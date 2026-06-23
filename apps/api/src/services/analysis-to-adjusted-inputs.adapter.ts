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
  AdjustedCapitalReserves,
  AdjustedExpenses,
  AdjustedIncome,
  AdjustedInputs,
  AdjustedLeasingAssumptionsView,
  AdjustedLineItem,
  AdjustedLoan,
  AdjustedMetrics,
  AdjustmentEntry,
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

/**
 * Project the synthesized `UnderwritingModel.capitalReserves` slot onto
 * the @cre/shared `AdjustedCapitalReserves` shape. Legacy non-promoted
 * analyses (no graph) leave the slot undefined; emit an all-zeros default
 * with `source: 'missing-data-penalty'` so the render-schema selectors
 * can read unconditionally.
 *
 * Unit convention is preserved: `monthly*` are monthly $, `upfront*` and
 * `pcaImmediateRepairs` are closing-time $.
 *
 * Without a real judgment engine surfacing raw vs adjusted distinctions
 * on the legacy synthesized model, we treat the carried value as both
 * raw and adjusted (delta = 0, source = 'raw'). When the engine cutover
 * lands and the render layer reads directly from @cre/contracts, this
 * function (and the whole adapter) goes away.
 */
function buildCapitalReserves(model: UnderwritingModel): AdjustedCapitalReserves {
  const cr = model.capitalReserves;
  if (!cr) {
    // Legacy / non-promoted analysis without graph state. Emit a coherent
    // all-zeros default so selectors can read unconditionally; the missing-
    // data-penalty source flag signals "not derivable" to downstream
    // disclosure surfaces.
    const missing: AdjustedLineItem = {
      raw: null, adjusted: 0, delta: 0, source: 'missing-data-penalty',
    };
    return {
      monthlyReplacementReserves: { ...missing },
      monthlyTenantImprovements:  { ...missing },
      monthlyLeasingCommissions:  { ...missing },
      monthlyCapex:               { ...missing },
      upfrontReplacementReserves: { ...missing },
      upfrontTiLc:                { ...missing },
      pcaImmediateRepairs:        { ...missing },
    };
  }
  const li = (v: number): AdjustedLineItem => ({
    raw: Number.isFinite(v) ? v : null,
    adjusted: Number.isFinite(v) ? v : 0,
    delta: 0,
    source: 'raw',
  });
  return {
    monthlyReplacementReserves: li(cr.monthlyReplacementReserves),
    monthlyTenantImprovements:  li(cr.monthlyTenantImprovements),
    monthlyLeasingCommissions:  li(cr.monthlyLeasingCommissions),
    monthlyCapex:               li(cr.monthlyCapex),
    upfrontReplacementReserves: li(cr.upfrontReplacementReserves),
    upfrontTiLc:                li(cr.upfrontTiLc),
    pcaImmediateRepairs:        li(cr.pcaImmediateRepairs),
  };
}

/**
 * Project the synthesized `UnderwritingModel.expenses.additionalItems[]`
 * back into the `@cre/shared.AdjustedInputs.adjustments[]` ledger. The
 * synthesis at synthesize-uw-model-from-graph.ts encodes each adjustment
 * as a LineItem with `id: 'exp_${ruleId.toLowerCase()}'` (Source A —
 * OpEx-level adjustments) or `id: 'exp_je_${ruleId.toLowerCase()}'`
 * (Source B — NOI-level adjustments from topLevelAdjustments). The
 * reverse projection strips the prefix and uppercases the result.
 *
 * Downstream `buildFloorBindings` filters by a JE_*_RAISED_TO_LIBRARY /
 * _RAISED_TO_BANK / _SUBSTITUTED_FROM_LIBRARY / _FLOOR / _CAPPED_TO_BANK
 * regex, so non-floor items (e.g. JE_NOI_RECONCILED) pass through harmlessly.
 */
function extractRuleIdFromLineItemId(id: string): string {
  // Match the longest prefix first — 'exp_je_' must be tried before 'exp_'.
  // Income-side bindings use the `inc_` prefix (Bug 3 widening — surfaces
  // vacancy/concessions/otherIncome floor bindings); 'inc_egi_residual'
  // is a defensive placeholder, not an adjustment — it stays out.
  const stripped = id.startsWith('exp_je_')
    ? id.slice('exp_je_'.length)
    : id.startsWith('exp_')
      ? id.slice('exp_'.length)
      : id.startsWith('inc_')
        ? id.slice('inc_'.length)
        : id;
  // Reverse synthesis's `.toLowerCase()` so the resulting ruleId can match
  // the JudgmentEngineRuleId catalogue and the floor-binding regex.
  return stripped.toUpperCase();
}

/**
 * Inferred field-name on the adjustments ledger based on the synthesized
 * line-item id prefix. Determines which schema-layer field the binding is
 * disclosed against on the populated workbook:
 *   - 'inc_*' (synthesis Phase 14 widening) → 'vacancyPct' etc.
 *   - 'exp_*' / 'exp_je_*'                   → 'totalOperatingExpenses'.
 *
 * The downstream `buildFloorBindings` filter regex matches on ruleId, not
 * field, so a mis-bucketed field doesn't break the disclosure. The field
 * label is informational only.
 */
function inferAdjustmentField(id: string, ruleId: string): string {
  if (id.startsWith('inc_')) {
    // Best-effort: route vacancy / concessions rule ids to their
    // respective fields. Anything else lands on a generic income field.
    if (ruleId.includes('VACANCY')) return 'vacancyPct';
    if (ruleId.includes('CONCESSION')) return 'concessionsPct';
    if (ruleId.includes('OTHER_INCOME') || ruleId.includes('OTHERINCOME')) return 'otherIncome';
    return 'income';
  }
  return 'totalOperatingExpenses';
}

/**
 * Skip-list: items the adapter must NOT project as adjustments. The synthesis
 * emits `inc_egi_residual` as a defensive EGI tie-out residual; it carries no
 * judgment-engine semantics and must not pollute the adjustments ledger.
 */
const ADJUSTMENT_LINE_ITEM_SKIP = new Set<string>([
  'exp_opex_residual',
  'inc_egi_residual',
]);

function buildAdjustments(model: UnderwritingModel): AdjustmentEntry[] {
  const out: AdjustmentEntry[] = [];
  const expenseItems = model.expenses?.additionalItems ?? [];
  const incomeItems = model.income?.additionalItems ?? [];
  for (const item of [...incomeItems, ...expenseItems]) {
    if (ADJUSTMENT_LINE_ITEM_SKIP.has(item.id)) continue;
    const ruleId = extractRuleIdFromLineItemId(item.id);
    out.push({
      ruleId,
      field: inferAdjustmentField(item.id, ruleId),
      before: null,
      after: item.annualAmount,
      reason: item.label,
      // The synthesis catalogue distinguishes:
      //   - Source A items (`exp_${ruleId}`) — library / bank floor lifts →
      //     map to 'library-baseline'.
      //   - Source B items (`exp_je_${ruleId}`) — NOI-level haircuts (e.g.
      //     JE_NOI_CAPPED_TO_BANK). These are still judgment-engine
      //     bindings; flag with 'library-baseline' as well so the floor-
      //     binding regex sees a consistent source. (The regex itself
      //     filters by ruleId, not source.)
      //   - 'inc_*' income-side bindings — Phase 14 widening for vacancy /
      //     concessions / otherIncome floors. Same 'library-baseline' flag.
      source: 'library-baseline',
    });
  }
  return out;
}

function buildMetrics(model: UnderwritingModel): AdjustedMetrics {
  return {
    netOperatingIncome: model.netOperatingIncome,
    capRate: model.capRate,
    impliedValue: model.impliedValue,
    // Legacy Analysis path doesn't carry a separate concluded `value` distinct
    // from `impliedValue` (engine-derived). When the producer pipeline supplies
    // an operator-supplied / appraisal-derived concluded valuation, that route
    // populates AdjustedMetrics.value directly — not through this adapter.
    value: null,
    annualDebtService: model.annualDebtService,
    dscr: model.dscr,
    ltv: model.ltv,
    debtYield: model.debtYield,
  };
}

// Display-only leasing baseline for the workbook top-block. Mirrors Phase 1's
// deriveLeasingAssumptions (apply-judgment-adjustments) but sources from the
// Analysis's appraisal extraction — this legacy adapter is the workbook-export
// path (render.routes → buildRenderPayload), which doesn't carry the graph
// AdjustedInputs.assumptions. Honest-blank: null when the appraisal didn't
// conclude one. Market rent annualized (×12); term in years (÷12). NOT read by
// scoring (display-only; the render is downstream of the graph doctrine score).
function deriveLeasingView(
  la: NonNullable<NonNullable<Analysis['appraisalExtraction']>['leasingAssumptions']> | null | undefined,
): { leasing: AdjustedLeasingAssumptionsView } | null {
  if (la === null || la === undefined) return null;
  return {
    leasing: {
      tiNewPsf: la.tiNewPsf,
      tiRenewPsf: la.tiRenewPsf,
      marketRentPsf: la.marketRentPsfPerMonth != null ? la.marketRentPsfPerMonth * 12 : null,
      downtimeMonths: la.downtimeMonths,
      leaseTermYears: la.avgLeaseTermMonths != null ? la.avgLeaseTermMonths / 12 : null,
    },
  };
}

export function adaptAnalysisToAdjustedInputs(analysis: Analysis): AdjustedInputs | null {
  const model = analysis.uwModel;
  if (!model) return null;
  return {
    income: buildIncome(model),
    expenses: buildExpenses(model),
    assumptions: deriveLeasingView(analysis.appraisalExtraction?.leasingAssumptions ?? null),
    // Below-NOI / capital reserves. Populated from the synthesized graph
    // when present, all-zeros default with missing-data-penalty otherwise.
    capitalReserves: buildCapitalReserves(model),
    loan: buildLoan(model),
    metrics: buildMetrics(model),
    // Projects synthesized `model.expenses.additionalItems[]` back into the
    // flat adjustments ledger. `buildFloorBindings` filters by floor-rule
    // ruleId pattern; non-floor entries (e.g. JE_NOI_CAPPED_TO_BANK if not
    // a floor) flow through harmlessly.
    adjustments: buildAdjustments(model),
    confidenceReduction: 0,
  };
}
