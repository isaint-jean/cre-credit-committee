/**
 * doctrine-clean / dimensions / sponsor-borrower-quality.ts
 *
 * Dimension 9 — Sponsor / borrower quality.
 *
 * SPEC v2 §9 (verbatim):
 *   Principle: qualitative overlay — sponsor experience, financial
 *   strength, track record, alignment.
 *   Convergence: thinner and qualitative across agencies; DBRS
 *   comparative review can adjust qualitatively (generally bounded,
 *   e.g. up to ~2 notches). The most judgment-driven dimension.
 *   Proposed treatment: qualitative modifier, not a hard score.
 *   (Define carefully; articulate from your own experience.)
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old sponsor logic. Bound + factor weights derived from
 * DBRS's ~2-notch convention + Moody's/KBRA sponsor components +
 * B-piece-investor practice, NOT fit to the corpus (which carries no
 * sponsor data).
 *
 * ─────────────────────────────────────────────────────────────────────
 * OWN-WORDS ARTICULATION (§9: "YOUR articulation matters most"):
 *
 *   The other eight dimensions size the property's cash flow against
 *   the loan and against agency-stressed conditions. Dim 9 sizes the
 *   PERSON behind the borrower. The lens that makes this dimension
 *   make sense — and the lens these rules are built around — is the
 *   B-piece (first-loss) investor's. When a loan defaults, the
 *   B-piece is the one writing down equity, and the recovery they
 *   actually get is determined less by the numbers in the offering
 *   memorandum than by the borrower's posture in the workout. A
 *   sophisticated sponsor with capital and a reputation to protect
 *   will fund a shortfall, negotiate a modification in good faith,
 *   and transfer the asset cooperatively if foreclosure becomes
 *   inevitable. A thin or hostile sponsor — one with no equity at
 *   risk, no other relationships to preserve, a history of fighting
 *   workouts, or fraud in the file — will weaponize the legal system
 *   to extract value: drawing out the foreclosure, contesting
 *   appointments, transferring tenants out, draining reserves into
 *   affiliate-payments before the lender can intervene. The dollar
 *   gap between those two postures on the same loan is the size of
 *   the sponsor signal — and on a B-piece position, it is the
 *   difference between recovering 60% and recovering 10%.
 *
 *   That said, sponsor quality cannot SWING a credit decision alone.
 *   The fundamental property cash flow, the leverage, the structural
 *   features are still the primary signal. The agencies acknowledge
 *   this directly: DBRS's comparative review carves out a bounded
 *   adjustment band (the published convention sits at roughly two
 *   notches of rating impact for sponsor-driven moves). Moody's and
 *   KBRA both incorporate sponsor as a component but never as a tier
 *   by itself. So dim 9 is built as a BOUNDED SIGNED MODIFIER on the
 *   risk scale — capped at ±0.20 on the [0, 1] scale (an interpretation
 *   of DBRS's ~2-notch bound at the band-width resolution this doctrine
 *   uses, where each named band is ~0.20-0.25 wide). It cannot
 *   independently drive a deal into elevated risk; it CAN move a deal
 *   one tier in either direction. The cap is the load-bearing
 *   discipline — it stops sponsor quality from becoming a back-door
 *   override on the cash-flow and structural reads.
 *
 *   FIVE FACTORS — assessed qualitatively in HITL review:
 *
 *   (1) Experience and track record.
 *       How long has this sponsor operated in CRE? Experience in THIS
 *       asset class (running multifamily ≠ running malls)? Have they
 *       held assets through a downturn — and how did they manage them?
 *       Symmetric — strong reduces risk modestly, weak increases it
 *       modestly.
 *
 *   (2) Financial strength.
 *       Net worth and liquidity against the loan size. Can they fund
 *       a shortfall if NOI dips? What contingent liabilities are
 *       outstanding (other guarantees, litigation exposure)? Symmetric.
 *
 *   (3) Alignment / skin-in-the-game.
 *       Is the equity REAL cash or financed (mezzanine, preferred
 *       equity stacked above the equity)? Did the sponsor cash out at
 *       origination — a partial or full return of equity at the
 *       closing — which leaves nothing to lose? Symmetric, but
 *       cash-out at origination is itself a negative signal.
 *
 *   (4) PRIOR CREDIT EVENTS — asymmetric upward.
 *       Past defaults, workouts, DPOs (discounted-payoff settlements),
 *       contested foreclosures, litigation against prior lenders,
 *       bad-boy-carveout triggers, MISREPRESENTATION in prior filings.
 *       This factor is asymmetric: a SEVERE rating here (active fraud,
 *       active misrepresentation, prior default of similar size) can
 *       independently drive the modifier to the risk-INCREASING bound.
 *       A clean record on this factor is not a benefit; it's the
 *       baseline expectation. A great track record on factors 1, 2, 3,
 *       5 does NOT offset a disqualifying event on factor 4. This
 *       asymmetry is the genuine B-piece lens — recovery is decided
 *       by character, and character is best predicted by past
 *       behavior in distress.
 *
 *   (5) Management quality.
 *       Is asset management in-house or third-party? Track record of
 *       the management entity on similar properties? Symmetric.
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * APPLICABILITY (3-state):
 *   - applicable: HITL assessment provided with all five factor ratings
 *     → modifier computed, capped at ±0.20
 *   - hitl-needed: assessment not provided → modifier=0 / inert; flag
 *     for human review. On the current corpus, this is UNIVERSAL — CMBS
 *     filings do not surface borrower sponsor financials in structured
 *     form. The dimension is correctly inert on every record today.
 *   - not-applicable-by-asset-type: NOT USED HERE. Sponsor quality
 *     applies across asset classes; this dimension never routes to
 *     not-applicable-by-asset-type.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

export type SponsorFactorRating = 'Strong' | 'Neutral' | 'Weak' | 'Severe';

export interface SponsorAssessment {
  /** (1) Experience and track record. Symmetric. */
  readonly experience: SponsorFactorRating;
  /** (2) Financial strength: net worth + liquidity vs loan + contingent liabs. Symmetric. */
  readonly financialStrength: SponsorFactorRating;
  /** (3) Alignment / skin-in-the-game: real cash equity vs financed; cash-out at origination = negative. Symmetric. */
  readonly alignment: SponsorFactorRating;
  /** (4) PRIOR CREDIT EVENTS — asymmetric upward. Severe can independently reach the risk bound. */
  readonly priorCreditEvents: SponsorFactorRating;
  /** (5) Management quality. In-house vs third-party; track record. Symmetric. */
  readonly managementQuality: SponsorFactorRating;
}

export interface SponsorBorrowerQualityInput {
  /**
   * HITL-provided assessment. When null, dim 9 routes to hitl-needed
   * and emits a zero modifier (inert). The clean corpus will be
   * universally null today — sponsor data is not in CMBS filings.
   */
  readonly assessment: SponsorAssessment | null;
}

/**
 * DBRS comparative-review bound (~2 notches), translated to this
 * doctrine's [0, 1] risk scale where each named band is ~0.20-0.25 wide.
 * The modifier is capped at ±MODIFIER_CAP.
 */
export const MODIFIER_CAP = 0.20;

/**
 * Per-factor signed contributions. The four symmetric factors are
 * weighted equally (each up to ±0.05); factor 4 is asymmetric upward
 * (Severe = +0.20 = full bound on its own).
 */
interface FactorWeights {
  readonly Strong: number;
  readonly Neutral: number;
  readonly Weak: number;
  readonly Severe: number;
}

const SYMMETRIC: FactorWeights = {
  Strong: -0.05,
  Neutral: 0,
  Weak: +0.05,
  Severe: +0.08,
};

const FACTOR4_PRIOR_CREDIT_EVENTS: FactorWeights = {
  Strong: -0.03,   // clean record offers only modest benefit (baseline expectation)
  Neutral: 0,
  Weak: +0.10,     // a workout / DPO in history — material upward push
  Severe: +0.20,   // fraud / misrepresentation / prior default — reaches the bound
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function evaluateSponsorBorrowerQuality(
  input: SponsorBorrowerQualityInput,
): DimensionContribution {
  if (input.assessment === null) {
    return {
      dimensionId: 'sponsor-borrower-quality',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        '[HITL — sponsor assessment not provided] Dim 9 is a qualitative ' +
        'modifier requiring an explicit sponsor assessment across 5 ' +
        'factors. Routed to inert (modifier=0). NEVER substitute a ' +
        'conservative default — provenance requires HITL judgment.',
      provenance: ['spec v2 §9 — HITL assessment required; no default'],
      applicability: 'hitl-needed',
      evaluated: false,
      riskModifier: 0,
    };
  }

  const a = input.assessment;
  // Compute per-factor contributions.
  const cExperience       = SYMMETRIC[a.experience];
  const cFinancial        = SYMMETRIC[a.financialStrength];
  const cAlignment        = SYMMETRIC[a.alignment];
  const cMgmt             = SYMMETRIC[a.managementQuality];
  const cPriorCredit      = FACTOR4_PRIOR_CREDIT_EVENTS[a.priorCreditEvents];

  // Sum and cap.
  const raw = cExperience + cFinancial + cAlignment + cMgmt + cPriorCredit;
  let modifier = clamp(raw, -MODIFIER_CAP, +MODIFIER_CAP);

  // ASYMMETRY: Severe factor-4 floors the modifier at the risk bound
  // even if other factors net negative. A great track record does NOT
  // offset a disqualifying event.
  if (a.priorCreditEvents === 'Severe') {
    modifier = Math.max(modifier, +MODIFIER_CAP);
  }

  // Build human-readable summary.
  const factorSummary =
    `experience=${a.experience}(${cExperience.toFixed(2)}), ` +
    `financialStrength=${a.financialStrength}(${cFinancial.toFixed(2)}), ` +
    `alignment=${a.alignment}(${cAlignment.toFixed(2)}), ` +
    `priorCreditEvents=${a.priorCreditEvents}(${cPriorCredit.toFixed(2)}, asymmetric upward), ` +
    `managementQuality=${a.managementQuality}(${cMgmt.toFixed(2)})`;
  const cappedNote = Math.abs(raw) > MODIFIER_CAP || (a.priorCreditEvents === 'Severe' && modifier > raw)
    ? ` raw=${raw.toFixed(2)} → capped/floored at modifier=${modifier.toFixed(2)} (DBRS ~2-notch bound)`
    : ` raw=${raw.toFixed(2)} → modifier=${modifier.toFixed(2)}`;

  // Pick a semantic tier label for the modifier direction.
  let tier: string;
  if (a.priorCreditEvents === 'Severe') {
    tier = 'disqualifying-event';     // factor-4 asymmetry
  } else if (modifier <= -0.10) {
    tier = 'strong-sponsor';
  } else if (modifier >= +0.10) {
    tier = 'weak-sponsor';
  } else {
    tier = 'neutral';
  }

  return {
    dimensionId: 'sponsor-borrower-quality',
    riskContribution: null,                 // NOT a peer tier
    tier,
    rationale:
      `Sponsor assessment: ${factorSummary}.${cappedNote} Direction: ` +
      `${tier} (${modifier < 0 ? 'risk-reducing' : modifier > 0 ? 'risk-increasing' : 'neutral'}). ` +
      `Sponsor cannot swing a deal alone — DBRS-bounded ±${MODIFIER_CAP.toFixed(2)} on the 0-1 risk scale.`,
    provenance: [
      'spec v2 §9 (Sponsor / borrower quality) — qualitative modifier, not a hard score',
      `DBRS comparative-review bound — ~2 notches translated to ±${MODIFIER_CAP.toFixed(2)} on this doctrine's 0-1 risk scale`,
      'Moody\'s sponsor-component treatment (component, not a separate tier)',
      'KBRA sponsor analysis (incorporated into structural review, not a peer tier)',
      'B-piece-investor workout-recovery practice — sponsor character decides cooperate-vs-fight posture',
      'Factor 4 (prior credit events) ASYMMETRIC upward: Severe reaches +bound independently',
      'Bound + per-factor weights convention-driven; corpus carries NO sponsor data (universally hitl-needed by design)',
    ],
    applicability: 'applicable',
    evaluated: true,
    riskModifier: modifier,
    derivedOutputs: {
      factorContributionExperience: cExperience,
      factorContributionFinancialStrength: cFinancial,
      factorContributionAlignment: cAlignment,
      factorContributionPriorCreditEvents: cPriorCredit,
      factorContributionManagementQuality: cMgmt,
      rawSumBeforeCap: raw,
      modifierAfterCap: modifier,
      modifierCap: MODIFIER_CAP,
    },
  };
}

export const SPONSOR_FACTOR_WEIGHTS = {
  symmetric: SYMMETRIC,
  priorCreditEvents: FACTOR4_PRIOR_CREDIT_EVENTS,
} as const;
