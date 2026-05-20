/**
 * Stage 10 orchestrator — `buildDoctrineEvaluation` (Batch 5c).
 *
 * Wires 5a component scorers + 5b asset-type adjusters + 5c score adjuster + rating-band
 * assignment + reason/flag aggregation into a single `DoctrineEvaluation` record.
 *
 * Pipeline order (per audit §A.4 + 3c2b spec):
 *   1. Run all 7 component scorers → flat `componentScores[]`
 *   2. Compute `mechanicalScore` (average of mechanical entries' scores; 0–100)
 *   3. Compute `weightedAggregate` (sum of contributions)
 *   4. Run asset-type adjusters → `assetTypeAdjustments[]`
 *   5. Run score adjusters (False_negative_guard / False_positive_guard) with ±25 envelope
 *   6. `finalScore = clamp(weightedAggregate + assetTypeSum + scoreAdjustmentSum, 0, 100)`
 *   7. Assign rating band per `RATING_BANDS`
 *   8. Aggregate reasons + flags
 *   9. Stamp content-hash id
 *
 * Architecture rules enforced:
 *   - No raw `ExtractionResult` reads.
 *   - No re-derivation of canonical metrics (NOI / DSCR / LTV / value).
 *   - No write-back to upstream records (Readonly types prevent).
 *   - Score adjustments capped at ±25 envelope; throws `ScoreAdjustmentEnvelopeViolation`
 *     payload via JudgmentEngineError if implementation arithmetic exceeds.
 *   - All reasons are bounded `DoctrineReasonCode` literal-union members.
 */

import {
  DOCTRINE_VERSION,
  DoctrineFlags,
  DoctrineReasonCodes,
  DoctrineRules,
  JUDGMENT_ENGINE_VERSION,
  RATING_BANDS,
  SCORE_ADJUSTMENT_ENVELOPE,
  STRESS_ENGINE_VERSION,
  VALUATION_ENGINE_VERSION,
  type AdjustedInputs,
  type AssetProfile,
  type CrossCheckResult,
  type DoctrineAssetTypeAdjustment,
  type DoctrineComponentScore,
  type DoctrineEvaluation,
  type DoctrineFlag,
  type DoctrineReasonCode,
  type DoctrineRuleId,
  type DoctrineScoreAdjustment,
  type ExtractionResultId,
  type LibrarySnapshot,
  type NarrativeFacts,
  type RatingBand,
  type StressOutputs,
  type ValuationConclusion,
} from '@cre/contracts';
import { computeDoctrineEvaluationId } from '../../util/content-hash.js';
import {
  scoreCapitalization,
  scoreDataConfidence,
  scoreDurability,
  scoreMaturityRisk,
  scoreMechanical,
  scoreNormalization,
  scoreTermRisk,
} from './components.js';
import { evaluateAssetTypeAdjusters } from './asset-type-adjusters.js';

/* ------------------------------- input shape ------------------------------ */

export interface BuildDoctrineEvaluationArgs {
  readonly adjustedInputs: AdjustedInputs;
  readonly assetProfile: AssetProfile;
  readonly librarySnapshot: LibrarySnapshot;
  readonly narrativeFacts: NarrativeFacts;
  readonly crossCheckResult: CrossCheckResult;     // pass empty findings if not available
  readonly stressOutputs: StressOutputs;
  readonly valuationConclusion: ValuationConclusion;
  // 6.5 — extraction-result FK is stamped on the evaluation root so the hydration bundle is
  // single-hop reachable. Doctrine does not read extraction content; only the id is recorded.
  readonly extractionResultId: ExtractionResultId;
}

/* ----------------------------- §12 score adjusters ----------------------- */

const FALSE_NEG_POINTS = 12 as const;
const FALSE_POS_POINTS = -15 as const;

function evaluateFalseNegativeGuard(args: {
  readonly mechanicalScore: number;
  readonly adjustedInputs: AdjustedInputs;
  readonly narrativeFacts: NarrativeFacts;
  readonly valuationConclusion: ValuationConclusion;
}): DoctrineScoreAdjustment {
  const { mechanicalScore, adjustedInputs, narrativeFacts, valuationConclusion } = args;

  const mechWeak = mechanicalScore < 50;
  const t12Present = !adjustedInputs.dataQualityFlags.includes('JE_T12_MISSING');
  const t12TrendOk = narrativeFacts.t12NoiTrend !== null && narrativeFacts.t12NoiTrend !== 'down';
  const rollover = adjustedInputs.metrics.pctIncomeExpiringWithinTerm;
  const lowRollover = rollover !== null && rollover <= 0.30;
  const finalValue = valuationConclusion.finalValue;
  const anchor = valuationConclusion.appraisalValue ?? valuationConclusion.asrValue;
  const valuationDisciplined =
    finalValue !== null && anchor !== null && anchor > 0 && finalValue <= 1.10 * anchor;

  const fired = mechWeak && t12Present && t12TrendOk && lowRollover && valuationDisciplined;

  return {
    ruleId: DoctrineRules.FALSE_NEGATIVE_GUARD,
    fired,
    points: fired ? FALSE_NEG_POINTS : 0,
    reasonCode: DoctrineReasonCodes.FALSE_NEG_DURABLE_CASHFLOW,
  };
}

function evaluateFalsePositiveGuard(args: {
  readonly componentScores: readonly DoctrineComponentScore[];
  readonly valuationConclusion: ValuationConclusion;
}): DoctrineScoreAdjustment {
  const { componentScores, valuationConclusion } = args;

  const overvaluation = valuationConclusion.capsApplied.some(
    c => c.reason === DoctrineFlags.OVERVALUATION_GUARDRAIL_TRIGGERED,
  );
  const aggressiveUw = componentScores.some(s =>
    s.reasonCodes.includes(DoctrineReasonCodes.UW_AGGRESSIVE_ABOVE_T12),
  );
  const capexShortfall = componentScores.some(s =>
    s.reasonCodes.includes(DoctrineReasonCodes.PCA_REPAIRS_UNDERFUNDED),
  );

  const fired = overvaluation || aggressiveUw || capexShortfall;

  return {
    ruleId: DoctrineRules.FALSE_POSITIVE_GUARD,
    fired,
    points: fired ? FALSE_POS_POINTS : 0,
    reasonCode: DoctrineReasonCodes.FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED,
  };
}

/**
 * Apply the ±25 envelope. If the absolute sum of `points` exceeds 25, scale proportionally so
 * the sum is exactly ±25 (sign preserved). v1.0 max possible is +12 / -15 = ±15, so the cap
 * never fires; the clamp is defensive.
 */
function applyScoreEnvelope(
  adjustments: readonly DoctrineScoreAdjustment[],
): readonly DoctrineScoreAdjustment[] {
  const total = adjustments.reduce((s, a) => s + a.points, 0);
  if (Math.abs(total) <= SCORE_ADJUSTMENT_ENVELOPE) {
    return adjustments;
  }
  const scale = SCORE_ADJUSTMENT_ENVELOPE / Math.abs(total);
  return adjustments.map(a => ({
    ...a,
    points: a.points * scale,
  }));
}

/* ------------------------------ rating bands ------------------------------ */

function assignRatingBand(finalScore: number): RatingBand {
  for (const band of RATING_BANDS) {
    if (finalScore >= band.minScore) return band.name;
  }
  return 'High Risk';
}

/* --------------------------- mechanical aggregate ------------------------- */

function computeMechanicalAggregate(componentScores: readonly DoctrineComponentScore[]): number {
  const mech = componentScores.filter(s => s.componentId === 'mechanical');
  if (mech.length === 0) return 0;
  return mech.reduce((sum, s) => sum + s.score, 0) / mech.length;
}

/* --------------------------- reason aggregation --------------------------- */

function aggregateReasons(
  componentScores: readonly DoctrineComponentScore[],
  assetTypeAdjustments: readonly DoctrineAssetTypeAdjustment[],
  scoreAdjustments: readonly DoctrineScoreAdjustment[],
): readonly { ruleId: DoctrineRuleId; reasonCode: DoctrineReasonCode }[] {
  const out: { ruleId: DoctrineRuleId; reasonCode: DoctrineReasonCode }[] = [];
  for (const cs of componentScores) {
    for (const rc of cs.reasonCodes) {
      out.push({ ruleId: cs.ruleId, reasonCode: rc });
    }
  }
  for (const aa of assetTypeAdjustments) {
    out.push({ ruleId: aa.ruleId, reasonCode: aa.reasonCode });
  }
  for (const sa of scoreAdjustments) {
    if (sa.fired) {
      out.push({ ruleId: sa.ruleId, reasonCode: sa.reasonCode });
    }
  }
  return out;
}

/* ---------------------------- flag aggregation --------------------------- */

const REASON_TO_FLAG_MAP: Partial<Record<DoctrineReasonCode, DoctrineFlag>> = {
  [DoctrineReasonCodes.UW_AGGRESSIVE_ABOVE_T12]:           DoctrineFlags.UW_ABOVE_T12_AGGRESSIVE,
  [DoctrineReasonCodes.VACANCY_TOO_LOW_VS_HISTORY]:        DoctrineFlags.VACANCY_UNDERSTATED,
  [DoctrineReasonCodes.EXPENSES_AGGRESSIVELY_BELOW_T12]:   DoctrineFlags.EXPENSES_UNDERSTATED,
  [DoctrineReasonCodes.PCA_REPAIRS_UNDERFUNDED]:           DoctrineFlags.CAPEX_SHORTFALL,
  [DoctrineReasonCodes.TILC_UNFUNDED_HIGH_ROLLOVER]:       DoctrineFlags.TILC_UNFUNDED_HIGH_ROLLOVER,
  [DoctrineReasonCodes.ROLLOVER_HIGH]:                     DoctrineFlags.ROLLOVER_TERM_HIGH,
  [DoctrineReasonCodes.TENANT_CONCENTRATION_HIGH]:         DoctrineFlags.TENANT_CONCENTRATION_HIGH,
  [DoctrineReasonCodes.MATURITY_REFI_INFEASIBLE]:          DoctrineFlags.MATURITY_REFI_RISK_HIGH,
  [DoctrineReasonCodes.INSUFFICIENT_DATA]:                 DoctrineFlags.INSUFFICIENT_DATA,
};

function aggregateFlags(
  componentScores: readonly DoctrineComponentScore[],
  assetTypeAdjustments: readonly DoctrineAssetTypeAdjustment[],
  valuationConclusion: ValuationConclusion,
): readonly DoctrineFlag[] {
  const flags = new Set<DoctrineFlag>();
  for (const cs of componentScores) {
    for (const rc of cs.reasonCodes) {
      const flag = REASON_TO_FLAG_MAP[rc];
      if (flag !== undefined) flags.add(flag);
    }
  }
  for (const aa of assetTypeAdjustments) {
    flags.add(aa.flag);
  }
  for (const cap of valuationConclusion.capsApplied) {
    flags.add(cap.reason);
  }
  for (const haircut of valuationConclusion.haircutsApplied) {
    flags.add(haircut.reason);
  }
  for (const flag of valuationConclusion.valuationFlags) {
    flags.add(flag);
  }
  return Array.from(flags);
}

/* --------------------------------- main ---------------------------------- */

export function buildDoctrineEvaluation(args: BuildDoctrineEvaluationArgs): DoctrineEvaluation {
  const {
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    crossCheckResult,
    stressOutputs,
    valuationConclusion,
    extractionResultId,
  } = args;

  /* Phase 1 — run 5a component scorers */
  const componentScores: DoctrineComponentScore[] = [
    ...scoreMechanical({
      dscr: adjustedInputs.metrics.dscr,
      debtYield: adjustedInputs.metrics.debtYield,
      ltvAppraisal: adjustedInputs.metrics.ltvAppraisal,
    }),
    ...scoreDurability({ adjustedInputs, crossCheck: crossCheckResult }),
    ...scoreNormalization({ adjustedInputs, narrativeFacts }),
    ...scoreCapitalization({ adjustedInputs }),
    ...scoreTermRisk({ adjustedInputs }),
    ...scoreMaturityRisk({ adjustedInputs, valuationConclusion }),
    ...scoreDataConfidence({ adjustedInputs }),
  ];

  /* Phase 2 — mechanicalScore (0–100 average) */
  const mechanicalScore = computeMechanicalAggregate(componentScores);

  /* Phase 3 — weightedAggregate */
  const weightedAggregate = componentScores.reduce((sum, s) => sum + s.contribution, 0);

  /* Phase 4 — asset-type adjusters */
  const assetTypeAdjustments = evaluateAssetTypeAdjusters({
    assetProfile,
    adjustedInputs,
    narrativeFacts,
  });

  /* Phase 5 — score adjusters with ±25 envelope */
  const rawScoreAdjustments: DoctrineScoreAdjustment[] = [
    evaluateFalseNegativeGuard({ mechanicalScore, adjustedInputs, narrativeFacts, valuationConclusion }),
    evaluateFalsePositiveGuard({ componentScores, valuationConclusion }),
  ];
  const scoreAdjustments = applyScoreEnvelope(rawScoreAdjustments);

  /* Phase 6 — finalScore */
  const assetTypePenaltySum = assetTypeAdjustments.reduce((sum, a) => sum + a.points, 0);
  const scoreAdjustmentSum = scoreAdjustments.reduce((sum, a) => sum + a.points, 0);
  const finalScore = Math.max(
    0,
    Math.min(100, weightedAggregate + assetTypePenaltySum + scoreAdjustmentSum),
  );

  /* Phase 7 — rating band */
  const ratingBand = assignRatingBand(finalScore);

  /* Phase 8 — reasons + flags */
  const reasons = aggregateReasons(componentScores, assetTypeAdjustments, scoreAdjustments);
  const flags = aggregateFlags(componentScores, assetTypeAdjustments, valuationConclusion);

  /* Phase 9 — stamp */
  const body = {
    analysisAsOfDate: adjustedInputs.analysisAsOfDate,
    doctrineVersion: DOCTRINE_VERSION,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId: adjustedInputs.id,
    librarySnapshotId: librarySnapshot.id,
    narrativeFactsId: narrativeFacts.id,
    crossCheckResultId: crossCheckResult.id,
    stressOutputsId: stressOutputs.id,
    valuationConclusionId: valuationConclusion.id,
    assetProfileId: assetProfile.id,
    extractionResultId,
    mechanicalScore,
    componentScores,
    weightedAggregate,
    assetTypeAdjustments,
    scoreAdjustments,
    finalScore,
    ratingBand,
    flags,
    reasons,
  };
  return { id: computeDoctrineEvaluationId(body), ...body } as DoctrineEvaluation;
}
