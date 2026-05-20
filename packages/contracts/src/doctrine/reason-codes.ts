/**
 * DoctrineReasonCodes — frozen v1 catalogue of every explainability code that may appear on a
 * `DoctrineComponentScore`, `DoctrineAssetTypeAdjustment`, `DoctrineScoreAdjustment`, or in the
 * `DoctrineEvaluation.reasons[]` projection.
 *
 * NO free text appears in any persisted record. Render-time string lookup translates these codes
 * to display strings (a separate i18n catalogue, not part of contracts).
 *
 * Adding a reason = adding an entry here. Same compile-time enforcement as flags and rules.
 */

export const DoctrineReasonCodes = {
  // §5 UW vs T-12 reconciliation
  UW_BELOW_T12_CONSERVATIVE:                'UW_BELOW_T12_CONSERVATIVE',
  UW_AT_OR_BELOW_T12:                       'UW_AT_OR_BELOW_T12',
  UW_SLIGHTLY_ABOVE_T12:                    'UW_SLIGHTLY_ABOVE_T12',
  UW_AGGRESSIVE_ABOVE_T12:                  'UW_AGGRESSIVE_ABOVE_T12',

  // §5 tenant concentration
  TENANT_CONCENTRATION_LOW:                 'TENANT_CONCENTRATION_LOW',
  TENANT_CONCENTRATION_MODERATE:            'TENANT_CONCENTRATION_MODERATE',
  TENANT_CONCENTRATION_ELEVATED:            'TENANT_CONCENTRATION_ELEVATED',
  TENANT_CONCENTRATION_HIGH:                'TENANT_CONCENTRATION_HIGH',

  // §5 rollover within term
  ROLLOVER_LOW:                             'ROLLOVER_LOW',
  ROLLOVER_MODERATE:                        'ROLLOVER_MODERATE',
  ROLLOVER_ELEVATED:                        'ROLLOVER_ELEVATED',
  ROLLOVER_HIGH:                            'ROLLOVER_HIGH',

  // §6 vacancy normalization
  VACANCY_GE_TRAILING_CONSERVATIVE:         'VACANCY_GE_TRAILING_CONSERVATIVE',
  VACANCY_SLIGHTLY_OPTIMISTIC:              'VACANCY_SLIGHTLY_OPTIMISTIC',
  VACANCY_TOO_LOW_VS_HISTORY:               'VACANCY_TOO_LOW_VS_HISTORY',

  // §6 expense growth realism
  EXPENSES_AT_OR_ABOVE_T12:                 'EXPENSES_AT_OR_ABOVE_T12',
  EXPENSES_SLIGHTLY_BELOW_T12:              'EXPENSES_SLIGHTLY_BELOW_T12',
  EXPENSES_AGGRESSIVELY_BELOW_T12:          'EXPENSES_AGGRESSIVELY_BELOW_T12',

  // §7 PCA reserves coverage
  PCA_REPAIRS_NOT_QUANTIFIED:               'PCA_REPAIRS_NOT_QUANTIFIED',
  PCA_REPAIRS_FULLY_COVERED:                'PCA_REPAIRS_FULLY_COVERED',
  PCA_REPAIRS_PARTIALLY_COVERED:            'PCA_REPAIRS_PARTIALLY_COVERED',
  PCA_REPAIRS_UNDERFUNDED:                  'PCA_REPAIRS_UNDERFUNDED',

  // §7 TI/LC vs rollover
  TILC_NOT_REQUIRED_LOW_ROLLOVER:           'TILC_NOT_REQUIRED_LOW_ROLLOVER',
  TILC_FUNDED_FOR_ROLLOVER:                 'TILC_FUNDED_FOR_ROLLOVER',
  TILC_UNFUNDED_HIGH_ROLLOVER:              'TILC_UNFUNDED_HIGH_ROLLOVER',
  TILC_FUNDED_DEFAULT:                      'TILC_FUNDED_DEFAULT',

  // §8 term DSCR buffer
  TERM_DSCR_STRONG:                         'TERM_DSCR_STRONG',
  TERM_DSCR_ADEQUATE:                       'TERM_DSCR_ADEQUATE',
  TERM_DSCR_THIN:                           'TERM_DSCR_THIN',

  // §8 refi feasibility
  MATURITY_REFI_FEASIBLE:                   'MATURITY_REFI_FEASIBLE',
  MATURITY_REFI_BORDERLINE:                 'MATURITY_REFI_BORDERLINE',
  MATURITY_REFI_INFEASIBLE:                 'MATURITY_REFI_INFEASIBLE',

  // §9 valuation guardrails
  VALUATION_ANCHORED:                       'VALUATION_ANCHORED',
  VALUATION_OVER_ANCHOR_CAPPED:             'VALUATION_OVER_ANCHOR_CAPPED',
  EXIT_CAP_AGGRESSIVE:                      'EXIT_CAP_AGGRESSIVE',
  SINGLE_TENANT_DARK_VALUE_HAIRCUT:         'SINGLE_TENANT_DARK_VALUE_HAIRCUT',

  // §11 asset-type adjusters
  OFFICE_LOW_QUALITY_CLASS:                 'OFFICE_LOW_QUALITY_CLASS',
  OFFICE_SHADOW_VACANCY:                    'OFFICE_SHADOW_VACANCY',
  MALL_DY_BELOW_MIN:                        'MALL_DY_BELOW_MIN',
  HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM:   'HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM',
  HOTEL_PIP_UNDERSIZED:                     'HOTEL_PIP_UNDERSIZED',
  STORAGE_DY_BELOW_FLOOR:                   'STORAGE_DY_BELOW_FLOOR',
  STORAGE_DSCR_BELOW_TARGET:                'STORAGE_DSCR_BELOW_TARGET',
  MHC_PRIVATE_WASTEWATER_RISK:              'MHC_PRIVATE_WASTEWATER_RISK',
  MHC_HIGH_PARK_OWNED_HOMES:                'MHC_HIGH_PARK_OWNED_HOMES',

  // §12 score adjuster
  FALSE_NEG_DURABLE_CASHFLOW:               'FALSE_NEG_DURABLE_CASHFLOW',
  FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED:      'FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED',

  // §1 data quality
  RENT_ROLL_MISSING:                        'RENT_ROLL_MISSING',
  T12_MISSING:                              'T12_MISSING',
  LOAN_TERMS_MISSING:                       'LOAN_TERMS_MISSING',
  PCA_MISSING:                              'PCA_MISSING',
  APPRAISAL_MISSING:                        'APPRAISAL_MISSING',
  SELLER_UW_USED_WHEN_ACTUAL_EXISTS:        'SELLER_UW_USED_WHEN_ACTUAL_EXISTS',
  ASR_USED_WHEN_PRIMARY_EXISTS:             'ASR_USED_WHEN_PRIMARY_EXISTS',

  // generic
  INSUFFICIENT_DATA:                        'INSUFFICIENT_DATA',
} as const;

export type DoctrineReasonCode = (typeof DoctrineReasonCodes)[keyof typeof DoctrineReasonCodes];
