import {
  IncomeSection, ExpenseSection, UnderwritingModel, LineItem,
  LoanDetails, RepaymentSchedule, RepaymentScheduleEntry
} from '../types/underwriting';
import {
  impliedValuePrimitive,
  dscrPrimitive,
  ltvPrimitive,
  debtYieldPrimitive,
} from '../validation/metric-primitives';

export function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.annualAmount, 0);
}

export function calculateEGI(income: IncomeSection): number {
  return (
    income.grossPotentialRent.annualAmount +
    income.vacancyLoss.annualAmount + // negative value
    income.concessions.annualAmount + // negative value
    income.otherIncome.annualAmount +
    sumLineItems(income.additionalItems)
  );
}

export function calculateTotalExpenses(expenses: ExpenseSection): number {
  return (
    expenses.realEstateTaxes.annualAmount +
    expenses.insurance.annualAmount +
    expenses.utilities.annualAmount +
    expenses.repairsAndMaintenance.annualAmount +
    expenses.management.annualAmount +
    expenses.generalAndAdmin.annualAmount +
    expenses.payroll.annualAmount +
    expenses.replacementReserves.annualAmount +
    sumLineItems(expenses.additionalItems)
  );
}

export function calculateNOI(egi: number, totalExpenses: number): number {
  return egi - totalExpenses;
}

// All financial-formula logic lives in `validation/metric-primitives`.
// The functions below are THIN WRAPPERS that delegate to those primitives.
// Do NOT inline DSCR/LTV/Implied Value/Debt Yield formulas anywhere else.
//
// Unit conventions (must match primitives):
//   - capRate: decimal fraction (0.045 = 4.5%)
//   - LTV / Debt Yield outputs: decimal fraction (0.75 = 75%)
//   - DSCR: unitless multiple
//   - interestRate (calculateAnnualDebtService): annual percent (e.g. 5.5)

function isValidPositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}
function isValidFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function calculateAnnualDebtService(
  loanAmount: number,
  annualRate: number,
  amortizationYears: number
): number | null {
  if (!isValidPositive(loanAmount) || !isValidPositive(annualRate) || !isValidPositive(amortizationYears)) {
    return null;
  }
  const monthlyRate = annualRate / 100 / 12;
  const totalPayments = amortizationYears * 12;
  const monthlyPayment =
    (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, totalPayments)) /
    (Math.pow(1 + monthlyRate, totalPayments) - 1);
  const result = monthlyPayment * 12;
  return Number.isFinite(result) ? result : null;
}

export function calculateDSCR(noi: number, annualDebtService: number): number | null {
  return dscrPrimitive(noi, annualDebtService);
}

export function calculateImpliedValue(noi: number, capRate: number): number | null {
  return impliedValuePrimitive(noi, capRate);
}

export function calculateLTV(loanAmount: number, value: number): number | null {
  return ltvPrimitive(loanAmount, value);
}

export function calculateDebtYield(noi: number, loanAmount: number): number | null {
  return debtYieldPrimitive(noi, loanAmount);
}

// --- Repayment Schedule ---

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function generateRepaymentSchedule(
  loanDetails: LoanDetails,
  monthlyNOI: number
): RepaymentSchedule | null {
  const {
    loanAmount,
    interestRate,
    ioMonths,
    amortizationMonths,
    termMonths,
    originationDate,
  } = loanDetails;

  // Strict gate: invalid loan inputs → not computable, return null.
  // The old behavior returned a degenerate schedule with 0-valued financial
  // fields, which laundered missing inputs into apparent results.
  if (
    !isValidPositive(loanAmount) ||
    !isValidPositive(interestRate) ||
    !isValidPositive(termMonths) ||
    !isValidFinite(monthlyNOI)
  ) {
    return null;
  }

  const monthlyRate = interestRate / 100 / 12;
  const startDate = new Date(originationDate);

  // Calculate the fully-amortizing monthly P&I payment (used during amort period)
  let amortPayment = 0;
  if (amortizationMonths > 0) {
    amortPayment =
      (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, amortizationMonths)) /
      (Math.pow(1 + monthlyRate, amortizationMonths) - 1);
  }

  const entries: RepaymentScheduleEntry[] = [];
  let balance = loanAmount;
  let cumulativePrincipal = 0;
  let totalInterest = 0;
  let totalPrincipal = 0;
  let totalPayments = 0;
  let minDSCR = Infinity;
  let minDSCRMonth: number | null = null;
  let dscrSum = 0;
  let dscrSampleCount = 0;

  // How many amortizing payments have been made (for correct principal calc after IO)
  let amortPaymentsMade = 0;

  for (let m = 1; m <= termMonths; m++) {
    const date = addMonths(startDate, m);
    const isIO = m <= ioMonths;

    const interest = balance * monthlyRate;
    let principal = 0;
    let payment = 0;

    if (isIO) {
      // Interest-only: pay only interest
      payment = interest;
      principal = 0;
    } else {
      // Amortizing: recalculate payment based on remaining balance and remaining amort months
      const remainingAmortMonths = amortizationMonths - amortPaymentsMade;
      if (remainingAmortMonths > 0) {
        payment =
          (balance * monthlyRate * Math.pow(1 + monthlyRate, remainingAmortMonths)) /
          (Math.pow(1 + monthlyRate, remainingAmortMonths) - 1);
      } else {
        // Fallback: interest-only if no amort months left
        payment = interest;
      }
      principal = payment - interest;
      amortPaymentsMade++;
    }

    balance -= principal;
    if (balance < 0.01) balance = 0; // handle floating-point dust
    cumulativePrincipal += principal;
    totalInterest += interest;
    totalPrincipal += principal;
    totalPayments += payment;

    // null when payment is 0 — DSCR is undefined for a 0-payment month, not 0.
    const monthlyDSCR: number | null = payment > 0 ? monthlyNOI / payment : null;
    if (monthlyDSCR !== null) {
      dscrSum += monthlyDSCR;
      dscrSampleCount++;
      if (monthlyDSCR < minDSCR) {
        minDSCR = monthlyDSCR;
        minDSCRMonth = m;
      }
    }

    entries.push({
      month: m,
      date: date.toISOString().slice(0, 10),
      isIO,
      beginningBalance: balance + principal, // balance before this payment
      scheduledPrincipal: Math.round(principal * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      totalPayment: Math.round(payment * 100) / 100,
      endingBalance: Math.round(balance * 100) / 100,
      cumulativePrincipal: Math.round(cumulativePrincipal * 100) / 100,
      monthlyDSCR: monthlyDSCR === null ? null : Math.round(monthlyDSCR * 100) / 100,
    });
  }

  const ioEndDate = addMonths(startDate, ioMonths);
  const balloonDate = addMonths(startDate, termMonths);

  return {
    entries,
    summary: {
      totalInterest: Math.round(totalInterest * 100) / 100,
      totalPrincipal: Math.round(totalPrincipal * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      balloonBalance: Math.round(balance * 100) / 100,
      balloonDate: balloonDate.toISOString().slice(0, 10),
      ioEndDate: ioEndDate.toISOString().slice(0, 10),
      // null = no DSCR was computable across the schedule (e.g. all-zero payments).
      averageDSCR: dscrSampleCount > 0 ? Math.round((dscrSum / dscrSampleCount) * 100) / 100 : null,
      minDSCR: dscrSampleCount > 0 ? Math.round(minDSCR * 100) / 100 : null,
      minDSCRMonth,
    },
  };
}

export function recalculateFullModel(model: UnderwritingModel): UnderwritingModel {
  const egi = calculateEGI(model.income);
  const totalExpenses = calculateTotalExpenses(model.expenses);
  const noi = calculateNOI(egi, totalExpenses);
  const impliedValue = calculateImpliedValue(noi, model.capRate);
  const annualDebtService = calculateAnnualDebtService(
    model.loanAmount,
    model.interestRate,
    model.amortizationYears
  );
  // Short-circuit on null inputs — do NOT coerce to 0. null in → null out.
  const dscr = annualDebtService === null ? null : calculateDSCR(noi, annualDebtService);
  const ltv = impliedValue === null ? null : calculateLTV(model.loanAmount, impliedValue);
  const debtYield = calculateDebtYield(noi, model.loanAmount);

  // Update derived line items
  const updatedIncome = {
    ...model.income,
    effectiveGrossIncome: {
      ...model.income.effectiveGrossIncome,
      annualAmount: egi,
    },
  };

  const updatedExpenses = {
    ...model.expenses,
    totalExpenses: {
      ...model.expenses.totalExpenses,
      annualAmount: totalExpenses,
    },
  };

  // Recalculate per-unit / per-sqft if applicable
  if (model.totalUnits && model.totalUnits > 0) {
    updatePerUnit(updatedIncome, updatedExpenses, model.totalUnits);
  }
  if (model.totalSqFt && model.totalSqFt > 0) {
    updatePerSqFt(updatedIncome, updatedExpenses, model.totalSqFt);
  }

  // Update percentOfEGI
  if (egi > 0) {
    updatePercentOfEGI(updatedExpenses, egi);
  }

  // Sync loanDetails with top-level fields (they may have been edited independently)
  const syncedLoanDetails: LoanDetails = {
    ...model.loanDetails,
    loanAmount: model.loanAmount,
    interestRate: model.interestRate,
    amortizationMonths: model.loanDetails
      ? model.loanDetails.amortizationMonths
      : model.amortizationYears * 12,
    termMonths: model.loanDetails
      ? model.loanDetails.termMonths
      : model.termYears * 12,
  };

  // Generate repayment schedule
  const monthlyNOI = noi / 12;
  const repaymentSchedule = generateRepaymentSchedule(syncedLoanDetails, monthlyNOI);

  return {
    ...model,
    income: updatedIncome,
    expenses: updatedExpenses,
    netOperatingIncome: noi,
    impliedValue,
    annualDebtService,
    dscr,
    ltv,
    debtYield,
    loanDetails: syncedLoanDetails,
    repaymentSchedule,
  };
}

function updatePerUnit(income: IncomeSection, expenses: ExpenseSection, units: number) {
  const allIncomeItems = [
    income.grossPotentialRent,
    income.vacancyLoss,
    income.concessions,
    income.otherIncome,
    income.effectiveGrossIncome,
    ...income.additionalItems,
  ];
  const allExpenseItems = [
    expenses.realEstateTaxes,
    expenses.insurance,
    expenses.utilities,
    expenses.repairsAndMaintenance,
    expenses.management,
    expenses.generalAndAdmin,
    expenses.payroll,
    expenses.replacementReserves,
    expenses.totalExpenses,
    ...expenses.additionalItems,
  ];
  [...allIncomeItems, ...allExpenseItems].forEach((item) => {
    item.perUnit = item.annualAmount / units;
  });
}

function updatePerSqFt(income: IncomeSection, expenses: ExpenseSection, sqft: number) {
  const allIncomeItems = [
    income.grossPotentialRent,
    income.vacancyLoss,
    income.concessions,
    income.otherIncome,
    income.effectiveGrossIncome,
    ...income.additionalItems,
  ];
  const allExpenseItems = [
    expenses.realEstateTaxes,
    expenses.insurance,
    expenses.utilities,
    expenses.repairsAndMaintenance,
    expenses.management,
    expenses.generalAndAdmin,
    expenses.payroll,
    expenses.replacementReserves,
    expenses.totalExpenses,
    ...expenses.additionalItems,
  ];
  [...allIncomeItems, ...allExpenseItems].forEach((item) => {
    item.perSqFt = item.annualAmount / sqft;
  });
}

function updatePercentOfEGI(expenses: ExpenseSection, egi: number) {
  const allItems = [
    expenses.realEstateTaxes,
    expenses.insurance,
    expenses.utilities,
    expenses.repairsAndMaintenance,
    expenses.management,
    expenses.generalAndAdmin,
    expenses.payroll,
    expenses.replacementReserves,
    expenses.totalExpenses,
    ...expenses.additionalItems,
  ];
  allItems.forEach((item) => {
    item.percentOfEGI = (item.annualAmount / egi) * 100;
  });
}

export function applyStressToModel(
  model: UnderwritingModel,
  adjustments: {
    vacancyDelta: number;
    rentDelta: number;
    capRateDelta: number;
    interestRateDelta: number;
  }
): UnderwritingModel {
  const stressed = JSON.parse(JSON.stringify(model)) as UnderwritingModel;

  // Apply rent adjustment (percentage change)
  if (adjustments.rentDelta !== 0) {
    const factor = 1 + adjustments.rentDelta / 100;
    stressed.income.grossPotentialRent.annualAmount *= factor;
  }

  // Apply vacancy adjustment (absolute change in percentage points)
  if (adjustments.vacancyDelta !== 0) {
    const currentVacancyRate = Math.abs(stressed.income.vacancyLoss.annualAmount) /
      stressed.income.grossPotentialRent.annualAmount;
    const newVacancyRate = currentVacancyRate + adjustments.vacancyDelta / 100;
    stressed.income.vacancyLoss.annualAmount =
      -Math.abs(stressed.income.grossPotentialRent.annualAmount * newVacancyRate);
  }

  // Apply cap rate adjustment (basis points)
  if (adjustments.capRateDelta !== 0) {
    stressed.capRate += adjustments.capRateDelta;
  }

  // Apply interest rate adjustment (basis points)
  if (adjustments.interestRateDelta !== 0) {
    stressed.interestRate += adjustments.interestRateDelta;
    if (stressed.loanDetails) {
      stressed.loanDetails.interestRate = stressed.interestRate;
    }
  }

  return recalculateFullModel(stressed);
}
