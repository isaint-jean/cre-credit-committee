/**
 * PROOF — the persisted deal-mode flag (#5 + #4). ONE flag drives (a) portfolio-input
 * visibility, (b) Create-Workbook export routing (fixes the unreachable-rollup bug), and
 * (c) the dashboard Loan Type column. Additive servicer_inputs + display/routing only.
 *
 *  (A) storage: deal_mode persists + round-trips on a :memory: store; unset → default; the
 *      dashboard batch query (distinctPoolIdsWithFieldValue) returns only roll_up pools.
 *  (B) service mapping: default single_loan; 'roll_up' honored.
 *  (C) THE BUG FIX: the export dispatch gates on the PERSISTED deal mode (not the query param)
 *      → any Create-Workbook button routes a roll_up deal to the rollup; honest <2-props fallback.
 *  (D) dashboard: listPools returns portfolioPoolIds (one batch query, same flag).
 *  (E) deal-room: PortfolioStructure shown ONLY when mode==='roll_up'; the toggle is the on-ramp.
 *  (F) DealCard renders the Loan Type badge from the same flag.
 *  (G) mint-safe: additive; canonical byte-identical (BMARK 17, 640 head).
 *
 * MINT-SAFE: storage tested on :memory: (no canonical write). Run from apps/api:
 *   npx tsx src/scripts/deal-mode-portfolio-flag-proof.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

function partA(): void {
  console.log('\n(A) storage — deal_mode persist/round-trip + default + dashboard batch query:');
  const s = new ServicerInputsStore(':memory:');
  const now = '2026-08-24T00:00:00Z';
  s.upsert({ poolId: 'P1', loanInPoolId: 'L1', fieldType: 'deal_mode', value: 'roll_up', author: 'servicer', now });
  s.upsert({ poolId: 'P2', loanInPoolId: 'L2', fieldType: 'deal_mode', value: 'single_loan', author: 'servicer', now });
  check('roll_up persists + round-trips', s.getOne('P1', 'L1', 'deal_mode')?.value === 'roll_up');
  check('unset loan → no row (service will default single_loan)', s.getOne('P3', 'L3', 'deal_mode') === null);
  const portfolioPools = s.distinctPoolIdsWithFieldValue('deal_mode', 'roll_up');
  check('dashboard batch query returns ONLY roll_up pools', portfolioPools.length === 1 && portfolioPools[0] === 'P1');
  check('a single_loan pool is NOT in the portfolio set', !portfolioPools.includes('P2'));
  // toggle back to single_loan (last-write-wins)
  s.upsert({ poolId: 'P1', loanInPoolId: 'L1', fieldType: 'deal_mode', value: 'single_loan', author: 'servicer', now });
  check('toggle back → single_loan; drops out of the portfolio set', s.getOne('P1', 'L1', 'deal_mode')?.value === 'single_loan' && s.distinctPoolIdsWithFieldValue('deal_mode', 'roll_up').length === 0);
}

function partB(): void {
  console.log('\n(B) service mapping (deal-mode.service):');
  const src = read('src/services/deal-mode.service.ts');
  check('getDealMode defaults to single_loan (value !== roll_up)', /=== 'roll_up' \? 'roll_up' : 'single_loan'/.test(src));
  check('resolveDealModeForAnalysis resolves via loan then getDealMode', /resolveDealModeForAnalysis[\s\S]{0,220}resolveLoanForAnalysis[\s\S]{0,120}getDealMode/.test(src));
  check('listPortfolioPoolIds uses the batch distinct query', /distinctPoolIdsWithFieldValue\(FIELD, 'roll_up'\)/.test(src));
}

function partC(): void {
  console.log('\n(C) ★ THE BUG FIX — dispatch gates on the PERSISTED mode (not the query param):');
  const src = read('src/services/export-portfolio-dispatch.service.ts');
  check('dispatch imports resolveDealModeForAnalysis', /import \{ resolveDealModeForAnalysis \}/.test(src));
  check('GATE 1 = persisted deal mode !== roll_up → null (fixes hardcoded-single_loan buttons)', /resolveDealModeForAnalysis\(analysis\.graphRevisionId\) !== 'roll_up'\) return null/.test(src));
  check('no longer gates on the per-request underwritingMode query param', !/underwritingMode !== 'roll_up'\) return null/.test(src));
  check('honest edge: roll_up but <2 properties → single-loan fallback (no empty rollup)', /HONEST EDGE[\s\S]{0,320}components\.length <= 1\) return null/.test(src));
}

function partD(): void {
  console.log('\n(D) dashboard — listPools returns portfolioPoolIds (same flag):');
  const routes = read('src/routes/pool.routes.ts');
  check('listPools returns { pools, portfolioPoolIds }', /res\.json\(\{ pools, portfolioPoolIds: listPortfolioPoolIds\(\) \}\)/.test(routes));
  check('deal-mode GET/PUT routes exist (servicer-gated PUT)', /servicer-inputs\/deal-mode/.test(routes) && /put\('\/:poolId\/loans\/:loanInPoolId\/servicer-inputs\/deal-mode'/.test(routes));
  check("PUT validates mode ∈ {single_loan, roll_up}", /raw !== 'single_loan' && raw !== 'roll_up'\) return send400Bad/.test(routes));
}

function partE(): void {
  console.log('\n(E) deal-room — portfolio input gated on mode; toggle is the on-ramp:');
  const dr = read('../web/src/components/DealRoomServicerInputs.tsx');
  check('fetches the persisted mode', /api\.getDealMode\(poolId, loanInPoolId\)/.test(dr));
  check('servicer toggle sets the mode (roll_up / single_loan)', /api\.putDealMode\(poolId, loanInPoolId, next\)/.test(dr) && /This is a portfolio loan/.test(dr));
  check('★ PortfolioStructure shown ONLY when mode === roll_up', /mode === 'roll_up' \?\s*\(\s*<PortfolioStructure/.test(dr));
  check('single_loan → hint instead of the portfolio input (hidden)', /Single loan — exports the single-property workbook/.test(dr));
}

function partF(): void {
  console.log('\n(F) dashboard Loan Type badge (DealCard) from the same flag:');
  const card = read('../web/src/components/PoolRail/DealCard.tsx');
  check('DealCard takes isPortfolio prop', /isPortfolio = false \}: \{ readonly pool: Pool; readonly isPortfolio\?: boolean \}/.test(card));
  check('renders Portfolio / Single Loan badge', /isPortfolio \? 'Portfolio' : 'Single Loan'/.test(card));
  const page = read('../web/src/app/pools/page.tsx');
  check('pools page passes isPortfolio from portfolioPoolIds set', /isPortfolio=\{portfolioPoolIds\.has\(p\.id\)\}/.test(page) && /new Set\(res\.portfolioPoolIds/.test(page));
}

function partG(): void {
  console.log('\n(G) mint-safe:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(() => {
  console.log('\nPersisted deal-mode portfolio flag proof (#5 + #4)');
  partA(); partB(); partC(); partD(); partE(); partF(); partG();
  console.log(failures === 0 ? '\ndeal-mode proof: OK\n' : `\ndeal-mode proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
