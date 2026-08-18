/**
 * Site Photos worksheet — Chunk 2 (STRUCTURE only). Adds a dedicated "Site Photos" sheet
 * to the exported workbook, laid out as a count-agnostic 2-column grid of empty anchor
 * BOXES (the boxes Chunk 3 will place resized photos into via worksheet.addImage). No images
 * yet; no jimp. Export/render-only — never touches the mint.
 *
 * The prototype proved tl/br cell-range anchors are the clean grid primitive. `sitePhotoBoxAnchors`
 * is the reusable helper Chunk 3 calls: given N photos → N box rectangles, 2 per row, growing
 * rows as needed. Coordinates are 1-indexed (ExcelJS getCell/mergeCells); Chunk 3 derives the
 * 0-indexed addImage anchor as (tlCol-1, tlRow-1) → (brCol, brRow).
 */
import type ExcelJS from 'exceljs';

export const SITE_PHOTOS_SHEET = 'Site Photos';

/** A photo to embed — the raw bytes + an exceljs image extension + an optional caption. */
export interface SitePhotoImage {
  readonly buffer: Buffer;
  readonly extension: 'png' | 'jpeg' | 'gif';
  readonly caption?: string;
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

    // Chunk 3 — embed the photo into the box's tl/br cell-range anchor (0-indexed for exceljs;
    // sitePhotoBoxAnchors is 1-indexed). editAs 'oneCell' moves-with-cells without resizing.
    if (photo !== undefined) {
      const imageId = workbook.addImage({ buffer: photo.buffer as unknown as ExcelJS.Buffer, extension: photo.extension });
      // exceljs's runtime accepts a partial {col,row} anchor (the prototype proved this);
      // its .d.ts Anchor type demands native* offsets, so cast the range.
      ws.addImage(imageId, {
        tl: { col: b.tlCol - 1, row: b.tlRow - 1 },
        br: { col: b.brCol, row: b.brRow },
        editAs: 'oneCell',
      } as never);
    }
  }
}
