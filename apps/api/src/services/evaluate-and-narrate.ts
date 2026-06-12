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
  DoctrineEvaluation,
  HandbookEvaluation,
  MitigationProposalSet,
  NarrativeEvaluation,
} from '@cre/contracts';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import { buildNarrative, type LLMCallFn } from './narrative/build-narrative.js';
import {
  evaluateFromAdjustedInputs,
  type EvaluateFromAdjustedInputsArgs,
} from './evaluate-from-adjusted-inputs.js';
import { synthesizeUwModelFromInputs } from './synthesize-uw-model-from-graph.js';
import { produceMitigations } from './mitigation/produce-mitigations.js';
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
}

export async function evaluateAndNarrate(
  args: EvaluateFromAdjustedInputsArgs,
  store: RecordGraphStore,
  deps: EvaluateAndNarrateDeps = {},
): Promise<EvaluateAndNarrateResult> {
  const { evaluation, handbookEvaluation, dealResult } = await evaluateFromAdjustedInputs(
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

  // v1.5 path through buildNarrative (no dealResult / composedPackage).
  // The v1.6 producer surface is ready (validated via the narrative harness),
  // but production orchestrator integration is staged separately so that
  // composeMitigations' recompute callback (which needs the adapter inputs
  // plumbed all the way through evaluateFromAdjustedInputs) lands in a
  // focused commit. Today this orchestrator keeps the v1.5 fallback active.
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
    },
    { llmCall: deps.llmCall },
  );
  store.insertNarrative(narrative);

  return { evaluation, handbookEvaluation, narrative, mitigationProposalSet };
}
