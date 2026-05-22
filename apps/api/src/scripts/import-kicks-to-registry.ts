/**
 * CLI entry: `npm run import-kicks-to-registry` (from apps/api).
 *
 * Reads the extracted Master Kick List JSON at
 * `apps/api/.data/kicks-master-list.json` (produced by extract-kicks-xlsx.ts),
 * projects rows via the cleaning service, and replaces the kicks_registry
 * table contents.
 *
 * Idempotent: re-running produces the same final state. Content-hash ids stay
 * stable across runs; replace-all semantics purge rows that no longer survive
 * projection (e.g., after a cleaning-rule tightening).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { kicksRegistryStore } from '../storage/kicks-registry-store.js';
import {
  importKicksToRegistry,
  type KickSkipReason,
  type KickSourceRow,
} from '../services/import-kicks-to-registry.js';

const __filename = fileURLToPath(import.meta.url);
const INPUT_PATH = path.resolve(path.dirname(__filename), '../../.data/kicks-master-list.json');

const SKIP_REASON_ORDER: readonly KickSkipReason[] = [
  'spacer_row',
  'asset_type_unmappable',
];

function main(): void {
  console.log('Master Kick List → kicks_registry connector\n');

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`);
    console.error('Run extract-kicks-xlsx.ts first to produce the JSON.');
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_PATH, 'utf8');
  const rows = JSON.parse(raw) as KickSourceRow[];
  console.log(`Loaded ${rows.length} source rows from ${path.basename(INPUT_PATH)}`);

  const before = kicksRegistryStore.count();
  console.log(`kicks_registry before: ${before} rows\n`);

  const report = importKicksToRegistry(rows, kicksRegistryStore);

  console.log('Result:');
  console.log(`  total seen:       ${report.totalSeen}`);
  console.log(`  imported:         ${report.imported}`);
  console.log('  skip reasons:');
  for (const reason of SKIP_REASON_ORDER) {
    const n = report.skipped[reason];
    if (n > 0) console.log(`    ${reason}: ${n}`);
  }
  console.log('  imported by AssetType:');
  for (const [at, n] of Object.entries(report.importedByAssetType)) {
    if (n > 0) console.log(`    ${at}: ${n}`);
  }
  console.log('  top 10 states by kick count:');
  const states = Object.entries(report.importedByState)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [s, n] of states) console.log(`    ${s}: ${n}`);

  const after = kicksRegistryStore.count();
  console.log(`\nkicks_registry after:  ${after} rows`);
}

main();
