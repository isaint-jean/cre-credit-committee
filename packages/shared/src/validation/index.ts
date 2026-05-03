/**
 * CRE underwriting validation layer — single source of truth.
 *
 * All scoring and computation pipelines MUST import from this module.
 * Direct construction of UnderwritingInput / FinalScore values that bypass
 * `parseUnderwritingInput` and `assertFinalScore` is a contract violation.
 */
export * from './errors';
export * from './uw-input.schema';
export * from './metric-primitives';
export * from './derived-metrics';
export * from './score-consistency';
