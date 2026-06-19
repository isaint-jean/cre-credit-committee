/**
 * Tests for the conservative-lease-up doctrine (DOCTRINE_VERSION 1.5):
 *   - apps/api/src/doctrine-clean/normalization/lease-up-detection.ts
 *   - apps/api/src/services/contracted-basis.ts
 *
 *   Section 1 — isLeaseUpDeal: each of the 5 signals individually + OR combinations.
 *   Section 2 — computeContractedNoi on a Sunroad-shape fixture (expect ≈ $8.57M).
 *   Section 3 — computeContractedNoi on a genuinely-stabilized fixture (expect null).
 *   Section 4 — computeContractedNoi on a SPECULATIVE lease-up (vacant space; expect
 *               sharp NOI drop proving the generalization bites).
 *
 *   cd apps/api && npx tsx src/scripts/test-contracted-lease-up-doctrine.ts
 */
import { detectLeaseUp, isLeaseUpDeal, LEASE_UP_OCCUPANCY_GAP_THRESHOLD } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/contracted-basis.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(cond: boolean, m: string): void { cond ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertNearly(actual: number | null, expected: number, tolPct: number, m: string): void {
  if (actual === null) { fail(`${m} (actual=null)`); return; }
  const diff = Math.abs(actual - expected);
  const tol = Math.abs(expected) * tolPct;
  if (diff <= tol) ok(`${m} (actual=${Math.round(actual).toLocaleString()}, expected≈${Math.round(expected).toLocaleString()}, within ${(tolPct * 100).toFixed(1)}%)`);
  else fail(`${m} (actual=${actual}, expected≈${expected}, off by ${diff})`);
}
function section(t: string): void { console.log(`\n=== ${t} ===`); }

/* ------------------------------ fixtures ---------------------------------- */

function emptyExtraction(): never {
  return {
    id: '0'.repeat(64),
    analysisAsOfDate: '2026-06-19T00:00:00Z',
    dealRef: 'TEST',
    extractionEngineVersion: '1.9',
    extractorVersions: {},
    sourceDocuments: [],
    asr: null,
    sellerUw: null,
    sellerUwOperatingStatement: null,
    t12Actual: null,
    inPlace: null,
    propertyMetadata: null,
    pca: null,
    appraisal: null,
    parties: null,
    annexA: null,
    rentRoll: null,
    loanTerms: null,
  } as unknown as never;
}

function emptyAdjustedInputs(otherIncome: number = 0): never {
  // Minimal AdjustedInputs shape that satisfies computeContractedNoi's reads.
  return {
    id: '0'.repeat(64),
    analysisAsOfDate: '2026-06-19T00:00:00Z',
    judgmentEngineVersion: '1.11',
    librarySnapshotId: 'lib',
    income: {
      vacancyPct: { adjusted: 0.10, raw: 0.10, source: 'TEST', adjustments: [] },
      otherIncome: { adjusted: otherIncome, raw: otherIncome, source: 'TEST', adjustments: [] },
    },
    metrics: { expenseRatio: 0.30 },
  } as unknown as never;
}

function assetProfileFor(businessPlan: 'Stabilized' | 'LeaseUp_or_Transitional'): never {
  return {
    id: '0'.repeat(64),
    propertyType: 'Office',
    businessPlan,
    marketLiquidity: 'Unknown',
  } as unknown as never;
}

/* ============================ Section 1 ================================== */
section('1. isLeaseUpDeal — 5 signals + OR combinations');

// Baseline: empty extraction, stabilized assetProfile → predicate false
{
  const trace = detectLeaseUp({ extraction: emptyExtraction(), assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.isLeaseUp, false, 'empty extraction + Stabilized assetProfile → false');
  assertEqual(trace.signals.t12NonPositive, false, '  signal (1) t12NonPositive = false');
  assertEqual(trace.signals.appraisalCurrentNoiNegative, false, '  signal (2) currentNoiNegative = false');
  assertEqual(trace.signals.stabilizationMonthsPresent, false, '  signal (3) stabilizationMonthsPresent = false');
  assertEqual(trace.signals.occupancyGapMaterial, false, '  signal (4) occupancyGapMaterial = false');
  assertEqual(trace.signals.assetProfilerSaysLeaseUp, false, '  signal (5) assetProfilerSaysLeaseUp = false');
}

// Signal (1) — t12 non-positive
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.t12Actual = { noi: -100 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.t12NonPositive, true, 'signal (1) fires when t12.noi = -100');
  assertEqual(trace.isLeaseUp, true, '  predicate true on (1) alone');
}
{
  // t12 = 0 is also non-positive (≤ 0)
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.t12Actual = { noi: 0 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.t12NonPositive, true, 'signal (1) fires when t12.noi = 0 (≤ 0 boundary)');
}
{
  // t12 positive does NOT fire (1)
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.t12Actual = { noi: 1_000_000 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.t12NonPositive, false, 'signal (1) does NOT fire when t12.noi = +$1M');
  assertEqual(trace.isLeaseUp, false, '  predicate false when only positive t12');
}

// Signal (2) — appraisal currentProForma NOI < 0
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { currentProForma: { netOperatingIncome: -355_016 } };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.appraisalCurrentNoiNegative, true, 'signal (2) fires on appraisal currentNoi = -$355K (Sunroad)');
  assertEqual(trace.isLeaseUp, true, '  predicate true on (2) alone');
}
{
  // Strictly < 0; 0 does NOT fire
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { currentProForma: { netOperatingIncome: 0 } };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.appraisalCurrentNoiNegative, false, 'signal (2) does NOT fire on currentNoi = 0 (strictly <0)');
}

// Signal (3) — stabilizationMonths > 0
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { stabilizationMonths: 10 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.stabilizationMonthsPresent, true, 'signal (3) fires on stabilizationMonths = 10 (Sunroad)');
  assertEqual(trace.isLeaseUp, true, '  predicate true on (3) alone');
}
{
  // 0 months does NOT fire
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { stabilizationMonths: 0 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.stabilizationMonthsPresent, false, 'signal (3) does NOT fire on stabilizationMonths = 0');
}

// Signal (4) — occupancy gap > 10pp
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { currentOccupancyPhysical: 0.73, stabilizedOccupancy: 0.96 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.occupancyGapMaterial, true, 'signal (4) fires on 23pp gap (Sunroad)');
  assertEqual(trace.isLeaseUp, true, '  predicate true on (4) alone');
}
{
  // Exactly at threshold = 10pp; NOT strictly greater, so does NOT fire
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { currentOccupancyPhysical: 0.85, stabilizedOccupancy: 0.95 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.occupancyGapMaterial, false, `signal (4) does NOT fire at exactly threshold (gap = ${LEASE_UP_OCCUPANCY_GAP_THRESHOLD * 100}pp)`);
}
{
  // 11pp gap — just above threshold
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { currentOccupancyPhysical: 0.84, stabilizedOccupancy: 0.95 };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.signals.occupancyGapMaterial, true, 'signal (4) fires at 11pp gap');
}

// Signal (5) — assetProfile.businessPlan
{
  const trace = detectLeaseUp({ extraction: emptyExtraction(), assetProfile: assetProfileFor('LeaseUp_or_Transitional') });
  assertEqual(trace.signals.assetProfilerSaysLeaseUp, true, 'signal (5) fires when businessPlan = LeaseUp_or_Transitional');
  assertEqual(trace.isLeaseUp, true, '  predicate true on (5) alone');
}
{
  const trace = detectLeaseUp({ extraction: emptyExtraction(), assetProfile: null });
  assertEqual(trace.signals.assetProfilerSaysLeaseUp, false, 'signal (5) does NOT fire when assetProfile is null');
}

// OR combination — multiple signals fire together (Sunroad reality)
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = {
    currentProForma: { netOperatingIncome: -355_016 },
    stabilizationMonths: 10,
    currentOccupancyPhysical: 0.73,
    stabilizedOccupancy: 0.96,
  };
  const trace = detectLeaseUp({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') });
  assertEqual(trace.isLeaseUp, true, 'OR combination: Sunroad-shape fires 3 signals (2)(3)(4)');
  assertEqual(trace.signals.appraisalCurrentNoiNegative, true, '  (2) fires');
  assertEqual(trace.signals.stabilizationMonthsPresent, true, '  (3) fires');
  assertEqual(trace.signals.occupancyGapMaterial, true, '  (4) fires');
  assertEqual(trace.signals.t12NonPositive, false, '  (1) does NOT fire (t12 null)');
  assertEqual(trace.signals.assetProfilerSaysLeaseUp, false, '  (5) does NOT fire (Sunroad assetProfile is Stabilized because trailing occ is null)');
}

// Convenience wrapper returns same boolean
{
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.appraisal = { stabilizationMonths: 10 };
  assertEqual(isLeaseUpDeal({ extraction: ex as never, assetProfile: assetProfileFor('Stabilized') }), true, 'isLeaseUpDeal() convenience wrapper agrees with detectLeaseUp().isLeaseUp');
}

/* ============================ Section 2 ================================== */
section('2. computeContractedNoi — Sunroad-shape (expect ≈ $8.57M)');

{
  // 10 tenants — all signed (PRELEASED or OCCUPIED), real Sunroad annual
  // rents from the v10 rent-roll record 199ac242….
  const sunroadTenants = [
    { tenantName: 'GSA',             status: 'PRELEASED', annual: 5_168_982 },
    { tenantName: 'EDD',             status: 'OCCUPIED',  annual: 1_652_754 },
    { tenantName: 'AppFolio',        status: 'OCCUPIED',  annual: 1_618_470 },
    { tenantName: 'Cypress',         status: 'OCCUPIED',  annual: 1_452_810 },
    { tenantName: 'Sunroad Asset',   status: 'OCCUPIED',  annual: 1_328_539 },
    { tenantName: 'Conam',           status: 'OCCUPIED',  annual:   658_718 },
    { tenantName: 'Kyocera',         status: 'OCCUPIED',  annual:   554_665 },
    { tenantName: 'DRE',             status: 'OCCUPIED',  annual:   530_286 },
    { tenantName: 'ABC',             status: 'OCCUPIED',  annual:   295_436 },
    { tenantName: 'CDPH',            status: 'OCCUPIED',  annual:   122_808 },
  ];
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.rentRoll = {
    lines: sunroadTenants.map((t) => ({
      kind: 'tenant',
      tenantName: t.tenantName,
      status: t.status,
      inPlaceRentAnnual: t.annual,
    })),
  };
  const trace = computeContractedNoi({
    rentRoll: ex.rentRoll as never,
    adjustedInputs: emptyAdjustedInputs(138_000), // Sunroad's $138K other income
    isLeaseUpDeal: true,
  });

  assertEqual(trace.qualifyingTenants, 10, 'all 10 Sunroad tenants qualify (1 PRELEASED + 9 OCCUPIED)');
  assertEqual(trace.excludedTenants, 0, 'zero exclusions');
  assertEqual(trace.contractedRevenue, 13_383_468, 'contracted revenue = $13,383,468 (sum of all 10 signed leases)');
  assertNearly(trace.egi, 12_045_121, 0.001, 'EGI = revenue × (1 − 10% vacancy)');
  assertNearly(trace.toe, 3_613_536, 0.001, 'TOE = EGI × 30% expense ratio');
  assertEqual(trace.otherIncome, 138_000, 'other income = $138K (Sunroad)');
  assertNearly(trace.contractedNoi, 8_569_585, 0.001, '★ contracted NOI ≈ $8.57M (≈$8.43M base + $138K other income)');
  assert(trace.note.includes('contracted basis'), 'trace note labels the basis as "contracted basis"');
  assert(trace.note.includes('other income'), 'trace note surfaces other income contribution');
  assert(!trace.note.includes('not a lease-up'), 'trace note does NOT say "not a lease-up"');

  // Brief gate — confirm match with $8.57M expectation
  const expected = 8_569_585;
  const actual = trace.contractedNoi!;
  const driftPct = Math.abs(actual - expected) / expected;
  assert(driftPct < 0.001, `★ within 0.1% of brief expectation $8.57M (drift = ${(driftPct * 100).toFixed(3)}%) — exact match after other-income fix`);
}

/* ============================ Section 3 ================================== */
section('3. computeContractedNoi — stabilized fixture (expect null, path unchanged)');

{
  // predicate=false → return null. Stabilized deals stay on the existing
  // pickIssuerNoi cascade. This is the surgical-NOT-default guarantee.
  const trace = computeContractedNoi({
    rentRoll: { lines: [{ kind: 'tenant', status: 'OCCUPIED', inPlaceRentAnnual: 100_000 }] } as never,
    adjustedInputs: emptyAdjustedInputs(),
    isLeaseUpDeal: false,
  });
  assertEqual(trace.contractedNoi, null, 'predicate=false → contractedNoi null (no override, no behavior change)');
  assert(trace.note.includes('not a lease-up'), 'trace note says "not a lease-up"');
  assertEqual(trace.qualifyingTenants, 0, 'short-circuits without counting tenants');
}

{
  // predicate=true but rent roll absent → return null
  const trace = computeContractedNoi({
    rentRoll: null,
    adjustedInputs: emptyAdjustedInputs(),
    isLeaseUpDeal: true,
  });
  assertEqual(trace.contractedNoi, null, 'predicate=true but no rent roll → contractedNoi null (graceful fall-through)');
  assert(trace.note.includes('rent roll absent'), 'trace note says "rent roll absent"');
}

/* ============================ Section 4 ================================== */
section('4. computeContractedNoi — SPECULATIVE lease-up (generalization-bite proof)');

{
  // 10 tenants: 5 OCCUPIED ($800K each = $4M signed revenue), 5 VACANT ($0).
  // Stabilized issuer projection (if we'd used it) might be $9M+. Contracted
  // basis should land DRAMATICALLY lower because the 5 vacant tenants
  // contribute zero — proving the generalization fix bites where it should.
  const speculativeTenants = [
    { status: 'OCCUPIED', annual: 800_000 },
    { status: 'OCCUPIED', annual: 800_000 },
    { status: 'OCCUPIED', annual: 800_000 },
    { status: 'OCCUPIED', annual: 800_000 },
    { status: 'OCCUPIED', annual: 800_000 },
    { status: 'VACANT',   annual: null },
    { status: 'VACANT',   annual: null },
    { status: 'VACANT',   annual: null },
    { status: 'VACANT',   annual: null },
    { status: 'VACANT',   annual: null },
  ];
  const ex = emptyExtraction() as unknown as Record<string, unknown>;
  ex.rentRoll = {
    lines: speculativeTenants.map((t) => ({
      kind: 'tenant',
      status: t.status,
      inPlaceRentAnnual: t.annual,
    })),
  };
  const trace = computeContractedNoi({
    rentRoll: ex.rentRoll as never,
    adjustedInputs: emptyAdjustedInputs(),
    isLeaseUpDeal: true,
  });

  assertEqual(trace.qualifyingTenants, 5, 'only 5 OCCUPIED tenants qualify');
  assertEqual(trace.excludedTenants, 5, '5 VACANT tenants EXCLUDED — speculative space contributes zero');
  assertEqual(trace.contractedRevenue, 4_000_000, 'contracted revenue = $4M (5 × $800K)');
  assertNearly(trace.contractedNoi, 2_520_000, 0.01, '★ contracted NOI ≈ $2.52M (5 × $800K × 0.90 vacancy × 0.70 expense)');

  // Worked-example verdict at the $75M loan from the recon — debt service
  // ~$5.99M; DSCR = 2.52M / 5.99M = 0.42× — generalization-bite proof
  const noi = trace.contractedNoi!;
  const debtService75M = 5_989_160;
  const dscr75M = noi / debtService75M;
  assert(dscr75M < 1.25, `★ at $75M loan, contracted-NOI yields DSCR ${dscr75M.toFixed(2)}× — BELOW ai-prompts:24 1.25× threshold; verdict flips DECLINE (generalization bites)`);

  // Compare to what stabilized credit would have produced — orders of magnitude apart
  const stabilizedFantasy = 9_000_000;
  const ratio = noi / stabilizedFantasy;
  assert(ratio < 0.30, `★ contracted NOI is ${(ratio * 100).toFixed(0)}% of speculative stabilized projection — the doctrine refuses to credit unsigned space (was: ${ratio < 0.30 ? '< 30% — sharp drop confirmed' : '!! UNEXPECTED — sharp drop NOT observed'})`);
}

/* ============================ Summary ==================================== */
section('Summary');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
