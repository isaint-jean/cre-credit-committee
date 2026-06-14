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

/**
 * Line-level discriminated union (PR 1 — multifamily honest-shape).
 *
 * `kind: 'tenant'` carries the office/retail/industrial tenant-lease shape.
 * `kind: 'unit'`   carries the multifamily/MHC/student-housing unit shape.
 *
 * Field semantics that are MEANINGLESS for the other variant are absent —
 * `leaseType` (NNN/MG/FSG/...) only on tenant; `concessionsMonthly` /
 * `bedrooms` / `unitType` only on unit. This is the field-means-two-things
 * trap we explicitly refused (uwY1Noi/statedRatioNumerator was the prior
 * teaching case). Honest shape: same name → same semantics.
 *
 * Top-level RentRoll.lines is a heterogeneous array of these — typical
 * rent rolls are homogeneous (all tenant OR all unit) but the contract
 * doesn't enforce homogeneity (mixed-use deals with a ground-floor
 * commercial tenant + residential units above would be tagged
 * per-line). Consumers reading variant-specific fields MUST narrow via
 * `if (line.kind === 'tenant')` — tsc --strict enforces this.
 *
 * Every numeric field is `number | null`; strings are `string | null`.
 * Parsers MUST preserve null when the source has no value. percentOfTotalSF
 * is computed by the producer at hydration time, not stored at parse time
 * — leave null for parsers; producer fills it.
 */

/** Office / retail / industrial line — one tenant lease per row. */
export interface TenantRentRollLine {
  readonly kind: 'tenant';
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

/**
 * Multifamily / MHC / student-housing line — one residential unit per row.
 *
 *   `leaseEndOrMTM: null` means month-to-month (the typical multifamily case).
 *   No `leaseType` — the office NNN/MG/FSG vocabulary is meaningless for
 *   residential leases.
 *   No `recoveriesAnnual`/`newTiPsf`/etc. — these are office-only structural
 *   fields with no residential analog.
 */
export interface UnitRentRollLine {
  readonly kind: 'unit';
  readonly unitId: string;                          // required — multifamily unit identity
  readonly status: TenantStatus;                    // OCCUPIED / VACANT / PRELEASED / HOLDOVER / UNKNOWN
  readonly squareFeet: number | null;               // unit SF
  readonly bedrooms: number | null;                 // mix indicator; null for studios / unknown
  readonly bathrooms: number | null;
  readonly unitType: string | null;                 // e.g. "1BR/1BA", "Studio", "Townhome"
  readonly leaseStart: ISODateTime | null;
  readonly leaseEndOrMTM: ISODateTime | null;       // null === month-to-month (NOT missing data)
  readonly inPlaceRentMonthly: number | null;
  readonly marketRentMonthly: number | null;
  readonly concessionsMonthly: number | null;       // dollars/month equivalent of concession amortized over lease term
  readonly securityDeposit: number | null;
  readonly notes: string | null;
}

/**
 * Discriminated union. Use `if (line.kind === 'tenant')` / `'unit'` to
 * narrow before reading variant-specific fields. tsc --strict will reject
 * any read of a variant-specific field on the bare union.
 */
export type RentRollLine = TenantRentRollLine | UnitRentRollLine;

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
