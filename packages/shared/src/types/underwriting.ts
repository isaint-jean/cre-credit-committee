export interface LineItem {
  id: string;
  label: string;
  annualAmount: number;
  perUnit?: number;
  perSqFt?: number;
  percentOfEGI?: number;
  isEditable: boolean;
  isOverridden: boolean;
  originalValue: number;
  source?: {
    page: number;
    sectionId: string;
  };
}

export interface IncomeSection {
  grossPotentialRent: LineItem;
  vacancyLoss: LineItem;
  concessions: LineItem;
  otherIncome: LineItem;
  effectiveGrossIncome: LineItem;
  additionalItems: LineItem[];
}

export interface ExpenseSection {
  realEstateTaxes: LineItem;
  insurance: LineItem;
  utilities: LineItem;
  repairsAndMaintenance: LineItem;
  management: LineItem;
  generalAndAdmin: LineItem;
  payroll: LineItem;
  replacementReserves: LineItem;
  totalExpenses: LineItem;
  additionalItems: LineItem[];
}

export type RateType = 'fixed' | 'floating';
export type PaymentFrequency = 'monthly' | 'quarterly';

export interface LoanDetails {
  loanAmount: number;
  interestRate: number;
  rateType: RateType;
  ioMonths: number;           // Interest-only period in months (0 = fully amortizing from day 1)
  amortizationMonths: number; // Amortization period in months (e.g. 360 = 30-year amort)
  termMonths: number;         // Total loan term in months (e.g. 60 = 5-year paper, 120 = 10-year)
  paymentFrequency: PaymentFrequency;
  prepaymentTerms: string;    // e.g. "Defeasance", "Yield Maintenance", "3-2-1 Step-Down"
  originationDate: string;    // ISO date — defaults to today
}

export interface RepaymentScheduleEntry {
  month: number;              // 1-indexed month of the loan
  date: string;               // ISO date for this payment
  isIO: boolean;              // true if within IO period
  beginningBalance: number;
  scheduledPrincipal: number;
  interest: number;
  totalPayment: number;
  endingBalance: number;
  cumulativePrincipal: number;
  monthlyDSCR: number | null; // null when payment is 0 / not computable
}

export interface RepaymentSchedule {
  entries: RepaymentScheduleEntry[];
  summary: {
    totalInterest: number;
    totalPrincipal: number;
    totalPayments: number;
    balloonBalance: number;       // Remaining balance at maturity
    balloonDate: string;          // ISO date of maturity/balloon
    ioEndDate: string;            // ISO date when IO period ends
    // DSCR fields are nullable: null = not computable from current inputs.
    averageDSCR: number | null;
    minDSCR: number | null;
    minDSCRMonth: number | null;
  };
}

export interface UnderwritingModel {
  income: IncomeSection;
  expenses: ExpenseSection;
  netOperatingIncome: number;
  capRate: number;
  // Derived fields are nullable: null means "not computable from current
  // inputs" (per validation contract — never coerce missing into 0).
  impliedValue: number | null;
  loanAmount: number;
  interestRate: number;
  amortizationYears: number;
  termYears: number;
  annualDebtService: number | null;
  dscr: number | null;
  ltv: number | null;
  debtYield: number | null;
  totalUnits?: number;
  totalSqFt?: number;
  asReported: boolean;
  modifiedCells: string[];
  loanDetails: LoanDetails;
  repaymentSchedule: RepaymentSchedule | null;
}
