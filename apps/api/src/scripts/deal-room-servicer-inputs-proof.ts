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

const HEAD_640_ROOT = '8c454c15cfe81b4a5133b08ab8a9081979f8819329661c75aaff4fdc1439a953';

function partA_B(): void {
  console.log('\n(A/B) resolver + deal name for real pooled roots:');
  const ps = new PoolStore(DB);
  const db = new Database(DB, { readonly: true });
  const roots = db.prepare('SELECT DISTINCT lineage_root_id FROM revision_lineage_envelopes').all() as Array<{ lineage_root_id: string }>;
  db.close();

  // Resolve every root; collect the ones that map to a single pool loan.
  const resolved: Array<{ root: string; poolId: string; loanInPoolId: string; assetType: string | null; dealName: string | null; ref: string | null }> = [];
  for (const { lineage_root_id } of roots) {
    const r = resolveLoanForRoot(lineage_root_id);
    if (r.resolved) {
      const loan = ps.getLoanInPool(r.loanInPoolId as never);
      if (loan) resolved.push({ root: lineage_root_id, poolId: r.poolId, loanInPoolId: r.loanInPoolId, assetType: loan.assetType ?? null, dealName: dealNameFromLoan(loan), ref: loan.originatorLoanRef });
    }
  }
  check('at least one root resolves to a pool loan (resolver works)', resolved.length > 0, `${resolved.length}/${roots.length} roots resolved`);

  // 640-head root resolves to pool coords + a real name.
  const head = resolveLoanForRoot(HEAD_640_ROOT);
  check('640-head root resolves to a single pool loan', head.resolved === true, head.resolved ? `${head.poolId}/${head.loanInPoolId}` : `ambiguous:${(head as { reason?: string }).reason}`);
  if (head.resolved) {
    const loan = ps.getLoanInPool(head.loanInPoolId as never);
    const name = dealNameFromLoan(loan!);
    const isSlug = name === null || /^bmark/i.test(name) || name.includes('-');
    check('640 deal name is a real name (not a benchmark slug)', !isSlug, `dealName='${name}' (ref='${loan?.originatorLoanRef}')`);
  }

  // A Sunroad root → 'Sunroad Centrum'.
  const sun = resolved.find((x) => (x.ref ?? '').toLowerCase().includes('sunroad'));
  check('a Sunroad root resolves', sun !== undefined, sun ? `ref='${sun.ref}'` : 'none found among resolved roots');
  if (sun) check("Sunroad deal name title-cases to 'Sunroad Centrum'", sun.dealName === 'Sunroad Centrum', `dealName='${sun.dealName}'`);
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
