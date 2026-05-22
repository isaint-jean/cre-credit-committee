/**
 * Kick — a single property-level record from the Master Kick List (historical
 * loan rejections / removed deals; Eightfold Real Estate Capital fund 6 era).
 *
 * Per CRE Credit Handbook section III, the kicks corpus is explicit
 * institutional memory: prior rejections in a submarket × asset-type are a
 * required input to new-deal evaluation. This contract defines the shape; the
 * judgment-engine integration (HOW the engine queries kicks at analysis time)
 * is deferred to a future ticket that depends on the handbook framework (#31).
 *
 * Storage layout: typed columns for queryable dimensions
 * (asset_type/state/MSA/sponsor/vintage/financial metrics) + a raw_row_json
 * blob preserving every source field for forensics and future field
 * extraction. Same hybrid pattern as the record-graph store.
 *
 * Identity: content-hash. 8F Control alone is NOT unique (223 duplicates in
 * source data; sub-IDs like "7.01" preserve property-within-deal identity but
 * cannot serve as PK). See the importer for the canonical hash input set.
 *
 * Percent fields are decimal fractions (0.65 not 65) matching ApprovedDeal /
 * historical-uws.json convention so engine code stays unit-consistent.
 */

import type { AssetType } from './asset.js';

export interface Kick {
  /** Content-hash id (16-char SHA-256 prefix over normalized canonical fields). */
  readonly id: string;

  /** Canonical asset type — mapped from the source "Normalized EF Property Type" column. */
  readonly assetType: AssetType;

  /** Raw 8F Control identifier from the source. NOT unique (deal-level grouping + sub-IDs
   *  like "7.01" for properties within a deal). Preserved as string. */
  readonly source8fControl: string | null;

  /** Deal/pool name (e.g. "BANK 2017-BNK5"). */
  readonly deal: string | null;
  readonly seller: string | null;
  readonly vintage: number | null;
  readonly propertyName: string | null;
  readonly address: string | null;
  readonly city: string | null;
  /** Two-letter state code, or "Various" for portfolio-spanning rows. */
  readonly state: string | null;
  readonly msa: string | null;
  /** Free-form sub-type (Garden / CBD / Limited Service / etc.). 101 distinct values in
   *  source; not normalized. */
  readonly propertySubType: string | null;
  /** Property | Loan | PF — the source taxonomy for row granularity. */
  readonly propertyFlag: string | null;
  readonly yearBuilt: number | null;
  readonly yearRenovated: number | null;
  readonly units: number | null;
  readonly cutOffBalanceDollars: number | null;
  readonly impliedDebtDollars: number | null;
  readonly debtPerUnitDollars: number | null;
  readonly ltvAtCutoff: number | null;
  readonly ltvAtMaturity: number | null;
  readonly debtYield: number | null;
  readonly dscr: number | null;
  readonly occupancyPct: number | null;
  readonly amortizationType: string | null;
  readonly sponsor: string | null;
  /** Boolean encoded as 0/1/null. Source has 13 distinct strings; normalized via
   *  Yes/Y → 1, No/N → 0, everything else (NAP/TBD/Various/0) → null. */
  readonly singleTenant: 0 | 1 | null;
  readonly loanPurpose: string | null;
  /** Free-text analyst rejection rationale. The highest-value field — median 398 chars
   *  in the imported corpus; ~59% of kicks carry substantive content. Null when source
   *  cell is empty or just "-". */
  readonly zfComments: string | null;
  readonly zfUwReviewComment: string | null;
  /** Raw source string for "UW Received" — semantically ambiguous (sometimes boolean
   *  "N", sometimes date "5/18/17", sometimes "-"). Not parsed; preserved verbatim. */
  readonly uwReceivedRaw: string | null;
  /** Raw source string for "ASR Received" — usually a date in "m/d/yy" form but
   *  preserved as string for now. */
  readonly asrReceivedRaw: string | null;

  /** Full original row as JSON. Lets us re-derive any column we didn't pick up in the
   *  typed schema without re-running the .xlsx extractor. */
  readonly rawRowJson: string;
  /** ISO 8601 timestamp when this row was imported. */
  readonly importedAt: string;
}
