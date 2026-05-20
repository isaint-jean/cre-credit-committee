/**
 * Manifesto rule evaluator (audit §8).
 *
 * v1.0 contract: manifesto rules are observational only. They emit AdjustmentEntries with
 * `delta = 0`; the value of the targeted line item is NOT mutated. Doctrine downstream reads
 * the outcomes and scores.
 *
 * Pipeline:
 *   1. Asset-type filter — skip if rule doesn't apply to the deal's property type.
 *   2. Resolve metric path via the frozen `METRIC_PATH_MAP`. Unknown metrics → silently skip.
 *   3. Read `currentValue`. If null → emit Watchlist with INSUFFICIENT_DATA reason.
 *   4. Evaluate predicate (operator-dependent). For `qualitative` and `between`, return
 *      INSUFFICIENT_DATA — v1.0 doesn't evaluate them.
 *   5. Outcome: predicate met → 'Pass'; predicate failed → `rule.outcome` (the rule's
 *      configured failure label).
 *   6. Emit AdjustmentEntry with delta=0.
 */

import type {
  AdjustmentEntry,
  AdjustedInputs,
  AssetProfile,
  AssetType,
  ManifestoComparisonOperator,
  ManifestoOutcome,
  ManifestoRule,
} from '@cre/contracts';

/** Result of evaluating a single manifesto rule. */
export interface ManifestoEvaluation {
  readonly fired: boolean;
  readonly outcome: ManifestoOutcome | 'INSUFFICIENT_DATA' | null;
  readonly entry: AdjustmentEntry | null;
}

/* ---------------------------- metric path mapping --------------------------- */

/**
 * Frozen lookup: manifesto `metricName` → `AdjustedInputs` resolved value.
 *
 * Adding a new manifesto-targetable metric requires adding an entry here. Unknown metrics
 * cause the rule to silently skip (no emission); this prevents typos in user-uploaded
 * manifestos from crashing the pipeline.
 */
type AdjustedInputsPath =
  | 'metrics.noi'
  | 'metrics.value'
  | 'metrics.dscr'
  | 'metrics.ltvAppraisal'
  | 'metrics.debtYield'
  | 'metrics.expenseRatio'
  | 'metrics.top1IncomeShare'
  | 'metrics.pctIncomeExpiringWithinTerm'
  | 'income.vacancyPct'
  | 'income.grossRentalIncome'
  | 'income.effectiveGrossIncome'
  | 'expenses.totalOperatingExpenses'
  | 'loan.loanAmount'
  | 'loan.interestRate'
  | 'assumptions.capRate';

export const METRIC_PATH_MAP: { readonly [K: string]: AdjustedInputsPath } = {
  noi:                          'metrics.noi',
  value:                        'metrics.value',
  dscr:                         'metrics.dscr',
  ltv:                          'metrics.ltvAppraisal',
  ltvAppraisal:                 'metrics.ltvAppraisal',
  debtYield:                    'metrics.debtYield',
  expenseRatio:                 'metrics.expenseRatio',
  top1IncomeShare:              'metrics.top1IncomeShare',
  pctIncomeExpiringWithinTerm:  'metrics.pctIncomeExpiringWithinTerm',
  vacancy:                      'income.vacancyPct',
  vacancyPct:                   'income.vacancyPct',
  grossRentalIncome:            'income.grossRentalIncome',
  effectiveGrossIncome:         'income.effectiveGrossIncome',
  totalOperatingExpenses:       'expenses.totalOperatingExpenses',
  loanAmount:                   'loan.loanAmount',
  interestRate:                 'loan.interestRate',
  capRate:                      'assumptions.capRate',
};

function resolvePath(adjusted: AdjustedInputs, path: AdjustedInputsPath): number | null {
  switch (path) {
    case 'metrics.noi':                          return adjusted.metrics.noi;
    case 'metrics.value':                        return adjusted.metrics.value;
    case 'metrics.dscr':                         return adjusted.metrics.dscr;
    case 'metrics.ltvAppraisal':                 return adjusted.metrics.ltvAppraisal;
    case 'metrics.debtYield':                    return adjusted.metrics.debtYield;
    case 'metrics.expenseRatio':                 return adjusted.metrics.expenseRatio;
    case 'metrics.top1IncomeShare':              return adjusted.metrics.top1IncomeShare;
    case 'metrics.pctIncomeExpiringWithinTerm':  return adjusted.metrics.pctIncomeExpiringWithinTerm;
    case 'income.vacancyPct':                    return adjusted.income.vacancyPct.adjusted;
    case 'income.grossRentalIncome':             return adjusted.income.grossRentalIncome.adjusted;
    case 'income.effectiveGrossIncome':          return adjusted.income.effectiveGrossIncome.adjusted;
    case 'expenses.totalOperatingExpenses':      return adjusted.expenses.totalOperatingExpenses.adjusted;
    case 'loan.loanAmount':                      return adjusted.loan.loanAmount.adjusted;
    case 'loan.interestRate':                    return adjusted.loan.interestRate.adjusted;
    case 'assumptions.capRate':                  return adjusted.assumptions.capRate.adjusted;
  }
}

/* ---------------------------- asset-type filter ----------------------------- */

function appliesToAssetType(
  ruleAssetTypes: readonly AssetType[] | readonly ['all'],
  propertyType: AssetType,
): boolean {
  if (ruleAssetTypes.length === 1 && ruleAssetTypes[0] === 'all') {
    return true;
  }
  return (ruleAssetTypes as readonly AssetType[]).includes(propertyType);
}

/* ---------------------------- predicate evaluation ------------------------- */

function evaluatePredicate(
  currentValue: number,
  threshold: string | number | null,
  op: ManifestoComparisonOperator,
): boolean | 'INSUFFICIENT_DATA' {
  switch (op) {
    case '>':
      return typeof threshold === 'number' && currentValue > threshold;
    case '>=':
      return typeof threshold === 'number' && currentValue >= threshold;
    case '<':
      return typeof threshold === 'number' && currentValue < threshold;
    case '<=':
      return typeof threshold === 'number' && currentValue <= threshold;
    case '==':
      return typeof threshold === 'number' ? currentValue === threshold : false;
    case '!=':
      return typeof threshold === 'number' ? currentValue !== threshold : false;
    case 'contains':
      return typeof threshold === 'string' && String(currentValue).includes(threshold);
    case 'between':
      // v1.0 cannot represent [lo, hi] thresholds in the contract type — skip
      return 'INSUFFICIENT_DATA';
    case 'qualitative':
      return 'INSUFFICIENT_DATA';
  }
}

/* ----------------------------- main entry point --------------------------- */

export function evaluateManifestoRule(args: {
  readonly rule: ManifestoRule;
  readonly adjusted: AdjustedInputs;
  readonly assetProfile: AssetProfile;
}): ManifestoEvaluation {
  const { rule, adjusted, assetProfile } = args;

  // 1. Asset-type filter
  if (!appliesToAssetType(rule.assetTypes, assetProfile.propertyType)) {
    return { fired: false, outcome: null, entry: null };
  }

  // 2. Resolve path
  const path = METRIC_PATH_MAP[rule.metricName];
  if (path === undefined) {
    // Unknown metric — silent skip (manifesto authored against an unmapped name)
    return { fired: false, outcome: null, entry: null };
  }
  const currentValue = resolvePath(adjusted, path);

  // 3. Null → INSUFFICIENT_DATA
  if (currentValue === null) {
    return {
      fired: true,
      outcome: 'INSUFFICIENT_DATA',
      entry: {
        ruleId: rule.ruleId,
        delta: 0,
        reason: `INSUFFICIENT_DATA: ${rule.metricName} is null`,
      },
    };
  }

  // 4. Evaluate predicate
  const predicateResult = evaluatePredicate(currentValue, rule.thresholdValue, rule.comparisonOperator);
  if (predicateResult === 'INSUFFICIENT_DATA') {
    return {
      fired: true,
      outcome: 'INSUFFICIENT_DATA',
      entry: {
        ruleId: rule.ruleId,
        delta: 0,
        reason: `INSUFFICIENT_DATA: ${rule.comparisonOperator} not evaluated in v1.0`,
      },
    };
  }

  // 5. Outcome
  const outcome: ManifestoOutcome = predicateResult ? 'Pass' : rule.outcome;

  // 6. Emit
  return {
    fired: true,
    outcome,
    entry: {
      ruleId: rule.ruleId,
      delta: 0,
      reason: `${outcome}: ${rule.metricName} ${rule.comparisonOperator} ${String(rule.thresholdValue)}`,
    },
  };
}
