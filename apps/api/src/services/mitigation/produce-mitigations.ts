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

/* ----------------------------- desk constants ----------------------------- */

export interface MitigationDeskConstants {
  /** DSCR target the lever solves toward (e.g., 1.25x). */
  readonly T_DSCR: number;
  /** Debt-yield floor target (decimal, e.g., 0.085 = 8.5%). */
  readonly T_DY: number;
  /** LTV ceiling target (decimal, e.g., 0.65 = 65%). */
  readonly T_LTV: number;
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
  T_LTV: 0.65,
  T_ROLLOVER: 0.20,
  COVERAGE_FACTOR: 0.75,
  MATERIALITY_MIN_PROCEEDS_CUT_PCT: 0.02,
};

/** Sane reserve ceiling (clamped + flagged in the description if it binds). */
const RESERVE_CAP_USD = 25_000_000;

/* ----------------- principle-enrichment table (handbook today) ------------ */
// Today's deterministic handbook has these principles whose firing would
// corroborate a metric breach. Coverage is intentionally thin (the recon
// flagged this — see doctrine v1.2 §7 v1.1/open). When the handbook later
// grows generic DSCR/DY/LTV/rollover principles, expand here.
const PRINCIPLES_BY_METRIC: Record<MitigationTargetMetric, readonly string[]> = {
  dscr:      ['P-IV-SS-4', 'P-IV-OFF-6'],
  debtYield: ['P-IV-SS-3', 'P-IV-RET-5'],
  ltv:       [],
};
const ROLLOVER_PRINCIPLES: readonly string[] = [];

/* --------------------------------- API ---------------------------------- */

export interface ProduceMitigationsArgs {
  readonly adjustedInputs: AdjustedInputs;
  readonly uwModel: UnderwritingModel;
  readonly firedFlags: readonly FiredFlag[];
  readonly desk?: MitigationDeskConstants;
}

export function produceMitigations(args: ProduceMitigationsArgs): MitigationProposal[] {
  const desk = args.desk ?? DEFAULT_MITIGATION_DESK;
  const proposals: MitigationProposal[] = [];

  const reduceProp = buildReduceProceedsProposal(args.adjustedInputs, args.uwModel, args.firedFlags, desk);
  if (reduceProp !== null) proposals.push(reduceProp);

  const reserveProp = buildFundReserveProposal(args.adjustedInputs, args.firedFlags, desk);
  if (reserveProp !== null) proposals.push(reserveProp);

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
  // LTV against impliedValue: not on AdjustedInputs (only ltvAppraisal lives
  // there; appraisal is rare). Compute from currentLoan / impliedValue.
  const ltv = impliedValue > 0 ? currentLoan / impliedValue : null;

  // Detect breach without yet sizing.
  const dscrBreached =      dscr        !== null && dscr     < desk.T_DSCR;
  const debtYieldBreached = debtYield   !== null && debtYield < desk.T_DY;
  const ltvBreached =       ltv         !== null && ltv      > desk.T_LTV;
  const anyBreach = dscrBreached || debtYieldBreached || ltvBreached;
  if (!anyBreach) return null;

  // Sizing prerequisites for any breached target.
  const canSizeDscr      = noi > 0 && rateDecimal > 0;
  const canSizeDebtYield = noi > 0;
  const canSizeLtv       = impliedValue > 0;
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
    breaches.push({ metric: 'ltv', lPrime: desk.T_LTV * impliedValue });
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

  return {
    id: 'reduce_proceeds_' + binding.metric,
    principleIds,
    lever: 'reduce_proceeds',
    leverKind: 'recalc_delta',
    title: 'Reduce loan proceeds to satisfy ' + targetLabel + ' target',
    description:
      'Concluded ' + targetLabel + ' = ' + formatMetric(binding.metric, beforeVal) +
      ' breaches the ' + targetLabel + ' target of ' + formatMetric(binding.metric, targetVal) + '. ' +
      'Lowering proceeds from ' + fmtUsd(currentLoan) + ' to ' + fmtUsd(lPrime) +
      ' (sponsor fills ' + fmtUsd(requiredEquity) + ') brings ' + targetLabel +
      ' to ' + formatMetric(binding.metric, afterVal) + '.',
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
    'funds ~' + (desk.COVERAGE_FACTOR * 12).toFixed(0) +
    ' months of TI/LC on ' + (pctRollover * 100).toFixed(1) + '% rollover-exposed income';

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
  return desk.T_LTV;
}

function beatsOnTarget(metric: MitigationTargetMetric, before: RecalcSnapshot, after: RecalcSnapshot): boolean {
  const b = pickMetric(metric, before);
  const a = pickMetric(metric, after);
  if (b === null || a === null) return false;
  // DSCR / DY are minima (raise is good). LTV is a ceiling (drop is good).
  return metric === 'ltv' ? a < b : a > b;
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
