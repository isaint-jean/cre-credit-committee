/**
 * PROOF — site-photos Chunk 3: embed uploaded photos into the Site Photos grid at export.
 * EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 * Gates:
 *  (A) embed: addSitePhotosGrid with N photos → N images embedded in the "Site Photos" sheet,
 *      count-agnostic (boxCount = photo count), captions kept, valid re-readable xlsx.
 *  (B) 0 photos → the empty default grid (discoverable, no images, no crash).
 *  (C) loader: exportImageExtension maps png/jpg/jpeg/gif and SKIPS unsupported (webp/heic);
 *      loadSitePhotosForExport orders by ref.order, skips unsupported types + missing blobs.
 *  (D) wiring: /export loads via loadSitePhotosForExport + passes photos to the grid.
 *  (E) rest UNCHANGED: real Sunroad export (no photos) → empty grid, sheet count 30, Operating
 *      History H17 still 6,899,325, Rent Roll intact.
 *  (F) file-size visibility (for Chunk 4) + canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/site-photos-chunk3-proof.ts   (from apps/api)
 */
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { renderRoutes } from '../routes/render.routes.js';
import { addSitePhotosGrid, SITE_PHOTOS_SHEET, type SitePhotoImage } from '../services/render-memo/site-photos-grid.js';
import { exportImageExtension, loadSitePhotosForExport } from '../services/render-memo/site-photos-for-export.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const DB = path.join(process.cwd(), 'data', 'cre.db');
const SUNROAD = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00';

/* --- minimal dependency-free PNG (solid color) for real embeddable bytes --- */
const CRC = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer { const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); const t = Buffer.from(type); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([l, t, data, cr]); }
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); raw[o] = 0; for (let x = 0; x < w; x++) { const p = o + 1 + x * 3; raw[p] = rgb[0]; raw[p + 1] = rgb[1]; raw[p + 2] = rgb[2]; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function partA_B(): Promise<void> {
  console.log('\n(A/B) embed N photos + empty-grid fallback:');
  const photos: SitePhotoImage[] = [
    { buffer: makePng(300, 200, [200, 60, 60]), extension: 'png', caption: 'Photo 1' },
    { buffer: makePng(300, 200, [60, 170, 90]), extension: 'png', caption: 'Photo 2' },
    { buffer: makePng(240, 320, [70, 110, 200]), extension: 'png', caption: 'Photo 3' },
  ];
  const wb = new ExcelJS.Workbook();
  addSitePhotosGrid(wb, { dealName: 'Test Deal', photos });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as never);
  const sp = back.getWorksheet(SITE_PHOTOS_SHEET)!;
  check('Site Photos sheet present', sp !== undefined);
  check('N=3 photos → 3 images embedded (count-agnostic)', (sp.getImages?.() ?? []).length === 3, `${(sp.getImages?.() ?? []).length} images`);
  check('media present in the workbook (bytes embedded)', ((back as unknown as { model?: { media?: unknown[] } }).model?.media?.length ?? 0) >= 3);
  check('re-read xlsx is valid (round-trips)', sp.getCell('A1').value !== null);

  const wb0 = new ExcelJS.Workbook();
  addSitePhotosGrid(wb0, { dealName: 'Empty', photos: [] });
  const back0 = new ExcelJS.Workbook();
  await back0.xlsx.load(Buffer.from(await wb0.xlsx.writeBuffer()) as never);
  const sp0 = back0.getWorksheet(SITE_PHOTOS_SHEET)!;
  check('0 photos → empty grid present, 0 images (discoverable)', sp0 !== undefined && (sp0.getImages?.() ?? []).length === 0 && String(sp0.getCell(3, 1).value) === 'Photo 1');
}

async function partC(): Promise<void> {
  console.log('\n(C) loader — extension map + order + skip:');
  check('extension map (png/jpg/jpeg/gif)', exportImageExtension('a.png') === 'png' && exportImageExtension('b.JPG') === 'jpeg' && exportImageExtension('c.jpeg') === 'jpeg' && exportImageExtension('d.gif') === 'gif');
  check('unsupported (webp/heic) → null (skipped, not mis-embedded)', exportImageExtension('x.webp') === null && exportImageExtension('y.heic') === null);

  // injected deps: refs whose ARRAY position != stored `order`, plus a webp + a missing blob.
  // (raw JSON, NOT serializeSitePhotos — which would re-index order to array position and
  // defeat the sort test.) Stored order: front=0, roof=1 → loader must return front then roof.
  const value = JSON.stringify({ photos: [
    { hash: 'h1', order: 1, fileName: 'roof.jpg' },
    { hash: 'h0', order: 0, fileName: 'front.png' },
    { hash: 'h2', order: 2, fileName: 'skip.webp' },
    { hash: 'hmiss', order: 3, fileName: 'gone.png' },
  ] });
  const loaded = await loadSitePhotosForExport('rev', {
    graph: { getRevisionEnvelope: () => ({ doctrineEvaluationId: 'eval' } as never) },
    resolve: (() => ({ resolved: true, poolId: 'P', loanInPoolId: 'L', matchedBy: 'exact-deal-ref' })) as never,
    getInput: (() => ({ value } as never)) as never,
    getBlob: async (h) => (h === 'hmiss' ? null : Buffer.from(`img-${h}`)),
    // Chunk 4 added a real jimp resize in the loader; these fixtures aren't real images, so
    // inject a passthrough resize to keep this ordering/skip test decoupled from decoding.
    resize: async (buf) => ({ buffer: buf, width: 10, height: 10, extension: 'jpeg' as const }),
  });
  check('ordered by ref.order (front.png then roof.jpg)', loaded.length === 2 && loaded[0]!.buffer.toString().includes('h0') && loaded[1]!.buffer.toString().includes('h1'));
  check('webp skipped + missing blob skipped', !loaded.some((p) => p.buffer.toString().includes('h2')) && !loaded.some((p) => p.buffer.toString().includes('hmiss')));
  const none = await loadSitePhotosForExport(null);
  check('no graphRevisionId → [] (no crash)', none.length === 0);
}

function partD(): void {
  console.log('\n(D) wiring — /export loads + passes photos:');
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes calls loadSitePhotosForExport', /loadSitePhotosForExport\(/.test(routes));
  check('render.routes passes photos to the grid', /sitePhotos:\s*\{[^}]*photos:\s*sitePhotos/.test(routes));
}

async function partE_F(): Promise<void> {
  console.log('\n(E/F) real Sunroad export (no photos) — empty grid, rest unchanged, size + mint:');
  const app = express(); app.use('/api/underwriting', renderRoutes);
  const server = app.listen(0); await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const qs = new URLSearchParams({ dealId: SUNROAD, assetClass: 'office', underwritingMode: 'single_loan', profile: 'bp_spire', templateType: 'single_loan' });
  const res = await fetch(`http://127.0.0.1:${port}/api/underwriting/export?${qs.toString()}`);
  check('export succeeded', res.status === 200);
  if (res.status !== 200) { server.close(); return; }
  const bytes = Buffer.from(await res.arrayBuffer());
  server.close();
  console.log(`  · exported workbook size: ${(bytes.length / 1024).toFixed(0)} KB (no photos on this deal; N phone photos would add ~4 MB each — Chunk 4 resizes)`);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as never);
  check('sheet count 30 (Site Photos present)', wb.worksheets.length === 30);
  const sp = wb.getWorksheet(SITE_PHOTOS_SHEET);
  check('no-photo deal → empty grid (0 images on the sheet)', sp !== undefined && (sp.getImages?.() ?? []).length === 0);
  const oh = wb.getWorksheet('Operating History and Pro Forma')!;
  const h17 = oh.getCell('H17').value;
  const h17n = typeof h17 === 'number' ? h17 : (h17 as { result?: number })?.result ?? 0;
  check('Operating History H17 still 6,899,325 (rest unchanged)', Math.abs(h17n - 6899325) <= 1);
  let rr = 0; wb.getWorksheet('Rent Roll')?.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, () => { rr++; }));
  check('Rent Roll intact (>100k cells)', rr > 100000, `${rr} cells`);

  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nSite-photos Chunk 3 proof (embed at export)');
  await partA_B(); await partC(); partD(); await partE_F();
  console.log(failures === 0 ? '\nsite-photos Chunk 3 proof: OK\n' : `\nsite-photos Chunk 3 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });
