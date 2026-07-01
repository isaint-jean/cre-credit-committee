// OverlayPatchesStore (Phase 2 v2 - post-7.2).
//
// Append-only repository for OverlayPatch records. Pure I/O abstraction; no business
// logic. The patch contract itself does not carry overlayId or rooting metadata; the
// store denormalizes those fields onto rows for indexed retrieval.
//
// Discipline:
//   - INSERT only. No update / delete methods. The append-only invariant is structural.
//   - INSERT ... ON CONFLICT(id) DO NOTHING - same content + same id = no-op (idempotent).
//   - On insert, the provided patch.id is recomputed from the body and verified against
//     the claimed id; mismatch throws RecordIdMismatchError (mirrors the spine pattern).
//   - Retrieval methods are deterministic: same row state -> same result.
//   - No business logic. Stores patches as-given; does not validate path semantics,
//     does not infer overlay membership, does not classify patches.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  DoctrineEvaluationId,
  OverlayId,
  OverlayPatch,
  OverlayPatchId,
  RenderVersion,
} from '@cre/contracts';
import { serializeRecordBody } from '../util/content-hash.js';
import { RecordIdMismatchError } from './record-graph-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

interface PatchRow {
  readonly payload: string;
}

// A patch read back with its hash-EXCLUDED denormalized `side` column. `side` is
// NOT part of the patch body / identity hash — it is a negotiation-view attribution
// tag written alongside `created_at`, read back joined onto the patch here.
export interface OverlayPatchWithSide {
  readonly patch: OverlayPatch;
  readonly side: string | null;
}

// Context required at insert time. The patch body itself does NOT carry overlayId
// or rooting fields; the caller supplies them so the store can index correctly.
// rootId here is the DoctrineEvaluationId (the analysis root); the rendered-analysis
// anchor is captured via the audit log's overlay-created event.
//
// `side` (optional): a hash-EXCLUDED denormalized column — the negotiation-view
// attribution ('originator' | 'buyer'). It is written to the `side` column exactly
// like `created_at`, and MUST NOT appear in the patch body (which is the hashed
// identity). Omitting it stores NULL.
export interface OverlayPatchInsertCtx {
  readonly overlayId: OverlayId;
  readonly rootId: DoctrineEvaluationId;
  readonly renderVersion: RenderVersion;
  readonly side?: string | null;
}

export class OverlayPatchesStore {
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
      CREATE TABLE IF NOT EXISTS overlay_patches (
        id TEXT PRIMARY KEY,
        overlay_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        render_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        side TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_overlay ON overlay_patches(overlay_id);
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_root ON overlay_patches(root_id);
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_root_version ON overlay_patches(root_id, render_version);
    `);
    // Defensive, idempotent: if a pre-existing lazy table was created before the
    // hash-excluded `side` column existed, add it. New tables already carry it via
    // the CREATE above; on those this is a no-op that we swallow.
    const hasSide = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('overlay_patches') WHERE name = 'side'`)
      .get();
    if (!hasSide) {
      this.db.exec(`ALTER TABLE overlay_patches ADD COLUMN side TEXT`);
    }
  }

  insert(patch: OverlayPatch, ctx: OverlayPatchInsertCtx): { inserted: boolean } {
    // Verify the patch's claimed id matches the canonical hash of its body. The
    // body excludes `id` per the spine convention.
    const { id, ...body } = patch;
    const { id: computedId, payload } = serializeRecordBody(body);
    if (id !== computedId) {
      throw new RecordIdMismatchError('OverlayPatch', id, computedId);
    }
    const result = this.db
      .prepare(
        `INSERT INTO overlay_patches
         (id, overlay_id, root_id, render_version, kind, payload, created_at, side)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        ctx.overlayId,
        ctx.rootId,
        ctx.renderVersion,
        patch.kind,
        payload,
        new Date().toISOString(),
        // `side` is a hash-excluded denormalized column written exactly like
        // `created_at` — it never enters the body/id. NULL when the caller omits it.
        ctx.side ?? null,
      );
    return { inserted: result.changes > 0 };
  }

  getById(id: OverlayPatchId): OverlayPatch | null {
    const row = this.db
      .prepare(`SELECT payload FROM overlay_patches WHERE id = ?`)
      .get(id) as PatchRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id, ...body } as OverlayPatch;
  }

  getByOverlay(overlayId: OverlayId): readonly OverlayPatch[] {
    const rows = this.db
      .prepare(`SELECT id, payload FROM overlay_patches WHERE overlay_id = ? ORDER BY created_at`)
      .all(overlayId) as Array<{ readonly id: string; readonly payload: string }>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as OverlayPatch;
    });
  }

  getByRoot(rootId: DoctrineEvaluationId): readonly OverlayPatch[] {
    const rows = this.db
      .prepare(`SELECT id, payload FROM overlay_patches WHERE root_id = ? ORDER BY created_at`)
      .all(rootId) as Array<{ readonly id: string; readonly payload: string }>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as OverlayPatch;
    });
  }

  // ── side-carrying reads ────────────────────────────────────────────────────
  // Same rows as getByOverlay/getByRoot, but join the hash-excluded `side` column
  // so the negotiation surface can render the attribution tag. The patch body
  // (JSON.parse(payload)) is UNCHANGED — `side` rides alongside, never inside it.

  getByOverlayWithSide(overlayId: OverlayId): readonly OverlayPatchWithSide[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload, side FROM overlay_patches WHERE overlay_id = ? ORDER BY created_at`,
      )
      .all(overlayId) as Array<{ readonly id: string; readonly payload: string; readonly side: string | null }>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { patch: { id: r.id, ...body } as OverlayPatch, side: r.side ?? null };
    });
  }

  getByRootWithSide(rootId: DoctrineEvaluationId): readonly OverlayPatchWithSide[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload, side FROM overlay_patches WHERE root_id = ? ORDER BY created_at`,
      )
      .all(rootId) as Array<{ readonly id: string; readonly payload: string; readonly side: string | null }>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { patch: { id: r.id, ...body } as OverlayPatch, side: r.side ?? null };
    });
  }

  getByRootAndVersion(
    rootId: DoctrineEvaluationId,
    renderVersion: RenderVersion,
  ): readonly OverlayPatch[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM overlay_patches
         WHERE root_id = ? AND render_version = ?
         ORDER BY created_at`,
      )
      .all(rootId, renderVersion) as Array<{ readonly id: string; readonly payload: string }>;
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as OverlayPatch;
    });
  }

  close(): void {
    this.db.close();
  }
}
