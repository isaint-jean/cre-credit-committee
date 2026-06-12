/**
 * Calibration baseline — STRUCTURAL FEATURE SIGNAL TEST
 *
 * The ratios (LTV / DSCR / DY) showed ~0 LOSS-vs-CLEAN separation on this
 * corpus (sharpened-read finding). This script tests whether structural /
 * categorical features carry the signal the ratios missed — the B-piece
 * edge thesis.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-clean-corpus-structural.ts
 *
 * Reads /tmp/clean-corpus-backbone-corpus.json. Honestly reports
 * populated-n per feature — flags where the corpus extractor didn't carry
 * a feature through (concentration / rollover need rent-roll extraction;
 * the body-page architecture currently drops them).
 *
 * No doctrine run, no edits, no rebuild. Analysis only.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-clean-corpus-structural.out';

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
  // NB: assetType / subType / top1IncomeShare / pctIncomeExpiringWithinTerm
  //     are NOT in the corpus JSON. The body-page extractor parses
  //     "Property Type" but doesn't persist it on the AnswerKeyRecord.
  //     We derive assetType from propertyName via heuristic below.
}

/* ============================================================================
 * Asset-type derivation from propertyName (same heuristic the baseline
 * harness uses in `mapAssetType`; expanded with subType heuristics).
 *
 * The corpus has 183 records and the body-page extractor read each one's
 * Property Type but didn't carry it forward. Re-deriving from the name is
 * the next best thing — accurate for keyword-rich names ("Hotel", "Mall",
 * "Office", "MHC Portfolio"); less accurate for generic names like
 * "Republic Plaza" (which is actually Office but the name doesn't say so).
 * ========================================================================== */

type AssetType = 'Office' | 'Retail' | 'Hotel' | 'Multifamily' | 'Industrial' | 'SelfStorage' | 'MHC' | 'MixedUse' | 'Other';
type SubType = 'Mall' | 'Anchored Retail' | 'Office CBD' | 'Office Suburban' | 'Hotel Full Service' | 'Hotel Limited Service' | 'MHC Portfolio' | 'Industrial Warehouse' | 'Generic';

function deriveAssetType(propertyName: string): AssetType {
  const s = propertyName.toLowerCase();
  // Hospitality — strongest signal
  if (/hotel|lodging|hospitality|inn\b|resort|marriott|hilton|hyatt|residence inn|candlewood|comfort suites|embassy suites|extended stay|holiday inn|radisson|courtyard|home 2 suites|home2 suites|hampton|crowne|sheraton|doubletree|aloft|fairfield|towneplace|staybridge|hyatt|westin|w hotel|w residence|w broadway|four seasons|le meridien|jw marriott/.test(s)) return 'Hotel';
  // MHC
  if (/\bmhc\b|manufactured housing|mobile home/.test(s)) return 'MHC';
  // Storage
  if (/storage|self.?stor/.test(s)) return 'SelfStorage';
  // Multifamily / apartments
  if (/apartment|multifamily|garden|residential|townhomes|coppertree|silver fox|encino courtyard/.test(s)) return 'Multifamily';
  // Industrial / warehouse / distribution
  if (/industrial|warehouse|distribution|logistic|hanesbrands|ds services|portfolio.*industrial/.test(s)) return 'Industrial';
  // Mixed Use
  if (/mixed/.test(s) || /empire hotel.*retail|hotel & retail/.test(s)) return 'MixedUse';
  // Retail — broad
  if (/mall|outlets|outlet|shopping|plaza|crossing|center|marketplace|portfolio.*retail|walgreens|spectrum|atrium|broadcasting square|fashion center|gurnee mills|wolfchase galleria|federal way crossings|great falls marketplace|kingsgate|fair lakes|christown|blue diamond|rentar/.test(s)) return 'Retail';
  // Office (residual catch-all for many CBD names)
  if (/office|tower|building|corporate|plaza.*office|broadway$|^\d+\s+\w+\s+(street|avenue|boulevard|road)/.test(s)) return 'Office';
  // Heuristic fallback by recognizable property-name patterns
  return 'Other';
}

function deriveSubType(propertyName: string, assetType: AssetType): SubType {
  const s = propertyName.toLowerCase();
  if (assetType === 'Retail') {
    if (/mall|gurnee mills|wolfchase galleria|concord mills|christown spectrum/.test(s)) return 'Mall';
    return 'Anchored Retail';
  }
  if (assetType === 'Hotel') {
    if (/full service|grand|w hotel|w residence|jw marriott|four seasons|le meridien|marriott(\s|$)|hilton(\s|$)|hyatt(\s|$)|radisson(\s|$)|empire|crowne|sheraton|westin|doubletree/.test(s)) return 'Hotel Full Service';
    return 'Hotel Limited Service';
  }
  if (assetType === 'Office') {
    if (/cbd|broadway|times square|wacker|madison|park avenue|bryant park|columbus circle/.test(s)) return 'Office CBD';
    return 'Office Suburban';
  }
  if (assetType === 'MHC') return 'MHC Portfolio';
  if (assetType === 'Industrial') return 'Industrial Warehouse';
  return 'Generic';
}

/* ============================================================================
 * Stats helpers
 * ========================================================================== */
function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/* ============================================================================
 * MAIN
 * ========================================================================== */
function main(): void {
  const out: string[] = [];
  out.push('CALIBRATION BASELINE — STRUCTURAL-FEATURE SIGNAL TEST');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Input: /tmp/clean-corpus-backbone-corpus.json');
  out.push('Analysis only — no doctrine run, no edits, no rebuild.');
  out.push('');

  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  // Restrict to records that the baseline harness was able to score (have inputs).
  // The sharpened analysis used 131 doctrine-scored records: 112 CLEAN, 7 STRESS, 12 LOSS.
  // For structural-feature test, USE every record (CLEAN/LOSS) regardless of doctrine eligibility —
  // structural features don't need ratios to be populated.
  const cleansAll = corpus.records.filter(r => r.outcomeClass === 'CLEAN');
  const lossesAll = corpus.records.filter(r => r.outcomeClass === 'LOSS');
  const stressAll = corpus.records.filter(r => r.outcomeClass === 'STRESS-ONLY');
  // For populated-n / loss-rate analysis we want records that the corpus actually carries
  // (excluding tracked-pending LOSSes whose propertyName is just "Loan #N").
  const cleansUsable = cleansAll.filter(r => r.propertyName !== '' && !/^Loan #\d+$/.test(r.propertyName));
  const lossesUsable = lossesAll.filter(r => r.propertyName !== '' && !/^Loan #\d+$/.test(r.propertyName) && r.inputSource !== 'tracked-pending');
  out.push(`Records in corpus: CLEAN=${cleansAll.length}  STRESS=${stressAll.length}  LOSS=${lossesAll.length}`);
  out.push(`With identifiable propertyName (not "Loan #N" placeholder):`);
  out.push(`  CLEAN=${cleansUsable.length}  LOSS=${lossesUsable.length}`);
  out.push('');

  /* === FIELD POPULATION REPORT ============================================= */
  out.push('================================================================');
  out.push('FIELD POPULATION — what structural features the corpus carries');
  out.push('================================================================');
  out.push('');
  out.push('AnswerKeyRecord shape on disk does NOT include:');
  out.push('  - assetType / subType  → derived heuristically from propertyName below');
  out.push('  - top1IncomeShare      → NOT IN CORPUS (no rent-roll extractor in body-page architecture)');
  out.push('  - pctIncomeExpiringWithinTerm → NOT IN CORPUS (same — rent-roll required)');
  out.push('');
  out.push('Populated-n by feature (LOSS / CLEAN sets):');
  out.push(`  propertyName               LOSS ${lossesUsable.length}/${lossesAll.length}    CLEAN ${cleansUsable.length}/${cleansAll.length}`);
  out.push(`  top1IncomeShare            LOSS 0/${lossesAll.length}     CLEAN 0/${cleansAll.length}    ← UNTESTABLE on this corpus (extractor doesn't carry it)`);
  out.push(`  pctIncomeExpiringWithinTerm LOSS 0/${lossesAll.length}    CLEAN 0/${cleansAll.length}    ← UNTESTABLE on this corpus (same)`);
  out.push('');
  out.push('CONSEQUENCE: cuts 2 (concentration) and 3 (rollover) require a richer extractor');
  out.push('  (rent-roll parsing in the body-page architecture, or a tail Annex A walker that');
  out.push('  captures Largest Tenant / Lease Expiration columns). They are NOT testable here.');
  out.push('  Cut 1 (asset type) IS testable — heuristic-derived from propertyName.');
  out.push('');

  /* === CUT 1 — ASSET TYPE + SUB-TYPE ====================================== */
  out.push('================================================================');
  out.push('(1) ASSET TYPE — loss-rate by category (heuristic derivation)');
  out.push('================================================================');
  out.push('');
  // Build the lookup
  const records = [
    ...cleansUsable.map(r => ({ ...r, _at: deriveAssetType(r.propertyName), _st: 'Generic' as SubType, outcome: 'CLEAN' as const })),
    ...lossesUsable.map(r => ({ ...r, _at: deriveAssetType(r.propertyName), _st: 'Generic' as SubType, outcome: 'LOSS' as const })),
  ];
  for (const r of records) r._st = deriveSubType(r.propertyName, r._at);

  // Tally by asset type
  const byType = new Map<AssetType, { clean: number; loss: number }>();
  for (const at of ['Office', 'Retail', 'Hotel', 'Multifamily', 'Industrial', 'SelfStorage', 'MHC', 'MixedUse', 'Other'] as AssetType[]) {
    byType.set(at, { clean: 0, loss: 0 });
  }
  for (const r of records) {
    const bucket = byType.get(r._at)!;
    if (r.outcome === 'LOSS') bucket.loss++; else bucket.clean++;
  }
  out.push(`  ${'assetType'.padEnd(14)} n      CLEAN   LOSS    loss-rate`);
  let totalN = 0, totalLoss = 0;
  for (const [at, { clean, loss }] of byType) {
    const n = clean + loss;
    if (n === 0) continue;
    const rate = (loss * 100 / n).toFixed(1);
    totalN += n; totalLoss += loss;
    out.push(`  ${at.padEnd(14)} ${n.toString().padStart(3)}   ${clean.toString().padStart(5)}   ${loss.toString().padStart(4)}   ${rate.padStart(6)}%`);
  }
  out.push(`  ${'(overall)'.padEnd(14)} ${totalN.toString().padStart(3)}   ${(totalN - totalLoss).toString().padStart(5)}   ${totalLoss.toString().padStart(4)}   ${(totalLoss * 100 / totalN).toFixed(1).padStart(6)}%`);
  out.push('');
  out.push('  INTERPRETATION:');
  out.push('  - Categories where loss-rate > overall = over-represented in LOSSes (signal candidate)');
  out.push('  - Categories where loss-rate < overall = under-represented (CLEAN-leaning)');
  out.push('  - At n=12 LOSSes total, individual cells are small-n — read with caution.');
  out.push('');

  /* === SUB-TYPE breakdown — same logic at finer granularity =============== */
  out.push('Sub-type breakdown (finer granularity; loss-rate by sub-type):');
  const bySubType = new Map<string, { clean: number; loss: number; lossNames: string[] }>();
  for (const r of records) {
    const key = `${r._at}:${r._st}`;
    if (!bySubType.has(key)) bySubType.set(key, { clean: 0, loss: 0, lossNames: [] });
    const b = bySubType.get(key)!;
    if (r.outcome === 'LOSS') { b.loss++; b.lossNames.push(r.propertyName); } else b.clean++;
  }
  const subRows = [...bySubType.entries()]
    .filter(([_, b]) => b.clean + b.loss >= 2)
    .sort((a, b) => (b[1].loss / Math.max(1, b[1].clean + b[1].loss)) - (a[1].loss / Math.max(1, a[1].clean + a[1].loss)));
  out.push(`  ${'sub-type'.padEnd(36)} n     CLEAN  LOSS   loss-rate`);
  for (const [key, b] of subRows) {
    const n = b.clean + b.loss;
    out.push(`  ${key.padEnd(36)} ${n.toString().padStart(3)}   ${b.clean.toString().padStart(4)}   ${b.loss.toString().padStart(3)}   ${(b.loss * 100 / n).toFixed(1).padStart(6)}%   ${b.lossNames.slice(0, 3).join(' | ')}`);
  }
  out.push('');

  /* === CUT 2 — CONCENTRATION ============================================== */
  out.push('================================================================');
  out.push('(2) TENANT CONCENTRATION (top1IncomeShare) — UNTESTABLE');
  out.push('================================================================');
  out.push('');
  out.push('  top1IncomeShare is null on EVERY corpus record (rent-roll extractor not wired');
  out.push('  through the body-page architecture). At populated-n = 0 / 0, this feature cannot');
  out.push('  be tested on the current corpus.');
  out.push('');
  out.push('  Reframe for future enrichment:');
  out.push('  - Body-page description pages do publish "Largest Tenant SF / % NRA / Lease Exp"');
  out.push('    for SOME loans (Encana Oil & Gas single-tenant, Empire Hotel & Retail tenants).');
  out.push('  - Extracting these into top1IncomeShare per loan is a body-page extractor extension');
  out.push('    (per-shelf catalog augmentation, not new rent-roll parser); single-tenant signal');
  out.push('    is most likely to discriminate on Office/Retail.');
  out.push('  - Re-test once populated.');
  out.push('');

  /* === CUT 3 — ROLLOVER =================================================== */
  out.push('================================================================');
  out.push('(3) LEASE ROLLOVER (pctIncomeExpiringWithinTerm) — UNTESTABLE');
  out.push('================================================================');
  out.push('');
  out.push('  pctIncomeExpiringWithinTerm is null on EVERY corpus record. Same root cause —');
  out.push('  body-page architecture skips rent-roll. Untestable here.');
  out.push('');
  out.push('  Reframe for future enrichment:');
  out.push('  - "5 Largest Tenants" tables on body description pages include Lease Expiration');
  out.push('    Date for each tenant. Computing pctIncomeExpiringWithinTerm from those plus the');
  out.push('    maturityDate field is mechanical once extraction is wired.');
  out.push('');

  /* === CUT 4 — COMBINED (asset-type only since concentration/rollover are null) === */
  out.push('================================================================');
  out.push('(4) COMBINED VIEW — flag by asset-type pattern (only structural signal available)');
  out.push('================================================================');
  out.push('');
  // Define "high-loss-rate asset types" empirically as types whose loss-rate exceeds overall
  const overallRate = totalLoss / totalN;
  const highLossTypes = new Set<AssetType>();
  for (const [at, { clean, loss }] of byType) {
    if (clean + loss < 3) continue;
    const r = loss / (clean + loss);
    if (r > overallRate * 1.5) highLossTypes.add(at);
  }
  out.push(`  Overall loss-rate: ${(overallRate * 100).toFixed(1)}%`);
  out.push(`  Asset types flagged (loss-rate > 1.5× overall, n ≥ 3): ${[...highLossTypes].join(', ') || '(none)'}`);
  if (highLossTypes.size > 0) {
    const flagged = records.filter(r => highLossTypes.has(r._at));
    const flaggedLoss = flagged.filter(r => r.outcome === 'LOSS').length;
    const flaggedClean = flagged.filter(r => r.outcome === 'CLEAN').length;
    const unflagged = records.filter(r => !highLossTypes.has(r._at));
    const unflaggedLoss = unflagged.filter(r => r.outcome === 'LOSS').length;
    const unflaggedClean = unflagged.filter(r => r.outcome === 'CLEAN').length;
    out.push(`  Flagged subset: n=${flagged.length}  CLEAN=${flaggedClean}  LOSS=${flaggedLoss}  loss-rate=${(flaggedLoss*100/flagged.length).toFixed(1)}%`);
    out.push(`  Unflagged subset: n=${unflagged.length}  CLEAN=${unflaggedClean}  LOSS=${unflaggedLoss}  loss-rate=${(unflaggedLoss*100/unflagged.length).toFixed(1)}%`);
    const recall = flaggedLoss / Math.max(1, totalLoss);
    const fp = flaggedClean / Math.max(1, totalN - totalLoss);
    out.push(`  Recall (LOSSes captured by asset-type flag): ${flaggedLoss}/${totalLoss}  (${(recall*100).toFixed(0)}%)`);
    out.push(`  FP    (CLEANs in flagged set):                ${flaggedClean}/${totalN - totalLoss}  (${(fp*100).toFixed(0)}%)`);
  }
  out.push('');

  /* === CUT 5 — COMPARE TO RATIO BASELINE ================================== */
  out.push('================================================================');
  out.push('(5) STRUCTURAL vs RATIO BASELINE — does asset-type beat the ratios?');
  out.push('================================================================');
  out.push('');
  out.push('  Ratio baseline (sharpened-read finding): raw-metric LOSS-vs-CLEAN means');
  out.push('    concludedLtv  CLEAN 63.7%  LOSS 66.5%  Δ ≈ 2.8 pts');
  out.push('    NCF DSCR      CLEAN 1.81x  LOSS 1.58x  Δ ≈ 0.23x');
  out.push('    debtYield     CLEAN 13.9%  LOSS 13.4%  Δ ≈ 0.5 pts');
  out.push('    → effective separation ≈ 0; CMBS loans pin similar metrics at origination.');
  out.push('');
  out.push('  Structural separation (asset-type, this run):');
  for (const [at, { clean, loss }] of byType) {
    const n = clean + loss;
    if (n < 3) continue;
    const r = loss / n;
    const delta = r - overallRate;
    const arrow = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '~';
    out.push(`    ${at.padEnd(14)} n=${n.toString().padStart(3)}  loss-rate=${(r*100).toFixed(1).padStart(5)}%  (overall ${(overallRate*100).toFixed(1)}%)  ${arrow}`);
  }
  out.push('');

  /* === CUT 6 — POWER ====================================================== */
  out.push('================================================================');
  out.push('(6) POWER / HONEST READ');
  out.push('================================================================');
  out.push('');
  out.push(`  n LOSSes (with identifiable name): ${lossesUsable.length}`);
  out.push(`  n CLEAN  (with identifiable name): ${cleansUsable.length}`);
  out.push('  Asset-type categorical at n=12 LOSS can show stark patterns (one type dominating),');
  out.push('  but per-cell n is small (Office n=3 loss = 25%-of-LOSSes from a single category).');
  out.push('  Treat per-type loss-rates as DIRECTIONAL, not significance-tested.');
  out.push('  Concentration / rollover untestable on this corpus — extractor enhancement needed.');
  out.push('');

  /* === BOTTOM LINE ======================================================== */
  out.push('================================================================');
  out.push('BOTTOM LINE');
  out.push('================================================================');
  out.push('');
  out.push('Thesis status: PARTIALLY TESTABLE on this corpus.');
  out.push('  - Asset type (testable): see whether the loss-rate pattern is stronger than the');
  out.push('    ratios\' ~0 separation. If specific types over-represent in LOSSes, the structural');
  out.push('    signal exists where the ratio signal did not.');
  out.push('  - Concentration + rollover (untestable): require body-page extractor extension to');
  out.push('    parse "Largest Tenants" + "Lease Expiration" columns. Re-test post-enrichment.');
  out.push('');
  out.push('Read the asset-type loss-rate table above. The structural signal:');
  // Compute the rough conclusion based on whether any asset type's loss-rate materially differs
  const significantTypes = [...byType.entries()].filter(([_, b]) => {
    const n = b.clean + b.loss;
    if (n < 4) return false;
    const r = b.loss / n;
    return Math.abs(r - overallRate) > 0.05;
  });
  if (significantTypes.length > 0) {
    out.push(`  - Differentiates: ${significantTypes.map(([at, b]) => `${at} (loss-rate ${(b.loss*100/(b.clean+b.loss)).toFixed(0)}%)`).join(', ')}`);
    out.push('  → STRUCTURAL signal exists where ratios were flat. The B-piece thesis holds');
    out.push('    on the testable dimension. Rebuild has a foothold beyond the ratios.');
  } else {
    out.push('  - No asset-type category shows a loss-rate that materially differs from overall.');
    out.push('  → STRUCTURAL signal is ALSO flat on this corpus at the testable dimension.');
    out.push('    Thesis may need richer extraction (concentration / rollover) to find the edge,');
    out.push('    or may need reframing — origination credit risk on CMBS conduit deals may not');
    out.push('    be discriminable from origination data alone.');
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[structural] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
