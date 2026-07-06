/**
 * DataRoomDocStore (Data-Room v2, manifest→SQLite port — PHASE 1).
 *
 * A lazy-DDL SQLite REPLICA of the per-pool JSON manifest held by
 * data-room-store.service.ts. This phase, the JSON manifest STAYS AUTHORITATIVE
 * for every READ — this table populates IN PARALLEL via write-through so the
 * existing proofs keep passing byte-identically. The read cutover is Phase 2.
 *
 * Lazy-DDL, CREATE TABLE IF NOT EXISTS on first construction — the same
 * precedent as document-read-state-store.ts / underwrite-job-store.ts (both on
 * this cre.db). No FK into engine tables: pool_id / loan_in_pool_id are SOFT
 * refs (same discipline as loan_in_pool.deal_ref); file_hash is a content hash.
 * IF NOT EXISTS makes the DDL a no-op on an existing db → the real cre.db is
 * byte-unchanged until the first write.
 *
 * ── The table ────────────────────────────────────────────────────────────────
 *
 *   data_room_doc(
 *     pool_id, loan_in_pool_id, doc_type, file_hash,   -- the composite PK
 *     file_name, mime_type, size, uploaded_at, notes,  -- the entry payload
 *     tier, ingest,                                     -- denormalized (as the manifest)
 *     seq                                               -- monotonic write-order cursor
 *   )
 *   PRIMARY KEY (pool_id, loan_in_pool_id, doc_type, file_hash)
 *
 * The PK reproduces the manifest's per-pool dedup key exactly:
 * (loanInPoolId, docType, fileHash), scoped by pool_id. A re-drop of the same
 * (loan, docType, hash) UPSERTs the SAME row (latest-wins metadata) — never a
 * duplicate — mirroring the manifest's filter-out-then-append.
 *
 * ── CATEGORY is DERIVED, never stored ────────────────────────────────────────
 *   category = DOC_TYPE_CATEGORY[docType] (the ONE source in the taxonomy). It is
 *   a pure function of doc_type, so storing it would be a second source that can
 *   drift; unlike tier/ingest — which the MANIFEST already denormalizes onto the
 *   entry — category is never on the entry. We derive it on read, exactly as
 *   projectByCategory does. (tier/ingest ARE stored: parity with the manifest's
 *   denormalized fields, and both remain re-derivable from the taxonomy as a
 *   guard.)
 *
 * ── ★★ THE SEQ TAIL-RELOCATION (the behavior-identity gate) ──────────────────
 *   `seq` is bumped to a NEW global monotonic max on EVERY write — a fresh
 *   INSERT and a CONFLICT-DO-UPDATE (a refresh/re-drop) alike:
 *
 *       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM data_room_doc)
 *
 *   So `ORDER BY seq` reproduces the manifest's `docs[]` order EXACTLY:
 *   write-order, with any refreshed row RELOCATED TO THE TAIL — byte-identical to
 *   the manifest's filter-out-then-append (re-drop moves the entry to the end of
 *   docs[]). NEVER relies on rowid (a CONFLICT-DO-UPDATE keeps the original
 *   rowid, so rowid order would leave a refreshed row in place — wrong).
 *
 * DISCIPLINE: pure I/O + the write-through replica. No read-path is changed by
 * this store existing; the service still reads the JSON manifest this phase.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DOC_TYPE_CATEGORY, docTypeById } from '@cre/contracts';
import type { DocTypeCategory, DocTypeEntry } from '@cre/contracts';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** One replicated data-room doc row. Mirrors DataRoomDocEntry + pool_id + seq. */
export interface DataRoomDocRow {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly notes: string | null;
  readonly tier: DocTypeEntry['tier'];
  readonly ingest: boolean;
  /** Monotonic write-order cursor (bumped on every write incl. refresh). */
  readonly seq: number;
}

/** The upsert payload — everything but seq (the store owns the seq bump). */
export interface DataRoomDocUpsert {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly notes: string | null;
  readonly tier: DocTypeEntry['tier'];
  readonly ingest: boolean;
}

interface DbRow {
  pool_id: string;
  loan_in_pool_id: string;
  doc_type: string;
  file_hash: string;
  file_name: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  notes: string | null;
  tier: string;
  ingest: number;
  seq: number;
}

function toRow(r: DbRow): DataRoomDocRow {
  return {
    poolId: r.pool_id,
    loanInPoolId: r.loan_in_pool_id,
    docType: r.doc_type,
    fileHash: r.file_hash,
    fileName: r.file_name,
    mimeType: r.mime_type,
    size: r.size,
    uploadedAt: r.uploaded_at,
    notes: r.notes,
    tier: r.tier as DocTypeEntry['tier'],
    ingest: r.ingest === 1,
    seq: r.seq,
  };
}

export class DataRoomDocStore {
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
   *  byte-unchanged until the first upsert. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_room_doc (
        pool_id         TEXT    NOT NULL,
        loan_in_pool_id TEXT    NOT NULL,
        doc_type        TEXT    NOT NULL,
        file_hash       TEXT    NOT NULL,
        file_name       TEXT    NOT NULL,
        mime_type       TEXT    NOT NULL,
        size            INTEGER NOT NULL,
        uploaded_at     TEXT    NOT NULL,
        notes           TEXT,
        tier            TEXT    NOT NULL,
        ingest          INTEGER NOT NULL,
        seq             INTEGER NOT NULL,
        PRIMARY KEY (pool_id, loan_in_pool_id, doc_type, file_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_data_room_doc_pool      ON data_room_doc(pool_id);
      CREATE INDEX IF NOT EXISTS idx_data_room_doc_pool_loan ON data_room_doc(pool_id, loan_in_pool_id);
      CREATE INDEX IF NOT EXISTS idx_data_room_doc_pool_hash ON data_room_doc(pool_id, file_hash);
      CREATE INDEX IF NOT EXISTS idx_data_room_doc_pool_type ON data_room_doc(pool_id, doc_type);

      CREATE TABLE IF NOT EXISTS data_room_import_marker (
        pool_id     TEXT NOT NULL PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // write-through upsert (the parallel replica of saveDataRoomDoc)
  // -------------------------------------------------------------------------

  /**
   * Upsert one doc into the table. INSERT … ON CONFLICT(pk) DO UPDATE — a re-drop
   * of the same (pool, loan, docType, hash) refreshes the SAME row (latest-wins),
   * never duplicates.
   *
   * ★★ SEQ TAIL-RELOCATION: seq is set to a NEW global monotonic max on BOTH the
   * insert AND the conflict-update — so ORDER BY seq reproduces the manifest's
   * write-order with any refreshed row relocated to the tail (filter-out-then-
   * append parity). Uses `MAX(seq)+1` (never rowid).
   */
  upsert(doc: DataRoomDocUpsert): DataRoomDocRow {
    this.db
      .prepare(
        `INSERT INTO data_room_doc
           (pool_id, loan_in_pool_id, doc_type, file_hash,
            file_name, mime_type, size, uploaded_at, notes, tier, ingest, seq)
         VALUES
           (@pool_id, @loan_in_pool_id, @doc_type, @file_hash,
            @file_name, @mime_type, @size, @uploaded_at, @notes, @tier, @ingest,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM data_room_doc))
         ON CONFLICT(pool_id, loan_in_pool_id, doc_type, file_hash) DO UPDATE SET
            file_name   = excluded.file_name,
            mime_type   = excluded.mime_type,
            size        = excluded.size,
            uploaded_at = excluded.uploaded_at,
            notes       = excluded.notes,
            tier        = excluded.tier,
            ingest      = excluded.ingest,
            seq         = (SELECT COALESCE(MAX(seq), 0) + 1 FROM data_room_doc)`,
      )
      .run({
        pool_id: doc.poolId,
        loan_in_pool_id: doc.loanInPoolId,
        doc_type: doc.docType,
        file_hash: doc.fileHash,
        file_name: doc.fileName,
        mime_type: doc.mimeType,
        size: doc.size,
        uploaded_at: doc.uploadedAt,
        notes: doc.notes,
        tier: doc.tier,
        ingest: doc.ingest ? 1 : 0,
      });
    return this.get(doc.poolId, doc.loanInPoolId, doc.docType, doc.fileHash)!;
  }

  // -------------------------------------------------------------------------
  // reads (parallel — the service still reads the JSON manifest this phase)
  // -------------------------------------------------------------------------

  /** One row by full PK, or null. */
  get(poolId: string, loanInPoolId: string, docType: string, fileHash: string): DataRoomDocRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM data_room_doc
          WHERE pool_id = ? AND loan_in_pool_id = ? AND doc_type = ? AND file_hash = ?`,
      )
      .get(poolId, loanInPoolId, docType, fileHash) as DbRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Every doc in a pool, in manifest `docs[]` order (ORDER BY seq ASC). */
  listPoolDocs(poolId: string): DataRoomDocRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM data_room_doc WHERE pool_id = ? ORDER BY seq ASC`)
      .all(poolId) as DbRow[];
    return rows.map(toRow);
  }

  /** DERIVED category for a doc row (the ONE source: DOC_TYPE_CATEGORY). Never a
   *  stored column — pure function of doc_type. */
  categoryOf(docType: string): DocTypeCategory | undefined {
    return DOC_TYPE_CATEGORY[docType];
  }

  /** Row count for a pool (parity helper). */
  countForPool(poolId: string): number {
    const r = this.db
      .prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id = ?`)
      .get(poolId) as { c: number };
    return r.c;
  }

  // -------------------------------------------------------------------------
  // marker-gated importer (backfill an existing JSON manifest → the table)
  // -------------------------------------------------------------------------

  /** Whether this pool was already imported (idempotency marker). */
  wasImported(poolId: string): boolean {
    const r = this.db
      .prepare(`SELECT 1 FROM data_room_import_marker WHERE pool_id = ?`)
      .get(poolId);
    return r !== undefined;
  }

  /**
   * Marker-gated, IDEMPOTENT, NON-LOSSY import of ONE pool's manifest `docs[]`
   * into the table. On first run: upserts every entry in `docs[]` order (ascending
   * seq — preserves the manifest order exactly) + stamps the per-pool marker.
   * On a re-run: the marker is present → a NO-OP (no dup, no seq change).
   *
   * ★ No-op in a tree with NO manifest (nothing to import). Returns the number of
   * entries imported (0 if already imported).
   */
  importPoolManifest(
    poolId: string,
    docs: ReadonlyArray<{
      loanInPoolId: string;
      docType: string;
      fileHash: string;
      fileName: string;
      mimeType: string;
      size: number;
      uploadedAt: string;
      notes: string | null;
      tier: DocTypeEntry['tier'];
      ingest: boolean;
    }>,
    importedAt: string = new Date().toISOString(),
  ): number {
    if (this.wasImported(poolId)) return 0; // idempotent — already imported

    const tx = this.db.transaction(() => {
      // Preserve docs[] order as ascending seq: upsert in array order (each bumps
      // MAX(seq)+1). A guard re-derives tier/ingest from the taxonomy when the
      // entry carries them (parity with the manifest denormalization).
      for (const d of docs) {
        const taxo = docTypeById(d.docType);
        this.upsert({
          poolId,
          loanInPoolId: d.loanInPoolId,
          docType: d.docType,
          fileHash: d.fileHash,
          fileName: d.fileName,
          mimeType: d.mimeType,
          size: d.size,
          uploadedAt: d.uploadedAt,
          notes: d.notes,
          // Prefer the entry's denormalized tier/ingest; fall back to taxonomy.
          tier: d.tier ?? (taxo?.tier as DocTypeEntry['tier']),
          ingest: d.ingest ?? (taxo?.tier === 'ingesting'),
        });
      }
      this.db
        .prepare(
          `INSERT INTO data_room_import_marker (pool_id, imported_at)
           VALUES (?, ?)
           ON CONFLICT(pool_id) DO NOTHING`,
        )
        .run(poolId, importedAt);
    });
    tx();
    return docs.length;
  }

  /** Test-only handle. */
  rawDb(): Database.Database {
    return this.db;
  }
}

/* -------------------------------------------------------------------------- */
/* Default singleton — constructed lazily so the lazy-DDL fires the FIRST time  */
/* the store is touched (a write), not at module-eval of an unrelated import.   */
/* Tests inject their own temp-db instance.                                     */
/* -------------------------------------------------------------------------- */

let _default: DataRoomDocStore | null = null;

/** The process-wide data-room-doc replica store (constructed on first access). */
export function dataRoomDocStore(): DataRoomDocStore {
  if (_default === null) _default = new DataRoomDocStore();
  return _default;
}

/** Test seam — reset the singleton so a proof can point it at a temp db. */
export function resetDataRoomDocStoreForTests(): void {
  _default = null;
}
