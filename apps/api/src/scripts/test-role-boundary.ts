/**
 * Tests for the legacy → new-spine role translation at the auth boundary.
 *
 *   tsx src/scripts/test-role-boundary.ts
 *
 * Covers:
 *   - normalizeRoleAtBoundary: lowercase legacy → uppercase new-spine; passthrough
 *     for already-uppercase and unknown values
 *   - requireAuth middleware: legacy lowercase JWTs are normalized at decode time
 *     (defense-in-depth for tokens issued before this fix)
 *   - enforcePermission: ADMIN passes registry:write; VIEWER fails with
 *     PERMISSION_DENIED (NOT UNKNOWN_ROLE — VIEWER is a known role with an
 *     empty permission set); a genuinely-unknown role yields UNKNOWN_ROLE
 *   - The JWT sign path: signing with a legacy role from the DB, then decoding,
 *     yields an uppercase role on req.user (verifies sign-time translation
 *     composes with decode-time normalization)
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { LEGACY_ROLE_TO_NEW, normalizeRoleAtBoundary, requireAuth } from '../middleware/auth.js';
import { enforcePermission } from '../middleware/require-permission.js';
import { env } from '../config/env.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------ mock req/res/next builders ---------------------- */

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeNext(): { called: boolean; fn: NextFunction } {
  const ref = { called: false } as { called: boolean; fn: NextFunction };
  ref.fn = () => { ref.called = true; };
  return ref;
}

/* ---------------------------- 1. translation ----------------------------- */

console.log('normalizeRoleAtBoundary:');
{
  assertEqual(normalizeRoleAtBoundary('admin'), 'ADMIN', '1.1 admin → ADMIN');
  assertEqual(normalizeRoleAtBoundary('analyst'), 'ANALYST', '1.2 analyst → ANALYST');
  assertEqual(normalizeRoleAtBoundary('viewer'), 'VIEWER', '1.3 viewer → VIEWER');
  assertEqual(normalizeRoleAtBoundary('ADMIN'), 'ADMIN', '1.4 ADMIN passes through');
  assertEqual(normalizeRoleAtBoundary('CREDIT_OFFICER'), 'CREDIT_OFFICER', '1.5 CREDIT_OFFICER passes through');
  assertEqual(normalizeRoleAtBoundary('unknown_role'), 'unknown_role', '1.6 unknown passes through (downstream surfaces UNKNOWN_ROLE)');
}

console.log('\nLEGACY_ROLE_TO_NEW map covers all three legacy values:');
{
  assertEqual(Object.keys(LEGACY_ROLE_TO_NEW).sort().join(','), 'admin,analyst,viewer', '2.1 keys are admin/analyst/viewer');
  assertEqual(LEGACY_ROLE_TO_NEW.admin, 'ADMIN', '2.2 admin → ADMIN');
  assertEqual(LEGACY_ROLE_TO_NEW.analyst, 'ANALYST', '2.3 analyst → ANALYST');
  assertEqual(LEGACY_ROLE_TO_NEW.viewer, 'VIEWER', '2.4 viewer → VIEWER');
}

/* ----------------- 2. requireAuth normalization on decode ---------------- */

console.log('\nrequireAuth normalizes legacy-lowercase JWTs at decode time:');
{
  // Simulate a JWT signed BEFORE the auth.routes.ts boundary translation
  // landed — payload role is the raw legacy lowercase string.
  const oldStyleToken = jwt.sign(
    { userId: 'u1', email: 'admin@example.com', role: 'admin' },
    env.jwtSecret,
    { expiresIn: '7d' },
  );
  const req = { headers: { authorization: `Bearer ${oldStyleToken}` }, user: undefined } as unknown as Request;
  const res = makeRes();
  const next = makeNext();
  requireAuth(req, res as unknown as Response, next.fn);
  assertEqual(next.called, true, '3.1 next() called (auth passed)');
  assertEqual(req.user?.role ?? null, 'ADMIN', '3.2 req.user.role normalized to ADMIN');
  assertEqual(req.user?.userId ?? null, 'u1', '3.3 other payload fields preserved');
}

console.log('\nrequireAuth passes new-spine uppercase JWTs through unchanged:');
{
  const newStyleToken = jwt.sign(
    { userId: 'u2', email: 'committee@example.com', role: 'COMMITTEE_MEMBER' },
    env.jwtSecret,
    { expiresIn: '7d' },
  );
  const req = { headers: { authorization: `Bearer ${newStyleToken}` }, user: undefined } as unknown as Request;
  const res = makeRes();
  const next = makeNext();
  requireAuth(req, res as unknown as Response, next.fn);
  assertEqual(next.called, true, '4.1 next() called');
  assertEqual(req.user?.role ?? null, 'COMMITTEE_MEMBER', '4.2 uppercase role preserved (no-op normalization)');
}

console.log('\nrequireAuth: missing / bad token unchanged:');
{
  /* 5. no auth header → 401 */
  const reqNoHeader = { headers: {}, user: undefined } as unknown as Request;
  const res = makeRes();
  const next = makeNext();
  requireAuth(reqNoHeader, res as unknown as Response, next.fn);
  assertEqual(res.statusCode, 401, '5.1 no auth header → 401');
  assertEqual(next.called, false, '5.2 next not called');

  /* 6. malformed token → 401 */
  const reqBad = { headers: { authorization: 'Bearer garbage' }, user: undefined } as unknown as Request;
  const res2 = makeRes();
  const next2 = makeNext();
  requireAuth(reqBad, res2 as unknown as Response, next2.fn);
  assertEqual(res2.statusCode, 401, '6.1 garbage token → 401');
  assertEqual(next2.called, false, '6.2 next not called');
}

/* --------------- 3. enforcePermission against new-spine roles ------------ */

console.log('\nenforcePermission(registry:write):');
{
  /* 7. ADMIN has registry:write → next() */
  const req = { user: { userId: 'u', email: 'a@b', role: 'ADMIN' } } as unknown as Request;
  const res = makeRes();
  const allowed = enforcePermission(req, res as unknown as Response, 'registry:write');
  assertEqual(allowed, true, '7.1 ADMIN allowed');
  assertEqual(res.statusCode, 0, '7.2 no error response written');
}

{
  /* 8. VIEWER is known but lacks registry:write → 403 PERMISSION_DENIED */
  const req = { user: { userId: 'u', email: 'v@b', role: 'VIEWER' } } as unknown as Request;
  const res = makeRes();
  const allowed = enforcePermission(req, res as unknown as Response, 'registry:write');
  assertEqual(allowed, false, '8.1 VIEWER denied');
  assertEqual(res.statusCode, 403, '8.2 status 403');
  const body = res.body as { error?: string; role?: string; required?: string };
  assertEqual(body.error ?? null, 'PERMISSION_DENIED', '8.3 error code PERMISSION_DENIED (not UNKNOWN_ROLE)');
  assertEqual(body.role ?? null, 'VIEWER', '8.4 response reports the role');
  assertEqual(body.required ?? null, 'registry:write', '8.5 response reports the required permission');
}

{
  /* 9. ANALYST also lacks registry:write → 403 PERMISSION_DENIED */
  const req = { user: { userId: 'u', email: 'a@b', role: 'ANALYST' } } as unknown as Request;
  const res = makeRes();
  const allowed = enforcePermission(req, res as unknown as Response, 'registry:write');
  assertEqual(allowed, false, '9.1 ANALYST denied');
  assertEqual(res.statusCode, 403, '9.2 status 403');
  const body = res.body as { error?: string };
  assertEqual(body.error ?? null, 'PERMISSION_DENIED', '9.3 error code PERMISSION_DENIED');
}

{
  /* 10. genuinely unknown role → 403 UNKNOWN_ROLE (distinct error code) */
  const req = { user: { userId: 'u', email: 'x@b', role: 'ROOT' } } as unknown as Request;
  const res = makeRes();
  const allowed = enforcePermission(req, res as unknown as Response, 'registry:write');
  assertEqual(allowed, false, '10.1 unknown role denied');
  assertEqual(res.statusCode, 403, '10.2 status 403');
  const body = res.body as { error?: string };
  assertEqual(body.error ?? null, 'UNKNOWN_ROLE', '10.3 error code UNKNOWN_ROLE (distinct from PERMISSION_DENIED)');
}

/* ---------- 4. Composite: legacy JWT → decode + permission check --------- */

console.log('\nComposite: legacy lowercase JWT → requireAuth → enforcePermission(registry:write):');
{
  // Simulates the production path: an old user JWT (issued before this fix
  // with lowercase 'admin') comes in, gets normalized at the auth boundary,
  // then the permission check on the registry POST succeeds.
  const oldAdminToken = jwt.sign(
    { userId: 'u', email: 'admin@example.com', role: 'admin' },
    env.jwtSecret,
    { expiresIn: '7d' },
  );
  const req = { headers: { authorization: `Bearer ${oldAdminToken}` }, user: undefined } as unknown as Request;
  const res = makeRes();
  const next = makeNext();
  requireAuth(req, res as unknown as Response, next.fn);
  assertEqual(next.called, true, '11.1 requireAuth passes legacy-admin JWT');
  assertEqual(req.user?.role ?? null, 'ADMIN', '11.2 role normalized to ADMIN');

  // Now feed the normalized req into enforcePermission.
  const res2 = makeRes();
  const allowed = enforcePermission(req, res2 as unknown as Response, 'registry:write');
  assertEqual(allowed, true, '11.3 ADMIN (post-normalization) holds registry:write');
}

{
  /* 12. Same composite path for legacy 'viewer' → ends in PERMISSION_DENIED */
  const oldViewerToken = jwt.sign(
    { userId: 'u', email: 'v@example.com', role: 'viewer' },
    env.jwtSecret,
    { expiresIn: '7d' },
  );
  const req = { headers: { authorization: `Bearer ${oldViewerToken}` }, user: undefined } as unknown as Request;
  const res = makeRes();
  const next = makeNext();
  requireAuth(req, res as unknown as Response, next.fn);
  assertEqual(next.called, true, '12.1 requireAuth passes legacy-viewer JWT');
  assertEqual(req.user?.role ?? null, 'VIEWER', '12.2 role normalized to VIEWER');

  const res2 = makeRes();
  const allowed = enforcePermission(req, res2 as unknown as Response, 'registry:write');
  assertEqual(allowed, false, '12.3 VIEWER denied registry:write');
  const body = res2.body as { error?: string };
  assertEqual(body.error ?? null, 'PERMISSION_DENIED', '12.4 → PERMISSION_DENIED (not UNKNOWN_ROLE)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
