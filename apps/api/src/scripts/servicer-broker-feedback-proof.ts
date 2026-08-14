/**
 * PROOF — servicer BROKER-FEEDBACK input (extends the site-visit pattern). DISPLAY-ONLY.
 * READ-ONLY on cre.db (store in-memory).
 *
 * Gates:
 *  (A) store: broker_feedback upserts/reads on the SAME table (new fieldType); it
 *      coexists with site_visit (both present, independent).
 *  (B) memo flow: servicerNotesForAnalysis-style projection surfaces BOTH notes as
 *      attributed blocks; the workbook cells map broker_feedback → its OWN cell
 *      (distinct from site_visit's), each present → cell / empty → omitted.
 *  (C) config: broker_feedback is registered with its own workbook cell + memo label;
 *      site_visit still present (not regressed).
 *  (D) route allowlist accepts broker_feedback; servicer-gated (analysis:revise).
 *  (E) display-only / not-negotiation-coupled: no mint; no requireNegotiationLoop.
 *  (F) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/servicer-broker-feedback-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';
import {
  SERVICER_NARRATIVE_FIELDS,
  servicerInputWorkbookCell,
  siteVisitWorkbookCell,
} from '../services/servicer-inputs.service.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function partA(): void {
  console.log('\n(A) store — broker_feedback on the same table, coexists with site_visit:');
  const store = new ServicerInputsStore(':memory:');
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit', value: 'Roof aging.', author: 'a@x.com', now: '2026-08-14T10:00:00Z' });
  const br = store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'broker_feedback', value: 'Broker: leasing velocity strong; two LOIs out.', author: 'a@x.com', now: '2026-08-14T11:00:00Z' });
  check('broker_feedback upserts + reads back', br.value.includes('LOIs') && store.getOne('P', 'L', 'broker_feedback') !== null);
  check('BOTH fieldTypes coexist for the loan (2 rows)', store.listForLoan('P', 'L').length === 2);
  check('site_visit UNCHANGED by broker write', store.getOne('P', 'L', 'site_visit')?.value === 'Roof aging.');
  store.rawDb().close();
}

function partB(): void {
  console.log('\n(B) memo + workbook per-field mapping:');
  const site = { poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit' as const, value: 'Roof aging.', author: 'a@x.com', updatedAt: '2026-08-14T10:00:00Z' };
  const broker = { poolId: 'P', loanInPoolId: 'L', fieldType: 'broker_feedback' as const, value: 'Two LOIs out.', author: 'a@x.com', updatedAt: '2026-08-14T11:00:00Z' };

  const siteCell = siteVisitWorkbookCell(site);
  const brokerCell = servicerInputWorkbookCell(broker, 'broker_feedback');
  check('broker_feedback → its OWN workbook cell', brokerCell !== null && brokerCell.value.startsWith('Servicer broker feedback:'));
  check('broker cell is DISTINCT from site_visit cell', siteCell !== null && brokerCell !== null && siteCell.address !== brokerCell.address, `${siteCell?.address} vs ${brokerCell?.address}`);
  check('empty broker note → null (no injection, byte-identical)', servicerInputWorkbookCell(null, 'broker_feedback') === null && servicerInputWorkbookCell({ ...broker, value: '  ' }, 'broker_feedback') === null);
}

function partC(): void {
  console.log('\n(C) config — broker registered, site_visit still present:');
  const types = SERVICER_NARRATIVE_FIELDS.map((f) => f.fieldType);
  check('broker_feedback + site_visit BOTH configured', types.includes('broker_feedback') && types.includes('site_visit'));
  const broker = SERVICER_NARRATIVE_FIELDS.find((f) => f.fieldType === 'broker_feedback')!;
  const site = SERVICER_NARRATIVE_FIELDS.find((f) => f.fieldType === 'site_visit')!;
  check('broker + site have DISTINCT workbook cells', broker.workbookAddress !== site.workbookAddress, `${site.workbookAddress} vs ${broker.workbookAddress}`);
  check('broker label attributed ("Servicer broker feedback")', broker.label === 'Servicer broker feedback');
}

function partD(): void {
  console.log('\n(D) route allowlist + servicer-gate:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  check("PUT allowlist accepts 'broker_feedback'", /SERVICER_INPUT_FIELDS[^;]*broker_feedback/.test(routes));
  const put = routes.slice(routes.indexOf('servicer-inputs/:fieldType'), routes.indexOf('servicer-inputs/:fieldType') + 500);
  check('PUT servicer-gated (analysis:revise)', put.includes("enforcePermission(req, res, 'analysis:revise'"));
}

function partE(): void {
  console.log('\n(E) display-only + not negotiation-coupled:');
  const svc = read('apps/api/src/services/servicer-inputs.service.ts');
  check('service touches NO mint/doctrine', !/evaluateAndNarrate|ingestExtractionResult|computeContentHash|applyRevisionDelta/.test(svc));
  check('service does NOT import/call the negotiation surface', !/from '.*overlay-patches-store|requireNegotiationLoop\(/.test(svc));
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='servicer_inputs'`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('servicer_inputs table absent on canonical (no write)', !hasTable);
}

console.log('\nServicer broker-feedback proof (read-only on cre.db)');
partA(); partB(); partC(); partD(); partE(); partF();
console.log(failures === 0 ? '\nservicer broker-feedback proof: OK\n' : `\nservicer broker-feedback proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
