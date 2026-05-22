/**
 * @cre/handbook-engine — public API.
 *
 * Public surface:
 *  - `evaluateHandbook(handbook, bag)` — top-level entry point. Evaluates
 *    every principle in the handbook against a deal field bag and returns
 *    fired flags + skipped-principle diagnostics.
 *  - `evaluatePrinciple(principle, bag)` — single-principle evaluator.
 *    Useful for testing individual principles or for incremental UI flows.
 *  - Type exports for engine inputs (FieldBag) and outputs (FiredFlag,
 *    SkippedPrinciple, etc.).
 *  - Lint exports: collectReferencedFields, lintHandbook,
 *    assertNoUnknownFields. Used by build-time validation that ensures
 *    every handbook-referenced field appears in the bag assembler's
 *    known-fields registry.
 *
 * Lower-level evaluators (formula, metric, condition, operator) are not
 * exported. If a consumer needs to evaluate at a finer granularity than
 * the principle level, that's a signal we need to widen the public API
 * deliberately rather than leak internals.
 */

export {
  evaluateHandbook,
  evaluatePrinciple,
} from './evaluator.js';

export type {
  FieldBag,
  FieldValue,
  FiredFlag,
  HandbookEvaluationResult,
  PrincipleEvaluationResult,
  SkippedPrinciple,
  SkipReason,
} from './types.js';

export {
  collectReferencedFields,
  lintHandbook,
  assertNoUnknownFields,
  principleFieldDependencies,
} from './lint.js';

export type { LintReport } from './lint.js';
