/**
 * DoctrineRules — full v1 enumeration of every rule id referenced by the doctrine ruleset.
 *
 * Adding a rule means adding a literal here. Removing a rule causes every reference to fail
 * compilation — that is the whole point. Same applies to renames.
 *
 * Frozen for `DOCTRINE_VERSION = '1.0'`. A future v2 rule registry lives in a sibling module
 * (`rules.v2.ts`); this file is append-only-safe but never edit-in-place once shipped.
 */

export const DoctrineRules = {
  // §1 data quality — missing-doc penalties
  RENT_ROLL_MISSING:                    'RENT_ROLL_MISSING',
  T12_MISSING:                          'T12_MISSING',
  LOAN_TERMS_MISSING:                   'LOAN_TERMS_MISSING',
  PCA_MISSING:                          'PCA_MISSING',
  APPRAISAL_MISSING:                    'APPRAISAL_MISSING',

  // §1 distrust penalties — source-tier choice
  SELLER_UW_USED_WHEN_ACTUAL_EXISTS:    'SELLER_UW_USED_WHEN_ACTUAL_EXISTS',
  ASR_USED_WHEN_PRIMARY_EXISTS:         'ASR_USED_WHEN_PRIMARY_EXISTS',

  // §4 mechanical metrics
  DSCR_LEVEL:                           'DSCR_LEVEL',
  DEBT_YIELD_LEVEL:                     'DEBT_YIELD_LEVEL',
  LTV_LEVEL:                            'LTV_LEVEL',

  // §5 durability of cash flow
  UW_VS_T12_NOI_RECONCILIATION:         'UW_VS_T12_NOI_RECONCILIATION',
  TENANT_CONCENTRATION:                 'TENANT_CONCENTRATION',
  ROLLOVER_WITHIN_TERM:                 'ROLLOVER_WITHIN_TERM',

  // §6 normalization quality
  VACANCY_FLOOR_VS_HISTORY:             'VACANCY_FLOOR_VS_HISTORY',
  EXPENSE_GROWTH_REALISM:               'EXPENSE_GROWTH_REALISM',

  // §7 capitalization adequacy
  PCA_IMMEDIATE_REPAIRS_COVERED:        'PCA_IMMEDIATE_REPAIRS_COVERED',
  TI_LC_VS_ROLLOVER:                    'TI_LC_VS_ROLLOVER',

  // §8 term / maturity
  TERM_DSCR_BUFFER:                     'TERM_DSCR_BUFFER',
  REFI_FEASIBILITY_STRESSED:            'REFI_FEASIBILITY_STRESSED',

  // §9 valuation guardrails (evaluated by the valuation engine; flagged here for traceability)
  NO_VALUE_ABOVE_PRIMARY_ANCHOR:        'NO_VALUE_ABOVE_PRIMARY_ANCHOR',
  EXIT_CAP_MUST_NOT_BE_AGGRESSIVE:      'EXIT_CAP_MUST_NOT_BE_AGGRESSIVE',
  SINGLE_TENANT_DARK_VALUE_HAIRCUT:     'SINGLE_TENANT_DARK_VALUE_HAIRCUT',

  // §11 asset-type adjusters
  OFFICE_LOW_QUALITY_CLASS:             'OFFICE_LOW_QUALITY_CLASS',
  OFFICE_SHADOW_VACANCY:                'OFFICE_SHADOW_VACANCY',
  MALL_DY_BELOW_MIN:                    'MALL_DY_BELOW_MIN',
  HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM: 'HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM',
  HOTEL_PIP_UNDERSIZED:                 'HOTEL_PIP_UNDERSIZED',
  STORAGE_DY_BELOW_FLOOR:               'STORAGE_DY_BELOW_FLOOR',
  STORAGE_DSCR_BELOW_TARGET:            'STORAGE_DSCR_BELOW_TARGET',
  MHC_PRIVATE_WASTEWATER_RISK:          'MHC_PRIVATE_WASTEWATER_RISK',
  MHC_HIGH_PARK_OWNED_HOMES:            'MHC_HIGH_PARK_OWNED_HOMES',

  // §12 score adjuster (final ±25 envelope)
  FALSE_NEGATIVE_GUARD:                 'FALSE_NEGATIVE_GUARD',
  FALSE_POSITIVE_GUARD:                 'FALSE_POSITIVE_GUARD',
} as const;

export type DoctrineRuleId = (typeof DoctrineRules)[keyof typeof DoctrineRules];
