import Database from 'better-sqlite3';
import path from 'path';
import bcrypt from 'bcryptjs';
import {
  Analysis, AnalysisSummary, Comment, AssetType, CriteriaEvaluation,
  FindingCategory, AuditLogEntry, ModelLogicVersionEntry
} from '@cre/shared';
import { CriteriaRuleSet } from '@cre/shared';
import type { TemplateType, UnderwritingTemplate, TemplateVersion, CreditManifesto, CreditManifestoDetail } from '@cre/shared';
import { getDefaultCriteria } from '../services/default-criteria.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: 'admin' | 'analyst' | 'viewer';
  createdAt: string;
}

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

class SqliteStore {
  private db: Database.Database;

  constructor() {
    // Ensure data directory exists
    const dir = path.dirname(DB_PATH);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(DB_PATH);
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
        error TEXT
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
    };
  }

  private rowToAnalysis(row: any): Analysis {
    const data = JSON.parse(row.data) as Omit<Analysis, 'comments'>;
    // Load comments from their own table
    const comments = this.getComments(row.id);
    return { ...data, comments };
  }

  // --- Analyses ---

  createAnalysis(analysis: Analysis): Analysis {
    const row = this.analysisToRow(analysis);
    this.db.prepare(`
      INSERT INTO analyses (id, name, asset_type, status, progress, current_step, credit_score_overall, risk_tier, created_at, updated_at, data, error)
      VALUES (@id, @name, @asset_type, @status, @progress, @current_step, @credit_score_overall, @risk_tier, @created_at, @updated_at, @data, @error)
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

  listAnalyses(): AnalysisSummary[] {
    const rows = this.db.prepare(
      'SELECT id, name, asset_type, status, credit_score_overall, risk_tier, created_at, updated_at, data FROM analyses ORDER BY created_at DESC'
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
      };
    });
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
        error = @error
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
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get('admin@cre.com');
    if (existing) return;

    const { v4: uuidv4 } = require('uuid');
    const hash = bcrypt.hashSync('admin123', 10);
    this.db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), 'admin@cre.com', hash, 'Admin', 'admin', new Date().toISOString());
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

  getActiveTemplate(templateType: TemplateType): (UnderwritingTemplate & { fileData: Buffer; structureJson: string | null }) | null {
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
