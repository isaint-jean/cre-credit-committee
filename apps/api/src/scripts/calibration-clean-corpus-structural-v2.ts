/**
 * Calibration baseline — STRUCTURAL FEATURE SIGNAL TEST v2
 *
 * Replaces the heuristic asset-type derivation with the corpus's
 * persisted assetType field (from the body page's labeled "Property
 * Type"); tests concentration (largestTenantPct) and rollover
 * (pctIncomeExpiringWithinTerm) using the newly extracted fields.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-clean-corpus-structural-v2.ts
 *
 * Reports population breakdown honestly — flags where extractor parse
 * coverage is low. No doctrine run, no edits, no rebuild.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-clean-corpus-structural-v2.out';

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
  out.push('CALIBRATION BASELINE — STRUCTURAL FEATURE SIGNAL TEST v2');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json (extractor-enriched fields)');
  out.push('No doctrine run, no edits, no rebuild. Analysis only.');
  out.push('');

  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  const cleans = records.filter(r => r.outcomeClass === 'CLEAN');
  const losses = records.filter(r => r.outcomeClass === 'LOSS');

  out.push('================================================================');
  out.push('POPULATION BREAKDOWN (the new fields)');
  out.push('================================================================');
  out.push('');
  out.push(`Total non-pending records: ${records.length}  (CLEAN ${cleans.length}, LOSS ${losses.length})`);
  out.push('');
  const tdStatus = new Map<string, { clean: number; loss: number }>();
  for (const r of records) {
    const k = r.tenantDataStatus ?? 'null';
    if (!tdStatus.has(k)) tdStatus.set(k, { clean: 0, loss: 0 });
    const b = tdStatus.get(k)!;
    if (r.outcomeClass === 'LOSS') b.loss++; else if (r.outcomeClass === 'CLEAN') b.clean++;
  }
  out.push('  tenantDataStatus breakdown:');
  out.push(`    ${'status'.padEnd(24)} CLEAN   LOSS`);
  for (const [k, b] of tdStatus) {
    out.push(`    ${k.padEnd(24)} ${b.clean.toString().padStart(5)}   ${b.loss.toString().padStart(4)}`);
  }
  out.push('');
  const atPop = records.filter(r => r.assetType !== null).length;
  const ltPop = records.filter(r => r.largestTenantPct !== null).length;
  const rollPop = records.filter(r => r.pctIncomeExpiringWithinTerm !== null).length;
  out.push(`  assetType populated:                  ${atPop}/${records.length}`);
  out.push(`  largestTenantPct populated:           ${ltPop}/${records.length}`);
  out.push(`  pctIncomeExpiringWithinTerm populated: ${rollPop}/${records.length}  ← maturityDate string-parse coverage low; rollover under-powered`);
  out.push('');
  out.push('  HONEST CAVEAT: parse-failed n is high (the multi-tenant table sits 4-10K');
  out.push('  chars beyond the page signature; some shelves have a slightly different');
  out.push('  anchor or row layout the heuristic missed). Where populated, the data is');
  out.push('  intact (sanity gates enforce: top1 ≤ 100%, sum ≤ 100%). Where null, the');
  out.push('  structural test treats them as missing — not zero.');
  out.push('');

  /* === Cut 1: GROUND-TRUTH ASSET TYPE ====================================== */
  out.push('================================================================');
  out.push('(1) ASSET TYPE — ground-truth from labeled "Property Type" field');
  out.push('================================================================');
  out.push('');
  // Group by assetType
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
  out.push(`  ${'assetType'.padEnd(14)} n     CLEAN   LOSS   loss-rate   LOSS examples`);
  for (const [at, b] of [...byType.entries()].sort((a, b2) => (b2[1].loss + b2[1].clean) - (a[1].loss + a[1].clean))) {
    const n = b.clean + b.loss;
    if (n === 0) continue;
    const r = (b.loss / n * 100).toFixed(1);
    out.push(`  ${at.padEnd(14)} ${n.toString().padStart(3)}   ${b.clean.toString().padStart(5)}   ${b.loss.toString().padStart(4)}   ${r.padStart(7)}%    ${b.lossNames.slice(0, 2).join(' | ')}`);
  }
  out.push(`  ${'(overall)'.padEnd(14)} ${totalN.toString().padStart(3)}   ${(totalN - totalL).toString().padStart(5)}   ${totalL.toString().padStart(4)}   ${(totalL * 100 / Math.max(1, totalN)).toFixed(1).padStart(7)}%`);
  out.push('');

  /* === Cut 2: CONCENTRATION ============================================== */
  out.push('================================================================');
  out.push('(2) CONCENTRATION (largestTenantPct) — top-tenant % NRA distribution');
  out.push('================================================================');
  out.push('');
  const lossLT = nonNull(losses.map(r => r.largestTenantPct));
  const cleanLT = nonNull(cleans.map(r => r.largestTenantPct));
  out.push(`  Populated n:  CLEAN ${cleanLT.length}/${cleans.length}   LOSS ${lossLT.length}/${losses.length}`);
  if (lossLT.length < 3) {
    out.push('  ⚠ LOSS n < 3 — directional only, no confident conclusion.');
  }
  out.push('');
  out.push(`  ${'class'.padEnd(8)} n      mean    median  p25    p75    min     max`);
  for (const [label, xs] of [['CLEAN', cleanLT], ['LOSS', lossLT]] as const) {
    if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
    const sorted = [...xs].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length / 4)] ?? NaN;
    const p75 = sorted[Math.floor(sorted.length * 3 / 4)] ?? NaN;
    out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}    ${(mean(xs) * 100).toFixed(1).padStart(5)}%  ${(median(xs) * 100).toFixed(1).padStart(5)}%  ${(p25 * 100).toFixed(1).padStart(5)}%  ${(p75 * 100).toFixed(1).padStart(5)}%  ${(Math.min(...xs) * 100).toFixed(1).padStart(5)}%  ${(Math.max(...xs) * 100).toFixed(1).padStart(5)}%`);
  }
  const concGap = (mean(cleanLT) - mean(lossLT)) * 100;
  out.push(`  Mean gap (CLEAN − LOSS): ${concGap.toFixed(1)} pts`);
  out.push('');
  out.push('  Loss-rate by concentration bucket (high-tenant-share vs low):');
  if (records.filter(r => r.largestTenantPct !== null).length >= 8) {
    // Use median of populated set as the dividing line
    const allLT = nonNull(records.map(r => r.largestTenantPct));
    const medLT = median(allLT);
    out.push(`    median largestTenantPct (split): ${(medLT * 100).toFixed(1)}%`);
    const high = records.filter(r => r.largestTenantPct !== null && r.largestTenantPct >= medLT);
    const low = records.filter(r => r.largestTenantPct !== null && r.largestTenantPct < medLT);
    const highLoss = high.filter(r => r.outcomeClass === 'LOSS').length;
    const lowLoss = low.filter(r => r.outcomeClass === 'LOSS').length;
    out.push(`    high-concentration (≥ median): n=${high.length}  LOSS=${highLoss}  loss-rate=${(highLoss*100/high.length).toFixed(1)}%`);
    out.push(`    low-concentration  (< median): n=${low.length}  LOSS=${lowLoss}  loss-rate=${(lowLoss*100/low.length).toFixed(1)}%`);
  }
  out.push('');
  out.push('  LOSS records with concentration populated:');
  for (const r of losses.filter(r2 => r2.largestTenantPct !== null)) {
    out.push(`    ${r.dealName} #${r.prosId} ${r.propertyName}  largestTenantPct=${(r.largestTenantPct! * 100).toFixed(1)}%  assetType=${r.assetType ?? 'null'}  status=${r.tenantDataStatus ?? 'null'}`);
  }

  /* === Cut 3: ROLLOVER =================================================== */
  out.push('');
  out.push('================================================================');
  out.push('(3) LEASE ROLLOVER (pctIncomeExpiringWithinTerm) — UNDER-POWERED');
  out.push('================================================================');
  out.push('');
  out.push(`  Populated:  CLEAN ${cleans.filter(r => r.pctIncomeExpiringWithinTerm !== null).length}/${cleans.length}   LOSS ${losses.filter(r => r.pctIncomeExpiringWithinTerm !== null).length}/${losses.length}`);
  out.push(`  Root cause: maturityDate string format on body pages is "Month DD, YYYY" (WFRBS) or`);
  out.push(`  date-NAP (ARDs); the extractor's M/D/YYYY parser only catches a fraction. Tenant`);
  out.push(`  lease expiration dates ARE captured by the row regex but the maturity comparison`);
  out.push(`  fails when maturityDate is in the unparsed format. Fixable but out of scope here.`);
  out.push(`  At populated n < 5, no LOSS conclusion possible. Re-test after date-parser hardening.`);

  /* === Cut 4: COMBINED ==================================================== */
  out.push('');
  out.push('================================================================');
  out.push('(4) COMBINED — asset-type flag + high-concentration flag');
  out.push('================================================================');
  out.push('');
  // High-loss-rate asset types: any with loss-rate > 1.5× overall AND n ≥ 4
  const overallRate = totalL / totalN;
  const highLossTypes = new Set<string>();
  for (const [at, b] of byType) {
    if (at === 'null') continue;
    const n = b.clean + b.loss;
    if (n < 4) continue;
    if (b.loss / n > overallRate * 1.5) highLossTypes.add(at);
  }
  // High concentration: top tenant ≥ 25% NRA (rough single-/few-tenant threshold)
  const concThreshold = 0.25;
  const flagged = records.filter(r =>
    (r.assetType !== null && highLossTypes.has(r.assetType))
    || (r.largestTenantPct !== null && r.largestTenantPct >= concThreshold)
  );
  const unflagged = records.filter(r => !flagged.includes(r));
  const flagL = flagged.filter(r => r.outcomeClass === 'LOSS').length;
  const flagC = flagged.filter(r => r.outcomeClass === 'CLEAN').length;
  const unflagL = unflagged.filter(r => r.outcomeClass === 'LOSS').length;
  const unflagC = unflagged.filter(r => r.outcomeClass === 'CLEAN').length;
  out.push(`  Rule: asset-type ∈ {${[...highLossTypes].join(', ')}}  OR  largestTenantPct ≥ ${(concThreshold*100).toFixed(0)}%`);
  out.push(`  Flagged subset:    n=${flagged.length}  CLEAN=${flagC}  LOSS=${flagL}  loss-rate=${(flagL*100/Math.max(1,flagged.length)).toFixed(1)}%`);
  out.push(`  Unflagged subset:  n=${unflagged.length}  CLEAN=${unflagC}  LOSS=${unflagL}  loss-rate=${(unflagL*100/Math.max(1,unflagged.length)).toFixed(1)}%`);
  const recall = flagL / Math.max(1, totalL);
  const fp = flagC / Math.max(1, totalN - totalL);
  out.push(`  Recall: ${flagL}/${totalL}  (${(recall*100).toFixed(0)}%)   FP: ${flagC}/${totalN - totalL}  (${(fp*100).toFixed(0)}%)`);
  out.push('');

  /* === Cut 5: COMPARE TO RATIO BASELINE =================================== */
  out.push('================================================================');
  out.push('(5) STRUCTURAL vs RATIO BASELINE');
  out.push('================================================================');
  out.push('');
  out.push('  Ratio baseline (sharpened read):');
  out.push('    concludedLtv  CLEAN 63.7% vs LOSS 66.5%  Δ 2.8 pts');
  out.push('    NCF DSCR      CLEAN 1.81x vs LOSS 1.58x  Δ 0.23x');
  out.push('    debtYield     CLEAN 13.9% vs LOSS 13.4%  Δ 0.5 pts');
  out.push('    → effective separation ≈ 0.');
  out.push('');
  out.push('  Structural (this run, ground-truth Property Type):');
  for (const [at, b] of [...byType.entries()].filter(([_, b]) => b.clean + b.loss >= 4)) {
    if (at === 'null') continue;
    const r = b.loss / (b.clean + b.loss);
    out.push(`    ${at.padEnd(14)} n=${(b.clean + b.loss).toString().padStart(3)}  loss-rate=${(r*100).toFixed(1)}%   (overall ${(overallRate*100).toFixed(1)}%)`);
  }
  out.push('');
  out.push(`  Concentration (largestTenantPct, where populated):`);
  out.push(`    CLEAN mean: ${(mean(cleanLT) * 100).toFixed(1)}%   LOSS mean: ${(mean(lossLT) * 100).toFixed(1)}%   Δ ${(concGap).toFixed(1)} pts`);
  out.push('');

  /* === Cut 6: POWER ====================================================== */
  out.push('================================================================');
  out.push('(6) POWER / HONEST READ');
  out.push('================================================================');
  out.push('');
  out.push(`  n LOSS = ${losses.length}; structural-feature-populated subsets are smaller.`);
  out.push(`  - Asset type (n=${atPop} pop., ${losses.filter(r=>r.assetType!==null).length} LOSS) — usable, directional.`);
  out.push(`  - Concentration (${ltPop} pop., ${lossLT.length} LOSS) — directional only at n=${lossLT.length}.`);
  out.push(`  - Rollover (${rollPop} pop., ${losses.filter(r=>r.pctIncomeExpiringWithinTerm!==null).length} LOSS) — UNDER-POWERED here.`);
  out.push('');
  out.push('  PARSE COVERAGE GAP: 72/183 tenantDataStatus="parse-failed". The body-page tenant');
  out.push('  table format varies more across shelves than first thought; the WFRBS-style anchor');
  out.push('  works on ~22% of records. Improving the anchor catalog per shelf (the same per-shelf');
  out.push('  pattern that worked for labels) would lift concentration coverage substantially. The');
  out.push('  data is on the body page — extraction catalog just hasn\'t caught up.');
  out.push('');

  /* === BOTTOM LINE ======================================================== */
  out.push('================================================================');
  out.push('BOTTOM LINE');
  out.push('================================================================');
  out.push('');
  out.push('Ground-truth asset-type (from Property Type, NOT the name heuristic):');
  // Identify the over-represented categories
  const over: string[] = [], under: string[] = [];
  for (const [at, b] of byType) {
    if (at === 'null') continue;
    const n = b.clean + b.loss;
    if (n < 4) continue;
    const r = b.loss / n;
    if (r > overallRate * 1.3) over.push(`${at} (${(r*100).toFixed(1)}%, n=${n})`);
    if (r < overallRate * 0.5) under.push(`${at} (${(r*100).toFixed(1)}%, n=${n})`);
  }
  out.push(`  Over-represented in LOSSes: ${over.join(', ') || '(none)'}`);
  out.push(`  Under-represented:          ${under.join(', ') || '(none)'}`);
  out.push(`  Overall loss-rate baseline: ${(overallRate*100).toFixed(1)}%`);
  out.push('');
  out.push('Concentration:');
  if (lossLT.length < 3) {
    out.push(`  LOSS n=${lossLT.length} — too few to conclude. Direction (if any): ${concGap > 5 ? 'CLEAN higher (cleans more concentrated — surprising)' : concGap < -5 ? 'LOSS higher (concentration → loss, expected direction)' : 'flat'}`);
  } else {
    out.push(`  Mean gap (CLEAN − LOSS): ${concGap.toFixed(1)} pts`);
  }
  out.push('');
  out.push('Rollover: UNDER-POWERED on this corpus (date-parse gap). Honest non-result.');
  out.push('');
  out.push('Bottom-line vs ratios:');
  if (over.length > 0) {
    out.push(`  STRUCTURAL signal present (asset-type ${over.length} type${over.length > 1 ? 's' : ''} over-represented)`);
    out.push(`  where ratios were flat. The B-piece edge thesis holds where the data permits the`);
    out.push(`  test. Concentration is directional but n=${lossLT.length} LOSS limits confidence; rollover needs`);
    out.push(`  extractor date-parse hardening before it can be evaluated.`);
  } else {
    out.push(`  NO clear over-representation by asset type at the populated n. Either the corpus`);
    out.push(`  is too small / too top-loan-skewed for the categorical signal to surface, or the`);
    out.push(`  signal genuinely flat at this size. Concentration directional, rollover untestable.`);
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[structural-v2] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
