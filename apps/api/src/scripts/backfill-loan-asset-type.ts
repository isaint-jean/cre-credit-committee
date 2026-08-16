/**
 * ONE-OFF BACKFILL — set assetType on the already-underwritten pool loans from their
 * AssetProfile, so the LOAN PAGE checklist shows the real type immediately (the deal-room
 * already resolves it read-time; new/re-underwritten loans get it via the underwrite
 * write-back). Closes the gap for the ~6 loans profiled before that write-back existed.
 *
 * Reuses the EXACT (b) write path — resolveLoanForRoot (root→loan) + getPropertyTypeForRoot
 * + normalizeAssetType + setLoanAssetType. No new logic; just iterates the profiled roots.
 *
 * ★ IDEMPOTENT: fills ONLY loans whose assetType is currently null; never overwrites a
 *   non-null value. Re-running is a no-op (filled = 0).
 * ★ MINT-SAFE: writes only the pool-layer loan_in_pool.asset_type column (+ its payload
 *   copy). Reads asset_profiles read-only. Does NOT touch the doctrine hash / 640 head.
 *
 * Run (default = canonical data/cre.db):   npx tsx src/scripts/backfill-loan-asset-type.ts
 * Run against a specific db (temp/live):    npx tsx src/scripts/backfill-loan-asset-type.ts <path-to.db>
 */
import { SqliteStore, store as defaultSqliteStore } from '../storage/sqlite-store.js';
import { PoolStore } from '../storage/pool-store.js';
import {
  resolveLoanForRoot,
  _setResolveLoanForRootStoresForTests,
  type LoanForRootResolution,
} from '../services/pool/resolve-loan-for-root.js';
import { normalizeAssetType, type LoanInPoolId } from '@cre/contracts';

export interface BackfillFill {
  readonly loanInPoolId: string;
  readonly assetType: string;
}
export interface BackfillSummary {
  readonly profiledRoots: number;
  readonly filled: BackfillFill[];
  readonly skippedNonNull: number;
  readonly skippedUnresolved: number;
  readonly skippedNoType: number;
}

export interface BackfillDeps {
  readonly sqliteStore: Pick<SqliteStore, 'getPropertyTypeForRoot' | 'listRootsWithAssetProfile'>;
  readonly poolStore: Pick<PoolStore, 'getLoanInPool' | 'setLoanAssetType'>;
  readonly resolve: (root: string) => LoanForRootResolution;
}

/** Pure backfill over injected stores — testable against a temp db. */
export function backfillLoanAssetType(deps: BackfillDeps): BackfillSummary {
  const { sqliteStore, poolStore, resolve } = deps;
  const roots = sqliteStore.listRootsWithAssetProfile();
  const filled: BackfillFill[] = [];
  let skippedNonNull = 0;
  let skippedUnresolved = 0;
  let skippedNoType = 0;
  const done = new Set<string>(); // dedup: distinct loans (a loan can have >1 profiled root)

  for (const root of roots) {
    const res = resolve(root);
    if (!res.resolved) { skippedUnresolved++; continue; }
    if (done.has(res.loanInPoolId)) continue;
    const loan = poolStore.getLoanInPool(res.loanInPoolId as LoanInPoolId);
    if (loan === null) { skippedUnresolved++; continue; }
    if (loan.assetType !== null) { skippedNonNull++; done.add(res.loanInPoolId); continue; } // never overwrite
    const assetType = normalizeAssetType(sqliteStore.getPropertyTypeForRoot(root));
    if (assetType === null) { skippedNoType++; continue; }
    poolStore.setLoanAssetType(res.loanInPoolId as LoanInPoolId, assetType);
    filled.push({ loanInPoolId: res.loanInPoolId, assetType });
    done.add(res.loanInPoolId);
  }
  return { profiledRoots: roots.length, filled, skippedNonNull, skippedUnresolved, skippedNoType };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function main(): void {
  const dbPath = process.argv[2]; // optional — default is the canonical singleton db
  const sqliteStore = dbPath ? new SqliteStore(dbPath) : defaultSqliteStore;
  const poolStore = dbPath ? new PoolStore(dbPath) : new PoolStore();
  // When targeting a non-default db, point resolveLoanForRoot at the same stores.
  if (dbPath) _setResolveLoanForRootStoresForTests({ sqliteStore, poolStore });
  try {
    const summary = backfillLoanAssetType({ sqliteStore, poolStore, resolve: resolveLoanForRoot });
    console.log(`\nBackfill loan assetType (${dbPath ?? 'canonical data/cre.db'})`);
    console.log(`  profiled roots: ${summary.profiledRoots}`);
    console.log(`  filled:         ${summary.filled.length}`);
    for (const f of summary.filled) console.log(`    - ${f.loanInPoolId} → ${f.assetType}`);
    console.log(`  skipped (already set): ${summary.skippedNonNull}`);
    console.log(`  skipped (unresolved):  ${summary.skippedUnresolved}`);
    console.log(`  skipped (no type):     ${summary.skippedNoType}\n`);
  } finally {
    if (dbPath) _setResolveLoanForRootStoresForTests(null);
  }
}

// Run only when invoked directly (not when imported by the proof).
if (import.meta.url === `file://${process.argv[1]}`) main();
