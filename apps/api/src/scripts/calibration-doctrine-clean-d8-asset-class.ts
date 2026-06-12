/**
 * Standalone validation of doctrine-clean dimension 8 (Asset class)
 * against the clean backbone corpus.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d8-asset-class.ts
 *
 * Runs the dimension ALONE — no scoring architecture composition. Asks:
 * does the asset-class risk contribution alone separate LOSS from CLEAN
 * on this corpus?
 *
 * Reports: tier table; distribution of contribution by outcome class;
 * loss-rate by tier; explicit Office divergence (the 2013-2016 vintage
 * shows office safe but the dimension trusts the standard).
 *
 * IN-SAMPLE caveat called out: the corpus directionally informed the
 * tiering. This validation reads how MUCH separation the public-standard
 * tiering produces — it does not declare an out-of-sample win.
 *
 * Reference, not a target — same status as the prior calibration runs.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateAssetClass, ASSET_CLASS_TIER_DEFINITIONS } from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d8-asset-class.out';

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
  out.push('doctrine-clean / dimension 8 (Asset class) — standalone validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('Reference, not a target. No scoring architecture, no composition with other dimensions.');
  out.push('');

  /* === Show the tier table (transparency) ================================= */
  out.push('================================================================');
  out.push('TIER TABLE (spec v2 § 8 + Moody\'s / KBRA / DBRS)');
  out.push('================================================================');
  out.push('');
  out.push(`  Tier   Risk    Classes`);
  for (const td of ASSET_CLASS_TIER_DEFINITIONS) {
    out.push(`  ${td.tier.padEnd(4)}   ${td.riskContribution.toFixed(2)}    ${td.classes.join(', ')}`);
  }
  out.push('');
  out.push('  Provenance (one citation per tier, full list in source code):');
  for (const td of ASSET_CLASS_TIER_DEFINITIONS) {
    out.push(`    Tier ${td.tier}: ${td.provenance[0]}`);
  }
  out.push('');

  /* === Load + evaluate ==================================================== */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}  (CLEAN ${records.filter(r => r.outcomeClass === 'CLEAN').length}, STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}, LOSS ${records.filter(r => r.outcomeClass === 'LOSS').length})`);
  out.push('');

  const scored = records.map(r => {
    const c = evaluateAssetClass({
      assetType: r.assetType,
      subType: r.subType,
      propertyName: r.propertyName,
    });
    return { record: r, contribution: c };
  });

  /* === (1) Distribution of contribution by outcome class ================= */
  out.push('================================================================');
  out.push('(1) RISK CONTRIBUTION DISTRIBUTION BY OUTCOME CLASS');
  out.push('================================================================');
  out.push('');
  out.push('  Range [0.0, 1.0] — 0 = lowest asset-class risk, 1 = highest.');
  out.push('');
  out.push(`  ${'class'.padEnd(12)} n     mean    median   p25     p75     min     max`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const subset = scored.filter(s => s.record.outcomeClass === cls);
    if (subset.length === 0) { out.push(`  ${cls.padEnd(12)} (n=0)`); continue; }
    const xs = subset.map(s => s.contribution.riskContribution);
    const sorted = [...xs].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length / 4)] ?? NaN;
    const p75 = sorted[Math.floor(sorted.length * 3 / 4)] ?? NaN;
    out.push(`  ${cls.padEnd(12)} ${xs.length.toString().padStart(3)}   ${mean(xs).toFixed(2).padStart(5)}   ${median(xs).toFixed(2).padStart(5)}    ${p25.toFixed(2).padStart(5)}   ${p75.toFixed(2).padStart(5)}   ${Math.min(...xs).toFixed(2).padStart(5)}   ${Math.max(...xs).toFixed(2).padStart(5)}`);
  }
  const cleans = scored.filter(s => s.record.outcomeClass === 'CLEAN');
  const losses = scored.filter(s => s.record.outcomeClass === 'LOSS');
  const meanGap = mean(losses.map(s => s.contribution.riskContribution)) - mean(cleans.map(s => s.contribution.riskContribution));
  out.push('');
  out.push(`  Mean gap (LOSS − CLEAN): ${meanGap.toFixed(3)}   (positive = LOSSes score higher risk; expected direction)`);
  out.push('');

  /* === (2) Tier distribution by class ===================================== */
  out.push('================================================================');
  out.push('(2) PER-TIER MIX BY OUTCOME CLASS');
  out.push('================================================================');
  out.push('');
  out.push(`  ${'class'.padEnd(12)} Tier I   Tier II   Tier III   Tier IV   total`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const subset = scored.filter(s => s.record.outcomeClass === cls);
    const dist = { I: 0, II: 0, III: 0, IV: 0 } as Record<string, number>;
    for (const s of subset) dist[s.contribution.tier] = (dist[s.contribution.tier] ?? 0) + 1;
    out.push(`  ${cls.padEnd(12)} ${dist.I!.toString().padStart(6)}   ${dist.II!.toString().padStart(7)}   ${dist.III!.toString().padStart(8)}   ${dist.IV!.toString().padStart(7)}   ${subset.length.toString().padStart(5)}`);
  }
  out.push('');

  /* === (3) Loss-rate by tier — the headline ============================== */
  out.push('================================================================');
  out.push('(3) LOSS-RATE BY TIER — does the dimension separate?');
  out.push('================================================================');
  out.push('');
  const overall = scored.filter(s => s.record.outcomeClass !== 'STRESS-ONLY');
  const totalN = overall.length;
  const totalL = overall.filter(s => s.record.outcomeClass === 'LOSS').length;
  const overallRate = totalL / Math.max(1, totalN);
  out.push(`  Overall (CLEAN + LOSS, excludes STRESS-ONLY): n=${totalN}  LOSS=${totalL}  baseline loss-rate=${(overallRate*100).toFixed(1)}%`);
  out.push('');
  out.push(`  ${'tier'.padEnd(8)} risk   n      CLEAN   LOSS   loss-rate   vs baseline`);
  for (const t of ['I', 'II', 'III', 'IV'] as const) {
    const inTier = overall.filter(s => s.contribution.tier === t);
    const tierC = inTier.filter(s => s.record.outcomeClass === 'CLEAN').length;
    const tierL = inTier.filter(s => s.record.outcomeClass === 'LOSS').length;
    const tierN = tierC + tierL;
    const rate = tierN > 0 ? tierL / tierN : 0;
    const mult = overallRate > 0 ? rate / overallRate : 0;
    const td = ASSET_CLASS_TIER_DEFINITIONS.find(x => x.tier === t)!;
    out.push(`  ${t.padEnd(8)} ${td.riskContribution.toFixed(2)}   ${tierN.toString().padStart(3)}    ${tierC.toString().padStart(5)}   ${tierL.toString().padStart(4)}   ${(rate*100).toFixed(1).padStart(6)}%   ${mult.toFixed(2)}×`);
  }
  out.push('');

  /* === (4) Office divergence — explicit accounting ====================== */
  out.push('================================================================');
  out.push('(4) OFFICE DIVERGENCE — standard says risky, this vintage corpus says safe');
  out.push('================================================================');
  out.push('');
  const office = scored.filter(s => s.record.assetType === 'Office');
  const officeL = office.filter(s => s.record.outcomeClass === 'LOSS').length;
  const officeC = office.filter(s => s.record.outcomeClass === 'CLEAN').length;
  const officeRate = office.length > 0 ? officeL / office.length : 0;
  out.push(`  Office records in corpus: n=${office.length}  CLEAN=${officeC}  LOSS=${officeL}  loss-rate=${(officeRate*100).toFixed(1)}%`);
  out.push(`  Overall baseline:         ${(overallRate*100).toFixed(1)}%`);
  out.push(`  Corpus office / overall:  ${overallRate > 0 ? (officeRate / overallRate).toFixed(2) : 'N/A'}×`);
  out.push('');
  out.push('  Per spec v2 § 8 method convergence: trust the standard. The dimension');
  out.push('  places Office in Tier III (Elevated) regardless of this corpus\'s vintage-');
  out.push('  specific safety reading. KBRA / DBRS / Moody\'s all flag office as');
  out.push('  structurally pressured post-2020; the 2013-2016 vintage corpus is pre-shift');
  out.push('  data. The dimension would mis-predict office stability on 2026 originations');
  out.push('  if it discounted for this vintage\'s low office loss-rate. Standard wins.');
  out.push('');
  out.push('  Expected consequence on this corpus: Office in Tier III contributes to');
  out.push('  "CLEAN false-positives" — cleans whose only structural-risk signal is being');
  out.push('  Office. That is acceptable; it reflects the rebuild\'s out-of-sample design');
  out.push('  intent. Future calibration on 2020+ vintage data should see Office\'s loss-');
  out.push('  rate climb toward the agency-framed level.');
  out.push('');

  /* === (5) Recall / FP at a sensible threshold =========================== */
  out.push('================================================================');
  out.push('(5) RECALL / FP AT SIMPLE THRESHOLDS');
  out.push('================================================================');
  out.push('');
  out.push('  Treating "Tier III or IV" as the flag set (a calibration threshold the');
  out.push('  scoring architecture would tune later — here we just report the read):');
  const flagged = overall.filter(s => s.contribution.tier === 'III' || s.contribution.tier === 'IV');
  const fl = flagged.filter(s => s.record.outcomeClass === 'LOSS').length;
  const fc = flagged.filter(s => s.record.outcomeClass === 'CLEAN').length;
  const recall = fl / Math.max(1, totalL);
  const fp = fc / Math.max(1, totalN - totalL);
  out.push(`    Flagged: n=${flagged.length}   LOSS=${fl}   CLEAN=${fc}   loss-rate=${(fl*100/Math.max(1,flagged.length)).toFixed(1)}%`);
  out.push(`    Recall (LOSSes in flag set):    ${fl}/${totalL}  (${(recall*100).toFixed(0)}%)`);
  out.push(`    FP (CLEANs in flag set):        ${fc}/${totalN - totalL}  (${(fp*100).toFixed(0)}%)`);
  out.push('');

  /* === (6) HITL / coverage ============================================== */
  out.push('================================================================');
  out.push('(6) HITL — records the dimension couldn\'t evaluate');
  out.push('================================================================');
  out.push('');
  const hitl = scored.filter(s => !s.contribution.evaluated);
  out.push(`  HITL records (assetType absent): ${hitl.length}/${records.length}`);
  if (hitl.length > 0) {
    for (const s of hitl.slice(0, 5)) {
      out.push(`    ${s.record.dealName} #${s.record.prosId} ${s.record.propertyName}  outcome=${s.record.outcomeClass}`);
    }
    if (hitl.length > 5) out.push(`    ... and ${hitl.length - 5} more`);
    out.push('  These records receive a conservative Tier IV contribution but are flagged');
    out.push('  evaluated=false so the scoring architecture can route to a human review.');
  }
  out.push('');

  /* === (7) IN-SAMPLE caveat + honest read ============================== */
  out.push('================================================================');
  out.push('(7) IN-SAMPLE CAVEAT + HONEST READ');
  out.push('================================================================');
  out.push('');
  out.push('  The corpus directionally informed the tiering (spec v2 § 8 method ');
  out.push('  convergence — corpus confirms agency direction except office). This');
  out.push('  validation reports HOW MUCH the public-standard tiering separates LOSS');
  out.push('  from CLEAN on the SAME corpus that confirmed direction. It is NOT an');
  out.push('  out-of-sample test.');
  out.push('');
  out.push('  What out-of-sample would change:');
  out.push('   - 2020+ vintage data is the natural next test (office actually pressured).');
  out.push('   - Cross-shelf folding (train Tier IV on 4 shelves, test on 5th) would');
  out.push('     also expose tier robustness, though n LOSS at any fold is small.');
  out.push('');
  out.push('  The dimension\'s purpose at this stage: SUPPLY A PROVENANCED ASSET-CLASS');
  out.push('  RISK CONTRIBUTION that the scoring architecture (later build-order step)');
  out.push('  can combine with the other eight dimensions. Standalone separation is a');
  out.push('  diagnostic, not the success metric.');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine');
  out.push('================================================================');
  out.push('');
  out.push('  Run this command from the repo root to verify:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/" apps/api/src/doctrine-clean');
  out.push('  Expected output: nothing.');
  out.push('');
  out.push('  Provenance for this dimension traces ONLY to:');
  out.push('    - spec v2 § 8 (Asset-class adjustments) + § "Method / convergence"');
  out.push('    - Moody\'s CMBS asset-class stability ranking (public)');
  out.push('    - KBRA CMBS methodology — per-asset-class treatments (public)');
  out.push('    - DBRS Morningstar CMBS rating methodology (public)');
  out.push('    - clean backbone corpus (directional confirmation only)');
  out.push('  NEVER to manifesto_rules.json, the old doctrine module, or any old');
  out.push('  judgment / evaluation logic.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d8] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
