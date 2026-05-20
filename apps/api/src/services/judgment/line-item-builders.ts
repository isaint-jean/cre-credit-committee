/**
 * Per-line-item builders for the judgment engine (Batch 3c1).
 *
 * Each builder is a thin function that:
 *   1. Reads the line item's source-tier cascade from extraction (3b)
 *   2. Picks the highest-available tier (3b's `pickFirstNonNull`)
 *   3. Looks up library/benchmark substitution + bank floor (3b's library-lookup)
 *   4. Calls the appropriate 3a helper (`adjustSubstituteOnly` / `adjustWithFloor`) with
 *      pre-resolved inputs
 *   5. Returns `AdjustedLineItem`
 *
 * Builders shipped in 3c1 cover the canonical patterns (Pattern 1 substitute-only,
 * Pattern 2 substitute-with-floor, Pattern 3 substitute-with-no-library). Pattern 4 (derived)
 * and Pattern 5 (not-applicable) need orchestrator context (other adjusted line items, asset
 * profile applicability) and ship in 3c2.
 *
 * v1.0 builders included:
 *   - vacancyPct          (Pattern 2)
 *   - capRate             (Pattern 1, substitution-only per audit §15.9)
 *   - grossRentalIncome   (Pattern 3, no library)
 *   - otherIncome         (Pattern 3)
 *   - loanAmount          (Pattern 3, no fallback — throws if missing)
 *   - interestRate        (Pattern 1, with MarketBenchmarks fallback)
 *   - termMonths          (Pattern 3)
 */

import type {
  AdjustedLineItem,
  AssetProfile,
  ExtractionResult,
  JudgmentEngineRuleId,
  LibrarySnapshot,
  MarketBenchmarks,
} from '@cre/contracts';
import {
  adjustSubstituteOnly,
  adjustWithFloor,
  buildNotApplicableLineItem,
  buildDerivedLineItem,
  requireRaw,
} from './line-item-helpers.js';
import {
  capRateCascade,
  pickFirstNonNull,
  vacancyPctCascade,
  type SourceCandidate,
} from './source-cascade.js';
import { getLibraryMedian } from './library-lookup.js';
import { computeMonthsBetween } from './date-math.js';
import { annualDebtService, maturityBalance } from './amortization.js';
import { JudgmentEngineError } from './errors.js';

/* --------------------------- substitution helper -------------------------- */

/**
 * Pick the substitution value AND the rule id together (Batch 6.2 audit U11). Library is the
 * primary source (n≥20); MarketBenchmark is the degraded fallback (n<20). Distinct rule ids
 * propagate the provenance to doctrine so its data_confidence component can weight them.
 *
 * Returns `value: null` only when BOTH sources are null — caller passes that to
 * adjustSubstituteOnly / adjustWithFloor which then throw via insufficientDataMessage.
 */
function pickSubstitution(args: {
  readonly library: number | null;
  readonly benchmark: number | null;
  readonly libraryRuleId: JudgmentEngineRuleId;
  readonly benchmarkRuleId: JudgmentEngineRuleId;
  readonly metricLabel: string;
}): {
  readonly value: number | null;
  readonly ruleId: JudgmentEngineRuleId;
  readonly reason: string;
} {
  if (args.library !== null) {
    return {
      value: args.library,
      ruleId: args.libraryRuleId,
      reason: `${args.metricLabel} null; substituted from library median (${args.library})`,
    };
  }
  if (args.benchmark !== null) {
    return {
      value: args.benchmark,
      ruleId: args.benchmarkRuleId,
      reason: `${args.metricLabel} null; substituted from market benchmark (${args.benchmark}) [library degraded n<20]`,
    };
  }
  return {
    value: null,
    ruleId: args.libraryRuleId, // unreachable — caller throws insufficientDataMessage
    reason: 'unreachable',
  };
}

/* --------------------------------- vacancyPct ------------------------------- */

/**
 * Pattern 2 — substitute, then raise to max(library median, bank vacancy).
 * Library median + market benchmark fallback for substitution; sellerUw vacancy as bank floor.
 */
export function buildVacancyPct(args: {
  readonly extraction: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly marketBenchmarks: MarketBenchmarks;
  readonly assetProfile: AssetProfile;
}): AdjustedLineItem {
  const picked = pickFirstNonNull(vacancyPctCascade(args.extraction));

  const libraryMedian = getLibraryMedian(
    args.librarySnapshot,
    args.assetProfile.propertyType,
    'vacancy',
  );
  const benchmarkVacancy = args.marketBenchmarks.vacancyRates[args.assetProfile.propertyType];

  // Batch 6.2 (audit U11): emit DISTINCT rule ids for library-backed vs benchmark-degraded
  // substitution. Doctrine's data_confidence component weights them differently — a benchmark
  // substitution implies the library distribution had n<20 for this asset type.
  const substitution = pickSubstitution({
    library: libraryMedian,
    benchmark: benchmarkVacancy,
    libraryRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
    benchmarkRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK',
    metricLabel: 'vacancy',
  });

  const bankFloor = args.extraction.sellerUw?.underwrittenVacancy ?? null;

  return adjustWithFloor({
    raw: picked.value,
    extractionSource: picked.tier,
    substitutionValue: substitution.value,
    substitutionRuleId: substitution.ruleId,
    substitutionReason: substitution.reason,
    insufficientDataMessage: 'JE_VACANCY_SUBSTITUTION_IMPOSSIBLE: no library or benchmark vacancy for asset type',
    libraryFloor: libraryMedian,
    libraryFloorRuleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN',
    libraryFloorReason: `vacancy raised to library median (${libraryMedian})`,
    bankFloor,
    bankFloorRuleId: 'JE_VACANCY_RAISED_TO_BANK',
    bankFloorReason: `vacancy raised to bank UW vacancy (${bankFloor})`,
  });
}

/* ----------------------------------- capRate -------------------------------- */

/**
 * Pattern 1 — substitution only (audit §15.9). Cap rate is the most-volatile valuation
 * assumption; raising raw cap rates upward to library median heavily understates value.
 * Library serves as fallback only.
 */
export function buildCapRate(args: {
  readonly extraction: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly marketBenchmarks: MarketBenchmarks;
  readonly assetProfile: AssetProfile;
}): AdjustedLineItem {
  const picked = pickFirstNonNull(capRateCascade(args.extraction));

  const libraryMedian = getLibraryMedian(
    args.librarySnapshot,
    args.assetProfile.propertyType,
    'capRate',
  );
  const benchmarkCapRate = args.marketBenchmarks.capRates[args.assetProfile.propertyType];

  // Batch 6.2 (audit U11): distinct rule ids for library-backed vs benchmark-degraded substitution.
  const substitution = pickSubstitution({
    library: libraryMedian,
    benchmark: benchmarkCapRate,
    libraryRuleId: 'JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY',
    benchmarkRuleId: 'JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK',
    metricLabel: 'cap rate',
  });

  return adjustSubstituteOnly({
    raw: picked.value,
    extractionSource: picked.tier,
    substitutionValue: substitution.value,
    substitutionRuleId: substitution.ruleId,
    substitutionReason: substitution.reason,
    insufficientDataMessage: 'JE_CAP_RATE_SUBSTITUTION_IMPOSSIBLE: no library or benchmark cap rate for asset type',
  });
}

/* ----------------------------- grossRentalIncome ---------------------------- */

/**
 * Pattern 3 — no library distribution exists for gross rental income (deal-specific). T-12
 * preferred over rent-roll-derived (sum of in-place rents × 12) over seller UW. If all are
 * null, throws — the missing-doc penalty already fired upstream.
 */
export function buildGrossRentalIncome(args: {
  readonly extraction: ExtractionResult;
}): AdjustedLineItem {
  const candidates: SourceCandidate[] = [];

  if (args.extraction.t12 !== null) {
    candidates.push({
      tier: 'T12_ACTUAL',
      value: args.extraction.t12.income.grossPotentialRent,
    });
  }
  if (args.extraction.rentRoll !== null) {
    // Sum of in-place rents × 12 (annualized)
    const sum = args.extraction.rentRoll.units.reduce<number>((acc, u) => {
      if (u.inPlaceRentMonthly !== null) return acc + u.inPlaceRentMonthly;
      return acc;
    }, 0);
    const annualized = sum * 12;
    candidates.push({
      tier: 'RENT_ROLL',
      value: sum > 0 ? annualized : null,
    });
  }

  const picked = pickFirstNonNull(candidates);

  return requireRaw({
    raw: picked.value,
    extractionSource: picked.tier,
    insufficientDataMessage: 'JE_GROSS_RENTAL_INCOME_MISSING: no T-12 or rent-roll-derived value',
  });
}

/* ---------------------------------- otherIncome ----------------------------- */

/**
 * Pattern 3 — non-rental income. Defaults to 0 if extraction reports null (treating "not
 * present" as "no other income," which is the most-conservative default — under-recognizing
 * income lowers NOI). Distinct from the substitution path: this is a domain-aware default
 * for an inherently-optional field.
 */
export function buildOtherIncome(args: {
  readonly extraction: ExtractionResult;
}): AdjustedLineItem {
  const t12Value = args.extraction.t12?.income.otherIncome ?? null;
  const raw = t12Value;

  if (raw === null) {
    // Batch 6.2.1 (audit U9): explicit MANUAL-default emission. The conservative default of 0
    // is correct (under-recognizing income lowers NOI), but doctrine cannot see the
    // synthesized-vs-extracted distinction without a named rule. Emit JE_OTHER_INCOME_DEFAULTED
    // so data_confidence registers the substitution.
    return {
      raw: null,
      adjusted: 0,
      source: 'MANUAL',
      adjustments: [{
        ruleId: 'JE_OTHER_INCOME_DEFAULTED',
        delta: 0,
        reason: 'Other income missing from T-12; defaulted to 0 (conservative — under-recognizes income).',
      }],
    };
  }

  return {
    raw,
    adjusted: raw,
    source: 'T12_ACTUAL',
    adjustments: [],
  };
}

/* ----------------------------------- loanAmount ----------------------------- */

/**
 * Pattern 3 — loan amount has no library/benchmark substitution path. If LoanTerms is missing,
 * the engine throws (the missing-doc penalty for LoanTerms already fired in confidence
 * reduction; the line item itself cannot synthesize a value).
 */
export function buildLoanAmount(args: {
  readonly extraction: ExtractionResult;
}): AdjustedLineItem {
  const raw = args.extraction.loanTerms?.loanAmount ?? null;

  return requireRaw({
    raw,
    extractionSource: 'BANK',
    insufficientDataMessage: 'JE_LOAN_AMOUNT_MISSING: loan terms not provided',
  });
}

/* --------------------------------- interestRate ----------------------------- */

/**
 * Pattern 1 — interest rate has a market-benchmark fallback (`baseRate`) when LoanTerms is
 * missing. Substitution emits `JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK`.
 */
export function buildInterestRate(args: {
  readonly extraction: ExtractionResult;
  readonly marketBenchmarks: MarketBenchmarks;
}): AdjustedLineItem {
  const raw = args.extraction.loanTerms?.interestRate ?? null;

  return adjustSubstituteOnly({
    raw,
    extractionSource: 'BANK',
    substitutionValue: args.marketBenchmarks.interestRateAssumptions.baseRate,
    substitutionRuleId: 'JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK',
    substitutionReason: `interest rate null; substituted from market benchmark base rate (${args.marketBenchmarks.interestRateAssumptions.baseRate})`,
    insufficientDataMessage: 'JE_INTEREST_RATE_SUBSTITUTION_IMPOSSIBLE: no benchmark base rate',
  });
}

/* ----------------------------------- termMonths ----------------------------- */

/**
 * Pattern 3 — loan term in months. Reads from LoanTerms.amortization (typical)? No, that's
 * amortization. termMonths is the maturity duration. Architecture pre-supposes LoanTerms
 * supplies this. If LoanTerms is missing, throws.
 *
 * Note: `LoanTermsExtraction` doesn't have an explicit `termMonths` field today — the contract
 * has `amortization` (months), `interestOnlyPeriod` (months), and `maturityDate` (date).
 * `termMonths` is computed from `maturityDate - analysisAsOfDate` if present. This builder
 * returns the value or throws.
 */
export function buildTermMonths(args: {
  readonly extraction: ExtractionResult;
  readonly analysisAsOfDate: string;
}): AdjustedLineItem {
  const maturityDate = args.extraction.loanTerms?.maturityDate ?? null;
  const raw = maturityDate !== null ? computeMonthsBetween(args.analysisAsOfDate, maturityDate) : null;

  return requireRaw({
    raw,
    extractionSource: 'BANK',
    insufficientDataMessage: 'JE_TERM_MONTHS_MISSING: maturity date not provided in loan terms',
  });
}

/* ============================ Batch 3c2a additions ============================ */

/* ----------------------------- concessionsPct ------------------------------ */

/**
 * Pattern 5 — applicable iff Multifamily/Hotel. Otherwise adjusted=0 (real zero, no penalty).
 * If applicable + raw null → substitute conservatively from a small default (no library
 * distribution exists for concessions). v1.0 default: 0.02 (2% of gross rent).
 */
export function buildConcessionsPct(args: {
  readonly extraction: ExtractionResult;
  readonly applicable: boolean;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();

  // Batch 6.2.1 (audit U7): when a unit has null `concessions` OR null `inPlaceRentMonthly`,
  // skip the unit entirely rather than silently summing 0. The legacy `?? 0` understated the
  // total rent denominator AND inflated the apparent concession ratio. The orchestrator emits
  // JE_RENT_ROLL_UNIT_INCOMPLETE separately when any unit is incomplete.
  let raw: number | null = null;
  if (args.extraction.rentRoll) {
    let totalConc = 0;
    let totalRent = 0;
    let completeUnits = 0;
    for (const u of args.extraction.rentRoll.units) {
      if (u.concessions === null || u.inPlaceRentMonthly === null) continue;
      totalConc += u.concessions;
      totalRent += u.inPlaceRentMonthly;
      completeUnits++;
    }
    raw = completeUnits > 0 && totalRent > 0 ? totalConc / totalRent : null;
  }

  return adjustSubstituteOnly({
    raw,
    extractionSource: 'RENT_ROLL',
    substitutionValue: 0.02,
    substitutionRuleId: 'JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT',
    substitutionReason: 'concessions null; default 2%',
    insufficientDataMessage: 'JE_CONCESSIONS_SUBSTITUTION_IMPOSSIBLE',
  });
}

/* ---------------------------- effectiveGrossIncome ------------------------- */

/**
 * Pattern 4 — derived. EGI = (gri.adjusted + otherIncome.adjusted) × (1 - vacancy - concessions).
 */
export function buildEffectiveGrossIncome(args: {
  readonly extraction: ExtractionResult;
  readonly grossRentalIncome: AdjustedLineItem;
  readonly otherIncome: AdjustedLineItem;
  readonly vacancyPct: AdjustedLineItem;
  readonly concessionsPct: AdjustedLineItem;
}): AdjustedLineItem {
  const totalIncome = args.grossRentalIncome.adjusted + args.otherIncome.adjusted;

  // Batch 6.2.1 (audit U8): explicit range check on vacancy + concessions. Sum > 1 OR < 0 is
  // an impossible occupancy composite (upstream contract violation). Throwing refuses to
  // manufacture EGI from fabricated economics — silently clamping at [0, 1] (the legacy
  // behavior) would produce plausible-but-false numbers downstream.
  const lossFactor = args.vacancyPct.adjusted + args.concessionsPct.adjusted;
  if (lossFactor < 0 || lossFactor > 1) {
    throw new JudgmentEngineError({
      code: 'JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE',
      context: {
        vacancy: args.vacancyPct.adjusted,
        concessions: args.concessionsPct.adjusted,
        sum: lossFactor,
        message: 'Upstream produced an impossible occupancy composite. Refusing to manufacture EGI.',
      },
    });
  }
  const computed = totalIncome * (1 - lossFactor);
  return buildDerivedLineItem({
    rawFromExtraction: args.extraction.t12?.income.effectiveRent ?? null,
    extractionSource: 'T12_ACTUAL',
    computedAdjusted: computed,
  });
}

/* ------------------------------ expense sub-lines -------------------------- */

function buildExpenseSubLine(args: {
  readonly raw: number | null;
}): AdjustedLineItem {
  // Path A (audit §E.1, §E.3): if T-12 sub-line missing, default to 0 with MANUAL source.
  // The library substitution applies to totalOperatingExpenses, not individual sub-lines.
  if (args.raw === null) return buildNotApplicableLineItem();
  return {
    raw: args.raw,
    adjusted: args.raw,
    source: 'T12_ACTUAL',
    adjustments: [],
  };
}

export function buildRealEstateTaxes(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  return buildExpenseSubLine({ raw: args.extraction.t12?.expenses.taxes ?? null });
}
export function buildInsurance(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  return buildExpenseSubLine({ raw: args.extraction.t12?.expenses.insurance ?? null });
}
export function buildUtilities(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  return buildExpenseSubLine({ raw: args.extraction.t12?.expenses.utilities ?? null });
}
export function buildManagementFee(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  return buildExpenseSubLine({ raw: args.extraction.t12?.expenses.managementFees ?? null });
}
export function buildMaintenance(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  return buildExpenseSubLine({ raw: args.extraction.t12?.expenses.repairsMaintenance ?? null });
}
export function buildOtherExpenses(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  // T-12 doesn't break out 'other' — return 0 unless explicitly tracked.
  return buildNotApplicableLineItem();
}

/**
 * Pattern 5 — payroll applicable iff Hotel/MHC/Multifamily. Otherwise 0.
 */
export function buildPayroll(args: {
  readonly extraction: ExtractionResult;
  readonly applicable: boolean;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();
  // Payroll typically baked into management/maintenance for office/retail; for applicable
  // types, T-12 may track separately. v1.0: read from T-12 if present (sometimes encoded
  // under 'utilities' or 'maintenance'); else 0.
  return buildNotApplicableLineItem();
}

/**
 * Pattern 4 / Path A — totalOperatingExpenses.
 *
 * If T-12 totalOperatingExpenses is non-null: use it directly.
 * If T-12 is missing entirely: substitute via `library.expenseRatio.median × adjustedEgi`
 * (Path A from audit §E.1). Substitution rule fires.
 * If both T-12 missing and library degraded for asset type AND no benchmark → throws.
 */
export function buildTotalOperatingExpenses(args: {
  readonly extraction: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly assetProfile: AssetProfile;
  readonly effectiveGrossIncome: AdjustedLineItem;
}): AdjustedLineItem {
  const t12 = args.extraction.t12;
  const t12Total = t12?.expenses.totalOperatingExpenses ?? null;
  const egi = args.effectiveGrossIncome.adjusted;

  // Step 1: derive a raw adjusted value (T-12 → sum-of-sub-lines → library substitution).
  let raw: number | null = null;
  let initialAdjusted: number;
  let source: 'T12_ACTUAL' | 'MANUAL' = 'MANUAL';
  const adjustments: { ruleId: 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY' | 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN' | 'JE_EXPENSE_RAISED_TO_BANK' | 'JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE'; delta: number; reason: string }[] = [];

  if (t12Total !== null) {
    raw = t12Total;
    initialAdjusted = t12Total;
    source = 'T12_ACTUAL';
  } else if (t12 !== null) {
    const e = t12.expenses;
    const subLines = [e.taxes, e.insurance, e.utilities, e.repairsMaintenance, e.managementFees];
    const presentValues = subLines.filter((v): v is number => v !== null);
    if (presentValues.length > 0) {
      raw = null;
      initialAdjusted = presentValues.reduce((a, b) => a + b, 0);
      source = 'T12_ACTUAL';
    } else {
      // No sub-lines either → fall through to library substitution
      const libRatio = getLibraryMedian(args.librarySnapshot, args.assetProfile.propertyType, 'expenseRatio');
      if (libRatio === null) {
        throw new Error('JE_EXPENSE_RATIO_SUBSTITUTION_IMPOSSIBLE: no library expense ratio for asset type');
      }
      raw = null;
      initialAdjusted = libRatio * egi;
      source = 'MANUAL';
      adjustments.push({
        ruleId: 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY',
        delta: initialAdjusted,
        reason: `T-12 missing; substituted via library expense ratio (${libRatio}) × adjusted EGI`,
      });
    }
  } else {
    const libRatio = getLibraryMedian(args.librarySnapshot, args.assetProfile.propertyType, 'expenseRatio');
    if (libRatio === null) {
      throw new Error('JE_EXPENSE_RATIO_SUBSTITUTION_IMPOSSIBLE: no library expense ratio for asset type');
    }
    raw = null;
    initialAdjusted = libRatio * egi;
    source = 'MANUAL';
    adjustments.push({
      ruleId: 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY',
      delta: initialAdjusted,
      reason: `T-12 missing; substituted via library expense ratio (${libRatio}) × adjusted EGI`,
    });
  }

  // Step 2: apply library/bank expense-ratio floor (architecture §6 conservatism).
  //
  // Batch 6.2 (audit U12): explicit null handling — distinguish "no floor data" from "floor of
  // 0%". When both library distribution (n<20) and T-12 are missing, the floor cannot be
  // enforced. Emit an INFORMATIONAL adjustment (delta 0) with JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE
  // so the audit trail captures the missing-data state. The orchestrator separately adds
  // JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE to dataQualityFlags so doctrine's data_confidence
  // component reads the flag.
  if (egi > 0) {
    const libRatio = getLibraryMedian(args.librarySnapshot, args.assetProfile.propertyType, 'expenseRatio');
    const bankEgi = t12?.income.totalIncome ?? null;
    const bankOpex = t12?.expenses.totalOperatingExpenses ?? null;
    const bankRatio = bankEgi !== null && bankOpex !== null && bankEgi > 0 ? bankOpex / bankEgi : null;
    if (libRatio === null && bankRatio === null) {
      adjustments.push({
        ruleId: 'JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE',
        delta: 0,
        reason: 'No library distribution (n<20) and no T-12 — expense-ratio floor not enforceable.',
      });
    } else {
      const effectiveLib = libRatio ?? 0;
      const effectiveBank = bankRatio ?? 0;
      const floor = Math.max(effectiveLib, effectiveBank) * egi;
      if (initialAdjusted < floor - 1e-9) {
        const useLib = effectiveLib >= effectiveBank;
        adjustments.push({
          ruleId: useLib ? 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN' : 'JE_EXPENSE_RAISED_TO_BANK',
          delta: floor - initialAdjusted,
          reason: useLib
            ? `expenses raised to library expense ratio (${effectiveLib}) × EGI`
            : `expenses raised to bank expense ratio (${effectiveBank.toFixed(4)}) × EGI`,
        });
        initialAdjusted = floor;
      }
    }
  }

  return {
    raw,
    adjusted: initialAdjusted,
    source,
    adjustments,
  };
}

/* ----------------------------- capital reserves ---------------------------- */

export function buildUpfrontCapex(args: {
  readonly extraction: ExtractionResult;
  readonly applicable: boolean;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();
  // Applicability predicate ensures pca.immediateRepairs > 0; raw is that value.
  const raw = args.extraction.pca?.immediateRepairs ?? null;
  return requireRaw({
    raw,
    extractionSource: 'PCA',
    insufficientDataMessage: 'JE_UPFRONT_CAPEX_MISSING: applicability says yes but PCA missing',
  });
}

export function buildUpfrontTiLc(args: { readonly applicable: boolean }): AdjustedLineItem {
  // v1.0: zero if not applicable; full reserve sizing logic lives in v1.1.
  return buildNotApplicableLineItem();
}

export function buildMonthlyCapex(args: {
  readonly applicable: boolean;
  readonly effectiveGrossIncome: AdjustedLineItem;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();
  // v1.0 default: 0.20% of EGI / month.
  // Batch 6.2.1 (audit U9): emit JE_MONTHLY_CAPEX_DEFAULTED so doctrine sees the synthesized value.
  const monthly = args.effectiveGrossIncome.adjusted * 0.002 / 12;
  return {
    raw: null,
    adjusted: monthly,
    source: 'MANUAL',
    adjustments: [{
      ruleId: 'JE_MONTHLY_CAPEX_DEFAULTED',
      delta: monthly,
      reason: 'No PCA capex schedule; defaulted to v1.0 0.20%/yr of EGI (industry-typical reserve).',
    }],
  };
}

export function buildMonthlyTiLc(args: { readonly applicable: boolean }): AdjustedLineItem {
  return buildNotApplicableLineItem();
}

export function buildPcaImmediateRepairs(args: {
  readonly extraction: ExtractionResult;
  readonly applicable: boolean;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();
  const raw = args.extraction.pca?.immediateRepairs ?? null;
  return raw !== null
    ? { raw, adjusted: raw, source: 'PCA', adjustments: [] }
    : buildNotApplicableLineItem();
}

/* ---------------------------------- loan sub-fields ------------------------ */

export function buildAmortizationMonths(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  const raw = args.extraction.loanTerms?.amortization ?? null;
  return requireRaw({
    raw,
    extractionSource: 'BANK',
    insufficientDataMessage: 'JE_AMORTIZATION_MISSING: loan terms not provided',
  });
}

export function buildIoPeriodMonths(args: {
  readonly extraction: ExtractionResult;
  readonly applicable: boolean;
}): AdjustedLineItem {
  if (!args.applicable) return buildNotApplicableLineItem();
  const raw = args.extraction.loanTerms?.interestOnlyPeriod ?? null;
  return requireRaw({
    raw,
    extractionSource: 'BANK',
    insufficientDataMessage: 'JE_IO_PERIOD_MISSING: applicability says yes but value missing',
  });
}

export function buildMaturityBalance(args: {
  readonly loanAmount: AdjustedLineItem;
  readonly interestRate: AdjustedLineItem;
  readonly amortizationMonths: AdjustedLineItem;
  readonly termMonths: AdjustedLineItem;
}): AdjustedLineItem {
  const computed = maturityBalance({
    loanAmount: args.loanAmount.adjusted,
    interestRate: args.interestRate.adjusted,
    amortizationMonths: args.amortizationMonths.adjusted,
    termMonths: args.termMonths.adjusted,
  });
  return buildDerivedLineItem({
    rawFromExtraction: null,
    extractionSource: 'MANUAL',
    computedAdjusted: computed,
  });
}

export function buildDebtServiceAnnual(args: {
  readonly loanAmount: AdjustedLineItem;
  readonly interestRate: AdjustedLineItem;
  readonly amortizationMonths: AdjustedLineItem;
}): AdjustedLineItem {
  const computed = annualDebtService({
    loanAmount: args.loanAmount.adjusted,
    interestRate: args.interestRate.adjusted,
    amortizationMonths: args.amortizationMonths.adjusted,
  });
  return buildDerivedLineItem({
    rawFromExtraction: null,
    extractionSource: 'MANUAL',
    computedAdjusted: computed,
  });
}

/* ------------------------------- assumptions ------------------------------- */

/**
 * Pattern 1 — substitute from library; fallback to capRate.adjusted + 50bps if no library
 * entry (audit §E.5).
 */
export function buildTerminalCapRate(args: {
  readonly extraction: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly assetProfile: AssetProfile;
  readonly capRate: AdjustedLineItem;
}): AdjustedLineItem {
  // No direct extraction source — terminal cap rate is typically not extracted as a
  // separate field. Use sellerUw if available (not currently in our contract); else
  // substitute.
  const libraryMedian = getLibraryMedian(args.librarySnapshot, args.assetProfile.propertyType, 'capRate');
  // Batch 6.2 (audit U10): emit DISTINCT rule ids for the two paths. Library + 50bps is the
  // primary substitution; spot + 50bps is the weaker fallback (only fires when library is
  // degraded). Doctrine's data_confidence component scores the spot path more harshly.
  let substitutionValue: number;
  let substitutionRuleId: JudgmentEngineRuleId;
  let substitutionReason: string;
  if (libraryMedian !== null) {
    substitutionValue = libraryMedian + 0.005;
    substitutionRuleId = 'JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD';
    substitutionReason = `terminal cap rate substituted from library median + 50bps (${substitutionValue})`;
  } else {
    substitutionValue = args.capRate.adjusted + 0.005;
    substitutionRuleId = 'JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD';
    substitutionReason = `terminal cap rate substituted from spot cap + 50bps (${substitutionValue}) [library degraded]`;
  }
  return adjustSubstituteOnly({
    raw: null,
    extractionSource: 'MANUAL',
    substitutionValue,
    substitutionRuleId,
    substitutionReason,
    insufficientDataMessage: 'JE_TERMINAL_CAP_RATE_SUBSTITUTION_IMPOSSIBLE',
  });
}

/**
 * Pattern 3 with v1.0 default — rent growth from sellerUw or 3% conservative default
 * (audit §E.6).
 */
export function buildRentGrowthPct(args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  const raw = args.extraction.sellerUw?.underwrittenRentGrowth ?? null;
  if (raw !== null) {
    return { raw, adjusted: raw, source: 'SELLER_UW', adjustments: [] };
  }
  // Batch 6.2.1 (audit U9): emit JE_RENT_GROWTH_DEFAULTED so doctrine sees the synthesized value.
  return {
    raw: null,
    adjusted: 0.03,
    source: 'MANUAL',
    adjustments: [{
      ruleId: 'JE_RENT_GROWTH_DEFAULTED',
      delta: 0.03,
      reason: 'Rent growth not in seller UW; defaulted to v1.0 conservative 3%/yr.',
    }],
  };
}

/**
 * Pattern 3 with v1.0 default — expense growth: 3% default (audit §E.6).
 */
export function buildExpenseGrowthPct(_args: { readonly extraction: ExtractionResult }): AdjustedLineItem {
  // Batch 6.2.1 (audit U9): emit JE_EXPENSE_GROWTH_DEFAULTED so doctrine sees the synthesized value.
  return {
    raw: null,
    adjusted: 0.03,
    source: 'MANUAL',
    adjustments: [{
      ruleId: 'JE_EXPENSE_GROWTH_DEFAULTED',
      delta: 0.03,
      reason: 'No expense-growth source in extraction; defaulted to v1.0 conservative 3%/yr.',
    }],
  };
}
