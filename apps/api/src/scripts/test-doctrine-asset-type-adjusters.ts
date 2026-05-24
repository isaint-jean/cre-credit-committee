/**
 * Tests for asset-type adjusters (Batch 5b).
 *
 *   npm run test:doctrine-asset-type-adjusters
 *
 * Verifies: each adjuster fires/doesn't fire correctly; dispatch by propertyType only fires
 * the right adjusters; asset types without v1.0 adjusters return empty; penalty values match
 * architecture §11.
 */

import {
  ASSET_TYPES,
  type AdjustedInputs,
  type AdjustedLineItem,
  type AssetProfile,
  type AssetType,
  type ContentHash,
  type NarrativeFacts,
} from '@cre/contracts';
import {
  ASSET_TYPE_ADJUSTER_PENALTIES,
  evaluateAssetTypeAdjusters,
} from '../services/doctrine/asset-type-adjusters.js';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
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

/* ------------------------------- fixtures -------------------------------- */

function lineItem(value: number): AdjustedLineItem {
  return { raw: value, adjusted: value, source: 'BANK', adjustments: [] };
}

function makeProfile(t: AssetType): AssetProfile {
  const body = { propertyType: t, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeAdjustedInputs(opts: { dscr?: number | null; debtYield?: number | null } = {}): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF, judgmentEngineVersion: '1.1' as const,
    librarySnapshotId: computeLibrarySnapshotId({ x: 1 }),
    income: {
      grossRentalIncome: lineItem(1_000_000), otherIncome: lineItem(0),
      vacancyPct: lineItem(0.05), concessionsPct: lineItem(0),
      effectiveGrossIncome: lineItem(950_000),
    },
    expenses: {
      realEstateTaxes: lineItem(80_000), insurance: lineItem(15_000),
      utilities: lineItem(20_000), managementFee: lineItem(28_000),
      payroll: lineItem(0), maintenance: lineItem(30_000),
      other: lineItem(0),
      generalAndAdmin: lineItem(0), janitorial: lineItem(0), reimbursements: lineItem(0),
      totalOperatingExpenses: lineItem(173_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0), upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0), monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0), monthlyTenantImprovements: lineItem(0), monthlyLeasingCommissions: lineItem(0),
      pcaImmediateRepairs: lineItem(0),
    },
    loan: {
      loanAmount: lineItem(10_000_000), interestRate: lineItem(0.07),
      termMonths: lineItem(120), amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0), maturityBalance: lineItem(9_000_000),
      debtServiceAnnual: lineItem(800_000),
    },
    assumptions: {
      capRate: lineItem(0.065), terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03), expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 800_000, value: 12_307_692,
      dscr: opts.dscr === undefined ? 1.30 : opts.dscr,
      ltvAppraisal: 0.60,
      debtYield: opts.debtYield === undefined ? 0.10 : opts.debtYield,
      expenseRatio: 0.18,
      top1IncomeShare: 0.25, pctIncomeExpiringWithinTerm: 0.20,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function makeNarrativeFacts(opts: Partial<{
  propertyClass: 'A' | 'B' | 'C' | null;
  shadowVacancyFlag: boolean | null;
  isMall: boolean | null;
  franchiseExpirationWithinTerm: boolean | null;
  pipRequired: boolean | null;
  pipBudgetPerKey: number | null;
  privateWastewater: boolean | null;
  parkOwnedHomesPct: number | null;
}> = {}): NarrativeFacts {
  const body = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: 0.95, occupancyCurrent: 0.95,
    propertyClass: opts.propertyClass === undefined ? 'A' : opts.propertyClass,
    shadowVacancyFlag: opts.shadowVacancyFlag === undefined ? false : opts.shadowVacancyFlag,
    subleaseCompetition: 'low' as const,
    leasingVelocityDataAvailable: true,
    isMall: opts.isMall === undefined ? null : opts.isMall,
    franchiseExpirationWithinTerm: opts.franchiseExpirationWithinTerm === undefined ? null : opts.franchiseExpirationWithinTerm,
    pipRequired: opts.pipRequired === undefined ? null : opts.pipRequired,
    pipBudgetPerKey: opts.pipBudgetPerKey === undefined ? null : opts.pipBudgetPerKey,
    privateWastewater: opts.privateWastewater === undefined ? null : opts.privateWastewater,
    parkOwnedHomesPct: opts.parkOwnedHomesPct === undefined ? null : opts.parkOwnedHomesPct,
    t12NoiTrend: 'flat' as const, isSingleTenant: false,
    appraisalValue: 12_500_000, appraisalCapRate: 0.065,
    asrValue: null, marketValueFromComps: null,
    exitCapRateBase: 0.065, exitCapRateStressed: 0.075,
  };
  return { id: computeNarrativeFactsId(body), ...body } as NarrativeFacts;
}

/* ------------------------------- Office ----------------------------------- */

console.log('Office:');
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Office'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'A' }),
  });
  assertEqual(r.length, 0, 'Class A office, no shadow vacancy → no adjusters fire');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Office'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'B' }),
  });
  assertEqual(r.length, 1, 'Class B office → 1 adjuster fires');
  assertEqual(r[0]?.ruleId ?? '', 'OFFICE_LOW_QUALITY_CLASS', 'low quality class fired');
  assertEqual(r[0]?.points ?? 0, -8, 'low quality class penalty -8 (architecture §11)');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Office'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'C', shadowVacancyFlag: true }),
  });
  assertEqual(r.length, 2, 'Class C + shadow vacancy → 2 adjusters fire');
  const total = r.reduce((s, a) => s + a.points, 0);
  assertEqual(total, -14, 'total office penalty: -8 + -6 = -14');
}

/* ------------------------------- Retail ----------------------------------- */

console.log('\nRetail:');
{
  // Mall + DY 0.10 (below 0.13) → fires
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Retail'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.10 }),
    narrativeFacts: makeNarrativeFacts({ isMall: true }),
  });
  assertEqual(r.length, 1, 'Mall with DY below 13% → fires');
  assertEqual(r[0]?.ruleId ?? '', 'MALL_DY_BELOW_MIN', 'mall DY rule');
  assertEqual(r[0]?.points ?? 0, -10, 'mall DY penalty -10');
}
{
  // Mall + DY 0.15 (above 0.13) → doesn't fire
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Retail'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.15 }),
    narrativeFacts: makeNarrativeFacts({ isMall: true }),
  });
  assertEqual(r.length, 0, 'Mall with DY above 13% → no fire');
}
{
  // Not a mall → doesn't fire even with low DY
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Retail'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.05 }),
    narrativeFacts: makeNarrativeFacts({ isMall: false }),
  });
  assertEqual(r.length, 0, 'Non-mall retail with low DY → no fire');
}

/* -------------------------------- Hotel ----------------------------------- */

console.log('\nHotel:');
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Hotel'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ franchiseExpirationWithinTerm: true }),
  });
  assertEqual(r.length, 1, 'franchise expires within term → 1 adjuster');
  assertEqual(r[0]?.ruleId ?? '', 'HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM', 'franchise rule');
  assertEqual(r[0]?.points ?? 0, -10, 'franchise penalty -10');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Hotel'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ pipRequired: true, pipBudgetPerKey: 10_000 }),
  });
  assertEqual(r.length, 1, 'PIP required + budget below 15k/key → fires');
  assertEqual(r[0]?.ruleId ?? '', 'HOTEL_PIP_UNDERSIZED', 'PIP rule');
  assertEqual(r[0]?.points ?? 0, -8, 'PIP penalty -8');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Hotel'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ pipRequired: true, pipBudgetPerKey: 20_000 }),
  });
  assertEqual(r.length, 0, 'PIP budget above 15k/key → no fire');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Hotel'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({
      franchiseExpirationWithinTerm: true,
      pipRequired: true, pipBudgetPerKey: 10_000,
    }),
  });
  assertEqual(r.length, 2, 'both hotel adjusters fire');
}

/* ------------------------------ SelfStorage ------------------------------- */

console.log('\nSelfStorage:');
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('SelfStorage'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.07, dscr: 1.20 }),
    narrativeFacts: makeNarrativeFacts(),
  });
  assertEqual(r.length, 2, 'DY 0.07 < 0.08 + DSCR 1.20 < 1.30 → both fire');
  const dyAdj = r.find(a => a.ruleId === 'STORAGE_DY_BELOW_FLOOR');
  const dscrAdj = r.find(a => a.ruleId === 'STORAGE_DSCR_BELOW_TARGET');
  assertEqual(dyAdj?.points ?? 0, -12, 'storage DY floor penalty -12');
  assertEqual(dscrAdj?.points ?? 0, -6, 'storage DSCR target penalty -6');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('SelfStorage'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.10, dscr: 1.40 }),
    narrativeFacts: makeNarrativeFacts(),
  });
  assertEqual(r.length, 0, 'storage with DY/DSCR above thresholds → no fire');
}

/* -------------------------------- MHC ------------------------------------- */

console.log('\nMHC:');
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('MHC'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ privateWastewater: true }),
  });
  assertEqual(r.length, 1, 'private wastewater → fires');
  assertEqual(r[0]?.ruleId ?? '', 'MHC_PRIVATE_WASTEWATER_RISK', 'wastewater rule');
  assertEqual(r[0]?.points ?? 0, -10, 'wastewater penalty -10');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('MHC'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ parkOwnedHomesPct: 0.30 }),
  });
  assertEqual(r.length, 1, 'park-owned homes 30% > 20% → fires');
  assertEqual(r[0]?.ruleId ?? '', 'MHC_HIGH_PARK_OWNED_HOMES', 'park-owned rule');
}
{
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('MHC'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ parkOwnedHomesPct: 0.15 }),
  });
  assertEqual(r.length, 0, 'park-owned 15% (below 20%) → no fire');
}

/* ----------------------- Asset types without v1.0 adjusters --------------- */

console.log('\nAsset types without v1.0 adjusters:');
for (const t of ['Industrial', 'Multifamily', 'MixedUse', 'Other'] as const) {
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile(t),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.05, dscr: 1.0 }),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'C', isMall: true, privateWastewater: true }),
  });
  assertEqual(r.length, 0, `${t} → no asset-type adjusters in v1.0`);
}

/* ----------------------- Dispatch isolation ------------------------------- */

console.log('\nDispatch isolation:');
{
  // Office adjusters should NOT fire on a Multifamily deal (even if narrative facts match Office predicates)
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Multifamily'),
    adjustedInputs: makeAdjustedInputs(),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'C', shadowVacancyFlag: true }),
  });
  assertEqual(r.length, 0, 'Office predicates do not leak into Multifamily dispatch (audit §F #12)');
}
{
  // SelfStorage DY rule should NOT fire on Office even with low DY
  const r = evaluateAssetTypeAdjusters({
    assetProfile: makeProfile('Office'),
    adjustedInputs: makeAdjustedInputs({ debtYield: 0.05 }),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'A' }),
  });
  assertEqual(r.length, 0, 'SelfStorage DY rule does not leak into Office');
}

/* ----------------------- Penalty values match architecture §11 ----------- */

console.log('\nPenalty values:');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.OFFICE_LOW_QUALITY_CLASS,                -8,  'office low quality = -8');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.OFFICE_SHADOW_VACANCY,                   -6,  'office shadow vacancy = -6');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.MALL_DY_BELOW_MIN,                      -10,  'mall DY = -10');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM, -10,  'hotel franchise = -10');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.HOTEL_PIP_UNDERSIZED,                    -8,  'hotel PIP = -8');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.STORAGE_DY_BELOW_FLOOR,                 -12,  'storage DY = -12');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.STORAGE_DSCR_BELOW_TARGET,               -6,  'storage DSCR = -6');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.MHC_PRIVATE_WASTEWATER_RISK,            -10,  'MHC wastewater = -10');
assertEqual(ASSET_TYPE_ADJUSTER_PENALTIES.MHC_HIGH_PARK_OWNED_HOMES,               -6,  'MHC park-owned = -6');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
