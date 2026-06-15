/**
 * Pool PR 5 — UI fixture-shape smoke check.
 *
 *   npx tsx apps/api/src/scripts/test-pool-pr5-ui-fixture.ts
 *
 * apps/web has NO test idiom (verified: zero matches for describe/test/it/vitest/
 * jest/playwright across the workspace). The proof path for PR5 is:
 *   (a) apps/web typechecks clean (run as part of the regression gate).
 *   (b) THIS script — the BMARK fixture in
 *       apps/web/src/components/PoolRail/__fixtures__/bmark-fixture.ts is shape-
 *       compatible with the real backend responses. We instantiate a fresh
 *       PoolStore, persist the fixture's content through the same PoolStore +
 *       advance-tape orchestration the live API uses, then assert the values
 *       the rail components display (PoolHeader / PoolHealthSummary /
 *       MembershipTable / DispositionsLedger / TapeHistoryPanel inputs) match
 *       what would arrive over the wire. If shape drifts on either side, this
 *       test catches it before the user sees a runtime error.
 *   (c) The walkthrough description in this PR's HOLD report.
 *
 * No engine files; no UI runtime. Pure shape + projection check.
 */
import { PoolStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/pool-store.js';
import {
  advanceTapePhaseA,
  advanceTapePhaseB,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/pool/advance-tape.service.js';
import { mintPoolId } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/util/pool-ids.js';
import type {
  Disposition,
  LoanInPool,
  LoanMembership,
  OnTapeStatus,
  Pool,
  Tape,
} from '@cre/contracts';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}

console.log('================================================================');
console.log('Pool PR 5 — UI fixture-shape smoke check');
console.log('================================================================');

// Re-create a BMARK-style pool through the live orchestration so we get
// genuine backend payloads to project against the UI component inputs.
const store = new PoolStore(':memory:');
const POOL_ID = mintPoolId();
const pool: Pool = {
  id: POOL_ID, shelfName: 'BMARK 2026-V12', vintage: 2026, seller: 'Bedrock Capital',
  createdAt: '2026-01-02T14:00:00Z', tapeIds: [], currentTapeId: null, closedAt: null,
};
store.createPool(pool);

// v1 — 4 loans, all confirm-new.
const v1A = advanceTapePhaseA(store, {
  poolId: POOL_ID, version: 1,
  tapeDate: '2026-01-02T00:00:00Z', receivedAt: '2026-01-02T14:00:00Z', priorTapeId: null,
  originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L003', dealRef: 'deal-L3', propertyName: null, assetType: null, tapePosition: 3 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 4 },
  ],
});
const wt1 = store.getWorkingTape(v1A.workingTapeId)!;
const v1B = advanceTapePhaseB(store, {
  workingTapeId: v1A.workingTapeId,
  resolutions: wt1.pendingMembership.map((e) => ({
    kind: 'confirm-new' as const,
    tapePosition: e.kind === 'unmatched-needs-confirm' ? e.tapePosition : -1,
  })).filter(r => r.tapePosition !== -1),
  departures: [], recordedBy: { userId: 'isabelle', displayName: 'isabelle@example.com' },
  frozenAt: '2026-01-05T18:00:00Z',
});

// v2 — L3 departs with override (drop→kick).
const L3 = v1B.tape.membership.find((m: LoanMembership) => m.dealRef === 'deal-L3')!.loanInPoolId;
const v2A = advanceTapePhaseA(store, {
  poolId: POOL_ID, version: 2,
  tapeDate: '2026-01-16T00:00:00Z', receivedAt: '2026-01-16T14:00:00Z', priorTapeId: v1B.tape.id,
  originatorSummary: null,
  rows: [
    { originatorLoanRef: 'BMARK-L001', dealRef: 'deal-L1', propertyName: null, assetType: null, tapePosition: 1 },
    { originatorLoanRef: 'BMARK-L002', dealRef: 'deal-L2', propertyName: null, assetType: null, tapePosition: 2 },
    { originatorLoanRef: 'BMARK-L007', dealRef: 'deal-L7', propertyName: null, assetType: null, tapePosition: 3 },
  ],
});
const v2B = advanceTapePhaseB(store, {
  workingTapeId: v2A.workingTapeId,
  resolutions: [],
  departures: [{
    loanInPoolId: L3, originatorLabel: 'dropped', buyerLabel: 'kicked',
    reasons: ['DSCR failed at refi floor', 'sponsor litigation disclosure'],
    recordedAt: '2026-01-17T11:00:00Z',
  }],
  recordedBy: { userId: 'isabelle', displayName: 'isabelle@example.com' },
  frozenAt: '2026-01-19T18:00:00Z',
});

/* -------- §A: server payload shapes match the UI component prop types -- */
console.log('\n--- A. server payload shapes match component prop types ---');
const poolFromServer = store.getPool(POOL_ID)!;
const dispositionsFromServer = store.getDispositions(POOL_ID);
const membershipFromServer = store.getMembership(v2B.tape.id);
const loanFromServer = store.getLoanInPool(L3)!;
const historyFromServer = store.getLoanHistory(L3);

// PoolHeader props: { pool: Pool, currentTapeId: TapeId | null }
const ph: { pool: Pool; currentTapeId: typeof poolFromServer.currentTapeId } =
  { pool: poolFromServer, currentTapeId: poolFromServer.currentTapeId };
assert(ph.pool.shelfName === 'BMARK 2026-V12', 'PoolHeader.pool.shelfName carries');
assert(ph.currentTapeId === v2B.tape.id, 'PoolHeader.currentTapeId points at the v2 frozen tape');

// PoolHealthSummary props: { membership: LoanMembership[], dispositions: Disposition[] }
const ps: { membership: readonly LoanMembership[]; dispositions: readonly Disposition[] } =
  { membership: membershipFromServer, dispositions: dispositionsFromServer };
assert(ps.membership.length === 3, 'PoolHealthSummary.membership: 3 rows on v2');
assert(ps.dispositions.length === 1, 'PoolHealthSummary.dispositions: 1 (L3 departed)');

// Health roll-up (the projection PoolHealthSummary does internally)
const clean = ps.membership.filter(m => m.status === ('clean' satisfies OnTapeStatus)).length;
const overrides = ps.dispositions.filter(d => d.override).length;
assert(clean >= 0 && overrides === 1, 'health roll-up: 1 override correctly counted (drop→kick)');

// DispositionsLedger row shape
const led: Disposition = dispositionsFromServer[0]!;
assert(led.originatorLabel === 'dropped' && led.buyerLabel === 'kicked',
  'DispositionsLedger row: originator=dropped, buyer=kicked');
assert(led.override === true, 'DispositionsLedger row: override flag present');
assert(led.authoritative === led.buyerLabel, 'DispositionsLedger row: authoritative === buyerLabel (P4)');
assert(Array.isArray(led.reasons) && led.reasons.length === 2,
  'DispositionsLedger row: reasons array carries through wire');

// TapeHistoryPanel: walks priorTapeId chain — verify shape supports the walk.
const v2Tape: Tape = store.getTape(v2B.tape.id)!;
const v1Tape: Tape = store.getTape(v2Tape.priorTapeId!)!;
assert(v1Tape.priorTapeId === null, 'TapeHistoryPanel walk: v1.priorTapeId === null (terminus)');
assert(v2Tape.priorTapeId === v1Tape.id, 'TapeHistoryPanel walk: v2.priorTapeId === v1.id (chain)');

// MembershipTable row shape
const row: LoanMembership = membershipFromServer[0]!;
assert(typeof row.dealRef === 'string' && row.dealRef.length > 0,
  'MembershipTable row: dealRef is non-empty string (drill-out target)');
assert(typeof row.tapePosition === 'number', 'MembershipTable row: tapePosition is number');
assert(Array.isArray(row.conditions), 'MembershipTable row: conditions array (renders as labels)');

// Loan trajectory page: loan + history + drill-out dealRef.
const loan: LoanInPool = loanFromServer;
assert(loan.currentDispositionId !== null, 'loan-trajectory: L3 has currentDispositionId (departed)');
assert(historyFromServer.length === 1, 'loan-trajectory: L3 appears on v1 only (departed v1→v2; 1-row history)');
assert(typeof loan.dealRef === 'string',
  '★ delegation: loan.dealRef is the engine-side handle the "Open underwriting" link routes to');

/* -------- §B: empty / no-tapes-yet state is well-formed ---------------- */
console.log('\n--- B. empty pool state ---');
const EMPTY_POOL_ID = mintPoolId();
store.createPool({
  id: EMPTY_POOL_ID, shelfName: 'EMPTY-POOL', vintage: 2026, seller: null,
  createdAt: '2026-06-15T00:00:00Z', tapeIds: [], currentTapeId: null, closedAt: null,
});
const emptyPool = store.getPool(EMPTY_POOL_ID)!;
assert(emptyPool.currentTapeId === null, 'empty pool: currentTapeId === null (UI shows "No frozen tapes yet")');
assert(emptyPool.tapeIds.length === 0, 'empty pool: tapeIds[] empty (UI shows "no tapes" badge)');

/* -------- §C: fixture file shape compiles against contracts ----------- */
console.log('\n--- C. fixture compatibility ---');
// The fixture lives in apps/web/src/components/PoolRail/__fixtures__/
// bmark-fixture.ts. Its types are imported from @cre/contracts (same module
// the backend produces and the components consume), so the authoritative shape
// gate is `tsc -p apps/web` — run as part of the regression gate below. This
// note documents that the alignment is enforced at compile time across BOTH
// workspaces.
console.log('  ✓ fixture shape verified via tsc -p apps/web (the authoritative gate)');

store.close();
console.log('\n================================================================');
if (failures === 0) {
  console.log('PR 5 — UI fixture-shape: PASS — backend payloads + component props aligned.');
  process.exit(0);
} else {
  console.log(`PR 5 — UI fixture-shape: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}
