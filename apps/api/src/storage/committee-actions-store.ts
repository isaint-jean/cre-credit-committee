// CommitteeActionsStore (Phase 3 - committee workflow layer).
//
// Append-only repository for CommitteeActionEvent records. Pure I/O abstraction.
// Mirrors the AuditEventsStore patterns (chain-linked, content-hashed, idempotent
// inserts, no update/delete) but is a SEPARATE table - committee actions are
// deal-scoped (rootId), distinct from overlay-scoped audit events.
//
// Discipline:
//   - INSERT only. Append-only enforced structurally.
//   - INSERT ... ON CONFLICT(id) DO NOTHING - idempotent re-insert.
//   - On insert, action.id is recomputed from body and verified.
//   - The store stores what it's given. No business logic, no state derivation,
//     no lifecycle inference - those are the projection layer's job.
//   - Retrieval is deterministic; ORDER BY occurred_at gives a temporal hint;
//     replay/projection uses previousActionId chain links for canonical order.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  CommitteeActionEvent,
  CommitteeActionId,
  DoctrineEvaluationId,
  RenderedAnalysisId,
} from '@cre/contracts';
import { serializeRecordBody } from '../util/content-hash.js';
import { RecordIdMismatchError } from './record-graph-store.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

interface ActionRow {
  readonly id: string;
  readonly payload: string;
}

export class CommitteeActionsStore {
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
      CREATE TABLE IF NOT EXISTS committee_actions (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        rendered_analysis_id TEXT NOT NULL,
        snapshot_id TEXT,
        previous_action_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        author TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_committee_actions_root ON committee_actions(root_id);
      CREATE INDEX IF NOT EXISTS idx_committee_actions_rendered ON committee_actions(rendered_analysis_id);
      CREATE INDEX IF NOT EXISTS idx_committee_actions_previous ON committee_actions(previous_action_id);
      CREATE INDEX IF NOT EXISTS idx_committee_actions_occurred ON committee_actions(occurred_at);
    `);
  }

  insert(action: CommitteeActionEvent): { inserted: boolean } {
    const { id, ...body } = action;
    const { id: computedId, payload } = serializeRecordBody(body);
    if (id !== computedId) {
      throw new RecordIdMismatchError('CommitteeActionEvent', id, computedId);
    }
    const result = this.db
      .prepare(
        `INSERT INTO committee_actions
         (id, root_id, rendered_analysis_id, snapshot_id, previous_action_id,
          kind, payload, author, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        action.rootId,
        action.renderedAnalysisId,
        action.snapshotId,
        action.previousActionId,
        action.kind,
        payload,
        action.author,
        action.occurredAt,
      );
    return { inserted: result.changes > 0 };
  }

  getById(id: CommitteeActionId): CommitteeActionEvent | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM committee_actions WHERE id = ?`)
      .get(id) as ActionRow | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as CommitteeActionEvent;
  }

  // All committee actions for one deal, ordered by occurred_at (temporal hint).
  // Projection layer walks previousActionId for canonical chain order.
  getByRoot(rootId: DoctrineEvaluationId): readonly CommitteeActionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM committee_actions
         WHERE root_id = ?
         ORDER BY occurred_at`,
      )
      .all(rootId) as readonly ActionRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as CommitteeActionEvent;
    });
  }

  // Actions taken against a specific rendered analysis (e.g., specific render version).
  getByRenderedAnalysis(renderedAnalysisId: RenderedAnalysisId): readonly CommitteeActionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM committee_actions
         WHERE rendered_analysis_id = ?
         ORDER BY occurred_at`,
      )
      .all(renderedAnalysisId) as readonly ActionRow[];
    return rows.map((r) => {
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      return { id: r.id, ...body } as CommitteeActionEvent;
    });
  }

  close(): void {
    this.db.close();
  }
}
