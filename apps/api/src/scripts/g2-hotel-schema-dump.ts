/**
 * G2 proof — per-asset-class Property Detail schema-address dump (v25).
 * Prints EVERY Property Detail address (with sources) for all 8 asset classes,
 * so a diff between the HEAD worktree (pre-G2) and the working tree (post-G2)
 * proves the sole changed hash is hotel-only and every non-hotel class is
 * byte-identical. In-memory only; touches no db.
 *
 * Run twice (HEAD worktree, then working tree) and `diff` the outputs.
 */
import { getSchemaSourcesByAddress } from '../services/render-schema.js';

type AC =
  | 'office' | 'multifamily' | 'self_storage' | 'manufactured_housing'
  | 'hotel' | 'retail' | 'industrial' | 'mixed_use';

const cases: Array<[AC, string]> = [
  ['office', 'office_core'],
  ['retail', 'retail_core'],
  ['industrial', 'ind_core'],
  ['mixed_use', 'mixed_use_core'],
  ['multifamily', 'mf_core'],
  ['self_storage', 'self_storage_core'],
  ['manufactured_housing', 'manufactured_housing_core'],
  ['hotel', 'hotel_core'],
];

for (const [ac, variant] of cases) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = getSchemaSourcesByAddress(ac as any, variant as any, 'single_loan' as any, 25);
  const pd = [...m.keys()].filter((a) => a.startsWith('Property Detail')).sort();
  console.log(`### ${ac}/${variant} (v25) Property Detail addresses (${pd.length}):`);
  for (const a of pd) {
    const src = [...(m.get(a) ?? [])].join(',');
    console.log(`   ${a}   [${src}]`);
  }
}
