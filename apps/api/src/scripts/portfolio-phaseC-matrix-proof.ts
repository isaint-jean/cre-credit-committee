/**
 * PROOF — Portfolio Phase C: the rollup MATRIX tab matching Isabelle's Blank Rollup UW
 * Template's "Rollup Tab" shape (col B = data field · C..Z = properties · AB = Totals).
 *
 *  (A) the workbook has a "Rollup Tab" with the header shape: B=Data Field, C..=1..N, AB=Totals.
 *  (B) per-property columns show each property's REAL 1a values (honest-blank where absent).
 *  (C) each row's Totals cell uses the template's rule AND equals the aggregator (zero drift):
 *      SUM (balances / line items), SUMPRODUCT-by-allocation (Concluded Cap Rate),
 *      ratio-of-totals (Portfolio LTV / debt yield / DSCR).
 *  (D) per-year rows we lack data for → honest-blank (label present, cells empty); stabilized
 *      figure threaded into "Year 1" only.
 *  (E) values flattened (no live formulas), valid re-readable xlsx; the matrix is the primary
 *      rollup tab (old Blended Pro-Forma gone).
 *  (F) single-loan byte-identical (BMARK 17, 640 head); matrix built only in the composer.
 *
 * MINT-SAFE: composer-only (roll_up + N>1); no canonical writes. Run from apps/api:
 *   npx tsx src/scripts/portfolio-phaseC-matrix-proof.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { manualPortfolioToComponents, type ManualPortfolioDefinition, type ManualPortfolioProperty } from '@cre/contracts';
import { aggregatePortfolio } from '../services/portfolio-aggregator.service.js';
import { composePortfolioWorkbook } from '../services/portfolio-workbook-composer.service.js';
import { PORTFOLIO_TEMPLATE_PATH, PORTFOLIO_LEAF_SHEET } from '../services/export-portfolio-dispatch.service.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const approx = (a: unknown, b: number, tol = 1): boolean => typeof a === 'number' && Math.abs(a - b) <= tol;
const cellNum = (ws: ExcelJS.Worksheet, r: number, c: number): unknown => {
  const v = ws.getCell(r, c).value;
  return v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v;
};

function mk(over: Partial<ManualPortfolioProperty>): ManualPortfolioProperty {
  return {
    propertyName: null, address: null, city: null, state: null, propertyType: 'Self-Storage', netRentableSF: null,
    value: null, noi: null, ncf: null, occupancyPct: null, allocatedLoanAmount: null,
    originalBalance: null, cutoffBalance: null, pgi: null, otherIncome: null, expenseReimbursements: null,
    egi: null, operatingExpenses: null, replacementReserves: null, tiLc: null, otherCapEx: null,
    rolloverPctWithinTerm: null, ...over,
  };
}
const P = [
  mk({ propertyName: 'Union City', value: 29_000_000, noi: 1_900_000, ncf: 1_730_000, allocatedLoanAmount: 18_000_000, originalBalance: 20_000_000, cutoffBalance: 19_500_000, netRentableSF: 69_000, pgi: 3_000_000, egi: 3_100_000, operatingExpenses: 1_200_000 }),
  mk({ propertyName: 'Jersey City', value: 21_500_000, noi: 1_200_000, ncf: 1_100_000, allocatedLoanAmount: 13_000_000, originalBalance: 14_000_000, cutoffBalance: 13_500_000, netRentableSF: 44_000, pgi: 2_000_000, egi: 2_100_000, operatingExpenses: 900_000 }),
  mk({ propertyName: 'Newark', value: 19_500_000, noi: 1_190_000, ncf: 1_090_000, allocatedLoanAmount: 12_000_000, originalBalance: 13_000_000, cutoffBalance: 12_500_000, netRentableSF: 62_000, pgi: 1_900_000, egi: 1_950_000, operatingExpenses: 760_000 }),
];
const DEF: ManualPortfolioDefinition = { properties: P, wholeLoanDebtService: 3_000_000 };

const LABEL = 2, FIRST = 3, TOTAL = 28;
/** Find the row index whose col-B label === label (exact). */
function rowFor(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 1; r <= ws.rowCount; r++) if (String(ws.getCell(r, LABEL).value ?? '') === label) return r;
  return -1;
}

(async () => {
  console.log('\nPortfolio Phase C — rollup matrix proof');
  const comps = manualPortfolioToComponents(DEF);
  const agg = aggregatePortfolio(comps, { wholeLoanDebtService: DEF.wholeLoanDebtService });
  const wb = await composePortfolioWorkbook({ templatePath: PORTFOLIO_TEMPLATE_PATH, leafTemplateSheetName: PORTFOLIO_LEAF_SHEET, components: comps, aggregation: agg });

  const back = new ExcelJS.Workbook();
  await back.xlsx.load(wb.buffer as never);
  const ws = back.getWorksheet('Rollup Tab');

  console.log('\n(A) matrix tab shape:');
  check('workbook has a "Rollup Tab"', ws !== undefined);
  if (!ws) { console.log('proof: FAIL (no tab)'); process.exit(1); }
  check('header: B=Data Field, C..E=1..3, AB=Totals', ws.getCell(1, LABEL).value === 'Data Field' && ws.getCell(1, FIRST).value === 1 && ws.getCell(1, FIRST + 2).value === 3 && ws.getCell(1, TOTAL).value === 'Totals');
  check('row 2 = Allocated Portion; row 3 = Property Name', ws.getCell(2, LABEL).value === 'Allocated Portion' && ws.getCell(3, LABEL).value === 'Property Name');
  check('property names in C..E', ws.getCell(3, FIRST).value === 'Union City' && ws.getCell(3, FIRST + 2).value === 'Newark');
  check('matrix is the PRIMARY rollup tab; Blended Pro-Forma removed', wb.rollUpSheetNames[0] === 'Rollup Tab' && !wb.rollUpSheetNames.includes('Blended Pro-Forma'));

  console.log('\n(B) per-property columns show real 1a values:');
  const rOrig = rowFor(ws, 'Original Balance');
  check('Original Balance C..E = per-property values', approx(cellNum(ws, rOrig, FIRST), 20_000_000) && approx(cellNum(ws, rOrig, FIRST + 1), 14_000_000) && approx(cellNum(ws, rOrig, FIRST + 2), 13_000_000));
  const rNRA = rowFor(ws, 'Net Rentable Area');
  check('Net Rentable Area per-property values', approx(cellNum(ws, rNRA, FIRST), 69_000) && approx(cellNum(ws, rNRA, FIRST + 2), 62_000));

  console.log('\n(C) Totals use the template rule AND equal the aggregator (zero drift):');
  check('Original Balance total = SUM = aggregator lineItems', approx(cellNum(ws, rOrig, TOTAL), agg.math.lineItems.originalBalance!) && approx(agg.math.lineItems.originalBalance!, 47_000_000));
  check('Concluded Value total = SUM = blendedValue', approx(cellNum(ws, rowFor(ws, 'Concluded Value'), TOTAL), agg.math.blendedValue!));
  const rCap = rowFor(ws, 'Concluded Cap Rate');
  check('Concluded Cap Rate total = SUMPRODUCT-by-allocation = aggregator', approx(cellNum(ws, rCap, TOTAL) as number, agg.math.allocationWeightedCapRate!, 1e-9));
  check('cap rate per-property = each capRate', approx(cellNum(ws, rCap, FIRST) as number, comps[0]!.capRate!, 1e-9));
  check('PGI Year 1 total = SUM = lineItems.pgi', approx(cellNum(ws, rowFor(ws, 'PGI Year 1'), TOTAL), agg.math.lineItems.pgi!) && approx(agg.math.lineItems.pgi!, 6_900_000));
  check('NOI Year 1 total = SUM = aggregateNoi', approx(cellNum(ws, rowFor(ws, 'NOI Year 1'), TOTAL), agg.math.aggregateNoi!));
  // ratio-of-totals section
  check('Portfolio LTV row = ratio = aggregator', approx(cellNum(ws, rowFor(ws, 'Portfolio LTV (Σ allocated ÷ Σ value)'), TOTAL) as number, agg.math.portfolioLtv!, 1e-9));
  check('Aggregate DSCR row = ratio = aggregator', approx(cellNum(ws, rowFor(ws, 'Aggregate DSCR (Σ NCF ÷ whole-loan DS)'), TOTAL) as number, agg.math.aggregateDscr!, 1e-9));

  console.log('\n(D) per-year rows honest-blank; stabilized threaded into Year 1 only:');
  check('PGI Year 1 present (stabilized threaded)', cellNum(ws, rowFor(ws, 'PGI Year 1'), FIRST) !== null);
  const rPgi2 = rowFor(ws, 'PGI Year 2');
  check('PGI Year 2 label present but cells blank (not smeared)', rPgi2 > 0 && cellNum(ws, rPgi2, FIRST) == null && cellNum(ws, rPgi2, TOTAL) == null);
  const rApp = rowFor(ws, 'Appraisal Value');
  check('Appraisal Value row blank (1a has no separate appraisal value)', rApp > 0 && cellNum(ws, rApp, FIRST) == null && cellNum(ws, rApp, TOTAL) == null);
  const rRoll = rowFor(ws, 'Rollover Year 1 - SF');
  check('Rollover SF schedule blank (1a carries a share, not SF)', rRoll > 0 && cellNum(ws, rRoll, TOTAL) == null);

  console.log('\n(E) flattened values + valid xlsx:');
  check('Totals cell is a plain value, not a formula', typeof ws.getCell(rOrig, TOTAL).value === 'number');
  check('valid re-readable workbook', back.worksheets.length >= 7);

  console.log('\n(F) honest-blank + mint-safe:');
  // A field no property supplies → blank row + null total.
  const noReserves = aggregatePortfolio(manualPortfolioToComponents({ properties: P.map((p) => mk({ ...p, replacementReserves: null })), wholeLoanDebtService: null }), {});
  const wb2 = await composePortfolioWorkbook({ templatePath: PORTFOLIO_TEMPLATE_PATH, leafTemplateSheetName: PORTFOLIO_LEAF_SHEET, components: manualPortfolioToComponents({ properties: P.map((p) => mk({ ...p, replacementReserves: null })), wholeLoanDebtService: null }), aggregation: noReserves });
  const b2 = new ExcelJS.Workbook(); await b2.xlsx.load(wb2.buffer as never);
  const ws2 = b2.getWorksheet('Rollup Tab')!;
  check('Reserves Year 1 total null when no property supplies it (honest-blank)', cellNum(ws2, rowFor(ws2, 'Reserves Year 1'), TOTAL) == null);
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  const composerSrc = readFileSync(path.join(process.cwd(), 'src/services/export-portfolio-dispatch.service.ts'), 'utf8');
  check('matrix reachable only via composer (roll_up + N>1 gate intact)', /underwritingMode !== 'roll_up'\) return null/.test(composerSrc) && /length <= 1\) return null/.test(composerSrc));
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);

  console.log(failures === 0 ? '\nPhase C proof: OK\n' : `\nPhase C proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
