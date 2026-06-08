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
  type DoctrineCoverage,
  type DoctrineEvaluation,
  type DoctrineFlag,
  type DoctrineReasonCode,
  type DoctrineRuleId,
  type DoctrineScoreAdjustment,
  type ExtractionResultId,
  type LibrarySnapshot,
  type NarrativeFacts,
  type RatingBand,
  type RentRoll,
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
import { isApplicable, RISK_DIMENSION_RULES } from './applicability.js';

/* ----------------------- v1.1 desk tunables (DEFERRED HASH-COVERAGE) ------
 * Like v1.0 → v1.10 judgment, these doctrine-side desk constants are NOT in
 * buildDoctrineHashSnapshot today. Tracked on the deferred
 * doctrine-desk-hashing thread; for now, DOCTRINE_VERSION 1.1 anchors them.
 *   - COVERAGE_FLOOR_THRESHOLD          : 0.50  (50% evaluated weight floor)
 *   - Risk-dim set                       : RISK_DIMENSION_RULES (applicability.ts)
 *   - Band cap target                    : 'Acceptable' (max band when risk-dim excluded)
 * Changing any of these requires a manual DOCTRINE_VERSION bump until the
 * snapshot is widened to include them.
 */
const COVERAGE_FLOOR_THRESHOLD = 0.50;

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
  // Phase 1 (rent-roll-node) — typed RentRoll, persisted as a first-class graph node by the
  // ingest layer. Doctrine does not read its contents; only the id is recorded. Nullable —
  // a deal genuinely may have no rent roll. Stamping changes DoctrineEvaluation's content-hash
  // id; mirrors the Batch 6.5 extractionResultId precedent above.
  readonly rentRoll: RentRoll | null;
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
  // 2026-05-31: JE_T12_MISSING renamed JE_TRAILING_ACTUALS_MISSING. The guard's
  // semantic remains "is there usable CF data" — both the trailing-actuals flag
  // (which now fires on every deal until class-(b) lands) AND the in-place flag
  // signal absence of CF data, so we check both. The guard requires BOTH to be
  // ABSENT to consider CF "present" — symmetric to the old single-flag check
  // (now widened across the two new flags).
  const t12Present =
    !adjustedInputs.dataQualityFlags.includes('JE_TRAILING_ACTUALS_MISSING') ||
    !adjustedInputs.dataQualityFlags.includes('JE_IN_PLACE_MISSING');
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
  // v1.1: mean of mechanical-component scores INCLUDED in the aggregate
  // (status === 'scored'). Excluded statuses (insufficient_data /
  // not_applicable) leave the denominator entirely — matches the
  // weightedAggregate exclude-renormalize doctrine. If all mechanicals are
  // excluded (degenerate; the coverage-floor gate fires separately), 0.
  const mech = componentScores.filter(
    s => s.componentId === 'mechanical' && s.status === 'scored',
  );
  if (mech.length === 0) return 0;
  return mech.reduce((sum, s) => sum + s.score, 0) / mech.length;
}

/**
 * v1.1 weighted aggregate: renormalize over status === 'scored' only.
 *   aggregate = (Σ scored contribution) × 100 / (Σ scored weight)
 * Both 'insufficient_data' and 'not_applicable' leave the denominator. The
 * band cap (risk-dim insufficient_data) + coverage floor (<50% scored weight)
 * are what keep that safe. Returns 0 when no components are 'scored'.
 */
function computeWeightedAggregateV11(
  componentScores: readonly DoctrineComponentScore[],
): number {
  const scored = componentScores.filter(s => s.status === 'scored');
  const scoredWeight = scored.reduce((s, c) => s + c.weight, 0);
  if (scoredWeight === 0) return 0;
  const scoredContribution = scored.reduce((s, c) => s + c.contribution, 0);
  return (scoredContribution * 100) / scoredWeight;
}

/**
 * v1.1 coverage summary. Computed from the per-component status discriminator.
 * Drives the band-cap + insufficient-coverage-gate downstream.
 *
 * `excludedRiskDimRuleIds` — risk-dim rules with status='insufficient_data'.
 * Risk-dim rules with status='not_applicable' are NOT excluded (rule doesn't
 * apply, absence isn't a coverage gap).
 */
function buildCoverage(
  componentScores: readonly DoctrineComponentScore[],
): DoctrineCoverage {
  let evaluatedWeight = 0;
  let totalEvaluableWeight = 0;
  const excludedRiskDimRuleIds: DoctrineRuleId[] = [];
  for (const cs of componentScores) {
    if (cs.status === 'not_applicable') continue;
    totalEvaluableWeight += cs.weight;
    if (cs.status === 'scored') {
      evaluatedWeight += cs.weight;
    } else if (cs.status === 'insufficient_data' && RISK_DIMENSION_RULES.has(cs.ruleId)) {
      excludedRiskDimRuleIds.push(cs.ruleId);
    }
  }
  const evaluatedPct =
    totalEvaluableWeight > 0 ? evaluatedWeight / totalEvaluableWeight : 0;
  return {
    evaluatedWeight,
    totalEvaluableWeight,
    evaluatedPct,
    excludedRiskDimRuleIds,
    bandCapApplied: false, // set later when the band is clamped
    insufficientCoverageGate: evaluatedPct < COVERAGE_FLOOR_THRESHOLD,
  };
}

/**
 * Band cap (v1.3 graduated): clamps by COUNT of risk-dim rules in
 * insufficient_data status.
 *
 *   n == 0 → no cap.
 *   n == 1 → clamp to max 'Acceptable' (the v1.1 flat-cap behavior).
 *   n >= 2 → clamp to max 'Weak' (Strong → Weak, Acceptable → Weak).
 *
 * Updates the v1.1 flat-cap decision per calibration finding: the flat
 * cap let tenant-driven deals missing multiple risk dims (TENANT_CONCENTRATION
 * + ROLLOVER + TI_LC sinks because rent roll absent, plus UW_VS_T12 sink
 * when no trailing actual) sail to a clean Acceptable — exactly the
 * Sentinel Square II / Naugatuck Valley over-rating pattern.
 *
 * Asymmetric trade: bites data-thin tenant-driven deals (Office / Retail /
 * Industrial) harder; doesn't touch Multifamily / Hotel / SelfStorage / MHC
 * where the tenant-driven dims are 'not_applicable' (not counted in
 * excludedRiskDimRuleIds). Production deals with rent rolls also unaffected
 * (those dims score).
 *
 * Does NOT touch finalScore — the cap is a disposition/display clamp, not
 * a score adjustment. bandCapApplied = true iff the band was actually
 * lowered (no-op clamps don't register).
 *
 * The graduation threshold (n >= 2 → Weak) is a desk tunable; logged on
 * the deferred doctrine-desk-hashing thread alongside COVERAGE_FLOOR_THRESHOLD
 * and RISK_DIMENSION_RULES. Manual DOCTRINE_VERSION bump required to change.
 */
function applyBandCap(
  preCapBand: RatingBand,
  excludedRiskDimRuleIds: readonly DoctrineRuleId[],
): { band: RatingBand; applied: boolean } {
  const n = excludedRiskDimRuleIds.length;
  if (n === 0) return { band: preCapBand, applied: false };

  // n >= 2 → clamp to Weak (covers Strong, Acceptable; Weak/High Risk no-op).
  if (n >= 2) {
    if (preCapBand === 'Strong' || preCapBand === 'Acceptable') {
      return { band: 'Weak', applied: true };
    }
    return { band: preCapBand, applied: false };
  }

  // n == 1 → clamp to Acceptable (covers Strong only).
  if (preCapBand === 'Strong') return { band: 'Acceptable', applied: true };
  return { band: preCapBand, applied: false };
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
    rentRoll,
  } = args;

  /* Phase 1 — run 5a component scorers.
   *
   * v1.2 LTV derived fallback: compute `ltvDerived = loanAmount /
   * valuationConclusion.finalValue` for the LTV scorer. The valuation engine
   * populates `finalValue` on essentially every deal (it falls back to
   * NOI/cap when no anchor is supplied — see valuation.service.ts:94-99).
   * When ltvAppraisal is null (production reality — extraction.appraisal
   * hardcoded null at build-extraction-result.ts:434), scoreLtv now falls
   * back to ltvDerived and attaches LTV_DERIVED_FROM_IMPLIED_VALUE so the
   * path is auditable. Must land with the UW-vs-T12 fill: once the cap
   * lifts on deals with t12, a high-LTV deal would otherwise sail to
   * Strong with LTV silently excluded (leverage unassessed). */
  const loanAdjusted = adjustedInputs.loan.loanAmount.adjusted;
  const finalValue = valuationConclusion.finalValue;
  const ltvDerived =
    finalValue !== null && finalValue > 0 ? loanAdjusted / finalValue : null;

  const rawComponentScores: DoctrineComponentScore[] = [
    ...scoreMechanical({
      dscr: adjustedInputs.metrics.dscr,
      debtYield: adjustedInputs.metrics.debtYield,
      ltvAppraisal: adjustedInputs.metrics.ltvAppraisal,
      ltvDerived,
    }),
    ...scoreDurability({ adjustedInputs, crossCheck: crossCheckResult }),
    ...scoreNormalization({ adjustedInputs, narrativeFacts }),
    ...scoreCapitalization({ adjustedInputs }),
    ...scoreTermRisk({ adjustedInputs }),
    ...scoreMaturityRisk({ adjustedInputs, valuationConclusion }),
    ...scoreDataConfidence({ adjustedInputs }),
  ];

  /* v1.1: overlay 'not_applicable' status post-hoc. The scorer functions don't
   * see assetProfile; this orchestrator does. `isApplicable` returns false for
   * tenant-driven rules (TENANT_CONCENTRATION, ROLLOVER_WITHIN_TERM,
   * TI_LC_VS_ROLLOVER) on non-tenant-driven asset classes; true otherwise.
   */
  const componentScores: DoctrineComponentScore[] = rawComponentScores.map((cs) =>
    !isApplicable(cs.ruleId, assetProfile)
      ? { ...cs, status: 'not_applicable' as const }
      : cs
  );

  /* Phase 2 — mechanicalScore (v1.1: filters status === 'scored') */
  const mechanicalScore = computeMechanicalAggregate(componentScores);

  /* Phase 3 — weightedAggregate (v1.1: renormalize over status === 'scored').
   * Excludes both 'insufficient_data' and 'not_applicable' from the
   * denominator. The cap + coverage gate (Phase 7 below) keep that safe. */
  const weightedAggregate = computeWeightedAggregateV11(componentScores);

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

  /* Phase 7 — rating band + v1.1 coverage / cap / floor.
   * (a) Assign band from finalScore (unchanged 4-band cutoffs).
   * (b) Build coverage summary from component statuses.
   * (c) Apply band cap: any risk-dim with status='insufficient_data' and
   *     pre-cap band='Strong' → clamp to 'Acceptable'. Does NOT modify finalScore.
   * (d) Coverage-floor gate: evaluatedPct < 0.50 → push INSUFFICIENT_COVERAGE_GATE flag.
   * Order: coverage built first, then cap reads excludedRiskDimRuleIds, then
   * the coverage object is finalized with bandCapApplied. */
  const preCapBand = assignRatingBand(finalScore);
  const coverageDraft = buildCoverage(componentScores);
  const capResult = applyBandCap(preCapBand, coverageDraft.excludedRiskDimRuleIds);
  const ratingBand = capResult.band;
  const coverage: DoctrineCoverage = {
    ...coverageDraft,
    bandCapApplied: capResult.applied,
  };

  /* Phase 8 — reasons + flags (v1.1 adds INSUFFICIENT_COVERAGE_GATE flag) */
  const reasons = aggregateReasons(componentScores, assetTypeAdjustments, scoreAdjustments);
  const flagsList: DoctrineFlag[] = [
    ...aggregateFlags(componentScores, assetTypeAdjustments, valuationConclusion),
  ];
  if (coverage.insufficientCoverageGate) {
    flagsList.push(DoctrineFlags.INSUFFICIENT_COVERAGE_GATE);
  }
  if (coverage.bandCapApplied) {
    flagsList.push(DoctrineFlags.BAND_CAPPED);
  }
  const flags = flagsList;

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
    rentRollId: rentRoll?.id ?? null,
    mechanicalScore,
    componentScores,
    weightedAggregate,
    assetTypeAdjustments,
    scoreAdjustments,
    finalScore,
    ratingBand,
    flags,
    reasons,
    coverage,
  };
  return { id: computeDoctrineEvaluationId(body), ...body } as DoctrineEvaluation;
}
