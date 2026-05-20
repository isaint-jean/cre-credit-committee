/**
 * MarketBenchmarks — point-value market context (current rates, prevailing norms).
 *
 * Distinct from `LibrarySnapshot`:
 *   - `LibrarySnapshot`   = distributions over historical approved deals (median, p25, p75, n).
 *                           Used by Stage 4 for assumption-floor logic per architecture §4.
 *   - `MarketBenchmarks`  = point-value reference for current market conditions
 *                           (treasury rates, prevailing cap/vacancy rates, expense PSF norms,
 *                            market-liquidity indices). Used for narrative context and UI
 *                            defaults.
 *
 * The judgment engine MUST prefer `LibrarySnapshot` for floor logic. `MarketBenchmarks` is
 * informational / contextual — never the source of truth for an underwriting assumption.
 */

import type { AssetType } from './asset.js';
import type { MarketBenchmarksId } from './identity.js';
import type { ISODateTime } from './versioning.js';

export interface MarketBenchmarks {
  readonly id: MarketBenchmarksId;
  readonly asOfDate: ISODateTime;

  /** Prevailing cap rate per asset type, as a fraction. `null` if no published rate exists. */
  readonly capRates: { readonly [K in AssetType]: number | null };

  /** Prevailing vacancy rate per asset type, as a fraction. `null` if not available. */
  readonly vacancyRates: { readonly [K in AssetType]: number | null };

  /**
   * Expense PSF benchmarks. `null` for asset classes where PSF is not the typical unit
   * (Multifamily / Hotel / MHC use per-unit / per-key / per-pad).
   */
  readonly expensesPerSqFt: { readonly [K in AssetType]: number | null };

  readonly interestRateAssumptions: {
    /** Current fixed-rate baseline (annualized fraction). */
    readonly baseRate: number;
    /** Stress-tested rate (annualized fraction; typically baseRate + spread). */
    readonly stressRate: number;
  };

  /**
   * Liquidity index per market tier. Convention TBD by producers; recommended unit is a 0–1
   * scalar where higher = more liquid. `null` when no measurement is published for the tier.
   */
  readonly marketLiquidityIndex: {
    readonly primary: number | null;
    readonly secondary: number | null;
    readonly tertiary: number | null;
  };
}
