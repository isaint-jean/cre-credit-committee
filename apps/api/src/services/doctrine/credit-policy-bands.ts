/**
 * Credit-policy band thresholds + classifiers (Batch 6 sub-batch 6.1).
 *
 * Single-source-of-truth for the per-metric display bands previously hard-coded
 * in the web client. Per architecture decision D6 (locked 2026-05-08), all UI
 * credit-policy thresholds lift to doctrine in a single sub-batch — the doctrine
 * layer is the sole authority. The web client consumes the band names as
 * opaque labels; it does NOT compute them.
 *
 * Behavioral parity with the legacy UI is the binding constraint
 * (constraint #5 of the 6.1 directive). Each constant below is the EXACT value
 * previously embedded in `apps/web/src/app/analysis/[id]/page.tsx` at the cited
 * line. Boundary semantics (strict `<` vs `<=`) are preserved as-is.
 *
 * Provenance comments name (a) the source line in the pre-6.1 page.tsx and
 * (b) the credit-policy meaning. Any future threshold change requires:
 *   - named rationale in this file
 *   - before/after example committed to the parity-note log
 *   - synthetic-fixture update under apps/api/fixtures/stabilized/
 *     (per D1 binding requirement, when the corpus is seeded)
 *
 * No null coercion. No asset-class branching (constraint #4). Inputs that are
 * `null` produce `null` band — degraded state surfaces, never silently
 * collapses to a green band.
 */

/* ----------------------------- public types ------------------------------ */

/**
 * MetricBand — a 4-state classification consumed by the UI for badge / cell
 * coloring. The semantics intentionally mirror the legacy UI's three-tier
 * scheme PLUS an explicit `null` for the "metric not computable" case.
 */
export type MetricBand = 'safe' | 'warning' | 'danger' | null;

/**
 * StressBreached — per-cell pass/fail for a stress-test scenario row. The
 * legacy UI computed this inline per-cell; this type captures the same
 * boolean classification.
 */
export type StressBreached = boolean | null;

/* ------------------------- threshold constants --------------------------- */

/**
 * DSCR thresholds.
 *
 * Provenance: page.tsx:876 (pre-6.1).
 *   `uw.dscr < 1.25 ? 'danger' : uw.dscr < 1.5 ? 'warning' : 'safe'`
 *
 * Credit-policy meaning:
 *   - DSCR < 1.25 → covenant-grade concern; danger.
 *   - 1.25 ≤ DSCR < 1.50 → adequate but inside watchlist territory; warning.
 *   - DSCR ≥ 1.50 → strong cash-flow coverage; safe.
 */
export const DSCR_THRESHOLDS = Object.freeze({
  dangerBelow: 1.25,
  warningBelow: 1.5,
});

/**
 * LTV thresholds.
 *
 * Provenance: page.tsx:878 (pre-6.1).
 *   `uw.ltv > 0.75 ? 'danger' : uw.ltv > 0.65 ? 'warning' : 'safe'`
 *
 * Credit-policy meaning:
 *   - LTV > 0.75 → above conservative leverage ceiling; danger.
 *   - 0.65 < LTV ≤ 0.75 → acceptable but elevated; warning.
 *   - LTV ≤ 0.65 → conservative leverage; safe.
 */
export const LTV_THRESHOLDS = Object.freeze({
  dangerAbove: 0.75,
  warningAbove: 0.65,
});

/**
 * Debt-yield thresholds.
 *
 * Provenance: page.tsx:879 (pre-6.1).
 *   `uw.debtYield < 0.08 ? 'danger' : uw.debtYield < 0.10 ? 'warning' : 'safe'`
 */
export const DEBT_YIELD_THRESHOLDS = Object.freeze({
  dangerBelow: 0.08,
  warningBelow: 0.1,
});

/**
 * Balloon-balance thresholds (as a fraction of original loan amount).
 *
 * Provenance: page.tsx:883 (pre-6.1).
 *   `summary.balloonBalance > uw.loanAmount * 0.9 ? 'danger'`
 *   `: summary.balloonBalance > uw.loanAmount * 0.7 ? 'warning' : 'safe'`
 *
 * Credit-policy meaning:
 *   - balloon > 90% of original loan → minimal amortization, refi risk; danger.
 *   - 70% < balloon ≤ 90% → modest amortization; warning.
 *   - balloon ≤ 70% → meaningful amortization; safe.
 */
export const BALLOON_THRESHOLDS = Object.freeze({
  dangerFraction: 0.9,
  warningFraction: 0.7,
});

/**
 * Minimum-monthly-DSCR thresholds (used for both the schedule summary and
 * each per-month entry).
 *
 * Provenance: page.tsx:885, 1057-1061, 1170-1174 (pre-6.1).
 *   `minDSCR < 1.15 ? 'danger' : < 1.25 ? 'warning' : 'safe'`
 *
 * Credit-policy meaning:
 *   - The monthly DSCR can dip below the annualized DSCR during seasonal
 *     periods or after the IO→amortization transition. The minimum across
 *     all months is the binding test for monthly debt-service coverage.
 *   - 1.15 is the typical bank covenant minimum.
 *   - 1.25 is the typical underwriting target.
 */
export const MIN_DSCR_THRESHOLDS = Object.freeze({
  dangerBelow: 1.15,
  warningBelow: 1.25,
});

/**
 * Stress-test pass/fail thresholds.
 *
 * Provenance: page.tsx:929 (DSCR), 933 (LTV), 936 (debt yield) (pre-6.1).
 *   `s.results.dscr < 1.15 → fail`
 *   `s.results.ltv  > 0.80 → fail`
 *   `s.results.debtYield < 0.07 → fail`
 *
 * Credit-policy meaning: under a stressed scenario, these are the
 * minimum/maximum acceptable values. Breach in ANY metric is a per-cell
 * fail (rendered as red text). Note: this is independent of
 * `breaksCovenants` (a scenario-level boolean) — the per-cell flag flags
 * which specific metric breached.
 */
export const STRESS_THRESHOLDS = Object.freeze({
  dscrMinAcceptable: 1.15,
  ltvMaxAcceptable: 0.8,
  debtYieldMinAcceptable: 0.07,
});

/**
 * Category-score tier thresholds (component-level).
 *
 * Provenance: page.tsx:619-622 (pre-6.1).
 *   `cat.score >= 80 ? 'strong' : >= 60 ? 'acceptable' : >= 40 ? 'watchlist' : 'high_risk'`
 *
 * NOTE: these thresholds DIFFER from the overall-score tier thresholds (85/70/50).
 * The category-level thresholds are intentionally coarser-grained — a category
 * can dip into 'watchlist' (40-60) without dragging the overall score below 50.
 */
export const CATEGORY_TIER_THRESHOLDS = Object.freeze({
  strongAtOrAbove: 80,
  acceptableAtOrAbove: 60,
  watchlistAtOrAbove: 40,
});

export type CategoryTier = 'strong' | 'acceptable' | 'watchlist' | 'high_risk';

/* --------------------------- classifier helpers -------------------------- */

function classifyBelow(value: number, dangerBelow: number, warningBelow: number): MetricBand {
  if (value < dangerBelow) return 'danger';
  if (value < warningBelow) return 'warning';
  return 'safe';
}

function classifyAbove(value: number, dangerAbove: number, warningAbove: number): MetricBand {
  if (value > dangerAbove) return 'danger';
  if (value > warningAbove) return 'warning';
  return 'safe';
}

/* -------------------------- per-metric classifiers ----------------------- */

export function classifyDscrBand(dscr: number | null): MetricBand {
  if (dscr === null) return null;
  return classifyBelow(dscr, DSCR_THRESHOLDS.dangerBelow, DSCR_THRESHOLDS.warningBelow);
}

export function classifyLtvBand(ltv: number | null): MetricBand {
  if (ltv === null) return null;
  return classifyAbove(ltv, LTV_THRESHOLDS.dangerAbove, LTV_THRESHOLDS.warningAbove);
}

export function classifyDebtYieldBand(debtYield: number | null): MetricBand {
  if (debtYield === null) return null;
  return classifyBelow(debtYield, DEBT_YIELD_THRESHOLDS.dangerBelow, DEBT_YIELD_THRESHOLDS.warningBelow);
}

/**
 * Balloon band — relative classification: the balloon balance vs the original
 * loan amount.
 *
 * Returns `null` if either input is null OR if loanAmount ≤ 0 (which would
 * produce a meaningless ratio). Degraded-state preservation (R8 / B6).
 */
export function classifyBalloonBand(balloonBalance: number | null, loanAmount: number | null): MetricBand {
  if (balloonBalance === null || loanAmount === null) return null;
  if (loanAmount <= 0) return null;
  if (balloonBalance > loanAmount * BALLOON_THRESHOLDS.dangerFraction) return 'danger';
  if (balloonBalance > loanAmount * BALLOON_THRESHOLDS.warningFraction) return 'warning';
  return 'safe';
}

export function classifyMinDscrBand(minDscr: number | null): MetricBand {
  if (minDscr === null) return null;
  return classifyBelow(minDscr, MIN_DSCR_THRESHOLDS.dangerBelow, MIN_DSCR_THRESHOLDS.warningBelow);
}

/** Per-month monthly DSCR band — same thresholds as the schedule summary's minDSCR. */
export function classifyMonthlyDscrBand(monthlyDscr: number | null): MetricBand {
  return classifyMinDscrBand(monthlyDscr);
}

/* -------------------------- stress per-cell flags ------------------------ */

export function classifyStressDscrBreached(stressedDscr: number | null): StressBreached {
  if (stressedDscr === null) return null;
  return stressedDscr < STRESS_THRESHOLDS.dscrMinAcceptable;
}

export function classifyStressLtvBreached(stressedLtv: number | null): StressBreached {
  if (stressedLtv === null) return null;
  return stressedLtv > STRESS_THRESHOLDS.ltvMaxAcceptable;
}

export function classifyStressDebtYieldBreached(stressedDebtYield: number | null): StressBreached {
  if (stressedDebtYield === null) return null;
  return stressedDebtYield < STRESS_THRESHOLDS.debtYieldMinAcceptable;
}

/* ----------------------------- category tiers ---------------------------- */

export function classifyCategoryTier(categoryScore: number | null): CategoryTier | null {
  if (categoryScore === null) return null;
  if (categoryScore >= CATEGORY_TIER_THRESHOLDS.strongAtOrAbove) return 'strong';
  if (categoryScore >= CATEGORY_TIER_THRESHOLDS.acceptableAtOrAbove) return 'acceptable';
  if (categoryScore >= CATEGORY_TIER_THRESHOLDS.watchlistAtOrAbove) return 'watchlist';
  return 'high_risk';
}

/* --------------------------- exports for tests --------------------------- */

/** Aggregate of all thresholds, frozen, for boot-time logging / display. */
export const CREDIT_POLICY_THRESHOLDS = Object.freeze({
  dscr: DSCR_THRESHOLDS,
  ltv: LTV_THRESHOLDS,
  debtYield: DEBT_YIELD_THRESHOLDS,
  balloon: BALLOON_THRESHOLDS,
  minDscr: MIN_DSCR_THRESHOLDS,
  stress: STRESS_THRESHOLDS,
  categoryTier: CATEGORY_TIER_THRESHOLDS,
});
