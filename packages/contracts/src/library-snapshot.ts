/**
 * LibrarySnapshot — stage-2 pinned baselines (immutable, content-addressable).
 *
 * Architecture contract §4: 200+ approved deals → distributions per asset type (median, p25, p75,
 * n). Used in EVERY analysis. If `n < 20` for an asset type, system must fail OR run in flagged
 * "degraded mode" with the degradation surfaced — silent fallback is forbidden. The `null` value
 * for an asset-type entry encodes the degraded state explicitly.
 *
 * The snapshot is immutable. Re-running an analysis tomorrow against the same `LibrarySnapshotId`
 * uses the same baselines; the live `approved_deals` table is never read at score time.
 */

import type { ContentHash, LibrarySnapshotId } from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { AssetType } from './asset.js';

export interface DistributionStats {
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
}

export interface LibrarySnapshotDistribution {
  readonly vacancy: DistributionStats;
  readonly expenseRatio: DistributionStats;
  readonly capRate: DistributionStats;
  readonly dscr: DistributionStats;
  readonly treasury10YAtClose: DistributionStats;
  readonly n: number;
}

export interface LibrarySnapshot {
  readonly id: LibrarySnapshotId;
  readonly asOf: ISODateTime;

  /** Hash of the source `approved_deals` table state at snapshot time. Audit trail. */
  readonly approvedDealsTableHash: ContentHash;

  /**
   * Every `AssetType` is keyed. Value is `null` when `n < 20` for that type — explicit degraded
   * state, not implicit absence. Doctrine reading a `null` distribution MUST emit
   * INSUFFICIENT_DATA, never substitute a default.
   */
  readonly byAssetType: { readonly [K in AssetType]: LibrarySnapshotDistribution | null };
}
