/**
 * external-dd.service — wires Brave web search → structured ExternalFinding →
 * the defamation guard. THIS LAYER ONLY: fetch, construct, guard. No memo
 * rendering, no score wiring, no caching (those are later layers).
 *
 * THE INVARIANT (load-bearing): Brave returns RAW SEARCH RESULTS — raw material,
 * not findings. Every result is either CONVERTED into a structured
 * ExternalFinding and run through computeRenderDecision, or DROPPED. There is no
 * path from a raw result to any output that bypasses the guard.
 *
 * QUERY PRECISION vs IDENTITY (critical separation): the query builders enrich
 * the search with deal context (city/state, the borrower LP, submarket) so real
 * signal surfaces — but that disambiguation improves only what we SEARCH, never
 * how loosely we ACCEPT. The identity guard (the LLM classifier) stays STRICT:
 * a result must be clearly about the SPECIFIC named entity to survive; a
 * same-name/same-city stranger is still dropped. Proximity in a query is not
 * identity.
 *
 * HONESTY IN CONSTRUCTION:
 *   - claimKind is DERIVED from the source domain and defaults DOWN when unsure.
 *   - sources are real (url + publisher + as-of), never fabricated.
 *   - verificationTier is a placeholder; the guard re-derives corroboration from
 *     the actual evidence.
 *   - HONEST NULL: the result carries an explicit status — 'no_findings_surfaced'
 *     (searched, nothing survived) is DISTINCT from any "clean" claim. Searching
 *     and finding nothing is never a clean bill of health.
 */

import type {
  ExternalFinding,
  ExternalClaimKind,
  ExternalSource,
  ExternalSubjectType,
  ExternalRenderDecision,
  ExternalSentiment,
  SnapshotExternalDD,
} from '@cre/contracts';
import { renderExternalFinding } from '@cre/contracts';
import type { ResearchResult } from '@cre/shared';
import { createHash } from 'node:crypto';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { callAIWithContinuation } from './ai-analysis.service.js';
import { braveSearch } from './research.service.js';
import { canonicalize } from '../util/canonical-json.js';

/**
 * External-DD engine version — scopes the fetch cache + the at-mint snapshot.
 * Bump when the query-builder or fetch semantics change so a stale cache row
 * doesn't serve results from an older query set (mirrors model_version in
 * llm_principle_eval_cache).
 */
export const EXTERNAL_DD_ENGINE_VERSION = '1.0' as const;

/** The fetch-cache surface the orchestrator needs (a RecordGraphStore subset). */
export interface DdFetchCache {
  getDdFetch(args: { queryHash: string; ddEngineVersion: string }): { readonly resultPayload: string; readonly retrievedAt: string } | null;
  insertDdFetch(args: { queryHash: string; ddEngineVersion: string; resultPayload: string; retrievedAt: string }): { inserted: boolean };
}

/**
 * Content-hash key for a DD fetch — SHA-256 of the JCS-canonicalized input
 * context (subject + subjectType + the exact query set + engine version).
 * Same subject + same queries + same engine → same key → cache hit → no Brave
 * call. Mirrors computeContextHash for llm_principle_eval_cache.
 */
export function ddQueryHash(subject: string, subjectType: ExternalSubjectType, queries: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalize({ subject, subjectType, queries, ddEngineVersion: EXTERNAL_DD_ENGINE_VERSION }), 'utf8')
    .digest('hex');
}

/* -------------------------- honest claimKind ----------------------------- */

const PRIMARY_RECORD_HOST =
  /(^|\.)gov(\.|$)|courts?\.|courtlistener|justia\.com\/(cases|dockets)|pacer|\.uscourts\.|county|assessor|recorder|\bclerk\b|sec\.gov/i;
const NEWS_HOST =
  /(reuters|apnews|ap\.org|bloomberg|wsj|nytimes|ft\.com|forbes|cnbc|bisnow|therealdeal|globest|commercialobserver|law360|bizjournals|latimes|sandiegouniontribune|washingtonpost|theguardian|npr|marketwatch|costar|trepp)\./i;

/** Derive claimKind HONESTLY from the source domain, defaulting DOWN (allegation). */
export function deriveClaimKind(hostname: string): ExternalClaimKind {
  const h = hostname.toLowerCase();
  if (PRIMARY_RECORD_HOST.test(h)) return 'public_record';
  if (NEWS_HOST.test(h)) return 'reported_event';
  return 'allegation';
}

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
  const asOfDate =
    r.publishedDate && r.publishedDate.trim().length > 0 ? r.publishedDate.trim() : 'date not stated';
  return { url: r.url, publisher, asOfDate };
}

/* ---------------------- query builders (precision) ----------------------- */

function dedupeStrings(xs: readonly string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter((x) => x.length > 0))];
}

/**
 * Targeted, disambiguated person queries. Enriches the bare entity name with deal
 * context already in the graph (city/state) and — crucially — tries the borrower
 * LP as well as the sponsor holding-co, because the borrower LP name is usually
 * more distinctive than a generic holding-company name. Union + dedupe happen in
 * the orchestrator. This improves what we SEARCH; the classifier still decides
 * what we ACCEPT.
 */
export function buildPersonQueries(input: {
  sponsorName: string | null;
  borrowerName: string | null;
  city: string | null;
  state: string | null;
}): string[] {
  const loc = [input.city, input.state].filter(Boolean).join(' ');
  const adverse = 'lawsuit OR bankruptcy OR fraud OR default OR litigation OR investigation';
  const qs: string[] = [];
  if (input.sponsorName) {
    qs.push(`"${input.sponsorName}" ${loc} real estate ${adverse}`);
    qs.push(`"${input.sponsorName}" real estate developer ${adverse}`);
  }
  if (input.borrowerName) {
    qs.push(`"${input.borrowerName}" ${adverse}`);
  }
  return dedupeStrings(qs);
}

/**
 * Adverse-signal queries for a SINGLE principal (per-principal search — a JV's
 * Vornado and Crown are searched separately so a finding attaches to the right
 * one). Mirrors buildPersonQueries but for one named party + its role.
 */
export function buildPrincipalQueries(
  name: string,
  role: 'sponsor' | 'borrower',
  city: string | null,
  state: string | null,
): string[] {
  if (!name || name.trim().length === 0) return [];
  const loc = [city, state].filter(Boolean).join(' ');
  const adverse = 'lawsuit OR bankruptcy OR fraud OR default OR litigation OR investigation';
  if (role === 'borrower') {
    // The borrowing SPV is bankruptcy-remote / low-signal — a single entity query.
    return dedupeStrings([`"${name}" ${adverse}`]);
  }
  return dedupeStrings([
    `"${name}" ${loc} real estate ${adverse}`,
    `"${name}" real estate developer ${adverse}`,
  ]);
}

/**
 * STRICT identity for a SINGLE principal handed to the classifier. Names ONLY
 * this principal — so a result about a DIFFERENT party to the same deal (the
 * other JV partner, the lender, a tenant) classifies as NOT the subject and is
 * dropped. This is what prevents cross-attribution (a Crown result never
 * attaches to Vornado, and vice versa).
 */
function buildPrincipalIdentity(
  name: string,
  role: 'sponsor' | 'borrower',
  input: Pick<ExternalDDInput, 'city' | 'state' | 'assetType'>,
): string {
  const ctx = [input.city, input.state].filter(Boolean).join(', ');
  const asset = input.assetType ? ` ${input.assetType}` : '';
  const roleDesc = role === 'sponsor'
    ? 'a sponsor / principal behind the borrower on'
    : 'the borrowing entity for';
  return `"${name}" — ${roleDesc} a${asset} commercial real-estate loan${ctx ? ` on a property in ${ctx}` : ''}. `
    + `The subject is SPECIFICALLY "${name}". A different company or person with a similar name is NOT the subject, `
    + `and neither is a DIFFERENT party to the same deal (another sponsor/JV partner, the lender, a tenant, a broker) — `
    + `only results about "${name}" itself are the subject.`;
}

/**
 * Neighborhood/radius property-distress queries. The prior address-exact +
 * "foreclosure" query returned nothing; this keys on the submarket/city instead.
 * These become subjectType 'property_market' (facts about a place — renders
 * freely, low reputational risk).
 */
export function buildPropertyDistressQueries(input: {
  city: string | null;
  submarket: string | null;
  state: string | null;
}): string[] {
  const area = input.submarket ?? input.city;
  if (!area) return [];
  const areaLoc = [area, input.state].filter(Boolean).join(' ');
  const cityLoc = [input.city, input.state].filter(Boolean).join(' ');
  return dedupeStrings([
    `"${areaLoc}" commercial real estate foreclosure OR distressed OR "special servicing" OR delinquent`,
    `"${cityLoc}" office CMBS "special servicing" OR delinquent OR foreclosure`,
  ]);
}

/* ----------------------- LLM classification ------------------------------ */

export interface ResultClassification {
  readonly index: number;
  readonly aboutSubject: 'yes' | 'no' | 'uncertain';
  readonly sentiment: ExternalSentiment;
  readonly reportedClaim: string;
  readonly claimGroup: string;
}

const CLASSIFY_SYSTEM =
  'You are a due-diligence analyst screening web search results for a credit committee. ' +
  'You NEVER assert anything as fact. IDENTITY IS STRICT: mark a result "yes" ONLY if it is clearly ' +
  'about the SPECIFIC named entity (or one of the specific entities) described. A different company ' +
  'or person that merely shares a name, city, or industry is "no". The subject description may include ' +
  'location or deal context to help you understand WHO the subject is; that context is for your ' +
  'understanding only and NEVER lowers the identity bar — proximity in the search terms is not ' +
  'identity. If you cannot confirm the specific entity, use "uncertain". Phrase every claim as REPORTED ' +
  'SPEECH ("reported…", "a lawsuit alleges…"), never "X did Y". Output ONLY a JSON array, no prose.';

function buildClassifyPrompt(identity: string, subjectType: ExternalSubjectType, resultsBlock: string): string {
  return `Subject (${subjectType}): ${identity}

For EACH numbered result, return an object:
{ "index": <n>,
  "aboutSubject": "yes" | "no" | "uncertain",   // clearly about the SPECIFIC entity above, not a namesake / same-city stranger?
  "sentiment": "negative" | "neutral" | "positive",
  "reportedClaim": "<one short REPORTED-SPEECH phrase; use \\"\\" if aboutSubject is not yes>",
  "claimGroup": "<short slug of the underlying event so multiple sources about the SAME event share it; '' if none>" }

Rules: default aboutSubject to "uncertain" unless the result clearly names the specific entity. Location/context in the subject description does NOT make a loose match acceptable. reportedClaim must be reported speech, never a bare fact. Return ONLY the JSON array.

Results:
${resultsBlock}`;
}

type LlmFn = typeof callAIWithContinuation;

export async function classifyResults(
  identity: string,
  subjectType: ExternalSubjectType,
  results: readonly ResearchResult[],
  llm: LlmFn = callAIWithContinuation,
): Promise<ResultClassification[]> {
  if (results.length === 0) return [];
  const block = results.map((r, i) => `${i}. ${r.title} — ${r.snippet} (source: ${r.source})`).join('\n');
  const out = await llm({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: buildClassifyPrompt(identity, subjectType, block) }],
    temperature: 0,
  });
  return parseClassifications(out, results.length);
}

/** Parse the LLM JSON conservatively. Never throws; anything not clearly
 *  aboutSubject:'yes' becomes 'uncertain' (→ dropped downstream). */
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

export interface DroppedResult {
  readonly subjectType: ExternalSubjectType;
  readonly title: string;
  readonly reason: string;
}

/**
 * Build ExternalFindings from a search's results + classifications. Applies the
 * false-subject guard (drops namesakes and no-source results) and MERGES results
 * sharing a claimGroup into one finding with multiple independent sources. Every
 * survivor is a structured finding — never a raw result.
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
      verificationTier: 'external-unverified',
      sentiment: g.sentiment,
      sources: g.sources,
      retrievedAt,
    });
  }
  return { findings, dropped };
}

/* ----------------------- guard + orchestrator ---------------------------- */

export interface GuardedFinding {
  readonly finding: ExternalFinding;
  readonly decision: ExternalRenderDecision;
  readonly rendered: string | null;
}

/** Run every finding through the defamation guard — the single choke point. */
export function guardFindings(findings: readonly ExternalFinding[]): GuardedFinding[] {
  return findings.map((finding) => {
    const r = renderExternalFinding(finding);
    return { finding, decision: r.decision, rendered: r.text };
  });
}

export interface ExternalDDInput {
  /**
   * Back-compat single sponsor (identity context / display). The AUTHORITATIVE
   * search list is `sponsors`; the person lane searches EACH principal in that
   * list independently. When `sponsors` is empty, `sponsorName` (if set) is
   * treated as a one-element list (single-sponsor deals).
   */
  readonly sponsorName: string | null;
  /**
   * ★ The sponsor PRINCIPALS to search — a JV names several (Vornado + Crown),
   * a single-sponsor deal names one. Each is searched + guarded INDEPENDENTLY so
   * a finding is attributed to the correct principal. Optional: absent/empty →
   * the lane falls back to the single `sponsorName` (back-compat).
   */
  readonly sponsors?: readonly string[];
  readonly borrowerName: string | null;
  readonly propertyAddress: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly submarket: string | null;
  readonly assetType: string | null;
  /** Frozen fetch timestamp — passed in, never wall-clock in the service. */
  readonly retrievedAt: string;
}

export interface ExternalDDDeps {
  readonly braveSearch?: typeof braveSearch;
  readonly llm?: LlmFn;
  /**
   * Fetch cache (read-through). When present, the raw Brave results for a query
   * set are cached by content-hash — a repeat run with the same subject +
   * queries returns the cached raw with NO Brave call. The GUARD still runs
   * fresh over the cached raw (we cache the FETCH, not the verdict).
   */
  readonly store?: DdFetchCache;
}

export interface ExternalDDResult {
  /**
   * HONEST NULL. 'findings' = at least one guard-decided finding surfaced (render
   * OR suppress_specific — a real signal exists, even if the specific claim is
   * suppressed). 'no_findings_surfaced' = we searched and nothing survived. The
   * render layer MUST present the latter as "searched, nothing surfaced", NEVER as
   * "clean" / "no issues".
   */
  readonly status: 'findings' | 'no_findings_surfaced';
  readonly queries: string[];
  readonly guarded: GuardedFinding[];
  readonly dropped: DroppedResult[];
  readonly rawCounts: { person: number; property: number };
  /** Whether each search was served from the fetch cache (no Brave call). */
  readonly cached: { person: boolean; property: boolean };
  /** The frozen fetch timestamp the findings are pinned to. */
  readonly retrievedAt: string;
  /**
   * The FIRST §4 subject searched, or `null` when the person lane could NOT run.
   * Back-compat single; the authoritative list is `personSubjects`.
   */
  readonly personSubject: string | null;
  /**
   * ★ Each §4 principal actually searched, independently. Empty when the person
   * lane could not run (no principals). Findings carry `subject === principal`.
   */
  readonly personSubjects: readonly string[];
  /**
   * The §6 subject actually searched (property market/area), or `null` when no
   * address/market was available and the market lane could NOT run.
   */
  readonly marketSubject: string | null;
}

async function unionSearch(queries: readonly string[], doBrave: typeof braveSearch): Promise<ResearchResult[]> {
  const seen = new Set<string>();
  const out: ResearchResult[] = [];
  for (const q of queries) {
    const rs = await doBrave(q);
    for (const r of rs) {
      if (r.url && r.url.length > 0 && !seen.has(r.url)) {
        seen.add(r.url);
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * Read-through fetch cache. On a hit, returns the cached RAW results with NO
 * Brave call (reproducible + cheap). On a miss, fetches, writes ON CONFLICT DO
 * NOTHING, returns. The guard is NOT cached — the caller re-runs it fresh over
 * whatever raw comes back.
 */
async function cachedUnionSearch(
  subject: string,
  subjectType: ExternalSubjectType,
  queries: readonly string[],
  doBrave: typeof braveSearch,
  store: DdFetchCache | undefined,
  retrievedAt: string,
): Promise<{ results: ResearchResult[]; fromCache: boolean }> {
  if (store !== undefined) {
    const key = ddQueryHash(subject, subjectType, queries);
    const hit = store.getDdFetch({ queryHash: key, ddEngineVersion: EXTERNAL_DD_ENGINE_VERSION });
    if (hit !== null) {
      try {
        const results = JSON.parse(hit.resultPayload) as ResearchResult[];
        return { results, fromCache: true };
      } catch {
        /* corrupt cache row — fall through to a fresh fetch */
      }
    }
    const results = await unionSearch(queries, doBrave);
    store.insertDdFetch({ queryHash: key, ddEngineVersion: EXTERNAL_DD_ENGINE_VERSION, resultPayload: JSON.stringify(results), retrievedAt });
    return { results, fromCache: false };
  }
  return { results: await unionSearch(queries, doBrave), fromCache: false };
}

/**
 * Fetch → construct → guard, end to end. Person (sponsor + borrower) queries and
 * property-distress queries, unioned + deduped, classified against a strict
 * identity, built into findings, guarded. Returns guard-decided findings, a
 * transparent dropped list, and an honest-null status. No memo, no score, no cache.
 */
export async function runExternalDueDiligence(
  input: ExternalDDInput,
  deps: ExternalDDDeps = {},
): Promise<ExternalDDResult> {
  const doBrave = deps.braveSearch ?? braveSearch;
  const llm = deps.llm ?? callAIWithContinuation;

  const queries: string[] = [];
  const allFindings: ExternalFinding[] = [];
  const allDropped: DroppedResult[] = [];
  const rawCounts = { person: 0, property: 0 };
  const cached = { person: false, property: false };
  // The subject actually searched per lane, or null when the lane had no key
  // (could-not-search). Load-bearing for §4/§6's (searched-empty vs could-not-
  // search) distinction — set ONLY when that lane's queries were non-empty.
  let personSubject: string | null = null;
  let marketSubject: string | null = null;

  // ★ PER-PRINCIPAL PERSON LANE. The sponsor principals (a JV names several) +
  // the borrower entity are each searched + classified + built INDEPENDENTLY, so
  // a finding attaches to the correct principal and the identity guard refuses
  // cross-attribution (a Crown result never attaches to Vornado). Back-compat:
  // when `sponsors` is empty, fall back to the single `sponsorName`.
  const sponsorPrincipals = (input.sponsors && input.sponsors.length > 0)
    ? input.sponsors
    : (input.sponsorName ? [input.sponsorName] : []);
  const principals: Array<{ name: string; role: 'sponsor' | 'borrower' }> = [
    ...sponsorPrincipals.map((name) => ({ name, role: 'sponsor' as const })),
    ...(input.borrowerName ? [{ name: input.borrowerName, role: 'borrower' as const }] : []),
  ];
  const personSubjects: string[] = [];
  const seenPrincipals = new Set<string>();
  let personCachedAll = true;
  for (const principal of principals) {
    const key = principal.name.trim().toLowerCase();
    if (key.length === 0 || seenPrincipals.has(key)) continue;
    const pQueries = buildPrincipalQueries(principal.name, principal.role, input.city, input.state);
    if (pQueries.length === 0) continue;
    seenPrincipals.add(key);
    personSubjects.push(principal.name);
    const { results, fromCache } = await cachedUnionSearch(principal.name, 'person', pQueries, doBrave, deps.store, input.retrievedAt);
    queries.push(...pQueries);
    rawCounts.person += results.length;
    personCachedAll = personCachedAll && fromCache;
    const identity = buildPrincipalIdentity(principal.name, principal.role, input);
    const cls = await classifyResults(identity, 'person', results, llm);
    const { findings, dropped } = buildFindings(principal.name, 'person', results, cls, input.retrievedAt);
    allFindings.push(...findings);
    allDropped.push(...dropped);
  }
  if (personSubjects.length > 0) {
    personSubject = personSubjects[0]!;
    cached.person = personCachedAll;
  }

  const propQueries = buildPropertyDistressQueries(input);
  if (propQueries.length > 0) {
    const area = [input.submarket ?? input.city, input.state].filter(Boolean).join(', ');
    const subject = area.length > 0 ? area : (input.propertyAddress ?? 'the property submarket');
    marketSubject = subject;
    const { results, fromCache } = await cachedUnionSearch(subject, 'property_market', propQueries, doBrave, deps.store, input.retrievedAt);
    queries.push(...propQueries);
    rawCounts.property = results.length;
    cached.property = fromCache;
    const identity = `the submarket/area "${subject}"${input.propertyAddress ? ` around ${input.propertyAddress}` : ''} — commercial-real-estate distress in THIS market; results about other markets are not the subject.`;
    const cls = await classifyResults(identity, 'property_market', results, llm);
    const { findings, dropped } = buildFindings(subject, 'property_market', results, cls, input.retrievedAt);
    allFindings.push(...findings);
    allDropped.push(...dropped);
  }

  const guarded = guardFindings(allFindings);
  const status: ExternalDDResult['status'] = guarded.length > 0 ? 'findings' : 'no_findings_surfaced';
  return { status, queries, guarded, dropped: allDropped, rawCounts, cached, retrievedAt: input.retrievedAt, personSubject, personSubjects, marketSubject };
}

/* ----------------------- at-mint snapshot producer ----------------------- */

/**
 * Freeze a DD run into the render-snapshot's `externalDD` field (v1.2+). Pure +
 * deterministic — maps the guard-approved findings verbatim (finding + decision
 * + rendered) and pins the frozen fetch timestamp + the deal's as-of date.
 *
 * Determinism (the point of this layer): the SAME `ExternalDDResult` + as-of
 * date always produces a byte-identical `SnapshotExternalDD`, so the rendered DD
 * is reproducible across re-renders and a later change to the live web cannot
 * move a minted finding. `status` is preserved verbatim — `no_findings_surfaced`
 * is an honest null (searched, nothing surfaced), never a clean bill of health.
 *
 * The `retrievedAt` comes from the RESULT (the frozen fetch timestamp the
 * findings were built over — matches the fetch-cache row), not from wall-clock.
 */
export function buildExternalDDSnapshot(
  result: Pick<ExternalDDResult, 'status' | 'guarded' | 'retrievedAt' | 'personSubject' | 'personSubjects' | 'marketSubject'>,
  analysisAsOfDate: string,
): SnapshotExternalDD {
  return {
    status: result.status,
    findings: result.guarded.map((g) => ({
      finding: g.finding,
      decision: g.decision,
      rendered: g.rendered,
    })),
    retrievedAt: result.retrievedAt as SnapshotExternalDD['retrievedAt'],
    analysisAsOfDate: analysisAsOfDate as SnapshotExternalDD['analysisAsOfDate'],
    personSubject: result.personSubject,
    personSubjects: result.personSubjects,
    marketSubject: result.marketSubject,
  };
}
