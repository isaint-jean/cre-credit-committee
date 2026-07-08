/**
 * Pool routes (Pool Layer PR 4) — HTTP surface for the pool layer.
 *
 * THIN handlers only. Each handler:
 *   1. Validates input shape (no business validation, no schema lib).
 *   2. Calls the PR3 advance-tape service OR a PR2 PoolStore method.
 *   3. Maps the result/error to HTTP.
 *
 * NO business logic in this file. Carry-over, reconciliation, disposition
 * derivation all live in advance-tape.service.ts (PR3). A handler that
 * computes any orchestration logic is a bug — it belongs in PR3.
 *
 * PERMISSION DEFERRAL (E1a): pool routes are auth-gated only via the
 * router-level `requireAuth` in `routes/index.ts`. Pool-specific permissions
 * — originator vs buyer rights, which are load-bearing for the two-sided
 * platform (an originator must NOT record a buyer-authoritative disposition,
 * a buyer must not advance someone else's pool) — are a tracked follow-up,
 * NOT an oversight. This file deliberately stops short of role gates until
 * pool RBAC policy crystallizes; the routes are safe to expose to
 * authenticated analysts in the meantime.
 *
 * SESSION DISCIPLINE (E2a): server holds NO state between Phase A and Phase
 * B. The client receives `workingTapeId` from Phase A's response and includes
 * it in Phase B's body. The handler cross-checks `workingTape.poolId` against
 * `:poolId` to refuse mis-routed bodies (POOL_ID_MISMATCH / 400).
 *
 * Error mapping:
 *   - shape validation failure          → 400 POOL_BAD_REQUEST
 *   - poolId path↔body mismatch          → 400 POOL_ID_MISMATCH
 *   - AdvanceTapeError                  → 422 ADVANCE_TAPE_PRECONDITION  (incl. the freeze-block)
 *   - WorkingTapeAlreadyOpenError       → 409 WORKING_TAPE_ALREADY_OPEN
 *   - WorkingTapeUnresolvedError        → 422 WORKING_TAPE_UNRESOLVED    (defensive — should not escape PR3)
 *   - RecordIdMismatchError             → 500 RECORD_ID_MISMATCH         (server bug, not client)
 *   - resource not found                → 404 NOT_FOUND
 *   - anything else                     → 400 with err.name              (conservative; matches ingest.routes.ts)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

import type {
  ConditionRef,
  DispositionKind,
  LoanInPoolId,
  Pool,
  PoolId,
  TapeId,
  TapeOriginatorSummary,
  WorkingTapeId,
} from '@cre/contracts';
import { ON_TAPE_STATUSES, DISPOSITION_KINDS, REASON_CATEGORIES } from '@cre/contracts';
import { isReasonCategoryValidForOutcome } from '@cre/contracts';
import type { ReasonCategory } from '@cre/contracts';

import { PoolStore, WorkingTapeAlreadyOpenError, WorkingTapeUnresolvedError } from '../storage/pool-store.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { deriveClearedForDealRef } from '../services/pool/derive-cleared.js';
import { resolveLoanForRoot } from '../services/pool/resolve-loan-for-root.js';
import { computePoolCoverage } from '../services/pool/pool-coverage.service.js';
import { underwriteJobStore } from '../storage/underwrite-job-store.js';
import { kickUnderwriteDrain } from '../services/pool/underwrite-worker.service.js';
import {
  advanceTapePhaseA,
  advanceTapePhaseB,
  recordStandaloneDisposition,
  AdvanceTapeError,
  NoCurrentTapeError,
  LoanAlreadyDisposedError,
  type DepartureLabel,
  type IncomingTape,
  type IncomingTapeRow,
  type Resolution,
} from '../services/pool/advance-tape.service.js';
import { mintPoolId } from '../util/pool-ids.js';

export const poolRoutes = Router();

/* -------------------------- Lazy-singleton store -------------------------- */
// Matches the workflow.routes.ts convention: open the sqlite connection on
// first use. Tests substitute via `_setPoolStoreForTests(new PoolStore(':memory:'))`.

let _store: PoolStore | null = null;
function poolStore(): PoolStore {
  if (_store === null) _store = new PoolStore();
  return _store;
}

/** Test hook: swap in an in-memory store. Used by `test-pool-pr4-http.ts`. */
export function _setPoolStoreForTests(store: PoolStore): void {
  _store = store;
}

/* ----------------------------- Error mapping ------------------------------ */

function send400Bad(res: Response, message: string): Response {
  return res.status(400).json({ error: 'POOL_BAD_REQUEST', message });
}

function mapThrow(res: Response, e: unknown): Response {
  if (e instanceof AdvanceTapeError) {
    return res.status(422).json({ error: 'ADVANCE_TAPE_PRECONDITION', message: e.reason });
  }
  if (e instanceof WorkingTapeAlreadyOpenError) {
    return res.status(409).json({
      error: 'WORKING_TAPE_ALREADY_OPEN',
      message: e.message,
      poolId: e.poolId,
    });
  }
  if (e instanceof WorkingTapeUnresolvedError) {
    return res.status(422).json({
      error: 'WORKING_TAPE_UNRESOLVED',
      message: e.message,
      unresolvedCount: e.unresolvedCount,
    });
  }
  if (e instanceof RecordIdMismatchError) {
    return res.status(500).json({
      error: 'RECORD_ID_MISMATCH',
      message: e.message,
      recordKind: e.recordKind,
    });
  }
  const err = e as Error;
  return res.status(400).json({
    error: err?.name ?? 'POOL_ERROR',
    message: err?.message ?? 'pool operation failed',
  });
}

/* ----------------------------- Validators --------------------------------- */
// Shape-only — does not interpret meaning. The PR3 service owns semantic
// validation (prior-tape mismatch, duplicate resolutions, etc.).

function isStr(v: unknown): v is string { return typeof v === 'string' && v.length > 0; }
function isStrOrNull(v: unknown): v is string | null { return v === null || (typeof v === 'string' && v.length > 0); }
function isInt(v: unknown): v is number { return typeof v === 'number' && Number.isInteger(v); }
function isDispositionKind(v: unknown): v is DispositionKind {
  return typeof v === 'string' && (DISPOSITION_KINDS as readonly string[]).indexOf(v) >= 0;
}
function isStrArr(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function isReasonCategory(v: unknown): v is ReasonCategory {
  return typeof v === 'string' && (REASON_CATEGORIES as readonly string[]).indexOf(v) >= 0;
}

function validateRow(v: unknown, idx: number): IncomingTapeRow | string {
  if (typeof v !== 'object' || v === null) return `rows[${idx}]: must be an object`;
  const r = v as Record<string, unknown>;
  if (!isStrOrNull(r['originatorLoanRef'])) return `rows[${idx}].originatorLoanRef: string|null`;
  if (!isStr(r['dealRef'])) return `rows[${idx}].dealRef: required string`;
  if (r['propertyName'] !== null && typeof r['propertyName'] !== 'string') return `rows[${idx}].propertyName: string|null`;
  if (r['assetType'] !== null && typeof r['assetType'] !== 'string') return `rows[${idx}].assetType: AssetType|null`;
  if (!isInt(r['tapePosition'])) return `rows[${idx}].tapePosition: integer`;
  return {
    originatorLoanRef: r['originatorLoanRef'] as string | null,
    dealRef: r['dealRef'] as string,
    propertyName: r['propertyName'] as string | null,
    assetType: r['assetType'] as IncomingTapeRow['assetType'],
    tapePosition: r['tapePosition'] as number,
  };
}

function validateOriginatorSummary(v: unknown): TapeOriginatorSummary | null | string {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return 'originatorSummary: object|null';
  const o = v as Record<string, unknown>;
  if (!isInt(o['originatorLoanCount'])) return 'originatorSummary.originatorLoanCount: integer';
  if (!isStrArr(o['originatorDroppedRefs'])) return 'originatorSummary.originatorDroppedRefs: string[]';
  if (!isStrArr(o['originatorKickedRefs'])) return 'originatorSummary.originatorKickedRefs: string[]';
  if (o['sourceLabel'] !== null && typeof o['sourceLabel'] !== 'string') return 'originatorSummary.sourceLabel: string|null';
  return {
    originatorLoanCount: o['originatorLoanCount'] as number,
    originatorDroppedRefs: o['originatorDroppedRefs'] as readonly string[],
    originatorKickedRefs: o['originatorKickedRefs'] as readonly string[],
    sourceLabel: o['sourceLabel'] as string | null,
  };
}

function validateResolution(v: unknown, idx: number): Resolution | string {
  if (typeof v !== 'object' || v === null) return `resolutions[${idx}]: must be an object`;
  const r = v as Record<string, unknown>;
  if (!isInt(r['tapePosition'])) return `resolutions[${idx}].tapePosition: integer`;
  if (r['kind'] === 'bind-existing') {
    if (!isStr(r['loanInPoolId'])) return `resolutions[${idx}].loanInPoolId: required string`;
    return { kind: 'bind-existing', tapePosition: r['tapePosition'] as number, loanInPoolId: r['loanInPoolId'] as LoanInPoolId };
  }
  if (r['kind'] === 'confirm-new') {
    return { kind: 'confirm-new', tapePosition: r['tapePosition'] as number };
  }
  return `resolutions[${idx}].kind: 'bind-existing'|'confirm-new'`;
}

function validateDeparture(v: unknown, idx: number): DepartureLabel | string {
  if (typeof v !== 'object' || v === null) return `departures[${idx}]: must be an object`;
  const d = v as Record<string, unknown>;
  if (!isStr(d['loanInPoolId'])) return `departures[${idx}].loanInPoolId: required string`;
  if (!isDispositionKind(d['originatorLabel'])) return `departures[${idx}].originatorLabel: 'dropped'|'kicked'`;
  if (!isDispositionKind(d['buyerLabel'])) return `departures[${idx}].buyerLabel: 'dropped'|'kicked'`;
  if (!isStrArr(d['reasons'])) return `departures[${idx}].reasons: string[]`;
  if (!isStr(d['recordedAt'])) return `departures[${idx}].recordedAt: ISODateTime`;
  // OPTIONAL refinement. Absent/null is allowed; when present it must be a known
  // category AND valid under the authoritative outcome (buyerLabel).
  const rawReasonCategory = d['reasonCategory'];
  let reasonCategory: ReasonCategory | null = null;
  if (rawReasonCategory !== undefined && rawReasonCategory !== null) {
    if (!isReasonCategory(rawReasonCategory)) {
      return `departures[${idx}].reasonCategory: 'disqualifying'|'couldnt_structure'|'expired'|'withdrawn'`;
    }
    if (!isReasonCategoryValidForOutcome(rawReasonCategory, d['buyerLabel'] as DispositionKind)) {
      return `departures[${idx}].reasonCategory '${rawReasonCategory}' is not valid for outcome '${d['buyerLabel'] as string}'`;
    }
    reasonCategory = rawReasonCategory;
  }
  return {
    loanInPoolId: d['loanInPoolId'] as LoanInPoolId,
    originatorLabel: d['originatorLabel'] as DispositionKind,
    buyerLabel: d['buyerLabel'] as DispositionKind,
    reasons: d['reasons'] as readonly string[],
    recordedAt: d['recordedAt'] as string,
    reasonCategory,
  };
}

/* ============================== WRITES =================================== */

/**
 * POST /api/pools — create a pool.
 *
 * Body: { shelfName, vintage, seller? }
 * Response 201: { pool: Pool }
 */
poolRoutes.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isStr(body['shelfName'])) return send400Bad(res, 'shelfName: required string');
  if (!isInt(body['vintage']))   return send400Bad(res, 'vintage: required integer');
  if (body['seller'] !== undefined && body['seller'] !== null && typeof body['seller'] !== 'string') {
    return send400Bad(res, 'seller: string|null');
  }
  const pool: Pool = {
    id: mintPoolId(),
    shelfName: body['shelfName'] as string,
    vintage: body['vintage'] as number,
    seller: (body['seller'] as string | null | undefined) ?? null,
    createdAt: new Date().toISOString(),
    tapeIds: [],
    currentTapeId: null,
    closedAt: null,
  };
  try {
    poolStore().createPool(pool);
    return res.status(201).json({ pool });
  } catch (e) {
    return mapThrow(res, e);
  }
});

/**
 * POST /api/pools/:poolId/tapes — Phase A (ingest + reconcile).
 *
 * Body: IncomingTape (sans poolId).
 * Response 201: { workingTapeId, summary, pendingMembership }
 */
poolRoutes.post('/:poolId/tapes', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!isInt(body['version']))    return send400Bad(res, 'version: required integer');
  if (!isStr(body['tapeDate']))   return send400Bad(res, 'tapeDate: required ISODateTime');
  if (!isStr(body['receivedAt'])) return send400Bad(res, 'receivedAt: required ISODateTime');
  if (body['priorTapeId'] !== null && !isStr(body['priorTapeId'])) {
    return send400Bad(res, 'priorTapeId: TapeId|null');
  }
  if (!Array.isArray(body['rows'])) return send400Bad(res, 'rows: required array');

  const rows: IncomingTapeRow[] = [];
  for (let i = 0; i < body['rows'].length; i++) {
    const r = validateRow(body['rows'][i], i);
    if (typeof r === 'string') return send400Bad(res, r);
    rows.push(r);
  }

  const summary = validateOriginatorSummary(body['originatorSummary']);
  if (typeof summary === 'string') return send400Bad(res, summary);

  const incoming: IncomingTape = {
    poolId,
    version: body['version'] as number,
    tapeDate: body['tapeDate'] as string,
    receivedAt: body['receivedAt'] as string,
    priorTapeId: body['priorTapeId'] as TapeId | null,
    rows,
    originatorSummary: summary,
  };

  try {
    const result = advanceTapePhaseA(poolStore(), incoming);
    const wt = poolStore().getWorkingTape(result.workingTapeId);
    if (wt === null) {
      // Should never happen — Phase A just wrote it. Defensive 500.
      return res.status(500).json({ error: 'WORKING_TAPE_VANISHED', workingTapeId: result.workingTapeId });
    }
    return res.status(201).json({
      workingTapeId: result.workingTapeId,
      summary: result.summary,
      pendingMembership: wt.pendingMembership,
    });
  } catch (e) {
    return mapThrow(res, e);
  }
});

/**
 * POST /api/pools/:poolId/tapes/freeze — Phase B (resolve + freeze).
 *
 * Body: { workingTapeId, resolutions, departures, frozenAt }
 * `recordedBy` is filled SERVER-SIDE from req.user (never trust a client-supplied
 * actor — the buyer-authoritative record's actor must be the authenticated user).
 *
 * Cross-checks workingTape.poolId === :poolId. Mismatch → 400 POOL_ID_MISMATCH.
 *
 * Response 201: { tape, newLoanInPoolIds, dispositionIds }
 */
poolRoutes.post('/:poolId/tapes/freeze', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!isStr(body['workingTapeId'])) return send400Bad(res, 'workingTapeId: required string');
  if (!isStr(body['frozenAt']))      return send400Bad(res, 'frozenAt: required ISODateTime');
  if (!Array.isArray(body['resolutions'])) return send400Bad(res, 'resolutions: required array');
  if (!Array.isArray(body['departures'])) return send400Bad(res, 'departures: required array');

  const resolutions: Resolution[] = [];
  for (let i = 0; i < body['resolutions'].length; i++) {
    const r = validateResolution(body['resolutions'][i], i);
    if (typeof r === 'string') return send400Bad(res, r);
    resolutions.push(r);
  }
  const departures: DepartureLabel[] = [];
  for (let i = 0; i < body['departures'].length; i++) {
    const d = validateDeparture(body['departures'][i], i);
    if (typeof d === 'string') return send400Bad(res, d);
    departures.push(d);
  }

  // ★ Cross-check: workingTape.poolId === :poolId (E2a refusal).
  const wt = poolStore().getWorkingTape(body['workingTapeId'] as WorkingTapeId);
  if (wt === null) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `working tape ${body['workingTapeId']} not found` });
  }
  if (wt.poolId !== poolId) {
    return res.status(400).json({
      error: 'POOL_ID_MISMATCH',
      message: `working tape ${body['workingTapeId']} belongs to pool ${wt.poolId}, not ${poolId}`,
    });
  }

  // ★ recordedBy from req.user — NEVER from body. The buyer-authoritative
  // record carries the authenticated actor.
  const recordedBy = {
    userId: req.user?.userId ?? 'anonymous',
    displayName: req.user?.email ?? null,
  };

  try {
    const result = advanceTapePhaseB(poolStore(), {
      workingTapeId: body['workingTapeId'] as WorkingTapeId,
      resolutions,
      departures,
      recordedBy,
      frozenAt: body['frozenAt'] as string,
    });
    return res.status(201).json({
      tape: result.tape,
      newLoanInPoolIds: result.newLoanInPoolIds,
      dispositionIds: result.dispositionIds,
    });
  } catch (e) {
    return mapThrow(res, e);
  }
});

/**
 * POST /api/pools/:poolId/loans/:loanInPoolId/close — the POSITIVE TERMINAL.
 *
 * Sets the per-loan `LoanLifecycleStatus = 'closed'` on the mutable `loan_in_pool`.
 * The loan STAYS in the pool and goes onto the final tape. This is NOT a
 * disposition (that's the departure path) and NOT a stored Cleared flag (Cleared
 * stays derived).
 *
 * Body: empty (no fields required). Actor is stamped SERVER-SIDE from req.user,
 * never from the body (mirror the freeze handler's buyer-authoritative discipline).
 *
 * Legality (all enforced here, before the store write):
 *   - 404 if the pool/loan doesn't exist or the loan isn't in this pool.
 *   - 422 NOT_CLEARED if the server RE-DERIVES Cleared = false (never trusts the
 *     client; re-computes the exact negotiation-surface predicate over persisted
 *     state via deriveClearedForDealRef).
 *   - 422 CLEARED_UNRESOLVABLE if the loan's dealRef can't map to a single graph
 *     root (can't re-derive → refuse rather than fake a pass).
 *   - 409 LOAN_ALREADY_DEPARTED if currentDispositionId != null (mutual exclusion).
 *   - Idempotent no-op if already 'closed' (200, mirrors recordDisposition's
 *     ON CONFLICT idempotency).
 *
 * Response 200: { loan: LoanInPool }  (with lifecycleStatus: 'closed').
 */
poolRoutes.post('/:poolId/loans/:loanInPoolId/close', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;

  // Actor stamped server-side (not currently persisted on the status row, but
  // read here to enforce the same "actor from req.user, never body" discipline as
  // the buyer-authoritative writes; role gates deferred, matching this file).
  void (req.user?.userId ?? 'anonymous');

  try {
    const loan = poolStore().getLoanInPool(loanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
    }

    // Idempotent: already closed → no-op success (re-close is not an error).
    if (loan.lifecycleStatus === 'closed') {
      return res.json({ loan });
    }

    // Mutual exclusion with a departure — a disposed loan cannot close.
    if (loan.currentDispositionId !== null && loan.currentDispositionId !== undefined) {
      return res.status(409).json({
        error: 'LOAN_ALREADY_DEPARTED',
        message: `loan ${loanInPoolId} has a disposition (${loan.currentDispositionId}) and cannot be closed`,
      });
    }

    // ★ Server RE-DERIVES Cleared from persisted state — never trusts the client.
    const clearedResult = deriveClearedForDealRef(loan.dealRef);
    if (!clearedResult.resolved) {
      return res.status(422).json({
        error: 'CLEARED_UNRESOLVABLE',
        message: `cannot re-derive Cleared for loan ${loanInPoolId} (dealRef '${loan.dealRef}': ${clearedResult.reason})`,
        reason: clearedResult.reason,
      });
    }
    if (!clearedResult.cleared) {
      return res.status(422).json({
        error: 'NOT_CLEARED',
        message: `loan ${loanInPoolId} is not cleared and cannot be closed`,
        detail: {
          hasFatalFlag: clearedResult.hasFatalFlag,
          band: clearedResult.band,
          bandOk: clearedResult.bandOk,
          convergenceTotal: clearedResult.convergenceTotal,
          ratifiedCount: clearedResult.ratifiedCount,
          structuralAllRatified: clearedResult.structuralAllRatified,
        },
      });
    }

    poolStore().setLifecycleStatus(loanInPoolId, 'closed');
    const updated = poolStore().getLoanInPool(loanInPoolId);
    return res.json({ loan: updated });
  } catch (e) {
    return mapThrow(res, e);
  }
});

/**
 * POST /api/pools/:poolId/loans/:loanInPoolId/underwrite — Data-Room Phase 3.
 * The manual "Underwrite now" action: fire ONE ingest/append per loan from its
 * accumulated tier-(a) data-room docs.
 *
 * ★ ASYNC (was sync). This route no longer `await`s `underwriteLoan` — a heavy
 * extraction (60 MB of PDFs + 2 LLM calls) blew past the connection timeout →
 * ECONNRESET / "socket hang up" and a "Underwrite failed" toast even though the
 * work often finished server-side (a GHOST completion). Instead it ENQUEUES one
 * durable `underwrite_job` (the SAME queue the settle fan-out uses) and returns
 * IMMEDIATELY (202). The P3 worker (`kickUnderwriteDrain`) drains it OFF the
 * request path and runs `underwriteLoan` VERBATIM; the UI polls
 * `GET …/underwrite-jobs` for the result. No sync `underwriteLoan` here → no
 * timeout to raise.
 *
 * ★ ONE JOB PER LOAN — the enqueue goes through the SAME dedup as the settle
 * fan-out (`underwriteJobStore().enqueue`, no-op when the loan already has an
 * ACTIVE pending|running job). So a manual click + a settle auto-fire, or a
 * double-click, can NEVER stack two ingests → no duplicate child revision.
 *
 * The pool loan is read HERE only to 404 a missing/cross-pool loan; the worker
 * re-reads it for the branch inputs. Actor is stamped SERVER-SIDE.
 *
 *   202 → enqueued ({ enqueued: true, jobId, alreadyActive })
 *         alreadyActive:true means the dedup returned an in-flight job (no second
 *         run) — the UI just polls that job.
 *   404 → loan not in this pool
 */
poolRoutes.post('/:poolId/loans/:loanInPoolId/underwrite', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;

  // Actor stamped server-side (never body) — same buyer-authoritative discipline
  // as the close/disposition writes. Role gates deferred, matching this file.
  void (req.user?.userId ?? 'anonymous');

  try {
    const loan = poolStore().getLoanInPool(loanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
    }

    // Enqueue through the shared dedup (one ACTIVE job per loan) — identical to the
    // settle fan-out (batch-settle-fanout.service.ts). created:false ⇒ a job was
    // already active (settle auto-fire or a prior/double click) → NO second run.
    const { job, created } = underwriteJobStore().enqueue(poolId, loanInPoolId);

    // Drain OFF the request path (idempotent — a running drain absorbs the new job).
    // We do NOT await; the request returns before any extraction/LLM work.
    kickUnderwriteDrain();

    // 202 Accepted — the work is queued, not done. UI polls GET …/underwrite-jobs.
    return res.status(202).json({
      enqueued: true,
      jobId: job.id,
      alreadyActive: !created,
      state: job.state,
      loanInPoolId,
    });
  } catch (e) {
    return mapThrow(res, e);
  }
});

/**
 * POST /api/pools/:poolId/loans/:loanInPoolId/disposition — the NEGATIVE TERMINAL
 * (standalone, out-of-band reject/withdraw). Mirrors `/close`, but records a
 * `Disposition` (kicked|dropped) directly — no tape freeze.
 *
 * Body: { outcome: 'kicked'|'dropped', reasonCategory?, note? }. Actor is stamped
 * SERVER-SIDE from req.user (never body — buyer-authoritative discipline, mirror
 * the freeze handler).
 *
 * Guards → responses (all mirror `/close`, enforced in the service):
 *   - 404 NOT_FOUND        — loan missing / not in this pool.
 *   - 409 LOAN_ALREADY_CLOSED — loan lifecycleStatus === 'closed' (mutual exclusion;
 *     symmetric to /close's 409 LOAN_ALREADY_DEPARTED).
 *   - 200 idempotent no-op — already disposed with byte-identical decision content.
 *   - 409 LOAN_ALREADY_DISPOSED — already disposed with DIFFERENT content
 *     (a correction goes through the append-only supersede chain, not overwrite).
 *   - 422 NO_CURRENT_TAPE  — pool.currentTapeId === null (nothing to depart from;
 *     honest refuse, never fabricate a tape).
 *
 * Response 200: { disposition, loan }  (the now-disposed loan, currentDispositionId set).
 */
poolRoutes.post('/:poolId/loans/:loanInPoolId/disposition', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Shape validation (reuse the existing shape helpers).
  if (!isDispositionKind(body['outcome'])) {
    return send400Bad(res, "outcome: 'kicked'|'dropped'");
  }
  const outcome = body['outcome'] as DispositionKind;

  // reasonCategory OPTIONAL — when present must be known AND valid for the outcome.
  let reasonCategory: ReasonCategory | null = null;
  const rawReasonCategory = body['reasonCategory'];
  if (rawReasonCategory !== undefined && rawReasonCategory !== null) {
    if (!isReasonCategory(rawReasonCategory)) {
      return send400Bad(res, "reasonCategory: 'disqualifying'|'couldnt_structure'|'expired'|'withdrawn'");
    }
    if (!isReasonCategoryValidForOutcome(rawReasonCategory, outcome)) {
      return send400Bad(res, `reasonCategory '${rawReasonCategory}' is not valid for outcome '${outcome}'`);
    }
    reasonCategory = rawReasonCategory;
  }

  // note OPTIONAL string.
  let note: string | null = null;
  if (body['note'] !== undefined && body['note'] !== null) {
    if (typeof body['note'] !== 'string') return send400Bad(res, 'note: string|null');
    note = body['note'];
  }

  try {
    // 404 — resolved here (before the service) to mirror /close exactly.
    const loan = poolStore().getLoanInPool(loanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
    }

    // 409 — a closed loan cannot be disposed (mutual exclusion; symmetric to
    // /close's LOAN_ALREADY_DEPARTED).
    if (loan.lifecycleStatus === 'closed') {
      return res.status(409).json({
        error: 'LOAN_ALREADY_CLOSED',
        message: `loan ${loanInPoolId} is closed (positive terminal) and cannot be disposed`,
      });
    }

    // ★ Actor from req.user — NEVER body (buyer-authoritative discipline).
    const recordedBy = {
      userId: req.user?.userId ?? 'anonymous',
      displayName: req.user?.email ?? null,
    };

    const result = recordStandaloneDisposition(poolStore(), poolId, loanInPoolId, {
      outcome,
      reasonCategory,
      note,
      recordedBy,
      recordedAt: new Date().toISOString(),
    });
    return res.json({ disposition: result.disposition, loan: result.loan });
  } catch (e) {
    if (e instanceof NoCurrentTapeError) {
      return res.status(422).json({ error: 'NO_CURRENT_TAPE', message: e.message });
    }
    if (e instanceof LoanAlreadyDisposedError) {
      return res.status(409).json({
        error: 'LOAN_ALREADY_DISPOSED',
        message: e.message,
        currentDispositionId: e.currentDispositionId,
      });
    }
    return mapThrow(res, e);
  }
});

/* =============================== READS =================================== */

/** GET /api/pools — list, with ?vintage / ?seller filters. */
poolRoutes.get('/', (req: Request, res: Response) => {
  const filter: { vintage?: number; seller?: string } = {};
  if (req.query['vintage'] !== undefined) {
    const v = Number(req.query['vintage']);
    if (!Number.isInteger(v)) return send400Bad(res, 'vintage query: integer');
    filter.vintage = v;
  }
  if (typeof req.query['seller'] === 'string' && req.query['seller'].length > 0) {
    filter.seller = req.query['seller'];
  }
  try {
    const pools = poolStore().listPools(filter);
    return res.json({ pools });
  } catch (e) { return mapThrow(res, e); }
});

/**
 * GET /api/pools/loan-for-root?rootId=<64-hex lineage root>
 *
 * Phase A forward resolver surface. Turns a graph ROOT into the single pool loan
 * it belongs to, so the graph-native DispositionBar (which holds only
 * `data.rootId`) can go live in the deal room. READ-ONLY — resolves fresh, no
 * stored column, no write.
 *
 * ★ MUST be registered BEFORE `GET /:poolId` — otherwise Express matches
 *   `/loan-for-root` as `:poolId = 'loan-for-root'` and this handler never runs.
 *
 * Responses (always 200 so the WEB can distinguish determinate vs ambiguous and
 * degrade to a preview without treating the ambiguous case as an HTTP error):
 *   - determinate → 200 { resolved:true, poolId, loanInPoolId, matchedBy }
 *   - not unique  → 200 { resolved:false, ambiguous:true, reason, matchCount }
 *       reason ∈ { NONE (0 matches / name-less root), MULTIPLE (>1 pool),
 *                  ROOT_NOT_FOUND (unknown root) }
 * A missing/blank `rootId` is a client shape error → 400 POOL_BAD_REQUEST.
 */
poolRoutes.get('/loan-for-root', (req: Request, res: Response) => {
  const rootId = req.query['rootId'];
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    return send400Bad(res, 'rootId query parameter is required');
  }
  try {
    const result = resolveLoanForRoot(rootId);
    return res.json(result);
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId — pool detail + D3 derivation of currentWorkingTapeId. */
poolRoutes.get('/:poolId', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    const wt = poolStore().getCurrentWorkingTape(poolId);
    return res.json({ pool, currentWorkingTapeId: wt?.id ?? null });
  } catch (e) { return mapThrow(res, e); }
});

/**
 * GET /api/pools/:poolId/coverage — per-loan DOC-COVERAGE projection (Data-Room
 * Phase 3, P0). READ-ONLY. Returns `[{ loanInPoolId, state, missing, analyzed }]`
 * where state ∈ complete | partial | none is derived K-gated from the intake
 * ledger (analyzed loans) or data-room doc presence (un-analyzed loans).
 *
 * Coverage is ORTHOGONAL to the Status/score verdict — it answers a document
 * question ("are the facts sourced?"), never a credit question. Green requires K.
 *
 * Loans are read from the pool's CURRENT (frozen) tape membership — the SAME
 * rows MembershipTable renders (pool page reads `pool.currentTapeId`) — so
 * coverage lines up 1:1 with the tape. When the pool has no current tape yet the
 * coverage list is empty (nothing to cover).
 *
 * ★ MUST be registered BEFORE `GET /:poolId`.
 */
poolRoutes.get('/:poolId/coverage', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    const membership = pool.currentTapeId !== null ? poolStore().getMembership(pool.currentTapeId) : [];
    const loans = membership.map((m) => ({ loanInPoolId: m.loanInPoolId, dealRef: m.dealRef }));
    const coverage = computePoolCoverage(poolId, loans);
    return res.json({ coverage });
  } catch (e) { return mapThrow(res, e); }
});

/**
 * GET /api/pools/:poolId/underwrite-jobs — the ASYNC underwrite job state per
 * loan (Data-Room Phase 3, P3). Returns `[{ loanInPoolId, jobId, state, reason,
 * updatedAt }]` — one row per loan that has (or had) a job, drawn from the loan's
 * MOST-RECENT job. `state ∈ pending | running | done | failed | interrupted`.
 *
 * The chip reads this ALONGSIDE /coverage: pending|running → "Underwriting…"
 * (inert); done → the chip resolves to the P0 coverage (complete/partial);
 * failed|interrupted → the REAL reason (coverage stays doc-truth — never a fake
 * green on failure). READ-ONLY — polled/refetched as jobs finish.
 *
 * ★ MUST be registered BEFORE `GET /:poolId`.
 */
poolRoutes.get('/:poolId/underwrite-jobs', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    // Latest job per loan (a loan may have older done/failed rows behind a newer
    // active one). getJobsForPool is newest-first → first per loan wins.
    const seen = new Set<string>();
    const jobs = underwriteJobStore()
      .getJobsForPool(poolId)
      .filter((j) => {
        if (seen.has(j.loanInPoolId)) return false;
        seen.add(j.loanInPoolId);
        return true;
      })
      .map((j) => ({
        loanInPoolId: j.loanInPoolId,
        jobId: j.id,
        state: j.state,
        reason: j.reason,
        updatedAt: j.updatedAt,
      }));
    return res.json({ jobs });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/working-tape — current open working tape, or 404. */
poolRoutes.get('/:poolId/working-tape', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const wt = poolStore().getCurrentWorkingTape(poolId);
    if (wt === null) return res.status(404).json({ error: 'NOT_FOUND', message: 'no open working tape' });
    return res.json({ workingTape: wt });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/tapes/:tapeId — frozen tape detail. */
poolRoutes.get('/:poolId/tapes/:tapeId', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const tapeId = req.params['tapeId'] as TapeId;
  try {
    const tape = poolStore().getTape(tapeId);
    if (tape === null || tape.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `tape ${tapeId} not found in pool ${poolId}` });
    }
    return res.json({ tape });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/tapes/:tapeId/membership — O(1) snapshot read. */
poolRoutes.get('/:poolId/tapes/:tapeId/membership', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const tapeId = req.params['tapeId'] as TapeId;
  try {
    const tape = poolStore().getTape(tapeId);
    if (tape === null || tape.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `tape ${tapeId} not found in pool ${poolId}` });
    }
    const membership = poolStore().getMembership(tapeId);
    return res.json({ membership });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/loans/:loanInPoolId — loan detail. */
poolRoutes.get('/:poolId/loans/:loanInPoolId', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  try {
    const loan = poolStore().getLoanInPool(loanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
    }
    return res.json({ loan });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/loans/:loanInPoolId/history — cross-tape trajectory. */
poolRoutes.get('/:poolId/loans/:loanInPoolId/history', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  try {
    const loan = poolStore().getLoanInPool(loanInPoolId);
    if (loan === null || loan.poolId !== poolId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
    }
    const history = poolStore().getLoanHistory(loanInPoolId);
    return res.json({ history });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/dispositions — all departures. */
poolRoutes.get('/:poolId/dispositions', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    const dispositions = poolStore().getDispositions(poolId);
    return res.json({ dispositions });
  } catch (e) { return mapThrow(res, e); }
});

/**
 * GET /api/pools/:poolId/final-tape — the loans that have CLOSED (per-loan
 * `LoanLifecycleStatus === 'closed'`). This is decoupled from `pool.closed_at`
 * (the pool-level seal): a pool accumulates closed loans before it seals.
 */
poolRoutes.get('/:poolId/final-tape', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    const loans = poolStore().getFinalTape(poolId);
    return res.json({ loans });
  } catch (e) { return mapThrow(res, e); }
});

/** GET /api/pools/:poolId/overrides — buyer-overrode-originator records. */
poolRoutes.get('/:poolId/overrides', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  try {
    const pool = poolStore().getPool(poolId);
    if (pool === null) return res.status(404).json({ error: 'NOT_FOUND', message: `pool ${poolId} not found` });
    const overrides = poolStore().getOverrides(poolId);
    return res.json({ overrides });
  } catch (e) { return mapThrow(res, e); }
});

// Suppress unused-import warning — keeps the closed-enum exports in scope so
// future validators can use them without a re-import dance.
void ON_TAPE_STATUSES;
void DISPOSITION_KINDS;

// Suppress unused-import warning for ConditionRef (reserved for the
// status/conditions update endpoint that PR4 deliberately does NOT include —
// status edits happen via the rail UI's interactive mutation surface, which
// PR4 doesn't expose; the working tape is read-only between Phase A and Phase
// B from this layer's perspective).
void (null as unknown as ConditionRef | null);
