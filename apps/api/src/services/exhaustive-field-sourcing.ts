/**
 * exhaustiveFieldSourcing — the EXHAUSTIVE SOURCING PASS.
 *
 * ★ DOCTRINE (Isabelle's rule): before ANY field is reported unsourced, search
 * EVERY document on the deal for it. "We didn't extract it" ≠ "it isn't there".
 * Only after an exhaustive LLM search across ALL deal documents comes back empty
 * is a field an honest blank — and the blank is now trustworthy because it was
 * EARNED by the search.
 *
 * WHY THIS EXISTS. The intake-completeness / coverage K-resolver reads the graph
 * ExtractionResult — the docs that were EXTRACTED at ingest. But a deal carries
 * more documents than were extracted (640: 10 routed docs, only 5 in the graph —
 * the ESA, appraisals, cash-flow workbooks + seller UW were never read). Fields
 * those docs would source (environmental status, stabilized value/NOI, in-place
 * NOI, GSA tenancy) showed "missing" though the fact sits in a doc on the deal.
 * This pass reads the WHOLE routed doc set and searches it, per would-be-missing
 * field, BEFORE the completeness layer declares the field unsourced.
 *
 * SAFEGUARDS (mirrors the proven LLM-primary extractors —
 * extract-asr-loan-terms-llm.ts):
 *   (a) temperature 0 + STRICT JSON + "null when not literally stated".
 *   (b) CITE-OR-DISCARD — every hit carries a verbatim sourceQuote we verify is
 *       literally present (whitespace-normalized) in the cited document's text.
 *       Un-citeable → discarded → the field stays honestly unsourced.
 *   (c) CACHING — keyed by (docSetHash + fieldId + version). Search once per
 *       (doc-set, field); a re-request replays the frozen result ($0, stable).
 *   (d) CREDIT-GATE + FAIL-SAFE — no key / LLM error → the pass is skipped and
 *       every field stays at its pre-search state (never crashes, never
 *       fabricates). An unsourced field is unsourced, not falsely found.
 *
 * READ-ONLY. This pass NEVER writes the graph / re-underwrites — it augments the
 * ADVISORY completeness read only. The score / revision are untouched.
 */

import { createHash } from 'node:crypto';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';
import { listPoolDocs, listHeldDocs } from './data-room-store.service.js';
import { blobStore } from '../storage/blob-store.js';
import type { ContentHash } from '@cre/contracts';
import { parseDocument } from './document-parser.service.js';

/** Bump when the prompt / query roster / capping changes (participates in the
 *  cache key so a version bump cleanly re-searches). */
export const EXHAUSTIVE_SOURCING_VERSION = '1.0.0';

export const EXHAUSTIVE_SOURCING_MODEL: string =
  process.env['EXHAUSTIVE_SOURCING_MODEL'] ?? CLAUDE_MODEL;

/** Per-doc character cap. Summaries / conclusion tables sit early (640 ESA's REC
 *  conclusion is at char ~9K of 8.25M); we take the head plus keyword windows so
 *  a deep fact in a large doc is still reachable without blowing the context. */
const HEAD_CHARS = 24_000;
const WINDOW_CHARS = 1_400;
const MAX_WINDOWS_PER_DOC = 8;
const MAX_DOC_CHARS = HEAD_CHARS + WINDOW_CHARS * MAX_WINDOWS_PER_DOC;
/** Total budget across all docs passed for one field's search. */
const MAX_BUNDLE_CHARS = 110_000;

/* ------------------------------ types ------------------------------------- */

export interface DealDocText {
  readonly docType: string;
  readonly fileName: string;
  readonly fileHash: string;
  readonly text: string;
}

/** One field to exhaustively source. `keywords` drive the large-doc windowing;
 *  `preferDocTypes` order docs so the most likely source is seen first. */
export interface FieldQuery {
  readonly id: string;
  readonly field: string;
  readonly hint: string;
  readonly keywords: readonly string[];
  readonly preferDocTypes: readonly string[];
}

/**
 * ★ THREE outcomes — the trust distinction:
 *   'found'       the search located the fact (cited).
 *   'absent'      the search RAN and the fact is in NO document → an EARNED blank.
 *   'unavailable' the search COULD NOT run (no credits / LLM error / no doc text)
 *                 → "we don't know yet" — NEVER a confirmed missing. Not cached,
 *                 so it retries once the search is available again.
 */
export type SourcingStatus = 'found' | 'absent' | 'unavailable';

export interface FieldSourcingResult {
  readonly id: string;
  readonly found: boolean;
  readonly value: string | null;
  readonly sourceQuote: string | null;
  readonly docName: string | null;
  readonly status: SourcingStatus;
  /** true only when a live LLM call COMPLETED this invocation (false on cache
   *  hit / no-credits skip / error). */
  readonly searched: boolean;
}

export interface ExhaustiveSourcingCache {
  get(key: string): FieldSourcingResult | null;
  put(key: string, result: FieldSourcingResult): void;
}

export class InMemoryExhaustiveSourcingCache implements ExhaustiveSourcingCache {
  private readonly store = new Map<string, FieldSourcingResult>();
  get(key: string): FieldSourcingResult | null { return this.store.get(key) ?? null; }
  put(key: string, result: FieldSourcingResult): void { this.store.set(key, result); }
}

/** Process-lifetime default cache (search once per doc-set+field+version). */
export const defaultCache = new InMemoryExhaustiveSourcingCache();

/** Stable hash of a doc set from its content hashes — computed from the MANIFEST
 *  (no parse needed) so a cache-peek can skip the expensive gather+parse when a
 *  field is already searched. */
export function docSetHashFromFileHashes(fileHashes: readonly string[]): string {
  const h = createHash('sha256');
  for (const fh of [...fileHashes].sort((a, b) => a.localeCompare(b))) h.update(fh);
  return h.digest('hex').slice(0, 16);
}

export function buildCacheKey(docSetHash: string, fieldId: string, version: string): string {
  return `${docSetHash}::${fieldId}::${version}`;
}

export type ExhaustiveLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

export interface ExhaustiveSourcingDeps {
  readonly llmCall?: ExhaustiveLlmCall;
  readonly creditsAvailable?: () => boolean;
  readonly cache?: ExhaustiveSourcingCache;
  readonly version?: string;
}

export function exhaustiveSourcingCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* ----------------------------- doc gathering ------------------------------ */

/**
 * Gather + parse the text of EVERY document ON the deal — ROUTED docs AND HELD
 * (un-routed) docs hinted to this loan. ★ Doctrine: "search every document I gave
 * it" includes files still in the held tray (a file Isabelle dropped is a file
 * she gave it, routed or not — e.g. occupancy files with no doc-type to route to).
 * Best-effort per doc: a parse failure drops that one doc (logged), never fails
 * the pass.
 */
export async function gatherDealDocTexts(
  poolId: string,
  loanInPoolId: string,
): Promise<DealDocText[]> {
  // Routed docs (by loan) + HELD docs hinted to this loan. Same shape, one set.
  const routed = listPoolDocs(poolId)
    .filter((d) => d.loanInPoolId === loanInPoolId)
    .map((d) => ({ docType: d.docType, fileName: d.fileName, fileHash: d.fileHash, mimeType: d.mimeType }));
  const held = listHeldDocs(poolId)
    .filter((h) => h.hintLoanInPoolId === loanInPoolId)
    .map((h) => ({ docType: h.hintDocType ?? 'held', fileName: h.fileName, fileHash: h.fileHash, mimeType: h.mimeType }));

  const out: DealDocText[] = [];
  const seen = new Set<string>();
  for (const e of [...routed, ...held]) {
    if (seen.has(e.fileHash)) continue; // a held file already routed → count once
    seen.add(e.fileHash);
    try {
      const bytes = await blobStore.getBlob(e.fileHash as ContentHash);
      if (bytes === null) continue; // blob missing → skip this doc (best-effort)
      const parsed = await parseDocument(bytes, e.fileName, e.mimeType);
      const text = parsed.rawText ?? '';
      if (text.trim().length > 0) {
        out.push({ docType: e.docType, fileName: e.fileName, fileHash: e.fileHash, text });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ExhaustiveSourcing] parse failed for ${e.fileName}:`, err);
    }
  }
  return out;
}

/* ------------------------------ capping ----------------------------------- */

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Head + keyword-windows: the doc head (where summaries/conclusions live) plus
 *  short windows around each keyword hit, so a deep fact in a large doc surfaces
 *  without passing the whole document. */
function capDoc(text: string, keywords: readonly string[]): string {
  if (text.length <= HEAD_CHARS) return text;
  const head = text.slice(0, HEAD_CHARS);
  const windows: string[] = [];
  const lower = text.toLowerCase();
  let taken = 0;
  for (const kw of keywords) {
    if (taken >= MAX_WINDOWS_PER_DOC) break;
    const k = kw.toLowerCase();
    let from = HEAD_CHARS; // only mine BEYOND the head (head already included)
    let idx = lower.indexOf(k, from);
    while (idx >= 0 && taken < MAX_WINDOWS_PER_DOC) {
      const start = Math.max(0, idx - Math.floor(WINDOW_CHARS / 2));
      windows.push(text.slice(start, start + WINDOW_CHARS));
      taken += 1;
      from = idx + WINDOW_CHARS;
      idx = lower.indexOf(k, from);
    }
  }
  const combined = head + (windows.length > 0 ? '\n…\n' + windows.join('\n…\n') : '');
  return combined.slice(0, MAX_DOC_CHARS);
}

/** Order docs by the field's preferred types, cap each, and pack up to the
 *  bundle budget. Returns the labelled bundle + the capped per-doc text (for the
 *  cite-or-discard presence check). */
function buildBundle(
  query: FieldQuery,
  docs: DealDocText[],
): { bundle: string; cappedByDoc: Map<string, string> } {
  const rank = (d: DealDocText): number => {
    const i = query.preferDocTypes.indexOf(d.docType);
    return i < 0 ? query.preferDocTypes.length + 1 : i;
  };
  const ordered = [...docs].sort((a, b) => rank(a) - rank(b));
  const cappedByDoc = new Map<string, string>();
  const parts: string[] = [];
  let budget = MAX_BUNDLE_CHARS;
  for (const d of ordered) {
    if (budget <= 0) break;
    const capped = capDoc(d.text, query.keywords).slice(0, budget);
    if (capped.trim().length === 0) continue;
    cappedByDoc.set(d.fileName, capped);
    parts.push(`===== DOCUMENT: ${d.fileName} (type: ${d.docType}) =====\n${capped}`);
    budget -= capped.length;
  }
  return { bundle: parts.join('\n\n'), cappedByDoc };
}

/* -------------------------------- search ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate credit analyst SEARCHING a deal\'s documents',
  'for one specific fact. You are exhaustive: you read across ALL the documents',
  'provided before concluding a fact is absent.',
  '',
  'Return ONLY a single JSON object, no prose, no markdown:',
  '{ "found": <bool>, "value": <string|null>, "sourceQuote": <string|null>, "docName": <string|null> }',
  '',
  'RULES:',
  '- found=true ONLY if the documents literally state the fact. Copy a SHORT',
  '  verbatim "sourceQuote" (exact substring) from the document that states it,',
  '  and put that document\'s name in "docName".',
  '- If the fact is not stated in ANY provided document, return',
  '  { "found": false, "value": null, "sourceQuote": null, "docName": null }.',
  '- NEVER infer, compute, or guess. No verbatim quote → found=false.',
].join('\n');

function buildUserPrompt(query: FieldQuery, bundle: string): string {
  return [
    `FIELD TO FIND: ${query.field}`,
    `WHAT IT MEANS: ${query.hint}`,
    '',
    'Search every document below. Return the STRICT JSON described.',
    '',
    '--- DEAL DOCUMENTS ---',
    bundle,
  ].join('\n');
}

/** 'absent' — the search RAN and found the fact NOWHERE → an EARNED blank (cached). */
const ABSENT = (id: string): FieldSourcingResult => ({
  id, found: false, value: null, sourceQuote: null, docName: null, status: 'absent', searched: true,
});
/** 'unavailable' — the search COULD NOT run (no credits / error / no text). NEVER
 *  a confirmed missing; NOT cached (retries when the search is available again). */
const UNAVAILABLE = (id: string): FieldSourcingResult => ({
  id, found: false, value: null, sourceQuote: null, docName: null, status: 'unavailable', searched: false,
});

/**
 * Exhaustively source ONE field across the deal's docs. Cache → credit-gate →
 * LLM search → cite-or-discard. Returns 'found' (value+quote+docName), 'absent'
 * (EARNED blank), or 'unavailable' (could-not-search — NOT a confirmed missing).
 */
export async function sourceOneField(
  query: FieldQuery,
  docs: DealDocText[],
  docSetHash: string,
  deps: ExhaustiveSourcingDeps = {},
): Promise<FieldSourcingResult> {
  const version = deps.version ?? EXHAUSTIVE_SOURCING_VERSION;
  const cache = deps.cache ?? defaultCache;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? exhaustiveSourcingCreditsAvailable;

  if (docs.length === 0) return UNAVAILABLE(query.id); // nothing to search → unknown, not absent

  const key = buildCacheKey(docSetHash, query.id, version);
  const hit = cache.get(key);
  if (hit) return { ...hit, searched: false }; // only 'found'/'absent' are ever cached

  if (!hasCredits()) return UNAVAILABLE(query.id); // ★ could-not-search — NOT a false blank

  const { bundle, cappedByDoc } = buildBundle(query, docs);
  if (bundle.trim().length === 0) return UNAVAILABLE(query.id);

  let raw: string;
  try {
    raw = await llmCall({
      model: EXHAUSTIVE_SOURCING_MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(query, bundle) }],
      temperature: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ExhaustiveSourcing] search failed for ${query.id}:`, err);
    return UNAVAILABLE(query.id); // ★ fail-safe → 'unavailable', NOT a searched blank
  }

  let parsed: unknown;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  const o = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
  const found = o?.['found'] === true;
  const value = typeof o?.['value'] === 'string' ? (o['value'] as string).trim() : null;
  const quote = typeof o?.['sourceQuote'] === 'string' ? (o['sourceQuote'] as string).trim() : null;
  const docName = typeof o?.['docName'] === 'string' ? (o['docName'] as string).trim() : null;

  // CITE-OR-DISCARD — the quote must literally appear in some capped doc text.
  let result: FieldSourcingResult;
  if (found && quote && quote.length > 0) {
    const nq = normalizeWs(quote);
    let citedDoc: string | null = null;
    for (const [name, text] of cappedByDoc) {
      if (normalizeWs(text).includes(nq)) { citedDoc = name; break; }
    }
    result = citedDoc
      ? { id: query.id, found: true, value: value ?? quote, sourceQuote: quote, docName: docName ?? citedDoc, status: 'found', searched: true }
      : ABSENT(query.id); // un-citeable → discard → EARNED honest blank
  } else {
    result = ABSENT(query.id); // searched, genuinely not found
  }

  cache.put(key, result); // only 'found'/'absent' reach here → 'unavailable' never cached
  return result;
}

/** Source many fields (sequential to bound concurrent LLM load; each cached). */
export async function exhaustivelySourceFields(
  queries: readonly FieldQuery[],
  docs: DealDocText[],
  docSetHash: string,
  deps: ExhaustiveSourcingDeps = {},
): Promise<Map<string, FieldSourcingResult>> {
  const out = new Map<string, FieldSourcingResult>();
  for (const q of queries) {
    out.set(q.id, await sourceOneField(q, docs, docSetHash, deps));
  }
  return out;
}
