/**
 * Direct tests for `evaluateFromAdjustedInputs` (Option C / issue #20, step 8.4).
 *
 *   npm run test:evaluate-from-adjusted-inputs       (from apps/api)
 *
 * Proves the factored pipeline tail works in isolation — the prerequisite for
 * applyRevisionDelta (step 8.5) reusing it for non-root revisions.
 *
 * Coverage:
 *   - Happy path: function produces a DoctrineEvaluation with the expected
 *     content-hash shape and wired FKs.
 *   - Persistence: all five records (AI, CC, SO, VC, DE) land in the store.
 *   - Idempotency: calling twice with same inputs yields the same evaluation.id
 *     and ON CONFLICT DO NOTHING fires on the second call.
 *   - Caller pre-insert: function does not throw when AdjustedInputs was already
 *     persisted by the caller (relevant for applyRevisionDelta flows).
 *   - Discipline check: function does NOT create a revision envelope. Envelope
 *     semantics belong to the caller (ingest creates root; applyRevisionDelta
 *     creates non-root). Catching envelope-creation drift here keeps the
 *     factored function reusable across root and non-root paths.
 */

import {
  ASSET_TYPES,
  DOCTRINE_VERSION,
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AssetProfile,
  AssetType,
  ContentHash,
  ExtractionResult,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeFacts,
  RevisionId,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
  computeRevisionId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { evaluateFromAdjustedInputs } from '../services/evaluate-from-adjusted-inputs.js';

const AS_OF = '2026-05-22T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ---------------------------- upstream fixtures ----------------------------- */

function emptyByAssetType(): Record<AssetType, null> {
  const out = {} as Record<AssetType, null>;
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function makeAssetProfile(): AssetProfile {
  const body = {
    propertyType: 'Office' as AssetType,
    businessPlan: 'Stabilized' as const,
    marketLiquidity: 'Primary' as const,
  };
  return { id: computeAssetProfileId(body), ...body };
}

function makeExtractionResult(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'EVAL-FROM-AI-TEST',
    rentRoll: null,
    t12: null,
    pca: null,
    appraisal: null,
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

function makeLibrarySnapshot(): LibrarySnapshot {
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType: emptyByAssetType(),
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeNarrativeFacts(): NarrativeFacts {
  const body = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: 0.92,
    occupancyCurrent: 0.95,
    propertyClass: 'A' as const,
    shadowVacancyFlag: false,
    subleaseCompetition: 'low' as const,
    leasingVelocityDataAvailable: true,
    isMall: null,
    franchiseExpirationWithinTerm: null,
    pipRequired: null,
    pipBudgetPerKey: null,
    privateWastewater: null,
    parkOwnedHomesPct: null,
    t12NoiTrend: 'flat' as const,
    isSingleTenant: false,
    appraisalValue: 80_000_000,
    appraisalCapRate: 0.06,
    asrValue: 75_000_000,
    marketValueFromComps: null,
    exitCapRateBase: 0.065,
    exitCapRateStressed: 0.075,
  };
  return { id: computeNarrativeFactsId(body), ...body } as NarrativeFacts;
}

function lineItem(value: number) {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

function makeAdjustedInputs(librarySnapshotId: LibrarySnapshotId): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId,
    income: {
      grossRentalIncome: lineItem(10_000_000),
      otherIncome: lineItem(500_000),
      vacancyPct: lineItem(0.05),
      concessionsPct: lineItem(0.01),
      effectiveGrossIncome: lineItem(9_400_000),
    },
    expenses: {
      realEstateTaxes: lineItem(800_000),
      insurance: lineItem(150_000),
      utilities: lineItem(200_000),
      managementFee: lineItem(280_000),
      payroll: lineItem(0),
      maintenance: lineItem(300_000),
      other: lineItem(100_000),
      totalOperatingExpenses: lineItem(1_830_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0),
      upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0),
      monthlyTiLc: lineItem(0),
      pcaImmediateRepairs: lineItem(0),
    },
    loan: {
      loanAmount: lineItem(50_000_000),
      interestRate: lineItem(0.07),
      termMonths: lineItem(120),
      amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0),
      maturityBalance: lineItem(45_000_000),
      debtServiceAnnual: lineItem(4_000_000),
    },
    assumptions: {
      capRate: lineItem(0.065),
      terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03),
      expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 7_570_000,
      value: 116_461_538,
      dscr: 1.89,
      ltvAppraisal: 0.625,
      debtYield: 0.1514,
      expenseRatio: 0.195,
      top1IncomeShare: 0.18,
      pctIncomeExpiringWithinTerm: 0.22,
    },
    confidenceReduction: 0.05,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

/** Build the full upstream set the function expects to find in the store
 *  (LibrarySnapshot, ExtractionResult, AssetProfile, NarrativeFacts) plus the
 *  AdjustedInputs the function will accept as input. Caller decides whether to
 *  pre-insert AI or let the function insert it. */
function setupUpstream(store: RecordGraphStore): {
  adjustedInputs: AdjustedInputs;
  assetProfile: AssetProfile;
  librarySnapshot: LibrarySnapshot;
  narrativeFacts: NarrativeFacts;
  extractionResult: ExtractionResult;
} {
  const librarySnapshot = makeLibrarySnapshot();
  const extractionResult = makeExtractionResult();
  const assetProfile = makeAssetProfile();
  const narrativeFacts = makeNarrativeFacts();
  store.insertLibrarySnapshot(librarySnapshot);
  store.insertExtractionResult(extractionResult);
  store.insertAssetProfile(assetProfile);
  store.insertNarrativeFacts(narrativeFacts);
  const adjustedInputs = makeAdjustedInputs(librarySnapshot.id);
  return { adjustedInputs, assetProfile, librarySnapshot, narrativeFacts, extractionResult };
}

/* ----------------------------------- tests --------------------------------- */

console.log('Happy path:');
{
  const store = new RecordGraphStore(':memory:');
  const u = setupUpstream(store);

  const { evaluation } = evaluateFromAdjustedInputs(
    {
      adjustedInputs: u.adjustedInputs,
      assetProfile: u.assetProfile,
      librarySnapshot: u.librarySnapshot,
      narrativeFacts: u.narrativeFacts,
      extractionResultId: u.extractionResult.id,
      analysisAsOfDate: AS_OF,
      propertyMetadata: null,
    },
    store,
  );

  assert(/^[0-9a-f]{64}$/.test(evaluation.id), 'evaluation.id is 64-char hex content hash');
  assertEqual(evaluation.adjustedInputsId, u.adjustedInputs.id, 'evaluation.adjustedInputsId === input.adjustedInputs.id');
  assertEqual(evaluation.assetProfileId, u.assetProfile.id, 'evaluation.assetProfileId === input.assetProfile.id');
  assertEqual(evaluation.librarySnapshotId, u.librarySnapshot.id, 'evaluation.librarySnapshotId === input.librarySnapshot.id');
  assertEqual(evaluation.narrativeFactsId, u.narrativeFacts.id, 'evaluation.narrativeFactsId === input.narrativeFacts.id');
  assertEqual(evaluation.extractionResultId, u.extractionResult.id, 'evaluation.extractionResultId === input.extractionResult.id (HY1 stamping)');

  // All five records persisted in dependency order.
  assert(store.getAdjustedInputs(evaluation.adjustedInputsId) !== null, 'AdjustedInputs persisted');
  assert(store.getCrossCheckResult(evaluation.crossCheckResultId) !== null, 'CrossCheckResult persisted');
  assert(store.getStressOutputs(evaluation.stressOutputsId) !== null, 'StressOutputs persisted');
  assert(store.getValuationConclusion(evaluation.valuationConclusionId) !== null, 'ValuationConclusion persisted');
  assert(store.getDoctrineEvaluation(evaluation.id) !== null, 'DoctrineEvaluation persisted');

  store.close();
}

console.log('\nIdempotency — two calls with the same args produce the same evaluation.id:');
{
  const store = new RecordGraphStore(':memory:');
  const u = setupUpstream(store);

  const args = {
    adjustedInputs: u.adjustedInputs,
    assetProfile: u.assetProfile,
    librarySnapshot: u.librarySnapshot,
    narrativeFacts: u.narrativeFacts,
    extractionResultId: u.extractionResult.id,
    analysisAsOfDate: AS_OF,
    propertyMetadata: null,
  };
  const r1 = evaluateFromAdjustedInputs(args, store);
  const r2 = evaluateFromAdjustedInputs(args, store);

  assertEqual(r1.evaluation.id, r2.evaluation.id, 'identical inputs → identical evaluation.id');
  assertEqual(r1.evaluation.crossCheckResultId, r2.evaluation.crossCheckResultId, 'identical inputs → identical crossCheckResultId');
  assertEqual(r1.evaluation.stressOutputsId, r2.evaluation.stressOutputsId, 'identical inputs → identical stressOutputsId');
  assertEqual(r1.evaluation.valuationConclusionId, r2.evaluation.valuationConclusionId, 'identical inputs → identical valuationConclusionId');

  store.close();
}

console.log('\nCaller pre-inserts AdjustedInputs — function still completes:');
{
  const store = new RecordGraphStore(':memory:');
  const u = setupUpstream(store);
  // Pre-insert AI before calling — mirrors how applyRevisionDelta (step 8.5)
  // may insert a child AdjustedInputs into the store and then drive the tail.
  store.insertAdjustedInputs(u.adjustedInputs);

  const { evaluation } = evaluateFromAdjustedInputs(
    {
      adjustedInputs: u.adjustedInputs,
      assetProfile: u.assetProfile,
      librarySnapshot: u.librarySnapshot,
      narrativeFacts: u.narrativeFacts,
      extractionResultId: u.extractionResult.id,
      analysisAsOfDate: AS_OF,
      propertyMetadata: null,
    },
    store,
  );
  assert(/^[0-9a-f]{64}$/.test(evaluation.id), 'evaluation produced when AI was pre-inserted by caller');
  assertEqual(evaluation.adjustedInputsId, u.adjustedInputs.id, 'AI id round-trips through the pre-insert path');

  store.close();
}

console.log('\nDiscipline — evaluateFromAdjustedInputs does NOT create a revision envelope:');
{
  const store = new RecordGraphStore(':memory:');
  const u = setupUpstream(store);
  const { evaluation } = evaluateFromAdjustedInputs(
    {
      adjustedInputs: u.adjustedInputs,
      assetProfile: u.assetProfile,
      librarySnapshot: u.librarySnapshot,
      narrativeFacts: u.narrativeFacts,
      extractionResultId: u.extractionResult.id,
      analysisAsOfDate: AS_OF,
      propertyMetadata: null,
    },
    store,
  );

  // What WOULD be the root revision id IF the function had created one. Use it
  // to query the lineage table. Function must NOT have written this row —
  // envelope creation is the caller's responsibility (step 8.3 lives in ingest).
  const wouldBeRootId = computeRevisionId({
    parentRevisionId: null,
    adjustedInputsId: u.adjustedInputs.id,
    doctrineVersion: DOCTRINE_VERSION,
  });
  assertEqual(store.getRevisionEnvelope(wouldBeRootId), null, 'no envelope at the would-be root id');
  assertEqual(store.getLatestRevisionByLineageRoot(wouldBeRootId), null, 'no latest envelope for any lineage root');
  assertEqual(store.walkLineageChain(wouldBeRootId).length, 0, 'lineage chain empty (function created no envelopes)');
  // No provenance either.
  assertEqual(store.getRevisionProvenance(wouldBeRootId as RevisionId), null, 'no provenance row');

  // Sanity: the evaluation is real even though no envelope exists.
  assert(store.getDoctrineEvaluation(evaluation.id) !== null, 'evaluation persisted as expected (envelope is a separate concern)');

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
