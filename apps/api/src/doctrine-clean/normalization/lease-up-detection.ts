/**
 * Lease-up detection predicate — the deliberate (not default) router that
 * decides when the conservative "contracted-basis" doctrine applies.
 *
 * Historical bug being fixed: `sustainable-cashflow.ts:296-302` falls through
 * crediting the issuer's stabilized projection whenever `t12Noi === null`.
 * For Sunroad-shape deals (lease-up with positive contracted leases), that's
 * defensible. For a SPECULATIVE lease-up (vacant space, no signed leases),
 * crediting the issuer's stabilized projection is exactly the "Stabilized
 * NOI is a fantasy" antipattern the AI-prompts doctrine prose (`ai-prompts.
 * service.ts:21`) calls out.
 *
 * This predicate routes the conservative basis as a REASONED judgment from
 * five orthogonal signals — OR'd together because each one independently
 * makes a deal "lease-up enough" that crediting the issuer's projection
 * without independent verification is wrong.
 *
 * Signals (any one fires → predicate true):
 *   (1) trailing-12 actual NOI is non-positive — engine has direct evidence
 *       the property is below sustainable Y1; KBRA discipline says don't
 *       credit a positive projection over a negative trailing.
 *   (2) appraiser's currentProForma NOI < 0 — third-party appraisal observed
 *       the property in distress at the as-of date; same posture as (1) but
 *       sourced from the appraisal rather than seller CF.
 *   (3) `stabilizationMonths > 0` on the appraisal — the appraiser explicitly
 *       projects a stabilization tenor, which only happens for deals not yet
 *       at stabilized economics.
 *   (4) Occupancy gap > 10 pp — when stabilizedOccupancy is meaningfully
 *       above currentOccupancyPhysical, the property has a documented ramp.
 *       10 pp is the smallest gap that exceeds normal occupancy churn; below
 *       this we treat the deal as "operationally stabilized."
 *   (5) assetProfile.businessPlan === 'LeaseUp_or_Transitional' — the
 *       upstream profiler already classified the deal on its own thresholds
 *       (`asset-profiler.service.ts:64-73`); honoring it keeps the doctrine
 *       consistent with the rest of the system's lease-up flag.
 *
 * DOCTRINE-CLEAN FENCE COMPLIANCE: this predicate reads ONLY raw extraction
 * + AssetProfile. It does NOT read AdjustedInputs / valuationConclusion /
 * handbook output — preserving the same pure-input discipline the rest of
 * doctrine-clean honors.
 */

import type {
  AppraisalExtraction,
  AssetProfile,
  ExtractionResult,
} from '@cre/contracts';

/** Occupancy-gap threshold (decimal). 10 pp matches normal market churn. */
export const LEASE_UP_OCCUPANCY_GAP_THRESHOLD = 0.10 as const;

export interface LeaseUpDetectionInput {
  readonly extraction: ExtractionResult;
  readonly assetProfile: AssetProfile | null;
}

export interface LeaseUpDetectionTrace {
  readonly isLeaseUp: boolean;
  readonly signals: {
    readonly t12NonPositive: boolean;
    readonly appraisalCurrentNoiNegative: boolean;
    readonly stabilizationMonthsPresent: boolean;
    readonly occupancyGapMaterial: boolean;
    readonly assetProfilerSaysLeaseUp: boolean;
  };
  readonly note: string;
}

/**
 * Pure predicate over raw extraction + assetProfile. Returns a trace so
 * the caller can persist WHY a deal routed to (or away from) the
 * contracted basis — same explainability discipline as
 * sustainable-cashflow's NoiDivergenceTrace.
 */
export function detectLeaseUp(input: LeaseUpDetectionInput): LeaseUpDetectionTrace {
  const ex = input.extraction;
  const appraisal: AppraisalExtraction | null = ex.appraisal ?? null;

  const t12 = ex.t12Actual?.noi ?? null;
  const t12NonPositive = t12 !== null && t12 <= 0;

  const apprCurrentNoi = appraisal?.currentProForma?.netOperatingIncome ?? null;
  const appraisalCurrentNoiNegative = apprCurrentNoi !== null && apprCurrentNoi < 0;

  const stabilizationMonths = appraisal?.stabilizationMonths ?? null;
  const stabilizationMonthsPresent =
    stabilizationMonths !== null && stabilizationMonths > 0;

  const currentOcc = appraisal?.currentOccupancyPhysical ?? null;
  const stabOcc = appraisal?.stabilizedOccupancy ?? null;
  const occupancyGapMaterial =
    currentOcc !== null && stabOcc !== null &&
    stabOcc - currentOcc > LEASE_UP_OCCUPANCY_GAP_THRESHOLD;

  const assetProfilerSaysLeaseUp =
    input.assetProfile?.businessPlan === 'LeaseUp_or_Transitional';

  const signals = {
    t12NonPositive,
    appraisalCurrentNoiNegative,
    stabilizationMonthsPresent,
    occupancyGapMaterial,
    assetProfilerSaysLeaseUp,
  };
  const isLeaseUp =
    t12NonPositive ||
    appraisalCurrentNoiNegative ||
    stabilizationMonthsPresent ||
    occupancyGapMaterial ||
    assetProfilerSaysLeaseUp;

  const firedSignals: string[] = [];
  if (t12NonPositive) firedSignals.push(`t12 ≤ 0 (${t12})`);
  if (appraisalCurrentNoiNegative) firedSignals.push(`appraisal currentNoi < 0 (${apprCurrentNoi})`);
  if (stabilizationMonthsPresent) firedSignals.push(`stabilizationMonths=${stabilizationMonths}`);
  if (occupancyGapMaterial) {
    firedSignals.push(`occupancy gap=${((stabOcc! - currentOcc!) * 100).toFixed(1)}pp (current=${currentOcc}, stab=${stabOcc})`);
  }
  if (assetProfilerSaysLeaseUp) firedSignals.push(`assetProfile=LeaseUp_or_Transitional`);

  const note = isLeaseUp
    ? `lease-up detected — firing signal(s): ${firedSignals.join('; ')}`
    : `not a lease-up — no signal fired (t12=${t12}, apprCurrentNoi=${apprCurrentNoi}, stabMonths=${stabilizationMonths}, currentOcc=${currentOcc}, stabOcc=${stabOcc}, businessPlan=${input.assetProfile?.businessPlan ?? 'null'})`;

  return { isLeaseUp, signals, note };
}

/** Convenience predicate when the trace isn't needed. */
export function isLeaseUpDeal(input: LeaseUpDetectionInput): boolean {
  return detectLeaseUp(input).isLeaseUp;
}
