/**
 * JudgmentEngineRules — frozen v1 enumeration of every rule the judgment engine (Stage 4) can
 * fire. Parallel to `DoctrineRules`, but distinct: judgment-engine rules MODIFY AdjustedInputs
 * (raise vacancy, cap NOI, substitute missing values, deduct confidence). Doctrine rules SCORE
 * the resulting state.
 *
 * Naming convention: `JE_*` prefix to disambiguate from `DoctrineRules` entries that share
 * conceptual names (e.g., `RENT_ROLL_MISSING` is a doctrine scoring rule; `JE_RENT_ROLL_MISSING`
 * is the corresponding judgment-engine adjustment rule that fires the confidence penalty).
 *
 * Frozen for `JUDGMENT_ENGINE_VERSION = '1.0'`. Adding a rule means adding a literal here AND
 * appending an entry to `JUDGMENT_ENGINE_MANIFEST` for hash-drift protection. The naming +
 * literal-union enforcement gives compile-time discrimination across the adjustment ledger.
 */

export const JudgmentEngineRules = {
  // §1 missing-doc penalties — adjust `confidenceReduction`
  JE_RENT_ROLL_MISSING:                          'JE_RENT_ROLL_MISSING',
  JE_T12_MISSING:                                'JE_T12_MISSING',
  JE_LOAN_TERMS_MISSING:                         'JE_LOAN_TERMS_MISSING',
  JE_PCA_MISSING:                                'JE_PCA_MISSING',
  JE_APPRAISAL_MISSING:                          'JE_APPRAISAL_MISSING',

  // §1 distrust-tier penalties — applied when a lower-tier source is used despite a higher tier
  // being available
  JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS:          'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS',
  JE_ASR_USED_WHEN_PRIMARY_EXISTS:               'JE_ASR_USED_WHEN_PRIMARY_EXISTS',

  // §6 conservatism normalizations — raise the adjusted value to a conservative floor
  JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN:           'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
  JE_VACANCY_RAISED_TO_BANK:                     'JE_VACANCY_RAISED_TO_BANK',
  JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN:           'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN',
  JE_EXPENSE_RAISED_TO_BANK:                     'JE_EXPENSE_RAISED_TO_BANK',
  JE_NOI_CAPPED_TO_BANK:                         'JE_NOI_CAPPED_TO_BANK',

  // §4 library-relative cap-rate normalization (raise cap rate; lower value)
  JE_CAP_RATE_RAISED_TO_LIBRARY_MEDIAN:          'JE_CAP_RATE_RAISED_TO_LIBRARY_MEDIAN',

  // §8 missing-data substitution — `raw === null` triggers substitution from library/benchmark.
  // Library distribution is the primary source (n≥20); MarketBenchmarks is the degraded fallback (n<20).
  // Batch 6.2 — provenance split: library and benchmark now emit distinct rule ids so doctrine's
  // data_confidence component can weight them differently (audit U11).
  JE_VACANCY_SUBSTITUTED_FROM_LIBRARY:              'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
  JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK:     'JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK',
  JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY:        'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY',
  JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY:             'JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY',
  JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK:    'JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK',
  JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK:      'JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK',
  JE_DSCR_SUBSTITUTED_FROM_LIBRARY:                 'JE_DSCR_SUBSTITUTED_FROM_LIBRARY',
  JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT:          'JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT',

  // §9 terminal-cap-rate cascade — Batch 6.2 (audit U10).
  // Provenance split: spread-from-library is preferable to spread-from-spot (latter fires when
  // library is degraded AND no other source is available). Distinct ids let doctrine see the
  // weaker fallback explicitly.
  JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD:    'JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD',
  JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD:       'JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD',

  // §10 explicit degraded-state signals — Batch 6.2 (audit U12, U15, NR4).
  // These rules fire when the new-spine path encounters a degraded condition that previously
  // collapsed silently to a green band. Each is read by doctrine's data_confidence component.
  JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE:              'JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE',
  JE_TILC_APPLICABILITY_UNKNOWN:                    'JE_TILC_APPLICABILITY_UNKNOWN',
  JE_CONSERVATISM_GATE_NO_FLOOR_DATA:               'JE_CONSERVATISM_GATE_NO_FLOOR_DATA',

  // §11 incomplete-input signals — Batch 6.2.1 (audit U7, U18).
  // Fires when rent-roll has any unit with null `inPlaceRentMonthly` or null `concessions`.
  // Aggregations that consume the rent roll skip those units explicitly and emit this flag
  // so doctrine's data_confidence component sees the under-counting risk.
  JE_RENT_ROLL_UNIT_INCOMPLETE:                     'JE_RENT_ROLL_UNIT_INCOMPLETE',

  // §12 impossible composite — Batch 6.2.1 (audit U8). Fires (via JudgmentEngineError, not
  // dataQualityFlags) when vacancyPct.adjusted + concessionsPct.adjusted falls outside [0, 1].
  // This is an upstream contract violation; the pipeline refuses to manufacture EGI from an
  // impossible occupancy composite.
  JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE:         'JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE',

  // §13 MANUAL-default emissions — Batch 6.2.1 (audit U9).
  // When a builder synthesizes a v1.0 conservative default for a missing input, an
  // AdjustmentEntry is emitted so doctrine sees that the value was synthesized (vs extracted).
  // Confidence reduction is NOT enforced via JE_MISSING_DOC_PENALTIES because the default
  // is not a missing-document — it's a missing field within a present document. Doctrine's
  // data_confidence component reads these flags and applies a smaller per-default penalty.
  JE_OTHER_INCOME_DEFAULTED:                        'JE_OTHER_INCOME_DEFAULTED',
  JE_RENT_GROWTH_DEFAULTED:                         'JE_RENT_GROWTH_DEFAULTED',
  JE_EXPENSE_GROWTH_DEFAULTED:                      'JE_EXPENSE_GROWTH_DEFAULTED',
  JE_MONTHLY_CAPEX_DEFAULTED:                       'JE_MONTHLY_CAPEX_DEFAULTED',
} as const;

export type JudgmentEngineRuleId = (typeof JudgmentEngineRules)[keyof typeof JudgmentEngineRules];

/* ---------------------------- penalty weights ---------------------------- */

/**
 * Per-document missing-doc penalty points per architecture contract §1. Applied as a
 * contribution to `AdjustedInputs.confidenceReduction` (after normalizing the sum).
 */
export const JE_MISSING_DOC_PENALTIES = {
  JE_RENT_ROLL_MISSING:  12,
  JE_T12_MISSING:        12,
  JE_LOAN_TERMS_MISSING: 10,
  JE_PCA_MISSING:         6,
  JE_APPRAISAL_MISSING:   4,
} as const;

/**
 * Per-rule distrust penalty points per architecture contract §1.
 */
export const JE_DISTRUST_PENALTIES = {
  JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS: 6,
  JE_ASR_USED_WHEN_PRIMARY_EXISTS:      6,
} as const;
