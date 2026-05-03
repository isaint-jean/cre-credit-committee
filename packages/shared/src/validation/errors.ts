/**
 * Validation error taxonomy for the CRE underwriting pipeline.
 *
 * Every failure mode the contract enumerates maps to one of these codes.
 * Callers branch on `code`, never on message text.
 */

export type ValidationErrorCode =
  | 'INCOMPLETE_INPUT_DATA_ERROR'
  | 'INVALID_NUMERIC_VALUE_ERROR'
  | 'MISSING_TRACEABILITY_ERROR'
  | 'SCORE_INCONSISTENCY_ERROR'
  | 'AI_SCORE_IN_FINAL_OUTPUT_ERROR'
  | 'DERIVED_METRIC_INPUT_MISSING_ERROR';

export interface ValidationIssue {
  code: ValidationErrorCode;
  path: (string | number)[];
  message: string;
}

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly issues: ValidationIssue[];

  constructor(code: ValidationErrorCode, issues: ValidationIssue[], message?: string) {
    super(message ?? `${code}: ${issues.length} issue(s)`);
    this.name = 'ValidationError';
    this.code = code;
    this.issues = issues;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, issues: this.issues };
  }
}
