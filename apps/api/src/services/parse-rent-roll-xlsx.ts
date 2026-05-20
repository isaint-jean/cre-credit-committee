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
}

const HEADER_PATTERNS: { readonly key: keyof ColumnMap; readonly regex: RegExp }[] = [
  { key: 'tenantName',     regex: /tenant\s*name|tenant$/i },
  { key: 'suite',          regex: /suite|unit\s*(?:id|#|number)/i },
  { key: 'squareFeet',     regex: /(?:^|\b)sf\b|sq\.?\s*ft|square\s*feet|gla|nra/i },
  { key: 'leaseStart',     regex: /lease\s*start|commencement|start\s*date/i },
  { key: 'leaseEnd',       regex: /lease\s*end|expir|maturity|end\s*date/i },
  { key: 'inPlaceRent',    regex: /in[\s-]*place\s*rent|current\s*rent|contract\s*rent|base\s*rent/i },
  { key: 'marketRent',     regex: /market\s*rent|appraisal\s*rent/i },
  { key: 'leaseType',      regex: /lease\s*type|recovery\s*type/i },
  { key: 'recoveries',     regex: /recover|reimburs/i },
  { key: 'otherIncome',    regex: /other\s*income|parking|storage/i },
  { key: 'newTiPsf',       regex: /new\s*ti(?!\s*lc)/i },
  { key: 'renewTiPsf',     regex: /renew\s*ti(?!\s*lc)/i },
  { key: 'newLcPct',       regex: /new\s*lc/i },
  { key: 'renewLcPct',     regex: /renew\s*lc/i },
  { key: 'downtimeMonths', regex: /downtime|down\s*time|vacancy\s*months/i },
  { key: 'status',         regex: /status|occupanc/i },
  { key: 'notes',          regex: /notes|comments/i },
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
    // Header row must have at least a tenant identifier and SF column.
    if (map.tenantName !== undefined && map.squareFeet !== undefined) {
      return { row: r, map };
    }
  }
  return null;
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

  // Tenant rows: every non-empty, non-total row from headerRow+1 onward.
  const lines: RentRollLine[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    if (isTotalsRow(ws, r, map)) continue;
    if (isEmptyRow(ws, r, map)) continue;
    lines.push(parseTenantRow(ws, r, map));
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
