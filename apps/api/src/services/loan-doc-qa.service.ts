/**
 * Per-loan document Q&A (grounded, cited, refuse-when-absent). Reuses the proven
 * gatherer + LLM client + cite-or-discard honesty machinery:
 *   gatherDealDocTexts → excerptDoc (question keywords) → ONE grounded temperature-0
 *   call → CITE-OR-DISCARD (the quote must literally appear in the cited doc, else
 *   the answer is DISCARDED → not_stated). Fail-closed: no credits / LLM error /
 *   unparseable output → 'unavailable' (never a crash, never an ungrounded guess).
 *
 * READ-ONLY: no persistence. Deps are injectable so the cite-or-discard + refusal
 * logic is unit-testable without live credits (see data-room-qa-proof.ts).
 */
import { env } from '../config/env.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { callAIWithContinuation } from './ai-analysis.service.js';
import { gatherDealDocTexts, excerptDoc, normalizeWs, type DealDocText } from './exhaustive-field-sourcing.js';

export type QaStatus = 'answered' | 'not_stated' | 'unavailable';

export interface LoanQaResult {
  readonly status: QaStatus;
  readonly answer: string | null;
  readonly sourceDoc: string | null;
  readonly sourceQuote: string | null;
  /** True when some of the loan's docs had no extractable text (scans) — so a
   *  'not_stated' may reflect an unreadable scan rather than genuine absence. */
  readonly scannedOnly: boolean;
}

interface LlmOpts {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user'; content: string }>;
  temperature?: number;
}

export interface LoanQaDeps {
  gather?: (poolId: string, loanInPoolId: string) => Promise<DealDocText[]>;
  llm?: (opts: LlmOpts) => Promise<string>;
  creditsAvailable?: () => boolean;
}

const CONTEXT_BUDGET = 120_000; // chars across the whole bundle

const STOPWORDS = new Set([
  'what', 'which', 'when', 'where', 'whats', 'the', 'and', 'for', 'are', 'was', 'were', 'this',
  'that', 'these', 'those', 'does', 'how', 'much', 'many', 'with', 'from', 'have', 'has', 'its',
]);
function keywordsFromQuestion(q: string): string[] {
  return Array.from(
    new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOPWORDS.has(w))),
  ).slice(0, 12);
}

const SYSTEM = [
  'You answer questions EXCLUSIVELY from the provided deal documents.',
  'RULES:',
  '- Answer ONLY if the documents literally state the answer.',
  '- Copy a SHORT verbatim "sourceQuote" (exact substring, ONE line / <=200 chars) from the document',
  '  that states it, and put that document\'s file name in "docName".',
  '- If the answer is not stated in ANY provided document, return',
  '  { "found": false, "answer": null, "sourceQuote": null, "docName": null }.',
  '- NEVER infer, compute, or guess. No verbatim quote -> found=false.',
  'Respond with ONLY a JSON object: { "found": boolean, "answer": string|null, "sourceQuote": string|null, "docName": string|null }.',
].join('\n');

const EMPTY = (status: QaStatus, scannedOnly = false): LoanQaResult => ({
  status,
  answer: null,
  sourceDoc: null,
  sourceQuote: null,
  scannedOnly,
});

export async function answerLoanQuestion(
  args: { poolId: string; loanInPoolId: string; question: string },
  deps: LoanQaDeps = {},
): Promise<LoanQaResult> {
  const creditsAvailable = deps.creditsAvailable ?? (() => env.anthropicApiKey.trim().length > 0);
  const gather = deps.gather ?? gatherDealDocTexts;
  const llm = deps.llm ?? ((o: LlmOpts) => callAIWithContinuation(o as Parameters<typeof callAIWithContinuation>[0]));

  const q = (args.question ?? '').trim();
  if (q.length === 0) return EMPTY('not_stated');

  // Fail-closed: no credits → unavailable (never a crash, never a guess).
  if (!creditsAvailable()) return EMPTY('unavailable');

  const docs = await gather(args.poolId, args.loanInPoolId);
  const withText = docs.filter((d) => d.text && d.text.trim().length > 0);
  const scannedOnly = docs.length > 0 && withText.length < docs.length;
  if (withText.length === 0) return EMPTY('not_stated', docs.length > 0);

  // Grounded context — keyword-windowed per doc, capped to a budget.
  const keywords = keywordsFromQuestion(q);
  let used = 0;
  const parts: string[] = [];
  for (const d of withText) {
    if (used >= CONTEXT_BUDGET) break;
    const ex = excerptDoc(d.text, keywords);
    const slice = ex.text.slice(0, Math.max(0, CONTEXT_BUDGET - used));
    used += slice.length;
    parts.push(`=== ${d.fileName} (${d.docType}) ===\n${slice}`);
  }
  const userMsg = `DOCUMENTS:\n${parts.join('\n\n')}\n\nQUESTION: ${q}`;

  let raw: string;
  try {
    raw = await llm({ model: CLAUDE_MODEL, max_tokens: 1024, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: userMsg }] });
  } catch {
    return EMPTY('unavailable', scannedOnly); // LLM error → honest floor
  }

  const parsed = parseJson(raw);
  if (
    !parsed ||
    parsed.found !== true ||
    typeof parsed.answer !== 'string' ||
    typeof parsed.sourceQuote !== 'string' ||
    typeof parsed.docName !== 'string'
  ) {
    return EMPTY('not_stated', scannedOnly);
  }
  const answer = parsed.answer as string;
  const sourceQuote = parsed.sourceQuote as string;
  const docName = parsed.docName as string;

  // CITE-OR-DISCARD: the quote must LITERALLY appear in the cited doc's text.
  const citedDoc =
    withText.find((d) => d.fileName === docName) ??
    withText.find((d) => normalizeWs(d.fileName).includes(normalizeWs(docName)));
  const quoteVerified = !!citedDoc && normalizeWs(citedDoc.text).includes(normalizeWs(sourceQuote));
  if (!quoteVerified) return EMPTY('not_stated', scannedOnly); // unverifiable → discard

  return { status: 'answered', answer, sourceDoc: citedDoc!.fileName, sourceQuote, scannedOnly };
}

function parseJson(raw: string): { found?: unknown; answer?: unknown; sourceQuote?: unknown; docName?: unknown } | null {
  try {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s < 0 || e < s) return null;
    return JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
}
