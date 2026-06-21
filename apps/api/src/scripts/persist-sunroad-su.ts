/**
 * persist-sunroad-su — run-once LIVE WRITE: stamp the ASR Sources & Uses table
 * onto analyses.data.sourcesAndUses for the canonical $85M Sunroad deal
 * (71edb76c / revision 5a2d3da1). The v14 bindings (F27-F31, K30) read this
 * overlay PRIMARY (buildSourcesUsesAtoms → c.sourcesUses.*), so a single
 * analyses-row UPDATE populates the S&U block — no re-ingest, no LLM, no
 * revision collision, doctrine frozen. Mirrors persist-sunroad-t12.ts.
 *
 * Figures: deterministic parse (parseSourcesAndUses, no LLM) of the ASR
 * (010. Sunroad Centrum - ASR PRELIM, sha256 645d573b…). Uses sum = $85M.
 *
 *   cd apps/api && npx tsx src/scripts/persist-sunroad-su.ts            # dry-run
 *   cd apps/api && npx tsx src/scripts/persist-sunroad-su.ts --apply    # LIVE write
 */
import Database from 'better-sqlite3';

const DB = process.env.SU_DB ?? '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const ANALYSIS_ID = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const APPLY = process.argv.includes('--apply');

const SU = {
  loanAmount: 85000000,
  loanPayoff: 65365379,
  returnOfEquity: 5600990,
  unfundedObligations: 12058873,
  capitalExpenditures: 274758,
  closingCosts: 1700000,
  purchasePrice: null,
  totalCostBasis: 91600000,
};

const db = new Database(DB);
const row = db.prepare('SELECT data FROM analyses WHERE id = ?').get(ANALYSIS_ID) as { data: string } | undefined;
if (!row) { console.error('FATAL: analysis row not found:', ANALYSIS_ID); process.exit(2); }
const data = JSON.parse(row.data);

console.log('=== persist-sunroad-su ===');
console.log('  DB:', DB, '| APPLY:', APPLY);
console.log('  before: sourcesAndUses present?', !!data.sourcesAndUses);

const usesSum = SU.loanPayoff + SU.returnOfEquity + SU.unfundedObligations + SU.capitalExpenditures + SU.closingCosts;
if (usesSum !== SU.loanAmount) { console.error(`FATAL: uses sum ${usesSum} ≠ loan ${SU.loanAmount}`); process.exit(2); }

const now = new Date().toISOString();
data.sourcesAndUses = SU;
console.log('  after:  sourcesAndUses set | uses sum =', usesSum.toLocaleString(), '= loan ✓');

if (!APPLY) {
  console.log('\nDRY-RUN — no write. Re-run with --apply (after backup + copy-verify) to write live.');
  db.close();
  process.exit(0);
}

const upd = db.prepare('UPDATE analyses SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now, ANALYSIS_ID);
if (upd.changes !== 1) { console.error('FATAL: expected 1 row updated, got', upd.changes); process.exit(2); }
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ LIVE: stamped sourcesAndUses onto analyses.data; WAL checkpointed.');
