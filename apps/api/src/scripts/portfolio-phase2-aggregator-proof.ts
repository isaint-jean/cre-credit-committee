/**
 * PORTFOLIO PHASE 2 — AGGREGATOR PROOF
 *
 * Validates portfolio-aggregator.service.ts against Prime Storage-Blue's KNOWN
 * rollup row (comps.db ground truth). Read-only over comps.db; no cre.db, no
 * doctrine touch, no commit.
 *
 *   1. Load the 5 PSB components from comps.db (READONLY) → PropertyComponent[].
 *   2. aggregatePortfolio() → per-property scores + roll-up math.
 *   3. Assert blended value / blended cap / concentration reproduce the PSB
 *      rollup row (value $91.2M, cap 5.80%) to the dollar/bp.
 *   4. Surface the DSCR basis decision (which whole-loan DS reproduces 1.45)
 *      and the blended-cap weighting comparison (value-weighted vs alternatives).
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/portfolio-phase2-aggregator-proof.ts
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { PropertyComponent } from '@cre/contracts';
import { aggregatePortfolio } from '../services/portfolio-aggregator.service.js';

const COMPS_DB = resolve(process.cwd(), '../../data/comps/comps.db');

/** PSB rollup-row ground truth (the aggregate assetNumber '19'). */
const GT = {
  value: 91_200_000,
  noi: 5_288_725.16,
  ncf: 5_256_222.88,
  cap: 0.05799,
  dscr: 1.45,
  loanPiece: 20_000_000,
  rate: 0.0621,
};

interface Row {
  assetNumber: string;
  propertyName: string | null;
  city: string | null;
  state: string | null;
  propertyType: string | null;
  netRentableSF: number | null;
  value: number | null;
  noi: number | null;
  ncf: number | null;
  capRate: number | null;
  occupancyPct: number | null;
  yearBuilt: number | null;
}

function loadComponents(): PropertyComponent[] {
  const db = new Database(COMPS_DB, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT assetNumber, propertyName, city, state, propertyType, netRentableSF,
              value, noi, ncf, capRate, occupancyPct, yearBuilt
       FROM comps
       WHERE propertyName LIKE 'Prime Storage%' AND assetNumber LIKE '19-%'
       ORDER BY assetNumber`,
    )
    .all() as Row[];
  db.close();
  return rows.map((r, i) => ({
    ordinal: i + 1,
    componentId: r.assetNumber,
    parentAssetNumber: '19',
    propertyName: r.propertyName,
    address: null,
    city: r.city,
    state: r.state,
    zip: null,
    propertyType: r.propertyType,
    netRentableSF: r.netRentableSF,
    yearBuilt: r.yearBuilt,
    value: r.value,
    valuationDate: null,
    noi: r.noi,
    ncf: r.ncf,
    revenue: null,
    occupancyPct: r.occupancyPct,
    capRate: r.capRate,
  }));
}

const out: string[] = [];
const log = (s = '') => out.push(s);
let allPass = true;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) allPass = false;
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
}

function main(): void {
  log('PORTFOLIO PHASE 2 — AGGREGATOR PROOF (vs Prime Storage-Blue rollup row)');
  log(`Run: ${new Date().toISOString()}`);
  log('');

  const components = loadComponents();
  log(`Loaded ${components.length} PSB components (expect 5):`);
  for (const c of components) {
    log(`  [${c.ordinal}] ${c.componentId} ${c.propertyName} — ${c.city}, ${c.state} | ` +
      `val=$${c.value?.toLocaleString()} NOI=$${c.noi?.toLocaleString()} NCF=$${c.ncf?.toLocaleString()} occ=${c.occupancyPct}`);
  }
  log('');

  // Whole-loan DS that reproduces DSCR 1.45 (ΣNCF / 1.45), surfaced explicitly.
  const impliedWholeLoanDS = GT.ncf / GT.dscr;
  const agg = aggregatePortfolio(components, { wholeLoanDebtService: impliedWholeLoanDS });
  const m = agg.math;

  /* ---- (A) Per-property scoring (evaluateDeal reused verbatim) ---- */
  log('PER-PROPERTY SCORING (evaluateDeal run N times):');
  for (const s of agg.scoredComponents) {
    log(`  [${s.ordinal}] ${s.propertyName} → score ${s.finalScore?.toFixed(1) ?? 'n/a'} ` +
      `band ${s.band} rec ${s.recommendation}`);
  }
  check('all 5 components scored', agg.scoredComponents.length === 5, `${agg.scoredComponents.length} scored`);
  log('');

  /* ---- (B) Roll-up math vs ground truth ---- */
  log('ROLL-UP MATH vs PSB rollup-row ground truth:');
  check('blended value = Σ value',
    m.blendedValue === GT.value,
    `computed $${m.blendedValue?.toLocaleString()} vs gt $${GT.value.toLocaleString()}`);
  check('aggregate NOI = Σ NOI',
    Math.abs((m.aggregateNoi ?? 0) - GT.noi) < 0.01,
    `computed $${m.aggregateNoi?.toLocaleString()} vs gt $${GT.noi.toLocaleString()}`);
  check('aggregate NCF = Σ NCF',
    Math.abs((m.aggregateNcf ?? 0) - GT.ncf) < 0.01,
    `computed $${m.aggregateNcf?.toLocaleString()} vs gt $${GT.ncf.toLocaleString()}`);
  const capBp = (m.blendedCapRate ?? 0) * 100;
  check('blended cap = ΣNOI/Σval reproduces 5.80% (±1bp)',
    Math.abs((m.blendedCapRate ?? 0) - GT.cap) < 0.0001,
    `computed ${capBp.toFixed(3)}% vs gt ${(GT.cap * 100).toFixed(3)}%`);
  check('aggregate DSCR reproduces 1.45 (whole-loan DS basis)',
    Math.abs((m.aggregateDscr ?? 0) - GT.dscr) < 0.005,
    `computed ${m.aggregateDscr?.toFixed(4)} vs gt ${GT.dscr} (DS=$${impliedWholeLoanDS.toLocaleString(undefined,{maximumFractionDigits:0})})`);
  log('');

  /* ---- (C) Blended-cap basis decision — check the alternatives ---- */
  log('BLENDED-CAP BASIS DECISION (check each weighting vs gt cap 5.80%):');
  const vals = components.map((c) => c.value!).filter((v) => v > 0);
  const nois = components.map((c) => c.noi!);
  const caps = components.map((c) => c.capRate!);
  const totalVal = vals.reduce((s, v) => s + v, 0);
  const totalNoi = nois.reduce((s, v) => s + v, 0);
  // value-weighted (RECOMMENDED) = ΣNOI/Σval
  const valueWeighted = totalNoi / totalVal;
  // simple mean of per-property cap rates
  const simpleMean = caps.reduce((s, v) => s + v, 0) / caps.length;
  // NOI-weighted mean of caps = Σ(cap_i · NOI_i)/ΣNOI
  const noiWeighted = components.reduce((s, c) => s + c.capRate! * c.noi!, 0) / totalNoi;
  log(`  value-weighted (ΣNOI/Σval)  = ${(valueWeighted * 100).toFixed(3)}%  ← RECOMMENDED (reproduces gt)`);
  log(`  simple mean of caps         = ${(simpleMean * 100).toFixed(3)}%  (does NOT reproduce gt)`);
  log(`  NOI-weighted mean of caps   = ${(noiWeighted * 100).toFixed(3)}%  (does NOT reproduce gt)`);
  check('value-weighted is the unique reproducer',
    Math.abs(valueWeighted - GT.cap) < 0.0001 &&
      Math.abs(simpleMean - GT.cap) > 0.0001 &&
      Math.abs(noiWeighted - GT.cap) > 0.0001,
    `value-weighted matches, alternatives diverge`);
  log('');

  /* ---- (D) Concentration ---- */
  log('CONCENTRATION:');
  const con = m.concentration;
  log(`  top property: ${con.topPropertyName} @ ${((con.topPropertyValueShare ?? 0) * 100).toFixed(2)}% of value`);
  log(`  geographic mix: ${con.geographicMixByState.map((s) => `${s.key} ${(s.valueShare * 100).toFixed(1)}%`).join(', ')}`);
  log(`  asset-class mix: ${con.assetClassMix.map((s) => `${s.key} ${(s.valueShare * 100).toFixed(1)}%`).join(', ')}`);
  log(`  Herfindahl index: ${con.herfindahlIndex?.toFixed(4)} (effective properties ${con.effectiveProperties?.toFixed(2)})`);
  // Expected: top = Union City 29M/91.2M = 31.80%; all NJ (1 state 100%); all Self-Storage.
  const expectedTop = 29_000_000 / GT.value;
  check('top-property share = Union City $29M / $91.2M',
    Math.abs((con.topPropertyValueShare ?? 0) - expectedTop) < 0.0001,
    `${((con.topPropertyValueShare ?? 0) * 100).toFixed(3)}% vs ${(expectedTop * 100).toFixed(3)}%`);
  check('all-NJ geographic concentration (1 state @ 100%)',
    con.geographicMixByState.length === 1 && con.geographicMixByState[0].key === 'NJ' &&
      Math.abs(con.geographicMixByState[0].valueShare - 1) < 1e-9,
    `${con.geographicMixByState.length} state(s)`);
  check('all Self-Storage (1 class @ 100%)',
    con.assetClassMix.length === 1 && Math.abs(con.assetClassMix[0].valueShare - 1) < 1e-9,
    `${con.assetClassMix.length} class(es): ${con.assetClassMix[0]?.key}`);
  // HHI by hand
  const hhiHand = vals.reduce((s, v) => s + (v / totalVal) ** 2, 0);
  check('Herfindahl index matches hand-computed',
    Math.abs((con.herfindahlIndex ?? 0) - hhiHand) < 1e-9,
    `${con.herfindahlIndex?.toFixed(6)} vs ${hhiHand.toFixed(6)}`);
  log('');

  /* ---- (E) Honest-blank judgment cells ---- */
  log('HONEST-BLANK JUDGMENT CELLS:');
  const r = agg.rollUpAggregation;
  log(`  loanCount = ${r.loanCount}`);
  log(`  aggregationMethodology = "${String(r.aggregationMethodology).slice(0, 70)}..." (computed, describes basis)`);
  log(`  normalizationCommentary = ${JSON.stringify(r.normalizationCommentary)}`);
  log(`  constituentLoanIds = ${JSON.stringify(r.constituentLoanIds)}`);
  check('normalizationCommentary is DATA_NOT_PROVIDED (honest blank)',
    r.normalizationCommentary === 'DATA_NOT_PROVIDED', String(r.normalizationCommentary));
  check('methodology mentions cross-collat/release/market-view as DATA_NOT_PROVIDED',
    typeof r.aggregationMethodology === 'string' &&
      /DATA_NOT_PROVIDED/.test(r.aggregationMethodology) &&
      /cross-collateral/i.test(r.aggregationMethodology),
    'stated in methodology');
  log('');

  /* ---- (F) DSCR-not-derivable path (no DS supplied) ---- */
  const aggNoDs = aggregatePortfolio(components);
  check('DSCR honest-null when no whole-loan DS supplied',
    aggNoDs.math.aggregateDscr === null && aggNoDs.math.dscrBasis.kind === 'not-derivable',
    `dscr=${aggNoDs.math.aggregateDscr}, basis=${aggNoDs.math.dscrBasis.kind}`);
  log('');

  log('='.repeat(72));
  log(`PHASE 2 AGGREGATOR PROOF: ${allPass ? 'ALL PASS' : 'FAILURES ABOVE'}`);
  log('='.repeat(72));

  console.log(out.join('\n'));
  process.exitCode = allPass ? 0 : 1;
}

main();
