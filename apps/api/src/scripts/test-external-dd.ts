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
  type ResultClassification,
} from '../services/external-dd.service.js';

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

console.log(`\n${failed === 0 ? '✓' : '✗'} external-dd: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
