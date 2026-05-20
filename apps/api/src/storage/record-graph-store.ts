/**
 * RecordGraphStore — content-addressable persistence for the doctrine pipeline.
 *
 * Seven tables, each a stage-output record from `@cre/contracts`. PK is the record's
 * `ContentHash` id (= SHA-256 of the JCS-canonical body without the id field). FKs enforce the
 * upstream record graph: AdjustedInputs → LibrarySnapshot; CrossCheckResult/StressOutputs →
 * AdjustedInputs; ValuationConclusion → AdjustedInputs + StressOutputs + NarrativeFacts;
 * DoctrineEvaluation → all upstream.
 *
 * Insert semantics:
 *   - `INSERT ... ON CONFLICT(id) DO NOTHING` — idempotent re-insert (same content = same id =
 *     no-op). FK violations and other constraint failures bubble up as errors.
 *   - No UPDATE statements. Records are immutable once persisted; mutating one would invalidate
 *     its content hash.
 *
 * Insert verification:
 *   - On every insert, the provided `record.id` is recomputed from the body. Mismatch throws
 *     `RecordIdMismatchError` — catches producers that constructed a record without using the
 *     contract-provided `compute*Id` factories.
 *
 * Database connection:
 *   - Opens its own connection to the same sqlite file as `SqliteStore`. WAL + foreign_keys ON.
 *   - Tests pass `':memory:'` to the constructor for isolation.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AssetProfile,
  AssetProfileId,
  CrossCheckResult,
  CrossCheckResultId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ExtractionResultId,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeFacts,
  NarrativeFactsId,
  PropertyMetadata,
  PropertyMetadataId,
  RenderedAnalysis,
  RenderedAnalysisId,
  RenderVersion,
  StressOutputs,
  StressOutputsId,
  ValuationConclusion,
  ValuationConclusionId,
} from '@cre/contracts';
import { serializeRecordBody } from '../util/content-hash.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

export class RecordIdMismatchError extends Error {
  override readonly name = 'RecordIdMismatchError';
  constructor(
    public readonly recordKind: string,
    public readonly claimedId: string,
    public readonly computedId: string,
  ) {
    super(
      `${recordKind}.id mismatch: producer claimed ${claimedId}, body hashes to ${computedId}. ` +
        `Use the @cre/contracts compute*Id factory to construct ids.`,
    );
  }
}

interface RecordRow {
  readonly id: string;
  readonly payload: string;
}

export class RecordGraphStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_results (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        extraction_engine_version TEXT NOT NULL,
        deal_ref TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS asset_profiles (
        id TEXT PRIMARY KEY,
        property_type TEXT NOT NULL,
        business_plan TEXT NOT NULL,
        market_liquidity TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS library_snapshots (
        id TEXT PRIMARY KEY,
        as_of TEXT NOT NULL,
        approved_deals_table_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS narrative_facts (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS adjusted_inputs (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        judgment_engine_version TEXT NOT NULL,
        library_snapshot_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (library_snapshot_id) REFERENCES library_snapshots(id)
      );

      CREATE TABLE IF NOT EXISTS cross_check_results (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        adjusted_inputs_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (adjusted_inputs_id) REFERENCES adjusted_inputs(id)
      );

      CREATE TABLE IF NOT EXISTS stress_outputs (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        adjusted_inputs_id TEXT NOT NULL,
        stress_engine_version TEXT NOT NULL,
        method TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (adjusted_inputs_id) REFERENCES adjusted_inputs(id)
      );

      CREATE TABLE IF NOT EXISTS valuation_conclusions (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        valuation_engine_version TEXT NOT NULL,
        adjusted_inputs_id TEXT NOT NULL,
        stress_outputs_id TEXT NOT NULL,
        narrative_facts_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (adjusted_inputs_id)  REFERENCES adjusted_inputs(id),
        FOREIGN KEY (stress_outputs_id)   REFERENCES stress_outputs(id),
        FOREIGN KEY (narrative_facts_id)  REFERENCES narrative_facts(id)
      );

      CREATE TABLE IF NOT EXISTS doctrine_evaluations (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        doctrine_version TEXT NOT NULL,
        judgment_engine_version TEXT NOT NULL,
        stress_engine_version TEXT NOT NULL,
        valuation_engine_version TEXT NOT NULL,
        adjusted_inputs_id TEXT NOT NULL,
        library_snapshot_id TEXT NOT NULL,
        narrative_facts_id TEXT NOT NULL,
        cross_check_result_id TEXT NOT NULL,
        stress_outputs_id TEXT NOT NULL,
        valuation_conclusion_id TEXT NOT NULL,
        asset_profile_id TEXT NOT NULL,
        extraction_result_id TEXT NOT NULL,
        final_score REAL NOT NULL,
        rating_band TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (adjusted_inputs_id)       REFERENCES adjusted_inputs(id),
        FOREIGN KEY (library_snapshot_id)      REFERENCES library_snapshots(id),
        FOREIGN KEY (narrative_facts_id)       REFERENCES narrative_facts(id),
        FOREIGN KEY (cross_check_result_id)    REFERENCES cross_check_results(id),
        FOREIGN KEY (stress_outputs_id)        REFERENCES stress_outputs(id),
        FOREIGN KEY (valuation_conclusion_id)  REFERENCES valuation_conclusions(id),
        FOREIGN KEY (asset_profile_id)         REFERENCES asset_profiles(id),
        FOREIGN KEY (extraction_result_id)     REFERENCES extraction_results(id)
      );

      -- Read-pole memoization cache (post-6.8). Lazy materialization: populated on first
      -- read, served from cache on subsequent reads. Append-only / content-addressed so
      -- the cache is monotonic and never invalidated; a render-version bump produces new
      -- entries while old ones remain (orphans for older versions can be GC'd later).
      CREATE TABLE IF NOT EXISTS rendered_analyses (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        render_version TEXT NOT NULL,
        analysis_as_of_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (root_id) REFERENCES doctrine_evaluations(id)
      );

      -- Leaf record. Carried sibling-style by buildExtractionResult (not owned
      -- by any spine record); the composer-output propertyMetadata field
      -- writes through here. No FKs. The 20 nullable descriptive fields stay
      -- inside payload (JSON); only the source column is extracted, matching
      -- the asset_profiles precedent of extracting classifier fields.
      CREATE TABLE IF NOT EXISTS property_metadata (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_adjusted_inputs_lib       ON adjusted_inputs(library_snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_cross_check_ai            ON cross_check_results(adjusted_inputs_id);
      CREATE INDEX IF NOT EXISTS idx_stress_outputs_ai         ON stress_outputs(adjusted_inputs_id);
      CREATE INDEX IF NOT EXISTS idx_valuation_ai              ON valuation_conclusions(adjusted_inputs_id);
      CREATE INDEX IF NOT EXISTS idx_valuation_stress          ON valuation_conclusions(stress_outputs_id);
      CREATE INDEX IF NOT EXISTS idx_doctrine_ai               ON doctrine_evaluations(adjusted_inputs_id);
      CREATE INDEX IF NOT EXISTS idx_doctrine_valuation        ON doctrine_evaluations(valuation_conclusion_id);
      CREATE INDEX IF NOT EXISTS idx_doctrine_doctrine_version ON doctrine_evaluations(doctrine_version);
      CREATE INDEX IF NOT EXISTS idx_doctrine_asset_profile    ON doctrine_evaluations(asset_profile_id);
      CREATE INDEX IF NOT EXISTS idx_doctrine_extraction       ON doctrine_evaluations(extraction_result_id);
      CREATE INDEX IF NOT EXISTS idx_rendered_root_version     ON rendered_analyses(root_id, render_version);
    `);
  }

  /* ---------------------------------- helpers ---------------------------------- */

  private verifyAndSerialize<T extends { readonly id: string }>(
    record: T,
    recordKind: string,
  ): { id: string; payload: string; body: Omit<T, 'id'> } {
    const { id, ...body } = record;
    const { id: computedId, payload } = serializeRecordBody(body);
    if (id !== computedId) {
      throw new RecordIdMismatchError(recordKind, id, computedId);
    }
    return { id, payload, body: body as Omit<T, 'id'> };
  }

  private parseRow<T>(row: RecordRow): T {
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as T;
  }

  /* ----------------------------- extraction_results ---------------------------- */

  insertExtractionResult(record: ExtractionResult): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'ExtractionResult');
    const result = this.db
      .prepare(
        `INSERT INTO extraction_results
         (id, analysis_as_of_date, extraction_engine_version, deal_ref, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.extractionEngineVersion,
        body.dealRef,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getExtractionResult(id: ExtractionResultId): ExtractionResult | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM extraction_results WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<ExtractionResult>(row) : null;
  }

  /* ------------------------------- asset_profiles ------------------------------ */

  insertAssetProfile(record: AssetProfile): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'AssetProfile');
    const result = this.db
      .prepare(
        `INSERT INTO asset_profiles
         (id, property_type, business_plan, market_liquidity, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.propertyType,
        body.businessPlan,
        body.marketLiquidity,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getAssetProfile(id: AssetProfileId): AssetProfile | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM asset_profiles WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<AssetProfile>(row) : null;
  }

  /* ----------------------------- library_snapshots ----------------------------- */

  insertLibrarySnapshot(record: LibrarySnapshot): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'LibrarySnapshot');
    const result = this.db
      .prepare(
        `INSERT INTO library_snapshots (id, as_of, approved_deals_table_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, body.asOf, body.approvedDealsTableHash, payload, new Date().toISOString());
    return { inserted: result.changes > 0 };
  }

  getLibrarySnapshot(id: LibrarySnapshotId): LibrarySnapshot | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM library_snapshots WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<LibrarySnapshot>(row) : null;
  }

  /* ------------------------------ narrative_facts ------------------------------ */

  insertNarrativeFacts(record: NarrativeFacts): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'NarrativeFacts');
    const result = this.db
      .prepare(
        `INSERT INTO narrative_facts (id, analysis_as_of_date, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, body.analysisAsOfDate, payload, new Date().toISOString());
    return { inserted: result.changes > 0 };
  }

  getNarrativeFacts(id: NarrativeFactsId): NarrativeFacts | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM narrative_facts WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<NarrativeFacts>(row) : null;
  }

  /* ------------------------------ adjusted_inputs ------------------------------ */

  insertAdjustedInputs(record: AdjustedInputs): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'AdjustedInputs');
    const result = this.db
      .prepare(
        `INSERT INTO adjusted_inputs
         (id, analysis_as_of_date, judgment_engine_version, library_snapshot_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.judgmentEngineVersion,
        body.librarySnapshotId,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getAdjustedInputs(id: AdjustedInputsId): AdjustedInputs | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM adjusted_inputs WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<AdjustedInputs>(row) : null;
  }

  /* ---------------------------- cross_check_results ---------------------------- */

  insertCrossCheckResult(record: CrossCheckResult): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'CrossCheckResult');
    const result = this.db
      .prepare(
        `INSERT INTO cross_check_results
         (id, analysis_as_of_date, adjusted_inputs_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, body.analysisAsOfDate, body.adjustedInputsId, payload, new Date().toISOString());
    return { inserted: result.changes > 0 };
  }

  getCrossCheckResult(id: CrossCheckResultId): CrossCheckResult | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM cross_check_results WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<CrossCheckResult>(row) : null;
  }

  /* ------------------------------- stress_outputs ------------------------------ */

  insertStressOutputs(record: StressOutputs): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'StressOutputs');
    const result = this.db
      .prepare(
        `INSERT INTO stress_outputs
         (id, analysis_as_of_date, adjusted_inputs_id, stress_engine_version, method, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.adjustedInputsId,
        body.stressEngineVersion,
        body.method,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getStressOutputs(id: StressOutputsId): StressOutputs | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM stress_outputs WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<StressOutputs>(row) : null;
  }

  /* --------------------------- valuation_conclusions --------------------------- */

  insertValuationConclusion(record: ValuationConclusion): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'ValuationConclusion');
    const result = this.db
      .prepare(
        `INSERT INTO valuation_conclusions
         (id, analysis_as_of_date, valuation_engine_version, adjusted_inputs_id, stress_outputs_id, narrative_facts_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.valuationEngineVersion,
        body.adjustedInputsId,
        body.stressOutputsId,
        body.narrativeFactsId,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getValuationConclusion(id: ValuationConclusionId): ValuationConclusion | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM valuation_conclusions WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<ValuationConclusion>(row) : null;
  }

  /* --------------------------- doctrine_evaluations ---------------------------- */

  insertDoctrineEvaluation(record: DoctrineEvaluation): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'DoctrineEvaluation');
    const result = this.db
      .prepare(
        `INSERT INTO doctrine_evaluations
         (id, analysis_as_of_date, doctrine_version, judgment_engine_version, stress_engine_version,
          valuation_engine_version, adjusted_inputs_id, library_snapshot_id, narrative_facts_id,
          cross_check_result_id, stress_outputs_id, valuation_conclusion_id,
          asset_profile_id, extraction_result_id,
          final_score, rating_band, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.doctrineVersion,
        body.judgmentEngineVersion,
        body.stressEngineVersion,
        body.valuationEngineVersion,
        body.adjustedInputsId,
        body.librarySnapshotId,
        body.narrativeFactsId,
        body.crossCheckResultId,
        body.stressOutputsId,
        body.valuationConclusionId,
        body.assetProfileId,
        body.extractionResultId,
        body.finalScore,
        body.ratingBand,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getDoctrineEvaluation(id: DoctrineEvaluationId): DoctrineEvaluation | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM doctrine_evaluations WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<DoctrineEvaluation>(row) : null;
  }

  /* ----------------------------- rendered_analyses ----------------------------- */

  insertRenderedAnalysis(record: RenderedAnalysis): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'RenderedAnalysis');
    const result = this.db
      .prepare(
        `INSERT INTO rendered_analyses
         (id, root_id, render_version, analysis_as_of_date, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.rootId,
        body.metadata.renderVersion,
        body.metadata.hashedAt,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getRenderedAnalysis(id: RenderedAnalysisId): RenderedAnalysis | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM rendered_analyses WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<RenderedAnalysis>(row) : null;
  }

  // Cache lookup keyed by (root_id, render_version). Returns the rendered analysis for
  // the given root at the given render version, or null if not yet materialized.
  getRenderedAnalysisByRoot(
    rootId: DoctrineEvaluationId,
    renderVersion: RenderVersion,
  ): RenderedAnalysis | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM rendered_analyses
         WHERE root_id = ? AND render_version = ?
         LIMIT 1`,
      )
      .get(rootId, renderVersion) as RecordRow | undefined;
    return row ? this.parseRow<RenderedAnalysis>(row) : null;
  }

  /* ------------------------------ property_metadata ----------------------------- */

  insertPropertyMetadata(record: PropertyMetadata): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'PropertyMetadata');
    const result = this.db
      .prepare(
        `INSERT INTO property_metadata (id, source, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, body.source, payload, new Date().toISOString());
    return { inserted: result.changes > 0 };
  }

  getPropertyMetadata(id: PropertyMetadataId): PropertyMetadata | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM property_metadata WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<PropertyMetadata>(row) : null;
  }

  /* --------------------------------- shutdown --------------------------------- */

  close(): void {
    this.db.close();
  }
}

export const recordGraphStore = new RecordGraphStore();
