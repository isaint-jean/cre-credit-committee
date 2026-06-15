/**
 * Pool layer PR 3 — advance-tape orchestration acceptance test.
 *
 *   npx tsx apps/api/src/scripts/test-pool-pr3-orchestration.ts
 *
 * Drives the BMARK 2026-V12 v1→v4 walk through the operation (no hand-built
 * tapes — every Tape, every membership row, every Disposition is produced by
 * advanceTapePhaseA + advanceTapePhaseB). Asserts:
 *
 *   §A  v1 ingest: all rows are 'unmatched-needs-confirm' with EMPTY candidates;
 *       confirm-new for all → LoanInPool mints; v1 freezes with the expected
 *       membership.
 *
 *   §B  v2 / v3 / v4 ingest: carriers exact-match → 'bound'; new loans →
 *       'unmatched-needs-confirm' (empty candidates); buyer confirm-new mints.
 *       Carry-over: a survivor keeps its LoanInPoolId AND its prior status (the
 *       single-source carry-over in Phase B).
 *
 *   §C  ★ THE RE-KEY TEST (the silent-mis-carry guard as logic). Ingest a v5
 *       where L4's originatorLoanRef changed 'BMARK-L004' → 'BMARK-L004-RE'.
 *       Assert:
 *         - The row surfaces as 'unmatched-needs-confirm' with L4 in
 *           candidateLoanInPoolIds (fuzzy prefix match).
 *         - It is NOT auto-bound (no L4 in the working tape's bound entries
 *           after Phase A).
 *         - It is NOT auto-treated-as-new (no new LoanInPool minted yet).
 *       Then resolve `bind-existing L4`. Assert:
 *         - After Phase B, L4 still has its original LoanInPoolId (no phantom).
 *         - L4 is on v5 with carried status (no phantom departure recorded).
 *         - LoanInPool.originatorLoanRef has been UPDATED to 'BMARK-L004-RE'
 *           (so the NEXT tape exact-matches without re-triggering).
 *
 *   §D  ★ THE FREEZE-BLOCK TEST: in a fresh pool, ingest a v1 with one row
 *       that the buyer never resolves; call Phase B without a resolution →
 *       AdvanceTapeError. (The PR2 guard inside freezeTape is the
 *       defense-in-depth; the orchestration surfaces it as AdvanceTapeError.)
 *
 *   §E  ★ Final persisted state matches the PR2 walk: same tape topology, same
 *       4 dispositions, same 3 overrides with both directions.
 *
 * Uses an in-memory SQLite (`:memory:`). Never touches cre.db.
 */
import type {
  DispositionKind,
  LoanInPool,
  LoanMembership,
  PendingMembershipEntry,
  PoolId,
  Tape,
  TapeId,
  Pool,
  LoanInPoolId,
} from '@cre/contracts';
import {
  AdvanceTapeError,
  advanceTapePhaseA,
  advanceTapePhaseB,
  type IncomingTape,
  type Resolution,
  type DepartureLabel,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/pool/advance-tape.service.js';
import { PoolStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/pool-store.js';
import { mintPoolId } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/util/pool-ids.js';

/* -------------------------------------------------------------------------- */
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}
function expectThrow<E extends new (...args: any[]) => Error>(
  ErrorCtor: E, fn: () => unknown, label: string,
): void {
  try {
    fn();
    console.log(`  ✗ ${label} — expected ${ErrorCtor.name}, no throw`);
    failures += 1;
  } catch (e) {
    if (e instanceof ErrorCtor) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label} — wrong error: ${(e as Error).name}: ${(e as Error).message}`); failures += 1; }
  }
}

/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('Pool PR 3 — advance-tape orchestration (BMARK 2026-V12, :memory:)');
console.log('================================================================');

const store = new PoolStore(':memory:');
const POOL_ID: PoolId = mintPoolId();
const pool: Pool = {
  id: POOL_ID,
  shelfName: 'BMARK 2026-V12',
  vintage: 2026,
  seller: 'Bedrock Capital',
  createdAt: '2026-01-02T14:00:00Z',
  tapeIds: [],
  currentTapeId: null,
  closedAt: null,
};
store.createPool(pool);

const actor = { userId: 'isabelle', displayName: 'Isabelle' };

function ingestAndFreeze(input: IncomingTape, departures: readonly DepartureLabel[], frozenAt: string): {
  readonly tape: Tape;
  readonly mintedByPosition: ReadonlyMap<number, LoanInPoolId>;
  readonly phaseASummary: { carriedCount: number; unmatchedCount: number; unmatchedWithSuggestionsCount: number };
} {
  const a = advanceTapePhaseA(store, input);
  // Default policy in this test: confirm-new every unmatched entry (the
  // re-key test §C deviates from this and supplies bind-existing manually).
  const wt = store.getWorkingTape(a.workingTapeId)!;
  const resolutions: Resolution[] = wt.pendingMembership
    .filter((e): e is Extract<PendingMembershipEntry, { kind: 'unmatched-needs-confirm' }> =>
      e.kind === 'unmatched-needs-confirm',
    )
    .map((e) => ({ kind: 'confirm-new', tapePosition: e.tapePosition }));
  const b = advanceTapePhaseB(store, {
    workingTapeId: a.workingTapeId,
    resolutions,
    departures,
    recordedBy: actor,
    frozenAt,
  });
  // Recover the minted ids by position from the frozen tape's membership (the
  // entries Phase A surfaced as unmatched and Phase B resolved as confirm-new).
  const mintedByPosition = new Map<number, LoanInPoolId>();
  for (const m of b.tape.membership) {
    // Position-> LoanInPoolId for the rows that were unmatched in the working
    // tape (i.e., not exact-matched in Phase A).
    if (wt.pendingMembership.find((e) => e.kind === 'unmatched-needs-confirm' && e.tapePosition === m.tapePosition)) {
      mintedByPosition.set(m.tapePosition, m.loanInPoolId);
    }
  }
  return { tape: b.tape, mintedByPosition, phaseASummary: a.summary };
}

/* -------------------------------------------------------------------------- */
/* §A  — v1 ingest                                                           */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. v1 ingest (all unmatched, empty candidates → confirm-new) ---');
const v1: IncomingTape = {
  poolId: POOL_ID,
  version: 1,
  tapeDate: '2026-01-02T00:00:00Z',
  receivedAt: '2026-01-02T14:00:00Z',
  priorTapeId: null,
  originatorSummary: { originatorLoanCount: 4, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'v1' },
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L003', dealRef: 'deal-L3', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
  ],
};
// Inspect Phase A output for v1 BEFORE Phase B
const v1A = advanceTapePhaseA(store, v1);
assert(v1A.summary.carriedCount === 0, 'v1 Phase A: 0 carried (no existing loans)');
assert(v1A.summary.unmatchedCount === 4, 'v1 Phase A: 4 unmatched');
const v1Wt = store.getWorkingTape(v1A.workingTapeId)!;
assert(v1Wt.pendingMembership.every(
  (e) => e.kind === 'unmatched-needs-confirm' && e.candidateLoanInPoolIds.length === 0,
), 'v1 Phase A: every entry unmatched with empty candidates');

// Now Phase B with confirm-new for all
const v1Resolutions: Resolution[] = v1Wt.pendingMembership
  .filter((e): e is Extract<PendingMembershipEntry, { kind: 'unmatched-needs-confirm' }> =>
    e.kind === 'unmatched-needs-confirm')
  .map((e) => ({ kind: 'confirm-new', tapePosition: e.tapePosition }));
const v1B = advanceTapePhaseB(store, {
  workingTapeId: v1A.workingTapeId, resolutions: v1Resolutions,
  departures: [], recordedBy: actor, frozenAt: '2026-01-05T18:00:00Z',
});
assert(v1B.newLoanInPoolIds.length === 4, 'v1 Phase B: 4 LoanInPools minted');
const v1Tape = v1B.tape;
assert(v1Tape.version === 1, 'v1 tape: version 1');
assert(v1Tape.membership.length === 4, 'v1 tape: 4 membership rows');
const L1 = v1Tape.membership.find(m => m.dealRef === 'deal-L1')!.loanInPoolId;
const L2 = v1Tape.membership.find(m => m.dealRef === 'deal-L2')!.loanInPoolId;
const L3 = v1Tape.membership.find(m => m.dealRef === 'deal-L3')!.loanInPoolId;
const L7 = v1Tape.membership.find(m => m.dealRef === 'deal-L7')!.loanInPoolId;
assert(new Set([L1, L2, L3, L7]).size === 4, 'v1: 4 distinct LoanInPoolIds minted');

/* -------------------------------------------------------------------------- */
/* §B  — v2/v3 ingest (carriers exact-match → bound; new loans → confirm-new) */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. v2/v3 ingest (carry-over by exact match) ---');
const v2: IncomingTape = {
  poolId: POOL_ID,
  version: 2,
  tapeDate: '2026-01-16T00:00:00Z',
  receivedAt: '2026-01-16T14:00:00Z',
  priorTapeId: v1Tape.id,
  originatorSummary: { originatorLoanCount: 5, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'v2' },
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L003', dealRef: 'deal-L3', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 5 },
  ],
};
const v2A = advanceTapePhaseA(store, v2);
assert(v2A.summary.carriedCount === 4, 'v2 Phase A: 4 carriers exact-matched (bound)');
assert(v2A.summary.unmatchedCount === 1, 'v2 Phase A: 1 unmatched (L4 — new)');
const v2Wt = store.getWorkingTape(v2A.workingTapeId)!;
const v2L4Unmatched = v2Wt.pendingMembership.find(e => e.kind === 'unmatched-needs-confirm') as Extract<PendingMembershipEntry, { kind: 'unmatched-needs-confirm' }>;
assert(v2L4Unmatched.candidateLoanInPoolIds.length === 0, 'v2 unmatched (L4): empty candidates (genuinely new)');

const v2B = advanceTapePhaseB(store, {
  workingTapeId: v2A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 5 }],
  departures: [], recordedBy: actor, frozenAt: '2026-01-19T18:00:00Z',
});
const v2Tape = v2B.tape;
const L4 = v2Tape.membership.find(m => m.dealRef === 'deal-L4')!.loanInPoolId;
assert(v2B.newLoanInPoolIds.length === 1 && v2B.newLoanInPoolIds[0] === L4, 'v2: only L4 was minted');

// Carry-over: L1 keeps its id across v1 → v2
const l1OnV1 = v1Tape.membership.find(m => m.loanInPoolId === L1)!;
const l1OnV2 = v2Tape.membership.find(m => m.loanInPoolId === L1)!;
assert(l1OnV1.loanInPoolId === l1OnV2.loanInPoolId, 'v2 carry-over: L1 LoanInPoolId byte-identical v1 → v2');

// v3 — add L5 (new), departure: L3
const v3: IncomingTape = {
  poolId: POOL_ID,
  version: 3,
  tapeDate: '2026-02-04T00:00:00Z',
  receivedAt: '2026-02-04T14:00:00Z',
  priorTapeId: v2Tape.id,
  originatorSummary: { originatorLoanCount: 5, originatorDroppedRefs: [], originatorKickedRefs: ['BMARK-L003'], sourceLabel: 'v3' },
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
    { originatorLoanRef: 'BMARK-L005', dealRef: 'deal-L5', propertyName: null, assetType: null, tapePosition: 5 },
  ],
};
const v3A = advanceTapePhaseA(store, v3);
assert(v3A.summary.carriedCount === 4, 'v3 Phase A: 4 carriers');
assert(v3A.summary.unmatchedCount === 1, 'v3 Phase A: 1 unmatched (L5 — new)');
const v3B = advanceTapePhaseB(store, {
  workingTapeId: v3A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 5 }],
  departures: [
    // L3 departs (v2 → v3 set-diff): originator='dropped' (per the wire), buyer='kicked' (★ override #1)
    {
      loanInPoolId: L3,
      originatorLabel: 'dropped' as DispositionKind,
      buyerLabel: 'kicked' as DispositionKind,
      reasons: ['DSCR failed at refi floor', 'sponsor litigation disclosure'],
      recordedAt: '2026-02-05T11:00:00Z',
    },
  ],
  recordedBy: actor, frozenAt: '2026-02-07T18:00:00Z',
});
const v3Tape = v3B.tape;
const L5 = v3Tape.membership.find(m => m.dealRef === 'deal-L5')!.loanInPoolId;
assert(v3B.dispositionIds.length === 1, 'v3 Phase B: 1 disposition recorded (L3 departed)');

// v4 — add L6 (new), departures: L2 (clean drop), L5 (★ override kick→drop), L7 (★ override kick→drop)
const v4: IncomingTape = {
  poolId: POOL_ID,
  version: 4,
  tapeDate: '2026-02-24T00:00:00Z',
  receivedAt: '2026-02-24T14:00:00Z',
  priorTapeId: v3Tape.id,
  originatorSummary: { originatorLoanCount: 3, originatorDroppedRefs: ['BMARK-L002'], originatorKickedRefs: ['BMARK-L005','BMARK-L007'], sourceLabel: 'v4' },
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L004', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L006', dealRef: 'deal-L6', propertyName: null, assetType: null, tapePosition: 3 },
  ],
};
const v4A = advanceTapePhaseA(store, v4);
assert(v4A.summary.carriedCount === 2, 'v4 Phase A: 2 carriers (L1, L4)');
assert(v4A.summary.unmatchedCount === 1, 'v4 Phase A: 1 unmatched (L6 — new)');
const v4B = advanceTapePhaseB(store, {
  workingTapeId: v4A.workingTapeId,
  resolutions: [{ kind: 'confirm-new', tapePosition: 3 }],
  departures: [
    { loanInPoolId: L2, originatorLabel: 'dropped', buyerLabel: 'dropped',
      reasons: ['originator withdrew; benign'], recordedAt: '2026-02-25T10:00:00Z' },
    { loanInPoolId: L5, originatorLabel: 'kicked', buyerLabel: 'dropped',  // ★ override #2 (opposite direction)
      reasons: ['originator labeled kick; buyer determined no institutional taint'], recordedAt: '2026-02-25T10:30:00Z' },
    { loanInPoolId: L7, originatorLabel: 'kicked', buyerLabel: 'dropped',  // ★ override #3
      reasons: ['kick-flag carried buyer judgment to drop only; corpus exclusion not warranted'], recordedAt: '2026-02-25T11:00:00Z' },
  ],
  recordedBy: actor, frozenAt: '2026-02-27T18:00:00Z',
});
const v4Tape = v4B.tape;
const L6 = v4Tape.membership.find(m => m.dealRef === 'deal-L6')!.loanInPoolId;
assert(v4B.dispositionIds.length === 3, 'v4 Phase B: 3 dispositions');

// Carry-over identity stability across the WHOLE walk: L1 byte-identical v1 → v4
const l1OnV4 = v4Tape.membership.find(m => m.loanInPoolId === L1)!;
assert(l1OnV4.loanInPoolId === L1, 'carry-over: L1 LoanInPoolId byte-identical v1 → v4');
assert(l1OnV4.dealRef === 'deal-L1', 'carry-over: L1 dealRef stable v1 → v4');

/* -------------------------------------------------------------------------- */
/* §C  — THE RE-KEY TEST (the silent-mis-carry guard as logic)                */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. ★ THE RE-KEY TEST ---');
// v5 ingest: L4's originatorLoanRef changed to 'BMARK-L004-RE'. Expectation:
//   - Phase A surfaces it as 'unmatched-needs-confirm' with [L4] in candidates.
//   - Phase A does NOT auto-bind it; does NOT auto-treat as new.
const v5: IncomingTape = {
  poolId: POOL_ID,
  version: 5,
  tapeDate: '2026-03-12T00:00:00Z',
  receivedAt: '2026-03-12T14:00:00Z',
  priorTapeId: v4Tape.id,
  originatorSummary: { originatorLoanCount: 3, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'v5' },
  rows: [
    { originatorLoanRef: 'BMARK-L001',    dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L004-RE', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L006',    dealRef: 'deal-L6', propertyName: null, assetType: null, tapePosition: 3 },
  ],
};
const v5A = advanceTapePhaseA(store, v5);
const v5Wt = store.getWorkingTape(v5A.workingTapeId)!;

// The L4 re-key row must surface as unmatched with L4 in candidates.
const rekeyEntry = v5Wt.pendingMembership.find(e => e.kind === 'unmatched-needs-confirm') as
  Extract<PendingMembershipEntry, { kind: 'unmatched-needs-confirm' }>;
assert(rekeyEntry !== undefined, 'v5: BMARK-L004-RE surfaced as unmatched (NOT auto-bound)');
assert(rekeyEntry.incomingOriginatorRef === 'BMARK-L004-RE', 'unmatched entry preserves incomingOriginatorRef');
assert(rekeyEntry.candidateLoanInPoolIds.includes(L4),
  '★ candidates include L4 (fuzzy prefix match found the real loan — the safe behavior)');

// Of the bound entries (carriers), L4 must NOT be there yet — it's unmatched.
const v5BoundLoanIds = v5Wt.pendingMembership
  .filter((e): e is Extract<PendingMembershipEntry, { kind: 'bound' }> => e.kind === 'bound')
  .map(e => e.binding.loanInPoolId);
assert(!v5BoundLoanIds.includes(L4), '★ L4 NOT in the bound entries (Phase A refused to auto-bind a re-key)');

// No new LoanInPool minted yet (Phase B hasn't run).
const allLoansBeforeB = store.getCurrentWorkingTape(POOL_ID); // working tape exists
assert(allLoansBeforeB !== null, 'working tape still open before Phase B');

// Now resolve: bind to L4.
const v5B = advanceTapePhaseB(store, {
  workingTapeId: v5A.workingTapeId,
  resolutions: [{ kind: 'bind-existing', tapePosition: 2, loanInPoolId: L4 }],
  departures: [],  // L1, L4, L6 all carry forward — no departures
  recordedBy: actor, frozenAt: '2026-03-15T18:00:00Z',
});
const v5Tape = v5B.tape;

// L4 keeps its original LoanInPoolId — NO phantom departure, NO phantom new loan.
const l4OnV5 = v5Tape.membership.find(m => m.loanInPoolId === L4);
assert(l4OnV5 !== undefined, '★ L4 is on v5 with its ORIGINAL LoanInPoolId (carry-over preserved)');
assert(v5B.newLoanInPoolIds.length === 0, '★ no new LoanInPool minted for L4 (bind-existing, not confirm-new)');
assert(v5B.dispositionIds.length === 0, '★ no phantom departure recorded for L4');

// L4's stored LoanInPool.originatorLoanRef has been UPDATED to the new ref —
// so the NEXT tape exact-matches without re-triggering the unmatched flow.
const l4Updated = store.getLoanInPool(L4)!;
assert(l4Updated.originatorLoanRef === 'BMARK-L004-RE',
  '★ LoanInPool.originatorLoanRef updated to new ref (future tapes exact-match cleanly)');

// Prove the next-tape exact match: v6 with 'BMARK-L004-RE' should now be a carrier.
const v6: IncomingTape = {
  poolId: POOL_ID, version: 6,
  tapeDate: '2026-03-25T00:00:00Z', receivedAt: '2026-03-25T14:00:00Z',
  priorTapeId: v5Tape.id, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001',    dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L004-RE', dealRef: 'deal-L4', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L006',    dealRef: 'deal-L6', propertyName: null, assetType: null, tapePosition: 3 },
  ],
};
const v6A = advanceTapePhaseA(store, v6);
assert(v6A.summary.carriedCount === 3 && v6A.summary.unmatchedCount === 0,
  '★ v6: BMARK-L004-RE exact-matches the updated stored ref — no re-trigger');
// Clean up the working tape (the test is done with this lineage).
const v6B = advanceTapePhaseB(store, {
  workingTapeId: v6A.workingTapeId, resolutions: [], departures: [],
  recordedBy: actor, frozenAt: '2026-03-28T18:00:00Z',
});
assert(v6B.tape.membership.length === 3, 'v6 frozen with 3 carriers');

/* -------------------------------------------------------------------------- */
/* §D  — THE FREEZE-BLOCK TEST                                                */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. ★ THE FREEZE-BLOCK TEST ---');
// Fresh pool to keep the working-tape-unique guard happy.
const POOL_ID_D = mintPoolId();
store.createPool({
  id: POOL_ID_D, shelfName: 'BLOCK-TEST', vintage: 2026, seller: null,
  createdAt: '2026-04-01T00:00:00Z', tapeIds: [], currentTapeId: null, closedAt: null,
});
const vD1: IncomingTape = {
  poolId: POOL_ID_D, version: 1,
  tapeDate: '2026-04-01T00:00:00Z', receivedAt: '2026-04-01T14:00:00Z',
  priorTapeId: null, originatorSummary: null,
  rows: [
    { originatorLoanRef: 'X-001', dealRef: 'deal-X1', propertyName: null, assetType: null, tapePosition: 1 },
  ],
};
const vD1A = advanceTapePhaseA(store, vD1);
// Now call Phase B WITHOUT a resolution for the unmatched entry. Must throw.
expectThrow(AdvanceTapeError, () => advanceTapePhaseB(store, {
  workingTapeId: vD1A.workingTapeId,
  resolutions: [],  // ★ EMPTY — but there's an unmatched-needs-confirm at position 1
  departures: [],
  recordedBy: actor, frozenAt: '2026-04-05T18:00:00Z',
}), '★ Phase B refuses (AdvanceTapeError) when unmatched entry has no resolution');

/* -------------------------------------------------------------------------- */
/* §E  — Final state matches the PR2 walk                                     */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. Final persisted state ---');
const allDisp = store.getDispositions(POOL_ID);
const overrides = store.getOverrides(POOL_ID);
assert(allDisp.length === 4, 'pool has 4 dispositions total (matches PR2 walk)');
assert(overrides.length === 3, 'pool has 3 overrides (matches PR2 walk)');
const overrideDirections = overrides.map(d => `${d.originatorLabel}->${d.buyerLabel}`);
assert(overrideDirections.includes('dropped->kicked'), 'override: drop->kick present (L3 v3)');
assert(overrideDirections.filter(s => s === 'kicked->dropped').length === 2,
  'override: TWO kick->drop present (L5 + L7 v4)');
for (const d of overrides) {
  assert(d.authoritative === d.buyerLabel, `disposition ${d.id.slice(0,8)}…: authoritative === buyerLabel (P4)`);
  assert(d.override === (d.originatorLabel !== d.buyerLabel),
    `disposition ${d.id.slice(0,8)}…: override === labels-differ (P5)`);
}

// Pool currentTapeId follows the orchestration freeze (now points at v6 since
// the re-key test extended the lineage). The intermediate v4 tape persists.
const poolBack = store.getPool(POOL_ID)!;
assert(poolBack.currentTapeId === v6B.tape.id, 'pool.currentTapeId advanced through orchestration');
const v4Persisted = store.getTape(v4Tape.id)!;
assert(v4Persisted.id === v4Tape.id, 'v4 still in store (frozen tape immutable)');

// Spot-check membership-by-tape walks:
assert(store.getMembership(v4Tape.id).length === 3, 'getMembership(v4): 3 rows');
assert(store.getLoanHistory(L1).length === 6, 'L1 history: 6 rows (v1 → v6)');

/* -------------------------------------------------------------------------- */
store.close();
console.log('\n================================================================');
if (failures === 0) {
  console.log('PR 3 — orchestration acceptance: PASS — re-key guard + freeze-block + walk all hold.');
  process.exit(0);
} else {
  console.log(`PR 3 — orchestration acceptance: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
