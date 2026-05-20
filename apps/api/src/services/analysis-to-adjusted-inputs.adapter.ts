/**
 * TEMPORARY BRIDGE — Analysis → AdjustedInputs.
 *
 * The architecture contract (memory/architecture_contract.md §3, §5) says the
 * judgment engine must emit AdjustedInputs as the canonical pipeline output.
 * That refactor has not landed. Until it does, this adapter projects the
 * existing `analysis.uwModel` (an UnderwritingModel) into the AdjustedInputs
 * shape so the render layer can already depend on the final contract.
 *
 * Why a separate file (vs. inlining):
 *   - render.service.ts MUST stay free of Analysis dependencies.
 *   - When `applyJudgmentAdjustments()` lands and the pipeline returns
 *     AdjustedInputs natively, we delete this entire file. No render-layer
 *     change required.
 *
 * What this adapter is NOT:
 *   - Not a judgment engine. Adjustments are reported as `source: 'raw'` because
 *     the current uwModel does not carry an adjustment ledger.
 *   - Not a metric computer. Whatever uwModel reports is passed through.
 */
import type {
  AdjustedExpenses,
  AdjustedIncome,
  AdjustedInputs,
  AdjustedLineItem,
  AdjustedLoan,
  AdjustedMetrics,
  Analysis,
  LineItem,
  UnderwritingModel,
} from '@cre/shared';

function lineItemToAdjusted(li: LineItem | undefined | null): AdjustedLineItem {
  if (!li) {
    return { raw: null, adjusted: 0, delta: 0, source: 'missing-data-penalty' };
  }
  // Without a real judgment engine, we treat originalValue as raw and the
  // current annualAmount as adjusted. delta is whatever divergence the legacy
  // override mechanism produced.
  const raw = Number.isFinite(li.originalValue) ? li.originalValue : null;
  const adjusted = Number.isFinite(li.annualAmount) ? li.annualAmount : 0;
  const delta = adjusted - (raw ?? 0);
  return {
    raw,
    adjusted,
    delta,
    source: li.isOverridden ? 'override' : 'raw',
  };
}

function buildIncome(model: UnderwritingModel): AdjustedIncome {
  return {
    grossPotentialRent:    lineItemToAdjusted(model.income.grossPotentialRent),
    vacancyLoss:           lineItemToAdjusted(model.income.vacancyLoss),
    concessions:           lineItemToAdjusted(model.income.concessions),
    otherIncome:           lineItemToAdjusted(model.income.otherIncome),
    effectiveGrossIncome:  lineItemToAdjusted(model.income.effectiveGrossIncome),
  };
}

function buildExpenses(model: UnderwritingModel): AdjustedExpenses {
  return {
    realEstateTaxes:       lineItemToAdjusted(model.expenses.realEstateTaxes),
    insurance:             lineItemToAdjusted(model.expenses.insurance),
    utilities:             lineItemToAdjusted(model.expenses.utilities),
    repairsAndMaintenance: lineItemToAdjusted(model.expenses.repairsAndMaintenance),
    management:            lineItemToAdjusted(model.expenses.management),
    generalAndAdmin:       lineItemToAdjusted(model.expenses.generalAndAdmin),
    payroll:               lineItemToAdjusted(model.expenses.payroll),
    replacementReserves:   lineItemToAdjusted(model.expenses.replacementReserves),
    totalExpenses:         lineItemToAdjusted(model.expenses.totalExpenses),
  };
}

/**
 * Normalize interest rate to decimal (0..1). The legacy uwModel and
 * loanDetails store rates inconsistently — some rows persist 7.16 (percent),
 * others 0.0716 (decimal). The render contract is decimal: cells in the
 * canonical artifact (e.g. `Coupon`) are formatted as percent, so writing
 * 7.16 displays as "716.00%". Anything > 1 is treated as percent and
 * divided by 100; anything <= 1 is already decimal.
 */
function normalizeRateToDecimal(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value > 1 ? value / 100 : value;
}

function buildLoan(model: UnderwritingModel): AdjustedLoan {
  const ld = model.loanDetails;
  const rawRate = ld?.interestRate ?? model.interestRate;
  return {
    loanAmount: ld?.loanAmount ?? model.loanAmount,
    interestRate: normalizeRateToDecimal(rawRate),
    rateType: ld?.rateType ?? 'fixed',
    amortizationMonths: ld?.amortizationMonths ?? model.amortizationYears * 12,
    termMonths: ld?.termMonths ?? model.termYears * 12,
    ioMonths: ld?.ioMonths ?? 0,
  };
}

function buildMetrics(model: UnderwritingModel): AdjustedMetrics {
  return {
    netOperatingIncome: model.netOperatingIncome,
    capRate: model.capRate,
    impliedValue: model.impliedValue,
    annualDebtService: model.annualDebtService,
    dscr: model.dscr,
    ltv: model.ltv,
    debtYield: model.debtYield,
  };
}

export function adaptAnalysisToAdjustedInputs(analysis: Analysis): AdjustedInputs | null {
  const model = analysis.uwModel;
  if (!model) return null;
  return {
    income: buildIncome(model),
    expenses: buildExpenses(model),
    loan: buildLoan(model),
    metrics: buildMetrics(model),
    // Legacy uwModel does not carry an adjustment ledger — return empty.
    // The judgment engine will populate this once it lands.
    adjustments: [],
    confidenceReduction: 0,
  };
}
