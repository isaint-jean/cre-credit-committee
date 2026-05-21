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
  ContentHash,
  CreditManifesto,
  CreditManifestoId,
  CrossCheckResult,
  CrossCheckResultId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ExtractionResultId,
  LibrarySnapshot,
  LibrarySnapshotId,
  MarketBenchmarks,
  MarketBenchmarksId,
  NarrativeFacts,
  NarrativeFactsId,
  PropertyMetadata,
  PropertyMetadataId,
  RenderedAnalysis,
  RenderedAnalysisId,
  RenderVersion,
  RevisionId,
  RevisionLineageEnvelope,
  RevisionProvenance,
  StressOutputs,
  StressOutputsId,
  ValuationConclusion,
  ValuationConclusionId,
} from '@cre/contracts';
import { computeRevisionId, serializeRecordBody } from '../util/content-hash.js';

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

      -- MarketBenchmarks registry. Point-value market context (current rates,
      -- prevailing norms). Pinned upstream input to the judgment engine; can be
      -- passed inline at ingest time OR referenced by id from this table.
      CREATE TABLE IF NOT EXISTS market_benchmarks (
        id TEXT PRIMARY KEY,
        as_of_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- CreditManifesto registry. Named manifesto_registry (NOT
      -- credit_manifestos) to avoid coexisting in the same physical sqlite
      -- file as the legacy credit_manifesto (singular) table owned by
      -- sqlite-store.ts -- that legacy table is a different model (PDF-upload-
      -- and-AI-extract) and remains untouched by this registry. Once the
      -- legacy /api/manifesto/* routes retire, this table can be renamed.
      CREATE TABLE IF NOT EXISTS manifesto_registry (
        id TEXT PRIMARY KEY,
        analysis_as_of_date TEXT NOT NULL,
        manifesto_contract_version TEXT NOT NULL,
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

      -- Tier B of issue #10 / ADR §6: re-upload short-circuit cache.
      -- Maps a composite content-derived key (slot hashes + extractor versions)
      -- to the ExtractionResult.id produced from those exact bytes under those
      -- exact versions. On re-upload with identical bytes + versions, the
      -- route hits this table, skips the composer, and reuses the cached
      -- ExtractionResult -- O(1) re-upload, no re-extraction (no AI calls).
      --
      -- FK to extraction_results.id but NO ON DELETE CASCADE: if a record is
      -- manually deleted, the cache entry becomes orphan; the route's
      -- cache-hit-with-missing-record edge case (ADR §6) falls through to
      -- re-extract. Keeps the cache append-only.
      --
      -- cf_hash / rent_roll_hash / asr_hash are nullable per-slot hashes,
      -- stored for audit / debugging visibility. The cache_key column is
      -- what the lookup is keyed on; per-slot columns are not in the unique
      -- constraint.
      CREATE TABLE IF NOT EXISTS extraction_input_cache (
        cache_key TEXT PRIMARY KEY,
        extraction_result_id TEXT NOT NULL,
        -- Nullable: PropertyMetadata is sibling-style and best-effort; the
        -- first composer run may have produced null PM. On cache hit, the
        -- route re-fetches by this id (NO FK because property_metadata can
        -- be deleted independently; the route's defensive null check handles
        -- the missing-PM case).
        property_metadata_id TEXT,
        cf_hash TEXT,
        rent_roll_hash TEXT,
        asr_hash TEXT,
        extractor_versions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (extraction_result_id) REFERENCES extraction_results(id)
      );

      CREATE INDEX IF NOT EXISTS idx_extraction_input_cache_result ON extraction_input_cache(extraction_result_id);

      -- Option C / spec §4 — revision lineage. Two sibling tables:
      --   - envelopes: content-addressed (id = SHA-256 of RevisionIdHashInput,
      --     i.e. {parentRevisionId, adjustedInputsId, doctrineVersion}).
      --     Append-only (L1). parent_revision_id NULL only for the root (L1 + §6).
      --     Engine versions stamped for replay completeness but NOT in hash (§5).
      --   - provenance: keyed by revision_id (FK), observability-only. NEVER
      --     participates in identity hash (§4 hard rule).
      CREATE TABLE IF NOT EXISTS revision_lineage_envelopes (
        revision_id              TEXT PRIMARY KEY,
        lineage_root_id          TEXT NOT NULL,
        parent_revision_id       TEXT,
        revision_ordinal         INTEGER NOT NULL,
        doctrine_evaluation_id   TEXT NOT NULL,
        adjusted_inputs_id       TEXT NOT NULL,
        doctrine_version         TEXT NOT NULL,
        judgment_engine_version  TEXT NOT NULL,
        stress_engine_version    TEXT NOT NULL,
        valuation_engine_version TEXT NOT NULL,
        created_at               TEXT NOT NULL,
        FOREIGN KEY (parent_revision_id)     REFERENCES revision_lineage_envelopes(revision_id),
        FOREIGN KEY (doctrine_evaluation_id) REFERENCES doctrine_evaluations(id),
        FOREIGN KEY (adjusted_inputs_id)     REFERENCES adjusted_inputs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_envelope_lineage_ordinal
        ON revision_lineage_envelopes(lineage_root_id, revision_ordinal DESC);
      CREATE INDEX IF NOT EXISTS idx_envelope_parent
        ON revision_lineage_envelopes(parent_revision_id);

      CREATE TABLE IF NOT EXISTS revision_provenance (
        revision_id        TEXT PRIMARY KEY,
        input_diff         TEXT NOT NULL,
        trigger_source     TEXT NOT NULL,
        applied_rule_ids   TEXT NOT NULL,
        adjustment_origin  TEXT NOT NULL,
        before_hash        TEXT NOT NULL,
        after_hash         TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        FOREIGN KEY (revision_id) REFERENCES revision_lineage_envelopes(revision_id)
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

  /** Most-recent-first by created_at. No pagination — registry volume is low. */
  listLibrarySnapshots(): LibrarySnapshot[] {
    const rows = this.db
      .prepare(`SELECT id, payload FROM library_snapshots ORDER BY created_at DESC, id DESC`)
      .all() as RecordRow[];
    return rows.map((r) => this.parseRow<LibrarySnapshot>(r));
  }

  /* ----------------------------- market_benchmarks ----------------------------- */

  insertMarketBenchmarks(record: MarketBenchmarks): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'MarketBenchmarks');
    const result = this.db
      .prepare(
        `INSERT INTO market_benchmarks (id, as_of_date, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, body.asOfDate, payload, new Date().toISOString());
    return { inserted: result.changes > 0 };
  }

  getMarketBenchmarks(id: MarketBenchmarksId): MarketBenchmarks | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM market_benchmarks WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<MarketBenchmarks>(row) : null;
  }

  listMarketBenchmarks(): MarketBenchmarks[] {
    const rows = this.db
      .prepare(`SELECT id, payload FROM market_benchmarks ORDER BY created_at DESC, id DESC`)
      .all() as RecordRow[];
    return rows.map((r) => this.parseRow<MarketBenchmarks>(r));
  }

  /* ---------------------------- manifesto_registry ----------------------------- */

  insertCreditManifesto(record: CreditManifesto): { inserted: boolean } {
    const { id, payload, body } = this.verifyAndSerialize(record, 'CreditManifesto');
    const result = this.db
      .prepare(
        `INSERT INTO manifesto_registry
         (id, analysis_as_of_date, manifesto_contract_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        body.analysisAsOfDate,
        body.manifestoContractVersion,
        payload,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getCreditManifesto(id: CreditManifestoId): CreditManifesto | null {
    const row = this.db
      .prepare(`SELECT id, payload FROM manifesto_registry WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ? this.parseRow<CreditManifesto>(row) : null;
  }

  listCreditManifestos(): CreditManifesto[] {
    const rows = this.db
      .prepare(`SELECT id, payload FROM manifesto_registry ORDER BY created_at DESC, id DESC`)
      .all() as RecordRow[];
    return rows.map((r) => this.parseRow<CreditManifesto>(r));
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

  /* -------------------------- extraction_input_cache --------------------------- */

  /** Cache entry: composite slot-hash + extractor-version key → resulting
   *  ExtractionResult.id (+ optional PropertyMetadataId). Inserted after a
   *  successful composer run; consulted before the next compose to
   *  short-circuit re-uploads. */
  insertExtractionInputCache(args: {
    readonly cacheKey: ContentHash;
    readonly extractionResultId: ExtractionResultId;
    readonly propertyMetadataId: PropertyMetadataId | null;
    readonly cfHash: ContentHash | null;
    readonly rentRollHash: ContentHash | null;
    readonly asrHash: ContentHash | null;
    readonly extractorVersions: Record<string, string>;
  }): { inserted: boolean } {
    const result = this.db
      .prepare(
        `INSERT INTO extraction_input_cache
         (cache_key, extraction_result_id, property_metadata_id, cf_hash, rent_roll_hash, asr_hash, extractor_versions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO NOTHING`,
      )
      .run(
        args.cacheKey,
        args.extractionResultId,
        args.propertyMetadataId,
        args.cfHash,
        args.rentRollHash,
        args.asrHash,
        JSON.stringify(args.extractorVersions),
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  /** Lookup by composite cache key. Returns the cached id pair (or null).
   *  Caller must then fetch the records (and verify they still exist — if
   *  deleted, the cache entry is orphan and the route falls through to
   *  re-extract). */
  getExtractionInputCacheByKey(cacheKey: ContentHash): {
    extractionResultId: ExtractionResultId;
    propertyMetadataId: PropertyMetadataId | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT extraction_result_id, property_metadata_id
         FROM extraction_input_cache WHERE cache_key = ?`,
      )
      .get(cacheKey) as
      | { extraction_result_id: string; property_metadata_id: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      extractionResultId: row.extraction_result_id as ExtractionResultId,
      propertyMetadataId: (row.property_metadata_id ?? null) as PropertyMetadataId | null,
    };
  }

  /* ------------------------- revision_lineage_envelopes ------------------------ */

  /**
   * Insert a revision envelope. Verifies envelope.revisionId === computeRevisionId of the
   * §5 hash-input subset (parentRevisionId, adjustedInputsId, doctrineVersion). Other
   * envelope fields (lineageRootId, ordinal, engine versions, FK ids) are stamped, not hashed.
   * Append-only (L1) — ON CONFLICT(revision_id) DO NOTHING gives idempotent re-insert.
   */
  insertRevisionLineageEnvelope(envelope: RevisionLineageEnvelope): { inserted: boolean } {
    const computedId = computeRevisionId({
      parentRevisionId: envelope.parentRevisionId,
      adjustedInputsId: envelope.adjustedInputsId,
      doctrineVersion: envelope.doctrineVersion,
    });
    if (envelope.revisionId !== computedId) {
      throw new RecordIdMismatchError(
        'RevisionLineageEnvelope',
        envelope.revisionId,
        computedId,
      );
    }
    const result = this.db
      .prepare(
        `INSERT INTO revision_lineage_envelopes
         (revision_id, lineage_root_id, parent_revision_id, revision_ordinal,
          doctrine_evaluation_id, adjusted_inputs_id,
          doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version,
          created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision_id) DO NOTHING`,
      )
      .run(
        envelope.revisionId,
        envelope.lineageRootId,
        envelope.parentRevisionId,
        envelope.revisionOrdinal,
        envelope.doctrineEvaluationId,
        envelope.adjustedInputsId,
        envelope.doctrineVersion,
        envelope.judgmentEngineVersion,
        envelope.stressEngineVersion,
        envelope.valuationEngineVersion,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getRevisionEnvelope(revisionId: RevisionId): RevisionLineageEnvelope | null {
    const row = this.db
      .prepare(
        `SELECT revision_id, lineage_root_id, parent_revision_id, revision_ordinal,
                doctrine_evaluation_id, adjusted_inputs_id,
                doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version
         FROM revision_lineage_envelopes WHERE revision_id = ?`,
      )
      .get(revisionId) as RevisionEnvelopeRow | undefined;
    return row ? parseEnvelopeRow(row) : null;
  }

  /** Highest-ordinal envelope in the given lineage (latest revision). NULL if no envelopes. */
  getLatestRevisionByLineageRoot(lineageRootId: RevisionId): RevisionLineageEnvelope | null {
    const row = this.db
      .prepare(
        `SELECT revision_id, lineage_root_id, parent_revision_id, revision_ordinal,
                doctrine_evaluation_id, adjusted_inputs_id,
                doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version
         FROM revision_lineage_envelopes
         WHERE lineage_root_id = ?
         ORDER BY revision_ordinal DESC
         LIMIT 1`,
      )
      .get(lineageRootId) as RevisionEnvelopeRow | undefined;
    return row ? parseEnvelopeRow(row) : null;
  }

  /** Full chain for a lineage, ordered by ordinal ASC (root → leaf). */
  walkLineageChain(lineageRootId: RevisionId): RevisionLineageEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT revision_id, lineage_root_id, parent_revision_id, revision_ordinal,
                doctrine_evaluation_id, adjusted_inputs_id,
                doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version
         FROM revision_lineage_envelopes
         WHERE lineage_root_id = ?
         ORDER BY revision_ordinal ASC`,
      )
      .all(lineageRootId) as RevisionEnvelopeRow[];
    return rows.map(parseEnvelopeRow);
  }

  /* ------------------------------ revision_provenance --------------------------- */

  /**
   * Insert provenance. FK to revision_lineage_envelopes is enforced by sqlite; insert
   * fails if the envelope is missing. NOT content-hashed — provenance is observable
   * only (§4) and keyed by revision_id alone.
   */
  insertRevisionProvenance(provenance: RevisionProvenance): { inserted: boolean } {
    const result = this.db
      .prepare(
        `INSERT INTO revision_provenance
         (revision_id, input_diff, trigger_source, applied_rule_ids, adjustment_origin,
          before_hash, after_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision_id) DO NOTHING`,
      )
      .run(
        provenance.revisionId,
        JSON.stringify(provenance.inputDiff),
        provenance.triggerSource,
        JSON.stringify(provenance.appliedRuleIds),
        JSON.stringify(provenance.adjustmentOrigin),
        provenance.beforeHash,
        provenance.afterHash,
        new Date().toISOString(),
      );
    return { inserted: result.changes > 0 };
  }

  getRevisionProvenance(revisionId: RevisionId): RevisionProvenance | null {
    const row = this.db
      .prepare(
        `SELECT revision_id, input_diff, trigger_source, applied_rule_ids, adjustment_origin,
                before_hash, after_hash
         FROM revision_provenance WHERE revision_id = ?`,
      )
      .get(revisionId) as RevisionProvenanceRow | undefined;
    return row ? parseProvenanceRow(row) : null;
  }

  /* --------------------------------- shutdown --------------------------------- */

  close(): void {
    this.db.close();
  }
}

/* ----------------- revision lineage row → record helpers ---------------------- */

interface RevisionEnvelopeRow {
  readonly revision_id: string;
  readonly lineage_root_id: string;
  readonly parent_revision_id: string | null;
  readonly revision_ordinal: number;
  readonly doctrine_evaluation_id: string;
  readonly adjusted_inputs_id: string;
  readonly doctrine_version: string;
  readonly judgment_engine_version: string;
  readonly stress_engine_version: string;
  readonly valuation_engine_version: string;
}

function parseEnvelopeRow(row: RevisionEnvelopeRow): RevisionLineageEnvelope {
  return {
    revisionId: row.revision_id as RevisionLineageEnvelope['revisionId'],
    lineageRootId: row.lineage_root_id as RevisionLineageEnvelope['lineageRootId'],
    parentRevisionId: row.parent_revision_id as RevisionLineageEnvelope['parentRevisionId'],
    revisionOrdinal: row.revision_ordinal,
    doctrineEvaluationId: row.doctrine_evaluation_id as RevisionLineageEnvelope['doctrineEvaluationId'],
    adjustedInputsId: row.adjusted_inputs_id as RevisionLineageEnvelope['adjustedInputsId'],
    doctrineVersion: row.doctrine_version as RevisionLineageEnvelope['doctrineVersion'],
    judgmentEngineVersion: row.judgment_engine_version as RevisionLineageEnvelope['judgmentEngineVersion'],
    stressEngineVersion: row.stress_engine_version as RevisionLineageEnvelope['stressEngineVersion'],
    valuationEngineVersion: row.valuation_engine_version as RevisionLineageEnvelope['valuationEngineVersion'],
  };
}

interface RevisionProvenanceRow {
  readonly revision_id: string;
  readonly input_diff: string;
  readonly trigger_source: string;
  readonly applied_rule_ids: string;
  readonly adjustment_origin: string;
  readonly before_hash: string;
  readonly after_hash: string;
}

function parseProvenanceRow(row: RevisionProvenanceRow): RevisionProvenance {
  return {
    revisionId: row.revision_id as RevisionProvenance['revisionId'],
    inputDiff: JSON.parse(row.input_diff) as RevisionProvenance['inputDiff'],
    triggerSource: row.trigger_source as RevisionProvenance['triggerSource'],
    appliedRuleIds: JSON.parse(row.applied_rule_ids) as RevisionProvenance['appliedRuleIds'],
    adjustmentOrigin: JSON.parse(row.adjustment_origin) as RevisionProvenance['adjustmentOrigin'],
    beforeHash: row.before_hash as RevisionProvenance['beforeHash'],
    afterHash: row.after_hash as RevisionProvenance['afterHash'],
  };
}

export const recordGraphStore = new RecordGraphStore();
