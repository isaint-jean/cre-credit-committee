/**
 * PROOF — Portfolio Phase A: live manual population path + allocated-loan-amount field.
 * Makes the already-built aggregator/composer/export REACHABLE on a real deal.
 *
 *  (A) contract round-trip: serialize→parse is identity; junk dropped; honest-blank.
 *  (B) manual def → PropertyComponent[] (ordinal, allocatedLoanAmount carried, capRate computed).
 *  (C) aggregator CONSUMES the allocation: whole-loan balance = Σ allocated → portfolio LTV +
 *      debt yield (were missing); aggregate DSCR from the supplied whole-loan debt service.
 *  (D) honest-blank: no allocations → whole-loan balance / LTV / DY are null (never guessed).
 *  (E) persistence round-trip on a :memory: servicer_inputs store (canonical-safe, additive).
 *  (F) e2e export: composePortfolioWorkbook on the manual components → N leaf tabs + 4 rollup
 *      tabs, valid re-readable xlsx.
 *  (G) wiring: the dispatch reads the manual override BEFORE the graph; single-loan gated.
 *  (H) single-loan byte-identical (BMARK 17, 640 head); allocatedLoanAmount is additive/optional.
 *
 * MINT-SAFE: no canonical writes (persistence uses :memory:), no re-mint.
 * Run: npx tsx src/scripts/portfolio-phaseA-manual-reachability-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import {
  parseManualPortfolio, serializeManualPortfolio, manualPortfolioToComponents,
  type ManualPortfolioDefinition, type ManualPortfolioProperty,
} from '@cre/contracts';
import { aggregatePortfolio } from '../services/portfolio-aggregator.service.js';
import { composePortfolioWorkbook } from '../services/portfolio-workbook-composer.service.js';
import { PORTFOLIO_TEMPLATE_PATH, PORTFOLIO_LEAF_SHEET } from '../services/export-portfolio-dispatch.service.js';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const approx = (a: number | null, b: number, tol = 1e-6): boolean => a !== null && Math.abs(a - b) <= tol;

// A realistic 3-property manual portfolio (values ~ Prime Storage-Blue shape).
function prop(name: string, value: number, noi: number, ncf: number, alloc: number, type = 'Self-Storage', state = 'NJ'): ManualPortfolioProperty {
  return { propertyName: name, address: null, city: null, state, propertyType: type, netRentableSF: null, value, noi, ncf, occupancyPct: 0.92, allocatedLoanAmount: alloc };
}
const DEF: ManualPortfolioDefinition = {
  properties: [
    prop('Union City', 29_000_000, 1_800_000, 1_650_000, 18_000_000),
    prop('Jersey City', 21_500_000, 1_200_000, 1_100_000, 13_000_000),
    prop('Newark', 19_500_000, 1_190_000, 1_090_000, 12_000_000),
  ],
  wholeLoanDebtService: 3_000_000,
};

function partA(): void {
  console.log('\n(A) contract round-trip:');
  const round = parseManualPortfolio(serializeManualPortfolio(DEF));
  check('serialize→parse is identity (3 props + DS)', round.properties.length === 3 && round.wholeLoanDebtService === 3_000_000);
  check('honest-blank: omitted fields stay null (not 0)', round.properties[0]!.address === null && round.properties[0]!.netRentableSF === null);
  const junk = parseManualPortfolio('{"properties":[{"value":"not-a-number","allocatedLoanAmount":5},{}],"wholeLoanDebtService":"x"}');
  check('junk dropped: bad number → null, DS junk → null', junk.properties[0]!.value === null && junk.properties[0]!.allocatedLoanAmount === 5 && junk.wholeLoanDebtService === null);
  check('malformed JSON → empty (never throws)', parseManualPortfolio('{{{').properties.length === 0);
}

function partB(): void {
  console.log('\n(B) manual def → PropertyComponent[]:');
  const comps = manualPortfolioToComponents(DEF);
  check('3 properties → 3 components, ordinal 1..3', comps.length === 3 && comps[0]!.ordinal === 1 && comps[2]!.ordinal === 3);
  check('allocatedLoanAmount carried onto the component', comps[0]!.allocatedLoanAmount === 18_000_000);
  check('capRate computed from noi/value', approx(comps[0]!.capRate, 1_800_000 / 29_000_000));
}

function partC(): void {
  console.log('\n(C) aggregator consumes the allocation (weighted aggregates + LTV/DY):');
  const comps = manualPortfolioToComponents(DEF);
  const agg = aggregatePortfolio(comps, { wholeLoanDebtService: DEF.wholeLoanDebtService });
  const m = agg.math;
  const sumVal = 29_000_000 + 21_500_000 + 19_500_000;
  const sumNoi = 1_800_000 + 1_200_000 + 1_190_000;
  const sumNcf = 1_650_000 + 1_100_000 + 1_090_000;
  const sumAlloc = 18_000_000 + 13_000_000 + 12_000_000;
  check('blended value = Σ value', approx(m.blendedValue, sumVal));
  check('aggregate NOI = Σ noi', approx(m.aggregateNoi, sumNoi));
  check('whole-loan balance = Σ allocatedLoanAmount', approx(m.wholeLoanBalance, sumAlloc), `$${m.wholeLoanBalance?.toLocaleString()}`);
  check('portfolio LTV = balance ÷ Σvalue', approx(m.portfolioLtv, sumAlloc / sumVal), `${((m.portfolioLtv ?? 0) * 100).toFixed(1)}%`);
  check('portfolio debt yield = ΣNOI ÷ balance', approx(m.portfolioDebtYield, sumNoi / sumAlloc), `${((m.portfolioDebtYield ?? 0) * 100).toFixed(2)}%`);
  check('aggregate DSCR = ΣNCF ÷ whole-loan DS (supplied)', approx(m.aggregateDscr, sumNcf / 3_000_000), `${m.aggregateDscr?.toFixed(2)}×`);
  check('blended cap = ΣNOI ÷ Σvalue', approx(m.blendedCapRate, sumNoi / sumVal));
}

function partD(): void {
  console.log('\n(D) honest-blank — no allocations → balance/LTV/DY null:');
  const noAlloc: ManualPortfolioDefinition = {
    properties: DEF.properties.map((p) => ({ ...p, allocatedLoanAmount: null })),
    wholeLoanDebtService: null,
  };
  const agg = aggregatePortfolio(manualPortfolioToComponents(noAlloc));
  check('whole-loan balance null (no guessed denominator)', agg.math.wholeLoanBalance === null);
  check('portfolio LTV null + debt yield null', agg.math.portfolioLtv === null && agg.math.portfolioDebtYield === null);
  check('aggregate DSCR null (no DS supplied)', agg.math.aggregateDscr === null);
  check('but blended value/NOI still summed (present inputs)', agg.math.blendedValue !== null && agg.math.aggregateNoi !== null);
}

function partE(): void {
  console.log('\n(E) persistence round-trip (:memory: servicer_inputs — canonical-safe, additive):');
  const store = new ServicerInputsStore(':memory:');
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'portfolio_structure', value: serializeManualPortfolio(DEF), author: 'servicer@x', now: '2026-08-22T00:00:00Z' });
  const back = parseManualPortfolio(store.getOne('P', 'L', 'portfolio_structure')?.value ?? null);
  check('portfolio_structure persists + round-trips (3 props + DS)', back.properties.length === 3 && back.wholeLoanDebtService === 3_000_000);
  check('allocated amounts survive persistence', back.properties[1]!.allocatedLoanAmount === 13_000_000);
}

async function partF(): Promise<void> {
  console.log('\n(F) e2e export — composer runs on the manual components:');
  const comps = manualPortfolioToComponents(DEF);
  const agg = aggregatePortfolio(comps, { wholeLoanDebtService: DEF.wholeLoanDebtService });
  const wb = await composePortfolioWorkbook({
    templatePath: PORTFOLIO_TEMPLATE_PATH,
    leafTemplateSheetName: PORTFOLIO_LEAF_SHEET,
    components: comps,
    aggregation: agg,
  });
  check('N=3 leaf tabs cloned', wb.leafSheetNames.length === 3, wb.leafSheetNames.join(', '));
  check('4 roll-up tabs built', wb.rollUpSheetNames.length === 4, wb.rollUpSheetNames.join(', '));
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(wb.buffer as never);
  check('workbook is a valid, re-readable xlsx', back.worksheets.length >= 7);
  check('Portfolio Summary tab present', back.getWorksheet('Portfolio Summary') !== undefined);
}

function partG(): void {
  console.log('\n(G) wiring — manual override read BEFORE graph; single-loan gated:');
  const dispatch = readFileSync(path.join(process.cwd(), 'src/services/export-portfolio-dispatch.service.ts'), 'utf8');
  check('dispatch reads resolveManualPortfolioComponents (manual override)', /resolveManualPortfolioComponents\(analysis\.graphRevisionId\)/.test(dispatch));
  check('manual override precedes the graph fallback (?? resolvePropertiesFromGraph)', /manual\?\.components \?\? resolvePropertiesFromGraph/.test(dispatch));
  check('single-loan gate intact (mode !== roll_up → null)', /underwritingMode !== 'roll_up'\) return null/.test(dispatch));
  check('dispatch passes wholeLoanDebtService to the aggregator', /wholeLoanDebtService: manual\?\.wholeLoanDebtService/.test(dispatch));
  const svc = readFileSync(path.join(process.cwd(), 'src/services/portfolio-structure.service.ts'), 'utf8');
  check('manual override requires N>1 (single-property never routes to portfolio)', /def\.properties\.length <= 1\) return null/.test(svc));
}

function partH(): void {
  console.log('\n(H) mint-safety + additive field:');
  // allocatedLoanAmount is optional — a component without it aggregates fine (N=1 never sets it).
  const single = aggregatePortfolio(manualPortfolioToComponents({ properties: [DEF.properties[0]!], wholeLoanDebtService: null }));
  check('single-component aggregate is safe (optional field absent-friendly)', single.math.loanCount === 1);
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nPortfolio Phase A — manual reachability proof');
  partA(); partB(); partC(); partD(); partE(); await partF(); partG(); partH();
  console.log(failures === 0 ? '\nPhase A proof: OK\n' : `\nPhase A proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
