/**
 * Dry-run pre-flight readiness for an existing deal — reconstructs its args from
 * the graph and computes the readiness (ledger + derived verdict + reverse
 * rollup) WITHOUT minting. Read-only: the derived verdict runs the mint's
 * deterministic front-half against a throwaway :memory: scratch store; canonical
 * is never written.
 *
 *   cd apps/api && npx tsx src/scripts/preflight-readiness.ts <analysisId> [--db <path>]
 *   cd apps/api && npx tsx src/scripts/preflight-readiness.ts --verify   # 640 + Sunroad byte-identical proof
 */
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { reconstructPreFlightArgs } from '../services/reconstruct-preflight-args.js';
import { computePreFlightReadiness } from '../services/pre-flight-readiness.service.js';

const DEALS = {
  '640': '26027996-5d1c-4a7a-ab72-03f4900a0be0',
  Sunroad: 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00',
};

const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : undefined;
const VERIFY = argv.includes('--verify');

function hr(t: string): void { console.log('\n════════════════════════════════════════\n' + t + '\n════════════════════════════════════════'); }

async function report(analysisId: string, label: string, rgs: RecordGraphStore, sqs: SqliteStore): Promise<boolean> {
  hr(`PRE-FLIGHT — ${label} (${analysisId})`);
  const rec = reconstructPreFlightArgs(analysisId, rgs, sqs);
  if ('error' in rec) { console.log('  ✗', rec.error); return false; }
  const pf = await computePreFlightReadiness(rec.args);

  const { ledger, verdict, unlocks } = pf;
  console.log(`  ── FIELD LEDGER (${ledger.counts.produce}/${ledger.counts.sourceable} sourced) ──`);
  console.log(`  PRODUCE (${ledger.produce.length}): ${ledger.produce.map(f => f.field).join(' · ') || '(none)'}`);
  console.log(`  BLANK-in-doc (${ledger.blankInDoc.length}): ${ledger.blankInDoc.map(f => f.field).join(' · ') || '(none)'}`);
  console.log(`  MISSING (${ledger.missing.length}): ${ledger.missing.map(f => f.field).join(' · ') || '(none)'}`);
  console.log(`  decision-blank (${ledger.decision.length}, not gaps): ${ledger.decision.map(f => f.field).join(' · ') || '(none)'}`);

  console.log(`\n  ── DERIVED VERDICT (PROVISIONAL — pre-mint) ──`);
  console.log(`  dataConfidence           : ${verdict.dataConfidence}`);
  console.log(`  willMintToInsufficientData: ${verdict.willMintToInsufficientData}`);
  console.log(`  willHardHalt             : ${verdict.willHardHalt}${verdict.willHardHalt ? ' — ' + verdict.hardHaltReasons.join('; ') : ''}`);
  console.log(`  finalScore               : ${verdict.finalScore}`);
  console.log(`  band / recommendation    : ${verdict.band} / ${verdict.recommendation}`);

  console.log(`\n  ── REVERSE ROLLUP (add doc → unlocks) ──`);
  for (const u of unlocks.slice(0, 6)) {
    console.log(`  + [${u.doc}] would unlock ${u.unlocksFields.length}: ${u.unlocksFields.join(', ')}`);
    console.log(`      → outputs: ${u.unlocksOutputs.join(' | ')}`);
  }
  if (unlocks.length === 0) console.log('  (no missing/blank fields have a source doc — nothing to add)');

  // ── BYTE-IDENTICAL PROOF vs the persisted minted verdict ──
  console.log(`\n  ── BYTE-IDENTICAL vs MINTED ──`);
  const mintedScore = rec.minted.finalScore;
  const mintedRec = rec.minted.snapshotRating?.recommendation ?? null;
  const mintedBand = rec.minted.snapshotRating?.band ?? null;
  const scoreMatch = verdict.finalScore === mintedScore;
  const recMatch = verdict.recommendation === mintedRec;
  const bandMatch = verdict.band === mintedBand;
  console.log(`  finalScore   : pre-flight ${verdict.finalScore} vs minted ${mintedScore}  ${scoreMatch ? '✓' : '✗'}`);
  console.log(`  recommendation: pre-flight ${verdict.recommendation} vs minted ${mintedRec}  ${recMatch ? '✓' : '✗'}`);
  console.log(`  band         : pre-flight ${verdict.band} vs minted ${mintedBand}  ${bandMatch ? '✓' : '✗'}`);
  const ok = scoreMatch && recMatch && bandMatch;
  console.log(`  ${ok ? '✓ BYTE-IDENTICAL to the minted reality' : '✗ DIVERGENCE — pre-flight is wrong'}`);
  return ok;
}

(async () => {
  const sqs = dbPath ? new SqliteStore(dbPath) : new SqliteStore();
  const rgs = dbPath ? new RecordGraphStore(dbPath) : new RecordGraphStore();

  if (VERIFY) {
    let allOk = true;
    for (const [label, id] of Object.entries(DEALS)) {
      allOk = (await report(id, label, rgs, sqs)) && allOk;
    }
    hr(allOk ? '✓ ALL BYTE-IDENTICAL' : '✗ DIVERGENCE');
    process.exit(allOk ? 0 : 1);
  }

  const target = argv.find(a => !a.startsWith('--') && a !== dbPath);
  if (!target) { console.error('usage: preflight-readiness.ts <analysisId> [--db <path>] | --verify'); process.exit(2); }
  const ok = await report(target, target, rgs, sqs);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(2); });
