// Workflow API endpoints (Phase 4 - productization layer).
//
// Thin adapters over the existing pure projection services + storage layer. Each
// handler:
//   - Parses input (body or query string)
//   - Validates SHAPE only (no business validation)
//   - Delegates to existing services / stores
//   - Returns the result as JSON
//
// CRITICAL DISCIPLINE:
//   - No business logic in these handlers. State derivation is the projection
//     layer's job (computeDealWorkflowState / buildCommitteeTimeline / rebuildAuditChain).
//   - No second source of truth. Every read goes through the existing pure functions
//     against the existing append-only stores.
//   - Permission checks gate every handler via requirePermission.
//   - Side-channel observability: route-handler-level logs via res.locals; the
//     observability middleware records every request.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  COMMITTEE_ACTION_KINDS,
  RENDER_VERSION,
  type AuditEvent,
  type AuditOverlayCreatedPayload,
  type AuditPatchAddedPayload,
  type CommitteeActionEvent,
  type CommitteeActionId,
  type CommitteeActionKind,
  type CommitteeActionPayload,
  type CommitteeSnapshotId,
  type DoctrineEvaluationId,
  type OverlayCommentPatch,
  type OverlayId,
  type OverlayPatchId,
  type RenderedAnalysisId,
} from '@cre/contracts';
import {
  computeAuditEventId,
  computeCommitteeActionId,
  computeContentHash,
  computeOverlayPatchId,
} from '../util/content-hash.js';
import { enforceDealForRoot } from '../middleware/deal-access.js';
import { requireNegotiationLoop } from '../middleware/negotiation-flag.js';
import { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';
import { OverlayPatchesStore } from '../storage/overlay-patches-store.js';
import { computeDealWorkflowState } from '../services/compute-deal-workflow-state.js';
import { buildCommitteeTimeline } from '../services/build-committee-timeline.js';
import { rebuildAuditChain } from '../services/replay-overlays.js';
import { enforcePermission, requirePermission } from '../middleware/require-permission.js';
import { requireAuth } from '../middleware/auth.js';

export const workflowRoutes = Router();

// Lazily-instantiated singletons. Each store opens its own connection to the same
// sqlite file; opening on first use avoids tying app boot time to filesystem state.
let _actionsStore: CommitteeActionsStore | null = null;
function actionsStore(): CommitteeActionsStore {
  if (_actionsStore === null) _actionsStore = new CommitteeActionsStore();
  return _actionsStore;
}
let _auditStore: AuditEventsStore | null = null;
function auditStore(): AuditEventsStore {
  if (_auditStore === null) _auditStore = new AuditEventsStore();
  return _auditStore;
}
let _snapshotStore: CommitteeSnapshotsStore | null = null;
function snapshotStore(): CommitteeSnapshotsStore {
  if (_snapshotStore === null) _snapshotStore = new CommitteeSnapshotsStore();
  return _snapshotStore;
}
let _patchesStore: OverlayPatchesStore | null = null;
function patchesStore(): OverlayPatchesStore {
  if (_patchesStore === null) _patchesStore = new OverlayPatchesStore();
  return _patchesStore;
}

/* --------- Permission map: which permission gates which kind ---------- */

const KIND_PERMISSION_MAP: { readonly [K in CommitteeActionKind]: string } = {
  SUBMIT_TO_COMMITTEE: 'workflow:submit',
  REQUEST_MORE_INFO:   'workflow:request-info',
  OVERRIDE_DECISION:   'workflow:override',
  APPROVE_DEAL:        'workflow:approve',
  REJECT_DEAL:         'workflow:reject',
  POSTPONE_DEAL:       'workflow:postpone',
  // Chunk 7b — the originator comms kinds, gated by the 7a permissions (originator-only).
  ORIGINATOR_PUSHBACK: 'workflow:respond',
  CALL_REQUESTED:      'workflow:request-call',
  SEND_TO_BUYER:       'workflow:send-to-buyer',
};

function isKnownKind(kind: string): kind is CommitteeActionKind {
  return (COMMITTEE_ACTION_KINDS as readonly string[]).indexOf(kind) >= 0;
}

/* ------------------------ POST /committee-actions --------------------- */
//
// Body shape:
//   {
//     rootId: DoctrineEvaluationId,
//     renderedAnalysisId: RenderedAnalysisId,
//     snapshotId?: CommitteeSnapshotId,
//     kind: CommitteeActionKind,
//     payload: <variant matching kind>,
//     occurredAt?: ISODateTime  (defaults to server-stamped wall clock)
//   }
//
// Server constructs the full event:
//   - author from req.user.email (authenticated)
//   - previousActionId = chain head from existing actions for rootId
//   - id from content hash of body
//
// Returns the persisted action.

interface PostActionBody {
  rootId?: unknown;
  renderedAnalysisId?: unknown;
  snapshotId?: unknown;
  kind?: unknown;
  payload?: unknown;
  occurredAt?: unknown;
  // Phase 4 OVERRIDE_DECISION surface: when kind === 'OVERRIDE_DECISION' the
  // client sends overlayId as a top-level field and OMITS payload. The server
  // looks up the overlay binding, verifies renderedAnalysisId match, and
  // constructs the canonical OverrideDecisionPayload itself. Any other kind
  // MUST send payload as before; sending overlayId at the top level for non-
  // OVERRIDE kinds is ignored.
  overlayId?: unknown;
}

workflowRoutes.post('/committee-actions', requireAuth, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as PostActionBody;

  // Shape validation only.
  if (typeof body.rootId !== 'string' || body.rootId.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
  }
  if (typeof body.renderedAnalysisId !== 'string' || body.renderedAnalysisId.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'renderedAnalysisId required' });
  }
  if (typeof body.kind !== 'string' || !isKnownKind(body.kind)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'kind invalid' });
  }

  // Permission check matched to the action kind. The required permission depends
  // on the request body (one permission per action kind), so we use the inline
  // helper rather than static middleware.
  const permission = KIND_PERMISSION_MAP[body.kind];
  if (!enforcePermission(req, res, permission as never)) return;

  // Resolve payload. Two paths:
  //   1. OVERRIDE_DECISION: client sends overlayId at the top level and OMITS
  //      payload entirely. Server looks up the overlay binding via the audit log,
  //      verifies the renderedAnalysisId matches, and constructs the canonical
  //      OverrideDecisionPayload itself. This is the only safe entry point per
  //      the Phase 4 directive: the client cannot fabricate an override payload.
  //   2. Every other kind: client supplies payload; server validates payload.kind
  //      matches body.kind and uses it verbatim.
  let resolvedPayload: CommitteeActionPayload;
  if (body.kind === 'OVERRIDE_DECISION') {
    if (typeof body.overlayId !== 'string' || body.overlayId.length === 0) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'overlayId required for OVERRIDE_DECISION',
      });
    }
    const overlayId = body.overlayId as OverlayId;
    const binding = auditStore().getOverlayBinding(overlayId);
    if (binding === null) {
      return res.status(400).json({
        error: 'OVERLAY_NOT_FOUND',
        message: 'overlay has no overlay-created event recorded',
      });
    }
    if (binding.renderedAnalysisId !== body.renderedAnalysisId) {
      return res.status(400).json({
        error: 'OVERLAY_BINDING_MISMATCH',
        message: 'renderedAnalysisId does not match overlay binding',
      });
    }
    resolvedPayload = {
      kind: 'OVERRIDE_DECISION',
      overlayId,
      summary: 'Committee override registered for overlay ' + overlayId,
    };
  } else {
    if (typeof body.payload !== 'object' || body.payload === null) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'payload required' });
    }
    const payload = body.payload as { kind?: unknown };
    if (payload.kind !== body.kind) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'payload.kind must match kind' });
    }
    resolvedPayload = body.payload as CommitteeActionPayload;
  }

  // Derive author from the authenticated user.
  const author = req.user?.email ?? 'unknown';
  const occurredAt =
    typeof body.occurredAt === 'string' && body.occurredAt.length > 0
      ? body.occurredAt
      : new Date().toISOString();

  // Look up chain head for previousActionId. The chain is per-deal (rootId);
  // walking by previousActionId is the projection layer's job, but at insert
  // time the simpler "most recent action" is enough as the predecessor candidate
  // because committee actions form a single linear chain per deal.
  const existing = actionsStore().getByRoot(body.rootId as DoctrineEvaluationId);
  // Pick the action whose id is NOT referenced as anyone's previousActionId
  // (i.e. the chain tail). For an empty chain, tail = null.
  const referenced = new Set<string>();
  for (const a of existing) {
    if (a.previousActionId !== null) referenced.add(a.previousActionId);
  }
  let chainTail: CommitteeActionId | null = null;
  for (const a of existing) {
    if (!referenced.has(a.id)) { chainTail = a.id; break; }
  }

  const eventBody = {
    previousActionId: chainTail,
    rootId: body.rootId as DoctrineEvaluationId,
    renderedAnalysisId: body.renderedAnalysisId as RenderedAnalysisId,
    snapshotId: typeof body.snapshotId === 'string' && body.snapshotId.length > 0
      ? body.snapshotId as CommitteeSnapshotId
      : null,
    kind: body.kind,
    payload: resolvedPayload,
    author,
    occurredAt,
  };
  const event: CommitteeActionEvent = {
    id: computeCommitteeActionId(eventBody),
    ...eventBody,
  };

  try {
    actionsStore().insert(event);
  } catch (e) {
    const err = e as Error;
    return res.status(400).json({ error: err?.name ?? 'INSERT_ERROR', message: err?.message });
  }

  // Side-channel observability annotation
  res.locals.observability = {
    cacheHit: false,
    renderVersion: 'committee-action:' + body.kind,
  };

  return res.status(201).json({ action: event });
});

/* ------------------------------ POST /overlays ------------------------- */
//
// Net-new (converge phase i). Mints the `overlay-created` audit event that is the
// PRECONDITION for an OVERRIDE_DECISION committee action. Prior to this route the
// only writer of `overlay-created` was the test scripts, so the override path was
// unreachable from the running app (see docs/recon/2026-07-01-converge-plan.md §2).
//
// Body shape:
//   {
//     rootId: DoctrineEvaluationId,          // the RenderedAnalysis's own rootId
//     renderedAnalysisId: RenderedAnalysisId, // the RenderedAnalysis's own id
//     overlayKey?: string                     // stable per-lever namespace (default 'default')
//   }
//
// DESIGN — sound append-only chain anchor:
//   - The overlayId is DETERMINISTIC over (rootId, renderedAnalysisId, overlayKey):
//     `ov-<contentHash>`. This makes create idempotent per binding — one overlay per
//     (deal, lever), so re-ratifying a lever reuses the same overlay rather than
//     minting a fresh chain. The client re-derives the same id, so it never has to
//     remember an opaque server-issued id.
//   - The `overlay-created` event is the chain ROOT: previousEventId = null, payload
//     carries { renderedAnalysisId, renderVersion } (self-describing for replay).
//   - The event id is content-hashed and inserted ON CONFLICT DO NOTHING, so a second
//     POST for the same binding + author + timestamp is a structural no-op; a second
//     POST at a different time still resolves to the SAME overlayId (its distinct
//     overlay-created event is idempotently skipped by getOverlayBinding LIMIT 1).
//   - Author from req.user (authenticated). Shape validation only; no business logic.
//   - Gated by 'workflow:override' — the same permission as the OVERRIDE_DECISION it
//     anchors. Minting an overlay is meaningless without the ability to override it.
//
// Returns { overlayId, inserted }.

interface PostOverlayBody {
  rootId?: unknown;
  renderedAnalysisId?: unknown;
  overlayKey?: unknown;
  occurredAt?: unknown;
}

workflowRoutes.post('/overlays', requireAuth, (req: Request, res: Response) => {
  if (!requireNegotiationLoop(res)) return; // negotiation lever-agree/override anchor — shelved when off
  const body = (req.body ?? {}) as PostOverlayBody;

  // Shape validation only.
  if (typeof body.rootId !== 'string' || body.rootId.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
  }
  if (typeof body.renderedAnalysisId !== 'string' || body.renderedAnalysisId.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'renderedAnalysisId required' });
  }
  const overlayKey =
    typeof body.overlayKey === 'string' && body.overlayKey.length > 0 ? body.overlayKey : 'default';

  // Permission: minting an overlay is the anchor for OVERRIDE_DECISION; gate identically.
  if (!enforcePermission(req, res, 'workflow:override' as never)) return;

  const rootId = body.rootId as DoctrineEvaluationId;
  const renderedAnalysisId = body.renderedAnalysisId as RenderedAnalysisId;
  const renderVersion = RENDER_VERSION;

  // Deterministic overlayId per (deal, overlayKey). Same binding -> same id, always.
  // The sanitized overlayKey is embedded in the id so downstream consumers (e.g. the
  // committee-action summary, which is 'registered for overlay <overlayId>') carry a
  // stable, human-legible marker of WHICH binding was acted upon — the client re-reads
  // ratification from the persisted timeline by matching this marker, no hash recompute.
  const keyToken = overlayKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const overlayId = ('ov-' + keyToken + '-' +
    computeContentHash({ rootId, renderedAnalysisId, overlayKey, renderVersion }).slice(0, 24)) as OverlayId;

  // Idempotent short-circuit: if this overlay already has an overlay-created event,
  // return it without minting a second chain-root event.
  const existing = auditStore().getOverlayBinding(overlayId);
  if (existing !== null) {
    res.locals.observability = { cacheHit: true, renderVersion: 'overlay-created' };
    return res.status(200).json({ overlayId, inserted: false });
  }

  const author = req.user?.email ?? 'unknown';
  const occurredAt =
    typeof body.occurredAt === 'string' && body.occurredAt.length > 0
      ? body.occurredAt
      : new Date().toISOString();

  const payload: AuditOverlayCreatedPayload = {
    kind: 'overlay-created',
    renderedAnalysisId,
    renderVersion,
  };
  const eventBody = {
    previousEventId: null,
    overlayId,
    kind: 'overlay-created' as const,
    payload,
    author,
    occurredAt,
  };
  const event: AuditEvent = { id: computeAuditEventId(eventBody), ...eventBody };

  let inserted: boolean;
  try {
    const result = auditStore().insert(event, { rootId, renderVersion });
    inserted = result.inserted;
  } catch (e) {
    const err = e as Error;
    return res.status(400).json({ error: err?.name ?? 'INSERT_ERROR', message: err?.message });
  }

  res.locals.observability = { cacheHit: false, renderVersion: 'overlay-created' };
  return res.status(201).json({ overlayId, inserted });
});

/* ------------------------- POST /overlay-comments ---------------------- */
//
// Thin, graph-native comment-patch WRITE route. Mirrors POST /overlays: it appends
// to the EXISTING stores (overlayPatchesStore + auditEventsStore) — NOT a second
// store — and mints the same-shape audit event.
//
// Body shape:
//   {
//     overlayId: OverlayId,                    // the anchor minted by POST /overlays
//     path: string,                            // the lever/finding this comment is "re:"
//     text: string,                            // the comment body
//     side?: 'originator' | 'buyer'            // negotiation-view attribution (hash-EXCLUDED)
//   }
//
// The overlay's binding (rootId, renderVersion, renderedAnalysisId) is read from its
// overlay-created event — the client never supplies rooting fields, matching the
// OVERRIDE_DECISION discipline.
//
// DESIGN:
//   - Build the OverlayCommentPatch BODY (kind:'comment', path, author, text, createdAt).
//     `side` is NOT in the body → NOT in the content hash. The id hashes the body only.
//   - computeOverlayPatchId(body) → the patch id (recompute-verified again by the store).
//   - overlayPatchesStore.insert(patch, { overlayId, rootId, renderVersion, side }):
//     `side` rides the hash-excluded column.
//   - Mint a `comment-added` audit event (previousEventId = the overlay's chain head)
//     so the write shows on the committee timeline. Same content-hash + chain pattern
//     as the test scripts and POST /overlays.
//   - Gated by 'workflow:override' — identical to the anchor (POST /overlays); a
//     comment rides the same overlay the override does.
//
// Returns { patchId, inserted }.

interface PostOverlayCommentBody {
  overlayId?: unknown;
  path?: unknown;
  text?: unknown;
  side?: unknown;
}

workflowRoutes.post('/overlay-comments', requireAuth, (req: Request, res: Response) => {
  if (!requireNegotiationLoop(res)) return; // negotiation-framed comment thread — shelved when off
  const body = (req.body ?? {}) as PostOverlayCommentBody;

  // Shape validation only.
  if (typeof body.overlayId !== 'string' || body.overlayId.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'overlayId required' });
  }
  if (typeof body.path !== 'string' || body.path.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'path required' });
  }
  if (typeof body.text !== 'string' || body.text.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'text required' });
  }
  // `side` is optional and stored verbatim (hash-excluded). Only accept the known
  // negotiation sides; anything else is treated as absent (stored NULL).
  const side =
    body.side === 'originator' || body.side === 'buyer' ? (body.side as string) : null;

  // Permission: a comment rides the same overlay an override does; gate identically.
  if (!enforcePermission(req, res, 'workflow:override' as never)) return;

  const overlayId = body.overlayId as OverlayId;

  // Resolve the overlay's binding from its overlay-created event. The client never
  // supplies rooting fields (same discipline as OVERRIDE_DECISION).
  const binding = auditStore().getOverlayBinding(overlayId);
  if (binding === null) {
    return res.status(400).json({
      error: 'OVERLAY_NOT_FOUND',
      message: 'overlay has no overlay-created event recorded',
    });
  }
  const { rootId, renderVersion } = binding;

  const author = req.user?.email ?? 'unknown';
  const createdAt = new Date().toISOString();

  // Build the patch BODY — `side` is deliberately NOT here (hash-excluded).
  const patchBody = {
    kind: 'comment' as const,
    path: body.path,
    author,
    text: body.text,
    createdAt,
  };
  const patchId = computeOverlayPatchId(patchBody);
  const patch: OverlayCommentPatch = { id: patchId, ...patchBody };

  let patchInserted: boolean;
  try {
    const result = patchesStore().insert(patch, { overlayId, rootId, renderVersion, side });
    patchInserted = result.inserted;
  } catch (e) {
    const err = e as Error;
    return res.status(400).json({ error: err?.name ?? 'INSERT_ERROR', message: err?.message });
  }

  // Mint the `comment-added` audit event so the write surfaces on the timeline.
  // previousEventId = the overlay's current chain head (its most recent event).
  const chain = auditStore().getByOverlay(overlayId);
  const previousEventId = chain.length > 0 ? chain[chain.length - 1].id : null;
  const auditPayload: AuditPatchAddedPayload = {
    kind: 'comment-added',
    patchId: patchId as OverlayPatchId,
    summary: oneLineSummary(body.path, body.text),
  };
  const eventBody = {
    previousEventId,
    overlayId,
    kind: 'comment-added' as const,
    payload: auditPayload,
    author,
    occurredAt: createdAt,
  };
  const event: AuditEvent = { id: computeAuditEventId(eventBody), ...eventBody };
  try {
    auditStore().insert(event, { rootId, renderVersion });
  } catch (e) {
    const err = e as Error;
    return res.status(400).json({ error: err?.name ?? 'INSERT_ERROR', message: err?.message });
  }

  res.locals.observability = { cacheHit: false, renderVersion: 'comment-added' };
  return res.status(201).json({ patchId, inserted: patchInserted });
});

// Compact, deterministic audit summary for a comment ('re:<path> — <text head>').
function oneLineSummary(path: string, text: string): string {
  const head = text.replace(/\s+/g, ' ').trim();
  const clipped = head.length > 80 ? head.slice(0, 79) + '…' : head;
  return 're:' + path + ' — ' + clipped;
}

/* ------------------------- GET /overlay-comments ----------------------- */
//
// Query: ?rootId=<DoctrineEvaluationId>
// Returns: { rootId, comments: [{ patchId, path, author, text, createdAt, side }] }
//
// Reads the persisted comment patches for a root (via overlayPatchesStore.getByRootWithSide)
// and returns them WITH the hash-excluded `side` so NegotiationSurface can render them
// side-tagged. Comment kind only; overrides/tags are surfaced via other paths.
//
// Chosen over enriching the committee timeline: TimelineEntry is a locked pure
// projection (no text/path/side fields, TL3 "no synthesis"), so a thin read route that
// joins the patch text + side is the cleaner surface. audit:read gates it (a read of
// persisted overlay state).

workflowRoutes.get(
  '/overlay-comments',
  requireAuth,
  requirePermission('audit:read'),
  (req: Request, res: Response) => {
    const rootId = req.query.rootId;
    if (typeof rootId !== 'string' || rootId.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
    }
    if (!enforceDealForRoot(req, res, rootId)) return; // Chunk 3b (dark): gate the deal
    const rows = patchesStore().getByRootWithSide(rootId as DoctrineEvaluationId);
    const comments = rows
      .filter((r) => r.patch.kind === 'comment')
      .map((r) => {
        const c = r.patch as OverlayCommentPatch;
        return {
          patchId: c.id,
          path: c.path,
          author: c.author,
          text: c.text,
          createdAt: c.createdAt,
          side: r.side,
        };
      });
    return res.status(200).json({ rootId, comments });
  },
);

/* ----------------------- GET /workflow-state --------------------------- */
//
// Query: ?rootId=<DoctrineEvaluationId>
// Returns: DealWorkflowState (computed via the pure projection)

workflowRoutes.get(
  '/workflow-state',
  requireAuth,
  requirePermission('workflow:read'),
  (req: Request, res: Response) => {
    const rootId = req.query.rootId;
    if (typeof rootId !== 'string' || rootId.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
    }
    if (!enforceDealForRoot(req, res, rootId)) return; // Chunk 3b (dark): gate the deal
    const result = computeDealWorkflowState({
      rootId: rootId as DoctrineEvaluationId,
      committeeActionsStore: actionsStore(),
      auditEventsStore: auditStore(),
    });
    return res.status(200).json(result);
  },
);

/* --------------------- GET /committee-timeline ------------------------- */
//
// Query: ?rootId=<DoctrineEvaluationId>
// Returns: CommitteeTimeline (chronologically merged across all 3 sources)

workflowRoutes.get(
  '/committee-timeline',
  requireAuth,
  requirePermission('audit:read'),
  (req: Request, res: Response) => {
    const rootId = req.query.rootId;
    if (typeof rootId !== 'string' || rootId.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
    }
    if (!enforceDealForRoot(req, res, rootId)) return; // Chunk 3b (dark): gate the deal
    const result = buildCommitteeTimeline({
      rootId: rootId as DoctrineEvaluationId,
      auditEventsStore: auditStore(),
      committeeActionsStore: actionsStore(),
      committeeSnapshotsStore: snapshotStore(),
    });
    return res.status(200).json(result);
  },
);

/* ------------------------- GET /audit-replay --------------------------- */
//
// Query: ?rootId=<DoctrineEvaluationId>
// Returns: { rootId, chains: { [overlayId]: AuditEvent[] } }
// (chronological audit chain per overlay, reachable from each chain root)

workflowRoutes.get(
  '/audit-replay',
  requireAuth,
  requirePermission('audit:read'),
  (req: Request, res: Response) => {
    const rootId = req.query.rootId;
    if (typeof rootId !== 'string' || rootId.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'rootId required' });
    }
    if (!enforceDealForRoot(req, res, rootId)) return; // Chunk 3b (dark): gate the deal
    const chains = rebuildAuditChain(rootId as DoctrineEvaluationId, auditStore());
    // Convert Map to a plain object for JSON serialization. Stable key order
    // (Map iteration is insertion order; same input -> same output).
    const chainsObject: { [overlayId: string]: ReturnType<typeof rebuildAuditChain> extends ReadonlyMap<string, infer V> ? V : never } = {};
    for (const [overlayId, events] of chains.entries()) {
      chainsObject[overlayId] = events;
    }
    return res.status(200).json({ rootId, chains: chainsObject });
  },
);

