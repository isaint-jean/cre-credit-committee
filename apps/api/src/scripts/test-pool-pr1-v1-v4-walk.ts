/**
 * Pool layer PR 1 — v1→v4 walk acceptance test.
 *
 *   cd apps/api && npx tsx src/scripts/test-pool-pr1-v1-v4-walk.ts
 *
 * Constructs the BMARK 2026-V12 example (4 dated tapes, carry-over, 3 overrides,
 * new-loan-review, unmatched-needs-confirm) ENTIRELY IN THE TYPES from
 * `@cre/contracts/src/pool.ts`. Asserts every prototype behavior is expressible:
 *
 *   1. 4 tapes v1 (2026-01-02) → v4 (2026-02-24), full membership snapshots.
 *   2. Carry-over: a loan present on v1 has the SAME LoanInPoolId on v4
 *      (identity stability across rounds).
 *   3. Departures derived as set difference between consecutive tapes' member ids.
 *   4. 3 overrides total — both directions:
 *        v3: originator says 'dropped', buyer says 'kicked'  (override = true)
 *        v4: originator says 'kicked',  buyer says 'dropped' (override = true, opposite direction)
 *        v4: originator says 'kicked',  buyer says 'dropped' (override = true, second)
 *      For every Disposition: authoritative === buyerLabel; override is correct.
 *   5. New loans on a tape default to 'under-review'.
 *   6. Reconciliation safety: a working tape can carry an
 *      'unmatched-needs-confirm' entry that CANNOT be put into a frozen
 *      `Tape.membership` (compile-time guarantee).
 *
 * SCOPE BOUNDARY: PR 1 is TYPES ONLY. No storage, no endpoints, no producers, no
 * UI, no engine changes. This test is a STATIC CONSTRUCTION proof — every value
 * is built by hand to demonstrate the types accept the prototype's shape. The
 * actual freeze / advance-tape / disposition-record OPERATIONS are later PRs.
 *
 * The test exits 1 on any failed assertion; the consolidated REPORT line at the
 * end states "PR 1 — v1→v4 walk: PASS" iff every assertion passed.
 */
import type {
  ConditionRef,
  Disposition,
  DispositionId,
  DispositionKind,
  LoanInPool,
  LoanInPoolId,
  LoanMembership,
  OnTapeStatus,
  PendingMembershipEntry,
  Pool,
  PoolId,
  Tape,
  TapeId,
  TapeOriginatorSummary,
  WorkingTape,
  WorkingTapeId,
} from '@cre/contracts';
import { DISPOSITION_KINDS, ON_TAPE_STATUSES, POOL_INVARIANTS } from '@cre/contracts';

/* -------------------------------------------------------------------------- */
/* Minimal brand-cast helpers — production code uses the canonical hash + uuid */
/* functions in apps/api/src/util. PR 1 is type-only, so these tests cast.    */
/* -------------------------------------------------------------------------- */
const asPoolId         = (s: string): PoolId         => s as unknown as PoolId;
const asLoanInPoolId   = (s: string): LoanInPoolId   => s as unknown as LoanInPoolId;
const asWorkingTapeId  = (s: string): WorkingTapeId  => s as unknown as WorkingTapeId;
const asTapeId         = (s: string): TapeId         => s as unknown as TapeId;
const asDispositionId  = (s: string): DispositionId  => s as unknown as DispositionId;

/* -------------------------------------------------------------------------- */
/* Test harness                                                               */
/* -------------------------------------------------------------------------- */
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* §A — Construct BMARK 2026-V12 pool                                         */
/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('Pool PR 1 — v1→v4 walk acceptance test (BMARK 2026-V12)');
console.log('================================================================');

const POOL_ID = asPoolId('00000000-0000-4000-8000-000000000001');

// 6 loans involved across the walk (small but covers carry-over + departures + new + overrides).
//   L1 — present v1→v4 (long carrier; identity stability proof)
//   L2 — present v1→v3, departs on v4 (clean drop, originator + buyer agree)
//   L3 — present v1→v2, departs on v3 (★ override #1: originator='dropped', buyer='kicked')
//   L4 — appears v2→v4 (new on v2, then carries)
//   L5 — appears v3→v4, departs v4 (★ override #2: originator='kicked', buyer='dropped')
//   L6 — appears v4 only (also departs v4 within same round? no — present on v4 as new)
//   L7 — present v1→v3, departs v4 (★ override #3: originator='kicked', buyer='dropped')

const L1 = asLoanInPoolId('loan-1111-1111-1111-111111111111');
const L2 = asLoanInPoolId('loan-2222-2222-2222-222222222222');
const L3 = asLoanInPoolId('loan-3333-3333-3333-333333333333');
const L4 = asLoanInPoolId('loan-4444-4444-4444-444444444444');
const L5 = asLoanInPoolId('loan-5555-5555-5555-555555555555');
const L6 = asLoanInPoolId('loan-6666-6666-6666-666666666666');
const L7 = asLoanInPoolId('loan-7777-7777-7777-777777777777');

const T1 = asTapeId('a'.repeat(64));
const T2 = asTapeId('b'.repeat(64));
const T3 = asTapeId('c'.repeat(64));
const T4 = asTapeId('d'.repeat(64));

const noConds: readonly ConditionRef[] = [];

function bound(
  loanInPoolId: LoanInPoolId,
  dealRef: string,
  status: OnTapeStatus,
  tapePosition: number,
  conditions: readonly ConditionRef[] = noConds,
): LoanMembership {
  return { loanInPoolId, dealRef, status, conditions, notes: null, tapePosition };
}

const summary = (label: string): TapeOriginatorSummary => ({
  originatorLoanCount: 0,
  originatorDroppedRefs: [],
  originatorKickedRefs: [],
  sourceLabel: label,
});

const tapeV1: Tape = {
  id: T1,
  poolId: POOL_ID,
  version: 1,
  tapeDate: '2026-01-02T00:00:00Z',
  receivedAt: '2026-01-02T14:00:00Z',
  frozenAt:   '2026-01-05T18:00:00Z',
  priorTapeId: null,
  membership: [
    bound(L1, 'deal-L1', 'clean',        1),
    bound(L2, 'deal-L2', 'clean',        2),
    bound(L3, 'deal-L3', 'conditioned',  3, [{ label: 'Estoppel pending', note: null }]),
    bound(L7, 'deal-L7', 'under-review', 4),
  ],
  originatorSummary: summary('BMARK 2026-V12 / v1 / 2026-01-02'),
};

const tapeV2: Tape = {
  id: T2,
  poolId: POOL_ID,
  version: 2,
  tapeDate:   '2026-01-16T00:00:00Z',
  receivedAt: '2026-01-16T14:00:00Z',
  frozenAt:   '2026-01-19T18:00:00Z',
  priorTapeId: T1,
  membership: [
    // L1, L2, L3, L7 carry forward (statuses may evolve from v1 buyer review)
    bound(L1, 'deal-L1', 'clean',        1),
    bound(L2, 'deal-L2', 'clean',        2),
    bound(L3, 'deal-L3', 'kick-flagged', 3),                       // buyer escalates intent-to-kick
    bound(L7, 'deal-L7', 'clean',        4),
    // L4 appears new on v2 — defaults to under-review
    bound(L4, 'deal-L4', 'under-review', 5),
  ],
  originatorSummary: summary('BMARK 2026-V12 / v2 / 2026-01-16'),
};

const tapeV3: Tape = {
  id: T3,
  poolId: POOL_ID,
  version: 3,
  tapeDate:   '2026-02-04T00:00:00Z',
  receivedAt: '2026-02-04T14:00:00Z',
  frozenAt:   '2026-02-07T18:00:00Z',
  priorTapeId: T2,
  membership: [
    bound(L1, 'deal-L1', 'clean',        1),
    bound(L2, 'deal-L2', 'clean',        2),
    bound(L4, 'deal-L4', 'conditioned',  3, [{ label: 'PCA Phase II', note: null }]),
    bound(L7, 'deal-L7', 'kick-flagged', 4),
    // L5 appears new on v3 — under-review
    bound(L5, 'deal-L5', 'under-review', 5),
    // L3 departs between v2 → v3 — Disposition recorded against leftOnTape=T3.
  ],
  originatorSummary: summary('BMARK 2026-V12 / v3 / 2026-02-04'),
};

const tapeV4: Tape = {
  id: T4,
  poolId: POOL_ID,
  version: 4,
  tapeDate:   '2026-02-24T00:00:00Z',
  receivedAt: '2026-02-24T14:00:00Z',
  frozenAt:   '2026-02-27T18:00:00Z',
  priorTapeId: T3,
  membership: [
    bound(L1, 'deal-L1', 'clean',        1),
    bound(L4, 'deal-L4', 'clean',        2),
    // L6 appears new on v4 — under-review
    bound(L6, 'deal-L6', 'under-review', 3),
    // L2, L5, L7 depart between v3 → v4 — Dispositions recorded against leftOnTape=T4.
  ],
  originatorSummary: summary('BMARK 2026-V12 / v4 / 2026-02-24'),
};

const pool: Pool = {
  id: POOL_ID,
  shelfName: 'BMARK 2026-V12',
  vintage: 2026,
  seller: 'Bedrock Capital',
  createdAt: '2026-01-02T14:00:00Z',
  tapeIds: [T1, T2, T3, T4],
  currentTapeId: T4,
  closedAt: null,
};

/* -------------------------------------------------------------------------- */
/* §B — Construct LoanInPool records (one per unique LoanInPoolId)            */
/* -------------------------------------------------------------------------- */
function makeLoanInPool(
  id: LoanInPoolId,
  dealRef: string,
  addedOnTape: TapeId,
  originatorRef: string | null,
  currentDispositionId: DispositionId | null = null,
): LoanInPool {
  return {
    id,
    poolId: POOL_ID,
    dealRef,
    addedOnTape,
    originatorLoanRef: originatorRef,
    propertyName: null,
    assetType: null,
    currentDispositionId,
  };
}

const D_L3 = asDispositionId('1'.repeat(64));
const D_L2 = asDispositionId('2'.repeat(64));
const D_L5 = asDispositionId('3'.repeat(64));
const D_L7 = asDispositionId('4'.repeat(64));

const loanRecords: readonly LoanInPool[] = [
  makeLoanInPool(L1, 'deal-L1', T1, 'BMARK-L001'),
  makeLoanInPool(L2, 'deal-L2', T1, 'BMARK-L002', D_L2),
  makeLoanInPool(L3, 'deal-L3', T1, 'BMARK-L003', D_L3),
  makeLoanInPool(L4, 'deal-L4', T2, 'BMARK-L004'),
  makeLoanInPool(L5, 'deal-L5', T3, 'BMARK-L005', D_L5),
  makeLoanInPool(L6, 'deal-L6', T4, 'BMARK-L006'),
  makeLoanInPool(L7, 'deal-L7', T1, 'BMARK-L007', D_L7),
];

/* -------------------------------------------------------------------------- */
/* §C — Construct Dispositions (the 3 overrides + the 1 clean drop)           */
/* -------------------------------------------------------------------------- */
const actor = { userId: 'isabelle', displayName: 'Isabelle' };

// L3 departs v3 → ★ OVERRIDE #1: originator='dropped', buyer='kicked'
const dispL3: Disposition = {
  id: D_L3,
  poolId: POOL_ID,
  loanInPoolId: L3,
  lastSeenOnTape: T2,
  leftOnTape:     T3,
  originatorLabel: 'dropped',
  buyerLabel:      'kicked',
  authoritative:   'kicked',
  override:        true,
  reasons: ['DSCR failed at refi floor', 'sponsor litigation disclosure'],
  recordedBy: actor,
  recordedAt: '2026-02-05T11:00:00Z',
  supersedes: null,
};

// L2 departs v4 → clean drop (no override): originator='dropped', buyer='dropped'
const dispL2: Disposition = {
  id: D_L2,
  poolId: POOL_ID,
  loanInPoolId: L2,
  lastSeenOnTape: T3,
  leftOnTape:     T4,
  originatorLabel: 'dropped',
  buyerLabel:      'dropped',
  authoritative:   'dropped',
  override:        false,
  reasons: ['originator withdrew; benign'],
  recordedBy: actor,
  recordedAt: '2026-02-25T10:00:00Z',
  supersedes: null,
};

// L5 departs v4 → ★ OVERRIDE #2: originator='kicked', buyer='dropped' (opposite direction)
const dispL5: Disposition = {
  id: D_L5,
  poolId: POOL_ID,
  loanInPoolId: L5,
  lastSeenOnTape: T3,
  leftOnTape:     T4,
  originatorLabel: 'kicked',
  buyerLabel:      'dropped',
  authoritative:   'dropped',
  override:        true,
  reasons: ['originator labeled kick; buyer determined no institutional taint'],
  recordedBy: actor,
  recordedAt: '2026-02-25T10:30:00Z',
  supersedes: null,
};

// L7 departs v4 → ★ OVERRIDE #3: originator='kicked', buyer='dropped' (second of same direction)
const dispL7: Disposition = {
  id: D_L7,
  poolId: POOL_ID,
  loanInPoolId: L7,
  lastSeenOnTape: T3,
  leftOnTape:     T4,
  originatorLabel: 'kicked',
  buyerLabel:      'dropped',
  authoritative:   'dropped',
  override:        true,
  reasons: ['kick-flag carried buyer judgment to drop only; corpus exclusion not warranted'],
  recordedBy: actor,
  recordedAt: '2026-02-25T11:00:00Z',
  supersedes: null,
};

const dispositions: readonly Disposition[] = [dispL3, dispL2, dispL5, dispL7];

/* -------------------------------------------------------------------------- */
/* §D — Assertions                                                            */
/* -------------------------------------------------------------------------- */

console.log('\n--- 1. Four dated tapes ---');
const tapes = [tapeV1, tapeV2, tapeV3, tapeV4];
assert(tapes.length === 4, 'four tapes exist');
assert(tapes[0]!.tapeDate === '2026-01-02T00:00:00Z', 'v1 dated 2026-01-02');
assert(tapes[3]!.tapeDate === '2026-02-24T00:00:00Z', 'v4 dated 2026-02-24');
assert(tapes.every((t, i) => t.version === i + 1), 'versions are 1,2,3,4 in order');
assert(tapeV1.priorTapeId === null, 'v1 has no prior');
assert(tapeV2.priorTapeId === T1,  'v2.priorTapeId === T1');
assert(tapeV3.priorTapeId === T2,  'v3.priorTapeId === T2');
assert(tapeV4.priorTapeId === T3,  'v4.priorTapeId === T3');
assert(pool.tapeIds.length === 4 && pool.currentTapeId === T4, 'pool currentTapeId === T4');

console.log('\n--- 2. Carry-over: LoanInPoolId stability across tapes ---');
const idsOnV1 = new Set(tapeV1.membership.map(m => m.loanInPoolId));
const idsOnV4 = new Set(tapeV4.membership.map(m => m.loanInPoolId));
assert(idsOnV1.has(L1), 'L1 present on v1');
assert(idsOnV4.has(L1), 'L1 present on v4');
const l1OnV1 = tapeV1.membership.find(m => m.loanInPoolId === L1)!;
const l1OnV4 = tapeV4.membership.find(m => m.loanInPoolId === L1)!;
assert(l1OnV1.loanInPoolId === l1OnV4.loanInPoolId, 'L1 has identical LoanInPoolId on v1 AND v4 (carry-over)');
assert(l1OnV1.dealRef === l1OnV4.dealRef, 'L1 dealRef stable across v1 → v4');

console.log('\n--- 3. Departures derived as set difference ---');
function departures(prior: Tape, next: Tape): readonly LoanInPoolId[] {
  const nextIds = new Set(next.membership.map(m => m.loanInPoolId));
  return prior.membership.map(m => m.loanInPoolId).filter(id => !nextIds.has(id));
}
const dep_v1_v2 = departures(tapeV1, tapeV2);
const dep_v2_v3 = departures(tapeV2, tapeV3);
const dep_v3_v4 = departures(tapeV3, tapeV4);
assert(dep_v1_v2.length === 0,                                'v1 → v2: no departures');
assert(dep_v2_v3.length === 1 && dep_v2_v3[0] === L3,          'v2 → v3: L3 departs');
assert(dep_v3_v4.length === 3 &&
       new Set(dep_v3_v4 as LoanInPoolId[]).size === 3 &&
       (dep_v3_v4 as LoanInPoolId[]).every(id => id === L2 || id === L5 || id === L7),
       'v3 → v4: L2, L5, L7 depart');

console.log('\n--- 4. Three overrides (both directions) ---');
const overrideDispositions = dispositions.filter(d => d.override);
assert(overrideDispositions.length === 3, 'exactly 3 dispositions carry override === true');
assert(dispL3.override === true && dispL3.originatorLabel === 'dropped' && dispL3.buyerLabel === 'kicked',
       'override #1 (L3, v3): drop → kick');
assert(dispL5.override === true && dispL5.originatorLabel === 'kicked' && dispL5.buyerLabel === 'dropped',
       'override #2 (L5, v4): kick → drop (opposite direction)');
assert(dispL7.override === true && dispL7.originatorLabel === 'kicked' && dispL7.buyerLabel === 'dropped',
       'override #3 (L7, v4): kick → drop');
assert(dispL2.override === false, 'L2 disposition is NOT an override (originator and buyer both dropped)');

for (const d of dispositions) {
  assert(d.authoritative === d.buyerLabel,
         `${d.id.slice(0, 8)}…: authoritative === buyerLabel (P4)`);
  assert(d.override === (d.originatorLabel !== d.buyerLabel),
         `${d.id.slice(0, 8)}…: override === (originatorLabel !== buyerLabel) (P5)`);
}

// Cross-check consecutive-tape invariant from the disposition shape
for (const d of dispositions) {
  const prior = tapes.find(t => t.id === d.lastSeenOnTape);
  const next  = tapes.find(t => t.id === d.leftOnTape);
  assert(prior !== undefined && next !== undefined && next.version === prior.version + 1,
         `${d.id.slice(0, 8)}…: leftOnTape.version === lastSeenOnTape.version + 1`);
}

console.log('\n--- 5. New loans default to under-review ---');
const newOnV2 = tapeV2.membership.find(m => m.loanInPoolId === L4)!;
assert(newOnV2.status === 'under-review', 'L4 first appears on v2 with status under-review');
const newOnV3 = tapeV3.membership.find(m => m.loanInPoolId === L5)!;
assert(newOnV3.status === 'under-review', 'L5 first appears on v3 with status under-review');
const newOnV4 = tapeV4.membership.find(m => m.loanInPoolId === L6)!;
assert(newOnV4.status === 'under-review', 'L6 first appears on v4 with status under-review');

console.log('\n--- 6. Reconciliation safety: unmatched-needs-confirm representable on working tape ---');
const workingTape: WorkingTape = {
  id: asWorkingTapeId('11111111-1111-4111-8111-111111111111'),
  poolId: POOL_ID,
  version: 5,
  tapeDate:   '2026-03-12T00:00:00Z',
  receivedAt: '2026-03-12T14:00:00Z',
  priorTapeId: T4,
  pendingMembership: [
    {
      kind: 'bound',
      binding: bound(L1, 'deal-L1', 'clean', 1),
      incomingOriginatorRef: 'BMARK-L001',
    },
    {
      // ★ THE LOAD-BEARING ROW: originator re-keyed; nothing matches deterministically.
      kind: 'unmatched-needs-confirm',
      incomingOriginatorRef: 'BMARK-L004-RE',  // L4's old ref was 'BMARK-L004'
      candidateLoanInPoolIds: [L4],            // fuzzy match hint
      tapePosition: 2,
    },
    {
      kind: 'new-loan-confirmed',
      incomingOriginatorRef: 'BMARK-L008',
      dealRef: 'deal-L8',
      status: 'under-review',
      conditions: [],
      notes: null,
      tapePosition: 3,
    },
  ],
  originatorSummary: summary('BMARK 2026-V12 / v5 / 2026-03-12 (in review)'),
};

assert(workingTape.pendingMembership.length === 3, 'working tape carries 3 pending entries');

const bound1 = workingTape.pendingMembership[0]!;
const unmatched = workingTape.pendingMembership[1]!;
const newConfirmed = workingTape.pendingMembership[2]!;
assert(bound1.kind === 'bound',                       'entry 0 is kind: bound');
assert(unmatched.kind === 'unmatched-needs-confirm',  'entry 1 is kind: unmatched-needs-confirm');
assert(newConfirmed.kind === 'new-loan-confirmed',    'entry 2 is kind: new-loan-confirmed');

if (unmatched.kind === 'unmatched-needs-confirm') {
  assert(unmatched.candidateLoanInPoolIds.length === 1 && unmatched.candidateLoanInPoolIds[0] === L4,
         'unmatched entry surfaces L4 as a fuzzy-match candidate (advance-tape op MUST confirm)');
  assert(unmatched.incomingOriginatorRef === 'BMARK-L004-RE',
         'unmatched entry retains the re-keyed incoming ref for human review');
}

// ★ Structural P3: a frozen Tape.membership is readonly LoanMembership[], NOT
// readonly PendingMembershipEntry[]. The test below is type-level: if these
// lines were to type-check, P3 would be broken. They are commented as PROOF
// (uncommenting must fail tsc) — kept here so the invariant is documented
// in code, not just in a markdown spec.
//
//   const wrongFrozen: Tape = {
//     ...tapeV4,
//     membership: workingTape.pendingMembership,  // TS2322 — PendingMembershipEntry not assignable to LoanMembership
//   };
//
// (The pool layer's freeze operation, landing in a later PR, is the runtime
// enforcer of P3 — it must resolve every PendingMembershipEntry to a
// LoanMembership before producing the TapeId.)

console.log('\n--- 7. Invariants registry exposed ---');
assert(POOL_INVARIANTS.length === 7, 'POOL_INVARIANTS exposes 7 declared invariants');
assert(ON_TAPE_STATUSES.length === 4, 'ON_TAPE_STATUSES has 4 values');
assert(DISPOSITION_KINDS.length === 2, 'DISPOSITION_KINDS has 2 values (dropped, kicked)');

// LoanInPool records cross-check: every loan that ever appeared has exactly one
// LoanInPool record; every departed loan carries a currentDispositionId.
const departedIds = new Set<LoanInPoolId>([L3, L2, L5, L7]);
for (const lr of loanRecords) {
  if (departedIds.has(lr.id)) {
    assert(lr.currentDispositionId !== null, `${lr.id.slice(0, 8)}…: departed → currentDispositionId set`);
  } else {
    assert(lr.currentDispositionId === null, `${lr.id.slice(0, 8)}…: still in pool → currentDispositionId null`);
  }
}

/* -------------------------------------------------------------------------- */
/* Final report                                                               */
/* -------------------------------------------------------------------------- */
console.log('\n================================================================');
if (failures === 0) {
  console.log('PR 1 — v1→v4 walk: PASS — model expresses every prototype behavior.');
  process.exit(0);
} else {
  console.log(`PR 1 — v1→v4 walk: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
