/**
 * Invite routes (Chunk 3d) — mount at /api/invites (with requireAuth).
 *
 *   POST /api/invites                 mint a buyer invite (owner/admin only)
 *   GET  /api/invites/:token          preview an invite for the accept page
 *   POST /api/invites/:token/accept   consume it → explicit buyer deal_access grant
 *
 * The token is a NEW AUTH SURFACE: unguessable, single-use, expiring; every failure
 * returns ONE generic message (no token-existence leak).
 */
import { Router, type Request, type Response } from 'express';
import { enforcePermission } from '../middleware/require-permission.js';
import { invitationStore } from '../storage/invitation-store.js';
import {
  canInviteToResource,
  acceptInvitation,
  AcceptInvitationError,
} from '../services/invitation.service.js';
import type { ResourceType } from '../storage/deal-access-store.js';

export const inviteRoutes = Router();

const GENERIC_INVALID = 'This invitation is invalid or has expired.';
function isValidType(t: unknown): t is ResourceType {
  return t === 'deal' || t === 'pool';
}

// POST /api/invites — an owner (or admin) mints a single-use buyer invite. Role-
// gated by workflow:send-to-buyer (ORIGINATOR + ADMIN; NOT buyer), then the self-
// dealing guard: must own the resource (a deal_access row) or be admin.
inviteRoutes.post('/', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'workflow:send-to-buyer')) return;
  const u = req.user!;
  const body = (req.body ?? {}) as {
    resourceType?: unknown;
    resourceKey?: unknown;
    invitedEmail?: unknown;
    expiresInDays?: unknown;
  };
  if (!isValidType(body.resourceType) || typeof body.resourceKey !== 'string' || body.resourceKey.length === 0) {
    res.status(400).json({ error: 'resourceType (deal|pool) and resourceKey are required' });
    return;
  }
  if (!canInviteToResource(u.userId, u.role, body.resourceType, body.resourceKey)) {
    res.status(403).json({ error: 'CANNOT_INVITE', message: 'you do not own this deal/pool' });
    return;
  }
  const inv = invitationStore().mint({
    resourceType: body.resourceType,
    resourceKey: body.resourceKey,
    invitedEmail: typeof body.invitedEmail === 'string' && body.invitedEmail.trim().length > 0 ? body.invitedEmail.trim() : null,
    grantedBy: u.userId,
    expiresInDays: typeof body.expiresInDays === 'number' ? body.expiresInDays : undefined,
  });
  res.status(201).json({
    token: inv.token,
    acceptUrl: `/invite/${inv.token}`,
    resourceType: inv.resourceType,
    resourceKey: inv.resourceKey,
    invitedEmail: inv.invitedEmail,
    expiresAt: inv.expiresAt,
  });
});

// GET /api/invites/:token — preview for the accept page. Fail-closed + generic.
inviteRoutes.get('/:token', (req: Request, res: Response) => {
  const inv = invitationStore().getByToken(req.params.token!);
  const invalid = !inv || inv.acceptedAt !== null || new Date(inv.expiresAt).getTime() <= Date.now();
  if (invalid) {
    res.status(404).json({ valid: false, error: GENERIC_INVALID });
    return;
  }
  res.json({
    valid: true,
    resourceType: inv!.resourceType,
    resourceKey: inv!.resourceKey,
    invitedEmail: inv!.invitedEmail,
    expiresAt: inv!.expiresAt,
  });
});

// POST /api/invites/:token/accept — consume + create the explicit buyer grant.
inviteRoutes.post('/:token/accept', (req: Request, res: Response) => {
  const u = req.user!;
  try {
    const result = acceptInvitation({ token: req.params.token!, userId: u.userId, userEmail: u.email });
    res.json({ accepted: true, ...result });
  } catch (e) {
    if (e instanceof AcceptInvitationError) {
      res.status(400).json({ accepted: false, error: GENERIC_INVALID }); // no leak of which failure
      return;
    }
    throw e;
  }
});
