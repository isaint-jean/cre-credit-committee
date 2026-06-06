/**
 * NOI divergence vs trailing-12 actual (Batch — 2026-06-06, judgment engine v1.8).
 *
 * Fires JE_NOI_BELOW_TRAILING_ACTUAL when:
 *   trailingActualNoi (from extraction.t12Actual.noi) is present, AND
 *   finalNoi < trailingActualNoi × (1 − NOI_DIVERGENCE_THRESHOLD).
 *
 * The 20% threshold reflects desk judgment: cumulative library floors + extraction-induced
 * conservatism can reasonably suppress concluded NOI by ~10-15% vs trailing actuals without
 * the deal being mis-underwritten; beyond 20% the gap is structural and warrants explicit
 * review (the engine's conservatism may have piled too high, OR the trailing actuals contain
 * non-recurring income that shouldn't carry forward). Either way, the analyst should look.
 *
 * Distinct from JE_NOI_CAPPED_TO_BANK (noi-cap.ts): the cap is upper-bound (derived ≤ bank);
 * this flag is a lower-bound REVIEW signal (concluded is materially BELOW trailing). v1.0
 * is informational — the conclusion stands, the flag surfaces in narrative + render.
 *
 * Threshold versioning: NOI_DIVERGENCE_THRESHOLD is NOT in buildJudgmentEngineHashSnapshot
 * ({rules, missingDocPenalties, distrustPenalties}). Same convention as cap-rate-stress
 * desk constants (ROLLOVER_HEAVY_THRESHOLD etc. in apply-cap-rate-stress.ts). Changing this
 * value MUST be accompanied by a manual JUDGMENT_ENGINE_VERSION bump per the workflow in
 * packages/contracts/src/judgment-engine-manifest.ts (the rule registry won't move the hash
 * on a numeric change, so boot-check will NOT catch a silent re-tune).
 *
 * Reference NOI is t12Actual.noi ONLY — not the bankNoi cascade. Trailing-twelve actuals
 * are the strongest evidence available; inPlace and sellerUw are seller projections that
 * carry their own biases and would dilute the signal.
 */

export const NOI_DIVERGENCE_THRESHOLD = 0.20 as const;

export interface NoiDivergenceResult {
  /** True when finalNoi is materially below trailingActualNoi (shortfall ≥ threshold). */
  readonly flagged: boolean;
  /** (trailingActualNoi − finalNoi) / trailingActualNoi. Positive = below reference. */
  readonly shortfallPct: number;
}

/**
 * Returns null when no reference NOI is available (t12Actual.noi null).
 * Otherwise returns { flagged, shortfallPct }.
 */
export function checkNoiDivergence(args: {
  readonly derivedNoi: number;
  readonly trailingActualNoi: number | null;
}): NoiDivergenceResult | null {
  if (args.trailingActualNoi === null) return null;
  if (args.trailingActualNoi <= 0) return null;
  const shortfallPct = (args.trailingActualNoi - args.derivedNoi) / args.trailingActualNoi;
  return {
    flagged: shortfallPct >= NOI_DIVERGENCE_THRESHOLD,
    shortfallPct,
  };
}
