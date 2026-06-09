/**
 * Synthesize a read-time legacy UnderwritingModel from new-spine graph records.
 *
 * Promoted-from-graph analyses carry `graphRevisionId` and no `uwModel`. The
 * legacy financial tabs (income / expenses / metrics / loan schedule / stress)
 * and the BP Spire workbook export both read `analysis.uwModel`; this function
 * synthesizes one on-the-fly from AdjustedInputs + StressOutputs + (best-effort)
 * PropertyMetadata so the legacy surfaces work for promoted records without
 * persisting any new state.
 *
 * Invariants:
 *   - Read-time only. Nothing persisted. Graph stays authoritative.
 *   - All synthesized LineItems carry `isEditable: false, isOverridden: false` —
 *     a promoted record is a read-only view of immutable graph data.
 *   - Field map (AdjustedInputs / StressOutputs → UnderwritingModel) is the one
 *     documented in the graph-render recon brief. Unit conversions:
 *       - vacancyPct / concessionsPct (0..1) × grossRentalIncome → negative $
 *         (calculateEGI in uw-calc.ts:16-24 expects negative vacancy / concessions)
 *       - monthlyReplacementReserves × 12 → annual $
 *       - interestRate (0..1 decimal) × 100 → percent (calculateAnnualDebtService
 *         in uw-calc.ts:69 divides by 100)
 *       - amortizationMonths / termMonths / 12 → years
 *   - Defaults for fields with no graph source:
 *       - additionalItems: []
 *       - loanDetails.rateType: 'fixed'
 *       - loanDetails.paymentFrequency: 'monthly'
 *       - loanDetails.prepaymentTerms: ''
 *       - loanDetails.originationDate: today (ISO yyyy-mm-dd)
 *   - Loan schedule (repaymentSchedule) is NOT reimplemented here — the final
 *     step delegates to recalculateFullModel (uw-calc.ts:231) which calls
 *     generateRepaymentSchedule with the synthesized loanDetails and monthly NOI.
 *
 * Returns null when the graph chain doesn't resolve from the supplied
 * RevisionId. Caller is expected to fall back to the legacy uwModel.
 */

import { recalculateFullModel } from '@cre/shared';
import type {
  CapitalReservesSection,
  CapRateDisclosure,
  CapRateDisclosureEntry,
  ExpenseSection,
  IncomeSection,
  LineItem,
  LoanDetails,
  UnderwritingModel,
} from '@cre/shared';
import type { AdjustedInputs, PropertyMetadata, RevisionId } from '@cre/contracts';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

/**
 * Informational `topLevelAdjustments` rule ids — entries whose `delta` describes
 * a flagged condition but is NOT applied to `ai.metrics.noi` by the judgment
 * engine. The Source-B loop in `synthesizeUwModelFromInputs` skips these so the
 * synthesized model's NOI ties out to `ai.metrics.noi`.
 *
 *   - JE_NOI_BELOW_TRAILING_ACTUAL: delta = finalNoi - trailingActualNoi
 *     (descriptive shortfall; conclusion stands per noi-divergence.ts:15-16).
 *   - JE_PERIOD_LABEL_MISMATCH:     delta = 0 (audit-only, see
 *     apply-judgment-adjustments.ts:216-260).
 *
 * Anything not in this set is treated as load-bearing (JE_NOI_CAPPED_TO_BANK,
 * manifesto entries, future caps). Keep this narrow — a new informational
 * topLevelAdjustment must be enumerated here or it will silently regress the
 * synthesized NOI.
 */
const _TOP_LEVEL_INFO_RULE_IDS: ReadonlySet<string> = new Set([
  'JE_NOI_BELOW_TRAILING_ACTUAL',
  'JE_PERIOD_LABEL_MISMATCH',
]);

/**
 * Thrown when the synthesized UnderwritingModel's NOI does not match
 * `ai.metrics.noi` within rounding tolerance ($1). The synthesizer is the
 * read-path adapter for promoted-from-graph analyses + mitigation engine;
 * its NOI MUST equal the judgment engine's concluded NOI, or every
 * downstream consumer (mitigation sizing, workbook export, legacy tabs)
 * sees corrupted figures.
 */
export class SynthesizeUwModelTieOutError extends Error {
  override readonly name = 'SynthesizeUwModelTieOutError';
  constructor(
    public readonly synthesizedNoi: number,
    public readonly aiMetricsNoi: number,
    extra: string,
  ) {
    super(
      `SynthesizeUwModelTieOutError: synthesized NOI ${synthesizedNoi.toFixed(2)} ` +
      `does not match ai.metrics.noi ${aiMetricsNoi.toFixed(2)} ` +
      `(diff=${(synthesizedNoi - aiMetricsNoi).toFixed(2)}). ${extra}`,
    );
  }
}

/**
 * Graph wrapper: walk the record graph from `rootRevisionId` to the inputs the
 * pure synthesis needs (DoctrineEvaluation → AdjustedInputs → best-effort
 * PropertyMetadata via the extraction id), then delegate. Returns null when
 * any required graph hop is broken (FK dangle / pre-graph deals).
 */
export function synthesizeUwModelFromGraph(
  rootRevisionId: RevisionId,
  store: RecordGraphStore,
): UnderwritingModel | null {
  const envelope = store.getRevisionEnvelope(rootRevisionId);
  if (envelope === null) return null;

  const doctrine = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) return null;

  const ai = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (ai === null) return null;

  const propertyMetadata = store.getPropertyMetadataByExtractionResultId(
    doctrine.extractionResultId,
  );

  return synthesizeUwModelFromInputs(ai, propertyMetadata);
}

/**
 * Pure synthesis: AdjustedInputs + best-effort PropertyMetadata → legacy
 * UnderwritingModel. No store access; safe to call mid-pipeline (e.g., from
 * evaluate-and-narrate.ts to feed the mitigation producer) when ai + pm are
 * already in scope, without round-tripping through the record graph.
 */
export function synthesizeUwModelFromInputs(
  ai: AdjustedInputs,
  propertyMetadata: PropertyMetadata | null,
): UnderwritingModel {
  /* Income — economically-faithful unit conversion. Vacancy and concessions
   * apply to (GPR + otherIncome) rather than GPR alone (a vacant unit reduces
   * BOTH base rent and other income); this matches the graph's EGI formula
   * and the legacy line items then sum to AI.income.effectiveGrossIncome
   * directly via calculateEGI. Residual handling is defensive: if a future
   * fixture surfaces an EGI gap from some other graph-side adjustment, it
   * surfaces as a labeled income additionalItem rather than silently
   * diverging. */
  const grossPotentialRent = ai.income.grossRentalIncome.adjusted;
  const vacancyConcessionBase = grossPotentialRent + ai.income.otherIncome.adjusted;
  const vacancyDollars = -(ai.income.vacancyPct.adjusted * vacancyConcessionBase);
  const concessionsDollars = -(ai.income.concessionsPct.adjusted * vacancyConcessionBase);

  const lineItemEgi =
    grossPotentialRent + vacancyDollars + concessionsDollars + ai.income.otherIncome.adjusted;
  const egiGap = ai.income.effectiveGrossIncome.adjusted - lineItemEgi;
  const incomeAdditionalItems: LineItem[] = [];
  if (Math.abs(egiGap) > 0.01) {
    incomeAdditionalItems.push(stubLineItem(
      'inc_egi_residual',
      'Income Adjustment',
      egiGap,
    ));
  }
  /* Income-side floor / library bindings (Phase 14 — Bug 3 widening).
   * The graph's vacancy / concessions / other-income line items each carry
   * an `adjustments[]` ledger; rules like JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN
   * fire here. The legacy UnderwritingModel has no income-side ledger; we
   * surface each rule as a zero-dollar additionalItem labeled with the real
   * ruleId so the adapter can lift it onto AdjustedInputs.adjustments[] and
   * buildFloorBindings can pick it up. Zero-dollar so the EGI tie-out is not
   * perturbed (vacancy etc. is already accounted for in vacancyLoss above —
   * this is metadata only). The downstream adapter prefixes them with
   * `inc_` so the reverse projection lifts the ruleId cleanly. */
  for (const adj of ai.income.vacancyPct.adjustments) {
    incomeAdditionalItems.push(stubLineItem(
      `inc_${adj.ruleId.toLowerCase()}`,
      humanizeRuleId(adj.ruleId),
      0,
    ));
  }
  for (const adj of ai.income.concessionsPct.adjustments) {
    incomeAdditionalItems.push(stubLineItem(
      `inc_${adj.ruleId.toLowerCase()}`,
      humanizeRuleId(adj.ruleId),
      0,
    ));
  }
  for (const adj of ai.income.otherIncome.adjustments) {
    incomeAdditionalItems.push(stubLineItem(
      `inc_${adj.ruleId.toLowerCase()}`,
      humanizeRuleId(adj.ruleId),
      0,
    ));
  }
  const income: IncomeSection = {
    grossPotentialRent: stubLineItem('inc_gpr', 'Gross Potential Rent', grossPotentialRent),
    vacancyLoss:        stubLineItem('inc_vac', 'Vacancy Loss', vacancyDollars),
    concessions:        stubLineItem('inc_conc', 'Concessions', concessionsDollars),
    otherIncome:        stubLineItem('inc_other', 'Other Income', ai.income.otherIncome.adjusted),
    effectiveGrossIncome: stubLineItem('inc_egi', 'Effective Gross Income', ai.income.effectiveGrossIncome.adjusted),
    additionalItems: incomeAdditionalItems,
  };

  /* Expenses.
   *
   * Reserves: the graph treats replacement reserves as below-NOI / capital
   * (AI.capitalReserves.monthlyReplacementReserves; AI.metrics.noi does NOT
   * subtract reserves). Putting them on the synthesized expense tab would
   * misrepresent the graph's NOI build-up. expenses.replacementReserves is
   * set to 0 here. (The legacy UnderwritingModel contract has no
   * "below-NOI capital" slot; transparency about the reserves value is a
   * documented gap. The graph carries the real monthly value at
   * AI.capitalReserves.monthlyReplacementReserves.)
   *
   * NOI cap: read the real JE_NOI_CAPPED_TO_BANK entry from
   * AI.topLevelAdjustments (originates in noi-cap.ts:24). Surface it as a
   * single non-editable additionalItem with the real value and reason code.
   * Same for any other topLevelAdjustments (manifesto entries). Neither the
   * legacy contract nor the BP Spire workbook v7 schema has an NOI-level
   * adjustment slot distinct from operating expenses, so additionalItems is
   * the only available placement. The workbook v7 schema projects no NOI
   * build-up cells at all today, so cap placement is moot there.
   */
  const additionalItems: LineItem[] = [];

  /* Source A — expense-level judgment adjustments. The judgment engine can bump
   * AI.expenses.totalOperatingExpenses above the sum of named line items (e.g.
   * JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN, JE_EXPENSE_RAISED_TO_BANK in
   * line-item-builders.ts:buildTotalOperatingExpenses). Surface each rule from
   * the totalOperatingExpenses adjustments[] ledger with its real delta. If
   * the deltas don't fully account for the gap (e.g. raw-side data quirks), a
   * residual is surfaced under the catchall label. */
  const namedExpensesSum =
    ai.expenses.realEstateTaxes.adjusted +
    ai.expenses.insurance.adjusted +
    ai.expenses.utilities.adjusted +
    ai.expenses.maintenance.adjusted +
    ai.expenses.managementFee.adjusted +
    ai.expenses.generalAndAdmin.adjusted +
    ai.expenses.payroll.adjusted;
  const expenseGap = ai.expenses.totalOperatingExpenses.adjusted - namedExpensesSum;
  let attributedExpense = 0;
  for (const adj of ai.expenses.totalOperatingExpenses.adjustments) {
    additionalItems.push(stubLineItem(
      `exp_${adj.ruleId.toLowerCase()}`,
      humanizeRuleId(adj.ruleId),
      adj.delta,
    ));
    attributedExpense += adj.delta;
  }
  const residualExpense = expenseGap - attributedExpense;
  if (Math.abs(residualExpense) > 0.01) {
    additionalItems.push(stubLineItem(
      'exp_opex_residual',
      'OpEx Residual (graph total minus named lines)',
      residualExpense,
    ));
  }

  /* Source B — NOI-level adjustments (JE_NOI_CAPPED_TO_BANK + manifesto
   * entries). Live in AI.topLevelAdjustments. delta is signed effect on NOI;
   * NOI-reducing entries (delta < 0) become positive expense items, since the
   * legacy UnderwritingModel contract has no slot for "below opex / above
   * NOI" haircuts (see brief Step 0 — confirmed for legacy model and BP
   * Spire workbook v7 schema).
   *
   * Blocklist (Phase 1.5 — 2026-06-08): a subset of topLevelAdjustments are
   * INFORMATIONAL — their `delta` describes a quantity (e.g. concluded-vs-
   * trailing gap on JE_NOI_BELOW_TRAILING_ACTUAL, or always-0 on
   * JE_PERIOD_LABEL_MISMATCH) but the judgment engine NEVER applies them to
   * `finalNoi`. Translating them into synthesized expenses double-counts the
   * gap and corrupts the synthesized NOI / DSCR / LTV / DY that the mitigation
   * producer reads. Skip them; load-bearing entries (caps + manifesto) flow
   * through as before. See `_TOP_LEVEL_INFO_RULE_IDS` below for the canonical
   * list — kept narrow because the engine doesn't carry a `loadBearing` flag
   * on AdjustmentEntry today. Deferred cleanup: move informational rules off
   * topLevelAdjustments entirely (option 3 from the Phase-1 diagnosis). */
  for (const entry of ai.topLevelAdjustments) {
    if (_TOP_LEVEL_INFO_RULE_IDS.has(entry.ruleId)) continue;
    additionalItems.push(stubLineItem(
      `exp_je_${entry.ruleId.toLowerCase()}`,
      humanizeRuleId(entry.ruleId),
      -entry.delta,
    ));
  }

  const expenses: ExpenseSection = {
    realEstateTaxes:       stubLineItem('exp_taxes', 'Real Estate Taxes', ai.expenses.realEstateTaxes.adjusted),
    insurance:             stubLineItem('exp_ins', 'Insurance', ai.expenses.insurance.adjusted),
    utilities:             stubLineItem('exp_util', 'Utilities', ai.expenses.utilities.adjusted),
    repairsAndMaintenance: stubLineItem('exp_rm', 'Repairs & Maintenance', ai.expenses.maintenance.adjusted),
    management:            stubLineItem('exp_mgmt', 'Management', ai.expenses.managementFee.adjusted),
    generalAndAdmin:       stubLineItem('exp_ga', 'General & Admin', ai.expenses.generalAndAdmin.adjusted),
    payroll:               stubLineItem('exp_payroll', 'Payroll', ai.expenses.payroll.adjusted),
    // Reserves zeroed on the opex subtotal (NOI excludes capital reserves —
    // preserves the NOI tie-out against AI.metrics.noi). The real annual
    // figure is embedded in the label so the analyst sees it without it
    // entering totalExpenses.
    replacementReserves:   stubLineItem(
      'exp_rr',
      `Replacement Reserves (capital, below NOI; $${(ai.capitalReserves.monthlyReplacementReserves.adjusted * 12).toLocaleString('en-US')}/yr)`,
      0,
    ),
    totalExpenses:         stubLineItem('exp_total', 'Total Operating Expenses', ai.expenses.totalOperatingExpenses.adjusted),
    additionalItems,
  };

  /* Capital reserves — below-NOI / capital. The new-spine
   * `AdjustedCapitalReserves` carries split TI / LC + monthly capex +
   * upfront one-time reserves; we bridge them onto the synthesized
   * UnderwritingModel so the adapter can project them onto
   * `@cre/shared.AdjustedInputs.capitalReserves` without re-importing
   * graph state. NOI tie-out is preserved at the expenses tab (which
   * still zeros `replacementReserves`). The values surface only on the
   * capital-reserves slot the render-schema reads. */
  const capitalReserves: CapitalReservesSection = {
    monthlyReplacementReserves: ai.capitalReserves.monthlyReplacementReserves.adjusted,
    monthlyTenantImprovements:  ai.capitalReserves.monthlyTenantImprovements.adjusted,
    monthlyLeasingCommissions:  ai.capitalReserves.monthlyLeasingCommissions.adjusted,
    monthlyCapex:               ai.capitalReserves.monthlyCapex.adjusted,
    upfrontReplacementReserves: ai.capitalReserves.upfrontReplacementReserves.adjusted,
    upfrontTiLc:                ai.capitalReserves.upfrontTiLc.adjusted,
    pcaImmediateRepairs:        ai.capitalReserves.pcaImmediateRepairs.adjusted,
  };

  const loanDetails: LoanDetails = {
    loanAmount:         ai.loan.loanAmount.adjusted,
    interestRate:       ai.loan.interestRate.adjusted * 100,
    rateType:           'fixed',
    ioMonths:           ai.loan.ioPeriodMonths.adjusted,
    amortizationMonths: ai.loan.amortizationMonths.adjusted,
    termMonths:         ai.loan.termMonths.adjusted,
    paymentFrequency:   'monthly',
    prepaymentTerms:    '',
    originationDate:    new Date().toISOString().slice(0, 10),
  };

  /* Concluded-cap disclosure (cap-rate stress doctrine v1). Each
   * AdjustmentEntry on AI.assumptions.capRate.adjustments[] becomes a
   * deltaBps-typed row (decimal fraction × 10_000). The cap-relevant
   * dataQualityFlags are filtered to JE_CAP_* and surfaced alongside.
   * Workbook template uses both to attach an Excel cell note on the
   * concluded-cap cell; web page renders capRate.adjustments through the
   * separate rendered-analysis path (render-underwriting-context.ts),
   * which is already bijective and needs no projection here. */
  const capRateDisclosure: CapRateDisclosure = {
    adjustments: ai.assumptions.capRate.adjustments.map((a): CapRateDisclosureEntry => ({
      ruleId: a.ruleId,
      reason: a.reason,
      deltaBps: Math.round(a.delta * 10_000),
    })),
    flags: ai.dataQualityFlags.filter((f) => f.startsWith('JE_CAP_')),
  };

  /* Pre-recalc skeleton. recalculateFullModel will overwrite the derived
     fields (NOI, impliedValue, dscr, ltv [= loan/impliedValue],
     debtYield, annualDebtService, repaymentSchedule, effectiveGrossIncome,
     totalExpenses, per-unit / per-sqft / percentOfEGI when totalUnits /
     totalSqFt are set).

     ltvAppraised is set AFTER recalc (otherwise recalc wouldn't touch it,
     but the field exists on the model so we'd be relying on undefined
     vs null semantics). We set it on the post-recalc return value. */
  const skeleton: UnderwritingModel = {
    income,
    expenses,
    capitalReserves,
    netOperatingIncome: 0,
    capRate:            ai.assumptions.capRate.adjusted,
    capRateDisclosure,
    impliedValue:       null,
    loanAmount:         loanDetails.loanAmount,
    interestRate:       loanDetails.interestRate,
    amortizationYears:  loanDetails.amortizationMonths / 12,
    termYears:          loanDetails.termMonths / 12,
    annualDebtService:  null,
    dscr:               null,
    ltv:                null,
    debtYield:          null,
    ...(propertyMetadata?.totalUnits != null ? { totalUnits: propertyMetadata.totalUnits } : {}),
    ...(propertyMetadata?.totalSquareFeet != null ? { totalSqFt: propertyMetadata.totalSquareFeet } : {}),
    asReported:         false,
    modifiedCells:      [],
    loanDetails,
    repaymentSchedule:  null,
  };

  const recalculated = recalculateFullModel(skeleton);

  /* Tie-out gate (Phase 1.5 — 2026-06-08). The synthesized UW model is the
   * read-path adapter that the mitigation producer (produce-mitigations.ts)
   * + legacy workbook tabs consume. Its NOI MUST equal the judgment engine's
   * concluded NOI; any divergence corrupts every downstream figure (DSCR /
   * LTV / DY) by exactly the divergence × the relevant divisor. Throw early
   * with a descriptive error rather than silently emit a wrong mitigant. */
  if (ai.metrics.noi !== null && Number.isFinite(recalculated.netOperatingIncome)) {
    const diff = Math.abs(recalculated.netOperatingIncome - ai.metrics.noi);
    if (diff > 1) {
      throw new SynthesizeUwModelTieOutError(
        recalculated.netOperatingIncome,
        ai.metrics.noi,
        'Inspect topLevelAdjustments + income/expense residuals; an informational ' +
        'topLevelAdjustment may be flowing through Source-B as an expense (must be ' +
        `enumerated in _TOP_LEVEL_INFO_RULE_IDS). topLevelAdjustments=[${ai.topLevelAdjustments.map(a => a.ruleId).join(', ')}]`,
      );
    }
  }

  return {
    ...recalculated,
    // Appraised LTV — direct from graph metrics. Distinct denominator from
    // recalculated.ltv (loan/impliedValue). Both shown on the metrics tab.
    ltvAppraised: ai.metrics.ltvAppraisal,
  };
}

function stubLineItem(id: string, label: string, annualAmount: number): LineItem {
  return {
    id,
    label,
    annualAmount,
    isEditable: false,
    isOverridden: false,
    originalValue: annualAmount,
  };
}

/**
 * Surface JudgmentEngineRuleId values as analyst-readable labels for the
 * synthesized expense tab. Keep the ruleId intact in the LineItem.id (via the
 * caller) so the underlying rule remains traceable.
 */
function humanizeRuleId(ruleId: string): string {
  switch (ruleId) {
    case 'JE_NOI_CAPPED_TO_BANK':                    return 'NOI Capped to Bank NOI (JE_NOI_CAPPED_TO_BANK)';
    case 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN':      return 'OpEx Raised to Library Median (JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN)';
    case 'JE_EXPENSE_RAISED_TO_BANK':                return 'OpEx Raised to Bank (JE_EXPENSE_RAISED_TO_BANK)';
    case 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY':return 'OpEx Ratio Substituted from Library (JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY)';
    case 'JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE':      return 'OpEx Ratio No Floor Available (JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE)';
    default:                                          return ruleId;
  }
}
