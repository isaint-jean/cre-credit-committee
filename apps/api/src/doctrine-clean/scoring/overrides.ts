/**
 * doctrine-clean / scoring / overrides.ts
 *
 * SCORING ARCHITECTURE — STAGE 2 of 3 (committee overrides).
 *
 * Two overrides applied on top of the stage-1 base risk:
 *
 *   OVERRIDE A — SEVERE SINGLE FLAG.
 *     If any individual peer dim resolves at the HIGH tier (~0.80),
 *     the risk is floored at the elevated band-floor (~0.45). The
 *     effect: a deal with one severe red flag cannot end up in the
 *     Strong / Acceptable bands no matter how the rest of the
 *     committee read goes. Equivalent to a committee saying "we don't
 *     care what the other numbers say — this one alone keeps it out
 *     of the top bands." The floor never auto-declines — decline is
 *     earned by the aggregate, not a single signal. The mitigant
 *     layer (a later capability) handles cure paths.
 *
 *   OVERRIDE B — CONVERGENCE AMPLIFIER.
 *     Count INDEPENDENT signals (the six post-collapse signals from
 *     stage 1) at elevated+ (>= 0.55). If three or more converge, the
 *     base risk is amplified linearly: +0.05 per independent signal
 *     past two. Three converge → +0.05; six converge → +0.20. The
 *     pattern reflects committee judgment: two elevated signals are
 *     common variation; three or more is a multi-front pattern that
 *     pushes the deal toward decline range even if no single signal
 *     is severe. Capped at 1.0.
 *
 *   COMBINE: result = clamp1(max(amplified, severeFloor)).
 *
 * SPONSOR (dim 9) is NOT here. The sponsor modifier is the bounded
 * signed adjustment handled in stage 3 (where it modifies risk by up
 * to ±0.20). Sponsor severe does NOT floor the risk — that's the
 * point of the cap.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * scorer / old doctrine. Thresholds + amplification step are
 * convention-driven, NOT corpus-fit.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   Committee credit-review practice rarely lets a single number — be
 *   it leverage, value, or refi — be cancelled by averaging it against
 *   acceptable numbers. The aggregate view is informative, but human
 *   committees apply two corrections to the average: they refuse to
 *   accept a strong recommendation when a single signal is at the
 *   tail, and they apply extra weight when several signals point in
 *   the same direction at once. These two overrides encode those
 *   corrections.
 *
 *   The severe-single-flag override (0.45 floor on any high-tier
 *   resolved dim) is calibrated to the elevated band-floor: the floor
 *   caps the deal at "elevated risk, watch closely" and stops it from
 *   reading as Strong/Acceptable. It does not push the deal into
 *   decline by itself — a one-off severe signal often has a curable
 *   mitigant (cash equity, recourse, larger reserve). The mitigant
 *   layer is where that cure logic eventually lives; stage 2 just
 *   stops the deal from sailing through on an averaged read.
 *
 *   The convergence amplifier (+0.05 per signal past 2) is the
 *   multi-front pattern. The signals are independent (ratio-family
 *   collapses LTV/DSCR/DY into one signal precisely to prevent
 *   triple-counting at this stage as well). Three independent signals
 *   all reading elevated is a property under multi-front pressure —
 *   the structural read says something is materially wrong across
 *   axes. A small linear bump is the conservative amplifier; it adds
 *   roughly one band-edge of risk when 5-6 signals all converge,
 *   moving uniformly-elevated reads into the decline range while
 *   never overshooting 1.0.
 *
 *   The +0.05-per-signal step is convention-driven: it lands
 *   convergent uniform-elevated reads (0.55 base + 0.20 amplifier =
 *   0.75) inside the decline range (>= 0.65) without overcorrecting
 *   on moderate-base reads (0.30 base + 0.05 amplifier = 0.35 — still
 *   acceptable). Stage 3's bands operate on the post-override risk.
 *
 * INPUTS:
 *   - stage-1 BaseBlendResult (base risk + collapsed 6-signal table)
 *   - the original 8 peer DimensionContributions (severe-single-flag
 *     checks individual peer dims, not the collapsed signals — a
 *     single high-tier LTV resolves the severe-flag override even
 *     when DSCR + DY pull the ratio-family contribution below high)
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';
import type { BaseBlendResult } from './base-blend.js';

/**
 * Risk threshold for the HIGH tier — ANY resolved peer dim at or above
 * this level triggers OVERRIDE A (severe single flag). The dim files
 * use 0.80 for asset-class Tier IV / dim 1-3 high, 0.85 for rollover
 * high, and up to 0.90 for refinance convergent-stress. Threshold 0.75
 * cleanly separates the high band from the elevated band (0.55) without
 * being sensitive to per-dim numerical drift.
 */
export const SEVERE_HIGH_TIER_THRESHOLD = 0.75;

/**
 * Floor applied when OVERRIDE A fires — the elevated band-floor on the
 * 0-1 risk scale (~0.45). Caps the deal out of Strong/Acceptable while
 * leaving decline as an earned outcome (aggregate, not single flag).
 */
export const SEVERE_FLOOR = 0.45;

/**
 * Risk threshold for the ELEVATED tier — used to count independent
 * signals for OVERRIDE B (convergence amplifier). 0.55 is the elevated
 * band-floor across the dim files.
 */
export const ELEVATED_PLUS_THRESHOLD = 0.55;

/**
 * OVERRIDE B threshold: number of independent elevated+ signals at or
 * above which the convergence amplifier engages. Two elevated signals
 * are common variation; three is the multi-front pattern.
 */
export const CONVERGENCE_TRIGGER_COUNT = 3;

/**
 * OVERRIDE B step: amplification per independent elevated+ signal past
 * the trigger boundary (i.e., past 2). Three signals → +0.05; six
 * signals → +0.20. Convention-driven; NOT corpus-fit.
 */
export const CONVERGENCE_AMPLIFY_PER_SIGNAL = 0.05;

export interface OverrideResult {
  /** Final risk after both overrides applied, capped at 1.0. */
  readonly finalRisk: number | null;
  /** Risk after stage 1 (echoed for trace). */
  readonly baseRisk: number | null;
  /** Risk after convergence amplifier but BEFORE severe floor. */
  readonly amplifiedRisk: number | null;
  /** Was OVERRIDE A (severe single flag) triggered? */
  readonly severeFloorFired: boolean;
  /** Peer dim ids whose riskContribution crossed the SEVERE_HIGH_TIER_THRESHOLD. */
  readonly severeFlaggedDims: readonly string[];
  /** Was OVERRIDE B (convergence amplifier) triggered? */
  readonly convergenceAmplifierFired: boolean;
  /** Count of independent (post-collapse) signals at elevated+. */
  readonly independentElevatedCount: number;
  /** Identity of those signals. */
  readonly independentElevatedSignals: readonly string[];
  /** Magnitude of convergence amplification (in raw risk units; 0 if not fired). */
  readonly convergenceAmplifierMagnitude: number;
  readonly rationale: string;
  readonly provenance: readonly string[];
}

function clamp1(x: number): number {
  return Math.min(1.0, Math.max(0.0, x));
}

export function applyOverrides(
  baseBlend: BaseBlendResult,
  contributions: readonly DimensionContribution[],
): OverrideResult {
  const baseRisk = baseBlend.baseRisk;

  // OVERRIDE A — Severe single flag (check each PEER dim individually,
  // not the collapsed signals). Only RESOLVED applicable dims count;
  // N/A and HITL cannot trigger.
  const severeFlaggedDims: string[] = [];
  for (const c of contributions) {
    if (c.applicability !== 'applicable') continue;
    if (typeof c.riskContribution !== 'number') continue;
    if (c.riskContribution >= SEVERE_HIGH_TIER_THRESHOLD) {
      severeFlaggedDims.push(c.dimensionId);
    }
  }
  const severeFloorFired = severeFlaggedDims.length > 0;

  // OVERRIDE B — Convergence amplifier (count post-collapse signals at
  // elevated+; ratio-family is one signal, not three). Uses stage-1's
  // weightedContributions which already reflects the ratio collapse and
  // excludes N/A + HITL.
  const independentElevatedSignals: string[] = [];
  for (const wc of baseBlend.weightedContributions) {
    if (wc.riskContribution >= ELEVATED_PLUS_THRESHOLD) {
      independentElevatedSignals.push(wc.signalId);
    }
  }
  const independentElevatedCount = independentElevatedSignals.length;
  const convergenceAmplifierFired = independentElevatedCount >= CONVERGENCE_TRIGGER_COUNT;
  const convergenceAmplifierMagnitude = convergenceAmplifierFired
    ? CONVERGENCE_AMPLIFY_PER_SIGNAL * (independentElevatedCount - (CONVERGENCE_TRIGGER_COUNT - 1))
    : 0;

  // If base couldn't be computed, propagate null but still report
  // which dims would have triggered (informational).
  if (baseRisk === null) {
    return {
      finalRisk: null,
      baseRisk: null,
      amplifiedRisk: null,
      severeFloorFired,
      severeFlaggedDims,
      convergenceAmplifierFired,
      independentElevatedCount,
      independentElevatedSignals,
      convergenceAmplifierMagnitude,
      rationale:
        '[base risk unresolved — overrides informational only] ' +
        `Severe-flag dims: ${severeFlaggedDims.length}; convergence signals: ${independentElevatedCount}. ` +
        'Stage 3 will gate on this.',
      provenance: ['stage 2 — base risk unresolved; overrides reported but not applied'],
    };
  }

  // Apply convergence amplifier first; severe floor is a MAX-floor on the
  // amplified value. Cap at 1.0.
  const amplifiedRisk = clamp1(baseRisk + convergenceAmplifierMagnitude);
  const flooredRisk = severeFloorFired ? Math.max(amplifiedRisk, SEVERE_FLOOR) : amplifiedRisk;
  const finalRisk = clamp1(flooredRisk);

  const rationaleParts: string[] = [];
  rationaleParts.push(`base risk ${baseRisk.toFixed(3)}`);
  if (convergenceAmplifierFired) {
    rationaleParts.push(`convergence amplifier: ${independentElevatedCount} independent signals at elevated+ (${independentElevatedSignals.join(', ')}) → +${convergenceAmplifierMagnitude.toFixed(3)} → ${amplifiedRisk.toFixed(3)}`);
  } else if (independentElevatedCount > 0) {
    rationaleParts.push(`${independentElevatedCount}/${CONVERGENCE_TRIGGER_COUNT} elevated+ signals — below convergence trigger, no amplification`);
  }
  if (severeFloorFired) {
    rationaleParts.push(`severe single flag: ${severeFlaggedDims.join(', ')} at high tier → floor at ${SEVERE_FLOOR.toFixed(2)} (Strong/Acceptable blocked)`);
  }
  rationaleParts.push(`final risk ${finalRisk.toFixed(3)}`);

  return {
    finalRisk,
    baseRisk,
    amplifiedRisk,
    severeFloorFired,
    severeFlaggedDims,
    convergenceAmplifierFired,
    independentElevatedCount,
    independentElevatedSignals,
    convergenceAmplifierMagnitude,
    rationale: rationaleParts.join('; '),
    provenance: [
      'doctrine-clean scoring stage 2 — committee overrides on stage-1 base risk',
      `Override A (severe single flag): floor at ${SEVERE_FLOOR.toFixed(2)} when ANY peer dim resolves at high tier (>= ${SEVERE_HIGH_TIER_THRESHOLD.toFixed(2)}); blocks Strong/Acceptable but does NOT auto-decline`,
      `Override B (convergence amplifier): +${CONVERGENCE_AMPLIFY_PER_SIGNAL.toFixed(2)} per independent elevated+ signal past ${CONVERGENCE_TRIGGER_COUNT - 1}; uses the 6 post-collapse signals (ratio-family counted once)`,
      `Combine: clamp1(max(amplified, severeFloor)) — convergence amplifies, severe floors, never overshoots 1.0`,
      'N/A and HITL signals do not contribute to severe-flag check or convergence count (excluded from risk math at stage 1)',
      'Sponsor dim (9) NOT here — bounded signed modifier handled in stage 3',
      'Thresholds + amplification step convention-driven (committee credit-review practice), NOT corpus-fit',
    ],
  };
}
