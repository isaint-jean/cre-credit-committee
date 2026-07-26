/**
 * VALIDATION: prove the guard SURFACES a true positive (renders a real,
 * corroborated public-record finding), AND — on IDENTICAL source data — still
 * DROPS it when the subject is the wrong party (Sunroad). Live Brave + LLM.
 * No memo, no score, no cache; nothing persisted.
 *
 * Subject: the SEC-charged Rishi Kapoor / Location Ventures Miami real-estate
 * fraud — genuinely public, mainstream-reported, a matter of public record. It
 * was correctly DROPPED for Sunroad earlier (not their sponsor); here it is the
 * SUBJECT, where surfacing is correct.
 *   npx tsx src/scripts/exercise-external-dd-true-positive.ts
 */
import { runExternalDueDiligence, classifyResults, buildFindings, guardFindings } from '../services/external-dd.service.js';
import { braveSearch } from '../services/research.service.js';

const RETRIEVED_AT = '2026-07-26T00:00:00Z';

const IDENTITY_RIGHT =
  '"Location Ventures" (a Miami real-estate development firm) or "Rishi Kapoor" (its founder) — the SEC-charged Miami real-estate fraud matter. A different company or person with a similar name is NOT the subject.';
const IDENTITY_WRONG =
  '"Sunroad Holding Corporation" (the sponsor) or "Sunroad Centrum Office One Partners, LP" (the borrowing entity) — parties to a San Diego office real-estate loan. A different company or person with a similar name is NOT the subject.';

function showFinding(label: string, g: ReturnType<typeof guardFindings>[number]): void {
  console.log(`  ${label}: [${g.finding.subjectType}] ${g.finding.subject}`);
  console.log(`    claim: ${g.finding.claim}`);
  console.log(`    claimKind: ${g.finding.claimKind} | sentiment: ${g.finding.sentiment} | independent publishers: ${[...new Set(g.finding.sources.map(s => s.publisher))].join(', ')}`);
  console.log(`    ★ renderDecision: ${g.decision.toUpperCase()}`);
  console.log(`    rendered → ${g.rendered === null ? '(blank)' : '"' + g.rendered + '"'}`);
}

(async () => {
  // ── 1. TRUE POSITIVE via the full live chain (subject = the real entity) ──
  console.log('══════ TRUE POSITIVE — full live chain, subject = Location Ventures / Rishi Kapoor ══════');
  const tp = await runExternalDueDiligence({
    sponsorName: 'Location Ventures', borrowerName: 'Rishi Kapoor',
    propertyAddress: null, city: 'Miami', state: 'FL', submarket: null, assetType: 'real estate',
    retrievedAt: RETRIEVED_AT,
  });
  console.log('queries:'); tp.queries.forEach(q => console.log('  •', q));
  console.log(`raw person results: ${tp.rawCounts.person} | status: ${tp.status}`);
  console.log('guarded findings:');
  if (tp.guarded.length === 0) console.log('  (none surfaced)');
  tp.guarded.forEach((g, i) => showFinding('#' + (i + 1), g));
  console.log('dropped:', tp.dropped.length);

  // ── 2. CONTRAST on IDENTICAL data: same results, RIGHT vs WRONG subject ──
  console.log('\n══════ CONTRAST — one fetch of the Kapoor matter, classified against TWO identities ══════');
  const results = await braveSearch('"Location Ventures" "Rishi Kapoor" SEC fraud OR charged OR settlement OR receiver');
  console.log(`fetched ${results.length} raw results about the matter:`);
  results.forEach((r, i) => console.log(`  ${i}. ${r.title.slice(0, 72)} (${r.source})`));

  console.log('\n— RIGHT subject (Location Ventures / Kapoor): expect SURFACE —');
  const clsRight = await classifyResults(IDENTITY_RIGHT, 'person', results, undefined);
  const right = guardFindings(buildFindings('Location Ventures (Rishi Kapoor)', 'person', results, clsRight, RETRIEVED_AT).findings);
  console.log(`  identity yes: ${clsRight.filter(c => c.aboutSubject === 'yes').length}/${results.length} | findings: ${right.length}`);
  right.forEach((g, i) => showFinding('#' + (i + 1), g));

  console.log('\n— WRONG subject (Sunroad), IDENTICAL data: expect DROP —');
  const clsWrong = await classifyResults(IDENTITY_WRONG, 'person', results, undefined);
  const wrongBuilt = buildFindings('Sunroad Holding Corporation', 'person', results, clsWrong, RETRIEVED_AT);
  const wrong = guardFindings(wrongBuilt.findings);
  console.log(`  identity yes: ${clsWrong.filter(c => c.aboutSubject === 'yes').length}/${results.length} | findings: ${wrong.length} | dropped: ${wrongBuilt.dropped.length}`);
  wrongBuilt.dropped.slice(0, 6).forEach(d => console.log(`    ✗ "${d.title.slice(0, 60)}" — ${d.reason}`));

  console.log('\n══════ VERDICT ══════');
  const surfaced = right.some(g => g.decision === 'render');
  const wrongClean = wrong.length === 0;
  console.log(`  true positive RENDERS for the right subject: ${surfaced ? '✓' : '✗'}`);
  console.log(`  IDENTICAL data DROPS for the wrong subject (Sunroad): ${wrongClean ? '✓' : '✗'}`);
  console.log(`  → the guard both SURFACES real findings and REFUSES misattribution: ${surfaced && wrongClean ? '✓ PROVEN' : '✗'}`);
})().catch((e) => { console.error('FATAL:', e?.message || e); process.exit(2); });
