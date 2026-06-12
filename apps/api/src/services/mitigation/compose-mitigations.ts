/**
 * compose-mitigations.ts — Mitigant v2 phase 3 (composition layer).
 *
 * SEPARATE LAYER from produceMitigations. "What fires" stays in produce-
 * mitigations.ts (per-lever proposals against the original deal); "how
 * they compose" lives here. They share the proposal contract and the
 * desk knobs, nothing else.
 *
 * COMPOSITION DOCTRINE (sequential-interactive, single-pass):
 *
 *   1. PARTITION fired proposals by interaction with loan balance:
 *
 *      DE-LEVERING  (touch loan size; interact through L')
 *        - reduce_proceeds     (LTV / DSCR / DY arms; cuts L to L')
 *        - require_amortization (sizes paydown to cure exit DSCR)
 *
 *      ORTHOGONAL   (different risk dimensions; stack as-is)
 *        - require_guaranty           (dim 9 sponsor)
 *        - in_place_cash_management   (dim 8 asset class)
 *        - springing_cash_management  (dim 5 concentration)
 *        - fund_reserve               (dim 6 rollover)
 *        - condition_precedent        (HITL coverage gates)
 *
 *   2. RESOLVE de-levering SEQUENTIALLY. Proceeds reduction is
 *      monotonically improving on every metric (DSCR ↑, DY ↑, LTV ↓,
 *      exit DSCR ↑), so a single pass suffices — no iteration, no new
 *      breaches can appear from a cut.
 *
 *        a. If reduce_proceeds fired, apply it: new L' = currentLoan -
 *           reduceProp.requiredEquity.
 *        b. Recompute the deal at L' (recomputeAtLoan callback).
 *        c. Re-run produceMitigations against the recomputed state.
 *        d. The composed amortization is whatever the lever sizes against
 *           the recomputed dim 4. Two outcomes:
 *             - DROPPED (no fire) — proceeds cut cured exit DSCR
 *             - RESIDUAL — proceeds cut narrowed but didn't close the
 *               gap; residual paydown sizes off L'.
 *
 *      If reduce_proceeds did NOT fire, amortization stands alone as
 *      originally sized.
 *
 *   3. STACK orthogonal levers AS-IS. Their proposals (covenants, recourse
 *      tiers, reserves, conditions precedent) don't depend on loan size
 *      EXCEPT where they reference loan size as a ratio (guaranty NW
 *      multiple, liquidity %). The proposal text stores those ratios
 *      symbolically; the composition engine recomputes the DOLLAR
 *      magnitudes against L' and surfaces them in the reconciliation.
 *
 *   4. The composed package shows BOTH the final lever list AND a
 *      reconciliation record. The lender must see WHY a lever dropped or
 *      shrank, not just the final list — "standalone amortization $10.03M
 *      → $0 (superseded by the $14.06M proceeds cut)".
 *
 * FENCE:
 *   - Engine is PURE — no I/O, no global state, no mutation of input args.
 *   - Engine takes a recomputeAtLoan callback so the caller owns the
 *     mechanics of rebuilding AdjustedInputs / UnderwritingModel / DealBag
 *     at a new loan size. This keeps composition decoupled from how
 *     AdjustedInputs is constructed in production vs harness vs tests.
 *   - Does NOT call any lever builder directly; only produceMitigations.
 *   - Does NOT mutate any proposal; it composes by selection + annotation.
 */
import type { AdjustedInputs, FiredFlag } from '@cre/contracts';
import type { MitigationProposal } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import type { EvaluateDealResult } from '../../doctrine-clean/scoring/evaluate-deal.js';
import {
  produceMitigations,
  DEFAULT_MITIGATION_DESK,
  DEFAULT_GUARANTY_TIER_TERMS,
  SPONSOR_CASH_AT_RISK_FLAG_THRESHOLD,
  resolveAssetTypeFromDeal,
  resolveLtvStructuredCeiling,
  resolveOperatingReservesPctOfEgi,
  resolveLeverageBandTierEndpoints,
  interpolateLeverageBandTier,
  computeFundedExitFigures,
  type MitigationDeskConstants,
  type GuarantyTierKey,
  type GuarantyTierTerms,
} from './produce-mitigations.js';
import { EXIT_DSCR_REFINANCEABLE_THRESHOLD } from '../../doctrine-clean/index.js';

/* --------------------------------- types ---------------------------------- */

/** State at a single loan size — what produceMitigations needs. */
export interface DealComputeState {
  readonly adjustedInputs: AdjustedInputs;
  readonly uwModel: UnderwritingModel;
  readonly dealResult: EvaluateDealResult;
}

export interface ComposeMitigationsArgs {
  /** Baseline state at the ORIGINAL loan. */
  readonly adjustedInputs: AdjustedInputs;
  readonly uwModel: UnderwritingModel;
  readonly dealResult: EvaluateDealResult;
  /** Pre-extraction quality flags (pass-through; not loan-dependent). */
  readonly firedFlags: readonly FiredFlag[];
  /**
   * Desk knob overrides — both flow through unchanged to produceMitigations
   * on both baseline AND recomputed-state passes (must match across passes
   * to be coherent).
   */
  readonly desk?: MitigationDeskConstants;
  /**
   * Caller-supplied recompute. Given a new loan size, return ai / uw /
   * dealResult at that loan. The engine calls this AT MOST ONCE — after
   * applying reduce_proceeds. The caller owns how to rebuild AdjustedInputs
   * + UnderwritingModel + DealBag consistently (preserving asset / cashflow
   * fields, recomputing loan-derived fields).
   */
  readonly recomputeAtLoan: (newLoanAmount: number) => DealComputeState;
}

/** Per-orthogonal-lever covenant dollar resolution against L'. */
export interface CovenantMagnitudesAtFinalLoan {
  readonly lever: string;
  readonly leverId: string;
  /** Lines like "Guarantor NW ≥ 1.5× loan → ≥ $108.62M". Generated only when the
   *  lever stores a known loan-ratio knob (guaranty NW + liquidity today). */
  readonly resolvedMagnitudes: readonly string[];
}

export interface ComposeReconciliation {
  readonly originalLoanAmount: number;
  readonly finalLoanAmount: number;
  readonly proceedsReduction: number;
  /** Required paydown of the STANDALONE amortization proposal (pre-composition). */
  readonly standaloneAmortPaydown: number | null;
  /** Required paydown of the COMPOSED amortization proposal (post-composition;
   *  null = dropped because proceeds cut alone cleared the exit gap). */
  readonly composedAmortPaydown: number | null;
  /**
   * Human-readable lines: what dropped, what shrank, why. The first
   * lender-facing rendering of the composition's reasoning trail.
   */
  readonly notes: readonly string[];
  /** Per-orthogonal-lever covenant magnitudes evaluated at L'. */
  readonly covenantMagnitudesAtFinalLoan: readonly CovenantMagnitudesAtFinalLoan[];
}

/**
 * v1.7 — Sponsor burden profile.
 *
 * Distinct kinds of sponsor obligation in a composed package. Do NOT
 * fake a single number — each piece is a different commitment kind:
 *   - equityAsk: real cash the sponsor must fill at closing
 *   - netRecourseCap: contingent cash-at-risk on a payment / DSCR-test event
 *   - netWorthRequirement / liquidityRequirement: balance-sheet capacity,
 *     not at-risk capital (covenants the sponsor must demonstrate)
 *   - distributionLockupYears: time the cash trap holds before distributions
 *
 * `cashAtRisk` aggregates ONLY the comparable cash pieces (equity +
 * net recourse). It's expressed as USD AND as a fraction of the final
 * loan. Crossing `flagThreshold` raises `flagsBurden` for display.
 */
export interface SponsorBurdenProfile {
  readonly equityAsk: number;
  readonly netRecourseCap: number;
  readonly recourseBreakdown: ReadonlyArray<{
    readonly lever: string;
    readonly proposalId: string;
    readonly capUsd: number;
    readonly note: string;
  }>;
  readonly netWorthRequirement: number;       // covenant magnitude in dollars
  readonly liquidityRequirement: number;
  readonly distributionLockupYears: number | null;
  readonly cashAtRiskUsd: number;             // equityAsk + netRecourseCap
  readonly cashAtRiskPctOfFinalLoan: number;
  readonly flagThreshold: number;
  readonly flagsBurden: boolean;
  readonly flagCopy: string | null;            // human-readable when flagged
}

export interface ComposedMitigationPackage {
  /** Final lever list to present to the lender. */
  readonly proposals: readonly MitigationProposal[];
  /** Baseline proposals (what produceMitigations returned pre-composition). */
  readonly initialProposals: readonly MitigationProposal[];
  /** Reconciliation record — why composition produced this list. */
  readonly reconciliation: ComposeReconciliation;
  /** L' (after composition). */
  readonly finalLoanAmount: number;
  /** Pass-through state at L' (for downstream consumers — narrative, UI). */
  readonly finalState: DealComputeState;
  /** v1.7 — sponsor burden profile derived from the composed package. */
  readonly sponsorBurdenProfile: SponsorBurdenProfile;
}

/* ------------------------------- entry point ------------------------------ */

const DE_LEVERING_LEVERS = new Set<string>(['reduce_proceeds', 'require_amortization']);

/** Lever ids that represent the structure-first mid-band cures. They are
 *  NOT de-levering — they hold proceeds. Composition keeps them as-is and
 *  surfaces "leverage/exit held within structured tolerance" in the
 *  reconciliation rather than the legacy "amort → $0 superseded by cut". */
const MID_BAND_LEVERS = new Set<string>([
  'leverage_band_recourse',
  'cash_sweep_refi_reserve',
  'springing_dscr_recourse',
]);

/** USD formatter used in reconciliation notes. */
function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

export function composeMitigations(args: ComposeMitigationsArgs): ComposedMitigationPackage {
  const desk = args.desk ?? DEFAULT_MITIGATION_DESK;
  const guarantyTerms: Readonly<Record<GuarantyTierKey, GuarantyTierTerms>> = DEFAULT_GUARANTY_TIER_TERMS;

  /* ---- (0) BASELINE — produceMitigations at original loan. ------------- */
  const initialProposals = produceMitigations({
    adjustedInputs: args.adjustedInputs,
    uwModel: args.uwModel,
    firedFlags: args.firedFlags,
    dealResult: args.dealResult,
    desk,
  });

  /* ---- (1) PARTITION (v1.3 structure-first). --------------------------- */
  // Three sets:
  //   de-levering   — reduce_proceeds (cut) + require_amortization (paydown
  //                   OR day-1-blocked diagnostic with cut hint).
  //   mid-band      — leverage_band_recourse / cash_sweep_refi_reserve /
  //                   springing_dscr_recourse. These HOLD proceeds; they
  //                   are NOT orthogonal in the doctrine sense — they ARE
  //                   the structured cure for a mid-band breach.
  //   orthogonal    — everything else (lockbox / springing-cash-trap /
  //                   guaranty / fund_reserve / condition_precedent).
  //                   These pass through and stack on top.
  const initialReduce = initialProposals.find(p => p.lever === 'reduce_proceeds');
  const initialAmort  = initialProposals.find(p => p.lever === 'require_amortization');
  const initialMidBand = initialProposals.filter(p => MID_BAND_LEVERS.has(p.lever));
  const orthogonal    = initialProposals.filter(
    p => !DE_LEVERING_LEVERS.has(p.lever) && !MID_BAND_LEVERS.has(p.lever),
  );

  const originalLoanAmount = args.adjustedInputs.loan.loanAmount.adjusted;

  /* ---- (2) Structure-first aggregation. -------------------------------- */
  // Identify CUT-FORCING proposals:
  //   (a) reduce_proceeds   — fires when LTV > ceiling (cut to ceiling)
  //   (b) require_amortization with id 'amortization_blocked_by_day1_dscr' —
  //       the lever signaled "exit < floor AND day-1 DSCR would be violated";
  //       the diagnostic carries an equivalent_cut field via requiredPaydown
  //       (the cut quantum sized to clear exit at IO).
  // If neither, NO CUT — hold proceeds; mid-band levers + orthogonal pass.
  // If one or both, pick the smaller L' (binding constraint).
  let finalLoanAmount = originalLoanAmount;
  let composedAmort: MitigationProposal | null = initialAmort ?? null;
  let finalState: DealComputeState = {
    adjustedInputs: args.adjustedInputs,
    uwModel: args.uwModel,
    dealResult: args.dealResult,
  };
  const notes: string[] = [];

  // Detect a day-1-blocked amortization (diagnostic that carries a cut hint).
  const amortBlocked = initialAmort?.id === 'amortization_blocked_by_day1_dscr';
  const amortCutHint = amortBlocked
    ? originalLoanAmount - (initialAmort!.requiredPaydown ?? 0)  // L' implied by the equivalent cut
    : null;

  // Detect a cut-forcing reduce_proceeds.
  const reduceCut = initialReduce !== undefined
    ? Math.max(0, originalLoanAmount - (initialReduce.requiredEquity ?? 0))
    : null;

  // Collect the cut-forcing candidates and pick the binding (smallest L').
  const cutCandidates: Array<{ source: string; lPrime: number }> = [];
  if (reduceCut !== null) {
    const bindingMetric = initialReduce!.targetMetric ?? 'ltv';
    cutCandidates.push({ source: `reduce_proceeds (${bindingMetric} arm — LTV above ceiling)`, lPrime: reduceCut });
  }
  if (amortCutHint !== null) {
    cutCandidates.push({ source: 'require_amortization day-1-DSCR fallback (exit below floor)', lPrime: amortCutHint });
  }

  // Mid-band proposals get rebuilt at L' on the CUT path; collected here so
  // the lender sees structural cures sized against the post-cut basis.
  let recomputedMidBand: MitigationProposal[] = [];

  if (cutCandidates.length === 0) {
    /* ---- STRUCTURE-FIRST HOLD PATH ----
     * No dimension is past its limit. Hold proceeds at full origination.
     * Mid-band levers (if any fired) carry the structured cure. The
     * reconciliation describes the held state per dimension. */
    const heldBands: string[] = [];
    const ltvBand = initialMidBand.find(p => p.lever === 'leverage_band_recourse');
    const exitSweep = initialMidBand.find(p => p.lever === 'cash_sweep_refi_reserve');
    const exitSpring = initialMidBand.find(p => p.lever === 'springing_dscr_recourse');
    if (ltvBand !== undefined) {
      heldBands.push(
        `Stressed LTV — held within the structured band; structural cure: ${ltvBand.title}.`,
      );
    }
    if (exitSweep !== undefined || exitSpring !== undefined) {
      const parts: string[] = [];
      if (exitSweep !== undefined)  parts.push('cash sweep refi reserve');
      if (exitSpring !== undefined) parts.push('springing DSCR recourse');
      heldBands.push(
        `Exit DSCR — held within the structured band; structural cure: ${parts.join(' + ')}.`,
      );
    }
    if (heldBands.length === 0) {
      notes.push(`No breaches forcing a cut; no mid-band levers fired — composition is identity over orthogonal levers.`);
    } else {
      notes.push(`Structure-first hold at full proceeds (${fmtUsd(originalLoanAmount)}). No proceeds cut applied.`);
      for (const h of heldBands) notes.push(h);
    }
    composedAmort = null;  // amortization not part of the hold path (mid-band exit uses sweep+springing, not amort).
  } else {
    /* ---- CUT PATH ----
     * One or more dimensions past their limit. Pick the smallest L' as the
     * BINDING constraint. Report all forcing paths transparently. */
    cutCandidates.sort((a, b) => a.lPrime - b.lPrime);
    const binding = cutCandidates[0]!;
    const targetLoan = binding.lPrime;
    notes.push(
      `Proceeds reduction ${fmtUsd(originalLoanAmount - targetLoan)} → L' = ${fmtUsd(targetLoan)} ` +
      `(binding: ${binding.source}).`,
    );
    if (cutCandidates.length > 1) {
      const alternatives = cutCandidates.slice(1)
        .map(c => `${c.source} would have required L' = ${fmtUsd(c.lPrime)}`)
        .join('; ');
      notes.push(`Non-binding paths: ${alternatives} (smallest L' wins).`);
    }

    /* Recompute + re-run produceMitigations at L'. */
    const recomputed = args.recomputeAtLoan(targetLoan);
    finalLoanAmount = targetLoan;
    finalState = recomputed;
    const recomputedProposals = produceMitigations({
      adjustedInputs: recomputed.adjustedInputs,
      uwModel: recomputed.uwModel,
      firedFlags: args.firedFlags,
      dealResult: recomputed.dealResult,
      desk,
    });

    const recomputedAmort = recomputedProposals.find(p => p.lever === 'require_amortization') ?? null;
    composedAmort = recomputedAmort;
    // v1.4 — also pick up mid-band cures at L'. Post-cut LTV may land at the
    // ceiling (structured band), and exit at L' may still be funded-structured.
    // Sizes are correct at L' because produceMitigations ran on the recomputed
    // state. The baseline initialMidBand is NOT used on the cut path.
    recomputedMidBand = recomputedProposals.filter(p => MID_BAND_LEVERS.has(p.lever));

    if (initialAmort !== undefined && recomputedAmort === null) {
      const initialAmortPaydown = initialAmort.requiredPaydown ?? NaN;
      const noun = amortBlocked ? 'equivalent cut' : 'standalone amortization';
      notes.push(
        `${noun} ${fmtUsd(initialAmortPaydown)} → $0 ` +
        `(superseded by the ${fmtUsd(originalLoanAmount - targetLoan)} proceeds cut — exit DSCR clears at L' = ${fmtUsd(targetLoan)}).`,
      );
    } else if (initialAmort !== undefined && recomputedAmort !== null) {
      notes.push(
        `Standalone amortization ${fmtUsd(initialAmort.requiredPaydown ?? NaN)} → composed residual ` +
        `${fmtUsd(recomputedAmort.requiredPaydown ?? NaN)} (proceeds cut narrowed the exit gap but didn't ` +
        `close it; residual amort sizes off L' = ${fmtUsd(targetLoan)}).`,
      );
    }

    // Sanity check: at L', neither reduce_proceeds nor a day-1-blocked
    // amortization should re-fire. Diagnostic only.
    const recomputedReduce = recomputedProposals.find(p => p.lever === 'reduce_proceeds');
    if (recomputedReduce !== undefined) {
      notes.push(
        `Diagnostic: reduce_proceeds still fires at L' (binding ${recomputedReduce.targetMetric ?? '?'}) — ` +
        `investigate; cut should monotonically clear LTV.`,
      );
    }
  }

  /* ---- (3) Orthogonal covenant magnitudes at L'. ----------------------- */
  const covenantMagnitudes: CovenantMagnitudesAtFinalLoan[] = [];
  for (const p of orthogonal) {
    const lines = resolveCovenantMagnitudes(p, finalLoanAmount, guarantyTerms);
    if (lines.length > 0) {
      covenantMagnitudes.push({
        lever: p.lever,
        leverId: p.id ?? '—',
        resolvedMagnitudes: lines,
      });
    }
  }
  if (covenantMagnitudes.length > 0 && finalLoanAmount !== originalLoanAmount) {
    notes.push(
      `Orthogonal covenant magnitudes (guaranty NW / liquidity ratios) re-resolved against ` +
      `L' = ${fmtUsd(finalLoanAmount)}, NOT the original ${fmtUsd(originalLoanAmount)}.`,
    );
  }

  /* ---- (4) Compose the final lever list. ------------------------------- */
  // Order: cut (if any) first, then mid-band structural cures (when we held),
  // then orthogonal. The lender reads top-down: origination move, structural
  // package, covenant scaffolding.
  //
  // When the HOLD path ran: NO reduce_proceeds, NO amortization (mid-band
  // exit is structured by sweep + springing, not amortized).
  // When the CUT path ran: include the cut + any residual amortization (the
  // amort-blocked diagnostic does NOT get included — the cut SUPERSEDES it).
  const proposals: MitigationProposal[] = [];
  if (cutCandidates.length > 0 && initialReduce !== undefined) proposals.push(initialReduce);
  if (composedAmort !== null && composedAmort.id !== 'amortization_blocked_by_day1_dscr') {
    proposals.push(composedAmort);
  }
  // Mid-band levers:
  //   HOLD path — use baseline initialMidBand (proceeds didn't move).
  //   CUT path  — use recomputedMidBand (sizes correct at L').
  if (cutCandidates.length === 0) proposals.push(...initialMidBand);
  else                            proposals.push(...recomputedMidBand);
  proposals.push(...orthogonal);

  /* ---- (4.5) v1.7 — Subordinate the springing when leverage covers it. */
  // The leverage_band_recourse is a partial PAYMENT guaranty: it covers the
  // balloon up to (recoursePct × L'). The springing_dscr_recourse covers
  // exit residual unfunded. When the leverage cap fully covers the exit
  // residual, the springing is redundant — DROP it (no double-count).
  // Keep ONLY when leverage is absent (e.g., LTV below trigger) or too light
  // to cover the residual.
  const subordinationApplied = subordinateSpringingIfRedundant(
    proposals, finalState, notes,
  );
  void subordinationApplied;

  /* ---- (5) Assemble reconciliation. ------------------------------------ */
  const reconciliation: ComposeReconciliation = {
    originalLoanAmount,
    finalLoanAmount,
    proceedsReduction: originalLoanAmount - finalLoanAmount,
    standaloneAmortPaydown: initialAmort?.requiredPaydown ?? null,
    composedAmortPaydown: composedAmort?.requiredPaydown ?? null,
    notes,
    covenantMagnitudesAtFinalLoan: covenantMagnitudes,
  };

  /* ---- (6) v1.7 — Sponsor burden profile. ------------------------------ */
  const sponsorBurdenProfile = computeSponsorBurdenProfile(
    proposals, finalState, finalLoanAmount, originalLoanAmount - finalLoanAmount,
  );

  return {
    proposals,
    initialProposals,
    reconciliation,
    finalLoanAmount,
    finalState,
    sponsorBurdenProfile,
  };
}

/* ----------- covenant-magnitude resolution (guaranty NW / liq) ------------ */
/*
 * The guaranty lever stores its NW multiple + liquidity % SYMBOLICALLY in
 * structuralChanges text ("net worth ≥ 1.5× loan", "liquidity ≥ 5% of loan").
 * The composition engine resolves those ratios into DOLLAR magnitudes
 * against L' so the lender sees the actual covenant they're underwriting.
 *
 * Resolution table is read from DEFAULT_GUARANTY_TIER_TERMS (single source
 * of truth — when Isabelle re-tunes the table, the resolved magnitudes
 * follow automatically). Matching is by tier-key parsed from the
 * proposal id (`guaranty_sponsor_{mild|moderate|severe}`); the disqualifying
 * case (id severe + description cites disqualifying) is detected from text.
 */
function resolveCovenantMagnitudes(
  p: MitigationProposal,
  finalLoanAmount: number,
  terms: Readonly<Record<GuarantyTierKey, GuarantyTierTerms>>,
): string[] {
  if (p.lever !== 'require_guaranty') return [];
  const id = p.id ?? '';
  const tierFromId = id.replace(/^guaranty_sponsor_/, '') as 'mild' | 'moderate' | 'severe';
  if (tierFromId !== 'mild' && tierFromId !== 'moderate' && tierFromId !== 'severe') return [];

  const desc = ((p as any).description ?? '') as string;
  const isDisqualifying = /disqualifying/i.test(desc) && tierFromId === 'severe';
  const tierKey: GuarantyTierKey = isDisqualifying ? 'disqualifying-event' : tierFromId;
  const t = terms[tierKey];

  const lines: string[] = [];
  lines.push(
    `Guarantor net-worth: ${t.netWorthMultiple.toFixed(1)}× loan → ≥ ${fmtUsd(t.netWorthMultiple * finalLoanAmount)} ` +
    `(at L' = ${fmtUsd(finalLoanAmount)})`,
  );
  lines.push(
    `Guarantor liquidity: ${(t.liquidityPct * 100).toFixed(0)}% of loan → ≥ ${fmtUsd(t.liquidityPct * finalLoanAmount)} ` +
    `(at L' = ${fmtUsd(finalLoanAmount)})`,
  );
  if (t.recoursePct > 0) {
    lines.push(
      `Recourse exposure: ${(t.recoursePct * 100).toFixed(0)}% of loan → ${fmtUsd(t.recoursePct * finalLoanAmount)} ` +
      `(at L' = ${fmtUsd(finalLoanAmount)})`,
    );
  }
  return lines;
}


/* ============== v1.7 — total-package coherence helpers ==================== */

/**
 * Subordinate the springing_dscr_recourse when leverage_band_recourse covers
 * the balloon. MUTATES the proposals array (removes the springing) and
 * appends a reconciliation note when redundant.
 *
 * Doctrine:
 *   - leverage_band_recourse is a partial PAYMENT guaranty, capped at
 *     recoursePct × finalLoanAmount. That cap is available to retire the
 *     balloon at maturity.
 *   - springing_dscr_recourse is sized at max(MIN × loan, exit-residual-
 *     unfunded). Its purpose is to backstop the exit refi gap.
 *   - When the leverage cap ≥ exit residual unfunded, the leverage guaranty
 *     ALREADY covers the same balloon risk the springing was meant to cover.
 *     Drop the springing — no double-count.
 *   - When leverage is absent OR cap < residual, KEEP springing; it covers
 *     the uncovered excess.
 *
 * Returns true when subordination dropped the springing; false otherwise.
 */
function subordinateSpringingIfRedundant(
  proposals: MitigationProposal[],
  finalState: DealComputeState,
  notes: string[],
): boolean {
  const leverageIdx = proposals.findIndex(p => p.lever === 'leverage_band_recourse');
  const springingIdx = proposals.findIndex(p => p.lever === 'springing_dscr_recourse');
  if (leverageIdx === -1 || springingIdx === -1) return false;

  const finalLoan = finalState.adjustedInputs.loan.loanAmount.adjusted;
  if (!(finalLoan > 0)) return false;

  // Recompute the leverage recourse cap at L' via the same interpolator
  // the lever uses. dim 7 supplies stressedLtv at L'.
  const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
  const dim7 = finalState.dealResult.dimensions.capRateValuationStress;
  const stressedLtvAtFinal = dim7.derivedOutputs?.stressedLtv;
  if (typeof stressedLtvAtFinal !== 'number' || !Number.isFinite(stressedLtvAtFinal)) return false;
  const trigger = DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
  const ceiling = resolveLtvStructuredCeiling(assetType);
  const endpoints = resolveLeverageBandTierEndpoints(assetType);
  const interp = interpolateLeverageBandTier(stressedLtvAtFinal, trigger, ceiling, endpoints);
  const leverageCap = interp.recoursePct * finalLoan;

  // Compute the exit residual unfunded the springing was meant to cover.
  const dim4 = finalState.dealResult.dimensions.refinanceFeasibility;
  const sustainableNcf = finalState.dealResult.normalization.sustainableNcf;
  const rc = dim4.derivedOutputs?.stressedRefiConstant;
  const maturityBalance = dim4.derivedOutputs?.maturityBalance;
  if (typeof sustainableNcf !== 'number' || !(sustainableNcf > 0)) return false;
  if (typeof rc !== 'number' || !(rc > 0)) return false;
  if (typeof maturityBalance !== 'number' || !(maturityBalance > 0)) return false;
  const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
  const exitClearingBalance = sustainableNcf / (rc * cureTarget);
  const reserveTarget = Math.max(0, maturityBalance - exitClearingBalance);
  const egi = finalState.adjustedInputs.income.effectiveGrossIncome.adjusted;
  const opReservesPct = resolveOperatingReservesPctOfEgi(assetType);
  const operatingReservesAnnual = Math.max(0, opReservesPct * egi);
  const debtServiceAnnual = finalState.adjustedInputs.loan.debtServiceAnnual.adjusted;
  const termMonths = finalState.adjustedInputs.loan.termMonths.adjusted;
  const funded = computeFundedExitFigures(
    sustainableNcf, debtServiceAnnual, termMonths, rc, maturityBalance,
    operatingReservesAnnual, reserveTarget,
  );
  const exitResidual = funded.residualUnfunded;

  // Doctrine: drop only when leverage cap fully covers the residual.
  // Distinguish the two redundancy cases honestly — they have different
  // doctrinal flavors:
  //   (A) residual = $0 — the cash trap FULLY funds the exit. The minimum-
  //       tier springing has no residual to backstop; it would only fire on
  //       a coverage breach, but the leverage guaranty already backstops
  //       payment in any case. Drop it.
  //   (B) 0 < residual ≤ leverage cap — the trap leaves a gap, but the
  //       leverage cap covers the gap. The leverage guaranty subsumes the
  //       springing's coverage of the residual.
  if (leverageCap >= exitResidual) {
    // Redundant — drop the springing.
    proposals.splice(springingIdx, 1);
    if (exitResidual <= 0) {
      // Case A — fully funded by the trap.
      notes.push(
        `Springing DSCR recourse SUBORDINATED — exit fully funded by the cash trap (residual ` +
        `${fmtUsd(exitResidual)}); the minimum-tier springing DSCR recourse has no residual to ` +
        `backstop and is removed. The ${fmtUsd(leverageCap)} leverage payment guaranty ` +
        `(${(interp.recoursePct * 100).toFixed(1)}% of L' = ${fmtUsd(finalLoan)}) backstops any ` +
        `payment shortfall in any case — no double-count.`,
      );
    } else {
      // Case B — residual covered by the leverage guaranty.
      notes.push(
        `Springing DSCR recourse SUBORDINATED — exit refi residual ${fmtUsd(exitResidual)} is ` +
        `already covered by the ${(interp.recoursePct * 100).toFixed(1)}% leverage payment guaranty ` +
        `(${fmtUsd(leverageCap)} cap on L' = ${fmtUsd(finalLoan)}, which covers the balloon). ` +
        `Standalone springing DSCR recourse removed as redundant — no double-count.`,
      );
    }
    return true;
  }

  // Leverage doesn't fully cover — KEEP springing (it covers the excess).
  // Optionally re-size in a future revision; current scope keeps the existing
  // springing proposal as-is.
  notes.push(
    `Springing DSCR recourse RETAINED — exit refi residual ${fmtUsd(exitResidual)} exceeds ` +
    `the leverage recourse cap ${fmtUsd(leverageCap)}. Springing covers the uncovered excess ` +
    `${fmtUsd(Math.max(0, exitResidual - leverageCap))}.`,
  );
  return false;
}

/**
 * Compute the sponsor burden profile from the (post-subordination) proposals.
 *
 * Each kind of burden is tracked distinctly. cashAtRisk aggregates ONLY
 * equity ask + net recourse cap (the comparable cash commitments). NW /
 * liquidity covenants are CAPACITY measures — surfaced alongside, NOT
 * summed in.
 */
function computeSponsorBurdenProfile(
  proposals: readonly MitigationProposal[],
  finalState: DealComputeState,
  finalLoanAmount: number,
  equityAsk: number,
): SponsorBurdenProfile {
  // Net recourse cap — sum across recourse-flavored levers that survived
  // subordination.
  const recourseBreakdown: Array<{ lever: string; proposalId: string; capUsd: number; note: string }> = [];
  let netRecourseCap = 0;

  // leverage_band_recourse — re-interpolate to get the cap at L'.
  const leverageProp = proposals.find(p => p.lever === 'leverage_band_recourse');
  if (leverageProp !== undefined && finalLoanAmount > 0) {
    const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
    const dim7 = finalState.dealResult.dimensions.capRateValuationStress;
    const sLtv = dim7.derivedOutputs?.stressedLtv;
    if (typeof sLtv === 'number' && Number.isFinite(sLtv)) {
      const trigger = DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
      const ceiling = resolveLtvStructuredCeiling(assetType);
      const endpoints = resolveLeverageBandTierEndpoints(assetType);
      const interp = interpolateLeverageBandTier(sLtv, trigger, ceiling, endpoints);
      const cap = interp.recoursePct * finalLoanAmount;
      netRecourseCap += cap;
      recourseBreakdown.push({
        lever: leverageProp.lever,
        proposalId: leverageProp.id ?? '',
        capUsd: cap,
        note: `${(interp.recoursePct * 100).toFixed(1)}% of L' (band position p = ${interp.p.toFixed(2)}, convex w = ${interp.w.toFixed(2)})`,
      });
    }
  }

  // springing_dscr_recourse — only present if subordination kept it.
  const springingProp = proposals.find(p => p.lever === 'springing_dscr_recourse');
  if (springingProp !== undefined && finalLoanAmount > 0) {
    // Re-derive the springing cap via the same logic the lever uses: max(MIN × loan, residual).
    // MIN_SPRINGING_RECOURSE_PCT is 0.10 in produce-mitigations.ts. Hard-code
    // matching value here (could be threaded via export if drift becomes a
    // concern; for now this is a CI invariant: same constant in two places).
    const MIN_SPRINGING_RECOURSE_PCT = 0.10;
    const minCap = MIN_SPRINGING_RECOURSE_PCT * finalLoanAmount;
    // The actual cap = max(min, residual). We re-derive residual.
    const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
    const dim4 = finalState.dealResult.dimensions.refinanceFeasibility;
    const sustainableNcf = finalState.dealResult.normalization.sustainableNcf;
    const rc = dim4.derivedOutputs?.stressedRefiConstant;
    const maturityBalance = dim4.derivedOutputs?.maturityBalance;
    let cap = minCap;
    if (typeof sustainableNcf === 'number' && sustainableNcf > 0 &&
        typeof rc === 'number' && rc > 0 &&
        typeof maturityBalance === 'number' && maturityBalance > 0) {
      const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
      const exitClearing = sustainableNcf / (rc * cureTarget);
      const reserveTarget = Math.max(0, maturityBalance - exitClearing);
      const egi = finalState.adjustedInputs.income.effectiveGrossIncome.adjusted;
      const opReservesPct = resolveOperatingReservesPctOfEgi(assetType);
      const operatingReservesAnnual = Math.max(0, opReservesPct * egi);
      const debtServiceAnnual = finalState.adjustedInputs.loan.debtServiceAnnual.adjusted;
      const termMonths = finalState.adjustedInputs.loan.termMonths.adjusted;
      const funded = computeFundedExitFigures(
        sustainableNcf, debtServiceAnnual, termMonths, rc, maturityBalance,
        operatingReservesAnnual, reserveTarget,
      );
      cap = Math.max(minCap, funded.residualUnfunded);
    }
    netRecourseCap += cap;
    recourseBreakdown.push({
      lever: springingProp.lever,
      proposalId: springingProp.id ?? '',
      capUsd: cap,
      note: `max(min tier 10% × L', residual unfunded gap) — sized to backstop the exit residual not covered by leverage recourse`,
    });
  }

  // require_guaranty — when dim 9 fires; carries tier-based recourse %.
  // Parse from the proposal's id (guaranty_sponsor_{mild|moderate|severe}).
  const guarantyProp = proposals.find(p => p.lever === 'require_guaranty');
  if (guarantyProp !== undefined && finalLoanAmount > 0) {
    const id = guarantyProp.id ?? '';
    const tier = id.replace(/^guaranty_sponsor_/, '');
    const tierKey: GuarantyTierKey | null =
      tier === 'mild' || tier === 'moderate' || tier === 'severe'
        ? (/disqualifying/i.test((guarantyProp as { description?: string }).description ?? '') && tier === 'severe' ? 'disqualifying-event' : tier as GuarantyTierKey)
        : null;
    if (tierKey !== null) {
      const t = DEFAULT_GUARANTY_TIER_TERMS[tierKey];
      const cap = t.recoursePct * finalLoanAmount;
      netRecourseCap += cap;
      recourseBreakdown.push({
        lever: guarantyProp.lever,
        proposalId: id,
        capUsd: cap,
        note: `dim-9 sponsor tier '${tierKey}' — ${(t.recoursePct * 100).toFixed(0)}% recourse`,
      });
    }
  }

  // Capacity covenants — leverage_band_recourse drives NW + liquidity.
  let netWorthRequirement = 0;
  let liquidityRequirement = 0;
  if (leverageProp !== undefined && finalLoanAmount > 0) {
    const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
    const dim7 = finalState.dealResult.dimensions.capRateValuationStress;
    const sLtv = dim7.derivedOutputs?.stressedLtv;
    if (typeof sLtv === 'number' && Number.isFinite(sLtv)) {
      const trigger = DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
      const ceiling = resolveLtvStructuredCeiling(assetType);
      const endpoints = resolveLeverageBandTierEndpoints(assetType);
      const interp = interpolateLeverageBandTier(sLtv, trigger, ceiling, endpoints);
      netWorthRequirement = interp.netWorthMultiple * finalLoanAmount;
      liquidityRequirement = interp.liquidityPct * finalLoanAmount;
    }
  }

  // Distribution lockup — years to fill the cash trap (from the funded math).
  let distributionLockupYears: number | null = null;
  const cashSweepProp = proposals.find(p => p.lever === 'cash_sweep_refi_reserve');
  if (cashSweepProp !== undefined) {
    const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
    const dim4 = finalState.dealResult.dimensions.refinanceFeasibility;
    const sustainableNcf = finalState.dealResult.normalization.sustainableNcf;
    const rc = dim4.derivedOutputs?.stressedRefiConstant;
    const maturityBalance = dim4.derivedOutputs?.maturityBalance;
    if (typeof sustainableNcf === 'number' && sustainableNcf > 0 &&
        typeof rc === 'number' && rc > 0 &&
        typeof maturityBalance === 'number' && maturityBalance > 0) {
      const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
      const exitClearing = sustainableNcf / (rc * cureTarget);
      const reserveTarget = Math.max(0, maturityBalance - exitClearing);
      const egi = finalState.adjustedInputs.income.effectiveGrossIncome.adjusted;
      const opReservesPct = resolveOperatingReservesPctOfEgi(assetType);
      const operatingReservesAnnual = Math.max(0, opReservesPct * egi);
      const debtServiceAnnual = finalState.adjustedInputs.loan.debtServiceAnnual.adjusted;
      const termMonths = finalState.adjustedInputs.loan.termMonths.adjusted;
      const funded = computeFundedExitFigures(
        sustainableNcf, debtServiceAnnual, termMonths, rc, maturityBalance,
        operatingReservesAnnual, reserveTarget,
      );
      distributionLockupYears = funded.yearsToFillTarget;
    }
  }

  // Cash-at-risk aggregation.
  const cashAtRiskUsd = equityAsk + netRecourseCap;
  const cashAtRiskPctOfFinalLoan = finalLoanAmount > 0 ? cashAtRiskUsd / finalLoanAmount : 0;
  const flagThreshold = SPONSOR_CASH_AT_RISK_FLAG_THRESHOLD;
  const flagsBurden = cashAtRiskPctOfFinalLoan >= flagThreshold;
  const flagCopy = flagsBurden
    ? `Cumulative sponsor burden (cash-at-risk ${(cashAtRiskPctOfFinalLoan * 100).toFixed(1)}% of L') ` +
      `approaches the desk's acceptability line for a non-recourse execution — consider lightening a ` +
      `lever, or whether this deal belongs with a recourse lender. Threshold: ${(flagThreshold * 100).toFixed(0)}% [ISABELLE-TO-CALIBRATE].`
    : null;

  return {
    equityAsk,
    netRecourseCap,
    recourseBreakdown,
    netWorthRequirement,
    liquidityRequirement,
    distributionLockupYears,
    cashAtRiskUsd,
    cashAtRiskPctOfFinalLoan,
    flagThreshold,
    flagsBurden,
    flagCopy,
  };
}
