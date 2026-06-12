/**
 * Sanity validation for doctrine-clean scoring stage 3 (final rating).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-stage3-rating.ts
 *
 * SANITY (not loss-fit):
 *   - REACHABILITY: all-low synthetic → Strong; all-high-convergent → Decline
 *     (proves the band cuts let the full range surface)
 *   - COVERAGE GATING: spine-HITL → InsufficientData; mostly-HITL → InsufficientData
 *   - SPONSOR MODIFIER: strong-sponsor shifts band down; severe shifts band up;
 *     bounded so neither can fully cross the rating spectrum alone
 *   - CORPUS DISTRIBUTION: band counts; informational loss-class skew
 *   - REFI ARTIFACT NOTE: refi is now the dominant severe driver (43) on this corpus
 *     because amort schedule isn't extracted → exit metrics ≈ going-in metrics. If
 *     bands skew high, that's the corpus artifact, not the bands.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
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
  RATING_BAND_CUTS,
  COVERAGE_RELIABILITY_THRESHOLD,
  SPINE_DIM_ID,
} from '../doctrine-clean/index.js';
import type {
  DimensionContribution,
  SponsorAssessment,
  RatingBand,
  Recommendation,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-stage3-rating.out';

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

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[i - 1]! + s[i]!) / 2 : s[i]!;
}
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i]!;
}

function stub(
  dimensionId: string,
  state: 'applicable' | 'not-applicable-by-asset-type' | 'hitl-needed',
  risk: number | null,
): DimensionContribution {
  return {
    dimensionId,
    riskContribution: state === 'applicable' ? risk : null,
    tier: state === 'applicable' ? 'synthetic' : 'N/A',
    rationale: `synthetic stub (${state})`,
    provenance: ['synthetic'],
    applicability: state,
    evaluated: state === 'applicable',
  };
}

function runRating(
  contribs: DimensionContribution[],
  sponsorAssessment: SponsorAssessment | null = null,
) {
  const sp = evaluateSponsorBorrowerQuality({ assessment: sponsorAssessment });
  const all = [...contribs, sp];
  const peerOnly = contribs;
  const blend = computeBaseBlend(peerOnly);
  const ov = applyOverrides(blend, peerOnly);
  const rt = computeRating(blend, ov, all);
  return { blend, ov, rt, sponsor: sp };
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / scoring stage 3 (final rating) — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Band cuts: Strong [0, ${RATING_BAND_CUTS.strongMax.toFixed(2)}) / Acceptable [, ${RATING_BAND_CUTS.acceptableMax.toFixed(2)}) / Watch [, ${RATING_BAND_CUTS.watchMax.toFixed(2)}) / Elevated [, ${RATING_BAND_CUTS.elevatedMax.toFixed(2)}) / Decline [, 1.0]`);
  out.push(`Coverage gate: spine (${SPINE_DIM_ID}) resolved AND reliability >= ${(COVERAGE_RELIABILITY_THRESHOLD * 100).toFixed(0)}%`);
  out.push('SANITY only — reachability + gating + sponsor + corpus distribution. NO loss-fit.');
  out.push('');

  /* === INVARIANT: REACHABILITY ========================================= */
  out.push('================================================================');
  out.push('REACHABILITY — all-low → Strong; all-high-convergent → Decline');
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
  const rLow = runRating(allLow);
  out.push(`  all-low resolved (no sponsor): base ${rLow.blend.baseRisk!.toFixed(3)} → post-override ${rLow.ov.finalRisk!.toFixed(3)} → rated ${rLow.rt.ratedRisk!.toFixed(3)} → band ${rLow.rt.band} → ${rLow.rt.recommendation}`);
  out.push(`    Expected: Strong / Approve.  ${rLow.rt.band === 'Strong' ? '✓' : '⚠'}`);
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
  const rHigh = runRating(allHigh);
  out.push(`  all-high-convergent: base ${rHigh.blend.baseRisk!.toFixed(3)} → post-override ${rHigh.ov.finalRisk!.toFixed(3)} → rated ${rHigh.rt.ratedRisk!.toFixed(3)} → band ${rHigh.rt.band} → ${rHigh.rt.recommendation}`);
  out.push(`    Expected: Decline.  ${rHigh.rt.band === 'Decline' ? '✓' : '⚠'}`);
  out.push('');

  // Intermediate
  const uniformElev: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.55),
    stub('refinance-feasibility',     'applicable', 0.55),
    stub('asset-class',               'applicable', 0.55),
    stub('rollover',                  'applicable', 0.55),
    stub('income-concentration',      'applicable', 0.55),
    stub('leverage-ltv',              'applicable', 0.55),
    stub('coverage-dscr',             'applicable', 0.55),
    stub('debt-yield',                'applicable', 0.55),
  ];
  const rUni = runRating(uniformElev);
  out.push(`  all-elevated: base ${rUni.blend.baseRisk!.toFixed(3)} → post-override ${rUni.ov.finalRisk!.toFixed(3)} → rated ${rUni.rt.ratedRisk!.toFixed(3)} → band ${rUni.rt.band} → ${rUni.rt.recommendation}`);
  out.push(`    Expected: Decline via convergence amplifier (0.55 + 0.20 = 0.75 >= 0.65).  ${rUni.rt.band === 'Decline' ? '✓' : '⚠'}`);
  out.push('');

  const allModerate: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.30),
    stub('refinance-feasibility',     'applicable', 0.30),
    stub('asset-class',               'applicable', 0.30),
    stub('rollover',                  'applicable', 0.30),
    stub('income-concentration',      'applicable', 0.30),
    stub('leverage-ltv',              'applicable', 0.30),
    stub('coverage-dscr',             'applicable', 0.30),
    stub('debt-yield',                'applicable', 0.30),
  ];
  const rMod = runRating(allModerate);
  out.push(`  all-moderate: rated ${rMod.rt.ratedRisk!.toFixed(3)} → band ${rMod.rt.band} → ${rMod.rt.recommendation}`);
  out.push(`    Expected: Watch (0.30 sits at Watch lower edge).  ${rMod.rt.band === 'Watch' ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT: COVERAGE GATING ====================================== */
  out.push('================================================================');
  out.push('COVERAGE GATING — spine-HITL → InsufficientData; thin coverage → InsufficientData');
  out.push('================================================================');
  out.push('');
  // Spine HITL — even if everything else is low.
  const spineHitl: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'hitl-needed', null),     // spine HITL
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.10),
    stub('coverage-dscr',             'applicable', 0.10),
    stub('debt-yield',                'applicable', 0.10),
  ];
  const rSpineHitl = runRating(spineHitl);
  out.push(`  Spine HITL, others resolved at low risk: recommendation = ${rSpineHitl.rt.recommendation}  band = ${rSpineHitl.rt.band ?? 'null'}`);
  out.push(`    Reason: ${rSpineHitl.rt.coverageGateReason ?? '<none>'}`);
  out.push(`    Expected: InsufficientData.  ${rSpineHitl.rt.recommendation === 'InsufficientData' ? '✓' : '⚠'}`);
  out.push('');

  // Mostly HITL — spine resolved but reliability below threshold.
  const thinCoverage: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),       // spine OK
    stub('refinance-feasibility',     'hitl-needed', null),
    stub('asset-class',               'hitl-needed', null),
    stub('rollover',                  'hitl-needed', null),
    stub('income-concentration',      'hitl-needed', null),
    stub('leverage-ltv',              'hitl-needed', null),
    stub('coverage-dscr',             'hitl-needed', null),
    stub('debt-yield',                'hitl-needed', null),
  ];
  const rThin = runRating(thinCoverage);
  out.push(`  Spine OK, 7 of 8 HITL: recommendation = ${rThin.rt.recommendation}`);
  out.push(`    Reliability ${(rThin.rt.coverageReliability * 100).toFixed(0)}%; reason: ${rThin.rt.coverageGateReason ?? '<none>'}`);
  out.push(`    Expected: InsufficientData (reliability 12.5% < 50%).  ${rThin.rt.recommendation === 'InsufficientData' ? '✓' : '⚠'}`);
  out.push('');

  // N/A does NOT penalize: multifamily with rollover + concentration N/A; 6 applicable, 0 HITL.
  const multifamily: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'not-applicable-by-asset-type', null),
    stub('income-concentration',      'not-applicable-by-asset-type', null),
    stub('leverage-ltv',              'applicable', 0.10),
    stub('coverage-dscr',             'applicable', 0.10),
    stub('debt-yield',                'applicable', 0.10),
  ];
  const rMF = runRating(multifamily);
  out.push(`  Multifamily-style (rollover+concentration N/A, others low): recommendation = ${rMF.rt.recommendation}  reliability ${(rMF.rt.coverageReliability * 100).toFixed(0)}%`);
  out.push(`    Expected: Strong / Approve — N/A doesn't penalize.  ${rMF.rt.band === 'Strong' && rMF.rt.recommendation === 'Approve' ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT: SPONSOR MODIFIER ===================================== */
  out.push('================================================================');
  out.push('SPONSOR MODIFIER — shifts band, bounded ±0.20');
  out.push('================================================================');
  out.push('');
  // Base setup: all-moderate (0.30) → Watch (0.30 sits at Watch lower edge).
  // Strong sponsor (-0.20) → Acceptable (0.10) or Strong (depending on cut).
  // Severe factor-4 (+0.20) → Watch/Elevated boundary (0.50).
  const baseModerate = allModerate;
  const strongSponsor: SponsorAssessment = {
    experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong',
    priorCreditEvents: 'Strong', managementQuality: 'Strong',
  };
  const severeSponsor: SponsorAssessment = {
    experience: 'Neutral', financialStrength: 'Neutral', alignment: 'Neutral',
    priorCreditEvents: 'Severe', managementQuality: 'Neutral',
  };
  const rStrong = runRating(baseModerate, strongSponsor);
  const rSev = runRating(baseModerate, severeSponsor);
  const rNo = runRating(baseModerate);
  out.push(`  All-moderate base (no sponsor):  rated ${rNo.rt.ratedRisk!.toFixed(3)} → ${rNo.rt.band} / ${rNo.rt.recommendation}`);
  out.push(`  All-moderate + Strong sponsor:    rated ${rStrong.rt.ratedRisk!.toFixed(3)} → ${rStrong.rt.band} / ${rStrong.rt.recommendation}  (modifier ${rStrong.rt.sponsorModifierValue.toFixed(2)})`);
  out.push(`  All-moderate + Severe factor-4:   rated ${rSev.rt.ratedRisk!.toFixed(3)} → ${rSev.rt.band} / ${rSev.rt.recommendation}  (modifier +${rSev.rt.sponsorModifierValue.toFixed(2)})`);
  out.push('');
  // Bound check: strong sponsor on uniform-elevated should NOT rescue Decline.
  const rStrongEl = runRating(uniformElev, strongSponsor);
  const rSevLow = runRating(allLow, severeSponsor);
  out.push(`  Uniform-elevated + Strong sponsor: rated ${rStrongEl.rt.ratedRisk!.toFixed(3)} → ${rStrongEl.rt.band} / ${rStrongEl.rt.recommendation}`);
  out.push(`    Sponsor cannot rescue a Decline outright (0.75 - 0.20 = 0.55 → Elevated; bounded discipline).  ${rStrongEl.rt.band !== 'Strong' && rStrongEl.rt.band !== 'Acceptable' ? '✓' : '⚠'}`);
  out.push(`  All-low + Severe factor-4:        rated ${rSevLow.rt.ratedRisk!.toFixed(3)} → ${rSevLow.rt.band} / ${rSevLow.rt.recommendation}`);
  out.push(`    Severe cannot push all-low to Decline alone (0.10 + 0.20 = 0.30 → Watch; bounded discipline).  ${rSevLow.rt.band !== 'Decline' ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT: BAND CUTS ============================================ */
  out.push('================================================================');
  out.push('BAND MAPPING — risk → band edge cases');
  out.push('================================================================');
  out.push('');
  // Spot-check the cut boundaries
  const cutTests: { risk: number; expected: RatingBand }[] = [
    { risk: 0.00, expected: 'Strong' },
    { risk: 0.149, expected: 'Strong' },
    { risk: 0.15, expected: 'Acceptable' },
    { risk: 0.299, expected: 'Acceptable' },
    { risk: 0.30, expected: 'Watch' },
    { risk: 0.449, expected: 'Watch' },
    { risk: 0.45, expected: 'Elevated' },
    { risk: 0.649, expected: 'Elevated' },
    { risk: 0.65, expected: 'Decline' },
    { risk: 1.00, expected: 'Decline' },
  ];
  let cutOk = 0;
  for (const tc of cutTests) {
    // Build a stub that produces this exact post-override risk.
    // Simplest: use all-low base then directly check mapToBand via a manual construction.
    // Use a single contrib with the desired riskContribution to get base = risk.
    const single: DimensionContribution[] = [
      stub('cap-rate-valuation-stress', 'applicable', tc.risk),
      stub('refinance-feasibility',     'applicable', tc.risk),
      stub('asset-class',               'applicable', tc.risk),
      stub('rollover',                  'applicable', tc.risk),
      stub('income-concentration',      'applicable', tc.risk),
      stub('leverage-ltv',              'applicable', tc.risk),
      stub('coverage-dscr',             'applicable', tc.risk),
      stub('debt-yield',                'applicable', tc.risk),
    ];
    const r = runRating(single);
    const got = r.rt.band;
    // For risks 0.55 and 0.65, overrides amplify — so the band may be shifted.
    // Only check boundaries where overrides don't fire (risks < 0.55).
    if (tc.risk < 0.55) {
      const ok = got === tc.expected;
      if (ok) cutOk++;
      out.push(`  risk=${tc.risk.toFixed(3)} → band ${got}  (expected ${tc.expected})  ${ok ? '✓' : '⚠'}`);
    }
  }
  out.push('  (risks >= 0.55 trigger overrides → band may shift; not a band-cut test)');
  out.push('');

  /* === CORPUS DISTRIBUTION ============================================= */
  out.push('================================================================');
  out.push('CORPUS DISTRIBUTION — full pipeline on the clean backbone corpus');
  out.push('================================================================');
  out.push('');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push('');

  const results = records.map(r => {
    const norm = normalizeSustainableCashflow({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, t12Noi: r.t12Noi,
      underwrittenOccupancy: null,
    });
    const dim7 = evaluateCapRateValuationStress({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi,
      sustainableNcf: norm.sustainableNcf, concludedValue: r.concludedValue,
      loanAmount: r.loanAmount, marketTier: 'Unknown',
    });
    const ltv = evaluateLeverageLtv({ stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null });
    const dscr = evaluateCoverageDscr({
      sustainableNcf: norm.sustainableNcf, loanAmount: r.loanAmount, coupon: r.coupon,
      amortMonths: null, ioYears: null, termYears: null,
    });
    const dy = evaluateDebtYield({
      sustainableNoi: norm.sustainableNoi, loanAmount: r.loanAmount, assetType: r.assetType, subType: r.subType,
    });
    const refi = evaluateRefinanceFeasibility({
      loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null,
      sustainableNcf: norm.sustainableNcf, sustainableNoi: norm.sustainableNoi,
      stressedValue: (dim7.derivedOutputs?.stressedValue as number | undefined | null) ?? null,
    });
    const roll = evaluateRollover({
      pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm, assetType: r.assetType,
      tenantDataStatus: r.tenantDataStatus as
        | 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null,
    });
    const conc = evaluateIncomeConcentration({
      assetType: r.assetType, largestTenantPct: r.largestTenantPct, largestTenantBasis: 'NRA',
    });
    const ac = evaluateAssetClass({
      assetType: r.assetType, subType: r.subType, propertyName: r.propertyName,
    });
    const peer: DimensionContribution[] = [dim7, refi, ac, roll, conc, ltv, dscr, dy];
    const sponsor = evaluateSponsorBorrowerQuality({ assessment: null });    // corpus: universally inert
    const all: DimensionContribution[] = [...peer, sponsor];
    const blend = computeBaseBlend(peer);
    const ov = applyOverrides(blend, peer);
    const rt = computeRating(blend, ov, all);
    return { record: r, blend, ov, rt };
  });

  // Band + recommendation distribution
  const bandCounts: Record<string, number> = {};
  const recCounts: Record<string, number> = {};
  for (const r of results) {
    const b = r.rt.band ?? 'InsufficientData';
    bandCounts[b] = (bandCounts[b] ?? 0) + 1;
    recCounts[r.rt.recommendation] = (recCounts[r.rt.recommendation] ?? 0) + 1;
  }
  out.push(`  Band distribution (n=${results.length}):`);
  for (const b of ['Strong', 'Acceptable', 'Watch', 'Elevated', 'Decline', 'InsufficientData'] as const) {
    const n = bandCounts[b] ?? 0;
    const pct = (n / results.length * 100).toFixed(1);
    const bar = '█'.repeat(Math.min(60, Math.round(n / 2)));
    out.push(`    ${b.padEnd(18)} ${n.toString().padStart(3)} (${pct}%)  ${bar}`);
  }
  out.push('');
  out.push(`  Recommendation distribution:`);
  for (const r of ['Approve', 'ApproveWithConditions', 'Decline', 'InsufficientData'] as const) {
    const n = recCounts[r] ?? 0;
    const pct = (n / results.length * 100).toFixed(1);
    out.push(`    ${r.padEnd(24)} ${n.toString().padStart(3)} (${pct}%)`);
  }
  out.push('');

  // ratedRisk distribution (excluding InsufficientData)
  const ratedRisks = results.map(r => r.rt.ratedRisk).filter((x): x is number => x !== null);
  out.push(`  ratedRisk distribution (n=${ratedRisks.length} resolved):`);
  out.push(`    min ${Math.min(...ratedRisks).toFixed(3)}  p25 ${quantile(ratedRisks,0.25).toFixed(3)}  median ${median(ratedRisks).toFixed(3)}  p75 ${quantile(ratedRisks,0.75).toFixed(3)}  max ${Math.max(...ratedRisks).toFixed(3)}  mean ${mean(ratedRisks).toFixed(3)}`);
  out.push('');

  // Loss-class skew (informational; clean SHOULD skew safer DIRECTIONALLY)
  out.push(`  Loss-class skew (informational — corpus is signal-weighted, NOT representative):`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const xs = results.filter(r => r.record.outcomeClass === cls);
    const bandsHere: Record<string, number> = {};
    for (const r of xs) {
      const b = r.rt.band ?? 'InsufficientData';
      bandsHere[b] = (bandsHere[b] ?? 0) + 1;
    }
    out.push(`    ${cls.padEnd(12)} n=${xs.length}`);
    for (const b of ['Strong', 'Acceptable', 'Watch', 'Elevated', 'Decline', 'InsufficientData'] as const) {
      const n = bandsHere[b] ?? 0;
      if (n === 0) continue;
      out.push(`        ${b.padEnd(18)} ${n.toString().padStart(3)} (${(n / xs.length * 100).toFixed(0)}%)`);
    }
  }
  out.push('');

  // Coverage-gating fires breakdown
  const gateFailures = results.filter(r => r.rt.coverageGateFailed);
  const spineHitlCount = gateFailures.filter(r => !r.rt.spineResolved).length;
  const reliabilityCount = gateFailures.filter(r => r.rt.spineResolved && r.rt.coverageReliability < COVERAGE_RELIABILITY_THRESHOLD).length;
  out.push(`  Coverage-gate failures: ${gateFailures.length}/${results.length}`);
  out.push(`    spine (dim 7) HITL: ${spineHitlCount}`);
  out.push(`    spine OK but reliability < ${(COVERAGE_RELIABILITY_THRESHOLD * 100).toFixed(0)}%: ${reliabilityCount}`);
  out.push('');

  // Refi-driver artifact note
  const severeFromRefi = results.filter(r => r.ov.severeFloorFired && r.ov.severeFlaggedDims.includes('refinance-feasibility')).length;
  out.push(`  Refi-as-dominant-severe-driver: ${severeFromRefi} records (= refi alone hits the high-tier threshold).`);
  out.push(`  ARTIFACT NOTE: corpus does not extract amortMonths/ioYears/termYears, so refi's exit metrics`);
  out.push(`  collapse to going-in metrics. This inflates the refi severe-flag rate; bands inherit that skew.`);
  out.push(`  Mitigation = corpus enrichment (extract amort schedule), NOT a band re-tune here.`);
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old scorer');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for stage 3 traces ONLY to:');
  out.push('    - sponsor (dim 9) bounded signed modifier ±0.20 (DBRS ~2-notch convention)');
  out.push('    - coverage gating: spine resolved + reliability >= 50%');
  out.push('    - five-band mapping with cuts calibrated for reachability, NOT corpus-fit');
  out.push('    - 3-action recommendation (Approve / ApproveWithConditions / Decline / InsufficientData)');
  out.push('  NEVER to manifesto_rules.json / old scorer / old doctrine.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean stage 3] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
