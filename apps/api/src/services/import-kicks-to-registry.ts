/**
 * Master Kick List → kicks_registry connector.
 *
 * Reads the JSON form of the Master Kick List sheet
 * (apps/api/.data/kicks-master-list.json, produced by extract-kicks-xlsx.ts),
 * normalizes each row through projectKickToRegistry, and bulk-inserts the
 * survivors via KicksRegistryStore.insertMany.
 *
 * Per CRE Credit Handbook §III, the kicks corpus is required institutional
 * memory. Today's scope is data plumbing only — the judgment engine does NOT
 * yet consult kicks_registry at analysis time. That integration depends on
 * the handbook framework (#31) and is filed separately.
 *
 * Replace-all semantics (#29 lesson): deleteAll() before insertMany() so
 * removed source rows actually leave the table.
 */

import { createHash } from 'node:crypto';
import type { AssetType, Kick } from '@cre/contracts';
import type { KicksRegistryStore } from '../storage/kicks-registry-store.js';
import { canonicalize } from '../util/canonical-json.js';

// ---------------------------------------------------------------------------
// Source row shape — what extract-kicks-xlsx.ts writes to JSON.
// Every value is either a string (the cell's displayed text) or null.
// ---------------------------------------------------------------------------

export interface KickSourceRow {
  readonly [column: string]: string | null;
}

// ---------------------------------------------------------------------------
// Asset-type mapping
// ---------------------------------------------------------------------------

/** Source "Normalized EF Property Type" → canonical PascalCase AssetType.
 *  "Various" and any blank/unknown value maps to null → row is skipped.
 *  "Parking" is rare (1 row in current source) and rolls up to "Other". */
const ASSET_TYPE_MAP: Readonly<Record<string, AssetType>> = {
  Hotel: 'Hotel',
  Multifamily: 'Multifamily',
  Industrial: 'Industrial',
  Retail: 'Retail',
  Office: 'Office',
  MHC: 'MHC',
  'Mixed Use': 'MixedUse',
  'Self Storage': 'SelfStorage',
  Other: 'Other',
  Parking: 'Other',
};

// ---------------------------------------------------------------------------
// Cleaning helpers
// ---------------------------------------------------------------------------

/** Trim + treat blank/whitespace-only as null. */
export function trimOrNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/** Trim + treat null/blank/"-" as null; otherwise preserve verbatim. Used for
 *  the ZF Comments column where "-" is a placeholder, not real content. */
export function trimCommentOrNull(v: string | null | undefined): string | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  return t === '-' ? null : t;
}

const NUMERIC_PLACEHOLDERS = new Set(['NAP', 'TBD', 'N/A', 'Various', '-', '#N/A']);

/** Parse a percent string like "65.0%" → 0.65 (decimal fraction). Returns null
 *  on placeholders (NAP/TBD/Various/-/N/A) or unparseable input. */
export function parsePercent(v: string | null | undefined): number | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (NUMERIC_PLACEHOLDERS.has(t)) return null;
  // Strip trailing % and commas/whitespace.
  const stripped = t.replace(/%$/, '').replace(/,/g, '').trim();
  if (stripped === '') return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** Parse a dollar string like "$27,000,000" → 27000000. Returns null on
 *  placeholders/unparseable input. Keeps real "$0" as 0 (zero-balance is
 *  semantically ambiguous in source; let downstream decide). */
export function parseDollars(v: string | null | undefined): number | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (NUMERIC_PLACEHOLDERS.has(t)) return null;
  // Strip leading $, commas, whitespace; tolerate "$0" specifically.
  const stripped = t.replace(/^\$/, '').replace(/,/g, '').trim();
  if (stripped === '') return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Parse a DSCR string like "1.51x" → 1.51. Source data: 1,327 of 1,327 DSCRs
 *  end with "x" (verified). Tolerate non-suffixed inputs too for safety. */
export function parseDscr(v: string | null | undefined): number | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (NUMERIC_PLACEHOLDERS.has(t)) return null;
  const stripped = t.replace(/x$/i, '').trim();
  if (stripped === '') return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Parse a units count like " 414,191 " → 414191. Returns null on placeholders
 *  or unparseable. */
export function parseUnits(v: string | null | undefined): number | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (NUMERIC_PLACEHOLDERS.has(t)) return null;
  const stripped = t.replace(/,/g, '').trim();
  if (stripped === '') return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Parse a year string ("1974") → 1974. Returns null on multi-year strings
 *  like "1999, 2001, 2002, & 2005", "TBD", "Various", "N/A", or out-of-range
 *  values (sane bounds: [1850, 2100]). */
export function parseYear(v: string | null | undefined): number | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (!/^\d{4}$/.test(t)) return null;
  const n = Number(t);
  if (n < 1850 || n > 2100) return null;
  return n;
}

/** Normalize the "Single Tenant (Yes/No)" column → 0 | 1 | null. Source has
 *  13 distinct strings; rules: YES/Y → 1, NO/N → 0, anything else (NAP, TBD,
 *  N/A, Various, "0", blank) → null. */
export function normalizeSingleTenant(v: string | null | undefined): 0 | 1 | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  const upper = t.toUpperCase();
  if (upper === 'YES' || upper === 'Y') return 1;
  if (upper === 'NO' || upper === 'N') return 0;
  return null;
}

/** Normalize Loan Purpose: typo correction + drop placeholders. */
export function normalizeLoanPurpose(v: string | null | undefined): string | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (t === '0' || t === 'TBD' || t === 'No') return null;
  // Source contains one occurrence of "Recapitilization" (misspelled).
  if (t === 'Recapitilization') return 'Recapitalization';
  return t;
}

/** Normalize Sponsor: drop "0", "TBD", whitespace-only placeholders. No
 *  further normalization (601 distinct names; dedup is a future ticket). */
export function normalizeSponsor(v: string | null | undefined): string | null {
  const t = trimOrNull(v);
  if (t === null) return null;
  if (t === '0' || t === 'TBD') return null;
  return t;
}

// ---------------------------------------------------------------------------
// Content-hash id
// ---------------------------------------------------------------------------

/** 16-char SHA-256 prefix over the canonical-JSON of the kick's identity fields.
 *  Naturally idempotent: same row content → same id. Collision probability is
 *  negligible at ~1,500 rows. */
export function computeKickId(input: {
  readonly assetType: AssetType;
  readonly source8fControl: string | null;
  readonly propertyName: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly deal: string | null;
  readonly vintage: number | null;
}): string {
  const canonical = canonicalize(input);
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return hex.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type KickSkipReason =
  | 'spacer_row'             // blank Normalized EF Property Type — visual divider
  | 'asset_type_unmappable'; // "Various" or anything else not in ASSET_TYPE_MAP

export type ProjectKickResult =
  | { readonly kind: 'ok'; readonly kick: Kick }
  | { readonly kind: 'skip'; readonly reason: KickSkipReason };

/**
 * Per-row projection. Cleaning rules per the #34 design report. The only
 * skip reasons are asset-type-related: spacer rows (blank PT) and unmappable
 * asset types ("Various" / blank-after-trim). Numeric placeholders ("NAP"
 * etc.) become typed null — they don't reject the row.
 */
export function projectKickToRegistry(
  row: KickSourceRow,
  importedAt: string,
): ProjectKickResult {
  // Spacer-row filter: the source has 861 fully-blank rows that serve as
  // visual dividers in the spreadsheet. Detect via blank Normalized EF
  // Property Type — the column the asset_type mapping depends on anyway.
  const ptRaw = trimOrNull(row['Normalized EF Property Type']);
  if (ptRaw === null) return { kind: 'skip', reason: 'spacer_row' };

  const assetType = ASSET_TYPE_MAP[ptRaw];
  if (assetType === undefined) return { kind: 'skip', reason: 'asset_type_unmappable' };

  const source8fControl = trimOrNull(row['8F Control']);
  const propertyName = trimOrNull(row['Property Name']);
  const address = trimOrNull(row['Address']);
  const city = trimOrNull(row['City']);
  const state = trimOrNull(row['State']);
  const deal = trimOrNull(row['Deal']);
  const vintage = parseYear(row['Vintage']);

  const id = computeKickId({
    assetType,
    source8fControl,
    propertyName,
    address,
    city,
    state,
    deal,
    vintage,
  });

  return {
    kind: 'ok',
    kick: {
      id,
      assetType,
      source8fControl,
      deal,
      seller: trimOrNull(row['Seller']),
      vintage,
      propertyName,
      address,
      city,
      state,
      msa: trimOrNull(row['MSA']),
      propertySubType: trimOrNull(row['Property Sub-Type']),
      propertyFlag: trimOrNull(row['Property Flag']),
      yearBuilt: parseYear(row['Year Built']),
      yearRenovated: parseYear(row['Year Renovated']),
      units: parseUnits(row['Units']),
      cutOffBalanceDollars: parseDollars(row['Cut-Off Property Balance']),
      impliedDebtDollars: parseDollars(row['Implied Total Debt at Cut Off based on LTV']),
      debtPerUnitDollars: parseDollars(row['Current Debt per Unit']),
      ltvAtCutoff: parsePercent(row['LTV at Cut-off']),
      ltvAtMaturity: parsePercent(row['LTV at Maturity']),
      debtYield: parsePercent(row['U/W NOI Debt Yield']),
      dscr: parseDscr(row['UW NCF DSCR']),
      occupancyPct: parsePercent(row['Most Recent Occ']),
      amortizationType: trimOrNull(row['Amortization Type']),
      sponsor: normalizeSponsor(row['Sponsor']),
      singleTenant: normalizeSingleTenant(row['Single Tenant (Yes/No)']),
      loanPurpose: normalizeLoanPurpose(row['Loan Purpose']),
      zfComments: trimCommentOrNull(row['ZF Comments']),
      zfUwReviewComment: trimCommentOrNull(row['ZF UW Review Comment']),
      uwReceivedRaw: trimOrNull(row['UW Received']),
      asrReceivedRaw: trimOrNull(row['ASR Received']),
      rawRowJson: JSON.stringify(row),
      importedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Bulk import + ImportReport
// ---------------------------------------------------------------------------

export interface ImportReport {
  readonly totalSeen: number;
  readonly imported: number;
  readonly skipped: { readonly [R in KickSkipReason]: number };
  readonly importedByAssetType: Readonly<Record<AssetType, number>>;
  readonly importedByState: Readonly<Record<string, number>>;
}

/**
 * Bulk import. Iterates source rows, projects each, tallies skip reasons, and
 * writes survivors via store.insertMany. Replace-all semantics: deleteAll()
 * runs first so removed source rows leave the table (same fix as #29 for
 * approved_deals — INSERT OR REPLACE alone is only idempotent under
 * non-shrinking inputs).
 */
export function importKicksToRegistry(
  rows: Iterable<KickSourceRow>,
  store: KicksRegistryStore,
  importedAt: string = new Date().toISOString(),
): ImportReport {
  const survivors: Kick[] = [];
  const skipped: { [R in KickSkipReason]: number } = {
    spacer_row: 0,
    asset_type_unmappable: 0,
  };
  const byAt: Record<AssetType, number> = {
    Office: 0, Retail: 0, Multifamily: 0, Hotel: 0, Industrial: 0,
    SelfStorage: 0, MHC: 0, MixedUse: 0, Other: 0,
  };
  const byState: Record<string, number> = {};
  let totalSeen = 0;
  for (const row of rows) {
    totalSeen += 1;
    const r = projectKickToRegistry(row, importedAt);
    if (r.kind === 'skip') {
      skipped[r.reason] += 1;
      continue;
    }
    survivors.push(r.kick);
    byAt[r.kick.assetType] += 1;
    const stateKey = r.kick.state ?? '__null__';
    byState[stateKey] = (byState[stateKey] ?? 0) + 1;
  }
  store.deleteAll();
  store.insertMany(survivors);
  return {
    totalSeen,
    imported: survivors.length,
    skipped,
    importedByAssetType: byAt,
    importedByState: byState,
  };
}
