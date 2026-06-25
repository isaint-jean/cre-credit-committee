/**
 * Template Engine Service
 *
 * Reads full Excel templates using ExcelJS (preserving formulas),
 * analyzes multi-tab structure, maps extracted deal data into correct
 * cells, and produces a populated Excel workbook for export.
 */

import ExcelJS from 'exceljs';
import type {
  CellComment,
  CellState,
  CellValue,
  RenderPayload,
  TablePayload,
  TemplateMetadata,
  UnderwritingModel,
} from '@cre/shared';
import type { PropertyMetadata, RentRoll, RentRollLine } from '@cre/contracts';
import { matchProvenancePattern } from './render-output-scrubber.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateTabInfo {
  name: string;
  index: number;
  category: TabCategory;
  rowCount: number;
  colCount: number;
  headers: string[];
  formulaCells: number;
  inputCells: number;
}

export interface TemplateStructure {
  tabs: TemplateTabInfo[];
  totalTabs: number;
  totalFormulaCells: number;
  totalInputCells: number;
}

export type TabCategory =
  | 'summary'
  | 'cash_flow'
  | 'rent_roll'
  | 'debt'
  | 'assumptions'
  | 'capex'
  | 'sources_uses'
  | 'returns'
  | 'unknown';

export interface PopulationResult {
  populatedBuffer: Buffer;
  mappedFields: MappedField[];
  unmappedFields: string[];
  tabsPopulated: string[];
}

export interface MappedField {
  field: string;
  tab: string;
  cell: string;
  value: number | string | boolean;
}

// ---------------------------------------------------------------------------
// Tab Classification
// ---------------------------------------------------------------------------

const TAB_PATTERNS: Record<TabCategory, RegExp> = {
  summary:      /summary|overview|exec|dashboard|deal\s*summary/i,
  cash_flow:    /cash\s*flow|income|expense|operat|noi|pro.?forma|t.?12|trailing|p\s*&\s*l|revenue|budget/i,
  rent_roll:    /rent\s*roll|unit\s*mix|lease|tenant|occupancy|rental/i,
  debt:         /debt|loan|financ|mortgage|capital\s*stack|leverage/i,
  assumptions:  /assum|input|param|scenario|underwriting|sensit/i,
  capex:        /capex|capital\s*exp|reserves|repair|improvement|renovation/i,
  sources_uses: /source|use|closing|cost|settlement/i,
  returns:      /return|irr|yield|exit|disposition|sale|equity/i,
  unknown:      /^$/,
};

function classifyTab(sheetName: string): TabCategory {
  for (const [category, pattern] of Object.entries(TAB_PATTERNS)) {
    if (category === 'unknown') continue;
    if (pattern.test(sheetName)) return category as TabCategory;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Analyze Template Structure
// ---------------------------------------------------------------------------

export async function analyzeTemplateStructure(buffer: Buffer): Promise<TemplateStructure> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const tabs: TemplateTabInfo[] = [];
  let totalFormulaCells = 0;
  let totalInputCells = 0;

  workbook.eachSheet((worksheet, sheetIndex) => {
    let formulaCells = 0;
    let inputCells = 0;
    const headers: string[] = [];
    let rowCount = 0;
    let colCount = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      rowCount = Math.max(rowCount, rowNumber);
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        colCount = Math.max(colCount, colNumber);

        // Collect headers from first few rows
        if (rowNumber <= 3 && cell.value !== null && cell.value !== undefined) {
          const val = String(cell.value).trim();
          if (val.length > 0 && val.length < 80) {
            headers.push(val);
          }
        }

        if (cell.formula) {
          formulaCells++;
        } else if (cell.value !== null && cell.value !== undefined) {
          inputCells++;
        }
      });
    });

    const tabInfo: TemplateTabInfo = {
      name: worksheet.name,
      index: sheetIndex,
      category: classifyTab(worksheet.name),
      rowCount,
      colCount,
      headers: headers.slice(0, 30),
      formulaCells,
      inputCells,
    };

    tabs.push(tabInfo);
    totalFormulaCells += formulaCells;
    totalInputCells += inputCells;
  });

  return {
    tabs,
    totalTabs: tabs.length,
    totalFormulaCells,
    totalInputCells,
  };
}

// ---------------------------------------------------------------------------
// Cell-Matching Helpers
// ---------------------------------------------------------------------------

/** Patterns to identify specific data fields in row labels */
const FIELD_PATTERNS: Record<string, RegExp> = {
  // Income
  grossPotentialRent:  /gross\s*potential\s*rent|gpr|potential\s*rental\s*income|scheduled\s*rent/i,
  vacancyLoss:         /vacancy|credit\s*loss|vacancy\s*(?:&|and)\s*credit/i,
  concessions:         /concession|free\s*rent/i,
  otherIncome:         /other\s*income|ancillary|miscellaneous\s*income|parking|laundry|storage/i,
  effectiveGrossIncome:/effective\s*gross\s*income|egi|total\s*income/i,

  // Expenses
  realEstateTaxes:     /real\s*estate\s*tax|property\s*tax|taxes/i,
  insurance:           /insurance/i,
  utilities:           /utilit/i,
  repairsAndMaint:     /repair|maintenance|r\s*&\s*m/i,
  management:          /management\s*fee|property\s*management/i,
  generalAndAdmin:     /general\s*(?:&|and)\s*admin|g\s*&\s*a|admin/i,
  payroll:             /payroll|salaries|wages|personnel/i,
  replacementReserves: /replacement\s*reserve|capex\s*reserve|capital\s*reserve/i,
  totalExpenses:       /total\s*(?:operating\s*)?expense/i,

  // NOI & Metrics
  noi:                 /net\s*operating\s*income|noi/i,
  capRate:             /cap\s*rate|capitalization\s*rate/i,
  impliedValue:        /(?:implied|appraised|estimated)\s*value|valuation/i,

  // Debt
  loanAmount:          /loan\s*amount|mortgage\s*amount|principal|total\s*loan/i,
  interestRate:        /interest\s*rate|coupon|note\s*rate/i,
  amortization:        /amortization|amort/i,
  loanTerm:            /(?:loan\s*)?term(?!ination)|maturity\s*\(?(?:months|years)?\)?/i,
  annualDebtService:   /annual\s*debt\s*service|ads|debt\s*service/i,
  dscr:                /dscr|debt\s*service\s*coverage/i,
  ltv:                 /ltv|loan\s*to\s*value/i,
  debtYield:           /debt\s*yield/i,

  // Loan structure (post-Phase 4 wiring batch). All sourced from uwModel.loanDetails;
  // populator does NOT compute or estimate any of these. Maturity date is derived from
  // origination + termMonths via straightforward unit arithmetic — no judgment.
  originationDate:     /origination\s*date|closing\s*date|funding\s*date|loan\s*date/i,
  maturityDate:        /maturity\s*date|loan\s*maturity|note\s*maturity/i,
  ioPeriodMonths:      /(?:^|\b)i\.?o\.?(?:\s*period)?\b|interest[-\s]*only(?:\s*period)?/i,
  rateType:            /rate\s*type|fixed\s*\/?\s*floating|fixed\s*or\s*floating/i,
  paymentFrequency:    /payment\s*frequency|pay\s*frequency/i,
  prepaymentTerms:     /prepayment(?:\s*terms?)?|prepay\s*lockout|defeasance|yield\s*maintenance/i,

  // Property overview (wiring batch 2). Square feet / units already exist on
  // uwModel as totalSqFt / totalUnits; populator just needs the regex labels.
  squareFeet:          /square\s*feet|sq\.?\s*ft|sf\b|total\s*(?:sf|sq\s*ft)|gla\b/i,
  units:               /(?:^|\b)units?\b|total\s*units|number\s*of\s*units|unit\s*count/i,

  // Credit flags (wiring batch 2). Read directly from server-emitted credit-policy
  // bands (uwModel.dscrBand / ltvBand / debtYieldBand). The bands are PRODUCER output
  // from doctrine/apply-credit-policy-bands.ts — populator does NOT classify thresholds
  // itself. Only flags whose meaning matches a band threshold are wired:
  //   - High_Leverage      ← ltvBand === 'danger'      (LTV > 0.75 per credit policy)
  //   - Refinance_Risk     ← debtYieldBand === 'danger' (DY < 0.08 per credit policy)
  // DSCR_Below_1_0 is intentionally NOT wired because the dscrBand threshold (1.25)
  // does not match the schema's literal "<1.0" semantic; mapping it would produce
  // false positives. A dedicated server-emitted flag is required for that field.
  highLeverage:        /high\s*leverage|leverage\s*flag|elevated\s*leverage/i,
  refinanceRisk:       /refinance\s*risk|refi\s*risk/i,

  // Property & Loan Summary loan-term labels. Property identity + physical
  // specs are populated by direct-cell writes in populatePropertyLoanSummaryTab
  // (see PROPERTY_LOAN_SUMMARY_CELLS) and intentionally have no FIELD_PATTERNS
  // entries — the label-scan can't reliably target the BP Spiral header layout
  // (split state/zip cells, value-column-E instead of -B, etc.).
  //   - Total Current/Original Balance both map to uwModel.loanAmount (same
  //     dollar amount; the workbook displays both because some loans diverge
  //     between original and current — we don't have that distinction today).
  currentBalance:      /(?:total\s*)?current\s*balance/i,
  originalBalance:     /(?:total\s*)?original\s*balance/i,
};

interface CellTarget {
  field: string;
  worksheet: ExcelJS.Worksheet;
  row: number;
  col: number;
}

// Batch 1A — multi-column period support. Tabs like 'Operating History and Pro Forma'
// have one row per line item but multiple period columns: prior years, T-12, Issuer UW,
// Year 1, etc. Each period column is identified by a recognizable header in the top
// rows of the worksheet. We detect those columns and write per-period values into the
// matching label rows.
//
// Coverage in this batch is intentionally narrow: only periods we can populate from
// existing pipeline output ('most_recent' from ASR extraction, 'issuer_uw' from Seller
// UW extraction). Historical-prior-year periods, Appraisal, Year 1, etc. require new
// extractors and are deferred.

export type PeriodKind =
  | '3rd_prior_year'
  | '2nd_prior_year'
  | 'prior_year'
  | 'most_recent'
  | 'appraisal'
  | 'issuer_uw'
  | 'actual_in_place'
  | 'year_1';

const PERIOD_HEADER_PATTERNS: { readonly kind: PeriodKind; readonly regex: RegExp }[] = [
  { kind: '3rd_prior_year',  regex: /3r?d\s*prior\s*year(?:\s*financials?)?/i },
  { kind: '2nd_prior_year',  regex: /2nd\s*prior\s*year(?:\s*financials?)?/i },
  { kind: 'prior_year',      regex: /(?:^|\b)prior\s*year(?:\s*financials?)?(?!\s*(?:financials\s*)?\s*(?:2nd|3rd|3r))/i },
  { kind: 'most_recent',     regex: /most\s*recent(?:\s*financials?)?|\bt[\s-]*12\b|trailing\s*12/i },
  { kind: 'appraisal',       regex: /^appraisal$|appraisal\s*uw/i },
  { kind: 'issuer_uw',       regex: /issuer\s*uw|seller\s*uw|underwriter\s*uw/i },
  { kind: 'actual_in_place', regex: /actual\s*income\s*in\s*place/i },
  { kind: 'year_1',          regex: /year\s*1|y1\b/i },
];

interface PeriodColumnMap {
  readonly columns: ReadonlyMap<number, PeriodKind>;     // column number -> period kind
  readonly headerRow: number;                            // row where headers were detected
}

// Scan the top rows of a worksheet to detect period column headers. Returns null
// when the sheet has no recognizable period structure (i.e., it's a single-column
// tab and should fall back to the single-cell populator).
function detectPeriodColumns(worksheet: ExcelJS.Worksheet): PeriodColumnMap | null {
  const maxScan = Math.min(8, worksheet.rowCount);
  let bestRow = 0;
  let bestCount = 0;
  let bestColumns: Map<number, PeriodKind> | null = null;

  for (let r = 1; r <= maxScan; r++) {
    const cols = new Map<number, PeriodKind>();
    const row = worksheet.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = String(cell.value ?? '').trim();
      if (!text || text.length > 60) return;
      for (const { kind, regex } of PERIOD_HEADER_PATTERNS) {
        if (regex.test(text) && !cols.has(col)) {
          cols.set(col, kind);
          break;
        }
      }
    });
    if (cols.size > bestCount) {
      bestCount = cols.size;
      bestRow = r;
      bestColumns = cols;
    }
  }
  // Heuristic: require at least 2 distinct period columns to call this a period sheet.
  // 1 alone is often a coincidental match (e.g. "Year 1" appearing in an unrelated cell).
  if (bestColumns && bestColumns.size >= 2) {
    return { columns: bestColumns, headerRow: bestRow };
  }
  return null;
}

/**
 * Scan a worksheet for label cells that match known field patterns.
 * Returns the VALUE cell (one column to the right of the label).
 */
function findFieldTargets(worksheet: ExcelJS.Worksheet): CellTarget[] {
  const targets: CellTarget[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (cell.formula) return; // skip formula cells

      const val = String(cell.value ?? '').trim();
      if (val.length < 2 || val.length > 80) return;

      for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
        if (pattern.test(val)) {
          // The value cell is in the next column (or the column after)
          // Check which of the next 3 columns has a value or formula
          for (let offset = 1; offset <= 3; offset++) {
            const targetCol = colNumber + offset;
            const targetCell = worksheet.getCell(rowNumber, targetCol);
            // Prefer cells that have a formula (= calculated) or a number value
            if (targetCell.formula) {
              // This is a formula cell — skip it (don't overwrite formulas)
              continue;
            }
            // Found a non-formula cell next to the label — this is our input target
            targets.push({ field, worksheet, row: rowNumber, col: targetCol });
            break;
          }
          break; // Only match first pattern per cell
        }
      }
    });
  });

  return targets;
}

// ---------------------------------------------------------------------------
// Build Value Map from UW Model
// ---------------------------------------------------------------------------

// null = field is not computable from current inputs. Consumers MUST skip
// null cells (no 0-coercion). Existing call sites at populateTemplate already
// guard with `if (value === undefined || value === null) continue`.
//
// Property identity + physical specs are NOT in this map — they go through
// populatePropertyLoanSummaryTab's direct-cell writer because the label-scan
// approach can't target the BP Spiral header layout reliably.
function buildValueMap(
  uwModel: UnderwritingModel,
): Record<string, number | string | boolean | null> {
  return {
    // Income
    grossPotentialRent:   uwModel.income.grossPotentialRent.annualAmount,
    vacancyLoss:          uwModel.income.vacancyLoss.annualAmount,
    concessions:          uwModel.income.concessions.annualAmount,
    otherIncome:          uwModel.income.otherIncome.annualAmount,
    effectiveGrossIncome: uwModel.income.effectiveGrossIncome.annualAmount,

    // Expenses
    realEstateTaxes:      uwModel.expenses.realEstateTaxes.annualAmount,
    insurance:            uwModel.expenses.insurance.annualAmount,
    utilities:            uwModel.expenses.utilities.annualAmount,
    repairsAndMaint:      uwModel.expenses.repairsAndMaintenance.annualAmount,
    management:           uwModel.expenses.management.annualAmount,
    generalAndAdmin:      uwModel.expenses.generalAndAdmin.annualAmount,
    payroll:              uwModel.expenses.payroll.annualAmount,
    replacementReserves:  uwModel.expenses.replacementReserves.annualAmount,
    totalExpenses:        uwModel.expenses.totalExpenses.annualAmount,

    // Metrics
    noi:                  uwModel.netOperatingIncome,
    capRate:              uwModel.capRate,
    impliedValue:         uwModel.impliedValue,

    // Debt
    loanAmount:           uwModel.loanAmount,
    interestRate:         uwModel.interestRate,
    amortization:         uwModel.amortizationYears,
    loanTerm:             uwModel.termYears,
    annualDebtService:    uwModel.annualDebtService,
    dscr:                 uwModel.dscr,
    ltv:                  uwModel.ltv,
    debtYield:            uwModel.debtYield,

    // Loan structure (sourced from uwModel.loanDetails). Maturity date is the only
    // derived value and comes from origination + termMonths via the helper below;
    // returns null if origination is absent or unparseable.
    originationDate:      uwModel.loanDetails?.originationDate ?? null,
    maturityDate:         computeMaturityDate(
                            uwModel.loanDetails?.originationDate ?? null,
                            uwModel.loanDetails?.termMonths ?? null,
                          ),
    ioPeriodMonths:       uwModel.loanDetails?.ioMonths ?? null,
    rateType:             uwModel.loanDetails?.rateType ?? null,
    paymentFrequency:     uwModel.loanDetails?.paymentFrequency ?? null,
    prepaymentTerms:      uwModel.loanDetails?.prepaymentTerms ?? null,

    // Property overview
    squareFeet:           uwModel.totalSqFt ?? null,
    units:                uwModel.totalUnits ?? null,

    // Credit flags projected from server-emitted credit-policy bands. Population
    // is server-owned: the band classification IS the producer-pole policy. The
    // populator only translates 'danger' band -> true, anything else -> null
    // (we do NOT emit `false` for unknown / safe bands, because absence of a
    // danger flag is not the same as an explicit safe flag — keeping null avoids
    // implying the populator made a judgment).
    highLeverage:         projectDangerFlag(uwModel.ltvBand),
    refinanceRisk:        projectDangerFlag(uwModel.debtYieldBand),

    // Property & Loan Summary loan-balance cells. Both map to uwModel.loanAmount
    // today because the legacy contract carries a single loan-balance field.
    // Property identity (propertyName, address, etc.) is handled separately by
    // populatePropertyLoanSummaryTab — not in this map.
    currentBalance:       uwModel.loanAmount,
    originalBalance:      uwModel.loanAmount,
  };
}

// Submarket/MSA label in the BP Spiral template is a slash-joined presentation
// string (e.g., "UTC / San Diego-Carlsbad") in a single cell (E8). State and
// zip are kept SEPARATE — they live in D6 and E6 respectively, not combined.
function formatSubmarketMsa(submarket: string | null, msa: string | null): string | null {
  if (submarket === null && msa === null) return null;
  if (submarket === null) return msa;
  if (msa === null) return submarket;
  return submarket + ' / ' + msa;
}
function formatYearBuiltRenovated(built: number | null, renovated: number | null): string | null {
  if (built === null && renovated === null) return null;
  if (renovated === null) return String(built);
  if (built === null)     return String(renovated);
  return String(built) + ' / ' + String(renovated);
}

function projectDangerFlag(band: 'safe' | 'warning' | 'danger' | null | undefined): boolean | null {
  if (band === undefined || band === null) return null;
  if (band === 'danger') return true;
  // safe / warning -> null (intentional: see comment in buildValueMap).
  return null;
}

// Maturity date helper. Pure date arithmetic: shift originationDate by termMonths.
// Returns null if either input is missing or origination is not parseable as ISO.
// No fallback to "today + term" — missing input means missing output.
function computeMaturityDate(originationDate: string | null, termMonths: number | null): string | null {
  if (originationDate === null || termMonths === null) return null;
  const origin = new Date(originationDate);
  if (Number.isNaN(origin.getTime())) return null;
  const maturity = new Date(origin);
  maturity.setUTCMonth(maturity.getUTCMonth() + termMonths);
  // Match the storage convention used elsewhere (ISO date-only suffix preserved).
  return maturity.toISOString();
}

// ---------------------------------------------------------------------------
// Period-aware writer (Batch 1A)
// ---------------------------------------------------------------------------

// Line-item field names recognized as having historical/period meaning. Maps
// row labels matching FIELD_PATTERNS keys to the field accessor on a per-source
// UnderwritingModel. When the row label matches one of these, we attempt to
// write the corresponding value into each detected period column.
const PERIOD_LINE_ITEM_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly read: (m: UnderwritingModel) => number | null;
}> = [
  { field: 'grossPotentialRent',   read: (m) => m.income.grossPotentialRent.annualAmount   },
  { field: 'vacancyLoss',          read: (m) => m.income.vacancyLoss.annualAmount          },
  { field: 'concessions',          read: (m) => m.income.concessions.annualAmount          },
  { field: 'otherIncome',          read: (m) => m.income.otherIncome.annualAmount          },
  { field: 'effectiveGrossIncome', read: (m) => m.income.effectiveGrossIncome.annualAmount },
  { field: 'realEstateTaxes',      read: (m) => m.expenses.realEstateTaxes.annualAmount    },
  { field: 'insurance',            read: (m) => m.expenses.insurance.annualAmount          },
  { field: 'utilities',            read: (m) => m.expenses.utilities.annualAmount          },
  { field: 'repairsAndMaint',      read: (m) => m.expenses.repairsAndMaintenance.annualAmount },
  { field: 'management',           read: (m) => m.expenses.management.annualAmount         },
  { field: 'generalAndAdmin',      read: (m) => m.expenses.generalAndAdmin.annualAmount    },
  { field: 'payroll',              read: (m) => m.expenses.payroll.annualAmount            },
  { field: 'replacementReserves',  read: (m) => m.expenses.replacementReserves.annualAmount },
  { field: 'totalExpenses',        read: (m) => m.expenses.totalExpenses.annualAmount      },
  { field: 'noi',                  read: (m) => m.netOperatingIncome                       },
];

// Per-period source resolver. Returns the UnderwritingModel that should fill
// a given period column, or null if no source is available for that period.
function periodSource(
  period: PeriodKind,
  uwModel: UnderwritingModel,
  options: PopulationOptions,
): UnderwritingModel | null {
  switch (period) {
    case 'most_recent':
      return options.periodSources?.mostRecent ?? null;
    case 'issuer_uw':
      return options.periodSources?.issuerUw ?? null;
    case '3rd_prior_year':
    case '2nd_prior_year':
    case 'prior_year':
    case 'appraisal':
    case 'actual_in_place':
    case 'year_1':
      // No source today. Future batches add producers for these.
      return null;
  }
}

// Shared accumulator for period-write entries. Filled by populatePeriodColumns
// and drained by populateTemplate after each worksheet pass. Module-level state
// is acceptable here because populateTemplate is the only call site and it
// processes worksheets sequentially within a single workbook.
const periodWritesLog: MappedField[] = [];

function populatePeriodColumns(
  worksheet: ExcelJS.Worksheet,
  periodMap: PeriodColumnMap,
  uwModel: UnderwritingModel,
  options: PopulationOptions,
): number {
  let writes = 0;

  // Iterate every row below the header, looking for a label cell that matches
  // a period-line-item field. The label is in column 1 (or 2) by convention;
  // we scan the first 3 columns to be flexible.
  for (let r = periodMap.headerRow + 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    let matchedField: string | null = null;
    for (let c = 1; c <= 3; c++) {
      const cell = row.getCell(c);
      if (cell.formula) continue;
      const text = String(cell.value ?? '').trim();
      if (text.length < 2 || text.length > 80) continue;
      for (const lineItem of PERIOD_LINE_ITEM_FIELDS) {
        const pattern = FIELD_PATTERNS[lineItem.field];
        if (pattern && pattern.test(text)) {
          matchedField = lineItem.field;
          break;
        }
      }
      if (matchedField !== null) break;
    }
    if (matchedField === null) continue;

    const lineItemEntry = PERIOD_LINE_ITEM_FIELDS.find((x) => x.field === matchedField);
    if (!lineItemEntry) continue;

    // For each detected period column, fetch the per-source value and write it.
    for (const [colNumber, period] of periodMap.columns.entries()) {
      const source = periodSource(period, uwModel, options);
      if (source === null) continue;
      const value = lineItemEntry.read(source);
      if (value === null || value === undefined) continue;

      // Don't overwrite formula cells.
      const cell = worksheet.getCell(r, colNumber);
      if (cell.formula) continue;

      cell.value = value;
      writes++;
      periodWritesLog.push({
        field: matchedField + ':' + period,
        tab: worksheet.name,
        cell: String.fromCharCode(64 + Math.min(colNumber, 26)) + r,
        value,
      });
    }
  }

  return writes;
}

// ---------------------------------------------------------------------------
// Rent Roll tab populator (Batch 1A)
// ---------------------------------------------------------------------------

// Column map for the BP Spiral 'Rent Roll' tab per-tenant input rows. Derived
// from row-13 header inspection of the blank template. INPUT columns only;
// FORMULA columns (Lease Term @ H, Market Rent PSF @ J, UW Monthly Rent @ L,
// UW Annual Rent @ M, recovery totals @ R/S, Total Rent @ U, etc.) are NOT
// written — populator preserves their formulas. The first tenant row is 14.
const RENT_ROLL_FIRST_DATA_ROW = 14;
const RENT_ROLL_COLS = {
  rank:                  1,   // A
  unit:                  2,   // B
  tenantName:            3,   // C
  squareFeet:            4,   // D
  // E = Code (lease-type lookup key); we do NOT set it because the workbook's
  // formulas resolve market rent from this code. Without a known code mapping,
  // writing a guess would corrupt the row.
  leaseStart:            6,   // F
  leaseEnd:              7,   // G
  // H = Lease Term (formula)
  contractRentPsf:       9,   // I  (INPUT; the workbook does NOT derive this)
  // J = Market Rent PSF (formula)
  uwBaseRentPsf:        11,   // K  (INPUT; drives UW Annual Rent formula at M)
  // L,M = UW Monthly Rent, UW Annual Rent (formula)
  leaseType:            14,   // N  (NNN/MG/etc text)
} as const;

// Property header cells (rows 2-4, col C is the value cell). Property Name on
// the Rent Roll tab in our blank template is FORMULA-driven (=Property_Name
// named range), so we don't overwrite it; the workbook resolves it from
// wherever Property_Name points. We DO write Stabilized Occupancy if we can
// derive it (left blank for now — Batch 1C concern).
const RENT_ROLL_PROPERTY_NAME_CELL = 'C2';

interface RentRollPopulationResult {
  readonly writes: number;
  readonly entries: MappedField[];
}

// Pre-tally the tenant rows the input rentRoll will fill, and the maximum row
// the worksheet allocates for input. The blank template allocates ~236 rows
// (rows 14 through ~250) before the Summary block; we cap writes there to
// avoid overrunning into formula sections.
function populateRentRollTab(
  worksheet: ExcelJS.Worksheet,
  rentRoll: RentRoll,
): RentRollPopulationResult {
  const entries: MappedField[] = [];
  let writes = 0;

  // Property Name — only write if the cell is NOT a formula (i.e., the
  // template doesn't already source it from a named range / cross-tab ref).
  if (rentRoll.propertyName !== null && rentRoll.propertyName.length > 0) {
    const cell = worksheet.getCell(RENT_ROLL_PROPERTY_NAME_CELL);
    if (!cell.formula) {
      cell.value = rentRoll.propertyName;
      writes++;
      entries.push({
        field: 'rentRoll.propertyName',
        tab: worksheet.name,
        cell: RENT_ROLL_PROPERTY_NAME_CELL,
        value: rentRoll.propertyName,
      });
    }
  }

  // The 'Rent Roll' tab is tenant/office-shaped — its columns (tenantName,
  // squareFeet, leaseType NNN/MG/FSG, leaseStart/leaseEnd-as-expiration,
  // contractRentPsf, uwBaseRentPsf) are office-vocabulary. The blank
  // template has NO equivalent per-unit input slot for multifamily on
  // 'Property Detail - MF SS MHP' — that tab is fully formula-driven
  // (rows 25-29 read from 'Property & Loan Summary' INDEX/MATCH lookups,
  // no per-unit input rows). PR 3 batch 3: filter to tenant-kind lines
  // before writing. Unit lines are honestly DROPPED at render rather
  // than coerced into tenant columns (which would misplace unitId into
  // tenantName, monthly rent into contractRentPsf, etc. — exactly the
  // field-means-two-things trap the discriminated union refuses).
  // Multifamily property-level summary data flows through other
  // workbook surfaces (Total_Units / Year_Built / Property_Type named
  // ranges populated by Build C's render-schema path).
  //
  // Back-compat (batch-1 convention): skip explicit `kind: 'unit'` only —
  // untyped legacy lines default to the tenant write path.
  const tenantLines = rentRoll.lines.filter(l => l.kind !== 'unit');

  // Tenant rows. Cap at the template's allocated input rows; the Summary
  // block (Leased/Vacant/Total) starts around row 250 in the blank template.
  const SUMMARY_GUARD_ROW = 248;
  const writableRows = Math.max(0, SUMMARY_GUARD_ROW - RENT_ROLL_FIRST_DATA_ROW);
  const lineLimit = Math.min(tenantLines.length, writableRows);

  for (let i = 0; i < lineLimit; i++) {
    const line = tenantLines[i]!;
    const row = RENT_ROLL_FIRST_DATA_ROW + i;
    writes += writeTenantRow(worksheet, row, i + 1, line, entries);
  }

  return { writes, entries };
}

// Write one tenant row. Returns count of cells actually written. Every cell
// is guarded: formula cells are skipped (the workbook may pin certain rows
// or columns), and null line fields are skipped (no zero fabrication).
//
// Callers MUST pre-filter unit-kind lines (see `populateRentRollTab` above —
// the writer is tenant-shape-only by design). Untyped legacy lines (no
// `kind` field) are treated as tenant per the batch-1 back-compat convention.
function writeTenantRow(
  worksheet: ExcelJS.Worksheet,
  row: number,
  rank: number,
  line: RentRollLine,
  entries: MappedField[],
): number {
  if (line.kind === 'unit') return 0;  // safety net — callers should have filtered

  let writes = 0;

  const psfFromAnnual = (annual: number | null, sqft: number | null): number | null => {
    if (annual === null || sqft === null || sqft <= 0) return null;
    return annual / sqft;
  };
  const contractRentPsf = psfFromAnnual(line.inPlaceRentAnnual, line.squareFeet);

  const targets: { col: number; field: string; value: string | number | null }[] = [
    { col: RENT_ROLL_COLS.rank,             field: 'rank',            value: rank },
    { col: RENT_ROLL_COLS.unit,             field: 'unit',            value: line.suite },
    { col: RENT_ROLL_COLS.tenantName,       field: 'tenantName',      value: line.tenantName },
    { col: RENT_ROLL_COLS.squareFeet,       field: 'squareFeet',      value: line.squareFeet },
    { col: RENT_ROLL_COLS.leaseStart,       field: 'leaseStart',      value: line.leaseStart },
    { col: RENT_ROLL_COLS.leaseEnd,         field: 'leaseEnd',        value: line.leaseEnd },
    { col: RENT_ROLL_COLS.contractRentPsf,  field: 'contractRentPsf', value: contractRentPsf },
    { col: RENT_ROLL_COLS.uwBaseRentPsf,    field: 'uwBaseRentPsf',   value: contractRentPsf },
    { col: RENT_ROLL_COLS.leaseType,        field: 'leaseType',       value: line.leaseType === 'UNKNOWN' ? null : line.leaseType },
  ];

  for (const t of targets) {
    if (t.value === null || t.value === undefined) continue;
    const cell = worksheet.getCell(row, t.col);
    if (cell.formula) continue;
    cell.value = t.value;
    writes++;
    entries.push({
      field: 'rentRoll.line[' + (rank - 1) + '].' + t.field,
      tab: worksheet.name,
      cell: columnLetter(t.col) + row,
      value: t.value,
    });
  }
  return writes;
}

// Excel-style column letter for a 1-based column index. Handles 1..702 (AZ).
function columnLetter(col: number): string {
  if (col <= 26) return String.fromCharCode(64 + col);
  const first = Math.floor((col - 1) / 26);
  const second = ((col - 1) % 26) + 1;
  return String.fromCharCode(64 + first) + String.fromCharCode(64 + second);
}

// ---------------------------------------------------------------------------
// Conclusions & Escrows tab populator (Step 14 in user's recommended fill order;
// upstream-by-formula-dependency of Third Party Reports Summary).
// ---------------------------------------------------------------------------

// Direct cell targets per BP Spiral 'Conclusions & Escrows' tab inspection.
// Both are INPUT cells; the workbook has FORMULA cells nearby that pull from
// these (e.g., 'Third Party Reports Summary'!E5 = +Appraised_Value where the
// Appraised_Value named range points here).
const CONCLUSIONS_CAP_RATE_CELL = 'I9';   // "Eightfold Concluded Cap Rate / LTV:"
const CONCLUSIONS_VALUE_CELL    = 'I11';  // "Appraisal Value:" — feeds Appraised_Value named range

interface ConclusionsPopulationResult {
  readonly writes: number;
  readonly entries: MappedField[];
}

function populateConclusionsAndEscrowsTab(
  worksheet: ExcelJS.Worksheet,
  uwModel: UnderwritingModel,
): ConclusionsPopulationResult {
  const entries: MappedField[] = [];
  let writes = 0;

  // I9 — Concluded Cap Rate. Source: server-emitted uwModel.capRate (decimal
  // fraction; Excel cell format converts to percent display). Skip when the
  // cell has a formula (defensive — the template may rewire this in future).
  if (uwModel.capRate !== null && uwModel.capRate !== undefined && uwModel.capRate > 0) {
    const cell = worksheet.getCell(CONCLUSIONS_CAP_RATE_CELL);
    if (!cell.formula) {
      cell.value = uwModel.capRate;
      writes++;
      entries.push({
        field: 'concludedCapRate',
        tab: worksheet.name,
        cell: CONCLUSIONS_CAP_RATE_CELL,
        value: uwModel.capRate,
      });
      // Concluded-cap disclosure (cap-rate stress doctrine v1). Attach the
      // adjustments ledger + cap-relevant dataQualityFlags as an Excel cell
      // note so an analyst opening the workbook sees the build-up without
      // modifying the cell layout. Cell notes are non-disruptive (no rows
      // shifted; no formulas affected). Skipped when the disclosure is
      // empty (legacy non-promoted analyses) or has no entries.
      const disclosure = uwModel.capRateDisclosure;
      if (
        disclosure !== undefined &&
        (disclosure.adjustments.length > 0 || disclosure.flags.length > 0)
      ) {
        const lines: string[] = [
          `Concluded cap = ${(uwModel.capRate * 100).toFixed(2)}%`,
          '',
        ];
        for (const adj of disclosure.adjustments) {
          const sign = adj.deltaBps >= 0 ? '+' : '−';
          lines.push(`  ${sign}${Math.abs(adj.deltaBps)} bps  ${adj.ruleId}`);
          lines.push(`      ${adj.reason}`);
        }
        if (disclosure.flags.length > 0) {
          lines.push('');
          lines.push('Data-quality flags:');
          for (const f of disclosure.flags) lines.push(`  - ${f}`);
        }
        cell.note = lines.join('\n');
      }
    }
  }

  // I11 — "Appraisal Value". The BP Spiral workbook treats this as the canonical
  // value input that the Appraised_Value named range points at. Strictly this
  // should hold a true third-party appraisal value, but no appraisal extractor
  // exists today. We write uwModel.impliedValue as a proxy so downstream
  // formulas (As-Is Value, Cap Rate cross-check, LTV computations) get a
  // non-zero base instead of producing #DIV/0! errors across the workbook.
  // This is a documented compromise — replace when an appraisal extractor lands.
  if (uwModel.impliedValue !== null && uwModel.impliedValue !== undefined && uwModel.impliedValue > 0) {
    const cell = worksheet.getCell(CONCLUSIONS_VALUE_CELL);
    if (!cell.formula) {
      cell.value = uwModel.impliedValue;
      writes++;
      entries.push({
        field: 'appraisalValueProxy',
        tab: worksheet.name,
        cell: CONCLUSIONS_VALUE_CELL,
        value: uwModel.impliedValue,
      });
    }
  }

  return { writes, entries };
}

// ---------------------------------------------------------------------------
// Property & Loan Summary header populator (Batch 1H direct-cell writer).
// ---------------------------------------------------------------------------
//
// Fixed-address writes for the property identity + physical-specs header block
// on the BP Spiral 'Property & Loan Summary' tab. The generic label-scanner
// can't reliably target this layout: the left block puts values in column E
// (not the +1 offset after column-A labels the scanner assumes) and state/zip
// are SPLIT across D6/E6 rather than combined into a single cell. Same
// architectural reason as populateConclusionsAndEscrowsTab above.
//
// E3 (Property_Name named range) is the canonical source cell for property
// name across the workbook — Cover Page B2, Operating History A2, 10 Yr Pro
// Forma B7, etc. all use `=Property_Name`, so writing E3 cascades.

const PROPERTY_LOAN_SUMMARY_CELLS = {
  propertyName:       'E3',
  address:            'E4',
  city:               'E5',
  state:              'D6',   // split from zip
  zip:                'E6',
  county:             'E7',
  submarketMsa:       'E8',   // combined "<submarket> / <msa>" in one cell
  propertyType:       'H3',
  occupancyPhysical:  'H4',
  netRentableArea:    'H5',
  buildingClass:      'H6',
  yearBuiltRenovated: 'H7',   // combined "<built> / <renov>" in one cell
  ownershipInterest:  'H8',
} as const;

interface PropertyLoanSummaryPopulationResult {
  readonly writes: number;
  readonly entries: MappedField[];
}

function populatePropertyLoanSummaryTab(
  worksheet: ExcelJS.Worksheet,
  propertyMetadata: PropertyMetadata | null,
  uwModel: UnderwritingModel,
  rentRoll: RentRoll | null,
): PropertyLoanSummaryPopulationResult {
  const entries: MappedField[] = [];
  let writes = 0;

  const write = (field: string, address: string, value: string | number | null): void => {
    if (value === null || value === undefined || value === '') return;
    const cell = worksheet.getCell(address);
    if (cell.formula) return; // never overwrite formula cells
    cell.value = value;
    writes++;
    entries.push({ field, tab: worksheet.name, cell: address, value });
  };

  // propertyName falls back to rentRoll.propertyName when AI metadata is null —
  // same precedence as the prior buildValueMap binding.
  write('propertyName', PROPERTY_LOAN_SUMMARY_CELLS.propertyName,
        propertyMetadata?.propertyName ?? rentRoll?.propertyName ?? null);

  if (propertyMetadata !== null) {
    write('address',            PROPERTY_LOAN_SUMMARY_CELLS.address,            propertyMetadata.address);
    write('city',               PROPERTY_LOAN_SUMMARY_CELLS.city,               propertyMetadata.city);
    write('state',              PROPERTY_LOAN_SUMMARY_CELLS.state,              propertyMetadata.state);
    write('zip',                PROPERTY_LOAN_SUMMARY_CELLS.zip,                propertyMetadata.zip);
    write('county',             PROPERTY_LOAN_SUMMARY_CELLS.county,             propertyMetadata.county);
    write('submarketMsa',       PROPERTY_LOAN_SUMMARY_CELLS.submarketMsa,
          formatSubmarketMsa(propertyMetadata.submarket, propertyMetadata.msa));
    write('propertyType',       PROPERTY_LOAN_SUMMARY_CELLS.propertyType,       propertyMetadata.propertySubtype);
    write('occupancyPhysical',  PROPERTY_LOAN_SUMMARY_CELLS.occupancyPhysical,  propertyMetadata.occupancyPhysical);
    write('netRentableArea',    PROPERTY_LOAN_SUMMARY_CELLS.netRentableArea,
          propertyMetadata.totalSquareFeet ?? uwModel.totalSqFt ?? null);
    write('buildingClass',      PROPERTY_LOAN_SUMMARY_CELLS.buildingClass,      propertyMetadata.buildingClass);
    write('yearBuiltRenovated', PROPERTY_LOAN_SUMMARY_CELLS.yearBuiltRenovated,
          formatYearBuiltRenovated(propertyMetadata.yearBuilt, propertyMetadata.yearRenovated));
    write('ownershipInterest',  PROPERTY_LOAN_SUMMARY_CELLS.ownershipInterest,  propertyMetadata.ownershipInterest);
  } else {
    // No propertyMetadata: NRA can still come from uwModel.totalSqFt. Other
    // fields have no fallback source today — leave blank rather than fabricate.
    write('netRentableArea', PROPERTY_LOAN_SUMMARY_CELLS.netRentableArea, uwModel.totalSqFt ?? null);
  }

  return { writes, entries };
}

// ---------------------------------------------------------------------------
// Populate Template (Single Loan)
// ---------------------------------------------------------------------------

export interface PopulationOptions {
  // Batch 1A — pre-merge per-source extractions used to populate multi-period
  // tabs (Operating History and Pro Forma). When absent, period-aware tabs
  // populate only with the merged uwModel under the 'most_recent' column.
  readonly periodSources?: {
    readonly mostRecent?: UnderwritingModel | null;   // ASR-extracted candidate
    readonly issuerUw?: UnderwritingModel | null;     // Seller-UW-extracted candidate
  };
  // Batch 1A — resolved rent roll (file > ASR table > Seller UW exhibit).
  // When present, the 'Rent Roll' tab populates per-tenant input rows starting
  // at row 14. Absent or null -> the tab is left as-is.
  readonly rentRoll?: RentRoll | null;
  // Batch 1H — extracted property metadata. Feeds Property & Loan Summary
  // header section + Property Detail tabs. Null when AI extraction returned
  // empty; populator leaves cells blank rather than fabricating.
  readonly propertyMetadata?: PropertyMetadata | null;
}

export async function populateTemplate(
  templateBuffer: Buffer,
  uwModel: UnderwritingModel,
  options: PopulationOptions = {},
): Promise<PopulationResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  const valueMap = buildValueMap(uwModel);
  const mappedFields: MappedField[] = [];
  const tabsPopulated = new Set<string>();
  const fieldsUsed = new Set<string>();

  // Scan every worksheet for field targets. Period-aware tabs (Operating History
  // and Pro Forma) get a different writer that fills per-period columns. The
  // Rent Roll tab gets its own writer that fills tenant rows at row 14+.
  workbook.eachSheet((worksheet) => {
    // Rent Roll tab dispatcher (Batch 1A). Matches only the canonical 'Rent Roll'
    // tab name; NOT 'Presentation Rent Roll' (formula-driven derivation) or
    // 'Rent Roll Summary' / 'Rent Roll Footnotes'.
    if (worksheet.name === 'Rent Roll' && options.rentRoll) {
      const rrResult = populateRentRollTab(worksheet, options.rentRoll);
      if (rrResult.writes > 0) tabsPopulated.add(worksheet.name);
      for (const entry of rrResult.entries) {
        mappedFields.push(entry);
        fieldsUsed.add(entry.field);
      }
      return;
    }

    // Conclusions & Escrows tab dispatcher (Step 14 in user's fill order).
    // Direct-cell writes to I9 (Concluded Cap Rate) and I11 (Appraisal Value)
    // because the generic label-matcher's "next non-formula cell" heuristic
    // doesn't reliably target this tab's far-right input columns.
    if (worksheet.name === 'Conclusions & Escrows') {
      const ceResult = populateConclusionsAndEscrowsTab(worksheet, uwModel);
      if (ceResult.writes > 0) tabsPopulated.add(worksheet.name);
      for (const entry of ceResult.entries) {
        mappedFields.push(entry);
        fieldsUsed.add(entry.field);
      }
      return;
    }

    // Property & Loan Summary header dispatcher (Batch 1H direct-cell writer).
    // Writes property identity + physical-specs cells (E3-E8, H3-H8, D6) using
    // fixed addresses, then FALLS THROUGH to the generic label-scanner so loan-
    // term labels (Current Balance, Coupon, Term, etc.) still populate via the
    // FIELD_PATTERNS currentBalance/originalBalance entries.
    if (worksheet.name === 'Property & Loan Summary') {
      const plsResult = populatePropertyLoanSummaryTab(
        worksheet,
        options.propertyMetadata ?? null,
        uwModel,
        options.rentRoll ?? null,
      );
      if (plsResult.writes > 0) tabsPopulated.add(worksheet.name);
      for (const entry of plsResult.entries) {
        mappedFields.push(entry);
        fieldsUsed.add(entry.field);
      }
      // intentional fall-through to label-scan for loan-term rows
    }

    const periodMap = detectPeriodColumns(worksheet);

    if (periodMap !== null) {
      const periodWrites = populatePeriodColumns(worksheet, periodMap, uwModel, options);
      if (periodWrites > 0) tabsPopulated.add(worksheet.name);
      for (const write of periodWritesLog) {
        mappedFields.push(write);
        fieldsUsed.add(write.field);
      }
      periodWritesLog.length = 0;
      return;
    }

    const targets = findFieldTargets(worksheet);

    for (const target of targets) {
      const value = valueMap[target.field];
      if (value === undefined || value === null) continue;

      // Write the value — this preserves formulas in OTHER cells
      const cell = worksheet.getCell(target.row, target.col);
      cell.value = typeof value === 'number' ? value : value;

      const cellRef = `${String.fromCharCode(64 + target.col)}${target.row}`;
      mappedFields.push({
        field: target.field,
        tab: worksheet.name,
        cell: cellRef,
        value,
      });
      tabsPopulated.add(worksheet.name);
      fieldsUsed.add(target.field);
    }
  });

  // Identify unmapped fields
  const allFields = Object.keys(valueMap);
  const unmappedFields = allFields.filter((f) => !fieldsUsed.has(f));

  // ExcelJS writeBuffer crashes on CF rules with undefined/empty `formulae`.
  // BP Spiral .xlsm artifacts ship rules ExcelJS can't round-trip; strip the
  // unrenderable ones before serialization. (Same issue + same fix as the
  // RenderPayload path further down — sanitizer is shared.)
  sanitizeConditionalFormatting(workbook);

  // Generate output buffer
  const outputBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    populatedBuffer: outputBuffer,
    mappedFields,
    unmappedFields,
    tabsPopulated: [...tabsPopulated],
  };
}

// ---------------------------------------------------------------------------
// Create Default Blank Template
// ---------------------------------------------------------------------------

/**
 * Generates a blank Excel workbook with standard CRE underwriting fields.
 * The row labels match FIELD_PATTERNS so populateTemplate() can map values
 * into the adjacent cells automatically.
 *
 * Uses minimal styling (font-only) to avoid ExcelJS conditional-formatting
 * serialization bugs with fill/border style objects.
 */
export async function createDefaultTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  function applyRow(sheet: ExcelJS.Worksheet, r: number, label: string, kind: 'header' | 'section' | 'label' | 'subtotal') {
    const labelCell = sheet.getCell(r, 1);
    labelCell.value = label;

    if (kind === 'header') {
      labelCell.font = { bold: true, size: 12 };
      sheet.getCell(r, 2).font = { bold: true, size: 12 };
    } else if (kind === 'section') {
      labelCell.font = { bold: true, size: 11 };
      sheet.getCell(r, 2).font = { bold: true, size: 11 };
    } else if (kind === 'subtotal') {
      labelCell.font = { bold: true, size: 10 };
      sheet.getCell(r, 2).font = { bold: true, size: 10 };
    } else {
      labelCell.font = { size: 10 };
      sheet.getCell(r, 2).font = { size: 10 };
    }
  }

  // --- Cash Flow / Pro Forma tab ---
  const cfSheet = workbook.addWorksheet('Cash Flow');
  cfSheet.getColumn(1).width = 35;
  cfSheet.getColumn(2).width = 20;

  const cfRows: [string, 'header' | 'section' | 'label' | 'subtotal'][] = [
    ['Pro Forma Cash Flow', 'header'],
    ['', 'label'],
    ['INCOME', 'section'],
    ['Gross Potential Rent', 'label'],
    ['Vacancy & Credit Loss', 'label'],
    ['Concessions', 'label'],
    ['Other Income', 'label'],
    ['Effective Gross Income', 'subtotal'],
    ['', 'label'],
    ['EXPENSES', 'section'],
    ['Real Estate Taxes', 'label'],
    ['Insurance', 'label'],
    ['Utilities', 'label'],
    ['Repairs & Maintenance', 'label'],
    ['Property Management', 'label'],
    ['General & Administrative', 'label'],
    ['Payroll', 'label'],
    ['Replacement Reserves', 'label'],
    ['Total Operating Expenses', 'subtotal'],
    ['', 'label'],
    ['Net Operating Income', 'subtotal'],
  ];

  cfRows.forEach(([label, kind], i) => applyRow(cfSheet, i + 1, label, kind));

  // --- Debt / Loan tab ---
  const debtSheet = workbook.addWorksheet('Debt Summary');
  debtSheet.getColumn(1).width = 35;
  debtSheet.getColumn(2).width = 20;

  const debtRows: [string, 'header' | 'section' | 'label' | 'subtotal'][] = [
    ['Debt Summary', 'header'],
    ['', 'label'],
    ['LOAN TERMS', 'section'],
    ['Loan Amount', 'label'],
    ['Interest Rate', 'label'],
    ['Amortization (Years)', 'label'],
    ['Loan Term (Years)', 'label'],
    ['Annual Debt Service', 'label'],
    ['', 'label'],
    ['KEY METRICS', 'section'],
    ['DSCR', 'label'],
    ['Loan to Value', 'label'],
    ['Debt Yield', 'label'],
    ['Cap Rate', 'label'],
    ['Implied Value', 'label'],
  ];

  debtRows.forEach(([label, kind], i) => applyRow(debtSheet, i + 1, label, kind));

  sanitizeConditionalFormatting(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Populate Roll-Up Template (Multi-Property)
// ---------------------------------------------------------------------------

interface PropertyData {
  name: string;
  uwModel: UnderwritingModel;
}

export async function populateRollUpTemplate(
  templateBuffer: Buffer,
  properties: PropertyData[],
  portfolioTotals: {
    totalNOI: number;
    totalLoanAmount: number;
    totalADS: number;
    portfolioDSCR: number;
    portfolioLTV: number;
    totalValue: number;
  },
): Promise<PopulationResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  const mappedFields: MappedField[] = [];
  const tabsPopulated = new Set<string>();
  const fieldsUsed = new Set<string>();

  // Strategy: for each tab, determine if it maps to a specific property
  // or to the portfolio summary. Then populate accordingly.

  workbook.eachSheet((worksheet) => {
    const category = classifyTab(worksheet.name);

    // Check if this tab name references a specific property
    const matchedProperty = properties.find((p) =>
      worksheet.name.toLowerCase().includes(p.name.toLowerCase().slice(0, 15))
    );

    if (matchedProperty) {
      // Property-specific tab — populate with that property's data
      const valueMap = buildValueMap(matchedProperty.uwModel);
      const targets = findFieldTargets(worksheet);
      for (const target of targets) {
        const value = valueMap[target.field];
        if (value === undefined || value === null) continue;
        worksheet.getCell(target.row, target.col).value = typeof value === 'number' ? value : value;
        const cellRef = `${String.fromCharCode(64 + target.col)}${target.row}`;
        mappedFields.push({ field: `${matchedProperty.name}.${target.field}`, tab: worksheet.name, cell: cellRef, value });
        tabsPopulated.add(worksheet.name);
        fieldsUsed.add(target.field);
      }
    } else if (category === 'summary' || category === 'debt') {
      // Summary/debt tab — populate with portfolio totals
      const targets = findFieldTargets(worksheet);
      const totalMap: Record<string, number> = {
        noi: portfolioTotals.totalNOI,
        loanAmount: portfolioTotals.totalLoanAmount,
        annualDebtService: portfolioTotals.totalADS,
        dscr: portfolioTotals.portfolioDSCR,
        ltv: portfolioTotals.portfolioLTV,
        impliedValue: portfolioTotals.totalValue,
      };
      for (const target of targets) {
        const value = totalMap[target.field];
        if (value === undefined || value === null) continue;
        worksheet.getCell(target.row, target.col).value = value;
        const cellRef = `${String.fromCharCode(64 + target.col)}${target.row}`;
        mappedFields.push({ field: `portfolio.${target.field}`, tab: worksheet.name, cell: cellRef, value });
        tabsPopulated.add(worksheet.name);
        fieldsUsed.add(target.field);
      }
    } else {
      // Generic tab — try first property's data as default
      if (properties.length > 0) {
        const valueMap = buildValueMap(properties[0].uwModel);
        const targets = findFieldTargets(worksheet);
        for (const target of targets) {
          const value = valueMap[target.field];
          if (value === undefined || value === null) continue;
          worksheet.getCell(target.row, target.col).value = typeof value === 'number' ? value : value;
          const cellRef = `${String.fromCharCode(64 + target.col)}${target.row}`;
          mappedFields.push({ field: target.field, tab: worksheet.name, cell: cellRef, value });
          tabsPopulated.add(worksheet.name);
          fieldsUsed.add(target.field);
        }
      }
    }
  });

  const allFields = Object.keys(buildValueMap(properties[0]?.uwModel || {} as any));
  const unmappedFields = allFields.filter((f) => !fieldsUsed.has(f));

  sanitizeConditionalFormatting(workbook);
  const outputBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    populatedBuffer: outputBuffer,
    mappedFields,
    unmappedFields,
    tabsPopulated: [...tabsPopulated],
  };
}

// ---------------------------------------------------------------------------
// Apply RenderPayload to canonical template
// ---------------------------------------------------------------------------

export interface RenderApplyResult {
  populatedBuffer: Buffer;
  writtenAddresses: string[];
  unresolvedAddresses: string[];
  hiddenSheets: string[];
  tablesWritten: string[];
}

/**
 * Hard error raised when a template/payload pair fails an integrity gate.
 * The export route maps every instance to HTTP 409 — there is no partial
 * rendering, no fallback template selection, and no auto-patching.
 */
export class TemplateIntegrityError extends Error {
  readonly code: 'TEMPLATE_INCOMPATIBLE' | 'TEMPLATE_SCHEMA_MISMATCH';
  readonly details: Record<string, unknown>;
  constructor(
    code: 'TEMPLATE_INCOMPATIBLE' | 'TEMPLATE_SCHEMA_MISMATCH',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TemplateIntegrityError';
    this.code = code;
    this.details = details;
  }
}

const A1_PATTERN = /^[A-Z]+\d+$/;

function splitAddress(address: string): { sheet: string; ref: string } | null {
  const idx = address.indexOf('!');
  if (idx <= 0 || idx === address.length - 1) return null;
  let sheet = address.slice(0, idx);
  // ExcelJS quotes sheet names containing special chars / underscores
  // ("'OF_Cashflow'!$A$1"). Normalise to the bare sheet name.
  if (sheet.length >= 2 && sheet.startsWith("'") && sheet.endsWith("'")) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  return { sheet, ref: address.slice(idx + 1) };
}

/**
 * Gate #1 — template/payload compatibility from the code-declared envelope.
 *
 * Enforces the (assetClass, contractVersion, structuralVariantKey,
 * templateVersion) tuple by rejecting any payload that falls outside the
 * template's registered support. Runs BEFORE any workbook is opened.
 */
export function validateTemplateCompatibility(
  template: TemplateMetadata,
  payload: RenderPayload,
): void {
  if (template.compatibleContractVersion !== payload.contractVersion) {
    throw new TemplateIntegrityError(
      'TEMPLATE_INCOMPATIBLE',
      `Template (${template.templateType}, v${template.templateVersion}) is bound to render contract v${template.compatibleContractVersion}, but payload uses v${payload.contractVersion}.`,
      {
        templateType: template.templateType,
        templateVersion: template.templateVersion,
        compatibleContractVersion: template.compatibleContractVersion,
        payloadContractVersion: payload.contractVersion,
      },
    );
  }
  if (!template.supportedAssetClasses.includes(payload.assetClass)) {
    throw new TemplateIntegrityError(
      'TEMPLATE_INCOMPATIBLE',
      `Template (${template.templateType}, v${template.templateVersion}) does not support assetClass=${payload.assetClass}.`,
      {
        templateType: template.templateType,
        templateVersion: template.templateVersion,
        assetClass: payload.assetClass,
        supportedAssetClasses: template.supportedAssetClasses,
      },
    );
  }
  if (!template.supportedVariants.includes(payload.structuralVariantKey)) {
    throw new TemplateIntegrityError(
      'TEMPLATE_INCOMPATIBLE',
      `Template (${template.templateType}, v${template.templateVersion}) does not support structuralVariantKey=${payload.structuralVariantKey}.`,
      {
        templateType: template.templateType,
        templateVersion: template.templateVersion,
        structuralVariantKey: payload.structuralVariantKey,
        supportedVariants: template.supportedVariants,
      },
    );
  }
  if (!template.supportedUnderwritingModes.includes(payload.underwritingMode)) {
    throw new TemplateIntegrityError(
      'TEMPLATE_INCOMPATIBLE',
      `Template (${template.templateType}, v${template.templateVersion}) does not support underwritingMode=${payload.underwritingMode}.`,
      {
        templateType: template.templateType,
        templateVersion: template.templateVersion,
        underwritingMode: payload.underwritingMode,
        supportedUnderwritingModes: template.supportedUnderwritingModes,
      },
    );
  }
}

/**
 * Resolve a single schema address against an already-loaded workbook.
 * Returns the cells the address points to, or null if it cannot resolve.
 * Pure read — never mutates the workbook (no auto-patching).
 */
function tryResolveAddress(
  workbook: ExcelJS.Workbook,
  address: string,
): ExcelJS.Cell[] | null {
  const parts = splitAddress(address);
  if (!parts) return null;
  const ws = workbook.getWorksheet(parts.sheet);
  if (!ws) return null;
  if (A1_PATTERN.test(parts.ref)) return [ws.getCell(parts.ref)];
  const cells = resolveNamedRangeCells(workbook, parts.sheet, parts.ref);
  return cells.length ? cells : null;
}

/**
 * Gate #2 — every schema address in the payload must point at a real Excel
 * target inside the template, AND every declared table layout's sheet +
 * coordinates must exist. Runs against the in-memory workbook BEFORE any
 * value is written; aborts on first complete diff.
 *
 * No silent range creation, no dynamic sheet creation, no fallback.
 */
export async function assertTemplateCanSatisfySchema(
  templateBuffer: Buffer,
  payload: RenderPayload,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  const missingAddresses: string[] = [];
  for (const address of payload.schemaAddresses) {
    const resolved = tryResolveAddress(workbook, address);
    if (!resolved) missingAddresses.push(address);
  }

  const missingTabs = payload.visibleTabs.filter(
    (name) => !workbook.getWorksheet(name),
  );

  const missingTables: string[] = [];
  for (const t of payload.tables) {
    const ws = workbook.getWorksheet(t.layout.sheetName);
    if (!ws) {
      missingTables.push(`${t.layout.name}@${t.layout.sheetName}`);
    }
  }

  if (missingAddresses.length || missingTabs.length || missingTables.length) {
    throw new TemplateIntegrityError(
      'TEMPLATE_SCHEMA_MISMATCH',
      'Template does not satisfy the schema for this (assetClass, structuralVariantKey).',
      {
        assetClass: payload.assetClass,
        structuralVariantKey: payload.structuralVariantKey,
        contractVersion: payload.contractVersion,
        missingAddresses,
        missingTabs,
        missingTables,
      },
    );
  }
}

function resolveNamedRangeCells(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  name: string,
): ExcelJS.Cell[] {
  // ExcelJS defined-names are keyed by the bare name (sheet scoping lives in
  // the address it resolves to, not the lookup key). If multiple names with
  // the same identifier exist, accept only those whose target sheet matches
  // the schema's expected sheet — that gives us per-sheet scoping semantics
  // without ExcelJS-specific scope plumbing.
  const ranges = (workbook.definedNames as any).getRanges?.(name);
  const list: string[] = ranges?.ranges ?? [];
  if (!list.length) return [];
  const cells: ExcelJS.Cell[] = [];
  for (const r of list) {
    const parts = splitAddress(r);
    if (!parts) continue;
    if (parts.sheet !== sheetName) continue;
    const ws = workbook.getWorksheet(parts.sheet);
    if (!ws) continue;
    // Strip absolute markers ($A$1 → A1) and expand simple ranges (A1:B2).
    const cleaned = parts.ref.replace(/\$/g, '');
    if (cleaned.includes(':')) {
      const [start, end] = cleaned.split(':');
      const startCell = ws.getCell(start);
      const endCell = ws.getCell(end);
      const r1 = Number(startCell.row);
      const r2 = Number(endCell.row);
      const c1 = Number(startCell.col);
      const c2 = Number(endCell.col);
      for (let row = r1; row <= r2; row++) {
        for (let col = c1; col <= c2; col++) {
          cells.push(ws.getCell(row, col));
        }
      }
    } else {
      cells.push(ws.getCell(cleaned));
    }
  }
  return cells;
}

/**
 * Workaround for an ExcelJS write-path defect.
 *
 * `cf-rule-xform.renderExpression()` and similar render methods access
 * `model.formulae[0]` without verifying `model.formulae` is defined.
 * Conditional-formatting rules of types {expression, cellIs, top10,
 * aboveAverage, containsText, timePeriod} that ExcelJS parses without a
 * populated formulae array trip the writer with
 * "Cannot read properties of undefined (reading '0')".
 *
 * dataBar / colorScale / iconSet rules go through different render
 * methods (cfvo-based), so they are preserved.
 *
 * This function drops only the unrenderable rules; everything else stays
 * intact. Returns the number of rules dropped (caller may surface in a
 * diagnostic header if useful).
 */
/**
 * Pre-resolve every sharedFormula cell to a standalone formula clone.
 *
 * ExcelJS round-trips sharedFormula cells as descendants of a "master"
 * cell — the descendant carries `{ sharedFormula: '<master A1 ref>',
 * result: <cached> }` and the master carries the actual formula string.
 * On `writeBuffer()`, ExcelJS rewrites the descendant by translating the
 * master's formula to the descendant's address. When the populator
 * overwrites the master cell with a value (or with a different formula),
 * the descendant's master pointer becomes orphaned and write-time
 * translation throws OR silently emits garbage.
 *
 * Workaround: BEFORE any mutation, walk every sheet, look up each
 * sharedFormula descendant's master formula, and replace the
 * descendant's value with a STANDALONE formula clone (carrying the
 * cached result so live recompute is preserved). After this pass, the
 * workbook has zero sharedFormula references and the populator can
 * freely overwrite any cell without orphaning siblings.
 *
 * The workbook stays LIVE/EDITABLE — every formula cell still carries
 * its formula string; Excel recomputes on open. This is option 1 of the
 * Phase 14 brief; option 2 (replace formulas with cached values) was
 * REJECTED because it freezes the workbook against analyst edits.
 *
 * Note: the standalone clone uses the master cell's formula string
 * VERBATIM (not relative-reference-translated). Cells whose master's
 * formula contains only absolute refs ($A$1) are exact. Cells whose
 * master uses relative refs (A1, A2, ...) will recompute against the
 * descendant cell's neighborhood on open — Excel resolves relative
 * refs at evaluation time anyway, so the behavior matches what the
 * sharedFormula did before. (For sharedFormula descendants whose
 * Excel-time recompute differs from a literal copy of the master
 * formula, the cached `result` value is also preserved, so the visible
 * cell content is correct on first open even if recompute drifts.)
 *
 * Returns the number of cells resolved (useful for diagnostic logging).
 */

// --- shared-formula relative-reference translation --------------------------
// A shared-formula DESCENDANT carries the master's formula offset by the
// descendant's position. Materializing it requires shifting the master's
// RELATIVE A1 references by (descendant − master) — copying the master string
// verbatim makes every descendant reference the master's column (the cause of
// the UW-column "sums column B" cash-flow corruption). These helpers do the
// shift, leaving absolute ($-locked) parts, sheet-qualified refs, named ranges,
// and string literals untouched.

function colLettersToNum(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}
function colNumToLetters(num: number): string {
  let s = '';
  while (num > 0) { const r = (num - 1) % 26; s = String.fromCharCode(65 + r) + s; num = Math.floor((num - 1) / 26); }
  return s;
}
function parseA1(addr: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(addr);
  return m ? { col: colLettersToNum(m[1]!), row: Number(m[2]) } : null;
}
function shiftRef(ref: string, dCol: number, dRow: number): string {
  const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/.exec(ref);
  if (!m) return ref;
  const [, colAbs, colLetters, rowAbs, rowDigits] = m;
  const newColNum = colAbs ? colLettersToNum(colLetters!) : colLettersToNum(colLetters!) + dCol;
  const newRowNum = rowAbs ? Number(rowDigits) : Number(rowDigits) + dRow;
  if (newColNum < 1 || newRowNum < 1) return ref; // would be #REF! — leave the original defensively
  return `${colAbs}${colAbs ? colLetters : colNumToLetters(newColNum)}${rowAbs}${newRowNum}`;
}

/**
 * Translate the master formula's RELATIVE references for a shared-formula
 * descendant at `targetAddr`. Δ=0 (the master itself) returns the formula
 * unchanged.
 *
 * The tokenizer alternation skips, in order: (1) string literals "…", (2)
 * sheet-qualified refs ('Sheet'!A1 or Sheet!A1, incl. ranges) — left verbatim
 * per the conservative policy, (3) bare A1 refs — translated. Named ranges
 * (word-identifiers; none in this template match the A1 shape — verified
 * against all 214 defined names) and function names (no trailing digits) never
 * match the bare-ref alternative, so they pass through untouched.
 */
function translateRelativeRefs(masterFormula: string, masterAddr: string, targetAddr: string): string {
  const m = parseA1(masterAddr);
  const t = parseA1(targetAddr);
  if (!m || !t) return masterFormula;
  const dCol = t.col - m.col;
  const dRow = t.row - m.row;
  if (dCol === 0 && dRow === 0) return masterFormula;
  const TOKEN = /("(?:[^"]|"")*")|((?:'(?:[^']|'')*'|[A-Za-z_][\w.]*)!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)|(\$?[A-Z]{1,3}\$?\d+)/g;
  return masterFormula.replace(TOKEN, (whole, str, sheetQual, bareRef) => {
    if (str !== undefined || sheetQual !== undefined) return whole; // string / sheet-qualified — leave
    return shiftRef(bareRef, dCol, dRow);
  });
}

function preResolveSharedFormulas(workbook: ExcelJS.Workbook): number {
  let resolved = 0;
  workbook.eachSheet((ws) => {
    // Build a master-formula lookup keyed by A1 master ref. A "master"
    // is any cell carrying a standalone formula (`formula` set,
    // `sharedFormula` absent).
    const masters: Record<string, string> = {};
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (
          v && typeof v === 'object' &&
          'formula' in v && !('sharedFormula' in v) &&
          typeof v.formula === 'string'
        ) {
          masters[cell.address] = v.formula as string;
        }
      });
    });
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'sharedFormula' in v) {
          const masterRef = v.sharedFormula as string;
          const masterFormula = masters[masterRef];
          if (masterFormula) {
            // Clone the master's formula to this cell as a standalone formula,
            // TRANSLATING relative references by (descendant − master) so each
            // cell references ITS OWN column/row (not the master's). The cached
            // result is preserved so first-open display is correct even before
            // Excel recomputes. (Verbatim copy was the UW-column corruption:
            // P12 became =SUM(B9:B11) instead of =SUM(P9:P11).)
            const translated = translateRelativeRefs(masterFormula, masterRef, cell.address);
            cell.value = { formula: translated, result: v.result } as any;
            resolved++;
          } else {
            // Master not in the lookup (unusual — possibly the master
            // was outside the iterated range). Fall back to the cached
            // result. The cell becomes a plain value cell. Better than
            // an orphaned formula reference that breaks writeBuffer().
            cell.value = v.result ?? null;
          }
        }
      });
    });
  });
  return resolved;
}

function sanitizeConditionalFormatting(workbook: ExcelJS.Workbook): number {
  const FORMULA_TYPES = new Set([
    'expression', 'cellIs', 'top10', 'aboveAverage', 'containsText', 'timePeriod',
  ]);
  let dropped = 0;
  workbook.eachSheet((ws) => {
    const cfList = (ws as any).conditionalFormattings;
    if (!Array.isArray(cfList)) return;
    for (const cf of cfList) {
      if (!Array.isArray(cf.rules)) continue;
      cf.rules = cf.rules.filter((r: any) => {
        const t = r?.type;
        if (!FORMULA_TYPES.has(t)) return true;
        if (Array.isArray(r.formulae) && r.formulae.length > 0) return true;
        dropped++;
        return false;
      });
    }
  });
  return dropped;
}

/**
 * Walks every worksheet's used range and redacts any string-valued cell
 * whose content matches a forbidden provenance pattern (filesystem path,
 * UNC share, ingestion marker). The cell value is replaced with `null`
 * (clears the cell). Headers / Print_Area / formula cells are not special-
 * cased — if the rendered value matches, it gets cleared.
 *
 * Also inspects worksheet headers / footers (page setup) and rich-text
 * runs since those are common stamping locations for source paths.
 *
 * Reuses `matchProvenancePattern` from render-output-scrubber.ts so the
 * pattern set is identical to the render-side hard-fail guard.
 */
function redactProvenanceInWorkbook(workbook: ExcelJS.Workbook): number {
  let redacted = 0;
  workbook.eachSheet((ws) => {
    // 1. Cell values (including formula results stored as `result`, and
    //    rich-text runs).
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null) return;
        // Plain string.
        if (typeof v === 'string') {
          if (matchProvenancePattern(v)) {
            cell.value = null;
            redacted++;
          }
          return;
        }
        // Rich text: { richText: [{ text, font }, ...] }
        if (typeof v === 'object' && Array.isArray((v as any).richText)) {
          let dirty = false;
          for (const run of (v as any).richText) {
            if (typeof run.text === 'string' && matchProvenancePattern(run.text)) {
              run.text = '';
              dirty = true;
            }
          }
          if (dirty) {
            cell.value = v;
            redacted++;
          }
          return;
        }
        // Hyperlink: { text, hyperlink }
        if (typeof v === 'object' && typeof (v as any).hyperlink === 'string') {
          const link = (v as any).hyperlink;
          const txt = (v as any).text;
          if (matchProvenancePattern(link) || (typeof txt === 'string' && matchProvenancePattern(txt))) {
            cell.value = null;
            redacted++;
          }
          return;
        }
        // Formula cell: { formula, result } — scrub the result string only.
        if (typeof v === 'object' && (v as any).formula !== undefined) {
          const result = (v as any).result;
          if (typeof result === 'string' && matchProvenancePattern(result)) {
            (v as any).result = '';
            cell.value = v;
            redacted++;
          }
          return;
        }
      });
    });
    // 2. Header / footer text (page setup stamping).
    const hf = (ws as any).headerFooter;
    if (hf) {
      for (const k of [
        'oddHeader', 'oddFooter', 'evenHeader', 'evenFooter',
        'firstHeader', 'firstFooter',
      ]) {
        const txt = hf[k];
        if (typeof txt === 'string' && matchProvenancePattern(txt)) {
          hf[k] = '';
          redacted++;
        }
      }
    }
  });
  return redacted;
}

/**
 * Workbook-properties sweep: scrub creator / lastModifiedBy / title /
 * subject / description / keywords / company / manager. Any of these
 * stamped with a path, filename, or known token is cleared.
 */
function redactProvenanceInWorkbookProperties(workbook: ExcelJS.Workbook): number {
  let cleared = 0;
  const targets: Array<keyof ExcelJS.Workbook> = [
    'creator', 'lastModifiedBy', 'title', 'subject', 'description', 'keywords', 'company', 'manager',
  ] as any;
  for (const k of targets) {
    const v = (workbook as any)[k];
    if (typeof v === 'string' && v.length > 0 && matchProvenancePattern(v)) {
      (workbook as any)[k] = '';
      cleared++;
    }
  }
  // Custom properties exposed via workbook.customProperties (ExcelJS API).
  const cp = (workbook as any).customProperties;
  if (cp && typeof cp.removeProperty === 'function' && Array.isArray(cp.model)) {
    for (const prop of [...cp.model]) {
      if (typeof prop?.value === 'string' && matchProvenancePattern(prop.value)) {
        try { cp.removeProperty(prop.name); cleared++; } catch { /* ignore */ }
      }
    }
  }
  return cleared;
}

/**
 * Post-write zip-level redactor. Opens the produced .xlsx as a zip and
 * scans every XML file likely to carry stamped provenance metadata:
 *   - xl/sharedStrings.xml (cell text shared across sheets)
 *   - xl/drawings/*.xml    (image alt text / drawing descriptions)
 *   - xl/comments*.xml     (cell comments and authors)
 *   - xl/threadedComments*.xml
 *   - docProps/core.xml    (Dublin-core author/title metadata)
 *   - docProps/app.xml     (Application/Company)
 *   - docProps/custom.xml  (custom properties)
 *
 * For each matched XML, runs `matchProvenancePattern` against text-node
 * content (between `>` and `<`) plus selected attribute values (descr,
 * title, author, hyperlink). Matches are replaced with empty string,
 * preserving the surrounding XML structure.
 *
 * Best-effort: any error returns the original buffer unchanged. Never
 * throws — observability/logging only.
 */
/**
 * ★ OOXML-validity sweep at the byte level. Walks every xl/worksheets/*.xml
 * inside the .xlsx zip and strips any `<v>NaN</v>` / `<v>Infinity</v>` /
 * `<v>-Infinity</v>` elements — i.e., cached values from formula cells whose
 * ExcelJS-computed result was non-finite. Removing the `<v>` element entirely
 * (we keep the `<f>` formula) tells Excel "no cached value; recompute on
 * open" — the cell then displays the formula's real Excel error (#VALUE!,
 * #N/A, etc.), valid OOXML.
 *
 * This is the load-bearing invariant: no exported workbook may contain a
 * `<v>NaN</v>` / `<v>Infinity</v>` cached value, regardless of upstream
 * formula-evaluation behavior. The writeCellValue NaN guard catches the
 * values we explicitly write; this catches the ones ExcelJS internally
 * computes-and-caches during load/serialize.
 */
async function sanitizeNonFiniteCachedValues(buffer: Buffer): Promise<Buffer> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer as any);
    // Matches <v>NaN</v>, <v>Infinity</v>, <v>-Infinity</v> (anywhere in
    // the cell element). Cell shape: <c ...><f>...</f><v>NaN</v></c> — we
    // strip just the <v> element, the <f> formula stays.
    const RE = /<v>(?:NaN|Infinity|-Infinity)<\/v>/gi;
    let touched = 0;
    for (const path of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet[^/]*\.xml$/i.test(path)) continue;
      const file = zip.file(path);
      if (!file) continue;
      const xml = await file.async('text');
      if (!RE.test(xml)) continue;
      RE.lastIndex = 0;
      const cleaned = xml.replace(RE, '');
      zip.file(path, cleaned);
      touched++;
    }

    // Force Excel to recompute on open by zeroing the workbook calcId. ExcelJS
    // hardcodes calcId="171027" (a recognized engine stamp) AND preserves each
    // formula cell's stale <v>0</v> carried from the template's 0-valued inputs.
    // Excel sees a known calcId + present cached values, trusts the cached
    // zeros, and SKIPS the recompute that fullCalcOnLoad="1" requested — so the
    // NOI/total cells show 0 until F9. Rewriting calcId to "0" marks the
    // workbook "never calculated by a known engine", forcing a full recalc on
    // open that overwrites the stale <v>. We can't set calcId via the ExcelJS
    // model (it's hardcoded), hence this byte rewrite. fullCalcOnLoad and every
    // other calcPr attribute are preserved (only the calcId attr changes).
    const wbFile = zip.file('xl/workbook.xml');
    if (wbFile) {
      const wbXml = await wbFile.async('text');
      const rewritten = wbXml.replace(/<calcPr\b[^>]*>/i, (tag) =>
        tag.replace(/calcId="\d+"/i, 'calcId="0"'),
      );
      if (rewritten !== wbXml) {
        zip.file('xl/workbook.xml', rewritten);
        touched++;
      }
    }

    if (touched === 0) return buffer;
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return Buffer.from(out as Buffer);
  } catch {
    return buffer;
  }
}

async function redactProvenanceFromXlsxBuffer(buffer: Buffer): Promise<Buffer> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer as any);
    const TARGET_PATTERNS: RegExp[] = [
      /^xl\/sharedStrings\.xml$/i,
      /^xl\/drawings\//i,
      /^xl\/comments[^/]*\.xml$/i,
      /^xl\/threadedComments\//i,
      /^docProps\/core\.xml$/i,
      /^docProps\/app\.xml$/i,
      /^docProps\/custom\.xml$/i,
    ];
    const files = Object.keys(zip.files);
    let touched = 0;
    for (const path of files) {
      if (!TARGET_PATTERNS.some((re) => re.test(path))) continue;
      const file = zip.file(path);
      if (!file) continue;
      const xml = await file.async('text');
      const cleaned = redactStringsInXml(xml);
      if (cleaned !== xml) {
        zip.file(path, cleaned);
        touched++;
      }
    }
    if (touched === 0) return buffer;
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return Buffer.from(out as Buffer);
  } catch (err) {
    console.error('[template-engine] xlsx zip-level redactor skipped:', (err as Error)?.message);
    return buffer;
  }
}

/**
 * Walks XML text nodes (content between `>` and `<`) and selected
 * attribute values, redacting any token matching a provenance pattern.
 * Preserves XML structure — never modifies tags or attribute names.
 */
function redactStringsInXml(xml: string): string {
  // Text between tags: >...< (non-greedy, no nested tags). We preserve
  // CDATA boundaries by also scrubbing inside CDATA sections.
  let out = xml.replace(/>([^<]+)</g, (full, content: string) => {
    const cleaned = scrubProvenanceFromText(content);
    return cleaned === content ? full : `>${cleaned}<`;
  });
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (full, content: string) => {
    const cleaned = scrubProvenanceFromText(content);
    return cleaned === content ? full : `<![CDATA[${cleaned}]]>`;
  });
  // Attribute values commonly used for paths / filenames / authors.
  const ATTR_NAMES = ['descr', 'title', 'name', 'author', 'href', 'Target', 'tooltip', 'displayName'];
  for (const attr of ATTR_NAMES) {
    const re = new RegExp(`(${attr}=")([^"]+)(")`, 'gi');
    out = out.replace(re, (_full, p1: string, val: string, p3: string) => {
      const cleaned = scrubProvenanceFromText(val);
      return cleaned === val ? `${p1}${val}${p3}` : `${p1}${cleaned}${p3}`;
    });
  }
  return out;
}

function scrubProvenanceFromText(text: string): string {
  if (!text) return text;
  if (matchProvenancePattern(text)) return '';
  return text;
}

/**
 * ARGB for the red flag fill applied to AWAITING_INPUT cells (rule fired
 * needing a manual input that doesn't exist). Light-red so existing dark
 * text remains legible, but unmistakably different from the artifact's
 * default cell fills. Preserved from v6/v7 — this is the existing
 * "missing data" visual.
 */
const MISSING_DATA_FILL_ARGB = 'FFFFC7CE';

/**
 * ARGB for the gray fill applied to HITL ("deliberately blank,
 * analyst-input required") cells. Visually distinct from the
 * MISSING_DATA red — HITL cells signal "the engine cannot know this
 * value; please fill it in" rather than "a rule needs an input that
 * doesn't exist yet." Light gray so the analyst can read template
 * formatting and any comment text.
 */
const HITL_FILL_ARGB = 'FFD9D9D9';

function applyFill(cell: ExcelJS.Cell, argb: string): void {
  try {
    (cell as any).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb },
    };
  } catch {
    /* styling failure must not block the write */
  }
}

/**
 * Write a value to a cell with the appropriate visual treatment for its
 * cell state. The three states:
 *
 *   'concluded'      — engine value-add. Value written verbatim; no fill
 *                      applied (template formatting wins). No comment.
 *   'hitl'           — deliberately blank, analyst input required. Value
 *                      is null; GRAY fill applied; comment text (when
 *                      provided) attached as a cell note.
 *   'awaiting_input' — rule fired needing a manual input that doesn't
 *                      exist. Value is null; RED fill applied; comment
 *                      text (when provided) attached as a cell note.
 *
 * The fill and comment writes are wrapped in try/catch — styling /
 * commenting failure must NEVER block the value write.
 *
 * NOTE: this signature changed in v8 (Phase B, populated-workbook
 * initiative). v6/v7 callers passed (cell, value); the prior
 * implementation auto-applied a red fill on null/'' values. That
 * implicit behavior is GONE — callers now declare the state
 * explicitly. `applyRenderPayloadToTemplate` reads the state from
 * `payload.cellStates`; when the payload is from an older client that
 * does not carry cellStates, the route is required to default to
 * 'concluded' (which preserves the v6/v7 surface for cells where the
 * value is also non-null).
 */
function writeCellValue(
  cell: ExcelJS.Cell,
  value: CellValue,
  state: CellState,
  comment: CellComment | null,
  forceOverwrite: boolean = false,
): void {
  // Formula guard. The legacy populator (populateTemplate, line 547) already
  // skips formula cells; the v8 payload-driven applyRenderPayloadToTemplate
  // path did not, so a schema entry that landed on a formula address would
  // wipe the formula on write. We preserve the formula and still attach the
  // comment so a deliberate "caveat this formula" schema entry (e.g. OPF
  // J35/J48/J50, where the formula correctly computes the STABILIZED basis
  // and the caveat surfaces the going-in figures) functions as intended.
  //
  // EXCEPTION: forceOverwrite=true bypasses the formula guard — the schema
  // explicitly asks the populator to REPLACE an existing formula with the
  // literal value. Used for engine direct-display into column P (engine
  // concluded) where the template's leaf cells are rent-roll-coupled or
  // L-column-cascade formulas. The cell becomes a value cell after this
  // write; downstream subtotal formulas (P17/P33/P35) recompute correctly
  // from the new leaves.
  if (cell.formula && !forceOverwrite) {
    if (comment !== null && state !== 'concluded') {
      try {
        (cell as any).note = {
          texts: [{ text: comment.text }],
          margins: { insetmode: 'auto' },
        };
      } catch {
        /* commenting failure must not block the (non-)write */
      }
    }
    return;
  }
  // OOXML-validity guard. A numeric value that's NaN / +Infinity / -Infinity
  // cannot be serialized into <v> without producing literal "NaN" / "Infinity"
  // tokens — both reject when Excel's parser opens the file (the OOXML spec
  // demands a finite numeric or an error sentinel, never NaN/Inf). LOAD-BEARING
  // INVARIANT: no code path below this function may ever produce an OOXML-
  // invalid file. We treat non-finite numeric values as null — the cell stays
  // empty, and any dependent formula that references it evaluates to a valid
  // Excel error (#VALUE! / #DIV/0!) at open-time rather than corrupting parse.
  // Coverage: NaN, +Infinity, -Infinity. Booleans / strings / null / Date
  // pass through unchanged.
  const sanitized: CellValue =
    typeof value === 'number' && !Number.isFinite(value) ? null : value;
  cell.value = sanitized === null ? null : (sanitized as any);
  if (state === 'hitl') {
    applyFill(cell, HITL_FILL_ARGB);
  } else if (state === 'awaiting_input') {
    applyFill(cell, MISSING_DATA_FILL_ARGB);
  }
  // 'concluded': no fill.

  // Comments emit when state is non-concluded OR when forceOverwrite is set
  // (a direct-display cell can legitimately carry an explanatory note even
  // though its state is concluded — e.g. the expense-floor disclosure).
  if (comment !== null && (state !== 'concluded' || forceOverwrite)) {
    try {
      (cell as any).note = {
        texts: [{ text: comment.text }],
        margins: { insetmode: 'auto' },
      };
    } catch {
      /* commenting failure must not block the write */
    }
  }
}

function writeTable(workbook: ExcelJS.Workbook, table: TablePayload): boolean {
  const ws = workbook.getWorksheet(table.layout.sheetName);
  if (!ws) return false;
  table.layout.columns.forEach((col, i) => {
    ws.getCell(table.layout.headerRow, i + 1).value = col.header;
  });
  table.rows.forEach((row, rIdx) => {
    table.layout.columns.forEach((col, cIdx) => {
      const v = row[col.sourceField];
      // Tables are concluded-only today. Driver tables never use the
      // HITL or AWAITING_INPUT visual semantics — they list cross-check
      // findings the engine produced.
      writeCellValue(ws.getCell(table.layout.dataStartRow + rIdx, cIdx + 1), v ?? null, 'concluded', null);
    });
  });
  return true;
}

/**
 * Apply a RenderPayload to a canonical underwriting template buffer:
 *   - write each cellBindings entry to its sheet/range
 *   - hide sheets not in visibleTabs (and unhide ones that are)
 *   - write each declared table at its layout coordinates
 *
 * No computation is performed; this is the renderer side of the
 * extraction → library → judgment → adjusted-inputs → metrics → render pipeline.
 */
// Operating-History historical-period columns + input rows on the standard
// (non-hotel) 'Operating History and Pro Forma' tab. Columns B/D/F/H are the
// 3rd-prior / 2nd-prior / prior / T12 trailing-actuals periods. Rows are the
// numeric INPUT lines only (PGR, Other Income, Reimbursements, the variable +
// fixed expenses, and the capital items) — the SUBTOTAL/formula rows
// (10,12,17,27,33,35,42,44) are intentionally excluded (they're formulas).
// Column J (UW pro-forma) and E16 (real IO-loan amortization 0) are NOT here.
const OH_HISTORICAL_TAB = 'Operating History and Pro Forma';
const OH_HISTORICAL_COLUMNS = ['B', 'D', 'F', 'H'] as const;
const OH_HISTORICAL_INPUT_ROWS = [9, 14, 15, 21, 22, 23, 24, 25, 26, 30, 31, 32, 38, 39, 40] as const;

/**
 * Blank the template-default 0s in the Operating History tab's historical
 * trailing-period input cells when no binding populated them. See the call site
 * in applyRenderPayloadToTemplate for the full rationale + invariants. Guards:
 * (1) only the standard non-hotel OH tab; (2) skip any cell a binding wrote
 * (writtenAddresses); (3) never null a formula cell; (4) only clear a literal
 * numeric 0 (the misleading template default) — leave anything else untouched.
 */
function clearAbsentOperatingHistoryZeros(
  workbook: ExcelJS.Workbook,
  writtenAddresses: ReadonlySet<string>,
): void {
  const ws = workbook.getWorksheet(OH_HISTORICAL_TAB);
  if (!ws) return; // hotel deals (different tab) or template without it → no-op
  for (const col of OH_HISTORICAL_COLUMNS) {
    for (const row of OH_HISTORICAL_INPUT_ROWS) {
      const ref = `${col}${row}`;
      if (writtenAddresses.has(`${OH_HISTORICAL_TAB}!${ref}`)) continue; // bound → keep
      const cell = ws.getCell(ref);
      if (cell.formula) continue;        // never null a formula
      if (cell.value === 0) cell.value = null; // strip the misleading default 0 only
    }
  }
}

// Asset class (case-insensitive) → the canonical 'Controls' table key the
// workbook's Factor VLOOKUP (`Z3 = VLOOKUP(Property_Type, Controls!A2:D17, 4, 0)`)
// expects. Keys verified against the Blank UW template's Controls sheet.
const ASSET_CLASS_TO_CONTROLS_KEY: Readonly<Record<string, string>> = {
  office:       'Office',
  retail:       'Retail',
  multifamily:  'Multifamily',
  hotel:        'Hotel',
  industrial:   'Industrial',
  selfstorage:  'Self-Storage',
  mhc:          'MHC',
  mixeduse:     'Mixed Use',
  other:        'Various',
};

// Rent Roll UW Base Rent PSF (see call site for rationale). Copies the schema-
// bound Contract Rent PSF (I = inPlaceRent/SF) into the unbound UW Base Rent PSF
// (K) per tenant, so M (= +K*D) surfaces UW Annual Rent = in-place rent. Same
// value + source as I (no estimate). Guards mirror the schema's: only where I is
// populated, never overwriting a formula cell. Touches only the Rent Roll input
// cells — no J/market, no M2M, no schema address.
function applyRentRollUwBaseRent(workbook: ExcelJS.Workbook): void {
  const ws = workbook.getWorksheet('Rent Roll');
  if (!ws) return;
  const I_COL = 9;   // Contract Rent PSF (schema-bound)
  const K_COL = 11;  // UW Base Rent PSF (unbound — drives M = +K*D)
  const FIRST_ROW = 14;
  const CAPACITY = 30; // RENT_ROLL_TENANT_CAPACITY — rows 14..43
  for (let row = FIRST_ROW; row < FIRST_ROW + CAPACITY; row++) {
    const iCell = ws.getCell(row, I_COL);
    const raw = iCell.value;
    const iVal =
      typeof raw === 'number'
        ? raw
        : raw !== null && typeof raw === 'object' && typeof (raw as { result?: unknown }).result === 'number'
          ? ((raw as { result: number }).result)
          : null;
    if (iVal === null) continue;          // only where Contract Rent PSF is populated
    const kCell = ws.getCell(row, K_COL);
    if (kCell.formula) continue;          // never overwrite a formula cell
    kCell.value = iVal;
  }
}

// Rent Roll size-tier classifier (workbook-polish; render-layer, no schema touch).
// Writes the single-char Office tier code into the "Code" column (E) per tenant,
// classified from squareFeet ALONE. The template's E is the tier-code cell —
// LEFT(E,1) feeds J (market-rent VLOOKUP) + AH (term/TI/LC by tier), RIGHT(E)
// feeds AE → B (SUMPRODUCT in-place-per-tier). The v10 schema mis-writes E as the
// status enum (its first letter never matches the M/L/T/X/Y lookup table), so the
// whole top-block tier table reads blank; overwriting E with the tier code lights
// it up. Safe: every per-tenant E consumer wants the tier code (none reads status),
// E never feeds the projection (PGI/vacancy/base-rent$ don't read it), and the
// income-catch is graph-sourced. Cutoffs reproduce the analyst's M/L/T assignment
// from SF (M = anchor ≥100k, T < 10k, else L) — the answer key is NOT read.
function applyRentRollSizeTier(workbook: ExcelJS.Workbook): void {
  const ws = workbook.getWorksheet('Rent Roll');
  if (!ws) return;
  const D_COL = 4;   // Square Feet (schema-bound)
  const E_COL = 5;   // "Code" — the single-char tier cell (LEFT/RIGHT(E) = tier)
  const FIRST_ROW = 14;
  const CAPACITY = 30; // rows 14..43
  for (let row = FIRST_ROW; row < FIRST_ROW + CAPACITY; row++) {
    const raw = ws.getCell(row, D_COL).value;
    const sf =
      typeof raw === 'number'
        ? raw
        : raw !== null && typeof raw === 'object' && typeof (raw as { result?: unknown }).result === 'number'
          ? ((raw as { result: number }).result)
          : null;
    if (sf === null) continue;            // only where Square Feet is populated
    const eCell = ws.getCell(row, E_COL);
    if (eCell.formula) continue;          // never overwrite a formula cell
    eCell.value = sf >= 100_000 ? 'M' : sf < 10_000 ? 'T' : 'L';
  }
}

// 10 Yr Pro Forma projection inputs (see call site for rationale). Two value-
// writes; both leave Year-1 untouched. Unmapped asset classes are LEFT ALONE
// (no guess) — Property_Type keeps the schema value and Factor stays as-is.
function applyProFormaProjectionInputs(workbook: ExcelJS.Workbook, assetClass: string): void {
  const key = ASSET_CLASS_TO_CONTROLS_KEY[String(assetClass).toLowerCase()];
  if (key === undefined) return; // unmapped asset class → leave the workbook alone (no guess)

  // (1) Property_Type → canonical Controls key (fixes Factor #N/A → unblocks the
  //     PGI PSF chain D21→E21→E22).
  for (const c of resolveNamedRangeCells(workbook, 'Property & Loan Summary', 'Property_Type')) {
    if (!c.formula) c.value = key;
  }

  // (2) Disable RRP → route to the STABILIZED-GROWTH projection. The render binds
  //     RRP="TRUE" to 'Property & Loan Summary'!AA3 (the M2M lease-rollover toggle).
  //     The RRP rollover rolls expiring leases to per-tenant MARKET rents and
  //     re-leases vacated space — data (marketRentAnnual) the current pipeline doesn't
  //     capture — so for RRP classes (Retail/Office/Industrial) it yields $0 rolled
  //     rent AND ~100% occupancy loss past Year 1 (PGI + EGI collapse → NOI deeply
  //     negative). Overwriting AA3 with "FALSE" bypasses BOTH the rent and occupancy
  //     rollovers, routing the projection through the template's own stabilized path
  //     (grow PGI off the real Year-1 figure; hold the Year-1 physical vacancy) — the
  //     same path MF/Hotel use. When per-tenant market comps are captured upstream,
  //     this should become conditional (keep RRP on for deals that have them).
  const plsRrp = workbook.getWorksheet('Property & Loan Summary');
  if (plsRrp) plsRrp.getCell('AA3').value = 'FALSE';

  // (3) Mode label → "Stabilized" (cosmetic; RRP-off already routes to growth) +
  //     a transparency note on the mode cell, so the projection's assumptions are
  //     legible in the workbook itself (the structured analysis-flag route would
  //     require a schema/contract change and is intentionally out of this surface).
  const pf = workbook.getWorksheet('10 Yr Pro Forma');
  if (pf) {
    const c8 = pf.getCell('C8');
    if (!c8.formula) c8.value = 'Stabilized';
    c8.note =
      'Stabilized projection: PGI grown ~1%/yr off the in-place Year-1; physical vacancy held at ' +
      'the Year-1 level. The Mark-to-Market lease-rollover is bypassed because per-tenant market ' +
      'comps were not captured. The state-agency tenants’ contractual 2027 step-down ' +
      '(~$60 → ~$49.80/SF on ~18.6% of rent) is NOT modeled, so later years are modestly ' +
      'optimistic on that slice; later-year NOI is approximate (1% rent growth vs faster OpEx growth).';
  }
}

export async function applyRenderPayloadToTemplate(
  templateBuffer: Buffer,
  payload: RenderPayload,
): Promise<RenderApplyResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  // Pre-resolve every sharedFormula descendant BEFORE any mutation. See the
  // function's JSDoc for the rationale: overwriting a master cell without
  // this pass orphans every descendant sharedFormula reference and either
  // throws or emits garbage at `xlsx.writeBuffer()` time. Phase 14 promoted
  // this from the phase13 one-off into the template-engine. The workbook
  // stays live/editable — each cell still carries its formula string.
  preResolveSharedFormulas(workbook);

  const writtenAddresses: string[] = [];
  const unresolvedAddresses: string[] = [];

  // payload.cellStates is REQUIRED at v8+. For pre-v8 payloads that may
  // still flow through here (legacy callers, fixtures), default each
  // address to 'concluded' — that matches the v6/v7 visual surface for
  // engine values and avoids the prior implicit "null → red" auto-fill
  // (now an explicit 'awaiting_input' state). cellComments is sparse;
  // missing addresses simply emit no comment.
  const cellStates = payload.cellStates ?? {};
  const cellComments = payload.cellComments ?? {};
  const cellOverwrites = payload.cellOverwrites ?? {};

  for (const [address, value] of Object.entries(payload.cellBindings)) {
    const parts = splitAddress(address);
    if (!parts) {
      unresolvedAddresses.push(address);
      continue;
    }
    const ws = workbook.getWorksheet(parts.sheet);
    if (!ws) {
      unresolvedAddresses.push(address);
      continue;
    }
    const state: CellState = cellStates[address] ?? 'concluded';
    const comment: CellComment | null = cellComments[address] ?? null;
    const forceOverwrite: boolean = cellOverwrites[address] === true;
    if (A1_PATTERN.test(parts.ref)) {
      writeCellValue(ws.getCell(parts.ref), value, state, comment, forceOverwrite);
      writtenAddresses.push(address);
      continue;
    }
    const cells = resolveNamedRangeCells(workbook, parts.sheet, parts.ref);
    if (!cells.length) {
      unresolvedAddresses.push(address);
      continue;
    }
    for (const c of cells) writeCellValue(c, value, state, comment, forceOverwrite);
    writtenAddresses.push(address);
  }

  // ── Operating-History historical-column zero cleanup (workbook-polish-zeros) ──
  // The Blank UW template ships the 'Operating History and Pro Forma' tab's
  // historical input cells (3rd-prior / 2nd-prior / prior / T12 = columns
  // B/D/F/H) pre-filled with 0. The render schema binds ONLY column J (the
  // appraisal pro-forma) and never populates the historical columns, so those
  // template-default 0s show through as a misleading "$0 across every year" for
  // deals with no trailing actuals (e.g. JE_TRAILING_ACTUALS_MISSING). Clear
  // them to blank so absent history reads as absent, not as a real zero.
  //
  // Invariant-safe: this mutates already-loaded cells only — it touches NO
  // cellBindings / schemaAddresses, so the versioned render-schema surface
  // (RENDER_CONTRACT_VERSION) is byte-identical. No version bump.
  //
  // Override precedence: `writtenAddresses` IS the gate. A cell is cleared ONLY
  // when it is NOT in writtenAddresses — i.e. no binding (today's column-J, or a
  // future historical-column feature) claimed it. A bound cell keeps its value,
  // so future per-period values survive untouched. We additionally (a) never
  // null a formula cell and (b) only clear a literal numeric 0 — so we strip the
  // template's misleading default zeros and nothing else.
  clearAbsentOperatingHistoryZeros(workbook, new Set(writtenAddresses));

  // ── 10 Yr Pro Forma projection inputs (workbook-polish; render-layer, no schema touch) ──
  // Two value-writes that unblock the multi-year projection (Year 1 is unaffected):
  //  (1) Property_Type — the schema binds the free-text descriptor (e.g. "Suburban
  //      Office") to the Property_Type named range, but Factor (Z3 = VLOOKUP(
  //      Property_Type, Controls, 4)) needs the canonical Controls key. A mismatch →
  //      Factor #N/A → the PGI PSF chain (D21→E21→E22) collapses to $0 past Year 1.
  //      Overwrite with the asset-class → Controls-key mapping.
  //  (2) Mode — set the pro-forma to "Stabilized" so PGI grows off the real Year-1
  //      figure (E21×Measure×Factor) rather than the Mark-to-Market rollover, which
  //      rolls expiring leases to per-tenant market comps we don't have (→ $0).
  // Invariant-safe: post-cellBindings cell mutations only; touches no schema address
  // (same precedent as clearAbsentOperatingHistoryZeros). No RENDER_CONTRACT bump.
  applyProFormaProjectionInputs(workbook, payload.assetClass);

  // ── Rent Roll UW Base Rent PSF (workbook-polish; render-layer, no schema touch) ──
  // The v10 rent-roll schema binds Contract Rent PSF (I = inPlaceRent/SF) but leaves
  // UW Base Rent PSF (K) unbound, so M (= +K*D = UW Annual Rent) stays blank — base
  // rent $ never surfaces despite the data being in hand. Mirror I → K per tenant so
  // M computes inPlaceRent. K shares I's EXACT value + source (no new value path, no
  // estimate); we only copy where I is populated and K isn't a formula. K lives here
  // in the post-pass while its sibling I is schema-bound — intentional + proportionate
  // to one derived column (formal schema-homing would be a separate governed v-bump
  // PR). Touches no schema address / version constant / migration — invariant-safe by
  // the same precedent as clearAbsentOperatingHistoryZeros / applyProFormaProjectionInputs.
  // Does NOT touch J (market rent) or the deliberately-bypassed M2M path.
  applyRentRollUwBaseRent(workbook);

  // ── Rent Roll size-tier classifier (workbook-polish; render-layer, no schema touch) ──
  // Writes the Office tier code (M/L/T) into the "Code" column (E) per tenant, derived
  // from squareFeet alone, so the top-block tier table (in-place-per-tier) resolves. The
  // v10 schema mis-writes E as status (breaking the tier lookups); this overwrites it
  // with the correct tier code. Display-only — E feeds no projection input, so the
  // income-catch is untouched. See the helper for the safety rationale + cutoffs.
  applyRentRollSizeTier(workbook);

  const visible = new Set(payload.visibleTabs);
  const hiddenSheets: string[] = [];
  workbook.eachSheet((ws) => {
    if (visible.has(ws.name)) {
      ws.state = 'visible';
    } else {
      ws.state = 'hidden';
      hiddenSheets.push(ws.name);
    }
  });

  const tablesWritten: string[] = [];
  for (const t of payload.tables) {
    if (writeTable(workbook, t)) tablesWritten.push(t.layout.name);
  }

  // ExcelJS write-path bug: cf-rule-xform.renderExpression / renderCellIs /
  // renderTop10 / renderAboveAverage / renderText / renderTimePeriod all
  // dereference `model.formulae[0]` without null-checking. Production
  // artifacts (e.g. Blank UW Template.xlsm) parse with conditional-formatting
  // rules where ExcelJS leaves `formulae` undefined or empty, and
  // writeBuffer() crashes with "Cannot read properties of undefined
  // (reading '0')". Drop those rules — they can't render anyway. This is
  // narrowly scoped: rules with valid formulae are preserved, as are
  // dataBar / colorScale / iconSet rules (which use cfvo, not formulae).
  sanitizeConditionalFormatting(workbook);

  // Provenance sweep: redact any string cell in the artifact carrying a
  // filesystem path or known ingestion marker. This catches values BAKED
  // INTO the artifact's cells (not just the cells we write). The
  // render-side scrubber hard-fails for paths in the cells we WROTE — those
  // indicate a producer bug. This sweep is the second line of defense for
  // legacy / artifact-resident data: it redacts in-place rather than
  // failing the export, since the artifact itself is the source of truth
  // and we cannot reject it.
  redactProvenanceInWorkbook(workbook);
  // Workbook-properties sweep: ExcelJS exposes core/app properties on the
  // workbook object (creator, lastModifiedBy, company, etc.). These are
  // stamping locations for usernames and source paths.
  redactProvenanceInWorkbookProperties(workbook);

  // ★ OOXML-validity sweep: ExcelJS internally evaluates some formulas
  // during load/serialize and caches the result onto cell.result. When the
  // formula's input is missing/null (e.g. EDATE(blank, 0)), the cached
  // result becomes JS NaN — which ExcelJS then serializes as the literal
  // `<v>NaN</v>` token, an OOXML-invalid construct that Excel and openpyxl
  // both reject on open. The writeCellValue NaN guard catches NaN values
  // we explicitly write; this sweep catches NaN cached on formula cells we
  // did NOT write to (which the formula guard preserves intact). For each
  // formula cell whose cached result is non-finite, we null the result so
  // Excel recomputes on open (and shows a valid #VALUE! / #N/A error if
  // the inputs really are missing). LOAD-BEARING INVARIANT: no formula
  // cell's cached value may serialize as NaN/Infinity.
  // (in-memory ExcelJS cell-walk attempts didn't reach the cached <v>
  // element for these specific formula cells; ExcelJS's serializer
  // re-emits the cached NaN regardless of cell.value / cell.model edits.
  // We rely on the byte-level sweep below at sanitizeNonFiniteCachedValues,
  // which runs against the serialized XML after writeBuffer.)

  // Force a full recalculation when Excel opens the workbook. ExcelJS writes
  // formula cells with their formula text but NO cached <v> result (it has no
  // calc engine), so every derived cell (Operating History row-27/33 subtotals,
  // row-35 NOI, the J/L/H column NOIs) would read 0/blank in any
  // non-calculating reader until Excel recomputes. Setting
  // calcProperties.fullCalcOnLoad emits <calcPr fullCalcOnLoad="1"/> in
  // xl/workbook.xml, which tells Excel to recompute ALL formulas on open.
  workbook.calcProperties.fullCalcOnLoad = true;

  let populatedBuffer: Buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  // Post-write deep sweep: ExcelJS does not expose drawing alt text,
  // docProps custom properties, comments, or shared strings via its cell
  // API. These survive the workbook round-trip with their original
  // contents — including UNC paths, usernames, file paths. Open the
  // resulting .xlsx as a zip, scan the relevant XML files, redact
  // matching strings in-place, and re-emit. Best-effort: failure here
  // does not block the export.
  populatedBuffer = await redactProvenanceFromXlsxBuffer(populatedBuffer);

  // ★ Final OOXML-validity gate. Strip any <v>NaN</v> / <v>Infinity</v>
  // cached values that survived the in-memory writeCellValue guard. This
  // happens at the byte level so it's robust against ExcelJS internal
  // re-evaluation behavior on writeBuffer.
  populatedBuffer = await sanitizeNonFiniteCachedValues(populatedBuffer);

  return {
    populatedBuffer,
    writtenAddresses,
    unresolvedAddresses,
    hiddenSheets,
    tablesWritten,
  };
}
