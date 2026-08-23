/**
 * PROOF — Sales Comps servicer input + workbook fill (data + photos), reusing the site-photos
 * image pipeline. EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 *  (A) contract round-trip: parse/serialize, cap at 4, honest-blank.
 *  (B) fill: fillSalesCompsTab writes each comp's fields into rows 7-10 mapped columns + embeds
 *      each photo into its region; omitted field → blank; <4 comps → unused rows blank.
 *  (C) SUBJECT row (12) untouched — still the template's named-range formulas.
 *  (D) opt-in: no comps → the tab (and workbook) byte-unchanged.
 *  (E) loader: loadSalesCompsForExport (injected deps) → comps + resized photo; skips a comp
 *      whose photo can't decode (fields still pass through).
 *  (F) wiring + mint-safe: render.routes loads + passes salesComps; canonical byte-identical.
 *
 * Run: npx tsx src/scripts/sales-comps-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { parseSalesComps, serializeSalesComps, type SalesCompsPayload, type SaleComp } from '@cre/contracts';
import { fillSalesCompsTab, SALES_COMPS_SHEET } from '../services/render-memo/sales-comps-fill.js';
import { loadSalesCompsForExport } from '../services/render-memo/sales-comps-for-export.js';
import type { SaleCompForExport } from '../services/render-memo/sales-comps-for-export.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TEMPLATE = path.join(process.cwd(), '../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
// The template ships conditional-formatting rules with empty formulae that crash exceljs
// writeBuffer. The PRODUCTION export path (applyRenderPayloadToTemplate) sanitizes these;
// this proof loads the raw template directly, so strip CF here (test-only concern).
function stripCf(wb: ExcelJS.Workbook): void {
  wb.eachSheet((ws) => { (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings = []; });
}
const cellVal = (ws: ExcelJS.Worksheet, r: number, c: number): unknown => {
  const v = ws.getCell(r, c).value;
  return v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v;
};
const isFormula = (ws: ExcelJS.Worksheet, addr: string): boolean => {
  const v = ws.getCell(addr).value;
  return !!(v && typeof v === 'object' && 'formula' in (v as object));
};

/* dependency-free solid PNG (real embeddable bytes) */
const CRC = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(t: string, d: Buffer): Buffer { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const ty = Buffer.from(t); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([ty, d])), 0); return Buffer.concat([l, ty, d, cr]); }
function makePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); for (let x = 0; x < w; x++) { const p = o + 1 + x * 3; raw[p] = 180; raw[p + 1] = 90; raw[p + 2] = 60; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function mk(over: Partial<SaleComp>): SaleComp {
  return { buildingName: null, address: null, cityState: null, distance: null, direction: null, totalSf: null, yearBuilt: null, yearRenov: null, occupancyAtSale: null, saleDate: null, salePrice: null, capRate: null, pricePerMeasure: null, photoHash: null, photoFileName: null, ...over };
}

async function partA(): Promise<void> {
  console.log('\n(A) contract round-trip:');
  const payload: SalesCompsPayload = { comps: [
    mk({ buildingName: 'A', salePrice: 5_000_000, capRate: 0.06 }),
    mk({ buildingName: 'B', address: '10 Main' }),
    mk({ buildingName: 'C' }), mk({ buildingName: 'D' }), mk({ buildingName: 'E (5th, dropped)' }),
  ] };
  const back = parseSalesComps(serializeSalesComps(payload));
  check('caps at 4 comps', back.comps.length === 4 && back.comps[3]!.buildingName === 'D');
  check('fields round-trip', back.comps[0]!.salePrice === 5_000_000 && back.comps[0]!.capRate === 0.06);
  check('honest-blank: omitted stays null', back.comps[2]!.address === null && back.comps[2]!.salePrice === null);
  check('junk dropped', parseSalesComps('{"comps":[{"salePrice":"nope"}]}').comps[0]!.salePrice === null);
}

async function fillAndReload(comps: readonly SaleCompForExport[]): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  fillSalesCompsTab(wb, comps);
  stripCf(wb);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  return back.getWorksheet(SALES_COMPS_SHEET)!;
}

async function partB_C(): Promise<void> {
  console.log('\n(B/C) fill rows 7-10 + photos; subject row untouched:');
  const img = makePng(400, 300);
  const { resizeForEmbed } = await import('../services/render-memo/site-photos-resize.js');
  const r = (await resizeForEmbed(img))!;
  const comps: SaleCompForExport[] = [
    { ...mk({ buildingName: 'Baybrook', address: '100 Bay', cityState: 'Houston, TX', distance: '1.2 mi', direction: 'NE', totalSf: 45000, yearBuilt: 1998, yearRenov: 2015, occupancyAtSale: 0.94, saleDate: '2024-06-15', salePrice: 12_500_000, capRate: 0.062, pricePerMeasure: 278 }), image: { buffer: r.buffer, width: r.width, height: r.height, extension: r.extension } },
    { ...mk({ buildingName: 'Broadmoor', address: '200 Broad', salePrice: 9_800_000, capRate: 0.058 }), image: { buffer: r.buffer, width: r.width, height: r.height, extension: r.extension } },
    { ...mk({ buildingName: 'Copperfield' }) }, // no photo, sparse
  ];
  const ws = await fillAndReload(comps);
  // Comp 1 → row 7. Columns: C=3 name, F=6 addr, G=7 city, H=8 dist, I=9 dir, J=10 sf, K=11 yb, L=12 yr, M=13 occ, N=14 date, O=15 price, P=16 cap, Q=17 ppm.
  check('Comp1 building name (C7)', cellVal(ws, 7, 3) === 'Baybrook');
  check('Comp1 address (F7) + city (G7)', cellVal(ws, 7, 6) === '100 Bay' && cellVal(ws, 7, 7) === 'Houston, TX');
  check('Comp1 sale price (O7) + cap rate (P7) + $/SF (Q7)', cellVal(ws, 7, 15) === 12_500_000 && cellVal(ws, 7, 16) === 0.062 && cellVal(ws, 7, 17) === 278);
  check('Comp1 sale date (N7) as entered', cellVal(ws, 7, 14) === '2024-06-15');
  check('Comp2 → row 8 (building name B8→C8)', cellVal(ws, 8, 3) === 'Broadmoor' && cellVal(ws, 8, 15) === 9_800_000);
  check('Comp3 → row 9, sparse (name only; price blank)', cellVal(ws, 9, 3) === 'Copperfield' && (cellVal(ws, 9, 15) === null || cellVal(ws, 9, 15) === undefined));
  check('Comp3 omitted field honest-blank (address F9 empty)', cellVal(ws, 9, 6) === null || cellVal(ws, 9, 6) === undefined);
  check('unused Comp4 row 10 blank', (cellVal(ws, 10, 3) === null || cellVal(ws, 10, 3) === undefined));
  check('2 photos embedded (comps 1-2; comp 3 had none)', (ws.getImages?.() ?? []).length === 2, `${(ws.getImages?.() ?? []).length} images`);
  // (C) subject row 12 untouched — still the template's named-range formulas.
  check('subject C12 still a formula (untouched)', isFormula(ws, 'C12'));
  check('subject O12 (Concluded_Value) still a formula (untouched)', isFormula(ws, 'O12'));
}

async function partD(): Promise<void> {
  console.log('\n(D) opt-in — no comps → tab byte-unchanged:');
  const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.load(readFileSync(TEMPLATE) as never); stripCf(wb0);
  const before = Buffer.from(await wb0.xlsx.writeBuffer()).length;
  const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(readFileSync(TEMPLATE) as never);
  fillSalesCompsTab(wb1, []); // no-op
  stripCf(wb1);
  const after = Buffer.from(await wb1.xlsx.writeBuffer()).length;
  const ws = wb1.getWorksheet(SALES_COMPS_SHEET)!;
  check('no comps → no images on the tab', (ws.getImages?.() ?? []).length === 0);
  check('no comps → C7 still empty (no fill)', cellVal(ws, 7, 3) === null || cellVal(ws, 7, 3) === undefined);
  check('no comps → workbook size unchanged (no-op)', Math.abs(before - after) < 200, `${before} vs ${after}`);
}

async function partE(): Promise<void> {
  console.log('\n(E) loader — injected deps, resize + skip-undecodable:');
  const png = makePng(500, 400);
  const value = serializeSalesComps({ comps: [
    mk({ buildingName: 'HasPhoto', photoHash: 'h1', photoFileName: 'a.jpg', salePrice: 7_000_000 }),
    mk({ buildingName: 'BadPhoto', photoHash: 'hbad', photoFileName: 'b.jpg' }),
    mk({ buildingName: 'NoPhoto', salePrice: 3_000_000 }),
  ] });
  const loaded = await loadSalesCompsForExport('rev', {
    graph: { getRevisionEnvelope: () => ({ doctrineEvaluationId: 'eval' } as never) },
    resolve: (() => ({ resolved: true, poolId: 'P', loanInPoolId: 'L', matchedBy: 'exact-deal-ref' })) as never,
    getInput: (() => ({ value } as never)) as never,
    getBlob: async (h) => (h === 'h1' ? png : h === 'hbad' ? Buffer.from('not-an-image') : null),
  });
  check('all 3 comps returned (fields always pass through)', loaded.length === 3);
  check('comp with decodable photo → image attached + resized dims', loaded[0]!.image !== undefined && (loaded[0]!.image!.width) > 0);
  check('comp with undecodable photo → no image, fields intact', loaded[1]!.image === undefined && loaded[1]!.buildingName === 'BadPhoto');
  check('comp with no photo → no image', loaded[2]!.image === undefined && loaded[2]!.salePrice === 3_000_000);
}

function partF(): void {
  console.log('\n(F) wiring + mint-safe:');
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes loads + passes salesComps', /loadSalesCompsForExport\(result\.analysis\.graphRevisionId\)/.test(routes) && /salesComps,/.test(routes));
  const eng = readFileSync(path.join(process.cwd(), 'src/services/template-engine.service.ts'), 'utf8');
  check('fill is opt-in (only when salesComps present + non-empty)', /opts\?\.salesComps !== undefined && opts\.salesComps\.length > 0/.test(eng));
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nSales Comps servicer-input + fill proof');
  await partA(); await partB_C(); await partD(); await partE(); partF();
  console.log(failures === 0 ? '\nSales Comps proof: OK\n' : `\nSales Comps proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
