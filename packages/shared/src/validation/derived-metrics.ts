import type { UnderwritingInput } from './uw-input.schema';
import {
  impliedValuePrimitive,
  ltvPrimitive,
  debtYieldPrimitive,
  dscrPrimitive,
} from './metric-primitives';

/**
 * Derived-metric output. Every field is `number | null` — never NaN, never
 * Infinity. A null means "an input was missing or non-finite"; the consumer
 * must treat null as "not computed", not as zero.
 *
 * Units: cap_rate, ltv, debt_yield are decimal fractions; dscr is a multiple.
 */
export interface DerivedMetrics {
  implied_value: number | null;
  dscr: number | null;
  ltv: number | null;
  debt_yield: number | null;
}

/**
 * Compute derived metrics under the contract's gating rules. ALL formulas are
 * delegated to `metric-primitives` — no formula logic lives here. This module
 * only handles input destructuring and the validation envelope.
 */
export function computeDerivedMetrics(input: UnderwritingInput): DerivedMetrics {
  const noi = input.noi.value;
  const loanAmount = input.loan_amount.value;
  const capRate = input.cap_rate.value;
  const debtService = input.debt_service?.value;

  const implied_value = impliedValuePrimitive(noi, capRate);
  const ltv = implied_value === null ? null : ltvPrimitive(loanAmount, implied_value);
  const debt_yield = debtYieldPrimitive(noi, loanAmount);
  const dscr = debtService === undefined ? null : dscrPrimitive(noi, debtService);

  return { implied_value, ltv, debt_yield, dscr };
}
