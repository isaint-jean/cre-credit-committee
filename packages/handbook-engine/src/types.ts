/**
 * @cre/handbook-engine — types module (refactored for #31 Commit 1).
 *
 * Engine-output types (FiredFlag, SkippedPrinciple, SkipReason,
 * FieldBag, FieldValue) now live in @cre/contracts/handbook-evaluation
 * so the HandbookEvaluation persisted record can reference them without
 * a contracts → engine dependency. They're re-exported here for
 * backward-compatibility with existing engine consumers.
 *
 * Engine-INTERNAL types (PrincipleEvaluationResult,
 * HandbookEvaluationResult, getField / fieldExists / fieldTruthy
 * helpers, the Band / ExecutionMode re-exports) remain here — they
 * describe evaluator-loop internals, not persisted shapes.
 *
 * The HANDBOOK_ENGINE_VERSION constant lives in @cre/contracts/versioning
 * (single source of truth alongside DOCTRINE_VERSION, STRESS_ENGINE_VERSION,
 * etc.) and is re-exported here so engine consumers can import it from
 * either package.
 */

import type {
  Band,
  ExecutionMode,
  FiredFlag,
  SkippedPrinciple,
} from '@cre/contracts';

// Re-export engine-output types from contracts so existing engine
// consumers don't need to update import paths.
export type {
  FieldBag,
  FieldValue,
  FiredFlag,
  InjectionPoint,
  SkippedPrinciple,
  SkipReason,
} from '@cre/contracts';

// Re-export the version constant for symmetry — engine consumers can
// continue importing HANDBOOK_ENGINE_VERSION from '@cre/handbook-engine'.
// The canonical declaration lives in @cre/contracts/versioning.
export { HANDBOOK_ENGINE_VERSION } from '@cre/contracts';
export type { HandbookEngineVersion } from '@cre/contracts';

// =============================================================================
// Engine-internal types
// =============================================================================

/**
 * Result of running the engine against a single principle.
 *
 * Either a flag fired (status: 'fired') or the principle was skipped
 * for one of the reasons in SkipReason (status: 'skipped'). No "did
 * not fire" case because that's just an empty result — the engine
 * reports skips, not silent no-ops, so the api layer can surface
 * diagnostic information when data gaps are blocking checks.
 */
export type PrincipleEvaluationResult =
  | { status: 'fired'; flag: FiredFlag }
  | { status: 'skipped'; skip: SkippedPrinciple };

/**
 * Result of running the engine against the full handbook for a deal.
 *
 * This is the engine-internal aggregate — `firedFlags` and
 * `skippedPrinciples` are directly persisted into the
 * HandbookEvaluation record's same-named fields by the api layer.
 */
export interface HandbookEvaluationResult {
  firedFlags: FiredFlag[];
  skippedPrinciples: SkippedPrinciple[];
}

// =============================================================================
// Internal helpers (unchanged from f981fec)
// =============================================================================

/**
 * Look up a field path in the bag. Returns undefined for missing keys.
 * Path is a flat string for v1 — no dotted-path resolution.
 */
import type { FieldBag, FieldValue } from '@cre/contracts';

export function getField(bag: FieldBag, path: string): FieldValue {
  return bag[path];
}

/**
 * `field_exists` semantics: the key is present and its value is not
 * undefined or null. A field set to `0` or `false` or empty string
 * EXISTS; those are valid values, not absence.
 */
export function fieldExists(bag: FieldBag, path: string): boolean {
  const v = bag[path];
  return v !== undefined && v !== null;
}

/**
 * `field_truthy` semantics — standard JS truthiness, with a missing
 * field treated as falsy.
 */
export function fieldTruthy(bag: FieldBag, path: string): boolean {
  return Boolean(bag[path]);
}

// Re-export Band/ExecutionMode from contracts so the formula and band
// evaluators can describe their inputs without reaching back into
// the contract module directly.
export type { Band, ExecutionMode };
