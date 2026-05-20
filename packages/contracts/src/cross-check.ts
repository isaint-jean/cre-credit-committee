/**
 * CrossCheckResult — stage-7 producer output.
 *
 * Architecture contract §7: driver-only, no prose. Each finding compares four values for a given
 * metric (bank UW, raw extraction, adjusted/judgment, BPSpiral final), records the drivers that
 * explain the deltas, and labels conservatism status. `generateCommentary` and any templated
 * narrative are forbidden.
 *
 * Doctrine §5 (`UW_VS_T12_NOI_RECONCILIATION`) MUST bind to `findings[].deltaVsBankPct` and
 * `overallAdjustmentBias` — never recompute the delta from raw inputs.
 */

import type {
  AdjustedInputsId,
  CrossCheckResultId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { SourceTier } from './source-tier.js';
import type { JudgmentEngineRuleId } from './judgment-engine-rules.js';
import type { CreditManifestoRuleId } from './manifesto.js';

export const CONSERVATISM_STATUSES = [
  'CONSERVATIVE',
  'NON_CONSERVATIVE',
  'NEUTRAL',
  // Batch 6.2 (audit U17): explicit "we could not compare" state. Distinct from NEUTRAL
  // (which means "we compared and found no skew"). Mapping null comparisons to NEUTRAL
  // mis-attributes "no comparison" as "no skew" — silent risk-washing.
  'INSUFFICIENT_DATA',
] as const;
export type ConservatismStatus = (typeof CONSERVATISM_STATUSES)[number];

export const ADJUSTMENT_BIASES = [
  'conservative',
  'neutral',
  'aggressive',
  // Batch 6.2 (audit U6): downgrade verdict when any finding has unmeasurable variance.
  // Distinct from 'neutral' — bubbles up via render badges to surface the degraded state.
  'INSUFFICIENT_DATA',
] as const;
export type AdjustmentBias = (typeof ADJUSTMENT_BIASES)[number];

export interface CrossCheckDriver {
  readonly input: string;                          // line-item path (e.g., "income.vacancyPct")
  readonly change: number;                         // signed; the contribution to the delta
  readonly reason: string;                         // bounded reason text (judgment-engine catalogue)
  readonly ruleId: JudgmentEngineRuleId | CreditManifestoRuleId;
}

export interface CrossCheckFinding {
  readonly metric: string;                         // 'noi' | 'dscr' | 'capRate' | 'value' | 'loanAmount' | 'interestRate' | 'debtService'

  readonly bank: { readonly value: number | null; readonly source: SourceTier };
  readonly rawExtracted: { readonly value: number | null; readonly source: SourceTier };
  readonly adjusted: { readonly value: number | null };
  readonly bpFinal: { readonly value: number | null };

  readonly drivers: readonly CrossCheckDriver[];

  readonly delta: {
    readonly vsBank: number | null;                // absolute
    readonly vsBankPct: number | null;             // fraction
  };

  readonly conservatismStatus: ConservatismStatus;
}

export interface CrossCheckResult {
  readonly id: CrossCheckResultId;
  readonly analysisAsOfDate: ISODateTime;
  readonly adjustedInputsId: AdjustedInputsId;

  readonly findings: readonly CrossCheckFinding[];
  readonly overallAdjustmentBias: AdjustmentBias;
}
