// PropertyMetadata contract (Batch 1H — post-Phase 4).
//
// Property identity + physical specs needed by the BP Spiral template's
// Property & Loan Summary header section and Property Detail tabs. Distinct
// from UnderwritingModel (financial / loan / cash-flow data) — this carries
// purely descriptive property attributes.
//
// All fields are nullable: when the AI extractor cannot find a value in the
// source document, the field stays null. Consumers MUST not coerce null to
// zero or empty string — null means "not extracted", which is information
// the populator surfaces by leaving the corresponding workbook cell blank.
//
// Source: today, ASR text extraction only. Seller UW exhibits may carry
// some of these fields; a future batch can add a precedence chain similar to
// RentRoll (file > ASR > Seller UW).

import type { PropertyMetadataId } from './identity.js';

export const PROPERTY_METADATA_SOURCES = ['asr_extraction', 'seller_uw_exhibit', 'manual_entry'] as const;
export type PropertyMetadataSource = (typeof PROPERTY_METADATA_SOURCES)[number];

export interface PropertyMetadata {
  readonly id: PropertyMetadataId;
  readonly source: PropertyMetadataSource;

  // Identity
  readonly propertyName: string | null;
  readonly propertySubtype: string | null;          // 'Suburban Office', 'Anchored Retail', etc.

  // Address
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;                     // 2-letter (e.g. 'CA')
  readonly zip: string | null;
  readonly county: string | null;
  readonly msa: string | null;                       // Metropolitan Statistical Area
  readonly submarket: string | null;

  // Construction / quality
  readonly yearBuilt: number | null;
  readonly yearRenovated: number | null;
  readonly buildingClass: string | null;             // 'A' / 'B' / 'C' / 'A-' / etc.

  // Size (whichever applies per asset type — populator dispatches via
  // property-type classifier)
  readonly totalSquareFeet: number | null;           // Office, Retail, Industrial, Self-Storage, Mixed-Use
  readonly totalUnits: number | null;                // Multifamily
  readonly totalRooms: number | null;                // Hotel
  readonly totalPads: number | null;                 // Manufactured Housing

  // Occupancy (fractions, e.g. 0.92 = 92%)
  readonly occupancyPhysical: number | null;
  readonly occupancyEconomic: number | null;

  // Ownership / legal
  readonly ownershipInterest: string | null;         // 'Fee Simple', 'Leasehold', etc.
  readonly numberOfBuildings: number | null;
}
