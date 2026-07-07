/**
 * Data Room v2 — Piece B, Phase 1: the zip-unpack SECURITY CORE (standalone).
 *
 *   import { unpackZipToSandbox } from './unpack-zip.service.js';
 *
 * ★ THREAT MODEL: this handles UNTRUSTED bank archives. It is bulletproof +
 * FAIL-CLOSED by design: a breach of ANY guard routes NOTHING — the offending
 * entry is REJECTED (recorded, never written), and the sandbox never leaks a
 * single unvalidated byte outside its per-batch root.
 *
 * ★ STANDALONE: this module touches NO seam/store/cre.db. It unpacks to an
 * `os.tmpdir()` sandbox, validates every entry, and `cleanup()`s (rm -rf) the
 * sandbox. It imports NOTHING from the data-room store / classify / assign, and
 * opens NO database. Phase 3 wires this into the seam; this phase is the core.
 *
 * ★ STREAMING (yauzl): entries are opened one-by-one and metered as they
 * decompress — we NEVER fully decompress a hostile entry before deciding.
 * adm-zip/jszip are all-in-memory and bomb-vulnerable; yauzl is not used that
 * way here — every read stream is abortable mid-flight.
 *
 * Guards (all fail-closed):
 *   - zip-slip:   name is rejected for absolute paths, `..` segments, backslashes
 *                 or NUL bytes BEFORE resolving; then the resolved destination
 *                 MUST live under `sandboxRoot + path.sep`.
 *   - zip-bomb:   decompressed bytes are metered MID-STREAM against MAX_ENTRY,
 *                 MAX_TOTAL and MAX_RATIO (decompressed/compressed); a breach
 *                 DESTROYS the read stream and rejects the entry. The declared
 *                 header size is NOT trusted — actual bytes are counted.
 *   - count:      opening entries stops once MAX_ENTRIES is reached.
 *   - nested zip: an inner `.zip` is an OPAQUE loose file (bytes only), NEVER
 *                 recursed into.
 *   - symlinks / non-files: symlinks (S_IFLNK) and directory entries are SKIPPED;
 *                 only regular files are written.
 */

import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type ZipFile, type Entry } from 'yauzl';

// ── Caps — NAMED, EXPORTED constants (tunable) + INJECTABLE via opts ──────────
/** Max number of entries opened; entries past this are not opened. */
export const MAX_ENTRIES = 5000;
/** Max total decompressed bytes across the whole archive. */
export const MAX_TOTAL = 2 * 1024 ** 3; // 2 GB
/** Max decompressed bytes for any single entry. */
export const MAX_ENTRY = 512 * 1024 ** 2; // 512 MB
/** Max decompressed/compressed ratio for any single entry (zip-bomb tell). */
export const MAX_RATIO = 100;

/** POSIX file-type mask + symlink bits, read from externalFileAttributes >>> 16. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000; // 0xA000
const S_IFDIR = 0o040000;

export interface UnpackCaps {
  maxEntries?: number;
  maxTotal?: number;
  maxEntry?: number;
  maxRatio?: number;
}

export interface UnpackOptions extends UnpackCaps {
  /** Override the sandbox parent dir (default os.tmpdir()). For tests. */
  tmpDir?: string;
}

export interface UnpackedFile {
  /** The entry's path as declared inside the archive (forward-slashed). */
  internalPath: string;
  /** Absolute path where the validated bytes were written, inside the sandbox. */
  sandboxPath: string;
  /** Actual decompressed byte count written. */
  size: number;
}

export type RejectReason =
  | 'zip-slip'
  | 'absolute-path'
  | 'dotdot-segment'
  | 'backslash'
  | 'nul-byte'
  | 'empty-name'
  | 'symlink'
  | 'entry-too-large'
  | 'total-too-large'
  | 'ratio-exceeded'
  | 'entry-count-exceeded'
  | 'write-error';

export interface RejectedEntry {
  internalPath: string;
  reason: RejectReason;
}

export interface UnpackResult {
  /** Per-batch sandbox root (absolute). All files live strictly under here. */
  sandboxRoot: string;
  files: UnpackedFile[];
  rejected: RejectedEntry[];
  /** rm -rf the sandbox. Idempotent. Also run in the caller's finally. */
  cleanup: () => Promise<void>;
}

/**
 * Static-name validation, run BEFORE resolving. Returns a reject reason for a
 * hostile name, or null if the name is structurally safe to resolve.
 */
function classifyName(name: string): RejectReason | null {
  if (name.length === 0) return 'empty-name';
  if (name.includes('\0')) return 'nul-byte';
  if (name.includes('\\')) return 'backslash';
  // Absolute POSIX path.
  if (name.startsWith('/')) return 'absolute-path';
  // Windows drive-absolute (e.g. C:\ — backslash already caught, but C:/ too).
  if (/^[a-zA-Z]:/.test(name)) return 'absolute-path';
  // Any `..` path segment (leading, embedded, or trailing).
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) return 'dotdot-segment';
  return null;
}

/**
 * Resolve the destination under the sandbox and confirm containment.
 * Returns the absolute sandboxPath, or null if the resolve escapes.
 */
function resolveContained(sandboxRoot: string, name: string): string | null {
  const dest = path.resolve(sandboxRoot, name);
  // Exact-root would be the directory itself (no file); require a child.
  if (dest === sandboxRoot) return null;
  if (!dest.startsWith(sandboxRoot + path.sep)) return null;
  return dest;
}

/**
 * Decode the raw filename bytes. We run yauzl with decodeStrings:false so that
 * yauzl NEVER validates or rejects a name itself — WE own every guard and get
 * per-entry rejection (a hostile name rejects that entry, not the archive). The
 * bytes are decoded as UTF-8 (the zip spec's flagged encoding); the guards then
 * run on the decoded string.
 */
function decodeName(raw: Buffer | string): string {
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

function isDirEntry(name: string, entry: Entry): boolean {
  // yauzl convention: trailing slash marks a directory.
  if (name.endsWith('/')) return true;
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  return mode === S_IFDIR;
}

function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  return mode === S_IFLNK;
}

/**
 * Unpack a zip (given as bytes) into a per-batch sandbox under os.tmpdir(),
 * validating every entry fail-closed. Nothing unvalidated leaves the sandbox.
 */
export async function unpackZipToSandbox(
  zipBytes: Buffer,
  opts: UnpackOptions = {},
): Promise<UnpackResult> {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const maxEntry = opts.maxEntry ?? MAX_ENTRY;
  const maxRatio = opts.maxRatio ?? MAX_RATIO;
  const parent = opts.tmpDir ?? os.tmpdir();

  const sandboxRoot = await fs.mkdtemp(path.join(parent, 'dataroom-unpack-'));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(sandboxRoot, { recursive: true, force: true });
  };

  const files: UnpackedFile[] = [];
  const rejected: RejectedEntry[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.fromBuffer(
        zipBytes,
        // ★ decodeStrings:false → yauzl does NOT validate/reject names itself;
        // WE own every guard (per-entry rejection, siblings still processed).
        // lazyEntries → we pull entries one-by-one (streaming, abortable).
        { lazyEntries: true, autoClose: true, decodeStrings: false },
        (err, zipFile) => {
          if (err || !zipFile) {
            reject(err ?? new Error('unpack: zip could not be opened'));
            return;
          }

          let runningTotal = 0;
          let opened = 0;
          let done = false;

          const finish = (e?: Error): void => {
            if (done) return;
            done = true;
            if (e) reject(e);
            else resolve();
          };

          const nextEntry = (): void => zipFile.readEntry();

          zipFile.on('error', finish);
          zipFile.on('end', () => finish());

          zipFile.on('entry', (entry: Entry) => {
            void handleEntry(entry);
          });

          async function handleEntry(entry: Entry): Promise<void> {
            const internalPath = decodeName(entry.fileName as unknown as Buffer);

            // ── Count cap: stop OPENING entries past the limit. ──────────────
            if (opened >= maxEntries) {
              rejected.push({ internalPath, reason: 'entry-count-exceeded' });
              return nextEntry();
            }

            // ── Directories: skip silently (structure is implied by files). ──
            if (isDirEntry(internalPath, entry)) {
              return nextEntry();
            }

            // ── Symlinks / non-regular files: SKIP (never written as a link). ─
            if (isSymlink(entry)) {
              rejected.push({ internalPath, reason: 'symlink' });
              return nextEntry();
            }

            // ── zip-slip: static name checks BEFORE resolving. ───────────────
            const nameReason = classifyName(internalPath);
            if (nameReason) {
              rejected.push({ internalPath, reason: nameReason });
              return nextEntry();
            }
            const dest = resolveContained(sandboxRoot, internalPath);
            if (dest === null) {
              rejected.push({ internalPath, reason: 'zip-slip' });
              return nextEntry();
            }

            // This entry WILL be opened; it counts against the entry cap.
            opened += 1;

            const compressedSize = entry.compressedSize;

            try {
              await streamEntryMetered(zipFile, entry, dest, {
                maxEntry,
                maxTotal,
                maxRatio,
                compressedSize,
                runningTotalBefore: runningTotal,
              }).then((res) => {
                if (res.ok) {
                  runningTotal += res.written;
                  files.push({
                    internalPath,
                    sandboxPath: dest,
                    size: res.written,
                  });
                } else {
                  rejected.push({ internalPath, reason: res.reason });
                }
              });
            } catch {
              // Any unexpected stream/write failure → fail-closed reject.
              await fs.rm(dest, { force: true }).catch(() => {});
              rejected.push({ internalPath, reason: 'write-error' });
            }

            return nextEntry();
          }

          // Kick off the lazy walk.
          nextEntry();
        },
      );
    });
  } catch (err) {
    // Fail-closed: if the archive itself is unreadable, clean and rethrow.
    await cleanup();
    throw err;
  }

  return { sandboxRoot, files, rejected, cleanup };
}

interface MeterCtx {
  maxEntry: number;
  maxTotal: number;
  maxRatio: number;
  compressedSize: number;
  runningTotalBefore: number;
}

type StreamOutcome =
  | { ok: true; written: number }
  | { ok: false; reason: RejectReason };

/**
 * Open the entry's read stream and pipe it to `dest` while metering
 * decompressed bytes MID-STREAM. If any cap fires, the read stream is
 * DESTROYED (aborting decompression — the full N bytes are never materialized),
 * the partial output is deleted, and the entry is rejected fail-closed.
 */
function streamEntryMetered(
  zipFile: ZipFile,
  entry: Entry,
  dest: string,
  ctx: MeterCtx,
): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve) => {
    zipFile.openReadStream(entry, async (err, readStream) => {
      if (err || !readStream) {
        resolve({ ok: false, reason: 'write-error' });
        return;
      }

      // Ensure the parent directory exists (nested internal paths).
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
      } catch {
        readStream.destroy();
        resolve({ ok: false, reason: 'write-error' });
        return;
      }

      let written = 0;
      let tripped: RejectReason | null = null;
      const writeStream = createWriteStream(dest);

      const meter = new Transform({
        transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
          written += chunk.length;

          // ── MID-STREAM caps — fire on ACTUAL bytes, not the header. ────────
          if (written > ctx.maxEntry) {
            tripped = 'entry-too-large';
          } else if (ctx.runningTotalBefore + written > ctx.maxTotal) {
            tripped = 'total-too-large';
          } else if (
            ctx.compressedSize > 0 &&
            written / ctx.compressedSize > ctx.maxRatio
          ) {
            tripped = 'ratio-exceeded';
          }

          if (tripped) {
            // Abort decompression NOW — never materialize the rest.
            readStream.destroy();
            // Signal downstream to stop; error propagates via pipeline.
            cb(new Error(`cap:${tripped}`));
            return;
          }
          cb(undefined, chunk);
        },
      });

      try {
        await pipeline(readStream, meter, writeStream);
        resolve({ ok: true, written });
      } catch {
        // Either a cap tripped or the stream errored. Delete partial output.
        readStream.destroy();
        await fs.rm(dest, { force: true }).catch(() => {});
        resolve({ ok: false, reason: tripped ?? 'write-error' });
      }
    });
  });
}
