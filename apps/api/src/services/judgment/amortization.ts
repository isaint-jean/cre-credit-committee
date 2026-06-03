/**
 * Amortization formula helpers for debt-service derivation (Stage 6 metrics).
 *
 * Standard P&I:
 *   monthly = P × r × (1+r)^n / ((1+r)^n - 1)
 * where r = annual rate / 12, n = amortization months.
 *
 * v1.0 simplifications (audit §E.4):
 *   - IO-ONLY loans (`amortizationMonths === 0` / `<= 0`) are CORRECTLY handled now:
 *     `annualDebtService = loanAmount × interestRate`. Interest-only loans are
 *     common in CRE (the entire term pays interest only; principal balloons at
 *     maturity). Previously this branch returned 0, causing DSCR = NOI / 0 = null
 *     for every IO-only deal — the system couldn't underwrite them at all.
 *   - PARTIAL-IO loans (an IO period followed by an amortizing tail, e.g.
 *     `ioMonths > 0` with `amortizationMonths > 0`) are STILL handled by the
 *     amortizing formula below — the IO period is ignored here. For partial-IO
 *     this overstates year-1 debt service (under-DSCR), which is conservative.
 *     v1.1 may produce IO-aware annual schedules that honor the partial-IO
 *     period explicitly.
 *   - Zero interest rate handled (special case: monthly = P/n).
 *   - Zero loan amount → 0 debt service (caller's responsibility to handle
 *     null inputs upstream).
 */

export function annualDebtService(args: {
  readonly loanAmount: number;
  readonly interestRate: number;          // annual fraction (e.g., 0.07 for 7%)
  readonly amortizationMonths: number;
}): number {
  if (args.loanAmount <= 0) return 0;
  if (args.amortizationMonths <= 0) {
    // IO-only loan: debt service = loanAmount × annual rate (interest payments only).
    // Without this branch, the formula below divides by (factor - 1) === 0 — and
    // the prior "return 0" gate silently broke DSCR for every IO-only deal.
    return args.loanAmount * args.interestRate;
  }

  const r = args.interestRate / 12;
  if (r === 0) {
    return (args.loanAmount / args.amortizationMonths) * 12;
  }
  const n = args.amortizationMonths;
  const factor = Math.pow(1 + r, n);
  const monthly = (args.loanAmount * r * factor) / (factor - 1);
  return monthly * 12;
}

/**
 * Remaining principal at month `termMonths` in a fully-amortizing loan.
 * If `termMonths >= amortizationMonths`, returns 0 (loan paid off at maturity).
 *
 * Formula (continuously compounded equivalent for monthly payments):
 *   B(t) = P × (1+r)^t - M × ((1+r)^t - 1) / r
 * where M is the monthly payment, r is monthly rate, t is month count.
 */
export function maturityBalance(args: {
  readonly loanAmount: number;
  readonly interestRate: number;
  readonly amortizationMonths: number;
  readonly termMonths: number;
}): number {
  if (args.loanAmount <= 0) return 0;
  if (args.termMonths >= args.amortizationMonths) return 0;
  if (args.termMonths <= 0) return args.loanAmount;

  const r = args.interestRate / 12;
  if (r === 0) {
    return args.loanAmount * (1 - args.termMonths / args.amortizationMonths);
  }

  const n = args.amortizationMonths;
  const t = args.termMonths;
  const factorN = Math.pow(1 + r, n);
  const factorT = Math.pow(1 + r, t);
  const monthly = (args.loanAmount * r * factorN) / (factorN - 1);
  return args.loanAmount * factorT - (monthly * (factorT - 1)) / r;
}
