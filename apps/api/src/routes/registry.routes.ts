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
import { requirePermission } from '../middleware/require-permission.js';

/* ---------------------------------- deps ---------------------------------- */

export interface RegistryDeps {
  readonly recordGraphStore: RecordGraphStore;
}

export const DEFAULT_REGISTRY_DEPS: RegistryDeps = {
  recordGraphStore,
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
    const record = body as T;
    if (typeof record.id !== 'string' || record.id.length === 0) {
      res.status(400).json({
        error: 'REGISTRY_BAD_REQUEST',
        message: `${recordKind} body must include a string id`,
      });
      return;
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
    ),
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
