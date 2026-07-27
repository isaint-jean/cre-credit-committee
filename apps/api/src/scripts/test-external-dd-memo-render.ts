/**
 * Tests for the §4 Sponsor / §6 Market external-DD render block.
 *
 *   npm run test:external-dd-memo-render
 *
 * Deterministic — synthetic SnapshotExternalDD inputs (no live web). Proves the
 * THREE HONEST STATES the memo must keep distinct and NEVER collapse:
 *   (a) FINDINGS          — guard-approved rendered strings appear, sourced+caveated.
 *   (b) SEARCHED-EMPTY    — "searched, nothing specific surfaced" — NOT "clean".
 *   (c) COULD-NOT-SEARCH  — lane subject null → NO DD block (the section's
 *                           existing honest-blank stands alone).
 * Plus: per-lane subjectType filtering (person→§4, property_market→§6), dedupe of
 * the generic suppressed line, honest-null wording, and NO engine-code leak.
 *
 * The guard is NOT re-run here — this renders the guard's already-frozen output.
 */

import { externalDDBlock } from '../services/render-memo/build-committee-memo.js';
import type { SnapshotExternalDD, ExternalFinding, ExternalRenderDecision } from '@cre/contracts';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }

const AS_OF = '2026-07-26T00:00:00.000Z';

// A guard-decided finding: the `rendered` string is what the guard already produced.
function finding(
  subjectType: 'person' | 'property_market',
  decision: ExternalRenderDecision,
  rendered: string | null,
  claim = 'a reported concern',
): { finding: ExternalFinding; decision: ExternalRenderDecision; rendered: string | null } {
  return {
    finding: {
      subjectType, subject: subjectType === 'person' ? 'Acme Sponsor' : 'Downtown, TX',
      claim, claimKind: 'reported_event', verificationTier: 'external-unverified',
      sentiment: 'negative', sources: [{ url: 'https://x.example/a', publisher: 'Example News', asOfDate: '2026-01-01T00:00:00Z' as never }],
      retrievedAt: AS_OF as never,
    },
    decision, rendered,
  };
}

function dd(partial: Partial<SnapshotExternalDD>): SnapshotExternalDD {
  return {
    status: 'no_findings_surfaced', findings: [], retrievedAt: AS_OF as never,
    analysisAsOfDate: AS_OF as never, personSubject: null, marketSubject: null,
    ...partial,
  };
}

/* ---- (c) COULD-NOT-SEARCH: lane subject null → empty block ---------------- */
console.log('State (c) could-not-search — lane subject null → no DD block:');
{
  // externalDD absent entirely
  assert(externalDDBlock(undefined, 'person', 'the sponsor') === '', 'externalDD absent → empty (§4 keeps its honest-blank)');
  // person lane null (640 shape: no sponsor name), market lane searched
  const snap = dd({ personSubject: null, marketSubject: 'Austin, TX', status: 'no_findings_surfaced' });
  assert(externalDDBlock(snap, 'person', 'the sponsor') === '', '§4 personSubject null → empty block (could-not-search)');
  assert(externalDDBlock(snap, 'property_market', 'the property’s market') !== '', '§6 marketSubject present → NON-empty block (it DID search)');
}

/* ---- (b) SEARCHED-EMPTY: subject present, no findings → honest null ------- */
console.log('State (b) searched-empty — honest null, NOT clean (tightened wording):');
{
  const snap = dd({ personSubject: 'Acme Sponsor', status: 'no_findings_surfaced', findings: [] });
  const html = externalDDBlock(snap, 'person', 'the sponsor');
  assert(html !== '', 'searched-empty → a DD block IS rendered (distinct from could-not-search)');
  assert(/surfaced nothing specific on the sponsor/.test(html), 'renders the tightened "surfaced nothing specific on the sponsor" null');
  assert(/as of 2026-07-26/.test(html), 'pins the as-of date');
  // Load-bearing honesty half — must survive the tightening.
  assert(/this is not an affirmative finding that the sponsor is clean/.test(html), 'explicitly says this is NOT a clean finding (absence ≠ clean)');
  assert(!/no issues|all clear|nothing adverse|reputable/i.test(html), 'never asserts the sponsor is clean/without issues');
  // One sentence — the old over-explained second sentence is gone.
  assert(!/This reflects a search that returned nothing specific/.test(html), 'the old two-sentence over-explanation is gone (one memo-tight sentence)');
  const sentences = html.replace(/<[^>]+>/g, ' ').replace(/External diligence\./, '').split('.').filter(s => s.trim().length > 3);
  assert(sentences.length === 1, 'the null is a single sentence');
  // CHANGE 2 — sponsor lane carries the prior-credit-events clause.
  assert(/which can partially speak to prior public credit events/.test(html), 'sponsor lane connects to the "prior credit events" gap (partially, public-only)');
  assert(/partially speak to/.test(html) && !/fully|substitutes|closes the gap/i.test(html), 'honest: "partially speak to" — never claims it closes the disclosure gap');
}

/* ---- (b) MARKET lane — tightened null, NO prior-credit-events clause ------ */
console.log('State (b) searched-empty — market lane omits the credit-events clause:');
{
  const snap = dd({ marketSubject: 'Austin, TX', status: 'no_findings_surfaced', findings: [] });
  const html = externalDDBlock(snap, 'property_market', 'the property’s market');
  assert(/surfaced nothing specific on the property’s market/.test(html), 'market null names the property’s market');
  assert(/this is not an affirmative finding that the market is clean/.test(html), 'market null keeps the not-clean caveat (subject: "the market")');
  assert(!/prior public credit events/.test(html), 'market lane does NOT carry the sponsor-only credit-events clause');
}

/* ---- (b) vs (c) MUST read differently ------------------------------------ */
console.log('(b) searched-empty ≠ (c) could-not-search — never collapsed:');
{
  const searchedEmpty = externalDDBlock(dd({ personSubject: 'Acme', status: 'no_findings_surfaced' }), 'person', 'the sponsor');
  const couldNotSearch = externalDDBlock(dd({ personSubject: null }), 'person', 'the sponsor');
  assert(searchedEmpty !== couldNotSearch, 'the two states produce different output');
  assert(searchedEmpty.length > 0 && couldNotSearch.length === 0, '"we looked and found nothing" renders a block; "we couldn’t look" renders none');
}

/* ---- (a) FINDINGS: guard-approved strings render ------------------------- */
console.log('State (a) findings — guard-approved strings render, sourced + caveated:');
{
  const rendered = 'A County Court Records report (2022-05-10) indicates a recorded judgment — the committee should independently confirm the source.';
  const snap = dd({
    personSubject: 'Acme Sponsor', status: 'findings',
    findings: [finding('person', 'render', rendered)],
  });
  const html = externalDDBlock(snap, 'person', 'the sponsor');
  assert(html.includes('County Court Records'), 'the sourced finding renders (publisher present)');
  assert(html.includes('should independently confirm'), 'the caveat renders (committee should confirm)');
  assert(!/surfaced nothing specific/.test(html), 'the searched-empty null does NOT show when findings exist');
  assert(/independently verify|not findings established by this analysis/i.test(html), 'frames findings as third-party, unverified — never as established facts');
}

/* ---- suppress_specific dedupe + no claim leak ---------------------------- */
console.log('Suppressed specifics — generic line, deduped, no claim/source:');
{
  const SUP = 'Further diligence is recommended on the sponsor.';
  const snap = dd({
    personSubject: 'Acme Sponsor', status: 'findings',
    findings: [
      finding('person', 'suppress_specific', SUP, 'a salacious unproven allegation'),
      finding('person', 'suppress_specific', SUP, 'another single-source rumor'),
    ],
  });
  const html = externalDDBlock(snap, 'person', 'the sponsor');
  assert(html.includes(SUP), 'the generic diligence line renders');
  assert(html.split(SUP).length - 1 === 1, 'the repeated generic line is deduped to ONE');
  assert(!html.includes('salacious') && !html.includes('rumor'), 'the suppressed SPECIFIC claims never leak into the memo');
}

/* ---- per-lane subjectType filter ----------------------------------------- */
console.log('Per-lane subjectType filter — §4 shows person only, §6 property only:');
{
  const snap = dd({
    personSubject: 'Acme Sponsor', marketSubject: 'Austin, TX', status: 'findings',
    findings: [
      finding('person', 'render', 'PERSON-LANE report — confirm.'),
      finding('property_market', 'render', 'MARKET-LANE foreclosure report — confirm.'),
    ],
  });
  const sec4 = externalDDBlock(snap, 'person', 'the sponsor');
  const sec6 = externalDDBlock(snap, 'property_market', 'the property’s market');
  assert(sec4.includes('PERSON-LANE') && !sec4.includes('MARKET-LANE'), '§4 shows only the person finding');
  assert(sec6.includes('MARKET-LANE') && !sec6.includes('PERSON-LANE'), '§6 shows only the property_market finding');
}

/* ---- NO engine-code / identifier leak via the DD render path ------------- */
console.log('Scrub — DD render path leaks no engine ids / codes / paths:');
{
  const snap = dd({
    personSubject: 'Acme', marketSubject: 'Austin, TX', status: 'findings',
    findings: [finding('person', 'render', 'A news report indicates a lawsuit — confirm.'), finding('property_market', 'render', 'A market report indicates rising vacancy — confirm.')],
  });
  const html = externalDDBlock(snap, 'person', 'the sponsor') + externalDDBlock(snap, 'property_market', 'the property’s market');
  const FORBIDDEN = /JE_|P-[IVX]+-|leverage-ltv|coverage-dscr|debt-yield|refinance-feasibility|income-concentration|cap-rate-valuation-stress|sponsor-borrower-quality|reduce_proceeds|require_amortization|dim-[0-9]|\/Users\/|\/Volumes\/|file:\/\//;
  assert(!FORBIDDEN.test(html), 'no engine ids, rule codes, dimension ids, lever ids, or filesystem paths leak');
}

/* ---- MULTI-PRINCIPAL §4 (a JV): per-principal render --------------------- */
console.log('Multi-principal §4 — each principal rendered independently:');
{
  const personFinding = (subject: string, rendered: string) => ({
    finding: {
      subjectType: 'person' as const, subject, claim: rendered, claimKind: 'reported_event' as const,
      verificationTier: 'external-unverified' as const, sentiment: 'negative' as const,
      sources: [{ url: 'https://x.example/a', publisher: 'Example News', asOfDate: '2026-01-01T00:00:00Z' as never }],
      retrievedAt: AS_OF as never,
    },
    decision: 'render' as const, rendered,
  });
  // Vornado has a finding; Crown searched-empty.
  const snap = dd({
    personSubject: 'Vornado Realty Trust',
    personSubjects: ['Vornado Realty Trust', 'Crown Acquisitions'],
    status: 'findings',
    findings: [personFinding('Vornado Realty Trust', 'A Reuters report (2024-01-01) indicates an SEC inquiry — confirm.')],
  });
  const html = externalDDBlock(snap, 'person', 'the sponsor');
  assert(/per principal/i.test(html), 'renders a per-principal block header');
  assert(html.includes('Vornado Realty Trust') && html.includes('Crown Acquisitions'), 'BOTH principals are named');
  assert(/on Vornado Realty Trust surfaced the following/.test(html), 'Vornado shows its finding');
  assert(/surfaced nothing specific on Crown Acquisitions/.test(html), 'Crown shows its own searched-empty null');
  assert(/not an affirmative finding that Crown Acquisitions is clean/.test(html), 'Crown null keeps the not-clean caveat, named to Crown');
  // The Vornado finding is NOT attached to Crown's block.
  const crownSlice = html.slice(html.indexOf('Crown Acquisitions'));
  assert(!/SEC inquiry/.test(crownSlice), 'Vornado’s finding does not leak into Crown’s block (per-principal attribution in the render)');
}

console.log('Single principal — byte-identical to the pre-multi-principal single block (no regression):');
{
  // A snapshot with personSubjects of length 1 (or absent) must render EXACTLY
  // as the single-block path — Sunroad unchanged.
  const withList = dd({ personSubject: 'Sunroad Holding Corporation', personSubjects: ['Sunroad Holding Corporation'], status: 'no_findings_surfaced' });
  const withoutList = dd({ personSubject: 'Sunroad Holding Corporation', status: 'no_findings_surfaced' });
  const a = externalDDBlock(withList, 'person', 'the sponsor');
  const b = externalDDBlock(withoutList, 'person', 'the sponsor');
  assert(a === b, 'one-element personSubjects renders identically to the single personSubject path');
  assert(/surfaced nothing specific on the sponsor/.test(a), 'single principal still uses the generic "the sponsor" wording (unchanged)');
  assert(!/per principal/i.test(a), 'single principal does NOT use the per-principal header');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} external-dd-memo-render: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
