/**
 * ApprovedDealsStore — reads + writes the `approved_deals` reference table.
 *
 * Architecture §4: "200+ approved deals stored in `approved_deals` table (columns: asset_type,
 * vacancy_pct, expense_ratio, cap_rate, treasury_10y_at_close, dscr, status)." This is the
 * historical-deal corpus that the LibrarySnapshot producer hashes + distills into per-asset-type
 * distributions.
 *
 * Insert semantics: `INSERT OR REPLACE` keyed by id (deals can be re-imported with corrected
 * data). Distinct from the content-addressable record-graph store which uses ON CONFLICT DO
 * NOTHING — approved_deals is reference data, not stage output.
 *
 * Connection: opens its own connection to the same sqlite file as `SqliteStore` /
 * `RecordGraphStore`. Tests pass `':memory:'` for isolation.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ASSET_TYPES, type AssetType } from '@cre/contracts';
import type { ISODateTime } from '@cre/contracts';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export const APPROVED_DEAL_STATUSES = ['approved', 'pending', 'rejected'] as const;
export type ApprovedDealStatus = (typeof APPROVED_DEAL_STATUSES)[number];

export interface ApprovedDeal {
  readonly id: string;
  readonly assetType: AssetType;
  readonly vacancyPct: number;            // 0..1
  readonly expenseRatio: number;          // 0..1
  readonly capRate: number;               // 0..1
  /**
   * 0..1 (e.g., 0.0425 for 4.25%). Nullable since issue #20 connector work:
   * historical-UW imports don't carry a treasury-at-close field, so imported
   * deals stamp null here. Pre-existing approved-deal sources (the synthetic
   * seed at scripts/seed-approved-deals.ts) continue to stamp a real number.
   */
  readonly treasury10YAtClose: number | null;
  readonly dscr: number;                  // ratio (e.g., 1.35)
  readonly status: ApprovedDealStatus;
  readonly closedAt: ISODateTime;
}

interface ApprovedDealRow {
  readonly id: string;
  readonly asset_type: string;
  readonly vacancy_pct: number;
  readonly expense_ratio: number;
  readonly cap_rate: number;
  readonly treasury_10y_at_close: number | null;
  readonly dscr: number;
  readonly status: string;
  readonly closed_at: string;
}

const ASSET_TYPE_SET = new Set<string>(ASSET_TYPES);
const STATUS_SET = new Set<string>(APPROVED_DEAL_STATUSES);

function rowToDeal(row: ApprovedDealRow): ApprovedDeal {
  if (!ASSET_TYPE_SET.has(row.asset_type)) {
    throw new Error(`approved_deals row '${row.id}' has invalid asset_type='${row.asset_type}'`);
  }
  if (!STATUS_SET.has(row.status)) {
    throw new Error(`approved_deals row '${row.id}' has invalid status='${row.status}'`);
  }
  return {
    id: row.id,
    assetType: row.asset_type as AssetType,
    vacancyPct: row.vacancy_pct,
    expenseRatio: row.expense_ratio,
    capRate: row.cap_rate,
    treasury10YAtClose: row.treasury_10y_at_close,
    dscr: row.dscr,
    status: row.status as ApprovedDealStatus,
    closedAt: row.closed_at,
  };
}

export class ApprovedDealsStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.migrateDropTreasuryNotNull();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approved_deals (
        id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL,
        vacancy_pct REAL NOT NULL,
        expense_ratio REAL NOT NULL,
        cap_rate REAL NOT NULL,
        treasury_10y_at_close REAL,
        dscr REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
        closed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approved_deals_asset_type ON approved_deals(asset_type);
      CREATE INDEX IF NOT EXISTS idx_approved_deals_status     ON approved_deals(status);
    `);
  }

  /**
   * One-time idempotent migration (issue #20 connector work): databases created
   * before the treasury_10y_at_close column was widened to nullable still carry
   * `NOT NULL` on that column. Detect via PRAGMA table_info; if the constraint
   * is still in place, rebuild the table without it.
   *
   * SQLite doesn't support `ALTER COLUMN ... DROP NOT NULL` directly. Standard
   * workaround is the table-rebuild dance: CREATE new, copy rows, DROP old,
   * RENAME new → old, recreate indexes. Transactional. No-op when the column
   * is already nullable (fresh DBs created by the new `migrate()` above) or
   * when the table doesn't exist yet (in which case migrate() just created it
   * with the nullable schema directly).
   */
  private migrateDropTreasuryNotNull(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info('approved_deals')").all() as Array<{
        readonly name: string; readonly notnull: number;
      }>;
      const treasuryCol = cols.find((c) => c.name === 'treasury_10y_at_close');
      if (treasuryCol === undefined || treasuryCol.notnull === 0) return;
      this.db.exec(`
        BEGIN;
        CREATE TABLE approved_deals_new (
          id TEXT PRIMARY KEY,
          asset_type TEXT NOT NULL,
          vacancy_pct REAL NOT NULL,
          expense_ratio REAL NOT NULL,
          cap_rate REAL NOT NULL,
          treasury_10y_at_close REAL,
          dscr REAL NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
          closed_at TEXT NOT NULL
        );
        INSERT INTO approved_deals_new
          SELECT id, asset_type, vacancy_pct, expense_ratio, cap_rate,
                 treasury_10y_at_close, dscr, status, closed_at
          FROM approved_deals;
        DROP TABLE approved_deals;
        ALTER TABLE approved_deals_new RENAME TO approved_deals;
        CREATE INDEX IF NOT EXISTS idx_approved_deals_asset_type ON approved_deals(asset_type);
        CREATE INDEX IF NOT EXISTS idx_approved_deals_status     ON approved_deals(status);
        COMMIT;
      `);
    } catch {
      /* Table not yet created — migrate() above creates it with the new schema. */
    }
  }

  /** Returns rows where status='approved', sorted by id ascending. Sort order is deterministic
   *  so the LibrarySnapshot producer can hash the canonical row sequence reproducibly. */
  getAllApproved(): readonly ApprovedDeal[] {
    const rows = this.db
      .prepare(
        `SELECT id, asset_type, vacancy_pct, expense_ratio, cap_rate,
                treasury_10y_at_close, dscr, status, closed_at
         FROM approved_deals
         WHERE status = 'approved'
         ORDER BY id ASC`,
      )
      .all() as ApprovedDealRow[];
    return rows.map(rowToDeal);
  }

  /**
   * Deletes every row in approved_deals. Used by the HistoricalUW connector to
   * provide replace-all semantics: re-running the import after the projection
   * criteria tighten (#29 sanity bounds) must purge rows that no longer pass
   * projection. INSERT OR REPLACE alone only updates rows with matching ids;
   * orphaned rows from a previous looser projection would otherwise persist.
   */
  deleteAll(): void {
    this.db.exec('DELETE FROM approved_deals');
  }

  insertMany(deals: readonly ApprovedDeal[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO approved_deals
       (id, asset_type, vacancy_pct, expense_ratio, cap_rate, treasury_10y_at_close,
        dscr, status, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: readonly ApprovedDeal[]) => {
      for (const d of rows) {
        stmt.run(
          d.id,
          d.assetType,
          d.vacancyPct,
          d.expenseRatio,
          d.capRate,
          d.treasury10YAtClose,
          d.dscr,
          d.status,
          d.closedAt,
        );
      }
    });
    tx(deals);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM approved_deals`).get() as { n: number };
    return row.n;
  }

  countByStatus(status: ApprovedDealStatus): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM approved_deals WHERE status = ?`)
      .get(status) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

export const approvedDealsStore = new ApprovedDealsStore();
