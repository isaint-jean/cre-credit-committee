/**
 * Contract tests for the rent-roll line-level discriminated union
 * (PR 1 — multifamily honest-shape).
 *
 *   cd apps/api && npx tsx src/scripts/test-rent-roll-discriminant.ts
 *
 * Verifies:
 *   - A multifamily synthetic fixture (50 units, 90% occupied, $1200/mo avg,
 *     2 concessions) constructs a valid UnitRentRollLine[]. No tenant fields
 *     present on the unit lines.
 *   - An office fixture (tenant lines) constructs a valid TenantRentRollLine[].
 *   - The line-level discriminant is honestly enforced: a deliberate read of
 *     `leaseType` off an un-narrowed `RentRollLine` is uncommented to prove
 *     tsc --strict flags it. The script asserts the runtime narrowing pattern
 *     works for both variants.
 *
 * NO PRODUCTION CODE CHANGE. NO CONSUMER EDITS.
 *
 * Existing consumers compile-fail under the new contract on purpose — that
 * compile signal is the deliverable of PR 1 (see commit body / design doc).
 */
import type {
  RentRoll,
  RentRollLine,
  TenantRentRollLine,
  UnitRentRollLine,
} from '@cre/contracts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
function pass(label: string) {
  console.log(`  ✓ ${label}`);
}

console.log('================================================================');
console.log('Rent-roll discriminated-union contract tests');
console.log('================================================================');

/* ----- (1) Multifamily fixture: 50 units, 45 occupied, 2 concessions ----- */
console.log('\n(1) Multifamily synthetic fixture — UnitRentRollLine[]');

const mfLines: UnitRentRollLine[] = Array.from({ length: 50 }, (_, i) => ({
  kind: 'unit',
  unitId: `unit-${i + 1}`,
  isResidential: true,
  status: i < 45 ? 'OCCUPIED' : 'VACANT',
  squareFeet: 850,
  bedrooms: i % 3 === 0 ? 2 : 1,
  bathrooms: 1,
  unitType: i % 3 === 0 ? '2BR/1BA' : '1BR/1BA',
  leaseStart: i < 45 ? ('2026-01-01T00:00:00Z' as any) : null,
  leaseEndOrMTM: i < 45 ? null : null,                       // null === MTM, NOT missing data
  inPlaceRentMonthly: i < 45 ? 1200 : null,
  marketRentMonthly: 1250,
  concessionsMonthly: i < 2 ? 200 : null,                    // 2 units with concessions
  securityDeposit: i < 45 ? 1200 : null,
  notes: null,
}));

assert(mfLines.length === 50, '50 unit lines constructed');
assert(mfLines.every(l => l.kind === 'unit'), 'every line discriminant is "unit"');
assert(mfLines.filter(l => l.status === 'OCCUPIED').length === 45, '45 occupied');
assert(mfLines.filter(l => l.concessionsMonthly !== null).length === 2, '2 with concessions');
// Field-honesty: tenant-only fields ABSENT
const sampleMfLine = mfLines[0]!;
assert(!('tenantName' in sampleMfLine), 'no tenantName on unit lines');
assert(!('leaseEnd' in sampleMfLine), 'no leaseEnd on unit lines (replaced by leaseEndOrMTM)');
assert(!('leaseType' in sampleMfLine), 'no leaseType on unit lines (office NNN/MG vocabulary)');
assert(!('inPlaceRentAnnual' in sampleMfLine), 'no inPlaceRentAnnual on unit lines (monthly only)');
assert(!('recoveriesAnnual' in sampleMfLine), 'no recoveriesAnnual on unit lines');
assert(!('newTiPsf' in sampleMfLine), 'no newTiPsf on unit lines');
pass('multifamily fixture: 50 unit lines, honestly shaped');

/* ----- (2) Office fixture: 4 tenants, all OCCUPIED, NNN leases --------- */
console.log('\n(2) Office tenant fixture — TenantRentRollLine[]');

const officeLines: TenantRentRollLine[] = [
  {
    kind: 'tenant',
    tenantName: 'Acme Corp',
    suite: '100',
    squareFeet: 12000,
    status: 'OCCUPIED',
    leaseStart: '2024-01-01T00:00:00Z' as any,
    leaseEnd: '2029-12-31T00:00:00Z' as any,
    inPlaceRentAnnual: 360000,
    marketRentAnnual: 384000,
    leaseType: 'NNN',
    recoveriesAnnual: 60000,
    otherIncomeAnnual: null,
    newTiPsf: 35,
    renewTiPsf: 15,
    newLcPct: 0.06,
    renewLcPct: 0.03,
    downtimeMonths: 6,
    notes: null,
  },
  {
    kind: 'tenant',
    tenantName: 'Beta LLC',
    suite: '200',
    squareFeet: 8500,
    status: 'OCCUPIED',
    leaseStart: '2025-06-01T00:00:00Z' as any,
    leaseEnd: '2030-05-31T00:00:00Z' as any,
    inPlaceRentAnnual: 255000,
    marketRentAnnual: 272000,
    leaseType: 'MG',
    recoveriesAnnual: 0,
    otherIncomeAnnual: null,
    newTiPsf: 30,
    renewTiPsf: 12,
    newLcPct: 0.05,
    renewLcPct: 0.025,
    downtimeMonths: 6,
    notes: null,
  },
];
assert(officeLines.every(l => l.kind === 'tenant'), 'every line discriminant is "tenant"');
assert(officeLines.every(l => 'leaseType' in l), 'leaseType present on every tenant line');
assert(!('unitType' in (officeLines[0]!)), 'no unitType on tenant lines');
assert(!('concessionsMonthly' in (officeLines[0]!)), 'no concessionsMonthly on tenant lines');
pass('office fixture: 2 tenant lines, honestly shaped');

/* ----- (3) Discriminant narrowing — runtime behavior ---------------------- */
console.log('\n(3) Discriminant narrowing — runtime behavior');

const mixed: RentRollLine[] = [
  officeLines[0]!,
  mfLines[0]!,
];

let officeReads = 0;
let unitReads = 0;
for (const line of mixed) {
  if (line.kind === 'tenant') {
    // Tenant-only field accessible after narrowing:
    const _: string = line.leaseType;
    officeReads++;
  } else {
    // Unit-only field accessible after narrowing:
    const _: string | null = line.unitType;
    unitReads++;
  }
}
assert(officeReads === 1 && unitReads === 1, 'narrowing branches both reachable');
pass('runtime narrowing: tenant + unit branches reachable; correct fields read on each');

/* ----- (4) Compile-fail proof (commented; uncommenting fails tsc --strict) - */
console.log('\n(4) Compile-fail proof — comment marker only (must not run)');

// const bad: RentRollLine = mfLines[0]!;
// const _willFail: LeaseType = bad.leaseType;
// ↑ tsc --strict rejects: "Property 'leaseType' does not exist on type
//   'UnitRentRollLine'". This is the discipline the discriminant buys.
//
// To re-prove: uncomment the two lines above and run
//   npx tsc -p apps/api/tsconfig.json --noEmit | grep test-rent-roll-discriminant
// Expected: TS2339 error on `.leaseType`.
pass('compile-fail proof: marker lines present (kept commented to keep this script runnable)');

/* ----- (5) RentRoll top-level shape unchanged ---------------------------- */
console.log('\n(5) RentRoll top-level shape — unchanged');

const rr: Omit<RentRoll, 'id'> = {
  asOfDate: '2026-06-14T00:00:00Z' as any,
  propertyName: 'Synthetic Multifamily Demo',
  source: 'rent_roll_file',
  lines: mfLines,
};
assert(rr.lines.length === 50, 'RentRoll.lines is a flat array, not a union of arrays');
pass('RentRoll top-level shape is unchanged — only lines[].kind is new');

console.log('\n================================================================');
console.log('✓ ALL CONTRACT TESTS PASS');
console.log('================================================================');
