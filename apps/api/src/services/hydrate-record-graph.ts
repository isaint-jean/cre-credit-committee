/**
 * Stage 11 — Hydration (Batch 6.5).
 *
 * Reconstructs the typed `HydratedRecordGraph` bundle for an analysis from a single
 * `DoctrineEvaluationId` root. Pure read; pure FK closure; pure topology.
 *
 * Distinct from `hydrate-underwriting-context.ts` (the legacy Stage-12 resolver, slated for
 * replacement in Batch 6.6). This file is Stage 11: bundle loader. Stage 12 is projection.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Hydration invariants (LOCKED — load-bearing). Any future change here must justify
 * conformance to every line below or the change is rejected on first reading.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *   HY1 — FK closure only. Reachability is exclusively via declared FKs in the
 *         record-graph-store schema. No computed joins on body content. No "find
 *         by date" or "match by name" lookups.
 *
 *   HY2 — No interpretation during reconstruction. Hydration is read + assemble.
 *         Forbidden in this file: nullish coalescing operator, logical-OR numeric
 *         defaulting, Math.max / Math.min, asset-class branching, Object.keys
 *         iteration-order leaks, Date.* wall-clock reads, Math.random. Any of
 *         these would convert the hydrator into a second ingestion layer that
 *         quietly synthesizes records — strictly forbidden.
 *
 *   HY3 — No fallback reconstruction. Any unresolved FK throws HydrationError.
 *         Silent substitution of missing nodes is forbidden. The empty CrossCheckResult
 *         emitted by the orchestrator (Batch 6.4 v1 gap) is persisted as a real row;
 *         hydration finds it via the normal FK lookup, not via fallback synthesis.
 *
 *   HY4 — Strict 1:1 identity resolution. One root id → exactly one bundle.
 *         One FK → exactly one row. Content-hash uniqueness guarantees this; this
 *         code preserves it (no LIMIT 1 over multiple matches, no "latest by created_at").
 *
 *   HY5 — Pure read. No store mutations during hydration. No write side-effects.
 *
 *   HY6 — Determinism. Same root → byte-identical bundle. No clock, no random,
 *         no env, no filesystem, no network.
 *
 *   HY7 — Mode-invariant. Hydration takes only the root id. Mode is a Stage 12
 *         resolver concern, NEVER a hydration parameter.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Single-hop topology (Batch 6.5 schema):
 *
 *   DoctrineEvaluationId ─ root lookup ─→ DoctrineEvaluation
 *                                            │
 *                                            ├─ adjustedInputsId      ─→ AdjustedInputs
 *                                            ├─ librarySnapshotId     ─→ LibrarySnapshot
 *                                            ├─ narrativeFactsId      ─→ NarrativeFacts
 *                                            ├─ crossCheckResultId    ─→ CrossCheckResult
 *                                            ├─ stressOutputsId       ─→ StressOutputs
 *                                            ├─ valuationConclusionId ─→ ValuationConclusion
 *                                            ├─ assetProfileId        ─→ AssetProfile
 *                                            └─ extractionResultId    ─→ ExtractionResult
 *
 * Every record in the bundle is reachable in exactly one FK lookup from the root.
 * No transitive chains. No multi-hop traversal. No alternate paths.
 */

import type {
  DoctrineEvaluationId,
  HydratedRecordGraph,
} from '@cre/contracts';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

/* ------------------------------- error type -------------------------------- */

export type HydrationErrorCode =
  | 'DOCTRINE_EVALUATION_NOT_FOUND'
  | 'DANGLING_FK_ADJUSTED_INPUTS'
  | 'DANGLING_FK_LIBRARY_SNAPSHOT'
  | 'DANGLING_FK_NARRATIVE_FACTS'
  | 'DANGLING_FK_CROSS_CHECK_RESULT'
  | 'DANGLING_FK_STRESS_OUTPUTS'
  | 'DANGLING_FK_VALUATION_CONCLUSION'
  | 'DANGLING_FK_ASSET_PROFILE'
  | 'DANGLING_FK_EXTRACTION_RESULT';

export interface HydrationErrorContext {
  readonly code: HydrationErrorCode;
  readonly rootId?: string;
  readonly missingId?: string;
}

export class HydrationError extends Error {
  override readonly name = 'HydrationError';
  readonly code: HydrationErrorCode;
  readonly context: HydrationErrorContext;

  constructor(context: HydrationErrorContext) {
    super(`Hydration failed: ${context.code}`);
    this.code = context.code;
    this.context = context;
  }
}

/* --------------------------------- hydrate -------------------------------- */

export function hydrateRecordGraph(
  rootId: DoctrineEvaluationId,
  store: RecordGraphStore,
): HydratedRecordGraph {
  /* Root lookup. */
  const doctrineEvaluation = store.getDoctrineEvaluation(rootId);
  if (doctrineEvaluation === null) {
    throw new HydrationError({ code: 'DOCTRINE_EVALUATION_NOT_FOUND', rootId });
  }

  /* Single-hop fan-out. Each FK resolves or throws. */
  const adjustedInputs = store.getAdjustedInputs(doctrineEvaluation.adjustedInputsId);
  if (adjustedInputs === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_ADJUSTED_INPUTS',
      rootId,
      missingId: doctrineEvaluation.adjustedInputsId,
    });
  }

  const librarySnapshot = store.getLibrarySnapshot(doctrineEvaluation.librarySnapshotId);
  if (librarySnapshot === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_LIBRARY_SNAPSHOT',
      rootId,
      missingId: doctrineEvaluation.librarySnapshotId,
    });
  }

  const narrativeFacts = store.getNarrativeFacts(doctrineEvaluation.narrativeFactsId);
  if (narrativeFacts === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_NARRATIVE_FACTS',
      rootId,
      missingId: doctrineEvaluation.narrativeFactsId,
    });
  }

  const crossCheckResult = store.getCrossCheckResult(doctrineEvaluation.crossCheckResultId);
  if (crossCheckResult === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_CROSS_CHECK_RESULT',
      rootId,
      missingId: doctrineEvaluation.crossCheckResultId,
    });
  }

  const stressOutputs = store.getStressOutputs(doctrineEvaluation.stressOutputsId);
  if (stressOutputs === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_STRESS_OUTPUTS',
      rootId,
      missingId: doctrineEvaluation.stressOutputsId,
    });
  }

  const valuationConclusion = store.getValuationConclusion(doctrineEvaluation.valuationConclusionId);
  if (valuationConclusion === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_VALUATION_CONCLUSION',
      rootId,
      missingId: doctrineEvaluation.valuationConclusionId,
    });
  }

  const assetProfile = store.getAssetProfile(doctrineEvaluation.assetProfileId);
  if (assetProfile === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_ASSET_PROFILE',
      rootId,
      missingId: doctrineEvaluation.assetProfileId,
    });
  }

  const extractionResult = store.getExtractionResult(doctrineEvaluation.extractionResultId);
  if (extractionResult === null) {
    throw new HydrationError({
      code: 'DANGLING_FK_EXTRACTION_RESULT',
      rootId,
      missingId: doctrineEvaluation.extractionResultId,
    });
  }

  return {
    doctrineEvaluation,
    valuationConclusion,
    stressOutputs,
    crossCheckResult,
    adjustedInputs,
    narrativeFacts,
    librarySnapshot,
    assetProfile,
    extractionResult,
  };
}
