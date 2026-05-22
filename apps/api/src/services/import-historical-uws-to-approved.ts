/**
 * Import historical underwritings (Phase 3 institutional memory at
 * `apps/api/.data/historical-uws.json`) into the `approved_deals` table — the
 * input source the LibrarySnapshot producer reads from.
 *
 * Surfaced during issue #20 step 8.10: the UW Library tab's data and the
 * `library_snapshots` table were two disconnected systems. This service is the
 * connector. Filtered to `outcome === 'approved'`; nulls in any required input
 * field (vacancy / capRate / dscr) or undefined expense-ratio (rents/expenses
 * missing or zero) → skip with structured reason. Null treasury10YAtClose passes
 * through (the source has no equivalent field).
 *
 * Idempotent: `ApprovedDealsStore.insertMany` uses `INSERT OR REPLACE` keyed by
 * id. We use the HistoricalUnderwriting's UUID as the ApprovedDeal.id; re-running
 * this import on the same source data replaces rows with byte-identical content
 * (and adds new ones if the source has grown).
 */

import type { AssetType, ISODateTime } from '@cre/contracts';
import type {
  ApprovedDeal,
  ApprovedDealsStore,
} from '../storage/approved-deals-store.js';
import type { HistoricalUnderwriting } from '@cre/shared';

/**
 * Lowercase snake_case → PascalCase AssetType. The HistoricalUW JSON file stores
 * asset types in legacy lowercase form despite the TS type claiming AssetType.
 * Unknown raw strings → null (skipped with reason 'unknown_asset_type').
 */
const ASSET_TYPE_MAP: Readonly<Record<string, AssetType>> = {
  office:       'Office',
  retail:       'Retail',
  multifamily:  'Multifamily',
  hotel:        'Hotel',
  industrial:   'Industrial',
  self_storage: 'SelfStorage',
  mhc:          'MHC',
  mixed_use:    'MixedUse',
  other:        'Other',
};

export type SkipReason =
  | 'outcome_not_approved'
  | 'unknown_asset_type'
  | 'null_vacancy'
  | 'null_capRate'
  | 'null_dscr'
  | 'expense_ratio_undefined'
  | 'vacancy_out_of_bounds'
  | 'expense_ratio_out_of_bounds'
  | 'cap_rate_out_of_bounds'
  | 'dscr_out_of_bounds';

/**
 * Sanity bounds for the projection. These filter pathologically-valued records
 * that pass the null check but contain extraction errors (unit-of-measure
 * mismatches, negative artifacts, etc.). Bounds calibrated against the
 * historical-uws.json dataset and CRE-domain reality:
 *
 *   vacancy:      [0, 0.5]        inclusive both sides. Negative is artifact;
 *                                 >50% is extreme.
 *   expenseRatio: (-inf, 1.0]     no lower bound — NNN structures legitimately
 *                                 produce er<0.05 (Tesla, CVS, etc.). >100%
 *                                 means expenses exceed revenue.
 *   capRate:      [0.02, 0.25]    defensive; current data is 3.6-11.75%.
 *   dscr:         (0, 10]         exclusive lower / inclusive upper. >10
 *                                 catches NYC co-op outliers (economically
 *                                 real but statistical aberrations).
 *
 * See #29 for the data analysis. The bounds correctly surface (and filter) a
 * systematic upstream extraction unit-of-measure bug — see #33 for the root-
 * cause work. Until #33 lands, Multifamily drops below the n>=20 threshold.
 */
export const SANITY_BOUNDS = {
  vacancyMin: 0,
  vacancyMax: 0.5,
  expenseRatioMax: 1.0,
  capRateMin: 0.02,
  capRateMax: 0.25,
  dscrMin: 0,        // exclusive (dscr > 0)
  dscrMax: 10,       // inclusive (dscr <= 10)
} as const;

export interface ImportReport {
  readonly totalSeen: number;
  readonly imported: number;
  readonly skipped: { readonly [R in SkipReason]: number };
  readonly importedByAssetType: { readonly [K in AssetType]: number };
}

function normalizeAssetType(raw: unknown): AssetType | null {
  if (typeof raw !== 'string') return null;
  const mapped = ASSET_TYPE_MAP[raw.toLowerCase()];
  return mapped ?? null;
}

/**
 * HistoricalUnderwriting.date is `"YYYY-MM-DD"`; ApprovedDeal.closedAt is
 * ISODateTime. Appending `T00:00:00Z` assumes UTC midnight for closed deals,
 * which is fine for institutional-memory aggregation (the producer's
 * distribution math doesn't read time-of-day). Pre-existing full-ISO inputs
 * pass through unchanged. Empty/malformed dates fall back to epoch so a deal
 * isn't silently dropped on a metadata issue — survival/skip is gated on the
 * input metrics, not on date precision.
 */
function normalizeClosedAt(date: string): ISODateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00Z` as ISODateTime;
  if (/T\d{2}:\d{2}/.test(date)) return date as ISODateTime;
  return '1970-01-01T00:00:00Z' as ISODateTime;
}

/**
 * Projection function. Returns the ApprovedDeal record on success, or a
 * structured skip-reason on failure (so callers can tally a report).
 *
 * Decisions encoded:
 *   1. expenseRatio = expenses / rents (gating: both non-null AND rents > 0)
 *   2. treasury10YAtClose stays null (HistoricalUWInputs has no equivalent field)
 *   3. Skip if ANY required field is null (vacancy / capRate / dscr / both
 *      expense inputs)
 */
export function projectHistoricalUWToApprovedDeal(
  uw: HistoricalUnderwriting,
):
  | { readonly kind: 'ok'; readonly deal: ApprovedDeal }
  | { readonly kind: 'skip'; readonly reason: SkipReason } {
  if (uw.outcome !== 'approved') return { kind: 'skip', reason: 'outcome_not_approved' };
  const assetType = normalizeAssetType(uw.assetType);
  if (assetType === null) return { kind: 'skip', reason: 'unknown_asset_type' };
  const inp = uw.inputs;
  if (inp.vacancy === null) return { kind: 'skip', reason: 'null_vacancy' };
  if (inp.capRate === null) return { kind: 'skip', reason: 'null_capRate' };
  if (inp.dscr === null)    return { kind: 'skip', reason: 'null_dscr' };
  if (inp.expenses === null || inp.rents === null || inp.rents <= 0) {
    return { kind: 'skip', reason: 'expense_ratio_undefined' };
  }

  // Sanity bounds — see SANITY_BOUNDS rationale + #29 / #33.
  const expenseRatio = inp.expenses / inp.rents;
  if (inp.vacancy < SANITY_BOUNDS.vacancyMin || inp.vacancy > SANITY_BOUNDS.vacancyMax) {
    return { kind: 'skip', reason: 'vacancy_out_of_bounds' };
  }
  if (expenseRatio > SANITY_BOUNDS.expenseRatioMax) {
    return { kind: 'skip', reason: 'expense_ratio_out_of_bounds' };
  }
  if (inp.capRate < SANITY_BOUNDS.capRateMin || inp.capRate > SANITY_BOUNDS.capRateMax) {
    return { kind: 'skip', reason: 'cap_rate_out_of_bounds' };
  }
  if (inp.dscr <= SANITY_BOUNDS.dscrMin || inp.dscr > SANITY_BOUNDS.dscrMax) {
    return { kind: 'skip', reason: 'dscr_out_of_bounds' };
  }

  return {
    kind: 'ok',
    deal: {
      id: uw.id,
      assetType,
      vacancyPct: inp.vacancy,
      expenseRatio,
      capRate: inp.capRate,
      treasury10YAtClose: null,    // Decision 2: source has no treasury data
      dscr: inp.dscr,
      status: 'approved',
      closedAt: normalizeClosedAt(uw.date),
    },
  };
}

/**
 * Bulk import. Iterates the provided UWs, projects each, tallies skip reasons,
 * and writes survivors via ApprovedDealsStore.insertMany. Returns a structured
 * report for the CLI wrapper to log.
 *
 * Replace-all semantics: the importer purges the existing approved_deals rows
 * before inserting survivors. INSERT OR REPLACE alone is only idempotent under
 * non-shrinking inputs; the #29 sanity bounds can shrink the survivor set, so
 * stale rows from a previous looser projection must be cleared. Re-running on
 * the same source still produces the same final state.
 */
export function importHistoricalUWsToApprovedDeals(
  uws: Iterable<HistoricalUnderwriting>,
  store: ApprovedDealsStore,
): ImportReport {
  const survivors: ApprovedDeal[] = [];
  const skipped: { [R in SkipReason]: number } = {
    outcome_not_approved: 0,
    unknown_asset_type: 0,
    null_vacancy: 0,
    null_capRate: 0,
    null_dscr: 0,
    expense_ratio_undefined: 0,
    vacancy_out_of_bounds: 0,
    expense_ratio_out_of_bounds: 0,
    cap_rate_out_of_bounds: 0,
    dscr_out_of_bounds: 0,
  };
  const byAt: { [K in AssetType]: number } = {
    Office: 0, Retail: 0, Multifamily: 0, Hotel: 0, Industrial: 0,
    SelfStorage: 0, MHC: 0, MixedUse: 0, Other: 0,
  };
  let totalSeen = 0;
  for (const uw of uws) {
    totalSeen += 1;
    const r = projectHistoricalUWToApprovedDeal(uw);
    if (r.kind === 'skip') { skipped[r.reason] += 1; continue; }
    survivors.push(r.deal);
    byAt[r.deal.assetType] += 1;
  }
  store.deleteAll();
  store.insertMany(survivors);
  return { totalSeen, imported: survivors.length, skipped, importedByAssetType: byAt };
}
