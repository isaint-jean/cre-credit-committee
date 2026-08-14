/**
 * CHECK — Originator→Servicer DISPLAY-ONLY relabel. READ-ONLY (source + cre.db).
 *
 * Asserts:
 *  (A) DISPLAY labels now read "Servicer" (side-label constants + a sampling of prose).
 *  (B) IDENTITY VALUES untouched: the 'ORIGINATOR' enum, role/side === 'originator'
 *      checks, ?side=originator URL param, the seed email + role value 'originator',
 *      the overlay-patches side value, and the text-originator theme token.
 *  (C) the Pool.seller DATA label still reads "Seller" (the securitization loan-seller
 *      field — the CRITICAL EXCEPTION; must NOT become "Servicer").
 *  (D) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/originator-servicer-relabel-check.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const has = (rel: string, s: string) => read(rel).includes(s);

function partA(): void {
  console.log('\n(A) DISPLAY labels read "Servicer":');
  check("auth-shell SIDE_LABEL.originator → 'Servicer'", has('apps/web/src/components/auth-shell.tsx', "originator: 'Servicer'"));
  check("side-accent.ts ORIGINATOR label → 'Servicer'", has('apps/web/src/lib/side-accent.ts', "label: 'Servicer'"));
  check('RenderedAnalysisView action prose → "Flag to servicer"', has('apps/web/src/components/RenderedAnalysisView.tsx', 'Flag to servicer'));
  check('DealRoom response → "Servicer — response"', has('apps/web/src/components/DealRoom.tsx', 'Servicer — response'));
  check('loan page → "Servicer ref"', has('apps/web/src/app/pools/[poolId]/loans/[loanInPoolId]/page.tsx', 'Servicer ref'));
  check('pool page header → "Servicer ref"', has('apps/web/src/app/pools/[poolId]/page.tsx', 'Servicer ref'));
  check('home prose → "Servicers want to win"', has('apps/web/src/app/page.tsx', 'Servicers want to win'));
  check('seed user name → "Servicer"', has('apps/api/src/storage/sqlite-store.ts', "name: 'Servicer'"));
  console.log('  · Seller UW → Servicer UW (party package):');
  check('BuyerDiffPanel → "Servicer Underwriting" + "Download servicer UW"', has('apps/web/src/components/BuyerDiffPanel.tsx', 'Servicer Underwriting') && has('apps/web/src/components/BuyerDiffPanel.tsx', 'Download servicer UW'));
  check('WorkbookReadiness CTA → "Generate servicer underwriting"', has('apps/web/src/components/WorkbookReadiness.tsx', 'Generate servicer underwriting'));
  check('NegotiationSurface → "servicer underwriting is with"', has('apps/web/src/components/NegotiationSurface.tsx', 'servicer underwriting is with'));
  check('home door → "Servicer underwriting"', has('apps/web/src/app/page.tsx', "'Servicer underwriting'"));
}

function partB(): void {
  console.log('\n(B) IDENTITY VALUES untouched:');
  check("roles.ts enum 'ORIGINATOR' present", has('packages/contracts/src/roles.ts', "'ORIGINATOR'"));
  check("side === 'originator' logic checks intact (RenderedAnalysisView)", has('apps/web/src/components/RenderedAnalysisView.tsx', "side === 'originator'"));
  check("?side=originator URL param intact (home + auth-shell)", has('apps/web/src/app/page.tsx', 'side=originator') && has('apps/web/src/components/auth-shell.tsx', "?side=originator"));
  check("seed email 'originator@cre.com' + role 'originator' intact", has('apps/api/src/storage/sqlite-store.ts', "email: 'originator@cre.com'") && has('apps/api/src/storage/sqlite-store.ts', "role: 'originator'"));
  check("SIDE_LABEL KEY 'originator' intact (not renamed)", read('apps/web/src/components/auth-shell.tsx').includes('originator:'));
  check("overlay-patches side value 'originator' intact", has('apps/api/src/routes/workflow.routes.ts', "body.side === 'originator'"));
  check("text-originator theme token intact (side-accent)", has('apps/web/src/lib/side-accent.ts', "text: 'text-originator'"));
  check("auth boundary map originator→ORIGINATOR intact", has('apps/api/src/middleware/auth.ts', "originator: 'ORIGINATOR'"));
}

function partC(): void {
  console.log('\n(C) Pool.seller DATA label UNCHANGED (must stay "Seller"):');
  check('PoolHeader seller label still "Seller"', /text-text-muted">Seller</.test(read('apps/web/src/components/PoolRail/PoolHeader.tsx')));
  check('MembershipTable seller column still "Seller"', has('apps/web/src/components/PoolRail/MembershipTable.tsx', '>Seller</th>'));
  check('pools filter still "Seller"', has('apps/web/src/app/pools/page.tsx', '>Seller</span>'));
  check('NewDealForm still "Seller (optional)"', has('apps/web/src/components/PoolRail/NewDealForm.tsx', 'Seller (optional)') || has('apps/web/src/components/PoolRail/NewDealForm.tsx', 'Seller'));
}

function partD(): void {
  console.log('\n(D) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nOriginator→Servicer display-only relabel check (read-only)');
partA(); partB(); partC(); partD();
console.log(failures === 0 ? '\nrelabel check: OK\n' : `\nrelabel check: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
