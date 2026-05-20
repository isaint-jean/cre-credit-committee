/**
 * Doctrine component scoring + rating bands. Frozen for `DOCTRINE_VERSION = '1.0'`.
 *
 * Weights are declared as const-asserted record. Sum MUST equal 100 (validated at runtime by the
 * doctrine engine on boot — see `DOCTRINE_HASH_DRIFT` companion check).
 *
 * Rating-band thresholds are declared once here and consumed by the engine. Comparison is
 * inclusive (`finalScore >= minScore`), as specified by the doctrine YAML §3 (`min_score`).
 */

import type { DoctrineReasonCode } from './reason-codes.js';
import type { DoctrineRuleId } from './rules.js';

export const DOCTRINE_COMPONENT_IDS = [
  'mechanical',
  'durability',
  'normalization',
  'capitalization',
  'market_alignment',     // §3 weight 10; component-level scoring rule lands in v1.1
  'term_risk',
  'maturity_risk',
  'data_confidence',
] as const;

export type DoctrineComponentId = (typeof DOCTRINE_COMPONENT_IDS)[number];

/** Sum = 100. Locked for v1.0 per doctrine YAML §3. */
export const DOCTRINE_COMPONENT_WEIGHTS: { readonly [K in DoctrineComponentId]: number } = {
  mechanical:        10,
  durability:        30,
  normalization:     15,
  capitalization:    20,
  market_alignment:  10,
  term_risk:          7,
  maturity_risk:      5,
  data_confidence:    3,
} as const;

/**
 * Rating bands. `>=` semantics (per doctrine YAML §3 `min_score`). Bands are evaluated in
 * descending `minScore` order; the first match wins.
 */
export const RATING_BANDS = [
  { name: 'Strong',     minScore: 75 },
  { name: 'Acceptable', minScore: 60 },
  { name: 'Weak',       minScore: 50 },
  { name: 'High Risk',  minScore:  0 },
] as const;

export type RatingBand = (typeof RATING_BANDS)[number]['name'];

/**
 * One scored component on a `DoctrineEvaluation`. The engine substages 10a–10b populate these;
 * 10c overlays valuation guardrail flags onto matching components; 10d/10e add adjustments.
 */
export interface DoctrineComponentScore {
  readonly componentId: DoctrineComponentId;
  readonly ruleId: DoctrineRuleId;
  readonly rawValue: number | null;          // the underlying metric the rule scored
  readonly score: number;                    // 0..100
  readonly weight: number;                   // matches DOCTRINE_COMPONENT_WEIGHTS[componentId]
  readonly contribution: number;             // = score * weight / 100
  readonly reasonCodes: readonly DoctrineReasonCode[];
}
