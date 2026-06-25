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
  RentRoll,
  SourceTier,
} from '@cre/contracts';
import { computeSignedLeaseCreditedNoi } from './signed-lease-credit.js';

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
 * Helper: derive vacancyPct from an OperatingStatementExtraction snapshot via
 * |vacancyLoss| / grossPotentialRent. Returns null when either field is null
 * or GPR is non-positive. Sign-normalized (CMBS-style CFs record vacancyLoss
 * as a negative dollar amount).
 */
function vacancyPctFromStatement(
  s: import('@cre/contracts').OperatingStatementExtraction | null,
): number | null {
  if (s === null) return null;
  const gpr = s.income.grossPotentialRent;
  const vl = s.vacancyLoss;
  if (gpr === null || gpr <= 0 || vl === null) return null;
  return Math.abs(vl) / gpr;
}

/**
 * Vacancy as a fraction (0..1).
 *
 * Class-(a) cascade (locked 2026-05-31): T12_ACTUAL → SELLER_UW → IN_PLACE.
 * Vacancy is a class-(a) field because the issuer's UW column carries the
 * issuer's adjusted vacancy assumption (e.g., "Commercial Adj. to Market
 * Vacancy" on Sunroad), which is meaningful credit data; reading In-Place's
 * vacancy (an artifact of the trailing period's actuals as recorded by the
 * seller's accounting) understates the issuer's risk view.
 *
 * Each non-null slot contributes a candidate computed independently from
 * that slot's vacancyLoss / GPR. SellerUW summary (the 3-field SellerUWExtraction
 * triplet) is intentionally NOT in this cascade — it's a separate document
 * type now distinct from the CF's GS U/W column; if a CF carries no GS U/W
 * column the deriveSellerUwTriplet path produces null and the summary
 * triplet is generally unavailable too. The summary's underwrittenVacancy
 * was historically the SellerUW fallback for this cascade but is now
 * superseded by reading sellerUwOperatingStatement directly (more
 * consistent provenance).
 */
export function vacancyPctCascade(extraction: ExtractionResult): readonly SourceCandidate[] {
  const cs: SourceCandidate[] = [];

  if (extraction.t12Actual !== null) {
    cs.push({ tier: 'T12_ACTUAL', value: vacancyPctFromStatement(extraction.t12Actual) });
  }
  if (extraction.sellerUwOperatingStatement !== null) {
    cs.push({ tier: 'SELLER_UW', value: vacancyPctFromStatement(extraction.sellerUwOperatingStatement) });
  }
  if (extraction.inPlace !== null) {
    cs.push({ tier: 'IN_PLACE', value: vacancyPctFromStatement(extraction.inPlace) });
  }
  // SellerUW summary triplet — last-resort fallback for back-compat with
  // existing tests that synthesize sellerUw without a sellerUwOperatingStatement.
  if (
    extraction.sellerUwOperatingStatement === null &&
    extraction.sellerUw !== null
  ) {
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
 * Bank NOI for the §6 NOI ceiling.
 *
 * Class-(a) cascade (locked 2026-05-31): T12_ACTUAL → SELLER_UW → IN_PLACE.
 * The NOI ceiling tracks the issuer's representation (GS U/W) ahead of
 * In-Place because the issuer's UW column carries the issuer's adjustments
 * (e.g., Prop 13 taxes) that materially shift NOI; In-Place is a fallback
 * when the issuer's UW column is also absent.
 */
export function bankNoiCascade(
  extraction: ExtractionResult,
  signedLease?: { readonly rentRoll: RentRoll | null; readonly expenseRatio: number | null } | null,
): readonly SourceCandidate[] {
  const cs: SourceCandidate[] = [];
  // Signed-lease (PRELEASED) credit — ranked ABOVE T12_ACTUAL. When a rent roll
  // carrying PRELEASED-in-window leases is supplied, credit their contractual
  // rent (net of opex) over the trailing T-12: a SIGNED lease is proven income
  // the trailing window predates. Inert (no tier pushed) when no rent roll / no
  // expense ratio / no real T-12 base / no PRELEASED leases → the cascade falls
  // through to T12_ACTUAL exactly as before (no regression on other deals).
  if (
    signedLease?.rentRoll != null &&
    signedLease.expenseRatio != null &&
    extraction.t12Actual?.noi != null
  ) {
    const credit = computeSignedLeaseCreditedNoi({
      rentRoll: signedLease.rentRoll,
      t12Noi: extraction.t12Actual.noi,
      expenseRatio: signedLease.expenseRatio,
      asOfDate: signedLease.rentRoll.asOfDate,
    });
    if (credit.creditedTenants.length > 0) {
      cs.push({ tier: 'T12_PRELEASED', value: credit.noi });
    }
  }
  if (extraction.t12Actual !== null) {
    cs.push({ tier: 'T12_ACTUAL', value: extraction.t12Actual.noi });
  }
  if (extraction.sellerUwOperatingStatement !== null) {
    cs.push({ tier: 'SELLER_UW', value: extraction.sellerUwOperatingStatement.noi });
  }
  if (extraction.inPlace !== null) {
    cs.push({ tier: 'IN_PLACE', value: extraction.inPlace.noi });
  }
  // SellerUW summary triplet last-resort fallback (back-compat with tests
  // that synthesize sellerUw without sellerUwOperatingStatement).
  if (
    extraction.sellerUwOperatingStatement === null &&
    extraction.sellerUw !== null
  ) {
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
