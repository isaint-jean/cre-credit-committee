/**
 * Tests for the NarrativeEvaluation contract module (Piece A Phase 1 batch 1).
 *
 *   npm run test:narrative-evaluation
 *
 * Covers:
 *   - Literal construction + JSON round-trip stability
 *   - consumedFlagPrincipleIds preserves order
 *   - computeNarrativeEvaluationId is content-deterministic (same body →
 *     same id; differing executiveSummary → different id)
 *   - Brand types compile (NarrativeEvaluationId distinct from
 *     HandbookEvaluationId at compile time — checked structurally here)
 */

import type {
  AdjustedInputsId,
  HandbookEvaluationId,
  ISODateTime,
  NarrativeEngineVersion,
  NarrativeEvaluation,
  NarrativeEvaluationId,
} from '@cre/contracts';
import { NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
import { computeNarrativeEvaluationId } from '../util/content-hash.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}
function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(m);
  else fail(`${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}

const AS_OF: ISODateTime = '2026-05-29T00:00:00.000Z' as ISODateTime;
const ADJUSTED_INPUTS_ID = 'a'.repeat(64) as AdjustedInputsId;
const HE_ID = 'b'.repeat(64) as HandbookEvaluationId;

function makeBody(overrides: Partial<{
  executiveSummary: string;
  consumedFlagPrincipleIds: readonly string[];
  redFlagAssessment: string;
  redFlagAssessmentConsumedFlagPrincipleIds: readonly string[];
  mitigationSuggestions: string;
  mitigationSuggestionsConsumedFlagPrincipleIds: readonly string[];
  committeeRecommendation: string;
  committeeRecommendationConsumedFlagPrincipleIds: readonly string[];
}> = {}) {
  return {
    analysisAsOfDate: AS_OF,
    adjustedInputsId: ADJUSTED_INPUTS_ID,
    handbookEvaluationId: HE_ID,
    engineVersion: NARRATIVE_ENGINE_VERSION as NarrativeEngineVersion,
    consumedFlagPrincipleIds: overrides.consumedFlagPrincipleIds ?? ['P-II-3', 'P-II-8'],
    redFlagAssessmentConsumedFlagPrincipleIds:
      overrides.redFlagAssessmentConsumedFlagPrincipleIds ??
      ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
    mitigationSuggestionsConsumedFlagPrincipleIds:
      overrides.mitigationSuggestionsConsumedFlagPrincipleIds ?? ['P-II-3'],
    committeeRecommendationConsumedFlagPrincipleIds:
      overrides.committeeRecommendationConsumedFlagPrincipleIds ??
      ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
    executiveSummary:
      overrides.executiveSummary ??
      'The deal carries critical cash-out refinance risk (P-II-3) at $8.5M, alongside specialty-asset exposure on Medical Office subtype (P-II-8). Both warrant committee scrutiny.',
    redFlagAssessment:
      overrides.redFlagAssessment ??
      '- [P-II-3] Cash-out refinance of $8.5M; equity extraction may signal seller distress.\n- [P-II-8] Medical Office subtype; specialty asset with thinner buyer pool at refinance.\n- [P-IV-OFF-2] Class B office; elevated leasing costs and reduced liquidity.\n- [P-IV-OFF-9] Washington DC submarket showing office distress signals.',
    mitigationSuggestions:
      overrides.mitigationSuggestions ??
      '- [P-II-3] Given cash-out amount of 8500000, require $5M upfront reserve plus minimum DSCR covenant at 1.25x with cash sweep above debt yield 11%.',
    committeeRecommendation:
      overrides.committeeRecommendation ??
      'Recommend conditional approval subject to $5M upfront reserve (P-II-3 cash-out exposure), minimum DSCR covenant at 1.25x with cash sweep above debt yield 11% (P-II-3), and specialty-asset risk premium of 50bps on the spread (P-II-8 Medical Office subtype). Residual Class B + DC submarket concerns (P-IV-OFF-2, P-IV-OFF-9) are acceptable at the proposed terms given DSCR of 1.42x.',
  };
}

function makeEvaluation(): NarrativeEvaluation {
  const body = makeBody();
  return {
    id: computeNarrativeEvaluationId(body),
    ...body,
  };
}

console.log('\n=== NarrativeEvaluation construction ===');

(() => {
  const ne = makeEvaluation();
  assertEqual(ne.adjustedInputsId, ADJUSTED_INPUTS_ID, 'adjustedInputsId populated (sibling FK)');
  assertEqual(ne.handbookEvaluationId, HE_ID, 'handbookEvaluationId populated (substrate reference)');
  assertEqual(ne.engineVersion, NARRATIVE_ENGINE_VERSION, 'engineVersion populated from contract constant');
  assertEqual(ne.consumedFlagPrincipleIds.length, 2, 'consumedFlagPrincipleIds populated (executive_summary scope)');
  assertEqual(ne.redFlagAssessmentConsumedFlagPrincipleIds.length, 4, 'redFlagAssessmentConsumedFlagPrincipleIds populated (red_flag_assessment scope)');
  assertEqual(ne.mitigationSuggestionsConsumedFlagPrincipleIds.length, 1, 'mitigationSuggestionsConsumedFlagPrincipleIds populated (mitigation_suggestions scope)');
  assertEqual(ne.committeeRecommendationConsumedFlagPrincipleIds.length, 4, 'committeeRecommendationConsumedFlagPrincipleIds populated (committee_recommendation scope)');
  assertEqual(typeof ne.executiveSummary, 'string', 'executiveSummary is string');
  assertEqual(typeof ne.redFlagAssessment, 'string', 'redFlagAssessment is string (Phase 2)');
  assertEqual(typeof ne.mitigationSuggestions, 'string', 'mitigationSuggestions is string (Phase 3)');
  assertEqual(typeof ne.committeeRecommendation, 'string', 'committeeRecommendation is string (Phase 4)');
  ok('full NarrativeEvaluation literal compiles and constructs (4-slot complete)');
})();

console.log('\n=== consumedFlagPrincipleIds preserves order ===');

(() => {
  const body = makeBody({ consumedFlagPrincipleIds: ['P-A', 'P-B', 'P-C'] });
  const ne: NarrativeEvaluation = { id: computeNarrativeEvaluationId(body), ...body };
  assertEqual([...ne.consumedFlagPrincipleIds], ['P-A', 'P-B', 'P-C'], 'order preserved on construction');
  // round-trip
  const round = JSON.parse(JSON.stringify(ne)) as NarrativeEvaluation;
  assertEqual([...round.consumedFlagPrincipleIds], ['P-A', 'P-B', 'P-C'], 'order preserved through JSON round-trip');
})();

console.log('\n=== computeNarrativeEvaluationId — content determinism ===');

(() => {
  const body1 = makeBody();
  const body2 = makeBody();
  assertEqual(
    computeNarrativeEvaluationId(body1),
    computeNarrativeEvaluationId(body2),
    'identical bodies hash to identical ids',
  );
  const differentSummary = makeBody({ executiveSummary: 'Completely different prose.' });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentSummary)) {
    fail('different executiveSummary should produce different id');
  } else {
    ok('different executiveSummary produces different id');
  }
  const differentConsumed = makeBody({ consumedFlagPrincipleIds: ['P-II-3'] });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentConsumed)) {
    fail('different consumedFlagPrincipleIds should produce different id');
  } else {
    ok('different consumedFlagPrincipleIds produces different id');
  }
  const differentRedFlag = makeBody({ redFlagAssessment: 'Different red-flag prose for Phase 2.' });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentRedFlag)) {
    fail('different redFlagAssessment should produce different id');
  } else {
    ok('different redFlagAssessment produces different id (Phase 2 slot in content hash)');
  }
  const differentRedFlagConsumed = makeBody({ redFlagAssessmentConsumedFlagPrincipleIds: ['P-II-3'] });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentRedFlagConsumed)) {
    fail('different redFlagAssessmentConsumedFlagPrincipleIds should produce different id');
  } else {
    ok('different redFlagAssessmentConsumedFlagPrincipleIds produces different id');
  }
  const differentMitigation = makeBody({ mitigationSuggestions: 'Different mitigation prose for Phase 3.' });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentMitigation)) {
    fail('different mitigationSuggestions should produce different id');
  } else {
    ok('different mitigationSuggestions produces different id (Phase 3 slot in content hash)');
  }
  const differentMitigationConsumed = makeBody({ mitigationSuggestionsConsumedFlagPrincipleIds: ['P-II-8'] });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentMitigationConsumed)) {
    fail('different mitigationSuggestionsConsumedFlagPrincipleIds should produce different id');
  } else {
    ok('different mitigationSuggestionsConsumedFlagPrincipleIds produces different id');
  }
  const differentCommittee = makeBody({ committeeRecommendation: 'Different committee prose for Phase 4.' });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentCommittee)) {
    fail('different committeeRecommendation should produce different id');
  } else {
    ok('different committeeRecommendation produces different id (Phase 4 slot in content hash)');
  }
  const differentCommitteeConsumed = makeBody({ committeeRecommendationConsumedFlagPrincipleIds: ['P-II-3'] });
  if (computeNarrativeEvaluationId(body1) === computeNarrativeEvaluationId(differentCommitteeConsumed)) {
    fail('different committeeRecommendationConsumedFlagPrincipleIds should produce different id');
  } else {
    ok('different committeeRecommendationConsumedFlagPrincipleIds produces different id');
  }
})();

console.log('\n=== Brand type assignability (compile-time check via runtime structural) ===');

(() => {
  const ne = makeEvaluation();
  // Both are ContentHash under the hood; the brand discriminator is compile-
  // time only. At runtime we just verify the value is a 64-char hex string.
  const id: NarrativeEvaluationId = ne.id;
  if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) {
    ok('NarrativeEvaluationId is 64-char lowercase hex');
  } else {
    fail(`NarrativeEvaluationId not 64-hex: ${id}`);
  }
})();

console.log('\n=== JSON round-trip stability ===');

(() => {
  const ne = makeEvaluation();
  const round = JSON.parse(JSON.stringify(ne)) as NarrativeEvaluation;
  assertEqual(round.id, ne.id, 'id survives round-trip');
  assertEqual(round.adjustedInputsId, ne.adjustedInputsId, 'adjustedInputsId survives');
  assertEqual(round.handbookEvaluationId, ne.handbookEvaluationId, 'handbookEvaluationId survives');
  assertEqual(round.engineVersion, ne.engineVersion, 'engineVersion survives');
  assertEqual(round.executiveSummary, ne.executiveSummary, 'executiveSummary survives');
  assertEqual(round.redFlagAssessment, ne.redFlagAssessment, 'redFlagAssessment survives (Phase 2)');
  assertEqual(
    [...round.redFlagAssessmentConsumedFlagPrincipleIds],
    [...ne.redFlagAssessmentConsumedFlagPrincipleIds],
    'redFlagAssessmentConsumedFlagPrincipleIds survives',
  );
  assertEqual(round.mitigationSuggestions, ne.mitigationSuggestions, 'mitigationSuggestions survives (Phase 3)');
  assertEqual(
    [...round.mitigationSuggestionsConsumedFlagPrincipleIds],
    [...ne.mitigationSuggestionsConsumedFlagPrincipleIds],
    'mitigationSuggestionsConsumedFlagPrincipleIds survives',
  );
  assertEqual(round.committeeRecommendation, ne.committeeRecommendation, 'committeeRecommendation survives (Phase 4)');
  assertEqual(
    [...round.committeeRecommendationConsumedFlagPrincipleIds],
    [...ne.committeeRecommendationConsumedFlagPrincipleIds],
    'committeeRecommendationConsumedFlagPrincipleIds survives',
  );
})();

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
