/**
 * Tests for GET /api/analyses/:id graph branch (option C / issue #20, step 8.7).
 *
 *   npm run test:get-analysis-route       (from apps/api)
 *
 * Closes the read-side of the AnalysisId contract migration that 8.3 started:
 *   - Pre-8.3, GET /:id on the graph branch treated :id as a DoctrineEvaluationId.
 *   - Post-8.3, ingest returns rootId = RevisionId (lineageRootId), but the GET handler
 *     was still treating it as DoctrineEvaluationId — every ingest → GET flow would 404.
 *   - 8.7 fixes this by resolving the envelope via getLatestRevisionByLineageRoot and
 *     materializing from envelope.doctrineEvaluationId.
 *
 * Coverage:
 *   - Dispatch by id format (uuid → legacy fallthrough, 64-hex → graph, other → 400)
 *   - Graph happy path: ingest root, GET with rootId, returns rendered + lineageRootId + revisionOrdinal
 *   - "Latest by lineage": after applyRevisionDelta, GET returns the CHILD's rendered
 *   - 404 on unknown lineage root
 *   - Cache: two GETs in a row → second is cache hit
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  RevisionId,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { applyRevisionDelta } from '../services/apply-revision-delta.js';
import { analysisRoutes, handleGraphRead } from '../routes/analysis.routes.js';

const AS_OF = '2026-05-22T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* --------------------------- mock req/res / dispatch --------------------- */

interface AuthPayload { userId: string; email: string; role: string }
interface MockReq {
  method: string;
  url: string;
  path: string;
  body: unknown;
  query: Record<string, unknown>;
  params: Record<string, string>;
  headers: Record<string, string>;
  user?: AuthPayload;
}
interface MockRes {
  statusCode: number;
  body: unknown;
  locals: { observability?: { cacheHit?: boolean; renderVersion?: string } };
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeReq(opts: Partial<MockReq> = {}): MockReq {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    path: opts.path ?? opts.url ?? '/',
    body: opts.body,
    query: opts.query ?? {},
    params: opts.params ?? {},
    headers: opts.headers ?? {},
    user: opts.user,
  };
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function dispatch(req: MockReq, res: MockRes): void {
  const stack = (analysisRoutes as unknown as { stack: unknown[] }).stack;
  for (const layer of stack) {
    const route = (layer as { route?: { path?: string; methods?: Record<string, boolean>; stack?: unknown[] } }).route;
    if (!route) continue;
    if (route.path !== req.path) continue;
    if (!route.methods?.[req.method.toLowerCase()]) continue;
    runChain(req, res, route.stack ?? [], 0);
    return;
  }
  res.status(404).json({ error: 'NO_MATCH' });
}
function runChain(req: MockReq, res: MockRes, handlers: unknown[], i: number): void {
  if (i >= handlers.length) return;
  const layer = handlers[i] as { handle?: ((req: unknown, res: unknown, next: () => void) => void) & { name?: string } };
  const handle = layer.handle;
  if (!handle) return;
  if (handle.name === 'requireAuth' && req.user !== undefined) {
    runChain(req, res, handlers, i + 1);
    return;
  }
  handle(req as never, res as never, () => runChain(req, res, handlers, i + 1));
}

/* ----------------------- upstream fixtures (graph) ---------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'GET-ROUTE-1',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'B', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2034-01-01T00:00:00Z', baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000,
          occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    t12: {
      period: 'T-12', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000,
                   repairsMaintenance: 36_000, managementFees: 40_000,
                   totalOperatingExpenses: 218_000 },
    },
    pca: { immediateRepairs: 50_000, nearTermRepairs: 150_000,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' } },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: { loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
      interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}
function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}
function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}
function makeManifesto(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function seedRoot(store: RecordGraphStore) {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  return ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
    },
    store,
  );
}

const SOME_GRAPH_ID = 'a'.repeat(64);
const LEGACY_UUID = '00000000-0000-4000-8000-000000000001';

/* =============================== TESTS ================================== */

console.log('Dispatch — malformed id → 400 MALFORMED_ANALYSIS_ID:');
{
  const req = makeReq({ path: '/:id', params: { id: 'not-a-valid-id' } });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'malformed id -> 400');
  assertEqual((res.body as { error: string }).error, 'MALFORMED_ANALYSIS_ID', 'MALFORMED_ANALYSIS_ID token');
}

console.log('\nDispatch — uuid v4 falls through to legacy handler (not blocked / not malformed):');
{
  // Legacy branch consults the production sqlite-store and returns 404 'Analysis not found'.
  // We only assert that the dispatch routed to the legacy branch (i.e., not MALFORMED).
  const req = makeReq({ path: '/:id', params: { id: LEGACY_UUID } });
  const res = makeRes();
  dispatch(req, res);
  assert(res.statusCode !== 400 || (res.body as { error: string }).error !== 'MALFORMED_ANALYSIS_ID',
    'uuid v4 does NOT 400 MALFORMED (dispatched into legacy branch)');
}

console.log('\nGraph 404 — unknown lineage root → 404 ANALYSIS_NOT_FOUND:');
{
  const store = new RecordGraphStore(':memory:');
  // No seed — getLatestRevisionByLineageRoot returns null.
  const req = makeReq({ path: '/:id', params: { id: SOME_GRAPH_ID } });
  const res = makeRes();
  handleGraphRead(req as never, res as never, store);
  assertEqual(res.statusCode, 404, 'unknown graph lineage -> 404');
  const body = res.body as { error: string; lineageRootId: string };
  assertEqual(body.error, 'ANALYSIS_NOT_FOUND', 'ANALYSIS_NOT_FOUND token');
  assertEqual(body.lineageRootId, SOME_GRAPH_ID, 'lineageRootId echoed in error body');
}

console.log('\nHappy path — ingest root, GET with rootId → 200 + lineageRootId + revisionOrdinal=0:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({ path: '/:id', params: { id: root.rootId as string } });
  const res = makeRes();
  handleGraphRead(req as never, res as never, store);
  assertEqual(res.statusCode, 200, 'status 200');
  const body = res.body as {
    id: string;
    rootId: string;
    lineageRootId: string;
    revisionOrdinal: number;
    metadata: { renderVersion: string };
  };
  assert(/^[0-9a-f]{64}$/.test(body.id), 'rendered.id is 64-hex');
  assert(/^[0-9a-f]{64}$/.test(body.rootId), 'rendered.rootId is 64-hex (DoctrineEvaluationId)');
  assertEqual(body.rootId, root.evaluationId, 'rendered.rootId === ingest.evaluationId (internal anchor)');
  assertEqual(body.lineageRootId, root.rootId, 'lineageRootId === URL :id === ingest.rootId (public AnalysisId)');
  assertEqual(body.revisionOrdinal, 0, 'revisionOrdinal === 0 (root revision)');
  assert(typeof body.metadata.renderVersion === 'string', 'metadata.renderVersion present');
}

console.log('\nLatest-by-lineage — after a revision, GET returns the CHILD\'s rendered:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);

  // Snapshot the root's rendered view first.
  const reqRoot = makeReq({ path: '/:id', params: { id: root.rootId as string } });
  const resRoot = makeRes();
  handleGraphRead(reqRoot as never, resRoot as never, store);
  const rootBody = resRoot.body as { id: string; rootId: string; revisionOrdinal: number };

  // Apply a revision (vacancy stress).
  const rev = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }] },
      triggerSource: 'USER_EDIT',
    },
    store,
  );

  // GET with the SAME lineageRootId. Must resolve to the child, not the root.
  const reqAfter = makeReq({ path: '/:id', params: { id: root.rootId as string } });
  const resAfter = makeRes();
  handleGraphRead(reqAfter as never, resAfter as never, store);

  assertEqual(resAfter.statusCode, 200, 'status 200 after revision');
  const afterBody = resAfter.body as {
    id: string;
    rootId: string;
    lineageRootId: string;
    revisionOrdinal: number;
  };
  assertEqual(afterBody.lineageRootId, root.rootId, 'lineageRootId still equals root.rootId (lineage anchor)');
  assertEqual(afterBody.revisionOrdinal, 1, 'revisionOrdinal === 1 (child)');
  assert(afterBody.rootId !== rootBody.rootId, 'rendered.rootId changed (new DoctrineEvaluationId from revision)');
  assertEqual(afterBody.rootId, rev.evaluation.id, 'rendered.rootId === child.evaluation.id');
  assert(afterBody.id !== rootBody.id, 'rendered.id changed (new content-hash)');
}

console.log('\nCache behavior — second GET on the same lineage is a cache hit:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req1 = makeReq({ path: '/:id', params: { id: root.rootId as string } });
  const res1 = makeRes();
  handleGraphRead(req1 as never, res1 as never, store);

  const req2 = makeReq({ path: '/:id', params: { id: root.rootId as string } });
  const res2 = makeRes();
  handleGraphRead(req2 as never, res2 as never, store);

  assertEqual(res1.statusCode, 200, 'first GET 200');
  assertEqual(res2.statusCode, 200, 'second GET 200');
  assertEqual(res1.locals.observability?.cacheHit, false, 'first GET: cacheHit=false (cold)');
  assertEqual(res2.locals.observability?.cacheHit, true, 'second GET: cacheHit=true (warm)');
  // Body determinism: byte-identical rendered between cold and warm reads.
  const b1 = res1.body as { id: string; rootId: string };
  const b2 = res2.body as { id: string; rootId: string };
  assertEqual(b1.id, b2.id, 'rendered.id matches across cold + warm');
  assertEqual(b1.rootId, b2.rootId, 'rendered.rootId matches across cold + warm');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
