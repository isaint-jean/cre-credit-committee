/**
 * `evaluateAndNarrate` — 3c coupled atomic wrapper (Piece A Phase 1
 * batch 2). Composes `evaluateFromAdjustedInputs` (producer-tail through
 * DoctrineEvaluation, including the Stage 6.5 HandbookEvaluation) with
 * `buildNarrative` + `insertNarrative` so a single call from the write-
 * path orchestrators (`ingestExtractionResult`, `applyRevisionDelta`)
 * produces and persists the full {DE, HE, Narrative} triple.
 *
 * SPEC anchors:
 *   - §14.4 v22 (coupled atomic wrapper architecture)
 *   - §14.4 v23 (atomicity via content-hash + ON CONFLICT, not transactions)
 *
 * Atomicity tracing (verified at recon, ITEM 1):
 *   - evaluateFromAdjustedInputs inserts AI → CC → SO → HE → VC → DE
 *     in dependency order, each via ON CONFLICT(id) DO NOTHING.
 *   - buildNarrative is async (LLM round-trip). If it throws, the
 *     producer-tail records are already persisted. Caller retries:
 *     evaluateFromAdjustedInputs re-runs as no-op (same content hashes),
 *     buildNarrative is re-attempted. Two narrative attempts can
 *     produce two rows (LLM non-determinism); both are valid and
 *     `getLatestNarrativeForAdjustedInputs(_, version)` returns the
 *     newer one.
 *
 * LLM DI seam (§14.4 batch 2 Q-R4): the `deps.llmCall` option cascades
 * downward into `buildNarrative`. Production callers omit it (the real
 * `callAIWithContinuation` is used); tests pass a deterministic stub.
 */

import type {
  AdjustedInputs,
  AdjustedLineItem,
  DoctrineEvaluation,
  HandbookEvaluation,
  MitigationProposalSet,
  NarrativeEvaluation,
} from '@cre/contracts';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import { calculateAnnualDebtService } from '@cre/shared';
import { buildNarrative, type LLMCallFn } from './narrative/build-narrative.js';
import {
  evaluateFromAdjustedInputs,
  type EvaluateFromAdjustedInputsArgs,
} from './evaluate-from-adjusted-inputs.js';
import { synthesizeUwModelFromInputs } from './synthesize-uw-model-from-graph.js';
import { produceMitigations } from './mitigation/produce-mitigations.js';
import {
  composeMitigations,
  type ComposedMitigationPackage,
  type DealComputeState,
} from './mitigation/compose-mitigations.js';
import type { EvaluateDealResult } from '../doctrine-clean/scoring/evaluate-deal.js';
import { evaluateDeal } from '../doctrine-clean/index.js';
import { computeMaturityBalance } from '../doctrine-clean/dimensions/refinance-feasibility.js';
import { computeMitigationProposalSetId } from '../util/content-hash.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

export interface EvaluateAndNarrateDeps {
  readonly llmCall?: LLMCallFn;
  /** Optional analyst-supplied manual inputs threaded into the
   *  LLM_CONTEXT evaluator. See run-llm-context-check.ts. */
  readonly manualInputs?: import('@cre/contracts').ManualInputs;
}

export interface EvaluateAndNarrateResult {
  readonly evaluation: DoctrineEvaluation;
  readonly handbookEvaluation: HandbookEvaluation;
  readonly narrative: NarrativeEvaluation;
  readonly mitigationProposalSet: MitigationProposalSet;
  /**
   * v1.6 — clean-doctrine EvaluateDealResult (in-memory; not persisted).
   * Surfaced for downstream consumers that need the structured doctrine
   * outputs (dim contributions, derivedOutputs incl. dim-7 stressedValue +
   * concludedValueSource) without re-hydrating from the bridged
   * DoctrineEvaluation. The memo renderer uses this to project the
   * AuthoritativeNumbers block + clean-doctrine findings deterministically.
   * Additive — existing callers (build-and-ingest routes,
   * ingest-extraction-result, apply-revision-delta, validation-real-deal)
   * may ignore.
   */
  readonly dealResult: EvaluateDealResult;
  /**
   * v1.6 — composed mitigation package (sequential single-pass de-levering
   * resolution applied; reconciliation notes attached). In-memory; not
   * persisted. Surfaced for downstream consumers (memo renderer) that need
   * the composed final L', the reconciliation prose ("standalone amortization
   * $X → $0, superseded by $Y proceeds cut"), and the covenant-magnitude
   * resolution against L' — none of which are reachable from the persisted
   * MitigationProposalSet (which holds the RAW pre-composition proposals).
   * Additive; existing callers may ignore.
   */
  readonly composedMitigationPackage: ComposedMitigationPackage;
}

/* ----------- v1.6 wiring — recompute helper for composeMitigations -------- */
/*
 * Pure clone-and-patch: produce an AdjustedInputs at L' (the post-cut loan
 * size) so produceMitigations' second pass scores against a coherent state.
 * Only loan-derived fields move; cashflow + expense + tenant-table fields
 * pass through unchanged (they don't depend on loan size).
 *
 * Patched fields:
 *   loan.loanAmount.adjusted       = newLoan
 *   loan.debtServiceAnnual.adjusted = calculateAnnualDebtService(newLoan, rate%, amortYrs)
 *   loan.maturityBalance.adjusted  = computeMaturityBalance(newLoan, coupon, amortMonths, ioYears, termYears)
 *   metrics.dscr                   = noi / debtServiceAtNewLoan
 *   metrics.debtYield              = noi / newLoan
 *
 * Unchanged fields:
 *   loan.interestRate, loan.termMonths, loan.amortizationMonths, loan.ioPeriodMonths,
 *   loan.maturityDate, all income/expense/capitalReserves/assumptions, metrics.noi,
 *   metrics.value, top-level adjustments, dataQualityFlags, dataConfidence.
 *
 * This mirrors the `recomputeAtLoan` callback shape composeMitigations expects.
 * If the post-cut debtService is non-positive (degenerate), DSCR/DY fall back
 * to the pre-cut values — composeMitigations' guard rails handle the rest.
 */
export function recomputeAiAtLoan(ai: AdjustedInputs, newLoan: number): AdjustedInputs {
  const ratePercent = ai.loan.interestRate.adjusted * 100;
  const amortMonths = ai.loan.amortizationMonths.adjusted;
  const ioMonths    = ai.loan.ioPeriodMonths.adjusted;
  const termMonths  = ai.loan.termMonths.adjusted;
  const ioYears     = ioMonths    > 0 ? ioMonths    / 12 : null;
  const termYears   = termMonths  > 0 ? termMonths  / 12 : null;

  // Annual debt service at the new loan. The helper expects amortYears = 0
  // for IO (interest-only); for amortizing, amortMonths / 12. Falls back to
  // newLoan × rate for IO when the helper returns null/non-positive.
  const amortYears  = amortMonths > 0 ? amortMonths / 12 : 0;
  const helperDs    = calculateAnnualDebtService(newLoan, ratePercent, amortYears);
  const debtServiceAnnual: number = (helperDs !== null && Number.isFinite(helperDs) && helperDs > 0)
    ? helperDs
    : newLoan * ai.loan.interestRate.adjusted;

  // Maturity balance at L'. Doctrine's own computeMaturityBalance handles
  // IO (no paydown → balance = newLoan) and amortizing (residual after
  // amortization over the in-amort months of the term).
  const maturityBalance = computeMaturityBalance(
    newLoan,
    ai.loan.interestRate.adjusted,
    amortMonths,
    ioYears,
    termYears,
  ).balance;

  const noi: number | null = ai.metrics.noi;
  const dscrAtNewLoan: number | null = (noi !== null && debtServiceAnnual > 0)
    ? noi / debtServiceAnnual
    : ai.metrics.dscr;
  const debtYieldAtNewLoan: number | null = (noi !== null && newLoan > 0)
    ? noi / newLoan
    : ai.metrics.debtYield;

  const patchLi = (li: AdjustedLineItem, adjusted: number): AdjustedLineItem =>
    ({ ...li, adjusted });

  return {
    ...ai,
    loan: {
      ...ai.loan,
      loanAmount:         patchLi(ai.loan.loanAmount,        newLoan),
      debtServiceAnnual:  patchLi(ai.loan.debtServiceAnnual, debtServiceAnnual),
      maturityBalance:    patchLi(ai.loan.maturityBalance,   maturityBalance ?? newLoan),
    },
    metrics: {
      ...ai.metrics,
      dscr:      dscrAtNewLoan,
      debtYield: debtYieldAtNewLoan,
    },
  };
}

export async function evaluateAndNarrate(
  args: EvaluateFromAdjustedInputsArgs,
  store: RecordGraphStore,
  deps: EvaluateAndNarrateDeps = {},
): Promise<EvaluateAndNarrateResult> {
  const { evaluation, handbookEvaluation, dealResult, dealBag } = await evaluateFromAdjustedInputs(
    args,
    store,
    // Wire the LLM_CONTEXT evaluator into the handbook pass when the same
    // llmCall is available. Production callers omit deps.llmCall → the
    // real callAIWithContinuation flows through to both the narrative
    // producer and the LLM-principle evaluator.
    { llmContextDeps: { llmCall: deps.llmCall, manualInputs: deps.manualInputs } },
  );

  // Mitigation engine v1 (commit 2c). Runs between HE and NE; deterministic,
  // no LLM. Reads the concluded metrics off args.adjustedInputs + a uwModel
  // synthesized from (ai, pm) and emits structured MitigationProposal[].
  // firedFlags are consulted for principle enrichment only (per doctrine v1.2
  // §0 metrics-driven trigger). Idempotent on content-hash.
  //
  // Mitigant v2 phase 1: the clean-doctrine `dealResult` (from Stage 8) is
  // threaded in additively. Phase 1 consumes it for the LTV arm re-point
  // ("lend to my value" — size against dim 7's stressedValue instead of
  // the appraised value). Other arms unchanged. The dealResult is in-memory
  // only — no new persisted record in this phase.
  const uwModelForMitigations = synthesizeUwModelFromInputs(
    args.adjustedInputs,
    args.propertyMetadata,
  );
  const proposals = produceMitigations({
    adjustedInputs: args.adjustedInputs,
    uwModel: uwModelForMitigations,
    firedFlags: handbookEvaluation.firedFlags,
    dealResult,
  });
  const mitigationSetBody = {
    adjustedInputsId: args.adjustedInputs.id,
    handbookEvaluationId: handbookEvaluation.id,
    mitigationEngineVersion: MITIGATION_ENGINE_VERSION,
    proposals,
  };
  const mitigationProposalSet: MitigationProposalSet = {
    id: computeMitigationProposalSetId(mitigationSetBody),
    ...mitigationSetBody,
  };
  store.insertMitigationProposalSet(mitigationProposalSet);

  // Mitigant v2 phase 3 — composition layer. Sequential single-pass
  // de-levering: if reduce_proceeds fires, recompute the deal at L'
  // (proceeds-cut loan), re-run produceMitigations on the recomputed
  // state, and let amortization either drop (proceeds cut cures exit
  // DSCR) or shrink to a residual paydown sized off L'. Orthogonal
  // levers (guaranty / lockbox / springing / fund_reserve / CP) stack
  // unchanged; their covenant magnitudes resolve against L' in the
  // reconciliation. The recompute callback closes over the original
  // dealBag (returned from evaluateFromAdjustedInputs) — DealBag's
  // asset / cashflow / tenant fields pass through; only `loanAmount`
  // is swapped, then evaluateDeal produces the post-cut dealResult.
  const composedMitigationPackage = composeMitigations({
    adjustedInputs: args.adjustedInputs,
    uwModel: uwModelForMitigations,
    dealResult,
    firedFlags: handbookEvaluation.firedFlags,
    recomputeAtLoan: (newLoanAmount: number): DealComputeState => {
      const aiPrime  = recomputeAiAtLoan(args.adjustedInputs, newLoanAmount);
      const uwPrime  = synthesizeUwModelFromInputs(aiPrime, args.propertyMetadata);
      const bagPrime = { ...dealBag, loanAmount: newLoanAmount };
      const dealResultPrime = evaluateDeal(bagPrime);
      return {
        adjustedInputs: aiPrime,
        uwModel: uwPrime,
        dealResult: dealResultPrime,
      };
    },
  });

  // Narrative engine v1.6 — composed-package wiring + handbook demotion.
  // Both `dealResult` and `composedMitigationPackage` are threaded; the
  // producer projects the deterministic AUTHORITATIVE NUMBERS block from
  // them and embeds it verbatim in every slot prompt. Handbook flags are
  // qualitative-only supporting observations (metric strings stripped).
  // Mitigation_suggestions slot renders the COMPOSED package + reconciliation
  // notes deterministically (no LLM). When the inputs are absent the
  // producer falls back to the v1.5 path automatically (legacy callers).
  const narrative = await buildNarrative(
    {
      handbookEvaluation,
      adjustedInputsId: args.adjustedInputs.id,
      analysisAsOfDate: args.analysisAsOfDate,
      // Narrative engine v1.4 — committee-recommendation gate.
      dataConfidence:   args.adjustedInputs.dataConfidence,
      dataQualityFlags: args.adjustedInputs.dataQualityFlags,
      // Narrative engine v1.5 — mitigation_suggestions deterministic render
      // + committee_recommendation grounding. The proposal set produced
      // immediately above is the SAME record threaded here; the narrative
      // producer reads it as the single source of truth for sized figures.
      mitigationProposalSet,
      // Narrative engine v1.6 — clean-doctrine authoritative numbers +
      // composed-package wiring + handbook demotion.
      dealResult,
      composedMitigationPackage,
    },
    { llmCall: deps.llmCall },
  );
  store.insertNarrative(narrative);

  return {
    evaluation,
    handbookEvaluation,
    narrative,
    mitigationProposalSet,
    // v1.6 surface — in-memory pass-through for downstream consumers
    // (memo renderer; future consumers may layer on additively).
    dealResult,
    composedMitigationPackage,
  };
}
