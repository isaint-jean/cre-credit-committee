/**
 * extractCapexScheduleFromPdf — DETERMINISTIC extractor for PCA Table 2's
 * year-by-year capex schedule.
 *
 * Replaces the prior AI-tier Call B (a hybrid two-call architecture's
 * schedule-extraction step). The AI path was empirically limited to ~50-60%
 * per-year alignment accuracy on the Sunroad anchor fixture — root cause
 * being that unpdf's `extractText({ mergePages: true })` collapses Table 2
 * cells to a flat token stream without column positions, leaving the model
 * to infer year placement from row metadata. Phase A of issue #44 confirmed
 * the ceiling is structural at the text-extraction-API layer (not a
 * model-capability issue — even the highest-capability model hit 7/12 with
 * the same prompt).
 *
 * Approach: bypass the flat-text path. Open the PDF via pdf.js's positional
 * API (already accessible through `unpdf`'s `getDocumentProxy` since
 * `unpdf ^1.6.2` ships pdf.js v5.x). Per text item, `transform[4]` is the
 * x-coordinate in user space. Read Table 2's year-header row, build a
 * `year → x` map, and look up totals-row items at each year-x.
 *
 * Empirical validation (Sunroad page 7):
 *   - Year-header row at y=449.59 with `"YR 1"` … `"YR 12"` items.
 *   - INFLATED TOTALS row at y=243.43 with 6 dollar items at 6 of the 12
 *     year-x positions (years 2, 3, 4, 5, 8, 9). Years with no outlay are
 *     ABSENT from the text stream rather than rendered as `$0`.
 *   - UNINFLATED TOTALS row at y=259.38 with corresponding 6 items.
 *
 * Design choices (per #44 Phase B Step 1 design recon):
 *   - Multi-pattern year-header matcher (handles "YR N", "Year N", bare
 *     integers, and 4-digit calendar years).
 *   - Year-N is derived from the header row itself; no dependency on Call
 *     A's `evaluationPeriodYears` scalar.
 *   - Totals-row-only v1: reads explicitly labeled INFLATED/UNINFLATED
 *     totals rows. Per-row summation fallback deferred to a future
 *     multi-vendor follow-up if a PCA surfaces without labeled totals.
 *   - Zero-cell-by-absence: year-x positions with no item within tolerance
 *     get amount = 0.
 *
 * Failure semantics:
 *   - Page or year-header undetected → return `null` overall (matches the
 *     prior Call B's "Table 2 not found" behavior).
 *   - Year-header detected but a totals row absent → that array is `null`;
 *     the other may still populate. The merge layer at
 *     `buildPcaFromAiResponses` handles partial nulls per existing
 *     discipline.
 */

import { getDocumentProxy } from 'unpdf';

/**
 * Output shape — one schedule entry per year.
 */
export interface CapexScheduleEntry {
  readonly year: number;
  readonly amount: number;
}

/**
 * Top-level result. `null` overall = Table 2 / year-header not detected.
 * Either array may still be null if the corresponding totals row is absent.
 */
export interface CapexScheduleResult {
  readonly inflated: ReadonlyArray<CapexScheduleEntry> | null;
  readonly uninflated: ReadonlyArray<CapexScheduleEntry> | null;
}

/**
 * pdf.js text item with the subset of fields we use. `transform[4]` = x,
 * `transform[5]` = y in user space (PDF affine matrix convention).
 */
interface PositionedTextItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/* ----- tolerance constants (user-space units; PDF default 1pt = 1 unit) ---- */

const Y_BUCKET_TOLERANCE = 1.5;   // items "on the same row" if y within this
const X_ASSIGN_TOLERANCE = 8.0;   // dollar item assigned to nearest year-x within this

/* ----- patterns ----- */

const YEAR_HEADER_PATTERNS: RegExp[] = [
  /^YR\s*\d+$/i,        // "YR 1", "YR 12"
  /^Year\s*\d+$/i,      // "Year 1"
  /^\d{1,2}$/,          // bare 1..99 (small fallback)
  /^\d{4}$/,            // 4-digit calendar years (2024, 2025, …)
];

const INFLATED_TOTALS_LABEL = /^inflated\s*totals?:?$/i;
const UNINFLATED_TOTALS_LABEL = /^uninflated\s*totals?:?$/i;

/* ============================== main function ============================ */

export async function extractCapexScheduleFromPdf(
  pdfBuffer: Buffer,
): Promise<CapexScheduleResult | null> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const numPages = pdf.numPages;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = toPositionedItems(content.items);

    const yearHeader = findYearHeaderRow(items);
    if (yearHeader === null) continue;

    // Year-header found on this page. Treat this as Table 2's page.
    const yearXMap = buildYearXMap(yearHeader);

    const inflated = readTotalsRow(items, yearXMap, INFLATED_TOTALS_LABEL);
    const uninflated = readTotalsRow(items, yearXMap, UNINFLATED_TOTALS_LABEL);

    // If neither totals row resolved, treat the whole detection as a false
    // positive — keep scanning (some PCAs may have a year-header on a TOC
    // page that doesn't have the totals data).
    if (inflated === null && uninflated === null) continue;

    return { inflated, uninflated };
  }

  // No page with a year-header + at least one totals row.
  return null;
}

/* ============================== helpers ================================== */

/**
 * Normalize pdf.js text-content items to our positioned shape, dropping
 * whitespace-only items and ones without a transform matrix.
 */
function toPositionedItems(rawItems: ReadonlyArray<unknown>): PositionedTextItem[] {
  const out: PositionedTextItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as {
      str?: unknown;
      transform?: unknown;
      width?: unknown;
    };
    if (typeof r.str !== 'string') continue;
    const str = r.str.replace(/\s+/g, ' ').trim();
    if (str.length === 0) continue;
    if (!Array.isArray(r.transform) || r.transform.length < 6) continue;
    const x = typeof r.transform[4] === 'number' ? r.transform[4] : null;
    const y = typeof r.transform[5] === 'number' ? r.transform[5] : null;
    if (x === null || y === null) continue;
    const width = typeof r.width === 'number' ? r.width : 0;
    out.push({ str, x, y, width });
  }
  return out;
}

/**
 * Group items into y-buckets (rows). Two items with y-coordinates within
 * `Y_BUCKET_TOLERANCE` are in the same row.
 *
 * Returns a map keyed by the y-coordinate of the FIRST item placed in
 * that bucket (lookups are by-bucket, not by-exact-y).
 *
 * Exported for test discipline.
 */
export function groupItemsByY(
  items: ReadonlyArray<PositionedTextItem>,
  tolerance: number = Y_BUCKET_TOLERANCE,
): Map<number, PositionedTextItem[]> {
  const buckets = new Map<number, PositionedTextItem[]>();
  for (const it of items) {
    let bucketKey: number | null = null;
    for (const key of buckets.keys()) {
      if (Math.abs(key - it.y) < tolerance) {
        bucketKey = key;
        break;
      }
    }
    if (bucketKey === null) bucketKey = it.y;
    let bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(bucketKey, bucket);
    }
    bucket.push(it);
  }
  return buckets;
}

/**
 * Find the row of items that constitutes Table 2's year-header.
 *
 * Strategy: group items by y; for each y-bucket whose items predominantly
 * match a year-header pattern, take the bucket with the most year-header
 * matches AND a count of ≥6 (rules out small spurious matches like an
 * "Year 1" callout in narrative prose). Items in the winning bucket are
 * sorted left-to-right by x and returned.
 *
 * Returns `null` if no plausible header row exists on the page.
 *
 * Exported for test discipline.
 */
export function findYearHeaderRow(
  items: ReadonlyArray<PositionedTextItem>,
): PositionedTextItem[] | null {
  const buckets = groupItemsByY(items);
  let best: PositionedTextItem[] | null = null;
  let bestCount = 0;

  for (const bucket of buckets.values()) {
    const matches = bucket.filter((it) =>
      YEAR_HEADER_PATTERNS.some((p) => p.test(it.str)),
    );
    if (matches.length < 6) continue;          // small noise threshold
    if (matches.length <= bestCount) continue; // strict-better-than wins
    best = matches.slice().sort((a, b) => a.x - b.x);
    bestCount = matches.length;
  }
  return best;
}

/**
 * Build year → x map from a year-header row. Items are assumed sorted by x
 * (which findYearHeaderRow guarantees). Year assignments are 1-indexed by
 * position: leftmost = year 1, next = year 2, …
 *
 * Exported for test discipline.
 */
export function buildYearXMap(
  yearHeader: ReadonlyArray<PositionedTextItem>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < yearHeader.length; i++) {
    map.set(i + 1, yearHeader[i].x);
  }
  return map;
}

/**
 * Parse a dollar-shaped cell value. Returns `null` for unparseable strings
 * (the caller decides whether absent = 0 vs absent = malformed).
 *
 * Accepts: `$5,125`, `$1,234.56`, `5125`, `1,234`, etc. Returns `0` for
 * explicit zero cells (`-`, `—`, `N/A`, `$0`).
 *
 * Exported for test discipline.
 */
export function parseDollarAmount(str: string): number | null {
  const trimmed = str.trim();
  if (trimmed === '') return null;
  if (/^[-—]$/.test(trimmed)) return 0;
  if (/^n\/?a$/i.test(trimmed)) return 0;
  const m = trimmed.match(/^\$?(-?[\d,]+(?:\.\d+)?)$/);
  if (m === null) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

/**
 * Read a totals row given a label regex (`INFLATED_TOTALS_LABEL` or
 * `UNINFLATED_TOTALS_LABEL`). Steps:
 *   1. Find the item whose `str` matches the label.
 *   2. Get all items at that y-bucket (the row).
 *   3. For each year in `yearXMap`, find the closest item by x within
 *      `X_ASSIGN_TOLERANCE`. Parse → amount; missing → 0.
 *
 * Returns the full N-entry array, or `null` if the label is absent.
 */
function readTotalsRow(
  items: ReadonlyArray<PositionedTextItem>,
  yearXMap: ReadonlyMap<number, number>,
  labelPattern: RegExp,
): ReadonlyArray<CapexScheduleEntry> | null {
  const labelItem = items.find((it) => labelPattern.test(it.str));
  if (labelItem === undefined) return null;

  // All items at the same y-bucket as the label.
  const rowItems = items.filter(
    (it) => Math.abs(it.y - labelItem.y) < Y_BUCKET_TOLERANCE,
  );

  const sortedYears = [...yearXMap.keys()].sort((a, b) => a - b);
  const out: CapexScheduleEntry[] = [];
  for (const year of sortedYears) {
    const yearX = yearXMap.get(year);
    if (yearX === undefined) continue;
    const nearest = findNearestItemByX(rowItems, yearX, X_ASSIGN_TOLERANCE);
    if (nearest === null) {
      out.push({ year, amount: 0 });
      continue;
    }
    const amount = parseDollarAmount(nearest.str);
    out.push({ year, amount: amount ?? 0 });
  }
  return out;
}

/**
 * Find the item in `items` whose x is closest to `targetX`, within
 * `tolerance`. Returns `null` if no item within tolerance.
 *
 * Exported for test discipline.
 */
export function findNearestItemByX(
  items: ReadonlyArray<PositionedTextItem>,
  targetX: number,
  tolerance: number = X_ASSIGN_TOLERANCE,
): PositionedTextItem | null {
  let best: PositionedTextItem | null = null;
  let bestDist = Infinity;
  for (const it of items) {
    const dist = Math.abs(it.x - targetX);
    if (dist > tolerance) continue;
    if (dist < bestDist) {
      best = it;
      bestDist = dist;
    }
  }
  return best;
}
