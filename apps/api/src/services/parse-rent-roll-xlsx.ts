/**
 * parseRentRollXlsx — convert an uploaded rent-roll xlsx/xlsm into a RentRoll record.
 *
 * Discipline (Batch 1 evidence-gated build):
 *   - NO invented values. Missing field on a row -> null.
 *   - NO row inference. Vacant rows must be explicitly marked (status = 'VACANT')
 *     in the source; we don't fabricate vacancy from missing tenant names.
 *   - NO synthetic aggregates. Tenant count, occupied SF, etc. are derivable
 *     downstream — this parser only emits raw lines.
 *
 * Recognized column-header families (case-insensitive, whitespace-tolerant). The
 * parser scans the first 50 rows for a row that contains AT LEAST a tenant-name
 * column AND a square-feet column; that row is the header. Tenant rows are every
 * non-empty row below the header until a blank row OR a totals row is reached.
 *
 * Lease-type strings are normalized via LEASE_TYPE_NORMALIZE; unrecognized values
 * map to 'UNKNOWN' (NOT silently coerced to 'OTHER').
 */

import ExcelJS from 'exceljs';
import {
  type LeaseType,
  type RentRoll,
  type RentRollLine,
  type RentRollSource,
  type TenantStatus,
} from '@cre/contracts';
import { computeRentRollId } from '../util/content-hash.js';

interface ColumnMap {
  tenantName?: number;
  suite?: number;
  squareFeet?: number;
  leaseStart?: number;
  leaseEnd?: number;
  inPlaceRent?: number;
  marketRent?: number;
  leaseType?: number;
  recoveries?: number;
  otherIncome?: number;
  newTiPsf?: number;
  renewTiPsf?: number;
  newLcPct?: number;
  renewLcPct?: number;
  downtimeMonths?: number;
  status?: number;
  notes?: number;
  // Unit-side columns (multifamily / MHC / student housing).
  bedrooms?: number;
  bathrooms?: number;
  unitType?: number;
  inPlaceRentMonthly?: number;
  marketRentMonthly?: number;
  concessionsMonthly?: number;
  securityDeposit?: number;
}

// PATTERN ORDER MATTERS: the loop in `findHeaderRow` `break`s on the first
// matching regex. Unit-side patterns are checked BEFORE the generic
// "rent" / "market rent" patterns so headers like "Monthly Market Rent"
// map to `marketRentMonthly` (a unit signal), not to `marketRent` (a tenant
// signal) — otherwise the detector would misclassify multifamily rolls as
// office.
const HEADER_PATTERNS: { readonly key: keyof ColumnMap; readonly regex: RegExp }[] = [
  // ----- Unit-specific patterns FIRST (strong multifamily signals) ---------
  { key: 'bedrooms',           regex: /bedroom|^br$|#\s*beds?/i },
  { key: 'bathrooms',          regex: /bathroom|^ba$|#\s*baths?/i },
  { key: 'unitType',           regex: /unit\s*type|floor\s*plan/i },
  { key: 'inPlaceRentMonthly', regex: /monthly\s*(?:rent|in[\s-]*place|contract|market)|rent\/mo|rent\s*per\s*month/i },
  { key: 'marketRentMonthly',  regex: /monthly\s*market\s*rent|market\s*rent\/mo/i },
  { key: 'concessionsMonthly', regex: /concession/i },
  { key: 'securityDeposit',    regex: /security\s*deposit|^deposit$/i },
  // ----- Shared columns (both kinds) ---------------------------------------
  { key: 'tenantName',         regex: /tenant\s*name|tenant$/i },
  { key: 'suite',              regex: /suite|unit\s*(?:id|#|number)|^unit$/i },
  { key: 'squareFeet',         regex: /(?:^|\b)sf\b|sq\.?\s*ft|square\s*feet|gla|nra/i },
  { key: 'leaseStart',         regex: /lease\s*start|commencement|start\s*date|move[\s-]?in/i },
  { key: 'leaseEnd',           regex: /lease\s*end|expir|maturity|end\s*date/i },
  { key: 'status',             regex: /status|occupanc/i },
  { key: 'notes',              regex: /notes|comments/i },
  // ----- Tenant-specific patterns LAST (strong office signals) -------------
  { key: 'inPlaceRent',        regex: /in[\s-]*place\s*rent|current\s*rent|contract\s*rent|base\s*rent|annual\s*rent/i },
  { key: 'marketRent',         regex: /market\s*rent|appraisal\s*rent/i },
  { key: 'leaseType',          regex: /lease\s*type|recovery\s*type/i },
  { key: 'recoveries',         regex: /recover|reimburs/i },
  { key: 'otherIncome',        regex: /other\s*income|parking|storage/i },
  { key: 'newTiPsf',           regex: /new\s*ti(?!\s*lc)/i },
  { key: 'renewTiPsf',         regex: /renew\s*ti(?!\s*lc)/i },
  { key: 'newLcPct',           regex: /new\s*lc/i },
  { key: 'renewLcPct',         regex: /renew\s*lc/i },
  { key: 'downtimeMonths',     regex: /downtime|down\s*time|vacancy\s*months/i },
];

const LEASE_TYPE_NORMALIZE: { readonly [k: string]: LeaseType } = {
  nnn: 'NNN', 'triple net': 'NNN', 'triple-net': 'NNN',
  mg: 'MG', 'modified gross': 'MG',
  fsg: 'FSG', 'full service': 'FSG', 'full service gross': 'FSG',
  gross: 'GROSS',
  ig: 'IG', 'industrial gross': 'IG',
};

const STATUS_NORMALIZE: { readonly [k: string]: TenantStatus } = {
  occupied: 'OCCUPIED',
  vacant: 'VACANT',
  preleased: 'PRELEASED', 'pre-leased': 'PRELEASED', 'pre leased': 'PRELEASED',
  holdover: 'HOLDOVER', 'hold over': 'HOLDOVER', 'hold-over': 'HOLDOVER',
};

function cellString(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim() || null;
  }
  if (typeof v === 'object' && 'text' in v) {
    const t = (v as { text: unknown }).text;
    return typeof t === 'string' ? t.trim() || null : null;
  }
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'string') return r.trim() || null;
    if (typeof r === 'number') return String(r);
  }
  return null;
}

function cellNumber(cell: ExcelJS.Cell): number | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return null;
}

function cellDate(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function findHeaderRow(worksheet: ExcelJS.Worksheet): { row: number; map: ColumnMap } | null {
  const maxScan = Math.min(50, worksheet.rowCount);
  for (let r = 1; r <= maxScan; r++) {
    const map: ColumnMap = {};
    const row = worksheet.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = cellString(cell);
      if (text === null) return;
      for (const { key, regex } of HEADER_PATTERNS) {
        if (regex.test(text) && map[key] === undefined) {
          map[key] = col;
          break;
        }
      }
    });
    // A header row qualifies if it has EITHER:
    //   (tenant) tenantName + squareFeet          — the original office signal
    //   (unit)   suite/unitId + (bedrooms | unitType | inPlaceRentMonthly | concessionsMonthly)
    //                                              — multifamily signals; suite serves
    //                                                as unitId via the shared regex
    //                                                /suite|unit\s*(?:id|#|number)|^unit$/
    const hasTenantSig = map.tenantName !== undefined && map.squareFeet !== undefined;
    const hasUnitId    = map.suite !== undefined;
    const hasUnitSig   = hasUnitId && (
      map.bedrooms !== undefined ||
      map.unitType !== undefined ||
      map.inPlaceRentMonthly !== undefined ||
      map.concessionsMonthly !== undefined
    );
    if (hasTenantSig || hasUnitSig) return { row: r, map };
  }
  return null;
}

/**
 * Classify the header row as tenant- or unit-shaped using STRONG signals.
 *
 *   STRONG TENANT signals: leaseType, recoveries, TI/LC, downtime, marketRent
 *     — these columns are office-vocabulary specific (NNN/MG/FSG, tenant
 *       improvements, leasing commissions, expense reimbursements).
 *   STRONG UNIT signals: bedrooms, bathrooms, unitType, inPlaceRentMonthly
 *     (explicitly monthly), concessionsMonthly — these are residential
 *     vocabulary with no office analog.
 *
 * Decision rule:
 *   - At least one tenant signal AND zero unit signals → 'tenant'
 *   - At least one unit signal AND zero tenant signals → 'unit'
 *   - Both signal sets present (mixed-use header?) → 'tenant' (conservative;
 *       the tenant parser handles a richer field set and the office-flavored
 *       columns will preserve more data — the unit columns are dropped on
 *       this row but the union still flags semantic mismatch downstream)
 *   - Neither signal set present (just suite/SF/rent — ambiguous) → 'tenant'
 *       (preserves prior behavior; the deal's asset class downstream is the
 *       authoritative classifier and dim 5/6 N/A-by-asset gates protect the
 *       doctrine score for any misclassified-as-tenant multifamily input).
 *
 * NOTE: parsing runs UPSTREAM of asset classification (the call site
 * `routes/analysis.routes.ts:1066` passes only a buffer), so content
 * detection is the only signal available today. A future enhancement could
 * thread an optional `assetTypeHint` parameter through ParseRentRollOptions
 * when the upload flow gains an operator-supplied asset-class field at
 * deal setup.
 */
function detectRentRollKind(map: ColumnMap): 'tenant' | 'unit' {
  const tenantSignals =
    (map.leaseType        !== undefined ? 1 : 0) +
    (map.recoveries       !== undefined ? 1 : 0) +
    (map.newTiPsf         !== undefined ? 1 : 0) +
    (map.renewTiPsf       !== undefined ? 1 : 0) +
    (map.newLcPct         !== undefined ? 1 : 0) +
    (map.renewLcPct       !== undefined ? 1 : 0) +
    (map.downtimeMonths   !== undefined ? 1 : 0) +
    (map.marketRent       !== undefined ? 1 : 0);
  const unitSignals =
    (map.bedrooms           !== undefined ? 1 : 0) +
    (map.bathrooms          !== undefined ? 1 : 0) +
    (map.unitType           !== undefined ? 1 : 0) +
    (map.inPlaceRentMonthly !== undefined ? 1 : 0) +
    (map.concessionsMonthly !== undefined ? 1 : 0);
  if (unitSignals > 0 && tenantSignals === 0) return 'unit';
  return 'tenant';
}

function isTotalsRow(worksheet: ExcelJS.Worksheet, row: number, map: ColumnMap): boolean {
  // Heuristic: a totals row has the word "total" or "subtotal" in the tenant-name
  // or first column, and typically has aggregated values without a tenant identity.
  const nameCell = map.tenantName !== undefined ? worksheet.getCell(row, map.tenantName) : null;
  const name = nameCell ? cellString(nameCell) : null;
  if (name && /total|subtotal|grand\s*total/i.test(name)) return true;
  return false;
}

function isEmptyRow(worksheet: ExcelJS.Worksheet, row: number, map: ColumnMap): boolean {
  const cols = Object.values(map).filter((c): c is number => typeof c === 'number');
  for (const col of cols) {
    const cell = worksheet.getCell(row, col);
    if (cellString(cell) !== null) return false;
  }
  return true;
}

export interface ParseRentRollOptions {
  readonly source?: RentRollSource;            // default 'rent_roll_file'
  readonly worksheetName?: string;             // optional explicit sheet selector
}

export function parseRentRollXlsx(buffer: Buffer, options: ParseRentRollOptions = {}): Promise<RentRoll> {
  return parseRentRollXlsxImpl(buffer, options);
}

async function parseRentRollXlsxImpl(buffer: Buffer, options: ParseRentRollOptions): Promise<RentRoll> {
  const source: RentRollSource = options.source ?? 'rent_roll_file';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);

  // Worksheet selection: explicit name wins; otherwise the first sheet whose
  // header row scan succeeds. Don't auto-pick by sheet name regex — broker rent
  // rolls use idiosyncratic sheet names.
  let target: ExcelJS.Worksheet | null = null;
  let header: { row: number; map: ColumnMap } | null = null;
  if (options.worksheetName) {
    const ws = wb.getWorksheet(options.worksheetName);
    if (!ws) throw new Error('parseRentRollXlsx: worksheet not found: ' + options.worksheetName);
    target = ws;
    header = findHeaderRow(ws);
  } else {
    wb.eachSheet((ws) => {
      if (target !== null) return;
      const h = findHeaderRow(ws);
      if (h !== null) { target = ws; header = h; }
    });
  }
  if (!target || !header) {
    throw new Error('parseRentRollXlsx: no recognizable rent-roll header row found');
  }
  const ws = target as ExcelJS.Worksheet;
  const headerRow = header.row;
  const map = header.map;

  // Header-area scan for asOfDate / propertyName. These typically appear as
  // labeled rows ABOVE the header. Scan rows 1..headerRow-1.
  let asOfDate: string | null = null;
  let propertyName: string | null = null;
  for (let r = 1; r < headerRow; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = cellString(cell);
      if (text === null) return;
      if (/rent\s*roll\s*date/i.test(text) && asOfDate === null) {
        for (let off = 1; off <= 4; off++) {
          const adj = ws.getCell(r, col + off);
          const d = cellDate(adj) ?? cellString(adj);
          if (d) { asOfDate = d; break; }
        }
      }
      if (/property\s*name/i.test(text) && propertyName === null) {
        for (let off = 1; off <= 4; off++) {
          const adj = ws.getCell(r, col + off);
          const v = cellString(adj);
          if (v) { propertyName = v; break; }
        }
      }
    });
  }

  // Detect tenant- vs unit-shape from the header signals, then dispatch
  // each row to the appropriate parser. Detection is content-only because
  // parsing runs upstream of asset classification — see
  // `detectRentRollKind` for the signal weights and ambiguity-default
  // rationale.
  const kind = detectRentRollKind(map);
  const lines: RentRollLine[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    if (isTotalsRow(ws, r, map)) continue;
    if (isEmptyRow(ws, r, map)) continue;
    lines.push(kind === 'unit'
      ? parseUnitRow(ws, r, map)
      : parseTenantRow(ws, r, map));
  }

  const body = { asOfDate, propertyName, source, lines };
  return { id: computeRentRollId(body), ...body };
}

function parseTenantRow(ws: ExcelJS.Worksheet, row: number, map: ColumnMap): RentRollLine {
  const get = (col: number | undefined) => (col === undefined ? null : ws.getCell(row, col));
  const num = (col: number | undefined) => (col === undefined ? null : cellNumber(ws.getCell(row, col)));
  const str = (col: number | undefined) => (col === undefined ? null : cellString(ws.getCell(row, col)));
  const date = (col: number | undefined) => (col === undefined ? null : cellDate(ws.getCell(row, col)));

  const leaseTypeRaw = str(map.leaseType);
  const leaseType: LeaseType = leaseTypeRaw === null
    ? 'UNKNOWN'
    : (LEASE_TYPE_NORMALIZE[leaseTypeRaw.toLowerCase().trim()] ?? 'OTHER');

  const statusRaw = str(map.status);
  const status: TenantStatus = statusRaw === null
    ? 'UNKNOWN'
    : (STATUS_NORMALIZE[statusRaw.toLowerCase().trim()] ?? 'UNKNOWN');

  void get;
  return {
    kind: 'tenant',
    tenantName:        str(map.tenantName),
    suite:             str(map.suite),
    squareFeet:        num(map.squareFeet),
    status,
    leaseStart:        date(map.leaseStart),
    leaseEnd:          date(map.leaseEnd),
    inPlaceRentAnnual: num(map.inPlaceRent),
    marketRentAnnual:  num(map.marketRent),
    leaseType,
    recoveriesAnnual:  num(map.recoveries),
    otherIncomeAnnual: num(map.otherIncome),
    newTiPsf:          num(map.newTiPsf),
    renewTiPsf:        num(map.renewTiPsf),
    newLcPct:          num(map.newLcPct),
    renewLcPct:        num(map.renewLcPct),
    downtimeMonths:    num(map.downtimeMonths),
    notes:             str(map.notes),
  };
}

/**
 * Multifamily / MHC / student-housing row parser. Honesty discipline:
 *   - VACANT units: status='VACANT', inPlaceRentMonthly=null (NOT 0 — a
 *     coercion lie); marketRentMonthly may still be present (asking rent).
 *   - MONTH-TO-MONTH: leaseEndOrMTM=null intentionally means MTM, NOT
 *     missing data. We do not synthesize a date or coerce. The contract
 *     comment at @cre/contracts.UnitRentRollLine.leaseEndOrMTM declares
 *     this semantic; this parser honors it.
 *   - CONCESSIONS absent: null, never 0.
 *   - No leaseType on the unit shape — the office NNN/MG/FSG vocabulary
 *     has no residential analog and the union type structurally forbids
 *     it on UnitRentRollLine.
 *
 *   `unitId` is required on the contract; we fall back to a row-positional
 *   synthetic id (`unit-<row#>`) only when the source omits a unit
 *   identifier entirely. The synthetic id is positional, not stable across
 *   re-parses of an edited rent roll — same discipline as the legacy
 *   rent-roll.adapter.ts at `unit-${i+1}`.
 */
function parseUnitRow(ws: ExcelJS.Worksheet, row: number, map: ColumnMap): RentRollLine {
  const num = (col: number | undefined) => (col === undefined ? null : cellNumber(ws.getCell(row, col)));
  const str = (col: number | undefined) => (col === undefined ? null : cellString(ws.getCell(row, col)));
  const date = (col: number | undefined) => (col === undefined ? null : cellDate(ws.getCell(row, col)));

  const statusRaw = str(map.status);
  const status: TenantStatus = statusRaw === null
    ? 'UNKNOWN'
    : (STATUS_NORMALIZE[statusRaw.toLowerCase().trim()] ?? 'UNKNOWN');

  const explicitUnitId = str(map.suite);
  const unitId = explicitUnitId ?? `unit-${row}`;

  return {
    kind: 'unit',
    unitId,
    status,
    squareFeet:         num(map.squareFeet),
    bedrooms:           num(map.bedrooms),
    bathrooms:          num(map.bathrooms),
    unitType:           str(map.unitType),
    leaseStart:         date(map.leaseStart),
    leaseEndOrMTM:      date(map.leaseEnd),                 // null === MTM by contract semantics
    inPlaceRentMonthly: num(map.inPlaceRentMonthly),
    marketRentMonthly:  num(map.marketRentMonthly),
    concessionsMonthly: num(map.concessionsMonthly),
    securityDeposit:    num(map.securityDeposit),
    notes:              str(map.notes),
  };
}
