/**
 * Tests for asset-profiler.service.ts. Pure function; no persistence.
 *
 *   npm run test:asset-profiler
 */

import type { AssetType, MarketLiquidity, NarrativeFacts } from '@cre/contracts';
import { classifyAssetProfile } from '../services/asset-profiler.service.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

function nf(current: number | null, trailing: number | null): Pick<NarrativeFacts, 'occupancyCurrent' | 'trailingOccAvg'> {
  return { occupancyCurrent: current, trailingOccAvg: trailing };
}

function profile(args: {
  propertyType: AssetType;
  current: number | null;
  trailing: number | null;
  liquidity?: MarketLiquidity;
}) {
  return classifyAssetProfile({
    propertyType: args.propertyType,
    narrativeFacts: nf(args.current, args.trailing),
    ...(args.liquidity !== undefined ? { marketLiquidityHint: args.liquidity } : {}),
  });
}

console.log('Business plan classification:');
{
  // Both below 0.85 → transitional
  const p = profile({ propertyType: 'Office', current: 0.70, trailing: 0.72 });
  assertEqual(p.businessPlan, 'LeaseUp_or_Transitional', 'occ 0.70/0.72 → LeaseUp_or_Transitional');
}
{
  // Both at/above 0.85 → stabilized
  const p = profile({ propertyType: 'Office', current: 0.95, trailing: 0.92 });
  assertEqual(p.businessPlan, 'Stabilized', 'occ 0.95/0.92 → Stabilized');
}
{
  // Edge: exactly 0.85 → not strictly less than → Stabilized
  const p = profile({ propertyType: 'Office', current: 0.85, trailing: 0.85 });
  assertEqual(p.businessPlan, 'Stabilized', 'occ 0.85/0.85 → Stabilized (boundary, exclusive)');
}
{
  // One below, one above → Stabilized (default per YAML catch-all)
  const p = profile({ propertyType: 'Office', current: 0.70, trailing: 0.95 });
  assertEqual(p.businessPlan, 'Stabilized', 'mixed (0.70 current, 0.95 trailing) → Stabilized');
}
{
  // Trailing below, current above → Stabilized
  const p = profile({ propertyType: 'Office', current: 0.92, trailing: 0.70 });
  assertEqual(p.businessPlan, 'Stabilized', 'mixed (0.92 current, 0.70 trailing) → Stabilized');
}

console.log('\nNull handling:');
{
  const p = profile({ propertyType: 'Office', current: null, trailing: null });
  assertEqual(p.businessPlan, 'Stabilized', 'both null → Stabilized default (no false LeaseUp claim)');
}
{
  const p = profile({ propertyType: 'Office', current: null, trailing: 0.70 });
  assertEqual(p.businessPlan, 'Stabilized', 'one null → Stabilized default (insufficient evidence)');
}

console.log('\nProperty type pass-through:');
{
  const types: AssetType[] = ['Office', 'Retail', 'Multifamily', 'Hotel', 'Industrial', 'SelfStorage', 'MHC', 'MixedUse', 'Other'];
  for (const t of types) {
    const p = profile({ propertyType: t, current: 0.95, trailing: 0.92 });
    assertEqual(p.propertyType, t, `propertyType='${t}' passes through`);
  }
}

console.log('\nMarket liquidity:');
{
  const noHint = profile({ propertyType: 'Office', current: 0.95, trailing: 0.92 });
  assertEqual(noHint.marketLiquidity, 'Unknown', 'no hint → Unknown');

  const primary = profile({ propertyType: 'Office', current: 0.95, trailing: 0.92, liquidity: 'Primary' });
  assertEqual(primary.marketLiquidity, 'Primary', 'Primary hint preserved');

  const tertiary = profile({ propertyType: 'Office', current: 0.95, trailing: 0.92, liquidity: 'Tertiary' });
  assertEqual(tertiary.marketLiquidity, 'Tertiary', 'Tertiary hint preserved');
}

console.log('\nIdempotency:');
{
  const a = profile({ propertyType: 'Multifamily', current: 0.85, trailing: 0.83, liquidity: 'Secondary' });
  const b = profile({ propertyType: 'Multifamily', current: 0.85, trailing: 0.83, liquidity: 'Secondary' });
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'same inputs → identical output');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
