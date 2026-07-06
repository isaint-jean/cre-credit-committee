/**
 * UnderwriteJobStore (Data-Room Phase 3, P3 — the durable job queue).
 *
 * An earlier P2 fan-out fired `underwriteLoan` FIRE-AND-FORGET (since removed) —
 * an in-memory Promise that is LOST on a process restart. P3 makes the fan-out
 * DURABLE: the settle enqueues a persisted `underwrite_job` row; an in-process
 * worker drains it OFF the request path; a boot re-claim guarantees no in-flight
 * job is silently dropped when the process dies mid-extraction.
 *
 * ── The table (lazy-DDL, CREATE TABLE IF NOT EXISTS on first construction, the
 *    document-read-state-store precedent — NO FK into engine tables; pool_id /
 *    loan_in_pool_id are SOFT refs, same as loan_in_pool.deal_ref) ─────────────
 *
 *   underwrite_job(
 *     id, pool_id, loan_in_pool_id,
 *     state ∈ pending | running | done | failed | interrupted,
 *     reason,                       -- failure/interrupt reason (honest, null on ok)
 *     created_at, updated_at
 *   )
 *
 * ── DEDUP (one-per-loan through the queue) ───────────────────────────────────
 *   `enqueue` is a no-op when the loan ALREADY has an ACTIVE (pending|running)
 *   job — it returns the existing job instead of minting a second. This preserves
 *   P2's one-append-per-loan invariant THROUGH the queue: a settle that re-fires
 *   for the same loan (or a double-settle) cannot stack two ingests → no duplicate
 *   child revision from queue duplication.
 *
 * ── claimNext (atomic) ───────────────────────────────────────────────────────
 *   `UPDATE … SET state='running' WHERE id = (SELECT id … state='pending' … LIMIT 1)`
 *   in ONE statement — better-sqlite3 is synchronous + single-threaded, so the
 *   claim + flip is atomic within the process. Returns the claimed row or null.
 *
 * ── BOOT RE-CLAIM (the load-bearing durability piece) ────────────────────────
 *   On construction, any row left `state='running'` is a job whose process died
 *   mid-flight. We mark it `interrupted` (NOT silently dropped, NOT blindly
 *   re-run). RATIONALE: `underwriteLoan`'s append path is NOT idempotent — a blind
 *   re-run mints a SECOND child revision. `interrupted` is HONEST (the outcome is
 *   unknown — the append may have committed before the crash) and DUPLICATE-FREE
 *   (nothing re-runs automatically). The chip surfaces it; the operator re-runs it
 *   via the manual "Underwrite now" (a deliberate, one-child re-append) if desired.
 *   The rule held: never-silently-drop AND never-duplicate-child.
 *
 * DISCIPLINE: pure I/O + the state machine. NO underwriteLoan import (the WORKER
 * owns that seam) — this store never runs an ingest, only records job state.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export type UnderwriteJobState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';

/** The active (still-owed-a-drain) states. Dedup + claim key off these. */
export const ACTIVE_STATES: readonly UnderwriteJobState[] = ['pending', 'running'];

export interface UnderwriteJob {
  readonly id: string;
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly state: UnderwriteJobState;
  /** Failure/interrupt reason — null on pending/running/done. */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface JobRow {
  id: string;
  pool_id: string;
  loan_in_pool_id: string;
  state: UnderwriteJobState;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(r: JobRow): UnderwriteJob {
  return {
    id: r.id,
    poolId: r.pool_id,
    loanInPoolId: r.loan_in_pool_id,
    state: r.state,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class UnderwriteJobStore {
  private readonly db: Database.Database;

  /** How many rows the boot re-claim marked `interrupted` on construction —
   *  surfaced for the restart-durability proof + boot logging. */
  readonly bootReclaimedCount: number;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.bootReclaimedCount = this.reclaimInterruptedOnBoot();
  }

  /** Lazy DDL — IF NOT EXISTS → no-op on an existing db, so the real cre.db is
   *  byte-unchanged until the first enqueue. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS underwrite_job (
        id              TEXT NOT NULL PRIMARY KEY,
        pool_id         TEXT NOT NULL,
        loan_in_pool_id TEXT NOT NULL,
        state           TEXT NOT NULL,
        reason          TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_underwrite_job_pool  ON underwrite_job(pool_id);
      CREATE INDEX IF NOT EXISTS idx_underwrite_job_loan  ON underwrite_job(loan_in_pool_id);
      CREATE INDEX IF NOT EXISTS idx_underwrite_job_state ON underwrite_job(state);
    `);
  }

  /**
   * BOOT RE-CLAIM. Any `running` row is a job whose process died mid-flight →
   * mark it `interrupted` (honest, no duplicate child). Returns the count.
   * Idempotent: on a clean boot there are no `running` rows → a no-op (and, since
   * the table may not even exist yet on a virgin db, it was just CREATEd above).
   */
  private reclaimInterruptedOnBoot(): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE underwrite_job
            SET state = 'interrupted',
                reason = COALESCE(reason, 'process restarted while this job was in flight — outcome unknown; re-run to underwrite'),
                updated_at = ?
          WHERE state = 'running'`,
      )
      .run(now);
    return info.changes;
  }

  // -------------------------------------------------------------------------
  // enqueue (dedup — one ACTIVE job per loan)
  // -------------------------------------------------------------------------

  /**
   * Enqueue a job for (pool, loan). DEDUP: if the loan already has an ACTIVE
   * (pending|running) job, return THAT job unchanged (created:false) — do NOT
   * mint a second. Otherwise insert a fresh `pending` row (created:true).
   */
  enqueue(poolId: string, loanInPoolId: string): { job: UnderwriteJob; created: boolean } {
    const existing = this.getActiveForLoan(loanInPoolId);
    if (existing !== null) return { job: existing, created: false };

    const now = new Date().toISOString();
    const row: JobRow = {
      id: uuid(),
      pool_id: poolId,
      loan_in_pool_id: loanInPoolId,
      state: 'pending',
      reason: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO underwrite_job (id, pool_id, loan_in_pool_id, state, reason, created_at, updated_at)
         VALUES (@id, @pool_id, @loan_in_pool_id, @state, @reason, @created_at, @updated_at)`,
      )
      .run(row);
    return { job: toJob(row), created: true };
  }

  // -------------------------------------------------------------------------
  // claimNext (atomic pending → running)
  // -------------------------------------------------------------------------

  /**
   * Atomically claim ONE pending job → flip it to `running` and return it, or
   * null when the queue is empty. The UPDATE targets a single pending id chosen
   * in the same statement (better-sqlite3 is synchronous + single-threaded, so no
   * two claims can race the same row within the process). Oldest-first (FIFO).
   */
  claimNext(): UnderwriteJob | null {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE underwrite_job
            SET state = 'running', updated_at = ?
          WHERE id = (
            SELECT id FROM underwrite_job
             WHERE state = 'pending'
             ORDER BY created_at ASC, id ASC
             LIMIT 1
          )`,
      )
      .run(now);
    if (info.changes === 0) return null;
    // Re-read the just-claimed running row. Since we FIFO-pick and only THIS call
    // flips pending→running, the newest `running` by updated_at is ours.
    const row = this.db
      .prepare(
        `SELECT * FROM underwrite_job WHERE state = 'running' AND updated_at = ?
          ORDER BY created_at ASC LIMIT 1`,
      )
      .get(now) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  // -------------------------------------------------------------------------
  // terminal transitions
  // -------------------------------------------------------------------------

  /** Mark a job `done` (successful drain). Clears any reason. */
  markDone(jobId: string): void {
    this.db
      .prepare(`UPDATE underwrite_job SET state = 'done', reason = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), jobId);
  }

  /** Mark a job `failed` with the REAL reason (never a fake success). */
  markFailed(jobId: string, reason: string): void {
    this.db
      .prepare(`UPDATE underwrite_job SET state = 'failed', reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, new Date().toISOString(), jobId);
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /** The loan's ACTIVE (pending|running) job, or null. Dedup + chip key off this. */
  getActiveForLoan(loanInPoolId: string): UnderwriteJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM underwrite_job
          WHERE loan_in_pool_id = ? AND state IN ('pending','running')
          ORDER BY created_at ASC LIMIT 1`,
      )
      .get(loanInPoolId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** The loan's MOST RECENT job in ANY state (the chip's per-loan status source). */
  getLatestForLoan(loanInPoolId: string): UnderwriteJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM underwrite_job WHERE loan_in_pool_id = ?
          ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get(loanInPoolId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** All jobs for a pool (newest first) — the pool-level chip feed. */
  getJobsForPool(poolId: string): UnderwriteJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM underwrite_job WHERE pool_id = ? ORDER BY updated_at DESC, created_at DESC`)
      .all(poolId) as JobRow[];
    return rows.map(toJob);
  }

  /** All jobs (any pool) currently pending — the worker's drain candidates. */
  hasPending(): boolean {
    const row = this.db.prepare(`SELECT 1 FROM underwrite_job WHERE state = 'pending' LIMIT 1`).get();
    return row !== undefined;
  }

  /** Fetch one job by id. */
  getJob(jobId: string): UnderwriteJob | null {
    const row = this.db.prepare(`SELECT * FROM underwrite_job WHERE id = ?`).get(jobId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** Test-only handle. */
  rawDb(): Database.Database {
    return this.db;
  }
}

/* -------------------------------------------------------------------------- */
/* Default singleton — constructed lazily so the boot re-claim runs the FIRST   */
/* time the store is touched (server boot imports it), not at module-eval of an */
/* unrelated import. Tests inject their own temp-db instance.                   */
/* -------------------------------------------------------------------------- */

let _default: UnderwriteJobStore | null = null;

/** The process-wide job store (constructed on first access → boot re-claim fires). */
export function underwriteJobStore(): UnderwriteJobStore {
  if (_default === null) _default = new UnderwriteJobStore();
  return _default;
}
