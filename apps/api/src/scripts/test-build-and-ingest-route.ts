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
} from '@cre/contracts';
import type { BuildReport } from '../services/extraction/build-report.js';
import type { BuildExtractionResultOutput } from '../services/extraction/build-extraction-result.js';
import {
  IngestionError,
  type IngestionResult,
} from '../services/ingest-extraction-result.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  makeBuildAndIngestHandler,
  type BuildAndIngestDeps,
} from '../routes/build-and-ingest.routes.js';

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
const ROOT_ID = ('d'.repeat(64)) as DoctrineEvaluationId;
const PM_ID = ('p'.repeat(64)) as PropertyMetadataId;
const LIB_ID = ('1'.repeat(64)) as LibrarySnapshotId;

function makeExtractionResult(): ExtractionResult {
  return {
    id: EXT_ID,
    analysisAsOfDate: '2026-05-20T00:00:00Z' as ISODateTime,
    extractionEngineVersion: '1.1.0' as never,
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
  const evaluation = { id: ROOT_ID } as DoctrineEvaluation;
  return { rootId: ROOT_ID, evaluation };
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
    ingestExtractionResult: () => {
      if (o.ingestThrow !== undefined) throw o.ingestThrow;
      return o.ingestReturn !== undefined ? o.ingestReturn : makeIngestionResult();
    },
    recordGraphStore: storeMock,
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
    const body = res.body as { rootId: string; extractionResultId: string; propertyMetadataId: string | null };
    assertEqual(body.rootId, ROOT_ID, '1.2 rootId == ingest result');
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
