// Pure helpers for the v1 underwriting edit affordance (issue #20 / step 8.8).
//
// Bridges the impedance mismatch between the wire contract (backend units:
// decimals for percentages, months for term/amortization) and analyst-natural
// UI units (% for percentages, years for term/amortization). All conversion
// logic lives here so RenderedAnalysisView stays focused on layout.

/**
 * 20 editable paths on the backend's `AdjustedInputs`. Mirrors the whitelist
 * in `apps/api/src/services/apply-revision-delta.ts`. Kept in sync manually for
 * now; if either side widens the editable surface, both must update. (A future
 * follow-up could move this list into `@cre/contracts` as a shared constant.)
 *
 * History: 16 paths shipped in 8.8 (income / expenses / loan); 4 assumptions
 * paths added in render version 7.3 (#24).
 */
export const EDITABLE_PATHS: readonly string[] = [
  'income.grossRentalIncome.adjusted',
  'income.otherIncome.adjusted',
  'income.vacancyPct.adjusted',
  'income.concessionsPct.adjusted',
  'expenses.realEstateTaxes.adjusted',
  'expenses.insurance.adjusted',
  'expenses.utilities.adjusted',
  'expenses.managementFee.adjusted',
  'expenses.payroll.adjusted',
  'expenses.maintenance.adjusted',
  'expenses.other.adjusted',
  'loan.loanAmount.adjusted',
  'loan.interestRate.adjusted',
  'loan.termMonths.adjusted',
  'loan.amortizationMonths.adjusted',
  'loan.ioPeriodMonths.adjusted',
  'assumptions.capRate.adjusted',
  'assumptions.terminalCapRate.adjusted',
  // §14.3 Decision 3 + Delta X: nullable parent on AdjustedAssumptions;
  // backend setByPath auto-constructs the parent on first analyst write.
  'assumptions.concludedCapRate.adjusted',
  'assumptions.rentGrowthPct.adjusted',
  'assumptions.expenseGrowthPct.adjusted',
];

const EDITABLE_PATH_SET = new Set(EDITABLE_PATHS);

export function isEditablePath(path: string): boolean {
  return EDITABLE_PATH_SET.has(path);
}

/**
 * Input-type classifier per path. Drives input formatting + (future) validation.
 * Currency: dollar values (no conversion).
 * Percent: backend stores 0..1 decimals; UI shows 0..100 percent.
 * Years: backend stores months; UI shows years (× 12 conversion).
 * Months: backend stores months; UI shows months (no conversion).
 */
export type InputType = 'currency' | 'percent' | 'years' | 'months';

const PERCENT_PATHS = new Set<string>([
  'income.vacancyPct.adjusted',
  'income.concessionsPct.adjusted',
  'loan.interestRate.adjusted',
  'assumptions.capRate.adjusted',
  'assumptions.terminalCapRate.adjusted',
  'assumptions.concludedCapRate.adjusted',   // §14.3 Decision 3 — 0..1 fraction
  'assumptions.rentGrowthPct.adjusted',
  'assumptions.expenseGrowthPct.adjusted',
]);
const YEARS_PATHS = new Set<string>([
  'loan.termMonths.adjusted',
  'loan.amortizationMonths.adjusted',
]);
const MONTHS_PATHS = new Set<string>([
  'loan.ioPeriodMonths.adjusted',
]);

export function pathInputType(path: string): InputType {
  if (PERCENT_PATHS.has(path)) return 'percent';
  if (YEARS_PATHS.has(path)) return 'years';
  if (MONTHS_PATHS.has(path)) return 'months';
  return 'currency';
}

/** Backend value (decimal / months) → UI input value (percent / years / months / dollars). */
export function pathToUiUnit(path: string, backendValue: number): number {
  switch (pathInputType(path)) {
    case 'percent': return backendValue * 100;
    case 'years':   return backendValue / 12;
    case 'months':  return backendValue;
    case 'currency': return backendValue;
  }
}

/** UI input value → backend value. Inverse of pathToUiUnit. */
export function uiUnitToBackend(path: string, uiValue: number): number {
  switch (pathInputType(path)) {
    case 'percent': return uiValue / 100;
    case 'years':   return uiValue * 12;
    case 'months':  return uiValue;
    case 'currency': return uiValue;
  }
}

/** Suffix used next to input labels to disambiguate units, e.g., "Vacancy (%)". */
export function pathUnitLabel(path: string): string {
  switch (pathInputType(path)) {
    case 'percent': return '%';
    case 'years':   return 'years';
    case 'months':  return 'months';
    case 'currency': return '$';
  }
}

/**
 * Reasonable step value for the input control. Currency: $1k. Percent: 0.1%
 * (so an analyst typing 7.5% can land on it without arrow-key precision pain).
 * Years/months: 1.
 */
export function pathInputStep(path: string): number {
  switch (pathInputType(path)) {
    case 'percent': return 0.1;
    case 'years':   return 1;
    case 'months':  return 1;
    case 'currency': return 1000;
  }
}

/**
 * Construct the backend path for a line item rendered in a given section.
 * Income / expenses sections render arrays of RenderedLineItem; each item's
 * `name` field matches the AdjustedInputs key. Loan and assumptions sections
 * render hand-assembled arrays from named structs; each line.name also matches
 * the AdjustedInputs key. So the path is just `${section}.${line.name}.adjusted`.
 */
export function buildPath(
  section: 'income' | 'expenses' | 'loan' | 'assumptions',
  lineName: string,
): string {
  return `${section}.${lineName}.adjusted`;
}
