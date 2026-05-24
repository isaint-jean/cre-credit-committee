/**
 * extractCashFlowFromXlsx — convert an uploaded Seller CF .xlsx into two
 * OperatingStatementExtraction snapshots:
 *   - `t12`: the seller's In-Place (T-12-equivalent) column
 *   - `sellerUwOperatingStatement`: the seller's underwriting column (label varies:
 *     "GS U/W", "Seller U/W", "Issuer UW", "UW")
 *
 * Discipline (mirrors parse-rent-roll-xlsx.ts):
 *   - NO invented values. Missing line on a column → null.
 *   - NO row inference. A line item is recognized only if its label-column text
 *     matches a known pattern.
 *   - NO synthetic aggregates. If `totalIncome` is missing from the source,
 *     we don't reconstruct it from grossPotentialRent + otherIncome.
 *   - NO LLM. Pure deterministic header + label matching.
 *
 * Worksheet selection: explicit name wins; otherwise the first sheet whose
 * (a) period-header row exposes both an In-Place column AND a UW column, and
 * (b) line-item label column has ≥ 3 recognizable labels below the header.
 *
 * Output shape: each snapshot is the contract's `OperatingStatementExtraction`,
 * which carries: gross potential rent, effective rent, other income, total income,
 * taxes, insurance, utilities, repairs & maintenance, management fees, general &
 * administrative, janitorial, reimbursements, total operating expenses, NOI,
 * vacancy loss, and a belowNoiAdjustments sub-block (replacement reserves, tenant
 * improvements, leasing commissions). Per handbook P-III-3 the below-NOI items
 * are NCF adjustments rather than operating expenses, so they live in their own
 * sub-block on the contract.
 *
 * Bad debt remains DROPPED from the contract. Empirically rare in CMBS-style CFs
 * (Sunroad lumps it into "Commercial Adj. to Market Vacancy" which is captured as
 * vacancyLoss); the only handbook principle governing it (P-IV-MF-9) is
 * multifamily-conditional and runs in LLM_CONTEXT mode rather than deterministic;
 * adding a badDebt pattern risks regex collision with the existing vacancyLoss
 * pattern. Revisit if future fixtures show bad debt as reliably separable.
 */

import ExcelJS from 'exceljs';
import type { OperatingStatementExtraction } from '@cre/contracts';

export interface ExtractCashFlowResult {
  readonly t12: OperatingStatementExtraction | null;
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
}

export interface ExtractCashFlowOptions {
  readonly worksheetName?: string;
}

/* ----------------------------- period detection ---------------------------- */

type PeriodKind = 'in_place' | 'uw' | 'budget' | 't12';

interface PeriodColumn {
  readonly kind: PeriodKind;
  readonly amountCol: number;
  readonly label: string;             // raw text from the workbook (preserved for `period`)
}

const PERIOD_PATTERNS: { readonly kind: PeriodKind; readonly regex: RegExp }[] = [
  { kind: 'in_place', regex: /in[\s-]*place|in[\s-]*place\s*rent|current(?!\s*rent)|trailing\s*twelve|t[\s-]?12/i },
  { kind: 't12',      regex: /t[\s-]?12|trailing\s*twelve/i },
  { kind: 'uw',       regex: /\b(?:gs|seller|issuer)?\s*(?:u\/w|uw|underwrit\w*)\b/i },
  { kind: 'budget',   regex: /budget|forecast|proforma|pro[\s-]*forma/i },
];

/* ---------------------------- line-item patterns --------------------------- */
/**
 * Each entry: contract path + label regex(s). The label-column scan picks the
 * FIRST matching pattern for a given row. Patterns are ordered to avoid
 * substring collisions (e.g., "Total Expenses" before "Expenses").
 */
type LineItemKey =
  | 'grossPotentialRent'
  | 'effectiveRent'
  | 'otherIncome'
  | 'totalIncome'
  | 'taxes'
  | 'insurance'
  | 'utilities'
  | 'repairsMaintenance'
  | 'managementFees'
  | 'generalAndAdmin'
  | 'janitorial'
  | 'reimbursements'
  | 'totalOperatingExpenses'
  | 'noi'
  | 'vacancyLoss'
  | 'replacementReserves'
  | 'tenantImprovements'
  | 'leasingCommissions';

const LINE_PATTERNS: { readonly key: LineItemKey; readonly regex: RegExp }[] = [
  // NOI first — protects against "Net Operating" being shadowed by other "net" rows.
  { key: 'noi',                    regex: /^net\s*operating\s*income\b/i },
  // Totals before their component words.
  { key: 'totalOperatingExpenses', regex: /^total\s*(?:operating\s*)?expenses\b/i },
  { key: 'totalIncome',            regex: /^(?:effective\s*gross\s*(?:revenue|income)|effective\s*gross|egr|egi)\b/i },
  { key: 'vacancyLoss',            regex: /^total\s*(?:commercial\s*)?vacancy(?:\s*[&+\s]*\s*credit)?(?:\s*loss)?\b/i },
  // Gross potential — distinct from "Total Other Revenue" / EGR.
  { key: 'grossPotentialRent',     regex: /^gross\s*potential\s*(?:commercial\s*)?(?:rental\s*revenue|rent\b)/i },
  // Other income (total).
  { key: 'otherIncome',            regex: /^total\s*other\s*(?:revenue|income)\b/i },
  // Reimbursements — requires "total" prefix to match Sunroad's row 12
  // ("Total Commercial Reimbursement Revenue") rather than the row 10
  // section header ("Commercial Reimbursement Revenue", value=null) which
  // findLineItems would otherwise match first. Same convention as the
  // otherIncome pattern (which also requires `^total\s+`).
  { key: 'reimbursements',         regex: /^total\s+(?:commercial\s+)?reimbursement\b/i },
  // Expense lines.
  { key: 'taxes',                  regex: /^real\s*estate\s*taxes|^property\s*taxes\b/i },
  { key: 'insurance',              regex: /^insurance\b/i },
  { key: 'utilities',              regex: /^utilities\b/i },
  { key: 'repairsMaintenance',     regex: /^repairs?\s*(?:&|and)\s*maintenance\b|^r\s*&\s*m\b/i },
  { key: 'managementFees',         regex: /^management\s*fees?\b/i },
  // G&A — matches Sunroad's "General and Administrative - Direct" via \b after admin.
  { key: 'generalAndAdmin',        regex: /^general\s*(?:and|&)\s*administrative\b|^g\s*&\s*a\b/i },
  { key: 'janitorial',             regex: /^janitorial\b|^cleaning\b/i },
  // Below-NOI items per handbook P-III-3 — replacement reserves, TI, LC.
  { key: 'replacementReserves',    regex: /^replacement\s+reserves?\b/i },
  { key: 'tenantImprovements',     regex: /^tenant\s+improvements?\b/i },
  { key: 'leasingCommissions',     regex: /^leasing\s+commissions?\b/i },
];

/* --------------------------------- helpers --------------------------------- */

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
    if (cleaned === '' || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return null;
}

interface PeriodHeader {
  readonly row: number;
  readonly periods: readonly PeriodColumn[];
}

/**
 * Scan rows 1..30 for a row that exposes period labels. The row must contain
 * BOTH an In-Place-style column AND a UW-style column for us to call this the
 * header row — otherwise we'd misfit a row that only labels one period.
 *
 * The Amount sub-column is presumed to be the same column as the period label.
 * If a separate "Amount / % / Per SF" sub-header row sits BELOW the period
 * row (common pattern), we scan rows period+1..period+3 and snap to whichever
 * column under the period label contains the text "Amount" (case-insensitive)
 * — that becomes the Amount column. If no "Amount" sub-row is found, we keep
 * the period-label column as the amount column.
 */
function findPeriodHeaderRow(ws: ExcelJS.Worksheet): PeriodHeader | null {
  const maxScan = Math.min(30, ws.rowCount);
  for (let r = 1; r <= maxScan; r++) {
    const candidates: PeriodColumn[] = [];
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = cellString(cell);
      if (text === null) return;
      for (const { kind, regex } of PERIOD_PATTERNS) {
        if (regex.test(text)) {
          if (!candidates.some((c) => c.kind === kind || c.amountCol === col)) {
            candidates.push({ kind, amountCol: col, label: text });
          }
          break;
        }
      }
    });

    const hasInPlace = candidates.some((c) => c.kind === 'in_place' || c.kind === 't12');
    const hasUw = candidates.some((c) => c.kind === 'uw');
    if (!hasInPlace || !hasUw) continue;

    // Snap to Amount sub-column if a sub-header row appears in the next 3 rows.
    const snapped = candidates.map((c) => snapToAmountColumn(ws, r, c));
    return { row: r, periods: snapped };
  }
  return null;
}

function snapToAmountColumn(ws: ExcelJS.Worksheet, periodRow: number, p: PeriodColumn): PeriodColumn {
  for (let r = periodRow + 1; r <= Math.min(periodRow + 3, ws.rowCount); r++) {
    // The "Amount" sub-header usually appears at the same column as the period
    // label OR within 0..2 columns to the right.
    for (let off = 0; off <= 2; off++) {
      const cell = ws.getCell(r, p.amountCol + off);
      const text = cellString(cell);
      if (text !== null && /^amount\b|\$\s*amount/i.test(text)) {
        return { ...p, amountCol: p.amountCol + off };
      }
    }
  }
  return p;
}

/**
 * Find the column that holds line-item labels. Scan columns 1..6 across rows
 * (headerRow+1 .. headerRow+30); the label column is the first column whose
 * text content matches ≥ 3 distinct LINE_PATTERNS entries.
 */
function findLabelColumn(ws: ExcelJS.Worksheet, headerRow: number): number | null {
  const lastRow = Math.min(headerRow + 40, ws.rowCount);
  const candidates: { col: number; matches: number }[] = [];
  for (let col = 1; col <= Math.min(6, ws.columnCount); col++) {
    const seen = new Set<LineItemKey>();
    for (let r = headerRow + 1; r <= lastRow; r++) {
      const text = cellString(ws.getCell(r, col));
      if (text === null) continue;
      for (const { key, regex } of LINE_PATTERNS) {
        if (regex.test(text)) { seen.add(key); break; }
      }
    }
    if (seen.size >= 3) candidates.push({ col, matches: seen.size });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.matches - a.matches);
  return candidates[0].col;
}

/* --------------------------- line-item extraction -------------------------- */

interface LineRow {
  readonly key: LineItemKey;
  readonly row: number;
}

function findLineItems(ws: ExcelJS.Worksheet, labelCol: number, headerRow: number): readonly LineRow[] {
  const seen = new Set<LineItemKey>();
  const out: LineRow[] = [];
  const lastRow = Math.min(headerRow + 200, ws.rowCount);
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const text = cellString(ws.getCell(r, labelCol));
    if (text === null) continue;
    for (const { key, regex } of LINE_PATTERNS) {
      if (seen.has(key)) continue;
      if (regex.test(text)) {
        seen.add(key);
        out.push({ key, row: r });
        break;
      }
    }
  }
  return out;
}

function buildStatement(
  ws: ExcelJS.Worksheet,
  period: PeriodColumn,
  lines: readonly LineRow[],
): OperatingStatementExtraction {
  const at = (key: LineItemKey): number | null => {
    const line = lines.find((l) => l.key === key);
    if (!line) return null;
    return cellNumber(ws.getCell(line.row, period.amountCol));
  };

  return {
    period: period.label,
    income: {
      grossPotentialRent: at('grossPotentialRent'),
      effectiveRent:      null,  // not separately reported in CMBS-style CF; left null per discipline
      otherIncome:        at('otherIncome'),
      totalIncome:        at('totalIncome'),
    },
    expenses: {
      taxes:                  at('taxes'),
      insurance:              at('insurance'),
      utilities:              at('utilities'),
      repairsMaintenance:     at('repairsMaintenance'),
      managementFees:         at('managementFees'),
      generalAndAdmin:        at('generalAndAdmin'),
      janitorial:             at('janitorial'),
      reimbursements:         at('reimbursements'),
      totalOperatingExpenses: at('totalOperatingExpenses'),
    },
    noi:         at('noi'),
    vacancyLoss: at('vacancyLoss'),
    belowNoiAdjustments: {
      replacementReserves: at('replacementReserves'),
      tenantImprovements:  at('tenantImprovements'),
      leasingCommissions:  at('leasingCommissions'),
    },
  };
}

/* ---------------------------------- entry ---------------------------------- */

export async function extractCashFlowFromXlsx(
  buffer: Buffer,
  options: ExtractCashFlowOptions = {},
): Promise<ExtractCashFlowResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);

  let target: ExcelJS.Worksheet | null = null;
  let header: PeriodHeader | null = null;
  let labelCol: number | null = null;

  const tryFit = (ws: ExcelJS.Worksheet): boolean => {
    const h = findPeriodHeaderRow(ws);
    if (h === null) return false;
    const lc = findLabelColumn(ws, h.row);
    if (lc === null) return false;
    target = ws;
    header = h;
    labelCol = lc;
    return true;
  };

  if (options.worksheetName) {
    const ws = wb.getWorksheet(options.worksheetName);
    if (!ws) return { t12: null, sellerUwOperatingStatement: null };
    if (!tryFit(ws)) return { t12: null, sellerUwOperatingStatement: null };
  } else {
    wb.eachSheet((ws) => {
      if (target !== null) return;
      tryFit(ws);
    });
  }
  if (!target || !header || labelCol === null) {
    return { t12: null, sellerUwOperatingStatement: null };
  }
  const ws = target as ExcelJS.Worksheet;
  const hdr = header as PeriodHeader;

  const lines = findLineItems(ws, labelCol, hdr.row);

  // In-Place: prefer 'in_place', fall back to 't12' if only that variant present.
  const inPlace = hdr.periods.find((p) => p.kind === 'in_place')
    ?? hdr.periods.find((p) => p.kind === 't12')
    ?? null;
  const uw = hdr.periods.find((p) => p.kind === 'uw') ?? null;

  return {
    t12: inPlace ? buildStatement(ws, inPlace, lines) : null,
    sellerUwOperatingStatement: uw ? buildStatement(ws, uw, lines) : null,
  };
}
