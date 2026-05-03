/**
 * Template Engine Service
 *
 * Reads full Excel templates using ExcelJS (preserving formulas),
 * analyzes multi-tab structure, maps extracted deal data into correct
 * cells, and produces a populated Excel workbook for export.
 */

import ExcelJS from 'exceljs';
import type { UnderwritingModel } from '@cre/shared';

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
  value: number | string;
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
  loanTerm:            /(?:loan\s*)?term|maturity/i,
  annualDebtService:   /annual\s*debt\s*service|ads|debt\s*service/i,
  dscr:                /dscr|debt\s*service\s*coverage/i,
  ltv:                 /ltv|loan\s*to\s*value/i,
  debtYield:           /debt\s*yield/i,
};

interface CellTarget {
  field: string;
  worksheet: ExcelJS.Worksheet;
  row: number;
  col: number;
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
function buildValueMap(uwModel: UnderwritingModel): Record<string, number | string | null> {
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
  };
}

// ---------------------------------------------------------------------------
// Populate Template (Single Loan)
// ---------------------------------------------------------------------------

export async function populateTemplate(
  templateBuffer: Buffer,
  uwModel: UnderwritingModel,
): Promise<PopulationResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer as any);

  const valueMap = buildValueMap(uwModel);
  const mappedFields: MappedField[] = [];
  const tabsPopulated = new Set<string>();
  const fieldsUsed = new Set<string>();

  // Scan every worksheet for field targets
  workbook.eachSheet((worksheet) => {
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

  const outputBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    populatedBuffer: outputBuffer,
    mappedFields,
    unmappedFields,
    tabsPopulated: [...tabsPopulated],
  };
}
