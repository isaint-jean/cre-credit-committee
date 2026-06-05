/**
 * applyCapRateStress — Stage 4 conclude-step for the cap-rate stress doctrine v1.
 *
 * Conservative directional stresser (office-only in v1). Takes the already-built
 * capRate AdjustedLineItem and applies, in order:
 *
 *   1. Tier correction (off a tier-blind base — library median or market benchmark).
 *      Bidirectional: gateway tightens, tertiary widens. Skipped on doc-supplied bases
 *      (appraisal/ASR) — those already encode the market; residual branch deferred.
 *   2. Business-plan risk widen (widen-only).
 *   3. Tenancy rollover risk widen (widen-only).
 *   4. Tenancy concentration risk widen (widen-only).
 *   5. Net-band flag (informational): |Σ stress deltas| > 150bps → JE_CAP_NET_ADJ_OUT_OF_BAND.
 *   6. Clamp (mutative): concluded cap pinned to [4.5%, 12.0%] band → JE_CAP_CLAMPED_TO_RANGE.
 *
 * All deltas are decimal fractions (+0.0035 == +35bps). Each nonzero rule emits an
 * AdjustmentEntry into the returned line item's adjustments[]. The function is pure
 * and immutable — it returns a NEW AdjustedLineItem; the orchestrator rebinds.
 *
 * v1 tier deltas are backtested off the n=44 clean office calibration cut
 * (R²=0.22 against the analyst answer key). Risk magnitudes are conservative
 * judgment placeholders pending desk recalibration. v1 reality: appraisal cap is
 * 0/55 populated and ASR rarely extracts, so the library-median + tier-correction
 * path is what fires today. See docs/architecture/cap-rate-stress-doctrine-v1.md
 * and JUDGMENT_ENGINE_MANIFEST['1.4'].
 *
 * Non-Office assetProfile.propertyType → no-op (input returned unchanged).
 */

import type {
  AdjustedLineItem,
  AdjustmentEntry,
  AssetProfile,
  MarketLiquidity,
} from '@cre/contracts';

/* ----- thresholds + magnitudes (locked v1; all are decimal fractions) ----- */

const CAP_RATE_FLOOR = 0.045 as const;
const CAP_RATE_CEILING = 0.120 as const;
const NET_ADJ_BAND_BPS = 0.0150 as const;

/** Tier corrections off a tier-blind base. Backtested. Unknown → 0 (no entry). */
const TIER_DELTA: Record<MarketLiquidity, number> = {
  Primary: -0.0075,
  Secondary: +0.0035,
  Tertiary: +0.0065,
  Unknown: 0,
};

const BP_LEASEUP_DELTA = +0.0025;

const ROLLOVER_HEAVY_THRESHOLD = 0.30;
const ROLLOVER_HEAVY_DELTA = +0.0040;
const ROLLOVER_MODERATE_THRESHOLD = 0.15;
const ROLLOVER_MODERATE_DELTA = +0.0015;

const CONCENTRATION_THRESHOLD = 0.35;
const CONCENTRATION_DELTA = +0.0040;

/* ----- base-source detection ----- */

type BaseSource = 'doc' | 'library' | 'benchmark';

/**
 * Read the capRate line item to detect which base the cascade landed on.
 * Tier correction applies only on tier-blind bases (library, benchmark) — both
 * are single-number-per-asset-class corpus medians. Doc bases (appraisal/ASR)
 * already encode the market and would double-count.
 */
function detectBaseSource(capRate: AdjustedLineItem): BaseSource {
  if (capRate.raw !== null) return 'doc';
  // raw === null → buildCapRate fired its substitution path.
  const first = capRate.adjustments[0];
  if (first?.ruleId === 'JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK') {
    return 'benchmark';
  }
  return 'library';
}

/* ------------------------------- main fn -------------------------------- */

export function applyCapRateStress(args: {
  readonly capRate: AdjustedLineItem;
  readonly assetProfile: AssetProfile;
  readonly top1IncomeShare: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
}): {
  readonly capRate: AdjustedLineItem;
  readonly netBandOutOfRange: boolean;
  readonly tierUnresolved: boolean;
} {
  const { capRate, assetProfile, top1IncomeShare, pctIncomeExpiringWithinTerm } = args;

  // v1 guard — office only. Other asset classes deferred.
  if (assetProfile.propertyType !== 'Office') {
    return { capRate, netBandOutOfRange: false, tierUnresolved: false };
  }

  // Tier-unresolved degraded-state flag (v1.5). Fires on Office when no tier
  // signal is available (neither explicit hint nor metro lookup resolved).
  // Independent of baseSource — the flag reports input absence, not whether
  // the doctrine would have applied a tier delta. Informational only;
  // delta=0; pushed to dataQualityFlags by the orchestrator.
  const tierUnresolved = assetProfile.marketLiquidity === 'Unknown';

  const baseSource = detectBaseSource(capRate);
  const newEntries: AdjustmentEntry[] = [];
  let adjusted = capRate.adjusted;
  let stressDeltaSum = 0;

  // 1. Tier correction — only on tier-blind base (library or benchmark).
  if (baseSource !== 'doc') {
    const tier = assetProfile.marketLiquidity;
    const tierDelta = TIER_DELTA[tier];
    if (tierDelta !== 0) {
      const ruleId =
        tier === 'Primary'   ? 'JE_CAP_TIER_GATEWAY'   :
        tier === 'Secondary' ? 'JE_CAP_TIER_SECONDARY' :
        /* Tertiary */         'JE_CAP_TIER_TERTIARY';
      const bps = Math.round(tierDelta * 10_000);
      const sign = bps >= 0 ? '+' : '−';
      newEntries.push({
        ruleId,
        delta: tierDelta,
        reason: `${tier.toLowerCase()} market (${sign}${Math.abs(bps)}bps off ${baseSource === 'library' ? 'library-median' : 'market-benchmark'} cap-rate base)`,
      });
      adjusted += tierDelta;
      stressDeltaSum += tierDelta;
    }
    // Unknown tier → no entry, no delta. Honest "no signal".
  }

  // 2. Business plan risk widen (widen-only).
  if (assetProfile.businessPlan === 'LeaseUp_or_Transitional') {
    newEntries.push({
      ruleId: 'JE_CAP_STRESS_BUSINESS_PLAN',
      delta: BP_LEASEUP_DELTA,
      reason: `lease-up / light transitional business plan (+25bps)`,
    });
    adjusted += BP_LEASEUP_DELTA;
    stressDeltaSum += BP_LEASEUP_DELTA;
  }

  // 3. Tenancy rollover risk widen (widen-only). Two-bucket threshold; the
  //    heavy bucket SUPERSEDES the moderate bucket (only one entry fires).
  //    Null pctIncomeExpiringWithinTerm → no entry (no signal, not a stress).
  if (pctIncomeExpiringWithinTerm !== null) {
    if (pctIncomeExpiringWithinTerm >= ROLLOVER_HEAVY_THRESHOLD) {
      newEntries.push({
        ruleId: 'JE_CAP_STRESS_TENANCY_ROLLOVER',
        delta: ROLLOVER_HEAVY_DELTA,
        reason: `near-term rollover ${(pctIncomeExpiringWithinTerm * 100).toFixed(1)}% of income (≥30% threshold; +40bps)`,
      });
      adjusted += ROLLOVER_HEAVY_DELTA;
      stressDeltaSum += ROLLOVER_HEAVY_DELTA;
    } else if (pctIncomeExpiringWithinTerm >= ROLLOVER_MODERATE_THRESHOLD) {
      newEntries.push({
        ruleId: 'JE_CAP_STRESS_TENANCY_ROLLOVER',
        delta: ROLLOVER_MODERATE_DELTA,
        reason: `near-term rollover ${(pctIncomeExpiringWithinTerm * 100).toFixed(1)}% of income (≥15% threshold; +15bps)`,
      });
      adjusted += ROLLOVER_MODERATE_DELTA;
      stressDeltaSum += ROLLOVER_MODERATE_DELTA;
    }
  }

  // 4. Tenancy concentration risk widen (widen-only). Null → no entry.
  if (top1IncomeShare !== null && top1IncomeShare >= CONCENTRATION_THRESHOLD) {
    newEntries.push({
      ruleId: 'JE_CAP_STRESS_TENANCY_CONCENTRATION',
      delta: CONCENTRATION_DELTA,
      reason: `top-1 tenant ${(top1IncomeShare * 100).toFixed(1)}% of income (≥35% threshold; +40bps)`,
    });
    adjusted += CONCENTRATION_DELTA;
    stressDeltaSum += CONCENTRATION_DELTA;
  }

  // 5. Net-band flag — informational, computed against the PRE-CLAMP sum so
  //    the flag reflects raw stress magnitude (clamp is mechanical, not a stress).
  const netBandOutOfRange = Math.abs(stressDeltaSum) > NET_ADJ_BAND_BPS;

  // 6. Clamp — mutative; only fires when the cap escapes the [4.5%, 12.0%] band.
  //    delta on the AdjustmentEntry is the clamp delta (signed); never aggregated
  //    into stressDeltaSum (clamp is mechanical, not a risk signal).
  if (adjusted < CAP_RATE_FLOOR) {
    const preClamp = adjusted;
    const clampDelta = CAP_RATE_FLOOR - preClamp;
    newEntries.push({
      ruleId: 'JE_CAP_CLAMPED_TO_RANGE',
      delta: clampDelta,
      reason: `concluded cap ${(preClamp * 100).toFixed(2)}% clamped up to floor ${(CAP_RATE_FLOOR * 100).toFixed(1)}%`,
    });
    adjusted = CAP_RATE_FLOOR;
  } else if (adjusted > CAP_RATE_CEILING) {
    const preClamp = adjusted;
    const clampDelta = CAP_RATE_CEILING - preClamp;
    newEntries.push({
      ruleId: 'JE_CAP_CLAMPED_TO_RANGE',
      delta: clampDelta,
      reason: `concluded cap ${(preClamp * 100).toFixed(2)}% clamped down to ceiling ${(CAP_RATE_CEILING * 100).toFixed(1)}%`,
    });
    adjusted = CAP_RATE_CEILING;
  }

  // Immutable rebuild.
  const stressedCapRate: AdjustedLineItem = {
    raw: capRate.raw,
    adjusted,
    source: capRate.source,
    adjustments: [...capRate.adjustments, ...newEntries],
  };
  return { capRate: stressedCapRate, netBandOutOfRange, tierUnresolved };
}
