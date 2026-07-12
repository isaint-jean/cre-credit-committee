/**
 * LLM smart-routing tier (Tier 3.5) for the Data-Room classify cascade.
 *
 * This is the ONE LLM tier in the routing path. It fires INSIDE
 * `classifyFileCascade`, AFTER the deterministic tier-3 content scan and BEFORE
 * a hard doc falls to HELD, behind the SAME hard-doc guard tier-3 uses
 * (`loanInPoolId === null || docType === null`). So it fires ONLY on the ~5
 * hard docs regex/fuzzy already gave up on, NEVER on the ~7 that auto-routed on
 * folder/filename. Cheap by construction.
 *
 * WHAT IT SEES: the filename + the already-extracted front-matter text (the
 * SAME `pageText` blob tier-3 parsed — no new parsing) + the pool's ACTUAL loans
 * + the ACTUAL doc-type taxonomy. Closed lists on BOTH axes.
 *
 * WHAT IT RETURNS: `{ loanInPoolId, docType, confidence, reason }` — validated
 * against the pool loans and the taxonomy enum, unsure→null.
 *
 * ── THE THREE HONESTY GUARDS (all enforced HERE, before any hint is filled) ──
 *   1. HOLD-WHEN-UNSURE — a null axis, OR confidence < CONFIDENCE_THRESHOLD,
 *      leaves that axis null → the doc HELDs. The deterministic-or-refuse floor
 *      survives; the LLM can only RAISE the auto-rate, never lower the floor.
 *   2. MATCH-REAL-TARGETS — a returned loanInPoolId NOT in the pool set is
 *      discarded→null; a returned docType NOT in DOC_TYPE_TAXONOMY is
 *      discarded→null. It cannot conjure a loan or a doc-type.
 *   3. VISIBLE/REVERSIBLE — when it fills an axis it emits a provenance note
 *      ("routed by AI — {reason}") the caller writes into `data_room_doc.notes`
 *      so a human sees + can override.
 *
 * ── FAIL-SAFE (mandatory) ──
 *   No credits / no API key → the LLM call is SKIPPED entirely (credit-gated).
 *   Any LLM error / timeout / malformed output → this returns null → the tier
 *   is a NO-OP → the doc HELDs (today's behavior). NEVER crashes, NEVER
 *   fabricates. The invariant: LLM present → higher auto-rate; LLM absent/broken
 *   → today's behavior EXACTLY.
 *
 * Pure over its inputs except for the single (optional, injectable) LLM call —
 * no DB, no store. The caller (`classifyFileCascade`) folds the result into the
 * SAME `loanInPoolId`/`docType` locals, so `verdictFor`/assign/underwrite are
 * untouched (the both-axes-confident safety bar still applies).
 */

import { DOC_TYPE_TAXONOMY, docTypeById } from '@cre/contracts';
import { env } from '../../config/env.js';
import { callAIWithContinuation } from '../ai-analysis.service.js';
import type { PoolLoanNameKey } from '../data-room-classify.service.js';

/** Model for the routing call — cheapest tier, closed-list classification is
 *  exactly Haiku's sweet spot. Overridable via LLM_SMART_ROUTE_MODEL. */
export const SMART_ROUTE_MODEL: string =
  process.env['LLM_SMART_ROUTE_MODEL'] ?? 'claude-haiku-4-5';

/** GUARD 1 — the confidence floor. An axis below this bar is discarded → null →
 *  the doc HELDs. Labeled-tunable (start conservative at 0.75). */
export const CONFIDENCE_THRESHOLD = 0.75;

/** Front-matter is capped generously; keep the LLM's view within a sane budget
 *  regardless of what the parser returned. */
const MAX_LLM_TEXT_CHARS = 12_000;

/** The structured verdict the LLM returns, AFTER validation. Any axis the guards
 *  rejected is null. `note` is populated only when an axis was actually filled. */
export interface LlmRouteResult {
  readonly loanInPoolId: string | null;
  readonly docType: string | null;
  readonly confidence: number;
  readonly reason: string;
  /** "routed by AI — {reason}" provenance for `data_room_doc.notes`, or null
   *  when the tier filled NO axis (nothing to record). */
  readonly note: string | null;
}

/** The injectable LLM seam. Signature mirrors `callAIWithContinuation`; a proof
 *  can pass a deterministic stub. Returns the raw model text. */
export type LlmRouteCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/** Credit gate — true only when an API key is present. When false the LLM call
 *  is skipped ENTIRELY (no request, no cost). Kept injectable for the no-credits
 *  fail-safe proof. */
export function creditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/** The frozen system prompt (cache-friendly). Defines the doc-types so the model
 *  routes an ASR to `asr` (the loan-terms SPINE doc) and the seller/Morgan-Stanley
 *  underwriting MODEL to `seller_uw` (a benchmark, NOT the ASR). */
const SYSTEM_PROMPT = [
  'You are a commercial-real-estate (CRE) data-room filing clerk. You are given a',
  "document's filename and its first-page text, the pool's actual loans, and the",
  'actual document-type taxonomy. Decide (1) which loan in the pool this document',
  'belongs to and (2) which document type it is — STRICTLY from the provided lists.',
  '',
  'Key document-type definitions:',
  '- asr = Asset Summary Report — the loan-terms SPINE document (loan amount, rate,',
  '  term, sponsor, property summary). This is the deal spine, NOT an underwriting model.',
  '- seller_uw = the SELLER\'s / issuer\'s / Morgan-Stanley underwriting MODEL — a',
  '  benchmark spreadsheet. It is NOT the ASR. If a doc is an underwriting model /',
  '  cash-flow model / issuer UW, it is seller_uw, never asr.',
  '- rent_roll = tenant-by-tenant rent schedule.',
  '- cf = cash-flow / operating statement / T-12 / trailing actuals / historical income.',
  '- t12 = a stored trailing-12 operating statement.',
  '- appraisal = third-party appraisal report.',
  '- pca = property condition assessment / engineering report.',
  '- insurance, title, legal, closing, leases, loan_terms, sponsor_pfs, phase_i_esa,',
  '  om, general — supporting room documents.',
  '',
  'RULES:',
  '- You MUST pick loanInPoolId from the given pool-loan list, or return null.',
  '- You MUST pick docType from the given taxonomy list, or return null.',
  '- If you are not confident about an axis, return null for THAT axis — do NOT guess.',
  '- You may NOT invent a loan or a document type that is not in the lists.',
  '- Return ONLY a single JSON object, no prose, no code fences.',
].join('\n');

/** Build the user message: filename + front-matter + the closed loan roster +
 *  the closed taxonomy. Both lists are what stop the model free-guessing. */
function buildUserPrompt(
  fileName: string,
  pageText: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): string {
  const loanLines = poolLoans
    .map((l) => {
      const name = l.propertyName ?? l.originatorLoanRef ?? '(unnamed)';
      const ref = l.originatorLoanRef ?? '';
      return `- loanInPoolId=${l.loanInPoolId}  name="${name}"  ref="${ref}"`;
    })
    .join('\n');

  const typeLines = DOC_TYPE_TAXONOMY.map((e) => `- ${e.id}  ${e.label}`).join('\n');

  return [
    `FILENAME: ${fileName}`,
    '',
    'FIRST-PAGE TEXT:',
    pageText.slice(0, MAX_LLM_TEXT_CHARS) || '(no extractable text)',
    '',
    'POOL LOANS (choose loanInPoolId from this list only, or null):',
    loanLines || '(none)',
    '',
    'DOC TYPES (choose docType id from this list only, or null):',
    typeLines,
    '',
    'Return a single JSON object of the exact shape:',
    '{"loanInPoolId": <id-string|null>, "docType": <id-string|null>, "confidence": <0.0-1.0>, "reason": <short-string>}',
  ].join('\n');
}

/** Defensive parse — tolerate fences / surrounding prose by extracting the first
 *  top-level JSON object. Malformed → null (→ fail-safe HELD). */
function parseRaw(raw: string): {
  loanInPoolId: unknown;
  docType: unknown;
  confidence: unknown;
  reason: unknown;
} | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  return {
    loanInPoolId: o['loanInPoolId'],
    docType: o['docType'],
    confidence: o['confidence'],
    reason: o['reason'],
  };
}

/**
 * The Tier-3.5 LLM classify. Credit-gated + fail-safe: returns a NO-OP result
 * (both axes null, no note) whenever credits are out, the call errors, or the
 * output is malformed — so the doc HELDs exactly as today.
 *
 * @param llmCall injectable LLM seam (defaults to the real Anthropic call). A
 *   proof passes a stub to exercise the routing/guard logic deterministically.
 */
export async function classifyByLlm(
  fileName: string,
  pageText: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
  llmCall: LlmRouteCall = callAIWithContinuation,
): Promise<LlmRouteResult> {
  const noop: LlmRouteResult = {
    loanInPoolId: null,
    docType: null,
    confidence: 0,
    reason: '',
    note: null,
  };

  // FAIL-SAFE — credit gate. No key/credits → skip the call entirely (no cost).
  if (!creditsAvailable()) return noop;

  // Nothing to read → nothing to classify (mirrors tier-3's '' guard).
  if (pageText.trim().length === 0 && fileName.trim().length === 0) return noop;

  const user = buildUserPrompt(fileName, pageText, poolLoans);

  let raw: string;
  try {
    raw = await llmCall({
      model: SMART_ROUTE_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      temperature: 0, // greedy — deterministic, replay-stable classification.
    });
  } catch {
    // FAIL-SAFE — LLM error / timeout / network → NO-OP → HELD.
    return noop;
  }

  const parsed = parseRaw(raw);
  if (parsed === null) return noop; // FAIL-SAFE — malformed output → HELD.

  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 400) : '';

  // ── GUARD 2 — MATCH-REAL-TARGETS ──────────────────────────────────────────
  // Loan: must be a member of the pool set, else discard→null.
  const poolIds = new Set(poolLoans.map((l) => l.loanInPoolId));
  let loanInPoolId: string | null =
    typeof parsed.loanInPoolId === 'string' && poolIds.has(parsed.loanInPoolId)
      ? parsed.loanInPoolId
      : null;
  // Doc-type: must be a real taxonomy id, else discard→null.
  let docType: string | null =
    typeof parsed.docType === 'string' && docTypeById(parsed.docType) !== undefined
      ? parsed.docType
      : null;

  // ── GUARD 1 — HOLD-WHEN-UNSURE ────────────────────────────────────────────
  // Below the confidence floor → discard BOTH axes (the model's confidence is a
  // whole-answer signal). A discarded axis stays null → the doc HELDs.
  if (confidence < CONFIDENCE_THRESHOLD) {
    loanInPoolId = null;
    docType = null;
  }

  // ── GUARD 3 — VISIBLE/REVERSIBLE ──────────────────────────────────────────
  // Provenance note ONLY when the tier actually filled an axis.
  const filled = loanInPoolId !== null || docType !== null;
  const note = filled
    ? `routed by AI (conf ${confidence.toFixed(2)}) — ${reason || 'no reason given'}`
    : null;

  return { loanInPoolId, docType, confidence, reason, note };
}
