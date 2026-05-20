// Tests for the Phase 4 workflow API endpoints.
//
//   npm run test:workflow-api
//
// Verifies:
//   - POST /committee-actions: shape validation, permission gating, chain stitching
//     (server sets previousActionId), persistence, response shape
//   - GET /workflow-state: delegates to computeDealWorkflowState; returns the projection
//   - GET /committee-timeline: delegates to buildCommitteeTimeline
//   - GET /audit-replay: delegates to rebuildAuditChain; serializes Map to plain object
//   - Permission enforcement: ANALYST can submit, COMMITTEE_MEMBER can approve, etc.
//
// Mechanism: invoke each handler directly with mock Request / Response. No HTTP
// server. The express middleware factories work fine on POJOs that quack like
// Request / Response. This avoids new dependencies and keeps the test fast.

import { RENDER_VERSION } from '@cre/contracts';
import type {
  AuditEvent,
  CommitteeActionEvent,
  DealWorkflowState,
  DoctrineEvaluationId,
  OverlayId,
  RenderedAnalysisId,
  RenderVersion,
} from '@cre/contracts';
import { workflowRoutes } from '../routes/workflow.routes.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { computeAuditEventId } from '../util/content-hash.js';

// AuthPayload is declared in apps/api auth middleware as a global Express
// extension. The mock req/res don't go through real middleware; we declare a
// local shape that matches the AuthPayload contract for type safety.
interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}
void RENDER_VERSION;

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

const ROOT_ID = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED_ID = 'b'.repeat(64) as RenderedAnalysisId;

/* --------------------------- mock req/res ------------------------------ */

interface MockRes {
  statusCode: number;
  body: unknown;
  locals: { observability?: { cacheHit?: boolean; renderVersion?: string } };
  finishCallbacks: Array<() => void>;
  headersSent: boolean;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  on(_event: 'finish', cb: () => void): void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    locals: {},
    finishCallbacks: [],
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    on(_event, cb) { this.finishCallbacks.push(cb); },
  };
  return res;
}

interface MockReq {
  method: string;
  url: string;
  path: string;
  body?: unknown;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  user?: AuthPayload;
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

// Walk the express router stack and find the handler chain matching method + path.
// Then invoke them in sequence as a single-threaded synchronous chain.
function dispatch(req: MockReq, res: MockRes): void {
  const stack = (workflowRoutes as unknown as { stack: unknown[] }).stack;
  // express stores routes as { route: { path, methods: { post: true, ... }, stack: [{ handle }, ...] } }
  for (const layer of stack) {
    const route = (layer as { route?: { path?: string; methods?: Record<string, boolean>; stack?: unknown[] } }).route;
    if (!route) continue;
    if (route.path !== req.path) continue;
    const method = req.method.toLowerCase();
    if (!route.methods?.[method]) continue;
    const handlers = route.stack ?? [];
    runChain(req, res, handlers, 0);
    return;
  }
  res.status(404).json({ error: 'NO_MATCH' });
}

function runChain(req: MockReq, res: MockRes, handlers: unknown[], i: number): void {
  if (i >= handlers.length) return;
  const layer = handlers[i] as { handle?: ((req: unknown, res: unknown, next: () => void) => void) & { name?: string } };
  const handle = layer.handle;
  if (!handle) return;
  // Skip the real requireAuth middleware when the test has already populated
  // req.user. This isolates the workflow-API tests from JWT plumbing; the
  // unauthenticated case (no req.user) is still exercised by leaving req.user
  // undefined on the mock.
  if (handle.name === 'requireAuth' && req.user !== undefined) {
    runChain(req, res, handlers, i + 1);
    return;
  }
  handle(req as never, res as never, () => {
    runChain(req, res, handlers, i + 1);
  });
}

/* ------------------------- helper: insert action --------------------- */

function makeAuth(role: string, email: string = 'user@example.com'): AuthPayload {
  return { userId: 'u-' + email, email, role };
}

/* --------------------------------- run --------------------------------- */

console.log('POST /committee-actions: requires authentication');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    body: {},
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 401, 'unauthenticated -> 401');
}

console.log('\nPOST /committee-actions: rejects malformed body');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    body: {},
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'missing rootId -> 400');
}

console.log('\nPOST /committee-actions: ANALYST can SUBMIT_TO_COMMITTEE');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('ANALYST', 'analyst@example.com'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'SUBMIT_TO_COMMITTEE',
      payload: {
        kind: 'SUBMIT_TO_COMMITTEE',
        committeeName: 'Q2-CRE',
        summary: 'first submit',
      },
      occurredAt: '2026-05-09T10:00:00Z',
    },
  });
  const res = makeRes();
  dispatch(req, res);

  assertEqual(res.statusCode, 201, 'returns 201 Created');
  const body = res.body as { action?: CommitteeActionEvent };
  assert(body.action !== undefined, 'response includes action');
  if (body.action) {
    assertEqual(body.action.kind, 'SUBMIT_TO_COMMITTEE', 'action.kind matches');
    assertEqual(body.action.author, 'analyst@example.com', 'author derived from req.user.email');
    assertEqual(body.action.previousActionId, null, 'first action has previousActionId=null');
    assert(/^[0-9a-f]{64}$/.test(body.action.id), 'id is 64-char content hash');
  }
}

console.log('\nPOST /committee-actions: ANALYST CANNOT approve (permission denied)');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('ANALYST'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'APPROVE_DEAL',
      payload: { kind: 'APPROVE_DEAL', conditions: [] },
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 403, 'ANALYST cannot approve -> 403');
  const body = res.body as { error?: string; required?: string };
  assertEqual(body.error, 'PERMISSION_DENIED', 'error code = PERMISSION_DENIED');
  assertEqual(body.required, 'workflow:approve', 'reports the required permission');
}

console.log('\nPOST /committee-actions: COMMITTEE_MEMBER can APPROVE_DEAL');
{
  // First, ensure there's a prior SUBMIT in the chain (already inserted above)
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('COMMITTEE_MEMBER', 'chair@example.com'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'APPROVE_DEAL',
      payload: { kind: 'APPROVE_DEAL', conditions: ['ltv-cap'] },
      occurredAt: '2026-05-09T11:00:00Z',
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 201, 'COMMITTEE_MEMBER can approve -> 201');
  const body = res.body as { action?: CommitteeActionEvent };
  if (body.action) {
    assertEqual(body.action.kind, 'APPROVE_DEAL', 'action.kind matches');
    assert(body.action.previousActionId !== null,
      'second action has previousActionId pointing to chain tail');
  }
}

console.log('\nGET /workflow-state: requires workflow:read permission');
{
  const req = makeReq({
    method: 'GET',
    path: '/workflow-state',
    query: { rootId: ROOT_ID as string },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 401, 'unauthenticated -> 401');
}

console.log('\nGET /workflow-state: returns DealWorkflowState (after submit + approve above)');
{
  const req = makeReq({
    method: 'GET',
    path: '/workflow-state',
    query: { rootId: ROOT_ID as string },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 200, 'returns 200');
  const body = res.body as DealWorkflowState;
  assertEqual(body.state, 'APPROVED', 'state derived as APPROVED (last action was APPROVE)');
  assertEqual(body.rootId, ROOT_ID, 'rootId echoed');
  assert(body.activeParticipants.length >= 2, 'at least 2 participants (analyst + chair)');
  assertEqual(body.lastActionAt, '2026-05-09T11:00:00Z', 'lastActionAt is the approve timestamp');
}

console.log('\nGET /workflow-state: missing rootId -> 400');
{
  const req = makeReq({
    method: 'GET',
    path: '/workflow-state',
    query: {},
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'missing rootId -> 400');
}

console.log('\nGET /committee-timeline: returns chronological merge');
{
  const req = makeReq({
    method: 'GET',
    path: '/committee-timeline',
    query: { rootId: ROOT_ID as string },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 200, 'returns 200');
  const body = res.body as { rootId?: string; entries?: unknown[] };
  assertEqual(body.rootId, ROOT_ID, 'rootId echoed');
  assert(Array.isArray(body.entries), 'entries is array');
  assert((body.entries?.length ?? 0) >= 2, 'has at least 2 entries (submit + approve)');
}

console.log('\nGET /audit-replay: returns chains object (Map serialized)');
{
  const req = makeReq({
    method: 'GET',
    path: '/audit-replay',
    query: { rootId: ROOT_ID as string },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 200, 'returns 200');
  const body = res.body as { rootId?: string; chains?: Record<string, unknown> };
  assertEqual(body.rootId, ROOT_ID, 'rootId echoed');
  assert(body.chains !== undefined, 'chains object present');
  assert(typeof body.chains === 'object', 'chains serialized as plain object (not Map)');
}

console.log('\nObservability: POST /committee-actions sets res.locals.observability');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('CREDIT_OFFICER'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'REQUEST_MORE_INFO',
      payload: { kind: 'REQUEST_MORE_INFO', questions: ['q1?'] },
    },
  });
  const res = makeRes();
  dispatch(req, res);
  if (res.statusCode === 201) {
    assert(res.locals.observability !== undefined, 'observability locals populated');
    assertEqual(res.locals.observability?.renderVersion, 'committee-action:REQUEST_MORE_INFO',
      'observability tags the action kind');
  } else {
    fail('REQUEST_MORE_INFO failed unexpectedly: status ' + res.statusCode);
  }
}

/* ----------------------- OVERRIDE_DECISION gating --------------------- */
//
// Server-side gating spec (workflow.routes.ts):
//   - body.kind === 'OVERRIDE_DECISION' triggers the override branch
//   - body.overlayId required; missing -> 400 BAD_REQUEST
//   - overlay must exist (overlay-created audit event present); else 400 OVERLAY_NOT_FOUND
//   - body.renderedAnalysisId must equal binding.renderedAnalysisId; else 400 OVERLAY_BINDING_MISMATCH
//   - On success the server constructs the OverrideDecisionPayload itself (the
//     client sends NO payload). Permission is workflow:override (CREDIT_OFFICER+).

console.log('\nPOST /committee-actions OVERRIDE: missing overlayId -> 400');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('CREDIT_OFFICER'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'OVERRIDE_DECISION',
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'missing overlayId -> 400');
  const body = res.body as { error?: string };
  assertEqual(body.error, 'BAD_REQUEST', 'error code = BAD_REQUEST');
}

console.log('\nPOST /committee-actions OVERRIDE: COMMITTEE_MEMBER cannot override (permission denied)');
{
  // Per ROLE_PERMISSIONS, COMMITTEE_MEMBER lacks 'workflow:override'. ANALYST and
  // CREDIT_OFFICER both have it (the matrix grants override to whoever can author
  // an overlay). This test confirms the boundary check fires before any overlay
  // lookup happens.
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('COMMITTEE_MEMBER'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'OVERRIDE_DECISION',
      overlayId: 'overlay-xyz',
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 403, 'COMMITTEE_MEMBER cannot override -> 403');
  const body = res.body as { required?: string };
  assertEqual(body.required, 'workflow:override', 'reports the required permission');
}

console.log('\nPOST /committee-actions OVERRIDE: unknown overlayId -> 400 OVERLAY_NOT_FOUND');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('CREDIT_OFFICER'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'OVERRIDE_DECISION',
      overlayId: 'overlay-does-not-exist',
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'unknown overlayId -> 400');
  const body = res.body as { error?: string };
  assertEqual(body.error, 'OVERLAY_NOT_FOUND', 'error code = OVERLAY_NOT_FOUND');
}

// Seed an overlay-created audit event so the next two tests have a real binding
// to look up. The route's auditStore singleton opens the same default sqlite db,
// so we open another handle to the same file and insert directly.
const seededOverlayId = 'overlay-test-1' as OverlayId;
const seededRenderVersion = RENDER_VERSION as RenderVersion;
{
  const seedStore = new AuditEventsStore();
  const eventBody = {
    previousEventId: null,
    overlayId: seededOverlayId,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: RENDERED_ID,
      renderVersion: seededRenderVersion,
    },
    author: 'analyst@example.com',
    occurredAt: '2026-05-09T09:00:00Z',
  };
  const event: AuditEvent = { id: computeAuditEventId(eventBody), ...eventBody };
  seedStore.insert(event, { rootId: ROOT_ID, renderVersion: seededRenderVersion });
  seedStore.close();
}

console.log('\nPOST /committee-actions OVERRIDE: renderedAnalysisId mismatch -> 400');
{
  const wrongRenderedId = 'c'.repeat(64) as RenderedAnalysisId;
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('CREDIT_OFFICER'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: wrongRenderedId,
      kind: 'OVERRIDE_DECISION',
      overlayId: seededOverlayId,
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 400, 'binding mismatch -> 400');
  const body = res.body as { error?: string };
  assertEqual(body.error, 'OVERLAY_BINDING_MISMATCH', 'error code = OVERLAY_BINDING_MISMATCH');
}

console.log('\nPOST /committee-actions OVERRIDE: valid request - server constructs payload');
{
  const req = makeReq({
    method: 'POST',
    path: '/committee-actions',
    user: makeAuth('CREDIT_OFFICER', 'co@example.com'),
    body: {
      rootId: ROOT_ID,
      renderedAnalysisId: RENDERED_ID,
      kind: 'OVERRIDE_DECISION',
      overlayId: seededOverlayId,
    },
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 201, 'override accepted -> 201');
  const body = res.body as { action?: CommitteeActionEvent };
  if (body.action) {
    assertEqual(body.action.kind, 'OVERRIDE_DECISION', 'action.kind = OVERRIDE_DECISION');
    assertEqual(body.action.author, 'co@example.com', 'author derived from req.user.email');
    const p = body.action.payload as { kind: string; overlayId?: string; summary?: string };
    assertEqual(p.kind, 'OVERRIDE_DECISION', 'server constructed payload.kind');
    assertEqual(p.overlayId, seededOverlayId, 'server populated payload.overlayId');
    assert(typeof p.summary === 'string' && p.summary.length > 0,
      'server populated payload.summary');
  } else {
    fail('valid override returned no action body');
  }
}

console.log('\nGET /workflow-state after OVERRIDE_DECISION: state derives from prior non-override action');
{
  // OVERRIDE_DECISION is non-state-changing per compute-deal-workflow-state.ts:
  // walking the chain backward skips OVERRIDE entries until a state-bearing kind
  // is found. The chain so far is:
  //   SUBMIT (analyst) -> APPROVE (chair) -> REQUEST_MORE_INFO (CREDIT_OFFICER) -> OVERRIDE (CREDIT_OFFICER)
  // Walking backward: OVERRIDE skipped -> REQUEST_MORE_INFO -> 'IN_REVIEW'.
  // Critically, the override did NOT mutate workflow state directly; the state
  // is derived from the chain projection.
  const req = makeReq({
    method: 'GET',
    path: '/workflow-state',
    query: { rootId: ROOT_ID as string },
    user: makeAuth('ANALYST'),
  });
  const res = makeRes();
  dispatch(req, res);
  assertEqual(res.statusCode, 200, 'returns 200');
  const body = res.body as DealWorkflowState;
  assertEqual(body.state, 'IN_REVIEW', 'state derived from prior non-override action (REQUEST_MORE_INFO)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
