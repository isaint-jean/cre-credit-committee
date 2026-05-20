/**
 * NOI ceiling enforcement (architecture §6, audit §9).
 *
 *   "adjusted NOI cannot exceed bank NOI without explicit driver justification recorded in
 *    `adjustments[]`."
 *
 * v1.0: cap is unconditional. If derived NOI exceeds bank NOI, lower to bank NOI and emit
 * `JE_NOI_CAPPED_TO_BANK` into `AdjustedInputs.topLevelAdjustments`. v1.1 may accept rule-id
 * justifications that allow exceedance.
 *
 * If `bankNoi` is null (no T-12 and no seller UW NOI), no cap can be applied — the engine
 * doesn't fail, but the missing-doc penalty already fired upstream.
 */

import type { AdjustmentEntry } from '@cre/contracts';

export interface NoiCapResult {
  /** Final NOI value after cap (may equal `derivedNoi` if no cap fired). */
  readonly capped: number;
  /** AdjustmentEntry to append to `topLevelAdjustments`, or null if cap didn't fire. */
  readonly entry: AdjustmentEntry | null;
}

export function applyNoiCap(args: {
  readonly derivedNoi: number;
  readonly bankNoi: number | null;
}): NoiCapResult {
  if (args.bankNoi === null) {
    return { capped: args.derivedNoi, entry: null };
  }
  if (args.derivedNoi <= args.bankNoi) {
    return { capped: args.derivedNoi, entry: null };
  }
  const delta = args.bankNoi - args.derivedNoi; // negative; we lowered NOI
  return {
    capped: args.bankNoi,
    entry: {
      ruleId: 'JE_NOI_CAPPED_TO_BANK',
      delta,
      reason: `derived NOI ${args.derivedNoi} exceeded bank NOI ${args.bankNoi}; capped to bank`,
    },
  };
}
