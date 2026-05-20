/**
 * AdjustedInputs — the single output contract of the judgment engine.
 *
 * Architecture contract (memory/architecture_contract.md §3, §5):
 *   "All final metrics derive ONLY from adjustedInputs."
 *
 * Producers: applyJudgmentAdjustments() — the only function permitted to set
 * adjusted values. Library baselines, manifesto rules, and missing-data
 * penalties all funnel through this one place.
 *
 * Consumers: any downstream rendering / cross-check / metric computation.
 * Consumers MUST treat this object as read-only and complete.
 *
 * NOTE: This type defines the contract. The pipeline currently returns an
 * `UnderwritingModel` and the bridge `analysis-to-adjusted-inputs.adapter.ts`
 * projects from it. Once `applyJudgmentAdjustments()` lands and the pipeline
 * returns `AdjustedInputs` natively, delete the adapter — render layer needs
 * no other change.
 */
import type { RateType } from './underwriting';

export type AdjustmentSource =
  | 'raw'
  | 'library-baseline'
  | 'manifesto-rule'
  | 'missing-data-penalty'
  | 'override';

export interface AdjustedLineItem {
  /** Value as extracted from the source document (null if missing). NEVER coerced to 0. */
  raw: number | null;
  /** Final value after the judgment engine. Always a number — penalties replace nulls. */
  adjusted: number;
  /** adjusted - (raw ?? 0). Positive means the engine increased the value. */
  delta: number;
  /** Why `adjusted` differs from `raw`. */
  source: AdjustmentSource;
  /** Reference to the rule that drove the adjustment, if any. */
  ruleId?: string;
}

export interface AdjustedIncome {
  grossPotentialRent: AdjustedLineItem;
  vacancyLoss: AdjustedLineItem;
  concessions: AdjustedLineItem;
  otherIncome: AdjustedLineItem;
  effectiveGrossIncome: AdjustedLineItem;
}

export interface AdjustedExpenses {
  realEstateTaxes: AdjustedLineItem;
  insurance: AdjustedLineItem;
  utilities: AdjustedLineItem;
  repairsAndMaintenance: AdjustedLineItem;
  management: AdjustedLineItem;
  generalAndAdmin: AdjustedLineItem;
  payroll: AdjustedLineItem;
  replacementReserves: AdjustedLineItem;
  totalExpenses: AdjustedLineItem;
}

export interface AdjustedLoan {
  loanAmount: number;
  interestRate: number;
  rateType: RateType;
  amortizationMonths: number;
  termMonths: number;
  ioMonths: number;
}

export interface AdjustedMetrics {
  netOperatingIncome: number;
  capRate: number;
  impliedValue: number | null;
  annualDebtService: number | null;
  dscr: number | null;
  ltv: number | null;
  debtYield: number | null;
}

export interface AdjustmentEntry {
  ruleId: string;
  field: string;
  before: number | null;
  after: number;
  reason: string;
  source: AdjustmentSource;
}

export interface AdjustedInputs {
  income: AdjustedIncome;
  expenses: AdjustedExpenses;
  loan: AdjustedLoan;
  metrics: AdjustedMetrics;
  /** Append-only ledger of every change applied by the judgment engine. */
  adjustments: AdjustmentEntry[];
  /** 0..1 — confidence reduction applied due to missing inputs / penalties. */
  confidenceReduction: number;
}
