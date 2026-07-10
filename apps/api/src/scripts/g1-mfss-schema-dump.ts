/**
 * G1 proof — per-asset-class Property Detail schema-address dump (v25).
 * Shows MF SS MHP slots bound (non-orphaned) and Comm/Office/Hotel untouched.
 * In-memory only; touches no db.
 */
import { getSchemaSourcesByAddress } from '../services/render-schema.js';

type AC =
  | 'office' | 'multifamily' | 'self_storage' | 'manufactured_housing'
  | 'hotel' | 'retail' | 'industrial' | 'mixed_use';

const cases: Array<[AC, string]> = [
  ['office', 'office_core'],
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
