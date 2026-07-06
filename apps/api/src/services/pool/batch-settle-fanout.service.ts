/**
 * batch-settle-fanout — Data-Room Phase 3: settle detection + the durable fan-out.
 *
 * When a staging batch SETTLES — every file in it assigned to a (loan, docType),
 * none still tray-pending — this service ENQUEUES ONE durable `underwrite_job`
 * per DISTINCT affected loan and returns FAST. It removes the manual
 * "Underwrite now" click (which stays as an escape hatch in pool.routes.ts).
 *
 * This is a pure ORCHESTRATION seam over P1's proven pieces:
 *   - settle detection reads the staging batch + the data-room manifest (no ingest),
 *   - the enqueue mints one `underwrite_job` per distinct affected loan; the P3
 *     worker (underwrite-worker.service.ts) drains it and runs `underwriteLoan`
 *     (pool/underwrite-loan.service.ts) VERBATIM — this service never reimplements
 *     the bridge/branch. One loan = one re-extraction (P1 already coalesces the
 *     loan's full tier-(a) set into ONE append/ingest); we NEVER fire per-file/per-doc.
 *
 * SETTLE = CONFIRMED-ONLY. A staging batch's `_batch.json` carries the FULL
 * original file set (the data-room assign path does not prune it — unlike the
 * library assignStagingFiles). A batch file is "confirmed-assigned" iff a
 * DataRoomDocEntry with its content hash exists in the pool manifest (both use
 * the same sha256-hex over the raw bytes). SETTLED = every batch file is
 * confirmed-assigned. A file still sitting in the confirm tray (dropped but not
 * assigned) has NO manifest entry → the batch is NOT settled → nothing enqueues.
 *
 * NON-BLOCKING: the assign response must NOT block on K×(extraction+2LLM). We
 * detect settle + resolve the affected loans SYNCHRONOUSLY (cheap, disk reads),
 * enqueue one durable job per distinct loan, kick the drain OFF the request path,
 * and return that list in the response. The worker drains in the background with
 * INDEPENDENT per-loan handling — one loan's ingest failing must not abort or
 * corrupt the others; a process restart re-claims any in-flight job (boot
 * re-claim). (An earlier P2 iteration fired `underwriteLoan` fire-and-forget on
 * an ephemeral Promise; that shim has since been removed in favour of the durable
 * queue below.)
 */

import type { PoolId, LoanInPoolId } from '@cre/contracts';
import { getStagingBatch } from '../source-doc-store.service.js';
import { listPoolDocs as defaultListPoolDocs } from '../data-room-store.service.js';
import { PoolStore } from '../../storage/pool-store.js';
import type { UnderwriteJobStore } from '../../storage/underwrite-job-store.js';
import { underwriteJobStore as defaultJobStore } from '../../storage/underwrite-job-store.js';
import { kickUnderwriteDrain } from './underwrite-worker.service.js';

/* -------------------------------------------------------------------------- */
/* Settle detection.                                                          */
/* -------------------------------------------------------------------------- */

export interface SettleDetectionDeps {
  readonly listPoolDocs?: typeof defaultListPoolDocs;
  readonly getStagingBatch?: typeof getStagingBatch;
}

export interface SettleResult {
  /** True iff EVERY file in the batch is confirmed-assigned (none tray-pending). */
  readonly settled: boolean;
  /** How many of the batch's files are confirmed-assigned into the manifest. */
  readonly assignedCount: number;
  /** How many files the original batch carried. */
  readonly totalCount: number;
  /** Distinct affected loans across the batch's ASSIGNED cells (fan-out targets). */
  readonly affectedLoanIds: ReadonlyArray<string>;
}

/**
 * Is the batch fully settled, and which distinct loans did it touch?
 *
 * A batch file counts as CONFIRMED-ASSIGNED when a DataRoomDocEntry in the pool
 * manifest shares its content hash. That is the ONLY thing that counts — a file
 * still in the confirm tray (no manifest entry) leaves the batch unsettled and
 * its loan out of the affected set.
 *
 * `affectedLoanIds` is `distinct(loanInPoolId)` over the manifest entries whose
 * hash matches a batch file — the fan-out fires exactly ONE job per entry here.
 * We report it even when NOT settled (for observability), but the route only
 * fires when `settled` is true.
 */
export function detectSettledBatch(
  poolId: string,
  batchId: string,
  deps: SettleDetectionDeps = {},
): SettleResult {
  const listPoolDocs = deps.listPoolDocs ?? defaultListPoolDocs;
  const readBatch = deps.getStagingBatch ?? getStagingBatch;

  const batch = readBatch(batchId);
  if (batch === null) {
    return { settled: false, assignedCount: 0, totalCount: 0, affectedLoanIds: [] };
  }

  // Hash → the data-room entry it was assigned to (confirmed-assigned only).
  // A batch can carry duplicate bytes (same hash, different staging slots); the
  // manifest keys on (loan, docType, fileHash), so one manifest entry can settle
  // several identical batch files. We match by hash membership either way.
  const manifestByHash = new Map<string, { loanInPoolId: string }>();
  for (const d of listPoolDocs(poolId)) {
    manifestByHash.set(d.fileHash, { loanInPoolId: d.loanInPoolId });
  }

  const totalCount = batch.files.length;
  let assignedCount = 0;
  const affected = new Set<string>();
  for (const f of batch.files) {
    const hit = manifestByHash.get(f.fileHash);
    if (hit) {
      assignedCount += 1;
      affected.add(hit.loanInPoolId);
    }
  }

  return {
    settled: totalCount > 0 && assignedCount === totalCount,
    assignedCount,
    totalCount,
    // Deterministic order for stable responses / proofs.
    affectedLoanIds: Array.from(affected).sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* P3 — the DURABLE enqueue.                                                   */
/* -------------------------------------------------------------------------- */

/** One affected loan, resolved to its underwriteLoan inputs, returned in the
 *  assign response so the UI can show which loans are underwriting. */
export interface AffectedLoan {
  readonly loanInPoolId: string;
  /** null when the loan can't be resolved in the pool store (skipped, not enqueued). */
  readonly dealRef: string | null;
}

export interface EnqueueOnSettleDeps extends SettleDetectionDeps {
  readonly poolStore?: PoolStore;
  readonly jobStore?: UnderwriteJobStore;
  /** Skip kicking the in-process drain (proofs drive the worker manually). */
  readonly kickDrain?: boolean;
}

export interface EnqueueOnSettleResult {
  readonly settled: boolean;
  /** The distinct loans the settle enqueued (or found already active) a job for. */
  readonly affectedLoans: ReadonlyArray<AffectedLoan>;
  /** How many NEW jobs the settle minted (dedup: an already-active loan is 0). */
  readonly enqueuedCount: number;
  /** The job ids per affected loan (new or already-active), for the response/chip. */
  readonly jobs: ReadonlyArray<{ loanInPoolId: string; jobId: string; created: boolean }>;
}

/**
 * ★ P3 fan-out — DURABLE. If `batchId` is now fully settled, ENQUEUE one durable
 * `underwrite_job` per distinct affected loan (DEDUP — a loan with an already-
 * active job is NOT re-enqueued, preserving P2's one-per-loan through the queue),
 * then KICK the in-process drain OFF the request path and RETURN FAST. The assign
 * response never waits on K×(extraction+LLM) — the worker drains in the
 * background; a process restart re-claims any in-flight job (boot re-claim).
 *
 * This superseded the earlier fire-and-forget fan-out (since removed): there is
 * no ephemeral Promise on the request path — the settle's ONLY durable act is the
 * enqueue.
 */
export function enqueueUnderwriteOnSettle(
  poolId: string,
  batchId: string,
  deps: EnqueueOnSettleDeps = {},
): EnqueueOnSettleResult {
  const poolStore = deps.poolStore ?? new PoolStore();
  const jobStore = deps.jobStore ?? defaultJobStore();

  const settle = detectSettledBatch(poolId, batchId, deps);
  if (!settle.settled) {
    return { settled: false, affectedLoans: [], enqueuedCount: 0, jobs: [] };
  }

  const affectedLoans: AffectedLoan[] = [];
  const jobs: Array<{ loanInPoolId: string; jobId: string; created: boolean }> = [];
  let enqueuedCount = 0;

  for (const loanInPoolId of settle.affectedLoanIds) {
    const loan = poolStore.getLoanInPool(loanInPoolId as LoanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      // Unresolvable / cross-pool — surface it but do NOT enqueue (nothing coherent
      // to underwrite; the worker would only fail it).
      affectedLoans.push({ loanInPoolId, dealRef: null });
      continue;
    }
    affectedLoans.push({ loanInPoolId, dealRef: loan.dealRef });
    const { job, created } = jobStore.enqueue(poolId, loanInPoolId);
    if (created) enqueuedCount += 1;
    jobs.push({ loanInPoolId, jobId: job.id, created });
  }

  // Kick the drain OFF the request path (idempotent; a running drain absorbs the
  // new jobs). The route does NOT await this. Proofs pass kickDrain:false to drive
  // the worker deterministically.
  if (deps.kickDrain !== false && enqueuedCount > 0) {
    kickUnderwriteDrain({ jobStore, poolStore });
  }

  return { settled: true, affectedLoans, enqueuedCount, jobs };
}
