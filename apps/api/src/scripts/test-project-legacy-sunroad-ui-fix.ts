/**
 * SUNROAD-UI-FIX — acceptance test for the projector's 5 missing tile fields
 * + the doctrine-coverage-gate signal threading.
 *
 *   cd apps/api && npx tsx src/scripts/test-project-legacy-sunroad-ui-fix.ts
 *
 * Two cases:
 *   §A  Sunroad-shaped GATED case — handbook has 8 firedFlags (1 critical + 7
 *       high); doctrine.flags includes INSUFFICIENT_COVERAGE_GATE with
 *       finalScore 0 / ratingBand 'High Risk'; cross-check empty + neutral
 *       bias. Asserts:
 *         - findings projected to length 8, severity counts 1 critical / 7 high
 *         - inputHash, manifestoVersion, modelLogicVersion all populated
 *         - validationResult is { passed:true, checks:1 } (clean cross-check)
 *         - creditScore.riskTier === 'insufficient_data' (gate signal)
 *
 *   §B  NORMAL case — handbook has 2 firedFlags (1 low + 1 medium); doctrine
 *       finalScore 75 / ratingBand 'Strong' / flags []; cross-check has 1
 *       finding with CONSERVATIVE status (passing) + neutral bias. Asserts:
 *         - findings projected to length 2
 *         - creditScore.riskTier === 'strong' (NOT insufficient_data — the
 *           gate-signal path doesn't fire when flags don't include it)
 *         - validationResult passed:true with 1 check
 *
 *   §C  cross-check honest negative — empty findings, bias 'INSUFFICIENT_DATA'
 *       (not neutral) → validationResult should be undefined (don't fake a
 *       pass when the engine itself flagged insufficient cross-check data).
 *
 * Independent of the existing test-project-legacy-from-graph.ts which uses
 * ingestExtractionResult to build the spine — this test injects records
 * directly so it can construct the exact gate + flag configurations needed.
 */

import {
  type AdjustedInputs,
  type AdjustedInputsId,
  type ContentHash,
  type CrossCheckResult,
  type CrossCheckResultId,
  type DoctrineEvaluation,
  type DoctrineEvaluationId,
  type ExtractionResultId,
  type HandbookEvaluation,
  type HandbookEvaluationId,
  type ISODateTime,
  type NarrativeEvaluation,
  type NarrativeEvaluationId,
  type RevisionId,
  type RevisionLineageEnvelope,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import type { Analysis, CreditScore } from '@cre/shared';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ✓ ${m}`); }
function fail(m: string): void { failed++; console.error(`  ✗ ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const AS_OF = '2026-06-15T00:00:00Z' as ISODateTime;

function fakeContentHash(seed: string): string {
  // 64-hex deterministic-from-seed for fixture IDs. Not a real content hash;
  // sufficient for ON CONFLICT identity and FK lookups in a :memory: store.
  let s = seed;
  while (s.length < 64) s += seed;
  return s.slice(0, 64);
}

function makeLegacy(graphRevisionId: string): Analysis {
  // uwModel/stressScenarios are PRESET to non-null/non-empty stub values so
  // the projector's synthesizeUwModelFromGraph + projectStressScenarios paths
  // short-circuit (they only fire when the legacy slot is null/empty). This
  // test exercises the FIVE NEW projections (findings + version-info +
  // validationResult + gate-signal), not uwModel synthesis (covered by the
  // existing test-project-legacy-from-graph.ts).
  return {
    id: 'analysis-uuid-for-test',
    name: 'Test Analysis',
    assetType: 'office',
    status: 'complete',
    progress: 100,
    currentStep: 'Complete (promoted from graph)',
    createdAt: AS_OF,
    updatedAt: AS_OF,
    graphRevisionId,
    document: null,
    uwDocument: null,
    supportingDocuments: [],
    templateDocument: null,
    findings: [],
    creditScore: null,
    uwModel: { stub: true } as never,
    research: null,
    crossCheckFindings: [],
    mitigations: [],
    executiveSummary: null,
    bPieceDecision: null,
    comments: [],
    criteriaEvaluations: [],
    stressScenarios: [{ stub: true }] as never,
  };
}

/* -------------------------------------------------------------------------- */
/* Spine record builders                                                      */
/* -------------------------------------------------------------------------- */

interface SpineSeed {
  readonly extractionResultId: ExtractionResultId;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly handbookEvaluationId: HandbookEvaluationId;
  readonly crossCheckResultId: CrossCheckResultId;
  readonly doctrineEvaluationId: DoctrineEvaluationId;
  readonly narrativeEvaluationId: NarrativeEvaluationId;
  readonly revisionId: RevisionId;
}

function seedSpine(
  store: RecordGraphStore,
  opts: {
    readonly seed: string;
    readonly firedFlags: HandbookEvaluation['firedFlags'];
    readonly doctrineFlags: readonly string[];
    readonly finalScore: number;
    readonly ratingBand: DoctrineEvaluation['ratingBand'];
    readonly crossCheckFindings: CrossCheckResult['findings'];
    readonly crossCheckBias: CrossCheckResult['overallAdjustmentBias'];
  },
): SpineSeed {
  const eid = fakeContentHash('extr-' + opts.seed) as ExtractionResultId;
  const aiid = fakeContentHash('adj-' + opts.seed) as AdjustedInputsId;
  const heid = fakeContentHash('hb-' + opts.seed) as HandbookEvaluationId;
  const ccid = fakeContentHash('cc-' + opts.seed) as CrossCheckResultId;
  const deid = fakeContentHash('doc-' + opts.seed) as DoctrineEvaluationId;
  const neid = fakeContentHash('narr-' + opts.seed) as NarrativeEvaluationId;
  const rev = fakeContentHash('rev-' + opts.seed) as RevisionId;

  // Direct DB inserts via the store's underlying db handle.
  // Bypasses the verifyAndSerialize content-hash checks — fine for fixture
  // construction where we want specific id values, not derived ones.
  const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;

  // adjusted_inputs (only id needed for FK + lookup; payload is minimal)
  db.prepare('INSERT INTO adjusted_inputs (id, payload, analysis_as_of_date, judgment_engine_version, library_snapshot_id, created_at) VALUES (?,?,?,?,?,?)').run(
    aiid, JSON.stringify({ id: aiid }), AS_OF, '1.10', fakeContentHash('lib-' + opts.seed), AS_OF,
  );

  // handbook_evaluation
  const heRecord: HandbookEvaluation = {
    id: heid,
    analysisAsOfDate: AS_OF,
    adjustedInputsId: aiid,
    handbookVersion: '2026.5-period-fix',
    engineVersion: '1.6.0',
    fieldBagSnapshot: {},
    firedFlags: opts.firedFlags,
    skippedPrinciples: [],
  };
  db.prepare('INSERT INTO handbook_evaluations (id, payload, analysis_as_of_date, adjusted_inputs_id, handbook_version, engine_version, created_at) VALUES (?,?,?,?,?,?,?)').run(
    heid, JSON.stringify(heRecord), AS_OF, aiid, '2026.5-period-fix', '1.6.0', AS_OF,
  );

  // cross_check_results
  const ccRecord: CrossCheckResult = {
    id: ccid,
    analysisAsOfDate: AS_OF,
    adjustedInputsId: aiid,
    findings: opts.crossCheckFindings,
    overallAdjustmentBias: opts.crossCheckBias,
  };
  db.prepare('INSERT INTO cross_check_results (id, payload, analysis_as_of_date, adjusted_inputs_id, created_at) VALUES (?,?,?,?,?)').run(
    ccid, JSON.stringify(ccRecord), AS_OF, aiid, AS_OF,
  );

  // doctrine_evaluation
  const deRecord: DoctrineEvaluation = {
    id: deid,
    analysisAsOfDate: AS_OF,
    doctrineVersion: '1.3' as never,
    judgmentEngineVersion: '1.10' as never,
    stressEngineVersion: '1.0' as never,
    valuationEngineVersion: '1.0' as never,
    adjustedInputsId: aiid,
    librarySnapshotId: fakeContentHash('lib-' + opts.seed) as never,
    narrativeFactsId: fakeContentHash('nf-' + opts.seed) as never,
    crossCheckResultId: ccid,
    stressOutputsId: fakeContentHash('so-' + opts.seed) as never,
    valuationConclusionId: fakeContentHash('vc-' + opts.seed) as never,
    assetProfileId: fakeContentHash('ap-' + opts.seed) as never,
    extractionResultId: eid,
    finalScore: opts.finalScore,
    ratingBand: opts.ratingBand,
    mechanicalScore: 0,
    weightedAggregate: opts.finalScore,
    componentScores: [],
    flags: opts.doctrineFlags as readonly never[],
    reasons: [],
    scoreAdjustments: [],
    assetTypeAdjustments: [],
    rentRollId: null,
    coverage: {
      evaluatedWeight: 1,
      totalEvaluableWeight: 1,
      evaluatedPct: 1,
      excludedRiskDimRuleIds: [],
      bandCapApplied: false,
      insufficientCoverageGate: opts.doctrineFlags.includes('INSUFFICIENT_COVERAGE_GATE'),
    },
  };
  db.prepare('INSERT INTO doctrine_evaluations (id, payload, analysis_as_of_date, doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version, adjusted_inputs_id, library_snapshot_id, narrative_facts_id, cross_check_result_id, stress_outputs_id, valuation_conclusion_id, asset_profile_id, extraction_result_id, final_score, rating_band, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    deid, JSON.stringify(deRecord), AS_OF, '1.3', '1.10', '1.0', '1.0', aiid,
    fakeContentHash('lib-' + opts.seed), fakeContentHash('nf-' + opts.seed), ccid,
    fakeContentHash('so-' + opts.seed), fakeContentHash('vc-' + opts.seed),
    fakeContentHash('ap-' + opts.seed), eid, opts.finalScore, opts.ratingBand, AS_OF,
  );

  // narrative
  const neRecord: NarrativeEvaluation = {
    id: neid,
    analysisAsOfDate: AS_OF,
    adjustedInputsId: aiid,
    handbookEvaluationId: heid,
    engineVersion: NARRATIVE_ENGINE_VERSION,
    executiveSummary: 'Test executive summary (' + opts.seed + ')',
    redFlagAssessment: 'Test red-flag assessment.',
    mitigationSuggestions: 'Test mitigation suggestions.',
    committeeRecommendation: 'Test committee recommendation.',
    consumedFlagPrincipleIds: [],
    redFlagAssessmentConsumedFlagPrincipleIds: [],
    mitigationSuggestionsConsumedFlagPrincipleIds: [],
    committeeRecommendationConsumedFlagPrincipleIds: [],
  };
  db.prepare('INSERT INTO narratives (id, payload, analysis_as_of_date, adjusted_inputs_id, handbook_evaluation_id, engine_version, created_at) VALUES (?,?,?,?,?,?,?)').run(
    neid, JSON.stringify(neRecord), AS_OF, aiid, heid, NARRATIVE_ENGINE_VERSION, AS_OF,
  );

  // revision_lineage_envelope
  const envelope: RevisionLineageEnvelope = {
    revisionId: rev,
    lineageRootId: rev as never,
    parentRevisionId: null,
    revisionOrdinal: 0,
    doctrineEvaluationId: deid,
    adjustedInputsId: aiid,
    doctrineVersion: '1.3' as never,
    judgmentEngineVersion: '1.10' as never,
    stressEngineVersion: '1.0' as never,
    valuationEngineVersion: '1.0' as never,
  };
  db.prepare('INSERT INTO revision_lineage_envelopes (revision_id, lineage_root_id, parent_revision_id, revision_ordinal, doctrine_evaluation_id, adjusted_inputs_id, doctrine_version, judgment_engine_version, stress_engine_version, valuation_engine_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    rev, rev, null, 0, deid, aiid, '1.3', '1.10', '1.0', '1.0', AS_OF,
  );
  void envelope;

  return {
    extractionResultId: eid,
    adjustedInputsId: aiid,
    handbookEvaluationId: heid,
    crossCheckResultId: ccid,
    doctrineEvaluationId: deid,
    narrativeEvaluationId: neid,
    revisionId: rev,
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function flag(principleId: string, severity: 'critical' | 'high' | 'medium' | 'advisory', msg: string): HandbookEvaluation['firedFlags'][number] {
  return {
    principleId,
    severity,
    flag_message: msg,
    metricValue: null,
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: [],
  };
}

const SUNROAD_FIRED_FLAGS = [
  flag('P-II-1',     'high',     'Multiple structural downside risks are present simultaneously: NOI uplift of …'),
  flag('P-II-6',     'critical', 'Multiple material data gaps are present: trailing actual NOI is null …'),
  flag('P-II-7',     'high',     'B-piece faces meaningful early-loss severity risk: the loan carries a $75M balance …'),
  flag('P-III-6',    'high',     'Leverage metrics show a mixed picture: DSCR of 1.42 and Debt Yield of 11.4% are …'),
  flag('P-III-8',    'high',     'Stress DSCR analysis is incomplete for an office deal where the largest tenant …'),
  flag('P-III-9',    'high',     'The deal provides a stabilized cap rate of 7.15% yielding an appraised value of …'),
  flag('P-III-10',   'high',     'Term risk and maturity risk are both present and must be explicitly distinguishe…'),
  flag('P-IV-OFF-3', 'high',     'Office capital reserves appear thin relative to the rollover exposure: monthly T…'),
];

/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('SUNROAD-UI-FIX — projector extension acceptance test');
console.log('================================================================');

const store = new RecordGraphStore(':memory:');
// Turn off FK enforcement on the :memory: store so we can inject spine records
// directly without seeding their upstream rows (library_snapshots,
// narrative_facts, asset_profiles, etc.). The projector reads the spine via
// public getters, so FK semantics aren't exercised in this test.
(store as unknown as { db: { pragma(s: string): unknown } }).db.pragma('foreign_keys = OFF');

/* -------------------------------------------------------------------------- */
/* §A — Sunroad-shaped GATED case                                            */
/* -------------------------------------------------------------------------- */
console.log('\n--- §A. Sunroad-shaped GATED case (INSUFFICIENT_COVERAGE_GATE + 8 firedFlags) ---');
{
  const seed = seedSpine(store, {
    seed: 'sunroad',
    firedFlags: SUNROAD_FIRED_FLAGS,
    doctrineFlags: ['INSUFFICIENT_DATA', 'INSUFFICIENT_COVERAGE_GATE'],
    finalScore: 0,
    ratingBand: 'High Risk',
    crossCheckFindings: [],
    crossCheckBias: 'neutral',
  });

  const input = makeLegacy(seed.revisionId);
  const out = projectLegacyAnalysisFromGraph(input, store);

  // ★ findings — 1:1 bijection
  assertEqual(out.findings.length, 8, '§A.1 ★ findings.length === 8 (bijective from spine firedFlags)');
  const critical = out.findings.filter((f) => f.severity === 'critical').length;
  const high     = out.findings.filter((f) => f.severity === 'high').length;
  assertEqual(critical, 1, '§A.2 ★ severity count: 1 critical (P-II-6)');
  assertEqual(high, 7, '§A.3 ★ severity count: 7 high');
  assert(out.findings.some((f) => f.id === 'P-II-6'), '§A.4 P-II-6 present');
  assert(out.findings.some((f) => f.id === 'P-IV-OFF-3'), '§A.5 P-IV-OFF-3 present');
  assert(out.findings.every((f) => f.explanation.length > 10),
    '§A.6 every finding carries a non-trivial explanation (flag_message)');
  assert(out.findings.find((f) => f.id === 'P-II-1')?.category === 'cash_flow',
    '§A.7 category derivation: P-II-* → cash_flow');
  assert(out.findings.find((f) => f.id === 'P-III-6')?.category === 'loan_structure',
    '§A.8 category derivation: P-III-* → loan_structure');
  assert(out.findings.find((f) => f.id === 'P-IV-OFF-3')?.category === 'expense',
    '§A.9 category derivation: P-IV-* → expense');

  // version-info fields
  assert(typeof out.inputHash === 'string' && out.inputHash.length === 64,
    '§A.10 ★ inputHash populated (extractionResultId, 64-hex)');
  assert(typeof out.manifestoVersion === 'string' && out.manifestoVersion.includes('handbook'),
    '§A.11 ★ manifestoVersion populated (carries handbookVersion)');
  assert(typeof out.modelLogicVersion === 'string' && out.modelLogicVersion.includes('D1.3'),
    '§A.12 ★ modelLogicVersion populated (composed engine versions)');
  assert(out.modelLogicVersion?.includes('J1.10') === true,
    '§A.13 modelLogicVersion includes judgment-engine version');

  // validationResult honest
  assert(out.validationResult !== undefined, '§A.14 ★ validationResult populated');
  assertEqual(out.validationResult!.passed, true,
    '§A.15 ★ validationResult.passed === true (empty findings + neutral bias = clean pass)');
  assertEqual(out.validationResult!.checks.length, 1,
    '§A.16 single summary check entry');

  // gate signal — CreditScore.riskTier
  const cs = out.creditScore as CreditScore;
  assertEqual(cs.riskTier, 'insufficient_data',
    '§A.17 ★★ creditScore.riskTier === "insufficient_data" (gate signal threaded)');
  assertEqual(cs.overall, 0,
    '§A.18 creditScore.overall === 0 (raw finalScore preserved; UI uses riskTier to interpret)');
}

/* -------------------------------------------------------------------------- */
/* §B — NORMAL case (no gate, real score)                                    */
/* -------------------------------------------------------------------------- */
console.log('\n--- §B. NORMAL case (gate NOT fired, real score) ---');
{
  const seed = seedSpine(store, {
    seed: 'normal',
    firedFlags: [
      flag('P-II-3', 'medium',   'Minor NOI normalization adjustment.'),
      flag('P-IV-MF-2', 'high',  'Multifamily reserve sizing is on the lower side.'),
    ],
    doctrineFlags: [],
    finalScore: 75,
    ratingBand: 'Strong',
    crossCheckFindings: [
      {
        metric: 'noi',
        bank: { value: 1_000_000, source: 'PRIMARY' as never },
        rawExtracted: { value: 1_000_000, source: 'PRIMARY' as never },
        adjusted: { value: 950_000 },
        bpFinal: { value: 950_000 },
        drivers: [],
        delta: { vsBank: -50_000, vsBankPct: -0.05 },
        conservatismStatus: 'CONSERVATIVE',
      } as CrossCheckResult['findings'][number],
    ],
    crossCheckBias: 'conservative',
  });

  const input = makeLegacy(seed.revisionId);
  const out = projectLegacyAnalysisFromGraph(input, store);

  assertEqual(out.findings.length, 2,
    '§B.1 ★ NORMAL case still works: findings.length === 2');
  const cs = out.creditScore as CreditScore;
  assertEqual(cs.riskTier, 'strong',
    '§B.2 ★★ creditScore.riskTier === "strong" (gate NOT fired — no insufficient_data override)');
  assertEqual(cs.overall, 75, '§B.3 creditScore.overall === 75 (real score)');
  assert(out.validationResult !== undefined,
    '§B.4 validationResult present');
  assertEqual(out.validationResult!.passed, true,
    '§B.5 single CONSERVATIVE finding passes (not NON_CONSERVATIVE)');
  assertEqual(out.validationResult!.checks.length, 1, '§B.6 1 check (the cross-check finding)');
}

/* -------------------------------------------------------------------------- */
/* §C — Cross-check honest negative                                          */
/* -------------------------------------------------------------------------- */
console.log('\n--- §C. cross-check INSUFFICIENT_DATA bias → no fake-pass ---');
{
  const seed = seedSpine(store, {
    seed: 'insuffcc',
    firedFlags: [],
    doctrineFlags: [],
    finalScore: 60,
    ratingBand: 'Acceptable',
    crossCheckFindings: [],
    crossCheckBias: 'INSUFFICIENT_DATA',
  });

  const input = makeLegacy(seed.revisionId);
  const out = projectLegacyAnalysisFromGraph(input, store);

  assertEqual(out.validationResult, undefined,
    '§C.1 ★ empty findings + INSUFFICIENT_DATA bias → validationResult undefined (UI shows NOT VALIDATED, honest)');
}

/* -------------------------------------------------------------------------- */
console.log('\n================================================================');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('SUNROAD-UI-FIX projector test: PASS — gate signal + 5 missing tile surfaces project correctly.');
process.exit(0);
