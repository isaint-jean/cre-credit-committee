/**
 * doctrine-clean / scoring / rating.ts
 *
 * SCORING ARCHITECTURE — STAGE 3 of 3 (final rating).
 *
 * Completes the assembly:
 *   1. Apply the sponsor (dim 9) bounded signed modifier (±0.20) on
 *      top of the stage-2 finalRisk, clamped to [0, 1].
 *   2. Coverage gating — return InsufficientData when the valuation
 *      spine (dim 7) is HITL OR when fewer than half of the applicable
 *      peer dims resolved. Never bluff a rating on too-thin coverage.
 *   3. Map the post-modifier risk to one of FIVE bands (Strong,
 *      Acceptable, Watch, Elevated, Decline).
 *   4. Map the band to a 3-level recommendation
 *      (Approve / ApproveWithConditions / Decline).
 *   5. Emit a full RatingResult: band + recommendation + finalRisk +
 *      fired-override record + coverage + sponsor-modifier-applied.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * scorer / old doctrine. Band cuts + coverage threshold are
 * convention-driven, NOT corpus-fit. The cuts are CALIBRATED for
 * REACHABILITY (synthetic all-low → Strong; all-high-convergent →
 * Decline) and adjusted ONLY if reachability / range-usage breaks.
 * The corpus is signal-weighted (not representative); we do not
 * target "typical → Acceptable" or any other corpus-median outcome.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   The 9-dim doctrine + the stage-1/stage-2 aggregation produces a
 *   number on [0, 1]. Stage 3 turns that number into a credit
 *   committee's actionable read. Three things happen here that no
 *   prior stage can do:
 *
 *   (a) SPONSOR — the qualitative overlay. Dim 9 is a bounded signed
 *       modifier (±0.20), not a peer tier. Adding it AFTER the
 *       structural overrides keeps the sponsor read from masking the
 *       cash-flow / structural reads. A strong sponsor can move a
 *       deal one band down; a Severe factor-4 issue can move it one
 *       band up. Sponsor cannot create a Decline or rescue a Decline
 *       — DBRS's ~2-notch convention is the discipline.
 *
 *   (b) COVERAGE GATING — committees refuse to rate what they can't
 *       see. Two gates: (i) the valuation spine (dim 7) MUST resolve,
 *       because every other risk read sizes off the stressed value
 *       it produces; (ii) at least half of the peer dims that
 *       potentially could apply must have resolved. Below those
 *       thresholds, the rating is InsufficientData — flagged for
 *       human review rather than guessed.
 *
 *   (c) BANDS + RECOMMENDATION — five risk bands mapped to three
 *       actions. Strong + Acceptable get Approve; Watch + Elevated
 *       get ApproveWithConditions (the conditions are the mitigants —
 *       larger reserve, recourse, tighter covenants, additional
 *       equity); Decline gets Decline (or restructure-required, but
 *       the doctrine itself does not prescribe the restructure path).
 *       Band cuts are calibrated for reachability against the stage-2
 *       distribution: 0.15 marks the Strong/Acceptable boundary (well
 *       below all-low uniform); 0.45 marks the elevated band-floor
 *       (the severe-floor target from stage 2); 0.65 marks Decline
 *       (the convergent-elevated band that stage 2's convergence
 *       amplifier reaches).
 *
 *   The recommendation is a committee read, not a regulatory action.
 *   It distills the doctrine's structural + ratio + structural-
 *   adjustment signal into one of three operator actions and a band
 *   label that explains why.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';
import type { BaseBlendResult, CoverageRecord } from './base-blend.js';
import type { OverrideResult } from './overrides.js';

export type RatingBand = 'Strong' | 'Acceptable' | 'Watch' | 'Elevated' | 'Decline';
export type Recommendation = 'Approve' | 'ApproveWithConditions' | 'Decline' | 'InsufficientData';

/**
 * Band cut-points on the post-modifier risk scale [0, 1]. Each cut is
 * the UPPER edge (exclusive) of the band below it; the next band
 * starts at the cut. Convention-driven, NOT corpus-fit.
 */
export const RATING_BAND_CUTS = {
  /** Below this → Strong. */
  strongMax: 0.15,
  /** Strong/Acceptable boundary. Below this → Acceptable. */
  acceptableMax: 0.30,
  /** Acceptable/Watch boundary. Below this → Watch. */
  watchMax: 0.45,
  /** Watch/Elevated boundary. Below this → Elevated. (Equal to severe-floor / elevated band-floor.) */
  elevatedMax: 0.65,
  /** Elevated/Decline boundary. At or above → Decline. */
} as const;

/**
 * Coverage gating — required minimum fraction of peer dims that are
 * APPLICABLE relative to the dims that COULD have applied (applicable
 * + HITL; N/A-by-asset-type excluded so a multifamily isn't penalized
 * for legitimately absent concentration). Below this → InsufficientData.
 */
export const COVERAGE_RELIABILITY_THRESHOLD = 0.5;

/**
 * Dim ID of the valuation spine. Must be resolved (applicable) for the
 * coverage gate to pass — every other ratio sizes off the stressed
 * value the cap-rate dim produces.
 */
export const SPINE_DIM_ID = 'cap-rate-valuation-stress';

/** Dim ID of the sponsor dim (9). Provides the bounded signed modifier. */
export const SPONSOR_DIM_ID = 'sponsor-borrower-quality';

export interface RatingResult {
  /** Post-sponsor-modifier risk, clamped to [0, 1]. Null when InsufficientData. */
  readonly ratedRisk: number | null;
  /** Five-band label, or null when InsufficientData. */
  readonly band: RatingBand | null;
  /** Three-level action, or 'InsufficientData' when gating fails. */
  readonly recommendation: Recommendation;
  /** Stage-1 base risk (echoed for trace). */
  readonly baseRisk: number | null;
  /** Stage-2 finalRisk (post overrides, pre sponsor modifier). */
  readonly postOverrideRisk: number | null;
  /** Same as ratedRisk; named for clarity in trace. */
  readonly postSponsorRisk: number | null;
  /** Did the sponsor modifier apply (non-zero, applicable, non-HITL)? */
  readonly sponsorModifierApplied: boolean;
  /** The signed modifier value used (0 if not applied). */
  readonly sponsorModifierValue: number;
  /** Did coverage gating fail? */
  readonly coverageGateFailed: boolean;
  /** Human-readable reason for gate failure (null if passed). */
  readonly coverageGateReason: string | null;
  /** Coverage reliability metric used: applicable / (applicable + hitl). */
  readonly coverageReliability: number;
  /** Was the valuation spine (dim 7) resolved? */
  readonly spineResolved: boolean;
  /** Red flags surfaced for committee narrative. */
  readonly redFlags: readonly string[];
  /** Coverage record echoed for downstream consumers. */
  readonly coverage: CoverageRecord;
  readonly rationale: string;
  readonly provenance: readonly string[];
}

function clamp1(x: number): number {
  return Math.min(1.0, Math.max(0.0, x));
}

function mapToBand(risk: number): RatingBand {
  if (risk < RATING_BAND_CUTS.strongMax)     return 'Strong';
  if (risk < RATING_BAND_CUTS.acceptableMax) return 'Acceptable';
  if (risk < RATING_BAND_CUTS.watchMax)      return 'Watch';
  if (risk < RATING_BAND_CUTS.elevatedMax)   return 'Elevated';
  return 'Decline';
}

function bandToRecommendation(b: RatingBand): Recommendation {
  switch (b) {
    case 'Strong':
    case 'Acceptable':
      return 'Approve';
    case 'Watch':
    case 'Elevated':
      return 'ApproveWithConditions';
    case 'Decline':
      return 'Decline';
  }
}

export function computeRating(
  baseBlend: BaseBlendResult,
  overrides: OverrideResult,
  contributions: readonly DimensionContribution[],
): RatingResult {
  // Find the sponsor contribution; pick its riskModifier if present + applicable.
  const sponsor = contributions.find(c => c.dimensionId === SPONSOR_DIM_ID);
  const sponsorModifierValue = sponsor !== undefined
    && sponsor.applicability === 'applicable'
    && typeof sponsor.riskModifier === 'number'
    ? sponsor.riskModifier
    : 0;
  const sponsorModifierApplied = sponsorModifierValue !== 0;

  // (1) Apply sponsor modifier to stage-2 finalRisk.
  const postOverrideRisk = overrides.finalRisk;
  const postSponsorRisk = postOverrideRisk === null
    ? null
    : clamp1(postOverrideRisk + sponsorModifierValue);

  // (2) Coverage gating.
  const coverage = baseBlend.coverage;
  const spineResolved = coverage.applicable.includes(SPINE_DIM_ID);
  const denom = coverage.applicable.length + coverage.hitlNeeded.length;
  const coverageReliability = denom === 0 ? 0 : coverage.applicable.length / denom;
  let coverageGateFailed = false;
  let coverageGateReason: string | null = null;
  if (!spineResolved) {
    coverageGateFailed = true;
    coverageGateReason = `valuation spine (${SPINE_DIM_ID}) not resolved`;
  } else if (coverageReliability < COVERAGE_RELIABILITY_THRESHOLD) {
    coverageGateFailed = true;
    coverageGateReason = `coverage reliability ${(coverageReliability * 100).toFixed(0)}% < ${(COVERAGE_RELIABILITY_THRESHOLD * 100).toFixed(0)}% threshold (applicable ${coverage.applicable.length} / hitl ${coverage.hitlNeeded.length})`;
  } else if (postSponsorRisk === null) {
    coverageGateFailed = true;
    coverageGateReason = 'stage-2 risk could not be computed (no signal resolved)';
  }

  // Build red flags.
  const redFlags: string[] = [];
  for (const d of overrides.severeFlaggedDims) {
    redFlags.push(`severe single flag: ${d} at high tier (≥ 0.75)`);
  }
  if (overrides.convergenceAmplifierFired) {
    redFlags.push(`convergence: ${overrides.independentElevatedCount} independent signals at elevated+ (${overrides.independentElevatedSignals.join(', ')}) → +${overrides.convergenceAmplifierMagnitude.toFixed(2)} risk`);
  }
  if (sponsorModifierApplied) {
    const dir = sponsorModifierValue > 0 ? 'risk-increasing' : 'risk-reducing';
    redFlags.push(`sponsor (${sponsor!.tier}): ${dir} ${sponsorModifierValue >= 0 ? '+' : ''}${sponsorModifierValue.toFixed(2)}`);
  }
  if (coverageGateFailed) {
    redFlags.push(`coverage gate: ${coverageGateReason}`);
  }

  // (3) + (4) — band + recommendation, or InsufficientData.
  if (coverageGateFailed || postSponsorRisk === null) {
    return {
      ratedRisk: null,
      band: null,
      recommendation: 'InsufficientData',
      baseRisk: baseBlend.baseRisk,
      postOverrideRisk,
      postSponsorRisk,
      sponsorModifierApplied,
      sponsorModifierValue,
      coverageGateFailed: true,
      coverageGateReason: coverageGateReason ?? 'risk could not be computed',
      coverageReliability,
      spineResolved,
      redFlags,
      coverage,
      rationale: `Insufficient coverage for a rating: ${coverageGateReason ?? 'risk could not be computed'}. ` +
                 `Applicable peer dims: ${coverage.applicable.length}; HITL: ${coverage.hitlNeeded.length}; N/A: ${coverage.naByAssetType.length}. ` +
                 `Spine resolved: ${spineResolved}. Route to human review.`,
      provenance: [
        'doctrine-clean scoring stage 3 — coverage gating',
        `Gate (i): valuation spine (${SPINE_DIM_ID}) must resolve — every other risk read sizes off the dim-7 stressed value`,
        `Gate (ii): coverage reliability >= ${(COVERAGE_RELIABILITY_THRESHOLD * 100).toFixed(0)}% (applicable / (applicable + hitl), N/A excluded)`,
        'When either gate fails, recommendation = InsufficientData (route to HITL, not a band)',
      ],
    };
  }

  const band = mapToBand(postSponsorRisk);
  const recommendation = bandToRecommendation(band);

  const rationale =
    `base ${(baseBlend.baseRisk ?? 0).toFixed(3)} → post-override ${postOverrideRisk!.toFixed(3)} → ` +
    `${sponsorModifierApplied ? `sponsor ${sponsorModifierValue >= 0 ? '+' : ''}${sponsorModifierValue.toFixed(2)} → ` : ''}` +
    `rated ${postSponsorRisk!.toFixed(3)} → band ${band} → recommendation ${recommendation}. ` +
    `Coverage reliability ${(coverageReliability * 100).toFixed(0)}% (applicable ${coverage.applicable.length}, hitl ${coverage.hitlNeeded.length}, N/A ${coverage.naByAssetType.length}). ` +
    `Red flags: ${redFlags.length === 0 ? 'none' : redFlags.length}.`;

  return {
    ratedRisk: postSponsorRisk,
    band,
    recommendation,
    baseRisk: baseBlend.baseRisk,
    postOverrideRisk,
    postSponsorRisk,
    sponsorModifierApplied,
    sponsorModifierValue,
    coverageGateFailed: false,
    coverageGateReason: null,
    coverageReliability,
    spineResolved,
    redFlags,
    coverage,
    rationale,
    provenance: [
      'doctrine-clean scoring stage 3 — sponsor modifier + coverage gating + bands + recommendation',
      `Sponsor (dim 9) bounded signed modifier ±0.20 (DBRS ~2-notch convention) applied AFTER overrides`,
      `Five bands: Strong [0, ${RATING_BAND_CUTS.strongMax.toFixed(2)}) / Acceptable [${RATING_BAND_CUTS.strongMax.toFixed(2)}, ${RATING_BAND_CUTS.acceptableMax.toFixed(2)}) / Watch [${RATING_BAND_CUTS.acceptableMax.toFixed(2)}, ${RATING_BAND_CUTS.watchMax.toFixed(2)}) / Elevated [${RATING_BAND_CUTS.watchMax.toFixed(2)}, ${RATING_BAND_CUTS.elevatedMax.toFixed(2)}) / Decline [${RATING_BAND_CUTS.elevatedMax.toFixed(2)}, 1.0]`,
      'Three-level action: Strong/Acceptable → Approve; Watch/Elevated → ApproveWithConditions; Decline → Decline',
      `Coverage gate: spine (${SPINE_DIM_ID}) resolved AND reliability >= ${(COVERAGE_RELIABILITY_THRESHOLD * 100).toFixed(0)}%`,
      'Band cuts convention-driven for REACHABILITY (synthetic all-low → Strong; all-high-convergent → Decline), NOT corpus-fit',
      'Corpus is signal-weighted (not representative) — do not target a corpus-median outcome',
    ],
  };
}
