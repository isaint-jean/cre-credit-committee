/**
 * Deal-access store (Chunk 3a) — per-user access to deals + pools.
 *
 * The polymorphic access table behind the invitation model:
 *   - resource_type 'deal' → resource_key = lineageRootId (the stable per-deal key;
 *     dealRef is non-unique across re-extractions).
 *   - resource_type 'pool' → resource_key = poolId (the data-room / pool workspace).
 *
 * 3a is SEED-ONLY: this table + owner-stamp-on-create + backfill exist, but NOTHING
 * reads it to filter yet. Enforcement (enforceDealAccess over every deal-scoped
 * read) is 3b — HELD. `accepted_at` stays null until the confi gate (3c) sets it.
 *
 * Lazy DDL (IF NOT EXISTS) → the real cre.db is byte-unchanged until the first
 * grant; fully reversible (drop the rows / the table restores the prior state).
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export type ResourceType = 'deal' | 'pool';
export type AccessParty = 'originator' | 'buyer' | 'admin';

export interface DealAccessRow {
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly userId: string;
  readonly party: AccessParty;
  readonly grantedBy: string | null;
  readonly grantedAt: string;
  readonly acceptedAt: string | null;
}

export interface DealAccessGrant {
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly userId: string;
  readonly party: AccessParty;
  readonly grantedBy?: string | null;
  /** ISO-8601; defaults to now. */
  readonly grantedAt?: string;
  readonly acceptedAt?: string | null;
}

interface DbRow {
  resource_type: string;
  resource_key: string;
  user_id: string;
  party: string;
  granted_by: string | null;
  granted_at: string;
  accepted_at: string | null;
}

function toRow(r: DbRow): DealAccessRow {
  return {
    resourceType: r.resource_type as ResourceType,
    resourceKey: r.resource_key,
    userId: r.user_id,
    party: r.party as AccessParty,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
    acceptedAt: r.accepted_at,
  };
}

export class DealAccessStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deal_access (
        resource_type TEXT NOT NULL,   -- 'deal' | 'pool'
        resource_key  TEXT NOT NULL,   -- lineageRootId | poolId
        user_id       TEXT NOT NULL,
        party         TEXT NOT NULL,   -- 'originator' | 'buyer' | 'admin'
        granted_by    TEXT,
        granted_at    TEXT NOT NULL,
        accepted_at   TEXT,
        PRIMARY KEY (resource_type, resource_key, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_deal_access_user     ON deal_access(user_id);
      CREATE INDEX IF NOT EXISTS idx_deal_access_resource ON deal_access(resource_type, resource_key);
    `);
  }

  /** Idempotent grant — INSERT OR IGNORE on the PK, so the owner-stamp and the
   *  backfill are both safely re-runnable (a re-grant is a no-op). */
  grant(g: DealAccessGrant): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO deal_access
           (resource_type, resource_key, user_id, party, granted_by, granted_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.resourceType,
        g.resourceKey,
        g.userId,
        g.party,
        g.grantedBy ?? null,
        g.grantedAt ?? new Date().toISOString(),
        g.acceptedAt ?? null,
      );
  }

  /** Does this user have an access row for the resource? (For 3b enforcement.) */
  has(resourceType: ResourceType, resourceKey: string, userId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM deal_access WHERE resource_type=? AND resource_key=? AND user_id=? LIMIT 1`)
      .get(resourceType, resourceKey, userId);
  }

  listForUser(userId: string): DealAccessRow[] {
    return (this.db.prepare(`SELECT * FROM deal_access WHERE user_id=?`).all(userId) as DbRow[]).map(toRow);
  }

  listForResource(resourceType: ResourceType, resourceKey: string): DealAccessRow[] {
    return (
      this.db.prepare(`SELECT * FROM deal_access WHERE resource_type=? AND resource_key=?`).all(resourceType, resourceKey) as DbRow[]
    ).map(toRow);
  }

  /** The accepted_at on a grant (null = granted but confi not yet accepted, or no
   *  grant). The data-room confi gate (3c) reads this. */
  acceptedAtFor(resourceType: ResourceType, resourceKey: string, userId: string): string | null {
    const r = this.db
      .prepare(`SELECT accepted_at AS a FROM deal_access WHERE resource_type=? AND resource_key=? AND user_id=?`)
      .get(resourceType, resourceKey, userId) as { a: string | null } | undefined;
    return r?.a ?? null;
  }

  /** Chunk 3c — stamp accepted_at on an EXISTING grant (confi accepted). Returns
   *  true only if a grant existed to stamp — you cannot accept your way INTO access,
   *  the grant must already exist (from the 3d invite/accept). */
  markConfiAccepted(resourceType: ResourceType, resourceKey: string, userId: string, acceptedAt?: string): boolean {
    const r = this.db
      .prepare(`UPDATE deal_access SET accepted_at=? WHERE resource_type=? AND resource_key=? AND user_id=?`)
      .run(acceptedAt ?? new Date().toISOString(), resourceType, resourceKey, userId);
    return r.changes > 0;
  }

  countAll(): number {
    return (this.db.prepare(`SELECT count(*) c FROM deal_access`).get() as { c: number }).c;
  }

  /** Reversibility helper (tests / rollback): remove one grant. */
  revoke(resourceType: ResourceType, resourceKey: string, userId: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM deal_access WHERE resource_type=? AND resource_key=? AND user_id=?`)
      .run(resourceType, resourceKey, userId);
    return r.changes > 0;
  }
}

// Lazy singleton (per the app's store pattern), plus a test-override seam.
let override: DealAccessStore | null = null;
let singleton: DealAccessStore | null = null;

/** Test seam — inject a temp/in-memory store (proofs). Pass null to clear. */
export function setDealAccessStore(store: DealAccessStore | null): void {
  override = store;
}

export function dealAccessStore(): DealAccessStore {
  if (override) return override;
  if (!singleton) singleton = new DealAccessStore();
  return singleton;
}
