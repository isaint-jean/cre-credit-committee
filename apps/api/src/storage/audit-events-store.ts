// AuditEventsStore (Phase 2 v2 - post-7.2).
//
// Append-only repository for AuditEvent records. Pure I/O abstraction.
//
// Discipline:
//   - INSERT only. Append-only enforced structurally.
//   - INSERT ... ON CONFLICT(id) DO NOTHING - idempotent re-insert.
//   - On insert, event.id is recomputed from body and verified.
//   - Retrieval preserves chain order via the previous_event_id linkage; callers
//     receive events as the producer wrote them, not in insertion-time order
//     (occurred_at is included in identity hash, but storage uses chain links to
//     preserve causal ordering even if multiple events share the same timestamp).
//   - No business logic. Does not validate chain integrity at insert time; that
//     check belongs to the replay engine which walks the chain.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  AuditEvent,
  AuditEventId,
  DoctrineEvaluationId,
  OverlayId,
  RenderVersion,
  RenderedAnalysisId,
} from '@cre/contracts';
import { serializeRecordBody } from '../util/content-hash.js';
import { RecordIdMismatchError } from './record-graph-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

interface EventRow {
  readonly id: string;
  readonly payload: string;
}

// Insert context: caller supplies the rooting metadata so the store can index
// events for fast retrieval by analysis root.
export interface AuditEventInsertCtx {
  readonly rootId: DoctrineEvaluationId;
  readonly renderVersion: RenderVersion;
}

export class AuditEventsStore {
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
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        overlay_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        render_version TEXT NOT NULL,
        previous_event_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_overlay ON audit_events(overlay_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_root ON audit_events(root_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_root_version ON audit_events(root_id, render_version);
      CREATE INDEX IF NOT EXISTS idx_audit_events_previous ON audit_events(previous_event_id);
    `);
  }

  insert(event: AuditEvent, ctx: AuditEventInsertCtx): { inserted: boolean } {
    const { id, ...body } = event;
    const { id: computedId, payload } = serializeRecordBody(body);
    if (id !== computedId) {
      throw new RecordIdMismatchError('AuditEvent', id, computedId);
    }
    const result = this.db
      .prepare(
        `INSERT INTO audit_events
         (id, overlay_id, root_id, render_version, previous_event_id, kind, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        event.overlayId,
        ctx.rootId,
        ctx.renderVersion,
        event.previousEventId,
        event.kind,
        payload,
        event.occurredAt,
      );
    return { inserted: result.changes > 0 };
  }

  getById(id: AuditEventId): AuditEvent | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM audit_events WHERE id = ?`)
      .get(id) as EventRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as AuditEvent;
  }

  // Returns events for one overlay, ordered by occurred_at (best-effort temporal).
  // The replay engine walks the previousEventId chain to determine canonical order
  // when occurred_at ties exist.
  getByOverlay(overlayId: OverlayId): readonly AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM audit_events
         WHERE overlay_id = ?
         ORDER BY occurred_at`,
      )
      .all(overlayId) as readonly EventRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as AuditEvent;
    });
  }

  // Returns events across all overlays anchored to the given analysis root.
  getByRoot(rootId: DoctrineEvaluationId): readonly AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM audit_events
         WHERE root_id = ?
         ORDER BY occurred_at`,
      )
      .all(rootId) as readonly EventRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as AuditEvent;
    });
  }

  getByRootAndVersion(
    rootId: DoctrineEvaluationId,
    renderVersion: RenderVersion,
  ): readonly AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM audit_events
         WHERE root_id = ? AND render_version = ?
         ORDER BY occurred_at`,
      )
      .all(rootId, renderVersion) as readonly EventRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as AuditEvent;
    });
  }

  // Distinct overlay ids anchored to a (root, render version) pair. Useful for
  // replay to enumerate overlays without scanning every event payload.
  getOverlayIdsByRootAndVersion(
    rootId: DoctrineEvaluationId,
    renderVersion: RenderVersion,
  ): readonly OverlayId[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT overlay_id FROM audit_events
         WHERE root_id = ? AND render_version = ?`,
      )
      .all(rootId, renderVersion) as readonly { readonly overlay_id: string }[];
    return rows.map((r) => r.overlay_id as OverlayId);
  }

  // Resolves an overlay's anchor (rootId, renderVersion, renderedAnalysisId) by
  // reading its overlay-created event. The overlay-created event is the chain
  // root and carries the binding metadata in its payload. Returns null when
  // the overlay has no overlay-created event recorded.
  //
  // Used by Phase 4 OVERRIDE_DECISION gating: the server confirms the request's
  // renderedAnalysisId matches the overlay's binding and rejects mismatches.
  getOverlayBinding(overlayId: OverlayId): {
    readonly rootId: DoctrineEvaluationId;
    readonly renderVersion: RenderVersion;
    readonly renderedAnalysisId: RenderedAnalysisId;
  } | null {
    const row = this.db
      .prepare(
        `SELECT root_id, render_version, payload
         FROM audit_events
         WHERE overlay_id = ? AND kind = 'overlay-created'
         LIMIT 1`,
      )
      .get(overlayId) as
      | { readonly root_id: string; readonly render_version: string; readonly payload: string }
      | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as { readonly payload?: { readonly renderedAnalysisId?: string } };
    const rId = body.payload?.renderedAnalysisId;
    if (typeof rId !== 'string') return null;
    return {
      rootId: row.root_id as DoctrineEvaluationId,
      renderVersion: row.render_version as RenderVersion,
      renderedAnalysisId: rId as RenderedAnalysisId,
    };
  }

  close(): void {
    this.db.close();
  }
}
