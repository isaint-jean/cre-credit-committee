/**
 * computeWorkbookCoverage — measure how populated an xlsx/xlsm workbook is.
 *
 * Counts every cell on every worksheet and classifies into four buckets:
 *   - emptyCells:       cell value is null/undefined
 *   - formulaCells:     cell has a formula (regardless of cached result)
 *   - realDataCells:    non-formula, non-empty, value is "informative"
 *                       (non-zero number, non-empty string, true boolean,
 *                       or a Date)
 *   - placeholderCells: non-formula, non-empty, but value is 0, empty string,
 *                       or whitespace-only string (the template's pre-fill defaults)
 *
 * Population rate = realDataCells / totalCells, matching the user's external
 * measurement tool. Includes empty cells in the denominator (so a tab with
 * lots of unused space gets a low rate). Use the absolute counts
 * (realDataCells, formulaCells) when you need the populated-surface picture.
 *
 * Status thresholds (chosen to match the user's reporting):
 *   < 5%      NOT POPULATED
 *   5%–10%    MINIMALLY POPULATED
 *   10%–20%   PARTIALLY POPULATED
 *   20%–50%   POPULATED
 *   >= 50%    FULLY POPULATED
 *
 * CAVEAT — important for interpretation:
 *   ExcelJS does NOT recalculate formulas on read. Formula cells carry their
 *   cached result (whatever the source app last computed). Many template
 *   formula cells cache zero because they were never recalculated after the
 *   template was created. Opening the file in Excel and saving WILL change
 *   the cached results and shift cells from placeholder→realData. The user
 *   running this analyzer outside Excel should not treat low rates on
 *   formula-heavy tabs (10 Yr Pro Forma, Presentation Rent Roll, Detailed
 *   Rollover) as a real coverage gap until the workbook has been opened in
 *   Excel at least once.
 */

import ExcelJS from 'exceljs';

export type CoverageStatus =
  | 'NOT POPULATED'
  | 'MINIMALLY POPULATED'
  | 'PARTIALLY POPULATED'
  | 'POPULATED'
  | 'FULLY POPULATED';

export interface TabCoverage {
  readonly name: string;
  readonly totalCells: number;
  readonly formulaCells: number;
  readonly realDataCells: number;
  readonly placeholderCells: number;
  readonly emptyCells: number;
  readonly populationRate: number;    // 0..1
  readonly status: CoverageStatus;
}

export interface WorkbookCoverage {
  readonly tabs: readonly TabCoverage[];
  readonly overall: {
    readonly totalTabs: number;
    readonly totalCells: number;
    readonly realDataCells: number;
    readonly populationRate: number;
  };
}

function classifyValue(cell: ExcelJS.Cell): 'empty' | 'formula' | 'real' | 'placeholder' {
  if (cell.formula) return 'formula';
  const v = cell.value;
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'string') {
    return v.trim().length === 0 ? 'placeholder' : 'real';
  }
  if (typeof v === 'number') {
    return v === 0 ? 'placeholder' : 'real';
  }
  if (typeof v === 'boolean') {
    return 'real';
  }
  if (v instanceof Date) {
    return 'real';
  }
  // RichText, hyperlink, etc.
  if (typeof v === 'object') {
    if ('richText' in v) {
      const txt = ((v as { richText: { text: string }[] }).richText)
        .map((r) => r.text).join('').trim();
      return txt.length === 0 ? 'placeholder' : 'real';
    }
    if ('text' in v) {
      const t = (v as { text: unknown }).text;
      return typeof t === 'string' && t.trim().length > 0 ? 'real' : 'placeholder';
    }
    // Sharedstring / error / result-only — treat as placeholder
    return 'placeholder';
  }
  return 'placeholder';
}

function statusFor(rate: number): CoverageStatus {
  if (rate < 0.05) return 'NOT POPULATED';
  if (rate < 0.10) return 'MINIMALLY POPULATED';
  if (rate < 0.20) return 'PARTIALLY POPULATED';
  if (rate < 0.50) return 'POPULATED';
  return 'FULLY POPULATED';
}

export async function computeWorkbookCoverage(buffer: Buffer): Promise<WorkbookCoverage> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);

  const tabs: TabCoverage[] = [];
  let overallTotal = 0;
  let overallReal = 0;

  wb.eachSheet((ws) => {
    let total = 0;
    let formula = 0;
    let real = 0;
    let placeholder = 0;
    let empty = 0;

    // Iterate every cell within the worksheet's used range. ExcelJS sparse
    // iteration via eachRow + eachCell visits only allocated cells; we
    // multiply rowCount × columnCount for the total cell budget.
    total = ws.rowCount * ws.columnCount;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const kind = classifyValue(cell);
        if (kind === 'formula') formula++;
        else if (kind === 'real') real++;
        else if (kind === 'placeholder') placeholder++;
      });
    });
    empty = total - (formula + real + placeholder);

    // Population rate denominator: total cells on the tab (including empty).
    // Matches the user's external measurement tool so reports are directly
    // comparable. Tabs with lots of unused empty cells get a low rate even
    // when their input-cell surface is fully filled.
    const denominator = total;
    const rate = denominator > 0 ? real / denominator : 0;

    tabs.push({
      name: ws.name,
      totalCells: total,
      formulaCells: formula,
      realDataCells: real,
      placeholderCells: placeholder,
      emptyCells: empty,
      populationRate: rate,
      status: statusFor(rate),
    });

    overallTotal += total;
    overallReal += real;
  });

  return {
    tabs,
    overall: {
      totalTabs: tabs.length,
      totalCells: overallTotal,
      realDataCells: overallReal,
      populationRate: overallTotal > 0 ? overallReal / overallTotal : 0,
    },
  };
}
