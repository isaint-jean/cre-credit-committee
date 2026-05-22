/**
 * Library-snapshot lookup helpers — type-safe access to per-asset-type distribution stats.
 *
 * `LibrarySnapshot.byAssetType[X]` is `LibrarySnapshotDistribution | null` (architecture §4
 * degraded mode for `n < 20`). These helpers surface the null path explicitly so callers
 * route to fallback (MarketBenchmarks) or throw, never silently substitute.
 */

import type {
  AssetType,
  DistributionStats,
  LibrarySnapshot,
  LibrarySnapshotDistribution,
} from '@cre/contracts';

export type LibraryMetric =
  | 'vacancy'
  | 'expenseRatio'
  | 'capRate'
  | 'dscr'
  | 'treasury10YAtClose';

/** Returns the per-asset-type distribution, or `null` if the asset type is in degraded mode. */
export function getLibraryDistribution(
  snapshot: LibrarySnapshot,
  assetType: AssetType,
): LibrarySnapshotDistribution | null {
  return snapshot.byAssetType[assetType];
}

/** Returns the median of a metric for an asset type, or `null` if unavailable.
 *
 *  Two layers of "unavailable":
 *    1. The asset-type distribution itself is null (n<20 / degraded mode).
 *    2. The specific metric's distribution stat is null (e.g., treasury10YAtClose
 *       when imported source deals don't carry a treasury-at-close field —
 *       issue #20 connector work). Per-metric nullability lives on the
 *       LibrarySnapshotDistribution contract type. */
export function getLibraryMedian(
  snapshot: LibrarySnapshot,
  assetType: AssetType,
  metric: LibraryMetric,
): number | null {
  const dist = getLibraryDistribution(snapshot, assetType);
  if (dist === null) return null;
  const stat = dist[metric];
  if (stat === null) return null;
  return stat.median;
}

/** Returns the full {median, p25, p75} stats for a metric, or `null` if unavailable.
 *  Null paths: see getLibraryMedian's docstring. */
export function getLibraryStats(
  snapshot: LibrarySnapshot,
  assetType: AssetType,
  metric: LibraryMetric,
): DistributionStats | null {
  const dist = getLibraryDistribution(snapshot, assetType);
  if (dist === null) return null;
  return dist[metric] ?? null;
}
