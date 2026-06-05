/**
 * Metro → market-liquidity tier lookup (cap-rate stress doctrine v1).
 *
 * Maps a (city, state) pair to a `MarketLiquidity` tier — `Primary` (gateway),
 * `Secondary`, or `Tertiary`. Seed table comes from the cap-stress implementation
 * brief (commit 2 site), encoded verbatim. Debatable classifications (San Diego,
 * Stamford, Greenwich, Detroit's Woodward corridor) are preserved as classified by
 * the brief — override via explicit `marketLiquidityHint` when the deck disagrees.
 *
 * Used as the second link in the build-and-ingest hint chain:
 *
 *   marketLiquidity = body.marketLiquidityHint                                  // explicit override
 *                   ?? cityStateToMarketLiquidity(pm?.city, pm?.state)          // metro lookup
 *                   ?? 'Unknown'                                                // profiler default
 *
 * Unmatched cities, or any null/empty input, return `'Unknown'`. No state-level
 * fallback — a state mixes tiers (e.g., California spans Primary through
 * Secondary). Calibration of the tier deltas is in commit 3.
 */

import type { MarketLiquidity } from '@cre/contracts';

/** Normalize a city for table lookup: trim, collapse whitespace, lowercase, drop
 *  periods (so "St. Louis" / "St Louis" / "ST.  LOUIS " all collapse to the same
 *  key). Returns null on empty/whitespace input. */
function normalizeCity(city: string | null | undefined): string | null {
  if (city === null || city === undefined) return null;
  const cleaned = city.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return cleaned.length === 0 ? null : cleaned;
}

/** Normalize a 2-letter state code: trim + uppercase. Returns null on empty. */
function normalizeState(state: string | null | undefined): string | null {
  if (state === null || state === undefined) return null;
  const cleaned = state.trim().toUpperCase();
  return cleaned.length === 0 ? null : cleaned;
}

function key(city: string, state: string): string {
  return `${city}|${state}`;
}

/** Seed table — verbatim from cap-stress-implementation-brief-v1.md.
 *  Keys are constructed via `key(normalizeCity(x), normalizeState(y))` so the
 *  table and lookup share identical normalization. */
const TIER_TABLE: ReadonlyMap<string, MarketLiquidity> = new Map<string, MarketLiquidity>([
  // ---- Primary / gateway ----
  // NYC aliases per the brief's "common NYC aliases" call-out.
  [key('new york', 'NY'), 'Primary'],
  [key('manhattan', 'NY'), 'Primary'],
  [key('new york city', 'NY'), 'Primary'],
  [key('boston', 'MA'), 'Primary'],
  [key('cambridge', 'MA'), 'Primary'],
  [key('washington', 'DC'), 'Primary'],
  [key('san francisco', 'CA'), 'Primary'],
  [key('los angeles', 'CA'), 'Primary'],
  [key('chicago', 'IL'), 'Primary'],
  [key('seattle', 'WA'), 'Primary'],
  [key('san jose', 'CA'), 'Primary'],
  [key('santa clara', 'CA'), 'Primary'],
  [key('sunnyvale', 'CA'), 'Primary'],
  [key('mountain view', 'CA'), 'Primary'],
  [key('palo alto', 'CA'), 'Primary'],

  // ---- Secondary ----
  // Debatable per brief: San Diego (strong-secondary, not gateway); Stamford,
  // Greenwich (NYC-adjacent). Classified as Secondary per the brief.
  [key('san diego', 'CA'), 'Secondary'],
  [key('oakland', 'CA'), 'Secondary'],
  [key('pleasanton', 'CA'), 'Secondary'],
  [key('sacramento', 'CA'), 'Secondary'],
  [key('long beach', 'CA'), 'Secondary'],
  [key('santa barbara', 'CA'), 'Secondary'],
  [key('thousand oaks', 'CA'), 'Secondary'],
  [key('petaluma', 'CA'), 'Secondary'],
  [key('renton', 'WA'), 'Secondary'],
  [key('bellevue', 'WA'), 'Secondary'],
  [key('denver', 'CO'), 'Secondary'],
  [key('dallas', 'TX'), 'Secondary'],
  [key('houston', 'TX'), 'Secondary'],
  [key('the woodlands', 'TX'), 'Secondary'],
  [key('austin', 'TX'), 'Secondary'],
  [key('atlanta', 'GA'), 'Secondary'],
  [key('phoenix', 'AZ'), 'Secondary'],
  [key('miami', 'FL'), 'Secondary'],
  [key('fort lauderdale', 'FL'), 'Secondary'],
  [key('plantation', 'FL'), 'Secondary'],
  [key('doral', 'FL'), 'Secondary'],
  [key('philadelphia', 'PA'), 'Secondary'],
  [key('king of prussia', 'PA'), 'Secondary'],
  [key('pittsburgh', 'PA'), 'Secondary'],
  [key('portland', 'OR'), 'Secondary'],
  [key('charlotte', 'NC'), 'Secondary'],
  [key('raleigh', 'NC'), 'Secondary'],
  [key('minneapolis', 'MN'), 'Secondary'],
  [key('nashville', 'TN'), 'Secondary'],
  [key('salt lake city', 'UT'), 'Secondary'],
  [key('st louis', 'MO'), 'Secondary'], // "St. Louis" normalizes to "st louis"
  [key('stamford', 'CT'), 'Secondary'],
  [key('greenwich', 'CT'), 'Secondary'],
  [key('fredericksburg', 'VA'), 'Secondary'],
  [key('arlington', 'VA'), 'Secondary'],

  // ---- Tertiary ----
  // Debatable per brief: Detroit (incl. Woodward-corridor addresses — large
  // metro, weak office). Classified as Tertiary per the brief.
  [key('detroit', 'MI'), 'Tertiary'],
  [key('jackson', 'MS'), 'Tertiary'],
]);

/**
 * Look up a market-liquidity tier from a (city, state) pair.
 *
 * @returns `'Primary'` | `'Secondary'` | `'Tertiary'` for matched entries.
 *          `'Unknown'` for null/empty inputs or unmatched cities. No state-level
 *          fallback (a state mixes tiers).
 */
export function cityStateToMarketLiquidity(
  city: string | null | undefined,
  state: string | null | undefined,
): MarketLiquidity {
  const c = normalizeCity(city);
  const s = normalizeState(state);
  if (c === null || s === null) return 'Unknown';
  return TIER_TABLE.get(key(c, s)) ?? 'Unknown';
}
