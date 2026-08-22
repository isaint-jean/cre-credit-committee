/**
 * portfolio-aggregator.service.ts — PORTFOLIO PHASE 2
 *
 * The roll-up AGGREGATOR. Turns the Phase-1 `PropertyComponent[]` (the N
 * per-property children of a portfolio loan) into portfolio-level numbers:
 *   1. run the EXISTING per-property scorer `evaluateDeal()` N times (verbatim,
 *      once per component) → N per-property scores, and
 *   2. compute the deterministic roll-up MATH (blended value / cap, aggregate
 *      DSCR, concentration) over the components.
 *
 * ★ DOCTRINE IS NOT REOPENED. This layer CONSUMES `evaluateDeal()`; it does
 * NOT modify the scorer, the 9 dimensions, the thresholds, or the DealBag
 * contract. Each component is mapped to a per-property DealBag with the SAME
 * mapping the committed corpus sweep (sweep-asset-class-corpus.ts) already
 * uses, so per-property scoring is byte-identical to that validated path.
 *
 * ★ CELL DISCIPLINE (banked). The aggregator COMPUTES every cell that is
 * sourceable from the component records (value / cap / DSCR / concentration)
 * and HONEST-BLANKS the judgment cells (cross-collateralization terms, release
 * provisions, portfolio-level market view) as `DATA_NOT_PROVIDED` with a
 * stated reason — there is zero modeling hook for them in the EX-102 surface,
 * so a blank is the honest answer, never a fabricated figure.
 *
 * ★ THE INVARIANT: this fires ONLY for `roll_up` mode. The N=1 single-property
 * path never calls it; `hydrateUnderwritingContext` gates on
 * `mode === 'roll_up'` exactly as it did for `buildRollUpStub()`. So the
 * committed 479-deal single-property sweep is byte-unchanged.
 *
 * NO DB writes. Pure struct→struct + the pure `evaluateDeal()` call.
 */
import type { PropertyComponent } from '@cre/contracts';
import type { RollUpAggregation } from '@cre/shared';
import { evaluateDeal, type DealBag, type EvaluateDealResult } from '../doctrine-clean/scoring/evaluate-deal.js';

/* ------------------------------------------------------------------ */
/*  Component → DealBag mapping (mirrors sweep-asset-class-corpus.ts)  */
/* ------------------------------------------------------------------ */

/**
 * EX-102 `propertyType` label → the scorer's canonical `assetType` string.
 * Identical remap table to the committed corpus sweep, so per-property
 * scoring reproduces that validated path exactly. null when unmappable.
 */
const COMPONENT_TO_ASSET_TYPE: Readonly<Record<string, string>> = {
  Multifamily: 'Multifamily',
  Retail: 'Retail',
  Industrial: 'Industrial',
  'Self-Storage': 'SelfStorage',
  Lodging: 'Hotel',
  'Mixed-Use': 'MixedUse',
  Office: 'Office',
};

function mapAssetType(propertyType: string | null): string | null {
  if (propertyType === null) return null;
  return COMPONENT_TO_ASSET_TYPE[propertyType] ?? null;
}

/**
 * One `PropertyComponent` → one per-property `DealBag`.
 *
 * ★ Mapping is DELIBERATELY the corpus-sweep mapping (the validated one):
 *   value          → concludedValue (source 'extracted-annex-a')
 *   noi            → uwY1Noi        (single EX-102 NOI period; t12Noi = null)
 *   occupancyPct   → underwrittenOccupancy
 *   (no per-property loan piece / coupon / tenant roster in the child
 *    records)  → loanAmount / coupon / tenant fields = null; the LTV /
 *    DSCR / concentration / rollover dims route to HITL honestly per
 *    component. Component scoring here is a per-asset QUALITY read (cap-rate
 *    stress, asset-class floor, vacancy tell), NOT a per-piece leverage read
 *    — the leverage lives at the WHOLE-LOAN / portfolio level, computed by the
 *    roll-up math below, not inside a component DealBag.
 */
function componentToDealBag(c: PropertyComponent): DealBag {
  return {
    propertyName: c.propertyName,
    assetType: mapAssetType(c.propertyType),
    subType: null,
    loanAmount: null,           // per-component loan piece not carried on the child record
    coupon: null,
    concludedValue: c.value,
    concludedValueSource: 'extracted-annex-a',
    uwY1Noi: c.noi,
    t12Noi: null,               // EX-102 carries one NOI period
    underwrittenOccupancy: c.occupancyPct,
    largestTenantPct: null,
    largestTenantBasis: 'unknown',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: null,
    amortMonths: null,
    ioYears: null,
    termYears: null,
    marketTier: 'Unknown',
  };
}

/* ------------------------------------------------------------------ */
/*  Result types                                                       */
/* ------------------------------------------------------------------ */

/** One component's scored result — the DealBag echoed + the full evaluation. */
export interface ScoredComponent {
  readonly ordinal: number;
  readonly componentId: string | null;
  readonly propertyName: string | null;
  readonly dealBag: DealBag;
  readonly evaluation: EvaluateDealResult;
  /** (1 − ratedRisk) × 100, or null when the scorer routed to InsufficientData. */
  readonly finalScore: number | null;
  readonly ratedRisk: number | null;
  readonly band: string | null;
  readonly recommendation: string;
}

/** State-level concentration slice. */
export interface ConcentrationSlice {
  readonly key: string;
  readonly valueShare: number;   // 0..1, share of Σvalue
}

/** The computed portfolio concentration metric family. */
export interface PortfolioConcentration {
  /** Largest single property's value ÷ Σvalue (0..1). null when Σvalue == 0. */
  readonly topPropertyValueShare: number | null;
  /** Property name of the largest single property (provenance). */
  readonly topPropertyName: string | null;
  /** Value-share by state (descending). */
  readonly geographicMixByState: readonly ConcentrationSlice[];
  /** Value-share by asset class (descending). */
  readonly assetClassMix: readonly ConcentrationSlice[];
  /** Herfindahl-Hirschman index of value shares, Σ(share²) ∈ (0..1].
   *  1.0 == fully concentrated (one property); → 1/N as N properties even out. */
  readonly herfindahlIndex: number | null;
  /** Effective number of properties = 1 / HHI (the HHI's inverse read). */
  readonly effectiveProperties: number | null;
}

/**
 * The debt-service basis the aggregate DSCR was computed against.
 *
 * ★ THE PARI-PASSU CAVEAT MADE EXPLICIT. The EX-102 child records carry
 * per-property NOI / NCF / value but NO per-property loan piece, and the
 * PARENT roll-up row's loan figure is the TRUST PIECE ($20M for PSB), not the
 * whole loan. The whole-loan debt service that the issuer's stated DSCR (1.45)
 * is computed against is NOT carried in the EX-102 surface. So:
 *   - When a caller supplies `wholeLoanDebtService`, the aggregate DSCR is
 *     ΣNCF ÷ that figure (the honest, reproducible basis).
 *   - Absent it, the aggregate DSCR is null (honest-blank) — the aggregator
 *     will NOT publish a DSCR computed against the trust PIECE (that reads
 *     structurally high / wrong, the same pari-passu trap the corpus sweep
 *     flagged for LTV/DY).
 */
export type DscrBasis =
  | { readonly kind: 'whole-loan-debt-service'; readonly debtService: number }
  | { readonly kind: 'not-derivable'; readonly reason: string };

/** The full computed roll-up math (the sourceable cells). */
export interface RollUpMath {
  readonly loanCount: number;
  /** Σ per-property value. */
  readonly blendedValue: number | null;
  /** Σ per-property NOI. */
  readonly aggregateNoi: number | null;
  /** Σ per-property NCF. */
  readonly aggregateNcf: number | null;
  /** ★ RECOMMENDED basis: value-weighted blended cap = ΣNOI ÷ Σvalue. */
  readonly blendedCapRate: number | null;
  /** Aggregate DSCR = ΣNCF ÷ whole-loan debt service (null when DS not supplied). */
  readonly aggregateDscr: number | null;
  readonly dscrBasis: DscrBasis;
  /** Σ per-property allocated loan amount = the whole-loan balance (Phase A). Null
   *  when no property carries an allocation (honest — no guessed denominator). */
  readonly wholeLoanBalance: number | null;
  /** Portfolio LTV = whole-loan balance ÷ Σvalue (null when either is absent). */
  readonly portfolioLtv: number | null;
  /** Portfolio debt yield = ΣNOI ÷ whole-loan balance (null when either is absent). */
  readonly portfolioDebtYield: number | null;
  readonly concentration: PortfolioConcentration;
}

/* ------------------------------------------------------------------ */
/*  Portfolio-structure terms — HONEST-BLANK by default (Phase 3)      */
/* ------------------------------------------------------------------ */

/** Sentinel for a portfolio-structure cell that has no source and no human
 *  input. NEVER computed / fabricated — a blank is the honest answer. */
export const DATA_NOT_PROVIDED = 'DATA_NOT_PROVIDED' as const;
export type DataNotProvided = typeof DATA_NOT_PROVIDED;

/**
 * ★ PORTFOLIO-STRUCTURE TERMS — release provisions & cross-collateralization.
 *
 * These are DEAL-DOCUMENT / HUMAN-JUDGMENT terms with ZERO modeling hook in the
 * EX-102 surface (no release prices, no cross-collateral covenants, no
 * cross-default language are carried in the child records). There is no model
 * that can invent them. So the DEFAULT is HONEST-BLANK (`DATA_NOT_PROVIDED`) —
 * never a computed or fabricated figure — with an OPTIONAL slot to RECORD a
 * value IF a human supplies it from the loan documents.
 *
 * A field is either the sentinel (no data / no human input) or a human-supplied
 * string. The aggregator NEVER writes anything but the sentinel; only
 * `supplyPortfolioStructure` (a human-in-the-loop entry) sets a real value.
 */
export interface PortfolioStructureTerms {
  /** Cross-collateralization: are the N properties cross-collateralized?
   *  Human-supplied verdict / terms, else DATA_NOT_PROVIDED. */
  readonly crossCollateralized: string | DataNotProvided;
  /** Cross-default: does default on one property trigger default across the
   *  pool? Human-supplied, else DATA_NOT_PROVIDED. */
  readonly crossDefaulted: string | DataNotProvided;
  /** Release provisions: the terms permitting release of an individual
   *  property (release price, prepayment premium, min-debt-yield/LTV tests).
   *  Human-supplied, else DATA_NOT_PROVIDED. */
  readonly releaseProvisions: string | DataNotProvided;
  /** Release price / defeasance premium basis (e.g. "115% of allocated loan
   *  amount"). Human-supplied, else DATA_NOT_PROVIDED — NEVER a computed
   *  release price (there is no allocated-loan-amount source in EX-102). */
  readonly releasePriceBasis: string | DataNotProvided;
  /** Substitution / addition-of-collateral rights. Human-supplied, else
   *  DATA_NOT_PROVIDED. */
  readonly substitutionRights: string | DataNotProvided;
  /** Provenance / who supplied any non-blank value (audit slot). */
  readonly source: string | DataNotProvided;
}

/** The all-honest-blank default — the ONLY thing the aggregator emits. */
export const BLANK_PORTFOLIO_STRUCTURE: PortfolioStructureTerms = {
  crossCollateralized: DATA_NOT_PROVIDED,
  crossDefaulted: DATA_NOT_PROVIDED,
  releaseProvisions: DATA_NOT_PROVIDED,
  releasePriceBasis: DATA_NOT_PROVIDED,
  substitutionRights: DATA_NOT_PROVIDED,
  source: DATA_NOT_PROVIDED,
};

/**
 * Human-in-the-loop entry point: record portfolio-structure terms a human read
 * from the loan documents. Every field defaults to the honest blank; only the
 * fields the human supplies are overwritten. This is the ONLY path that can
 * produce a non-blank value — there is deliberately no computed path.
 */
export function supplyPortfolioStructure(
  supplied: Partial<PortfolioStructureTerms>,
): PortfolioStructureTerms {
  return { ...BLANK_PORTFOLIO_STRUCTURE, ...supplied };
}

export interface PortfolioAggregation {
  readonly scoredComponents: readonly ScoredComponent[];
  readonly math: RollUpMath;
  readonly rollUpAggregation: RollUpAggregation;
  /** ★ Release / cross-collateral terms — HONEST-BLANK by default (Phase 3).
   *  Only non-blank when a caller passes `portfolioStructure` in options. */
  readonly portfolioStructure: PortfolioStructureTerms;
}

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface AggregateOptions {
  /**
   * Optional whole-loan debt service (annual $). REQUIRED to compute the
   * aggregate DSCR honestly — see DscrBasis. The EX-102 surface does NOT
   * carry it; a caller with the loan-terms doc (rate + amort + whole balance)
   * supplies it. Absent → aggregate DSCR is honest-null.
   */
  readonly wholeLoanDebtService?: number | null;
  /** Optional per-loan identifiers for `constituentLoanIds`. */
  readonly constituentLoanIds?: readonly string[];
  /**
   * ★ Optional HUMAN-SUPPLIED portfolio-structure terms (release provisions,
   * cross-collateralization). ABSENT → all-honest-blank (DATA_NOT_PROVIDED).
   * The aggregator NEVER computes these; a human passes what they read from the
   * loan documents. Use `supplyPortfolioStructure()` to build a partial safely.
   */
  readonly portfolioStructure?: PortfolioStructureTerms;
}

/* ------------------------------------------------------------------ */
/*  Aggregation math                                                   */
/* ------------------------------------------------------------------ */

function sumDefined(xs: ReadonlyArray<number | null>): number | null {
  const present = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (present.length === 0) return null;
  return present.reduce((s, x) => s + x, 0);
}

function computeConcentration(components: readonly PropertyComponent[]): PortfolioConcentration {
  const values = components.map((c) => c.value).filter((v): v is number => typeof v === 'number' && v > 0);
  const totalValue = values.length ? values.reduce((s, v) => s + v, 0) : 0;

  if (totalValue <= 0) {
    return {
      topPropertyValueShare: null,
      topPropertyName: null,
      geographicMixByState: [],
      assetClassMix: [],
      herfindahlIndex: null,
      effectiveProperties: null,
    };
  }

  // Top property.
  let top: PropertyComponent | null = null;
  for (const c of components) {
    if (typeof c.value === 'number' && (top === null || c.value > (top.value ?? 0))) top = c;
  }
  const topPropertyValueShare = top && typeof top.value === 'number' ? top.value / totalValue : null;

  // Grouped mix (value-share, descending). Missing key → 'Unknown'.
  const groupMix = (keyOf: (c: PropertyComponent) => string): ConcentrationSlice[] => {
    const byKey = new Map<string, number>();
    for (const c of components) {
      if (typeof c.value !== 'number' || c.value <= 0) continue;
      const k = keyOf(c);
      byKey.set(k, (byKey.get(k) ?? 0) + c.value);
    }
    return [...byKey.entries()]
      .map(([key, v]) => ({ key, valueShare: v / totalValue }))
      .sort((a, b) => b.valueShare - a.valueShare);
  };

  const geographicMixByState = groupMix((c) => c.state ?? 'Unknown');
  const assetClassMix = groupMix((c) => c.propertyType ?? 'Unknown');

  // Herfindahl over per-property value shares.
  const hhi = values.reduce((s, v) => {
    const share = v / totalValue;
    return s + share * share;
  }, 0);

  return {
    topPropertyValueShare,
    topPropertyName: top?.propertyName ?? null,
    geographicMixByState,
    assetClassMix,
    herfindahlIndex: hhi,
    effectiveProperties: hhi > 0 ? 1 / hhi : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Aggregate a portfolio loan's N components into portfolio-level results.
 *
 * Runs `evaluateDeal()` verbatim per component, then computes the roll-up
 * math. Populates `rollUpAggregation` with the computed count + a
 * methodology/normalization note, and HONEST-BLANKS the judgment cells.
 */
export function aggregatePortfolio(
  components: readonly PropertyComponent[],
  opts: AggregateOptions = {},
): PortfolioAggregation {
  /* (1) Per-property scoring — evaluateDeal() reused VERBATIM. */
  const scoredComponents: ScoredComponent[] = components.map((c) => {
    const dealBag = componentToDealBag(c);
    const evaluation = evaluateDeal(dealBag);
    const ratedRisk = evaluation.rating.ratedRisk;
    return {
      ordinal: c.ordinal,
      componentId: c.componentId,
      propertyName: c.propertyName,
      dealBag,
      evaluation,
      finalScore: ratedRisk === null ? null : (1 - ratedRisk) * 100,
      ratedRisk,
      band: evaluation.rating.band,
      recommendation: evaluation.rating.recommendation,
    };
  });

  /* (2) Roll-up math — the sourceable cells. */
  const blendedValue = sumDefined(components.map((c) => c.value));
  const aggregateNoi = sumDefined(components.map((c) => c.noi));
  const aggregateNcf = sumDefined(components.map((c) => c.ncf));

  // ★ RECOMMENDED blended-cap basis: value-weighted (ΣNOI / Σvalue). See the
  // basis discussion in the report — this is the only weighting that
  // reproduces the PSB rollup row's cap (5.80%) to the basis point.
  const blendedCapRate =
    blendedValue !== null && blendedValue > 0 && aggregateNoi !== null
      ? aggregateNoi / blendedValue
      : null;

  // ★ Aggregate DSCR — only against a whole-loan debt service (pari-passu trap).
  const ds = opts.wholeLoanDebtService;
  const dscrBasis: DscrBasis =
    typeof ds === 'number' && Number.isFinite(ds) && ds > 0
      ? { kind: 'whole-loan-debt-service', debtService: ds }
      : {
          kind: 'not-derivable',
          reason:
            'EX-102 carries per-property NCF but no per-property loan piece; the parent ' +
            'roll-up loan figure is the TRUST PIECE (pari-passu), not the whole loan. The ' +
            'whole-loan debt service the issuer DSCR is computed against is not in the ' +
            'source surface — supply wholeLoanDebtService to derive DSCR.',
        };
  const aggregateDscr =
    dscrBasis.kind === 'whole-loan-debt-service' && aggregateNcf !== null
      ? aggregateNcf / dscrBasis.debtService
      : null;

  const concentration = computeConcentration(components);

  // ★ Whole-loan balance = Σ per-property allocated loan amount (Phase A — human-
  //   supplied). Enables portfolio LTV + debt yield that the EX-102 source could not.
  //   Absent (no allocations supplied) → honest-null, no guessed denominator.
  const wholeLoanBalance = sumDefined(components.map((c) => c.allocatedLoanAmount ?? null));
  const portfolioLtv =
    wholeLoanBalance !== null && blendedValue !== null && blendedValue > 0
      ? wholeLoanBalance / blendedValue
      : null;
  const portfolioDebtYield =
    wholeLoanBalance !== null && wholeLoanBalance > 0 && aggregateNoi !== null
      ? aggregateNoi / wholeLoanBalance
      : null;

  const math: RollUpMath = {
    loanCount: components.length,
    blendedValue,
    aggregateNoi,
    aggregateNcf,
    blendedCapRate,
    aggregateDscr,
    dscrBasis,
    wholeLoanBalance,
    portfolioLtv,
    portfolioDebtYield,
    concentration,
  };

  /* (3) rollUpAggregation — computed count + methodology; judgment cells
   *     HONEST-BLANK. The numeric portfolio aggregates flow via AdjustedInputs
   *     per the contract; this metadata block describes HOW they were combined
   *     and honest-blanks what the source cannot support. */
  const constituentLoanIds =
    opts.constituentLoanIds && opts.constituentLoanIds.length > 0
      ? [...opts.constituentLoanIds]
      : components.map((c) => c.componentId).filter((id): id is string => id !== null);

  const rollUpAggregation: RollUpAggregation = {
    loanCount: components.length,
    // Sourceable: the aggregation is deterministic; state the basis explicitly.
    aggregationMethodology:
      'Value-weighted roll-up: blended value = Σ per-property value; blended cap = ΣNOI ÷ Σvalue; ' +
      'aggregate DSCR = ΣNCF ÷ whole-loan debt service. Concentration (top-property share, ' +
      'geographic/asset-class mix, Herfindahl) computed over per-property value shares. ' +
      'Cross-collateralization terms, release provisions, and portfolio market view are ' +
      'DATA_NOT_PROVIDED — not carried in the EX-102 source surface.',
    // No cross-portfolio normalization was applied (single asset class / single
    // state here); state that honestly rather than fabricate a normalization.
    normalizationCommentary: 'DATA_NOT_PROVIDED',
    constituentLoanIds,
  };

  /* (4) Portfolio-structure terms — HONEST-BLANK by default. Only non-blank
   *     when a human supplied them via options; never computed/fabricated. */
  const portfolioStructure = opts.portfolioStructure ?? BLANK_PORTFOLIO_STRUCTURE;

  return { scoredComponents, math, rollUpAggregation, portfolioStructure };
}
