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
  /**
   * Operating-side replacement reserves slot. KEPT AT 0 BY DESIGN for the
   * NOI tie-out — the new-spine engine treats reserves as below-NOI / capital
   * (they don't enter `metrics.netOperatingIncome`). If you need the real
   * reserve value, read `AdjustedInputs.capitalReserves.monthlyReplacementReserves.adjusted`
   * (monthly $; multiply by 12 for annual). The render-schema's P38
   * Replacement Reserves cell sources from there, not from this field.
   */
  replacementReserves: AdjustedLineItem;
  totalExpenses: AdjustedLineItem;
}

/**
 * Capital reserves (below-NOI / capital).
 *
 * The new-spine judgment engine treats these as separate from operating
 * expenses — they don't enter the NOI build-up. Surfaced on the @cre/shared
 * projection so the populated workbook can show real reserve values without
 * breaking the NOI tie-out that `AdjustedExpenses.replacementReserves`
 * preserves (which stays zero by design).
 *
 * Source: the rich `@cre/contracts.AdjustedCapitalReserves` produced by the
 * new-spine engine. The adapter `analysis-to-adjusted-inputs.adapter.ts`
 * projects from the legacy `UnderwritingModel.capitalReserves` slot (filled
 * in by `synthesize-uw-model-from-graph.ts` at synthesis time); legacy
 * non-promoted analyses without graph state surface an all-zeros default
 * marked `source: 'missing-data-penalty'`.
 *
 * Unit convention: ALL `monthly*` fields are MONTHLY dollars (multiply by 12
 * for annual). `upfront*` and `pcaImmediateRepairs` are dollar TOTALS
 * (closing-time cash reserves; not annualized).
 */
export interface AdjustedCapitalReserves {
  monthlyReplacementReserves: AdjustedLineItem;
  monthlyTenantImprovements: AdjustedLineItem;
  monthlyLeasingCommissions: AdjustedLineItem;
  monthlyCapex: AdjustedLineItem;
  upfrontReplacementReserves: AdjustedLineItem;
  upfrontTiLc: AdjustedLineItem;
  pcaImmediateRepairs: AdjustedLineItem;
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
  /**
   * Operator-/extraction-supplied concluded value. Distinct from `impliedValue`
   * (engine value = NOI / capRate); `value` carries the persisted concluded
   * valuation surfaced through the producer pipeline (operator-supplied BOV
   * on Sunroad, appraisal-derived on appraised deals). Aligns the shared type
   * with `@cre/contracts.AdjustedMetrics.value` — the runtime payload has
   * always carried this field; the shared type just hadn't surfaced it.
   */
  value: number | null;
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
  /**
   * Below-NOI / capital reserves. Surfaced separately from `expenses` so
   * the NOI tie-out (`metrics.netOperatingIncome === EGI - totalExpenses`)
   * is preserved. See `AdjustedCapitalReserves` JSDoc for unit conventions.
   *
   * Adapter contract: legacy analyses without graph state emit an
   * all-zeros default with `source: 'missing-data-penalty'` on each
   * line item — never undefined. Selectors can read this field
   * unconditionally.
   */
  capitalReserves: AdjustedCapitalReserves;
  loan: AdjustedLoan;
  metrics: AdjustedMetrics;
  /** Append-only ledger of every change applied by the judgment engine. */
  adjustments: AdjustmentEntry[];
  /** 0..1 — confidence reduction applied due to missing inputs / penalties. */
  confidenceReduction: number;
  /**
   * Display-only assumptions threaded from the graph AdjustedInputs
   * (@cre/contracts). The VALUE already flows to the render via the projection
   * (build-underwriting-context-projection passes `graph.adjustedInputs`); this
   * optional field exists so the render schema's leasing selectors type-check.
   * Leasing assumptions are display-only (workbook top-block) and are NOT read
   * by scoring. Optional/nullable for back-compat with legacy adapters.
   */
  assumptions?: { leasing?: AdjustedLeasingAssumptionsView | null } | null;
}

/**
 * Display-only leasing assumptions surfaced for the render — a local mirror of
 * the @cre/contracts `AdjustedLeasingAssumptions` (shared cannot import from
 * contracts). All nullable; honest-blank when the appraisal didn't conclude one.
 * Market rent is annual $/SF; term is years.
 */
export interface AdjustedLeasingAssumptionsView {
  tiNewPsf: number | null;
  tiRenewPsf: number | null;
  marketRentPsf: number | null;
  downtimeMonths: number | null;
  leaseTermYears: number | null;
}
