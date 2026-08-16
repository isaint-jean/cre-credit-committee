import Database from 'better-sqlite3';
import path from 'path';
import bcrypt from 'bcryptjs';
import {
  Analysis, AnalysisSummary, Comment, AssetType, CriteriaEvaluation,
  FindingCategory, AuditLogEntry, ModelLogicVersionEntry
} from '@cre/shared';
import { CriteriaRuleSet } from '@cre/shared';
import type { TemplateMetadata, TemplateType, UnderwritingTemplate, TemplateVersion, CreditManifesto, CreditManifestoDetail } from '@cre/shared';
import { getDefaultCriteria } from '../services/default-criteria.js';
import {
  getRegisteredVersionsForType,
  getTemplateMetadata,
  TemplateRegistryGateError,
} from '../services/template-registry.js';
import { normalizePropertyName, normalizeAnalysisNameForMatch } from '../services/parse-bmark-tape-xlsx.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  // Lowercase storage roles; translated to the uppercase contract enum at the JWT
  // boundary (normalizeRoleAtBoundary). 'originator'/'buyer' added in role-siloing ch.1.
  role: 'admin' | 'analyst' | 'viewer' | 'originator' | 'buyer';
  createdAt: string;
}

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** Canonical-ranking quality signals for one graph-backed analysis
 *  (getCanonicalScoredAnalysisId). Higher spineScore / validated / scored and a
 *  more recent createdAt rank better; archived is excluded outright. */
interface AnalysisCanonicalQuality {
  readonly archived: boolean;
  readonly scored: boolean;      // coverage gate NOT fired (validly scored)
  readonly spineScore: number;   // 2 appraisal-anchored, 1 ASR-anchored, 0 unsourced
  readonly validated: boolean;   // income validated (trailing actuals)
  readonly createdAt: string;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPathOverride?: string) {
    // Batch 6.3 — accept an optional override (e.g., `:memory:` for tests).
    // Default behavior unchanged: prod uses `data/cre.db`.
    const useMemory = dbPathOverride === ':memory:';
    if (useMemory) {
      this.db = new Database(':memory:');
      this.db.pragma('foreign_keys = ON');
      this.migrate();
      this.migrateTemplates();
      this.seedCriteria();
      this.seedDefaultUser();
      return;
    }
    // Ensure data directory exists
    const dir = path.dirname(DB_PATH);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Test seam: honor a real file-path override (e.g. a cre.db COPY) so
    // copy-bound verifies never touch the live db. Default behavior unchanged —
    // the prod singleton (no arg) resolves `undefined ?? DB_PATH` = DB_PATH.
    // migrate() is CREATE-IF-NOT-EXISTS and the seeds are INSERT-OR-IGNORE, so
    // opening an EXISTING copy is non-clobbering (idempotent).
    this.db = new Database(dbPathOverride ?? DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.migrateTemplates();
    this.seedCriteria();
    this.seedDefaultUser();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploading',
        progress REAL NOT NULL DEFAULT 0,
        current_step TEXT NOT NULL DEFAULT '',
        credit_score_overall REAL,
        risk_tier TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL,
        error TEXT,
        -- Batch 6.3 — revision lineage on legacy path. Single-parent, append-only,
        -- immutable. parent_analysis_id is NULL only for root revisions; lineage_root_id
        -- defaults to id (root case); revision_ordinal defaults to 0.
        parent_analysis_id TEXT,
        lineage_root_id TEXT,
        revision_ordinal INTEGER NOT NULL DEFAULT 0,
        -- Nullable anchor into the new-spine graph substrate (64-hex RevisionId).
        -- When set, projection layer reads HE/DE/NE from the graph store; when null,
        -- legacy-only behavior (LLM-produced executiveSummary etc.) is preserved.
        graph_revision_id TEXT
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        finding_id TEXT,
        stance TEXT NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'analyst',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS criteria (
        asset_type TEXT PRIMARY KEY,
        rules TEXT NOT NULL,
        scoring_weights TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'analyst',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS uw_templates (
        id TEXT PRIMARY KEY,
        template_type TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_data BLOB NOT NULL,
        structure_json TEXT,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS populated_templates (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_data BLOB NOT NULL,
        mapped_fields TEXT,
        unmapped_fields TEXT,
        tabs_populated TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status);
      CREATE INDEX IF NOT EXISTS idx_analyses_asset_type ON analyses(asset_type);
      CREATE INDEX IF NOT EXISTS idx_comments_analysis ON comments(analysis_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_uw_templates_type ON uw_templates(template_type);
      CREATE INDEX IF NOT EXISTS idx_uw_templates_active ON uw_templates(template_type, is_active);
      CREATE INDEX IF NOT EXISTS idx_populated_templates_analysis ON populated_templates(analysis_id);

      CREATE TABLE IF NOT EXISTS analysis_cache (
        input_hash TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        manifesto_version TEXT NOT NULL,
        model_logic_version TEXT NOT NULL,
        components_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cache_analysis ON analysis_cache(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_cache_asset_type ON analysis_cache(asset_type);

      CREATE TABLE IF NOT EXISTS credit_manifesto (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        file_data BLOB NOT NULL,
        raw_text TEXT NOT NULL,
        extracted_rules_json TEXT NOT NULL DEFAULT '[]',
        ambiguities_json TEXT NOT NULL DEFAULT '[]',
        scoring_weights_json TEXT,
        asset_types_covered TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'processing',
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        processed_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_manifesto_active ON credit_manifesto(is_active);

      CREATE TABLE IF NOT EXISTS version_audit_log (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        analysis_name TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        manifesto_version TEXT NOT NULL,
        manifesto_label TEXT NOT NULL,
        model_logic_version TEXT NOT NULL,
        credit_score_overall REAL,
        recommendation TEXT,
        risk_tier TEXT,
        validation_passed INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_audit_analysis ON version_audit_log(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_audit_input_hash ON version_audit_log(input_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON version_audit_log(timestamp DESC);

      CREATE TABLE IF NOT EXISTS model_logic_versions (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS original_uploads (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_original_uploads_analysis ON original_uploads(analysis_id);
    `);
  }

  /** Add columns/tables that may be missing on existing databases */
  private migrateTemplates() {
    // Add structure_json column if it doesn't exist (for databases created before this migration)
    try {
      const cols = this.db.prepare("PRAGMA table_info('uw_templates')").all() as any[];
      if (cols.length > 0 && !cols.find((c: any) => c.name === 'structure_json')) {
        this.db.exec('ALTER TABLE uw_templates ADD COLUMN structure_json TEXT');
      }
    } catch { /* table might not exist yet — that's OK, migrate() just created it */ }

    // Batch 6.3 — lineage columns on the analyses table for revision semantics.
    // Idempotent: skip if already present, run for older databases.
    try {
      const cols = this.db.prepare("PRAGMA table_info('analyses')").all() as any[];
      if (cols.length > 0) {
        const has = (n: string) => cols.find((c: any) => c.name === n);
        if (!has('parent_analysis_id')) {
          this.db.exec('ALTER TABLE analyses ADD COLUMN parent_analysis_id TEXT');
        }
        if (!has('lineage_root_id')) {
          this.db.exec('ALTER TABLE analyses ADD COLUMN lineage_root_id TEXT');
        }
        if (!has('revision_ordinal')) {
          this.db.exec('ALTER TABLE analyses ADD COLUMN revision_ordinal INTEGER NOT NULL DEFAULT 0');
        }
        if (!has('graph_revision_id')) {
          this.db.exec('ALTER TABLE analyses ADD COLUMN graph_revision_id TEXT');
        }
        // Soft-archive primitive (deal-lifecycle base). Nullable-default-0 so
        // every existing deal stays active (archived=0). Reversible: flip to 0
        // to restore. This is the first use of the flag that a future
        // disposition doctrine (Cleared/Closed/Expired/Withdrawn) will build on.
        if (!has('archived')) {
          this.db.exec('ALTER TABLE analyses ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
        }
        // Backfill lineage_root_id = id for any existing rows where it's NULL.
        // parent_analysis_id stays NULL (these are root revisions). revision_ordinal stays 0.
        this.db.exec(`UPDATE analyses SET lineage_root_id = id WHERE lineage_root_id IS NULL`);
      }
    } catch { /* table might not exist yet — that's OK, migrate() just created it */ }
  }

  private seedCriteria() {
    const assetTypes: AssetType[] = [
      'office', 'multifamily', 'retail', 'industrial',
      'hotel', 'self_storage', 'mixed_use', 'manufactured_housing'
    ];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO criteria (asset_type, rules, scoring_weights) VALUES (?, ?, ?)`
    );
    for (const type of assetTypes) {
      const defaults = getDefaultCriteria(type);
      insert.run(type, JSON.stringify(defaults.rules), JSON.stringify(defaults.scoringWeights));
    }
  }

  // --- Serialization helpers ---

  private analysisToRow(a: Analysis) {
    // Pull comments out — they live in their own table
    const { comments, ...rest } = a;
    return {
      id: a.id,
      name: a.name,
      asset_type: a.assetType,
      status: a.status,
      progress: a.progress,
      current_step: a.currentStep,
      credit_score_overall: a.creditScore?.overall ?? null,
      risk_tier: a.creditScore?.riskTier ?? null,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      data: JSON.stringify(rest),
      error: a.error ?? null,
      // Batch 6.3 — lineage fields. Root revisions: parent=null, root=id, ordinal=0.
      parent_analysis_id: a.parentAnalysisId ?? null,
      lineage_root_id: a.lineageRootId ?? a.id,
      revision_ordinal: a.revisionOrdinal ?? 0,
      graph_revision_id: a.graphRevisionId ?? null,
    };
  }

  private rowToAnalysis(row: any): Analysis {
    const data = JSON.parse(row.data) as Omit<Analysis, 'comments'>;
    // Load comments from their own table
    const comments = this.getComments(row.id);
    // Lineage fields — read from row columns (authoritative; older rows backfilled in migration).
    return {
      ...data,
      comments,
      parentAnalysisId: row.parent_analysis_id ?? null,
      lineageRootId: row.lineage_root_id ?? row.id,
      revisionOrdinal: row.revision_ordinal ?? 0,
      graphRevisionId: row.graph_revision_id ?? null,
    };
  }

  /**
   * Direct better-sqlite3 handle. Reserved for instrumentation that needs
   * to lazily create its own append-only tables (observability, audit
   * traces). Callers must NOT mutate analysis / template / criteria rows
   * through this — use the typed methods instead.
   */
  rawDb(): Database.Database {
    return this.db;
  }

  // --- Analyses ---

  createAnalysis(analysis: Analysis): Analysis {
    const row = this.analysisToRow(analysis);
    this.db.prepare(`
      INSERT INTO analyses (id, name, asset_type, status, progress, current_step, credit_score_overall, risk_tier, created_at, updated_at, data, error, parent_analysis_id, lineage_root_id, revision_ordinal, graph_revision_id)
      VALUES (@id, @name, @asset_type, @status, @progress, @current_step, @credit_score_overall, @risk_tier, @created_at, @updated_at, @data, @error, @parent_analysis_id, @lineage_root_id, @revision_ordinal, @graph_revision_id)
    `).run(row);

    // Insert any initial comments
    if (analysis.comments?.length) {
      const insertComment = this.db.prepare(`
        INSERT INTO comments (id, analysis_id, section_id, finding_id, stance, text, author, created_at, updated_at)
        VALUES (@id, @analysis_id, @section_id, @finding_id, @stance, @text, @author, @created_at, @updated_at)
      `);
      for (const c of analysis.comments) {
        insertComment.run({
          id: c.id,
          analysis_id: analysis.id,
          section_id: c.sectionId,
          finding_id: c.findingId ?? null,
          stance: c.stance,
          text: c.text,
          author: c.author,
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        });
      }
    }

    return analysis;
  }

  getAnalysis(id: string): Analysis | null {
    const row = this.db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
    if (!row) return null;
    return this.rowToAnalysis(row);
  }

  /**
   * Unified-Read bridge — resolve the legacy `analyses` row whose
   * `graph_revision_id` points at a given graph RevisionId. Used by the
   * shared read resolver (`resolveAnalysisForRead`) to recover the legacy
   * substrate (deal name, appraisal/PCA/etc. overlays stored in the row's
   * `data` blob) for a deal being viewed through its 64-hex graph lineage.
   *
   * The legacy row's `graph_revision_id` bridges to the lineage HEAD revision
   * (see `lookupAnalysisByDealRef` docstring), so callers should pass the
   * envelope's `revisionId` for the LATEST revision of the lineage. Returns
   * null for pure-graph deals that never got a legacy row.
   */
  getAnalysisByGraphRevisionId(graphRevisionId: string): Analysis | null {
    const row = this.db
      .prepare('SELECT * FROM analyses WHERE graph_revision_id = ? LIMIT 1')
      .get(graphRevisionId);
    if (!row) return null;
    return this.rowToAnalysis(row);
  }

  /**
   * Funnel PR — lookup analyses by dealRef (the soft string id the pool layer
   * stores on each LoanInPool/LoanMembership). Walks the canonical join chain:
   *
   *   extraction_results.deal_ref
   *     → doctrine_evaluations.extraction_result_id   (FK + INDEX idx_doctrine_extraction)
   *     → revision_lineage_envelopes.doctrine_evaluation_id
   *     → revision_lineage_envelopes.lineage_root_id  (graph-spine analysis id; 64-hex)
   *     → analyses.graph_revision_id                   (legacy-spine bridge — LEFT JOIN)
   *
   * Returns the most-recent extraction first. The route layer picks the head
   * and reports `multipleFound` if `> 1` rows came back (re-extractions).
   *
   * Result shape:
   *   - legacyId:        legacy uuid analyses.id if a legacy row exists; null for pure-graph
   *   - graphId:         lineage_root_id (always present for any analysis with a graph spine,
   *                      which is every analysis since post-6.8 unification)
   *   - status:          legacy status if available (e.g. 'complete'); null for pure-graph
   *
   * The route layer prefers `legacyId` when present (more debuggable URL) and falls back
   * to `graphId`. The existing GET /:id dispatcher handles either format.
   */
  lookupAnalysisByDealRef(dealRef: string): Array<{
    legacyId: string | null;
    graphId: string;
    status: string | null;
    createdAt: string;
  }> {
    // PASS 1 — exact match on extraction_results.deal_ref. Fast path; unchanged.
    const exact = this.db.prepare(`
      SELECT
        a.id            AS legacy_id,
        rle.lineage_root_id AS graph_id,
        a.status        AS legacy_status,
        er.created_at   AS created_at
      FROM extraction_results er
      JOIN doctrine_evaluations de ON de.extraction_result_id = er.id
      JOIN revision_lineage_envelopes rle ON rle.doctrine_evaluation_id = de.id
      LEFT JOIN analyses a ON a.graph_revision_id = rle.revision_id
      WHERE er.deal_ref = ?
      ORDER BY er.created_at DESC
    `).all(dealRef) as Array<{
      legacy_id: string | null;
      graph_id: string;
      legacy_status: string | null;
      created_at: string;
    }>;
    // ★ Only SHORT-CIRCUIT when Pass 1 actually BRIDGED to a legacy analysis. The
    // LEFT JOIN binds `analyses.graph_revision_id = rle.revision_id` (a specific
    // envelope revision) — but a deal's legacy row points its graph_revision_id
    // at the CURRENT head, which need not equal the per-envelope revision_id the
    // extraction chain surfaces first. So Pass 1 can return extraction rows with a
    // NULL legacy_id even though a legacy analysis exists (this stranded 640 at
    // analyzed:false → a false "partial documents"). When no row bridged, fall
    // THROUGH to Pass 2's normalized-name rescue rather than returning the
    // graph-only rows early. Pass 1 still wins whenever it found the legacy link.
    const exactBridged = exact.filter((r) => r.legacy_id !== null);
    if (exactBridged.length > 0) {
      return exact.map((r) => ({
        legacyId: r.legacy_id,
        graphId: r.graph_id,
        status: r.legacy_status,
        createdAt: r.created_at,
      }));
    }
    // Pass-1 found extraction rows but none bridged to a legacy analysis. Keep
    // them as a FALLBACK: a genuine pure-graph deal (no legacy row to name-match)
    // must still resolve to its graphId, not "". Pass 2 only OVERRIDES this when
    // it positively matches a legacy analysis by normalized name.
    const pass1GraphOnly = (): Array<{ legacyId: string | null; graphId: string; status: string | null; createdAt: string }> =>
      exact.map((r) => ({
        legacyId: r.legacy_id,
        graphId: r.graph_id,
        status: r.legacy_status,
        createdAt: r.created_at,
      }));

    // PASS 2 — pool-mediated normalized-property-name fallback (DEAL END-TO-END
    // Slice 1). Bridges the pool/engine identity gap: a pool LoanInPool's
    // dealRef (e.g. 'bmark2024v8-sunroad-centrum') is keyed differently from
    // the engine analysis's extraction-side deal_ref (e.g. 'SUNROAD-CENTRUM-REAL')
    // even when they describe the same loan. The pool's
    // `loan_in_pool.originator_loan_ref` is already normalized to the property
    // name (set by the reseed parser via normalizePropertyName). The engine's
    // `analyses.name` carries the human-readable name with a trailing
    // parenthetical suffix; normalizeAnalysisNameForMatch strips that and
    // routes through the same normalizer. Match on the equality of those two
    // normalized strings.
    //
    // Honesty constraints:
    //   - Consulted when Pass 1 found no BRIDGED legacy analysis (zero rows, OR
    //     rows whose LEFT JOIN to analyses was null). Pass 1's bridged result
    //     still wins; this only rescues the unbridged case + falls back to the
    //     graph-only rows when it can't positively name-match.
    //   - Pool table must have a row for the incoming dealRef; else found:false.
    //     (We do not normalize arbitrary inputs as property names — that would
    //     turn dealRefs unrelated to any pool loan into false-positive matches.)
    //   - Engine-side analyses are filtered by normalized-name equality;
    //     if 0 matches → return [] (genuine not-found, NOT silent best-guess).
    //   - If >1 matches → return them all (route layer surfaces multipleFound).
    const poolRow = this.db.prepare(`
      SELECT originator_loan_ref
      FROM loan_in_pool
      WHERE deal_ref = ?
      LIMIT 1
    `).get(dealRef) as { originator_loan_ref: string | null } | undefined;
    if (!poolRow || !poolRow.originator_loan_ref) return pass1GraphOnly();

    const targetKey = normalizePropertyName(poolRow.originator_loan_ref);
    if (targetKey === null) return pass1GraphOnly();

    // Walk every analysis that's linked to a graph revision. N is small in
    // practice (one analysis per loan ever underwritten); pulling candidates
    // and filtering by normalized-name equality in JS keeps the SQL portable
    // (no SQL UDF required).
    const candidates = this.db.prepare(`
      SELECT
        a.id            AS legacy_id,
        a.name          AS legacy_name,
        a.status        AS legacy_status,
        rle.lineage_root_id AS graph_id,
        er.created_at   AS created_at
      FROM analyses a
      JOIN revision_lineage_envelopes rle ON rle.revision_id = a.graph_revision_id
      JOIN doctrine_evaluations de ON de.id = rle.doctrine_evaluation_id
      JOIN extraction_results er ON er.id = de.extraction_result_id
      WHERE a.graph_revision_id IS NOT NULL
      ORDER BY er.created_at DESC
    `).all() as Array<{
      legacy_id: string;
      legacy_name: string;
      legacy_status: string | null;
      graph_id: string;
      created_at: string;
    }>;

    const matches = candidates.filter((c) =>
      normalizeAnalysisNameForMatch(c.legacy_name) === targetKey
    );
    if (matches.length === 0) return pass1GraphOnly();
    return matches.map((r) => ({
      legacyId: r.legacy_id,
      graphId: r.graph_id,
      status: r.legacy_status,
      createdAt: r.created_at,
    }));
  }

  /**
   * ★ The CANONICAL scored analysis id for a deal_ref — the EARLIEST-created
   * legacy analysis among the deal's chains. A deal_ref can accrue duplicate
   * chains (a stray early drop; or a duplicate analysis minted by an errant
   * re-underwrite — 640 gained `82fe3bf7` on the `c9de8c37` chain from the
   * 2026-07-15 agent-fired-underwrite incident). The ORIGINAL analysis is the
   * deal's canonical identity; later SEPARATE-lineage analyses are artifacts (a
   * genuine re-underwrite APPENDS to the same analysis, it does not fork a new
   * legacy row). ★ BOTH the deal-page read (resolveAnalysisForRead) and pool
   * coverage resolve through THIS so the two surfaces can never disagree on which
   * copy of a deal is canonical. Returns null when no scored analysis exists.
   */
  getCanonicalScoredAnalysisId(dealRef: string): string | null {
    // Gather EVERY graph-backed copy of the deal, robust to a deal_ref split
    // across chains: (a) exact-deal_ref bridged analyses, PLUS (b) analyses whose
    // NORMALIZED property-name matches the deal (640 gained a duplicate whose
    // extraction deal_ref differs — '640 5th avenue' vs the pool's
    // 'bmark2024v8-640-5th-avenue' — but both share the name). Canonical = the
    // EARLIEST-created ANALYSIS (the original; a genuine re-underwrite APPENDS to
    // it, so a later separate row is a duplicate/artifact).
    const candidates = new Map<string, string>(); // legacyId → analysis.created_at
    const add = (id: string): void => {
      const r = this.db
        .prepare('SELECT created_at FROM analyses WHERE id = ? AND graph_revision_id IS NOT NULL')
        .get(id) as { created_at: string } | undefined;
      if (r) candidates.set(id, r.created_at);
    };
    for (const m of this.lookupAnalysisByDealRef(dealRef)) if (m.legacyId) add(m.legacyId);

    const poolRow = this.db
      .prepare('SELECT originator_loan_ref FROM loan_in_pool WHERE deal_ref = ? LIMIT 1')
      .get(dealRef) as { originator_loan_ref: string | null } | undefined;
    // Name-key: prefer the pool's normalized property name; else derive it from a
    // candidate analysis's name (so the artifact's OWN deal_ref, which has no pool
    // row, still finds the whole name-family and picks the original).
    let targetKey = poolRow?.originator_loan_ref ? normalizePropertyName(poolRow.originator_loan_ref) : null;
    if (targetKey === null && candidates.size > 0) {
      const anyId = [...candidates.keys()][0]!;
      const nm = this.db.prepare('SELECT name FROM analyses WHERE id = ?').get(anyId) as { name: string } | undefined;
      if (nm?.name) targetKey = normalizeAnalysisNameForMatch(nm.name);
    }
    if (targetKey !== null) {
      const all = this.db
        .prepare('SELECT id, name, created_at FROM analyses WHERE graph_revision_id IS NOT NULL')
        .all() as Array<{ id: string; name: string; created_at: string }>;
      for (const c of all) {
        if (normalizeAnalysisNameForMatch(c.name) === targetKey) candidates.set(c.id, c.created_at);
      }
    }

    // Rank by QUALITY, not time. (1) EXCLUDE archived — an archived copy is
    // never the canonical the app opens (closes the archive-completeness gap:
    // list-hide AND resolver-exclude). (2) Among the rest, prefer the BEST-
    // SOURCED, validly-scored copy: a validly-scored analysis (coverage gate not
    // fired) beats an insufficient-data one; a sourced valuation spine
    // (appraisal > ASR > neither) and validated income beat unsourced; tie-break
    // on the most recent ingest. This is correct whether later ingests IMPROVED
    // the deal (Sunroad: a later ingest added the appraisal → pick it) or DRIFTED
    // (a later duplicate artifact is worse-sourced → the original still wins).
    const ranked = [...candidates.keys()]
      .map((id) => ({ id, q: this.analysisCanonicalQuality(id) }))
      .filter((c): c is { id: string; q: AnalysisCanonicalQuality } => c.q !== null && !c.q.archived)
      .sort((a, b) => {
        if (a.q.scored !== b.q.scored) return a.q.scored ? -1 : 1;           // validly-scored first
        if (a.q.spineScore !== b.q.spineScore) return b.q.spineScore - a.q.spineScore; // appraisal > ASR > none
        if (a.q.validated !== b.q.validated) return a.q.validated ? -1 : 1;  // validated income first
        return b.q.createdAt.localeCompare(a.q.createdAt);                   // else most recent
      });
    return ranked[0]?.id ?? null; // best-sourced non-archived copy = canonical
  }

  /**
   * Canonical-ranking quality signals for one graph-backed analysis. Resolves
   * the analysis's HEAD revision → doctrine eval (coverage gate + score),
   * adjusted inputs (income confidence), and extraction (appraisal / ASR
   * presence). Returns null when the analysis has no resolvable graph chain.
   */
  private analysisCanonicalQuality(legacyId: string): AnalysisCanonicalQuality | null {
    const r = this.db.prepare(`
      SELECT a.archived AS archived, a.created_at AS createdAt,
        json_extract(d.payload, '$.coverage.insufficientCoverageGate') AS gate,
        json_extract(ai.payload, '$.dataConfidence') AS dc,
        (json_extract(er.payload, '$.appraisal') IS NOT NULL) AS hasAppraisal,
        (json_extract(er.payload, '$.asr') IS NOT NULL) AS hasAsr
      FROM analyses a
      JOIN revision_lineage_envelopes e ON e.revision_id = a.graph_revision_id
      JOIN doctrine_evaluations d ON d.id = e.doctrine_evaluation_id
      JOIN adjusted_inputs ai ON ai.id = e.adjusted_inputs_id
      LEFT JOIN extraction_results er ON er.id = d.extraction_result_id
      WHERE a.id = ?
    `).get(legacyId) as
      | { archived: number; createdAt: string; gate: number | null; dc: string | null; hasAppraisal: number; hasAsr: number }
      | undefined;
    if (r === undefined) return null;
    return {
      archived: r.archived === 1,
      scored: r.gate !== 1,                                   // coverage gate NOT fired
      spineScore: r.hasAppraisal ? 2 : r.hasAsr ? 1 : 0,       // sourced valuation spine
      validated: r.dc === 'validated',
      createdAt: r.createdAt,
    };
  }

  /**
   * Phase A (forward root→loan resolver) — FORWARD counterpart of
   * `lookupAnalysisByDealRef`. Given a graph ROOT (`lineage_root_id`, 64-hex),
   * return that root's extraction `deal_ref` and its human `analyses.name`.
   *
   * This walks the SAME canonical join chain as `lookupAnalysisByDealRef`
   * PASS-1 (`extraction_results → doctrine_evaluations → revision_lineage_envelopes`),
   * but run FORWARD: the root is the input (the envelope's `lineage_root_id`),
   * not the extraction `deal_ref`. `revision_ordinal = 0` pins the root revision
   * of the lineage, whose evaluation carries the root's extraction.
   *
   * `name` is resolved from `analyses.name` by joining ANY revision in the
   * lineage (`analyses.graph_revision_id = rle.revision_id`, over all ordinals),
   * because the legacy `analyses` row's `graph_revision_id` points at the lineage
   * HEAD revision, not the root revision. Pure-graph roots that never got a legacy
   * `analyses` row return `name: null` — the resolver's PASS-2 name bridge then
   * simply finds no name to normalize (honest refuse, never a guess).
   *
   * Returns `null` when `rootId` is not a known lineage root.
   */
  getRootRefAndName(rootId: string): { readonly dealRef: string; readonly name: string | null } | null {
    const row = this.db.prepare(`
      SELECT
        er.deal_ref AS deal_ref,
        (
          SELECT a.name
          FROM analyses a
          JOIN revision_lineage_envelopes r2 ON r2.revision_id = a.graph_revision_id
          WHERE r2.lineage_root_id = rle.lineage_root_id
          LIMIT 1
        ) AS name
      FROM revision_lineage_envelopes rle
      JOIN doctrine_evaluations de ON de.id = rle.doctrine_evaluation_id
      JOIN extraction_results er ON er.id = de.extraction_result_id
      WHERE rle.lineage_root_id = ? AND rle.revision_ordinal = 0
      LIMIT 1
    `).get(rootId) as { deal_ref: string; name: string | null } | undefined;
    if (!row) return null;
    return { dealRef: row.deal_ref, name: row.name ?? null };
  }

  /**
   * Translate a `doctrine_evaluation_id` → its `lineage_root_id` (1:1; an eval id
   * appears on exactly one revision envelope). Used to normalize the id the render
   * surface holds — `RenderedAnalysis.rootId` is a DoctrineEvaluationId, but the
   * forward loan resolver keys on `lineage_root_id`. Returns null when the id is not
   * a known doctrine_evaluation_id (e.g. it is already a lineage_root_id, or garbage).
   */
  getLineageRootForEvaluation(evalId: string): string | null {
    const row = this.db
      .prepare(`SELECT lineage_root_id FROM revision_lineage_envelopes WHERE doctrine_evaluation_id = ? LIMIT 1`)
      .get(evalId) as { lineage_root_id: string } | undefined;
    return row?.lineage_root_id ?? null;
  }

  /**
   * The engine's asset type for a graph id — reads AssetProfile.propertyType off the
   * doctrine evaluation. Accepts ANY of the three graph ids a caller might hold: a
   * `doctrine_evaluation_id` (what RenderedAnalysis.rootId is — the deal-room path), a
   * `lineage_root_id`, or a `revision_id` (what the underwrite result carries). READ-ONLY
   * over the content-hashed graph — never mutates the mint. Returns the raw propertyType
   * (may be un-normalized casing); callers normalize via `normalizeAssetType`. null when
   * the id has no profiled evaluation (e.g. an un-underwritten loan).
   */
  getPropertyTypeForRoot(graphId: string): string | null {
    const row = this.db
      .prepare(`
        SELECT ap.payload AS payload
        FROM asset_profiles ap
        JOIN doctrine_evaluations de ON de.asset_profile_id = ap.id
        LEFT JOIN revision_lineage_envelopes rle ON rle.doctrine_evaluation_id = de.id
        WHERE de.id = @id OR rle.lineage_root_id = @id OR rle.revision_id = @id
        LIMIT 1
      `)
      .get({ id: graphId }) as { payload: string } | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.payload) as { propertyType?: string | null }).propertyType ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Soft-archive primitive. Flips analyses.archived. Reversible — pass false to
   * restore. Returns false when the id doesn't exist. Touches ONLY the analyses
   * row; the graph spine + content-addressed blobs are untouched.
   */
  setAnalysisArchived(id: string, archived: boolean): boolean {
    const result = this.db
      .prepare('UPDATE analyses SET archived = ?, updated_at = updated_at WHERE id = ?')
      .run(archived ? 1 : 0, id);
    return result.changes > 0;
  }

  /** Whether an analysis is archived. Null when the id doesn't exist. */
  isAnalysisArchived(id: string): boolean | null {
    const row = this.db.prepare('SELECT archived FROM analyses WHERE id = ?').get(id) as { archived?: number } | undefined;
    return row === undefined ? null : row.archived === 1;
  }

  listAnalyses(includeArchived = false): AnalysisSummary[] {
    // Soft-archive: the deal list hides archived deals by default. Pass
    // includeArchived to retrieve them (nothing is lost — archived deals stay
    // in the table and are one flag-flip from active).
    const rows = this.db.prepare(
      `SELECT id, name, asset_type, status, credit_score_overall, risk_tier, created_at, updated_at, data, parent_analysis_id, lineage_root_id, revision_ordinal FROM analyses ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at DESC`
    ).all() as any[];

    return rows.map((r) => {
      let inputHash: string | undefined;
      let manifestoVersion: string | undefined;
      let modelLogicVersion: string | undefined;
      try {
        const data = JSON.parse(r.data);
        inputHash = data.inputHash;
        manifestoVersion = data.manifestoVersion;
        modelLogicVersion = data.modelLogicVersion;
      } catch {}
      return {
        id: r.id,
        name: r.name,
        assetType: r.asset_type,
        status: r.status,
        creditScore: r.credit_score_overall,
        riskTier: r.risk_tier,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        inputHash,
        manifestoVersion,
        modelLogicVersion,
        parentAnalysisId: r.parent_analysis_id ?? null,
        lineageRootId: r.lineage_root_id ?? r.id,
        revisionOrdinal: r.revision_ordinal ?? 0,
      };
    });
  }

  /**
   * Return the LATEST revision in a lineage, given any analysis id within that lineage.
   * "Latest" = the row with the highest `revision_ordinal` among rows sharing the same
   * `lineage_root_id`. Used by `GET /analyses/:id` per the revision-lineage spec §7.
   *
   * Append-only by construction — there is no "edit" path that would require this query
   * to disambiguate concurrent writes; the highest ordinal IS the latest.
   */
  getLatestRevisionInLineage(analysisId: string): Analysis | null {
    const head = this.db.prepare(
      'SELECT lineage_root_id FROM analyses WHERE id = ?'
    ).get(analysisId) as any;
    if (!head) return null;
    const rootId = head.lineage_root_id ?? analysisId;
    const row = this.db.prepare(
      `SELECT * FROM analyses
        WHERE lineage_root_id = ?
        ORDER BY revision_ordinal DESC, created_at DESC
        LIMIT 1`
    ).get(rootId) as any;
    return row ? this.rowToAnalysis(row) : null;
  }

  /**
   * Return the full lineage chain (every revision sharing the same `lineage_root_id`),
   * ordered by `revision_ordinal` ascending. Append-only by construction (no UPDATE on
   * lineage columns is allowed; revisions are inserted as new rows).
   *
   * Batch 6.3 — backs `GET /analyses/:id/lineage`.
   */
  listLineage(analysisId: string): import('@cre/shared').LineageEntry[] {
    // First resolve which lineage this analysis belongs to (latest revisions and root all share root_id).
    const head = this.db.prepare(
      'SELECT lineage_root_id FROM analyses WHERE id = ?'
    ).get(analysisId) as any;
    if (!head) return [];
    const rootId = head.lineage_root_id ?? analysisId;

    const rows = this.db.prepare(
      `SELECT id, name, parent_analysis_id, lineage_root_id, revision_ordinal,
              created_at, status, credit_score_overall, risk_tier
         FROM analyses
        WHERE lineage_root_id = ?
        ORDER BY revision_ordinal ASC, created_at ASC`
    ).all(rootId) as any[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentAnalysisId: r.parent_analysis_id ?? null,
      lineageRootId: r.lineage_root_id ?? r.id,
      revisionOrdinal: r.revision_ordinal ?? 0,
      createdAt: r.created_at,
      status: r.status,
      creditScore: r.credit_score_overall,
      riskTier: r.risk_tier,
    }));
  }

  updateAnalysis(id: string, updates: Partial<Analysis>): Analysis | null {
    const existing = this.getAnalysis(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    const row = this.analysisToRow(updated);

    this.db.prepare(`
      UPDATE analyses SET
        name = @name,
        asset_type = @asset_type,
        status = @status,
        progress = @progress,
        current_step = @current_step,
        credit_score_overall = @credit_score_overall,
        risk_tier = @risk_tier,
        updated_at = @updated_at,
        data = @data,
        error = @error,
        graph_revision_id = @graph_revision_id
      WHERE id = @id
    `).run(row);

    return updated;
  }

  deleteAnalysis(id: string): boolean {
    const result = this.db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // --- Comments ---

  addComment(analysisId: string, comment: Comment): Comment | null {
    const exists = this.db.prepare('SELECT id FROM analyses WHERE id = ?').get(analysisId);
    if (!exists) return null;

    this.db.prepare(`
      INSERT INTO comments (id, analysis_id, section_id, finding_id, stance, text, author, created_at, updated_at)
      VALUES (@id, @analysis_id, @section_id, @finding_id, @stance, @text, @author, @created_at, @updated_at)
    `).run({
      id: comment.id,
      analysis_id: analysisId,
      section_id: comment.sectionId,
      finding_id: comment.findingId ?? null,
      stance: comment.stance,
      text: comment.text,
      author: comment.author,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    });

    // Touch the analysis updated_at
    this.db.prepare('UPDATE analyses SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), analysisId);

    return comment;
  }

  getComments(analysisId: string): Comment[] {
    const rows = this.db.prepare(
      'SELECT * FROM comments WHERE analysis_id = ? ORDER BY created_at ASC'
    ).all(analysisId) as any[];

    return rows.map((r) => ({
      id: r.id,
      analysisId: r.analysis_id,
      sectionId: r.section_id,
      findingId: r.finding_id ?? undefined,
      stance: r.stance,
      text: r.text,
      author: r.author,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  updateComment(analysisId: string, commentId: string, updates: Partial<Comment>): Comment | null {
    const row = this.db.prepare(
      'SELECT * FROM comments WHERE id = ? AND analysis_id = ?'
    ).get(commentId, analysisId) as any;
    if (!row) return null;

    const now = new Date().toISOString();
    if (updates.stance !== undefined) {
      this.db.prepare('UPDATE comments SET stance = ? WHERE id = ?').run(updates.stance, commentId);
    }
    if (updates.text !== undefined) {
      this.db.prepare('UPDATE comments SET text = ? WHERE id = ?').run(updates.text, commentId);
    }
    this.db.prepare('UPDATE comments SET updated_at = ? WHERE id = ?').run(now, commentId);

    const updated = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as any;
    return {
      id: updated.id,
      analysisId: updated.analysis_id,
      sectionId: updated.section_id,
      findingId: updated.finding_id ?? undefined,
      stance: updated.stance,
      text: updated.text,
      author: updated.author,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  }

  deleteComment(analysisId: string, commentId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM comments WHERE id = ? AND analysis_id = ?'
    ).run(commentId, analysisId);
    return result.changes > 0;
  }

  // --- Criteria ---

  getCriteria(assetType: AssetType): CriteriaRuleSet | null {
    const row = this.db.prepare('SELECT * FROM criteria WHERE asset_type = ?').get(assetType) as any;
    if (!row) return null;
    return {
      assetType: row.asset_type as AssetType,
      rules: JSON.parse(row.rules),
      scoringWeights: JSON.parse(row.scoring_weights),
    };
  }

  updateCriteria(assetType: AssetType, ruleSet: CriteriaRuleSet): CriteriaRuleSet {
    this.db.prepare(`
      INSERT INTO criteria (asset_type, rules, scoring_weights)
      VALUES (?, ?, ?)
      ON CONFLICT(asset_type) DO UPDATE SET
        rules = excluded.rules,
        scoring_weights = excluded.scoring_weights
    `).run(assetType, JSON.stringify(ruleSet.rules), JSON.stringify(ruleSet.scoringWeights));
    return ruleSet;
  }

  // --- Users ---

  private seedDefaultUser() {
    const { v4: uuidv4 } = require('uuid');
    // Idempotent per-email seed. Existing admin seeding is unchanged; role-siloing
    // chunk 1 adds one ORIGINATOR + one BUYER dev user so each side can be logged in
    // as. Roles are stored lowercase (translated to the uppercase contract enum at the
    // JWT boundary). Additive — no existing user or role is modified.
    const seeds: ReadonlyArray<{ email: string; name: string; role: string; password: string }> = [
      { email: 'admin@cre.com',      name: 'Admin',      role: 'admin',      password: 'admin123' },
      { email: 'originator@cre.com', name: 'Servicer',   role: 'originator', password: 'originator123' }, // display name only — email + role value 'originator' are identity (unchanged)
      { email: 'buyer@cre.com',      name: 'Buyer',      role: 'buyer',      password: 'buyer123' },
    ];
    for (const s of seeds) {
      const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(s.email);
      if (existing) continue;
      const hash = bcrypt.hashSync(s.password, 10);
      this.db.prepare(
        'INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuidv4(), s.email, hash, s.name, s.role, new Date().toISOString());
    }
  }

  createUser(user: { email: string; password: string; name: string; role?: string }): User {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const hash = bcrypt.hashSync(user.password, 10);
    const now = new Date().toISOString();
    const role = user.role || 'analyst';

    this.db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, user.email, hash, user.name, role, now);

    return { id, email: user.email, passwordHash: hash, name: user.name, role: role as User['role'], createdAt: now };
  }

  getUserByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  verifyPassword(plaintext: string, hash: string): boolean {
    return bcrypt.compareSync(plaintext, hash);
  }

  // --- Underwriting Templates ---

  uploadTemplate(
    id: string,
    templateType: TemplateType,
    fileName: string,
    fileData: Buffer,
    uploadedBy: string,
    structureJson?: string
  ): UnderwritingTemplate {
    const now = new Date().toISOString();

    // Get next version number for this template type
    const latest = this.db.prepare(
      'SELECT MAX(version) as maxVersion FROM uw_templates WHERE template_type = ?'
    ).get(templateType) as any;
    const version = (latest?.maxVersion || 0) + 1;

    // Storage-boundary registry gate (root-cause fix for the v3/v4/v5 / v6 /
    // v10 pollution pattern). Refuses to write a uw_templates row whose
    // (templateType, MAX+1) has no entry in apps/api/src/services/
    // template-registry.ts. Operators must land a registry commit BEFORE
    // uploading the artifact so getTemplateMetadata is non-null at read time
    // and the export pipeline's compatibility check has something to validate.
    //
    // SCOPE: this gate covers the uploadTemplate path ONLY. Direct INSERTs
    // (remediation scripts that need to land a specific version that doesn't
    // match MAX+1) MUST self-gate by checking getTemplateMetadata(templateType,
    // explicitVersion) before INSERT — the residual is NOT silent because the
    // remediation scripts (remediate-template-registry-v6.ts /
    // remediate-template-registry-v10.ts) each pre-flight against the registry
    // by convention. Future remediation scripts MUST follow the same pattern.
    if (getTemplateMetadata(templateType, version) === null) {
      throw new TemplateRegistryGateError({
        templateType,
        targetVersion: version,
        registeredVersions: getRegisteredVersionsForType(templateType),
      });
    }

    // Deactivate all previous templates of this type
    this.db.prepare(
      'UPDATE uw_templates SET is_active = 0 WHERE template_type = ?'
    ).run(templateType);

    // Insert the new template
    this.db.prepare(`
      INSERT INTO uw_templates (id, template_type, version, file_name, file_size, file_data, structure_json, uploaded_by, uploaded_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, templateType, version, fileName, fileData.length, fileData, structureJson || null, uploadedBy, now);

    return {
      id,
      templateType,
      version,
      fileName,
      fileSize: fileData.length,
      uploadedBy,
      uploadedAt: now,
      isActive: true,
    };
  }

  getActiveTemplate(templateType: TemplateType): (UnderwritingTemplate & {
    fileData: Buffer;
    structureJson: string | null;
    /**
     * Compatibility envelope from the code-declared template registry, looked
     * up by exact (templateType, version). null when the artifact's version is
     * not registered — callers MUST treat that as a hard incompatibility.
     */
    templateMetadata: TemplateMetadata | null;
  }) | null {
    const row = this.db.prepare(
      'SELECT * FROM uw_templates WHERE template_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1'
    ).get(templateType) as any;
    if (!row) return null;
    return {
      id: row.id,
      templateType: row.template_type,
      version: row.version,
      fileName: row.file_name,
      fileSize: row.file_size,
      fileData: row.file_data,
      structureJson: row.structure_json || null,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.uploaded_at,
      isActive: !!row.is_active,
      templateMetadata: getTemplateMetadata(row.template_type, row.version),
    };
  }

  listTemplates(templateType?: TemplateType): UnderwritingTemplate[] {
    let rows: any[];
    if (templateType) {
      rows = this.db.prepare(
        'SELECT id, template_type, version, file_name, file_size, uploaded_by, uploaded_at, is_active FROM uw_templates WHERE template_type = ? ORDER BY version DESC'
      ).all(templateType) as any[];
    } else {
      rows = this.db.prepare(
        'SELECT id, template_type, version, file_name, file_size, uploaded_by, uploaded_at, is_active FROM uw_templates ORDER BY template_type, version DESC'
      ).all() as any[];
    }
    return rows.map((r) => ({
      id: r.id,
      templateType: r.template_type,
      version: r.version,
      fileName: r.file_name,
      fileSize: r.file_size,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
      isActive: !!r.is_active,
    }));
  }

  getTemplateVersions(templateType: TemplateType): TemplateVersion[] {
    const rows = this.db.prepare(
      'SELECT id, template_type, version, file_name, file_size, uploaded_by, uploaded_at FROM uw_templates WHERE template_type = ? ORDER BY version DESC'
    ).all(templateType) as any[];
    return rows.map((r) => ({
      id: r.id,
      templateId: r.id,
      templateType: r.template_type,
      version: r.version,
      fileName: r.file_name,
      fileSize: r.file_size,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
    }));
  }

  activateTemplateVersion(id: string): boolean {
    const row = this.db.prepare('SELECT template_type FROM uw_templates WHERE id = ?').get(id) as any;
    if (!row) return false;

    this.db.prepare('UPDATE uw_templates SET is_active = 0 WHERE template_type = ?').run(row.template_type);
    this.db.prepare('UPDATE uw_templates SET is_active = 1 WHERE id = ?').run(id);
    return true;
  }

  deleteTemplate(id: string): boolean {
    const result = this.db.prepare('DELETE FROM uw_templates WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getTemplateFile(id: string): { fileName: string; fileData: Buffer } | null {
    const row = this.db.prepare('SELECT file_name, file_data FROM uw_templates WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { fileName: row.file_name, fileData: row.file_data };
  }

  // --- Populated Templates (generated per-analysis) ---

  savePopulatedTemplate(
    id: string,
    analysisId: string,
    fileName: string,
    fileData: Buffer,
    mappedFields: string,
    unmappedFields: string,
    tabsPopulated: string,
  ): void {
    // Remove any existing populated template for this analysis
    this.db.prepare('DELETE FROM populated_templates WHERE analysis_id = ?').run(analysisId);

    this.db.prepare(`
      INSERT INTO populated_templates (id, analysis_id, file_name, file_data, mapped_fields, unmapped_fields, tabs_populated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, analysisId, fileName, fileData, mappedFields, unmappedFields, tabsPopulated, new Date().toISOString());
  }

  getPopulatedTemplate(analysisId: string): { id: string; fileName: string; fileData: Buffer; mappedFields: string; unmappedFields: string; tabsPopulated: string } | null {
    const row = this.db.prepare('SELECT * FROM populated_templates WHERE analysis_id = ?').get(analysisId) as any;
    if (!row) return null;
    return {
      id: row.id,
      fileName: row.file_name,
      fileData: row.file_data,
      mappedFields: row.mapped_fields || '[]',
      unmappedFields: row.unmapped_fields || '[]',
      tabsPopulated: row.tabs_populated || '[]',
    };
  }
  // --- Original Uploads ---

  saveOriginalUpload(id: string, analysisId: string, fileType: string, fileName: string, mimeType: string, fileData: Buffer): void {
    this.db.prepare(`
      INSERT INTO original_uploads (id, analysis_id, file_type, file_name, mime_type, file_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, analysisId, fileType, fileName, mimeType, fileData, new Date().toISOString());
  }

  getOriginalUpload(analysisId: string, fileType: string): { fileName: string; mimeType: string; fileData: Buffer } | null {
    const row = this.db.prepare(
      'SELECT file_name, mime_type, file_data FROM original_uploads WHERE analysis_id = ? AND file_type = ?'
    ).get(analysisId, fileType) as any;
    if (!row) return null;
    return { fileName: row.file_name, mimeType: row.mime_type, fileData: row.file_data };
  }

  listOriginalUploads(analysisId: string): { fileType: string; fileName: string; mimeType: string }[] {
    const rows = this.db.prepare(
      'SELECT file_type, file_name, mime_type FROM original_uploads WHERE analysis_id = ?'
    ).all(analysisId) as any[];
    return rows.map(r => ({ fileType: r.file_type, fileName: r.file_name, mimeType: r.mime_type }));
  }

  // --- Credit Manifesto ---

  createManifesto(id: string, fileName: string, fileData: Buffer, rawText: string, uploadedBy: string): { id: string; version: number } {
    const now = new Date().toISOString();
    const latest = this.db.prepare(
      'SELECT MAX(version) as maxVersion FROM credit_manifesto'
    ).get() as any;
    const version = (latest?.maxVersion || 0) + 1;

    this.db.prepare(`
      INSERT INTO credit_manifesto
        (id, version, file_name, file_size, file_data, raw_text, extracted_rules_json,
         ambiguities_json, scoring_weights_json, asset_types_covered, status,
         uploaded_by, uploaded_at, processed_at, is_active, error)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', NULL, '[]', 'processing', ?, ?, NULL, 0, NULL)
    `).run(id, version, fileName, fileData.length, fileData, rawText, uploadedBy, now);

    return { id, version };
  }

  activateManifesto(
    id: string,
    extractedRulesJson: string,
    ambiguitiesJson: string,
    assetTypesCovered: string,
    scoringWeightsJson: string | null
  ): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE credit_manifesto SET is_active = 0').run();
    this.db.prepare(`
      UPDATE credit_manifesto SET
        extracted_rules_json = ?,
        ambiguities_json = ?,
        asset_types_covered = ?,
        scoring_weights_json = ?,
        status = 'active',
        processed_at = ?,
        is_active = 1
      WHERE id = ?
    `).run(extractedRulesJson, ambiguitiesJson, assetTypesCovered, scoringWeightsJson, now, id);
  }

  failManifesto(id: string, error: string): void {
    this.db.prepare(
      "UPDATE credit_manifesto SET status = 'error', error = ?, processed_at = ? WHERE id = ?"
    ).run(error, new Date().toISOString(), id);
  }

  getActiveManifesto(): CreditManifestoDetail | null {
    const row = this.db.prepare(
      'SELECT * FROM credit_manifesto WHERE is_active = 1 LIMIT 1'
    ).get() as any;
    if (!row) return null;
    return this.manifestoRowToDetail(row);
  }

  getManifesto(id: string): CreditManifestoDetail | null {
    const row = this.db.prepare(
      'SELECT * FROM credit_manifesto WHERE id = ?'
    ).get(id) as any;
    if (!row) return null;
    return this.manifestoRowToDetail(row);
  }

  listManifestos(): CreditManifesto[] {
    const rows = this.db.prepare(
      'SELECT id, version, file_name, file_size, status, extracted_rules_json, ambiguities_json, asset_types_covered, uploaded_by, uploaded_at, processed_at, is_active, error FROM credit_manifesto ORDER BY version DESC'
    ).all() as any[];
    return rows.map(r => ({
      id: r.id,
      version: r.version,
      fileName: r.file_name,
      fileSize: r.file_size,
      status: r.status,
      extractedRulesCount: JSON.parse(r.extracted_rules_json || '[]').length,
      ambiguitiesCount: JSON.parse(r.ambiguities_json || '[]').length,
      assetTypesCovered: JSON.parse(r.asset_types_covered || '[]'),
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
      processedAt: r.processed_at,
      isActive: !!r.is_active,
      error: r.error,
    }));
  }

  hasActiveManifesto(): boolean {
    const row = this.db.prepare(
      'SELECT id FROM credit_manifesto WHERE is_active = 1 LIMIT 1'
    ).get();
    return !!row;
  }

  private manifestoRowToDetail(row: any): CreditManifestoDetail {
    const extractedRules = JSON.parse(row.extracted_rules_json || '[]');
    const ambiguities = JSON.parse(row.ambiguities_json || '[]');
    return {
      id: row.id,
      version: row.version,
      fileName: row.file_name,
      fileSize: row.file_size,
      status: row.status,
      extractedRules,
      extractedRulesCount: extractedRules.length,
      ambiguities,
      ambiguitiesCount: ambiguities.length,
      scoringWeights: row.scoring_weights_json ? JSON.parse(row.scoring_weights_json) : null,
      assetTypesCovered: JSON.parse(row.asset_types_covered || '[]'),
      rawText: row.raw_text,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.uploaded_at,
      processedAt: row.processed_at,
      isActive: !!row.is_active,
      error: row.error,
    };
  }

  // --- Version Audit Log ---

  writeAuditLog(entry: AuditLogEntry): void {
    this.db.prepare(`
      INSERT INTO version_audit_log
        (id, analysis_id, analysis_name, asset_type, input_hash, manifesto_version,
         manifesto_label, model_logic_version, credit_score_overall, recommendation,
         risk_tier, validation_passed, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.analysisId, entry.analysisName, entry.assetType,
      entry.inputHash, entry.manifestoVersion, entry.manifestoLabel,
      entry.modelLogicVersion, entry.creditScoreOverall, entry.recommendation,
      entry.riskTier, entry.validationPassed ? 1 : 0, entry.timestamp,
    );
  }

  getAuditLog(filters?: { assetType?: string; limit?: number }): AuditLogEntry[] {
    let sql = 'SELECT * FROM version_audit_log';
    const params: any[] = [];
    if (filters?.assetType) {
      sql += ' WHERE asset_type = ?';
      params.push(filters.assetType);
    }
    sql += ' ORDER BY timestamp DESC';
    if (filters?.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(this.auditRowToEntry);
  }

  getAuditLogByAnalysis(analysisId: string): AuditLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM version_audit_log WHERE analysis_id = ? ORDER BY timestamp DESC'
    ).all(analysisId) as any[];
    return rows.map(this.auditRowToEntry);
  }

  getAuditLogByInputHash(inputHash: string): AuditLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM version_audit_log WHERE input_hash = ? ORDER BY timestamp DESC'
    ).all(inputHash) as any[];
    return rows.map(this.auditRowToEntry);
  }

  private auditRowToEntry(row: any): AuditLogEntry {
    return {
      id: row.id,
      analysisId: row.analysis_id,
      analysisName: row.analysis_name,
      assetType: row.asset_type,
      inputHash: row.input_hash,
      manifestoVersion: row.manifesto_version,
      manifestoLabel: row.manifesto_label,
      modelLogicVersion: row.model_logic_version,
      creditScoreOverall: row.credit_score_overall,
      recommendation: row.recommendation,
      riskTier: row.risk_tier,
      validationPassed: !!row.validation_passed,
      timestamp: row.timestamp,
    };
  }

  // --- Model Logic Versions ---

  registerModelLogicVersion(version: string, description: string, changes: string[]): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO model_logic_versions (version, description, changes_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(version, description, JSON.stringify(changes), new Date().toISOString());
  }

  listModelLogicVersions(): ModelLogicVersionEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM model_logic_versions ORDER BY created_at DESC'
    ).all() as any[];
    return rows.map(r => ({
      version: r.version,
      description: r.description,
      changes: JSON.parse(r.changes_json),
      createdAt: r.created_at,
    }));
  }

  // --- Analysis Cache (Consistency Engine) ---

  getCacheEntry(inputHash: string): { analysisId: string; createdAt: string } | null {
    const row = this.db.prepare(
      'SELECT analysis_id, created_at FROM analysis_cache WHERE input_hash = ?'
    ).get(inputHash) as any;
    if (!row) return null;

    // Verify the referenced analysis still exists and is complete
    const analysis = this.db.prepare(
      'SELECT status FROM analyses WHERE id = ?'
    ).get(row.analysis_id) as any;
    if (!analysis || analysis.status !== 'complete') {
      // Stale entry — analysis was deleted or errored; prune cache entry
      this.db.prepare('DELETE FROM analysis_cache WHERE input_hash = ?').run(inputHash);
      return null;
    }

    return { analysisId: row.analysis_id, createdAt: row.created_at };
  }

  createCacheEntry(inputHash: string, analysisId: string, componentsJson: string): void {
    const components = JSON.parse(componentsJson);
    this.db.prepare(`
      INSERT OR REPLACE INTO analysis_cache
        (input_hash, analysis_id, asset_type, manifesto_version, model_logic_version, components_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      inputHash,
      analysisId,
      components.assetType,
      components.manifestoVersion,
      components.modelLogicVersion,
      componentsJson,
      new Date().toISOString()
    );
  }

  invalidateCacheByAssetType(assetType: string): number {
    const result = this.db.prepare(
      'DELETE FROM analysis_cache WHERE asset_type = ?'
    ).run(assetType);
    return result.changes;
  }

  invalidateCacheByAnalysisId(analysisId: string): number {
    const result = this.db.prepare(
      'DELETE FROM analysis_cache WHERE analysis_id = ?'
    ).run(analysisId);
    return result.changes;
  }
}

export const store = new SqliteStore();
