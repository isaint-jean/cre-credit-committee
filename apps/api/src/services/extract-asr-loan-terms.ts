/**
 * extractAsrLoanTerms — deterministic regex parser for the ASR's "Loan Terms"
 * block.
 *
 * The ASR's loan-terms block is a stable, labeled key/value table (one
 * "Field: value" pair per visual line, two pairs per textual line after PDF
 * extraction collapses columns). The block is anchored on "Original
 * Principal Balance:" — the lender's authoritative cut-off principal — and
 * spans ~12 fields before the document transitions into the property-detail
 * tables.
 *
 * DESIGN: regex over LLM. Loan terms are the highest-stakes numbers in the
 * pipeline (loan amount, coupon, IO, maturity) — they govern every downstream
 * metric (LTV, DSCR, debt yield, debt service, refinance test). Determinism
 * matters more than tolerance:
 *
 *   - Regex is reproducible across runs; LLMs are not.
 *   - Regex output is auditable line-by-line; LLM output is a black box.
 *   - The ASR's labels are stable across issuers (the originator's
 *     standardized term-sheet template).
 *   - Cost: zero tokens per ingest vs. ~2k for an LLM call.
 *
 * INTERNAL CROSS-CHECKS (the brief's "★ flag contradictions, don't trust
 * blind" clause):
 *
 *   - Balloon Amount should equal Original Principal Balance for
 *     interest-only loans (no amortization). Mismatch ⇒ warning, don't
 *     reject — could be a hybrid amort/IO that's currently unmodeled.
 *   - Note Date + Original Term (mos) should equal Maturity Date within
 *     ±31 days (tolerates day-of-month conventions). Mismatch ⇒ warning.
 *
 * The data-integrity gate's `debtService ≈ loan × rate` plausibility check
 * fires downstream and provides an orthogonal backstop against a bad parse.
 * This extractor's job is to flag what it CAN check; the gate handles what
 * crosses to other records.
 *
 * SOURCE TAG: the produced `LoanTermsExtraction` is stamped with
 * `source: 'ASR'`. The data-integrity gate's STUB_SUSPECT_SOURCES does not
 * include 'ASR', so loan-block fields populated from this path clear the
 * provenance gate. Caller-supplied loan terms (via the build-and-ingest
 * route's `loanTerms` form field) flow through with no source field and
 * default to 'BANK' downstream — those continue to surface a provenance
 * WARN. PRECEDENCE: when both are present (caller body field AND ASR
 * block), the caller's value wins as an explicit override.
 */

import type { LoanTermsExtraction, ISODateTime } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';

export interface ExtractAsrLoanTermsResult {
  /** The parsed loan-terms record, or null if the block was not found OR
   *  every field came back null (no anchor + no fields). Stamped with
   *  source='ASR' when non-null. */
  readonly loanTerms: LoanTermsExtraction | null;
  /** Internal-consistency contradictions surfaced during parsing. Empty
   *  when no checks fired. These do NOT suppress the loanTerms — downstream
   *  consumers may surface them in the memo's Data Quality section. */
  readonly warnings: readonly string[];
}

const EMPTY_RESULT: ExtractAsrLoanTermsResult = { loanTerms: null, warnings: [] };

/* ------------------------------- normalizers ------------------------------- */

/** Parse a dollar string ("$85,000,000" / "85000000" / "85,000,000.00") to
 *  a number. Returns null on placeholders (NAP / N/A / etc.) or non-numeric. */
function parseDollar(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^(n\/?a|nap|none|null|undefined|tbd|not\s*provided)$/i.test(s)) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a percent string ("7.16%" / "7.16" / "0.0716") into a 0..1
 *  fraction. >1 treated as percent; ≤1 as already-decimal. */
function parsePctToFraction(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^(n\/?a|nap|none|null|undefined|tbd)$/i.test(s)) return null;
  const cleaned = s.replace(/[%\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

/** Parse a month count ("60" / "60 mos") to an integer. */
function parseMonths(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^(n\/?a|nap|none|null|undefined|tbd)$/i.test(s)) return null;
  const cleaned = s.replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Parse a US-style MM/DD/YYYY date to an ISO datetime at midnight UTC.
 *  Returns null on placeholders or malformed input. */
function parseDateToIso(raw: string | undefined): ISODateTime | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^(n\/?a|nap|none|null|undefined|tbd)$/i.test(s)) return null;
  // MM/DD/YYYY or M/D/YYYY
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m === null) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = month.toString().padStart(2, '0');
  const dd = day.toString().padStart(2, '0');
  return `${year}-${mm}-${dd}T00:00:00.000Z` as ISODateTime;
}

/** Difference between two ISO dates in days. */
function daysBetween(iso1: string, iso2: string): number {
  const d1 = new Date(iso1).getTime();
  const d2 = new Date(iso2).getTime();
  return Math.abs(d2 - d1) / (1000 * 60 * 60 * 24);
}

/* --------------------------------- parser --------------------------------- */

/** Extract a labeled value from the loan-terms text block.
 *
 *  Strategy: match `<label>:` followed by a value that ends at either
 *  the next labeled field (the next `<Word> ... :` pattern) or two-or-more
 *  whitespace characters (heuristic for column boundary in flattened PDF
 *  extraction). The ASR's standard layout puts two key:value pairs per
 *  textual line, so we MUST stop at the next-label boundary.
 *
 *  Returns the captured value (trimmed) or undefined when the label is
 *  not present in the block.
 */
function extractField(block: string, label: string): string | undefined {
  // Escape regex specials in the label (parens, etc.).
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture group: lazy match up to the next " <Capitalized Word ...>: "
  // pattern OR end of block. Allowing 2+ spaces also terminates the value
  // (defensive for layouts where a column wraps).
  const re = new RegExp(
    `${esc}:\\s*([^\\n]*?)(?=\\s+[A-Z][A-Za-z0-9 /\\-()?]{0,40}:|\\s{2,}|$|\\n)`,
    'i',
  );
  const m = re.exec(block);
  if (m === null) return undefined;
  const v = m[1]?.trim();
  return v === undefined || v.length === 0 ? undefined : v;
}

/* ----------------------------- pure parser API ----------------------------- */

/**
 * Pure parser: takes raw text (the full ASR rawText), finds the loan-terms
 * block, parses + normalizes each field, and runs internal-consistency
 * cross-checks.
 *
 * Returns `{loanTerms: null, warnings: []}` when the anchor "Original
 * Principal Balance:" is not found in the text. Otherwise returns the
 * parsed record (which may have null fields where labels were absent /
 * malformed) and any contradiction warnings.
 */
export function parseAsrLoanTermsFromText(text: string): ExtractAsrLoanTermsResult {
  // Anchor: find the "Original Principal Balance:" line. From there, take
  // the next ~2500 chars — the loan-terms block is ~12 fields and never
  // exceeds ~1500 chars in practice (Sunroad's is ~900 chars).
  const anchorIdx = text.indexOf('Original Principal Balance:');
  if (anchorIdx === -1) return EMPTY_RESULT;
  const block = text.slice(anchorIdx, anchorIdx + 2500);

  // Pull each labeled field. extractField returns undefined when the label
  // is absent; the normalizer then returns null.
  const loanAmount = parseDollar(extractField(block, 'Original Principal Balance'));
  const coupon = parsePctToFraction(extractField(block, 'Coupon'));
  const amortMonths = parseMonths(extractField(block, 'Original Amort Term (mos)'));
  const ioMonths = parseMonths(extractField(block, 'Interest Only Term (mos)'));
  const maturityIso = parseDateToIso(extractField(block, 'Maturity Date'));

  // Sibling fields for internal-consistency cross-checks (not surfaced
  // on the output record, just used to flag contradictions).
  const balloon = parseDollar(extractField(block, 'Balloon Amount'));
  const noteDateIso = parseDateToIso(extractField(block, 'Note Date'));
  const originalTermMonths = parseMonths(extractField(block, 'Original Term (mos)'));

  // If every field came back null AND there was no anchor match, treat
  // as empty. (We already verified anchor presence, so this is a defensive
  // belt against a malformed block that anchored but yielded nothing.)
  const allNull = loanAmount === null && coupon === null && amortMonths === null
    && ioMonths === null && maturityIso === null;
  if (allNull) return EMPTY_RESULT;

  // Internal cross-checks (★ brief: flag contradictions, don't trust blind).
  const warnings: string[] = [];

  // Balloon = original principal for interest-only loans (no amortization).
  // Skip when amort > 0 (the loan amortizes; balloon ≠ principal by design)
  // or when balloon/loanAmount missing.
  if (
    loanAmount !== null && balloon !== null
    && amortMonths !== null && amortMonths === 0
    && Math.abs(balloon - loanAmount) > 1
  ) {
    warnings.push(
      `Internal contradiction: Balloon Amount $${balloon.toLocaleString()} does not equal `
      + `Original Principal Balance $${loanAmount.toLocaleString()} on an interest-only loan `
      + `(Amort Term = 0). Verify the ASR's loan-terms block — one of these figures is wrong.`,
    );
  }

  // Note Date + Original Term (mos) ≈ Maturity Date (within 31 days).
  if (noteDateIso !== null && maturityIso !== null && originalTermMonths !== null) {
    const noteDate = new Date(noteDateIso);
    const computed = new Date(noteDate);
    computed.setUTCMonth(computed.getUTCMonth() + originalTermMonths);
    const drift = daysBetween(computed.toISOString(), maturityIso);
    if (drift > 31) {
      warnings.push(
        `Internal contradiction: Note Date (${noteDateIso.slice(0, 10)}) + Original Term `
        + `(${originalTermMonths} mos) does not equal Maturity Date `
        + `(${maturityIso.slice(0, 10)}); drift = ${Math.round(drift)} days. `
        + `Verify the ASR's loan-terms block.`,
      );
    }
  }

  return {
    loanTerms: {
      loanAmount,
      interestRate: coupon,
      amortization: amortMonths,
      interestOnlyPeriod: ioMonths,
      maturityDate: maturityIso,
      source: 'ASR',
    },
    warnings,
  };
}

/* ----------------------- ParsedDocument-substrate API ---------------------- */

/**
 * Pull loan terms from an already-parsed ASR document. Wraps the pure
 * parser; the ASR adapter calls this in its sub-extractor fan-out.
 *
 * Returns `EMPTY_RESULT` on empty rawText (defensive — a malformed
 * ParsedDocument with no sections still returns cleanly rather than
 * throwing).
 */
export function extractAsrLoanTerms(doc: ParsedDocument): ExtractAsrLoanTermsResult {
  const text = doc.rawText ?? doc.sections
    .map((s) => (s.title ? '## ' + s.title + '\n' : '') + (s.content ?? ''))
    .join('\n\n');
  if (text.length === 0) return EMPTY_RESULT;
  return parseAsrLoanTermsFromText(text);
}
