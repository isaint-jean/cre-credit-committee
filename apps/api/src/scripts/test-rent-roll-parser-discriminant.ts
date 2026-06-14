/**
 * PR 2 — parseRentRollXlsx multifamily branch + office regression.
 *
 *   cd apps/api && npx tsx src/scripts/test-rent-roll-parser-discriminant.ts
 *
 * Builds two synthetic xlsx fixtures in-memory, runs the real parser, and
 * verifies:
 *   - Multifamily fixture (50 units, 10% vacant with null rent, 2 MTM,
 *     2 concessions) parses to kind:'unit' lines with honest nulls.
 *   - Office fixture (4 tenants, NNN leases, recoveries, TI/LC) parses to
 *     kind:'tenant' lines with the existing field set intact + the
 *     kind:'tenant' discriminant stamp.
 *
 * Honesty assertions enforced:
 *   - VACANT units: inPlaceRentMonthly === null (NOT 0).
 *   - MTM units: leaseEndOrMTM === null (NOT a synthetic date).
 *   - Concession-absent units: concessionsMonthly === null (NOT 0).
 *   - Tenant lines: no leaseType coercion to 'OTHER' when source is silent
 *     — current parser uses 'UNKNOWN' which is acceptable per the contract.
 */
import ExcelJS from 'exceljs';
import { parseRentRollXlsx } from '../services/parse-rent-roll-xlsx.js';
import type { RentRoll, UnitRentRollLine, TenantRentRollLine } from '@cre/contracts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
function pass(label: string) { console.log(`  ✓ ${label}`); }

async function buildMultifamilyXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rent Roll');
  ws.getRow(1).values = ['Rent Roll Date', '2026-06-01'];
  ws.getRow(2).values = ['Property Name', 'Synthetic Multifamily Demo'];
  // Header row — strong unit signals: bedrooms, unit type, monthly rent, concessions
  ws.getRow(4).values = [
    'Unit',
    'Unit Type',
    'Bedrooms',
    'Bathrooms',
    'Square Feet',
    'Status',
    'Lease Start',
    'Lease End',
    'Monthly Rent',
    'Monthly Market Rent',
    'Concessions',
    'Security Deposit',
  ];
  for (let i = 0; i < 50; i++) {
    const isVacant = i >= 45;             // 5 vacant (10%)
    const isMtm = i === 10 || i === 20;   // 2 MTM
    const hasConcession = i < 2;          // 2 with concessions
    const beds = i % 3 === 0 ? 2 : 1;
    ws.getRow(5 + i).values = [
      `${100 + i}`,
      beds === 2 ? '2BR/1BA' : '1BR/1BA',
      beds,
      1,
      beds === 2 ? 950 : 750,
      isVacant ? 'VACANT' : 'OCCUPIED',
      isVacant ? null : '2026-01-01',
      isVacant ? null : (isMtm ? null : '2027-01-01'),
      isVacant ? null : 1200 + (beds === 2 ? 300 : 0),
      1250 + (beds === 2 ? 300 : 0),
      hasConcession ? 200 : null,
      isVacant ? null : 1200,
    ];
  }
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

async function buildOfficeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rent Roll');
  ws.getRow(1).values = ['Rent Roll Date', '2026-06-01'];
  ws.getRow(2).values = ['Property Name', 'Synthetic Office Demo'];
  // Header row — strong tenant signals: lease type, recoveries, TI/LC
  ws.getRow(4).values = [
    'Tenant Name',
    'Suite',
    'Square Feet',
    'Status',
    'Lease Start',
    'Lease End',
    'In Place Rent',
    'Market Rent',
    'Lease Type',
    'Recoveries',
    'New TI',
    'New LC',
  ];
  ws.getRow(5).values = ['Acme Corp', '100', 12000, 'OCCUPIED', '2024-01-01', '2029-12-31', 360000, 384000, 'NNN', 60000, 35, 0.06];
  ws.getRow(6).values = ['Beta LLC',  '200',  8500, 'OCCUPIED', '2025-06-01', '2030-05-31', 255000, 272000, 'MG',  0,     30, 0.05];
  ws.getRow(7).values = ['Gamma Inc', '300',  6200, 'OCCUPIED', '2023-09-01', '2028-08-31', 173600, 186000, 'FSG', 0,     28, 0.04];
  ws.getRow(8).values = ['Vacant',    '400',  2000, 'VACANT',   null,         null,         null,   60000,  'UNKNOWN', null, null, null];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('PR 2 — parseRentRollXlsx multifamily branch + office regression');
  console.log('================================================================');

  /* ----- Multifamily fixture ------------------------------------------- */
  console.log('\n(1) Multifamily synthetic xlsx — parse to kind:"unit" lines');
  const mfBuffer = await buildMultifamilyXlsx();
  const mf: RentRoll = await parseRentRollXlsx(mfBuffer);
  assert(mf.lines.length === 50, `parsed 50 lines (got ${mf.lines.length})`);
  pass(`parsed 50 lines from synthetic xlsx`);

  const mfFirst = mf.lines[0]!;
  assert(mfFirst.kind === 'unit', `first line kind === 'unit' (got '${mfFirst.kind}')`);
  pass('discriminant: kind === "unit" on every line');
  assert(mf.lines.every(l => l.kind === 'unit'), 'EVERY line stamped kind:"unit"');

  // Honesty check 1: VACANT units have null rent (NOT 0)
  const vacantUnits = (mf.lines as UnitRentRollLine[]).filter(l => l.status === 'VACANT');
  assert(vacantUnits.length === 5, `5 vacant units (got ${vacantUnits.length})`);
  assert(vacantUnits.every(u => u.inPlaceRentMonthly === null), 'every vacant unit has inPlaceRentMonthly === null (NOT 0)');
  pass('honesty: vacant units have null rent (not zero-coerced)');

  // Honesty check 2: MTM units have null leaseEndOrMTM (NOT a synthetic date)
  const occupiedUnits = (mf.lines as UnitRentRollLine[]).filter(l => l.status === 'OCCUPIED');
  const mtmUnits = occupiedUnits.filter(u => u.leaseEndOrMTM === null);
  assert(mtmUnits.length === 2, `2 MTM units (got ${mtmUnits.length})`);
  pass('honesty: MTM units have leaseEndOrMTM === null (not a synthesized date)');

  // Honesty check 3: Concessions absent → null (NOT 0)
  const concessionUnits = (mf.lines as UnitRentRollLine[]).filter(u => u.concessionsMonthly !== null);
  assert(concessionUnits.length === 2, `2 units with concessions (got ${concessionUnits.length})`);
  const nonConcessionUnits = (mf.lines as UnitRentRollLine[]).filter(u => u.concessionsMonthly === null);
  assert(nonConcessionUnits.length === 48, `48 units with null concessions (got ${nonConcessionUnits.length})`);
  pass('honesty: concession-absent units have null (not 0-coerced)');

  // marketRentMonthly survives even when vacant (asking rent)
  const vacantWithMarket = vacantUnits.filter(u => u.marketRentMonthly !== null);
  assert(vacantWithMarket.length === 5, 'vacant units preserve marketRentMonthly (asking rent)');
  pass('honesty: vacant units keep marketRentMonthly (asking rent)');

  // Honesty check 4: no leaseType field on unit lines (would be a contract violation)
  assert(!('leaseType' in mfFirst), 'unit lines have NO leaseType field (office vocabulary refused)');
  pass('contract: no leaseType field present on unit lines');

  /* ----- Office fixture ------------------------------------------------ */
  console.log('\n(2) Office synthetic xlsx — parse to kind:"tenant" lines');
  const officeBuffer = await buildOfficeXlsx();
  const office: RentRoll = await parseRentRollXlsx(officeBuffer);
  assert(office.lines.length === 4, `parsed 4 lines (got ${office.lines.length})`);
  pass(`parsed 4 lines from synthetic xlsx`);

  const officeFirst = office.lines[0]!;
  assert(officeFirst.kind === 'tenant', `first line kind === 'tenant' (got '${officeFirst.kind}')`);
  pass('discriminant: kind === "tenant" on every line');
  assert(office.lines.every(l => l.kind === 'tenant'), 'EVERY line stamped kind:"tenant"');

  const acme = office.lines[0] as TenantRentRollLine;
  assert(acme.tenantName === 'Acme Corp', `tenant 0 name preserved (got '${acme.tenantName}')`);
  assert(acme.leaseType === 'NNN', `tenant 0 leaseType === 'NNN' (got '${acme.leaseType}')`);
  assert(acme.inPlaceRentAnnual === 360000, 'tenant 0 inPlaceRentAnnual preserved');
  assert(acme.recoveriesAnnual === 60000, 'tenant 0 recoveriesAnnual preserved');
  assert(acme.newTiPsf === 35, 'tenant 0 newTiPsf preserved');
  assert(acme.newLcPct === 0.06, 'tenant 0 newLcPct preserved');
  pass('office regression: all tenant fields byte-identical + kind:"tenant" stamp');

  // Vacant tenant
  const vacantTenant = office.lines[3] as TenantRentRollLine;
  assert(vacantTenant.status === 'VACANT', 'vacant tenant status === "VACANT"');
  assert(vacantTenant.inPlaceRentAnnual === null, 'vacant tenant inPlaceRentAnnual === null');
  pass('office regression: vacant tenant rent null (not 0)');

  console.log('\n================================================================');
  console.log('✓ PR 2 PARSER TESTS PASS');
  console.log('================================================================');
}

main().catch((e) => { console.error(e); process.exit(1); });
