/**
 * §11 asset-type adjusters and §12 score adjuster (final ±25 envelope).
 *
 * §11 adjusters fire conditionally based on `AssetProfile.propertyType` and `NarrativeFacts`.
 * Each one is a discrete deduction (or zero) keyed by a `DoctrineRuleId` + `DoctrineFlag`.
 *
 * §12 envelope: `|sum(scoreAdjustments[].points)| <= 25` per evaluation. The doctrine engine
 * MUST throw `ScoreAdjustmentEnvelopeViolation` if implementation arithmetic would exceed the
 * cap rather than silently clamp.
 */

import { DoctrineRules } from './rules.js';
import type { DoctrineRuleId } from './rules.js';
import type { DoctrineFlag } from './flags.js';
import type { DoctrineReasonCode } from './reason-codes.js';

export interface DoctrineAssetTypeAdjustment {
  readonly ruleId: DoctrineRuleId;
  readonly flag: DoctrineFlag;
  readonly fired: boolean;
  readonly points: number;                   // signed; YAML adjusters are deductions (negative)
  readonly reasonCode: DoctrineReasonCode;
}

/**
 * §12 score-adjuster entry. Only two rules can fire here — `False_negative_guard` and
 * `False_positive_guard`. The literal-typed `ruleId` enforces this at compile time.
 */
export interface DoctrineScoreAdjustment {
  readonly ruleId:
    | typeof DoctrineRules.FALSE_NEGATIVE_GUARD
    | typeof DoctrineRules.FALSE_POSITIVE_GUARD;
  readonly fired: boolean;
  readonly points: number;                   // signed; -25..+25
  readonly reasonCode: DoctrineReasonCode;
}

/** The maximum absolute total influence of `scoreAdjustments[]` per evaluation. */
export const SCORE_ADJUSTMENT_ENVELOPE = 25 as const;
