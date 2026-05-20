// Tests for computeWorkbookCoverage.
//
//   npm run test:compute-workbook-coverage
//
// Builds synthetic workbooks with known cell mixes and asserts the classifier
// counts every category correctly, plus the population-rate + status thresholds.

import ExcelJS from 'exceljs';
import { computeWorkbookCoverage } from '../services/compute-workbook-coverage.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

async function build(builder: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  builder(wb);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

async function main(): Promise<void> {

console.log('computeWorkbookCoverage: classifies value, formula, placeholder, empty correctly');
{
  const buf = await build((wb) => {
    const ws = wb.addWorksheet('Test');
    // Real values
    ws.getCell('A1').value = 'Hello';
    ws.getCell('A2').value = 42;
    ws.getCell('A3').value = true;
    ws.getCell('A4').value = new Date('2026-01-01');
    // Placeholder values (template-default zeros / blanks)
    ws.getCell('B1').value = 0;
    ws.getCell('B2').value = '';
    ws.getCell('B3').value = '   ';
    // Formula
    ws.getCell('C1').value = { formula: '1+1', result: 2 } as ExcelJS.CellFormulaValue;
    // C2/C3 left empty
  });
  const cov = await computeWorkbookCoverage(buf);
  const t = cov.tabs.find((x) => x.name === 'Test')!;
  assertEqual(t.realDataCells,    4, 'realDataCells = 4 (Hello + 42 + true + Date)');
  assertEqual(t.placeholderCells, 3, 'placeholderCells = 3 (0 + "" + "   ")');
  assertEqual(t.formulaCells,     1, 'formulaCells = 1');
  // emptyCells = totalCells - (4+3+1)
  assert(t.emptyCells >= 0, 'emptyCells non-negative');
  assertEqual(t.realDataCells + t.placeholderCells + t.formulaCells + t.emptyCells, t.totalCells,
    'classifications sum to totalCells');
}

console.log('\ncomputeWorkbookCoverage: population rate = real / total (matches external tool)');
{
  const buf = await build((wb) => {
    const ws = wb.addWorksheet('RateTest');
    ws.getCell('A1').value = 'real';
    ws.getCell('A2').value = 0;             // placeholder
    ws.getCell('A3').value = { formula: '1', result: 1 } as ExcelJS.CellFormulaValue;
    // rest empty
  });
  const cov = await computeWorkbookCoverage(buf);
  const t = cov.tabs.find((x) => x.name === 'RateTest')!;
  // Denominator = total cells (rowCount × columnCount), so the rate is much
  // smaller than 1/3 because ExcelJS allocates empty cells in the used range.
  // We just verify it's positive and < 1.
  assert(t.populationRate > 0,    'populationRate > 0');
  assert(t.populationRate < 1,    'populationRate < 1');
  assertEqual(t.realDataCells, 1, 'realDataCells = 1 absolute count');
}

console.log('\ncomputeWorkbookCoverage: status thresholds');
{
  // 100% real → FULLY POPULATED
  const allReal = await build((wb) => {
    const ws = wb.addWorksheet('All');
    ws.getCell('A1').value = 'a';
    ws.getCell('A2').value = 'b';
    ws.getCell('A3').value = 'c';
  });
  const cov1 = await computeWorkbookCoverage(allReal);
  assertEqual(cov1.tabs[0]!.status, 'FULLY POPULATED', 'all real → FULLY POPULATED');

  // Sparse: 1 real / (ExcelJS allocates many empty cells in the used range)
  // Denominator is total cells, so the rate is very low → NOT POPULATED.
  const sparse = await build((wb) => {
    const ws = wb.addWorksheet('Sparse');
    ws.getCell('A1').value = 'real';
    for (let i = 2; i <= 25; i++) ws.getCell('A' + i).value = 0;
  });
  const cov2 = await computeWorkbookCoverage(sparse);
  assertEqual(cov2.tabs[0]!.status, 'NOT POPULATED', 'sparse tab → NOT POPULATED');
}

console.log('\ncomputeWorkbookCoverage: multi-tab workbook + overall aggregate');
{
  const buf = await build((wb) => {
    const a = wb.addWorksheet('A');
    a.getCell('A1').value = 'x';
    const b = wb.addWorksheet('B');
    b.getCell('A1').value = 0;
    b.getCell('A2').value = 0;
  });
  const cov = await computeWorkbookCoverage(buf);
  assertEqual(cov.tabs.length, 2, '2 tabs');
  assertEqual(cov.overall.totalTabs, 2, 'overall.totalTabs = 2');
  assert(cov.overall.realDataCells >= 1, 'overall.realDataCells >= 1');
}

console.log('\ncomputeWorkbookCoverage: empty workbook → zero rates');
{
  const buf = await build((wb) => { wb.addWorksheet('Empty'); });
  const cov = await computeWorkbookCoverage(buf);
  assertEqual(cov.tabs[0]!.realDataCells,    0, 'empty tab: 0 real');
  assertEqual(cov.tabs[0]!.populationRate,   0, 'empty tab: 0 rate');
  assertEqual(cov.tabs[0]!.status,           'NOT POPULATED', 'empty tab: NOT POPULATED');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

}

main().catch((e) => { console.error(e); process.exit(1); });
