/**
 * Pool layer PR 4 — HTTP-layer acceptance test.
 *
 *   npx tsx apps/api/src/scripts/test-pool-pr4-http.ts
 *
 * Drives the BMARK 2026-V12 v1→v4 walk via the route handlers (mock req/res,
 * matching `test-get-analysis-route.ts`'s convention — NO supertest). Proves:
 *
 *   §A  create pool via POST /api/pools, then v1 via Phase A → Phase B HTTP
 *       calls; assert the review queue appears in Phase A's response.
 *   §B  v2 / v3 / v4: carriers + new + departures via HTTP; assert frozen
 *       tape + dispositionIds in the responses.
 *   §C  ★ RE-KEY through HTTP: v5 tape with re-keyed L4 ref → Phase A response
 *       shows 'unmatched-needs-confirm' + L4 in candidateLoanInPoolIds; Phase B
 *       binds-existing → 201; follow-up GET /api/pools/:id/dispositions shows
 *       NO phantom departure recorded for L4.
 *   §D  ★ FREEZE-BLOCK through HTTP: Phase B with unresolved entry → 422 with
 *       structured error (code + message), NOT 200.
 *   §E  ★ recordedBy provenance: body's actor (if present) is IGNORED; the
 *       persisted disposition's recordedBy comes from req.user.
 *   §F  Reads: pool detail returns currentWorkingTapeId (D3); membership +
 *       loan history + overrides return the expected shape.
 *   §G  Path↔body cross-check: 400 POOL_ID_MISMATCH when workingTapeId
 *       belongs to a different pool.
 *
 * SCOPE BOUNDARY: this is the HTTP layer only. The orchestration semantics
 * are PR3's job (already 47/47); the persistence is PR2 (50/50). PR4 proves
 * the wire shape, error mapping, and recordedBy provenance — nothing else.
 *
 * Uses an in-memory PoolStore (`:memory:`) injected via the route-file's test
 * hook. Never touches cre.db.
 */
import type {
  Disposition,
  LoanInPool,
  LoanInPoolId,
  LoanMembership,
  PendingMembershipEntry,
  Pool,
  Tape,
  TapeId,
  WorkingTapeId,
  WorkingTape,
} from '@cre/contracts';
import { poolRoutes, _setPoolStoreForTests } from '../routes/pool.routes.js';
import { PoolStore } from '../storage/pool-store.js';

/* -------------------------------------------------------------------------- */
/* Mock req/res + dispatcher (same convention as test-get-analysis-route.ts)  */
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

function makeReq(opts: Partial<MockReq> = {}): MockReq {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    path: opts.path ?? opts.url ?? '/',
    body: opts.body,
    query: opts.query ?? {},
    params: opts.params ?? {},
    headers: opts.headers ?? {},
    user: opts.user ?? { userId: 'u-isabelle', email: 'isabelle@example.com', role: 'ANALYST' },
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

/**
 * Walk the Express router stack and dispatch to the matching layer. Supports
 * parameterized paths (`/:poolId/tapes/:tapeId`) by literal-segment matching
 * with param extraction.
 */
function dispatch(req: MockReq, res: MockRes): void {
  type Layer = {
    route?: {
      path?: string;
      methods?: Record<string, boolean>;
      stack?: { handle?: (req: unknown, res: unknown, next: () => void) => void }[];
    };
  };
  const stack = (poolRoutes as unknown as { stack: Layer[] }).stack;
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

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}

function splitPathAndQuery(pathWithQuery: string): { path: string; query: Record<string, string> } {
  const q = pathWithQuery.indexOf('?');
  if (q < 0) return { path: pathWithQuery, query: {} };
  const path = pathWithQuery.slice(0, q);
  const query: Record<string, string> = {};
  for (const pair of pathWithQuery.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
    query[k] = v;
  }
  return { path, query };
}

function call(method: string, pathWithQuery: string, body?: unknown): { status: number; body: any } {
  const { path, query } = splitPathAndQuery(pathWithQuery);
  const req = makeReq({ method, url: pathWithQuery, path, body, query });
  const res = makeRes();
  dispatch(req, res);
  return { status: res.statusCode, body: res.body as any };
}

function callAs(user: AuthPayload | undefined, method: string, pathWithQuery: string, body?: unknown): { status: number; body: any } {
  const { path, query } = splitPathAndQuery(pathWithQuery);
  const req = makeReq({ method, url: pathWithQuery, path, body, query, user });
  const res = makeRes();
  dispatch(req, res);
  return { status: res.statusCode, body: res.body as any };
}

/* -------------------------------------------------------------------------- */
/* Setup — in-memory store injection                                          */
/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('Pool PR 4 — HTTP-layer acceptance test (BMARK 2026-V12, :memory:)');
console.log('================================================================');

const store = new PoolStore(':memory:');
_setPoolStoreForTests(store);

/* -------------------------------------------------------------------------- */
/* §A  — create pool, ingest v1                                              */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. POST /api/pools + v1 Phase A → Phase B ---');
const create = call('POST', '/', {
  shelfName: 'BMARK 2026-V12', vintage: 2026, seller: 'Bedrock Capital',
});
assert(create.status === 201, 'POST /pools → 201');
assert(typeof create.body.pool?.id === 'string', 'response.pool.id is a string');
const POOL_ID = create.body.pool.id as string;

const v1Body = {
  version: 1,
  tapeDate: '2026-01-02T00:00:00Z',
  receivedAt: '2026-01-02T14:00:00Z',
  priorTapeId: null,
  originatorSummary: { originatorLoanCount: 4, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'v1' },
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L003', dealRef: 'deal-L3', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
  ],
};
const v1A = call('POST', `/${POOL_ID}/tapes`, v1Body);
assert(v1A.status === 201, 'v1 POST /:poolId/tapes (Phase A) → 201');
assert(v1A.body.summary.carriedCount === 0 && v1A.body.summary.unmatchedCount === 4,
  'Phase A response carries summary: 0 carried / 4 unmatched');
assert(Array.isArray(v1A.body.pendingMembership) && v1A.body.pendingMembership.length === 4,
  'Phase A response carries pendingMembership (4 entries — the review queue)');
const v1Wt = v1A.body.workingTapeId as string;

const v1B = call('POST', `/${POOL_ID}/tapes/freeze`, {
  workingTapeId: v1Wt,
  resolutions: v1Body.rows.map(r => ({ kind: 'confirm-new', tapePosition: r.tapePosition })),
  departures: [], frozenAt: '2026-01-05T18:00:00Z',
});
assert(v1B.status === 201, 'v1 Phase B → 201');
assert(v1B.body.newLoanInPoolIds?.length === 4, 'v1 Phase B response: 4 newLoanInPoolIds');
const v1TapeId = v1B.body.tape.id as string;
const v1Tape = v1B.body.tape as Tape;
const L1 = v1Tape.membership.find(m => m.dealRef === 'deal-L1')!.loanInPoolId;
const L2 = v1Tape.membership.find(m => m.dealRef === 'deal-L2')!.loanInPoolId;
const L3 = v1Tape.membership.find(m => m.dealRef === 'deal-L3')!.loanInPoolId;
const L7 = v1Tape.membership.find(m => m.dealRef === 'deal-L7')!.loanInPoolId;

/* -------------------------------------------------------------------------- */
/* §B  — v2 / v3 / v4 through HTTP                                            */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. v2 / v3 / v4 HTTP walks ---');
function postPhaseA(body: any): { workingTapeId: string; summary: any; pendingMembership: PendingMembershipEntry[] } {
  const r = call('POST', `/${POOL_ID}/tapes`, body);
  if (r.status !== 201) throw new Error(`Phase A expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
function postPhaseB(body: any): { tape: Tape; newLoanInPoolIds: string[]; dispositionIds: string[] } {
  const r = call('POST', `/${POOL_ID}/tapes/freeze`, body);
  if (r.status !== 201) throw new Error(`Phase B expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// v2
const v2A = postPhaseA({
  version: 2,
  tapeDate: '2026-01-16T00:00:00Z', receivedAt: '2026-01-16T14:00:00Z',
  priorTapeId: v1TapeId, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L003', dealRef: 'deal-L3', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 5 },
  ],
});
assert(v2A.summary.carriedCount === 4 && v2A.summary.unmatchedCount === 1,
  'v2 Phase A: 4 carriers + 1 unmatched (L4)');
const v2B = postPhaseB({
  workingTapeId: v2A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 5 }],
  departures: [], frozenAt: '2026-01-19T18:00:00Z',
});
const L4 = v2B.tape.membership.find(m => m.dealRef === 'deal-L4')!.loanInPoolId;

// v3 — L3 departs (★ override #1 dropped→kicked)
const v3A = postPhaseA({
  version: 3,
  tapeDate: '2026-02-04T00:00:00Z', receivedAt: '2026-02-04T14:00:00Z',
  priorTapeId: v2B.tape.id, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
    { originatorLoanRef: 'BMARK-L005', dealRef: 'deal-L5', propertyName: null, assetType: null, tapePosition: 5 },
  ],
});
const v3B = postPhaseB({
  workingTapeId: v3A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 5 }],
  departures: [{
    loanInPoolId: L3, originatorLabel: 'dropped', buyerLabel: 'kicked',
    reasons: ['DSCR failed at refi floor'], recordedAt: '2026-02-05T11:00:00Z',
  }],
  frozenAt: '2026-02-07T18:00:00Z',
});
const L5 = v3B.tape.membership.find(m => m.dealRef === 'deal-L5')!.loanInPoolId;
assert(v3B.dispositionIds.length === 1, 'v3 Phase B response: 1 disposition');

// v4 — L2, L5, L7 depart (★ overrides #2 + #3 kicked→dropped)
const v4A = postPhaseA({
  version: 4,
  tapeDate: '2026-02-24T00:00:00Z', receivedAt: '2026-02-24T14:00:00Z',
  priorTapeId: v3B.tape.id, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L006', dealRef: 'deal-L6', propertyName: null, assetType: null, tapePosition: 3 },
  ],
});
const v4B = postPhaseB({
  workingTapeId: v4A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 3 }],
  departures: [
    { loanInPoolId: L2, originatorLabel: 'dropped', buyerLabel: 'dropped', reasons: ['benign withdrawal'], recordedAt: '2026-02-25T10:00:00Z' },
    { loanInPoolId: L5, originatorLabel: 'kicked', buyerLabel: 'dropped', reasons: ['no institutional taint'], recordedAt: '2026-02-25T10:30:00Z' },
    { loanInPoolId: L7, originatorLabel: 'kicked', buyerLabel: 'dropped', reasons: ['kick-flag→drop'], recordedAt: '2026-02-25T11:00:00Z' },
  ],
  frozenAt: '2026-02-27T18:00:00Z',
});
const L6 = v4B.tape.membership.find(m => m.dealRef === 'deal-L6')!.loanInPoolId;
assert(v4B.dispositionIds.length === 3, 'v4 Phase B response: 3 dispositions');

/* -------------------------------------------------------------------------- */
/* §C  — RE-KEY through HTTP                                                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. ★ RE-KEY through HTTP ---');
const dispositionsBeforeRekey = call('GET', `/${POOL_ID}/dispositions`);
const v5A = postPhaseA({
  version: 5,
  tapeDate: '2026-03-12T00:00:00Z', receivedAt: '2026-03-12T14:00:00Z',
  priorTapeId: v4B.tape.id, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001',    dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L004-RE', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L006',    dealRef: 'deal-L6', propertyName: null, assetType: null, tapePosition: 3 },
  ],
});
const rekeyEntry = v5A.pendingMembership.find(e => e.kind === 'unmatched-needs-confirm') as
  Extract<PendingMembershipEntry, { kind: 'unmatched-needs-confirm' }>;
assert(rekeyEntry !== undefined, 'v5 Phase A response: re-key surfaces as unmatched-needs-confirm');
assert(rekeyEntry.incomingOriginatorRef === 'BMARK-L004-RE', 'Phase A response preserves incomingOriginatorRef');
assert(rekeyEntry.candidateLoanInPoolIds.includes(L4),
  '★ Phase A response: candidateLoanInPoolIds includes the real L4');
assert(v5A.summary.unmatchedWithSuggestionsCount === 1, 'summary surfaces 1 unmatched with suggestions');

const v5B = postPhaseB({
  workingTapeId: v5A.workingTapeId,
  resolutions: [{ kind: 'bind-existing', tapePosition: 2, loanInPoolId: L4 }],
  departures: [], frozenAt: '2026-03-15T18:00:00Z',
});
assert(v5B.tape.membership.find((m: LoanMembership) => m.loanInPoolId === L4) !== undefined,
  '★ HTTP: L4 carried with original LoanInPoolId after bind-existing');

// ★ Follow-up GET: dispositions count UNCHANGED — no phantom departure recorded.
const dispositionsAfterRekey = call('GET', `/${POOL_ID}/dispositions`);
assert(dispositionsAfterRekey.body.dispositions.length === dispositionsBeforeRekey.body.dispositions.length,
  '★ GET /dispositions: no phantom departure recorded for L4 (count unchanged before/after re-key)');

/* -------------------------------------------------------------------------- */
/* §D  — FREEZE-BLOCK through HTTP                                            */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. ★ FREEZE-BLOCK through HTTP ---');
// Fresh pool for a clean unmatched scenario.
const otherPool = call('POST', '/', { shelfName: 'BLOCK-TEST', vintage: 2026, seller: null });
const POOL_ID_BLOCK = otherPool.body.pool.id as string;
const blockA = call('POST', `/${POOL_ID_BLOCK}/tapes`, {
  version: 1, tapeDate: '2026-04-01T00:00:00Z', receivedAt: '2026-04-01T14:00:00Z',
  priorTapeId: null, originatorSummary: null,
  rows: [{ originatorLoanRef: 'X-001', dealRef: 'deal-X1', propertyName: null, assetType: null, tapePosition: 1 }],
});
assert(blockA.status === 201, 'block pool v1 Phase A → 201');
const blockB = call('POST', `/${POOL_ID_BLOCK}/tapes/freeze`, {
  workingTapeId: blockA.body.workingTapeId,
  resolutions: [], // ★ EMPTY — unmatched-needs-confirm entry at position 1
  departures: [], frozenAt: '2026-04-05T18:00:00Z',
});
assert(blockB.status === 422, '★ freeze-block → 422 (NOT 200, NOT silently dropped)');
assert(blockB.body.error === 'ADVANCE_TAPE_PRECONDITION',
  '★ structured error code ADVANCE_TAPE_PRECONDITION');
assert(typeof blockB.body.message === 'string' && blockB.body.message.length > 0,
  '★ message non-empty — the UI can render "resolve N entries before freezing"');

/* -------------------------------------------------------------------------- */
/* §E  — recordedBy provenance: req.user, NEVER the body                      */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. ★ recordedBy provenance (req.user, never body) ---');
// Fresh pool, get to a departure scenario.
const proP = call('POST', '/', { shelfName: 'PROV-TEST', vintage: 2026, seller: null });
const POOL_ID_PROV = proP.body.pool.id as string;
const proAV1 = call('POST', `/${POOL_ID_PROV}/tapes`, {
  version: 1, tapeDate: '2026-05-01T00:00:00Z', receivedAt: '2026-05-01T14:00:00Z', priorTapeId: null, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'P-001', dealRef: 'deal-P1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'P-002', dealRef: 'deal-P2', propertyName: null, assetType: null, tapePosition: 2 },
  ],
});
const proBV1 = callAs({ userId: 'u-CREATOR', email: 'creator@example.com', role: 'ANALYST' },
  'POST', `/${POOL_ID_PROV}/tapes/freeze`, {
  workingTapeId: proAV1.body.workingTapeId,
  resolutions: proAV1.body.pendingMembership.map((e: any) => ({ kind: 'confirm-new', tapePosition: e.tapePosition })),
  departures: [], frozenAt: '2026-05-03T18:00:00Z',
});
const Lp1 = proBV1.body.tape.membership.find((m: LoanMembership) => m.dealRef === 'deal-P1').loanInPoolId;
// v2 with departure — tamper recordedBy in the body (server must IGNORE).
const proAV2 = call('POST', `/${POOL_ID_PROV}/tapes`, {
  version: 2, tapeDate: '2026-05-10T00:00:00Z', receivedAt: '2026-05-10T14:00:00Z',
  priorTapeId: proBV1.body.tape.id, originatorSummary: null,
  rows: [{ originatorLoanRef: 'P-002', dealRef: 'deal-P2', propertyName: null, assetType: null, tapePosition: 1 }],
});
const proBV2 = callAs({ userId: 'u-AUTH-RECORDER', email: 'recorder@example.com', role: 'ANALYST' },
  'POST', `/${POOL_ID_PROV}/tapes/freeze`, {
  workingTapeId: proAV2.body.workingTapeId,
  resolutions: [],
  departures: [{
    loanInPoolId: Lp1, originatorLabel: 'dropped', buyerLabel: 'dropped',
    reasons: ['departure for provenance test'], recordedAt: '2026-05-11T11:00:00Z',
  }],
  // Tamper: try to set recordedBy in the body — server must NOT consult this.
  recordedBy: { userId: 'u-IMPERSONATOR', displayName: 'attacker@evil.com' },
  frozenAt: '2026-05-13T18:00:00Z',
});
assert(proBV2.status === 201, 'prov v2 freeze → 201');
const disps = call('GET', `/${POOL_ID_PROV}/dispositions`).body.dispositions as Disposition[];
const persisted = disps.find(d => d.loanInPoolId === Lp1);
assert(persisted !== undefined, 'departed loan has a persisted disposition');
assert(persisted!.recordedBy.userId === 'u-AUTH-RECORDER',
  '★ persisted recordedBy.userId === req.user.userId (auth-recorder), NOT body actor (impersonator)');
assert(persisted!.recordedBy.displayName === 'recorder@example.com',
  '★ persisted recordedBy.displayName === req.user.email, NOT body actor');

/* -------------------------------------------------------------------------- */
/* §F  — Reads                                                               */
/* -------------------------------------------------------------------------- */
console.log('\n--- F. Reads ---');
const detail = call('GET', `/${POOL_ID}`);
assert(detail.status === 200, 'GET /:poolId → 200');
assert(detail.body.pool.id === POOL_ID, 'detail response carries pool with correct id');
assert(detail.body.currentWorkingTapeId === null,
  'D3 derivation: currentWorkingTapeId === null (no open WT after v5 freeze)');

const membership = call('GET', `/${POOL_ID}/tapes/${v4B.tape.id}/membership`);
assert(membership.status === 200 && Array.isArray(membership.body.membership), 'GET membership → 200');
assert(membership.body.membership.length === 3, 'v4 membership: 3 rows');

const history = call('GET', `/${POOL_ID}/loans/${L1}/history`);
assert(history.status === 200, 'GET loan history → 200');
assert(history.body.history.length === 5, 'L1 history: 5 rows (v1, v2, v3, v4, v5)');

const overrides = call('GET', `/${POOL_ID}/overrides`);
assert(overrides.status === 200, 'GET /overrides → 200');
assert(overrides.body.overrides.length === 3, '3 overrides recorded (matches PR3 walk)');
const overrideDirections = (overrides.body.overrides as Disposition[]).map(d => `${d.originatorLabel}->${d.buyerLabel}`);
assert(overrideDirections.includes('dropped->kicked'), 'override: drop->kick present');
assert(overrideDirections.filter(s => s === 'kicked->dropped').length === 2,
  'override: TWO kick->drop present (both directions)');

const list = call('GET', '/?vintage=2026');
assert(list.status === 200 && Array.isArray(list.body?.pools), 'GET / (list) → 200');
assert((list.body?.pools?.length ?? 0) >= 3, 'list returns ≥ 3 pools (BMARK + block + prov)');

const notFound = call('GET', `/${POOL_ID}/tapes/${'f'.repeat(64)}`);
assert(notFound.status === 404, 'GET unknown tape → 404');
assert(notFound.body.error === 'NOT_FOUND', '404 carries structured error code');

/* -------------------------------------------------------------------------- */
/* §G  — Path↔body cross-check (E2a refusal)                                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- G. ★ Path↔body cross-check (POOL_ID_MISMATCH) ---');
// Open a working tape on POOL_ID_PROV so we have a known WT id.
const proAV3 = call('POST', `/${POOL_ID_PROV}/tapes`, {
  version: 3, tapeDate: '2026-06-01T00:00:00Z', receivedAt: '2026-06-01T14:00:00Z',
  priorTapeId: proBV2.body.tape.id, originatorSummary: null,
  rows: [{ originatorLoanRef: 'P-NEW', dealRef: 'deal-PNEW', propertyName: null, assetType: null, tapePosition: 1 }],
});
const provWtId = proAV3.body.workingTapeId as string;
// Try to freeze it through a DIFFERENT pool's path:
const mismatch = call('POST', `/${POOL_ID}/tapes/freeze`, {
  workingTapeId: provWtId,
  resolutions: [], departures: [], frozenAt: '2026-06-05T18:00:00Z',
});
assert(mismatch.status === 400, '★ mis-routed workingTapeId → 400 (NOT 201 — would advance wrong pool)');
assert(mismatch.body.error === 'POOL_ID_MISMATCH', '★ structured error code POOL_ID_MISMATCH');

/* -------------------------------------------------------------------------- */
/* §H  — Final                                                                */
/* -------------------------------------------------------------------------- */
console.log('\n--- H. Final assertions ---');
const finalDisps = call('GET', `/${POOL_ID}/dispositions`).body.dispositions as Disposition[];
const finalOverrides = call('GET', `/${POOL_ID}/overrides`).body.overrides as Disposition[];
assert(finalDisps.length === 4, 'BMARK pool: 4 dispositions (matches PR3 walk)');
assert(finalOverrides.length === 3, 'BMARK pool: 3 overrides (matches PR3 walk)');
for (const d of finalOverrides) {
  assert(d.authoritative === d.buyerLabel,
    `disposition ${d.id.slice(0, 8)}…: authoritative === buyerLabel (P4) preserved through HTTP`);
  assert(d.override === (d.originatorLabel !== d.buyerLabel),
    `disposition ${d.id.slice(0, 8)}…: override flag matches labels-differ (P5) preserved through HTTP`);
}

store.close();
console.log('\n================================================================');
if (failures === 0) {
  console.log('PR 4 — HTTP-layer acceptance: PASS — wire shape + error mapping + provenance all hold.');
  process.exit(0);
} else {
  console.log(`PR 4 — HTTP-layer acceptance: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}

// Silence unused-import warnings (these types are used via inference above).
void (null as unknown as Pool | LoanInPool | WorkingTape | WorkingTapeId | TapeId | LoanInPoolId | null);
