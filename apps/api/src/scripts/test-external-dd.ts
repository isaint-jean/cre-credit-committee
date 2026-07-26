/**
 * Tests for the Brave → ExternalFinding → guard chain construction.
 *
 *   npm run test:external-dd
 *
 * Deterministic — synthetic ResearchResults + synthetic classifications (no live
 * Brave, no live LLM). Proves the construction invariants: every result becomes a
 * guarded finding or is dropped; false-subject drop; corroboration merge; honest
 * claimKind-from-domain; no-usable-source drop; and each render decision.
 */

import type { ResearchResult } from '@cre/shared';
import {
  deriveClaimKind,
  resultToSource,
  buildFindings,
  guardFindings,
  buildPersonQueries,
  buildPropertyDistressQueries,
  runExternalDueDiligence,
  buildExternalDDSnapshot,
  ddQueryHash,
  EXTERNAL_DD_ENGINE_VERSION,
  type ResultClassification,
  type DdFetchCache,
} from '../services/external-dd.service.js';
import { canonicalize } from '../util/canonical-json.js';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const RETRIEVED = '2026-07-26T00:00:00Z';
const R = (title: string, url: string, snippet = ''): ResearchResult => ({
  title, url, snippet, source: (() => { try { return new URL(url).hostname; } catch { return ''; } })(), riskSignal: 'neutral',
});
const C = (index: number, aboutSubject: ResultClassification['aboutSubject'], sentiment: ResultClassification['sentiment'], reportedClaim: string, claimGroup = ''): ResultClassification =>
  ({ index, aboutSubject, sentiment, reportedClaim, claimGroup });

/* ---- claimKind derived honestly from domain (default DOWN) --------------- */
console.log('claimKind from source domain:');
assertEqual(deriveClaimKind('www.courtlistener.com'), 'public_record', 'court records → public_record');
assertEqual(deriveClaimKind('sandiego.county.gov'), 'public_record', 'county .gov → public_record');
assertEqual(deriveClaimKind('reuters.com'), 'reported_event', 'reuters → reported_event');
assertEqual(deriveClaimKind('somerandomblog.wordpress.com'), 'allegation', 'unknown blog → allegation (default DOWN)');

/* ---- resultToSource: real or null --------------------------------------- */
console.log('resultToSource:');
assertEqual(resultToSource(R('t', '')), null, 'empty url → no source');
{
  const s = resultToSource(R('t', 'https://www.reuters.com/x'));
  assert(s !== null && s.publisher === 'reuters.com', 'valid url → publisher = hostname (www stripped)');
}

/* ---- FALSE-SUBJECT guard: namesake dropped, not attributed --------------- */
console.log('False-subject guard:');
{
  const results = [
    R('Sunroad Enterprises car dealership sued', 'https://news.example/car', 'a different Sunroad, an auto dealer'),
    R('Sunroad Holding Corporation loan default', 'https://reuters.com/a', 'the real estate sponsor'),
  ];
  const cls = [
    C(0, 'no', 'negative', ''),                                   // namesake — dropped
    C(1, 'yes', 'negative', 'reported involvement in a loan default', 'default-2020'),
  ];
  const { findings, dropped } = buildFindings('Sunroad Holding Corporation', 'person', results, cls, RETRIEVED);
  assertEqual(findings.length, 1, 'only the real-subject result becomes a finding');
  assert(!JSON.stringify(findings).includes('car dealership') && !JSON.stringify(findings).includes('auto dealer'), "the namesake's claim is NOT attributed to this sponsor");
  assert(dropped.some((d) => /identity no/.test(d.reason)), 'the namesake is recorded as dropped (identity no)');
  // an 'uncertain' identity is also dropped
  const u = buildFindings('X', 'person', [R('t', 'https://a.com/x')], [C(0, 'uncertain', 'negative', 'reported thing')], RETRIEVED);
  assertEqual(u.findings.length, 0, "identity 'uncertain' → dropped");
}

/* ---- single news person-negative → suppress_specific -------------------- */
console.log('Single news source, person + negative → suppress_specific:');
{
  const results = [R('Sponsor lawsuit', 'https://reuters.com/x', 'reported')];
  const g = guardFindings(buildFindings('Acme Sponsor', 'person', results, [C(0, 'yes', 'negative', 'reported tie to a fraud lawsuit', 'g1')], RETRIEVED).findings);
  assertEqual(g.length, 1, 'one finding built');
  assertEqual(g[0]!.decision, 'suppress_specific', 'one news source is not corroboration → suppressed');
  assert(!g[0]!.rendered!.includes('fraud'), 'the specific claim does NOT leak');
}

/* ---- corroboration merge (2 independent) → render ----------------------- */
console.log('Two independent sources, same claimGroup → merged + rendered:');
{
  const results = [
    R('Reuters: sponsor default', 'https://reuters.com/a', 'reported'),
    R('WSJ: sponsor default', 'https://wsj.com/b', 'reported'),
  ];
  const cls = [C(0, 'yes', 'negative', 'reported involvement in a 2020 loan default', 'default-2020'), C(1, 'yes', 'negative', 'reported involvement in a 2020 loan default', 'default-2020')];
  const built = buildFindings('Acme Sponsor', 'person', results, cls, RETRIEVED);
  assertEqual(built.findings.length, 1, 'two sources about the same event merge into ONE finding');
  assertEqual(built.findings[0]!.sources.length, 2, 'the finding carries both independent sources');
  const g = guardFindings(built.findings);
  assertEqual(g[0]!.decision, 'render', 'two independent sources = corroborated → render');
  assert(g[0]!.rendered!.includes('2020 loan default') && g[0]!.rendered!.includes('confirm'), 'renders the claim with a confirm caveat');
}

/* ---- public record → render --------------------------------------------- */
console.log('Primary public record → render:');
{
  const results = [R('Court judgment', 'https://www.courtlistener.com/docket/1', 'recorded judgment')];
  const g = guardFindings(buildFindings('Acme Sponsor', 'person', results, [C(0, 'yes', 'negative', 'a recorded court judgment for guaranty breach', 'judgment-1')], RETRIEVED).findings);
  assertEqual(g[0]!.finding.claimKind, 'public_record', 'court host → claimKind public_record');
  assertEqual(g[0]!.decision, 'render', 'a primary record renders');
}

/* ---- property_market → render freely ------------------------------------ */
console.log('property_market → render freely:');
{
  const results = [R('2 foreclosures near address', 'https://sandiego.county.gov/recs', 'county records')];
  const g = guardFindings(buildFindings('8620 Spectrum Center Blvd, San Diego', 'property_market', results, [C(0, 'yes', 'negative', 'two nearby foreclosures recorded in the past year', 'fc-1')], RETRIEVED).findings);
  assertEqual(g[0]!.decision, 'render', 'property_market renders (facts about places)');
  assert(g[0]!.rendered!.includes('foreclosures') && g[0]!.rendered!.includes('confirm'), 'renders with caveat');
}

/* ---- no usable source → dropped (never a sourceless finding) ------------- */
console.log('No usable source → dropped:');
{
  const built = buildFindings('Acme', 'person', [R('t', '')], [C(0, 'yes', 'negative', 'reported thing')], RETRIEVED);
  assertEqual(built.findings.length, 0, 'a result with no usable URL cannot become a finding');
  assert(built.dropped.some((d) => /no usable source/.test(d.reason)), 'recorded as dropped (no usable source)');
}

/* ---- INVARIANT: every result is a finding-source OR dropped ------------- */
console.log('Invariant — nothing leaks un-guarded:');
{
  const results = [
    R('real', 'https://reuters.com/a', ''),
    R('namesake', 'https://x.com/b', ''),
    R('nourl', '', ''),
  ];
  const cls = [C(0, 'yes', 'negative', 'reported x', 'g'), C(1, 'no', 'negative', ''), C(2, 'yes', 'negative', 'reported y')];
  const { findings, dropped } = buildFindings('Acme', 'person', results, cls, RETRIEVED);
  const sourcedUrls = new Set(findings.flatMap((f) => f.sources.map((s) => s.url)));
  const accountedFor = results.every((r) => sourcedUrls.has(r.url) || dropped.some((d) => d.title === r.title));
  assert(accountedFor, 'every raw result is either a guarded finding-source OR explicitly dropped');
}

/* ---- query builders (precision) ----------------------------------------- */
console.log('Query precision — person queries:');
{
  const qs = buildPersonQueries({ sponsorName: 'Sunroad Holding Corporation', borrowerName: 'Sunroad Centrum Office One Partners, LP', city: 'San Diego', state: 'CA' });
  assert(qs.some((q) => q.includes('San Diego') && q.includes('Sunroad Holding Corporation')), 'sponsor query is disambiguated with city/state');
  assert(qs.some((q) => q.includes('Sunroad Centrum Office One Partners, LP')), 'the borrower LP is searched (more distinctive than the holding co)');
  assert(new Set(qs).size === qs.length, 'queries are deduped');
}
console.log('Query precision — property-distress queries:');
{
  const qs = buildPropertyDistressQueries({ city: 'San Diego', submarket: 'Kearny Mesa', state: 'CA' });
  assert(qs.length > 0 && qs.some((q) => q.includes('Kearny Mesa')), 'uses the submarket (radius), not an exact address');
  assert(qs.every((q) => !q.includes('8620')), 'does NOT key on the exact street number (which returned 0)');
  assertEqual(buildPropertyDistressQueries({ city: null, submarket: null, state: null }).length, 0, 'no area → no query');
}

/* ---- HONEST NULL + identity unweakened by disambiguation (async) --------- */
// Wrapped in an async IIFE — the sync assertions above run first; these awaits
// follow (top-level await is unavailable in the CJS build).
void (async () => {
  console.log('Honest null + strict identity through the full pipe (injected deps):');
  {
    // A namesake result surfaces (a DIFFERENT Miami developer), even though the query
    // now carries city context. The classifier stub marks it identity:'no'.
    const stubBrave = async (_q: string): Promise<ResearchResult[]> =>
      [R('Rishi Kapoor fraud victims — Miami developer', 'https://news.example/kapoor', 'a different developer, not this sponsor')];
    const stubLlmNo = async (): Promise<string> =>
      JSON.stringify([{ index: 0, aboutSubject: 'no', sentiment: 'negative', reportedClaim: '', claimGroup: '' }]);
    const res = await runExternalDueDiligence(
      { sponsorName: 'Sunroad Holding Corporation', borrowerName: 'Sunroad Centrum Office One Partners, LP', propertyAddress: '8620 Spectrum Center Blvd', city: 'San Diego', state: 'CA', submarket: 'Kearny Mesa', assetType: 'office', retrievedAt: RETRIEVED },
      { braveSearch: stubBrave as never, llm: stubLlmNo as never },
    );
    assertEqual(res.status, 'no_findings_surfaced', 'namesake dropped → status is no_findings_surfaced (NOT clean)');
    assertEqual(res.guarded.length, 0, 'no findings surfaced');
    assert(res.dropped.some((dd) => /identity no/.test(dd.reason)), 'the namesake (even with city context) is dropped by the identity guard');
    assert(!JSON.stringify(res.guarded).includes('Rishi Kapoor'), "the stranger's scandal is NOT attributed to the sponsor (absent from guarded findings; it appears only in the transparent dropped list)");
    assert(res.queries.some((q) => q.includes('San Diego')) && res.queries.some((q) => q.includes('Kearny Mesa')), 'the tightened queries WERE issued (disambiguation happened) — yet identity stayed strict');
  }
  console.log('Honest null — real match surfaces → status findings:');
  {
    const stubBrave = async (q: string): Promise<ResearchResult[]> =>
      q.includes('Sunroad') ? [R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];
    const stubLlmYes = async (): Promise<string> =>
      JSON.stringify([{ index: 0, aboutSubject: 'yes', sentiment: 'negative', reportedClaim: 'a recorded court judgment', claimGroup: 'j1' }]);
    const res = await runExternalDueDiligence(
      { sponsorName: 'Sunroad Holding Corporation', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED },
      { braveSearch: stubBrave as never, llm: stubLlmYes as never },
    );
    assertEqual(res.status, 'findings', 'a real match → status findings');
    assertEqual(res.guarded[0]!.decision, 'render', 'the public record renders');
  }

  /* ---- FETCH CACHE: read-through, no second Brave call ------------------- */
  // An in-memory mirror of web_dd_fetch_cache (JCS key + version-scoped),
  // exactly the shape RecordGraphStore.getDdFetch/insertDdFetch present.
  function makeCache(): DdFetchCache & { rows: Map<string, { resultPayload: string; retrievedAt: string }> } {
    const rows = new Map<string, { resultPayload: string; retrievedAt: string }>();
    return {
      rows,
      getDdFetch({ queryHash, ddEngineVersion }) {
        return rows.get(`${queryHash}::${ddEngineVersion}`) ?? null;
      },
      insertDdFetch({ queryHash, ddEngineVersion, resultPayload, retrievedAt }) {
        const k = `${queryHash}::${ddEngineVersion}`;
        if (rows.has(k)) return { inserted: false }; // ON CONFLICT DO NOTHING
        rows.set(k, { resultPayload, retrievedAt });
        return { inserted: true };
      },
    };
  }

  console.log('Fetch cache — read-through avoids a second Brave call:');
  {
    const cache = makeCache();
    let braveCalls = 0;
    const countingBrave = async (q: string): Promise<ResearchResult[]> => {
      braveCalls++;
      return q.includes('Sunroad') ? [R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];
    };
    const stubYes = async (): Promise<string> =>
      JSON.stringify([{ index: 0, aboutSubject: 'yes', sentiment: 'negative', reportedClaim: 'a recorded court judgment', claimGroup: 'j1' }]);
    const input = { sponsorName: 'Sunroad Holding Corporation', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED };

    const run1 = await runExternalDueDiligence(input, { braveSearch: countingBrave as never, llm: stubYes as never, store: cache });
    const callsAfterRun1 = braveCalls;
    assert(callsAfterRun1 > 0, 'first run hits Brave (cache miss → fetch)');
    assertEqual(run1.cached.person, false, 'first run is not served from cache');

    const run2 = await runExternalDueDiligence(input, { braveSearch: countingBrave as never, llm: stubYes as never, store: cache });
    assertEqual(braveCalls, callsAfterRun1, 'second run makes ZERO additional Brave calls (served from cache)');
    assertEqual(run2.cached.person, true, 'second run is served from the fetch cache');
    assertEqual(run2.status, 'findings', 'cached raw still yields the same finding');
    assertEqual(run2.guarded[0]!.decision, run1.guarded[0]!.decision, 'render decision is identical across the cached re-run');
    assertEqual(JSON.stringify(run2.guarded), JSON.stringify(run1.guarded), 'guarded findings are byte-identical across the cached re-run');
  }

  console.log('Fetch cache — the RAW fetch is cached, not the verdict (guard re-runs fresh):');
  {
    // Same raw cached results, but a HARSHER guard on the re-run (llm now says the
    // claim is worse). The cache returns the identical raw; the fresh guard re-scores.
    const cache = makeCache();
    let braveCalls = 0;
    const brave = async (q: string): Promise<ResearchResult[]> => {
      braveCalls++;
      return q.includes('Sunroad') ? [R('Report on Sunroad Holding Corporation', 'https://somereportblog.wordpress.com/x', 'reported')] : [];
    };
    const input = { sponsorName: 'Sunroad Holding Corporation', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED };
    // Run 1: classifier says the item is about a namesake (dropped) — nothing surfaces.
    const llmNo = async (): Promise<string> => JSON.stringify([{ index: 0, aboutSubject: 'no', sentiment: 'negative', reportedClaim: '', claimGroup: '' }]);
    const run1 = await runExternalDueDiligence(input, { braveSearch: brave as never, llm: llmNo as never, store: cache });
    const callsAfterRun1 = braveCalls;
    assertEqual(run1.status, 'no_findings_surfaced', 'run 1: guard drops the namesake');
    // Run 2: SAME cached raw (0 new Brave), but classifier now confirms identity → surfaces.
    const llmYes = async (): Promise<string> => JSON.stringify([{ index: 0, aboutSubject: 'yes', sentiment: 'negative', reportedClaim: 'a reported concern', claimGroup: 'g1' }]);
    const run2 = await runExternalDueDiligence(input, { braveSearch: brave as never, llm: llmYes as never, store: cache });
    assertEqual(braveCalls, callsAfterRun1, 'run 2 fetched nothing new (raw served from cache)');
    assertEqual(run2.cached.person, true, 'run 2 raw came from the cache');
    assertEqual(run2.status, 'findings', 'yet the FRESH guard re-scored the cached raw and surfaced it (verdict not cached)');
  }

  console.log('Fetch cache — a later web change does NOT move the cached fetch (determinism):');
  {
    const cache = makeCache();
    const input = { sponsorName: 'Sunroad Holding Corporation', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED };
    const stubYes = async (): Promise<string> =>
      JSON.stringify([{ index: 0, aboutSubject: 'yes', sentiment: 'negative', reportedClaim: 'a recorded court judgment', claimGroup: 'j1' }]);
    const braveV1 = async (q: string): Promise<ResearchResult[]> =>
      q.includes('Sunroad') ? [R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];
    // A DIFFERENT web tomorrow — extra results, changed text. Must not leak past the cache.
    const braveV2 = async (q: string): Promise<ResearchResult[]> =>
      q.includes('Sunroad') ? [R('BRAND NEW allegation vs Sunroad', 'https://tabloid.example/z', 'new'), R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];
    const first = await runExternalDueDiligence(input, { braveSearch: braveV1 as never, llm: stubYes as never, store: cache });
    const later = await runExternalDueDiligence(input, { braveSearch: braveV2 as never, llm: stubYes as never, store: cache });
    assertEqual(later.cached.person, true, 'the later render is pinned to the cached fetch');
    assertEqual(later.rawCounts.person, first.rawCounts.person, 'the web change did NOT enlarge the pinned raw set');
    assertEqual(JSON.stringify(later.guarded), JSON.stringify(first.guarded), 'the minted finding is byte-identical despite the web changing');
    assertEqual(later.retrievedAt, RETRIEVED, 'retrievedAt stays pinned to the frozen fetch timestamp');
  }

  console.log('Fetch cache — the query hash is JCS-canonical + version-scoped:');
  {
    const h1 = ddQueryHash('Acme', 'person', ['b query', 'a query']);
    const h2 = ddQueryHash('Acme', 'person', ['b query', 'a query']);
    assertEqual(h1, h2, 'same inputs → same hash (deterministic)');
    assert(h1 !== ddQueryHash('Acme', 'person', ['a query', 'b query']), 'query ORDER is part of the key (union order is meaningful)');
    assert(h1 !== ddQueryHash('Acme', 'property_market', ['b query', 'a query']), 'subjectType is part of the key');
    assert(typeof EXTERNAL_DD_ENGINE_VERSION === 'string' && EXTERNAL_DD_ENGINE_VERSION.length > 0, 'engine version is present (key is version-scoped)');
  }

  console.log('At-mint snapshot — frozen DD is byte-identical across re-renders + web changes:');
  {
    const AS_OF = '2026-07-26T00:00:00.000Z';
    const cache = makeCache();
    const input = { sponsorName: 'Sunroad Holding Corporation', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED };
    const stubYes = async (): Promise<string> =>
      JSON.stringify([{ index: 0, aboutSubject: 'yes', sentiment: 'negative', reportedClaim: 'a recorded court judgment', claimGroup: 'j1' }]);
    const braveV1 = async (q: string): Promise<ResearchResult[]> =>
      q.includes('Sunroad') ? [R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];
    // Tomorrow's web: a brand-new tabloid item + the original. Must not leak past the cache.
    const braveV2 = async (q: string): Promise<ResearchResult[]> =>
      q.includes('Sunroad') ? [R('BRAND NEW allegation vs Sunroad', 'https://tabloid.example/z', 'new'), R('Court judgment vs Sunroad Holding Corporation', 'https://www.courtlistener.com/d/1', 'recorded')] : [];

    // Mint: run DD, freeze into a snapshot field pinned to the as-of date.
    const mintRun = await runExternalDueDiligence(input, { braveSearch: braveV1 as never, llm: stubYes as never, store: cache });
    const minted = buildExternalDDSnapshot(mintRun, AS_OF);
    const mintedBytes = canonicalize(minted as unknown as Record<string, unknown>);

    // Re-render #1: same everything → identical bytes (cache hit, 0 Brave).
    const rerun1 = await runExternalDueDiligence(input, { braveSearch: braveV1 as never, llm: stubYes as never, store: cache });
    const snap1 = buildExternalDDSnapshot(rerun1, AS_OF);
    assertEqual(canonicalize(snap1 as unknown as Record<string, unknown>), mintedBytes, 're-render with identical inputs → byte-identical frozen DD');

    // Re-render #2: the WEB CHANGED (braveV2), but the fetch is cached → the
    // minted finding does not move.
    const rerun2 = await runExternalDueDiligence(input, { braveSearch: braveV2 as never, llm: stubYes as never, store: cache });
    const snap2 = buildExternalDDSnapshot(rerun2, AS_OF);
    assertEqual(canonicalize(snap2 as unknown as Record<string, unknown>), mintedBytes, 'a later web change does NOT move the minted finding (frozen at mint)');

    assertEqual(minted.retrievedAt, RETRIEVED, 'snapshot retrievedAt is pinned to the frozen fetch timestamp');
    assertEqual(minted.analysisAsOfDate, AS_OF, 'snapshot analysisAsOfDate is pinned to the deal as-of date');
    assertEqual(minted.status, 'findings', 'snapshot preserves the honest status');
    assertEqual(minted.findings.length, 1, 'the single guard-approved finding is frozen');
    assertEqual(minted.findings[0]!.decision, 'render', 'the render decision is frozen verbatim');
  }

  console.log('At-mint snapshot — an honest null (searched, nothing surfaced) is frozen as such:');
  {
    const AS_OF = '2026-07-26T00:00:00.000Z';
    const brave = async (): Promise<ResearchResult[]> => [];
    const llm = async (): Promise<string> => JSON.stringify([]);
    const run = await runExternalDueDiligence(
      { sponsorName: 'Nobody Notable LLC', borrowerName: null, propertyAddress: null, city: 'San Diego', state: 'CA', submarket: null, assetType: 'office', retrievedAt: RETRIEVED },
      { braveSearch: brave as never, llm: llm as never },
    );
    const snap = buildExternalDDSnapshot(run, AS_OF);
    assertEqual(snap.status, 'no_findings_surfaced', 'the honest null is frozen (searched, nothing surfaced — NOT clean)');
    assertEqual(snap.findings.length, 0, 'no findings frozen');
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} external-dd: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
