/**
 * extractCbreAppraisalLlm — LLM-primary FALLBACK for a commercial appraisal's
 * SCORE-RELEVANT core, mirroring `extract-asr-loan-terms-llm.ts` exactly.
 *
 * WHY THIS EXISTS. The deterministic regex extractor (`extract-cbre-appraisal.ts`)
 * is tuned to ONE report — CBRE's Sunroad Centrum office template — anchoring on
 * specific pages (3/12/88) and exact row labels. On a different appraisal (a
 * different appraiser, property type, state, or even a different CBRE template —
 * proven on the Lexington Grand multifamily LIHTC report, which the regex read
 * 0/66 on) every anchor misses and the score-relevant fields return null → the
 * deal loses its value basis / cap rate / stabilized NOI. This module de-anchors
 * that failure: when the regex can't find the core, it reads the WHOLE appraisal
 * text with the LLM and extracts the SUBJECT property's headline conclusions.
 *
 * SCOPE (Tier 1). The SCORE-RELEVANT SCALARS the doctrine + memo read first:
 *   asIsValue, asStabilizedValue, overallCapRate, terminalCapRate, stabilizedNoi,
 *   currentOccupancyPhysical, yearBuilt — plus the identity Tier 1b deferred here
 *   (city, state, interestAppraised, methodology). The deep pro-forma ladder and
 *   leasing tables are OUT of scope (lower-criticality, table-shaped — a later tier).
 *
 * ★ SUBJECT-not-COMP. An appraisal is dense with comparables — other properties'
 * values, cap rates, and locations. The prompt is emphatic: extract ONLY the
 * SUBJECT property's concluded figures, never a comparable's.
 *
 * ★ DETERMINISM SAFEGUARDS (mirrors loan-terms):
 *   (a) temperature 0 + STRICT JSON schema + "null when unsure".
 *   (b) CITE-OR-DISCARD — every value carries a `sourceQuote` we verify LITERALLY
 *       appears in the doc text (whitespace-normalized). Un-citeable → null.
 *   (c) null-not-fabricate — a genuinely-absent field is null (honest blank).
 *   (d) CACHING keyed by (docHash + extractorVersion) — extract once per doc-
 *       version, $0 on re-underwrite, byte-stable. Injectable seam.
 *
 * FAIL-SAFE. No credits / LLM error / malformed output ⇒ every field null ⇒ the
 * regex extractor's honest floor stands. NEVER crashes, NEVER fabricates.
 */

import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';

/** Bump when the prompt / schema / normalization changes — participates in the
 *  cache key so a version bump cleanly re-extracts (no stale reads). */
export const APPRAISAL_LLM_VERSION = '1.0.0';

/** Cap the LLM's view. Appraisal PDFs are large (200+ pages); the SUBJECT's
 *  headline conclusions live in the executive summary / letter of transmittal /
 *  income-capitalization sections near the front. 120K chars comfortably covers
 *  them while staying inside the model's context. */
const MAX_LLM_TEXT_CHARS = 120_000;

/** Model — Sonnet for the highest-stakes numbers (accuracy > pennies). */
export const APPRAISAL_LLM_MODEL: string =
  process.env['APPRAISAL_LLM_MODEL'] ?? CLAUDE_MODEL;

/* --------------------------- injectable LLM seam --------------------------- */

/** Mirrors `callAIWithContinuation`'s option shape; a proof passes a stub. */
export type AppraisalLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/* ----------------------------- injectable cache ---------------------------- */

export interface AppraisalLlmCache {
  get(docHash: string, extractorVersion: string): AppraisalLlmResult | null;
  put(docHash: string, extractorVersion: string, result: AppraisalLlmResult): void;
}

/** A trivial in-memory cache for proofs / single-process use. */
export class InMemoryAppraisalLlmCache implements AppraisalLlmCache {
  private readonly store = new Map<string, AppraisalLlmResult>();
  get(docHash: string, v: string): AppraisalLlmResult | null {
    return this.store.get(`${docHash}::${v}`) ?? null;
  }
  put(docHash: string, v: string, result: AppraisalLlmResult): void {
    this.store.set(`${docHash}::${v}`, result);
  }
}

/* -------------------------------- result shape ----------------------------- */

export interface AppraisalFieldTrace {
  readonly field: string;
  readonly sourceQuote: string | null;
  readonly cited: boolean;
}

/** The SUBJECT property's score-relevant core + deferred identity, each cited or
 *  null. Merged into the regex `AppraisalExtraction` by the adapter (regex wins
 *  where present; the LLM only fills nulls). */
export interface AppraisalLlmResult {
  readonly asIsValue: number | null;
  readonly asStabilizedValue: number | null;
  readonly overallCapRate: number | null;        // 0..1 fraction
  readonly terminalCapRate: number | null;        // 0..1 fraction
  readonly stabilizedNoi: number | null;
  readonly currentOccupancyPhysical: number | null; // 0..1 fraction
  readonly yearBuilt: number | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly interestAppraised: string | null;
  readonly methodology: string | null;
  readonly traces: readonly AppraisalFieldTrace[];
  readonly warnings: readonly string[];
  readonly fromCache: boolean;
  readonly llmCalled: boolean;
}

const EMPTY_FIELDS: Omit<AppraisalLlmResult, 'fromCache' | 'llmCalled' | 'traces' | 'warnings'> = {
  asIsValue: null, asStabilizedValue: null, overallCapRate: null, terminalCapRate: null,
  stabilizedNoi: null, currentOccupancyPhysical: null, yearBuilt: null,
  city: null, state: null, interestAppraised: null, methodology: null,
};

/* -------------------------------- credit gate ------------------------------ */

export function appraisalCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* --------------------------------- prompt ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate appraiser extracting the SUBJECT property\'s',
  'concluded figures from a commercial appraisal report. You read the WHOLE',
  'document and understand it — you are robust to any appraiser (CBRE, JLL,',
  'Cushman, Newmark, …) and any property type.',
  '',
  'Return ONLY a single JSON object of the exact shape below. No prose, no',
  'markdown, no code fences.',
  '',
  'CRITICAL RULES:',
  '- ★ SUBJECT ONLY. An appraisal contains many COMPARABLE properties (other',
  '  buildings\' sale prices, cap rates, cities). Extract ONLY the SUBJECT',
  '  property\'s CONCLUDED values — NEVER a comparable\'s figure or location.',
  '- Every value MUST be accompanied by a "sourceQuote": a SHORT verbatim string',
  '  copied EXACTLY from the document that states that value for the SUBJECT. If',
  '  you cannot find a verbatim quote, set BOTH the value AND its sourceQuote to',
  '  null. NEVER invent, infer, or compute a value not literally stated.',
  '- Missing / uncertain field -> null (never 0, "", "N/A", "TBD").',
  '',
  'FIELDS:',
  '- asIsValue: the SUBJECT\'s concluded "As Is" market value, whole dollars.',
  '- asStabilizedValue: the SUBJECT\'s "As Stabilized" / "As Complete" /',
  '  prospective market value, whole dollars. Null if the appraisal concludes only',
  '  an as-is value.',
  '- overallCapRate: the SUBJECT\'s concluded overall / going-in capitalization',
  '  rate. Return as a percent number (6.00) OR decimal (0.06) — caller normalizes.',
  '- terminalCapRate: the SUBJECT\'s terminal / reversion / exit cap rate. Null if',
  '  not stated.',
  '- stabilizedNoi: the SUBJECT\'s concluded stabilized net operating income',
  '  (the appraiser\'s pro-forma NOI), whole dollars. Null if not stated.',
  '- currentOccupancyPhysical: the SUBJECT\'s current physical occupancy. Percent',
  '  (90.63) or decimal (0.9063). Use OCCUPANCY, not "leased/pre-leased" if both',
  '  are given and they differ. Null if not stated.',
  '- yearBuilt: the SUBJECT\'s year of construction (4-digit year). Null if absent.',
  '- city: the SUBJECT property\'s city. Null if not clearly the subject\'s.',
  '- state: the SUBJECT property\'s state, 2-letter abbreviation (e.g. "SC"). Null',
  '  if not clearly the subject\'s.',
  '- interestAppraised: the property rights/interest appraised for the SUBJECT',
  '  ("Fee Simple", "Leased Fee", "Leasehold"). Null if not stated.',
  '- methodology: the SUBJECT\'s primary valuation approach relied on ("Income',
  '  Capitalization Approach", "Sales Comparison Approach", "Cost Approach"). Null',
  '  if not stated.',
].join('\n');

function buildUserPrompt(text: string): string {
  return [
    'Extract the SUBJECT property\'s concluded figures from this appraisal. Return',
    'STRICT JSON of EXACTLY this shape (every field an object with value + sourceQuote):',
    '{',
    '  "asIsValue":                { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "asStabilizedValue":        { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "overallCapRate":           { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "terminalCapRate":          { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "stabilizedNoi":            { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "currentOccupancyPhysical": { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "yearBuilt":                { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "city":                     { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "state":                    { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "interestAppraised":        { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "methodology":              { "value": <string|null>, "sourceQuote": <string|null> }',
    '}',
    '',
    '--- APPRAISAL DOCUMENT TEXT ---',
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

/** Percent-or-fraction → 0..1 fraction. "6.00" → 0.06; "0.06" → 0.06. */
function toFraction(v: unknown): number | null {
  const n = toNumber(typeof v === 'string' ? v.replace(/%/g, '') : v);
  if (n === null || n < 0) return null;
  return n > 1 ? n / 100 : n;
}

/** 4-digit construction year, validated to a plausible range. */
function toYear(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  const y = Math.round(n);
  return y >= 1800 && y <= 2100 ? y : null;
}

function toStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length === 0 ? null : s;
}

/** 2-letter state abbreviation (or a spelled-out state left as-is if not 2-char). */
function toStateAbbr(v: unknown): string | null {
  const s = toStr(v);
  if (s === null) return null;
  return s.length === 2 ? s.toUpperCase() : s;
}

/* ----------------------------- cite-or-discard ----------------------------- */

/**
 * Normalize for the cite-or-discard presence check. Appraisal PDFs (unpdf/pdfjs
 * text) carry artifacts a verbatim quote won't reproduce: SOFT HYPHENATION across
 * line breaks ("pre-\nleased"), stray colons/commas, and reflowed whitespace.
 * Anti-fabrication still holds — a quote's alphanumeric content must appear
 * CONTIGUOUSLY in the doc — but a real value is no longer discarded over a
 * hyphen. We: lowercase → join hyphenations (hyphen + optional spaces removed) →
 * punctuation → space → collapse whitespace.
 */
function normalizeWs(s: string): string {
  return s
    .toLowerCase()
    .replace(/-\s*/g, '')                       // join "pre-\nleased" → "preleased"
    .replace(/[:,.$%()–—"'`]/g, ' ')  // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

function citeOrDiscard<T>(
  field: string,
  rawValue: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
  normalize: (v: unknown) => T | null,
  traces: AppraisalFieldTrace[],
): T | null {
  const value = normalize(rawValue);
  if (value === null) {
    traces.push({ field, sourceQuote: typeof rawQuote === 'string' ? rawQuote : null, cited: false });
    return null;
  }
  const quote = typeof rawQuote === 'string' ? rawQuote.trim() : '';
  if (quote.length === 0) {
    traces.push({ field, sourceQuote: null, cited: false });
    return null;
  }
  const cited = normalizedDoc.includes(normalizeWs(quote));
  traces.push({ field, sourceQuote: quote, cited });
  if (!cited) return null; // fabricated / mis-cited → discard.
  return value;
}

/* --------------------------------- parser ---------------------------------- */

function fieldOf(o: Record<string, unknown>, key: string): { value: unknown; sourceQuote: unknown } {
  const f = o[key];
  if (f !== null && typeof f === 'object') {
    const r = f as Record<string, unknown>;
    return { value: r['value'], sourceQuote: r['sourceQuote'] };
  }
  return { value: f, sourceQuote: null };
}

/**
 * Pure parser over the raw LLM text. Exported so proofs exercise the full
 * safeguard chain (parse + cite-or-discard + normalization) deterministically
 * off a fixture string with no live call.
 */
export function parseAppraisalLlmResponse(
  responseText: string,
  docText: string,
): Omit<AppraisalLlmResult, 'fromCache' | 'llmCalled'> {
  let parsed: unknown;
  try {
    parsed = extractJSON(responseText);
  } catch {
    return { ...EMPTY_FIELDS, traces: [], warnings: [] };
  }
  if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_FIELDS, traces: [], warnings: [] };
  const o = parsed as Record<string, unknown>;

  const normalizedDoc = normalizeWs(docText);
  const traces: AppraisalFieldTrace[] = [];
  const warnings: string[] = [];

  const g = (k: string) => fieldOf(o, k);
  const asIsValue = citeOrDiscard('asIsValue', g('asIsValue').value, g('asIsValue').sourceQuote, normalizedDoc, toNumber, traces);
  const asStabilizedValue = citeOrDiscard('asStabilizedValue', g('asStabilizedValue').value, g('asStabilizedValue').sourceQuote, normalizedDoc, toNumber, traces);
  const overallCapRate = citeOrDiscard('overallCapRate', g('overallCapRate').value, g('overallCapRate').sourceQuote, normalizedDoc, toFraction, traces);
  const terminalCapRate = citeOrDiscard('terminalCapRate', g('terminalCapRate').value, g('terminalCapRate').sourceQuote, normalizedDoc, toFraction, traces);
  const stabilizedNoi = citeOrDiscard('stabilizedNoi', g('stabilizedNoi').value, g('stabilizedNoi').sourceQuote, normalizedDoc, toNumber, traces);
  const currentOccupancyPhysical = citeOrDiscard('currentOccupancyPhysical', g('currentOccupancyPhysical').value, g('currentOccupancyPhysical').sourceQuote, normalizedDoc, toFraction, traces);
  const yearBuilt = citeOrDiscard('yearBuilt', g('yearBuilt').value, g('yearBuilt').sourceQuote, normalizedDoc, toYear, traces);
  const city = citeOrDiscard('city', g('city').value, g('city').sourceQuote, normalizedDoc, toStr, traces);
  const state = citeOrDiscard('state', g('state').value, g('state').sourceQuote, normalizedDoc, toStateAbbr, traces);
  const interestAppraised = citeOrDiscard('interestAppraised', g('interestAppraised').value, g('interestAppraised').sourceQuote, normalizedDoc, toStr, traces);
  const methodology = citeOrDiscard('methodology', g('methodology').value, g('methodology').sourceQuote, normalizedDoc, toStr, traces);

  // Consistency note: occupancy must be a fraction ≤ 1 (toFraction guarantees it);
  // flag an implausible cap rate (>25%) as a data-quality warning (still returned).
  if (overallCapRate !== null && overallCapRate > 0.25) {
    warnings.push(`Appraisal LLM: overall cap rate ${(overallCapRate * 100).toFixed(2)}% is implausibly high — verify.`);
  }

  return {
    asIsValue, asStabilizedValue, overallCapRate, terminalCapRate, stabilizedNoi,
    currentOccupancyPhysical, yearBuilt, city, state, interestAppraised, methodology,
    traces, warnings,
  };
}

/* --------------------------------- runner ---------------------------------- */

export interface ExtractCbreAppraisalLlmDeps {
  readonly llmCall?: AppraisalLlmCall;
  readonly creditsAvailable?: () => boolean;
  readonly cache?: AppraisalLlmCache;
  readonly extractorVersion?: string;
}

/**
 * LLM-primary appraisal-core extraction over the FULL appraisal text.
 *
 * Order of operations (mirrors extract-asr-loan-terms-llm):
 *   1. CACHE — stored result for (docHash, version) → return it ($0).
 *   2. CREDIT GATE — no credits → all-null WITHOUT calling ($0).
 *   3. LLM CALL (temp 0) → parse → cite-or-discard.
 *   4. FAIL-SAFE — any throw ⇒ all-null. Never crashes, never fabricates.
 *   5. STORE — cache the fresh result so the next call is $0.
 */
export async function extractCbreAppraisalLlm(
  docText: string,
  docHash: string,
  deps: ExtractCbreAppraisalLlmDeps = {},
): Promise<AppraisalLlmResult> {
  const version = deps.extractorVersion ?? APPRAISAL_LLM_VERSION;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? appraisalCreditsAvailable;
  const cache = deps.cache;

  const empty = (): AppraisalLlmResult => ({ ...EMPTY_FIELDS, traces: [], warnings: [], fromCache: false, llmCalled: false });

  if (typeof docText !== 'string' || docText.trim().length === 0) return empty();

  if (cache) {
    const hit = cache.get(docHash, version);
    if (hit) return { ...hit, fromCache: true, llmCalled: false };
  }

  if (!hasCredits()) return empty();

  let raw: string;
  try {
    raw = await llmCall({
      model: APPRAISAL_LLM_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(docText.slice(0, MAX_LLM_TEXT_CHARS)) }],
      temperature: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AI:Appraisal] extraction call failed:', err);
    return empty();
  }

  const parsed = parseAppraisalLlmResponse(raw, docText);
  const result: AppraisalLlmResult = { ...parsed, fromCache: false, llmCalled: true };

  if (cache) cache.put(docHash, version, result);
  return result;
}
