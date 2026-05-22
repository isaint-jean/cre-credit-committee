/**
 * FormulaNode evaluator.
 *
 * Evaluates a FormulaNode tree to a number, given a deal field bag.
 *
 * Returns null when:
 *  - A `field` node references a path that's missing from the bag
 *  - A `field` node references a path whose value isn't numeric
 *  - A `divide` operation has a zero denominator
 *  - An `op` node has fewer operands than the operator requires
 *
 * Null propagates upward — any sub-tree that returns null causes the
 * whole formula to be null. This is intentional: a formula with a missing
 * input shouldn't silently substitute zero or NaN, it should signal to
 * the caller that the metric can't be computed.
 *
 * `sum_over_term` semantics:
 *  The minimal-arity ops (add, subtract, multiply, divide) take operands
 *  that resolve to scalars. `sum_over_term` is special — its operand
 *  resolves to either a single scalar (interpreted as a per-period value
 *  summed across the loan term, requiring the bag to carry `loan_term`
 *  as a number of periods) or to an array of per-period values (the
 *  engine sums the array directly). The current handbook uses
 *  sum_over_term in P-IV-RET-6 where the operand is a difference of
 *  field values; the bag is expected to carry the per-period series for
 *  noi_projection, debt_service, capex_projection, reserves as arrays.
 *
 * v1 limitation: sum_over_term only handles scalar arithmetic on array
 *  operands when each operand is either an array of the same length or a
 *  broadcast scalar. If operands disagree on length, returns null.
 */

import type { FormulaNode } from '@cre/contracts';
import type { FieldBag, FieldValue } from './types.js';
import { getField } from './types.js';

/**
 * Evaluate a formula to a scalar number, or null if the formula can't be
 * resolved (missing field, non-numeric field, divide by zero, malformed
 * operands).
 */
export function evaluateFormula(
  formula: FormulaNode,
  bag: FieldBag,
): number | null {
  switch (formula.kind) {
    case 'literal':
      return formula.value;
    case 'field': {
      const v = getField(bag, formula.path);
      return coerceToNumber(v);
    }
    case 'op':
      return evaluateOp(formula, bag);
  }
}

function evaluateOp(
  node: Extract<FormulaNode, { kind: 'op' }>,
  bag: FieldBag,
): number | null {
  const { op, operands } = node;

  if (operands.length === 0) return null;

  switch (op) {
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide': {
      // Scalar ops: each operand must resolve to a scalar.
      const values: number[] = [];
      for (const operand of operands) {
        const v = evaluateFormula(operand, bag);
        if (v === null) return null;
        values.push(v);
      }
      return applyScalarOp(op, values);
    }
    case 'sum_over_term':
      return evaluateSumOverTerm(operands, bag);
  }
}

function applyScalarOp(
  op: 'add' | 'subtract' | 'multiply' | 'divide',
  values: number[],
): number | null {
  if (values.length === 0) return null;
  // Non-empty by guard above; assert non-undefined for noUncheckedIndexedAccess.
  let acc = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const next = values[i]!;
    switch (op) {
      case 'add':
        acc = acc + next;
        break;
      case 'subtract':
        acc = acc - next;
        break;
      case 'multiply':
        acc = acc * next;
        break;
      case 'divide':
        if (next === 0) return null;
        acc = acc / next;
        break;
    }
  }
  return acc;
}

/**
 * sum_over_term: sum a per-period series. The operand can be:
 *  - a `field` node pointing at an array — sum the array
 *  - an `op` node whose sub-tree evaluates to a per-period array
 *    (this is the P-IV-RET-6 case: subtract two arrays element-wise,
 *    then sum the result)
 *
 * v1 implementation strategy: evaluate the operand once with array
 * semantics, then sum. Returns null if the operand can't be resolved
 * to an array (or to a scalar that we'd broadcast — see note below).
 */
function evaluateSumOverTerm(
  operands: FormulaNode[],
  bag: FieldBag,
): number | null {
  if (operands.length !== 1) return null;
  const series = evaluateFormulaAsArray(operands[0]!, bag);
  if (series === null) return null;
  let sum = 0;
  for (const v of series) {
    sum += v;
  }
  return sum;
}

/**
 * Evaluate a formula node as an array of per-period scalars. Used inside
 * sum_over_term.
 *
 * `literal` → broadcast: a single-element array. Useful for constants in
 *  a formula that's otherwise array-valued.
 * `field` → if the field value is a numeric array, return it; if scalar,
 *  return [scalar] for broadcast; otherwise null.
 * `op` → element-wise apply. All array operands must agree on length;
 *  scalar operands broadcast.
 */
function evaluateFormulaAsArray(
  formula: FormulaNode,
  bag: FieldBag,
): number[] | null {
  switch (formula.kind) {
    case 'literal':
      return [formula.value];
    case 'field': {
      const v = getField(bag, formula.path);
      if (Array.isArray(v)) {
        const out: number[] = [];
        for (const elem of v) {
          if (typeof elem !== 'number' || !Number.isFinite(elem)) return null;
          out.push(elem);
        }
        return out;
      }
      const scalar = coerceToNumber(v);
      if (scalar === null) return null;
      return [scalar];
    }
    case 'op': {
      if (formula.op === 'sum_over_term') {
        // Nested sum_over_term: collapse the inner one to a scalar, then broadcast.
        const inner = evaluateSumOverTerm(formula.operands, bag);
        if (inner === null) return null;
        return [inner];
      }
      const subArrays: number[][] = [];
      for (const operand of formula.operands) {
        const arr = evaluateFormulaAsArray(operand, bag);
        if (arr === null) return null;
        subArrays.push(arr);
      }
      // Determine target length: longest non-broadcast array.
      // Broadcast = length-1.
      let targetLen = 1;
      for (const arr of subArrays) {
        if (arr.length > 1) {
          if (targetLen > 1 && arr.length !== targetLen) return null;
          targetLen = arr.length;
        }
      }
      // Apply element-wise.
      const result: number[] = [];
      for (let i = 0; i < targetLen; i++) {
        const slice: number[] = [];
        for (const arr of subArrays) {
          slice.push(arr.length === 1 ? arr[0]! : arr[i]!);
        }
        const applied = applyScalarOp(
          formula.op as 'add' | 'subtract' | 'multiply' | 'divide',
          slice,
        );
        if (applied === null) return null;
        result.push(applied);
      }
      return result;
    }
  }
}

function coerceToNumber(v: FieldValue): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
