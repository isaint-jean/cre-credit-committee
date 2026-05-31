/**
 * Read-through projection — overlay graph substrate onto a legacy Analysis.
 *
 * When a legacy Analysis carries `graphRevisionId` (set by the promote-from-graph
 * operation), this projection fills the legacy substrate fields from the linked
 * new-spine records (NarrativeEvaluation, DoctrineEvaluation) so the legacy view
 * renders real handbook output instead of legacy LLM output.
 *
 * Current scope:
 *   - executiveSummary     ← NarrativeEvaluation.executiveSummary
 *   - creditScore          ← DoctrineEvaluation.{finalScore, ratingBand, componentScores}
 *   - uwModel              ← synthesizeUwModelFromGraph (AdjustedInputs +
 *                             StressOutputs + PropertyMetadata best-effort);
 *                             ONLY when the legacy uwModel is null. Preserves
 *                             any analyst-edited legacy uwModel that's already
 *                             populated.
 *   - stressScenarios      ← StressOutputs.scenarios[] (legacy stress shape);
 *                             ONLY when the legacy stressScenarios is empty.
 *                             Promoted records preload graph-computed scenarios
 *                             so the stress tab shows real results without a
 *                             manual click.
 *   - mitigationsNarrative ← NarrativeEvaluation.mitigationSuggestions (prose).
 *                             Read-time only — the legacy mitigations[] cards
 *                             array is left untouched. The page chooses which
 *                             surface to render based on graphRevisionId.
 *
 * Fallback: when `graphRevisionId` is null/undefined, OR when any of the linked
 * records cannot be resolved, the corresponding legacy field is left unchanged —
 * preserving legacy behavior for unlinked analyses and degrading gracefully for
 * partial graph state.
 *
 * Numbers projected into legacy must match what the new-spine view would show.
 * `rendered-analysis.ts` projects `DoctrineEvaluation.componentScores` as
 * `RenderedComponentScore[]` with renamed `componentId → name` (bijective
 * passthrough); this projector applies the same bijection into the legacy
 * `CreditScoreCategory[]` shape, so the Score tab and the new-spine view
 * agree on the score values.
 */

import {
  NARRATIVE_ENGINE_VERSION,
  type DoctrineComponentScore,
  type DoctrineEvaluation,
  type NarrativeEvaluation,
  type RatingBand,
  type RevisionId,
  type StressOutputs,
  type StressScenarioOutput,
} from '@cre/contracts';
import type {
  Analysis,
  CreditScore,
  CreditScoreCategory,
  FindingCategory,
  StressScenario,
} from '@cre/shared';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import { synthesizeUwModelFromGraph } from './synthesize-uw-model-from-graph.js';

export function projectLegacyAnalysisFromGraph(
  analysis: Analysis,
  store: RecordGraphStore,
): Analysis {
  const link = analysis.graphRevisionId;
  if (link === null || link === undefined || link.length === 0) {
    return analysis;
  }

  const envelope = store.getRevisionEnvelope(link as RevisionId);
  if (envelope === null) {
    return analysis;
  }

  const narrative = store.getLatestNarrativeForAdjustedInputs(
    envelope.adjustedInputsId,
    NARRATIVE_ENGINE_VERSION,
  );
  const doctrine = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);

  // Independent fallbacks: if NE is missing keep legacy executiveSummary; if DE
  // is missing keep legacy creditScore. Either projection alone is still useful.
  const projectedExecutiveSummary = narrative !== null
    ? projectExecutiveSummary(narrative)
    : analysis.executiveSummary;
  const projectedCreditScore = doctrine !== null
    ? projectCreditScore(doctrine)
    : analysis.creditScore;

  // uwModel: synthesize ONLY when the legacy slot is null (promote-from-graph
  // initial state). If an analyst-edited legacy uwModel already exists, keep it.
  // If synthesis returns null (graph chain doesn't resolve), keep whatever's
  // there. The synthesis function performs its own envelope lookup, so this
  // overlay is safe to call without precomputed records.
  const projectedUwModel = analysis.uwModel === null
    ? (synthesizeUwModelFromGraph(link as RevisionId, store) ?? analysis.uwModel)
    : analysis.uwModel;

  // stressScenarios: project from StressOutputs ONLY when the legacy
  // stressScenarios array is empty (promote-from-graph initial state). Any
  // already-populated legacy stress (e.g. from a prior handleRunStress) is
  // preserved. DE resolution gates this: without DE we can't reach
  // stressOutputsId, so the projection is short-circuited.
  let projectedStressScenarios = analysis.stressScenarios;
  if ((analysis.stressScenarios?.length ?? 0) === 0 && doctrine !== null) {
    const stressOutputs = store.getStressOutputs(doctrine.stressOutputsId);
    if (stressOutputs !== null) {
      projectedStressScenarios = projectStressScenarios(stressOutputs);
    }
  }

  // mitigationsNarrative: passthrough of NE.mitigationSuggestions when NE
  // resolves; null otherwise. Independent of the legacy `mitigations[]` cards
  // — the projector never touches that array. The page chooses which surface
  // to render based on analysis.graphRevisionId.
  const projectedMitigationsNarrative = narrative !== null
    ? narrative.mitigationSuggestions
    : (analysis.mitigationsNarrative ?? null);

  return {
    ...analysis,
    executiveSummary: projectedExecutiveSummary,
    creditScore: projectedCreditScore,
    uwModel: projectedUwModel,
    stressScenarios: projectedStressScenarios,
    mitigationsNarrative: projectedMitigationsNarrative,
  };
}

/**
 * Project graph StressOutputs into legacy StressScenario[] shape.
 *
 * Field map (StressScenarioOutput → StressScenario):
 *   - name                     ← name (verbatim)
 *   - results.noi              ← noi (null coerced to 0 — legacy requires
 *                                 number; graph noi may be null for
 *                                 not-computable scenarios)
 *   - results.dscr/ltv/        ← passthrough (legacy already nullable)
 *     debtYield/impliedValue
 *   - results.dscrBreached/    ← breaches.includes(metric) ? true :
 *     ltvBreached/                skipped.includes(metric) ? null : false
 *     debtYieldBreached
 *   - breaksCovenants          ← breaches.length > 0
 *   - covenantBreaches         ← humanized breach strings
 *   - covenantSkips            ← humanized skip strings
 *   - adjustments              ← all zeros (graph stores STRESS_METHOD per-run,
 *                                 not per-scenario delta values; the legacy
 *                                 adjustments object isn't displayed in the
 *                                 stress tab — purely structural).
 */
function projectStressScenarios(stressOutputs: StressOutputs): StressScenario[] {
  return stressOutputs.scenarios.map(projectStressScenario);
}

function projectStressScenario(s: StressScenarioOutput): StressScenario {
  const dscrBreached = breachFlag(s.breaches, s.skipped, 'DSCR');
  const ltvBreached = breachFlag(s.breaches, s.skipped, 'LTV');
  const debtYieldBreached = breachFlag(s.breaches, s.skipped, 'DEBT_YIELD');
  return {
    name: s.name,
    adjustments: { vacancyDelta: 0, rentDelta: 0, capRateDelta: 0, interestRateDelta: 0 },
    results: {
      noi: s.noi ?? 0,
      dscr: s.dscr,
      ltv: s.ltv,
      debtYield: s.debtYield,
      impliedValue: s.value,
      dscrBreached,
      ltvBreached,
      debtYieldBreached,
    },
    breaksCovenants: s.breaches.length > 0,
    covenantBreaches: s.breaches.map(humanizeBreach),
    covenantSkips: s.skipped.map(humanizeBreach),
  };
}

function breachFlag(
  breaches: readonly StressScenarioOutput['breaches'][number][],
  skipped: readonly StressScenarioOutput['skipped'][number][],
  metric: 'DSCR' | 'LTV' | 'DEBT_YIELD',
): boolean | null {
  if (breaches.includes(metric)) return true;
  if (skipped.includes(metric)) return null;
  return false;
}

function humanizeBreach(b: 'DSCR' | 'LTV' | 'DEBT_YIELD'): string {
  switch (b) {
    case 'DSCR':       return 'DSCR covenant';
    case 'LTV':        return 'LTV covenant';
    case 'DEBT_YIELD': return 'Debt Yield covenant';
  }
}

function projectExecutiveSummary(narrative: NarrativeEvaluation): string {
  return narrative.executiveSummary;
}

/**
 * Project DoctrineEvaluation → legacy CreditScore.
 *
 * Mapped fields:
 *   - overall          ← finalScore (rounded; legacy display is an int)
 *   - riskTier         ← ratingBand mapped to legacy 4-tier vocabulary
 *   - categories[]     ← componentScores[] (bijective, see projectCategory)
 *
 * Unmapped fields (no DoctrineEvaluation source — defaulted):
 *   - recommendation   = 'further_review' (safe non-actionable)
 *   - narrative        = '' (Score tab hides the card when falsy)
 *   - whyThisScore     = ''
 *   - howToImprove     = ''
 *
 * Per-category `tier` is intentionally left undefined here; the route handler
 * re-runs `applyCreditPolicyBandsToAnalysis` after projection, which decorates
 * each category with the doctrine-owned `classifyCategoryTier(score)` band.
 */
function projectCreditScore(doctrine: DoctrineEvaluation): CreditScore {
  return {
    overall: Math.round(doctrine.finalScore),
    categories: doctrine.componentScores.map(projectCategory),
    recommendation: 'further_review',
    narrative: '',
    riskTier: ratingBandToRiskTier(doctrine.ratingBand),
    whyThisScore: '',
    howToImprove: '',
  };
}

function projectCategory(c: DoctrineComponentScore): CreditScoreCategory {
  return {
    // Vocabulary mismatch — DoctrineComponentId is not in the FindingCategory
    // enum, but page.tsx displays it via `cat.category.replace('_', ' ')`
    // which renders cleanly ("Market Alignment", "Data Confidence"). Mirrors
    // rendered-analysis.ts:197 which uses componentId directly as `name`.
    category: c.componentId as unknown as FindingCategory,
    score: c.score,
    maxScore: 100,
    weight: c.weight,
    weightedScore: c.contribution,
    findings: [],
    explanation: '',
  };
}

/**
 * Map doctrine 4-band vocabulary to legacy 4-tier vocabulary.
 *   Strong     (>=75) → strong
 *   Acceptable (>=60) → acceptable
 *   Weak       (>=50) → watchlist   (closest analog; both yellow-zone)
 *   High Risk  (>= 0) → high_risk
 *
 * The two threshold sets are NOT aligned (doctrine: 75/60/50/0; legacy:
 * 85/70/50/—). When projecting, the DOCTRINE band wins per "numbers projected
 * into legacy must match what the new-spine view would show".
 */
function ratingBandToRiskTier(band: RatingBand): CreditScore['riskTier'] {
  switch (band) {
    case 'Strong':     return 'strong';
    case 'Acceptable': return 'acceptable';
    case 'Weak':       return 'watchlist';
    case 'High Risk':  return 'high_risk';
  }
}
