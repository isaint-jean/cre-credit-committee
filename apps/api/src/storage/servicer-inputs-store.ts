/**
 * ServicerInputsStore — Phase 2: fillable human-in-the-loop inputs the SERVICER
 * enters (site visits, and later broker feedback / tab commentary / comps) that
 * flow into the workbook + memo.
 *
 * ★ DISPLAY-ONLY / MINT-SAFE. This store is OUTSIDE the content-hashed doctrine
 *   graph (like disposition / the underwrite-job queue — soft refs, no FK into
 *   engine tables). A servicer note is ADDITIVE annotation: it renders in the memo
 *   / workbook but NEVER re-scores (the honest-floor HITL-decoupled discipline).
 *   It is NOT the shelved overlay-comments store (that's behind NEGOTIATION_LOOP_
 *   ENABLED); this works with the negotiation loop OFF (the default).
 *
 * ── The table (lazy-DDL, CREATE TABLE IF NOT EXISTS on first construction) ──────
 *   servicer_inputs(
 *     pool_id, loan_in_pool_id, field_type,   -- PK; field_type e.g. 'site_visit'
 *     value,                                   -- narrative text (v1). Structured
 *                                              -- field types (comps) will add a
 *                                              -- JSON payload column later.
 *     author, updated_at
 *   )
 *
 * UPSERT: one row per (loan, field_type) — a re-save overwrites (last write wins),
 * stamping author + updated_at. Additive: extend `field_type` for broker_feedback /
 * tab_commentary; a future structured shape (comps) rides a sibling column.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** The human-input field types (extend as broker/commentary/comps land).
 *  'site_visit_checklist' is a STRUCTURED field — its `value` is a JSON payload
 *  (checklist state), not narrative text; it rides the same TEXT column. */
export type ServicerInputFieldType = 'site_visit' | 'broker_feedback' | 'tab_commentary' | 'site_visit_checklist' | 'site_photos' | 'portfolio_structure' | 'sales_comps' | 'lease_comps' | 'site_inspection';

export interface ServicerInput {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly fieldType: ServicerInputFieldType;
  readonly value: string;
  readonly author: string;
  readonly updatedAt: string;
}

interface Row {
  pool_id: string;
  loan_in_pool_id: string;
  field_type: ServicerInputFieldType;
  value: string;
  author: string;
  updated_at: string;
}

function toInput(r: Row): ServicerInput {
  return {
    poolId: r.pool_id,
    loanInPoolId: r.loan_in_pool_id,
    fieldType: r.field_type,
    value: r.value,
    author: r.author,
    updatedAt: r.updated_at,
  };
}

export class ServicerInputsStore {
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

  /** Lazy DDL — IF NOT EXISTS → no-op on an existing db (cre.db byte-unchanged
   *  until the first upsert). */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servicer_inputs (
        pool_id         TEXT NOT NULL,
        loan_in_pool_id TEXT NOT NULL,
        field_type      TEXT NOT NULL,
        value           TEXT NOT NULL,
        author          TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (pool_id, loan_in_pool_id, field_type)
      );
      CREATE INDEX IF NOT EXISTS idx_servicer_inputs_loan ON servicer_inputs(pool_id, loan_in_pool_id);
    `);
  }

  /** All human inputs for a loan (any field type). */
  listForLoan(poolId: string, loanInPoolId: string): ServicerInput[] {
    const rows = this.db
      .prepare(`SELECT * FROM servicer_inputs WHERE pool_id = ? AND loan_in_pool_id = ? ORDER BY field_type`)
      .all(poolId, loanInPoolId) as Row[];
    return rows.map(toInput);
  }

  /** One field for a loan, or null. */
  getOne(poolId: string, loanInPoolId: string, fieldType: ServicerInputFieldType): ServicerInput | null {
    const row = this.db
      .prepare(`SELECT * FROM servicer_inputs WHERE pool_id = ? AND loan_in_pool_id = ? AND field_type = ?`)
      .get(poolId, loanInPoolId, fieldType) as Row | undefined;
    return row ? toInput(row) : null;
  }

  /** Upsert one field (last write wins), stamping author + updated_at server-side. */
  upsert(args: {
    poolId: string;
    loanInPoolId: string;
    fieldType: ServicerInputFieldType;
    value: string;
    author: string;
    now: string;
  }): ServicerInput {
    const row: Row = {
      pool_id: args.poolId,
      loan_in_pool_id: args.loanInPoolId,
      field_type: args.fieldType,
      value: args.value,
      author: args.author,
      updated_at: args.now,
    };
    this.db
      .prepare(
        `INSERT INTO servicer_inputs (pool_id, loan_in_pool_id, field_type, value, author, updated_at)
         VALUES (@pool_id, @loan_in_pool_id, @field_type, @value, @author, @updated_at)
         ON CONFLICT(pool_id, loan_in_pool_id, field_type)
           DO UPDATE SET value = excluded.value, author = excluded.author, updated_at = excluded.updated_at`,
      )
      .run(row);
    return toInput(row);
  }

  /** Test-only handle. */
  rawDb(): Database.Database {
    return this.db;
  }
}

/* -------------------------------------------------------------------------- */
/* Default singleton — constructed lazily (first touch runs the lazy DDL).     */
/* -------------------------------------------------------------------------- */

let _default: ServicerInputsStore | null = null;

export function servicerInputsStore(): ServicerInputsStore {
  if (_default === null) _default = new ServicerInputsStore();
  return _default;
}
