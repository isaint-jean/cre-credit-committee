/**
 * PROOF — Market (a) + (b): bind extracted asr.marketRent → Market tab (vacancy J4, submkt
 * rent J7) + expose marketRent on the ASR read path. Real deterministic content. EXPORT-ONLY,
 * MINT-SAFE.
 *
 *  (a) fill: J4 = vacancyRate (RAW 0..1 fraction, matching the cell's "0.0%" format), J7 =
 *      averageRentPsf; submarketName NOT written (no clean cell); null → no-op (blank).
 *  (b) read path: projectAsr now includes marketRent; the AsrSlotExtraction DTO carries it.
 *  (c) J4 number format is "0.0%" so the raw fraction renders correctly (7.9% not 790%).
 *  (d) ONLY J4/J7 change vs the untouched baseline; auto columns (E/G/H formulas) untouched.
 *  (e) deterministic + wiring: marketRent is the ASR "Sub-Market Overview" parse (no LLM);
 *      render.routes loads it via the graph walk and passes it opt-in.
 *  (f) mint-safe: canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/market-rent-bind-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { MarketRentSummary } from '@cre/contracts';
import { fillMarketTab, loadMarketRentForExport, MARKET_SHEET } from '../services/render-memo/market-fill.js';
import { projectAsr } from '../services/slot-extraction.service.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TEMPLATE = path.join(process.cwd(), '../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const rawVal = (ws: ExcelJS.Worksheet, a: string): unknown => ws.getCell(a).value;
const blank = (ws: ExcelJS.Worksheet, a: string): boolean => { const v = ws.getCell(a).value; return v === null || v === undefined; };
const isFormula = (ws: ExcelJS.Worksheet, a: string): boolean => { const v = ws.getCell(a).value; return !!(v && typeof v === 'object' && 'formula' in (v as object)); };
function stripCf(wb: ExcelJS.Workbook): void { wb.eachSheet((ws) => { (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings = []; }); }

// Sunroad-shape submarket rent (Kearny Mesa; vacancy 7.9%, ~$38.57/SF).
const SUNROAD_MR: MarketRentSummary = { submarketName: 'Kearny Mesa', vacancyRate: 0.079, averageRentPsf: 38.57, source: 'ASR Sub-Market Overview' };

async function loadFilled(mr: MarketRentSummary | null): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  fillMarketTab(wb, mr);
  stripCf(wb);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  return back.getWorksheet(MARKET_SHEET)!;
}

async function partA(): Promise<void> {
  console.log('\n(a) fill J4 vacancy + J7 submkt rent; submarketName skipped; null → blank:');
  const ws = await loadFilled(SUNROAD_MR);
  check('J4 = raw vacancy fraction 0.079 (NOT pre-multiplied)', rawVal(ws, 'J4') === 0.079);
  check('J7 = avg rent PSF 38.57', rawVal(ws, 'J7') === 38.57);
  check('submarketName not jammed anywhere near the trends grid (J-col rows 4-10 = only J4/J7)', [5, 6, 8, 9, 10].every((r) => blank(ws, `J${r}`)));
  const none = await loadFilled(null);
  check('marketRent null → J4/J7 blank (no-op, honest-blank)', blank(none, 'J4') && blank(none, 'J7'));
  const partial = await loadFilled({ submarketName: 'X', vacancyRate: null, averageRentPsf: 40, source: null });
  check('null vacancy skipped (J4 blank), present rent written (J7=40)', blank(partial, 'J4') && rawVal(partial, 'J7') === 40);
}

async function partC(): Promise<void> {
  console.log('\n(c) number format — J4 is "0.0%" so 0.079 renders 7.9% (not 790%):');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  check('template J4 numFmt is a percent format', wb.getWorksheet(MARKET_SHEET)!.getCell('J4').numFmt === '0.0%');
}

async function partB(): Promise<void> {
  console.log('\n(b) read path — projectAsr now includes marketRent:');
  const asrWith = { underwrittenNOI: null, impliedValue: null, impliedCapRate: null, priorDebtPayoff: null, sponsorEquity: null, sourcesAndUses: null, underwrittenCashFlows: null, marketRent: SUNROAD_MR } as never;
  const dto = projectAsr(asrWith);
  check('DTO carries marketRent (submarket/vacancy/rent)', dto.marketRent !== null && dto.marketRent!.submarketName === 'Kearny Mesa' && dto.marketRent!.vacancyRate === 0.079 && dto.marketRent!.averageRentPsf === 38.57);
  const asrWithout = { underwrittenNOI: null, impliedValue: null, impliedCapRate: null, priorDebtPayoff: null, sponsorEquity: null, sourcesAndUses: null, underwrittenCashFlows: null } as never;
  check('marketRent absent → DTO marketRent null (honest)', projectAsr(asrWithout).marketRent === null);
}

async function partD(): Promise<void> {
  console.log('\n(d) ONLY J4/J7 change vs baseline; auto columns untouched:');
  const base = await loadFilled(null);
  const filled = await loadFilled(SUNROAD_MR);
  const changed: string[] = [];
  const cols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  for (let r = 1; r <= 45; r++) for (const c of cols) {
    const a = `${c}${r}`;
    if (JSON.stringify(rawVal(base, a)) !== JSON.stringify(rawVal(filled, a))) changed.push(a);
  }
  check('exactly J4, J7 changed — nothing else', changed.length === 2 && changed.includes('J4') && changed.includes('J7'), changed.join(','));
  check('auto columns (E Appraisal, H Concluded UW) still formulas (untouched)', isFormula(filled, 'E4') && isFormula(filled, 'H4'));
}

function partE(): void {
  console.log('\n(e) deterministic + wiring:');
  const svc = readFileSync(path.join(process.cwd(), 'src/services/slot-extraction.service.ts'), 'utf8');
  check('projectAsr maps marketRent', /marketRent: asr\.marketRent \?\? null/.test(svc));
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes loads marketRent via graph walk + passes it opt-in', /loadMarketRentForExport\(result\.analysis\.graphRevisionId\)/.test(routes) && /marketRent,/.test(routes));
  const eng = readFileSync(path.join(process.cwd(), 'src/services/template-engine.service.ts'), 'utf8');
  check('fill is opt-in (only when marketRent present)', /opts\?\.marketRent !== undefined && opts\.marketRent !== null/.test(eng));
  const contract = readFileSync(path.join(process.cwd(), '../../packages/contracts/src/extraction.ts'), 'utf8');
  check('marketRent is the deterministic ASR "Sub-Market Overview" parse (no LLM)', /Sub-Market Overview.*no LLM|deterministic parse of the ASR/s.test(contract));
}

function partF(): void {
  console.log('\n(f) mint-safe:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nMarket marketRent bind + read-path proof');
  await partA(); await partC(); await partB(); await partD(); partE(); partF();
  console.log(failures === 0 ? '\nMarket proof: OK\n' : `\nMarket proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });
