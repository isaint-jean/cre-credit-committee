/**
 * Tests for the library-floor disclosure builder (Phase B,
 * populated-workbook initiative).
 *
 *   npx tsx apps/api/src/scripts/test-floor-binding-disclosure.ts
 *
 * Covers `buildFloorBindings(adjustedInputs)`:
 *
 *   - AdjustedInputs with JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN in the
 *     adjustments ledger → floorBindings contains the matching entry
 *     with the right lineItem, ruleId, delta, reason.
 *   - AdjustedInputs with no floor-binding rules → floorBindings is an
 *     empty array.
 *   - Multiple floor bindings on different line items → all surface in
 *     the array, in source-ledger order.
 *   - Adjustments whose ruleId is NOT a floor binding (e.g.
 *     JE_NOI_RECONCILED, JE_MANIFESTO_*) → skipped.
 *   - Deterministic: same input → byte-equal output (no clock reads, no
 *     Math.random).
 *
 * Pure unit test — no graph / store / HTTP. Builds a minimal
 * AdjustedInputs structurally compatible with @cre/shared's flat
 * `adjustments: AdjustmentEntry[]` ledger.
 */

import { buildFloorBindings, isFloorBindingRuleId } from '../services/build-floor-bindings.js';
import type { AdjustedInputs, AdjustmentEntry } from '@cre/shared';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertDeepEqual<T>(a: T, b: T, m: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  sa === sb ? ok(m) : fail(`${m} (actual=${sa}, expected=${sb})`);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal AdjustedInputs structurally compatible with
 * @cre/shared's flat adjustments ledger. Only the adjustments[] array is
 * load-bearing for this builder; the remaining numeric fields are filler.
 */
function makeAdjustedInputs(adjustments: AdjustmentEntry[]): AdjustedInputs {
  return {
    income: {
      grossPotentialRent: { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      vacancyLoss:        { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      concessions:        { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      otherIncome:        { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      effectiveGrossIncome:{raw: 0, adjusted: 0, delta: 0, source: 'raw' },
    },
    expenses: {
      realEstateTaxes:        { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      insurance:              { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      utilities:              { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      repairsAndMaintenance:  { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      management:             { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      generalAndAdmin:        { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      payroll:                { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      replacementReserves:    { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
      totalExpenses:          { raw: 0, adjusted: 0, delta: 0, source: 'raw' },
    },
    loan: {
      loanAmount: 0, interestRate: 0, rateType: 'fixed' as any,
      amortizationMonths: 360, termMonths: 60, ioMonths: 0,
    },
    metrics: {
      netOperatingIncome: 0, capRate: 0, impliedValue: null,
      annualDebtService: null, dscr: null, ltv: null, debtYield: null,
    },
    adjustments,
    confidenceReduction: 0,
  };
}

const FLOOR_ENTRY_EXPENSE_LIBRARY: AdjustmentEntry = {
  ruleId: 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN',
  field: 'totalOperatingExpenses',
  before: 200_000,
  after: 235_000,
  reason: 'Library median expense ratio (35%) exceeded source-derived value.',
  source: 'library-baseline',
};

const FLOOR_ENTRY_VACANCY_LIBRARY: AdjustmentEntry = {
  ruleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
  field: 'vacancyPct',
  before: 0.03,
  after: 0.07,
  reason: 'Library vacancy median (7%) exceeded source-derived 3%.',
  source: 'library-baseline',
};

const FLOOR_ENTRY_EXPENSE_BANK: AdjustmentEntry = {
  ruleId: 'JE_EXPENSE_RAISED_TO_BANK',
  field: 'totalOperatingExpenses',
  before: 180_000,
  after: 210_000,
  reason: 'Bank-observed expense ratio higher than source.',
  source: 'manifesto-rule',
};

const FLOOR_ENTRY_NOI_CAP: AdjustmentEntry = {
  ruleId: 'JE_NOI_CAPPED_TO_BANK',
  field: 'netOperatingIncome',
  before: 950_000,
  after: 900_000,
  reason: 'Bank NOI ceiling enforced (system UW NOI exceeded bank cap).',
  source: 'manifesto-rule',
};

const FLOOR_ENTRY_EXPENSE_SUBSTITUTED: AdjustmentEntry = {
  ruleId: 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY',
  field: 'totalOperatingExpenses',
  before: null,
  after: 220_000,
  reason: 'Source expense ratio missing; substituted library median.',
  source: 'library-baseline',
};

const NON_FLOOR_ENTRY_NOI_RECON: AdjustmentEntry = {
  ruleId: 'JE_NOI_RECONCILED',
  field: 'netOperatingIncome',
  before: 1_000_000,
  after: 1_000_000,
  reason: 'NOI reconciled against trailing actual; no change.',
  source: 'manifesto-rule',
};

const NON_FLOOR_ENTRY_MISSING_DATA: AdjustmentEntry = {
  ruleId: 'JE_TRAILING_ACTUALS_MISSING',
  field: 'confidenceReduction',
  before: 0,
  after: 0.05,
  reason: 'Trailing-12 actuals missing — distrust penalty applied.',
  source: 'missing-data-penalty',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testEmptyLedger(): void {
  console.log('\n[1] empty adjustments ledger → empty floorBindings');
  const ai = makeAdjustedInputs([]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 0, 'returns empty array');
  assert(Array.isArray(result), 'returns an Array (not undefined / null)');
}

function testSingleLibraryFloor(): void {
  console.log('\n[2] single JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN entry');
  const ai = makeAdjustedInputs([FLOOR_ENTRY_EXPENSE_LIBRARY]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 1, 'one floor binding emitted');
  const fb = result[0];
  assertEqual(fb.lineItem, 'totalOperatingExpenses', 'lineItem = totalOperatingExpenses');
  assertEqual(fb.ruleId, 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN', 'ruleId preserved');
  assertEqual(fb.delta, 35_000, 'delta = after - (before ?? 0) = 35,000');
  assertEqual(fb.reason, FLOOR_ENTRY_EXPENSE_LIBRARY.reason, 'reason preserved verbatim');
}

function testNullBeforeYieldsAfterAsDelta(): void {
  console.log('\n[3] null `before` treats as zero → delta = after');
  const ai = makeAdjustedInputs([FLOOR_ENTRY_EXPENSE_SUBSTITUTED]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 1, 'one floor binding emitted');
  assertEqual(result[0].delta, 220_000, 'delta = after when before is null');
  assertEqual(result[0].ruleId, 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY', 'SUBSTITUTED rule matches floor pattern');
}

function testMultipleFloorBindings(): void {
  console.log('\n[4] multiple floor bindings on different line items');
  const ai = makeAdjustedInputs([
    FLOOR_ENTRY_EXPENSE_LIBRARY,
    FLOOR_ENTRY_VACANCY_LIBRARY,
    FLOOR_ENTRY_EXPENSE_BANK,
    FLOOR_ENTRY_NOI_CAP,
  ]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 4, 'four floor bindings emitted');
  assertEqual(result[0].lineItem, 'totalOperatingExpenses', '[0] lineItem');
  assertEqual(result[1].lineItem, 'vacancyPct',              '[1] lineItem');
  assertEqual(result[2].lineItem, 'totalOperatingExpenses', '[2] lineItem');
  assertEqual(result[3].lineItem, 'netOperatingIncome',     '[3] lineItem');
  assertEqual(result[0].ruleId, 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN', '[0] ruleId');
  assertEqual(result[1].ruleId, 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', '[1] ruleId');
  assertEqual(result[2].ruleId, 'JE_EXPENSE_RAISED_TO_BANK',           '[2] ruleId');
  assertEqual(result[3].ruleId, 'JE_NOI_CAPPED_TO_BANK',               '[3] ruleId');
}

function testNonFloorRulesSkipped(): void {
  console.log('\n[5] non-floor adjustments are skipped');
  const ai = makeAdjustedInputs([
    NON_FLOOR_ENTRY_NOI_RECON,
    FLOOR_ENTRY_VACANCY_LIBRARY,
    NON_FLOOR_ENTRY_MISSING_DATA,
  ]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 1, 'only the floor entry is emitted');
  assertEqual(result[0].ruleId, 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', 'right entry kept');
}

function testRuleIdPredicateMatrix(): void {
  console.log('\n[6] isFloorBindingRuleId predicate matrix');
  // POSITIVE matches
  assert(isFloorBindingRuleId('JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN'), 'library median expense lift');
  assert(isFloorBindingRuleId('JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN'), 'library median vacancy lift');
  assert(isFloorBindingRuleId('JE_EXPENSE_RAISED_TO_BANK'),           'bank-observed expense lift');
  assert(isFloorBindingRuleId('JE_VACANCY_RAISED_TO_BANK'),           'bank-observed vacancy lift');
  assert(isFloorBindingRuleId('JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY'), 'library substitution');
  assert(isFloorBindingRuleId('JE_NOI_CAPPED_TO_BANK'),               'bank NOI ceiling cap');
  assert(isFloorBindingRuleId('JE_ANY_FLOOR'),                        'generic *_FLOOR suffix');
  assert(isFloorBindingRuleId('JE_DSCR_FLOOR'),                       'DSCR floor');
  // NEGATIVE matches
  assert(!isFloorBindingRuleId('JE_NOI_RECONCILED'),                  'noi-reconciliation is NOT a floor binding');
  assert(!isFloorBindingRuleId('JE_TRAILING_ACTUALS_MISSING'),        'missing-data flag is NOT a floor binding');
  assert(!isFloorBindingRuleId('JE_RENT_ROLL_UNIT_INCOMPLETE'),       'rent-roll quality is NOT a floor binding');
  assert(!isFloorBindingRuleId('JE_PERIOD_LABEL_MISMATCH'),           'period mismatch is NOT a floor binding');
  assert(!isFloorBindingRuleId(undefined),                            'undefined ruleId predicate is false');
  assert(!isFloorBindingRuleId(''),                                   'empty ruleId predicate is false');
  assert(!isFloorBindingRuleId(null),                                 'null ruleId predicate is false');
}

function testSkipsEntriesWithoutField(): void {
  console.log('\n[7] adjustments without a `field` are skipped');
  const fieldless = {
    ...FLOOR_ENTRY_EXPENSE_LIBRARY,
    field: '' as any,
  };
  const ai = makeAdjustedInputs([fieldless, FLOOR_ENTRY_VACANCY_LIBRARY]);
  const result = buildFloorBindings(ai);
  assertEqual(result.length, 1, 'only the entry with a field is emitted');
  assertEqual(result[0].lineItem, 'vacancyPct', 'field-bearing entry is kept');
}

function testDeterminism(): void {
  console.log('\n[8] deterministic over its input');
  const ai = makeAdjustedInputs([
    FLOOR_ENTRY_EXPENSE_LIBRARY,
    FLOOR_ENTRY_VACANCY_LIBRARY,
    NON_FLOOR_ENTRY_NOI_RECON,
    FLOOR_ENTRY_NOI_CAP,
  ]);
  const r1 = buildFloorBindings(ai);
  const r2 = buildFloorBindings(ai);
  const r3 = buildFloorBindings(makeAdjustedInputs([
    FLOOR_ENTRY_EXPENSE_LIBRARY,
    FLOOR_ENTRY_VACANCY_LIBRARY,
    NON_FLOOR_ENTRY_NOI_RECON,
    FLOOR_ENTRY_NOI_CAP,
  ]));
  assertDeepEqual(r1, r2, 'two calls with the same fixture produce byte-equal output');
  assertDeepEqual(r1, r3, 'fresh fixture with same values produces byte-equal output');
}

function testReportableSample(): void {
  console.log('\n[9] sample output for the brief\'s "report verbatim" requirement');
  const ai = makeAdjustedInputs([FLOOR_ENTRY_EXPENSE_LIBRARY]);
  const result = buildFloorBindings(ai);
  // Print the sample so the parent's report can capture it verbatim.
  console.log('  sample floorBindings:');
  console.log('  ' + JSON.stringify(result, null, 2).replace(/\n/g, '\n  '));
  assertEqual(result.length, 1, 'sample has one floor binding');
}

(() => {
  console.log('=== test-floor-binding-disclosure ===');
  testEmptyLedger();
  testSingleLibraryFloor();
  testNullBeforeYieldsAfterAsDelta();
  testMultipleFloorBindings();
  testNonFloorRulesSkipped();
  testRuleIdPredicateMatrix();
  testSkipsEntriesWithoutField();
  testDeterminism();
  testReportableSample();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
