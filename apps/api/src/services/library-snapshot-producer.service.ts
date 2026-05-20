/**
 * LibrarySnapshot producer (Stage 2).
 *
 * Pins the historical-deal corpus into a content-addressable `LibrarySnapshot`. Reads every
 * approved deal from the `approved_deals` table, computes per-asset-type distributions, hashes
 * the canonical source-table state for audit, and stamps an immutable record.
 *
 * Architecture §4 contract:
 *   - Returns distributions (median, p25, p75, n) — never single point values.
 *   - n < 20 → that asset type's entry is `null` (degraded mode); silent fallback is forbidden.
 *
 * Architecture §3 (single source of truth): downstream stages consume the `LibrarySnapshot`
 * record by id; the live `approved_deals` table is never queried at score time.
 */

import {
  ASSET_TYPES,
  type AssetType,
  type DistributionStats,
  type ISODateTime,
  type LibrarySnapshot,
  type LibrarySnapshotDistribution,
} from '@cre/contracts';
import {
  computeContentHash,
  computeLibrarySnapshotId,
} from '../util/content-hash.js';
import type { ApprovedDealsStore, ApprovedDeal } from '../storage/approved-deals-store.js';

/** Architecture §4: minimum sample size for a distribution to be reportable. Below this, the
 *  asset type's entry is `null` and consumers must surface degraded mode. */
export const MIN_DISTRIBUTION_N = 20 as const;

export function buildLibrarySnapshot(args: {
  readonly asOfDate: ISODateTime;
  readonly store: ApprovedDealsStore;
}): LibrarySnapshot {
  const allApproved = args.store.getAllApproved();

  // Hash source-table state for audit / drift detection. Sort by id (already done by the store)
  // ensures canonical ordering; same content yields same hash.
  const approvedDealsTableHash = computeContentHash(
    allApproved.map(d => ({
      id: d.id,
      assetType: d.assetType,
      vacancyPct: d.vacancyPct,
      expenseRatio: d.expenseRatio,
      capRate: d.capRate,
      treasury10YAtClose: d.treasury10YAtClose,
      dscr: d.dscr,
      status: d.status,
      closedAt: d.closedAt,
    })),
  );

  const byAssetType = computeByAssetType(allApproved);

  const body = {
    asOf: args.asOfDate,
    approvedDealsTableHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

/* --------------------------- distribution math --------------------------- */

function computeByAssetType(
  deals: readonly ApprovedDeal[],
): { readonly [K in AssetType]: LibrarySnapshotDistribution | null } {
  const out = {} as { [K in AssetType]: LibrarySnapshotDistribution | null };
  for (const assetType of ASSET_TYPES) {
    const filtered = deals.filter(d => d.assetType === assetType);
    if (filtered.length < MIN_DISTRIBUTION_N) {
      out[assetType] = null;
      continue;
    }
    out[assetType] = computeDistribution(filtered);
  }
  return out;
}

function computeDistribution(deals: readonly ApprovedDeal[]): LibrarySnapshotDistribution {
  return {
    vacancy:            stats(sortAsc(deals.map(d => d.vacancyPct))),
    expenseRatio:       stats(sortAsc(deals.map(d => d.expenseRatio))),
    capRate:            stats(sortAsc(deals.map(d => d.capRate))),
    dscr:               stats(sortAsc(deals.map(d => d.dscr))),
    treasury10YAtClose: stats(sortAsc(deals.map(d => d.treasury10YAtClose))),
    n: deals.length,
  };
}

function stats(sortedAsc: readonly number[]): DistributionStats {
  return {
    median: percentile(sortedAsc, 50),
    p25: percentile(sortedAsc, 25),
    p75: percentile(sortedAsc, 75),
  };
}

/**
 * Linear-interpolation percentile (the most common convention for financial distributions).
 *
 *   rank = (p / 100) * (n - 1)
 *   if rank is integer: return sorted[rank]
 *   else: linearly interpolate between sorted[floor(rank)] and sorted[ceil(rank)]
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error('percentile: empty input');
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0]!;
  }
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sortedAsc[lower]!;
  }
  const frac = rank - lower;
  return sortedAsc[lower]! * (1 - frac) + sortedAsc[upper]! * frac;
}

function sortAsc(values: readonly number[]): readonly number[] {
  return [...values].sort((a, b) => a - b);
}
