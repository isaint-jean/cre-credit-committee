/**
 * flag-categories — RENDER-TIME classification of engine signals into memo buckets.
 *
 * The engine emits a FLAT list of flags / findings with no due-diligence-vs-financial
 * category (recon: the taxonomy is keyed by credit methodology, not report intent).
 * This registry classifies a signal id (a doctrine dimension id, a JE_ rule id, a
 * doctrine flag / reason code) into a memo bucket so the memo can LEAD with
 * due-diligence red flags and DEMOTE financial-metric flags to a secondary block.
 *
 * ★ DISPLAY-ONLY. Nothing here feeds the mint / doctrine hash — it is consulted at
 *   memo render time. Unmapped ids default to 'other' (a due-diligence bucket) —
 *   a signal is NEVER dropped; it always renders somewhere.
 */

export type FlagCategory =
  | 'reconciliation' // things not tying out (NOI divergence, cross-check)
  | 'capex'          // cap-ex exposure / physical (PCA repairs, reserves)
  | 'sponsor'        // sponsor quality / external DD
  | 'data_quality'   // missing / unreliable / substituted data
  | 'financial_metric' // DSCR / LTV / debt-yield / refi / cap-rate / durability
  | 'other';         // qualitative credit risk (tenant, rollover, asset resilience) — DD by default

/** Due-diligence buckets LEAD the memo; only 'financial_metric' is DEMOTED. */
export function isDueDiligence(c: FlagCategory): boolean {
  return c !== 'financial_metric';
}

/** Human sub-headings for the categories (memo section rendering). */
export const CATEGORY_LABEL: Readonly<Record<FlagCategory, string>> = {
  reconciliation:   'Reconciliation / figures not tying out',
  capex:            'Cap-ex & physical condition',
  sponsor:          'Sponsor',
  data_quality:     'Data quality — missing / unreliable',
  financial_metric: 'Financial-metric risks',
  other:            'Other due-diligence concerns',
};

/** The 9 canonical doctrine DIMENSION ids (CleanDoctrineFinding.dimensionId) → bucket. */
const DIMENSION_CATEGORY: Readonly<Record<string, FlagCategory>> = {
  'sponsor-borrower-quality':  'sponsor',
  'income-concentration':      'other', // tenant concentration — qualitative DD
  'rollover':                  'other', // lease rollover — qualitative DD
  'asset-class':               'other', // property-type resilience — qualitative DD
  'leverage-ltv':              'financial_metric',
  'coverage-dscr':             'financial_metric',
  'debt-yield':                'financial_metric',
  'refinance-feasibility':     'financial_metric',
  'cap-rate-valuation-stress': 'financial_metric',
};

/** Known JE_ rule ids / doctrine flags / reason codes → bucket (reused across the memo). */
const FLAG_CATEGORY: Readonly<Record<string, FlagCategory>> = {
  // reconciliation / tie-out
  JE_NOI_BELOW_TRAILING_ACTUAL: 'reconciliation',
  JE_NOI_DIVERGES_FROM_ASR:     'reconciliation',
  UW_VS_T12_NOI_RECONCILIATION: 'reconciliation',
  // cap-ex / physical
  JE_PCA_MISSING:                            'capex',
  CAPEX_SHORTFALL:                           'capex',
  TILC_UNFUNDED_HIGH_ROLLOVER:               'capex',
  JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED: 'capex',
  // data quality / missing
  JE_RENT_ROLL_MISSING:        'data_quality',
  JE_TRAILING_ACTUALS_MISSING: 'data_quality',
  JE_IN_PLACE_MISSING:         'data_quality',
  JE_APPRAISAL_MISSING:        'data_quality',
  JE_LOAN_TERMS_MISSING:       'data_quality',
  INSUFFICIENT_DATA:           'data_quality',
  // financial-metric
  DSCR_LEVEL:            'financial_metric',
  LTV_LEVEL:             'financial_metric',
  DEBT_YIELD_LEVEL:      'financial_metric',
  MATURITY_REFI_RISK_HIGH: 'financial_metric',
  UW_ABOVE_T12_AGGRESSIVE: 'financial_metric',
};

/**
 * Classify a signal id into a memo bucket. Handles doctrine dimension ids AND
 * flag / reason-code ids, with family-prefix fallbacks. Unknown → 'other' (a
 * due-diligence bucket) so a signal is never dropped.
 */
export function flagCategory(id: string): FlagCategory {
  if (id in DIMENSION_CATEGORY) return DIMENSION_CATEGORY[id]!;
  if (id in FLAG_CATEGORY) return FLAG_CATEGORY[id]!;
  const u = id.toUpperCase();
  if (/PCA_REPAIRS_|CAPEX|REPLACEMENT_RESERVES|IMMEDIATE_REPAIRS|TILC/.test(u)) return 'capex';
  if (/RECONCIL|NOI.*(DIVERG|BELOW_TRAILING)|OTHER_INCOME_RECOVERED/.test(u)) return 'reconciliation';
  if (/SPONSOR/.test(u)) return 'sponsor';
  if (/_MISSING$|_DEFAULTED$|SUBSTITUTED|INSUFFICIENT|_UNKNOWN$|NO_FLOOR/.test(u)) return 'data_quality';
  if (/^JE_CAP_|DSCR|LTV|DEBT_YIELD|REFI|LEVERAGE|COVERAGE|CAP_RATE|OVERVALUATION|EXIT_CAP/.test(u)) return 'financial_metric';
  return 'other'; // never dropped — renders on the due-diligence side by default
}
