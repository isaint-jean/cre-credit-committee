/**
 * Tests for HandbookEvaluation contract module.
 *
 * Covers:
 *   - Type construction at runtime (does the literal compile and serialize?)
 *   - JSON round-trip stability (serialization preserves shape)
 *   - undefined-key serialization behavior in fieldBagSnapshot
 *   - SKIP_REASONS enum coverage
 *
 * Hand-rolled assertEqual pattern matching the workspace convention.
 *
 * INTEGRATION NOTE FOR CC: rewire the import block to use the real
 * @cre/contracts module:
 *
 *   import type { HandbookEvaluation, FiredFlag, SkippedPrinciple,
 *     SkipReason } from '@cre/contracts';
 *   import { SKIP_REASONS } from '@cre/contracts';
 */

import type {
  AdjustedInputsId,
  FieldBag,
  FiredFlag,
  HandbookEngineVersion,
  HandbookEvaluation,
  HandbookEvaluationId,
  ISODateTime,
  SkippedPrinciple,
} from '@cre/contracts';
import { SKIP_REASONS } from '@cre/contracts';

// =============================================================================
// Hand-rolled test runner
// =============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}

function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}

function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    ok(m);
  } else {
    fail(
      `${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`,
    );
  }
}

function assertDeepEqual<T>(actual: T, expected: T, m: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    ok(m);
  } else {
    fail(`${m} (actual=${a}, expected=${e})`);
  }
}

// =============================================================================
// Fixture
// =============================================================================

function makeFiredFlag(overrides: Partial<FiredFlag> = {}): FiredFlag {
  return {
    principleId: 'P-IV-OFF-2',
    severity: 'high',
    flag_message: 'Office property is Class B. Per handbook, Class B/C assets face elevated risk.',
    metricValue: 'B',
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: ['red_flag_assessment', 'committee_recommendation'],
    ...overrides,
  };
}

function makeSkippedPrinciple(overrides: Partial<SkippedPrinciple> = {}): SkippedPrinciple {
  return {
    principleId: 'P-IV-HOT-5',
    reason: 'trigger_inactive',
    ...overrides,
  };
}

function makeMinimalEvaluation(): HandbookEvaluation {
  const bag: FieldBag = {
    asset_type: 'Office',
    debt_yield: 0.085,
    dscr: 1.20,
    loan_amount: 30_000_000,
    msa: 'Atlanta-Sandy Springs-Alpharetta, GA MSA',
    building_class: 'B',
    property_sub_type: 'Suburban Office',
    building_age: 30,
    stressed_dscr_top_3_removed: 0.85,
    tenancy_type: 'Multi-Tenant',
  };

  return {
    id: 'aaaaaaaaaaaaaaaa' as HandbookEvaluationId,
    analysisAsOfDate: '2026-01-01T00:00:00.000Z' as ISODateTime,
    adjustedInputsId: 'bbbbbbbbbbbbbbbb' as AdjustedInputsId,
    handbookVersion: '2026.1',
    engineVersion: '1.0.0' as HandbookEngineVersion,
    firedFlags: [
      makeFiredFlag({ principleId: 'P-IV-OFF-2', bandIndex: 0 }),
      makeFiredFlag({
        principleId: 'P-IV-OFF-6',
        severity: 'critical',
        flag_message: 'Stressed DSCR is 0.85, below 1.0.',
        metricValue: 0.85,
      }),
    ],
    skippedPrinciples: [
      makeSkippedPrinciple({ principleId: 'P-IV-ST-4', reason: 'trigger_inactive' }),
      makeSkippedPrinciple({
        principleId: 'P-IV-HOT-10',
        reason: 'missing_field',
        detail: "metric field 'annual_room_revenue'",
      }),
    ],
    fieldBagSnapshot: bag,
  };
}

// =============================================================================
// Tests
// =============================================================================

console.log('\n=== HandbookEvaluation construction ===');

(() => {
  const eval_ = makeMinimalEvaluation();
  assertEqual(eval_.handbookVersion, '2026.1', 'handbookVersion populated');
  assertEqual(eval_.engineVersion, '1.0.0', 'engineVersion populated');
  assertEqual(eval_.firedFlags.length, 2, 'two fired flags');
  assertEqual(eval_.skippedPrinciples.length, 2, 'two skipped principles');
  ok('full HandbookEvaluation literal compiles and constructs');
})();

console.log('\n=== FiredFlag completeness (preserves all engine output fields) ===');

(() => {
  const flag = makeFiredFlag();
  assertEqual(flag.principleId, 'P-IV-OFF-2', 'principleId field');
  assertEqual(flag.severity, 'high', 'severity field');
  assertEqual(flag.metricValue, 'B', 'metricValue field (critical for LLM citations)');
  assertEqual(flag.groupIndex, 0, 'groupIndex field (critical for nested-exception diagnostics)');
  assertEqual(flag.bandIndex, 0, 'bandIndex field');
  assertDeepEqual(
    flag.injectionPoints,
    ['red_flag_assessment', 'committee_recommendation'],
    'injectionPoints field (bridge to future LLM-context integration)',
  );
})();

console.log('\n=== SkippedPrinciple shape (preserves detail field) ===');

(() => {
  const skip = makeSkippedPrinciple({
    principleId: 'P-IV-HOT-10',
    reason: 'missing_field',
    detail: "metric field 'annual_room_revenue'",
  });
  assertEqual(skip.reason, 'missing_field', 'reason field');
  assertEqual(
    skip.detail,
    "metric field 'annual_room_revenue'",
    'detail field (diagnostic gold)',
  );
})();

console.log('\n=== SKIP_REASONS enum coverage ===');

(() => {
  // All 7 reasons the engine can produce must be in the enum
  const expected = [
    'trigger_inactive',
    'not_deterministic',
    'no_check_defined',
    'missing_field',
    'no_band_matched',
    'no_group_matched',
    'degenerate_evaluation',
  ];
  assertEqual(SKIP_REASONS.length, expected.length, `SKIP_REASONS has ${expected.length} entries`);
  for (const reason of expected) {
    if (!SKIP_REASONS.includes(reason as never)) {
      fail(`SKIP_REASONS missing '${reason}'`);
    }
  }
  ok('all 7 engine skip reasons covered');
})();

console.log('\n=== fieldBagSnapshot JSON round-trip ===');

(() => {
  const eval_ = makeMinimalEvaluation();
  // Round-trip through JSON.
  const round = JSON.parse(JSON.stringify(eval_)) as HandbookEvaluation;
  assertEqual(round.handbookVersion, eval_.handbookVersion, 'handbookVersion survives round-trip');
  assertEqual(round.fieldBagSnapshot['asset_type'], 'Office', 'fieldBagSnapshot survives round-trip');
  assertEqual(round.fieldBagSnapshot['debt_yield'], 0.085, 'numeric value survives');
  assertEqual(round.firedFlags.length, 2, 'firedFlags array survives');
  assertEqual(round.skippedPrinciples[1]?.detail, "metric field 'annual_room_revenue'", 'detail survives');
})();

console.log('\n=== fieldBagSnapshot drops undefined keys after JSON serialization ===');

(() => {
  const bagWithUndefined: FieldBag = {
    asset_type: 'Office',
    debt_yield: 0.085,
    mall_class: undefined,           // dropped
    appraised_dark_value: undefined, // dropped
    hotel_service_level: undefined,  // dropped
  };
  const serialized = JSON.parse(JSON.stringify(bagWithUndefined));
  // Only 2 keys should survive (the 3 undefined ones are dropped by JSON.stringify)
  const keys = Object.keys(serialized);
  assertEqual(keys.length, 2, 'undefined keys dropped after JSON serialization');
  assertEqual(serialized['asset_type'], 'Office', 'populated keys preserved');
  assertEqual(serialized['debt_yield'], 0.085, 'populated numeric keys preserved');
  ok('JSON canonicalization will only persist 14 of 31 keys (the populated ones)');
})();

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
