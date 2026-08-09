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
  NARRATIVE_ENGINE_VERSION,
  RENDER_VERSION,
  SNAPSHOT_PRODUCER_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  NarrativeEvaluation,
} from '@cre/contracts';
import {
  AS_OF,
  makeBenchmarks,
  makeFullExtraction,
  makeManifesto,
  makeSnapshot,
} from './fixtures/office-deal-fixture.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { computeIngestFrontHalf, ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { computePreFlightReadiness } from '../services/pre-flight-readiness.service.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { materializeRenderedAnalysis } from '../services/materialize-rendered-analysis.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* Deal fixtures (makeFullExtraction / makeSnapshot / makeBenchmarks / makeManifesto)
   live in ./fixtures/office-deal-fixture.ts — SHARED with the build-and-ingest route
   suite's pre-flight preview test so both exercise the same deal. */

const STUB_EXEC_A = 'Test exec summary A — deterministic prose for integration test.';
const STUB_EXEC_B = 'Test exec summary B — different prose to verify cache-staleness gate.';
const STUB_REDFLAG_A = '- [P-TEST] Test red-flag assessment A — deterministic prose for integration test.';
const STUB_REDFLAG_B = '- [P-TEST] Test red-flag assessment B — different prose to verify cache-staleness gate.';
// Phase 1.5 (v1.5 narrative): mitigation_suggestions is now deterministic
// (rendered from MitigationProposalSet, no LLM call). The stub fields below
// are wired into makeStub for source compatibility but the produced narrative
// will carry the deterministic render — assertions are updated accordingly.
const STUB_MITIGATION_A = '(unused — slot is deterministic in v1.5)';
const STUB_MITIGATION_B = '(unused — slot is deterministic in v1.5)';
// v1.6 mitigation composition is the current producer path (single-pass
// de-levering + reconciliation). Reference the CURRENT header constant so the
// assertions track the source of truth rather than a stale hardcoded string.
import { MITIGATION_SUGGESTIONS_HEADER_V1_6 } from '../services/narrative/prompt-templates.js';
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
  // calls evaluateAndNarrate internally). Args hoisted so the pre-flight route
  // parity check below runs the SAME args the mint consumed.
  const mintArgs = {
    extractionResult: makeFullExtraction(),
    propertyType: 'Office' as AssetType,
    marketLiquidityHint: 'Primary' as const,
    librarySnapshotId: lib.id,
    marketBenchmarks: makeBenchmarks(),
    creditManifesto: makeManifesto(),
    analysisAsOfDate: AS_OF,
    rentRoll: null,
  };
  const ingest = await ingestExtractionResult(
    mintArgs,
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );

  // 0. Render-snapshot sibling row (PR i — read-instead-of-recompute foundation):
  // every NEW eval the pipeline produces MUST have a matching snapshot keyed on
  // its DoctrineEvaluationId. Forward-only — historical evals carry no snapshot.
  const snap0 = store.getDoctrineRenderSnapshot(ingest.evaluationId);
  assert(snap0 !== null, 'render snapshot persisted for new eval');
  assertEqual(snap0?.doctrineEvaluationId, ingest.evaluationId, 'snapshot.doctrineEvaluationId == new eval id');
  assertEqual(snap0?.snapshotProducerVersion, SNAPSHOT_PRODUCER_VERSION, 'snapshot.snapshotProducerVersion stamped from the contract constant');
  assert(snap0?.rating.recommendation !== undefined, 'snapshot.rating.recommendation populated');
  assert(typeof snap0?.authoritativeNumbers.stressedValue === 'number' || snap0?.authoritativeNumbers.stressedValue === null, 'snapshot.authoritativeNumbers.stressedValue persisted');
  assert(Object.keys(snap0?.dimOutputs ?? {}).length >= 1, 'snapshot.dimOutputs has at least one dim');

  // 1. HE row persisted
  const doctrine = store.getDoctrineEvaluation(ingest.evaluationId);
  assert(doctrine !== null, 'doctrine evaluation persisted');

  // 1b. PRE-FLIGHT ROUTE PARITY — the build-and-ingest `preview:true` seam derives
  // its verdict via computeIngestFrontHalf → computePreFlightReadiness (the SAME
  // shared front-half this mint ran + the SAME derived-verdict path the CLI uses).
  // Prove that chain, on the SAME args, is BYTE-IDENTICAL to what this real mint
  // just produced: the preview predicts the mint exactly, writing nothing here
  // (computePreFlightReadiness runs against its own throwaway :memory: scratch).
  {
    const fh = computeIngestFrontHalf(mintArgs, store);
    const readiness = await computePreFlightReadiness({
      extraction: mintArgs.extractionResult,
      adjustedInputs: fh.adjustedInputs,
      assetProfile: fh.assetProfile,
      librarySnapshot: fh.librarySnapshot,
      narrativeFacts: fh.narrativeFacts,
      propertyMetadata: fh.propertyMetadata,
      rentRoll: mintArgs.rentRoll,
      sourceDocumentKinds: (mintArgs.extractionResult.sourceDocuments ?? []).map((d) => d.kind),
    });
    assertEqual(readiness.verdict.finalScore, doctrine!.finalScore ?? null, '1b route-preview finalScore == minted finalScore (byte-identical)');
    assertEqual(readiness.verdict.recommendation, snap0!.rating.recommendation, '1b route-preview recommendation == minted');
    assertEqual(readiness.verdict.band, snap0!.rating.band ?? null, '1b route-preview band == minted');
    assertEqual(readiness.verdict.provisional, true, '1b route-preview verdict flagged PROVISIONAL (pre-mint)');
  }

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
  // v1.6 — mitigation_suggestions is deterministic (composed mitigants, single-
  // pass de-levering). The fixture's engine emits proposals (sub-1.0 DSCR + high
  // rollover); the slot carries the v1.6 header + sized figures, not the LLM stub.
  // (v1.6 renders lever names as human prose — "Reduce loan proceeds", "Fund a
  // reserve" — and scrubs the raw ids, so we assert on the deterministic SIZED
  // FIGURE the composition produced, a version-agnostic proof of a real render.)
  assert(
    (narrative?.mitigationSuggestions ?? '').startsWith(MITIGATION_SUGGESTIONS_HEADER_V1_6),
    'narrative.mitigationSuggestions starts with the v1.6 deterministic composed-mitigants header (proposals present)',
  );
  assert(
    /\$[\d.]+[MK]/.test(narrative?.mitigationSuggestions ?? '') && /Reduce loan proceeds|Fund a reserve|cash management|amortization/i.test(narrative?.mitigationSuggestions ?? ''),
    'narrative.mitigationSuggestions carries an engine-sized proposal (deterministic render, not the LLM stub)',
  );
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
    rentRoll: null,
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
      rentRoll: null,
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
      extraction: store.getExtractionResult(doctrine.extractionResultId)!,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
      rentRoll: null,
    },
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );
  assert(result.evaluation !== undefined, 'wrapper returns evaluation');
  assert(result.handbookEvaluation !== undefined, 'wrapper returns handbookEvaluation');
  assert(result.narrative !== null, 'wrapper returns narrative (status ok)');
  assertEqual(result.narrativeStatus, 'ok', 'narrativeStatus is ok on a working narrative');
  assertEqual(result.narrative!.handbookEvaluationId, result.handbookEvaluation.id, 'narrative.handbookEvaluationId === HE.id from same call');

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
      rentRoll: null,
    },
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );

  const rendered = materializeRenderedAnalysis(ingest.evaluationId, store);
  assert(rendered.narrative !== null, 'RenderedAnalysis.narrative populated');
  assertEqual(rendered.narrative?.executiveSummary, STUB_EXEC_A, 'rendered narrative carries exec-summary stub prose');
  assertEqual(rendered.narrative?.redFlagAssessment, STUB_REDFLAG_A, 'rendered narrative carries red-flag stub prose (Phase 2)');
  // v1.5 — mitigation slot is deterministic. Rendered narrative must surface
  // the engine's proposals via the v1.5 header (not a stub).
  assert(
    (rendered.narrative?.mitigationSuggestions ?? '').startsWith(MITIGATION_SUGGESTIONS_HEADER_V1_6),
    'rendered narrative carries v1.6 deterministic mitigation render',
  );
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
      rentRoll: null,
    },
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_A, redFlag: STUB_REDFLAG_A, mitigation: STUB_MITIGATION_A, committee: STUB_COMMITTEE_A }) },
  );
  const renderedA = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedA.narrative?.executiveSummary, STUB_EXEC_A, 'first materialize: exec stub A');
  assertEqual(renderedA.narrative?.redFlagAssessment, STUB_REDFLAG_A, 'first materialize: red-flag stub A');
  // v1.5 — first materialize carries the deterministic mitigation render.
  assert(
    (renderedA.narrative?.mitigationSuggestions ?? '').startsWith(MITIGATION_SUGGESTIONS_HEADER_V1_6),
    'first materialize: v1.6 deterministic mitigation render',
  );
  const mitigationRoundA = renderedA.narrative?.mitigationSuggestions ?? '';
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
      extraction: store.getExtractionResult(doctrine.extractionResultId)!,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
      rentRoll: null,
    },
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_B, redFlag: STUB_REDFLAG_B, mitigation: STUB_MITIGATION_B, committee: STUB_COMMITTEE_B }) },
  );

  // Re-materialize: cache lookup uses the NEW narrativeId → miss → fresh render.
  const renderedB = materializeRenderedAnalysis(ingest.evaluationId, store);
  assertEqual(renderedB.narrative?.executiveSummary, STUB_EXEC_B, 'second materialize: exec stub B (cache-staleness gate fired)');
  assertEqual(renderedB.narrative?.redFlagAssessment, STUB_REDFLAG_B, 'second materialize: red-flag stub B (cache-staleness gate fired)');
  // v1.5 — mitigation slot is deterministic from MitigationProposalSet, which
  // is itself a function of AdjustedInputs (unchanged between materializes
  // here). Cache-staleness on the OTHER slots is what proves the gate works;
  // mitigation slot output must STAY the same across re-narration with the
  // same AI inputs.
  assertEqual(
    renderedB.narrative?.mitigationSuggestions,
    mitigationRoundA,
    'second materialize: mitigation slot identical to first (deterministic from same AI)',
  );
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
      rentRoll: null,
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
      extraction: store.getExtractionResult(doctrine.extractionResultId)!,
      analysisAsOfDate: AS_OF as never,
      propertyMetadata: null,
      rentRoll: null,
    },
    store,
    { llmCall: makeStub({ exec: STUB_EXEC_B, redFlag: STUB_REDFLAG_B, mitigation: STUB_MITIGATION_B, committee: STUB_COMMITTEE_B }) },
  );
  const secondLatest = store.getLatestNarrativeForAdjustedInputs(doctrine.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  assertEqual(secondLatest?.executiveSummary, STUB_EXEC_B, 'second latest = exec stub B (newest by created_at)');
  assertEqual(secondLatest?.redFlagAssessment, STUB_REDFLAG_B, 'second latest = red-flag stub B');
  // v1.5 — second latest's mitigation slot mirrors first (deterministic, same AI).
  assert(
    (secondLatest?.mitigationSuggestions ?? '').startsWith(MITIGATION_SUGGESTIONS_HEADER_V1_6),
    'second latest: v1.6 deterministic mitigation render',
  );
  assertEqual(secondLatest?.committeeRecommendation, STUB_COMMITTEE_B, 'second latest = committee stub B (Phase 4)');

  store.close();
}

console.log('\nPartial-degradation semantics — red_flag_assessment slot throws → SCORED-but-un-narrated PARTIAL (not a failure), memo pending, retry recovers:');
{
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  /* Stub that succeeds for executive_summary but rejects on red_flag_assessment.
     NEW contract (narrative-fails-soft fix): a narrative slot throw NO LONGER
     rejects evaluateAndNarrate. buildNarrative is caught → the ingest returns a
     scored-but-un-narrated PARTIAL: the producer-tail (AdjustedInputs / DE / …)
     AND the lineage head ARE persisted (score readable), narrativeStatus is
     'deferred', and NO NarrativeEvaluation row is written. A retry with a
     non-rejecting stub re-runs the producer-tail as no-ops (ON CONFLICT) and
     composes the narrative fresh — cheap recovery. Mirrors extraction-fails-soft. */
  const partialFailureStub: LLMCallFn = async ({ messages }) => {
    const content = messages[0]?.content;
    const text = typeof content === 'string' ? content : '';
    if (text.includes('red-flag assessment')) {
      throw new Error('Simulated LLM failure on red_flag_assessment slot');
    }
    return STUB_EXEC_A;
  };

  const ingest1 = await ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: null,
    },
    store,
    { llmCall: partialFailureStub },
  );
  assert(ingest1.rootId !== undefined, 'first ingest DID NOT throw — degraded to a scored partial');
  assertEqual(ingest1.narrativeStatus, 'deferred', 'ingest reports narrativeStatus deferred');
  assert((ingest1.narrativeDeferredReason ?? '').includes('red_flag_assessment'), 'deferred reason records the failing slot');
  // Score readable: the lineage head + doctrine evaluation persisted.
  assert(store.getRevisionEnvelope(ingest1.rootId) !== null, 'lineage head persisted (score readable) despite narrative deferral');
  assert(store.getDoctrineEvaluation(ingest1.evaluationId) !== null, 'DoctrineEvaluation persisted (score/band/dims intact)');

  /* Producer-tail persisted; NO narrative row yet (memo pending). */
  const aiRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM adjusted_inputs').all() as Array<{ id: string }>;
  assert(aiRows.length === 1, 'producer-tail persisted AdjustedInputs row (scored)');
  const narrRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM narratives').all() as Array<{ id: string }>;
  assertEqual(narrRows.length, 0, 'no narrative row written when red-flag slot threw (memo pending)');

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
      rentRoll: null,
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
  // v1.5 — retry produces the deterministic mitigation render (not the stub).
  assert(
    (recovered?.mitigationSuggestions ?? '').startsWith(MITIGATION_SUGGESTIONS_HEADER_V1_6),
    'retry produces v1.6 deterministic mitigation_suggestions slot',
  );
  assertEqual(recovered?.committeeRecommendation, STUB_COMMITTEE_A, 'retry produces committee_recommendation slot (Phase 4)');

  store.close();
}

// v1.5 retirement note: the Phase-3 partial-failure block (mitigation slot
// throws) has been removed. The mitigation_suggestions slot is now a pure
// deterministic render of MitigationProposalSet (no LLM call), so there is
// no LLM-failure path to exercise. Q-S4 (f.1) symmetry remains in effect for
// the three LLM-driven slots (executive_summary, red_flag_assessment,
// committee_recommendation); their partial-failure blocks below verify it.

console.log('\nPartial-degradation (Phase 4) — committee_recommendation slot throws → scored partial (not a failure):');
{
  /* Final partial-degradation block: the 4th slot (committee_recommendation)
     failing degrades the same way — a scored partial, not a rejection. Confirms
     the narrative-fails-soft fix applies uniformly across all LLM-driven slots. */
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

  const ingestC = await ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: null,
    },
    store,
    { llmCall: committeeFailureStub },
  );
  assert(ingestC.rootId !== undefined, 'committee-failing ingest DID NOT throw — degraded to a scored partial');
  assertEqual(ingestC.narrativeStatus, 'deferred', 'ingest reports narrativeStatus deferred (committee slot)');
  assert(store.getDoctrineEvaluation(ingestC.evaluationId) !== null, 'DoctrineEvaluation persisted (score intact)');

  const narrRows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } })
    .db.prepare('SELECT id FROM narratives').all() as Array<{ id: string }>;
  assertEqual(narrRows.length, 0, 'no narrative row written when committee slot threw (memo pending)');

  store.close();
}

/* --------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });

// Mark NarrativeEvaluation usage so type-only import isn't elided
const _: NarrativeEvaluation | null = null;
void _;
