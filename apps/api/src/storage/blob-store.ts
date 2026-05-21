/**
 * BlobStore — content-addressed blob persistence for uploaded files.
 *
 * Tier B implementation of issue #10. The interface and required properties
 * (B1-B5) are locked by docs/architecture/file-storage-and-idempotency.md §5.
 *
 * Two implementations:
 *   - FilesystemBlobStore: persists bytes under <basePath>/<hash[0:2]>/<hash>.bin
 *     with two-level sharding. Writes are atomic (write to .tmp, then rename).
 *   - MemoryBlobStore: in-memory Map<ContentHash, Buffer>. For handler-level
 *     tests that need a BlobStore that quacks correctly without filesystem I/O.
 *
 * Properties (per ADR §5):
 *   B1: putBlob is idempotent (same buffer → same hash, no net storage change).
 *   B2: returned hash MUST equal computeBufferContentHash(buffer).
 *   B3: getBlob returns byte-identical bytes or null. No partial/transformed reads.
 *   B4: hasBlob is a strict subset of getBlob !== null; may be cheaper.
 *   B5: This module is the ONLY surface that touches blob storage. Direct
 *       fs.writeFile to .data/blobs/ from elsewhere is forbidden.
 *
 * Errors: BlobStoreError with a discriminated `code` field. HASH_MISMATCH
 * fires when an existing blob's bytes don't hash to its filename (defense
 * against filesystem corruption / B2 violations); WRITE_FAILED and
 * READ_FAILED wrap underlying I/O failures with a typed envelope so callers
 * can distinguish blob errors from other failures at the route boundary.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ContentHash } from '@cre/contracts';
import { computeBufferContentHash } from '../util/content-hash.js';

export type BlobStoreErrorCode = 'HASH_MISMATCH' | 'WRITE_FAILED' | 'READ_FAILED';

export class BlobStoreError extends Error {
  override readonly name = 'BlobStoreError';
  constructor(
    public readonly code: BlobStoreErrorCode,
    public readonly hash: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface BlobStore {
  /** Persist bytes; return their content hash. Idempotent: if the hash
   *  already exists with byte-identical content, this is a no-op and
   *  returns the existing hash. Throws BlobStoreError on filesystem
   *  failure or HASH_MISMATCH (existing file with same name but different
   *  bytes — should be impossible under SHA-256, but B2-guards). */
  putBlob(buffer: Buffer): Promise<ContentHash>;

  /** Retrieve bytes by content hash. Returns null if not present. Throws
   *  BlobStoreError on filesystem failure other than ENOENT. */
  getBlob(hash: ContentHash): Promise<Buffer | null>;

  /** Existence check. B4: may be implemented more cheaply than getBlob;
   *  filesystem impl uses fs.access (no file-read). */
  hasBlob(hash: ContentHash): Promise<boolean>;
}

/* ---------------------------- FilesystemBlobStore ------------------------- */

const DEFAULT_BLOB_PATH = path.join(process.cwd(), '.data', 'blobs');

export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly basePath: string = DEFAULT_BLOB_PATH) {}

  private shardDir(hash: string): string {
    // Two-level sharding by hash prefix. ADR §4.1.
    return path.join(this.basePath, hash.slice(0, 2));
  }

  private blobPath(hash: string): string {
    return path.join(this.shardDir(hash), `${hash}.bin`);
  }

  async putBlob(buffer: Buffer): Promise<ContentHash> {
    const hash = computeBufferContentHash(buffer);
    const blobPath = this.blobPath(hash);
    const shardDir = this.shardDir(hash);

    // Fast path: if the file already exists, verify it matches and return.
    // The verification is a defense-in-depth check (B2): a SHA-256 collision
    // is cryptographically infeasible, but filesystem-level corruption or
    // misuse could produce a same-named file with different bytes.
    try {
      const existing = await fs.readFile(blobPath);
      const existingHash = computeBufferContentHash(existing);
      if (existingHash !== hash) {
        throw new BlobStoreError(
          'HASH_MISMATCH',
          hash,
          `existing blob at ${blobPath} hashes to ${existingHash}, not ${hash}`,
        );
      }
      return hash;
    } catch (e) {
      if (e instanceof BlobStoreError) throw e;
      // ENOENT → fall through to write. Any other I/O failure escalates.
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw new BlobStoreError(
          'READ_FAILED',
          hash,
          `existence probe failed: ${err.message}`,
          err,
        );
      }
    }

    // Atomic write: write to <path>.tmp, then rename. rename(2) is atomic
    // on POSIX filesystems. If the process crashes mid-write, no partial
    // <hash>.bin exists; the .tmp orphan is harmless and can be cleaned up
    // by a future GC pass — out of scope per ADR §4.2.
    //
    // tmp suffix uses crypto.randomBytes (not Date.now()) so two concurrent
    // putBlob calls with the same buffer in the same event-loop tick get
    // distinct .tmp paths. Without this, both writers would target the
    // same .tmp file: the first to rename it succeeds; the second hits
    // ENOENT on rename because the source was already moved.
    const tmpPath = `${blobPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.mkdir(shardDir, { recursive: true });
      await fs.writeFile(tmpPath, buffer);
      await fs.rename(tmpPath, blobPath);
    } catch (e) {
      const err = e as Error;
      // Best-effort cleanup of the .tmp file. Ignore failure here — the
      // tmp is harmless and will be visible to ops if it accumulates.
      try { await fs.unlink(tmpPath); } catch { /* swallow */ }
      throw new BlobStoreError(
        'WRITE_FAILED',
        hash,
        `write failed at ${blobPath}: ${err.message}`,
        err,
      );
    }

    return hash;
  }

  async getBlob(hash: ContentHash): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.blobPath(hash));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw new BlobStoreError(
        'READ_FAILED',
        hash,
        `read failed at ${this.blobPath(hash)}: ${err.message}`,
        err,
      );
    }
  }

  async hasBlob(hash: ContentHash): Promise<boolean> {
    try {
      await fs.access(this.blobPath(hash), fsConstants.F_OK);
      return true;
    } catch {
      // fs.access throws on any failure (ENOENT, EACCES, etc.). For B4 the
      // safe answer is "not accessible" → false. If a real permission issue
      // is masking a present blob, getBlob will surface it next.
      return false;
    }
  }
}

/* ----------------------------- MemoryBlobStore ---------------------------- */

/** In-memory BlobStore for handler-level tests. Verifies the same interface
 *  contract without touching the filesystem. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs: Map<string, Buffer> = new Map();

  async putBlob(buffer: Buffer): Promise<ContentHash> {
    const hash = computeBufferContentHash(buffer);
    const existing = this.blobs.get(hash);
    if (existing !== undefined) {
      // B2-guard: same key should always carry same bytes. Cheap to check
      // in memory; matches the filesystem impl's defense-in-depth.
      if (!existing.equals(buffer)) {
        throw new BlobStoreError(
          'HASH_MISMATCH',
          hash,
          `in-memory blob under ${hash} has different bytes than the buffer being put`,
        );
      }
      return hash;
    }
    // Copy the buffer so external mutations don't corrupt store state.
    this.blobs.set(hash, Buffer.from(buffer));
    return hash;
  }

  async getBlob(hash: ContentHash): Promise<Buffer | null> {
    const found = this.blobs.get(hash);
    if (found === undefined) return null;
    // Return a copy so callers can't mutate stored bytes.
    return Buffer.from(found);
  }

  async hasBlob(hash: ContentHash): Promise<boolean> {
    return this.blobs.has(hash);
  }

  /** Test-only: clear all stored blobs. NOT part of the BlobStore interface. */
  clear(): void {
    this.blobs.clear();
  }
}

/* ----------------------------- production singleton ---------------------- */

/** Production singleton. Tests pass their own FilesystemBlobStore(tempdir) or
 *  MemoryBlobStore. Mirrors the recordGraphStore singleton pattern. */
export const blobStore: BlobStore = new FilesystemBlobStore();
