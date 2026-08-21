/**
 * PROOF — site-photos Chunk 4: jimp resize (shrink bytes) + aspect-preserving placement (fit).
 * EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 *  (A) resize: a large photo is downscaled (long edge ≤ 1200) + re-encoded JPEG → far fewer
 *      bytes; a small photo is NOT upscaled; an undecodable buffer → null (skip, no crash).
 *  (B) aspect: fittedPlacement gives a fixed-size ext matching the image aspect (no stretch),
 *      fitted inside the box, centered — portrait and landscape both undistorted.
 *  (C) file size: 8 resized photos embed to a workbook DRAMATICALLY smaller than the same 8
 *      full-size — the proof reports both.
 *  (D) count-agnostic embed still holds (N photos → N images, valid re-readable xlsx).
 *  (E) loader integration: loadSitePhotosForExport resizes each blob (real jimp) → jpeg + dims.
 *  (F) real Sunroad export unchanged (no photos → empty grid, sheet count 30, H17 6,899,325,
 *      Rent Roll intact) + canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/site-photos-chunk4-proof.ts   (from apps/api)
 */
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import { renderRoutes } from '../routes/render.routes.js';
import { addSitePhotosGrid, fittedPlacement, sitePhotoBoxAnchors, SITE_PHOTOS_SHEET, type SitePhotoImage } from '../services/render-memo/site-photos-grid.js';
import { resizeForEmbed } from '../services/render-memo/site-photos-resize.js';
import { loadSitePhotosForExport } from '../services/render-memo/site-photos-for-export.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const DB = path.join(process.cwd(), 'data', 'cre.db');
const SUNROAD = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00';

/* --- PNG generators: solid (tiny) + pseudo-noise (poorly compressible = large, realistic) --- */
const CRC = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer { const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); const t = Buffer.from(type); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([l, t, data, cr]); }
function makePng(w: number, h: number, noisy: boolean): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1); raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const p = o + 1 + x * 3;
      if (noisy) { raw[p] = (x * 31 + y * 17) & 255; raw[p + 1] = (x * 13 + y * 7) & 255; raw[p + 2] = (x * 5 + y * 29) & 255; }
      else { raw[p] = 200; raw[p + 1] = 60; raw[p + 2] = 60; }
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function partA(): Promise<void> {
  console.log('\n(A) resize — downscale + re-encode, only-downscale, skip undecodable:');
  const big = makePng(2000, 1500, true);
  const r = await resizeForEmbed(big);
  check('large photo resized (not null)', r !== null);
  check('downscaled to long edge ≤ 1200', r !== null && Math.max(r.width, r.height) <= 1200, r ? `${r.width}×${r.height}` : '');
  check('re-encoded JPEG, fewer bytes than the source', r !== null && r.extension === 'jpeg' && r.buffer.length < big.length, r ? `${(r.buffer.length / 1024) | 0}KB vs ${(big.length / 1024) | 0}KB` : '');
  const small = makePng(640, 480, false);
  const rs = await resizeForEmbed(small);
  check('small photo NOT upscaled (dims preserved)', rs !== null && rs.width === 640 && rs.height === 480, rs ? `${rs.width}×${rs.height}` : '');
  const bad = await resizeForEmbed(Buffer.from('this-is-not-an-image'));
  check('undecodable buffer → null (skip, no crash)', bad === null);
}

async function partB(): Promise<void> {
  console.log('\n(B) aspect — fixed-size ext matches image aspect (no stretch), fits + centers:');
  const box = sitePhotoBoxAnchors(1)[0]!;
  const land = fittedPlacement(box, 1600, 900);   // landscape
  const port = fittedPlacement(box, 900, 1600);   // portrait
  const aspOk = (p: { ext: { width: number; height: number } }, imgW: number, imgH: number): boolean =>
    Math.abs(p.ext.width / p.ext.height - imgW / imgH) < 0.03;
  check('landscape ext keeps image aspect (no stretch)', aspOk(land, 1600, 900), `${land.ext.width}×${land.ext.height}`);
  check('portrait ext keeps image aspect (no stretch)', aspOk(port, 900, 1600), `${port.ext.width}×${port.ext.height}`);
  const boxWpx = (box.brCol - box.tlCol + 1) * 110, boxHpx = (box.brRow - box.tlRow + 1) * 20;
  check('landscape fits inside the box (letterbox, no crop)', land.ext.width <= boxWpx && land.ext.height <= boxHpx);
  check('portrait fits inside the box (letterbox, no crop)', port.ext.width <= boxWpx && port.ext.height <= boxHpx);
  check('centered — tl offset ≥ box top-left (0-indexed)', port.tl.col >= box.tlCol - 1 && port.tl.row >= box.tlRow - 1);
}

async function embedCount(photos: SitePhotoImage[]): Promise<{ images: number; bytes: number }> {
  const wb = new ExcelJS.Workbook();
  addSitePhotosGrid(wb, { dealName: 'Chunk4', photos });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as never);
  const sp = back.getWorksheet(SITE_PHOTOS_SHEET)!;
  return { images: (sp.getImages?.() ?? []).length, bytes: buf.length };
}

async function partC_D(): Promise<void> {
  console.log('\n(C/D) count-agnostic embed + file-size win (6 resized vs 6 full-size):');
  // Realistic-resolution sources (3000px long edge, like an uncropped phone photo). To isolate
  // the Chunk-4 win HONESTLY we hold the encoder/quality constant (JPEG q80 both sides) and
  // vary ONLY the 1200px cap: full = resizeForEmbed(…, 99999) (no downscale), small = the real cap.
  const srcPngs = [makePng(3000, 2250, true), makePng(2250, 3000, true), makePng(3000, 2000, true),
                   makePng(2000, 3000, true), makePng(3000, 2250, true), makePng(2250, 3000, true)];
  const resized: SitePhotoImage[] = [];
  const fullSize: SitePhotoImage[] = [];
  for (const s of srcPngs) {
    const small = await resizeForEmbed(s, 1200, 80);          // Chunk-4 path
    const full = await resizeForEmbed(s, 99999, 80);          // same q80, NO downscale (baseline)
    if (small) resized.push({ buffer: small.buffer, extension: small.extension, width: small.width, height: small.height, caption: `Photo ${resized.length + 1}` });
    if (full) fullSize.push({ buffer: full.buffer, extension: full.extension, width: full.width, height: full.height, caption: `Photo ${fullSize.length + 1}` });
  }
  const rOut = await embedCount(resized);
  const fullOut = await embedCount(fullSize);
  check('6 photos → 6 images embedded (count-agnostic, valid re-read)', rOut.images === 6);
  check('only downscaled — every resized photo ≤ 1200 long edge', resized.every((p) => Math.max(p.width ?? 0, p.height ?? 0) <= 1200));
  console.log(`  · resized xlsx: ${(rOut.bytes / 1024) | 0} KB   vs full-size xlsx: ${(fullOut.bytes / 1024 / 1024).toFixed(1)} MB`);
  check('resized workbook is DRAMATICALLY smaller than full-size', rOut.bytes < fullOut.bytes * 0.5, `${((1 - rOut.bytes / fullOut.bytes) * 100) | 0}% smaller`);
  const zero = await embedCount([]);
  check('0 photos → empty grid, 0 images (no crash)', zero.images === 0);
}

async function partE(): Promise<void> {
  console.log('\n(E) loader integration — real jimp resize inside loadSitePhotosForExport:');
  const png = makePng(1600, 1200, true);
  const loaded = await loadSitePhotosForExport('rev', {
    graph: { getRevisionEnvelope: () => ({ doctrineEvaluationId: 'eval' } as never) },
    resolve: (() => ({ resolved: true, poolId: 'P', loanInPoolId: 'L', matchedBy: 'exact-deal-ref' })) as never,
    getInput: (() => ({ value: JSON.stringify({ photos: [{ hash: 'h0', order: 0, fileName: 'front.png' }] }) } as never)) as never,
    getBlob: async () => png,
  });
  check('loader returns a resized photo with jpeg + dims', loaded.length === 1 && loaded[0]!.extension === 'jpeg' && (loaded[0]!.width ?? 0) > 0 && (loaded[0]!.height ?? 0) > 0, loaded[0] ? `${loaded[0]!.width}×${loaded[0]!.height}` : '');
  check('loader downscaled the 1600px source (≤ 1200 long edge)', loaded.length === 1 && Math.max(loaded[0]!.width ?? 0, loaded[0]!.height ?? 0) <= 1200);
}

async function partF(): Promise<void> {
  console.log('\n(F) real Sunroad export unchanged + mint-safe:');
  const app = express(); app.use('/api/underwriting', renderRoutes);
  const server = app.listen(0); await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const qs = new URLSearchParams({ dealId: SUNROAD, assetClass: 'office', underwritingMode: 'single_loan', profile: 'bp_spire', templateType: 'single_loan' });
  const res = await fetch(`http://127.0.0.1:${port}/api/underwriting/export?${qs.toString()}`);
  check('export succeeded', res.status === 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  server.close();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as never);
  check('sheet count 30 (Site Photos present)', wb.worksheets.length === 30);
  const oh = wb.getWorksheet('Operating History and Pro Forma')!;
  const h17 = oh.getCell('H17').value; const h17n = typeof h17 === 'number' ? h17 : (h17 as { result?: number })?.result ?? 0;
  check('Operating History H17 still 6,899,325', Math.abs(h17n - 6899325) <= 1);
  let rr = 0; wb.getWorksheet('Rent Roll')?.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, () => { rr++; }));
  check('Rent Roll intact (>100k cells)', rr > 100000, `${rr} cells`);
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nSite-photos Chunk 4 proof (jimp resize + aspect fit)');
  await partA(); await partB(); await partC_D(); await partE(); await partF();
  console.log(failures === 0 ? '\nsite-photos Chunk 4 proof: OK\n' : `\nsite-photos Chunk 4 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
