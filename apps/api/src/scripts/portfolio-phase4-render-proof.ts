/**
 * PORTFOLIO PHASE 4 — WORKBOOK RENDER PROOF
 *
 * Proves the composition layer (portfolio-workbook-composer.service.ts):
 *   (A) Prime Storage-Blue composes a REAL .xlsx to /tmp, re-read from disk:
 *       5 per-property LEAF tabs (distinct correct data matched to comps.db to
 *       the dollar) + 4 roll-up tabs built once.
 *   (B) Roll-up tabs carry the P2-validated numbers (blended $91.2M, cap 5.80%,
 *       concentration "elevated", DSCR honest-null).
 *   (C) Honest blanks are VISIBLY blank (pari-passu DSCR cell empty + labeled;
 *       cross-collateral / release / market view = DATA_NOT_PROVIDED sentinel).
 *   (D) SINGLE-PROPERTY UNCHANGED: N=1 NEVER enters composition (throws by
 *       design); the composer fires only for N>1.
 *   (E) GUARDRAIL 1: only leaf tabs cloned; roll-up tabs built once.
 *
 * Read-only over comps.db; NO cre.db; NO doctrine touch; NO commit; NO LLM.
 * Writes a THROWAWAY workbook to /tmp.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/portfolio-phase4-render-proof.ts
 */
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { resolve } from 'node:path';
import type { PropertyComponent } from '@cre/contracts';
import { aggregatePortfolio } from '../services/portfolio-aggregator.service.js';
import {
  composePortfolioWorkbook,
  leafSheetName,
  CROSS_SHEET_FORMULA_DECISION,
  HONEST_BLANK_DSCR_LABEL,
} from '../services/portfolio-workbook-composer.service.js';

const REPO = resolve(process.cwd(), '../..');
const COMPS_DB = resolve(REPO, 'data/comps/comps.db');
const TEMPLATE = resolve(REPO, 'docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const LEAF_SHEET = 'Property Detail - MF SS MHP'; // self_storage leaf per render-schema
const OUT = '/tmp/portfolio-phase4-prime-storage-blue.xlsx';

/** PSB rollup-row ground truth (comps.db aggregate '19'). */
const GT = { value: 91_200_000, noi: 5_288_725.16, cap: 0.05799, dscr: 1.45, ncf: 5_256_222.88 };

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

async function main(): Promise<void> {
  log('PORTFOLIO PHASE 4 — WORKBOOK RENDER PROOF (Prime Storage-Blue)');
  log(`Run: ${new Date().toISOString()}`);
  log(`Cross-sheet-formula decision: ${CROSS_SHEET_FORMULA_DECISION}`);
  log('');

  const components = loadPSB();
  log(`Loaded ${components.length} PSB components.`);
  // Whole-loan DS that reproduces the issuer DSCR 1.45 (ΣNCF/1.45); NOT supplied
  // to the aggregation below on purpose, so the composed DSCR is HONEST-NULL.
  const agg = aggregatePortfolio(components); // no wholeLoanDebtService → honest-null DSCR

  /* ---- (A) Compose a real .xlsx → write to /tmp → re-read from disk ---- */
  const res = await composePortfolioWorkbook({
    templatePath: TEMPLATE,
    leafTemplateSheetName: LEAF_SHEET,
    components,
    aggregation: agg,
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, res.buffer);

  const verify = new ExcelJS.Workbook();
  await verify.xlsx.readFile(OUT);
  const reReadSheets: string[] = [];
  verify.eachSheet((ws) => reReadSheets.push(ws.name));

  log('(A) COMPOSED WORKBOOK (re-read from disk):');
  log(`  total sheets: ${reReadSheets.length}`);
  log(`  leaf (cloned) sheets: ${res.leafSheetNames.length} → ${res.leafSheetNames.join(', ')}`);
  log(`  roll-up (built once) sheets: ${res.rollUpSheetNames.join(', ')}`);
  log(`  CF rules dropped: ${res.cfRulesDropped}`);
  check('workbook wrote + re-read from disk', reReadSheets.length > 0, `${reReadSheets.length} sheets`);
  check('5 per-property LEAF tabs cloned', res.leafSheetNames.length === 5, `${res.leafSheetNames.length}`);
  check('4 roll-up tabs built once', res.rollUpSheetNames.length === 4, res.rollUpSheetNames.join(','));
  check('leaf template sheet still present (cloned, not moved)',
    reReadSheets.includes(LEAF_SHEET), LEAF_SHEET);
  log('');

  /* Per-property leaf values matched to comps.db to the dollar. */
  log('  PER-PROPERTY LEAF DATA (re-read, matched to comps.db):');
  for (const c of components) {
    const nm = leafSheetName(c);
    const ws = verify.getWorksheet(nm);
    if (!ws) { check(`leaf ${nm} present`, false, 'MISSING'); continue; }
    const name = ws.getCell('B1').value;
    const val = ws.getCell('B8').value;
    const noi = ws.getCell('B9').value;
    const nameOk = name === c.propertyName;
    const valOk = val === c.value;
    const noiOk = Math.abs(Number(noi) - Number(c.noi)) < 0.01;
    log(`    "${nm}": value=$${Number(val).toLocaleString()} NOI=$${Number(noi).toLocaleString()}`);
    check(`leaf ${c.componentId} name+value+NOI match comps.db`,
      nameOk && valOk && noiOk,
      `name=${nameOk} value=${valOk} noi=${noiOk}`);
  }
  // Spot-checks called out in the gate.
  const union = verify.getWorksheet(leafSheetName(components[0]))!; // 19-001 Union City
  const garfield = verify.getWorksheet(leafSheetName(components[4]))!; // 19-005 Garfield
  check('Union City leaf = $29,000,000 / NOI $1,799,399.41',
    union.getCell('B8').value === 29_000_000 && Math.abs(Number(union.getCell('B9').value) - 1_799_399.41) < 0.01,
    `val=${union.getCell('B8').value} noi=${union.getCell('B9').value}`);
  check('Garfield leaf = $7,700,000 / NOI $390,013.43',
    garfield.getCell('B8').value === 7_700_000 && Math.abs(Number(garfield.getCell('B9').value) - 390_013.43) < 0.01,
    `val=${garfield.getCell('B8').value} noi=${garfield.getCell('B9').value}`);
  log('');

  /* ---- (B) Roll-up tabs show the P2-validated numbers ---- */
  log('(B) ROLL-UP TABS carry P2-validated numbers (re-read from disk):');
  const summary = verify.getWorksheet('Portfolio Summary')!;
  // A1 title; rows: count, blended value, agg NOI, agg NCF, blended cap, DSCR
  const findRowByLabel = (ws: ExcelJS.Worksheet, label: string): number | null => {
    for (let r = 1; r <= ws.rowCount; r++) {
      if (String(ws.getCell(`A${r}`).value ?? '').trim() === label) return r;
    }
    return null;
  };
  const blendedValRow = findRowByLabel(summary, 'Blended value (Σ value)')!;
  const capRow = findRowByLabel(summary, 'Blended cap rate (ΣNOI ÷ Σvalue)')!;
  const blendedVal = summary.getCell(`B${blendedValRow}`).value;
  const cap = summary.getCell(`B${capRow}`).value;
  log(`  blended value cell = $${Number(blendedVal).toLocaleString()}`);
  log(`  blended cap cell = ${(Number(cap) * 100).toFixed(3)}%`);
  check('blended value cell = $91.2M', blendedVal === GT.value, `$${Number(blendedVal).toLocaleString()}`);
  check('blended cap cell = 5.80% (±1bp)', Math.abs(Number(cap) - GT.cap) < 0.0001, `${(Number(cap) * 100).toFixed(3)}%`);

  const concTab = verify.getWorksheet('Concentration')!;
  const levelRow = findRowByLabel(concTab, 'Concentration level')!;
  const level = concTab.getCell(`B${levelRow}`).value;
  log(`  concentration level cell = ${String(level)}`);
  check('concentration level cell = "elevated"', level === 'elevated', String(level));
  log('');

  /* ---- (C) Honest blanks visibly blank ---- */
  log('(C) HONEST BLANKS (re-read from disk):');
  const dscrRow = findRowByLabel(summary, 'Aggregate DSCR')!;
  const dscrVal = summary.getCell(`B${dscrRow}`).value;
  const dscrLabel = summary.getCell(`C${dscrRow}`).value;
  log(`  DSCR value cell = ${dscrVal === null ? '(blank)' : String(dscrVal)}; adjacent label = "${String(dscrLabel)}"`);
  check('pari-passu DSCR cell is BLANK (not fabricated)', dscrVal === null, `value=${dscrVal}`);
  check('DSCR blank carries the honest label', dscrLabel === HONEST_BLANK_DSCR_LABEL, String(dscrLabel));

  const alloc = verify.getWorksheet('Allocation & Release')!;
  const xcRow = findRowByLabel(alloc, 'Cross-collateralized')!;
  const relRow = findRowByLabel(alloc, 'Release provisions')!;
  const xc = alloc.getCell(`B${xcRow}`).value;
  const rel = alloc.getCell(`B${relRow}`).value;
  log(`  cross-collateralized cell = "${String(xc)}"`);
  log(`  release provisions cell   = "${String(rel)}"`);
  check('cross-collateral = DATA_NOT_PROVIDED (visible sentinel, not fabricated)',
    xc === 'DATA_NOT_PROVIDED', String(xc));
  check('release provisions = DATA_NOT_PROVIDED (visible sentinel)',
    rel === 'DATA_NOT_PROVIDED', String(rel));
  log('');

  /* ---- (D) SINGLE-PROPERTY UNCHANGED — N=1 never enters composition ---- */
  log('(D) SINGLE-PROPERTY UNCHANGED (composition is N>1 only):');
  const single = [components[0]];
  const agg1 = aggregatePortfolio(single);
  let threw = false;
  let msg = '';
  try {
    await composePortfolioWorkbook({
      templatePath: TEMPLATE, leafTemplateSheetName: LEAF_SHEET,
      components: single, aggregation: agg1,
    });
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  check('N=1 → composePortfolioWorkbook throws (never composes; N=1 uses single-property path)',
    threw && /portfolio-only/.test(msg), threw ? msg.slice(0, 60) : 'did NOT throw');
  log('  → the composition NEVER runs for N=1; the existing single-property');
  log('    render/export path (e0b4844) is byte-identical (never invoked here).');
  log('');

  /* ---- (E) GUARDRAIL 1: leaf-tabs-first ---- */
  log('(E) GUARDRAIL 1 — leaf-tabs-first:');
  // Only the leaf tab was cloned ×5; the 4 roll-up tabs are the ONLY net-new
  // aggregate sheets and each appears exactly once.
  const leafClones = reReadSheets.filter((n) => res.leafSheetNames.includes(n)).length;
  const rollUpOnce = res.rollUpSheetNames.every(
    (n) => reReadSheets.filter((x) => x === n).length === 1,
  );
  check('exactly 5 leaf clones present', leafClones === 5, `${leafClones}`);
  check('each roll-up tab appears exactly once (built once, not cloned)', rollUpOnce, 'once each');
  log('');

  log('='.repeat(72));
  log(`PHASE 4 RENDER PROOF: ${allPass ? 'ALL PASS' : 'FAILURES ABOVE'}`);
  log(`  workbook: ${OUT}`);
  log('='.repeat(72));
  console.log(out.join('\n'));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.log('FATAL:', (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
});
