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
import { buildHandbookEvaluation } from './handbook/build-handbook-evaluation.js';
import { computeCrossCheckResultId, computeDoctrineEvaluationId } from '../util/content-hash.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  adaptExtractionToDealBag,
  evaluateDeal,
  bridgeToDoctrineEvaluation,
} from '../doctrine-clean/index.js';
import { detectLeaseUp } from '../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from './contracted-basis.js';
import type {
  EvaluateDealResult,
  OperatorSuppliedValue,
} from '../doctrine-clean/index.js';
import type { DealBag } from '../doctrine-clean/scoring/evaluate-deal.js';
import type { DoctrineEvaluationId } from '@cre/contracts';

/**
 * Clean-doctrine version sentinel. Persisted DoctrineEvaluations produced by
 * the clean-room path carry this stamp instead of the legacy `DOCTRINE_VERSION`
 * constant ('1.3'). Reverts (or any old-doctrine code path that may still
 * run elsewhere) carry the legacy stamp, so persisted records are identifiable
 * by source. The literal-union `DoctrineVersion` allows '1.0' through '1.3'
 * only — we pick '1.3' for now to satisfy the type, and the
 * DOCTRINE_CLEAN_VERSION_TAG below is recorded out-of-band when needed for
 * lineage filtering. (A separate, deliberate contract-extension batch will
 * add a 'clean.1' literal to the type and use it here.)
 *
 * judgmentEngineVersion stays at the existing JUDGMENT_ENGINE_VERSION because
 * the judgment engine STILL RUNS (it produces AdjustedInputs the handbook
 * evaluator and other consumers read). The clean doctrine ignores judgment
 * output but the engine itself remains in the pipeline at this step.
 */
const CLEAN_DOCTRINE_PATH_TAG = 'clean-1.0' as const;

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
  /**
   * v1.6 narrative wiring — operator-supplied concluded value (FALLBACK).
   * Threaded into adaptExtractionToDealBag so dim 7 can resolve on deals
   * whose extraction yields no appraisal.valueConclusion AND no
   * asr.impliedValue (Sunroad shape). The fence stays intact — this is an
   * EXPLICIT contract input from the caller, NOT a read from
   * AdjustedInputs / valuationConclusion. Omit to preserve existing
   * "extraction-only" behavior (dim 7 HITLs when both extraction paths
   * are absent). See adapters/extraction-to-dealbag.ts.
   */
  readonly operatorSuppliedValue?: OperatorSuppliedValue;
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
  /**
   * The clean-doctrine `EvaluateDealResult` from Stage 8 (the in-memory
   * value the bridge consumed). Returned so the `evaluateAndNarrate`
   * wrapper can thread it into the mitigation producer downstream
   * without re-deriving it from the lossy bridged `DoctrineEvaluation`.
   *
   * Phase 1 of the mitigant-v2 backbone — additive, in-memory only; no
   * persisted record. The dim-7 LTV re-point in produceMitigations
   * reads `dimensions.capRateValuationStress.derivedOutputs.stressedValue`
   * from this object. Other callers may ignore.
   */
  readonly dealResult: EvaluateDealResult;
  /**
   * v1.6 narrative wiring — the DealBag the clean doctrine consumed. The
   * orchestrator's composeMitigations call needs it to rebuild a DealBag
   * at L' (proceeds-cut loan) for the recompute callback. Pass-through;
   * not persisted. Other callers may ignore.
   */
  readonly dealBag: DealBag;
  /**
   * v1.1 noiBasis additive (Option C). The contracted-basis NOI computed
   * earlier in this function, surfaced for the snapshot producer so the
   * disclosure callout reads pin-faithful numbers without re-running the
   * lease-up + contracted-basis pipeline downstream. `null` when the
   * lease-up predicate didn't fire (stabilized deals — no divergence to
   * disclose).
   */
  readonly contractedNoi: number | null;
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

  /* Stage 8 — DoctrineEvaluation (CLEAN-ROOM PATH; retire-old step 5).
   *
   * Swap: doctrine computation now goes through doctrine-clean (raw
   * ExtractionResult + PropertyMetadata → adapter → evaluateDeal → bridge).
   * The clean doctrine IGNORES AdjustedInputs / ValuationConclusion / judgment
   * output entirely (the fence). Judgment still runs above to keep producing
   * AdjustedInputs for the handbook evaluator + other consumers that haven't
   * been rewired yet (separate, later phase).
   *
   * Reversal: a single git revert of this swap restores buildDoctrineEvaluation.
   * No other files modified by this step.
   *
   * Persisted-record stamp: doctrineVersion remains in the contract-defined
   * literal union; the clean-path tag is recorded inline at CLEAN_DOCTRINE_PATH_TAG
   * for future lineage filtering. judgmentEngineVersion stays at the existing
   * value because judgment still produces AdjustedInputs for the bundle.
   */
  const extraction = store.getExtractionResult(extractionResultId);
  if (extraction === null) {
    throw new Error(
      `evaluate-from-adjusted-inputs: ExtractionResult ${extractionResultId} not found in store. ` +
      `The clean doctrine needs the raw extraction record (not just its id); ensure ingest persists ` +
      `it before this stage. Tag: ${CLEAN_DOCTRINE_PATH_TAG}`,
    );
  }
  // Conservative-lease-up doctrine (DOCTRINE_VERSION 1.5). The detection
  // predicate routes lease-up deals to the contracted basis (rent-roll
  // signed-lease filter + engine's existing vacancy/expense discipline);
  // stabilized deals fall through unchanged. The producer lives outside
  // doctrine-clean (in services/contracted-basis.ts) because it reuses
  // AdjustedInputs.income.vacancyPct.adjusted + metrics.expenseRatio to
  // avoid duplicating floor policy. The adapter receives only the scalar
  // override, preserving the clean-room fence by construction.
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    operatorSuppliedValue: args.operatorSuppliedValue,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);

  // Compute a content-hash id over the bundle so re-running with identical
  // upstream records is idempotent (same id; same persisted bytes).
  const bridgeIds = {
    evaluationId: '__placeholder__' as DoctrineEvaluationId,
    extractionResultId,
    adjustedInputsId: adjustedInputs.id,
    librarySnapshotId: librarySnapshot.id,
    narrativeFactsId: narrativeFacts.id,
    crossCheckResultId: crossCheckResult.id,
    stressOutputsId: stressOutputs.id,
    valuationConclusionId: valuationConclusion.id,
    assetProfileId: assetProfile.id,
    rentRollId: rentRoll?.id ?? null,
  };
  const bridgeVersions = {
    doctrineVersion: '1.5' as const,                     // conservative-lease-up doctrine; matches DOCTRINE_VERSION constant
    judgmentEngineVersion: '1.10' as const,              // judgment still runs above; existing version stamp
    stressEngineVersion: '1.0' as const,
    valuationEngineVersion: '1.0' as const,
  };
  // leaseUpTrace + contractedTrace are not currently persisted; they're
  // available locally for diagnostic logging if the caller wants to surface
  // why a deal routed (or didn't route) to the contracted basis. The clean
  // doctrine's normalization layer (sustainable-cashflow.ts) records its own
  // haircut trace on the DoctrineEvaluation output; a separate Phase 6.5
  // batch can promote leaseUpTrace + contractedTrace into the persisted
  // record if lineage filtering needs them.
  void leaseUpTrace;
  // contractedTrace is exposed below so the snapshot producer can carry
  // contractedNoi as a stamped field (v1.1 noiBasis disclosure).
  const bridged = bridgeToDoctrineEvaluation(dealResult, bridgeIds, bridgeVersions, analysisAsOfDate);

  // Stamp the content-hash id over the bridged body (placeholder id is ignored
  // by the id factory because we pass the body without the id field).
  const { id: _drop, ...bodyForId } = bridged;
  const evaluation: DoctrineEvaluation = {
    ...bridged,
    id: computeDoctrineEvaluationId(bodyForId),
  };
  store.insertDoctrineEvaluation(evaluation);

  return {
    evaluation,
    handbookEvaluation,
    dealResult,
    dealBag,
    // v1.1 noiBasis additive: surface the contracted-NOI scalar (null when the
    // lease-up predicate didn't fire — stabilized deals) so the snapshot
    // producer can stamp it without re-running the lease-up + contracted-basis
    // pipeline downstream.
    contractedNoi: contractedTrace.contractedNoi,
  };
}
