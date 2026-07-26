/**
 * HumanSponsorAssessment — the SANCTIONED human→score bridge for dimension 9
 * (sponsor-borrower-quality).
 *
 * THE INVARIANT (load-bearing): a due-diligence FINDING never reaches the score
 * directly. The ONLY way sponsor signal moves dim-9 is a HUMAN entering an
 * explicit assessment. This type IS that human judgment — provenance is LOCKED
 * to the literal `'human'`, so no derived/web value can occupy this slot. A DD
 * finding (`ExternalFinding`) is a different type with no construction path into
 * this one; the reviewer reads the finding as CONTEXT and enters each factor
 * THEMSELVES. Auto-population is absent by construction — there is no code (and
 * no type-legal expression) that maps a finding to these factors.
 *
 * The five factors mirror the doctrine's `SponsorAssessment` scoring input
 * (apps/api/src/doctrine-clean/dimensions/sponsor-borrower-quality.ts) — kept
 * here (contracts cannot import from apps/api) so this record carries BOTH the
 * scoring input AND the provenance (who / when / optional note). The scorer
 * extracts the five factors; the memo renders who entered it and when.
 *
 * Carried on `AdjustedInputs.sponsorAssessment` so that entering one is a NEW
 * SCORED HEAD, not a silent mutation: a new assessment → new AdjustedInputs
 * content-hash → new AdjustedInputsId → new RevisionId → new head, traceable to
 * who/when. Absent (the corpus default) → dim-9 stays HITL/inert.
 */

import type { ISODateTime } from './versioning.js';

/**
 * Per-factor rating. Symmetric factors (experience / financial-strength /
 * alignment / management) span the full range; factor 4 (prior credit events)
 * is asymmetric-upward in the scorer — `Severe` alone floors the modifier at
 * the +0.20 risk bound (a clean record cannot offset a disqualifying event).
 */
export type SponsorFactorRating = 'Strong' | 'Neutral' | 'Weak' | 'Severe';

export const SPONSOR_FACTOR_RATINGS: readonly SponsorFactorRating[] = [
  'Strong', 'Neutral', 'Weak', 'Severe',
] as const;

/**
 * A human-entered, provenance-tagged sponsor assessment. Immutable once entered;
 * a change is a NEW record on a NEW head (new AdjustedInputs id), never an edit.
 */
export interface HumanSponsorAssessment {
  /** (1) Experience and track record. Symmetric. */
  readonly experience: SponsorFactorRating;
  /** (2) Financial strength (net worth + liquidity vs loan + contingent liabs). Symmetric. */
  readonly financialStrength: SponsorFactorRating;
  /** (3) Alignment / skin-in-the-game (real cash equity vs financed). Symmetric. */
  readonly alignment: SponsorFactorRating;
  /** (4) PRIOR CREDIT EVENTS — asymmetric upward. `Severe` reaches the bound alone. */
  readonly priorCreditEvents: SponsorFactorRating;
  /** (5) Management quality. Symmetric. */
  readonly managementQuality: SponsorFactorRating;

  /** WHO entered it — the authenticated reviewer (email / user id). */
  readonly enteredBy: string;
  /** WHEN — the reviewer's submission timestamp (frozen into the head; deterministic). */
  readonly enteredAt: ISODateTime;
  /** Optional reviewer note, e.g. "entered after reviewing external-DD finding X". */
  readonly note?: string;
  /**
   * Provenance, LOCKED to `'human'`. This is the air-gap in the type system:
   * the slot can only ever hold a human judgment — never a derived or web value.
   */
  readonly provenance: 'human';
}

/** True iff `v` is a valid factor rating (route/shape validation). */
export function isSponsorFactorRating(v: unknown): v is SponsorFactorRating {
  return typeof v === 'string' && (SPONSOR_FACTOR_RATINGS as readonly string[]).includes(v);
}
