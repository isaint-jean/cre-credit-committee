/**
 * Storage-layer tests for revision lineage (step 8.2 / issue #20).
 *
 *   npm run test:revision-storage           (from apps/api)
 *
 * Covers:
 *   - Root envelope insert (parent=null, ordinal=0) round-trips.
 *   - Child envelope insert succeeds when parent exists; fails when parent absent (FK).
 *   - getLatestRevisionByLineageRoot returns highest ordinal.
 *   - walkLineageChain returns ordered chain (root → leaf).
 *   - Provenance insert requires envelope FK; round-trips arrays/diff JSON.
 *   - Envelope id mismatch (claimed != computed) throws RecordIdMismatchError.
 *   - Idempotent re-insert (ON CONFLICT DO NOTHING returns inserted: false on 2nd run).
 *
 * In-memory sqlite; no filesystem side effects.
 */

import {
  ASSET_TYPES,
  DOCTRINE_VERSION,
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
  STRESS_ENGINE_VERSION,
  VALUATION_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AssetProfile,
  AssetType,
  ContentHash,
  CrossCheckResult,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeFacts,
  NarrativeFactsId,
  RevisionId,
  RevisionLineageEnvelope,
  RevisionProvenance,
  StressOutputs,
  ValuationConclusion,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeCrossCheckResultId,
  computeDoctrineEvaluationId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
  computeRevisionId,
  computeStressOutputsId,
  computeValuationConclusionId,
} from '../util/content-hash.js';
import {
  RecordGraphStore,
  RecordIdMismatchError,
} from '../storage/record-graph-store.js';

const AS_OF = '2026-05-21T00:00:00Z';

let passed = 0;
let failed = 0;

function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertThrows(fn: () => unknown, message: string, predicate?: (e: unknown) => boolean): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (predicate && !predicate(e)) fail(`${message} (wrong error: ${(e as Error).message})`);
    else ok(message);
  }
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
    dealRef: 'REV-TEST',
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

function makeAdjustedInputs(librarySnapshotId: LibrarySnapshotId, salt = 0): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId,
    income: {
      grossRentalIncome: lineItem(10_000_000 + salt),
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
      generalAndAdmin: lineItem(0),
      janitorial: lineItem(0),
      reimbursements: lineItem(0),
      totalOperatingExpenses: lineItem(1_830_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0),
      upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0),
      monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0),
      monthlyTenantImprovements: lineItem(0),
      monthlyLeasingCommissions: lineItem(0),
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

function makeCrossCheckResult(adjustedInputsId: AdjustedInputsId): CrossCheckResult {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId,
    findings: [],
    overallAdjustmentBias: 'neutral' as const,
  };
  return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
}

function makeStressOutputs(adjustedInputsId: AdjustedInputsId): StressOutputs {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    method: 'DEFAULT' as const,
    scenarios: [],
  };
  return { id: computeStressOutputsId(body), ...body } as StressOutputs;
}

function makeValuationConclusion(
  adjustedInputsId: AdjustedInputsId,
  stressOutputsId: ContentHash,
  narrativeFactsId: NarrativeFactsId,
): ValuationConclusion {
  const body = {
    analysisAsOfDate: AS_OF,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId,
    stressOutputsId: stressOutputsId as unknown as ValuationConclusion['stressOutputsId'],
    narrativeFactsId,
    uwValue: 116_461_538,
    marketValue: null,
    downsideValue: 95_000_000,
    finalValue: 95_000_000,
    appraisalValue: 80_000_000,
    asrValue: 75_000_000,
    capsApplied: [],
    valuationFlags: [],
    haircutsApplied: [],
    anchorUsed: 'appraisal' as const,
  };
  return { id: computeValuationConclusionId(body), ...body } as ValuationConclusion;
}

function makeDoctrineEvaluation(args: {
  adjustedInputs: AdjustedInputs;
  librarySnapshot: LibrarySnapshot;
  narrativeFacts: NarrativeFacts;
  crossCheckResult: CrossCheckResult;
  stressOutputs: StressOutputs;
  valuationConclusion: ValuationConclusion;
  assetProfile: AssetProfile;
  extractionResult: ExtractionResult;
}): DoctrineEvaluation {
  const body = {
    analysisAsOfDate: AS_OF,
    doctrineVersion: DOCTRINE_VERSION,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId: args.adjustedInputs.id,
    librarySnapshotId: args.librarySnapshot.id,
    narrativeFactsId: args.narrativeFacts.id,
    crossCheckResultId: args.crossCheckResult.id,
    stressOutputsId: args.stressOutputs.id,
    valuationConclusionId: args.valuationConclusion.id,
    assetProfileId: args.assetProfile.id,
    extractionResultId: args.extractionResult.id,
    mechanicalScore: 65,
    componentScores: [],
    weightedAggregate: 62,
    assetTypeAdjustments: [],
    scoreAdjustments: [],
    finalScore: 62,
    ratingBand: 'Acceptable' as const,
    flags: [],
    reasons: [],
  };
  return { id: computeDoctrineEvaluationId(body), ...body } as DoctrineEvaluation;
}

/** Populate a full upstream graph and return the resulting (adjustedInputsId, doctrineEvaluationId).
 *  Each call produces a distinct chain via the `salt` parameter so successive envelopes can FK to
 *  different adjustedInputs/doctrine pairs. */
function seedUpstreamGraph(store: RecordGraphStore, salt: number): {
  adjustedInputsId: AdjustedInputsId;
  doctrineEvaluationId: DoctrineEvaluationId;
} {
  const lib = makeLibrarySnapshot();
  const ext = makeExtractionResult();
  const ap = makeAssetProfile();
  const nf = makeNarrativeFacts();
  store.insertLibrarySnapshot(lib);
  store.insertExtractionResult(ext);
  store.insertAssetProfile(ap);
  store.insertNarrativeFacts(nf);

  const ai = makeAdjustedInputs(lib.id, salt);
  store.insertAdjustedInputs(ai);
  const cc = makeCrossCheckResult(ai.id);
  store.insertCrossCheckResult(cc);
  const so = makeStressOutputs(ai.id);
  store.insertStressOutputs(so);
  const vc = makeValuationConclusion(ai.id, so.id, nf.id);
  store.insertValuationConclusion(vc);
  const doc = makeDoctrineEvaluation({
    adjustedInputs: ai,
    librarySnapshot: lib,
    narrativeFacts: nf,
    crossCheckResult: cc,
    stressOutputs: so,
    valuationConclusion: vc,
    assetProfile: ap,
    extractionResult: ext,
  });
  store.insertDoctrineEvaluation(doc);
  return { adjustedInputsId: ai.id, doctrineEvaluationId: doc.id };
}

/* --------------------------------- envelope helper ------------------------- */

function makeEnvelope(args: {
  parentRevisionId: RevisionId | null;
  lineageRootId?: RevisionId;            // defaults to "self" for root (parent=null)
  revisionOrdinal: number;
  adjustedInputsId: AdjustedInputsId;
  doctrineEvaluationId: DoctrineEvaluationId;
}): RevisionLineageEnvelope {
  const revisionId = computeRevisionId({
    parentRevisionId: args.parentRevisionId,
    adjustedInputsId: args.adjustedInputsId,
    doctrineVersion: DOCTRINE_VERSION,
  });
  const lineageRootId = args.lineageRootId ?? revisionId;
  return {
    revisionId,
    lineageRootId,
    parentRevisionId: args.parentRevisionId,
    revisionOrdinal: args.revisionOrdinal,
    doctrineEvaluationId: args.doctrineEvaluationId,
    adjustedInputsId: args.adjustedInputsId,
    doctrineVersion: DOCTRINE_VERSION,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
  };
}

/* ----------------------------------- tests --------------------------------- */

console.log('Root envelope:');
{
  const store = new RecordGraphStore(':memory:');
  const { adjustedInputsId, doctrineEvaluationId } = seedUpstreamGraph(store, 0);
  const root = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId,
    doctrineEvaluationId,
  });
  const { inserted } = store.insertRevisionLineageEnvelope(root);
  assert(inserted, 'root envelope insert (parent=null, ordinal=0) succeeds');

  const got = store.getRevisionEnvelope(root.revisionId);
  assert(got !== null, 'getRevisionEnvelope round-trips');
  assertEqual(got!.parentRevisionId, null, 'root has parentRevisionId=null');
  assertEqual(got!.revisionOrdinal, 0, 'root has ordinal=0');
  assertEqual(got!.lineageRootId, root.revisionId, 'root has lineageRootId === revisionId');
  assertEqual(got!.doctrineEvaluationId, doctrineEvaluationId, 'doctrineEvaluationId round-trips');

  store.close();
}

console.log('\nChild envelope (parent present → OK):');
{
  const store = new RecordGraphStore(':memory:');
  const seed0 = seedUpstreamGraph(store, 0);
  const seed1 = seedUpstreamGraph(store, 1);
  const root = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId: seed0.adjustedInputsId,
    doctrineEvaluationId: seed0.doctrineEvaluationId,
  });
  store.insertRevisionLineageEnvelope(root);

  const child = makeEnvelope({
    parentRevisionId: root.revisionId,
    lineageRootId: root.revisionId,
    revisionOrdinal: 1,
    adjustedInputsId: seed1.adjustedInputsId,
    doctrineEvaluationId: seed1.doctrineEvaluationId,
  });
  const { inserted } = store.insertRevisionLineageEnvelope(child);
  assert(inserted, 'child envelope insert (parent exists) succeeds');

  const got = store.getRevisionEnvelope(child.revisionId);
  assertEqual(got!.parentRevisionId, root.revisionId, 'child parentRevisionId points to root');
  assertEqual(got!.lineageRootId, root.revisionId, 'child lineageRootId stays at root');
  assertEqual(got!.revisionOrdinal, 1, 'child ordinal=1');

  store.close();
}

console.log('\nChild envelope (parent absent → FK violation):');
{
  const store = new RecordGraphStore(':memory:');
  const seed = seedUpstreamGraph(store, 0);
  const phantomParent = ('f'.repeat(64)) as unknown as RevisionId;
  const orphan = makeEnvelope({
    parentRevisionId: phantomParent,
    lineageRootId: phantomParent,
    revisionOrdinal: 1,
    adjustedInputsId: seed.adjustedInputsId,
    doctrineEvaluationId: seed.doctrineEvaluationId,
  });
  assertThrows(
    () => store.insertRevisionLineageEnvelope(orphan),
    'insert with non-existent parent fails (FK)',
    (e) => (e as Error).message.toLowerCase().includes('foreign key'),
  );

  store.close();
}

console.log('\ngetLatestRevisionByLineageRoot + walkLineageChain:');
{
  const store = new RecordGraphStore(':memory:');
  const seeds = [
    seedUpstreamGraph(store, 0),
    seedUpstreamGraph(store, 1),
    seedUpstreamGraph(store, 2),
  ];
  const root = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId: seeds[0]!.adjustedInputsId,
    doctrineEvaluationId: seeds[0]!.doctrineEvaluationId,
  });
  store.insertRevisionLineageEnvelope(root);

  const child1 = makeEnvelope({
    parentRevisionId: root.revisionId,
    lineageRootId: root.revisionId,
    revisionOrdinal: 1,
    adjustedInputsId: seeds[1]!.adjustedInputsId,
    doctrineEvaluationId: seeds[1]!.doctrineEvaluationId,
  });
  store.insertRevisionLineageEnvelope(child1);

  const child2 = makeEnvelope({
    parentRevisionId: child1.revisionId,
    lineageRootId: root.revisionId,
    revisionOrdinal: 2,
    adjustedInputsId: seeds[2]!.adjustedInputsId,
    doctrineEvaluationId: seeds[2]!.doctrineEvaluationId,
  });
  store.insertRevisionLineageEnvelope(child2);

  const latest = store.getLatestRevisionByLineageRoot(root.revisionId);
  assertEqual(latest?.revisionId, child2.revisionId, 'getLatestRevisionByLineageRoot returns highest-ordinal envelope');
  assertEqual(latest?.revisionOrdinal, 2, 'latest ordinal is 2');

  const chain = store.walkLineageChain(root.revisionId);
  assertEqual(chain.length, 3, 'walkLineageChain returns 3 envelopes');
  assertEqual(chain[0]!.revisionOrdinal, 0, 'chain[0] ordinal=0');
  assertEqual(chain[1]!.revisionOrdinal, 1, 'chain[1] ordinal=1');
  assertEqual(chain[2]!.revisionOrdinal, 2, 'chain[2] ordinal=2');
  assertEqual(chain[0]!.revisionId, root.revisionId, 'chain[0] is root');
  assertEqual(chain[2]!.revisionId, child2.revisionId, 'chain[2] is latest');

  // Unknown lineage root → no envelopes / null latest
  const unknown = ('e'.repeat(64)) as unknown as RevisionId;
  assertEqual(store.getLatestRevisionByLineageRoot(unknown), null, 'getLatestRevisionByLineageRoot returns null for unknown root');
  assertEqual(store.walkLineageChain(unknown).length, 0, 'walkLineageChain returns empty for unknown root');

  store.close();
}

console.log('\nProvenance:');
{
  const store = new RecordGraphStore(':memory:');
  const seed = seedUpstreamGraph(store, 0);
  const root = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId: seed.adjustedInputsId,
    doctrineEvaluationId: seed.doctrineEvaluationId,
  });
  store.insertRevisionLineageEnvelope(root);

  const provenance: RevisionProvenance = {
    revisionId: root.revisionId,
    inputDiff: {
      changedFields: [
        { path: 'income.vacancyPct.adjusted', before: 0.05, after: 0.07, changeType: 'modified' },
      ],
    },
    triggerSource: 'USER_EDIT',
    appliedRuleIds: [],
    adjustmentOrigin: ['manual: vacancy stress'],
    beforeHash: seed.adjustedInputsId,
    afterHash: seed.adjustedInputsId,
  };
  const { inserted } = store.insertRevisionProvenance(provenance);
  assert(inserted, 'provenance insert succeeds when envelope exists');

  const got = store.getRevisionProvenance(root.revisionId);
  assert(got !== null, 'getRevisionProvenance round-trips');
  assertEqual(got!.triggerSource, 'USER_EDIT', 'triggerSource preserved');
  assertEqual(got!.inputDiff.changedFields.length, 1, 'inputDiff.changedFields round-trips');
  assertEqual(got!.inputDiff.changedFields[0]!.path, 'income.vacancyPct.adjusted', 'inputDiff path round-trips');
  assertEqual(got!.adjustmentOrigin.length, 1, 'adjustmentOrigin round-trips');

  // FK enforcement: provenance for an envelope that doesn't exist must fail.
  const orphanRevision = ('d'.repeat(64)) as unknown as RevisionId;
  assertThrows(
    () => store.insertRevisionProvenance({ ...provenance, revisionId: orphanRevision }),
    'provenance insert fails when envelope is absent (FK)',
    (e) => (e as Error).message.toLowerCase().includes('foreign key'),
  );

  store.close();
}

console.log('\nEnvelope id mismatch (claimed != computed):');
{
  const store = new RecordGraphStore(':memory:');
  const seed = seedUpstreamGraph(store, 0);
  const real = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId: seed.adjustedInputsId,
    doctrineEvaluationId: seed.doctrineEvaluationId,
  });
  const tampered: RevisionLineageEnvelope = {
    ...real,
    revisionId: ('c'.repeat(64)) as unknown as RevisionId,
    lineageRootId: ('c'.repeat(64)) as unknown as RevisionId,
  };
  assertThrows(
    () => store.insertRevisionLineageEnvelope(tampered),
    'envelope with mismatched revisionId throws RecordIdMismatchError',
    (e) => e instanceof RecordIdMismatchError,
  );
  store.close();
}

console.log('\nIdempotent re-insert (ON CONFLICT DO NOTHING):');
{
  const store = new RecordGraphStore(':memory:');
  const seed = seedUpstreamGraph(store, 0);
  const root = makeEnvelope({
    parentRevisionId: null,
    revisionOrdinal: 0,
    adjustedInputsId: seed.adjustedInputsId,
    doctrineEvaluationId: seed.doctrineEvaluationId,
  });
  const r1 = store.insertRevisionLineageEnvelope(root);
  const r2 = store.insertRevisionLineageEnvelope(root);
  assert(r1.inserted === true, 'first envelope insert: inserted=true');
  assert(r2.inserted === false, 'second envelope insert (same id): inserted=false');

  const prov: RevisionProvenance = {
    revisionId: root.revisionId,
    inputDiff: { changedFields: [] },
    triggerSource: 'SYSTEM_RECALC',
    appliedRuleIds: [],
    adjustmentOrigin: [],
    beforeHash: seed.adjustedInputsId,
    afterHash: seed.adjustedInputsId,
  };
  const p1 = store.insertRevisionProvenance(prov);
  const p2 = store.insertRevisionProvenance(prov);
  assert(p1.inserted === true, 'first provenance insert: inserted=true');
  assert(p2.inserted === false, 'second provenance insert (same id): inserted=false');

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
