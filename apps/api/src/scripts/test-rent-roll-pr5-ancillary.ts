/**
 * PR A — isResidential ancillary-row filter (EE 1.8) — double-count guard.
 *
 *   cd apps/api && npx tsx src/scripts/test-rent-roll-pr5-ancillary.ts
 *
 * The whole point of PR A: a parking line (isResidential:false, rent
 * $75/mo) must NOT contribute to GPR. The operating statement's
 * `otherIncome` line ALREADY carries parking and storage rents — counting
 * them again on the rent-roll side would double-count against EGI.
 *
 * This test proves the filter is load-bearing — a tag without a filter
 * does nothing.
 */
import type {
  ExtractionResult,
  RentRollExtraction,
  ResidentialUnit,
  OperatingStatementExtraction,
} from '@cre/contracts';
import { projectToRentRollExtraction } from '../services/extraction/adapters/rent-roll.adapter.js';
import { buildGrossRentalIncome } from '../services/judgment/line-item-builders.js';
import type { RentRoll, UnitRentRollLine } from '@cre/contracts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`✗ FAIL: ${msg}`); process.exit(1); }
}
function pass(label: string) { console.log(`  ✓ ${label}`); }

const ASOF = '2026-06-14T00:00:00Z' as any;

console.log('================================================================');
console.log('PR A — isResidential filter: GPR double-count guard');
console.log('================================================================');

/* ===== (1) THE DOUBLE-COUNT GUARD — load-bearing test ===== */
console.log('\n(1) DOUBLE-COUNT GUARD: parking $75/mo must NOT contribute to GPR');

const mixedLines: UnitRentRollLine[] = [
  // 2 residential units
  { kind: 'unit', unitId: '101', isResidential: true,  status: 'OCCUPIED',
    squareFeet: 750, bedrooms: 1, bathrooms: 1, unitType: '1BR/1BA',
    leaseStart: '2026-01-01T00:00:00Z' as any, leaseEndOrMTM: '2027-01-01T00:00:00Z' as any,
    inPlaceRentMonthly: 1200, marketRentMonthly: 1250,
    concessionsMonthly: null, securityDeposit: 1200, notes: null },
  { kind: 'unit', unitId: '102', isResidential: true,  status: 'OCCUPIED',
    squareFeet: 950, bedrooms: 2, bathrooms: 1, unitType: '2BR/1BA',
    leaseStart: '2026-01-01T00:00:00Z' as any, leaseEndOrMTM: '2027-01-01T00:00:00Z' as any,
    inPlaceRentMonthly: 1500, marketRentMonthly: 1550,
    concessionsMonthly: null, securityDeposit: 1500, notes: null },
  // 1 ancillary parking line — MUST be excluded from GPR
  { kind: 'unit', unitId: 'P-15', isResidential: false, status: 'OCCUPIED',
    squareFeet: null, bedrooms: null, bathrooms: null, unitType: 'Parking',
    leaseStart: null, leaseEndOrMTM: null,
    inPlaceRentMonthly: 75, marketRentMonthly: 100,
    concessionsMonthly: null, securityDeposit: null, notes: 'parking spot' },
];

const mixedRentRoll: RentRoll = {
  id: 'rr-mixed-ancillary' as any,
  asOfDate: ASOF, propertyName: 'Mixed Ancillary',
  source: 'rent_roll_file', lines: mixedLines,
};

// Project to the new-spine ExtractionResult.rentRoll shape.
const proj: RentRollExtraction = projectToRentRollExtraction(mixedRentRoll);

// Direct check: the projector's summary counts RESIDENTIAL only.
assert(proj.summary.totalUnits === 2,
  `summary.totalUnits === 2 (residential-only; got ${proj.summary.totalUnits})`);
assert(proj.summary.occupiedUnits === 2,
  `summary.occupiedUnits === 2 (got ${proj.summary.occupiedUnits})`);
pass('summary.totalUnits counts residential ONLY (parking excluded)');

// Project all units carry their isResidential through.
const parking = proj.units.find(u => u.kind === 'unit' && (u as ResidentialUnit).unitId === 'P-15') as ResidentialUnit;
assert(parking !== undefined, 'parking line preserved on the projection (audit fidelity)');
assert(parking.isResidential === false,
  `parking line isResidential === false on projection (got ${parking.isResidential})`);
pass('parking line PRESERVED on projection with isResidential:false (audit fidelity)');

// GPR via buildGrossRentalIncome — feed through an ExtractionResult.
const sellerUw: OperatingStatementExtraction = {
  period: 'Year 1', income: { grossPotentialRent: null, effectiveRent: null, otherIncome: 24_000, totalIncome: null },
  expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null,
    generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: null },
  noi: null, vacancyLoss: null,
  belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
};

const extraction: ExtractionResult = {
  id: 'ext-mixed' as any,
  analysisAsOfDate: ASOF,
  dealRef: 'ANCILLARY-TEST',
  extractionEngineVersion: '1.8' as any,
  extractorVersions: {} as any,
  sourceDocuments: [],
  asr: null, sellerUw, sellerUwOperatingStatement: sellerUw, t12Actual: null,
  inPlace: null, pca: null, appraisal: null, loanTerms: null, annexA: null,
  rentRoll: proj,
} as ExtractionResult;

// Call buildGrossRentalIncome — the load-bearing consumer.
const gprResult = buildGrossRentalIncome({ extraction } as any);
const expectedResidentialGpr = (1200 + 1500) * 12;  // = $32,400
const expectedWithParking = expectedResidentialGpr + 75 * 12;  // = $33,300 — WRONG
console.log(`  buildGrossRentalIncome.adjusted = ${gprResult.adjusted}`);
console.log(`  expected residential-only        = ${expectedResidentialGpr}`);
console.log(`  expected if parking leaked       = ${expectedWithParking} (double-count failure)`);
assert(gprResult.adjusted === expectedResidentialGpr,
  `★ GPR === residential-only $32,400 (got $${gprResult.adjusted}) — parking $75/mo MUST be excluded`);
pass('★ DOUBLE-COUNT GUARD: parking ($75/mo = $900/yr) EXCLUDED from GPR');
pass('   Operating statement otherIncome ($24,000) carries parking separately — NO double-count');

/* ===== (2) Vacant storage doesn't drag down multifamily occupancy ===== */
console.log('\n(2) Vacant storage MUST NOT drag down multifamily economic occupancy');

const mfWithStorage: UnitRentRollLine[] = [
  { kind: 'unit', unitId: '101', isResidential: true, status: 'OCCUPIED',
    squareFeet: 750, bedrooms: 1, bathrooms: 1, unitType: '1BR/1BA',
    leaseStart: null, leaseEndOrMTM: null,
    inPlaceRentMonthly: 1200, marketRentMonthly: 1250,
    concessionsMonthly: null, securityDeposit: null, notes: null },
  { kind: 'unit', unitId: '102', isResidential: true, status: 'OCCUPIED',
    squareFeet: 750, bedrooms: 1, bathrooms: 1, unitType: '1BR/1BA',
    leaseStart: null, leaseEndOrMTM: null,
    inPlaceRentMonthly: 1200, marketRentMonthly: 1250,
    concessionsMonthly: null, securityDeposit: null, notes: null },
  // VACANT storage locker — would drag occupancy from 100% → 67% if counted
  { kind: 'unit', unitId: 'S-08', isResidential: false, status: 'VACANT',
    squareFeet: null, bedrooms: null, bathrooms: null, unitType: 'Storage',
    leaseStart: null, leaseEndOrMTM: null,
    inPlaceRentMonthly: null, marketRentMonthly: 50,
    concessionsMonthly: null, securityDeposit: null, notes: null },
];
const mfWithStorageRoll: RentRoll = {
  id: 'rr-mf-storage' as any, asOfDate: ASOF, propertyName: 'MF + storage',
  source: 'rent_roll_file', lines: mfWithStorage,
};
const projStorage = projectToRentRollExtraction(mfWithStorageRoll);
assert(projStorage.summary.totalUnits === 2, `totalUnits residential-only (got ${projStorage.summary.totalUnits})`);
assert(projStorage.summary.occupiedUnits === 2, `occupiedUnits residential-only (got ${projStorage.summary.occupiedUnits})`);
assert(projStorage.summary.economicOccupancy === 1.0,
  `economic occupancy 100% on 2/2 residential (got ${projStorage.summary.economicOccupancy})`);
pass('vacant storage does NOT drag multifamily occupancy below 100%');

/* ===== (3) Back-compat: untyped legacy data → defaults residential ===== */
console.log('\n(3) BACK-COMPAT: untyped legacy unit (no isResidential field) → INCLUDED');

// Synthetic pre-EE-1.8 data (no isResidential field, as any).
const legacyExtraction: ExtractionResult = {
  ...extraction,
  rentRoll: {
    units: [
      // No isResidential / no kind — pure legacy shape.
      { unitId: '201', inPlaceRentMonthly: 1000 },
      { unitId: '202', inPlaceRentMonthly: 1100 },
    ],
    summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
  } as unknown as RentRollExtraction,
};
const legacyGpr = buildGrossRentalIncome({ extraction: legacyExtraction } as any);
const expectedLegacyGpr = (1000 + 1100) * 12;
assert(legacyGpr.adjusted === expectedLegacyGpr,
  `legacy untyped: GPR = ${expectedLegacyGpr} (got ${legacyGpr.adjusted}) — included as residential by default`);
pass('★ back-compat: untyped legacy units default to RESIDENTIAL (included in GPR)');
pass('   Sunroad / pre-EE-1.8 persisted data continues to count exactly as before');

console.log('\n================================================================');
console.log('✓ PR A — isResidential filter tests pass');
console.log('================================================================');
