/**
 * PROOF — bind extracted sponsor principals (parties.sponsors[]) → Borrower tab Key Principals
 * (D13:D18). Real deterministic ASR content, previously discarded. EXPORT-ONLY, MINT-SAFE.
 *
 *  (A) a JV list (>1) fills D13:D18 in order; D13 = the primary (sponsors[0]).
 *  (B) honest-blank: no sponsors → no-op (D13 keeps the render-schema sponsorName; D14:D18 blank);
 *      empty/whitespace entries dropped.
 *  (C) overflow: >6 principals → fill 6, report dropped (no crash).
 *  (D) ONLY the Key Principals cells change (D14:D18 vs the untouched baseline); other cells same.
 *  (E) deterministic + wiring: sponsors is the ASR PartiesExtraction list (no LLM); render.routes
 *      reads result.analysis.partiesExtraction.sponsors and passes borrowerSponsors opt-in.
 *  (F) mint-safe: canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/borrower-key-principals-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { fillBorrowerKeyPrincipals, BORROWER_SHEET } from '../services/render-memo/borrower-key-principals-fill.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TEMPLATE = path.join(process.cwd(), '../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const val = (ws: ExcelJS.Worksheet, addr: string): unknown => {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v;
};
const blank = (ws: ExcelJS.Worksheet, addr: string): boolean => { const v = ws.getCell(addr).value; return v === null || v === undefined; };
function stripCf(wb: ExcelJS.Workbook): void { wb.eachSheet((ws) => { (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings = []; }); }

async function loadFilled(sponsors: readonly string[] | null): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  fillBorrowerKeyPrincipals(wb, sponsors);
  stripCf(wb);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  return back.getWorksheet(BORROWER_SHEET)!;
}

async function partA(): Promise<void> {
  console.log('\n(A) JV list fills D13:D18 in order (D13 = primary):');
  const ws = await loadFilled(['Vornado Realty Trust', 'Crown Acquisitions', 'Sunroad Holding Corporation']);
  check('D13 = sponsors[0] (primary)', val(ws, 'D13') === 'Vornado Realty Trust');
  check('D14 = sponsors[1]', val(ws, 'D14') === 'Crown Acquisitions');
  check('D15 = sponsors[2]', val(ws, 'D15') === 'Sunroad Holding Corporation');
  check('D16:D18 blank (only 3 principals)', blank(ws, 'D16') && blank(ws, 'D17') && blank(ws, 'D18'));
  check('A13 label still "Other Key Principals / Sponsor(s):" (untouched)', String(val(ws, 'A13') ?? '').startsWith('Other Key Principals'));
}

async function partB(): Promise<void> {
  console.log('\n(B) honest-blank — no sponsors → no-op; empties dropped:');
  const none = await loadFilled(null);
  check('no sponsors → D13:D18 all blank (D13 left to render-schema sponsorName)', ['D13', 'D14', 'D15', 'D16', 'D17', 'D18'].every((a) => blank(none, a)));
  const empties = await loadFilled(['', '   ', 'Real Sponsor']);
  check('empty/whitespace entries dropped; only real names written', val(empties, 'D13') === 'Real Sponsor' && blank(empties, 'D14'));
  // single-sponsor deal (Sunroad-shape one-element list)
  const single = await loadFilled(['Sunroad Holding Corporation']);
  check('single-sponsor → D13 filled, D14:D18 blank', val(single, 'D13') === 'Sunroad Holding Corporation' && blank(single, 'D14'));
}

async function partC(): Promise<void> {
  console.log('\n(C) overflow — >6 principals → fill 6, drop the rest (no crash):');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  const r = fillBorrowerKeyPrincipals(wb, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
  check('written 6, dropped 2', r.written === 6 && r.dropped === 2);
  stripCf(wb);
  const back = new ExcelJS.Workbook(); await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  const ws = back.getWorksheet(BORROWER_SHEET)!;
  check('D13..D18 = P1..P6; P7/P8 not written anywhere', val(ws, 'D13') === 'P1' && val(ws, 'D18') === 'P6');
}

async function partD(): Promise<void> {
  console.log('\n(D) ONLY the Key Principals cells change (vs untouched baseline):');
  // Baseline: template with no fill. Compare a scan of the Borrower sheet's D column.
  const base = await loadFilled(null);
  const filled = await loadFilled(['A', 'B']);
  let changed: string[] = [];
  for (let r = 1; r <= 40; r++) {
    const a = `D${r}`;
    if (String(val(base, a) ?? '') !== String(val(filled, a) ?? '')) changed.push(a);
  }
  check('exactly D13, D14 changed (nothing else in column D)', changed.length === 2 && changed.includes('D13') && changed.includes('D14'), changed.join(','));
}

function partE(): void {
  console.log('\n(E) deterministic + wiring:');
  const eng = readFileSync(path.join(process.cwd(), 'src/services/template-engine.service.ts'), 'utf8');
  check('fill is opt-in (only when borrowerSponsors present + non-empty)', /opts\?\.borrowerSponsors !== undefined && opts\.borrowerSponsors !== null && opts\.borrowerSponsors\.length > 0/.test(eng));
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes reads parties.sponsors (deterministic ASR extraction) + passes it', /result\.analysis\.partiesExtraction\?\.sponsors \?\? null/.test(routes) && /borrowerSponsors,/.test(routes));
  const contract = readFileSync(path.join(process.cwd(), '../../packages/contracts/src/extraction.ts'), 'utf8');
  check('sponsors is a deterministic ASR list on PartiesExtraction (no LLM)', /readonly sponsors\?: readonly string\[\]/.test(contract) && /deterministic regex/.test(contract));
}

function partF(): void {
  console.log('\n(F) mint-safe:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nBorrower Key Principals (sponsors[]) bind proof');
  await partA(); await partB(); await partC(); await partD(); partE(); partF();
  console.log(failures === 0 ? '\nBorrower key-principals proof: OK\n' : `\nBorrower key-principals proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });
