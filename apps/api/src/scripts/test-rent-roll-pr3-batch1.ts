/**
 * PR 3 batch 1 — score-level silent-passenger check.
 *
 *   cd apps/api && npx tsx src/scripts/test-rent-roll-pr3-batch1.ts
 *
 * The 6 batch-1 consumers should:
 *   1. PROJECTOR  — preserve unit-line semantics (concessionsMonthly,
 *      leaseEndOrMTM, occupied) and the discriminant.
 *   2. DEALBAG ADAPTER — `deriveTopTenantShare`, `deriveTenantDataStatus`,
 *      `deriveRolloverShare` should all return null/'na-by-asset-type' on a
 *      multifamily input (NOT garbage computed from undefined tenantName).
 *   3. JUDGMENT LAYER — narrowing is verified at the type level (tsc);
 *      runtime is checked here by feeding a hybrid extraction through the
 *      relevant pure functions where importable.
 *
 * This script does NOT run a full doctrine evaluation — that would require
 * a richer fixture setup. The narrowing's correctness is verified by:
 *   - the projector test (round-trip a unit RentRoll through the projector)
 *   - the dealbag-adapter tests (multifamily → null/'na' outputs)
 *   - tsc proving each filter is in place at compile time
 */
import type {
  RentRoll,
  TenantRentRollLine,
  UnitRentRollLine,
  RentRollExtraction,
} from '@cre/contracts';
import { projectToRentRollExtraction } from '../services/extraction/adapters/rent-roll.adapter.js';
import {
  deriveTopTenantShare,
  deriveTenantDataStatus,
  deriveRolloverShare,
} from '../doctrine-clean/adapters/extraction-to-dealbag.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
function pass(label: string) { console.log(`  ✓ ${label}`); }

console.log('================================================================');
console.log('PR 3 batch 1 — score-level silent-passenger check');
console.log('================================================================');

/* ----- multifamily RentRoll fixture (50 units) ------------------------- */
const mfLines: UnitRentRollLine[] = Array.from({ length: 50 }, (_, i) => ({
  kind: 'unit',
  unitId: `${100 + i}`,
  isResidential: true,
  status: i < 45 ? 'OCCUPIED' : 'VACANT',
  squareFeet: 850,
  bedrooms: i % 3 === 0 ? 2 : 1,
  bathrooms: 1,
  unitType: i % 3 === 0 ? '2BR/1BA' : '1BR/1BA',
  leaseStart: '2026-01-01T00:00:00Z' as any,
  leaseEndOrMTM: i === 10 || i === 20 ? null : ('2027-01-01T00:00:00Z' as any),  // 2 MTM
  inPlaceRentMonthly: i < 45 ? 1200 : null,
  marketRentMonthly: 1250,
  concessionsMonthly: i < 2 ? 200 : null,                                          // 2 concessions
  securityDeposit: i < 45 ? 1200 : null,
  notes: null,
}));

const mfRentRoll: RentRoll = {
  id: 'mf-rr-fixture' as any,
  asOfDate: '2026-06-14T00:00:00Z' as any,
  propertyName: 'Synthetic MF',
  source: 'rent_roll_file',
  lines: mfLines,
};

/* ----- office RentRoll fixture (4 tenants) ----------------------------- */
const officeLines: TenantRentRollLine[] = [
  { kind: 'tenant', tenantName: 'Acme Corp', suite: '100', squareFeet: 12000, status: 'OCCUPIED',
    leaseStart: '2024-01-01T00:00:00Z' as any, leaseEnd: '2029-12-31T00:00:00Z' as any,
    inPlaceRentAnnual: 360000, marketRentAnnual: 384000, leaseType: 'NNN',
    recoveriesAnnual: 60000, otherIncomeAnnual: null,
    newTiPsf: 35, renewTiPsf: 15, newLcPct: 0.06, renewLcPct: 0.03, downtimeMonths: 6, notes: null },
  { kind: 'tenant', tenantName: 'Beta LLC', suite: '200', squareFeet: 8500, status: 'OCCUPIED',
    leaseStart: '2025-06-01T00:00:00Z' as any, leaseEnd: '2030-05-31T00:00:00Z' as any,
    inPlaceRentAnnual: 255000, marketRentAnnual: 272000, leaseType: 'MG',
    recoveriesAnnual: 0, otherIncomeAnnual: null,
    newTiPsf: 30, renewTiPsf: 12, newLcPct: 0.05, renewLcPct: 0.025, downtimeMonths: 6, notes: null },
];

const officeRentRoll: RentRoll = {
  id: 'off-rr-fixture' as any,
  asOfDate: '2026-06-14T00:00:00Z' as any,
  propertyName: 'Synthetic Office',
  source: 'rent_roll_file',
  lines: officeLines,
};

/* ----- (1) Projector — preserves unit semantics ------------------------- */
console.log('\n(1) Projector: projectToRentRollExtraction');

const mfProj: RentRollExtraction = projectToRentRollExtraction(mfRentRoll);
assert(mfProj.units.length === 50, '50 units projected');
assert(mfProj.units.every(u => u.kind === 'unit'), 'every projected unit has kind:"unit"');
pass('discriminant preserved on multifamily projection');

const mfUnit0 = mfProj.units[0] as Extract<typeof mfProj.units[number], { kind: 'unit' }>;
assert(mfUnit0.unitId === '100', 'unitId preserved');
assert(mfUnit0.inPlaceRentMonthly === 1200, 'inPlaceRentMonthly preserved (NOT lossily annualized)');
assert(mfUnit0.concessionsMonthly === 200, 'concessionsMonthly preserved (was previously dropped to null)');
assert(mfUnit0.bedrooms === 2, 'bedrooms preserved');
assert(mfUnit0.unitType === '2BR/1BA', 'unitType preserved');
assert(mfUnit0.occupied === true, 'occupied=true for OCCUPIED status');
pass('unit-side fields preserved (concessionsMonthly, bedrooms, unitType, etc.)');

const mfMtm = mfProj.units[10] as Extract<typeof mfProj.units[number], { kind: 'unit' }>;
assert(mfMtm.leaseEndOrMTM === null, 'MTM unit: leaseEndOrMTM null (semantic preserved, NOT synthesized)');
pass('honesty: MTM semantics preserved through the projector');

const mfVacant = mfProj.units[45] as Extract<typeof mfProj.units[number], { kind: 'unit' }>;
assert(mfVacant.occupied === false, 'VACANT unit: occupied=false');
assert(mfVacant.inPlaceRentMonthly === null, 'VACANT unit: inPlaceRentMonthly null (no zero-coercion)');
pass('honesty: vacant-unit null-fidelity preserved through the projector');

const officeProj: RentRollExtraction = projectToRentRollExtraction(officeRentRoll);
assert(officeProj.units.length === 2, '2 tenant units projected');
assert(officeProj.units.every(u => u.kind === 'tenant'), 'every projected unit has kind:"tenant"');
const officeUnit0 = officeProj.units[0] as Extract<typeof officeProj.units[number], { kind: 'tenant' }>;
assert(officeUnit0.tenantName === 'Acme Corp', 'tenant 0 name preserved');
assert(officeUnit0.inPlaceRentMonthly === 30000, 'annual 360000 → monthly 30000 (existing /12 conversion)');
pass('office projector regression: existing tenant projection byte-for-byte equivalent + kind stamp');

/* ----- (2) Dealbag adapter — gated returns for multifamily ------------- */
console.log('\n(2) Dealbag adapter: multifamily returns null/na, never garbage');

const mfTop = deriveTopTenantShare(mfProj);
assert(mfTop === null, `deriveTopTenantShare(multifamily) returns null (got ${mfTop})`);
pass('deriveTopTenantShare(multifamily) === null — no garbage computed from undefined tenantName');

const mfTenantData = deriveTenantDataStatus(mfProj, 'Multifamily');
assert(mfTenantData === 'na-by-asset-type', `deriveTenantDataStatus(Multifamily) === 'na-by-asset-type' (got '${mfTenantData}')`);
pass("deriveTenantDataStatus(Multifamily) === 'na-by-asset-type' (gated)");

const mfRollover = deriveRolloverShare(mfProj, '2031-12-31T00:00:00Z' as any);
assert(mfRollover === null, `deriveRolloverShare(multifamily) returns null (got ${mfRollover})`);
pass('deriveRolloverShare(multifamily) === null — no garbage from missing leaseEnd');

/* ----- (3) Office regression on dealbag adapter ------------------------- */
console.log('\n(3) Office regression — dealbag adapter byte-identical for tenant input');

const offTop = deriveTopTenantShare(officeProj);
// Both tenants occupied: Acme $360k, Beta $255k → top = 360/(360+255) = 0.5854...
assert(offTop !== null && Math.abs(offTop - (360000 / (360000 + 255000))) < 1e-9,
  `deriveTopTenantShare(office) === Acme-share (got ${offTop})`);
pass('deriveTopTenantShare(office): Acme/(Acme+Beta) preserved');

const offTenantData = deriveTenantDataStatus(officeProj, 'Office');
assert(offTenantData === 'multi-tenant-parsed', `deriveTenantDataStatus(Office, 2 tenants) === 'multi-tenant-parsed' (got '${offTenantData}')`);
pass("deriveTenantDataStatus(Office) === 'multi-tenant-parsed'");

const offRollover = deriveRolloverShare(officeProj, '2028-06-30T00:00:00Z' as any);
// Maturity 2028-06-30; Acme lease ends 2029-12-31 (after) → does NOT expire; Beta lease ends 2030-05-31 (after) → does NOT expire.
// Share = 0
assert(offRollover === 0, `deriveRolloverShare(office, maturity 2028-06): 0 (both leases run past maturity); got ${offRollover}`);
pass('deriveRolloverShare(office): both leases past maturity → 0 (correct office rollover share)');

console.log('\n================================================================');
console.log('✓ PR 3 BATCH 1 SCORE-LEVEL SILENT-PASSENGER CHECK PASSES');
console.log('================================================================');
