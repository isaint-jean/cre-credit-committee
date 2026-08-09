/**
 * Invitation store (Chunk 3d) — single-use, expiring buyer invites.
 *
 * An invite is a NEW AUTH SURFACE, so the token is treated carefully: 32 random
 * bytes (unguessable), single-use (accepted_at stamps it spent), expiring. Accept
 * validation lives in invitation.service.ts; this store is just persistence.
 *
 * On accept the flow mints an EXPLICIT buyer deal_access row — the reliable grant
 * path that sidesteps 3b's best-effort pool→deal derivation. Lazy DDL (byte-
 * unchanged until first mint); reversible (DELETE by token).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ResourceType } from './deal-access-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export interface InvitationRow {
  readonly token: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly invitedEmail: string | null;
  readonly party: 'buyer';
  readonly grantedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedBy: string | null;
}

export interface MintInvitation {
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly invitedEmail?: string | null;
  readonly grantedBy: string;
  readonly expiresInDays?: number; // default 7
  /** Test-only override to force a specific expiry (e.g. an already-past instant). */
  readonly expiresAt?: string;
  readonly createdAt?: string;
}

interface DbRow {
  token: string;
  resource_type: string;
  resource_key: string;
  invited_email: string | null;
  party: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
}

function toRow(r: DbRow): InvitationRow {
  return {
    token: r.token,
    resourceType: r.resource_type as ResourceType,
    resourceKey: r.resource_key,
    invitedEmail: r.invited_email,
    party: 'buyer',
    grantedBy: r.granted_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by,
  };
}

export class InvitationStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invitations (
        token         TEXT NOT NULL PRIMARY KEY,
        resource_type TEXT NOT NULL,   -- 'deal' | 'pool'
        resource_key  TEXT NOT NULL,
        invited_email TEXT,            -- optional bind to a specific buyer email
        party         TEXT NOT NULL,   -- 'buyer'
        granted_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        accepted_at   TEXT,            -- set once (single-use)
        accepted_by   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_resource ON invitations(resource_type, resource_key);
    `);
  }

  mint(m: MintInvitation): InvitationRow {
    const token = randomBytes(32).toString('hex'); // 64 hex chars, unguessable
    const now = m.createdAt ?? new Date().toISOString();
    const expiresAt =
      m.expiresAt ?? new Date(Date.now() + (m.expiresInDays ?? 7) * 86_400_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO invitations
           (token, resource_type, resource_key, invited_email, party, granted_by, created_at, expires_at, accepted_at, accepted_by)
         VALUES (?, ?, ?, ?, 'buyer', ?, ?, ?, NULL, NULL)`,
      )
      .run(token, m.resourceType, m.resourceKey, m.invitedEmail ?? null, m.grantedBy, now, expiresAt);
    return this.getByToken(token)!;
  }

  getByToken(token: string): InvitationRow | null {
    const r = this.db.prepare(`SELECT * FROM invitations WHERE token = ?`).get(token) as DbRow | undefined;
    return r ? toRow(r) : null;
  }

  /** Mark the invite spent — single-use: only flips a not-yet-accepted invite.
   *  Returns true if THIS call consumed it (guards a token-reuse race). */
  markAccepted(token: string, acceptedBy: string): boolean {
    const r = this.db
      .prepare(`UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE token = ? AND accepted_at IS NULL`)
      .run(new Date().toISOString(), acceptedBy, token);
    return r.changes > 0;
  }

  countAll(): number {
    return (this.db.prepare(`SELECT count(*) c FROM invitations`).get() as { c: number }).c;
  }

  /** Reversibility helper (tests / rollback). */
  deleteByToken(token: string): boolean {
    return this.db.prepare(`DELETE FROM invitations WHERE token = ?`).run(token).changes > 0;
  }
}

let override: InvitationStore | null = null;
let singleton: InvitationStore | null = null;

export function setInvitationStore(store: InvitationStore | null): void {
  override = store;
}
export function invitationStore(): InvitationStore {
  if (override) return override;
  if (!singleton) singleton = new InvitationStore();
  return singleton;
}
