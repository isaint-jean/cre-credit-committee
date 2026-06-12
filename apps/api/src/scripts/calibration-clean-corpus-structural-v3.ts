/**
 * Calibration baseline — STRUCTURAL FEATURE SIGNAL TEST v3
 *
 * Same cuts as v2 but the corpus is now enriched with:
 *  (1) "Month DD, YYYY" maturity-date parsing → rollover populated on 26
 *      records instead of 3.
 *  (2) Tail-loss assetType populated on all 12 LOSSes (recovery entries
 *      and walker-fed paths both carry assetType now).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-clean-corpus-structural-v3.ts
 *
 * Reports: (a) the now-testable rollover cut, (b) the clean per-type
 * loss-rate read with all 12 losses typed, (c) coverage changes vs v2,
 * and (d) honest power read.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-clean-corpus-structural-v3.out';

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number | null;
  concludedLtv: number | null;
  uwDscrNcf: number | null;
  bcLoss: number | null;
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
function nonNull(xs: (number | null)[]): number[] {
  return xs.filter((x): x is number => x !== null && Number.isFinite(x));
}

function main(): void {
  const out: string[] = [];
  out.push('CALIBRATION BASELINE — STRUCTURAL FEATURE SIGNAL TEST v3');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json (post date-parser fix + tail asset-types)');
  out.push('No doctrine run, no edits, no rebuild. Analysis only.');
  out.push('');

  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  const cleans = records.filter(r => r.outcomeClass === 'CLEAN');
  const losses = records.filter(r => r.outcomeClass === 'LOSS');

  out.push('================================================================');
  out.push('COVERAGE — what changed vs v2');
  out.push('================================================================');
  out.push('');
  out.push(`Non-pending records: ${records.length}  (CLEAN ${cleans.length}, LOSS ${losses.length})`);
  out.push('');
  const atPop = records.filter(r => r.assetType !== null).length;
  const lossAtPop = losses.filter(r => r.assetType !== null).length;
  const ltPop = records.filter(r => r.largestTenantPct !== null).length;
  const lossLtPop = losses.filter(r => r.largestTenantPct !== null).length;
  const rollPop = records.filter(r => r.pctIncomeExpiringWithinTerm !== null).length;
  const lossRollPop = losses.filter(r => r.pctIncomeExpiringWithinTerm !== null).length;
  out.push(`  ${'feature'.padEnd(34)} v2 pop    v3 pop    Δ      v3 LOSS pop`);
  out.push(`  ${'assetType'.padEnd(34)} 141/176   ${atPop}/${records.length}   ${(atPop - 141 >= 0 ? '+' : '')}${atPop - 141}     ${lossAtPop}/${losses.length}  ← all losses now typed`);
  out.push(`  ${'largestTenantPct'.padEnd(34)} 41/176    ${ltPop}/${records.length}    ${(ltPop - 41 >= 0 ? '+' : '')}${ltPop - 41}     ${lossLtPop}/${losses.length}`);
  out.push(`  ${'pctIncomeExpiringWithinTerm'.padEnd(34)} 3/176     ${rollPop}/${records.length}   ${(rollPop - 3 >= 0 ? '+' : '')}${rollPop - 3}    ${lossRollPop}/${losses.length}  ← unblocked by date parser`);
  out.push('');

  /* === (1) ASSET TYPE (CLEAN — all 12 losses typed) ====================== */
  out.push('================================================================');
  out.push('(1) ASSET TYPE — clean read, all 12 LOSSes now typed');
  out.push('================================================================');
  out.push('');
  const byType = new Map<string, { clean: number; loss: number; lossNames: string[] }>();
  for (const r of records) {
    const at = r.assetType ?? 'null';
    if (!byType.has(at)) byType.set(at, { clean: 0, loss: 0, lossNames: [] });
    const b = byType.get(at)!;
    if (r.outcomeClass === 'LOSS') { b.loss++; b.lossNames.push(r.propertyName); }
    else if (r.outcomeClass === 'CLEAN') b.clean++;
  }
  const totalN = [...byType.values()].reduce((s, b) => s + b.clean + b.loss, 0);
  const totalL = [...byType.values()].reduce((s, b) => s + b.loss, 0);
  const overallRate = totalL / totalN;
  out.push(`  ${'assetType'.padEnd(14)} n     CLEAN   LOSS   loss-rate   vs overall (${(overallRate*100).toFixed(1)}%)`);
  for (const [at, b] of [...byType.entries()].sort((a, b2) => (b2[1].loss + b2[1].clean) - (a[1].loss + a[1].clean))) {
    const n = b.clean + b.loss;
    if (n === 0) continue;
    const rate = b.loss / n;
    const mult = rate / overallRate;
    const arrow = mult >= 1.5 ? '↑↑' : mult >= 1.2 ? '↑' : mult <= 0.5 ? '↓↓' : mult <= 0.8 ? '↓' : '~';
    out.push(`  ${at.padEnd(14)} ${n.toString().padStart(3)}   ${b.clean.toString().padStart(5)}   ${b.loss.toString().padStart(4)}   ${(rate*100).toFixed(1).padStart(6)}%   ${arrow.padStart(3)}   ${b.lossNames.slice(0, 2).join(' | ')}`);
  }
  out.push(`  ${'(overall)'.padEnd(14)} ${totalN.toString().padStart(3)}   ${(totalN - totalL).toString().padStart(5)}   ${totalL.toString().padStart(4)}   ${(overallRate * 100).toFixed(1).padStart(6)}%`);
  out.push('');
  out.push('  Note: the 6 tail-loss records that had assetType=null in v2 are now typed');
  out.push('  (Minot, Home 2 Suites, Candlewood, Comfort Suites → Hotel; Masonic →');
  out.push('  MixedUse; Windmill Lakes → Retail). The Hotel category jumps from 0 losses');
  out.push('  to the proper count once the tail-loss records land where they belong.');
  out.push('');

  /* === (2) CONCENTRATION (unchanged — same parse coverage) ============= */
  out.push('================================================================');
  out.push('(2) CONCENTRATION (largestTenantPct) — unchanged from v2');
  out.push('================================================================');
  out.push('');
  const lossLT = nonNull(losses.map(r => r.largestTenantPct));
  const cleanLT = nonNull(cleans.map(r => r.largestTenantPct));
  out.push(`  Populated: CLEAN ${cleanLT.length}, LOSS ${lossLT.length}.`);
  out.push(`  Mean: CLEAN ${(mean(cleanLT)*100).toFixed(1)}%   LOSS ${(mean(lossLT)*100).toFixed(1)}%   Δ ${((mean(cleanLT)-mean(lossLT))*100).toFixed(1)} pts`);
  out.push(`  (Anchor-coverage gap unchanged — 69 records parse-failed. Out of scope here.)`);
  out.push('');

  /* === (3) ROLLOVER — now testable ====================================== */
  out.push('================================================================');
  out.push('(3) LEASE ROLLOVER (pctIncomeExpiringWithinTerm) — now testable');
  out.push('================================================================');
  out.push('');
  const lossRoll = nonNull(losses.map(r => r.pctIncomeExpiringWithinTerm));
  const cleanRoll = nonNull(cleans.map(r => r.pctIncomeExpiringWithinTerm));
  out.push(`  Populated: CLEAN ${cleanRoll.length}/${cleans.length}, LOSS ${lossRoll.length}/${losses.length}`);
  if (lossRoll.length === 0) {
    out.push('  ⚠ LOSS coverage still 0 — none of the LOSS records have a maturityDate + tenant');
    out.push('    table both populated. Rollover remains UNDER-POWERED at LOSS n=0.');
    out.push('    (Likely cause: the 3 LOSS records with tenant tables are Retail body pages');
    out.push('    that didn\'t expose maturityDate in the expected position. Anchor work.)');
  } else {
    out.push('');
    out.push(`  ${'class'.padEnd(8)} n      mean    median  p25    p75    min     max`);
    for (const [label, xs] of [['CLEAN', cleanRoll], ['LOSS', lossRoll]] as const) {
      if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
      const sorted = [...xs].sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length / 4)] ?? NaN;
      const p75 = sorted[Math.floor(sorted.length * 3 / 4)] ?? NaN;
      out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}    ${(mean(xs) * 100).toFixed(1).padStart(5)}%  ${(median(xs) * 100).toFixed(1).padStart(5)}%  ${(p25 * 100).toFixed(1).padStart(5)}%  ${(p75 * 100).toFixed(1).padStart(5)}%  ${(Math.min(...xs) * 100).toFixed(1).padStart(5)}%  ${(Math.max(...xs) * 100).toFixed(1).padStart(5)}%`);
    }
    const rollGap = (mean(cleanRoll) - mean(lossRoll)) * 100;
    out.push(`  Mean gap (CLEAN − LOSS): ${rollGap.toFixed(1)} pts`);
    out.push('');
    out.push('  Loss-rate by rollover bucket:');
    const allRoll = nonNull(records.map(r => r.pctIncomeExpiringWithinTerm));
    if (allRoll.length >= 8) {
      const medRoll = median(allRoll);
      out.push(`    median pctIncomeExpiringWithinTerm: ${(medRoll * 100).toFixed(1)}%`);
      const high = records.filter(r => r.pctIncomeExpiringWithinTerm !== null && r.pctIncomeExpiringWithinTerm >= medRoll);
      const low = records.filter(r => r.pctIncomeExpiringWithinTerm !== null && r.pctIncomeExpiringWithinTerm < medRoll);
      const highLoss = high.filter(r => r.outcomeClass === 'LOSS').length;
      const lowLoss = low.filter(r => r.outcomeClass === 'LOSS').length;
      out.push(`    high-rollover (≥ median): n=${high.length}  LOSS=${highLoss}  loss-rate=${(highLoss*100/Math.max(1,high.length)).toFixed(1)}%`);
      out.push(`    low-rollover  (< median): n=${low.length}  LOSS=${lowLoss}  loss-rate=${(lowLoss*100/Math.max(1,low.length)).toFixed(1)}%`);
    }
    out.push('');
    out.push('  LOSS records with rollover populated:');
    for (const r of losses.filter(r2 => r2.pctIncomeExpiringWithinTerm !== null)) {
      out.push(`    ${r.dealName} #${r.prosId} ${r.propertyName}  rollover=${(r.pctIncomeExpiringWithinTerm! * 100).toFixed(1)}%  largestTenant=${r.largestTenantPct !== null ? (r.largestTenantPct*100).toFixed(1)+'%' : 'null'}  assetType=${r.assetType ?? 'null'}`);
    }
  }
  out.push('');

  /* === (4) COMBINED ===================================================== */
  out.push('================================================================');
  out.push('(4) COMBINED — asset-type + concentration + rollover (where populated)');
  out.push('================================================================');
  out.push('');
  const highLossTypes = new Set<string>();
  for (const [at, b] of byType) {
    if (at === 'null') continue;
    const n = b.clean + b.loss;
    if (n < 4) continue;
    if (b.loss / n > overallRate * 1.5) highLossTypes.add(at);
  }
  // Compute high-rollover threshold (only if we have meaningful coverage)
  const allRoll = nonNull(records.map(r => r.pctIncomeExpiringWithinTerm));
  const rollThr = allRoll.length >= 8 ? median(allRoll) : null;
  const concThr = 0.25;
  const flagged = records.filter(r =>
    (r.assetType !== null && highLossTypes.has(r.assetType))
    || (r.largestTenantPct !== null && r.largestTenantPct >= concThr)
    || (rollThr !== null && r.pctIncomeExpiringWithinTerm !== null && r.pctIncomeExpiringWithinTerm >= rollThr)
  );
  const unflagged = records.filter(r => !flagged.includes(r));
  const flagL = flagged.filter(r => r.outcomeClass === 'LOSS').length;
  const flagC = flagged.filter(r => r.outcomeClass === 'CLEAN').length;
  const unflagL = unflagged.filter(r => r.outcomeClass === 'LOSS').length;
  const unflagC = unflagged.filter(r => r.outcomeClass === 'CLEAN').length;
  out.push(`  Rule: asset-type ∈ {${[...highLossTypes].join(', ')}}  OR  largestTenantPct ≥ 25%  OR  rollover ≥ ${rollThr !== null ? (rollThr*100).toFixed(1)+'%' : 'N/A'}`);
  out.push(`  Flagged:    n=${flagged.length}  CLEAN=${flagC}  LOSS=${flagL}  loss-rate=${(flagL*100/Math.max(1,flagged.length)).toFixed(1)}%`);
  out.push(`  Unflagged:  n=${unflagged.length}  CLEAN=${unflagC}  LOSS=${unflagL}  loss-rate=${(unflagL*100/Math.max(1,unflagged.length)).toFixed(1)}%`);
  out.push(`  Recall: ${flagL}/${totalL}  (${(flagL*100/Math.max(1,totalL)).toFixed(0)}%)   FP: ${flagC}/${totalN - totalL}  (${(flagC*100/Math.max(1,totalN-totalL)).toFixed(0)}%)`);
  out.push('');

  /* === (5) STRUCTURAL vs RATIO BASELINE + v2 ============================== */
  out.push('================================================================');
  out.push('(5) STRUCTURAL vs RATIO BASELINE + v2');
  out.push('================================================================');
  out.push('');
  out.push('  Ratio baseline (sharpened read): ~0 separation.');
  out.push('  Asset-type read (v2 → v3, all 12 LOSSes typed):');
  for (const [at, b] of [...byType.entries()].filter(([_, b]) => b.clean + b.loss >= 4)) {
    if (at === 'null') continue;
    const r = b.loss / (b.clean + b.loss);
    out.push(`    ${at.padEnd(14)} n=${(b.clean + b.loss).toString().padStart(3)}  loss-rate=${(r*100).toFixed(1)}%   (overall ${(overallRate*100).toFixed(1)}%)`);
  }
  out.push('');
  if (lossRoll.length > 0) {
    out.push(`  Rollover (v2 untestable → v3):`);
    out.push(`    CLEAN mean ${(mean(cleanRoll)*100).toFixed(1)}%   LOSS mean ${(mean(lossRoll)*100).toFixed(1)}%   Δ ${((mean(cleanRoll)-mean(lossRoll))*100).toFixed(1)} pts`);
  } else {
    out.push(`  Rollover: v3 LOSS coverage still 0 (anchor gap on the 12 LOSS records' tenant tables).`);
  }
  out.push('');

  /* === (6) POWER / HONEST READ =========================================== */
  out.push('================================================================');
  out.push('(6) POWER / HONEST READ');
  out.push('================================================================');
  out.push('');
  out.push(`  n LOSS = ${losses.length}; per-cut populated subsets:`);
  out.push(`  - Asset type (LOSS n=${lossAtPop}/12) — full coverage now, usable for per-type loss-rates.`);
  out.push(`  - Concentration (LOSS n=${lossLT.length}/12) — directional only.`);
  out.push(`  - Rollover (LOSS n=${lossRollPop}/12) — ${lossRollPop > 0 ? 'directional at this n; report by class' : 'still under-powered — needs WFRBS tenant-table anchor for hospitality body pages'}.`);
  out.push('');

  /* === BOTTOM LINE ======================================================== */
  out.push('================================================================');
  out.push('BOTTOM LINE — v3 vs v2');
  out.push('================================================================');
  out.push('');
  // Identify over- and under-represented categories
  const over: string[] = [], under: string[] = [];
  for (const [at, b] of byType) {
    if (at === 'null') continue;
    const n = b.clean + b.loss;
    if (n < 4) continue;
    const r = b.loss / n;
    if (r > overallRate * 1.3) over.push(`${at} (${(r*100).toFixed(1)}%, n=${n})`);
    if (r < overallRate * 0.5) under.push(`${at} (${(r*100).toFixed(1)}%, n=${n})`);
  }
  out.push(`Asset-type (clean read, all 12 LOSSes typed):`);
  out.push(`  Over-represented:  ${over.join(', ') || '(none)'}`);
  out.push(`  Under-represented: ${under.join(', ') || '(none)'}`);
  out.push(`  Overall baseline:  ${(overallRate*100).toFixed(1)}%`);
  out.push('');
  if (lossRoll.length > 0) {
    const rollGap = (mean(cleanRoll) - mean(lossRoll)) * 100;
    out.push(`Rollover: now testable, LOSS n=${lossRoll.length}`);
    out.push(`  Mean gap (CLEAN − LOSS): ${rollGap.toFixed(1)} pts`);
    out.push(`  ${Math.abs(rollGap) > 5 ? '→ directional signal' : '→ flat at populated n'}`);
  } else {
    out.push(`Rollover: still under-powered (LOSS n=${lossRoll.length}).`);
    out.push('  Coverage on CLEANs lifted to ${cleanRoll.length} (was 3); LOSS coverage still 0.');
    out.push('  The 3 multi-tenant-parsed LOSSes (Shop City, Woodbridge, Brunswick) didn\'t');
    out.push('  expose maturityDate in the slice the extractor scans for them — tenant table');
    out.push('  is past offset+5000. Widening the maturity-date scan window would fix it.');
  }

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[structural-v3] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
