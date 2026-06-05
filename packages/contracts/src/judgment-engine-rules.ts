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
 * Frozen for `JUDGMENT_ENGINE_VERSION = '1.5'`. Adding a rule means adding a literal here AND
 * appending an entry to `JUDGMENT_ENGINE_MANIFEST` for hash-drift protection. The naming +
 * literal-union enforcement gives compile-time discrimination across the adjustment ledger.
 */

export const JudgmentEngineRules = {
  // §1 missing-doc penalties — adjust `confidenceReduction`
  JE_RENT_ROLL_MISSING:                          'JE_RENT_ROLL_MISSING',
  /**
   * RENAMED 2026-05-31 from JE_T12_MISSING. The old name fired when
   * extraction.t12 (which actually held In-Place data) was null — i.e., it
   * fired only when the entire seller CF was missing. After the
   * period-classification fix, the rule fires when
   * extraction.t12Actual === null (strict trailing-twelve column absent),
   * which is the case for EVERY deal whose seller CF doesn't expose a
   * separate T-12 column — most CMBS-style CFs today. Until the class-(b)
   * trailing-actuals ingest slot lands, this rule will fire on essentially
   * every deal. That's intentional: it honestly signals "no trailing
   * actuals in the record" rather than borrowing the In-Place column to
   * pretend the gap doesn't exist.
   */
  JE_TRAILING_ACTUALS_MISSING:                   'JE_TRAILING_ACTUALS_MISSING',
  /**
   * Added 2026-05-31. Fires when `extraction.inPlace === null` — i.e., the
   * seller CF carried no In-Place / current column. Distinct from
   * JE_TRAILING_ACTUALS_MISSING (which signals absence of T-12 data) and
   * from a missing CF document entirely (which is now covered by the
   * combination of both flags being null + appraisal/CF kind absent in
   * sourceDocuments). Docks data_confidence at the same weight as the
   * trailing-actuals flag.
   */
  JE_IN_PLACE_MISSING:                           'JE_IN_PLACE_MISSING',
  /**
   * Added 2026-05-31. Informational (delta=0) — fires when an
   * OperatingStatementExtraction slot's `period` label does not match the
   * expected pattern for that slot (e.g., inPlace.period reads "GS U/W"
   * suggesting the extractor classified a column wrong). Surfaces in
   * dataQualityFlags for audit but does NOT dock the data_confidence
   * doctrine score — the slot's data is still consumable; this is a
   * safeguard against silent misclassification.
   */
  JE_PERIOD_LABEL_MISMATCH:                      'JE_PERIOD_LABEL_MISMATCH',
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
  JE_REPLACEMENT_RESERVES_DEFAULTED:                'JE_REPLACEMENT_RESERVES_DEFAULTED',
  JE_TENANT_IMPROVEMENTS_DEFAULTED:                 'JE_TENANT_IMPROVEMENTS_DEFAULTED',
  JE_LEASING_COMMISSIONS_DEFAULTED:                 'JE_LEASING_COMMISSIONS_DEFAULTED',

  // PCA producer ticket — Phase 1+2 ship. Fires when buildUpfrontReplacementReserves
  // synthesizes a 0 default because PCAExtraction.capexScheduleInflated is null
  // (no PCA uploaded, or both PCA AI calls failed). Distinct from
  // JE_REPLACEMENT_RESERVES_DEFAULTED (which fires on absent CF below-NOI line);
  // this one fires on absent PCA capex schedule. Doctrine reads both flags via
  // its data_confidence component.
  JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED:        'JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED',

  // §14 cap-rate stress doctrine v1 (office) — Batch 1.4 (2026-06-05).
  //
  // Scaffolding for the cap-rate stress step (see docs/cap-rate-stress-doctrine-v1.md
  // and the implementation brief). The literals are DEFINED here so the rule registry
  // and hash-drift manifest stay locked, but they are NOT emitted yet — orchestrator
  // wire-up lands in subsequent commits. Each rule (when emitted) will push an
  // AdjustmentEntry to capRate.adjustments[] with a fixed bps delta off the cap base,
  // following the existing line-item-builders.ts adjustment pattern.
  //
  // Tier corrections — bidirectional; de-bias the tier-blind library median. Calibration
  // R²=0.22 against analyst answer key; corrections vs. flat default RMSE 1.16 → 1.00.
  JE_CAP_TIER_GATEWAY:                              'JE_CAP_TIER_GATEWAY',
  JE_CAP_TIER_SECONDARY:                            'JE_CAP_TIER_SECONDARY',
  JE_CAP_TIER_TERTIARY:                             'JE_CAP_TIER_TERTIARY',
  // Risk-stress widening — judgment magnitudes (conservative starting bands).
  // v1 uses the existing 2-value businessPlan enum (Stabilized / LeaseUp_or_Transitional);
  // a 3-bucket widening (value-add @ +50) is deferred to v1.1.
  JE_CAP_STRESS_BUSINESS_PLAN:                      'JE_CAP_STRESS_BUSINESS_PLAN',
  JE_CAP_STRESS_TENANCY_ROLLOVER:                   'JE_CAP_STRESS_TENANCY_ROLLOVER',
  JE_CAP_STRESS_TENANCY_CONCENTRATION:              'JE_CAP_STRESS_TENANCY_CONCENTRATION',
  // Guardrails. CLAMPED_TO_RANGE is mutative (snaps concludedCap to the [4.5%, 12.0%]
  // band and records the snap delta). NET_ADJ_OUT_OF_BAND is informational (delta=0;
  // surfaces in dataQualityFlags when |Σ stress deltas| exceeds 150bps).
  JE_CAP_CLAMPED_TO_RANGE:                          'JE_CAP_CLAMPED_TO_RANGE',
  JE_CAP_NET_ADJ_OUT_OF_BAND:                       'JE_CAP_NET_ADJ_OUT_OF_BAND',
  // Tier-unresolved degraded-state flag (v1.5). Informational (delta=0;
  // surfaces in dataQualityFlags). Fires on Office deals when
  // AssetProfile.marketLiquidity === 'Unknown' — i.e., neither an explicit
  // marketLiquidityHint nor the metro→tier seed table resolved a tier. Honest
  // signal that the doctrine's tier-correction step was skipped for lack of
  // input rather than for doctrinal reasons. Same shape as Phase 6.5
  // degraded-state flags; doctrine's data_confidence component reads it.
  JE_CAP_TIER_UNRESOLVED:                           'JE_CAP_TIER_UNRESOLVED',
} as const;

export type JudgmentEngineRuleId = (typeof JudgmentEngineRules)[keyof typeof JudgmentEngineRules];

/* ---------------------------- penalty weights ---------------------------- */

/**
 * Per-document missing-doc penalty points per architecture contract §1. Applied as a
 * contribution to `AdjustedInputs.confidenceReduction` (after normalizing the sum).
 */
export const JE_MISSING_DOC_PENALTIES = {
  JE_RENT_ROLL_MISSING:        12,
  /**
   * 2026-05-31 rename — penalty weight preserved from the legacy JE_T12_MISSING.
   * Fires on every deal today (no class-(b) ingest slot yet); the weight
   * stays at 12 because the trailing-actual gap remains real even though it's
   * universal. When class-(b) lands, deals carrying a T-12 statement clear
   * the flag and recover the 12 penalty points.
   */
  JE_TRAILING_ACTUALS_MISSING:  12,
  /**
   * Added 2026-05-31. Penalty weight 8 — slightly lower than
   * JE_TRAILING_ACTUALS_MISSING (12) because In-Place absence on a CMBS-style
   * CF is rare and structurally a CF-document gap, whereas trailing-actuals
   * absence is the deal-state-of-the-world today (every-deal universal).
   */
  JE_IN_PLACE_MISSING:           8,
  JE_LOAN_TERMS_MISSING:        10,
  JE_PCA_MISSING:                6,
  JE_APPRAISAL_MISSING:          4,
} as const;

/**
 * Per-rule distrust penalty points per architecture contract §1.
 */
export const JE_DISTRUST_PENALTIES = {
  JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS: 6,
  JE_ASR_USED_WHEN_PRIMARY_EXISTS:      6,
} as const;
