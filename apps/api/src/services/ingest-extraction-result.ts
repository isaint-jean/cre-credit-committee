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
 *   - MarketBenchmarks, CreditManifesto — dual-mode: either passed inline as full records
 *     OR referenced by id from the registry (apps/api/src/routes/registry.routes.ts).
 *     Exactly one of inline-or-reference per pair; the route handler enforces shape.
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
  CreditManifestoId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ISODateTime,
  LibrarySnapshotId,
  MarketBenchmarks,
  MarketBenchmarksId,
  MarketLiquidity,
  RevisionId,
  RevisionLineageEnvelope,
  RevisionProvenance,
} from '@cre/contracts';
import { applyJudgmentAdjustments } from './judgment/apply-judgment-adjustments.js';
import { buildNarrativeFacts } from './narrative-facts.service.js';
import { classifyAssetProfile } from './asset-profiler.service.js';
import { evaluateAndNarrate } from './evaluate-and-narrate.js';
import type { LLMCallFn } from './narrative/build-narrative.js';
import { computeRevisionId } from '../util/content-hash.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

/**
 * Optional dependencies for the orchestrator. The LLM-call seam cascades
 * through `evaluateAndNarrate` to `buildNarrative` so tests can supply a
 * deterministic stub instead of hitting the Anthropic API. Production
 * callers omit `deps` (or pass `{}`) and the real `callAIWithContinuation`
 * is used.
 */
export interface IngestExtractionResultDeps {
  readonly llmCall?: LLMCallFn;
}

/* ------------------------------- error type -------------------------------- */

export type IngestionErrorCode =
  | 'LIBRARY_SNAPSHOT_NOT_FOUND'
  | 'MARKET_BENCHMARKS_NOT_FOUND'
  | 'CREDIT_MANIFESTO_NOT_FOUND';

export interface IngestionErrorContext {
  readonly code: IngestionErrorCode;
  readonly librarySnapshotId?: string;
  readonly marketBenchmarksId?: string;
  readonly creditManifestoId?: string;
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
  /** Inline `marketBenchmarks` and reference `marketBenchmarksId` are mutually
   *  exclusive: exactly one MUST be supplied. The route handler enforces this;
   *  the orchestrator below resolves whichever is present. Same convention for
   *  the credit-manifesto pair. */
  readonly marketBenchmarks?: MarketBenchmarks;
  readonly marketBenchmarksId?: MarketBenchmarksId;
  readonly creditManifesto?: CreditManifesto;
  readonly creditManifestoId?: CreditManifestoId;
  readonly analysisAsOfDate: ISODateTime;
}

export interface IngestionResult {
  /**
   * Public AnalysisId — the root revision envelope's id. Equal to the lineage's
   * `lineageRootId` (Option C / spec §1: `AnalysisId === LineageRootId`). NOT the
   * doctrine-evaluation id (see `evaluationId` below); two records with different
   * roles, same 64-hex shape.
   */
  readonly rootId: RevisionId;
  /**
   * Internal anchor for hydration / rendering / committee/audit/workflow stores.
   * Stays addressable for callers that need to reach the doctrine-evaluation
   * directly (e.g., `materializeRenderedAnalysis(rootId=DoctrineEvaluationId)`).
   */
  readonly evaluationId: DoctrineEvaluationId;
  readonly evaluation: DoctrineEvaluation;
}

/* ----------------------------- orchestration ------------------------------ */

export async function ingestExtractionResult(
  args: IngestExtractionResultArgs,
  store: RecordGraphStore,
  deps: IngestExtractionResultDeps = {},
): Promise<IngestionResult> {
  const {
    extractionResult,
    propertyType,
    marketLiquidityHint,
    librarySnapshotId,
    analysisAsOfDate,
  } = args;

  /* Resolve marketBenchmarks: prefer inline; otherwise look up by id. The
     caller MUST supply exactly one — the route handler validates. */
  let marketBenchmarks: MarketBenchmarks;
  if (args.marketBenchmarks !== undefined) {
    marketBenchmarks = args.marketBenchmarks;
  } else if (args.marketBenchmarksId !== undefined) {
    const found = store.getMarketBenchmarks(args.marketBenchmarksId);
    if (found === null) {
      throw new IngestionError({
        code: 'MARKET_BENCHMARKS_NOT_FOUND',
        marketBenchmarksId: args.marketBenchmarksId,
      });
    }
    marketBenchmarks = found;
  } else {
    // Route handler should have caught this; defensive fallthrough.
    throw new IngestionError({
      code: 'MARKET_BENCHMARKS_NOT_FOUND',
      marketBenchmarksId: '(neither inline nor reference supplied)',
    });
  }

  /* Resolve creditManifesto: same pattern. */
  let creditManifesto: CreditManifesto;
  if (args.creditManifesto !== undefined) {
    creditManifesto = args.creditManifesto;
  } else if (args.creditManifestoId !== undefined) {
    const found = store.getCreditManifesto(args.creditManifestoId);
    if (found === null) {
      throw new IngestionError({
        code: 'CREDIT_MANIFESTO_NOT_FOUND',
        creditManifestoId: args.creditManifestoId,
      });
    }
    creditManifesto = found;
  } else {
    throw new IngestionError({
      code: 'CREDIT_MANIFESTO_NOT_FOUND',
      creditManifestoId: '(neither inline nor reference supplied)',
    });
  }

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

  /* Best-effort PropertyMetadata for the handbook evaluator (#31, Commit 2).
     Looked up via the stopgap cache-traversal method; returns null if no PM
     was produced or persisted for this extraction. */
  const propertyMetadata = store.getPropertyMetadataByExtractionResultId(extractionResult.id);

  /* Stages 4-8 + narrative composition delegated to the coupled
     `evaluateAndNarrate` wrapper (Piece A Phase 1 batch 2). This composes
     the shared pipeline tail (used by applyRevisionDelta too) with the
     narrative producer so HE+narrative are always atomic per v22/v23. */
  const { evaluation } = await evaluateAndNarrate(
    {
      adjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      extractionResultId: extractionResult.id,
      analysisAsOfDate,
      propertyMetadata,
    },
    store,
    { llmCall: deps.llmCall },
  );

  /* Stage 9 — Root revision envelope + provenance (Option C / issue #20).
     Every graph-backed analysis gets a lineage root envelope at ingest. Identity
     (revisionId) is deterministic over the §5 hash-input subset: parent=null,
     adjustedInputsId, doctrineVersion. lineageRootId is self-referential for
     root (= revisionId). Engine versions are stamped from the evaluation for
     replay completeness; they do NOT participate in the id hash. */
  const rootRevisionId = computeRevisionId({
    parentRevisionId: null,
    adjustedInputsId: adjustedInputs.id,
    doctrineVersion: evaluation.doctrineVersion,
  });
  const rootEnvelope: RevisionLineageEnvelope = {
    revisionId: rootRevisionId,
    lineageRootId: rootRevisionId,
    parentRevisionId: null,
    revisionOrdinal: 0,
    doctrineEvaluationId: evaluation.id,
    adjustedInputsId: adjustedInputs.id,
    doctrineVersion: evaluation.doctrineVersion,
    judgmentEngineVersion: evaluation.judgmentEngineVersion,
    stressEngineVersion: evaluation.stressEngineVersion,
    valuationEngineVersion: evaluation.valuationEngineVersion,
  };
  store.insertRevisionLineageEnvelope(rootEnvelope);

  /* Root provenance — observable-only (§4). triggerSource='INITIAL_INGEST'
     distinguishes the lineage-creation event from downstream USER_EDIT /
     SYSTEM_RECALC revisions. The "diff" is empty because there is no parent;
     beforeHash === afterHash === adjustedInputs.id (no transformation: the
     root's AdjustedInputs IS the state). */
  const rootProvenance: RevisionProvenance = {
    revisionId: rootRevisionId,
    inputDiff: { changedFields: [] },
    triggerSource: 'INITIAL_INGEST',
    appliedRuleIds: [],
    adjustmentOrigin: [],
    beforeHash: adjustedInputs.id,
    afterHash: adjustedInputs.id,
  };
  store.insertRevisionProvenance(rootProvenance);

  return { rootId: rootRevisionId, evaluationId: evaluation.id, evaluation };
}
