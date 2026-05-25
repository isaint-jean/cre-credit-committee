/**
 * AdjustedInputs — stage-4 producer output (judgment engine), immutable post-stage-4.
 *
 * Architecture contract §3: all final metrics derive ONLY from AdjustedInputs. No parallel
 * computation paths. This is the single source of truth for downstream metrics, cross-check,
 * stress, valuation, and doctrine.
 *
 * Architecture contract §8: missing inputs NEVER default to 0. Each `AdjustedLineItem` records
 * a nullable `raw` (extracted) and a non-null `adjusted` (post-judgment value, where the judgment
 * engine has substituted library-median + missing-data penalty for nulls). Penalty rules are
 * traced through `adjustments[]`.
 *
 * Architecture contract §6: the conservatism gate (stage 5) verifies adjusted vacancy, expense
 * ratio, and NOI against library-and-bank floors before metrics derive. AdjustedInputs is what
 * the gate validates; if it fails, the pipeline aborts with `ConservatismViolationPayload`.
 */

import type {
  AdjustedInputsId,
  LibrarySnapshotId,
} from './identity.js';
import type {
  JudgmentEngineVersion,
  ISODateTime,
} from './versioning.js';
import type { SourceTier } from './source-tier.js';
import type { JudgmentEngineRuleId } from './judgment-engine-rules.js';
import type { CreditManifestoRuleId } from './manifesto.js';

/**
 * One adjustment ledger entry attached to an `AdjustedLineItem`. Records which rule changed the
 * value and by how much. Doctrine §1 distrust penalties read from the aggregated ledger to score
 * `data_confidence` — they MUST NOT independently re-walk documents.
 *
 * `ruleId` accepts both judgment-engine rules (frozen literal union) and manifesto rules
 * (branded user-configurable string). Each fires under its own registry, but both route through
 * the same ledger.
 */
export interface AdjustmentEntry {
  readonly ruleId: JudgmentEngineRuleId | CreditManifestoRuleId;
  readonly delta: number;            // signed; effect on `adjusted` relative to `raw`
  readonly reason: string;           // bounded by per-registry reason catalogue
}

/**
 * Four-field shape: raw extraction (nullable), adjusted post-judgment value (always a number;
 * penalty replaces null), source tier the judgment engine selected, and the adjustments ledger.
 *
 * Invariant: if `raw === null`, then `adjustments` MUST contain at least one entry whose ruleId
 * is the missing-data penalty rule. The judgment engine never silently substitutes for null.
 */
export interface AdjustedLineItem {
  readonly raw: number | null;
  readonly adjusted: number;
  readonly source: SourceTier;
  readonly adjustments: readonly AdjustmentEntry[];
}

export interface AdjustedIncome {
  readonly grossRentalIncome: AdjustedLineItem;
  readonly otherIncome: AdjustedLineItem;
  readonly vacancyPct: AdjustedLineItem;            // 0..1; doctrine §6 reads .raw vs trailing
  readonly concessionsPct: AdjustedLineItem;
  readonly effectiveGrossIncome: AdjustedLineItem;
}

export interface AdjustedExpenses {
  readonly realEstateTaxes: AdjustedLineItem;
  readonly insurance: AdjustedLineItem;
  readonly utilities: AdjustedLineItem;
  readonly managementFee: AdjustedLineItem;
  readonly payroll: AdjustedLineItem;
  readonly maintenance: AdjustedLineItem;
  readonly other: AdjustedLineItem;
  readonly generalAndAdmin: AdjustedLineItem;
  readonly janitorial: AdjustedLineItem;
  /**
   * Tenant expense recoveries (CAM, tax recoveries, etc.). Semantically a REVENUE
   * offset to operating expenses, not an expense per se. Placed here to match the
   * source cash flow statement layout; consumers that sum AdjustedExpenses fields
   * for `totalOperatingExpenses` must SUBTRACT this field, not add it.
   */
  readonly reimbursements: AdjustedLineItem;
  readonly totalOperatingExpenses: AdjustedLineItem;
}

export interface AdjustedCapitalReserves {
  /**
   * Closing-time reserve sized against the PCA's IMMEDIATE REPAIRS line items
   * (Table 1). Doctrine's `scoreCapitalization` reads this directly via
   * `scorePcaCoverage(pcaImmediateRepairs.raw, upfrontCapex.adjusted)` — the
   * ratio scores whether the bank's closing reserve adequately covers the
   * PCA-identified immediate repair cost. Source: 'PCA' (from
   * `extraction.pca.immediateRepairs`). Conceptually paired with
   * `upfrontReplacementReserves` below — the two carry DIFFERENT semantics
   * and MUST NOT be conflated (per Step 5 design recon: rewiring
   * upfrontCapex to a long-term-capex source would silently break
   * scorePcaCoverage's risk detection).
   */
  readonly upfrontCapex: AdjustedLineItem;

  /**
   * Closing-time reserve for LONG-TERM replacement capex over the PCA's
   * evaluation period (Table 2). Distinct concept from `upfrontCapex` above
   * (which is sized for immediate-repair coverage). Maps to the populator's
   * cell E49 "Replacement Reserves — Up Front". Source: 'PCA' (derived as
   * `sum(extraction.pca.capexScheduleInflated)` when present); 'MANUAL' with
   * `JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED` emission otherwise. Doctrine
   * does NOT currently consume this field; it exists for populator wiring +
   * future asset-class doctrine that may want a long-term-reserve coverage
   * check.
   */
  readonly upfrontReplacementReserves: AdjustedLineItem;

  readonly upfrontTiLc: AdjustedLineItem;
  readonly monthlyCapex: AdjustedLineItem;
  /**
   * Sum of monthlyTenantImprovements + monthlyLeasingCommissions. Derived field
   * — populated by the orchestrator after the two split projection builders run.
   * Retained as a separate field for downstream API stability (doctrine's
   * scoreTiLcSizing reads this directly); null-handling semantics for partial
   * triplet (one split populated, one null) are specified in the orchestrator.
   */
  readonly monthlyTiLc: AdjustedLineItem;
  /**
   * From OperatingStatementExtraction.belowNoiAdjustments.replacementReserves / 12.
   * Distinct from monthlyCapex (which is PCA-sourced from immediateRepairs);
   * these capture different reserve concepts and are additive, not redundant.
   */
  readonly monthlyReplacementReserves: AdjustedLineItem;
  /**
   * From OperatingStatementExtraction.belowNoiAdjustments.tenantImprovements / 12.
   * Split from leasingCommissions to match source-CF layout; the combined
   * monthlyTiLc above is derived from both.
   */
  readonly monthlyTenantImprovements: AdjustedLineItem;
  /**
   * From OperatingStatementExtraction.belowNoiAdjustments.leasingCommissions / 12.
   * Split from tenantImprovements (see monthlyTenantImprovements).
   */
  readonly monthlyLeasingCommissions: AdjustedLineItem;
  readonly pcaImmediateRepairs: AdjustedLineItem;

  /**
   * Year-by-year capex schedule projected from `PCAExtraction.capexScheduleInflated`
   * (PCA Phase 2 widening, scoped in v8 §14.1). One entry per year of the PCA's
   * evaluation period; years with no scheduled capex carry `amount: 0`.
   *
   * **SHAPE BREAK NOTE.** This field and `capexScheduleUninflated` are the
   * FIRST non-`AdjustedLineItem` fields in `AdjustedCapitalReserves`. They are
   * sibling-shape per-period arrays, not the uniform `{raw, adjusted, source,
   * adjustments}` line-item shape every other field in this interface follows.
   * The brief authorized this break in v8 §14.1 (the line-item shape doesn't
   * compose over arrays-of-objects). Consumers iterating `AdjustedCapitalReserves`
   * fields generically should dispatch on shape; no such generic iteration
   * exists today in the codebase (verified during Step 1 mismatch sweep).
   *
   * Engine consumption: the field-bag assembler projects this to
   * `bag['capex_projection']` as a length-N array of amounts (years stripped,
   * year order preserved) for P-IV-RET-6's `sum_over_term` formula. Sourced
   * from PCA at extraction time; null when no PCA has been ingested.
   *
   * KNOWN LIMITATION inherited from `PCAExtraction.capexScheduleInflated`: the
   * AI-tier PCA extractor reliably captures the sum and the set of non-zero
   * years, but year-by-year placement accuracy is ~50-60% (PDF text strips
   * column positions). Sum-precise consumers work correctly; year-precise
   * consumers should not rely on per-year accuracy. See PCAExtraction's JSDoc
   * for the full discussion.
   */
  readonly capexScheduleInflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;

  /**
   * Same schedule as `capexScheduleInflated` but in uninflated (year-0) dollars.
   * Cross-source for the inflated schedule; not currently consumed by the
   * handbook engine or any builder. Carried on AdjustedInputs for audit
   * traceability — the underwriter can see both bases side-by-side.
   */
  readonly capexScheduleUninflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;
}

export interface AdjustedLoan {
  readonly loanAmount: AdjustedLineItem;
  readonly interestRate: AdjustedLineItem;       // annualized, 0..1
  readonly termMonths: AdjustedLineItem;
  readonly amortizationMonths: AdjustedLineItem;
  readonly ioPeriodMonths: AdjustedLineItem;
  readonly maturityBalance: AdjustedLineItem;
  readonly debtServiceAnnual: AdjustedLineItem;
}

export interface AdjustedAssumptions {
  readonly capRate: AdjustedLineItem;            // entry/going-in
  readonly terminalCapRate: AdjustedLineItem;
  readonly rentGrowthPct: AdjustedLineItem;
  readonly expenseGrowthPct: AdjustedLineItem;
}

/**
 * Derived metrics. These are functions of the line items above, computed by stage 6
 * (`recalculateFullModel`). They live on AdjustedInputs because every downstream stage reads them
 * from a single source of truth.
 *
 * Numbers are nullable because the inputs can produce null (e.g., DSCR is null if debt service
 * is zero). Doctrine routes nulls through the INSUFFICIENT_DATA reason code rather than coercing.
 */
export interface AdjustedMetrics {
  readonly noi: number | null;
  readonly value: number | null;                          // = noi / capRate.adjusted
  readonly dscr: number | null;                           // = noi / debtServiceAnnual.adjusted
  readonly ltvAppraisal: number | null;                   // = loanAmount / appraisalValue
  readonly debtYield: number | null;                      // = noi / loanAmount
  readonly expenseRatio: number | null;                   // = totalOpEx / EGI
  readonly top1IncomeShare: number | null;                // 0..1; from rent roll
  readonly pctIncomeExpiringWithinTerm: number | null;    // 0..1; from rent roll vs term
}

/**
 * Stage-4 record. `id` is the SHA-256 of the JCS canonical serialization of every field below
 * EXCEPT `id` itself. Producers compute the hash, brand it as `AdjustedInputsId`, and attach it.
 *
 * `topLevelAdjustments` (Batch 1.6 — 2026-05-08): cross-cutting AdjustmentEntries that don't
 * pin to a specific line item. Currently used for `JE_NOI_CAPPED_TO_BANK` (architecture §6 NOI
 * ceiling). Doctrine reads from here for cross-cutting rule attribution. Distinct from
 * per-line-item `AdjustedLineItem.adjustments[]` which carries adjustments scoped to a single
 * field.
 */
export interface AdjustedInputs {
  readonly id: AdjustedInputsId;

  readonly analysisAsOfDate: ISODateTime;
  readonly judgmentEngineVersion: JudgmentEngineVersion;
  readonly librarySnapshotId: LibrarySnapshotId;

  readonly income: AdjustedIncome;
  readonly expenses: AdjustedExpenses;
  readonly capitalReserves: AdjustedCapitalReserves;
  readonly loan: AdjustedLoan;
  readonly assumptions: AdjustedAssumptions;
  readonly metrics: AdjustedMetrics;

  readonly confidenceReduction: number;          // 0..1
  readonly topLevelAdjustments: readonly AdjustmentEntry[];

  /**
   * Data-quality ledger surface (Batch 1.10 — 2026-05-08): which judgment-engine missing-doc /
   * distrust rules fired during Stage 4. Distinct from `confidenceReduction` (which is the
   * normalized scalar penalty). Doctrine §1 (data-confidence component) reads these for
   * per-doc scoring; doctrine §12 (False_negative_guard) checks
   * `dataQualityFlags.includes('JE_T12_MISSING')` for presence/absence predicates.
   *
   * Order is firing order from the orchestrator: missing-doc first (5 possible), distrust
   * second (2 possible). Each entry deduplicated.
   */
  readonly dataQualityFlags: readonly JudgmentEngineRuleId[];
}
