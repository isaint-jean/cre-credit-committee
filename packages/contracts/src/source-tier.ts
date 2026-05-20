/**
 * Source tier — provenance label for adjusted line items and cross-check findings.
 *
 * The tier ordering is the conservatism preference: ACTUAL evidence outranks SELLER materials,
 * which outrank ASR, which outranks MANUAL. The judgment engine is the only producer that picks
 * a tier; downstream consumers (cross-check, doctrine §1 distrust penalties) read it.
 */

export const SOURCE_TIERS = [
  'BANK',
  'T12_ACTUAL',
  'RENT_ROLL',
  'APPRAISAL',
  'PCA',
  'UW',
  'SELLER_UW',
  'ASR',
  'MANUAL',
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];
