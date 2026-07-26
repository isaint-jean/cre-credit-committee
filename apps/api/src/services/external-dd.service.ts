/**
 * external-dd.service — wires Brave web search → structured ExternalFinding →
 * the defamation guard. THIS LAYER ONLY: fetch, construct, guard. No memo
 * rendering, no score wiring, no caching (those are later layers).
 *
 * THE INVARIANT (load-bearing): Brave returns RAW SEARCH RESULTS — raw material,
 * not findings. Every result is either CONVERTED into a structured
 * ExternalFinding and run through computeRenderDecision, or DROPPED. There is no
 * path from a raw result to any output that bypasses the guard. The service
 * returns guard-decided findings + a transparent list of what was dropped and why.
 *
 * HONESTY IN CONSTRUCTION:
 *   - claimKind is DERIVED from the source domain (primary-record host → public_record;
 *     news host → reported_event; blog/unknown → allegation), and defaults DOWN when
 *     unsure — never guessed up.
 *   - sources are real (url + publisher + as-of), never fabricated; a result with no
 *     usable URL cannot become a corroborating source.
 *   - verificationTier is a conservative placeholder; the guard re-derives corroboration
 *     from the actual evidence (independent publishers / primary record) and ignores it.
 *   - FALSE-SUBJECT GUARD: an LLM classifies whether each result is actually about THIS
 *     subject (not a namesake) and whether it is adverse. Anything not clearly about the
 *     subject is DROPPED — a stranger's scandal is never attributed to this sponsor.
 */

import type {
  ExternalFinding,
  ExternalClaimKind,
  ExternalSource,
  ExternalSubjectType,
  ExternalRenderDecision,
  ExternalSentiment,
} from '@cre/contracts';
import { computeRenderDecision, renderExternalFinding } from '@cre/contracts';
import type { ResearchResult } from '@cre/shared';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { callAIWithContinuation } from './ai-analysis.service.js';
import { searchSponsor, braveSearch } from './research.service.js';

/* -------------------------- honest claimKind ----------------------------- */

// Primary-record hosts (recorded documents — the highest-verifiability kind).
const PRIMARY_RECORD_HOST =
  /(^|\.)gov(\.|$)|courts?\.|courtlistener|justia\.com\/(cases|dockets)|pacer|\.uscourts\.|county|assessor|recorder|\bclerk\b|sec\.gov/i;
// Recognized news publishers (reported events).
const NEWS_HOST =
  /(reuters|apnews|ap\.org|bloomberg|wsj|nytimes|ft\.com|forbes|cnbc|bisnow|therealdeal|globest|commercialobserver|law360|bizjournals|latimes|sandiegouniontribune|washingtonpost|theguardian|npr|marketwatch|costar)\./i;

/** Derive claimKind HONESTLY from the source domain, defaulting DOWN (allegation)
 *  when the host isn't a recognized primary record or news outlet. */
export function deriveClaimKind(hostname: string): ExternalClaimKind {
  const h = hostname.toLowerCase();
  if (PRIMARY_RECORD_HOST.test(h)) return 'public_record';
  if (NEWS_HOST.test(h)) return 'reported_event';
  return 'allegation';
}

/** Strongest claimKind across a merged finding's sources. */
function strongestKind(kinds: readonly ExternalClaimKind[]): ExternalClaimKind {
  if (kinds.includes('public_record')) return 'public_record';
  if (kinds.includes('reported_event')) return 'reported_event';
  return 'allegation';
}

/* ---------------------- real source from a result ------------------------ */

/** Convert a Brave result to a real ExternalSource, or null when it has no usable
 *  URL/publisher (an unusable result can never become a corroborating source). */
export function resultToSource(r: ResearchResult): ExternalSource | null {
  if (!r.url || r.url.trim().length === 0) return null;
  let publisher: string;
  try {
    publisher = new URL(r.url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (publisher.length === 0) return null;
  // Brave 'age' is a human string ("2 weeks ago") or absent — we never fabricate a
  // precise ISO date; the source's stated age is recorded verbatim, and the finding's
  // retrievedAt separately pins the fetch time.
  const asOfDate =
    r.publishedDate && r.publishedDate.trim().length > 0 ? r.publishedDate.trim() : 'date not stated';
  return { url: r.url, publisher, asOfDate };
}

/* ----------------------- LLM classification ------------------------------ */

/** One classified result. `aboutSubject` is the false-subject guard: only 'yes'
 *  survives; 'no'/'uncertain' are dropped. `reportedClaim` is reported speech. */
export interface ResultClassification {
  readonly index: number;
  readonly aboutSubject: 'yes' | 'no' | 'uncertain';
  readonly sentiment: ExternalSentiment;
  readonly reportedClaim: string; // reported speech; '' when not about the subject
  readonly claimGroup: string;    // slug of the underlying event, so independent sources about the SAME event merge
}

const CLASSIFY_SYSTEM =
  'You are a due-diligence analyst screening web search results for a credit committee. ' +
  'You NEVER assert anything as fact. Be conservative about identity: if you cannot confirm a ' +
  'result is about the SPECIFIC named subject (not a different entity or person with a similar ' +
  'name), mark it "uncertain". Phrase every claim as REPORTED SPEECH ("reported…", "a lawsuit ' +
  'alleges…"), never "X did Y". Output ONLY a JSON array, no prose.';

function buildClassifyPrompt(subject: string, subjectType: ExternalSubjectType, resultsBlock: string): string {
  const kind = subjectType === 'person' ? 'commercial-real-estate sponsor/borrower entity' : 'property / location';
  return `Subject (${subjectType}): "${subject}" — a ${kind}.

For EACH numbered result, return an object:
{ "index": <n>,
  "aboutSubject": "yes" | "no" | "uncertain",   // is this clearly about THIS specific subject, not a namesake?
  "sentiment": "negative" | "neutral" | "positive",  // adverse event/risk = negative
  "reportedClaim": "<one short REPORTED-SPEECH phrase, e.g. 'reported involvement in a 2019 loan-default lawsuit'; use \\"\\" if aboutSubject is not yes>",
  "claimGroup": "<short slug of the underlying event so multiple sources about the SAME event share it, e.g. '2019-loan-default'; '' if none>" }

Rules: default aboutSubject to "uncertain" unless the result clearly names the specific subject. reportedClaim must be reported speech, never a bare fact. Return ONLY the JSON array.

Results:
${resultsBlock}`;
}

type LlmFn = typeof callAIWithContinuation;

async function classifyResults(
  subject: string,
  subjectType: ExternalSubjectType,
  results: readonly ResearchResult[],
  llm: LlmFn,
): Promise<ResultClassification[]> {
  if (results.length === 0) return [];
  const block = results.map((r, i) => `${i}. ${r.title} — ${r.snippet} (source: ${r.source})`).join('\n');
  const out = await llm({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: buildClassifyPrompt(subject, subjectType, block) }],
    temperature: 0,
  });
  return parseClassifications(out, results.length);
}

/** Parse the LLM JSON conservatively: malformed entries or out-of-range indices are
 *  dropped; an entry that doesn't clearly say aboutSubject:'yes' is treated as
 *  'uncertain' (→ dropped downstream). Never throws. */
export function parseClassifications(raw: string, resultCount: number): ResultClassification[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ResultClassification[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const index = typeof o['index'] === 'number' ? o['index'] : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= resultCount) continue;
    const aboutSubject = o['aboutSubject'] === 'yes' ? 'yes' : o['aboutSubject'] === 'no' ? 'no' : 'uncertain';
    const sentiment: ExternalSentiment =
      o['sentiment'] === 'negative' ? 'negative' : o['sentiment'] === 'positive' ? 'positive' : 'neutral';
    const reportedClaim = typeof o['reportedClaim'] === 'string' ? o['reportedClaim'] : '';
    const claimGroup = typeof o['claimGroup'] === 'string' ? o['claimGroup'] : '';
    out.push({ index, aboutSubject, sentiment, reportedClaim, claimGroup });
  }
  return out;
}

/* ----------------------- finding construction ---------------------------- */

/**
 * Build ExternalFindings from a search's results + classifications. Applies the
 * false-subject guard (drops anything not clearly about the subject), drops
 * results with no usable source, and MERGES results sharing a claimGroup into one
 * finding with multiple independent sources (so genuine corroboration is
 * recognized). Every survivor is a structured finding — never a raw result.
 */
export function buildFindings(
  subject: string,
  subjectType: ExternalSubjectType,
  results: readonly ResearchResult[],
  classifications: readonly ResultClassification[],
  retrievedAt: string,
): { findings: ExternalFinding[]; dropped: DroppedResult[] } {
  const dropped: DroppedResult[] = [];
  interface Group { claim: string; sentiment: ExternalSentiment; sources: ExternalSource[]; kinds: ExternalClaimKind[]; }
  const groups = new Map<string, Group>();

  for (const c of classifications) {
    const r = results[c.index];
    if (r === undefined) continue;
    if (c.aboutSubject !== 'yes') {
      dropped.push({ subjectType, title: r.title, reason: `identity ${c.aboutSubject} (false-subject guard)` });
      continue;
    }
    if (c.reportedClaim.trim().length === 0) {
      dropped.push({ subjectType, title: r.title, reason: 'no reported claim' });
      continue;
    }
    const src = resultToSource(r);
    if (src === null) {
      dropped.push({ subjectType, title: r.title, reason: 'no usable source URL' });
      continue;
    }
    const key = (c.claimGroup.trim() || c.reportedClaim.trim()).toLowerCase();
    const g = groups.get(key) ?? { claim: c.reportedClaim.trim(), sentiment: c.sentiment, sources: [], kinds: [] };
    if (!g.sources.some((s) => s.url === src.url)) {
      g.sources.push(src);
      g.kinds.push(deriveClaimKind(src.publisher));
    }
    groups.set(key, g);
  }

  const findings: ExternalFinding[] = [];
  for (const g of groups.values()) {
    if (g.sources.length === 0) continue;
    findings.push({
      subjectType,
      subject,
      claim: g.claim,
      claimKind: strongestKind(g.kinds),
      verificationTier: 'external-unverified', // placeholder; the guard re-derives from evidence
      sentiment: g.sentiment,
      sources: g.sources,
      retrievedAt,
    });
  }
  return { findings, dropped };
}

export interface DroppedResult {
  readonly subjectType: ExternalSubjectType;
  readonly title: string;
  readonly reason: string;
}

/* ----------------------- guard + orchestrator ---------------------------- */

export interface GuardedFinding {
  readonly finding: ExternalFinding;
  readonly decision: ExternalRenderDecision;
  /** The ONLY sanctioned committee-facing text (null when blank; generic prompt when
   *  suppressed; caveated reported-speech when rendered). Not wired to the memo yet. */
  readonly rendered: string | null;
}

/** Run every finding through the defamation guard. The single choke point: nothing
 *  produces output except a guard-decided finding. */
export function guardFindings(findings: readonly ExternalFinding[]): GuardedFinding[] {
  return findings.map((finding) => {
    const r = renderExternalFinding(finding);
    return { finding, decision: r.decision, rendered: r.text };
  });
}

export interface ExternalDDInput {
  readonly sponsorName: string | null;
  readonly propertyAddress: string | null;
  readonly city: string | null;
  /** Frozen fetch timestamp — passed in, never wall-clock in the service (determinism). */
  readonly retrievedAt: string;
}

export interface ExternalDDDeps {
  readonly searchSponsor?: typeof searchSponsor;
  readonly braveSearch?: typeof braveSearch;
  readonly llm?: LlmFn;
}

export interface ExternalDDResult {
  readonly queries: string[];
  readonly guarded: GuardedFinding[];
  readonly dropped: DroppedResult[];
  readonly rawCounts: { sponsor: number; property: number };
}

/**
 * Fetch → construct → guard, end to end. Sponsor search → person findings;
 * property/foreclosure search → property_market findings. Returns guard-decided
 * findings + a transparent dropped list. No memo, no score, no cache.
 */
export async function runExternalDueDiligence(
  input: ExternalDDInput,
  deps: ExternalDDDeps = {},
): Promise<ExternalDDResult> {
  const doSponsor = deps.searchSponsor ?? searchSponsor;
  const doBrave = deps.braveSearch ?? braveSearch;
  const llm = deps.llm ?? callAIWithContinuation;

  const queries: string[] = [];
  const allFindings: ExternalFinding[] = [];
  const allDropped: DroppedResult[] = [];
  const rawCounts = { sponsor: 0, property: 0 };

  if (input.sponsorName && input.sponsorName.trim().length > 0) {
    const { results, searchQuery } = await doSponsor(input.sponsorName);
    queries.push(searchQuery);
    rawCounts.sponsor = results.length;
    const cls = await classifyResults(input.sponsorName, 'person', results, llm);
    const { findings, dropped } = buildFindings(input.sponsorName, 'person', results, cls, input.retrievedAt);
    allFindings.push(...findings);
    allDropped.push(...dropped);
  }

  if (input.propertyAddress && input.propertyAddress.trim().length > 0) {
    const city = input.city ?? '';
    const q = `foreclosure OR "notice of default" OR distressed OR REO near "${input.propertyAddress}" ${city}`.trim();
    const results = await doBrave(q);
    queries.push(q);
    rawCounts.property = results.length;
    const subject = `${input.propertyAddress}${city ? ', ' + city : ''}`;
    const cls = await classifyResults(subject, 'property_market', results, llm);
    const { findings, dropped } = buildFindings(subject, 'property_market', results, cls, input.retrievedAt);
    allFindings.push(...findings);
    allDropped.push(...dropped);
  }

  return { queries, guarded: guardFindings(allFindings), dropped: allDropped, rawCounts };
}
