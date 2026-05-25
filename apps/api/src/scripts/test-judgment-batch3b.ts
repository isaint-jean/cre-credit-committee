/**
 * Tests for Batch 3b: source cascades, library lookup, manifesto evaluator, NOI cap,
 * confidence-reduction math.
 *
 *   npm run test:judgment-batch3b
 */

import {
  ASSET_TYPES,
  type AssetType,
  type ContentHash,
  type ExtractionResult,
  type LibrarySnapshot,
  type ManifestoRule,
  type CreditManifestoRuleId,
  type AssetProfile,
  type AdjustedInputs,
  type AdjustedLineItem,
  type SourceTier,
} from '@cre/contracts';
import {
  bankNoiCascade,
  capRateCascade,
  pickFirstNonNull,
  vacancyPctCascade,
} from '../services/judgment/source-cascade.js';
import {
  getLibraryDistribution,
  getLibraryMedian,
  getLibraryStats,
} from '../services/judgment/library-lookup.js';
import { evaluateManifestoRule } from '../services/judgment/manifesto-evaluator.js';
import { applyNoiCap } from '../services/judgment/noi-cap.js';
import {
  computeConfidenceReduction,
  penaltyWeightFor,
} from '../services/judgment/confidence-reduction.js';
import { computeAssetProfileId } from '../util/content-hash.js';

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

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function lineItem(value: number): AdjustedLineItem {
  return { raw: value, adjusted: value, source: 'BANK' as SourceTier, adjustments: [] };
}

function makeAdjustedInputs(overrides: { vacancyPct?: number; dscr?: number | null; capRate?: number; ltv?: number | null } = {}): AdjustedInputs {
  return {
    id: 'a'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: '1.2',
    librarySnapshotId: 'b'.repeat(64) as never,
    income: {
      grossRentalIncome: lineItem(10_000_000),
      otherIncome: lineItem(0),
      vacancyPct: lineItem(overrides.vacancyPct ?? 0.05),
      concessionsPct: lineItem(0),
      effectiveGrossIncome: lineItem(9_500_000),
    },
    expenses: {
      realEstateTaxes: lineItem(800_000), insurance: lineItem(150_000),
      utilities: lineItem(200_000), managementFee: lineItem(280_000),
      payroll: lineItem(0), maintenance: lineItem(300_000),
      other: lineItem(100_000),
      generalAndAdmin: lineItem(0), janitorial: lineItem(0), reimbursements: lineItem(0),
      totalOperatingExpenses: lineItem(1_830_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0), upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0), monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0), monthlyTenantImprovements: lineItem(0), monthlyLeasingCommissions: lineItem(0),
      pcaImmediateRepairs: lineItem(0),
      upfrontReplacementReserves: lineItem(0),
      capexScheduleInflated: null,
      capexScheduleUninflated: null,
    },
    loan: {
      loanAmount: lineItem(50_000_000), interestRate: lineItem(0.07),
      termMonths: lineItem(120), amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0), maturityBalance: lineItem(45_000_000),
      debtServiceAnnual: lineItem(4_000_000),
    },
    assumptions: {
      capRate: lineItem(overrides.capRate ?? 0.065),
      terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03),
      expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 7_670_000, value: 118_000_000,
      dscr: overrides.dscr === undefined ? 1.92 : overrides.dscr,
      ltvAppraisal: overrides.ltv === undefined ? 0.42 : overrides.ltv,
      debtYield: 0.1534, expenseRatio: 0.193,
      top1IncomeShare: 0.30, pctIncomeExpiringWithinTerm: 0.22,
    },
    confidenceReduction: 0.05,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  const base: ExtractionResult = {
    id: 'c'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: '1.4',
    dealRef: 'TEST-1',
    rentRoll: null, t12: null, pca: null,
    appraisal: null, sellerUw: null, sellerUwOperatingStatement: null, asr: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { ...base, ...overrides };
}

function makeProfile(propertyType: AssetType): AssetProfile {
  const body = { propertyType, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeRule(opts: Partial<ManifestoRule> & { metricName: string }): ManifestoRule {
  return {
    ruleId: 'rule-x' as CreditManifestoRuleId,
    condition: 'test',
    thresholdValue: 1.20,
    comparisonOperator: '>=',
    outcome: 'Fail',
    weight: 10,
    assetTypes: ['all'],
    sourceText: '',
    pageReference: null,
    ...opts,
  };
}

/* ---------------------------- source-cascade tests ------------------------- */

console.log('Source cascade — pickFirstNonNull:');
{
  const r = pickFirstNonNull([
    { tier: 'T12_ACTUAL', value: null },
    { tier: 'SELLER_UW', value: 0.05 },
    { tier: 'ASR', value: 0.04 },
  ]);
  assertEqual(r.tier, 'SELLER_UW', 'picks first non-null');
  assertEqual(r.value, 0.05, 'value preserved');
}
{
  const r = pickFirstNonNull([
    { tier: 'T12_ACTUAL', value: null },
    { tier: 'SELLER_UW', value: null },
  ]);
  assertEqual(r.tier, 'MANUAL', 'all null → MANUAL');
  assertEqual(r.value, null, 'all null → null value');
}
{
  const r = pickFirstNonNull([{ tier: 'T12_ACTUAL', value: 0 }]);
  assertEqual(r.tier, 'T12_ACTUAL', 'zero is not null');
  assertEqual(r.value, 0, 'zero preserved');
}

console.log('\nSource cascade — vacancyPctCascade:');
{
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.03 },
    sellerUwOperatingStatement: null,
  });
  const cs = vacancyPctCascade(ext);
  const picked = pickFirstNonNull(cs);
  assertEqual(picked.tier, 'T12_ACTUAL', 'T-12 preferred when both present');
  assertClose(picked.value as number, 0.05, 1e-9, 'T-12 vacancy = 60k/1.2M = 0.05');
}
{
  const ext = makeExtraction({
    sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.03 },
    sellerUwOperatingStatement: null,
  });
  const picked = pickFirstNonNull(vacancyPctCascade(ext));
  assertEqual(picked.tier, 'SELLER_UW', 'falls back to seller UW when no T-12');
  assertEqual(picked.value, 0.03, 'seller UW vacancy preserved');
}

console.log('\nSource cascade — capRateCascade:');
{
  const ext = makeExtraction({
    appraisal: { valueConclusion: 100_000_000, capRate: 0.06, methodology: null },
    asr: { impliedValue: 110_000_000, impliedCapRate: 0.055, underwrittenNOI: null },
  });
  const picked = pickFirstNonNull(capRateCascade(ext));
  assertEqual(picked.tier, 'APPRAISAL', 'appraisal preferred over ASR');
  assertEqual(picked.value, 0.06, 'appraisal cap rate preserved');
}

console.log('\nSource cascade — bankNoiCascade:');
{
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: 950_000, vacancyLoss: null,
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const picked = pickFirstNonNull(bankNoiCascade(ext));
  assertEqual(picked.value, 950_000, 'T-12 NOI as bank NOI');
}

/* ---------------------------- library-lookup tests ------------------------ */

function makeSnapshot(officeMedian: number = 0.10, multifamilyDist: boolean = false): LibrarySnapshot {
  const byAssetType = emptyByAssetType() as { [K in AssetType]: ReturnType<typeof getLibraryDistribution> };
  byAssetType.Office = {
    vacancy: { median: officeMedian, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.40, p25: 0.35, p75: 0.45 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  if (multifamilyDist) {
    byAssetType.Multifamily = {
      vacancy: { median: 0.05, p25: 0.04, p75: 0.06 },
      expenseRatio: { median: 0.40, p25: 0.36, p75: 0.44 },
      capRate: { median: 0.055, p25: 0.05, p75: 0.06 },
      dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
      treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
      n: 25,
    };
  }
  return {
    id: 'd'.repeat(64) as never,
    asOf: AS_OF,
    approvedDealsTableHash: 'e'.repeat(64) as ContentHash,
    byAssetType,
  };
}

console.log('\nLibrary lookup:');
{
  const snap = makeSnapshot();
  const dist = getLibraryDistribution(snap, 'Office');
  assert(dist !== null, 'Office distribution present');
  if (dist) assertEqual(dist.n, 25, 'Office n=25');
}
{
  const snap = makeSnapshot();
  assertEqual(getLibraryDistribution(snap, 'Multifamily'), null, 'Multifamily null (degraded)');
  assertEqual(getLibraryMedian(snap, 'Multifamily', 'vacancy'), null, 'null distribution → null median');
}
{
  const snap = makeSnapshot();
  assertClose(getLibraryMedian(snap, 'Office', 'vacancy') as number, 0.10, 1e-9, 'Office vacancy median');
  assertClose(getLibraryMedian(snap, 'Office', 'capRate') as number, 0.075, 1e-9, 'Office cap-rate median');
}
{
  const snap = makeSnapshot();
  const stats = getLibraryStats(snap, 'Office', 'vacancy');
  assert(stats !== null, 'Office vacancy stats present');
  if (stats) assertEqual(stats.p25, 0.07, 'p25 preserved');
}

/* ---------------------------- manifesto-evaluator tests ------------------- */

console.log('\nManifesto evaluator — asset-type filter:');
{
  const adj = makeAdjustedInputs({ dscr: 1.50 });
  const rule = makeRule({ metricName: 'dscr', assetTypes: ['Office'] });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Multifamily') });
  assertEqual(r.fired, false, 'rule for Office skipped on Multifamily');
}
{
  const adj = makeAdjustedInputs({ dscr: 1.50 });
  const rule = makeRule({ metricName: 'dscr', assetTypes: ['all'] });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Multifamily') });
  assertEqual(r.fired, true, "['all'] rule applies to any asset type");
}

console.log('\nManifesto evaluator — Pass/Fail outcomes:');
{
  const adj = makeAdjustedInputs({ dscr: 1.50 });
  const rule = makeRule({ metricName: 'dscr', comparisonOperator: '>=', thresholdValue: 1.20, outcome: 'Fail' });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.outcome, 'Pass', 'predicate met (1.50 >= 1.20) → Pass');
  assertEqual(r.entry?.delta ?? 1, 0, 'manifesto entry delta = 0 (observational)');
}
{
  const adj = makeAdjustedInputs({ dscr: 1.10 });
  const rule = makeRule({ metricName: 'dscr', comparisonOperator: '>=', thresholdValue: 1.20, outcome: 'Fail' });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.outcome, 'Fail', 'predicate failed (1.10 < 1.20) → rule.outcome (Fail)');
}
{
  const adj = makeAdjustedInputs({ dscr: 1.10 });
  const rule = makeRule({ metricName: 'dscr', comparisonOperator: '>=', thresholdValue: 1.20, outcome: 'Watchlist' });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.outcome, 'Watchlist', 'predicate failed → Watchlist when rule.outcome=Watchlist');
}

console.log('\nManifesto evaluator — null current value:');
{
  const adj = makeAdjustedInputs({ dscr: null });
  const rule = makeRule({ metricName: 'dscr', comparisonOperator: '>=', thresholdValue: 1.20, outcome: 'Fail' });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.outcome, 'INSUFFICIENT_DATA', 'null currentValue → INSUFFICIENT_DATA');
  assert((r.entry?.reason ?? '').includes('INSUFFICIENT_DATA'), 'INSUFFICIENT_DATA in reason');
}

console.log('\nManifesto evaluator — qualitative + between operators:');
{
  const adj = makeAdjustedInputs({ dscr: 1.30 });
  const qualRule = makeRule({ metricName: 'dscr', comparisonOperator: 'qualitative', outcome: 'Fail' });
  const r = evaluateManifestoRule({ rule: qualRule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.outcome, 'INSUFFICIENT_DATA', 'qualitative → INSUFFICIENT_DATA in v1.0');

  const betRule = makeRule({ metricName: 'dscr', comparisonOperator: 'between', outcome: 'Fail' });
  const r2 = evaluateManifestoRule({ rule: betRule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r2.outcome, 'INSUFFICIENT_DATA', 'between → INSUFFICIENT_DATA in v1.0');
}

console.log('\nManifesto evaluator — unknown metric:');
{
  const adj = makeAdjustedInputs();
  const rule = makeRule({ metricName: 'nonexistent_metric_xyz', outcome: 'Fail' });
  const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: makeProfile('Office') });
  assertEqual(r.fired, false, 'unknown metric silently skipped');
}

console.log('\nManifesto evaluator — operator coverage:');
{
  const adj = makeAdjustedInputs({ dscr: 1.20 });
  const profile = makeProfile('Office');
  const ops = [
    { op: '>',  threshold: 1.10, expected: 'Pass' },     // 1.20 > 1.10
    { op: '>',  threshold: 1.30, expected: 'Fail' },     // 1.20 > 1.30 false
    { op: '>=', threshold: 1.20, expected: 'Pass' },     // 1.20 >= 1.20
    { op: '<',  threshold: 1.50, expected: 'Pass' },     // 1.20 < 1.50
    { op: '<=', threshold: 1.20, expected: 'Pass' },     // 1.20 <= 1.20
    { op: '==', threshold: 1.20, expected: 'Pass' },     // 1.20 === 1.20
    { op: '!=', threshold: 1.10, expected: 'Pass' },     // 1.20 !== 1.10
  ] as const;
  for (const { op, threshold, expected } of ops) {
    const rule = makeRule({ metricName: 'dscr', comparisonOperator: op, thresholdValue: threshold, outcome: 'Fail' });
    const r = evaluateManifestoRule({ rule, adjusted: adj, assetProfile: profile });
    assertEqual(r.outcome, expected, `${op} ${threshold} → ${expected}`);
  }
}

/* ---------------------------- NOI cap tests --------------------------- */

console.log('\nNOI cap:');
{
  const r = applyNoiCap({ derivedNoi: 8_000_000, bankNoi: 9_000_000 });
  assertEqual(r.capped, 8_000_000, 'no cap when derived <= bank');
  assertEqual(r.entry, null, 'no entry');
}
{
  const r = applyNoiCap({ derivedNoi: 9_000_000, bankNoi: 8_000_000 });
  assertEqual(r.capped, 8_000_000, 'capped to bank when derived > bank');
  assertEqual(r.entry?.ruleId ?? '', 'JE_NOI_CAPPED_TO_BANK', 'cap rule emitted');
  assertEqual(r.entry?.delta ?? 0, -1_000_000, 'delta is negative (NOI lowered)');
}
{
  const r = applyNoiCap({ derivedNoi: 8_000_000, bankNoi: null });
  assertEqual(r.capped, 8_000_000, 'no cap when bank NOI null');
  assertEqual(r.entry, null, 'no entry when bank null');
}
{
  // boundary: derived === bank → no cap
  const r = applyNoiCap({ derivedNoi: 8_000_000, bankNoi: 8_000_000 });
  assertEqual(r.entry, null, 'no cap at boundary (derived === bank)');
}

/* ---------------------------- confidence-reduction tests ------------------ */

console.log('\nConfidence reduction:');
{
  assertEqual(penaltyWeightFor('JE_RENT_ROLL_MISSING'), 12, 'rent roll = 12');
  assertEqual(penaltyWeightFor('JE_T12_MISSING'), 12, 't-12 = 12');
  assertEqual(penaltyWeightFor('JE_LOAN_TERMS_MISSING'), 10, 'loan terms = 10');
  assertEqual(penaltyWeightFor('JE_PCA_MISSING'), 6, 'pca = 6');
  assertEqual(penaltyWeightFor('JE_APPRAISAL_MISSING'), 4, 'appraisal = 4');
  assertEqual(penaltyWeightFor('JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS'), 6, 'seller-uw distrust = 6');
  assertEqual(penaltyWeightFor('JE_ASR_USED_WHEN_PRIMARY_EXISTS'), 6, 'asr distrust = 6');
  assertEqual(penaltyWeightFor('JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN'), 0, 'normalization rules = 0 weight');
  assertEqual(penaltyWeightFor('JE_VACANCY_SUBSTITUTED_FROM_LIBRARY'), 0, 'substitution rules = 0 weight');
}
{
  assertEqual(computeConfidenceReduction([]), 0, 'empty → 0');
  assertEqual(computeConfidenceReduction([{ ruleId: 'JE_RENT_ROLL_MISSING' }]), 0.12, '1 doc missing → 0.12');
  assertClose(
    computeConfidenceReduction([
      { ruleId: 'JE_RENT_ROLL_MISSING' },
      { ruleId: 'JE_T12_MISSING' },
      { ruleId: 'JE_LOAN_TERMS_MISSING' },
      { ruleId: 'JE_PCA_MISSING' },
      { ruleId: 'JE_APPRAISAL_MISSING' },
    ]),
    0.44,
    1e-9,
    'all 5 docs missing → 0.44',
  );
  assertClose(
    computeConfidenceReduction([
      { ruleId: 'JE_RENT_ROLL_MISSING' },
      { ruleId: 'JE_T12_MISSING' },
      { ruleId: 'JE_LOAN_TERMS_MISSING' },
      { ruleId: 'JE_PCA_MISSING' },
      { ruleId: 'JE_APPRAISAL_MISSING' },
      { ruleId: 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS' },
      { ruleId: 'JE_ASR_USED_WHEN_PRIMARY_EXISTS' },
    ]),
    0.56,
    1e-9,
    'all 5 + both distrust → 0.56',
  );
}
{
  // Deduplication: same rule id appearing twice doesn't double-count
  const r = computeConfidenceReduction([
    { ruleId: 'JE_RENT_ROLL_MISSING' },
    { ruleId: 'JE_RENT_ROLL_MISSING' },
  ]);
  assertEqual(r, 0.12, 'duplicate rule id deduplicated');
}
{
  // Cap at 1.0
  // (architecture v1.0 max is 0.56, but verify clamp is correct)
  const fakeMax = computeConfidenceReduction(
    Array.from({ length: 20 }, () => ({ ruleId: 'JE_T12_MISSING' as const })),
  );
  // Dedup makes this just 1 entry → 0.12
  assertEqual(fakeMax, 0.12, 'duplicates clamped to single entry');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
