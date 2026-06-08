/**
 * DoctrineEvaluation — stage-10 producer output.
 *
 * The persisted doctrine record. Carries the FULL replay tuple: every record id, every version
 * stamp, the analysis as-of date. Re-running the doctrine against the same tuple MUST produce a
 * byte-identical record (different `id` only if any input or version changed).
 *
 * The record itself is content-addressable: `id` = SHA-256 of the JCS canonical serialization of
 * the rest of the fields.
 */

import type {
  AdjustedInputsId,
  AssetProfileId,
  CrossCheckResultId,
  DoctrineEvaluationId,
  ExtractionResultId,
  LibrarySnapshotId,
  NarrativeFactsId,
  RentRollId,
  StressOutputsId,
  ValuationConclusionId,
} from '../identity.js';
import type {
  DoctrineVersion,
  ISODateTime,
  JudgmentEngineVersion,
  StressEngineVersion,
  ValuationEngineVersion,
} from '../versioning.js';
import type {
  DoctrineAssetTypeAdjustment,
  DoctrineScoreAdjustment,
} from './adjustments.js';
import type {
  DoctrineComponentScore,
  RatingBand,
} from './components.js';
import type { DoctrineFlag } from './flags.js';
import type { DoctrineReasonCode } from './reason-codes.js';
import type { DoctrineRuleId } from './rules.js';

/**
 * Coverage summary (v1.1). Captures HOW MUCH of the doctrine weight was
 * evaluatable on this deal and which guardrails fired.
 *
 *   - evaluatedWeight        Σ weight of components whose status === 'scored'.
 *   - totalEvaluableWeight   Σ weight of components whose status !== 'not_applicable'.
 *                            (market_alignment is excluded as before — empty rule set).
 *   - evaluatedPct           evaluatedWeight / totalEvaluableWeight.
 *   - excludedRiskDimRuleIds Risk-dim rules (UW_VS_T12 / TENANT_CONCENTRATION /
 *                            ROLLOVER_WITHIN_TERM / TI_LC_VS_ROLLOVER) whose
 *                            status === 'insufficient_data'. Any non-empty → cap fires.
 *   - bandCapApplied         True iff cap actively downgraded ratingBand
 *                            (only happens if pre-cap band was 'Strong').
 *   - insufficientCoverageGate  True iff evaluatedPct < 0.50 — gate the deal.
 */
export interface DoctrineCoverage {
  readonly evaluatedWeight: number;
  readonly totalEvaluableWeight: number;
  readonly evaluatedPct: number;
  readonly excludedRiskDimRuleIds: readonly DoctrineRuleId[];
  readonly bandCapApplied: boolean;
  readonly insufficientCoverageGate: boolean;
}

export interface DoctrineEvaluation {
  readonly id: DoctrineEvaluationId;

  // Time anchor — frozen from extraction
  readonly analysisAsOfDate: ISODateTime;

  // Version axes (replay key components)
  readonly doctrineVersion: DoctrineVersion;
  readonly judgmentEngineVersion: JudgmentEngineVersion;
  readonly stressEngineVersion: StressEngineVersion;
  readonly valuationEngineVersion: ValuationEngineVersion;

  // FK chain — every upstream stage record referenced. Single-hop hydration:
  // every record in the bundle is reachable from this root in exactly one FK lookup.
  readonly adjustedInputsId: AdjustedInputsId;
  readonly librarySnapshotId: LibrarySnapshotId;
  readonly narrativeFactsId: NarrativeFactsId;
  readonly crossCheckResultId: CrossCheckResultId;
  readonly stressOutputsId: StressOutputsId;
  readonly valuationConclusionId: ValuationConclusionId;
  readonly assetProfileId: AssetProfileId;        // 6.5: was inline embed `assetProfile`
  readonly extractionResultId: ExtractionResultId; // 6.5: new — root knows its extraction provenance
  // Phase 1 (rent-roll-node): typed RentRoll captured at extraction time is now a first-class
  // graph node. Nullable — a deal genuinely may have no rent roll (no xlsx uploaded + no ASR
  // fallback). Adding this field intentionally changes DoctrineEvaluation's content-hash id;
  // documented schema evolution, mirrors the Batch 6.5 extractionResultId precedent above.
  readonly rentRollId: RentRollId | null;

  // Substages 10a–10g — scoring trail
  readonly mechanicalScore: number;                              // 10a aggregate (§4)
  readonly componentScores: readonly DoctrineComponentScore[];   // 10a per-component
  readonly weightedAggregate: number;                            // 10b weighted sum
  readonly assetTypeAdjustments: readonly DoctrineAssetTypeAdjustment[]; // 10d
  readonly scoreAdjustments: readonly DoctrineScoreAdjustment[]; // 10e (±25 envelope)
  readonly finalScore: number;                                   // 10f, clamped 0..100
  readonly ratingBand: RatingBand;                               // 10f

  // 10c flags (read from valuation conclusion + asset-type adjusters + components)
  readonly flags: readonly DoctrineFlag[];

  // 10g bounded explainability projection — NO free text
  readonly reasons: readonly {
    readonly ruleId: DoctrineRuleId;
    readonly reasonCode: DoctrineReasonCode;
  }[];

  /**
   * v1.1: coverage summary. Captures the aggregator's view of how much of the
   * doctrine weight was evaluatable + which guardrails fired. See DoctrineCoverage.
   */
  readonly coverage: DoctrineCoverage;
}
