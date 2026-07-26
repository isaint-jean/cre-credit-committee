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
  PropertyMetadata,
  RentRoll,
  RevisionId,
  RevisionTrigger,
  RevisionLineageEnvelope,
  RevisionProvenance,
} from '@cre/contracts';
import { applyJudgmentAdjustments } from './judgment/apply-judgment-adjustments.js';
import { buildNarrativeFacts } from './narrative-facts.service.js';
import { classifyAssetProfile } from './asset-profiler.service.js';
import { evaluateAndNarrate } from './evaluate-and-narrate.js';
import type { LLMCallFn } from './narrative/build-narrative.js';
import { computeContentHash, computeRevisionId } from '../util/content-hash.js';
import { diffAdjustedInputs } from './apply-revision-delta.js';
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
  /**
   * Optional analyst-supplied manual inputs (comps, sponsor research, etc.).
   * Threaded down to the LLM_CONTEXT evaluator's per-principle context. When
   * provided, principles that require this kind of data reach a fired
   * conclusion grounded in the analyst input; when omitted, those
   * principles return needs_manual_input. Data-only — no UI; populated
   * by script/test today.
   */
  readonly manualInputs?: import('@cre/contracts').ManualInputs;
  /**
   * External DD at mint (v1.2 snapshot). Pass-through to `evaluateAndNarrate` —
   * OPT-IN, default OFF. Production mint routes set `{ enabled: true }` so
   * §4/§6 get real external-DD; direct-call tests omit it (no live web).
   */
  readonly externalDd?: import('./evaluate-and-narrate.js').EvaluateAndNarrateDeps['externalDd'];
}

/* ------------------------------- error type -------------------------------- */

export type IngestionErrorCode =
  | 'LIBRARY_SNAPSHOT_NOT_FOUND'
  | 'MARKET_BENCHMARKS_NOT_FOUND'
  | 'CREDIT_MANIFESTO_NOT_FOUND'
  | 'PARENT_REVISION_NOT_FOUND';

export interface IngestionErrorContext {
  readonly code: IngestionErrorCode;
  readonly librarySnapshotId?: string;
  readonly marketBenchmarksId?: string;
  readonly creditManifestoId?: string;
  readonly parentRevisionId?: string;
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
  /**
   * Append-step seam (Option C / lineage). When ABSENT (the default, every
   * create-path ingest), Stage 9 writes a ROOT envelope exactly as before.
   * When PRESENT, Stage 9 instead writes a CHILD envelope under the parent's
   * lineage (lineageRootId from parent, ordinal+1, deterministic child id) —
   * the lineage-correct re-ingest the append flow needs. Envelope branch only;
   * no other behavior changes.
   */
  readonly parentRevisionId?: RevisionId;
  /**
   * Child-revision trigger label (CHILD branch only). Defaults to 'DOC_APPEND'
   * (the original append-flow semantics) so every existing caller is unchanged.
   * A re-judgment under a doctrine code change (e.g. the signed-lease cap tier)
   * passes 'DOCTRINE_ADJUSTMENT' for honest provenance — no document is appended.
   */
  readonly triggerSource?: RevisionTrigger;
  /** Optional child-provenance origin note (CHILD branch). Records WHY the
   *  re-judgment ran (e.g. 'signed-lease cap tier (48f4cc2)'). Default []. */
  readonly adjustmentOrigin?: readonly string[];
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
  /** Phase 1 (rent-roll-node): typed RentRoll surfaced by the composer (or
   *  null when no rent roll was produced). Persisted as a first-class graph
   *  node before the downstream pipeline runs; its id is then stamped on
   *  DoctrineEvaluation.rentRollId. null when no xlsx was uploaded and the
   *  ASR fallback produced nothing. */
  readonly rentRoll: RentRoll | null;
  /** Sprint-0: typed PropertyMetadata surfaced by the composer (or null when
   *  no ASR-AI extraction produced one). Persisted to the property_metadata
   *  table here so downstream stages (judgment, handbook, narrative,
   *  doctrine, populator) can read it, AND an extraction_input_cache row is
   *  written linking it to extractionResult.id so the read-side projector
   *  (project-legacy-analysis-from-graph) can resolve it back via
   *  getPropertyMetadataByExtractionResultId(). Without this, ~30
   *  property-identity cells on the Bank/BP Spire workbook export render
   *  blank even when the ASR extracted them. */
  readonly propertyMetadata?: PropertyMetadata | null;
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
    rentRoll,
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

  /* Stages 1, 1.5, 1/3, 3 — COMPUTE ONLY (no persist).
   *
   * Gate-cleanups refactor: persistence of these records is DEFERRED to
   * evaluateFromAdjustedInputs, which inserts them right AFTER the
   * data-integrity gate passes. This eliminates the orphan footprint on
   * HARD halt — previously each of these 4 records (plus PM below) leaked
   * to SQLite before the gate fired, leaving an inert but persisted
   * extraction in the graph.
   *
   * The records are still computed in their original order (FK / data
   * dependencies preserved); the persist call sites moved downstream. */
  const narrativeFacts = buildNarrativeFacts({
    extractionResult,
    analysisAsOfDate,
  });

  const assetProfile = classifyAssetProfile({
    propertyType,
    narrativeFacts: {
      occupancyCurrent: narrativeFacts.occupancyCurrent,
      trailingOccAvg: narrativeFacts.trailingOccAvg,
    },
    ...(marketLiquidityHint !== undefined ? { marketLiquidityHint } : {}),
  });

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
    // Thread the rent roll so the bank-NOI cascade can credit signed (PRELEASED)
    // leases — the income-catch cap learns signed leases. null → unchanged.
    rentRoll,
  });

  /* PropertyMetadata resolution (deferred-persist variant):
   *
   * If the caller passes a typed PM from the composer, hold it in-memory;
   * evaluateFromAdjustedInputs will insert it post-gate (idempotent).
   * If the caller doesn't pass one, fall back to the legacy lookup which
   * traverses the cache via extractionResult.id — that lookup only
   * succeeds if a PRIOR ingest already linked one (revision path), since
   * the extraction itself hasn't been persisted yet this turn. New ingest
   * + no PM = legitimately null (existing behavior).
   *
   * The extraction_input_cache row that links PM → extractionResult.id is
   * persisted here ONLY IF the gate is going to pass (we defer it next to
   * the PM insert). To preserve the original semantics, the cache link
   * write is moved to AFTER evaluateAndNarrate returns, gated on whether
   * the caller supplied PM (same condition as before). */
  let propertyMetadata: PropertyMetadata | null;
  if (args.propertyMetadata !== undefined && args.propertyMetadata !== null) {
    propertyMetadata = args.propertyMetadata;
  } else {
    propertyMetadata = store.getPropertyMetadataByExtractionResultId(extractionResult.id);
  }

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
      extraction: extractionResult,
      analysisAsOfDate,
      propertyMetadata,
      rentRoll,
    },
    store,
    { llmCall: deps.llmCall, manualInputs: deps.manualInputs, externalDd: deps.externalDd },
  );

  /* Post-gate PM cache link. evaluateFromAdjustedInputs inserts the
   * PropertyMetadata record itself (post-gate, idempotent); the cache
   * link that joins PM ↔ ExtractionResult is ingest-specific so it
   * lands here. Skip on the revision path (caller passes existing PM
   * looked up from the parent — link is already present). */
  if (args.propertyMetadata !== undefined && args.propertyMetadata !== null) {
    const existingLink = store.getPropertyMetadataByExtractionResultId(extractionResult.id);
    if (existingLink === null) {
      store.insertExtractionInputCache({
        cacheKey: computeContentHash({
          kind: 'sprint-0-pm-link',
          extractionResultId: extractionResult.id,
          propertyMetadataId: args.propertyMetadata.id,
        }),
        extractionResultId: extractionResult.id,
        propertyMetadataId: args.propertyMetadata.id,
        cfHash: null,
        rentRollHash: null,
        asrHash: null,
        pcaHash: null,
        extractorVersions: {},
      });
    }
  }

  /* Stage 9 (CHILD branch) — append-step lineage. When parentRevisionId is
     supplied, this ingest is a re-extraction APPENDED under an existing deal's
     lineage: write a child envelope (parent's lineageRootId, parentRevisionId,
     ordinal+1) instead of a root, with a deterministic child id over the same
     §5 hash-input subset (parent + adjustedInputsId + doctrineVersion). Early
     return leaves the ROOT branch below BYTE-IDENTICAL to the create path. */
  if (args.parentRevisionId !== undefined) {
    const parentEnvelope = store.getRevisionEnvelope(args.parentRevisionId);
    if (parentEnvelope === null) {
      throw new IngestionError({
        code: 'PARENT_REVISION_NOT_FOUND',
        parentRevisionId: args.parentRevisionId,
      });
    }
    const childRevisionId = computeRevisionId({
      parentRevisionId: args.parentRevisionId,
      adjustedInputsId: adjustedInputs.id,
      doctrineVersion: evaluation.doctrineVersion,
    });
    const childEnvelope: RevisionLineageEnvelope = {
      revisionId: childRevisionId,
      lineageRootId: parentEnvelope.lineageRootId,
      parentRevisionId: args.parentRevisionId,
      revisionOrdinal: parentEnvelope.revisionOrdinal + 1,
      doctrineEvaluationId: evaluation.id,
      adjustedInputsId: adjustedInputs.id,
      doctrineVersion: evaluation.doctrineVersion,
      judgmentEngineVersion: evaluation.judgmentEngineVersion,
      stressEngineVersion: evaluation.stressEngineVersion,
      valuationEngineVersion: evaluation.valuationEngineVersion,
    };
    store.insertRevisionLineageEnvelope(childEnvelope);

    /* Child provenance — child shape (borrowed from apply-revision-delta), with
       the REAL structural diff: parent AdjustedInputs vs this re-extraction's.
       DOC_APPEND names the append source. beforeHash/afterHash are the
       AdjustedInputs ids of the transition. */
    const parentAdjustedInputs = store.getAdjustedInputs(parentEnvelope.adjustedInputsId);
    if (parentAdjustedInputs === null) {
      throw new IngestionError({
        code: 'PARENT_REVISION_NOT_FOUND',
        parentRevisionId: args.parentRevisionId,
      });
    }
    const childProvenance: RevisionProvenance = {
      revisionId: childRevisionId,
      inputDiff: diffAdjustedInputs(parentAdjustedInputs, adjustedInputs),
      triggerSource: args.triggerSource ?? 'DOC_APPEND',
      appliedRuleIds: [],
      adjustmentOrigin: args.adjustmentOrigin ?? [],
      beforeHash: parentEnvelope.adjustedInputsId,
      afterHash: adjustedInputs.id,
    };
    store.insertRevisionProvenance(childProvenance);

    // Persist-on-ingest (Sunroad registry fix, Phase 1). Persist the EXACT
    // benchmarks/manifesto objects this ingest scored against — the same
    // objects whose ids are stamped on the eval-context below — BEFORE writing
    // the context, so the context is born resolvable (never orphaned). Both
    // inserts are content-addressed + ON CONFLICT DO NOTHING (idempotent): the
    // reference-id append path (registry already persisted) re-inserts the same
    // row as a no-op. Behavior-preserving: additive rows only; the eval-context
    // id boundary is unchanged (computeRevisionId ignores these ids).
    store.insertMarketBenchmarks(marketBenchmarks);
    store.insertCreditManifesto(creditManifesto);

    // A-enabler: record the evaluation context (the INHERITED benchmarks/manifesto
    // the orchestration passed — read off the parent) for the child, so a second
    // append (grandchild) can self-source. Additive sibling; no id boundary.
    store.insertRevisionEvaluationContext({
      revisionId: childRevisionId,
      marketBenchmarksId: marketBenchmarks.id,
      creditManifestoId: creditManifesto.id,
    });

    return { rootId: childRevisionId, evaluationId: evaluation.id, evaluation };
  }

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

  // Persist-on-ingest (Sunroad registry fix, Phase 1). Persist the EXACT
  // benchmarks/manifesto objects this root was evaluated against — the same
  // objects whose ids are stamped on the eval-context below — BEFORE writing
  // the context, so the context is born resolvable (never orphaned). Both
  // inserts are content-addressed + ON CONFLICT DO NOTHING (idempotent): an
  // inline registry equal to a pre-persisted one (reference path) re-inserts
  // the same row as a no-op. Behavior-preserving: additive rows only; the root
  // revision id is unchanged (computeRevisionId ignores these ids).
  store.insertMarketBenchmarks(marketBenchmarks);
  store.insertCreditManifesto(creditManifesto);

  // A-enabler: record the evaluation context (benchmarks/manifesto this root was
  // evaluated against) so the append flow can self-source it from the parent.
  // Additive sibling — computeRevisionId ignores these ids, so the root revision
  // id is unchanged.
  store.insertRevisionEvaluationContext({
    revisionId: rootRevisionId,
    marketBenchmarksId: marketBenchmarks.id,
    creditManifestoId: creditManifesto.id,
  });

  return { rootId: rootRevisionId, evaluationId: evaluation.id, evaluation };
}
