/**
 * Doctrine component scorers (Batch 5a).
 *
 * 7 scorers (8 components per spec — `market_alignment` is empty in v1.0 per audit §C):
 *   - scoreMechanical          (3 rules: DSCR, debt yield, LTV)
 *   - scoreDurability          (3 rules: UW vs T-12, concentration, rollover)
 *   - scoreNormalization       (2 rules: vacancy gap, expense growth)
 *   - scoreCapitalization      (2 rules: PCA coverage, TI/LC sizing)
 *   - scoreTermRisk            (1 rule: term DSCR buffer)
 *   - scoreMaturityRisk        (1 rule: refi feasibility stressed)
 *   - scoreDataConfidence      (5 rules: per-doc presence, architecture-weighted)
 *
 * Each scorer is a PURE function: read inputs from upstream records → produce
 * `DoctrineComponentScore[]` (one entry per rule). The orchestrator (Batch 5c) flattens these
 * into `DoctrineEvaluation.componentScores`.
 *
 * Architecture rules (audit §F):
 *   - No raw `ExtractionResult` reads.
 *   - No re-derivation of canonical metrics.
 *   - No write-back to upstream records.
 *   - All reasonCodes are `DoctrineReasonCode` literal-union members.
 *   - Each rule scored 0–100; weight × score / 100 = contribution.
 */

import {
  DOCTRINE_COMPONENT_WEIGHTS,
  DoctrineReasonCodes,
  DoctrineRules,
  type AdjustedInputs,
  type CrossCheckResult,
  type DoctrineComponentScore,
  type DoctrineReasonCode,
  type DoctrineRuleId,
  type NarrativeFacts,
  type StressOutputs,
  type ValuationConclusion,
} from '@cre/contracts';

/* ------------------------------- helpers ---------------------------------- */

interface BuildScoreArgs {
  readonly componentId: DoctrineComponentScore['componentId'];
  readonly ruleId: DoctrineRuleId;
  readonly rawValue: number | null;
  readonly score: number;
  readonly weight: number;
  readonly reasonCodes: readonly DoctrineReasonCode[];
}

function buildScore(args: BuildScoreArgs): DoctrineComponentScore {
  return {
    componentId: args.componentId,
    ruleId: args.ruleId,
    rawValue: args.rawValue,
    score: args.score,
    weight: args.weight,
    contribution: (args.score * args.weight) / 100,
    reasonCodes: args.reasonCodes,
  };
}

const INSUFFICIENT_DATA_SCORE = 0;

/* ------------------------------ mechanical -------------------------------- */

function scoreDscrMechanical(dscr: number | null): number {
  if (dscr === null) return INSUFFICIENT_DATA_SCORE;
  if (dscr >= 1.35) return 100;
  if (dscr >= 1.20) return 80;
  if (dscr >= 1.05) return 55;
  if (dscr >= 0.95) return 40;
  return 20;
}

function scoreDebtYield(dy: number | null): number {
  if (dy === null) return INSUFFICIENT_DATA_SCORE;
  if (dy >= 0.12) return 95;
  if (dy >= 0.10) return 80;
  if (dy >= 0.08) return 55;
  return 30;
}

function scoreLtv(ltv: number | null): number {
  if (ltv === null) return INSUFFICIENT_DATA_SCORE;
  if (ltv <= 0.55) return 95;
  if (ltv <= 0.65) return 80;
  if (ltv <= 0.75) return 55;
  return 30;
}

export function scoreMechanical(inputs: {
  readonly dscr: number | null;
  readonly debtYield: number | null;
  readonly ltvAppraisal: number | null;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.mechanical / 3;
  return [
    buildScore({
      componentId: 'mechanical', ruleId: DoctrineRules.DSCR_LEVEL,
      rawValue: inputs.dscr, score: scoreDscrMechanical(inputs.dscr), weight: w,
      reasonCodes: inputs.dscr === null ? [DoctrineReasonCodes.INSUFFICIENT_DATA] : [],
    }),
    buildScore({
      componentId: 'mechanical', ruleId: DoctrineRules.DEBT_YIELD_LEVEL,
      rawValue: inputs.debtYield, score: scoreDebtYield(inputs.debtYield), weight: w,
      reasonCodes: inputs.debtYield === null ? [DoctrineReasonCodes.INSUFFICIENT_DATA] : [],
    }),
    buildScore({
      componentId: 'mechanical', ruleId: DoctrineRules.LTV_LEVEL,
      rawValue: inputs.ltvAppraisal, score: scoreLtv(inputs.ltvAppraisal), weight: w,
      reasonCodes: inputs.ltvAppraisal === null ? [DoctrineReasonCodes.INSUFFICIENT_DATA] : [],
    }),
  ];
}

/* ------------------------------ durability -------------------------------- */

function scoreUwVsT12Reconciliation(crossCheck: CrossCheckResult | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (crossCheck === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  const noiFinding = crossCheck.findings.find(f => f.metric === 'noi');
  const deltaPct = noiFinding?.delta.vsBankPct ?? null;
  if (deltaPct === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  // Per doctrine YAML §5: delta_pct = (uw - t12) / t12. Negative = conservative.
  if (deltaPct <= -0.10) return { rawValue: deltaPct, score: 95, reasonCodes: [DoctrineReasonCodes.UW_BELOW_T12_CONSERVATIVE] };
  if (deltaPct <=  0.00) return { rawValue: deltaPct, score: 80, reasonCodes: [DoctrineReasonCodes.UW_AT_OR_BELOW_T12] };
  if (deltaPct <=  0.05) return { rawValue: deltaPct, score: 55, reasonCodes: [DoctrineReasonCodes.UW_SLIGHTLY_ABOVE_T12] };
  return { rawValue: deltaPct, score: 25, reasonCodes: [DoctrineReasonCodes.UW_AGGRESSIVE_ABOVE_T12] };
}

function scoreTenantConcentration(top1: number | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (top1 === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  if (top1 <= 0.20) return { rawValue: top1, score: 90, reasonCodes: [DoctrineReasonCodes.TENANT_CONCENTRATION_LOW] };
  if (top1 <= 0.30) return { rawValue: top1, score: 70, reasonCodes: [DoctrineReasonCodes.TENANT_CONCENTRATION_MODERATE] };
  if (top1 <= 0.40) return { rawValue: top1, score: 45, reasonCodes: [DoctrineReasonCodes.TENANT_CONCENTRATION_ELEVATED] };
  return { rawValue: top1, score: 25, reasonCodes: [DoctrineReasonCodes.TENANT_CONCENTRATION_HIGH] };
}

function scoreRollover(pct: number | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (pct === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  if (pct <= 0.15) return { rawValue: pct, score: 90, reasonCodes: [DoctrineReasonCodes.ROLLOVER_LOW] };
  if (pct <= 0.30) return { rawValue: pct, score: 70, reasonCodes: [DoctrineReasonCodes.ROLLOVER_MODERATE] };
  if (pct <= 0.45) return { rawValue: pct, score: 45, reasonCodes: [DoctrineReasonCodes.ROLLOVER_ELEVATED] };
  return { rawValue: pct, score: 25, reasonCodes: [DoctrineReasonCodes.ROLLOVER_HIGH] };
}

export function scoreDurability(inputs: {
  readonly adjustedInputs: AdjustedInputs;
  readonly crossCheck: CrossCheckResult | null;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.durability / 3;
  const m = inputs.adjustedInputs.metrics;

  const uwVsT12 = scoreUwVsT12Reconciliation(inputs.crossCheck);
  const concentration = scoreTenantConcentration(m.top1IncomeShare);
  const rollover = scoreRollover(m.pctIncomeExpiringWithinTerm);

  return [
    buildScore({ componentId: 'durability', ruleId: DoctrineRules.UW_VS_T12_NOI_RECONCILIATION,
      rawValue: uwVsT12.rawValue, score: uwVsT12.score, weight: w, reasonCodes: uwVsT12.reasonCodes }),
    buildScore({ componentId: 'durability', ruleId: DoctrineRules.TENANT_CONCENTRATION,
      rawValue: concentration.rawValue, score: concentration.score, weight: w, reasonCodes: concentration.reasonCodes }),
    buildScore({ componentId: 'durability', ruleId: DoctrineRules.ROLLOVER_WITHIN_TERM,
      rawValue: rollover.rawValue, score: rollover.score, weight: w, reasonCodes: rollover.reasonCodes }),
  ];
}

/* ----------------------------- normalization ------------------------------ */

function scoreVacancyGap(rawVacancy: number | null, trailingOcc: number | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (rawVacancy === null || trailingOcc === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  const trailingVacancy = 1 - trailingOcc;
  const gap = trailingVacancy - rawVacancy;     // positive = uw vacancy below trailing (optimistic)
  if (gap <= 0.00) return { rawValue: gap, score: 90, reasonCodes: [DoctrineReasonCodes.VACANCY_GE_TRAILING_CONSERVATIVE] };
  if (gap <= 0.03) return { rawValue: gap, score: 70, reasonCodes: [DoctrineReasonCodes.VACANCY_SLIGHTLY_OPTIMISTIC] };
  return { rawValue: gap, score: 35, reasonCodes: [DoctrineReasonCodes.VACANCY_TOO_LOW_VS_HISTORY] };
}

function scoreExpenseGrowth(rawOpex: number | null, adjustedOpex: number): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (rawOpex === null || rawOpex <= 0) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  const deltaPct = (adjustedOpex - rawOpex) / rawOpex;
  if (deltaPct >=  0.00) return { rawValue: deltaPct, score: 80, reasonCodes: [DoctrineReasonCodes.EXPENSES_AT_OR_ABOVE_T12] };
  if (deltaPct >= -0.03) return { rawValue: deltaPct, score: 55, reasonCodes: [DoctrineReasonCodes.EXPENSES_SLIGHTLY_BELOW_T12] };
  return { rawValue: deltaPct, score: 30, reasonCodes: [DoctrineReasonCodes.EXPENSES_AGGRESSIVELY_BELOW_T12] };
}

export function scoreNormalization(inputs: {
  readonly adjustedInputs: AdjustedInputs;
  readonly narrativeFacts: NarrativeFacts;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.normalization / 2;
  const ai = inputs.adjustedInputs;

  const vacancy = scoreVacancyGap(ai.income.vacancyPct.raw, inputs.narrativeFacts.trailingOccAvg);
  const expense = scoreExpenseGrowth(
    ai.expenses.totalOperatingExpenses.raw,
    ai.expenses.totalOperatingExpenses.adjusted,
  );

  return [
    buildScore({ componentId: 'normalization', ruleId: DoctrineRules.VACANCY_FLOOR_VS_HISTORY,
      rawValue: vacancy.rawValue, score: vacancy.score, weight: w, reasonCodes: vacancy.reasonCodes }),
    buildScore({ componentId: 'normalization', ruleId: DoctrineRules.EXPENSE_GROWTH_REALISM,
      rawValue: expense.rawValue, score: expense.score, weight: w, reasonCodes: expense.reasonCodes }),
  ];
}

/* ---------------------------- capitalization ------------------------------ */

function scorePcaCoverage(immediate: number | null, upfront: number): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (immediate === null) {
    return { rawValue: null, score: 60, reasonCodes: [DoctrineReasonCodes.PCA_REPAIRS_NOT_QUANTIFIED] };
  }
  if (immediate <= 0) {
    return { rawValue: 0, score: 90, reasonCodes: [DoctrineReasonCodes.PCA_REPAIRS_NOT_QUANTIFIED] };
  }
  const coverage = upfront / immediate;
  if (coverage >= 1.0) return { rawValue: coverage, score: 90, reasonCodes: [DoctrineReasonCodes.PCA_REPAIRS_FULLY_COVERED] };
  if (coverage >= 0.7) return { rawValue: coverage, score: 65, reasonCodes: [DoctrineReasonCodes.PCA_REPAIRS_PARTIALLY_COVERED] };
  return { rawValue: coverage, score: 30, reasonCodes: [DoctrineReasonCodes.PCA_REPAIRS_UNDERFUNDED] };
}

function scoreTiLcSizing(rolloverPct: number | null, upfrontTiLc: number, monthlyTiLc: number): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (rolloverPct === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  if (rolloverPct <= 0.15) {
    return { rawValue: rolloverPct, score: 80, reasonCodes: [DoctrineReasonCodes.TILC_NOT_REQUIRED_LOW_ROLLOVER] };
  }
  const hasTiLc = upfrontTiLc > 0 || monthlyTiLc > 0;
  if (rolloverPct > 0.30 && !hasTiLc) {
    return { rawValue: rolloverPct, score: 25, reasonCodes: [DoctrineReasonCodes.TILC_UNFUNDED_HIGH_ROLLOVER] };
  }
  if (hasTiLc) {
    return { rawValue: rolloverPct, score: 80, reasonCodes: [DoctrineReasonCodes.TILC_FUNDED_FOR_ROLLOVER] };
  }
  return { rawValue: rolloverPct, score: 55, reasonCodes: [DoctrineReasonCodes.TILC_FUNDED_DEFAULT] };
}

export function scoreCapitalization(inputs: {
  readonly adjustedInputs: AdjustedInputs;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.capitalization / 2;
  const ai = inputs.adjustedInputs;

  const pca = scorePcaCoverage(
    ai.capitalReserves.pcaImmediateRepairs.raw,
    ai.capitalReserves.upfrontCapex.adjusted,
  );
  const tilc = scoreTiLcSizing(
    ai.metrics.pctIncomeExpiringWithinTerm,
    ai.capitalReserves.upfrontTiLc.adjusted,
    ai.capitalReserves.monthlyTiLc.adjusted,
  );

  return [
    buildScore({ componentId: 'capitalization', ruleId: DoctrineRules.PCA_IMMEDIATE_REPAIRS_COVERED,
      rawValue: pca.rawValue, score: pca.score, weight: w, reasonCodes: pca.reasonCodes }),
    buildScore({ componentId: 'capitalization', ruleId: DoctrineRules.TI_LC_VS_ROLLOVER,
      rawValue: tilc.rawValue, score: tilc.score, weight: w, reasonCodes: tilc.reasonCodes }),
  ];
}

/* ------------------------------- term risk -------------------------------- */

function scoreTermDscr(dscr: number | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (dscr === null) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  if (dscr >= 1.25) return { rawValue: dscr, score: 85, reasonCodes: [DoctrineReasonCodes.TERM_DSCR_STRONG] };
  if (dscr >= 1.10) return { rawValue: dscr, score: 60, reasonCodes: [DoctrineReasonCodes.TERM_DSCR_ADEQUATE] };
  return { rawValue: dscr, score: 35, reasonCodes: [DoctrineReasonCodes.TERM_DSCR_THIN] };
}

export function scoreTermRisk(inputs: {
  readonly adjustedInputs: AdjustedInputs;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.term_risk;
  const r = scoreTermDscr(inputs.adjustedInputs.metrics.dscr);
  return [
    buildScore({ componentId: 'term_risk', ruleId: DoctrineRules.TERM_DSCR_BUFFER,
      rawValue: r.rawValue, score: r.score, weight: w, reasonCodes: r.reasonCodes }),
  ];
}

/* ----------------------------- maturity risk ------------------------------ */

function scoreRefiFeasibility(maturityBalance: number, downsideValue: number | null): {
  rawValue: number | null; score: number; reasonCodes: DoctrineReasonCode[];
} {
  if (downsideValue === null || downsideValue <= 0) {
    return { rawValue: null, score: INSUFFICIENT_DATA_SCORE, reasonCodes: [DoctrineReasonCodes.INSUFFICIENT_DATA] };
  }
  const stressedLtv = maturityBalance / downsideValue;
  if (stressedLtv <= 0.70) return { rawValue: stressedLtv, score: 80, reasonCodes: [DoctrineReasonCodes.MATURITY_REFI_FEASIBLE] };
  if (stressedLtv <= 0.85) return { rawValue: stressedLtv, score: 55, reasonCodes: [DoctrineReasonCodes.MATURITY_REFI_BORDERLINE] };
  return { rawValue: stressedLtv, score: 25, reasonCodes: [DoctrineReasonCodes.MATURITY_REFI_INFEASIBLE] };
}

export function scoreMaturityRisk(inputs: {
  readonly adjustedInputs: AdjustedInputs;
  readonly valuationConclusion: ValuationConclusion;
}): readonly DoctrineComponentScore[] {
  const w = DOCTRINE_COMPONENT_WEIGHTS.maturity_risk;
  const r = scoreRefiFeasibility(
    inputs.adjustedInputs.loan.maturityBalance.adjusted,
    inputs.valuationConclusion.downsideValue,
  );
  return [
    buildScore({ componentId: 'maturity_risk', ruleId: DoctrineRules.REFI_FEASIBILITY_STRESSED,
      rawValue: r.rawValue, score: r.score, weight: w, reasonCodes: r.reasonCodes }),
  ];
}

/* ---------------------------- data confidence ----------------------------- */

/**
 * Per-doc rule configuration. Weights mirror architecture §1 penalty points (12, 12, 10, 6, 4
 * → sum 44 → normalized to data_confidence's 3-point component weight).
 */
const DATA_CONFIDENCE_RULES: readonly {
  ruleId: DoctrineRuleId;
  jeFlag: import('@cre/contracts').JudgmentEngineRuleId;
  reasonIfMissing: DoctrineReasonCode;
  penaltyPoints: number;
}[] = [
  { ruleId: DoctrineRules.RENT_ROLL_MISSING, jeFlag: 'JE_RENT_ROLL_MISSING', reasonIfMissing: DoctrineReasonCodes.RENT_ROLL_MISSING, penaltyPoints: 12 },
  { ruleId: DoctrineRules.T12_MISSING,        jeFlag: 'JE_T12_MISSING',        reasonIfMissing: DoctrineReasonCodes.T12_MISSING,        penaltyPoints: 12 },
  { ruleId: DoctrineRules.LOAN_TERMS_MISSING, jeFlag: 'JE_LOAN_TERMS_MISSING', reasonIfMissing: DoctrineReasonCodes.LOAN_TERMS_MISSING, penaltyPoints: 10 },
  { ruleId: DoctrineRules.PCA_MISSING,        jeFlag: 'JE_PCA_MISSING',        reasonIfMissing: DoctrineReasonCodes.PCA_MISSING,        penaltyPoints: 6 },
  { ruleId: DoctrineRules.APPRAISAL_MISSING,  jeFlag: 'JE_APPRAISAL_MISSING',  reasonIfMissing: DoctrineReasonCodes.APPRAISAL_MISSING,  penaltyPoints: 4 },
];

const TOTAL_PENALTY_POINTS = DATA_CONFIDENCE_RULES.reduce((s, r) => s + r.penaltyPoints, 0); // 44

export function scoreDataConfidence(inputs: {
  readonly adjustedInputs: AdjustedInputs;
}): readonly DoctrineComponentScore[] {
  const componentWeight = DOCTRINE_COMPONENT_WEIGHTS.data_confidence; // 3
  return DATA_CONFIDENCE_RULES.map(rule => {
    const isMissing = inputs.adjustedInputs.dataQualityFlags.includes(rule.jeFlag);
    const score = isMissing ? 0 : 100;
    const ruleWeight = (rule.penaltyPoints / TOTAL_PENALTY_POINTS) * componentWeight;
    return buildScore({
      componentId: 'data_confidence',
      ruleId: rule.ruleId,
      rawValue: isMissing ? 0 : 1,
      score,
      weight: ruleWeight,
      reasonCodes: isMissing ? [rule.reasonIfMissing] : [],
    });
  });
}

/* ---------------------------- stress accessor ----------------------------- */

/** Helper for components that read worst-case stress NOI/DSCR. Imported by the orchestrator. */
export function pickWorstStressDscr(stress: StressOutputs): number | null {
  const dscrs = stress.scenarios.map(s => s.dscr).filter((d): d is number => d !== null);
  return dscrs.length > 0 ? Math.min(...dscrs) : null;
}
