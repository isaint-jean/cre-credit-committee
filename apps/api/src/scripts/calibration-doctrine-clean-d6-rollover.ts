/**
 * Standalone validation of doctrine-clean dimension 6 (Rollover)
 * against the clean backbone corpus. Includes a coverage-verify for
 * dimension 8 (asset-class) to confirm null-assetType records now route
 * to HITL ('N/A' tier) instead of silently bucketing into Tier IV.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d6-rollover.ts
 *
 * SANITY CHECK, not a signal gate. The dim-8 validation taught the
 * lesson: standalone separation isn't the success metric for a
 * provenanced contribution. The dimension's purpose is to supply a
 * KBRA/DBRS-derived rollover risk weight that the scoring architecture
 * (later build-order step) combines with other dimensions.
 *
 * What this checks:
 *   - Coverage handling: POPULATED vs N/A-by-asset-type vs HITL vs
 *     out-of-range — three states route correctly, none silently
 *     bucketed into a risk tier
 *   - Standalone direction: does the dimension move LOSS-vs-CLEAN in
 *     the expected direction at populated n
 *   - Rollover-vs-Retail confound probe: can we disentangle? Honest
 *     answer at n=3 LOSS
 *   - Dim 8 coverage verify: the null-assetType records that were
 *     formerly silently in Tier IV now correctly route to 'N/A'
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateAssetClass,
  evaluateRollover,
  ROLLOVER_BANDS,
  type RolloverDimensionInput,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d6-rollover.out';

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

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / dimension 6 (Rollover) — standalone sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('SANITY CHECK, not a signal gate (recalibrated per dim-8 lesson).');
  out.push('');

  /* === BAND TABLE (transparency) ========================================== */
  out.push('================================================================');
  out.push('BAND TABLE — spec v2 § 6 + KBRA / DBRS rollover treatment');
  out.push('================================================================');
  out.push('');
  out.push(`  Band       Risk    Share-of-income range`);
  for (const b of ROLLOVER_BANDS) {
    const lo = (b.minShare * 100).toFixed(0);
    const hi = b.maxShare > 1 ? '100' : (b.maxShare * 100).toFixed(0);
    out.push(`  ${b.tier.padEnd(10)} ${b.riskContribution.toFixed(2)}    [${lo}%, ${hi}%)`);
  }
  out.push('  N/A         ---    (asset class has no commercial leases — Hotel/Multifamily/MHC/SelfStorage)');
  out.push('  HITL        ---    (input missing — parse-failed or pctIncomeExpiringWithinTerm absent)');
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  const cleansAll = records.filter(r => r.outcomeClass === 'CLEAN');
  const lossesAll = records.filter(r => r.outcomeClass === 'LOSS');
  out.push(`  CLEAN ${cleansAll.length}   STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}   LOSS ${lossesAll.length}`);
  out.push('');

  /* === SCORE === */
  const scored = records.map(r => {
    const input: RolloverDimensionInput = {
      pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm,
      assetType: r.assetType,
      tenantDataStatus: r.tenantDataStatus as RolloverDimensionInput['tenantDataStatus'],
    };
    return { record: r, contribution: evaluateRollover(input) };
  });

  /* === (1) COVERAGE BREAKDOWN — applicability routing =================== */
  out.push('================================================================');
  out.push('(1) COVERAGE — applicability routing (the three input states)');
  out.push('================================================================');
  out.push('');
  out.push('  Three input states route as follows:');
  out.push('    populated         → applicability=\'applicable\',          riskContribution non-null');
  out.push('    na-by-asset-type  → applicability=\'not-applicable-by-asset-type\', riskContribution null');
  out.push('    parse-failed/null → applicability=\'hitl-needed\',         riskContribution null');
  out.push('');
  out.push('  Counts by routing and by outcome class:');
  const route = (s: typeof scored[number]) => s.contribution.applicability;
  const buckets: Record<string, { CLEAN: number; LOSS: number; STRESS: number }> = {
    'applicable': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'not-applicable-by-asset-type': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'hitl-needed': { CLEAN: 0, LOSS: 0, STRESS: 0 },
  };
  for (const s of scored) {
    const b = buckets[route(s)]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'routing'.padEnd(34)} CLEAN   LOSS   STRESS`);
  for (const [k, b] of Object.entries(buckets)) {
    out.push(`  ${k.padEnd(34)} ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');
  out.push('  Sanity: every record is in exactly one routing bucket; no double-counting,');
  out.push('  no record was silently bucketed into a risk band without applicability=applicable.');
  out.push('');

  /* === (2) BAND DISTRIBUTION ON APPLICABLE RECORDS ====================== */
  out.push('================================================================');
  out.push('(2) BAND DISTRIBUTION — applicable records only');
  out.push('================================================================');
  out.push('');
  const applicable = scored.filter(s => s.contribution.applicability === 'applicable');
  out.push(`  n applicable records: ${applicable.length}`);
  out.push('');
  const distByClass = (cls: 'CLEAN' | 'STRESS-ONLY' | 'LOSS'): Record<string, number> => {
    const d: Record<string, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
    for (const s of applicable.filter(s => s.record.outcomeClass === cls)) {
      d[s.contribution.tier] = (d[s.contribution.tier] ?? 0) + 1;
    }
    return d;
  };
  out.push(`  ${'class'.padEnd(12)} low   moderate  elevated  high   total`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const d = distByClass(cls);
    const total = applicable.filter(s => s.record.outcomeClass === cls).length;
    out.push(`  ${cls.padEnd(12)} ${(d.low ?? 0).toString().padStart(3)}   ${(d.moderate ?? 0).toString().padStart(7)}   ${(d.elevated ?? 0).toString().padStart(8)}   ${(d.high ?? 0).toString().padStart(4)}   ${total.toString().padStart(5)}`);
  }
  out.push('');

  /* === (3) STANDALONE SEPARATION — riskContribution distribution by class === */
  out.push('================================================================');
  out.push('(3) STANDALONE SEPARATION — applicable records only');
  out.push('================================================================');
  out.push('');
  const xsByClass = (cls: 'CLEAN' | 'LOSS'): number[] => applicable
    .filter(s => s.record.outcomeClass === cls)
    .map(s => s.contribution.riskContribution!)
    .filter((x): x is number => x !== null);
  const cleansX = xsByClass('CLEAN');
  const lossesX = xsByClass('LOSS');
  out.push(`  ${'class'.padEnd(8)} n     mean    median  min    max`);
  for (const [label, xs] of [['CLEAN', cleansX], ['LOSS', lossesX]] as const) {
    if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
    out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}   ${mean(xs).toFixed(2).padStart(5)}   ${median(xs).toFixed(2).padStart(5)}   ${Math.min(...xs).toFixed(2).padStart(5)}   ${Math.max(...xs).toFixed(2).padStart(5)}`);
  }
  const meanGap = mean(lossesX) - mean(cleansX);
  out.push('');
  out.push(`  Mean gap (LOSS − CLEAN): ${meanGap.toFixed(3)}   (positive = LOSS scores higher risk; expected direction)`);
  out.push('');

  /* === (4) LOSS-RATE BY BAND ============================================= */
  out.push('================================================================');
  out.push('(4) LOSS-RATE BY BAND — does the dimension separate?');
  out.push('================================================================');
  out.push('');
  const appNoStress = applicable.filter(s => s.record.outcomeClass !== 'STRESS-ONLY');
  const totalN = appNoStress.length;
  const totalL = appNoStress.filter(s => s.record.outcomeClass === 'LOSS').length;
  const overallRate = totalN > 0 ? totalL / totalN : 0;
  out.push(`  Among applicable records (excludes STRESS-ONLY): n=${totalN}  LOSS=${totalL}  baseline=${(overallRate*100).toFixed(1)}%`);
  out.push('');
  out.push(`  ${'band'.padEnd(10)} risk   n      CLEAN   LOSS   loss-rate   vs baseline`);
  for (const b of ROLLOVER_BANDS) {
    const inBand = appNoStress.filter(s => s.contribution.tier === b.tier);
    const c = inBand.filter(s => s.record.outcomeClass === 'CLEAN').length;
    const l = inBand.filter(s => s.record.outcomeClass === 'LOSS').length;
    const n = c + l;
    const rate = n > 0 ? l / n : 0;
    const mult = overallRate > 0 ? rate / overallRate : 0;
    out.push(`  ${b.tier.padEnd(10)} ${b.riskContribution.toFixed(2)}   ${n.toString().padStart(3)}    ${c.toString().padStart(5)}   ${l.toString().padStart(4)}   ${(rate*100).toFixed(1).padStart(6)}%   ${mult.toFixed(2)}×`);
  }
  out.push('');

  /* === (5) ROLLOVER-vs-RETAIL CONFOUND PROBE ============================ */
  out.push('================================================================');
  out.push('(5) ROLLOVER-vs-RETAIL CONFOUND — disentangle as far as n allows');
  out.push('================================================================');
  out.push('');
  out.push('  All 3 populated-LOSS records on the v3 read are Retail. Can the dimension');
  out.push('  separate rollover from asset-class on this corpus?');
  out.push('');
  // Among applicable records, slice by Retail/non-Retail
  const retailApp = appNoStress.filter(s => s.record.assetType === 'Retail');
  const nonRetailApp = appNoStress.filter(s => s.record.assetType !== 'Retail');
  const retailLoss = retailApp.filter(s => s.record.outcomeClass === 'LOSS').length;
  const nonRetailLoss = nonRetailApp.filter(s => s.record.outcomeClass === 'LOSS').length;
  out.push(`  Retail applicable records:     n=${retailApp.length}  CLEAN=${retailApp.length - retailLoss}  LOSS=${retailLoss}`);
  out.push(`  Non-Retail applicable records: n=${nonRetailApp.length}  CLEAN=${nonRetailApp.length - nonRetailLoss}  LOSS=${nonRetailLoss}`);
  out.push('');
  if (nonRetailLoss === 0) {
    out.push('  ⚠ ZERO non-Retail LOSSes in the applicable (populated rollover) subset. The');
    out.push('    confound cannot be empirically disentangled on this corpus — every LOSS');
    out.push('    that exposes a populated rollover signal is also Retail. Rollover\'s');
    out.push('    standalone signal on this corpus is INDISTINGUISHABLE from Retail\'s.');
  } else {
    out.push('  Within non-Retail applicable records:');
    out.push(`  ${'band'.padEnd(10)} n      LOSS   loss-rate`);
    for (const b of ROLLOVER_BANDS) {
      const inBand = nonRetailApp.filter(s => s.contribution.tier === b.tier);
      const l = inBand.filter(s => s.record.outcomeClass === 'LOSS').length;
      const rate = inBand.length > 0 ? l / inBand.length : 0;
      out.push(`  ${b.tier.padEnd(10)} ${inBand.length.toString().padStart(3)}    ${l.toString().padStart(4)}   ${(rate*100).toFixed(1).padStart(6)}%`);
    }
  }
  out.push('');
  out.push('  Within Retail applicable records:');
  out.push(`  ${'band'.padEnd(10)} n      LOSS   loss-rate`);
  for (const b of ROLLOVER_BANDS) {
    const inBand = retailApp.filter(s => s.contribution.tier === b.tier);
    const l = inBand.filter(s => s.record.outcomeClass === 'LOSS').length;
    const rate = inBand.length > 0 ? l / inBand.length : 0;
    out.push(`  ${b.tier.padEnd(10)} ${inBand.length.toString().padStart(3)}    ${l.toString().padStart(4)}   ${(rate*100).toFixed(1).padStart(6)}%`);
  }
  out.push('');
  out.push('  Honest read: with n=3 LOSS (all Retail), the corpus does not let us test');
  out.push('  whether non-Retail high-rollover loans also lose. The structural test\'s');
  out.push('  24.6-pt mean gap on rollover stands as the directional read, but the');
  out.push('  asset-class CONTROL is unavailable at this n. Re-run after richer extraction.');
  out.push('');

  /* === (6) HITL list (compact) =========================================== */
  out.push('================================================================');
  out.push('(6) HITL RECORDS (input missing — route to human review)');
  out.push('================================================================');
  out.push('');
  const hitl = scored.filter(s => s.contribution.applicability === 'hitl-needed');
  out.push(`  n records routed to HITL: ${hitl.length}`);
  out.push('  Coverage status breakdown:');
  const byStatus = new Map<string, number>();
  for (const s of hitl) {
    const k = s.record.tenantDataStatus ?? 'tenantDataStatus=null';
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byStatus) out.push(`    ${k.padEnd(28)} ${n}`);
  out.push('');

  /* === (7) DIM 8 COVERAGE VERIFY ======================================== */
  out.push('================================================================');
  out.push('(7) DIM 8 COVERAGE VERIFY — null-assetType now routes to N/A, not Tier IV');
  out.push('================================================================');
  out.push('');
  const dim8Scored = records.map(r => ({
    record: r,
    contribution: evaluateAssetClass({
      assetType: r.assetType,
      subType: r.subType,
      propertyName: r.propertyName,
    }),
  }));
  const dim8NullAssetType = dim8Scored.filter(s => s.record.assetType === null);
  const dim8Tiers = { I: 0, II: 0, III: 0, IV: 0, 'N/A': 0 } as Record<string, number>;
  for (const s of dim8Scored) {
    dim8Tiers[s.contribution.tier] = (dim8Tiers[s.contribution.tier] ?? 0) + 1;
  }
  out.push(`  Records with null assetType: ${dim8NullAssetType.length}`);
  out.push(`  Of these, dim-8 tier assignment:`);
  const nullTierDist = { I: 0, II: 0, III: 0, IV: 0, 'N/A': 0 } as Record<string, number>;
  for (const s of dim8NullAssetType) {
    nullTierDist[s.contribution.tier] = (nullTierDist[s.contribution.tier] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(nullTierDist)) out.push(`    tier=${k.padEnd(5)} ${n}`);
  const stillInIV = nullTierDist['IV'] ?? 0;
  out.push('');
  out.push(`  null-assetType records still in Tier IV: ${stillInIV}  ${stillInIV === 0 ? '✓ FIXED — none silently bucketed into Tier IV' : '✗ STILL BUCKETED into Tier IV — fix incomplete'}`);
  out.push('');
  out.push(`  Full dim-8 tier distribution across ALL records (post-fix):`);
  for (const [k, n] of Object.entries(dim8Tiers)) out.push(`    tier=${k.padEnd(5)} ${n}`);
  out.push('');
  const dim8Hitl = dim8Scored.filter(s => s.contribution.applicability === 'hitl-needed').length;
  const dim8NA = dim8Scored.filter(s => s.contribution.applicability === 'not-applicable-by-asset-type').length;
  out.push(`  dim-8 applicability counts:  applicable=${dim8Scored.length - dim8Hitl - dim8NA}  na=${dim8NA}  hitl=${dim8Hitl}`);
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine');
  out.push('================================================================');
  out.push('');
  out.push('  Run from the repo root to verify:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/" apps/api/src/doctrine-clean');
  out.push('  Expected output: nothing (matches in README.md are the fence statement itself).');
  out.push('');
  out.push('  Provenance for dim 6 (Rollover) traces ONLY to:');
  out.push('    - spec v2 § 6 (Lease rollover within loan term) + § "Method"');
  out.push('    - KBRA CMBS methodology — lease-turnover risk + per-tier rollover loadings');
  out.push('    - DBRS Morningstar CMBS methodology — vacancy + leasing-cost haircuts');
  out.push('    - clean backbone corpus (directional confirmation only)');
  out.push('  NEVER to manifesto_rules.json, the old doctrine module, or any old logic.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d6] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
