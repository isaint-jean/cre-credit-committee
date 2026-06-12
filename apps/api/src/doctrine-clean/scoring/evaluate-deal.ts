/**
 * doctrine-clean / scoring / evaluate-deal.ts
 *
 * THE PUBLIC API — one end-to-end callable.
 *
 * Wires the doctrine-clean pieces into a single deal-evaluation
 * pipeline. Takes the deal inputs (+ optional operator-supplied
 * sponsor assessment) and returns a RatingResult + all 9 dimension
 * contributions + the sustainable-cashflow normalization output.
 *
 * SCOPE:
 *   - Pure orchestration. No new doctrine, no new thresholds, no new
 *     rules. Every signal traces to a doctrine-clean piece already
 *     built and provenance-traced.
 *   - Respects the dependency DAG:
 *       normalization → dim 7 → dim 1 + dim 4 (consume spine outputs)
 *       normalization → dim 2 + dim 3 (consume sustainable NCF / NOI)
 *       independent: dim 5 + dim 6 + dim 8
 *       dim 9: optional HITL — universally inert on corpus
 *       scoring: base-blend → overrides → rating
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old orchestrator / old scorer. Wiring derived from
 * doctrine-clean signatures only.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';
import { normalizeSustainableCashflow, type SustainableCashflowOutput } from '../normalization/sustainable-cashflow.js';
import { evaluateCapRateValuationStress } from '../dimensions/cap-rate-valuation-stress.js';
import { evaluateLeverageLtv } from '../dimensions/leverage-ltv.js';
import { evaluateCoverageDscr } from '../dimensions/coverage-dscr.js';
import { evaluateDebtYield } from '../dimensions/debt-yield.js';
import { evaluateRefinanceFeasibility } from '../dimensions/refinance-feasibility.js';
import { evaluateRollover } from '../dimensions/rollover.js';
import { evaluateIncomeConcentration } from '../dimensions/income-concentration.js';
import { evaluateAssetClass } from '../dimensions/asset-class.js';
import { evaluateSponsorBorrowerQuality, type SponsorAssessment } from '../dimensions/sponsor-borrower-quality.js';
import { computeBaseBlend, type BaseBlendResult } from './base-blend.js';
import { applyOverrides, type OverrideResult } from './overrides.js';
import { computeRating, type RatingResult } from './rating.js';

/**
 * The deal-bag input shape. Mirrors the corpus AnswerKeyRecord +
 * optional extension fields (amortMonths/ioYears/termYears, market
 * tier, top-N tenant shares) that future extractor work will surface.
 * Every field is nullable to match the 3-state doctrine; dims route
 * to HITL when their required inputs are absent.
 */
export interface DealBag {
  /* Identity (echoed; not consumed by scoring) */
  readonly propertyName: string | null;

  /* Structural / asset-class inputs */
  readonly assetType: string | null;
  readonly subType: string | null;

  /* Capital structure */
  readonly loanAmount: number | null;
  readonly coupon: number | null;
  readonly concludedValue: number | null;

  /* Cashflow inputs */
  readonly uwY1Noi: number | null;
  readonly t12Noi: number | null;
  readonly underwrittenOccupancy: number | null;

  /* Tenant-table inputs */
  readonly largestTenantPct: number | null;
  readonly largestTenantBasis: 'NRA' | 'base-rent' | 'unknown';
  readonly pctIncomeExpiringWithinTerm: number | null;
  readonly tenantDataStatus:
    | 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null;

  /* Amortization inputs (extractor surfaces these in future work) */
  readonly amortMonths: number | null;
  readonly ioYears: number | null;
  readonly termYears: number | null;

  /* Optional refinements */
  readonly marketTier?: 'Primary' | 'Secondary' | 'Tertiary' | 'Unknown' | null;
  readonly stressedRefiConstant?: number | null;
  readonly topNTenantShares?: readonly number[];
}

/**
 * Per-dimension contribution map. The orchestrator exposes each peer
 * dim by its canonical id (matching dimensionId on each DimensionContribution),
 * so downstream consumers (narrative, red-flag rendering, UI) can
 * address dims without scanning the array.
 */
export interface DimensionsByName {
  readonly capRateValuationStress: DimensionContribution;     // dim 7
  readonly leverageLtv: DimensionContribution;                // dim 1
  readonly coverageDscr: DimensionContribution;               // dim 2
  readonly debtYield: DimensionContribution;                  // dim 3
  readonly refinanceFeasibility: DimensionContribution;       // dim 4
  readonly incomeConcentration: DimensionContribution;        // dim 5
  readonly rollover: DimensionContribution;                   // dim 6
  readonly assetClass: DimensionContribution;                 // dim 8
  readonly sponsorBorrowerQuality: DimensionContribution;     // dim 9
}

export interface EvaluateDealResult {
  readonly rating: RatingResult;
  readonly baseBlend: BaseBlendResult;
  readonly overrides: OverrideResult;
  readonly normalization: SustainableCashflowOutput;
  readonly dimensions: DimensionsByName;
  /** Flat list of all 9 contributions, in canonical order. */
  readonly allDimensions: readonly DimensionContribution[];
}

/**
 * Evaluate a deal end-to-end. Pure function; no I/O, no global state.
 *
 *   evaluateDeal(deal)                       — sponsor inert (HITL)
 *   evaluateDeal(deal, sponsorAssessment)    — sponsor modifier applied
 */
export function evaluateDeal(
  deal: DealBag,
  sponsorAssessment: SponsorAssessment | null = null,
): EvaluateDealResult {
  /* (1) NORMALIZATION — sustainable NCF / NOI. */
  const normalization = normalizeSustainableCashflow({
    assetType: deal.assetType,
    subType: deal.subType,
    uwY1Noi: deal.uwY1Noi,
    t12Noi: deal.t12Noi,
    underwrittenOccupancy: deal.underwrittenOccupancy,
  });

  /* (2) SPINE — cap-rate / valuation (dim 7). */
  const capRateValuationStress = evaluateCapRateValuationStress({
    assetType: deal.assetType,
    subType: deal.subType,
    uwY1Noi: deal.uwY1Noi,
    sustainableNcf: normalization.sustainableNcf,
    concludedValue: deal.concludedValue,
    loanAmount: deal.loanAmount,
    marketTier: deal.marketTier ?? 'Unknown',
  });

  const stressedLtv = (capRateValuationStress.derivedOutputs?.stressedLtv as number | undefined | null) ?? null;
  const stressedValue = (capRateValuationStress.derivedOutputs?.stressedValue as number | undefined | null) ?? null;

  /* (3) SPINE-DEPENDENT — LTV (dim 1), refinance (dim 4). */
  const leverageLtv = evaluateLeverageLtv({ stressedLtv });
  const refinanceFeasibility = evaluateRefinanceFeasibility({
    assetType: deal.assetType,
    loanAmount: deal.loanAmount,
    coupon: deal.coupon,
    amortMonths: deal.amortMonths,
    ioYears: deal.ioYears,
    termYears: deal.termYears,
    sustainableNcf: normalization.sustainableNcf,
    sustainableNoi: normalization.sustainableNoi,
    stressedValue,
    stressedRefiConstant: deal.stressedRefiConstant ?? null,
  });

  /* (4) NORMALIZATION-DEPENDENT — DSCR (dim 2), DY (dim 3). */
  const coverageDscr = evaluateCoverageDscr({
    sustainableNcf: normalization.sustainableNcf,
    loanAmount: deal.loanAmount,
    coupon: deal.coupon,
    amortMonths: deal.amortMonths,
    ioYears: deal.ioYears,
    termYears: deal.termYears,
  });
  const debtYield = evaluateDebtYield({
    sustainableNoi: normalization.sustainableNoi,
    loanAmount: deal.loanAmount,
    assetType: deal.assetType,
    subType: deal.subType,
  });

  /* (5) INDEPENDENT — concentration (5), rollover (6), asset-class (8). */
  const incomeConcentration = evaluateIncomeConcentration({
    assetType: deal.assetType,
    largestTenantPct: deal.largestTenantPct,
    largestTenantBasis: deal.largestTenantBasis,
    topNTenantShares: deal.topNTenantShares,
  });
  const rollover = evaluateRollover({
    pctIncomeExpiringWithinTerm: deal.pctIncomeExpiringWithinTerm,
    assetType: deal.assetType,
    tenantDataStatus: deal.tenantDataStatus,
  });
  const assetClass = evaluateAssetClass({
    assetType: deal.assetType,
    subType: deal.subType,
    propertyName: deal.propertyName,
  });

  /* (6) SPONSOR (9) — HITL unless an assessment is provided. */
  const sponsorBorrowerQuality = evaluateSponsorBorrowerQuality({ assessment: sponsorAssessment });

  /* (7) SCORING — base-blend → overrides → rating. */
  const peerContributions: DimensionContribution[] = [
    capRateValuationStress,
    refinanceFeasibility,
    assetClass,
    rollover,
    incomeConcentration,
    leverageLtv,
    coverageDscr,
    debtYield,
  ];
  const baseBlend = computeBaseBlend(peerContributions);
  const overrides = applyOverrides(baseBlend, peerContributions);
  const allContributions: DimensionContribution[] = [
    ...peerContributions,
    sponsorBorrowerQuality,
  ];
  const rating = computeRating(baseBlend, overrides, allContributions);

  /* (8) ASSEMBLE result. */
  const dimensions: DimensionsByName = {
    capRateValuationStress,
    leverageLtv,
    coverageDscr,
    debtYield,
    refinanceFeasibility,
    incomeConcentration,
    rollover,
    assetClass,
    sponsorBorrowerQuality,
  };
  return {
    rating,
    baseBlend,
    overrides,
    normalization,
    dimensions,
    allDimensions: allContributions,
  };
}
