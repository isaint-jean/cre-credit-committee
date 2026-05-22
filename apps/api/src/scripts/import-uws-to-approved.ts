/**
 * CLI entry: `npm run import-uws-to-approved` (from apps/api).
 *
 * Reads historical-uws.json via the existing uw-intelligence service's load
 * path, projects approved UWs into ApprovedDeal shape, bulk-inserts into the
 * `approved_deals` table. After this completes, the user can navigate to
 * /admin/registry/library-snapshots and click "Build from approved_deals" to
 * regenerate a library snapshot with non-null distributions for the asset
 * types that cleared the n>=20 threshold.
 *
 * Idempotent: re-running over the same historical-uws.json produces the same
 * approved_deals state (INSERT OR REPLACE keyed on UW id). Safe to invoke
 * multiple times — duplicate rows do not accumulate.
 */

import { listHistoricalUWsFull } from '../services/uw-intelligence.service.js';
import { approvedDealsStore } from '../storage/approved-deals-store.js';
import {
  importHistoricalUWsToApprovedDeals,
  type SkipReason,
} from '../services/import-historical-uws-to-approved.js';

const SKIP_REASON_ORDER: readonly SkipReason[] = [
  'outcome_not_approved',
  'unknown_asset_type',
  'null_vacancy',
  'null_capRate',
  'null_dscr',
  'expense_ratio_undefined',
  'vacancy_out_of_bounds',
  'expense_ratio_out_of_bounds',
  'cap_rate_out_of_bounds',
  'dscr_out_of_bounds',
];

function main(): void {
  console.log('UW Library → approved_deals connector\n');

  const before = approvedDealsStore.countByStatus('approved');
  console.log(`approved_deals before: ${before} rows (status=approved)\n`);

  const uws = listHistoricalUWsFull();
  console.log(`Loaded ${uws.length} historical UWs from .data/historical-uws.json\n`);

  const report = importHistoricalUWsToApprovedDeals(uws, approvedDealsStore);

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
    if (n > 0) {
      const flag = n >= 20 ? '  ← clears n>=20 threshold' : '';
      console.log(`    ${at}: ${n}${flag}`);
    }
  }
  const after = approvedDealsStore.countByStatus('approved');
  console.log(`\napproved_deals after:  ${after} rows (status=approved)`);
  console.log('\nNext step: open /admin/registry/library-snapshots → click "Build from approved_deals".');
}

main();
