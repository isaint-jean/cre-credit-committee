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

// Context required at insert time. The patch body itself does NOT carry overlayId
// or rooting fields; the caller supplies them so the store can index correctly.
// rootId here is the DoctrineEvaluationId (the analysis root); the rendered-analysis
// anchor is captured via the audit log's overlay-created event.
export interface OverlayPatchInsertCtx {
  readonly overlayId: OverlayId;
  readonly rootId: DoctrineEvaluationId;
  readonly renderVersion: RenderVersion;
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_overlay ON overlay_patches(overlay_id);
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_root ON overlay_patches(root_id);
      CREATE INDEX IF NOT EXISTS idx_overlay_patches_root_version ON overlay_patches(root_id, render_version);
    `);
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
         (id, overlay_id, root_id, render_version, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
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
