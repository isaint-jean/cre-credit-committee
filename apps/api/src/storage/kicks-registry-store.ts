/**
 * KicksRegistryStore — reads + writes the `kicks_registry` reference table.
 *
 * Backs the institutional-memory layer of rejected/removed deals from
 * Eightfold's Master Kick List. Per CRE Credit Handbook §III, this corpus is
 * a required input to new-deal review ("look at our master list of loan
 * removals over time to identify other prior kicks in a submarket of a given
 * property type"). Today the store is populated and queryable but the
 * judgment engine does NOT yet consult it during analysis — that integration
 * depends on the handbook framework (#31).
 *
 * Layout: typed columns for queryable dimensions + a `raw_row_json` blob
 * preserving the source row verbatim. Same hybrid pattern as the record-graph
 * store. Indexes on the five most likely query axes (asset_type, state, msa,
 * sponsor, vintage).
 *
 * Insert semantics: replace-all (#29 lesson). The importer calls deleteAll()
 * before insertMany() so removed source rows actually leave the table.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ASSET_TYPES, type AssetType, type Kick } from '@cre/contracts';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

interface KickRow {
  readonly id: string;
  readonly asset_type: string;
  readonly source_8f_control: string | null;
  readonly deal: string | null;
  readonly seller: string | null;
  readonly vintage: number | null;
  readonly property_name: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly msa: string | null;
  readonly property_sub_type: string | null;
  readonly property_flag: string | null;
  readonly year_built: number | null;
  readonly year_renovated: number | null;
  readonly units: number | null;
  readonly cut_off_balance_dollars: number | null;
  readonly implied_debt_dollars: number | null;
  readonly debt_per_unit_dollars: number | null;
  readonly ltv_at_cutoff: number | null;
  readonly ltv_at_maturity: number | null;
  readonly debt_yield: number | null;
  readonly dscr: number | null;
  readonly occupancy_pct: number | null;
  readonly amortization_type: string | null;
  readonly sponsor: string | null;
  readonly single_tenant: number | null;
  readonly loan_purpose: string | null;
  readonly zf_comments: string | null;
  readonly zf_uw_review_comment: string | null;
  readonly uw_received_raw: string | null;
  readonly asr_received_raw: string | null;
  readonly raw_row_json: string;
  readonly imported_at: string;
}

const ASSET_TYPE_SET = new Set<string>(ASSET_TYPES);

function rowToKick(row: KickRow): Kick {
  if (!ASSET_TYPE_SET.has(row.asset_type)) {
    throw new Error(`kicks_registry row '${row.id}' has invalid asset_type='${row.asset_type}'`);
  }
  const st = row.single_tenant;
  const singleTenant: 0 | 1 | null = st === null ? null : st === 1 ? 1 : 0;
  return {
    id: row.id,
    assetType: row.asset_type as AssetType,
    source8fControl: row.source_8f_control,
    deal: row.deal,
    seller: row.seller,
    vintage: row.vintage,
    propertyName: row.property_name,
    address: row.address,
    city: row.city,
    state: row.state,
    msa: row.msa,
    propertySubType: row.property_sub_type,
    propertyFlag: row.property_flag,
    yearBuilt: row.year_built,
    yearRenovated: row.year_renovated,
    units: row.units,
    cutOffBalanceDollars: row.cut_off_balance_dollars,
    impliedDebtDollars: row.implied_debt_dollars,
    debtPerUnitDollars: row.debt_per_unit_dollars,
    ltvAtCutoff: row.ltv_at_cutoff,
    ltvAtMaturity: row.ltv_at_maturity,
    debtYield: row.debt_yield,
    dscr: row.dscr,
    occupancyPct: row.occupancy_pct,
    amortizationType: row.amortization_type,
    sponsor: row.sponsor,
    singleTenant,
    loanPurpose: row.loan_purpose,
    zfComments: row.zf_comments,
    zfUwReviewComment: row.zf_uw_review_comment,
    uwReceivedRaw: row.uw_received_raw,
    asrReceivedRaw: row.asr_received_raw,
    rawRowJson: row.raw_row_json,
    importedAt: row.imported_at,
  };
}

export class KicksRegistryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kicks_registry (
        id                      TEXT PRIMARY KEY,
        asset_type              TEXT NOT NULL,
        source_8f_control       TEXT,
        deal                    TEXT,
        seller                  TEXT,
        vintage                 INTEGER,
        property_name           TEXT,
        address                 TEXT,
        city                    TEXT,
        state                   TEXT,
        msa                     TEXT,
        property_sub_type       TEXT,
        property_flag           TEXT,
        year_built              INTEGER,
        year_renovated          INTEGER,
        units                   REAL,
        cut_off_balance_dollars REAL,
        implied_debt_dollars    REAL,
        debt_per_unit_dollars   REAL,
        ltv_at_cutoff           REAL,
        ltv_at_maturity         REAL,
        debt_yield              REAL,
        dscr                    REAL,
        occupancy_pct           REAL,
        amortization_type       TEXT,
        sponsor                 TEXT,
        single_tenant           INTEGER,
        loan_purpose            TEXT,
        zf_comments             TEXT,
        zf_uw_review_comment    TEXT,
        uw_received_raw         TEXT,
        asr_received_raw        TEXT,
        raw_row_json            TEXT NOT NULL,
        imported_at             TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kicks_asset_type ON kicks_registry(asset_type);
      CREATE INDEX IF NOT EXISTS idx_kicks_state      ON kicks_registry(state);
      CREATE INDEX IF NOT EXISTS idx_kicks_msa        ON kicks_registry(msa);
      CREATE INDEX IF NOT EXISTS idx_kicks_sponsor    ON kicks_registry(sponsor);
      CREATE INDEX IF NOT EXISTS idx_kicks_vintage    ON kicks_registry(vintage);
    `);
  }

  /** Returns all kicks, sorted by id ascending (deterministic). */
  getAll(): readonly Kick[] {
    const rows = this.db
      .prepare(
        `SELECT id, asset_type, source_8f_control, deal, seller, vintage,
                property_name, address, city, state, msa, property_sub_type,
                property_flag, year_built, year_renovated, units,
                cut_off_balance_dollars, implied_debt_dollars, debt_per_unit_dollars,
                ltv_at_cutoff, ltv_at_maturity, debt_yield, dscr, occupancy_pct,
                amortization_type, sponsor, single_tenant, loan_purpose,
                zf_comments, zf_uw_review_comment, uw_received_raw, asr_received_raw,
                raw_row_json, imported_at
         FROM kicks_registry
         ORDER BY id ASC`,
      )
      .all() as KickRow[];
    return rows.map(rowToKick);
  }

  /** Purges every row. The importer calls this before insertMany to provide
   *  replace-all semantics (same correctness fix as #29 for approved_deals). */
  deleteAll(): void {
    this.db.exec('DELETE FROM kicks_registry');
  }

  insertMany(kicks: readonly Kick[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO kicks_registry
       (id, asset_type, source_8f_control, deal, seller, vintage,
        property_name, address, city, state, msa, property_sub_type,
        property_flag, year_built, year_renovated, units,
        cut_off_balance_dollars, implied_debt_dollars, debt_per_unit_dollars,
        ltv_at_cutoff, ltv_at_maturity, debt_yield, dscr, occupancy_pct,
        amortization_type, sponsor, single_tenant, loan_purpose,
        zf_comments, zf_uw_review_comment, uw_received_raw, asr_received_raw,
        raw_row_json, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: readonly Kick[]) => {
      for (const k of rows) {
        stmt.run(
          k.id,
          k.assetType,
          k.source8fControl,
          k.deal,
          k.seller,
          k.vintage,
          k.propertyName,
          k.address,
          k.city,
          k.state,
          k.msa,
          k.propertySubType,
          k.propertyFlag,
          k.yearBuilt,
          k.yearRenovated,
          k.units,
          k.cutOffBalanceDollars,
          k.impliedDebtDollars,
          k.debtPerUnitDollars,
          k.ltvAtCutoff,
          k.ltvAtMaturity,
          k.debtYield,
          k.dscr,
          k.occupancyPct,
          k.amortizationType,
          k.sponsor,
          k.singleTenant,
          k.loanPurpose,
          k.zfComments,
          k.zfUwReviewComment,
          k.uwReceivedRaw,
          k.asrReceivedRaw,
          k.rawRowJson,
          k.importedAt,
        );
      }
    });
    tx(kicks);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM kicks_registry').get() as { n: number };
    return row.n;
  }

  countByAssetType(): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT asset_type, COUNT(*) AS n FROM kicks_registry GROUP BY asset_type')
      .all() as Array<{ asset_type: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.asset_type] = r.n;
    return out;
  }

  countByState(): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(state, '__null__') AS state, COUNT(*) AS n
         FROM kicks_registry GROUP BY state`,
      )
      .all() as Array<{ state: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

export const kicksRegistryStore = new KicksRegistryStore();
