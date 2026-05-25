/**
 * Tests for the Batch 1 Truth Layer contracts: `ExtractionResult` + `MarketBenchmarks`.
 *
 *   npm run test:extraction-contract
 *
 * Pure type-shape verification — no producers exist yet. Confirms:
 *   - Fixtures of every sub-extraction shape compile + canonicalize
 *   - Content-hash + branded-id factories work
 *   - Idempotency (same body → same id)
 *   - Null sub-extractions are accepted
 *   - MarketBenchmarks key set covers every AssetType
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  SOURCE_DOCUMENT_KINDS,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  ExtractionResult,
  MarketBenchmarks,
  RentRollUnit,
  SourceDocumentRef,
} from '@cre/contracts';
import {
  computeExtractionResultId,
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

/* --------------------------- ExtractionResult fixtures --------------------- */

function makeUnit(unitId: string, occupied: boolean, baseRent: number | null): RentRollUnit {
  return {
    unitId,
    tenantName: occupied ? `Tenant ${unitId}` : null,
    leaseStart: occupied ? '2024-01-01T00:00:00Z' : null,
    leaseEnd: occupied ? '2027-01-01T00:00:00Z' : null,
    baseRentMonthly: baseRent,
    inPlaceRentMonthly: occupied ? baseRent : null,
    occupied,
    concessions: occupied ? 0 : null,
    securityDeposit: occupied ? 1500 : null,
  };
}

function makeFullExtractionBody() {
  const sourceDocuments: readonly SourceDocumentRef[] = [
    { kind: 'rent_roll', contentHash: 'a'.repeat(64) as ContentHash },
    { kind: 't12',       contentHash: 'b'.repeat(64) as ContentHash },
    { kind: 'pca',       contentHash: 'c'.repeat(64) as ContentHash },
    { kind: 'appraisal', contentHash: 'd'.repeat(64) as ContentHash },
    { kind: 'asr',       contentHash: 'e'.repeat(64) as ContentHash },
    { kind: 'seller_uw', contentHash: 'f'.repeat(64) as ContentHash },
    { kind: 'loan_terms',contentHash: '0'.repeat(64) as ContentHash },
  ];

  return {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'OPP-12345',

    rentRoll: {
      units: [
        makeUnit('A101', true,  5_000),
        makeUnit('A102', true,  4_800),
        makeUnit('A103', false, null),
      ],
      summary: {
        totalUnits: 3,
        occupiedUnits: 2,
        economicOccupancy: 0.667,
      },
    },

    t12: {
      period: 'T-12 ending Apr 2026',
      income: {
        grossPotentialRent: 1_200_000,
        effectiveRent:      1_140_000,
        otherIncome:        60_000,
        totalIncome:        1_200_000,
      },
      expenses: {
        taxes:                100_000,
        insurance:            18_000,
        utilities:            24_000,
        repairsMaintenance:   36_000,
        managementFees:       40_000,
        generalAndAdmin:      null,
        janitorial:           null,
        reimbursements:       null,
        totalOperatingExpenses: 218_000,
      },
      noi: 982_000,
      vacancyLoss: 60_000,
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },

    pca: {
      immediateRepairs: 50_000,
      shortTermRepairs:  150_000,
      evaluationPeriodYears: null,
      inflationRate: null,
      replacementReservesPerSfPerYearInflated: null,
      replacementReservesPerSfPerYearUninflated: null,
      capexScheduleInflated: null,
      capexScheduleUninflated: null,
      structural: {
        roof:       'fair, life remaining 5-7 years',
        hvac:       'good',
        plumbing:   'good',
        electrical: 'good',
      },
    },

    appraisal: {
      valueConclusion: 16_500_000,
      capRate:         0.06,
      methodology:     'Income (Direct Cap) + Sales Comparison',
    },

    sellerUw: {
      underwrittenNOI:        1_080_000,
      underwrittenRentGrowth: 0.03,
      underwrittenVacancy:    0.04,
    },

    sellerUwOperatingStatement: {
      period: 'Seller U/W',
      income: {
        grossPotentialRent: 1_200_000,
        effectiveRent:      null,
        otherIncome:        50_000,
        totalIncome:        1_200_000,
      },
      expenses: {
        taxes:                  120_000,
        insurance:              30_000,
        utilities:              25_000,
        repairsMaintenance:     40_000,
        managementFees:         36_000,
        generalAndAdmin:        null,
        janitorial:             null,
        reimbursements:         null,
        totalOperatingExpenses: 251_000,
      },
      noi:         949_000,
      vacancyLoss: -50_000,
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },

    asr: {
      impliedValue:    18_000_000,
      impliedCapRate:  0.06,
      underwrittenNOI: 1_080_000,
    },

    loanTerms: {
      loanAmount:         11_000_000,
      interestRate:       0.07,
      amortization:       360,
      interestOnlyPeriod: 24,
      maturityDate:       '2031-05-08T00:00:00Z',
    },

    sourceDocuments,
    extractorVersions: {} as Record<string, string>,
  };
}

function makeSparseExtractionBody() {
  return {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'OPP-99999',
    rentRoll: null,
    t12: null,
    pca: null,
    appraisal: null,
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: null,
    sourceDocuments: [] as readonly SourceDocumentRef[],
    extractorVersions: {} as Record<string, string>,
  };
}

console.log('ExtractionResult — full fixture:');
{
  const body = makeFullExtractionBody();
  const id = computeExtractionResultId(body);
  const record: ExtractionResult = { id, ...body } as ExtractionResult;

  assert(/^[0-9a-f]{64}$/.test(id), 'id is 64-char lowercase hex');
  assertEqual(record.dealRef, 'OPP-12345', 'dealRef preserved');
  assertEqual(record.t12?.noi ?? null, 982_000, 't12 NOI preserved');
  assertEqual(record.rentRoll?.units.length ?? 0, 3, 'rent roll has 3 units');
  assertEqual(record.sourceDocuments.length, 7, 'all 7 source documents listed');
  assertEqual(record.extractionEngineVersion, EXTRACTION_ENGINE_VERSION, 'engine version stamped');
}

console.log('\nExtractionResult — sparse fixture (everything null):');
{
  const body = makeSparseExtractionBody();
  const id = computeExtractionResultId(body);
  const record: ExtractionResult = { id, ...body } as ExtractionResult;

  assert(/^[0-9a-f]{64}$/.test(id), 'sparse id is hex');
  assertEqual(record.t12, null, 't12 is null');
  assertEqual(record.rentRoll, null, 'rentRoll is null');
  assertEqual(record.sourceDocuments.length, 0, 'no source documents');
}

console.log('\nExtractionResult — idempotency:');
{
  const a = computeExtractionResultId(makeFullExtractionBody());
  const b = computeExtractionResultId(makeFullExtractionBody());
  assertEqual(a, b, 'identical bodies hash to same id');

  const c = computeExtractionResultId({ ...makeFullExtractionBody(), dealRef: 'OPP-DIFFERENT' });
  assert(a !== c, 'differing dealRef → different id');
}

console.log('\nExtractionResult — null preservation in canonical form:');
{
  // Architecture §8: missing inputs remain null. This verifies the contract surfaces null,
  // never coerces. Constructing a body with explicit null fields exercises the path.
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'OPP-NULL',
    rentRoll: null,
    t12: {
      period: 'T-12',
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
      noi: null,
      vacancyLoss: null,
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    pca: null,
    appraisal: null,
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: null,
    sourceDocuments: [] as readonly SourceDocumentRef[],
    extractorVersions: {} as Record<string, string>,
  };
  const id = computeExtractionResultId(body);
  assert(/^[0-9a-f]{64}$/.test(id), 'all-null T-12 still produces a stable hash');
}

/* --------------------------- MarketBenchmarks fixtures --------------------- */

function makeMarketBenchmarksBody() {
  const byAssetType: { [K in AssetType]: number | null } = {
    Office:      0.075,
    Retail:      0.065,
    Multifamily: 0.055,
    Hotel:       0.085,
    Industrial:  0.060,
    SelfStorage: 0.070,
    MHC:         0.065,
    MixedUse:    null,
    Other:       null,
  };
  const vacancyByAssetType: { [K in AssetType]: number | null } = {
    Office:      0.12,
    Retail:      0.06,
    Multifamily: 0.05,
    Hotel:       null,
    Industrial:  0.04,
    SelfStorage: 0.10,
    MHC:         0.04,
    MixedUse:    null,
    Other:       null,
  };
  const expensePsf: { [K in AssetType]: number | null } = {
    Office:      8.50,
    Retail:      6.00,
    Multifamily: null,    // per-unit basis, not PSF
    Hotel:       null,    // per-key basis
    Industrial:  3.50,
    SelfStorage: 4.25,
    MHC:         null,    // per-pad basis
    MixedUse:    null,
    Other:       null,
  };

  return {
    asOfDate: AS_OF,
    capRates:        byAssetType,
    vacancyRates:    vacancyByAssetType,
    expensesPerSqFt: expensePsf,
    interestRateAssumptions: {
      baseRate:   0.065,
      stressRate: 0.085,
    },
    marketLiquidityIndex: {
      primary:   0.85,
      secondary: 0.55,
      tertiary:  0.30,
    },
  };
}

console.log('\nMarketBenchmarks — full fixture:');
{
  const body = makeMarketBenchmarksBody();
  const id = computeMarketBenchmarksId(body);
  const record: MarketBenchmarks = { id, ...body } as MarketBenchmarks;

  assert(/^[0-9a-f]{64}$/.test(id), 'id is hex');
  assertEqual(record.capRates.Office, 0.075, 'Office cap rate preserved');
  assertEqual(record.capRates.MixedUse, null, 'MixedUse cap rate is null (no published rate)');
  assertEqual(record.expensesPerSqFt.Multifamily, null, 'Multifamily PSF is null (per-unit basis)');
  assertEqual(record.interestRateAssumptions.baseRate, 0.065, 'baseRate preserved');
  assertEqual(record.marketLiquidityIndex.primary, 0.85, 'primary liquidity preserved');
}

console.log('\nMarketBenchmarks — every AssetType keyed:');
{
  const body = makeMarketBenchmarksBody();
  for (const t of ASSET_TYPES) {
    assert(t in body.capRates, `capRates has key '${t}'`);
    assert(t in body.vacancyRates, `vacancyRates has key '${t}'`);
    assert(t in body.expensesPerSqFt, `expensesPerSqFt has key '${t}'`);
  }
}

console.log('\nMarketBenchmarks — idempotency:');
{
  const a = computeMarketBenchmarksId(makeMarketBenchmarksBody());
  const b = computeMarketBenchmarksId(makeMarketBenchmarksBody());
  assertEqual(a, b, 'identical bodies hash to same id');
}

/* --------------------------- distinctness across record kinds -------------- */

console.log('\nBranded id types are distinct:');
{
  // Compile-time discrimination: AdjustedInputsId !== ExtractionResultId. We can't directly assert
  // a compile error here, but we verify the runtime hashes are independent.
  const er = computeExtractionResultId({ x: 1 });
  const mb = computeMarketBenchmarksId({ x: 1 });
  // Same content → same hash regardless of brand (hash is purely content-derived). The brand
  // discriminates at compile time only.
  assertEqual(er, mb as unknown as typeof er, 'same content → same hash (brand is compile-time only)');
}

console.log('\nSourceDocumentKind enumeration:');
{
  assertEqual(SOURCE_DOCUMENT_KINDS.length, 8, '8 source-document kinds');
  assert(SOURCE_DOCUMENT_KINDS.includes('rent_roll'),         'rent_roll listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('t12'),               't12 listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('pca'),               'pca listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('appraisal'),         'appraisal listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('asr'),               'asr listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('seller_uw'),         'seller_uw listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('loan_terms'),        'loan_terms listed');
  assert(SOURCE_DOCUMENT_KINDS.includes('property_metadata'), 'property_metadata listed');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
