/**
 * Tests for the Master Kick List → kicks_registry connector (#34).
 *
 *   npm run test:import-kicks-to-registry        (from apps/api)
 *
 * Coverage:
 *   - Cleaning helpers (parsePercent / parseDollars / parseDscr / parseUnits /
 *     parseYear / normalizeSingleTenant / normalizeLoanPurpose /
 *     normalizeSponsor / trimCommentOrNull)
 *   - Asset-type mapping (including Parking → Other, Various → skip, blank → skip)
 *   - projectKickToRegistry: ok + both skip reasons
 *   - Content-hash id stability (same input → same id; differing inputs → different ids)
 *   - importKicksToRegistry: report shape + ImportReport accounting
 *   - Replace-all idempotency under shrinking inputs (#29 lesson, applied here)
 */

import { KicksRegistryStore } from '../storage/kicks-registry-store.js';
import {
  computeKickId,
  importKicksToRegistry,
  normalizeLoanPurpose,
  normalizeSingleTenant,
  normalizeSponsor,
  parseDollars,
  parseDscr,
  parsePercent,
  parseUnits,
  parseYear,
  projectKickToRegistry,
  trimCommentOrNull,
  trimOrNull,
  type KickSourceRow,
} from '../services/import-kicks-to-registry.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number | null, b: number, eps: number, m: string): void {
  if (a === null) { fail(`${m} (actual=null, expected≈${b})`); return; }
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected≈${b})`);
}

/* ---------------------------- fixture builder ----------------------------- */

/** Minimal happy-path source row. Override columns the test cares about. */
function makeRow(overrides: Partial<KickSourceRow> = {}): KickSourceRow {
  return {
    'UW Received': 'N',
    'ASR Received': '4/25/17',
    'Deal': 'BANK 2017-BNK5',
    '8F Control': '16',
    'Normalized EF Property Type': 'Retail',
    'Property Flag': 'Loan',
    'Seller': 'BANA',
    'Vintage': '2017',
    'Property Name': 'Test Property',
    'Address': '123 Main St',
    'City': 'Anytown',
    'State': 'NY',
    'Property Type': 'Retail',
    'Property Sub-Type': 'Anchored',
    'Year Built': '1990',
    'Year Renovated': '2010',
    'Units': ' 100,000 ',
    'Cut-Off Property Balance': '$10,000,000',
    'Implied Total Debt at Cut Off based on LTV': '$15,000,000',
    'Current Debt per Unit': '$100.00',
    'LTV at Cut-off': '65.0%',
    'LTV at Maturity': '55.0%',
    'U/W NOI Debt Yield': '10.0%',
    'Amortization Type': 'Amortizing',
    'Most Recent Occ': '95.0%',
    'UW NCF DSCR': '1.50x',
    'Sponsor': 'Test Sponsor',
    'Single Tenant (Yes/No)': 'No',
    'Loan Purpose': 'Refinance',
    'ZF Comments': 'Test rationale',
    'ZF UW Review Comment': null,
    'MSA': 'New York, NY',
    ...overrides,
  };
}

const IMPORTED_AT = '2026-05-22T00:00:00Z';

/* ======================== TESTS =========================================== */

console.log('trimOrNull:');
assertEqual(trimOrNull(null), null, 'null → null');
assertEqual(trimOrNull('  '), null, 'whitespace-only → null');
assertEqual(trimOrNull(''), null, 'empty → null');
assertEqual(trimOrNull('  hello '), 'hello', 'trims whitespace');

console.log('\ntrimCommentOrNull:');
assertEqual(trimCommentOrNull('-'), null, '"-" → null (placeholder)');
assertEqual(trimCommentOrNull(' - '), null, '" - " → null (trimmed placeholder)');
assertEqual(trimCommentOrNull(null), null, 'null → null');
assertEqual(trimCommentOrNull('Real text'), 'Real text', 'real text preserved');

console.log('\nparsePercent (returns decimal fraction):');
assertClose(parsePercent('65.0%'), 0.65, 1e-9, '"65.0%" → 0.65');
assertClose(parsePercent('100.0%'), 1.0, 1e-9, '"100.0%" → 1.0');
assertClose(parsePercent('0.0%'), 0.0, 1e-9, '"0.0%" → 0.0');
assertEqual(parsePercent('NAP'), null, '"NAP" → null');
assertEqual(parsePercent('TBD'), null, '"TBD" → null');
assertEqual(parsePercent('-'), null, '"-" → null');
assertEqual(parsePercent('N/A'), null, '"N/A" → null');
assertEqual(parsePercent(null), null, 'null → null');

console.log('\nparseDollars:');
assertEqual(parseDollars('$27,000,000'), 27000000, '"$27,000,000" → 27000000');
assertEqual(parseDollars('$0'), 0, '"$0" → 0 (zero balance preserved per design)');
assertEqual(parseDollars('$325.94'), 325.94, '"$325.94" → 325.94');
assertEqual(parseDollars('NAP'), null, '"NAP" → null');
assertEqual(parseDollars('-'), null, '"-" → null');
assertEqual(parseDollars(null), null, 'null → null');

console.log('\nparseDscr:');
assertClose(parseDscr('1.51x'), 1.51, 1e-9, '"1.51x" → 1.51');
assertClose(parseDscr('2.00x'), 2.0, 1e-9, '"2.00x" → 2.0');
assertClose(parseDscr('1.50'), 1.5, 1e-9, '"1.50" (no x suffix) → 1.5');
assertEqual(parseDscr('NAP'), null, '"NAP" → null');
assertEqual(parseDscr(null), null, 'null → null');

console.log('\nparseUnits:');
assertEqual(parseUnits(' 414,191 '), 414191, '" 414,191 " → 414191');
assertEqual(parseUnits('100'), 100, '"100" → 100');
assertEqual(parseUnits('TBD'), null, '"TBD" → null');
assertEqual(parseUnits('-'), null, '"-" → null');

console.log('\nparseYear:');
assertEqual(parseYear('1974'), 1974, '"1974" → 1974');
assertEqual(parseYear('2026'), 2026, '"2026" → 2026');
assertEqual(parseYear('1849'), null, '"1849" → null (below range)');
assertEqual(parseYear('2101'), null, '"2101" → null (above range)');
assertEqual(parseYear('1999, 2001, 2002, & 2005'), null, 'multi-year string → null');
assertEqual(parseYear('TBD'), null, '"TBD" → null');
assertEqual(parseYear('Various'), null, '"Various" → null');
assertEqual(parseYear('N/A'), null, '"N/A" → null');
assertEqual(parseYear('tbd'), null, '"tbd" (lowercase) → null');

console.log('\nnormalizeSingleTenant:');
assertEqual(normalizeSingleTenant('Yes'), 1, '"Yes" → 1');
assertEqual(normalizeSingleTenant('Y'), 1, '"Y" → 1');
assertEqual(normalizeSingleTenant('yes'), 1, '"yes" (lowercase) → 1');
assertEqual(normalizeSingleTenant('No'), 0, '"No" → 0');
assertEqual(normalizeSingleTenant('N'), 0, '"N" → 0');
assertEqual(normalizeSingleTenant('N '), 0, '"N " (trailing space) → 0');
assertEqual(normalizeSingleTenant('NAP'), null, '"NAP" → null');
assertEqual(normalizeSingleTenant('TBD'), null, '"TBD" → null');
assertEqual(normalizeSingleTenant('N/A'), null, '"N/A" → null');
assertEqual(normalizeSingleTenant('Various'), null, '"Various" → null');
assertEqual(normalizeSingleTenant('0'), null, '"0" → null');
assertEqual(normalizeSingleTenant(null), null, 'null → null');

console.log('\nnormalizeLoanPurpose:');
assertEqual(normalizeLoanPurpose('Recapitilization'), 'Recapitalization', 'typo correction');
assertEqual(normalizeLoanPurpose('Refinance'), 'Refinance', 'normal pass-through');
assertEqual(normalizeLoanPurpose('Acquisition'), 'Acquisition', 'pass-through');
assertEqual(normalizeLoanPurpose('0'), null, '"0" → null');
assertEqual(normalizeLoanPurpose('TBD'), null, '"TBD" → null');
assertEqual(normalizeLoanPurpose('No'), null, '"No" → null');
assertEqual(normalizeLoanPurpose(null), null, 'null → null');

console.log('\nnormalizeSponsor:');
assertEqual(normalizeSponsor('Simon Property Group'), 'Simon Property Group', 'pass-through');
assertEqual(normalizeSponsor('0'), null, '"0" → null');
assertEqual(normalizeSponsor('TBD'), null, '"TBD" → null');
assertEqual(normalizeSponsor(' '), null, '" " → null');
assertEqual(normalizeSponsor(null), null, 'null → null');

console.log('\nAsset-type mapping (via projectKickToRegistry):');
{
  const cases: ReadonlyArray<[string, string]> = [
    ['Office', 'Office'],
    ['Retail', 'Retail'],
    ['Multifamily', 'Multifamily'],
    ['Hotel', 'Hotel'],
    ['Industrial', 'Industrial'],
    ['MHC', 'MHC'],
    ['Mixed Use', 'MixedUse'],
    ['Self Storage', 'SelfStorage'],
    ['Other', 'Other'],
    ['Parking', 'Other'],
  ];
  for (const [raw, expected] of cases) {
    const r = projectKickToRegistry(makeRow({ 'Normalized EF Property Type': raw }), IMPORTED_AT);
    if (r.kind === 'ok') assertEqual(r.kick.assetType, expected, `"${raw}" → "${expected}"`);
    else fail(`"${raw}" unexpectedly skipped: ${r.reason}`);
  }
}

console.log('\nSpacer-row + unmappable-asset-type skips:');
{
  const blank = projectKickToRegistry(makeRow({ 'Normalized EF Property Type': null }), IMPORTED_AT);
  assertEqual(blank.kind === 'skip' ? blank.reason : 'NO_SKIP', 'spacer_row', 'null PT → spacer_row');
  const ws = projectKickToRegistry(makeRow({ 'Normalized EF Property Type': '  ' }), IMPORTED_AT);
  assertEqual(ws.kind === 'skip' ? ws.reason : 'NO_SKIP', 'spacer_row', 'whitespace-only PT → spacer_row');
  const various = projectKickToRegistry(makeRow({ 'Normalized EF Property Type': 'Various' }), IMPORTED_AT);
  assertEqual(various.kind === 'skip' ? various.reason : 'NO_SKIP', 'asset_type_unmappable', '"Various" → asset_type_unmappable');
  const garbage = projectKickToRegistry(makeRow({ 'Normalized EF Property Type': 'Spaceport' }), IMPORTED_AT);
  assertEqual(garbage.kind === 'skip' ? garbage.reason : 'NO_SKIP', 'asset_type_unmappable', 'unknown PT → asset_type_unmappable');
}

console.log('\nHappy-path projection — full field mapping:');
{
  const r = projectKickToRegistry(makeRow(), IMPORTED_AT);
  if (r.kind !== 'ok') { fail('expected ok'); }
  else {
    const k = r.kick;
    assertEqual(k.assetType, 'Retail', 'assetType mapped');
    assertEqual(k.source8fControl, '16', 'source 8F control preserved');
    assertEqual(k.deal, 'BANK 2017-BNK5', 'deal preserved');
    assertEqual(k.seller, 'BANA', 'seller preserved');
    assertEqual(k.vintage, 2017, 'vintage parsed');
    assertEqual(k.propertyName, 'Test Property', 'propertyName preserved');
    assertEqual(k.state, 'NY', 'state preserved');
    assertEqual(k.msa, 'New York, NY', 'msa preserved');
    assertEqual(k.propertySubType, 'Anchored', 'sub-type preserved');
    assertEqual(k.yearBuilt, 1990, 'yearBuilt parsed');
    assertEqual(k.yearRenovated, 2010, 'yearRenovated parsed');
    assertEqual(k.units, 100000, 'units parsed');
    assertEqual(k.cutOffBalanceDollars, 10000000, 'cutOffBalance parsed');
    assertClose(k.ltvAtCutoff, 0.65, 1e-9, 'ltvAtCutoff as decimal fraction');
    assertClose(k.ltvAtMaturity, 0.55, 1e-9, 'ltvAtMaturity as decimal fraction');
    assertClose(k.debtYield, 0.10, 1e-9, 'debtYield as decimal fraction');
    assertClose(k.dscr, 1.50, 1e-9, 'dscr parsed (no x suffix)');
    assertClose(k.occupancyPct, 0.95, 1e-9, 'occupancyPct as decimal fraction');
    assertEqual(k.singleTenant, 0, 'singleTenant "No" → 0');
    assertEqual(k.loanPurpose, 'Refinance', 'loanPurpose preserved');
    assertEqual(k.zfComments, 'Test rationale', 'zfComments preserved');
    assertEqual(k.uwReceivedRaw, 'N', 'UW Received preserved as raw string');
    assertEqual(k.asrReceivedRaw, '4/25/17', 'ASR Received preserved as raw string');
    assertEqual(k.importedAt, IMPORTED_AT, 'importedAt stamped');
    assert(k.rawRowJson.length > 100, 'rawRowJson is populated');
    assertEqual(k.id.length, 16, 'id is 16 chars');
  }
}

console.log('\nContent-hash id stability:');
{
  const id1 = computeKickId({
    assetType: 'Office', source8fControl: '42', propertyName: 'Foo',
    address: '1 St', city: 'NYC', state: 'NY', deal: 'DEAL-A', vintage: 2020,
  });
  const id2 = computeKickId({
    assetType: 'Office', source8fControl: '42', propertyName: 'Foo',
    address: '1 St', city: 'NYC', state: 'NY', deal: 'DEAL-A', vintage: 2020,
  });
  assertEqual(id1, id2, 'identical inputs → identical id');
  const id3 = computeKickId({
    assetType: 'Office', source8fControl: '42', propertyName: 'Bar',
    address: '1 St', city: 'NYC', state: 'NY', deal: 'DEAL-A', vintage: 2020,
  });
  assert(id1 !== id3, 'differing propertyName → differing id');
  assertEqual(id1.length, 16, 'id is 16 chars');
}

console.log('\nimportKicksToRegistry — report shape:');
{
  const store = new KicksRegistryStore(':memory:');
  const rows: KickSourceRow[] = [
    makeRow({ '8F Control': '1', 'Property Name': 'A', 'Normalized EF Property Type': 'Office' }),
    makeRow({ '8F Control': '2', 'Property Name': 'B', 'Normalized EF Property Type': 'Retail' }),
    makeRow({ 'Normalized EF Property Type': null }),     // spacer_row
    makeRow({ 'Normalized EF Property Type': 'Various' }), // asset_type_unmappable
    makeRow({ '8F Control': '3', 'Property Name': 'C', 'Normalized EF Property Type': 'Parking' }), // → Other
  ];
  const r = importKicksToRegistry(rows, store, IMPORTED_AT);
  assertEqual(r.totalSeen, 5, 'totalSeen = 5');
  assertEqual(r.imported, 3, 'imported = 3 survivors');
  assertEqual(r.skipped.spacer_row, 1, 'spacer_row count');
  assertEqual(r.skipped.asset_type_unmappable, 1, 'asset_type_unmappable count');
  assertEqual(r.importedByAssetType.Office, 1, 'Office=1');
  assertEqual(r.importedByAssetType.Retail, 1, 'Retail=1');
  assertEqual(r.importedByAssetType.Other, 1, 'Other=1 (Parking reclassified)');
  assertEqual(store.count(), 3, 'store reflects 3 rows');
  store.close();
}

console.log('\nReplace-all semantics — shrinking input purges stale rows:');
{
  const store = new KicksRegistryStore(':memory:');
  const initialRows: KickSourceRow[] = [
    makeRow({ '8F Control': '1', 'Property Name': 'A' }),
    makeRow({ '8F Control': '2', 'Property Name': 'B' }),
    makeRow({ '8F Control': '3', 'Property Name': 'C' }),
  ];
  importKicksToRegistry(initialRows, store, IMPORTED_AT);
  assertEqual(store.count(), 3, 'first import: 3 rows');
  const shrunkRows: KickSourceRow[] = [
    makeRow({ '8F Control': '1', 'Property Name': 'A' }),
    makeRow({ '8F Control': '2', 'Property Name': 'B' }),
  ];
  const r = importKicksToRegistry(shrunkRows, store, IMPORTED_AT);
  assertEqual(r.imported, 2, 'shrunk re-import: 2 survivors');
  assertEqual(store.count(), 2, 'store reflects shrunk set (row C purged)');
  store.close();
}

console.log('\nIdempotency — running importer twice produces same state:');
{
  const store = new KicksRegistryStore(':memory:');
  const rows: KickSourceRow[] = [
    makeRow({ '8F Control': '1', 'Property Name': 'A', 'Normalized EF Property Type': 'Office' }),
    makeRow({ '8F Control': '2', 'Property Name': 'B', 'Normalized EF Property Type': 'Retail' }),
  ];
  importKicksToRegistry(rows, store, IMPORTED_AT);
  const allFirst = store.getAll();
  importKicksToRegistry(rows, store, IMPORTED_AT);
  const allSecond = store.getAll();
  assertEqual(allFirst.length, allSecond.length, 'row count stable');
  assertEqual(allFirst[0]!.id, allSecond[0]!.id, 'ids stable across runs');
  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
