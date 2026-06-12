/**
 * Mitigations doctrine v1 — pure producer core.
 *
 * Metrics-driven (NOT flag-driven, per doctrine v1.2 §0): reads the concluded
 * metrics off `AdjustedInputs.metrics` + the synthesized `UnderwritingModel`,
 * compares against desk targets, sizes the lever, applies it to a CLONE of
 * the uwModel, and recomputes the before/after delta. Fired handbook
 * principles are consulted only to enrich `principleIds` (optional citation).
 *
 * Discipline:
 *   - Pure. No I/O, no store, no graph writes, no clock, no random.
 *   - `structuredClone` the uwModel before mutating — `recalculateFullModel`
 *     mutates inner line-item arrays via shallow copies; deep clone keeps the
 *     producer's input untouched.
 *   - Doctrine §5 guardrails: no empty / immaterial proposals; recalc must
 *     beat before on the target metric; dedupe to the binding constraint;
 *     manual-sizing-required when an input is null; clamp absurdities.
 *
 * Commit 2b: this module only. Wiring (orchestrator, persist, render
 * projection) lives in 2c/2d. `MITIGATION_ENGINE_VERSION` / manifest are
 * NOT shipped here — the producer is exercised in isolation and verified
 * against the math.
 */

import type {
  AdjustedInputs,
  FiredFlag,
  MitigationProposal,
  MitigationTargetMetric,
  RecalcSnapshot,
  RiskReduction,
  Severity,
} from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import { calculateAnnualDebtService, recalculateFullModel } from '@cre/shared';
import type { EvaluateDealResult } from '../../doctrine-clean/index.js';
import { EXIT_DSCR_REFINANCEABLE_THRESHOLD, ASSET_CLASS_ENUM } from '../../doctrine-clean/index.js';

/* ----------------------------- desk constants ----------------------------- */

export interface MitigationDeskConstants {
  /** DSCR target the lever solves toward (e.g., 1.25x). */
  readonly T_DSCR: number;
  /** Debt-yield floor target (decimal, e.g., 0.085 = 8.5%). */
  readonly T_DY: number;
  /**
   * LTV TRIGGER — the breach threshold. Fires the lever when
   * stressedLtv > T_LTV_TRIGGER. Separate from T_LTV_TARGET so the
   * desk can require a cure that goes BELOW the trigger (no
   * just-at-the-edge sizings that re-breach on the slightest move).
   */
  readonly T_LTV_TRIGGER: number;
  /**
   * LTV TARGET — the cure level. When the lever fires, L'_LTV is
   * sized to T_LTV_TARGET × stressedValue (NOT T_LTV_TRIGGER ×
   * stressedValue). Setting T_LTV_TARGET < T_LTV_TRIGGER produces a
   * step-up at the trigger boundary (≈ (T_LTV_TRIGGER − T_LTV_TARGET)
   * × stressedValue at the first fire row), which the desk uses to
   * avoid edge-of-cliff sizings.
   */
  readonly T_LTV_TARGET: number;
  /**
   * Exit-DSCR CURE TARGET — desk knob owned by the LEVER (sizing only).
   *
   * Ownership split (locked desk policy):
   *   - The doctrine owns the BREACH TRIGGER on exit DSCR:
   *     `EXIT_DSCR_REFINANCEABLE_THRESHOLD = 1.20` in
   *     doctrine-clean/dimensions/refinance-feasibility.ts. Dim 4
   *     scores against it; the amortization lever's fire-gate also
   *     reads it. Do not duplicate it here.
   *   - The desk owns the CURE TARGET — the level the lever SIZES TO
   *     when it fires. Setting CURE_TARGET > TRIGGER produces a
   *     cushion: cured loans land above the doctrine's refinanceable
   *     line, not just at it. Mirror of T_LTV_TRIGGER/T_LTV_TARGET.
   *
   * Provenance: operator-judgment. NOT employer-derived.
   */
  readonly T_EXIT_DSCR_CURE_TARGET: number;
  /** Rollover-as-pct-of-income trigger for the TI/LC reserve (decimal). */
  readonly T_ROLLOVER: number;
  /** Reserve sizing multiplier (downtime + TI proxy). */
  readonly COVERAGE_FACTOR: number;
  /** Proposed proceeds cut must exceed this pct of current loan or the
   *  proposal is dropped (no-empty-mitigations guardrail). */
  readonly MATERIALITY_MIN_PROCEEDS_CUT_PCT: number;
}

export const DEFAULT_MITIGATION_DESK: MitigationDeskConstants = {
  T_DSCR: 1.25,
  T_DY: 0.085,
  T_LTV_TRIGGER: 0.70,
  T_LTV_TARGET: 0.68,
  T_EXIT_DSCR_CURE_TARGET: 1.25,
  T_ROLLOVER: 0.20,
  COVERAGE_FACTOR: 0.75,
  MATERIALITY_MIN_PROCEEDS_CUT_PCT: 0.02,
};

/** Sane reserve ceiling (clamped + flagged in the description if it binds). */
export const RESERVE_CAP_USD = 25_000_000;

/* ----------------- require_guaranty desk knobs (v2 lever 2) --------------- */
/*
 * GUARANTY_TIER_TERMS — desk-owned NUMERIC knobs for the recourse +
 * covenant package the guaranty lever emits per tier. Lifted from the
 * original string-literal text so the terms are calibrable instead of
 * baked-in.
 *
 * Ownership split (locked desk policy, mirror of dim-7 / dim-4 patterns):
 *   - The doctrine owns dim 9 (sponsor riskModifier + tier classification).
 *     The lever's 3 modifier-breakpoint knobs (TRIGGER 0.03 / MODERATE 0.10
 *     / SEVERE 0.18) are doctrine-adjacent and stay near the lever.
 *   - The DESK owns what the recourse package LOOKS LIKE once the lever
 *     fires — recourse %, net-worth multiple, liquidity %, burn-off years.
 *     Four tiers (mild / moderate / severe / disqualifying-event), four
 *     numeric knobs each. Recourse percentage is now a single point per
 *     tier (was a range like "25-50%" in the prior string literals); when
 *     Isabelle re-tunes she sets the point.
 *
 * The disqualifying-event entry is a 4th key (NOT a clone of severe): it
 * carries the recourse % the desk wants on a factor-4 Severe (typically
 * 100% — but it's a knob, not a constant). Currently it matches severe on
 * net-worth + liquidity + burn-off; the lever forces this key when dim 9
 * tier === 'disqualifying-event' regardless of net modifier magnitude.
 *
 * BOILERPLATE preserved unchanged in the lever's output text:
 *   - Bad-boy carve-outs (fraud / misrepresentation / bankruptcy filing)
 *   - Springing-recourse provisions on deal underperformance (severe tier)
 *   - LTV / DSCR step-down tests as burn-off preconditions
 * These are structural-term scaffolding the lender insists on every
 * recourse package; calibrating them as numbers would be a category error.
 *
 * Provenance: operator-judgment. NOT employer-derived.
 */
export type GuarantyTierKey = 'mild' | 'moderate' | 'severe' | 'disqualifying-event';

export interface GuarantyTierTerms {
  /** Recourse percentage (single point per tier; 0..1). */
  readonly recoursePct: number;
  /** Guarantor net-worth covenant: minimum NW as a multiple of loan size. */
  readonly netWorthMultiple: number;
  /** Guarantor liquidity covenant: minimum liquidity as % of loan size (0..1). */
  readonly liquidityPct: number;
  /**
   * Burn-off horizon in YEARS of clean performance + covenant compliance
   * before the guaranty can sunset. `null` means no burn-off — guaranty
   * runs through the term.
   */
  readonly burnOffYears: number | null;
}

export const DEFAULT_GUARANTY_TIER_TERMS: Readonly<Record<GuarantyTierKey, GuarantyTierTerms>> = {
  mild:                  { recoursePct: 0.25, netWorthMultiple: 1.0, liquidityPct: 0.05, burnOffYears: 3    },
  moderate:              { recoursePct: 0.50, netWorthMultiple: 1.5, liquidityPct: 0.05, burnOffYears: 5    },
  severe:                { recoursePct: 0.75, netWorthMultiple: 2.0, liquidityPct: 0.10, burnOffYears: null },
  'disqualifying-event': { recoursePct: 1.00, netWorthMultiple: 2.0, liquidityPct: 0.10, burnOffYears: null },
};

/* ----------------- principle-enrichment table (handbook today) ------------ */
// Today's deterministic handbook has these principles whose firing would
// corroborate a metric breach. Coverage is intentionally thin (the recon
// flagged this — see doctrine v1.2 §7 v1.1/open). When the handbook later
// grows generic DSCR/DY/LTV/rollover principles, expand here.
export const PRINCIPLES_BY_METRIC: Record<MitigationTargetMetric, readonly string[]> = {
  dscr:      ['P-IV-SS-4', 'P-IV-OFF-6'],
  debtYield: ['P-IV-SS-3', 'P-IV-RET-5'],
  ltv:       [],
};
export const ROLLOVER_PRINCIPLES: readonly string[] = [];

/**
 * Frozen snapshot of the engine state that defines version 1.x behavior.
 * Boot check hashes this (canonical JSON) and compares against the manifest
 * entry for `MITIGATION_ENGINE_VERSION`. Bumping any of these values changes
 * the hash and requires a new manifest entry under a bumped version.
 */
export function buildMitigationEngineHashSnapshot() {
  return {
    desk: DEFAULT_MITIGATION_DESK,
    reserveCapUsd: RESERVE_CAP_USD,
    principlesByMetric: PRINCIPLES_BY_METRIC,
    rolloverPrinciples: ROLLOVER_PRINCIPLES,
    guarantyTierTerms: DEFAULT_GUARANTY_TIER_TERMS,
  };
}

/* --------------------------------- API ---------------------------------- */

export interface ProduceMitigationsArgs {
  readonly adjustedInputs: AdjustedInputs;
  readonly uwModel: UnderwritingModel;
  readonly firedFlags: readonly FiredFlag[];
  readonly desk?: MitigationDeskConstants;
  /**
   * Mitigant v2 phase 1 (foundation): the clean-doctrine
   * `EvaluateDealResult`, threaded in-memory from
   * `evaluateFromAdjustedInputs`. Optional + readonly. When present, the
   * LTV arm of `reduce_proceeds` sizes against dim 7's `stressedValue`
   * instead of the appraised value ("lend to MY value"). When absent or
   * when dim 7 didn't resolve, the LTV arm falls back to the legacy
   * appraised-value basis — no behavior change. Other arms unchanged.
   */
  readonly dealResult?: EvaluateDealResult;
}

export function produceMitigations(args: ProduceMitigationsArgs): MitigationProposal[] {
  const desk = args.desk ?? DEFAULT_MITIGATION_DESK;
  const proposals: MitigationProposal[] = [];

  const reduceProp = buildReduceProceedsProposal(args.adjustedInputs, args.uwModel, args.firedFlags, desk, args.dealResult);
  if (reduceProp !== null) proposals.push(reduceProp);

  const reserveProp = buildFundReserveProposal(args.adjustedInputs, args.firedFlags, desk);
  if (reserveProp !== null) proposals.push(reserveProp);

  // Mitigant v2 phase 2 lever 1 — refi amortization requirement.
  // Reads dim 4 (refinance-feasibility) from the threaded dealResult.
  // Sizes a target maturity balance so the exit DSCR clears the
  // doctrine's refinanceable threshold at the stressed refi constant.
  const amortProp = buildAmortizationProposal(args.adjustedInputs, args.dealResult, desk);
  if (amortProp !== null) proposals.push(amortProp);

  // Mitigant v2 phase 2 lever 2 — sponsor payment guaranty / partial recourse.
  // Reads dim 9 (sponsor-borrower-quality) from the threaded dealResult.
  // Structural-term lever (no dollar sizing); recourse intensity scales with
  // the sponsor-concern magnitude (riskModifier + factor-4 asymmetry).
  const guarantyProp = buildGuarantyProposal(args.dealResult);
  if (guarantyProp !== null) proposals.push(guarantyProp);

  // Mitigant v2 phase 2 lever 3 — concentration springing cash trap.
  // Reads dim 5 (income-concentration) from the threaded dealResult.
  // HYBRID lever: structural-term springing TRIGGER + dollar-sized trap CAP
  // off concentrated income. Distinct from v1's fund_reserve (rollover →
  // upfront TI/LC escrow); different dim + different mechanism.
  const springingProp = buildSpringingCashTrapProposal(args.adjustedInputs, args.dealResult, desk);
  if (springingProp !== null) proposals.push(springingProp);

  // Mitigant v2 phase 2 lever 4 — asset-class in-place lockbox.
  // Reads dim 8 (asset-class) from the threaded dealResult. Constant
  // (NOT springing) hard lockbox + asset-tailored reserve when the asset
  // class itself is the risk (Tier III/IV per spec v2 § 8).
  const lockboxProp = buildInPlaceLockboxProposal(args.adjustedInputs, args.dealResult);
  if (lockboxProp !== null) proposals.push(lockboxProp);

  // Mitigant v2 phase 2 lever 5 — coverage-gate condition precedent.
  // Reads dimension applicability + coverage/rating state from the
  // threaded dealResult. Converts missing data into closing conditions:
  // for each dim routed to HITL, emit a "provide X before close"
  // condition naming the missing data + the dimension it unlocks.
  // Complement of the data-requiring levers: dim 9 HITL → CP "provide
  // sponsor financials"; dim 9 RESOLVED + risk-increasing → lever 2
  // guaranty (no overlap).
  const cpProp = buildConditionPrecedentProposal(args.dealResult);
  if (cpProp !== null) proposals.push(cpProp);

  return proposals;
}

/* --------------------------- reduce_proceeds ---------------------------- */

interface BreachedTarget {
  readonly metric: MitigationTargetMetric;
  readonly lPrime: number;
}

function buildReduceProceedsProposal(
  ai: AdjustedInputs,
  uw: UnderwritingModel,
  firedFlags: readonly FiredFlag[],
  desk: MitigationDeskConstants,
  dealResult?: EvaluateDealResult,
): MitigationProposal | null {
  // Coerce nullable metrics to numbers up-front; the "is null?" question is
  // collapsed to "is non-positive?" via the `>0` checks below. Keeps the type
  // narrowing simple at each sizing call site.
  const noiRaw          = ai.metrics.noi;
  const noi: number     = noiRaw !== null ? noiRaw : 0;
  const currentLoan     = ai.loan.loanAmount.adjusted;
  const rateDecimal     = ai.loan.interestRate.adjusted;
  const amortMonths     = ai.loan.amortizationMonths.adjusted;
  const ivRaw           = uw.impliedValue;
  const impliedValue: number = ivRaw !== null ? ivRaw : 0;
  const dscr            = ai.metrics.dscr;
  const debtYield       = ai.metrics.debtYield;

  // LTV BASIS — phase-1 dim-7 re-point. The LTV arm now sizes against the
  // doctrine's STRESSED value when dim 7 resolved ("lend to MY value"), and
  // falls back to the legacy impliedValue when dim 7 was HITL or no
  // dealResult was threaded. The stressed value is always ≤ the appraised
  // value (cap-rate stress + sustainable-NCF haircut), so the LTV-supported
  // loan L'_LTV = T_LTV_TARGET × ltvDenominator is ≤ the legacy basis. The
  // binding-constraint logic (smallest L' across DSCR/DY/LTV arms) then
  // naturally selects the more-conservative answer.
  //
  // Fallback discipline: when stressedValue is null/zero, the LTV arm
  // reads from impliedValue exactly as before — byte-identical to v1.
  const dim7Stressed = dealResult?.dimensions.capRateValuationStress.derivedOutputs?.stressedValue as number | null | undefined;
  const usingStressedValue = typeof dim7Stressed === 'number' && dim7Stressed > 0;
  const ltvDenominator: number = usingStressedValue ? dim7Stressed! : impliedValue;
  const ltv = ltvDenominator > 0 ? currentLoan / ltvDenominator : null;

  // Detect breach without yet sizing.
  const dscrBreached =      dscr        !== null && dscr     < desk.T_DSCR;
  const debtYieldBreached = debtYield   !== null && debtYield < desk.T_DY;
  const ltvBreached =       ltv         !== null && ltv      > desk.T_LTV_TRIGGER;
  const anyBreach = dscrBreached || debtYieldBreached || ltvBreached;
  if (!anyBreach) return null;

  // Sizing prerequisites for any breached target.
  const canSizeDscr      = noi > 0 && rateDecimal > 0;
  const canSizeDebtYield = noi > 0;
  const canSizeLtv       = ltvDenominator > 0;
  const cannotSizeAny = (dscrBreached      && !canSizeDscr) ||
                        (debtYieldBreached && !canSizeDebtYield) ||
                        (ltvBreached       && !canSizeLtv) ||
                        currentLoan <= 0;
  if (cannotSizeAny) {
    return makeManualSizingProposal(
      'reduce_proceeds',
      'recalc_delta',
      'Manual sizing required: reduce-proceeds inputs incomplete',
      'Concluded model breaches a leverage/coverage target but one of (NOI, loanAmount, interestRate, impliedValue) is missing or non-positive. Re-extract the missing input or size the lever manually.',
    );
  }

  // Size each breached target → take binding (smallest L').
  const breaches: BreachedTarget[] = [];
  if (dscrBreached) {
    const isIO = amortMonths === 0;
    const lPrimeDscr = isIO
      ? noi / (desk.T_DSCR * rateDecimal)
      : binarySearchLoanForDscr(noi, desk.T_DSCR, rateDecimal, amortMonths, currentLoan);
    breaches.push({ metric: 'dscr', lPrime: lPrimeDscr });
  }
  if (debtYieldBreached) {
    breaches.push({ metric: 'debtYield', lPrime: noi / desk.T_DY });
  }
  if (ltvBreached) {
    // SIZE TO TARGET (not trigger): L'_LTV = T_LTV_TARGET × stressedValue.
    // With T_LTV_TARGET < T_LTV_TRIGGER, the cure goes below the breach
    // line — produces a step-up at the trigger boundary of ~
    // (T_LTV_TRIGGER − T_LTV_TARGET) × stressedValue.
    breaches.push({ metric: 'ltv', lPrime: desk.T_LTV_TARGET * ltvDenominator });
  }
  if (breaches.length === 0) return null;

  // Binding constraint = smallest L' (most restrictive).
  const binding = breaches.reduce((a, b) => (a.lPrime <= b.lPrime ? a : b));
  let lPrime = Math.max(0, binding.lPrime);

  // Materiality.
  const cutPct = (currentLoan - lPrime) / currentLoan;
  if (cutPct < desk.MATERIALITY_MIN_PROCEEDS_CUT_PCT) return null;

  // Recalc on a deep clone — recalculateFullModel mutates inner line items
  // via shallow spreads, so structuredClone is required to keep the caller's
  // uwModel reference clean.
  const clone = structuredClone(uw);
  clone.loanAmount = lPrime;
  clone.loanDetails = { ...clone.loanDetails, loanAmount: lPrime };
  const after = recalculateFullModel(clone);

  const before = snapshot(uw);
  const afterSnap = snapshot(after);

  // Doctrine §5: must beat before on the binding target.
  if (!beatsOnTarget(binding.metric, before, afterSnap)) return null;

  const requiredEquity = currentLoan - lPrime;
  const candidatePrinciples = PRINCIPLES_BY_METRIC[binding.metric];
  const principleIds = enrichPrincipleIds(firedFlags, candidatePrinciples);
  const severity = inferSeverity(binding.metric, before, desk);
  const riskReduction = classifyRiskReduction(cutPct);

  const targetLabel    = TARGET_LABELS[binding.metric];
  const beforeVal      = pickMetric(binding.metric, before);
  const afterVal       = pickMetric(binding.metric, afterSnap);
  const targetVal      = pickDeskTarget(binding.metric, desk);

  // Mitigant v2 phase 1: when the binding constraint is LTV AND we used
  // dim 7's stressed value as the denominator, tag the proposal with the
  // dimensions it addresses (leverage + cap-rate-valuation-stress). This
  // is the first emitter of addressesDimensions; phase 2 expands.
  const ltvWasStressedBasis = binding.metric === 'ltv' && usingStressedValue;
  const addressesDimensions: string[] = ltvWasStressedBasis
    ? ['leverage-ltv', 'cap-rate-valuation-stress']
    : binding.metric === 'ltv'
      ? ['leverage-ltv']
      : binding.metric === 'dscr'
        ? ['coverage-dscr']
        : ['debt-yield'];

  // LTV-ARM IN DOCTRINE-STRESSED BASIS (no appraised/concluded LTV in lever output).
  // The doctrine fires the LTV lever against dim 7's stressedValue, not against
  // the appraised value. The description re-expresses the breach + cure in the
  // basis the lever ACTUALLY uses: stressedLtv before = currentLoan / dim7Stressed,
  // stressedLtv after = lPrime / dim7Stressed. The appraised/"concluded" LTV
  // (loan / impliedValue) is deliberately NOT surfaced anywhere — the memo
  // carries ONE LTV basis (doctrine-stressed). Fallback for the legacy path:
  // when the LTV arm runs WITHOUT a stressed basis (dim 7 HITL), we keep the
  // generic "Concluded X = Y breaches Z target" framing — there is no stressed
  // value to substitute.
  const stressedLtvBefore = ltvWasStressedBasis ? currentLoan / dim7Stressed! : null;
  const stressedLtvAfter  = ltvWasStressedBasis ? lPrime      / dim7Stressed! : null;
  const stressedLtvTarget = ltvWasStressedBasis ? desk.T_LTV_TRIGGER          : null;
  const ltvDescription = ltvWasStressedBasis
    ? 'Stressed LTV ' + (stressedLtvBefore! * 100).toFixed(2) + '% breaches the doctrine ' +
      'stressed-LTV trigger of ' + (stressedLtvTarget! * 100).toFixed(2) + '% ' +
      '(loan / dim-7 stressed value $' + (dim7Stressed! / 1_000_000).toFixed(2) + 'M; ' +
      'cap-rate stress + sustainable-NCF haircut). ' +
      'Lowering proceeds from ' + fmtUsd(currentLoan) + ' to ' + fmtUsd(lPrime) +
      ' (sponsor fills ' + fmtUsd(requiredEquity) + ') brings stressed LTV to ' +
      (stressedLtvAfter! * 100).toFixed(2) + '% at the doctrine-stressed value.'
    : null;

  return {
    id: 'reduce_proceeds_' + binding.metric,
    principleIds,
    lever: 'reduce_proceeds',
    leverKind: 'recalc_delta',
    title: 'Reduce loan proceeds to satisfy ' + targetLabel + ' target',
    description:
      (ltvDescription !== null
        ? ltvDescription
        : ('Concluded ' + targetLabel + ' = ' + formatMetric(binding.metric, beforeVal) +
           ' breaches the ' + targetLabel + ' target of ' + formatMetric(binding.metric, targetVal) + '. ' +
           'Lowering proceeds from ' + fmtUsd(currentLoan) + ' to ' + fmtUsd(lPrime) +
           ' (sponsor fills ' + fmtUsd(requiredEquity) + ') brings ' + targetLabel +
           ' to ' + formatMetric(binding.metric, afterVal) + '.')
      ) +
      collateralBenefitClause(binding.metric, before, afterSnap),
    structuralChanges: [
      'Reduce loan amount from ' + fmtUsd(currentLoan) + ' to ' + fmtUsd(lPrime),
      'Sponsor funds ' + fmtUsd(requiredEquity) + ' equity gap at closing',
    ],
    requiredEquity,
    recalcBefore: before,
    recalcAfter: afterSnap,
    targetMetric: binding.metric,
    riskReduction,
    severity,
    addressesDimensions,
  };
}

function binarySearchLoanForDscr(
  noi: number,
  targetDscr: number,
  rateDecimal: number,
  amortMonths: number,
  upperBound: number,
): number {
  // calculateAnnualDebtService expects rate as PERCENT (e.g. 7.9) and
  // amortization in YEARS. ai.loan.interestRate.adjusted is decimal (0.079);
  // convert at the boundary.
  const ratePercent = rateDecimal * 100;
  const amortYears = amortMonths / 12;
  let lo = 0;
  let hi = upperBound;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const ads = calculateAnnualDebtService(mid, ratePercent, amortYears);
    if (ads === null || ads <= 0) {
      hi = mid;
      continue;
    }
    const dscrAtMid = noi / ads;
    if (dscrAtMid < targetDscr) {
      hi = mid;
    } else {
      lo = mid;
    }
    if (hi - lo < 1) break;
  }
  return (lo + hi) / 2;
}

/* ----------------------------- fund_reserve ----------------------------- */

function buildFundReserveProposal(
  ai: AdjustedInputs,
  firedFlags: readonly FiredFlag[],
  desk: MitigationDeskConstants,
): MitigationProposal | null {
  const pctRollover = ai.metrics.pctIncomeExpiringWithinTerm;
  if (pctRollover === null || pctRollover <= desk.T_ROLLOVER) return null;

  const egi = ai.income.effectiveGrossIncome.adjusted;
  if (!Number.isFinite(egi) || egi <= 0) {
    return makeManualSizingProposal(
      'fund_reserve',
      'coverage_reserve',
      'Manual sizing required: TI/LC reserve inputs incomplete',
      'Rollover concentration ' + (pctRollover * 100).toFixed(1) + '% exceeds the ' +
      (desk.T_ROLLOVER * 100).toFixed(0) + '% threshold, but EGI is missing or non-positive. ' +
      'Provide EGI to size the reserve, or size manually.',
    );
  }

  let reserve = pctRollover * egi * desk.COVERAGE_FACTOR;
  let clamped = false;
  if (reserve > RESERVE_CAP_USD) {
    reserve = RESERVE_CAP_USD;
    clamped = true;
  }
  if (reserve <= 0) return null;

  const principleIds = enrichPrincipleIds(firedFlags, ROLLOVER_PRINCIPLES);
  const coverageStatement =
    'pre-funds re-tenanting cost (TI/LC + downtime) at ' +
    (desk.COVERAGE_FACTOR * 100).toFixed(0) + '% of the ' +
    (pctRollover * 100).toFixed(1) + '% rollover-exposed annual income';

  return {
    id: 'fund_reserve_tilc_rollover',
    principleIds,
    lever: 'fund_reserve',
    leverKind: 'coverage_reserve',
    title: 'Upfront TI/LC reserve for near-term rollover',
    description:
      'Concluded near-term rollover ' + (pctRollover * 100).toFixed(1) + '% of income exceeds the ' +
      (desk.T_ROLLOVER * 100).toFixed(0) + '% threshold. ' +
      'Escrowing ' + fmtUsd(reserve) + ' at closing pre-funds expected re-tenanting costs ' +
      '(TI + downtime) against the exposed income, sized as ' +
      (pctRollover * 100).toFixed(1) + '% × EGI × ' + desk.COVERAGE_FACTOR + ' coverage factor.' +
      (clamped ? ' Clamped at sane reserve ceiling (' + fmtUsd(RESERVE_CAP_USD) + ').' : ''),
    structuralChanges: [
      'Escrow ' + fmtUsd(reserve) + ' TI/LC reserve at closing',
      'Hold against re-tenanting / downtime costs over the loan term',
    ],
    requiredReserve: reserve,
    coverageStatement,
    riskReduction: classifyReserveRiskReduction(pctRollover, desk.T_ROLLOVER),
    severity: pctRollover > desk.T_ROLLOVER * 1.5 ? 'high' : 'medium',
  };
}

/* --------------------------- helpers / utilities -------------------------- */

function snapshot(uw: UnderwritingModel): RecalcSnapshot {
  return {
    dscr:         uw.dscr,
    ltv:          uw.ltv,
    debtYield:    uw.debtYield,
    impliedValue: uw.impliedValue,
  };
}

function pickMetric(metric: MitigationTargetMetric, snap: RecalcSnapshot): number | null {
  if (metric === 'dscr')      return snap.dscr;
  if (metric === 'debtYield') return snap.debtYield;
  return snap.ltv;
}

function pickDeskTarget(metric: MitigationTargetMetric, desk: MitigationDeskConstants): number {
  if (metric === 'dscr')      return desk.T_DSCR;
  if (metric === 'debtYield') return desk.T_DY;
  // For description purposes, surface the TRIGGER ("breaches the LTV target of 70%").
  // The cure quantum (TARGET-driven L') is already in the recalc-delta.
  return desk.T_LTV_TRIGGER;
}

function beatsOnTarget(metric: MitigationTargetMetric, before: RecalcSnapshot, after: RecalcSnapshot): boolean {
  const b = pickMetric(metric, before);
  const a = pickMetric(metric, after);
  if (b === null || a === null) return false;
  // DSCR / DY are minima (raise is good). LTV is a ceiling (drop is good).
  return metric === 'ltv' ? a < b : a > b;
}

/**
 * Returns " Also improves <Metric> <b>→<a>, <Metric> <b>→<a>." for the non-
 * binding metrics among {dscr, debtYield} that moved favorably under the
 * applied lever. Empty string when nothing else moved. Verb is "improves" so
 * the clause stays direction-agnostic across mixed metric semantics.
 *
 * LTV is deliberately EXCLUDED from the side-effects list — the lever's only
 * authorized LTV basis is doctrine-stressed (loan / dim-7 stressedValue), and
 * the `RecalcSnapshot.ltv` field carries the APPRAISED-basis figure
 * (loan / uw.impliedValue). Surfacing it here would put a second LTV basis
 * in the memo, contradicting the "one LTV basis: doctrine-stressed" rule.
 * The LTV cure is already disclosed in the description's stressed-basis
 * before/after framing when the LTV arm fires; for DSCR/DY-binding cases
 * the LTV improvement is implicit in the proceeds reduction.
 */
function collateralBenefitClause(
  bindingMetric: MitigationTargetMetric,
  before: RecalcSnapshot,
  after: RecalcSnapshot,
): string {
  const others: MitigationTargetMetric[] = (['dscr', 'debtYield'] as const)
    .filter((m) => m !== bindingMetric);
  const moved: string[] = [];
  for (const m of others) {
    const b = pickMetric(m, before);
    const a = pickMetric(m, after);
    if (b === null || a === null) continue;
    const favorable = a > b;
    if (!favorable) continue;
    moved.push(TARGET_LABELS[m] + ' ' + formatMetric(m, b) + '→' + formatMetric(m, a));
  }
  if (moved.length === 0) return '';
  return ' Also improves ' + moved.join(', ') + '.';
}

function enrichPrincipleIds(
  firedFlags: readonly FiredFlag[],
  candidates: readonly string[],
): readonly string[] {
  if (candidates.length === 0) return [];
  const fired = new Set(firedFlags.map((f) => f.principleId));
  return candidates.filter((id) => fired.has(id));
}

function inferSeverity(
  metric: MitigationTargetMetric,
  before: RecalcSnapshot,
  desk: MitigationDeskConstants,
): Severity {
  const b = pickMetric(metric, before);
  const t = pickDeskTarget(metric, desk);
  if (b === null) return 'medium';
  // Normalized gap: how far the metric is from target, signed by direction.
  const gap = metric === 'ltv' ? (b - t) / t : (t - b) / t;
  if (gap >= 0.15) return 'critical';
  if (gap >= 0.05) return 'high';
  return 'medium';
}

function classifyRiskReduction(cutPct: number): RiskReduction {
  if (cutPct >= 0.15) return 'significant';
  if (cutPct >= 0.05) return 'moderate';
  return 'marginal';
}

function classifyReserveRiskReduction(pct: number, threshold: number): RiskReduction {
  const excess = (pct - threshold) / threshold;
  if (excess >= 0.50) return 'significant';
  if (excess >= 0.20) return 'moderate';
  return 'marginal';
}

const TARGET_LABELS: Record<MitigationTargetMetric, string> = {
  dscr: 'DSCR',
  debtYield: 'Debt Yield',
  ltv: 'LTV',
};

function formatMetric(metric: MitigationTargetMetric, v: number | null): string {
  if (v === null) return '—';
  if (metric === 'dscr') return v.toFixed(2) + 'x';
  return (v * 100).toFixed(2) + '%';
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}

function makeManualSizingProposal(
  lever: 'reduce_proceeds' | 'fund_reserve',
  leverKind: 'recalc_delta' | 'coverage_reserve',
  title: string,
  description: string,
): MitigationProposal {
  return {
    id: 'manual_' + lever,
    principleIds: [],
    lever,
    leverKind,
    title,
    description,
    structuralChanges: ['Sizing requires manual analyst input — see description.'],
    riskReduction: 'marginal',
    severity: 'medium',
  };
}

/* ----------------------- require_amortization (v2 lever 1) ----------------- */
/*
 * Sized off dim 4 (refinance-feasibility) of the threaded clean
 * dealResult. Fires when the doctrine's exit DSCR is BELOW the
 * refinanceable threshold (EXIT_DSCR_REFINANCEABLE_THRESHOLD) — i.e.,
 * the loan can't clear the take-out at the doctrine's stressed refi
 * constant. Solves for the maturity balance B_target that would clear
 * the threshold:
 *
 *     B_target = sustainableNCF / (stressedRefiConstant × refiDscrThreshold)
 *
 * Then expresses the implied amortization schedule (years) that lands
 * the balance at B_target at term-end, given the loan's current rate +
 * term. The lever's required paydown = currentLoan − B_target.
 *
 * Edge discipline:
 *   - B_target >= currentLoan          → no fire (already refinanceable at balance)
 *   - B_target <= 0                    → manual variant (amortization alone insufficient)
 *   - implied amort > MAX_AMORT_YEARS  → manual variant (schedule impractical)
 *   - exit DSCR not computable         → no fire
 *
 * Fence: reads only dealResult.dimensions.refinanceFeasibility.derivedOutputs
 * + dealResult.normalization.sustainableNcf + ai.loan.{loanAmount, interestRate, termMonths}.
 * NO judgment-engine outputs / valuationConclusion / handbook.
 */
const MAX_IMPLIED_AMORT_YEARS = 40;

function buildAmortizationProposal(
  ai: AdjustedInputs,
  dealResult: EvaluateDealResult | undefined,
  desk: MitigationDeskConstants,
): MitigationProposal | null {
  if (!dealResult) return null;
  const refiDim = dealResult.dimensions.refinanceFeasibility;
  if (refiDim.applicability !== 'applicable') return null;

  const exitDscrRaw = refiDim.derivedOutputs?.exitDscr;
  const stressedRefiConstRaw = refiDim.derivedOutputs?.stressedRefiConstant;
  const maturityBalanceRaw = refiDim.derivedOutputs?.maturityBalance;
  const sustainableNcf = dealResult.normalization.sustainableNcf;

  if (typeof exitDscrRaw !== 'number' || !Number.isFinite(exitDscrRaw)) return null;
  if (typeof stressedRefiConstRaw !== 'number' || !(stressedRefiConstRaw > 0)) return null;
  if (typeof maturityBalanceRaw !== 'number' || !(maturityBalanceRaw > 0)) return null;
  if (typeof sustainableNcf !== 'number' || !(sustainableNcf > 0)) return null;

  // Trigger: exit DSCR below the refinanceable threshold = leg score elevated+ on dim 4.
  if (exitDscrRaw >= EXIT_DSCR_REFINANCEABLE_THRESHOLD) return null;

  const exitDscr = exitDscrRaw;
  const stressedRefiConstant = stressedRefiConstRaw;
  const currentLoan = ai.loan.loanAmount.adjusted;
  if (!(currentLoan > 0)) return null;

  const couponDecimal = ai.loan.interestRate.adjusted;
  const termMonths = ai.loan.termMonths.adjusted;
  if (!(termMonths > 0)) return null;

  // B_target so re-computed exit DSCR clears the DESK's CURE TARGET — NOT
  // the doctrine's TRIGGER. Cure target ≥ trigger produces a cushion: cured
  // loans land above the refinanceable line by
  //   sustainableNCF / (stressedRefiConstant × cureTarget)
  //   −
  //   sustainableNCF / (stressedRefiConstant × trigger)
  // (≈ 4% of B_trigger at the default 1.25 / 1.20 split).
  // Fire gate above still reads the doctrine's TRIGGER (1.20); only the
  // sizing target lives on the desk knob.
  const cureTarget = desk.T_EXIT_DSCR_CURE_TARGET;
  const bTarget = sustainableNcf / (stressedRefiConstant * cureTarget);

  // Edge: target balance ≥ current loan → already refinanceable; lever wouldn't move the needle.
  if (bTarget >= currentLoan) return null;

  // Edge: target balance ≤ 0 — amortization alone cannot clear the refi; recommend proceeds reduction.
  if (bTarget <= 0) {
    return {
      id: 'amortization_refi_insufficient',
      principleIds: [],
      lever: 'require_amortization',
      leverKind: 'amortization',
      title: 'Amortization alone insufficient — proceeds reduction required',
      description:
        `Concluded exit DSCR ${exitDscr.toFixed(2)}x falls below the doctrine's ` +
        `${EXIT_DSCR_REFINANCEABLE_THRESHOLD.toFixed(2)}x refinanceable threshold at the ` +
        `${(stressedRefiConstant * 100).toFixed(2)}% stressed take-out constant. The math ` +
        `(sustainable NCF ${fmtUsd(sustainableNcf)} / (${(stressedRefiConstant * 100).toFixed(2)}% × ${cureTarget.toFixed(2)}x cure target)) ` +
        `implies a target maturity balance ≤ $0 — meaning even a fully amortizing loan to $0 won't ` +
        `cure the refi at the stressed constant. A proceeds reduction (reduce_proceeds lever) is required.`,
      structuralChanges: [
        'Amortization alone cannot satisfy the doctrine\'s refinanceable threshold.',
        'Pair with reduce_proceeds: cut origination loan first, then size amortization off the new balance.',
      ],
      riskReduction: 'marginal',
      severity: 'high',
      addressesDimensions: ['refinance-feasibility'],
    };
  }

  const requiredPaydown = currentLoan - bTarget;

  // Standard amortizing-balance: solve for implied amort SCHEDULE (in years)
  // that lands current loan at bTarget after termMonths at the loan's rate.
  const impliedAmortYears = computeImpliedAmortYearsForBalance(currentLoan, couponDecimal, termMonths, bTarget);

  if (impliedAmortYears === null || !(impliedAmortYears > 0) || impliedAmortYears > MAX_IMPLIED_AMORT_YEARS) {
    return {
      id: 'amortization_refi_impractical',
      principleIds: [],
      lever: 'require_amortization',
      leverKind: 'amortization',
      title: 'Amortization schedule impractical — proceeds reduction required',
      description:
        `Concluded exit DSCR ${exitDscr.toFixed(2)}x falls below the doctrine's ` +
        `${EXIT_DSCR_REFINANCEABLE_THRESHOLD.toFixed(2)}x refinanceable threshold. Target maturity balance ` +
        `${fmtUsd(bTarget)} (paydown ${fmtUsd(requiredPaydown)} over a ${(termMonths / 12).toFixed(1)}-year term at ` +
        `${(couponDecimal * 100).toFixed(2)}% coupon) implies an amort schedule outside practical range (>${MAX_IMPLIED_AMORT_YEARS}yr ` +
        `or undefined). Amortization alone won't close the gap; pair with proceeds reduction.`,
      structuralChanges: [
        'Required amortization schedule exceeds practical range — sponsor cannot service the implied payment.',
        'Pair with reduce_proceeds: cut origination loan first, then size amortization off the new balance.',
      ],
      requiredPaydown,
      targetMaturityBalance: bTarget,
      riskReduction: 'marginal',
      severity: 'high',
      addressesDimensions: ['refinance-feasibility'],
    };
  }

  // Severity + risk reduction from exit-DSCR shortfall magnitude.
  const severity: Severity =
    exitDscr < 1.00 ? 'critical' :
    exitDscr < 1.10 ? 'high' :
    'medium';
  const riskReduction: RiskReduction =
    exitDscr < 1.00 ? 'significant' :
    exitDscr < 1.15 ? 'moderate' :
    'marginal';

  // After-target exit DSCR (the desk's cure target by construction).
  // Cure target ≥ trigger means the cured loan lands above the
  // doctrine's refinanceable line, not just at it.
  const afterExitDscr = cureTarget;

  return {
    id: 'amortization_refi',
    principleIds: [],
    lever: 'require_amortization',
    leverKind: 'amortization',
    title: 'Require amortization to a refinanceable maturity balance',
    description:
      `Concluded exit DSCR ${exitDscr.toFixed(2)}x at the ${(stressedRefiConstant * 100).toFixed(2)}% stressed take-out ` +
      `falls below the doctrine's ${EXIT_DSCR_REFINANCEABLE_THRESHOLD.toFixed(2)}x refinanceable threshold ` +
      `(maturity balance ${fmtUsd(maturityBalanceRaw)} / sustainable NCF ${fmtUsd(sustainableNcf)}). ` +
      `Amortizing from ${fmtUsd(currentLoan)} down to ${fmtUsd(bTarget)} by maturity ` +
      `(${fmtUsd(requiredPaydown)} total paydown, ≈ ${impliedAmortYears.toFixed(1)}-year amort schedule at ` +
      `the loan's ${(couponDecimal * 100).toFixed(2)}% coupon over a ${(termMonths / 12).toFixed(0)}-year term) ` +
      `brings the exit DSCR to ${afterExitDscr.toFixed(2)}x — clearing the doctrine's ` +
      `${EXIT_DSCR_REFINANCEABLE_THRESHOLD.toFixed(2)}x refinanceable line with the desk's cure cushion.`,
    structuralChanges: [
      `Convert interest-only to amortizing (or increase amortization to ≈ ${impliedAmortYears.toFixed(0)}-year schedule)`,
      `Amortize from ${fmtUsd(currentLoan)} to ${fmtUsd(bTarget)} by maturity (${fmtUsd(requiredPaydown)} total paydown)`,
    ],
    requiredPaydown,
    targetMaturityBalance: bTarget,
    riskReduction,
    severity,
    addressesDimensions: ['refinance-feasibility'],
  };
}

/**
 * Standard amortizing-balance solve for the implied amortization
 * schedule (in YEARS) that brings a loan of size L from origination to
 * balance B at time tMonths, at monthly rate r = coupon/12.
 *
 * Two-step derivation:
 *   1. Find the monthly payment P that produces balance B at tMonths:
 *        B = L(1+r)^t - P((1+r)^t - 1)/r
 *      ⇒ P = (L(1+r)^t - B) · r / ((1+r)^t - 1)
 *   2. Invert the standard mortgage payment formula to find the amort
 *      schedule A_months that produces P from initial L at rate r:
 *        P = L·r / (1 - (1+r)^-A)
 *      ⇒ A_months = -ln(1 - L·r/P) / ln(1+r)
 *
 * Returns null when the math is undefined or infeasible (negative loan,
 * non-positive rate edge, P too small to cover interest, A > 600mo).
 * The zero-rate edge case is handled separately (linear amort).
 */
function computeImpliedAmortYearsForBalance(
  L: number,
  couponDecimal: number,
  tMonths: number,
  B: number,
): number | null {
  if (!(L > 0) || !(tMonths > 0) || !(B >= 0) || B >= L) return null;
  if (!(couponDecimal > 0)) {
    // Zero-rate edge — linear amort: B = L - (L/A_months) · tMonths ⇒ A_months = L · tMonths / (L − B).
    const aMonths = L * tMonths / (L - B);
    if (!Number.isFinite(aMonths) || aMonths <= 0) return null;
    return aMonths / 12;
  }
  const r = couponDecimal / 12;
  const growth = Math.pow(1 + r, tMonths);
  const numerator = (L * growth - B) * r;
  const denominator = growth - 1;
  if (denominator <= 0) return null;
  const monthlyPayment = numerator / denominator;
  if (!(monthlyPayment > 0)) return null;
  // Invert: 1 − L·r/P must be in (0, 1) to have a real schedule.
  const inner = 1 - (L * r) / monthlyPayment;
  if (inner <= 0 || inner >= 1) return null;
  const aMonths = -Math.log(inner) / Math.log(1 + r);
  if (!Number.isFinite(aMonths) || aMonths <= 0) return null;
  return aMonths / 12;
}

export { buildAmortizationProposal, computeImpliedAmortYearsForBalance };

/* ------------------ require_guaranty (v2 lever 2) ----------------- */
/*
 * Sized off dim 9 (sponsor-borrower-quality) from the threaded clean
 * dealResult. Fires when dim 9 is APPLICABLE + RESOLVED and the
 * riskModifier is risk-INCREASING beyond a small threshold. Does NOT
 * fire on dim 9 HITL (missing sponsor data is the coverage-gate's
 * domain, not a guaranty lever) and does NOT fire on a clean / risk-
 * decreasing sponsor.
 *
 * This is the first STRUCTURAL-TERM lever — no dollar sizing. The
 * recourse intensity scales with the concern magnitude:
 *   - mild      modifier in [TRIGGER, 0.10)  → limited / burn-off guaranty + covenants
 *   - moderate  modifier in [0.10, 0.18)     → partial guaranty (25-50% recourse) + slower burn-off
 *   - severe    modifier >= 0.18 OR factor-4 priorCreditEvents-Severe
 *                                            → full payment guaranty (or substantial recourse 50%+)
 *                                              + strict covenants + no/late burn-off
 *
 * Factor-4 (prior credit events) drives a SEVERE tier independently of
 * the net modifier magnitude — a Severe factor-4 reading in dim 9 (active
 * fraud / misrepresentation / prior default) triggers full payment recourse
 * regardless of what the other 4 symmetric factors show. The asymmetry
 * matches dim 9's own structure (priorCreditEvents Severe floors the
 * modifier at +bound).
 *
 * If the factor breakdown is exposed (it is — dim 9 publishes
 * factorContribution* in derivedOutputs), the description tailors the
 * emphasis: factor-4 → payment recourse + bad-boy carve-outs;
 * factor-2 (financial strength) weak → tightened liquidity covenants;
 * factor-3 (alignment) weak → cash-out limitation / equity-in-deal.
 *
 * Fence: reads ONLY dealResult.dimensions.sponsorBorrowerQuality. No
 * judgment-engine output / valuationConclusion / handbook / AdjustedInputs.
 */
const GUARANTY_TRIGGER_THRESHOLD = 0.03;        // modifier must be > 3 pts upward to fire
const GUARANTY_MODERATE_THRESHOLD = 0.10;       // moderate tier begins
const GUARANTY_SEVERE_THRESHOLD = 0.18;         // severe tier begins (just below the +0.20 bound)

type GuarantyTier = 'mild' | 'moderate' | 'severe';

function buildGuarantyProposal(
  dealResult: EvaluateDealResult | undefined,
  terms: Readonly<Record<GuarantyTierKey, GuarantyTierTerms>> = DEFAULT_GUARANTY_TIER_TERMS,
): MitigationProposal | null {
  if (!dealResult) return null;
  const sponsorDim = dealResult.dimensions.sponsorBorrowerQuality;

  // (a) Applicability: only on RESOLVED dim 9. HITL belongs to the
  // coverage gate, not a guaranty lever.
  if (sponsorDim.applicability !== 'applicable') return null;

  // (b) Risk modifier must be risk-INCREASING beyond a small threshold.
  // Negative (risk-reducing strong sponsor) → no guaranty needed.
  const modifier = sponsorDim.riskModifier;
  if (typeof modifier !== 'number' || !Number.isFinite(modifier)) return null;
  if (modifier <= GUARANTY_TRIGGER_THRESHOLD) return null;

  // (c) Factor-4 asymmetry: a 'disqualifying-event' tier (set in dim 9
  // when priorCreditEvents === 'Severe') forces severe tier even if the
  // net modifier sits below the severe threshold.
  const disqualifyingEvent = sponsorDim.tier === 'disqualifying-event';

  // (d) Tier selection.
  let tier: GuarantyTier;
  if (disqualifyingEvent || modifier >= GUARANTY_SEVERE_THRESHOLD) tier = 'severe';
  else if (modifier >= GUARANTY_MODERATE_THRESHOLD)                tier = 'moderate';
  else                                                              tier = 'mild';

  // (e) Inspect factor contributions to tailor emphasis. Each is signed:
  // positive = risk-increasing direction.
  const d = sponsorDim.derivedOutputs ?? {};
  const cExperience       = (d.factorContributionExperience       as number | null | undefined) ?? 0;
  const cFinancial        = (d.factorContributionFinancialStrength as number | null | undefined) ?? 0;
  const cAlignment        = (d.factorContributionAlignment        as number | null | undefined) ?? 0;
  const cPriorCredit      = (d.factorContributionPriorCreditEvents as number | null | undefined) ?? 0;
  const cManagement       = (d.factorContributionManagementQuality as number | null | undefined) ?? 0;

  const factorEmphasis: string[] = [];
  if (cPriorCredit > 0)  factorEmphasis.push('prior credit events');
  if (cFinancial > 0)    factorEmphasis.push('financial strength');
  if (cAlignment > 0)    factorEmphasis.push('alignment / skin-in-the-game');
  if (cManagement > 0)   factorEmphasis.push('management quality');
  if (cExperience > 0)   factorEmphasis.push('experience / track record');

  // (f) Recourse + covenant scaffolding by tier — INTERPOLATED from the
  // desk-owned GUARANTY_TIER_TERMS table (not hardcoded). The 4th tier-key
  // 'disqualifying-event' captures the factor-4 forced case; severe shape
  // is otherwise selected. Boilerplate (bad-boy carve-outs, springing-
  // recourse, LTV/DSCR step-downs) stays as fixed text.
  const tierKey: GuarantyTierKey = disqualifyingEvent ? 'disqualifying-event' : tier;
  const t = terms[tierKey];
  const recoursePctStr  = (t.recoursePct  * 100).toFixed(0);
  const liquidityPctStr = (t.liquidityPct * 100).toFixed(0);
  const nwMultStr       = t.netWorthMultiple.toFixed(1);
  const burnOffPhrase   = t.burnOffYears === null
    ? 'no burn-off'
    : `burn-off after ${t.burnOffYears} years`;
  const burnOffPhrasePlus = t.burnOffYears === null
    ? 'no burn-off'
    : `burn-off after ${t.burnOffYears}+ years`;

  const recourseTerms: { title: string; recourseClause: string; covenantClause: string; structuralChanges: string[] } = (() => {
    if (tier === 'severe') {
      return {
        title: 'Full payment guaranty + strict covenants — severe sponsor concern',
        recourseClause:
          disqualifyingEvent
            ? `Full payment guaranty (${recoursePctStr}% recourse on payment and the loan) from a creditworthy guarantor; ${burnOffPhrase}. The disqualifying credit event on factor 4 (prior credit events) makes the borrower's historical performance disqualifying absent personal recourse.`
            : `Full payment guaranty (or substantial recourse ${recoursePctStr}%+) from a creditworthy guarantor; ${burnOffPhrase} (or burn-off only after years of clean performance + covenant tests).`,
        covenantClause:
          `Strict ongoing guarantor covenants: minimum net worth ≥ ${nwMultStr}× loan, minimum liquidity ≥ ${liquidityPctStr}% of loan, annual financial certification, springing recourse triggers on deal underperformance, expanded bad-boy carve-outs (fraud, misrepresentation, bankruptcy filing).`,
        structuralChanges: [
          disqualifyingEvent
            ? `Full payment guaranty (${recoursePctStr}% recourse) from a creditworthy guarantor — required absent the disqualifying credit-event history`
            : `Full payment guaranty (or ${recoursePctStr}%+ partial payment guaranty) from a creditworthy guarantor`,
          t.burnOffYears === null
            ? 'No burn-off (or burn-off only after years of clean performance + covenant tests + LTV reduction)'
            : `Burn-off after ${t.burnOffYears}+ years of clean performance + covenant tests + LTV reduction`,
          `Minimum guarantor net worth ≥ ${nwMultStr}× loan, minimum liquidity ≥ ${liquidityPctStr}% of loan`,
          'Annual financial certification, springing recourse triggers, expanded bad-boy carve-outs (fraud, misrepresentation, bankruptcy filing)',
        ],
      };
    }
    if (tier === 'moderate') {
      return {
        title: 'Partial payment guaranty + financial covenants — moderate sponsor concern',
        recourseClause:
          `Partial payment guaranty (${recoursePctStr}% recourse on payment) from a creditworthy guarantor. Recourse covers payment on the loan balance up to the recourse percentage; standard bad-boy carve-outs apply for the remainder.`,
        covenantClause:
          `Guarantor net-worth + liquidity covenants: minimum net worth ≥ ${nwMultStr}× loan, minimum liquidity ≥ ${liquidityPctStr}% of loan, annual financial certification. ${t.burnOffYears === null ? 'No burn-off' : `Burn-off after ${t.burnOffYears}+ years of clean performance`}, achievement of LTV and DSCR step-downs, and no covenant trigger events.`,
        structuralChanges: [
          `Partial payment guaranty (${recoursePctStr}% recourse) from a creditworthy guarantor`,
          `Guarantor net-worth covenant: minimum net worth ≥ ${nwMultStr}× loan`,
          `Guarantor liquidity covenant: minimum liquidity ≥ ${liquidityPctStr}% of loan`,
          'Annual guarantor financial certification + standard bad-boy carve-outs',
          t.burnOffYears === null
            ? 'No burn-off — guaranty runs through the term'
            : `Burn-off after ${t.burnOffYears}+ years of clean performance + LTV/DSCR step-down tests`,
        ],
      };
    }
    // mild
    return {
      title: 'Limited burn-off payment guaranty + net-worth / liquidity covenants — mild sponsor concern',
      recourseClause:
        `Limited payment guaranty (≤${recoursePctStr}% recourse on payment) with ${burnOffPhrase} from a creditworthy guarantor. Standard bad-boy carve-outs.`,
      covenantClause:
        `Guarantor financial covenants: minimum net worth ≥ ${nwMultStr}× loan, minimum liquidity ≥ ${liquidityPctStr}% of loan. Annual financial certification. ${t.burnOffYears === null ? 'Guaranty runs through the term (no burn-off).' : `Guaranty burns off after ${t.burnOffYears} years of clean performance + DSCR/LTV thresholds met.`}`,
      structuralChanges: [
        `Limited payment guaranty (≤${recoursePctStr}% recourse) with ${burnOffPhrasePlus} from a creditworthy guarantor`,
        `Guarantor net-worth covenant: minimum net worth ≥ ${nwMultStr}× loan`,
        `Guarantor liquidity covenant: minimum liquidity ≥ ${liquidityPctStr}% of loan`,
        'Annual guarantor financial certification + standard bad-boy carve-outs',
        t.burnOffYears === null
          ? 'No burn-off (held for the term)'
          : `Burn-off after ${t.burnOffYears} years of clean performance + DSCR/LTV threshold achievement`,
      ],
    };
  })();

  const severity: Severity =
    tier === 'severe'   ? (disqualifyingEvent ? 'critical' : 'high') :
    tier === 'moderate' ? 'high' :
    'medium';
  const riskReduction: RiskReduction =
    tier === 'severe'   ? 'significant' :
    tier === 'moderate' ? 'moderate' :
    'marginal';

  const emphasisClause = factorEmphasis.length > 0
    ? ' Drivers: ' + factorEmphasis.join(', ') + '.'
    : '';
  const tierEmphasis = disqualifyingEvent
    ? ' Factor-4 (prior credit events) is Severe — the dim-9 asymmetry forces the severe tier regardless of net modifier magnitude.'
    : '';

  return {
    id: 'guaranty_sponsor_' + tier,
    principleIds: [],
    lever: 'require_guaranty',
    leverKind: 'guaranty',
    title: recourseTerms.title,
    description:
      `Sponsor / borrower quality assessment yields a risk-increasing modifier of +${modifier.toFixed(2)} on the doctrine's 0-1 risk scale (DBRS-bounded ±${(d.modifierCap as number ?? 0.20).toFixed(2)}).${emphasisClause}${tierEmphasis} Recommended ${tier} tier: ${recourseTerms.recourseClause} ${recourseTerms.covenantClause} The guaranty is only as good as the balance sheet behind it — net-worth and liquidity covenants ride alongside in every tier.`,
    structuralChanges: recourseTerms.structuralChanges,
    riskReduction,
    severity,
    addressesDimensions: ['sponsor-borrower-quality'],
  };
}

export { buildGuarantyProposal };

/* ------------ springing_cash_management — concentration trap (v2 lever 3) ----------- */
/*
 * Hybrid lever:
 *   STRUCTURAL: springing cash management — cash flows normally to the
 *               sponsor until a tenant-status trigger fires (notice-to-
 *               vacate / go-dark / bankruptcy / credit-downgrade /
 *               property DSCR test); upon trigger, excess cash sweeps
 *               into a re-tenanting reserve.
 *   DOLLAR:    sized trap CAP off dim 5's concentrated-income estimate.
 *               cap = topTenantShare × EGI × coverageFactor (default 0.75 —
 *               same as v1's fund_reserve for rollover; calibration default).
 *               The cap is the springing-trap accumulation TARGET, NOT an
 *               upfront escrow.
 *
 * Trigger: dim 5 applicability === 'applicable' AND tier in
 *          {'elevated', 'high'}. Does NOT fire on:
 *          - not-applicable-by-asset-type (Hotel/Multifamily/MHC/SelfStorage)
 *          - HITL (missing tenant data → coverage gate's domain)
 *          - low / moderate concentration (no structural justification for
 *            springing cash management; lighter v1 reserves handle moderate).
 *
 * Distinct from v1 fund_reserve: v1 sizes a TI/LC escrow off the
 * pctIncomeExpiringWithinTerm metric (ROLLOVER); this lever sizes a
 * springing-trap cap off TENANT CONCENTRATION (a different signal). A
 * deal with high concentration AND high rollover legitimately gets both
 * proposals (different risks, different mechanisms; no double-count).
 *
 * Basis caveat: dim 5 records its top-tenant basis in its RATIONALE
 * (NRA / base-rent / unknown); the structured derivedOutputs does not
 * surface the basis literal. The proposal description carries a
 * generic basis-uncertainty note so reviewers see the caveat without
 * relying on text-parsing dim 5's rationale. For anchored retail
 * specifically, NRA-share OVERSTATES the anchor's true income share —
 * the lever cites this in the description.
 *
 * Fence: reads ONLY dealResult.dimensions.incomeConcentration +
 * AdjustedInputs.income.effectiveGrossIncome.adjusted (the SAME EGI
 * source v1's fund_reserve already uses — consistent, already-vetted).
 * No judgment metrics.noi / valuationConclusion / handbook.
 */

/** Default coverage factor for the trap cap. Matches v1's fund_reserve
 *  rollover coverage factor (0.75 × of the exposed income). CALIBRATION
 *  default — surfaces in the proposal description. */
const CONCENTRATION_TRAP_COVERAGE_FACTOR_DEFAULT = 0.75;

function buildSpringingCashTrapProposal(
  ai: AdjustedInputs,
  dealResult: EvaluateDealResult | undefined,
  desk: MitigationDeskConstants,
): MitigationProposal | null {
  if (!dealResult) return null;
  const concDim = dealResult.dimensions.incomeConcentration;

  // (a) Applicability — only on resolved + tenant-based assets.
  if (concDim.applicability !== 'applicable') return null;

  // (b) Trigger — elevated or high concentration tier only.
  if (concDim.tier !== 'elevated' && concDim.tier !== 'high') return null;

  // (c) Top-tenant share from dim 5 derivedOutputs.
  const topTenantShare = concDim.derivedOutputs?.topTenantShare as number | null | undefined;
  if (typeof topTenantShare !== 'number' || !(topTenantShare > 0) || topTenantShare > 1.0001) return null;

  // (d) EGI source — same as v1 fund_reserve (intentional consistency).
  const egi = ai.income.effectiveGrossIncome.adjusted;
  if (!Number.isFinite(egi) || egi <= 0) {
    return {
      id: 'springing_cash_trap_concentration_manual',
      principleIds: [],
      lever: 'springing_cash_management',
      leverKind: 'springing_cash_management',
      title: 'Manual sizing required: tenant-concentration springing cash trap',
      description:
        `Top tenant ${(topTenantShare * 100).toFixed(1)}% of income on the property ` +
        `(${concDim.tier} concentration per dim 5), but EGI is missing or non-positive on the ` +
        `underwriting model — cannot size the springing trap cap. Provide EGI to size the cap, or ` +
        `size manually using the concentrated annual income × the coverage factor ` +
        `(default ${CONCENTRATION_TRAP_COVERAGE_FACTOR_DEFAULT}× — calibration setting).`,
      structuralChanges: ['Sizing requires manual analyst input — see description.'],
      addressesDimensions: ['income-concentration'],
      riskReduction: 'marginal',
      severity: 'medium',
    };
  }

  // (e) Sizing — trap cap off concentrated income.
  const coverageFactor = CONCENTRATION_TRAP_COVERAGE_FACTOR_DEFAULT;
  const concentratedAnnualIncome = topTenantShare * egi;
  const trapCap = concentratedAnnualIncome * coverageFactor;
  if (!(trapCap > 0) || !Number.isFinite(trapCap)) return null;

  // Severity / riskReduction from concentration magnitude (dim 5 tier).
  const severity: Severity = concDim.tier === 'high' ? 'critical' : 'high';
  const riskReduction: RiskReduction = concDim.tier === 'high' ? 'significant' : 'moderate';

  const trapCapClause =
    `Trap cap $${(trapCap / 1_000_000).toFixed(2)}M = top-tenant share ` +
    `${(topTenantShare * 100).toFixed(1)}% × EGI $${(egi / 1_000_000).toFixed(2)}M × ` +
    `${coverageFactor.toFixed(2)} coverage factor (calibration default — same factor v1's ` +
    `fund_reserve uses for rollover TI/LC sizing).`;

  const basisCaveatClause =
    ` BASIS CAVEAT: the top-tenant share is the dim-5 estimate (basis recorded in dim 5's rationale ` +
    `— NRA-share for v1 corpus, base-rent share for the live extractor adapter). For anchored ` +
    `retail in particular, an NRA-based share OVERSTATES the anchor's true base-rent income share; ` +
    `the trap cap on such deals is a conservative upper bound and an analyst can resize off ` +
    `per-tenant base-rent when available.`;

  return {
    id: 'springing_cash_trap_concentration',
    principleIds: [],
    lever: 'springing_cash_management',
    leverKind: 'springing_cash_management',
    title: 'Springing cash management on tenant-concentration trigger',
    description:
      `Top tenant ${(topTenantShare * 100).toFixed(1)}% of income (dim 5 tier=${concDim.tier}); ` +
      `concentrated annual income estimate $${(concentratedAnnualIncome / 1_000_000).toFixed(2)}M. ` +
      `Recommend SPRINGING cash management: cash flows normally to the sponsor until a tenant-status ` +
      `trigger fires (tenant notice-to-vacate, go-dark, bankruptcy filing, credit downgrade below ` +
      `investment-grade, OR a property-level DSCR floor breach) — upon trigger, excess cash is swept ` +
      `into a re-tenanting reserve up to the trap cap, released for TI/LC + carrying cost during ` +
      `re-leasing. ${trapCapClause} ${basisCaveatClause} The trap cap is the ACCUMULATION TARGET ` +
      `under the springing trigger; NOT an upfront escrow at closing (distinct from v1's fund_reserve ` +
      `mechanism which addresses rollover, not concentration).`,
    structuralChanges: [
      'Springing cash management triggers: tenant notice-to-vacate / go-dark / bankruptcy filing / ' +
      'credit downgrade below investment grade / property DSCR floor breach',
      'Cash flows normally to sponsor (distributions permitted) until a trigger fires',
      `Upon trigger: excess cash swept into a re-tenanting reserve up to trap cap $${(trapCap / 1_000_000).toFixed(2)}M`,
      'Reserve released for TI/LC + carrying cost during re-leasing; balance returned on cure',
      'Springing-mechanism + cap clauses + cure tests defined in loan docs',
    ],
    requiredReserve: trapCap,
    coverageStatement:
      `springing-trap accumulation cap (NOT an upfront escrow): pre-funds re-tenanting ` +
      `(TI/LC + downtime) up to ${(coverageFactor * 100).toFixed(0)}% of the ` +
      `${(topTenantShare * 100).toFixed(1)}%-concentrated annual income upon trigger event`,
    addressesDimensions: ['income-concentration'],
    riskReduction,
    severity,
  };
}

export { buildSpringingCashTrapProposal };

/* ----------- in_place_cash_management — asset-class lockbox (v2 lever 4) ----------- */
/*
 * Constant (NOT springing) hard lockbox + asset-tailored reserve when
 * dim 8 (asset-class) places the property in Tier III or IV — i.e.,
 * the asset itself is the risk, not just a tenant-specific event. The
 * lockbox is in-place from closing: all cash sweeps into a controlled
 * account, distributions to the sponsor are conditional on debt
 * service + reserves + tests.
 *
 * Trigger: dim 8 applicability === 'applicable' AND tier in {'III', 'IV'}.
 *          Tiers I/II do NOT fire — the doctrine's own asset-class
 *          weighting handles those without a structural overlay.
 *          HITL does NOT fire — coverage gate's domain.
 *
 * COORDINATION with lever 3 (springing cash trap on concentration):
 *   The in-place lockbox is the STRICTER, CONSTANT cousin of lever 3.
 *   When BOTH fire on the same deal (e.g., a concentrated Mall with one
 *   anchor + a Tier IV asset class), the in-place lockbox SUBSUMES the
 *   springing trigger — cash is already controlled at all times, so the
 *   tenant-specific trigger is moot. We deliberately do NOT suppress
 *   lever 3 in code; both proposals fire and lever 4's description
 *   carries the subsumption note for the human to reconcile.
 *   (Lever-composition/reconciliation is a known v2 limitation for a
 *    later pass.)
 *
 * The ASSET-SPECIFIC RESERVE tailors the dollar component by canonical
 * asset class. Reserves are sized as a % of EGI, defaulted to public
 * agency conventions (KBRA / DBRS norms) — flagged as CALIBRATION
 * defaults in the proposal description.
 *
 * Fence: reads ONLY dealResult.dimensions.assetClass +
 * AdjustedInputs.income.effectiveGrossIncome.adjusted (the SAME EGI
 * source v1 fund_reserve + lever 3 already use). No judgment metrics
 * / valuationConclusion / handbook.
 */

interface AssetClassReserveProfile {
  readonly reserveKind: string;             // human-readable label
  readonly reserveDescription: string;      // longer-form rationale
  readonly reservePctOfEgiDefault: number;  // CALIBRATION DEFAULT
}

// DESK POLICY DP-1 (see apps/api/src/doctrine-clean/README.md):
// These reserves are CUSTODIAL — bank-controlled cash escrows that
// guarantee TI/LC + capex funding during the loan term. They do NOT
// duplicate the ANALYTICAL NCF/NOI haircut in
// doctrine-clean/normalization/sustainable-cashflow.ts; the two
// answer different questions and are retained together by locked
// desk policy. Provenance: operator-judgment.
const ASSET_CLASS_RESERVE_PROFILE: Readonly<Record<string, AssetClassReserveProfile>> = {
  Hotel:             { reserveKind: 'FF&E reserve',                         reserveDescription: 'furniture, fixtures + equipment (room product) at brand-flag standard',                    reservePctOfEgiDefault: 0.04 },
  Mall:              { reserveKind: 'CapEx + TI/LC reserve (mall)',         reserveDescription: 'common-area capex + tenant improvements + leasing commissions for in-line tenant churn', reservePctOfEgiDefault: 0.035 },
  Office:            { reserveKind: 'CapEx + TI/LC reserve (office)',       reserveDescription: 'building capex + tenant improvements + leasing commissions for office rollover (CUSTODIAL — see DP-1; NOT duplicative with NCF/NOI 0.89 haircut)', reservePctOfEgiDefault: 0.03 },
  AnchoredRetail:    { reserveKind: 'CapEx + TI/LC reserve (anchored)',     reserveDescription: 'building capex + TI/LC for anchored center re-tenanting',                                 reservePctOfEgiDefault: 0.03 },
  UnanchoredRetail:  { reserveKind: 'CapEx + TI/LC reserve (unanchored)',   reserveDescription: 'building capex + TI/LC; unanchored re-tenanting carries higher LC cost per SF',           reservePctOfEgiDefault: 0.035 },
  SpecialtyAtypical: { reserveKind: 'Specialty capex reserve',              reserveDescription: 'atypical-collateral capex (e.g., data-center mechanicals, trade-mart specialty buildout)', reservePctOfEgiDefault: 0.04 },
  Unknown:           { reserveKind: 'Generic capex reserve',                reserveDescription: 'unclassified asset — generic recurring capex reserve as conservative default',             reservePctOfEgiDefault: 0.025 },
  // Tier-I/II classes get profiles too for completeness, but the lever
  // doesn't fire on those tiers — these entries are never hit.
  Multifamily:       { reserveKind: 'Replacement reserve',                  reserveDescription: 'residential replacement reserve',                                                          reservePctOfEgiDefault: 0.03 },
  MHC:               { reserveKind: 'Replacement reserve',                  reserveDescription: 'manufactured-housing replacement reserve',                                                  reservePctOfEgiDefault: 0.025 },
  Industrial:        { reserveKind: 'CapEx reserve',                        reserveDescription: 'industrial building capex',                                                                 reservePctOfEgiDefault: 0.02 },
  SelfStorage:       { reserveKind: 'CapEx reserve',                        reserveDescription: 'self-storage building capex',                                                               reservePctOfEgiDefault: 0.02 },
  MixedUse:          { reserveKind: 'CapEx + TI/LC reserve (mixed-use)',    reserveDescription: 'blended capex + TI/LC for mixed-use components',                                            reservePctOfEgiDefault: 0.03 },
};

function buildInPlaceLockboxProposal(
  ai: AdjustedInputs,
  dealResult: EvaluateDealResult | undefined,
): MitigationProposal | null {
  if (!dealResult) return null;
  const acDim = dealResult.dimensions.assetClass;

  // (a) Applicability — only on RESOLVED dim 8.
  if (acDim.applicability !== 'applicable') return null;

  // (b) Trigger — Tier III or Tier IV only (the asset itself is the risk).
  if (acDim.tier !== 'III' && acDim.tier !== 'IV') return null;

  // (c) Canonical class via the enum index from derivedOutputs.
  const idx = acDim.derivedOutputs?.canonicalAssetClassIndex;
  if (typeof idx !== 'number' || idx < 0 || idx >= ASSET_CLASS_ENUM.length) return null;
  const canonicalClass = ASSET_CLASS_ENUM[idx]!;
  const profile = ASSET_CLASS_RESERVE_PROFILE[canonicalClass];
  if (!profile) return null;

  // (d) EGI source — same as v1 fund_reserve + lever 3.
  const egi = ai.income.effectiveGrossIncome.adjusted;
  if (!Number.isFinite(egi) || egi <= 0) {
    return {
      id: 'in_place_lockbox_asset_class_manual',
      principleIds: [],
      lever: 'in_place_cash_management',
      leverKind: 'in_place_cash_management',
      title: `Manual sizing required: in-place lockbox + ${profile.reserveKind} (${canonicalClass} Tier ${acDim.tier})`,
      description:
        `Asset class ${canonicalClass} sits in dim-8 Tier ${acDim.tier} — the asset itself is the risk. ` +
        `An in-place (constant, hard) lockbox with controlled distributions is recommended alongside a ` +
        `${profile.reserveKind} (${profile.reserveDescription}). EGI is missing or non-positive on the ` +
        `underwriting model — cannot size the reserve at the calibration default ` +
        `(${(profile.reservePctOfEgiDefault * 100).toFixed(1)}% of EGI). Provide EGI to size, or size manually.`,
      structuralChanges: ['Sizing requires manual analyst input — see description.'],
      addressesDimensions: ['asset-class'],
      riskReduction: 'marginal',
      severity: 'medium',
    };
  }

  // (e) Asset-specific reserve sizing (CALIBRATION default).
  const reserveAmount = egi * profile.reservePctOfEgiDefault;

  // Severity from Tier.
  const severity: Severity =
    acDim.tier === 'IV' && (canonicalClass === 'Mall' || canonicalClass === 'SpecialtyAtypical') ? 'critical' :
    acDim.tier === 'IV' ? 'high' :
    'high';
  const riskReduction: RiskReduction =
    acDim.tier === 'IV' ? 'significant' : 'moderate';

  const subsumptionNote =
    ' COORDINATION NOTE: when a tenant-concentration springing cash trap (lever 3) fires on the same ' +
    'deal, this in-place lockbox SUBSUMES the springing trigger — cash is already controlled at all ' +
    'times under the in-place mechanism, so the tenant-specific trigger is moot. Both proposals are ' +
    'emitted for review; a human reconciles the overlap. (Lever composition / reconciliation is a v2 ' +
    'pending limitation.)';

  return {
    id: 'in_place_lockbox_asset_class',
    principleIds: [],
    lever: 'in_place_cash_management',
    leverKind: 'in_place_cash_management',
    title: `In-place cash management (hard lockbox) — ${canonicalClass} Tier ${acDim.tier}`,
    description:
      `Asset class ${canonicalClass} (dim-8 Tier ${acDim.tier}; risk contribution ${(acDim.riskContribution ?? 0).toFixed(2)}) — ` +
      `the asset itself is the risk, not a tenant-specific event. Recommend IN-PLACE (constant, hard) ` +
      `cash management from closing: all cash from operations sweeps into a controlled account, ` +
      `distributions to the sponsor are CONDITIONAL on (i) debt-service + reserves funded current, ` +
      `(ii) DSCR / occupancy tests met, (iii) no covenant trigger active. Distinct from lever 3 ` +
      `(springing): the lockbox is in-place from day one because the asset CLASS drives the risk, ` +
      `not a specific tenant event. Pair with a ${profile.reserveKind} sized at ` +
      `${(profile.reservePctOfEgiDefault * 100).toFixed(1)}% of EGI = $${(reserveAmount / 1_000_000).toFixed(2)}M ` +
      `(${profile.reserveDescription}; CALIBRATION default — analyst can resize per the deal's PCA / ` +
      `lease-up profile). The reserve is recurring / escrowed alongside the lockbox; the lockbox releases ` +
      `funds for the reserve before sponsor distributions.${subsumptionNote}`,
    structuralChanges: [
      'In-place (hard) lockbox from closing: all rents + receipts sweep into a controlled account',
      'Controlled distributions to sponsor — released after debt service + reserves + DSCR/occupancy tests',
      'No springing trigger required — the mechanism is constant because the asset class drives the risk',
      `${profile.reserveKind} (CALIBRATION ${(profile.reservePctOfEgiDefault * 100).toFixed(1)}% of EGI): $${(reserveAmount / 1_000_000).toFixed(2)}M recurring escrow alongside the lockbox`,
      'Reserve funded before sponsor distributions; covenant-driven release schedule + analyst-resizable',
    ],
    requiredReserve: reserveAmount,
    coverageStatement:
      `${profile.reserveKind} sized at ${(profile.reservePctOfEgiDefault * 100).toFixed(1)}% of EGI ` +
      `(CALIBRATION default). Recurring escrow alongside the in-place lockbox; funded before sponsor distributions.`,
    addressesDimensions: ['asset-class'],
    riskReduction,
    severity,
  };
}

export { buildInPlaceLockboxProposal };

/* --------- condition_precedent — coverage-gate (v2 lever 5) --------- */
/*
 * The simplest structural lever — purely structural-term, NO dollar.
 * When ≥ 1 dimension is HITL (missing data prevented underwriting it),
 * enumerate the gaps and emit conditions precedent: "provide [data] so
 * [dim] can be underwritten; do not close until delivered."
 *
 * Trigger: ≥ 1 peer dim in `dealResult.dimensions` has
 *          applicability === 'hitl-needed'. Dim 9 (sponsor) HITL is
 *          part of this set — it's the COMPLEMENT of lever 2
 *          (guaranty): missing sponsor data → CP; resolved + risk-
 *          increasing sponsor data → guaranty. No overlap.
 *
 * Boundary:
 *   - Severity escalates when (a) the COVERAGE GATE FIRED — i.e.,
 *     final rating = InsufficientData — OR (b) the SPINE (dim 7
 *     cap-rate / valuation stress) is HITL (everything else sizes
 *     off it). Either case is `critical`.
 *   - 2+ peer dims HITL → `high`.
 *   - 1 non-spine peer HITL → `medium`.
 *
 * Reading the corpus: dim 9 is universally HITL on the CMBS backbone
 * corpus (no sponsor data in filings). On real deals with full
 * underwriting packages, the lever fires selectively per actually-
 * missing items.
 *
 * Fence: reads ONLY dealResult.dimensions.* (per-dim applicability)
 * and dealResult.rating (coverage-gate state). NO judgment, NO
 * AdjustedInputs, NO valuationConclusion, NO handbook.
 */
interface MissingDocSpec {
  readonly dimId: string;
  readonly dimLabel: string;
  readonly missingDoc: string;
  readonly unlocks: string;
}

/**
 * Map clean-doctrine dimensionId → the missing data / documentation
 * that would resolve it. Used by lever 5 to translate HITL state into
 * actionable closing conditions.
 */
const HITL_TO_MISSING_DOC: Readonly<Record<string, MissingDocSpec>> = {
  'cap-rate-valuation-stress': {
    dimId: 'cap-rate-valuation-stress',
    dimLabel: 'cap-rate / valuation (SPINE)',
    missingDoc: 'appraisal / ASR (concluded value) + operating statements (issuer underwritten NOI)',
    unlocks: 'stressed value — every other ratio sizes off it',
  },
  'leverage-ltv': {
    dimId: 'leverage-ltv',
    dimLabel: 'leverage (LTV)',
    missingDoc: 'appraisal + loan terms (loan amount)',
    unlocks: 'stressed LTV against the doctrine\'s stressed value',
  },
  'coverage-dscr': {
    dimId: 'coverage-dscr',
    dimLabel: 'coverage (DSCR)',
    missingDoc: 'operating statements (T-12 actual + sustainable NCF inputs) + loan terms (coupon + amortization)',
    unlocks: 'stressed DSCR on sustainable NCF',
  },
  'debt-yield': {
    dimId: 'debt-yield',
    dimLabel: 'debt yield',
    missingDoc: 'operating statements (sustainable NOI) + loan amount',
    unlocks: 'debt yield against sustainable NOI',
  },
  'refinance-feasibility': {
    dimId: 'refinance-feasibility',
    dimLabel: 'refinance feasibility',
    missingDoc: 'loan terms — amortization months / IO period / term years / coupon / origination date',
    unlocks: 'maturity balance + exit DSCR / DY / LTV at the stressed refi constant',
  },
  'income-concentration': {
    dimId: 'income-concentration',
    dimLabel: 'income concentration',
    missingDoc: 'rent roll (per-tenant base rent + SF + lease term)',
    unlocks: 'top-tenant share + Herfindahl-style diversity index',
  },
  'rollover': {
    dimId: 'rollover',
    dimLabel: 'rollover within term',
    missingDoc: 'rent roll (lease expiration schedule) + loan maturity date',
    unlocks: 'share of income expiring within loan term',
  },
  'asset-class': {
    dimId: 'asset-class',
    dimLabel: 'asset class',
    missingDoc: 'asset-type confirmation (property type / subType / property name for mall detection)',
    unlocks: 'asset-class tier (Moody\'s stability ranking + KBRA/DBRS asset-specific framing)',
  },
  'sponsor-borrower-quality': {
    dimId: 'sponsor-borrower-quality',
    dimLabel: 'sponsor / borrower quality',
    missingDoc: 'sponsor financials (net worth + liquidity statements) + track record (CRE tenure, asset-class experience, prior credit events disclosure)',
    unlocks: 'sponsor judgment modifier (DBRS comparative-review ±2 notches bound)',
  },
};

function buildConditionPrecedentProposal(
  dealResult?: EvaluateDealResult,
): MitigationProposal | null {
  if (!dealResult) return null;

  // Enumerate HITL peer dims (all 9, including sponsor). Sort by canonical
  // dim order so the output is deterministic.
  const allDimIds = [
    'cap-rate-valuation-stress',
    'leverage-ltv',
    'coverage-dscr',
    'debt-yield',
    'refinance-feasibility',
    'income-concentration',
    'rollover',
    'asset-class',
    'sponsor-borrower-quality',
  ] as const;
  const dimsByName: Record<string, { applicability: string } | undefined> = {
    'cap-rate-valuation-stress':  dealResult.dimensions.capRateValuationStress,
    'leverage-ltv':               dealResult.dimensions.leverageLtv,
    'coverage-dscr':              dealResult.dimensions.coverageDscr,
    'debt-yield':                 dealResult.dimensions.debtYield,
    'refinance-feasibility':      dealResult.dimensions.refinanceFeasibility,
    'income-concentration':       dealResult.dimensions.incomeConcentration,
    'rollover':                   dealResult.dimensions.rollover,
    'asset-class':                dealResult.dimensions.assetClass,
    'sponsor-borrower-quality':   dealResult.dimensions.sponsorBorrowerQuality,
  };
  const hitlDimIds: string[] = [];
  for (const id of allDimIds) {
    const dim = dimsByName[id];
    if (dim?.applicability === 'hitl-needed') hitlDimIds.push(id);
  }
  if (hitlDimIds.length === 0) return null;

  // Severity escalation
  const coverageGateFired = dealResult.rating.recommendation === 'InsufficientData';
  const spineHitl = hitlDimIds.includes('cap-rate-valuation-stress');
  // Peer-HITL count (excluding sponsor — sponsor data is universally absent
  // on CMBS filings; counting it in the "multiple peer" tier would push
  // every CMBS deal to severity:high. Sponsor counts as a single condition.)
  const peerHitlExcludingSponsor = hitlDimIds.filter(d => d !== 'sponsor-borrower-quality').length;

  const severity: Severity =
    coverageGateFired || spineHitl ? 'critical' :
    peerHitlExcludingSponsor >= 2 ? 'high' :
    'medium';
  const riskReduction: RiskReduction = 'significant';

  // Build the specifics per HITL dim.
  const specs = hitlDimIds.map(id => HITL_TO_MISSING_DOC[id]).filter((s): s is MissingDocSpec => s !== undefined);
  if (specs.length === 0) return null;

  const structuralChanges: string[] = specs.map(s =>
    `CP — provide ${s.missingDoc} (unlocks: ${s.dimLabel}) before close`
  );

  const coverageGateClause = coverageGateFired
    ? ' The COVERAGE GATE FIRED — the doctrine returned InsufficientData rather than a rating, ' +
      'because the data missing crosses the rating threshold. Closing without resolving these ' +
      'conditions means closing without a complete underwriting.'
    : '';
  const spineClause = spineHitl
    ? ' The SPINE (dim 7 — cap-rate / valuation stress) is HITL: every other ratio in the doctrine ' +
      '(leverage, coverage, debt yield, refi) sizes off the stressed value the spine produces. Without ' +
      'the spine, the deal cannot be sized.'
    : '';

  const enumeration = specs.map(s =>
    `• ${s.dimLabel} — provide ${s.missingDoc}; unlocks ${s.unlocks}.`
  ).join('\n');

  return {
    id: 'conditions_precedent_coverage',
    principleIds: [],
    lever: 'condition_precedent',
    leverKind: 'condition_precedent',
    title: `Conditions precedent: resolve ${hitlDimIds.length} unscored dimension${hitlDimIds.length === 1 ? '' : 's'} before close`,
    description:
      `The deal could not be fully underwritten — ${hitlDimIds.length} doctrine dimension` +
      `${hitlDimIds.length === 1 ? '' : 's'} routed to HITL (missing data prevented evaluation).${coverageGateClause}${spineClause} ` +
      `Convert each gap into a closing condition precedent — the lender does not close until the borrower ` +
      `delivers the documentation that unlocks each unscored dimension. The conditions enumerated:\n${enumeration}\n` +
      `On the CMBS corpus this lever fires near-universally on sponsor data (CMBS filings do not surface ` +
      `borrower sponsor financials in structured form). On live underwriting packages the lever should ` +
      `fire selectively per actually-missing items.`,
    structuralChanges,
    addressesDimensions: hitlDimIds,
    riskReduction,
    severity,
  };
}

export { buildConditionPrecedentProposal };
