/**
 * Operator evaluator.
 *
 * Given a metric value, a ComparisonOp, and a resolved threshold, decides
 * whether the band fires. Pure function. Total over its inputs (no throws).
 *
 * Operator semantics — keyed by what threshold shapes are valid:
 *
 *   Numeric scalar metric vs literal threshold:
 *     lt, lte, gt, gte — standard numeric comparisons. Returns false if
 *     metric is not a finite number or threshold value isn't numeric.
 *
 *   Equality:
 *     eq, neq — strict equality / inequality. No coercion. Both sides
 *     must be primitive (string, number, boolean); arrays returning false
 *     for safety (the contract doesn't define array equality semantics).
 *
 *   Set membership:
 *     in — metric is one of the values in the threshold set.
 *     not_in — metric is NOT one of the values in the threshold set.
 *     Both require threshold kind 'set'. Metric must be primitive.
 *
 *   Array intersection:
 *     contains_any — metric is an array; at least one element overlaps
 *       with threshold set.
 *     contains_all — metric is an array; every element of threshold set
 *       is present in metric. (NOT "every element of metric is in
 *       threshold set" — that's a subset-of check, which we don't have.)
 *     Both require threshold kind 'set'. Metric must be an array.
 *
 *   Range:
 *     in_range — metric is a finite number within [min, max] honoring
 *       inclusivity flags. Requires threshold kind 'range'.
 *
 *   Categorical:
 *     matches — fires unconditionally. Used with metric kind 'categorical'
 *       and threshold kind 'none'. Means: if the EvaluationGroup's
 *       condition matched and the band's operator is `matches`, the band
 *       fires. The categorical metric is just a sentinel; the firing
 *       semantic is "group condition → band fires."
 *
 * Mismatched shapes (e.g., `in_range` with a literal threshold, or `gt`
 * against a string metric) return false. The engine treats these as
 * "band doesn't fire" rather than throwing — defensive design for
 * handbook authoring errors that escape the lint pass.
 */

import type { ComparisonOp } from '@cre/contracts';
import type { ResolvedThreshold } from './metric.js';
import type { FieldValue } from './types.js';

export function evaluateOperator(
  metric: FieldValue,
  operator: ComparisonOp,
  threshold: ResolvedThreshold,
): boolean {
  if (threshold.kind === 'unresolvable') return false;

  switch (operator) {
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return evaluateOrderedComparison(metric, operator, threshold);
    case 'eq':
    case 'neq':
      return evaluateEquality(metric, operator, threshold);
    case 'in':
    case 'not_in':
      return evaluateSetMembership(metric, operator, threshold);
    case 'contains_any':
    case 'contains_all':
      return evaluateArrayContains(metric, operator, threshold);
    case 'in_range':
      return evaluateInRange(metric, threshold);
    case 'matches':
      return evaluateMatches(threshold);
  }
}

function evaluateOrderedComparison(
  metric: FieldValue,
  operator: 'lt' | 'lte' | 'gt' | 'gte',
  threshold: ResolvedThreshold,
): boolean {
  if (typeof metric !== 'number' || !Number.isFinite(metric)) return false;
  if (threshold.kind !== 'literal') return false;
  if (typeof threshold.value !== 'number' || !Number.isFinite(threshold.value)) {
    return false;
  }
  switch (operator) {
    case 'lt':
      return metric < threshold.value;
    case 'lte':
      return metric <= threshold.value;
    case 'gt':
      return metric > threshold.value;
    case 'gte':
      return metric >= threshold.value;
  }
}

function evaluateEquality(
  metric: FieldValue,
  operator: 'eq' | 'neq',
  threshold: ResolvedThreshold,
): boolean {
  if (threshold.kind !== 'literal') return false;
  if (
    metric === null ||
    metric === undefined ||
    Array.isArray(metric)
  ) {
    // Equality against null/undefined/array is ill-defined here.
    return operator === 'neq';
  }
  const eq = metric === threshold.value;
  return operator === 'eq' ? eq : !eq;
}

function evaluateSetMembership(
  metric: FieldValue,
  operator: 'in' | 'not_in',
  threshold: ResolvedThreshold,
): boolean {
  if (threshold.kind !== 'set') return false;
  if (typeof metric !== 'string' && typeof metric !== 'number') return false;
  let found = false;
  for (const candidate of threshold.values) {
    if (candidate === metric) {
      found = true;
      break;
    }
  }
  return operator === 'in' ? found : !found;
}

function evaluateArrayContains(
  metric: FieldValue,
  operator: 'contains_any' | 'contains_all',
  threshold: ResolvedThreshold,
): boolean {
  if (threshold.kind !== 'set') return false;
  if (!Array.isArray(metric)) return false;
  if (operator === 'contains_any') {
    for (const candidate of threshold.values) {
      for (const elem of metric) {
        if (candidate === elem) return true;
      }
    }
    return false;
  }
  // contains_all: every element of the threshold set must be in metric
  for (const candidate of threshold.values) {
    let found = false;
    for (const elem of metric) {
      if (candidate === elem) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function evaluateInRange(
  metric: FieldValue,
  threshold: ResolvedThreshold,
): boolean {
  if (typeof metric !== 'number' || !Number.isFinite(metric)) return false;
  if (threshold.kind !== 'range') return false;
  const aboveMin = threshold.minInclusive
    ? metric >= threshold.min
    : metric > threshold.min;
  const belowMax = threshold.maxInclusive
    ? metric <= threshold.max
    : metric < threshold.max;
  return aboveMin && belowMax;
}

function evaluateMatches(threshold: ResolvedThreshold): boolean {
  // `matches` fires whenever it's reached. The EvaluationGroup's condition
  // already gated us in; the operator's job is to say "yes, fire."
  // We accept threshold kind 'none' (the canonical pairing) but also allow
  // any threshold — the handbook lint pass enforces the pairing, the engine
  // doesn't need to.
  return threshold.kind !== 'unresolvable';
}
