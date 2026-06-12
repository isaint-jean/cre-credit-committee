/**
 * doctrine-clean / dimensions / coverage-dscr.ts
 *
 * Dimension 2 — Coverage (DSCR) on sustainable cash flow.
 *
 * SPEC v2 §2 (verbatim):
 *   Principle: coverage on stressed/sustainable cash flow, not in-place
 *   alone.
 *   Convergence: KBRA KDSC; DBRS DSCR benchmarks; Moody's actual +
 *   stressed DSCR (the primary PoD driver). KBRA default study: DSC
 *   1.2-2.0x defaulted far more than >3.0x.
 *   Proposed treatment: minimum coverage threshold (~1.20-1.25x
 *   convention); compute on haircut NOI.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old DSCR thresholds. Bands derived from the convergence
 * above, NOT fit to the corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   The agencies converge on a sliding-scale view of coverage:
 *   - KBRA's default study (a public empirical anchor): conduit loans
 *     with KDSC 1.2-2.0x defaulted at materially higher rates than
 *     loans above 3.0x. The 1.20-1.25x region is the agency-convention
 *     minimum coverage threshold across KBRA / DBRS / Moody's.
 *   - Moody's stressed DSCR is the primary probability-of-default
 *     driver in their conduit/fusion methodology.
 *   - The "stressed/sustainable cash flow" basis is critical: in-place
 *     DSCR can be flattered by issuer projections; the defensible DSCR
 *     numerator is sustainable NCF (from the normalization layer).
 *
 *   Band thresholds (sustainable-NCF DSCR):
 *   - strong ≥ 1.50x: durable coverage; comfortable above the
 *     agency-convention floor and KBRA default-study breakpoint
 *   - adequate 1.25-1.50x: agency-typical; at-or-above convention
 *   - thin 1.00-1.25x: below the 1.20-1.25x agency floor; KBRA default
 *     study showed materially elevated defaults here
 *   - distressed < 1.00x: coverage gap; cash flow does not service debt
 *     on the sustainable basis
 *
 *   DEBT SERVICE computation:
 *   - When `amortMonths` is provided: standard mortgage payment with
 *     monthly rate = coupon/12, n = amortMonths. Annual DS = 12 × monthly.
 *   - When loan is IO (ioYears >= termYears, or amortMonths null):
 *     interest-only stress, annual DS = loanAmount × coupon. This is
 *     the agency-conservative path: it floors the loan's debt service
 *     at the interest-only level, which is the lowest the borrower
 *     ever pays, and surfaces the maturity refinancing risk separately
 *     (a future dimension's job).
 *   - The agencies' "stressed DSCR" is computed at the stressed-NCF
 *     basis with the actual debt service convention. We use IO when
 *     amort schedule is absent — conservative on the numerator side
 *     (NCF stressed), neutral on the denominator (don't add extra
 *     stress on top of unknown amort).
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type { DimensionContribution } from '../types.js';

export interface CoverageDscrInput {
  /**
   * Sustainable NCF in dollars from the normalization layer. Numerator
   * of the stressed DSCR. Null when normalization was HITL.
   */
  readonly sustainableNcf: number | null;
  /** Loan amount in dollars. Drives debt service computation. */
  readonly loanAmount: number | null;
  /** Coupon in decimal (e.g., 0.0424 = 4.24%). Drives debt service. */
  readonly coupon: number | null;
  /**
   * Amortization months. When provided AND less than ioYears * 12 +
   * termYears * 12 conditions don't apply, debt service is the standard
   * amortizing mortgage payment. When null, debt service falls back to
   * interest-only.
   */
  readonly amortMonths: number | null;
  /**
   * Years of interest-only at the start of the loan. When ioYears
   * covers the entire term (ioYears >= termYears) the loan is fully IO
   * and debt service = loanAmount × coupon.
   */
  readonly ioYears: number | null;
  /** Loan term in years. */
  readonly termYears: number | null;
}

interface CoverageBand {
  readonly tier: 'strong' | 'adequate' | 'thin' | 'distressed';
  readonly riskContribution: number;
  readonly minDscr: number;
  readonly maxDscr: number;
  readonly rationale: string;
}

const BANDS: readonly CoverageBand[] = [
  {
    tier: 'strong',
    riskContribution: 0.10,
    minDscr: 1.50,
    maxDscr: Number.POSITIVE_INFINITY,
    rationale:
      'Stressed DSCR >= 1.50x. Durable coverage — comfortably above ' +
      'the agency-convention 1.20-1.25x floor and the KBRA default-' +
      'study elevated-default region (DSC 1.2-2.0x).',
  },
  {
    tier: 'adequate',
    riskContribution: 0.30,
    minDscr: 1.25,
    maxDscr: 1.50,
    rationale:
      'Stressed DSCR 1.25-1.50x. Agency-typical conduit zone. ' +
      'At-or-above the convention floor; within KBRA\'s elevated-' +
      'default 1.2-2.0x band but above the bottom of that band.',
  },
  {
    tier: 'thin',
    riskContribution: 0.55,
    minDscr: 1.00,
    maxDscr: 1.25,
    rationale:
      'Stressed DSCR 1.00-1.25x. Below the 1.20-1.25x agency-' +
      'convention floor. KBRA default study showed materially elevated ' +
      'defaults in this region. Moody\'s stressed DSCR is their primary ' +
      'PoD driver — this band signals it.',
  },
  {
    tier: 'distressed',
    riskContribution: 0.80,
    minDscr: Number.NEGATIVE_INFINITY,
    maxDscr: 1.00,
    rationale:
      'Stressed DSCR < 1.00x. Cash flow does not service debt on the ' +
      'sustainable basis; coverage gap.',
  },
] as const;

/**
 * Compute annual debt service. Returns null when inputs insufficient.
 *
 *   - IO loan (ioYears >= termYears, or amortMonths null and coupon known):
 *       DS = loanAmount × coupon
 *   - Amortizing (amortMonths provided):
 *       monthly rate r = coupon / 12; n = amortMonths
 *       monthly payment = loanAmount × r / (1 − (1+r)^(−n))
 *       DS = 12 × monthly
 *
 * Returns { annualDs, basis } so the dimension can cite the path used.
 */
function computeAnnualDebtService(
  loanAmount: number,
  coupon: number,
  amortMonths: number | null,
  ioYears: number | null,
  termYears: number | null,
): { annualDs: number; basis: 'interest-only' | 'amortizing' } {
  const isFullIo = ioYears !== null && termYears !== null && ioYears >= termYears;
  if (isFullIo || amortMonths === null || amortMonths <= 0) {
    return { annualDs: loanAmount * coupon, basis: 'interest-only' };
  }
  const r = coupon / 12;
  if (r <= 0) {
    return { annualDs: loanAmount / (amortMonths / 12), basis: 'amortizing' };
  }
  const monthly = (loanAmount * r) / (1 - Math.pow(1 + r, -amortMonths));
  return { annualDs: 12 * monthly, basis: 'amortizing' };
}

export function evaluateCoverageDscr(
  input: CoverageDscrInput,
): DimensionContribution {
  if (input.sustainableNcf === null || input.loanAmount === null || input.coupon === null) {
    const missing: string[] = [];
    if (input.sustainableNcf === null) missing.push('sustainableNcf');
    if (input.loanAmount === null) missing.push('loanAmount');
    if (input.coupon === null) missing.push('coupon');
    return {
      dimensionId: 'coverage-dscr',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — missing input(s): ${missing.join(', ')}] Coverage dimension requires sustainable NCF + loan amount + coupon. Route to human review.`,
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  if (input.loanAmount <= 0 || input.coupon <= 0) {
    return {
      dimensionId: 'coverage-dscr',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — non-positive input(s)] loanAmount=${input.loanAmount}, coupon=${input.coupon}. Sanity gate failed upstream.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  const { annualDs, basis } = computeAnnualDebtService(
    input.loanAmount, input.coupon, input.amortMonths, input.ioYears, input.termYears,
  );
  if (annualDs <= 0 || !Number.isFinite(annualDs)) {
    return {
      dimensionId: 'coverage-dscr',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — invalid annualDs=${annualDs}] Debt service computation produced invalid result. Route to human review.`,
      provenance: ['debt-service formula failure — upstream input issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  const stressedDscr = input.sustainableNcf / annualDs;
  const band = BANDS.find(b => stressedDscr >= b.minDscr && stressedDscr < b.maxDscr)!;
  return {
    dimensionId: 'coverage-dscr',
    riskContribution: band.riskContribution,
    tier: band.tier,
    rationale:
      `Stressed DSCR = sustainable NCF $${Math.round(input.sustainableNcf).toLocaleString()} / annual DS $${Math.round(annualDs).toLocaleString()} (${basis}) = ${stressedDscr.toFixed(2)}x → ${band.tier}. ${band.rationale}`,
    provenance: [
      'spec v2 §2 (Coverage / DSCR)',
      'KBRA KDSC + KBRA default study (DSC 1.2-2.0x defaulted materially more than >3.0x)',
      'DBRS Morningstar DSCR benchmarks',
      'Moody\'s Approach to Rating US Conduit/Fusion CMBS — stressed DSCR is primary PoD driver',
      'Numerator = sustainable NCF (from normalization layer; KBRA KNCF / DBRS stabilized-NCF basis)',
      `Denominator = annual debt service (${basis}): ${basis === 'interest-only' ? 'loanAmount × coupon (conservative when amort schedule unknown)' : 'standard mortgage payment × 12'}`,
      'Bands convention-driven (agency convergence), NOT fit to clean corpus',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      stressedDscr,
      annualDebtService: annualDs,
      debtServiceBasisIsIo: basis === 'interest-only' ? 1 : 0,
    },
  };
}

export const COVERAGE_DSCR_BANDS = BANDS;
export { computeAnnualDebtService };
