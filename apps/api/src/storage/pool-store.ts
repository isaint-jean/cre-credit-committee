/**
 * PoolStore (Pool Layer PR 2) — persistence for the deal-as-collection-of-loans
 * surface. Six tables:
 *
 *   pool             — workspace container (uuid PK, mutable on currentTapeId)
 *   tape             — frozen, content-hash PK, immutable
 *   working_tape     — mutable pre-freeze tape, uuid PK (UPDATE allowed)
 *   loan_in_pool     — carry-across-tapes identity (uuid PK)
 *   loan_membership  — denormalized snapshot row, composite PK (tape_id, loan_in_pool_id)
 *   disposition      — append-only buyer-authoritative departure (content-hash PK)
 *
 * Discipline (mirrors OverlayPatchesStore + CommitteeActionsStore):
 *   - Hash-blob row shape: (id, …denormalized indexable cols…, payload). Payload
 *     is the JCS-canonical body sans id. Reads reconstruct via `{ id, ...JSON.parse(payload) }`.
 *   - Content-hash inserts (`tape`, `disposition`) use `ON CONFLICT(id) DO NOTHING`
 *     and verify `record.id === compute<Kind>Id(makeHashInput(record))` — mismatch
 *     throws `RecordIdMismatchError` (same wrapper the spine uses).
 *   - C1 hash boundary: TapeId / DispositionId EXCLUDE observability timestamps
 *     (frozenAt, receivedAt, recordedAt). See `pool.ts` §8b.
 *   - No UPDATE / DELETE on `tape`, `disposition`, or `loan_membership` — append-only
 *     / immutable invariants are structural (no method exists). `working_tape`
 *     and `loan_in_pool.current_disposition_id` are the only mutables.
 *   - dealRef is a SOFT REFERENCE (no FK into engine tables — boundary discipline,
 *     same precedent as `committee_actions.root_id`).
 *
 * Structural invariants enforced in DDL:
 *   - UNIQUE(working_tape.pool_id) — at most one open working tape per pool (D-class
 *     guard so a phantom second working tape is impossible at the storage level).
 *   - UNIQUE(tape.pool_id, version) and UNIQUE(working_tape.pool_id, version) — one
 *     tape per (pool, version).
 *   - PRIMARY KEY(loan_membership.tape_id, loan_in_pool_id) — many-to-many uniqueness.
 *
 * SCOPE BOUNDARY: PR 2 is persistence only. `freezeTape` is the storage primitive
 * that turns an already-resolved working tape into a frozen one; it does NOT decide
 * carry-over, does NOT resolve reconciliation, and REFUSES (throws) if any
 * `'unmatched-needs-confirm'` pending entry remains. The advance-tape orchestration
 * (carry-over, reconciliation UX, etc.) lands in PR 3 on top of this layer.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  Disposition,
  DispositionId,
  LoanInPool,
  LoanInPoolId,
  LoanLifecycleStatus,
  LoanMembership,
  Pool,
  PoolId,
  Tape,
  TapeId,
  WorkingTape,
  WorkingTapeId,
} from '@cre/contracts';
import {
  computeDispositionId,
  computeTapeId,
  serializeRecordBody,
} from '../util/content-hash.js';
import {
  makeDispositionIdHashInput,
  makeTapeIdHashInput,
} from '../util/pool-ids.js';
import { RecordIdMismatchError } from './record-graph-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** Thrown when a caller attempts to freeze a working tape that still carries an
 *  `'unmatched-needs-confirm'` entry. PR 3's advance-tape orchestration resolves
 *  these before calling freezeTape; the store refuses to silently drop them. */
export class WorkingTapeUnresolvedError extends Error {
  override readonly name = 'WorkingTapeUnresolvedError';
  constructor(
    public readonly workingTapeId: WorkingTapeId,
    public readonly unresolvedCount: number,
  ) {
    super(
      `working tape ${workingTapeId} cannot be frozen: ${unresolvedCount} ` +
        `pending entry/entries are still in 'unmatched-needs-confirm' state. ` +
        `Resolve all bindings before calling freezeTape.`,
    );
  }
}

/** Thrown when a caller attempts to open a second working tape for a pool that
 *  already has one. Mirrors the DDL UNIQUE(pool_id) guard with a typed wrapper. */
export class WorkingTapeAlreadyOpenError extends Error {
  override readonly name = 'WorkingTapeAlreadyOpenError';
  constructor(public readonly poolId: PoolId) {
    super(`pool ${poolId} already has an open working tape (UNIQUE pool_id)`);
  }
}

interface PoolRow      { readonly payload: string; readonly current_tape_id: string | null }
interface PayloadRow   { readonly payload: string }
interface IdPayloadRow { readonly id: string; readonly payload: string }
interface MembershipPayloadRow {
  readonly tape_id: string;
  readonly loan_in_pool_id: string;
  readonly payload: string;
}

export class PoolStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool (
        id              TEXT PRIMARY KEY,
        shelf_name      TEXT NOT NULL,
        vintage         INTEGER NOT NULL,
        seller          TEXT,
        created_at      TEXT NOT NULL,
        current_tape_id TEXT,
        closed_at       TEXT,
        payload         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pool_shelf ON pool(shelf_name, vintage);

      CREATE TABLE IF NOT EXISTS tape (
        id            TEXT PRIMARY KEY,
        pool_id       TEXT NOT NULL,
        version       INTEGER NOT NULL,
        tape_date     TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        frozen_at     TEXT NOT NULL,
        prior_tape_id TEXT,
        payload       TEXT NOT NULL,
        UNIQUE (pool_id, version),
        FOREIGN KEY (pool_id) REFERENCES pool(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tape_pool ON tape(pool_id);
      CREATE INDEX IF NOT EXISTS idx_tape_prior ON tape(prior_tape_id);

      CREATE TABLE IF NOT EXISTS working_tape (
        id            TEXT PRIMARY KEY,
        pool_id       TEXT NOT NULL UNIQUE,
        version       INTEGER NOT NULL,
        tape_date     TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        prior_tape_id TEXT,
        updated_at    TEXT NOT NULL,
        payload       TEXT NOT NULL,
        UNIQUE (pool_id, version),
        FOREIGN KEY (pool_id) REFERENCES pool(id)
      );

      CREATE TABLE IF NOT EXISTS loan_in_pool (
        id                     TEXT PRIMARY KEY,
        pool_id                TEXT NOT NULL,
        deal_ref               TEXT NOT NULL,
        added_on_tape          TEXT NOT NULL,
        originator_loan_ref    TEXT,
        property_name          TEXT,
        asset_type             TEXT,
        current_disposition_id TEXT,
        lifecycle_status       TEXT,
        payload                TEXT NOT NULL,
        FOREIGN KEY (pool_id) REFERENCES pool(id)
      );
      CREATE INDEX IF NOT EXISTS idx_loan_in_pool_pool       ON loan_in_pool(pool_id);
      CREATE INDEX IF NOT EXISTS idx_loan_in_pool_dealref    ON loan_in_pool(deal_ref);
      CREATE INDEX IF NOT EXISTS idx_loan_in_pool_originator ON loan_in_pool(pool_id, originator_loan_ref);

      CREATE TABLE IF NOT EXISTS loan_membership (
        tape_id         TEXT NOT NULL,
        loan_in_pool_id TEXT NOT NULL,
        pool_id         TEXT NOT NULL,
        status          TEXT NOT NULL,
        tape_position   INTEGER NOT NULL,
        deal_ref        TEXT NOT NULL,
        payload         TEXT NOT NULL,
        PRIMARY KEY (tape_id, loan_in_pool_id),
        FOREIGN KEY (tape_id)         REFERENCES tape(id),
        FOREIGN KEY (loan_in_pool_id) REFERENCES loan_in_pool(id),
        FOREIGN KEY (pool_id)         REFERENCES pool(id)
      );
      CREATE INDEX IF NOT EXISTS idx_loan_membership_loan ON loan_membership(loan_in_pool_id);
      CREATE INDEX IF NOT EXISTS idx_loan_membership_pool ON loan_membership(pool_id);

      CREATE TABLE IF NOT EXISTS disposition (
        id                TEXT PRIMARY KEY,
        pool_id           TEXT NOT NULL,
        loan_in_pool_id   TEXT NOT NULL,
        last_seen_on_tape TEXT NOT NULL,
        left_on_tape      TEXT NOT NULL,
        originator_label  TEXT NOT NULL,
        buyer_label       TEXT NOT NULL,
        override_flag     INTEGER NOT NULL,
        supersedes        TEXT,
        recorded_at       TEXT NOT NULL,
        payload           TEXT NOT NULL,
        FOREIGN KEY (pool_id)         REFERENCES pool(id),
        FOREIGN KEY (loan_in_pool_id) REFERENCES loan_in_pool(id),
        FOREIGN KEY (last_seen_on_tape) REFERENCES tape(id),
        FOREIGN KEY (left_on_tape)      REFERENCES tape(id)
      );
      CREATE INDEX IF NOT EXISTS idx_disposition_pool      ON disposition(pool_id);
      CREATE INDEX IF NOT EXISTS idx_disposition_loan      ON disposition(loan_in_pool_id);
      CREATE INDEX IF NOT EXISTS idx_disposition_overrides ON disposition(pool_id, override_flag);
    `);

    // Defensive, idempotent lazy ALTER (P4c-status). `loan_in_pool` is eagerly
    // created above with a fixed column list, so a pre-existing cre.db table does
    // NOT auto-carry the pool-lifecycle `lifecycle_status` column. Add it if
    // absent — mirrors the overlay_patches `side`-column pattern. Nullable, NO
    // backfill: `null` is the correct "no positive terminal reached" state for
    // every existing row. New tables already carry it via the CREATE above; on
    // those this SELECT sees the column and the ALTER is skipped.
    const hasLifecycleStatus = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('loan_in_pool') WHERE name = 'lifecycle_status'`)
      .get();
    if (!hasLifecycleStatus) {
      this.db.exec(`ALTER TABLE loan_in_pool ADD COLUMN lifecycle_status TEXT`);
    }
  }

  /* -------------------------- Pool ------------------------------------- */

  createPool(pool: Pool): void {
    const { id, ...body } = pool;
    const payload = JSON.stringify(body);
    this.db
      .prepare(
        `INSERT INTO pool (id, shelf_name, vintage, seller, created_at, current_tape_id, closed_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pool.shelfName, pool.vintage, pool.seller, pool.createdAt, pool.currentTapeId, pool.closedAt, payload);
  }

  getPool(id: PoolId): Pool | null {
    const row = this.db
      .prepare(`SELECT payload, current_tape_id FROM pool WHERE id = ?`)
      .get(id) as PoolRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    // Refresh the mutable `currentTapeId` from its column (canonical source of truth)
    return { id, ...body, currentTapeId: row.current_tape_id } as Pool;
  }

  listPools(filter?: { readonly vintage?: number; readonly seller?: string }): readonly Pool[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filter?.vintage !== undefined) { wheres.push('vintage = ?'); params.push(filter.vintage); }
    if (filter?.seller !== undefined)  { wheres.push('seller = ?');  params.push(filter.seller); }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT id, payload, current_tape_id FROM pool ${whereClause} ORDER BY created_at`)
      .all(...params) as Array<{ readonly id: string } & PoolRow>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body, currentTapeId: r.current_tape_id } as Pool;
    });
  }

  /** Update `pool.currentTapeId` after a successful freeze. The Pool record is
   *  the only mutable handle in this layer; everything else is append-only or
   *  derived. */
  setCurrentTape(poolId: PoolId, tapeId: TapeId): void {
    this.db.prepare(`UPDATE pool SET current_tape_id = ? WHERE id = ?`).run(tapeId, poolId);
  }

  /* ------------------------ Working tape ------------------------------- */

  insertWorkingTape(wt: WorkingTape): void {
    const { id, ...body } = wt;
    const payload = JSON.stringify(body);
    try {
      this.db
        .prepare(
          `INSERT INTO working_tape
           (id, pool_id, version, tape_date, received_at, prior_tape_id, updated_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, wt.poolId, wt.version, wt.tapeDate, wt.receivedAt, wt.priorTapeId,
          new Date().toISOString(), payload,
        );
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // SQLite UNIQUE(pool_id) violation → typed wrapper.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && (err.message ?? '').includes('working_tape.pool_id')) {
        throw new WorkingTapeAlreadyOpenError(wt.poolId);
      }
      throw e;
    }
  }

  getWorkingTape(id: WorkingTapeId): WorkingTape | null {
    const row = this.db
      .prepare(`SELECT payload FROM working_tape WHERE id = ?`)
      .get(id) as PayloadRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id, ...body } as WorkingTape;
  }

  /** D3: derive the current open working tape for a pool via SQL. The Pool type
   *  intentionally does NOT carry this pointer (avoids cache-vs-truth drift). */
  getCurrentWorkingTape(poolId: PoolId): WorkingTape | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM working_tape WHERE pool_id = ?`)
      .get(poolId) as IdPayloadRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as WorkingTape;
  }

  /** PR3: rewrite the working tape's body (status edits, resolution of pending
   *  entries). UPDATE only — the WorkingTape is the one mutable record in this
   *  layer. The id and pool_id are not changed; everything else can move.
   *  Throws if the working tape doesn't exist. */
  updateWorkingTape(wt: WorkingTape): void {
    const { id, ...body } = wt;
    const payload = JSON.stringify(body);
    const result = this.db
      .prepare(
        `UPDATE working_tape
         SET version = ?, tape_date = ?, received_at = ?, prior_tape_id = ?,
             updated_at = ?, payload = ?
         WHERE id = ?`,
      )
      .run(
        wt.version, wt.tapeDate, wt.receivedAt, wt.priorTapeId,
        new Date().toISOString(), payload, id,
      );
    if (result.changes === 0) {
      throw new Error(`updateWorkingTape: working tape ${id} not found`);
    }
  }

  /**
   * Storage-only freeze. Reads the working tape, validates that NO pending entry
   * is still `'unmatched-needs-confirm'`, projects each `'bound'` /
   * `'new-loan-confirmed'` entry to a `LoanMembership`, computes the `TapeId`
   * from the hash input (C1: timestamps excluded), persists the frozen `Tape` +
   * `loan_membership` rows, drops the working tape, and returns the new `Tape`.
   *
   * NOTE: this does NOT do carry-over, does NOT mint LoanInPool records for
   * `'new-loan-confirmed'` entries, and does NOT update `pool.currentTapeId`.
   * Those are PR 3's orchestration responsibilities. PR 2 supplies a clean
   * persistence primitive that a higher-level operation can compose.
   *
   * Refuses to freeze if any pending entry is `'unmatched-needs-confirm'` —
   * silently dropping it would mis-carry a re-keyed loan into a phantom
   * departure (the exact bug the discriminated union prevents at the type level).
   */
  freezeTape(workingTapeId: WorkingTapeId, frozenAt: string): Tape {
    const wt = this.getWorkingTape(workingTapeId);
    if (!wt) throw new Error(`working tape ${workingTapeId} not found`);

    const unresolved = wt.pendingMembership.filter((e) => e.kind === 'unmatched-needs-confirm');
    if (unresolved.length > 0) {
      throw new WorkingTapeUnresolvedError(workingTapeId, unresolved.length);
    }

    const membership: LoanMembership[] = wt.pendingMembership.map((entry) => {
      if (entry.kind === 'bound') return entry.binding;
      if (entry.kind === 'new-loan-confirmed') {
        // PR-2 NOTE: PR-3's orchestration mints the LoanInPoolId and persists the
        // LoanInPool record BEFORE calling freezeTape. By the time this code runs,
        // the orchestration must have rewritten `new-loan-confirmed` entries to
        // `bound`. If we ever see one here, the orchestration violated its
        // contract — refuse to fabricate a LoanInPoolId.
        throw new Error(
          `freezeTape: 'new-loan-confirmed' pending entry not yet promoted to 'bound' ` +
            `(orchestration must mint LoanInPool + rewrite to bound before freezing)`,
        );
      }
      // Unreachable due to the unresolved check above, but the structural narrow
      // is what makes the membership array typed.
      throw new Error('unreachable: unresolved pending entry survived the guard');
    });

    const hashInput = {
      poolId:            wt.poolId,
      version:           wt.version,
      tapeDate:          wt.tapeDate,
      priorTapeId:       wt.priorTapeId,
      membership,
      originatorSummary: wt.originatorSummary,
    };
    const tapeId = computeTapeId(hashInput);

    const tape: Tape = {
      id: tapeId,
      poolId:            wt.poolId,
      version:           wt.version,
      tapeDate:          wt.tapeDate,
      receivedAt:        wt.receivedAt,
      frozenAt,
      priorTapeId:       wt.priorTapeId,
      membership,
      originatorSummary: wt.originatorSummary,
    };

    const tx = this.db.transaction(() => {
      this.insertTape(tape);
      this.insertMembershipBatch(tape.id, tape.poolId, membership);
      this.db.prepare(`DELETE FROM working_tape WHERE id = ?`).run(workingTapeId);
    });
    tx();

    return tape;
  }

  /* -------------------------- Tape ------------------------------------- */

  /** Direct frozen-tape insert. Verifies the producer's `tape.id` matches the
   *  recomputed `computeTapeId(makeTapeIdHashInput(tape))`. ON CONFLICT(id) DO
   *  NOTHING — idempotent re-insert. */
  insertTape(tape: Tape): { inserted: boolean } {
    const computedId = computeTapeId(makeTapeIdHashInput(tape));
    if (tape.id !== computedId) {
      throw new RecordIdMismatchError('Tape', tape.id, computedId);
    }
    const { id, ...body } = tape;
    const payload = JSON.stringify(body);
    const result = this.db
      .prepare(
        `INSERT INTO tape (id, pool_id, version, tape_date, received_at, frozen_at, prior_tape_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, tape.poolId, tape.version, tape.tapeDate, tape.receivedAt, tape.frozenAt, tape.priorTapeId, payload);
    return { inserted: result.changes > 0 };
  }

  getTape(id: TapeId): Tape | null {
    const row = this.db.prepare(`SELECT payload FROM tape WHERE id = ?`).get(id) as PayloadRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id, ...body } as Tape;
  }

  /** O(1) pool-as-of-tape — one row read returns the entire frozen snapshot.
   *  This is the read property snapshot-storage was chosen for. */
  getMembership(tapeId: TapeId): readonly LoanMembership[] {
    const rows = this.db
      .prepare(
        `SELECT tape_id, loan_in_pool_id, payload FROM loan_membership
         WHERE tape_id = ? ORDER BY tape_position`,
      )
      .all(tapeId) as readonly MembershipPayloadRow[];
    return rows.map((r) => JSON.parse(r.payload) as LoanMembership);
  }

  /** History of one loan across every tape it appeared on. */
  getLoanHistory(loanInPoolId: LoanInPoolId): readonly LoanMembership[] {
    const rows = this.db
      .prepare(
        `SELECT lm.tape_id, lm.loan_in_pool_id, lm.payload
         FROM loan_membership lm
         JOIN tape t ON t.id = lm.tape_id
         WHERE lm.loan_in_pool_id = ?
         ORDER BY t.version`,
      )
      .all(loanInPoolId) as readonly MembershipPayloadRow[];
    return rows.map((r) => JSON.parse(r.payload) as LoanMembership);
  }

  /** Batch insert membership rows for a freshly persisted tape. Called inside the
   *  freezeTape transaction. */
  private insertMembershipBatch(tapeId: TapeId, poolId: PoolId, membership: readonly LoanMembership[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO loan_membership
       (tape_id, loan_in_pool_id, pool_id, status, tape_position, deal_ref, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of membership) {
      stmt.run(tapeId, m.loanInPoolId, poolId, m.status, m.tapePosition, m.dealRef, JSON.stringify(m));
    }
  }

  /* ------------------------ LoanInPool --------------------------------- */

  insertLoanInPool(loan: LoanInPool): void {
    const { id, ...body } = loan;
    const payload = JSON.stringify(body);
    this.db
      .prepare(
        `INSERT INTO loan_in_pool
         (id, pool_id, deal_ref, added_on_tape, originator_loan_ref, property_name, asset_type,
          current_disposition_id, lifecycle_status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, loan.poolId, loan.dealRef, loan.addedOnTape, loan.originatorLoanRef,
        loan.propertyName, loan.assetType, loan.currentDispositionId,
        loan.lifecycleStatus ?? null, payload,
      );
  }

  getLoanInPool(id: LoanInPoolId): LoanInPool | null {
    const row = this.db
      .prepare(`SELECT payload, current_disposition_id, lifecycle_status FROM loan_in_pool WHERE id = ?`)
      .get(id) as
      | ({ readonly current_disposition_id: string | null; readonly lifecycle_status: string | null } & PayloadRow)
      | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    // Refresh both mutable columns from their canonical column source of truth
    // (the payload is a stale identity-time copy for these two fields).
    return {
      id,
      ...body,
      currentDispositionId: row.current_disposition_id,
      lifecycleStatus: (row.lifecycle_status as LoanLifecycleStatus | null),
    } as LoanInPool;
  }

  setCurrentDisposition(loanInPoolId: LoanInPoolId, dispositionId: DispositionId): void {
    this.db
      .prepare(`UPDATE loan_in_pool SET current_disposition_id = ? WHERE id = ?`)
      .run(dispositionId, loanInPoolId);
  }

  /** P4c-status: set the per-loan positive-terminal lifecycle status. Mirrors
   *  `setCurrentDisposition` — a one-line UPDATE on the mutable `loan_in_pool`.
   *  Legality (Cleared re-derivation, departure-exclusion, idempotency) is the
   *  route/service layer's job; the store just persists what it's given. The
   *  `lifecycle_status` column is the canonical source `getLoanInPool` reads back
   *  (the payload copy is not rewritten — same discipline as
   *  `current_disposition_id`, which lives only in its column). */
  setLifecycleStatus(loanInPoolId: LoanInPoolId, status: LoanLifecycleStatus): void {
    this.db
      .prepare(`UPDATE loan_in_pool SET lifecycle_status = ? WHERE id = ?`)
      .run(status, loanInPoolId);
  }

  /** P4c-status: the final tape — every loan in the pool whose per-loan
   *  lifecycle status is `'closed'`. This is the PER-LOAN Closed read, decoupled
   *  from `pool.closed_at` (the pool-level seal). A pool accumulates Closed loans
   *  before the pool itself seals. Ordered by `added_on_tape` for a stable view. */
  getFinalTape(poolId: PoolId): readonly LoanInPool[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload, current_disposition_id, lifecycle_status
         FROM loan_in_pool
         WHERE pool_id = ? AND lifecycle_status = 'closed'
         ORDER BY added_on_tape`,
      )
      .all(poolId) as ReadonlyArray<
        { readonly id: string; readonly current_disposition_id: string | null; readonly lifecycle_status: string | null } & PayloadRow
      >;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        id: r.id,
        ...body,
        currentDispositionId: r.current_disposition_id,
        lifecycleStatus: (r.lifecycle_status as LoanLifecycleStatus | null),
      } as LoanInPool;
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Forward root→loan resolver reads (Phase A). Two NARROW read-only projections */
  /* consumed by `resolveLoanForRoot` (services/pool/resolve-loan-for-root.ts).   */
  /* They are the FORWARD counterparts of the reverse pool-lookup that            */
  /* `sqlite-store.lookupAnalysisByDealRef` PASS-2 walks: instead of pool-loan →   */
  /* root, the resolver goes root → pool-loan, and needs (1) exact-deal_ref rows   */
  /* and (2) the full {id, pool_id, originator_loan_ref, property_name} projection */
  /* to run the SAME normalized-name bridge forward. Kept in the store so all SQL  */
  /* lives in the storage layer; no business logic here.                          */
  /* -------------------------------------------------------------------------- */

  /** PASS 1 (exact) source: every pool loan whose `deal_ref` equals `dealRef`.
   *  Indexed by `idx_loan_in_pool_dealref`. Returns id+pool_id only (identity). */
  findLoansByExactDealRef(dealRef: string): ReadonlyArray<{
    readonly loanInPoolId: LoanInPoolId;
    readonly poolId: PoolId;
  }> {
    const rows = this.db
      .prepare(`SELECT id, pool_id FROM loan_in_pool WHERE deal_ref = ?`)
      .all(dealRef) as ReadonlyArray<{ readonly id: string; readonly pool_id: string }>;
    return rows.map((r) => ({
      loanInPoolId: r.id as LoanInPoolId,
      poolId: r.pool_id as PoolId,
    }));
  }

  /** PASS 2 (normalized-name bridge) source: the identity + name columns of every
   *  pool loan. N is small (one row per loan ever pooled); the resolver filters
   *  in JS by normalized-name equality, exactly as `lookupAnalysisByDealRef`
   *  PASS-2 does over the analyses side — keeping the SQL portable (no UDF). */
  listLoanNameKeys(): ReadonlyArray<{
    readonly loanInPoolId: LoanInPoolId;
    readonly poolId: PoolId;
    readonly originatorLoanRef: string | null;
    readonly propertyName: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, pool_id, originator_loan_ref, property_name FROM loan_in_pool`,
      )
      .all() as ReadonlyArray<{
        readonly id: string;
        readonly pool_id: string;
        readonly originator_loan_ref: string | null;
        readonly property_name: string | null;
      }>;
    return rows.map((r) => ({
      loanInPoolId: r.id as LoanInPoolId,
      poolId: r.pool_id as PoolId,
      originatorLoanRef: r.originator_loan_ref,
      propertyName: r.property_name,
    }));
  }

  /** PR3: when a buyer resolves a re-key (incoming originatorRef differs from
   *  the stored one), update the stored ref so the NEXT tape's exact-match
   *  succeeds without re-triggering the unmatched-needs-confirm flow. The
   *  per-tape history of incoming refs is preserved in each tape's bound-entry
   *  `incomingOriginatorRef` field (the tape payload), so this UPDATE does not
   *  destroy audit. */
  updateOriginatorLoanRef(loanInPoolId: LoanInPoolId, newRef: string | null): void {
    this.db
      .prepare(`UPDATE loan_in_pool SET originator_loan_ref = ? WHERE id = ?`)
      .run(newRef, loanInPoolId);
    // Also rewrite the payload column so getLoanInPool reads the new value.
    const row = this.db
      .prepare(`SELECT payload FROM loan_in_pool WHERE id = ?`)
      .get(loanInPoolId) as PayloadRow | undefined;
    if (!row) return;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    body['originatorLoanRef'] = newRef;
    this.db
      .prepare(`UPDATE loan_in_pool SET payload = ? WHERE id = ?`)
      .run(JSON.stringify(body), loanInPoolId);
  }

  /* ------------------------- Disposition ------------------------------- */

  /** Append-only record. Verifies `disposition.id === computeDispositionId(hashInput)`.
   *  Idempotent via ON CONFLICT(id) DO NOTHING. */
  recordDisposition(disposition: Disposition): { inserted: boolean } {
    const computedId = computeDispositionId(makeDispositionIdHashInput(disposition));
    if (disposition.id !== computedId) {
      throw new RecordIdMismatchError('Disposition', disposition.id, computedId);
    }
    const { id, ...body } = disposition;
    const payload = JSON.stringify(body);
    const result = this.db
      .prepare(
        `INSERT INTO disposition
         (id, pool_id, loan_in_pool_id, last_seen_on_tape, left_on_tape,
          originator_label, buyer_label, override_flag, supersedes, recorded_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id, disposition.poolId, disposition.loanInPoolId,
        disposition.lastSeenOnTape, disposition.leftOnTape,
        disposition.originatorLabel, disposition.buyerLabel,
        disposition.override ? 1 : 0, disposition.supersedes,
        disposition.recordedAt, payload,
      );
    return { inserted: result.changes > 0 };
  }

  getDispositions(poolId: PoolId): readonly Disposition[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM disposition
         WHERE pool_id = ?
         ORDER BY recorded_at`,
      )
      .all(poolId) as readonly IdPayloadRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as Disposition;
    });
  }

  getOverrides(poolId: PoolId): readonly Disposition[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM disposition
         WHERE pool_id = ? AND override_flag = 1
         ORDER BY recorded_at`,
      )
      .all(poolId) as readonly IdPayloadRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as Disposition;
    });
  }

  close(): void {
    this.db.close();
  }
}
