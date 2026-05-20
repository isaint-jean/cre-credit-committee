/**
 * Cross-check producer (contract-shape).
 *
 * Produces `CrossCheckResult` from `@cre/contracts` — driver-only, no prose, no severity,
 * no formatted strings. Architecture contract §7 forbids narrative output here; this is the
 * shape that satisfies it.
 *
 * Runs parallel to the legacy `cross-check.service.ts` during rollout (architecture contract §9).
 * Eventually the legacy service is deleted when all consumers migrate to this output shape.
 *
 * Input gaps vs. the locked ideal:
 *   - Drivers: the judgment engine is the producer of `drivers[]`. Until that lands, drivers are
 *     empty arrays. The cross-check captures the four-tier value comparison and conservatism
 *     status; driver decomposition is filled in by the judgment engine.
 *   - bank vs rawExtracted: legacy seller materials don't separate "bank's UW summary" from
 *     "what we extracted from seller documents." Both tiers receive the same value with
 *     `source: 'SELLER_UW'`. When real raw-extraction lands, the two will diverge.
 *   - adjusted vs bpFinal: legacy `UnderwritingModel` is a single number per metric. Both tiers
 *     receive the same value. When `applyJudgmentAdjustments()` lands, AdjustedInputs.metrics.*
 *     supplies adjusted; bpFinal stays as the post-pipeline number.
 */

import type {
  AdjustedInputsId,
  AdjustmentBias,
  ConservatismStatus,
  CrossCheckFinding,
  CrossCheckResult,
  ISODateTime,
} from '@cre/contracts';
import type { SellerExtractedMetrics, UnderwritingModel } from '@cre/shared';
import { computeCrossCheckResultId } from '../util/content-hash.js';

/**
 * Comparison spec — declared statically so the metric set is auditable in one place. Order is
 * preserved into `findings[]` so byte-identical inputs produce byte-identical outputs.
 */
type ConservativeDirection = 'lower' | 'higher';

interface MetricSpec {
  readonly metric: string;                        // canonical key, not display name
  readonly bankValue: number | null;
  readonly bpValue: number | null;
  readonly conservativeDirection: ConservativeDirection;
}

export function buildCrossCheckResult(args: {
  readonly sellerMetrics: SellerExtractedMetrics;
  readonly uwModel: UnderwritingModel;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly analysisAsOfDate: ISODateTime;
}): CrossCheckResult {
  const { sellerMetrics, uwModel, adjustedInputsId, analysisAsOfDate } = args;

  const specs: readonly MetricSpec[] = [
    { metric: 'noi',          bankValue: sellerMetrics.noi.value,           bpValue: uwModel.netOperatingIncome, conservativeDirection: 'lower'  },
    { metric: 'dscr',         bankValue: sellerMetrics.dscr.value,          bpValue: uwModel.dscr,               conservativeDirection: 'lower'  },
    { metric: 'capRate',      bankValue: sellerMetrics.capRate.value,       bpValue: uwModel.capRate,            conservativeDirection: 'higher' },
    { metric: 'value',        bankValue: sellerMetrics.propertyValue.value, bpValue: uwModel.impliedValue,       conservativeDirection: 'lower'  },
    { metric: 'loanAmount',   bankValue: sellerMetrics.loanAmount.value,    bpValue: uwModel.loanAmount,         conservativeDirection: 'lower'  },
    { metric: 'interestRate', bankValue: sellerMetrics.interestRate.value,  bpValue: uwModel.interestRate,       conservativeDirection: 'higher' },
    { metric: 'debtService',  bankValue: sellerMetrics.debtService.value,   bpValue: uwModel.annualDebtService,  conservativeDirection: 'higher' },
  ];

  const findings: CrossCheckFinding[] = specs.map(spec => buildFinding(spec));
  const overallAdjustmentBias = computeOverallBias(findings);

  const body = {
    analysisAsOfDate,
    adjustedInputsId,
    findings,
    overallAdjustmentBias,
  };
  return { id: computeCrossCheckResultId(body), ...body } as CrossCheckResult;
}

function buildFinding(spec: MetricSpec): CrossCheckFinding {
  const { metric, bankValue, bpValue, conservativeDirection } = spec;

  const delta = computeDelta(bankValue, bpValue);
  const conservatismStatus = computeConservatismStatus(bankValue, bpValue, conservativeDirection);

  // Legacy data path collapses bank↔rawExtracted and adjusted↔bpFinal — see file header.
  // SourceTier defaults: 'SELLER_UW' for bank/raw (whatever the bank/seller submitted);
  // adjusted/bpFinal are post-pipeline numbers and don't carry an originating source tier.
  return {
    metric,
    bank:         { value: bankValue, source: 'SELLER_UW' },
    rawExtracted: { value: bankValue, source: 'SELLER_UW' },
    adjusted:     { value: bpValue },
    bpFinal:      { value: bpValue },
    drivers:      [],   // judgment engine populates when it lands
    delta,
    conservatismStatus,
  };
}

function computeDelta(
  bank: number | null,
  bp: number | null,
): { vsBank: number | null; vsBankPct: number | null } {
  if (bank === null || bp === null) {
    return { vsBank: null, vsBankPct: null };
  }
  const vsBank = bp - bank;
  const vsBankPct = bank !== 0 ? vsBank / Math.abs(bank) : null;     // fraction, not percent
  return { vsBank, vsBankPct };
}

function computeConservatismStatus(
  bank: number | null,
  bp: number | null,
  conservativeDirection: ConservativeDirection,
): ConservatismStatus {
  // Batch 6.2 (audit U17): when either side is null, the comparison did not happen.
  // 'NEUTRAL' is a meaningful business outcome ("we compared and found no skew"); applying
  // it to a non-comparison silently mis-attributes "no comparison" as "no skew."
  if (bank === null || bp === null) return 'INSUFFICIENT_DATA';
  if (Math.abs(bp - bank) <= 0.001) return 'NEUTRAL';
  const bpIsLower = bp < bank;
  if (conservativeDirection === 'lower') {
    return bpIsLower ? 'CONSERVATIVE' : 'NON_CONSERVATIVE';
  }
  return bpIsLower ? 'NON_CONSERVATIVE' : 'CONSERVATIVE';
}

/**
 * Net bias across all findings — weighted by absolute pct-variance.
 *
 * Batch 6.2 (audit U6 contract path): explicitly skip findings with null variance and
 * downgrade verdict to 'INSUFFICIENT_DATA' if more than 1/3 of findings are unmeasurable.
 * Previously the legacy `?? 0` silently zero-weighted nulls — risk-washing deals where
 * comparisons could not be performed.
 */
export function computeOverallBias(
  findings: readonly CrossCheckFinding[],
): AdjustmentBias {
  let conservativeWeight = 0;
  let nonConservativeWeight = 0;
  let unmeasurableCount = 0;

  for (const f of findings) {
    if (f.delta.vsBankPct === null || f.conservatismStatus === 'INSUFFICIENT_DATA') {
      unmeasurableCount++;
      continue;
    }
    const w = Math.abs(f.delta.vsBankPct);
    if (f.conservatismStatus === 'CONSERVATIVE') conservativeWeight += w;
    else if (f.conservatismStatus === 'NON_CONSERVATIVE') nonConservativeWeight += w;
  }

  if (findings.length > 0 && unmeasurableCount * 3 >= findings.length) {
    return 'INSUFFICIENT_DATA';
  }

  const total = conservativeWeight + nonConservativeWeight;
  if (total < 0.01) return 'neutral';

  const ratio = conservativeWeight / total;
  if (ratio > 0.6) return 'conservative';
  if (ratio < 0.4) return 'aggressive';
  return 'neutral';
}
