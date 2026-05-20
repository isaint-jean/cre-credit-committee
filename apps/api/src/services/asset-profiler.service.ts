/**
 * Stage 3: Asset profiler.
 *
 * Pure function (`extraction → AssetProfile`) implementing the doctrine YAML §2 classification:
 *   - propertyType:    pass-through from extraction (already classified by the extractor)
 *   - businessPlan:    Stabilized vs LeaseUp_or_Transitional, derived from occupancy thresholds
 *   - marketLiquidity: hint from the caller (or NarrativeFacts in a future revision)
 *
 * First-class persisted record as of Batch 6.3.6. Content-hash id over the AssetProfile body
 * `{propertyType, businessPlan, marketLiquidity}`. The classifier reads NarrativeFacts to derive
 * `businessPlan`, but identity is over the resulting body — the hash is independent of
 * NarrativeFacts / Judgment / Stress / Doctrine outputs.
 *
 * Input philosophy: the profiler reads only the narrative-facts subset relevant to classification.
 * It does NOT read AdjustedInputs (those don't exist yet at stage 3) and it does NOT branch on
 * asset-type-specific rules (that's the doctrine's job, downstream).
 */

import type {
  AssetProfile,
  AssetType,
  BusinessPlan,
  MarketLiquidity,
  NarrativeFacts,
} from '@cre/contracts';
import { computeAssetProfileId } from '../util/content-hash.js';

/**
 * Occupancy thresholds for business-plan classification. Locked here for v1.0; doctrine YAML §2
 * declares 0.85 as the cutoff for both current and trailing occupancy. Future tuning lives in
 * the doctrine ruleset (with version bump) — not here.
 */
const BUSINESS_PLAN_OCCUPANCY_THRESHOLD = 0.85 as const;

export function classifyAssetProfile(args: {
  readonly propertyType: AssetType;
  readonly narrativeFacts: Pick<NarrativeFacts, 'occupancyCurrent' | 'trailingOccAvg'>;
  readonly marketLiquidityHint?: MarketLiquidity;
}): AssetProfile {
  const { propertyType, narrativeFacts, marketLiquidityHint } = args;

  const body = {
    propertyType,
    businessPlan: classifyBusinessPlan(
      narrativeFacts.occupancyCurrent,
      narrativeFacts.trailingOccAvg,
    ),
    marketLiquidity: marketLiquidityHint ?? 'Unknown',
  };

  return { id: computeAssetProfileId(body), ...body };
}

/**
 * YAML §2 logic:
 *   if occupancy_current < 0.85 AND trailing_occupancy_avg < 0.85 → LeaseUp_or_Transitional
 *   if both ≥ 0.85                                                 → Stabilized
 *   else                                                            → Stabilized (default)
 *
 * Null handling: a null occupancy is treated as "no evidence of lease-up" and routes to the
 * `Stabilized` default (per the YAML's catch-all). The doctrine §1 missing-data penalty still
 * fires for absent data — the profiler doesn't double-penalize.
 */
function classifyBusinessPlan(
  current: number | null,
  trailing: number | null,
): BusinessPlan {
  if (current !== null && trailing !== null) {
    if (current < BUSINESS_PLAN_OCCUPANCY_THRESHOLD && trailing < BUSINESS_PLAN_OCCUPANCY_THRESHOLD) {
      return 'LeaseUp_or_Transitional';
    }
  }
  return 'Stabilized';
}
