/**
 * Chunk 7a — originator comms permissions + the role-gated kick. Additive to the matrix,
 * and the disposition route now enforces workflow:dispose. Exercises the EXACT authz
 * function the route uses (enforcePermission), so the kick gate is the SERVER boundary.
 *   - ORIGINATOR holds respond / request-call / send-to-buyer; does NOT hold dispose
 *     (cannot kick their own deal).
 *   - BUYER holds dispose (first-loss kick); does NOT hold the originator comms perms.
 *   - COMMITTEE_MEMBER + ADMIN hold dispose (internal terminal authority / superset).
 *   - ANALYST / CREDIT_OFFICER / VIEWER do NOT hold dispose (no terminal authority).
 *   - existing internal roles otherwise unregressed.
 *
 *   npm run test:role-siloing-chunk7a
 */
import type { Request, Response } from 'express';
import { ROLE_PERMISSIONS, roleHasPermission } from '@cre/contracts';
import { enforcePermission } from '../middleware/require-permission.js';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

/** The exact route gate: enforcePermission(req.user.role, 'workflow:dispose'). */
function kickGate(role: string): { allowed: boolean; statusCode: number; error: string | null } {
  const req = { user: { userId: 'u', email: 'u@x', role } } as unknown as Request;
  let statusCode = 200;
  let error: string | null = null;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: { error?: string }) { error = b?.error ?? null; return this; },
  } as unknown as Response;
  const allowed = enforcePermission(req, res, 'workflow:dispose' as never);
  return { allowed, statusCode, error };
}
const kickDenied = (role: string) => { const r = kickGate(role); assert(!r.allowed && r.statusCode === 403 && r.error === 'PERMISSION_DENIED', `${role} kick → 403 PERMISSION_DENIED`); };
const kickAllowed = (role: string) => { const r = kickGate(role); assert(r.allowed && r.statusCode === 200, `${role} kick → allowed`); };

console.log('ORIGINATOR comms perms (respond / request-call / send-to-buyer) + NO kick:');
assert(roleHasPermission('ORIGINATOR', 'workflow:respond'), 'ORIGINATOR has workflow:respond');
assert(roleHasPermission('ORIGINATOR', 'workflow:request-call'), 'ORIGINATOR has workflow:request-call');
assert(roleHasPermission('ORIGINATOR', 'workflow:send-to-buyer'), 'ORIGINATOR has workflow:send-to-buyer');
assert(!roleHasPermission('ORIGINATOR', 'workflow:dispose'), 'ORIGINATOR does NOT have workflow:dispose');

console.log('\nThe kick gate (enforcePermission workflow:dispose) — the server boundary:');
kickDenied('ORIGINATOR');   // cannot kick their own deal
kickAllowed('BUYER');       // first-loss kick
kickAllowed('COMMITTEE_MEMBER');
kickAllowed('ADMIN');
kickDenied('ANALYST');
kickDenied('CREDIT_OFFICER');
kickDenied('VIEWER');

console.log('\nBUYER holds the kick but NOT the originator comms perms:');
assert(roleHasPermission('BUYER', 'workflow:dispose'), 'BUYER has workflow:dispose');
assert(!roleHasPermission('BUYER', 'workflow:respond'), 'BUYER does NOT have workflow:respond');
assert(!roleHasPermission('BUYER', 'workflow:send-to-buyer'), 'BUYER does NOT have workflow:send-to-buyer');

console.log('\nADMIN superset holds all four new perms:');
for (const p of ['workflow:respond', 'workflow:request-call', 'workflow:send-to-buyer', 'workflow:dispose'] as const) {
  assert(roleHasPermission('ADMIN', p), `ADMIN has ${p}`);
}

console.log('\nExisting internal roles unregressed (additive only):');
const UNCHANGED: Record<string, readonly string[]> = {
  VIEWER: [],
  ANALYST: ['workflow:read', 'workflow:submit', 'workflow:override', 'audit:read', 'snapshot:read', 'snapshot:create', 'analysis:revise'],
  CREDIT_OFFICER: ['workflow:read', 'workflow:submit', 'workflow:request-info', 'workflow:override', 'audit:read', 'snapshot:read', 'snapshot:create', 'analysis:revise'],
};
for (const [role, perms] of Object.entries(UNCHANGED)) {
  const actual = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] as readonly string[];
  assert(JSON.stringify(actual) === JSON.stringify(perms), `${role} permissions unchanged`);
}
// COMMITTEE_MEMBER: exactly +dispose; nothing else changed, nothing lost.
assert(roleHasPermission('COMMITTEE_MEMBER', 'workflow:dispose'), 'COMMITTEE_MEMBER gained workflow:dispose (intended)');
assert(roleHasPermission('COMMITTEE_MEMBER', 'workflow:approve') && roleHasPermission('COMMITTEE_MEMBER', 'workflow:reject'), 'COMMITTEE_MEMBER kept approve/reject (no takeaway)');
assert(!roleHasPermission('COMMITTEE_MEMBER', 'workflow:respond'), 'COMMITTEE_MEMBER did not gain comms perms');

console.log(`\n${failed === 0 ? '✓' : '✗'} role-siloing-chunk7a: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
