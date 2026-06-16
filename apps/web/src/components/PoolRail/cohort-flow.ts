/**
 * Cohort-flow projection — the pool's tape-by-tape biography as a flowing
 * ribbon with added / dropped / kicked tributaries.
 *
 * Pure projection: server payloads → typed flow model. Exported so the SVG
 * component just renders the model and a fixture test can verify the
 * computation without React. Same pattern as `branchForLookup`.
 *
 * BALANCE MODEL (reseed PR B):
 *   - Per-tape **totalBalance** = sum of `membership[].cutOffBalance` for that
 *     tape (skip nulls). null when ALL memberships on a tape have null
 *     balance (synthetic-shaped data) — caller falls back to count-scaling.
 *   - Per-transition **addedBalance** = sum of cutOffBalance for the loans
 *     NEW on this tape (their balance on THIS tape, their first appearance).
 *   - Per-transition **droppedBalance** / **kickedBalance** = sum of
 *     cutOffBalance for the departed loans **as recorded on the PRIOR tape**
 *     (the balance that was in the pool, then left — the audit-faithful
 *     "last-seen" model: when a loan departs, the dollars that left are the
 *     dollars they had on the tape they were last on).
 *
 * MULTIPLICITY: kicked-vs-dropped split is driven by the disposition record's
 * `buyerLabel` (the buyer-authoritative designation; the override mechanic
 * from PR1). A departure with no disposition row defaults to `dropped`.
 */
import type { Disposition, LoanMembership, Tape } from '@cre/contracts';

export interface TransitionFlow {
  /** Set of loanInPoolIds that appeared on BOTH the prior and this tape. */
  readonly carried: number;
  readonly carriedBalance: number | null;
  /** loanInPoolIds present on this tape but not the prior — "+N added". */
  readonly added: number;
  /** Sum of cutOffBalance for the added loans on THIS tape. null when none have balance. */
  readonly addedBalance: number | null;
  /** loanInPoolIds on the prior tape but not this one, with buyerLabel ≠ 'kicked'. */
  readonly dropped: number;
  /** Sum of cutOffBalance for the dropped loans from the PRIOR tape (last seen). */
  readonly droppedBalance: number | null;
  /** Same set, with buyerLabel === 'kicked'. */
  readonly kicked: number;
  readonly kickedBalance: number | null;
}

export interface TapeNode {
  readonly tapeId: string;
  readonly version: number;
  readonly tapeDate: string;
  readonly loanCount: number;
  /** Sum of cutOffBalance across this tape's membership. null when ALL are null. */
  readonly totalBalance: number | null;
  readonly isCurrent: boolean;
  readonly isOrigin: boolean;
  /** null for the origin tape; populated for every subsequent tape. */
  readonly transitionFromPrior: TransitionFlow | null;
}

export interface CohortFlowModel {
  readonly nodes: readonly TapeNode[];
  /** Convenience aggregate: every transition the diagram will draw. */
  readonly transitions: readonly TransitionFlow[];
  /** True iff at least one node has a non-null totalBalance. SVG uses this
   *  to choose between dollar-scaling and count-scaling. */
  readonly hasBalanceData: boolean;
}

/** Pure helper: sum non-null balances; null when EVERY input is null. */
function sumBalance(rows: readonly LoanMembership[]): number | null {
  let sum = 0;
  let anyPresent = false;
  for (const r of rows) {
    const v = r.cutOffBalance;
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      sum += v;
      anyPresent = true;
    }
  }
  return anyPresent ? sum : null;
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
    return { nodes: [], transitions: [], hasBalanceData: false };
  }

  // Bucket dispositions by leftOnTape so per-transition lookup is O(1).
  const departedByLeftOnTape = new Map<string, readonly Disposition[]>();
  for (const d of dispositions) {
    const arr = departedByLeftOnTape.get(d.leftOnTape) ?? [];
    departedByLeftOnTape.set(d.leftOnTape, [...arr, d]);
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
      const priorIds = new Set(prior.membership.map(m => m.loanInPoolId as string));
      const thisIds = new Set(tape.membership.map(m => m.loanInPoolId as string));

      const carriedRows = tape.membership.filter(m => priorIds.has(m.loanInPoolId as string));
      const addedRows   = tape.membership.filter(m => !priorIds.has(m.loanInPoolId as string));
      const departedRowsPrior = prior.membership.filter(m => !thisIds.has(m.loanInPoolId as string));

      // Departures = priorIds \ thisIds. Split by disposition buyerLabel.
      const dispsForThisLeftOn = departedByLeftOnTape.get(tape.id as string) ?? [];
      const dispByLoanInPoolId = new Map<string, Disposition>();
      for (const d of dispsForThisLeftOn) dispByLoanInPoolId.set(d.loanInPoolId as string, d);

      const droppedRowsPrior: LoanMembership[] = [];
      const kickedRowsPrior: LoanMembership[] = [];
      for (const row of departedRowsPrior) {
        const d = dispByLoanInPoolId.get(row.loanInPoolId as string);
        // Buyer-authoritative label. No disposition → conservative dropped.
        if (d?.buyerLabel === 'kicked') kickedRowsPrior.push(row);
        else droppedRowsPrior.push(row);
      }

      transitionFromPrior = {
        carried:         carriedRows.length,
        carriedBalance:  sumBalance(carriedRows),
        added:           addedRows.length,
        addedBalance:    sumBalance(addedRows),
        dropped:         droppedRowsPrior.length,
        droppedBalance:  sumBalance(droppedRowsPrior),
        kicked:          kickedRowsPrior.length,
        kickedBalance:   sumBalance(kickedRowsPrior),
      };
    }

    nodes.push({
      tapeId: tape.id as string,
      version: tape.version,
      tapeDate: tape.tapeDate,
      loanCount: tape.membership.length,
      totalBalance,
      isCurrent: (tape.id as string) === currentTapeId,
      isOrigin,
      transitionFromPrior,
    });
  }

  const transitions: TransitionFlow[] = nodes
    .map(n => n.transitionFromPrior)
    .filter((t): t is TransitionFlow => t !== null);

  return { nodes, transitions, hasBalanceData };
}
