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

  const income: IncomeSection = {
    grossPotentialRent: stubLineItem('inc_gpr', 'Gross Potential Rent', grossPotentialRent),
    vacancyLoss:        stubLineItem('inc_vac', 'Vacancy Loss', vacancyDollars),
    concessions:        stubLineItem('inc_conc', 'Concessions', concessionsDollars),
    otherIncome:        stubLineItem('inc_other', 'Other Income', ai.income.otherIncome.adjusted),
    effectiveGrossIncome: stubLineItem('inc_egi', 'Effective Gross Income', ai.income.effectiveGrossIncome.adjusted),
    additionalItems: [],
  };

  /* Expenses — direct map. ReplacementReserves moves namespace (capitalReserves
     → expenses) and changes granularity (monthly → annual).

     Judgment-engine NOI cap: AI.metrics.noi is computed as
     applyNoiCap(preCapNoi, bankNoi) in apply-judgment-adjustments.ts:312 —
     not a simple EGI − totalOpEx. To make the synthesized model's NOI match
     AI.metrics.noi, we close the gap with an explicit additionalItem so the
     analyst can SEE the cap rather than have it hidden in the headline number.
     Same approach used in spirit by AI.topLevelAdjustments. */
  const replacementReservesAnnual = ai.capitalReserves.monthlyReplacementReserves.adjusted * 12;
  const namedExpensesSum =
    ai.expenses.realEstateTaxes.adjusted +
    ai.expenses.insurance.adjusted +
    ai.expenses.utilities.adjusted +
    ai.expenses.maintenance.adjusted +
    ai.expenses.managementFee.adjusted +
    ai.expenses.generalAndAdmin.adjusted +
    ai.expenses.payroll.adjusted +
    replacementReservesAnnual;
  // Compute the gap in terms of OUR line-item EGI (what recalculateFullModel
  // will sum from income.{grossPotentialRent, vacancyLoss, concessions,
  // otherIncome}) — not AI.income.EGI.adjusted, which can differ slightly if
  // judgment-engine income-side adjustments don't fall on the four fields we
  // unit-convert. Using the line-item EGI here makes the closure exact.
  const lineItemEgi = grossPotentialRent + vacancyDollars + concessionsDollars + ai.income.otherIncome.adjusted;
  const additionalItems: LineItem[] = [];
  if (ai.metrics.noi !== null) {
    const judgmentGap = lineItemEgi - namedExpensesSum - ai.metrics.noi;
    if (Math.abs(judgmentGap) > 0.01) {
      additionalItems.push(stubLineItem('exp_je_adj', 'Judgment Engine Adjustment', judgmentGap));
    }
  }
  const expenses: ExpenseSection = {
    realEstateTaxes:       stubLineItem('exp_taxes', 'Real Estate Taxes', ai.expenses.realEstateTaxes.adjusted),
    insurance:             stubLineItem('exp_ins', 'Insurance', ai.expenses.insurance.adjusted),
    utilities:             stubLineItem('exp_util', 'Utilities', ai.expenses.utilities.adjusted),
    repairsAndMaintenance: stubLineItem('exp_rm', 'Repairs & Maintenance', ai.expenses.maintenance.adjusted),
    management:            stubLineItem('exp_mgmt', 'Management', ai.expenses.managementFee.adjusted),
    generalAndAdmin:       stubLineItem('exp_ga', 'General & Admin', ai.expenses.generalAndAdmin.adjusted),
    payroll:               stubLineItem('exp_payroll', 'Payroll', ai.expenses.payroll.adjusted),
    replacementReserves:   stubLineItem('exp_rr', 'Replacement Reserves', replacementReservesAnnual),
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
     fields (NOI, impliedValue, dscr, ltv, debtYield, annualDebtService,
     repaymentSchedule, effectiveGrossIncome, totalExpenses, per-unit /
     per-sqft / percentOfEGI when totalUnits / totalSqFt are set). */
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

  return recalculateFullModel(skeleton);
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
