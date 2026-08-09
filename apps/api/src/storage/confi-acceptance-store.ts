/**
 * Confidentiality-acceptance log (Chunk 3c) — append-only, patterned on the
 * CommitteeActions store shape. Every buyer acceptance is recorded who / when / IP
 * / agreement version, so which text they agreed to is auditable. The acceptance
 * also flips deal_access.accepted_at (done in the route) which is what the data-room
 * gate reads; this table is the durable legal record.
 *
 * Lazy DDL (byte-unchanged until first accept); reversible (DELETE by id/resource).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResourceType } from './deal-access-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** The current confidentiality-agreement version. Bump when the TEXT changes so a
 *  re-acceptance is required and the audit records exactly which text was agreed. */
export const CONFIDENTIALITY_AGREEMENT_VERSION = 'confi-v1-2026-08';

export interface ConfiAcceptanceRow {
  readonly id: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly userId: string;
  readonly agreementVersion: string;
  readonly acceptedAt: string;
  readonly clientIp: string | null;
}

export interface RecordAcceptance {
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly userId: string;
  readonly agreementVersion: string;
  readonly clientIp: string | null;
  readonly acceptedAt?: string; // defaults to now
}

interface DbRow {
  id: string;
  resource_type: string;
  resource_key: string;
  user_id: string;
  agreement_version: string;
  accepted_at: string;
  client_ip: string | null;
}

function toRow(r: DbRow): ConfiAcceptanceRow {
  return {
    id: r.id,
    resourceType: r.resource_type as ResourceType,
    resourceKey: r.resource_key,
    userId: r.user_id,
    agreementVersion: r.agreement_version,
    acceptedAt: r.accepted_at,
    clientIp: r.client_ip,
  };
}

export class ConfiAcceptanceStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS confi_acceptances (
        id                TEXT NOT NULL PRIMARY KEY,
        resource_type     TEXT NOT NULL,   -- 'deal' | 'pool'
        resource_key      TEXT NOT NULL,
        user_id           TEXT NOT NULL,
        agreement_version TEXT NOT NULL,
        accepted_at       TEXT NOT NULL,
        client_ip         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_confi_resource ON confi_acceptances(resource_type, resource_key);
      CREATE INDEX IF NOT EXISTS idx_confi_user     ON confi_acceptances(user_id);
    `);
  }

  /** Append one acceptance (never updates — the log is the record). */
  record(a: RecordAcceptance): ConfiAcceptanceRow {
    const id = randomUUID();
    const acceptedAt = a.acceptedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO confi_acceptances
           (id, resource_type, resource_key, user_id, agreement_version, accepted_at, client_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, a.resourceType, a.resourceKey, a.userId, a.agreementVersion, acceptedAt, a.clientIp);
    return this.db.prepare(`SELECT * FROM confi_acceptances WHERE id = ?`).get(id) as unknown as ConfiAcceptanceRow;
  }

  /** Has this user accepted the CURRENT agreement version for the resource? */
  hasAccepted(resourceType: ResourceType, resourceKey: string, userId: string, version = CONFIDENTIALITY_AGREEMENT_VERSION): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM confi_acceptances
          WHERE resource_type=? AND resource_key=? AND user_id=? AND agreement_version=? LIMIT 1`,
      )
      .get(resourceType, resourceKey, userId, version);
  }

  listForResource(resourceType: ResourceType, resourceKey: string): ConfiAcceptanceRow[] {
    return (this.db.prepare(`SELECT * FROM confi_acceptances WHERE resource_type=? AND resource_key=?`).all(resourceType, resourceKey) as DbRow[]).map(toRow);
  }

  countAll(): number {
    return (this.db.prepare(`SELECT count(*) c FROM confi_acceptances`).get() as { c: number }).c;
  }
}

let override: ConfiAcceptanceStore | null = null;
let singleton: ConfiAcceptanceStore | null = null;
export function setConfiAcceptanceStore(store: ConfiAcceptanceStore | null): void {
  override = store;
}
export function confiAcceptanceStore(): ConfiAcceptanceStore {
  if (override) return override;
  if (!singleton) singleton = new ConfiAcceptanceStore();
  return singleton;
}
