/**
 * Tests for credit-policy band classifiers (Batch 6 sub-batch 6.1).
 *
 *   npm run test:credit-policy-bands
 *
 * Verifies behavioral parity with the legacy UI logic that was lifted from
 * `apps/web/src/app/analysis/[id]/page.tsx` into the doctrine-owned
 * `services/doctrine/credit-policy-bands.ts`. Each test exercises:
 *
 *   - boundary semantics (strict `<` vs `<=`)
 *   - the three normal bands (safe/warning/danger)
 *   - null-fidelity (null in → null out, never silent collapse to 'safe')
 *
 * The threshold constants used here are imported from the module — they are
 * NOT duplicated. If a constant changes, this file shifts with it (caught by
 * the parity-note discipline in D6, not by silent test passing).
 */

import {
  CATEGORY_TIER_THRESHOLDS,
  DSCR_THRESHOLDS,
  LTV_THRESHOLDS,
  DEBT_YIELD_THRESHOLDS,
  BALLOON_THRESHOLDS,
  MIN_DSCR_THRESHOLDS,
  STRESS_THRESHOLDS,
  classifyBalloonBand,
  classifyCategoryTier,
  classifyDebtYieldBand,
  classifyDscrBand,
  classifyLtvBand,
  classifyMinDscrBand,
  classifyMonthlyDscrBand,
  classifyStressDebtYieldBreached,
  classifyStressDscrBreached,
  classifyStressLtvBreached,
} from '../services/doctrine/credit-policy-bands.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* -------------------------------- DSCR ----------------------------------- */

console.log('DSCR band:');
assertEqual(classifyDscrBand(null), null, 'null DSCR → null band');
assertEqual(classifyDscrBand(1.0), 'danger', 'DSCR 1.00 < 1.25 → danger');
assertEqual(classifyDscrBand(1.24), 'danger', 'DSCR 1.24 < 1.25 → danger');
assertEqual(classifyDscrBand(1.25), 'warning', 'DSCR 1.25 boundary → warning (strict <)');
assertEqual(classifyDscrBand(1.40), 'warning', 'DSCR 1.40 → warning');
assertEqual(classifyDscrBand(1.49), 'warning', 'DSCR 1.49 < 1.50 → warning');
assertEqual(classifyDscrBand(1.50), 'safe', 'DSCR 1.50 boundary → safe (strict <)');
assertEqual(classifyDscrBand(2.00), 'safe', 'DSCR 2.00 → safe');
assertEqual(DSCR_THRESHOLDS.dangerBelow, 1.25, 'constant unchanged: dangerBelow 1.25');
assertEqual(DSCR_THRESHOLDS.warningBelow, 1.5, 'constant unchanged: warningBelow 1.5');

/* --------------------------------- LTV ----------------------------------- */

console.log('\nLTV band:');
assertEqual(classifyLtvBand(null), null, 'null LTV → null band');
assertEqual(classifyLtvBand(0.5), 'safe', 'LTV 0.50 ≤ 0.65 → safe');
assertEqual(classifyLtvBand(0.65), 'safe', 'LTV 0.65 boundary → safe (strict >)');
assertEqual(classifyLtvBand(0.66), 'warning', 'LTV 0.66 > 0.65 → warning');
assertEqual(classifyLtvBand(0.70), 'warning', 'LTV 0.70 → warning');
assertEqual(classifyLtvBand(0.75), 'warning', 'LTV 0.75 boundary → warning (strict >)');
assertEqual(classifyLtvBand(0.80), 'danger', 'LTV 0.80 > 0.75 → danger');
assertEqual(LTV_THRESHOLDS.dangerAbove, 0.75, 'constant unchanged: dangerAbove 0.75');
assertEqual(LTV_THRESHOLDS.warningAbove, 0.65, 'constant unchanged: warningAbove 0.65');

/* ----------------------------- debt yield -------------------------------- */

console.log('\nDebt yield band:');
assertEqual(classifyDebtYieldBand(null), null, 'null DY → null band');
assertEqual(classifyDebtYieldBand(0.05), 'danger', 'DY 0.05 < 0.08 → danger');
assertEqual(classifyDebtYieldBand(0.08), 'warning', 'DY 0.08 boundary → warning (strict <)');
assertEqual(classifyDebtYieldBand(0.09), 'warning', 'DY 0.09 → warning');
assertEqual(classifyDebtYieldBand(0.10), 'safe', 'DY 0.10 boundary → safe (strict <)');
assertEqual(classifyDebtYieldBand(0.15), 'safe', 'DY 0.15 → safe');
assertEqual(DEBT_YIELD_THRESHOLDS.dangerBelow, 0.08, 'constant unchanged: dangerBelow 0.08');
assertEqual(DEBT_YIELD_THRESHOLDS.warningBelow, 0.10, 'constant unchanged: warningBelow 0.10');

/* ------------------------------- balloon --------------------------------- */

console.log('\nBalloon band:');
assertEqual(classifyBalloonBand(null, 1_000_000), null, 'null balloon → null band');
assertEqual(classifyBalloonBand(500_000, null), null, 'null loan → null band');
assertEqual(classifyBalloonBand(900_000, 0), null, 'zero loan → null band (degraded)');
assertEqual(classifyBalloonBand(900_000, -100), null, 'negative loan → null band (degraded)');
assertEqual(classifyBalloonBand(500_000, 1_000_000), 'safe', 'balloon 50% of loan → safe');
assertEqual(classifyBalloonBand(700_000, 1_000_000), 'safe', 'balloon 70% boundary → safe (strict >)');
assertEqual(classifyBalloonBand(700_001, 1_000_000), 'warning', 'balloon just above 70% → warning');
assertEqual(classifyBalloonBand(900_000, 1_000_000), 'warning', 'balloon 90% boundary → warning (strict >)');
assertEqual(classifyBalloonBand(900_001, 1_000_000), 'danger', 'balloon just above 90% → danger');
assertEqual(BALLOON_THRESHOLDS.dangerFraction, 0.9, 'constant unchanged: dangerFraction 0.9');
assertEqual(BALLOON_THRESHOLDS.warningFraction, 0.7, 'constant unchanged: warningFraction 0.7');

/* ------------------------------- min DSCR -------------------------------- */

console.log('\nMin DSCR band:');
assertEqual(classifyMinDscrBand(null), null, 'null min DSCR → null band');
assertEqual(classifyMinDscrBand(1.00), 'danger', 'min DSCR 1.00 < 1.15 → danger');
assertEqual(classifyMinDscrBand(1.15), 'warning', 'min DSCR 1.15 boundary → warning (strict <)');
assertEqual(classifyMinDscrBand(1.20), 'warning', 'min DSCR 1.20 → warning');
assertEqual(classifyMinDscrBand(1.25), 'safe', 'min DSCR 1.25 boundary → safe (strict <)');
assertEqual(classifyMinDscrBand(1.40), 'safe', 'min DSCR 1.40 → safe');
assertEqual(MIN_DSCR_THRESHOLDS.dangerBelow, 1.15, 'constant unchanged: dangerBelow 1.15');
assertEqual(MIN_DSCR_THRESHOLDS.warningBelow, 1.25, 'constant unchanged: warningBelow 1.25');

/* ------------------------- monthly DSCR (alias) -------------------------- */

console.log('\nMonthly DSCR band (same thresholds as min DSCR):');
assertEqual(classifyMonthlyDscrBand(1.10), 'danger', 'monthly DSCR 1.10 → danger');
assertEqual(classifyMonthlyDscrBand(1.20), 'warning', 'monthly DSCR 1.20 → warning');
assertEqual(classifyMonthlyDscrBand(1.30), 'safe', 'monthly DSCR 1.30 → safe');
assertEqual(classifyMonthlyDscrBand(null), null, 'null monthly DSCR → null');

/* --------------------------- stress per-cell ---------------------------- */

console.log('\nStress per-cell breach flags:');
// DSCR
assertEqual(classifyStressDscrBreached(null), null, 'null stress DSCR → null');
assertEqual(classifyStressDscrBreached(1.10), true, 'stressed DSCR 1.10 < 1.15 → breached');
assertEqual(classifyStressDscrBreached(1.15), false, 'stressed DSCR 1.15 boundary → not breached (strict <)');
assertEqual(classifyStressDscrBreached(1.20), false, 'stressed DSCR 1.20 → not breached');
// LTV
assertEqual(classifyStressLtvBreached(null), null, 'null stress LTV → null');
assertEqual(classifyStressLtvBreached(0.75), false, 'stressed LTV 0.75 → not breached');
assertEqual(classifyStressLtvBreached(0.80), false, 'stressed LTV 0.80 boundary → not breached (strict >)');
assertEqual(classifyStressLtvBreached(0.81), true, 'stressed LTV 0.81 > 0.80 → breached');
// DY
assertEqual(classifyStressDebtYieldBreached(null), null, 'null stress DY → null');
assertEqual(classifyStressDebtYieldBreached(0.06), true, 'stressed DY 0.06 < 0.07 → breached');
assertEqual(classifyStressDebtYieldBreached(0.07), false, 'stressed DY 0.07 boundary → not breached (strict <)');
assertEqual(classifyStressDebtYieldBreached(0.10), false, 'stressed DY 0.10 → not breached');
// constants
assertEqual(STRESS_THRESHOLDS.dscrMinAcceptable, 1.15, 'constant unchanged: stress DSCR min 1.15');
assertEqual(STRESS_THRESHOLDS.ltvMaxAcceptable, 0.8, 'constant unchanged: stress LTV max 0.80');
assertEqual(STRESS_THRESHOLDS.debtYieldMinAcceptable, 0.07, 'constant unchanged: stress DY min 0.07');

/* -------------------------- category tiers ------------------------------- */

console.log('\nCategory tier:');
assertEqual(classifyCategoryTier(null), null, 'null score → null tier');
assertEqual(classifyCategoryTier(20), 'high_risk', 'score 20 < 40 → high_risk');
assertEqual(classifyCategoryTier(40), 'watchlist', 'score 40 boundary → watchlist (≥)');
assertEqual(classifyCategoryTier(50), 'watchlist', 'score 50 → watchlist');
assertEqual(classifyCategoryTier(60), 'acceptable', 'score 60 boundary → acceptable (≥)');
assertEqual(classifyCategoryTier(75), 'acceptable', 'score 75 → acceptable');
assertEqual(classifyCategoryTier(80), 'strong', 'score 80 boundary → strong (≥)');
assertEqual(classifyCategoryTier(95), 'strong', 'score 95 → strong');
assertEqual(CATEGORY_TIER_THRESHOLDS.strongAtOrAbove, 80, 'constant unchanged: strong ≥ 80');
assertEqual(CATEGORY_TIER_THRESHOLDS.acceptableAtOrAbove, 60, 'constant unchanged: acceptable ≥ 60');
assertEqual(CATEGORY_TIER_THRESHOLDS.watchlistAtOrAbove, 40, 'constant unchanged: watchlist ≥ 40');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
