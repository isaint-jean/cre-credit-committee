import { extractText, getDocumentProxy } from 'unpdf';
import type { AsrCashFlows, AsrCashFlowLadder } from '@cre/contracts';

/**
 * Parser for the ASR "Underwritten Cash Flows" table (page 12 of the Sunroad-
 * style ASR) → a per-column income/expense/NOI ladder. The types live in the
 * contract (`@cre/contracts`) — this is the parsing logic only.
 *
 * ★ The table extracts CLEAN / row-major via unpdf (unlike the appraisal Part-A
 *   pages, which reorder text). Each row is one line `<label> <7 column $> <%>
 *   <$/SF>`. So we anchor on the row label and read the columns positionally —
 *   no layout reconstruction.
 *
 * ★ Validated (never copied from the answer key — derived from the source PDF):
 *   NOI 2021 −914,620 · 2022 1,905,814 · 2023 3,778,355 · T12 3,863,872 ·
 *   UW 9,294,609; appraisal-col NOI 8,603,823 confirms column alignment; Budget
 *   (col 5) correctly dropped. NB the ASR's 2023 NOI differs ~$10K from the
 *   OK-TO-PRINT key (3,768,059) — we reproduce the SOURCE.
 *
 * Two entry points:
 *   · `parseAsrCashFlowsFromText(text)` — text core, used by the ASR extractor
 *     on `document.rawText` (= pages.join('\n'), all pages). ANCHOR-SCOPED to
 *     the "Underwritten Cash Flows" heading so labels that recur elsewhere in
 *     the document (e.g. "Net Operating Income") don't get mis-read.
 *   · `extractAsrCashFlows(buffer)` — buffer wrapper for standalone use.
 */

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
 * Columns: 0=2021, 1=2022, 2=2023, 3=Trailing-12, 4=Budget, 5=Appraisal,
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
 * Take the LAST 7 non-decimal numeric tokens, treating `(…)` as negative. This
 * isolates the columns from a leading footnote digit ("Base Rental Revenue1")
 * and the trailing `%` and `$/SF` decimals (columns are whole dollars).
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

/**
 * Parse the "Underwritten Cash Flows" table out of already-extracted text
 * (e.g. ParsedDocument.rawText = pages.join('\n')). ANCHOR-SCOPED: only the
 * lines AFTER the "Underwritten Cash Flows" heading are parsed, so a label that
 * recurs elsewhere in the document is never matched. Returns null when the
 * anchor or the spine (UW NOI) isn't found.
 */
export function parseAsrCashFlowsFromText(text: string): AsrCashFlows | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const allLines = text.split('\n');
  const anchor = allLines.findIndex((l) => /Underwritten Cash Flow/i.test(l));
  if (anchor < 0) return null;
  const lines = allLines.slice(anchor + 1);

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
      (result[key] as Record<keyof AsrCashFlowLadder, number | null>)[field] = cols[colIndex];
    }
    rowsParsed += 1;
  }

  if (rowsParsed === 0 || result.uw.netOperatingIncome === null) return null;
  return result;
}

/** Buffer wrapper for standalone use — extracts the PDF text then parses. */
export async function extractAsrCashFlows(pdfBuffer: Buffer): Promise<AsrCashFlows | null> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return parseAsrCashFlowsFromText(pages.join('\n'));
}
