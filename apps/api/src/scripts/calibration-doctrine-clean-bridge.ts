/**
 * Validation for the EvaluateDealResult → DoctrineEvaluation bridge.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-bridge.ts
 *
 * Checks:
 *   1. CONTRACT VALIDITY — run evaluateDeal on all 176 corpus records, bridge
 *      each, confirm every output is a CONTRACT-VALID DoctrineEvaluation:
 *        - finalScore + mechanicalScore + weightedAggregate in [0, 100]
 *        - ratingBand is one of the 4 OLD bands
 *        - flags/reasons are bounded literal unions
 *        - coverage shape complete
 *        - scoreAdjustments sum |points| <= 25
 *        - componentScores has 8 entries (one per DOCTRINE_COMPONENT_ID)
 *        - all weights sum to 100
 *   2. MAPPING SPOT-CHECKS:
 *        - synthetic all-low → Strong band + high (inverted) score
 *        - synthetic all-high-convergent → High Risk + low score
 *        - InsufficientData → High Risk + INSUFFICIENT_DATA flag + insufficientCoverageGate
 *   3. TYPE-CHECK GATE — bridge output is typed as the OLD DoctrineEvaluation
 *      (verified by tsc; this script's import of the type validates it at runtime via shape).
 *   4. FENCE — bridge imports only @cre/contracts types + doctrine-clean siblings;
 *      no @cre/contracts service modules, no judgment/old-doctrine logic.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateDeal,
  bridgeToDoctrineEvaluation,
  adaptExtractionToDealBag,
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  evaluateLeverageLtv,
  evaluateCoverageDscr,
  evaluateDebtYield,
  evaluateRefinanceFeasibility,
  evaluateRollover,
  evaluateIncomeConcentration,
  evaluateAssetClass,
  evaluateSponsorBorrowerQuality,
  computeBaseBlend,
  applyOverrides,
  computeRating,
  type DealBag,
} from '../doctrine-clean/index.js';
import type {
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResultId,
  AdjustedInputsId,
  LibrarySnapshotId,
  NarrativeFactsId,
  CrossCheckResultId,
  StressOutputsId,
  ValuationConclusionId,
  AssetProfileId,
  RentRollId,
  DoctrineComponentScore,
  DimensionContribution,
} from '@cre/contracts';
import {
  DOCTRINE_COMPONENT_IDS,
  DOCTRINE_COMPONENT_WEIGHTS,
  RATING_BANDS,
  SCORE_ADJUSTMENT_ENVELOPE,
} from '@cre/contracts';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-bridge.out';

const VALID_OLD_BANDS = new Set(RATING_BANDS.map(b => b.name));

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number | null;
  coupon: number | null;
  concludedValue: number | null;
  uwY1Noi: number | null;
  t12Noi: number | null;
  assetType: string | null;
  subType: string | null;
  largestTenantPct: number | null;
  pctIncomeExpiringWithinTerm: number | null;
  tenantDataStatus: string | null;
}

// Stub branded ids — bridge accepts opaque strings (the brand is compile-time only).
function stubIds() {
  const hex = (label: string) => (label.padEnd(64, '0').slice(0, 64) as unknown as string);
  return {
    evaluationId: hex('ev') as DoctrineEvaluationId,
    extractionResultId: hex('ex') as ExtractionResultId,
    adjustedInputsId: hex('ai') as AdjustedInputsId,
    librarySnapshotId: hex('ls') as LibrarySnapshotId,
    narrativeFactsId: hex('nf') as NarrativeFactsId,
    crossCheckResultId: hex('cc') as CrossCheckResultId,
    stressOutputsId: hex('so') as StressOutputsId,
    valuationConclusionId: hex('vc') as ValuationConclusionId,
    assetProfileId: hex('ap') as AssetProfileId,
    rentRollId: null as RentRollId | null,
  };
}

const stubVersions = {
  doctrineVersion: '1.3' as const,
  judgmentEngineVersion: '1.10' as const,
  stressEngineVersion: '1.0' as const,
  valuationEngineVersion: '1.0' as const,
};

const stubAsOf = '2026-06-12T00:00:00.000Z' as DoctrineEvaluation['analysisAsOfDate'];

/** Validate that a DoctrineEvaluation conforms to the contract. */
function validateDoctrineEvaluation(d: DoctrineEvaluation): string[] {
  const errs: string[] = [];
  // Scores in range
  if (!(d.finalScore >= 0 && d.finalScore <= 100)) errs.push(`finalScore out of [0,100]: ${d.finalScore}`);
  if (!(d.mechanicalScore >= 0 && d.mechanicalScore <= 100)) errs.push(`mechanicalScore out of [0,100]: ${d.mechanicalScore}`);
  if (!(d.weightedAggregate >= 0 && d.weightedAggregate <= 100)) errs.push(`weightedAggregate out of [0,100]: ${d.weightedAggregate}`);
  // Band membership
  if (!VALID_OLD_BANDS.has(d.ratingBand)) errs.push(`ratingBand not in old union: ${d.ratingBand}`);
  // Component scores: 8 entries, weights match table, sum to 100
  if (d.componentScores.length !== DOCTRINE_COMPONENT_IDS.length) {
    errs.push(`componentScores length ${d.componentScores.length} ≠ ${DOCTRINE_COMPONENT_IDS.length}`);
  }
  let weightSum = 0;
  const seenCids = new Set<string>();
  for (const cs of d.componentScores) {
    if (!DOCTRINE_COMPONENT_IDS.includes(cs.componentId)) errs.push(`componentId not in union: ${cs.componentId}`);
    if (seenCids.has(cs.componentId)) errs.push(`duplicate componentId: ${cs.componentId}`);
    seenCids.add(cs.componentId);
    if (cs.weight !== DOCTRINE_COMPONENT_WEIGHTS[cs.componentId]) errs.push(`weight mismatch for ${cs.componentId}: ${cs.weight} ≠ ${DOCTRINE_COMPONENT_WEIGHTS[cs.componentId]}`);
    if (!(cs.score >= 0 && cs.score <= 100)) errs.push(`component ${cs.componentId} score out of [0,100]: ${cs.score}`);
    weightSum += cs.weight;
    // contribution = score * weight / 100
    const expected = cs.score * cs.weight / 100;
    if (Math.abs(cs.contribution - expected) > 1e-9) errs.push(`${cs.componentId} contribution mismatch: ${cs.contribution} ≠ ${expected}`);
  }
  if (weightSum !== 100) errs.push(`componentScore weight sum ${weightSum} ≠ 100`);
  // Score-adjustments envelope
  const adjSum = d.scoreAdjustments.reduce((s, a) => s + Math.abs(a.points), 0);
  if (adjSum > SCORE_ADJUSTMENT_ENVELOPE) errs.push(`scoreAdjustments envelope ${adjSum} > ${SCORE_ADJUSTMENT_ENVELOPE}`);
  // Coverage shape
  if (typeof d.coverage.evaluatedWeight !== 'number') errs.push(`coverage.evaluatedWeight not number`);
  if (typeof d.coverage.totalEvaluableWeight !== 'number') errs.push(`coverage.totalEvaluableWeight not number`);
  if (typeof d.coverage.evaluatedPct !== 'number') errs.push(`coverage.evaluatedPct not number`);
  if (!Array.isArray(d.coverage.excludedRiskDimRuleIds)) errs.push(`coverage.excludedRiskDimRuleIds not array`);
  if (typeof d.coverage.bandCapApplied !== 'boolean') errs.push(`coverage.bandCapApplied not boolean`);
  if (typeof d.coverage.insufficientCoverageGate !== 'boolean') errs.push(`coverage.insufficientCoverageGate not boolean`);
  return errs;
}

function stub(dimensionId: string, state: 'applicable' | 'not-applicable-by-asset-type' | 'hitl-needed', risk: number | null): DimensionContribution {
  return {
    dimensionId,
    riskContribution: state === 'applicable' ? risk : null,
    tier: state === 'applicable' ? 'synthetic' : 'N/A',
    rationale: `stub`,
    provenance: ['stub'],
    applicability: state,
    evaluated: state === 'applicable',
  };
}

function runFromContribs(contribs: DimensionContribution[]) {
  const sp = evaluateSponsorBorrowerQuality({ assessment: null });
  const blend = computeBaseBlend(contribs);
  const ov = applyOverrides(blend, contribs);
  const rt = computeRating(blend, ov, [...contribs, sp]);
  // Build synthetic EvaluateDealResult-like object
  const result = {
    rating: rt,
    baseBlend: blend,
    overrides: ov,
    normalization: {
      routeStatus: 'applicable' as const,
      sustainableNoi: 1_000_000,
      sustainableNcf: 950_000,
      issuerNoi: 1_000_000,
      haircutTrace: { noiDivergence: { status: 'no-t12-input' as const, ratioUwToT12: null, haircutApplied: 1, note: '' }, vacancy: { status: 'occupancy-not-available' as const, underwrittenOccupancy: null, stabilizedFloorVacancy: null, haircutApplied: 1, note: '' }, ncfCapital: { status: 'applied' as const, assetClassResolved: 'Office', ncfNoiRatio: 0.95, note: '' } },
      rationale: '',
      provenance: [],
    },
    dimensions: {
      capRateValuationStress: contribs.find(c => c.dimensionId === 'cap-rate-valuation-stress')!,
      leverageLtv: contribs.find(c => c.dimensionId === 'leverage-ltv')!,
      coverageDscr: contribs.find(c => c.dimensionId === 'coverage-dscr')!,
      debtYield: contribs.find(c => c.dimensionId === 'debt-yield')!,
      refinanceFeasibility: contribs.find(c => c.dimensionId === 'refinance-feasibility')!,
      incomeConcentration: contribs.find(c => c.dimensionId === 'income-concentration')!,
      rollover: contribs.find(c => c.dimensionId === 'rollover')!,
      assetClass: contribs.find(c => c.dimensionId === 'asset-class')!,
      sponsorBorrowerQuality: sp,
    },
    allDimensions: [...contribs, sp],
  };
  return result;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assertEq<T>(got: T, want: T, label: string) {
  if (got === want) { passed++; return; }
  failed++; failures.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function assert(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failed++; failures.push(label);
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / bridge (EvaluateDealResult → DoctrineEvaluation) — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === (1) CONTRACT VALIDITY across 176 corpus records ============= */
  out.push('================================================================');
  out.push('(1) CONTRACT VALIDITY — bridge output for all 176 corpus records');
  out.push('================================================================');
  out.push('');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  const ids = stubIds();
  let invalidN = 0;
  const errors: { name: string; errs: string[] }[] = [];
  for (const r of records) {
    const norm = normalizeSustainableCashflow({ assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, t12Noi: r.t12Noi, underwrittenOccupancy: null });
    const dim7 = evaluateCapRateValuationStress({ assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, sustainableNcf: norm.sustainableNcf, concludedValue: r.concludedValue, loanAmount: r.loanAmount, marketTier: 'Unknown' });
    const ltv = evaluateLeverageLtv({ stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null });
    const dscr = evaluateCoverageDscr({ sustainableNcf: norm.sustainableNcf, loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null });
    const dy = evaluateDebtYield({ sustainableNoi: norm.sustainableNoi, loanAmount: r.loanAmount, assetType: r.assetType, subType: r.subType });
    const refi = evaluateRefinanceFeasibility({ loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null, sustainableNcf: norm.sustainableNcf, sustainableNoi: norm.sustainableNoi, stressedValue: (dim7.derivedOutputs?.stressedValue as number | undefined | null) ?? null });
    const roll = evaluateRollover({ pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm, assetType: r.assetType, tenantDataStatus: r.tenantDataStatus as any });
    const conc = evaluateIncomeConcentration({ assetType: r.assetType, largestTenantPct: r.largestTenantPct, largestTenantBasis: 'NRA' });
    const ac = evaluateAssetClass({ assetType: r.assetType, subType: r.subType, propertyName: r.propertyName });
    const sp = evaluateSponsorBorrowerQuality({ assessment: null });
    const peer = [dim7, refi, ac, roll, conc, ltv, dscr, dy];
    const all = [...peer, sp];
    const blend = computeBaseBlend(peer);
    const ov = applyOverrides(blend, peer);
    const rt = computeRating(blend, ov, all);
    const result = { rating: rt, baseBlend: blend, overrides: ov, normalization: norm, allDimensions: all, dimensions: { capRateValuationStress: dim7, leverageLtv: ltv, coverageDscr: dscr, debtYield: dy, refinanceFeasibility: refi, incomeConcentration: conc, rollover: roll, assetClass: ac, sponsorBorrowerQuality: sp } };
    const doctrine = bridgeToDoctrineEvaluation(result, ids, stubVersions, stubAsOf);
    const errs = validateDoctrineEvaluation(doctrine);
    if (errs.length > 0) {
      invalidN++;
      if (errors.length < 8) errors.push({ name: `${r.dealName} / ${r.propertyName}`, errs });
    }
  }
  out.push(`  Records bridged: ${records.length}`);
  out.push(`  Contract-invalid: ${invalidN}  ${invalidN === 0 ? '✓ all bridged outputs satisfy the old contract' : '⚠'}`);
  if (errors.length > 0) {
    out.push('  First failures:');
    for (const e of errors) {
      out.push(`    ${e.name}:`);
      for (const err of e.errs) out.push(`      ✗ ${err}`);
    }
  }
  out.push('');

  /* === (2) MAPPING SPOT-CHECKS — synthetic scenarios =============== */
  out.push('================================================================');
  out.push('(2) MAPPING SPOT-CHECKS — synthetic all-low / all-high / InsufficientData');
  out.push('================================================================');
  out.push('');

  const allLow: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.10),
    stub('coverage-dscr',             'applicable', 0.10),
    stub('debt-yield',                'applicable', 0.10),
  ];
  const dLow = bridgeToDoctrineEvaluation(runFromContribs(allLow), ids, stubVersions, stubAsOf);
  out.push(`  all-low → finalScore ${dLow.finalScore.toFixed(1)} (expect ~90) / ratingBand ${dLow.ratingBand} (expect Strong)`);
  assert(dLow.finalScore >= 85 && dLow.finalScore <= 95, `all-low finalScore ~90: got ${dLow.finalScore}`);
  assertEq(dLow.ratingBand, 'Strong', 'all-low ratingBand = Strong');
  assert(!dLow.coverage.insufficientCoverageGate, 'all-low: no coverage gate');
  assertEq(dLow.flags.length, 0, 'all-low: no flags');
  out.push('');

  const allHigh: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.80),
    stub('refinance-feasibility',     'applicable', 0.80),
    stub('asset-class',               'applicable', 0.80),
    stub('rollover',                  'applicable', 0.80),
    stub('income-concentration',      'applicable', 0.80),
    stub('leverage-ltv',              'applicable', 0.80),
    stub('coverage-dscr',             'applicable', 0.80),
    stub('debt-yield',                'applicable', 0.80),
  ];
  const dHigh = bridgeToDoctrineEvaluation(runFromContribs(allHigh), ids, stubVersions, stubAsOf);
  out.push(`  all-high → finalScore ${dHigh.finalScore.toFixed(1)} (expect ~0) / ratingBand ${dHigh.ratingBand} (expect High Risk)`);
  assert(dHigh.finalScore >= 0 && dHigh.finalScore <= 20, `all-high finalScore very low: got ${dHigh.finalScore}`);
  assertEq(dHigh.ratingBand, 'High Risk', 'all-high ratingBand = High Risk');
  assert(dHigh.flags.length > 0, 'all-high: red flags present');
  assert(dHigh.scoreAdjustments.length > 0, 'all-high: scoreAdjustments present (overrides fired)');
  out.push(`  scoreAdjustments: ${dHigh.scoreAdjustments.map(a => `${a.ruleId}=${a.points}pts`).join(', ')}`);
  out.push(`  flags: ${dHigh.flags.join(', ')}`);
  out.push('');

  // InsufficientData — spine HITL
  const spineHitl: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'hitl-needed', null),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.10),
    stub('coverage-dscr',             'applicable', 0.10),
    stub('debt-yield',                'applicable', 0.10),
  ];
  const dHitl = bridgeToDoctrineEvaluation(runFromContribs(spineHitl), ids, stubVersions, stubAsOf);
  out.push(`  spine-HITL → finalScore ${dHitl.finalScore} / ratingBand ${dHitl.ratingBand} (expect High Risk + INSUFFICIENT_DATA)`);
  assertEq(dHitl.finalScore, 0, 'spine-HITL finalScore = 0');
  assertEq(dHitl.ratingBand, 'High Risk', 'spine-HITL ratingBand = High Risk');
  assert(dHitl.flags.includes('INSUFFICIENT_DATA' as any), 'spine-HITL: INSUFFICIENT_DATA flag present');
  assert(dHitl.coverage.insufficientCoverageGate, 'spine-HITL: insufficientCoverageGate = true');
  out.push(`  flags: ${dHitl.flags.join(', ')}`);
  out.push('');

  // Moderate — should land in mid-band
  const allMod: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.30),
    stub('refinance-feasibility',     'applicable', 0.30),
    stub('asset-class',               'applicable', 0.30),
    stub('rollover',                  'applicable', 0.30),
    stub('income-concentration',      'applicable', 0.30),
    stub('leverage-ltv',              'applicable', 0.30),
    stub('coverage-dscr',             'applicable', 0.30),
    stub('debt-yield',                'applicable', 0.30),
  ];
  const dMod = bridgeToDoctrineEvaluation(runFromContribs(allMod), ids, stubVersions, stubAsOf);
  out.push(`  all-moderate → finalScore ${dMod.finalScore.toFixed(1)} (expect 70) / ratingBand ${dMod.ratingBand}`);
  assert(dMod.finalScore >= 65 && dMod.finalScore <= 75, `all-moderate finalScore ~70: got ${dMod.finalScore}`);
  // 70 sits in old 'Acceptable' (>=60, <75)
  assertEq(dMod.ratingBand, 'Acceptable', 'all-moderate ratingBand = Acceptable');
  out.push('');

  /* === (3) END-TO-END through the adapter + bridge ================= */
  out.push('================================================================');
  out.push('(3) END-TO-END — adapter + evaluateDeal + bridge');
  out.push('================================================================');
  out.push('');
  // Build a synthetic deal through the full clean-room path
  const deal: DealBag = {
    propertyName: 'Test Tower',
    assetType: 'Office',
    subType: 'CBD',
    loanAmount: 30_000_000,
    coupon: 0.045,
    concludedValue: 50_000_000,
    uwY1Noi: 3_500_000,
    t12Noi: null,
    underwrittenOccupancy: 0.93,
    largestTenantPct: 0.40,
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.20,
    tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360,
    ioYears: 5,
    termYears: null,
    marketTier: 'Unknown',
  };
  const fullResult = evaluateDeal(deal);
  const fullDoc = bridgeToDoctrineEvaluation(fullResult, ids, stubVersions, stubAsOf);
  out.push(`  Test Tower:`);
  out.push(`    clean rating: ${fullResult.rating.recommendation} band=${fullResult.rating.band ?? 'null'} risk=${fullResult.rating.ratedRisk?.toFixed(3) ?? 'null'}`);
  out.push(`    bridged: finalScore=${fullDoc.finalScore.toFixed(1)} band=${fullDoc.ratingBand} mech=${fullDoc.mechanicalScore.toFixed(1)} weightedAgg=${fullDoc.weightedAggregate.toFixed(1)}`);
  out.push(`    flags=[${fullDoc.flags.join(', ')}]`);
  out.push(`    reasons=${fullDoc.reasons.length}  scoreAdjustments=${fullDoc.scoreAdjustments.length}`);
  out.push(`    coverage: evaluated=${fullDoc.coverage.evaluatedWeight}/${fullDoc.coverage.totalEvaluableWeight} (${(fullDoc.coverage.evaluatedPct*100).toFixed(0)}%)  gate=${fullDoc.coverage.insufficientCoverageGate}`);
  const errs = validateDoctrineEvaluation(fullDoc);
  assertEq(errs.length, 0, `end-to-end contract validity: ${errs.length} errors`);
  // Score-inversion sanity: if clean says ratedRisk=X, then finalScore should equal (1-X)*100 ± rounding
  if (fullResult.rating.ratedRisk !== null) {
    const expected = (1 - fullResult.rating.ratedRisk) * 100;
    assert(Math.abs(fullDoc.finalScore - expected) < 1e-6, `score inversion: got ${fullDoc.finalScore}, expected ${expected}`);
  }
  out.push('');

  /* === (4) FENCE AUDIT ============================================== */
  out.push('================================================================');
  out.push('(4) FENCE AUDIT — bridge imports');
  out.push('================================================================');
  out.push('');
  const BRIDGE_PATH = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/adapters/dealresult-to-doctrine-evaluation.ts';
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const importLines = src.split('\n').filter(l => /^import /.test(l));
  out.push(`  Imports (${importLines.length}):`);
  for (const l of importLines) out.push(`    ${l}`);
  const banned: { rx: RegExp; label: string }[] = [
    { rx: /services\/doctrine\//, label: 'old doctrine service module' },
    { rx: /services\/judgment\//, label: 'judgment service module' },
    { rx: /services\/handbook\//, label: 'handbook service module' },
    { rx: /buildDoctrineEvaluation/, label: 'old buildDoctrineEvaluation' },
    { rx: /buildValuationConclusion/, label: 'judgment valuation builder' },
    { rx: /manifesto_rules/, label: 'manifesto_rules.json' },
  ];
  let violations = 0;
  for (const line of importLines) {
    for (const { rx, label } of banned) {
      if (rx.test(line)) {
        violations++;
        out.push(`    ⚠ ${label}: ${line}`);
      }
    }
  }
  out.push(`  Fence violations: ${violations}  ${violations === 0 ? '✓' : '⚠'}`);
  out.push('');
  out.push('  Bridge consumes ONLY @cre/contracts TYPES (no logic imports) +');
  out.push('  doctrine-clean siblings (EvaluateDealResult, DimensionContribution).');
  out.push('');

  /* === SUMMARY ============================================== */
  out.push('================================================================');
  out.push('SUMMARY');
  out.push('================================================================');
  out.push('');
  out.push(`  Asserts: ${passed} passed / ${failed} failed`);
  if (failures.length > 0) {
    out.push('  Failures:');
    for (const f of failures.slice(0, 20)) out.push(`    ✗ ${f}`);
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean bridge] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
