// Tests for the observability layer (post-6.8 telemetry).
//
//   npm run test:observability
//
// Verifies:
//   - Sink receives one request_completed event per request lifecycle
//   - id format classification (legacy / graph / malformed) when :id is present
//   - cacheHit + renderVersion present when handler populates res.locals.observability
//   - cacheHit absent when handler does not populate (e.g., legacy branch, other routes)
//   - latency is a non-negative finite number
//   - Sink errors are SWALLOWED - control flow is unaffected even when sink throws
//   - In-memory ring buffer sink works correctly (test injection mechanism)
//   - emit() is robust to malformed events / sink throws
//   - The middleware does NOT affect req/res - body, headers, status are unchanged
//
// Test mechanism: construct mock req/res objects, invoke the middleware, simulate the
// 'finish' event. No real HTTP server. Lightweight.

import {
  consoleSink,
  emit,
  getSink,
  setSink,
  type ObservabilityEvent,
  type ObservabilitySink,
  type RequestCompletedEvent,
} from '../util/observability.js';
import { observabilityMiddleware } from '../middleware/observability.middleware.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

// ------------------------------ test sink -------------------------------

class RingBufferSink implements ObservabilitySink {
  readonly events: ObservabilityEvent[] = [];
  record(event: ObservabilityEvent): void {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

class ThrowingSink implements ObservabilitySink {
  recordCalled = 0;
  record(_event: ObservabilityEvent): void {
    this.recordCalled++;
    throw new Error('sink failure');
  }
}

// ------------------------------ mock req/res ----------------------------

interface FinishCallback { (): void; }

interface MockReq {
  method: string;
  path: string;
  params: { id?: string };
}

interface MockRes {
  statusCode: number;
  locals: { observability?: { cacheHit?: boolean; renderVersion?: string } };
  finishCallbacks: FinishCallback[];
  on(event: 'finish', cb: FinishCallback): void;
  // simulate end-of-response - fires the finish handlers
  triggerFinish(): void;
}

function makeReq(opts: Partial<MockReq> = {}): MockReq {
  return {
    method: opts.method ?? 'GET',
    path: opts.path ?? '/api/test',
    params: opts.params ?? {},
  };
}

function makeRes(opts: { status?: number } = {}): MockRes {
  const finishCallbacks: FinishCallback[] = [];
  return {
    statusCode: opts.status ?? 200,
    locals: {},
    finishCallbacks,
    on(_event, cb): void { finishCallbacks.push(cb); },
    triggerFinish(): void { for (const cb of finishCallbacks) cb(); },
  };
}

function runMiddleware(req: MockReq, res: MockRes): void {
  let nextCalled = 0;
  observabilityMiddleware(
    req as never,
    res as never,
    () => { nextCalled++; },
  );
  if (nextCalled !== 1) fail('middleware did not call next() exactly once');
}

// --------------------------------- run ---------------------------------

console.log('Sink injection (test infrastructure):');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);
  assert(getSink() === ring, 'setSink swaps the active sink');
  setSink(prev);
  assert(getSink() === consoleSink, 'previous sink restored after swap');
}

console.log('\nRequest lifecycle: middleware emits one event on finish:');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);

  const req = makeReq({ method: 'GET', path: '/api/health' });
  const res = makeRes({ status: 200 });
  runMiddleware(req, res);
  assertEqual(ring.events.length, 0, 'no event before finish');

  res.triggerFinish();
  assertEqual(ring.events.length, 1, 'exactly one event after finish');
  const evt = ring.events[0] as RequestCompletedEvent;
  assertEqual(evt.type, 'request_completed', 'event type === request_completed');
  assertEqual(evt.method, 'GET', 'method recorded');
  assertEqual(evt.path, '/api/health', 'path recorded');
  assertEqual(evt.status, 200, 'status recorded');
  assert(typeof evt.latencyMs === 'number' && evt.latencyMs >= 0 && Number.isFinite(evt.latencyMs),
    'latencyMs is non-negative finite number');

  setSink(prev);
}

console.log('\nID format classification (legacy / graph / malformed) when :id present:');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);

  // legacy uuid
  ring.reset();
  {
    const req = makeReq({ params: { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' } });
    const res = makeRes();
    runMiddleware(req, res);
    res.triggerFinish();
    assertEqual((ring.events[0] as RequestCompletedEvent).idFormat, 'legacy', 'uuid v4 -> idFormat=legacy');
  }

  // content-hash
  ring.reset();
  {
    const req = makeReq({ params: { id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } });
    const res = makeRes();
    runMiddleware(req, res);
    res.triggerFinish();
    assertEqual((ring.events[0] as RequestCompletedEvent).idFormat, 'graph', '64-hex -> idFormat=graph');
  }

  // malformed (uppercase hex)
  ring.reset();
  {
    const req = makeReq({ params: { id: 'A'.repeat(64) } });
    const res = makeRes();
    runMiddleware(req, res);
    res.triggerFinish();
    assertEqual((ring.events[0] as RequestCompletedEvent).idFormat, 'malformed', 'uppercase hex -> idFormat=malformed');
  }

  // no :id param -> idFormat absent
  ring.reset();
  {
    const req = makeReq({ params: {} });
    const res = makeRes();
    runMiddleware(req, res);
    res.triggerFinish();
    assertEqual((ring.events[0] as RequestCompletedEvent).idFormat, undefined, 'no :id -> idFormat absent');
  }

  setSink(prev);
}

console.log('\nres.locals.observability passthrough (cacheHit + renderVersion):');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);

  // Cache miss
  ring.reset();
  {
    const req = makeReq();
    const res = makeRes();
    runMiddleware(req, res);
    res.locals.observability = { cacheHit: false, renderVersion: '6.7' };
    res.triggerFinish();
    const evt = ring.events[0] as RequestCompletedEvent;
    assertEqual(evt.cacheHit, false, 'cacheHit=false propagated');
    assertEqual(evt.renderVersion, '6.7', 'renderVersion propagated');
  }

  // Cache hit
  ring.reset();
  {
    const req = makeReq();
    const res = makeRes();
    runMiddleware(req, res);
    res.locals.observability = { cacheHit: true, renderVersion: '6.7' };
    res.triggerFinish();
    const evt = ring.events[0] as RequestCompletedEvent;
    assertEqual(evt.cacheHit, true, 'cacheHit=true propagated');
    assertEqual(evt.renderVersion, '6.7', 'renderVersion propagated');
  }

  // Locals not populated -> fields absent
  ring.reset();
  {
    const req = makeReq();
    const res = makeRes();
    runMiddleware(req, res);
    res.triggerFinish();
    const evt = ring.events[0] as RequestCompletedEvent;
    assertEqual(evt.cacheHit, undefined, 'cacheHit absent when locals empty');
    assertEqual(evt.renderVersion, undefined, 'renderVersion absent when locals empty');
  }

  setSink(prev);
}

console.log('\nSink isolation (RD4-style determinism for the side channel):');
{
  // Sink throws -> event STILL recorded by the throw, BUT control flow unaffected.
  // Verify by confirming no unhandled exception escapes the emit() call.
  const throwing = new ThrowingSink();
  const prev = setSink(throwing);

  let unhandled = false;
  try {
    emit({
      type: 'request_completed',
      method: 'GET',
      path: '/api/test',
      status: 200,
      latencyMs: 1.5,
    });
  } catch {
    unhandled = true;
  }
  assert(!unhandled, 'emit() does not propagate sink errors');
  assertEqual(throwing.recordCalled, 1, 'sink was called once despite throwing');

  setSink(prev);
}

console.log('\nMiddleware control flow not affected by sink failure:');
{
  const throwing = new ThrowingSink();
  const prev = setSink(throwing);

  const req = makeReq();
  const res = makeRes({ status: 200 });

  let unhandled = false;
  try {
    runMiddleware(req, res);
    res.triggerFinish();
  } catch {
    unhandled = true;
  }
  assert(!unhandled, 'middleware lifecycle survives sink throws');
  // res state is unchanged - middleware never touches body/status
  assertEqual(res.statusCode, 200, 'response status unchanged after middleware');

  setSink(prev);
}

console.log('\nMiddleware does not mutate req/res body:');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);

  const req = makeReq({ method: 'POST', path: '/api/render' });
  const res = makeRes({ status: 200 });
  // Snapshot the pre-middleware state (excluding listener arrays / methods)
  const reqSnapshot = JSON.stringify({ method: req.method, path: req.path, params: req.params });
  const resSnapshotPre = JSON.stringify({ statusCode: res.statusCode, locals: res.locals });

  runMiddleware(req, res);

  const reqAfter = JSON.stringify({ method: req.method, path: req.path, params: req.params });
  const resAfter = JSON.stringify({ statusCode: res.statusCode, locals: res.locals });
  assertEqual(reqAfter, reqSnapshot, 'req fields unchanged by middleware');
  assertEqual(resAfter, resSnapshotPre, 'res fields unchanged by middleware');

  res.triggerFinish();

  const reqFinal = JSON.stringify({ method: req.method, path: req.path, params: req.params });
  assertEqual(reqFinal, reqSnapshot, 'req fields unchanged after finish');

  setSink(prev);
}

console.log('\nMultiple requests share no state through the sink:');
{
  const ring = new RingBufferSink();
  const prev = setSink(ring);

  for (let i = 0; i < 3; i++) {
    const req = makeReq({ path: '/api/req-' + i });
    const res = makeRes({ status: 200 + i });
    runMiddleware(req, res);
    res.triggerFinish();
  }
  assertEqual(ring.events.length, 3, 'three independent events recorded');
  assertEqual((ring.events[0] as RequestCompletedEvent).path, '/api/req-0', 'event 0 path');
  assertEqual((ring.events[2] as RequestCompletedEvent).status, 202, 'event 2 status');

  setSink(prev);
}

// --------------------------------- summary ---------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
