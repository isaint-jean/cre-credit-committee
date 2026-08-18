/**
 * buildFlagDetailsForRoot — resolve a graph root (doctrine_evaluation_id) → re-run the
 * deterministic doctrine evaluation → assemble every flag's "how I determined this" detail.
 * Shared by the deal-room flag-details endpoint AND the memo caller so both surfaces show
 * identical content. RENDER-ONLY: no LLM, no write, no re-mint (mirrors render-memo-for-
 * analysis's deterministic reconstruction).
 */
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type { DoctrineEvaluationId } from '@cre/contracts';
import type { FlagDetail } from '@cre/contracts';
import { adaptExtractionToDealBag, evaluateDeal } from '../../doctrine-clean/index.js';
import { detectLeaseUp } from '../../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '../contracted-basis.js';
import { buildNoiReconciliationDetail } from './noi-reconciliation-detail.js';
import { buildAllFlagDetails } from './flag-detail.js';

/** Build the flag-detail map for a root, or null when the root doesn't resolve / lacks records. */
export function buildFlagDetailsForRoot(rootId: string, graph: RecordGraphStore): Record<string, FlagDetail> | null {
  const doctrine = graph.getDoctrineEvaluation(rootId as DoctrineEvaluationId);
  if (doctrine === null) return null;
  const extraction = graph.getExtractionResult(doctrine.extractionResultId);
  const adjustedInputs = graph.getAdjustedInputs(doctrine.adjustedInputsId);
  const assetProfile = graph.getAssetProfile(doctrine.assetProfileId);
  if (extraction === null || adjustedInputs === null || assetProfile === null) return null;

  const propertyMetadata = graph.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? graph.getRentRoll(doctrine.rentRollId) : null;

  // Deterministic reconstruction (mirrors render-memo-for-analysis.ts:238-248) — no LLM, no write.
  const leaseUp = detectLeaseUp({ extraction, assetProfile });
  const contracted = computeContractedNoi({ rentRoll, adjustedInputs, isLeaseUpDeal: leaseUp.isLeaseUp });
  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contracted.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);

  const noiReconciliation = buildNoiReconciliationDetail(extraction, adjustedInputs.metrics.noi);
  return buildAllFlagDetails({
    contributions: dealResult.allDimensions,
    dataQualityFlags: adjustedInputs.dataQualityFlags ?? [],
    noiReconciliation,
  });
}
