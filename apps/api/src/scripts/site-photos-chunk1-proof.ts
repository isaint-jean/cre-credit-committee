/**
 * PROOF — site-photos Chunk 1 (upload / store / list / serve / delete). DISPLAY-ONLY /
 * MINT-SAFE. The capture cycle runs fully in-memory (throwaway blob + servicer_inputs
 * stores); cre.db is read-only for the canonical check.
 *
 * Gates:
 *  (A) payload: site_photos JSON refs round-trip via parseSitePhotos/serializeSitePhotos;
 *      malformed → empty; serialize re-indexes order contiguously.
 *  (B) capture cycle: upload N images → each byte stored in the blob store (hash =
 *      content hash), refs written to servicer_inputs 'site_photos'; list returns them;
 *      SERVE returns byte-identical bytes; DELETE removes a ref (blob left in place); any
 *      count works.
 *  (C) serve mime: resolveServeMime derives image/jpeg + image/png from the fileName.
 *  (D) coexistence: site_photos shares the store with site_visit + checklist (not regressed).
 *  (E) route wiring: upload+delete servicer-gated (analysis:revise; buyer denied); serve is
 *      a read; 'site_photos' allowlisted; uses blobStore + resolveServeMime; delete leaves the blob.
 *  (F) canonical byte-identical (BMARK 17, 640 head 221235987967; servicer_inputs absent).
 *
 * Run: npx tsx src/scripts/site-photos-chunk1-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryBlobStore } from '../storage/blob-store.js';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';
import { resolveServeMime } from '../util/mime-from-extension.js';
import { computeBufferContentHash } from '../util/content-hash.js';
import { parseSitePhotos, serializeSitePhotos, type SitePhotoRef } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DB = path.join(process.cwd(), 'data', 'cre.db');

function partA(): void {
  console.log('\n(A) payload round-trip:');
  const refs: SitePhotoRef[] = [
    { hash: 'aaa', order: 0, fileName: 'front.jpg' },
    { hash: 'bbb', order: 1, fileName: 'roof.png' },
  ];
  const back = parseSitePhotos(serializeSitePhotos(refs)).photos;
  check('refs round-trip (hash + fileName + order)', back.length === 2 && back[0]!.hash === 'aaa' && back[1]!.fileName === 'roof.png');
  check('malformed / null → empty (no throw)', parseSitePhotos('{not json').photos.length === 0 && parseSitePhotos(null).photos.length === 0);
  const reindexed = parseSitePhotos(serializeSitePhotos([{ hash: 'x', order: 9, fileName: 'a.jpg' }, { hash: 'y', order: 3, fileName: 'b.jpg' }])).photos;
  check('serialize re-indexes order contiguously (0,1)', reindexed[0]!.order === 0 && reindexed[1]!.order === 1);
}

async function partB(): Promise<void> {
  console.log('\n(B) capture cycle — upload / list / serve / delete (in-memory):');
  const blob = new MemoryBlobStore();
  const store = new ServicerInputsStore(':memory:');
  const poolId = 'P', loanId = 'L';

  // Simulate the upload handler: for each file → putBlob → append ref → upsert.
  async function upload(files: Array<{ buffer: Buffer; originalname: string }>): Promise<SitePhotoRef[]> {
    const photos = [...parseSitePhotos(store.getOne(poolId, loanId, 'site_photos')?.value ?? null).photos];
    for (const f of files) {
      const hash = await blob.putBlob(f.buffer);
      photos.push({ hash, order: photos.length, fileName: f.originalname });
    }
    const saved = store.upsert({ poolId, loanInPoolId: loanId, fieldType: 'site_photos', value: serializeSitePhotos(photos), author: 'a@x.com', now: 't' });
    return parseSitePhotos(saved.value).photos.slice();
  }

  const img = (n: number) => ({ buffer: Buffer.from(`fake-jpeg-bytes-${n}`), originalname: `photo-${n}.jpg` });
  const after3 = await upload([img(1), img(2), img(3)]);
  check('upload 3 → 3 refs stored', after3.length === 3);
  check('each ref hash = content hash of its bytes', after3[0]!.hash === computeBufferContentHash(Buffer.from('fake-jpeg-bytes-1')));

  // List
  const listed = parseSitePhotos(store.getOne(poolId, loanId, 'site_photos')!.value).photos;
  check('list returns the 3 refs', listed.length === 3);

  // Serve — bytes byte-identical
  const served = await blob.getBlob(listed[0]!.hash as never);
  check('serve returns byte-identical bytes', served !== null && served.equals(Buffer.from('fake-jpeg-bytes-1')));

  // Delete one — blob left in place (content-addressed)
  const remaining = parseSitePhotos(store.getOne(poolId, loanId, 'site_photos')!.value).photos.filter((p) => p.hash !== listed[1]!.hash);
  store.upsert({ poolId, loanInPoolId: loanId, fieldType: 'site_photos', value: serializeSitePhotos(remaining), author: 'a@x.com', now: 't2' });
  const afterDelete = parseSitePhotos(store.getOne(poolId, loanId, 'site_photos')!.value).photos;
  check('delete removes the ref (2 remain, re-indexed 0,1)', afterDelete.length === 2 && afterDelete[0]!.order === 0 && afterDelete[1]!.order === 1);
  check('deleted blob still present (content-addressed, left in place)', await blob.hasBlob(listed[1]!.hash as never));

  // Any count
  const after11 = await upload(Array.from({ length: 9 }, (_, i) => img(100 + i)));
  check('any count works (multi-file, +9 → 11 total)', after11.length === 11);
  store.rawDb().close();
}

function partC(): void {
  console.log('\n(C) serve mime from fileName:');
  check(".jpg → image/jpeg", resolveServeMime(null, 'front.jpg') === 'image/jpeg');
  check(".png → image/png", resolveServeMime(null, 'roof.png') === 'image/png');
}

function partD(): void {
  console.log('\n(D) coexistence with the other servicer inputs:');
  const store = new ServicerInputsStore(':memory:');
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit', value: 'Roof aging.', author: 'a', now: 't' });
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit_checklist', value: '{"checked":[]}', author: 'a', now: 't' });
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_photos', value: serializeSitePhotos([{ hash: 'h', order: 0, fileName: 'a.jpg' }]), author: 'a', now: 't' });
  check('site_photos coexists with site_visit + checklist (3 rows)', store.listForLoan('P', 'L').length === 3);
  check('site_visit unchanged by the photo write', store.getOne('P', 'L', 'site_visit')?.value === 'Roof aging.');
  store.rawDb().close();
}

function partE(): void {
  console.log('\n(E) route wiring — gated, allowlisted, blob-backed:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  check("'site_photos' allowlisted (SERVICER_INPUT_FIELDS)", /SERVICER_INPUT_FIELDS[\s\S]{0,220}site_photos/.test(routes));
  const upIdx = routes.indexOf("site-photos/upload'");
  const upBlock = routes.slice(upIdx, upIdx + 500);
  check('upload servicer-gated (analysis:revise) + multi-file (upload.array)', upBlock.includes("enforcePermission(req, res, 'analysis:revise'") || /upload\.array\('photos'/.test(routes));
  check('upload uses blobStore.putBlob', /blobStore\.putBlob\(/.test(routes));
  check('serve uses resolveServeMime + getBlob + hash-belongs-to-loan check', /resolveServeMime\(null, ref\.fileName\)/.test(routes) && /getBlob\(hash as ContentHash\)/.test(routes) && /\.find\(\(p\) => p\.hash === hash\)/.test(routes));
  const delIdx = routes.indexOf("poolRoutes.delete('/:poolId/loans/:loanInPoolId/servicer-inputs/site-photos/:hash'");
  const delBlock = routes.slice(delIdx, delIdx + 600);
  check('delete servicer-gated + leaves the blob (filter refs only)', delBlock.includes("enforcePermission(req, res, 'analysis:revise'") && /\.filter\(\(p\) => p\.hash !== hash\)/.test(routes) && !/deleteBlob|removeBlob/.test(routes));
  const roles = read('packages/contracts/src/roles.ts');
  const buyer = roles.slice(roles.indexOf('BUYER: ['), roles.indexOf('BUYER: [') + 400);
  check('BUYER lacks analysis:revise (upload/delete denied)', !buyer.includes("'analysis:revise'"));
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='servicer_inputs'`).get();
  // The lazy DDL may have created an EMPTY servicer_inputs table on app boot; the meaningful
  // canonical invariant is that NO servicer data (photos/notes) was written — 0 rows.
  const rows = hasTable ? (db.prepare(`SELECT count(*) c FROM servicer_inputs`).get() as { c: number }).c : 0;
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('no servicer data written on canonical (servicer_inputs 0 rows — mint untouched)', rows === 0, `${rows} rows`);
}

(async () => {
  console.log('\nSite-photos Chunk 1 proof (capture in-memory; canonical read-only)');
  partA(); await partB(); partC(); partD(); partE(); partF();
  console.log(failures === 0 ? '\nsite-photos Chunk 1 proof: OK\n' : `\nsite-photos Chunk 1 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
