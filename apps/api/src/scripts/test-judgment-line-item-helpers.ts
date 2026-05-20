/**
 * Tests for per-line-item adjustment helpers (Batch 3a).
 *
 *   npm run test:judgment-line-item-helpers
 *
 * Covers all 5 patterns + the distrust-penalty wrapper. Verifies null-handling discipline,
 * delta sign, AdjustmentEntry composition + ordering, and the no-silent-coercion invariant.
 */

import {
  adjustSubstituteOnly,
  adjustWithFloor,
  buildDerivedLineItem,
  buildNotApplicableLineItem,
  requireRaw,
  withDistrustPenalty,
} from '../services/judgment/line-item-helpers.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}
function assertThrows(fn: () => unknown, m: string): void {
  try { fn(); fail(`${m} (did not throw)`); } catch { ok(m); }
}

/* --------------------------- Pattern 1 (substitute-only) ------------------- */

console.log('Pattern 1 — substitute-only:');

{
  const result = adjustSubstituteOnly({
    raw: 0.05,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: 0.07,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib median',
    insufficientDataMessage: 'no data',
  });
  assertEqual(result.raw, 0.05, 'non-null raw passes through (raw)');
  assertEqual(result.adjusted, 0.05, 'non-null raw passes through (adjusted)');
  assertEqual(result.source, 'T12_ACTUAL', 'source preserved');
  assertEqual(result.adjustments.length, 0, 'no adjustments when raw is non-null');
}

{
  const result = adjustSubstituteOnly({
    raw: null,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: 0.07,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'library median for asset type',
    insufficientDataMessage: 'no data',
  });
  assertEqual(result.raw, null, 'raw=null preserved on output');
  assertEqual(result.adjusted, 0.07, 'adjusted = substitution value');
  assertEqual(result.source, 'MANUAL', 'source falls back to MANUAL on substitution');
  assertEqual(result.adjustments.length, 1, 'one substitution adjustment fired');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', 'substitution ruleId');
  assertEqual(result.adjustments[0]?.delta ?? 0, 0.07, 'substitution delta = substituted value');
  assertEqual(result.adjustments[0]?.reason ?? '', 'library median for asset type', 'substitution reason');
}

{
  // Both raw and substitution null → throws (architecture §8: no silent zero coercion)
  assertThrows(
    () => adjustSubstituteOnly({
      raw: null,
      extractionSource: 'T12_ACTUAL',
      substitutionValue: null,
      substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
      substitutionReason: 'lib median',
      insufficientDataMessage: 'JE_VACANCY_SUBSTITUTION_IMPOSSIBLE',
    }),
    'null raw + null substitution → throws',
  );
}

{
  // raw = 0 (a real zero, not null) — passes through, NOT treated as missing
  const result = adjustSubstituteOnly({
    raw: 0,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: 0.05,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib median',
    insufficientDataMessage: 'no data',
  });
  assertEqual(result.raw, 0, 'raw=0 (real zero) preserved');
  assertEqual(result.adjusted, 0, 'adjusted=0 (no substitution)');
  assertEqual(result.adjustments.length, 0, 'zero raw is NOT treated as missing');
}

/* --------------------------- Pattern 2 (substitute + floor) ---------------- */

console.log('\nPattern 2 — substitute + floor:');

{
  // raw above both floors → no normalization
  const result = adjustWithFloor({
    raw: 0.10,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: 0.07,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.05,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib floor',
    bankFloor: 0.06,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank floor',
  });
  assertEqual(result.adjusted, 0.10, 'raw above both floors → no normalization');
  assertEqual(result.adjustments.length, 0, 'no adjustment fired');
}

{
  // raw below library floor; library > bank → raise to library
  const result = adjustWithFloor({
    raw: 0.03,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: null,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.07,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib median',
    bankFloor: 0.05,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank',
  });
  assertEqual(result.adjusted, 0.07, 'raised to library floor (library > bank)');
  assertEqual(result.adjustments.length, 1, 'one floor adjustment fired');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', 'library rule fired');
  assertClose(result.adjustments[0]?.delta ?? 0, 0.04, 1e-9, 'delta = floor - raw = 0.04');
}

{
  // raw below both floors; bank > library → raise to bank
  const result = adjustWithFloor({
    raw: 0.02,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: null,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.05,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib',
    bankFloor: 0.08,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank vacancy from sellerUw',
  });
  assertEqual(result.adjusted, 0.08, 'raised to bank floor (bank > library)');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_BANK', 'bank rule fired');
}

{
  // null raw → substitute, then check floor
  const result = adjustWithFloor({
    raw: null,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: 0.04,                                 // low substitution
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib substitution',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.06,                                      // higher floor
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib floor',
    bankFloor: null,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank',
  });
  assertEqual(result.adjusted, 0.06, 'substituted then raised to library floor');
  assertEqual(result.adjustments.length, 2, 'two adjustments: substitution + floor');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', 'substitution first');
  assertEqual(result.adjustments[1]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', 'floor second');
}

{
  // Both floors null → no normalization
  const result = adjustWithFloor({
    raw: 0.01,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: null,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
    libraryFloor: null,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib',
    bankFloor: null,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank',
  });
  assertEqual(result.adjusted, 0.01, 'no floors → no normalization');
  assertEqual(result.adjustments.length, 0, 'no floor adjustment');
}

{
  // raw EQUAL to floor → no normalization (not <)
  const result = adjustWithFloor({
    raw: 0.05,
    extractionSource: 'T12_ACTUAL',
    substitutionValue: null,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.05,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'lib',
    bankFloor: null,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank',
  });
  assertEqual(result.adjusted, 0.05, 'raw equal to floor → no change');
  assertEqual(result.adjustments.length, 0, 'no adjustment when raw equals floor');
}

/* --------------------------- Pattern 4 (derived) -------------------------- */

console.log('\nPattern 4 — derived:');

{
  const result = buildDerivedLineItem({
    rawFromExtraction: 950_000,
    extractionSource: 'T12_ACTUAL',
    computedAdjusted: 920_000,
  });
  assertEqual(result.raw, 950_000, 'raw from extraction preserved');
  assertEqual(result.adjusted, 920_000, 'adjusted = computed value');
  assertEqual(result.source, 'T12_ACTUAL', 'source preserved when raw available');
  assertEqual(result.adjustments.length, 0, 'no adjustments on derived item');
}

{
  const result = buildDerivedLineItem({
    rawFromExtraction: null,
    extractionSource: 'T12_ACTUAL',
    computedAdjusted: 920_000,
  });
  assertEqual(result.raw, null, 'raw=null preserved');
  assertEqual(result.source, 'MANUAL', 'source falls back to MANUAL when raw was null');
}

/* --------------------------- Pattern 3 canonical (requireRaw) ------------- */

console.log('\nrequireRaw — Pattern 3 (no substitution path):');

{
  const result = requireRaw({
    raw: 50_000_000,
    extractionSource: 'BANK',
    insufficientDataMessage: 'JE_LOAN_AMOUNT_MISSING',
  });
  assertEqual(result.raw, 50_000_000, 'raw preserved');
  assertEqual(result.adjusted, 50_000_000, 'adjusted = raw');
  assertEqual(result.source, 'BANK', 'source preserved');
  assertEqual(result.adjustments.length, 0, 'no adjustments fire');
}
{
  assertThrows(
    () => requireRaw({
      raw: null,
      extractionSource: 'BANK',
      insufficientDataMessage: 'JE_LOAN_AMOUNT_MISSING',
    }),
    'null raw throws with the message',
  );
}
{
  // raw=0 is a real zero, not null — passes through
  const result = requireRaw({
    raw: 0,
    extractionSource: 'BANK',
    insufficientDataMessage: 'should not fire',
  });
  assertEqual(result.raw, 0, 'raw=0 (real zero) preserved');
  assertEqual(result.adjusted, 0, 'adjusted=0');
}

/* --------------------------- Pattern 5 (not applicable) ------------------- */

console.log('\nPattern 5 — not applicable:');

{
  const result = buildNotApplicableLineItem();
  assertEqual(result.raw, null, 'raw=null');
  assertEqual(result.adjusted, 0, 'adjusted=0 (real zero, not substituted)');
  assertEqual(result.source, 'MANUAL', 'source=MANUAL');
  assertEqual(result.adjustments.length, 0, 'no adjustments');
}

/* --------------------------- Distrust-penalty wrapper --------------------- */

console.log('\nDistrust-penalty wrapper:');

{
  const initial = adjustSubstituteOnly({
    raw: 1_000_000,
    extractionSource: 'SELLER_UW',
    substitutionValue: null,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: '',
    insufficientDataMessage: 'no data',
  });
  const penalized = withDistrustPenalty(initial, {
    distrustRuleId: 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS',
    reason: 'T-12 was available but seller UW was used',
  });
  assertEqual(penalized.adjusted, 1_000_000, 'value unchanged by penalty');
  assertEqual(penalized.source, 'SELLER_UW', 'source unchanged');
  assertEqual(penalized.adjustments.length, 1, 'one penalty adjustment');
  assertEqual(penalized.adjustments[0]?.ruleId ?? '', 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS', 'distrust ruleId');
  assertEqual(penalized.adjustments[0]?.delta ?? 1, 0, 'distrust delta is 0 (informational)');
}

{
  // Idempotency — applying the same distrust rule twice doesn't double-add
  const initial = buildNotApplicableLineItem();
  const once = withDistrustPenalty(initial, {
    distrustRuleId: 'JE_ASR_USED_WHEN_PRIMARY_EXISTS',
    reason: 'r',
  });
  const twice = withDistrustPenalty(once, {
    distrustRuleId: 'JE_ASR_USED_WHEN_PRIMARY_EXISTS',
    reason: 'r',
  });
  assertEqual(twice.adjustments.length, 1, 'duplicate distrust does not double-add');
}

{
  // Distrust on top of an already-substituted item
  const subbed = adjustSubstituteOnly({
    raw: null,
    extractionSource: 'ASR',
    substitutionValue: 0.07,
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib',
    insufficientDataMessage: 'no data',
  });
  const penalized = withDistrustPenalty(subbed, {
    distrustRuleId: 'JE_ASR_USED_WHEN_PRIMARY_EXISTS',
    reason: 'appraisal preferred',
  });
  assertEqual(penalized.adjustments.length, 2, 'two adjustments: substitution + distrust');
  assertEqual(penalized.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', 'substitution first');
  assertEqual(penalized.adjustments[1]?.ruleId ?? '', 'JE_ASR_USED_WHEN_PRIMARY_EXISTS', 'distrust second');
}

/* --------------------------- Composition correctness ---------------------- */

console.log('\nAdjustment ordering (substitution → floor → distrust):');

{
  const subbed = adjustWithFloor({
    raw: null,
    extractionSource: 'SELLER_UW',
    substitutionValue: 0.04,                                 // below library floor
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    substitutionReason: 'lib substitution',
    insufficientDataMessage: 'no data',
    libraryFloor: 0.06,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: 'library median',
    bankFloor: null,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: 'bank',
  });
  const final = withDistrustPenalty(subbed, {
    distrustRuleId: 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS',
    reason: 'distrust',
  });
  assertEqual(final.adjustments.length, 3, 'three adjustments in firing order');
  assertEqual(final.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', '[0] substitution');
  assertEqual(final.adjustments[1]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', '[1] floor');
  assertEqual(final.adjustments[2]?.ruleId ?? '', 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS', '[2] distrust');
  assertEqual(final.adjusted, 0.06, 'final adjusted is the floor value');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
