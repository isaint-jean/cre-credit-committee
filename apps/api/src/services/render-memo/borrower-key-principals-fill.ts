/**
 * fillBorrowerKeyPrincipals — write the extracted sponsor PRINCIPALS
 * (ExtractionResult/PartiesExtraction.sponsors[]) into the Borrower tab's
 * "Other Key Principals / Sponsor(s)" list (D13:D18). EXPORT-ONLY, MINT-SAFE.
 *
 * The names are deterministic ASR extraction (extract-parties-from-asr), already stamped on
 * the analysis but bound to NO cell today — this surfaces the discarded content. It's an
 * opt-in post-payload fill (like the comps / site-inspection fills), NOT a render-schema
 * binding: the schema is version-fingerprint-locked, and a variable-length list into
 * consecutive cells is exactly the shape the opt-in fill handles honest-blank.
 *
 * When the structured list is present it is AUTHORITATIVE for D13:D18 (D13 = sponsors[0], the
 * primary — same party the render-schema 'Sponsor' bind puts there). When it is ABSENT (older
 * deals / single-sponsor with no list), the fill is a no-op → D13 keeps the render-schema
 * sponsorName and D14:D18 stay blank. Honest-blank throughout; never fabricated.
 */
import type ExcelJS from 'exceljs';

export const BORROWER_SHEET = 'Borrower';
const FIRST_PRINCIPAL_ROW = 13; // D13..D18 — the Key Principals list (6 slots)
const PRINCIPAL_COL = 4;        // D
const MAX_PRINCIPALS = 6;

/**
 * Fill D13:D18 from the sponsor principals. No-op when the sheet is absent or the list is
 * empty (→ byte-unchanged; opt-in at the caller). Fills up to 6; any beyond that are dropped
 * (the template has 6 slots — returned so the caller can note the overflow honestly).
 */
export function fillBorrowerKeyPrincipals(
  workbook: ExcelJS.Workbook,
  sponsors: readonly string[] | null | undefined,
): { written: number; dropped: number } {
  const names = (sponsors ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => s.length > 0);
  if (names.length === 0) return { written: 0, dropped: 0 };
  const ws = workbook.getWorksheet(BORROWER_SHEET);
  if (ws === undefined) return { written: 0, dropped: 0 };

  const toWrite = names.slice(0, MAX_PRINCIPALS);
  toWrite.forEach((name, i) => {
    ws.getCell(FIRST_PRINCIPAL_ROW + i, PRINCIPAL_COL).value = name;
  });
  return { written: toWrite.length, dropped: Math.max(0, names.length - MAX_PRINCIPALS) };
}
