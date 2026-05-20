// CommitteeSnapshotsStore (Phase 2 v2 - post-7.2).
//
// Append-only repository for CommitteeSnapshot records. Pure I/O abstraction.
//
// Discipline:
//   - INSERT only.
//   - INSERT ... ON CONFLICT(id) DO NOTHING - idempotent re-insert.
//   - On insert, snapshot.id is recomputed from body and verified.
//   - Snapshots embed full RenderedAnalysis + (optional) EditableOverlay; the body
//     is potentially large. Storage handles whatever size; no cleanup, no truncation.
//   - The snapshot's body already carries renderedAnalysisId and overlayId so no
//     additional context is required at insert time (unlike patches/audit-events).

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  CommitteeSnapshot,
  CommitteeSnapshotId,
  OverlayId,
  RenderedAnalysisId,
} from '@cre/contracts';
import { serializeRecordBody } from '../util/content-hash.js';
import { RecordIdMismatchError } from './record-graph-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

interface SnapshotRow {
  readonly id: string;
  readonly payload: string;
}

export class CommitteeSnapshotsStore {
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
      CREATE TABLE IF NOT EXISTS committee_snapshots (
        id TEXT PRIMARY KEY,
        rendered_analysis_id TEXT NOT NULL,
        overlay_id TEXT,
        exported_at TEXT NOT NULL,
        exported_by TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_committee_snapshots_root ON committee_snapshots(rendered_analysis_id);
      CREATE INDEX IF NOT EXISTS idx_committee_snapshots_overlay ON committee_snapshots(overlay_id);
      CREATE INDEX IF NOT EXISTS idx_committee_snapshots_exported_at ON committee_snapshots(exported_at);
    `);
  }

  insert(snapshot: CommitteeSnapshot): { inserted: boolean } {
    const { id, ...body } = snapshot;
    const { id: computedId, payload } = serializeRecordBody(body);
    if (id !== computedId) {
      throw new RecordIdMismatchError('CommitteeSnapshot', id, computedId);
    }
    const result = this.db
      .prepare(
        `INSERT INTO committee_snapshots
         (id, rendered_analysis_id, overlay_id, exported_at, exported_by, purpose, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        snapshot.renderedAnalysisId,
        snapshot.overlayId,
        snapshot.exportContext.exportedAt,
        snapshot.exportContext.exportedBy,
        snapshot.exportContext.purpose,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getById(id: CommitteeSnapshotId): CommitteeSnapshot | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM committee_snapshots WHERE id = ?`)
      .get(id) as SnapshotRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as CommitteeSnapshot;
  }

  // Snapshots for a specific rendered analysis. Multiple snapshots can exist for
  // the same rendered analysis at different export times (different exportContext).
  getByRenderedAnalysis(renderedAnalysisId: RenderedAnalysisId): readonly CommitteeSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM committee_snapshots
         WHERE rendered_analysis_id = ?
         ORDER BY exported_at`,
      )
      .all(renderedAnalysisId) as readonly SnapshotRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as CommitteeSnapshot;
    });
  }

  // Snapshots that bundle a specific overlay.
  getByOverlay(overlayId: OverlayId): readonly CommitteeSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM committee_snapshots
         WHERE overlay_id = ?
         ORDER BY exported_at`,
      )
      .all(overlayId) as readonly SnapshotRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as CommitteeSnapshot;
    });
  }

  close(): void {
    this.db.close();
  }
}
