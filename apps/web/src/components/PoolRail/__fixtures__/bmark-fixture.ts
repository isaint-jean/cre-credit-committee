/**
 * BMARK 2026-V12 fixture (PR 5 UI proof shape).
 *
 * Mirror of the worked example proven across PR 1-4 (54 + 50 + 47 + 44 assertions).
 * The rail components import this fixture in the smoke check to verify the wire
 * shape compiles and renders against the real @cre/contracts types — proven before
 * the production DB has any pools in it.
 *
 * THIS IS A FIXTURE, NOT MOCK DATA. The UI never reads it at runtime; production
 * pages always go through `api.*` against the real backend.
 */
import type {
  Disposition,
  DispositionId,
  LoanInPool,
  LoanInPoolId,
  LoanMembership,
  Pool,
  PoolId,
  Tape,
  TapeId,
} from '@cre/contracts';

const POOL_ID = '00000000-0000-4000-8000-000000000001' as unknown as PoolId;
const L1 = 'loan-1111-1111-4111-8111-111111111111' as unknown as LoanInPoolId;
const L4 = 'loan-4444-4444-4444-444444444444' as unknown as LoanInPoolId;
const L3 = 'loan-3333-3333-3333-333333333333' as unknown as LoanInPoolId;

const TAPE_V1 = 'a'.repeat(64) as unknown as TapeId;
const TAPE_V2 = 'b'.repeat(64) as unknown as TapeId;
const TAPE_V3 = 'c'.repeat(64) as unknown as TapeId;

const DISP_L3 = '1'.repeat(64) as unknown as DispositionId;

export const FIXTURE_POOL: Pool = {
  id: POOL_ID,
  shelfName: 'BMARK 2026-V12',
  vintage: 2026,
  seller: 'Bedrock Capital',
  createdAt: '2026-01-02T14:00:00Z',
  tapeIds: [TAPE_V1, TAPE_V2, TAPE_V3],
  currentTapeId: TAPE_V3,
  closedAt: null,
};

export const FIXTURE_MEMBERSHIP_V3: readonly LoanMembership[] = [
  { loanInPoolId: L1, dealRef: 'deal-L1', status: 'clean',       conditions: [],                                           notes: null, tapePosition: 1 },
  { loanInPoolId: L4, dealRef: 'deal-L4', status: 'conditioned', conditions: [{ label: 'PCA Phase II', note: null }],      notes: 'TI/LC reserve to be sized', tapePosition: 2 },
];

export const FIXTURE_TAPES: readonly Tape[] = [
  {
    id: TAPE_V1, poolId: POOL_ID, version: 1,
    tapeDate: '2026-01-02T00:00:00Z', receivedAt: '2026-01-02T14:00:00Z', frozenAt: '2026-01-05T18:00:00Z',
    priorTapeId: null,
    membership: [
      { loanInPoolId: L1, dealRef: 'deal-L1', status: 'clean',        conditions: [], notes: null, tapePosition: 1 },
      { loanInPoolId: L3, dealRef: 'deal-L3', status: 'conditioned',  conditions: [{ label: 'Estoppel pending', note: null }], notes: null, tapePosition: 2 },
    ],
    originatorSummary: { originatorLoanCount: 2, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'BMARK / v1' },
  },
  {
    id: TAPE_V2, poolId: POOL_ID, version: 2,
    tapeDate: '2026-01-16T00:00:00Z', receivedAt: '2026-01-16T14:00:00Z', frozenAt: '2026-01-19T18:00:00Z',
    priorTapeId: TAPE_V1,
    membership: [
      { loanInPoolId: L1, dealRef: 'deal-L1', status: 'clean',        conditions: [], notes: null, tapePosition: 1 },
      { loanInPoolId: L3, dealRef: 'deal-L3', status: 'kick-flagged', conditions: [], notes: null, tapePosition: 2 },
      { loanInPoolId: L4, dealRef: 'deal-L4', status: 'under-review', conditions: [], notes: null, tapePosition: 3 },
    ],
    originatorSummary: { originatorLoanCount: 3, originatorDroppedRefs: [], originatorKickedRefs: [], sourceLabel: 'BMARK / v2' },
  },
  {
    id: TAPE_V3, poolId: POOL_ID, version: 3,
    tapeDate: '2026-02-04T00:00:00Z', receivedAt: '2026-02-04T14:00:00Z', frozenAt: '2026-02-07T18:00:00Z',
    priorTapeId: TAPE_V2,
    membership: FIXTURE_MEMBERSHIP_V3,
    originatorSummary: { originatorLoanCount: 2, originatorDroppedRefs: [], originatorKickedRefs: ['BMARK-L003'], sourceLabel: 'BMARK / v3' },
  },
];

export const FIXTURE_DISPOSITIONS: readonly Disposition[] = [
  {
    id: DISP_L3, poolId: POOL_ID, loanInPoolId: L3,
    lastSeenOnTape: TAPE_V2, leftOnTape: TAPE_V3,
    originatorLabel: 'dropped', buyerLabel: 'kicked',
    authoritative: 'kicked', override: true,
    reasons: ['DSCR failed at refi floor', 'sponsor litigation disclosure'],
    recordedBy: { userId: 'isabelle', displayName: 'Isabelle' },
    recordedAt: '2026-02-05T11:00:00Z',
    supersedes: null,
  },
];

export const FIXTURE_LOAN_L1: LoanInPool = {
  id: L1, poolId: POOL_ID, dealRef: 'deal-L1', addedOnTape: TAPE_V1,
  originatorLoanRef: 'BMARK-L001', propertyName: 'Maple Court Apartments',
  assetType: 'Multifamily', currentDispositionId: null,
};

export const FIXTURE_LOAN_L3: LoanInPool = {
  id: L3, poolId: POOL_ID, dealRef: 'deal-L3', addedOnTape: TAPE_V1,
  originatorLoanRef: 'BMARK-L003', propertyName: 'Walnut Office Plaza',
  assetType: 'Office', currentDispositionId: DISP_L3,
};
