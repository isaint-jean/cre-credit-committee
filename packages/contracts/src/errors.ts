/**
 * Typed error payloads for stage failures.
 *
 * The contracts package defines payload SHAPES only. The actual `Error` subclasses (e.g.
 * `class ConservatismViolation extends Error`) live on the api side, throw these payloads, and
 * are caught by callers via `instanceof` + payload inspection.
 */

/**
 * Stage 5 conservatism gate violation. The gate either passes or throws. If it throws, every
 * failed rule appears as a detail entry. The api-side error class wraps `ConservatismViolation`
 * as its payload.
 */
export interface ConservatismViolationDetail {
  readonly metric: 'vacancy' | 'expense_ratio' | 'noi';
  readonly rule: string;
  readonly expected: number;
  readonly actual: number;
}

export interface ConservatismViolationPayload {
  readonly violations: readonly ConservatismViolationDetail[];
}

/**
 * Doctrine evaluator precondition failure. Thrown if upstream stages produced incomplete inputs
 * (e.g., missing valuation, empty cross-check, undefined narrative-facts fields). The doctrine
 * MUST refuse to run rather than fall back — this payload describes which precondition failed.
 */
export interface DoctrinePreconditionFailure {
  readonly missingInput:
    | 'valuationConclusion'
    | 'crossCheckResult'
    | 'stressOutputs'
    | 'narrativeFacts'
    | 'librarySnapshot'
    | 'adjustedInputs'
    | 'assetProfile';
  readonly detail: string;
}

/**
 * Score-adjuster envelope violation. The doctrine §12 layer caps `|sum(scoreAdjustments.points)|`
 * at 25. If implementation arithmetic exceeds that, the engine throws this rather than emit an
 * unbounded score.
 */
export interface ScoreAdjustmentEnvelopeViolation {
  readonly attempted: number;
  readonly cap: 25;
}
