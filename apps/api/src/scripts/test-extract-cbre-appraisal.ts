/**
 * test-extract-cbre-appraisal — run-once checksum test for the CBRE Sunroad
 * appraisal extractor against the brief's authorized expected values.
 *
 *   cd apps/api && npx tsx src/scripts/test-extract-cbre-appraisal.ts
 *
 * If ANY field misses its target, this script reports the break and exits 1 —
 * that's an extractor bug, not a wiring issue.
 */
import { readFileSync } from 'node:fs';
import { extractCbreAppraisal } from '../services/extract-cbre-appraisal.js';

const PDF = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/.data/source-docs/3327fd55-e382-4286-8378-64d33a11e518/appraisal/132b5d07f307ee1b8ce2fa0aba87a6f04d94bdd5d432a1c4307f1f83ad04ff1d.pdf';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown, tolerance = 0): void {
  let ok: boolean;
  if (typeof actual === 'number' && typeof expected === 'number') {
    ok = Math.abs(actual - expected) <= tolerance;
  } else {
    ok = actual === expected;
  }
  if (ok) { pass++; console.log(`  ✓ ${label}: ${actual}`); }
  else    { fail++; console.error(`  ✗ ${label}: actual=${actual} expected=${expected}`); }
}

(async () => {
  console.log('Loading PDF…');
  const buf = readFileSync(PDF);
  console.log(`  bytes: ${buf.length}`);
  console.log('Extracting…');
  const r = await extractCbreAppraisal(buf);

  console.log('\n=== HEADLINE VALUES ===');
  check('asIsValue',         r.asIsValue,         122_000_000);
  check('asStabilizedValue', r.asStabilizedValue, 133_000_000);
  check('landValue',         r.landValue,         30_000_000);

  console.log('\n=== CAP RATES ===');
  check('overallCapRate',  r.overallCapRate,  0.0625, 0.00001);
  check('terminalCapRate', r.terminalCapRate, 0.0650, 0.00001);
  check('discountRate',    r.discountRate,    0.0725, 0.00001);

  console.log('\n=== IDENTITY ===');
  check('addressFull',       r.addressFull,        '8620 Spectrum Center Blvd');
  // Tier 1b: city/state are no longer hardcoded 'San Diego'/'CA'. An appraisal's
  // comparables section is dense with "City, County, State" strings, so a
  // deterministic regex grabs a comp (proven: "Portola Hills…"). They are
  // deferred to Tier 1's LLM (whole-doc "subject" understanding) → null here.
  check('city',              r.city,               null);
  check('state',             r.state,              null);
  check('zip',               r.zip,                '92123');
  check('county',            r.county,             'San Diego County');
  check('yearBuilt',         r.yearBuilt,          2008);
  check('grossBuildingArea', r.grossBuildingArea,  285_085);
  check('netRentableArea',   r.netRentableArea,    274_758);
  check('numberOfStories',   r.numberOfStories,    11);
  check('numberOfBuildings', r.numberOfBuildings,  1);

  console.log('\n=== LEASE-UP AXIS ===');
  check('currentOccupancyPhysical', r.currentOccupancyPhysical, 0.468, 0.001);
  check('stabilizedOccupancy',      r.stabilizedOccupancy,      0.960, 0.001);
  check('stabilizationMonths',      r.stabilizationMonths,      10);

  console.log('\n=== STABILIZED PRO FORMA (the load-bearing table) ===');
  const sp = r.stabilizedProForma!;
  check('PGR',                    sp.potentialRentalIncome,     12_635_961, 1);
  check('Vacancy loss',           sp.vacancyLoss,               -505_438, 1);
  check('Credit loss',            sp.creditLoss,                -126_360, 1);
  check('Other income (gross)',   sp.otherIncomeGross,          138_000);
  check('Other-income VCL',       sp.otherIncomeVCL,            -28_023, 1);
  check('Net-effective reimb',    sp.netEffectiveReimbursements, 394_436, 1);
  check('EGI',                    sp.effectiveGrossIncome,      12_536_598, 1);
  check('Real estate taxes',      sp.realEstateTaxes,           1_674_577, 1);
  check('Property insurance',     sp.insurance,                 302_234, 1);
  check('Utilities',              sp.utilities,                 412_137, 1);
  check('General operating',      sp.generalOperating,          247_282, 1);
  check('Janitorial',             sp.janitorial,                370_923, 1);
  check('R&M',                    sp.repairsMaintenance,        494_564, 1);
  check('Management fee',         sp.managementFee,             376_098, 1);
  check('Nonreimbursable LL',     sp.nonreimbursableLandlord,   54_952, 1);
  check('Replacement reserves',   sp.replacementReserves,       0);
  check('Total OpEx',             sp.totalOperatingExpenses,    3_932_767, 1);
  check('Stabilized NOI',         sp.netOperatingIncome,        8_603_831, 1);

  console.log('\n=== CURRENT PRO FORMA (2022 actuals) ===');
  const cp = r.currentProForma!;
  check('Current EGI',  cp.effectiveGrossIncome,      1_942_126, 1);
  check('Current TOE',  cp.totalOperatingExpenses,    2_297_142, 1);
  check('Current NOI',  cp.netOperatingIncome,        -355_016, 1);

  console.log('\n=== RECONCILIATION ASSERTIONS ===');
  // ★ Sum of broken-out expenses MUST equal stated TOE
  const expenseSum = (sp.realEstateTaxes ?? 0) + (sp.insurance ?? 0) + (sp.utilities ?? 0) +
                     (sp.generalOperating ?? 0) + (sp.janitorial ?? 0) + (sp.repairsMaintenance ?? 0) +
                     (sp.managementFee ?? 0) + (sp.nonreimbursableLandlord ?? 0) + (sp.replacementReserves ?? 0);
  check('Σ(expenses) == totalOperatingExpenses', expenseSum, sp.totalOperatingExpenses!, 1);
  // ★ Template-computed L17 (= Net Rental Rev + OtherIncome + NetEffReimb)
  const templateL17 = (sp.potentialRentalIncome! + sp.vacancyLoss! + sp.creditLoss!) +
                      (sp.otherIncomeGross ?? 0) + (sp.netEffectiveReimbursements ?? 0);
  check('Template L17 ≈ EGI', templateL17, sp.effectiveGrossIncome!, 2);
  // ★ Template-computed L35 NOI ≈ stabilized NOI (the gate)
  const templateL35 = templateL17 - expenseSum;
  check('★ Template L35 NOI ties to stabilizedNOI', templateL35, sp.netOperatingIncome!, 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('\n★ EXTRACTOR BUG — fix before proceeding.');
    process.exit(1);
  }
  console.log('\n★ All checksums green. AppraisalExtraction ready to persist + wire.');
  process.exit(0);
})().catch((e) => { console.error('threw:', e); process.exit(2); });
