/**
 * Template Engine Service
 *
 * Reads full Excel templates using ExcelJS (preserving formulas),
 * analyzes multi-tab structure, maps extracted deal data into correct
 * cells, and produces a populated Excel workbook for export.
 */

import ExcelJS from 'exceljs';
import type {
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

  // Tenant rows. Cap at the template's allocated input rows; the Summary
  // block (Leased/Vacant/Total) starts around row 250 in the blank template.
  const SUMMARY_GUARD_ROW = 248;
  const writableRows = Math.max(0, SUMMARY_GUARD_ROW - RENT_ROLL_FIRST_DATA_ROW);
  const lineLimit = Math.min(rentRoll.lines.length, writableRows);

  for (let i = 0; i < lineLimit; i++) {
    const line = rentRoll.lines[i]!;
    const row = RENT_ROLL_FIRST_DATA_ROW + i;
    writes += writeTenantRow(worksheet, row, i + 1, line, entries);
  }

  return { writes, entries };
}

// Write one tenant row. Returns count of cells actually written. Every cell
// is guarded: formula cells are skipped (the workbook may pin certain rows
// or columns), and null line fields are skipped (no zero fabrication).
function writeTenantRow(
  worksheet: ExcelJS.Worksheet,
  row: number,
  rank: number,
  line: RentRollLine,
  entries: MappedField[],
): number {
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
 * ARGB for the red flag fill applied to empty / missing cells.
 * Light-red so existing dark text remains legible, but unmistakably
 * different from the artifact's default cell fills.
 */
const MISSING_DATA_FILL_ARGB = 'FFFFC7CE';

function writeCellValue(cell: ExcelJS.Cell, value: CellValue): void {
  if (value === null) {
    cell.value = null;
  } else {
    cell.value = value as any;
  }
  // Per spec §4 "If a value is missing → write empty cell value, apply RED
  // CELL STYLE". Empty string is also treated as missing.
  const isMissing = value === null || value === '';
  if (isMissing) {
    try {
      (cell as any).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: MISSING_DATA_FILL_ARGB },
      };
    } catch {
      /* styling failure must not block the write */
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
      writeCellValue(ws.getCell(table.layout.dataStartRow + rIdx, cIdx + 1), v ?? null);
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
export async function applyRenderPayloadToTemplate(
  templateBuffer: Buffer,
  payload: RenderPayload,
): Promise<RenderApplyResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  const writtenAddresses: string[] = [];
  const unresolvedAddresses: string[] = [];

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
    if (A1_PATTERN.test(parts.ref)) {
      writeCellValue(ws.getCell(parts.ref), value);
      writtenAddresses.push(address);
      continue;
    }
    const cells = resolveNamedRangeCells(workbook, parts.sheet, parts.ref);
    if (!cells.length) {
      unresolvedAddresses.push(address);
      continue;
    }
    for (const c of cells) writeCellValue(c, value);
    writtenAddresses.push(address);
  }

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

  let populatedBuffer: Buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  // Post-write deep sweep: ExcelJS does not expose drawing alt text,
  // docProps custom properties, comments, or shared strings via its cell
  // API. These survive the workbook round-trip with their original
  // contents — including UNC paths, usernames, file paths. Open the
  // resulting .xlsx as a zip, scan the relevant XML files, redact
  // matching strings in-place, and re-emit. Best-effort: failure here
  // does not block the export.
  populatedBuffer = await redactProvenanceFromXlsxBuffer(populatedBuffer);

  return {
    populatedBuffer,
    writtenAddresses,
    unresolvedAddresses,
    hiddenSheets,
    tablesWritten,
  };
}
