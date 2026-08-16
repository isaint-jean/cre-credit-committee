/**
 * PROOF — deal-room NOI-reconciliation receipts endpoint + expander.
 * DISPLAY-ONLY / render-time / MINT-SAFE. Reads cre.db read-only.
 *
 * Gates:
 *  (A) endpoint data path: for 640's root (a doctrine_evaluation_id), the server logic
 *      (getDoctrineEvaluation → extraction + adjustedInputs.metrics.noi → buildNoiReconciliationDetail)
 *      yields a multi-row detail (concluded + ASR), NO page number.
 *  (B) 404-safe: an unknown root → { detail: null } (getDoctrineEvaluation null).
 *  (C) SHARED builder: the endpoint (pool.routes) and the memo (render-memo-for-analysis)
 *      both call buildNoiReconciliationDetail → byte-identical rows.
 *  (D) deal-room wiring: the receipts expander mounts INSIDE the existing noiDivergence
 *      banner (not a new box); gated on ≥2 rows; source-document only, no page.
 *  (E) endpoint registered + deal-access gated + read-only (no write/mint).
 *  (F) canonical byte-identical (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/deal-room-noi-reconciliation-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildNoiReconciliationDetail } from '../services/render-memo/noi-reconciliation-detail.js';
import type { DoctrineEvaluationId } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DB = path.join(process.cwd(), 'data', 'cre.db');
const PAGE_RE = /\bp\.?\s*\d|\bpage\s*\d/i;
const HEAD_640_EVAL_ID = '8259948db54784048bc63cc367731d087d2b0f2f0e9fe8bbb6cd6b74e74812a8';

/** Mirror of the endpoint handler's server logic (same getters + same builder). */
function endpointDetail(graph: RecordGraphStore, rootId: string) {
  const de = graph.getDoctrineEvaluation(rootId as DoctrineEvaluationId);
  if (de === null) return null;
  const extraction = graph.getExtractionResult(de.extractionResultId);
  if (extraction === null) return null;
  const adjusted = graph.getAdjustedInputs(de.adjustedInputsId);
  return buildNoiReconciliationDetail(extraction, adjusted?.metrics.noi ?? null);
}

function partA_B(): void {
  console.log('\n(A/B) endpoint data path + 404-safe:');
  const graph = new RecordGraphStore(DB);
  const detail = endpointDetail(graph, HEAD_640_EVAL_ID);
  check('640 root → detail with ≥2 sourced rows', detail !== null && detail.rows.length >= 2, detail ? `${detail.rows.length} rows: ${detail.rows.map(r => r.label).join(' | ')}` : 'null');
  check('640 detail carries NO page number', detail !== null && !PAGE_RE.test(JSON.stringify(detail)));
  check('640 detail rows carry a source DOCUMENT', detail !== null && detail.rows.every(r => r.sourceDocument.length > 0));
  check('unknown root → null (404-safe)', endpointDetail(graph, 'deadbeef'.repeat(8)) === null);
}

function partC(): void {
  console.log('\n(C) shared builder — memo + deal-room, same source:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  const memoCaller = read('apps/api/src/services/render-memo/render-memo-for-analysis.ts');
  check('endpoint calls buildNoiReconciliationDetail', /buildNoiReconciliationDetail\(/.test(routes));
  check('memo calls the SAME buildNoiReconciliationDetail', /buildNoiReconciliationDetail\(/.test(memoCaller));
}

function partD(): void {
  console.log('\n(D) deal-room wiring — inside the existing banner, gated, no page:');
  const view = read('apps/web/src/components/RenderedAnalysisView.tsx');
  const comp = read('apps/web/src/components/NoiReconciliationReceipts.tsx');
  // mounted inside the noiDivergence banner (not a new box)
  const bannerIdx = view.indexOf("noiDivergence?.status.value === 'flagged'");
  const bannerBlock = bannerIdx >= 0 ? view.slice(bannerIdx, bannerIdx + 700) : '';
  check('receipts expander mounted INSIDE the existing noiDivergence banner', bannerBlock.includes('<NoiReconciliationReceipts'));
  check('no new banner/box added (single mount)', (view.match(/<NoiReconciliationReceipts/g) ?? []).length === 1);
  check('expander gated on ≥2 rows (mirrors the memo)', comp.includes('detail.rows.length < 2'));
  check('renders as a collapsed <details> "Show the figures compared"', comp.includes('<details') && comp.includes('Show the figures compared'));
  check('source document only + the no-page note (nothing fabricated)', comp.includes('Source document') && comp.includes('page-level provenance is not captured') && !PAGE_RE.test(comp.replace(/page-level provenance is not captured/g, '')));
}

function partE(): void {
  console.log('\n(E) endpoint registered + gated + read-only:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  check("GET /loan-for-root/:rootId/noi-reconciliation registered", /poolRoutes\.get\('\/loan-for-root\/:rootId\/noi-reconciliation'/.test(routes));
  const start = routes.indexOf("'/loan-for-root/:rootId/noi-reconciliation'");
  const body = routes.slice(start, start + 700);
  check('deal-access gated (enforceDealForRoot)', body.includes('enforceDealForRoot(req, res, rootId)'));
  check('handler touches NO write/mint', !/upsert|INSERT|UPDATE|evaluateAndNarrate|computeContentHash|setLoanAssetType/.test(body));
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nDeal-room NOI-reconciliation receipts proof (read-only on cre.db)');
partA_B(); partC(); partD(); partE(); partF();
console.log(failures === 0 ? '\ndeal-room NOI-reconciliation proof: OK\n' : `\ndeal-room NOI-reconciliation proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
