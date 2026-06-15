/**
 * Pool layer (PR 2) — uuid id minting + hash-input projection helpers.
 *
 * `PoolId`, `LoanInPoolId`, and `WorkingTapeId` are uuid-v4 brands. Services use
 * `import { v4 as uuid } from 'uuid'` everywhere else in this codebase; these
 * helpers wrap that and brand-cast so callers cannot accidentally produce a raw
 * uuid string and pass it where a typed id is required.
 *
 * `makeTapeIdHashInput` and `makeDispositionIdHashInput` are the canonical
 * projections from the full PR-1 records to their hash-boundary subsets (per
 * `pool.ts` §8b). The store calls these at insert and verify time; nobody else
 * should compute hash inputs ad-hoc — that would risk drift from the C1 boundary.
 */

import { v4 as uuid } from 'uuid';
import type {
  Disposition,
  DispositionIdHashInput,
  LoanInPoolId,
  PoolId,
  Tape,
  TapeIdHashInput,
  WorkingTapeId,
} from '@cre/contracts';

export const mintPoolId = (): PoolId => uuid() as unknown as PoolId;
export const mintLoanInPoolId = (): LoanInPoolId => uuid() as unknown as LoanInPoolId;
export const mintWorkingTapeId = (): WorkingTapeId => uuid() as unknown as WorkingTapeId;

/**
 * Project a `Tape` to its `TapeIdHashInput`. The C1 hash boundary: pool, version,
 * tapeDate, priorTapeId, membership, originatorSummary — NO frozenAt, NO
 * receivedAt. Two tapes that round-trip to byte-identical hash inputs must
 * produce the same `TapeId`.
 */
export function makeTapeIdHashInput(tape: Tape): TapeIdHashInput {
  return {
    poolId:            tape.poolId,
    version:           tape.version,
    tapeDate:          tape.tapeDate,
    priorTapeId:       tape.priorTapeId,
    membership:        tape.membership,
    originatorSummary: tape.originatorSummary,
  };
}

/**
 * Project a `Disposition` to its `DispositionIdHashInput`. The C1 hash boundary
 * excludes `recordedAt`; everything else that defines the decision is included.
 */
export function makeDispositionIdHashInput(disposition: Disposition): DispositionIdHashInput {
  return {
    poolId:           disposition.poolId,
    loanInPoolId:     disposition.loanInPoolId,
    lastSeenOnTape:   disposition.lastSeenOnTape,
    leftOnTape:       disposition.leftOnTape,
    originatorLabel:  disposition.originatorLabel,
    buyerLabel:       disposition.buyerLabel,
    authoritative:    disposition.authoritative,
    override:         disposition.override,
    reasons:          disposition.reasons,
    recordedBy:       disposition.recordedBy,
    supersedes:       disposition.supersedes,
  };
}
