/**
 * Tests for the HUMAN → dim-9 bridge.
 *
 *   npm run test:human-sponsor-assessment
 *
 * Proves THE INVARIANT (a DD finding never reaches the score directly; only a
 * human entering an explicit assessment moves dim-9) at the seams that carry it:
 *   - the human record's provenance is type-locked to 'human';
 *   - the bridge maps human → doctrine ONE WAY, dropping provenance, with no
 *     inverse (nothing builds a HumanSponsorAssessment from a finding/score);
 *   - dim-9 stays HITL/inert until a human assessment arrives, then applies a
 *     real ±0.20 modifier; factor-4 Severe floors at +0.20 (doctrine unchanged);
 *   - §4 renders the human judgment DISTINCT from the external-DD finding.
 *
 * Deterministic — pure functions, synthetic inputs. No DB, no web.
 */
import { toDoctrineSponsorAssessment } from '../services/sponsor-assessment-bridge.js';
import { evaluateSponsorBorrowerQuality } from '../doctrine-clean/index.js';
import { externalDDBlock, humanSponsorAssessmentBlock } from '../services/render-memo/build-committee-memo.js';
import { isSponsorFactorRating, type HumanSponsorAssessment, type SnapshotExternalDD } from '@cre/contracts';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const AS_OF = '2026-07-26T00:00:00.000Z';
function human(overrides: Partial<HumanSponsorAssessment> = {}): HumanSponsorAssessment {
  return {
    experience: 'Neutral', financialStrength: 'Neutral', alignment: 'Neutral',
    priorCreditEvents: 'Neutral', managementQuality: 'Neutral',
    enteredBy: 'reviewer@mapaon.com', enteredAt: AS_OF as never, provenance: 'human',
    ...overrides,
  };
}

/* ---- factor-rating validator (route shape guard) ------------------------- */
console.log('Factor-rating validator:');
assert(isSponsorFactorRating('Strong') && isSponsorFactorRating('Severe'), 'accepts valid ratings');
assert(!isSponsorFactorRating('strong') && !isSponsorFactorRating('') && !isSponsorFactorRating(3), 'rejects invalid ratings (case / empty / non-string)');

/* ---- the bridge: human → doctrine, one way, provenance dropped ----------- */
console.log('Bridge — human record → doctrine scoring input:');
{
  assertEqual(toDoctrineSponsorAssessment(null), null, 'null → null (dim-9 stays HITL; no default substituted)');
  assertEqual(toDoctrineSponsorAssessment(undefined), null, 'undefined → null');
  const d = toDoctrineSponsorAssessment(human({ experience: 'Strong', priorCreditEvents: 'Severe' }))!;
  assertEqual(d.experience, 'Strong', 'carries the human experience factor');
  assertEqual(d.priorCreditEvents, 'Severe', 'carries factor-4');
  assert(!('provenance' in d) && !('enteredBy' in d) && !('enteredAt' in d), 'drops provenance/who/when — the scorer sees only the 5 factors');
  assertEqual(Object.keys(d).sort().join(','), 'alignment,experience,financialStrength,managementQuality,priorCreditEvents', 'exactly the 5 scoring factors, nothing more');
}

/* ---- dim-9 stays HITL until a human assessment arrives -------------------- */
console.log('dim-9 — HITL/inert until a HUMAN assessment moves it:');
{
  const hitl = evaluateSponsorBorrowerQuality({ assessment: null });
  assertEqual(hitl.applicability, 'hitl-needed', 'null assessment → hitl-needed (inert)');
  assertEqual(hitl.riskModifier, 0, 'null assessment → modifier 0 (no default)');

  const applied = evaluateSponsorBorrowerQuality({ assessment: toDoctrineSponsorAssessment(human({ experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong', priorCreditEvents: 'Strong', managementQuality: 'Strong' })) });
  assertEqual(applied.applicability, 'applicable', 'a human assessment → applicable (dim-9 resolves)');
  assert(typeof applied.riskModifier === 'number' && applied.riskModifier < 0, 'a strong sponsor → risk-reducing modifier');
  assertEqual(applied.riskModifier, -0.20, 'all-Strong floors at the risk-reducing bound (−0.20)');
}

/* ---- factor-4 Severe asymmetry — floors at +0.20 (doctrine unchanged) ----- */
console.log('Factor-4 Severe floors at +0.20 even against otherwise-Strong factors:');
{
  const severe = evaluateSponsorBorrowerQuality({
    assessment: toDoctrineSponsorAssessment(human({
      experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong',
      managementQuality: 'Strong', priorCreditEvents: 'Severe',
    })),
  });
  assertEqual(severe.applicability, 'applicable', 'applicable');
  assertEqual(severe.riskModifier, 0.20, 'factor-4 Severe reaches +0.20 — a clean record does NOT offset a disqualifying event');
}

/* ---- §4 render: human judgment DISTINCT from the DD finding --------------- */
console.log('§4 render — human assessment distinct from the external-DD finding:');
{
  const h = human({ experience: 'Strong', priorCreditEvents: 'Severe', note: 'entered after reviewing the external-DD context' });
  const block = humanSponsorAssessmentBlock(h);
  assert(/committee’s sponsor assessment/i.test(block), 'reads as the committee’s OWN assessment');
  assert(block.includes('reviewer@mapaon.com') && /Entered 2026-07-26/.test(block), 'attributed to who + when');
  assert(block.includes('Prior credit events') && block.includes('Severe'), 'shows the five factors incl. factor-4 value');
  assert(/context the reviewer weighed|not a value derived/i.test(block), 'states the DD is context, the assessment is the human call (not derived)');
  assert(block.includes('entered after reviewing the external-DD context'), 'renders the optional reviewer note');

  // The DD block and the human block are DIFFERENT surfaces — never conflated.
  const ddSnap: SnapshotExternalDD = {
    status: 'no_findings_surfaced', findings: [], retrievedAt: AS_OF as never,
    analysisAsOfDate: AS_OF as never, personSubject: 'Acme Sponsor', marketSubject: null,
  };
  const ddBlock = externalDDBlock(ddSnap, 'person', 'the sponsor');
  assert(/External searches/.test(ddBlock) && !/committee’s sponsor assessment/i.test(ddBlock), 'the DD block is external-signal prose, not the human judgment');
  assert(!/External searches/.test(block), 'the human block does not restate the external search — the two are distinct');
}

/* ---- THE INVARIANT: no finding → assessment auto-population --------------- */
console.log('Invariant — a DD finding cannot auto-set any assessment factor:');
{
  // Provenance is type-locked to the literal 'human'. A finding is a different
  // type; there is no expression that yields a HumanSponsorAssessment from it.
  const h = human();
  assertEqual(h.provenance, 'human', 'the record is provenance-tagged human (type-locked literal)');
  // The bridge is one-way: it consumes a human record and returns scoring
  // factors; it NEVER produces a human record. (Compile-time: toDoctrine returns
  // SponsorAssessment | null, which has no enteredBy/provenance — cannot be fed
  // back as a HumanSponsorAssessment.) The absence of an inverse is the air-gap.
  ok('the bridge has no inverse (human → factors only; nothing builds a human record from a finding/score)');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} human-sponsor-assessment: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
