// Render route (Batch 6.7) - POST /api/render.
//
// Dumb constructor: hydrate -> project -> render -> return. Validates body shape; delegates
// all logic to the three pure stages. Per the locked semantics model, the route handler does
// not interpret meaning. The render service produces the human-facing output; everything in
// between is pure transport.
//
// Body shape: { rootId: DoctrineEvaluationId }
// On success: 200 with the RenderedAnalysis record.
// On error: 400 with the underlying error name and message (HydrationError surfaces here when
//           the rootId is unknown or a FK is dangling).
//
// Strict-dispatch unification with the legacy /api/underwriting/render arrives in Batch 6.8.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { HydrationError } from '../services/hydrate-record-graph.js';
import { materializeRenderedAnalysisWithMeta } from '../services/materialize-rendered-analysis.js';
import { recordGraphStore } from '../storage/record-graph-store.js';

export const renderV2Routes = Router();

interface RenderRequestBody {
  rootId?: unknown;
}

renderV2Routes.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as RenderRequestBody;

  if (typeof body.rootId !== 'string' || body.rootId.length === 0) {
    return res.status(400).json({
      error: 'RENDER_BAD_REQUEST',
      message: 'rootId (string) is required',
    });
  }

  try {
    // Memoized read-pole pipeline (post-6.8 caching layer).
    const meta = materializeRenderedAnalysisWithMeta(body.rootId as never, recordGraphStore);
    // Side-channel observability: telemetry only, never used for routing.
    res.locals.observability = {
      cacheHit: meta.cacheHit,
      renderVersion: meta.rendered.metadata.renderVersion,
    };
    return res.status(200).json(meta.rendered);
  } catch (e) {
    if (e instanceof HydrationError) {
      return res.status(400).json({
        error: e.code,
        message: e.message,
        ...e.context,
      });
    }
    const err = e as Error;
    return res.status(400).json({
      error: err?.name ?? 'RENDER_ERROR',
      message: err?.message ?? 'Render failed',
    });
  }
});
