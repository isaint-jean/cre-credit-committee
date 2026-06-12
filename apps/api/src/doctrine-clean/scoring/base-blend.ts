/**
 * doctrine-clean / scoring / base-blend.ts
 *
 * SCORING ARCHITECTURE — STAGE 1 of 3 (base-blend).
 *
 * Aggregates the 8 PEER DimensionContributions (LTV, DSCR, DY, refi,
 * concentration, rollover, cap-rate, asset-class) into a single base
 * risk + a coverage record. This is committee logic, NOT averaging —
 * weights reflect each dimension's structural importance in the
 * cross-agency convergence.
 *
 * SCOPE OF THIS STAGE:
 *   - Partition contributions by applicability state
 *   - Ratio collapse (LTV/DSCR/DY → one family signal) to prevent the
 *     leverage triple-count that contaminated the old baseline
 *   - Weighted base blend with renormalization over resolved signals
 *   - Coverage record (dim identity + state + confidence)
 *
 * EXPLICITLY OUT OF SCOPE (later stages):
 *   - Stage 2: overrides (forced overrides / cliff conditions)
 *   - Stage 3: bands + sponsor (dim 9) modifier + coverage gating +
 *              final recommendation
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * scorer / old doctrine. Weights derived from cross-agency convergence
 * + the sharpened-read structural-feature test (which proved ratios
 * don't separate and structural dims do), NOT fit to the corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   The eight peer dimensions present different views of credit risk
 *   on a property. Three of them — LTV, DSCR, and debt yield — are
 *   different formulations of the same underlying signal: how much
 *   loan the property is carrying against its cash flow and value.
 *   Treating them as three independent dimensions would TRIPLE-COUNT
 *   that signal in a weighted average. The base-blend collapses them
 *   into ONE ratio-family contribution before the main blend,
 *   following Moody's framing: LTV is the primary severity driver,
 *   DSCR is the primary probability-of-default driver, and DY is a
 *   cross-check / confirmation. The other five dimensions present
 *   independent signals — value realness (cap-rate), maturity exit
 *   (refinance), structural pressure (asset-class), tenant rollover,
 *   tenant concentration.
 *
 *   The weighting hierarchy reflects what the cross-agency convergence
 *   + the sharpened-read structural-feature test demonstrated:
 *
 *   - ANCHOR (weight 0.30) — Cap-rate / valuation (dim 7).
 *     Every other risk metric sizes off the stressed value the
 *     cap-rate dim produces. If the stressed value is wrong, every
 *     downstream ratio is wrong. The dim is the spine; weight reflects it.
 *
 *   - HIGH (weight 0.18 each) — Refinance (dim 4) + Asset-class (dim 8).
 *     Maturity default is the dominant CMBS loss path; refi-feasibility
 *     measures it directly. Asset-class carried the separating signal
 *     in the sharpened-read structural test (the conduit-homogeneous
 *     ratios did not). Together they account for the structural credit
 *     story.
 *
 *   - MEANINGFUL (weight 0.12 each) — Rollover (dim 6) + Concentration (dim 5).
 *     Real signals, narrower scope. Rollover is asset-agnostic and tied
 *     to lease-turnover risk. Concentration is the tenant-dependency
 *     overlay. Both contribute when applicable.
 *
 *   - MODERATE (weight 0.10 total) — Collapsed ratio-family (dims 1+2+3).
 *     Real but conduit-homogeneous; the sharpened-read showed they
 *     don't separate on conduit data. The dim is included for valid
 *     cases (severely-leveraged loans surface here) but its weight is
 *     capped so it cannot dominate the structural read.
 *
 *   The weights sum to 1.00. When any dimension is N/A or HITL, its
 *   weight is REDISTRIBUTED PROPORTIONALLY across the resolved
 *   signals — so a multifamily property (concentration N/A) is not
 *   penalized for the dim's absence, and a record missing rollover
 *   data is not penalized for missing data. Redistribution preserves
 *   the relative emphasis among resolved signals.
 *
 *   The coverage record alongside the base risk tracks which
 *   dimensions resolved, which were N/A by asset type, and which were
 *   HITL. Stage 3 will use this for confidence gating; this stage
 *   just records it.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

/**
 * Canonical signal IDs in the base-blend. Note that the three ratio
 * dims (leverage-ltv, coverage-dscr, debt-yield) collapse into the
 * 'ratio-family' signal before the main blend.
 */
export type BaseBlendSignalId =
  | 'cap-rate-valuation-stress'
  | 'refinance-feasibility'
  | 'asset-class'
  | 'rollover'
  | 'income-concentration'
  | 'ratio-family';

/** Main blend weights (after ratio collapse). Sum to 1.00. */
const SIGNAL_WEIGHTS: Readonly<Record<BaseBlendSignalId, number>> = {
  'cap-rate-valuation-stress': 0.30,   // ANCHOR — value realness
  'refinance-feasibility':     0.18,   // HIGH   — maturity default path
  'asset-class':               0.18,   // HIGH   — structural separator
  'rollover':                  0.12,   // MEANINGFUL — lease-turnover risk
  'income-concentration':      0.12,   // MEANINGFUL — tenant-dependency
  'ratio-family':              0.10,   // MODERATE — collapsed LTV/DSCR/DY
};

/**
 * Inner blend within the ratio family. LTV + DSCR are the primary
 * drivers (severity + PoD respectively per Moody's framing); DY is
 * the confirming cross-check. Sum to 1.00; when a sub-component is
 * unavailable, its weight redistributes within the family.
 */
const RATIO_FAMILY_INNER_WEIGHTS: Readonly<Record<string, number>> = {
  'leverage-ltv':   0.40,
  'coverage-dscr':  0.40,
  'debt-yield':     0.20,
};

const PEER_DIMENSION_IDS = [
  'cap-rate-valuation-stress',
  'refinance-feasibility',
  'asset-class',
  'rollover',
  'income-concentration',
  'leverage-ltv',
  'coverage-dscr',
  'debt-yield',
] as const;

export interface CoverageRecord {
  /** Dimensions that contributed risk (applicability === 'applicable'). */
  readonly applicable: readonly string[];
  /** Dimensions legitimately absent for the asset class. */
  readonly naByAssetType: readonly string[];
  /** Dimensions that need human review (input missing / parse failed). */
  readonly hitlNeeded: readonly string[];
  /** Dimensions absent from the input array entirely (caller bug guard). */
  readonly notProvided: readonly string[];
  /**
   * Confidence proxy: count of applicable peer dims (1-8) divided by 8.
   * Stage 3 will gate on this; this stage just records it.
   */
  readonly confidence: number;
}

export interface RatioFamilyCollapse {
  /** Collapsed family contribution in [0, 1]; null when no ratio dim applicable. */
  readonly contribution: number | null;
  /** Inner weights actually used (after renormalization within the family). */
  readonly innerWeights: Readonly<Record<string, number>>;
  /** Ratio dims that contributed. */
  readonly applicable: readonly string[];
  /** Ratio dims that were N/A by asset type (none today — ratios have no N/A). */
  readonly naByAssetType: readonly string[];
  /** Ratio dims routed to HITL. */
  readonly hitlNeeded: readonly string[];
}

export interface WeightedContribution {
  readonly signalId: BaseBlendSignalId;
  readonly riskContribution: number;
  readonly weightInitial: number;
  readonly weightRenormalized: number;
  readonly weightedRisk: number;
}

export interface BaseBlendResult {
  /** Aggregated base risk in [0, 1], or null when no signal resolved. */
  readonly baseRisk: number | null;
  /** Per-signal weighted breakdown after renormalization. */
  readonly weightedContributions: readonly WeightedContribution[];
  /** Ratio-family collapse intermediate. */
  readonly ratioFamily: RatioFamilyCollapse;
  /** Coverage record (dim identity + state + confidence). */
  readonly coverage: CoverageRecord;
  /** Sum of initial weights for resolved signals (pre-renormalization). */
  readonly resolvedInitialWeightSum: number;
  /** Renormalization factor applied (1 / resolvedInitialWeightSum). */
  readonly renormalizationFactor: number | null;
  readonly rationale: string;
  readonly provenance: readonly string[];
}

function isApplicable(c: DimensionContribution): boolean {
  return c.applicability === 'applicable' && typeof c.riskContribution === 'number';
}

function collapseRatioFamily(
  contributions: readonly DimensionContribution[],
): RatioFamilyCollapse {
  const byId = new Map(contributions.map(c => [c.dimensionId, c]));
  const ratioIds = Object.keys(RATIO_FAMILY_INNER_WEIGHTS);
  const applicable: string[] = [];
  const hitl: string[] = [];
  const naByAssetType: string[] = [];
  let weightedRisk = 0;
  let resolvedWeight = 0;
  for (const id of ratioIds) {
    const c = byId.get(id);
    if (!c) { hitl.push(id + ' (not provided)'); continue; }
    if (c.applicability === 'not-applicable-by-asset-type') { naByAssetType.push(id); continue; }
    if (isApplicable(c)) {
      const w = RATIO_FAMILY_INNER_WEIGHTS[id]!;
      weightedRisk += w * c.riskContribution!;
      resolvedWeight += w;
      applicable.push(id);
    } else {
      hitl.push(id);
    }
  }
  if (resolvedWeight === 0) {
    return {
      contribution: null,
      innerWeights: {},
      applicable,
      naByAssetType,
      hitlNeeded: hitl,
    };
  }
  // Renormalize within the family.
  const innerWeights: Record<string, number> = {};
  for (const id of applicable) innerWeights[id] = RATIO_FAMILY_INNER_WEIGHTS[id]! / resolvedWeight;
  return {
    contribution: weightedRisk / resolvedWeight,
    innerWeights,
    applicable,
    naByAssetType,
    hitlNeeded: hitl,
  };
}

export function computeBaseBlend(
  contributions: readonly DimensionContribution[],
): BaseBlendResult {
  const byId = new Map(contributions.map(c => [c.dimensionId, c]));
  // Coverage tracking across ALL 8 peer dims.
  const applicableSet: string[] = [];
  const naSet: string[] = [];
  const hitlSet: string[] = [];
  const notProvided: string[] = [];
  for (const id of PEER_DIMENSION_IDS) {
    const c = byId.get(id);
    if (!c) { notProvided.push(id); continue; }
    if (isApplicable(c)) applicableSet.push(id);
    else if (c.applicability === 'not-applicable-by-asset-type') naSet.push(id);
    else if (c.applicability === 'hitl-needed') hitlSet.push(id);
  }

  // Ratio collapse.
  const ratioFamily = collapseRatioFamily(contributions);

  // Build the 6-signal table.
  const signals: { id: BaseBlendSignalId; risk: number | null }[] = [
    { id: 'cap-rate-valuation-stress', risk: pickRisk(byId.get('cap-rate-valuation-stress')) },
    { id: 'refinance-feasibility',     risk: pickRisk(byId.get('refinance-feasibility')) },
    { id: 'asset-class',               risk: pickRisk(byId.get('asset-class')) },
    { id: 'rollover',                  risk: pickRisk(byId.get('rollover')) },
    { id: 'income-concentration',      risk: pickRisk(byId.get('income-concentration')) },
    { id: 'ratio-family',              risk: ratioFamily.contribution },
  ];

  // Partition + renormalize.
  let resolvedInitialWeight = 0;
  for (const s of signals) {
    if (s.risk !== null) resolvedInitialWeight += SIGNAL_WEIGHTS[s.id];
  }
  const weightedContributions: WeightedContribution[] = [];
  let baseRisk: number | null = null;
  if (resolvedInitialWeight === 0) {
    baseRisk = null;
  } else {
    const renormFactor = 1 / resolvedInitialWeight;
    let acc = 0;
    for (const s of signals) {
      if (s.risk === null) continue;
      const wInit = SIGNAL_WEIGHTS[s.id];
      const wRenorm = wInit * renormFactor;
      const weightedRisk = wRenorm * s.risk;
      weightedContributions.push({
        signalId: s.id,
        riskContribution: s.risk,
        weightInitial: wInit,
        weightRenormalized: wRenorm,
        weightedRisk,
      });
      acc += weightedRisk;
    }
    baseRisk = acc;
  }

  const confidence = applicableSet.length / PEER_DIMENSION_IDS.length;
  const coverage: CoverageRecord = {
    applicable: applicableSet, naByAssetType: naSet, hitlNeeded: hitlSet, notProvided, confidence,
  };

  const rationale = baseRisk === null
    ? 'No peer dimension resolved; base risk cannot be computed. Stage 3 will gate on this.'
    : `Resolved ${weightedContributions.length}/6 signals (${applicableSet.length}/8 peer dims applicable). ` +
      `Ratio family ${ratioFamily.contribution === null ? 'unresolved' : 'collapsed to ' + ratioFamily.contribution.toFixed(3)} ` +
      `from ${ratioFamily.applicable.length}/3 sub-components. ` +
      `Initial-weight sum for resolved signals = ${resolvedInitialWeight.toFixed(3)} → renormalization factor ${(1 / resolvedInitialWeight).toFixed(3)}. ` +
      `Base risk = ${baseRisk.toFixed(3)}.`;

  return {
    baseRisk,
    weightedContributions,
    ratioFamily,
    coverage,
    resolvedInitialWeightSum: resolvedInitialWeight,
    renormalizationFactor: resolvedInitialWeight === 0 ? null : 1 / resolvedInitialWeight,
    rationale,
    provenance: [
      'doctrine-clean scoring stage 1 — base-blend (committee-weighted aggregation)',
      'Ratio collapse — Moody\'s framing: LTV severity + DSCR PoD primary, DY confirming. Prevents leverage triple-count.',
      'Signal weights — convention-driven hierarchy (anchor / high / meaningful / moderate), NOT fit to corpus',
      'Cap-rate (7) anchored at 0.30 — produces the stressed value other dims size against',
      'Refi (4) + Asset-class (8) at 0.18 each — maturity-default path + sharpened-read structural separator',
      'Rollover (6) + Concentration (5) at 0.12 each — meaningful, narrower-scope structural overlays',
      'Ratio family (1+2+3 collapsed) at 0.10 — real but conduit-homogeneous; capped so cannot dominate',
      'N/A and HITL signals EXCLUDED from risk math; weights redistribute proportionally over resolved signals',
      'Coverage record alongside base risk — stage 3 gating, not this stage',
    ],
  };
}

function pickRisk(c: DimensionContribution | undefined): number | null {
  if (!c) return null;
  if (c.applicability !== 'applicable') return null;
  return typeof c.riskContribution === 'number' ? c.riskContribution : null;
}

export const BASE_BLEND_SIGNAL_WEIGHTS = SIGNAL_WEIGHTS;
export const BASE_BLEND_RATIO_FAMILY_INNER_WEIGHTS = RATIO_FAMILY_INNER_WEIGHTS;
export const BASE_BLEND_PEER_DIMENSION_IDS = PEER_DIMENSION_IDS;
