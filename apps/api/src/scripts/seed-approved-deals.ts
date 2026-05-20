/**
 * One-shot seeder for the `approved_deals` table.
 *
 *   npm run seed:approved-deals          (refuses if table is non-empty)
 *   npm run seed:approved-deals -- --force  (overwrites)
 *
 * Generates 25 deals per AssetType (225 total — above architecture §4's 200+ minimum). Values
 * are deterministic per (assetType, index) so re-runs produce identical data; useful for dev
 * and testing the library-snapshot producer end-to-end without seeding production data.
 *
 * NOT for production use. Production deals are seeded by the credit team via a real ingest
 * pipeline (TBD).
 */

import { ASSET_TYPES, type AssetType } from '@cre/contracts';
import {
  ApprovedDealsStore,
  type ApprovedDeal,
} from '../storage/approved-deals-store.js';

const DEALS_PER_TYPE = 25;
const SEED_AS_OF = '2026-01-01T00:00:00Z';

/* Asset-type-typical baselines (rough industry approximations for dev seeding). */
const BASELINES: { readonly [K in AssetType]: {
  readonly vacancyPct: number;
  readonly expenseRatio: number;
  readonly capRate: number;
  readonly dscr: number;
} } = {
  Office:      { vacancyPct: 0.12, expenseRatio: 0.40, capRate: 0.075, dscr: 1.30 },
  Retail:      { vacancyPct: 0.06, expenseRatio: 0.25, capRate: 0.065, dscr: 1.40 },
  Multifamily: { vacancyPct: 0.05, expenseRatio: 0.40, capRate: 0.055, dscr: 1.30 },
  Hotel:       { vacancyPct: 0.30, expenseRatio: 0.65, capRate: 0.085, dscr: 1.50 },
  Industrial:  { vacancyPct: 0.04, expenseRatio: 0.20, capRate: 0.060, dscr: 1.40 },
  SelfStorage: { vacancyPct: 0.10, expenseRatio: 0.35, capRate: 0.070, dscr: 1.50 },
  MHC:         { vacancyPct: 0.04, expenseRatio: 0.40, capRate: 0.065, dscr: 1.40 },
  MixedUse:    { vacancyPct: 0.08, expenseRatio: 0.32, capRate: 0.068, dscr: 1.35 },
  Other:       { vacancyPct: 0.10, expenseRatio: 0.35, capRate: 0.070, dscr: 1.30 },
};

const TREASURY_BASELINE = 0.0425;

/** Cheap deterministic noise: stable per (assetType, index). */
function noise(assetTypeIdx: number, dealIdx: number, magnitude: number): number {
  const seed = (dealIdx * 7 + assetTypeIdx * 13) % 11;
  return (seed - 5) / 10 * magnitude;        // -0.5..0.5 of magnitude
}

function buildSeed(): readonly ApprovedDeal[] {
  const deals: ApprovedDeal[] = [];
  for (let typeIdx = 0; typeIdx < ASSET_TYPES.length; typeIdx++) {
    const assetType = ASSET_TYPES[typeIdx]!;
    const baseline = BASELINES[assetType];
    for (let i = 0; i < DEALS_PER_TYPE; i++) {
      deals.push({
        id: `seed-${assetType}-${String(i).padStart(3, '0')}`,
        assetType,
        vacancyPct:           clamp(baseline.vacancyPct    + noise(typeIdx, i, 0.04), 0.005, 0.50),
        expenseRatio:         clamp(baseline.expenseRatio  + noise(typeIdx, i, 0.06), 0.10,  0.85),
        capRate:              clamp(baseline.capRate       + noise(typeIdx, i, 0.01), 0.04,  0.12),
        dscr:                 clamp(baseline.dscr          + noise(typeIdx, i, 0.20), 1.00,  2.50),
        treasury10YAtClose:   clamp(TREASURY_BASELINE      + noise(typeIdx, i, 0.005), 0.020, 0.060),
        status: 'approved',
        closedAt: SEED_AS_OF,
      });
    }
  }
  return deals;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/* ----------------------------------- run ----------------------------------- */

const force = process.argv.includes('--force');
const store = new ApprovedDealsStore();

const existing = store.count();
if (existing > 0 && !force) {
  console.error(`approved_deals already has ${existing} rows. Pass --force to overwrite.`);
  store.close();
  process.exit(1);
}

const deals = buildSeed();
store.insertMany(deals);

const approvedCount = store.countByStatus('approved');
console.log(`seeded ${deals.length} deals (${approvedCount} approved); previous count was ${existing}`);

store.close();
process.exit(0);
