/**
 * Render the buyer-diff VISUAL to HTML files for Sunroad + 640 — the deliverable
 * Isabelle opens in a browser. Read-only, deterministic, no LLM (frozen state).
 *
 *   cd apps/api && npx tsx src/scripts/render-buyer-diff-view.ts [--out <dir>]
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { reconstructPreFlightArgs } from '../services/reconstruct-preflight-args.js';
import { buildBuyerDiffCrossCheck, projectBuyerDiff } from '../services/buyer-diff.service.js';
import { renderBuyerDiffHtml } from '../services/render-buyer-diff-html.js';

const DEALS: Record<string, string> = {
  Sunroad: 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00',
  '640': '26027996-5d1c-4a7a-ab72-03f4900a0be0',
};

const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : join(homedir(), 'Downloads');

const sqs = new SqliteStore();
const rgs = new RecordGraphStore();

for (const [label, id] of Object.entries(DEALS)) {
  const rec = reconstructPreFlightArgs(id, rgs, sqs);
  if ('error' in rec) { console.error(`  ✗ ${label}: ${rec.error}`); continue; }
  const { extraction, adjustedInputs } = rec.args;
  const cross = buildBuyerDiffCrossCheck(adjustedInputs, extraction, extraction.analysisAsOfDate);
  const rows = projectBuyerDiff(cross);
  const html = renderBuyerDiffHtml({ id, dealRef: extraction.dealRef }, rows, cross.overallAdjustmentBias);
  const path = join(outDir, `Buyer-Diff-${label}.html`);
  writeFileSync(path, html, 'utf8');
  const counts = { agreement: 0, adjustment: 0, 'cant-verify': 0 } as Record<string, number>;
  for (const r of rows) counts[r.state]++;
  console.log(`  ✓ ${label}: ${path}  (${rows.length} rows — ${counts.agreement} accepted / ${counts.adjustment} adjusted / ${counts['cant-verify']} can't-verify, bias ${cross.overallAdjustmentBias})`);
}
console.log('\n✓ buyer-diff views rendered — nothing written to cre.db.');
