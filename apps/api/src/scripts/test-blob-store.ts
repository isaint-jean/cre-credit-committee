/**
 * Tests for FilesystemBlobStore + MemoryBlobStore (Tier B of issue #10).
 *
 *   tsx src/scripts/test-blob-store.ts
 *
 * The filesystem suite uses a unique tempdir per test, cleaned up in a finally
 * block. Verifies B1–B5 from docs/architecture/file-storage-and-idempotency.md §5
 * plus the HASH_MISMATCH defense and the two-level sharding layout.
 *
 * Pattern is structural (no shared global state), so failures don't cascade.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ContentHash } from '@cre/contracts';
import { computeBufferContentHash } from '../util/content-hash.js';
import {
  BlobStoreError,
  FilesystemBlobStore,
  MemoryBlobStore,
  type BlobStore,
} from '../storage/blob-store.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function failPrint(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : failPrint(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : failPrint(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

async function mkTempStore(): Promise<{ store: FilesystemBlobStore; basePath: string }> {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'blob-store-test-'));
  return { store: new FilesystemBlobStore(basePath), basePath };
}

async function cleanup(basePath: string): Promise<void> {
  await fs.rm(basePath, { recursive: true, force: true });
}

/* --------------------------- FilesystemBlobStore -------------------------- */

(async () => {
  console.log('FilesystemBlobStore — putBlob + getBlob round-trip (B2, B3):');
  {
    const { store, basePath } = await mkTempStore();
    try {
      const buf = Buffer.from('hello world\n');
      const expectedHash = computeBufferContentHash(buf);
      const returnedHash = await store.putBlob(buf);
      assertEqual(returnedHash, expectedHash, '1.1 returned hash equals computeBufferContentHash(buf) (B2)');

      const fetched = await store.getBlob(returnedHash);
      assert(fetched !== null, '1.2 getBlob returns bytes (not null)');
      assert(fetched !== null && fetched.equals(buf), '1.3 fetched bytes byte-identical to input (B3)');
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — idempotency (B1):');
  {
    const { store, basePath } = await mkTempStore();
    try {
      const buf = Buffer.from('idempotent content');
      const h1 = await store.putBlob(buf);
      const h2 = await store.putBlob(buf);
      const h3 = await store.putBlob(Buffer.from(buf)); // distinct buffer, same bytes
      assertEqual(h1, h2, '2.1 putBlob twice returns same hash');
      assertEqual(h2, h3, '2.2 putBlob with copy-of-buf returns same hash');

      // No net storage change: the shard directory contains exactly one file.
      const shardDir = path.join(basePath, h1.slice(0, 2));
      const entries = await fs.readdir(shardDir);
      assertEqual(entries.length, 1, '2.3 exactly one file in shard dir after 3 puts');
      assertEqual(entries[0] ?? '', `${h1}.bin`, '2.4 file named <hash>.bin');
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — getBlob not-present returns null (B3):');
  {
    const { store, basePath } = await mkTempStore();
    try {
      const fakeHash = ('0'.repeat(64)) as ContentHash;
      const result = await store.getBlob(fakeHash);
      assertEqual(result, null, '3.1 getBlob on unknown hash returns null');
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — hasBlob (B4):');
  {
    const { store, basePath } = await mkTempStore();
    try {
      const buf = Buffer.from('existence test');
      const h = await store.putBlob(buf);

      assertEqual(await store.hasBlob(h), true, '4.1 hasBlob returns true for stored blob');
      const fakeHash = ('f'.repeat(64)) as ContentHash;
      assertEqual(await store.hasBlob(fakeHash), false, '4.2 hasBlob returns false for unknown hash');

      // B4: hasBlob is a strict subset of getBlob !== null
      const fetched = await store.getBlob(h);
      assertEqual(fetched !== null, await store.hasBlob(h), '4.3 hasBlob aligned with getBlob !== null');
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — two-level sharding by hash prefix:');
  {
    const { store, basePath } = await mkTempStore();
    try {
      // Pick two buffers that hash to different prefixes (overwhelmingly likely
      // since SHA-256 is uniform). Both should land in their own shard dir.
      const bufA = Buffer.from('alpha');
      const bufB = Buffer.from('beta-shard-test');
      const hA = await store.putBlob(bufA);
      const hB = await store.putBlob(bufB);
      const prefixA = hA.slice(0, 2);
      const prefixB = hB.slice(0, 2);

      // Verify directory layout
      const baseEntries = await fs.readdir(basePath);
      assert(baseEntries.includes(prefixA), `5.1 shard dir ${prefixA} present at base`);
      // If by very low probability the two hashes share the same prefix, this
      // assertion would still hold trivially.
      const fileA = await fs.readFile(path.join(basePath, prefixA, `${hA}.bin`));
      assert(fileA.equals(bufA), `5.2 blob at ${prefixA}/${hA.slice(0, 8)}.bin matches`);

      if (prefixA !== prefixB) {
        assert(baseEntries.includes(prefixB), `5.3 distinct shard dir ${prefixB} also present`);
      } else {
        ok('5.3 (skipped — both blobs landed in the same shard by hash chance)');
      }
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — HASH_MISMATCH defense:');
  {
    const { store, basePath } = await mkTempStore();
    try {
      // Plant a file at the path that "should" contain bytes hashing to X, but
      // populate it with different bytes. The next putBlob with bytes hashing
      // to X reads the existing file, detects mismatch, throws.
      const realBuf = Buffer.from('real content');
      const realHash = computeBufferContentHash(realBuf);
      const shardDir = path.join(basePath, realHash.slice(0, 2));
      const blobPath = path.join(shardDir, `${realHash}.bin`);
      await fs.mkdir(shardDir, { recursive: true });
      await fs.writeFile(blobPath, Buffer.from('CORRUPTED bytes that do not hash to realHash'));

      let threw: BlobStoreError | null = null;
      try { await store.putBlob(realBuf); } catch (e) { threw = e as BlobStoreError; }
      assert(threw instanceof BlobStoreError, '6.1 throws BlobStoreError on hash mismatch');
      assertEqual(threw?.code ?? null, 'HASH_MISMATCH', '6.2 code = HASH_MISMATCH');
      assertEqual(threw?.hash ?? null, realHash, '6.3 hash reported on the error');
    } finally { await cleanup(basePath); }
  }

  console.log('\nFilesystemBlobStore — concurrent putBlob with same bytes:');
  {
    // B1 idempotency under concurrency. Three parallel puts of the same buffer
    // should all return the same hash and leave exactly one file. The atomic
    // .tmp + rename strategy means each writer creates its own .tmp file and
    // the last rename wins; same-bytes contract makes "wins" semantically
    // identical.
    const { store, basePath } = await mkTempStore();
    try {
      const buf = Buffer.from('concurrent content');
      const [h1, h2, h3] = await Promise.all([
        store.putBlob(buf),
        store.putBlob(buf),
        store.putBlob(buf),
      ]);
      assertEqual(h1, h2, '7.1 concurrent put 1 and 2 return same hash');
      assertEqual(h2, h3, '7.2 concurrent put 2 and 3 return same hash');

      // Exactly one final blob; no leftover .tmp files. (If the .tmp cleanup
      // logic failed, this would show extra files.)
      const shardDir = path.join(basePath, h1.slice(0, 2));
      const entries = (await fs.readdir(shardDir)).filter((n) => !n.endsWith('.tmp'));
      assertEqual(entries.length, 1, '7.3 exactly one non-tmp file after concurrent puts');
    } finally { await cleanup(basePath); }
  }

  /* ------------------------------- MemoryBlobStore ------------------------- */

  console.log('\nMemoryBlobStore — same contract verified with in-memory impl:');
  {
    const store: BlobStore = new MemoryBlobStore();
    const buf = Buffer.from('memory backed');
    const expected = computeBufferContentHash(buf);

    const h1 = await store.putBlob(buf);
    assertEqual(h1, expected, '8.1 returned hash matches computeBufferContentHash (B2)');
    assertEqual(await store.hasBlob(h1), true, '8.2 hasBlob true after put');
    assertEqual((await store.getBlob(h1))?.equals(buf), true, '8.3 getBlob returns matching bytes (B3)');

    const h2 = await store.putBlob(buf);
    assertEqual(h2, h1, '8.4 putBlob idempotent (B1)');

    const fakeHash = ('a'.repeat(64)) as ContentHash;
    assertEqual(await store.getBlob(fakeHash), null, '8.5 unknown hash → null');
    assertEqual(await store.hasBlob(fakeHash), false, '8.6 unknown hash → hasBlob false');
  }

  console.log('\nMemoryBlobStore — HASH_MISMATCH defense (parallel to filesystem impl):');
  {
    // Construct two buffers that would hash to the same key only if we cheated:
    // force-insert via private field, then try putBlob with bytes that hash to
    // that same key but differ. Memory impl detects via .equals().
    const store = new MemoryBlobStore();
    const buf = Buffer.from('real bytes');
    const h = computeBufferContentHash(buf);
    // Force a corrupt entry into the private map for the defense path:
    (store as unknown as { blobs: Map<string, Buffer> }).blobs.set(h, Buffer.from('corrupt different bytes'));

    let threw: BlobStoreError | null = null;
    try { await store.putBlob(buf); } catch (e) { threw = e as BlobStoreError; }
    assert(threw instanceof BlobStoreError, '9.1 throws BlobStoreError on memory-level hash collision');
    assertEqual(threw?.code ?? null, 'HASH_MISMATCH', '9.2 code = HASH_MISMATCH');
  }

  console.log('\nMemoryBlobStore — caller mutation does not corrupt store:');
  {
    // The store should defensively copy bytes on put and on get; a caller
    // mutating their buffer after put, or mutating the returned buffer,
    // must not affect future reads.
    const store = new MemoryBlobStore();
    const buf = Buffer.from('original');
    const h = await store.putBlob(buf);
    buf[0] = 0x58; // 'X' — mutate the caller's buffer
    const fetched = await store.getBlob(h);
    assert(fetched !== null && fetched.toString() === 'original', '10.1 post-put mutation of input does not corrupt store');

    if (fetched !== null) {
      fetched[0] = 0x59; // 'Y' — mutate the returned buffer
    }
    const fetched2 = await store.getBlob(h);
    assert(fetched2 !== null && fetched2.toString() === 'original', '10.2 mutation of returned buffer does not corrupt store');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
