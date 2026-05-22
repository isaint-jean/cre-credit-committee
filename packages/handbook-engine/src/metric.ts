/**
 * MetricExpression and ThresholdValue evaluators.
 *
 * The metric evaluator resolves a MetricExpression to a FieldValue
 * (number, string, boolean, array, null, or undefined). The threshold
 * evaluator resolves a ThresholdValue to a concrete comparison target —
 * either a literal, a set, a range, or a field-referenced value pulled
 * fresh from the bag.
 *
 * Both layers cleanly separate "I couldn't compute this" (returns null)
 * from "the result is null" (returns null). Callers must treat null as
 * "can't proceed" — there is no way to distinguish a computed-null from
 * a field-absent-null in v1. This is acceptable because no operator
 * meaningfully handles null on either side; if the metric or threshold
 * resolves to null, the band can't fire.
 */

import type { MetricExpression, ThresholdValue } from '@cre/contracts';
import { evaluateFormula } from './formula.js';
import type { FieldBag, FieldValue } from './types.js';
import { getField } from './types.js';

/**
 * Evaluate a MetricExpression to a FieldValue.
 *
 *  - `simple` reads a field by path; returns whatever's there
 *    (string, number, boolean, array, null, undefined).
 *  - `computed` evaluates the formula; returns a number, or null if
 *    the formula can't be resolved (missing inputs, divide by zero, etc.)
 *  - `categorical` returns a sentinel — there's no scalar to compute;
 *    the condition match alone fires the flag via the `matches` operator.
 *    Returning a fixed string sentinel ("__categorical__") keeps the
 *    function total without leaking an undefined-as-meaningful through
 *    the rest of the pipeline.
 */
export function evaluateMetric(
  metric: MetricExpression,
  bag: FieldBag,
): FieldValue {
  switch (metric.kind) {
    case 'simple':
      return getField(bag, metric.path);
    case 'computed':
      return evaluateFormula(metric.formula, bag);
    case 'categorical':
      return CATEGORICAL_SENTINEL;
  }
}

export const CATEGORICAL_SENTINEL = '__categorical__';

/**
 * Resolved threshold — the form a ThresholdValue takes once any field
 * references have been dereferenced. Bands compare metric values against
 * one of these shapes.
 *
 * `kind: 'unresolvable'` is the engine's signal that a field_reference
 * couldn't be resolved (missing or non-comparable bag entry). Returned
 * instead of throwing so the caller can record a skip and move on.
 */
export type ResolvedThreshold =
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'set'; values: ReadonlyArray<string | number> }
  | {
      kind: 'range';
      min: number;
      max: number;
      minInclusive: boolean;
      maxInclusive: boolean;
    }
  | { kind: 'none' }
  | { kind: 'unresolvable'; reason: string };

export function resolveThreshold(
  threshold: ThresholdValue,
  bag: FieldBag,
): ResolvedThreshold {
  switch (threshold.kind) {
    case 'literal':
      return { kind: 'literal', value: threshold.value };
    case 'set':
      return { kind: 'set', values: threshold.values };
    case 'range':
      return {
        kind: 'range',
        min: threshold.min,
        max: threshold.max,
        minInclusive: threshold.minInclusive,
        maxInclusive: threshold.maxInclusive,
      };
    case 'none':
      return { kind: 'none' };
    case 'field_reference': {
      const v = getField(bag, threshold.path);
      // For v1, field_reference must resolve to a number — every current
      // use is numeric (e.g., compare stressed dark value to loan amount).
      // String/boolean field_references aren't used by any current
      // principle; extending the contract later is fine.
      if (typeof v === 'number' && Number.isFinite(v)) {
        return { kind: 'literal', value: v };
      }
      return {
        kind: 'unresolvable',
        reason: `field_reference '${threshold.path}' missing or non-numeric`,
      };
    }
  }
}
