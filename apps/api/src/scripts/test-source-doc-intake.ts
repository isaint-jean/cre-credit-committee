/**
 * Tests for source-doc intake (Phase 1, upload-and-organize layer).
 *
 *   npx tsx apps/api/src/scripts/test-source-doc-intake.ts
 *
 * Pattern follows test-blob-store.ts: each test block uses a unique tempdir,
 * cleaned in finally. `setDataRoot()` redirects all I/O to the tempdir so we
 * never touch the real apps/api/.data files.
 *
 * Coverage:
 *   - manifest store: empty, single upload, idempotent re-upload, distinct
 *     bytes -> two entries, multi-deal isolation, idempotent delete
 *   - completeness view (per-deal + all)
 *   - HistoricalUnderwriting FK validation: 404 + 400 paths
 *   - staging + assign: 5-file batch, partial assign with one bad deal id,
 *     discard
 *   - file streaming round-trip
 *   - atomic-write discipline (no .tmp files lingering)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  setDataRoot,
  uploadSourceDoc,
  deleteSourceDoc,
  listAllManifests,
  getDealManifest,
  getSourceDocBuffer,
  getDealCompleteness,
  getAllCompleteness,
  createStagingBatch,
  getStagingBatch,
  assignStagingFiles,
  discardStagingBatch,
  listSlots,
  HistoricalUwNotFoundError,
  InvalidSlotError,
} from '../services/source-doc-store.service.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function failPrint(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : failPrint(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : failPrint(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

function setupTempDataDir(): { dataRoot: string; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-doc-test-'));
  setDataRoot(dataRoot);
  return {
    dataRoot,
    cleanup: () => {
      setDataRoot(null);
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function seedHistoricalUws(
  dataRoot: string,
  deals: ReadonlyArray<{ id: string; dealName: string }>,
): void {
  const file = path.join(dataRoot, 'historical-uws.json');
  const tuples = deals.map((d) => [d.id, { id: d.id, dealName: d.dealName }]);
  fs.writeFileSync(file, JSON.stringify(tuples, null, 2));
}

function noLingeringTmpFiles(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const full = path.join(d, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) stack.push(full);
      else if (name.endsWith('.tmp')) return false;
    }
  }
  return true;
}

(async () => {
  const DEAL_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const DEAL_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const DEAL_GHOST = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  // -------------------------------------------------------------------------
  console.log('source-doc-store — slot taxonomy:');
  {
    const slots = listSlots();
    assertEqual(slots.length, 7, '0.1 7 slots total');
    const required = slots.filter((s) => s.required).map((s) => s.slot);
    assertEqual(required.length, 2, '0.2 exactly 2 required slots');
    assert(required.includes('asr') && required.includes('cf'), '0.3 required = asr + cf');
    const slotNames = slots.map((s) => s.slot);
    for (const expected of ['asr', 'cf', 'rent_roll', 'pca', 'seller_uw', 't12', 'appraisal']) {
      assert(slotNames.includes(expected as any), `0.4 taxonomy includes ${expected}`);
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — empty initial state:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [
        { id: DEAL_A, dealName: 'Deal A' },
        { id: DEAL_B, dealName: 'Deal B' },
      ]);
      const manifests = listAllManifests();
      assertEqual(manifests.length, 0, '1.1 listAllManifests() returns []');
      const complete = getAllCompleteness();
      assertEqual(complete.length, 2, '1.2 getAllCompleteness() returns one per HistoricalUW');
      const completeA = complete.find((c) => c.historicalUwId === DEAL_A)!;
      assert(completeA !== undefined, '1.3 deal A appears in completeness even with no docs');
      assertEqual(completeA.hasMinimum, false, '1.4 hasMinimum=false with no docs');
      assertEqual(completeA.totalDocsPresent, 0, '1.5 totalDocsPresent=0');
      assertEqual(completeA.slots.asr.required, true, '1.6 asr.required=true');
      assertEqual(completeA.slots.asr.present, false, '1.7 asr.present=false (empty)');
      assertEqual(completeA.slots.cf.required, true, '1.8 cf.required=true');
      assertEqual(completeA.slots.appraisal.required, false, '1.9 appraisal.required=false');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — single upload to asr:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      const buf = Buffer.from('asr-content-v1');
      const entry = await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: buf,
        originalFileName: 'asr.pdf',
        mimeType: 'application/pdf',
      });
      const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
      assertEqual(entry.fileHash, expectedHash, '2.1 entry.fileHash = SHA-256(buf)');
      assertEqual(entry.size, buf.length, '2.2 entry.size matches');
      assertEqual(entry.originalFileName, 'asr.pdf', '2.3 originalFileName preserved');
      assertEqual(entry.notes, null, '2.4 notes defaults to null when omitted');

      const m = getDealManifest(DEAL_A);
      assert(m !== null, '2.5 manifest exists for deal A');
      assertEqual(m!.dealName, 'Deal A', '2.6 dealName denormalized');
      assertEqual(m!.slots.asr.length, 1, '2.7 asr slot has 1 entry');
      assertEqual(m!.slots.cf.length, 0, '2.8 cf slot still empty');

      // Blob on disk
      const blobDir = path.join(dataRoot, 'source-docs', DEAL_A, 'asr');
      const entries = fs.readdirSync(blobDir).filter((n) => !n.endsWith('.tmp'));
      assertEqual(entries.length, 1, '2.9 exactly 1 blob in asr dir');
      assert(entries[0]!.startsWith(expectedHash), '2.10 blob name starts with hash');
      assert(noLingeringTmpFiles(path.join(dataRoot, 'source-docs')), '2.11 no .tmp files lingering');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — idempotent re-upload of identical bytes:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      const buf = Buffer.from('the-same-bytes');
      const e1 = await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: buf,
        originalFileName: 'first.pdf',
        mimeType: 'application/pdf',
      });
      // Tiny wait so uploadedAt timestamps differ (ISO-8601 millisecond resolution).
      await new Promise((r) => setTimeout(r, 5));
      const e2 = await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: buf,
        originalFileName: 'renamed.pdf',
        mimeType: 'application/pdf',
        notes: 'analyst note',
      });
      assertEqual(e1.fileHash, e2.fileHash, '3.1 same bytes -> same hash');

      const m = getDealManifest(DEAL_A);
      assertEqual(m!.slots.asr.length, 1, '3.2 still exactly 1 manifest entry');
      const updated = m!.slots.asr[0]!;
      assertEqual(updated.originalFileName, 'renamed.pdf', '3.3 originalFileName refreshed');
      assertEqual(updated.notes, 'analyst note', '3.4 notes refreshed on re-upload');

      // Blob dir still has exactly 1 file.
      const blobDir = path.join(dataRoot, 'source-docs', DEAL_A, 'asr');
      const entries = fs.readdirSync(blobDir).filter((n) => !n.endsWith('.tmp'));
      assertEqual(entries.length, 1, '3.5 still exactly 1 blob on disk');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — distinct bytes -> two entries in same slot (0-to-N):');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'rent_roll',
        buffer: Buffer.from('rr-jan-2026'),
        originalFileName: 'rr-jan.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'rent_roll',
        buffer: Buffer.from('rr-feb-2026'),
        originalFileName: 'rr-feb.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const m = getDealManifest(DEAL_A);
      assertEqual(m!.slots.rent_roll.length, 2, '4.1 rent_roll has 2 entries');
      const hashes = new Set(m!.slots.rent_roll.map((e) => e.fileHash));
      assertEqual(hashes.size, 2, '4.2 two distinct hashes');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — multi-deal isolation:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [
        { id: DEAL_A, dealName: 'Deal A' },
        { id: DEAL_B, dealName: 'Deal B' },
      ]);
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: Buffer.from('asr-A'),
        originalFileName: 'asr-A.pdf',
        mimeType: 'application/pdf',
      });
      await uploadSourceDoc({
        historicalUwId: DEAL_B,
        slot: 'cf',
        buffer: Buffer.from('cf-B'),
        originalFileName: 'cf-B.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      assertEqual(getDealManifest(DEAL_A)!.slots.asr.length, 1, '5.1 deal A has its asr entry');
      assertEqual(getDealManifest(DEAL_A)!.slots.cf.length, 0, '5.2 deal A has no cf entry');
      assertEqual(getDealManifest(DEAL_B)!.slots.cf.length, 1, '5.3 deal B has its cf entry');
      assertEqual(getDealManifest(DEAL_B)!.slots.asr.length, 0, '5.4 deal B has no asr entry');
      const all = listAllManifests();
      assertEqual(all.length, 2, '5.5 two manifests total');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — completeness with required + optional slots:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      // hasMinimum starts false
      assertEqual(getDealCompleteness(DEAL_A).hasMinimum, false, '6.1 hasMinimum=false initially');

      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: Buffer.from('asr'),
        originalFileName: 'asr.pdf',
        mimeType: 'application/pdf',
      });
      assertEqual(getDealCompleteness(DEAL_A).hasMinimum, false, '6.2 hasMinimum still false (only asr)');
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'cf',
        buffer: Buffer.from('cf'),
        originalFileName: 'cf.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const c = getDealCompleteness(DEAL_A);
      assertEqual(c.hasMinimum, true, '6.3 hasMinimum=true after asr+cf');
      assertEqual(c.totalDocsPresent, 2, '6.4 totalDocsPresent=2');
      assertEqual(c.slots.asr.present, true, '6.5 asr.present=true');
      assertEqual(c.slots.appraisal.present, false, '6.6 appraisal.present=false');
      assertEqual(c.slots.appraisal.required, false, '6.7 appraisal.required=false (still NOT an error)');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — idempotent delete:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      const buf = Buffer.from('to-delete');
      const e = await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'pca',
        buffer: buf,
        originalFileName: 'pca.pdf',
        mimeType: 'application/pdf',
      });
      const r1 = await deleteSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'pca',
        fileHash: e.fileHash,
      });
      assertEqual(r1, true, '7.1 first delete returns true');
      assertEqual(getDealManifest(DEAL_A)!.slots.pca.length, 0, '7.2 pca slot now empty');

      const blobDir = path.join(dataRoot, 'source-docs', DEAL_A, 'pca');
      const remaining = fs.existsSync(blobDir)
        ? fs.readdirSync(blobDir).filter((n) => !n.endsWith('.tmp'))
        : [];
      assertEqual(remaining.length, 0, '7.3 blob removed from disk');

      const r2 = await deleteSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'pca',
        fileHash: e.fileHash,
      });
      assertEqual(r2, false, '7.4 second delete returns false (idempotent, no throw)');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — FK validation: non-existent historicalUwId:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      let thrown: unknown = null;
      try {
        await uploadSourceDoc({
          historicalUwId: DEAL_GHOST,
          slot: 'asr',
          buffer: Buffer.from('x'),
          originalFileName: 'x.pdf',
          mimeType: 'application/pdf',
        });
      } catch (e) {
        thrown = e;
      }
      assert(thrown instanceof HistoricalUwNotFoundError, '8.1 throws HistoricalUwNotFoundError');
      assertEqual(
        (thrown as HistoricalUwNotFoundError).historicalUwId,
        DEAL_GHOST,
        '8.2 error carries the bad id',
      );
    } finally { cleanup(); }
  }

  console.log('\nsource-doc-store — invalid slot rejected:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      let thrown: unknown = null;
      try {
        await uploadSourceDoc({
          historicalUwId: DEAL_A,
          slot: 'not_a_real_slot' as any,
          buffer: Buffer.from('x'),
          originalFileName: 'x.pdf',
          mimeType: 'application/pdf',
        });
      } catch (e) {
        thrown = e;
      }
      assert(thrown instanceof InvalidSlotError, '9.1 throws InvalidSlotError');
      assertEqual(
        (thrown as InvalidSlotError).slot,
        'not_a_real_slot',
        '9.2 error carries bad slot',
      );
      assertEqual(
        (thrown as InvalidSlotError).validSlots.length,
        7,
        '9.3 error lists 7 valid slots',
      );
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — staging batch creation:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [
        { id: DEAL_A, dealName: 'Deal A' },
        { id: DEAL_B, dealName: 'Deal B' },
      ]);
      const batch = await createStagingBatch({
        files: [
          { buffer: Buffer.from('f1'), originalFileName: 'f1.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('f2'), originalFileName: 'f2.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('f3'), originalFileName: 'f3.xlsx', mimeType: 'application/octet-stream' },
          { buffer: Buffer.from('f4'), originalFileName: 'f4.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('f5'), originalFileName: 'f5.pdf', mimeType: 'application/pdf' },
        ],
      });
      assertEqual(batch.files.length, 5, '10.1 batch holds 5 files');
      assertEqual(listAllManifests().length, 0, '10.2 manifest NOT updated by staging (still empty)');

      const reread = getStagingBatch(batch.batchId);
      assert(reread !== null, '10.3 staging batch re-readable from disk');
      assertEqual(reread!.files.length, 5, '10.4 re-read batch has 5 files');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — staging assign (partial, with one bad deal id):');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [
        { id: DEAL_A, dealName: 'Deal A' },
        { id: DEAL_B, dealName: 'Deal B' },
      ]);
      const batch = await createStagingBatch({
        files: [
          { buffer: Buffer.from('a-asr'), originalFileName: 'a-asr.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('a-cf'), originalFileName: 'a-cf.xlsx', mimeType: 'application/octet-stream' },
          { buffer: Buffer.from('a-rr'), originalFileName: 'a-rr.xlsx', mimeType: 'application/octet-stream' },
          { buffer: Buffer.from('b-asr'), originalFileName: 'b-asr.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('ghost'), originalFileName: 'ghost.pdf', mimeType: 'application/pdf' },
        ],
      });
      const [s1, s2, s3, s4, s5] = batch.files;

      // First 3 assigns succeed (all to deal A).
      const r1 = await assignStagingFiles({
        batchId: batch.batchId,
        assignments: [
          { stagingId: s1!.stagingId, historicalUwId: DEAL_A, slot: 'asr' },
          { stagingId: s2!.stagingId, historicalUwId: DEAL_A, slot: 'cf' },
          { stagingId: s3!.stagingId, historicalUwId: DEAL_A, slot: 'rent_roll' },
        ],
      });
      assertEqual(r1.length, 3, '11.1 three assignment results');
      assert(r1.every((r) => r.status === 'assigned'), '11.2 all 3 assigned successfully');
      assertEqual(getDealManifest(DEAL_A)!.slots.asr.length, 1, '11.3 deal A asr now has 1');
      assertEqual(getDealManifest(DEAL_A)!.slots.cf.length, 1, '11.4 deal A cf now has 1');
      assertEqual(getDealManifest(DEAL_A)!.slots.rent_roll.length, 1, '11.5 deal A rent_roll now has 1');

      // Now try to assign remaining 2: one good (s4 to deal B), one bad (s5 to ghost id).
      const r2 = await assignStagingFiles({
        batchId: batch.batchId,
        assignments: [
          { stagingId: s4!.stagingId, historicalUwId: DEAL_B, slot: 'asr' },
          { stagingId: s5!.stagingId, historicalUwId: DEAL_GHOST, slot: 'asr' },
        ],
      });
      assertEqual(r2.length, 2, '11.6 two results from second batch');
      const okResult = r2.find((r) => r.stagingId === s4!.stagingId)!;
      const errResult = r2.find((r) => r.stagingId === s5!.stagingId)!;
      assertEqual(okResult.status, 'assigned', '11.7 deal B asr succeeded');
      assertEqual(errResult.status, 'error', '11.8 ghost id reported as error');
      assert(
        typeof errResult.error === 'string' && errResult.error.includes('historical_uw_not_found'),
        '11.9 error message names the failure mode',
      );
      assertEqual(getDealManifest(DEAL_B)!.slots.asr.length, 1, '11.10 deal B asr grew to 1');
      // The ghost file is STILL staged (not silently dropped).
      const remaining = getStagingBatch(batch.batchId);
      assert(remaining !== null, '11.11 batch still exists');
      assertEqual(remaining!.files.length, 1, '11.12 1 file remains staged (the bad one)');
      assertEqual(remaining!.files[0]!.stagingId, s5!.stagingId, '11.13 remaining is the ghost-target one');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — discard staging batch:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      const batch = await createStagingBatch({
        files: [
          { buffer: Buffer.from('x'), originalFileName: 'x.pdf', mimeType: 'application/pdf' },
          { buffer: Buffer.from('y'), originalFileName: 'y.pdf', mimeType: 'application/pdf' },
        ],
      });
      const ok1 = await discardStagingBatch(batch.batchId);
      assertEqual(ok1, true, '12.1 discard returns true');
      assertEqual(getStagingBatch(batch.batchId), null, '12.2 batch no longer readable');
      const ok2 = await discardStagingBatch(batch.batchId);
      assertEqual(ok2, false, '12.3 re-discard returns false (idempotent)');
      // Manifest never grew.
      assertEqual(listAllManifests().length, 0, '12.4 manifest still empty after discard');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — file streaming round-trip:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      const original = Buffer.from('the actual bytes that came in');
      const e = await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 't12',
        buffer: original,
        originalFileName: 't12.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const round = getSourceDocBuffer({
        historicalUwId: DEAL_A,
        slot: 't12',
        fileHash: e.fileHash,
      });
      assert(round !== null, '13.1 round-trip read succeeds');
      assert(round!.buffer.equals(original), '13.2 bytes match original');
      assertEqual(round!.entry.fileHash, e.fileHash, '13.3 entry metadata matches');

      const miss = getSourceDocBuffer({
        historicalUwId: DEAL_A,
        slot: 't12',
        fileHash: 'deadbeef'.padEnd(64, '0'),
      });
      assertEqual(miss, null, '13.4 unknown hash returns null');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log('\nsource-doc-store — atomic-write discipline:');
  {
    const { dataRoot, cleanup } = setupTempDataDir();
    try {
      seedHistoricalUws(dataRoot, [{ id: DEAL_A, dealName: 'Deal A' }]);
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        buffer: Buffer.from('atomic-1'),
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
      });
      await uploadSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'cf',
        buffer: Buffer.from('atomic-2'),
        originalFileName: 'c.xlsx',
        mimeType: 'application/octet-stream',
      });
      await deleteSourceDoc({
        historicalUwId: DEAL_A,
        slot: 'asr',
        fileHash: getDealManifest(DEAL_A)!.slots.asr[0]!.fileHash,
      });
      assert(noLingeringTmpFiles(path.join(dataRoot, 'source-docs')), '14.1 no .tmp files after upsert+delete cycle');
      // Manifest always present.
      const manifestPath = path.join(dataRoot, 'source-docs', 'source-doc-manifests.json');
      assert(fs.existsSync(manifestPath), '14.2 manifest file present');
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assertEqual(parsed.version, 1, '14.3 manifest file version=1');
    } finally { cleanup(); }
  }

  // -------------------------------------------------------------------------
  console.log(`\nTotals: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(2);
});
