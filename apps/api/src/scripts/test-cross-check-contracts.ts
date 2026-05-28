/**
 * Tests for `cross-check-contracts.service.ts`.
 *
 *   npm run test:cross-check-contracts
 *
 * Verifies: shape, idempotency, conservatism mapping, overall bias, persistence round-trip
 * through `RecordGraphStore` (with the parent AdjustedInputs FK satisfied via in-memory db).
 */

import {
  ASSET_TYPES,
  JUDGMENT_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AssetType,
  ContentHash,
  LibrarySnapshot,
  LibrarySnapshotId,
} from '@cre/contracts';
import type { SellerExtractedMetrics, UnderwritingModel } from '@cre/shared';
import {
  computeAdjustedInputsId,
  computeLibrarySnapshotId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildCrossCheckResult } from '../services/cross-check-contracts.service.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;

function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------------ fixtures --------------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function makeLibrarySnapshot(): LibrarySnapshot {
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType: emptyByAssetType(),
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function lineItem(value: number) {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

function makeAdjustedInputs(librarySnapshotId: LibrarySnapshotId): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId,
    income: {
      grossRentalIncome: lineItem(10_000_000), otherIncome: lineItem(0),
      vacancyPct: lineItem(0.05), concessionsPct: lineItem(0),
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
      capRate: lineItem(0.065), terminalCapRate: lineItem(0.075), concludedCapRate: null,
      rentGrowthPct: lineItem(0.03), expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 7_670_000, value: 118_000_000, dscr: 1.92,
      ltvAppraisal: 0.625, debtYield: 0.1534, expenseRatio: 0.193,
      top1IncomeShare: 0.18, pctIncomeExpiringWithinTerm: 0.22,
    },
    confidenceReduction: 0.05,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function makeSellerMetrics(): SellerExtractedMetrics {
  return {
    noi:          { value: 8_000_000,   source: 'Seller UW Memo', confidence: 1, status: 'found' },
    loanAmount:   { value: 50_000_000,  source: 'Seller UW Memo', confidence: 1, status: 'found' },
    interestRate: { value: 0.065,       source: 'Term Sheet',     confidence: 1, status: 'found' },
    capRate:      { value: 0.06,        source: 'Seller ASR',     confidence: 1, status: 'found' },
    propertyValue:{ value: 133_000_000, source: 'Seller ASR',     confidence: 1, status: 'found' },
    debtService:  { value: 3_800_000,   source: 'Term Sheet',     confidence: 1, status: 'found' },
    dscr:         { value: 2.10,        source: 'Seller UW Memo', confidence: 1, status: 'found' },
  };
}

function makeUwModel(): UnderwritingModel {
  // BP value pattern: NOI a bit lower (conservative), cap rate higher (conservative),
  // value lower, interest rate higher (conservative).
  return {
    netOperatingIncome: 7_670_000,
    loanAmount:         50_000_000,
    interestRate:       0.07,
    capRate:            0.065,
    impliedValue:       118_000_000,
    annualDebtService:  4_000_000,
    dscr:               1.92,
  } as UnderwritingModel;  // legacy shape may have more fields; cast at the test boundary
}

/* --------------------------------- run ----------------------------------- */

const lib = makeLibrarySnapshot();
const ai = makeAdjustedInputs(lib.id);
const sellerMetrics = makeSellerMetrics();
const uwModel = makeUwModel();

console.log('Shape:');
{
  const cc = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });

  assert(typeof cc.id === 'string' && /^[0-9a-f]{64}$/.test(cc.id), 'id is 64-char hex');
  assertEqual(cc.adjustedInputsId, ai.id, 'FK adjustedInputsId stamped');
  assertEqual(cc.analysisAsOfDate, AS_OF, 'analysisAsOfDate stamped');
  assertEqual(cc.findings.length, 7, '7 findings (one per metric)');

  const noi = cc.findings.find(f => f.metric === 'noi');
  assert(noi !== undefined, 'noi finding present');
  assertEqual(noi?.bank.value ?? null, 8_000_000, 'noi.bank.value preserved');
  assertEqual(noi?.bpFinal.value ?? null, 7_670_000, 'noi.bpFinal.value preserved');
  assertEqual(noi?.drivers.length ?? -1, 0, 'drivers empty (judgment engine TBD)');
  assertEqual(noi?.bank.source ?? null, 'SELLER_UW', 'bank.source = SELLER_UW (legacy collapse)');
  assertEqual(noi?.conservatismStatus ?? null, 'CONSERVATIVE', 'noi BP < bank → CONSERVATIVE (lower-is-conservative)');

  const capRate = cc.findings.find(f => f.metric === 'capRate');
  assertEqual(capRate?.conservatismStatus ?? null, 'CONSERVATIVE', 'capRate BP > bank → CONSERVATIVE (higher-is-conservative)');

  const interestRate = cc.findings.find(f => f.metric === 'interestRate');
  assertEqual(interestRate?.conservatismStatus ?? null, 'CONSERVATIVE', 'interestRate BP > bank → CONSERVATIVE');

  const loanAmount = cc.findings.find(f => f.metric === 'loanAmount');
  assertEqual(loanAmount?.conservatismStatus ?? null, 'NEUTRAL', 'loanAmount equal → NEUTRAL');

  // No prose anywhere in the record
  const stringified = JSON.stringify(cc);
  assert(!stringified.includes('commentary'), 'no commentary field anywhere');
  assert(!stringified.includes('severity'), 'no severity field anywhere');
}

console.log('\nIdempotency:');
{
  const a = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  const b = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  assertEqual(a.id, b.id, 'same inputs → same id');
}

console.log('\nDelta math (fraction, not percent):');
{
  const cc = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  const noi = cc.findings.find(f => f.metric === 'noi');
  // (7_670_000 - 8_000_000) / 8_000_000 = -0.04125
  const expected = (7_670_000 - 8_000_000) / 8_000_000;
  assertEqual(noi?.delta.vsBankPct ?? null, expected, 'noi delta.vsBankPct is a fraction');
}

console.log('\nOverall bias:');
{
  const cc = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  // Most BP values are conservative vs seller → should resolve conservative
  assertEqual(cc.overallAdjustmentBias, 'conservative', 'overallAdjustmentBias = conservative for the conservative-skewed fixture');
}

console.log('\nPersistence round-trip:');
{
  const store = new RecordGraphStore(':memory:');
  store.insertLibrarySnapshot(lib);
  store.insertAdjustedInputs(ai);

  const cc = buildCrossCheckResult({
    sellerMetrics, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  const r = store.insertCrossCheckResult(cc);
  assert(r.inserted, 'cross-check inserted with FK to adjusted_inputs');

  const fetched = store.getCrossCheckResult(cc.id);
  assert(fetched !== null, 'retrievable by id');
  assertEqual(fetched?.findings.length ?? -1, 7, 'findings round-trip');
  assertEqual(fetched?.overallAdjustmentBias ?? null, 'conservative', 'bias round-trips');

  // Re-insert idempotent
  const r2 = store.insertCrossCheckResult(cc);
  assert(!r2.inserted, 're-insert reports inserted=false');

  store.close();
}

console.log('\nNull handling:');
{
  const sparseSeller: SellerExtractedMetrics = {
    noi:           { value: null,         source: '', confidence: 0, status: 'missing' },
    loanAmount:    { value: 50_000_000,   source: '', confidence: 1, status: 'found' },
    interestRate:  { value: null,         source: '', confidence: 0, status: 'missing' },
    capRate:       { value: 0.06,         source: '', confidence: 1, status: 'found' },
    propertyValue: { value: null,         source: '', confidence: 0, status: 'missing' },
    debtService:   { value: null,         source: '', confidence: 0, status: 'missing' },
    dscr:          { value: null,         source: '', confidence: 0, status: 'missing' },
  };
  const cc = buildCrossCheckResult({
    sellerMetrics: sparseSeller, uwModel,
    adjustedInputsId: ai.id, analysisAsOfDate: AS_OF,
  });
  const noi = cc.findings.find(f => f.metric === 'noi');
  assert(noi !== undefined && noi.bank.value === null, 'null bank value preserved');
  assert(noi !== undefined && noi.delta.vsBankPct === null, 'null bank → null delta');
  // Batch 6.2 (audit U17): null bank → INSUFFICIENT_DATA, not NEUTRAL.
  // 'NEUTRAL' is "we compared and found no skew"; null inputs mean no comparison happened.
  assertEqual(noi?.conservatismStatus ?? null, 'INSUFFICIENT_DATA', 'null bank → INSUFFICIENT_DATA (no comparison)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
