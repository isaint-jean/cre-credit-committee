/**
 * PORTFOLIO PHASE 3 — CONCENTRATION DIMENSION PROOF
 *
 * Proves the NEW portfolio-ONLY concentration DIMENSION:
 *   (A) Scores Prime Storage-Blue with the PROPOSED-and-LABELED thresholds —
 *       shows the concentration band PSB earns (single-geo / single-class /
 *       moderate-Herfindahl → elevated).
 *   (B) PORTFOLIO-ONLY applicability: N=1 → N/A (never flags a single-property
 *       loan), N>1 → applicable.
 *   (C) Release / cross-collateral = HONEST-BLANK by default, with the optional
 *       human-supply slot demonstrated.
 *
 * Read-only over comps.db; NO cre.db; NO doctrine touch; NO commit; NO LLM.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/portfolio-phase3-concentration-proof.ts
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { PropertyComponent } from '@cre/contracts';
import {
  aggregatePortfolio,
  supplyPortfolioStructure,
  DATA_NOT_PROVIDED,
} from '../services/portfolio-aggregator.service.js';
import {
  evaluatePortfolioConcentration,
  CONCENTRATION_THRESHOLDS,
} from '../services/portfolio-concentration.js';

const COMPS_DB = resolve(process.cwd(), '../../data/comps/comps.db');

interface Row {
  assetNumber: string; propertyName: string | null; city: string | null;
  state: string | null; propertyType: string | null; netRentableSF: number | null;
  value: number | null; noi: number | null; ncf: number | null;
  capRate: number | null; occupancyPct: number | null; yearBuilt: number | null;
}

function loadPSB(): PropertyComponent[] {
  const db = new Database(COMPS_DB, { readonly: true, fileMustExist: true });
  const rows = db.prepare(
    `SELECT assetNumber, propertyName, city, state, propertyType, netRentableSF,
            value, noi, ncf, capRate, occupancyPct, yearBuilt
     FROM comps
     WHERE propertyName LIKE 'Prime Storage%' AND assetNumber LIKE '19-%'
     ORDER BY assetNumber`,
  ).all() as Row[];
  db.close();
  return rows.map((r, i) => ({
    ordinal: i + 1, componentId: r.assetNumber, parentAssetNumber: '19',
    propertyName: r.propertyName, address: null, city: r.city, state: r.state, zip: null,
    propertyType: r.propertyType, netRentableSF: r.netRentableSF, yearBuilt: r.yearBuilt,
    value: r.value, valuationDate: null, noi: r.noi, ncf: r.ncf, revenue: null,
    occupancyPct: r.occupancyPct, capRate: r.capRate,
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
  log('PORTFOLIO PHASE 3 — CONCENTRATION DIMENSION PROOF');
  log(`Run: ${new Date().toISOString()}`);
  log('');

  log('★ THRESHOLDS IN USE (PROVISIONAL — Isabelle to tune):');
  log(`  status: ${CONCENTRATION_THRESHOLDS.status}`);
  const T = CONCENTRATION_THRESHOLDS;
  log(`  top-property bands: <${T.topPropertyShare.diversifiedBelow}=I, ` +
    `<${T.topPropertyShare.moderateBelow}=II, <${T.topPropertyShare.concentratedBelow}=III, ≥=IV`);
  log(`  Herfindahl bands:   <${T.herfindahl.diversifiedBelow}=I, ` +
    `<${T.herfindahl.moderateBelow}=II, <${T.herfindahl.concentratedBelow}=III, ≥=IV`);
  log(`  single-geography flag ≥ ${T.singleGeographyShareFlag.threshold}`);
  log(`  single-asset-class flag ≥ ${T.singleAssetClassShareFlag.threshold}`);
  log(`  band risk scale: I=${T.bandRiskContribution.I} II=${T.bandRiskContribution.II} ` +
    `III=${T.bandRiskContribution.III} IV=${T.bandRiskContribution.IV}; ` +
    `flag add-on +${T.singleFlagRiskAddOn.perFlag}/flag (cap ${T.singleFlagRiskAddOn.cap})`);
  log('');

  /* ---- (A) Score Prime Storage-Blue ---- */
  const components = loadPSB();
  const agg = aggregatePortfolio(components);
  const con = agg.math.concentration;
  log(`(A) PRIME STORAGE-BLUE — ${components.length} properties`);
  log(`  top property: ${con.topPropertyName} @ ${((con.topPropertyValueShare ?? 0) * 100).toFixed(2)}%`);
  log(`  geo mix: ${con.geographicMixByState.map((s) => `${s.key} ${(s.valueShare * 100).toFixed(1)}%`).join(', ')}`);
  log(`  class mix: ${con.assetClassMix.map((s) => `${s.key} ${(s.valueShare * 100).toFixed(1)}%`).join(', ')}`);
  log(`  Herfindahl ${con.herfindahlIndex?.toFixed(4)} (${con.effectiveProperties?.toFixed(2)} effective properties)`);

  const dim = evaluatePortfolioConcentration({ loanCount: components.length, concentration: con });
  log('');
  log('  CONCENTRATION DIMENSION result:');
  log(`    applicability = ${dim.applicability}`);
  log(`    tier          = ${dim.tier}`);
  log(`    riskContribution = ${dim.riskContribution}`);
  log(`    rationale: ${dim.rationale}`);
  log('');
  check('PSB concentration dim is applicable (N=5 > 1)', dim.applicability === 'applicable', dim.applicability);
  // DISPERSION: top 31.8% → band II; HHI 0.2314 (4.32 effective) → band II. PSB is
  // genuinely MODERATE on dispersion — it is the two CORRELATION flags that elevate it.
  check('PSB base dispersion tier = II (moderate; 4.32 effective properties)',
    dim.tier === 'II', `tier ${dim.tier}`);
  check('single-geography flag fired (100% NJ)',
    dim.derivedOutputs?.singleGeographyFlag === 1, `flag=${dim.derivedOutputs?.singleGeographyFlag}`);
  check('single-asset-class flag fired (100% Self-Storage)',
    dim.derivedOutputs?.singleAssetClassFlag === 1, `flag=${dim.derivedOutputs?.singleAssetClassFlag}`);
  // base II (0.30) + 2 flags (+0.15) = 0.45 → effective level "elevated".
  check('riskContribution = base tier II + both single-flags = 0.45',
    typeof dim.riskContribution === 'number' && Math.abs(dim.riskContribution - 0.45) < 1e-9,
    `${dim.riskContribution}`);
  check('effective concentration LEVEL = "elevated" (single-geo + single-class lift moderate→elevated)',
    dim.derivedOutputs?.concentrationLevel === 'elevated',
    `level=${dim.derivedOutputs?.concentrationLevel}`);
  log('');

  /* ---- (B) PORTFOLIO-ONLY applicability: N=1 → N/A ---- */
  log('(B) PORTFOLIO-ONLY APPLICABILITY:');
  // N=1: a single-property "portfolio" — its concentration is trivially 100%.
  const singleComp: PropertyComponent[] = [components[0]];
  const agg1 = aggregatePortfolio(singleComp);
  const con1 = agg1.math.concentration;
  log(`  N=1 concentration: top ${((con1.topPropertyValueShare ?? 0) * 100).toFixed(0)}%, ` +
    `HHI ${con1.herfindahlIndex?.toFixed(2)} (trivially 100% concentrated — by construction)`);
  const dim1 = evaluatePortfolioConcentration({ loanCount: 1, concentration: con1 });
  log(`  N=1 dimension: applicability=${dim1.applicability}, tier=${dim1.tier}, risk=${dim1.riskContribution}`);
  check('N=1 → NOT applicable (never flags a single-property loan)',
    dim1.applicability === 'not-applicable-by-asset-type', dim1.applicability);
  check('N=1 → tier N/A, riskContribution null (does NOT fire)',
    dim1.tier === 'N/A' && dim1.riskContribution === null,
    `tier=${dim1.tier}, risk=${dim1.riskContribution}`);
  check('N=1 → evaluated=false (the 100% concentration is definitional, not a risk)',
    dim1.evaluated === false, `evaluated=${dim1.evaluated}`);
  // Also N=0 guard.
  const dim0 = evaluatePortfolioConcentration({ loanCount: 0, concentration: con1 });
  check('N=0 → also N/A (loanCount<=1 gate)',
    dim0.applicability === 'not-applicable-by-asset-type' && dim0.riskContribution === null,
    `${dim0.applicability}`);
  log('');

  /* ---- (C) Release / cross-collateral = HONEST-BLANK ---- */
  log('(C) RELEASE / CROSS-COLLATERAL — HONEST-BLANK by default:');
  const ps = agg.portfolioStructure;
  log(`  crossCollateralized = ${ps.crossCollateralized}`);
  log(`  crossDefaulted      = ${ps.crossDefaulted}`);
  log(`  releaseProvisions   = ${ps.releaseProvisions}`);
  log(`  releasePriceBasis   = ${ps.releasePriceBasis}`);
  log(`  substitutionRights  = ${ps.substitutionRights}`);
  log(`  source              = ${ps.source}`);
  check('all portfolio-structure fields default to DATA_NOT_PROVIDED (never fabricated)',
    ps.crossCollateralized === DATA_NOT_PROVIDED && ps.crossDefaulted === DATA_NOT_PROVIDED &&
    ps.releaseProvisions === DATA_NOT_PROVIDED && ps.releasePriceBasis === DATA_NOT_PROVIDED &&
    ps.substitutionRights === DATA_NOT_PROVIDED && ps.source === DATA_NOT_PROVIDED,
    'all blank');
  log('');
  log('  OPTIONAL HUMAN-SUPPLY SLOT (a human reads the loan docs and records terms):');
  const supplied = supplyPortfolioStructure({
    crossCollateralized: 'Yes — all 5 properties cross-collateralized and cross-defaulted',
    releaseProvisions: 'Individual release permitted at 115% of allocated loan amount + DY test',
    source: 'Loan Agreement §2.5 (human-entered)',
  });
  const aggSupplied = aggregatePortfolio(components, { portfolioStructure: supplied });
  const ps2 = aggSupplied.portfolioStructure;
  log(`  crossCollateralized = ${ps2.crossCollateralized}`);
  log(`  releaseProvisions   = ${ps2.releaseProvisions}`);
  log(`  releasePriceBasis   = ${ps2.releasePriceBasis}  (untouched → still blank)`);
  log(`  source              = ${ps2.source}`);
  check('human-supplied fields recorded; unsupplied fields stay honest-blank',
    ps2.crossCollateralized !== DATA_NOT_PROVIDED &&
    ps2.releaseProvisions !== DATA_NOT_PROVIDED &&
    ps2.releasePriceBasis === DATA_NOT_PROVIDED,
    'supplied set, releasePriceBasis still blank');
  check('there is NO computed path — aggregator without a human supply is all-blank',
    aggregatePortfolio(components).portfolioStructure.crossCollateralized === DATA_NOT_PROVIDED,
    'default is blank');
  log('');

  log('='.repeat(72));
  log(`PHASE 3 CONCENTRATION PROOF: ${allPass ? 'ALL PASS' : 'FAILURES ABOVE'}`);
  log('='.repeat(72));
  console.log(out.join('\n'));
  process.exitCode = allPass ? 0 : 1;
}

main();
