/**
 * BMARK 2024-V8 prelim-tape parser — a .xlsx file → `IncomingTape`.
 *
 * Reads one prelim-tape Excel file from the BMARK 2024-V8 lineage and emits an
 * `IncomingTape` ready for `advanceTapePhaseA`. The reseed script feeds each of
 * the 13 chosen tape files through this parser in date order.
 *
 * ★ Identity key: the parser sets `originatorLoanRef` to the **normalized
 *   property name** (NOT the per-tape Loan ID, which renumbers across tapes).
 *   Step-0 verification of the real tapes proved property-name + a 3-entry
 *   alias map gives a stable, collision-free identity across all 13 tapes.
 *
 * Column map (1-indexed; matches Isabelle's column survey on the Final tape):
 *   1  Loan ID                       — display order only
 *   4  Mortgage Loan Seller          — bank code, may be co-seller "X, Y"
 *   6  Property Name                 — RAW; normalized for originatorLoanRef
 *   8  City
 *   9  State
 *  11  Property Type                 — raw label; mapped to AssetType
 *  19  Cut-off Date Balance ($)      — the securitization balance (per-tape)
 *
 * Whole-loan filter: rows whose Loan ID is an INTEGER are whole loans; decimals
 * (e.g. 5.01, 5.02) are property breakouts and are skipped per the whole-loan
 * decision.
 *
 * Header row: 3 (1-indexed). Sheet name varies ("BMARK 2024-V8" on the early
 * tapes, "Tape" on later ones) — the parser auto-detects the widest sheet.
 */

import ExcelJS from 'exceljs';
import type {
  AssetType,
  ISODateTime,
  PoolId,
  TapeId,
  TapeOriginatorSummary,
} from '@cre/contracts';
import type { IncomingTape, IncomingTapeRow } from './pool/advance-tape.service.js';

/* -------------------------------------------------------------------------- */
/* Normalization (Step 0 verified collision-free + continuity-preserving)     */
/* -------------------------------------------------------------------------- */

const DASH_RE = /[‐-―]/g;       // various Unicode dashes → ASCII hyphen
const STRIP_PUNCT_RE = /[`.,'"()\[\]{}/\\*]/g;
const WS_RE = /\s+/g;

/**
 * Documented data variations discovered on the real BMARK tapes (recon §C
 * near-miss hunt). Same property, different spelling mid-lineage. Map LATER
 * forms → EARLIER form so carry-over preserves identity.
 *
 *   "Woodman Townhomes"  (5_30+) ← "Woodman Town Homes" (4_19 → 5_23)
 *   "Rechler ... - A"    (5_23+) ← "Rechler ... - Pool A" (5_2 → 5_17)
 *   "Rechler ... - B"    (5_23+) ← "Rechler ... - Pool B" (5_2 → 5_17)
 *
 * Extend this map as new data variations surface.
 */
const TAPE_NAME_ALIASES: Record<string, string> = {
  'woodman townhomes':                          'woodman town homes',
  'rechler industrial portfolio - a':           'rechler industrial portfolio - pool a',
  'rechler industrial portfolio - b':           'rechler industrial portfolio - pool b',
};

export function normalizePropertyName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw);
  s = s.normalize('NFKC');
  s = s.replace(DASH_RE, '-');
  s = s.trim().toLowerCase();
  s = s.replace(STRIP_PUNCT_RE, ' ');
  s = s.replace(WS_RE, ' ').trim();
  if (s.length === 0) return null;
  return TAPE_NAME_ALIASES[s] ?? s;
}

/* -------------------------------------------------------------------------- */
/* Column index map (0-indexed, exceljs uses 1-indexed but rows.values[]      */
/* makes the first cell index 1; we index by name via the header row).        */
/* -------------------------------------------------------------------------- */

const HEADER_ROW = 3;

const COLS = {
  loanId:        'Loan ID',
  seller:        'Mortgage Loan Seller',
  propertyName:  'Property Name',
  city:          'City',
  state:         'State',
  propertyType:  'Property Type',
  cutOffBalance: 'Cut-off Date Balance ($)',
} as const;

/* -------------------------------------------------------------------------- */
/* AssetType mapping (raw tape labels → @cre/contracts AssetType)             */
/* -------------------------------------------------------------------------- */
// Best-effort: anything else → null (the contract's assetType is `AssetType | null`).
const PROPERTY_TYPE_MAP: Record<string, AssetType> = {
  'office':                'Office',
  'retail':                'Retail',
  'multifamily':           'Multifamily',
  'hospitality':           'Hotel',
  'hotel':                 'Hotel',
  'industrial':            'Industrial',
  'self-storage':          'SelfStorage',
  'self storage':          'SelfStorage',
  'mixed use':             'MixedUse',
  'mixed-use':             'MixedUse',
  'mhc':                   'MHC',
  'manufactured housing':  'MHC',
};

function mapAssetType(raw: string | null): AssetType | null {
  if (raw === null) return null;
  const key = raw.toLowerCase().trim();
  return PROPERTY_TYPE_MAP[key] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Header detection + sheet selection                                         */
/* -------------------------------------------------------------------------- */

interface ParseTapeOptions {
  readonly poolId: PoolId;
  readonly version: number;
  readonly tapeDate: ISODateTime;
  readonly receivedAt: ISODateTime;
  readonly priorTapeId: TapeId | null;
  readonly sourceLabel: string;
}

/**
 * Parse one BMARK 2024-V8 prelim-tape .xlsx → IncomingTape.
 */
export async function parseBmarkTapeXlsx(
  filePath: string,
  opts: ParseTapeOptions,
): Promise<IncomingTape> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Auto-detect the widest sheet (sheet name varies across tapes — early ones
  // use "BMARK 2024-V8", later ones use "Tape").
  let chosen: ExcelJS.Worksheet | null = null;
  let maxCols = 0;
  wb.eachSheet((ws) => {
    if (ws.columnCount > maxCols) {
      maxCols = ws.columnCount;
      chosen = ws;
    }
  });
  if (chosen === null) {
    throw new Error(`parseBmarkTapeXlsx: no sheets found in ${filePath}`);
  }
  const ws: ExcelJS.Worksheet = chosen;

  // Build header → column index map from row 3.
  const headerRow = ws.getRow(HEADER_ROW);
  const colByName = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = String(cell.value ?? '').trim();
    if (text.length > 0) colByName.set(text, colNumber);
  });

  function colOf(name: string): number {
    const idx = colByName.get(name);
    if (idx === undefined) {
      throw new Error(
        `parseBmarkTapeXlsx: missing required column "${name}" in ${filePath} (header row ${HEADER_ROW})`,
      );
    }
    return idx;
  }

  const cLoanId      = colOf(COLS.loanId);
  const cSeller      = colOf(COLS.seller);
  const cName        = colOf(COLS.propertyName);
  const cCity        = colOf(COLS.city);
  const cState       = colOf(COLS.state);
  const cPropType    = colOf(COLS.propertyType);
  const cCutoffBal   = colOf(COLS.cutOffBalance);

  const rows: IncomingTapeRow[] = [];
  let tapePosition = 0;
  let totalLoanCount = 0;

  for (let r = HEADER_ROW + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // Loan ID is a FORMULA cell on the prelim tapes (IFERROR(IF(B=Property,...))).
    // Use numberOrNull to unwrap the formula result.
    const loanIdNum = numberOrNull(row.getCell(cLoanId).value);
    if (loanIdNum === null) continue;

    // Whole-loan filter: integer Loan IDs only; skip decimal property breakouts.
    if (!Number.isInteger(loanIdNum)) continue;

    const rawName = stringOrNull(row.getCell(cName).value);
    if (rawName === null) continue;  // skip rows without a property name

    const normalized = normalizePropertyName(rawName);
    if (normalized === null) continue;

    tapePosition += 1;
    totalLoanCount += 1;

    const propertyType = stringOrNull(row.getCell(cPropType).value);
    const assetType = mapAssetType(propertyType);

    rows.push({
      // ★ originatorLoanRef = the NORMALIZED property name (the stable identity)
      originatorLoanRef:  normalized,
      // ★ dealRef = a synthetic engine handle derived from the normalized name.
      //   The funnel lookup will return found:false until an analysis is created.
      //   Format: `bmark2024v8-<sanitized-slug>` so it's URL-safe and re-derivable.
      dealRef:            'bmark2024v8-' + slug(normalized),
      propertyName:       rawName,                                    // RAW (for display)
      assetType:          assetType,                                   // typed
      tapePosition:       tapePosition,
      cutOffBalance:      numberOrNull(row.getCell(cCutoffBal).value),
      propertyType:       propertyType,                                // raw label
      mortgageLoanSeller: stringOrNull(row.getCell(cSeller).value),
      city:               stringOrNull(row.getCell(cCity).value),
      state:              stringOrNull(row.getCell(cState).value),
    });
  }

  const summary: TapeOriginatorSummary = {
    originatorLoanCount:   totalLoanCount,
    originatorDroppedRefs: [],  // not derivable from a single-tape file
    originatorKickedRefs:  [],
    sourceLabel:           opts.sourceLabel,
  };

  return {
    poolId:             opts.poolId,
    version:            opts.version,
    tapeDate:           opts.tapeDate,
    receivedAt:         opts.receivedAt,
    priorTapeId:        opts.priorTapeId,
    rows,
    originatorSummary:  summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Cell helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Excel formula cells come back as `{ formula, result, … }`. Unwrap to the
 *  resolved value before applying any other parsing. Also handles hyperlinks
 *  and shared-string objects. */
function unwrap(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: unknown; text?: unknown; hyperlink?: unknown };
    if (o.result !== undefined)   return o.result;
    if (o.richText !== undefined) {
      // richText is an array of { text, font } segments
      if (Array.isArray(o.richText)) {
        return o.richText.map((seg: { text?: string }) => seg?.text ?? '').join('');
      }
    }
    if (o.text !== undefined) return o.text;
  }
  return v;
}

function stringOrNull(v: unknown): string | null {
  const u = unwrap(v);
  if (u === null || u === undefined) return null;
  const s = String(u).trim();
  return s.length === 0 ? null : s;
}

function numberOrNull(v: unknown): number | null {
  const u = unwrap(v);
  if (u === null || u === undefined || u === '') return null;
  const n = typeof u === 'number' ? u : Number(u);
  return Number.isFinite(n) ? n : null;
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
