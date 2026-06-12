/**
 * doctrine-clean / adapters / dealresult-to-doctrine-evaluation.ts
 *
 * Drop-in OUTPUT bridge: EvaluateDealResult → DoctrineEvaluation.
 *
 * Maps the clean doctrine's output into the EXISTING old `DoctrineEvaluation`
 * contract shape so the live-pipeline swap (next step) needs ZERO downstream
 * changes. This is Strategy (a) per the retire-old step-1 inventory:
 * preserve the persisted-record contract, accept some output lossiness
 * (sponsor modifier, dim 9, full override traces), then a follow-on batch
 * extends the contract for full fidelity.
 *
 * FENCE: this file targets ONLY the old OUTPUT contract TYPES. It reads
 * NO old scoring LOGIC. It does NOT import:
 *   - any `services/doctrine/*` module
 *   - any `services/judgment/*` module
 *   - `services/handbook/*`
 *   - the old `manifesto_rules.json`
 *   - the old `buildDoctrineEvaluation` function
 * It DOES import the contract TYPES from `@cre/contracts` — that's the
 * point of a drop-in bridge: produce a value of the existing TYPE so the
 * caller's downstream consumers see no change.
 *
 * SCORE INVERSION (the load-bearing convention shift):
 *   The OLD contract uses GOODNESS: finalScore 0-100, HIGHER = SAFER,
 *   ratingBand 'Strong' = best. The CLEAN doctrine uses BADNESS:
 *   ratedRisk 0-1, HIGHER = RISKIER, ratingBand 'Decline' = worst. The
 *   bridge inverts: `finalScore = (1 - ratedRisk) * 100`. Same for
 *   per-component scores (each dim's riskContribution × 100 inverted).
 *   The OLD `RATING_BANDS` table then classifies the inverted goodness
 *   score into the OLD 4-band union — no separate band-mapping table.
 *
 * INSUFFICIENT-DATA HANDLING:
 *   When the clean rating recommendation is 'InsufficientData', the
 *   bridge emits:
 *     - finalScore = 0 (lowest, matching old "no data → no credit")
 *     - ratingBand = 'High Risk' (old lowest-confidence band)
 *     - coverage.insufficientCoverageGate = true
 *     - INSUFFICIENT_DATA flag added to flags[]
 *
 * LOSSY MAPPINGS (documented; full fidelity in contract-extension batch):
 *   - SPONSOR (dim 9) — riskModifier, factor breakdown, asymmetry: NO old slot. Dropped.
 *   - STAGE-2 OVERRIDES — full trace (which signals at elevated+ etc.): folded
 *     into a single scoreAdjustment entry; the per-signal detail is lost.
 *   - PER-DIM RATIONALE — long-form rationale strings: not propagated (old
 *     `reasons[]` is bounded literal-union DoctrineReasonCode only).
 *
 * NO IMPORTS FROM OLD DOCTRINE / OLD SCORER / HANDBOOK / MANIFESTO.
 */
import type {
  AdjustedInputsId,
  AssetProfileId,
  CrossCheckResultId,
  DoctrineCoverage,
  DoctrineAssetTypeAdjustment,
  DoctrineComponentId,
  DoctrineComponentScore,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  DoctrineFlag,
  DoctrineReasonCode,
  DoctrineRuleId,
  DoctrineScoreAdjustment,
  DoctrineVersion,
  ExtractionResultId,
  ISODateTime,
  JudgmentEngineVersion,
  LibrarySnapshotId,
  NarrativeFactsId,
  RatingBand as OldRatingBand,
  RentRollId,
  StressOutputsId,
  StressEngineVersion,
  ValuationConclusionId,
  ValuationEngineVersion,
} from '@cre/contracts';
import {
  DOCTRINE_COMPONENT_IDS,
  DOCTRINE_COMPONENT_WEIGHTS,
  DoctrineFlags,
  DoctrineReasonCodes,
  DoctrineRules,
  RATING_BANDS,
  SCORE_ADJUSTMENT_ENVELOPE,
} from '@cre/contracts';
import type { EvaluateDealResult } from '../scoring/evaluate-deal.js';
import type { DimensionContribution } from '../types.js';

export interface BridgeIds {
  readonly evaluationId: DoctrineEvaluationId;
  readonly extractionResultId: ExtractionResultId;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly librarySnapshotId: LibrarySnapshotId;
  readonly narrativeFactsId: NarrativeFactsId;
  readonly crossCheckResultId: CrossCheckResultId;
  readonly stressOutputsId: StressOutputsId;
  readonly valuationConclusionId: ValuationConclusionId;
  readonly assetProfileId: AssetProfileId;
  readonly rentRollId: RentRollId | null;
}

export interface BridgeVersions {
  readonly doctrineVersion: DoctrineVersion;
  readonly judgmentEngineVersion: JudgmentEngineVersion;
  readonly stressEngineVersion: StressEngineVersion;
  readonly valuationEngineVersion: ValuationEngineVersion;
}

/**
 * Map clean dim id → old component id. The 9 clean dims compress into
 * the 8 old components per the doctrine YAML §3 component table. Some
 * old components have multiple clean dims; others have none and route to
 * 'not_applicable' status with score 0.
 *
 * Mapping:
 *   mechanical       ← LTV (1), DSCR (2), DY (3) — ratio family
 *   durability       ← asset-class (8), rollover (6), concentration (5)
 *   normalization    ← sustainable-cashflow normalization layer
 *   capitalization   ← cap-rate / valuation stress (7)
 *   market_alignment ← (no clean equivalent) — 'not_applicable'
 *   term_risk        ← (none separately; DSCR covers in 'mechanical') — 'not_applicable'
 *   maturity_risk    ← refinance feasibility (4)
 *   data_confidence  ← coverage record's confidence metric
 */
const COMPONENT_MAP: Readonly<Record<DoctrineComponentId, readonly string[]>> = {
  mechanical:        ['leverage-ltv', 'coverage-dscr', 'debt-yield'],
  durability:        ['asset-class', 'rollover', 'income-concentration'],
  normalization:     [],   // populated specially from normalization layer
  capitalization:    ['cap-rate-valuation-stress'],
  market_alignment:  [],
  term_risk:         [],
  maturity_risk:     ['refinance-feasibility'],
  data_confidence:   [],   // populated specially from coverage record
};

/** Map clean per-dim severity → old DoctrineFlag (best-effort; many drop). */
function severeFlagToOldFlag(dimId: string): DoctrineFlag | null {
  switch (dimId) {
    case 'refinance-feasibility':         return DoctrineFlags.MATURITY_REFI_RISK_HIGH;
    case 'income-concentration':          return DoctrineFlags.TENANT_CONCENTRATION_HIGH;
    case 'rollover':                      return DoctrineFlags.ROLLOVER_TERM_HIGH;
    case 'cap-rate-valuation-stress':     return DoctrineFlags.OVERVALUATION_GUARDRAIL_TRIGGERED;
    // No old slot for asset-class / leverage-ltv / coverage-dscr / debt-yield
    // at the high tier; these signals are reflected in finalScore but not as flags.
    default: return null;
  }
}

/** Map clean per-dim elevated+ → old DoctrineReasonCode (best-effort; lossy). */
function dimToReasonCode(dim: DimensionContribution): DoctrineReasonCode | null {
  if (typeof dim.riskContribution !== 'number' || dim.riskContribution < 0.55) return null;
  switch (dim.dimensionId) {
    case 'rollover':                      return DoctrineReasonCodes.ROLLOVER_HIGH;
    case 'income-concentration':          return DoctrineReasonCodes.TENANT_CONCENTRATION_HIGH;
    case 'refinance-feasibility':
      return dim.riskContribution >= 0.75
        ? DoctrineReasonCodes.MATURITY_REFI_INFEASIBLE
        : DoctrineReasonCodes.MATURITY_REFI_BORDERLINE;
    case 'coverage-dscr':                 return DoctrineReasonCodes.TERM_DSCR_THIN;
    default: return null;
  }
}

/** Map clean dim id → an old DoctrineRuleId for reasons[] best-effort. */
function dimToRuleId(dimId: string): DoctrineRuleId | null {
  switch (dimId) {
    case 'rollover':                      return DoctrineRules.ROLLOVER_WITHIN_TERM;
    case 'income-concentration':          return DoctrineRules.TENANT_CONCENTRATION;
    case 'refinance-feasibility':         return DoctrineRules.REFI_FEASIBILITY_STRESSED;
    case 'coverage-dscr':                 return DoctrineRules.DSCR_LEVEL;
    case 'leverage-ltv':                  return DoctrineRules.LTV_LEVEL;
    case 'debt-yield':                    return DoctrineRules.DEBT_YIELD_LEVEL;
    case 'cap-rate-valuation-stress':     return DoctrineRules.NO_VALUE_ABOVE_PRIMARY_ANCHOR;
    default: return null;
  }
}

/** Classify a goodness score (0-100) into the OLD 4-band table. */
function classifyOldBand(goodness: number): OldRatingBand {
  for (const band of RATING_BANDS) {
    if (goodness >= band.minScore) return band.name;
  }
  return 'High Risk';
}

/**
 * Build a DoctrineComponentScore for a clean component bucket.
 * Averages the per-dim goodness scores (inverted from riskContribution);
 * status reflects whether ANY dim resolved.
 */
function buildComponentScore(
  componentId: DoctrineComponentId,
  cleanDimIds: readonly string[],
  allDims: readonly DimensionContribution[],
  fallbackResolvedScore?: number,
  fallbackResolvedStatus?: 'scored' | 'not_applicable' | 'insufficient_data',
): DoctrineComponentScore {
  const weight = DOCTRINE_COMPONENT_WEIGHTS[componentId];
  // Component-special path (normalization, data_confidence): caller supplies
  // a pre-computed score + status.
  if (cleanDimIds.length === 0 && fallbackResolvedScore !== undefined && fallbackResolvedStatus !== undefined) {
    const score = Math.max(0, Math.min(100, fallbackResolvedScore));
    return {
      componentId,
      ruleId: DoctrineRules.DSCR_LEVEL,  // fallback rule id; downstream renderers don't gate on it for synthetic components
      rawValue: null,
      score,
      weight,
      contribution: score * weight / 100,
      reasonCodes: [],
      status: fallbackResolvedStatus,
    };
  }
  // Components with no clean dims and no fallback → not_applicable.
  if (cleanDimIds.length === 0) {
    return {
      componentId,
      ruleId: DoctrineRules.DSCR_LEVEL,
      rawValue: null,
      score: 0,
      weight,
      contribution: 0,
      reasonCodes: [],
      status: 'not_applicable',
    };
  }
  // Aggregate clean dims that map to this component.
  const dims = allDims.filter(d => cleanDimIds.includes(d.dimensionId));
  const applicable = dims.filter(d => d.applicability === 'applicable' && typeof d.riskContribution === 'number');
  const naAll = dims.length > 0 && dims.every(d => d.applicability === 'not-applicable-by-asset-type');
  if (applicable.length === 0) {
    return {
      componentId,
      ruleId: dimToRuleId(cleanDimIds[0]!) ?? DoctrineRules.DSCR_LEVEL,
      rawValue: null,
      score: 0,
      weight,
      contribution: 0,
      reasonCodes: naAll ? [] : [DoctrineReasonCodes.INSUFFICIENT_DATA],
      status: naAll ? 'not_applicable' : 'insufficient_data',
    };
  }
  const avgBadness = applicable.reduce((s, d) => s + (d.riskContribution as number), 0) / applicable.length;
  const goodness = Math.max(0, Math.min(100, (1 - avgBadness) * 100));
  const reasonCodes: DoctrineReasonCode[] = [];
  for (const d of applicable) {
    const rc = dimToReasonCode(d);
    if (rc !== null && !reasonCodes.includes(rc)) reasonCodes.push(rc);
  }
  return {
    componentId,
    ruleId: dimToRuleId(applicable[0]!.dimensionId) ?? DoctrineRules.DSCR_LEVEL,
    rawValue: avgBadness,
    score: goodness,
    weight,
    contribution: goodness * weight / 100,
    reasonCodes,
    status: 'scored',
  };
}

/**
 * Build the doctrine `coverage` summary from the clean coverage record +
 * the components map. The numbers use the OLD doctrine-component weight
 * table (sum=100) so the existing readers see familiar magnitudes.
 */
function buildCoverage(
  result: EvaluateDealResult,
  componentScores: readonly DoctrineComponentScore[],
): DoctrineCoverage {
  let evaluatedWeight = 0;
  let totalEvaluableWeight = 0;
  for (const cs of componentScores) {
    if (cs.status === 'not_applicable') continue;
    totalEvaluableWeight += cs.weight;
    if (cs.status === 'scored') evaluatedWeight += cs.weight;
  }
  const evaluatedPct = totalEvaluableWeight === 0 ? 0 : evaluatedWeight / totalEvaluableWeight;
  // Risk-dim rule ids in the old contract — fire when a corresponding clean
  // dim resolved to hitl-needed (not applicable counts as N/A — excluded).
  const cov = result.baseBlend.coverage;
  const excludedRiskDimRuleIds: DoctrineRuleId[] = [];
  if (cov.hitlNeeded.includes('rollover'))                excludedRiskDimRuleIds.push(DoctrineRules.ROLLOVER_WITHIN_TERM);
  if (cov.hitlNeeded.includes('income-concentration'))    excludedRiskDimRuleIds.push(DoctrineRules.TENANT_CONCENTRATION);
  if (cov.hitlNeeded.includes('coverage-dscr'))           excludedRiskDimRuleIds.push(DoctrineRules.UW_VS_T12_NOI_RECONCILIATION);
  return {
    evaluatedWeight,
    totalEvaluableWeight,
    evaluatedPct,
    excludedRiskDimRuleIds,
    bandCapApplied: false,
    insufficientCoverageGate: result.rating.coverageGateFailed,
  };
}

/**
 * Build the scoreAdjustments[] from stage-2 overrides. Both severe-floor
 * and convergence amplifier produce negative points (they INCREASE risk =
 * REDUCE goodness). Sum is clamped to the old ±25 envelope.
 *
 * Convention: each override that fired emits a FALSE_POSITIVE_GUARD entry
 * with negative points proportional to its magnitude. (FALSE_NEGATIVE_GUARD
 * is positive-points territory; clean doctrine has no positive overrides.)
 */
function buildScoreAdjustments(result: EvaluateDealResult): DoctrineScoreAdjustment[] {
  const out: DoctrineScoreAdjustment[] = [];
  const ov = result.overrides;
  if (ov.severeFloorFired) {
    const severeMagnitude = Math.max(0, (ov.amplifiedRisk ?? ov.baseRisk ?? 0) > 0
      ? Math.max(0, (ov.finalRisk ?? 0) - (ov.amplifiedRisk ?? ov.baseRisk ?? 0))
      : 0);
    const points = -Math.min(SCORE_ADJUSTMENT_ENVELOPE, Math.round(severeMagnitude * 100));
    out.push({
      ruleId: DoctrineRules.FALSE_POSITIVE_GUARD,
      fired: true,
      points,
      reasonCode: DoctrineReasonCodes.FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED,
    });
  }
  if (ov.convergenceAmplifierFired) {
    const remaining = SCORE_ADJUSTMENT_ENVELOPE - out.reduce((s, e) => s + Math.abs(e.points), 0);
    const points = -Math.min(remaining, Math.round(ov.convergenceAmplifierMagnitude * 100));
    if (Math.abs(points) > 0) {
      out.push({
        ruleId: DoctrineRules.FALSE_POSITIVE_GUARD,
        fired: true,
        points,
        reasonCode: DoctrineReasonCodes.FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED,
      });
    }
  }
  return out;
}

/**
 * Build the flags[] from clean rating's red-flags + InsufficientData.
 */
function buildFlags(result: EvaluateDealResult): DoctrineFlag[] {
  const flags = new Set<DoctrineFlag>();
  for (const d of result.overrides.severeFlaggedDims) {
    const f = severeFlagToOldFlag(d);
    if (f !== null) flags.add(f);
  }
  if (result.rating.coverageGateFailed) {
    flags.add(DoctrineFlags.INSUFFICIENT_DATA);
    flags.add(DoctrineFlags.INSUFFICIENT_COVERAGE_GATE);
  }
  return Array.from(flags);
}

/**
 * Build the reasons[] from per-dim elevated+ rationale, best-effort
 * mapping to the bounded DoctrineReasonCode union.
 */
function buildReasons(
  result: EvaluateDealResult,
): readonly { readonly ruleId: DoctrineRuleId; readonly reasonCode: DoctrineReasonCode }[] {
  const reasons: { ruleId: DoctrineRuleId; reasonCode: DoctrineReasonCode }[] = [];
  if (result.rating.coverageGateFailed) {
    reasons.push({
      ruleId: DoctrineRules.RENT_ROLL_MISSING,   // generic data-quality rule
      reasonCode: DoctrineReasonCodes.INSUFFICIENT_DATA,
    });
  }
  for (const d of result.allDimensions) {
    const rc = dimToReasonCode(d);
    const rid = dimToRuleId(d.dimensionId);
    if (rc !== null && rid !== null) {
      reasons.push({ ruleId: rid, reasonCode: rc });
    }
  }
  return reasons;
}

/**
 * Build a contract-valid DoctrineEvaluation from an EvaluateDealResult +
 * caller-supplied ids + version stamps + analysis as-of date.
 *
 * Pure function; no I/O.
 */
export function bridgeToDoctrineEvaluation(
  result: EvaluateDealResult,
  ids: BridgeIds,
  versions: BridgeVersions,
  analysisAsOfDate: ISODateTime,
): DoctrineEvaluation {
  // Score inversion: clean BADNESS [0..1] → old GOODNESS [0..100].
  const insufficient = result.rating.recommendation === 'InsufficientData';
  const ratedRisk = insufficient ? 1.0 : (result.rating.ratedRisk ?? 1.0);
  const finalScore = Math.max(0, Math.min(100, (1 - ratedRisk) * 100));
  const baseRisk = result.baseBlend.baseRisk ?? ratedRisk;
  const weightedAggregate = Math.max(0, Math.min(100, (1 - baseRisk) * 100));

  // Per-component scoring (8 components).
  const componentScores: DoctrineComponentScore[] = [];
  for (const cid of DOCTRINE_COMPONENT_IDS) {
    if (cid === 'normalization') {
      // Special: drive from normalization layer routeStatus + a synthetic score
      const norm = result.normalization;
      if (norm.routeStatus === 'applicable') {
        const haircutMagnitude = norm.issuerNoi !== null && norm.sustainableNcf !== null && norm.issuerNoi > 0
          ? 1 - (norm.sustainableNcf / norm.issuerNoi)
          : 0;
        const goodness = (1 - haircutMagnitude) * 100;
        componentScores.push(buildComponentScore('normalization', [], result.allDimensions, goodness, 'scored'));
      } else {
        componentScores.push(buildComponentScore('normalization', [], result.allDimensions, 0, 'insufficient_data'));
      }
    } else if (cid === 'data_confidence') {
      // Special: drive from coverage confidence
      const conf = result.baseBlend.coverage.confidence;
      componentScores.push(buildComponentScore('data_confidence', [], result.allDimensions, conf * 100, 'scored'));
    } else {
      componentScores.push(buildComponentScore(cid, COMPONENT_MAP[cid], result.allDimensions));
    }
  }
  // Mechanical score = the 'mechanical' component's score
  const mechComponent = componentScores.find(c => c.componentId === 'mechanical')!;
  const mechanicalScore = mechComponent.score;

  // Score adjustments + flags + reasons
  const scoreAdjustments = buildScoreAdjustments(result);
  const flags = buildFlags(result);
  const reasons = buildReasons(result);

  // Rating band: classify the inverted goodness score via the OLD band table,
  // except on InsufficientData → force 'High Risk' (lowest band).
  const ratingBand: OldRatingBand = insufficient ? 'High Risk' : classifyOldBand(finalScore);

  // Coverage summary
  const coverage = buildCoverage(result, componentScores);

  // Asset-type adjustments: empty (now baked into dim 8 contribution).
  const assetTypeAdjustments: DoctrineAssetTypeAdjustment[] = [];

  return {
    id: ids.evaluationId,
    analysisAsOfDate,
    doctrineVersion: versions.doctrineVersion,
    judgmentEngineVersion: versions.judgmentEngineVersion,
    stressEngineVersion: versions.stressEngineVersion,
    valuationEngineVersion: versions.valuationEngineVersion,
    adjustedInputsId: ids.adjustedInputsId,
    librarySnapshotId: ids.librarySnapshotId,
    narrativeFactsId: ids.narrativeFactsId,
    crossCheckResultId: ids.crossCheckResultId,
    stressOutputsId: ids.stressOutputsId,
    valuationConclusionId: ids.valuationConclusionId,
    assetProfileId: ids.assetProfileId,
    extractionResultId: ids.extractionResultId,
    rentRollId: ids.rentRollId,
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
}
