/**
 * Tests for `services/judgment/date-math.ts`.
 *
 *   npm run test:judgment-date-math
 */

import { computeMonthsBetween } from '../services/judgment/date-math.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

console.log('computeMonthsBetween:');

assertEqual(computeMonthsBetween('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), 1, '1 month');
assertEqual(computeMonthsBetween('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), 12, '12 months (1 year)');
assertEqual(computeMonthsBetween('2026-01-01T00:00:00Z', '2036-01-01T00:00:00Z'), 120, '120 months (10 years)');

assertEqual(computeMonthsBetween('2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z'), null, 'same date → null (end <= start)');
assertEqual(computeMonthsBetween('2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), null, 'end before start → null');

assertEqual(computeMonthsBetween('not-a-date', '2026-01-01T00:00:00Z'), null, 'malformed from → null');
assertEqual(computeMonthsBetween('2026-01-01T00:00:00Z', 'not-a-date'), null, 'malformed to → null');
assertEqual(computeMonthsBetween('not-a-date', 'also-not'), null, 'both malformed → null');

// 18 months ≈ 18 (rounded from 30.4375 average)
const eighteenMonths = computeMonthsBetween('2026-01-01T00:00:00Z', '2027-07-01T00:00:00Z');
ok(`18-month span: ${eighteenMonths} (expected ~18)`);
if (eighteenMonths !== null && (eighteenMonths < 17 || eighteenMonths > 19)) {
  fail(`18-month rounding off: got ${eighteenMonths}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
