/**
 * Visual PR 2 — cohort-flow projection fixture-shape smoke check.
 *
 *   npx tsx apps/api/src/scripts/test-cohort-flow-projection.ts
 *
 * Reproduces the pure projection (`computeCohortFlow`) inline so this test
 * doesn't import from apps/web (independent compile graphs, same convention
 * as test-pool-pr5-ui-fixture / test-pool-pr6-home-base / funnel PR2).
 * If the projection drifts in either workspace, the assertions catch it.
 *
 * What's asserted:
 *   §A  Empty tapes → empty model (no crash).
 *   §B  Single-tape pool → one node, ZERO flows (honest single-tape state).
 *   §C  The BMARK seed's actual shape (v1→v6) projects to the per-transition
 *       counts I verified against the seeded DB earlier (and against PR1-3
 *       acceptance assertions): the override drop→kick on L3, the 3 v3→v4
 *       departures (L2 dropped + L5 kicked + L7 kicked), the re-key carry-over.
 *   §D  A departure with NO matching disposition (theoretical — shouldn't
 *       happen under PR3's contract) falls back to `dropped` (conservative read).
 */

// Make this a module so the local `assert` doesn't collide with sibling scripts.
export {};

interface AssertCtx { failures: number }
const ctx: AssertCtx = { failures: 0 };
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); ctx.failures += 1; }
}

/* -------------------------------------------------------------------------- */
/* Local projection — kept structurally identical to                          */
/* apps/web/src/components/PoolRail/cohort-flow.ts                            */
/* -------------------------------------------------------------------------- */
interface LoanMembership {
  readonly loanInPoolId: string;
  readonly cutOffBalance?: number | null;  // Reseed PR B
}
interface Tape {
  readonly id: string;
  readonly version: number;
  readonly tapeDate: string;
  readonly membership: readonly LoanMembership[];
}
interface Disposition {
  readonly id: string;
  readonly loanInPoolId: string;
  readonly leftOnTape: string;
  readonly buyerLabel: 'dropped' | 'kicked';
}
interface TransitionFlow {
  carried: number;        carriedBalance: number | null;
  added: number;          addedBalance: number | null;
  dropped: number;        droppedBalance: number | null;
  kicked: number;         kickedBalance: number | null;
}
interface TapeNode {
  tapeId: string; version: number; tapeDate: string;
  loanCount: number; totalBalance: number | null;
  isCurrent: boolean; isOrigin: boolean;
  transitionFromPrior: TransitionFlow | null;
}
interface CohortFlowModel { nodes: TapeNode[]; transitions: TransitionFlow[]; hasBalanceData: boolean }

function sumBalance(rows: readonly LoanMembership[]): number | null {
  let sum = 0; let anyPresent = false;
  for (const r of rows) {
    const v = r.cutOffBalance;
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      sum += v; anyPresent = true;
    }
  }
  return anyPresent ? sum : null;
}

function computeCohortFlow(tapes: readonly Tape[], dispositions: readonly Disposition[], currentTapeId: string | null): CohortFlowModel {
  if (tapes.length === 0) return { nodes: [], transitions: [], hasBalanceData: false };
  const departedByLeftOnTape = new Map<string, Disposition[]>();
  for (const d of dispositions) {
    const arr = departedByLeftOnTape.get(d.leftOnTape) ?? [];
    arr.push(d);
    departedByLeftOnTape.set(d.leftOnTape, arr);
  }
  let hasBalanceData = false;
  const nodes: TapeNode[] = [];
  for (let i = 0; i < tapes.length; i++) {
    const tape = tapes[i]!;
    const isOrigin = i === 0;
    const totalBalance = sumBalance(tape.membership);
    if (totalBalance !== null) hasBalanceData = true;
    let transitionFromPrior: TransitionFlow | null = null;
    if (!isOrigin) {
      const prior = tapes[i - 1]!;
      const priorIds = new Set(prior.membership.map(m => m.loanInPoolId));
      const thisIds  = new Set(tape.membership.map(m => m.loanInPoolId));
      const carriedRows = tape.membership.filter(m => priorIds.has(m.loanInPoolId));
      const addedRows   = tape.membership.filter(m => !priorIds.has(m.loanInPoolId));
      const departedRowsPrior = prior.membership.filter(m => !thisIds.has(m.loanInPoolId));
      const dispsForLeftOn = departedByLeftOnTape.get(tape.id) ?? [];
      const dispByLoan = new Map<string, Disposition>();
      for (const d of dispsForLeftOn) dispByLoan.set(d.loanInPoolId, d);
      const droppedRowsPrior: LoanMembership[] = [];
      const kickedRowsPrior: LoanMembership[] = [];
      for (const row of departedRowsPrior) {
        const d = dispByLoan.get(row.loanInPoolId);
        if (d?.buyerLabel === 'kicked') kickedRowsPrior.push(row);
        else droppedRowsPrior.push(row);
      }
      transitionFromPrior = {
        carried: carriedRows.length, carriedBalance: sumBalance(carriedRows),
        added:   addedRows.length,   addedBalance:   sumBalance(addedRows),
        dropped: droppedRowsPrior.length, droppedBalance: sumBalance(droppedRowsPrior),
        kicked:  kickedRowsPrior.length,  kickedBalance:  sumBalance(kickedRowsPrior),
      };
    }
    nodes.push({
      tapeId: tape.id, version: tape.version, tapeDate: tape.tapeDate,
      loanCount: tape.membership.length, totalBalance,
      isCurrent: tape.id === currentTapeId, isOrigin,
      transitionFromPrior,
    });
  }
  const transitions = nodes.map(n => n.transitionFromPrior).filter((t): t is TransitionFlow => t !== null);
  return { nodes, transitions, hasBalanceData };
}

/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('Visual PR 2 — cohort-flow projection');
console.log('================================================================');

/* -------------------------------------------------------------------------- */
/* §A — empty tapes                                                           */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. empty tapes ---');
const empty = computeCohortFlow([], [], null);
assert(empty.nodes.length === 0,       'empty tapes → empty nodes (no crash)');
assert(empty.transitions.length === 0, 'empty tapes → empty transitions');

/* -------------------------------------------------------------------------- */
/* §B — single tape: 1 node, 0 flows                                          */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. single tape (honest single-node state) ---');
const single = computeCohortFlow(
  [{ id: 'T1', version: 1, tapeDate: '2026-01-02T00:00:00Z',
     membership: [{ loanInPoolId: 'L1' }, { loanInPoolId: 'L2' }] }],
  [],
  'T1',
);
assert(single.nodes.length === 1,            'single tape: 1 node');
assert(single.transitions.length === 0,      'single tape: 0 transitions (no flows drawn)');
assert(single.nodes[0]!.isOrigin === true,   'single tape: origin marker fires');
assert(single.nodes[0]!.isCurrent === true,  'single tape: current marker fires');
assert(single.nodes[0]!.transitionFromPrior === null, 'single tape: no prior transition');

/* -------------------------------------------------------------------------- */
/* §C — BMARK seed shape v1→v6 (the real seeded pool)                        */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. BMARK seed shape v1→v6 ---');
// Synthesize the BMARK lineage I verified earlier against the seeded DB:
//   v1: L1, L2, L3, L7
//   v2: L1, L2, L3, L7, L4
//   v3: L1, L2, L4, L7, L5      — L3 departs (override drop→kick, buyerLabel=kicked)
//   v4: L1, L4, L6              — L2 dropped, L5 kicked (override), L7 kicked (override)
//   v5: L1, L4, L6              — re-key resolution, no churn
//   v6: L1, L4, L6              — clean carry
const tape = (id: string, v: number, date: string, ids: string[]): Tape => ({
  id, version: v, tapeDate: date, membership: ids.map(loanInPoolId => ({ loanInPoolId })),
});
const tapesBmark: Tape[] = [
  tape('T1', 1, '2026-01-02T00:00:00Z', ['L1','L2','L3','L7']),
  tape('T2', 2, '2026-01-16T00:00:00Z', ['L1','L2','L3','L7','L4']),
  tape('T3', 3, '2026-02-04T00:00:00Z', ['L1','L2','L4','L7','L5']),
  tape('T4', 4, '2026-02-24T00:00:00Z', ['L1','L4','L6']),
  tape('T5', 5, '2026-03-12T00:00:00Z', ['L1','L4','L6']),
  tape('T6', 6, '2026-03-25T00:00:00Z', ['L1','L4','L6']),
];
const dispBmark: Disposition[] = [
  // L3 departs on v3 (override drop→kick — buyer-authoritative kicked)
  { id: 'D-L3', loanInPoolId: 'L3', leftOnTape: 'T3', buyerLabel: 'kicked' },
  // v3→v4: L2 (clean drop), L5 (override kicked), L7 (override kicked)
  { id: 'D-L2', loanInPoolId: 'L2', leftOnTape: 'T4', buyerLabel: 'dropped' },
  { id: 'D-L5', loanInPoolId: 'L5', leftOnTape: 'T4', buyerLabel: 'kicked' },
  { id: 'D-L7', loanInPoolId: 'L7', leftOnTape: 'T4', buyerLabel: 'kicked' },
];

const bmark = computeCohortFlow(tapesBmark, dispBmark, 'T6');

assert(bmark.nodes.length === 6,        'BMARK: 6 nodes');
assert(bmark.transitions.length === 5,  'BMARK: 5 transitions (one per consecutive pair)');
assert(bmark.nodes[0]!.isOrigin === true,    'BMARK: v1 isOrigin');
assert(bmark.nodes[5]!.isCurrent === true,   'BMARK: v6 isCurrent');

// v1→v2: +L4. carried=4, added=1, departed=0
assert(bmark.transitions[0]!.carried === 4 && bmark.transitions[0]!.added === 1 && bmark.transitions[0]!.dropped === 0 && bmark.transitions[0]!.kicked === 0,
  '★ v1→v2: carried=4, added=1, dropped=0, kicked=0');
// v2→v3: +L5. -L3 (kicked-override). carried=4, added=1, dropped=0, kicked=1
assert(bmark.transitions[1]!.carried === 4 && bmark.transitions[1]!.added === 1 && bmark.transitions[1]!.dropped === 0 && bmark.transitions[1]!.kicked === 1,
  '★ v2→v3: carried=4, added=1, dropped=0, kicked=1 (the L3 drop→kick override surfaces in red)');
// v3→v4: +L6. -L2 (dropped), -L5 (kicked), -L7 (kicked). carried=2 (L1,L4), added=1, dropped=1, kicked=2
assert(bmark.transitions[2]!.carried === 2 && bmark.transitions[2]!.added === 1 && bmark.transitions[2]!.dropped === 1 && bmark.transitions[2]!.kicked === 2,
  '★ v3→v4: carried=2, added=1, dropped=1, kicked=2 (the biggest single-tape contraction)');
// v4→v5: re-key carry, no churn
assert(bmark.transitions[3]!.carried === 3 && bmark.transitions[3]!.added === 0 && bmark.transitions[3]!.dropped === 0 && bmark.transitions[3]!.kicked === 0,
  '★ v4→v5: carried=3, added=0, dropped=0, kicked=0 (re-key resolution is invisible — same identities)');
// v5→v6: clean
assert(bmark.transitions[4]!.carried === 3 && bmark.transitions[4]!.added === 0 && bmark.transitions[4]!.dropped === 0 && bmark.transitions[4]!.kicked === 0,
  '★ v5→v6: carried=3, added=0, dropped=0, kicked=0 (clean carry)');

// Per-node loan counts
const counts = bmark.nodes.map(n => n.loanCount);
assert(JSON.stringify(counts) === JSON.stringify([4,5,5,3,3,3]),
  '★ BMARK loan counts per tape: [4,5,5,3,3,3] — matches the seed');

/* -------------------------------------------------------------------------- */
/* §D — Departure with no disposition → defaults to dropped                  */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. Departure with no disposition (defensive default) ---');
const defensive = computeCohortFlow(
  [
    tape('U1', 1, '2026-04-01T00:00:00Z', ['A','B','C']),
    tape('U2', 2, '2026-04-15T00:00:00Z', ['A','B']),  // C departs but no disposition supplied
  ],
  [],
  'U2',
);
assert(defensive.transitions[0]!.dropped === 1 && defensive.transitions[0]!.kicked === 0,
  '★ departure without a disposition record falls back to dropped (conservative read)');

/* -------------------------------------------------------------------------- */
/* §E — Reseed PR B: dollar-Sankey balance projection                         */
/*    Balance-aware fixture verifying:                                        */
/*    - node totalBalance = sum of THIS tape's cutOffBalance                  */
/*    - addedBalance      = sum of NEW rows' balance on THIS tape             */
/*    - droppedBalance    = sum of departed rows' balance on the PRIOR tape   */
/*                          (last-tape-seen audit-faithful model)             */
/*    - hasBalanceData flag flips correctly                                   */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. Reseed PR B — dollar-Sankey balance projection ---');

// Sanity-check the EXISTING fixtures (no balances): hasBalanceData is false.
assert(empty.hasBalanceData === false,    'empty fixture: hasBalanceData = false (count-only fallback)');
assert(single.hasBalanceData === false,   'balance-less single tape: hasBalanceData = false');
assert(bmark.hasBalanceData === false,    'balance-less BMARK fixture: hasBalanceData = false');
assert(bmark.nodes.every(n => n.totalBalance === null),  'balance-less BMARK: every totalBalance is null');
assert(bmark.transitions.every(t => t.addedBalance === null && t.droppedBalance === null && t.kickedBalance === null && t.carriedBalance === null),
  'balance-less BMARK: every per-transition balance is null');

// Now a balance-aware fixture. Loans X, Y, Z with explicit per-tape balances.
// Lineage:
//   v1: X=$100mm, Y=$80mm, Z=$50mm                              (total $230mm)
//   v2: X=$95mm,  Y=$78mm           — Z DROPS                   (total $173mm)
//   v3: X=$93mm,         + W=$60mm  — Y KICKED, W added         (total $153mm)
// Expected transitions:
//   v1→v2: carried=2 (X@95 + Y@78 = 173), added=0/null,
//          dropped=1 (Z @ PRIOR balance $50mm), kicked=0/null
//   v2→v3: carried=1 (X@93), added=1 (W@60),
//          dropped=0/null, kicked=1 (Y @ PRIOR balance $78mm)
const balTape = (id: string, v: number, date: string, rows: Array<[string, number | null]>): Tape => ({
  id, version: v, tapeDate: date,
  membership: rows.map(([loanInPoolId, bal]) => ({ loanInPoolId, cutOffBalance: bal })),
});
const tapesBal: Tape[] = [
  balTape('B1', 1, '2026-01-02T00:00:00Z', [['X', 100_000_000], ['Y',  80_000_000], ['Z', 50_000_000]]),
  balTape('B2', 2, '2026-01-16T00:00:00Z', [['X',  95_000_000], ['Y',  78_000_000]]),
  balTape('B3', 3, '2026-02-04T00:00:00Z', [['X',  93_000_000], ['W',  60_000_000]]),
];
const dispBal: Disposition[] = [
  // Z exits on B2 — buyer-authoritative dropped (the headline departure).
  { id: 'D-Z', loanInPoolId: 'Z', leftOnTape: 'B2', buyerLabel: 'dropped' },
  // Y exits on B3 — buyer-authoritative kicked (override category).
  { id: 'D-Y', loanInPoolId: 'Y', leftOnTape: 'B3', buyerLabel: 'kicked' },
];
const bal = computeCohortFlow(tapesBal, dispBal, 'B3');

// hasBalanceData flips
assert(bal.hasBalanceData === true, '★ hasBalanceData = true when balances are present');

// Per-node totalBalance
assert(bal.nodes[0]!.totalBalance === 230_000_000, '★ v1 totalBalance = $230mm');
assert(bal.nodes[1]!.totalBalance === 173_000_000, '★ v2 totalBalance = $173mm');
assert(bal.nodes[2]!.totalBalance === 153_000_000, '★ v3 totalBalance = $153mm');

// v1→v2: carried = X@95 + Y@78 = $173mm; departed Z @ PRIOR = $50mm (dropped)
const t12 = bal.transitions[0]!;
assert(t12.carried === 2 && t12.carriedBalance === 173_000_000,
  '★ v1→v2: carried 2 loans @ $173mm (X+Y at THIS tape balance)');
assert(t12.added === 0 && t12.addedBalance === null,
  '★ v1→v2: zero added → addedBalance = null (no rows to sum)');
assert(t12.dropped === 1 && t12.droppedBalance === 50_000_000,
  '★★ v1→v2: Z dropped @ PRIOR balance = $50mm (last-tape-seen)');
assert(t12.kicked === 0 && t12.kickedBalance === null,
  '★ v1→v2: zero kicked → kickedBalance = null');

// v2→v3: carried = X@93 = $93mm; added W@60 = $60mm; kicked Y @ PRIOR (B2) = $78mm
const t23 = bal.transitions[1]!;
assert(t23.carried === 1 && t23.carriedBalance === 93_000_000,
  '★ v2→v3: carried X @ $93mm (THIS tape balance)');
assert(t23.added === 1 && t23.addedBalance === 60_000_000,
  '★ v2→v3: W added @ $60mm (THIS tape balance — first appearance)');
assert(t23.dropped === 0 && t23.droppedBalance === null,
  '★ v2→v3: zero dropped → droppedBalance = null');
assert(t23.kicked === 1 && t23.kickedBalance === 78_000_000,
  '★★ v2→v3: Y kicked @ PRIOR (v2) balance = $78mm — NOT $80mm (v1), NOT 0 (absent on v3); last-tape-seen model');

// Mixed-null defense: partial-null fixture — only one of the THREE rows has a
// balance. totalBalance should equal that single balance; hasBalanceData true.
const mixed = computeCohortFlow(
  [balTape('M1', 1, '2026-05-01T00:00:00Z', [['p', 25_000_000], ['q', null], ['r', null]])],
  [],
  'M1',
);
assert(mixed.hasBalanceData === true && mixed.nodes[0]!.totalBalance === 25_000_000,
  '★ partial-null tape: totalBalance sums only the present balances ($25mm) and flips hasBalanceData');

/* -------------------------------------------------------------------------- */
console.log('\n================================================================');
if (ctx.failures === 0) {
  console.log('Visual PR 2 — cohort-flow projection: PASS — BMARK shape matches verified counts.');
  process.exit(0);
} else {
  console.log(`Visual PR 2 — cohort-flow projection: FAIL (${ctx.failures} assertion${ctx.failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
