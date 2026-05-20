/**
 * Doctrine reason catalogue (i18n).
 *
 * Maps each `DoctrineReasonCode` to a single English display string. Render layer reads this
 * for explainability projection — the bounded reason codes on `DoctrineEvaluation.reasons[]`
 * resolve to display strings here.
 *
 * Presentation layer, not contract. Lives on the api side, not in `@cre/contracts`. No
 * `analysisAsOfDate`, no replay implications. Adding a code (with a doctrine version bump on the
 * contracts side) requires adding a string here — type system enforces completeness via
 * `Record<DoctrineReasonCode, string>`.
 *
 * Tone: institutional credit-committee voice. Short. No emojis. No punctuation drama.
 */

import { DoctrineReasonCodes } from '@cre/contracts';
import type { DoctrineReasonCode } from '@cre/contracts';

export const DOCTRINE_REASON_CATALOGUE: { readonly [K in DoctrineReasonCode]: string } = {
  // §5 UW vs T-12 reconciliation
  UW_BELOW_T12_CONSERVATIVE:                'Underwriting NOI is more than 10% below trailing T-12 — conservative posture.',
  UW_AT_OR_BELOW_T12:                       'Underwriting NOI is at or below trailing T-12.',
  UW_SLIGHTLY_ABOVE_T12:                    'Underwriting NOI is slightly above trailing T-12 (within 5%).',
  UW_AGGRESSIVE_ABOVE_T12:                  'Underwriting NOI exceeds trailing T-12 by more than 10% — aggressive.',

  // §5 tenant concentration
  TENANT_CONCENTRATION_LOW:                 'Top tenant represents 20% or less of income.',
  TENANT_CONCENTRATION_MODERATE:            'Top tenant represents 20–30% of income.',
  TENANT_CONCENTRATION_ELEVATED:            'Top tenant represents 30–40% of income.',
  TENANT_CONCENTRATION_HIGH:                'Top tenant exceeds 40% of income.',

  // §5 rollover within term
  ROLLOVER_LOW:                             '15% or less of income expires within loan term.',
  ROLLOVER_MODERATE:                        '15–30% of income expires within loan term.',
  ROLLOVER_ELEVATED:                        '30–45% of income expires within loan term.',
  ROLLOVER_HIGH:                            'More than 45% of income expires within loan term.',

  // §6 vacancy normalization
  VACANCY_GE_TRAILING_CONSERVATIVE:         'Underwriting vacancy is at or above trailing — conservative.',
  VACANCY_SLIGHTLY_OPTIMISTIC:              'Underwriting vacancy is slightly below trailing (within 3 percentage points).',
  VACANCY_TOO_LOW_VS_HISTORY:               'Underwriting vacancy is materially below trailing — optimistic.',

  // §6 expense growth realism
  EXPENSES_AT_OR_ABOVE_T12:                 'Underwriting expenses at or above trailing T-12.',
  EXPENSES_SLIGHTLY_BELOW_T12:              'Underwriting expenses slightly below T-12 (within 3%).',
  EXPENSES_AGGRESSIVELY_BELOW_T12:          'Underwriting expenses materially below T-12 — aggressive.',

  // §7 PCA reserves coverage
  PCA_REPAIRS_NOT_QUANTIFIED:               'PCA immediate repairs not quantified.',
  PCA_REPAIRS_FULLY_COVERED:                'Upfront reserves cover PCA immediate repairs in full.',
  PCA_REPAIRS_PARTIALLY_COVERED:            'Upfront reserves cover at least 70% of PCA immediate repairs.',
  PCA_REPAIRS_UNDERFUNDED:                  'Upfront reserves cover less than 70% of PCA immediate repairs.',

  // §7 TI/LC vs rollover
  TILC_NOT_REQUIRED_LOW_ROLLOVER:           'Rollover at or below 15% — TI/LC reserves not required.',
  TILC_FUNDED_FOR_ROLLOVER:                 'Rollover above 15% with TI/LC reserves funded.',
  TILC_UNFUNDED_HIGH_ROLLOVER:              'Rollover above 30% with no TI/LC reserves.',
  TILC_FUNDED_DEFAULT:                      'TI/LC posture acceptable for rollover profile.',

  // §8 term DSCR buffer
  TERM_DSCR_STRONG:                         'DSCR at or above 1.25x — strong term coverage.',
  TERM_DSCR_ADEQUATE:                       'DSCR between 1.10x and 1.25x — adequate term coverage.',
  TERM_DSCR_THIN:                           'DSCR below 1.10x — thin term coverage.',

  // §8 refi feasibility
  MATURITY_REFI_FEASIBLE:                   'Stressed LTV at or below 70% at maturity — refi feasible.',
  MATURITY_REFI_BORDERLINE:                 'Stressed LTV between 70% and 85% at maturity — borderline refi.',
  MATURITY_REFI_INFEASIBLE:                 'Stressed LTV above 85% at maturity — refi unlikely without paydown.',

  // §9 valuation guardrails
  VALUATION_ANCHORED:                       'Underwritten value is within 1.20x of the primary anchor.',
  VALUATION_OVER_ANCHOR_CAPPED:             'Underwritten value exceeded 1.20x of anchor — capped at 1.10x.',
  EXIT_CAP_AGGRESSIVE:                      'Exit cap rate is below the appraisal cap rate.',
  SINGLE_TENANT_DARK_VALUE_HAIRCUT:         'Single-tenant exposure: 50% dark-value haircut applied.',

  // §11 asset-type adjusters
  OFFICE_LOW_QUALITY_CLASS:                 'Class B or C office — quality penalty applied.',
  OFFICE_SHADOW_VACANCY:                    'Shadow vacancy detected in the office submarket.',
  MALL_DY_BELOW_MIN:                        'Mall debt yield below 13% — below minimum threshold.',
  HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM:   'Hotel franchise agreement expires within loan term.',
  HOTEL_PIP_UNDERSIZED:                     'Hotel PIP budget below $15,000 per key threshold.',
  STORAGE_DY_BELOW_FLOOR:                   'Self-storage debt yield below 8% floor.',
  STORAGE_DSCR_BELOW_TARGET:                'Self-storage DSCR below 1.30x target.',
  MHC_PRIVATE_WASTEWATER_RISK:              'Manufactured housing community on private wastewater system.',
  MHC_HIGH_PARK_OWNED_HOMES:                'Manufactured housing community has more than 20% park-owned homes.',

  // §12 score adjuster
  FALSE_NEG_DURABLE_CASHFLOW:               'Mechanical metrics weak but cash flow durable and valuation disciplined.',
  FALSE_POS_AGGRESSIVE_OR_UNDERFUNDED:      'Aggressive assumptions or capital shortfall outweigh positive component scores.',

  // §1 data quality — missing-doc penalties
  RENT_ROLL_MISSING:                        'Rent roll not provided.',
  T12_MISSING:                              'Trailing 12-month financials not provided.',
  LOAN_TERMS_MISSING:                       'Loan term sheet not provided.',
  PCA_MISSING:                              'Property condition assessment not provided.',
  APPRAISAL_MISSING:                        'Appraisal not provided.',

  // §1 distrust penalties
  SELLER_UW_USED_WHEN_ACTUAL_EXISTS:        'Seller underwriting used as primary source despite available actuals.',
  ASR_USED_WHEN_PRIMARY_EXISTS:             'ASR used as primary source despite higher-tier evidence available.',

  // generic
  INSUFFICIENT_DATA:                        'Insufficient data to evaluate.',
};

/**
 * Lookup helper. Returns the catalogue string for a code.
 *
 * Type system guarantees the lookup always finds an entry — `code: DoctrineReasonCode` is a
 * literal-union member, and the catalogue is `Record<DoctrineReasonCode, string>`.
 */
export function reasonString(code: DoctrineReasonCode): string {
  return DOCTRINE_REASON_CATALOGUE[code];
}

/**
 * Runtime completeness assertion. Catches the (compile-time-illegal) edge case where someone
 * uses `as` casts to bypass the type system. Boot the api with this assertion to surface drift
 * early; called from `apps/api/src/util/doctrine-boot-check.ts` (or similar) if extended.
 */
export function assertReasonCatalogueComplete(): void {
  for (const code of Object.values(DoctrineReasonCodes)) {
    const s = DOCTRINE_REASON_CATALOGUE[code];
    if (typeof s !== 'string' || s.length === 0) {
      throw new Error(`DOCTRINE_REASON_CATALOGUE missing or empty entry for code='${code}'`);
    }
  }
}
