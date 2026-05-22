/**
 * Condition evaluator.
 *
 * Pure recursive interpreter over the Condition discriminated union from
 * the contract. Used in three places:
 *   - Principle.trigger — whether the principle applies to this deal at all
 *   - EvaluationGroup.condition — which group's bands apply for this deal
 *   - Nested all_of / any_of / not — composition primitives
 *
 * Semantics:
 *  - `always` → true
 *  - `field_equals` → bag[field] === value (strict equality, no coercion)
 *  - `field_in` → bag[field] is in the values set (strict; arrays not handled
 *    here, this is for scalar membership)
 *  - `field_gte` / `field_gt` / `field_lte` / `field_lt` → numeric comparison;
 *    missing or non-numeric field → false
 *  - `field_exists` → key present and value not undefined/null
 *  - `field_truthy` → standard JS truthiness on the field value
 *  - `all_of` → every sub-condition true (empty array → true, vacuously)
 *  - `any_of` → at least one sub-condition true (empty array → false)
 *  - `not` → inversion
 *
 * Conditions never "fail" — they're total over the bag. Missing fields just
 * make field-based conditions false (except `not field_exists`, which is true).
 * This is the intentional design: triggers and group conditions are gates, not
 * computations. If you want to skip a principle on missing data, use the
 * upstream metric/threshold evaluators which DO signal failure.
 */

import type { Condition } from '@cre/contracts';
import type { FieldBag } from './types.js';
import { fieldExists, fieldTruthy, getField } from './types.js';

export function evaluateCondition(
  condition: Condition,
  bag: FieldBag,
): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'field_equals': {
      const v = getField(bag, condition.field);
      return v === condition.value;
    }
    case 'field_in': {
      const v = getField(bag, condition.field);
      if (typeof v !== 'string' && typeof v !== 'number') return false;
      // ReadonlyArray.includes is typed against the array's element type;
      // since the array is string|number union and v is narrowed to one of
      // those, use a typed comparison loop to avoid casts.
      for (const candidate of condition.values) {
        if (candidate === v) return true;
      }
      return false;
    }
    case 'field_gte': {
      const v = getField(bag, condition.field);
      return typeof v === 'number' && Number.isFinite(v) && v >= condition.value;
    }
    case 'field_gt': {
      const v = getField(bag, condition.field);
      return typeof v === 'number' && Number.isFinite(v) && v > condition.value;
    }
    case 'field_lte': {
      const v = getField(bag, condition.field);
      return typeof v === 'number' && Number.isFinite(v) && v <= condition.value;
    }
    case 'field_lt': {
      const v = getField(bag, condition.field);
      return typeof v === 'number' && Number.isFinite(v) && v < condition.value;
    }
    case 'field_exists':
      return fieldExists(bag, condition.field);
    case 'field_truthy':
      return fieldTruthy(bag, condition.field);
    case 'all_of':
      for (const sub of condition.conditions) {
        if (!evaluateCondition(sub, bag)) return false;
      }
      return true;
    case 'any_of':
      for (const sub of condition.conditions) {
        if (evaluateCondition(sub, bag)) return true;
      }
      return false;
    case 'not':
      return !evaluateCondition(condition.condition, bag);
  }
}
