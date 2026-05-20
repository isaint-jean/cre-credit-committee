// RentRoll contract (Batch 1A — post-Phase 4).
//
// Source-of-truth representation of a property's tenant-level rent roll. Drives
// Year 1 rent-roll-based underwriting per the Batch 1 evidence-gated build rules:
//   - rent-roll-driven Year 1 PGI MUST come from this record
//   - vacancy MAY come from in-place occupancy here, OR from an explicit
//     assumption elsewhere; absence of either → null + missingSupport
//   - reimbursements derive from leaseType per tenant
//
// Source precedence at ingest time (documented; enforced by the producer, not
// this contract):
//   1. Dedicated rent-roll file uploaded via /analyses POST 'rent_roll' slot
//   2. Rent-roll tables extracted from the ASR
//   3. Rent-roll exhibits in the Seller UW
//   none → no RentRoll record produced; downstream Year-1 fields stay null
//
// CRITICAL DISCIPLINE:
//   - This contract is types + branded id only. No producers. No I/O.
//   - Tenant rows are passthrough: parsers MUST NOT invent fields, fill missing
//     values with zeros, or back-solve. Missing → null on the field.
//   - The id is the SHA-256 of the JCS-canonical serialization of the record
//     body (excluding `id` itself). Same rent-roll content -> same id.

import type { RentRollId } from './identity.js';
import type { ISODateTime } from './versioning.js';

export const LEASE_TYPES = [
  'NNN',
  'MG',           // Modified Gross
  'FSG',          // Full Service Gross
  'GROSS',
  'IG',           // Industrial Gross
  'OTHER',
  'UNKNOWN',      // explicit acknowledgment that the lease type is not stated
] as const;
export type LeaseType = (typeof LEASE_TYPES)[number];

export const TENANT_STATUS = [
  'OCCUPIED',
  'VACANT',
  'PRELEASED',
  'HOLDOVER',
  'UNKNOWN',
] as const;
export type TenantStatus = (typeof TENANT_STATUS)[number];

// One tenant / unit row. Every numeric field is `number | null`; strings are
// `string | null`. Parsers MUST preserve null when the source has no value.
// percentOfTotalSF is computed by the producer at hydration time, not stored
// at parse time — leave null for parsers; producer fills it.
export interface RentRollLine {
  readonly tenantName: string | null;
  readonly suite: string | null;                    // unit / suite identifier
  readonly squareFeet: number | null;
  readonly status: TenantStatus;
  readonly leaseStart: ISODateTime | null;
  readonly leaseEnd: ISODateTime | null;
  readonly inPlaceRentAnnual: number | null;        // base rent, annualized $
  readonly marketRentAnnual: number | null;         // market / appraisal rent, annualized $
  readonly leaseType: LeaseType;
  readonly recoveriesAnnual: number | null;         // expense reimbursements
  readonly otherIncomeAnnual: number | null;        // parking, storage, etc.
  readonly newTiPsf: number | null;                 // tenant improvement allowance, $/SF
  readonly renewTiPsf: number | null;
  readonly newLcPct: number | null;                 // leasing commission, fraction
  readonly renewLcPct: number | null;
  readonly downtimeMonths: number | null;
  readonly notes: string | null;
}

// Top-level rent roll. The `lines` array is the truth; aggregate stats
// (tenant count, occupied SF, etc.) are NOT cached on this record because
// they're cheap to compute and storing them risks divergence.
export interface RentRoll {
  readonly id: RentRollId;
  readonly asOfDate: ISODateTime | null;            // rent roll date stamp from source
  readonly propertyName: string | null;             // header field; may be null when source omits it
  readonly source: RentRollSource;                  // provenance for audit
  readonly lines: readonly RentRollLine[];
}

export const RENT_ROLL_SOURCES = ['rent_roll_file', 'asr_table', 'seller_uw_exhibit'] as const;
export type RentRollSource = (typeof RENT_ROLL_SOURCES)[number];
