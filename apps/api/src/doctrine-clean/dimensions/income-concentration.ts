/**
 * doctrine-clean / dimensions / income-concentration.ts
 *
 * Dimension 5 — Income concentration (tenant concentration).
 *
 * SPEC v2 §5 (verbatim):
 *   Principle: concentration of income in a single or few tenants
 *   (by base rent, not just SF).
 *   Convergence: Moody's Herfindahl loan- and property-level diversity
 *   (a named public method); KBRA loss-anatomy research (tenant
 *   concentration among loss drivers); pre-sales report top tenants by
 *   base rent.
 *   Proposed treatment: concentration flag on top-tenant base-rent
 *   share; measure by income, not SF where data allows; consider a
 *   Herfindahl-style index.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old concentration logic. Thresholds derived from agency
 * conventions (Moody's diversity / KBRA loss-anatomy / single-tenant
 * CTL treatment), NOT fit to the 12-loss corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   A property whose income depends on one or two tenants behaves
 *   structurally differently from a property whose income spreads
 *   across many. The three NRSROs converge on the same view of why:
 *   - Moody's makes the diversity treatment explicit through a
 *     loan-level Herfindahl index (the index is published in their
 *     conduit/fusion methodology; the lower the diversity score, the
 *     higher the loan's PoD/severity adjustment).
 *   - KBRA's published CMBS Loss Study series consistently identifies
 *     single-tenant and tenant-concentrated loans as overrepresented
 *     in the loss tail: when the dominant tenant exits or downsizes,
 *     the property's cash flow gaps and the loan's coverage gaps;
 *     replacement leasing takes longer + costs more per square foot
 *     than at a diversified property.
 *   - The pre-sale reports across all three agencies list top tenants
 *     by base rent (not by SF) precisely because base rent is the
 *     income-truth — a single big-box tenant may occupy 60% of SF but
 *     pay only 25% of base rent (large anchored centers often have
 *     credit-tenant anchors at very low PSF rent vs. higher-paying
 *     in-line shop tenants).
 *
 *   Top-tenant-share bands (single-tenant-dependency convention):
 *     low     < 25%  → diversified; agency-baseline
 *     moderate 25-50% → concentrated minority; Moody's diversity
 *                       starts to ding here
 *     elevated 50-75% → single-tenant-dominant; KBRA loss-anatomy
 *                       overrepresentation begins
 *     high    ≥ 75%  → CTL territory (credit-tenant-lease single-
 *                       tenant property); separate agency treatment
 *                       hinged on the tenant's credit rating
 *
 *   APPLICABILITY (the dimension that PROPERLY uses N/A-by-asset-type):
 *     - applicable: tenant-based asset classes (Office, Retail,
 *       Anchored/Unanchored Retail, Mall, Industrial, MixedUse) WITH
 *       largestTenantPct populated.
 *     - not-applicable-by-asset-type: unit/room-based classes
 *       (Multifamily, MHC, Hotel, SelfStorage). No single-tenant
 *       concentration concept — a multifamily property has hundreds of
 *       monthly residential leases; a hotel has nightly bookings; MHC
 *       and self-storage are month-to-month. The dimension is silent
 *       and the scoring architecture reweights remaining dimensions.
 *     - hitl-needed: tenant-based class but largestTenantPct missing
 *       (extractor parse-failed or field absent). NEVER substitute a
 *       conservative default at the contribution layer.
 *
 *   CORPUS BASIS DEVIATION (FLAGGED):
 *     §5 prescribes base-rent share. The clean backbone extractor
 *     parses tenant tables by NRA (square-footage share), not by base
 *     rent — the body-page "Major Tenants" / "Largest Owned Tenants"
 *     tables present % of NRA per tenant. We use the SF basis as a
 *     PROXY and flag this in the rationale + provenance. The bias is
 *     directional and asset-class-dependent:
 *       - Office: SF-share tracks base-rent-share fairly closely (TI/LC
 *         differences but rents per PSF roughly comparable across
 *         in-place tenants).
 *       - Anchored retail: SF-share OVERSTATES the anchor's income
 *         share — anchors typically pay low PSF rent vs in-line. We
 *         note this caveat in the rationale.
 *       - Industrial / single-tenant: SF and base-rent shares are
 *         often identical (single-tenant property).
 *     Future enhancement: extract per-tenant base-rent column from the
 *     body-page tables (Annex A schedule formats vary by shelf).
 *
 *   HERFINDAHL HOOK (future):
 *     A true Herfindahl index requires the full distribution of
 *     tenant shares (sum of squares). The corpus stores only the #1
 *     top-tenant share today. We expose `topNTenantShares` as an
 *     optional input slot so the dimension can switch to a proper
 *     index when the extractor surfaces top-5 / top-10 tenant lists.
 *     We do NOT fake a Herfindahl from a single data point — the
 *     current dimension is explicitly a single-tenant-share flag.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

export interface IncomeConcentrationInput {
  /**
   * Normalized asset class — drives applicability. May be null → HITL.
   */
  readonly assetType: string | null;
  /**
   * Top-tenant share. Currently NRA-based on the clean corpus (SF
   * proxy for income). Decimal in [0, 1] — 1.0 = single-tenant.
   * Null when extractor could not parse the tenant table for a tenant-
   * based asset class.
   */
  readonly largestTenantPct: number | null;
  /**
   * Basis of `largestTenantPct`. The extractor currently emits NRA-
   * based shares; future tenant-table parsing may surface base-rent
   * shares directly. The dimension records the basis in its rationale.
   */
  readonly largestTenantBasis: 'NRA' | 'base-rent' | 'unknown';
  /**
   * OPTIONAL — full top-N tenant share distribution, for the future
   * Herfindahl index. When present and length >= 2, the dimension may
   * also publish a Herfindahl-style derived output. Today, the
   * extractor does not surface this; dimension reads it as undefined.
   */
  readonly topNTenantShares?: readonly number[];
}

/**
 * Tenant-based asset classes — dimension is applicable. (Spec v2 §5
 * "tenant concentration" framing; KBRA + Moody's treat these classes as
 * income-by-tenant.)
 */
const TENANT_BASED_TYPES: ReadonlySet<string> = new Set([
  'Office',
  'AnchoredRetail',
  'UnanchoredRetail',
  'Mall',
  'Retail',
  'Industrial',
  'MixedUse',
]);

/**
 * Unit/room-based asset classes — no single-tenant concentration
 * concept. Dimension legitimately N/A-by-asset-type.
 */
const UNIT_OR_ROOM_BASED_TYPES: ReadonlySet<string> = new Set([
  'Multifamily',
  'MHC',
  'Hotel',
  'SelfStorage',
]);

interface ConcentrationBand {
  readonly tier: 'low' | 'moderate' | 'elevated' | 'high';
  readonly riskContribution: number;
  readonly minShare: number;
  readonly maxShare: number;
  readonly rationale: string;
}

const BANDS: readonly ConcentrationBand[] = [
  {
    tier: 'low',
    riskContribution: 0.10,
    minShare: 0.00,
    maxShare: 0.25,
    rationale:
      'Top tenant < 25% of income. Diversified — agency baseline. ' +
      'Cash flow does not depend materially on any single tenant; ' +
      're-leasing one tenant\'s exit does not gap the loan.',
  },
  {
    tier: 'moderate',
    riskContribution: 0.30,
    minShare: 0.25,
    maxShare: 0.50,
    rationale:
      'Top tenant 25-50%. Concentrated minority. Moody\'s diversity ' +
      'index starts to ding here; a single tenant exit re-leases a ' +
      'meaningful share of income.',
  },
  {
    tier: 'elevated',
    riskContribution: 0.55,
    minShare: 0.50,
    maxShare: 0.75,
    rationale:
      'Top tenant 50-75%. Single-tenant-dominant. KBRA loss-anatomy ' +
      'identifies this band as overrepresented in CMBS losses; the ' +
      'loan\'s cash flow effectively underwrites the dominant tenant\'s ' +
      'lease covenant.',
  },
  {
    tier: 'high',
    riskContribution: 0.80,
    minShare: 0.75,
    maxShare: 1.01,
    rationale:
      'Top tenant >= 75%. Credit-tenant-lease territory. The loan\'s ' +
      'credit is the dominant tenant\'s credit; agencies treat these ' +
      'as effectively CTL deals with separate sizing methodology.',
  },
] as const;

export function evaluateIncomeConcentration(
  input: IncomeConcentrationInput,
): DimensionContribution {
  // (1) APPLICABILITY GATE — assetType is the gating axis.
  if (input.assetType === null) {
    return {
      dimensionId: 'income-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale: '[HITL — assetType absent] Income-concentration dimension requires assetType to gate applicability. Route to human review.',
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  if (UNIT_OR_ROOM_BASED_TYPES.has(input.assetType)) {
    return {
      dimensionId: 'income-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[N/A by asset type: ${input.assetType}] ` +
        'Income concentration does not apply — unit/room-based asset ' +
        'class has no single-tenant concentration concept. ' +
        '(Multifamily/MHC = monthly residential leases; Hotel = daily ' +
        'bookings; SelfStorage = month-to-month.) Scoring architecture ' +
        'reweights remaining dimensions.',
      provenance: [
        'spec v2 §5 — applicability gate by asset class (tenant-concentration framing)',
        'Moody\'s + KBRA + DBRS — tenant concentration applies to multi-year commercial-lease asset classes',
      ],
      applicability: 'not-applicable-by-asset-type',
      evaluated: false,
    };
  }
  if (!TENANT_BASED_TYPES.has(input.assetType)) {
    // Asset class outside the canonical set — conservative: route to HITL.
    return {
      dimensionId: 'income-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — unrecognized assetType='${input.assetType}'] Cannot determine applicability gate. Route to human review.`,
      provenance: ['input outside canonical asset-class set — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (2) HITL — tenant-based but share absent.
  if (input.largestTenantPct === null) {
    return {
      dimensionId: 'income-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[HITL — largestTenantPct absent on tenant-based asset (${input.assetType})] ` +
        'Tenant table did not parse or top-tenant share not extracted. ' +
        'Route to human review. NEVER substitute a conservative default ' +
        'at the contribution layer.',
      provenance: ['input absent — tenant-table parse failure or field not extracted'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (3) Defensive sanity gate.
  if (input.largestTenantPct < 0 || input.largestTenantPct > 1.0001) {
    return {
      dimensionId: 'income-concentration',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — out-of-range largestTenantPct=${input.largestTenantPct}] Sanity gate failed upstream.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (4) POPULATED — map share to band, flag basis deviation if SF/NRA.
  const share = input.largestTenantPct;
  const band = BANDS.find(b => share >= b.minShare && share < b.maxShare)!;
  const basisCaveat =
    input.largestTenantBasis === 'NRA'
      ? ' BASIS CAVEAT: corpus extractor surfaces NRA-share (SF), not base-rent — spec v2 §5 prefers base-rent. NRA is used as a directional proxy; for anchored retail in particular NRA OVERSTATES the anchor\'s base-rent share. Future enhancement: extract per-tenant base-rent column.'
      : input.largestTenantBasis === 'unknown'
        ? ' BASIS CAVEAT: top-tenant-share basis unspecified; treated directionally.'
        : '';

  // Future Herfindahl hook — present optionally.
  let herfindahl: number | null = null;
  if (input.topNTenantShares && input.topNTenantShares.length >= 2) {
    herfindahl = input.topNTenantShares.reduce((s, x) => s + x * x, 0);
  }

  return {
    dimensionId: 'income-concentration',
    riskContribution: band.riskContribution,
    tier: band.tier,
    rationale:
      `Top tenant ${(share * 100).toFixed(1)}% (basis=${input.largestTenantBasis}) on ${input.assetType} → ${band.tier}. ${band.rationale}${basisCaveat}`,
    provenance: [
      'spec v2 §5 (Income concentration)',
      'Moody\'s loan- and property-level Herfindahl diversity index (US Conduit/Fusion CMBS methodology)',
      'KBRA CMBS Loss Study series — tenant concentration among loss drivers',
      'DBRS Morningstar pre-sale tenant rosters — top tenants reported by base rent',
      'Single-tenant CTL treatment (separate agency sizing methodology) — top-tenant share >= 75% boundary',
      input.largestTenantBasis === 'NRA'
        ? 'BASIS DEVIATION: NRA (SF) share used as proxy for base-rent share — spec v2 §5 prefers base-rent (deepening = full per-tenant base-rent extraction)'
        : input.largestTenantBasis === 'base-rent'
          ? 'Basis: base-rent share (spec v2 §5 preferred)'
          : 'Basis: unknown — treated directionally',
      'Bands convention-driven (Moody\'s diversity + KBRA loss-anatomy + single-tenant CTL convention), NOT fit to clean corpus',
      'Herfindahl index: hook left for top-N tenant distribution; NOT computed from a single data point today',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      topTenantShare: share,
      herfindahlIndex: herfindahl,
    },
  };
}

export const INCOME_CONCENTRATION_BANDS = BANDS;
export const INCOME_CONCENTRATION_APPLICABLE_TYPES = TENANT_BASED_TYPES;
export const INCOME_CONCENTRATION_NA_TYPES = UNIT_OR_ROOM_BASED_TYPES;
