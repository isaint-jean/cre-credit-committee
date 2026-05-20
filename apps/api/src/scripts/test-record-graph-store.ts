/**
 * Tests for RecordGraphStore. Uses an in-memory sqlite db; no filesystem side effects.
 *
 *   npm run test:record-graph
 *
 * Exercises round-trip, idempotency, hash-mismatch detection, FK enforcement, and content-hash
 * verification on read.
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
  AssetProfileId,
  AssetType,
  ContentHash,
  CrossCheckResult,
  CrossCheckResultId,
  DoctrineEvaluation,
  ExtractionResult,
  ExtractionResultId,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeFacts,
  NarrativeFactsId,
  PropertyMetadata,
  PropertyMetadataId,
  StressOutputs,
  StressOutputsId,
  ValuationConclusion,
  ValuationConclusionId,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeCrossCheckResultId,
  computeDoctrineEvaluationId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
  computePropertyMetadataId,
  computeStressOutputsId,
  computeValuationConclusionId,
} from '../util/content-hash.js';
import {
  RecordGraphStore,
  RecordIdMismatchError,
} from '../storage/record-graph-store.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;

function ok(message: string): void {
  passed++;
  console.log(`  ok    ${message}`);
}
function fail(message: string): void {
  failed++;
  console.error(`  FAIL  ${message}`);
}
function assert(condition: boolean, message: string): void {
  condition ? ok(message) : fail(message);
}
function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch {
    ok(message);
  }
}
function assertThrowsInstanceOf<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  message: string,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (e instanceof ctor) ok(message);
    else fail(`${message} (threw ${(e as Error)?.name})`);
  }
}

/* ------------------------------- fixtures -------------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function makeAssetProfile(propertyType: AssetType = 'Office'): AssetProfile {
  const body = {
    propertyType,
    businessPlan: 'Stabilized' as const,
    marketLiquidity: 'Primary' as const,
  };
  return { id: computeAssetProfileId(body), ...body };
}

function makeExtractionResult(dealRef = 'TEST-1'): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef,
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

function makePropertyMetadata(propertyName: string | null = 'Test Property'): PropertyMetadata {
  const body = {
    source: 'asr_extraction' as const,
    propertyName,
    propertySubtype: 'Suburban Office',
    address: '123 Main St',
    city: 'Testville',
    state: 'CA',
    zip: '90000',
    county: null,
    msa: null,
    submarket: null,
    yearBuilt: 2010,
    yearRenovated: null,
    buildingClass: 'B',
    totalSquareFeet: 50_000,
    totalUnits: null,
    totalRooms: null,
    totalPads: null,
    occupancyPhysical: 0.92,
    occupancyEconomic: null,
    ownershipInterest: 'Fee Simple',
    numberOfBuildings: 1,
  };
  return { id: computePropertyMetadataId(body), ...body };
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
  stressOutputsId: StressOutputsId,
  narrativeFactsId: NarrativeFactsId,
): ValuationConclusion {
  const body = {
    analysisAsOfDate: AS_OF,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId,
    stressOutputsId,
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
  adjustedInputsId: AdjustedInputsId;
  librarySnapshotId: LibrarySnapshotId;
  narrativeFactsId: NarrativeFactsId;
  crossCheckResultId: CrossCheckResultId;
  stressOutputsId: StressOutputsId;
  valuationConclusionId: ValuationConclusionId;
  assetProfileId: AssetProfileId;
  extractionResultId: ExtractionResultId;
}): DoctrineEvaluation {
  const body = {
    analysisAsOfDate: AS_OF,
    doctrineVersion: DOCTRINE_VERSION,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId: args.adjustedInputsId,
    librarySnapshotId: args.librarySnapshotId,
    narrativeFactsId: args.narrativeFactsId,
    crossCheckResultId: args.crossCheckResultId,
    stressOutputsId: args.stressOutputsId,
    valuationConclusionId: args.valuationConclusionId,
    assetProfileId: args.assetProfileId,
    extractionResultId: args.extractionResultId,
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

/* --------------------------------- run ----------------------------------- */

const store = new RecordGraphStore(':memory:');

console.log('Round-trip:');
{
  const lib = makeLibrarySnapshot();
  const r1 = store.insertLibrarySnapshot(lib);
  assert(r1.inserted, 'insertLibrarySnapshot reports inserted=true on first call');
  const fetched = store.getLibrarySnapshot(lib.id);
  assert(fetched !== null, 'getLibrarySnapshot returns row for known id');
  assert(fetched?.id === lib.id, 'retrieved id matches original');

  // re-derive id from retrieved body to verify storage didn't corrupt content
  if (fetched) {
    const { id: _retId, ...retBody } = fetched;
    const recomputed = computeLibrarySnapshotId(retBody);
    assert(recomputed === lib.id, 'retrieved body re-hashes to original id');
  }
}

console.log('\nIdempotency:');
{
  const lib = makeLibrarySnapshot();
  store.insertLibrarySnapshot(lib);
  const r2 = store.insertLibrarySnapshot(lib);
  assert(!r2.inserted, 'second insert of same record reports inserted=false');
}

console.log('\nNonexistent get:');
{
  const fetched = store.getLibrarySnapshot('z'.repeat(64) as never);
  assert(fetched === null, 'getLibrarySnapshot returns null for unknown id');
}

console.log('\nID mismatch detection:');
{
  const lib = makeLibrarySnapshot();
  const tampered = { ...lib, asOf: '2099-01-01T00:00:00Z' };  // body changed, id not recomputed
  assertThrowsInstanceOf(
    () => store.insertLibrarySnapshot(tampered as LibrarySnapshot),
    RecordIdMismatchError,
    'insert with mismatched id throws RecordIdMismatchError',
  );
}

console.log('\nFK enforcement:');
{
  // AdjustedInputs requires LibrarySnapshot to exist
  const orphan = makeAdjustedInputs('0'.repeat(64) as LibrarySnapshotId);  // no such snapshot
  assertThrows(
    () => store.insertAdjustedInputs(orphan),
    'AdjustedInputs with unknown librarySnapshotId fails FK',
  );
}

console.log('\nFull chain round-trip:');
{
  const lib = makeLibrarySnapshot();
  store.insertLibrarySnapshot(lib);

  const narr = makeNarrativeFacts();
  store.insertNarrativeFacts(narr);

  const ai = makeAdjustedInputs(lib.id);
  store.insertAdjustedInputs(ai);

  const cc = makeCrossCheckResult(ai.id);
  store.insertCrossCheckResult(cc);

  const stress = makeStressOutputs(ai.id);
  store.insertStressOutputs(stress);

  const val = makeValuationConclusion(ai.id, stress.id, narr.id);
  store.insertValuationConclusion(val);

  const profile = makeAssetProfile('Office');
  store.insertAssetProfile(profile);
  const ext = makeExtractionResult('FULL-CHAIN-DEAL');
  store.insertExtractionResult(ext);

  const doctrine = makeDoctrineEvaluation({
    adjustedInputsId: ai.id,
    librarySnapshotId: lib.id,
    narrativeFactsId: narr.id,
    crossCheckResultId: cc.id,
    stressOutputsId: stress.id,
    valuationConclusionId: val.id,
    assetProfileId: profile.id,
    extractionResultId: ext.id,
  });
  const dr = store.insertDoctrineEvaluation(doctrine);
  assert(dr.inserted, 'doctrine evaluation persisted with full FK chain');

  const fetched = store.getDoctrineEvaluation(doctrine.id);
  assert(fetched !== null, 'doctrine evaluation retrievable by id');
  assert(fetched?.finalScore === 62, 'finalScore round-trips');
  assert(fetched?.ratingBand === 'Acceptable', 'ratingBand round-trips');
  assert(fetched?.adjustedInputsId === ai.id, 'FK adjustedInputsId round-trips');
}

console.log('\nDoctrineEvaluation FK chain enforcement:');
{
  const fakeId = '0'.repeat(64);
  const orphan = makeDoctrineEvaluation({
    adjustedInputsId: fakeId as AdjustedInputsId,
    librarySnapshotId: fakeId as LibrarySnapshotId,
    narrativeFactsId: fakeId as NarrativeFactsId,
    crossCheckResultId: fakeId as CrossCheckResultId,
    stressOutputsId: fakeId as StressOutputsId,
    valuationConclusionId: fakeId as ValuationConclusionId,
    assetProfileId: fakeId as AssetProfileId,
    extractionResultId: fakeId as ExtractionResultId,
  });
  assertThrows(
    () => store.insertDoctrineEvaluation(orphan),
    'doctrine evaluation with unknown FKs fails constraint',
  );
}

console.log('\nExtractionResult round-trip:');
{
  const ext = makeExtractionResult();
  const r1 = store.insertExtractionResult(ext);
  assert(r1.inserted, 'insertExtractionResult reports inserted=true on first call');
  const fetched = store.getExtractionResult(ext.id);
  assert(fetched !== null, 'getExtractionResult returns row for known id');
  assert(fetched?.id === ext.id, 'retrieved id matches original');
  assert(fetched?.dealRef === 'TEST-1', 'dealRef round-trips');
  if (fetched) {
    const { id: _ret, ...retBody } = fetched;
    const recomputed = computeExtractionResultId(retBody);
    assert(recomputed === ext.id, 'retrieved body re-hashes to original id');
  }
}

console.log('\nExtractionResult idempotency:');
{
  const ext = makeExtractionResult('IDEMPOTENT-DEAL');
  store.insertExtractionResult(ext);
  const r2 = store.insertExtractionResult(ext);
  assert(!r2.inserted, 'second insert of same ExtractionResult reports inserted=false');
}

console.log('\nExtractionResult id mismatch detection:');
{
  const ext = makeExtractionResult();
  const tampered = { ...ext, dealRef: 'TAMPERED-DEAL' };
  assertThrowsInstanceOf(
    () => store.insertExtractionResult(tampered as ExtractionResult),
    RecordIdMismatchError,
    'insert with tampered ExtractionResult body throws RecordIdMismatchError',
  );
}

console.log('\nExtractionResult nonexistent get:');
{
  const fetched = store.getExtractionResult('z'.repeat(64) as never);
  assert(fetched === null, 'getExtractionResult returns null for unknown id');
}

console.log('\nAssetProfile round-trip:');
{
  const profile = makeAssetProfile('Multifamily');
  const r1 = store.insertAssetProfile(profile);
  assert(r1.inserted, 'insertAssetProfile reports inserted=true on first call');
  const fetched = store.getAssetProfile(profile.id);
  assert(fetched !== null, 'getAssetProfile returns row for known id');
  assert(fetched?.id === profile.id, 'retrieved id matches original');
  assert(fetched?.propertyType === 'Multifamily', 'propertyType round-trips');
  assert(fetched?.businessPlan === 'Stabilized', 'businessPlan round-trips');
  assert(fetched?.marketLiquidity === 'Primary', 'marketLiquidity round-trips');
  if (fetched) {
    const { id: _ret, ...retBody } = fetched;
    const recomputed = computeAssetProfileId(retBody);
    assert(recomputed === profile.id, 'retrieved body re-hashes to original id');
  }
}

console.log('\nAssetProfile idempotency:');
{
  const profile = makeAssetProfile('Hotel');
  store.insertAssetProfile(profile);
  const r2 = store.insertAssetProfile(profile);
  assert(!r2.inserted, 'second insert of same AssetProfile reports inserted=false');
}

console.log('\nAssetProfile id mismatch detection:');
{
  const profile = makeAssetProfile('Office');
  const tampered = { ...profile, propertyType: 'Retail' as const };
  assertThrowsInstanceOf(
    () => store.insertAssetProfile(tampered as AssetProfile),
    RecordIdMismatchError,
    'insert with tampered AssetProfile body throws RecordIdMismatchError',
  );
}

console.log('\nAssetProfile content-hash determinism (same body → same id):');
{
  const a = makeAssetProfile('Industrial');
  const b = makeAssetProfile('Industrial');
  assert(a.id === b.id, 'two AssetProfiles with identical bodies share the same id');
}

console.log('\nAssetProfile content-hash discrimination (different body → different id):');
{
  const a = makeAssetProfile('Office');
  const b = makeAssetProfile('Retail');
  assert(a.id !== b.id, 'AssetProfiles with different propertyType have different ids');
}

console.log('\nAssetProfile nonexistent get:');
{
  const fetched = store.getAssetProfile('z'.repeat(64) as never);
  assert(fetched === null, 'getAssetProfile returns null for unknown id');
}

console.log('\nPropertyMetadata round-trip:');
{
  const pm = makePropertyMetadata();
  const r1 = store.insertPropertyMetadata(pm);
  assert(r1.inserted, 'insertPropertyMetadata reports inserted=true on first call');
  const fetched = store.getPropertyMetadata(pm.id);
  assert(fetched !== null, 'getPropertyMetadata returns row for known id');
  assert(fetched?.id === pm.id, 'retrieved id matches original');
  if (fetched) {
    const { id: _id, ...body } = fetched;
    const recomputed = computePropertyMetadataId(body);
    assert(recomputed === pm.id, 'retrieved body re-hashes to original id');
  }
}

console.log('\nPropertyMetadata idempotency:');
{
  const pm = makePropertyMetadata();
  store.insertPropertyMetadata(pm);
  const r2 = store.insertPropertyMetadata(pm);
  assert(!r2.inserted, 'second insert of same record reports inserted=false');
}

console.log('\nPropertyMetadata nonexistent get:');
{
  const fetched = store.getPropertyMetadata('00'.repeat(32) as PropertyMetadataId);
  assert(fetched === null, 'getPropertyMetadata returns null for unknown id');
}

console.log('\nPropertyMetadata ID mismatch detection:');
{
  const pm = makePropertyMetadata();
  const tampered = { ...pm, propertyName: 'Tampered Name' };
  assertThrowsInstanceOf(
    () => store.insertPropertyMetadata(tampered as PropertyMetadata),
    RecordIdMismatchError,
    'insert with tampered PropertyMetadata body throws RecordIdMismatchError',
  );
}

store.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
