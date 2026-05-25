/**
 * Tests for `stress-test-contracts.service.ts`.
 *
 *   npm run test:stress-contracts
 *
 * Verifies asset-class dispatch, scenario counts, math correctness on a known fixture, breach
 * detection, persistence round-trip via RecordGraphStore, and the rent-roll-missing fallback.
 */

import {
  ASSET_TYPES,
  JUDGMENT_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AssetType,
  AssetProfile,
  ContentHash,
  LibrarySnapshot,
  LibrarySnapshotId,
  PropertyType,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeLibrarySnapshotId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  buildStressOutputs,
  chooseStressMethod,
  STRESS_COVENANT_THRESHOLDS,
  type TopTenantShare,
} from '../services/stress-test-contracts.service.js';

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
  // NOI ~= 7.67M, DSCR ~= 1.92, value ~= 118M, LTV ~= 0.42 (loan 50M / value 118M),
  // debtYield ~= 0.153
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
      capRate: lineItem(0.065), terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03), expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 7_670_000, value: 118_000_000, dscr: 1.92,
      ltvAppraisal: 0.42, debtYield: 0.1534, expenseRatio: 0.193,
      top1IncomeShare: 0.30, pctIncomeExpiringWithinTerm: 0.22,
    },
    confidenceReduction: 0.05,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function profile(propertyType: PropertyType): AssetProfile {
  const body = { propertyType, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

/* --------------------------------- run ----------------------------------- */

const lib = makeLibrarySnapshot();
const ai = makeAdjustedInputs(lib.id);

console.log('Asset-class dispatch:');
{
  assertEqual(chooseStressMethod('Office'),       'TENANT_REMOVAL',     'Office → TENANT_REMOVAL');
  assertEqual(chooseStressMethod('Retail'),       'TENANT_REMOVAL',     'Retail → TENANT_REMOVAL');
  assertEqual(chooseStressMethod('Industrial'),   'TENANT_REMOVAL',     'Industrial → TENANT_REMOVAL');
  assertEqual(chooseStressMethod('Multifamily'),  'OCC_RENT_CONCESSION','Multifamily → OCC_RENT_CONCESSION');
  assertEqual(chooseStressMethod('Hotel'),        'OCC_RENT_CONCESSION','Hotel → OCC_RENT_CONCESSION');
  assertEqual(chooseStressMethod('SelfStorage'),  'OCC_RENT_CONCESSION','SelfStorage → OCC_RENT_CONCESSION');
  assertEqual(chooseStressMethod('MHC'),          'OCC_RENT_CONCESSION','MHC → OCC_RENT_CONCESSION');
  assertEqual(chooseStressMethod('MixedUse'),     'DEFAULT',            'MixedUse → DEFAULT');
  assertEqual(chooseStressMethod('Other'),        'DEFAULT',            'Other → DEFAULT');
}

console.log('\nDEFAULT method (MixedUse → 5 scenarios):');
{
  const out = buildStressOutputs({
    adjustedInputs: ai, assetProfile: profile('MixedUse'),
    analysisAsOfDate: AS_OF,
  });
  assertEqual(out.method, 'DEFAULT', 'method = DEFAULT');
  assertEqual(out.scenarios.length, 5, '5 default scenarios');
  assertEqual(out.scenarios[0]?.name ?? '', 'Vacancy +5%', 'first scenario name');

  // Vacancy +5%: gross 10M → vacancy 5%+5%=10%, effective 9M, NOI = 9M - 1.83M = 7.17M
  const vac = out.scenarios.find(s => s.name === 'Vacancy +5%');
  assert(vac !== undefined && vac.noi !== null, 'vacancy scenario has noi');
  if (vac && vac.noi !== null) {
    const expected = 10_000_000 * (1 - 0.10) - 1_830_000;
    assert(Math.abs(vac.noi - expected) < 1, `vacancy +5% NOI math (got ${vac.noi}, expected ${expected})`);
  }
}

console.log('\nOCC_RENT_CONCESSION method (Multifamily → 5 scenarios):');
{
  const out = buildStressOutputs({
    adjustedInputs: ai, assetProfile: profile('Multifamily'),
    analysisAsOfDate: AS_OF,
  });
  assertEqual(out.method, 'OCC_RENT_CONCESSION', 'method = OCC_RENT_CONCESSION');
  assertEqual(out.scenarios.length, 5, '5 occ-rent scenarios');
  const names = out.scenarios.map(s => s.name);
  assert(names.includes('Occ -5%'),  'has Occ -5%');
  assert(names.includes('Occ -10%'), 'has Occ -10%');
  assert(names.includes('Rent -5%'), 'has Rent -5%');
  assert(names.includes('Rent -10%'),'has Rent -10%');
  assert(names.includes('Combo'),    'has Combo');

  // Rent -10%: gross 9M (after rent delta), vacancy 5% → 8.55M, NOI = 8.55M - 1.83M = 6.72M
  const rentDown = out.scenarios.find(s => s.name === 'Rent -10%');
  if (rentDown && rentDown.noi !== null) {
    const expected = 10_000_000 * 0.9 * (1 - 0.05) - 1_830_000;
    assert(Math.abs(rentDown.noi - expected) < 1, `rent -10% NOI math (got ${rentDown.noi}, expected ${expected})`);
  }
}

console.log('\nTENANT_REMOVAL method (Office + rent roll → 5 scenarios):');
{
  const tenants: TopTenantShare[] = [
    { rank: 1, incomeShare: 0.30 },
    { rank: 2, incomeShare: 0.20 },
    { rank: 3, incomeShare: 0.10 },
  ];
  const out = buildStressOutputs({
    adjustedInputs: ai, assetProfile: profile('Office'),
    topTenantShares: tenants,
    analysisAsOfDate: AS_OF,
  });
  assertEqual(out.method, 'TENANT_REMOVAL', 'method = TENANT_REMOVAL');
  assertEqual(out.scenarios.length, 5, '5 tenant-removal scenarios');

  // Remove T1 (30% share): gross drops to 7M, vacancy 5%, EGI 6.65M, NOI 6.65M - 1.83M = 4.82M
  const removeT1 = out.scenarios.find(s => s.name === 'Remove T1');
  if (removeT1 && removeT1.noi !== null) {
    const expected = 10_000_000 * 0.70 * 0.95 - 1_830_000;
    assert(Math.abs(removeT1.noi - expected) < 1, `Remove T1 NOI math (got ${removeT1.noi}, expected ${expected})`);
  }

  // Remove T1+T2+T3 (60% combined): gross 4M, EGI 3.8M, NOI 1.97M; DSCR < 1.15 → breach
  const removeAll = out.scenarios.find(s => s.name === 'Remove T1+T2+T3');
  if (removeAll) {
    assert(removeAll.dscr !== null && removeAll.dscr < STRESS_COVENANT_THRESHOLDS.minDSCR, 'Remove T1+T2+T3 → DSCR breach');
    assert(removeAll.breaches.includes('DSCR'), 'breach reported');
  }
}

console.log('\nTENANT_REMOVAL fallback (Office without rent roll → DEFAULT):');
{
  const out = buildStressOutputs({
    adjustedInputs: ai, assetProfile: profile('Office'),
    analysisAsOfDate: AS_OF,
  });
  assertEqual(out.method, 'DEFAULT', 'falls back to DEFAULT when topTenantShares missing');
  assertEqual(out.scenarios.length, 5, 'default scenarios produced');
}

console.log('\nIdempotency:');
{
  const a = buildStressOutputs({ adjustedInputs: ai, assetProfile: profile('Multifamily'), analysisAsOfDate: AS_OF });
  const b = buildStressOutputs({ adjustedInputs: ai, assetProfile: profile('Multifamily'), analysisAsOfDate: AS_OF });
  assertEqual(a.id, b.id, 'same inputs → same id');
}

console.log('\nID format:');
{
  const out = buildStressOutputs({ adjustedInputs: ai, assetProfile: profile('Multifamily'), analysisAsOfDate: AS_OF });
  assert(/^[0-9a-f]{64}$/.test(out.id), 'id is 64-char hex');
}

console.log('\nVersioning + FK:');
{
  const out = buildStressOutputs({ adjustedInputs: ai, assetProfile: profile('Multifamily'), analysisAsOfDate: AS_OF });
  assertEqual(out.adjustedInputsId, ai.id, 'FK adjustedInputsId stamped');
  assertEqual(out.stressEngineVersion, '1.0', 'engine version stamped');
}

console.log('\nPersistence round-trip:');
{
  const store = new RecordGraphStore(':memory:');
  store.insertLibrarySnapshot(lib);
  store.insertAdjustedInputs(ai);

  const out = buildStressOutputs({ adjustedInputs: ai, assetProfile: profile('Multifamily'), analysisAsOfDate: AS_OF });
  const r = store.insertStressOutputs(out);
  assert(r.inserted, 'stress outputs inserted with FK');

  const fetched = store.getStressOutputs(out.id);
  assert(fetched !== null, 'retrievable by id');
  assertEqual(fetched?.method ?? '', 'OCC_RENT_CONCESSION', 'method round-trips');
  assertEqual(fetched?.scenarios.length ?? -1, 5, 'scenarios round-trip');

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
