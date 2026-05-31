/**
 * `evaluateFromAdjustedInputs` — multi-stage pipeline tail (Option C / issue #20, step 8.4).
 *
 * Given a fully-constructed AdjustedInputs (built by the caller — either via the
 * judgment engine at ingest, or by applying a revision delta to a parent's
 * AdjustedInputs at edit time), this function persists the AdjustedInputs and
 * runs the downstream producers, persisting each in dependency order:
 *
 *   1. AdjustedInputs       (insertAdjustedInputs)
 *   2. CrossCheckResult     (insertCrossCheckResult) — v1: empty findings
 *   3. StressOutputs        (insertStressOutputs)
 *   4. ValuationConclusion  (insertValuationConclusion)
 *   5. DoctrineEvaluation   (insertDoctrineEvaluation)
 *
 * Every insert is `ON CONFLICT(id) DO NOTHING`, so the function is idempotent —
 * calling it twice with the same inputs is safe. Same inputs produce the same
 * `DoctrineEvaluation.id` (content-hash determinism, architecture H4).
 *
 * Pure topology over its producers, identical to ingestExtractionResult's discipline
 * (no `??`, no asset-class branching, no fallback selection). Producers own all
 * interpretive logic; this function only threads records in dependency order.
 *
 * Boundary:
 *   - The judgment engine does NOT run here. The caller must build `adjustedInputs`.
 *   - Root revision envelope + provenance are NOT created here. The caller (ingest
 *     for root revisions; applyRevisionDelta for child revisions) owns envelope
 *     semantics so this function can serve both root and non-root paths uniformly.
 *
 * Errors:
 *   - RecordIdMismatchError propagates from any insert if a producer constructed a
 *     record without using the contract `compute*Id` factories.
 *   - Producer-internal exceptions (e.g., from stress / valuation / doctrine engines)
 *     propagate unchanged.
 */

import type {
  AdjustedInputs,
  AssetProfile,
  CrossCheckResult,
  DoctrineEvaluation,
  ExtractionResultId,
  HandbookEvaluation,
  ISODateTime,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import { buildStressOutputs } from './stress-test-contracts.service.js';
import { buildValuationConclusion } from './valuation.service.js';
import { buildDoctrineEvaluation } from './doctrine/build-doctrine-evaluation.js';
import { buildHandbookEvaluation } from './handbook/build-handbook-evaluation.js';
import { computeCrossCheckResultId } from '../util/content-hash.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

export interface EvaluateFromAdjustedInputsArgs {
  /** Fully constructed AdjustedInputs; not yet persisted. This function inserts it. */
  readonly adjustedInputs: AdjustedInputs;
  readonly assetProfile: AssetProfile;
  readonly librarySnapshot: LibrarySnapshot;
  readonly narrativeFacts: NarrativeFacts;
  /** Stamped on the resulting DoctrineEvaluation so the bundle is reachable from the
   *  root in single-hop FK lookups (Batch 6.5 hydration invariant HY1). */
  readonly extractionResultId: ExtractionResultId;
  readonly analysisAsOfDate: ISODateTime;
  /** Best-effort PropertyMetadata for the handbook field-bag assembler.
   *  Sourced upstream via getPropertyMetadataByExtractionResultId(extractionResultId).
   *  null is a valid state — assembler is null-tolerant and the engine skips
   *  metadata-derived principles with reason 'missing_field'. */
  readonly propertyMetadata: PropertyMetadata | null;
  /** Phase 1 (rent-roll-node): typed RentRoll. Stamped on DoctrineEvaluation
   *  as `rentRollId` so the bundle is reachable from the root. null when no
   *  rent roll was produced; this is a valid state (deal with no rent roll). */
  readonly rentRoll: RentRoll | null;
}

export interface EvaluateFromAdjustedInputsResult {
  readonly evaluation: DoctrineEvaluation;
  /**
   * The HandbookEvaluation built and persisted at Stage 6.5. Returned so
   * the coupled `evaluateAndNarrate` wrapper (Piece A Phase 1 batch 2)
   * can hand the HE to the narrative producer without re-reading it from
   * the store. Other callers may ignore this field.
   */
  readonly handbookEvaluation: HandbookEvaluation;
}

export interface EvaluateFromAdjustedInputsDeps {
  /**
   * Optional LLM-context deps for the handbook evaluator (Phase 3 of the
   * LLM_CONTEXT evaluator). When provided, the handbook engine dispatches
   * LLM_CONTEXT principles through runLlmContextCheck. When omitted, all
   * non-deterministic principles skip with 'not_deterministic' (legacy
   * sync engine behavior).
   */
  readonly llmContextDeps?: import('./handbook/run-llm-context-check.js').LlmContextCheckDeps;
}

export async function evaluateFromAdjustedInputs(
  args: EvaluateFromAdjustedInputsArgs,
  store: RecordGraphStore,
  deps: EvaluateFromAdjustedInputsDeps = {},
): Promise<EvaluateFromAdjustedInputsResult> {
  const {
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    extractionResultId,
    analysisAsOfDate,
    propertyMetadata,
    rentRoll,
  } = args;

  /* Stage 4 (insert only) — AdjustedInputs already constructed by caller. */
  store.insertAdjustedInputs(adjustedInputs);

  /* Stage 5 — CrossCheckResult (v1: empty; producer refactor deferred to its own
     sub-batch — see ingest-extraction-result.ts header for the original 6.4.5 note). */
  const crossCheckResult: CrossCheckResult = (() => {
    const body = {
      analysisAsOfDate,
      adjustedInputsId: adjustedInputs.id,
      findings: [],
      overallAdjustmentBias: 'neutral' as const,
    };
    return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
  })();
  store.insertCrossCheckResult(crossCheckResult);

  /* Stage 6 — StressOutputs. */
  const stressOutputs = buildStressOutputs({
    adjustedInputs,
    assetProfile,
    analysisAsOfDate,
  });
  store.insertStressOutputs(stressOutputs);

  /* Stage 6.5 — HandbookEvaluation (#31, Commit 2). Parallel "handbook says"
     annotation. Sibling to the doctrine pipeline — does NOT feed into
     valuation/doctrine scoring. Persisted independently. Placed after
     StressOutputs because the assembler reads stressed_dscr_top_3_removed
     from the named scenario; placed before ValuationConclusion because the
     handbook evaluation has no dependency on valuation or doctrine. */
  const handbookEvaluation = await buildHandbookEvaluation(
    {
      adjustedInputs,
      assetProfile,
      narrativeFacts,
      stressOutputs,
      propertyMetadata,
      analysisAsOfDate,
      // Phase 2 (rent-roll-node): forward the typed RentRoll into the handbook
      // evaluator. buildHandbookEvaluation threads it into runLlmContextCheck
      // where a curated per-tenant block flows into the LLM prompt + context hash.
      rentRoll,
    },
    { store, llmContextDeps: deps.llmContextDeps },
  );
  store.insertHandbookEvaluation(handbookEvaluation);

  /* Stage 7 — ValuationConclusion. */
  const valuationConclusion = buildValuationConclusion({
    adjustedInputs,
    stressOutputs,
    narrativeFacts,
  });
  store.insertValuationConclusion(valuationConclusion);

  /* Stage 8 — DoctrineEvaluation. Also stamps extractionResultId so the bundle is
     reachable from the root in single-hop FK lookups (Batch 6.5 hydration invariant HY1). */
  const evaluation = buildDoctrineEvaluation({
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    crossCheckResult,
    stressOutputs,
    valuationConclusion,
    extractionResultId,
    rentRoll,
  });
  store.insertDoctrineEvaluation(evaluation);

  return { evaluation, handbookEvaluation };
}
