/**
 * Confidence-reduction math (audit §10).
 *
 * Sums penalty points across missing-doc + distrust ledgers, normalizes by 100, clamps to
 * [0, 1]. Per architecture §1: each penalty point ≈ 1% confidence reduction; max sum across
 * all v1.0 rules = 56 (5 missing docs × full weights + 2 distrust × 6).
 *
 * `/100` chosen as the normalization factor for forward compatibility — adding a rule that
 * pushes the sum past 100 would saturate the reduction at 1.0 rather than break the unit
 * convention.
 */

import {
  JE_DISTRUST_PENALTIES,
  JE_MISSING_DOC_PENALTIES,
  type JudgmentEngineRuleId,
} from '@cre/contracts';

export interface PenaltyEntry {
  readonly ruleId: JudgmentEngineRuleId;
}

const MISSING_DOC_KEYS = new Set<string>(Object.keys(JE_MISSING_DOC_PENALTIES));
const DISTRUST_KEYS = new Set<string>(Object.keys(JE_DISTRUST_PENALTIES));

/**
 * Returns the penalty point weight for a given rule id, or 0 if the rule doesn't contribute
 * to confidence reduction (rules outside the missing-doc / distrust categories — e.g.,
 * substitution and normalization rules — don't reduce confidence directly; they affect line
 * item values instead).
 */
export function penaltyWeightFor(ruleId: JudgmentEngineRuleId): number {
  if (MISSING_DOC_KEYS.has(ruleId)) {
    return JE_MISSING_DOC_PENALTIES[ruleId as keyof typeof JE_MISSING_DOC_PENALTIES];
  }
  if (DISTRUST_KEYS.has(ruleId)) {
    return JE_DISTRUST_PENALTIES[ruleId as keyof typeof JE_DISTRUST_PENALTIES];
  }
  return 0;
}

/**
 * Compute `confidenceReduction ∈ [0, 1]` from the missing-doc + distrust ledgers.
 * Duplicates of the same ruleId are deduplicated (no double-counting).
 */
export function computeConfidenceReduction(entries: readonly PenaltyEntry[]): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const e of entries) {
    if (seen.has(e.ruleId)) continue;
    seen.add(e.ruleId);
    sum += penaltyWeightFor(e.ruleId);
  }
  return Math.max(0, Math.min(1, sum / 100));
}
