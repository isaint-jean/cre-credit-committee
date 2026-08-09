/**
 * underwrite-worker — Data-Room Phase 3, P3. The in-process drain that runs the
 * durable queue OFF the request path.
 *
 * P2 fired `underwriteLoan` fire-and-forget FROM the assign response. P3 splits
 * that in two: the settle now only ENQUEUES a durable job (returns fast — the
 * assign never waits on K×(extraction+LLM)); THIS worker drains the queue in the
 * background.
 *
 * The loop:
 *   claimNext() → a `running` job  → run P1's `underwriteLoan` VERBATIM
 *     → markDone(id)                    on full success (incl. narrative)
 *     → markPartial(id, reason)         scored but narrative deferred (credits) —
 *                                       a degraded success, NOT a failure
 *     → markFailed(id, realReason)      on failure (honest — never a fake success)
 *   repeat until the queue is empty.
 *
 * ONE DRAIN AT A TIME per store (a module-level in-flight guard) so we never run
 * two overlapping drains that could both claim work — the point is a single
 * sequential worker off the request path, not throughput. `kick()` is idempotent:
 * an enqueue calls it, but if a drain is already running the kick is a no-op (the
 * running drain will pick the just-enqueued job on its next claimNext()).
 *
 * The worker NEVER re-implements the branch — one loan = ONE `underwriteLoan`
 * (which P1 coalesces to ONE append/ingest). No NEW underwrite behavior.
 */

import type { UnderwriteJobStore } from '../../storage/underwrite-job-store.js';
import { underwriteJobStore as defaultJobStore } from '../../storage/underwrite-job-store.js';
import { PoolStore } from '../../storage/pool-store.js';
import {
  underwriteLoan as defaultUnderwriteLoan,
  UnderwriteLoanError,
} from './underwrite-loan.service.js';
import type { LoanInPoolId } from '@cre/contracts';

export interface UnderwriteWorkerDeps {
  readonly jobStore?: UnderwriteJobStore;
  readonly poolStore?: PoolStore;
  readonly underwriteLoan?: typeof defaultUnderwriteLoan;
  /** Injected so proofs can observe each job's terminal outcome. */
  readonly onJobSettled?: (o: DrainOutcome) => void;
}

export type DrainOutcome =
  | { readonly jobId: string; readonly loanInPoolId: string; readonly state: 'done'; readonly outcome: string }
  | { readonly jobId: string; readonly loanInPoolId: string; readonly state: 'partial'; readonly outcome: string; readonly reason: string }
  | { readonly jobId: string; readonly loanInPoolId: string; readonly state: 'failed'; readonly reason: string };

/** In-flight guard keyed by the store instance — one drain per store at a time. */
const _draining = new WeakMap<UnderwriteJobStore, Promise<DrainOutcome[]>>();

/**
 * Drain the queue to empty: claim → run → mark, sequentially. Resolves with the
 * per-job outcomes. If a drain is already in flight for this store, returns the
 * SAME in-flight promise (never two overlapping drains). Never rejects — every
 * job resolves to a done/failed outcome; one job's failure is ISOLATED and cannot
 * abort a sibling (P2's isolated-failure property, preserved through the queue).
 */
export function drainUnderwriteJobs(deps: UnderwriteWorkerDeps = {}): Promise<DrainOutcome[]> {
  const jobStore = deps.jobStore ?? defaultJobStore();
  const existing = _draining.get(jobStore);
  if (existing) return existing;

  const run = (async (): Promise<DrainOutcome[]> => {
    const poolStore = deps.poolStore ?? new PoolStore();
    const underwriteLoan = deps.underwriteLoan ?? defaultUnderwriteLoan;
    const onJobSettled = deps.onJobSettled;
    const outcomes: DrainOutcome[] = [];

    for (;;) {
      const job = jobStore.claimNext();
      if (job === null) break; // queue drained

      try {
        const loan = poolStore.getLoanInPool(job.loanInPoolId as LoanInPoolId);
        if (loan === null || loan.poolId !== job.poolId) {
          const reason = `loan ${job.loanInPoolId} not found in pool ${job.poolId} — cannot underwrite`;
          jobStore.markFailed(job.id, reason);
          const o: DrainOutcome = { jobId: job.id, loanInPoolId: job.loanInPoolId, state: 'failed', reason };
          outcomes.push(o);
          onJobSettled?.(o);
          continue;
        }

        const result = await underwriteLoan({
          poolId: job.poolId,
          loanInPoolId: job.loanInPoolId,
          dealRef: loan.dealRef,
          propertyType: loan.assetType ?? null,
          analysisName: loan.propertyName ?? loan.originatorLoanRef ?? loan.dealRef,
        });

        if (result.outcome === 'no-ingestable-docs') {
          // Honest: nothing to underwrite is a failure of THIS job, not a fake done.
          jobStore.markFailed(job.id, result.message);
          const o: DrainOutcome = { jobId: job.id, loanInPoolId: job.loanInPoolId, state: 'failed', reason: result.message };
          outcomes.push(o);
          onJobSettled?.(o);
          continue;
        }

        // The loan is SCORED (doctrine tail + head persisted). If the narrative
        // LLM deferred (credits exhausted), this is a PARTIAL success — score
        // readable, memo pending — NOT a failure. A retry re-runs only narrative.
        if (result.narrativeStatus === 'deferred') {
          const reason = `pending_credits: ${result.narrativeDeferredReason ?? 'narrative unavailable'}`;
          jobStore.markPartial(job.id, reason);
          const o: DrainOutcome = { jobId: job.id, loanInPoolId: job.loanInPoolId, state: 'partial', outcome: result.outcome, reason };
          outcomes.push(o);
          onJobSettled?.(o);
          continue;
        }

        jobStore.markDone(job.id);
        const o: DrainOutcome = { jobId: job.id, loanInPoolId: job.loanInPoolId, state: 'done', outcome: result.outcome };
        outcomes.push(o);
        onJobSettled?.(o);
      } catch (e) {
        // Isolated per-job failure — the REAL reason, then keep draining siblings.
        const reason =
          e instanceof UnderwriteLoanError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        jobStore.markFailed(job.id, reason);
        const o: DrainOutcome = { jobId: job.id, loanInPoolId: job.loanInPoolId, state: 'failed', reason };
        outcomes.push(o);
        onJobSettled?.(o);
      }
    }
    return outcomes;
  })();

  // Track it for the in-flight guard; clear on settle (success or the defensive
  // catch below — the loop itself never throws, but a claimNext DB error could).
  _draining.set(jobStore, run);
  run.finally(() => {
    if (_draining.get(jobStore) === run) _draining.delete(jobStore);
  }).catch(() => undefined);

  return run;
}

/**
 * Kick a drain OFF the request path. Idempotent + non-blocking: returns
 * immediately; if a drain is already running this is a no-op (the running drain
 * will pick up any just-enqueued job). The caller (settle route) does NOT await.
 */
export function kickUnderwriteDrain(deps: UnderwriteWorkerDeps = {}): void {
  const p = drainUnderwriteJobs(deps);
  // Never let a background drain surface as an unhandled rejection.
  p.catch(() => undefined);
}
