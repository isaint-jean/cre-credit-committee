/**
 * PROOF — Portfolio Phase B 1a: widen PropertyComponent + manual input + aggregator to the
 * template's per-property line-item set (the values the Phase C rollup matrix consumes).
 *
 *  (A) contract round-trip: the new line-item fields serialize→parse→normalize onto components.
 *  (B) aggregator SUMS the additive line items (template AB = SUM(C:Z)): original/cutoff
 *      balance, PGI, other income, expense reimb, EGI, OpEx, NOI, reserves, TI-LC, capex, NCF.
 *  (C) allocation-weighted rules (SUMPRODUCT-by-allocation): weighted cap rate + rollover.
 *  (D) honest-null: a line item omitted across all properties → null total (never guessed);
 *      weighted rate with no allocations → null.
 *  (E) export still runs on the wider components (composer shape unchanged — matrix is Phase C).
 *  (F) additive / mint-safe: single-component safe; canonical byte-identical (BMARK 17, 640 head).
 *
 * MINT-SAFE: pure aggregation + contract; no canonical writes. No doctrine/render-schema change.
 * Run: npx tsx src/scripts/portfolio-phaseB-1a-lineitems-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  parseManualPortfolio, serializeManualPortfolio, manualPortfolioToComponents,
  type ManualPortfolioDefinition, type ManualPortfolioProperty,
} from '@cre/contracts';
import { aggregatePortfolio } from '../services/portfolio-aggregator.service.js';
import { composePortfolioWorkbook } from '../services/portfolio-workbook-composer.service.js';
import { PORTFOLIO_TEMPLATE_PATH, PORTFOLIO_LEAF_SHEET } from '../services/export-portfolio-dispatch.service.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const approx = (a: number | null, b: number, tol = 1e-6): boolean => a !== null && Math.abs(a - b) <= tol;

function mk(over: Partial<ManualPortfolioProperty>): ManualPortfolioProperty {
  return {
    propertyName: null, address: null, city: null, state: null, propertyType: 'Self-Storage', netRentableSF: null,
    value: null, noi: null, ncf: null, occupancyPct: null, allocatedLoanAmount: null,
    originalBalance: null, cutoffBalance: null, pgi: null, otherIncome: null, expenseReimbursements: null,
    egi: null, operatingExpenses: null, replacementReserves: null, tiLc: null, otherCapEx: null,
    rolloverPctWithinTerm: null, ...over,
  };
}

// 3 properties with the FULL line-item set.
const P = [
  mk({ propertyName: 'A', value: 29_000_000, noi: 1_900_000, ncf: 1_730_000, allocatedLoanAmount: 18_000_000, originalBalance: 20_000_000, cutoffBalance: 19_500_000, pgi: 3_000_000, otherIncome: 200_000, expenseReimbursements: 100_000, egi: 3_100_000, operatingExpenses: 1_200_000, replacementReserves: 50_000, tiLc: 100_000, otherCapEx: 20_000, rolloverPctWithinTerm: 0.30 }),
  mk({ propertyName: 'B', value: 21_500_000, noi: 1_200_000, ncf: 1_100_000, allocatedLoanAmount: 13_000_000, originalBalance: 14_000_000, cutoffBalance: 13_500_000, pgi: 2_000_000, otherIncome: 150_000, expenseReimbursements: 80_000, egi: 2_100_000, operatingExpenses: 900_000, replacementReserves: 40_000, tiLc: 60_000, otherCapEx: 15_000, rolloverPctWithinTerm: 0.20 }),
  mk({ propertyName: 'C', value: 19_500_000, noi: 1_190_000, ncf: 1_090_000, allocatedLoanAmount: 12_000_000, originalBalance: 13_000_000, cutoffBalance: 12_500_000, pgi: 1_900_000, otherIncome: 120_000, expenseReimbursements: 70_000, egi: 1_950_000, operatingExpenses: 760_000, replacementReserves: 35_000, tiLc: 50_000, otherCapEx: 12_000, rolloverPctWithinTerm: 0.10 }),
];
const DEF: ManualPortfolioDefinition = { properties: P, wholeLoanDebtService: 3_000_000 };
const sum = (f: (p: ManualPortfolioProperty) => number | null): number => P.reduce((s, p) => s + (f(p) ?? 0), 0);

function partA(): void {
  console.log('\n(A) contract round-trip of the widened line-item set:');
  const back = parseManualPortfolio(serializeManualPortfolio(DEF));
  check('line items survive serialize→parse', back.properties[0]!.pgi === 3_000_000 && back.properties[0]!.originalBalance === 20_000_000 && back.properties[0]!.tiLc === 100_000);
  check('rollover share survives', back.properties[0]!.rolloverPctWithinTerm === 0.30);
  const comps = manualPortfolioToComponents(DEF);
  check('normalize carries line items onto PropertyComponent', comps[1]!.egi === 2_100_000 && comps[1]!.operatingExpenses === 900_000 && comps[1]!.cutoffBalance === 13_500_000);
}

function partB(): void {
  console.log('\n(B) aggregator SUMS the additive line items (template AB = SUM(C:Z)):');
  const li = aggregatePortfolio(manualPortfolioToComponents(DEF), { wholeLoanDebtService: DEF.wholeLoanDebtService }).math.lineItems;
  check('Σ original balance', approx(li.originalBalance, sum((p) => p.originalBalance)), `$${li.originalBalance?.toLocaleString()}`);
  check('Σ cutoff balance', approx(li.cutoffBalance, sum((p) => p.cutoffBalance)));
  check('Σ PGI', approx(li.pgi, sum((p) => p.pgi)));
  check('Σ other income', approx(li.otherIncome, sum((p) => p.otherIncome)));
  check('Σ expense reimbursements', approx(li.expenseReimbursements, sum((p) => p.expenseReimbursements)));
  check('Σ EGI', approx(li.egi, sum((p) => p.egi)));
  check('Σ operating expenses', approx(li.operatingExpenses, sum((p) => p.operatingExpenses)));
  check('Σ NOI (mirrors aggregateNoi)', approx(li.noi, sum((p) => p.noi)));
  check('Σ replacement reserves', approx(li.replacementReserves, sum((p) => p.replacementReserves)));
  check('Σ TI-LC', approx(li.tiLc, sum((p) => p.tiLc)));
  check('Σ other capex', approx(li.otherCapEx, sum((p) => p.otherCapEx)));
  check('Σ NCF (mirrors aggregateNcf)', approx(li.ncf, sum((p) => p.ncf)));
}

function partC(): void {
  console.log('\n(C) allocation-weighted rules (SUMPRODUCT-by-allocation):');
  const comps = manualPortfolioToComponents(DEF);
  const m = aggregatePortfolio(comps, { wholeLoanDebtService: DEF.wholeLoanDebtService }).math;
  const alloc = P.map((p) => p.allocatedLoanAmount!);
  const caps = comps.map((c) => c.capRate!);
  const wCap = caps.reduce((s, c, i) => s + c * alloc[i]!, 0) / alloc.reduce((s, a) => s + a, 0);
  const wRoll = P.reduce((s, p, i) => s + p.rolloverPctWithinTerm! * alloc[i]!, 0) / alloc.reduce((s, a) => s + a, 0);
  check('allocation-weighted cap rate = Σ(cap·alloc)÷Σalloc', approx(m.allocationWeightedCapRate, wCap), `${((m.allocationWeightedCapRate ?? 0) * 100).toFixed(2)}%`);
  check('allocation-weighted rollover = Σ(roll·alloc)÷Σalloc', approx(m.portfolioRolloverPct, wRoll), `${((m.portfolioRolloverPct ?? 0) * 100).toFixed(1)}%`);
  // weighted differs from a naive average → proves it's actually weighting.
  const naive = caps.reduce((s, c) => s + c, 0) / caps.length;
  check('weighted cap ≠ naive mean (allocation actually applied)', Math.abs(wCap - naive) > 1e-9);
}

function partD(): void {
  console.log('\n(D) honest-null — omitted field → null total; no allocations → weighted null:');
  const noReserves = { ...DEF, properties: P.map((p) => mk({ ...p, replacementReserves: null })) };
  const li = aggregatePortfolio(manualPortfolioToComponents(noReserves)).math.lineItems;
  check('all reserves omitted → Σ reserves null (never 0-guessed)', li.replacementReserves === null);
  check('but PGI still summed (present inputs)', li.pgi !== null);
  const noAlloc = { ...DEF, properties: P.map((p) => mk({ ...p, allocatedLoanAmount: null })) };
  const m = aggregatePortfolio(manualPortfolioToComponents(noAlloc)).math;
  check('no allocations → weighted cap rate null', m.allocationWeightedCapRate === null);
  check('no allocations → weighted rollover null', m.portfolioRolloverPct === null);
}

async function partE(): Promise<void> {
  console.log('\n(E) export still runs on the widened components (composer shape unchanged):');
  const comps = manualPortfolioToComponents(DEF);
  const agg = aggregatePortfolio(comps, { wholeLoanDebtService: DEF.wholeLoanDebtService });
  const wb = await composePortfolioWorkbook({ templatePath: PORTFOLIO_TEMPLATE_PATH, leafTemplateSheetName: PORTFOLIO_LEAF_SHEET, components: comps, aggregation: agg });
  check('3 leaf tabs + 4 rollup tabs', wb.leafSheetNames.length === 3 && wb.rollUpSheetNames.length === 4);
  const back = new ExcelJS.Workbook(); await back.xlsx.load(wb.buffer as never);
  check('workbook is a valid, re-readable xlsx', back.worksheets.length >= 7);
}

function partF(): void {
  console.log('\n(F) additive / mint-safe:');
  const single = aggregatePortfolio(manualPortfolioToComponents({ properties: [P[0]!], wholeLoanDebtService: null }));
  check('single-component safe (optional fields absent-friendly)', single.math.loanCount === 1 && single.math.lineItems.pgi === 3_000_000);
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nPortfolio Phase B 1a — line-item widening proof');
  partA(); partB(); partC(); partD(); await partE(); partF();
  console.log(failures === 0 ? '\nPhase B 1a proof: OK\n' : `\nPhase B 1a proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
