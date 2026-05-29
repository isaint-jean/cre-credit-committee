/**
 * format-flags — produce LLM-prompt-ready descriptors from a
 * HandbookEvaluation's fired flags, filtered to a single InjectionPoint.
 *
 * Piece A Phase 1 (batch 1) helper. The narrative producer calls this once
 * per injection-point slot it composes; in batch 1 only `executive_summary`
 * is consumed, but the utility is polymorphic over all four InjectionPoint
 * values so additional slots in later Phase 1 sub-batches need no rewrite.
 *
 * Determinism: same input → same output. Same severity tiebreaks by
 * principleId ascending. Same principleId is impossible by construction
 * (a principle fires at most once per evaluation) but the localeCompare
 * tiebreak is stable in either case.
 *
 * The returned shape drops engine-internal indices (groupIndex, bandIndex)
 * and serializes metricValue to a human-readable string. The narrative
 * producer concatenates these into prompt text via prompt-templates.ts.
 */

import type { FiredFlag, InjectionPoint, Severity } from '@cre/contracts';

/**
 * Ordering for prompt embedding: most severe first. Mirrors the SEVERITIES
 * tuple in @cre/contracts/handbook.ts (critical, high, medium, advisory).
 * The rank is private to this module — exposing it would tempt callers to
 * resort, defeating determinism.
 */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  advisory: 3,
};

/**
 * Compact, prompt-ready descriptor of a single fired flag. Fields are
 * named for LLM clarity rather than mirroring the engine's wire shape.
 */
export interface FormattedFlag {
  readonly principleId: string;
  readonly severity: Severity;
  readonly message: string;
  /**
   * String rendering of the FiredFlag.metricValue (number → decimal string,
   * string → as-is, array → comma-joined, null/undefined → "—"). Lossy by
   * design; the un-stringified value remains accessible on the source
   * HandbookEvaluation if any downstream needs the raw form.
   */
  readonly metric: string;
}

function formatMetric(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? value.toString() : value.toString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map((x) => formatMetric(x)).join(', ');
  return String(value);
}

/**
 * Filter `flags` to those whose `injectionPoints` include `point`, then
 * sort by severity rank (critical first), tiebreaking on principleId
 * ascending. Returns FormattedFlag[] suitable for prompt embedding.
 *
 * Empty input or no-matches returns []. The producer treats an empty
 * result as a no-flags narrative (still valid prose, no error).
 */
export function formatFlagsForInjectionPoint(
  flags: readonly FiredFlag[],
  point: InjectionPoint,
): FormattedFlag[] {
  return flags
    .filter((f) => f.injectionPoints.includes(point))
    .slice()
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity] ?? 99;
      const sb = SEVERITY_RANK[b.severity] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.principleId.localeCompare(b.principleId);
    })
    .map((f) => ({
      principleId: f.principleId,
      severity: f.severity,
      message: f.flag_message,
      metric: formatMetric(f.metricValue),
    }));
}

/**
 * Extract just the principle ids of flags that survived the filter for a
 * given injection point, sorted ascending for canonicalization stability.
 * Used by the producer to populate `NarrativeEvaluation.consumedFlagPrincipleIds`
 * — replay verification compares this set without re-running the LLM.
 */
export function consumedPrincipleIdsForInjectionPoint(
  flags: readonly FiredFlag[],
  point: InjectionPoint,
): string[] {
  return flags
    .filter((f) => f.injectionPoints.includes(point))
    .map((f) => f.principleId)
    .sort();
}
