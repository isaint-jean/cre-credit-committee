/**
 * Sales comparables — the servicer's manually-entered sale comps for a deal. Up to 4 comps,
 * each a set of fields + an optional photo (the photo bytes live in the content-addressed
 * blob store, referenced here by hash — exactly like site photos). At export they fill the
 * workbook's "Sales Comps" tab (rows 7-10) + embed each photo into its region.
 *
 * ★ DISPLAY/EXPORT-ONLY, MINT-SAFE. Servicer human input on the additive servicer_inputs
 *   TEXT column (fieldType 'sales_comps'). Never touches the minted doctrine / 640 head.
 *   Honest-blank: any field the servicer omits stays null, never fabricated. The SUBJECT row
 *   is auto-filled by the generator's named ranges — it is NOT part of this payload.
 */

/** One sale comp — every field optional (honest-blank when omitted). */
export interface SaleComp {
  readonly buildingName: string | null;
  readonly address: string | null;
  readonly cityState: string | null;
  readonly distance: string | null;        // e.g. "1.2 mi"
  readonly direction: string | null;       // e.g. "NE"
  readonly totalSf: number | null;
  readonly yearBuilt: number | null;
  readonly yearRenov: number | null;
  readonly occupancyAtSale: number | null; // 0..1 fraction
  readonly saleDate: string | null;        // free text / ISO (display as given)
  readonly salePrice: number | null;
  readonly capRate: number | null;         // 0..1 fraction
  readonly pricePerMeasure: number | null; // $/SF (or $/unit)
  /** Content hash of the comp's photo in the blob store, or null. */
  readonly photoHash: string | null;
  readonly photoFileName: string | null;
}

export interface SalesCompsPayload {
  readonly comps: readonly SaleComp[];
}

export const EMPTY_SALES_COMPS: SalesCompsPayload = { comps: [] };

/** The "Sales Comps" tab holds 4 comp slots (Comp 1-4). */
export const MAX_SALE_COMPS = 4;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/** Parse the stored JSON defensively — malformed / legacy → empty (never throws). Caps at 4. */
export function parseSalesComps(raw: string | null | undefined): SalesCompsPayload {
  if (!raw) return EMPTY_SALES_COMPS;
  try {
    const o = JSON.parse(raw) as Partial<SalesCompsPayload>;
    const comps = Array.isArray(o.comps)
      ? o.comps.slice(0, MAX_SALE_COMPS).map((c) => {
          const q = (c ?? {}) as Partial<SaleComp>;
          return {
            buildingName: strOrNull(q.buildingName),
            address: strOrNull(q.address),
            cityState: strOrNull(q.cityState),
            distance: strOrNull(q.distance),
            direction: strOrNull(q.direction),
            totalSf: numOrNull(q.totalSf),
            yearBuilt: numOrNull(q.yearBuilt),
            yearRenov: numOrNull(q.yearRenov),
            occupancyAtSale: numOrNull(q.occupancyAtSale),
            saleDate: strOrNull(q.saleDate),
            salePrice: numOrNull(q.salePrice),
            capRate: numOrNull(q.capRate),
            pricePerMeasure: numOrNull(q.pricePerMeasure),
            photoHash: strOrNull(q.photoHash),
            photoFileName: strOrNull(q.photoFileName),
          };
        })
      : [];
    return { comps };
  } catch {
    return EMPTY_SALES_COMPS;
  }
}

/** Serialize a comps payload back to the stored JSON (caps at 4). */
export function serializeSalesComps(payload: SalesCompsPayload): string {
  return JSON.stringify({
    comps: payload.comps.slice(0, MAX_SALE_COMPS).map((c) => ({
      buildingName: c.buildingName,
      address: c.address,
      cityState: c.cityState,
      distance: c.distance,
      direction: c.direction,
      totalSf: c.totalSf,
      yearBuilt: c.yearBuilt,
      yearRenov: c.yearRenov,
      occupancyAtSale: c.occupancyAtSale,
      saleDate: c.saleDate,
      salePrice: c.salePrice,
      capRate: c.capRate,
      pricePerMeasure: c.pricePerMeasure,
      photoHash: c.photoHash,
      photoFileName: c.photoFileName,
    })),
  });
}
