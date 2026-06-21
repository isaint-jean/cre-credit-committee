/**
 * persist-sunroad-t12 — run-once LIVE WRITE: stamp the normalized T12 historical
 * actuals onto analyses.data.t12Extraction for the canonical $85M Sunroad deal
 * (71edb76c / revision 5a2d3da1), plus a credit-note Comment carrying the
 * adjustment trail / vintage asymmetry / lease-termination red flag. Mirrors
 * persist-sunroad-issuer-uw.ts (a single analyses-row UPDATE; no re-ingest, no
 * LLM, doctrine frozen — the T12 column is display-only).
 *
 * Source: Centrum Office 12_Month_Statement - 03.25.2024.pdf (Mar 2023–Feb 2024,
 * FINAL vintage). NOI derived from source, NOT back-solved to the answer key:
 *   reported NOI 6,952,470 − one-time lease-term fee 2,850,631 (acct 420625)
 *   − reclassify operating electric 228,405 (681089 + 681097) = 3,873,434.
 *
 * DISCIPLINE: take a backup first (cre.db.bak-pre-t12-<ts>), run on a COPY to
 * re-confirm, then apply to live and WAL-checkpoint. Pass --apply to write;
 * default is dry-run (prints the diff, writes nothing).
 *
 *   cd apps/api && npx tsx src/scripts/persist-sunroad-t12.ts            # dry-run
 *   cd apps/api && npx tsx src/scripts/persist-sunroad-t12.ts --apply    # LIVE write
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const DB = process.env.T12_DB ?? '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const ANALYSIS_ID = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const APPLY = process.argv.includes('--apply');

const T12 = {
  period: 'T-12 Mar 2023–Feb 2024 (FINAL 3/25/2024)',
  income: { grossPotentialRent: 6892889.34, effectiveRent: null, otherIncome: 6730.98, totalIncome: 6899620.32, uwAdjustments: null },
  expenses: { taxes: 775331.00, insurance: 316813.56, utilities: 565623.00, repairsMaintenance: 811067.00, managementFees: 188249.44, generalAndAdmin: 291437.00, janitorial: 77665.85, reimbursements: 0, totalOperatingExpenses: 3026186.85 },
  noi: 3873434, vacancyLoss: 0,
  belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
};

const MUST_CARRY =
  'T12 HISTORICAL (Operating History column H) — FINAL-vintage borrower actuals, ' +
  'period Mar 2023–Feb 2024 (statement 3/25/2024).\n' +
  'ADJUSTMENT TRAIL: reported NOI $6,952,470 − one-time lease-termination fee ' +
  '$2,850,631 (acct 420625, Jul-2023) − reclassify operating electric $228,405 ' +
  '(681089 vacant-space $82,869 + 681097 GSA $145,536, moved from below-NOI into ' +
  'utilities) = derived T12 NOI $3,873,434. Ties to the issuer completed-UW T12 ' +
  '($3,863,842) within ~$9.6K (~0.25%, category-mapping rounding — honest residual).\n' +
  'VINTAGE ASYMMETRY: this T12 column is FINAL-vintage actuals; the loan terms on ' +
  'this deal remain PRELIM vintage. Do not read the two as a single vintage.\n' +
  'RED FLAG (credit signal, not just an accounting footnote): a tenant paid $2.85M ' +
  'to terminate early in the trailing period, and the window also carries ' +
  'vacant-space electric ($82,869) — a tenant-departure / rollover + carried-' +
  'vacancy signal for the memo.';

const db = new Database(DB);
const row = db.prepare('SELECT data FROM analyses WHERE id = ?').get(ANALYSIS_ID) as { data: string } | undefined;
if (!row) { console.error('FATAL: analysis row not found:', ANALYSIS_ID); process.exit(2); }
const data = JSON.parse(row.data);

console.log('=== persist-sunroad-t12 ===');
console.log('  DB:', DB, '| APPLY:', APPLY);
console.log('  before: t12Extraction present?', !!data.t12Extraction);

const now = new Date().toISOString();
data.t12Extraction = T12;
data.comments = Array.isArray(data.comments) ? data.comments : [];
data.comments.push({
  id: randomUUID(), analysisId: ANALYSIS_ID, sectionId: 'operating-history',
  stance: 'note', text: MUST_CARRY, author: 'system:t12-normalization',
  createdAt: now, updatedAt: now,
});

console.log('  after:  t12Extraction.noi =', data.t12Extraction.noi, '| comments +1 (must-carry note)');

if (!APPLY) {
  console.log('\nDRY-RUN — no write. Re-run with --apply (after backup + copy-verify) to write live.');
  db.close();
  process.exit(0);
}

const upd = db.prepare('UPDATE analyses SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now, ANALYSIS_ID);
if (upd.changes !== 1) { console.error('FATAL: expected 1 row updated, got', upd.changes); process.exit(2); }
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ LIVE: stamped t12Extraction + must-carry note onto analyses.data; WAL checkpointed.');
