/**
 * Sanity validation for doctrine-clean sustainable-cashflow normalization
 * + dim 7 re-point (numerator switched from issuer NOI to sustainable NCF).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-sustainable-cashflow.ts
 *
 * SANITY CHECK ONLY (corpus n=12 LOSS too thin for calibration). What we
 * actually check:
 *
 *   (A) Coverage routing — applicable / hitl-needed (2 states; the
 *       normalization has no N/A-by-asset-type — every asset class
 *       has cashflow).
 *
 *   (B) Sanity — sustainable NCF <= issuer NOI for every applicable record
 *       (haircuts are always non-positive on cashflow), no NaN/Infinity.
 *
 *   (C) Haircut DISTRIBUTION — for each step (NOI-divergence, vacancy,
 *       NCF capital), report counts by status.
 *
 *   (D) Dim 7 re-point: re-run dim 7 with sustainable NCF as numerator,
 *       compare stressed value vs the issuer-NOI-based stressed value.
 *       Sustainable-NCF stressed values must be <= issuer-NOI stressed
 *       values for every applicable record (no regressions).
 *
 *   (E) Standalone loss-separation on the re-pointed valuation aggressiveness,
 *       with the "uninformative at n=12 LOSS" caveat.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  type SustainableCashflowInput,
  type CapRateValuationStressInput,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-sustainable-cashflow.out';

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number | null;
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
  out.push('doctrine-clean / sustainable-cashflow normalization + dim 7 re-point — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('SANITY CHECK ONLY (corpus n=12 LOSS too thin to calibrate; haircuts derived from public conventions).');
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push(`  CLEAN ${records.filter(r => r.outcomeClass === 'CLEAN').length}   STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}   LOSS ${records.filter(r => r.outcomeClass === 'LOSS').length}`);
  out.push('');

  /* === RUN NORMALIZATION === */
  const normResults = records.map(r => {
    const input: SustainableCashflowInput = {
      assetType: r.assetType,
      subType: r.subType,
      uwY1Noi: r.uwY1Noi,
      t12Noi: r.t12Noi,
      underwrittenOccupancy: null,  // corpus does not surface occupancy
    };
    return { record: r, normalized: normalizeSustainableCashflow(input) };
  });

  /* === (A) COVERAGE ROUTING (2 states) ================================== */
  out.push('================================================================');
  out.push('(A) COVERAGE — applicability routing');
  out.push('================================================================');
  out.push('');
  out.push('  Two routings (normalization has no N/A-by-asset-type — every class has cashflow):');
  out.push('    applicable     → sustainable NCF computed');
  out.push('    hitl-needed    → assetType OR uwY1Noi missing; sustainable NCF null');
  out.push('');
  const buckets: Record<string, { CLEAN: number; LOSS: number; STRESS: number }> = {
    'applicable': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'hitl-needed': { CLEAN: 0, LOSS: 0, STRESS: 0 },
  };
  for (const s of normResults) {
    const b = buckets[s.normalized.routeStatus]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'routing'.padEnd(22)} CLEAN   LOSS   STRESS`);
  for (const [k, b] of Object.entries(buckets)) {
    out.push(`  ${k.padEnd(22)} ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');

  /* === (B) SANITY — sustainable NCF <= issuer NOI, no NaN/Inf =========== */
  out.push('================================================================');
  out.push('(B) SANITY — sustainable NCF vs issuer NOI');
  out.push('================================================================');
  out.push('');
  const applicable = normResults.filter(s => s.normalized.routeStatus === 'applicable');
  let countSustainableExceeds = 0;
  let nanCount = 0;
  let infCount = 0;
  const haircuts: number[] = [];
  for (const s of applicable) {
    const ncf = s.normalized.sustainableNcf!;
    const noi = s.normalized.issuerNoi!;
    if (Number.isNaN(ncf)) nanCount++;
    if (!Number.isFinite(ncf) && !Number.isNaN(ncf)) infCount++;
    if (ncf > noi + 0.01) countSustainableExceeds++;  // tolerance for FP noise
    haircuts.push(1 - ncf / noi);
  }
  out.push(`  n applicable: ${applicable.length}`);
  out.push(`  Records where sustainable NCF > issuer NOI: ${countSustainableExceeds}  ${countSustainableExceeds === 0 ? '✓ haircut always non-positive' : '⚠ bug'}`);
  out.push(`  NaN sustainable NCF: ${nanCount}  ${nanCount === 0 ? '✓' : '⚠'}`);
  out.push(`  Infinity sustainable NCF: ${infCount}  ${infCount === 0 ? '✓' : '⚠'}`);
  if (haircuts.length > 0) {
    out.push(`  Overall haircut (1 - NCF/NOI): min ${(Math.min(...haircuts) * 100).toFixed(1)}%   mean ${(mean(haircuts) * 100).toFixed(1)}%   median ${(median(haircuts) * 100).toFixed(1)}%   max ${(Math.max(...haircuts) * 100).toFixed(1)}%`);
  }
  out.push('');

  /* === (C) HAIRCUT DISTRIBUTION by step ================================ */
  out.push('================================================================');
  out.push('(C) HAIRCUT DISTRIBUTION — by step');
  out.push('================================================================');
  out.push('');
  const divStatus: Record<string, number> = {};
  const vacStatus: Record<string, number> = {};
  const ncfStatus: Record<string, number> = {};
  for (const s of applicable) {
    const h = s.normalized.haircutTrace;
    divStatus[h.noiDivergence.status] = (divStatus[h.noiDivergence.status] ?? 0) + 1;
    vacStatus[h.vacancy.status] = (vacStatus[h.vacancy.status] ?? 0) + 1;
    ncfStatus[h.ncfCapital.status] = (ncfStatus[h.ncfCapital.status] ?? 0) + 1;
  }
  out.push('  (A) NOI-divergence haircut:');
  for (const [k, n] of Object.entries(divStatus).sort()) out.push(`        ${k.padEnd(28)} ${n}`);
  out.push('');
  out.push('  (B) Vacancy haircut (DBRS stabilized-NCF basis):');
  for (const [k, n] of Object.entries(vacStatus).sort()) out.push(`        ${k.padEnd(34)} ${n}`);
  out.push('');
  out.push('  (C) NCF capital deduction (KBRA KNCF basis):');
  for (const [k, n] of Object.entries(ncfStatus).sort()) out.push(`        ${k.padEnd(28)} ${n}`);
  out.push('');

  // Sample of records that hit the NOI-divergence haircut
  out.push('  Sample records that hit the divergence haircut (top 12):');
  const divHit = applicable.filter(s => s.normalized.haircutTrace.noiDivergence.status === 'haircut-to-t12').slice(0, 12);
  for (const s of divHit) {
    const t = s.normalized.haircutTrace.noiDivergence;
    const retentionPct = (t.haircutApplied * 100).toFixed(1);
    const haircutPct = ((1 - t.haircutApplied) * 100).toFixed(1);
    out.push(`    ${s.record.dealName.slice(0,18).padEnd(18)} / ${s.record.propertyName.slice(0,36).padEnd(36)}  ratio=${(t.ratioUwToT12 ?? 0).toFixed(2)}  retain=${retentionPct}%  haircut=${haircutPct}%`);
  }
  out.push('');

  /* === (D) DIM 7 RE-POINT ============================================== */
  out.push('================================================================');
  out.push('(D) DIM 7 RE-POINT — sustainable NCF as numerator (no regressions)');
  out.push('================================================================');
  out.push('');
  // Run dim 7 BOTH ways and compare.
  const dim7Both = records.map(r => {
    const norm = normResults.find(n => n.record === r)!.normalized;
    const baseInput: CapRateValuationStressInput = {
      assetType: r.assetType,
      subType: r.subType,
      uwY1Noi: r.uwY1Noi,
      concludedValue: r.concludedValue,
      loanAmount: r.loanAmount,
      marketTier: 'Unknown',
    };
    const dim7Noi = evaluateCapRateValuationStress(baseInput);
    const dim7Ncf = evaluateCapRateValuationStress({ ...baseInput, sustainableNcf: norm.sustainableNcf });
    return { record: r, dim7Noi, dim7Ncf };
  });

  const applicableBoth = dim7Both.filter(x => x.dim7Noi.applicability === 'applicable' && x.dim7Ncf.applicability === 'applicable');
  let stressedNcfHigherCount = 0;
  let stressedNcfLowerCount = 0;
  let stressedNcfEqualCount = 0;
  let valueDeltas: number[] = [];
  for (const x of applicableBoth) {
    const sNoi = x.dim7Noi.derivedOutputs?.stressedValue as number;
    const sNcf = x.dim7Ncf.derivedOutputs?.stressedValue as number;
    if (sNcf > sNoi + 0.01) stressedNcfHigherCount++;
    else if (sNcf < sNoi - 0.01) stressedNcfLowerCount++;
    else stressedNcfEqualCount++;
    valueDeltas.push((sNoi - sNcf) / sNoi);
  }
  out.push(`  Records evaluated by both runs: ${applicableBoth.length}`);
  out.push(`  Sustainable-NCF stressed value < NOI-based stressed value: ${stressedNcfLowerCount}  ✓ expected (haircut never adds)`);
  out.push(`  Sustainable-NCF stressed value = NOI-based stressed value: ${stressedNcfEqualCount}  (no haircut applied: NCF/NOI=1 path or no divergence)`);
  out.push(`  Sustainable-NCF stressed value > NOI-based stressed value: ${stressedNcfHigherCount}  ${stressedNcfHigherCount === 0 ? '✓ no regressions' : '⚠ regression'}`);
  if (valueDeltas.length > 0) {
    out.push(`  Stressed-value DELTA (NOI − NCF, fraction): min ${(Math.min(...valueDeltas) * 100).toFixed(1)}%   mean ${(mean(valueDeltas) * 100).toFixed(1)}%   median ${(median(valueDeltas) * 100).toFixed(1)}%   max ${(Math.max(...valueDeltas) * 100).toFixed(1)}%`);
  }
  out.push('');

  // Band-distribution shift (CLEAN+LOSS only, excluding STRESS-ONLY for cleaner read).
  out.push('  Band shift on dim 7 (CLEAN + LOSS, applicable both ways):');
  const distBy = (which: 'noi' | 'ncf', cls: 'CLEAN' | 'LOSS'): Record<string, number> => {
    const out: Record<string, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
    for (const x of applicableBoth.filter(x => x.record.outcomeClass === cls)) {
      const tier = (which === 'noi' ? x.dim7Noi : x.dim7Ncf).tier;
      out[tier] = (out[tier] ?? 0) + 1;
    }
    return out;
  };
  for (const cls of ['CLEAN', 'LOSS'] as const) {
    const a = distBy('noi', cls); const b = distBy('ncf', cls);
    out.push(`    ${cls} (issuer NOI → sustainable NCF):`);
    for (const tier of ['low', 'moderate', 'elevated', 'high'] as const) {
      out.push(`      ${tier.padEnd(10)}: ${(a[tier] ?? 0).toString().padStart(3)} → ${(b[tier] ?? 0).toString().padStart(3)}`);
    }
  }
  out.push('');

  /* === (E) STANDALONE LOSS SEPARATION (caveated) ======================== */
  out.push('================================================================');
  out.push('(E) STANDALONE — valuation aggressiveness on sustainable NCF basis');
  out.push('================================================================');
  out.push('');
  const aggBy = (cls: 'CLEAN' | 'LOSS'): number[] =>
    applicableBoth.filter(x => x.record.outcomeClass === cls)
      .map(x => x.dim7Ncf.derivedOutputs?.valuationAggressiveness as number)
      .filter(x => x !== null && x !== undefined && !Number.isNaN(x));
  const c = aggBy('CLEAN');
  const l = aggBy('LOSS');
  out.push(`  ${'class'.padEnd(8)} n    mean      median    min       max`);
  const fmt = (x: number) => (x * 100).toFixed(1) + '%';
  for (const [label, xs] of [['CLEAN', c], ['LOSS', l]] as const) {
    if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
    out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}  ${fmt(mean(xs)).padStart(7)}   ${fmt(median(xs)).padStart(7)}   ${fmt(Math.min(...xs)).padStart(7)}   ${fmt(Math.max(...xs)).padStart(7)}`);
  }
  if (c.length > 0 && l.length > 0) {
    out.push(`  Mean gap (LOSS − CLEAN): ${((mean(l) - mean(c)) * 100).toFixed(1)} pts`);
  }
  out.push('');
  out.push(`  ⚠ UNINFORMATIVE AT THIS n. Corpus n=${l.length} LOSS records in applicable subset is`);
  out.push('    too small for a statistical claim. The dimensions\' correctness rests on the public-');
  out.push('    source provenance, not on this loss-rate split. Re-test after richer extraction.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / NOI-divergence / income-recovery');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|noi[_-]?divergence|income[_-]?recovery|cap_rate_delta" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only inside README fence statement + dim 7 / sustainable-cashflow doc comments that NAME the fenced symbols to say "we do NOT use them".');
  out.push('');
  out.push('  Provenance for the normalization traces ONLY to:');
  out.push('    - spec v2 convergence spine (re-derive sustainable cash flow before sizing leverage/coverage)');
  out.push('    - KBRA KNCF — haircut cash flow construction, asset-class NCF/NOI norms');
  out.push('    - DBRS Morningstar — stabilized NCF, stabilized vacancy floors');
  out.push('    - KBRA pre-sale variance convention — material variance ~5% uwY1Noi vs T-12');
  out.push('  NEVER to old manifesto_rules.json / old doctrine cashflow / old NOI-divergence / old income-recovery code.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean cashflow] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
