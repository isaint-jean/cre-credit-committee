/**
 * doctrine-clean / dimensions / rollover.ts
 *
 * Dimension 6 — Lease rollover within loan term.
 *
 * PROVENANCE (rewrite-in-own-words per spec v2 method note):
 *
 *   PRIMARY: KBRA CMBS methodology — lease-turnover risk treatment.
 *   KBRA frames rollover as the share of in-place income (or, when
 *   income is not extracted, share of net rentable area) whose tenant
 *   leases expire before the loan's maturity date. The agency rationale:
 *   every expiring lease creates a re-leasing event during loan life,
 *   exposing cash flow to (a) downtime / vacancy between tenants,
 *   (b) tenant-improvement / leasing-commission capital spend, and
 *   (c) re-leasing rate risk (the new rent may be below the expiring
 *   tenant's contract rent). The more income / SF rolls within term,
 *   the more re-leasing events the loan must absorb to repay.
 *
 *   SECONDARY: DBRS Morningstar CMBS rating methodology — vacancy and
 *   leasing-cost haircuts. DBRS converts elevated rollover into explicit
 *   stressed NCF haircuts: a higher rolling-share property gets a larger
 *   vacancy assumption + larger TI/LC carve-out applied to underwritten
 *   cash flow. The two agencies converge on the same risk-direction
 *   reading (more rollover → more risk); their thresholds for "elevated"
 *   land in similar bands.
 *
 *   The treatment is ASSET-AGNOSTIC for asset classes that have tenant
 *   leases. Spec v2 § 6 makes a single-axis adjustment on rolling share;
 *   it does not stratify the threshold by asset class. (A more elaborate
 *   model COULD differentiate office-vs-retail re-leasing duration, but
 *   spec v2 deliberately keeps the rollover dimension orthogonal to
 *   asset-type to avoid double-counting with dim 8.)
 *
 *   APPLICABILITY (spec v2 dim 8 applicability note + dim 6 method):
 *   Rollover only applies to asset classes whose underwriting is
 *   driven by multi-year commercial leases (Office, Retail / Mall,
 *   Industrial, Mixed Use). Hotel cash flow is driven by daily-rate
 *   bookings (no tenant lease); Multifamily and MHC are tenant-by-month
 *   or annual residential renewals with implicit assumed turnover; Self
 *   Storage is month-to-month. For these asset classes the rollover
 *   dimension is NOT-APPLICABLE-BY-ASSET-TYPE — the scoring architecture
 *   reweights remaining dimensions; the rollover dimension stays silent.
 *
 *   CORPUS CONFIRMATION (directional only — NOT the primary fit):
 *   Clean backbone corpus structural test v3 — among 26 populated
 *   records: CLEAN mean rollover 46.4% vs LOSS mean 70.9% (3 LOSSes).
 *   Loss-rate by median split (47.6%): high-rollover bucket 23.1%
 *   (3/13) vs low-rollover bucket 0% (0/13). DIRECTION matches the
 *   agency framework; magnitude reads as a stronger signal than the
 *   ratios. CAVEAT: all 3 populated-LOSS records are Retail — the
 *   rollover-vs-asset-class confound cannot be disentangled at n=3.
 *
 * THRESHOLDS:
 *
 *   KBRA / DBRS do not publish a single shared cutoff; their published
 *   stress treatments cluster at "elevated when meaningful share rolls
 *   within term" (DBRS vacancy haircut bands; KBRA per-tier rollover
 *   loadings). Spec v2 § 6 method discretizes into four bands so the
 *   dimension's contribution is a calibrated weight, not a single
 *   threshold crossing. The four bands below are derived from KBRA's
 *   typical rollover-stress tier breaks (low / moderate / elevated /
 *   high) which align with DBRS's vacancy-haircut bands.
 *
 *   Band breaks at 25% / 50% / 75% are spec v2 § 6's discretization:
 *   below 25% the contract base is durable through term (most leases
 *   extend past maturity); 25-50% requires re-leasing a meaningful
 *   minority during term; 50-75% requires re-leasing the majority;
 *   above 75% nearly all income re-leases — the dimension is in the
 *   tail of the distribution.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

/**
 * Input shape for the rollover dimension. Pure function; no global state.
 */
export interface RolloverDimensionInput {
  /**
   * NRA-weighted share of tenants whose lease expiration date precedes
   * the loan's maturity date. In [0.0, 1.0]. Null when the body-page
   * extractor couldn't parse the tenant table or the maturity date.
   *
   * (The corpus exposes this as `pctIncomeExpiringWithinTerm` on each
   * AnswerKeyRecord; this dimension reads NRA-share as an income-share
   * proxy — KBRA prefers income-weighted when available, NRA-weighted
   * when not. Spec v2 § 6 explicitly accepts the NRA proxy.)
   */
  readonly pctIncomeExpiringWithinTerm: number | null;
  /**
   * Asset type as the extractor / Annex A walker emitted it. Used ONLY
   * for the applicability gate (which asset classes have tenant leases).
   * The rollover threshold is asset-agnostic.
   */
  readonly assetType: string | null;
  /**
   * Tenant-table status from the extractor. Distinguishes "tenant table
   * not applicable for this asset class" from "tenant table failed to
   * parse" — the two route differently:
   *   'multi-tenant-parsed' / 'single-tenant'  → POPULATED (use the value)
   *   'na-by-asset-type'                       → NOT-APPLICABLE-BY-ASSET-TYPE
   *   'parse-failed' / null                    → HITL-NEEDED
   */
  readonly tenantDataStatus:
    | 'multi-tenant-parsed'
    | 'single-tenant'
    | 'na-by-asset-type'
    | 'parse-failed'
    | null;
}

/**
 * Asset classes with NO multi-year commercial tenant leases. Spec v2
 * dim 8 applicability note + dim 6 method: rollover not applicable.
 *
 * The extractor's `normalizeAssetType` produces these strings.
 */
const NO_TENANT_LEASE_TYPES: ReadonlySet<string> = new Set([
  'Hotel',
  'Multifamily',
  'MHC',
  'SelfStorage',
]);

/**
 * Spec v2 § 6 band breaks. Band cutoffs are inclusive on the LOWER edge
 * (e.g., "moderate" includes 0.25; "elevated" includes 0.50).
 */
interface RolloverBand {
  readonly tier: 'low' | 'moderate' | 'elevated' | 'high';
  readonly riskContribution: number;
  readonly minShare: number;   // inclusive
  readonly maxShare: number;   // exclusive (1.01 for 'high' so 1.00 caps)
  readonly rationale: string;
}

const BANDS: readonly RolloverBand[] = [
  {
    tier: 'low',
    riskContribution: 0.10,
    minShare: 0.00,
    maxShare: 0.25,
    rationale:
      'Less than a quarter of income rolls within term. The contract base ' +
      'extends materially beyond loan maturity; re-leasing events during ' +
      'loan life are a minority of total income. KBRA / DBRS treat this ' +
      'as the durable-contract baseline.',
  },
  {
    tier: 'moderate',
    riskContribution: 0.30,
    minShare: 0.25,
    maxShare: 0.50,
    rationale:
      'A meaningful minority of income (25-50%) re-leases within term. ' +
      'Each rollover event carries downtime + TI/LC + re-rate risk; in ' +
      'aggregate the loan must absorb several such events. Above the ' +
      'durable baseline but below the agency-flagged elevated band.',
  },
  {
    tier: 'elevated',
    riskContribution: 0.60,
    minShare: 0.50,
    maxShare: 0.75,
    rationale:
      'Majority of income (50-75%) re-leases within term. KBRA flags ' +
      'this band as elevated rollover; DBRS applies a stress vacancy + ' +
      'TI/LC haircut to underwritten cash flow. The loan\'s repayment ' +
      'capacity depends materially on re-leasing success during loan life.',
  },
  {
    tier: 'high',
    riskContribution: 0.85,
    minShare: 0.75,
    maxShare: 1.01,                       // 1.00 inclusive
    rationale:
      'Vast majority of income (>= 75%) re-leases within term. The loan ' +
      'is effectively underwriting a full re-leasing cycle during its ' +
      'life. KBRA / DBRS tail of rollover-risk distribution.',
  },
] as const;

/**
 * Evaluate the rollover dimension on one input. Pure; no I/O.
 */
export function evaluateRollover(
  input: RolloverDimensionInput,
): DimensionContribution {
  // (1) APPLICABILITY GATE — asset class has no tenant leases.
  if (input.assetType !== null && NO_TENANT_LEASE_TYPES.has(input.assetType)) {
    return {
      dimensionId: 'rollover',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[N/A by asset type: ${input.assetType}] ` +
        'Rollover dimension does not apply — this asset class has no ' +
        'multi-year commercial tenant leases. (Hotel = daily-rate bookings; ' +
        'Multifamily / MHC = monthly residential; SelfStorage = ' +
        'month-to-month.) Spec v2 dim 6 method note: NOT-APPLICABLE; ' +
        'scoring architecture reweights remaining dimensions.',
      provenance: [
        'spec v2 § 6 method note — applicability gate by asset class',
        'KBRA CMBS methodology — rollover treatment applies to multi-year commercial leases',
        'DBRS Morningstar CMBS methodology — same applicability scope',
      ],
      applicability: 'not-applicable-by-asset-type',
      evaluated: false,
    };
  }

  // (2) HITL — tenant data is parse-failed or status is null. NEVER
  //     route a null share to a risk tier.
  if (input.pctIncomeExpiringWithinTerm === null
      || input.tenantDataStatus === null
      || input.tenantDataStatus === 'parse-failed') {
    const reason = input.pctIncomeExpiringWithinTerm === null
      ? 'pctIncomeExpiringWithinTerm absent'
      : `tenantDataStatus='${input.tenantDataStatus}'`;
    return {
      dimensionId: 'rollover',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[HITL — ${reason}] Tenant table or maturity-date input not ` +
        'available; dimension cannot evaluate. Route to human review. ' +
        'NEVER substitute a conservative default at the contribution ' +
        'layer (provenance must stay honest).',
      provenance: ['input absent / parse-failed — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (3) POPULATED — map share to band.
  const share = input.pctIncomeExpiringWithinTerm;
  if (share < 0 || share > 1.0001) {
    // Defensive: extractor sanity gates should prevent this. If a value
    // outside [0, 1] reaches the dimension, refuse to score.
    return {
      dimensionId: 'rollover',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[HITL — out-of-range value ${share}] pctIncomeExpiringWithinTerm ` +
        'must be a share in [0, 1]. Sanity gate failed upstream; route to ' +
        'human review.',
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  const band = BANDS.find(b => share >= b.minShare && share < b.maxShare)!;
  return {
    dimensionId: 'rollover',
    riskContribution: band.riskContribution,
    tier: band.tier,
    rationale: `Share ${(share * 100).toFixed(1)}% → ${band.tier}. ${band.rationale}`,
    provenance: [
      'spec v2 § 6 (Lease rollover within loan term)',
      'KBRA CMBS methodology — lease-turnover risk treatment + per-tier rollover loadings',
      'DBRS Morningstar CMBS methodology — vacancy + leasing-cost haircuts on elevated rollover',
      `corpus direction (n=3 LOSS populated, all Retail — caveat documented in validation): ` +
        `CLEAN mean 46.4%, LOSS mean 70.9%; high-rollover bucket loss-rate 23.1% vs ` +
        `low-rollover 0.0% (median split at 47.6%)`,
    ],
    applicability: 'applicable',
    evaluated: true,
  };
}

/** Export band table for the validation harness to introspect. */
export const ROLLOVER_BANDS = BANDS;
