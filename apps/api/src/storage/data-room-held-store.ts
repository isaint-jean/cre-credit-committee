/**
 * DataRoomHeldStore (Data-Room content-routing — SLICE 3: durable never-reject).
 *
 * The DURABLE home for the "needs identification" (HELD) state — an accepted file
 * the routing cascade (folder→filename→content) could NOT confidently identify on
 * BOTH axes, so it can't sit in `data_room_doc` (whose PK is
 * (pool_id, loan_in_pool_id, doc_type, file_hash) — a held file has NO loan and/or
 * NO doc-type). Rather than leave it only in the TRANSIENT staging batch (lost on
 * restart, discarded when the batch expires — a silent "drop"), we persist it here.
 *
 * ── The three states (a held file is state 2; state 3 must NOT exist) ─────────
 *   1. ROUTED  — cascade identified both axes → `data_room_doc`, underwrites on
 *                settle.
 *   2. HELD    — this table. Accepted + kept + surfaced to a human. Carries the
 *                PARTIAL hints the cascade DID find (e.g. docType=pca, loan=null).
 *   3. dropped — MUST NOT EXIST. Every accepted file is ROUTED or HELD.
 *   (security-rejected zip entries are refused AT THE GATE — never admitted here.)
 *
 * ── The table ────────────────────────────────────────────────────────────────
 *
 *   data_room_held(
 *     pool_id, file_hash,                              -- the PK (pool-scoped, content id)
 *     file_name, mime_type, size, uploaded_at,         -- the accepted file's payload
 *     hint_doc_type, hint_loan_in_pool_id, hint_category, -- the PARTIAL cascade hints
 *     seq                                              -- monotonic write-order cursor
 *   )
 *   PRIMARY KEY (pool_id, file_hash)
 *
 * KEYED (pool_id, file_hash) — a content-addressed identity that needs NO
 * loan/doc-type (the exact reason a held file can't live in data_room_doc). A
 * re-drop of the same bytes to the same pool UPSERTs the SAME row (latest hints
 * win, seq relocates to the tail) — never a duplicate. This deliberately does NOT
 * pollute the routed PK or its dedup: routed and held are SEPARATE tables, so the
 * routed room never sees a held row and vice-versa.
 *
 * ── Why a separate table (not a status column on data_room_doc) ───────────────
 *   data_room_doc's PK REQUIRES loan_in_pool_id + doc_type (both NOT NULL). A held
 *   file has neither (or only one). A `status='held'` sentinel would force
 *   sentinel loan/docType values INTO the routed PK — polluting dedup (two held
 *   files with the same sentinel loan/docType/hash would collide) and every routed
 *   read/projection would have to filter the sentinel out. The separate table keeps
 *   the routed PK/dedup pristine and the held set is its own clean projection.
 *
 * BYTES stay in the content-addressed blob store (the SAME bytes a later routed
 * copy would read) — this table stores only the MAPPING + hints, exactly as
 * data_room_doc does. Lazy-DDL (CREATE TABLE IF NOT EXISTS) → the real cre.db is
 * byte-unchanged until the first held write. DURABLE — it's in cre.db, so a fresh
 * store (a restart) still sees every held row.
 *
 * DISCIPLINE: pure I/O. No ingest, no composer, no classify — the route wires the
 * cascade verdict to persistHeld(); this store just persists + projects + moves.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DOC_TYPE_CATEGORY } from '@cre/contracts';
import type { DocTypeCategory } from '@cre/contracts';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** One HELD (needs-identification) file row. Mirrors the accepted file + the
 *  partial cascade hints. A null hint = the cascade refused that axis. */
export interface DataRoomHeldRow {
  readonly poolId: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  /** Partial hint: the doc-type the cascade found, or null when it refused. */
  readonly hintDocType: string | null;
  /** Partial hint: the loan the cascade found, or null when it refused. */
  readonly hintLoanInPoolId: string | null;
  /** Partial hint: the browse category (from a folder tier or derived from the
   *  hint doc-type), or null. */
  readonly hintCategory: string | null;
  /** Monotonic write-order cursor (bumped on every write incl. refresh). */
  readonly seq: number;
}

/** The upsert payload — everything but seq (the store owns the seq bump). */
export interface DataRoomHeldUpsert {
  readonly poolId: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly hintDocType: string | null;
  readonly hintLoanInPoolId: string | null;
  readonly hintCategory: string | null;
}

interface DbRow {
  pool_id: string;
  file_hash: string;
  file_name: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  hint_doc_type: string | null;
  hint_loan_in_pool_id: string | null;
  hint_category: string | null;
  seq: number;
}

function toRow(r: DbRow): DataRoomHeldRow {
  return {
    poolId: r.pool_id,
    fileHash: r.file_hash,
    fileName: r.file_name,
    mimeType: r.mime_type,
    size: r.size,
    uploadedAt: r.uploaded_at,
    hintDocType: r.hint_doc_type,
    hintLoanInPoolId: r.hint_loan_in_pool_id,
    hintCategory: r.hint_category,
    seq: r.seq,
  };
}

export class DataRoomHeldStore {
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

  /** Lazy DDL — IF NOT EXISTS → no-op on an existing db, so the real cre.db is
   *  byte-unchanged until the first held upsert. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_room_held (
        pool_id              TEXT    NOT NULL,
        file_hash            TEXT    NOT NULL,
        file_name            TEXT    NOT NULL,
        mime_type            TEXT    NOT NULL,
        size                 INTEGER NOT NULL,
        uploaded_at          TEXT    NOT NULL,
        hint_doc_type        TEXT,
        hint_loan_in_pool_id TEXT,
        hint_category        TEXT,
        seq                  INTEGER NOT NULL,
        PRIMARY KEY (pool_id, file_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_data_room_held_pool ON data_room_held(pool_id);
    `);
  }

  // -------------------------------------------------------------------------
  // write — persist an accepted-but-unidentified file to the durable held set
  // -------------------------------------------------------------------------

  /**
   * Upsert one held file. INSERT … ON CONFLICT(pool_id, file_hash) DO UPDATE — a
   * re-drop of the same bytes to the same pool refreshes the SAME row (latest
   * hints + metadata win), never duplicates. seq bumps to a fresh global MAX+1 on
   * BOTH the insert AND the conflict-update, so ORDER BY seq is write-order with a
   * refreshed row relocated to the tail (same discipline as data_room_doc).
   */
  upsert(held: DataRoomHeldUpsert): DataRoomHeldRow {
    this.db
      .prepare(
        `INSERT INTO data_room_held
           (pool_id, file_hash, file_name, mime_type, size, uploaded_at,
            hint_doc_type, hint_loan_in_pool_id, hint_category, seq)
         VALUES
           (@pool_id, @file_hash, @file_name, @mime_type, @size, @uploaded_at,
            @hint_doc_type, @hint_loan_in_pool_id, @hint_category,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM data_room_held))
         ON CONFLICT(pool_id, file_hash) DO UPDATE SET
            file_name            = excluded.file_name,
            mime_type            = excluded.mime_type,
            size                 = excluded.size,
            uploaded_at          = excluded.uploaded_at,
            hint_doc_type        = excluded.hint_doc_type,
            hint_loan_in_pool_id = excluded.hint_loan_in_pool_id,
            hint_category        = excluded.hint_category,
            seq                  = (SELECT COALESCE(MAX(seq), 0) + 1 FROM data_room_held)`,
      )
      .run({
        pool_id: held.poolId,
        file_hash: held.fileHash,
        file_name: held.fileName,
        mime_type: held.mimeType,
        size: held.size,
        uploaded_at: held.uploadedAt,
        hint_doc_type: held.hintDocType,
        hint_loan_in_pool_id: held.hintLoanInPoolId,
        hint_category: held.hintCategory,
      });
    return this.get(held.poolId, held.fileHash)!;
  }

  // -------------------------------------------------------------------------
  // reads / projection — surface the "needs identification" set
  // -------------------------------------------------------------------------

  /** One held row by PK, or null. */
  get(poolId: string, fileHash: string): DataRoomHeldRow | null {
    const row = this.db
      .prepare(`SELECT * FROM data_room_held WHERE pool_id = ? AND file_hash = ?`)
      .get(poolId, fileHash) as DbRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Every held file in a pool, in write-order (ORDER BY seq ASC). The
   *  "needs identification" projection. */
  listForPool(poolId: string): DataRoomHeldRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM data_room_held WHERE pool_id = ? ORDER BY seq ASC`)
      .all(poolId) as DbRow[];
    return rows.map(toRow);
  }

  /** Held count for a pool (the "needs identification" badge). */
  countForPool(poolId: string): number {
    const r = this.db
      .prepare(`SELECT count(*) c FROM data_room_held WHERE pool_id = ?`)
      .get(poolId) as { c: number };
    return r.c;
  }

  // -------------------------------------------------------------------------
  // move — delete-from-held (the "held → routed" resolution's held half)
  // -------------------------------------------------------------------------

  /** Delete one held row (called AFTER the file is persisted into data_room_doc —
   *  a clean move, held → routed). Returns true if a row was removed. */
  delete(poolId: string, fileHash: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM data_room_held WHERE pool_id = ? AND file_hash = ?`)
      .run(poolId, fileHash);
    return info.changes > 0;
  }

  /** DERIVED category for a held doc-type hint (the ONE source: DOC_TYPE_CATEGORY).
   *  Never a substitute for the stored hint_category (which may come from a folder
   *  tier) — a helper for callers deriving from a doc-type only. */
  categoryOf(docType: string): DocTypeCategory | undefined {
    return DOC_TYPE_CATEGORY[docType];
  }

  /** Test-only handle. */
  rawDb(): Database.Database {
    return this.db;
  }
}

/* -------------------------------------------------------------------------- */
/* Default singleton — lazy so the DDL fires on the first held write, not at    */
/* module-eval of an unrelated import. Tests inject their own temp-db instance. */
/* -------------------------------------------------------------------------- */

let _default: DataRoomHeldStore | null = null;

/** The process-wide held store (constructed on first access). */
export function dataRoomHeldStore(): DataRoomHeldStore {
  if (_default === null) _default = new DataRoomHeldStore();
  return _default;
}

/** Test seam — reset the singleton so a proof can point it at a temp db. */
export function resetDataRoomHeldStoreForTests(): void {
  _default = null;
}
