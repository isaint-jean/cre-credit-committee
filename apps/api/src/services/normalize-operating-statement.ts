import type {
  BorrowerOperatingStatementExtraction,
  NormalizationAdjustment,
  NormalizedOperatingStatement,
} from '@cre/contracts';

/**
 * Normalization layer — carries a borrower's REPORTED NOI to a recurring,
 * comparable basis via a TYPED list of adjustments. This is the underwriting
 * JUDGMENT layer, kept strictly separate from extraction (Phase 2's
 * `extract-operating-statement.ts` is a pure mirror and is NOT mutated here).
 *
 * ★ Deterministic + grounded: `normalizeOperatingStatement(raw, adjustments)`
 *   computes `normalizedNoi = rawNoi + Σ noiEffect` and verifies every
 *   adjustment ties to an actual raw account line (so the list can't drift from
 *   the source). Validated against Centrum's T-12: raw $6,952,469.80 →
 *   normalized $3,863,872.37 (to the cent) via `SUNROAD_T12_NORMALIZATION`.
 *
 * ★ GENERALIZATION (the hybrid design — not built this phase): the adjustment
 *   LIST is a PER-DEAL input, not a universal constant. In production it is
 *   either operator-confirmed or seeded by candidate-FLAGGING heuristics over
 *   the raw ladder, then confirmed:
 *     · Type A (non_recurring_income_strip): flag income lines with a single-
 *       month spike, or labels matching /termination|buyout|non[- ]?recurring/i.
 *     · Type B (below_noi_opex_reclass): flag below-NOI lines whose label is an
 *       operating-expense type (utilities/electric, recurring G&A) booked under
 *       a non-operating/partnership block.
 *     · Type C (non_operating_income_exclusion): flag interest/dividend income.
 *   The heuristics propose; a human (or a documented per-deal rule) disposes.
 *   This file encodes only the proven, confirmed list — the deterministic core.
 */

/** Round to cents to keep the reconciliation exact under float arithmetic. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Expected noiEffect for an adjustment given its type (strips/reclasses/excl
 * reduce NOI by the line amount; a net-zero bucket move has no NOI effect). */
function expectedNoiEffect(a: NormalizationAdjustment): number {
  return a.type === 'net_zero_bucket_move' ? 0 : -a.amount;
}

/**
 * Apply a typed adjustment list to a raw borrower operating statement.
 * `reconciles` is true only when EVERY adjustment (a) ties to an actual raw
 * line with a matching amount and (b) carries the noiEffect its type implies.
 */
export function normalizeOperatingStatement(
  raw: BorrowerOperatingStatementExtraction,
  adjustments: ReadonlyArray<NormalizationAdjustment>,
): NormalizedOperatingStatement {
  const rawNoi = raw.netOperatingIncome;
  if (rawNoi === null) {
    return { rawNoi: null, adjustments, normalizedNoi: null, reconciles: false };
  }

  const lineByCode = new Map(raw.lines.map((l) => [l.accountCode, l.total]));
  const grounded = adjustments.every((a) => {
    const lineTotal = lineByCode.get(a.accountCode);
    const tiesToLine = lineTotal !== undefined && Math.abs(lineTotal - a.amount) < 0.005;
    const noiEffectValid = Math.abs(a.noiEffect - expectedNoiEffect(a)) < 0.005;
    return tiesToLine && noiEffectValid;
  });

  const sumEffect = adjustments.reduce((s, a) => s + a.noiEffect, 0);
  const normalizedNoi = r2(rawNoi + sumEffect);

  return { rawNoi, adjustments, normalizedNoi, reconciles: grounded };
}

/**
 * The PROVEN, confirmed T-12 normalization for the Centrum / Sunroad deal — a
 * PER-DEAL input (the deterministic set Phase 1c reconciled to the cent), NOT a
 * universal constant. 9 typed lines across the 4-type taxonomy:
 *   A  420625 lease-termination fee strip            −2,850,630.63
 *   B  681089 + 681097 electric → utilities          −228,405.12
 *   B  681070/76/78/130 recurring G&A → opex           −9,266.70
 *   C  420925 interest income excluded                   −294.98
 *   D  660235 assessment fee (taxes→G&A, net-zero)            0.00
 *   raw 6,952,469.80 → normalized 3,863,872.37 ✓
 */
export const SUNROAD_T12_NORMALIZATION: ReadonlyArray<NormalizationAdjustment> = [
  {
    type: 'non_recurring_income_strip',
    accountCode: '420625',
    label: 'Lease Termination',
    amount: 2_850_630.63,
    noiEffect: -2_850_630.63,
    rationale: 'One-time lease-termination fee (entirely Jul-2023); excluded from recurring income.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681089',
    label: 'Electric - Vacant Space',
    amount: 82_869.10,
    noiEffect: -82_869.10,
    rationale: 'Operating electric (vacant space) mis-booked below NOI; reclassified into operating utilities.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681097',
    label: 'Electric-GSA',
    amount: 145_536.02,
    noiEffect: -145_536.02,
    rationale: 'Operating electric (GSA) mis-booked below NOI; reclassified into operating utilities.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681070',
    label: 'Tax Consulting',
    amount: 3_050.00,
    noiEffect: -3_050.00,
    rationale: 'Recurring entity-level G&A mis-booked below NOI; reclassified into operating G&A.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681076',
    label: 'Misc Consultant',
    amount: 1_011.70,
    noiEffect: -1_011.70,
    rationale: 'Recurring entity-level G&A mis-booked below NOI; reclassified into operating G&A.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681078',
    label: 'Tax Return Preparation',
    amount: 4_405.00,
    noiEffect: -4_405.00,
    rationale: 'Recurring entity-level G&A mis-booked below NOI; reclassified into operating G&A.',
  },
  {
    type: 'below_noi_opex_reclass',
    accountCode: '681130',
    label: 'Franchise Taxes',
    amount: 800.00,
    noiEffect: -800.00,
    rationale: 'Recurring entity-level G&A mis-booked below NOI; reclassified into operating G&A.',
  },
  {
    type: 'non_operating_income_exclusion',
    accountCode: '420925',
    label: 'Interest Income',
    amount: 294.98,
    noiEffect: -294.98,
    rationale: 'Non-operating interest income; excluded from operating revenue.',
  },
  {
    type: 'net_zero_bucket_move',
    accountCode: '660235',
    label: 'Owners Assessment Fee',
    amount: 4_304.04,
    noiEffect: 0,
    rationale: 'Re-categorised within opex (real-estate taxes → G&A); both above the NOI line, so net-zero on NOI.',
  },
];
