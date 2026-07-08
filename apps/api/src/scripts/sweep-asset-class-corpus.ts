/**
 * scripts/sweep-asset-class-corpus.ts
 *
 * FREE, NO-LLM, READ-ONLY asset-class validation sweep.
 *
 * Feeds the 889-comp EX-102 corpus (data/comps/comps.db) through the
 * DETERMINISTIC scorer evaluateDeal() — grouped by asset class — and shows
 * the per-class doctrine logic firing on REAL loan-level data (real value /
 * NOI / NCF / DSCR / cap-rate / loan piece).
 *
 * SCOPE / SAFETY:
 *   - READ-ONLY over comps.db (opened SQLITE_OPEN_READONLY). NEVER writes it.
 *   - NEVER touches cre.db. NEVER calls an LLM. Pure function evaluateDeal().
 *   - No writes anywhere; prints a report to stdout (+ optional --json).
 *
 * MAPPING (EX-102 field -> evaluateDeal DealBag input):
 *   propertyType     -> assetType     (label remap; see CORPUS_TO_ASSET_TYPE)
 *   propertyTypeCodeRaw / subtype -> subType (Office CBD split etc.)
 *   value            -> concludedValue (source 'extracted-annex-a' — issuer's
 *                        prospectus-disclosed EX-102 valuation; the dim treats
 *                        this as a lower-confidence comparator, NOT a penalty)
 *   noi              -> uwY1Noi        (issuer NOI; drives the sustainable
 *                        cash-flow spine + cap-rate stress numerator)
 *   (no t12)         -> t12Noi = null  (EX-102 has one NOI period; no divergence
 *                        haircut is possible — HONEST, not a failure)
 *   loanPieceAmount  -> loanAmount     (★ PARI-PASSU CAVEAT: EX-102's loan
 *                        amount is the TRUST PIECE, not the whole loan; DY / LTV
 *                        computed here are PIECE-BASED and read structurally low.
 *                        Absolute levels are unreliable; the ASSET-CLASS FLOOR
 *                        DIFFERENTIATION they exercise is still valid — same
 *                        piece basis across all classes, so relative floors show.)
 *   interestRate     -> coupon         (exercises DSCR / refinance)
 *   occupancyPct     -> underwrittenOccupancy (★ exercises the DBRS stabilized-
 *                        vacancy-floor differentiation — the self-storage-vs-office
 *                        tell; hotel -> RevPAR/null path)
 *   -- NOT exercisable from EX-102 (no full tenant roster / no lease-expiry vs
 *      maturity): largestTenantPct, pctIncomeExpiringWithinTerm -> null; the
 *      concentration + rollover dims route to N/A-by-asset-type or HITL honestly.
 *
 * Run:  tsx src/scripts/sweep-asset-class-corpus.ts [--json out.json]
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { evaluateDeal, type DealBag } from '../doctrine-clean/scoring/evaluate-deal.js';

const COMPS_DB = resolve(process.cwd(), '../../data/comps/comps.db');

/** EX-102 propertyType label -> scorer canonical assetType string. */
const CORPUS_TO_ASSET_TYPE: Readonly<Record<string, string>> = {
  Multifamily: 'Multifamily',
  Retail: 'Retail',            // dim canonicalizes -> UnanchoredRetail (conservative)
  Industrial: 'Industrial',
  'Self-Storage': 'SelfStorage',
  Lodging: 'Hotel',
  'Mixed-Use': 'MixedUse',
  Office: 'Office',
  // 'Other' + 'Health-Care' deliberately absent -> route via subtype / null.
};

interface CompRow {
  cik: string; assetNumber: string;
  propertyName: string | null;
  propertyType: string | null; propertyTypeCodeRaw: string | null;
  value: number | null; noi: number | null; ncf: number | null;
  dscr: number | null; capRate: number | null;
  loanPieceAmount: number | null; ltvPiece: number | null;
  interestRate: number | null; occupancyPct: number | null;
}

/** Best-effort subType from the raw property-type code (Office CBD split etc.). */
function subTypeFor(row: CompRow): string | null {
  const raw = (row.propertyTypeCodeRaw ?? '').trim();
  if (raw === '' || /^\d+$/.test(raw)) return null;
  // 'CH' is a code the corpus uses under 'Other'; no clean class signal.
  if (raw === 'CH') return null;
  return raw;
}

/** Map an EX-102 assetType label to the scorer input; null when unmappable. */
function mapAssetType(row: CompRow): string | null {
  if (row.propertyType === null) return null;
  return CORPUS_TO_ASSET_TYPE[row.propertyType] ?? null;
}

function buildDealBag(row: CompRow, assetType: string | null): DealBag {
  return {
    propertyName: row.propertyName,
    assetType,
    subType: subTypeFor(row),
    loanAmount: row.loanPieceAmount,      // PARI-PASSU: trust piece, not whole loan
    coupon: row.interestRate,
    concludedValue: row.value,
    concludedValueSource: 'extracted-annex-a',  // prospectus-disclosed EX-102 value
    uwY1Noi: row.noi,
    t12Noi: null,                          // EX-102 has one NOI period
    underwrittenOccupancy: row.occupancyPct,   // exercises the vacancy floor tell
    // EX-102 carries only a single top-tenant name+SF, no full roster / no
    // lease-expiry-vs-maturity — concentration + rollover cannot be exercised.
    largestTenantPct: null,
    largestTenantBasis: 'unknown',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: null,
    amortMonths: null,
    ioYears: null,
    termYears: null,
    marketTier: 'Unknown',
  };
}

/* ------------------------------- stats helpers ---------------------------- */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; }
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return quantile(s, 0.5); }
function fmt(x: number, d = 1): string { return Number.isFinite(x) ? x.toFixed(d) : 'n/a'; }

/* --------------------------------- sweep ---------------------------------- */
interface CompResult {
  assetTypeInput: string | null;
  finalScore: number | null;          // (1 - ratedRisk) * 100
  ratedRisk: number | null;
  band: string | null;
  recommendation: string;
  // dim tells
  stressedCapGoingIn: number | null;  // decimal
  vacancyStatus: string;              // from normalization haircutTrace.vacancy
  vacancyFloor: number | null;        // stabilizedFloorVacancy used (decimal)
  ncfNoiRatio: number | null;
  debtYield: number | null;           // decimal (piece-based)
  dyFloor: number | null;             // decimal
  dyTier: string | null;
  assetClassTier: string;             // I..IV / N/A
  assetClassRisk: number | null;
  rolloverApplicability: string;
  concentrationApplicability: string;
  capRateTier: string;                // valuation-aggressiveness band
  capRateRisk: number | null;
  // per-signal weighted contributions (base-blend)
  weighted: Record<string, number>;  // signalId -> weightedRisk
  severeFloorFired: boolean;
  convergenceFired: boolean;
}

function runOne(row: CompRow): CompResult | null {
  const assetType = mapAssetType(row);
  const bag = buildDealBag(row, assetType);
  const r = evaluateDeal(bag);

  const norm = r.normalization;
  const cap = r.dimensions.capRateValuationStress;
  const dy = r.dimensions.debtYield;
  const ac = r.dimensions.assetClass;

  const weighted: Record<string, number> = {};
  for (const wc of r.baseBlend.weightedContributions) weighted[wc.signalId] = wc.weightedRisk;

  return {
    assetTypeInput: assetType,
    finalScore: r.rating.ratedRisk === null ? null : (1 - r.rating.ratedRisk) * 100,
    ratedRisk: r.rating.ratedRisk,
    band: r.rating.band,
    recommendation: r.rating.recommendation,
    stressedCapGoingIn: (cap.derivedOutputs?.stressedCapRateGoingIn as number | null) ?? null,
    vacancyStatus: norm.haircutTrace.vacancy.status,
    vacancyFloor: norm.haircutTrace.vacancy.stabilizedFloorVacancy,
    ncfNoiRatio: norm.haircutTrace.ncfCapital.ncfNoiRatio,
    debtYield: (dy.derivedOutputs?.debtYield as number | null) ?? null,
    dyFloor: (dy.derivedOutputs?.assetFloorDecimal as number | null) ?? null,
    dyTier: typeof dy.tier === 'string' ? dy.tier : null,
    assetClassTier: typeof ac.tier === 'string' ? ac.tier : 'N/A',
    assetClassRisk: ac.riskContribution,
    rolloverApplicability: r.dimensions.rollover.applicability,
    concentrationApplicability: r.dimensions.incomeConcentration.applicability,
    capRateTier: typeof cap.tier === 'string' ? cap.tier : 'N/A',
    capRateRisk: cap.riskContribution,
    weighted,
    severeFloorFired: r.overrides.severeFloorFired,
    convergenceFired: r.overrides.convergenceAmplifierFired,
  };
}

function main() {
  const jsonOutIdx = process.argv.indexOf('--json');
  const jsonOut = jsonOutIdx >= 0 ? process.argv[jsonOutIdx + 1] : null;

  const db = new Database(COMPS_DB, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT cik, assetNumber, propertyName, propertyType, propertyTypeCodeRaw,
           value, noi, ncf, dscr, capRate, loanPieceAmount, ltvPiece,
           interestRate, occupancyPct
    FROM comps
  `).all() as CompRow[];
  db.close();

  const total = rows.length;
  const skipped: { reason: string; n: number }[] = [];
  const skipReasons = new Map<string, number>();
  const bump = (r: string) => skipReasons.set(r, (skipReasons.get(r) ?? 0) + 1);

  // Group results by the corpus propertyType label (the reporting axis).
  const byGroup = new Map<string, CompResult[]>();
  let scored = 0;

  for (const row of rows) {
    // Require the three cap-rate-spine drivers (value + noi + loan) positive so
    // the spine resolves; without them the record is InsufficientData anyway.
    if (row.noi === null || row.value === null || row.loanPieceAmount === null) { bump('missing noi/value/loanPiece'); continue; }
    if (row.noi <= 0 || row.value <= 0 || row.loanPieceAmount <= 0) { bump('non-positive noi/value/loanPiece'); continue; }
    const res = runOne(row);
    if (res === null) { bump('runtime-null'); continue; }
    scored++;
    const grp = row.propertyType ?? 'null';
    if (!byGroup.has(grp)) byGroup.set(grp, []);
    byGroup.get(grp)!.push(res);
  }
  for (const [reason, n] of skipReasons) skipped.push({ reason, n });

  /* ---------------------------- REPORT ---------------------------- */
  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p('='.repeat(78));
  p('ASSET-CLASS CORPUS SWEEP — evaluateDeal() over the EX-102 corpus (READ-ONLY)');
  p('='.repeat(78));
  p(`corpus: ${COMPS_DB}`);
  p(`total rows: ${total}   scored: ${scored}   skipped: ${total - scored}`);
  p('skipped breakdown:');
  for (const s of skipped) p(`   - ${s.reason}: ${s.n}`);
  p();

  // ------ (1) score distribution per class ------
  p('-'.repeat(78));
  p('(1) SCORE DISTRIBUTION PER CLASS  [finalScore = (1 - ratedRisk) * 100]');
  p('-'.repeat(78));
  p('class            n   scored  min   med   mean  max    | band spread (Str/Acc/Wat/Ele/Dec/InsuffData)');
  const groupOrder = [...byGroup.keys()].sort((a, b) => byGroup.get(b)!.length - byGroup.get(a)!.length);
  for (const g of groupOrder) {
    const list = byGroup.get(g)!;
    const scores = list.map(r => r.finalScore).filter((x): x is number => x !== null);
    const s = [...scores].sort((a, b) => a - b);
    const bands = { Strong: 0, Acceptable: 0, Watch: 0, Elevated: 0, Decline: 0, InsuffData: 0 };
    for (const r of list) {
      if (r.recommendation === 'InsufficientData') bands.InsuffData++;
      else if (r.band) (bands as Record<string, number>)[r.band]++;
    }
    p(
      `${g.padEnd(15)} ${String(list.length).padStart(3)}  ${String(scores.length).padStart(5)}  ` +
      `${fmt(s[0] ?? NaN)}  ${fmt(median(scores))}  ${fmt(mean(scores))}  ${fmt(s[s.length - 1] ?? NaN)}   | ` +
      `${bands.Strong}/${bands.Acceptable}/${bands.Watch}/${bands.Elevated}/${bands.Decline}/${bands.InsuffData}`,
    );
  }
  p();

  // ------ (2) which dims drive each class (mean weighted contribution) ------
  p('-'.repeat(78));
  p('(2) DIMENSION DRIVERS PER CLASS — mean weighted risk contribution per signal');
  p('    (base-blend post-collapse signals; higher = pushes score down)');
  p('-'.repeat(78));
  const signalIds = ['cap-rate-valuation-stress', 'refinance-feasibility', 'asset-class', 'rollover', 'income-concentration', 'ratio-family'];
  p('class            ' + signalIds.map(s => s.split('-')[0].padStart(9)).join(' '));
  for (const g of groupOrder) {
    const list = byGroup.get(g)!.filter(r => r.recommendation !== 'InsufficientData');
    if (list.length === 0) { p(`${g.padEnd(15)} (all InsufficientData)`); continue; }
    const cells = signalIds.map(sig => {
      const vals = list.map(r => r.weighted[sig]).filter((x): x is number => x !== undefined);
      return fmt(mean(vals), 3).padStart(9);
    });
    p(`${g.padEnd(15)} ${cells.join(' ')}`);
  }
  p();

  // ------ (3) differentiation TELLS ------
  p('-'.repeat(78));
  p('(3) DIFFERENTIATION TELLS — the per-class tables MANIFESTING (with numbers)');
  p('-'.repeat(78));

  // 3a. cap-rate going-in floor + NCF/NOI ratio + DY floor per class (applied values)
  p('3a. Applied per-class FLOORS (from a representative scored record each):');
  p('class            capGoingIn  ncf/noi  dyFloor  vacancyFloor  vacancyStatus');
  for (const g of groupOrder) {
    const list = byGroup.get(g)!.filter(r => r.recommendation !== 'InsufficientData');
    if (list.length === 0) { p(`${g.padEnd(15)} (all InsufficientData)`); continue; }
    // pick modal applied floor set (they're class-constant, so first is fine)
    const r = list[0];
    p(
      `${g.padEnd(15)} ${(r.stressedCapGoingIn !== null ? (r.stressedCapGoingIn * 100).toFixed(2) + '%' : 'n/a').padStart(9)}  ` +
      `${(r.ncfNoiRatio !== null ? r.ncfNoiRatio.toFixed(3) : 'n/a').padStart(6)}  ` +
      `${(r.dyFloor !== null ? (r.dyFloor * 100).toFixed(1) + '%' : 'n/a').padStart(6)}  ` +
      `${(r.vacancyFloor !== null ? (r.vacancyFloor * 100).toFixed(0) + '%' : 'null').padStart(11)}  ` +
      `${r.vacancyStatus}`,
    );
  }
  p();
  p('   TELL — self-storage floors differ from office: SelfStorage cap-floor 7.75%,');
  p('   DY-floor 8.5%, vacancy-floor 13%, NCF/NOI 0.97  vs  Office cap-floor 9.00%,');
  p('   DY-floor 9.0%, vacancy-floor 10%, NCF/NOI 0.89. (Verify against the rows above.)');
  p('   TELL — Hotel (Lodging) vacancyFloor = null -> "asset-not-vacancy-based"');
  p('   (RevPAR basis), no vacancy number applied. (Verify Lodging row above.)');
  p();

  // 3b. rollover + concentration applicability per class
  p('3b. Rollover + Concentration APPLICABILITY per class (do they fire when they should?):');
  p('class            rollover-applicability          concentration-applicability');
  for (const g of groupOrder) {
    const list = byGroup.get(g)!;
    const rollCounts = new Map<string, number>();
    const concCounts = new Map<string, number>();
    for (const r of list) {
      rollCounts.set(r.rolloverApplicability, (rollCounts.get(r.rolloverApplicability) ?? 0) + 1);
      concCounts.set(r.concentrationApplicability, (concCounts.get(r.concentrationApplicability) ?? 0) + 1);
    }
    const modal = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(',');
    p(`${g.padEnd(15)} ${modal(rollCounts).padEnd(31)} ${modal(concCounts)}`);
  }
  p();
  p('   TELL — MF / Hotel / SelfStorage rollover + concentration = not-applicable-by-asset-type');
  p('   (silent, correctly). Retail/Office/Industrial/MixedUse: rollover + concentration');
  p('   route to HITL here because EX-102 carries NO tenant roster / lease-expiry (honest');
  p('   coverage gap, not a fire). Rollover FIRING (a real band) requires the roster the');
  p('   corpus lacks — flagged as an EX-102 data limit, not a doctrine failure.');
  p();

  // 3c. asset-class tier per class
  p('3c. Asset-class TIER assigned per class (dim 8 table manifesting):');
  p('class            tier(s)  risk');
  for (const g of groupOrder) {
    const list = byGroup.get(g)!;
    const tierCounts = new Map<string, number>();
    for (const r of list) tierCounts.set(`${r.assetClassTier}:${r.assetClassRisk}`, (tierCounts.get(`${r.assetClassTier}:${r.assetClassRisk}`) ?? 0) + 1);
    const modal = [...tierCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(', ');
    p(`${g.padEnd(15)} ${modal}`);
  }
  p();

  // ------ (4) anomalies ------
  p('-'.repeat(78));
  p('(4) ANOMALIES (flagged honestly)');
  p('-'.repeat(78));
  const anomalies: string[] = [];

  // (a) InsufficientData rate per class. For MAPPABLE classes this would be a
  //     defect; for UNMAPPABLE labels (Other / Health-Care -> assetType null)
  //     it is the coverage-gap-not-risk doctrine working AS DESIGNED: a null
  //     assetType routes the valuation spine (dim 7) to HITL -> the deal cannot
  //     be scored without a class, and is flagged InsufficientData rather than
  //     bucketed to a risk tier. Distinguish the two.
  const MAPPABLE = new Set(Object.keys(CORPUS_TO_ASSET_TYPE));
  for (const g of groupOrder) {
    const list = byGroup.get(g)!;
    const insuff = list.filter(r => r.recommendation === 'InsufficientData').length;
    if (insuff === 0) continue;
    if (MAPPABLE.has(g)) {
      anomalies.push(`${g} (MAPPABLE class): ${insuff}/${list.length} InsufficientData — UNEXPECTED for a mappable class; inspect the coverage gate (spine should resolve when value+noi+loan present).`);
    } else {
      p(`  (expected) ${g}: ${insuff}/${list.length} InsufficientData — label does not map to a canonical asset class (assetType null) -> valuation spine (dim 7) HITL -> coverage-gap-not-risk doctrine flags InsufficientData rather than inventing a tier. CORRECT behavior.`);
    }
  }
  // (b) a class where cap going-in floor looks like it leaked from another class
  //     (each corpus label should map to exactly one applied cap-floor family)
  for (const g of groupOrder) {
    const list = byGroup.get(g)!.filter(r => r.recommendation !== 'InsufficientData');
    const floors = new Set(list.map(r => r.stressedCapGoingIn).filter(x => x !== null).map(x => (x! * 100).toFixed(2)));
    if (floors.size > 1) anomalies.push(`${g}: multiple distinct cap-going-in floors applied {${[...floors].join('%, ')}%} — expected one per class unless subtype split (Office CBD/suburban/medical is legitimate).`);
  }
  // (c) score outside plausible band
  for (const g of groupOrder) {
    const scores = byGroup.get(g)!.map(r => r.finalScore).filter((x): x is number => x !== null);
    if (scores.some(s => s < 0 || s > 100)) anomalies.push(`${g}: a finalScore outside [0,100] — arithmetic bug.`);
  }
  if (anomalies.length === 0) {
    p('None found on the structural checks:');
    p('  - no cross-class cap-floor leakage (each label maps to one floor family;');
    p('    Office subtype split, if any, is legitimate and reported in 3a);');
    p('  - no finalScore outside [0,100];');
    p('  - InsufficientData, where present, traces to the documented EX-102 coverage');
    p('    limit (no tenant roster), not a scoring defect.');
  } else {
    for (const a of anomalies) p(`  * ${a}`);
  }
  p();
  p('NOTE (structural, expected): DY / LTV are PIECE-BASED (loanPieceAmount = trust');
  p('piece, not whole loan). Absolute DY/LTV levels read structurally HIGH-yield /');
  p('LOW-leverage and are NOT trustworthy in absolute terms. The class-relative FLOOR');
  p('differentiation is valid (same piece basis across all classes).');

  const report = L.join('\n');
  process.stdout.write(report + '\n');

  if (jsonOut) {
    const out = {
      meta: { total, scored, skipped, generatedAt: new Date().toISOString(), comps: COMPS_DB },
      groups: Object.fromEntries([...byGroup.entries()].map(([g, list]) => [g, {
        n: list.length,
        scores: list.map(r => r.finalScore),
        results: list,
      }])),
    };
    writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify(out, null, 2));
    process.stderr.write(`\n[wrote JSON -> ${jsonOut}]\n`);
  }
}

main();
