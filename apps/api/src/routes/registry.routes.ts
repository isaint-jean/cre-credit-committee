/**
 * Registry routes — POST/GET CRUD for the three pinned upstream inputs to the
 * judgment engine:
 *
 *   /api/registry/library-snapshots
 *   /api/registry/market-benchmarks
 *   /api/registry/credit-manifestos
 *
 * Records are content-addressed (id = SHA-256 of JCS-canonical body) and
 * immutable. There is no PUT, no DELETE: a new id is a new record. The legacy
 * `/api/manifesto/*` routes (PDF-upload + AI-extract model in sqlite-store)
 * are untouched by this module — different paradigm, different storage table
 * (sqlite-store's `credit_manifesto` singular vs. record-graph-store's
 * `manifesto_registry`).
 *
 * Per route:
 *   GET  /                 — list (most-recent-first; no pagination, low volume)
 *   GET  /:id              — fetch by content hash; 404 on miss
 *   POST /                 — insert; body MUST be a full record including a
 *                            client-supplied `id` that matches compute*Id(body).
 *                            Mismatch → 409 REGISTRY_ID_MISMATCH.
 *                            Idempotent re-insert returns 200 (existing) vs 201 (new).
 *
 * Auth: requireAuth gates reads. requirePermission('registry:write') gates POST.
 *
 * Dependency injection: makeRegistryRouter(deps) factory. Tests inject a mock
 * RecordGraphStore so handler logic is exercised without touching disk.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type {
  CreditManifesto,
  CreditManifestoId,
  LibrarySnapshot,
  LibrarySnapshotId,
  MarketBenchmarks,
  MarketBenchmarksId,
} from '@cre/contracts';
import {
  RecordIdMismatchError,
  recordGraphStore,
} from '../storage/record-graph-store.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  ApprovedDealsStore,
  approvedDealsStore,
} from '../storage/approved-deals-store.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { buildLibrarySnapshot } from '../services/library-snapshot-producer.service.js';
import type { ISODateTime } from '@cre/contracts';

/* ---------------------------------- deps ---------------------------------- */

export interface RegistryDeps {
  readonly recordGraphStore: RecordGraphStore;
  /** Used by the build-from-approved-deals action on library snapshots. */
  readonly approvedDealsStore: ApprovedDealsStore;
}

export const DEFAULT_REGISTRY_DEPS: RegistryDeps = {
  recordGraphStore,
  approvedDealsStore,
};

/* ------------------------------ handler factories ------------------------- */

interface ListHandler<T> {
  (req: Request, res: Response): void;
  // Marker for TS narrowing in tests; not used at runtime.
  readonly _kind?: T;
}

function makeListHandler<T extends { readonly id: string }>(
  read: () => T[],
): ListHandler<T> {
  return ((_req: Request, res: Response): void => {
    res.status(200).json({ items: read() });
  }) as ListHandler<T>;
}

function makeGetHandler<T extends { readonly id: string }, Id extends string>(
  read: (id: Id) => T | null,
  notFoundCode: string,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const id = req.params.id as Id;
    const record = read(id);
    if (record === null) {
      res.status(404).json({ error: notFoundCode, id });
      return;
    }
    res.status(200).json({ record });
  };
}

interface InsertResult { inserted: boolean }

function makePostHandler<T extends { readonly id: string }>(
  write: (record: T) => InsertResult,
  recordKind: 'LibrarySnapshot' | 'MarketBenchmarks' | 'CreditManifesto',
  computeId: (body: unknown) => string,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const body = req.body as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        error: 'REGISTRY_BAD_REQUEST',
        message: `${recordKind} body must be a JSON object`,
      });
      return;
    }
    /* Dual-mode body:
     *   - id present  → existing behavior; store.verifyAndSerialize() validates
     *     the claimed id matches the computed id, throws RecordIdMismatchError
     *     on mismatch (409 path below).
     *   - id absent   → compute it server-side from the body's content, attach
     *     to the record, and proceed. Lets admin-UI callers paste raw JSON
     *     without manually computing SHA-256. */
    const claimed = (body as { id?: unknown }).id;
    let record: T;
    if (typeof claimed === 'string' && claimed.length > 0) {
      record = body as T;
    } else {
      const { id: _omit, ...bodyWithoutId } = body as { id?: unknown };
      void _omit;
      const computedId = computeId(bodyWithoutId);
      record = { ...bodyWithoutId, id: computedId } as unknown as T;
    }
    try {
      const { inserted } = write(record);
      // 201 = new row; 200 = idempotent no-op on identical re-insert.
      res.status(inserted ? 201 : 200).json({ id: record.id, inserted });
    } catch (e) {
      if (e instanceof RecordIdMismatchError) {
        res.status(409).json({
          error: 'REGISTRY_ID_MISMATCH',
          message: e.message,
          recordKind: e.recordKind,
          claimedId: e.claimedId,
          computedId: e.computedId,
        });
        return;
      }
      const err = e as Error;
      res.status(400).json({
        error: err?.name ?? 'REGISTRY_INSERT_ERROR',
        message: err?.message ?? 'insert failed',
      });
    }
  };
}

/* -------------------------------- handlers -------------------------------- */
/* Each handler is a deps-bound function that takes (req, res). Tests invoke
 * these directly with mock req/res. The router below wires them under their
 * URL paths + permission middleware. */

export interface RegistryHandlers {
  readonly listLibrarySnapshots:   (req: Request, res: Response) => void;
  readonly getLibrarySnapshot:     (req: Request, res: Response) => void;
  readonly postLibrarySnapshot:    (req: Request, res: Response) => void;
  /** Build (NOT insert) a LibrarySnapshot from the current approved_deals
   *  table state at the given asOfDate. Returns the computed snapshot body
   *  for admin review; admin then submits via postLibrarySnapshot to persist. */
  readonly buildLibrarySnapshot:   (req: Request, res: Response) => void;
  readonly listMarketBenchmarks:   (req: Request, res: Response) => void;
  readonly getMarketBenchmarks:    (req: Request, res: Response) => void;
  readonly postMarketBenchmarks:   (req: Request, res: Response) => void;
  readonly listCreditManifestos:   (req: Request, res: Response) => void;
  readonly getCreditManifesto:     (req: Request, res: Response) => void;
  readonly postCreditManifesto:    (req: Request, res: Response) => void;
}

export function makeRegistryHandlers(
  deps: RegistryDeps = DEFAULT_REGISTRY_DEPS,
): RegistryHandlers {
  return {
    listLibrarySnapshots: makeListHandler<LibrarySnapshot>(
      () => deps.recordGraphStore.listLibrarySnapshots(),
    ),
    getLibrarySnapshot: makeGetHandler<LibrarySnapshot, LibrarySnapshotId>(
      (id) => deps.recordGraphStore.getLibrarySnapshot(id),
      'LIBRARY_SNAPSHOT_NOT_FOUND',
    ),
    postLibrarySnapshot: makePostHandler<LibrarySnapshot>(
      (r) => deps.recordGraphStore.insertLibrarySnapshot(r),
      'LibrarySnapshot',
      computeLibrarySnapshotId,
    ),
    buildLibrarySnapshot: (req: Request, res: Response): void => {
      const body = req.body as { asOfDate?: unknown } | null | undefined;
      const asOfDate = body?.asOfDate;
      if (typeof asOfDate !== 'string' || asOfDate.length === 0) {
        res.status(400).json({
          error: 'REGISTRY_BAD_REQUEST',
          message: 'buildLibrarySnapshot body must include a non-empty string asOfDate',
        });
        return;
      }
      try {
        const snapshot = buildLibrarySnapshot({
          asOfDate: asOfDate as ISODateTime,
          store: deps.approvedDealsStore,
        });
        res.status(200).json({ snapshot });
      } catch (e) {
        const err = e as Error;
        res.status(400).json({
          error: err?.name ?? 'BUILD_LIBRARY_SNAPSHOT_ERROR',
          message: err?.message ?? 'buildLibrarySnapshot failed',
        });
      }
    },
    listMarketBenchmarks: makeListHandler<MarketBenchmarks>(
      () => deps.recordGraphStore.listMarketBenchmarks(),
    ),
    getMarketBenchmarks: makeGetHandler<MarketBenchmarks, MarketBenchmarksId>(
      (id) => deps.recordGraphStore.getMarketBenchmarks(id),
      'MARKET_BENCHMARKS_NOT_FOUND',
    ),
    postMarketBenchmarks: makePostHandler<MarketBenchmarks>(
      (r) => deps.recordGraphStore.insertMarketBenchmarks(r),
      'MarketBenchmarks',
      computeMarketBenchmarksId,
    ),
    listCreditManifestos: makeListHandler<CreditManifesto>(
      () => deps.recordGraphStore.listCreditManifestos(),
    ),
    getCreditManifesto: makeGetHandler<CreditManifesto, CreditManifestoId>(
      (id) => deps.recordGraphStore.getCreditManifesto(id),
      'CREDIT_MANIFESTO_NOT_FOUND',
    ),
    postCreditManifesto: makePostHandler<CreditManifesto>(
      (r) => deps.recordGraphStore.insertCreditManifesto(r),
      'CreditManifesto',
      computeCreditManifestoId,
    ),
  };
}

/* --------------------------------- router --------------------------------- */

export function makeRegistryRouter(deps: RegistryDeps = DEFAULT_REGISTRY_DEPS): Router {
  const router = Router();
  const h = makeRegistryHandlers(deps);
  const writeGate = requirePermission('registry:write');

  const libSub = Router();
  libSub.get('/', h.listLibrarySnapshots);
  // POST /build must be registered before POST /:id-less routes so express
  // doesn't accidentally try to parse 'build' as a path param. (Not an issue
  // here since GET /:id and POST / are separate verbs from POST /build, but
  // the convention is to register specific paths first.)
  libSub.post('/build', writeGate, h.buildLibrarySnapshot);
  libSub.get('/:id', h.getLibrarySnapshot);
  libSub.post('/', writeGate, h.postLibrarySnapshot);
  router.use('/library-snapshots', libSub);

  const benchSub = Router();
  benchSub.get('/', h.listMarketBenchmarks);
  benchSub.get('/:id', h.getMarketBenchmarks);
  benchSub.post('/', writeGate, h.postMarketBenchmarks);
  router.use('/market-benchmarks', benchSub);

  const manSub = Router();
  manSub.get('/', h.listCreditManifestos);
  manSub.get('/:id', h.getCreditManifesto);
  manSub.post('/', writeGate, h.postCreditManifesto);
  router.use('/credit-manifestos', manSub);

  return router;
}

/** Production singleton; tests use makeRegistryHandlers(mockDeps). */
export const registryRoutes: Router = makeRegistryRouter();
