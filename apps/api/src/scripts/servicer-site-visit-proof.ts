/**
 * PROOF — servicer SITE-VISIT input, end-to-end (Phase 2 first cut). DISPLAY-ONLY.
 * READ-ONLY on cre.db (store runs in-memory).
 *
 * Gates:
 *  (A) store: upsert a site_visit note → persists → reads back; re-save overwrites
 *      (last write wins), author/timestamp stamped.
 *  (B) memo flow: siteVisitMemoInput projects a note into the memo input; empty → undefined.
 *      workbook flow: siteVisitWorkbookCell(note) → Site Inspection cell when present;
 *      null when empty (→ no injection → export byte-identical).
 *  (C) display-only / mint-safe: the store/service touch NO mint/doctrine/evaluateAndNarrate;
 *      the memo block is display-only (not part of flagCategory scoring).
 *  (D) NOT coupled to the shelved negotiation store: store/service/routes never call
 *      requireNegotiationLoop → work with NEGOTIATION_LOOP_ENABLED off (the default).
 *  (E) servicer-gated: the PUT is gated on analysis:revise — the servicer (originator)
 *      role has it, the buyer does NOT.
 *  (F) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/servicer-site-visit-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';
import { siteVisitMemoInput, siteVisitWorkbookCell, SITE_VISIT_WORKBOOK_ADDRESS } from '../services/servicer-inputs.service.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function partA(): void {
  console.log('\n(A) store — upsert, read back, overwrite:');
  const store = new ServicerInputsStore(':memory:');
  const first = store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit', value: 'Roof at end of life; parking lot cracking.', author: 'isabelle@x.com', now: '2026-08-14T10:00:00Z' });
  check('upsert returns the saved note', first.value.includes('Roof') && first.author === 'isabelle@x.com');
  const readBack = store.getOne('P', 'L', 'site_visit');
  check('reads back the persisted note', readBack !== null && readBack.value === first.value);
  const updated = store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit', value: 'Revisited — roof replaced.', author: 'isabelle@x.com', now: '2026-08-15T09:00:00Z' });
  check('re-save overwrites (last write wins)', updated.value === 'Revisited — roof replaced.' && store.listForLoan('P', 'L').length === 1);
  check('other loans unaffected (keyed by loan)', store.getOne('P', 'OTHER', 'site_visit') === null);
  store.rawDb().close();
}

function partB(): void {
  console.log('\n(B) memo + workbook flow helpers:');
  const note = { poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit' as const, value: '  Deferred maintenance on HVAC.  ', author: 'a@x.com', updatedAt: '2026-08-14T10:00:00Z' };

  const memo = siteVisitMemoInput(note);
  check('memo input projects a present note (trimmed + attributed)', memo !== undefined && memo.text === 'Deferred maintenance on HVAC.' && memo.author === 'a@x.com');
  check('memo input undefined when empty (no memo block)', siteVisitMemoInput(null) === undefined && siteVisitMemoInput({ ...note, value: '   ' }) === undefined);

  const cell = siteVisitWorkbookCell(note);
  check('workbook cell → Site Inspection address when present', cell !== null && cell.address === SITE_VISIT_WORKBOOK_ADDRESS && cell.value.startsWith('Servicer site visit:'));
  check('workbook cell → null when empty (NO injection, byte-identical)', siteVisitWorkbookCell(null) === null && siteVisitWorkbookCell({ ...note, value: '' }) === null);
}

function partC(): void {
  console.log('\n(C) display-only / mint-safe:');
  const store = read('apps/api/src/storage/servicer-inputs-store.ts');
  const svc = read('apps/api/src/services/servicer-inputs.service.ts');
  const noMint = (s: string) => !/evaluateAndNarrate|ingestExtractionResult|computeContentHash|DoctrineEvaluation|applyRevisionDelta|insertRevision/.test(s);
  check('store touches NO mint/doctrine (outside the hashed graph)', noMint(store));
  check('service touches NO mint/doctrine', noMint(svc));
  const memoSrc = read('apps/api/src/services/render-memo/build-committee-memo.ts');
  const risks = memoSrc.slice(memoSrc.indexOf('function renderKeyCreditRisks'));
  // Servicer notes render as attributed DISPLAY blocks (label-driven), NOT via flagCategory.
  check('memo renders servicer notes as DISPLAY blocks (not via flagCategory)', risks.includes('memo-servicer-flag') && !/flagCategory\(\s*servicerNotes/.test(risks));
  check('memo block is guarded (empty → nothing added)', risks.includes('servicerNotes ?? []'));
  // The "Servicer site visit" attribution now lives in the service config (data-driven).
  check('site_visit label configured (Servicer site visit)', svc.includes("label: 'Servicer site visit'"));
}

function partD(): void {
  console.log('\n(D) NOT coupled to the shelved negotiation store:');
  const store = read('apps/api/src/storage/servicer-inputs-store.ts');
  const svc = read('apps/api/src/services/servicer-inputs.service.ts');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  // The servicer-input routes must not gate on requireNegotiationLoop (they'd die when off).
  const putBlock = routes.slice(routes.indexOf("servicer-inputs/:fieldType"), routes.indexOf("servicer-inputs/:fieldType") + 800);
  // Coupling = an actual import/call, NOT a comment mention that it's NOT that store.
  check('store + service never IMPORT/CALL the negotiation surface', !/from '.*overlay-patches-store|from '.*negotiation-flag|requireNegotiationLoop\(|overlayPatchesStore\(/.test(store + svc));
  check('the PUT route does NOT call requireNegotiationLoop', !putBlock.includes('requireNegotiationLoop'));
}

function partE(): void {
  console.log('\n(E) servicer-gated (analysis:revise — servicer yes, buyer no):');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  const putBlock = routes.slice(routes.indexOf("servicer-inputs/:fieldType"), routes.indexOf("servicer-inputs/:fieldType") + 500);
  check('PUT enforces analysis:revise', putBlock.includes("enforcePermission(req, res, 'analysis:revise'"));
  const roles = read('packages/contracts/src/roles.ts');
  const originator = roles.slice(roles.indexOf('ORIGINATOR: ['), roles.indexOf('ORIGINATOR: [') + 400);
  const buyer = roles.slice(roles.indexOf('BUYER: ['), roles.indexOf('BUYER: [') + 400);
  check('servicer (ORIGINATOR) HAS analysis:revise', originator.includes("'analysis:revise'"));
  check('BUYER does NOT have analysis:revise (write denied)', !buyer.includes("'analysis:revise'"));
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  // the store table is lazy-DDL; it must not exist yet on canonical (untouched).
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='servicer_inputs'`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('servicer_inputs table absent on canonical (no write happened)', !hasTable);
}

console.log('\nServicer site-visit proof (read-only on cre.db)');
partA(); partB(); partC(); partD(); partE(); partF();
console.log(failures === 0 ? '\nservicer site-visit proof: OK\n' : `\nservicer site-visit proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
