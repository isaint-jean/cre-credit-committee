/**
 * Tests for the LibrarySnapshot producer (Stage 2).
 *
 *   npm run test:library-snapshot-producer
 *
 * Verifies distribution math (median/p25/p75 to known values), n<20 degraded mode, content-hash
 * stability, idempotency, persistence round-trip, and the percentile helper edge cases.
 */

import { ASSET_TYPES, type AssetType, type ContentHash } from '@cre/contracts';
import {
  ApprovedDealsStore,
  type ApprovedDeal,
  type ApprovedDealStatus,
} from '../storage/approved-deals-store.js';
import {
  buildLibrarySnapshot,
  MIN_DISTRIBUTION_N,
  percentile,
} from '../services/library-snapshot-producer.service.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';

const AS_OF = '2026-05-08T00:00:00Z';
const DEAL_AS_OF = '2026-01-01T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}

/* ------------------------------- fixtures -------------------------------- */

function makeDeal(id: string, assetType: AssetType, vacancyPct: number, overrides: Partial<ApprovedDeal> = {}): ApprovedDeal {
  return {
    id,
    assetType,
    vacancyPct,
    expenseRatio: 0.30,
    capRate: 0.06,
    treasury10YAtClose: 0.04,
    dscr: 1.30,
    status: 'approved' as ApprovedDealStatus,
    closedAt: DEAL_AS_OF,
    ...overrides,
  };
}

/* --------------------------------- run ----------------------------------- */

console.log('Percentile math (linear interpolation):');
{
  const xs = [10, 20, 30, 40, 50];
  assertEqual(percentile(xs, 50), 30, 'median of [10..50]');
  assertEqual(percentile(xs, 25), 20, 'p25 of [10..50]');
  assertEqual(percentile(xs, 75), 40, 'p75 of [10..50]');
  assertEqual(percentile(xs, 0),  10, 'p0 of [10..50]');
  assertEqual(percentile(xs, 100),50, 'p100 of [10..50]');
}
{
  // 4 elements → linear interpolation between values
  const xs = [10, 20, 30, 40];
  assertEqual(percentile(xs, 50), 25, 'median interpolates between 20 and 30');
  assertEqual(percentile(xs, 25), 17.5, 'p25 interpolates');
}
{
  assertEqual(percentile([42], 50), 42, 'single-element percentile');
}

console.log('\nDistribution build — full Office distribution (25 deals, 0.01..0.25 vacancy):');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 1; i <= 25; i++) {
    deals.push(makeDeal(`o-${i.toString().padStart(2, '0')}`, 'Office', i / 100));
  }
  store.insertMany(deals);

  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  const office = snap.byAssetType.Office;
  assert(office !== null, 'Office distribution computed');
  if (office) {
    assertEqual(office.n, 25, 'n = 25');
    assertClose(office.vacancy.median, 0.13, 1e-9, 'vacancy median = 0.13 (13/100)');
    assertClose(office.vacancy.p25,    0.07, 1e-9, 'vacancy p25 = 0.07 (7/100)');
    assertClose(office.vacancy.p75,    0.19, 1e-9, 'vacancy p75 = 0.19 (19/100)');
  }

  // Other asset types: no deals → null
  for (const t of ASSET_TYPES) {
    if (t !== 'Office') {
      assertEqual(snap.byAssetType[t], null, `${t} → null (no deals)`);
    }
  }
  store.close();
}

console.log('\nDegraded mode — n < 20 produces null:');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 0; i < MIN_DISTRIBUTION_N - 1; i++) {        // 19 deals — one short
    deals.push(makeDeal(`m-${i}`, 'Multifamily', 0.05));
  }
  store.insertMany(deals);

  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  assertEqual(snap.byAssetType.Multifamily, null, 'n=19 < 20 → null');
  store.close();
}

console.log('\nDegraded mode — n exactly 20 computes:');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 0; i < MIN_DISTRIBUTION_N; i++) {            // exactly 20
    deals.push(makeDeal(`m-${i}`, 'Multifamily', 0.05));
  }
  store.insertMany(deals);

  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  assert(snap.byAssetType.Multifamily !== null, 'n=20 → distribution computed');
  if (snap.byAssetType.Multifamily) {
    assertEqual(snap.byAssetType.Multifamily.n, 20, 'n = 20');
  }
  store.close();
}

console.log('\nStatus filter — only "approved" rows used:');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  // 25 approved + 30 pending (should not affect distribution)
  for (let i = 0; i < 25; i++) {
    deals.push(makeDeal(`a-${i}`, 'Office', 0.10));
  }
  for (let i = 0; i < 30; i++) {
    deals.push(makeDeal(`p-${i}`, 'Office', 0.99, { status: 'pending' }));
  }
  store.insertMany(deals);

  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  const office = snap.byAssetType.Office;
  assert(office !== null, 'Office distribution computed');
  if (office) {
    assertEqual(office.n, 25, 'n counts only approved rows');
    assertClose(office.vacancy.median, 0.10, 1e-9, 'pending rows excluded from median (would have been 0.99)');
  }
  store.close();
}

console.log('\nIdempotency:');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 1; i <= 25; i++) {
    deals.push(makeDeal(`d-${i}`, 'Office', i / 100));
  }
  store.insertMany(deals);

  const a = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  const b = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  assertEqual(a.id, b.id, 'same store + asOf → same snapshot id');
  store.close();
}

console.log('\nTable hash detects drift:');
{
  const store = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 1; i <= 25; i++) {
    deals.push(makeDeal(`d-${i}`, 'Office', i / 100));
  }
  store.insertMany(deals);

  const before = buildLibrarySnapshot({ asOfDate: AS_OF, store });

  // Add one more deal
  store.insertMany([makeDeal('extra', 'Office', 0.99)]);

  const after = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  assert(before.id !== after.id, 'snapshot id differs after table mutation');
  assert(
    before.approvedDealsTableHash !== after.approvedDealsTableHash,
    'table hash differs after table mutation',
  );
  store.close();
}

console.log('\nFK + persistence round-trip:');
{
  const dealsStore = new ApprovedDealsStore(':memory:');
  const deals: ApprovedDeal[] = [];
  for (let i = 1; i <= 25; i++) {
    deals.push(makeDeal(`d-${i}`, 'Office', i / 100));
  }
  dealsStore.insertMany(deals);

  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store: dealsStore });

  // Persist via RecordGraphStore (separate :memory: db)
  const recordStore = new RecordGraphStore(':memory:');
  const result = recordStore.insertLibrarySnapshot(snap);
  assert(result.inserted, 'snapshot persisted');

  const fetched = recordStore.getLibrarySnapshot(snap.id);
  assert(fetched !== null, 'snapshot retrievable');
  if (fetched) {
    assertEqual(fetched.byAssetType.Office?.n ?? -1, 25, 'distribution n round-trips');
  }
  recordStore.close();
  dealsStore.close();
}

console.log('\nasOfDate stamped:');
{
  const store = new ApprovedDealsStore(':memory:');
  const snap = buildLibrarySnapshot({ asOfDate: AS_OF, store });
  assertEqual(snap.asOf, AS_OF, 'asOf preserved');
  // approvedDealsTableHash stable for empty table
  assert(/^[0-9a-f]{64}$/.test(snap.approvedDealsTableHash as string), 'table hash is hex');
  store.close();
}

console.log('\nApprovedDealsStore — invalid asset type rejected on read:');
{
  const store = new ApprovedDealsStore(':memory:');
  // Insert via raw SQL bypassing the typed insertMany()
  // (simulates corrupt data; verifies we surface it rather than silently coerce)
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  db.prepare(
    `INSERT INTO approved_deals (id, asset_type, vacancy_pct, expense_ratio, cap_rate, treasury_10y_at_close, dscr, status, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('bad', 'NonexistentType', 0.05, 0.30, 0.06, 0.04, 1.30, 'approved', DEAL_AS_OF);
  let threw = false;
  try {
    store.getAllApproved();
  } catch {
    threw = true;
  }
  assert(threw, 'bad asset_type surfaces as error on read');
  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
