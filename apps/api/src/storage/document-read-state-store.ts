/**
 * DocumentReadStateStore (Data-Room Phase 1, Deliverable 3).
 *
 * Per-user read/unread tracking + a per-user download cursor for the
 * "download-what's-new" behaviour. Net-new, self-contained, DECOUPLED from
 * ingest / governed / registry.
 *
 * Two lazy-DDL tables (created on first write, mirroring the overlay `side`
 * column / audit-events lazy-migrate precedent — CREATE TABLE IF NOT EXISTS):
 *
 *   document_read_state(user_id, file_hash, read_at)
 *     - keys on the JWT req.user.userId + the content-addressed fileHash
 *       (already the doc's natural id — no new id space).
 *     - PRIMARY KEY(user_id, file_hash): a doc is read once per user.
 *       Re-marking refreshes read_at (upsert).
 *
 *   document_download_cursor(user_id, pool_id, last_synced_at)
 *     - the per-(user, pool) sync cursor for download-what's-new.
 *     - "what's new" = docs uploaded after last_synced_at (never-synced =
 *       everything). On a successful pull, advance the cursor to the newest
 *       uploadedAt just downloaded.
 *     - PRIMARY KEY(user_id, pool_id).
 *
 * DISCIPLINE:
 *   - No FK into cre.db engine tables (soft references, same precedent as
 *     committee_actions.root_id / loan_in_pool.deal_ref). user_id is the JWT
 *     subject; file_hash is a content hash; pool_id is a soft pool ref.
 *   - Idempotent upserts (ON CONFLICT ... DO UPDATE) — safe to re-run.
 *   - Pure I/O. No business logic beyond the cursor/read-state math.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export interface ReadStateRow {
  readonly userId: string;
  readonly fileHash: string;
  readonly readAt: string;
}

export class DocumentReadStateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  /** Lazy DDL — created on first construction. IF NOT EXISTS makes it a no-op on
   *  an existing db, so the real cre.db is byte-unchanged until a first write. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_read_state (
        user_id   TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        read_at   TEXT NOT NULL,
        PRIMARY KEY (user_id, file_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_document_read_state_user ON document_read_state(user_id);

      CREATE TABLE IF NOT EXISTS document_download_cursor (
        user_id        TEXT NOT NULL,
        pool_id        TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        PRIMARY KEY (user_id, pool_id)
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Read-state
  // -------------------------------------------------------------------------

  /** Mark one doc read for a user. Idempotent; refreshes read_at on re-mark. */
  markRead(userId: string, fileHash: string, readAt: string = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO document_read_state (user_id, file_hash, read_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, file_hash) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run(userId, fileHash, readAt);
  }

  /** The set of fileHashes this user has read. */
  readSet(userId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT file_hash FROM document_read_state WHERE user_id = ?`)
      .all(userId) as ReadonlyArray<{ file_hash: string }>;
    return new Set(rows.map((r) => r.file_hash));
  }

  /** True iff this user has read this doc. */
  isRead(userId: string, fileHash: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM document_read_state WHERE user_id = ? AND file_hash = ?`)
      .get(userId, fileHash);
    return row !== undefined;
  }

  /**
   * Given the pool's doc fileHashes, return the user's unread subset + count.
   * Unread = not present in document_read_state for this user. Pure set math;
   * the caller supplies the pool's current doc hashes (from the data-room store)
   * so this store never reaches into the manifest.
   */
  unreadOf(userId: string, poolDocHashes: ReadonlyArray<string>): { unread: string[]; count: number } {
    const read = this.readSet(userId);
    const unread = poolDocHashes.filter((h) => !read.has(h));
    return { unread, count: unread.length };
  }

  // -------------------------------------------------------------------------
  // Download cursor (download-what's-new)
  // -------------------------------------------------------------------------

  /** The user's last-synced cursor for a pool, or null if never synced. */
  getCursor(userId: string, poolId: string): string | null {
    const row = this.db
      .prepare(`SELECT last_synced_at FROM document_download_cursor WHERE user_id = ? AND pool_id = ?`)
      .get(userId, poolId) as { last_synced_at: string } | undefined;
    return row?.last_synced_at ?? null;
  }

  /** Advance (or set) the user's sync cursor for a pool. Idempotent upsert. */
  setCursor(userId: string, poolId: string, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO document_download_cursor (user_id, pool_id, last_synced_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, pool_id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
      )
      .run(userId, poolId, syncedAt);
  }

  /**
   * Compute what's-new for a user against a pool's docs. A doc is "new" iff its
   * uploadedAt is strictly after the user's cursor (never-synced → all new).
   * Returns the new docs + the max uploadedAt among them (the cursor to advance
   * to AFTER a successful download). Pure math; docs are supplied by the caller.
   */
  whatsNew(
    userId: string,
    poolId: string,
    docs: ReadonlyArray<{ fileHash: string; uploadedAt: string }>,
  ): { newDocs: Array<{ fileHash: string; uploadedAt: string }>; nextCursor: string | null } {
    const cursor = this.getCursor(userId, poolId);
    const newDocs = docs.filter((d) => cursor === null || d.uploadedAt > cursor);
    let nextCursor: string | null = cursor;
    for (const d of newDocs) {
      if (nextCursor === null || d.uploadedAt > nextCursor) nextCursor = d.uploadedAt;
    }
    return { newDocs, nextCursor };
  }

  /** Test-only handle. */
  rawDb(): Database.Database {
    return this.db;
  }
}
