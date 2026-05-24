/**
 * Integration tests for the Stage 10 doctrine evaluator (Batch 5c).
 *
 *   npm run test:doctrine-evaluation
 *
 * Verifies: full pipeline (5a + 5b + 5c) wires correctly; mechanicalScore aggregation;
 * weightedAggregate sum; score adjuster firing conditions; ±25 envelope; rating-band
 * boundaries; reason + flag aggregation; idempotency; persistence round-trip.
 */

import {
  ASSET_TYPES,
  type AdjustedInputs,
  type AdjustedLineItem,
  type AssetProfile,
  type AssetType,
  type ContentHash,
  type CrossCheckResult,
  type DoctrineFlag,
  type LibrarySnapshot,
  type LibrarySnapshotDistribution,
  type NarrativeFacts,
  type PropertyClass,
  type StressOutputs,
  type ValuationCap,
  type ValuationConclusion,
  type ValuationHaircut,
} from '@cre/contracts';
import { buildDoctrineEvaluation } from '../services/doctrine/build-doctrine-evaluation.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  computeAdjustedInputsId,
  computeAssetProfileId,
  computeCrossCheckResultId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeNarrativeFactsId,
  computeStressOutputsId,
  computeValuationConclusionId,
} from '../util/content-hash.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}

/* ------------------------------- fixtures -------------------------------- */

function lineItem(value: number, raw: number | null = value): AdjustedLineItem {
  return { raw, adjusted: value, source: 'BANK', adjustments: [] };
}

function makeProfile(t: AssetType = 'Office'): AssetProfile {
  const body = { propertyType: t, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeAdjustedInputs(opts: Partial<{
  noi: number | null;
  dscr: number | null;
  ltvAppraisal: number | null;
  debtYield: number | null;
  top1IncomeShare: number | null;
  pctIncomeExpiringWithinTerm: number | null;
  pcaImmediate: number | null;
  upfrontCapex: number;
  dataQualityFlags: import('@cre/contracts').JudgmentEngineRuleId[];
  librarySnapshotId: import('@cre/contracts').LibrarySnapshotId;
}> = {}): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: '1.0' as const,
    librarySnapshotId: opts.librarySnapshotId ?? computeLibrarySnapshotId({ x: 1 }),
    income: {
      grossRentalIncome: lineItem(1_000_000),
      otherIncome: lineItem(0),
      vacancyPct: lineItem(0.10, 0.05),
      concessionsPct: lineItem(0),
      effectiveGrossIncome: lineItem(900_000),
    },
    expenses: {
      realEstateTaxes: lineItem(80_000),
      insurance: lineItem(15_000),
      utilities: lineItem(20_000),
      managementFee: lineItem(28_000),
      payroll: lineItem(0),
      maintenance: lineItem(30_000),
      other: lineItem(0),
      totalOperatingExpenses: lineItem(250_000, 200_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(opts.upfrontCapex ?? 0),
      upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0),
      monthlyTiLc: lineItem(0),
      pcaImmediateRepairs: lineItem(opts.pcaImmediate ?? 0, opts.pcaImmediate === undefined ? null : opts.pcaImmediate),
    },
    loan: {
      loanAmount: lineItem(10_000_000),
      interestRate: lineItem(0.07),
      termMonths: lineItem(120),
      amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0),
      maturityBalance: lineItem(9_000_000),
      debtServiceAnnual: lineItem(800_000),
    },
    assumptions: {
      capRate: lineItem(0.065),
      terminalCapRate: lineItem(0.075),
      rentGrowthPct: lineItem(0.03),
      expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: opts.noi === undefined ? 800_000 : opts.noi,
      value: 12_307_692,
      dscr: opts.dscr === undefined ? 1.30 : opts.dscr,
      ltvAppraisal: opts.ltvAppraisal === undefined ? 0.60 : opts.ltvAppraisal,
      debtYield: opts.debtYield === undefined ? 0.10 : opts.debtYield,
      expenseRatio: 0.25,
      top1IncomeShare: opts.top1IncomeShare === undefined ? 0.25 : opts.top1IncomeShare,
      pctIncomeExpiringWithinTerm:
        opts.pctIncomeExpiringWithinTerm === undefined ? 0.20 : opts.pctIncomeExpiringWithinTerm,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: opts.dataQualityFlags ?? [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function makeNarrativeFacts(opts: Partial<{
  trailingOccAvg: number | null;
  t12NoiTrend: 'up' | 'flat' | 'down' | null;
  isSingleTenant: boolean;
  propertyClass: PropertyClass | null;
  shadowVacancyFlag: boolean | null;
}> = {}): NarrativeFacts {
  const body = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: opts.trailingOccAvg === undefined ? 0.95 : opts.trailingOccAvg,
    occupancyCurrent: 0.95,
    propertyClass: opts.propertyClass === undefined ? ('A' as PropertyClass) : opts.propertyClass,
    shadowVacancyFlag: opts.shadowVacancyFlag === undefined ? false : opts.shadowVacancyFlag,
    subleaseCompetition: 'low' as const,
    leasingVelocityDataAvailable: true,
    isMall: null,
    franchiseExpirationWithinTerm: null,
    pipRequired: null,
    pipBudgetPerKey: null,
    privateWastewater: null,
    parkOwnedHomesPct: null,
    t12NoiTrend: opts.t12NoiTrend === undefined ? ('flat' as const) : opts.t12NoiTrend,
    isSingleTenant: opts.isSingleTenant ?? false,
    appraisalValue: 12_500_000,
    appraisalCapRate: 0.065,
    asrValue: null,
    marketValueFromComps: null,
    exitCapRateBase: 0.065,
    exitCapRateStressed: 0.075,
  };
  return { id: computeNarrativeFactsId(body), ...body } as NarrativeFacts;
}

function makeLibrarySnapshot(): LibrarySnapshot {
  const dist: LibrarySnapshotDistribution = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const byAssetType = {} as { [K in AssetType]: LibrarySnapshotDistribution | null };
  for (const t of ASSET_TYPES) byAssetType[t] = dist;
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: ('a'.repeat(64) as ContentHash),
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeCrossCheckResult(
  noiDeltaPct: number | null = null,
  adjustedInputsId?: import('@cre/contracts').AdjustedInputsId,
): CrossCheckResult {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId: adjustedInputsId ?? computeAdjustedInputsId({ x: 1 }),
    findings:
      noiDeltaPct === null
        ? []
        : [
            {
              metric: 'noi',
              bank: { value: 800_000, source: 'T12_ACTUAL' as const },
              rawExtracted: { value: 800_000, source: 'T12_ACTUAL' as const },
              adjusted: { value: 800_000 * (1 + noiDeltaPct) },
              bpFinal: { value: 800_000 * (1 + noiDeltaPct) },
              drivers: [],
              delta: { vsBank: 800_000 * noiDeltaPct, vsBankPct: noiDeltaPct },
              conservatismStatus: 'NEUTRAL' as const,
            },
          ],
    overallAdjustmentBias: 'neutral' as const,
  };
  return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
}

function makeStressOutputs(adjustedInputsId?: import('@cre/contracts').AdjustedInputsId): StressOutputs {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId: adjustedInputsId ?? computeAdjustedInputsId({ x: 1 }),
    stressEngineVersion: '1.0' as const,
    method: 'DEFAULT' as const,
    scenarios: [
      {
        name: 'Vacancy +5%',
        noi: 700_000,
        dscr: 0.875,
        value: 10_769_230,
        ltv: 0.93,
        debtYield: 0.07,
        breaches: [],
        skipped: [],
      },
    ],
  };
  return { id: computeStressOutputsId(body), ...body } as StressOutputs;
}

function makeValuationConclusion(opts: Partial<{
  finalValue: number | null;
  uwValue: number | null;
  downsideValue: number | null;
  capsApplied: readonly ValuationCap[];
  haircutsApplied: readonly ValuationHaircut[];
  valuationFlags: readonly DoctrineFlag[];
  adjustedInputsId: import('@cre/contracts').AdjustedInputsId;
  stressOutputsId: import('@cre/contracts').StressOutputsId;
  narrativeFactsId: import('@cre/contracts').NarrativeFactsId;
}> = {}): ValuationConclusion {
  const body = {
    analysisAsOfDate: AS_OF,
    valuationEngineVersion: '1.0' as const,
    adjustedInputsId: opts.adjustedInputsId ?? computeAdjustedInputsId({ x: 1 }),
    stressOutputsId: opts.stressOutputsId ?? computeStressOutputsId({ x: 1 }),
    narrativeFactsId: opts.narrativeFactsId ?? computeNarrativeFactsId({ x: 1 }),
    uwValue: opts.uwValue === undefined ? 12_000_000 : opts.uwValue,
    marketValue: null,
    downsideValue: opts.downsideValue === undefined ? 10_000_000 : opts.downsideValue,
    finalValue: opts.finalValue === undefined ? 10_000_000 : opts.finalValue,
    appraisalValue: 12_500_000,
    asrValue: null,
    capsApplied: opts.capsApplied ?? [],
    haircutsApplied: opts.haircutsApplied ?? [],
    valuationFlags: opts.valuationFlags ?? [],
    anchorUsed: 'appraisal' as const,
  };
  return { id: computeValuationConclusionId(body), ...body } as ValuationConclusion;
}

function defaultArgs() {
  return {
    adjustedInputs: makeAdjustedInputs(),
    assetProfile: makeProfile('Office'),
    librarySnapshot: makeLibrarySnapshot(),
    narrativeFacts: makeNarrativeFacts(),
    crossCheckResult: makeCrossCheckResult(),
    stressOutputs: makeStressOutputs(),
    valuationConclusion: makeValuationConclusion(),
    extractionResultId: 'e'.repeat(64) as never,
  };
}

/* --------------------------- happy path ---------------------------------- */

console.log('Happy path:');
{
  const r = buildDoctrineEvaluation(defaultArgs());
  assert(typeof r.id === 'string' && /^[0-9a-f]{64}$/.test(r.id), 'id is 64-char hex');
  assertEqual(r.doctrineVersion, '1.0', 'doctrineVersion stamped');
  assert(r.componentScores.length > 0, 'componentScores populated');
  assert(r.finalScore >= 0 && r.finalScore <= 100, 'finalScore in [0,100]');
  assert(['Strong', 'Acceptable', 'Weak', 'High Risk'].includes(r.ratingBand), 'rating band assigned');
  const args = defaultArgs();
  assertEqual(r.assetProfileId, args.assetProfile.id, 'assetProfileId FK matches input');
}

/* --------------------------- mechanicalScore ----------------------------- */

console.log('\nMechanicalScore aggregation:');
{
  // DSCR 1.40 → 100, DY 0.13 → 95, LTV 0.50 → 95 → avg ≈ 96.67
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({ dscr: 1.40, debtYield: 0.13, ltvAppraisal: 0.50 }),
  });
  assertClose(r.mechanicalScore, (100 + 95 + 95) / 3, 0.01, 'mechanical avg of 100+95+95 ≈ 96.67');
}
{
  // DSCR 0.80 → 20, DY 0.05 → 30, LTV 0.85 → 30 → avg ≈ 26.67
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({ dscr: 0.80, debtYield: 0.05, ltvAppraisal: 0.85 }),
  });
  assertClose(r.mechanicalScore, (20 + 30 + 30) / 3, 0.01, 'mechanical avg of 20+30+30 ≈ 26.67');
}

/* --------------------------- weightedAggregate --------------------------- */

console.log('\nWeightedAggregate:');
{
  const r = buildDoctrineEvaluation(defaultArgs());
  const sum = r.componentScores.reduce((s, c) => s + c.contribution, 0);
  assertClose(r.weightedAggregate, sum, 1e-9, 'weightedAggregate = sum of contributions');
  assert(r.weightedAggregate >= 0 && r.weightedAggregate <= 100, 'weightedAggregate in [0, 100]');
}

/* ----------------------------- score adjusters --------------------------- */

console.log('\nFalse_negative_guard:');
{
  // mechanical < 50 (DSCR 1.0 → 40, DY 0.07 → 30, LTV 0.78 → 30 → avg 33.3),
  // t12 present, trend flat, rollover 0.20 ≤ 0.30, finalValue 10M ≤ 1.10 × 12.5M → fires +12
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({
      dscr: 1.0,
      debtYield: 0.07,
      ltvAppraisal: 0.78,
      pctIncomeExpiringWithinTerm: 0.20,
    }),
    valuationConclusion: makeValuationConclusion({ finalValue: 10_000_000 }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_NEGATIVE_GUARD');
  assert(guard?.fired ?? false, 'False_negative_guard fires when conditions met');
  assertEqual(guard?.points ?? 0, 12, 'fires with +12 points');
}
{
  // Strong mechanical → mech<50 fails → does not fire
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({ dscr: 1.40, debtYield: 0.13, ltvAppraisal: 0.50 }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_NEGATIVE_GUARD');
  assertEqual(guard?.fired ?? true, false, 'strong mechanical → guard does not fire');
  assertEqual(guard?.points ?? 1, 0, 'no points when not fired');
}
{
  // T-12 missing → does not fire
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({
      dscr: 1.0,
      debtYield: 0.07,
      ltvAppraisal: 0.78,
      dataQualityFlags: ['JE_T12_MISSING'],
    }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_NEGATIVE_GUARD');
  assertEqual(guard?.fired ?? true, false, 't12 missing → guard does not fire');
}
{
  // T-12 trend down → does not fire
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({ dscr: 1.0, debtYield: 0.07, ltvAppraisal: 0.78 }),
    narrativeFacts: makeNarrativeFacts({ t12NoiTrend: 'down' }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_NEGATIVE_GUARD');
  assertEqual(guard?.fired ?? true, false, 't12 trend down → guard does not fire');
}

console.log('\nFalse_positive_guard:');
{
  // OVERVALUATION_GUARDRAIL_TRIGGERED capApplied → fires
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    valuationConclusion: makeValuationConclusion({
      capsApplied: [
        { reason: 'OVERVALUATION_GUARDRAIL_TRIGGERED', cappedTo: 13_750_000, basis: 'appraisal' },
      ],
    }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_POSITIVE_GUARD');
  assert(guard?.fired ?? false, 'overvaluation cap → False_positive_guard fires');
  assertEqual(guard?.points ?? 0, -15, 'fires with -15 points');
}
{
  // No triggers → does not fire
  const r = buildDoctrineEvaluation(defaultArgs());
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_POSITIVE_GUARD');
  assertEqual(guard?.fired ?? true, false, 'no triggers → guard does not fire');
}
{
  // PCA underfunded → CAPEX_SHORTFALL reason → guard fires
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({ pcaImmediate: 100_000, upfrontCapex: 30_000 }),
  });
  const guard = r.scoreAdjustments.find(a => a.ruleId === 'FALSE_POSITIVE_GUARD');
  assert(guard?.fired ?? false, 'PCA underfunded → False_positive_guard fires (CAPEX_SHORTFALL)');
}

/* --------------------------- score envelope ------------------------------ */

console.log('\n±25 envelope:');
{
  // Both fire: +12 + -15 = -3, inside ±25 → no scaling
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({
      dscr: 1.0,
      debtYield: 0.07,
      ltvAppraisal: 0.78,
      pcaImmediate: 100_000,
      upfrontCapex: 30_000,
    }),
    valuationConclusion: makeValuationConclusion({ finalValue: 10_000_000 }),
  });
  const total = r.scoreAdjustments.reduce((s, a) => s + a.points, 0);
  assert(Math.abs(total) <= 25, `|score adjustments sum| ≤ 25 (got ${total})`);
  assertClose(total, -3, 1e-9, 'sum is +12 + -15 = -3, no scaling needed');
}

/* ------------------------------ rating bands ----------------------------- */

console.log('\nRating bands:');
{
  const r = buildDoctrineEvaluation(defaultArgs());
  if (r.finalScore >= 75) assertEqual(r.ratingBand, 'Strong', 'finalScore ≥ 75 → Strong');
  else if (r.finalScore >= 60) assertEqual(r.ratingBand, 'Acceptable', 'finalScore ≥ 60 → Acceptable');
  else if (r.finalScore >= 50) assertEqual(r.ratingBand, 'Weak', 'finalScore ≥ 50 → Weak');
  else assertEqual(r.ratingBand, 'High Risk', 'finalScore < 50 → High Risk');
}
{
  // Strong inputs across the board → high score
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    adjustedInputs: makeAdjustedInputs({
      dscr: 1.50,
      debtYield: 0.13,
      ltvAppraisal: 0.50,
      top1IncomeShare: 0.10,
      pctIncomeExpiringWithinTerm: 0.10,
    }),
    crossCheckResult: makeCrossCheckResult(-0.10),
  });
  assert(r.finalScore > 0, 'strong fixture has positive score');
  assert(['Strong', 'Acceptable', 'Weak', 'High Risk'].includes(r.ratingBand), 'rating band valid');
}

/* ----------------------------- reasons + flags --------------------------- */

console.log('\nReason aggregation:');
{
  const r = buildDoctrineEvaluation(defaultArgs());
  assert(r.reasons.length > 0, 'reasons array populated');
  for (const reason of r.reasons) {
    assert(typeof reason.ruleId === 'string', 'each reason has ruleId');
    assert(typeof reason.reasonCode === 'string', 'each reason has reasonCode');
  }
}

console.log('\nFlag aggregation:');
{
  // Office Class C → asset-type flag fires
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    narrativeFacts: makeNarrativeFacts({ propertyClass: 'C' }),
  });
  assert(r.flags.includes('OFFICE_LOW_QUALITY_CLASS'), 'asset-type flag included');
}
{
  // Valuation cap fires → flag included
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    valuationConclusion: makeValuationConclusion({
      capsApplied: [
        { reason: 'OVERVALUATION_GUARDRAIL_TRIGGERED', cappedTo: 13_750_000, basis: 'appraisal' },
      ],
    }),
  });
  assert(r.flags.includes('OVERVALUATION_GUARDRAIL_TRIGGERED'), 'valuation cap flag included');
}
{
  // valuationFlags advisory passes through
  const r = buildDoctrineEvaluation({
    ...defaultArgs(),
    valuationConclusion: makeValuationConclusion({ valuationFlags: ['EXIT_CAP_TOO_TIGHT'] }),
  });
  assert(r.flags.includes('EXIT_CAP_TOO_TIGHT'), 'advisory valuation flag passed through');
}

/* ------------------------------- idempotency ----------------------------- */

console.log('\nIdempotency:');
{
  const a = buildDoctrineEvaluation(defaultArgs());
  const b = buildDoctrineEvaluation(defaultArgs());
  assertEqual(a.id, b.id, 'same inputs → same id');
  assertEqual(a.finalScore, b.finalScore, 'same inputs → same finalScore');
}

/* --------------------------- persistence round-trip ---------------------- */

console.log('\nPersistence round-trip:');
{
  // Build a fully chained record graph (real FKs throughout)
  const librarySnapshot = makeLibrarySnapshot();
  const narrativeFacts = makeNarrativeFacts();
  const adjustedInputs = makeAdjustedInputs({ librarySnapshotId: librarySnapshot.id });
  const crossCheckResult = makeCrossCheckResult(null, adjustedInputs.id);
  const stressOutputs = makeStressOutputs(adjustedInputs.id);
  const valuationConclusion = makeValuationConclusion({
    adjustedInputsId: adjustedInputs.id,
    stressOutputsId: stressOutputs.id,
    narrativeFactsId: narrativeFacts.id,
  });
  const assetProfile = makeProfile('Office');
  // Build a real ExtractionResult fixture so the FK from doctrine_evaluations resolves
  const extBody = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: '1.2' as const,
    dealRef: 'PERSIST-DEAL',
    rentRoll: null, t12: null, pca: null,
    appraisal: null, sellerUw: null, sellerUwOperatingStatement: null, asr: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
  };
  const extId = computeExtractionResultId(extBody);
  const extraction = { id: extId, ...extBody } as import('@cre/contracts').ExtractionResult;
  const args = {
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    crossCheckResult,
    stressOutputs,
    valuationConclusion,
    extractionResultId: extId,
  };
  const result = buildDoctrineEvaluation(args);

  const store = new RecordGraphStore(':memory:');
  store.insertLibrarySnapshot(librarySnapshot);
  store.insertNarrativeFacts(narrativeFacts);
  store.insertAdjustedInputs(adjustedInputs);
  store.insertCrossCheckResult(crossCheckResult);
  store.insertStressOutputs(stressOutputs);
  store.insertValuationConclusion(valuationConclusion);
  store.insertAssetProfile(assetProfile);
  store.insertExtractionResult(extraction);
  const r = store.insertDoctrineEvaluation(result);
  assert(r.inserted, 'doctrine evaluation persisted');

  const fetched = store.getDoctrineEvaluation(result.id);
  assert(fetched !== null, 'retrievable by id');
  assertEqual(fetched?.finalScore ?? -1, result.finalScore, 'finalScore round-trips');
  assertEqual(fetched?.ratingBand ?? '', result.ratingBand, 'ratingBand round-trips');
  assertEqual(
    fetched?.componentScores.length ?? -1,
    result.componentScores.length,
    'componentScores length round-trips',
  );
  store.close();
}

/* ------------------------ FK + version stamping ------------------------- */

console.log('\nFK + version stamping:');
{
  const args = defaultArgs();
  const r = buildDoctrineEvaluation(args);
  assertEqual(r.adjustedInputsId, args.adjustedInputs.id, 'adjustedInputsId FK');
  assertEqual(r.librarySnapshotId, args.librarySnapshot.id, 'librarySnapshotId FK');
  assertEqual(r.narrativeFactsId, args.narrativeFacts.id, 'narrativeFactsId FK');
  assertEqual(r.crossCheckResultId, args.crossCheckResult.id, 'crossCheckResultId FK');
  assertEqual(r.stressOutputsId, args.stressOutputs.id, 'stressOutputsId FK');
  assertEqual(r.valuationConclusionId, args.valuationConclusion.id, 'valuationConclusionId FK');
  assertEqual(r.doctrineVersion, '1.0', 'doctrineVersion');
  assertEqual(r.judgmentEngineVersion, '1.0', 'judgmentEngineVersion');
  assertEqual(r.stressEngineVersion, '1.0', 'stressEngineVersion');
  assertEqual(r.valuationEngineVersion, '1.0', 'valuationEngineVersion');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
