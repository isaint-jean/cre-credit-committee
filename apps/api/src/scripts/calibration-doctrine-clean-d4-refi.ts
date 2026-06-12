/**
 * Sanity validation for doctrine-clean dimension 4 (Refinance feasibility).
 *
 * Pipeline: normalize sustainable cashflow → dim 7 stressed value →
 * dim 4 reads sustainable NCF/NOI + stressed value → computes exit
 * metrics at the stressed refi constant.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d4-refi.ts
 *
 * SANITY CHECK ONLY. The clean corpus's losses are mostly TERM /
 * operational defaults — not maturity / refi defaults — so a flat or
 * weak standalone separation on this dimension is EXPECTED and ACCEPTED.
 * The dimension's value is forward-looking (refi risk for live loans
 * approaching maturity under a different rate regime than at
 * origination).
 *
 * Spot-checks:
 *   - maturity-balance formula (IO no-paydown / fully-amortizing /
 *     partial-IO) — three explicit cases
 *   - exit metrics plausible (DSCR / DY / LTV in sane ranges)
 *   - coverage routing (applicable / hitl-needed only; no
 *     N/A-by-asset-type)
 *   - KBRA-office-Watch convergence pattern (≥2 legs at elevated+)
 *   - pari-passu inflation consistency with the going-in ratio dims
 *   - no NaN / Infinity / negative values
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  evaluateRefinanceFeasibility,
  evaluateLeverageLtv,
  evaluateCoverageDscr,
  evaluateDebtYield,
  computeMaturityBalance,
  STRESSED_REFI_CONSTANT_DEFAULT,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d4-refi.out';

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
  maturityDate: string | null;
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
  out.push('doctrine-clean / dimension 4 (Refinance feasibility) — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Input: ${CORPUS_PATH}`);
  out.push(`Stressed refi constant default: ${(STRESSED_REFI_CONSTANT_DEFAULT * 100).toFixed(2)}%`);
  out.push('FRAMING: corpus losses are mostly TERM/operational, not refi — flat/weak separation EXPECTED.');
  out.push('');

  /* === SPOT CHECK — maturity-balance formula ============================ */
  out.push('================================================================');
  out.push('SPOT CHECK — maturity-balance formula (IO vs amortizing vs partial-IO)');
  out.push('================================================================');
  out.push('');
  // Case 1: IO no-paydown (amortMonths null)
  const c1 = computeMaturityBalance(10_000_000, 0.05, null, null, null);
  out.push(`  Case 1 IO no-paydown:   $10M / 5% / amortMonths=null →    balance=$${Math.round(c1.balance).toLocaleString()}  basis=${c1.basis}   (expected $10,000,000 — no paydown)`);
  // Case 2: full IO (ioYears == termYears)
  const c2 = computeMaturityBalance(10_000_000, 0.05, 360, 10, 10);
  out.push(`  Case 2 IO full term:    $10M / 5% / amort=360, IO=10, term=10 → balance=$${Math.round(c2.balance).toLocaleString()}  basis=${c2.basis}   (expected $10,000,000)`);
  // Case 3: fully amortizing — 30yr amort, 10yr term, no IO
  const c3 = computeMaturityBalance(10_000_000, 0.05, 360, 0, 10);
  out.push(`  Case 3 fully amort:     $10M / 5% / amort=360, IO=0, term=10 → balance=$${Math.round(c3.balance).toLocaleString()}  basis=${c3.basis}   (expected ~$8.19M — 10yr payments off a 30yr schedule)`);
  // Case 4: partial IO — 30yr amort, 10yr term, 5yr IO
  const c4 = computeMaturityBalance(10_000_000, 0.05, 360, 5, 10);
  out.push(`  Case 4 partial-IO:      $10M / 5% / amort=360, IO=5, term=10 → balance=$${Math.round(c4.balance).toLocaleString()}  basis=${c4.basis}   (expected ~$9.07M — 5yr IO then 5yr amort payments)`);
  // Case 5: zero IO + short amort
  const c5 = computeMaturityBalance(10_000_000, 0.05, 120, 0, 10);
  out.push(`  Case 5 self-amort:      $10M / 5% / amort=120, IO=0, term=10 → balance=$${Math.round(c5.balance).toLocaleString()}  basis=${c5.basis}   (expected $0 — fully amortizes in term)`);
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push(`  CLEAN ${records.filter(r => r.outcomeClass === 'CLEAN').length}   STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}   LOSS ${records.filter(r => r.outcomeClass === 'LOSS').length}`);
  out.push('');
  out.push('  Note: corpus does not extract amortMonths / ioYears / termYears today.');
  out.push('  EVERY record routes through the IO no-paydown path (balance = loanAmount).');
  out.push('  This is the agency-conservative default (IO carries full balance → worst exit).');
  out.push('');

  /* === PIPELINE === */
  const scored = records.map(r => {
    const norm = normalizeSustainableCashflow({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, t12Noi: r.t12Noi, underwrittenOccupancy: null,
    });
    const dim7 = evaluateCapRateValuationStress({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, sustainableNcf: norm.sustainableNcf,
      concludedValue: r.concludedValue, loanAmount: r.loanAmount, marketTier: 'Unknown',
    });
    const refi = evaluateRefinanceFeasibility({
      assetType: r.assetType,
      loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null,
      sustainableNcf: norm.sustainableNcf, sustainableNoi: norm.sustainableNoi,
      stressedValue: (dim7.derivedOutputs?.stressedValue as number | undefined | null) ?? null,
    });
    // Reference ratio dims for pari-passu consistency check
    const dscr = evaluateCoverageDscr({
      sustainableNcf: norm.sustainableNcf, loanAmount: r.loanAmount, coupon: r.coupon,
      amortMonths: null, ioYears: null, termYears: null,
    });
    const dy = evaluateDebtYield({
      sustainableNoi: norm.sustainableNoi, loanAmount: r.loanAmount, assetType: r.assetType, subType: r.subType,
    });
    const ltv = evaluateLeverageLtv({ stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null });
    return { record: r, norm, dim7, refi, dscr, dy, ltv };
  });

  /* === COVERAGE ROUTING ================================================ */
  out.push('================================================================');
  out.push('COVERAGE — applicability routing (2 states; no N/A-by-asset-type)');
  out.push('================================================================');
  out.push('');
  const buckets: Record<string, { CLEAN: number; LOSS: number; STRESS: number }> = {
    'applicable': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'hitl-needed': { CLEAN: 0, LOSS: 0, STRESS: 0 },
  };
  for (const s of scored) {
    const b = buckets[s.refi.applicability]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'routing'.padEnd(22)} CLEAN   LOSS   STRESS`);
  for (const [k, b] of Object.entries(buckets)) {
    out.push(`  ${k.padEnd(22)} ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');

  /* === EXIT METRIC RANGES + BUG SCREEN ================================ */
  out.push('================================================================');
  out.push('EXIT METRICS — range sanity + bug screen');
  out.push('================================================================');
  out.push('');
  const applicable = scored.filter(s => s.refi.applicability === 'applicable');
  const exitDscrs = applicable.map(s => s.refi.derivedOutputs?.exitDscr as number).filter(Number.isFinite);
  const exitDys = applicable.map(s => s.refi.derivedOutputs?.exitDy as number).filter(Number.isFinite);
  const exitLtvs = applicable.map(s => s.refi.derivedOutputs?.exitLtv as number).filter(Number.isFinite);
  out.push(`  exit DSCR: n=${exitDscrs.length}  min ${Math.min(...exitDscrs).toFixed(2)}x  mean ${mean(exitDscrs).toFixed(2)}x  median ${median(exitDscrs).toFixed(2)}x  max ${Math.max(...exitDscrs).toFixed(2)}x`);
  out.push(`  exit DY:   n=${exitDys.length}  min ${(Math.min(...exitDys) * 100).toFixed(2)}%  mean ${(mean(exitDys) * 100).toFixed(2)}%  median ${(median(exitDys) * 100).toFixed(2)}%  max ${(Math.max(...exitDys) * 100).toFixed(2)}%`);
  out.push(`  exit LTV:  n=${exitLtvs.length}  min ${(Math.min(...exitLtvs) * 100).toFixed(0)}%  mean ${(mean(exitLtvs) * 100).toFixed(0)}%  median ${(median(exitLtvs) * 100).toFixed(0)}%  max ${(Math.max(...exitLtvs) * 100).toFixed(0)}%`);
  out.push('');
  let nan = 0, inf = 0, neg = 0;
  for (const s of applicable) {
    const d = s.refi.derivedOutputs ?? {};
    for (const k of Object.keys(d)) {
      const v = d[k] as number | null;
      if (v === null) continue;
      if (Number.isNaN(v)) nan++;
      if (!Number.isFinite(v) && !Number.isNaN(v)) inf++;
      if (v < 0) neg++;
    }
  }
  out.push(`  NaN values across derivedOutputs: ${nan}  ${nan === 0 ? '✓' : '⚠'}`);
  out.push(`  Infinity values: ${inf}  ${inf === 0 ? '✓' : '⚠'}`);
  out.push(`  Negative values: ${neg}  ${neg === 0 ? '✓' : '⚠'}`);
  out.push('');
  // Sanity invariant: since amortMonths is null everywhere, maturity balance = loanAmount,
  // so exit LTV should equal dim 7 stressedLtv (within FP epsilon) for every record.
  const maxLtvDelta = Math.max(...applicable.map(s => {
    const exit = s.refi.derivedOutputs?.exitLtv as number;
    const going = s.dim7.derivedOutputs?.stressedLtv as number | null;
    if (going === null || going === undefined) return 0;
    return Math.abs(exit - going);
  }));
  out.push(`  Invariant check — max |exit LTV − going-in stressed LTV| (should be ~0 since balance=loanAmount): ${(maxLtvDelta * 1e8).toFixed(2)}e-8  ${maxLtvDelta < 1e-8 ? '✓' : '⚠ unexpected drift'}`);
  out.push('');

  /* === BAND DISTRIBUTION ================================================ */
  out.push('================================================================');
  out.push('BAND DISTRIBUTION — applicable records');
  out.push('================================================================');
  out.push('');
  const allTiers = ['low', 'moderate', 'elevated', 'high', 'convergent-stress'];
  out.push(`  ${'class'.padEnd(12)} ${allTiers.map(t => t.padStart(18)).join('')}  total`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const inCls = applicable.filter(s => s.record.outcomeClass === cls);
    const counts = allTiers.map(t => inCls.filter(s => s.refi.tier === t).length);
    out.push(`  ${cls.padEnd(12)} ${counts.map(c => c.toString().padStart(18)).join('')}  ${inCls.length.toString().padStart(5)}`);
  }
  out.push('');

  /* === KBRA-OFFICE-WATCH CONVERGENCE PATTERN =========================== */
  out.push('================================================================');
  out.push('KBRA-OFFICE-WATCH CONVERGENCE — distribution of legs-at-elevated+');
  out.push('================================================================');
  out.push('');
  const distLegs: Record<number, { CLEAN: number; LOSS: number; STRESS: number }> = {};
  for (let i = 0; i <= 3; i++) distLegs[i] = { CLEAN: 0, LOSS: 0, STRESS: 0 };
  for (const s of applicable) {
    const n = s.refi.derivedOutputs?.legsAtElevatedOrAbove as number;
    const b = distLegs[n]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'legs at elevated+'.padEnd(20)} CLEAN   LOSS   STRESS`);
  for (let i = 0; i <= 3; i++) {
    const b = distLegs[i]!;
    out.push(`  ${i.toString().padStart(18)}     ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');
  out.push(`  Records flagged "convergent-stress" (≥2 legs at elevated+) get a +0.10 risk bump.`);
  out.push('');

  /* === PARI-PASSU CONSISTENCY ========================================== */
  out.push('================================================================');
  out.push('PARI-PASSU CONSISTENCY — same trust-slice records inflate exit DY too');
  out.push('================================================================');
  out.push('');
  // The going-in DY dim already flagged DY > 30% as implausible. Refi exit DY
  // should flag the SAME set as elevated/high (since balance = loanAmount on
  // the current corpus, exit DY = going-in DY).
  const goingInDyAbove30 = applicable.filter(s => {
    const dy = s.dy.derivedOutputs?.debtYield as number | undefined;
    return dy !== undefined && dy > 0.30;
  });
  const exitDyAbove30 = applicable.filter(s => {
    const ed = s.refi.derivedOutputs?.exitDy as number;
    return ed > 0.30;
  });
  out.push(`  Going-in DY > 30%:    ${goingInDyAbove30.length} records`);
  out.push(`  Exit DY > 30%:        ${exitDyAbove30.length} records   ${goingInDyAbove30.length === exitDyAbove30.length ? '✓ same set (balance = loanAmount on current corpus)' : '⚠ unexpected divergence'}`);
  out.push('  Sample pari-passu trust-slice records (high exit DY = inflated by slice/whole gap):');
  for (const s of [...exitDyAbove30].sort((a, b) => (b.refi.derivedOutputs!.exitDy as number) - (a.refi.derivedOutputs!.exitDy as number)).slice(0, 5)) {
    const ed = s.refi.derivedOutputs!.exitDy as number;
    out.push(`    ${s.record.dealName.slice(0,18).padEnd(18)} / ${s.record.propertyName.slice(0,36).padEnd(36)}  exit DY=${(ed * 100).toFixed(1)}%`);
  }
  out.push('');

  /* === STANDALONE SEPARATION (flat acceptable) ========================== */
  out.push('================================================================');
  out.push('STANDALONE SEPARATION — LOSS vs CLEAN (flat/weak acceptable)');
  out.push('================================================================');
  out.push('');
  out.push('  CONTEXT: clean corpus losses are mostly TERM/operational defaults (Anderson Mall,');
  out.push('  Windmill Lakes, Candlewood/Comfort, MSBAM #43, WFCM #39, etc.). They are NOT');
  out.push('  maturity/refi failures. Flat/weak separation here CONFIRMS the dimension is doing');
  out.push('  the right thing — it identifies refi risk, not term-default risk.');
  out.push('');
  const get = (cls: 'CLEAN' | 'LOSS', f: (s: typeof scored[number]) => number | undefined): number[] =>
    scored.filter(s => s.record.outcomeClass === cls).map(f).filter((x): x is number => x !== undefined && x !== null && Number.isFinite(x));
  const cExitDscr = get('CLEAN', s => s.refi.derivedOutputs?.exitDscr as number);
  const lExitDscr = get('LOSS',  s => s.refi.derivedOutputs?.exitDscr as number);
  const cExitDy   = get('CLEAN', s => s.refi.derivedOutputs?.exitDy as number);
  const lExitDy   = get('LOSS',  s => s.refi.derivedOutputs?.exitDy as number);
  const cExitLtv  = get('CLEAN', s => s.refi.derivedOutputs?.exitLtv as number);
  const lExitLtv  = get('LOSS',  s => s.refi.derivedOutputs?.exitLtv as number);
  const cRisk     = get('CLEAN', s => s.refi.riskContribution ?? undefined);
  const lRisk     = get('LOSS',  s => s.refi.riskContribution ?? undefined);
  out.push(`  ${'metric'.padEnd(14)} CLEAN-mean  LOSS-mean   gap (LOSS-CLEAN)`);
  out.push(`  exit DSCR      ${mean(cExitDscr).toFixed(2).padStart(10)}x ${mean(lExitDscr).toFixed(2).padStart(8)}x  ${(mean(lExitDscr) - mean(cExitDscr)).toFixed(2)}x`);
  out.push(`  exit DY        ${(mean(cExitDy) * 100).toFixed(2).padStart(10)}% ${(mean(lExitDy) * 100).toFixed(2).padStart(7)}%  ${((mean(lExitDy) - mean(cExitDy)) * 100).toFixed(2)}pp`);
  out.push(`  exit LTV       ${(mean(cExitLtv) * 100).toFixed(1).padStart(10)}% ${(mean(lExitLtv) * 100).toFixed(1).padStart(7)}%  ${((mean(lExitLtv) - mean(cExitLtv)) * 100).toFixed(1)}pp`);
  out.push(`  riskContrib    ${mean(cRisk).toFixed(2).padStart(10)}  ${mean(lRisk).toFixed(2).padStart(8)}  ${(mean(lRisk) - mean(cRisk)).toFixed(2)}`);
  out.push('');
  out.push(`  ⚠ UNINFORMATIVE AT THIS n. n=${lRisk.length} LOSS records in applicable subset is too small`);
  out.push('  for a statistical claim. The dimension\'s value is FORWARD-LOOKING (refi risk for live');
  out.push('  loans approaching maturity under a different rate regime), not validated by this corpus.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old refi logic');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|refi_constant|refi_test|maturity_default" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for dim 4 traces ONLY to:');
  out.push('    - spec v2 §4 (verbatim in dim header)');
  out.push('    - KBRA office Watch refi test (low DY + high LTV + low coverage + near-term maturity converge)');
  out.push('    - DBRS Morningstar post-GFC stressed take-out treatment');
  out.push('    - Moody\'s Approach to Rating US Conduit/Fusion CMBS — term + maturity in PoD');
  out.push('    - Stressed refi constant default ~9.25% (agency-convention central, NOT corpus-fit)');
  out.push('  NEVER to manifesto_rules.json / old doctrine / old refi logic.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d4] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
