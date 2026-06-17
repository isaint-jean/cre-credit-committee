/**
 * extract-parties-from-asr — deterministic regex extractor for borrower /
 * sponsor / guarantor identity from a CMBS-style ASR PDF.
 *
 * The ASR's "Borrower Summary" section (typically p.6 on Goldman-format
 * ASRs) carries explicit "Borrower Entity Name:" and "Sponsor / Guarantor:"
 * labels followed by the entity strings. A loan-terms table on a later page
 * (typically p.7) restates "Borrower:" and "Sponsor:" alongside the term
 * sheet — same values, different label form. We accept either surface.
 *
 * No LLM. No fallback inference. If a label isn't found in the document text,
 * the field stays null (honest-blank discipline).
 */
import { extractText, getDocumentProxy } from 'unpdf';
import type { PartiesExtraction } from '@cre/contracts';

/** Strip the right edge of a name to drop trailing label noise that crept
 *  in due to PDF text layout (e.g. "Sunroad Holding Corporation Entity State:"
 *  would otherwise carry the "Entity State:" suffix). Cuts at known
 *  cohabitant labels. Preserves commas inside the entity name itself
 *  (e.g. "Sunroad Centrum Office One Partners, LP"). */
function cleanName(raw: string): string {
  let v = raw.trim();
  // Cut at any subsequent label keyword that may have wrapped onto the line.
  const cutAt = v.search(/\s+(?:Entity\s+(?:Type|State)|Borrower\s+Net\s+Worth|Sponsor\s+(?:Net\s+Worth|Liquidity)|Non-Consolidation|Independent\s+Director|Affiliated\s+with|Management\s+Fee|Date\s+of|Recourse|Remaining|Post-Closing|Interest\s+Only)\s*:/);
  if (cutAt !== -1) v = v.slice(0, cutAt).trim();
  // Drop a trailing label artifact when the value itself ends in ":" + nothing
  v = v.replace(/\s*:\s*$/, '').trim();
  return v;
}

/** Multi-line tolerant match: search for `<label> <value>` allowing the
 *  value to span up to 2 lines (CMBS-style entity names sometimes wrap). */
function matchAcrossLines(text: string, labelPattern: RegExp): string | null {
  const m = text.match(labelPattern);
  if (!m) return null;
  // Take the captured group; if it ends with a hanging continuation token
  // (like a stray comma or "Partners,"), pull the following ~80 chars to
  // complete the entity name, then cleanName.
  const captured = (m[1] ?? '').replace(/\s+/g, ' ').trim();
  // Look at up to 60 chars AFTER the captured group in case the entity name
  // wrapped onto the next "line" (which PDFs render as a single concatenated
  // string in pdf-text output).
  const idxEnd = (m.index ?? 0) + m[0].length;
  const tail = text.slice(idxEnd, idxEnd + 60);
  // If the captured looks truncated (ends with a comma, or doesn't contain
  // any of the common entity-suffix tokens "LP", "LLC", "Inc.", "Corp.",
  // "Corporation", "Trust", "Partners", "Holdings"), append the tail up to
  // the first sentence-terminator or label keyword.
  const looksComplete = /\b(?:LP|LLC|Inc\.?|Corp\.?|Corporation|Trust|Partners(?:hip)?|Holdings)\b/.test(captured);
  const endsAwkwardly = /,\s*$/.test(captured) || captured.length < 12;
  if (!looksComplete && endsAwkwardly) {
    const continuation = tail.match(/^([^|\n]{0,80}?)(?=\s+(?:Entity|Borrower|Sponsor|Recourse|Type|State|Net\s+Worth|Liquidity|Non-Consolidation|Date|Management|:)|[.\n]|$)/);
    if (continuation && continuation[1]) {
      return cleanName(captured + ' ' + continuation[1]);
    }
  }
  return cleanName(captured);
}

/**
 * Pure text-only parse step. Tested in isolation against representative ASR
 * text strings — no PDF dependency. `pages` is the array of per-page text
 * strings (length 1 acceptable for single-page or merged text).
 */
export function parsePartiesFromAsrText(pages: readonly string[]): PartiesExtraction {
  let borrowerName: string | null = null;
  let sponsorName: string | null = null;
  const pageReferences: Record<string, number> = {};

  // Scan each page; first match wins. "Borrower Entity Name" is the most
  // explicit ASR label; the loan-terms-table "Borrower:" is fallback.
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i];
    if (borrowerName === null) {
      const v =
        matchAcrossLines(t, /Borrower\s+Entity\s+Name\s*:\s*([^\n|]+(?:\n[^\n|]+)?)/i)
        ?? matchAcrossLines(t, /(?<!Recourse\s)(?<!Carveout\s)\bBorrower\s*:\s*([^\n|]+(?:\n[^\n|]+)?)/i);
      if (v && v.length > 0) {
        borrowerName = v;
        pageReferences['borrowerName'] = i + 1;
      }
    }
    if (sponsorName === null) {
      // Prefer "Sponsor / Guarantor" (most explicit) over bare "Sponsor:"
      // (which can match "Sponsor Net Worth:" / "Sponsor Liquidity:").
      const v =
        matchAcrossLines(t, /Sponsor\s*\/\s*Guarantor\s*:\s*([^\n|]+(?:\n[^\n|]+)?)/i)
        ?? matchAcrossLines(t, /\bSponsor\s*:\s*([^\n|]+(?:\n[^\n|]+)?)/i);
      if (v && v.length > 0) {
        sponsorName = v;
        pageReferences['sponsorName'] = i + 1;
      }
    }
    if (borrowerName !== null && sponsorName !== null) break;
  }

  return { borrowerName, sponsorName, pageReferences };
}

/** PDF-loading wrapper. Loads the document, extracts per-page text, and
 *  delegates to the pure parse step. */
export async function extractPartiesFromAsr(pdf: Buffer): Promise<PartiesExtraction> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: false });
  const pages: string[] = Array.isArray(text) ? text : [String(text)];
  return parsePartiesFromAsrText(pages);
}
