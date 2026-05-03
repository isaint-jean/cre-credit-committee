/**
 * SINGLE SOURCE OF TRUTH for derived-metric formulas.
 *
 * Every layer that computes DSCR, LTV, Implied Value, or Debt Yield MUST
 * delegate to these primitives. No layer is permitted to inline the formula.
 *
 * Unit conventions (per system contract):
 *   - cap_rate, ltv, debt_yield: decimal fractions (0–1)
 *   - dscr: unitless multiple (1.25 = 1.25x)
 *   - All inputs must already be normalized; no internal /100 scaling exists.
 *
 * Invalid inputs return null. NaN and Infinity never escape these functions.
 */

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function isPositiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Implied Value = NOI / cap_rate (cap_rate is decimal). */
export function impliedValuePrimitive(noi: number, capRate: number): number | null {
  if (!isFiniteNumber(noi) || !isPositiveFinite(capRate)) return null;
  const v = noi / capRate;
  return Number.isFinite(v) ? v : null;
}

/** DSCR = NOI / annual_debt_service (unitless multiple). */
export function dscrPrimitive(noi: number, debtService: number): number | null {
  if (!isFiniteNumber(noi) || !isPositiveFinite(debtService)) return null;
  const v = noi / debtService;
  return Number.isFinite(v) ? v : null;
}

/** LTV = loan_amount / implied_value (decimal fraction, 0.75 = 75%). */
export function ltvPrimitive(loanAmount: number, impliedValue: number): number | null {
  if (!isPositiveFinite(loanAmount) || !isPositiveFinite(impliedValue)) return null;
  const v = loanAmount / impliedValue;
  return Number.isFinite(v) ? v : null;
}

/** Debt Yield = NOI / loan_amount (decimal fraction, 0.10 = 10%). */
export function debtYieldPrimitive(noi: number, loanAmount: number): number | null {
  if (!isFiniteNumber(noi) || !isPositiveFinite(loanAmount)) return null;
  const v = noi / loanAmount;
  return Number.isFinite(v) ? v : null;
}
