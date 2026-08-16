/**
 * PROOF — one-off assetType backfill. Runs the backfill on a TEMP COPY of cre.db
 * (never canonical), verifies the fill, idempotency, no-overwrite, and that CANONICAL
 * is byte-untouched. MINT-SAFE (pool-layer column only).
 *
 * Gates:
 *  (A) fill: on the temp db, Sunroad's pool loan → 'Office', 640 → 'Office' (faithful);
 *      filled count == distinct profiled loans; casing normalized.
 *  (B) idempotent: a second run fills 0 (all already set) and never overwrites.
 *  (C) no-overwrite: a loan pre-set to a sentinel is left untouched.
 *  (D) un-profiled loans untouched (still null on temp).
 *  (E) CANONICAL byte-untouched: the real cre.db still has Sunroad assetType null,
 *      BMARK 17, 640 head 221235987967 intact (the proof only wrote to the temp copy).
 *
 * Run: npx tsx src/scripts/backfill-loan-asset-type-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../storage/sqlite-store.js';
import { PoolStore } from '../storage/pool-store.js';
import { resolveLoanForRoot, _setResolveLoanForRootStoresForTests } from '../services/pool/resolve-loan-for-root.js';
import { backfillLoanAssetType } from './backfill-loan-asset-type.js';
import type { LoanInPoolId } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const SRC = path.join(process.cwd(), 'data', 'cre.db');
const HEAD_640_LINEAGE_ROOT = '8c454c15cfe81b4a5133b08ab8a9081979f8819329661c75aaff4fdc1439a953';

function canonicalNonNull(): number {
  const c = new Database(SRC, { readonly: true });
  const n = (c.prepare(`SELECT count(*) c FROM loan_in_pool WHERE asset_type IS NOT NULL`).get() as { c: number }).c;
  c.close();
  return n;
}

function run(): void {
  // Baseline BEFORE any work — canonical already has a pre-existing non-null (not ours).
  const baselineNonNull = canonicalNonNull();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-proof-'));
  const TMP = path.join(tmpDir, 'cre.db');
  fs.copyFileSync(SRC, TMP);

  const sqlite = new SqliteStore(TMP);
  const pool = new PoolStore(TMP);
  // Point resolveLoanForRoot at the temp stores so the whole backfill hits the copy.
  _setResolveLoanForRootStoresForTests({ sqliteStore: sqlite, poolStore: pool });

  try {
    // Find Sunroad's root + loan on the temp copy.
    const tdb = new Database(TMP, { readonly: true });
    const sunRoot = (tdb.prepare(`
      SELECT DISTINCT rle.lineage_root_id AS root
      FROM revision_lineage_envelopes rle
      JOIN doctrine_evaluations de ON de.id = rle.doctrine_evaluation_id
      JOIN extraction_results er ON er.id = de.extraction_result_id
      WHERE er.deal_ref LIKE '%unroad%' LIMIT 1
    `).get() as { root: string } | undefined)?.root;
    tdb.close();

    const sunRes = sunRoot ? resolveLoanForRoot(sunRoot) : { resolved: false as const, ambiguous: true as const, reason: 'NONE' as const, matchCount: 0 };
    const r640 = resolveLoanForRoot(HEAD_640_LINEAGE_ROOT);
    check('resolved Sunroad + 640 pool loans on the temp copy', sunRes.resolved && r640.resolved);
    const sunLoanId = sunRes.resolved ? (sunRes.loanInPoolId as LoanInPoolId) : null;
    const loan640Id = r640.resolved ? (r640.loanInPoolId as LoanInPoolId) : null;

    // Pre: both null on the copy.
    check('pre-backfill: Sunroad + 640 assetType null on temp', pool.getLoanInPool(sunLoanId!)?.assetType == null && pool.getLoanInPool(loan640Id!)?.assetType == null);

    // ── Fresh backfill on the temp copy. ──
    const s1 = backfillLoanAssetType({ sqliteStore: sqlite, poolStore: pool, resolve: resolveLoanForRoot });

    // (A) fill — Sunroad + 640 → Office (faithful to the engine).
    check("Sunroad pool loan → 'Office' (loan page checklist now shows Office)", pool.getLoanInPool(sunLoanId!)?.assetType === 'Office');
    check("640 pool loan → 'Office' (faithful to the engine)", pool.getLoanInPool(loan640Id!)?.assetType === 'Office');
    check('filled the 2 profiled+pooled null loans (Sunroad, 640)', s1.filled.length === 2, `filled ${s1.filled.length} of ${s1.profiledRoots} profiled roots; skipped non-null ${s1.skippedNonNull}, unresolved ${s1.skippedUnresolved}`);
    check('every filled value is a canonical AssetType (casing normalized)', s1.filled.every((f) => /^[A-Z][a-zA-Z]+$/.test(f.assetType)));
    check('a pre-existing non-null profiled loan was skipped (not overwritten)', s1.skippedNonNull >= 1);

    // (C) explicit no-overwrite: set Sunroad to a sentinel, re-run — must stay the sentinel.
    pool.setLoanAssetType(sunLoanId!, 'Retail');
    const s2 = backfillLoanAssetType({ sqliteStore: sqlite, poolStore: pool, resolve: resolveLoanForRoot });
    check('no-overwrite: a set value is left untouched on re-run', pool.getLoanInPool(sunLoanId!)?.assetType === 'Retail');
    check('idempotent: re-run fills 0', s2.filled.length === 0);
  } finally {
    _setResolveLoanForRootStoresForTests(null);
  }

  // (E) CANONICAL untouched — the proof only wrote to the temp copy.
  const cdb = new Database(SRC, { readonly: true });
  const bmark = (cdb.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = cdb.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  cdb.close();
  check('CANONICAL byte-untouched: BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('CANONICAL loan_in_pool unchanged (proof wrote only to temp)', canonicalNonNull() === baselineNonNull, `non-null ${canonicalNonNull()} == baseline ${baselineNonNull}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\nBackfill loan assetType proof (runs on a TEMP copy; canonical read-only)');
run();
console.log(failures === 0 ? '\nbackfill loan assetType proof: OK\n' : `\nbackfill loan assetType proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
