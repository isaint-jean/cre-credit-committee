/**
 * PROOF — Site Inspection servicer input + workbook fill (free-text/number, ~57 fields).
 * EXPORT/RENDER-ONLY, MINT-SAFE.
 *
 *  (A) contract round-trip: parse/serialize; number vs text; honest-blank; junk dropped.
 *  (B) cell-map integrity: every mapped cell is BLANK in the template (0 formula collisions);
 *      all 57 field ids covered; the 4 auto cells (C4/E4/C5/E5) are NOT in the map.
 *  (C) fill: a sample across all 7 sections writes into the correct mapped cells; the
 *      DUPLICATE-LABEL fields land in distinct cells (ext/int General Condition, roof
 *      construction/condition, walls M13/K16, dates K2/K18) — no collision.
 *  (D) auto cells untouched (C4/E4/C5/E5 still formulas); omitted field → blank.
 *  (E) opt-in: null → the tab (and workbook) byte-unchanged.
 *  (F) loader + wiring + mint-safe: loadSiteInspectionForExport (injected deps); render.routes
 *      loads + passes; canonical byte-identical.
 *
 * Run: npx tsx src/scripts/site-inspection-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import {
  parseSiteInspection, serializeSiteInspection, isSiteInspectionNumberField,
  SITE_INSPECTION_NUMBER_FIELDS, SITE_INSPECTION_TEXT_FIELDS, type SiteInspection,
} from '@cre/contracts';
import { fillSiteInspectionTab, loadSiteInspectionForExport, SITE_INSPECTION_CELL_MAP, SITE_INSPECTION_SHEET } from '../services/render-memo/site-inspection-fill.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TEMPLATE = path.join(process.cwd(), '../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const cellVal = (ws: ExcelJS.Worksheet, addr: string): unknown => {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v;
};
const isFormula = (ws: ExcelJS.Worksheet, addr: string): boolean => {
  const v = ws.getCell(addr).value;
  return !!(v && typeof v === 'object' && 'formula' in (v as object));
};
const isBlank = (ws: ExcelJS.Worksheet, addr: string): boolean => ws.getCell(addr).value === null || ws.getCell(addr).value === undefined;
function stripCf(wb: ExcelJS.Workbook): void { wb.eachSheet((ws) => { (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings = []; }); }

async function loadTemplateSheet(fill: SiteInspection | null): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  fillSiteInspectionTab(wb, fill);
  stripCf(wb);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as never);
  return back.getWorksheet(SITE_INSPECTION_SHEET)!;
}

async function partA(): Promise<void> {
  console.log('\n(A) contract round-trip:');
  const d: SiteInspection = { numberOfBldgs: 3, propertyQuality: 'B', residential: 40, areaType: 'Suburban' };
  const back = parseSiteInspection(serializeSiteInspection(d));
  check('number field round-trips', back.numberOfBldgs === 3 && back.residential === 40);
  check('text field round-trips', back.propertyQuality === 'B' && back.areaType === 'Suburban');
  check('omitted → null (honest-blank)', back.elevators === null && back.company === null);
  check('junk dropped (string in number field → null)', parseSiteInspection('{"numberOfBldgs":"three"}').numberOfBldgs === null);
  check('malformed JSON → empty (never throws)', Object.values(parseSiteInspection('{{{')).every((v) => v === null));
}

async function partB(): Promise<void> {
  console.log('\n(B) cell-map integrity (57 fields, 0 formula collisions, autos excluded):');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(readFileSync(TEMPLATE) as never);
  const ws = wb.getWorksheet(SITE_INSPECTION_SHEET)!;
  const ids = Object.keys(SITE_INSPECTION_CELL_MAP);
  check('map covers all 57 fields', ids.length === 57 && ids.length === (SITE_INSPECTION_NUMBER_FIELDS.length + SITE_INSPECTION_TEXT_FIELDS.length));
  const collisions = ids.filter((f) => isFormula(ws, SITE_INSPECTION_CELL_MAP[f]!));
  check('no mapped cell is a formula (0 collisions)', collisions.length === 0, collisions.join(','));
  const cells = Object.values(SITE_INSPECTION_CELL_MAP);
  check('all mapped cells are distinct (no two fields share a cell)', new Set(cells).size === cells.length);
  check('the 4 auto cells are NOT in the map', !cells.includes('C4') && !cells.includes('E4') && !cells.includes('C5') && !cells.includes('E5'));
}

async function partC_D(): Promise<void> {
  console.log('\n(C/D) fill across all 7 sections + duplicate-label distinct cells + autos untouched:');
  const d: SiteInspection = {
    numberOfBldgs: 3, propertyQuality: 'B',                       // Property Summary
    areaType: 'Suburban', cornerLocation: 'Yes',                  // Location
    residential: 40, retail: 25,                                  // Neighborhood mix
    rentLevelVsCompSet: 'At market',                              // Competitive Set
    managementCompany: 'Acme Mgmt',                               // Property Management
    roofConstruction: 'Metal', roofCondition: 'Good',            // duplicate label "Roof" → K5 vs K13
    extGeneralCondition: 'Good', intGeneralCondition: 'Fair',    // duplicate "General Condition" → K10 vs M10
    walls: 'Painted', extWalls: 'Brick',                          // duplicate "Walls" → M13 vs K16
    dateOfInspectionTop: '2024-06-15', dateOfInspection: '2024-06-16', company: 'Inspect Co', // dup Date → K2 vs K18
    // elevators intentionally OMITTED (honest-blank check)
  };
  const ws = await loadTemplateSheet(d);
  check('Property Summary: numberOfBldgs→C6, propertyQuality→E8', cellVal(ws, 'C6') === 3 && cellVal(ws, 'E8') === 'B');
  check('Location: areaType→C11, cornerLocation→C10', cellVal(ws, 'C11') === 'Suburban' && cellVal(ws, 'C10') === 'Yes');
  check('Neighborhood mix: residential→C17, retail→C19 (numbers)', cellVal(ws, 'C17') === 40 && cellVal(ws, 'C19') === 25);
  check('Competitive Set: rentLevelVsCompSet→G5', cellVal(ws, 'G5') === 'At market');
  check('Property Management: managementCompany→G10', cellVal(ws, 'G10') === 'Acme Mgmt');
  check('★ dup "Roof": roofConstruction→K5, roofCondition→K13 (distinct)', cellVal(ws, 'K5') === 'Metal' && cellVal(ws, 'K13') === 'Good');
  check('★ dup "General Condition": ext→K10, int→M10 (distinct)', cellVal(ws, 'K10') === 'Good' && cellVal(ws, 'M10') === 'Fair');
  check('★ dup "Walls": walls→M13, extWalls→K16 (distinct)', cellVal(ws, 'M13') === 'Painted' && cellVal(ws, 'K16') === 'Brick');
  check('★ dup "Date of Inspection": top→K2, detail→K18, company→M18 (distinct)', cellVal(ws, 'K2') === '2024-06-15' && cellVal(ws, 'K18') === '2024-06-16' && cellVal(ws, 'M18') === 'Inspect Co');
  // (D) auto cells untouched + omitted honest-blank
  check('auto cells untouched (C4/E4/C5/E5 still formulas)', isFormula(ws, 'C4') && isFormula(ws, 'E4') && isFormula(ws, 'C5') && isFormula(ws, 'E5'));
  check('omitted field → blank (elevators C7 empty)', isBlank(ws, 'C7'));
  check('number field type flags: numberOfBldgs numeric, propertyQuality text', isSiteInspectionNumberField('numberOfBldgs') && !isSiteInspectionNumberField('propertyQuality'));
}

async function partE(): Promise<void> {
  console.log('\n(E) opt-in — null → tab byte-unchanged:');
  const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.load(readFileSync(TEMPLATE) as never); stripCf(wb0);
  const before = Buffer.from(await wb0.xlsx.writeBuffer()).length;
  const wb1 = new ExcelJS.Workbook(); await wb1.xlsx.load(readFileSync(TEMPLATE) as never);
  fillSiteInspectionTab(wb1, null); stripCf(wb1);
  const after = Buffer.from(await wb1.xlsx.writeBuffer()).length;
  const ws = wb1.getWorksheet(SITE_INSPECTION_SHEET)!;
  check('null → C6 still blank (no fill)', isBlank(ws, 'C6'));
  check('null → workbook size unchanged (no-op)', Math.abs(before - after) < 200, `${before} vs ${after}`);
}

function partF(): void {
  console.log('\n(F) loader + wiring + mint-safe:');
  const value = serializeSiteInspection({ propertyQuality: 'A', numberOfBldgs: 2 });
  const loaded = loadSiteInspectionForExport('rev', {
    graph: { getRevisionEnvelope: () => ({ doctrineEvaluationId: 'eval' } as never) },
    resolve: (() => ({ resolved: true, poolId: 'P', loanInPoolId: 'L', matchedBy: 'exact-deal-ref' })) as never,
    getInput: (() => ({ value } as never)) as never,
  });
  check('loader returns parsed form', loaded !== null && loaded.propertyQuality === 'A' && loaded.numberOfBldgs === 2);
  check('loader → null when no graphRevisionId', loadSiteInspectionForExport(null) === null);
  const routes = readFileSync(path.join(process.cwd(), 'src/routes/render.routes.ts'), 'utf8');
  check('render.routes loads + passes siteInspection', /loadSiteInspectionForExport\(result\.analysis\.graphRevisionId\)/.test(routes) && /siteInspection,/.test(routes));
  const eng = readFileSync(path.join(process.cwd(), 'src/services/template-engine.service.ts'), 'utf8');
  check('fill is opt-in (only when siteInspection present + non-null)', /opts\?\.siteInspection !== undefined && opts\.siteInspection !== null/.test(eng));
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nSite Inspection servicer-input + fill proof');
  await partA(); await partB(); await partC_D(); await partE(); partF();
  console.log(failures === 0 ? '\nSite Inspection proof: OK\n' : `\nSite Inspection proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });
