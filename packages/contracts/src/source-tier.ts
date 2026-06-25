/**
 * Source tier — provenance label for adjusted line items and cross-check findings.
 *
 * The tier ordering is the conservatism preference: ACTUAL evidence outranks SELLER materials,
 * which outrank ASR, which outranks MANUAL. The judgment engine is the only producer that picks
 * a tier; downstream consumers (cross-check, doctrine §1 distrust penalties) read it.
 *
 * IN_PLACE added 2026-05-31 with the period-classification fix. Sits between
 * T12_ACTUAL (strict trailing-twelve actuals — truth floor) and RENT_ROLL
 * (synthesizable from per-tenant in-place rents). Reflects that the seller
 * CF's In-Place column is a current-period snapshot of contractual rents:
 * better than seller's underwriting projection, weaker than a true T-12.
 */

export const SOURCE_TIERS = [
  'BANK',
  // T12 trailing actual PLUS contractual rent of signed-but-not-commenced
  // (PRELEASED) leases, net of opex (signed-lease credit). Outranks the bare
  // T12_ACTUAL in the bank-NOI cascade: a SIGNED lease is proven income the
  // trailing window simply predates. Inert (absent) when no PRELEASED leases.
  'T12_PRELEASED',
  'T12_ACTUAL',
  'IN_PLACE',
  'RENT_ROLL',
  'APPRAISAL',
  'PCA',
  'UW',
  'SELLER_UW',
  'ASR',
  'MANUAL',
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];
