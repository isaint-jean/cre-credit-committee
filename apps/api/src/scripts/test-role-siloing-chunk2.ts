/**
 * Role-siloing chunk 2 — server-side denial of approve/reject/submit for ORIGINATOR,
 * locked with tests. Exercises the EXACT authorization function the /committee-actions
 * route uses (enforcePermission(req.user.role, KIND_PERMISSION_MAP[kind])), so this is
 * the security boundary, not a client check:
 *   - ORIGINATOR → APPROVE/REJECT/SUBMIT all DENIED (403 PERMISSION_DENIED).
 *   - BUYER → APPROVE/REJECT allowed (first-loss); SUBMIT denied.
 *   - COMMITTEE_MEMBER / ADMIN → approve/reject still allowed (no regression).
 *   - ANALYST → approve denied (unchanged internal-role behavior).
 * No deal state is mutated: this tests the authz gate, which the route runs BEFORE any
 * committee-action write. Live-HTTP denial (real token → real 403) is proven separately.
 *
 *   npm run test:role-siloing-chunk2
 */
import type { Request, Response } from 'express';
import { enforcePermission } from '../middleware/require-permission.js';
import type { Permission } from '@cre/contracts';

// Mirrors KIND_PERMISSION_MAP in routes/workflow.routes.ts (the route gates each action
// kind by exactly this permission via enforcePermission).
const KIND_PERMISSION: Record<string, Permission> = {
  APPROVE_DEAL: 'workflow:approve',
  REJECT_DEAL: 'workflow:reject',
  SUBMIT_TO_COMMITTEE: 'workflow:submit',
  REQUEST_MORE_INFO: 'workflow:request-info',
  POSTPONE_DEAL: 'workflow:postpone',
  OVERRIDE_DECISION: 'workflow:override',
};

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

/** Run the exact route gate for (role, kind): returns {allowed, statusCode, error}. */
function gate(role: string, kind: string): { allowed: boolean; statusCode: number; error: string | null } {
  const req = { user: { userId: 'u', email: 'u@x', role } } as unknown as Request;
  let statusCode = 200;
  let error: string | null = null;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: { error?: string }) { error = b?.error ?? null; return this; },
  } as unknown as Response;
  const allowed = enforcePermission(req, res, KIND_PERMISSION[kind]);
  return { allowed, statusCode, error };
}
const denied = (role: string, kind: string, m: string) => {
  const r = gate(role, kind);
  assert(!r.allowed && r.statusCode === 403 && r.error === 'PERMISSION_DENIED', m);
};
const allowed = (role: string, kind: string, m: string) => {
  const r = gate(role, kind);
  assert(r.allowed && r.statusCode === 200, m);
};

console.log('ORIGINATOR — DENIED the verdict (the hard doctrine guarantee):');
denied('ORIGINATOR', 'APPROVE_DEAL', 'ORIGINATOR APPROVE_DEAL → 403 PERMISSION_DENIED');
denied('ORIGINATOR', 'REJECT_DEAL', 'ORIGINATOR REJECT_DEAL → 403 PERMISSION_DENIED');
denied('ORIGINATOR', 'SUBMIT_TO_COMMITTEE', 'ORIGINATOR SUBMIT_TO_COMMITTEE → 403 PERMISSION_DENIED');

console.log('\nBUYER — first-loss approver (approve/reject allowed; cannot submit):');
allowed('BUYER', 'APPROVE_DEAL', 'BUYER APPROVE_DEAL → allowed');
allowed('BUYER', 'REJECT_DEAL', 'BUYER REJECT_DEAL → allowed');
denied('BUYER', 'SUBMIT_TO_COMMITTEE', 'BUYER SUBMIT_TO_COMMITTEE → 403 (buyer cannot submit)');

console.log('\nCOMMITTEE_MEMBER + ADMIN — no regression (still approve/reject):');
allowed('COMMITTEE_MEMBER', 'APPROVE_DEAL', 'COMMITTEE_MEMBER APPROVE_DEAL → allowed');
allowed('COMMITTEE_MEMBER', 'REJECT_DEAL', 'COMMITTEE_MEMBER REJECT_DEAL → allowed');
allowed('ADMIN', 'APPROVE_DEAL', 'ADMIN APPROVE_DEAL → allowed');
allowed('ADMIN', 'REJECT_DEAL', 'ADMIN REJECT_DEAL → allowed');

console.log('\nOther internal roles unchanged:');
denied('ANALYST', 'APPROVE_DEAL', 'ANALYST APPROVE_DEAL → 403 (unchanged — analyst cannot approve)');
allowed('ANALYST', 'SUBMIT_TO_COMMITTEE', 'ANALYST SUBMIT_TO_COMMITTEE → allowed (unchanged)');
denied('VIEWER', 'APPROVE_DEAL', 'VIEWER APPROVE_DEAL → 403 (unchanged)');

console.log(`\n${failed === 0 ? '✓' : '✗'} role-siloing-chunk2: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
