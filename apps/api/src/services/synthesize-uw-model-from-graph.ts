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
  ExpenseSection,
  IncomeSection,
  LineItem,
  LoanDetails,
  UnderwritingModel,
} from '@cre/shared';
import type { RevisionId } from '@cre/contracts';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

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

  /* Income — unit-converted from AI.income. Vacancy and concessions are stored
     as 0..1 fractions on AI; legacy LineItems expect signed-negative dollars. */
  const grossPotentialRent = ai.income.grossRentalIncome.adjusted;
  const vacancyDollars = -(ai.income.vacancyPct.adjusted * grossPotentialRent);
  const concessionsDollars = -(ai.income.concessionsPct.adjusted * grossPotentialRent);

  /* Income — direct map + EGI reconciliation. Legacy calculateEGI applies
   * vacancy/concessions to GPR only; the graph's EGI formula applies vacancy
   * to (GPR + otherIncome) (and may include other convention-level
   * adjustments). The gap between my line-item-summed EGI and
   * AI.income.effectiveGrossIncome.adjusted is surfaced as an income
   * additionalItem labeled descriptively, so recalculateFullModel's recompute
   * lands at the graph's canonical EGI. */
  const lineItemEgiBeforeReconciliation =
    grossPotentialRent + vacancyDollars + concessionsDollars + ai.income.otherIncome.adjusted;
  const egiGap = ai.income.effectiveGrossIncome.adjusted - lineItemEgiBeforeReconciliation;
  const incomeAdditionalItems: LineItem[] = [];
  if (Math.abs(egiGap) > 0.01) {
    incomeAdditionalItems.push(stubLineItem(
      'inc_egi_recon',
      'Income Reconciliation (graph EGI − line items)',
      egiGap,
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
   * Spire workbook v7 schema). */
  for (const entry of ai.topLevelAdjustments) {
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
    // Reserves zeroed on the tab — graph treats them as below-NOI / capital.
    // Real monthly value: AI.capitalReserves.monthlyReplacementReserves.
    replacementReserves:   stubLineItem('exp_rr', 'Replacement Reserves (below NOI on graph)', 0),
    totalExpenses:         stubLineItem('exp_total', 'Total Operating Expenses', ai.expenses.totalOperatingExpenses.adjusted),
    additionalItems,
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
    netOperatingIncome: 0,
    capRate:            ai.assumptions.capRate.adjusted,
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
