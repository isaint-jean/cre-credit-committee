/**
 * Tests for the period-classification fix in extractCashFlowFromXlsx (2026-05-31).
 *
 *   tsx src/scripts/test-cf-period-classification.ts
 *
 * Validates that the period-pattern split produces a clean three-slot result:
 *   - In-Place + GS U/W columns → inPlace populated, sellerUwOperatingStatement
 *     populated, t12Actual null.
 *   - T-12 + GS U/W columns → t12Actual populated, sellerUwOperatingStatement
 *     populated, inPlace null.
 *   - All three columns → all three slots populated; no cross-contamination
 *     (each slot reads from its own column's amount column).
 *   - In-Place only (no UW) → header-row rejected (extractor requires UW
 *     column for a fit); all three slots null. This is the documented behavior:
 *     extracting against a UW-less CF is out of scope (the GS U/W column is
 *     the issuer's representation and is what most class-(a) consumers need).
 *
 * Test approach: build minimal synthetic XLSX buffers in memory via ExcelJS,
 * exercising the period-header detection + label scan + slot projection.
 * Mirrors test-extract-cash-flow-from-xlsx.ts's pattern (tsx + ok/fail).
 */

import ExcelJS from 'exceljs';
import { extractCashFlowFromXlsx } from '../services/extract-cash-flow-from-xlsx.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/** Build a minimal CF workbook. Each entry in `periods` becomes one column
 *  with a period-header row at row 3 and a few line-item rows below. The
 *  label column is column A. */
async function makeCfBuffer(periods: ReadonlyArray<{ label: string; amount: number }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Flow Extract');

  // Period header at row 3.
  ws.getCell(3, 1).value = '';
  periods.forEach((p, idx) => {
    ws.getCell(3, 2 + idx).value = p.label;
  });

  // Line-items below (>= 3 to pass label-column scan).
  const rows: { key: string; offset: number }[] = [
    { key: 'Gross Potential Rent', offset: 100 },
    { key: 'Real Estate Taxes', offset: 200 },
    { key: 'Insurance', offset: 300 },
    { key: 'Total Operating Expenses', offset: 400 },
    { key: 'Net Operating Income', offset: 500 },
    { key: 'Replacement Reserves', offset: 600 },
  ];
  rows.forEach((r, i) => {
    const row = 5 + i;
    ws.getCell(row, 1).value = r.key;
    periods.forEach((p, idx) => {
      ws.getCell(row, 2 + idx).value = p.amount + r.offset + idx;
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

(async () => {
  /* --------------- Case 1: In-Place + GS U/W → inPlace + sellerUw -------------- */
  console.log('Case 1 — In-Place + GS U/W columns (no T-12):');
  {
    const buf = await makeCfBuffer([
      { label: 'In-Place', amount: 1_000_000 },
      { label: 'GS U/W', amount: 2_000_000 },
    ]);
    const r = await extractCashFlowFromXlsx(buf);
    assertEqual(r.t12Actual, null, 't12Actual is null (no T-12 column in source)');
    assert(r.inPlace !== null, 'inPlace populated (In-Place column)');
    assert(r.sellerUwOperatingStatement !== null, 'sellerUwOperatingStatement populated (GS U/W column)');
    // Period label is preserved verbatim.
    if (r.inPlace) assert(/in[\s-]*place/i.test(r.inPlace.period), 'inPlace.period label is "In-Place"');
    if (r.sellerUwOperatingStatement) assert(/u\/?w/i.test(r.sellerUwOperatingStatement.period), 'sellerUwOperatingStatement.period label is "GS U/W"');
  }

  /* --------------- Case 2: T-12 + GS U/W → t12Actual + sellerUw -------------- */
  console.log('\nCase 2 — T-12 + GS U/W columns (no In-Place):');
  {
    const buf = await makeCfBuffer([
      { label: 'T-12 ending 2025-12-31', amount: 1_500_000 },
      { label: 'GS U/W', amount: 2_500_000 },
    ]);
    const r = await extractCashFlowFromXlsx(buf);
    assert(r.t12Actual !== null, 't12Actual populated (strict T-12 column)');
    assertEqual(r.inPlace, null, 'inPlace is null (no In-Place column)');
    assert(r.sellerUwOperatingStatement !== null, 'sellerUwOperatingStatement populated');
    if (r.t12Actual) assert(/t.?12|trailing/i.test(r.t12Actual.period), 't12Actual.period label matches T-12 pattern');
  }

  /* --------------- Case 3: All three columns → no cross-contamination ---------- */
  console.log('\nCase 3 — In-Place + T-12 + GS U/W (all three columns):');
  {
    // Distinct amounts so we can verify each slot picks its OWN column, not a
    // neighbor's data.
    const buf = await makeCfBuffer([
      { label: 'In-Place', amount: 1_000_000 },
      { label: 'T-12', amount: 2_000_000 },
      { label: 'GS U/W', amount: 3_000_000 },
    ]);
    const r = await extractCashFlowFromXlsx(buf);
    assert(r.t12Actual !== null, 't12Actual populated');
    assert(r.inPlace !== null, 'inPlace populated');
    assert(r.sellerUwOperatingStatement !== null, 'sellerUwOperatingStatement populated');

    // Verify each slot picked its own column via the distinct GPR values:
    //   In-Place: amount + offset(100) + colIdx(0) = 1_000_100
    //   T-12:     amount + offset(100) + colIdx(1) = 2_000_101
    //   GS U/W:   amount + offset(100) + colIdx(2) = 3_000_102
    assertEqual(r.inPlace?.income.grossPotentialRent ?? null, 1_000_100, 'inPlace.GPR comes from In-Place column');
    assertEqual(r.t12Actual?.income.grossPotentialRent ?? null, 2_000_101, 't12Actual.GPR comes from T-12 column');
    assertEqual(r.sellerUwOperatingStatement?.income.grossPotentialRent ?? null, 3_000_102, 'sellerUwOperatingStatement.GPR comes from GS U/W column');
  }

  /* --------------- Case 4: In-Place only (no UW) → all null ------------------- */
  console.log('\nCase 4 — In-Place column only (no UW column → rejected):');
  {
    // Without a UW column the header-row scan rejects the sheet, returning all
    // three slots null. Documented behavior: a CF without an issuer-UW column
    // is out of scope for this extractor (the GS U/W column is the bank-side
    // view this layer is designed to capture).
    const buf = await makeCfBuffer([
      { label: 'In-Place', amount: 1_000_000 },
    ]);
    const r = await extractCashFlowFromXlsx(buf);
    assertEqual(r.t12Actual, null, 't12Actual null (header row not accepted without UW)');
    assertEqual(r.inPlace, null, 'inPlace null (header row not accepted without UW)');
    assertEqual(r.sellerUwOperatingStatement, null, 'sellerUwOperatingStatement null');
  }

  /* --------------- Summary ----------------------------------------------------- */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
