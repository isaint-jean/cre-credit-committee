/**
 * Reseed PR A — real BMARK 2024-V8 lineage acceptance test.
 *
 *   npx tsx apps/api/src/scripts/test-reseed-bmark-lineage.ts
 *
 * Reads the seeded BMARK 2024-V8 pool from apps/api/data/cre.db (requires the
 * seed script to have run first) and asserts the lineage matches the real
 * 13-prelim-tape biography:
 *
 *   §A  13 dated frozen tapes in chronological order.
 *   §B  Per-tape whole-loan counts: 47/59/62/50/50/47/56/50/49/48/46/45/35.
 *   §C  ★ Sunroad Centrum: present on tape 1 AND the Final tape, keyed by the
 *       SAME LoanInPoolId throughout (carry-over works), with cutOffBalance
 *       stepping $82.46M → $30M (v8) → $12.46M (v9, held to Final).
 *   §D  4_11 big-drop transition: 16 departures recorded.
 *   §E  Final tape has 35 loans; dealRef preserved as the funnel join key.
 *
 * If the seed hasn't run, skips with an honest message rather than failing
 * (the test is for the SEEDED state). The seed itself is run separately;
 * this script is a one-shot verification.
 */
import path from 'node:path';
import { PoolStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/pool-store.js';
import type { Disposition, LoanMembership } from '@cre/contracts';

const SHELF_NAME = 'BMARK 2024-V8';
const EXPECTED_COUNTS = [47, 59, 62, 50, 50, 47, 56, 50, 49, 48, 46, 45, 35];
void path; // imported in case we add path-aware seeding later

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}

console.log('================================================================');
console.log('Reseed PR A — BMARK 2024-V8 lineage acceptance');
console.log('================================================================');

const store = new PoolStore();
const pool = store.listPools().find(p => p.shelfName === SHELF_NAME);
if (pool === undefined) {
  console.log(`\n  ⚠ Seeded pool "${SHELF_NAME}" not found in apps/api/data/cre.db.`);
  console.log('    Run the seed first:');
  console.log('      cd apps/api && npx tsx src/scripts/seed-pool-bmark.ts');
  console.log('    Then re-run this test.');
  store.close();
  process.exit(0);
}

console.log(`\nFound pool: ${pool.id}  shelfName=${pool.shelfName}  vintage=${pool.vintage}`);

/* -------------------------------------------------------------------------- */
/* §A  — 13 dated frozen tapes in chronological order                         */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. 13 dated frozen tapes ---');

// Walk priorTapeId chain backward from currentTapeId
const tapes: Array<{ id: string; version: number; date: string; priorTapeId: string | null }> = [];
let cursor: string | null = pool.currentTapeId;
const MAX_WALK = 100;
for (let i = 0; cursor !== null && i < MAX_WALK; i++) {
  const t = store.getTape(cursor as never);
  if (t === null) break;
  tapes.push({ id: t.id as string, version: t.version, date: t.tapeDate as string, priorTapeId: t.priorTapeId as string | null });
  cursor = t.priorTapeId as string | null;
}
tapes.reverse(); // chronological now

assert(tapes.length === 13, `13 frozen tapes (got ${tapes.length})`);
assert(tapes[0]?.version === 1, 'first tape is v1');
assert(tapes[tapes.length - 1]?.version === 13, 'last tape is v13');

// Dates are monotonic
let monotonic = true;
for (let i = 1; i < tapes.length; i++) {
  if (tapes[i]!.date < tapes[i - 1]!.date) { monotonic = false; break; }
}
assert(monotonic, 'tape dates are monotonic (chronological)');

/* -------------------------------------------------------------------------- */
/* §B  — Per-tape whole-loan counts                                           */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. Per-tape whole-loan counts ---');
const actualCounts: number[] = [];
for (const t of tapes) {
  const m = store.getMembership(t.id as never);
  actualCounts.push(m.length);
}
console.log(`    expected: ${JSON.stringify(EXPECTED_COUNTS)}`);
console.log(`    actual:   ${JSON.stringify(actualCounts)}`);
assert(
  JSON.stringify(actualCounts) === JSON.stringify(EXPECTED_COUNTS),
  '★ per-tape counts match the recon\'s expected 47/59/62/50/50/47/56/50/49/48/46/45/35 lineage',
);

/* -------------------------------------------------------------------------- */
/* §C  — Sunroad Centrum: trackable + per-tape balance progression           */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. ★ Sunroad Centrum — carry-over + balance per tape ---');

interface SunroadHit { tapeVersion: number; loanInPoolId: string; balance: number | null }
const sunroad: SunroadHit[] = [];
for (const t of tapes) {
  const m = store.getMembership(t.id as never);
  const hit = m.find((row: LoanMembership) => row.propertyName === 'Sunroad Centrum');
  if (hit !== undefined) {
    sunroad.push({
      tapeVersion: t.version,
      loanInPoolId: hit.loanInPoolId as string,
      balance: (hit.cutOffBalance ?? null),
    });
  }
}

assert(sunroad.length === 13, `Sunroad present on all 13 tapes (got ${sunroad.length})`);
const distinctSunroadIds = new Set(sunroad.map(s => s.loanInPoolId));
assert(distinctSunroadIds.size === 1,
  `★ Sunroad's LoanInPoolId is STABLE across all 13 tapes (got ${distinctSunroadIds.size} distinct)`);

// Per-tape balance progression
const v1Balance = sunroad[0]?.balance;
const v8Balance = sunroad[7]?.balance;
const v9Balance = sunroad[8]?.balance;
const finalBalance = sunroad[sunroad.length - 1]?.balance;
assert(v1Balance === 82460000, `v1 balance = $82.46M (got ${v1Balance})`);
assert(v8Balance === 30000000, `★ v8 balance step → $30M (got ${v8Balance})`);
assert(v9Balance === 12460000, `★ v9 balance step → $12.46M (got ${v9Balance})`);
assert(finalBalance === 12460000, `Final balance held at $12.46M (got ${finalBalance})`);

/* -------------------------------------------------------------------------- */
/* §D  — 4_11 big-drop transition (the headline -16)                          */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. 4_11 transition (the -16 headline drop) ---');
// Tape 4 is 4_11. Departures recorded against leftOnTape = tape 4.
const dispositions: readonly Disposition[] = store.getDispositions(pool.id);
const fourElevenTapeId = tapes[3]?.id;
const fourElevenDepartures = dispositions.filter(d => (d.leftOnTape as string) === fourElevenTapeId);
assert(fourElevenDepartures.length === 16,
  `★ 16 departures recorded on the 4_11 transition (the big-drop tape) (got ${fourElevenDepartures.length})`);

/* -------------------------------------------------------------------------- */
/* §E  — Final tape + dealRef preserved                                       */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. Final tape + dealRef preserved ---');
const finalTape = tapes[tapes.length - 1]!;
const finalMembership = store.getMembership(finalTape.id as never);
assert(finalMembership.length === 35, `Final tape carries 35 loans (got ${finalMembership.length})`);
assert(finalMembership.every(m => typeof m.dealRef === 'string' && m.dealRef.length > 0),
  'every Final loan has dealRef (funnel join key preserved)');
assert(finalMembership.every(m => m.dealRef.startsWith('bmark2024v8-')),
  'dealRef format matches the parser convention');

// Spot check on a couple of fields denormalized properly
const finalSunroad = finalMembership.find(m => m.propertyName === 'Sunroad Centrum');
assert(finalSunroad?.cutOffBalance === 12460000, 'Sunroad cutOffBalance on Final = $12.46M');
assert(finalSunroad?.city === 'San Diego' && finalSunroad?.state === 'CA',
  'Sunroad city/state denormalized to Final membership row');
assert(finalSunroad?.propertyType === 'Office', 'Sunroad propertyType denormalized to Final membership row');

/* -------------------------------------------------------------------------- */
console.log('\n================================================================');
if (failures === 0) {
  console.log('Reseed PR A — BMARK 2024-V8 lineage: PASS — real biography seeded correctly.');
  process.exit(0);
} else {
  console.log(`Reseed PR A — BMARK 2024-V8 lineage: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}

store.close();
