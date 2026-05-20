/**
 * Date math helpers — small utility for date-derived line items (e.g., `termMonths` from
 * `maturityDate − analysisAsOfDate`).
 *
 * Uses average month length 30.4375 days (mean of 365.25 / 12) for ISO-date deltas. Rounds to
 * the nearest whole month — financial UW conventions don't typically reason in fractional
 * months at this granularity.
 *
 * Returns `null` for invalid inputs (malformed ISO, end ≤ start). Callers route the null path
 * through their normal substitution / throw logic; this helper does not throw.
 */

const AVERAGE_MONTH_MS = 1000 * 60 * 60 * 24 * 30.4375;

export function computeMonthsBetween(fromIso: string, toIso: string): number | null {
  const start = Date.parse(fromIso);
  const end = Date.parse(toIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  if (end <= start) {
    return null;
  }
  return Math.round((end - start) / AVERAGE_MONTH_MS);
}
