/**
 * Integration tests for the Stage 4 orchestrator (Batch 3c2b).
 *
 *   npm run test:judgment-orchestrator
 *
 * Exercises:
 *   - Pre-condition checks (analysisAsOfDate mismatches → JudgmentEngineError)
 *   - Phase pipeline: builders → metrics → NOI cap → conservatism → manifesto → confidence → assembly
 *   - NOI cap firing and re-derivation of NOI-dependent metrics
 *   - Conservatism gate (direct invocation with violating inputs)
 *   - Manifesto rule outcomes (Pass / Fail / Watchlist / INSUFFICIENT_DATA)
 *   - confidenceReduction math
 *   - Idempotency (same inputs → same id)
 *   - Persistence round-trip via RecordGraphStore
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  type AdjustedInputs,
  type AssetProfile,
  type AssetType,
  type ContentHash,
  type CreditManifesto,
  type CreditManifestoRuleId,
  type ExtractionResult,
  type LibrarySnapshot,
  type ManifestoRule,
  type MarketBenchmarks,
} from '@cre/contracts';
import { applyJudgmentAdjustments } from '../services/judgment/apply-judgment-adjustments.js';
import {
  ConservatismViolation,
  JudgmentEngineError,
} from '../services/judgment/errors.js';
import { verifyConservatism } from '../services/judgment/verify-conservatism.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  computeAssetProfileId,
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
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
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  message: string,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (e instanceof ctor) ok(message);
    else fail(`${message} (threw ${(e as Error)?.name})`);
  }
}

/* ------------------------------- fixtures -------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeProfile(t: AssetType = 'Office'): AssetProfile {
  const body = { propertyType: t, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeFullExtraction(asOf: string = AS_OF): ExtractionResult {
  const body = {
    analysisAsOfDate: asOf,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'TEST-1',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'Tenant B', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2034-01-01T00:00:00Z', baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000,
          occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    t12: {
      period: 'T-12 ending Apr 2026', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000,
                   repairsMaintenance: 36_000, managementFees: 40_000,
                   totalOperatingExpenses: 218_000 },
    },
    pca: {
      immediateRepairs: 50_000, nearTermRepairs: 150_000,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: {
      loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
      interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z',
    },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(asOf: string = AS_OF, rules: readonly ManifestoRule[] = []): CreditManifesto {
  const body = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules,
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function makeRule(opts: Omit<Partial<ManifestoRule>, 'ruleId' | 'metricName'> & { metricName: string; ruleId: string }): ManifestoRule {
  return {
    condition: 'test',
    thresholdValue: 1.20,
    comparisonOperator: '>=',
    outcome: 'Fail',
    weight: 10,
    assetTypes: ['all'],
    sourceText: '',
    pageReference: null,
    ...opts,
    ruleId: opts.ruleId as CreditManifestoRuleId,
  };
}

function defaultArgs() {
  return {
    extraction: makeFullExtraction(),
    assetProfile: makeProfile('Office'),
    librarySnapshot: makeSnapshot(),
    manifesto: makeManifesto(),
    marketBenchmarks: makeBenchmarks(),
    analysisAsOfDate: AS_OF,
  };
}

/* ------------------------------- pre-condition tests --------------------- */

console.log('Pre-conditions:');

{
  // analysisAsOfDate mismatch on extraction
  const args = defaultArgs();
  args.extraction = makeFullExtraction('2025-01-01T00:00:00Z');
  assertThrowsInstance(
    () => applyJudgmentAdjustments(args),
    JudgmentEngineError,
    'extraction.analysisAsOfDate mismatch → JudgmentEngineError',
  );
}
{
  // analysisAsOfDate mismatch on manifesto
  const args = defaultArgs();
  args.manifesto = makeManifesto('2099-01-01T00:00:00Z');
  assertThrowsInstance(
    () => applyJudgmentAdjustments(args),
    JudgmentEngineError,
    'manifesto.analysisAsOfDate mismatch → JudgmentEngineError',
  );
}

/* ------------------------------- happy path ------------------------------ */

console.log('\nHappy path:');

{
  const result = applyJudgmentAdjustments(defaultArgs());
  assert(typeof result.id === 'string' && /^[0-9a-f]{64}$/.test(result.id), 'id is 64-char hex');
  assertEqual(result.judgmentEngineVersion, JUDGMENT_ENGINE_VERSION, 'engine version stamped');
  assertEqual(result.analysisAsOfDate, AS_OF, 'analysisAsOfDate stamped');
  assert(result.metrics.noi !== null, 'NOI computed');
  assert(result.metrics.value !== null, 'value computed');
  assert(result.metrics.dscr !== null, 'DSCR computed');
  assert(result.metrics.debtYield !== null, 'debtYield computed');
  assert(result.income.grossRentalIncome.adjusted > 0, 'GRI > 0');
  assert(result.expenses.totalOperatingExpenses.adjusted > 0, 'totalOpEx > 0');
  assert(result.loan.debtServiceAnnual.adjusted > 0, 'debtServiceAnnual > 0');
  assert(result.assumptions.capRate.adjusted > 0, 'capRate > 0');
}

/* ------------------------------- NOI cap firing ------------------------- */

console.log('\nNOI cap:');

{
  // Construct extraction with low T-12 NOI so derived NOI > bank NOI → cap fires.
  // Default fixture's derived NOI is ~794k after expense floor enforcement; set bank NOI = 600k.
  const ext = makeFullExtraction();
  const lowBankExt = { ...ext, t12: { ...ext.t12!, noi: 600_000 } } as ExtractionResult;
  const result = applyJudgmentAdjustments({ ...defaultArgs(), extraction: lowBankExt });
  assertClose(result.metrics.noi as number, 600_000, 1, 'NOI capped to bank NOI 600k when derived > bank');
  const noiCapEntry = result.topLevelAdjustments.find(a => a.ruleId === 'JE_NOI_CAPPED_TO_BANK');
  assert(noiCapEntry !== undefined, 'JE_NOI_CAPPED_TO_BANK entry present in topLevelAdjustments');
  assert((noiCapEntry?.delta ?? 0) < 0, 'cap delta is negative (NOI was lowered)');
}
{
  // Construct extraction where bank NOI is high → no cap
  const ext = makeFullExtraction();
  const highBankExt = { ...ext, t12: { ...ext.t12!, noi: 5_000_000 } } as ExtractionResult;
  const result = applyJudgmentAdjustments({ ...defaultArgs(), extraction: highBankExt });
  const noiCapEntry = result.topLevelAdjustments.find(a => a.ruleId === 'JE_NOI_CAPPED_TO_BANK');
  assert(noiCapEntry === undefined, 'no cap when derived NOI <= bank NOI');
}

/* ------------------------------- conservatism gate ----------------------- */

console.log('\nConservatism gate (direct invocation):');

{
  // Construct an AdjustedInputs that violates vacancy floor
  const lib = makeSnapshot();
  // Office library median = 0.10; construct adjusted vacancy = 0.05
  const violatingAdjusted: AdjustedInputs = {
    id: '0'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: lib.id,
    income: {
      grossRentalIncome: { raw: 1_000_000, adjusted: 1_000_000, source: 'BANK', adjustments: [] },
      otherIncome: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      vacancyPct: { raw: 0.05, adjusted: 0.05, source: 'BANK', adjustments: [] },   // BELOW floor 0.10
      concessionsPct: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      effectiveGrossIncome: { raw: 950_000, adjusted: 950_000, source: 'BANK', adjustments: [] },
    },
    expenses: {
      realEstateTaxes: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      insurance: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      utilities: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      managementFee: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      payroll: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      maintenance: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      other: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      totalOperatingExpenses: { raw: 200_000, adjusted: 200_000, source: 'BANK', adjustments: [] },
    },
    capitalReserves: {
      upfrontCapex: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      upfrontTiLc: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      monthlyCapex: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      monthlyTiLc: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      pcaImmediateRepairs: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
    },
    loan: {
      loanAmount: { raw: 1, adjusted: 1, source: 'BANK', adjustments: [] },
      interestRate: { raw: 0.05, adjusted: 0.05, source: 'BANK', adjustments: [] },
      termMonths: { raw: 120, adjusted: 120, source: 'BANK', adjustments: [] },
      amortizationMonths: { raw: 360, adjusted: 360, source: 'BANK', adjustments: [] },
      ioPeriodMonths: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      maturityBalance: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
      debtServiceAnnual: { raw: 0, adjusted: 0, source: 'BANK', adjustments: [] },
    },
    assumptions: {
      capRate: { raw: 0.06, adjusted: 0.06, source: 'BANK', adjustments: [] },
      terminalCapRate: { raw: 0.07, adjusted: 0.07, source: 'BANK', adjustments: [] },
      rentGrowthPct: { raw: 0.03, adjusted: 0.03, source: 'BANK', adjustments: [] },
      expenseGrowthPct: { raw: 0.03, adjusted: 0.03, source: 'BANK', adjustments: [] },
    },
    metrics: {
      noi: 750_000, value: 12_500_000, dscr: null, ltvAppraisal: null,
      debtYield: null, expenseRatio: 0.21, top1IncomeShare: null,
      pctIncomeExpiringWithinTerm: null,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };

  assertThrowsInstance(
    () => verifyConservatism({
      adjustedInputs: violatingAdjusted,
      extraction: makeFullExtraction(),
      librarySnapshot: lib,
      assetProfile: makeProfile('Office'),
    }),
    ConservatismViolation,
    'vacancy below floor → ConservatismViolation thrown',
  );
}

{
  // Conservatism passes on a properly-constructed AdjustedInputs (the orchestrator output)
  const result = applyJudgmentAdjustments(defaultArgs());
  // If we got here, conservatism gate already passed during orchestration
  assert(result.metrics.noi !== null, 'orchestrator output passed conservatism gate');
}

/* --------------------------------- manifesto ----------------------------- */

console.log('\nManifesto evaluation:');

{
  const passingRule = makeRule({
    ruleId: 'r-dscr-min',
    metricName: 'dscr',
    comparisonOperator: '>=',
    thresholdValue: 1.0,
    outcome: 'Fail',
  });
  const args = defaultArgs();
  args.manifesto = makeManifesto(AS_OF, [passingRule]);
  const result = applyJudgmentAdjustments(args);
  const manifestoEntries = result.topLevelAdjustments.filter(
    a => a.ruleId === 'r-dscr-min',
  );
  assertEqual(manifestoEntries.length, 1, 'manifesto rule emitted exactly one AdjustmentEntry');
  assertEqual(manifestoEntries[0]?.delta ?? -1, 0, 'manifesto entry delta = 0 (observational)');
}

/* ----------------------------- confidence reduction --------------------- */

console.log('\nConfidence reduction:');

{
  const result = applyJudgmentAdjustments(defaultArgs());
  // Default: all 5 docs present → 0
  assertEqual(result.confidenceReduction, 0, 'all docs present → 0');
  assertEqual(result.dataQualityFlags.length, 0, 'all docs present → empty dataQualityFlags');
}
{
  // Sparse extraction: only T-12 + LoanTerms + Appraisal present
  const ext = makeFullExtraction();
  const sparseBody = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'TEST-SPARSE',
    rentRoll: null,            // 12-point penalty
    t12: ext.t12,
    pca: null,                 // 6-point penalty
    appraisal: ext.appraisal,
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: ext.loanTerms,
    sourceDocuments: [],
    extractorVersions: {},
  };
  const sparseExt = { id: computeExtractionResultId(sparseBody), ...sparseBody } as ExtractionResult;
  const args = { ...defaultArgs(), extraction: sparseExt };
  const result = applyJudgmentAdjustments(args);
  // RR + PCA missing = 12 + 6 = 18 → 0.18
  assertClose(result.confidenceReduction, 0.18, 1e-9, 'rent roll + PCA missing → 0.18');
  assert(result.dataQualityFlags.includes('JE_RENT_ROLL_MISSING'), 'JE_RENT_ROLL_MISSING flag set');
  assert(result.dataQualityFlags.includes('JE_PCA_MISSING'), 'JE_PCA_MISSING flag set');
  // Batch 6.2 (audit U15): Office is tenant-driven; missing rent roll AND tenant-driven asset
  // class → TI/LC applicability cannot be determined. The flag explicitly surfaces the
  // degraded state (vs the legacy silent NOT_APPLICABLE downgrade).
  assert(result.dataQualityFlags.includes('JE_TILC_APPLICABILITY_UNKNOWN'),
    'JE_TILC_APPLICABILITY_UNKNOWN flag set (Office + null rent roll)');
  assertEqual(result.dataQualityFlags.length, 3, 'flags: 2 missing-doc + 1 TI/LC unknown');
}

/* ------------------------------- idempotency ---------------------------- */

console.log('\nIdempotency:');

{
  const r1 = applyJudgmentAdjustments(defaultArgs());
  const r2 = applyJudgmentAdjustments(defaultArgs());
  assertEqual(r1.id, r2.id, 'same inputs → same id');
}

/* --------------------------- persistence round-trip --------------------- */

console.log('\nPersistence round-trip:');

{
  const result = applyJudgmentAdjustments(defaultArgs());
  const store = new RecordGraphStore(':memory:');
  store.insertLibrarySnapshot(makeSnapshot());
  const inserted = store.insertAdjustedInputs(result);
  assert(inserted.inserted, 'AdjustedInputs persisted via record-graph store');
  const fetched = store.getAdjustedInputs(result.id);
  assert(fetched !== null, 'retrievable by id');
  assertEqual(fetched?.metrics.noi ?? null, result.metrics.noi, 'NOI round-trips');
  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
