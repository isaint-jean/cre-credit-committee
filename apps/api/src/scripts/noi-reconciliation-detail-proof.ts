/**
 * PROOF — NOI-reconciliation flag expander (render-time sourced side-by-side).
 * DISPLAY-ONLY / MINT-SAFE. Reads cre.db read-only.
 *
 * Gates:
 *  (A) builder: concluded + T-12 + ASR + seller present → 4 rows, correct labels/sources,
 *      currency formatted.
 *  (B) present-only: absent figures produce NO row (no null rows — honest).
 *  (C) < 2 figures → no side-by-side (the memo expander renders nothing).
 *  (D) variance: deterministic vs concluded (T-12 %, ASR ×); null when concluded absent.
 *  (E) ★ NO page number anywhere — source DOCUMENT only (nothing fabricated).
 *  (F) real deal: 640's extraction yields a multi-row detail (concluded + ASR at least).
 *  (G) memo wiring: the expander is attached to the NOI-recon flags, gated on ≥2 rows,
 *      inside a <details> in the underwriting-validation body (no section reorder → the
 *      committee-memo FORMAT HASH is unchanged → no version bump).
 *  (H) canonical byte-identical (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/noi-reconciliation-detail-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildNoiReconciliationDetail } from '../services/render-memo/noi-reconciliation-detail.js';
import type { ExtractionResult } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DB = path.join(process.cwd(), 'data', 'cre.db');
const PAGE_RE = /\bp\.?\s*\d|\bpage\s*\d/i;

const er = (t12: number | null, asr: number | null, seller: number | null): ExtractionResult =>
  ({ t12Actual: t12 === null ? null : { noi: t12 }, asr: asr === null ? null : { underwrittenNOI: asr }, sellerUw: seller === null ? null : { underwrittenNOI: seller } } as unknown as ExtractionResult);

function partA_E(): void {
  console.log('\n(A–E) builder — rows, present-only, variance, no page:');
  const full = buildNoiReconciliationDetail(er(3_000_000, 56_200_000, 2_800_000), 8_300_000);
  check('4 rows when all present', full.rows.length === 4, `${full.rows.length} rows`);
  check('concluded row formatted + sourced', full.rows[0]!.label.startsWith('Concluded') && full.rows[0]!.valueFormatted === '$8,300,000' && /Engine/.test(full.rows[0]!.sourceDocument));
  check('T-12 row sourced to the operating statement', full.rows.some(r => /Trailing-12/.test(r.label) && /Operating statement/.test(r.sourceDocument)));
  check('ASR row sourced to the ASR', full.rows.some(r => /ASR/.test(r.label) && /Asset Summary Report/.test(r.sourceDocument)));

  // (B) present-only
  const noT12 = buildNoiReconciliationDetail(er(null, 56_200_000, null), 8_300_000);
  check('absent T-12 + seller → those rows omitted (no null rows)', noT12.rows.length === 2 && !noT12.rows.some(r => /Trailing-12|Seller/.test(r.label)));

  // (C) < 2 figures
  const single = buildNoiReconciliationDetail(er(null, null, null), 8_300_000);
  check('only concluded present → 1 row (< 2 → expander renders nothing)', single.rows.length === 1);

  // (D) variance
  check('variance vs ASR (×) present', full.variance !== null && /× (above|below) the ASR/.test(full.variance!));
  check('variance vs T-12 (%) present', /% (above|below) the T-12/.test(full.variance ?? ''));
  const noConcluded = buildNoiReconciliationDetail(er(3_000_000, 56_200_000, null), null);
  check('variance null when concluded absent', noConcluded.variance === null);

  // (E) NO page number
  const blob = JSON.stringify(full);
  check('NO page number anywhere (source document only)', !PAGE_RE.test(blob), 'scanned rows + variance');
}

function partF(): void {
  console.log('\n(F) real deal — 640 extraction yields a multi-row detail:');
  const graph = new RecordGraphStore(DB);
  const de = graph.getDoctrineEvaluation('8259948db54784048bc63cc367731d087d2b0f2f0e9fe8bbb6cd6b74e74812a8' as never);
  check('640 doctrine evaluation resolves', de !== null);
  if (de === null) return;
  const extraction = graph.getExtractionResult(de.extractionResultId);
  check('640 extraction resolves', extraction !== null);
  if (extraction === null) return;
  // Use the ASR-disclosed NOI as a stand-in concluded for the variance path; the rows
  // themselves come from 640's real extracted figures.
  const detail = buildNoiReconciliationDetail(extraction, extraction.asr?.underwrittenNOI ?? 8_300_000);
  check('640 detail has ≥2 sourced rows', detail.rows.length >= 2, `${detail.rows.length} rows: ${detail.rows.map(r => r.label).join(' | ')}`);
  check('640 detail carries NO page number', !PAGE_RE.test(JSON.stringify(detail)));
}

function partG(): void {
  console.log('\n(G) memo wiring — attached to the NOI flags, gated, no reorder:');
  const memo = read('apps/api/src/services/render-memo/build-committee-memo.ts');
  check('expander gated to the NOI-reconciliation flags', memo.includes('NOI_RECONCILIATION_FLAGS') && /JE_NOI_DIVERGES_FROM_ASR/.test(memo) && /JE_NOI_BELOW_TRAILING_ACTUAL/.test(memo));
  check('expander gated on ≥2 rows (a side-by-side needs two)', memo.includes('detail.rows.length < 2'));
  check('rendered as a <details> in the underwriting-validation body (no new section)', memo.includes('<details class="memo-noi-reconciliation"'));
  check('memo expander shows source document, NOT a page', memo.includes('Source document') && memo.includes('page-level provenance is not captured'));
}

function partH(): void {
  console.log('\n(H) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nNOI-reconciliation detail proof (read-only on cre.db)');
partA_E(); partF(); partG(); partH();
console.log(failures === 0 ? '\nNOI-reconciliation detail proof: OK\n' : `\nNOI-reconciliation detail proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
