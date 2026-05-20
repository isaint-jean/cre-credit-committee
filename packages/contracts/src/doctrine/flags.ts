/**
 * DoctrineFlags — frozen v1 enumeration of every flag emitted by the doctrine evaluator OR
 * pre-stamped by the valuation engine into `ValuationConclusion.capsApplied[].reason` /
 * `haircutsApplied[].reason`.
 *
 * Flags are categorical, not free text. New flags require a new entry here AND a corresponding
 * entry in `DoctrineReasonCodes` (paired explainability).
 */

export const DoctrineFlags = {
  // §5 durability
  UW_ABOVE_T12_AGGRESSIVE:                  'UW_ABOVE_T12_AGGRESSIVE',
  TENANT_CONCENTRATION_HIGH:                'TENANT_CONCENTRATION_HIGH',
  ROLLOVER_TERM_HIGH:                       'ROLLOVER_TERM_HIGH',

  // §6 normalization
  VACANCY_UNDERSTATED:                      'VACANCY_UNDERSTATED',
  EXPENSES_UNDERSTATED:                     'EXPENSES_UNDERSTATED',

  // §7 capitalization
  CAPEX_SHORTFALL:                          'CAPEX_SHORTFALL',
  TILC_UNFUNDED_HIGH_ROLLOVER:              'TILC_UNFUNDED_HIGH_ROLLOVER',

  // §8 maturity
  MATURITY_REFI_RISK_HIGH:                  'MATURITY_REFI_RISK_HIGH',

  // §9 valuation guardrails (stamped by valuation engine, read by doctrine)
  OVERVALUATION_GUARDRAIL_TRIGGERED:        'OVERVALUATION_GUARDRAIL_TRIGGERED',
  EXIT_CAP_TOO_TIGHT:                       'EXIT_CAP_TOO_TIGHT',
  SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED: 'SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED',

  // §11 asset-type adjusters
  OFFICE_LOW_QUALITY_CLASS:                 'OFFICE_LOW_QUALITY_CLASS',
  OFFICE_SHADOW_VACANCY:                    'OFFICE_SHADOW_VACANCY',
  MALL_DY_BELOW_MIN:                        'MALL_DY_BELOW_MIN',
  HOTEL_FLAG_EXPIRATION_TERM:               'HOTEL_FLAG_EXPIRATION_TERM',
  HOTEL_PIP_UNDERSIZED:                     'HOTEL_PIP_UNDERSIZED',
  STORAGE_DY_BELOW_FLOOR:                   'STORAGE_DY_BELOW_FLOOR',
  STORAGE_DSCR_BELOW_TARGET:                'STORAGE_DSCR_BELOW_TARGET',
  MHC_PRIVATE_WASTEWATER_RISK:              'MHC_PRIVATE_WASTEWATER_RISK',
  MHC_HIGH_PARK_OWNED_HOMES:                'MHC_HIGH_PARK_OWNED_HOMES',

  // generic
  INSUFFICIENT_DATA:                        'INSUFFICIENT_DATA',
} as const;

export type DoctrineFlag = (typeof DoctrineFlags)[keyof typeof DoctrineFlags];
