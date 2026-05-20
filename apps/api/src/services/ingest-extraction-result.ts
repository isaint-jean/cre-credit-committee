/**
 * Ingestion orchestrator (Batch 6.4) — pure topology over stable producers.
 *
 * Threads typed records through the new-spine pipeline in fixed dependency order. Persists
 * each record to record-graph-store. Returns the resulting DoctrineEvaluation as the analysis
 * root (architecture H4: same input → same DoctrineEvaluationId).
 *
 * Discipline (per the user's pre-6.3 directive, locked through 6.4):
 *
 *   - Pure topology. No `??`, no `||` numeric defaulting, no asset-class branching, no fallback
 *     selection beyond producer-emitted dispatch (e.g., `chooseStressMethod` is producer-internal).
 *   - No interpretation. The orchestrator never reads the contents of a record to decide what to
 *     do next; producers own all interpretive logic, surface flags + reason codes, and route
 *     missing-data through INSUFFICIENT_DATA themselves.
 *   - Strict null fidelity. Producers receive the records they need; missing data flows through
 *     unmodified.
 *   - D7 isolation. Does NOT import `analysis-to-adjusted-inputs.adapter.ts` (lint:boundaries
 *     deny-list enforces this).
 *   - The route handler that calls this is a dumb constructor: validate body shape → call here →
 *     return result. No business logic in the handler.
 *
 * Pipeline (locked, sub-batch 6.4):
 *
 *   ExtractionResult → NarrativeFacts → AssetProfile → AdjustedInputs → CrossCheckResult →
 *   StressOutputs → ValuationConclusion → DoctrineEvaluation
 *
 * Pinned upstream inputs:
 *
 *   - LibrarySnapshot — pre-persisted (via `seed:approved-deals`); ingestion looks up by id.
 *   - MarketBenchmarks, CreditManifesto — passed inline as full records (registry storage
 *     deferred to a later sub-batch).
 *
 * v1 known gap (deferred):
 *
 *   - CrossCheckResult is emitted as empty (`findings: []`, `bias: 'neutral'`). The producer
 *     `buildCrossCheckResult` requires the legacy-shaped `sellerMetrics + uwModel` pair; the
 *     new spine produces `ExtractionResult.sellerUw + AdjustedInputs`. Refactoring that
 *     producer is its own sub-batch (6.4.5 or later). Empty CrossCheckResult is handled
 *     gracefully by Stage 10 doctrine evaluation (per the 5c constraint).
 */

import type {
  AssetType,
  CreditManifesto,
  CrossCheckResult,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ISODateTime,
  LibrarySnapshotId,
  MarketBenchmarks,
  MarketLiquidity,
} from '@cre/contracts';
import { applyJudgmentAdjustments } from './judgment/apply-judgment-adjustments.js';
import { buildNarrativeFacts } from './narrative-facts.service.js';
import { classifyAssetProfile } from './asset-profiler.service.js';
import { buildStressOutputs } from './stress-test-contracts.service.js';
import { buildValuationConclusion } from './valuation.service.js';
import { buildDoctrineEvaluation } from './doctrine/build-doctrine-evaluation.js';
import { computeCrossCheckResultId } from '../util/content-hash.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

/* ------------------------------- error type -------------------------------- */

export type IngestionErrorCode =
  | 'LIBRARY_SNAPSHOT_NOT_FOUND';

export interface IngestionErrorContext {
  readonly code: IngestionErrorCode;
  readonly librarySnapshotId?: string;
}

export class IngestionError extends Error {
  override readonly name = 'IngestionError';
  readonly code: IngestionErrorCode;
  readonly context: IngestionErrorContext;

  constructor(context: IngestionErrorContext) {
    super(`Ingestion failed: ${context.code}`);
    this.code = context.code;
    this.context = context;
  }
}

/* --------------------------------- args ----------------------------------- */

export interface IngestExtractionResultArgs {
  readonly extractionResult: ExtractionResult;
  readonly propertyType: AssetType;
  readonly marketLiquidityHint?: MarketLiquidity;
  readonly librarySnapshotId: LibrarySnapshotId;
  readonly marketBenchmarks: MarketBenchmarks;
  readonly creditManifesto: CreditManifesto;
  readonly analysisAsOfDate: ISODateTime;
}

export interface IngestionResult {
  readonly rootId: DoctrineEvaluationId;
  readonly evaluation: DoctrineEvaluation;
}

/* ----------------------------- orchestration ------------------------------ */

export function ingestExtractionResult(
  args: IngestExtractionResultArgs,
  store: RecordGraphStore,
): IngestionResult {
  const {
    extractionResult,
    propertyType,
    marketLiquidityHint,
    librarySnapshotId,
    marketBenchmarks,
    creditManifesto,
    analysisAsOfDate,
  } = args;

  /* Stage 1 — persist extraction. */
  store.insertExtractionResult(extractionResult);

  /* Stage 1/3 — NarrativeFacts. */
  const narrativeFacts = buildNarrativeFacts({
    extractionResult,
    analysisAsOfDate,
  });
  store.insertNarrativeFacts(narrativeFacts);

  /* Stage 3 — AssetProfile. */
  const assetProfile = classifyAssetProfile({
    propertyType,
    narrativeFacts: {
      occupancyCurrent: narrativeFacts.occupancyCurrent,
      trailingOccAvg: narrativeFacts.trailingOccAvg,
    },
    ...(marketLiquidityHint !== undefined ? { marketLiquidityHint } : {}),
  });
  store.insertAssetProfile(assetProfile);

  /* Pinned input — LibrarySnapshot lookup. */
  const librarySnapshot = store.getLibrarySnapshot(librarySnapshotId);
  if (librarySnapshot === null) {
    throw new IngestionError({
      code: 'LIBRARY_SNAPSHOT_NOT_FOUND',
      librarySnapshotId,
    });
  }

  /* Stage 4 — judgment engine produces AdjustedInputs. */
  const adjustedInputs = applyJudgmentAdjustments({
    extraction: extractionResult,
    assetProfile,
    librarySnapshot,
    manifesto: creditManifesto,
    marketBenchmarks,
    analysisAsOfDate,
  });
  store.insertAdjustedInputs(adjustedInputs);

  /* Stage 5 — CrossCheckResult (v1: empty; producer refactor deferred — see header). */
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
    extractionResultId: extractionResult.id,
  });
  store.insertDoctrineEvaluation(evaluation);

  return { rootId: evaluation.id, evaluation };
}
