/**
 * batch-settle-fanout — Data-Room Phase 3, P2: the batch-settled auto-fire.
 *
 * When a staging batch SETTLES — every file in it assigned to a (loan, docType),
 * none still tray-pending — this service fans out ONE `underwriteLoan` job per
 * DISTINCT affected loan and fires them NON-BLOCKING. It removes the manual
 * "Underwrite now" click (which stays as an escape hatch in pool.routes.ts).
 *
 * This is a pure ORCHESTRATION seam over P1's proven pieces:
 *   - settle detection reads the staging batch + the data-room manifest (no ingest),
 *   - the fan-out reuses `underwriteLoan` (pool/underwrite-loan.service.ts) VERBATIM
 *     — it does NOT reimplement the bridge/branch. One loan = one re-extraction
 *     (P1 already coalesces the loan's full tier-(a) set into ONE append/ingest);
 *     we NEVER fire per-file/per-doc.
 *
 * SETTLE = CONFIRMED-ONLY. A staging batch's `_batch.json` carries the FULL
 * original file set (the data-room assign path does not prune it — unlike the
 * library assignStagingFiles). A batch file is "confirmed-assigned" iff a
 * DataRoomDocEntry with its content hash exists in the pool manifest (both use
 * the same sha256-hex over the raw bytes). SETTLED = every batch file is
 * confirmed-assigned. A file still sitting in the confirm tray (dropped but not
 * assigned) has NO manifest entry → the batch is NOT settled → nothing fires.
 *
 * NON-BLOCKING: the assign response must NOT block on K×(extraction+2LLM). We
 * detect settle + resolve the affected loans SYNCHRONOUSLY (cheap, disk reads),
 * return that list in the response, and dispatch the K underwrite jobs
 * fire-and-forget with INDEPENDENT per-loan error handling — one loan's ingest
 * failing must not abort or corrupt the others. (The durable queue + live
 * "Underwriting…" status is P3; P2 just fans out + fires.)
 */

import type { PoolId, LoanInPoolId } from '@cre/contracts';
import { getStagingBatch } from '../source-doc-store.service.js';
import { listPoolDocs as defaultListPoolDocs } from '../data-room-store.service.js';
import { PoolStore } from '../../storage/pool-store.js';
import {
  underwriteLoan as defaultUnderwriteLoan,
  UnderwriteLoanError,
} from './underwrite-loan.service.js';
import type { UnderwriteLoanResult } from './underwrite-loan.service.js';
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
/* Fan-out fire.                                                              */
/* -------------------------------------------------------------------------- */

export interface FanOutDeps {
  readonly underwriteLoan?: typeof defaultUnderwriteLoan;
  readonly poolStore?: PoolStore;
  /** Injected so proofs can observe the per-loan outcome of each dispatched job. */
  readonly onJobSettled?: (r: FanOutJobOutcome) => void;
}

export type FanOutJobOutcome =
  | { readonly loanInPoolId: string; readonly ok: true; readonly result: UnderwriteLoanResult }
  | { readonly loanInPoolId: string; readonly ok: false; readonly code: string; readonly message: string };

/** One affected loan, resolved to its underwriteLoan inputs, returned in the
 *  assign response so the UI can show which loans are underwriting. */
export interface AffectedLoan {
  readonly loanInPoolId: string;
  /** null when the loan can't be resolved in the pool store (skipped, not fired). */
  readonly dealRef: string | null;
}

export interface FanOutFireResult {
  readonly settled: boolean;
  /** The distinct loans the fan-out fired a job for (the fired set). */
  readonly affectedLoans: ReadonlyArray<AffectedLoan>;
  /** How many jobs were actually dispatched (== affectedLoans that resolved). */
  readonly firedCount: number;
  /** Resolves when EVERY dispatched job has settled — proofs await this; the
   *  route does NOT (it returns before awaiting, keeping the fire non-blocking). */
  readonly done: Promise<ReadonlyArray<FanOutJobOutcome>>;
}

/**
 * If `batchId` is now fully settled, fire ONE `underwriteLoan` per distinct
 * affected loan — NON-BLOCKING, INDEPENDENT per-loan error handling.
 *
 * The caller (the route) invokes this AFTER an assign op on either settle path
 * ((a) auto-route on POST /staging, (b) confirm on POST /assign), returns
 * `affectedLoans` in the response, and does NOT await `done`. The jobs run to
 * completion in the background; a single job failing (bad input / no ingestable
 * docs) is caught, surfaced via `onJobSettled`, and NEVER aborts or corrupts the
 * others.
 *
 * When the batch is NOT settled: no job fires, `affectedLoans` is empty,
 * `settled` is false — the still-tray-pending file's loan does NOT underwrite.
 */
export function fireUnderwriteOnSettle(
  poolId: string,
  batchId: string,
  deps: FanOutDeps & SettleDetectionDeps = {},
): FanOutFireResult {
  const underwriteLoan = deps.underwriteLoan ?? defaultUnderwriteLoan;
  const poolStore = deps.poolStore ?? new PoolStore();
  const onJobSettled = deps.onJobSettled;

  const settle = detectSettledBatch(poolId, batchId, deps);
  if (!settle.settled) {
    return { settled: false, affectedLoans: [], firedCount: 0, done: Promise.resolve([]) };
  }

  // Resolve each affected loan to its underwriteLoan inputs (dealRef / propertyType /
  // name) SYNCHRONOUSLY — cheap pool-store reads, no ingest. One job per distinct
  // loan; a loan we can't resolve is reported (dealRef:null) but not fired.
  const affectedLoans: AffectedLoan[] = [];
  const dispatch: Array<Promise<FanOutJobOutcome>> = [];

  for (const loanInPoolId of settle.affectedLoanIds) {
    const loan = poolStore.getLoanInPool(loanInPoolId as LoanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      // Unresolvable / cross-pool — surface as an affected loan with no dealRef,
      // but do not fire a job for it (nothing coherent to underwrite).
      affectedLoans.push({ loanInPoolId, dealRef: null });
      continue;
    }
    affectedLoans.push({ loanInPoolId, dealRef: loan.dealRef });

    // ── Fire NON-BLOCKING with INDEPENDENT error handling. Each job is its own
    //    Promise; a rejection is caught HERE so one loan's failure can never
    //    reject the aggregate or abort a sibling. ──
    const job = (async (): Promise<FanOutJobOutcome> => {
      try {
        const result = await underwriteLoan({
          poolId,
          loanInPoolId,
          dealRef: loan.dealRef,
          propertyType: loan.assetType ?? null,
          analysisName: loan.propertyName ?? loan.originatorLoanRef ?? loan.dealRef,
        });
        const out: FanOutJobOutcome = { loanInPoolId, ok: true, result };
        onJobSettled?.(out);
        return out;
      } catch (e) {
        const code = e instanceof UnderwriteLoanError ? e.code : 'UNDERWRITE_FAILED';
        const message = e instanceof Error ? e.message : String(e);
        const out: FanOutJobOutcome = { loanInPoolId, ok: false, code, message };
        onJobSettled?.(out);
        return out;
      }
    })();
    // Attach a no-op catch defensively — the async IIFE never rejects (it catches
    // internally), but this guards against an unhandled-rejection if that changes.
    job.catch(() => undefined);
    dispatch.push(job);
  }

  // `done` never rejects: every element resolves to an ok/err outcome. Proofs
  // await it; the route ignores it (returns before it settles → non-blocking).
  const done = Promise.all(dispatch);

  return {
    settled: true,
    affectedLoans,
    firedCount: dispatch.length,
    done,
  };
}

/* -------------------------------------------------------------------------- */
/* P3 — the DURABLE enqueue (replaces the fire-and-forget fan-out).            */
/* -------------------------------------------------------------------------- */

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
 * This REPLACES `fireUnderwriteOnSettle`'s fire-and-forget: no ephemeral Promise
 * on the request path — the settle's ONLY durable act is the enqueue.
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
