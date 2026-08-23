/**
 * fillSalesCompsTab — write the servicer's sale comps into the workbook's "Sales Comps" tab
 * (rows 7-10, the Comp 1-4 slots) + embed each comp's photo into its region. EXPORT-ONLY,
 * MINT-SAFE. Reuses the site-photos aspect-fit embed (fittedPlacement + workbook.addImage).
 *
 * The comp data columns (rows 7-10) are PLAIN INPUT cells in this template (verified) — direct
 * writes, no force-overwrite needed here (Lease Comps has type-switched formula columns; that's
 * a later build). Honest-blank: null fields are skipped (cells stay empty). The SUBJECT row (12)
 * is auto-filled by the generator's named ranges and is NEVER touched here.
 */
import type ExcelJS from 'exceljs';
import { fittedPlacement, type SitePhotoBox } from './site-photos-grid.js';
import type { SaleCompForExport } from './sales-comps-for-export.js';

export const SALES_COMPS_SHEET = 'Sales Comps';
const FIRST_COMP_ROW = 7; // Comp 1..4 → rows 7,8,9,10

// Mapped columns (1-indexed) per the template's Sales Comps header row 6.
const COL = {
  buildingName: 3,   // C
  address: 6,        // F
  cityState: 7,      // G
  distance: 8,       // H
  direction: 9,      // I
  totalSf: 10,       // J
  yearBuilt: 11,     // K
  yearRenov: 12,     // L
  occupancyAtSale: 13, // M
  saleDate: 14,      // N
  salePrice: 15,     // O
  capRate: 16,       // P
  pricePerMeasure: 17, // Q
} as const;

// Photo regions below the grid (1-indexed cell boxes). E/I are gap columns.
//   Comp 1 = B16:D21 · Comp 2 = F16:H21 · Comp 3 = B30:D34 · Comp 4 = F30:H34.
const PHOTO_BOXES: readonly Omit<SitePhotoBox, 'index' | 'captionRow' | 'captionCol'>[] = [
  { tlRow: 16, tlCol: 2, brRow: 21, brCol: 4 },
  { tlRow: 16, tlCol: 6, brRow: 21, brCol: 8 },
  { tlRow: 30, tlCol: 2, brRow: 34, brCol: 4 },
  { tlRow: 30, tlCol: 6, brRow: 34, brCol: 8 },
];

/** Write a value only when present (honest-blank: null/undefined leaves the cell untouched). */
function put(ws: ExcelJS.Worksheet, row: number, col: number, value: string | number | null): void {
  if (value === null || value === undefined) return;
  ws.getCell(row, col).value = value;
}

/**
 * Fill the Sales Comps tab from the loan's comps. No-op when the sheet is absent or there are
 * no comps → the workbook is byte-unchanged (opt-in at the caller). Only rows 7-10 + the photo
 * regions are touched; the subject row and every other sheet are left alone.
 */
export function fillSalesCompsTab(workbook: ExcelJS.Workbook, comps: readonly SaleCompForExport[]): void {
  if (comps.length === 0) return;
  const ws = workbook.getWorksheet(SALES_COMPS_SHEET);
  if (ws === undefined) return;

  comps.slice(0, 4).forEach((c, i) => {
    const row = FIRST_COMP_ROW + i;
    put(ws, row, COL.buildingName, c.buildingName);
    put(ws, row, COL.address, c.address);
    put(ws, row, COL.cityState, c.cityState);
    put(ws, row, COL.distance, c.distance);
    put(ws, row, COL.direction, c.direction);
    put(ws, row, COL.totalSf, c.totalSf);
    put(ws, row, COL.yearBuilt, c.yearBuilt);
    put(ws, row, COL.yearRenov, c.yearRenov);
    put(ws, row, COL.occupancyAtSale, c.occupancyAtSale);
    put(ws, row, COL.saleDate, c.saleDate);
    put(ws, row, COL.salePrice, c.salePrice);
    put(ws, row, COL.capRate, c.capRate);
    put(ws, row, COL.pricePerMeasure, c.pricePerMeasure);

    // Embed the photo into this comp's region — aspect-fit (reuse the site-photos helper).
    const box = PHOTO_BOXES[i];
    if (c.image !== undefined && box !== undefined) {
      const imageId = workbook.addImage({ buffer: c.image.buffer as unknown as ExcelJS.Buffer, extension: c.image.extension });
      const anchorBox: SitePhotoBox = { index: i, captionRow: box.tlRow - 1, captionCol: box.tlCol, ...box };
      const p = fittedPlacement(anchorBox, c.image.width, c.image.height);
      ws.addImage(imageId, { tl: p.tl, ext: p.ext, editAs: 'oneCell' } as never);
    }
  });
}
