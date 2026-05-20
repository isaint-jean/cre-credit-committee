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
  type CommitteeActionEvent,
  type CommitteeActionId,
  type CommitteeActionKind,
  type CommitteeActionPayload,
  type CommitteeSnapshotId,
  type DoctrineEvaluationId,
  type OverlayId,
  type RenderedAnalysisId,
} from '@cre/contracts';
import { computeCommitteeActionId } from '../util/content-hash.js';
import { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';
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

/* --------- Permission map: which permission gates which kind ---------- */

const KIND_PERMISSION_MAP: { readonly [K in CommitteeActionKind]: string } = {
  SUBMIT_TO_COMMITTEE: 'workflow:submit',
  REQUEST_MORE_INFO:   'workflow:request-info',
  OVERRIDE_DECISION:   'workflow:override',
  APPROVE_DEAL:        'workflow:approve',
  REJECT_DEAL:         'workflow:reject',
  POSTPONE_DEAL:       'workflow:postpone',
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

