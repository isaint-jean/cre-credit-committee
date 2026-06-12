/**
 * Sanity validation for doctrine-clean dimension 5 (Income concentration).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d5-concentration.ts
 *
 * SANITY CHECK ONLY (under-tested by design):
 *   - largestTenantPct only ~41/176 populated on the clean corpus today
 *   - of the 41 populated records, concentration loss-anatomy effects
 *     are confounded with Retail / Mall asset-class signals (all 3 LOSS
 *     records that expose populated tenant data are Retail)
 *   - standalone separation likely flat — provenance-grounded; deepening
 *     = extractor work to surface base-rent shares for the full corpus
 *
 * What this checks:
 *   - 3-state coverage routing (applicable / not-applicable-by-asset-type /
 *     hitl-needed) — the dimension that PROPERLY uses the N/A state.
 *     Multifamily/MHC/Hotel/SelfStorage → N/A. Office/Retail/Industrial/
 *     MixedUse → applicable or HITL depending on tenant data.
 *   - Band distribution + plausible thresholds
 *   - SF/NRA basis deviation flagged in rationale
 *   - Bug screen — no NaN / Infinity / negative
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateIncomeConcentration,
  INCOME_CONCENTRATION_BANDS,
  INCOME_CONCENTRATION_APPLICABLE_TYPES,
  INCOME_CONCENTRATION_NA_TYPES,
} from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d5-concentration.out';

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  assetType: string | null;
  subType: string | null;
  largestTenantPct: number | null;
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
  out.push('doctrine-clean / dimension 5 (Income concentration) — sanity check');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Input: ${CORPUS_PATH}`);
  out.push('SANITY CHECK — under-tested by design (largestTenantPct ~41/176 populated; Retail-confounded).');
  out.push('NRA (SF) basis used as proxy for base-rent share (spec v2 §5 prefers base-rent — deviation flagged).');
  out.push('');

  /* === BAND + APPLICABILITY TABLES ====================================== */
  out.push('================================================================');
  out.push('BAND TABLE — top-tenant share thresholds');
  out.push('================================================================');
  out.push('');
  out.push(`  ${'tier'.padEnd(10)} risk   share range`);
  for (const b of INCOME_CONCENTRATION_BANDS) {
    const lo = (b.minShare * 100).toFixed(0);
    const hi = b.maxShare > 1 ? '100' : (b.maxShare * 100).toFixed(0);
    out.push(`  ${b.tier.padEnd(10)} ${b.riskContribution.toFixed(2)}   [${lo}%, ${hi}%)`);
  }
  out.push('  N/A         ---    asset class has no single-tenant concentration concept');
  out.push('  HITL        ---    largestTenantPct missing on a tenant-based asset class');
  out.push('');
  out.push(`  Tenant-based applicable types: ${Array.from(INCOME_CONCENTRATION_APPLICABLE_TYPES).join(', ')}`);
  out.push(`  N/A-by-asset-type types:       ${Array.from(INCOME_CONCENTRATION_NA_TYPES).join(', ')}`);
  out.push('');

  /* === LOAD === */
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push(`  CLEAN ${records.filter(r => r.outcomeClass === 'CLEAN').length}   STRESS-ONLY ${records.filter(r => r.outcomeClass === 'STRESS-ONLY').length}   LOSS ${records.filter(r => r.outcomeClass === 'LOSS').length}`);
  out.push('');

  /* === SCORE === */
  const scored = records.map(r => ({
    record: r,
    contribution: evaluateIncomeConcentration({
      assetType: r.assetType,
      largestTenantPct: r.largestTenantPct,
      largestTenantBasis: 'NRA',
    }),
  }));

  /* === (1) 3-STATE COVERAGE ROUTING ===================================== */
  out.push('================================================================');
  out.push('(1) COVERAGE — proper 3-state routing (this dim uses N/A correctly)');
  out.push('================================================================');
  out.push('');
  const buckets: Record<string, { CLEAN: number; LOSS: number; STRESS: number }> = {
    'applicable': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'not-applicable-by-asset-type': { CLEAN: 0, LOSS: 0, STRESS: 0 },
    'hitl-needed': { CLEAN: 0, LOSS: 0, STRESS: 0 },
  };
  for (const s of scored) {
    const b = buckets[s.contribution.applicability]!;
    if (s.record.outcomeClass === 'CLEAN') b.CLEAN++;
    else if (s.record.outcomeClass === 'LOSS') b.LOSS++;
    else b.STRESS++;
  }
  out.push(`  ${'routing'.padEnd(34)} CLEAN   LOSS   STRESS`);
  for (const [k, b] of Object.entries(buckets)) {
    out.push(`  ${k.padEnd(34)} ${b.CLEAN.toString().padStart(5)}   ${b.LOSS.toString().padStart(4)}   ${b.STRESS.toString().padStart(6)}`);
  }
  out.push('');
  // Sanity: N/A bucket should be unit/room-based assets only.
  const naTypes = new Set<string>();
  for (const s of scored.filter(s => s.contribution.applicability === 'not-applicable-by-asset-type')) {
    if (s.record.assetType !== null) naTypes.add(s.record.assetType);
  }
  out.push(`  N/A asset classes observed: ${Array.from(naTypes).sort().join(', ')}`);
  const naLeak = Array.from(naTypes).filter(t => !INCOME_CONCENTRATION_NA_TYPES.has(t));
  out.push(`  Sanity: N/A bucket contains ONLY unit/room-based types: ${naLeak.length === 0 ? '✓' : `⚠ leakage: ${naLeak.join(', ')}`}`);
  out.push('');

  /* === (2) BAND DISTRIBUTION ============================================ */
  out.push('================================================================');
  out.push('(2) BAND DISTRIBUTION — applicable records only');
  out.push('================================================================');
  out.push('');
  const applicable = scored.filter(s => s.contribution.applicability === 'applicable');
  out.push(`  n applicable: ${applicable.length}`);
  out.push('');
  out.push(`  ${'class'.padEnd(12)} low   moderate  elevated  high   total`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const inCls = applicable.filter(s => s.record.outcomeClass === cls);
    const d: Record<string, number> = { low: 0, moderate: 0, elevated: 0, high: 0 };
    for (const s of inCls) d[s.contribution.tier] = (d[s.contribution.tier] ?? 0) + 1;
    out.push(`  ${cls.padEnd(12)} ${(d.low ?? 0).toString().padStart(3)}   ${(d.moderate ?? 0).toString().padStart(7)}   ${(d.elevated ?? 0).toString().padStart(8)}   ${(d.high ?? 0).toString().padStart(4)}   ${inCls.length.toString().padStart(5)}`);
  }
  out.push('');

  /* === (3) SHARE DISTRIBUTION =========================================== */
  out.push('================================================================');
  out.push('(3) SHARE DISTRIBUTION — applicable records');
  out.push('================================================================');
  out.push('');
  const shares = applicable.map(s => s.contribution.derivedOutputs?.topTenantShare as number).filter(Number.isFinite);
  if (shares.length > 0) {
    out.push(`  n=${shares.length}  min ${(Math.min(...shares) * 100).toFixed(1)}%  mean ${(mean(shares) * 100).toFixed(1)}%  median ${(median(shares) * 100).toFixed(1)}%  max ${(Math.max(...shares) * 100).toFixed(1)}%`);
    out.push(`  Implausible (< 0 or > 1): ${shares.filter(x => x < 0 || x > 1).length}`);
  }
  out.push('');

  /* === (4) BUG SCREEN =================================================== */
  out.push('================================================================');
  out.push('(4) BUG SCREEN — no NaN / Infinity / negative across derived outputs');
  out.push('================================================================');
  out.push('');
  let nan = 0, inf = 0, neg = 0;
  for (const s of applicable) {
    const d = s.contribution.derivedOutputs ?? {};
    for (const k of Object.keys(d)) {
      const v = d[k] as number | null;
      if (v === null) continue;
      if (Number.isNaN(v)) nan++;
      if (!Number.isFinite(v) && !Number.isNaN(v)) inf++;
      if (v < 0) neg++;
    }
  }
  out.push(`  NaN: ${nan}  ${nan === 0 ? '✓' : '⚠'}`);
  out.push(`  Infinity: ${inf}  ${inf === 0 ? '✓' : '⚠'}`);
  out.push(`  Negative: ${neg}  ${neg === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === (5) STANDALONE SEPARATION (under-tested framing) ================= */
  out.push('================================================================');
  out.push('(5) STANDALONE SEPARATION — LOSS vs CLEAN (under-tested by design)');
  out.push('================================================================');
  out.push('');
  out.push('  CONTEXT: only ~41/176 records have populated largestTenantPct, AND every populated-LOSS');
  out.push('  record is Retail. Concentration\'s standalone signal here is indistinguishable from');
  out.push('  Retail asset-class signal at this n. Flat / weak read EXPECTED and ACCEPTED.');
  out.push('');
  const cShares = applicable.filter(s => s.record.outcomeClass === 'CLEAN').map(s => s.contribution.derivedOutputs?.topTenantShare as number).filter(Number.isFinite);
  const lShares = applicable.filter(s => s.record.outcomeClass === 'LOSS').map(s => s.contribution.derivedOutputs?.topTenantShare as number).filter(Number.isFinite);
  out.push(`  ${'class'.padEnd(8)} n     mean      median    min       max`);
  for (const [label, xs] of [['CLEAN', cShares], ['LOSS', lShares]] as const) {
    if (xs.length === 0) { out.push(`  ${label.padEnd(8)} (n=0)`); continue; }
    const fmt = (x: number) => (x * 100).toFixed(1) + '%';
    out.push(`  ${label.padEnd(8)} ${xs.length.toString().padStart(3)}   ${fmt(mean(xs)).padStart(7)}   ${fmt(median(xs)).padStart(7)}   ${fmt(Math.min(...xs)).padStart(7)}   ${fmt(Math.max(...xs)).padStart(7)}`);
  }
  if (cShares.length > 0 && lShares.length > 0) {
    const gap = mean(lShares) - mean(cShares);
    out.push('');
    out.push(`  Mean gap (LOSS − CLEAN): ${(gap * 100).toFixed(1)} pts  (sign depends on Retail-mix; n too small for inference)`);
  }
  out.push('');
  out.push(`  ⚠ UNDER-TESTED — n=${lShares.length} populated-LOSS, all Retail (asset-class confound).`);
  out.push('  Deepening = extractor work to surface per-tenant base-rent share + larger corpus.');
  out.push('');

  /* === (6) HITL BREAKDOWN =============================================== */
  out.push('================================================================');
  out.push('(6) HITL RECORDS — tenant-based but largestTenantPct missing');
  out.push('================================================================');
  out.push('');
  const hitl = scored.filter(s => s.contribution.applicability === 'hitl-needed');
  out.push(`  n routed to HITL: ${hitl.length}`);
  const byStatus: Record<string, number> = {};
  for (const s of hitl) {
    const k = s.record.tenantDataStatus ?? 'tenantDataStatus=null';
    byStatus[k] = (byStatus[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byStatus).sort()) out.push(`    ${k.padEnd(28)} ${n}`);
  out.push('  (Coverage is honestly thin today — deepening = body-page tenant-table parse coverage)');
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — no import / reference to old doctrine / old concentration logic');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -rE "manifesto_rules|services/doctrine/|services/judgment/|tenant_concentration|herfindahl" apps/api/src/doctrine-clean');
  out.push('  Expected: matches only in README + dim doc-comment fence statements.');
  out.push('');
  out.push('  Provenance for dim 5 traces ONLY to:');
  out.push('    - spec v2 §5 (verbatim in dim header)');
  out.push('    - Moody\'s loan- and property-level Herfindahl diversity index (US Conduit/Fusion methodology)');
  out.push('    - KBRA CMBS Loss Study series — tenant concentration among loss drivers');
  out.push('    - DBRS Morningstar pre-sale tenant rosters — top tenants reported by base rent');
  out.push('    - Single-tenant CTL convention (>=75% top-share boundary)');
  out.push('  NEVER to manifesto_rules.json / old doctrine / old concentration logic.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d5] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
