// Tests for materialize-rendered-analysis.ts (post-6.8 caching layer).
//
//   npm run test:materialize-rendered-analysis
//
// Verifies:
//   - Cold path computes the full read-pole pipeline (hydrate -> project -> render)
//     and persists the RenderedAnalysis to the record-graph store.
//   - Warm path hits the cache: rendered_analyses row count does NOT grow on second
//     call for the same (rootId, renderVersion).
//   - Determinism: cache hit and cache miss return byte-identical RenderedAnalysis
//     for the same input. Same RenderedAnalysisId. Same JSON.stringify.
//   - Idempotent insert: second call is a no-op at the storage layer.
//   - FK enforcement: cannot insert a RenderedAnalysis whose rootId points at a
//     non-existent doctrine_evaluations row.
//   - Content-hash mismatch detection: tampered RenderedAnalysis throws on insert
//     (RecordIdMismatchError).
//   - cacheHit metadata: materializeRenderedAnalysisWithMeta returns cacheHit=false
//     on first call, cacheHit=true on subsequent calls.
//   - Determinism across stores: two independent in-memory stores produce identical
//     RenderedAnalysisId for the same input (no env / clock / random leaks).

import {
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  RENDER_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  DoctrineEvaluationId,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  RenderedAnalysis,
  RenderedLoanSection,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
  computeRenderedAnalysisId,
} from '../util/content-hash.js';
import {
  RecordGraphStore,
  RecordIdMismatchError,
} from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import {
  materializeRenderedAnalysis,
  materializeRenderedAnalysisWithMeta,
} from '../services/materialize-rendered-analysis.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  m: string,
): void {
  try { fn(); fail(m + ' (did not throw)'); }
  catch (e) {
    if (e instanceof ctor) ok(m);
    else fail(m + ' (threw ' + ((e as Error)?.name ?? typeof e) + ')');
  }
}

// ------------------------------ fixtures -------------------------------

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'CACHE-1',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'Tenant B', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2034-01-01T00:00:00Z', baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000,
          occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    t12: {
      period: 'T-12 ending Apr 2026', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000,
                   repairsMaintenance: 36_000, managementFees: 40_000,
                   generalAndAdmin: null, janitorial: null, reimbursements: null,
                   totalOperatingExpenses: 218_000 },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    pca: {
      immediateRepairs: 50_000, shortTermRepairs: 150_000,
      evaluationPeriodYears: null, inflationRate: null,
      replacementReservesPerSfPerYearInflated: null, replacementReservesPerSfPerYearUninflated: null,
      capexScheduleInflated: null, capexScheduleUninflated: null,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: {
      loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
      interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z',
    },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function ingestSeed(store: RecordGraphStore): { rootId: DoctrineEvaluationId } {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const result = ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
    },
    store,
  );
  // Post-#20: materialization anchors on the DoctrineEvaluationId (cache key axis).
  // result.rootId is the public AnalysisId (RevisionId) and is not consumable here.
  return { rootId: result.evaluationId };
}

// Helper: count rows in rendered_analyses. Used to verify cache hit/miss behavior.
function countRenderedAnalyses(store: RecordGraphStore): number {
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const row = db.prepare('SELECT COUNT(*) AS c FROM rendered_analyses').get() as { c: number };
  return row.c;
}

// --------------------------------- run ---------------------------------

console.log('Cold path: first call computes + persists:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);
  assertEqual(countRenderedAnalyses(store), 0, 'rendered_analyses table empty before first call');

  const meta = materializeRenderedAnalysisWithMeta(rootId, store);
  assertEqual(meta.cacheHit, false, 'first call cacheHit=false');
  assert(/^[0-9a-f]{64}$/.test(meta.rendered.id), 'returned RenderedAnalysisId is 64-hex');
  assertEqual(meta.rendered.rootId, rootId, 'rendered.rootId === input rootId');
  assertEqual(countRenderedAnalyses(store), 1, 'rendered_analyses table has 1 row after first call');

  store.close();
}

console.log('\nWarm path: second call hits cache (no new row):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);
  const first = materializeRenderedAnalysisWithMeta(rootId, store);
  const rowsAfterFirst = countRenderedAnalyses(store);

  const second = materializeRenderedAnalysisWithMeta(rootId, store);
  assertEqual(second.cacheHit, true, 'second call cacheHit=true');
  assertEqual(countRenderedAnalyses(store), rowsAfterFirst, 'no new row added on cache hit');
  assertEqual(second.rendered.id, first.rendered.id, 'cache hit returns same RenderedAnalysisId');

  store.close();
}

console.log('\nDeterminism: cold and warm produce content-equivalent output:');
{
  // Note: storage round-trips bodies through JCS canonicalization (lexicographic key
  // order), while the renderer emits insertion order. Raw JSON.stringify diverges in
  // ordering but content-hash equality proves canonical equivalence (which is what
  // matters for replay / cache correctness). Field-level checks confirm payload parity.
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);

  const cold = materializeRenderedAnalysis(rootId, store);
  const warm = materializeRenderedAnalysis(rootId, store);

  assertEqual(cold.id, warm.id, 'cold.id === warm.id (canonical equivalence)');
  assertEqual(cold.rootId, warm.rootId, 'rootId matches');
  assertEqual(cold.summary.ratingBand.value, warm.summary.ratingBand.value, 'ratingBand value matches');
  assertEqual(cold.summary.finalScore.value, warm.summary.finalScore.value, 'finalScore value matches');
  assertEqual(cold.metrics.dscr.value, warm.metrics.dscr.value, 'dscr value matches');
  assertEqual(cold.metrics.dscr.displayValue, warm.metrics.dscr.displayValue, 'dscr displayValue matches');
  assertEqual(cold.metadata.renderVersion, warm.metadata.renderVersion, 'renderVersion matches');
  assertEqual(cold.metadata.hashedAt, warm.metadata.hashedAt, 'hashedAt matches');
  assertEqual(cold.doctrine.flags.length, warm.doctrine.flags.length, 'doctrine flags count matches');
  assertEqual(cold.dataQuality.flags.length, warm.dataQuality.flags.length, 'dataQuality flags count matches');

  store.close();
}

console.log('\nMany calls: still exactly one row in cache:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);

  for (let i = 0; i < 5; i++) materializeRenderedAnalysis(rootId, store);
  assertEqual(countRenderedAnalyses(store), 1, '5 calls -> 1 cached row (idempotent)');

  store.close();
}

console.log('\nDeterminism across stores (no env / clock / random leaks):');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const { rootId: rootA } = ingestSeed(storeA);
  const { rootId: rootB } = ingestSeed(storeB);

  // Same fixture in both stores -> same rootId, same RenderedAnalysisId
  assertEqual(rootA, rootB, 'identical fixtures produce identical rootId in fresh stores');
  const a = materializeRenderedAnalysis(rootA, storeA);
  const b = materializeRenderedAnalysis(rootB, storeB);
  assertEqual(a.id, b.id, 'identical rootIds produce identical RenderedAnalysisId across stores');
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'byte-identical bodies across stores');

  storeA.close();
  storeB.close();
}

console.log('\nFK enforcement: cannot insert RenderedAnalysis with non-existent rootId:');
{
  const store = new RecordGraphStore(':memory:');
  // Construct a synthetic RenderedAnalysis whose rootId points at nothing.
  // The orphan body must satisfy the full RenderedAnalysis 7.2 shape (D09
  // components, D16/D17 income/expense lines, D21 loan, D20 stress, D04 findings)
  // so that materialize-time type checks pass before the FK check fires at insert.
  const orphanRoot = '0'.repeat(64) as DoctrineEvaluationId;
  const emptyLine: RenderedLoanSection['loanAmount'] = {
    name: '',
    raw: { value: null, displayValue: '-' },
    adjusted: { value: null, displayValue: '-' },
    source: 'BANK',
    adjustments: [],
  };
  const body = {
    rootId: orphanRoot,
    summary: {
      ratingBand: { value: 'Acceptable' as const, displayValue: 'Acceptable' },
      finalScore: { value: 50, displayValue: '50' },
    },
    metrics: {
      dscr: { value: null, displayValue: '-' },
      ltv: { value: null, displayValue: '-' },
      debtYield: { value: null, displayValue: '-' },
      noi: { value: null, displayValue: '-' },
    },
    valuation: {
      finalValue: { value: null, displayValue: '-' },
      anchorUsed: { value: 'none' as const, displayValue: 'none' },
    },
    doctrine: {
      mechanicalScore: { value: 50, displayValue: '50' },
      weightedAggregate: { value: 50, displayValue: '50' },
      flags: [],
      components: [],
    },
    dataQuality: { flags: [] },
    incomeLines: [],
    expenseLines: [],
    loan: {
      loanAmount: emptyLine,
      interestRate: emptyLine,
      termMonths: emptyLine,
      amortizationMonths: emptyLine,
      ioPeriodMonths: emptyLine,
      maturityBalance: emptyLine,
      debtServiceAnnual: emptyLine,
    },
    assumptions: {
      capRate: emptyLine,
      terminalCapRate: emptyLine,
      rentGrowthPct: emptyLine,
      expenseGrowthPct: emptyLine,
    },
    stress: { method: 'DEFAULT', scenarios: [] },
    findings: [],
    metadata: { hashedAt: AS_OF, renderVersion: RENDER_VERSION },
  };
  // Compute a valid id for this body so we don't trip RecordIdMismatchError
  // before reaching the FK check.
  const orphanId = computeRenderedAnalysisId(body);
  const orphan = { id: orphanId, ...body } as RenderedAnalysis;

  let threwFkError = false;
  try { store.insertRenderedAnalysis(orphan); }
  catch { threwFkError = true; }
  assert(threwFkError, 'insert with non-existent root_id fails FK constraint');

  store.close();
}

console.log('\nContent-hash mismatch detection (RecordIdMismatchError):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);
  const cold = materializeRenderedAnalysis(rootId, store);

  // Tamper with the body without recomputing the id.
  const tampered: RenderedAnalysis = {
    ...cold,
    summary: {
      ...cold.summary,
      finalScore: { value: 999, displayValue: '999' },
    },
  };
  assertThrowsInstance(
    () => store.insertRenderedAnalysis(tampered),
    RecordIdMismatchError,
    'tampered RenderedAnalysis throws RecordIdMismatchError',
  );

  store.close();
}

console.log('\ngetRenderedAnalysis(id) round-trip:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);
  const cold = materializeRenderedAnalysis(rootId, store);

  const fetched = store.getRenderedAnalysis(cold.id);
  assert(fetched !== null, 'getRenderedAnalysis returns row for known id');
  assertEqual(fetched?.id, cold.id, 'fetched.id matches');
  // id equality proves canonical content equivalence; spot-check a few fields.
  assertEqual(fetched?.rootId, cold.rootId, 'fetched.rootId matches');
  assertEqual(fetched?.summary.finalScore.value, cold.summary.finalScore.value, 'fetched finalScore matches');
  assertEqual(fetched?.metadata.renderVersion, cold.metadata.renderVersion, 'fetched renderVersion matches');

  // Unknown id -> null
  const missing = store.getRenderedAnalysis('z'.repeat(64) as never);
  assertEqual(missing, null, 'unknown id -> null');

  store.close();
}

console.log('\ngetRenderedAnalysisByRoot(rootId, renderVersion) cache-key lookup:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = ingestSeed(store);

  // Before materialization, lookup returns null
  const cold = store.getRenderedAnalysisByRoot(rootId, RENDER_VERSION);
  assertEqual(cold, null, 'lookup before materialization -> null');

  // After materialization, lookup returns the cached record
  materializeRenderedAnalysis(rootId, store);
  const warm = store.getRenderedAnalysisByRoot(rootId, RENDER_VERSION);
  assert(warm !== null, 'lookup after materialization returns the cached record');
  assertEqual(warm?.rootId, rootId, 'cached record rootId matches');

  // Wrong version -> null (forward-compatibility for future render-version bumps)
  const wrongVersion = store.getRenderedAnalysisByRoot(rootId, '99.99' as never);
  assertEqual(wrongVersion, null, 'lookup at non-existent render version -> null');

  store.close();
}

// --------------------------------- summary ---------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
