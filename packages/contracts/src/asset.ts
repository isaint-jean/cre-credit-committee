/**
 * Asset classification.
 *
 * `AssetType` is the structural axis used by the render schema (one of the four render-index
 * axes). `AssetProfile` is the stage-3 producer output that the doctrine evaluator consumes for
 * asset-type-specific adjusters (§11 of the doctrine ruleset).
 */

import type { AssetProfileId } from './identity.js';

export const ASSET_TYPES = [
  'Office',
  'Retail',
  'Multifamily',
  'Hotel',
  'Industrial',
  'SelfStorage',
  'MHC',
  'MixedUse',
  'Other',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * `PropertyType` is an alias retained for the doctrine YAML's vocabulary. Resolve to one name in
 * a future revision; for now both are accepted.
 */
export type PropertyType = AssetType;

export const BUSINESS_PLANS = ['Stabilized', 'LeaseUp_or_Transitional'] as const;
export type BusinessPlan = (typeof BUSINESS_PLANS)[number];

export const MARKET_LIQUIDITIES = ['Primary', 'Secondary', 'Tertiary', 'Unknown'] as const;
export type MarketLiquidity = (typeof MARKET_LIQUIDITIES)[number];

/**
 * Stage-3 output. Pure derivation from extraction (with classifying inputs from NarrativeFacts).
 *
 * First-class persisted record (Batch 6.3.6): content-hash id over `{propertyType, businessPlan,
 * marketLiquidity}`. The hash is over the AssetProfile body — independent of NarrativeFacts /
 * Judgment / Stress / Doctrine outputs (the classifier internally consumes NarrativeFacts to
 * derive `businessPlan`, but identity is over the resulting body, not its inputs).
 *
 * AssetProfile is still embedded inline inside `DoctrineEvaluation` for now; switching that
 * embedding to a `assetProfileId` reference is deferred to Batch 6.5 (hydration).
 */
export interface AssetProfile {
  readonly id: AssetProfileId;
  readonly propertyType: PropertyType;
  readonly businessPlan: BusinessPlan;
  readonly marketLiquidity: MarketLiquidity;
}
