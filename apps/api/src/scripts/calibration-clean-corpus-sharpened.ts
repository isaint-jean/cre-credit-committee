/**
 * Calibration baseline — SHARPENED READ
 *
 * Strips two confounds from the existing baseline output to read the
 * doctrine's actual RISK discrimination (separable from band-cap noise
 * + top-loan selection):
 *   (1) PRE-CAP risk separation on mechanicalScore (pre-band-cap)
 *   (2) COMPLETE-INPUT subset (inputCompletePct ≥ 90%)
 *   (3) RAW-METRIC LOSS vs CLEAN — concludedLtv, NCF DSCR, NOI DSCR, DY
 *   (4) SIZE CONTROL — restrict cleans to smallest quartile
 *   (5) MISSED-LOSS foreseeability — raw metrics on the 3 misses
 *   (6) FP HEADROOM split — cap-driven vs risk-score-driven
 *
 *   cd apps/api && npx tsx src/scripts/calibration-clean-corpus-sharpened.ts
 *
 * Analysis only. Reads /tmp/calibration-clean-corpus.csv + the corpus JSON.
 * No new doctrine run, no doctrine / manifesto edits, no rebuild.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSV_PATH = '/tmp/calibration-clean-corpus.csv';
const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-clean-corpus-sharpened.out';

/* ============================================================================
 * Row shapes — CSV row + corpus record (merged on cik+prosId)
 * ========================================================================== */

interface CsvRow {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number;
  engineBand: string;
  finalScore: number;
  mechScore: number;
  gateFired: boolean;
  bandCapApplied: boolean;
  inputCompletePct: number;
}

interface CorpusRecord {
  cik: string;
  prosId: string;
  outcomeClass: string;
  loanAmount: number | null;
  coupon: number | null;
  concludedValue: number | null;
  concludedLtv: number | null;
  uwDscrNoi: number | null;
  uwDscrNcf: number | null;
  uwY1Noi: number | null;
  t12Noi: number | null;
  bcLoss: number | null;
}

interface MergedRow extends CsvRow {
  raw: CorpusRecord;
  debtYield: number | null;
}

function parseCsv(): CsvRow[] {
  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const out: CsvRow[] = [];
  // Light CSV parsing — handles quoted fields (propertyName + dealName)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cells: string[] = [];
    let buf = '', q = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"' && line[j + 1] === '"') { buf += '"'; j++; continue; }
      if (c === '"') { q = !q; continue; }
      if (c === ',' && !q) { cells.push(buf); buf = ''; continue; }
      buf += c;
    }
    cells.push(buf);
    if (cells.length < 14) continue;
    out.push({
      cik: cells[0]!,
      dealName: cells[1]!,
      shelf: cells[2]!,
      prosId: cells[3]!,
      propertyName: cells[4]!,
      outcomeClass: cells[5] as CsvRow['outcomeClass'],
      inputSource: cells[6]!,
      loanAmount: Number(cells[7]) || 0,
      engineBand: cells[8]!,
      finalScore: Number(cells[9]),
      mechScore: Number(cells[10]),
      gateFired: cells[11] === 'Y',
      bandCapApplied: cells[12] === 'Y',
      inputCompletePct: Number(cells[13]) / 100,
    });
  }
  return out;
}

function mergeWithCorpus(csv: CsvRow[]): MergedRow[] {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const idx = new Map<string, CorpusRecord>();
  for (const r of corpus.records) idx.set(`${r.cik}::${r.prosId}`, r);
  const out: MergedRow[] = [];
  for (const c of csv) {
    const raw = idx.get(`${c.cik}::${c.prosId}`);
    if (raw === undefined) continue;
    const debtYield = raw.uwY1Noi !== null && raw.loanAmount !== null && raw.loanAmount > 0
      ? raw.uwY1Noi / raw.loanAmount
      : null;
    out.push({ ...c, raw, debtYield });
  }
  return out;
}

/* ============================================================================
 * Stats helpers
 * ========================================================================== */
function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[i - 1]! + s[i]!) / 2 : s[i]!;
}
function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
function nonNull(xs: (number | null)[]): number[] {
  return xs.filter((x): x is number => x !== null && Number.isFinite(x));
}

/* ============================================================================
 * MAIN
 * ========================================================================== */
function main(): void {
  const out: string[] = [];
  out.push('CALIBRATION BASELINE — SHARPENED READ (analysis only)');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Inputs: /tmp/calibration-clean-corpus.csv + /tmp/clean-corpus-backbone-corpus.json');
  out.push('No doctrine run, no edits, no rebuild — sharpened reading of the existing baseline.');
  out.push('');

  const rows = mergeWithCorpus(parseCsv()).filter(r => r.engineBand !== 'SKIP' && Number.isFinite(r.finalScore));
  const losses = rows.filter(r => r.outcomeClass === 'LOSS');
  const cleans = rows.filter(r => r.outcomeClass === 'CLEAN');
  const stress = rows.filter(r => r.outcomeClass === 'STRESS-ONLY');
  out.push(`Rows merged (CSV ∩ corpus, doctrine-scored): ${rows.length}`);
  out.push(`  CLEAN: ${cleans.length}   STRESS-ONLY: ${stress.length}   LOSS: ${losses.length}`);

  const lossWeakHigh = losses.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  const cleanWeakHigh = cleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push('');
  out.push('Reference (existing baseline finalScore-driven, with cap):');
  out.push(`  LOSS recall (Weak/High Risk):     ${lossWeakHigh.length}/${losses.length}  (${(lossWeakHigh.length * 100 / losses.length).toFixed(0)}%)`);
  out.push(`  CLEAN false-positive:             ${cleanWeakHigh.length}/${cleans.length}  (${(cleanWeakHigh.length * 100 / cleans.length).toFixed(0)}%)`);
  out.push(`  Mean finalScore CLEAN: ${mean(cleans.map(r => r.finalScore)).toFixed(1)}   LOSS: ${mean(losses.map(r => r.finalScore)).toFixed(1)}   gap: ${(mean(cleans.map(r => r.finalScore)) - mean(losses.map(r => r.finalScore))).toFixed(1)} pts`);

  /* === (1) PRE-CAP RISK SEPARATION on mechScore ============================ */
  out.push('');
  out.push('================================================================');
  out.push('(1) PRE-CAP RISK SEPARATION — mechanical score (no band cap)');
  out.push('================================================================');
  const meanMechClean = mean(cleans.map(r => r.mechScore));
  const meanMechLoss = mean(losses.map(r => r.mechScore));
  const medMechClean = median(cleans.map(r => r.mechScore));
  const medMechLoss = median(losses.map(r => r.mechScore));
  out.push(`  ${'class'.padEnd(12)} n     mean      p25     median  p75     max`);
  for (const [label, subset] of [['CLEAN', cleans], ['STRESS-ONLY', stress], ['LOSS', losses]] as const) {
    const xs = subset.map(r => r.mechScore);
    if (xs.length === 0) { out.push(`  ${label.padEnd(12)} (n=0)`); continue; }
    out.push(`  ${label.padEnd(12)} ${xs.length.toString().padStart(3)}   ${mean(xs).toFixed(1).padStart(5)}   ${pct(xs, 0.25).toFixed(1).padStart(5)}   ${median(xs).toFixed(1).padStart(5)}   ${pct(xs, 0.75).toFixed(1).padStart(5)}   ${Math.max(...xs).toFixed(1).padStart(5)}`);
  }
  out.push(`  Mean mechScore gap (CLEAN − LOSS): ${(meanMechClean - meanMechLoss).toFixed(1)} pts`);
  out.push(`  Median mechScore gap:             ${(medMechClean - medMechLoss).toFixed(1)} pts`);
  out.push('  Compare: finalScore gap was 6.1 pts. mechScore reveals raw doctrine intent.');
  out.push('');
  out.push('  Recall / FP at sensible mechScore thresholds (lower mechScore = riskier):');
  for (const T of [50, 60, 70, 80, 90]) {
    const lossCaught = losses.filter(r => r.mechScore < T).length;
    const cleanFp = cleans.filter(r => r.mechScore < T).length;
    out.push(`    mech < ${T}:   LOSS caught ${lossCaught}/${losses.length} (${(lossCaught*100/losses.length).toFixed(0)}%)   CLEAN FP ${cleanFp}/${cleans.length} (${(cleanFp*100/cleans.length).toFixed(0)}%)`);
  }

  /* === (2) COMPLETE-INPUT SUBSET ========================================== */
  out.push('');
  out.push('================================================================');
  out.push('(2) COMPLETE-INPUT SUBSET — inputCompletePct ≥ 90% (cap not the story)');
  out.push('================================================================');
  const compRows = rows.filter(r => r.inputCompletePct >= 0.9);
  const compLosses = compRows.filter(r => r.outcomeClass === 'LOSS');
  const compCleans = compRows.filter(r => r.outcomeClass === 'CLEAN');
  out.push(`  n CLEAN: ${compCleans.length}   n LOSS: ${compLosses.length}   n STRESS-ONLY: ${compRows.filter(r => r.outcomeClass === 'STRESS-ONLY').length}`);
  const compLossWeakHigh = compLosses.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  const compCleanWeakHigh = compCleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push(`  LOSS recall (Weak/High Risk):  ${compLossWeakHigh.length}/${compLosses.length}  (${(compLossWeakHigh.length * 100 / Math.max(1, compLosses.length)).toFixed(0)}%)   vs full-set 75%`);
  out.push(`  CLEAN false-positive:          ${compCleanWeakHigh.length}/${compCleans.length}  (${(compCleanWeakHigh.length * 100 / Math.max(1, compCleans.length)).toFixed(0)}%)   vs full-set 54%`);
  out.push(`  Mean finalScore CLEAN: ${mean(compCleans.map(r => r.finalScore)).toFixed(1)}   LOSS: ${mean(compLosses.map(r => r.finalScore)).toFixed(1)}   gap: ${(mean(compCleans.map(r => r.finalScore)) - mean(compLosses.map(r => r.finalScore))).toFixed(1)} pts`);
  out.push(`  Mean mechScore  CLEAN: ${mean(compCleans.map(r => r.mechScore)).toFixed(1)}   LOSS: ${mean(compLosses.map(r => r.mechScore)).toFixed(1)}   gap: ${(mean(compCleans.map(r => r.mechScore)) - mean(compLosses.map(r => r.mechScore))).toFixed(1)} pts`);

  /* === (3) RAW-METRIC LOSS vs CLEAN ======================================== */
  out.push('');
  out.push('================================================================');
  out.push('(3) RAW-METRIC LOSS-vs-CLEAN — doctrine-bypassed premise test');
  out.push('================================================================');
  const metricLabels = ['concludedLtv', 'uwDscrNoi', 'uwDscrNcf', 'debtYield'] as const;
  out.push(`  metric         class       n     mean    p25     median  p75`);
  for (const m of metricLabels) {
    for (const [label, subset] of [['CLEAN', cleans], ['LOSS', losses]] as const) {
      const vals = nonNull(subset.map(r => (m === 'debtYield' ? r.debtYield : r.raw[m])));
      if (vals.length === 0) { out.push(`  ${m.padEnd(15)}${label.padEnd(12)} (n=0)`); continue; }
      const fmt = m === 'debtYield' || m === 'concludedLtv'
        ? (x: number) => (x * 100).toFixed(1) + '%'
        : (x: number) => x.toFixed(2) + 'x';
      out.push(`  ${m.padEnd(15)}${label.padEnd(12)} ${vals.length.toString().padStart(3)}   ${fmt(mean(vals)).padStart(7)}   ${fmt(pct(vals, 0.25)).padStart(7)}   ${fmt(median(vals)).padStart(7)}   ${fmt(pct(vals, 0.75)).padStart(7)}`);
    }
  }
  out.push('  Interpretation:');
  out.push('  - origination LTV: cleans typically lower; losses higher (more leveraged at the start)');
  out.push('  - DSCR (NCF): cleans higher (more debt-service buffer); losses lower');
  out.push('  - debt yield: cleans higher (more NOI per loan dollar); losses lower');
  out.push('  → If LOSS distributions overlap CLEAN distributions heavily on the raw metrics,');
  out.push('    the doctrine itself has limited material to work with at origination.');

  /* === (4) SIZE CONTROL — cleans smallest quartile ========================= */
  out.push('');
  out.push('================================================================');
  out.push('(4) SIZE CONTROL — cleans restricted to smallest quartile');
  out.push('================================================================');
  const cleanLoans = cleans.map(r => r.loanAmount).sort((a, b) => a - b);
  const q25 = cleanLoans[Math.floor(cleanLoans.length / 4)] ?? 0;
  const smallCleans = cleans.filter(r => r.loanAmount <= q25);
  out.push(`  CLEAN loan-size quartile cutoff: $${q25.toLocaleString()}  (smallest-quartile n=${smallCleans.length}, total CLEAN n=${cleans.length})`);
  out.push(`  Mean LOSS loan size: $${Math.round(mean(losses.map(r => r.loanAmount))).toLocaleString()}`);
  out.push(`  Mean small-CLEAN loan size: $${Math.round(mean(smallCleans.map(r => r.loanAmount))).toLocaleString()}`);
  if (smallCleans.length < 8) {
    out.push(`  ⚠ corpus lacks small CLEANs (n=${smallCleans.length}) — size-match imperfect. Proceeding with what's available.`);
  }
  out.push('');
  out.push('  Raw metrics (small-CLEAN vs LOSS):');
  for (const m of metricLabels) {
    const cVals = nonNull(smallCleans.map(r => (m === 'debtYield' ? r.debtYield : r.raw[m])));
    const lVals = nonNull(losses.map(r => (m === 'debtYield' ? r.debtYield : r.raw[m])));
    const fmt = m === 'debtYield' || m === 'concludedLtv'
      ? (x: number) => (x * 100).toFixed(1) + '%'
      : (x: number) => x.toFixed(2) + 'x';
    out.push(`    ${m.padEnd(15)}  small-CLEAN n=${cVals.length} mean=${cVals.length > 0 ? fmt(mean(cVals)) : 'NA'}   LOSS n=${lVals.length} mean=${fmt(mean(lVals))}`);
  }
  out.push('');
  out.push('  Discrimination on size-matched CLEAN:');
  const smallCleanWeakHigh = smallCleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push(`    small-CLEAN false-positive: ${smallCleanWeakHigh.length}/${smallCleans.length}  (${(smallCleanWeakHigh.length * 100 / Math.max(1, smallCleans.length)).toFixed(0)}%)   vs full-CLEAN 54%`);
  const smallCleanMechMean = mean(smallCleans.map(r => r.mechScore));
  out.push(`    mean mechScore small-CLEAN: ${smallCleanMechMean.toFixed(1)}   vs full-CLEAN ${mean(cleans.map(r => r.mechScore)).toFixed(1)}   vs LOSS ${mean(losses.map(r => r.mechScore)).toFixed(1)}`);

  /* === (5) MISSED-LOSS FORESEEABILITY ====================================== */
  out.push('');
  out.push('================================================================');
  out.push('(5) MISSED-LOSS FORESEEABILITY — the 3 losses rated Acceptable');
  out.push('================================================================');
  const missed = losses.filter(r => r.engineBand === 'Strong' || r.engineBand === 'Acceptable');
  const caught = losses.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push(`  Missed losses (Strong/Acceptable): ${missed.length}/${losses.length}`);
  for (const r of missed) {
    const ltv = r.raw.concludedLtv;
    const dscrNcf = r.raw.uwDscrNcf;
    const dy = r.debtYield;
    out.push(`    ${r.dealName} #${r.prosId} ${r.propertyName}`);
    out.push(`       loan=$${r.loanAmount.toLocaleString()}  LTV=${ltv !== null ? (ltv*100).toFixed(1)+'%' : 'null'}  NCF DSCR=${dscrNcf?.toFixed(2) ?? 'null'}x  DY=${dy !== null ? (dy*100).toFixed(1)+'%' : 'null'}`);
    out.push(`       band=${r.engineBand}  finalScore=${r.finalScore.toFixed(1)}  mechScore=${r.mechScore.toFixed(1)}  bcLoss=$${(r.raw.bcLoss ?? 0).toLocaleString()}`);
  }
  out.push('');
  out.push('  Caught losses (reference — Weak/High Risk):');
  for (const r of caught) {
    const ltv = r.raw.concludedLtv;
    const dscrNcf = r.raw.uwDscrNcf;
    const dy = r.debtYield;
    out.push(`    ${r.dealName} #${r.prosId} ${r.propertyName}: LTV=${ltv !== null ? (ltv*100).toFixed(1)+'%' : 'null'}  NCF DSCR=${dscrNcf?.toFixed(2) ?? 'null'}x  DY=${dy !== null ? (dy*100).toFixed(1)+'%' : 'null'}  band=${r.engineBand}`);
  }
  out.push('');
  out.push('  Reference — CLEAN mean: LTV=' + (mean(nonNull(cleans.map(r => r.raw.concludedLtv))) * 100).toFixed(1) + '%   NCF DSCR=' + mean(nonNull(cleans.map(r => r.raw.uwDscrNcf))).toFixed(2) + 'x   DY=' + (mean(nonNull(cleans.map(r => r.debtYield))) * 100).toFixed(1) + '%');
  out.push('');
  out.push('  Foreseeability call: do the 3 missed losses have METRICS that look risky');
  out.push('  (foreseeable → doctrine should have caught), or do they look like cleans');
  out.push('  (not foreseeable at origination → recall ceiling, not a doctrine defect)?');

  /* === (6) FP HEADROOM — cap-driven vs risk-score-driven =================== */
  out.push('');
  out.push('================================================================');
  out.push('(6) FP HEADROOM — cap-driven (immovable by risk rules) vs risk-driven');
  out.push('================================================================');
  const cleanFps = cleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  const capDriven = cleanFps.filter(r => r.bandCapApplied);
  const riskDriven = cleanFps.filter(r => !r.bandCapApplied);
  out.push(`  Total CLEAN FPs:                       ${cleanFps.length}/${cleans.length}`);
  out.push(`  Cap-driven (bandCapApplied=Y):         ${capDriven.length}  — immovable by risk-rule rebuild; needs coverage / cap policy fix`);
  out.push(`  Risk-score-driven (bandCapApplied=N):  ${riskDriven.length}  — addressable by risk-rule rebuild (the rebuild's real FP headroom)`);
  out.push('');
  out.push('  Cap-driven FP records — sample (with mechScore showing pre-cap rating):');
  for (const r of capDriven.slice(0, 10)) {
    out.push(`    ${r.dealName.padEnd(20)} #${r.prosId.padEnd(3)} ${r.propertyName.padEnd(38)} band=${r.engineBand}  mechScore=${r.mechScore.toFixed(1)}  finalScore=${r.finalScore.toFixed(1)}  inputs=${(r.inputCompletePct*100).toFixed(0)}%`);
  }
  if (capDriven.length > 10) out.push(`    ... and ${capDriven.length - 10} more`);
  out.push('');
  out.push('  Risk-driven FP records — sample (mechScore says these scored as risky pre-cap):');
  for (const r of riskDriven.slice(0, 10)) {
    out.push(`    ${r.dealName.padEnd(20)} #${r.prosId.padEnd(3)} ${r.propertyName.padEnd(38)} band=${r.engineBand}  mechScore=${r.mechScore.toFixed(1)}  finalScore=${r.finalScore.toFixed(1)}  LTV=${r.raw.concludedLtv !== null ? (r.raw.concludedLtv*100).toFixed(1)+'%' : 'null'}  NCF DSCR=${r.raw.uwDscrNcf?.toFixed(2) ?? 'null'}x`);
  }
  if (riskDriven.length > 10) out.push(`    ... and ${riskDriven.length - 10} more`);

  /* === BOTTOM LINE ========================================================= */
  out.push('');
  out.push('================================================================');
  out.push('BOTTOM LINE');
  out.push('================================================================');
  out.push('');
  out.push('Pre-cap mechScore gap (CLEAN − LOSS):');
  out.push(`  full set:           ${(meanMechClean - meanMechLoss).toFixed(1)} pts   (vs 6.1 pt finalScore gap — cap squeezes the signal)`);
  const compMechGap = mean(compCleans.map(r => r.mechScore)) - mean(compLosses.map(r => r.mechScore));
  out.push(`  complete inputs:    ${compMechGap.toFixed(1)} pts`);
  out.push('');
  out.push('Cap-driven vs risk-driven CLEAN FP:');
  out.push(`  cap-driven:    ${capDriven.length}  (immovable — coverage/cap policy)`);
  out.push(`  risk-driven:   ${riskDriven.length}  (addressable — rebuild aims here)`);
  out.push('');
  out.push('Recall vs FP — where is the rebuild headroom?');
  out.push(`  Recall:   ${lossWeakHigh.length}/${losses.length} (${(lossWeakHigh.length*100/losses.length).toFixed(0)}%) — already strong; the 3 missed are diagnosed above`);
  out.push(`  FP:       ${cleanFps.length}/${cleans.length} (${(cleanFps*100/cleans.length).toFixed(0)}%) — high, but ${capDriven.length} are cap-driven (immovable); the rebuild's actual FP target is the ${riskDriven.length} risk-driven`);

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[sharpened] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
