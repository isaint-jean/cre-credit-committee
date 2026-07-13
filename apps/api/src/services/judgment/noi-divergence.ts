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
 * Threshold versioning (v1.10): NOI_DIVERGENCE_THRESHOLD is folded into the
 * `deskConstants` key of buildJudgmentEngineHashSnapshot (judgment-engine-boot-check.ts).
 * A silent re-tune of this value moves the engine-state hash and trips
 * JUDGMENT_ENGINE_HASH_DRIFT at boot — the manual-bump convention is replaced
 * by an automatic forcing function. Changes still require bumping
 * JUDGMENT_ENGINE_VERSION and appending a manifest entry; the boot check
 * catches the omission.
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

/**
 * ★ ASR-NOI cross-check (2026-07-12 — the 640/Yardi remediation P2 seed).
 *
 * The ASR discloses the issuer's own stated UNDERWRITTEN NOI (extraction.asr
 * .underwrittenNOI — captured today but historically never compared against the
 * engine's concluded NOI). This is the arithmetic that would have CAUGHT the
 * 640 stub: the engine concluded $8.3M while the ASR plainly states $56.2M — a
 * 6.8× gap, an unmistakable extraction failure — yet nothing flagged it.
 *
 * This is a SYMMETRIC divergence (either direction is a red flag): a concluded
 * NOI far BELOW the ASR's disclosed NOI means the income extraction under-read
 * (the 640 case); far ABOVE means the engine is more aggressive than the issuer
 * (the analyst should also look). The magnitude ratio (larger / smaller) is
 * compared against a hard threshold; ≥ 2× is structural — no legitimate
 * conservatism gap is that wide.
 *
 * This is a REVIEW signal (like checkNoiDivergence), not a hard halt: the
 * concluded NOI stands, but the flag surfaces the contradiction so a stub NOI
 * cannot be silently published against an ASR that says otherwise.
 */
export const ASR_NOI_DIVERGENCE_RATIO = 2.0 as const;

export interface AsrNoiDivergenceResult {
  /** True when concluded and ASR-disclosed NOI diverge by ≥ ASR_NOI_DIVERGENCE_RATIO×. */
  readonly flagged: boolean;
  /** max(concluded, asr) / min(concluded, asr) — always ≥ 1. */
  readonly ratio: number;
  /** true when concluded < asr (the under-read direction, the 640 case). */
  readonly concludedBelow: boolean;
}

/**
 * Returns null when no ASR-disclosed NOI is available (or non-positive), or when
 * the concluded NOI is non-positive. Otherwise returns the symmetric divergence.
 */
export function checkAsrNoiDivergence(args: {
  readonly derivedNoi: number;
  readonly asrDisclosedNoi: number | null;
}): AsrNoiDivergenceResult | null {
  if (args.asrDisclosedNoi === null || args.asrDisclosedNoi <= 0) return null;
  if (!Number.isFinite(args.derivedNoi) || args.derivedNoi <= 0) return null;
  const hi = Math.max(args.derivedNoi, args.asrDisclosedNoi);
  const lo = Math.min(args.derivedNoi, args.asrDisclosedNoi);
  const ratio = hi / lo;
  return {
    flagged: ratio >= ASR_NOI_DIVERGENCE_RATIO,
    ratio,
    concludedBelow: args.derivedNoi < args.asrDisclosedNoi,
  };
}
