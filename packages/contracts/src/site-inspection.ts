/**
 * Site inspection — the servicer's structured inspection form for a deal. ONE object of ~57
 * free-text/number fields (7 sections) that fill the workbook's "Site Inspection" tab at export.
 *
 * ★ DISPLAY/EXPORT-ONLY, MINT-SAFE. Servicer input on the additive servicer_inputs TEXT column
 *   (fieldType 'site_inspection'). Never touches the mint. Honest-blank: any field the servicer
 *   omits stays null → the tab cell is left as-is. Four cells (NRA, Occupancy, Year Built/Renov)
 *   are auto-filled by the generator's named ranges and are NOT part of this form.
 */

/** The 10 numeric fields (counts + the Neighborhood Development mix). Everything else is text. */
export const SITE_INSPECTION_NUMBER_FIELDS = [
  'numberOfBldgs', 'numberOfStories', 'elevators', 'parkingSpaces',
  'residential', 'office', 'multiFamily', 'industrial', 'retail', 'hotel',
] as const;
export type SiteInspectionNumberField = (typeof SITE_INSPECTION_NUMBER_FIELDS)[number];

/** All ~47 free-text fields (dates ride as free text — the template does not type-enforce). */
export const SITE_INSPECTION_TEXT_FIELDS = [
  // Property Summary
  'dateAcquired', 'propertyQuality',
  // Location / Neighborhood
  'cornerLocation', 'ingressEgress', 'areaType', 'growthPattern', 'visibility', 'newConstruction',
  'streetAppeal', 'changeInUse', 'roadwayType', 'signalized', 'trafficVolume',
  // Competitive Set
  'generalComparisonToComps', 'rentLevelVsCompSet', 'occupancyVsCompSet', 'newSupply', 'sponsorExposure',
  // Property Management
  'managementCompany', 'borrowerSponsorAffiliated', 'marketExperienceLevel', 'reputation',
  // Construction Details
  'exteriorConstruction', 'roofConstruction', 'sprinklers', 'hvac', 'exteriorCondition', 'interiorCondition',
  'extGeneralCondition', 'intGeneralCondition', 'windows', 'ceilings', 'landscaping', 'paint',
  'roofCondition', 'walls', 'roads', 'commonAreas', 'parking', 'flooring', 'extWalls', 'lighting',
  // Inspection Details
  'dateOfInspectionTop', 'dateOfInspection', 'company', 'dayOfWeekTime', 'contactTitle',
] as const;
export type SiteInspectionTextField = (typeof SITE_INSPECTION_TEXT_FIELDS)[number];

export type SiteInspection =
  Partial<Record<SiteInspectionNumberField, number | null>> &
  Partial<Record<SiteInspectionTextField, string | null>>;

export const EMPTY_SITE_INSPECTION: SiteInspection = {};

const numberFieldSet: ReadonlySet<string> = new Set(SITE_INSPECTION_NUMBER_FIELDS);

/** Parse the stored JSON defensively — malformed / legacy → empty (never throws). */
export function parseSiteInspection(raw: string | null | undefined): SiteInspection {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number | string | null> = {};
    for (const k of SITE_INSPECTION_NUMBER_FIELDS) {
      const v = o[k];
      out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    for (const k of SITE_INSPECTION_TEXT_FIELDS) {
      const v = o[k];
      out[k] = typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
    }
    return out as SiteInspection;
  } catch {
    return {};
  }
}

/** Serialize a site-inspection back to the stored JSON (only the known fields). */
export function serializeSiteInspection(data: SiteInspection): string {
  const out: Record<string, number | string | null> = {};
  const d = data as Record<string, unknown>;
  for (const k of SITE_INSPECTION_NUMBER_FIELDS) {
    const v = d[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  for (const k of SITE_INSPECTION_TEXT_FIELDS) {
    const v = d[k];
    out[k] = typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  }
  return JSON.stringify(out);
}

/** True for the numeric fields (the UI renders these as number inputs). */
export function isSiteInspectionNumberField(field: string): boolean {
  return numberFieldSet.has(field);
}
