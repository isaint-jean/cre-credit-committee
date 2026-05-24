/**
 * Tests for POST /api/analyses/:id/revisions (option C / issue #20, step 8.6).
 *
 *   npm run test:revision-route       (from apps/api)
 *
 * Coverage:
 *   - Permission gating (uniform across legacy + graph branches via analysis:revise)
 *   - Dispatch by id format (uuid → legacy, 64-hex → graph, other → 400)
 *   - Graph branch happy path + response shape including inputDiff (the 8.6 addition)
 *   - Body validation (top-level shape) at the route level
 *   - Service-error → HTTP mapping (404 / 400 / 409 / 500)
 *   - Idempotency through the route
 *
 * Two test modes:
 *   1. Router-walked tests (auth/permission/dispatch) use the express stack walker pattern
 *      from test-workflow-api.ts. These never touch the store.
 *   2. Direct-handler tests (happy path / idempotency / service-error mapping) call the
 *      exported `handleGraphRevision` with an in-memory RecordGraphStore. This isolates
 *      tests from the production data/cre.db singleton.
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
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
import { analysisRoutes, handleGraphRevision } from '../routes/analysis.routes.js';

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
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeReq(opts: Partial<MockReq> = {}): MockReq {
  return {
    method: opts.method ?? 'POST',
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
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

/** Walk analysisRoutes for the matching method+path and invoke its handler chain. */
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
  // Skip the real requireAuth middleware when test pre-populates req.user.
  if (handle.name === 'requireAuth' && req.user !== undefined) {
    runChain(req, res, handlers, i + 1);
    return;
  }
  handle(req as never, res as never, () => runChain(req, res, handlers, i + 1));
}

function makeAuth(role: string, email: string = 'user@example.com'): AuthPayload {
  return { userId: 'u-' + email, email, role };
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
    dealRef: 'REV-ROUTE-1',
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
                   generalAndAdmin: null, janitorial: null, reimbursements: null,
                   totalOperatingExpenses: 218_000 },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
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

const LEGACY_UUID = '00000000-0000-4000-8000-000000000001'; // valid uuid v4 shape
const SOME_GRAPH_ID = 'a'.repeat(64);

/* =============================== TESTS ================================== */

console.log('Auth — unauthenticated request → 401:');
{
  const req = makeReq({ path: '/:id/revisions', params: { id: SOME_GRAPH_ID }, body: {} });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 401, 'unauthenticated -> 401');
}

console.log('\nPermission — VIEWER on graph id → 403:');
{
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: SOME_GRAPH_ID },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [] } },
    user: makeAuth('VIEWER'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 403, 'VIEWER on graph -> 403');
  assertEqual((res.body as { error: string }).error, 'PERMISSION_DENIED', 'PERMISSION_DENIED token');
}

console.log('\nPermission — VIEWER on legacy uuid id → 403 (uniform gating):');
{
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: LEGACY_UUID },
    body: { type: 'uw-model-cells', updates: [] },
    user: makeAuth('VIEWER'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 403, 'VIEWER on legacy uuid -> 403 (permission gate applies before dispatch)');
}

console.log('\nPermission — COMMITTEE_MEMBER explicitly denied (separation of duties) → 403:');
{
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: SOME_GRAPH_ID },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [] } },
    user: makeAuth('COMMITTEE_MEMBER'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 403, 'COMMITTEE_MEMBER -> 403 (does not hold analysis:revise)');
}

console.log('\nDispatch — malformed id → 400 MALFORMED_ANALYSIS_ID:');
{
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: 'not-a-valid-id' },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [] } },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'malformed id -> 400');
  assertEqual((res.body as { error: string }).error, 'MALFORMED_ANALYSIS_ID', 'MALFORMED_ANALYSIS_ID token');
}

console.log('\nDispatch — uuid v4 falls through to legacy handler (not blocked by permission):');
{
  // ANALYST holds analysis:revise. The middleware admits; dispatch sees uuid → legacy branch.
  // Legacy handler looks up via sqlite-store, finds nothing → 404 with the legacy error string.
  // We only assert that this is NOT a permission denial and NOT a malformed id (i.e., dispatch
  // routed correctly), without asserting on the legacy 404 message which depends on sqlite state.
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: LEGACY_UUID },
    body: { type: 'uw-model-cells', updates: [] },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assert(res.statusCode !== 403, 'ANALYST + legacy uuid does NOT 403');
  assert(res.statusCode !== 400 || (res.body as { error: string }).error !== 'MALFORMED_ANALYSIS_ID',
    'ANALYST + legacy uuid does NOT 400 MALFORMED (dispatched into legacy branch)');
}

/* ----------------- direct-handler tests (in-memory store) ---------------- */

console.log('\nHappy path — ANALYST + graph id + valid delta → 201 with response shape:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: root.rootId as string },
    body: {
      delta: {
        kind: 'adjusted-input-overrides',
        overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }],
      },
      adjustmentOrigin: ['vacancy stress'],
    },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);

  assertEqual(res.statusCode, 201, 'status 201');
  const body = res.body as {
    rootId: string;
    revisionId: string;
    evaluationId: string;
    revisionOrdinal: number;
    inputDiff: { changedFields: Array<{ path: string }> };
  };
  assertEqual(body.rootId, root.rootId, 'rootId echoes URL :id');
  assert(/^[0-9a-f]{64}$/.test(body.revisionId), 'revisionId is 64-hex');
  assert(/^[0-9a-f]{64}$/.test(body.evaluationId), 'evaluationId is 64-hex');
  assertEqual(body.revisionOrdinal, 1, 'revisionOrdinal === 1');
  assert(Array.isArray(body.inputDiff.changedFields) && body.inputDiff.changedFields.length > 0,
    'inputDiff.changedFields is a non-empty array');
  const paths = body.inputDiff.changedFields.map((f) => f.path);
  assert(paths.includes('income.vacancyPct.adjusted'),
    'inputDiff includes the override path income.vacancyPct.adjusted');
  assert(paths.some((p) => p.startsWith('metrics.')),
    'inputDiff includes recomputed metrics paths');
}

console.log('\nHappy path — CREDIT_OFFICER also permitted (router-level):');
{
  // Router-walked variant: shows the permission gate passes for CREDIT_OFFICER. The
  // subsequent handler reaches recordGraphStore (singleton) which won't have the lineage,
  // so we expect 404 PARENT_REVISION_NOT_FOUND. The point is the role is NOT denied.
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: SOME_GRAPH_ID },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.1 }] } },
    user: makeAuth('CREDIT_OFFICER'),
  });
  const res = makeRes();
  dispatch(req, res);
  assert(res.statusCode !== 403, 'CREDIT_OFFICER does NOT 403');
  assertEqual(res.statusCode, 404, 'CREDIT_OFFICER + unknown lineage root -> 404 PARENT_REVISION_NOT_FOUND');
  assertEqual((res.body as { error: string }).error, 'PARENT_REVISION_NOT_FOUND', 'PARENT_REVISION_NOT_FOUND token');
}

console.log('\nBody validation — missing delta → 400 INVALID_BODY:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({ path: '/:id/revisions', params: { id: root.rootId as string }, body: { /* missing delta */ } });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 400, 'missing delta -> 400');
  assertEqual((res.body as { error: string }).error, 'INVALID_BODY', 'INVALID_BODY token');
}

console.log('\nBody validation — delta with wrong kind → 400 INVALID_BODY:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: root.rootId as string },
    body: { delta: { kind: 'something-else', overrides: [] } },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 400, 'wrong kind -> 400');
  assertEqual((res.body as { error: string }).error, 'INVALID_BODY', 'INVALID_BODY token');
}

console.log('\nUnknown lineage root → 404 PARENT_REVISION_NOT_FOUND:');
{
  const store = new RecordGraphStore(':memory:');
  // No seed — graph id will not resolve to any envelope.
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: SOME_GRAPH_ID },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }] } },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 404, 'unknown lineage root -> 404');
  assertEqual((res.body as { error: string }).error, 'PARENT_REVISION_NOT_FOUND', 'PARENT_REVISION_NOT_FOUND token');
}

console.log('\nInvalidDeltaError — non-editable path → 400 INVALID_DELTA with code:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: root.rootId as string },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'metrics.dscr', value: 1.5 }] } },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 400, 'non-editable path -> 400');
  const body = res.body as { error: string; code: string; path: string };
  assertEqual(body.error, 'INVALID_DELTA', 'INVALID_DELTA token');
  assertEqual(body.code, 'NON_EDITABLE_PATH', 'code === NON_EDITABLE_PATH');
  assertEqual(body.path, 'metrics.dscr', 'path echoed');
}

console.log('\nInvalidDeltaError — vacancy+concessions > 1 → 400 with VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: root.rootId as string },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 1.5 }] } },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 400, 'vacancy>1 -> 400');
  const body = res.body as { error: string; code: string };
  assertEqual(body.error, 'INVALID_DELTA', 'INVALID_DELTA token');
  assertEqual(body.code, 'VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE', 'code === VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE');
}

console.log('\nInvalidDeltaError — NaN value → 400 with BAD_VALUE_TYPE:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const req = makeReq({
    path: '/:id/revisions',
    params: { id: root.rootId as string },
    body: { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: Number.NaN }] } },
  });
  const res = makeRes();
  handleGraphRevision(req as never, res as never, store);
  assertEqual(res.statusCode, 400, 'NaN -> 400');
  assertEqual((res.body as { code: string }).code, 'BAD_VALUE_TYPE', 'code === BAD_VALUE_TYPE');
}

console.log('\nIdempotency — same body twice → both 201, same revisionId:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const body = { delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }] } };

  const req1 = makeReq({ path: '/:id/revisions', params: { id: root.rootId as string }, body });
  const res1 = makeRes();
  handleGraphRevision(req1 as never, res1 as never, store);

  const req2 = makeReq({ path: '/:id/revisions', params: { id: root.rootId as string }, body });
  const res2 = makeRes();
  handleGraphRevision(req2 as never, res2 as never, store);

  assertEqual(res1.statusCode, 201, 'first call -> 201');
  assertEqual(res2.statusCode, 201, 'second call -> 201 (idempotent)');
  const b1 = res1.body as { revisionId: string; revisionOrdinal: number };
  const b2 = res2.body as { revisionId: string; revisionOrdinal: number };
  assertEqual(b1.revisionId, b2.revisionId, 'same revisionId across both calls');
  assertEqual(b1.revisionOrdinal, b2.revisionOrdinal, 'same revisionOrdinal across both calls');
  assertEqual(store.walkLineageChain(root.rootId as RevisionId).length, 2, 'chain length stays 2 (root + one child)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
