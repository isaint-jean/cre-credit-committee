/**
 * DEV SEED — real BMARK 2024-V8 prelim-tape lineage.
 *
 *   cd apps/api && npx tsx src/scripts/seed-pool-bmark.ts
 *
 * Reads 13 prelim-tape .xlsx files from ~/Downloads/Tapes (in date order; uses
 * 4_3v2 as canonical v3 per the recon decision), parses each through
 * parse-bmark-tape-xlsx.ts, and drives them through advanceTapePhaseA +
 * advanceTapePhaseB to produce the real 13-tape pool in the local cre.db.
 *
 * Identity key: NORMALIZED property name (Step-0 verified collision-free
 * across all 13 tapes; alias map handles 3 known data-drift cases).
 *
 * Idempotency: if a pool with shelfName "BMARK 2024-V8" already exists,
 * logs and exits without re-seeding.
 *
 * NOT a production seed — this is dev-data infrastructure. The parser +
 * contract changes are real product code; this script ties them together
 * for the demo.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { LoanInPoolId, Pool, PoolId, TapeId, Disposition } from '@cre/contracts';
import { PoolStore } from '../storage/pool-store.js';
import {
  advanceTapePhaseA,
  advanceTapePhaseB,
  type IncomingTape,
  type Resolution,
} from '../services/pool/advance-tape.service.js';
import { mintPoolId } from '../util/pool-ids.js';
import { parseBmarkTapeXlsx, normalizePropertyName } from '../services/parse-bmark-tape-xlsx.js';
import { deriveDealModesFromTape } from '../services/deal-mode.service.js';

const SHELF_NAME = 'BMARK 2024-V8';
const VINTAGE = 2024;

const TAPE_DIR = path.join(os.homedir(), 'Downloads', 'Tapes');

// 13 prelim tapes in date order. 4_3v2 is the canonical v3 (the same-day
// re-issue with Ovation→Lauretta swap); 4_3 (original) is excluded.
interface TapeFile { readonly label: string; readonly file: string; readonly date: string }
const TAPES: readonly TapeFile[] = [
  { label: '3_22',  file: 'BMARK 2024-V8 Combined Prelim Tape_3.22.xlsx',   date: '2024-03-22T00:00:00Z' },
  { label: '3_29',  file: 'BMARK 2024-V8 Combined Prelim Tape_3.29.xlsx',   date: '2024-03-29T00:00:00Z' },
  { label: '4_3v2', file: 'BMARK 2024-V8 Combined Prelim Tape_4.3v2.xlsx',  date: '2024-04-03T00:00:00Z' },
  { label: '4_11',  file: 'BMARK 2024-V8 Combined Prelim Tape_4.11.xlsx',   date: '2024-04-11T00:00:00Z' },
  { label: '4_19',  file: 'BMARK 2024-V8 Combined Prelim Tape_4.19.xlsx',   date: '2024-04-19T00:00:00Z' },
  { label: '4_25',  file: 'BMARK 2024-V8 Combined Prelim Tape_4.25.xlsx',   date: '2024-04-25T00:00:00Z' },
  { label: '5_2',   file: 'BMARK 2024-V8 Combined Prelim Tape_5.2.xlsx',    date: '2024-05-02T00:00:00Z' },
  { label: '5_17',  file: 'BMARK 2024-V8 Combined Prelim Tape_5.17.xlsx',   date: '2024-05-17T00:00:00Z' },
  { label: '5_23',  file: 'BMARK 2024-V8 Combined Prelim Tape_5.23.xlsx',   date: '2024-05-23T00:00:00Z' },
  { label: '5_30',  file: 'BMARK 2024-V8 Combined Prelim Tape_5.30.xlsx',   date: '2024-05-30T00:00:00Z' },
  { label: '6_4',   file: 'BMARK 2024-V8 Combined Prelim Tape_6.4.xlsx',    date: '2024-06-04T00:00:00Z' },
  { label: '6_6',   file: 'BMARK 2024-V8 Combined Prelim Tape_6.6.xlsx',    date: '2024-06-06T00:00:00Z' },
  { label: 'Final', file: 'BMARK 2024-V8 Combined Prelim Tape_Final.xlsx',  date: '2024-06-10T00:00:00Z' },
];

async function main(): Promise<void> {
  const store = new PoolStore();

  // ── Idempotency guard ───────────────────────────────────────────────────
  const existing = store.listPools().find((p) => p.shelfName === SHELF_NAME);
  if (existing !== undefined) {
    console.log('================================================================');
    console.log('seed-pool-bmark — already seeded, skipping');
    console.log('================================================================');
    console.log(`  PoolId:        ${existing.id}`);
    console.log(`  shelfName:     ${existing.shelfName}`);
    console.log(`  currentTapeId: ${existing.currentTapeId ?? '—'}`);
    console.log('');
    console.log('  To re-seed (PURGES the existing pool):');
    console.log(`    sqlite3 apps/api/data/cre.db "DELETE FROM disposition WHERE pool_id = '${existing.id}';`);
    console.log(`                                  DELETE FROM loan_membership WHERE pool_id = '${existing.id}';`);
    console.log(`                                  DELETE FROM working_tape WHERE pool_id = '${existing.id}';`);
    console.log(`                                  DELETE FROM tape WHERE pool_id = '${existing.id}';`);
    console.log(`                                  DELETE FROM loan_in_pool WHERE pool_id = '${existing.id}';`);
    console.log(`                                  DELETE FROM pool WHERE id = '${existing.id}';"`);
    store.close();
    return;
  }

  // ── Pre-flight: confirm all 13 tape files exist ─────────────────────────
  for (const t of TAPES) {
    const fp = path.join(TAPE_DIR, t.file);
    if (!fs.existsSync(fp)) {
      console.error(`  ✗ missing tape file: ${fp}`);
      console.error(`    Drop the BMARK 2024-V8 .xlsx tapes into ${TAPE_DIR} and re-run.`);
      store.close();
      process.exit(1);
    }
  }

  console.log('================================================================');
  console.log('seed-pool-bmark — real BMARK 2024-V8 reseed (13 prelim tapes)');
  console.log('================================================================');

  // ── Create the pool ─────────────────────────────────────────────────────
  const POOL_ID: PoolId = mintPoolId();
  const pool: Pool = {
    id: POOL_ID,
    shelfName: SHELF_NAME,
    vintage: VINTAGE,
    seller: 'BMARK (multi-seller: CREFI / GACC / GSMC / BMO / Barclays)',
    createdAt: TAPES[0]!.date,
    tapeIds: [],
    currentTapeId: null,
    closedAt: null,
  };
  store.createPool(pool);

  const actor = { userId: 'seed-script', displayName: 'seed-script@dev' };
  let priorTapeId: TapeId | null = null;
  let priorOriginatorRefs: Set<string> = new Set();
  let priorIncomingByRef: Map<string, IncomingTape['rows'][number]> = new Map();

  // ── Walk all 13 tapes ───────────────────────────────────────────────────
  for (let i = 0; i < TAPES.length; i++) {
    const t = TAPES[i]!;
    const version = i + 1;
    const filePath = path.join(TAPE_DIR, t.file);
    process.stdout.write(`  ${t.label.padEnd(6)} v${version.toString().padStart(2)}  …  `);

    const incoming: IncomingTape = await parseBmarkTapeXlsx(filePath, {
      poolId: POOL_ID,
      version,
      tapeDate: t.date as IncomingTape['tapeDate'],
      receivedAt: t.date as IncomingTape['receivedAt'],
      priorTapeId,
      sourceLabel: `BMARK 2024-V8 / ${t.label} (${t.date.slice(0, 10)})`,
    });

    // Phase A: ingest + reconcile.
    const a = advanceTapePhaseA(store, incoming);

    // Build Phase B inputs:
    //  - Every unmatched-needs-confirm entry → confirm-new (BMARK pools don't
    //    re-key; the normalized name is verified stable, so unmatched means new).
    //  - For each loan in priorOriginatorRefs that isn't in this tape's
    //    originatorLoanRefs → record a departure (default: clean drop).
    const wt = store.getWorkingTape(a.workingTapeId);
    if (wt === null) throw new Error('working tape vanished');

    const resolutions: Resolution[] = wt.pendingMembership
      .filter((e) => e.kind === 'unmatched-needs-confirm')
      .map((e) => ({
        kind: 'confirm-new' as const,
        tapePosition: (e as { tapePosition: number }).tapePosition,
      }));

    // Departures: prior originator refs not in this tape's rows.
    const thisRefs = new Set(incoming.rows.map((r) => r.originatorLoanRef!));
    const departedRefs = [...priorOriginatorRefs].filter((ref) => !thisRefs.has(ref));
    const departures = departedRefs.map((ref) => {
      const existingLoan = findLoanInPoolByOriginatorRef(store, POOL_ID, ref);
      // No origin/buyer label info in the source data — treat as clean drop.
      return {
        loanInPoolId: existingLoan!.id,
        originatorLabel: 'dropped' as const,
        buyerLabel:      'dropped' as const,
        reasons: [`Originator dropped on ${t.label}`],
        recordedAt: t.date,
      };
    });

    const b = advanceTapePhaseB(store, {
      workingTapeId: a.workingTapeId,
      resolutions,
      departures,
      recordedBy: actor,
      frozenAt: t.date,
    });

    const carriedCount = a.summary.carriedCount;
    const newMintCount = b.newLoanInPoolIds.length;
    const departedCount = b.dispositionIds.length;
    console.log(`${b.tape.membership.length.toString().padStart(3)} loans  ` +
                `[carried ${carriedCount.toString().padStart(3)}  +${newMintCount.toString().padStart(2)} added  -${departedCount.toString().padStart(2)} dropped]`);

    priorTapeId = b.tape.id;
    priorOriginatorRefs = thisRefs;
    priorIncomingByRef = new Map(incoming.rows.map((r) => [r.originatorLoanRef!, r]));
  }

  // ★ Derive deal_mode from the tape — the last tape's rows carry the tape-derived
  //   propertyCount per loan (Properties-per-Loan ∪ decimal-breakout count). >1 ⇒ roll_up.
  //   Manual overrides (if a servicer toggled) are preserved. Portfolio-ness comes from the
  //   source data, not a human toggle.
  const modeUpdates = deriveDealModesFromTape(store, POOL_ID, [...priorIncomingByRef.values()]);
  console.log(`  deal_mode derived from tape for ${modeUpdates} loan(s).`);

  // ── Summary ─────────────────────────────────────────────────────────────
  const finalPool = store.getPool(POOL_ID)!;
  const finalMembership = store.getMembership(finalPool.currentTapeId!);
  const allDisp: readonly Disposition[] = store.getDispositions(POOL_ID);
  const overrides = store.getOverrides(POOL_ID);

  console.log('');
  console.log('================================================================');
  console.log('seed-pool-bmark — DONE');
  console.log('================================================================');
  console.log(`  PoolId:           ${POOL_ID}`);
  console.log(`  shelfName:        ${finalPool.shelfName}`);
  console.log(`  tapes seeded:     ${TAPES.length} (v1 → v${TAPES.length})`);
  console.log(`  loans on Final:   ${finalMembership.length}`);
  console.log(`  total departures: ${allDisp.length}`);
  console.log(`  overrides:        ${overrides.length}`);
  console.log('');
  console.log('  open the rail:  http://localhost:3000/pools');

  store.close();
}

/* Helper: look up LoanInPool by originatorLoanRef within a pool. */
function findLoanInPoolByOriginatorRef(
  store: PoolStore,
  poolId: PoolId,
  originatorLoanRef: string,
): { id: LoanInPoolId } | null {
  const db = (store as unknown as {
    db: { prepare: (sql: string) => { get: (...args: unknown[]) => { id: string } | undefined } };
  }).db;
  const row = db
    .prepare(`SELECT id FROM loan_in_pool WHERE pool_id = ? AND originator_loan_ref = ?`)
    .get(poolId, originatorLoanRef);
  if (!row) return null;
  return { id: row.id as LoanInPoolId };
}

// Touch the export so the import is reachable from this module
void normalizePropertyName;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
