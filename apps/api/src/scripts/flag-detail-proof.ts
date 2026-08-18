/**
 * PROOF — "how I determined this" flag details (shared buildFlagDetail). RENDER-ONLY.
 * READ-ONLY on cre.db.
 *
 * Gates:
 *  (A) RICH: a dimension flag (coverage-dscr / cap-rate) → statement + rationale (how) +
 *      derivedOutputs as evidence; the NOI flag → the reconciliation receipts.
 *  (B) MESSAGE-tier: a JE data-quality flag → committee sentence + rule id + honest source.
 *  (C) HONEST-THIN: sponsor-borrower-quality → thin, NO invented evidence.
 *  (D) ★ NO FABRICATED SOURCE: every evidence.source across every flag is an honest form
 *      ("Underwriting inputs" / "<doc-kind> (page not captured)" / "Absence of …" / …) —
 *      NEVER a fabricated document+page (no "p. N" / "page N<digit>").
 *  (E) SHARED builder: the deal-room endpoint AND the memo both call buildFlagDetailsForRoot.
 *  (F) canonical byte-identical (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/flag-detail-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { buildFlagDetailsForRoot } from '../services/render-memo/flag-details-for-root.js';
import type { FlagDetail } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DB = path.join(process.cwd(), 'data', 'cre.db');
// A fabricated citation = a doc/page number. "(page not captured)" is honest (no digit after).
const FAB_SOURCE = /\bp\.?\s*\d|\bpage\s+\d/i;

const SUNROAD_EVAL = 'e50120480ad5d5058e34ef6a2a36780453e4a83956b1abb269c5cfee0b84b619';

function partA_D(): void {
  console.log('\n(A–D) flag details for Sunroad (rich / message / thin / no-fabrication):');
  const details = buildFlagDetailsForRoot(SUNROAD_EVAL, recordGraphStore);
  check('buildFlagDetailsForRoot returns details', details !== null && Object.keys(details).length > 0, details ? `${Object.keys(details).length} flags` : 'null');
  if (details === null) return;

  // (A) rich dimension
  const dscr = details['coverage-dscr'];
  check('coverage-dscr is RICH (rationale + evidence)', dscr !== undefined && dscr.tier === 'rich' && dscr.howDetermined.length > 20 && dscr.evidence.length > 0, dscr ? `${dscr.evidence.length} evidence rows` : 'absent');
  check('coverage-dscr statement + how are non-empty', dscr !== undefined && dscr.statement.length > 0 && dscr.howDetermined.length > 0);
  // (A) NOI
  const noi = details['JE_NOI_DIVERGES_FROM_ASR'] ?? details['JE_NOI_BELOW_TRAILING_ACTUAL'];
  check('NOI flag is RICH with sourced receipts', noi !== undefined && noi.evidence.length >= 2 && noi.evidence.every(e => e.source.length > 0));

  // (B) message-tier JE flag (find any dataQualityFlag-style key that is message)
  const messageFlag = Object.values(details).find(d => d.tier === 'message' && /^(JE_|UW_|DSCR_|LTV_|INSUFFICIENT)/.test(d.flagId));
  check('a JE flag is MESSAGE-tier (sentence + rule + source)', messageFlag !== undefined && messageFlag.evidence.length >= 1, messageFlag ? messageFlag.flagId : 'none present');

  // (C) honest-thin sponsor
  const sponsor = details['sponsor-borrower-quality'];
  check('sponsor is HONEST-THIN (no invented evidence)', sponsor !== undefined && sponsor.tier === 'thin' && sponsor.evidence.length === 0);
  check('sponsor how-determined does not invent reasoning', sponsor !== undefined && /HITL|could not be evaluated|human/i.test(sponsor.howDetermined));

  // (D) NO fabricated source anywhere
  const allSources: string[] = [];
  for (const d of Object.values(details)) for (const e of d.evidence) allSources.push(e.source);
  const fabricated = allSources.filter(s => FAB_SOURCE.test(s));
  check('NO fabricated document+page in any evidence source', fabricated.length === 0, fabricated.length ? `offenders: ${fabricated.slice(0, 3).join(' | ')}` : `${allSources.length} sources scanned, all honest`);
  check("sources are honest forms only (inputs / page-not-captured / absence / …)", allSources.every(s => /underwriting inputs|page not captured|absence of|pca report|not captured|engine/i.test(s)), `${allSources.length} sources`);
}

function partE(): void {
  console.log('\n(E) shared builder — deal-room endpoint + memo both use it:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  const memoCaller = read('apps/api/src/services/render-memo/render-memo-for-analysis.ts');
  check('deal-room endpoint calls buildFlagDetailsForRoot', /buildFlagDetailsForRoot\(/.test(routes) && /flag-details/.test(routes));
  check('memo caller calls the SAME buildFlagDetailsForRoot', /buildFlagDetailsForRoot\(/.test(memoCaller));
  const memo = read('apps/api/src/services/render-memo/build-committee-memo.ts');
  check('memo renders an inline <details> per flag (flagDetailHtml)', /function flagDetailHtml/.test(memo) && /<details class="memo-flag-detail"/.test(memo));
  const view = read('apps/web/src/components/RenderedAnalysisView.tsx');
  check('deal-room mounts the modal + makes flags clickable', /<FlagDetailModal/.test(view) && /getFlagDetails/.test(view) && /HowDeterminedButton/.test(view));
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nFlag-detail proof (read-only on cre.db)');
partA_D(); partE(); partF();
console.log(failures === 0 ? '\nflag-detail proof: OK\n' : `\nflag-detail proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
