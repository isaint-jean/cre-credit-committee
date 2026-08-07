/**
 * ★ BUYER-DIFF v1 PROOF (read-only). Lights up the issuer-vs-ours diff on Sunroad
 * + 640: reads each deal's frozen AdjustedInputs + extraction, builds the 7-metric
 * CrossCheckResult (the producer now wired into the graph-mint), and projects the
 * three states (agreement / adjustment / can't-verify) with the per-field why.
 *
 * Nothing written to cre.db — reads the persisted deals + computes the diff
 * deterministically (same result the wired mint now persists).
 *
 *   cd apps/api && npx tsx src/scripts/proof-buyer-diff.ts [--db <path>]
 */
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { reconstructPreFlightArgs } from '../services/reconstruct-preflight-args.js';
import { buildBuyerDiffCrossCheck, projectBuyerDiff, type BuyerDiffRow } from '../services/buyer-diff.service.js';

const DEALS = {
  '640': '26027996-5d1c-4a7a-ab72-03f4900a0be0',
  Sunroad: 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00',
};

const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : undefined;

function fmt(metric: string, v: number | null): string {
  if (v === null) return 'null';
  if (metric === 'capRate' || metric === 'interestRate') return `${(v * 100).toFixed(2)}%`;
  if (metric === 'dscr') return `${v.toFixed(2)}x`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}
function hr(t: string): void { console.log(`\n════════════════════════════════════════\n${t}\n════════════════════════════════════════`); }

function printRow(r: BuyerDiffRow): void {
  const badge = r.state === 'agreement' ? 'AGREE   ' : r.state === 'adjustment' ? 'ADJUST  ' : "CAN'T-VF";
  const deltaStr = r.deltaPct === null ? '—' : `${r.deltaPct >= 0 ? '+' : ''}${(r.deltaPct * 100).toFixed(1)}%`;
  console.log(`  ${badge} ${r.metric.padEnd(13)} issuer ${fmt(r.metric, r.issuer).padStart(14)}  →  ours ${fmt(r.metric, r.ours).padStart(14)}  (${deltaStr.padStart(7)})  [${r.conservatism}]`);
  for (const w of r.why) {
    console.log(`            └─ why: ${w.ruleId} — ${w.reason}`);
  }
}

async function report(label: string, analysisId: string, rgs: RecordGraphStore, sqs: SqliteStore): Promise<void> {
  hr(`BUYER-DIFF — ${label}`);
  const rec = reconstructPreFlightArgs(analysisId, rgs, sqs);
  if ('error' in rec) { console.log('  ✗', rec.error); return; }
  const { extraction, adjustedInputs } = rec.args;

  const cross = buildBuyerDiffCrossCheck(adjustedInputs, extraction, extraction.analysisAsOfDate);
  const rows = projectBuyerDiff(cross);

  console.log(`  overallAdjustmentBias: ${cross.overallAdjustmentBias}`);
  console.log('  ISSUER underwriting  vs  OUR buyer-adjusted underwriting:\n');
  for (const r of rows) printRow(r);

  const counts = { agreement: 0, adjustment: 0, 'cant-verify': 0 } as Record<BuyerDiffRow['state'], number>;
  for (const r of rows) counts[r.state]++;
  console.log(`\n  states: AGREEMENT ${counts.agreement} · ADJUSTMENT ${counts.adjustment} · CAN'T-VERIFY ${counts['cant-verify']}`);

  const noi = rows.find((r) => r.metric === 'noi');
  if (noi) {
    console.log(`\n  ★ NOI money-shot: issuer ${fmt('noi', noi.issuer)} → ours ${fmt('noi', noi.ours)} (${noi.state})`);
    console.log(`     why: ${noi.why.length ? noi.why.map((w) => `${w.ruleId} (${w.reason})`).join('; ') : '(no NOI-level adjustment on this deal)'}`);
  }
}

(async () => {
  const sqs = dbPath ? new SqliteStore(dbPath) : new SqliteStore();
  const rgs = dbPath ? new RecordGraphStore(dbPath) : new RecordGraphStore();
  for (const [label, id] of Object.entries(DEALS)) {
    await report(label, id, rgs, sqs);
  }
  console.log('\n✓ buyer-diff proof complete — nothing written to cre.db.');
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
