/**
 * Tests for the HistoricalUW → ApprovedDeal connector (issue #20).
 *
 *   npm run test:import-historical-uws       (from apps/api)
 *
 * Coverage:
 *   - Happy path: fully-populated approved UW projects correctly
 *   - Outcome filter: 'modified' / 'rejected' skip with reason
 *   - Asset-type normalization: all 9 lowercase → PascalCase + unknown → skip
 *   - Null-required-field skips: vacancy / capRate / dscr (one each)
 *   - Expense-ratio undefined: null rents / null expenses / rents <= 0
 *   - Expense-ratio formula correctness with known inputs
 *   - Date normalization (YYYY-MM-DD → T00:00:00Z; full ISO passes through)
 *   - Idempotency: running importer twice produces same count + content
 *   - ImportReport shape: totals + by-asset-type + skip-reason sum
 */

import type { ApprovedDeal } from '../storage/approved-deals-store.js';
import { ApprovedDealsStore } from '../storage/approved-deals-store.js';
import type { HistoricalUnderwriting } from '@cre/shared';
import {
  importHistoricalUWsToApprovedDeals,
  projectHistoricalUWToApprovedDeal,
} from '../services/import-historical-uws-to-approved.js';

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

/* ---------------------------- fixture builders ----------------------------- */

/** Minimal HistoricalUnderwriting builder with sensible defaults. Override only
 *  the fields a given test cares about. */
function makeUW(overrides: {
  id?: string;
  assetType?: string;
  outcome?: 'approved' | 'modified' | 'rejected';
  date?: string;
  inputs?: Partial<HistoricalUnderwriting['inputs']>;
} = {}): HistoricalUnderwriting {
  const inputs = {
    noi: 1_000_000,
    rents: 2_000_000,
    vacancy: 0.05,
    expenses: 800_000,
    capRate: 0.065,
    loanAmount: 10_000_000,
    loanTerm: 10,
    interestRate: 0.07,
    ltv: 0.65,
    dscr: 1.35,
    ...(overrides.inputs ?? {}),
  };
  return {
    id: overrides.id ?? 'uw-' + Math.random().toString(36).slice(2, 10),
    assetType: (overrides.assetType ?? 'office') as HistoricalUnderwriting['assetType'],
    dealName: 'Test Deal',
    outcome: overrides.outcome ?? 'approved',
    date: overrides.date ?? '2026-04-15',
    year: 2026,
    notes: '',
    fileName: 'test.xlsx',
    fileSize: 100_000,
    brokerName: 'Test Broker',
    brokerFirm: 'Test Firm',
    city: 'Testville',
    state: 'CA',
    brokerNarratives: [],
    inputs: inputs as HistoricalUnderwriting['inputs'],
    adjustments: { noiAdjustment: null, capRateAdjustment: null, valueAdjustment: null, leverageAdjustment: null },
    structure: { reserves: null, recourse: null, cashManagement: null, earnOut: null },
    loanType: 'single_asset',
    parentId: null,
    portfolioProperties: [],
    fileHash: 'abc',
    dataQuality: 'complete',
    outcomeSource: null,
    outcomeConfidence: null,
    kickMatchId: null,
    outcomeAudit: null,
    extractedAt: '2026-04-15T00:00:00Z',
    createdAt: '2026-04-15T00:00:00Z',
    updatedAt: '2026-04-15T00:00:00Z',
  } as HistoricalUnderwriting;
}

function expectOk(r: ReturnType<typeof projectHistoricalUWToApprovedDeal>): ApprovedDeal {
  if (r.kind !== 'ok') throw new Error('expected ok projection, got skip: ' + r.reason);
  return r.deal;
}

/* ======================== TESTS =========================================== */

console.log('Happy path — fully-populated approved Office UW:');
{
  const uw = makeUW({
    id: 'uw-happy',
    assetType: 'office',
    inputs: { vacancy: 0.05, capRate: 0.065, dscr: 1.35, rents: 2_000_000, expenses: 800_000 },
  });
  const r = projectHistoricalUWToApprovedDeal(uw);
  const d = expectOk(r);
  assertEqual(d.id, 'uw-happy', 'id passed through from UW');
  assertEqual(d.assetType, 'Office', 'assetType normalized lowercase → PascalCase');
  assertEqual(d.vacancyPct, 0.05, 'vacancyPct === inputs.vacancy');
  assertEqual(d.expenseRatio, 0.4, 'expenseRatio === expenses/rents (800k / 2M = 0.4)');
  assertEqual(d.capRate, 0.065, 'capRate === inputs.capRate');
  assertEqual(d.dscr, 1.35, 'dscr === inputs.dscr');
  assertEqual(d.treasury10YAtClose, null, 'treasury10YAtClose === null (Decision 2)');
  assertEqual(d.status, 'approved', 'status === approved');
  assertEqual(d.closedAt, '2026-04-15T00:00:00Z', 'closedAt has T00:00:00Z suffix');
}

console.log('\nOutcome filter — non-approved UWs skip:');
{
  const rMod = projectHistoricalUWToApprovedDeal(makeUW({ outcome: 'modified' }));
  assertEqual(rMod.kind === 'skip' ? rMod.reason : 'NO_SKIP', 'outcome_not_approved', "outcome='modified' → skip outcome_not_approved");
  const rRej = projectHistoricalUWToApprovedDeal(makeUW({ outcome: 'rejected' }));
  assertEqual(rRej.kind === 'skip' ? rRej.reason : 'NO_SKIP', 'outcome_not_approved', "outcome='rejected' → skip outcome_not_approved");
}

console.log('\nAsset-type normalization — all 9 valid + unknown:');
{
  const cases: ReadonlyArray<[string, string]> = [
    ['office',       'Office'],
    ['retail',       'Retail'],
    ['multifamily',  'Multifamily'],
    ['hotel',        'Hotel'],
    ['industrial',   'Industrial'],
    ['self_storage', 'SelfStorage'],
    ['mhc',          'MHC'],
    ['mixed_use',    'MixedUse'],
    ['other',        'Other'],
  ];
  for (const [raw, expected] of cases) {
    const r = projectHistoricalUWToApprovedDeal(makeUW({ assetType: raw }));
    if (r.kind === 'ok') assertEqual(r.deal.assetType, expected, `'${raw}' → '${expected}'`);
    else fail(`'${raw}' projection unexpectedly skipped: ${r.reason}`);
  }
  // Unknown asset type
  const rUnknown = projectHistoricalUWToApprovedDeal(makeUW({ assetType: 'student_housing' }));
  assertEqual(rUnknown.kind === 'skip' ? rUnknown.reason : 'NO_SKIP', 'unknown_asset_type', "unknown raw asset_type → skip unknown_asset_type");
}

console.log('\nNull-required-field skips:');
{
  const rV = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { vacancy: null } }));
  assertEqual(rV.kind === 'skip' ? rV.reason : 'NO_SKIP', 'null_vacancy', 'null vacancy → skip null_vacancy');
  const rC = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { capRate: null } }));
  assertEqual(rC.kind === 'skip' ? rC.reason : 'NO_SKIP', 'null_capRate', 'null capRate → skip null_capRate');
  const rD = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { dscr: null } }));
  assertEqual(rD.kind === 'skip' ? rD.reason : 'NO_SKIP', 'null_dscr', 'null dscr → skip null_dscr');
}

console.log('\nExpense-ratio undefined skips:');
{
  const rE = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { expenses: null } }));
  assertEqual(rE.kind === 'skip' ? rE.reason : 'NO_SKIP', 'expense_ratio_undefined', 'null expenses → skip expense_ratio_undefined');
  const rR = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { rents: null } }));
  assertEqual(rR.kind === 'skip' ? rR.reason : 'NO_SKIP', 'expense_ratio_undefined', 'null rents → skip expense_ratio_undefined');
  const rZ = projectHistoricalUWToApprovedDeal(makeUW({ inputs: { rents: 0 } }));
  assertEqual(rZ.kind === 'skip' ? rZ.reason : 'NO_SKIP', 'expense_ratio_undefined', 'rents=0 → skip expense_ratio_undefined (avoid /0)');
}

console.log('\nExpense-ratio formula correctness:');
{
  const uw = makeUW({ inputs: { rents: 1_000_000, expenses: 350_000 } });
  const d = expectOk(projectHistoricalUWToApprovedDeal(uw));
  assertClose(d.expenseRatio, 0.35, 1e-9, 'expenseRatio = 350k / 1M = 0.35');
}

console.log('\nDate normalization:');
{
  const dShort = expectOk(projectHistoricalUWToApprovedDeal(makeUW({ date: '2025-08-30' })));
  assertEqual(dShort.closedAt, '2025-08-30T00:00:00Z', 'YYYY-MM-DD → YYYY-MM-DDT00:00:00Z');
  const dFull = expectOk(projectHistoricalUWToApprovedDeal(makeUW({ date: '2025-08-30T14:23:11Z' })));
  assertEqual(dFull.closedAt, '2025-08-30T14:23:11Z', 'full ISO passes through unchanged');
}

console.log('\nIdempotency — running importer twice produces same state:');
{
  const store = new ApprovedDealsStore(':memory:');
  const uws = [
    makeUW({ id: 'id-1', assetType: 'office' }),
    makeUW({ id: 'id-2', assetType: 'retail' }),
    makeUW({ id: 'id-3', assetType: 'multifamily' }),
  ];
  const r1 = importHistoricalUWsToApprovedDeals(uws, store);
  assertEqual(r1.imported, 3, 'first import: 3 survivors');
  assertEqual(store.countByStatus('approved'), 3, 'first import: store has 3 rows');
  const r2 = importHistoricalUWsToApprovedDeals(uws, store);
  assertEqual(r2.imported, 3, 'second import: same 3 survivors');
  assertEqual(store.countByStatus('approved'), 3, 'second import: store still has 3 rows (INSERT OR REPLACE)');
  store.close();
}

console.log('\nImportReport shape — totals + skip sum:');
{
  const store = new ApprovedDealsStore(':memory:');
  const uws = [
    makeUW({ id: 'survives-1' }),                              // ok
    makeUW({ id: 'survives-2', assetType: 'retail' }),         // ok
    makeUW({ id: 'skip-modified', outcome: 'modified' }),       // skip outcome_not_approved
    makeUW({ id: 'skip-unknown',  assetType: 'student' }),     // skip unknown_asset_type
    makeUW({ id: 'skip-nullvac',  inputs: { vacancy: null } }),// skip null_vacancy
  ];
  const r = importHistoricalUWsToApprovedDeals(uws, store);
  assertEqual(r.totalSeen, 5, 'totalSeen counts ALL UWs including skips');
  assertEqual(r.imported, 2, 'imported counts only survivors');
  const skipSum =
    r.skipped.outcome_not_approved + r.skipped.unknown_asset_type +
    r.skipped.null_vacancy + r.skipped.null_capRate + r.skipped.null_dscr +
    r.skipped.expense_ratio_undefined;
  assertEqual(skipSum, 3, 'skip-reason counts sum to (totalSeen - imported)');
  assertEqual(r.skipped.outcome_not_approved, 1, 'outcome_not_approved = 1');
  assertEqual(r.skipped.unknown_asset_type, 1, 'unknown_asset_type = 1');
  assertEqual(r.skipped.null_vacancy, 1, 'null_vacancy = 1');
  // importedByAssetType sums to imported
  const byAtSum = Object.values(r.importedByAssetType).reduce((a, b) => a + b, 0);
  assertEqual(byAtSum, 2, 'importedByAssetType sums to imported');
  assertEqual(r.importedByAssetType.Office, 1, 'Office: 1');
  assertEqual(r.importedByAssetType.Retail, 1, 'Retail: 1');
  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
