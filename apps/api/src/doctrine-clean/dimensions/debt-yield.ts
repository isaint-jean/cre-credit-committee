/**
 * doctrine-clean / dimensions / debt-yield.ts
 *
 * Dimension 3 — Debt yield (DY).
 *
 * SPEC v2 §3 (verbatim):
 *   Principle: NOI / loan balance — leverage independent of cap rate
 *   and coupon.
 *   Convergence: KBRA KDY; DBRS debt-yield levels; Moody's via NCF/
 *   value relationship. Post-GFC standard.
 *   Proposed treatment: debt-yield floor (~8-10% convention, property-
 *   type dependent).
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old DY thresholds. Floors derived from the convergence
 * above and KBRA property-type conventions, NOT fit to the corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   Debt yield is the post-GFC convention that severed leverage from
 *   the volatility of cap rates and coupons. NOI divided by loan
 *   balance gives a return-on-loan figure that does not move when cap
 *   rates compress or expand. KBRA's KDY, DBRS's published debt-yield
 *   levels, and Moody's NCF/value relationship all converge on
 *   property-type-dependent floors in the ~8-10% range; KBRA in
 *   particular publishes higher floors for hospitality / mall (higher
 *   cash-flow volatility) and lower floors for multifamily / industrial
 *   (more durable cash flow).
 *
 *   We use SUSTAINABLE NOI as the numerator (from the normalization
 *   layer), consistent with the spine convergence: "don't trust the
 *   issuer's underwritten number — re-derive sustainable cash flow."
 *
 *   Property-type-adjusted floors (KBRA-style, expressed as DY%):
 *     Multifamily, MHC:        7.5%   (durable resi cashflow)
 *     Industrial:              8.0%   (light recurring capital)
 *     AnchoredRetail:          8.0%
 *     SelfStorage:             8.5%
 *     MixedUse:                8.5%
 *     Office:                  9.0%   (TI/LC + rollover sensitivity)
 *     UnanchoredRetail:        9.0%
 *     Hotel:                  10.5%   (RevPAR volatility)
 *     Mall:                   10.0%   (secular pressure post-2020)
 *     Unknown:                 9.0%   (conservative central)
 *
 *   These floors define the lower edge of the "adequate" band per asset
 *   class — below them, the dimension elevates risk.
 *
 *   Generic bands (asset-floor-relative):
 *     strong    >= floor + 2.0pp     0.10
 *     adequate  [floor, floor + 2pp) 0.30
 *     thin      [floor - 1.5pp,floor) 0.55
 *     distressed < floor − 1.5pp     0.80
 *
 *   This anchors the bands TO the agency convention per asset class
 *   instead of using a single global cutoff that would mis-bucket
 *   multifamily (durable at 7.5%) vs hotel (thin at 7.5%).
 */
import type { DimensionContribution } from '../types.js';

export interface DebtYieldInput {
  /**
   * Sustainable NOI in dollars from the normalization layer. Numerator
   * of the debt yield. Null when normalization was HITL.
   */
  readonly sustainableNoi: number | null;
  /** Loan amount in dollars. Denominator. */
  readonly loanAmount: number | null;
  /** Asset class — drives the asset-floor. May be null → HITL. */
  readonly assetType: string | null;
  /** Sub-type — used for Retail → Mall disambiguation. */
  readonly subType: string | null;
}

interface AssetDyFloor {
  readonly assetClass: string;
  readonly floorDecimal: number;
  readonly source: string;
}

const ASSET_FLOORS: readonly AssetDyFloor[] = [
  { assetClass: 'Multifamily',      floorDecimal: 0.0750, source: 'KBRA multifamily KDY floor ~7.5% — durable residential cashflow' },
  { assetClass: 'MHC',              floorDecimal: 0.0750, source: 'KBRA MHC KDY floor ~7.5% — comparable to multifamily' },
  { assetClass: 'Industrial',       floorDecimal: 0.0800, source: 'KBRA industrial KDY floor ~8.0% — light recurring capital' },
  { assetClass: 'AnchoredRetail',   floorDecimal: 0.0800, source: 'KBRA anchored-retail KDY floor ~8.0%' },
  { assetClass: 'SelfStorage',      floorDecimal: 0.0850, source: 'KBRA self-storage KDY floor ~8.5%' },
  { assetClass: 'MixedUse',         floorDecimal: 0.0850, source: 'KBRA mixed-use KDY floor ~8.5% — blended conservative' },
  { assetClass: 'Office',           floorDecimal: 0.0900, source: 'KBRA office KDY floor ~9.0% — TI/LC + rollover sensitivity' },
  { assetClass: 'UnanchoredRetail', floorDecimal: 0.0900, source: 'KBRA unanchored-retail KDY floor ~9.0%' },
  { assetClass: 'Hotel',            floorDecimal: 0.1050, source: 'KBRA hotel KDY floor ~10.5% — RevPAR volatility' },
  { assetClass: 'Mall',             floorDecimal: 0.1000, source: 'KBRA / DBRS regional-mall KDY floor ~10.0% — secular pressure post-2020' },
  { assetClass: 'Unknown',          floorDecimal: 0.0900, source: 'Unknown fallback — conservative central convention' },
] as const;

const FLOOR_BY_ASSET: ReadonlyMap<string, AssetDyFloor> =
  new Map(ASSET_FLOORS.map(f => [f.assetClass, f]));

function resolveAssetFloor(
  assetType: string | null,
  subType: string | null,
): AssetDyFloor {
  if (assetType === null) return FLOOR_BY_ASSET.get('Unknown')!;
  if (assetType === 'Retail' || assetType === 'AnchoredRetail' || assetType === 'UnanchoredRetail') {
    const st = (subType ?? '').toLowerCase();
    if (st.includes('mall') || st.includes('mills') || st.includes('outlet')) {
      return FLOOR_BY_ASSET.get('Mall')!;
    }
    if (assetType === 'Retail') return FLOOR_BY_ASSET.get('UnanchoredRetail')!;
  }
  return FLOOR_BY_ASSET.get(assetType) ?? FLOOR_BY_ASSET.get('Unknown')!;
}

export function evaluateDebtYield(
  input: DebtYieldInput,
): DimensionContribution {
  if (input.sustainableNoi === null || input.loanAmount === null || input.assetType === null) {
    const missing: string[] = [];
    if (input.sustainableNoi === null) missing.push('sustainableNoi');
    if (input.loanAmount === null) missing.push('loanAmount');
    if (input.assetType === null) missing.push('assetType');
    return {
      dimensionId: 'debt-yield',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — missing input(s): ${missing.join(', ')}] Debt-yield dimension requires sustainable NOI + loan amount + asset class. Route to human review.`,
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  if (input.loanAmount <= 0) {
    return {
      dimensionId: 'debt-yield',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — non-positive loanAmount=${input.loanAmount}] Sanity gate failed upstream.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  const floor = resolveAssetFloor(input.assetType, input.subType);
  const dy = input.sustainableNoi / input.loanAmount;
  // Bands relative to the asset-specific floor.
  let tier: 'strong' | 'adequate' | 'thin' | 'distressed';
  let riskContribution: number;
  let bandRationale: string;
  if (dy >= floor.floorDecimal + 0.020) {
    tier = 'strong';      riskContribution = 0.10;
    bandRationale = `>= asset floor + 2.0pp (${((floor.floorDecimal + 0.020) * 100).toFixed(1)}%). Durable; comfortably above the agency-convention floor.`;
  } else if (dy >= floor.floorDecimal) {
    tier = 'adequate';    riskContribution = 0.30;
    bandRationale = `at/above asset floor ${(floor.floorDecimal * 100).toFixed(1)}%. Agency-typical.`;
  } else if (dy >= floor.floorDecimal - 0.015) {
    tier = 'thin';        riskContribution = 0.55;
    bandRationale = `within 1.5pp below asset floor ${(floor.floorDecimal * 100).toFixed(1)}%. Below the agency-convention floor for ${floor.assetClass}.`;
  } else {
    tier = 'distressed';  riskContribution = 0.80;
    bandRationale = `> 1.5pp below asset floor ${(floor.floorDecimal * 100).toFixed(1)}%. Materially below agency convention.`;
  }
  return {
    dimensionId: 'debt-yield',
    riskContribution,
    tier,
    rationale: `Sustainable NOI $${Math.round(input.sustainableNoi).toLocaleString()} / loan $${Math.round(input.loanAmount).toLocaleString()} = DY ${(dy * 100).toFixed(2)}%. Asset floor ${floor.assetClass} ${(floor.floorDecimal * 100).toFixed(1)}%. ${tier} — ${bandRationale}`,
    provenance: [
      'spec v2 §3 (Debt yield)',
      'KBRA KDY (post-GFC standard) — property-type dependent floors',
      'DBRS Morningstar published debt-yield levels',
      'Moody\'s NCF/value relationship — debt-yield equivalent',
      `Asset floor source: ${floor.source}`,
      'Numerator = sustainable NOI (from normalization layer)',
      'Bands relative to asset-specific KBRA floor (NOT a single global cutoff — that would mis-bucket residential vs hospitality)',
      'Floors convention-driven (agency convergence), NOT fit to clean corpus',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      debtYield: dy,
      assetFloorDecimal: floor.floorDecimal,
    },
  };
}

export const DEBT_YIELD_ASSET_FLOORS = ASSET_FLOORS;
