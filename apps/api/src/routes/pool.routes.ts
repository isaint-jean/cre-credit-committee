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
  ContentHash,
  DispositionKind,
  DoctrineEvaluationId,
  LoanInPoolId,
  SitePhotoRef,
  Pool,
  PoolId,
  TapeId,
  TapeOriginatorSummary,
  WorkingTapeId,
} from '@cre/contracts';
import { ON_TAPE_STATUSES, DISPOSITION_KINDS, REASON_CATEGORIES } from '@cre/contracts';
import { isReasonCategoryValidForOutcome, normalizeAssetType, parseSitePhotos, serializeSitePhotos, parseManualPortfolio, type ManualPortfolioDefinition, parseSalesComps, serializeSalesComps, type SalesCompsPayload, parseLeaseComps, serializeLeaseComps, type LeaseCompsPayload, parseSiteInspection, serializeSiteInspection, type SiteInspection } from '@cre/contracts';
import type { ReasonCategory } from '@cre/contracts';

import { enforcePermission } from '../middleware/require-permission.js';
import { store as sqliteStore } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { buildNoiReconciliationDetail } from '../services/render-memo/noi-reconciliation-detail.js';
import { buildFlagDetailsForRoot } from '../services/render-memo/flag-details-for-root.js';
import { PoolStore, WorkingTapeAlreadyOpenError, WorkingTapeUnresolvedError } from '../storage/pool-store.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { deriveClearedForDealRef } from '../services/pool/derive-cleared.js';
import { resolveLoanForRoot } from '../services/pool/resolve-loan-for-root.js';
import { computePoolCoverage } from '../services/pool/pool-coverage.service.js';
import { underwriteJobStore } from '../storage/underwrite-job-store.js';
import { dealAccessStore } from '../storage/deal-access-store.js';
import { enforcePoolParam, filterAccessiblePools, enforceDealForRoot, dataRoomConfiRequired } from '../middleware/deal-access.js';
import { confiAcceptanceStore, CONFIDENTIALITY_AGREEMENT_VERSION } from '../storage/confi-acceptance-store.js';
import { computeMissingDocs } from '../services/data-room-store.service.js';
import { kickUnderwriteDrain } from '../services/pool/underwrite-worker.service.js';
import { evaluateUnderwriteReadiness } from '../services/pool/underwrite-readiness.service.js';
import { rescanHeldOnLoanArrival } from '../services/pool/rescan-held-on-loan-arrival.service.js';
import { getServicerInput, getServicerInputs, upsertServicerInput } from '../services/servicer-inputs.service.js';
import { setPortfolioStructure } from '../services/portfolio-structure.service.js';
import { getDealMode, setDealMode, listPortfolioPoolIds, type DealMode } from '../services/deal-mode.service.js';
import { upload, uploadImages } from '../middleware/upload.js';
import { blobStore } from '../storage/blob-store.js';
import { resolveServeMime } from '../util/mime-from-extension.js';
import type { ServicerInputFieldType } from '../storage/servicer-inputs-store.js';
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

// Chunk 3b (dark): gate EVERY /:poolId/* pool route by POOL access (detail,
// coverage, tapes/membership, loans/history, dispositions, final-tape, overrides).
// The list GET / is filtered per-row below; /loan-for-root?rootId is gated in-handler.
// NO-OP when the flag is off.
poolRoutes.param('poolId', enforcePoolParam);

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
 * Body: { shelfName, vintage, seller?, propertyName? }
 * Response 201: { pool: Pool, seededLoan?: LoanInPool }
 *
 * ★ FIX 2 — OPTIONAL `propertyName` (ADDITIVE). When ABSENT the create path is
 * byte-identical to before: a pool SHELL with no `loan_in_pool` (a CMBS pool whose
 * loans arrive on a separate tape upload). When PRESENT the create is a
 * single-property "new deal": after the shell is created we seed ONE `loan_in_pool`
 * from the supplied name (`seedSingleLoan`), so the genuinely-new deal has a loan
 * for the data-room router to match its docs against (via `classifyLoanFromContent`
 * / `classifyStagedFile` + the FIX-1 ordinal bridge). `seededLoan` is echoed only
 * when a loan was seeded.
 */
poolRoutes.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isStr(body['shelfName'])) return send400Bad(res, 'shelfName: required string');
  if (!isInt(body['vintage']))   return send400Bad(res, 'vintage: required integer');
  if (body['seller'] !== undefined && body['seller'] !== null && typeof body['seller'] !== 'string') {
    return send400Bad(res, 'seller: string|null');
  }
  // OPTIONAL propertyName — absent/null/'' ⇒ no seed (unchanged shell). When a
  // non-empty string, seed exactly one single-property loan after the shell.
  if (body['propertyName'] !== undefined && body['propertyName'] !== null && typeof body['propertyName'] !== 'string') {
    return send400Bad(res, 'propertyName: string|null');
  }
  const rawName = body['propertyName'] as string | null | undefined;
  const seedName = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;

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
    // ★ Chunk 3a — stamp the creating user as this pool's originator/owner in
    //   deal_access (additive; NO enforcement yet — nothing reads it until 3b).
    //   Best-effort: only when a user context is present. (Analysis lineage roots
    //   are minted in the async ingest/underwrite workers WITHOUT req.user, so
    //   their owner-stamp is deferred to the user-aware create flow in 3d;
    //   existing roots are covered by the 3a backfill.)
    if (req.user?.userId) {
      dealAccessStore().grant({
        resourceType: 'pool',
        resourceKey: pool.id,
        userId: req.user.userId,
        party: 'originator',
        grantedBy: req.user.userId,
      });
    }
    // ★ ADDITIVE: seed a single matchable loan ONLY when propertyName is supplied.
    if (seedName !== null) {
      const seededLoan = poolStore().seedSingleLoan(pool.id, seedName);
      return res.status(201).json({ pool, seededLoan });
    }
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

    // ★ Chunk 2 — new loans just arrived. Re-scan the HELD backlog: any orphan doc
    // that now confidently matches a (now-present) loan auto-attaches (held → routed)
    // and, if it completed the loan, underwrites via Chunk 3. OFF the response path
    // (idempotent + durable; re-fires on the next advance if a process dies mid-scan).
    if (result.newLoanInPoolIds.length > 0) {
      void rescanHeldOnLoanArrival(poolId).catch((e) => {
        console.error('[tape-freeze] held auto-attach re-scan failed:', (e as Error)?.message ?? e);
      });
    }

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
 *   409 → NOT_READY (Chunk-1 gate): the loan lacks the minimum doc set (ASR +
 *         income). Pass `force:true` to underwrite a partial loan on purpose.
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

    // ★ Chunk-1 readiness gate — the manual route is gated BY DEFAULT (same predicate
    // as the settle fan-out), so a stray click can't underwrite a half-supplied loan.
    // BUT the human escape hatch is preserved: `force: true` (or `?force=true`)
    // deliberately underwrites a partial loan on purpose (honest-floor engine still
    // flags what's missing). Not-ready + not-forced → 409, with what it needs.
    const force = req.body?.force === true || req.query['force'] === 'true';
    if (!force) {
      const readiness = evaluateUnderwriteReadiness(poolId, loanInPoolId);
      if (!readiness.ready) {
        return res.status(409).json({
          error: 'NOT_READY',
          message: `loan ${loanInPoolId} is not ready to underwrite — needs ${readiness.missing.join(' + ')}. Pass force:true to underwrite anyway.`,
          missing: readiness.missing,
        });
      }
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
// ── Servicer human-input fields (Phase 2) — DISPLAY-ONLY, mint-safe ──────────
// GET is a read for anyone with deal access; PUT is SERVICER-gated (analysis:revise —
// the servicer/originator role holds it, the buyer does not). These flow into the
// workbook + memo as additive annotation and NEVER re-score. Works with the
// negotiation loop OFF (this is not the shelved overlay-comments store).
// site_visit_checklist carries a structured JSON payload (checklist state) in `value`;
// the others are narrative text. All are display-only / mint-safe additive annotation.
const SERVICER_INPUT_FIELDS: ReadonlySet<string> = new Set(['site_visit', 'broker_feedback', 'tab_commentary', 'site_visit_checklist', 'site_photos', 'portfolio_structure', 'sales_comps', 'lease_comps', 'site_inspection', 'deal_mode']);

// Resolve a graph ROOT (the deal-room holds only data.rootId) → its pool coordinates
// + a display deal name. The deal-room needs poolId/loanInPoolId/assetType to mount the
// servicer inputs, and the real deal name for its title. READ-ONLY (resolveLoanForRoot
// re-derives fresh; no write) and display-only. Registered before the '/:poolId/...'
// routes: it is a distinct 2-segment path, never shadowed by them.
function dealNameFromLoan(loan: { propertyName: string | null; originatorLoanRef: string | null }): string | null {
  const proper = loan.propertyName?.trim();
  if (proper && proper.length > 0) return proper; // a real property name is already cased — use as-is
  const ref = loan.originatorLoanRef?.trim();
  if (ref && ref.length > 0) return ref.replace(/\b\w/g, (c) => c.toUpperCase()); // the ref is stored lowercase → title-case
  return null;
}

poolRoutes.get('/loan-for-root/:rootId', (req: Request, res: Response) => {
  const rootId = req.params['rootId'] as string;
  const r = resolveLoanForRoot(rootId);
  if (!r.resolved) return res.json({ resolved: false, reason: r.reason });
  const loan = poolStore().getLoanInPool(r.loanInPoolId as LoanInPoolId);
  if (loan === null) return res.json({ resolved: false, reason: 'NONE' });
  // Fix (c) — read-time resolve: the pool row is minted with assetType:null, so when it's
  // null, derive the real type from the engine's AssetProfile (via the root's doctrine eval)
  // and normalize casing. Faithful to the engine; un-underwritten loans (no profile) stay
  // null → the checklist's generic list. READ-ONLY over the mint; no data mutation here.
  const assetType = loan.assetType ?? normalizeAssetType(sqliteStore.getPropertyTypeForRoot(rootId));
  return res.json({
    resolved: true,
    poolId: r.poolId,
    loanInPoolId: r.loanInPoolId,
    assetType,
    dealName: dealNameFromLoan(loan),
  });
});

// NOI-reconciliation receipts for the deal-room's red NOI banner — the SAME builder the
// memo uses, so the deal-room rows are byte-identical to the memo's. data.rootId is a
// doctrine_evaluation_id → read its extraction + concluded NOI and build the detail.
// READ-ONLY over the mint (no re-mint, no payload change); deal-access gated like the
// sibling. { detail: null } when the root has no evaluation/extraction (404-safe/honest).
// Flag details ("how I determined this") for every red flag on the deal — the same shared
// builder the memo uses. data.rootId (a doctrine_evaluation_id) → re-run doctrine eval →
// per-flag { statement, howDetermined, evidence[] }, keyed by dimensionId / ruleId. READ-ONLY
// over the mint (deterministic re-eval; no LLM, no write); deal-access gated. {} when unresolved.
poolRoutes.get('/loan-for-root/:rootId/flag-details', (req: Request, res: Response) => {
  const rootId = req.params['rootId'] as string;
  if (!enforceDealForRoot(req, res, rootId)) return;
  const details = buildFlagDetailsForRoot(rootId, recordGraphStore);
  return res.json({ details: details ?? {} });
});

poolRoutes.get('/loan-for-root/:rootId/noi-reconciliation', (req: Request, res: Response) => {
  const rootId = req.params['rootId'] as string;
  if (!enforceDealForRoot(req, res, rootId)) return; // gate the deal (mirrors the query-param resolver)
  const de = recordGraphStore.getDoctrineEvaluation(rootId as DoctrineEvaluationId);
  if (de === null) return res.json({ detail: null });
  const extraction = recordGraphStore.getExtractionResult(de.extractionResultId);
  if (extraction === null) return res.json({ detail: null });
  const adjusted = recordGraphStore.getAdjustedInputs(de.adjustedInputsId);
  const detail = buildNoiReconciliationDetail(extraction, adjusted?.metrics.noi ?? null);
  return res.json({ detail });
});

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  return res.json({ inputs: getServicerInputs(poolId, loanInPoolId) });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/:fieldType', (req: Request, res: Response) => {
  // ★ SERVICER-only write. analysis:revise is held by the servicer (originator) role,
  // NOT the buyer — so a buyer PUT is a 403. Enforced before any write.
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const fieldType = req.params['fieldType'] as string;
  if (!SERVICER_INPUT_FIELDS.has(fieldType)) {
    return send400Bad(res, `unknown fieldType '${fieldType}' (site_visit | broker_feedback | tab_commentary | site_visit_checklist | site_photos)`);
  }
  const value = (req.body ?? {})['value'];
  if (typeof value !== 'string') return send400Bad(res, 'value: required string');
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const saved = upsertServicerInput({ poolId, loanInPoolId, fieldType: fieldType as ServicerInputFieldType, value, author });
  return res.json({ input: saved });
});

/* ── Portfolio structure (Phase A: manual portfolio definition) ───────────────
 * A servicer hand-defines ONE loan's N properties + allocated loan amounts so the
 * already-built portfolio aggregator/composer/export run on a real cross-collateralized
 * loan (no per-property doc extraction yet — Phase B). Rides servicer_inputs
 * 'portfolio_structure'. DISPLAY/EXPORT-ONLY / MINT-SAFE. Servicer-gated on write. */

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/portfolio-structure', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const def = parseManualPortfolio(getServicerInput(poolId, loanInPoolId, 'portfolio_structure')?.value ?? null);
  return res.json({ definition: def });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/portfolio-structure', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  // Re-parse the incoming definition defensively (drops junk, honest-blanks omissions).
  const def: ManualPortfolioDefinition = parseManualPortfolio(JSON.stringify((req.body ?? {})['definition'] ?? {}));
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const saved = setPortfolioStructure({ poolId, loanInPoolId, definition: def, author });
  return res.json({ definition: saved });
});

/* ── Sales comps (servicer input) ─────────────────────────────────────────────
 * The servicer enters up to 4 sale comps (fields + a photo each) → filled into the
 * workbook's "Sales Comps" tab at export. Fields ride servicer_inputs 'sales_comps' JSON;
 * photo bytes → the blob store (referenced by hash). DISPLAY/EXPORT-ONLY / MINT-SAFE. */

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/sales-comps', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  return res.json({ salesComps: parseSalesComps(getServicerInput(poolId, loanInPoolId, 'sales_comps')?.value ?? null) });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/sales-comps', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  // Re-parse defensively (drops junk, honest-blanks omissions, caps at 4).
  const payload: SalesCompsPayload = parseSalesComps(JSON.stringify((req.body ?? {})['salesComps'] ?? {}));
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const saved = upsertServicerInput({ poolId, loanInPoolId, fieldType: 'sales_comps', value: serializeSalesComps(payload), author });
  return res.json({ salesComps: parseSalesComps(saved.value) });
});

// POST a comp photo → blob store; returns {hash, fileName} the client stores on the comp.
// Reuses uploadImages (the image-accepting multer). Servicer-gated.
poolRoutes.post('/:poolId/loans/:loanInPoolId/servicer-inputs/sales-comps/photo', uploadImages.single('photo'), async (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const file = req.file;
  if (file === undefined) return send400Bad(res, 'no photo uploaded (multipart field: photo)');
  const hash = await blobStore.putBlob(file.buffer);
  return res.json({ hash, fileName: file.originalname });
});

// GET serve a comp photo's bytes (thumbnails). The hash MUST belong to THIS loan's comps.
poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/sales-comps/photo/:hash', async (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const hash = req.params['hash'] as string;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const comps = parseSalesComps(getServicerInput(poolId, loanInPoolId, 'sales_comps')?.value ?? null).comps;
  const ref = comps.find((c) => c.photoHash === hash);
  if (ref === undefined) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo not found for this loan' });
  const bytes = await blobStore.getBlob(hash as ContentHash);
  if (bytes === null) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo bytes not in blob store' });
  res.setHeader('Content-Type', resolveServeMime(null, ref.photoFileName ?? 'photo.jpg'));
  return res.send(bytes);
});

/* ── Deal mode (single_loan vs roll_up) — the persisted portfolio flag ─────────
 * The ONE source of truth that silos portfolio from single-loan: drives the portfolio
 * input visibility, the Create-Workbook export routing, and the dashboard Loan Type
 * column. Set by an explicit servicer toggle. Rides servicer_inputs 'deal_mode'. */

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/deal-mode', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  return res.json({ mode: getDealMode(poolId, loanInPoolId) });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/deal-mode', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const raw = (req.body ?? {})['mode'];
  if (raw !== 'single_loan' && raw !== 'roll_up') return send400Bad(res, "mode: 'single_loan' | 'roll_up'");
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const mode = setDealMode({ poolId, loanInPoolId, mode: raw as DealMode, author });
  return res.json({ mode });
});

/* ── Site inspection (servicer input) ─────────────────────────────────────────
 * A structured inspection FORM (~57 free-text/number fields, 7 sections) → fills the
 * workbook's "Site Inspection" tab at export. Rides servicer_inputs 'site_inspection'
 * JSON. Text-only (no photos). DISPLAY/EXPORT-ONLY / MINT-SAFE. */

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/site-inspection', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  return res.json({ siteInspection: parseSiteInspection(getServicerInput(poolId, loanInPoolId, 'site_inspection')?.value ?? null) });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/site-inspection', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const data: SiteInspection = parseSiteInspection(JSON.stringify((req.body ?? {})['siteInspection'] ?? {}));
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const saved = upsertServicerInput({ poolId, loanInPoolId, fieldType: 'site_inspection', value: serializeSiteInspection(data), author });
  return res.json({ siteInspection: parseSiteInspection(saved.value) });
});

/* ── Lease comps (servicer input) ─────────────────────────────────────────────
 * Twin of sales comps: up to 4 lease comps (shared fields + asset-type rate metrics +
 * a photo each) → fill the workbook's "Lease Comps" tab at export. Rides servicer_inputs
 * 'lease_comps' JSON; photo bytes → the blob store. DISPLAY/EXPORT-ONLY / MINT-SAFE. */

poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/lease-comps', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  return res.json({ leaseComps: parseLeaseComps(getServicerInput(poolId, loanInPoolId, 'lease_comps')?.value ?? null) });
});

poolRoutes.put('/:poolId/loans/:loanInPoolId/servicer-inputs/lease-comps', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const payload: LeaseCompsPayload = parseLeaseComps(JSON.stringify((req.body ?? {})['leaseComps'] ?? {}));
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  const saved = upsertServicerInput({ poolId, loanInPoolId, fieldType: 'lease_comps', value: serializeLeaseComps(payload), author });
  return res.json({ leaseComps: parseLeaseComps(saved.value) });
});

// POST a lease-comp photo → blob store; returns {hash, fileName}. Reuses uploadImages.
poolRoutes.post('/:poolId/loans/:loanInPoolId/servicer-inputs/lease-comps/photo', uploadImages.single('photo'), async (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const file = req.file;
  if (file === undefined) return send400Bad(res, 'no photo uploaded (multipart field: photo)');
  const hash = await blobStore.putBlob(file.buffer);
  return res.json({ hash, fileName: file.originalname });
});

// GET serve a lease-comp photo's bytes (thumbnails). The hash MUST belong to THIS loan's comps.
poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/lease-comps/photo/:hash', async (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const hash = req.params['hash'] as string;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const comps = parseLeaseComps(getServicerInput(poolId, loanInPoolId, 'lease_comps')?.value ?? null).comps;
  const ref = comps.find((c) => c.photoHash === hash);
  if (ref === undefined) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo not found for this loan' });
  const bytes = await blobStore.getBlob(hash as ContentHash);
  if (bytes === null) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo bytes not in blob store' });
  res.setHeader('Content-Type', resolveServeMime(null, ref.photoFileName ?? 'photo.jpg'));
  return res.send(bytes);
});

/* ── Site photos (Chunk 1: capture) ──────────────────────────────────────────
 * The servicer uploads site-visit photos (any count); bytes → the content-addressed
 * blob store, refs → servicer_inputs 'site_photos' JSON. DISPLAY/EXPORT-ONLY / MINT-SAFE
 * (blobs are outside the doctrine hash; servicer_inputs is outside the mint). No resize
 * (Chunk 4) and no Excel embedding (Chunk 3) yet — capture / list / serve / delete only. */

function loadSitePhotos(poolId: PoolId, loanInPoolId: LoanInPoolId): SitePhotoRef[] {
  return [...parseSitePhotos(getServicerInput(poolId, loanInPoolId, 'site_photos')?.value ?? null).photos];
}
function saveSitePhotos(poolId: PoolId, loanInPoolId: LoanInPoolId, photos: readonly SitePhotoRef[], author: string): SitePhotoRef[] {
  const saved = upsertServicerInput({ poolId, loanInPoolId, fieldType: 'site_photos', value: serializeSitePhotos(photos), author });
  return parseSitePhotos(saved.value).photos.slice();
}

// POST upload — multi-file (any count). Servicer-gated (analysis:revise).
poolRoutes.post('/:poolId/loans/:loanInPoolId/servicer-inputs/site-photos/upload', uploadImages.array('photos', 100), async (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) return send400Bad(res, 'no photos uploaded (multipart field: photos)');
  const photos = loadSitePhotos(poolId, loanInPoolId);
  for (const f of files) {
    const hash = await blobStore.putBlob(f.buffer);
    photos.push({ hash, order: photos.length, fileName: f.originalname });
  }
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  return res.json({ photos: saveSitePhotos(poolId, loanInPoolId, photos, author) });
});

// GET serve one photo's bytes (thumbnails). Read for anyone with deal access; the hash
// MUST belong to THIS loan's set (never serves an arbitrary blob).
poolRoutes.get('/:poolId/loans/:loanInPoolId/servicer-inputs/site-photos/:hash', async (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const hash = req.params['hash'] as string;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const ref = loadSitePhotos(poolId, loanInPoolId).find((p) => p.hash === hash);
  if (ref === undefined) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo not found for this loan' });
  const bytes = await blobStore.getBlob(hash as ContentHash);
  if (bytes === null) return res.status(404).json({ error: 'NOT_FOUND', message: 'photo bytes not in blob store' });
  res.setHeader('Content-Type', resolveServeMime(null, ref.fileName));
  res.setHeader('Content-Disposition', `inline; filename="${ref.fileName.replace(/[^\w.\- ]+/g, '_')}"`);
  return res.send(bytes);
});

// DELETE one photo ref (leaves the blob — content-addressed, may be shared). Servicer-gated.
poolRoutes.delete('/:poolId/loans/:loanInPoolId/servicer-inputs/site-photos/:hash', (req: Request, res: Response) => {
  if (!enforcePermission(req, res, 'analysis:revise' as never)) return;
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const hash = req.params['hash'] as string;
  const loan = poolStore().getLoanInPool(loanInPoolId);
  if (loan === null || loan.poolId !== poolId) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `loan ${loanInPoolId} not found in pool ${poolId}` });
  }
  const remaining = loadSitePhotos(poolId, loanInPoolId).filter((p) => p.hash !== hash);
  const author = req.user?.email ?? req.user?.userId ?? 'anonymous';
  return res.json({ photos: saveSitePhotos(poolId, loanInPoolId, remaining, author) });
});

poolRoutes.post('/:poolId/loans/:loanInPoolId/disposition', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as PoolId;
  const loanInPoolId = req.params['loanInPoolId'] as LoanInPoolId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // ★ Chunk 7a — role-gate the kick/disposition (previously ungated). Buyer-authoritative
  // (first-loss) + COMMITTEE_MEMBER/ADMIN; the ORIGINATOR cannot dispose their own deal.
  // Enforced BEFORE any write, so a denial (403) never mutates a pool.
  if (!enforcePermission(req, res, 'workflow:dispose' as never)) return;

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
    // Chunk 3b (dark): per-ROW filter to the pools the user may see (never a blanket
    // 403 on the list). Pass-through when the flag is off / for admin.
    const pools = filterAccessiblePools(req, poolStore().listPools(filter), (p) => p.id);
    // #4 — the dashboard "Loan Type" column reads the SAME persisted flag: pool ids with a
    // roll_up loan (one batch query, no per-card N+1). A pool absent from this set is single.
    return res.json({ pools, portfolioPoolIds: listPortfolioPoolIds() });
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
  if (!enforceDealForRoot(req, res, rootId)) return; // Chunk 3b (dark): gate the deal
  try {
    const result = resolveLoanForRoot(rootId);
    return res.json(result);
  } catch (e) { return mapThrow(res, e); }
});

// ─── Chunk 3c — confidentiality gate ─────────────────────────────────────────
// The buyer accepts a confi agreement before the data room opens. Acceptance is
// logged (who/when/IP/version) AND flips deal_access.accepted_at (what the data-
// room gate reads). Reachable via the pool param gate (pool access) — the buyer
// already has a grant; confi UNLOCKS entry, it does not grant access.

// GET /api/pools/:poolId/confidentiality/status — is confi required + accepted?
poolRoutes.get('/:poolId/confidentiality/status', (req: Request, res: Response) => {
  const u = req.user!;
  const poolId = req.params['poolId'] as string;
  const accepted = dealAccessStore().acceptedAtFor('pool', poolId, u.userId) !== null;
  const required = dataRoomConfiRequired(u.userId, u.role, poolId);
  return res.json({ required, accepted, agreementVersion: CONFIDENTIALITY_AGREEMENT_VERSION });
});

// POST /api/pools/:poolId/confidentiality/accept — record + unlock.
poolRoutes.post('/:poolId/confidentiality/accept', (req: Request, res: Response) => {
  const u = req.user!;
  const poolId = req.params['poolId'] as string;
  // You cannot accept your way INTO access — a grant must already exist (from 3d).
  if (!dealAccessStore().has('pool', poolId, u.userId)) {
    return res.status(403).json({ error: 'NO_GRANT', message: 'no access grant to accept for this room' });
  }
  const acceptedAt = new Date().toISOString();
  confiAcceptanceStore().record({
    resourceType: 'pool',
    resourceKey: poolId,
    userId: u.userId,
    agreementVersion: CONFIDENTIALITY_AGREEMENT_VERSION,
    clientIp: req.ip ?? null,
    acceptedAt,
  });
  dealAccessStore().markConfiAccepted('pool', poolId, u.userId, acceptedAt);
  return res.json({ accepted: true, acceptedAt, agreementVersion: CONFIDENTIALITY_AGREEMENT_VERSION });
});

// GET /api/pools/:poolId/loans/:loanInPoolId/missing-docs — Tier 2 (a). Set-difference
// empty ingest slots + humanized label + "blocks what". Deal-access gated; read-only;
// NO engine/LLM call (works for an un-underwritten loan).
poolRoutes.get('/:poolId/loans/:loanInPoolId/missing-docs', (req: Request, res: Response) => {
  const poolId = req.params['poolId'] as string;
  const loanInPoolId = req.params['loanInPoolId'] as string;
  return res.json({ missing: computeMissingDocs(poolId, loanInPoolId) });
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
