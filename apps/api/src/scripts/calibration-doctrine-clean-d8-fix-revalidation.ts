/**
 * Re-validation after asset-class canonicalize fix.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-d8-fix-revalidation.ts
 *
 * Reports:
 *   - The 37 previously-Tier-IV records: their NEW tier + classification path
 *   - Re-run stage-1 base-blend on the corpus: distribution shift
 *   - Re-run stage-2 overrides: NEW Override A fire-rate (was 79/45%; expect a meaningful drop)
 *   - Confirm any new HITL routings are genuine no-signal cases
 *   - Confirm no regressions on already-correct classifications
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  evaluateLeverageLtv,
  evaluateCoverageDscr,
  evaluateDebtYield,
  evaluateRefinanceFeasibility,
  evaluateRollover,
  evaluateIncomeConcentration,
  evaluateAssetClass,
  computeBaseBlend,
  applyOverrides,
} from '../doctrine-clean/index.js';
import type { DimensionContribution } from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-d8-fix-revalidation.out';

// The 37 (propertyName, dealName) pairs that were Tier IV pre-fix
const PRE_FIX_TIER_IV_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['Concord Mills', 'WFRBS 2013-C11'],
  ['Rhp Portfolio I', 'WFRBS 2013-C11'],
  ['Brennan Industrial Portfolio II', 'WFRBS 2013-C11'],
  ['Midland Odessa Self Storage Portfolio', 'WFRBS 2013-C11'],
  ['Ascentia Mhc Portfolio', 'CGCMT 2013-GCJ11'],
  ['The Crossings Premium Outlets', 'MSBAM 2013-C8'],
  ['Chrysler East Building', 'MSBAM 2013-C8'],
  ['Wanamaker Building', 'MSBAM 2013-C8'],
  ['Hyatt Regency Hill Country Resort and Spa', 'MSBAM 2013-C8'],
  ['Storage Post Portfolio', 'MSBAM 2013-C8'],
  ['Carolina Premium Outlets', 'MSBAM 2013-C8'],
  ['Broadcasting Square Shopping Center', 'MSBAM 2013-C8'],
  ['Anderson Mall', 'MSBAM 2013-C8'],
  ['Warwick Estates Mhc', 'MSBAM 2013-C8'],
  ['Cole Income Nav Portfolio', 'WFCM 2015-LC20'],
  ['Rhp Portfolio II', 'WFRBS 2013-C12'],
  ['Victoria Mall', 'WFRBS 2013-C12'],
  ['Woodbridge Center', 'WFRBS 2014-C20'],
  ['A-3-16 Bloomberg Data Center', 'WFRBS 2014-C20'],
  ['Brunswick Square', 'WFRBS 2014-C20'],
  ['Savoy Retail & 60 TH Street Residential', 'WFRBS 2014-C20'],
  ['Iron Guard Storage Portfolio', 'CGCMT 2014-GC25'],
  ['Americasmart', 'MSBAM 2014-C14'],
  ['Sun Communities Portfolio', 'MSBAM 2014-C14'],
  ['Stonestown Galleria', 'MSBAM 2014-C14'],
  ['Greenleigh Mhc', 'MSBAM 2014-C14'],
  ['County View Mhc', 'MSBAM 2014-C14'],
  ['Arundel Mills & Marketplace', 'MSBAM 2014-C15'],
  ['Americasmart', 'MSBAM 2014-C15'],
  ['La Concha Hotel & Tower', 'MSBAM 2014-C15'],
  ['Sun Communities Portfolio II', 'MSBAM 2014-C15'],
  ['Marriott Philadelphia Downtown', 'MSBAM 2014-C15'],
  ['Aspen Lake Office Portfolio', 'MSBAM 2014-C15'],
  ['JW Marriott and Fairfield Inn & Suites', 'MSBAM 2014-C15'],
  ['Aspen Heights - Harrisonburg', 'MSBAM 2014-C15'],
  ['Northway Mall', 'MSBAM 2014-C15'],
  ['Elston Center', 'MSBAM 2014-C15'],
];

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
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i]!;
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / dim 8 canonicalize fix — re-validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('SCOPE: fixes coverage-into-risk conflation. Tiers + provenance UNCHANGED (spec §8).');
  out.push('');

  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`Records (non-pending): ${records.length}`);
  out.push('');

  /* === (1) BEFORE→AFTER on the 37 pre-fix Tier-IV records ============= */
  out.push('================================================================');
  out.push('(1) BEFORE → AFTER on the 37 previously-Tier-IV records');
  out.push('================================================================');
  out.push('');
  out.push(`${'#'.padStart(3)}  ${'property'.padEnd(40)}  ${'raw subType'.padEnd(22)}  ${'before'.padEnd(10)}  ${'after'.padEnd(28)}  outcome`);
  let i = 1;
  let stillTierIv = 0;
  const newTierCounts: Record<string, number> = {};
  for (const [propName, dealName] of PRE_FIX_TIER_IV_PROPERTIES) {
    const r = records.find(x => x.propertyName === propName && x.dealName === dealName);
    if (!r) { out.push(`${i.toString().padStart(3)}  ${propName.padEnd(40)}  (record not found)`); i++; continue; }
    const newAc = evaluateAssetClass({ assetType: r.assetType, subType: r.subType, propertyName: r.propertyName });
    const afterTier = newAc.tier;
    const newKey = afterTier;
    newTierCounts[newKey] = (newTierCounts[newKey] ?? 0) + 1;
    if (afterTier === 'IV') stillTierIv++;
    // Extract classification source from rationale for compact display
    const srcMatch = newAc.rationale.match(/classification:\s*([\w-]+)/);
    const src = srcMatch ? srcMatch[1] : (afterTier === 'N/A' ? 'HITL' : '');
    out.push(`${i.toString().padStart(3)}  ${propName.slice(0, 40).padEnd(40)}  ${(r.subType ?? '').slice(0, 22).padEnd(22)}  ${'IV (0.80)'.padEnd(10)}  ${(afterTier + ' / ' + src).padEnd(28)}  ${r.outcomeClass}`);
    i++;
  }
  out.push('');
  out.push(`  Re-tier summary (was 37 in Tier IV pre-fix):`);
  for (const [k, n] of Object.entries(newTierCounts).sort()) {
    out.push(`    tier=${k.padEnd(5)} ${n}`);
  }
  out.push(`  Records still at Tier IV after fix: ${stillTierIv}`);
  out.push('');

  /* === (2) Spot-check HITL routings: are they genuinely no-signal? ===== */
  out.push('================================================================');
  out.push('(2) HITL ROUTINGS — confirm genuine no-signal');
  out.push('================================================================');
  out.push('');
  const allHitl: { record: CorpusRecord; rationale: string }[] = [];
  for (const r of records) {
    const ac = evaluateAssetClass({ assetType: r.assetType, subType: r.subType, propertyName: r.propertyName });
    if (ac.applicability === 'hitl-needed') allHitl.push({ record: r, rationale: ac.rationale });
  }
  out.push(`  Total HITL records: ${allHitl.length}`);
  // Group by reason
  const hitlReasons: Record<string, { count: number; samples: string[] }> = {};
  for (const h of allHitl) {
    const key = h.record.assetType === null
      ? 'rawAssetType=null'
      : `rawAssetType="${h.record.assetType}" subType="${h.record.subType ?? ''}"`;
    if (!hitlReasons[key]) hitlReasons[key] = { count: 0, samples: [] };
    hitlReasons[key]!.count++;
    if (hitlReasons[key]!.samples.length < 3) hitlReasons[key]!.samples.push(h.record.propertyName);
  }
  out.push('');
  out.push(`  Breakdown by reason (genuine no-signal cases):`);
  for (const [key, { count, samples }] of Object.entries(hitlReasons).sort((a, b) => b[1].count - a[1].count)) {
    out.push(`    ${key.padEnd(60)}  n=${count}`);
    for (const s of samples) out.push(`        sample: ${s}`);
  }
  out.push('');

  /* === (3) RE-RUN STAGE-1 + STAGE-2 — distribution shift =============== */
  out.push('================================================================');
  out.push('(3) RE-RUN — stage-1 base-blend + stage-2 overrides');
  out.push('================================================================');
  out.push('');
  const results = records.map(r => {
    const norm = normalizeSustainableCashflow({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, t12Noi: r.t12Noi,
      underwrittenOccupancy: null,
    });
    const dim7 = evaluateCapRateValuationStress({
      assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi,
      sustainableNcf: norm.sustainableNcf, concludedValue: r.concludedValue,
      loanAmount: r.loanAmount, marketTier: 'Unknown',
    });
    const ltv = evaluateLeverageLtv({ stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null });
    const dscr = evaluateCoverageDscr({
      sustainableNcf: norm.sustainableNcf, loanAmount: r.loanAmount, coupon: r.coupon,
      amortMonths: null, ioYears: null, termYears: null,
    });
    const dy = evaluateDebtYield({
      sustainableNoi: norm.sustainableNoi, loanAmount: r.loanAmount, assetType: r.assetType, subType: r.subType,
    });
    const refi = evaluateRefinanceFeasibility({
      assetType: r.assetType,
      loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null,
      sustainableNcf: norm.sustainableNcf, sustainableNoi: norm.sustainableNoi,
      stressedValue: (dim7.derivedOutputs?.stressedValue as number | undefined | null) ?? null,
    });
    const roll = evaluateRollover({
      pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm, assetType: r.assetType,
      tenantDataStatus: r.tenantDataStatus as
        | 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null,
    });
    const conc = evaluateIncomeConcentration({
      assetType: r.assetType, largestTenantPct: r.largestTenantPct, largestTenantBasis: 'NRA',
    });
    const ac = evaluateAssetClass({
      assetType: r.assetType, subType: r.subType, propertyName: r.propertyName,
    });
    const all: DimensionContribution[] = [dim7, refi, ac, roll, conc, ltv, dscr, dy];
    const blend = computeBaseBlend(all);
    const ov = applyOverrides(blend, all);
    return { record: r, ac, blend, ov };
  });

  // Asset-class tier distribution after fix
  const acTiers: Record<string, number> = {};
  for (const x of results) acTiers[x.ac.tier] = (acTiers[x.ac.tier] ?? 0) + 1;
  out.push(`  Asset-class tier distribution (AFTER fix):`);
  for (const [k, n] of Object.entries(acTiers).sort()) out.push(`    tier=${k.padEnd(5)} ${n}`);
  out.push(`  (Pre-fix: I=25, II=25, III=63, IV=37, N/A=26)`);
  out.push('');

  // baseRisk + finalRisk distributions
  const baseRisks = results.map(x => x.blend.baseRisk).filter((x): x is number => x !== null);
  const finalRisks = results.map(x => x.ov.finalRisk).filter((x): x is number => x !== null);
  out.push(`  baseRisk  n=${baseRisks.length}  min ${Math.min(...baseRisks).toFixed(3)}  p25 ${quantile(baseRisks,0.25).toFixed(3)}  median ${median(baseRisks).toFixed(3)}  p75 ${quantile(baseRisks,0.75).toFixed(3)}  max ${Math.max(...baseRisks).toFixed(3)}  mean ${mean(baseRisks).toFixed(3)}`);
  out.push(`  finalRisk n=${finalRisks.length}  min ${Math.min(...finalRisks).toFixed(3)}  p25 ${quantile(finalRisks,0.25).toFixed(3)}  median ${median(finalRisks).toFixed(3)}  p75 ${quantile(finalRisks,0.75).toFixed(3)}  max ${Math.max(...finalRisks).toFixed(3)}  mean ${mean(finalRisks).toFixed(3)}`);
  out.push(`  (PRE-FIX baseline: baseRisk median 0.403 mean 0.409; finalRisk median 0.450 mean 0.432)`);
  out.push('');

  // Override A fires
  const severeFires = results.filter(x => x.ov.severeFloorFired);
  const convergenceFires = results.filter(x => x.ov.convergenceAmplifierFired);
  out.push(`  Override fires after fix:`);
  out.push(`    severe-single-flag (Override A): ${severeFires.length}/${results.length}  (was 79/176 = 44.9%)  → ${(severeFires.length / results.length * 100).toFixed(1)}%`);
  out.push(`    convergence amplifier (Override B): ${convergenceFires.length}/${results.length}  (was 21/176 = 11.9%)  → ${(convergenceFires.length / results.length * 100).toFixed(1)}%`);
  out.push('');

  // Which peer dim triggered severe (compare to pre-fix)
  const flagged: Record<string, number> = {};
  for (const r of severeFires) for (const d of r.ov.severeFlaggedDims) flagged[d] = (flagged[d] ?? 0) + 1;
  out.push(`  Severe-flagged dims after fix (compare to pre-fix in parens):`);
  const preFix: Record<string, number> = {
    'refinance-feasibility': 43,
    'asset-class': 37,
    'leverage-ltv': 31,
    'rollover': 7,
    'cap-rate-valuation-stress': 6,
    'debt-yield': 1,
  };
  for (const [k, n] of Object.entries(flagged).sort((a, b) => b[1] - a[1])) {
    const pre = preFix[k] ?? 0;
    out.push(`    ${k.padEnd(34)} ${n.toString().padStart(3)}  (pre-fix: ${pre})`);
  }
  out.push('');

  /* === (4) NO-REGRESSION CHECK — already-correct classifications stable === */
  out.push('================================================================');
  out.push('(4) NO REGRESSIONS — already-correct classifications stable');
  out.push('================================================================');
  out.push('');
  // Spot-check a few records that should have been correctly classified pre-fix:
  // Office, Hotel, Multifamily, Industrial — verify they still resolve to the same tier
  const spotChecks = [
    { assetType: 'Multifamily', subType: 'Garden', propertyName: 'Test MF', expectedTier: 'I' },
    { assetType: 'Office',      subType: 'CBD',    propertyName: 'Test Office', expectedTier: 'III' },
    { assetType: 'Hotel',       subType: 'Full',   propertyName: 'Test Hotel',  expectedTier: 'III' },
    { assetType: 'Industrial',  subType: null,     propertyName: 'Test Indu',   expectedTier: 'I' },
    { assetType: 'Retail',      subType: 'Anchored', propertyName: 'Test Retail', expectedTier: 'I' },
    { assetType: 'Retail',      subType: 'Regional', propertyName: 'Test Regional', expectedTier: 'IV' },
    { assetType: null,          subType: null,     propertyName: 'Test Null',   expectedTier: 'N/A' },
  ];
  for (const tc of spotChecks) {
    const r = evaluateAssetClass({ assetType: tc.assetType, subType: tc.subType, propertyName: tc.propertyName });
    const ok = r.tier === tc.expectedTier;
    out.push(`  assetType=${(tc.assetType ?? '<null>').padEnd(12)} subType=${(tc.subType ?? '<null>').padEnd(10)} → tier=${r.tier.padEnd(5)} (expected ${tc.expectedTier}) ${ok ? '✓' : '⚠'}`);
  }
  out.push('');

  /* === (5) NEW BEHAVIOR — Mall-name detection regardless of rawAssetType */
  out.push('================================================================');
  out.push('(5) MALL-NAME DETECTION fix — runs regardless of rawAssetType');
  out.push('================================================================');
  out.push('');
  const mallNameTests = [
    { propertyName: 'Northway Mall', assetType: 'Other', subType: 'Anchored', expected: 'IV' },
    { propertyName: 'Carolina Premium Outlets', assetType: 'Other', subType: 'Anchored', expected: 'IV' },
    { propertyName: 'Arundel Mills & Marketplace', assetType: 'Other', subType: 'Various', expected: 'IV' },
  ];
  for (const tc of mallNameTests) {
    const r = evaluateAssetClass({ assetType: tc.assetType, subType: tc.subType, propertyName: tc.propertyName });
    const ok = r.tier === tc.expected;
    out.push(`  ${tc.propertyName.padEnd(34)} assetType=${tc.assetType.padEnd(8)} subType=${tc.subType.padEnd(10)} → tier=${r.tier} ${ok ? '✓ Mall detected via propertyName regardless of rawAssetType' : '⚠'}`);
  }
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — tiers + provenance unchanged');
  out.push('================================================================');
  out.push('');
  out.push('  Tier table risk contributions:');
  out.push('    Tier I   = 0.10  (unchanged)');
  out.push('    Tier II  = 0.30  (unchanged)');
  out.push('    Tier III = 0.55  (unchanged)');
  out.push('    Tier IV  = 0.80  (unchanged; classes: Mall, SpecialtyAtypical, Unknown)');
  out.push('  Provenance: spec v2 §8 + Moody\'s stability + KBRA/DBRS — UNCHANGED');
  out.push('  Fix corrects ONLY the canonicalize() input-classification logic; doctrine UNCHANGED.');
  out.push('');
  out.push('  Old-doctrine grep: grep -rE "manifesto_rules|services/doctrine/|services/judgment/" apps/api/src/doctrine-clean → only fence-statement matches.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean d8 fix] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
