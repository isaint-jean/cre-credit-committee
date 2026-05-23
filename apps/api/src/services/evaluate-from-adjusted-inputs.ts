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
  ISODateTime,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
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
}

export interface EvaluateFromAdjustedInputsResult {
  readonly evaluation: DoctrineEvaluation;
}

export function evaluateFromAdjustedInputs(
  args: EvaluateFromAdjustedInputsArgs,
  store: RecordGraphStore,
): EvaluateFromAdjustedInputsResult {
  const {
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    extractionResultId,
    analysisAsOfDate,
    propertyMetadata,
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
  const handbookEvaluation = buildHandbookEvaluation({
    adjustedInputs,
    assetProfile,
    narrativeFacts,
    stressOutputs,
    propertyMetadata,
    analysisAsOfDate,
  });
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
  });
  store.insertDoctrineEvaluation(evaluation);

  return { evaluation };
}
