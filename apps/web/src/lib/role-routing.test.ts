/**
 * role-routing test (chunk 4) — per-role landing + cross-role deep-link guard.
 *   ORIGINATOR/BUYER: '/' → /pools (their world), '/admin/*' → /pools (no admin surface),
 *   other paths → stay. ADMIN + internal roles + logged-out → unaffected (null).
 *
 *   npx tsx apps/web/src/lib/role-routing.test.ts
 */
import { roleRoute } from './role-routing';

let passed = 0, failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string): void => { failed++; console.error(`  FAIL  ${m}`); };
const eq = (got: string | null, want: string | null, m: string): void =>
  (got === want ? ok(m) : fail(`${m} (got ${String(got)}, want ${String(want)})`));

console.log('ORIGINATOR — routed into their world, no admin surface:');
eq(roleRoute('ORIGINATOR', '/'), '/pools', "ORIGINATOR '/' → /pools (their world, not two-door)");
eq(roleRoute('ORIGINATOR', '/admin/criteria'), '/pools', 'ORIGINATOR /admin/criteria → /pools (guarded)');
eq(roleRoute('ORIGINATOR', '/admin'), '/pools', 'ORIGINATOR /admin → /pools (guarded)');
eq(roleRoute('ORIGINATOR', '/pools'), null, 'ORIGINATOR /pools → stay');
eq(roleRoute('ORIGINATOR', '/analysis/abc'), null, 'ORIGINATOR /analysis/abc → stay (their side is forced)');

console.log('\nBUYER — same routing:');
eq(roleRoute('BUYER', '/'), '/pools', "BUYER '/' → /pools");
eq(roleRoute('BUYER', '/admin/registry'), '/pools', 'BUYER /admin/registry → /pools (guarded)');
eq(roleRoute('BUYER', '/pools/p1'), null, 'BUYER /pools/p1 → stay');

console.log('\nADMIN — unaffected (keeps the two-door home + admin surfaces):');
eq(roleRoute('ADMIN', '/'), null, "ADMIN '/' → stay (two-door home)");
eq(roleRoute('ADMIN', '/admin/criteria'), null, 'ADMIN /admin/criteria → stay (allowed)');
eq(roleRoute('ADMIN', '/pools'), null, 'ADMIN /pools → stay');

console.log('\nInternal roles + logged-out — unaffected (no regression):');
eq(roleRoute('ANALYST', '/'), null, "ANALYST '/' → stay");
eq(roleRoute('ANALYST', '/admin/criteria'), null, 'ANALYST /admin/criteria → stay (existing access kept)');
eq(roleRoute('COMMITTEE_MEMBER', '/admin'), null, 'COMMITTEE_MEMBER /admin → stay');
eq(roleRoute(null, '/'), null, 'logged-out → stay (null)');
eq(roleRoute(undefined, '/admin'), null, 'no role → stay (null)');

console.log('\nCase-insensitive (storage vs contract casing):');
eq(roleRoute('originator', '/'), '/pools', "lowercase 'originator' still routes");

console.log(`\n${failed === 0 ? '✓' : '✗'} role-routing: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
