/**
 * Integration test — evaluateAndNarrate end-to-end (Piece A Phase 1 batch 2).
 *
 *   npm run test:evaluate-and-narrate
 *
 * Exercises the coupled wrapper at the service boundary:
 *   - evaluateAndNarrate runs the producer-tail (HE + DE + siblings) AND
 *     buildNarrative, persisting all of the above to an in-memory store.
 *   - LLM is mocked via the deps.llmCall seam so the test is deterministic
 *     and Anthropic-API-free.
 *   - Verifies the full materialize pipeline: ingest → evaluateAndNarrate →
 *     latest narrative + RA cache key + RenderedNarrativeSection.
 *
 * Scope (verifies six contracts):
 *   1. evaluateAndNarrate persists HE + Narrative + DoctrineEvaluation rows
 *      with the correct FK shape.
 *   2. Narrative.handbookEvaluationId references the HE just inserted.
 *   3. Narrative.executiveSummary === stub output.
 *   4. Idempotency: second call with same input → no-op (same content-hash
 *      ids; ON CONFLICT DO NOTHING).
 *   5. materializeRenderedAnalysis includes the narrative section.
 *   6. Cache staleness gate: re-narrate (different stub) → re-materialize →
 *      different RenderedAnalysisId, cache produces fresh prose, no
 *      stale-render leak.
 *
 * Fixtures: reuses test-ingest-pipeline.ts's library / benchmarks / manifesto
 * shape via inline minimal builders (duplicating, not coupling).
 */

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  NARRATIVE_ENGINE_VERSION,
  RENDER_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  NarrativeEvaluation,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { materializeRenderedAnalysis } from '../services/materialize-rendered-analysis.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

const AS_OF = '2026-05-29T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------------ fixtures ------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'EVAL-NARRATE-1',
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

const STUB_OUTPUT_A = 'Test exec summary A — deterministic prose for batch-2 integration test.';
const STUB_OUTPUT_B = 'Test exec summary B — different prose to verify cache-staleness gate.';

function makeStub(output: string): LLMCallFn {
  return async () => output;
}

/* --------------------------------- run --------------------------------- */

(async () => {

console.log('Seed + evaluateAndNarrate end-to-end:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  // Ingest using stub LLM A — exercises full write path (ingestExtractionResult
  // calls evaluateAndNarrate internally).
  const ingest = await ingestExtractionResult(
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
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );

  // 1. HE row persisted
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId);
  assert(doctrine !== null, 'doctrine evaluation persisted');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(doctrine!.adjustedInputsId);
  assert(he !== null, 'HandbookEvaluation persisted as sibling');

  // 2. Narrative row persisted with correct FK shape
  const narrative = store.getLatestNarrativeForAdjustedInputs(
    doctrine!.adjustedInputsId,
    NARRATIVE_ENGINE_VERSION,
  );
  assert(narrative !== null, 'NarrativeEvaluation persisted');
  assertEqual(narrative?.adjustedInputsId, doctrine!.adjustedInputsId, 'narrative.adjustedInputsId == HE.adjustedInputsId (sibling FK)');
  assertEqual(narrative?.handbookEvaluationId, he!.id, 'narrative.handbookEvaluationId references the consumed HE');
  assertEqual(narrative?.engineVersion, NARRATIVE_ENGINE_VERSION, 'narrative.engineVersion stamped from contract constant');

  // 3. Stub output preserved
  assertEqual(narrative?.executiveSummary, STUB_OUTPUT_A, 'narrative.executiveSummary === stub LLM output');

  store.close();
}

console.log('\nIdempotency — second ingest with same inputs and stub → no-op:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const stub = makeStub(STUB_OUTPUT_A);
  const args = {
    extractionResult: makeFullExtraction(),
    propertyType: 'Office' as AssetType,
    marketLiquidityHint: 'Primary' as const,
    librarySnapshotId: lib.id,
    marketBenchmarks: makeBenchmarks(),
    creditManifesto: makeManifesto(),
    analysisAsOfDate: AS_OF,
  };
  const r1 = await ingestExtractionResult(args, store, { llmCall: stub });
  const r2 = await ingestExtractionResult(args, store, { llmCall: stub });
  assertEqual(r1.rootId, r2.rootId, 'same rootId across calls (idempotency-via-content-hash)');
  assertEqual(r1.evaluationId, r2.evaluationId, 'same evaluationId');
  // Narrative content-hash matches → ON CONFLICT skipped the second insert.
  // Confirm by reading "all narratives for this AI" and asserting length is 1.
  const doctrine = store.getDoctrineEvaluation(r1.evaluationId)!;
  const all = store.getNarrativesForAdjustedInputs(doctrine.adjustedInputsId);
  assertEqual(all.length, 1, 'exactly one narrative row across two ingests (deterministic stub → same id → ON CONFLICT DO NOTHING)');
  store.close();
}

console.log('\nDirect call to evaluateAndNarrate exposes wrapper return shape:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  // Use ingest to seed the dependencies so we can directly call evaluateAndNarrate
  // on the prepared inputs (mirrors how the write-path orchestrators call it
  // internally — same args shape).
  const ingest = await ingestExtractionResult(
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
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId)!;
  const assetProfile = store.getAssetProfile(doctrine.assetProfileId)!;
  const adjustedInputs = store.getAdjustedInputs(doctrine.adjustedInputsId)!;
  const librarySnapshot = store.getLibrarySnapshot(doctrine.librarySnapshotId)!;
  const narrativeFacts = store.getNarrativeFacts(doctrine.narrativeFactsId)!;

  // Direct invocation: every field on EvaluateAndNarrateResult is populated.
  const result = await evaluateAndNarrate(
    {
      adjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      extractionResultId: doctrine.extractionResultId,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
    },
    store,
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );
  assert(result.evaluation !== undefined, 'wrapper returns evaluation');
  assert(result.handbookEvaluation !== undefined, 'wrapper returns handbookEvaluation');
  assert(result.narrative !== undefined, 'wrapper returns narrative');
  assertEqual(result.narrative.handbookEvaluationId, result.handbookEvaluation.id, 'narrative.handbookEvaluationId === HE.id from same call');

  store.close();
}

console.log('\nmaterialize includes the narrative section:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingest = await ingestExtractionResult(
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
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );

  const rendered = materializeRenderedAnalysis(ingest.evaluationId, store);
  assert(rendered.narrative !== null, 'RenderedAnalysis.narrative populated');
  assertEqual(rendered.narrative?.executiveSummary, STUB_OUTPUT_A, 'rendered narrative carries stub prose');
  assertEqual(rendered.narrative?.engineVersion, NARRATIVE_ENGINE_VERSION, 'rendered narrative carries engine version');
  assertEqual(rendered.metadata.renderVersion, RENDER_VERSION, 'render version is current (7.5)');

  store.close();
}

console.log('\nCache-key staleness gate (Q-R3 (p)) — re-narrate produces fresh render:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  // Ingest with stub A; materialize; capture id.
  const ingest = await ingestExtractionResult(
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
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );
  const renderedA = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedA.narrative?.executiveSummary, STUB_OUTPUT_A, 'first materialize: stub A prose');

  // Directly add a SECOND narrative with different prose (stub B) — simulates
  // a re-narrate or LLM re-run. The store's insertNarrative handles distinct
  // content-hash ids fine; getLatestNarrativeForAdjustedInputs returns the newer.
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId)!;
  const assetProfile = store.getAssetProfile(doctrine.assetProfileId)!;
  const adjustedInputs = store.getAdjustedInputs(doctrine.adjustedInputsId)!;
  const librarySnapshot = store.getLibrarySnapshot(doctrine.librarySnapshotId)!;
  const narrativeFacts = store.getNarrativeFacts(doctrine.narrativeFactsId)!;
  // Force created_at to differ so the new narrative wins the latest-by-created_at race.
  const t0 = Date.now();
  while (Date.now() === t0) { /* spin */ }
  await evaluateAndNarrate(
    {
      adjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      extractionResultId: doctrine.extractionResultId,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
    },
    store,
    { llmCall: makeStub(STUB_OUTPUT_B) },
  );

  // Re-materialize: cache lookup uses the NEW narrativeId → miss → fresh render.
  const renderedB = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedB.narrative?.executiveSummary, STUB_OUTPUT_B, 'second materialize: stub B prose (cache-staleness gate fired)');
  if (renderedA.id === renderedB.id) {
    fail('cache returned stale render: same RenderedAnalysisId despite different narrative');
  } else {
    ok('different narrative → different RenderedAnalysisId (content-determinism holds)');
  }

  // Verify two rendered_analyses rows now exist (one per narrative).
  const counts = (store as unknown as { db: { prepare: (q: string) => { get: (...args: unknown[]) => { c: number } } } })
    .db.prepare('SELECT COUNT(*) AS c FROM rendered_analyses WHERE root_id = ?').get(ingest.evaluationId);
  assertEqual(counts.c, 2, 'two rendered_analyses rows: one per distinct narrative content-hash');

  store.close();
}

console.log('\nLast-narrative wins — getLatestNarrative returns newest by created_at:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingest = await ingestExtractionResult(
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
    { llmCall: makeStub(STUB_OUTPUT_A) },
  );
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId)!;
  const firstLatest = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assertEqual(firstLatest?.executiveSummary, STUB_OUTPUT_A, 'first latest = stub A');

  // Compose second narrative with B
  const assetProfile = store.getAssetProfile(doctrine.assetProfileId)!;
  const adjustedInputs = store.getAdjustedInputs(doctrine.adjustedInputsId)!;
  const librarySnapshot = store.getLibrarySnapshot(doctrine.librarySnapshotId)!;
  const narrativeFacts = store.getNarrativeFacts(doctrine.narrativeFactsId)!;
  const t0 = Date.now();
  while (Date.now() === t0) { /* spin */ }
  await evaluateAndNarrate(
    {
      adjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      extractionResultId: doctrine.extractionResultId,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
    },
    store,
    { llmCall: makeStub(STUB_OUTPUT_B) },
  );
  const secondLatest = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assertEqual(secondLatest?.executiveSummary, STUB_OUTPUT_B, 'second latest = stub B (newest by created_at)');

  store.close();
}

/* --------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });

// Mark NarrativeEvaluation usage so type-only import isn't elided
const _: NarrativeEvaluation | null = null;
void _;
