/**
 * Validation for the doctrine-clean input adapter.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-adapter.ts
 *
 * Checks:
 *   1. UNIT TESTS — synthetic ExtractionResult + PropertyMetadata produce the
 *      expected DealBag (each raw read + each derivation + pick-orders + missing-
 *      source → null).
 *   2. INTEGRATION — adapter → evaluateDeal end-to-end on a synthetic "real-deal"
 *      shape; rating is sane.
 *   3. ASSET-TYPE FALLBACK — propertySubtype heuristic resolves to the right
 *      AssetType for the common labels.
 *   4. FENCE — adapter imports only @cre/contracts (ExtractionResult, PropertyMetadata,
 *      AssetType) + DealBag from doctrine-clean. NO judgment / AdjustedInputs /
 *      valuationConclusion / handbook imports.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ExtractionResult,
  RentRollExtraction,
  AssetType,
} from '@cre/contracts';
import type { PropertyMetadata } from '@cre/contracts';
import {
  adaptExtractionToDealBag,
  pickIssuerNoi,
  pickConcludedValue,
  pickOccupancy,
  deriveTopTenantShare,
  deriveTenantDataStatus,
  deriveRolloverShare,
  evaluateDeal,
} from '../doctrine-clean/index.js';

const OUT_PATH = '/tmp/calibration-doctrine-clean-adapter.out';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; return; }
  failed++; failures.push(label);
}
function assertEq<T>(got: T, want: T, label: string): void {
  if (got === want) { passed++; return; }
  failed++; failures.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function assertClose(got: number | null, want: number, eps: number, label: string): void {
  if (got !== null && Math.abs(got - want) <= eps) { passed++; return; }
  failed++; failures.push(`${label}: got ${got} want ~${want} (eps ${eps})`);
}

/* ------- minimal extraction-shape builders for synthetic tests ------- */

function mkExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    id: 'TEST_ID' as ExtractionResult['id'],
    analysisAsOfDate: '2026-06-12T00:00:00.000Z' as ExtractionResult['analysisAsOfDate'],
    extractionEngineVersion: 'test-engine' as ExtractionResult['extractionEngineVersion'],
    dealRef: 'TEST_DEAL',
    rentRoll: null,
    inPlace: null,
    t12Actual: null,
    pca: null,
    appraisal: null,
    sellerUw: null,
    sellerUwOperatingStatement: null,
    asr: null,
    loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
    ...overrides,
  };
}

function mkPropertyMetadata(overrides: Partial<PropertyMetadata> = {}): PropertyMetadata {
  return {
    id: 'PM_TEST' as PropertyMetadata['id'],
    source: 'asr_extraction',
    propertyName: null,
    propertySubtype: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    county: null,
    msa: null,
    submarket: null,
    yearBuilt: null,
    yearRenovated: null,
    buildingClass: null,
    totalSquareFeet: null,
    totalUnits: null,
    totalRooms: null,
    totalPads: null,
    occupancyPhysical: null,
    occupancyEconomic: null,
    ownershipInterest: null,
    numberOfBuildings: null,
    ...overrides,
  };
}

function mkRentRoll(units: Array<Partial<RentRollExtraction['units'][number]>>): RentRollExtraction {
  return {
    units: units.map((u, i) => ({
      unitId: `U${i + 1}`,
      tenantName: null,
      leaseStart: null,
      leaseEnd: null,
      baseRentMonthly: null,
      inPlaceRentMonthly: null,
      occupied: false,
      concessions: null,
      securityDeposit: null,
      ...u,
    })),
    summary: { totalUnits: units.length, occupiedUnits: units.filter(u => u.tenantName !== null).length, economicOccupancy: null },
  };
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / adapter (extraction → DealBag) — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* ============= (1) UNIT TESTS — pick helpers ============= */
  out.push('================================================================');
  out.push('(1) UNIT TESTS — pick helpers');
  out.push('================================================================');
  out.push('');

  // pickIssuerNoi — pick order
  const noiOrderTests = [
    { ext: mkExtraction({ sellerUwOperatingStatement: { period: 'gs', income: {} as any, expenses: {} as any, noi: 1000, vacancyLoss: null, belowNoiAdjustments: {} as any }, sellerUw: { underwrittenNOI: 2000, underwrittenRentGrowth: null, underwrittenVacancy: null }, asr: { underwrittenNOI: 3000, impliedValue: null, impliedCapRate: null } }), want: 1000 },
    { ext: mkExtraction({ sellerUw: { underwrittenNOI: 2000, underwrittenRentGrowth: null, underwrittenVacancy: null }, asr: { underwrittenNOI: 3000, impliedValue: null, impliedCapRate: null } }), want: 2000 },
    { ext: mkExtraction({ asr: { underwrittenNOI: 3000, impliedValue: null, impliedCapRate: null } }), want: 3000 },
    { ext: mkExtraction({}), want: null },
  ];
  for (const t of noiOrderTests) {
    assertEq(pickIssuerNoi(t.ext), t.want, `pickIssuerNoi → ${t.want}`);
  }

  // pickConcludedValue — pick order
  const valueOrderTests = [
    { ext: mkExtraction({ appraisal: { valueConclusion: 50_000_000, capRate: null, methodology: null }, asr: { impliedValue: 60_000_000, impliedCapRate: null, underwrittenNOI: null } }), want: 50_000_000 },
    { ext: mkExtraction({ asr: { impliedValue: 60_000_000, impliedCapRate: null, underwrittenNOI: null } }), want: 60_000_000 },
    { ext: mkExtraction({}), want: null },
  ];
  for (const t of valueOrderTests) {
    assertEq(pickConcludedValue(t.ext), t.want, `pickConcludedValue → ${t.want}`);
  }

  // pickOccupancy — pick order
  const occTests = [
    { pm: mkPropertyMetadata({ occupancyEconomic: 0.91, occupancyPhysical: 0.95 }), ext: mkExtraction({ sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.08 } }), want: 0.91 },
    { pm: mkPropertyMetadata({ occupancyPhysical: 0.95 }), ext: mkExtraction({ sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.08 } }), want: 0.95 },
    { pm: null, ext: mkExtraction({ sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: null, underwrittenVacancy: 0.08 } }), want: 0.92 },
    { pm: null, ext: mkExtraction({}), want: null },
  ];
  for (const t of occTests) {
    const got = pickOccupancy(t.pm, t.ext);
    if (t.want === null) assertEq(got, null, `pickOccupancy → null`);
    else assertClose(got, t.want, 1e-9, `pickOccupancy → ${t.want}`);
  }

  /* ============= (2) UNIT TESTS — rent-roll derivations ============= */
  out.push('================================================================');
  out.push('(2) UNIT TESTS — rent-roll derivations');
  out.push('================================================================');
  out.push('');

  // largestTenantPct — single tenant
  assertClose(
    deriveTopTenantShare(mkRentRoll([{ tenantName: 'Anchor', baseRentMonthly: 1000 }])),
    1.0, 1e-9, 'largestTenantPct single-tenant = 1.00',
  );
  // largestTenantPct — multi tenant
  assertClose(
    deriveTopTenantShare(mkRentRoll([
      { tenantName: 'A', baseRentMonthly: 1000 },
      { tenantName: 'B', baseRentMonthly: 500 },
      { tenantName: 'C', baseRentMonthly: 500 },
    ])),
    0.5, 1e-9, 'largestTenantPct top=50%',
  );
  // largestTenantPct — same tenant in multiple units sums
  assertClose(
    deriveTopTenantShare(mkRentRoll([
      { tenantName: 'A', baseRentMonthly: 100 },
      { tenantName: 'A', baseRentMonthly: 200 },
      { tenantName: 'B', baseRentMonthly: 100 },
    ])),
    300 / 400, 1e-9, 'largestTenantPct same-tenant-multi-unit sums',
  );
  // largestTenantPct — vacant excluded
  assertClose(
    deriveTopTenantShare(mkRentRoll([
      { tenantName: 'A', baseRentMonthly: 1000 },
      { tenantName: null, baseRentMonthly: null },
    ])),
    1.0, 1e-9, 'largestTenantPct vacant excluded',
  );
  // largestTenantPct — null rent-roll
  assertEq(deriveTopTenantShare(null), null, 'largestTenantPct null rentRoll → null');
  // largestTenantPct — falls back to inPlaceRentMonthly when baseRent null
  assertClose(
    deriveTopTenantShare(mkRentRoll([
      { tenantName: 'A', baseRentMonthly: null, inPlaceRentMonthly: 500 },
    ])),
    1.0, 1e-9, 'largestTenantPct inPlaceRent fallback',
  );

  // tenantDataStatus
  assertEq(deriveTenantDataStatus(null, 'Hotel'), 'na-by-asset-type', 'tenantDataStatus Hotel → N/A');
  assertEq(deriveTenantDataStatus(null, 'Multifamily'), 'na-by-asset-type', 'tenantDataStatus Multifamily → N/A');
  assertEq(deriveTenantDataStatus(null, 'MHC'), 'na-by-asset-type', 'tenantDataStatus MHC → N/A');
  assertEq(deriveTenantDataStatus(null, 'SelfStorage'), 'na-by-asset-type', 'tenantDataStatus SelfStorage → N/A');
  assertEq(deriveTenantDataStatus(null, 'Retail'), 'parse-failed', 'tenantDataStatus Retail no rentRoll → parse-failed');
  assertEq(deriveTenantDataStatus(null, 'Office'), 'parse-failed', 'tenantDataStatus Office no rentRoll → parse-failed');
  assertEq(deriveTenantDataStatus(null, null), null, 'tenantDataStatus null assetType + null rentRoll → null');
  assertEq(
    deriveTenantDataStatus(mkRentRoll([{ tenantName: 'A' }]), 'Office'),
    'single-tenant', 'tenantDataStatus 1 tenant → single-tenant',
  );
  assertEq(
    deriveTenantDataStatus(mkRentRoll([{ tenantName: 'A' }, { tenantName: 'B' }]), 'Office'),
    'multi-tenant-parsed', 'tenantDataStatus 2+ → multi-tenant-parsed',
  );

  // deriveRolloverShare
  const matDate = '2025-01-01T00:00:00.000Z';
  assertClose(
    deriveRolloverShare(
      mkRentRoll([
        { tenantName: 'A', baseRentMonthly: 1000, leaseEnd: '2024-06-01T00:00:00.000Z' },  // expires before
        { tenantName: 'B', baseRentMonthly: 1000, leaseEnd: '2030-01-01T00:00:00.000Z' },  // after
      ]),
      matDate,
    ),
    0.5, 1e-9, 'rolloverShare half-expiring',
  );
  assertEq(deriveRolloverShare(null, matDate), null, 'rolloverShare null rentRoll → null');
  assertEq(
    deriveRolloverShare(mkRentRoll([{ tenantName: 'A', baseRentMonthly: 1000, leaseEnd: '2030-01-01T00:00:00.000Z' }]), null),
    null, 'rolloverShare null maturity → null',
  );

  /* ============= (3) FULL ADAPTER — synthetic end-to-end ============= */
  out.push('================================================================');
  out.push('(3) FULL ADAPTER — synthetic end-to-end');
  out.push('================================================================');
  out.push('');
  // Build a realistic synthetic deal: Office in CBD, with sellerUw NOI,
  // appraisal value, IO loan with amort.
  const synExt = mkExtraction({
    sellerUwOperatingStatement: { period: 'gs', income: {} as any, expenses: {} as any, noi: 3_500_000, vacancyLoss: null, belowNoiAdjustments: {} as any },
    appraisal: { valueConclusion: 50_000_000, capRate: 0.07, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 3_400_000, underwrittenRentGrowth: null, underwrittenVacancy: 0.08 },
    loanTerms: { loanAmount: 30_000_000, interestRate: 0.045, amortization: 360, interestOnlyPeriod: 60, maturityDate: '2034-12-01T00:00:00.000Z' },
    rentRoll: mkRentRoll([
      { tenantName: 'BigCo', baseRentMonthly: 100_000, leaseEnd: '2036-12-01T00:00:00.000Z' },   // extends beyond 2034-12 maturity
      { tenantName: 'SmallCo', baseRentMonthly: 50_000, leaseEnd: '2035-06-01T00:00:00.000Z' },  // extends beyond
      { tenantName: 'TinyCo', baseRentMonthly: 25_000, leaseEnd: '2030-01-01T00:00:00.000Z' },   // expires within term
    ]),
  });
  const synPm = mkPropertyMetadata({
    propertyName: 'Synthetic Office Tower',
    propertySubtype: 'CBD Office',
    city: 'Chicago',
    state: 'IL',
    occupancyEconomic: 0.93,
  });
  const bag = adaptExtractionToDealBag(synExt, synPm, { explicitAssetType: 'Office' });
  out.push('  DealBag synthesized:');
  out.push(`    propertyName=${bag.propertyName}  assetType=${bag.assetType}  subType=${bag.subType}`);
  out.push(`    loanAmount=${bag.loanAmount?.toLocaleString()}  coupon=${bag.coupon}  amortMonths=${bag.amortMonths}  ioYears=${bag.ioYears}`);
  out.push(`    concludedValue=${bag.concludedValue?.toLocaleString()}  uwY1Noi=${bag.uwY1Noi?.toLocaleString()}  t12Noi=${bag.t12Noi}`);
  out.push(`    underwrittenOccupancy=${bag.underwrittenOccupancy}  largestTenantPct=${bag.largestTenantPct?.toFixed(4)}`);
  out.push(`    tenantDataStatus=${bag.tenantDataStatus}  largestTenantBasis=${bag.largestTenantBasis}`);
  out.push(`    pctIncomeExpiringWithinTerm=${bag.pctIncomeExpiringWithinTerm?.toFixed(4)}  marketTier=${bag.marketTier}  termYears=${bag.termYears}`);
  out.push('');

  // Spot-check expected values
  assertEq(bag.assetType, 'Office', 'adapter assetType=Office');
  assertEq(bag.subType, 'CBD Office', 'adapter subType passthrough');
  assertEq(bag.uwY1Noi, 3_500_000, 'adapter uwY1Noi from sellerUwOperatingStatement');  // not 3,400,000 (sellerUw narrative) — pick order
  assertEq(bag.concludedValue, 50_000_000, 'adapter concludedValue from appraisal');
  assertEq(bag.underwrittenOccupancy, 0.93, 'adapter occupancy from PM economic');
  assertEq(bag.ioYears, 5, 'adapter ioYears = 60/12');
  assertEq(bag.amortMonths, 360, 'adapter amortMonths');
  assertEq(bag.marketTier, 'Unknown', 'adapter marketTier=Unknown (first-cutover default)');
  assertEq(bag.termYears, null, 'adapter termYears=null (first-cutover default)');
  assertEq(bag.largestTenantBasis, 'base-rent', 'adapter largestTenantBasis=base-rent');
  // Top tenant: BigCo $1.2M / $2.1M = 0.5714
  assertClose(bag.largestTenantPct, 1_200_000 / 2_100_000, 1e-9, 'adapter largestTenantPct from rent roll');
  // Rollover: TinyCo $300k / $2.1M = 0.1429
  assertClose(bag.pctIncomeExpiringWithinTerm, 300_000 / 2_100_000, 1e-9, 'adapter rollover share');
  assertEq(bag.tenantDataStatus, 'multi-tenant-parsed', 'adapter tenantDataStatus=multi-tenant-parsed');

  /* ============= (4) ASSET-TYPE FALLBACK heuristic ============= */
  out.push('================================================================');
  out.push('(4) ASSET-TYPE FALLBACK — from propertySubtype heuristic');
  out.push('================================================================');
  out.push('');
  const subtypeTests: { subtype: string; expectedAt: AssetType | null }[] = [
    { subtype: 'Suburban Office', expectedAt: 'Office' },
    { subtype: 'Medical Office Building', expectedAt: 'Office' },
    { subtype: 'Garden Multifamily', expectedAt: 'Multifamily' },
    { subtype: 'Student Housing', expectedAt: 'Multifamily' },
    { subtype: 'Full Service Hotel', expectedAt: 'Hotel' },
    { subtype: 'Boutique Hotel', expectedAt: 'Hotel' },
    { subtype: 'Warehouse Industrial', expectedAt: 'Industrial' },
    { subtype: 'Distribution', expectedAt: 'Industrial' },
    { subtype: 'Self Storage', expectedAt: 'SelfStorage' },
    { subtype: 'Manufactured Housing', expectedAt: 'MHC' },
    { subtype: 'MHC Portfolio', expectedAt: 'MHC' },
    { subtype: 'Mixed Use', expectedAt: 'MixedUse' },
    { subtype: 'Anchored Retail', expectedAt: 'Retail' },
    { subtype: 'Regional Mall', expectedAt: 'Retail' },
    { subtype: 'Premium Outlets', expectedAt: 'Retail' },
    { subtype: 'Galleria', expectedAt: 'Retail' },
    { subtype: 'Strip Center', expectedAt: 'Retail' },
    { subtype: 'unrecognizable garbage', expectedAt: null },
  ];
  for (const t of subtypeTests) {
    const pm = mkPropertyMetadata({ propertySubtype: t.subtype });
    const out2 = adaptExtractionToDealBag(mkExtraction({}), pm);
    out.push(`  "${t.subtype.padEnd(25)}" → assetType=${out2.assetType}  (expected ${t.expectedAt})`);
    assertEq(out2.assetType, t.expectedAt, `subtype heuristic "${t.subtype}"`);
  }
  out.push('');

  /* ============= (5) END-TO-END through evaluateDeal ============= */
  out.push('================================================================');
  out.push('(5) END-TO-END — adapter → evaluateDeal');
  out.push('================================================================');
  out.push('');
  const result = evaluateDeal(bag);
  out.push(`  RATING: ${result.rating.recommendation}  band=${result.rating.band ?? 'null'}  ratedRisk=${result.rating.ratedRisk?.toFixed(3) ?? 'null'}`);
  out.push(`  normalization: ${result.normalization.routeStatus}  sustainableNcf=${result.normalization.sustainableNcf?.toFixed(0)}`);
  out.push(`  dim 7 (cap-rate): ${result.dimensions.capRateValuationStress.applicability}  tier=${result.dimensions.capRateValuationStress.tier}`);
  out.push(`  dim 8 (asset-class): ${result.dimensions.assetClass.applicability}  tier=${result.dimensions.assetClass.tier}`);
  out.push(`  dim 5 (concentration): ${result.dimensions.incomeConcentration.applicability}  tier=${result.dimensions.incomeConcentration.tier}`);
  out.push(`  dim 6 (rollover): ${result.dimensions.rollover.applicability}  tier=${result.dimensions.rollover.tier}`);
  out.push('');
  assert(result.rating.recommendation !== 'InsufficientData', 'end-to-end: rating resolves (not InsufficientData)');
  assert(result.rating.ratedRisk !== null, 'end-to-end: ratedRisk non-null');
  assert(result.normalization.routeStatus === 'applicable', 'end-to-end: normalization resolves');
  assert(result.dimensions.capRateValuationStress.applicability === 'applicable', 'end-to-end: dim 7 resolves');

  /* ============= (6) EMPTY EXTRACTION → HITL routing ============= */
  out.push('================================================================');
  out.push('(6) EMPTY EXTRACTION → expected HITL routing');
  out.push('================================================================');
  out.push('');
  const emptyBag = adaptExtractionToDealBag(mkExtraction({}), null);
  out.push(`  Empty extraction DealBag: all fields null except marketTier='Unknown', largestTenantBasis='base-rent'`);
  assertEq(emptyBag.assetType, null, 'empty: assetType null');
  assertEq(emptyBag.uwY1Noi, null, 'empty: uwY1Noi null');
  assertEq(emptyBag.concludedValue, null, 'empty: concludedValue null');
  assertEq(emptyBag.loanAmount, null, 'empty: loanAmount null');
  assertEq(emptyBag.marketTier, 'Unknown', 'empty: marketTier=Unknown');
  const emptyResult = evaluateDeal(emptyBag);
  out.push(`  RATING on empty: ${emptyResult.rating.recommendation}`);
  assertEq(emptyResult.rating.recommendation, 'InsufficientData', 'empty extraction → InsufficientData');

  /* ============= (7) FENCE AUDIT ============= */
  out.push('================================================================');
  out.push('(7) FENCE AUDIT — adapter imports only ExtractionResult + PropertyMetadata');
  out.push('================================================================');
  out.push('');
  const ADAPTER_PATH = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/adapters/extraction-to-dealbag.ts';
  const adapterSrc = fs.readFileSync(ADAPTER_PATH, 'utf8');
  const importLines = adapterSrc.split('\n').filter(l => /^import /.test(l));
  out.push(`  Imports in adapter:`);
  for (const l of importLines) out.push(`    ${l}`);
  const banned = [
    /AdjustedInputs/, /adjusted.*inputs/i,
    /valuationConclusion/, /finalValue/,
    /metrics\.noi/, /metrics\.dscr/, /metrics\.value/,
    /services\/doctrine\//, /services\/judgment\//, /handbook/,
    /manifesto_rules/, /buildValuationConclusion/, /buildDoctrineEvaluation/,
    /apply.*judgment/i, /apply.*cap.*rate.*stress/i,
  ];
  let fenceViolations = 0;
  for (const line of importLines) {
    for (const rx of banned) {
      if (rx.test(line)) {
        fenceViolations++;
        out.push(`    ⚠ FENCE VIOLATION: "${line}" matches ${rx}`);
      }
    }
  }
  // Also scan source body for any judgment/AdjustedInputs reference
  const bodyMatches: string[] = [];
  for (const rx of [/AdjustedInputs/, /valuationConclusion/, /metrics\.noi/, /metrics\.dscr/, /buildDoctrineEvaluation/]) {
    const m = adapterSrc.match(rx);
    if (m) bodyMatches.push(`${m[0]}`);
  }
  // Filter out matches inside the doc comments (intentional fence-statement text)
  const realBodyMatches: string[] = [];
  for (const term of bodyMatches) {
    // Reread to check if it appears in non-comment line
    const codeLines = adapterSrc.split('\n').filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'));
    const codeText = codeLines.join('\n');
    if (codeText.includes(term)) realBodyMatches.push(term);
  }
  out.push(`  Code-body matches for banned terms (excluding doc comments): ${realBodyMatches.length}  ${realBodyMatches.length === 0 ? '✓' : '⚠'}`);
  out.push(`  Import-line fence violations: ${fenceViolations}  ${fenceViolations === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* ============= SUMMARY ============= */
  out.push('================================================================');
  out.push('SUMMARY');
  out.push('================================================================');
  out.push('');
  out.push(`  Asserts: ${passed} passed / ${failed} failed`);
  if (failures.length > 0) {
    out.push('  Failures:');
    for (const f of failures.slice(0, 20)) out.push(`    ✗ ${f}`);
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean adapter] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
