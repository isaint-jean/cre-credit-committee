import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Standalone parser for the ASR "Underwritten Cash Flows" table (page 12 of the
 * Sunroad-style ASR). Pure function: pdfBuffer → per-column income/expense/NOI
 * ladder. NOT yet wired into the extraction pipeline (no contract type, no
 * hydrate/resolver/schema) — that's a later phase. See memory
 * `operating-history-page-fix` for the phased plan.
 *
 * ★ The page-12 table extracts CLEAN / row-major via unpdf (unlike the
 *   appraisal Part-A pages, which reorder text). Each row is one line:
 *   `<label> <7 column $> <%> <$/SF>`. So we anchor on the row label and read
 *   the column numbers positionally — no layout reconstruction needed.
 *
 * ★ Validated (PHASE 1, never copied from the answer key — derived from the
 *   source PDF and checked against it): NOI 2021 −914,620 · 2022 1,905,814 ·
 *   2023 3,778,355 · T12 3,863,872 · UW 9,294,609; appraisal-col NOI 8,603,823
 *   confirms column alignment; Budget (col 5) correctly dropped.
 *   NB: the ASR's 2023 NOI (3,778,355) differs from the OK-TO-PRINT key's
 *   3,768,059 by ~$10K (an analyst expense tweak) — we reproduce the SOURCE.
 */

export interface AsrCashFlowLadder {
  baseRentalRevenue: number | null;
  commercialReimbursementRevenue: number | null;
  parkingIncome: number | null;
  otherRevenue: number | null;
  potentialGrossRevenue: number | null;
  vacancyLoss: number | null;
  effectiveGrossRevenue: number | null;
  realEstateTaxes: number | null;
  insurance: number | null;
  utilities: number | null;
  repairsAndMaintenance: number | null;
  managementFee: number | null;
  generalAndAdministrative: number | null;
  totalExpenses: number | null;
  netOperatingIncome: number | null;
  replacementReserves: number | null;
  tenantImprovements: number | null;
  leasingCommissions: number | null;
  netCashFlow: number | null;
}

export interface AsrCashFlows {
  y2021: AsrCashFlowLadder;
  y2022: AsrCashFlowLadder;
  y2023: AsrCashFlowLadder;
  t12: AsrCashFlowLadder;
  /** ASR col 6 — kept for cross-validation against the appraisal extractor (col 5 Budget is dropped). */
  appraisal: AsrCashFlowLadder;
  uw: AsrCashFlowLadder;
}

/** Row label (as it appears in the PDF) → ladder field. */
const ROW_FIELD_MAP: ReadonlyArray<readonly [string, keyof AsrCashFlowLadder]> = [
  ['Base Rental Revenue', 'baseRentalRevenue'],
  ['Commercial Reimbursement Revenue', 'commercialReimbursementRevenue'],
  ['Parking Income', 'parkingIncome'],
  ['Other Revenue', 'otherRevenue'],
  ['Potential Gross Revenue', 'potentialGrossRevenue'],
  ['Vacancy Loss', 'vacancyLoss'],
  ['Effective Gross Revenue', 'effectiveGrossRevenue'],
  ['Real Estate Taxes', 'realEstateTaxes'],
  ['Insurance', 'insurance'],
  ['Utilities', 'utilities'],
  ['Repairs & Maintenance', 'repairsAndMaintenance'],
  ['Management Fee', 'managementFee'],
  ['General and Administrative - Direct', 'generalAndAdministrative'],
  ['Total Expenses', 'totalExpenses'],
  ['Net Operating Income', 'netOperatingIncome'],
  ['Replacement Reserves', 'replacementReserves'],
  ['Tenant Improvements', 'tenantImprovements'],
  ['Leasing Commissions', 'leasingCommissions'],
  ['Net Cash Flow', 'netCashFlow'],
];

/**
 * ASR column index (0-based, in the 7-column table) → output ladder key.
 * Columns are: 0=2021, 1=2022, 2=2023, 3=Trailing-12, 4=Budget, 5=Appraisal,
 * 6=GS U/W. We KEEP 0/1/2/3/5/6 and DROP 4 (Budget — the workbook has no Budget
 * column; letting it shift the map is the alignment trap).
 */
const COL_INDEX_TO_KEY: ReadonlyArray<readonly [number, keyof AsrCashFlows]> = [
  [0, 'y2021'],
  [1, 'y2022'],
  [2, 'y2023'],
  [3, 't12'],
  // index 4 = Budget — intentionally dropped.
  [5, 'appraisal'],
  [6, 'uw'],
];

/**
 * Read the 7 column values from a row's text (everything after the label).
 * Strategy: take the LAST 7 non-decimal numeric tokens, treating `(…)` as
 * negative. This isolates the columns from:
 *   · a leading footnote digit (e.g. "Base Rental Revenue1") — dropped by slice(-7),
 *   · the trailing `%` column and `$/SF` column — both decimals, filtered out
 *     (every column value is a whole dollar amount).
 */
function parseRowColumns(rest: string): number[] {
  const tokens = rest.match(/\(?-?\$?[\d,]+(?:\.\d+)?\)?%?/g) ?? [];
  const ints: number[] = [];
  for (const t of tokens) {
    if (t.includes('%')) continue; // the % column
    if (/\.\d/.test(t)) continue; // the $/SF column (decimal)
    const negative = t.includes('(') || t.startsWith('-');
    const n = Number(t.replace(/[$(),\-]/g, ''));
    if (Number.isNaN(n)) continue;
    ints.push(negative ? -n : n);
  }
  return ints.slice(-7);
}

function emptyLadder(): AsrCashFlowLadder {
  return {
    baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null,
    otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: null,
    realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null,
    managementFee: null, generalAndAdministrative: null, totalExpenses: null, netOperatingIncome: null,
    replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: null,
  };
}

/** Parse the ASR "Underwritten Cash Flows" page. Returns null if the page/table isn't found. */
export async function extractAsrCashFlows(pdfBuffer: Buffer): Promise<AsrCashFlows | null> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text: pages } = await extractText(pdf, { mergePages: false });

  const pageIndex = pages.findIndex((p) => /Underwritten Cash Flow/i.test(p));
  if (pageIndex < 0) return null;
  const lines = pages[pageIndex].split('\n');

  const result: AsrCashFlows = {
    y2021: emptyLadder(), y2022: emptyLadder(), y2023: emptyLadder(),
    t12: emptyLadder(), appraisal: emptyLadder(), uw: emptyLadder(),
  };

  let rowsParsed = 0;
  for (const [label, field] of ROW_FIELD_MAP) {
    const line = lines.find((l) => l.replace(/\s+/g, ' ').trim().startsWith(label));
    if (!line) continue;
    const rest = line.replace(/\s+/g, ' ').trim().slice(label.length);
    const cols = parseRowColumns(rest);
    if (cols.length !== 7) continue; // malformed row — leave the field null
    for (const [colIndex, key] of COL_INDEX_TO_KEY) {
      result[key][field] = cols[colIndex];
    }
    rowsParsed += 1;
  }

  // If we didn't parse the spine rows (NOI at minimum), treat the table as absent.
  if (rowsParsed === 0 || result.uw.netOperatingIncome === null) return null;
  return result;
}
