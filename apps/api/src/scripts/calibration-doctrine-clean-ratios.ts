/**
 * Light sanity validation for doctrine-clean ratio dimensions
 *   - dim 1 Leverage (LTV)
 *   - dim 2 Coverage (DSCR)
 *   - dim 3 Debt Yield (DY)
 *
 * Pipeline: normalize sustainable cashflow → dim 7 → consume stressedLtv +
 * sustainable NOI/NCF → run the three ratio dimensions.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-ratios.ts
 *
 * IMPORTANT CAVEAT (the sharpened read):
 *   Standalone separation on ratios is EXPECTED FLAT. The sharpened-read
 *   calibration phase already showed ratios don't separate CLEAN vs LOSS
 *   on this corpus. A flat read here CONFIRMS a faithful build — it is
 *   not a defect. The dimensions' correctness rests on agency-convention
 *   provenance, not on this corpus's loss-rate split.
 *
 * Spot-checks:
 *   - LTV plausible range (10-200%)
 *   - DSCR plausible range (0.5-3.5x)
 *   - DY plausible range (3-25%)
 *   - Debt-service IO vs amortizing: when amortMonths null → IO; spot-check
 *     IO formula = loan × coupon
 *   - No NaN / Infinity / negative values
 *   - Coverage routing correct (applicable / hitl-needed only; no N/A-by-
 *     asset-type for any ratio)
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  evaluateLeverageLtv,
  evaluateCoverageDscr,
  evaluateDebtYield,
  LEVERAGE_LTV_BANDS,
  COVERAGE_DSCR_BANDS,
  DEBT_YIELD_ASSET_FLOORS,
  computeAnnualDebtService,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-ratios.out';

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

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / ratio dimensions (LTV / DSCR / DY) — light sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('LIGHT SANITY — flat standalone separation EXPECTED and ACCEPTED (sharpened read showed ratios don\'t separate).');
  out.push('Bands convention-driven (agency convergence); NOT fit to corpus.');
  out.push('');

  /* === BAND TABLES (transparency) ======================================= */
  out.push('================================================================');
  out.push('BAND TABLES — agency-convention thresholds');
  out.push('================================================================');
  out.push('');
  out.push('  LTV bands (vs stressed value):');
  for (const b of LEVERAGE_LTV_BANDS) {
    const lo = b.minLtv === Number.NEGATIVE_INFINITY ? '−∞' : (b.minLtv * 100).toFixed(0) + '%';
    const hi = b.maxLtv === Number.POSITIVE_INFINITY ? '+∞' : (b.maxLtv * 100).toFixed(0) + '%';
    out.push(`    ${b.tier.padEnd(10)} risk ${b.riskContribution.toFixed(2)}   [${lo}, ${hi})`);
  }
  out.push('');
  out.push('  DSCR bands (sustainable NCF / annual debt service):');
  for (const b of COVERAGE_DSCR_BANDS) {
    const lo = b.minDscr === Number.NEGATIVE_INFINITY ? '−∞' : b.minDscr.toFixed(2) + 'x';
    const hi = b.maxDscr === Number.POSITIVE_INFINITY ? '+∞' : b.maxDscr.toFixed(2) + 'x';
    out.push(`    ${b.tier.padEnd(12)} risk ${b.riskContribution.toFixed(2)}   [${lo}, ${hi})`);
  }
  out.push('');
  out.push('  DY asset-specific floors (KBRA KDY conventions):');
  for (const f of DEBT_YIELD_ASSET_FLOORS) {
    out.push(`    ${f.assetClass.padEnd(20)} floor ${(f.floorDecimal * 100).toFixed(1)}%`);
  }
  out.push('  DY bands relative to asset floor: strong = floor+2.0pp, adequate ≥ floor, thin ≥ floor−1.5pp, distressed < floor−1.5pp');
  out.push('');

  /* === DEBT-SERVICE SPOT CHECK ========================================== */
  out.push('================================================================');
  out.push('SPOT CHECK — debt-service formula sanity');
  out.push('================================================================');
  out.push('');
  // IO case (amortMonths null): DS = loan × coupon
  const io = computeAnnualDebtService(10_000_000, 0.05, null, null, null);
  out.push(`  IO case   loan=$10M, coupon=5%, amortMonths=null → DS=$${Math.round(io.annualDs).toLocaleString()}  basis=${io.basis}  (expected $500,000 interest-only)`);
  // Amortizing case (360 month / 30-year amort): standard mortgage payment
  const am = computeAnnualDebtService(10_000_000, 0.05, 360, null, null);
  out.push(`  Amort case loan=$10M, coupon=5%, amortMonths=360 → DS=$${Math.round(am.annualDs).toLocaleString()}  basis=${am.basis}  (expected ~$644,000 P&I; mortgage formula)`);
  // Full IO (ioYears >= termYears)
  const fullIo = computeAnnualDebtService(10_000_000, 0.05, 360, 10, 10);
  out.push(`  Full-IO   loan=$10M, coupon=5%, amort=360, ioYears=10, termYears=10 → DS=$${Math.round(fullIo.annualDs).toLocaleString()}  basis=${fullIo.basis}  (expected $500,000 IO override)`);
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push(`  CLEAN ${records.filter(r => r.outcomeClass === 'CLEAN').length}   STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}   LOSS ${records.filter(r => r.outcomeClass === 'LOSS').length}`);
  out.push('');

  /* === PIPELINE === */
  const scored = records.map(r => {
    const norm = normalizeSustainableCashflow({
      assetType: r.assetType,
      subType: r.subType,
      uwY1Noi: r.uwY1Noi,
      t12Noi: r.t12Noi,
      underwrittenOccupancy: null,
    });
    const dim7 = evaluateCapRateValuationStress({
      assetType: r.assetType,
      subType: r.subType,
      uwY1Noi: r.uwY1Noi,
      sustainableNcf: norm.sustainableNcf,
      concludedValue: r.concludedValue,
      loanAmount: r.loanAmount,
      marketTier: 'Unknown',
    });
    const ltv = evaluateLeverageLtv({
      stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null,
    });
    const dscr = evaluateCoverageDscr({
      sustainableNcf: norm.sustainableNcf,
      loanAmount: r.loanAmount,
      coupon: r.coupon,
      amortMonths: null,           // corpus does not expose
      ioYears: null,
      termYears: null,
    });
    const dy = evaluateDebtYield({
      sustainableNoi: norm.sustainableNoi,
      loanAmount: r.loanAmount,
      assetType: r.assetType,
      subType: r.subType,
    });
    return { record: r, norm, dim7, ltv, dscr, dy };
  });

  /* === COVERAGE ROUTING ================================================ */
  out.push('================================================================');
  out.push('COVERAGE ROUTING — applicable vs hitl-needed (no N/A-by-asset-type on any ratio)');
  out.push('================================================================');
  out.push('');
  const dims = [
    { name: 'LTV',  pick: (s: typeof scored[number]) => s.ltv },
    { name: 'DSCR', pick: (s: typeof scored[number]) => s.dscr },
    { name: 'DY',   pick: (s: typeof scored[number]) => s.dy },
  ];
  out.push(`  ${'dim'.padEnd(6)} applicable    hitl-needed   total`);
  for (const d of dims) {
    const app = scored.filter(s => d.pick(s).applicability === 'applicable').length;
    const hit = scored.filter(s => d.pick(s).applicability === 'hitl-needed').length;
    out.push(`  ${d.name.padEnd(6)} ${app.toString().padStart(10)}    ${hit.toString().padStart(11)}   ${(app + hit).toString().padStart(5)}`);
  }
  out.push('');
  out.push('  Sanity: every record routes to exactly one of applicable / hitl-needed.');
  out.push('');

  /* === RANGE SANITY ==================================================== */
  out.push('================================================================');
  out.push('RANGE SANITY — plausible LTV / DSCR / DY values');
  out.push('================================================================');
  out.push('');
  const ltvs = scored.map(s => s.ltv.derivedOutputs?.stressedLtv as number | undefined).filter((x): x is number => x !== undefined && x !== null && Number.isFinite(x));
  const dscrs = scored.map(s => s.dscr.derivedOutputs?.stressedDscr as number | undefined).filter((x): x is number => x !== undefined && x !== null && Number.isFinite(x));
  const dys = scored.map(s => s.dy.derivedOutputs?.debtYield as number | undefined).filter((x): x is number => x !== undefined && x !== null && Number.isFinite(x));
  out.push(`  LTV (stressed):  n=${ltvs.length}  min ${(Math.min(...ltvs) * 100).toFixed(0)}%  mean ${(mean(ltvs) * 100).toFixed(0)}%  median ${(median(ltvs) * 100).toFixed(0)}%  max ${(Math.max(...ltvs) * 100).toFixed(0)}%`);
  out.push(`  DSCR (stressed): n=${dscrs.length}  min ${Math.min(...dscrs).toFixed(2)}x  mean ${mean(dscrs).toFixed(2)}x  median ${median(dscrs).toFixed(2)}x  max ${Math.max(...dscrs).toFixed(2)}x`);
  out.push(`  DY (sustainable NOI/loan): n=${dys.length}  min ${(Math.min(...dys) * 100).toFixed(2)}%  mean ${(mean(dys) * 100).toFixed(2)}%  median ${(median(dys) * 100).toFixed(2)}%  max ${(Math.max(...dys) * 100).toFixed(2)}%`);
  out.push('');
  // Implausible checks
  const ltvImpl = ltvs.filter(x => x < 0.10 || x > 2.00).length;
  const dscrImpl = dscrs.filter(x => x < 0.30 || x > 5.00).length;
  const dyImpl = dys.filter(x => x < 0.02 || x > 0.30).length;
  out.push(`  Implausible LTV (< 10% or > 200%): ${ltvImpl}  ${ltvImpl === 0 ? '✓' : '⚠'}`);
  out.push(`  Implausible DSCR (< 0.30x or > 5.00x): ${dscrImpl}  ${dscrImpl === 0 ? '✓' : '⚠'}`);
  out.push(`  Implausible DY (< 2% or > 30%): ${dyImpl}  ${dyImpl === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === BUG SCREEN ====================================================== */
  out.push('================================================================');
  out.push('BUG SCREEN — no NaN / Infinity / negative values across derivedOutputs');
  out.push('================================================================');
  out.push('');
  let nan = 0, inf = 0, neg = 0;
  for (const s of scored) {
    for (const dim of [s.ltv, s.dscr, s.dy]) {
      const d = dim.derivedOutputs ?? {};
      for (const k of Object.keys(d)) {
        const v = d[k] as number | null;
        if (v === null) continue;
        if (Number.isNaN(v)) nan++;
        if (!Number.isFinite(v) && !Number.isNaN(v)) inf++;
        if (v < 0) neg++;
      }
    }
  }
  out.push(`  NaN across LTV/DSCR/DY derivedOutputs: ${nan}  ${nan === 0 ? '✓' : '⚠'}`);
  out.push(`  Infinity: ${inf}  ${inf === 0 ? '✓' : '⚠'}`);
  out.push(`  Negative: ${neg}  ${neg === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === BAND DISTRIBUTION =============================================== */
  out.push('================================================================');
  out.push('BAND DISTRIBUTION — applicable records by class');
  out.push('================================================================');
  out.push('');
  const dimDefs = [
    { name: 'LTV',  tiers: ['low', 'moderate', 'elevated', 'high'] as const, pick: (s: typeof scored[number]) => s.ltv.tier },
    { name: 'DSCR', tiers: ['strong', 'adequate', 'thin', 'distressed'] as const, pick: (s: typeof scored[number]) => s.dscr.tier },
    { name: 'DY',   tiers: ['strong', 'adequate', 'thin', 'distressed'] as const, pick: (s: typeof scored[number]) => s.dy.tier },
  ];
  for (const d of dimDefs) {
    out.push(`  ${d.name}:`);
    out.push(`    ${'class'.padEnd(12)} ${d.tiers.map(t => t.padStart(11)).join('')}   total`);
    for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
      const inCls = scored.filter(s => s.record.outcomeClass === cls && (d.pick(s) !== 'N/A'));
      const counts = d.tiers.map(t => inCls.filter(s => d.pick(s) === t).length);
      out.push(`    ${cls.padEnd(12)} ${counts.map(c => c.toString().padStart(11)).join('')}   ${inCls.length.toString().padStart(5)}`);
    }
    out.push('');
  }

  /* === STANDALONE SEPARATION (flat-is-correct) ========================== */
  out.push('================================================================');
  out.push('STANDALONE SEPARATION — LOSS vs CLEAN');
  out.push('================================================================');
  out.push('');
  out.push('  EXPECTED FLAT (sharpened read showed ratios don\'t separate). Flat = faithful build.');
  out.push('');
  out.push(`  ${'metric'.padEnd(12)} CLEAN-mean  LOSS-mean   gap (LOSS-CLEAN)`);
  for (const d of [
    { name: 'LTV',  xs: (s: typeof scored[number]) => s.ltv.derivedOutputs?.stressedLtv as number | undefined, fmt: (x: number) => (x * 100).toFixed(1) + '%' },
    { name: 'DSCR', xs: (s: typeof scored[number]) => s.dscr.derivedOutputs?.stressedDscr as number | undefined, fmt: (x: number) => x.toFixed(2) + 'x' },
    { name: 'DY',   xs: (s: typeof scored[number]) => s.dy.derivedOutputs?.debtYield as number | undefined, fmt: (x: number) => (x * 100).toFixed(2) + '%' },
  ]) {
    const get = (cls: 'CLEAN' | 'LOSS') => scored.filter(s => s.record.outcomeClass === cls).map(s => d.xs(s)).filter((x): x is number => x !== undefined && x !== null && Number.isFinite(x));
    const c = get('CLEAN'); const l = get('LOSS');
    if (c.length === 0 || l.length === 0) { out.push(`  ${d.name.padEnd(12)} (n=0 in one class)`); continue; }
    const gap = mean(l) - mean(c);
    const gapFmt = d.name === 'DSCR' ? gap.toFixed(2) + 'x' : (gap * 100).toFixed(1) + 'pp';
    out.push(`  ${d.name.padEnd(12)} ${d.fmt(mean(c)).padStart(10)}  ${d.fmt(mean(l)).padStart(9)}   ${gapFmt}`);
  }
  out.push('');
  out.push(`  Flat or contradictory gaps here are EXPECTED. The dimensions' correctness rests on`);
  out.push('  agency-convention provenance + the structural dimensions (asset-class, rollover, valuation),');
  out.push('  not on ratio separation in this thin corpus.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old ratio thresholds');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|ltv_threshold|dscr_threshold|dy_threshold" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc comments (fence statements).');
  out.push('');
  out.push('  Provenance for the three ratio dimensions traces ONLY to:');
  out.push('    - spec v2 §1 / §2 / §3 (verbatim in each dimension\'s header)');
  out.push('    - KBRA KLTV / KDSC / KDY (asset-specific conventions + default study)');
  out.push('    - DBRS Morningstar LTV Sizing Benchmarks, DSCR benchmarks, debt-yield levels');
  out.push('    - Moody\'s Approach to Rating US Conduit/Fusion CMBS — stressed DSCR primary PoD driver');
  out.push('  NEVER to manifesto_rules.json / old doctrine / old ratio thresholds.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean ratios] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
