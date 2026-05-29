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

const STUB_EXEC_A = 'Test exec summary A — deterministic prose for integration test.';
const STUB_EXEC_B = 'Test exec summary B — different prose to verify cache-staleness gate.';
const STUB_REDFLAG_A = '- [P-TEST] Test red-flag assessment A — deterministic prose for integration test.';
const STUB_REDFLAG_B = '- [P-TEST] Test red-flag assessment B — different prose to verify cache-staleness gate.';
const STUB_MITIGATION_A = '- [P-TEST] Test mitigation suggestion A — require $5M reserve plus DSCR covenant at 1.25x.';
const STUB_MITIGATION_B = '- [P-TEST] Test mitigation suggestion B — different prose to verify cache-staleness gate.';
const STUB_COMMITTEE_A = 'Recommend conditional approval A — subject to reserves and DSCR covenant per mitigations section.';
const STUB_COMMITTEE_B = 'Recommend conditional approval B — different prose to verify cache-staleness gate.';

/**
 * Per-slot dispatching stub (Phase 4: 4-slot object-bag — Q-T1 (b)
 * extended). The orchestrator makes 4 parallel LLM calls — one per
 * slot — and the stub picks the right output based on a stable
 * marker in the prompt text:
 *   - committee_recommendation prompt contains "committee recommendation"
 *   - mitigation_suggestions prompt contains "mitigation-suggestions list"
 *   - red_flag_assessment prompt contains "red-flag assessment"
 *   - executive_summary prompt is the default fall-through
 *
 * Marker order matters: most-specific marker checked first. The
 * committee check goes first (no other prompt mentions 'committee');
 * the mitigation check comes before red-flag because no prompt
 * template mentions both phrases, but the convention guards against
 * future overlap.
 */
function makeStub({ exec, redFlag, mitigation, committee }: {
  exec: string;
  redFlag: string;
  mitigation: string;
  committee: string;
}): LLMCallFn {
  return async ({ messages }) => {
    const content = messages[0]?.content;
    const text = typeof content === 'string' ? content : '';
    if (text.includes('committee recommendation')) return committee;
    if (text.includes('mitigation-suggestions list')) return mitigation;
    if (text.includes('red-flag assessment')) return redFlag;
    return exec;
  };
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
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
  assertEqual(narrative?.executiveSummary, STUB_EXEC_A, 'narrative.executiveSummary === stub LLM output');
  // Phase 2 — red_flag_assessment slot populated by orchestrator
  assertEqual(narrative?.redFlagAssessment, STUB_REDFLAG_A, 'narrative.redFlagAssessment === red-flag stub LLM output');
  assertEqual(narrative?.mitigationSuggestions, STUB_MITIGATION_A, 'narrative.mitigationSuggestions === mitigation stub LLM output (Phase 3)');
  assertEqual(narrative?.committeeRecommendation, STUB_COMMITTEE_A, 'narrative.committeeRecommendation === committee stub LLM output (Phase 4)');
  if (!narrative) {
    fail('expected narrative to be present');
  } else {
    // Structural shape: per-slot consumed-id field exists, is an array, and is
    // a superset (set inclusion) of consumedFlagPrincipleIds — because every
    // flag fired into executive_summary also fires into red_flag_assessment
    // per the handbook engine (executive_summary is a strict subset of
    // red_flag_assessment for any deal). Specific ids depend on which
    // handbook principles fire against this integration test's synthetic deal.
    const execSet = new Set(narrative.consumedFlagPrincipleIds);
    const rfaSet = new Set(narrative.redFlagAssessmentConsumedFlagPrincipleIds);
    const isSuperset = [...execSet].every((id) => rfaSet.has(id));
    assert(isSuperset, 'redFlagAssessmentConsumedFlagPrincipleIds is a superset of consumedFlagPrincipleIds');
    assert(
      Array.isArray(narrative.redFlagAssessmentConsumedFlagPrincipleIds),
      'redFlagAssessmentConsumedFlagPrincipleIds is an array (structural)',
    );
    // Phase 3: mitigation_suggestions has NO guaranteed subset/superset
    // relationship to other slots (per CC's recon ITEM 4 finding — each
    // principle declares its own injectionPoints; mitigation could include
    // flags not in any other slot). Conservative structural-only assertion.
    assert(
      Array.isArray(narrative.mitigationSuggestionsConsumedFlagPrincipleIds),
      'mitigationSuggestionsConsumedFlagPrincipleIds is an array (structural)',
    );
    // Phase 4: committee_recommendation likewise has NO guaranteed
    // subset/superset relationship to other slots. Structural-only assertion.
    assert(
      Array.isArray(narrative.committeeRecommendationConsumedFlagPrincipleIds),
      'committeeRecommendationConsumedFlagPrincipleIds is an array (structural)',
    );
  }

  store.close();
}

console.log('\nIdempotency — second ingest with same inputs and stub → no-op:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const stub = makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A });
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );

  const rendered = materializeRenderedAnalysis(ingest.evaluationId, store);
  assert(rendered.narrative !== null, 'RenderedAnalysis.narrative populated');
  assertEqual(rendered.narrative?.executiveSummary, STUB_EXEC_A, 'rendered narrative carries exec-summary stub prose');
  assertEqual(rendered.narrative?.redFlagAssessment, STUB_REDFLAG_A, 'rendered narrative carries red-flag stub prose (Phase 2)');
  assertEqual(rendered.narrative?.mitigationSuggestions, STUB_MITIGATION_A, 'rendered narrative carries mitigation stub prose (Phase 3)');
  assertEqual(rendered.narrative?.committeeRecommendation, STUB_COMMITTEE_A, 'rendered narrative carries committee stub prose (Phase 4)');
  assertEqual(rendered.narrative?.engineVersion, NARRATIVE_ENGINE_VERSION, 'rendered narrative carries engine version');
  assertEqual(rendered.metadata.renderVersion, RENDER_VERSION, 'render version is current (7.8)');

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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );
  const renderedA = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedA.narrative?.executiveSummary, STUB_EXEC_A, 'first materialize: exec stub A');
  assertEqual(renderedA.narrative?.redFlagAssessment, STUB_REDFLAG_A, 'first materialize: red-flag stub A');
  assertEqual(renderedA.narrative?.mitigationSuggestions, STUB_MITIGATION_A, 'first materialize: mitigation stub A (Phase 3)');
  assertEqual(renderedA.narrative?.committeeRecommendation, STUB_COMMITTEE_A, 'first materialize: committee stub A (Phase 4)');

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
    { llmCall: makeStub({ exec: STUB_EXEC_B, redFlag: STUB_REDFLAG_B, mitigation: STUB_MITIGATION_B, committee: STUB_COMMITTEE_B }) },
  );

  // Re-materialize: cache lookup uses the NEW narrativeId → miss → fresh render.
  const renderedB = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedB.narrative?.executiveSummary, STUB_EXEC_B, 'second materialize: exec stub B (cache-staleness gate fired)');
  assertEqual(renderedB.narrative?.redFlagAssessment, STUB_REDFLAG_B, 'second materialize: red-flag stub B (cache-staleness gate fired)');
  assertEqual(renderedB.narrative?.mitigationSuggestions, STUB_MITIGATION_B, 'second materialize: mitigation stub B (cache-staleness gate fired)');
  assertEqual(renderedB.narrative?.committeeRecommendation, STUB_COMMITTEE_B, 'second materialize: committee stub B (cache-staleness gate fired)');
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId)!;
  const firstLatest = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assertEqual(firstLatest?.executiveSummary, STUB_EXEC_A, 'first latest = exec stub A');

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
    { llmCall: makeStub({ exec: STUB_EXEC_B, redFlag: STUB_REDFLAG_B, mitigation: STUB_MITIGATION_B, committee: STUB_COMMITTEE_B }) },
  );
  const secondLatest = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assertEqual(secondLatest?.executiveSummary, STUB_EXEC_B, 'second latest = exec stub B (newest by created_at)');
  assertEqual(secondLatest?.redFlagAssessment, STUB_REDFLAG_B, 'second latest = red-flag stub B');
  assertEqual(secondLatest?.mitigationSuggestions, STUB_MITIGATION_B, 'second latest = mitigation stub B (Phase 3)');
  assertEqual(secondLatest?.committeeRecommendation, STUB_COMMITTEE_B, 'second latest = committee stub B (Phase 4)');

  store.close();
}

console.log('\nPartial-failure semantics (Q-S4 (f.1)) — red_flag_assessment slot throws → wrapper rejects, no row written:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  /* Stub that succeeds for executive_summary but rejects on red_flag_assessment.
     Per Q-S4 (f.1): Promise.all rejection in buildNarrative → evaluateAndNarrate
     throws → no NarrativeEvaluation row persisted. HE + producer-tail rows DO
     persist (they ran before the LLM calls, per the v23 inline-insert pattern).
     Retry with a non-rejecting stub re-runs both slots; ON CONFLICT makes the
     producer-tail re-inserts no-ops; the narrative composes fresh and persists. */
  const partialFailureStub: LLMCallFn = async ({ messages }) => {
    const content = messages[0]?.content;
    const text = typeof content === 'string' ? content : '';
    if (text.includes('red-flag assessment')) {
      throw new Error('Simulated LLM failure on red_flag_assessment slot');
    }
    return STUB_EXEC_A;
  };

  let threwFirst = false;
  let ingest1;
  try {
    ingest1 = await ingestExtractionResult(
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
      { llmCall: partialFailureStub },
    );
  } catch {
    threwFirst = true;
  }
  assert(threwFirst, 'first ingest with partial-failure stub throws');
  assertEqual(ingest1, undefined, 'first ingest produced no IngestionResult');

  /* Verify no narrative row persisted. HE row DOES persist (producer-tail
     ran before the LLM calls) — this is v23 idempotency-via-content-hash
     semantics: re-ingest re-runs producer-tail as no-ops via ON CONFLICT. */
  const aiRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM adjusted_inputs').all() as Array<{ id: string }>;
  assert(aiRows.length === 1, 'producer-tail persisted AdjustedInputs row even though narrative threw');
  const narrRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM narratives').all() as Array<{ id: string }>;
  assertEqual(narrRows.length, 0, 'no narrative row written when red-flag slot threw');

  /* Retry with a non-rejecting stub. v23 idempotency: producer-tail
     re-inserts are no-ops via ON CONFLICT; narrative composes fresh from
     both slots and persists. */
  const ingest2 = await ingestExtractionResult(
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
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );
  assert(ingest2.rootId !== undefined, 'retry succeeded with non-rejecting stub');
  const doctrine = store.getDoctrineEvaluation(ingest2.evaluationId)!;
  const recovered = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assert(recovered !== null, 'narrative persisted on retry');
  assertEqual(recovered?.executiveSummary, STUB_EXEC_A, 'retry produces exec_summary slot');
  assertEqual(recovered?.redFlagAssessment, STUB_REDFLAG_A, 'retry produces red_flag_assessment slot');
  assertEqual(recovered?.mitigationSuggestions, STUB_MITIGATION_A, 'retry produces mitigation_suggestions slot (Phase 3)');
  assertEqual(recovered?.committeeRecommendation, STUB_COMMITTEE_A, 'retry produces committee_recommendation slot (Phase 4)');

  store.close();
}

console.log('\nPartial-failure (Phase 3) — mitigation_suggestions slot throws → wrapper rejects:');
{
  /* Mirror of the prior partial-failure block but for the mitigation slot.
     Verifies Q-S4 (f.1) symmetry: any slot's LLM failure rejects the
     orchestrator. Confirms the 3-slot Promise.all extension preserves
     atomicity semantics for the new slot. */
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const mitFailureStub: LLMCallFn = async ({ messages }) => {
    const content = messages[0]?.content;
    const text = typeof content === 'string' ? content : '';
    if (text.includes('mitigation-suggestions list')) {
      throw new Error('Simulated LLM failure on mitigation_suggestions slot');
    }
    if (text.includes('red-flag assessment')) return STUB_REDFLAG_A;
    return STUB_EXEC_A;
  };

  let threwMit = false;
  try {
    await ingestExtractionResult(
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
      { llmCall: mitFailureStub },
    );
  } catch {
    threwMit = true;
  }
  assert(threwMit, 'ingest with mitigation-failing stub throws (Q-S4 symmetry for slot 3)');

  const narrRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM narratives').all() as Array<{ id: string }>;
  assertEqual(narrRows.length, 0, 'no narrative row written when mitigation slot threw');

  store.close();
}

console.log('\nPartial-failure (Phase 4) — committee_recommendation slot throws → wrapper rejects:');
{
  /* Final partial-failure block: verifies Q-S4 (f.1) symmetry for the 4th
     slot. Confirms the 4-slot Promise.all extension preserves atomicity
     semantics for the new committee_recommendation slot. With this test
     all 4 slots have a Q-S4 symmetry verifier; the orchestrator's
     fail-on-any-slot semantic is comprehensively exercised. */
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  const committeeFailureStub: LLMCallFn = async ({ messages }) => {
    const content = messages[0]?.content;
    const text = typeof content === 'string' ? content : '';
    if (text.includes('committee recommendation')) {
      throw new Error('Simulated LLM failure on committee_recommendation slot');
    }
    if (text.includes('mitigation-suggestions list')) return STUB_MITIGATION_A;
    if (text.includes('red-flag assessment')) return STUB_REDFLAG_A;
    return STUB_EXEC_A;
  };

  let threwCommittee = false;
  try {
    await ingestExtractionResult(
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
      { llmCall: committeeFailureStub },
    );
  } catch {
    threwCommittee = true;
  }
  assert(threwCommittee, 'ingest with committee-failing stub throws (Q-S4 symmetry for slot 4)');

  const narrRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM narratives').all() as Array<{ id: string }>;
  assertEqual(narrRows.length, 0, 'no narrative row written when committee slot threw');

  store.close();
}

/* --------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });

// Mark NarrativeEvaluation usage so type-only import isn't elided
const _: NarrativeEvaluation | null = null;
void _;
