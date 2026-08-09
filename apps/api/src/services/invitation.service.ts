/**
 * Invitation service (Chunk 3d) — the self-dealing guard + accept-and-grant.
 *
 * Accept mints an EXPLICIT buyer deal_access row (the reliable grant path — no
 * reliance on 3b's best-effort pool→deal derivation). accepted_at on that row is
 * LEFT NULL: access still pends the confidentiality gate (3c).
 */
import { dealAccessStore } from '../storage/deal-access-store.js';
import type { ResourceType } from '../storage/deal-access-store.js';
import { invitationStore } from '../storage/invitation-store.js';

function isAdmin(role: string | undefined): boolean {
  return typeof role === 'string' && role.toUpperCase() === 'ADMIN';
}

/** Self-dealing guard: only ADMIN, or an OWNER of the resource (has a deal_access
 *  row on it), may invite a buyer to it. An originator cannot invite to a deal or
 *  pool they do not own. */
export function canInviteToResource(
  userId: string,
  role: string | undefined,
  resourceType: ResourceType,
  resourceKey: string,
): boolean {
  if (isAdmin(role)) return true;
  return dealAccessStore().has(resourceType, resourceKey, userId);
}

export type AcceptFailure = 'INVALID' | 'EXPIRED' | 'USED' | 'EMAIL_MISMATCH';

export class AcceptInvitationError extends Error {
  readonly code: AcceptFailure;
  constructor(code: AcceptFailure) {
    super(code);
    this.name = 'AcceptInvitationError';
    this.code = code;
  }
}

export interface AcceptResult {
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly party: 'buyer';
}

/**
 * Validate + consume an invite, then create the explicit buyer deal_access grant.
 * Fail-closed: any validation problem throws AcceptInvitationError (the route maps
 * every failure to ONE generic message so a token's existence never leaks).
 */
export function acceptInvitation(args: { token: string; userId: string; userEmail?: string }): AcceptResult {
  const inv = invitationStore().getByToken(args.token);
  if (!inv) throw new AcceptInvitationError('INVALID');
  if (inv.acceptedAt) throw new AcceptInvitationError('USED');
  if (new Date(inv.expiresAt).getTime() <= Date.now()) throw new AcceptInvitationError('EXPIRED');
  if (inv.invitedEmail && inv.invitedEmail.toLowerCase() !== (args.userEmail ?? '').toLowerCase()) {
    throw new AcceptInvitationError('EMAIL_MISMATCH');
  }

  // Consume single-use FIRST (guards a reuse race): if it was spent between our
  // read and now, markAccepted returns false → treat as already USED.
  if (!invitationStore().markAccepted(args.token, args.userId)) {
    throw new AcceptInvitationError('USED');
  }

  // The EXPLICIT grant — reliable, no derivation. accepted_at NULL → still pends
  // the confidentiality gate (3c) before the data room opens.
  dealAccessStore().grant({
    resourceType: inv.resourceType,
    resourceKey: inv.resourceKey,
    userId: args.userId,
    party: 'buyer',
    grantedBy: inv.grantedBy,
    acceptedAt: null,
  });

  return { resourceType: inv.resourceType, resourceKey: inv.resourceKey, party: 'buyer' };
}
