/**
 * PROOF — site-photos Chunk 2: the "Site Photos" worksheet with an empty anchor grid.
 * Exercises the REAL export path (GET /api/underwriting/export → applyRenderPayloadToTemplate).
 * EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 * Gates:
 *  (A) anchor helper: sitePhotoBoxAnchors(N) → N boxes, 2 per row, non-overlapping, rows grow
 *      (verified N=4/8/16).
 *  (B) the export now has a "Site Photos" sheet — header ("Site Photos — <deal>"), 8 "Photo N"
 *      captions, empty bordered boxes, and NO images on the sheet (Chunk 2).
 *  (C) the rest of the workbook is UNCHANGED — sheet count 29 → 30 (only Site Photos added);
 *      Operating-History Column H still populated (H17 = 6,899,325), Rent Roll intact, and the
 *      original 29 sheets are all still present.
 *  (D) MINT-SAFE: no re-mint (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/site-photos-chunk2-proof.ts   (from apps/api)
 */
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { renderRoutes } from '../routes/render.routes.js';
import { sitePhotoBoxAnchors, SITE_PHOTOS_SHEET } from '../services/render-memo/site-photos-grid.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const DB = path.join(process.cwd(), 'data', 'cre.db');
const SUNROAD = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00';

function num(cell: ExcelJS.Cell): number | null {
  const v: unknown = cell.value;
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'number') return (v as { result: number }).result;
  return null;
}

async function exportWb(): Promise<ExcelJS.Workbook | null> {
  const app = express();
  app.use('/api/underwriting', renderRoutes);
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const qs = new URLSearchParams({ dealId: SUNROAD, assetClass: 'office', underwritingMode: 'single_loan', profile: 'bp_spire', templateType: 'single_loan' });
  const res = await fetch(`http://127.0.0.1:${port}/api/underwriting/export?${qs.toString()}`);
  if (!res.ok) { server.close(); return null; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  server.close();
  return wb;
}

function partA(): void {
  console.log('\n(A) anchor helper — 2 per row, non-overlapping, rows grow:');
  const a4 = sitePhotoBoxAnchors(4);
  check('N=4 → 4 boxes', a4.length === 4);
  check('boxes 0,1 share a row; 2,3 the next row', a4[0]!.tlRow === a4[1]!.tlRow && a4[2]!.tlRow === a4[3]!.tlRow && a4[2]!.tlRow > a4[0]!.tlRow);
  check('two columns (box0 left, box1 right, no overlap)', a4[0]!.tlCol === 1 && a4[1]!.tlCol > a4[0]!.brCol);
  check('N=8 → 8 boxes, N=16 → 16 boxes', sitePhotoBoxAnchors(8).length === 8 && sitePhotoBoxAnchors(16).length === 16);
  const a16 = sitePhotoBoxAnchors(16);
  const overlap = a16.some((b, i) => a16.some((c, j) => i !== j && b.tlRow <= c.brRow && c.tlRow <= b.brRow && b.tlCol <= c.brCol && c.tlCol <= b.brCol));
  check('no two boxes overlap (N=16)', !overlap);
}

async function partB_C(): Promise<void> {
  console.log('\n(B/C) export — Site Photos sheet added, rest unchanged:');
  const wb = await exportWb();
  check('export succeeded', wb !== null);
  if (wb === null) return;

  check('sheet count is 30 (was 29 — only Site Photos added)', wb.worksheets.length === 30, `${wb.worksheets.length} sheets`);
  const sp = wb.getWorksheet(SITE_PHOTOS_SHEET);
  check('"Site Photos" sheet present', sp !== undefined);
  if (sp !== undefined) {
    check('header names the deal', /^Site Photos — .+/.test(String(sp.getCell('A1').value)), String(sp.getCell('A1').value));
    check('"Photo 1" + "Photo 8" captions present', String(sp.getCell(3, 1).value) === 'Photo 1' && sitePhotoBoxAnchors(8).some((b) => String(sp.getCell(b.captionRow, b.captionCol).value) === 'Photo 8'));
    let imgs = 0; try { imgs = (sp.getImages?.() ?? []).length; } catch { /* none */ }
    check('NO images on the Site Photos sheet (Chunk 2, empty grid)', imgs === 0, `${imgs} images`);
  }

  // rest unchanged
  const names = wb.worksheets.map((w) => w.name).filter((n) => n !== SITE_PHOTOS_SHEET);
  check('the 29 original sheets are all still present', names.length === 29);
  for (const expected of ['Property & Loan Summary', 'Operating History and Pro Forma', 'Rent Roll', 'Conclusions & Escrows']) {
    check(`original sheet "${expected}" present`, names.includes(expected));
  }
  const oh = wb.getWorksheet('Operating History and Pro Forma')!;
  check('Operating History H17 still populated (6,899,325 — existing tab unchanged)', Math.abs((num(oh.getCell('H17')) ?? 0) - 6899325) <= 1);
  let rr = 0; wb.getWorksheet('Rent Roll')?.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, () => { rr++; }));
  check('Rent Roll intact (>100k non-empty cells)', rr > 100000, `${rr} cells`);
}

function partD(): void {
  console.log('\n(D) mint-safe (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nSite-photos Chunk 2 proof (real export path)');
  partA(); await partB_C(); partD();
  console.log(failures === 0 ? '\nsite-photos Chunk 2 proof: OK\n' : `\nsite-photos Chunk 2 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
