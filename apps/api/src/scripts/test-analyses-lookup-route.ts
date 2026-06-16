/**
 * Funnel PR — GET /api/analyses/lookup acceptance test.
 *
 *   npx tsx apps/api/src/scripts/test-analyses-lookup-route.ts
 *
 * The first funnel PR touching an engine route file (analysis.routes.ts).
 * Proves the lookup is correct AND that the route precedence puts /lookup
 * before /:id so the literal segment isn't shadowed.
 *
 * Mock-req/res dispatch matches the existing route-test convention
 * (test-pool-pr4-http.ts, test-get-analysis-route.ts).
 *
 * Asserts:
 *   §A  found: seed an analysis with dealRef='X' → lookup returns
 *       { found: true, analysisId, status }.
 *   §B  not-found: lookup an unknown dealRef → { found: false } 200, NOT 404
 *       (the funnel's clean negative).
 *   §C  SUNROAD-real case: a row with dealRef='SUNROAD-CENTRUM-REAL' (the same
 *       string the dev cre.db actually carries) → findable.
 *   §D  BMARK-synthetic case: pool dealRefs like 'deal-L1' (seeded loans with
 *       NO analysis) → { found: false } — proves the funnel's "New analysis"
 *       branch will fire correctly.
 *   §E  bad input: missing/empty dealRef → 400 POOL_BAD_REQUEST.
 *   §F  route precedence: GET /lookup?dealRef=X reaches the lookup handler,
 *       NOT the /:id handler (assert by response shape — { found } vs.
 *       { analysis }).
 *   §G  multiplicity: two extractions for the same dealRef → multipleFound:true,
 *       count:2, head = most recent.
 *
 * Uses :memory: SQLite via SqliteStore (existing constructor supports it).
 * The graph-substrate rows are inserted directly via the underlying db handle
 * since this test exercises the JOIN, not the producers.
 */
import Database from 'better-sqlite3';
import { SqliteStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import { analysisRoutes } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/routes/analysis.routes.js';

/* -------------------------------------------------------------------------- */
/* Mock req/res                                                               */
/* -------------------------------------------------------------------------- */

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
  locals: Record<string, unknown>;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}
function makeReq(opts: Partial<MockReq>): MockReq {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    path: opts.path ?? opts.url ?? '/',
    body: opts.body,
    query: opts.query ?? {},
    params: opts.params ?? {},
    headers: opts.headers ?? {},
    user: opts.user ?? { userId: 'u', email: 'u@example.com', role: 'ANALYST' },
  };
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; if (this.statusCode === 0) this.statusCode = 200; return this; },
  };
  return res;
}
function dispatch(req: MockReq, res: MockRes): void {
  type Layer = {
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack?: { handle?: (req: unknown, res: unknown, next: () => void) => void }[];
    };
  };
  const stack = (analysisRoutes as unknown as { stack: Layer[] }).stack;
  for (const layer of stack) {
    const route = layer.route;
    if (!route?.path || !route.methods?.[req.method.toLowerCase()]) continue;
    const params = matchPath(route.path, req.path);
    if (params === null) continue;
    req.params = params;
    runChain(req, res, route.stack ?? [], 0);
    return;
  }
  res.status(404).json({ error: 'NO_MATCH', path: req.path });
}
function matchPath(pattern: string, url: string): Record<string, string> | null {
  const pSegs = pattern.split('/').filter(Boolean);
  const uSegs = url.split('/').filter(Boolean);
  if (pSegs.length !== uSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const ps = pSegs[i]!;
    const us = uSegs[i]!;
    if (ps.startsWith(':')) params[ps.slice(1)] = us;
    else if (ps !== us) return null;
  }
  return params;
}
function runChain(
  req: MockReq, res: MockRes,
  handlers: { handle?: (req: unknown, res: unknown, next: () => void) => void }[],
  i: number,
): void {
  if (i >= handlers.length) return;
  const handle = handlers[i]?.handle;
  if (!handle) return;
  handle(req as never, res as never, () => runChain(req, res, handlers, i + 1));
}

function splitPathAndQuery(p: string): { path: string; query: Record<string, string> } {
  const q = p.indexOf('?');
  if (q < 0) return { path: p, query: {} };
  const path = p.slice(0, q);
  const query: Record<string, string> = {};
  for (const pair of p.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
    query[k] = v;
  }
  return { path, query };
}
function call(method: string, pathWithQuery: string): { status: number; body: any } {
  const { path, query } = splitPathAndQuery(pathWithQuery);
  const req = makeReq({ method, url: pathWithQuery, path, body: undefined, query });
  const res = makeRes();
  dispatch(req, res);
  return { status: res.statusCode, body: res.body as any };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}

console.log('================================================================');
console.log('Funnel PR — GET /api/analyses/lookup acceptance test');
console.log('================================================================');

/* -------------------------------------------------------------------------- */
/* Setup — :memory: DB, seeded with the join chain                            */
/* -------------------------------------------------------------------------- */

// The route module imports a singleton `store` (default cre.db). For the test we
// need to swap the SqliteStore's underlying db to a :memory: one. The existing
// route-test convention (test-get-analysis-route.ts) doesn't swap; here we use a
// brand-new in-memory store instance, then SQL-injection-style insert directly.
// We use the imported singleton's connection via a one-line escape — same
// pattern PR2/PR3/PR4 tests use.

import { store as singletonStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';

// Replace the singleton's db with a fresh :memory: one. We do this by reaching
// the private field; same convention used in the existing PR2-PR4 test files.
const memDb = new Database(':memory:');
memDb.pragma('foreign_keys = OFF');  // simplify the test — we only need the FK shapes, not enforcement
(singletonStore as unknown as { db: Database.Database }).db = memDb;

// Create JUST the tables involved in the join chain. Schema mirrors the real
// DDL but stripped of FK constraints (we toggled foreign_keys off above).
memDb.exec(`
  CREATE TABLE extraction_results (
    id TEXT PRIMARY KEY,
    deal_ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE doctrine_evaluations (
    id TEXT PRIMARY KEY,
    extraction_result_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE revision_lineage_envelopes (
    revision_id TEXT PRIMARY KEY,
    lineage_root_id TEXT NOT NULL,
    doctrine_evaluation_id TEXT NOT NULL
  );
  CREATE TABLE analyses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    graph_revision_id TEXT,
    -- columns rowToAnalysis() reads on the §F cross-check path
    data TEXT NOT NULL DEFAULT '{}',
    parent_analysis_id TEXT,
    lineage_root_id TEXT,
    revision_ordinal INTEGER NOT NULL DEFAULT 0
  );
  -- DEAL END-TO-END Slice 1 — the pool-mediated fallback path consults this
  -- table to resolve pool dealRefs (e.g. bmark2024v8-sunroad-centrum) to
  -- engine analyses whose analyses.name normalizes to the same property
  -- name as loan_in_pool.originator_loan_ref.
  CREATE TABLE loan_in_pool (
    id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    deal_ref TEXT NOT NULL,
    originator_loan_ref TEXT
  );
`);

function seedAnalysis(opts: {
  readonly dealRef: string;
  readonly extractionId: string;
  readonly doctrineId: string;
  readonly revisionId: string;
  readonly legacyAnalysisId: string | null;
  readonly legacyStatus: string | null;
  readonly extractionCreatedAt: string;
  readonly legacyName?: string;
}): void {
  memDb.prepare('INSERT INTO extraction_results (id, deal_ref, created_at, payload) VALUES (?, ?, ?, ?)')
    .run(opts.extractionId, opts.dealRef, opts.extractionCreatedAt, '{}');
  memDb.prepare('INSERT INTO doctrine_evaluations (id, extraction_result_id, created_at) VALUES (?, ?, ?)')
    .run(opts.doctrineId, opts.extractionId, opts.extractionCreatedAt);
  memDb.prepare('INSERT INTO revision_lineage_envelopes (revision_id, lineage_root_id, doctrine_evaluation_id) VALUES (?, ?, ?)')
    .run(opts.revisionId, opts.revisionId /* root */, opts.doctrineId);
  if (opts.legacyAnalysisId !== null) {
    memDb.prepare('INSERT INTO analyses (id, name, status, graph_revision_id) VALUES (?, ?, ?, ?)')
      .run(opts.legacyAnalysisId, opts.legacyName ?? opts.dealRef, opts.legacyStatus ?? 'complete', opts.revisionId);
  }
}

// Sunroad-real: a legacy uuid linked through the graph chain.
seedAnalysis({
  dealRef: 'SUNROAD-CENTRUM-REAL',
  extractionId: '23d2edd71a0f6dd944a2e563429016287f4d769c1f24125ec4bc545c23c079dd',
  doctrineId: '17a2455385a64f1e78fc4f4c8a679419da2dbb824f651cf66a511093228d3b81',
  revisionId: '444f40a686df27b34dc4f7f29efc77afc45262ed20eae6d5401b76874e86de04',
  legacyAnalysisId: 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  legacyStatus: 'complete',
  legacyName: 'Sunroad Centrum (real-deal validation)',
  extractionCreatedAt: '2026-05-31T15:46:09.401Z',
});

// A graph-only analysis (no legacy row) — proves the LEFT JOIN handles that path.
seedAnalysis({
  dealRef: 'GRAPH-ONLY-DEAL',
  extractionId: 'a'.repeat(64),
  doctrineId: 'b'.repeat(64),
  revisionId: 'c'.repeat(64),
  legacyAnalysisId: null,
  legacyStatus: null,
  extractionCreatedAt: '2026-04-01T00:00:00Z',
});

// Multiplicity case: two extractions sharing one dealRef.
seedAnalysis({
  dealRef: 'MULTI-DEAL',
  extractionId: '1'.repeat(64),
  doctrineId: '2'.repeat(64),
  revisionId: '3'.repeat(64),
  legacyAnalysisId: 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa',
  legacyStatus: 'complete',
  extractionCreatedAt: '2026-03-01T00:00:00Z',
});
seedAnalysis({
  dealRef: 'MULTI-DEAL',
  extractionId: '4'.repeat(64),
  doctrineId: '5'.repeat(64),
  revisionId: '6'.repeat(64),
  legacyAnalysisId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  legacyStatus: 'complete',
  extractionCreatedAt: '2026-06-10T00:00:00Z',  // more recent
});

/* -------------------------------------------------------------------------- */
/* §A — found                                                                 */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. found path ---');
const foundRes = call('GET', '/lookup?dealRef=SUNROAD-CENTRUM-REAL');
assert(foundRes.status === 200, 'GET /lookup?dealRef=SUNROAD-CENTRUM-REAL → 200');
assert(foundRes.body.found === true, 'response.found === true');
assert(foundRes.body.analysisId === 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  '★ SUNROAD-real: analysisId is the legacy uuid (preferred over graphId for debuggable URL)');
assert(foundRes.body.status === 'complete', 'status === "complete" (from legacy column)');
assert(foundRes.body.workflowState === null, 'workflowState === null (TODO: wire DealWorkflowState)');
assert(foundRes.body.multipleFound === undefined, 'no multipleFound for single match');

/* -------------------------------------------------------------------------- */
/* §B — not-found (clean negative, NOT 404)                                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. not-found path ---');
const ntRes = call('GET', '/lookup?dealRef=DOES-NOT-EXIST');
assert(ntRes.status === 200, 'unknown dealRef → 200 (NOT 404)');
assert(ntRes.body.found === false, 'response.found === false');
assert(ntRes.body.analysisId === undefined, 'no analysisId on negative');

/* -------------------------------------------------------------------------- */
/* §C — SUNROAD-real case (already covered in §A; here verify the response   */
/*       carries the real DB's actual analysis name shape)                    */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. SUNROAD-real round-trip ---');
assert(typeof foundRes.body.analysisId === 'string' && foundRes.body.analysisId.length === 36,
  'SUNROAD analysisId is a 36-char uuid (the existing GET /:id legacy dispatch will handle it)');

/* -------------------------------------------------------------------------- */
/* §D — BMARK synthetic (the funnel's "New analysis" branch)                 */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. BMARK synthetic pool dealRefs ---');
for (const synth of ['deal-L1', 'deal-L2', 'deal-L4', 'deal-L7']) {
  const r = call('GET', `/lookup?dealRef=${encodeURIComponent(synth)}`);
  assert(r.status === 200, `${synth}: 200`);
  assert(r.body.found === false, `${synth}: found=false (★ funnel will branch to "New analysis")`);
}

/* -------------------------------------------------------------------------- */
/* §E — bad input                                                             */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. bad input ---');
const missing = call('GET', '/lookup');
assert(missing.status === 400, 'missing dealRef → 400');
assert(missing.body.error === 'POOL_BAD_REQUEST', '400 carries POOL_BAD_REQUEST code');

const empty = call('GET', '/lookup?dealRef=');
assert(empty.status === 400, 'empty dealRef → 400');

/* -------------------------------------------------------------------------- */
/* §F — route precedence (the safety check)                                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- F. route precedence ---');
// The lookup response shape ({ found }) is structurally distinct from /:id's
// shape ({ analysis }). If precedence were wrong, GET /lookup would hit /:id,
// which would call dispatchByIdFormat('lookup') → throw → 400 with
// { error: 'MALFORMED_ANALYSIS_ID' }. We assert the OPPOSITE: the response
// proves /lookup matched first.
assert(foundRes.body.found !== undefined,
  '★ /lookup response shape = { found } — NOT { analysis } — confirms lookup handler matched, NOT /:id');
assert(foundRes.body.error !== 'MALFORMED_ANALYSIS_ID',
  '★ /:id dispatcher did NOT intercept "lookup" (would have produced MALFORMED_ANALYSIS_ID)');

// Negative-control cross-check: send a literally-malformed id (also a
// non-uuid, non-hex string) to /:id. If precedence somehow swapped /lookup
// and /:id, this request would 200-with-{found:false} (the /lookup handler
// without a dealRef param would 400). Instead it must reach /:id and 400
// MALFORMED_ANALYSIS_ID. This proves /:id still routes correctly AFTER
// /lookup was inserted — no over-match.
const malformedIdRes = call('GET', '/some-malformed-string-not-a-uuid');
assert(malformedIdRes.status === 400 && malformedIdRes.body.error === 'MALFORMED_ANALYSIS_ID',
  '★ /:id handler still reachable: a non-id string at /:id → 400 MALFORMED_ANALYSIS_ID (proves /lookup didn\'t over-match)');

/* -------------------------------------------------------------------------- */
/* §G — multiplicity                                                          */
/* -------------------------------------------------------------------------- */
console.log('\n--- G. multiplicity ---');
const multi = call('GET', '/lookup?dealRef=MULTI-DEAL');
assert(multi.status === 200, 'MULTI-DEAL → 200');
assert(multi.body.found === true, 'found === true');
assert(multi.body.multipleFound === true, '★ multipleFound === true');
assert(multi.body.count === 2, 'count === 2 (two extractions for the same dealRef)');
// Head should be the MORE RECENT (2026-06-10 > 2026-03-01)
assert(multi.body.analysisId === 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  '★ head = most recent extraction (ORDER BY created_at DESC)');

/* -------------------------------------------------------------------------- */
/* §H — graph-only analysis (no legacy row → falls back to graphId)          */
/* -------------------------------------------------------------------------- */
console.log('\n--- H. graph-only (no legacy row) ---');
const graphOnly = call('GET', '/lookup?dealRef=GRAPH-ONLY-DEAL');
assert(graphOnly.status === 200, 'GRAPH-ONLY-DEAL → 200');
assert(graphOnly.body.found === true, 'found === true even without legacy row');
assert(graphOnly.body.analysisId === 'c'.repeat(64),
  '★ fallback to graphId (64-hex lineage_root_id) when legacyId is null');
assert(graphOnly.body.status === null,
  'status === null for pure-graph (no legacy column to read from)');

/* -------------------------------------------------------------------------- */
/* §I — DEAL END-TO-END Slice 1: pool-mediated normalized-name fallback       */
/*                                                                            */
/* The pool and the engine carry DIFFERENT dealRef strings for the same real  */
/* loan. Pool: 'bmark2024v8-sunroad-centrum' (reseed convention). Engine:     */
/* 'SUNROAD-CENTRUM-REAL' (calibration convention). The fallback bridges them */
/* via the pool's normalized `originator_loan_ref` ↔ engine's `analyses.name` */
/* normalized (parenthetical-stripped + reused property-name normalizer).      */
/* -------------------------------------------------------------------------- */
console.log('\n--- I. ★ pool-mediated normalized-name fallback ---');

// Seed a pool loan whose deal_ref matches NOTHING in extraction_results,
// but whose normalized originator_loan_ref matches SUNROAD's analyses.name.
memDb.prepare('INSERT INTO loan_in_pool (id, pool_id, deal_ref, originator_loan_ref) VALUES (?, ?, ?, ?)')
  .run('lip-sunroad-uuid', 'pool-bmark-2024-v8-uuid', 'bmark2024v8-sunroad-centrum', 'sunroad centrum');

// Sanity: confirm Pass 1 (exact deal_ref) does NOT match — only Pass 2 should.
const passOnlyAtExact = memDb.prepare(
  "SELECT COUNT(*) AS n FROM extraction_results WHERE deal_ref = 'bmark2024v8-sunroad-centrum'"
).get() as { n: number };
assert(passOnlyAtExact.n === 0,
  '★ Pass 1 (exact deal_ref) returns 0 for the bmark ref — fallback is the only path that can resolve');

const fallbackHit = call('GET', '/lookup?dealRef=bmark2024v8-sunroad-centrum');
assert(fallbackHit.status === 200, '★ pool-ref lookup → 200 via fallback');
assert(fallbackHit.body.found === true, '★ found === true (fallback resolved the identity gap)');
assert(fallbackHit.body.analysisId === 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  '★★ pool ref "bmark2024v8-sunroad-centrum" resolves to the real Sunroad analysisId (the engine\'s SUNROAD-CENTRUM-REAL row)');
assert(fallbackHit.body.status === 'complete',
  '★ status carried through from the matched analysis');
assert(fallbackHit.body.multipleFound === undefined,
  'single fallback match — no multipleFound flag');

/* -------------------------------------------------------------------------- */
/* §J — fallback honesty (no false positives, no over-match)                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- J. fallback honest negatives + multiplicity ---');

// (J1) A pool loan whose originator_loan_ref matches NO analysis name → still
// found:false. The fallback must not silently best-guess.
memDb.prepare('INSERT INTO loan_in_pool (id, pool_id, deal_ref, originator_loan_ref) VALUES (?, ?, ?, ?)')
  .run('lip-other-uuid', 'pool-bmark-2024-v8-uuid', 'bmark2024v8-some-other-loan', 'some other property');
const noMatch = call('GET', '/lookup?dealRef=bmark2024v8-some-other-loan');
assert(noMatch.status === 200 && noMatch.body.found === false,
  '★ pool loan with no name-matching analysis → found:false (fallback does NOT false-positive)');

// (J2) A dealRef that exists in NEITHER extraction_results NOR loan_in_pool
// → still found:false. The fallback can't be triggered by an arbitrary string.
const stranger = call('GET', '/lookup?dealRef=totally-unknown-ref');
assert(stranger.status === 200 && stranger.body.found === false,
  '★ unknown dealRef (not in extraction_results AND not in any pool) → found:false');

// (J3) Multiplicity surfaced via fallback: seed a SECOND analysis whose
// stripped name also normalizes to "sunroad centrum". Expect multipleFound +
// count=2.
seedAnalysis({
  dealRef: 'SUNROAD-REVALIDATION-2',
  extractionId: '7'.repeat(64),
  doctrineId: '8'.repeat(64),
  revisionId: '9'.repeat(64),
  legacyAnalysisId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
  legacyStatus: 'complete',
  legacyName: 'Sunroad Centrum (re-extracted v2)',
  extractionCreatedAt: '2026-06-11T00:00:00Z',
});
memDb.prepare('INSERT INTO loan_in_pool (id, pool_id, deal_ref, originator_loan_ref) VALUES (?, ?, ?, ?)')
  .run('lip-sunroad-multi-uuid', 'pool-bmark-2024-v8-uuid', 'bmark2024v8-sunroad-centrum-multi', 'sunroad centrum');
const multiFallback = call('GET', '/lookup?dealRef=bmark2024v8-sunroad-centrum-multi');
assert(multiFallback.status === 200 && multiFallback.body.found === true,
  'fallback with >1 name-matching analyses → found:true');
assert(multiFallback.body.multipleFound === true,
  '★ multipleFound surfaces via fallback (route layer adds the flag when count > 1)');
assert(multiFallback.body.count === 2,
  '★ count === 2 — both Sunroad analyses surfaced');

// (J4) THE PRESERVATION ASSERTION: re-call §A's exact path. Must STILL hit
// Pass 1 (not be intercepted by Pass 2) and return the canonical single hit.
console.log('\n--- J4. ★ Pass 1 behavior UNCHANGED for exact matches ---');
const reA = call('GET', '/lookup?dealRef=SUNROAD-CENTRUM-REAL');
assert(reA.status === 200 && reA.body.found === true,
  '★ Pass 1 (exact deal_ref) still wins — found:true');
assert(reA.body.analysisId === 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  '★ exact match returns the same single analysisId as before — no fallback intermixing');
assert(reA.body.multipleFound === undefined,
  '★ exact path: no multipleFound (Pass 2 has 2 candidates, but Pass 1 exits before Pass 2 runs)');

console.log('\n================================================================');
if (failures === 0) {
  console.log('Funnel PR — lookup route: PASS — exact + fallback + precedence + multiplicity all hold.');
  process.exit(0);
} else {
  console.log(`Funnel PR — lookup route: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
