/**
 * fillLeaseCompsTab — write the servicer's lease comps into the workbook's "Lease Comps" tab
 * (rows 7-10) + embed each comp's photo. EXPORT-ONLY, MINT-SAFE. Reuses the site-photos
 * aspect-fit embed (fittedPlacement + workbook.addImage), mirroring the Sales Comps fill.
 *
 * ★ THE DELTA vs Sales Comps:
 *   (1) C (Building Name), M (Occup) and the rate columns N/O/P are IFERROR FORMULAS in this
 *       template (they return "" outside the MF self-comp mode). A direct ExcelJS `.value =`
 *       assignment REPLACES the formula with the written value — i.e. force-overwrite. We write
 *       real comp values there (skipping nulls → the formula stays and shows "").
 *   (2) N/O/P hold DIFFERENT metrics per asset type (the template's $X$5 legend). The fill maps
 *       the deal's asset type → the 3 rate metrics that belong in N/O/P.
 *
 * Honest-blank: null fields are skipped. The SUBJECT row (12) is auto-filled by named ranges
 * and is NEVER touched.
 */
import type ExcelJS from 'exceljs';
import { fittedPlacement, type SitePhotoBox } from './site-photos-grid.js';
import { leaseRateModeForAssetType } from '@cre/contracts';
import type { LeaseCompForExport } from './lease-comps-for-export.js';

export const LEASE_COMPS_SHEET = 'Lease Comps';
const FIRST_COMP_ROW = 7; // Comp 1..4 → rows 7,8,9,10

// Shared input columns (1-indexed) per the template's Lease Comps header row 6.
const COL = {
  buildingName: 3,   // C  (formula → force-overwrite)
  address: 6,        // F
  cityState: 7,      // G
  distance: 8,       // H
  direction: 9,      // I
  totalSf: 10,       // J
  yearBuilt: 11,     // K
  yearRenov: 12,     // L
  occupancy: 13,     // M  (formula → force-overwrite)
  rate1: 14,         // N  (formula → force-overwrite) — metric 1 by asset type
  rate2: 15,         // O  (formula → force-overwrite) — metric 2
  rate3: 16,         // P  (formula → force-overwrite) — metric 3
} as const;

// Photo regions (same as Sales Comps): Comp1 B16:D21 · Comp2 F16:H21 · Comp3 B30:D34 · Comp4 F30:H34.
const PHOTO_BOXES: readonly Omit<SitePhotoBox, 'index' | 'captionRow' | 'captionCol'>[] = [
  { tlRow: 16, tlCol: 2, brRow: 21, brCol: 4 },
  { tlRow: 16, tlCol: 6, brRow: 21, brCol: 8 },
  { tlRow: 30, tlCol: 2, brRow: 34, brCol: 4 },
  { tlRow: 30, tlCol: 6, brRow: 34, brCol: 8 },
];

/** The 3 rate metrics that belong in N/O/P for the deal's asset type (matches the $X$5 legend). */
function rateTriple(c: LeaseCompForExport, assetType: string | null | undefined): [string | number | null, string | number | null, string | number | null] {
  switch (leaseRateModeForAssetType(assetType)) {
    case 'hotel': return [c.rackRate, c.adr, c.revPar];
    case 'residential': return [c.concessions, c.monthlyRent, c.rentPsf];
    case 'commercial': default: return [c.leaseType, c.leaseRate, c.expenseReimb];
  }
}

/** Write a value only when present. A direct `.value =` overwrites a formula cell (force-overwrite). */
function put(ws: ExcelJS.Worksheet, row: number, col: number, value: string | number | null): void {
  if (value === null || value === undefined) return;
  ws.getCell(row, col).value = value;
}

/**
 * Fill the Lease Comps tab from the loan's comps for the deal's asset type. No-op when the sheet
 * is absent or there are no comps → the workbook is byte-unchanged (opt-in at the caller). Only
 * rows 7-10 + the photo regions are touched; the subject row and every other sheet are left alone.
 */
export function fillLeaseCompsTab(
  workbook: ExcelJS.Workbook,
  comps: readonly LeaseCompForExport[],
  assetType: string | null | undefined,
): void {
  if (comps.length === 0) return;
  const ws = workbook.getWorksheet(LEASE_COMPS_SHEET);
  if (ws === undefined) return;

  comps.slice(0, 4).forEach((c, i) => {
    const row = FIRST_COMP_ROW + i;
    // Shared fields — F..L are plain inputs; C (Building Name) is a formula → overwritten by assign.
    put(ws, row, COL.buildingName, c.buildingName);
    put(ws, row, COL.address, c.address);
    put(ws, row, COL.cityState, c.cityState);
    put(ws, row, COL.distance, c.distance);
    put(ws, row, COL.direction, c.direction);
    put(ws, row, COL.totalSf, c.totalSf);
    put(ws, row, COL.yearBuilt, c.yearBuilt);
    put(ws, row, COL.yearRenov, c.yearRenov);
    put(ws, row, COL.occupancy, c.occupancy); // M — formula, overwritten
    // Rate columns N/O/P — asset-type-switched metrics; formulas overwritten by the assignment.
    const [r1, r2, r3] = rateTriple(c, assetType);
    put(ws, row, COL.rate1, r1);
    put(ws, row, COL.rate2, r2);
    put(ws, row, COL.rate3, r3);

    // Photo → this comp's region (aspect-fit, reuse the site-photos helper).
    const box = PHOTO_BOXES[i];
    if (c.image !== undefined && box !== undefined) {
      const imageId = workbook.addImage({ buffer: c.image.buffer as unknown as ExcelJS.Buffer, extension: c.image.extension });
      const anchorBox: SitePhotoBox = { index: i, captionRow: box.tlRow - 1, captionCol: box.tlCol, ...box };
      const p = fittedPlacement(anchorBox, c.image.width, c.image.height);
      ws.addImage(imageId, { tl: p.tl, ext: p.ext, editAs: 'oneCell' } as never);
    }
  });
}
