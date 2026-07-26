/**
 * extractPartiesFromAsrLlm — LLM-primary FALLBACK for borrower/sponsor identity.
 *
 * WHY THIS EXISTS. The deterministic regex extractor
 * (`extract-parties-from-asr.ts`) anchors on the Goldman-format labels
 * "Borrower Entity Name:" / "Sponsor / Guarantor:". When an ASR does not carry
 * those labels (e.g. 640 Fifth Ave's Bank-of-Montreal ASR, which names the
 * sponsor in a "Sponsorship Overview" prose section — "Vornado Realty Trust and
 * Crown Acquisitions" — and never uses the Goldman labels), the regex returns
 * null → `parties: null` → the sponsor-DD lane reports could-not-search. This
 * module de-anchors that: when the regex path finds nothing, it reads the WHOLE
 * ASR text with the LLM and extracts the borrower entity + the sponsor
 * PRINCIPALS (a JV names several).
 *
 * MIRRORS extract-asr-loan-terms-llm.ts EXACTLY — same governance armor:
 *   - injectable LLM seam (proofs pass a deterministic stub),
 *   - credit-gate (no key ⇒ skip the call, $0),
 *   - temperature 0 (greedy / replay-stable),
 *   - CITE-OR-DISCARD: every name must appear VERBATIM in the document (the
 *     anti-fabrication grounding) AND be backed by a non-empty sourceQuote that
 *     contains it — an un-grounded name is DISCARDED to null. No fabrication
 *     ever reaches the parties record. (Grounding on the name — short, copied
 *     faithfully — is robust to PDF whitespace noise that breaks long-quote
 *     matching, while still guaranteeing the name is genuinely in the file.)
 *   - null-not-fabricate: no cited name → parties: null.
 *   - CACHE keyed by (docHash + extractorVersion), injectable.
 *
 * ★ TARGET THE SPONSOR/PRINCIPAL, not the bankruptcy-remote borrower SPV. The
 * SPONSOR (the reputation-relevant parent/guarantor/JV partner) is what the
 * person-DD lane searches. The borrower SPV is captured when named but is
 * typically generic/bankruptcy-remote; when it isn't named, that stays null
 * (honest-blank), never forced.
 *
 * ★ THE GENUINE-GAP INVARIANT. A filing that truly names only the SPV (no
 * principal disclosed) → cite-or-discard yields no principal → sponsors empty →
 * "cannot assess" correctly stands. We extract only what is genuinely present.
 *
 * FAIL-SAFE. No credits / LLM error / malformed output ⇒ parties null ⇒ the
 * sponsor-DD lane stays could-not-search (today's honest floor). NEVER crashes,
 * NEVER fabricates.
 */

import type { PartiesExtraction } from '@cre/contracts';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';

/** Bump when the prompt / schema / normalization changes — participates in the
 *  cache key so a version bump cleanly re-extracts (no stale reads). */
export const ASR_PARTIES_LLM_VERSION = '1.0.0';

/** Cap the LLM's view of the doc (matches the loan-terms extractor's ceiling —
 *  identity blocks live in the first pages, but we pass the whole doc so a prose
 *  "Sponsorship Overview" buried anywhere is still covered). */
const MAX_LLM_TEXT_CHARS = 80_000;

/** Model — defaults to CLAUDE_MODEL (Sonnet); overridable for tests / bumps. */
export const ASR_PARTIES_LLM_MODEL: string =
  process.env['ASR_PARTIES_LLM_MODEL'] ?? CLAUDE_MODEL;

/* --------------------------- injectable LLM seam --------------------------- */

/** Mirrors `callAIWithContinuation`'s option shape; a proof passes a stub. */
export type PartiesLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/* ----------------------------- injectable cache ---------------------------- */

/**
 * Extract-once-per-doc-version cache. Keyed by (docHash + extractorVersion).
 * Injectable so production can back it with SQLite and proofs use an in-memory
 * map. (Today the composer's extraction_input_cache dedupes at a higher level,
 * so DEFAULT_ASR_DEPS passes no cache — same as the loan-terms extractor.)
 */
export interface PartiesLlmCache {
  get(docHash: string, extractorVersion: string): PartiesLlmResult | null;
  put(docHash: string, extractorVersion: string, result: PartiesLlmResult): void;
}

/** A trivial in-memory cache for proofs / single-process use. */
export class InMemoryPartiesLlmCache implements PartiesLlmCache {
  private readonly store = new Map<string, PartiesLlmResult>();
  get(docHash: string, v: string): PartiesLlmResult | null {
    return this.store.get(`${docHash}::${v}`) ?? null;
  }
  put(docHash: string, v: string, result: PartiesLlmResult): void {
    this.store.set(`${docHash}::${v}`, result);
  }
}

/* -------------------------------- result shape ----------------------------- */

/** Per-name provenance: the raw name the LLM returned and the verbatim quote it
 *  cited. `cited` records whether the quote was verified present + name-bearing
 *  (the cite-or-discard outcome). Observability only. */
export interface PartiesFieldTrace {
  readonly field: string;
  readonly name: string | null;
  readonly sourceQuote: string | null;
  readonly cited: boolean;
}

export interface PartiesLlmResult {
  /** The parties record, or null when nothing citeable surfaced / credits out /
   *  the call failed. When present, `sponsors` is the cited principal list and
   *  `sponsorName` is its first element (back-compat). */
  readonly parties: PartiesExtraction | null;
  /** Per-name citation traces (observability / audit). */
  readonly traces: readonly PartiesFieldTrace[];
  /** Warnings surfaced into the memo's Data Quality channel. */
  readonly warnings: readonly string[];
  /** True when this result came from the cache (no LLM call this invocation). */
  readonly fromCache: boolean;
  /** True when a live LLM call was made this invocation. */
  readonly llmCalled: boolean;
}

const EMPTY: Omit<PartiesLlmResult, 'fromCache' | 'llmCalled'> = {
  parties: null,
  traces: [],
  warnings: [],
};

/* -------------------------------- credit gate ------------------------------ */

/** True only when an API key is present. When false the LLM call is skipped
 *  ENTIRELY (no request, no cost). Injectable-overridable via deps for the
 *  no-credits fail-safe proof. */
export function partiesCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* --------------------------------- prompt ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate credit analyst extracting the PARTIES to a',
  'loan from an Asset Summary Report (ASR). You read the WHOLE document and are',
  'robust to any issuer format (Goldman Sachs, Bank of Montreal, Morgan Stanley,',
  'etc.).',
  '',
  'Return ONLY a single JSON object of the exact shape below. No prose, no',
  'markdown, no code fences.',
  '',
  'WHAT TO EXTRACT:',
  '- borrowerEntity: the BORROWER — the legal entity (usually a single-purpose',
  '  LLC / LP) that holds the mortgage loan, IF the document names it. This is',
  '  often a bankruptcy-remote SPV. If the ASR does not name a specific borrowing',
  '  entity, set it to null (do NOT guess).',
  '- sponsorPrincipals: the SPONSOR(S) — the reputation-relevant principal(s)',
  '  behind the borrower: the parent company, guarantor, key principal, or (on a',
  '  joint venture) EACH JV partner. Return a LIST with one entry per DISTINCT',
  '  named principal. A JV such as "Vornado Realty Trust and Crown Acquisitions"',
  '  yields TWO entries: "Vornado Realty Trust" AND "Crown Acquisitions".',
  '',
  'CRITICAL RULES:',
  '- Every name MUST be accompanied by a "sourceQuote": a SHORT verbatim string',
  '  copied EXACTLY from the document that CONTAINS that name. If you cannot find',
  '  a verbatim quote that contains the name, OMIT that entry (for the list) or',
  '  set the value AND sourceQuote to null (for borrowerEntity). NEVER invent or',
  '  infer a name that is not literally written in the document.',
  '- Return the ACTUAL entity/company/person NAME — never a defined term or role',
  '  word. "the Sponsor", "the Borrower", "the JV Partners", "Sponsor",',
  '  "Borrower", "Guarantor", "Mortgagor" are NOT names — if the document only',
  '  uses such a placeholder without a real name, return null / omit.',
  '- If NO principal is named anywhere (the filing discloses only a generic SPV',
  '  and no parent/guarantor/principal), return an EMPTY sponsorPrincipals list.',
  '  That is the correct, honest answer — do not manufacture a principal.',
].join('\n');

function buildUserPrompt(text: string): string {
  return [
    'Extract the parties from this ASR. Return STRICT JSON of EXACTLY this shape:',
    '{',
    '  "borrowerEntity":    { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "sponsorPrincipals": [ { "value": <string>, "sourceQuote": <string> }, ... ]',
    '}',
    '',
    '--- ASR DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

/* ------------------------------- normalizers ------------------------------- */

/** Whitespace normalize for the presence check (PDF extraction collapses /
 *  re-flows whitespace; a quote should match modulo whitespace + case). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Role words / defined terms that are NOT real entity names. A cited name that
 *  reduces to one of these is discarded — the genuine-gap invariant (a filing
 *  that only says "the Sponsor" names no principal). */
const PLACEHOLDER_NAMES = new Set<string>([
  'sponsor', 'the sponsor', 'sponsors', 'the sponsors',
  'borrower', 'the borrower', 'borrowers', 'the borrowers',
  'guarantor', 'the guarantor', 'guarantors',
  'mortgagor', 'the mortgagor',
  'jv partners', 'the jv partners', 'joint venture', 'the joint venture',
  'principal', 'the principal', 'key principal',
  'n/a', 'na', 'none', 'null', 'tbd', 'various', 'undisclosed', 'not disclosed',
]);

function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

/* ----------------------------- cite-or-discard ----------------------------- */

/**
 * ★ CITE-OR-DISCARD for a NAME. Returns the cleaned name ONLY when:
 *   (a) it is a plausible entity name — ≥2 chars, not a placeholder/role word
 *       ("the Sponsor", "Borrower", "JV Partners", …); AND
 *   (b) the NAME appears VERBATIM (whitespace/case-normalized) in the document
 *       text — the anti-fabrication grounding. A name genuinely present in the
 *       source is what the DD lane searches; a name the LLM invented (not in the
 *       doc) is discarded. This is the load-bearing check; AND
 *   (c) the LLM provided a non-empty sourceQuote that itself CONTAINS the name —
 *       so the model cited evidence for it, not a bare guess.
 *
 * NOTE (why not quote-in-doc): matching the LLM's long verbatim quote against
 * PDF-extracted text is brittle (unpdf re-flows whitespace, drops ligatures,
 * splices page-header noise into the middle of a sentence). The NAME is short
 * and copied faithfully, so grounding on name-in-doc is both robust AND a
 * strictly-sufficient anti-fabrication guarantee: the name is really in the file.
 */
function citeName(
  field: string,
  rawValue: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
  traces: PartiesFieldTrace[],
): string | null {
  const name = typeof rawValue === 'string' ? rawValue.trim() : '';
  const quote = typeof rawQuote === 'string' ? rawQuote.trim() : '';
  if (name.length < 2 || isPlaceholderName(name)) {
    traces.push({ field, name: name.length > 0 ? name : null, sourceQuote: quote.length > 0 ? quote : null, cited: false });
    return null;
  }
  const nameNorm = normalizeWs(name);
  const nameInDoc = normalizedDoc.includes(nameNorm);          // (b) grounding
  const nameInQuote = quote.length > 0 && normalizeWs(quote).includes(nameNorm); // (c) evidence
  const cited = nameInDoc && nameInQuote;
  traces.push({ field, name, sourceQuote: quote.length > 0 ? quote : null, cited });
  return cited ? name : null;
}

/* --------------------------------- parser ---------------------------------- */

function fieldOf(o: Record<string, unknown>, key: string): { value: unknown; sourceQuote: unknown } {
  const f = o[key];
  if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
    const r = f as Record<string, unknown>;
    return { value: r['value'], sourceQuote: r['sourceQuote'] };
  }
  return { value: f, sourceQuote: null };
}

/**
 * Pure parser over the raw LLM text. Exported so proofs exercise the full
 * safeguard chain (parse + cite-or-discard + dedup) deterministically off a
 * fixture string with no live call.
 */
export function parsePartiesLlmResponse(
  responseText: string,
  docText: string,
): Omit<PartiesLlmResult, 'fromCache' | 'llmCalled'> {
  let parsed: unknown;
  try {
    parsed = extractJSON(responseText);
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY;
  const o = parsed as Record<string, unknown>;

  const normalizedDoc = normalizeWs(docText);
  const traces: PartiesFieldTrace[] = [];
  const warnings: string[] = [];

  // Borrower entity (single, optional). Cite-or-discard.
  const borrower = fieldOf(o, 'borrowerEntity');
  const borrowerName = citeName('borrowerEntity', borrower.value, borrower.sourceQuote, normalizedDoc, traces);

  // Sponsor principals (list). Cite-or-discard EACH; drop uncited; dedupe.
  const rawPrincipals = Array.isArray(o['sponsorPrincipals']) ? (o['sponsorPrincipals'] as unknown[]) : [];
  const sponsors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawPrincipals.length; i++) {
    const p = rawPrincipals[i];
    const rec = (p !== null && typeof p === 'object') ? (p as Record<string, unknown>) : { value: p, sourceQuote: null };
    const name = citeName(`sponsorPrincipals[${i}]`, rec['value'], rec['sourceQuote'], normalizedDoc, traces);
    if (name === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sponsors.push(name);
  }

  const droppedPrincipals = rawPrincipals.length - sponsors.length;
  if (droppedPrincipals > 0) {
    warnings.push(`Parties LLM: ${droppedPrincipals} proposed principal(s) discarded (un-citeable / placeholder / duplicate).`);
  }

  // Honest not-found: nothing citeable → parties null (sponsor-DD stays could-not-search).
  if (borrowerName === null && sponsors.length === 0) {
    return { parties: null, traces, warnings };
  }

  const parties: PartiesExtraction = {
    borrowerName,
    // Back-compat: sponsorName is the first cited principal (or null when the
    // borrower was named but no principal was).
    sponsorName: sponsors.length > 0 ? sponsors[0]! : null,
    sponsors,
  };
  return { parties, traces, warnings };
}

/* --------------------------------- runner ---------------------------------- */

export interface ExtractPartiesFromAsrLlmDeps {
  /** Injectable LLM seam. Defaults to the real Anthropic call. */
  readonly llmCall?: PartiesLlmCall;
  /** Injectable credit gate. Defaults to the env-key check. */
  readonly creditsAvailable?: () => boolean;
  /** Injectable cache. Omit to run without caching. */
  readonly cache?: PartiesLlmCache;
  /** Extractor version participating in the cache key. Defaults to the module
   *  version; override in tests to prove version-busting. */
  readonly extractorVersion?: string;
}

/**
 * LLM-primary parties extraction over the FULL ASR text.
 *
 * @param docText   the full ASR rawText (all pages).
 * @param docHash   content hash of the ASR bytes (cache key half).
 * @param deps      injectable LLM seam / credit gate / cache / version.
 *
 * Order of operations (mirrors extract-asr-loan-terms-llm.ts):
 *   1. CACHE — stored result for (docHash, version) → return it ($0).
 *   2. CREDIT GATE — no credits → EMPTY (parties null) WITHOUT calling ($0).
 *   3. LLM CALL (temp 0) → parse → cite-or-discard.
 *   4. FAIL-SAFE — any throw ⇒ EMPTY. Never crashes, never fabricates.
 *   5. STORE — put the fresh result in the cache.
 */
export async function extractPartiesFromAsrLlm(
  docText: string,
  docHash: string,
  deps: ExtractPartiesFromAsrLlmDeps = {},
): Promise<PartiesLlmResult> {
  const version = deps.extractorVersion ?? ASR_PARTIES_LLM_VERSION;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? partiesCreditsAvailable;
  const cache = deps.cache;

  const empty = (): PartiesLlmResult => ({ ...EMPTY, fromCache: false, llmCalled: false });

  if (typeof docText !== 'string' || docText.trim().length === 0) return empty();

  // (1) CACHE — extract-once-per-doc-version.
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
      model: ASR_PARTIES_LLM_MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(docText.slice(0, MAX_LLM_TEXT_CHARS)) }],
      temperature: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AI:Parties] extraction call failed:', err);
    return empty();
  }

  const parsed = parsePartiesLlmResponse(raw, docText);
  const result: PartiesLlmResult = { ...parsed, fromCache: false, llmCalled: true };

  // (5) STORE — freeze the answer so the next underwrite is $0 + deterministic.
  if (cache) cache.put(docHash, version, result);

  return result;
}
