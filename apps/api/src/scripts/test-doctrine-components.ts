/**
 * Tests for doctrine component scorers (Batch 5a).
 *
 *   npm run test:doctrine-components
 *
 * Each scorer verified at threshold boundaries + null inputs + reason-code emission.
 */

import {
  ASSET_TYPES,
  DOCTRINE_COMPONENT_WEIGHTS,
  type AdjustedInputs,
  type AdjustedLineItem,
  type AssetType,
  type ContentHash,
  type CrossCheckResult,
  type NarrativeFacts,
  type ValuationConclusion,
} from '@cre/contracts';
import {
  scoreCapitalization,
  scoreDataConfidence,
  scoreDurability,
  scoreMaturityRisk,
  scoreMechanical,
  scoreNormalization,
  scoreTermRisk,
} from '../services/doctrine/components.js';
import {
  computeAdjustedInputsId,
  computeCrossCheckResultId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
  computeStressOutputsId,
  computeValuationConclusionId,
} from '../util/content-hash.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}

/* ------------------------------- fixtures -------------------------------- */

function lineItem(value: number, raw: number | null = value): AdjustedLineItem {
  return { raw, adjusted: value, source: 'BANK', adjustments: [] };
}

function makeAdjustedInputs(opts: Partial<{
  noi: number | null;
  dscr: number | null;
  ltvAppraisal: number | null;
  debtYield: number | null;
  top1IncomeShare: number | null;
  pctIncomeExpiringWithinTerm: number | null;
  rawVacancy: number | null;
  rawOpex: number | null;
  adjustedOpex: number;
  pcaImmediate: number | null;
  upfrontCapex: number;
  upfrontTiLc: number;
  monthlyTiLc: number;
  maturityBalance: number;
  dataQualityFlags: import('@cre/contracts').JudgmentEngineRuleId[];
}> = {}): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: '1.0' as const,
    librarySnapshotId: computeLibrarySnapshotId({ x: 1 }),
    income: {
      grossRentalIncome: lineItem(1_000_000),
      otherIncome: lineItem(0),
      vacancyPct: lineItem(0.10, opts.rawVacancy === undefined ? 0.05 : opts.rawVacancy),
      concessionsPct: lineItem(0),
      effectiveGrossIncome: lineItem(900_000),
    },
    expenses: {
      realEstateTaxes: lineItem(80_000), insurance: lineItem(15_000),
      utilities: lineItem(20_000), managementFee: lineItem(28_000),
      payroll: lineItem(0), maintenance: lineItem(30_000),
      other: lineItem(0),
      totalOperatingExpenses: lineItem(opts.adjustedOpex ?? 250_000, opts.rawOpex === undefined ? 200_000 : opts.rawOpex),
    },
    capitalReserves: {
      upfrontCapex: lineItem(opts.upfrontCapex ?? 0),
      upfrontTiLc: lineItem(opts.upfrontTiLc ?? 0),
      monthlyCapex: lineItem(0),
      monthlyTiLc: lineItem(opts.monthlyTiLc ?? 0),
      pcaImmediateRepairs: lineItem(opts.pcaImmediate ?? 0, opts.pcaImmediate === undefined ? null : opts.pcaImmediate),
    },
    loan: {
      loanAmount: lineItem(10_000_000),
      interestRate: lineItem(0.07),
      termMonths: lineItem(120), amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0),
      maturityBalance: lineItem(opts.maturityBalance ?? 9_000_000),
      debtServiceAnnual: lineItem(800_000),
    },
    assumptions: {
      capRate: lineItem(0.065), terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03), expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: opts.noi === undefined ? 800_000 : opts.noi,
      value: 12_307_692,
      dscr: opts.dscr === undefined ? 1.30 : opts.dscr,
      ltvAppraisal: opts.ltvAppraisal === undefined ? 0.60 : opts.ltvAppraisal,
      debtYield: opts.debtYield === undefined ? 0.10 : opts.debtYield,
      expenseRatio: 0.25,
      top1IncomeShare: opts.top1IncomeShare === undefined ? 0.25 : opts.top1IncomeShare,
      pctIncomeExpiringWithinTerm: opts.pctIncomeExpiringWithinTerm === undefined ? 0.20 : opts.pctIncomeExpiringWithinTerm,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: opts.dataQualityFlags ?? [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function makeNarrativeFacts(opts: { trailingOccAvg?: number | null } = {}): NarrativeFacts {
  const body = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: opts.trailingOccAvg === undefined ? 0.95 : opts.trailingOccAvg,
    occupancyCurrent: 0.95, propertyClass: 'A' as const,
    shadowVacancyFlag: false, subleaseCompetition: 'low' as const,
    leasingVelocityDataAvailable: true,
    isMall: null, franchiseExpirationWithinTerm: null,
    pipRequired: null, pipBudgetPerKey: null,
    privateWastewater: null, parkOwnedHomesPct: null,
    t12NoiTrend: 'flat' as const, isSingleTenant: false,
    appraisalValue: 12_500_000, appraisalCapRate: 0.065,
    asrValue: null, marketValueFromComps: null,
    exitCapRateBase: 0.065, exitCapRateStressed: 0.075,
  };
  return { id: computeNarrativeFactsId(body), ...body } as NarrativeFacts;
}

function makeCrossCheck(noiDeltaPct: number | null): CrossCheckResult {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId: computeAdjustedInputsId({ x: 1 }),
    findings: noiDeltaPct === null ? [] : [
      {
        metric: 'noi',
        bank: { value: 800_000, source: 'T12_ACTUAL' as const },
        rawExtracted: { value: 800_000, source: 'T12_ACTUAL' as const },
        adjusted: { value: 800_000 * (1 + noiDeltaPct) },
        bpFinal: { value: 800_000 * (1 + noiDeltaPct) },
        drivers: [],
        delta: { vsBank: 800_000 * noiDeltaPct, vsBankPct: noiDeltaPct },
        conservatismStatus: 'NEUTRAL' as const,
      },
    ],
    overallAdjustmentBias: 'neutral' as const,
  };
  return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
}

function makeValuation(downsideValue: number | null): ValuationConclusion {
  const body = {
    analysisAsOfDate: AS_OF, valuationEngineVersion: '1.0' as const,
    adjustedInputsId: computeAdjustedInputsId({ x: 1 }),
    stressOutputsId: computeStressOutputsId({ x: 1 }),
    narrativeFactsId: computeNarrativeFactsId({ x: 1 }),
    uwValue: 12_000_000, marketValue: null,
    downsideValue, finalValue: downsideValue,
    appraisalValue: 12_500_000, asrValue: null,
    capsApplied: [], haircutsApplied: [], valuationFlags: [],
    anchorUsed: 'appraisal' as const,
  };
  return { id: computeValuationConclusionId(body), ...body } as ValuationConclusion;
}

/* ------------------------------- mechanical ------------------------------- */

console.log('Mechanical:');
{
  const r = scoreMechanical({ dscr: 1.40, debtYield: 0.13, ltvAppraisal: 0.50 });
  assertEqual(r.length, 3, '3 entries');
  const dscr = r.find(s => s.ruleId === 'DSCR_LEVEL')!;
  assertEqual(dscr.score, 100, 'DSCR 1.40 → 100');
  const dy = r.find(s => s.ruleId === 'DEBT_YIELD_LEVEL')!;
  assertEqual(dy.score, 95, 'DY 0.13 → 95');
  const ltv = r.find(s => s.ruleId === 'LTV_LEVEL')!;
  assertEqual(ltv.score, 95, 'LTV 0.50 → 95');
  assertClose(dscr.weight + dy.weight + ltv.weight, DOCTRINE_COMPONENT_WEIGHTS.mechanical, 1e-9,
    'weights sum to component weight');
}
{
  // Threshold boundaries
  const r = scoreMechanical({ dscr: 1.20, debtYield: 0.10, ltvAppraisal: 0.65 });
  assertEqual(r.find(s => s.ruleId === 'DSCR_LEVEL')!.score, 80, 'DSCR 1.20 → 80 (boundary)');
  assertEqual(r.find(s => s.ruleId === 'DEBT_YIELD_LEVEL')!.score, 80, 'DY 0.10 → 80 (boundary)');
  assertEqual(r.find(s => s.ruleId === 'LTV_LEVEL')!.score, 80, 'LTV 0.65 → 80 (boundary)');
}
{
  // Below all thresholds
  const r = scoreMechanical({ dscr: 0.80, debtYield: 0.05, ltvAppraisal: 0.85 });
  assertEqual(r.find(s => s.ruleId === 'DSCR_LEVEL')!.score, 20, 'DSCR 0.80 → 20');
  assertEqual(r.find(s => s.ruleId === 'DEBT_YIELD_LEVEL')!.score, 30, 'DY 0.05 → 30');
  assertEqual(r.find(s => s.ruleId === 'LTV_LEVEL')!.score, 30, 'LTV 0.85 → 30');
}
{
  // Null inputs → INSUFFICIENT_DATA
  const r = scoreMechanical({ dscr: null, debtYield: null, ltvAppraisal: null });
  for (const s of r) {
    assert(s.reasonCodes.includes('INSUFFICIENT_DATA'), `${s.ruleId} INSUFFICIENT_DATA on null input`);
    assertEqual(s.score, 0, `${s.ruleId} score 0 on null`);
  }
}

/* ------------------------------- durability ------------------------------- */

console.log('\nDurability:');
{
  const r = scoreDurability({
    adjustedInputs: makeAdjustedInputs({ top1IncomeShare: 0.25, pctIncomeExpiringWithinTerm: 0.20 }),
    crossCheck: makeCrossCheck(-0.05), // UW slightly below T-12 (conservative)
  });
  assertEqual(r.length, 3, '3 entries');
  const uw = r.find(s => s.ruleId === 'UW_VS_T12_NOI_RECONCILIATION')!;
  assertEqual(uw.score, 80, 'UW at/below T-12 → 80');
  assert(uw.reasonCodes.includes('UW_AT_OR_BELOW_T12'), 'UW_AT_OR_BELOW_T12 reason');

  const conc = r.find(s => s.ruleId === 'TENANT_CONCENTRATION')!;
  assertEqual(conc.score, 70, 'top1 0.25 → moderate (70)');
  assert(conc.reasonCodes.includes('TENANT_CONCENTRATION_MODERATE'), 'moderate reason');

  const roll = r.find(s => s.ruleId === 'ROLLOVER_WITHIN_TERM')!;
  assertEqual(roll.score, 70, 'rollover 0.20 → moderate');
}
{
  // Aggressive UW (delta > 10%)
  const r = scoreDurability({
    adjustedInputs: makeAdjustedInputs(),
    crossCheck: makeCrossCheck(0.15),
  });
  const uw = r.find(s => s.ruleId === 'UW_VS_T12_NOI_RECONCILIATION')!;
  assertEqual(uw.score, 25, 'UW aggressive above T-12 → 25');
  assert(uw.reasonCodes.includes('UW_AGGRESSIVE_ABOVE_T12'), 'aggressive reason');
}
{
  // Missing CrossCheckResult → INSUFFICIENT_DATA
  const r = scoreDurability({
    adjustedInputs: makeAdjustedInputs(),
    crossCheck: null,
  });
  const uw = r.find(s => s.ruleId === 'UW_VS_T12_NOI_RECONCILIATION')!;
  assertEqual(uw.score, 0, 'no cross-check → 0');
  assert(uw.reasonCodes.includes('INSUFFICIENT_DATA'), 'no cross-check → INSUFFICIENT_DATA');
}
{
  // High concentration
  const r = scoreDurability({
    adjustedInputs: makeAdjustedInputs({ top1IncomeShare: 0.50 }),
    crossCheck: makeCrossCheck(0),
  });
  const conc = r.find(s => s.ruleId === 'TENANT_CONCENTRATION')!;
  assertEqual(conc.score, 25, 'top1 0.50 → high (25)');
}

/* ------------------------------ normalization ----------------------------- */

console.log('\nNormalization:');
{
  // Vacancy: rawVacancy 0.10 vs trailingVacancy 0.05 → gap = -0.05 (uw above trailing, conservative)
  const r = scoreNormalization({
    adjustedInputs: makeAdjustedInputs({ rawVacancy: 0.10 }),
    narrativeFacts: makeNarrativeFacts({ trailingOccAvg: 0.95 }),
  });
  const vac = r.find(s => s.ruleId === 'VACANCY_FLOOR_VS_HISTORY')!;
  assertEqual(vac.score, 90, 'uw vacancy ≥ trailing → 90');
  assert(vac.reasonCodes.includes('VACANCY_GE_TRAILING_CONSERVATIVE'), 'conservative reason');
}
{
  // rawVacancy 0.025 vs trailingVacancy 0.05 → gap = 0.025 (slightly optimistic; cleanly < 0.03)
  const r = scoreNormalization({
    adjustedInputs: makeAdjustedInputs({ rawVacancy: 0.025 }),
    narrativeFacts: makeNarrativeFacts({ trailingOccAvg: 0.95 }),
  });
  const vac = r.find(s => s.ruleId === 'VACANCY_FLOOR_VS_HISTORY')!;
  assertEqual(vac.score, 70, 'gap 0.025 → 70 (slightly optimistic)');
}
{
  // rawVacancy 0.00 vs trailingVacancy 0.10 → gap 0.10 (too low vs history)
  const r = scoreNormalization({
    adjustedInputs: makeAdjustedInputs({ rawVacancy: 0.00 }),
    narrativeFacts: makeNarrativeFacts({ trailingOccAvg: 0.90 }),
  });
  const vac = r.find(s => s.ruleId === 'VACANCY_FLOOR_VS_HISTORY')!;
  assertEqual(vac.score, 35, 'gap 0.10 → 35 (too low vs history)');
}
{
  // Expense growth: rawOpex 200k, adjustedOpex 250k → delta +0.25 (above T-12, conservative)
  const r = scoreNormalization({
    adjustedInputs: makeAdjustedInputs({ rawOpex: 200_000, adjustedOpex: 250_000 }),
    narrativeFacts: makeNarrativeFacts(),
  });
  const exp = r.find(s => s.ruleId === 'EXPENSE_GROWTH_REALISM')!;
  assertEqual(exp.score, 80, 'delta +0.25 → 80 (at or above T-12)');
}
{
  // rawOpex 200k, adjustedOpex 180k → delta -0.10 (aggressive)
  const r = scoreNormalization({
    adjustedInputs: makeAdjustedInputs({ rawOpex: 200_000, adjustedOpex: 180_000 }),
    narrativeFacts: makeNarrativeFacts(),
  });
  const exp = r.find(s => s.ruleId === 'EXPENSE_GROWTH_REALISM')!;
  assertEqual(exp.score, 30, 'delta -0.10 → 30 (aggressive)');
}

/* ----------------------------- capitalization ----------------------------- */

console.log('\nCapitalization:');
{
  // PCA: immediate 50k, upfront 60k → coverage 1.2 → fully covered
  const r = scoreCapitalization({
    adjustedInputs: makeAdjustedInputs({ pcaImmediate: 50_000, upfrontCapex: 60_000 }),
  });
  const pca = r.find(s => s.ruleId === 'PCA_IMMEDIATE_REPAIRS_COVERED')!;
  assertEqual(pca.score, 90, 'PCA fully covered → 90');
}
{
  // PCA: immediate 100k, upfront 80k → coverage 0.8 → partial
  const r = scoreCapitalization({
    adjustedInputs: makeAdjustedInputs({ pcaImmediate: 100_000, upfrontCapex: 80_000 }),
  });
  assertEqual(r.find(s => s.ruleId === 'PCA_IMMEDIATE_REPAIRS_COVERED')!.score, 65, 'partial coverage');
}
{
  // PCA: immediate 100k, upfront 50k → coverage 0.5 → underfunded
  const r = scoreCapitalization({
    adjustedInputs: makeAdjustedInputs({ pcaImmediate: 100_000, upfrontCapex: 50_000 }),
  });
  assertEqual(r.find(s => s.ruleId === 'PCA_IMMEDIATE_REPAIRS_COVERED')!.score, 30, 'underfunded');
}
{
  // TI/LC: high rollover, no reserves → unfunded high
  const r = scoreCapitalization({
    adjustedInputs: makeAdjustedInputs({
      pctIncomeExpiringWithinTerm: 0.40, upfrontTiLc: 0, monthlyTiLc: 0,
    }),
  });
  const tilc = r.find(s => s.ruleId === 'TI_LC_VS_ROLLOVER')!;
  assertEqual(tilc.score, 25, 'rollover > 30% with no reserves → 25');
  assert(tilc.reasonCodes.includes('TILC_UNFUNDED_HIGH_ROLLOVER'), 'unfunded reason');
}
{
  // Low rollover → not required
  const r = scoreCapitalization({
    adjustedInputs: makeAdjustedInputs({ pctIncomeExpiringWithinTerm: 0.10 }),
  });
  const tilc = r.find(s => s.ruleId === 'TI_LC_VS_ROLLOVER')!;
  assertEqual(tilc.score, 80, 'low rollover → 80 (not required)');
}

/* ------------------------------- term risk -------------------------------- */

console.log('\nTerm risk:');
{
  const r = scoreTermRisk({ adjustedInputs: makeAdjustedInputs({ dscr: 1.30 }) });
  assertEqual(r.length, 1, '1 entry');
  assertEqual(r[0]?.score ?? -1, 85, 'DSCR 1.30 → strong (85)');
}
{
  const r = scoreTermRisk({ adjustedInputs: makeAdjustedInputs({ dscr: 1.15 }) });
  assertEqual(r[0]?.score ?? -1, 60, 'DSCR 1.15 → adequate (60)');
}
{
  const r = scoreTermRisk({ adjustedInputs: makeAdjustedInputs({ dscr: 1.00 }) });
  assertEqual(r[0]?.score ?? -1, 35, 'DSCR 1.00 → thin (35)');
}

/* ----------------------------- maturity risk ------------------------------ */

console.log('\nMaturity risk:');
{
  // Maturity 5M, downside 10M → stressed LTV 0.50 → feasible
  const r = scoreMaturityRisk({
    adjustedInputs: makeAdjustedInputs({ maturityBalance: 5_000_000 }),
    valuationConclusion: makeValuation(10_000_000),
  });
  assertEqual(r[0]?.score ?? -1, 80, 'stressed LTV 0.50 → feasible (80)');
}
{
  // Maturity 8M, downside 10M → stressed LTV 0.80 → borderline
  const r = scoreMaturityRisk({
    adjustedInputs: makeAdjustedInputs({ maturityBalance: 8_000_000 }),
    valuationConclusion: makeValuation(10_000_000),
  });
  assertEqual(r[0]?.score ?? -1, 55, 'stressed LTV 0.80 → borderline (55)');
}
{
  // Maturity 9M, downside 10M → stressed LTV 0.90 → infeasible
  const r = scoreMaturityRisk({
    adjustedInputs: makeAdjustedInputs({ maturityBalance: 9_000_000 }),
    valuationConclusion: makeValuation(10_000_000),
  });
  assertEqual(r[0]?.score ?? -1, 25, 'stressed LTV 0.90 → infeasible (25)');
}
{
  const r = scoreMaturityRisk({
    adjustedInputs: makeAdjustedInputs(),
    valuationConclusion: makeValuation(null),
  });
  assertEqual(r[0]?.score ?? -1, 0, 'null downside → INSUFFICIENT_DATA');
}

/* ---------------------------- data confidence ----------------------------- */

console.log('\nData confidence:');
{
  // No flags → all 5 rules pass (score 100 each)
  const r = scoreDataConfidence({ adjustedInputs: makeAdjustedInputs() });
  assertEqual(r.length, 5, '5 per-doc entries');
  for (const s of r) assertEqual(s.score, 100, `${s.ruleId} present → 100`);
  const totalContribution = r.reduce((sum, s) => sum + s.contribution, 0);
  assertClose(totalContribution, DOCTRINE_COMPONENT_WEIGHTS.data_confidence, 1e-9,
    'all docs present → full contribution = data_confidence weight (3)');
}
{
  // Rent roll missing → that rule scores 0; others score 100
  const r = scoreDataConfidence({
    adjustedInputs: makeAdjustedInputs({ dataQualityFlags: ['JE_RENT_ROLL_MISSING'] }),
  });
  const rr = r.find(s => s.ruleId === 'RENT_ROLL_MISSING')!;
  assertEqual(rr.score, 0, 'rent roll missing → 0');
  assert(rr.reasonCodes.includes('RENT_ROLL_MISSING'), 'reason emitted');

  const t12 = r.find(s => s.ruleId === 'T12_MISSING')!;
  assertEqual(t12.score, 100, 't12 present → 100');
}
{
  // All 5 missing → contribution = 0
  const r = scoreDataConfidence({
    adjustedInputs: makeAdjustedInputs({
      dataQualityFlags: ['JE_RENT_ROLL_MISSING', 'JE_T12_MISSING', 'JE_LOAN_TERMS_MISSING', 'JE_PCA_MISSING', 'JE_APPRAISAL_MISSING'],
    }),
  });
  const totalContribution = r.reduce((sum, s) => sum + s.contribution, 0);
  assertEqual(totalContribution, 0, 'all docs missing → 0 contribution');
}

/* ------------------------- contribution math sanity ----------------------- */

console.log('\nContribution math:');
{
  const r = scoreMechanical({ dscr: 1.40, debtYield: 0.13, ltvAppraisal: 0.50 });
  for (const s of r) {
    assertClose(s.contribution, (s.score * s.weight) / 100, 1e-9,
      `${s.ruleId} contribution = score × weight / 100`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
