// Materialization wrapper for RenderedAnalysis (post-6.8 caching layer).
//
// Lazy memoization: cache check first; on miss, run the read-pole pipeline
// (hydrate -> project -> render) and persist the result. Subsequent calls for the same
// (rootId, renderVersion) hit cache.
//
// Architectural placement (per the post-6.8 caching directive):
//   - This wrapper sits ABOVE the render service. It does NOT live inside the render
//     module itself. Render's RD1 invariant (no upstream reach-back, no store imports)
//     is preserved: render-underwriting-context.ts still imports nothing computational.
//   - This wrapper is consumed by ROUTE handlers only (GET /api/analyses/:id graph
//     branch and POST /api/render). Route handlers may compose hydrate / project /
//     render / store imports; the render service may not.
//   - dispatchByIdFormat is unchanged. The unified-read contract is preserved: format
//     classification still happens once, at the route boundary, before this wrapper is
//     ever called.
//
// Determinism:
//   Cache hit and cache miss produce identical RenderedAnalysisId for the same
//   (rootId, renderVersion). RD4 + content-hash addressing guarantee this; the cache
//   never returns a different body than what fresh computation would produce.
//
// Cache semantics:
//   - Append-only. ON CONFLICT(id) DO NOTHING on insert. No invalidation surface.
//   - Keyed by (rootId, renderVersion) on lookup; primary key is RenderedAnalysisId.
//   - A render-version bump produces new cache entries while old ones remain (orphans
//     for previous versions; can be GC'd later if storage growth becomes an issue).

import {
  NARRATIVE_ENGINE_VERSION,
  RENDER_VERSION,
  type DoctrineEvaluationId,
  type RenderedAnalysis,
} from '@cre/contracts';
import { hydrateRecordGraph } from './hydrate-record-graph.js';
import { buildUnderwritingContextProjection } from './build-underwriting-context-projection.js';
import { renderUnderwritingContext } from './render-underwriting-context.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

export interface MaterializationResult {
  readonly rendered: RenderedAnalysis;
  readonly cacheHit: boolean;
}

// Returns the RenderedAnalysis for the given root, computing and caching it if not
// already materialized at the current render version. Throws HydrationError on dangling
// FKs (propagated from the read-pole pipeline); throws other downstream errors as-is.
//
// Two-call form available via materializeRenderedAnalysisWithMeta when callers need
// to know whether the result came from cache (e.g., for observability / metrics).
// The simpler form below returns just the record.
export function materializeRenderedAnalysis(
  rootId: DoctrineEvaluationId,
  store: RecordGraphStore,
): RenderedAnalysis {
  return materializeRenderedAnalysisWithMeta(rootId, store).rendered;
}

export function materializeRenderedAnalysisWithMeta(
  rootId: DoctrineEvaluationId,
  store: RecordGraphStore,
): MaterializationResult {
  /* Narrative fetch first (Piece A Phase 1 batch 2 / Q-R2' (iii) + Q-R3 (p)).
     The HRG bundle FK-closes the doctrine + 8 spine records but NOT the
     NarrativeEvaluation sibling; we pull the latest narrative for the
     bundle's AdjustedInputs at the current NARRATIVE_ENGINE_VERSION and
     use its id as part of the cache lookup key. Different narrative content
     → different RenderedAnalysisId → cache miss → fresh render with the new
     prose. */
  const bundle = hydrateRecordGraph(rootId, store);
  const narrative = store.getLatestNarrativeForAdjustedInputs(
    bundle.adjustedInputs.id,
    NARRATIVE_ENGINE_VERSION,
  );
  const narrativeId = narrative?.id ?? null;

  const cached = store.getRenderedAnalysisByRoot(rootId, RENDER_VERSION, narrativeId);
  if (cached !== null) {
    return { rendered: cached, cacheHit: true };
  }

  // Cold path: project + render (passing narrative through to renderUnderwritingContext).
  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  const rendered = renderUnderwritingContext(ctx, narrative);
  store.insertRenderedAnalysis(rendered, narrativeId);
  return { rendered, cacheHit: false };
}
