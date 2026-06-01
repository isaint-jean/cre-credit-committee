/**
 * Tests for the period-label safeguard (Safeguard 1 of the 2026-05-31 fix).
 *
 *   tsx src/scripts/test-period-label-safeguard.ts
 *
 * The orchestrator emits JE_PERIOD_LABEL_MISMATCH (delta=0, informational)
 * when a slot's `period` text does not match the expected pattern for that
 * slot. The flag surfaces in `dataQualityFlags` and the underlying entries
 * surface in `topLevelAdjustments`, but the rule is excluded from
 * data_confidence weighting (no doctrine score dock).
 *
 * Test cases:
 *   - All slots with sane period labels → no mismatch flag.
 *   - inPlace with "GS U/W" period label (wrong slot) → mismatch fires.
 *   - sellerUwOperatingStatement with "T-12" label (wrong slot) → mismatch fires.
 *   - t12Actual with "In-Place" label (wrong slot) → mismatch fires.
 *   - Entries are delta=0 (informational only).
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetProfile,
  AssetType,
  CreditManifesto,
  ExtractionResult,
  ISODateTime,
  LibrarySnapshot,
  MarketBenchmarks,
  OperatingStatementExtraction,
} from '@cre/contracts';
import { applyJudgmentAdjustments } from '../services/judgment/apply-judgment-adjustments.js';
import {
  computeAssetProfileId,
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeLib(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = { asOf: AS_OF, approvedDealsTableHash: ('a'.repeat(64)) as never, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Office: 0.10 },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50), Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function makeProfile(): AssetProfile {
  const body = { propertyType: 'Office' as AssetType, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeStatement(period: string): OperatingStatementExtraction {
  return {
    period,
    income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
    expenses: {
      taxes: 100_000, insurance: 18_000, utilities: 24_000, repairsMaintenance: 36_000,
      managementFees: 40_000, generalAndAdmin: null, janitorial: null, reimbursements: null,
      totalOperatingExpenses: 218_000,
    },
    noi: 800_000,
    vacancyLoss: 60_000,
    belowNoiAdjustments: { replacementReserves: 54_952, tenantImprovements: 12_000, leasingCommissions: 8_000 },
  };
}

function makeExtraction(opts: {
  inPlacePeriod?: string;
  sellerUwPeriod?: string;
  t12ActualPeriod?: string;
}): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'TEST-SAFEGUARD',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2029-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
      ],
      summary: { totalUnits: 1, occupiedUnits: 1, economicOccupancy: 1.0 },
    },
    inPlace: opts.inPlacePeriod !== undefined ? makeStatement(opts.inPlacePeriod) : null,
    t12Actual: opts.t12ActualPeriod !== undefined ? makeStatement(opts.t12ActualPeriod) : null,
    pca: null,
    appraisal: { valueConclusion: 12_000_000, capRate: 0.075, methodology: 'Income' },
    sellerUw: null,
    sellerUwOperatingStatement: opts.sellerUwPeriod !== undefined ? makeStatement(opts.sellerUwPeriod) : null,
    asr: null,
    loanTerms: {
      loanAmount: 6_000_000, interestRate: 0.07,
      amortization: 360, interestOnlyPeriod: 0,
      maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
    },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

function defaultArgs(extraction: ExtractionResult) {
  return {
    extraction,
    assetProfile: makeProfile(),
    librarySnapshot: makeLib(),
    manifesto: makeManifesto(),
    marketBenchmarks: makeBenchmarks(),
    analysisAsOfDate: AS_OF,
  };
}

/* ----------------------------- cases ----------------------------------- */

console.log('Period-label safeguard:');

/* Case 1 — sane labels → no mismatch flag. */
{
  const ext = makeExtraction({
    inPlacePeriod: 'In-Place',
    sellerUwPeriod: 'GS U/W',
    // t12Actual omitted (null)
  });
  const ai = applyJudgmentAdjustments(defaultArgs(ext));
  assert(!ai.dataQualityFlags.includes('JE_PERIOD_LABEL_MISMATCH'),
    'sane labels → JE_PERIOD_LABEL_MISMATCH does NOT fire');
  const mismatch = ai.topLevelAdjustments.find(a => a.ruleId === 'JE_PERIOD_LABEL_MISMATCH');
  assertEqual(mismatch, undefined, 'no JE_PERIOD_LABEL_MISMATCH entry in topLevelAdjustments');
}

/* Case 2 — inPlace.period = "GS U/W" (wrong slot) → mismatch. */
{
  const ext = makeExtraction({
    inPlacePeriod: 'GS U/W',
    sellerUwPeriod: 'GS U/W',
  });
  const ai = applyJudgmentAdjustments(defaultArgs(ext));
  assert(ai.dataQualityFlags.includes('JE_PERIOD_LABEL_MISMATCH'),
    'inPlace mislabeled "GS U/W" → JE_PERIOD_LABEL_MISMATCH flag in dataQualityFlags');
  const mismatch = ai.topLevelAdjustments.find(a => a.ruleId === 'JE_PERIOD_LABEL_MISMATCH');
  assert(mismatch !== undefined, 'mismatch entry present in topLevelAdjustments');
  if (mismatch) {
    assertEqual(mismatch.delta, 0, 'mismatch entry delta=0 (informational, not load-bearing)');
    assert(mismatch.reason.includes('inPlace'), 'mismatch reason references inPlace slot');
  }
}

/* Case 3 — sellerUwOperatingStatement.period = "T-12" (wrong slot) → mismatch. */
{
  const ext = makeExtraction({
    inPlacePeriod: 'In-Place',
    sellerUwPeriod: 'T-12',
  });
  const ai = applyJudgmentAdjustments(defaultArgs(ext));
  assert(ai.dataQualityFlags.includes('JE_PERIOD_LABEL_MISMATCH'),
    'sellerUwOperatingStatement mislabeled "T-12" → JE_PERIOD_LABEL_MISMATCH flag fires');
  const mismatch = ai.topLevelAdjustments.find(
    a => a.ruleId === 'JE_PERIOD_LABEL_MISMATCH' && a.reason.includes('sellerUwOperatingStatement'),
  );
  assert(mismatch !== undefined, 'mismatch entry references sellerUwOperatingStatement slot');
  if (mismatch) assertEqual(mismatch.delta, 0, 'delta=0');
}

/* Case 4 — t12Actual.period = "In-Place" (wrong slot) → mismatch. */
{
  const ext = makeExtraction({
    inPlacePeriod: 'In-Place',
    sellerUwPeriod: 'GS U/W',
    t12ActualPeriod: 'In-Place',
  });
  const ai = applyJudgmentAdjustments(defaultArgs(ext));
  assert(ai.dataQualityFlags.includes('JE_PERIOD_LABEL_MISMATCH'),
    't12Actual mislabeled "In-Place" → JE_PERIOD_LABEL_MISMATCH flag fires');
  const mismatch = ai.topLevelAdjustments.find(
    a => a.ruleId === 'JE_PERIOD_LABEL_MISMATCH' && a.reason.includes('t12Actual'),
  );
  assert(mismatch !== undefined, 'mismatch entry references t12Actual slot');
  if (mismatch) assertEqual(mismatch.delta, 0, 'delta=0');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
