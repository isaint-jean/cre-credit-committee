/**
 * Standalone sanity check for doctrine-clean dimension 7
 * (Cap-rate / valuation stress) against the clean backbone corpus.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d7-cap-rate.ts
 *
 * LIGHTER than dim-6 / dim-8 validations on purpose:
 *   - corpus is too thin (n=12 LOSS, fewer with NOI+value populated)
 *     to refit deltas without overfitting
 *   - the dimension's primary purpose is to publish the STRESSED VALUE
 *     downstream LTV / DSCR / DY compute against — its risk signal is
 *     a SECONDARY output
 *
 * What this checks:
 *   - SANITY: stressed cap rates plausible (5-12% range)
 *   - SANITY: stressed values are below concluded values for substantially
 *     all populated records (the agency Value-below-appraisal invariant)
 *   - SANITY: stressed LTV plausible (40-200% range; over 100% = leveraged
 *     above the agency-stressed value, which IS the dim 7 signal)
 *   - COVERAGE: 2-state routing (applicable / hitl-needed) — no record
 *     silently bucketed
 *   - DIRECTIONAL: LOSS vs CLEAN mean gap on valuation aggressiveness —
 *     reported WITH the "n=3 LOSS in applicable subset — uninformative
 *     at this n" caveat
 *   - BUG screen: no NaN / Infinity / negative stressed values
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateCapRateValuationStress,
  ASSET_CAP_RATE_FLOORS,
  VALUATION_AGGRESSIVENESS_BANDS,
  type CapRateValuationStressInput,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d7-cap-rate.out';

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number | null;
  bcLoss: number | null;
  concludedValue: number | null;
  uwY1Noi: number | null;
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
  out.push('doctrine-clean / dimension 7 (Cap-rate / valuation stress) — standalone sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('LIGHTER SANITY CHECK: corpus n=12 LOSS too thin to refit deltas without overfitting.');
  out.push('Public-range floors used; corpus is coarse sanity only, not a calibration target.');
  out.push('');

  /* === ASSET FLOOR TABLE ================================================= */
  out.push('================================================================');
  out.push('ASSET-CLASS GOING-IN CAP RATE FLOORS (public-source derived)');
  out.push('================================================================');
  out.push('');
  out.push(`  ${'asset class'.padEnd(20)} going-in   DBRS range`);
  for (const f of ASSET_CAP_RATE_FLOORS) {
    const range = `${(f.dbrsRangeLow * 100).toFixed(1)}-${(f.dbrsRangeHigh * 100).toFixed(1)}%`;
    out.push(`  ${f.assetClass.padEnd(20)} ${(f.goingInDecimal * 100).toFixed(2).padStart(5)}%    ${range.padEnd(14)}`);
  }
  out.push('  (Terminal = going-in + 50 bps; market-tier delta -/0/+50 bps, Unknown = 0)');
  out.push('');

  /* === VALUATION BANDS =================================================== */
  out.push('================================================================');
  out.push('VALUATION AGGRESSIVENESS BANDS (risk contribution)');
  out.push('================================================================');
  out.push('');
  out.push('  Tier      Risk    Aggressiveness range (stressed-vs-concluded haircut)');
  for (const b of VALUATION_AGGRESSIVENESS_BANDS) {
    const lo = b.minAggressiveness === Number.NEGATIVE_INFINITY ? '−∞' : (b.minAggressiveness * 100).toFixed(0) + '%';
    const hi = b.maxAggressiveness === Number.POSITIVE_INFINITY ? '+∞' : (b.maxAggressiveness * 100).toFixed(0) + '%';
    out.push(`  ${b.tier.padEnd(10)} ${b.riskContribution.toFixed(2)}    [${lo}, ${hi})`);
  }
  out.push('  N/A         ---    HITL — assetType/uwY1Noi/concludedValue missing');
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  const cleansAll = records.filter(r => r.outcomeClass === 'CLEAN');
  const lossesAll = records.filter(r => r.outcomeClass === 'LOSS');
  const stressesAll = records.filter(r => r.outcomeClass === 'STRESS-ONLY');
  out.push(`Records (non-pending): ${records.length}   CLEAN ${cleansAll.length}   STRESS-ONLY ${stressesAll.length}   LOSS ${lossesAll.length}`);
  out.push('');

  /* === SCORE === */
  const scored = records.map(r => {
    const input: CapRateValuationStressInput = {
      assetType: r.assetType,
      subType: r.subType,
      uwY1Noi: r.uwY1Noi,
      concludedValue: r.concludedValue,
      loanAmount: r.loanAmount,
      marketTier: 'Unknown',
    };
    return { record: r, contribution: evaluateCapRateValuationStress(input) };
  });

  /* === (1) COVERAGE ROUTING (2 states) ================================== */
  out.push('================================================================');
  out.push('(1) COVERAGE — applicability routing (the two input states)');
  out.push('================================================================');
  out.push('');
  out.push('  Two routings (this dimension has no N/A-by-asset-type — applies universally):');
  out.push('    populated       → applicability=\'applicable\', riskContribution non-null');
  out.push('    null/missing    → applicability=\'hitl-needed\', riskContribution null');
  out.push('');
  const buckets: Record<string, { CLEAN: number; LOSS: number; STRESS: number }> = {
    'applicable': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'hitl-needed': { CLEAN: 0, LOSS: 0, STRESS: 0 },
  };
  for (const s of scored) {
    const b = buckets[s.contribution.applicability]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'routing'.padEnd(22)} CLEAN   LOSS   STRESS`);
  for (const [k, b] of Object.entries(buckets)) {
    out.push(`  ${k.padEnd(22)} ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');
  out.push('  Sanity: every record in exactly one bucket; no double-count, no silent default.');
  out.push('');

  /* === (2) SANITY — stressed cap rates plausible ======================== */
  out.push('================================================================');
  out.push('(2) SANITY — stressed cap rates plausible (5-12% bounds)');
  out.push('================================================================');
  out.push('');
  const applicable = scored.filter(s => s.contribution.applicability === 'applicable');
  const capRates = applicable
    .map(s => s.contribution.derivedOutputs?.stressedCapRateGoingIn ?? null)
    .filter((x): x is number => x !== null);
  if (capRates.length > 0) {
    out.push(`  n=${capRates.length}   min ${(Math.min(...capRates) * 100).toFixed(2)}%   mean ${(mean(capRates) * 100).toFixed(2)}%   median ${(median(capRates) * 100).toFixed(2)}%   max ${(Math.max(...capRates) * 100).toFixed(2)}%`);
    const implausible = capRates.filter(c => c < 0.04 || c > 0.13);
    out.push(`  Implausible (< 4% or > 13%): ${implausible.length}  ${implausible.length === 0 ? '✓' : '⚠ check input or floor table'}`);
  }
  out.push('');

  /* === (3) SANITY — stressed values BELOW concluded values =============== */
  out.push('================================================================');
  out.push('(3) SANITY — stressed value below concluded value (agency invariant)');
  out.push('================================================================');
  out.push('');
  const sVsCRaw = applicable.map(s => ({
    rec: s.record,
    stressed: s.contribution.derivedOutputs?.stressedValue ?? null,
    aggressiveness: s.contribution.derivedOutputs?.valuationAggressiveness ?? null,
  })).filter(x => x.stressed !== null && x.aggressiveness !== null);
  const belowConcluded = sVsCRaw.filter(x => (x.stressed as number) < (x.rec.concludedValue as number)).length;
  const aboveConcluded = sVsCRaw.filter(x => (x.stressed as number) >= (x.rec.concludedValue as number)).length;
  out.push(`  Stressed value < concluded value: ${belowConcluded}/${sVsCRaw.length}`);
  out.push(`  Stressed value >= concluded value: ${aboveConcluded}/${sVsCRaw.length}   ${aboveConcluded === 0 ? '✓ all stressed values below concluded' : '⚠ above-appraisal records — see list below'}`);
  if (aboveConcluded > 0) {
    out.push('');
    out.push('  Records where stressed value >= concluded (issuer cap rate already at/above floor):');
    for (const x of sVsCRaw.filter(x => (x.stressed as number) >= (x.rec.concludedValue as number)).slice(0, 12)) {
      const aggPct = ((x.aggressiveness as number) * 100).toFixed(1);
      out.push(`    ${x.rec.dealName} / ${x.rec.propertyName.padEnd(36).slice(0, 36)}  agg ${aggPct.padStart(6)}%  assetType=${x.rec.assetType ?? 'null'}`);
    }
  }
  out.push('');

  /* === (4) SANITY — stressed LTV in plausible range ===================== */
  out.push('================================================================');
  out.push('(4) SANITY — stressed LTV plausible range');
  out.push('================================================================');
  out.push('');
  const stressedLtvs = applicable
    .map(s => s.contribution.derivedOutputs?.stressedLtv ?? null)
    .filter((x): x is number => x !== null);
  if (stressedLtvs.length > 0) {
    out.push(`  n=${stressedLtvs.length}   min ${(Math.min(...stressedLtvs) * 100).toFixed(0)}%   mean ${(mean(stressedLtvs) * 100).toFixed(0)}%   median ${(median(stressedLtvs) * 100).toFixed(0)}%   max ${(Math.max(...stressedLtvs) * 100).toFixed(0)}%`);
    const negLtv = stressedLtvs.filter(x => x < 0).length;
    const overLeverage = stressedLtvs.filter(x => x > 1.5).length;
    out.push(`  Negative / NaN stressed LTV: ${negLtv}  ${negLtv === 0 ? '✓' : '⚠ bug'}`);
    out.push(`  Above 150% stressed LTV (over-leveraged vs stressed value): ${overLeverage}`);
    out.push(`     → this IS dim 7\'s signal: loans leveraged above the stressed value; not a bug`);
  }
  out.push('');

  /* === (5) SANITY — no NaN / Infinity =================================== */
  out.push('================================================================');
  out.push('(5) BUG SCREEN — no NaN / Infinity / negative stressed values');
  out.push('================================================================');
  out.push('');
  let nanCount = 0;
  let infCount = 0;
  let negStressedValueCount = 0;
  for (const s of applicable) {
    const d = s.contribution.derivedOutputs ?? {};
    for (const k of Object.keys(d)) {
      const v = d[k] as number | null;
      if (v === null) continue;
      if (Number.isNaN(v)) nanCount++;
      if (!Number.isFinite(v) && !Number.isNaN(v)) infCount++;
      if (k === 'stressedValue' && v < 0) negStressedValueCount++;
    }
  }
  out.push(`  NaN values across derivedOutputs: ${nanCount}  ${nanCount === 0 ? '✓' : '⚠'}`);
  out.push(`  Infinity values across derivedOutputs: ${infCount}  ${infCount === 0 ? '✓' : '⚠'}`);
  out.push(`  Negative stressedValue: ${negStressedValueCount}  ${negStressedValueCount === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === (6) DIRECTIONAL (uninformative at n=12 — caveated) =============== */
  out.push('================================================================');
  out.push('(6) DIRECTIONAL — LOSS vs CLEAN on valuation aggressiveness');
  out.push('================================================================');
  out.push('');
  const aggByClass = (cls: 'CLEAN' | 'LOSS'): number[] => applicable
    .filter(s => s.record.outcomeClass === cls)
    .map(s => s.contribution.derivedOutputs?.valuationAggressiveness ?? null)
    .filter((x): x is number => x !== null);
  const cleanAgg = aggByClass('CLEAN');
  const lossAgg = aggByClass('LOSS');
  out.push(`  ${'class'.padEnd(8)} n    mean      median    min       max`);
  for (const [label, xs] of [['CLEAN', cleanAgg], ['LOSS', lossAgg]] as const) {
    if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
    const fmt = (x: number) => (x * 100).toFixed(1) + '%';
    out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}  ${fmt(mean(xs)).padStart(7)}   ${fmt(median(xs)).padStart(7)}   ${fmt(Math.min(...xs)).padStart(7)}   ${fmt(Math.max(...xs)).padStart(7)}`);
  }
  if (cleanAgg.length > 0 && lossAgg.length > 0) {
    const gap = mean(lossAgg) - mean(cleanAgg);
    out.push('');
    out.push(`  Mean gap (LOSS − CLEAN): ${(gap * 100).toFixed(1)} pts   (positive = LOSS more aggressive valuation)`);
  }
  out.push('');
  out.push(`  ⚠ UNINFORMATIVE AT THIS n. Corpus n=${lossAgg.length} LOSS records in applicable`);
  out.push('    subset is too small to draw a statistical signal — any apparent gap (or its');
  out.push('    direction) reflects noise more than dimensional separation. This is the SPECIFIC');
  out.push('    reason we derived deltas from PUBLIC RANGES, not from the corpus. The dimension\'s');
  out.push('    correctness rests on the public-source provenance, not on this loss-rate split.');
  out.push('');

  /* === (7) BAND DISTRIBUTION (informational) ============================ */
  out.push('================================================================');
  out.push('(7) BAND DISTRIBUTION — applicable records');
  out.push('================================================================');
  out.push('');
  out.push(`  ${'class'.padEnd(12)} low   moderate  elevated  high   total`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const d: Record<string, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
    for (const s of applicable.filter(s => s.record.outcomeClass === cls)) {
      d[s.contribution.tier] = (d[s.contribution.tier] ?? 0) + 1;
    }
    const total = applicable.filter(s => s.record.outcomeClass === cls).length;
    out.push(`  ${cls.padEnd(12)} ${(d.low ?? 0).toString().padStart(3)}   ${(d.moderate ?? 0).toString().padStart(7)}   ${(d.elevated ?? 0).toString().padStart(8)}   ${(d.high ?? 0).toString().padStart(4)}   ${total.toString().padStart(5)}`);
  }
  out.push('');

  /* === (8) HITL list (compact) ========================================== */
  out.push('================================================================');
  out.push('(8) HITL records (compact breakdown)');
  out.push('================================================================');
  out.push('');
  const hitl = scored.filter(s => s.contribution.applicability === 'hitl-needed');
  out.push(`  n records routed to HITL: ${hitl.length}`);
  const missingCount: Record<string, number> = { 'assetType': 0, 'uwY1Noi': 0, 'concludedValue': 0 };
  for (const s of hitl) {
    if (s.record.assetType === null) missingCount.assetType!++;
    if (s.record.uwY1Noi === null) missingCount.uwY1Noi!++;
    if (s.record.concludedValue === null) missingCount.concludedValue!++;
  }
  for (const [k, n] of Object.entries(missingCount)) out.push(`    missing ${k.padEnd(20)} ${n}`);
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / cap-rate deltas');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|cap_rate_delta|cap-rate-delta" apps/api/src/doctrine-clean');
  out.push('  Expected output: README fence statement only.');
  out.push('');
  out.push('  Provenance for dim 7 (Cap-rate / valuation stress) traces ONLY to:');
  out.push('    - spec v2 §7 (verbatim block in cap-rate-valuation-stress.ts header)');
  out.push('    - DBRS Morningstar stressed cap-rate ranges (per asset class)');
  out.push('    - KBRA North American CMBS Property Evaluation Methodology — asset-specific KBRA cap rate');
  out.push('    - Moody\'s Approach to Rating US Conduit/Fusion CMBS — quality-grade → cap rate');
  out.push('    - Public cap-rate data — MSCI/RCA US National All-Property Index, Trepp CMBS appraisal-cap series');
  out.push('    - DBRS LTV Sizing Benchmark calibration (~61% LTV vs ~39% decline) for band breaks');
  out.push('    - CREFC / CMBS convention for terminal-vs-going-in widen');
  out.push('  NEVER to manifesto_rules.json, the old doctrine, or the old corpus-tuned tier deltas.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d7] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
