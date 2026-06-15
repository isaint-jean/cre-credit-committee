/**
 * PR 3 batch 2 — narrative-facts isSingleTenant honesty.
 *
 *   cd apps/api && npx tsx src/scripts/test-rent-roll-pr3-batch2.ts
 *
 * Proves:
 *   - Multifamily fixture (50 unit-kind lines) → isSingleTenant === null
 *     (UNKNOWN — the question is malformed for a residential roll).
 *   - Multifamily flows through deriveTenancyType → undefined (no
 *     "Single-Tenant" or "Multi-Tenant" assertion is made).
 *   - Office tenant fixture → existing behavior preserved exactly.
 *   - Untyped legacy fixture (no `kind` field, simulating pre-PR-2 data)
 *     → existing behavior preserved exactly (back-compat path).
 *   - Empty rent roll → false (the existing "structurally observable" answer).
 *   - Null rent roll → null (UNKNOWN — missing data).
 */
import type {
  ExtractionResult,
  RentRollExtraction,
  TenantUnit,
  ResidentialUnit,
} from '@cre/contracts';
import { buildNarrativeFacts } from '../services/narrative-facts.service.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
function pass(label: string) { console.log(`  ✓ ${label}`); }

const ASOF = '2026-06-14T00:00:00Z' as any;

function mkExtraction(rentRoll: RentRollExtraction | null): ExtractionResult {
  // Minimal ExtractionResult — only rentRoll matters for these assertions.
  // analysisAsOfDate is required by the contract; other slots null.
  return {
    analysisAsOfDate: ASOF,
    dealRef: 'pr3-batch2-fixture',
    extractionEngineVersion: '1.7' as any,
    extractorVersions: {} as any,
    sourceDocuments: [],
    asr: null,
    sellerUw: null,
    sellerUwOperatingStatement: null,
    t12Actual: null,
    inPlace: null,
    pca: null,
    appraisal: null,
    loanTerms: null,
    annexA: null,
    rentRoll,
  } as ExtractionResult;
}

console.log('================================================================');
console.log('PR 3 batch 2 — narrative-facts isSingleTenant honesty');
console.log('================================================================');

/* ----- (1) Multifamily fixture: 50 unit-kind lines, no tenants ---------- */
console.log('\n(1) Multifamily synthetic (50 unit-kind lines)');

const mfUnits: ResidentialUnit[] = Array.from({ length: 50 }, (_, i) => ({
  kind: 'unit',
  unitId: `${100 + i}`,
  isResidential: true,
  bedrooms: 1,
  bathrooms: 1,
  unitType: '1BR/1BA',
  leaseStart: '2026-01-01T00:00:00Z' as any,
  leaseEndOrMTM: null,
  baseRentMonthly: null,
  inPlaceRentMonthly: i < 45 ? 1200 : null,
  occupied: i < 45,
  concessionsMonthly: null,
  securityDeposit: null,
}));

const mfRentRoll: RentRollExtraction = {
  units: mfUnits,
  summary: { totalUnits: 50, occupiedUnits: 45, economicOccupancy: 0.9 },
};

const mfFacts = buildNarrativeFacts({
  extractionResult: mkExtraction(mfRentRoll),
  analysisAsOfDate: ASOF,
});

assert(mfFacts.isSingleTenant === null,
  `multifamily isSingleTenant === null (got ${JSON.stringify(mfFacts.isSingleTenant)})`);
pass('multifamily: isSingleTenant === null — NOT true, NOT false');
pass('multifamily: the "single tenant" question is honestly N/A for a 50-unit residential roll');

/* ----- (2) Downstream check — deriveTenancyType handles null --------- */
// deriveTenancyType is in handbook/assembler.ts (not exported); the consumer
// behavior is: isSingleTenant === true → 'Single-Tenant', === false →
// 'Multi-Tenant', null → undefined (no assertion). Reproduce locally to
// confirm null routes to undefined.
console.log('\n(2) Downstream: deriveTenancyType handles null → undefined');
function deriveTenancyType(isSingleTenant: boolean | null): string | undefined {
  if (isSingleTenant === true) return 'Single-Tenant';
  if (isSingleTenant === false) return 'Multi-Tenant';
  return undefined;
}
const mfTenancy = deriveTenancyType(mfFacts.isSingleTenant);
assert(mfTenancy === undefined,
  `multifamily deriveTenancyType returns undefined (no tenancy assertion) — got '${mfTenancy}'`);
pass('multifamily: tenancy_type is undefined downstream — handbook makes NO tenancy assertion');
pass('multifamily: memo prose downstream will NOT claim "Single-Tenant" for a 50-unit building');

/* ----- (3) Office fixture: 2 tenant-kind lines, multi-tenant ----------- */
console.log('\n(3) Office synthetic (2 tenant-kind lines)');

const offTenants: TenantUnit[] = [
  { kind: 'tenant', unitId: '100', tenantName: 'Acme Corp',
    leaseStart: '2024-01-01T00:00:00Z' as any, leaseEnd: '2029-12-31T00:00:00Z' as any,
    baseRentMonthly: null, inPlaceRentMonthly: 30000, occupied: true,
    concessions: null, securityDeposit: null },
  { kind: 'tenant', unitId: '200', tenantName: 'Beta LLC',
    leaseStart: '2025-06-01T00:00:00Z' as any, leaseEnd: '2030-05-31T00:00:00Z' as any,
    baseRentMonthly: null, inPlaceRentMonthly: 21250, occupied: true,
    concessions: null, securityDeposit: null },
];

const offRentRoll: RentRollExtraction = {
  units: offTenants,
  summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
};

const offFacts = buildNarrativeFacts({
  extractionResult: mkExtraction(offRentRoll),
  analysisAsOfDate: ASOF,
});

assert(offFacts.isSingleTenant === false,
  `office (2 distinct tenants) isSingleTenant === false (got ${JSON.stringify(offFacts.isSingleTenant)})`);
pass('office: isSingleTenant === false (2 distinct tenant names)');
const offTenancy = deriveTenancyType(offFacts.isSingleTenant);
assert(offTenancy === 'Multi-Tenant', `office tenancy_type === 'Multi-Tenant' (got '${offTenancy}')`);
pass('office: tenancy_type === "Multi-Tenant" downstream — existing behavior preserved');

/* ----- (4) Single-tenant office: 1 distinct tenant --------------------- */
console.log('\n(4) Single-tenant office (1 tenant name across multiple suites)');

const singleTenantOff: TenantUnit[] = [
  { kind: 'tenant', unitId: '100', tenantName: 'Megacorp',
    leaseStart: '2024-01-01T00:00:00Z' as any, leaseEnd: '2034-12-31T00:00:00Z' as any,
    baseRentMonthly: null, inPlaceRentMonthly: 50000, occupied: true,
    concessions: null, securityDeposit: null },
  { kind: 'tenant', unitId: '200', tenantName: 'Megacorp',
    leaseStart: '2024-01-01T00:00:00Z' as any, leaseEnd: '2034-12-31T00:00:00Z' as any,
    baseRentMonthly: null, inPlaceRentMonthly: 25000, occupied: true,
    concessions: null, securityDeposit: null },
];

const stFacts = buildNarrativeFacts({
  extractionResult: mkExtraction({
    units: singleTenantOff,
    summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
  }),
  analysisAsOfDate: ASOF,
});
assert(stFacts.isSingleTenant === true, `single-tenant: isSingleTenant === true (got ${stFacts.isSingleTenant})`);
pass('single-tenant office: isSingleTenant === true');

/* ----- (5) Untyped legacy fixture (no kind field) --------------------- */
console.log('\n(5) Back-compat: untyped legacy fixture (no kind field)');

// Simulates persisted pre-PR-2 data: tenantName + no kind field.
const legacyUntyped = {
  units: [
    { tenantName: 'Legacy Tenant A', inPlaceRentMonthly: 10000 },
    { tenantName: 'Legacy Tenant B', inPlaceRentMonthly: 12000 },
  ],
  summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
} as unknown as RentRollExtraction;

const legacyFacts = buildNarrativeFacts({
  extractionResult: mkExtraction(legacyUntyped),
  analysisAsOfDate: ASOF,
});
assert(legacyFacts.isSingleTenant === false,
  `legacy untyped (2 distinct names, no kind field): isSingleTenant === false (got ${legacyFacts.isSingleTenant})`);
pass('legacy untyped data: existing behavior preserved (back-compat path takes tenant branch)');

/* ----- (6) Edge cases -------------------------------------------------- */
console.log('\n(6) Edge cases');

const emptyFacts = buildNarrativeFacts({
  extractionResult: mkExtraction({ units: [], summary: { totalUnits: 0, occupiedUnits: 0, economicOccupancy: null } }),
  analysisAsOfDate: ASOF,
});
assert(emptyFacts.isSingleTenant === false, 'empty rent roll: isSingleTenant === false (structurally observable)');
pass('empty rent roll: isSingleTenant === false (existing semantic preserved)');

const nullFacts = buildNarrativeFacts({
  extractionResult: mkExtraction(null),
  analysisAsOfDate: ASOF,
});
assert(nullFacts.isSingleTenant === null, 'null rent roll: isSingleTenant === null (UNKNOWN)');
pass('null rent roll: isSingleTenant === null (existing semantic preserved)');

console.log('\n================================================================');
console.log('✓ PR 3 BATCH 2 — narrative-facts honesty proven');
console.log('================================================================');
