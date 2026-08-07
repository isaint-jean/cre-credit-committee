/**
 * Buyer-diff (v1) — the issuer's underwriting vs OUR buyer-adjusted underwriting,
 * per field, with the WHY. Reuses the existing `@cre/contracts` CrossCheckFinding
 * shape + the graph producer's helpers (computeDelta / computeConservatismStatus /
 * computeOverallBias). NO new scoring — this is a projection over data the judgment
 * engine already produced (AdjustedInputs raw/adjusted/adjustments + the retained
 * issuer-NOI slots).
 *
 * Two entry points:
 *   - buildBuyerDiffCrossCheck(adjustedInputs, extraction, asOf) → CrossCheckResult
 *     Wired into the graph-mint (replaces the empty findings[]). The 7 metrics the
 *     legacy producer already handles: noi, dscr, capRate, value, loanAmount,
 *     interestRate, debtService.
 *   - projectBuyerDiff(crossCheck) → BuyerDiffRow[]
 *     The read: projects findings into the three states (agreement / adjustment /
 *     can't-verify) with the per-field why. Deterministic; pure read over frozen state.
 *
 * ★ SCORE-SAFETY (the 'noi' finding). The doctrine's durability component reads
 * ONLY the 'noi' finding's `delta.vsBankPct` and expects the P-III-15 reconciliation
 * (our UW NOI vs the T-12 TRAILING ACTUAL — components.ts scoreUwVsT12Reconciliation).
 * So the 'noi' finding's `bank` is the TRAILING ACTUAL and its `delta` reproduces the
 * derived reconciliation EXACTLY — the score is byte-identical (the doctrine comment
 * calls the fill "a pure addition, not a rewrite"). The buyer-diff's ISSUER number for
 * NOI is carried separately on `rawExtracted` (the issuer's submitted UW NOI), and the
 * read compares rawExtracted↔bpFinal — never perturbing the doctrine's bank↔delta.
 */

import type {
  AdjustedInputs, AdjustmentEntry, CrossCheckDriver, CrossCheckFinding,
  CrossCheckResult, ExtractionResult, ISODateTime, SourceTier,
} from '@cre/contracts';
import { computeCrossCheckResultId } from '../util/content-hash.js';
import {
  computeDelta, computeConservatismStatus, computeOverallBias,
  type ConservativeDirection,
} from './cross-check-contracts.service.js';

/* ------------------------------- the producer ------------------------------ */

/** One metric's raw materials, read straight off AdjustedInputs + extraction. */
interface MetricInputs {
  readonly metric: string;
  /** DOCTRINE reference tier (for 'noi' this is the trailing actual so the score
   *  is byte-identical; for others it equals the issuer value). null → the doctrine
   *  falls back to its derived path. */
  readonly bankValue: number | null;
  /** The ISSUER's submitted value (the buyer-diff "their number"). */
  readonly issuerValue: number | null;
  /** OUR judgment-adjusted / final value. */
  readonly ourValue: number | null;
  readonly conservativeDirection: ConservativeDirection;
  /** The WHY — the judgment adjustments that moved this field. */
  readonly drivers: readonly CrossCheckDriver[];
}

const ISSUER_SOURCE: SourceTier = 'SELLER_UW';

function driversFrom(input: string, adjustments: readonly AdjustmentEntry[]): CrossCheckDriver[] {
  return adjustments.map((a) => ({ input, change: a.delta, reason: a.reason, ruleId: a.ruleId }));
}

/** Assemble the 7 metric inputs from the frozen judgment output. */
function collectMetricInputs(ai: AdjustedInputs, ex: ExtractionResult): MetricInputs[] {
  const m = ai.metrics;
  const issuerNoi = m.issuerStatedNoiSellerUw ?? m.issuerStatedNoiAsr ?? m.trailingActualNoi ?? m.inPlaceNoi;
  return [
    {
      metric: 'noi',
      // ★ bank = TRAILING ACTUAL → the doctrine's uwVsT12 reads delta vs this and
      // gets the byte-identical derived reconciliation. Issuer number rides on rawExtracted.
      bankValue: m.trailingActualNoi,
      issuerValue: issuerNoi,
      ourValue: m.noi,
      conservativeDirection: 'lower',
      // The money shot's WHY. NOI is DERIVED (EGI − opex), so the reasons our NOI
      // differs from the issuer's are the constituent judgment adjustments — the
      // vacancy raised to a floor, the expenses raised to a market ratio, income
      // recovery — plus any top-level NOI cap. Aggregate them so the NOI row carries
      // the full "why we didn't accept their NOI".
      drivers: [
        ...driversFrom('income.grossRentalIncome', ai.income.grossRentalIncome.adjustments),
        ...driversFrom('income.vacancyPct', ai.income.vacancyPct.adjustments),
        ...driversFrom('income.effectiveGrossIncome', ai.income.effectiveGrossIncome.adjustments),
        ...driversFrom('expenses.totalOperatingExpenses', ai.expenses.totalOperatingExpenses.adjustments),
        ...driversFrom('metrics.noi', ai.topLevelAdjustments),
      ],
    },
    {
      metric: 'dscr',
      bankValue: ex.annexA?.uwDscr ?? null,
      issuerValue: ex.annexA?.uwDscr ?? null,
      ourValue: m.dscr,
      conservativeDirection: 'lower',
      drivers: [], // derived from NOI ÷ debt service — see those rows for the why.
    },
    {
      metric: 'capRate',
      bankValue: ai.assumptions.capRate.raw ?? ex.asr?.impliedCapRate ?? null,
      issuerValue: ai.assumptions.capRate.raw ?? ex.asr?.impliedCapRate ?? null,
      ourValue: ai.assumptions.capRate.adjusted,
      conservativeDirection: 'higher',
      drivers: driversFrom('assumptions.capRate', ai.assumptions.capRate.adjustments),
    },
    {
      metric: 'value',
      bankValue: ex.asr?.impliedValue ?? ex.appraisal?.asIsValue ?? null,
      issuerValue: ex.asr?.impliedValue ?? ex.appraisal?.asIsValue ?? null,
      ourValue: m.value,
      conservativeDirection: 'lower',
      drivers: [], // derived = NOI ÷ capRate — the why is on the noi + capRate rows.
    },
    {
      metric: 'loanAmount',
      bankValue: ai.loan.loanAmount.raw,
      issuerValue: ai.loan.loanAmount.raw,
      ourValue: ai.loan.loanAmount.adjusted,
      conservativeDirection: 'lower',
      drivers: driversFrom('loan.loanAmount', ai.loan.loanAmount.adjustments),
    },
    {
      metric: 'interestRate',
      bankValue: ai.loan.interestRate.raw,
      issuerValue: ai.loan.interestRate.raw,
      ourValue: ai.loan.interestRate.adjusted,
      conservativeDirection: 'higher',
      drivers: driversFrom('loan.interestRate', ai.loan.interestRate.adjustments),
    },
    {
      metric: 'debtService',
      bankValue: ai.loan.debtServiceAnnual.raw,
      issuerValue: ai.loan.debtServiceAnnual.raw,
      ourValue: ai.loan.debtServiceAnnual.adjusted,
      conservativeDirection: 'higher',
      drivers: driversFrom('loan.debtServiceAnnual', ai.loan.debtServiceAnnual.adjustments),
    },
  ];
}

function buildFinding(mi: MetricInputs): CrossCheckFinding {
  return {
    metric: mi.metric,
    // DOCTRINE frame: delta is vs `bank`. For noi, bank = trailing actual.
    bank: { value: mi.bankValue, source: ISSUER_SOURCE },
    // BUYER-DIFF frame: the issuer's SUBMITTED value.
    rawExtracted: { value: mi.issuerValue, source: ISSUER_SOURCE },
    adjusted: { value: mi.ourValue },
    bpFinal: { value: mi.ourValue },
    drivers: mi.drivers,
    delta: computeDelta(mi.bankValue, mi.ourValue),
    conservatismStatus: computeConservatismStatus(mi.bankValue, mi.ourValue, mi.conservativeDirection),
  };
}

/**
 * The graph-mint producer — populates CrossCheckResult.findings from the frozen
 * AdjustedInputs. Additive to the eval: it does not change any score (the 'noi'
 * finding reproduces the doctrine's derived reconciliation exactly).
 */
export function buildBuyerDiffCrossCheck(
  adjustedInputs: AdjustedInputs,
  extraction: ExtractionResult,
  analysisAsOfDate: ISODateTime,
): CrossCheckResult {
  const findings = collectMetricInputs(adjustedInputs, extraction).map(buildFinding);
  const body = {
    analysisAsOfDate,
    adjustedInputsId: adjustedInputs.id,
    findings,
    overallAdjustmentBias: computeOverallBias(findings),
  };
  return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
}

/* --------------------------------- the read -------------------------------- */

export type BuyerDiffState = 'agreement' | 'adjustment' | 'cant-verify';

export interface BuyerDiffRow {
  readonly metric: string;
  readonly state: BuyerDiffState;
  /** The issuer's submitted number (their underwriting). */
  readonly issuer: number | null;
  /** Our buyer-adjusted number. */
  readonly ours: number | null;
  /** ours − issuer (absolute), and as a fraction of |issuer|. null when unmeasurable. */
  readonly delta: number | null;
  readonly deltaPct: number | null;
  /** The per-field WHY — the judgment adjustments that moved the number. Empty in
   *  AGREEMENT; empty on a derived metric (why is on its constituents). */
  readonly why: readonly CrossCheckDriver[];
  /** Directional conservatism of OUR number vs the issuer (from the finding). */
  readonly conservatism: CrossCheckFinding['conservatismStatus'];
}

/** Agreement threshold — |deltaPct| at or below this reads as "buyer accepts as-is". */
const AGREEMENT_EPS = 0.005; // 0.5%

/** Which direction is CONSERVATIVE for the buyer, per metric (lower value / higher rate). */
const CONSERVATIVE_DIR: Record<string, ConservativeDirection> = {
  noi: 'lower', dscr: 'lower', value: 'lower', loanAmount: 'lower',
  capRate: 'higher', interestRate: 'higher', debtService: 'higher',
};

/**
 * Project the frozen CrossCheckResult into the three buyer-diff states. The
 * ISSUER number is `rawExtracted` (their submission); OURS is `bpFinal`. The delta
 * is computed issuer↔ours here (NOT the finding's `delta`, which is the doctrine's
 * bank-framed reconciliation). Honest: can't-verify never collapses into agreement.
 */
export function projectBuyerDiff(crossCheck: CrossCheckResult): BuyerDiffRow[] {
  return crossCheck.findings.map((f) => {
    const issuer = f.rawExtracted.value;
    const ours = f.bpFinal.value;
    const measurable = issuer !== null && ours !== null;
    const delta = measurable ? ours - issuer : null;
    const deltaPct = measurable && issuer !== 0 ? (ours - issuer) / Math.abs(issuer) : null;

    let state: BuyerDiffState;
    if (!measurable) {
      // The insufficient-data honesty state — the issuer asserts something we
      // can't source, or we couldn't produce a number. Never "agreement".
      state = 'cant-verify';
    } else if (f.drivers.length === 0 && (deltaPct === null || Math.abs(deltaPct) <= AGREEMENT_EPS)) {
      state = 'agreement';
    } else {
      state = 'adjustment';
    }

    // Conservatism framed ISSUER↔OURS (the buyer-diff meaning) — NOT the finding's
    // `conservatismStatus`, which for 'noi' is the doctrine's bank↔ours (trailing-actual)
    // frame and can read INSUFFICIENT_DATA even on a clear adjustment.
    const dir = CONSERVATIVE_DIR[f.metric] ?? 'lower';
    const conservatism = computeConservatismStatus(issuer, ours, dir);

    return { metric: f.metric, state, issuer, ours, delta, deltaPct, why: f.drivers, conservatism };
  });
}
