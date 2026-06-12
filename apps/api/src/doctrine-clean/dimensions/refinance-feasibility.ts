/**
 * doctrine-clean / dimensions / refinance-feasibility.ts
 *
 * Dimension 4 — Refinance feasibility (maturity / balloon risk).
 *
 * SPEC v2 §4 (verbatim):
 *   Principle: can the loan exit at maturity under stressed rates —
 *   exit DY / refi coverage at a stressed constant.
 *   Convergence: KBRA office Watch (low DY, high LTV, low coverage,
 *   near-term maturity = refi risk); DBRS post-GFC term/IO PoD
 *   treatment; Moody's term and maturity in PoD.
 *   Proposed treatment: test exit DY/DSCR at a stressed refinance
 *   constant; flag near-term maturity + thin exit metrics.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old refi logic. Numbers below derived from agency
 * conventions (KBRA office Watch refi test, DBRS stressed take-out,
 * Moody's maturity PoD), NOT fit to the 12-loss corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   A CMBS loan repays in one of two ways: amortization during term
 *   (a fraction of principal) and a balloon at maturity (the rest).
 *   The agencies converge on the view that the balloon's refinanceability
 *   is the second leg of credit risk, separate from term-default. KBRA's
 *   office Watch surveillance criterion makes the convergence explicit:
 *   the loans they flag for refi risk are those with LOW debt yield,
 *   HIGH stressed LTV, LOW coverage, and a NEAR-TERM maturity. DBRS's
 *   post-GFC stressed take-out approach is the same idea — apply a
 *   take-out lender's stressed refi constant to the maturity balance,
 *   and see whether the property's sustainable NCF clears the resulting
 *   debt service. Moody's incorporates maturity-default into their PoD
 *   calculus directly.
 *
 *   Three exit metrics, all computed at the MATURITY balance:
 *     - exit DY   = sustainable NOI / maturity balance
 *     - exit DSCR = sustainable NCF / (maturity balance × stressed refi constant)
 *     - exit LTV  = maturity balance / stressed value (dim 7)
 *
 *   STRESSED REFI CONSTANT:
 *     The take-out lender at maturity is assumed to lend at a stressed
 *     rate plus standard amortization. KBRA's office Watch uses a
 *     ~9.25% stressed refi constant (decomposed as roughly ~7-7.5%
 *     stressed take-out rate + 30-year amortization). DBRS uses a
 *     similar band; Moody's is in the same neighborhood. We default to
 *     0.0925 — a single conservative number that all three agencies
 *     cluster near. The constant is exposed as an input so future
 *     wiring can asset-class-differentiate if needed (spec v2 §4
 *     treats it as agency-convention agnostic).
 *
 *   EXIT HURDLES (from KBRA office Watch + DBRS take-out + Moody's):
 *     - exit DSCR: flag thin <1.20x, distressed <1.00x
 *     - exit DY:   flag thin <9.0%, distressed <7.0%
 *     - exit LTV:  flag elevated >75%, high >90%
 *
 *   RISK AGGREGATION (KBRA office Watch convergence pattern):
 *     KBRA explicitly flags loans where LOW DY + HIGH LTV + LOW
 *     COVERAGE all converge. We compute each leg's risk contribution
 *     and take the BINDING (max) leg as the dimension's tier and risk
 *     contribution. When multiple legs land at elevated+, the tier
 *     label is 'convergent-stress' (the office-Watch convergence
 *     pattern) and the contribution is bumped 0.10 above the max,
 *     capped at 1.0.
 *
 *   MATURITY BALANCE COMPUTATION:
 *     - IO full term (ioYears >= termYears OR amortMonths null):
 *         balance = loanAmount  (no paydown — worst exit case)
 *     - Fully amortizing from origination (ioYears null / 0):
 *         balance = standard mortgage-balance formula at termYears * 12
 *     - Partial-IO (0 < ioYears < termYears):
 *         balance held flat for ioYears, then amortizing-balance
 *         formula on full balance over remaining (termYears - ioYears)
 *
 *   ON THE CURRENT CORPUS:
 *     `amortMonths` / `ioYears` / `termYears` are not yet extracted.
 *     EVERY record routes through the IO no-paydown path (maturity
 *     balance = loanAmount). This is the agency-conservative default
 *     (IO carries the full balance to maturity → worst exit). The
 *     rationale flags this explicitly so reviewers see the assumption.
 *
 *   PARI-PASSU CAVEAT:
 *     Exit DSCR and exit DY use `loanAmount` in the denominator. When
 *     the corpus carries a trust-slice loanAmount (not the whole-loan
 *     basis), exit DSCR and exit DY will be inflated on the same ~17
 *     records the going-in ratio dimensions flagged. Not a refi bug —
 *     upstream pari-passu normalization gap. Sanity harness surfaces
 *     the same record set.
 *
 *   STANDALONE SEPARATION EXPECTATION:
 *     The clean corpus's losses are mostly TERM/operational defaults,
 *     NOT maturity/refi defaults. The dimension may NOT separate
 *     LOSS-vs-CLEAN on this corpus, and a flat/weak read is acceptable
 *     and reported with that framing. The dimension's value is
 *     forward-looking — refi risk for live loans approaching maturity
 *     under a different rate regime than at origination.
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

export interface RefinanceFeasibilityInput {
  /**
   * Asset type (canonical class string the extractor / clean adapter
   * emits, e.g. 'Office'). Used to select the stressed refi take-out
   * constant by asset-key (see STRESSED_REFI_CONSTANT_BY_ASSET); the
   * per-deal `stressedRefiConstant` override still takes precedence.
   * Null falls through to the _default key (0.0925).
   */
  readonly assetType: string | null;
  /** Loan amount at origination, in dollars. */
  readonly loanAmount: number | null;
  /** Coupon in decimal (e.g., 0.0424 = 4.24%). Drives amortization. */
  readonly coupon: number | null;
  /**
   * Amortization months. When null, the maturity balance falls to the
   * IO no-paydown path (balance = loanAmount), the agency-conservative
   * default for unknown amort schedule.
   */
  readonly amortMonths: number | null;
  /**
   * Initial interest-only period in years. When null or 0, the loan is
   * treated as fully amortizing from origination (assuming amortMonths
   * is provided). When >= termYears, the loan is IO full term.
   */
  readonly ioYears: number | null;
  /** Loan term in years. */
  readonly termYears: number | null;
  /** Sustainable NCF (from normalization layer). Numerator of exit DSCR. */
  readonly sustainableNcf: number | null;
  /** Sustainable NOI (from normalization layer). Numerator of exit DY. */
  readonly sustainableNoi: number | null;
  /** Stressed value (from dim 7 derivedOutputs). Denominator of exit LTV. */
  readonly stressedValue: number | null;
  /**
   * Stressed refi constant in decimal. KBRA office Watch /
   * DBRS stressed take-out convention ~0.0925 (≈ 7.25% stressed rate
   * over 30-year amort). Optional — defaults to 0.0925.
   */
  readonly stressedRefiConstant?: number | null;
}

/**
 * Stressed take-out constant by asset class — OPERATOR-JUDGMENT locked
 * desk knob. Anchored to KBRA office Watch refi test + DBRS post-GFC
 * stressed take-out treatment; NOT employer-derived.
 *
 * Office carries a tightened constant (10.00%) reflecting the post-2020
 * structural-pressure thesis (work-from-home dislocation + re-leasing
 * uncertainty raises the take-out lender's required cushion). All
 * other asset classes fall through to the _default = 9.25% (the
 * agency-convention central value: ~7.25% stressed rate over 30-yr
 * amort), unchanged from prior behavior.
 *
 * Per-deal override: `RefinanceFeasibilityInput.stressedRefiConstant`
 * takes precedence over this map when provided. Selection order:
 *   1. input.stressedRefiConstant (if non-null and > 0)
 *   2. STRESSED_REFI_CONSTANT_BY_ASSET[assetType] (if assetType resolves)
 *   3. STRESSED_REFI_CONSTANT_BY_ASSET['_default'] (0.0925)
 */
const STRESSED_REFI_CONSTANT_BY_ASSET: ReadonlyMap<string, number> = new Map([
  ['Office',   0.10],
  ['_default', 0.0925],
]);

/** Resolve the stressed refi constant for an asset class (used as
 *  fallback when no per-deal override is supplied). */
function resolveStressedRefiConstant(assetType: string | null): number {
  if (assetType !== null && STRESSED_REFI_CONSTANT_BY_ASSET.has(assetType)) {
    return STRESSED_REFI_CONSTANT_BY_ASSET.get(assetType)!;
  }
  return STRESSED_REFI_CONSTANT_BY_ASSET.get('_default')!;
}

/** Legacy export — preserved for callers that still reference the
 *  scalar default. New code reads via resolveStressedRefiConstant. */
const DEFAULT_STRESSED_REFI_CONSTANT = STRESSED_REFI_CONSTANT_BY_ASSET.get('_default')!;

/**
 * Compute the loan balance AT MATURITY for refi-exit purposes.
 *
 * Returns { balance, basis } so the dimension can cite the amort path.
 */
function computeMaturityBalance(
  loanAmount: number,
  coupon: number,
  amortMonths: number | null,
  ioYears: number | null,
  termYears: number | null,
): { balance: number; basis: 'no-paydown-io' | 'fully-amortizing' | 'partial-io' } {
  const isFullIo = ioYears !== null && termYears !== null && ioYears >= termYears;
  if (isFullIo || amortMonths === null || amortMonths <= 0 || termYears === null || termYears <= 0) {
    return { balance: loanAmount, basis: 'no-paydown-io' };
  }
  const r = coupon / 12;
  if (r <= 0) {
    // 0% coupon edge case — linear paydown.
    const monthsToAmort = (termYears - (ioYears ?? 0)) * 12;
    const monthlyPrincipal = loanAmount / amortMonths;
    const balance = Math.max(0, loanAmount - monthlyPrincipal * monthsToAmort);
    return { balance, basis: (ioYears ?? 0) > 0 ? 'partial-io' : 'fully-amortizing' };
  }
  // Standard mortgage payment from full balance over amortMonths.
  const monthlyPayment = (loanAmount * r) / (1 - Math.pow(1 + r, -amortMonths));
  // Months of amortization between origination and maturity (after IO period).
  const ioYrs = ioYears ?? 0;
  const amortizingMonths = Math.max(0, (termYears - ioYrs) * 12);
  // Balance after `amortizingMonths` of payments at `monthlyPayment` on a loan
  // that started fully balanced (IO period leaves principal untouched).
  // Closed-form: B_t = L * (1+r)^t - P * ((1+r)^t - 1) / r
  const growth = Math.pow(1 + r, amortizingMonths);
  const balance = loanAmount * growth - monthlyPayment * (growth - 1) / r;
  const finalBalance = Math.max(0, balance);
  return { balance: finalBalance, basis: ioYrs > 0 ? 'partial-io' : 'fully-amortizing' };
}

interface LegBand {
  readonly tier: 'low' | 'moderate' | 'elevated' | 'high';
  readonly riskContribution: number;
}
const LEG_LOW: LegBand      = { tier: 'low',      riskContribution: 0.10 };
const LEG_MOD: LegBand      = { tier: 'moderate', riskContribution: 0.30 };
const LEG_ELEVATED: LegBand = { tier: 'elevated', riskContribution: 0.55 };
const LEG_HIGH: LegBand     = { tier: 'high',     riskContribution: 0.80 };

/**
 * The exit-DSCR threshold above which the loan is REFINANCEABLE under
 * dim 4's stress (corresponds to the moderate/elevated leg boundary).
 * Exposed for the mitigant layer so the lever and the doctrine agree
 * on "refinanceable" — when the mitigant sizes a paydown / amortization
 * to clear this threshold, dim 4's leg score will move from elevated+
 * to moderate.
 */
export const EXIT_DSCR_REFINANCEABLE_THRESHOLD = 1.20;

function scoreDscrLeg(dscr: number): LegBand {
  if (dscr >= 1.50) return LEG_LOW;
  if (dscr >= EXIT_DSCR_REFINANCEABLE_THRESHOLD) return LEG_MOD;
  if (dscr >= 1.00) return LEG_ELEVATED;
  return LEG_HIGH;
}
function scoreDyLeg(dy: number): LegBand {
  if (dy >= 0.110) return LEG_LOW;
  if (dy >= 0.090) return LEG_MOD;
  if (dy >= 0.070) return LEG_ELEVATED;
  return LEG_HIGH;
}
function scoreLtvLeg(ltv: number): LegBand {
  if (ltv < 0.65) return LEG_LOW;
  if (ltv < 0.75) return LEG_MOD;
  if (ltv < 0.90) return LEG_ELEVATED;
  return LEG_HIGH;
}

export function evaluateRefinanceFeasibility(
  input: RefinanceFeasibilityInput,
): DimensionContribution {
  // HITL — required inputs.
  if (
    input.loanAmount === null ||
    input.coupon === null ||
    input.sustainableNcf === null ||
    input.sustainableNoi === null ||
    input.stressedValue === null
  ) {
    const missing: string[] = [];
    if (input.loanAmount === null) missing.push('loanAmount');
    if (input.coupon === null) missing.push('coupon');
    if (input.sustainableNcf === null) missing.push('sustainableNcf');
    if (input.sustainableNoi === null) missing.push('sustainableNoi');
    if (input.stressedValue === null) missing.push('stressedValue');
    return {
      dimensionId: 'refinance-feasibility',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — missing input(s): ${missing.join(', ')}] Refi-feasibility dimension requires loan + coupon + sustainable NCF/NOI + stressed value. Route to human review.`,
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  if (input.loanAmount <= 0 || input.coupon <= 0 || input.stressedValue <= 0) {
    return {
      dimensionId: 'refinance-feasibility',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — non-positive input(s)] loanAmount=${input.loanAmount}, coupon=${input.coupon}, stressedValue=${input.stressedValue}. Sanity gate failed upstream.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // Selection order:
  //   (1) per-deal override (input.stressedRefiConstant) — top precedence
  //   (2) asset-keyed lookup (STRESSED_REFI_CONSTANT_BY_ASSET[assetType])
  //   (3) fall-through _default (0.0925)
  const stressedRefiConstant = (input.stressedRefiConstant ?? null) !== null && input.stressedRefiConstant! > 0
    ? input.stressedRefiConstant!
    : resolveStressedRefiConstant(input.assetType);

  const { balance, basis } = computeMaturityBalance(
    input.loanAmount, input.coupon, input.amortMonths, input.ioYears, input.termYears,
  );

  // Defensive — if balance is non-positive or NaN, refuse to score.
  if (!Number.isFinite(balance) || balance <= 0) {
    return {
      dimensionId: 'refinance-feasibility',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — invalid maturity balance=${balance}] Amortization computation produced invalid result.`,
      provenance: ['maturity-balance formula failure — upstream input issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // Three exit metrics.
  const exitDscrDs = balance * stressedRefiConstant;
  const exitDscr = input.sustainableNcf / exitDscrDs;
  const exitDy = input.sustainableNoi / balance;
  const exitLtv = balance / input.stressedValue;

  // Score each leg.
  const legDscr = scoreDscrLeg(exitDscr);
  const legDy = scoreDyLeg(exitDy);
  const legLtv = scoreLtvLeg(exitLtv);
  const legs = [
    { name: 'exit DSCR', leg: legDscr, value: exitDscr, fmt: (x: number) => x.toFixed(2) + 'x' },
    { name: 'exit DY',   leg: legDy,   value: exitDy,   fmt: (x: number) => (x * 100).toFixed(2) + '%' },
    { name: 'exit LTV',  leg: legLtv,  value: exitLtv,  fmt: (x: number) => (x * 100).toFixed(1) + '%' },
  ];

  // Risk: max across legs; bump 0.10 for KBRA-office-Watch convergence
  // (≥ 2 legs at elevated+) capped at 1.0.
  const elevatedOrAbove = legs.filter(l => l.leg.riskContribution >= 0.55).length;
  const maxLeg = legs.reduce((a, b) => a.leg.riskContribution >= b.leg.riskContribution ? a : b);
  let riskContribution = maxLeg.leg.riskContribution;
  let tier: string = maxLeg.leg.tier;
  let convergenceNote = '';
  if (elevatedOrAbove >= 2) {
    riskContribution = Math.min(1.0, riskContribution + 0.10);
    tier = 'convergent-stress';
    convergenceNote = ` KBRA-office-Watch convergence pattern: ${elevatedOrAbove} of 3 legs at elevated+ — risk bumped by 0.10.`;
  }

  const bindingLeg = maxLeg.name;
  const legSummary = legs.map(l => `${l.name}=${l.fmt(l.value)}(${l.leg.tier})`).join(', ');

  return {
    dimensionId: 'refinance-feasibility',
    riskContribution,
    tier,
    rationale:
      `Maturity balance basis=${basis} → balance $${Math.round(balance).toLocaleString()}. ` +
      `Take-out at stressed refi constant ${(stressedRefiConstant * 100).toFixed(2)}% (KBRA office Watch / DBRS take-out). ` +
      `Legs: ${legSummary}. Binding leg = ${bindingLeg}.${convergenceNote}`,
    provenance: [
      'spec v2 §4 (Refinance feasibility)',
      'KBRA office Watch refi test — low DY + high LTV + low coverage + near-term maturity converge',
      'DBRS Morningstar post-GFC stressed take-out treatment',
      'Moody\'s Approach to Rating US Conduit/Fusion CMBS — term + maturity in PoD',
      `Stressed refi constant ${(stressedRefiConstant * 100).toFixed(2)}% (default: ~7.25% stressed rate + 30-year amort = ~9.25%) — agency-convention central, NOT corpus-fit`,
      `Maturity-balance basis: ${basis} (${basis === 'no-paydown-io' ? 'amortMonths absent or ioYears >= termYears — full balance to maturity, agency-conservative' : basis === 'partial-io' ? 'IO for ioYears then amortizing schedule on full balance' : 'fully-amortizing from origination'})`,
      'Exit-leg hurdles — DSCR: thin <1.20x / distressed <1.00x; DY: thin <9.0% / distressed <7.0%; LTV: elevated >75% / high >90%',
      'KBRA-office-Watch convergence: ≥2 legs at elevated+ → risk bumped 0.10 (label tier=\'convergent-stress\')',
      'Numerator sources: sustainable NCF + sustainable NOI from normalization layer (KBRA KNCF / DBRS stabilized-NCF basis)',
      'PARI-PASSU CAVEAT: exit DSCR + exit DY use loanAmount → inflated on trust-slice records; same upstream gap as the going-in ratio dimensions',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      maturityBalance: balance,
      stressedRefiConstant,
      exitDscr,
      exitDy,
      exitLtv,
      legsAtElevatedOrAbove: elevatedOrAbove,
    },
  };
}

export const STRESSED_REFI_CONSTANT_DEFAULT = DEFAULT_STRESSED_REFI_CONSTANT;
export const STRESSED_REFI_CONSTANT_BY_ASSET_TABLE = STRESSED_REFI_CONSTANT_BY_ASSET;
export { computeMaturityBalance };
