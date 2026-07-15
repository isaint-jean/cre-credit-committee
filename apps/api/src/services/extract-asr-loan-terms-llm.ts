/**
 * extractAsrLoanTermsLlm — LLM-primary FALLBACK for the ASR "Loan Terms" block.
 *
 * WHY THIS EXISTS. The deterministic regex extractor
 * (`extract-asr-loan-terms.ts`) anchors on the single Morgan-Stanley phrase
 * `Original Principal Balance:`. When an ASR does not carry that phrase (e.g.
 * 640 Fifth Ave's Bank-of-Montreal-style / Summary-of-Terms layout), the regex
 * returns EMPTY_RESULT → `loanTerms: null` → the engine fails closed
 * (`JE_LOAN_AMOUNT_MISSING`). This module de-anchors that failure: when the
 * deterministic path can't find the block (or can't find `loanAmount`), it reads
 * the WHOLE ASR text with the LLM and extracts structured loan terms.
 *
 * ★ FULL LOAN-TERMS SET (P1 → this extension). P1 filled only the gating
 * `loanAmount`. But clearing `JE_LOAN_AMOUNT_MISSING` only surfaced the NEXT
 * fail-closed gate, `JE_TERM_MONTHS_MISSING` (`buildTermMonths` needs a term /
 * maturity). This module now extracts ALL FIVE loan terms the engine reads:
 * loanAmount (WHOLE), termMonths, maturityDate, coupon (interest rate), and
 * amortization (+ interest-only). Each carries its own cite-or-discard quote and
 * independently returns null when genuinely absent (null-not-fabricate).
 *
 * ★ TERM-vs-MATURITY (why termMonths exists). The 640 ASR states the loan TERM
 * in prose ("a $400,000,000, 5-year, fixed rate, interest-only loan") but no
 * maturity date and no origination/note date to derive one. So:
 *   - We have the LLM cite the verbatim TERM PHRASE ("5-year"); WE normalize it
 *     to months deterministically (the LLM never does the arithmetic silently —
 *     it returns the phrase, we convert + verify the phrase is in the quote).
 *   - If the ASR states an origination/note date AND a term, we derive
 *     maturityDate = originationDate + termMonths.
 *   - If neither a maturity date nor an origination anchor is present (640),
 *     maturityDate stays null and `termMonths` flows through as the explicit
 *     fallback `buildTermMonths` reads → `JE_TERM_MONTHS_MISSING` cleared on the
 *     honest fact the ASR actually states.
 *
 * COMPOSITION, not greenfield. This is the union of two already-proven patterns:
 *   - `extract-asr.ts` — full-doc read, `callAIWithContinuation` on CLAUDE_MODEL,
 *     STRICT-JSON-nulls discipline ("Missing fields must be null"), tolerant
 *     `extractJSON` parse, all-null → null.
 *   - `data-room/llm-smart-route.service.ts` (a9a22cc) — the GOVERNANCE armor:
 *     `creditsAvailable()` credit-gate (no key ⇒ skip the call, $0), temperature
 *     0 (greedy / replay-stable), an INJECTABLE LLM seam so proofs pass a
 *     deterministic stub, and a discard-what-you-can't-verify guard (there:
 *     MATCH-REAL-TARGETS; here: CITE-OR-DISCARD against the doc text).
 *
 * ★ WHOLE-vs-PIECE (DECISION LOCKED). The gating `loanAmount` is the WHOLE loan
 * — the asset services the whole debt (the pari-passu lesson d9019e7:
 * piece-based coverage is false-optimistic). A trust / senior / mezz PIECE, when
 * present, is captured on a SEPARATE labeled field `loanAmountTrustPiece` for
 * exposure disclosure ONLY; it is NEVER a credit metric and never feeds the
 * engine's gating loanAmount. For 640: whole = $400,000,000; the "$57,000,000"
 * in that ASR is `Minimum UNOI` (an NOI covenant, NOT a loan slice) — exactly
 * the trap the whole-vs-piece discipline defeats.
 *
 * ★ DETERMINISM SAFEGUARDS (this feeds the ENGINE; an LLM can be confidently
 * wrong):
 *   (a) temperature 0 + STRICT JSON schema + "null when unsure".
 *   (b) CITE-OR-DISCARD — every extracted value carries a `sourceQuote`. We
 *       verify the quote LITERALLY appears in the doc's rawText (whitespace
 *       normalized). An un-citeable value is DISCARDED → null. No fabrication
 *       reaches the engine.
 *   (c) null-not-fabricate — every field independently returns null when absent;
 *       a null loanAmount trips the same fail-closed engine refusal.
 *   (d) CACHING — keyed by (docHash + extractorVersion). Extract ONCE per
 *       doc-version, store the structured result; a re-underwrite reads the
 *       STORED result (no second LLM call → $0, and the persisted output is
 *       byte-stable so no per-run drift reaches the engine). The cache is an
 *       injectable seam (`LoanTermsLlmCache`) so it can be backed by SQLite in
 *       production and by an in-memory map in proofs.
 *
 * FAIL-SAFE. No credits / LLM error / malformed output ⇒ every field null ⇒ the
 * engine refuses (today's honest floor). NEVER crashes, NEVER fabricates.
 */

import type { LoanTermsExtraction, ISODateTime } from '@cre/contracts';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';

/** Bump when the prompt / schema / normalization changes — participates in the
 *  cache key so a version bump cleanly re-extracts (no stale reads). */
export const ASR_LOAN_TERMS_LLM_VERSION = '2.2.0';

/** Cap the LLM's view of the doc (matches extract-asr.ts's 80K slice — a safe
 *  ceiling; loan terms live in the first pages but we pass the whole doc so a
 *  non-MS layout that buries them anywhere is still covered). */
const MAX_LLM_TEXT_CHARS = 80_000;

/** Model — Sonnet for the highest-stakes numbers (accuracy > pennies). Defaults
 *  to CLAUDE_MODEL (Sonnet 4.6); overridable for tests / future bumps. */
export const ASR_LOAN_TERMS_LLM_MODEL: string =
  process.env['ASR_LOAN_TERMS_LLM_MODEL'] ?? CLAUDE_MODEL;

/* --------------------------- injectable LLM seam --------------------------- */

/** Mirrors `callAIWithContinuation`'s option shape; a proof passes a stub. */
export type LoanTermsLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/* ----------------------------- injectable cache ---------------------------- */

/**
 * The extract-once-per-doc-version cache. Keyed by (docHash + extractorVersion);
 * the value is the already-normalized result. `get` returns the stored result
 * (cache HIT → no LLM call) or null (MISS). `put` stores after a fresh extract.
 * Injectable so production backs it with SQLite and proofs use an in-memory map.
 */
export interface LoanTermsLlmCache {
  get(docHash: string, extractorVersion: string): LoanTermsLlmResult | null;
  put(docHash: string, extractorVersion: string, result: LoanTermsLlmResult): void;
}

/** A trivial in-memory cache for proofs / single-process use. */
export class InMemoryLoanTermsLlmCache implements LoanTermsLlmCache {
  private readonly store = new Map<string, LoanTermsLlmResult>();
  get(docHash: string, v: string): LoanTermsLlmResult | null {
    return this.store.get(`${docHash}::${v}`) ?? null;
  }
  put(docHash: string, v: string, result: LoanTermsLlmResult): void {
    this.store.set(`${docHash}::${v}`, result);
  }
}

/* -------------------------------- result shape ----------------------------- */

/** Per-field provenance: the raw value the LLM returned and the verbatim quote
 *  it cited. `cited` records whether the quote was verified present in the doc
 *  (the cite-or-discard outcome). Observability only. */
export interface LoanTermsFieldTrace {
  readonly field: string;
  readonly sourceQuote: string | null;
  readonly cited: boolean;
}

export interface LoanTermsLlmResult {
  /** The gating loan-terms record (WHOLE-loan `loanAmount`), or null when the
   *  LLM produced nothing citeable / credits were out / the call failed.
   *  Stamped source='ASR'. */
  readonly loanTerms: LoanTermsExtraction | null;
  /** ★ The trust / senior / mezz PIECE, when the ASR discloses one. EXPOSURE
   *  DISCLOSURE ONLY — never a credit metric, never gates. Null when the loan
   *  is whole (no pari-passu / senior-mezz split) or un-citeable. */
  readonly loanAmountTrustPiece: number | null;
  /** Per-field citation traces (observability / audit). */
  readonly traces: readonly LoanTermsFieldTrace[];
  /** Warnings surfaced into the memo's Data Quality channel (same channel the
   *  regex extractor uses). */
  readonly warnings: readonly string[];
  /** True when this result came from the cache (no LLM call this invocation). */
  readonly fromCache: boolean;
  /** True when a live LLM call was made this invocation (false on cache hit,
   *  no-credits skip, or fail-safe). Lets the harness assert $0 on cache hit. */
  readonly llmCalled: boolean;
}

const EMPTY: Omit<LoanTermsLlmResult, 'fromCache' | 'llmCalled'> = {
  loanTerms: null,
  loanAmountTrustPiece: null,
  traces: [],
  warnings: [],
};

/* -------------------------------- credit gate ------------------------------ */

/** True only when an API key is present. When false the LLM call is skipped
 *  ENTIRELY (no request, no cost). Injectable-overridable via the deps for the
 *  no-credits fail-safe proof. */
export function loanTermsCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* --------------------------------- prompt ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate credit analyst extracting LOAN TERMS from an',
  'Asset Summary Report (ASR). You read the WHOLE document and understand it —',
  'you are robust to any issuer format (Morgan Stanley, Bank of Montreal, etc.).',
  '',
  'Return ONLY a single JSON object of the exact shape below. No prose, no',
  'markdown, no code fences.',
  '',
  'CRITICAL RULES:',
  '- Every value MUST be accompanied by a "sourceQuote": a SHORT verbatim string',
  '  copied EXACTLY from the document that states that value. If you cannot find a',
  '  verbatim quote in the document for a field, set BOTH the value AND its',
  '  sourceQuote to null. NEVER invent, infer, or compute a value that is not',
  '  literally stated in the document.',
  '- Missing / uncertain field -> null (never 0, "", "N/A", "TBD").',
  '',
  '★ WHOLE LOAN vs PIECE (most important):',
  '- "loanAmountWhole" = the TOTAL / WHOLE loan amount the lender is presenting',
  '  (the full facility). This is the gating number. E.g. a "$400,000,000 loan"',
  '  fully comprised of a $300MM senior note and a $100MM mezzanine note has',
  '  loanAmountWhole = 400000000.',
  '- "loanAmountTrustPiece" = a SINGLE trust note / pari-passu slice / senior or',
  '  mezzanine PIECE of the whole loan, IF the document splits the loan into',
  '  pieces. This is exposure disclosure only. Null when the loan is not split.',
  '- Do NOT confuse a covenant floor (e.g. "Minimum UNOI", "Minimum Underwritten',
  '  NOI", "Minimum Debt Yield") with a loan piece. Those are NOT loan amounts.',
  '  If a dollar figure is labeled as a minimum/covenant, it is NEITHER',
  '  loanAmountWhole NOR loanAmountTrustPiece — leave both to their true values.',
  '',
  'FIELDS:',
  '- coupon: the annual interest rate. Return as a decimal fraction (7.91% ->',
  '  0.0791) OR as the percent number (7.91) — either is fine, the caller',
  '  normalizes. Null if the document does not state a numeric rate. A "fixed',
  '  rate" label with NO number is null (the label is not a rate).',
  '- amortizationMonths: original amortization term in months. 0 for full-term',
  '  interest-only. Null if not stated.',
  '- interestOnlyMonths: interest-only period in months. Null if not stated.',
  '- termPhrase: the VERBATIM loan-term phrase EXACTLY as written, e.g.',
  '  "5-year", "60-month", "ten year". This is the loan TERM / tenor (time to',
  '  maturity), NOT the amortization and NOT the interest-only period. Copy the',
  '  words as-is; do NOT convert to a number yourself. Null if no term is stated.',
  '- originationDate: the loan origination / note / closing date as MM/DD/YYYY,',
  '  ONLY if the document explicitly states the loan\'s origination/note/closing',
  '  date. Do NOT use an appraisal "effective" date, a lease date, or a report',
  '  date — those are not the loan origination date. Null if not explicitly',
  '  stated for the loan itself.',
  '- maturityDate: loan maturity as MM/DD/YYYY. Null if not stated.',
].join('\n');

function buildUserPrompt(text: string): string {
  return [
    'Extract the loan terms from this ASR. Return STRICT JSON of EXACTLY this shape:',
    '{',
    '  "loanAmountWhole":       { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "loanAmountTrustPiece":  { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "coupon":                { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "amortizationMonths":    { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "interestOnlyMonths":    { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "termPhrase":            { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "originationDate":       { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "maturityDate":          { "value": <string|null>, "sourceQuote": <string|null> }',
    '}',
    '',
    '--- ASR DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

/* ------------------------------- normalizers ------------------------------- */

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return null;
    if (/^(n\/?a|nap|none|null|undefined|tbd|not\s*provided)$/i.test(s)) return null;
    const cleaned = s.replace(/[$,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toFraction(v: unknown): number | null {
  const n = toNumber(typeof v === 'string' ? v.replace(/%/g, '') : v);
  if (n === null) return null;
  if (n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

function toMonths(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.round(n);
}

function toIso(v: unknown): ISODateTime | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
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

/** Number words 0..20 (+ tens) for "ten year" / "twenty-year" style phrases. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40,
};

/**
 * ★ TERM-PHRASE → MONTHS (deterministic; the LLM never does the arithmetic).
 * Parses the verbatim term phrase into a month count:
 *   "5-year" / "5 year" / "5yr" / "five-year" / "ten year"  → years × 12
 *   "60-month" / "60 mo" / "60mos"                           → months as-is
 * Returns null when no year/month quantity can be read. This is the ONLY place
 * that converts a term into months — keeps the arithmetic out of the model. */
export function termPhraseToMonths(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s.length === 0) return null;

  // Quantity (numeric or number-word) immediately preceding a year/month unit,
  // tolerating parentheses / dashes / spaces between them. This handles both the
  // clean prose form ("5-year", "60-month", "ten year") AND the ASR summary-
  // table form ("Five (5) Year", "Five (5) YearTerm"). We allow up to a handful
  // of non-alphanumeric separators (spaces, dashes, parens) between the quantity
  // and the unit so "5) year" / "five (5) year" both resolve.
  // The trailing `(?:term\b|\b)` also matches the PDF-flattened "YearTerm" form
  // (where "Year Term:" collapsed to "YearTerm:") without matching "yearly".
  const unitRe = /(\d+(?:\.\d+)?|[a-z]+)[\s)\-(.]{0,4}(years?|yrs?|yr|months?|mos?|mo)(?:term\b|\b)/g;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(s)) !== null) {
    const qtyRaw = m[1] ?? '';
    const unit = m[2] ?? '';
    let qty: number | null = null;
    if (/^\d/.test(qtyRaw)) {
      const n = Number(qtyRaw);
      qty = Number.isFinite(n) ? n : null;
    } else {
      qty = NUMBER_WORDS[qtyRaw] ?? null;
    }
    if (qty === null || qty <= 0) continue;
    if (/^y/.test(unit)) return Math.round(qty * 12);
    return Math.round(qty); // months
  }
  return null;
}

/**
 * ★ ANCHOR #3 — DOC-GROUNDED TERM (deterministic; LLM-quote-INDEPENDENT). Scans
 * the DOCUMENT itself for the loan-term phrase stated beside the loan figure,
 * instead of trusting whichever span the LLM happened to quote. A loan-
 * presentation sentence states the amount then the term ("$400,000,000, 5-year,
 * fixed rate, interest-only loan"), so we find every occurrence of the figure
 * and read a short window AFTER it for a term phrase. Because it reads the doc —
 * not the LLM output — the term is the SAME on every run (no LLM non-determinism
 * can drop it). Returns { months, window } (window cited as the sourceQuote) or
 * null when no plausible term sits beside the figure (honest floor preserved).
 */
export function deriveTermFromDocFigure(
  loanAmount: number,
  normalizedDoc: string,
): { months: number; window: string } | null {
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) return null;
  // The figure as the ASR writes it, with thousands separators. normalizeWs only
  // lowercased + collapsed whitespace — digits and commas are untouched.
  const grouped = loanAmount.toLocaleString('en-US'); // e.g. "400,000,000"
  const WINDOW = 45; // short enough to stay inside the loan-presentation clause.
  let from = 0;
  for (;;) {
    const idx = normalizedDoc.indexOf(grouped, from);
    if (idx < 0) break;
    const start = idx + grouped.length;
    const after = normalizedDoc.slice(start, start + WINDOW);
    const months = termPhraseToMonths(after);
    // Plausible LOAN term only (1..50yr) — rejects a stray unit ("30 months"
    // capped-reserve language) that isn't a tenor.
    if (months !== null && months >= 12 && months <= 600) {
      return { months, window: `${grouped}${after}`.trim() };
    }
    from = start;
  }
  return null;
}

/** Add whole months to an ISO date, returning a new ISO datetime (UTC). Used to
 *  derive maturityDate = originationDate + termMonths when no maturity is
 *  stated. Uses calendar-month arithmetic (clamps day overflow). */
function addMonthsIso(baseIso: ISODateTime, months: number): ISODateTime | null {
  const d = new Date(baseIso);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, mo + months, 1));
  // Clamp the day to the target month's length.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString() as ISODateTime;
}

/* ----------------------------- cite-or-discard ----------------------------- */

/** Normalize whitespace for the presence check (PDF extraction collapses /
 *  re-flows whitespace; a quote should match modulo whitespace). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * ★ CITE-OR-DISCARD. Returns the value ONLY when its sourceQuote is a non-empty
 * string that literally appears (whitespace-normalized) in the doc text.
 * Otherwise returns null and records the discard in `traces`.
 */
function citeOrDiscard<T>(
  field: string,
  rawValue: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
  normalize: (v: unknown) => T | null,
  traces: LoanTermsFieldTrace[],
): T | null {
  const value = normalize(rawValue);
  if (value === null) {
    traces.push({ field, sourceQuote: typeof rawQuote === 'string' ? rawQuote : null, cited: false });
    return null;
  }
  const quote = typeof rawQuote === 'string' ? rawQuote.trim() : '';
  if (quote.length === 0) {
    // Value with no quote → un-grounded → discard.
    traces.push({ field, sourceQuote: null, cited: false });
    return null;
  }
  const cited = normalizedDoc.includes(normalizeWs(quote));
  traces.push({ field, sourceQuote: quote, cited });
  if (!cited) return null; // fabricated / mis-cited → discard.
  return value;
}

/**
 * ★ CITE-OR-DISCARD for the TERM PHRASE. Stricter than `citeOrDiscard`: the
 * quote must (a) appear in the doc AND (b) itself contain the verbatim term
 * phrase — so the term is pinned to the sentence that actually states it, not
 * merely to some present-but-unrelated quote. Returns the NORMALIZED months
 * (the arithmetic is done here, deterministically — never by the model).
 */
function citeTermPhrase(
  field: string,
  rawPhrase: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
  traces: LoanTermsFieldTrace[],
): number | null {
  const phrase = typeof rawPhrase === 'string' ? rawPhrase.trim() : '';
  const months = termPhraseToMonths(phrase);
  const quote = typeof rawQuote === 'string' ? rawQuote.trim() : '';
  if (months === null || phrase.length === 0 || quote.length === 0) {
    traces.push({ field, sourceQuote: quote.length > 0 ? quote : null, cited: false });
    return null;
  }
  const quoteInDoc = normalizedDoc.includes(normalizeWs(quote));
  const phraseInQuote = normalizeWs(quote).includes(normalizeWs(phrase));
  const cited = quoteInDoc && phraseInQuote;
  traces.push({ field, sourceQuote: quote, cited });
  if (!cited) return null; // un-grounded or quote doesn't state the term → discard.
  return months;
}

/* --------------------------------- parser ---------------------------------- */

function fieldOf(o: Record<string, unknown>, key: string): { value: unknown; sourceQuote: unknown } {
  const f = o[key];
  if (f !== null && typeof f === 'object') {
    const r = f as Record<string, unknown>;
    return { value: r['value'], sourceQuote: r['sourceQuote'] };
  }
  // Tolerate a bare scalar (model didn't wrap) — value present, no quote.
  return { value: f, sourceQuote: null };
}

/**
 * Pure parser over the raw LLM text. Exported so proofs exercise the full
 * safeguard chain (parse + cite-or-discard + whole/piece + normalization)
 * deterministically off a recorded/fixture string with no live call.
 */
export function parseLoanTermsLlmResponse(
  responseText: string,
  docText: string,
): Omit<LoanTermsLlmResult, 'fromCache' | 'llmCalled'> {
  let parsed: unknown;
  try {
    parsed = extractJSON(responseText);
  } catch {
    return EMPTY; // malformed → null → engine refuses.
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY;
  const o = parsed as Record<string, unknown>;

  const normalizedDoc = normalizeWs(docText);
  const traces: LoanTermsFieldTrace[] = [];
  const warnings: string[] = [];

  const whole = fieldOf(o, 'loanAmountWhole');
  const piece = fieldOf(o, 'loanAmountTrustPiece');
  const coup = fieldOf(o, 'coupon');
  const amort = fieldOf(o, 'amortizationMonths');
  const io = fieldOf(o, 'interestOnlyMonths');
  const term = fieldOf(o, 'termPhrase');
  const orig = fieldOf(o, 'originationDate');
  const mat = fieldOf(o, 'maturityDate');

  // ★ WHOLE is the gating loanAmount. Cite-or-discard each field.
  const loanAmount = citeOrDiscard('loanAmountWhole', whole.value, whole.sourceQuote, normalizedDoc, toNumber, traces);
  const loanAmountTrustPiece = citeOrDiscard('loanAmountTrustPiece', piece.value, piece.sourceQuote, normalizedDoc, toNumber, traces);
  const coupon = citeOrDiscard('coupon', coup.value, coup.sourceQuote, normalizedDoc, toFraction, traces);
  const amortization = citeOrDiscard('amortizationMonths', amort.value, amort.sourceQuote, normalizedDoc, toMonths, traces);
  const interestOnlyPeriod = citeOrDiscard('interestOnlyMonths', io.value, io.sourceQuote, normalizedDoc, toMonths, traces);
  const originationDate = citeOrDiscard('originationDate', orig.value, orig.sourceQuote, normalizedDoc, toIso, traces);
  const maturityDateStated = citeOrDiscard('maturityDate', mat.value, mat.sourceQuote, normalizedDoc, toIso, traces);

  // ★ termMonths — extra guard beyond cite-or-discard: the cited quote must
  //   itself CONTAIN the verbatim term phrase (not just appear in the doc). This
  //   pins the term to the actual sentence stating it and blocks a quote that is
  //   present-but-unrelated. WE normalize the phrase to months (the LLM returns
  //   the words; the arithmetic is deterministic here).
  const termFromField = citeTermPhrase('termPhrase', term.value, term.sourceQuote, normalizedDoc, traces);

  // ★ MULTI-ANCHOR TERM (robustness to re-runs — NOT a patch). The dedicated
  //   `termPhrase` field can come back uncited on a FRESH LLM re-extraction
  //   (temp-0 is greedy but not bit-identical run-to-run; the model may quote a
  //   different span, or omit the field). That single-field dependency is exactly
  //   what blocked a 640 re-score (JE_TERM_MONTHS_MISSING) after an adapter
  //   version bump busted the composer cache and forced a fresh extract.
  //   ★ THE FIX: the loan-amount quote we ALREADY cited and trust routinely
  //   states the term in the same breath — 640's is "a $400,000,000, 5-year,
  //   fixed rate, interest-only loan". So when the dedicated field yields no
  //   term, read it straight out of the loanAmountWhole sourceQuote. That quote
  //   was already verified present in the doc by loanAmount's own cite-or-discard
  //   — reusing it introduces NO new extraction and NO new LLM variance.
  //   ★ SAME HONEST FLOOR: we only derive when (a) loanAmount itself is cited and
  //   (b) that quote genuinely parses to a term; otherwise termMonths stays null
  //   and the engine refuses (JE_TERM_MONTHS_MISSING) — no fabrication.
  let termMonths = termFromField;
  if (termMonths === null && loanAmount !== null) {
    // ANCHOR #2 — the already-cited loan-amount quote, WHEN it carries the term
    // ("a $400,000,000, 5-year, ... loan"). Cheap; works when the LLM quotes the
    // full descriptive sentence. But the LLM may quote a TERSE amount ("$400,000,000")
    // on a fresh run — so this alone is not enough (it's what let 640 re-fail).
    const wholeQuote = typeof whole.sourceQuote === 'string' ? whole.sourceQuote.trim() : '';
    const wholeQuoteCited = wholeQuote.length > 0 && normalizedDoc.includes(normalizeWs(wholeQuote));
    if (wholeQuoteCited) {
      const derived = termPhraseToMonths(wholeQuote);
      if (derived !== null) {
        termMonths = derived;
        traces.push({ field: 'termPhrase', sourceQuote: wholeQuote, cited: true });
        warnings.push(
          `Loan-terms LLM: dedicated term phrase not cited on this run — DERIVED term = ${derived}mo `
          + `from the already-cited loan-amount quote ("${wholeQuote}"). Multi-anchor #2.`,
        );
      }
    }
    // ★ ANCHOR #3 — DOC-GROUNDED figure-window scan (the robust one). Reads the
    // term straight out of the DOCUMENT beside the loan figure, independent of
    // which span the LLM quoted → the term reads the SAME on every run. THIS is
    // what makes the term robust to LLM non-determinism (the 640 re-score failure).
    if (termMonths === null) {
      const win = deriveTermFromDocFigure(loanAmount, normalizedDoc);
      if (win !== null) {
        termMonths = win.months;
        traces.push({ field: 'termPhrase', sourceQuote: win.window, cited: true });
        warnings.push(
          `Loan-terms LLM: term phrase not cited by the LLM on this run — DERIVED term = ${win.months}mo `
          + `by reading the document beside the loan figure ("${win.window}"). Multi-anchor #3 `
          + `(doc-grounded, LLM-quote-independent) → deterministic across re-runs.`,
        );
      }
    }
  }

  // ★ FULL-TERM INTEREST-ONLY → amortization = 0 (deterministic, definitional —
  // NOT a fabrication, NOT LLM-coaxed). A loan whose interest-only period covers
  // the FULL term genuinely does not amortize, so 0 is the HONEST value, derived
  // from the cited "interest-only" phrase (a real equivalence, like fifth=5th).
  // ★ NARROW: fires ONLY for full-term IO — the IO period ≥ term, OR a whole-loan
  // "interest-only" statement with NO separate (partial) IO period. A partial-IO
  // or amortizing loan (IO period < term) keeps its own amortization (or honest
  // null) — we NEVER zero out a real amortization schedule.
  let amortizationResolved = amortization;
  if (amortizationResolved === null && termMonths !== null) {
    const knownPartialIo = interestOnlyPeriod !== null && interestOnlyPeriod < termMonths;
    const fullTermIoByPeriod = interestOnlyPeriod !== null && interestOnlyPeriod >= termMonths;
    const ioMatch = knownPartialIo ? null : normalizedDoc.match(/interest[-\s]?only/i);
    const ioQuote = ioMatch ? ioMatch[0] : null;
    if (fullTermIoByPeriod || (interestOnlyPeriod === null && ioQuote !== null)) {
      amortizationResolved = 0;
      const evidence = fullTermIoByPeriod
        ? `interest-only period ${interestOnlyPeriod}mo ≥ term ${termMonths}mo`
        : (ioQuote as string);
      traces.push({ field: 'amortizationMonths', sourceQuote: evidence, cited: true });
      warnings.push(
        `Loan-terms LLM: full-term interest-only → amortization = 0 (a full-term IO loan does `
        + `not amortize; derived from the cited "${evidence}", not fabricated).`,
      );
    }
  }

  // ★ Guard: never let the piece masquerade as the whole. If the whole is null
  // but a piece was cited, we do NOT promote it — the engine refuses on a null
  // whole loanAmount rather than gate on a piece (whole-not-piece discipline).
  if (loanAmount === null && loanAmountTrustPiece !== null) {
    warnings.push(
      `Loan-terms LLM: a loan PIECE ($${loanAmountTrustPiece.toLocaleString()}) was cited but the `
      + `WHOLE loan amount was not — holding loanAmount to null (whole-not-piece: the asset services `
      + `the whole debt; a piece is not a gating credit metric).`,
    );
  }
  // Consistency note: piece should be < whole if both present.
  if (loanAmount !== null && loanAmountTrustPiece !== null && loanAmountTrustPiece >= loanAmount) {
    warnings.push(
      `Loan-terms LLM: trust piece ($${loanAmountTrustPiece.toLocaleString()}) is not smaller than the `
      + `whole loan ($${loanAmount.toLocaleString()}) — verify the ASR; treating the whole as gating.`,
    );
  }

  // ★ MATURITY DATE — precedence:
  //   1. an explicitly-stated (and cited) maturity date wins.
  //   2. else, if BOTH an origination/note date AND a term were cited, DERIVE
  //      maturityDate = originationDate + termMonths (analyst-standard).
  //   3. else null — the term still reaches the engine via `termMonths`, and
  //      `buildTermMonths` reads it directly (no fabricated date).
  let maturityDate: ISODateTime | null = maturityDateStated;
  if (maturityDate === null && originationDate !== null && termMonths !== null) {
    const derived = addMonthsIso(originationDate, termMonths);
    if (derived !== null) {
      maturityDate = derived;
      warnings.push(
        `Loan-terms LLM: maturity date not stated — DERIVED as origination `
        + `(${originationDate.slice(0, 10)}) + ${termMonths}mo term = ${derived.slice(0, 10)}.`,
      );
    }
  }

  const allNull = loanAmount === null && coupon === null && amortizationResolved === null
    && interestOnlyPeriod === null && maturityDate === null && termMonths === null;
  if (allNull) {
    return { loanTerms: null, loanAmountTrustPiece, traces, warnings };
  }

  return {
    loanTerms: {
      loanAmount,
      interestRate: coupon,
      amortization: amortizationResolved,
      interestOnlyPeriod,
      termMonths,
      maturityDate,
      source: 'ASR',
    },
    loanAmountTrustPiece,
    traces,
    warnings,
  };
}

/* --------------------------------- runner ---------------------------------- */

export interface ExtractAsrLoanTermsLlmDeps {
  /** Injectable LLM seam. Defaults to the real Anthropic call. */
  readonly llmCall?: LoanTermsLlmCall;
  /** Injectable credit gate. Defaults to the env-key check. */
  readonly creditsAvailable?: () => boolean;
  /** Injectable cache. Omit to run without caching. */
  readonly cache?: LoanTermsLlmCache;
  /** Extractor version participating in the cache key. Defaults to the module
   *  version; override in tests to prove version-busting. */
  readonly extractorVersion?: string;
}

/**
 * LLM-primary loan-terms extraction over the FULL ASR text.
 *
 * @param docText   the full ASR rawText (all pages).
 * @param docHash   content hash of the ASR bytes (cache key half).
 * @param deps      injectable LLM seam / credit gate / cache / version.
 *
 * Order of operations:
 *   1. CACHE — if a stored result exists for (docHash, version), return it
 *      (fromCache=true, llmCalled=false, $0). Deterministic re-underwrite.
 *   2. CREDIT GATE — if no credits, return EMPTY (all null) WITHOUT calling
 *      (llmCalled=false, $0). Engine refuses = today's honest floor.
 *   3. LLM CALL (temp 0) → parse → cite-or-discard → whole/piece.
 *   4. FAIL-SAFE — any throw ⇒ EMPTY (all null). Never crashes, never fabricates.
 *   5. STORE — put the fresh result in the cache so the next call is $0.
 */
export async function extractAsrLoanTermsLlm(
  docText: string,
  docHash: string,
  deps: ExtractAsrLoanTermsLlmDeps = {},
): Promise<LoanTermsLlmResult> {
  const version = deps.extractorVersion ?? ASR_LOAN_TERMS_LLM_VERSION;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? loanTermsCreditsAvailable;
  const cache = deps.cache;

  const empty = (): LoanTermsLlmResult => ({ ...EMPTY, fromCache: false, llmCalled: false });

  if (typeof docText !== 'string' || docText.trim().length === 0) return empty();

  // (1) CACHE — extract-once-per-doc-version. A hit means NO LLM call ($0) and a
  //     byte-stable persisted result (no per-run drift reaches the engine).
  if (cache) {
    const hit = cache.get(docHash, version);
    if (hit) return { ...hit, fromCache: true, llmCalled: false };
  }

  // (2) CREDIT GATE — no key/credits ⇒ skip the call entirely.
  if (!hasCredits()) return empty();

  // (3) LLM CALL — temp 0, structured. Fail-safe on any throw.
  let raw: string;
  try {
    raw = await llmCall({
      model: ASR_LOAN_TERMS_LLM_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(docText.slice(0, MAX_LLM_TEXT_CHARS)) }],
      temperature: 0,
    });
  } catch (err) {
    // FAIL-SAFE — LLM error / timeout / network → EMPTY → engine refuses.
    // eslint-disable-next-line no-console
    console.warn('[AI:LoanTerms] extraction call failed:', err);
    return empty();
  }

  const parsed = parseLoanTermsLlmResponse(raw, docText);
  const result: LoanTermsLlmResult = { ...parsed, fromCache: false, llmCalled: true };

  // (5) STORE — freeze the answer so the next underwrite is $0 + deterministic.
  if (cache) cache.put(docHash, version, result);

  return result;
}
