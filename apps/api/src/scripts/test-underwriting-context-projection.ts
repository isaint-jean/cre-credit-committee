// Tests for build-underwriting-context-projection.ts (Batch 6.6 - Stage 12 projection).
//
//   npm run test:underwriting-context-projection
//
// Verifies the locked projection invariants PJ1-PJ5:
//   - Round-trip: ingest -> hydrate -> project -> 9 records present, all identity-equal to bundle
//   - PJ1 bijection: every input record appears exactly once in output; output has no extra
//     records beyond the spec'd shape
//   - rootId passes through unchanged
//   - metadata.hydratedAt mirrors doctrineEvaluation.analysisAsOfDate (passthrough)
//   - metadata.projectionVersion is the literal '6.6'
//   - PJ4 determinism: two projections of same bundle -> byte-identical output
//   - PJ5 identity passthrough: each record reference is === the input record (not a clone)
//   - PJ3 no fallback synthesis: identity equality means no record was reconstructed
//   - PJ2 mode-invariance: signature is (input) only - no mode parameter

import {
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  PROJECTION_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  DoctrineEvaluationId,
  ExtractionResult,
  HydratedRecordGraph,
  LibrarySnapshot,
  MarketBenchmarks,
  UnderwritingContext,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { STUB_LLM_DEPS } from './_narrative-test-deps.js';
import { hydrateRecordGraph } from '../services/hydrate-record-graph.js';
import { buildUnderwritingContextProjection } from '../services/build-underwriting-context-projection.js';

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
    dealRef: 'PROJ-1',
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

async function ingestSeed(store: RecordGraphStore): Promise<{ rootId: DoctrineEvaluationId; bundle: HydratedRecordGraph }> {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const result = await ingestExtractionResult(
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
    STUB_LLM_DEPS,
  );
  // Post-#20: hydrate / projection anchor on the DoctrineEvaluationId, exposed
  // as result.evaluationId. result.rootId is the public AnalysisId (RevisionId).
  const bundle = hydrateRecordGraph(result.evaluationId, store);
  return { rootId: result.evaluationId, bundle };
}

// --------------------------------- run ---------------------------------

(async () => {

console.log('Round-trip: ingest -> hydrate -> project -> 9 records present:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });

  assert(ctx.doctrineEvaluation !== null, 'doctrineEvaluation present');
  assert(ctx.valuationConclusion !== null, 'valuationConclusion present');
  assert(ctx.stressOutputs !== null, 'stressOutputs present');
  assert(ctx.crossCheckResult !== null, 'crossCheckResult present');
  assert(ctx.adjustedInputs !== null, 'adjustedInputs present');
  assert(ctx.narrativeFacts !== null, 'narrativeFacts present');
  assert(ctx.librarySnapshot !== null, 'librarySnapshot present');
  assert(ctx.assetProfile !== null, 'assetProfile present');
  assert(ctx.extractionResult !== null, 'extractionResult present');

  store.close();
}

console.log('\nrootId passthrough:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  assertEqual(ctx.rootId, rootId, 'ctx.rootId === input rootId');

  store.close();
}

console.log('\nPJ5 identity passthrough: each output record === input record (no clone):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });

  assert(ctx.doctrineEvaluation === bundle.doctrineEvaluation, 'doctrineEvaluation reference identity');
  assert(ctx.valuationConclusion === bundle.valuationConclusion, 'valuationConclusion reference identity');
  assert(ctx.stressOutputs === bundle.stressOutputs, 'stressOutputs reference identity');
  assert(ctx.crossCheckResult === bundle.crossCheckResult, 'crossCheckResult reference identity');
  assert(ctx.adjustedInputs === bundle.adjustedInputs, 'adjustedInputs reference identity');
  assert(ctx.narrativeFacts === bundle.narrativeFacts, 'narrativeFacts reference identity');
  assert(ctx.librarySnapshot === bundle.librarySnapshot, 'librarySnapshot reference identity');
  assert(ctx.assetProfile === bundle.assetProfile, 'assetProfile reference identity');
  assert(ctx.extractionResult === bundle.extractionResult, 'extractionResult reference identity');

  store.close();
}

console.log('\nmetadata.hydratedAt mirrors doctrineEvaluation.analysisAsOfDate (passthrough):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  assertEqual(ctx.metadata.hydratedAt, bundle.doctrineEvaluation.analysisAsOfDate,
    'metadata.hydratedAt === doctrine.analysisAsOfDate');

  store.close();
}

console.log('\nmetadata.projectionVersion is the literal "6.6":');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  assertEqual(ctx.metadata.projectionVersion, '6.6', 'projectionVersion === "6.6"');
  assertEqual(ctx.metadata.projectionVersion, PROJECTION_VERSION, 'projectionVersion === PROJECTION_VERSION constant');

  store.close();
}

console.log('\nPJ4 determinism: same input -> byte-identical output:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const a = buildUnderwritingContextProjection({ rootId, graph: bundle });
  const b = buildUnderwritingContextProjection({ rootId, graph: bundle });
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'two projections of same input -> byte-identical');
}

console.log('\nPJ1 bijection: output has exactly the spec keys:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  const keys = Object.keys(ctx).sort();
  const expected = [
    'adjustedInputs',
    'assetProfile',
    'crossCheckResult',
    'doctrineEvaluation',
    'extractionResult',
    'librarySnapshot',
    'metadata',
    'narrativeFacts',
    'rootId',
    'stressOutputs',
    'valuationConclusion',
  ].sort();
  assertEqual(JSON.stringify(keys), JSON.stringify(expected), 'top-level keys match spec exactly');

  // metadata has exactly two keys
  const metaKeys = Object.keys(ctx.metadata).sort();
  assertEqual(JSON.stringify(metaKeys), JSON.stringify(['hydratedAt', 'projectionVersion']),
    'metadata has exactly hydratedAt + projectionVersion');

  store.close();
}

console.log('\nPJ3 no fallback synthesis: empty CrossCheckResult passes through unchanged:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);

  // Ingestion v1 emits an empty CrossCheckResult; projection must not synthesize anything
  // to "fix" that - it passes through whatever the bundle holds.
  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });
  assertEqual(ctx.crossCheckResult.findings.length, 0, 'empty findings preserved (not synthesized)');
  assertEqual(ctx.crossCheckResult.overallAdjustmentBias, 'neutral', 'neutral bias preserved');

  store.close();
}

console.log('\nPJ2 mode-invariance: signature is (input) only - no mode parameter:');
{
  // Function arity must be 1: takes the single ProjectionInput object.
  assertEqual(buildUnderwritingContextProjection.length, 1, 'arity === 1 (ProjectionInput only)');
}

console.log('\n9 contract record types tracked (record-count regression check):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, bundle } = await ingestSeed(store);
  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });

  const recordKeys: (keyof UnderwritingContext)[] = [
    'assetProfile',
    'extractionResult',
    'librarySnapshot',
    'adjustedInputs',
    'narrativeFacts',
    'crossCheckResult',
    'stressOutputs',
    'valuationConclusion',
    'doctrineEvaluation',
  ];
  assertEqual(recordKeys.length, 9, 'context exposes exactly 9 records');

  for (const k of recordKeys) {
    assert(ctx[k] !== undefined, k + ' is defined on the projection');
  }

  store.close();
}

// --------------------------------- summary ---------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

})().catch((e) => { console.error(e); process.exit(1); });
