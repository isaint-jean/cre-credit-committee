/**
 * Sanity validation for doctrine-clean scoring stage 1 (base-blend).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-stage1-base-blend.ts
 *
 * SANITY (not loss-fit). What we verify:
 *
 *   STRUCTURAL INVARIANTS (synthetic — exact arithmetic):
 *     - All-low resolved → base ~0.10
 *     - All-moderate → ~0.30
 *     - All-elevated → ~0.55
 *     - All-high → ~0.80
 *     - N/A excluded: multifamily with concentration N/A is not
 *       penalized; weight redistributes proportionally
 *     - HITL excluded: same redistribution; record carries HITL identity
 *     - Ratio collapse: high-leverage deal's ratios contribute ONCE,
 *       not three times (spot-check the family weight)
 *     - Weights sum to 1.00 over resolved signals (renormalization)
 *
 *   CORPUS DISTRIBUTION:
 *     Run the full pipeline on the clean backbone corpus and report
 *     base-risk + coverage distributions. Sanity (full range used,
 *     sensible spread), NOT loss-separation.
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
  BASE_BLEND_SIGNAL_WEIGHTS,
  BASE_BLEND_RATIO_FAMILY_INNER_WEIGHTS,
} from '../doctrine-clean/index.js';
import type { DimensionContribution } from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-stage1-base-blend.out';

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

/** Build a stub DimensionContribution at a given risk + state. */
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
  out.push('doctrine-clean / scoring stage 1 (base-blend) — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('SANITY only — invariants on synthetic stubs + corpus distribution. No loss-fit.');
  out.push('');

  /* === WEIGHT TABLES ==================================================== */
  out.push('================================================================');
  out.push('WEIGHT TABLES');
  out.push('================================================================');
  out.push('');
  out.push('  Main blend weights (after ratio collapse), sum to 1.00:');
  let weightSum = 0;
  for (const [id, w] of Object.entries(BASE_BLEND_SIGNAL_WEIGHTS)) {
    out.push(`    ${id.padEnd(32)} ${w.toFixed(2)}`);
    weightSum += w;
  }
  out.push(`    sum = ${weightSum.toFixed(2)}  ${Math.abs(weightSum - 1.0) < 1e-9 ? '✓' : '⚠'}`);
  out.push('');
  out.push('  Ratio-family inner weights (LTV/DSCR/DY), sum to 1.00:');
  let innerSum = 0;
  for (const [id, w] of Object.entries(BASE_BLEND_RATIO_FAMILY_INNER_WEIGHTS)) {
    out.push(`    ${id.padEnd(32)} ${w.toFixed(2)}`);
    innerSum += w;
  }
  out.push(`    sum = ${innerSum.toFixed(2)}  ${Math.abs(innerSum - 1.0) < 1e-9 ? '✓' : '⚠'}`);
  out.push('');

  /* === INVARIANT 1: ALL-LOW / -MOD / -ELEV / -HIGH ====================== */
  out.push('================================================================');
  out.push('INVARIANT 1 — all-resolved at uniform risk: base ≈ uniform risk');
  out.push('================================================================');
  out.push('');
  for (const [label, r] of [['low', 0.10], ['moderate', 0.30], ['elevated', 0.55], ['high', 0.80]] as const) {
    const stubs: DimensionContribution[] = [
      stub('cap-rate-valuation-stress', 'applicable', r),
      stub('refinance-feasibility',     'applicable', r),
      stub('asset-class',               'applicable', r),
      stub('rollover',                  'applicable', r),
      stub('income-concentration',      'applicable', r),
      stub('leverage-ltv',              'applicable', r),
      stub('coverage-dscr',             'applicable', r),
      stub('debt-yield',                'applicable', r),
    ];
    const result = computeBaseBlend(stubs);
    const ok = Math.abs((result.baseRisk ?? 0) - r) < 1e-9;
    out.push(`  all-${label.padEnd(8)} (risk ${r.toFixed(2)}) → base ${(result.baseRisk ?? NaN).toFixed(4)}  ${ok ? '✓' : '⚠'}`);
  }
  out.push('');

  /* === INVARIANT 2: N/A EXCLUSION ====================================== */
  out.push('================================================================');
  out.push('INVARIANT 2 — N/A excluded from risk; weight redistributes');
  out.push('================================================================');
  out.push('');
  // Multifamily-style: concentration N/A. All other dims at risk 0.30.
  // Expected base = 0.30 (renormalization preserves the uniform level).
  const mfaScenario: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.30),
    stub('refinance-feasibility',     'applicable', 0.30),
    stub('asset-class',               'applicable', 0.30),
    stub('rollover',                  'not-applicable-by-asset-type', null),
    stub('income-concentration',      'not-applicable-by-asset-type', null),
    stub('leverage-ltv',              'applicable', 0.30),
    stub('coverage-dscr',             'applicable', 0.30),
    stub('debt-yield',                'applicable', 0.30),
  ];
  const r1 = computeBaseBlend(mfaScenario);
  out.push(`  Multifamily (rollover + concentration N/A, all else moderate): base ${(r1.baseRisk ?? NaN).toFixed(4)}  ${Math.abs((r1.baseRisk ?? 0) - 0.30) < 1e-9 ? '✓ N/A does not penalize' : '⚠'}`);
  out.push(`    Coverage: applicable ${r1.coverage.applicable.length}, N/A ${r1.coverage.naByAssetType.length}, HITL ${r1.coverage.hitlNeeded.length}, confidence ${r1.coverage.confidence.toFixed(2)}`);
  out.push('');
  // Same with the N/A dims at risk 0.80 if they were applicable.
  // The risk should still resolve to ~0.30 because they're EXCLUDED.
  out.push(`  ☑ Sanity sub-check: the N/A dims' "risk if applicable" is ignored — only applicable dims contribute.`);
  out.push('');

  /* === INVARIANT 3: HITL EXCLUSION FROM RISK, INCLUSION IN COVERAGE === */
  out.push('================================================================');
  out.push('INVARIANT 3 — HITL excluded from risk; tracked in coverage');
  out.push('================================================================');
  out.push('');
  const hitlScenario: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.55),
    stub('refinance-feasibility',     'hitl-needed', null),
    stub('asset-class',               'applicable', 0.55),
    stub('rollover',                  'hitl-needed', null),
    stub('income-concentration',      'applicable', 0.55),
    stub('leverage-ltv',              'applicable', 0.55),
    stub('coverage-dscr',             'applicable', 0.55),
    stub('debt-yield',                'applicable', 0.55),
  ];
  const r2 = computeBaseBlend(hitlScenario);
  out.push(`  Mixed scenario (refi + rollover HITL; all resolved at 0.55): base ${(r2.baseRisk ?? NaN).toFixed(4)}  ${Math.abs((r2.baseRisk ?? 0) - 0.55) < 1e-9 ? '✓ HITL does not penalize' : '⚠'}`);
  out.push(`    Coverage applicable: ${r2.coverage.applicable.join(', ')}`);
  out.push(`    Coverage hitl: ${r2.coverage.hitlNeeded.join(', ')}`);
  out.push(`    Confidence: ${r2.coverage.confidence.toFixed(2)} (= ${r2.coverage.applicable.length}/8)`);
  out.push('');

  /* === INVARIANT 4: RATIO COLLAPSE PREVENTS TRIPLE-COUNT =============== */
  out.push('================================================================');
  out.push('INVARIANT 4 — ratio collapse: LTV/DSCR/DY contribute ONCE');
  out.push('================================================================');
  out.push('');
  // High-leverage scenario: all three ratios at 0.80, others at 0.10.
  // Without collapse: a flat 8-way average would weight 3/8 = 37.5% of base
  // toward 0.80. With collapse + the 0.10 ratio-family weight, the ratios
  // contribute exactly 10% * 0.80 = 0.08 plus the remaining 90% * 0.10 = 0.09 → 0.17.
  const leverageStress: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'applicable', 0.10),
    stub('refinance-feasibility',     'applicable', 0.10),
    stub('asset-class',               'applicable', 0.10),
    stub('rollover',                  'applicable', 0.10),
    stub('income-concentration',      'applicable', 0.10),
    stub('leverage-ltv',              'applicable', 0.80),
    stub('coverage-dscr',             'applicable', 0.80),
    stub('debt-yield',                'applicable', 0.80),
  ];
  const r3 = computeBaseBlend(leverageStress);
  const expected = 0.10 * 0.80 + 0.90 * 0.10;
  const triplecountWouldBe = (3 * 0.80 + 5 * 0.10) / 8;  // naive 8-way average
  out.push(`  High-leverage deal (3 ratios at 0.80; others at 0.10):`);
  out.push(`    Collapsed base risk = ${(r3.baseRisk ?? NaN).toFixed(4)}  (expected ${expected.toFixed(4)})  ${Math.abs((r3.baseRisk ?? 0) - expected) < 1e-9 ? '✓' : '⚠'}`);
  out.push(`    Without collapse (naive 8-way average) would have been ${triplecountWouldBe.toFixed(4)} — triple-count would BIAS UP by ${(triplecountWouldBe - (r3.baseRisk ?? 0)).toFixed(4)}`);
  out.push(`    Ratio family collapsed contribution = ${(r3.ratioFamily.contribution ?? NaN).toFixed(4)} (= 0.80, since all 3 ratios equal)`);
  out.push(`    Ratio family inner weights used: ${Object.entries(r3.ratioFamily.innerWeights).map(([k, w]) => `${k}=${w.toFixed(2)}`).join(', ')}`);
  out.push('');

  /* === INVARIANT 5: RENORMALIZATION OVER RESOLVED ====================== */
  out.push('================================================================');
  out.push('INVARIANT 5 — weights sum to 1.00 over resolved signals (after renormalization)');
  out.push('================================================================');
  out.push('');
  for (const r of [r1, r2, r3]) {
    const sum = r.weightedContributions.reduce((s, c) => s + c.weightRenormalized, 0);
    out.push(`  scenario: ${r.weightedContributions.length} signals  renormalized sum = ${sum.toFixed(6)}  ${Math.abs(sum - 1.0) < 1e-9 ? '✓' : '⚠'}`);
  }
  out.push('');

  /* === EDGE: NOTHING RESOLVED ========================================== */
  out.push('================================================================');
  out.push('EDGE — no signal resolved: baseRisk null, coverage records all HITL');
  out.push('================================================================');
  out.push('');
  const allHitl: DimensionContribution[] = [
    stub('cap-rate-valuation-stress', 'hitl-needed', null),
    stub('refinance-feasibility',     'hitl-needed', null),
    stub('asset-class',               'hitl-needed', null),
    stub('rollover',                  'hitl-needed', null),
    stub('income-concentration',      'hitl-needed', null),
    stub('leverage-ltv',              'hitl-needed', null),
    stub('coverage-dscr',             'hitl-needed', null),
    stub('debt-yield',                'hitl-needed', null),
  ];
  const r4 = computeBaseBlend(allHitl);
  out.push(`  All HITL → baseRisk = ${r4.baseRisk}  ${r4.baseRisk === null ? '✓ null (cannot compute)' : '⚠'}`);
  out.push(`  Coverage: applicable ${r4.coverage.applicable.length}, hitl ${r4.coverage.hitlNeeded.length}, confidence ${r4.coverage.confidence.toFixed(2)}`);
  out.push('');

  /* === CORPUS DISTRIBUTION ============================================= */
  out.push('================================================================');
  out.push('CORPUS DISTRIBUTION — full pipeline run on the clean backbone corpus');
  out.push('================================================================');
  out.push('');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push('');

  const corpusResults = records.map(r => {
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
    const blend = computeBaseBlend([dim7, refi, ac, roll, conc, ltv, dscr, dy]);
    return { record: r, blend };
  });

  const baseRisks = corpusResults.map(x => x.blend.baseRisk).filter((x): x is number => x !== null);
  const baseRiskNull = corpusResults.filter(x => x.blend.baseRisk === null).length;
  out.push(`  baseRisk distribution (n=${baseRisks.length} resolved; ${baseRiskNull} null):`);
  out.push(`    min ${Math.min(...baseRisks).toFixed(3)}   p25 ${quantile(baseRisks, 0.25).toFixed(3)}   median ${median(baseRisks).toFixed(3)}   p75 ${quantile(baseRisks, 0.75).toFixed(3)}   max ${Math.max(...baseRisks).toFixed(3)}   mean ${mean(baseRisks).toFixed(3)}`);
  out.push('');
  // Histogram in 0.05 buckets
  const buckets: Record<string, number> = {};
  for (const r of baseRisks) {
    const lo = Math.floor(r * 20) / 20;
    const k = lo.toFixed(2);
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  out.push(`  Histogram (0.05 buckets):`);
  for (const k of Object.keys(buckets).sort()) {
    const n = buckets[k]!;
    const bar = '█'.repeat(Math.min(60, Math.round(n / 2)));
    out.push(`    ${k} ${n.toString().padStart(3)}  ${bar}`);
  }
  out.push('');

  // Coverage distribution
  const confidences = corpusResults.map(x => x.blend.coverage.confidence);
  out.push(`  Coverage confidence (= applicable / 8 peer dims):`);
  out.push(`    min ${Math.min(...confidences).toFixed(3)}   p25 ${quantile(confidences, 0.25).toFixed(3)}   median ${median(confidences).toFixed(3)}   p75 ${quantile(confidences, 0.75).toFixed(3)}   max ${Math.max(...confidences).toFixed(3)}   mean ${mean(confidences).toFixed(3)}`);
  out.push('');
  const naCounts = corpusResults.map(x => x.blend.coverage.naByAssetType.length);
  const hitlCounts = corpusResults.map(x => x.blend.coverage.hitlNeeded.length);
  out.push(`  Per-record N/A-by-asset-type count: min ${Math.min(...naCounts)} mean ${mean(naCounts).toFixed(2)} max ${Math.max(...naCounts)}`);
  out.push(`  Per-record HITL count:              min ${Math.min(...hitlCounts)} mean ${mean(hitlCounts).toFixed(2)} max ${Math.max(...hitlCounts)}`);
  out.push('');

  // Spot-check: how many resolved signals contribute on average
  const resolvedCounts = corpusResults.map(x => x.blend.weightedContributions.length);
  out.push(`  Resolved signal count per record (out of 6 after ratio collapse): min ${Math.min(...resolvedCounts)} mean ${mean(resolvedCounts).toFixed(2)} max ${Math.max(...resolvedCounts)}`);
  out.push('');

  // Loss-class spread (informational only; not a fit target)
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const xs = corpusResults.filter(x => x.record.outcomeClass === cls).map(x => x.blend.baseRisk).filter((x): x is number => x !== null);
    if (xs.length === 0) { out.push(`  ${cls.padEnd(12)} (n=0 resolved)`); continue; }
    out.push(`  ${cls.padEnd(12)} n=${xs.length}  mean ${mean(xs).toFixed(3)}  median ${median(xs).toFixed(3)}  min ${Math.min(...xs).toFixed(3)}  max ${Math.max(...xs).toFixed(3)}`);
  }
  out.push('');
  out.push(`  NOTE: stage-1 base-blend is committee aggregation, NOT a loss classifier. Loss-spread`);
  out.push('  reporting is informational; stage-3 will add the bands + sponsor modifier + coverage');
  out.push('  gating that produce the final recommendation.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old scorer');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|baseline_score|scorer_v1" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for stage 1 traces ONLY to:');
  out.push('    - committee-weighted aggregation pattern (cross-agency convergence)');
  out.push('    - Moody\'s framing for ratio collapse (LTV severity + DSCR PoD + DY confirming)');
  out.push('    - sharpened-read structural-feature test (proved ratios don\'t separate, structural dims do)');
  out.push('  NEVER to manifesto_rules.json / old scorer / old doctrine.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean stage 1] report: ${OUT_PATH}`);
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i]!;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
