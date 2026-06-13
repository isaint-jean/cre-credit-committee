/**
 * doctrine-clean / dimensions / cap-rate-valuation-stress.ts
 *
 * Dimension 7 — Cap-rate / valuation stress.
 *
 * SPEC v2 §7 (verbatim):
 *   Principle: value = sustainable NCF / an asset-specific, market-tier-
 *   adjusted cap rate; going-in vs. terminal matters.
 *   Convergence: KBRA asset-specific KBRA cap rate; DBRS stressed cap-rate
 *   ranges (office 6.0–10.0%); Moody's quality grade → cap rate. All three
 *   derive value below appraisal.
 *   Proposed treatment: going-in floor + terminal widen, market-tier
 *   adjusted. (The tier deltas were corpus-tuned before — refit against
 *   the clean corpus, do not carry over.)
 *
 * FENCE (HIGHEST-RISK DIMENSION):
 *   The "corpus-tuned tier deltas" referenced in the spec are the OLD
 *   doctrine's numbers. We do NOT open them, do NOT load
 *   manifesto_rules.json, do NOT carry over any old floor / delta /
 *   adjustment. Every number in this file traces to a public source:
 *   DBRS stressed cap-rate ranges, KBRA asset-specific cap rates,
 *   Moody's quality-grade → cap-rate framework, plus public cap-rate
 *   data (MSCI/RCA, Trepp) for sanity.
 *
 * DEVIATION from spec v2 §7's literal "refit against the clean corpus":
 *   the clean backbone corpus carries n=12 LOSS records (3 with all
 *   value+NOI inputs populated after the v3 read). That is too thin to
 *   refit per-asset-class tier deltas without overfitting — the corpus
 *   would simply re-introduce the same trap the old doctrine fell into
 *   (a model that memorized its calibration deals). We instead derive
 *   the floors from the PUBLIC agency ranges (robust, multi-source) and
 *   use the corpus ONLY as a coarse sanity check (sensible stressed
 *   values, plausible cap rates, no bugs). This is documented in the
 *   build-order #3 prompt as the explicit deviation; it shifts dim 7
 *   off the trap.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   Value, properly underwritten, is what the asset's sustainable cash
 *   flow supports at the cap rate a sober buyer would underwrite to —
 *   not what an appraisal report concluded for a 10-K disclosure. The
 *   three NRSROs converge on the framework: (a) strip the issuer's
 *   pro-forma growth and excess vacancy normalization out of cash flow
 *   to get a haircut NCF, then (b) divide by an asset-specific,
 *   market-tier-adjusted cap rate. The output — the agency Value —
 *   sits below the appraisal. Loan leverage and coverage are then
 *   measured against THAT value, not against appraisal.
 *
 *   Cap-rate convergence:
 *     - DBRS publishes explicit STRESSED cap-rate RANGES per asset class
 *       in its Multi-Borrower / SASB / Property Analysis criteria.
 *       Office is the most widely-cited range: 6.0% to 10.0%, with
 *       individual property cap rates set within the band based on
 *       market tier, asset quality, tenancy, and rollover. Other asset
 *       classes follow similar bands.
 *     - KBRA's North American CMBS Property Evaluation Methodology
 *       publishes asset-specific "KBRA cap rates" used to back into
 *       KBRA Value, which in turn drives KLTV / KDSC / KDY. Their
 *       per-property cap rate is built up from asset class + market +
 *       quality (analogous structure to DBRS).
 *     - Moody's Approach to Rating US Conduit/Fusion CMBS derives a cap
 *       rate from the property's QUALITY GRADE (1 = institutional-AAA,
 *       5 = highly stressed) and asset class. The grade-to-cap-rate
 *       mapping is published in the methodology.
 *     - Public cap-rate data — MSCI/RCA US National All-Property Index,
 *       Trepp quarterly CMBS appraisal cap-rate series — provides the
 *       transaction-level sanity check that agency stressed bands sit
 *       ABOVE the transaction-level market clearing rates by the
 *       agency's stress carve-out (typically 75-150 bps above the
 *       transaction median for "good market" property types).
 *
 *   GOING-IN vs TERMINAL:
 *     Going-in cap rate values the asset at loan close (today's NCF /
 *     today's cap rate). Terminal cap rate widens for the loan's exit:
 *     the property must refinance at maturity, and a sober underwriter
 *     assumes cap rates widen between today and maturity (reversion to
 *     mean + cycle uncertainty + exit liquidity). Standard convention
 *     in CMBS underwriting and CREFC pro-forma guidance is terminal =
 *     going-in + 50 bps to 100 bps. We use +50 bps as a moderate widen,
 *     consistent across the three agencies.
 *
 *   MARKET TIER ADJUSTMENT:
 *     Both KBRA and DBRS adjust the cap rate by market quality. The
 *     adjustment is structurally a tier delta: PRIMARY / Gateway
 *     markets (Manhattan, San Francisco, Boston, Chicago CBD, DC etc.)
 *     trade at tighter cap rates; SECONDARY markets at the asset-class
 *     base; TERTIARY at +50 to +100 bps. The corpus does NOT currently
 *     expose market designation, so this dimension reads market tier
 *     as 'Unknown' for every corpus record today and applies no market
 *     delta. The delta logic is preserved for future extractor support.
 *
 * INPUT STATES (three, per the dim-8/6 doctrine):
 *   POPULATED: assetType + uwY1Noi + concludedValue present → compute
 *              stressed value, stressed LTV (if loanAmount present),
 *              and risk contribution from valuation aggressiveness.
 *   HITL:      assetType OR uwY1Noi OR concludedValue null/missing →
 *              riskContribution=null, tier='N/A',
 *              applicability='hitl-needed'. NEVER substitute a
 *              conservative default at the contribution layer.
 *
 *   There is no N/A-by-asset-type for this dimension — cap-rate /
 *   valuation stress applies to every asset class that has any income
 *   (every CMBS-financed commercial property).
 *
 * RISK SIGNAL — valuation aggressiveness:
 *   The dimension's risk contribution measures how aggressively the
 *   issuer-concluded value is set relative to the stressed value the
 *   agencies derive. Bands:
 *     low      <  15%   ( 0.10 ) — durable; issuer value ≈ stressed
 *     moderate 15-30%   ( 0.30 ) — typical CMBS underwriting spread
 *     elevated 30-45%   ( 0.55 ) — agency-flag zone (DBRS calibrates
 *                                  ~61% LTV vs DBRS Value to withstand
 *                                  a ~39% appraisal-vs-stressed decline)
 *     high     ≥  45%   ( 0.80 ) — tail aggression
 *
 * DERIVED OUTPUTS (for downstream LTV / DSCR / DY dimensions):
 *     stressedCapRateGoingIn        (decimal, e.g. 0.080 = 8.00%)
 *     stressedCapRateTerminal       (decimal, going-in + 50 bps)
 *     stressedValue                 (uwY1Noi / stressedCapRateGoingIn)
 *     stressedLtv                   (loanAmount / stressedValue) if loanAmount
 *     valuationAggressiveness       (concludedValue − stressedValue) / concludedValue
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

export interface CapRateValuationStressInput {
  /** Normalized asset class from the extractor. May be null → HITL. */
  readonly assetType: string | null;
  /** Optional sub-type for finer asset-class disambiguation (Mall vs Anchored). */
  readonly subType: string | null;
  /**
   * Issuer-underwritten Year-1 NOI in dollars. Used ONLY as a fallback
   * when `sustainableNcf` is not provided by the sustainable-cashflow
   * normalization pre-step (e.g., when this dimension is called in
   * isolation in tests). The canonical pipeline runs the sustainable-
   * cashflow normalization first and passes `sustainableNcf` directly,
   * matching the KBRA/DBRS/Moody's convergence ("don't trust the
   * issuer's underwritten number — re-derive sustainable cash flow").
   */
  readonly uwY1Noi: number | null;
  /**
   * Sustainable NCF in dollars from the upstream normalization
   * pre-step (see `normalization/sustainable-cashflow.ts`). When
   * present, this is the numerator used to derive the stressed value.
   * When null/undefined, dim 7 falls back to `uwY1Noi` and flags the
   * fallback in the rationale + provenance.
   */
  readonly sustainableNcf?: number | null;
  /**
   * Concluded value used as the comparator: stressed value vs
   * concluded value yields the valuation aggressiveness signal.
   * Resolved upstream by the adapter from one of three explicit
   * sources (see concludedValueSource).
   */
  readonly concludedValue: number | null;
  /**
   * Provenance tag for `concludedValue`. Source-agnostic stressing —
   * the cap-rate floor is applied regardless of source — but the
   * rationale surfaces a confidence note when the source is
   * 'operator-supplied' so the lender-facing audit discloses the
   * valuation basis verbatim. Optional + nullable for back-compat
   * with callers that haven't yet wired the source through.
   */
  readonly concludedValueSource?:
    | 'extracted-appraisal'
    | 'extracted-asr'
    | 'operator-supplied'
    | null;
  /** Loan amount in dollars. Used to compute stressed LTV (derived output). */
  readonly loanAmount: number | null;
  /**
   * Market tier — 'Primary' (Gateway), 'Secondary', 'Tertiary', or
   * 'Unknown'. Corpus does not currently expose this; left as 'Unknown'
   * for every record today (no market-tier delta applied). The future
   * extractor wiring will populate this from MSA / submarket tagging.
   */
  readonly marketTier: 'Primary' | 'Secondary' | 'Tertiary' | 'Unknown' | null;
}

/**
 * Going-in stressed cap-rate FLOORS by asset class, in decimal form.
 *
 * These are derived from the PUBLIC DBRS stressed ranges (cited per
 * asset class) with KBRA + Moody's directional cross-check. Each floor
 * is set near the midpoint-to-upper of the DBRS published range — a
 * sober going-in rate consistent with KBRA's per-property cap and
 * Moody's quality-grade-3 (institutional-stable) cap, the "central
 * stress" the three agencies converge near.
 *
 * NUMBERS ARE FROM PUBLIC SOURCES. They are NOT carried over from old
 * doctrine's `manifesto_rules.json`. The old deltas were corpus-tuned
 * (the trap spec v2 §7 calls out); we deliberately do not use them.
 */
interface AssetCapRateFloor {
  readonly assetClass: string;
  readonly goingInDecimal: number;
  readonly dbrsRangeLow: number;
  readonly dbrsRangeHigh: number;
  readonly source: string;
}

export const ASSET_FLOORS: readonly AssetCapRateFloor[] = [
  {
    assetClass: 'Multifamily',
    goingInDecimal: 0.0650,
    dbrsRangeLow: 0.0500, dbrsRangeHigh: 0.0800,
    source: 'DBRS Multifamily 5.0-8.0%; KBRA multifamily KBRA cap ~6.0-7.0%; Moody\'s grade-3 multifamily ~6.5%',
  },
  {
    assetClass: 'MHC',
    goingInDecimal: 0.0675,
    dbrsRangeLow: 0.0550, dbrsRangeHigh: 0.0850,
    source: 'DBRS MHC 5.5-8.5% (slightly above multifamily); KBRA MHC cap ~6.5-7.5%',
  },
  {
    assetClass: 'Industrial',
    goingInDecimal: 0.0725,
    dbrsRangeLow: 0.0600, dbrsRangeHigh: 0.0950,
    source: 'DBRS Industrial 6.0-9.5%; KBRA industrial KBRA cap ~6.5-7.5%; Moody\'s grade-3 industrial ~7.0%',
  },
  {
    assetClass: 'AnchoredRetail',
    goingInDecimal: 0.0775,
    dbrsRangeLow: 0.0650, dbrsRangeHigh: 0.0950,
    source: 'DBRS Retail (anchored) 6.5-9.5%; KBRA anchored ~7.0-8.0%; Moody\'s grade-3 anchored ~7.25%',
  },
  {
    assetClass: 'SelfStorage',
    goingInDecimal: 0.0775,
    dbrsRangeLow: 0.0650, dbrsRangeHigh: 0.0950,
    source: 'DBRS Self-storage 6.5-9.5%; KBRA self-storage ~7.0-7.5%; Moody\'s grade-3 ~7.5%',
  },
  {
    assetClass: 'MixedUse',
    goingInDecimal: 0.0800,
    dbrsRangeLow: 0.0650, dbrsRangeHigh: 0.0950,
    source: 'DBRS Mixed-Use 6.5-9.5% (uses dominant-component cap weighted); KBRA mixed-use blended',
  },
  {
    assetClass: 'UnanchoredRetail',
    goingInDecimal: 0.0850,
    dbrsRangeLow: 0.0700, dbrsRangeHigh: 0.1050,
    source: 'DBRS Retail (unanchored) 7.0-10.5%; KBRA unanchored adds 50-100bps over anchored; Moody\'s grade-3 unanchored ~8.0%',
  },
  {
    assetClass: 'Office',
    // Default Office floor when no subtype is provided. Operator-judgment
    // anchored within the public range (DBRS 6.0-10.0%, KBRA ~7.0-9.0%,
    // Moody's grade-3 ~7.5%): conservative central at 0.0900. Per-subtype
    // floors live in OFFICE_SUBTYPE_FLOORS below and take precedence when
    // a subtype resolves.
    goingInDecimal: 0.0900,
    dbrsRangeLow: 0.0600, dbrsRangeHigh: 0.1000,
    source: 'OPERATOR-JUDGMENT (anchored to public range — DBRS Office 6.0-10.0%, KBRA office ~7.0-9.0%, Moody\'s grade-3 office ~7.5%; NOT employer-derived) — default Office floor 9.00% used when no subtype resolves',
  },
  {
    assetClass: 'Mall',
    goingInDecimal: 0.0900,
    dbrsRangeLow: 0.0750, dbrsRangeHigh: 0.1150,
    source: 'DBRS regional/super-regional mall 7.5-11.5% (post-2020 wider); KBRA mall ~8.0-10.0%; secular pressure raises floor',
  },
  {
    assetClass: 'Hotel',
    goingInDecimal: 0.0950,
    dbrsRangeLow: 0.0800, dbrsRangeHigh: 0.1100,
    source: 'DBRS Hotel 8.0-11.0%; KBRA hotel ~9.0-10.0%; Moody\'s hotel grade-3 ~9.0%',
  },
  {
    assetClass: 'Unknown',
    goingInDecimal: 0.0900,
    dbrsRangeLow: 0.0500, dbrsRangeHigh: 0.1150,
    source: 'Fallback when extractor could not classify — sits near top of agency stress range as conservative floor',
  },
] as const;

const FLOOR_BY_ASSET: ReadonlyMap<string, AssetCapRateFloor> =
  new Map(ASSET_FLOORS.map(f => [f.assetClass, f]));

/**
 * Office subtype floors — operator-judgment anchored to the public Office
 * range (DBRS 6.0-10.0%, KBRA ~7.0-9.0%, Moody's grade-3 ~7.5%). NOT
 * employer-derived. The per-subtype split reflects desk consensus that
 * CBD office carries the heaviest re-leasing + structural-stress risk
 * post-2020 (work-from-home dislocation, sublease overhang); suburban
 * office sits between CBD and medical; medical-office buildings
 * (purpose-built, sticky tenant base) carry the lightest stress.
 *
 * Subtype detection is permissive — the resolver reads the SubType
 * string case-insensitively and substring-matches the keys below. When
 * no subtype resolves, the resolver falls through to the default Office
 * floor (0.0900) in ASSET_FLOORS.
 *
 * Market-tier deltas (Primary -50bps, Tertiary +50bps, Unknown 0bps) are
 * applied UNCHANGED on top of the subtype floor by the dimension's main
 * path — the subtype map sets the BASE going-in rate only.
 */
export const OFFICE_SUBTYPE_FLOORS: ReadonlyMap<string, { goingInDecimal: number; subtypeLabel: string }> = new Map([
  ['cbd',       { goingInDecimal: 0.0900,  subtypeLabel: 'Office CBD' }],
  ['suburban',  { goingInDecimal: 0.0850,  subtypeLabel: 'Office Suburban' }],
  ['medical',   { goingInDecimal: 0.0775,  subtypeLabel: 'Office Medical' }],
]);

/** Default Office floor used when subType is null OR doesn't match any key. */
export const OFFICE_SUBTYPE_DEFAULT_FLOOR = 0.0900;

/** Constant +50 bps terminal widening (standard CMBS / CREFC convention). */
export const TERMINAL_WIDEN_BPS = 0.0050;

/** Market-tier deltas in bps (asset-agnostic). */
export const MARKET_TIER_DELTAS: Record<'Primary' | 'Secondary' | 'Tertiary' | 'Unknown', number> = {
  Primary:   -0.0050,   // -50 bps tighter
  Secondary:  0.0000,
  Tertiary:  +0.0050,   // +50 bps wider
  Unknown:    0.0000,
};

export interface ValuationBand {
  readonly tier: 'low' | 'moderate' | 'elevated' | 'high';
  readonly riskContribution: number;
  readonly minAggressiveness: number;     // inclusive lower edge
  readonly maxAggressiveness: number;     // exclusive upper edge
  readonly rationale: string;
}

export const VALUATION_BANDS: readonly ValuationBand[] = [
  {
    tier: 'low',
    riskContribution: 0.10,
    minAggressiveness: Number.NEGATIVE_INFINITY,
    maxAggressiveness: 0.15,
    rationale:
      'Stressed value within ~15% of concluded value (or above). The ' +
      'issuer-concluded value is durable under agency cap-rate stress; ' +
      'leverage and coverage measured against either base land in ' +
      'similar territory.',
  },
  {
    tier: 'moderate',
    riskContribution: 0.30,
    minAggressiveness: 0.15,
    maxAggressiveness: 0.30,
    rationale:
      'Stressed value 15-30% below concluded. Typical CMBS ' +
      'underwriting carve-out; the agencies routinely set Value here. ' +
      'Above-baseline aggression but within the conventional band.',
  },
  {
    tier: 'elevated',
    riskContribution: 0.55,
    minAggressiveness: 0.30,
    maxAggressiveness: 0.45,
    rationale:
      'Stressed value 30-45% below concluded. DBRS calibrates ~61% LTV ' +
      'vs DBRS Value to withstand a ~39% appraisal-vs-stressed decline; ' +
      'this band is at or beyond that calibration point. Agency-flag ' +
      'zone for valuation aggression.',
  },
  {
    tier: 'high',
    riskContribution: 0.80,
    minAggressiveness: 0.45,
    maxAggressiveness: Number.POSITIVE_INFINITY,
    rationale:
      'Stressed value 45%+ below concluded. Tail aggression — the ' +
      'concluded value depends on assumptions the agencies\' stressed ' +
      'cap rate does not credit. Leverage / coverage measured against ' +
      'concluded mask material risk.',
  },
] as const;

function resolveAssetFloor(
  assetType: string | null,
  subType: string | null,
): AssetCapRateFloor {
  if (assetType === null) return FLOOR_BY_ASSET.get('Unknown')!;
  // Disambiguate Retail → Mall via subType when subType signals mall structure.
  if (assetType === 'Retail' || assetType === 'AnchoredRetail' || assetType === 'UnanchoredRetail') {
    const st = (subType ?? '').toLowerCase();
    if (st.includes('mall') || st.includes('mills') || st.includes('outlet')) {
      return FLOOR_BY_ASSET.get('Mall')!;
    }
    if (assetType === 'Retail') {
      // Bare "Retail" with no sub-class signal — conservative default,
      // consistent with the dim-8 canonicalization (UnanchoredRetail).
      return FLOOR_BY_ASSET.get('UnanchoredRetail')!;
    }
  }
  // Office subtype split (operator-judgment anchored to public range).
  // Reads subType case-insensitively + substring-matches the OFFICE_SUBTYPE_FLOORS
  // keys; falls through to the default Office floor on no match / null.
  if (assetType === 'Office') {
    const baseOffice = FLOOR_BY_ASSET.get('Office')!;
    const st = (subType ?? '').toLowerCase();
    for (const [key, entry] of OFFICE_SUBTYPE_FLOORS) {
      if (st.includes(key)) {
        return {
          ...baseOffice,
          goingInDecimal: entry.goingInDecimal,
          source: `OPERATOR-JUDGMENT (${entry.subtypeLabel} — anchored to public Office range DBRS 6.0-10.0% / KBRA ~7.0-9.0% / Moody's grade-3 ~7.5%; NOT employer-derived): ${(entry.goingInDecimal * 100).toFixed(2)}%`,
        };
      }
    }
    // subType null OR unrecognized — _default fallback (already 0.0900 on baseOffice).
    return {
      ...baseOffice,
      goingInDecimal: OFFICE_SUBTYPE_DEFAULT_FLOOR,
      source: `OPERATOR-JUDGMENT (Office _default — subType absent or unrecognized; anchored to public range; NOT employer-derived): ${(OFFICE_SUBTYPE_DEFAULT_FLOOR * 100).toFixed(2)}%`,
    };
  }
  return FLOOR_BY_ASSET.get(assetType) ?? FLOOR_BY_ASSET.get('Unknown')!;
}

export function evaluateCapRateValuationStress(
  input: CapRateValuationStressInput,
): DimensionContribution {
  // (1) HITL — any of the three drivers absent.
  if (input.assetType === null || input.uwY1Noi === null || input.concludedValue === null) {
    const missing: string[] = [];
    if (input.assetType === null) missing.push('assetType');
    if (input.uwY1Noi === null) missing.push('uwY1Noi');
    if (input.concludedValue === null) missing.push('concludedValue');
    return {
      dimensionId: 'cap-rate-valuation-stress',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[HITL — missing input(s): ${missing.join(', ')}] ` +
        'Cap-rate / valuation-stress dimension requires assetType + ' +
        'uwY1Noi + concludedValue. Route to human review. NEVER ' +
        'substitute a conservative default at the contribution layer.',
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
      derivedOutputs: {
        stressedCapRateGoingIn: null,
        stressedCapRateTerminal: null,
        stressedValue: null,
        stressedLtv: null,
        valuationAggressiveness: null,
      },
    };
  }

  // (2) Defensive sanity gates — refuse to score on absurd inputs.
  if (input.uwY1Noi <= 0 || input.concludedValue <= 0) {
    return {
      dimensionId: 'cap-rate-valuation-stress',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        `[HITL — non-positive input(s)] uwY1Noi=${input.uwY1Noi}, ` +
        `concludedValue=${input.concludedValue}. NOI / value must be ` +
        '> 0. Sanity gate failed upstream; route to human review.',
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (3) POPULATED — derive stressed cap rate, value, LTV, aggressiveness.
  // Numerator: PREFER sustainable NCF (from the upstream normalization);
  // FALL BACK to uwY1Noi when sustainable NCF was not provided.
  // The fallback is flagged in rationale + provenance so reviewers see
  // when the spine's "sustainable cash flow" half is not wired.
  const useSustainable = input.sustainableNcf !== undefined && input.sustainableNcf !== null && input.sustainableNcf > 0;
  const cashflowBase = useSustainable ? input.sustainableNcf! : input.uwY1Noi;
  const cashflowBaseLabel = useSustainable
    ? `sustainable NCF $${Math.round(cashflowBase).toLocaleString()}`
    : `issuer Y1 NOI $${Math.round(cashflowBase).toLocaleString()} (FALLBACK — sustainable NCF not provided)`;
  const floor = resolveAssetFloor(input.assetType, input.subType);
  const tier = input.marketTier ?? 'Unknown';
  const marketDelta = MARKET_TIER_DELTAS[tier];
  const stressedCapRateGoingIn = floor.goingInDecimal + marketDelta;
  const stressedCapRateTerminal = stressedCapRateGoingIn + TERMINAL_WIDEN_BPS;
  const stressedValue = cashflowBase / stressedCapRateGoingIn;
  const stressedLtv = input.loanAmount !== null && input.loanAmount > 0
    ? input.loanAmount / stressedValue
    : null;
  const valuationAggressiveness = (input.concludedValue - stressedValue) / input.concludedValue;

  const band = VALUATION_BANDS.find(b =>
    valuationAggressiveness >= b.minAggressiveness && valuationAggressiveness < b.maxAggressiveness,
  )!;

  // Source-agnostic stressing: cap-floor + sustainable NCF drive the stressed
  // value regardless of where the comparator came from. But surface a
  // CONFIDENCE NOTE when the comparator is operator-supplied so the
  // lender-facing audit discloses the valuation basis verbatim.
  const concludedValueSource = input.concludedValueSource ?? null;
  const sourceLabel =
    concludedValueSource === 'extracted-appraisal' ? 'extracted appraisal (third-party)'
    : concludedValueSource === 'extracted-asr'     ? 'extracted ASR implied value'
    : concludedValueSource === 'operator-supplied' ? 'OPERATOR-SUPPLIED'
    : 'unspecified source';
  const operatorConfidenceNote = concludedValueSource === 'operator-supplied'
    ? ' [VALUATION BASIS: operator-supplied — lower data confidence than a third-party ' +
      'appraisal; data-confidence note, NOT a score penalty. Stressed-value math unchanged.]'
    : '';

  return {
    dimensionId: 'cap-rate-valuation-stress',
    riskContribution: band.riskContribution,
    tier: band.tier,
    rationale:
      `Asset=${floor.assetClass} market=${tier}: stressed cap rate ` +
      `going-in ${(stressedCapRateGoingIn * 100).toFixed(2)}% / terminal ` +
      `${(stressedCapRateTerminal * 100).toFixed(2)}% applied to ${cashflowBaseLabel} ` +
      `→ stressed value $${Math.round(stressedValue).toLocaleString()} vs concluded ` +
      `$${Math.round(input.concludedValue).toLocaleString()} (basis: ${sourceLabel}) → ` +
      `valuation aggressiveness ${(valuationAggressiveness * 100).toFixed(1)}% → ` +
      `${band.tier}. ${band.rationale}${operatorConfidenceNote}`,
    provenance: [
      'spec v2 §7 (Cap-rate / valuation stress)',
      useSustainable
        ? 'Numerator = sustainable NCF from normalization/sustainable-cashflow.ts (KBRA KNCF / DBRS stabilized-NCF basis)'
        : 'Numerator = issuer Y1 NOI (FALLBACK — sustainable-cashflow normalization not provided to this call)',
      `DBRS Morningstar stressed cap-rate range for ${floor.assetClass}: ${(floor.dbrsRangeLow * 100).toFixed(1)}-${(floor.dbrsRangeHigh * 100).toFixed(1)}%`,
      `KBRA North American CMBS Property Evaluation Methodology — asset-specific KBRA cap rate (cross-check)`,
      `Moody's Approach to Rating US Conduit/Fusion CMBS — quality-grade → cap rate (cross-check)`,
      'Public cap-rate data — MSCI/RCA US National All-Property Index, Trepp CMBS appraisal-cap series (transaction-level sanity)',
      `Going-in floor source: ${floor.source}`,
      'Terminal widen +50 bps — standard CMBS / CREFC pro-forma convention',
      'Valuation aggressiveness bands — DBRS LTV Sizing Benchmark calibration (~61% LTV withstands ~39% decline)',
      'DEVIATION from spec v2 §7 literal "refit against corpus": corpus n=12 too thin; deltas derived from public ranges, corpus used only as coarse sanity check',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      stressedCapRateGoingIn,
      stressedCapRateTerminal,
      stressedValue,
      stressedLtv,
      valuationAggressiveness,
      // Pass-through of the concluded value the dim consumed — surfaced so
      // downstream consumers (memo renderer / RenderedAnalysis) can display
      // the raw comparator alongside the doctrine-stressed value without
      // re-reading from the rationale prose. Bijective: equals input.concludedValue.
      concludedValue: input.concludedValue,
      // Source tag carried forward for the lender-facing audit. Resolution
      // precedence (extraction → operator fallback) and confidence semantics
      // live in adapters/extraction-to-dealbag.ts::resolveConcludedValue.
      concludedValueSource,
    },
  };
}

export const ASSET_CAP_RATE_FLOORS = ASSET_FLOORS;
export const VALUATION_AGGRESSIVENESS_BANDS = VALUATION_BANDS;
