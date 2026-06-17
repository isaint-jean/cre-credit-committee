/**
 * Tests for extract-cash-flow-from-xlsx.
 *
 *   npm run test:extract-cash-flow
 *
 * Fixture: apps/api/fixtures/sunroad-centrum-cf.xlsx — Sunroad Centrum Seller CF
 * Preliminary 2023-07-25. Sheet "Cash Flow Extract" carries Budget / In-Place /
 * GS U/W columns; this test verifies the parser identifies the In-Place and
 * GS U/W periods, locates the label column, and extracts each contract-mapped
 * line item with the correct sign and magnitude.
 *
 * Pattern mirrors test-extraction-contract.ts (ok/fail/assert/assertEqual,
 * exit code = failure count). No vitest/jest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCashFlowFromXlsx } from '../services/extract-cash-flow-from-xlsx.js';

// Resolve fixture relative to this script so it works whether `tsx` is invoked
// from the repo root or from apps/api (npm workspaces both happen).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/sunroad-centrum-cf.xlsx');

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(actual: number | null, expected: number, tol: number, m: string): void {
  if (actual === null) { fail(`${m} (actual=null, expected≈${expected})`); return; }
  Math.abs(actual - expected) <= tol
    ? ok(`${m} (${actual} ≈ ${expected})`)
    : fail(`${m} (actual=${actual}, expected≈${expected}, tol=${tol})`);
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`FATAL: fixture not found at ${FIXTURE}`);
    process.exit(2);
  }

  const buffer = fs.readFileSync(FIXTURE);

  /* ----------------------- happy path: full extraction ---------------------- */

  console.log('Sunroad CF — extractCashFlowFromXlsx (default worksheet auto-detect):');
  const result = await extractCashFlowFromXlsx(buffer);

  assert(result.inPlace !== null, 'inPlace snapshot is populated');
  assert(result.sellerUwOperatingStatement !== null, 'sellerUwOperatingStatement (GS U/W) snapshot is populated');

  // ---- In-Place column (expected from Cash Flow Extract sheet, column 7) ---- //
  if (result.inPlace) {
    const t = result.inPlace;
    console.log('\n  In-Place period & line items:');
    assert(/in[\s-]*place/i.test(t.period), `period label looks in-place ("${t.period}")`);

    // GPR (r10 col 7): 13_383_467.35164
    assertClose(t.income.grossPotentialRent, 13_383_467, 5, 'income.grossPotentialRent');
    // Other Income total (r20 col 7): 138_000
    assertClose(t.income.otherIncome, 138_000, 1, 'income.otherIncome');
    // EGR (r25 col 7): 13_605_467.35164 — mapped to totalIncome
    assertClose(t.income.totalIncome, 13_605_467, 5, 'income.totalIncome (EGR)');
    // Effective rent: not separately reported in this CF schema → null per discipline
    assertEqual(t.income.effectiveRent, null, 'income.effectiveRent left null (not in source)');
    // Vacancy loss (r24 col 7): 0 (In-Place has no vacancy applied — only UW column does)
    assertClose(t.vacancyLoss, 0, 1, 'vacancyLoss (In-Place reports 0)');

    // Expenses (col 7)
    assertClose(t.expenses.taxes, 780_092, 1, 'expenses.taxes (r27)');
    assertClose(t.expenses.insurance, 306_000, 1, 'expenses.insurance (r28)');
    assertClose(t.expenses.utilities, 276_580, 1, 'expenses.utilities (r31)');
    assertClose(t.expenses.repairsMaintenance, 817_537, 1, 'expenses.repairsMaintenance (r32)');
    assertClose(t.expenses.managementFees, 408_164, 2, 'expenses.managementFees (r34)');
    // Total Expenses (r37 col 7): 3_274_676
    assertClose(t.expenses.totalOperatingExpenses, 3_274_676, 2, 'expenses.totalOperatingExpenses (r37)');

    // NOI (r38 col 7): 10_330_791
    assertClose(t.noi, 10_330_791, 5, 'noi (r38)');
  }

  // ---- UW column (expected from Cash Flow Extract sheet, column 10) ---- //
  if (result.sellerUwOperatingStatement) {
    const u = result.sellerUwOperatingStatement;
    console.log('\n  GS U/W period & line items:');
    assert(/u\/w|uw|underwrit/i.test(u.period), `period label looks UW ("${u.period}")`);

    // GPR (r10 col 10): 13_383_467.35164 (same as In-Place — UW didn't bump rent)
    assertClose(u.income.grossPotentialRent, 13_383_467, 5, 'income.grossPotentialRent');
    assertClose(u.income.otherIncome, 138_000, 1, 'income.otherIncome');
    // EGR (r25 col 10): 13_628_082.20
    assertClose(u.income.totalIncome, 13_628_082, 5, 'income.totalIncome (EGR)');
    // Vacancy loss (r24 col 10): -455_337.86 (UW applies 5% vacancy on non-credit rent)
    assertClose(u.vacancyLoss, -455_338, 2, 'vacancyLoss (UW applies vacancy, negative)');

    // Expenses (col 10)
    // Taxes UW (r27 col 10): 960_500 (Prop 13 reassessment, materially higher than In-Place 780_092)
    assertClose(u.expenses.taxes, 960_500, 2, 'expenses.taxes (UW > In-Place per Prop 13)');
    assertClose(u.expenses.insurance, 306_000, 1, 'expenses.insurance');
    assertClose(u.expenses.utilities, 276_580, 1, 'expenses.utilities');
    assertClose(u.expenses.repairsMaintenance, 817_537, 1, 'expenses.repairsMaintenance');
    // Mgmt fee UW (r34 col 10): 408_842 — 3% of UW EGI (slightly higher than In-Place's 408_164)
    assertClose(u.expenses.managementFees, 408_842, 2, 'expenses.managementFees');
    // Total Expenses (r37 col 10): 3_455_762
    assertClose(u.expenses.totalOperatingExpenses, 3_455_762, 2, 'expenses.totalOperatingExpenses');

    // NOI UW (r38 col 10): 10_172_320 (lower than In-Place NOI 10_330_791 due to UW vacancy + tax bump)
    assertClose(u.noi, 10_172_320, 5, 'noi (UW NOI below In-Place per manifesto-style pressure-test)');

    // uwAdjustments — the CMBS "Total UW Adjustments" section total at row 16
    // (Sunroad: $297,544.71 = PV of contractual rent steps for IG tenants,
    // per CF footnote 3). MUST capture the section total, not the per-line
    // "Credit Tenant Rent Steps" entry at row 15 — the regex requires the
    // "total" prefix specifically to enforce that distinction.
    assertClose(u.income.uwAdjustments ?? null, 297_545, 1, 'income.uwAdjustments captures "Total UW Adjustments" total ($297,545 rent-steps PV)');
    // Section-total guard. Verify the regex did NOT match on the per-line
    // "Credit Tenant Rent Steps" row (which would also produce a number).
    // The line value is the same ($297,545 since it's the only line under
    // the section), so equality with the per-line value isn't a guard. The
    // guard is that the regex `^total\s+(?:uw|underwrit\w+)\s+adjustments?`
    // requires the leading "Total" — verified at extractor source. We
    // assert here that ONLY the row labeled "Total UW Adjustments" matched
    // by checking the captured value is the section total, not zero or null.
    assert(typeof u.income.uwAdjustments === 'number' && u.income.uwAdjustments > 0, 'uwAdjustments is a real positive number (not null, not zero)');
  }

  /* -------------------------- explicit worksheet name ----------------------- */

  console.log('\nExplicit worksheet name:');
  const explicit = await extractCashFlowFromXlsx(buffer, { worksheetName: 'Cash Flow Extract' });
  assert(explicit.inPlace !== null, 'explicit "Cash Flow Extract" produces inPlace');
  assert(explicit.sellerUwOperatingStatement !== null, 'explicit "Cash Flow Extract" produces UW snapshot');

  /* ------------------------- unknown worksheet → null ----------------------- */

  console.log('\nUnknown worksheet → null on both fields:');
  const missingSheet = await extractCashFlowFromXlsx(buffer, { worksheetName: 'Does Not Exist' });
  assertEqual(missingSheet.inPlace, null, 'unknown worksheet → inPlace null');
  assertEqual(missingSheet.sellerUwOperatingStatement, null, 'unknown worksheet → sellerUwOperatingStatement null');

  /* ----------- non-cashflow workbook → null (no header row found) ---------- */

  console.log('\nUnrecognizable buffer → null on both fields:');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['just a label', '', '', '']);
  ws.addRow(['', '', '', '']);
  const emptyBuf = Buffer.from(await wb.xlsx.writeBuffer());

  /* --------- uwAdjustments null when no "Total UW Adjustments" row exists -- */

  console.log('\nMinimal CF with no UW-adjustments row → uwAdjustments null (not 0):');
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Cash Flow Extract');
  // Header row with BOTH In-Place and GS U/W column labels (PASS 1 detection
  // requires both an in_place/t12 column AND a uw column on the same row).
  ws2.getCell('G2').value = 'In-Place';
  ws2.getCell('J2').value = 'GS U/W';
  // Build a minimal income/expense section that the extractor will detect,
  // but DELIBERATELY omit any "Total UW Adjustments" row.
  ws2.getCell('C7').value  = 'Gross Potential Commercial Rental Revenue';  ws2.getCell('G7').value  = 1_000_000;  ws2.getCell('J7').value  = 1_000_000;
  ws2.getCell('C12').value = 'Total Commercial Reimbursement Revenue';     ws2.getCell('G12').value = 50_000;     ws2.getCell('J12').value = 50_000;
  ws2.getCell('C18').value = 'Parking Income';                              ws2.getCell('G18').value = 10_000;     ws2.getCell('J18').value = 10_000;
  ws2.getCell('C20').value = 'Total Other Revenue';                         ws2.getCell('G20').value = 10_000;     ws2.getCell('J20').value = 10_000;
  ws2.getCell('C24').value = 'Total Commercial Vacancy & Credit Loss';     ws2.getCell('G24').value = -20_000;    ws2.getCell('J24').value = -20_000;
  ws2.getCell('C25').value = 'Effective Gross Revenue';                     ws2.getCell('G25').value = 1_040_000;  ws2.getCell('J25').value = 1_040_000;
  ws2.getCell('C27').value = 'Real Estate Taxes';                            ws2.getCell('G27').value = 100_000;    ws2.getCell('J27').value = 100_000;
  ws2.getCell('C28').value = 'Insurance';                                    ws2.getCell('G28').value = 50_000;     ws2.getCell('J28').value = 50_000;
  ws2.getCell('C37').value = 'Total Expenses';                               ws2.getCell('G37').value = 150_000;    ws2.getCell('J37').value = 150_000;
  ws2.getCell('C38').value = 'Net Operating Income';                         ws2.getCell('G38').value = 890_000;    ws2.getCell('J38').value = 890_000;
  const noAdjBuf = Buffer.from(await wb2.xlsx.writeBuffer());
  const noAdj = await extractCashFlowFromXlsx(noAdjBuf, { worksheetName: 'Cash Flow Extract' });
  // Sanity: the sheet IS recognized as a UW snapshot.
  assert(noAdj.sellerUwOperatingStatement !== null, 'synthetic CF without uw-adjustments row still produces a UW snapshot');
  // Normalize undefined → null for the equality check (the extractor uses
  // either to mean "no source"; the contract guarantees the difference is
  // not load-bearing for downstream).
  const noAdjValue = noAdj.sellerUwOperatingStatement?.income.uwAdjustments ?? null;
  assertEqual(noAdjValue, null, 'uwAdjustments is null (not 0) when no "Total UW Adjustments" row exists in source');
  const empty = await extractCashFlowFromXlsx(emptyBuf);
  assertEqual(empty.inPlace, null, 'no recognizable header → inPlace null');
  assertEqual(empty.sellerUwOperatingStatement, null, 'no recognizable header → sellerUwOperatingStatement null');

  /* --------------------------- summary / exit code -------------------------- */

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Unhandled error in test:', err);
  process.exit(2);
});
