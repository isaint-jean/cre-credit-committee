/**
 * Tests for computeRefiWindowRollover (Phase 1 of the "read deal data before
 * asset-class priors" gate).
 *
 *   npx tsx apps/api/src/scripts/test-refi-window.ts
 *
 * Covers:
 *   - data-complete case: all leases past maturity+window → no_rollover_in_refi_window
 *   - data-complete case: one tenant inside window → rollover_in_refi_window with
 *     correct aggregate fraction
 *   - data-absent: rentRoll=null → insufficient_data (no aggregate)
 *   - data-absent: termMonths=null → insufficient_data
 *   - data-absent: maturityDate=null → insufficient_data
 *   - data-absent: every leaseEnd=null → insufficient_data (perTenantSchedule still emitted)
 *   - mixed: one leaseEnd null among many → sourceDataComplete=false → insufficient_data
 *   - buffer behavior: same data with different refiWindowMonths → different verdict
 *   - strict null fidelity: aggregateRolloverFraction is null (not 0) in insufficient_data
 *   - per-tenant `expiresWithinRefiWindow` is null when leaseEnd is null
 */

import type { ISODateTime, RentRoll, RentRollLine } from '@cre/contracts';
import { computeRentRollId } from '../util/content-hash.js';
import { computeRefiWindowRollover } from '../services/judgment/refi-window.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const AS_OF: ISODateTime = '2026-05-31T00:00:00Z';

function line(overrides: Partial<RentRollLine> & { tenantName: string }): RentRollLine {
  return {
    tenantName: overrides.tenantName,
    suite: overrides.suite ?? null,
    squareFeet: overrides.squareFeet ?? null,
    status: overrides.status ?? 'OCCUPIED',
    leaseStart: overrides.leaseStart ?? '2020-01-01T00:00:00Z',
    leaseEnd: overrides.leaseEnd ?? null,
    inPlaceRentAnnual: overrides.inPlaceRentAnnual ?? null,
    marketRentAnnual: overrides.marketRentAnnual ?? null,
    leaseType: overrides.leaseType ?? 'NNN',
    recoveriesAnnual: null, otherIncomeAnnual: null,
    newTiPsf: null, renewTiPsf: null, newLcPct: null, renewLcPct: null,
    downtimeMonths: null, notes: null,
  };
}

function makeRoll(lines: RentRollLine[]): RentRoll {
  const body = { asOfDate: AS_OF, propertyName: 'Test', source: 'rent_roll_file' as const, lines };
  return { id: computeRentRollId(body), ...body };
}

console.log('1. data-complete, no rollover (all leases past maturity + 12mo):');
{
  const roll = makeRoll([
    line({ tenantName: 'GSA', leaseEnd: '2039-01-01T00:00:00Z', inPlaceRentAnnual: 1_000_000 }),
    line({ tenantName: 'B',   leaseEnd: '2040-01-01T00:00:00Z', inPlaceRentAnnual:   500_000 }),
  ]);
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
    refiWindowMonths: 12,
  });
  assertEqual(facts.sourceDataComplete, true, '1.1 sourceDataComplete=true');
  assertEqual(facts.aggregateRolloverFraction, 0, '1.2 aggregate fraction === 0 (no expirations in window)');
  assertEqual(facts.verdict, 'no_rollover_in_refi_window', '1.3 verdict=no_rollover_in_refi_window');
  assertEqual(facts.refiWindowMonths, 12, '1.4 refiWindowMonths echoed');
  assertEqual(facts.perTenantSchedule.length, 2, '1.5 perTenantSchedule emits both tenants');
  assertEqual(facts.perTenantSchedule[0]?.expiresWithinRefiWindow, false, '1.6 GSA does not expire in window');
  assertEqual(facts.perTenantSchedule[1]?.expiresWithinRefiWindow, false, '1.7 B does not expire in window');
  assert(facts.maturityPlusWindowDate !== null, '1.8 maturityPlusWindowDate computed');
}

console.log('\n2. data-complete, partial rollover (some leases inside window):');
{
  const roll = makeRoll([
    line({ tenantName: 'Early', leaseEnd: '2030-01-01T00:00:00Z', inPlaceRentAnnual: 200_000 }),
    line({ tenantName: 'Late',  leaseEnd: '2040-01-01T00:00:00Z', inPlaceRentAnnual: 800_000 }),
  ]);
  // Maturity 2031-05-31 + 12mo → cutoff ~2032-05-31. Early (2030) expires before; Late (2040) does not.
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
    refiWindowMonths: 12,
  });
  assertEqual(facts.sourceDataComplete, true, '2.1 sourceDataComplete=true');
  assertEqual(facts.aggregateRolloverFraction, 0.2, '2.2 aggregate fraction === 0.2 (200k / 1M)');
  assertEqual(facts.verdict, 'rollover_in_refi_window', '2.3 verdict=rollover_in_refi_window');
  assertEqual(facts.perTenantSchedule[0]?.expiresWithinRefiWindow, true, '2.4 Early expires in window');
  assertEqual(facts.perTenantSchedule[1]?.expiresWithinRefiWindow, false, '2.5 Late does not');
}

console.log('\n3. data-absent: rentRoll=null → insufficient_data:');
{
  const facts = computeRefiWindowRollover({
    rentRoll: null,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(facts.sourceDataComplete, false, '3.1 sourceDataComplete=false');
  assertEqual(facts.aggregateRolloverFraction, null, '3.2 aggregateRolloverFraction IS null (not 0)');
  assertEqual(facts.verdict, 'insufficient_data', '3.3 verdict=insufficient_data');
  assertEqual(facts.perTenantSchedule.length, 0, '3.4 perTenantSchedule empty when rentRoll null');
  assertEqual(facts.refiWindowMonths, 12, '3.5 default refiWindowMonths=12 used');
}

console.log('\n4. data-absent: termMonths=null → insufficient_data:');
{
  const roll = makeRoll([line({ tenantName: 'X', leaseEnd: '2030-01-01T00:00:00Z', inPlaceRentAnnual: 100_000 })]);
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: null,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(facts.sourceDataComplete, false, '4.1 sourceDataComplete=false (termMonths null)');
  assertEqual(facts.aggregateRolloverFraction, null, '4.2 aggregate null');
  assertEqual(facts.verdict, 'insufficient_data', '4.3 verdict=insufficient_data');
  assertEqual(facts.perTenantSchedule.length, 1, '4.4 perTenantSchedule still emits (data visibility)');
}

console.log('\n5. data-absent: maturityDate=null → insufficient_data:');
{
  const roll = makeRoll([line({ tenantName: 'X', leaseEnd: '2030-01-01T00:00:00Z', inPlaceRentAnnual: 100_000 })]);
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: null,
    termMonths: 60,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(facts.sourceDataComplete, false, '5.1 sourceDataComplete=false (maturityDate null)');
  assertEqual(facts.aggregateRolloverFraction, null, '5.2 aggregate null');
  assertEqual(facts.verdict, 'insufficient_data', '5.3 verdict=insufficient_data');
  assertEqual(facts.maturityPlusWindowDate, null, '5.4 maturityPlusWindowDate null when input null');
  assertEqual(facts.perTenantSchedule[0]?.expiresWithinRefiWindow, null,
    '5.5 expiresWithinRefiWindow null when cutoff unknown');
}

console.log('\n6. data-absent: every leaseEnd=null → insufficient_data:');
{
  const roll = makeRoll([
    line({ tenantName: 'A', leaseEnd: null, inPlaceRentAnnual: 100_000 }),
    line({ tenantName: 'B', leaseEnd: null, inPlaceRentAnnual: 200_000 }),
  ]);
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(facts.sourceDataComplete, false, '6.1 sourceDataComplete=false (no leaseEnd anywhere)');
  assertEqual(facts.verdict, 'insufficient_data', '6.2 verdict=insufficient_data');
  assertEqual(facts.perTenantSchedule.length, 2, '6.3 perTenantSchedule still surfaces both tenants');
  assertEqual(facts.perTenantSchedule[0]?.expiresWithinRefiWindow, null, '6.4 A expiresWithinRefiWindow null');
  assertEqual(facts.perTenantSchedule[1]?.expiresWithinRefiWindow, null, '6.5 B expiresWithinRefiWindow null');
}

console.log('\n7. mixed: one leaseEnd null among many → sourceDataComplete=false → insufficient_data:');
{
  const roll = makeRoll([
    line({ tenantName: 'A', leaseEnd: '2030-01-01T00:00:00Z', inPlaceRentAnnual: 100_000 }),
    line({ tenantName: 'B', leaseEnd: null,                    inPlaceRentAnnual: 200_000 }),
  ]);
  const facts = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(facts.sourceDataComplete, false, '7.1 sourceDataComplete=false (one gap)');
  assertEqual(facts.aggregateRolloverFraction, null, '7.2 aggregate null (data incomplete)');
  assertEqual(facts.verdict, 'insufficient_data', '7.3 verdict=insufficient_data');
  // A has leaseEnd, so per-tenant expiresWithinRefiWindow is true. B has no leaseEnd → null.
  assertEqual(facts.perTenantSchedule[0]?.expiresWithinRefiWindow, true, '7.4 A surfaces true');
  assertEqual(facts.perTenantSchedule[1]?.expiresWithinRefiWindow, null, '7.5 B surfaces null');
}

console.log('\n8. buffer behavior: same data, different refiWindowMonths → different verdict:');
{
  const roll = makeRoll([
    line({ tenantName: 'Late', leaseEnd: '2032-01-01T00:00:00Z', inPlaceRentAnnual: 100_000 }),
  ]);
  // Maturity 2031-05-31, lease ends 2032-01-01 (~7 months past). With 6mo window: NOT in window.
  // With 12mo window: IN window.
  const facts6 = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
    refiWindowMonths: 6,
  });
  assertEqual(facts6.verdict, 'no_rollover_in_refi_window', '8.1 6mo window → no rollover');
  assertEqual(facts6.aggregateRolloverFraction, 0, '8.2 6mo window → 0 fraction');

  const facts12 = computeRefiWindowRollover({
    rentRoll: roll,
    maturityDate: '2031-05-31T00:00:00Z',
    termMonths: 60,
    analysisAsOfDate: AS_OF,
    refiWindowMonths: 12,
  });
  assertEqual(facts12.verdict, 'rollover_in_refi_window', '8.3 12mo window → rollover (same data)');
  assertEqual(facts12.aggregateRolloverFraction, 1, '8.4 12mo window → 100% fraction');
}

console.log('\n9. determinism: same inputs twice → byte-equal output (pure function):');
{
  const roll = makeRoll([
    line({ tenantName: 'A', leaseEnd: '2030-01-01T00:00:00Z', inPlaceRentAnnual: 100_000 }),
  ]);
  const a = computeRefiWindowRollover({
    rentRoll: roll, maturityDate: '2031-05-31T00:00:00Z', termMonths: 60, analysisAsOfDate: AS_OF,
  });
  const b = computeRefiWindowRollover({
    rentRoll: roll, maturityDate: '2031-05-31T00:00:00Z', termMonths: 60, analysisAsOfDate: AS_OF,
  });
  assertEqual(JSON.stringify(a), JSON.stringify(b), '9.1 deterministic (byte-equal JSON)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
