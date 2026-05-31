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

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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

async function findFlag(
  bag: FieldBag,
  principleId: string,
): ReturnType<typeof evaluatePrinciple> {
  // engine evaluator is now async (Phase 3) — await + return its Promise resolution
  const principle = handbook.principles.find((p) => p.id === principleId);
  if (!principle) throw new Error(`principle ${principleId} not found`);
  return await evaluatePrinciple(principle, bag);
}

async function expectFired(
  bag: FieldBag,
  principleId: string,
  expectedSeverity: 'critical' | 'high' | 'medium' | 'advisory',
  expectedGroupIndex: number,
  expectedBandIndex: number,
): Promise<void> {
  const result = await findFlag(bag, principleId);
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

async function expectSkipped(
  bag: FieldBag,
  principleId: string,
  expectedReason: string,
): Promise<void> {
  const result = await findFlag(bag, principleId);
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

// Top-level async IIFE — engine evaluators are async since Phase 3 of the
// LLM_CONTEXT evaluator. Sequencing inside the IIFE preserves the existing
// console output / failure-reporting semantics.
(async () => {

console.log('\n=== Schema-validating principles ===');

// P-IV-RET-5: mall fortress Class A nested exception
// The contract's most complex pattern: two evaluationGroups, fortress first
await test('P-IV-RET-5: fortress Class A mall with 9% DY fires CRITICAL from fortress group', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.09,
  };
  await expectFired(bag, 'P-IV-RET-5', 'critical', 0, 0);
});

await test('P-IV-RET-5: fortress Class A mall with 10.5% DY fires HIGH from fortress group band 1', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.105,
  };
  await expectFired(bag, 'P-IV-RET-5', 'high', 0, 1);
});

await test('P-IV-RET-5: fortress Class A mall with 12% DY does not fire (group matched, no band hit)', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'Fortress Class A',
    debt_yield: 0.12,
  };
  await expectSkipped(bag, 'P-IV-RET-5', 'no_band_matched');
});

await test('P-IV-RET-5: non-fortress mall with 12% DY fires CRITICAL from catch-all group', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'B',
    debt_yield: 0.12,
  };
  await expectFired(bag, 'P-IV-RET-5', 'critical', 1, 0);
});

await test('P-IV-RET-5: non-fortress mall with 16% DY does not fire (catch-all band did not hit)', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    mall_class: 'B',
    debt_yield: 0.16,
  };
  await expectSkipped(bag, 'P-IV-RET-5', 'no_band_matched');
});

// P-IV-HOT-5: bi-modal threshold by service level
await test('P-IV-HOT-5: limited-service hotel with $12K/key PIP fires HIGH from limited-service group', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Limited-Service',
    pip_reserve_per_key: 12000,
  };
  await expectFired(bag, 'P-IV-HOT-5', 'high', 0, 0);
});

await test('P-IV-HOT-5: limited-service hotel with $18K/key PIP does not fire (limited group, no band)', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Limited-Service',
    pip_reserve_per_key: 18000,
  };
  await expectSkipped(bag, 'P-IV-HOT-5', 'no_band_matched');
});

await test('P-IV-HOT-5: full-service hotel with $18K/key PIP fires HIGH from full-service group', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Full-Service',
    pip_reserve_per_key: 18000,
  };
  await expectFired(bag, 'P-IV-HOT-5', 'high', 1, 0);
});

await test('P-IV-HOT-5: full-service hotel with $50K/key PIP does not fire (full-service group, no band)', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    hotel_service_level: 'Full-Service',
    pip_reserve_per_key: 50000,
  };
  await expectSkipped(bag, 'P-IV-HOT-5', 'no_band_matched');
});

// P-IV-HOT-7: triple compound condition + categorical metric + matches operator
await test('P-IV-HOT-7: 30-yo full-service CBD hotel fires CRITICAL via categorical matches', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 30,
    hotel_service_level: 'Full-Service',
    location_type: 'CBD',
  };
  await expectFired(bag, 'P-IV-HOT-7', 'critical', 0, 0);
});

await test('P-IV-HOT-7: 30-yo full-service SUBURBAN hotel does not fire (condition fails)', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 30,
    hotel_service_level: 'Full-Service',
    location_type: 'Suburban',
  };
  await expectSkipped(bag, 'P-IV-HOT-7', 'no_group_matched');
});

await test('P-IV-HOT-7: 15-yo full-service CBD hotel does not fire (age below 20)', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    building_age: 15,
    hotel_service_level: 'Full-Service',
    location_type: 'CBD',
  };
  await expectSkipped(bag, 'P-IV-HOT-7', 'no_group_matched');
});

// P-IV-ST-4: computed metric × field_reference threshold + compound trigger
await test('P-IV-ST-4: single-tenant with dark value $20M and loan $15M does not fire ($10M < $15M is true, but check is reversed)', async () => {
  // Stressed dark value = 20M × 0.5 = 10M. Threshold (loan amount) = 15M. Operator = lt.
  // Is stressed dark value LESS THAN loan amount? 10M < 15M → true → fires.
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    appraised_dark_value: 20_000_000,
    loan_amount: 15_000_000,
  };
  await expectFired(bag, 'P-IV-ST-4', 'high', 0, 0);
});

await test('P-IV-ST-4: single-tenant with dark value $40M and loan $15M does not fire (stressed > loan)', async () => {
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    appraised_dark_value: 40_000_000,
    loan_amount: 15_000_000,
  };
  // Stressed = 20M, loan = 15M, 20M < 15M is false. Skip.
  await expectSkipped(bag, 'P-IV-ST-4', 'no_band_matched');
});

await test('P-IV-ST-4: multifamily deal does not fire (trigger fails)', async () => {
  const bag: FieldBag = {
    tenancy_type: 'Multi-Tenant',
    appraised_dark_value: 20_000_000,
    loan_amount: 15_000_000,
  };
  await expectSkipped(bag, 'P-IV-ST-4', 'trigger_inactive');
});

await test('P-IV-ST-4: single-tenant deal with no dark value does not fire (trigger requires field_exists)', async () => {
  const bag: FieldBag = {
    tenancy_type: 'Single-Tenant',
    loan_amount: 15_000_000,
  };
  await expectSkipped(bag, 'P-IV-ST-4', 'trigger_inactive');
});

// P-IV-IND-1: categorical metric + matches operator + compound condition
await test('P-IV-IND-1: 35-yo manufacturing industrial fires HIGH via categorical matches', async () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    building_age: 35,
    property_sub_type: 'Manufacturing',
  };
  await expectFired(bag, 'P-IV-IND-1', 'high', 0, 0);
});

await test('P-IV-IND-1: 35-yo distribution warehouse does not fire (sub_type not in set)', async () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    building_age: 35,
    property_sub_type: 'Distribution',
  };
  await expectSkipped(bag, 'P-IV-IND-1', 'no_group_matched');
});

// P-IV-HOT-10: divide computed metric
await test('P-IV-HOT-10: hotel with loan $30M / room revenue $5M = 6x fires HIGH', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 30_000_000,
    annual_room_revenue: 5_000_000,
  };
  await expectFired(bag, 'P-IV-HOT-10', 'high', 0, 0);
});

await test('P-IV-HOT-10: hotel with loan $20M / room revenue $5M = 4x fires MEDIUM (advisory band)', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 20_000_000,
    annual_room_revenue: 5_000_000,
  };
  await expectFired(bag, 'P-IV-HOT-10', 'medium', 0, 1);
});

await test('P-IV-HOT-10: hotel with loan $15M / room revenue $5M = 3x does not fire', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 15_000_000,
    annual_room_revenue: 5_000_000,
  };
  await expectSkipped(bag, 'P-IV-HOT-10', 'no_band_matched');
});

await test('P-IV-HOT-10: hotel with no room revenue field skips with missing_field', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    loan_amount: 30_000_000,
  };
  await expectSkipped(bag, 'P-IV-HOT-10', 'missing_field');
});

// P-IV-MHC-3: array contains_any against watchlist
await test('P-IV-MHC-3: MHC with lift station infrastructure fires HIGH', async () => {
  const bag: FieldBag = {
    asset_type: 'MHC',
    utility_infrastructure_type: ['municipal water', 'lift station'],
  };
  await expectFired(bag, 'P-IV-MHC-3', 'high', 0, 0);
});

await test('P-IV-MHC-3: MHC with municipal-only infrastructure does not fire', async () => {
  const bag: FieldBag = {
    asset_type: 'MHC',
    utility_infrastructure_type: ['municipal water', 'municipal sewer'],
  };
  await expectSkipped(bag, 'P-IV-MHC-3', 'no_band_matched');
});

// P-IV-RET-6: sum_over_term formula
await test('P-IV-RET-6: mall with negative cumulative CF fires HIGH', async () => {
  // 10-period NOI of $1M each = $10M; debt service $1.1M × 10 = $11M; nets to -$1M
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    noi_projection: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    debt_service: [1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000],
    reserves: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    capex_projection: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  await expectFired(bag, 'P-IV-RET-6', 'high', 0, 0);
});

await test('P-IV-RET-6: mall with positive cumulative CF does not fire', async () => {
  const bag: FieldBag = {
    asset_type: 'Retail',
    property_sub_type: 'Regional Mall',
    noi_projection: [2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000],
    debt_service: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    reserves: [0, 0, 0, 0, 0],
    capex_projection: [0, 0, 0, 0, 0],
  };
  await expectSkipped(bag, 'P-IV-RET-6', 'no_band_matched');
});

// =============================================================================
// Operator coverage tests
// =============================================================================

console.log('\n=== Operator coverage ===');

// P-II-3 — cash-out detection — uses gt with literal 0
await test('P-II-3: refinance with cash_out $1 fires HIGH', async () => {
  const bag: FieldBag = {
    loan_purpose: 'Refinance',
    cash_out_amount: 1,
  };
  await expectFired(bag, 'P-II-3', 'high', 0, 0);
});

await test('P-II-3: refinance with cash_out 0 does not fire (gt 0 strict)', async () => {
  const bag: FieldBag = {
    loan_purpose: 'Refinance',
    cash_out_amount: 0,
  };
  await expectSkipped(bag, 'P-II-3', 'no_band_matched');
});

await test('P-II-3: acquisition skips on trigger', async () => {
  const bag: FieldBag = {
    loan_purpose: 'Acquisition',
    cash_out_amount: 5_000_000,
  };
  await expectSkipped(bag, 'P-II-3', 'trigger_inactive');
});

// P-II-8 — specialty asset in set
await test('P-II-8: data center fires HIGH', async () => {
  const bag: FieldBag = { property_sub_type: 'Data Center' };
  await expectFired(bag, 'P-II-8', 'high', 0, 0);
});

await test('P-II-8: distribution warehouse does not fire', async () => {
  const bag: FieldBag = { property_sub_type: 'Distribution' };
  await expectSkipped(bag, 'P-II-8', 'no_band_matched');
});

// P-IV-SS-2 — multi-tier bands (gt and in_range)
await test('P-IV-SS-2: self-storage with 11 SF/capita fires HIGH (first band)', async () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 11,
  };
  await expectFired(bag, 'P-IV-SS-2', 'high', 0, 0);
});

await test('P-IV-SS-2: self-storage with 8 SF/capita fires MEDIUM (advisory band)', async () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 8,
  };
  await expectFired(bag, 'P-IV-SS-2', 'medium', 0, 1);
});

await test('P-IV-SS-2: self-storage with 5 SF/capita does not fire', async () => {
  const bag: FieldBag = {
    asset_type: 'SelfStorage',
    trade_area_sf_per_capita: 5,
  };
  await expectSkipped(bag, 'P-IV-SS-2', 'no_band_matched');
});

// =============================================================================
// Trigger and execution-mode short-circuits
// =============================================================================

console.log('\n=== Trigger and execution-mode short-circuits ===');

await test('P-II-1: skips with not_deterministic (no deterministic check)', async () => {
  const bag: FieldBag = {};
  await expectSkipped(bag, 'P-II-1', 'not_deterministic');
});

await test('P-IV-MF-1: missing operating-history field skips with missing_field on a 5+ year building', async () => {
  const bag: FieldBag = {
    asset_type: 'Multifamily',
    building_age: 10,
  };
  await expectSkipped(bag, 'P-IV-MF-1', 'missing_field');
});

await test('P-IV-MF-1: trigger inactive for new construction', async () => {
  const bag: FieldBag = {
    asset_type: 'Multifamily',
    building_age: 3,
    years_of_stable_operating_history: 0,
  };
  await expectSkipped(bag, 'P-IV-MF-1', 'trigger_inactive');
});

// =============================================================================
// Message interpolation
// =============================================================================

console.log('\n=== Message interpolation ===');

await test('P-IV-HOT-4: 8-yr-old hotel flag message interpolates years_since_last_renovation', async () => {
  const bag: FieldBag = {
    asset_type: 'Hotel',
    years_since_last_renovation: 8,
  };
  const result = await findFlag(bag, 'P-IV-HOT-4');
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

await test('evaluateHandbook returns FiredFlags + Skips for an industrial deal', async () => {
  const bag: FieldBag = {
    asset_type: 'Industrial',
    loan_purpose: 'Acquisition',
    building_age: 35,
    property_sub_type: 'Manufacturing',
    property_sub_type_specialty: undefined,
  };
  const result = await evaluateHandbook(handbook, bag);
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

await test('collectReferencedFields returns a non-empty sorted array', async () => {
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

await test('principleFieldDependencies returns one entry per DETERMINISTIC principle', async () => {
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

})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
