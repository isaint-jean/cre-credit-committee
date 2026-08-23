/**
 * Site Inspection tab — loader + fill. The servicer's structured inspection form (servicer_inputs
 * 'site_inspection') is written into the "Site Inspection" tab at export. EXPORT-ONLY, MINT-SAFE.
 * Text-only (no photos); every mapped cell is a blank input in the template → direct writes, no
 * force-overwrite. The 4 auto cells (NRA C4 / Occupancy E4 / Year Built C5 / Year Renov E5) are
 * NOT in the map → their named-range formulas are left untouched.
 */
import type ExcelJS from 'exceljs';
import type { RevisionId, SiteInspection } from '@cre/contracts';
import { parseSiteInspection, isSiteInspectionNumberField } from '@cre/contracts';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import { recordGraphStore as defaultGraph } from '../../storage/record-graph-store.js';
import { resolveLoanForRoot } from '../pool/resolve-loan-for-root.js';
import { getServicerInput } from '../servicer-inputs.service.js';

export const SITE_INSPECTION_SHEET = 'Site Inspection';

/**
 * field id → its value cell on the tab (verified against Blank_UW_Template_v2.xlsm). The four
 * auto cells (C4/E4/C5/E5) are deliberately absent. Duplicate-label fields have distinct cells
 * (ext/int General Condition, roof construction/condition, walls M13/K16, dates K2/K18).
 */
export const SITE_INSPECTION_CELL_MAP: Readonly<Record<string, string>> = {
  // Property Summary
  numberOfBldgs: 'C6', numberOfStories: 'E6', elevators: 'C7', parkingSpaces: 'E7',
  dateAcquired: 'C8', propertyQuality: 'E8',
  // Location / Neighborhood
  cornerLocation: 'C10', ingressEgress: 'E10', areaType: 'C11', growthPattern: 'E11',
  visibility: 'C12', newConstruction: 'E12', streetAppeal: 'C13', changeInUse: 'E13',
  roadwayType: 'C14', signalized: 'E14', trafficVolume: 'C15',
  // Neighborhood Development (numeric mix)
  residential: 'C17', office: 'E17', multiFamily: 'C18', industrial: 'E18', retail: 'C19', hotel: 'E19',
  // Competitive Set
  generalComparisonToComps: 'G4', rentLevelVsCompSet: 'G5', occupancyVsCompSet: 'G6',
  newSupply: 'G7', sponsorExposure: 'G8',
  // Property Management
  managementCompany: 'G10', borrowerSponsorAffiliated: 'G11', marketExperienceLevel: 'G12', reputation: 'G13',
  // Construction Details
  exteriorConstruction: 'K4', roofConstruction: 'K5', sprinklers: 'K7', hvac: 'M7',
  exteriorCondition: 'K9', interiorCondition: 'M9', extGeneralCondition: 'K10', intGeneralCondition: 'M10',
  windows: 'K11', ceilings: 'M11', landscaping: 'K12', paint: 'M12', roofCondition: 'K13', walls: 'M13',
  roads: 'K14', commonAreas: 'M14', parking: 'K15', flooring: 'M15', extWalls: 'K16', lighting: 'M16',
  // Inspection Details
  dateOfInspectionTop: 'K2', dateOfInspection: 'K18', company: 'M18', dayOfWeekTime: 'K19', contactTitle: 'M19',
};

export interface SiteInspectionExportDeps {
  readonly graph?: Pick<RecordGraphStore, 'getRevisionEnvelope'>;
  readonly resolve?: typeof resolveLoanForRoot;
  readonly getInput?: typeof getServicerInput;
}

/** The loan's site-inspection form, or null when none / unresolved. */
export function loadSiteInspectionForExport(
  graphRevisionId: string | null | undefined,
  deps: SiteInspectionExportDeps = {},
): SiteInspection | null {
  if (!graphRevisionId) return null;
  const graph = deps.graph ?? defaultGraph;
  const resolve = deps.resolve ?? resolveLoanForRoot;
  const getInput = deps.getInput ?? getServicerInput;

  const env = graph.getRevisionEnvelope(graphRevisionId as RevisionId);
  if (env === null) return null;
  const res = resolve(env.doctrineEvaluationId);
  if (!res.resolved) return null;

  const row = getInput(res.poolId, res.loanInPoolId, 'site_inspection');
  if (row === null) return null;
  return parseSiteInspection(row.value);
}

/**
 * Fill the Site Inspection tab from the servicer's form. No-op when the sheet is absent or the
 * data is null (opt-in at the caller → byte-unchanged). Honest-blank: null/empty fields are
 * skipped (the cell is left as-is). The 4 auto cells and every other sheet are never touched.
 */
export function fillSiteInspectionTab(workbook: ExcelJS.Workbook, data: SiteInspection | null): void {
  if (data === null) return;
  const ws = workbook.getWorksheet(SITE_INSPECTION_SHEET);
  if (ws === undefined) return;

  const d = data as Record<string, unknown>;
  for (const [field, cell] of Object.entries(SITE_INSPECTION_CELL_MAP)) {
    const v = d[field];
    if (isSiteInspectionNumberField(field)) {
      if (typeof v === 'number' && Number.isFinite(v)) ws.getCell(cell).value = v;
    } else if (typeof v === 'string' && v.trim().length > 0) {
      ws.getCell(cell).value = v.trim();
    }
    // null / undefined / empty → skip (honest-blank; leave the template cell as-is).
  }
}
