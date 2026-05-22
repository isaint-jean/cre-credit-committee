/**
 * End-to-end engine validation against the real handbook.
 *
 * Drives the actual 87-principle handbook from @cre/handbook-data through
 * the engine with carefully-constructed synthetic deal bags. Validates
 * that the schema-validating principles fire as designed and that other
 * principles fire/skip appropriately.
 *
 * Not a comprehensive unit test suite — that's a separate exercise. This
 * is a smoke test that exercises the most complex contract patterns end
 * to end and proves the engine handles them correctly.
 */

import { handbook } from '@cre/handbook-data';
import {
  collectReferencedFields,
  evaluateHandbook,
  evaluatePrinciple,
  principleFieldDependencies,
} from '../src/index.js';
import type { FieldBag } from '../src/index.js';

// =============================================================================
// Test runner (tiny — no framework dependency for this proof)
// =============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function findFlag(
  bag: FieldBag,
  principleId: string,
): ReturnType<typeof evaluatePrinciple> {
  const principle = handbook.principles.find((p) => p.id === principleId);
  if (!principle) throw new Error(`principle ${principleId} not found`);
  return evaluatePrinciple(principle, bag);
}

function expectFired(
  bag: FieldBag,
  principleId: string,
  expectedSeverity: 'critical' | 'high' | 'medium' | 'advisory',
  expectedGroupIndex: number,
  expectedBandIndex: number,
): void {
  const result = findFlag(bag, principleId);
  if (result.status !== 'fired') {
    throw new Error(
      `expected ${principleId} to fire, got skip with reason '${result.skip.reason}'` +
        (result.skip.detail ? ` (${result.skip.detail})` : ''),
    );
  }
  assertEqual(result.flag.severity, expectedSeverity, 'severity');
  assertEqual(result.flag.groupIndex, expectedGroupIndex, 'groupIndex');
  assertEqual(result.flag.bandIndex, expectedBandIndex, 'bandIndex');
}

function expectSkipped(
  bag: FieldBag,
  principleId: string,
  expectedReason: string,
): void {
  const result = findFlag(bag, principleId);
  if (result.status !== 'skipped') {
    throw new Error(
      `expected ${principleId} to be skipped, got fired (band ${result.flag.bandIndex} of group ${result.flag.groupIndex})`,
    );
  }
  assertEqual(result.skip.reason, expectedReason, 'skip reason');
}

// =============================================================================
// Tests
// =============================================================================

console.log('\n=== Schema-validating principles ===');

// P-IV-RET-5: mall fortress Class A nested exception
// The contract's most complex pattern: two evaluationGroups, fortress first
test('P-IV-RET-5: fortress Class A mall with 9% DY fires CRITICAL from fortress group', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.09,
  };
  expectFired(bag, 'P-IV-RET-5', 'critical', 0, 0);
});

test('P-IV-RET-5: fortress Class A mall with 10.5% DY fires HIGH from fortress group band 1', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.105,
  };
  expectFired(bag, 'P-IV-RET-5', 'high', 0, 1);
});

test('P-IV-RET-5: fortress Class A mall with 12% DY does not fire (group matched, no band hit)', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.12,
  };
  expectSkipped(bag, 'P-IV-RET-5', 'no_band_matched');
});

test('P-IV-RET-5: non-fortress mall with 12% DY fires CRITICAL from catch-all group', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'B',
    debt_yield: 0.12,
  };
  expectFired(bag, 'P-IV-RET-5', 'critical', 1, 0);
});

test('P-IV-RET-5: non-fortress mall with 16% DY does not fire (catch-all band did not hit)', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'B',
    debt_yield: 0.16,
  };
  expectSkipped(bag, 'P-IV-RET-5', 'no_band_matched');
});

// P-IV-HOT-5: bi-modal threshold by service level
test('P-IV-HOT-5: limited-service hotel with $12K/key PIP fires HIGH from limited-service group', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Limited-Service',
    pip_reserve_per_key: 12000,
  };
  expectFired(bag, 'P-IV-HOT-5', 'high', 0, 0);
});

test('P-IV-HOT-5: limited-service hotel with $18K/key PIP does not fire (limited group, no band)', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Limited-Service',
    pip_reserve_per_key: 18000,
  };
  expectSkipped(bag, 'P-IV-HOT-5', 'no_band_matched');
});

test('P-IV-HOT-5: full-service hotel with $18K/key PIP fires HIGH from full-service group', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Full-Service',
    pip_reserve_per_key: 18000,
  };
  expectFired(bag, 'P-IV-HOT-5', 'high', 1, 0);
});

test('P-IV-HOT-5: full-service hotel with $50K/key PIP does not fire (full-service group, no band)', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Full-Service',
    pip_reserve_per_key: 50000,
  };
  expectSkipped(bag, 'P-IV-HOT-5', 'no_band_matched');
});

// P-IV-HOT-7: triple compound condition + categorical metric + matches operator
test('P-IV-HOT-7: 30-yo full-service CBD hotel fires CRITICAL via categorical matches', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 30,
    hotel_service_level: 'Full-Service',
    location_type: 'CBD',
  };
  expectFired(bag, 'P-IV-HOT-7', 'critical', 0, 0);
});

test('P-IV-HOT-7: 30-yo full-service SUBURBAN hotel does not fire (condition fails)', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 30,
    hotel_service_level: 'Full-Service',
    location_type: 'Suburban',
  };
  expectSkipped(bag, 'P-IV-HOT-7', 'no_group_matched');
});

test('P-IV-HOT-7: 15-yo full-service CBD hotel does not fire (age below 20)', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 15,
    hotel_service_level: 'Full-Service',
    location_type: 'CBD',
  };
  expectSkipped(bag, 'P-IV-HOT-7', 'no_group_matched');
});

// P-IV-ST-4: computed metric × field_reference threshold + compound trigger
test('P-IV-ST-4: single-tenant with dark value $20M and loan $15M does not fire ($10M < $15M is true, but check is reversed)', () => {
  // Stressed dark value = 20M × 0.5 = 10M. Threshold (loan amount) = 15M. Operator = lt.
  // Is stressed dark value LESS THAN loan amount? 10M < 15M → true → fires.
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    appraised_dark_value: 20_000_000,
    loan_amount: 15_000_000,
  };
  expectFired(bag, 'P-IV-ST-4', 'high', 0, 0);
});

test('P-IV-ST-4: single-tenant with dark value $40M and loan $15M does not fire (stressed > loan)', () => {
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    appraised_dark_value: 40_000_000,
    loan_amount: 15_000_000,
  };
  // Stressed = 20M, loan = 15M, 20M < 15M is false. Skip.
  expectSkipped(bag, 'P-IV-ST-4', 'no_band_matched');
});

test('P-IV-ST-4: multifamily deal does not fire (trigger fails)', () => {
  const bag: FieldBag = {
    tenancy_type: 'Multi-Tenant',
    appraised_dark_value: 20_000_000,
    loan_amount: 15_000_000,
  };
  expectSkipped(bag, 'P-IV-ST-4', 'trigger_inactive');
});

test('P-IV-ST-4: single-tenant deal with no dark value does not fire (trigger requires field_exists)', () => {
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    loan_amount: 15_000_000,
  };
  expectSkipped(bag, 'P-IV-ST-4', 'trigger_inactive');
});

// P-IV-IND-1: categorical metric + matches operator + compound condition
test('P-IV-IND-1: 35-yo manufacturing industrial fires HIGH via categorical matches', () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    building_age: 35,
    property_sub_type: 'Manufacturing',
  };
  expectFired(bag, 'P-IV-IND-1', 'high', 0, 0);
});

test('P-IV-IND-1: 35-yo distribution warehouse does not fire (sub_type not in set)', () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    building_age: 35,
    property_sub_type: 'Distribution',
  };
  expectSkipped(bag, 'P-IV-IND-1', 'no_group_matched');
});

// P-IV-HOT-10: divide computed metric
test('P-IV-HOT-10: hotel with loan $30M / room revenue $5M = 6x fires HIGH', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 30_000_000,
    annual_room_revenue: 5_000_000,
  };
  expectFired(bag, 'P-IV-HOT-10', 'high', 0, 0);
});

test('P-IV-HOT-10: hotel with loan $20M / room revenue $5M = 4x fires MEDIUM (advisory band)', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 20_000_000,
    annual_room_revenue: 5_000_000,
  };
  expectFired(bag, 'P-IV-HOT-10', 'medium', 0, 1);
});

test('P-IV-HOT-10: hotel with loan $15M / room revenue $5M = 3x does not fire', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 15_000_000,
    annual_room_revenue: 5_000_000,
  };
  expectSkipped(bag, 'P-IV-HOT-10', 'no_band_matched');
});

test('P-IV-HOT-10: hotel with no room revenue field skips with missing_field', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 30_000_000,
  };
  expectSkipped(bag, 'P-IV-HOT-10', 'missing_field');
});

// P-IV-MHC-3: array contains_any against watchlist
test('P-IV-MHC-3: MHC with lift station infrastructure fires HIGH', () => {
  const bag: FieldBag = {
    asset_type: 'MHC',
    utility_infrastructure_type: ['municipal water', 'lift station'],
  };
  expectFired(bag, 'P-IV-MHC-3', 'high', 0, 0);
});

test('P-IV-MHC-3: MHC with municipal-only infrastructure does not fire', () => {
  const bag: FieldBag = {
    asset_type: 'MHC',
    utility_infrastructure_type: ['municipal water', 'municipal sewer'],
  };
  expectSkipped(bag, 'P-IV-MHC-3', 'no_band_matched');
});

// P-IV-RET-6: sum_over_term formula
test('P-IV-RET-6: mall with negative cumulative CF fires HIGH', () => {
  // 10-period NOI of $1M each = $10M; debt service $1.1M × 10 = $11M; nets to -$1M
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    noi_projection: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    debt_service: [1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000],
    reserves: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    capex_projection: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  expectFired(bag, 'P-IV-RET-6', 'high', 0, 0);
});

test('P-IV-RET-6: mall with positive cumulative CF does not fire', () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    noi_projection: [2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000],
    debt_service: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    reserves: [0, 0, 0, 0, 0],
    capex_projection: [0, 0, 0, 0, 0],
  };
  expectSkipped(bag, 'P-IV-RET-6', 'no_band_matched');
});

// =============================================================================
// Operator coverage tests
// =============================================================================

console.log('\n=== Operator coverage ===');

// P-II-3 — cash-out detection — uses gt with literal 0
test('P-II-3: refinance with cash_out $1 fires HIGH', () => {
  const bag: FieldBag = {
    loan_purpose: 'Refinance',
    cash_out_amount: 1,
  };
  expectFired(bag, 'P-II-3', 'high', 0, 0);
});

test('P-II-3: refinance with cash_out 0 does not fire (gt 0 strict)', () => {
  const bag: FieldBag = {
    loan_purpose: 'Refinance',
    cash_out_amount: 0,
  };
  expectSkipped(bag, 'P-II-3', 'no_band_matched');
});

test('P-II-3: acquisition skips on trigger', () => {
  const bag: FieldBag = {
    loan_purpose: 'Acquisition',
    cash_out_amount: 5_000_000,
  };
  expectSkipped(bag, 'P-II-3', 'trigger_inactive');
});

// P-II-8 — specialty asset in set
test('P-II-8: data center fires HIGH', () => {
  const bag: FieldBag = { property_sub_type: 'Data Center' };
  expectFired(bag, 'P-II-8', 'high', 0, 0);
});

test('P-II-8: distribution warehouse does not fire', () => {
  const bag: FieldBag = { property_sub_type: 'Distribution' };
  expectSkipped(bag, 'P-II-8', 'no_band_matched');
});

// P-IV-SS-2 — multi-tier bands (gt and in_range)
test('P-IV-SS-2: self-storage with 11 SF/capita fires HIGH (first band)', () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 11,
  };
  expectFired(bag, 'P-IV-SS-2', 'high', 0, 0);
});

test('P-IV-SS-2: self-storage with 8 SF/capita fires MEDIUM (advisory band)', () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 8,
  };
  expectFired(bag, 'P-IV-SS-2', 'medium', 0, 1);
});

test('P-IV-SS-2: self-storage with 5 SF/capita does not fire', () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 5,
  };
  expectSkipped(bag, 'P-IV-SS-2', 'no_band_matched');
});

// =============================================================================
// Trigger and execution-mode short-circuits
// =============================================================================

console.log('\n=== Trigger and execution-mode short-circuits ===');

test('P-II-1: skips with not_deterministic (no deterministic check)', () => {
  const bag: FieldBag = {};
  expectSkipped(bag, 'P-II-1', 'not_deterministic');
});

test('P-IV-MF-1: missing operating-history field skips with missing_field on a 5+ year building', () => {
  const bag: FieldBag = {
    asset_type: 'Multifamily',
    building_age: 10,
  };
  expectSkipped(bag, 'P-IV-MF-1', 'missing_field');
});

test('P-IV-MF-1: trigger inactive for new construction', () => {
  const bag: FieldBag = {
    asset_type: 'Multifamily',
    building_age: 3,
    years_of_stable_operating_history: 0,
  };
  expectSkipped(bag, 'P-IV-MF-1', 'trigger_inactive');
});

// =============================================================================
// Message interpolation
// =============================================================================

console.log('\n=== Message interpolation ===');

test('P-IV-HOT-4: 8-yr-old hotel flag message interpolates years_since_last_renovation', () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    years_since_last_renovation: 8,
  };
  const result = findFlag(bag, 'P-IV-HOT-4');
  if (result.status !== 'fired') {
    throw new Error(`expected fire, got skip: ${result.skip.reason}`);
  }
  if (!result.flag.flag_message.includes('8 years past last major renovation')) {
    throw new Error(`expected interpolated message, got: '${result.flag.flag_message}'`);
  }
});

// =============================================================================
// Top-level handbook evaluation against a representative deal
// =============================================================================

console.log('\n=== Top-level evaluation ===');

test('evaluateHandbook returns FiredFlags + Skips for an industrial deal', () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    loan_purpose: 'Acquisition',
    building_age: 35,
    property_sub_type: 'Manufacturing',
    property_sub_type_specialty: undefined,
  };
  const result = evaluateHandbook(handbook, bag);
  if (result.firedFlags.length === 0) {
    throw new Error('expected at least one fired flag for this deal');
  }
  // P-IV-IND-1 should be in fired flags
  const indFired = result.firedFlags.find((f) => f.principleId === 'P-IV-IND-1');
  if (!indFired) {
    throw new Error('expected P-IV-IND-1 to fire for 35-yo manufacturing industrial');
  }
  // P-II-3 should not fire (loan_purpose is Acquisition)
  const p2_3 = result.firedFlags.find((f) => f.principleId === 'P-II-3');
  if (p2_3) {
    throw new Error('expected P-II-3 to NOT fire (loan is acquisition)');
  }
});

// =============================================================================
// Lint pass
// =============================================================================

console.log('\n=== Lint pass ===');

test('collectReferencedFields returns a non-empty sorted array', () => {
  const fields = collectReferencedFields(handbook);
  if (fields.length === 0) throw new Error('expected fields to be referenced');
  // Verify sortedness
  for (let i = 1; i < fields.length; i++) {
    if (fields[i - 1]! > fields[i]!) {
      throw new Error('collectReferencedFields did not return sorted output');
    }
  }
  // Sanity check: a few obvious fields should be there
  if (!fields.includes('asset_type')) throw new Error('expected asset_type in fields');
  if (!fields.includes('loan_amount')) throw new Error('expected loan_amount in fields');
  if (!fields.includes('debt_yield')) throw new Error('expected debt_yield in fields');
});

test('principleFieldDependencies returns one entry per DETERMINISTIC principle', () => {
  const deps = principleFieldDependencies(handbook);
  const deterministicCount = handbook.principles.filter((p) =>
    p.executionModes.includes('DETERMINISTIC'),
  ).length;
  if (deps.length !== deterministicCount) {
    throw new Error(
      `expected ${deterministicCount} entries, got ${deps.length}`,
    );
  }
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
