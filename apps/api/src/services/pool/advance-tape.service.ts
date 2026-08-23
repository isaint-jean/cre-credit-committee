/**
 * advance-tape.service (Pool layer PR 3) — the operation that drives a pool
 * forward by one tape. Composes PR2's `PoolStore` primitives + PR1's types.
 *
 * Two-phase design — the seam is human-in-the-loop reconciliation:
 *
 *   PHASE A — INGEST + RECONCILE: take an incoming originator tape, open a
 *     working tape, classify every row into a `PendingMembershipEntry`. The
 *     output is a working tape (mix of `'bound'` exact-matches and
 *     `'unmatched-needs-confirm'` review queue) + a summary for the rail UI.
 *     Phase A NEVER auto-binds beyond exact match, NEVER mints a new
 *     LoanInPool, NEVER freezes.
 *
 *   PHASE B — RESOLVE + FREEZE: the buyer has decided each unmatched entry
 *     (either `bind-existing` for a re-key, or `confirm-new` for a genuinely
 *     new loan). Phase B applies the resolutions (minting LoanInPool on
 *     confirm-new, updating the originator-ref on bind-existing), applies
 *     carry-over (status + conditions from the prior tape for survivors),
 *     records dispositions for departures, and calls PR2's `freezeTape` to
 *     commit. PR2's two structural guards (unmatched-needs-confirm refusal +
 *     new-loan-confirmed refusal) fire through the operation if Phase B's
 *     contract is violated; they are surfaced as `AdvanceTapeError`, not
 *     swallowed.
 *
 * LAYER BOUNDARY: this file imports `@cre/contracts` + the pool storage layer.
 * Nothing from the engine (judgment / mitigation / narrative / extraction). The
 * `dealRef` on every incoming row is treated as an opaque string — the caller
 * supplies it, the pool layer never reads through it.
 *
 * THE LOAD-BEARING RULE — the silent-mis-carry guard as LOGIC: a re-keyed
 * originator ref (the loan exists but the originator renumbered it) MUST
 * surface as `'unmatched-needs-confirm'` with the real loan in
 * `candidateLoanInPoolIds`. It MUST NOT be auto-bound (would corrupt
 * carry-over). It MUST NOT be auto-treated-as-new (would create both a phantom
 * departure of the real loan AND a phantom new loan). The fuzzy-candidate
 * surfacing IS the safe behavior; the human IS the resolution.
 */

import type {
  AssetType,
  ConditionRef,
  Disposition,
  DispositionId,
  DispositionKind,
  ISODateTime,
  LoanInPool,
  LoanInPoolId,
  LoanMembership,
  PendingMembershipEntry,
  PoolId,
  ReasonCategory,
  Tape,
  TapeId,
  TapeOriginatorSummary,
  WorkingTape,
  WorkingTapeId,
} from '@cre/contracts';
import { isReasonCategoryValidForOutcome } from '@cre/contracts';
import {
  computeDispositionId,
  computeTapeId,
} from '../../util/content-hash.js';
import {
  mintLoanInPoolId,
  mintWorkingTapeId,
} from '../../util/pool-ids.js';
import {
  PoolStore,
  WorkingTapeUnresolvedError,
} from '../../storage/pool-store.js';

/* -------------------------------------------------------------------------- */
/* §1. Input + output types                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row of an incoming originator tape — what the pool layer needs to
 * classify the row. The `dealRef` is the caller's responsibility (it's the
 * engine-surface handle; PR3 never reads through it). `originatorLoanRef` is
 * the originator's identifier on THIS tape; re-keys are normal and surface as
 * `'unmatched-needs-confirm'`.
 */
export interface IncomingTapeRow {
  readonly originatorLoanRef: string | null;
  readonly dealRef: string;
  readonly propertyName: string | null;
  readonly assetType: AssetType | null;
  readonly tapePosition: number;

  /* Reseed PR — denormalized per-tape display fields carried into
   * LoanMembership at Phase B. All optional; consumers fall back gracefully. */
  readonly cutOffBalance?:      number | null;
  readonly propertyType?:       string | null;
  readonly mortgageLoanSeller?: string | null;
  readonly city?:               string | null;
  readonly state?:              string | null;

  /* ★ Tape-derived property count (Properties-per-Loan column ∪ decimal-breakout count).
   * >1 ⇒ portfolio. Consumed post-ingest by deriveDealModesFromTape to set deal_mode. */
  readonly propertyCount?:      number | null;
}

export interface IncomingTape {
  readonly poolId: PoolId;
  readonly version: number;
  readonly tapeDate: ISODateTime;
  readonly receivedAt: ISODateTime;
  /** Must equal the pool's current frozen `currentTapeId` (null only for v1). */
  readonly priorTapeId: TapeId | null;
  readonly rows: readonly IncomingTapeRow[];
  readonly originatorSummary: TapeOriginatorSummary | null;
}

export interface AdvanceTapePhaseAResult {
  readonly workingTapeId: WorkingTapeId;
  readonly summary: ReconciliationSummary;
}

export interface ReconciliationSummary {
  /** Rows that exact-matched an existing LoanInPool — bound automatically. */
  readonly carriedCount: number;
  /** Rows in 'unmatched-needs-confirm' — total awaiting human resolution. */
  readonly unmatchedCount: number;
  /** Of the unmatched, how many carry ≥1 candidate hint. */
  readonly unmatchedWithSuggestionsCount: number;
}

/* Phase B ------------------------------------------------------------------ */

export type Resolution =
  | { readonly kind: 'bind-existing'; readonly tapePosition: number; readonly loanInPoolId: LoanInPoolId }
  | { readonly kind: 'confirm-new';   readonly tapePosition: number };

export interface DepartureLabel {
  readonly loanInPoolId: LoanInPoolId;
  readonly originatorLabel: DispositionKind;
  readonly buyerLabel: DispositionKind;
  readonly reasons: readonly string[];
  readonly recordedAt: ISODateTime;
  /**
   * OPTIONAL refinement of the authoritative outcome. Must satisfy
   * `isReasonCategoryValidForOutcome(reasonCategory, buyerLabel)` — validated in
   * `recordDeparture`. Hash-excluded (persisted in the disposition payload only).
   */
  readonly reasonCategory?: ReasonCategory | null;
}

export interface AdvanceTapePhaseBInput {
  readonly workingTapeId: WorkingTapeId;
  readonly resolutions: readonly Resolution[];
  readonly departures: readonly DepartureLabel[];
  readonly recordedBy: { readonly userId: string; readonly displayName: string | null };
  readonly frozenAt: ISODateTime;
}

export interface AdvanceTapePhaseBResult {
  readonly tape: Tape;
  /** LoanInPoolIds minted for 'confirm-new' resolutions. */
  readonly newLoanInPoolIds: readonly LoanInPoolId[];
  /** DispositionIds recorded for departures. */
  readonly dispositionIds: readonly DispositionId[];
}

export class AdvanceTapeError extends Error {
  override readonly name = 'AdvanceTapeError';
  constructor(public readonly reason: string) {
    super(`advance-tape: ${reason}`);
  }
}

/* -------------------------------------------------------------------------- */
/* §2. Phase A — ingest + reconcile                                           */
/* -------------------------------------------------------------------------- */

/**
 * One row on a frozen tape's membership list, lookup-form. Used as a fast read
 * helper when computing carry-over in Phase B.
 */
interface PriorMembershipLookup {
  readonly byLoanInPoolId: ReadonlyMap<LoanInPoolId, LoanMembership>;
}

/**
 * Classify an incoming row by walking the pool's existing LoanInPool records.
 *   - exact match on originatorLoanRef → 'bound' with the existing id
 *   - else fuzzy candidates → 'unmatched-needs-confirm' (with hints)
 *
 * Fuzzy logic (deterministic, hint-only — these are CANDIDATES, not bindings):
 *   - same dealRef as an existing loan (strong)
 *   - same propertyName as an existing loan (strong, if both non-null)
 *   - originatorLoanRef prefix-relation (handles re-key suffixes like '-RE')
 */
function classifyRow(
  row: IncomingTapeRow,
  existingLoans: readonly LoanInPool[],
): PendingMembershipEntry {
  // Exact match on originatorLoanRef → auto-bind. This is the ONLY auto-path;
  // every other case demands human review.
  if (row.originatorLoanRef !== null) {
    const exactMatch = existingLoans.find(
      (l) => l.originatorLoanRef === row.originatorLoanRef,
    );
    if (exactMatch !== undefined) {
      return {
        kind: 'bound',
        binding: {
          loanInPoolId: exactMatch.id,
          dealRef: row.dealRef,
          status: 'under-review',  // Phase B applies carry-over from prior tape
          conditions: [],
          notes: null,
          tapePosition: row.tapePosition,
          // Reseed PR — denormalized per-tape display fields
          propertyName:       row.propertyName,
          cutOffBalance:      row.cutOffBalance ?? null,
          propertyType:       row.propertyType ?? null,
          mortgageLoanSeller: row.mortgageLoanSeller ?? null,
          city:               row.city ?? null,
          state:              row.state ?? null,
        },
        incomingOriginatorRef: row.originatorLoanRef,
      };
    }
  }

  // No exact match → compute candidates. Empty array = genuinely new (or no
  // basis for fuzzy match); human still confirms.
  const candidates = computeCandidates(row, existingLoans);
  return {
    kind: 'unmatched-needs-confirm',
    incomingOriginatorRef: row.originatorLoanRef,
    dealRef: row.dealRef,   // carried so Phase B confirm-new mints with it
    candidateLoanInPoolIds: candidates,
    tapePosition: row.tapePosition,
    // Reseed PR — carried so Phase B confirm-new lands the display fields
    // on the LoanMembership without re-passing IncomingTape.
    propertyName:       row.propertyName,
    cutOffBalance:      row.cutOffBalance ?? null,
    propertyType:       row.propertyType ?? null,
    mortgageLoanSeller: row.mortgageLoanSeller ?? null,
    city:               row.city ?? null,
    state:              row.state ?? null,
  };
}

function computeCandidates(
  row: IncomingTapeRow,
  existingLoans: readonly LoanInPool[],
): readonly LoanInPoolId[] {
  const candidates = new Set<LoanInPoolId>();

  // Strong: dealRef match.
  for (const loan of existingLoans) {
    if (loan.dealRef === row.dealRef) candidates.add(loan.id);
  }

  // Strong: propertyName match (when both non-null).
  if (row.propertyName !== null) {
    for (const loan of existingLoans) {
      if (loan.propertyName === row.propertyName) candidates.add(loan.id);
    }
  }

  // Weaker: originatorLoanRef prefix-relation. "BMARK-L004" vs "BMARK-L004-RE"
  // — one is a prefix of the other. Minimum 6 chars to avoid spurious matches.
  if (row.originatorLoanRef !== null && row.originatorLoanRef.length >= 6) {
    for (const loan of existingLoans) {
      if (loan.originatorLoanRef === null || loan.originatorLoanRef.length < 6) continue;
      if (originatorRefSimilar(row.originatorLoanRef, loan.originatorLoanRef)) {
        candidates.add(loan.id);
      }
    }
  }

  return Array.from(candidates);
}

function originatorRefSimilar(a: string, b: string): boolean {
  // One is a prefix of the other. Catches suffix re-keys (-RE, -v2, etc.).
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Phase A — open a working tape with reconciled pendingMembership. Validates
 * the prior tape pointer against the pool's current state, then classifies
 * every row. Returns the working tape id + a summary the rail UI can read to
 * surface the unmatched queue.
 *
 * Throws `AdvanceTapeError` on pool-not-found, prior-tape mismatch, or version
 * non-monotonic.
 */
export function advanceTapePhaseA(
  store: PoolStore,
  input: IncomingTape,
): AdvanceTapePhaseAResult {
  const pool = store.getPool(input.poolId);
  if (pool === null) {
    throw new AdvanceTapeError(`pool ${input.poolId} not found`);
  }

  if (pool.currentTapeId !== input.priorTapeId) {
    throw new AdvanceTapeError(
      `priorTapeId mismatch: pool.currentTapeId=${pool.currentTapeId} but input.priorTapeId=${input.priorTapeId}`,
    );
  }

  // Look up every existing LoanInPool for this pool (the reconciliation domain).
  const existingLoans = listLoansInPool(store, input.poolId);

  // Classify every row.
  const pendingMembership: PendingMembershipEntry[] = input.rows.map((row) =>
    classifyRow(row, existingLoans),
  );

  const workingTape: WorkingTape = {
    id: mintWorkingTapeId(),
    poolId: input.poolId,
    version: input.version,
    tapeDate: input.tapeDate,
    receivedAt: input.receivedAt,
    priorTapeId: input.priorTapeId,
    pendingMembership,
    originatorSummary: input.originatorSummary,
  };

  // Storage layer's UNIQUE(working_tape.pool_id) is the structural guard
  // against opening a 2nd working tape; PR3 doesn't paper over that throw —
  // callers get `WorkingTapeAlreadyOpenError` if they try to advance twice.
  store.insertWorkingTape(workingTape);

  return {
    workingTapeId: workingTape.id,
    summary: summarize(pendingMembership),
  };
}

function summarize(membership: readonly PendingMembershipEntry[]): ReconciliationSummary {
  let carried = 0;
  let unmatched = 0;
  let withSuggestions = 0;
  for (const entry of membership) {
    if (entry.kind === 'bound') carried += 1;
    else if (entry.kind === 'unmatched-needs-confirm') {
      unmatched += 1;
      if (entry.candidateLoanInPoolIds.length > 0) withSuggestions += 1;
    }
    // 'new-loan-confirmed' is not produced by Phase A (PR3 short-circuits via
    // direct minting in Phase B); reaching this branch would indicate an
    // unexpected input shape, but we tolerate it for forward-compat.
  }
  return {
    carriedCount: carried,
    unmatchedCount: unmatched,
    unmatchedWithSuggestionsCount: withSuggestions,
  };
}

/* -------------------------------------------------------------------------- */
/* §3. Phase B — resolve, carry-over, departures, freeze                      */
/* -------------------------------------------------------------------------- */

/**
 * Phase B — finalize a working tape: apply resolutions, mint LoanInPool on
 * confirm-new, apply carry-over from prior, record departure dispositions,
 * freeze the tape, advance the pool pointer.
 *
 * Contract checks (any failure → `AdvanceTapeError`, NOT swallowed):
 *   - Every `'unmatched-needs-confirm'` entry must have a resolution.
 *   - Every resolution's `tapePosition` must match an unmatched entry.
 *   - `bind-existing` must reference a real LoanInPool in this pool.
 *   - Every departure (loan on prior tape not on this tape) must have a label.
 *
 * Failure of any of those is surfaced; PR2's `freezeTape` guard fires as a
 * defense-in-depth backstop.
 */
export function advanceTapePhaseB(
  store: PoolStore,
  input: AdvanceTapePhaseBInput,
): AdvanceTapePhaseBResult {
  const wt = store.getWorkingTape(input.workingTapeId);
  if (wt === null) {
    throw new AdvanceTapeError(`working tape ${input.workingTapeId} not found`);
  }

  // 1. Index resolutions by tapePosition for O(1) lookup.
  const resolutionsByPosition = new Map<number, Resolution>();
  for (const r of input.resolutions) {
    if (resolutionsByPosition.has(r.tapePosition)) {
      throw new AdvanceTapeError(`duplicate resolution for tapePosition ${r.tapePosition}`);
    }
    resolutionsByPosition.set(r.tapePosition, r);
  }

  // 2. Walk pendingMembership; apply resolutions; produce the resolved-all-bound
  //    pendingMembership. Track new LoanInPoolIds minted along the way.
  const newLoanInPoolIds: LoanInPoolId[] = [];
  const minted: Array<{
    readonly loanInPoolId: LoanInPoolId;
    readonly dealRef: string;
    readonly originatorRef: string | null;
    readonly tapePosition: number;
  }> = [];
  const rekeyUpdates: Array<{ readonly loanInPoolId: LoanInPoolId; readonly newRef: string | null }> = [];

  const resolvedPending: PendingMembershipEntry[] = wt.pendingMembership.map((entry) => {
    if (entry.kind === 'bound') return entry;
    if (entry.kind === 'new-loan-confirmed') {
      // Phase B doesn't expect this state — PR3 doesn't produce it. Defensive
      // throw so a future change can't slip an unmodelled state through.
      throw new AdvanceTapeError(
        `pendingMembership[${entry.tapePosition}].kind === 'new-loan-confirmed' is not a Phase A output; ` +
          `PR3 short-circuits via direct minting`,
      );
    }
    // 'unmatched-needs-confirm' — must have a resolution.
    const resolution = resolutionsByPosition.get(entry.tapePosition);
    if (resolution === undefined) {
      throw new AdvanceTapeError(
        `unresolved entry at tapePosition ${entry.tapePosition} — supply a resolution`,
      );
    }
    if (resolution.kind === 'bind-existing') {
      const existing = store.getLoanInPool(resolution.loanInPoolId);
      if (existing === null || existing.poolId !== wt.poolId) {
        throw new AdvanceTapeError(
          `bind-existing references LoanInPool ${resolution.loanInPoolId} which does not exist in pool ${wt.poolId}`,
        );
      }
      // Originator may have re-keyed — record the new ref for an UPDATE pass
      // after freeze (so subsequent tapes exact-match without re-triggering
      // unmatched-needs-confirm).
      if (existing.originatorLoanRef !== entry.incomingOriginatorRef) {
        rekeyUpdates.push({
          loanInPoolId: resolution.loanInPoolId,
          newRef: entry.incomingOriginatorRef,
        });
      }
      return {
        kind: 'bound',
        binding: {
          loanInPoolId: resolution.loanInPoolId,
          dealRef: existing.dealRef,  // engine handle from the existing record
          status: 'under-review',     // carry-over rewrites this below
          conditions: [],
          notes: null,
          tapePosition: entry.tapePosition,
          // Per-tape display fields from THIS tape's row (audit-faithful —
          // captures balance restructures, name drifts, etc. for the rebound loan).
          propertyName:       entry.propertyName       ?? existing.propertyName,
          cutOffBalance:      entry.cutOffBalance      ?? null,
          propertyType:       entry.propertyType       ?? null,
          mortgageLoanSeller: entry.mortgageLoanSeller ?? null,
          city:               entry.city               ?? null,
          state:              entry.state              ?? null,
        },
        incomingOriginatorRef: entry.incomingOriginatorRef,
      };
    }
    // confirm-new: mint a LoanInPool. We don't insert the record yet — we need
    // the new TapeId first (for addedOnTape). The mint just gives us a stable
    // id we can reference; the row gets inserted after the TapeId is known.
    const newId = mintLoanInPoolId();
    newLoanInPoolIds.push(newId);
    minted.push({
      loanInPoolId: newId,
      dealRef: entry.dealRef,                    // carried on the unmatched entry
      originatorRef: entry.incomingOriginatorRef,
      tapePosition: entry.tapePosition,
    });
    return {
      kind: 'bound',
      binding: {
        loanInPoolId: newId,
        dealRef: entry.dealRef,
        status: 'under-review',
        conditions: [],
        notes: null,
        tapePosition: entry.tapePosition,
        propertyName:       entry.propertyName       ?? null,
        cutOffBalance:      entry.cutOffBalance      ?? null,
        propertyType:       entry.propertyType       ?? null,
        mortgageLoanSeller: entry.mortgageLoanSeller ?? null,
        city:               entry.city               ?? null,
        state:              entry.state              ?? null,
      },
      incomingOriginatorRef: entry.incomingOriginatorRef,
    };
  });

  // 3. Apply carry-over from the prior tape (status + conditions) for every
  //    bound entry whose LoanInPoolId existed on the prior. New loans keep
  //    'under-review'. This is the SINGLE place carry-over runs.
  const priorLookup = buildPriorLookup(store, wt.priorTapeId);
  const carriedPending: PendingMembershipEntry[] = resolvedPending.map((entry) => {
    if (entry.kind !== 'bound') return entry;
    const prior = priorLookup.byLoanInPoolId.get(entry.binding.loanInPoolId);
    if (prior === undefined) return entry;  // new loan: keep 'under-review'
    return {
      ...entry,
      binding: { ...entry.binding, status: prior.status, conditions: prior.conditions },
    };
  });

  // 4. Persist resolved + carried pendingMembership back to the working tape.
  store.updateWorkingTape({ ...wt, pendingMembership: carriedPending });

  // 5. Compute the to-be-frozen TapeId from the resolved membership (same hash
  //    input PR2's freezeTape will compute — idempotent by construction).
  const finalMembership: LoanMembership[] = carriedPending.map((e) => {
    if (e.kind !== 'bound') {
      throw new AdvanceTapeError(`unreachable: entry should be bound after resolutions`);
    }
    return e.binding;
  });
  const newTapeId: TapeId = computeTapeId({
    poolId: wt.poolId,
    version: wt.version,
    tapeDate: wt.tapeDate,
    priorTapeId: wt.priorTapeId,
    membership: finalMembership,
    originatorSummary: wt.originatorSummary,
  });

  // 6. Insert LoanInPool rows for confirm-new mints (addedOnTape = newTapeId).
  //    addedOnTape is a forward reference to a tape that doesn't exist YET —
  //    permissible because the DDL declared no FK on added_on_tape. The Tape
  //    row gets inserted in step 7 (via freezeTape).
  for (const m of minted) {
    const loan: LoanInPool = {
      id: m.loanInPoolId,
      poolId: wt.poolId,
      dealRef: m.dealRef,
      addedOnTape: newTapeId,
      originatorLoanRef: m.originatorRef,
      propertyName: null,
      assetType: null,
      currentDispositionId: null,
    };
    store.insertLoanInPool(loan);
  }

  // 7. Freeze through PR2's primitive. PR2's guard (refuse-on-unmatched) is the
  //    defense-in-depth backstop — by this point Phase B has resolved every
  //    entry, so the call should succeed. If it throws, the throw is surfaced.
  let frozenTape: Tape;
  try {
    frozenTape = store.freezeTape(input.workingTapeId, input.frozenAt);
  } catch (e) {
    if (e instanceof WorkingTapeUnresolvedError) {
      throw new AdvanceTapeError(
        `freezeTape refused: ${e.unresolvedCount} unresolved pending entry/entries — ` +
          `Phase B did not produce an all-bound membership. This is a Phase B bug.`,
      );
    }
    throw e;
  }

  // 8. Apply re-key UPDATEs to LoanInPool.originator_loan_ref (so future tapes
  //    exact-match the new ref). Audit trail is preserved in each tape's
  //    bound-entry `incomingOriginatorRef` field.
  for (const r of rekeyUpdates) {
    store.updateOriginatorLoanRef(r.loanInPoolId, r.newRef);
  }

  // 9. Record dispositions for departures (loans on prior tape not on this).
  const dispositionIds: DispositionId[] = [];
  if (wt.priorTapeId !== null) {
    const priorIds = new Set(priorLookup.byLoanInPoolId.keys());
    const thisIds = new Set(finalMembership.map((m) => m.loanInPoolId));
    const departed: LoanInPoolId[] = [];
    for (const id of priorIds) if (!thisIds.has(id)) departed.push(id);

    const labelsByLoan = new Map<LoanInPoolId, DepartureLabel>();
    for (const d of input.departures) labelsByLoan.set(d.loanInPoolId, d);

    for (const departedId of departed) {
      // ── Standalone-disposition double-count guard (Phase 1) ──────────────
      // SKIP any departing loan that ALREADY carries a `currentDispositionId`:
      // it was disposed out-of-band (by the forthcoming standalone-disposition
      // write, or an earlier departure). WHY this is needed: a pre-freeze
      // standalone disposition leaves the loan on the IMMUTABLE current tape
      // (the tape isn't rewritten when a loan is disposed out-of-band), so the
      // NEXT freeze still sees it in `priorIds \ thisIds` and would re-flag it
      // as a departure. That second `recordDeparture` computes a DIFFERENT
      // DispositionId — its hash includes `leftOnTape`, which now differs from
      // the out-of-band disposition's `leftOnTape` — so it is NOT deduped by
      // `recordDisposition`'s ON CONFLICT(id) DO NOTHING → a genuine
      // DOUBLE-RECORD (two disposition rows for one loan). Reading the loan's
      // `currentDispositionId` from the store and skipping when non-null is
      // symmetric to the existing `assertNotClosedForDisposition` guard: a loan
      // is on-tape XOR departed XOR closed — an already-disposed loan is spent.
      const existingLoan = store.getLoanInPool(departedId);
      if (existingLoan !== null && existingLoan.currentDispositionId !== null) {
        // Already disposed → do not record a second departure. The prior
        // DispositionId stands; nothing appended, nothing to push.
        continue;
      }

      const label = labelsByLoan.get(departedId);
      if (label === undefined) {
        // Contract intact: a genuinely-new departure (no prior disposition)
        // STILL requires its DepartureLabel. Only already-disposed loans are
        // exempt (they `continue`d above); this reaches only real departures.
        throw new AdvanceTapeError(
          `departed loan ${departedId} requires a DepartureLabel — supply one`,
        );
      }
      const dispositionId = recordDeparture(
        store, wt.poolId, departedId, wt.priorTapeId, frozenTape.id, label, input.recordedBy,
      );
      dispositionIds.push(dispositionId);
    }
  } else {
    // priorTapeId === null → v1. There are no departures from a non-existent
    // prior. If the caller supplied departures here, it's a misconfiguration.
    if (input.departures.length > 0) {
      throw new AdvanceTapeError('v1 tape (no prior) cannot have departures — input.departures must be empty');
    }
  }

  // 10. Advance the pool pointer.
  store.setCurrentTape(wt.poolId, frozenTape.id);

  return {
    tape: frozenTape,
    newLoanInPoolIds,
    dispositionIds,
  };
}

function buildPriorLookup(store: PoolStore, priorTapeId: TapeId | null): PriorMembershipLookup {
  if (priorTapeId === null) {
    return { byLoanInPoolId: new Map() };
  }
  const priorMembership = store.getMembership(priorTapeId);
  const byLoanInPoolId = new Map<LoanInPoolId, LoanMembership>();
  for (const m of priorMembership) byLoanInPoolId.set(m.loanInPoolId, m);
  return { byLoanInPoolId };
}

/**
 * P4c-status symmetric guard. A loan whose per-loan `lifecycleStatus === 'closed'`
 * (positive terminal) cannot then be disposed — Closed XOR departed XOR on-tape.
 * Throws `AdvanceTapeError` if the loan is closed; no-op otherwise. Exported so the
 * gate harness exercises the EXACT guard the disposition write path uses.
 */
export function assertNotClosedForDisposition(store: PoolStore, loanInPoolId: LoanInPoolId): void {
  const loan = store.getLoanInPool(loanInPoolId);
  if (loan !== null && loan.lifecycleStatus === 'closed') {
    throw new AdvanceTapeError(
      `loan ${loanInPoolId} is closed (positive terminal) and cannot be disposed`,
    );
  }
}

function recordDeparture(
  store: PoolStore,
  poolId: PoolId,
  loanInPoolId: LoanInPoolId,
  lastSeenOnTape: TapeId,
  leftOnTape: TapeId,
  label: DepartureLabel,
  recordedBy: { readonly userId: string; readonly displayName: string | null },
): DispositionId {
  // Freeze-time departure = the shared write core with FREEZE tape context:
  // lastSeenOnTape = prior frozen tape, leftOnTape = the newly-frozen tape (the
  // consecutive-tape event, `version + 1`, pool.ts:389). The out-of-band
  // standalone path reuses the SAME core with a relaxed tape context (§B5).
  return writeDisposition(store, {
    poolId,
    loanInPoolId,
    lastSeenOnTape,
    leftOnTape,
    originatorLabel: label.originatorLabel,
    buyerLabel: label.buyerLabel,
    reasons: label.reasons,
    reasonCategory: label.reasonCategory ?? null,
    recordedAt: label.recordedAt,
    recordedBy,
  });
}

/* -------------------------------------------------------------------------- */
/* §5. Standalone disposition — out-of-band per-loan reject/withdraw          */
/* -------------------------------------------------------------------------- */

/**
 * Typed error for the honest refusal when a pool has no current frozen tape.
 * A disposition needs a `lastSeenOnTape` (the tape the loan is departing FROM);
 * with no frozen tape there is nothing to depart from → refuse rather than
 * fabricate a tape id. The route maps this to 422 NO_CURRENT_TAPE.
 */
export class NoCurrentTapeError extends Error {
  override readonly name = 'NoCurrentTapeError';
  constructor(public readonly poolId: PoolId, public readonly loanInPoolId: LoanInPoolId) {
    super(`pool ${poolId} has no current frozen tape — loan ${loanInPoolId} cannot be disposed out-of-band`);
  }
}

/** Typed error: the loan already carries a `currentDispositionId`. */
export class LoanAlreadyDisposedError extends Error {
  override readonly name = 'LoanAlreadyDisposedError';
  constructor(public readonly loanInPoolId: LoanInPoolId, public readonly currentDispositionId: DispositionId) {
    super(`loan ${loanInPoolId} is already disposed (${currentDispositionId})`);
  }
}

export interface StandaloneDispositionInput {
  readonly outcome: DispositionKind;
  readonly reasonCategory?: ReasonCategory | null;
  readonly note?: string | null;
  readonly recordedBy: { readonly userId: string; readonly displayName: string | null };
  readonly recordedAt: ISODateTime;
}

export interface StandaloneDispositionResult {
  readonly dispositionId: DispositionId;
  readonly disposition: Disposition;
  readonly loan: LoanInPool;
}

/**
 * Record a standalone, out-of-band disposition for ONE loan — the deal-room /
 * pool-page "reject/withdraw this loan now" write. NO tape freeze.
 *
 * REUSE: `writeDisposition` (the exact hash/validate/persist core `recordDeparture`
 * uses), `assertNotClosedForDisposition` (the closed-XOR-disposed guard). The
 * mutual-exclusion vs the freeze-time double-count is handled by Phase 1's guard
 * in `advanceTapePhaseB`'s departure loop.
 *
 * NET-NEW: the tape-context assembly. A freeze-time departure is a tape-DIFF; here
 * there is no freeze, so:
 *   - `lastSeenOnTape = pool.currentTapeId` — the tape the loan is currently ON.
 *     Null → `NoCurrentTapeError` (422; never fabricate a tape).
 *   - `leftOnTape = lastSeenOnTape` (§B5-a). The out-of-band reject leaves from the
 *     CURRENT tape (no next tape exists yet). This RELAXES the `version + 1`
 *     invariant (pool.ts:389) to `>=` for out-of-band rejects (`==` here); it is a
 *     doctrine-only invariant, NOT machine-enforced (no code compares tape
 *     versions), and B5 hash-safety holds — `DispositionIdHashInput` hashes the
 *     `TapeId` VALUES, not any version delta.
 *   - `originatorLabel = buyerLabel = outcome` — a buyer-initiated out-of-band
 *     reject carries no conflicting originator label, so `override === false`.
 *   - `note` (when present) rides in `reasons: string[]`.
 *
 * Guards (all before the write):
 *   - `assertNotClosedForDisposition` → AdvanceTapeError (closed loan can't be disposed).
 *   - `pool.currentTapeId === null` → `NoCurrentTapeError`.
 *   - already-disposed (`currentDispositionId != null`): IDEMPOTENT no-op iff the
 *     re-submit is byte-identical decision content (the recomputed DispositionId
 *     equals the stored one) — mirrors /close's idempotent-closed. Otherwise
 *     `LoanAlreadyDisposedError` (a real correction goes through the append-only
 *     `supersedes` chain, not a silent overwrite).
 */
export function recordStandaloneDisposition(
  store: PoolStore,
  poolId: PoolId,
  loanInPoolId: LoanInPoolId,
  input: StandaloneDispositionInput,
): StandaloneDispositionResult {
  const loan = store.getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    // Caller (route) resolves 404; the service refuses a missing/mismatched target.
    throw new AdvanceTapeError(`loan ${loanInPoolId} not found in pool ${poolId}`);
  }

  // Guard 1: closed XOR disposed (mirror recordDeparture's first check).
  assertNotClosedForDisposition(store, loanInPoolId);

  // Guard 2: honest refuse — nothing to depart from without a current tape.
  const pool = store.getPool(poolId);
  if (pool === null) {
    throw new AdvanceTapeError(`pool ${poolId} not found`);
  }
  if (pool.currentTapeId === null) {
    throw new NoCurrentTapeError(poolId, loanInPoolId);
  }

  // Tape context (net-new): out-of-band reject leaves FROM the current tape.
  const lastSeenOnTape = pool.currentTapeId;
  const leftOnTape = lastSeenOnTape; // §B5-a: leftOnTape == lastSeenOnTape.

  // Validate reasonCategory before minting (same as recordDeparture core does).
  if (!isReasonCategoryValidForOutcome(input.reasonCategory ?? null, input.outcome)) {
    throw new AdvanceTapeError(
      `reasonCategory '${input.reasonCategory}' is not valid for outcome '${input.outcome}' (loan ${loanInPoolId})`,
    );
  }

  const reasons: string[] = input.note != null && input.note.length > 0 ? [input.note] : [];

  // Pre-compute the id so idempotency can be decided WITHOUT a write on the
  // already-disposed path.
  const prospectiveId = computeDispositionId({
    poolId,
    loanInPoolId,
    lastSeenOnTape,
    leftOnTape,
    originatorLabel: input.outcome,
    buyerLabel: input.outcome,
    authoritative: input.outcome,
    override: false,
    reasons,
    recordedBy: input.recordedBy,
    supersedes: null,
  });

  // Guard 3: already-disposed → idempotent iff byte-identical, else conflict.
  if (loan.currentDispositionId != null) {
    if (loan.currentDispositionId === prospectiveId) {
      // Byte-identical re-submit → 200 no-op. Return the existing disposition.
      const existing = store
        .getDispositions(poolId)
        .find((d) => d.id === loan.currentDispositionId);
      if (existing !== undefined) {
        return { dispositionId: existing.id, disposition: existing, loan };
      }
    }
    throw new LoanAlreadyDisposedError(loanInPoolId, loan.currentDispositionId);
  }

  const dispositionId = writeDisposition(store, {
    poolId,
    loanInPoolId,
    lastSeenOnTape,
    leftOnTape,
    originatorLabel: input.outcome,
    buyerLabel: input.outcome,
    reasons,
    reasonCategory: input.reasonCategory ?? null,
    recordedAt: input.recordedAt,
    recordedBy: input.recordedBy,
  });

  const written = store.getDispositions(poolId).find((d) => d.id === dispositionId)!;
  const updatedLoan = store.getLoanInPool(loanInPoolId)!;
  return { dispositionId, disposition: written, loan: updatedLoan };
}

/* -------------------------------------------------------------------------- */
/* §5b. Shared disposition write core (reused by both departure paths)         */
/* -------------------------------------------------------------------------- */

interface DispositionWriteCore {
  readonly poolId: PoolId;
  readonly loanInPoolId: LoanInPoolId;
  readonly lastSeenOnTape: TapeId;
  readonly leftOnTape: TapeId;
  readonly originatorLabel: DispositionKind;
  readonly buyerLabel: DispositionKind;
  readonly reasons: readonly string[];
  readonly reasonCategory: ReasonCategory | null;
  readonly recordedAt: ISODateTime;
  readonly recordedBy: { readonly userId: string; readonly displayName: string | null };
}

/**
 * The shared hash/validate/persist core of a disposition write. Factored OUT of
 * `recordDeparture` so the freeze-time and out-of-band paths share ONE hash
 * derivation — no duplicated hash logic. The caller supplies the tape context
 * (freeze-diff vs out-of-band) + labels; this computes `override`, validates the
 * reasonCategory refinement, mints the `DispositionId`, and writes both the
 * `disposition` row and the `current_disposition_id` pointer.
 */
function writeDisposition(store: PoolStore, core: DispositionWriteCore): DispositionId {
  // P4c-status symmetric guard: a CLOSED loan (positive terminal) cannot depart.
  assertNotClosedForDisposition(store, core.loanInPoolId);

  const override = core.originatorLabel !== core.buyerLabel;
  // reasonCategory is an OPTIONAL, hash-EXCLUDED refinement of the authoritative
  // outcome. Reject a mismatched pair before we mint an id / persist.
  if (!isReasonCategoryValidForOutcome(core.reasonCategory, core.buyerLabel)) {
    throw new AdvanceTapeError(
      `reasonCategory '${core.reasonCategory}' is not valid for outcome '${core.buyerLabel}' ` +
        `(loan ${core.loanInPoolId})`,
    );
  }
  const hashInput = {
    poolId: core.poolId,
    loanInPoolId: core.loanInPoolId,
    lastSeenOnTape: core.lastSeenOnTape,
    leftOnTape: core.leftOnTape,
    originatorLabel: core.originatorLabel,
    buyerLabel: core.buyerLabel,
    authoritative: core.buyerLabel,  // always === buyerLabel (P4)
    override,                         // === (originatorLabel !== buyerLabel) (P5)
    reasons: core.reasons,
    recordedBy: core.recordedBy,
    supersedes: null,
  };
  const id = computeDispositionId(hashInput);
  const disposition: Disposition = {
    id, ...hashInput, recordedAt: core.recordedAt,
    // Body-only refinement — deliberately AFTER the id is computed and NOT in
    // hashInput, so it can never enter the DispositionId hash boundary.
    reasonCategory: core.reasonCategory,
  };
  store.recordDisposition(disposition);
  store.setCurrentDisposition(core.loanInPoolId, id);
  return id;
}

/* -------------------------------------------------------------------------- */
/* §4. Helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * List every LoanInPool for a pool — drives Phase A's reconciliation domain.
 * PR2's store doesn't expose a `listLoansInPool` method directly; we use the
 * indexed db handle. (Adding the convenience to PoolStore is a small PR2
 * extension worth considering on a future pass; for now this keeps PR3
 * contained.)
 */
function listLoansInPool(store: PoolStore, poolId: PoolId): readonly LoanInPool[] {
  // The store's db is private; we go through a thin accessor that matches the
  // test pattern PR2 already uses (read-only SELECT, no writes).
  type AnyDb = { prepare: (sql: string) => { all: (...args: unknown[]) => readonly { readonly id: string; readonly payload: string; readonly current_disposition_id: string | null }[] } };
  const db = (store as unknown as { db: AnyDb }).db;
  const rows = db
    .prepare(
      `SELECT id, payload, current_disposition_id FROM loan_in_pool WHERE pool_id = ?`,
    )
    .all(poolId);
  return rows.map((r) => {
    const body = JSON.parse(r.payload) as Record<string, unknown>;
    return { id: r.id, ...body, currentDispositionId: r.current_disposition_id } as LoanInPool;
  });
}

