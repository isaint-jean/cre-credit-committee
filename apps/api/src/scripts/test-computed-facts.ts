/**
 * Pure unit tests for the Phase 2 computed-facts builders:
 *   - buildReserveScheduleFacts (AdjustedInputs.capitalReserves → ReserveScheduleFacts)
 *   - buildTerminationOptionsFacts (always emits Phase-2 extraction-gap shape)
 *
 *   npx tsx apps/api/src/scripts/test-computed-facts.ts
 *
 * Covers:
 *   - all-null monthlies → totalMonthlyReservesDollars=null (strict null fidelity,
 *     NOT zero)
 *   - all-populated reserves (mix of zeros and non-zeros) → roll-ups correct
 *   - mixed nulls — the brief's headline case: monthlyReplacementReserves=$0 but
 *     monthlyTiLc>0 → anyMonthlyReservePopulated=true, totalMonthlyReservesDollars
 *     adds up correctly across non-null fields
 *   - capexScheduleInflated passthrough — populated and null
 *   - upfronts: all null → totalUpfrontReservesDollars null
 *   - source tag matches contract literal
 *   - anyMonthlyReservePopulated true iff at least one monthly is non-null AND > 0
 *     (a populated zero does NOT count as "populated")
 *   - buildTerminationOptionsFacts: extracted=false, options=null, extractionGap
 *     populated with the canonical detail prose + recommendedInputKind
 *   - determinism: builders called twice with same inputs → byte-identical output
 */

import type { AdjustedInputs } from '@cre/contracts';
import {
  buildReserveScheduleFacts,
  buildTerminationOptionsFacts,
} from '../services/handbook/run-llm-context-check.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertDeepEqual<T>(a: T, b: T, m: string): void {
  JSON.stringify(a) === JSON.stringify(b)
    ? ok(m)
    : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

// AdjustedLineItem.adjusted is non-null in the contract today, but the builder
// is null-aware for forward-compat. We exercise nulls below by casting via the
// test fixture (test-only — the production type is unchanged).
function lineItem(value: number | null) {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

interface ReserveFixture {
  monthlyReplacementReserves: number | null;
  monthlyCapex: number | null;
  monthlyTiLc: number | null;
  monthlyTenantImprovements: number | null;
  monthlyLeasingCommissions: number | null;
  upfrontReplacementReserves: number | null;
  upfrontTiLc: number | null;
  pcaImmediateRepairs: number | null;
  capexScheduleInflated: ReadonlyArray<{ year: number; amount: number }> | null;
}

function mkAdjusted(rs: ReserveFixture): AdjustedInputs {
  return {
    capitalReserves: {
      upfrontCapex: lineItem(0),
      upfrontReplacementReserves: lineItem(rs.upfrontReplacementReserves),
      upfrontTiLc: lineItem(rs.upfrontTiLc),
      monthlyCapex: lineItem(rs.monthlyCapex),
      monthlyTiLc: lineItem(rs.monthlyTiLc),
      monthlyReplacementReserves: lineItem(rs.monthlyReplacementReserves),
      monthlyTenantImprovements: lineItem(rs.monthlyTenantImprovements),
      monthlyLeasingCommissions: lineItem(rs.monthlyLeasingCommissions),
      pcaImmediateRepairs: lineItem(rs.pcaImmediateRepairs),
      capexScheduleInflated: rs.capexScheduleInflated,
      capexScheduleUninflated: null,
    },
  } as unknown as AdjustedInputs;
}

console.log('1. buildReserveScheduleFacts — all-null monthlies, all-null upfronts');
{
  const facts = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: null, monthlyCapex: null, monthlyTiLc: null,
    monthlyTenantImprovements: null, monthlyLeasingCommissions: null,
    upfrontReplacementReserves: null, upfrontTiLc: null, pcaImmediateRepairs: null,
    capexScheduleInflated: null,
  }));
  assertEqual(facts.source, 'adjusted_inputs.capitalReserves', '1.1 source literal correct');
  assertEqual(facts.monthlyReplacementReserves, null, '1.2 monthlyReplacementReserves null preserved');
  assertEqual(facts.monthlyCapex, null, '1.3 monthlyCapex null preserved');
  assertEqual(facts.monthlyTiLc, null, '1.4 monthlyTiLc null preserved');
  assertEqual(facts.monthlyTenantImprovements, null, '1.5 monthlyTenantImprovements null preserved');
  assertEqual(facts.monthlyLeasingCommissions, null, '1.6 monthlyLeasingCommissions null preserved');
  assertEqual(facts.upfrontReplacementReserves, null, '1.7 upfrontReplacementReserves null preserved');
  assertEqual(facts.upfrontTiLc, null, '1.8 upfrontTiLc null preserved');
  assertEqual(facts.pcaImmediateRepairs, null, '1.9 pcaImmediateRepairs null preserved');
  assertEqual(facts.capexScheduleInflated, null, '1.10 capexScheduleInflated null passthrough');
  assertEqual(facts.totalMonthlyReservesDollars, null, '1.11 totalMonthlyReservesDollars=NULL on all-null (NOT zero — strict null fidelity)');
  assertEqual(facts.totalUpfrontReservesDollars, null, '1.12 totalUpfrontReservesDollars=NULL on all-null (NOT zero)');
  assertEqual(facts.anyMonthlyReservePopulated, false, '1.13 anyMonthlyReservePopulated=false on all-null');
}

console.log('\n2. buildReserveScheduleFacts — all-populated, all positive');
{
  const facts = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: 750, monthlyCapex: 250, monthlyTiLc: 500,
    monthlyTenantImprovements: 300, monthlyLeasingCommissions: 200,
    upfrontReplacementReserves: 100_000, upfrontTiLc: 50_000, pcaImmediateRepairs: 25_000,
    capexScheduleInflated: [{ year: 1, amount: 5_000 }, { year: 2, amount: 7_500 }],
  }));
  assertEqual(facts.monthlyReplacementReserves, 750, '2.1 monthlyReplacementReserves preserved');
  assertEqual(facts.monthlyCapex, 250, '2.2 monthlyCapex preserved');
  assertEqual(facts.monthlyTiLc, 500, '2.3 monthlyTiLc preserved');
  // 750 + 250 + 500 + 300 + 200 = 2000
  assertEqual(facts.totalMonthlyReservesDollars, 2000, '2.4 totalMonthlyReservesDollars sums all 5 monthlies');
  // 100k + 50k + 25k = 175k
  assertEqual(facts.totalUpfrontReservesDollars, 175_000, '2.5 totalUpfrontReservesDollars sums all 3 upfronts');
  assertEqual(facts.anyMonthlyReservePopulated, true, '2.6 anyMonthlyReservePopulated=true (multiple positive)');
  assertDeepEqual(
    facts.capexScheduleInflated,
    [{ year: 1, amount: 5_000 }, { year: 2, amount: 7_500 }],
    '2.7 capexScheduleInflated passthrough verbatim',
  );
}

console.log('\n3. buildReserveScheduleFacts — MIXED nulls (the brief\'s headline case)');
// monthlyReplacementReserves=$0 but monthlyTiLc>0. The roll-ups must reflect:
//   totalMonthlyReservesDollars: 0+500+300+200 = 1000 (capex is null → excluded)
//   anyMonthlyReservePopulated: true (TI/LC is >0)
{
  const facts = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: 0,
    monthlyCapex: null,        // null — excluded from sum
    monthlyTiLc: 500,          // populated
    monthlyTenantImprovements: 300,
    monthlyLeasingCommissions: 200,
    upfrontReplacementReserves: 0,
    upfrontTiLc: 75_000,
    pcaImmediateRepairs: null, // null — excluded from upfront sum
    capexScheduleInflated: null,
  }));
  assertEqual(facts.monthlyReplacementReserves, 0, '3.1 monthlyReplacementReserves=0 preserved (NOT promoted to null)');
  assertEqual(facts.monthlyCapex, null, '3.2 monthlyCapex null preserved');
  assertEqual(facts.monthlyTiLc, 500, '3.3 monthlyTiLc=500 preserved');
  // Sum: 0 + 500 + 300 + 200 = 1000 (capex null excluded)
  assertEqual(facts.totalMonthlyReservesDollars, 1000, '3.4 totalMonthlyReservesDollars excludes null capex, sums the rest correctly');
  // Sum: 0 + 75k = 75k (pcaImmediateRepairs null excluded)
  assertEqual(facts.totalUpfrontReservesDollars, 75_000, '3.5 totalUpfrontReservesDollars excludes null pcaImmediateRepairs');
  assertEqual(facts.anyMonthlyReservePopulated, true, '3.6 anyMonthlyReservePopulated=true (TI/LC > 0; replacement=0 doesn\'t count)');
}

console.log('\n4. buildReserveScheduleFacts — populated zeros only (anyMonthlyReservePopulated semantic)');
// All monthlies are 0 (not null). anyMonthlyReservePopulated must be FALSE
// (the predicate requires non-null AND > 0; a populated zero is not "populated reserves").
{
  const facts = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: 0, monthlyCapex: 0, monthlyTiLc: 0,
    monthlyTenantImprovements: 0, monthlyLeasingCommissions: 0,
    upfrontReplacementReserves: 0, upfrontTiLc: 0, pcaImmediateRepairs: 0,
    capexScheduleInflated: null,
  }));
  assertEqual(facts.totalMonthlyReservesDollars, 0, '4.1 totalMonthlyReservesDollars=0 (real sum of zeros, NOT null)');
  assertEqual(facts.totalUpfrontReservesDollars, 0, '4.2 totalUpfrontReservesDollars=0 (real sum of zeros)');
  assertEqual(facts.anyMonthlyReservePopulated, false, '4.3 anyMonthlyReservePopulated=FALSE on all-zero (zero is not "populated")');
}

console.log('\n5. buildReserveScheduleFacts — capexScheduleInflated empty array vs null');
{
  // Empty array — passed through as-is (not null).
  const factsEmpty = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: 0, monthlyCapex: 0, monthlyTiLc: 0,
    monthlyTenantImprovements: 0, monthlyLeasingCommissions: 0,
    upfrontReplacementReserves: 0, upfrontTiLc: 0, pcaImmediateRepairs: 0,
    capexScheduleInflated: [],
  }));
  assertDeepEqual(factsEmpty.capexScheduleInflated, [], '5.1 empty array passes through as []');

  // Null — passes through as null.
  const factsNull = buildReserveScheduleFacts(mkAdjusted({
    monthlyReplacementReserves: 0, monthlyCapex: 0, monthlyTiLc: 0,
    monthlyTenantImprovements: 0, monthlyLeasingCommissions: 0,
    upfrontReplacementReserves: 0, upfrontTiLc: 0, pcaImmediateRepairs: 0,
    capexScheduleInflated: null,
  }));
  assertEqual(factsNull.capexScheduleInflated, null, '5.2 null passes through as null');
}

console.log('\n6. buildReserveScheduleFacts — determinism (same input twice → byte-identical output)');
{
  const fixture: ReserveFixture = {
    monthlyReplacementReserves: 0, monthlyCapex: null, monthlyTiLc: 500,
    monthlyTenantImprovements: 300, monthlyLeasingCommissions: 200,
    upfrontReplacementReserves: 0, upfrontTiLc: 75_000, pcaImmediateRepairs: null,
    capexScheduleInflated: [{ year: 1, amount: 3_000 }],
  };
  const f1 = buildReserveScheduleFacts(mkAdjusted(fixture));
  const f2 = buildReserveScheduleFacts(mkAdjusted(fixture));
  assertEqual(JSON.stringify(f1), JSON.stringify(f2), '6.1 two calls produce byte-identical output');
}

console.log('\n7. buildTerminationOptionsFacts — always Phase-2 extraction-gap shape');
{
  const f = buildTerminationOptionsFacts();
  assertEqual(f.source, 'rent_roll_footnotes', '7.1 source literal correct');
  assertEqual(f.extracted, false, '7.2 extracted=false (Phase 2 extraction gap)');
  assertEqual(f.options, null, '7.3 options=null when not extracted');
  assert(f.extractionGap !== null, '7.4 extractionGap populated');
  if (f.extractionGap !== null) {
    assertEqual(f.extractionGap.kind, 'termination_option_extraction_gap', '7.5 extractionGap.kind matches');
    assertEqual(f.extractionGap.recommendedInputKind, 'termination_option_extraction_gap', '7.6 recommendedInputKind matches');
    assert(f.extractionGap.detail.includes('rent-roll footnote'), '7.7 detail prose references rent-roll footnote');
    assert(f.extractionGap.detail.includes('needs_manual_input'), '7.8 detail prose instructs needs_manual_input path');
    assert(f.extractionGap.detail.length > 80, '7.9 detail prose has substantive guidance');
  }
}

console.log('\n8. buildTerminationOptionsFacts — determinism (two calls → byte-identical)');
{
  const a = buildTerminationOptionsFacts();
  const b = buildTerminationOptionsFacts();
  assertEqual(JSON.stringify(a), JSON.stringify(b), '8.1 two calls produce byte-identical output');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
