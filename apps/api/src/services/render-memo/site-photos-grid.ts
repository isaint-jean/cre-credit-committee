/**
 * Site Photos worksheet — a dedicated "Site Photos" sheet in the exported workbook, laid out
 * as a count-agnostic 2-column grid of boxes. Export/render-only — never touches the mint.
 *   Chunk 2: the empty anchor grid.  Chunk 3: embed the photos into the boxes.
 *   Chunk 4: photos arrive resized (jimp, in site-photos-for-export) and carry pixel dims, so
 *            each is placed aspect-correct — fitted inside its box, centered, NO stretch.
 *
 * `sitePhotoBoxAnchors(N)` → N box rectangles (2 per row, rows grow). Coordinates are 1-indexed
 * (ExcelJS getCell/mergeCells); the 0-indexed addImage anchor is (tlCol-1, tlRow-1) → (brCol,
 * brRow). `fittedPlacement` converts a box + image dims into an aspect-correct oneCell anchor.
 */
import type ExcelJS from 'exceljs';

export const SITE_PHOTOS_SHEET = 'Site Photos';

/** A photo to embed — the raw bytes + an exceljs image extension + an optional caption. */
export interface SitePhotoImage {
  readonly buffer: Buffer;
  readonly extension: 'png' | 'jpeg' | 'gif';
  readonly caption?: string;
  // Chunk 4 — resized pixel dims. When BOTH are present the image is placed aspect-correct
  // (fit inside the box, centered, no stretch); absent → the legacy tl/br stretch (Chunk 3).
  readonly width?: number;
  readonly height?: number;
}

/** One photo box: the 1-indexed cell rectangle for the image + its caption cell. */
export interface SitePhotoBox {
  readonly index: number;       // 0-based box number
  readonly tlRow: number;       // top-left (1-indexed)
  readonly tlCol: number;
  readonly brRow: number;       // bottom-right (1-indexed, inclusive)
  readonly brCol: number;
  readonly captionRow: number;  // the "Photo N" caption cell (row above the box)
  readonly captionCol: number;
}

const HEADER_ROW = 1;
const FIRST_CAPTION_ROW = 3;   // leave row 1 header + row 2 gap
const COLS_PER_BOX = 3;
const ROWS_PER_BOX = 11;
const COL_GAP = 1;             // blank column between the two box columns
const ROW_BLOCK = 1 /* caption */ + ROWS_PER_BOX + 2 /* gap below */;

// Pixel size of one grid cell, matching the width/height this sheet sets below (col width 16,
// row height 16pt). Deliberately conservative (slightly small) so a fitted image stays INSIDE
// the box border rather than bleeding past it — small gaps are fine (letterbox).
const COL_PX = 110;
const ROW_PX = 20;
const FIT_MARGIN = 0.9;        // leave a hair of padding inside the box

/**
 * Chunk 4 — aspect-preserving placement. Given a box and the image's pixel dimensions, fit
 * the WHOLE image inside the box (letterbox), centered, WITHOUT stretching or cropping. Only
 * downscales for the fit (never enlarges past the resized bytes). Returns an exceljs oneCell
 * anchor: a fractional `tl` (for centering) + a fixed pixel `ext` (so no stretch to fill).
 */
export function fittedPlacement(
  box: SitePhotoBox,
  imgW: number,
  imgH: number,
): { tl: { col: number; row: number }; ext: { width: number; height: number } } {
  const boxWpx = (box.brCol - box.tlCol + 1) * COL_PX;
  const boxHpx = (box.brRow - box.tlRow + 1) * ROW_PX;
  const maxW = boxWpx * FIT_MARGIN;
  const maxH = boxHpx * FIT_MARGIN;
  // min(...,1): fit inside the box, but never upscale a small photo (avoid pixelation).
  const scale = Math.min(maxW / imgW, maxH / imgH, 1);
  const fitW = Math.max(1, Math.round(imgW * scale));
  const fitH = Math.max(1, Math.round(imgH * scale));
  const offXpx = (boxWpx - fitW) / 2;
  const offYpx = (boxHpx - fitH) / 2;
  return {
    // 0-indexed for exceljs; fractional col/row centers the image within the box.
    tl: { col: (box.tlCol - 1) + offXpx / COL_PX, row: (box.tlRow - 1) + offYpx / ROW_PX },
    ext: { width: fitW, height: fitH },
  };
}

/**
 * ★ The reusable anchor helper — given N boxes, returns N rectangles laid out 2 per row
 * (adding rows as N grows). Chunk 3 calls this to place N photos into the grid.
 */
export function sitePhotoBoxAnchors(count: number): SitePhotoBox[] {
  const boxes: SitePhotoBox[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    const gridRow = Math.floor(i / 2);
    const gridCol = i % 2;
    const tlCol = 1 + gridCol * (COLS_PER_BOX + COL_GAP);
    const captionRow = FIRST_CAPTION_ROW + gridRow * ROW_BLOCK;
    const tlRow = captionRow + 1;
    boxes.push({
      index: i,
      captionRow,
      captionCol: tlCol,
      tlRow,
      tlCol,
      brRow: tlRow + ROWS_PER_BOX - 1,
      brCol: tlCol + COLS_PER_BOX - 1,
    });
  }
  return boxes;
}

/**
 * Add the "Site Photos" grid to the workbook. Idempotent (no-op if the sheet exists).
 *  - Chunk 2 (no `photos`): header + bordered boxes + "Photo N" captions, empty default grid.
 *  - Chunk 3 (`photos` present): COUNT-AGNOSTIC — one box per photo (2/row, rows grow), each
 *    photo EMBEDDED into its box via workbook.addImage + worksheet.addImage (tl/br cell-range,
 *    editAs 'oneCell'). No resize — original bytes (Chunk 4 adds jimp). Empty photos → the empty
 *    default grid so the tab stays discoverable.
 */
export function addSitePhotosGrid(
  workbook: ExcelJS.Workbook,
  opts: { readonly dealName?: string; readonly boxCount?: number; readonly photos?: readonly SitePhotoImage[] } = {},
): void {
  if (workbook.getWorksheet(SITE_PHOTOS_SHEET) !== undefined) return;
  const photos = opts.photos ?? [];
  const count = photos.length > 0 ? photos.length : Math.max(0, opts.boxCount ?? 8);
  const ws = workbook.addWorksheet(SITE_PHOTOS_SHEET);

  for (let c = 1; c <= 8; c++) ws.getColumn(c).width = 16;

  const header = ws.getCell(HEADER_ROW, 1);
  header.value = opts.dealName && opts.dealName.trim().length > 0 ? `Site Photos — ${opts.dealName.trim()}` : 'Site Photos';
  header.font = { bold: true, size: 13 };
  ws.mergeCells(HEADER_ROW, 1, HEADER_ROW, 7);

  const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
  for (const b of sitePhotoBoxAnchors(count)) {
    const photo = photos[b.index];
    const cap = ws.getCell(b.captionRow, b.captionCol);
    cap.value = photo?.caption ?? `Photo ${b.index + 1}`;
    cap.font = { size: 10, color: { argb: 'FF666666' } };

    // The box: bordered light-gray frame + row heights (behind any embedded image).
    ws.mergeCells(b.tlRow, b.tlCol, b.brRow, b.brCol);
    const box = ws.getCell(b.tlRow, b.tlCol);
    box.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    box.border = { top: thin, left: thin, bottom: thin, right: thin };
    box.alignment = { horizontal: 'center', vertical: 'middle' };
    for (let r = b.tlRow; r <= b.brRow; r++) ws.getRow(r).height = 16;

    if (photo !== undefined) {
      const imageId = workbook.addImage({ buffer: photo.buffer as unknown as ExcelJS.Buffer, extension: photo.extension });
      // exceljs's runtime accepts a partial {col,row} anchor (the prototype proved this); its
      // .d.ts Anchor type demands native* offsets, so the range is cast.
      if (photo.width !== undefined && photo.height !== undefined && photo.width > 0 && photo.height > 0) {
        // Chunk 4 — aspect-preserving: fixed-size `ext` fitted to the box (no stretch), tl
        // fractional to center it (letterbox). Portraits no longer distort.
        const p = fittedPlacement(b, photo.width, photo.height);
        ws.addImage(imageId, { tl: p.tl, ext: p.ext, editAs: 'oneCell' } as never);
      } else {
        // Chunk 3 fallback — tl/br cell-range stretch (used only when dims are unknown).
        ws.addImage(imageId, {
          tl: { col: b.tlCol - 1, row: b.tlRow - 1 },
          br: { col: b.brCol, row: b.brRow },
          editAs: 'oneCell',
        } as never);
      }
    }
  }
}
