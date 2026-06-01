/**
 * Pure unit tests for `buildNoiReconciliationFacts` (Commit 1 — Model-A value-add
 * NOI reconciliation rule).
 *
 *   npx tsx apps/api/src/scripts/test-noi-reconciliation.ts
 *
 * Covers:
 *   - Both inputs present + uplift → verdict='noi_uplift_present',
 *     excessDollars/Fraction computed correctly.
 *   - Both inputs present + no uplift (negative or zero excess) → verdict
 *     ='noi_at_or_below_trailing', excessDollars/Fraction computed.
 *   - trailingActualNoi=0 → excessFraction null (div-by-zero guard); verdict still
 *     computes from excessDollars sign.
 *   - Either operand null → verdict='insufficient_data', derived fields null.
 *   - signedLeaseBackingAvailable ALWAYS false (engine version policy).
 *   - extractionGap shape ALWAYS present (kind + recommendedInputKind constant;
 *     detail contains the load-bearing prose).
 *   - Issuer-stated NOI fields pass through verbatim (cross-reference, not load-bearing).
 *   - source tag is constant 'adjusted_inputs.metrics' so the LLM sees a single origin
 *     label.
 *
 * Spec-clean (§2.3): the builder reads AdjustedInputs only; this test file imports
 * nothing from extraction. The test inputs use a minimal hand-rolled AdjustedInputs
 * cast through `as unknown as AdjustedInputs` — we don't go through the judgment
 * orchestrator (that's covered separately by test-judgment-orchestrator.ts).
 */

import type { AdjustedInputs } from '@cre/contracts';
import { buildNoiReconciliationFacts } from '../services/handbook/run-llm-context-check.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/**
 * Minimal AdjustedInputs builder for the NOI-recon tests. Only the four metrics
 * fields the builder reads are populated honestly; the rest are filler so the
 * type checker is satisfied. The builder must read AdjustedInputs.metrics ONLY.
 */
function makeAdjustedInputs(metrics: {
  noi: number | null;
  trailingActualNoi: number | null;
  issuerStatedNoiSellerUw: number | null;
  issuerStatedNoiAsr: number | null;
}): AdjustedInputs {
  return {
    metrics: {
      noi: metrics.noi,
      value: null,
      dscr: null,
      ltvAppraisal: null,
      debtYield: null,
      expenseRatio: null,
      top1IncomeShare: null,
      pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: metrics.trailingActualNoi,
      issuerStatedNoiSellerUw: metrics.issuerStatedNoiSellerUw,
      issuerStatedNoiAsr: metrics.issuerStatedNoiAsr,
    },
  } as unknown as AdjustedInputs;
}

console.log('1. Both inputs present + uplift → verdict=noi_uplift_present, correct excess');
{
  const ai = makeAdjustedInputs({
    noi: 1_200_000,
    trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: 1_150_000,
    issuerStatedNoiAsr: 1_180_000,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.source, 'adjusted_inputs.metrics', '1.1 source tag constant');
  assertEqual(f.systemUwNoi, 1_200_000, '1.2 systemUwNoi pass-through');
  assertEqual(f.trailingActualNoi, 1_000_000, '1.3 trailingActualNoi pass-through');
  assertEqual(f.issuerStatedNoiSellerUw, 1_150_000, '1.4 issuerStatedNoiSellerUw pass-through');
  assertEqual(f.issuerStatedNoiAsr, 1_180_000, '1.5 issuerStatedNoiAsr pass-through');
  assertEqual(f.excessDollars, 200_000, '1.6 excessDollars = 1.2M - 1.0M = 200k');
  assertEqual(f.excessFraction, 0.2, '1.7 excessFraction = 200k / 1.0M = 0.2');
  assertEqual(f.verdict, 'noi_uplift_present', '1.8 verdict=noi_uplift_present');
  assertEqual(f.signedLeaseBackingAvailable, false, '1.9 signedLeaseBackingAvailable=false (engine 1.5.0 policy)');
  assertEqual(f.extractionGap.kind, 'signed_lease_status_extraction_gap', '1.10 extractionGap.kind constant');
  assertEqual(f.extractionGap.recommendedInputKind, 'signed_lease_status_extraction_gap', '1.11 recommendedInputKind matches kind');
  assert(f.extractionGap.detail.includes('signed/executed'), '1.12 extractionGap.detail carries the load-bearing prose');
}

console.log('\n2. Both inputs present + no uplift (negative excess) → verdict=noi_at_or_below_trailing');
{
  const ai = makeAdjustedInputs({
    noi: 900_000,
    trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.excessDollars, -100_000, '2.1 excessDollars = -100k (system below trailing)');
  assertEqual(f.excessFraction, -0.1, '2.2 excessFraction = -100k / 1.0M = -0.1');
  assertEqual(f.verdict, 'noi_at_or_below_trailing', '2.3 verdict=noi_at_or_below_trailing');
  // Cross-reference fields pass through as null without affecting the verdict.
  assertEqual(f.issuerStatedNoiSellerUw, null, '2.4 null issuerStatedNoiSellerUw pass-through');
  assertEqual(f.issuerStatedNoiAsr, null, '2.5 null issuerStatedNoiAsr pass-through');
  assertEqual(f.signedLeaseBackingAvailable, false, '2.6 signedLeaseBackingAvailable=false even when no uplift');
}

console.log('\n3. Both inputs present + exactly equal (zero excess) → verdict=noi_at_or_below_trailing');
{
  const ai = makeAdjustedInputs({
    noi: 1_000_000,
    trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.excessDollars, 0, '3.1 excessDollars = 0 (exactly equal)');
  assertEqual(f.excessFraction, 0, '3.2 excessFraction = 0');
  assertEqual(f.verdict, 'noi_at_or_below_trailing', '3.3 zero excess → verdict=noi_at_or_below_trailing (NOT noi_uplift_present)');
}

console.log('\n4. trailingActualNoi=0 → excessFraction null (div-by-zero guard); verdict still computes');
{
  const ai = makeAdjustedInputs({
    noi: 500_000,
    trailingActualNoi: 0,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.excessDollars, 500_000, '4.1 excessDollars = 500k (system - 0)');
  assertEqual(f.excessFraction, null, '4.2 excessFraction null (div-by-zero guard, NOT Infinity, NOT 0)');
  assertEqual(f.verdict, 'noi_uplift_present', '4.3 verdict still computes from excessDollars sign');
}

console.log('\n5. trailingActualNoi=0 + systemUwNoi=0 → verdict=noi_at_or_below_trailing (zero excess); excessFraction null');
{
  const ai = makeAdjustedInputs({
    noi: 0,
    trailingActualNoi: 0,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.excessDollars, 0, '5.1 excessDollars = 0');
  assertEqual(f.excessFraction, null, '5.2 excessFraction null (div-by-zero guard holds even when numerator is zero)');
  assertEqual(f.verdict, 'noi_at_or_below_trailing', '5.3 zero/zero → not_uplift (verdict still computes from sign)');
}

console.log('\n6. systemUwNoi null → verdict=insufficient_data, all derived fields null');
{
  const ai = makeAdjustedInputs({
    noi: null,
    trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: 950_000,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.systemUwNoi, null, '6.1 systemUwNoi null pass-through');
  assertEqual(f.trailingActualNoi, 1_000_000, '6.2 trailingActualNoi pass-through');
  assertEqual(f.issuerStatedNoiSellerUw, 950_000, '6.3 issuer cross-reference still surfaces');
  assertEqual(f.excessDollars, null, '6.4 excessDollars null (strict null fidelity)');
  assertEqual(f.excessFraction, null, '6.5 excessFraction null');
  assertEqual(f.verdict, 'insufficient_data', '6.6 verdict=insufficient_data');
}

console.log('\n7. trailingActualNoi null → verdict=insufficient_data, all derived fields null');
{
  const ai = makeAdjustedInputs({
    noi: 1_200_000,
    trailingActualNoi: null,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: 1_100_000,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.systemUwNoi, 1_200_000, '7.1 systemUwNoi pass-through');
  assertEqual(f.trailingActualNoi, null, '7.2 trailingActualNoi null pass-through');
  assertEqual(f.issuerStatedNoiAsr, 1_100_000, '7.3 issuer cross-reference still surfaces');
  assertEqual(f.excessDollars, null, '7.4 excessDollars null');
  assertEqual(f.excessFraction, null, '7.5 excessFraction null');
  assertEqual(f.verdict, 'insufficient_data', '7.6 verdict=insufficient_data');
}

console.log('\n8. both operands null → verdict=insufficient_data; cross-references stay null');
{
  const ai = makeAdjustedInputs({
    noi: null,
    trailingActualNoi: null,
    issuerStatedNoiSellerUw: null,
    issuerStatedNoiAsr: null,
  });
  const f = buildNoiReconciliationFacts(ai);
  assertEqual(f.verdict, 'insufficient_data', '8.1 verdict=insufficient_data');
  assertEqual(f.systemUwNoi, null, '8.2 systemUwNoi null');
  assertEqual(f.trailingActualNoi, null, '8.3 trailingActualNoi null');
  assertEqual(f.issuerStatedNoiSellerUw, null, '8.4 issuerStatedNoiSellerUw null');
  assertEqual(f.issuerStatedNoiAsr, null, '8.5 issuerStatedNoiAsr null');
}

console.log('\n9. signedLeaseBackingAvailable ALWAYS false (engine 1.5.0 policy)');
{
  // Even when both NOIs are populated AND uplift is small AND issuer-stated values agree,
  // signedLeaseBackingAvailable stays false. This is the structural fact that drives the
  // resolution path: today's rent-roll extractor cannot pull signed-lease execution status.
  for (const trail of [null, 0, 500_000, 1_000_000]) {
    for (const sys of [null, 0, 500_000, 1_500_000]) {
      const ai = makeAdjustedInputs({
        noi: sys, trailingActualNoi: trail,
        issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
      });
      const f = buildNoiReconciliationFacts(ai);
      assertEqual(f.signedLeaseBackingAvailable, false,
        `9.x signedLeaseBackingAvailable=false (sys=${sys}, trail=${trail})`);
    }
  }
}

console.log('\n10. extractionGap shape ALWAYS present and constant (kind + recommendedInputKind)');
{
  // Same field-bag policy regardless of verdict: the extractionGap is structurally
  // present so the LLM can always cite it when it needs to escalate to the manual-input
  // path. (The decision to USE the gap is the LLM's; the gate just surfaces it.)
  const aiUplift = makeAdjustedInputs({
    noi: 1_200_000, trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
  });
  const aiNoUplift = makeAdjustedInputs({
    noi: 900_000, trailingActualNoi: 1_000_000,
    issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
  });
  const aiNull = makeAdjustedInputs({
    noi: null, trailingActualNoi: null,
    issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
  });
  for (const [label, ai] of [['uplift', aiUplift], ['no-uplift', aiNoUplift], ['null', aiNull]] as const) {
    const f = buildNoiReconciliationFacts(ai);
    assertEqual(f.extractionGap.kind, 'signed_lease_status_extraction_gap',
      `10.x (${label}) extractionGap.kind constant`);
    assertEqual(f.extractionGap.recommendedInputKind, 'signed_lease_status_extraction_gap',
      `10.x (${label}) recommendedInputKind constant`);
    assert(f.extractionGap.detail.length > 100,
      `10.x (${label}) extractionGap.detail carries substantive prose`);
  }
}

console.log('\n11. Issuer-stated NOI fields are cross-reference only (do NOT change the verdict)');
{
  // Same systemUwNoi (200k) + trailingActualNoi (300k), but different issuer-stated
  // values. Verdict must NOT change — the trigger compares system UW vs trailing only.
  const ai_low = makeAdjustedInputs({
    noi: 200_000, trailingActualNoi: 300_000,
    issuerStatedNoiSellerUw: 100_000, issuerStatedNoiAsr: 100_000,
  });
  const ai_high = makeAdjustedInputs({
    noi: 200_000, trailingActualNoi: 300_000,
    issuerStatedNoiSellerUw: 500_000, issuerStatedNoiAsr: 500_000,
  });
  const f_low = buildNoiReconciliationFacts(ai_low);
  const f_high = buildNoiReconciliationFacts(ai_high);
  assertEqual(f_low.verdict, 'noi_at_or_below_trailing', '11.1 low issuer values → verdict driven by trailing');
  assertEqual(f_high.verdict, 'noi_at_or_below_trailing', '11.2 high issuer values → same verdict (issuer is cross-ref only)');
  assertEqual(f_low.excessDollars, f_high.excessDollars, '11.3 excessDollars unchanged by issuer values');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
