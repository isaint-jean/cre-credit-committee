/**
 * ★ Route proof — GET /api/analyses/:id/buyer-diff on Sunroad + 640 (read-only,
 * against cre.db). Dispatches the real analysisRoutes handler (resolve → build →
 * project → respond) for BOTH JSON and ?format=html, and asserts the tri-state
 * diff + the visual. No mint, no LLM, nothing written.
 *
 *   cd apps/api && npx tsx src/scripts/proof-buyer-diff-route.ts
 */
import { analysisRoutes } from '../routes/analysis.routes.js';

const DEALS: Record<string, string> = {
  '640': '26027996-5d1c-4a7a-ab72-03f4900a0be0',
  Sunroad: 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00',
};

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

interface Res {
  statusCode: number; body: unknown; html: string | null;
  status(c: number): Res; json(b: unknown): Res; type(t: string): Res; send(b: string): Res;
}
function makeRes(): Res {
  return {
    statusCode: 0, body: undefined, html: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    type() { return this; },
    send(b) { this.html = b; return this; },
  };
}
function dispatch(pathPattern: string, params: Record<string, string>, query: Record<string, unknown>): Res {
  const res = makeRes();
  const req = { method: 'GET', path: pathPattern, params, query, body: undefined, headers: {} };
  const stack = (analysisRoutes as unknown as { stack: Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle?: (rq: unknown, rs: unknown, nx: () => void) => void }> } }> }).stack;
  for (const layer of stack) {
    const route = layer.route;
    if (!route || route.path !== pathPattern || !route.methods?.['get']) continue;
    const run = (i: number): void => {
      const h = (route.stack ?? [])[i]?.handle;
      if (h) h(req as never, res as never, () => run(i + 1));
    };
    run(0);
    return res;
  }
  res.status(404).json({ error: 'NO_MATCH' });
  return res;
}

interface DiffRow { metric: string; state: string; issuer: number | null; ours: number | null; why: unknown[] }

for (const [label, id] of Object.entries(DEALS)) {
  console.log(`\nGET /analyses/${label}/buyer-diff (JSON):`);
  const json = dispatch('/:id/buyer-diff', { id }, {});
  assert(json.statusCode === 200, `200 OK`);
  const body = json.body as { rows?: DiffRow[]; overallAdjustmentBias?: string; dealRef?: string };
  assert(Array.isArray(body.rows) && body.rows.length === 7, `7 metric rows returned`);
  const states = new Set((body.rows ?? []).map((r) => r.state));
  assert(states.has('adjustment'), `has an ADJUSTMENT row`);
  assert(states.has('cant-verify'), `has a CAN'T-VERIFY row (honest)`);
  const noi = (body.rows ?? []).find((r) => r.metric === 'noi');
  assert(noi !== undefined && noi.state === 'adjustment' && noi.why.length > 0, `NOI is an adjustment with a structured why`);

  console.log(`GET /analyses/${label}/buyer-diff?format=html (view):`);
  const html = dispatch('/:id/buyer-diff', { id }, { format: 'html' });
  assert(html.statusCode === 200, `200 OK`);
  const h = html.html ?? '';
  assert(h.includes('row adjustment') && h.includes('row cant-verify'), `view renders tri-state rows`);
  assert(h.includes('show changes') && h.includes('hide-changes'), `view has the show/hide-changes toggle`);
  assert(h.includes("can't verify") && h.includes('insufficient data'), `can't-verify styled distinctly (not agreement)`);
}

console.log(`\n${failed === 0 ? '✓' : '✗'} buyer-diff route: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
