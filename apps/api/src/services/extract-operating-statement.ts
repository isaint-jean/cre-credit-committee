import { extractText, getDocumentProxy } from 'unpdf';
import type {
  BorrowerOperatingStatementExtraction,
  BorrowerOperatingStatementLine,
} from '@cre/contracts';

/**
 * Parser for a borrower-supplied GL operating statement PDF (Centrum-style:
 * "Centrum Office One Partners LP — Statement (12 months), Mar 2023–Feb 2024").
 * Produces a RAW account ladder (code + label + period total) + the statement's
 * own subtotal lines. PURE MIRROR — no normalization (the one-time / reclass
 * adjustments are a separate judgment layer, Phase 3).
 *
 * ★ Structure (confirmed from the source PDF): 3-page text-PDF, every data row
 *   is `<6-digit acct> <label> <12 monthly $> <Total $>`. unpdf merges it into
 *   one token stream; we split on the 6-digit account codes and, within each
 *   record, read the MONETARY tokens (formatted `…,###.##`) — taking the 13th
 *   (the Total, after the 12 months). Two wrinkles handled:
 *     · the TOTAL is the LAST of the 13 monthly+total figures, not month-1;
 *     · page-header lines ("…Statement (12 months)… Page 1 of 3 … Mar 2023 …")
 *       interrupt mid-ladder — they carry NO `.##` monetary tokens, so they
 *       never contribute a figure and are skipped for free.
 *
 * ★ Account codes are the only bare 6-consecutive-digit tokens (every dollar
 *   value ≥ $1,000 is comma-grouped, so `\d{6}` can't match inside one; values
 *   < $1,000 are < 6 digits). Section-header rows (e.g. "410000 REVENUE") carry
 *   no monetary token → emitted as no line.
 *
 * ★ Validated against the source (never copied): raw NOI (665999) =
 *   $6,952,469.80; TOTAL REVENUE (499999) = $9,750,250.95; TOTAL OPERATING
 *   EXPENSES (665899) = $2,797,781.15.
 */

/** A monetary token: optional leading minus, comma-grouped, exactly 2 decimals. */
const MONEY_RE = /-?[\d,]+\.\d{2}/g;

/** Parse a monetary token ("-1,044.48") → number. Returns null if unparseable. */
function money(token: string): number | null {
  const n = Number(token.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Subtotal account codes whose Total we surface explicitly. */
const TOTAL_REVENUE_CODE = '499999';
const TOTAL_OPEX_CODE = '665899';
const NOI_CODE = '665999';

/**
 * Parse the raw operating-statement ladder out of already-extracted PDF text
 * (the merged token stream). Returns null if no account records are found.
 */
export function parseOperatingStatementFromText(
  text: string,
): BorrowerOperatingStatementExtraction | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Entity + period from the page header (printed on every page).
  // Restrict the entity name to letters+spaces so it can't span across the
  // numeric ladder (the page-header entity is "…Partners LP (020)").
  const entityMatch = text.match(/([A-Z][A-Za-z ]*? LP)\s*\(\d+\)/);
  const periodMatch = text.match(/Period\s*=\s*([A-Za-z]{3} \d{4}-[A-Za-z]{3} \d{4})/);

  // Split the stream into records, one per 6-digit account code. The capture
  // keeps the code; everything up to the next code is that record's body.
  const parts = text.split(/(?<!\d)(\d{6})(?!\d)/);
  // parts = [preamble, code1, body1, code2, body2, ...]
  const lines: BorrowerOperatingStatementLine[] = [];
  let totalRevenue: number | null = null;
  let totalOperatingExpenses: number | null = null;
  let netOperatingIncome: number | null = null;

  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i];
    const body = parts[i + 1] ?? '';
    const moneyTokens = body.match(MONEY_RE) ?? [];
    if (moneyTokens.length < 13) continue; // section header / no figures → skip

    // The Total is the 13th figure (12 months + total). Take index 12 — robust
    // to any trailing page-header junk (which carries no `.##` tokens anyway).
    const total = money(moneyTokens[12]);
    if (total === null) continue;

    // Label = the body text BEFORE the first monetary token, trimmed.
    const firstMoneyIdx = body.search(MONEY_RE);
    const label = body
      .slice(0, firstMoneyIdx < 0 ? body.length : firstMoneyIdx)
      .replace(/\s+/g, ' ')
      .trim();

    lines.push({ accountCode: code, label, total });

    if (code === TOTAL_REVENUE_CODE) totalRevenue = total;
    else if (code === TOTAL_OPEX_CODE) totalOperatingExpenses = total;
    else if (code === NOI_CODE) netOperatingIncome = total;
  }

  if (lines.length === 0) return null;

  return {
    period: periodMatch ? periodMatch[1] : null,
    entity: entityMatch ? entityMatch[1].trim() : null,
    lines,
    totalRevenue,
    totalOperatingExpenses,
    netOperatingIncome,
  };
}

/** Buffer wrapper for standalone use — extracts the PDF text then parses. */
export async function extractOperatingStatement(
  pdfBuffer: Buffer,
): Promise<BorrowerOperatingStatementExtraction | null> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return parseOperatingStatementFromText(Array.isArray(text) ? text.join('\n') : text);
}
