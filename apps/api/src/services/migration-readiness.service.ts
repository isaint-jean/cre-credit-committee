/**
 * Migration Readiness Aggregator.
 *
 * Reads the underwriting_observability_log and computes per-field
 * coverage / stability / fallback-pressure metrics, then renders a
 * verdict against the per-group thresholds defined in
 * field-migration-state.ts.
 *
 * Pure read. Does not mutate the log, schema, or any pipeline state.
 *
 * The output of this service is the SOLE permitted basis for declaring
 * a state transition in FIELD_STATE_REGISTRY (per spec §3 governance:
 * "no migration allowed without observability evidence").
 */
import type { UnderwritingObservabilityEvent } from './underwriting-observability.service.js';
import {
  FIELD_STATE_REGISTRY,
  REQUIRED_SOURCE_BY_STATE,
  THRESHOLDS,
  ADJUSTED_INPUTS_DEPRECATION,
  MIGRATION_ORDER,
  type FieldGroup,
  type FieldMigrationState,
} from './field-migration-state.js';

// --- Per-field metrics (derived from obs log) ------------------------------

export interface FieldReadinessMetrics {
  address: string;
  group: FieldGroup;
  currentState: FieldMigrationState;
  /** Total renders observed for this field. */
  observations: number;
  /** Coverage: fraction of renders where the cell carried a real value. */
  coverage: number;
  /** Stability: 1 - variance of fallback-pressure over the window. */
  stability: number;
  /** Fallback pressure: fraction of renders where this cell triggered a fallback. */
  fallbackPressure: number;
}

export interface FieldReadinessVerdict extends FieldReadinessMetrics {
  /** Threshold pack applied (depends on group). */
  thresholds: typeof THRESHOLDS[FieldGroup];
  /** True iff every individual metric clears its threshold. */
  meetsCoverage: boolean;
  meetsStability: boolean;
  meetsFallbackPressure: boolean;
  /** True iff all three thresholds are met AND observations ≥ minConsecutiveRuns. */
  eligibleForNextState: boolean;
  /** The state this cell would advance to next, or null if already at FULL_MODERN. */
  nextState: FieldMigrationState | null;
  /** Notes for the contributor — explains why eligibility was denied. */
  reasons: string[];
}

export interface ReadinessReport {
  contractVersion: number;
  generatedAt: string;
  windowSize: number;
  totalRendersInWindow: number;
  /** Global legacyDependencyRatio averaged over the window. */
  globalLegacyDependencyRatio: number;
  /**
   * AdjustedInputs deprecation eligibility — spec §5. True iff every
   * field is FULL_MODERN AND globalLegacyDependencyRatio < threshold AND
   * sustained over enough consecutive runs.
   */
  adjustedInputsDeprecationEligible: boolean;
  fields: FieldReadinessVerdict[];
  /** Group-rollup view: per group's average metrics. */
  groupSummary: Array<{
    group: FieldGroup;
    fieldCount: number;
    averageCoverage: number;
    averageStability: number;
    averageFallbackPressure: number;
    eligibleFieldCount: number;
  }>;
  migrationOrder: ReadonlyArray<FieldGroup>;
}

// --- Helpers ---------------------------------------------------------------

function variance(samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sq = samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / samples.length;
  return sq;
}

function nextStateFor(s: FieldMigrationState): FieldMigrationState | null {
  switch (s) {
    case 'LEGACY':        return 'DUAL_OBSERVED';
    case 'DUAL_OBSERVED': return 'HYBRID';
    case 'HYBRID':        return 'FULL_MODERN';
    case 'FULL_MODERN':   return null;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// --- Coverage signal -------------------------------------------------------
// Coverage for a cell at a given render = "did this cell carry a real
// value?" A cell read from resolvedContext counts as covered if the field
// map's `source: resolvedContext` cell did NOT carry the
// DATA_NOT_PROVIDED / NOT_AVAILABLE / REQUIRES_EXTERNAL_DATA sentinel
// at write time. Because the persisted event records source + fallback,
// not the literal value, we approximate coverage as: cell appears in
// fieldMap AND fallback === false (i.e. not a hydrator-driven value).
//
// This is a deliberate simplification for v1 of the readiness service.
// A future enhancement should record the literal CellValue at emission
// time so coverage can be computed exactly.

// --- Public entry: readiness over a window of events -----------------------

export function computeReadiness(
  events: UnderwritingObservabilityEvent[],
  contractVersion: number,
): ReadinessReport {
  const windowSize = events.length;
  const totalRendersInWindow = windowSize;

  const declared = FIELD_STATE_REGISTRY[contractVersion] ?? [];
  const verdicts: FieldReadinessVerdict[] = [];

  // Per-field aggregation.
  for (const decl of declared) {
    const samples: Array<{ source: string; fallback: boolean }> = [];
    for (const ev of events) {
      if (ev.contractVersion !== contractVersion) continue;
      const cell = ev.fieldMap.find((f) => f.field === decl.address);
      if (!cell) continue;
      samples.push({ source: cell.source, fallback: cell.fallback });
    }
    const observations = samples.length;
    const coverageHits = samples.filter((s) => s.source === REQUIRED_SOURCE_BY_STATE[decl.state] && !s.fallback).length;
    const coverage = observations > 0 ? coverageHits / observations : 0;
    const fallbackHits = samples.filter((s) => s.fallback).length;
    const fallbackPressure = observations > 0 ? fallbackHits / observations : 0;
    // Stability: 1 - variance(fallback pressure series in chunks). Chunk
    // the samples into fixed-size buckets and variance the per-bucket
    // pressure. Smaller variance → higher stability.
    const bucketSize = Math.max(1, Math.floor(samples.length / 5));
    const buckets: number[] = [];
    for (let i = 0; i < samples.length; i += bucketSize) {
      const slice = samples.slice(i, i + bucketSize);
      const fb = slice.filter((s) => s.fallback).length / Math.max(slice.length, 1);
      buckets.push(fb);
    }
    const stability = clamp01(1 - variance(buckets));

    const groupT = THRESHOLDS[decl.group];
    const meetsCoverage = coverage >= groupT.minCoverage;
    const meetsStability = stability >= groupT.minStability;
    const meetsFallbackPressure = fallbackPressure <= groupT.maxFallbackPressure;
    const enoughObservations = observations >= groupT.minConsecutiveRuns;

    const reasons: string[] = [];
    if (!enoughObservations)        reasons.push(`only ${observations} observations in window; need ≥ ${groupT.minConsecutiveRuns}`);
    if (!meetsCoverage)              reasons.push(`coverage ${coverage.toFixed(3)} < ${groupT.minCoverage}`);
    if (!meetsStability)             reasons.push(`stability ${stability.toFixed(3)} < ${groupT.minStability}`);
    if (!meetsFallbackPressure)      reasons.push(`fallbackPressure ${fallbackPressure.toFixed(3)} > ${groupT.maxFallbackPressure}`);
    if (decl.state === 'FULL_MODERN') reasons.push('already at FULL_MODERN — no further migration available');

    const eligibleForNextState =
      decl.state !== 'FULL_MODERN' &&
      enoughObservations &&
      meetsCoverage &&
      meetsStability &&
      meetsFallbackPressure;

    verdicts.push({
      address: decl.address,
      group: decl.group,
      currentState: decl.state,
      observations,
      coverage,
      stability,
      fallbackPressure,
      thresholds: groupT,
      meetsCoverage,
      meetsStability,
      meetsFallbackPressure,
      eligibleForNextState,
      nextState: nextStateFor(decl.state),
      reasons,
    });
  }

  // Group rollup.
  const groupSummary = (Object.keys(THRESHOLDS) as FieldGroup[]).map((group) => {
    const gv = verdicts.filter((v) => v.group === group);
    const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    return {
      group,
      fieldCount: gv.length,
      averageCoverage:        avg(gv.map((v) => v.coverage)),
      averageStability:       avg(gv.map((v) => v.stability)),
      averageFallbackPressure:avg(gv.map((v) => v.fallbackPressure)),
      eligibleFieldCount:     gv.filter((v) => v.eligibleForNextState).length,
    };
  });

  // Global legacy-dependency ratio (mean of metrics.legacyDependencyRatio).
  const globalLegacyDependencyRatio = events.length
    ? events.reduce((acc, e) => acc + e.metrics.legacyDependencyRatio, 0) / events.length
    : 0;

  // AdjustedInputs deprecation gate.
  const allFullModern = declared.length > 0 && declared.every((d) => d.state === 'FULL_MODERN');
  const lowEnoughLegacy = globalLegacyDependencyRatio < ADJUSTED_INPUTS_DEPRECATION.maxLegacyDependencyRatio;
  const sustainedRuns = events.length >= ADJUSTED_INPUTS_DEPRECATION.minConsecutiveRunsBelowRatio;
  const adjustedInputsDeprecationEligible = allFullModern && lowEnoughLegacy && sustainedRuns;

  return {
    contractVersion,
    generatedAt: new Date().toISOString(),
    windowSize,
    totalRendersInWindow,
    globalLegacyDependencyRatio,
    adjustedInputsDeprecationEligible,
    fields: verdicts,
    groupSummary,
    migrationOrder: MIGRATION_ORDER,
  };
}

// --- Sqlite log reader -----------------------------------------------------

/**
 * Read the most recent N events for a given contractVersion from
 * underwriting_observability_log. Returns [] if the table doesn't
 * exist yet.
 */
export function readObservabilityWindow(
  db: any,
  contractVersion: number,
  windowSize = 200,
): UnderwritingObservabilityEvent[] {
  try {
    const rows = db.prepare(
      `SELECT payload_json
         FROM underwriting_observability_log
         WHERE contract_version = ?
         ORDER BY id DESC
         LIMIT ?`,
    ).all(contractVersion, windowSize) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as UnderwritingObservabilityEvent);
  } catch (err) {
    // Table missing or query failed — readiness over an empty window.
    return [];
  }
}
