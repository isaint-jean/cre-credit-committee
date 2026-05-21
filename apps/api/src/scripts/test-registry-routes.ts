/**
 * Handler-level tests for routes/registry.routes.ts.
 *
 *   tsx src/scripts/test-registry-routes.ts
 *
 * Uses an in-memory RecordGraphStore (not mocked) so the round-trip exercises
 * real serialization. Each test invokes a deps-bound handler directly with a
 * mock Request/Response, matching the pattern in test-build-and-ingest-route.ts.
 * Permission middleware is NOT exercised here (the handler factories are
 * post-middleware); the permission wiring is verified by inspection of the
 * router itself.
 */

import type { Request, Response } from 'express';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  CreditManifestoId,
  LibrarySnapshot,
  LibrarySnapshotId,
  MarketBenchmarks,
  MarketBenchmarksId,
} from '@cre/contracts';
import { ASSET_TYPES, MANIFESTO_CONTRACT_VERSION } from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { makeRegistryHandlers } from '../routes/registry.routes.js';

const AS_OF = '2026-05-21T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------------ mock req/res ------------------------------ */

interface MockReq { body?: unknown; params?: { [k: string]: string } }
interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

/* ----------------------------- fixture builders --------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeBenchmarks(officeCapRate: number = 0.075): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: officeCapRate },
    vacancyRates: emptyByAssetType<number | null>(0.05),
    expensesPerSqFt: emptyByAssetType<number | null>(8.50),
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(asOf: string = AS_OF): CreditManifesto {
  const body = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function makeSnapshot(): LibrarySnapshot {
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType: emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null),
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

/* ---------------------------------- tests --------------------------------- */

console.log('POST /market-benchmarks shape validation:');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });

  /* 1. POST non-object body → 400 REGISTRY_BAD_REQUEST */
  {
    const req: MockReq = { body: 'not an object' };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 400, '1.1 status 400 on non-object body');
    const body = res.body as { error?: string };
    assertEqual(body.error ?? null, 'REGISTRY_BAD_REQUEST', '1.2 error code REGISTRY_BAD_REQUEST');
  }

  /* 2. POST array body → 400 */
  {
    const req: MockReq = { body: [1, 2, 3] };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 400, '2.1 array body rejected with 400');
  }

  /* 3. POST object missing id → 400 */
  {
    const req: MockReq = { body: { asOfDate: AS_OF, capRates: {} } };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 400, '3.1 missing id rejected with 400');
    const body = res.body as { message?: string };
    assert((body.message ?? '').includes('id'), '3.2 message mentions id');
  }

  /* 4. POST with tampered id → 409 REGISTRY_ID_MISMATCH */
  {
    const bm = makeBenchmarks();
    const tampered = { ...bm, id: ('f'.repeat(64)) as MarketBenchmarksId };
    const req: MockReq = { body: tampered };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 409, '4.1 status 409 on id mismatch');
    const body = res.body as { error?: string; recordKind?: string; claimedId?: string; computedId?: string };
    assertEqual(body.error ?? null, 'REGISTRY_ID_MISMATCH', '4.2 error code REGISTRY_ID_MISMATCH');
    assertEqual(body.recordKind ?? null, 'MarketBenchmarks', '4.3 recordKind reported');
    assert((body.claimedId ?? '').length === 64, '4.4 claimedId present');
    assert((body.computedId ?? '').length === 64, '4.5 computedId present');
  }

  store.close();
}

console.log('\nPOST /market-benchmarks happy paths:');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });
  const bm = makeBenchmarks();

  /* 5. POST valid body → 201 inserted */
  {
    const req: MockReq = { body: bm };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 201, '5.1 status 201 on new insert');
    const body = res.body as { id?: string; inserted?: boolean };
    assertEqual(body.id ?? null, bm.id, '5.2 id echoed back');
    assertEqual(body.inserted ?? null, true, '5.3 inserted=true reported');
  }

  /* 6. POST same body again → 200 not inserted (idempotent) */
  {
    const req: MockReq = { body: bm };
    const res = makeRes();
    h.postMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '6.1 status 200 on re-insert');
    const body = res.body as { id?: string; inserted?: boolean };
    assertEqual(body.id ?? null, bm.id, '6.2 id echoed back');
    assertEqual(body.inserted ?? null, false, '6.3 inserted=false reported');
  }

  store.close();
}

console.log('\nGET /market-benchmarks/:id:');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });
  const bm = makeBenchmarks();
  store.insertMarketBenchmarks(bm);

  /* 7. GET existing → 200 with record */
  {
    const req: MockReq = { params: { id: bm.id } };
    const res = makeRes();
    h.getMarketBenchmarks(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '7.1 status 200');
    const body = res.body as { record?: MarketBenchmarks };
    assertEqual(body.record?.id ?? null, bm.id, '7.2 record.id matches');
    assertEqual(body.record?.asOfDate ?? null, AS_OF, '7.3 asOfDate preserved');
  }

  /* 8. GET unknown id → 404 with MARKET_BENCHMARKS_NOT_FOUND */
  {
    const req: MockReq = { params: { id: '0'.repeat(64) } };
    const res = makeRes();
    h.getMarketBenchmarks(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 404, '8.1 status 404 on unknown id');
    const body = res.body as { error?: string };
    assertEqual(body.error ?? null, 'MARKET_BENCHMARKS_NOT_FOUND', '8.2 error code MARKET_BENCHMARKS_NOT_FOUND');
  }

  store.close();
}

console.log('\nGET /market-benchmarks (list):');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });

  /* 9. empty list */
  {
    const req: MockReq = {};
    const res = makeRes();
    h.listMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '9.1 status 200 on empty list');
    const body = res.body as { items?: MarketBenchmarks[] };
    assertEqual(body.items?.length ?? -1, 0, '9.2 items is empty array');
  }

  /* 10. list after inserts */
  {
    store.insertMarketBenchmarks(makeBenchmarks(0.070));
    store.insertMarketBenchmarks(makeBenchmarks(0.075));
    const req: MockReq = {};
    const res = makeRes();
    h.listMarketBenchmarks(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '10.1 status 200');
    const body = res.body as { items?: MarketBenchmarks[] };
    assertEqual(body.items?.length ?? -1, 2, '10.2 items.length == 2');
  }

  store.close();
}

console.log('\nCreditManifesto handlers (smoke + error path):');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });
  const m = makeManifesto();

  /* 11. POST valid → 201 */
  {
    const req: MockReq = { body: m };
    const res = makeRes();
    h.postCreditManifesto(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 201, '11.1 status 201');
    const body = res.body as { id?: string; inserted?: boolean };
    assertEqual(body.id ?? null, m.id, '11.2 id echoed');
  }

  /* 12. GET present → 200 */
  {
    const req: MockReq = { params: { id: m.id } };
    const res = makeRes();
    h.getCreditManifesto(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '12.1 status 200');
    const body = res.body as { record?: CreditManifesto };
    assertEqual(body.record?.id ?? null, m.id, '12.2 record.id matches');
  }

  /* 13. POST tampered → 409 with recordKind=CreditManifesto */
  {
    const tampered = { ...m, id: ('f'.repeat(64)) as CreditManifestoId };
    const req: MockReq = { body: tampered };
    const res = makeRes();
    h.postCreditManifesto(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 409, '13.1 status 409');
    const body = res.body as { error?: string; recordKind?: string };
    assertEqual(body.recordKind ?? null, 'CreditManifesto', '13.2 recordKind reported correctly');
  }

  /* 14. GET unknown → 404 CREDIT_MANIFESTO_NOT_FOUND */
  {
    const req: MockReq = { params: { id: '0'.repeat(64) } };
    const res = makeRes();
    h.getCreditManifesto(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 404, '14.1 status 404');
    const body = res.body as { error?: string };
    assertEqual(body.error ?? null, 'CREDIT_MANIFESTO_NOT_FOUND', '14.2 error code');
  }

  store.close();
}

console.log('\nLibrarySnapshot handlers (smoke):');
{
  const store = new RecordGraphStore(':memory:');
  const h = makeRegistryHandlers({ recordGraphStore: store });
  const s = makeSnapshot();

  /* 15. POST → 201 */
  {
    const req: MockReq = { body: s };
    const res = makeRes();
    h.postLibrarySnapshot(req as Request, res as unknown as Response);
    assertEqual(res.statusCode, 201, '15.1 status 201');
  }

  /* 16. GET present → 200 */
  {
    const req: MockReq = { params: { id: s.id } };
    const res = makeRes();
    h.getLibrarySnapshot(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 200, '16.1 status 200');
    const body = res.body as { record?: LibrarySnapshot };
    assertEqual(body.record?.id ?? null, s.id, '16.2 record.id matches');
  }

  /* 17. list → 1 entry */
  {
    const req: MockReq = {};
    const res = makeRes();
    h.listLibrarySnapshots(req as Request, res as unknown as Response);
    const body = res.body as { items?: LibrarySnapshot[] };
    assertEqual(body.items?.length ?? -1, 1, '17.1 items.length == 1');
  }

  /* 18. GET unknown → 404 LIBRARY_SNAPSHOT_NOT_FOUND */
  {
    const req: MockReq = { params: { id: '0'.repeat(64) } };
    const res = makeRes();
    h.getLibrarySnapshot(req as unknown as Request, res as unknown as Response);
    assertEqual(res.statusCode, 404, '18.1 status 404');
    const body = res.body as { error?: string };
    assertEqual(body.error ?? null, 'LIBRARY_SNAPSHOT_NOT_FOUND', '18.2 error code');
  }

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
