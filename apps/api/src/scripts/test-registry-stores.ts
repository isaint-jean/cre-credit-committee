/**
 * Tests for the registry-side ops on RecordGraphStore: insertMarketBenchmarks /
 * getMarketBenchmarks / listMarketBenchmarks, insertCreditManifesto /
 * getCreditManifesto / listCreditManifestos, listLibrarySnapshots (added for
 * symmetry with the registry routes).
 *
 *   tsx src/scripts/test-registry-stores.ts
 *
 * Pattern mirrors the existing test-record-graph-store.ts: in-memory DB,
 * insert + get + list + id-mismatch + not-found cases.
 */

import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  CreditManifestoId,
  LibrarySnapshot,
  MarketBenchmarks,
  MarketBenchmarksId,
} from '@cre/contracts';
import { ASSET_TYPES, MANIFESTO_CONTRACT_VERSION } from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import {
  RecordGraphStore,
  RecordIdMismatchError,
} from '../storage/record-graph-store.js';

const AS_OF = '2026-05-21T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------------ fixture builders -------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeBenchmarks(asOf: string = AS_OF, officeCapRate: number = 0.075): MarketBenchmarks {
  const body = {
    asOfDate: asOf,
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

function makeSnapshot(asOf: string = AS_OF): LibrarySnapshot {
  const body = {
    asOf,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType: emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null),
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

/* ---------------------------------- tests --------------------------------- */

console.log('MarketBenchmarks store ops:');
{
  const store = new RecordGraphStore(':memory:');
  const bm = makeBenchmarks();

  /* 1. insert + get round-trip */
  const r1 = store.insertMarketBenchmarks(bm);
  assertEqual(r1.inserted, true, '1.1 first insert reports inserted=true');
  const fetched = store.getMarketBenchmarks(bm.id);
  assert(fetched !== null, '1.2 getMarketBenchmarks returns the record');
  assertEqual(fetched?.id ?? null, bm.id, '1.3 fetched id matches');
  assertEqual(fetched?.asOfDate ?? null, AS_OF, '1.4 asOfDate preserved');
  assertEqual(fetched?.capRates.Office ?? null, 0.075, '1.5 nested field preserved');

  /* 2. idempotent re-insert */
  const r2 = store.insertMarketBenchmarks(bm);
  assertEqual(r2.inserted, false, '2.1 re-insert reports inserted=false (ON CONFLICT)');

  /* 3. not-found */
  const missing = store.getMarketBenchmarks(('0'.repeat(64)) as MarketBenchmarksId);
  assertEqual(missing, null, '3.1 getMarketBenchmarks returns null for unknown id');

  /* 4. id mismatch */
  const tampered = { ...bm, id: ('f'.repeat(64)) as MarketBenchmarksId };
  let threw: Error | null = null;
  try { store.insertMarketBenchmarks(tampered); } catch (e) { threw = e as Error; }
  assert(threw instanceof RecordIdMismatchError, '4.1 tampered id throws RecordIdMismatchError');
  assertEqual((threw as RecordIdMismatchError)?.recordKind ?? null, 'MarketBenchmarks', '4.2 recordKind = MarketBenchmarks');

  store.close();
}

console.log('\nMarketBenchmarks list ops:');
{
  const store = new RecordGraphStore(':memory:');

  /* 5. list on empty table → [] */
  assertEqual(store.listMarketBenchmarks().length, 0, '5.1 listMarketBenchmarks on empty table → []');

  /* 6. list after multiple inserts — assert set membership.
       Order is best-effort by created_at DESC; same-ms inserts can tie,
       so position-level assertions are not part of the contract. */
  const a = makeBenchmarks(AS_OF, 0.070);
  const b = makeBenchmarks(AS_OF, 0.075);
  const c = makeBenchmarks(AS_OF, 0.080);
  store.insertMarketBenchmarks(a);
  store.insertMarketBenchmarks(b);
  store.insertMarketBenchmarks(c);
  const listed = store.listMarketBenchmarks();
  assertEqual(listed.length, 3, '6.1 list returns 3 records');
  const ids = new Set(listed.map((r) => r.id));
  assert(ids.has(a.id), '6.2 set contains a.id');
  assert(ids.has(b.id), '6.3 set contains b.id');
  assert(ids.has(c.id), '6.4 set contains c.id');

  store.close();
}

console.log('\nCreditManifesto store ops:');
{
  const store = new RecordGraphStore(':memory:');
  const m = makeManifesto();

  /* 7. insert + get round-trip */
  const r1 = store.insertCreditManifesto(m);
  assertEqual(r1.inserted, true, '7.1 first insert reports inserted=true');
  const fetched = store.getCreditManifesto(m.id);
  assert(fetched !== null, '7.2 getCreditManifesto returns the record');
  assertEqual(fetched?.id ?? null, m.id, '7.3 fetched id matches');
  assertEqual(fetched?.manifestoContractVersion ?? null, MANIFESTO_CONTRACT_VERSION, '7.4 contract version preserved');

  /* 8. idempotent re-insert */
  const r2 = store.insertCreditManifesto(m);
  assertEqual(r2.inserted, false, '8.1 re-insert reports inserted=false');

  /* 9. not-found */
  const missing = store.getCreditManifesto(('0'.repeat(64)) as CreditManifestoId);
  assertEqual(missing, null, '9.1 getCreditManifesto returns null for unknown id');

  /* 10. id mismatch */
  const tampered = { ...m, id: ('f'.repeat(64)) as CreditManifestoId };
  let threw: Error | null = null;
  try { store.insertCreditManifesto(tampered); } catch (e) { threw = e as Error; }
  assert(threw instanceof RecordIdMismatchError, '10.1 tampered id throws RecordIdMismatchError');
  assertEqual((threw as RecordIdMismatchError)?.recordKind ?? null, 'CreditManifesto', '10.2 recordKind = CreditManifesto');

  store.close();
}

console.log('\nCreditManifesto list ops:');
{
  const store = new RecordGraphStore(':memory:');

  /* 11. list empty */
  assertEqual(store.listCreditManifestos().length, 0, '11.1 list on empty table → []');

  /* 12. list after inserts — set-membership only (see note in case 6). */
  const a = makeManifesto('2026-01-01T00:00:00Z');
  const b = makeManifesto('2026-03-01T00:00:00Z');
  store.insertCreditManifesto(a);
  store.insertCreditManifesto(b);
  const listed = store.listCreditManifestos();
  assertEqual(listed.length, 2, '12.1 list returns 2 records');
  const ids = new Set(listed.map((r) => r.id));
  assert(ids.has(a.id), '12.2 set contains a.id');
  assert(ids.has(b.id), '12.3 set contains b.id');

  store.close();
}

console.log('\nLibrarySnapshots list op (added for registry symmetry):');
{
  const store = new RecordGraphStore(':memory:');

  /* 13. list empty */
  assertEqual(store.listLibrarySnapshots().length, 0, '13.1 list on empty table → []');

  /* 14. list after inserts — set-membership only (see note in case 6). */
  const a = makeSnapshot('2026-01-01T00:00:00Z');
  const b = makeSnapshot('2026-04-01T00:00:00Z');
  store.insertLibrarySnapshot(a);
  store.insertLibrarySnapshot(b);
  const listed = store.listLibrarySnapshots();
  assertEqual(listed.length, 2, '14.1 list returns 2 records');
  const ids = new Set(listed.map((r) => r.id));
  assert(ids.has(a.id), '14.2 set contains a.id');
  assert(ids.has(b.id), '14.3 set contains b.id');

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
