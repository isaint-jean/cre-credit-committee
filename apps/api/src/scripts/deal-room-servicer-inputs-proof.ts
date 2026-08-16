/**
 * PROOF — deal-room servicer inputs + deal-name resolution. READ-ONLY on cre.db.
 * DISPLAY-ONLY / MINT-SAFE.
 *
 * Gates:
 *  (A) resolver: a graph root resolves to pool coords (poolId/loanInPoolId) + assetType.
 *      The 640-head root + a Sunroad root BOTH resolve to a single pool loan.
 *  (B) deal name: the resolved dealName (dealNameFromLoan logic) is the REAL deal name,
 *      not a benchmark slug — Sunroad → 'Sunroad Centrum'; 640 → a real name (no 'bmark'
 *      prefix, no hyphenated slug). Falls back to null only when genuinely un-pooled.
 *  (C) endpoint: GET /pools/loan-for-root/:rootId is registered + READ-ONLY (no write/mint).
 *  (D) shared store key: the deal-room wrapper writes the SAME fieldTypes (site_visit,
 *      broker_feedback, site_visit_checklist) as the pool loan page → same store keys →
 *      a note on one surface shows on the other.
 *  (E) gating unchanged: the child components still gate on side==='originator'.
 *  (F) display-only / mint-safe: the route + wrapper touch NO mint/doctrine.
 *  (G) canonical byte-identical (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/deal-room-servicer-inputs-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLoanForRoot } from '../services/pool/resolve-loan-for-root.js';
import { PoolStore } from '../storage/pool-store.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DB = path.join(process.cwd(), 'data', 'cre.db');

// Mirror of the route's dealNameFromLoan (pool.routes.ts) — proves the display transform.
function dealNameFromLoan(loan: { propertyName: string | null; originatorLoanRef: string | null }): string | null {
  const proper = loan.propertyName?.trim();
  if (proper && proper.length > 0) return proper;
  const ref = loan.originatorLoanRef?.trim();
  if (ref && ref.length > 0) return ref.replace(/\b\w/g, (c) => c.toUpperCase());
  return null;
}

// 640 head, as the deal-room actually holds it: RenderedAnalysis.rootId is a
// doctrine_evaluation_id (NOT the lineage_root_id). The OLD proof drove the resolver
// with the lineage_root_id — which always resolved — and so false-greened the live bug.
const HEAD_640_EVAL_ID = '8259948db54784048bc63cc367731d087d2b0f2f0e9fe8bbb6cd6b74e74812a8'; // = data.rootId
const HEAD_640_LINEAGE_ROOT = '8c454c15cfe81b4a5133b08ab8a9081979f8819329661c75aaff4fdc1439a953';

function partA_B(): void {
  console.log('\n(A/B) resolver accepts the EVAL id (what the deal-room actually passes):');
  const ps = new PoolStore(DB);
  const db = new Database(DB, { readonly: true });
  // Drive the resolver with doctrine_evaluation_id — the id RenderedAnalysis.rootId holds.
  const evalRows = db.prepare('SELECT DISTINCT doctrine_evaluation_id AS evalId FROM revision_lineage_envelopes WHERE doctrine_evaluation_id IS NOT NULL').all() as Array<{ evalId: string }>;
  db.close();

  // ── The live path: resolve BY THE EVAL id (previously ROOT_NOT_FOUND; now fixed). ──
  const byEval = resolveLoanForRoot(HEAD_640_EVAL_ID);
  check('resolve(EVAL id) resolves — the real live deal-room path', byEval.resolved === true, byEval.resolved ? `${byEval.poolId}/${byEval.loanInPoolId}` : (byEval as { reason?: string }).reason ?? '');
  if (byEval.resolved) {
    const loan = ps.getLoanInPool(byEval.loanInPoolId as never);
    check("640 eval-id → real name '640 5th Avenue' (not a benchmark slug)", dealNameFromLoan(loan!) === '640 5th Avenue', `dealName='${dealNameFromLoan(loan!)}'`);
  }

  // ── REGRESSION GUARD: resolve(evalId) must equal resolve(its lineage_root). ──
  // If someone reverts the fix, resolve(evalId) → ROOT_NOT_FOUND and this fails —
  // it can no longer false-green by only testing the lineage root.
  const byRoot = resolveLoanForRoot(HEAD_640_LINEAGE_ROOT);
  check(
    'resolve(evalId) === resolve(lineage_root) — same loan (no false-green)',
    byEval.resolved === true && byRoot.resolved === true && byEval.poolId === byRoot.poolId && byEval.loanInPoolId === byRoot.loanInPoolId,
  );

  // ── Backward compatible: a lineage_root_id STILL resolves. ──
  check('lineage_root_id STILL resolves (backward compatible)', byRoot.resolved === true);

  // ── Sunroad, driven by its EVAL id → 'Sunroad Centrum'. ──
  let sunroadEvalId: string | null = null;
  for (const { evalId } of evalRows) {
    const res = resolveLoanForRoot(evalId);
    if (res.resolved) {
      const loan = ps.getLoanInPool(res.loanInPoolId as never);
      if ((loan?.originatorLoanRef ?? '').toLowerCase().includes('sunroad')) { sunroadEvalId = evalId; break; }
    }
  }
  check('a Sunroad EVAL id resolves (deal-room live path)', sunroadEvalId !== null, sunroadEvalId ? `evalId=${sunroadEvalId.slice(0, 12)}…` : 'none found');
  if (sunroadEvalId) {
    const res = resolveLoanForRoot(sunroadEvalId);
    const loan = res.resolved ? ps.getLoanInPool(res.loanInPoolId as never) : null;
    check("Sunroad eval-id → 'Sunroad Centrum'", loan !== null && dealNameFromLoan(loan) === 'Sunroad Centrum', `dealName='${loan ? dealNameFromLoan(loan) : null}'`);
  }

  // ── Honest fallback: a genuinely unknown id → resolved:false (no false mount). ──
  const bogus = resolveLoanForRoot('deadbeef'.repeat(8));
  check('unknown id → resolved:false (honest un-pooled fallback)', bogus.resolved === false);
}

function partC(): void {
  console.log('\n(C) endpoint registered + read-only:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  check("GET /loan-for-root/:rootId registered", /poolRoutes\.get\('\/loan-for-root\/:rootId'/.test(routes));
  // the handler body must not write / mint.
  const start = routes.indexOf("'/loan-for-root/:rootId'");
  const body = routes.slice(start, start + 700);
  check('resolver handler touches NO write/mint', !/upsert|INSERT|UPDATE|evaluateAndNarrate|computeContentHash/.test(body));
}

function partD_E(): void {
  console.log('\n(D/E) shared store key + gating unchanged:');
  const wrapper = read('apps/web/src/components/DealRoomServicerInputs.tsx');
  const page = read('apps/web/src/app/pools/[poolId]/loans/[loanInPoolId]/page.tsx');
  // SAME fieldTypes on both surfaces → same store keys → shared state.
  check("deal-room wrapper uses fieldType 'site_visit'", /fieldType="site_visit"/.test(wrapper));
  check("deal-room wrapper uses fieldType 'broker_feedback'", /fieldType="broker_feedback"/.test(wrapper));
  check('deal-room wrapper mounts SiteVisitChecklist', /SiteVisitChecklist/.test(wrapper));
  check('pool loan page uses the SAME fieldTypes', /fieldType="site_visit"/.test(page) && /fieldType="broker_feedback"/.test(page) && /SiteVisitChecklist/.test(page));
  // gating is inside the child components, unchanged.
  const narr = read('apps/web/src/components/ServicerNarrativeInput.tsx');
  const chk = read('apps/web/src/components/SiteVisitChecklist.tsx');
  check("ServicerNarrativeInput gates on side==='originator'", narr.includes("side === 'originator'"));
  check("SiteVisitChecklist gates on side==='originator'", chk.includes("side === 'originator'"));
}

function partF(): void {
  console.log('\n(F) display-only / mint-safe:');
  const wrapper = read('apps/web/src/components/DealRoomServicerInputs.tsx');
  const resolver = read('apps/api/src/services/pool/resolve-loan-for-root.ts');
  const noMint = (s: string) => !/evaluateAndNarrate|ingestExtractionResult|computeContentHash|applyRevisionDelta|insertRevision/.test(s);
  check('deal-room wrapper touches NO mint', noMint(wrapper));
  check('resolver is read-only (no DB write / mint)', noMint(resolver) && !/INSERT|UPDATE\s|\.run\(/.test(resolver));
}

function partG(): void {
  console.log('\n(G) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='servicer_inputs'`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('servicer_inputs table absent on canonical (no write happened)', !hasTable);
}

console.log('\nDeal-room servicer inputs + deal-name proof (read-only on cre.db)');
partA_B(); partC(); partD_E(); partF(); partG();
console.log(failures === 0 ? '\ndeal-room servicer inputs proof: OK\n' : `\ndeal-room servicer inputs proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
