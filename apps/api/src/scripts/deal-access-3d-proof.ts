/**
 * PROOF — Chunk 3d: invite → accept → EXPLICIT deal_access grant. Fully in-memory
 * + synthetic ids → the real cre.db is never written (canonical deal_access stays
 * 48 rows; no invitations table is created on it). Proves:
 *   - self-dealing guard: only an OWNER (deal_access row) or ADMIN may invite;
 *   - accept creates the EXPLICIT buyer grant (accepted_at NULL — pends confi 3c);
 *   - with the flag ON the invited buyer can read THAT deal (DIRECT grant, no
 *     derivation) but still not others;
 *   - token is single-use (reuse rejected), expiring (expired rejected), email-
 *     bound (mismatch rejected), and an unknown token is rejected — all fail-closed.
 *
 * Run: npx tsx src/scripts/deal-access-3d-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { InvitationStore, setInvitationStore } from '../storage/invitation-store.js';
import { canInviteToResource, acceptInvitation, AcceptInvitationError, type AcceptFailure } from '../services/invitation.service.js';
import { canAccessDeal } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
function expectAccept(label: string, fn: () => void, code: AcceptFailure): void {
  try { fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, e instanceof AcceptInvitationError && e.code === code, e instanceof AcceptInvitationError ? e.code : String(e)); }
}

const ORIG = '__orig__', BUYER = '__buyer__', ADMIN = '__admin__';
const DEAL = '__test_deal__', OTHER = '__other_deal__';

function main(): void {
  const canonicalBefore = new DealAccessStore(DB_PATH).countAll();
  console.log('\nDeal-access 3d proof — invite/accept → explicit grant (in-memory; canonical-safe)\n');

  const access = new DealAccessStore(':memory:');
  const invites = new InvitationStore(':memory:');
  setDealAccessStore(access);
  setInvitationStore(invites);
  try {
    // Originator owns DEAL (a deal_access row). Nobody owns OTHER.
    access.grant({ resourceType: 'deal', resourceKey: DEAL, userId: ORIG, party: 'originator' });

    // ── self-dealing guard ──────────────────────────────────────────────────
    check('owner (originator) CAN invite to their deal', canInviteToResource(ORIG, 'ORIGINATOR', 'deal', DEAL));
    check('non-owner originator CANNOT invite to a deal they do not own', !canInviteToResource(ORIG, 'ORIGINATOR', 'deal', OTHER));
    check('admin CAN invite to any resource (bypass)', canInviteToResource(ADMIN, 'ADMIN', 'deal', OTHER));
    check('buyer (no ownership) CANNOT invite', !canInviteToResource(BUYER, 'BUYER', 'deal', DEAL));

    // ── mint → accept → explicit grant ──────────────────────────────────────
    const inv = invites.mint({ resourceType: 'deal', resourceKey: DEAL, grantedBy: ORIG });
    check('mint returns a 64-hex unguessable token', /^[0-9a-f]{64}$/.test(inv.token), `${inv.token.slice(0, 12)}…`);
    check('buyer has NO grant before accept', !access.has('deal', DEAL, BUYER));
    const r = acceptInvitation({ token: inv.token, userId: BUYER, userEmail: 'buyer@x.com' });
    check('accept returns the resource', r.resourceType === 'deal' && r.resourceKey === DEAL);
    check('accept created the EXPLICIT buyer grant (no derivation)', access.has('deal', DEAL, BUYER));
    check('grant pends confi — accepted_at is NULL', access.listForResource('deal', DEAL).find((x) => x.userId === BUYER)?.acceptedAt === null);

    // ── flag ON: invited buyer reads THAT deal, not others ──────────────────
    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';
    check('flag ON — invited buyer CAN read the accepted deal (direct grant)', canAccessDeal(BUYER, 'BUYER', DEAL));
    check('flag ON — invited buyer still DENIED an un-invited deal', !canAccessDeal(BUYER, 'BUYER', OTHER));
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';

    // ── token hardening ─────────────────────────────────────────────────────
    expectAccept('single-use — reusing a spent token is rejected', () => acceptInvitation({ token: inv.token, userId: BUYER, userEmail: 'buyer@x.com' }), 'USED');
    expectAccept('unknown token is rejected', () => acceptInvitation({ token: 'deadbeef', userId: BUYER }), 'INVALID');

    const expired = invites.mint({ resourceType: 'deal', resourceKey: DEAL, grantedBy: ORIG, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expectAccept('expired token is rejected', () => acceptInvitation({ token: expired.token, userId: BUYER }), 'EXPIRED');

    const bound = invites.mint({ resourceType: 'deal', resourceKey: DEAL, grantedBy: ORIG, invitedEmail: 'named@buyer.com' });
    expectAccept('email-bound token rejects a different accepting email', () => acceptInvitation({ token: bound.token, userId: BUYER, userEmail: 'someone@else.com' }), 'EMAIL_MISMATCH');
    const rBound = acceptInvitation({ token: bound.token, userId: BUYER, userEmail: 'NAMED@buyer.com' }); // case-insensitive match
    check('email-bound token accepts the matching email (case-insensitive)', rBound.resourceKey === DEAL);
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
    setInvitationStore(null);
  }

  const canonicalAfter = new DealAccessStore(DB_PATH).countAll();
  check('canonical deal_access untouched (48 rows)', canonicalAfter === canonicalBefore, `${canonicalBefore} → ${canonicalAfter}`);
  console.log(failures === 0 ? '\ndeal-access 3d proof: OK\n' : `\ndeal-access 3d proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
