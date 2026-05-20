/**
 * Typed error classes for the judgment engine.
 *
 * Throw-only error model (audit §D.5). Pre-condition violations and orchestration failures
 * raise typed errors with structured codes; callers pattern-match on `code` rather than
 * parsing message strings.
 */

import type { ConservatismViolationPayload } from '@cre/contracts';

export type JudgmentEngineErrorCode =
  | 'ANALYSIS_AS_OF_MISMATCH'
  | 'LIBRARY_SNAPSHOT_VERSION_MISMATCH'
  | 'MANIFESTO_VERSION_MISMATCH'
  | 'INSUFFICIENT_INPUT'
  | 'BUILDER_FAILED'
  // Batch 6.2.1 (audit U8): vacancy + concessions composite outside [0, 1] is an upstream
  // contract violation. Rather than silently clamping (which manufactures plausible-but-false
  // economics), the builder throws so the orchestrator surfaces the broken input loudly.
  | 'JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE';

export interface JudgmentEngineErrorArgs {
  readonly code: JudgmentEngineErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
}

export class JudgmentEngineError extends Error {
  override readonly name = 'JudgmentEngineError';
  readonly code: JudgmentEngineErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(args: JudgmentEngineErrorArgs) {
    super(`[${args.code}] ${JSON.stringify(args.context)}`);
    this.code = args.code;
    this.context = args.context;
  }
}

/**
 * Stage-5 conservatism violation. Wraps the typed payload from contracts so callers can
 * `instanceof ConservatismViolation` and read `.payload.violations[]`.
 */
export class ConservatismViolation extends Error {
  override readonly name = 'ConservatismViolation';
  constructor(public readonly payload: ConservatismViolationPayload) {
    super(`[CONSERVATISM_VIOLATION] ${payload.violations.length} violation(s)`);
  }
}
