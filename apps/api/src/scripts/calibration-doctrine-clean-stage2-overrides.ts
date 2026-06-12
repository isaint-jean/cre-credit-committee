/**
 * Sanity validation for doctrine-clean scoring stage 2 (overrides).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-stage2-overrides.ts
 *
 * SANITY (not loss-fit). What we verify:
 *
 *   SYNTHETIC INVARIANTS:
 *     - severe floor: one dim at 0.80, rest at 0.10 → base ~ 0.17 →
 *       floored to 0.45
 *     - severe floor (no overshoot): one dim at 0.80, rest at 0.55 →
 *       no upward push (floor doesn't push past existing risk)
 *     - convergence non-trigger: 1 elevated → no amplifier
 *     - convergence non-trigger: 2 elevated → no amplifier (below 3)
 *     - convergence trigger: 3 elevated+ → +0.05 amplification
 *     - convergence: 4 → +0.10; 5 → +0.15; 6 → +0.20
 *     - high convergence reaches decline range: 6 signals at 0.55
 *       (uniform-elevated) → 0.55 + 0.20 = 0.75 (>= 0.65 decline)
 *     - cap at 1.0: 6 high signals → 0.80 + 0.20 = 1.00 (clamped)
 *     - ratio-family counted ONCE in convergence (3 ratios at high
 *       count as 1 signal at the post-collapse level)
 *     - sponsor (9) not part of overrides
 *
 *   CORPUS DISTRIBUTION:
 *     Run pipeline on 176 records. Report:
 *       - how many records fire severe floor
 *       - how many fire convergence amplifier
 *       - post-override risk distribution (compared to base)
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
  computeBaseBlend,
  applyOverrides,
  SEVERE_HIGH_TIER_THRESHOLD,
  SEVERE_FLOOR,
  ELEVATED_PLUS_THRESHOLD,
  CONVERGENCE_TRIGGER_COUNT,
  CONVERGENCE_AMPLIFY_PER_SIGNAL,
} from '../doctrine-clean/index.js';
import type { DimensionContribution } from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-stage2-overrides.out';

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

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / scoring stage 2 (overrides) — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`SEVERE_HIGH_TIER_THRESHOLD=${SEVERE_HIGH_TIER_THRESHOLD.toFixed(2)}, SEVERE_FLOOR=${SEVERE_FLOOR.toFixed(2)}`);
  out.push(`ELEVATED_PLUS_THRESHOLD=${ELEVATED_PLUS_THRESHOLD.toFixed(2)}, CONVERGENCE_TRIGGER_COUNT=${CONVERGENCE_TRIGGER_COUNT}, CONVERGENCE_AMPLIFY_PER_SIGNAL=${CONVERGENCE_AMPLIFY_PER_SIGNAL.toFixed(2)}`);
  out.push('SANITY only — invariants on synthetic stubs + corpus distribution. No loss-fit.');
  out.push('');

  /* === INVARIANT — SEVERE FLOOR ========================================= */
  out.push('================================================================');
  out.push('INVARIANT — severe single flag floors at 0.45');
  out.push('================================================================');
  out.push('');
  // One asset-class at 0.80, others at 0.10. Base ~ 0.17. Floor → 0.45.
  const oneHigh: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.80),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.10),
    stub('coverage-dscr',             'applicable', 0.10),
    stub('debt-yield',                'applicable', 0.10),
  ];
  const base1 = computeBaseBlend(oneHigh);
  const ov1 = applyOverrides(base1, oneHigh);
  out.push(`  One peer dim at 0.80 (asset-class), rest at 0.10:`);
  out.push(`    base ${(base1.baseRisk ?? NaN).toFixed(4)} → final ${(ov1.finalRisk ?? NaN).toFixed(4)}`);
  out.push(`    severeFloorFired=${ov1.severeFloorFired} severeFlagged=[${ov1.severeFlaggedDims.join(', ')}]`);
  out.push(`    Expected: floor at 0.45 since base < 0.45.  ${Math.abs((ov1.finalRisk ?? 0) - 0.45) < 1e-9 ? '✓' : '⚠'}`);
  out.push('');
  // One dim at 0.80, others at 0.55. Base = 0.55 * 0.82 + 0.80 * 0.18 = 0.451 + 0.144 = 0.595.
  // But convergence amplifier ALSO fires (5 other signals at 0.55 = 5 elevated; +1 high = 6 signals at elevated+)
  // → +0.05 * 4 = +0.20 → 0.595 + 0.20 = 0.795. Severe floor of 0.45 has no effect.
  const oneHighFiveElev: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.55),
    stub('refinance-feasibility',     'applicable', 0.55),
    stub('asset-class',               'applicable', 0.80),
    stub('rollover',                  'applicable', 0.55),
    stub('income-concentration',      'applicable', 0.55),
    stub('leverage-ltv',              'applicable', 0.55),
    stub('coverage-dscr',             'applicable', 0.55),
    stub('debt-yield',                'applicable', 0.55),
  ];
  const base2 = computeBaseBlend(oneHighFiveElev);
  const ov2 = applyOverrides(base2, oneHighFiveElev);
  out.push(`  One peer dim at 0.80, others at 0.55 (severe + convergence):`);
  out.push(`    base ${(base2.baseRisk ?? NaN).toFixed(4)} → amplified ${(ov2.amplifiedRisk ?? NaN).toFixed(4)} → final ${(ov2.finalRisk ?? NaN).toFixed(4)}`);
  out.push(`    severeFloorFired=${ov2.severeFloorFired}  convergenceFired=${ov2.convergenceAmplifierFired} count=${ov2.independentElevatedCount}`);
  out.push(`    Severe floor (0.45) below amplified risk → no upward push from severe floor.  ${(ov2.finalRisk ?? 0) >= (ov2.amplifiedRisk ?? 0) - 1e-9 ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT — CONVERGENCE NON-TRIGGERS ============================ */
  out.push('================================================================');
  out.push('INVARIANT — convergence non-triggers');
  out.push('================================================================');
  out.push('');
  for (const elevCount of [0, 1, 2]) {
    const stubs: DimensionContribution[] = [
      stub('cap-rate-valuation-stress', 'applicable', elevCount >= 1 ? 0.55 : 0.10),
      stub('refinance-feasibility',     'applicable', elevCount >= 2 ? 0.55 : 0.10),
      stub('asset-class',               'applicable', 0.10),
      stub('rollover',                  'applicable', 0.10),
      stub('income-concentration',      'applicable', 0.10),
      stub('leverage-ltv',              'applicable', 0.10),
      stub('coverage-dscr',             'applicable', 0.10),
      stub('debt-yield',                'applicable', 0.10),
    ];
    const b = computeBaseBlend(stubs);
    const o = applyOverrides(b, stubs);
    out.push(`  ${elevCount} elevated signal(s): base ${(b.baseRisk ?? NaN).toFixed(4)} → final ${(o.finalRisk ?? NaN).toFixed(4)}  convergenceFired=${o.convergenceAmplifierFired} count=${o.independentElevatedCount}  ${!o.convergenceAmplifierFired ? '✓ no amplification (below 3)' : '⚠ unexpected'}`);
  }
  out.push('');

  /* === INVARIANT — CONVERGENCE GRADIENT ================================ */
  out.push('================================================================');
  out.push('INVARIANT — convergence gradient (3, 4, 5, 6 elevated+ signals)');
  out.push('================================================================');
  out.push('');
  for (const elevCount of [3, 4, 5, 6]) {
    // Set first `elevCount` of the 6 collapsed signals to 0.55. Note ratio-family is
    // signal #6 in the collapse — easiest way to control is set assetClass + refi +
    // cap-rate + rollover + concentration + all-ratios to elevated as needed.
    // The 6 collapsed signals correspond to: cap-rate, refinance, asset-class,
    // rollover, concentration, ratio-family.
    // Easiest: distribute across the 6 by setting the right peer-dim risks.
    // For elevCount=3: cap-rate, refi, asset-class elevated; rest low; ratios low.
    const stubs: DimensionContribution[] = [
      stub('cap-rate-valuation-stress', 'applicable', elevCount >= 1 ? 0.55 : 0.10),
      stub('refinance-feasibility',     'applicable', elevCount >= 2 ? 0.55 : 0.10),
      stub('asset-class',               'applicable', elevCount >= 3 ? 0.55 : 0.10),
      stub('rollover',                  'applicable', elevCount >= 4 ? 0.55 : 0.10),
      stub('income-concentration',      'applicable', elevCount >= 5 ? 0.55 : 0.10),
      // For elevCount >= 6, push all three ratios to elevated so the family is at 0.55.
      stub('leverage-ltv',              'applicable', elevCount >= 6 ? 0.55 : 0.10),
      stub('coverage-dscr',             'applicable', elevCount >= 6 ? 0.55 : 0.10),
      stub('debt-yield',                'applicable', elevCount >= 6 ? 0.55 : 0.10),
    ];
    const b = computeBaseBlend(stubs);
    const o = applyOverrides(b, stubs);
    const expectedAmplifier = CONVERGENCE_AMPLIFY_PER_SIGNAL * (elevCount - (CONVERGENCE_TRIGGER_COUNT - 1));
    out.push(`  ${elevCount} elevated+ signals: base ${(b.baseRisk ?? NaN).toFixed(4)} → amplified ${(o.amplifiedRisk ?? NaN).toFixed(4)} → final ${(o.finalRisk ?? NaN).toFixed(4)}  amplifier=+${o.convergenceAmplifierMagnitude.toFixed(3)}  (expected +${expectedAmplifier.toFixed(3)})  ${Math.abs(o.convergenceAmplifierMagnitude - expectedAmplifier) < 1e-9 ? '✓' : '⚠'}`);
  }
  out.push('');

  /* === INVARIANT — UNIFORM-ELEVATED REACHES DECLINE WHEN CONVERGENT === */
  out.push('================================================================');
  out.push('INVARIANT — uniform-elevated reaches decline range (>= 0.65) with full convergence');
  out.push('================================================================');
  out.push('');
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
  const bUni = computeBaseBlend(uniformElev);
  const oUni = applyOverrides(bUni, uniformElev);
  out.push(`  All 6 signals at 0.55 (uniform-elevated): base ${(bUni.baseRisk ?? NaN).toFixed(4)} → final ${(oUni.finalRisk ?? NaN).toFixed(4)}`);
  out.push(`    Expected ≈ 0.55 + 0.20 = 0.75 (decline range, >= 0.65).  ${(oUni.finalRisk ?? 0) >= 0.65 ? '✓ in decline range' : '⚠'}`);
  out.push('');

  /* === INVARIANT — CAP AT 1.0 =========================================== */
  out.push('================================================================');
  out.push('INVARIANT — risk never overshoots 1.0');
  out.push('================================================================');
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
  const bAH = computeBaseBlend(allHigh);
  const oAH = applyOverrides(bAH, allHigh);
  out.push(`  All 8 peer dims at 0.80: base ${(bAH.baseRisk ?? NaN).toFixed(4)} → final ${(oAH.finalRisk ?? NaN).toFixed(4)}  ${(oAH.finalRisk ?? 0) <= 1.0 + 1e-9 ? '✓ ≤ 1.0' : '⚠ overshoot'}`);
  out.push('');

  /* === INVARIANT — RATIO COLLAPSE IN CONVERGENCE COUNT ================= */
  out.push('================================================================');
  out.push('INVARIANT — ratio-family counted ONCE in convergence (not three times)');
  out.push('================================================================');
  out.push('');
  // Three ratios at high (0.80), others at 0.10. Ratio family collapses to one signal.
  // Convergence count should be 1 (just the ratio-family), NOT 3 — below trigger.
  const ratiosOnly: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.80),
    stub('coverage-dscr',             'applicable', 0.80),
    stub('debt-yield',                'applicable', 0.80),
  ];
  const bRO = computeBaseBlend(ratiosOnly);
  const oRO = applyOverrides(bRO, ratiosOnly);
  out.push(`  3 ratios at 0.80, others at 0.10: convergence count = ${oRO.independentElevatedCount}  signals=[${oRO.independentElevatedSignals.join(', ')}]`);
  out.push(`    Expected count = 1 (ratio-family only; not 3 — triple-count avoided).  ${oRO.independentElevatedCount === 1 ? '✓' : '⚠'}`);
  out.push(`    severeFloorFired=${oRO.severeFloorFired} (peer-level check, fires on ANY individual ratio at 0.80)  ${oRO.severeFloorFired ? '✓ severe still fires at peer level' : '⚠'}`);
  out.push(`    Result: severe floor at 0.45 applies; convergence does not (below 3 collapsed signals)`);
  out.push(`    final ${(oRO.finalRisk ?? NaN).toFixed(4)}  ${(oRO.finalRisk ?? 0) >= SEVERE_FLOOR - 1e-9 ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT — N/A AND HITL DON'T TRIGGER OVERRIDES ================ */
  out.push('================================================================');
  out.push('INVARIANT — N/A and HITL dims don\'t fire overrides');
  out.push('================================================================');
  out.push('');
  const naWithHigh: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.30),
    stub('refinance-feasibility',     'applicable', 0.30),
    stub('asset-class',               'applicable', 0.30),
    stub('rollover',                  'not-applicable-by-asset-type', null),       // N/A; ignored
    stub('income-concentration',      'hitl-needed',                  null),       // HITL; ignored
    stub('leverage-ltv',              'applicable', 0.30),
    stub('coverage-dscr',             'applicable', 0.30),
    stub('debt-yield',                'applicable', 0.30),
  ];
  const bNa = computeBaseBlend(naWithHigh);
  const oNa = applyOverrides(bNa, naWithHigh);
  out.push(`  6 applicable at 0.30, 1 N/A, 1 HITL: severeFloorFired=${oNa.severeFloorFired}  convergenceCount=${oNa.independentElevatedCount}`);
  out.push(`    Expected: no severe fire, 0 elevated+ signals.  ${!oNa.severeFloorFired && oNa.independentElevatedCount === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === CORPUS DISTRIBUTION ============================================== */
  out.push('================================================================');
  out.push('CORPUS DISTRIBUTION — overrides on the clean backbone corpus');
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
      assetType: r.assetType,
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
    const allContribs: DimensionContribution[] = [dim7, refi, ac, roll, conc, ltv, dscr, dy];
    const blend = computeBaseBlend(allContribs);
    const ov = applyOverrides(blend, allContribs);
    return { record: r, blend, ov };
  });

  const baseRisks = results.map(x => x.blend.baseRisk).filter((x): x is number => x !== null);
  const finalRisks = results.map(x => x.ov.finalRisk).filter((x): x is number => x !== null);
  out.push(`  baseRisk  n=${baseRisks.length}  min ${Math.min(...baseRisks).toFixed(3)}  p25 ${quantile(baseRisks,0.25).toFixed(3)}  median ${median(baseRisks).toFixed(3)}  p75 ${quantile(baseRisks,0.75).toFixed(3)}  max ${Math.max(...baseRisks).toFixed(3)}  mean ${mean(baseRisks).toFixed(3)}`);
  out.push(`  finalRisk n=${finalRisks.length}  min ${Math.min(...finalRisks).toFixed(3)}  p25 ${quantile(finalRisks,0.25).toFixed(3)}  median ${median(finalRisks).toFixed(3)}  p75 ${quantile(finalRisks,0.75).toFixed(3)}  max ${Math.max(...finalRisks).toFixed(3)}  mean ${mean(finalRisks).toFixed(3)}`);
  out.push('');

  const severeFires = results.filter(x => x.ov.severeFloorFired);
  const convergenceFires = results.filter(x => x.ov.convergenceAmplifierFired);
  const bothFires = results.filter(x => x.ov.severeFloorFired && x.ov.convergenceAmplifierFired);
  out.push(`  Override fires:`);
  out.push(`    severe-single-flag (OVERRIDE A): ${severeFires.length} records (${(severeFires.length / results.length * 100).toFixed(1)}%)`);
  out.push(`    convergence amplifier (OVERRIDE B): ${convergenceFires.length} records (${(convergenceFires.length / results.length * 100).toFixed(1)}%)`);
  out.push(`    both: ${bothFires.length} records (${(bothFires.length / results.length * 100).toFixed(1)}%)`);
  out.push('');

  // Histogram of severe-flagged dims
  const flaggedCount: Record<string, number> = {};
  for (const r of severeFires) for (const d of r.ov.severeFlaggedDims) flaggedCount[d] = (flaggedCount[d] ?? 0) + 1;
  out.push(`  Severe-flagged dims (which peer dim triggered):`);
  for (const [k, n] of Object.entries(flaggedCount).sort((a, b) => b[1] - a[1])) out.push(`    ${k.padEnd(34)} ${n}`);
  out.push('');

  // Distribution of independent-elevated count
  const countDist: Record<number, number> = {};
  for (const r of results) {
    if (r.ov.finalRisk === null) continue;
    countDist[r.ov.independentElevatedCount] = (countDist[r.ov.independentElevatedCount] ?? 0) + 1;
  }
  out.push(`  Independent-elevated count distribution (resolved records):`);
  for (let i = 0; i <= 6; i++) {
    const n = countDist[i] ?? 0;
    const bar = '█'.repeat(Math.min(60, Math.round(n / 2)));
    out.push(`    ${i}: ${n.toString().padStart(3)}  ${bar}`);
  }
  out.push('');

  // Compare base vs final by delta
  const deltas = results.filter(x => x.blend.baseRisk !== null && x.ov.finalRisk !== null)
    .map(x => (x.ov.finalRisk as number) - (x.blend.baseRisk as number));
  out.push(`  Final-vs-base delta:  min ${Math.min(...deltas).toFixed(3)}  median ${median(deltas).toFixed(3)}  mean ${mean(deltas).toFixed(3)}  max ${Math.max(...deltas).toFixed(3)}`);
  const positives = deltas.filter(d => d > 1e-9).length;
  const negatives = deltas.filter(d => d < -1e-9).length;
  const zeros = deltas.filter(d => Math.abs(d) <= 1e-9).length;
  out.push(`  Records with override impact: ${positives} positive, ${zeros} unchanged, ${negatives} negative  ${negatives === 0 ? '✓ overrides never reduce risk' : '⚠'}`);
  out.push('');

  // Informational loss-class spread (NOT a fit target)
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const xs = results.filter(x => x.record.outcomeClass === cls).map(x => x.ov.finalRisk).filter((x): x is number => x !== null);
    if (xs.length === 0) { out.push(`  ${cls.padEnd(12)} (n=0 resolved)`); continue; }
    out.push(`  ${cls.padEnd(12)} n=${xs.length}  mean ${mean(xs).toFixed(3)}  median ${median(xs).toFixed(3)}  min ${Math.min(...xs).toFixed(3)}  max ${Math.max(...xs).toFixed(3)}`);
  }
  out.push('');
  out.push(`  NOTE: stage-2 overrides shape risk; stage-3 will add the bands + sponsor modifier + coverage`);
  out.push('  gating that produce the final recommendation.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old scorer');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|baseline_score|scorer_v1|override_threshold" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for stage 2 traces ONLY to:');
  out.push('    - committee credit-review practice (the two overrides are a generalization)');
  out.push('    - Override A: severe single-flag floor at elevated band-floor (~0.45) — blocks Strong/Acceptable, never auto-declines');
  out.push('    - Override B: convergence amplifier at +0.05 per signal past 2 independent elevated+ — pushes uniform convergent reads into decline');
  out.push('    - Cap at 1.0 (no overshoot)');
  out.push('    - Thresholds + amplification step convention-driven, NOT corpus-fit');
  out.push('  NEVER to manifesto_rules.json / old scorer / old doctrine.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean stage 2] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
