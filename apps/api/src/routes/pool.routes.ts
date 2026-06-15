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
import { ON_TAPE_STATUSES, DISPOSITION_KINDS } from '@cre/contracts';

import { PoolStore, WorkingTapeAlreadyOpenError, WorkingTapeUnresolvedError } from '../storage/pool-store.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import {
  advanceTapePhaseA,
  advanceTapePhaseB,
  AdvanceTapeError,
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
  return {
    loanInPoolId: d['loanInPoolId'] as LoanInPoolId,
    originatorLabel: d['originatorLabel'] as DispositionKind,
    buyerLabel: d['buyerLabel'] as DispositionKind,
    reasons: d['reasons'] as readonly string[],
    recordedAt: d['recordedAt'] as string,
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
