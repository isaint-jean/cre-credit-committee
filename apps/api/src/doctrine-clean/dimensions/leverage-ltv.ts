/**
 * doctrine-clean / dimensions / leverage-ltv.ts
 *
 * Dimension 1 — Leverage (LTV) on a sustainable / haircut value.
 *
 * SPEC v2 §1 (verbatim):
 *   Principle: loan balance against a sustainable/haircut value, not
 *   the appraisal.
 *   Convergence: KBRA KLTV (vs KBRA Value); DBRS LTV Sizing Benchmarks
 *   (vs DBRS Value, calibrated so ~61% LTV withstands a ~39% decline);
 *   Moody's LTV (vs Moody's Value, the primary loss-severity driver).
 *   Proposed treatment: LTV against a haircut value; elevated-leverage
 *   flag in the ~65–70% stressed-LTV region.
 *
 * FENCE: no import / reference to old manifesto_rules.json / old
 * doctrine / old LTV thresholds. Bands DERIVED from the convergence
 * above, NOT fit to the corpus.
 *
 * PROVENANCE — rewrite in own words:
 *
 *   The agencies converge on the same insight: LTV computed against
 *   appraisal hides leverage by accepting an inflated denominator.
 *   The defensible LTV is loan-balance over the agency-derived value
 *   (KBRA Value, DBRS Value, Moody's Value) — all three of which sit
 *   below appraisal. This dimension consumes the stressed value
 *   produced by dim 7 (cap-rate / valuation stress) and reads the
 *   stressed LTV from its derivedOutputs.
 *
 *   Band thresholds:
 *   - DBRS LTV Sizing Benchmark calibrates the ~61% LTV vs DBRS Value
 *     to withstand a ~39% appraisal-vs-stressed decline. The 61-65%
 *     region marks the durable / moderate boundary.
 *   - KBRA KLTV typically flags elevated leverage at 65-70% (the spec
 *     v2 §1 "~65-70% stressed-LTV region"). We set the moderate /
 *     elevated boundary at 65%.
 *   - 75% stressed LTV is materially above the DBRS calibration and
 *     into the KBRA "high leverage" zone — the elevated / high boundary.
 *   - 90%+ stressed LTV means the loan exceeds the agency-stressed
 *     value by a wide margin — tail.
 *
 *   These bands are CONVENTION-DRIVEN, not corpus-fit.
 */
import type { DimensionContribution } from '../types.js';

export interface LeverageLtvInput {
  /**
   * Stressed LTV in decimal (e.g., 0.65 = 65%). The canonical pipeline
   * reads this from dim 7's `derivedOutputs.stressedLtv` (loan amount
   * divided by the dim-7 stressed value). Pass null when dim 7 was
   * HITL or did not compute stressedLtv (e.g., loanAmount was null).
   */
  readonly stressedLtv: number | null;
}

interface LeverageBand {
  readonly tier: 'low' | 'moderate' | 'elevated' | 'high';
  readonly riskContribution: number;
  readonly minLtv: number;
  readonly maxLtv: number;
  readonly rationale: string;
}

const BANDS: readonly LeverageBand[] = [
  {
    tier: 'low',
    riskContribution: 0.10,
    minLtv: Number.NEGATIVE_INFINITY,
    maxLtv: 0.65,
    rationale:
      'Stressed LTV below 65%. Loan balance is comfortably below the ' +
      'agency-stressed value; DBRS LTV Sizing Benchmark places this ' +
      'band in durable territory (~61% calibrated to withstand a ~39% ' +
      'decline).',
  },
  {
    tier: 'moderate',
    riskContribution: 0.30,
    minLtv: 0.65,
    maxLtv: 0.75,
    rationale:
      'Stressed LTV 65-75%. Spec v2 §1 elevated-leverage region; KBRA ' +
      'KLTV typically flags here. Above the DBRS durable calibration ' +
      'but below the agency high-leverage zone.',
  },
  {
    tier: 'elevated',
    riskContribution: 0.55,
    minLtv: 0.75,
    maxLtv: 0.90,
    rationale:
      'Stressed LTV 75-90%. Materially above the agency-stressed ' +
      'value; severity-of-loss exposure rises sharply (Moody\'s LTV is ' +
      'the primary loss-severity driver).',
  },
  {
    tier: 'high',
    riskContribution: 0.80,
    minLtv: 0.90,
    maxLtv: Number.POSITIVE_INFINITY,
    rationale:
      'Stressed LTV 90%+. Loan exceeds the agency-stressed value by a ' +
      'wide margin; default-event recovery against the stressed value ' +
      'leaves little or no equity.',
  },
] as const;

export function evaluateLeverageLtv(
  input: LeverageLtvInput,
): DimensionContribution {
  if (input.stressedLtv === null) {
    return {
      dimensionId: 'leverage-ltv',
      riskContribution: null,
      tier: 'N/A',
      rationale:
        '[HITL — stressedLtv absent] Leverage dimension requires the ' +
        'stressed LTV from dim 7\'s derivedOutputs.stressedLtv. Route ' +
        'to human review. NEVER substitute a conservative default at ' +
        'the contribution layer.',
      provenance: ['input absent — no provenance trace possible'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  if (input.stressedLtv < 0 || !Number.isFinite(input.stressedLtv)) {
    return {
      dimensionId: 'leverage-ltv',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — invalid stressedLtv=${input.stressedLtv}] Sanity gate failed upstream; route to human review.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }
  const band = BANDS.find(b => input.stressedLtv! >= b.minLtv && input.stressedLtv! < b.maxLtv)!;
  return {
    dimensionId: 'leverage-ltv',
    riskContribution: band.riskContribution,
    tier: band.tier,
    rationale: `Stressed LTV ${(input.stressedLtv * 100).toFixed(1)}% → ${band.tier}. ${band.rationale}`,
    provenance: [
      'spec v2 §1 (Leverage / LTV)',
      'DBRS Morningstar LTV Sizing Benchmark — ~61% LTV vs DBRS Value withstands ~39% decline',
      'KBRA KLTV (KBRA North American CMBS Property Evaluation Methodology) — elevated-leverage flag ~65-70%',
      'Moody\'s LTV (vs Moody\'s Value) — primary loss-severity driver',
      'Numerator = loan balance; denominator = stressed value from dim 7 (sustainable NCF / stressed cap rate)',
      'Bands convention-driven (agency convergence), NOT fit to clean corpus',
    ],
    applicability: 'applicable',
    evaluated: true,
    derivedOutputs: {
      stressedLtv: input.stressedLtv,
    },
  };
}

export const LEVERAGE_LTV_BANDS = BANDS;
