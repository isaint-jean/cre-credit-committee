/**
 * Tests for the ExternalFinding honesty model + defamation guard.
 *
 *   npm run test:external-finding
 *
 * Proves the four render behaviors (suppress / public-record / corroborated /
 * property-market), the never-a-score-path guarantee, the unsourced→blank rule,
 * safety-against-mislabeled-tier, and determinism. Synthetic findings only — no
 * web, no live data.
 */

import { execSync } from 'node:child_process';
import {
  computeRenderDecision,
  renderExternalFinding,
  stripReportingPrefix,
  isEvidenceCorroborated,
  independentSourceCount,
  EXTERNAL_FINDING_SUPPRESSED_TEXT,
  type ExternalFinding,
} from '@cre/contracts';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const base = {
  subject: 'Acme Sponsor LLC',
  retrievedAt: '2026-07-26T00:00:00Z',
} as const;

/* ---- 1. person + unverified + negative (one blog) → suppress_specific ---- */
console.log('Rule 1 — person + negative + unverified → suppress the specific claim:');
{
  const f: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'reported association with a 2019 fraud settlement',
    claimKind: 'allegation',
    verificationTier: 'external-unverified',
    sentiment: 'negative',
    sources: [{ url: 'https://randomblog.example/post', publisher: 'RandomBlog', asOfDate: '2026-01-01T00:00:00Z' }],
  };
  const r = renderExternalFinding(f);
  assertEqual(computeRenderDecision(f), 'suppress_specific', 'decision is suppress_specific');
  assertEqual(r.text, EXTERNAL_FINDING_SUPPRESSED_TEXT, 'renders ONLY the generic diligence prompt');
  assert(!r.text!.includes('fraud'), 'the specific claim word ("fraud") does NOT appear in the output');
  assert(!r.text!.includes('2019'), 'the specific claim detail ("2019") does NOT appear');
  assert(!r.text!.includes('RandomBlog') && !r.text!.includes('randomblog'), 'the source is NOT named');
}

/* ---- 2. person + negative + public_record → render the specific claim ----- */
console.log('Rule 2a — person + negative + public_record → render WITH source+date+caveat:');
{
  const f: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'a recorded court judgment for breach of a loan guaranty',
    claimKind: 'public_record',
    verificationTier: 'external-unverified', // label doesn't matter — public_record is the primary-source bar
    sentiment: 'negative',
    sources: [{ url: 'https://courts.example/case/123', publisher: 'County Court Records', asOfDate: '2022-05-10T00:00:00Z' }],
  };
  const r = renderExternalFinding(f);
  assertEqual(computeRenderDecision(f), 'render', 'decision is render (primary public record)');
  assert(r.text!.includes('recorded court judgment'), 'the specific claim IS present');
  assert(r.text!.includes('County Court Records'), 'the source is named');
  assert(r.text!.includes('2022-05-10T00:00:00Z'), 'the as-of date is present');
  assert(r.text!.includes('confirm'), 'a confirm caveat is present (never a bare fact)');
}

/* ---- 3. person + negative + corroborated (3 independent sources) → render -- */
console.log('Rule 2b — person + negative + corroborated (≥2 independent) → render WITH caveat:');
{
  const f: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'reported involvement in a large 2020 loan default',
    claimKind: 'reported_event',
    verificationTier: 'external-corroborated',
    sentiment: 'negative',
    sources: [
      { url: 'https://reuters.example/a', publisher: 'Reuters', asOfDate: '2020-03-01T00:00:00Z' },
      { url: 'https://wsj.example/b', publisher: 'Wall Street Journal', asOfDate: '2020-03-02T00:00:00Z' },
      { url: 'https://bloomberg.example/c', publisher: 'Bloomberg', asOfDate: '2020-03-03T00:00:00Z' },
    ],
  };
  const r = renderExternalFinding(f);
  assertEqual(computeRenderDecision(f), 'render', 'decision is render (3 independent sources)');
  assert(r.text!.includes('2020 loan default'), 'the specific claim IS present');
  assert(r.text!.includes('confirm'), 'a confirm caveat is present');
}

/* ---- 4. property_market → render freely (still caveated) ------------------ */
console.log('Rule 3 — property_market → render freely (facts about places, low bar):');
{
  const f: ExternalFinding = {
    ...base,
    subject: '8620 Spectrum Center Blvd, San Diego, CA',
    subjectType: 'property_market',
    claim: 'two foreclosures recorded within a quarter-mile in the past 12 months',
    claimKind: 'public_record',
    verificationTier: 'external-corroborated',
    sentiment: 'negative',
    sources: [{ url: 'https://assessor.example/recs', publisher: 'County Assessor', asOfDate: '2026-06-01T00:00:00Z' }],
  };
  const r = renderExternalFinding(f);
  assertEqual(computeRenderDecision(f), 'render', 'decision is render (property_market, not a person)');
  assert(r.text!.includes('foreclosures'), 'the specific market fact IS present');
  assert(r.text!.includes('confirm'), 'a confirm caveat is present');
}

/* ---- 5. never a score path ------------------------------------------------ */
console.log('Rule 5 — NO score path (type-level + import-level guarantees):');
{
  // (a) the type exposes no numeric/boolean fact field the scorer could read.
  const sample: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'x',
    claimKind: 'allegation',
    verificationTier: 'external-unverified',
    sentiment: 'neutral',
    sources: [{ url: 'u', publisher: 'p', asOfDate: '2026-01-01T00:00:00Z' }],
  };
  const badTop = Object.entries(sample).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean');
  assertEqual(badTop.length, 0, 'ExternalFinding has NO numeric/boolean top-level field');
  const badSrc = sample.sources.flatMap((s) => Object.values(s)).filter((v) => typeof v === 'number' || typeof v === 'boolean');
  assertEqual(badSrc.length, 0, 'ExternalSource has NO numeric/boolean field');

  // (b) no doctrine-clean scorer file imports the finding module — it cannot reach
  // the score programmatically. (grep returns non-zero exit → || true → empty.)
  const hits = execSync(
    "grep -rl 'external-finding\\|ExternalFinding' apps/api/src/doctrine-clean 2>/dev/null || true",
    { cwd: process.cwd() + '/../..', encoding: 'utf8' },
  ).trim();
  assertEqual(hits, '', 'no file under doctrine-clean/ references ExternalFinding (scorer cannot import it)');
}

/* ---- 6. zero sources → blank --------------------------------------------- */
console.log('Rule 6 — unsourced finding → blank (nothing renders):');
{
  const f: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'an unsourced rumor',
    claimKind: 'allegation',
    verificationTier: 'external-unverified',
    sentiment: 'negative',
    sources: [],
  };
  assertEqual(computeRenderDecision(f), 'blank', 'decision is blank');
  assertEqual(renderExternalFinding(f).text, null, 'nothing renders (text is null)');
}

/* ---- 7. safety: mislabeled tier cannot bypass suppression ----------------- */
console.log('Safety — a mislabeled "external-corroborated" backed by one blog still suppresses:');
{
  const f: ExternalFinding = {
    ...base,
    subjectType: 'person',
    claim: 'reported tie to a fraud scheme',
    claimKind: 'allegation',
    verificationTier: 'external-corroborated', // MIS-LABELED: only one non-record source below
    sentiment: 'negative',
    sources: [{ url: 'https://oneblog.example', publisher: 'OneBlog', asOfDate: '2025-01-01T00:00:00Z' }],
  };
  assert(!isEvidenceCorroborated(f), 'guard does NOT trust the label — evidence is not corroborated');
  assertEqual(computeRenderDecision(f), 'suppress_specific', 'still suppressed (safe by construction)');
  assert(!renderExternalFinding(f).text!.includes('fraud'), 'the mislabeled specific claim does NOT leak');
}

/* ---- 8. independence counting + determinism ------------------------------ */
console.log('Independence + determinism:');
{
  const dupPublisher = [
    { url: 'https://a.example/1', publisher: 'Reuters', asOfDate: '2020-01-01T00:00:00Z' },
    { url: 'https://a.example/2', publisher: 'reuters', asOfDate: '2020-01-02T00:00:00Z' },
  ];
  assertEqual(independentSourceCount(dupPublisher), 1, 'two articles from the same publisher = 1 independent source');
  const f: ExternalFinding = {
    ...base, subjectType: 'person', claim: 'reported default', claimKind: 'reported_event',
    verificationTier: 'external-corroborated', sentiment: 'negative', sources: dupPublisher,
  };
  assertEqual(computeRenderDecision(f), 'suppress_specific', 'same-publisher pair is NOT corroboration → suppressed');
  // determinism: same finding → same decision, repeatedly.
  const d1 = computeRenderDecision(f), d2 = computeRenderDecision(f), d3 = computeRenderDecision(f);
  assert(d1 === d2 && d2 === d3, 'renderDecision is a pure function (same finding → same decision)');
}

/* ---- wording: strip the reporting-verb prefix so "indicates" reads cleanly -- */
console.log('Wording — leading "Reported that …" is stripped (no "indicates Reported that"):');
{
  assertEqual(stripReportingPrefix('Reported that a former executive was convicted'), 'A former executive was convicted', 'strips "Reported that " + recapitalizes');
  assertEqual(stripReportingPrefix('reported that x happened'), 'X happened', 'case-insensitive');
  assertEqual(stripReportingPrefix('Reports that a default occurred'), 'A default occurred', 'strips "Reports that "');
  assertEqual(stripReportingPrefix('It was reported that a lawsuit was filed'), 'A lawsuit was filed', 'strips "It was reported that "');
  assertEqual(stripReportingPrefix('a lawsuit alleges misconduct'), 'a lawsuit alleges misconduct', 'leaves other phrasings untouched');
  assertEqual(stripReportingPrefix(stripReportingPrefix('Reported that x')), 'X', 'idempotent');

  // End-to-end: a claim starting with "Reported that" renders without the collision.
  const f: ExternalFinding = {
    ...base,
    subjectType: 'property_market',
    claim: 'Reported that a former Vornado Realty Trust executive was found guilty of fraud',
    claimKind: 'public_record',
    verificationTier: 'external-corroborated',
    sentiment: 'negative',
    sources: [{ url: 'https://www.courtlistener.com/x', publisher: 'CourtListener', asOfDate: '2026-04-22T00:00:00Z' }],
  };
  const text = renderExternalFinding(f).text!;
  assert(!/indicates Reported that/i.test(text), 'the "indicates Reported that" collision is gone');
  assert(/indicates A former Vornado Realty Trust executive/.test(text), 'reads "indicates A former … executive …"');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} external-finding: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
