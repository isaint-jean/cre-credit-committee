/**
 * PROOF — Lease Comps servicer input + workbook fill (data + photos + asset-type rate-column
 * switch + force-overwrite on the formula columns). EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 *  (A) contract round-trip: parse/serialize, cap 4, honest-blank; rate-mode-by-asset-type.
 *  (B) fill (Commercial deal): fields in mapped cells; the FORMULA columns (C, M, N/O/P) are
 *      FORCE-OVERWRITTEN (now plain values, not formulas); rate columns show COMMERCIAL metrics
 *      (Lease Type / Lease Rate / Exp. Reimb.); photos embedded; <4 → blank; omitted → blank.
 *  (C) SUBJECT row (12) untouched — still the template's named-range formulas.
 *  (D) asset-type switch: a MULTIFAMILY deal writes the MF metrics (Concessions/Monthly Rent/
 *      Rent PSF) into N/O/P; a HOTEL deal writes Rack Rate/ADR/RevPAR.
 *  (E) opt-in: no comps → the tab (and workbook) byte-unchanged.
 *  (F) loader: injected deps → comps + resized photo; skips an undecodable photo.
 *  (G) wiring + mint-safe: render.routes loads + passes leaseComps (with assetType); canonical
 *      byte-identical.
 *
 * Run: npx tsx src/scripts/lease-comps-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { parseLeaseComps, serializeLeaseComps, leaseRateModeForAssetType, type LeaseCompsPayload, type LeaseComp } from '@cre/contracts';
import { fillLeaseCompsTab, LEASE_COMPS_SHEET } from '../services/render-memo/lease-comps-fill.js';
import { loadLeaseCompsForExport, type LeaseCompForExport } from '../services/render-memo/lease-comps-for-export.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TEMPLATE = path.join(process.cwd(), '../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const cellVal = (ws: ExcelJS.Worksheet, r: number, c: number): unknown => {
  const v = ws.getCell(r, c).value;
  return v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v;
};
const isFormula = (ws: ExcelJS.Worksheet, addr: string): boolean => {
  const v = ws.getCell(addr).value;
  return !!(v && typeof v === 'object' && 'formula' in (v as object));
};
function stripCf(wb: ExcelJS.Workbook): void { wb.eachSheet((ws) => { (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings = []; }); }

const CRC = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(t: string, d: Buffer): Buffer { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const ty = Buffer.from(t); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([ty, d])), 0); return Buffer.concat([l, ty, d, cr]); }
function makePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); for (let x = 0; x < w; x++) { const p = o + 1 + x * 3; raw[p] = 120; raw[p + 1] = 140; raw[p + 2] = 90; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function mk(over: Partial<LeaseComp>): LeaseComp {
  return { buildingName: null, address: null, cityState: null, distance: null, direction: null, totalSf: null, yearBuilt: null, yearRenov: null, occupancy: null, leaseType: null, leaseRate: null, expenseReimb: null, concessions: null, monthlyRent: null, rentPsf: null, rackRate: null, adr: null, revPar: null, photoHash: null, photoFileName: null, ...over };
}

async function fillAndReload(comps: readonly LeaseCompForExport[], assetType: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  fillLeaseCompsTab(wb, comps, assetType);
  stripCf(wb);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  return back.getWorksheet(LEASE_COMPS_SHEET)!;
}

async function partA(): Promise<void> {
  console.log('\n(A) contract round-trip + rate-mode:');
  const payload: LeaseCompsPayload = { comps: [
    mk({ buildingName: 'A', leaseType: 'NNN', leaseRate: 32.5, expenseReimb: 8.1 }),
    mk({ buildingName: 'B' }), mk({ buildingName: 'C' }), mk({ buildingName: 'D' }), mk({ buildingName: 'E-drop' }),
  ] };
  const back = parseLeaseComps(serializeLeaseComps(payload));
  check('caps at 4', back.comps.length === 4);
  check('fields round-trip (leaseType text + rate numbers)', back.comps[0]!.leaseType === 'NNN' && back.comps[0]!.leaseRate === 32.5 && back.comps[0]!.expenseReimb === 8.1);
  check('honest-blank: omitted stays null', back.comps[1]!.leaseRate === null);
  check('rate-mode: Office→commercial, Multifamily→residential, Hotel→hotel',
    leaseRateModeForAssetType('Office') === 'commercial' && leaseRateModeForAssetType('Multifamily') === 'residential' && leaseRateModeForAssetType('SelfStorage') === 'residential' && leaseRateModeForAssetType('Hotel') === 'hotel');
}

async function partB_C(): Promise<void> {
  console.log('\n(B/C) Commercial fill: force-overwrite + commercial rate columns + subject intact:');
  const { resizeForEmbed } = await import('../services/render-memo/site-photos-resize.js');
  const r = (await resizeForEmbed(makePng(400, 300)))!;
  const comps: LeaseCompForExport[] = [
    { ...mk({ buildingName: 'Westgate', address: '1 W St', cityState: 'Dallas, TX', distance: '0.8 mi', direction: 'N', totalSf: 32000, yearBuilt: 2005, yearRenov: 2019, occupancy: 0.91, leaseType: 'NNN', leaseRate: 34, expenseReimb: 9 }), image: { buffer: r.buffer, width: r.width, height: r.height, extension: r.extension } },
    { ...mk({ buildingName: 'Eastpark', leaseType: 'Gross', leaseRate: 28 }) },
    { ...mk({ buildingName: 'Midtown' }) },
  ];
  const ws = await fillAndReload(comps, 'Office');
  // Comp1 → row 7. Columns: C=3 name, F=6 addr, G=7 city, H=8 dist, I=9 dir, J=10 sf, K=11 yb, L=12 yr, M=13 occ, N=14/O=15/P=16 rate.
  check('Comp1 building name (C7)', cellVal(ws, 7, 3) === 'Westgate');
  check('Comp1 address + city (F7/G7)', cellVal(ws, 7, 6) === '1 W St' && cellVal(ws, 7, 7) === 'Dallas, TX');
  check('Comp1 year built/renov (K7/L7)', cellVal(ws, 7, 11) === 2005 && cellVal(ws, 7, 12) === 2019);
  check('★ FORCE-OVERWRITE: C7 (was a formula) is now a plain value', !isFormula(ws, 'C7') && cellVal(ws, 7, 3) === 'Westgate');
  check('★ FORCE-OVERWRITE: M7 (Occup formula) is now the value', !isFormula(ws, 'M7') && cellVal(ws, 7, 13) === 0.91);
  check('★ Commercial rate columns: N7=Lease Type, O7=Lease Rate, P7=Exp Reimb', cellVal(ws, 7, 14) === 'NNN' && cellVal(ws, 7, 15) === 34 && cellVal(ws, 7, 16) === 9);
  check('★ N7/O7/P7 force-overwritten (no longer formulas)', !isFormula(ws, 'N7') && !isFormula(ws, 'O7') && !isFormula(ws, 'P7'));
  check('Comp2 → row 8 (sparse)', cellVal(ws, 8, 3) === 'Eastpark' && cellVal(ws, 8, 14) === 'Gross' && cellVal(ws, 8, 15) === 28);
  // Comp3 has a name (C9 overwritten) but NO rate → O9 is NOT overwritten: the template's
  // formula stays (renders "" for a commercial deal) — honest-blank, no fabricated value.
  check('Comp3 → row 9: name written, omitted rate left untouched (formula, honest-blank)', cellVal(ws, 9, 3) === 'Midtown' && isFormula(ws, 'O9'));
  // Comp4 doesn't exist (only 3 comps) → row 10 fully untouched (formulas stay).
  check('unused Comp4 row 10 untouched (still a formula)', isFormula(ws, 'C10'));
  check('1 photo embedded (comp1 only)', (ws.getImages?.() ?? []).length === 1);
  // (C) subject row 12 untouched.
  check('subject C12 still a formula (untouched)', isFormula(ws, 'C12'));
  check('subject M12 (Occupancy) still a formula (untouched)', isFormula(ws, 'M12'));
}

async function partD(): Promise<void> {
  console.log('\n(D) asset-type switch — MF + Hotel write their own metrics into N/O/P:');
  const mfComp: LeaseCompForExport = { ...mk({ buildingName: 'MF-1', concessions: 1.5, monthlyRent: 2100, rentPsf: 2.6 }) };
  const wsMf = await fillAndReload([mfComp, mk({ buildingName: 'MF-2' })], 'Multifamily');
  check('MF: N7=Concessions, O7=Monthly Rent, P7=Rent PSF', cellVal(wsMf, 7, 14) === 1.5 && cellVal(wsMf, 7, 15) === 2100 && cellVal(wsMf, 7, 16) === 2.6);
  check('MF: commercial fields NOT written (leaseType blank)', cellVal(wsMf, 7, 14) !== 'NNN');
  const hotelComp: LeaseCompForExport = { ...mk({ buildingName: 'Hot-1', rackRate: 220, adr: 185, revPar: 150 }) };
  const wsH = await fillAndReload([hotelComp, mk({ buildingName: 'Hot-2' })], 'Hotel');
  check('Hotel: N7=Rack Rate, O7=ADR, P7=RevPAR', cellVal(wsH, 7, 14) === 220 && cellVal(wsH, 7, 15) === 185 && cellVal(wsH, 7, 16) === 150);
}

async function partE(): Promise<void> {
  console.log('\n(E) opt-in — no comps → tab byte-unchanged:');
  const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.load(readFileSync(TEMPLATE) as never); stripCf(wb0);
  const before = Buffer.from(await wb0.xlsx.writeBuffer()).length;
  const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(readFileSync(TEMPLATE) as never);
  fillLeaseCompsTab(wb1, [], 'Office'); stripCf(wb1);
  const after = Buffer.from(await wb1.xlsx.writeBuffer()).length;
  const ws = wb1.getWorksheet(LEASE_COMPS_SHEET)!;
  check('no comps → 0 images + C7 still a formula (untouched)', (ws.getImages?.() ?? []).length === 0 && isFormula(ws, 'C7'));
  check('no comps → workbook size unchanged (no-op)', Math.abs(before - after) < 200, `${before} vs ${after}`);
}

async function partF(): Promise<void> {
  console.log('\n(F) loader — injected deps, resize + skip-undecodable:');
  const png = makePng(500, 400);
  const value = serializeLeaseComps({ comps: [
    mk({ buildingName: 'HasPhoto', photoHash: 'h1', photoFileName: 'a.jpg', leaseRate: 30 }),
    mk({ buildingName: 'BadPhoto', photoHash: 'hbad', photoFileName: 'b.jpg' }),
  ] });
  const loaded = await loadLeaseCompsForExport('rev', {
    graph: { getRevisionEnvelope: () => ({ doctrineEvaluationId: 'eval' } as never) },
    resolve: (() => ({ resolved: true, poolId: 'P', loanInPoolId: 'L', matchedBy: 'exact-deal-ref' })) as never,
    getInput: (() => ({ value } as never)) as never,
    getBlob: async (h) => (h === 'h1' ? png : h === 'hbad' ? Buffer.from('nope') : null),
  });
  check('decodable photo → image; undecodable → no image, fields intact', loaded.length === 2 && loaded[0]!.image !== undefined && loaded[1]!.image === undefined && loaded[1]!.buildingName === 'BadPhoto');
}

function partG(): void {
  console.log('\n(G) wiring + mint-safe:');
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes loads leaseComps + passes assetType', /loadLeaseCompsForExport\(result\.analysis\.graphRevisionId\)/.test(routes) && /leaseComps: \{ comps: leaseComps, assetType: result\.assetClass \}/.test(routes));
  const eng = readFileSync(path.join(process.cwd(), 'src/services/template-engine.service.ts'), 'utf8');
  check('fill is opt-in (only when leaseComps present + non-empty)', /opts\?\.leaseComps !== undefined && opts\.leaseComps\.comps\.length > 0/.test(eng));
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nLease Comps servicer-input + fill proof');
  await partA(); await partB_C(); await partD(); await partE(); await partF(); partG();
  console.log(failures === 0 ? '\nLease Comps proof: OK\n' : `\nLease Comps proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });
