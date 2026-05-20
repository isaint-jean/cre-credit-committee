/**
 * Per-line-item source-tier cascades + the highest-available picker.
 *
 * Each line item declares its preference order explicitly. The picker reads candidates in
 * order and returns the first non-null value with its source tier. When all candidates are
 * null, the picker returns `MANUAL` source with `null` value — the line-item helper then
 * falls back to library substitution (Pattern 1/2) or throws.
 *
 * Distrust-tier detection (architecture §1) is NOT triggered by automatic cascade picking —
 * it would only fire if a manifesto rule or operator override forced a lower tier despite a
 * higher one being available. Not exercised in v1.0; the cascade picks highest-available
 * unconditionally.
 *
 * The cascades shipped here cover the line items needed by NOI cap (bank NOI source),
 * vacancy floor logic (T-12 vs seller UW vacancy), and cap-rate substitution (appraisal vs ASR).
 * Full per-line-item cascades for all 17 fields land with the orchestrator in 3c.
 */

import type {
  ExtractionResult,
  SourceTier,
} from '@cre/contracts';

export interface SourceCandidate {
  readonly tier: SourceTier;
  readonly value: number | null;
}

export interface ResolvedSource {
  readonly tier: SourceTier;
  readonly value: number | null;
}

/**
 * Pick the first candidate whose value is non-null. If all are null, return MANUAL with null
 * value — caller handles the missing-data path (substitution or throw).
 */
export function pickFirstNonNull(
  candidates: readonly SourceCandidate[],
): ResolvedSource {
  for (const c of candidates) {
    if (c.value !== null) {
      return { tier: c.tier, value: c.value };
    }
  }
  return { tier: 'MANUAL', value: null };
}

/* ---------------------- per-line-item cascades (subset for 3b) ---------------------- */

/**
 * Vacancy as a fraction (0..1). T-12 derives from `vacancyLoss / grossPotentialRent`;
 * seller UW supplies the field directly.
 */
export function vacancyPctCascade(extraction: ExtractionResult): readonly SourceCandidate[] {
  const cs: SourceCandidate[] = [];

  // T-12: vacancyLoss / grossPotentialRent
  if (extraction.t12 !== null) {
    const gpr = extraction.t12.income.grossPotentialRent;
    const vl = extraction.t12.vacancyLoss;
    const value = gpr !== null && gpr > 0 && vl !== null ? vl / gpr : null;
    cs.push({ tier: 'T12_ACTUAL', value });
  }

  // Seller UW: underwrittenVacancy directly
  if (extraction.sellerUw !== null) {
    cs.push({ tier: 'SELLER_UW', value: extraction.sellerUw.underwrittenVacancy });
  }

  return cs;
}

/**
 * Cap rate as a fraction (0..1). Appraisal first; ASR as fallback (note: skipping seller UW
 * since the contract doesn't carry a sellerUw cap-rate field).
 */
export function capRateCascade(extraction: ExtractionResult): readonly SourceCandidate[] {
  const cs: SourceCandidate[] = [];
  if (extraction.appraisal !== null) {
    cs.push({ tier: 'APPRAISAL', value: extraction.appraisal.capRate });
  }
  if (extraction.asr !== null) {
    cs.push({ tier: 'ASR', value: extraction.asr.impliedCapRate });
  }
  return cs;
}

/**
 * Bank NOI for the §6 NOI ceiling. T-12 actual is the canonical bank baseline; seller UW is
 * the fallback when no T-12 is available.
 */
export function bankNoiCascade(extraction: ExtractionResult): readonly SourceCandidate[] {
  const cs: SourceCandidate[] = [];
  if (extraction.t12 !== null) {
    cs.push({ tier: 'T12_ACTUAL', value: extraction.t12.noi });
  }
  if (extraction.sellerUw !== null) {
    cs.push({ tier: 'SELLER_UW', value: extraction.sellerUw.underwrittenNOI });
  }
  return cs;
}

/**
 * Bank vacancy for the §6 conservatism floor (max(library median, bank vacancy)). Same
 * cascade as `vacancyPctCascade` — the engine reads the bank value to compute the floor;
 * downstream judgment uses this value as the bankFloor argument for `adjustWithFloor`.
 */
export function bankVacancyCascade(extraction: ExtractionResult): readonly SourceCandidate[] {
  return vacancyPctCascade(extraction);
}
