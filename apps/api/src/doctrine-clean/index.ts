/**
 * doctrine-clean — public entry points.
 *
 * Self-contained. No imports from old doctrine / manifesto modules.
 * Will grow as additional clean dimensions land.
 */
export * from './types.js';
export { evaluateAssetClass, ASSET_CLASS_TIER_DEFINITIONS, ASSET_CLASS_ENUM } from './dimensions/asset-class.js';
export { evaluateRollover, ROLLOVER_BANDS, type RolloverDimensionInput } from './dimensions/rollover.js';
export {
  evaluateCapRateValuationStress,
  ASSET_CAP_RATE_FLOORS,
  VALUATION_AGGRESSIVENESS_BANDS,
  type CapRateValuationStressInput,
} from './dimensions/cap-rate-valuation-stress.js';
export {
  normalizeSustainableCashflow,
  SUSTAINABLE_CASHFLOW_CONVENTIONS,
  type SustainableCashflowInput,
  type SustainableCashflowOutput,
  type NoiDivergenceTrace,
  type VacancyHaircutTrace,
  type NcfCapitalTrace,
} from './normalization/sustainable-cashflow.js';
export {
  evaluateLeverageLtv,
  LEVERAGE_LTV_BANDS,
  type LeverageLtvInput,
} from './dimensions/leverage-ltv.js';
export {
  evaluateCoverageDscr,
  COVERAGE_DSCR_BANDS,
  computeAnnualDebtService,
  type CoverageDscrInput,
} from './dimensions/coverage-dscr.js';
export {
  evaluateDebtYield,
  DEBT_YIELD_ASSET_FLOORS,
  type DebtYieldInput,
} from './dimensions/debt-yield.js';
export {
  evaluateRefinanceFeasibility,
  computeMaturityBalance,
  STRESSED_REFI_CONSTANT_DEFAULT,
  EXIT_DSCR_REFINANCEABLE_THRESHOLD,
  type RefinanceFeasibilityInput,
} from './dimensions/refinance-feasibility.js';
export {
  evaluateIncomeConcentration,
  INCOME_CONCENTRATION_BANDS,
  INCOME_CONCENTRATION_APPLICABLE_TYPES,
  INCOME_CONCENTRATION_NA_TYPES,
  type IncomeConcentrationInput,
} from './dimensions/income-concentration.js';
export {
  evaluateSponsorBorrowerQuality,
  MODIFIER_CAP as SPONSOR_MODIFIER_CAP,
  SPONSOR_FACTOR_WEIGHTS,
  type SponsorAssessment,
  type SponsorBorrowerQualityInput,
  type SponsorFactorRating,
} from './dimensions/sponsor-borrower-quality.js';
export {
  computeBaseBlend,
  BASE_BLEND_SIGNAL_WEIGHTS,
  BASE_BLEND_RATIO_FAMILY_INNER_WEIGHTS,
  BASE_BLEND_PEER_DIMENSION_IDS,
  type BaseBlendSignalId,
  type BaseBlendResult,
  type CoverageRecord,
  type RatioFamilyCollapse,
  type WeightedContribution,
} from './scoring/base-blend.js';
export {
  applyOverrides,
  SEVERE_HIGH_TIER_THRESHOLD,
  SEVERE_FLOOR,
  ELEVATED_PLUS_THRESHOLD,
  CONVERGENCE_TRIGGER_COUNT,
  CONVERGENCE_AMPLIFY_PER_SIGNAL,
  type OverrideResult,
} from './scoring/overrides.js';
export {
  computeRating,
  RATING_BAND_CUTS,
  COVERAGE_RELIABILITY_THRESHOLD,
  SPINE_DIM_ID,
  SPONSOR_DIM_ID,
  type RatingBand,
  type Recommendation,
  type RatingResult,
} from './scoring/rating.js';
export {
  evaluateDeal,
  type DealBag,
  type EvaluateDealResult,
  type DimensionsByName,
} from './scoring/evaluate-deal.js';
export {
  adaptExtractionToDealBag,
  pickIssuerNoi,
  pickConcludedValue,
  pickOccupancy,
  deriveTopTenantShare,
  deriveTenantDataStatus,
  deriveRolloverShare,
  type AdapterOptions,
  type TenantDataStatus,
} from './adapters/extraction-to-dealbag.js';
export {
  bridgeToDoctrineEvaluation,
  type BridgeIds,
  type BridgeVersions,
} from './adapters/dealresult-to-doctrine-evaluation.js';
