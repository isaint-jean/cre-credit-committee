/**
 * Page-1 text extractor for the Data-Room content-classify tier (SLICE 1).
 *
 * The CONTENT tier of the routing cascade is the tier-3 fallback: it runs ONLY
 * when the folder + filename tiers both fail to resolve an axis. This module
 * pulls a document's page-1 text ONCE per file (memoized by identity), and only
 * when the cascade actually reaches for it, so the scan stays cheap.
 *
 * Dispatch by magic bytes (NOT by extension — zip entries arrive as
 * application/octet-stream with a bare leaf name):
 *   - PDF  (`%PDF`)          → parsePdf(bytes).pages[0]  (the cover page)
 *   - XLSX (`PK\x03\x04`)    → parseExcel headers / first-sheet text
 *   - anything else          → '' (no content signal → the loan/docType axes
 *                                   refuse, exactly like a nameless file)
 *
 * ★ NO-LLM: this reads bytes with the same deterministic `unpdf` / `xlsx`
 *   parsers the ingest pipeline uses. No anthropic import, no network — it runs
 *   with API credits depleted and still yields page-1 text.
 */

import { extractText, getDocumentProxy } from 'unpdf';
import * as XLSX from 'xlsx';

/** Cap the returned blob so a giant cover page can't blow up regex/matcher work.
 *  8 KB is far past any property-name / doc-type header that lives up top. */
const MAX_PAGE1_CHARS = 8_192;

function looksLikePdf(bytes: Buffer): boolean {
  // "%PDF" — allow a small leading BOM/whitespace offset some producers emit.
  return bytes.subarray(0, 8).toString('latin1').includes('%PDF');
}

function looksLikeZipXlsx(bytes: Buffer): boolean {
  // XLSX is a zip container: local-file-header magic "PK\x03\x04".
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** PDF → cover-page (page 1) text. */
async function pdfPage1(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return (pages[0] ?? '').slice(0, MAX_PAGE1_CHARS);
}

/** Cap the front-matter blob (a few cover pages). Larger than page-1 because the
 *  appraisal's effective/value date lives in the value-conclusion table a few
 *  pages in, not on the bare cover. */
const MAX_FRONTMATTER_CHARS = 24_576;
/** How many leading PDF pages the date scan reads (cover + letter + value table). */
const FRONTMATTER_PAGES = 6;

/** PDF → the first FRONTMATTER_PAGES pages joined (the cover + transmittal letter
 *  + value-conclusion table, where the appraisal's effective/as-of/report date
 *  lives). Real appraisal COVERS carry no date; the value date is a few pages in. */
async function pdfFrontMatter(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return pages.slice(0, FRONTMATTER_PAGES).join('\n').slice(0, MAX_FRONTMATTER_CHARS);
}

/** XLSX → first-sheet name + header/first-rows text (the cover-page analogue). */
function xlsxPage1(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (!first) return '';
  const sheet = wb.Sheets[first];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
  // Sheet name + the first several rows carry the doc/property labels.
  const head = data.slice(0, 20).map((row) => row.map(String).join('\t')).join('\n');
  return `${first}\n${head}`.slice(0, MAX_PAGE1_CHARS);
}

/**
 * Extract page-1 text from raw bytes, dispatching by magic bytes. Returns '' for
 * unrecognized formats or on any parser error (the cascade treats '' as "no
 * content signal" and the axes refuse — never throws into the routing path).
 */
export async function extractPage1Text(bytes: Buffer): Promise<string> {
  try {
    if (looksLikePdf(bytes)) return await pdfPage1(bytes);
    if (looksLikeZipXlsx(bytes)) return xlsxPage1(bytes);
    return '';
  } catch {
    // A malformed / encrypted / unsupported doc must never break routing —
    // fall through to "no content signal" (both content axes then refuse).
    return '';
  }
}

/**
 * Extract front-matter text for the CONTENT-DATE scan (SLICE 4). Same dispatch as
 * extractPage1Text, but reads the first several PDF pages (the appraisal's
 * effective/value date lives in the value-conclusion table a few pages past the
 * bare cover). XLSX reuses the page-1 header text (its dates live in the first
 * rows). Returns '' on any parser failure — the caller then persists a null
 * content date and the tiebreak falls back to uploadedAt (honest). NO-LLM.
 */
export async function extractFrontMatterText(bytes: Buffer): Promise<string> {
  try {
    if (looksLikePdf(bytes)) return await pdfFrontMatter(bytes);
    if (looksLikeZipXlsx(bytes)) return xlsxPage1(bytes);
    return '';
  } catch {
    return '';
  }
}
