/**
 * Data Room v2 — Piece B, Phase 1: HOSTILE-FIXTURE tests for the zip-unpack
 * security core. This is the GATE — it CRAFTS REAL malicious zips and proves
 * each is handled fail-closed.
 *
 *   tsx src/scripts/test-unpack-zip-security.ts
 *
 * Fixtures are built two ways:
 *   - archiver (a dep) for compressible data, nested zips, symlinks, happy path.
 *   - RAW zip bytes (buildRawZip) for hostile ENTRY NAMES — archiver sanitizes
 *     `..`, so zip-slip / absolute / backslash / NUL names are hand-assembled
 *     into the local + central directory so they survive to the unpacker.
 *
 * ★ STANDALONE: this test imports ONLY the unpack module + node/archiver. No
 * store, no classify, no cre.db.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
// archiver ships no types in this repo (no @types/archiver) → default-import is
// an untyped module. We only use append()/symlink()/finalize() here.
import archiver from 'archiver';

// Minimal structural type for the archiver instance we drive (avoids `any`).
interface ArchiverLike {
  append(source: Buffer, opts: { name: string }): unknown;
  symlink(name: string, target: string, mode?: number): unknown;
  finalize(): Promise<void>;
  pipe(dest: NodeJS.WritableStream): unknown;
  on(event: string, cb: (...a: unknown[]) => void): unknown;
}

import {
  unpackZipToSandbox,
  MAX_ENTRIES,
  MAX_TOTAL,
  MAX_ENTRY,
  MAX_RATIO,
  type UnpackResult,
} from '../services/data-room/unpack-zip.service.js';

let passed = 0;
let failed = 0;
function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function bad(m: string): void {
  failed++;
  console.error(`  FAIL  ${m}`);
}
function assert(c: boolean, m: string): void {
  c ? ok(m) : bad(m);
}

// ── archiver → Buffer helper ─────────────────────────────────────────────────
async function archiveToBuffer(
  build: (a: ArchiverLike) => void,
): Promise<Buffer> {
  const a = archiver('zip', { zlib: { level: 9 } }) as unknown as ArchiverLike;
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => chunks.push(c));
  const doneP = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    a.on('error', reject);
  });
  a.pipe(sink);
  build(a);
  await a.finalize();
  await doneP;
  return Buffer.concat(chunks);
}

// ── RAW zip builder (for hostile names archiver would sanitize) ──────────────
// Minimal ZIP with STORED entries (method 0) so we control the exact fileName
// bytes in both the local header and the central directory.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

interface RawEntry {
  name: string; // raw bytes for the filename (may contain \0, .., \, etc.)
  data: Buffer;
  externalAttrs?: number; // externalFileAttributes (e.g. symlink mode << 16)
}

function buildRawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'binary');
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    const localRecord = Buffer.concat([local, nameBuf, e.data]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir sig
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk #
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((e.externalAttrs ?? 0) >>> 0, 38); // external attrs (unsigned)
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += localRecord.length;
  }

  const localsBuf = Buffer.concat(locals);
  const centralsBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralsBuf.length, 12);
  eocd.writeUInt32LE(localsBuf.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localsBuf, centralsBuf, eocd]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// A per-test sandbox parent so we can prove cleanup left NOTHING behind.
async function withUnpack(
  zip: Buffer,
  opts: Parameters<typeof unpackZipToSandbox>[1],
  body: (res: UnpackResult) => Promise<void>,
): Promise<string> {
  const res = await unpackZipToSandbox(zip, opts);
  const root = res.sandboxRoot;
  try {
    await body(res);
  } finally {
    await res.cleanup();
  }
  return root;
}

async function main(): Promise<void> {
  console.log('== Data Room v2 Piece B Phase 1 — hostile-fixture gate ==\n');
  console.log(
    `caps: MAX_ENTRIES=${MAX_ENTRIES} MAX_TOTAL=${MAX_TOTAL} MAX_ENTRY=${MAX_ENTRY} MAX_RATIO=${MAX_RATIO}\n`,
  );

  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'dataroom-test-'));

  // ── 1. ZIP-SLIP ────────────────────────────────────────────────────────────
  {
    console.log('[1] zip-slip (../, absolute, backslash, NUL)');
    // Canary path OUTSIDE any sandbox — must NOT exist after.
    const canary = path.join(tmpParent, 'ESCAPED-evil.txt');
    await fs.rm(canary, { force: true });

    const zip = buildRawZip([
      { name: '../../ESCAPED-evil.txt', data: Buffer.from('pwned') },
      { name: '/tmp/ESCAPED-abs.txt', data: Buffer.from('pwned') },
      { name: '..\\..\\ESCAPED-bs.txt', data: Buffer.from('pwned') },
      { name: 'good/../../ESCAPED-mid.txt', data: Buffer.from('pwned') },
      { name: 'evil\0.txt', data: Buffer.from('pwned') },
    ]);

    const root = await withUnpack(zip, { tmpDir: tmpParent }, async (res) => {
      assert(res.files.length === 0, 'zip-slip: no files written');
      assert(res.rejected.length === 5, `zip-slip: all 5 rejected (got ${res.rejected.length})`);
      const reasons = res.rejected.map((r) => r.reason);
      assert(reasons.includes('dotdot-segment'), 'zip-slip: ../.. → dotdot-segment');
      assert(reasons.includes('absolute-path'), 'zip-slip: /tmp/.. → absolute-path');
      assert(reasons.includes('backslash'), 'zip-slip: backslash → rejected');
      assert(reasons.includes('nul-byte'), 'zip-slip: NUL → rejected');
      // ★ prove NOTHING escaped the sandbox
      assert(!(await exists(canary)), 'zip-slip: canary OUTSIDE sandbox absent');
      assert(!(await exists('/tmp/ESCAPED-abs.txt')), 'zip-slip: /tmp target absent');
      // ★ prove sandbox itself has NO files
      const entries = await fs.readdir(res.sandboxRoot, { recursive: true } as any);
      const fileEntries = [] as string[];
      for (const e of entries as string[]) {
        const full = path.join(res.sandboxRoot, e);
        if ((await fs.stat(full)).isFile()) fileEntries.push(e);
      }
      assert(fileEntries.length === 0, `zip-slip: sandbox empty of files (got ${fileEntries.length})`);
    });
    assert(!(await exists(root)), 'zip-slip: sandbox removed by cleanup');
    assert(!(await exists(canary)), 'zip-slip: canary still absent after cleanup');
  }

  // ── 2. RATIO-BOMB (mid-stream, REAL) ───────────────────────────────────────
  {
    console.log('\n[2] ratio-bomb (mid-stream, real compressible entry)');
    // 8 MB of zeros → compresses to a few KB → ratio >> lowered MAX_RATIO.
    const N = 8 * 1024 * 1024;
    const zip = await archiveToBuffer((a) => {
      a.append(Buffer.alloc(N, 0), { name: 'bomb.bin' });
    });
    // Lower BOTH ratio and per-entry so the meter fires DURING decompression,
    // well before N bytes materialize.
    const root = await withUnpack(
      zip,
      { tmpDir: tmpParent, maxRatio: 5, maxEntry: 256 * 1024 },
      async (res) => {
        assert(res.files.length === 0, 'ratio-bomb: nothing written');
        assert(res.rejected.length === 1, 'ratio-bomb: one rejection');
        const reason = res.rejected[0]?.reason;
        assert(
          reason === 'ratio-exceeded' || reason === 'entry-too-large',
          `ratio-bomb: rejected mid-stream (reason=${reason})`,
        );
        // ★ prove it aborted mid-stream: no full-N artifact anywhere.
        const files: number[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const d of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) await walk(full);
            else files.push((await fs.stat(full)).size);
          }
        };
        await walk(res.sandboxRoot);
        const biggest = files.length ? Math.max(...files) : 0;
        assert(biggest < N, `ratio-bomb: no full ${N}-byte artifact (biggest=${biggest})`);
        assert(biggest <= 256 * 1024 + 65536, 'ratio-bomb: partial output stayed small (aborted early)');
      },
    );
    assert(!(await exists(root)), 'ratio-bomb: sandbox removed');
  }

  // ── 3. SIZE-BOMB (total > MAX_TOTAL) ───────────────────────────────────────
  {
    console.log('\n[3] size-bomb (total > lowered MAX_TOTAL)');
    // Two 2 MB entries; lower total cap to 3 MB → second (or first) trips total.
    const zip = await archiveToBuffer((a) => {
      a.append(Buffer.alloc(2 * 1024 * 1024, 7), { name: 'a.bin' });
      a.append(Buffer.alloc(2 * 1024 * 1024, 9), { name: 'b.bin' });
    });
    const root = await withUnpack(
      zip,
      { tmpDir: tmpParent, maxTotal: 3 * 1024 * 1024, maxEntry: 10 * 1024 * 1024, maxRatio: 1_000_000 },
      async (res) => {
        const totalTrip = res.rejected.some((r) => r.reason === 'total-too-large');
        assert(totalTrip, 'size-bomb: total-too-large fired');
        // At most one entry could fit under the 3 MB total.
        assert(res.files.length <= 1, `size-bomb: <=1 file admitted (got ${res.files.length})`);
      },
    );
    assert(!(await exists(root)), 'size-bomb: sandbox removed');
  }

  // ── 4. COUNT-BOMB (> MAX_ENTRIES) ──────────────────────────────────────────
  {
    console.log('\n[4] count-bomb (> lowered MAX_ENTRIES)');
    const zip = await archiveToBuffer((a) => {
      for (let i = 0; i < 20; i++) a.append(Buffer.from(`x${i}`), { name: `f${i}.txt` });
    });
    const root = await withUnpack(
      zip,
      { tmpDir: tmpParent, maxEntries: 5 },
      async (res) => {
        assert(res.files.length === 5, `count-bomb: capped at 5 files (got ${res.files.length})`);
        const counted = res.rejected.filter((r) => r.reason === 'entry-count-exceeded').length;
        assert(counted === 15, `count-bomb: 15 rejected past cap (got ${counted})`);
      },
    );
    assert(!(await exists(root)), 'count-bomb: sandbox removed');
  }

  // ── 5. NESTED ZIP (opaque, not recursed) ───────────────────────────────────
  {
    console.log('\n[5] nested-zip (opaque loose file, NOT recursed)');
    const inner = await archiveToBuffer((a) => {
      a.append(Buffer.from('SECRET-INNER-CONTENT'), { name: 'INNER-SHOULD-NOT-UNPACK.txt' });
    });
    const outer = await archiveToBuffer((a) => {
      a.append(inner, { name: 'nested/inner.zip' });
      a.append(Buffer.from('top'), { name: 'nested/top.txt' });
    });
    const root = await withUnpack(outer, { tmpDir: tmpParent }, async (res) => {
      const paths = res.files.map((f) => f.internalPath).sort();
      assert(paths.includes('nested/inner.zip'), 'nested: inner.zip extracted as opaque file');
      assert(paths.includes('nested/top.txt'), 'nested: sibling top.txt extracted');
      // ★ prove inner entries were NOT unpacked.
      assert(
        !res.files.some((f) => f.internalPath.includes('INNER-SHOULD-NOT-UNPACK')),
        'nested: inner entry NOT recursed into files',
      );
      // ★ prove no inner-name artifact on disk.
      let found = false;
      const walk = async (dir: string): Promise<void> => {
        for (const d of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, d.name);
          if (d.isDirectory()) await walk(full);
          else if (d.name.includes('INNER-SHOULD-NOT-UNPACK')) found = true;
        }
      };
      await walk(res.sandboxRoot);
      assert(!found, 'nested: no inner-entry file on disk');
      // The inner.zip on disk should be byte-identical to the opaque bytes.
      const innerEntry = res.files.find((f) => f.internalPath === 'nested/inner.zip')!;
      const onDisk = await fs.readFile(innerEntry.sandboxPath);
      assert(onDisk.equals(inner), 'nested: inner.zip bytes preserved opaque');
    });
    assert(!(await exists(root)), 'nested: sandbox removed');
  }

  // ── 6. SYMLINK (skipped) ───────────────────────────────────────────────────
  {
    console.log('\n[6] symlink (skipped, never written as a link)');
    // Raw entry with S_IFLNK mode in externalFileAttributes >>> 16.
    const S_IFLNK = 0o120000;
    const zip = buildRawZip([
      { name: 'link-to-etc-passwd', data: Buffer.from('/etc/passwd'), externalAttrs: (S_IFLNK | 0o777) << 16 },
      { name: 'regular.txt', data: Buffer.from('ok'), externalAttrs: (0o100644) << 16 },
    ]);
    const root = await withUnpack(zip, { tmpDir: tmpParent }, async (res) => {
      assert(res.rejected.some((r) => r.reason === 'symlink'), 'symlink: entry rejected as symlink');
      assert(
        res.files.every((f) => f.internalPath !== 'link-to-etc-passwd'),
        'symlink: not present in files',
      );
      assert(res.files.some((f) => f.internalPath === 'regular.txt'), 'symlink: sibling regular file kept');
      // ★ prove no symlink on disk.
      const linkPath = path.join(res.sandboxRoot, 'link-to-etc-passwd');
      let isLink = false;
      try {
        isLink = (await fs.lstat(linkPath)).isSymbolicLink();
      } catch {
        /* absent = good */
      }
      assert(!isLink, 'symlink: no symbolic link materialized');
      assert(!(await exists(linkPath)), 'symlink: no file at symlink path');
    });
    assert(!(await exists(root)), 'symlink: sandbox removed');
  }

  // ── 7. HAPPY PATH ──────────────────────────────────────────────────────────
  {
    console.log('\n[7] happy-path (well-formed Loan/Category/file.pdf)');
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf body');
    const zip = await archiveToBuffer((a) => {
      a.append(pdfBytes, { name: 'Loan/Category/file.pdf' });
      a.append(Buffer.from('a,b,c\n1,2,3\n'), { name: 'Loan/Category/data.csv' });
    });
    const root = await withUnpack(zip, { tmpDir: tmpParent }, async (res) => {
      assert(res.rejected.length === 0, 'happy: nothing rejected');
      assert(res.files.length === 2, `happy: 2 files (got ${res.files.length})`);
      const pdf = res.files.find((f) => f.internalPath === 'Loan/Category/file.pdf');
      assert(!!pdf, 'happy: internalPath Loan/Category/file.pdf present');
      if (pdf) {
        assert(pdf.sandboxPath.startsWith(res.sandboxRoot + path.sep), 'happy: sandboxPath under root');
        assert(pdf.size === pdfBytes.length, `happy: size matches (${pdf.size})`);
        const onDisk = await fs.readFile(pdf.sandboxPath);
        assert(onDisk.equals(pdfBytes), 'happy: bytes round-trip exactly');
      }
    });
    assert(!(await exists(root)), 'happy: sandbox removed after cleanup');
  }

  // ── 8. CLEANUP ON THROW (unreadable archive) ───────────────────────────────
  {
    console.log('\n[8] cleanup-on-throw (garbage bytes → throws, temp cleaned)');
    const garbage = Buffer.from('this is definitely not a zip file at all');
    let threw = false;
    try {
      await unpackZipToSandbox(garbage, { tmpDir: tmpParent });
    } catch {
      threw = true;
    }
    assert(threw, 'throw: unreadable archive throws fail-closed');
    // ★ prove no sandbox dir leaked in the parent.
    const leftover = await fs.readdir(tmpParent);
    const sandboxes = leftover.filter((n) => n.startsWith('dataroom-unpack-'));
    assert(sandboxes.length === 0, `throw: no leaked sandbox dirs (found ${sandboxes.length})`);
  }

  // Final: parent should be empty of unpack sandboxes across ALL cases.
  {
    const leftover = await fs.readdir(tmpParent);
    const sandboxes = leftover.filter((n) => n.startsWith('dataroom-unpack-'));
    assert(sandboxes.length === 0, `TEMP ALWAYS CLEANED: 0 sandbox dirs remain (found ${sandboxes.length})`);
  }

  await fs.rm(tmpParent, { recursive: true, force: true });

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
