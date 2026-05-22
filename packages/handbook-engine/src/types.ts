/**
 * @cre/handbook-engine — types module
 *
 * Type definitions for the engine's inputs and outputs. The engine evaluates
 * deterministic checks against an untyped field bag (per design decision B2
 * locked in during the JSON-conversion session), producing a list of fired
 * flags plus diagnostic information.
 */

import type {
  Band,
  ExecutionMode,
  InjectionPoint,
  Severity,
} from '@cre/contracts';

/**
 * The "deal context" the engine evaluates against. Untyped intentionally —
 * the api layer is responsible for assembling this bag from whatever deal
 * sources are in play (ASR, UW model, sponsor questionnaire, manual entry).
 *
 * Allowed value types are kept narrow to keep the operator interpreter
 * total — no arbitrary objects, no functions. Arrays are needed for the
 * `contains_any` / `contains_all` operators (e.g., tenant_categories array
 * matched against a watchlist set).
 *
 * `undefined` is the canonical "field absent" signal. The api layer should
 * not assemble a bag with `undefined` keys; the engine treats both "key
 * absent" and "key present but undefined" as missing.
 */
export type FieldValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | null
  | undefined;

export type FieldBag = Readonly<Record<string, FieldValue>>;

// =============================================================================
// Engine outputs
// =============================================================================

/**
 * A single fired flag — emitted when a principle's deterministic check fires
 * for a given deal context. Carries enough context for the LLM (or a human
 * reviewer) to reconstruct what fired and why.
 */
export interface FiredFlag {
  principleId: string;
  severity: Severity;
  flag_message: string;
  /**
   * The fully-resolved metric value at the moment the band fired.
   * Useful for the LLM to cite specifics in narrative output, and for
   * debugging when the message-interpolation surface inevitably grows.
   */
  metricValue: FieldValue;
  /**
   * Which band fired, by zero-based index within its evaluation group,
   * plus which group fired by zero-based index. Useful for diagnostics
   * ("the SECOND band of the first group fired" vs the more-common case
   * where only one band per group).
   */
  groupIndex: number;
  bandIndex: number;
  injectionPoints: ReadonlyArray<InjectionPoint>;
}

/**
 * A principle that didn't fire — either trigger was false, deterministic
 * execution mode wasn't selected, the field bag was missing required data,
 * or no band matched. Kept as a distinct shape (not just absence) so
 * downstream consumers can distinguish "principle was checked and clean"
 * from "principle was checked and skipped because data was missing."
 */
export interface SkippedPrinciple {
  principleId: string;
  reason: SkipReason;
  /**
   * Optional detail string for diagnostics. For example, when reason is
   * 'missing_field', the missing field path. Engine fills this on a
   * best-effort basis — consumers should not parse it as structured data.
   */
  detail?: string;
}

export type SkipReason =
  /** Principle.trigger evaluated to false. */
  | 'trigger_inactive'
  /** Principle.executionModes does not include DETERMINISTIC. */
  | 'not_deterministic'
  /** Principle has executionMode DETERMINISTIC but no deterministicCheck block. */
  | 'no_check_defined'
  /** A field referenced by metric, threshold, or condition is absent from the bag. */
  | 'missing_field'
  /**
   * Metric resolved fine and group condition matched, but no band's
   * operator+threshold returned true.
   */
  | 'no_band_matched'
  /** No evaluation group's condition matched. */
  | 'no_group_matched'
  /**
   * The deterministic check is structurally well-formed against the
   * contract but cannot produce a meaningful result for this deal —
   * e.g., a formula divides by zero. Distinct from missing_field
   * because the inputs were present, just degenerate.
   */
  | 'degenerate_evaluation';

/**
 * Result of running the engine against a single principle.
 *
 * Either a flag fired (status: 'fired') or the principle was skipped for
 * one of the reasons above (status: 'skipped'). No "did not fire" case
 * because that's just an empty result — the engine reports skips, not
 * silent no-ops, so the api layer can surface diagnostic information when
 * data gaps are blocking checks.
 */
export type PrincipleEvaluationResult =
  | { status: 'fired'; flag: FiredFlag }
  | { status: 'skipped'; skip: SkippedPrinciple };

/**
 * Result of running the engine against the full handbook for a deal.
 */
export interface HandbookEvaluationResult {
  firedFlags: FiredFlag[];
  skippedPrinciples: SkippedPrinciple[];
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Look up a field path in the bag. Returns undefined for missing keys.
 * Path is a flat string for v1 — no dotted-path resolution. If we need
 * `sponsor.litigation_count` style paths later, this is the one chokepoint
 * to upgrade.
 */
export function getField(bag: FieldBag, path: string): FieldValue {
  return bag[path];
}

/**
 * `field_exists` semantics: the key is present and its value is not
 * undefined or null. A field set to `0` or `false` or empty string EXISTS;
 * those are valid values, not absence.
 */
export function fieldExists(bag: FieldBag, path: string): boolean {
  const v = bag[path];
  return v !== undefined && v !== null;
}

/**
 * `field_truthy` semantics — JavaScript truthiness, with the caveat that
 * a missing field is also falsy. Used by triggers like P-IV-MF-12 which
 * gates on `has_recent_substantial_renovation` being truthy.
 */
export function fieldTruthy(bag: FieldBag, path: string): boolean {
  return Boolean(bag[path]);
}

// Re-export Band so the formula and band evaluators can describe their
// inputs without reaching back into @cre/contracts.
export type { Band, ExecutionMode };
