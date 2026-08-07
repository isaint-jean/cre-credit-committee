/**
 * derive-side test (role-siloing chunk 3) — the keystone bridge logic.
 *   ORIGINATOR/BUYER forced to their side (?side ignored); ADMIN + internal roles +
 *   logged-out keep the URL ?side (else Platform/null).
 *
 *   npx tsx apps/web/src/lib/derive-side.test.ts
 */
import { deriveSide } from './derive-side';
import type { Side } from './side-context';

let passed = 0, failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string): void => { failed++; console.error(`  FAIL  ${m}`); };
const eq = (got: Side | null, want: Side | null, m: string): void =>
  (got === want ? ok(m) : fail(`${m} (got ${String(got)}, want ${String(want)})`));

console.log('ORIGINATOR — forced (?side cannot override):');
eq(deriveSide('ORIGINATOR', null), 'originator', 'ORIGINATOR + no ?side → originator');
eq(deriveSide('ORIGINATOR', 'buyer'), 'originator', 'ORIGINATOR + ?side=buyer → originator (ignored)');
eq(deriveSide('ORIGINATOR', 'originator'), 'originator', 'ORIGINATOR + ?side=originator → originator');

console.log('\nBUYER — forced:');
eq(deriveSide('BUYER', null), 'buyer', 'BUYER + no ?side → buyer');
eq(deriveSide('BUYER', 'originator'), 'buyer', 'BUYER + ?side=originator → buyer (ignored)');

console.log('\nADMIN — ?side overridable (QA both sides):');
eq(deriveSide('ADMIN', 'originator'), 'originator', 'ADMIN + ?side=originator → originator');
eq(deriveSide('ADMIN', 'buyer'), 'buyer', 'ADMIN + ?side=buyer → buyer');
eq(deriveSide('ADMIN', null), null, 'ADMIN + no ?side → Platform (null)');

console.log('\nInternal roles + logged-out — unchanged (?side or Platform):');
eq(deriveSide('ANALYST', 'buyer'), 'buyer', 'ANALYST keeps ?side');
eq(deriveSide('ANALYST', null), null, 'ANALYST + no ?side → Platform');
eq(deriveSide('COMMITTEE_MEMBER', 'originator'), 'originator', 'COMMITTEE_MEMBER keeps ?side');
eq(deriveSide('VIEWER', null), null, 'VIEWER + no ?side → Platform');
eq(deriveSide(null, 'buyer'), 'buyer', 'logged-out keeps ?side');
eq(deriveSide(undefined, null), null, 'no user + no ?side → Platform');

console.log('\nCase-insensitive robustness (storage vs contract casing):');
eq(deriveSide('originator', null), 'originator', 'lowercase originator still forces');
eq(deriveSide('buyer', 'originator'), 'buyer', 'lowercase buyer still forces');

console.log(`\n${failed === 0 ? '✓' : '✗'} derive-side: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
