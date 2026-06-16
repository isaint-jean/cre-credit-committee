/**
 * Cohort-flow projection — the pool's tape-by-tape biography as a flowing
 * ribbon with added / dropped / kicked tributaries.
 *
 * Pure projection: server payloads → typed flow model. Exported so the SVG
 * component just renders the model and a fixture test can verify the
 * computation without React. Same pattern as `branchForLookup` in
 * MembershipTable.
 *
 * BALANCE: the pool contract does not carry per-loan balance today
 * (`LoanMembership` has loanInPoolId, dealRef, status, conditions, notes,
 * tapePosition — no balance; `Tape` has no aggregate balance either). So the
 * ribbon scales by LOAN COUNT, and the prototype's "$X.XB" labels are
 * honestly OMITTED rather than fabricated. When the contract eventually
 * carries balance, this projection picks it up automatically.
 *
 * MULTIPLICITY: the kicked-vs-dropped split is driven by the disposition
 * record's `buyerLabel` (the buyer-authoritative designation; the override
 * mechanic from PR1). A departure with no disposition row is impossible
 * under PR3's freezeTape contract, but we tolerate it as a generic "departed"
 * by defaulting unrecorded departures to `dropped` (most-conservative read).
 */
import type { Disposition, Tape } from '@cre/contracts';

export interface TransitionFlow {
  /** Set of loanInPoolIds that appeared on BOTH the prior and this tape. */
  readonly carried: number;
  /** loanInPoolIds present on this tape but not the prior — "+N added". */
  readonly added: number;
  /** loanInPoolIds on the prior tape but not this one, with buyerLabel ≠ 'kicked'. */
  readonly dropped: number;
  /** Same set, with buyerLabel === 'kicked'. */
  readonly kicked: number;
}

export interface TapeNode {
  readonly tapeId: string;
  readonly version: number;
  readonly tapeDate: string;
  readonly loanCount: number;
  readonly isCurrent: boolean;
  readonly isOrigin: boolean;
  /** null for the origin tape; populated for every subsequent tape. */
  readonly transitionFromPrior: TransitionFlow | null;
}

export interface CohortFlowModel {
  readonly nodes: readonly TapeNode[];
  /** Convenience aggregate: every transition the diagram will draw. */
  readonly transitions: readonly TransitionFlow[];
}

/**
 * Project the rail's already-loaded tape + disposition payloads into the
 * cohort-flow visual model.
 *
 * `tapes` must be in chronological order (v1 → vN). The rail page's existing
 * priorTapeId-chain walk produces this order; this projection trusts it.
 */
export function computeCohortFlow(
  tapes: readonly Tape[],
  dispositions: readonly Disposition[],
  currentTapeId: string | null,
): CohortFlowModel {
  if (tapes.length === 0) {
    return { nodes: [], transitions: [] };
  }

  // Bucket dispositions by leftOnTape so per-transition lookup is O(1).
  const departedByLeftOnTape = new Map<string, readonly Disposition[]>();
  for (const d of dispositions) {
    const arr = departedByLeftOnTape.get(d.leftOnTape) ?? [];
    departedByLeftOnTape.set(d.leftOnTape, [...arr, d]);
  }

  const nodes: TapeNode[] = [];
  for (let i = 0; i < tapes.length; i++) {
    const tape = tapes[i]!;
    const isOrigin = i === 0;

    let transitionFromPrior: TransitionFlow | null = null;
    if (!isOrigin) {
      const prior = tapes[i - 1]!;
      const priorIds = new Set(prior.membership.map(m => m.loanInPoolId as string));
      const thisIds = new Set(tape.membership.map(m => m.loanInPoolId as string));

      let carried = 0;
      for (const id of priorIds) if (thisIds.has(id)) carried += 1;
      const added = tape.membership.length - carried;

      // Departures = priorIds \ thisIds. Split by disposition buyerLabel.
      const departedIds: string[] = [];
      for (const id of priorIds) if (!thisIds.has(id)) departedIds.push(id);

      const dispsForThisLeftOn = departedByLeftOnTape.get(tape.id as string) ?? [];
      const dispByLoanInPoolId = new Map<string, Disposition>();
      for (const d of dispsForThisLeftOn) dispByLoanInPoolId.set(d.loanInPoolId as string, d);

      let kicked = 0;
      let dropped = 0;
      for (const id of departedIds) {
        const d = dispByLoanInPoolId.get(id);
        // Buyer-authoritative label. If a departure has no recorded disposition
        // (shouldn't happen under PR3's contract), conservatively count as dropped.
        if (d?.buyerLabel === 'kicked') kicked += 1;
        else dropped += 1;
      }
      transitionFromPrior = { carried, added, dropped, kicked };
    }

    nodes.push({
      tapeId: tape.id as string,
      version: tape.version,
      tapeDate: tape.tapeDate,
      loanCount: tape.membership.length,
      isCurrent: (tape.id as string) === currentTapeId,
      isOrigin,
      transitionFromPrior,
    });
  }

  const transitions: TransitionFlow[] = nodes
    .map(n => n.transitionFromPrior)
    .filter((t): t is TransitionFlow => t !== null);

  return { nodes, transitions };
}
