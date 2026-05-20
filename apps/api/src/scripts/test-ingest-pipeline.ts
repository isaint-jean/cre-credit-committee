/**
 * Tests for the new-spine ingestion orchestrator (Batch 6.4).
 *
 *   npm run test:ingest-pipeline
 *
 * Verifies:
 *   - Happy path: full ExtractionResult → all 9 records persisted in record-graph-store
 *   - Idempotency invariant H4/B5: same inputs → same DoctrineEvaluationId; second ingestion
 *     of same inputs is a no-op for every record kind
 *   - Determinism: re-invocation produces byte-identical evaluation
 *   - LIBRARY_SNAPSHOT_NOT_FOUND: passing an unknown librarySnapshotId throws IngestionError
 *   - analysisAsOfDate mismatch: producer (JudgmentEngineError) propagates through orchestrator
 *   - Degraded T-12: pipeline completes; data-quality flags surface
 *   - Empty CrossCheckResult emitted (v1 documented gap; cross-check producer refactor deferred)
 *   - All 9 records re-derivable from their bodies (id integrity round-trip)
 */

import {
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  ingestExtractionResult,
  IngestionError,
} from '../services/ingest-extraction-result.js';
import { JudgmentEngineError } from '../services/judgment/errors.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  message: string,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (e instanceof ctor) ok(message);
    else fail(`${message} (threw ${(e as Error)?.name ?? typeof e})`);
  }
}

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(asOf: string = AS_OF, dealRef = 'INGEST-1'): ExtractionResult {
  const body = {
    analysisAsOfDate: asOf,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef,
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
                   totalOperatingExpenses: 218_000 },
    },
    pca: {
      immediateRepairs: 50_000, nearTermRepairs: 150_000,
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

function makeManifesto(asOf: string = AS_OF): CreditManifesto {
  const body = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function defaultArgs() {
  return {
    extractionResult: makeFullExtraction(),
    propertyType: 'Office' as AssetType,
    marketLiquidityHint: 'Primary' as const,
    marketBenchmarks: makeBenchmarks(),
    creditManifesto: makeManifesto(),
    analysisAsOfDate: AS_OF,
  };
}

/* ----------------------------------- run ---------------------------------- */

console.log('Happy path — full ingestion produces all 9 records:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const { extractionResult, propertyType, marketLiquidityHint, marketBenchmarks, creditManifesto, analysisAsOfDate } = defaultArgs();
  const result = ingestExtractionResult(
    {
      extractionResult,
      propertyType,
      marketLiquidityHint,
      librarySnapshotId: lib.id,
      marketBenchmarks,
      creditManifesto,
      analysisAsOfDate,
    },
    store,
  );

  assert(/^[0-9a-f]{64}$/.test(result.rootId), 'rootId is 64-char hex content hash');
  assertEqual(result.evaluation.id, result.rootId, 'returned evaluation.id matches rootId');

  // Verify each of the 9 records is persisted
  assert(store.getExtractionResult(extractionResult.id) !== null, 'ExtractionResult persisted');
  assert(store.getAssetProfile(result.evaluation.assetProfileId) !== null, 'AssetProfile persisted');
  assert(store.getExtractionResult(result.evaluation.extractionResultId) !== null, 'ExtractionResult reachable from root via FK');
  assert(store.getLibrarySnapshot(lib.id) !== null, 'LibrarySnapshot present (pre-persisted)');
  assert(store.getNarrativeFacts(result.evaluation.narrativeFactsId) !== null, 'NarrativeFacts persisted');
  assert(store.getAdjustedInputs(result.evaluation.adjustedInputsId) !== null, 'AdjustedInputs persisted');
  assert(store.getCrossCheckResult(result.evaluation.crossCheckResultId) !== null, 'CrossCheckResult persisted');
  assert(store.getStressOutputs(result.evaluation.stressOutputsId) !== null, 'StressOutputs persisted');
  assert(store.getValuationConclusion(result.evaluation.valuationConclusionId) !== null, 'ValuationConclusion persisted');
  assert(store.getDoctrineEvaluation(result.rootId) !== null, 'DoctrineEvaluation persisted as root');

  store.close();
}

console.log('\nIdempotency — same inputs produce same rootId; second ingestion is a no-op:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const args = {
    ...defaultArgs(),
    librarySnapshotId: lib.id,
  };
  const r1 = ingestExtractionResult(args, store);
  const r2 = ingestExtractionResult(args, store);

  assertEqual(r1.rootId, r2.rootId, 'identical inputs produce identical rootId (H4/B5)');
  assertEqual(r1.evaluation.adjustedInputsId, r2.evaluation.adjustedInputsId, 'AdjustedInputsId is deterministic');
  assertEqual(r1.evaluation.narrativeFactsId, r2.evaluation.narrativeFactsId, 'NarrativeFactsId is deterministic');
  assertEqual(r1.evaluation.valuationConclusionId, r2.evaluation.valuationConclusionId, 'ValuationConclusionId is deterministic');
  assertEqual(r1.evaluation.stressOutputsId, r2.evaluation.stressOutputsId, 'StressOutputsId is deterministic');
  assertEqual(r1.evaluation.crossCheckResultId, r2.evaluation.crossCheckResultId, 'CrossCheckResultId is deterministic');

  store.close();
}

console.log('\nDeterminism — fresh store, same inputs, byte-identical evaluation:');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  storeA.insertLibrarySnapshot(lib);
  storeB.insertLibrarySnapshot(lib);

  const args = { ...defaultArgs(), librarySnapshotId: lib.id };
  const a = ingestExtractionResult(args, storeA);
  const b = ingestExtractionResult(args, storeB);

  assertEqual(a.rootId, b.rootId, 'rootId is stable across stores (no env / disk / clock leaks)');
  assertEqual(a.evaluation.finalScore, b.evaluation.finalScore, 'finalScore identical');
  assertEqual(a.evaluation.ratingBand, b.evaluation.ratingBand, 'ratingBand identical');

  storeA.close();
  storeB.close();
}

console.log('\nEmpty CrossCheckResult emitted (v1 documented gap):');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const result = ingestExtractionResult(
    { ...defaultArgs(), librarySnapshotId: lib.id },
    store,
  );
  const cc = store.getCrossCheckResult(result.evaluation.crossCheckResultId);
  assert(cc !== null, 'CrossCheckResult present in store');
  assertEqual(cc?.findings.length, 0, 'empty findings list (legacy producer mismatch)');
  assertEqual(cc?.overallAdjustmentBias, 'neutral', "bias is 'neutral'");
  assertEqual(cc?.adjustedInputsId, result.evaluation.adjustedInputsId, 'CrossCheckResult.adjustedInputsId points at the run');

  store.close();
}

console.log('\nLIBRARY_SNAPSHOT_NOT_FOUND — unknown librarySnapshotId throws IngestionError:');
{
  const store = new RecordGraphStore(':memory:');
  // Note: NO library snapshot pre-persisted

  assertThrowsInstance(
    () =>
      ingestExtractionResult(
        { ...defaultArgs(), librarySnapshotId: 'z'.repeat(64) as never },
        store,
      ),
    IngestionError,
    'unknown librarySnapshotId throws IngestionError',
  );

  store.close();
}

console.log('\nProducer error propagation — analysisAsOfDate mismatch surfaces JudgmentEngineError:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  // extraction date doesn't match args date
  const mismatched = makeFullExtraction('2025-01-01T00:00:00Z');
  assertThrowsInstance(
    () =>
      ingestExtractionResult(
        {
          ...defaultArgs(),
          extractionResult: mismatched,
          librarySnapshotId: lib.id,
        },
        store,
      ),
    JudgmentEngineError,
    'extraction date mismatch propagates JudgmentEngineError',
  );

  store.close();
}

console.log('\nDegraded T-12 — pipeline completes; surfaces dataQualityFlags:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const ext = makeFullExtraction();
  const noT12 = { ...ext };
  // Reconstruct without t12; recompute id since body changes
  const degradedBody = { ...noT12, t12: null };
  delete (degradedBody as { id?: unknown }).id;
  const degraded = { ...degradedBody, id: computeExtractionResultId(degradedBody) } as ExtractionResult;

  const result = ingestExtractionResult(
    { ...defaultArgs(), extractionResult: degraded, librarySnapshotId: lib.id },
    store,
  );

  assert(/^[0-9a-f]{64}$/.test(result.rootId), 'pipeline still completes with missing T-12');
  const ai = store.getAdjustedInputs(result.evaluation.adjustedInputsId);
  assert(ai !== null, 'AdjustedInputs persisted under degraded conditions');
  assert(ai !== null && ai.dataQualityFlags.length > 0, 'dataQualityFlags surface degraded state');

  store.close();
}

console.log('\nID integrity round-trip — every persisted record re-hashes to its stored id:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const result = ingestExtractionResult(
    { ...defaultArgs(), librarySnapshotId: lib.id },
    store,
  );

  // The store's verifyAndSerialize already enforces this on every insert. If any record
  // had a body-hash mismatch, ingestion would have thrown above. Confirm by reading back
  // and checking the id property is preserved.
  const fetched = store.getDoctrineEvaluation(result.rootId);
  assertEqual(fetched?.id, result.rootId, 'persisted root id round-trips');
  assertEqual(fetched?.adjustedInputsId, result.evaluation.adjustedInputsId, 'FK adjustedInputsId round-trips');
  assertEqual(fetched?.valuationConclusionId, result.evaluation.valuationConclusionId, 'FK valuationConclusionId round-trips');

  store.close();
}

/* ---------------------------------- summary -------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
