/**
 * portfolio-concentration.ts — PORTFOLIO PHASE 3
 *
 * The PORTFOLIO CONCENTRATION DIMENSION. Phase 2's aggregator COMPUTES the
 * concentration numbers (top-property share, geographic mix, asset-class mix,
 * Herfindahl); THIS layer SCORES them — turns those numbers into a banded risk
 * tier (a portfolio-level risk signal), reusing the banded-tier PATTERN from
 * the single-property doctrine dimensions.
 *
 * ★ ARCHITECTURE — this is a NEW, PORTFOLIO-ONLY, ADDITIVE dimension. It lives
 *   in the PORTFOLIO layer (services/), NOT in doctrine-clean/. It does NOT
 *   touch evaluateDeal(), the 9 single-property dimensions, or any doctrine
 *   threshold. The single-property (N=1) scoring path is byte-identical — this
 *   dimension is never called on that path and legitimately does NOT apply to a
 *   single-property "portfolio" (see applicability below).
 *
 * ★ PATTERN REUSE — banded-tier shape lifted from
 *   doctrine-clean/dimensions/asset-class.ts (TIER_DEFINITIONS → CLASS_TO_TIER
 *   lookup → riskContribution per tier) and debt-yield.ts (band cutoffs +
 *   per-band riskContribution + rationale). We DO NOT modify those files; we
 *   mirror their shape. The output uses the SAME DimensionContribution contract
 *   the doctrine dims emit, so the portfolio surface reads homogeneously.
 *
 * ★★ THRESHOLDS ARE ISABELLE'S B-PIECE JUDGMENT — NOT DATA-DERIVABLE. Unlike a
 *   debt-yield floor (an agency-published number), the concentration bands are a
 *   RISK-APPETITE choice. The block below carries PROPOSED DEFAULTS with a
 *   source/reasoning for each, clearly labeled "PROPOSED — Isabelle to tune".
 *   They are PROVISIONAL. To tune, edit ONE block (CONCENTRATION_THRESHOLDS);
 *   nothing else changes.
 *
 * NO DB writes. Pure struct→struct. No LLM.
 */
import type { DimensionContribution } from '../doctrine-clean/types.js';
import type { PortfolioConcentration } from './portfolio-aggregator.service.js';

/* ================================================================== */
/*  ★★ PROPOSED THRESHOLDS — "Isabelle to tune" (PROVISIONAL) ★★       */
/* ================================================================== */
/**
 * The concentration risk bands. These are a RISK-APPETITE JUDGMENT, not a
 * data-derived number — surfaced as PROPOSED DEFAULTS for Isabelle to accept or
 * adjust. Each carries the reasoning / source it was anchored to.
 *
 * Sources referenced (analogy, not a single published table — a concentration
 * appetite doesn't have one):
 *   - DBRS Morningstar / KBRA / Moody's CMBS diversity scoring: agencies reward
 *     effective-property-count / geographic / property-type diversity and
 *     penalize concentrated pools; single-tenant / single-asset / single-MSA
 *     pools carry an explicit concentration add-on.
 *   - HHI / DOJ-FTC Horizontal Merger Guidelines analogy for the Herfindahl
 *     cutoffs: HHI < 0.15 "unconcentrated", 0.15–0.25 "moderately concentrated",
 *     > 0.25 "highly concentrated". CRE pools scale the same math (Σ share²).
 *   - CMBS single-borrower / large-loan norms: a portfolio whose largest asset
 *     is > ~40–50% of value reads as a de-facto single-asset credit; a
 *     single-property-type or single-state pool loses the diversification credit
 *     the roll-up structure is supposed to buy.
 *
 * ★ Bands run lowest-risk → highest-risk; riskContribution mirrors the
 *   doctrine 4-band scale (0.10 / 0.30 / 0.55 / 0.80) so the portfolio signal
 *   sits on the SAME 0..1 risk scale as the doctrine dims (asset-class,
 *   debt-yield) — NOT a new scale.
 */
export const CONCENTRATION_THRESHOLDS = {
  /** Provenance banner — printed on every rationale so nobody mistakes these
   *  provisional numbers for a published standard. */
  status: 'PROPOSED — Isabelle to tune (PROVISIONAL, not a published standard)',

  /**
   * TOP-PROPERTY value share (largest single asset ÷ Σ value). Bands the
   * single-asset-dominance risk. Anchored to CMBS single-asset norms.
   */
  topPropertyShare: {
    /** < 20% → diversified: no single asset dominates.               → tier I  */
    diversifiedBelow: 0.20,
    /** [20%, 35%) → moderate single-asset weight.                    → tier II */
    moderateBelow: 0.35,
    /** [35%, 50%) → concentrated: largest asset is a material driver.→ tier III*/
    concentratedBelow: 0.50,
    /** ≥ 50% → dominant: de-facto single-asset credit.               → tier IV */
    // (dominant is the ≥ concentratedBelow bucket)
    source:
      'CMBS single-asset norms: largest asset > ~40–50% of value reads as a ' +
      'de-facto single-asset credit; 20% diversification threshold ≈ 5 equal ' +
      'assets. PROPOSED — Isabelle to tune.',
  },

  /**
   * HERFINDAHL index (Σ per-property value share²). Bands overall value
   * dispersion. Anchored to the DOJ-FTC HHI cutoffs (rescaled to 0..1).
   */
  herfindahl: {
    /** < 0.15 → well-diversified pool (> ~6.7 effective properties). → tier I  */
    diversifiedBelow: 0.15,
    /** [0.15, 0.25) → moderately concentrated (4–6.7 effective).     → tier II */
    moderateBelow: 0.25,
    /** [0.25, 0.50) → concentrated (2–4 effective properties).       → tier III*/
    concentratedBelow: 0.50,
    /** ≥ 0.50 → highly concentrated (< 2 effective properties).      → tier IV */
    source:
      'DOJ-FTC Horizontal Merger Guidelines HHI analogy: <0.15 unconcentrated, ' +
      '0.15–0.25 moderately concentrated, >0.25 highly concentrated. 0.50 = ' +
      'fewer than 2 effective properties. PROPOSED — Isabelle to tune.',
  },

  /**
   * SINGLE-GEOGRAPHY flag: one state ≥ this share of value → geographic
   * concentration add-on. 90% (not 100%) tolerates a de-minimis out-of-state
   * asset while still flagging a single-market pool.
   */
  singleGeographyShareFlag: {
    threshold: 0.90,
    source:
      'DBRS/KBRA/Moody\'s diversity scoring: a single-MSA / single-state pool ' +
      'loses geographic-diversification credit (correlated local-market shock, ' +
      'single natural-catastrophe exposure). 90% tolerates a de-minimis ' +
      'out-of-state asset. PROPOSED — Isabelle to tune.',
  },

  /**
   * SINGLE-ASSET-CLASS flag: one property type ≥ this share of value →
   * property-type concentration add-on.
   */
  singleAssetClassShareFlag: {
    threshold: 0.90,
    source:
      'Agency diversity scoring: a single-property-type pool loses ' +
      'property-type-diversification credit (correlated sector shock — e.g. an ' +
      'all-office or all-self-storage pool moves as one sector). 90% tolerates ' +
      'a de-minimis off-type asset. PROPOSED — Isabelle to tune.',
  },

  /**
   * BAND riskContributions — mirror the doctrine 4-band scale so this signal is
   * on the SAME 0..1 risk axis as the doctrine dimensions. PROPOSED — tunable.
   */
  bandRiskContribution: {
    I: 0.10,   // diversified
    II: 0.30,  // moderate
    III: 0.55, // concentrated
    IV: 0.80,  // dominant / highly concentrated
    source:
      'Mirrors the doctrine 4-band scale (asset-class / debt-yield: ' +
      '0.10/0.30/0.55/0.80) so the portfolio concentration signal sits on the ' +
      'same 0..1 risk axis. PROPOSED — Isabelle to tune.',
  },

  /**
   * SINGLE-FLAG risk ADD-ON. Each of {single-geography, single-asset-class}
   * that fires nudges the base tier's risk UP by this amount, capped at the
   * top-of-scale (0.80). Kept small so a flag SHADES the tier, doesn't swing it.
   */
  singleFlagRiskAddOn: {
    perFlag: 0.075,
    cap: 0.80,
    source:
      'A concentration FLAG is a shade, not a re-tier: +0.075 per flag (two ' +
      'flags ≈ +0.15 ≈ one band), capped at the 0.80 top-of-scale. PROPOSED — ' +
      'Isabelle to tune.',
  },

  /**
   * EFFECTIVE-LEVEL cutoffs. Map the FINAL risk contribution (base dispersion
   * band + correlation add-ons) to a human-legible level. The base `tier`
   * measures dispersion; this is the COMBINED read (what actually lands PSB in
   * "elevated" despite a moderate dispersion band). Cutoffs align to the
   * doctrine band edges (Watch/Elevated ≈ 0.45).
   */
  effectiveLevel: {
    /** < 0.20 → diversified · [0.20,0.45) → moderate · [0.45,0.70) → elevated · ≥0.70 → high */
    moderateAt: 0.20,
    elevatedAt: 0.45,
    highAt: 0.70,
    source:
      'Effective-concentration level = final risk contribution (base dispersion + ' +
      'correlation flags) mapped to diversified/moderate/elevated/high, aligned to ' +
      'the doctrine band edges. PROPOSED — Isabelle to tune.',
  },
} as const;

/* ================================================================== */
/*  Banded-tier evaluation (pattern mirrors debt-yield.ts bands)      */
/* ================================================================== */

type ConcentrationTier = 'I' | 'II' | 'III' | 'IV';

/** Band a 0..1 share against a {diversified/moderate/concentrated} cutoff set. */
function bandShare(
  x: number,
  cuts: { diversifiedBelow: number; moderateBelow: number; concentratedBelow: number },
): ConcentrationTier {
  if (x < cuts.diversifiedBelow) return 'I';
  if (x < cuts.moderateBelow) return 'II';
  if (x < cuts.concentratedBelow) return 'III';
  return 'IV';
}

const TIER_ORDER: readonly ConcentrationTier[] = ['I', 'II', 'III', 'IV'];
function maxTier(a: ConcentrationTier, b: ConcentrationTier): ConcentrationTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Map the FINAL risk contribution (base band + single-flag add-ons) back to a
 * human-legible level on the doctrine 4-band scale. This is the EFFECTIVE
 * concentration read — a moderate-dispersion pool that is single-sector AND
 * single-geography can reach "elevated" via the correlation add-ons even though
 * its base dispersion band is only moderate (that IS the PSB case). The base
 * `tier` measures DISPERSION (effective property count); this level measures
 * the COMBINED concentration risk actually contributed.
 */
export type ConcentrationLevel = 'diversified' | 'moderate' | 'elevated' | 'high';
function levelForRisk(risk: number): ConcentrationLevel {
  const L = CONCENTRATION_THRESHOLDS.effectiveLevel;
  const EPS = 1e-9; // absorb float error at exact band edges (e.g. 0.30 + 2×0.075).
  if (risk < L.moderateAt - EPS) return 'diversified';
  if (risk < L.elevatedAt - EPS) return 'moderate';
  if (risk < L.highAt - EPS) return 'elevated';
  return 'high';
}

/**
 * Input to the concentration dimension. `loanCount` gates applicability:
 * concentration is PORTFOLIO-ONLY (N > 1). The `concentration` block is
 * Phase 2's computed `PortfolioConcentration`.
 */
export interface ConcentrationDimensionInput {
  readonly loanCount: number;
  readonly concentration: PortfolioConcentration;
}

/**
 * Evaluate the PORTFOLIO CONCENTRATION dimension.
 *
 * ★ APPLICABILITY — PORTFOLIO-ONLY:
 *   - N ≤ 1  → NOT APPLICABLE. A single-property "portfolio" has trivial 100%
 *     concentration BY CONSTRUCTION — that is not a risk, it is the definition
 *     of a single-asset loan (already scored in full by the 9 doctrine dims).
 *     Flagging it would double-count and mislabel a normal single-asset deal as
 *     "concentrated". Returns applicability 'not-applicable-by-asset-type',
 *     riskContribution null, tier 'N/A'. NEVER fires.
 *   - Missing metrics (Σvalue == 0 → null shares) → HITL, never a fabricated
 *     tier.
 *
 * Pure function; no I/O; no doctrine touch.
 */
export function evaluatePortfolioConcentration(
  input: ConcentrationDimensionInput,
): DimensionContribution {
  const banner = CONCENTRATION_THRESHOLDS.status;

  /* (0) PORTFOLIO-ONLY GATE — N ≤ 1 is legitimately N/A, never a risk. */
  if (input.loanCount <= 1) {
    return {
      dimensionId: 'portfolio-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[N/A — single-property (loanCount=${input.loanCount})] Concentration is a ` +
        'PORTFOLIO-ONLY dimension. A single-property loan has trivial 100% ' +
        'concentration by construction — that is the definition of a single-asset ' +
        'credit, already scored by the single-property doctrine, NOT a risk to ' +
        're-flag. Dimension does not fire.',
      provenance: [
        'portfolio concentration is a roll-up-only (N>1) signal',
        'single-property (N=1) 100% concentration is definitional, not a risk — never flagged',
        'single-property scoring path is untouched (this dim is not on it)',
      ],
      applicability: 'not-applicable-by-asset-type',
      evaluated: false,
    };
  }

  const c = input.concentration;

  /* (1) Missing metrics → HITL (never a fabricated tier). */
  if (c.topPropertyValueShare === null || c.herfindahlIndex === null) {
    return {
      dimensionId: 'portfolio-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        '[HITL — concentration metrics not derivable] Σ component value is 0 or ' +
        'no per-property values present; top-property share / Herfindahl are null. ' +
        'Route to human review; NEVER bucket into a concentration tier without data.',
      provenance: [
        'concentration metrics absent (Σvalue == 0) — coverage gap, not a risk signal',
      ],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  const T = CONCENTRATION_THRESHOLDS;

  /* (2) Band each metric, take the worst (max) as the base tier. */
  const topTier = bandShare(c.topPropertyValueShare, T.topPropertyShare);
  const hhiTier = bandShare(c.herfindahlIndex, T.herfindahl);
  const baseTier = maxTier(topTier, hhiTier);
  let riskContribution: number = T.bandRiskContribution[baseTier];

  /* (3) Single-geography / single-asset-class ADD-ON flags. */
  const topStateShare = c.geographicMixByState[0]?.valueShare ?? 0;
  const topClassShare = c.assetClassMix[0]?.valueShare ?? 0;
  const singleGeography = topStateShare >= T.singleGeographyShareFlag.threshold;
  const singleAssetClass = topClassShare >= T.singleAssetClassShareFlag.threshold;
  const flagsFired = (singleGeography ? 1 : 0) + (singleAssetClass ? 1 : 0);
  if (flagsFired > 0) {
    riskContribution = Math.min(
      T.singleFlagRiskAddOn.cap,
      riskContribution + flagsFired * T.singleFlagRiskAddOn.perFlag,
    );
  }

  const level = levelForRisk(riskContribution);
  const eff = c.effectiveProperties;
  const flagsText =
    flagsFired === 0
      ? 'no single-geography / single-asset-class flag'
      : [
          singleGeography
            ? `single-geography (${(topStateShare * 100).toFixed(0)}% ${c.geographicMixByState[0]?.key})`
            : null,
          singleAssetClass
            ? `single-asset-class (${(topClassShare * 100).toFixed(0)}% ${c.assetClassMix[0]?.key})`
            : null,
        ]
          .filter(Boolean)
          .join(' + ') + ` → +${(flagsFired * T.singleFlagRiskAddOn.perFlag).toFixed(3)} add-on`;

  return {
    dimensionId: 'portfolio-concentration',
    riskContribution,
    tier: baseTier,
    rationale:
      `[${banner}] Top-property share ${(c.topPropertyValueShare * 100).toFixed(1)}% ` +
      `(band ${topTier}), Herfindahl ${c.herfindahlIndex.toFixed(4)} ` +
      `(${eff !== null ? eff.toFixed(2) + ' effective properties, ' : ''}band ${hhiTier}) ` +
      `→ base dispersion tier ${baseTier}. ${flagsText}. Effective concentration ` +
      `risk ${riskContribution.toFixed(3)} → level "${level}". Portfolio-only signal over ` +
      `${input.loanCount} properties.`,
    provenance: [
      `THRESHOLDS: ${banner}`,
      `top-property bands: ${T.topPropertyShare.source}`,
      `Herfindahl bands: ${T.herfindahl.source}`,
      `single-geography flag: ${T.singleGeographyShareFlag.source}`,
      `single-asset-class flag: ${T.singleAssetClassShareFlag.source}`,
      `band risk scale: ${T.bandRiskContribution.source}`,
      `flag add-on: ${T.singleFlagRiskAddOn.source}`,
      'portfolio-only (N>1) — never fires on a single-property loan',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      topPropertyValueShare: c.topPropertyValueShare,
      herfindahlIndex: c.herfindahlIndex,
      effectiveProperties: eff,
      singleGeographyFlag: singleGeography ? 1 : 0,
      singleAssetClassFlag: singleAssetClass ? 1 : 0,
      // String tag (derivedOutputs allows string for provenance/audit): the
      // effective concentration level (base dispersion + correlation add-ons).
      concentrationLevel: level,
    },
  };
}
