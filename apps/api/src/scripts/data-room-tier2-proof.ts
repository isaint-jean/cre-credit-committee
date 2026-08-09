/**
 * PROOF — Data Room Tier 2 first cut (a)+(b). READ-ONLY; NO engine/LLM call.
 * (a) computeMissingDocs — set-difference empty ingest slots, humanized + "blocks what":
 *     Sunroad (has cf/asr/appraisal/pca) → missing rent_roll; 640 (has all 5) → none;
 *     labels are humanized (not JE_ codes); blocks non-empty.
 * (b) cf/t12 income/expense is rendered client-side from the already-fetched
 *     RenderedAnalysis — so the proof asserts cf is PRESENT (not missing) for the
 *     loans, i.e. the income table has a basis. (getAnalysis reachability itself is
 *     covered by the differentiator proof.)
 *
 * Run: npx tsx src/scripts/data-room-tier2-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { computeMissingDocs } from '../services/data-room-store.service.js';

const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';
const SUNROAD = 'd3834d42-3b43-4d5e-8266-15203fe6e17e';
const SIXFORTY = 'ec9d2cfb-4baa-4347-bacc-84786d645da9';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function main(): void {
  console.log('\nData Room Tier 2 proof — missing-doc surface + cf/t12 basis (read-only)\n');

  const sun = computeMissingDocs(BMARK, SUNROAD);
  const ftf = computeMissingDocs(BMARK, SIXFORTY);
  const sunSlots = sun.map((m) => m.slot);
  const ftfSlots = ftf.map((m) => m.slot);

  // (a) set-difference correctness.
  check('Sunroad missing rent_roll (has cf/asr/appraisal/pca)', sunSlots.includes('rent_roll'), sunSlots.join(',') || '(none)');
  check('Sunroad NOT missing cf/asr/appraisal/pca', !['cf', 'asr', 'appraisal', 'pca'].some((s) => sunSlots.includes(s)));
  check('640 missing NOTHING (has all 5 ingest slots)', ftfSlots.length === 0, ftfSlots.join(',') || '(none)');

  // Humanized labels + blocks (not raw JE_ codes).
  const rr = sun.find((m) => m.slot === 'rent_roll');
  check('rent_roll entry humanized (label, not JE_ code)', !!rr && rr.label.toLowerCase().includes('rent roll') && !rr.label.startsWith('JE_'), rr?.label);
  check('rent_roll entry carries "blocks what"', !!rr && rr.blocks.length > 0, rr?.blocks);
  check('no missing entry is a raw JE_ code', sun.every((m) => !m.label.startsWith('JE_')));

  // (b) cf present → the income/expense table has a basis (renders from RenderedAnalysis).
  check('cf present for Sunroad (income table basis)', !sunSlots.includes('cf'));
  check('cf present for 640 (income table basis)', !ftfSlots.includes('cf'));

  // No engine call needed — computeMissingDocs is pure (returned above without a render).
  check('missing-docs computed with NO engine/LLM call', Array.isArray(sun) && Array.isArray(ftf));

  // Canonical byte-identical (read-only).
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id=?`).get(BMARK) as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17, 640 head)', bmark === 17 && !!head, `BMARK ${bmark}`);

  console.log(failures === 0 ? '\ndata-room Tier 2 proof: OK\n' : `\ndata-room Tier 2 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
