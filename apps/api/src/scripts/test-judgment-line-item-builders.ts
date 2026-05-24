/**
 * Tests for per-line-item builders (Batch 3c1).
 *
 *   npm run test:judgment-line-item-builders
 *
 * Each builder is tested with: present-and-valid raw input, missing raw input + substitution,
 * missing raw + null substitution (throws), library-floor enforcement (where applicable),
 * bank-floor enforcement (where applicable), and source-tier preservation.
 */

import {
  ASSET_TYPES,
  type AssetType,
  type AssetProfile,
  type ContentHash,
  type ExtractionResult,
  type LibrarySnapshot,
  type MarketBenchmarks,
} from '@cre/contracts';
import { computeAssetProfileId } from '../util/content-hash.js';
import {
  buildCapRate,
  buildGrossRentalIncome,
  buildInterestRate,
  buildLoanAmount,
  buildOtherIncome,
  buildTermMonths,
  buildVacancyPct,
} from '../services/judgment/line-item-builders.js';

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
function assertThrows(fn: () => unknown, m: string): void {
  try { fn(); fail(`${m} (did not throw)`); } catch { ok(m); }
}

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function makeProfile(propertyType: AssetType): AssetProfile {
  const body = { propertyType, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    id: 'a'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: '1.3',
    dealRef: 'TEST-1',
    rentRoll: null, t12: null, pca: null,
    appraisal: null, sellerUw: null, sellerUwOperatingStatement: null, asr: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
    ...overrides,
  };
}

function makeSnapshot(opts: {
  officeVacancyMedian?: number;
  officeCapRateMedian?: number;
} = {}): LibrarySnapshot {
  const byAssetType = emptyByAssetType() as { [K in AssetType]: ReturnType<typeof anyDistribution> | null };
  byAssetType.Office = {
    vacancy: { median: opts.officeVacancyMedian ?? 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.40, p25: 0.35, p75: 0.45 },
    capRate: { median: opts.officeCapRateMedian ?? 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  return {
    id: 'b'.repeat(64) as never,
    asOf: AS_OF,
    approvedDealsTableHash: 'c'.repeat(64) as ContentHash,
    byAssetType,
  };
}
// helper to satisfy TS for anonymous distribution shape
function anyDistribution() {
  return {} as { vacancy: { median: number; p25: number; p75: number }; expenseRatio: { median: number; p25: number; p75: number }; capRate: { median: number; p25: number; p75: number }; dscr: { median: number; p25: number; p75: number }; treasury10YAtClose: { median: number; p25: number; p75: number }; n: number };
}

function makeBenchmarks(opts: {
  officeVacancy?: number | null;
  officeCapRate?: number | null;
  baseRate?: number;
} = {}): MarketBenchmarks {
  const base: { [K in AssetType]: number | null } = {
    Office: opts.officeVacancy ?? 0.12,
    Retail: 0.06, Multifamily: 0.05, Hotel: 0.30, Industrial: 0.04,
    SelfStorage: 0.10, MHC: 0.04, MixedUse: null, Other: null,
  };
  const caps: { [K in AssetType]: number | null } = {
    Office: opts.officeCapRate ?? 0.08,
    Retail: 0.065, Multifamily: 0.055, Hotel: 0.085, Industrial: 0.060,
    SelfStorage: 0.070, MHC: 0.065, MixedUse: null, Other: null,
  };
  const psf = { ...base };
  return {
    id: 'd'.repeat(64) as never,
    asOfDate: AS_OF,
    capRates: caps,
    vacancyRates: base,
    expensesPerSqFt: psf,
    interestRateAssumptions: { baseRate: opts.baseRate ?? 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
}

/* --------------------------------- buildVacancyPct ------------------------- */

console.log('buildVacancyPct:');

{
  // raw above floor + library median, no normalization
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: 200_000,
      income: { grossPotentialRent: 1_000_000, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const result = buildVacancyPct({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeVacancyMedian: 0.10 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertClose(result.adjusted, 0.20, 1e-9, 'raw 0.20 (above 0.10 floor) preserved');
  assertEqual(result.source, 'T12_ACTUAL', 'source = T12_ACTUAL');
  assertEqual(result.adjustments.length, 0, 'no adjustments fired');
}
{
  // raw below library floor → raised to library median
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: 30_000,
      income: { grossPotentialRent: 1_000_000, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const result = buildVacancyPct({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeVacancyMedian: 0.10 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertClose(result.adjusted, 0.10, 1e-9, 'raw 0.03 raised to library median 0.10');
  assertEqual(result.adjustments.length, 1, 'one floor adjustment fired');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', 'library floor rule');
}
{
  // bank floor (sellerUw vacancy) higher than library
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: 30_000,
      income: { grossPotentialRent: 1_000_000, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.12 },
    sellerUwOperatingStatement: null,
  });
  const result = buildVacancyPct({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeVacancyMedian: 0.10 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertClose(result.adjusted, 0.12, 1e-9, 'raised to bank floor (0.12 > library 0.10)');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_RAISED_TO_BANK', 'bank floor rule');
}
{
  // raw null → substitute from library median
  const ext = makeExtraction();
  const result = buildVacancyPct({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeVacancyMedian: 0.10 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertClose(result.adjusted, 0.10, 1e-9, 'null raw → substituted to library median');
  assertEqual(result.source, 'MANUAL', 'source = MANUAL on substitution');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', 'substitution rule');
}
{
  // raw null AND library degraded for asset type → fall back to MarketBenchmarks
  // Multifamily has null library distribution (in our fixture), benchmark vacancy = 0.05.
  const ext = makeExtraction();
  const result = buildVacancyPct({
    extraction: ext,
    librarySnapshot: makeSnapshot(),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Multifamily'),
  });
  assertClose(result.adjusted, 0.05, 1e-9, 'null lib + benchmark fallback (Multifamily 0.05)');
  assertEqual(result.source, 'MANUAL', 'source = MANUAL on benchmark substitution');
  // Batch 6.2 (audit U11): benchmark substitution emits a DISTINCT rule id from library substitution.
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK', 'benchmark substitution rule fired (split provenance)');
}
{
  // raw null AND library null AND benchmark null → throws
  const ext = makeExtraction();
  assertThrows(
    () => buildVacancyPct({
      extraction: ext,
      librarySnapshot: makeSnapshot({}), // Office has lib distribution
      marketBenchmarks: makeBenchmarks(),
      assetProfile: makeProfile('MixedUse'),  // MixedUse has null in both
    }),
    'no library + no benchmark for asset type → throws',
  );
}

/* --------------------------------- buildCapRate ---------------------------- */

console.log('\nbuildCapRate:');

{
  const ext = makeExtraction({
    appraisal: { valueConclusion: null, capRate: 0.06, methodology: null },
  });
  const result = buildCapRate({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeCapRateMedian: 0.075 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertEqual(result.adjusted, 0.06, 'raw 0.06 NOT raised to library 0.075 (substitution-only)');
  assertEqual(result.source, 'APPRAISAL', 'source = APPRAISAL');
  assertEqual(result.adjustments.length, 0, 'no normalization for cap rate (substitution-only)');
}
{
  const ext = makeExtraction(); // no appraisal, no asr
  const result = buildCapRate({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeCapRateMedian: 0.075 }),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertEqual(result.adjusted, 0.075, 'null raw → substituted from library median');
  assertEqual(result.source, 'MANUAL', 'source = MANUAL');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY', 'cap-rate substitution rule');
}
{
  // ASR fallback when appraisal cap rate is null
  const ext = makeExtraction({
    appraisal: { valueConclusion: 100_000_000, capRate: null, methodology: null },
    asr: { impliedValue: 110_000_000, impliedCapRate: 0.055, underwrittenNOI: null },
  });
  const result = buildCapRate({
    extraction: ext,
    librarySnapshot: makeSnapshot(),
    marketBenchmarks: makeBenchmarks(),
    assetProfile: makeProfile('Office'),
  });
  assertEqual(result.source, 'ASR', 'source falls back to ASR when appraisal capRate is null');
  assertEqual(result.adjusted, 0.055, 'ASR cap rate used');
}

/* ---------------------------- buildGrossRentalIncome ----------------------- */

console.log('\nbuildGrossRentalIncome:');

{
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: null,
      income: { grossPotentialRent: 1_200_000, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const result = buildGrossRentalIncome({ extraction: ext });
  assertEqual(result.adjusted, 1_200_000, 'GRI from T-12');
  assertEqual(result.source, 'T12_ACTUAL', 'source = T12_ACTUAL');
}
{
  const ext = makeExtraction(); // no T-12, no rent roll
  assertThrows(
    () => buildGrossRentalIncome({ extraction: ext }),
    'no GRI available → throws',
  );
}

/* ------------------------------- buildOtherIncome -------------------------- */

console.log('\nbuildOtherIncome:');

{
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: null,
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: 50_000, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const result = buildOtherIncome({ extraction: ext });
  assertEqual(result.adjusted, 50_000, 'other income preserved');
}
{
  const ext = makeExtraction();
  const result = buildOtherIncome({ extraction: ext });
  assertEqual(result.adjusted, 0, 'no other income → defaults to 0 (conservative)');
  assertEqual(result.source, 'MANUAL', 'source = MANUAL');
  // Batch 6.2.1 (audit U9): MANUAL default emits JE_OTHER_INCOME_DEFAULTED so doctrine
  // sees the synthesized-vs-extracted distinction.
  assertEqual(result.adjustments.length, 1, 'JE_OTHER_INCOME_DEFAULTED emitted (audit U9)');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_OTHER_INCOME_DEFAULTED', 'rule id matches');
}

/* ---------------------------------- buildLoanAmount ------------------------ */

console.log('\nbuildLoanAmount:');

{
  const ext = makeExtraction({
    loanTerms: { loanAmount: 50_000_000, interestRate: 0.07, amortization: 360, interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
  });
  const result = buildLoanAmount({ extraction: ext });
  assertEqual(result.adjusted, 50_000_000, 'loan amount from LoanTerms');
  assertEqual(result.source, 'BANK', 'source = BANK');
}
{
  const ext = makeExtraction();
  assertThrows(
    () => buildLoanAmount({ extraction: ext }),
    'no LoanTerms → throws',
  );
}

/* --------------------------------- buildInterestRate ---------------------- */

console.log('\nbuildInterestRate:');

{
  const ext = makeExtraction({
    loanTerms: { loanAmount: 50_000_000, interestRate: 0.07, amortization: 360, interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
  });
  const result = buildInterestRate({ extraction: ext, marketBenchmarks: makeBenchmarks() });
  assertEqual(result.adjusted, 0.07, 'interest rate from LoanTerms');
  assertEqual(result.source, 'BANK', 'source = BANK');
}
{
  const ext = makeExtraction();
  const result = buildInterestRate({
    extraction: ext,
    marketBenchmarks: makeBenchmarks({ baseRate: 0.075 }),
  });
  assertEqual(result.adjusted, 0.075, 'null raw → substituted from benchmark base rate');
  assertEqual(result.source, 'MANUAL', 'source = MANUAL on substitution');
  assertEqual(result.adjustments[0]?.ruleId ?? '', 'JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK', 'benchmark substitution rule');
}

/* ---------------------------------- buildTermMonths ----------------------- */

console.log('\nbuildTermMonths:');

{
  const ext = makeExtraction({
    loanTerms: {
      loanAmount: 50_000_000, interestRate: 0.07, amortization: 360, interestOnlyPeriod: 0,
      maturityDate: '2036-05-08T00:00:00Z',  // 10 years from AS_OF (2026-05-08)
    },
  });
  const result = buildTermMonths({ extraction: ext, analysisAsOfDate: AS_OF });
  // Approximate: 10 years * 12 = 120 months, give or take 1 due to rounding
  assert(result.adjusted >= 119 && result.adjusted <= 121, `term months ≈ 120 (got ${result.adjusted})`);
  assertEqual(result.source, 'BANK', 'source = BANK');
}
{
  const ext = makeExtraction();
  assertThrows(
    () => buildTermMonths({ extraction: ext, analysisAsOfDate: AS_OF }),
    'no LoanTerms → throws',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
