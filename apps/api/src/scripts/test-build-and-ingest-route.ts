/**
 * Tests for the POST /api/build-and-ingest route handler.
 *
 *   tsx src/scripts/test-build-and-ingest-route.ts
 *
 * Pattern: mock req/res POJOs (same as test-workflow-api.ts), but instead of
 * walking the Router stack we invoke makeBuildAndIngestHandler(mockDeps)
 * directly. This skips multer + requireAuth in the test path; both are
 * exercised by integration tests at deployment time.
 *
 * Mocking: BuildAndIngestDeps is the seam. Tests stub buildExtractionResult
 * and ingestExtractionResult to control composer + ingest outcomes. The
 * recordGraphStore mock only needs the methods the handler calls
 * (insertPropertyMetadata).
 *
 * NOTE on the `?? null` defensive expressions: same as the other adapter
 * tests — codebase's "no ?? / no || numeric defaulting" discipline applies
 * to PRODUCTION code, not test assertions.
 */

import type {
  ASRExtraction,
  AssetType,
  ContentHash,
  CrossCheckResult,
  CrossCheckResultId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ExtractionResultId,
  ISODateTime,
  LibrarySnapshotId,
  MarketBenchmarks,
  CreditManifesto,
  PropertyMetadata,
  PropertyMetadataId,
  RevisionId,
} from '@cre/contracts';
import type { BuildReport } from '../services/extraction/build-report.js';
import type { BuildExtractionResultOutput } from '../services/extraction/build-extraction-result.js';
import {
  IngestionError,
  type IngestionResult,
} from '../services/ingest-extraction-result.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { MemoryBlobStore, BlobStoreError, type BlobStore } from '../storage/blob-store.js';
import { computeExtractionResultId, computePropertyMetadataId } from '../util/content-hash.js';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';
import {
  makeBuildAndIngestHandler,
  type BuildAndIngestDeps,
} from '../routes/build-and-ingest.routes.js';

type MulterFilesMap = { [fieldname: string]: Array<{ buffer: Buffer; originalname: string }> };

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ----------------------------- mock req/res ------------------------------ */

interface MockReq {
  body?: unknown;
  files?: { [field: string]: Array<{ buffer: Buffer; originalname: string }> };
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

/* ------------------------- synthetic value builders ----------------------- */

const CONTRACT_HASH = 'a'.repeat(64) as ContentHash;
const EXT_ID = ('e'.repeat(64)) as ExtractionResultId;
// ROOT_ID = the public AnalysisId (RevisionId). EVAL_ID = the internal DoctrineEvaluationId.
// Post-#20 they are categorically distinct ids (both 64-hex; different roles).
const ROOT_ID = ('d'.repeat(64)) as RevisionId;
const EVAL_ID = ('7'.repeat(64)) as DoctrineEvaluationId;
const PM_ID = ('p'.repeat(64)) as PropertyMetadataId;
const LIB_ID = ('1'.repeat(64)) as LibrarySnapshotId;

function makeExtractionResult(): ExtractionResult {
  return {
    id: EXT_ID,
    analysisAsOfDate: '2026-05-20T00:00:00Z' as ISODateTime,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'TEST',
    rentRoll: null,
    t12: null,
    pca: null,
    appraisal: null,
    sellerUw: null,
    sellerUwOperatingStatement: null,
    asr: null,
    loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
  };
}

function makePropertyMetadata(): PropertyMetadata {
  return {
    id: PM_ID,
    source: 'asr_extraction',
    propertyName: 'Test', propertySubtype: null,
    address: null, city: null, state: null, zip: null, county: null, msa: null, submarket: null,
    yearBuilt: null, yearRenovated: null, buildingClass: null,
    totalSquareFeet: null, totalUnits: null, totalRooms: null, totalPads: null,
    occupancyPhysical: null, occupancyEconomic: null,
    ownershipInterest: null, numberOfBuildings: null,
  };
}

function makeBuildReport(): BuildReport {
  return {
    startedAt: '2026-05-20T00:00:00Z' as ISODateTime,
    finishedAt: '2026-05-20T00:00:01Z' as ISODateTime,
    engineVersion: '1.1.0' as never,
    slots: {
      sellerCfXlsx: { status: 'absent' },
      rentRollXlsx: { status: 'absent' },
      asrPdf: { status: 'absent' },
      pcaPdf: { status: 'absent' },
    },
  };
}

function makeIngestionResult(): IngestionResult {
  const crossCheck: CrossCheckResult = {
    id: ('c'.repeat(64)) as CrossCheckResultId,
    analysisAsOfDate: '2026-05-20T00:00:00Z' as ISODateTime,
    adjustedInputsId: ('b'.repeat(64)) as never,
    findings: [],
    overallAdjustmentBias: 'neutral',
  };
  void crossCheck;
  const evaluation = { id: EVAL_ID } as DoctrineEvaluation;
  return { rootId: ROOT_ID, evaluationId: EVAL_ID, evaluation };
}

/* ----------------------------- form body helper -------------------------- */

const VALID_BENCHMARKS = JSON.stringify({ id: 'b'.repeat(64), asOf: '2026-05-20T00:00:00Z' });
const VALID_MANIFESTO = JSON.stringify({ id: 'm'.repeat(64), version: '1.0' });

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisAsOfDate: '2026-05-20T00:00:00Z',
    dealRef: 'TEST-DEAL',
    propertyType: 'Office' as AssetType,
    librarySnapshotId: LIB_ID,
    marketBenchmarks: VALID_BENCHMARKS,
    creditManifesto: VALID_MANIFESTO,
    ...overrides,
  };
}

/* ------------------------------ deps builder ----------------------------- */

interface DepsOverrides {
  composerReturn?: BuildExtractionResultOutput;
  composerThrow?: Error;
  ingestReturn?: IngestionResult;
  ingestThrow?: Error;
  pmInsertThrow?: Error;
  /** For Tier B short-circuit tests: override the entire RecordGraphStore.
   *  Lets a test simulate cache hits / orphan-cache entries. */
  storeOverride?: RecordGraphStore;
  /** For Tier B putBlob-failure tests: substitute a misbehaving BlobStore. */
  blobStoreOverride?: BlobStore;
}

function makeDeps(o: DepsOverrides = {}): BuildAndIngestDeps {
  const insertPropertyMetadataSpy = {
    callCount: 0,
    lastArg: null as PropertyMetadata | null,
  };
  const storeMock = {
    insertPropertyMetadata: (record: PropertyMetadata) => {
      insertPropertyMetadataSpy.callCount += 1;
      insertPropertyMetadataSpy.lastArg = record;
      if (o.pmInsertThrow !== undefined) throw o.pmInsertThrow;
      return { inserted: true };
    },
    /* Tier B short-circuit hooks. Default mocks: empty cache (miss),
     * no-op cache write. Tests that need to exercise hit/orphan paths
     * provide their own RecordGraphStore via DepsOverrides.storeOverride. */
    getExtractionInputCacheByKey: (_key: string) => null,
    getExtractionResult: (_id: string) => null,
    getPropertyMetadata: (_id: string) => null,
    insertExtractionInputCache: () => ({ inserted: true }),
    // Cast retained per §13.6 acceptance (b): RecordGraphStore is a class
    // (~43 methods) without a narrow interface; this stub covers only the
    // methods the outer route handler directly calls (5 of 43). Cleaning
    // this cast cleanly requires cascade narrowing — ingestExtractionResult
    // receives the same store and itself calls 9 store methods, so a
    // BuildAndIngestStore narrowing forces a downstream
    // IngestExtractionResultStore extraction too. The cascade is
    // architectural-design work (interface boundaries, names, location)
    // outside §13.6's fixture-cleanup framing; deferred to a dedicated
    // architectural ticket if appetite arises. See #49 v14 ship (SPEC §10.16
    // or §13.6 v14 layered note for the cleanup-arc framing).
  } as unknown as RecordGraphStore;

  return {
    buildExtractionResult: async () => {
      if (o.composerThrow !== undefined) throw o.composerThrow;
      const defaultReturn: BuildExtractionResultOutput = {
        extractionResult: makeExtractionResult(),
        propertyMetadata: null,
        report: makeBuildReport(),
      };
      return o.composerReturn !== undefined ? o.composerReturn : defaultReturn;
    },
    ingestExtractionResult: async () => {
      if (o.ingestThrow !== undefined) throw o.ingestThrow;
      return o.ingestReturn !== undefined ? o.ingestReturn : makeIngestionResult();
    },
    recordGraphStore: o.storeOverride ?? storeMock,
    blobStore: o.blobStoreOverride ?? new MemoryBlobStore(),
    extractorVersions: {
      cf: '0.1.0',
      rentRoll: '0.1.0',
      asr: '0.2.0',
      engine: EXTRACTION_ENGINE_VERSION,
    },
  };
}

/* -------------------------------- run ----------------------------------- */

(async () => {
  /* CASE 1 — happy path: all files + valid body, composer + ingest succeed */
  console.log('1. happy path: all files + valid form + composer + ingest succeed');
  {
    const handler = makeBuildAndIngestHandler(makeDeps({
      composerReturn: {
        extractionResult: makeExtractionResult(),
        propertyMetadata: makePropertyMetadata(),
        report: {
          ...makeBuildReport(),
          slots: {
            sellerCfXlsx: { status: 'ok', durationMs: 5, adapterVersion: '0.1.0' },
            rentRollXlsx: { status: 'ok', durationMs: 3, adapterVersion: '0.1.0' },
            asrPdf: { status: 'ok', durationMs: 10, adapterVersion: '0.1.0' },
            pcaPdf: { status: 'ok', durationMs: 12, adapterVersion: '1.1' },
          },
        },
      },
    }));
    const req: MockReq = {
      body: validBody(),
      files: {
        asr: [{ buffer: Buffer.from('pdf'), originalname: 'a.pdf' }],
        rent_roll: [{ buffer: Buffer.from('xlsx'), originalname: 'r.xlsx' }],
        seller_cf: [{ buffer: Buffer.from('xlsx'), originalname: 'c.xlsx' }],
      },
    };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '1.1 status 201');
    const body = res.body as { rootId: string; evaluationId: string; extractionResultId: string; propertyMetadataId: string | null };
    assertEqual(body.rootId, ROOT_ID, '1.2 rootId == ingest result (RevisionId)');
    assertEqual(body.evaluationId, EVAL_ID, '1.2b evaluationId == ingest result (DoctrineEvaluationId)');
    assertEqual(body.extractionResultId, EXT_ID, '1.3 extractionResultId == composer output');
    assertEqual(body.propertyMetadataId, PM_ID, '1.4 propertyMetadataId == PM.id');
  }

  /* CASE 2 — no files: empty multipart files map, valid form */
  console.log('\n2. no files uploaded → 201, composer sees empty slots');
  {
    let observedSlots: unknown = null;
    const deps = makeDeps();
    const originalBuilder = deps.buildExtractionResult;
    const patched: BuildAndIngestDeps = {
      ...deps,
      buildExtractionResult: async (args) => {
        observedSlots = args.slots;
        return originalBuilder(args);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const req: MockReq = { body: validBody() };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '2.1 status 201 (no files is contract-valid)');
    assertEqual(Object.keys(observedSlots as object).length, 0, '2.2 composer received empty slots map');
  }

  /* CASE 3 — only ASR uploaded */
  console.log('\n3. only ASR uploaded → composer sees asrPdf only');
  {
    let observedSlots: unknown = null;
    const deps = makeDeps();
    const patched: BuildAndIngestDeps = {
      ...deps,
      buildExtractionResult: async (args) => {
        observedSlots = args.slots;
        return deps.buildExtractionResult(args);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const req: MockReq = {
      body: validBody(),
      files: { asr: [{ buffer: Buffer.from('pdf'), originalname: 'a.pdf' }] },
    };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '3.1 status 201');
    const keys = Object.keys(observedSlots as object).sort();
    assertEqual(keys.join(','), 'asrPdf', '3.2 composer slots = { asrPdf } only');
  }

  /* CASE 4 — missing required form field */
  console.log('\n4. missing librarySnapshotId → 400 with shape-validation error');
  {
    const handler = makeBuildAndIngestHandler(makeDeps());
    const req: MockReq = { body: validBody({ librarySnapshotId: undefined }) };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '4.1 status 400');
    const body = res.body as { error: string; missing: string[] };
    assertEqual(body.error, 'BUILD_AND_INGEST_BAD_REQUEST', '4.2 error code');
    assertEqual(body.missing.length, 1, '4.3 missing list has one entry');
    assertEqual(body.missing[0], 'librarySnapshotId', '4.4 missing field is librarySnapshotId');
  }

  /* CASE 5 — malformed JSON in marketBenchmarks */
  console.log('\n5. malformed JSON in marketBenchmarks → 400 with parse error');
  {
    const handler = makeBuildAndIngestHandler(makeDeps());
    const req: MockReq = { body: validBody({ marketBenchmarks: '{ not valid json' }) };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '5.1 status 400');
    const body = res.body as { error: string; field: string; parseError: string };
    assertEqual(body.error, 'BUILD_AND_INGEST_BAD_REQUEST', '5.2 error code');
    assertEqual(body.field, 'marketBenchmarks', '5.3 field is marketBenchmarks');
    assert(body.parseError.length > 0, '5.4 parseError populated');
  }

  /* CASE 6 — IngestionError (LIBRARY_SNAPSHOT_NOT_FOUND) propagates as 400 */
  console.log('\n6. IngestionError → 400 with code preserved');
  {
    const handler = makeBuildAndIngestHandler(makeDeps({
      ingestThrow: new IngestionError({
        code: 'LIBRARY_SNAPSHOT_NOT_FOUND',
        librarySnapshotId: 'unknown-snapshot',
      }),
    }));
    const req: MockReq = { body: validBody(), files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '6.1 status 400');
    const body = res.body as { error: string; librarySnapshotId?: string };
    assertEqual(body.error, 'LIBRARY_SNAPSHOT_NOT_FOUND', '6.2 error code from IngestionError');
    assertEqual(body.librarySnapshotId ?? null, 'unknown-snapshot', '6.3 context.librarySnapshotId surfaced');
  }

  /* CASE 7 — PM persistence fails AFTER ingest succeeds → 201 with informational error */
  console.log('\n7. PM persistence throws → 201 with propertyMetadataError');
  {
    const handler = makeBuildAndIngestHandler(makeDeps({
      composerReturn: {
        extractionResult: makeExtractionResult(),
        propertyMetadata: makePropertyMetadata(),
        report: makeBuildReport(),
      },
      pmInsertThrow: new Error('disk full'),
    }));
    const req: MockReq = { body: validBody(), files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '7.1 status 201 (spine is committed; PM failure is informational)');
    const body = res.body as {
      propertyMetadataId: string | null;
      propertyMetadataError?: { name: string; message: string };
    };
    assertEqual(body.propertyMetadataId, null, '7.2 propertyMetadataId null on PM persistence failure');
    assert(body.propertyMetadataError !== undefined, '7.3 propertyMetadataError populated');
    assertEqual(body.propertyMetadataError?.message ?? null, 'disk full', '7.4 propertyMetadataError carries original message');
  }

  /* CASE 8 — Idempotency: same inputs twice produce same response ids */
  console.log('\n8. idempotency: same inputs → same ids across two calls');
  {
    const deps = makeDeps({
      composerReturn: {
        extractionResult: makeExtractionResult(),
        propertyMetadata: makePropertyMetadata(),
        report: makeBuildReport(),
      },
    });
    const handler = makeBuildAndIngestHandler(deps);
    const req: MockReq = { body: validBody(), files: {} };
    const r1 = makeRes();
    const r2 = makeRes();
    await handler(req as never, r1 as never);
    await handler(req as never, r2 as never);
    const b1 = r1.body as { extractionResultId: string; rootId: string; propertyMetadataId: string | null };
    const b2 = r2.body as { extractionResultId: string; rootId: string; propertyMetadataId: string | null };
    assertEqual(b1.extractionResultId, b2.extractionResultId, '8.1 extractionResultId stable across calls');
    assertEqual(b1.rootId, b2.rootId, '8.2 rootId stable across calls');
    assertEqual(b1.propertyMetadataId, b2.propertyMetadataId, '8.3 propertyMetadataId stable across calls');
  }

  /* CASE 9 — loanTerms form field parses and threads through to composer
   * (Ticket K #7). The handler parses the JSON-stringified loanTerms field
   * and passes it as args.loanTerms to the composer. */
  console.log('\n9. loanTerms form field threads to composer args (Ticket K #7)');
  {
    let observedLoanTerms: unknown = 'NOT_OBSERVED';
    const deps = makeDeps();
    const patched: BuildAndIngestDeps = {
      ...deps,
      buildExtractionResult: async (args) => {
        observedLoanTerms = (args as { loanTerms?: unknown }).loanTerms;
        return deps.buildExtractionResult(args);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const loanTermsValue = {
      loanAmount: 10_000_000,
      interestRate: 0.065,
      amortization: 360,
      interestOnlyPeriod: 0,
      maturityDate: '2031-05-08T00:00:00Z',
    };
    const req: MockReq = {
      body: validBody({ loanTerms: JSON.stringify(loanTermsValue) }),
      files: {},
    };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '9.1 status 201');
    assert(observedLoanTerms !== 'NOT_OBSERVED', '9.2 composer received the loanTerms arg');
    const observedObj = observedLoanTerms as { loanAmount?: number; interestRate?: number };
    assertEqual(observedObj.loanAmount, 10_000_000, '9.3 loanAmount parsed from JSON and threaded through');
    assertEqual(observedObj.interestRate, 0.065, '9.4 interestRate parsed and threaded through');
  }

  /* CASE 10 — malformed loanTerms JSON → 400 (parallel to case 5 for marketBenchmarks) */
  console.log('\n10. malformed loanTerms JSON → 400 with parse error (Ticket K #7)');
  {
    const handler = makeBuildAndIngestHandler(makeDeps());
    const req: MockReq = {
      body: validBody({ loanTerms: '{ not valid json' }),
      files: {},
    };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '10.1 status 400');
    const body = res.body as { error: string; field: string; parseError: string };
    assertEqual(body.error, 'BUILD_AND_INGEST_BAD_REQUEST', '10.2 error code');
    assertEqual(body.field, 'loanTerms', '10.3 field is loanTerms');
    assert(body.parseError.length > 0, '10.4 parseError populated');
  }

  /* CASE 11 — loanTerms field omitted → composer receives undefined (Ticket K #7) */
  console.log('\n11. loanTerms omitted → composer.args.loanTerms === undefined');
  {
    let observedLoanTerms: unknown = 'NOT_OBSERVED';
    const deps = makeDeps();
    const patched: BuildAndIngestDeps = {
      ...deps,
      buildExtractionResult: async (args) => {
        observedLoanTerms = (args as { loanTerms?: unknown }).loanTerms;
        return deps.buildExtractionResult(args);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const req: MockReq = { body: validBody(), files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '11.1 status 201');
    assertEqual(observedLoanTerms, undefined, '11.2 composer received undefined (legacy default)');
  }

  /* CASE 12 — registry id-mode for marketBenchmarks (Tier-A registry). */
  console.log('\n12. marketBenchmarksId reference accepted; inline marketBenchmarks omitted');
  {
    let observedArgs: { marketBenchmarksId?: string; marketBenchmarks?: unknown } | null = null;
    const deps = makeDeps();
    const patched: BuildAndIngestDeps = {
      ...deps,
      ingestExtractionResult: async (args, store) => {
        observedArgs = args as { marketBenchmarksId?: string; marketBenchmarks?: unknown };
        return deps.ingestExtractionResult(args, store);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const body = validBody();
    delete (body as { marketBenchmarks?: unknown }).marketBenchmarks;
    body.marketBenchmarksId = 'b'.repeat(64);
    const req: MockReq = { body, files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '12.1 status 201');
    const captured12 = observedArgs as { marketBenchmarksId?: string; marketBenchmarks?: unknown } | null;
    assertEqual(captured12?.marketBenchmarksId ?? null, 'b'.repeat(64), '12.2 ingest received marketBenchmarksId');
    assertEqual(captured12?.marketBenchmarks ?? null, null, '12.3 ingest did NOT receive inline marketBenchmarks');
  }

  /* CASE 13 — both inline and id supplied for marketBenchmarks → 400 */
  console.log('\n13. marketBenchmarks AND marketBenchmarksId supplied → 400');
  {
    const handler = makeBuildAndIngestHandler(makeDeps());
    const body = validBody({ marketBenchmarksId: 'b'.repeat(64) });
    const req: MockReq = { body, files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '13.1 status 400');
    const responseBody = res.body as { error: string; message: string };
    assertEqual(responseBody.error, 'BUILD_AND_INGEST_BAD_REQUEST', '13.2 error code');
    assert(responseBody.message.includes('both supplied'), '13.3 message indicates both supplied');
  }

  /* CASE 14 — neither inline nor id supplied for marketBenchmarks → 400 */
  console.log('\n14. neither marketBenchmarks nor marketBenchmarksId supplied → 400');
  {
    const handler = makeBuildAndIngestHandler(makeDeps());
    const body = validBody();
    delete (body as { marketBenchmarks?: unknown }).marketBenchmarks;
    const req: MockReq = { body, files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 400, '14.1 status 400');
    const responseBody = res.body as { error: string; message: string };
    assertEqual(responseBody.error, 'BUILD_AND_INGEST_BAD_REQUEST', '14.2 error code');
    assert(responseBody.message.includes('neither supplied'), '14.3 message indicates neither supplied');
  }

  /* CASE 15 — creditManifestoId reference accepted; inline omitted */
  console.log('\n15. creditManifestoId reference accepted');
  {
    let observedArgs: { creditManifestoId?: string; creditManifesto?: unknown } | null = null;
    const deps = makeDeps();
    const patched: BuildAndIngestDeps = {
      ...deps,
      ingestExtractionResult: async (args, store) => {
        observedArgs = args as { creditManifestoId?: string; creditManifesto?: unknown };
        return deps.ingestExtractionResult(args, store);
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const body = validBody();
    delete (body as { creditManifesto?: unknown }).creditManifesto;
    body.creditManifestoId = 'm'.repeat(64);
    const req: MockReq = { body, files: {} };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '15.1 status 201');
    const captured15 = observedArgs as { creditManifestoId?: string; creditManifesto?: unknown } | null;
    assertEqual(captured15?.creditManifestoId ?? null, 'm'.repeat(64), '15.2 ingest received creditManifestoId');
  }

  /* Helper: build an ExtractionResult with a content-hashed id (rather than
   * the hardcoded EXT_ID stub used by makeExtractionResult). Required for
   * Tier B tests that insert into a real RecordGraphStore — the store's
   * verifyAndSerialize step rejects any record whose claimed id doesn't
   * match the body hash.
   *
   * dealRefSuffix lets each test produce a distinct ExtractionResult to
   * avoid cross-test ON-CONFLICT-DO-NOTHING aliasing within the same
   * :memory: DB. */
  function makeProperExtractionResult(dealRefSuffix: string): ExtractionResult {
    const body = {
      analysisAsOfDate: '2026-05-20T00:00:00Z' as ISODateTime,
      extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
      dealRef: `TIER-B-${dealRefSuffix}`,
      rentRoll: null,
      t12: null,
      pca: null,
      appraisal: null,
      sellerUw: null,
      sellerUwOperatingStatement: null,
      asr: null,
      loanTerms: null,
      sourceDocuments: [],
      extractorVersions: {} as Record<string, string>,
    };
    return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
  }

  /* CASE 16 — Tier B short-circuit: re-upload skips composer.
   *
   * Wire a real in-memory record-graph store + memory blob store. First call
   * runs the composer (count = 1) and populates the cache. Second call with
   * the same body + the same file content hits the cache and SKIPS the
   * composer (count stays at 1). */
  console.log('\n16. Tier B short-circuit — re-upload same bytes skips composer');
  {
    const realStore = new RecordGraphStore(':memory:');
    const memBlob = new MemoryBlobStore();
    let composerCalls = 0;

    const baseDeps = makeDeps({ storeOverride: realStore, blobStoreOverride: memBlob });
    const composedExtraction = makeProperExtractionResult('case-16');
    // Real ExtractionResult must actually be persisted by the test ingest so
    // the cache hit's getExtractionResult succeeds.
    realStore.insertExtractionResult(composedExtraction);
    const patched: BuildAndIngestDeps = {
      ...baseDeps,
      buildExtractionResult: async () => {
        composerCalls += 1;
        return {
          extractionResult: composedExtraction,
          propertyMetadata: null,
          report: makeBuildReport(),
        };
      },
    };

    const handler = makeBuildAndIngestHandler(patched);
    const asrBuf = Buffer.from('asr fixture content for cache test');
    const fileBody: MulterFilesMap = {
      asr: [{ buffer: asrBuf, originalname: 'asr.pdf' }] as never,
    };

    // First call — cache miss, composer runs
    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler(req as never, res as never);
      assertEqual(res.statusCode, 201, '16.1 first call 201');
      assertEqual(composerCalls, 1, '16.2 composer called once on first request');
    }
    // Second call — same bytes, cache hit, composer NOT called again
    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler(req as never, res as never);
      assertEqual(res.statusCode, 201, '16.3 second call 201');
      assertEqual(composerCalls, 1, '16.4 composer NOT called second time (cache hit)');
      const body = res.body as { extractionResultId: string };
      assertEqual(body.extractionResultId, composedExtraction.id, '16.5 same extractionResultId returned on cache hit');
    }

    realStore.close();
  }

  /* CASE 17 — Tier B short-circuit: PropertyMetadata preserved across cache hit.
   *
   * First call produces a non-null PropertyMetadata; cache stores its id.
   * Second call (cache hit) returns the same propertyMetadataId. */
  console.log('\n17. Tier B short-circuit — PropertyMetadata preserved across cache hit');
  {
    const realStore = new RecordGraphStore(':memory:');
    const memBlob = new MemoryBlobStore();
    const composedExtraction = makeProperExtractionResult('case-17');
    realStore.insertExtractionResult(composedExtraction);

    // Build a real PropertyMetadata record so getPropertyMetadata returns it
    // on cache hit. Use the contract's compute helper for the id.
    const pmBody = {
      source: 'asr_extraction' as const,
      propertyName: 'Test Property',
      propertySubtype: 'Suburban Office',
      address: '123 Main St',
      city: 'Testville', state: 'CA', zip: '90000',
      county: null, msa: null, submarket: null,
      yearBuilt: 2010, yearRenovated: null, buildingClass: 'B',
      totalSquareFeet: 50000, totalUnits: null, totalRooms: null, totalPads: null,
      occupancyPhysical: 0.92, occupancyEconomic: null,
      ownershipInterest: 'Fee Simple', numberOfBuildings: 1,
    };
    const pm: PropertyMetadata = { id: computePropertyMetadataId(pmBody), ...pmBody } as PropertyMetadata;
    realStore.insertPropertyMetadata(pm);

    let composerCalls = 0;
    const baseDeps = makeDeps({ storeOverride: realStore, blobStoreOverride: memBlob });
    const patched: BuildAndIngestDeps = {
      ...baseDeps,
      buildExtractionResult: async () => {
        composerCalls += 1;
        return {
          extractionResult: composedExtraction,
          propertyMetadata: pm,
          report: makeBuildReport(),
        };
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const asrBuf = Buffer.from('content for PM-preservation test');
    const fileBody: MulterFilesMap = {
      asr: [{ buffer: asrBuf, originalname: 'asr.pdf' }] as never,
    };

    // First call
    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler(req as never, res as never);
      const body = res.body as { propertyMetadataId: string };
      assertEqual(res.statusCode, 201, '17.1 first call 201');
      assertEqual(body.propertyMetadataId, pm.id, '17.2 first call returned pm.id');
    }
    // Second call — cache hit, same pm.id reused
    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler(req as never, res as never);
      const body = res.body as { propertyMetadataId: string };
      assertEqual(res.statusCode, 201, '17.3 second call 201');
      assertEqual(composerCalls, 1, '17.4 composer NOT re-called');
      assertEqual(body.propertyMetadataId, pm.id, '17.5 same propertyMetadataId on cache hit');
    }

    realStore.close();
  }

  /* CASE 18 — Tier B: putBlob failure fails fast BEFORE composer runs.
   *
   * A misbehaving BlobStore throws on putBlob. The request must fail before
   * the composer is invoked — no wasted AI calls. */
  console.log('\n18. Tier B — putBlob failure fails fast before composer');
  {
    const failingBlob: BlobStore = {
      putBlob: async () => { throw new BlobStoreError('WRITE_FAILED', 'x'.repeat(64), 'disk full simulated'); },
      getBlob: async () => null,
      hasBlob: async () => false,
    };
    let composerCalls = 0;
    const baseDeps = makeDeps({ blobStoreOverride: failingBlob });
    const patched: BuildAndIngestDeps = {
      ...baseDeps,
      buildExtractionResult: async () => {
        composerCalls += 1;
        return {
          extractionResult: makeExtractionResult(),
          propertyMetadata: null,
          report: makeBuildReport(),
        };
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const fileBody: MulterFilesMap = {
      asr: [{ buffer: Buffer.from('whatever'), originalname: 'asr.pdf' }] as never,
    };
    const req: MockReq = { body: validBody(), files: fileBody };
    const res = makeRes();
    await handler(req as never, res as never);

    assertEqual(res.statusCode, 500, '18.1 status 500');
    const body = res.body as { error: string; hash?: string };
    assertEqual(body.error, 'WRITE_FAILED', '18.2 error code surfaces BlobStoreError.code');
    assertEqual(composerCalls, 0, '18.3 composer NOT called (fail fast)');
  }

  /* CASE 19 — Tier B: orphan cache entry falls through to re-extract.
   *
   * Plant a cache entry that references a non-existent ExtractionResultId.
   * Route should detect the missing record on cache hit and fall through to
   * the cache-miss path: putBlob + run composer. */
  console.log('\n19. Tier B — orphan cache entry falls through to re-extract');
  {
    const realStore = new RecordGraphStore(':memory:');
    const memBlob = new MemoryBlobStore();
    let composerCalls = 0;

    // For the orphan cache entry to install successfully (FK constraint),
    // we need a temporary ExtractionResult row to point at. We'll insert
    // one, then delete it directly via sql to simulate manual deletion. But
    // simpler: insert a real record, then plant a cache entry pointing at
    // a DIFFERENT id (one that doesn't exist). The FK is satisfied via the
    // initial id, and getExtractionResult on the non-existent id returns
    // null — same effective behavior as a true orphan.
    //
    // Even simpler: directly plant a cache entry where the cache lookup
    // would hit but the extraction_result row doesn't exist. FK prevents
    // that. So: insert a placeholder ExtractionResult, write a cache row
    // pointing at IT, then DELETE the row from extraction_results
    // (bypassing FK via PRAGMA). Trickier than worth it.
    //
    // Cleanest: stub the store so getExtractionInputCacheByKey returns a
    // non-null { extractionResultId }, but getExtractionResult returns null
    // for that id. This is the exact post-condition of a manual record
    // deletion in production.
    const orphanCacheStore = {
      ...realStore,
      getExtractionInputCacheByKey: () => ({
        extractionResultId: ('o'.repeat(64)) as never,
        propertyMetadataId: null,
      }),
      getExtractionResult: () => null, // orphan
      getPropertyMetadata: () => null,
      insertExtractionResult: realStore.insertExtractionResult.bind(realStore),
      insertExtractionInputCache: realStore.insertExtractionInputCache.bind(realStore),
      insertPropertyMetadata: realStore.insertPropertyMetadata.bind(realStore),
      // Cast retained per §13.6 acceptance (b): same justification as the
      // makeDeps default storeMock at the top of this file — RecordGraphStore
      // is a class without a narrow interface; the spread-over-real-store
      // pattern loses class identity at the type level (spread returns plain
      // object). Cleaning cleanly requires cascade narrowing through
      // ingestExtractionResult; deferred to a dedicated architectural ticket
      // (see #49 v14 ship).
    } as unknown as RecordGraphStore;

    const composedExtraction = makeProperExtractionResult('case-19');
    const baseDeps = makeDeps({ storeOverride: orphanCacheStore, blobStoreOverride: memBlob });
    const patched: BuildAndIngestDeps = {
      ...baseDeps,
      buildExtractionResult: async () => {
        composerCalls += 1;
        return {
          extractionResult: composedExtraction,
          propertyMetadata: null,
          report: makeBuildReport(),
        };
      },
    };
    const handler = makeBuildAndIngestHandler(patched);
    const fileBody: MulterFilesMap = {
      asr: [{ buffer: Buffer.from('orphan-cache test content'), originalname: 'asr.pdf' }] as never,
    };
    const req: MockReq = { body: validBody(), files: fileBody };
    const res = makeRes();
    await handler(req as never, res as never);
    assertEqual(res.statusCode, 201, '19.1 status 201 (fall through succeeded)');
    assertEqual(composerCalls, 1, '19.2 composer ran (orphan cache entry triggered fall-through)');

    realStore.close();
  }

  /* CASE 20 — Tier B: cache miss writes a cache entry that subsequent
   * uploads can use.
   *
   * Issue the same request twice via different handler instances with the
   * same real store. The cache row written by the first run should be
   * visible to the second run (which uses a different handler closure but
   * the same store). This verifies the cache-write step actually fires on
   * cache miss. */
  console.log('\n20. Tier B — cache write after compose makes second call short-circuit');
  {
    const realStore = new RecordGraphStore(':memory:');
    const memBlob = new MemoryBlobStore();
    const composedExtraction = makeProperExtractionResult('case-20');
    realStore.insertExtractionResult(composedExtraction);
    let composerCalls = 0;

    const baseDeps = makeDeps({ storeOverride: realStore, blobStoreOverride: memBlob });
    const patched: BuildAndIngestDeps = {
      ...baseDeps,
      buildExtractionResult: async () => {
        composerCalls += 1;
        return {
          extractionResult: composedExtraction,
          propertyMetadata: null,
          report: makeBuildReport(),
        };
      },
    };
    const handler1 = makeBuildAndIngestHandler(patched);
    const handler2 = makeBuildAndIngestHandler(patched);
    const fileBody: MulterFilesMap = {
      asr: [{ buffer: Buffer.from('cache-write verification test'), originalname: 'asr.pdf' }] as never,
    };

    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler1(req as never, res as never);
      assertEqual(res.statusCode, 201, '20.1 first handler 201');
    }
    {
      const req: MockReq = { body: validBody(), files: fileBody };
      const res = makeRes();
      await handler2(req as never, res as never);
      assertEqual(res.statusCode, 201, '20.2 second handler 201');
      assertEqual(composerCalls, 1, '20.3 cache hit via persisted cache entry (composer only ran once)');
    }

    realStore.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
