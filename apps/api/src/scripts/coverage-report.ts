// One-off: run computeWorkbookCoverage against an xlsx/xlsm file and print
// a human-readable report. Used for spot-checking against external measurements.
//
//   npx tsx src/scripts/coverage-report.ts <path-to-xlsx>

import * as fs from 'node:fs';
import { computeWorkbookCoverage } from '../services/compute-workbook-coverage.js';

const path = process.argv[2];
if (!path) { console.error('usage: coverage-report.ts <path>'); process.exit(1); }

(async () => {
  const buf = fs.readFileSync(path);
  const cov = await computeWorkbookCoverage(buf);

  // Sort by population rate ascending to match the user's reporting order.
  const sorted = [...cov.tabs].sort((a, b) => a.populationRate - b.populationRate);

  const fmt = (n: number) => (n * 100).toFixed(2) + '%';
  const pad = (s: string, w: number) => s.length >= w ? s : s + ' '.repeat(w - s.length);

  console.log(pad('Sheet Name', 38) + pad('Rate', 9) + pad('Real', 8) + pad('Placeholder', 13) + pad('Empty', 8) + 'Status');
  console.log('-'.repeat(110));
  for (const t of sorted) {
    console.log(
      pad(t.name, 38) +
      pad(fmt(t.populationRate), 9) +
      pad(String(t.realDataCells), 8) +
      pad(String(t.placeholderCells), 13) +
      pad(String(t.emptyCells), 8) +
      t.status,
    );
  }
  console.log('-'.repeat(110));
  console.log('Overall: ' + cov.overall.totalTabs + ' tabs, ' + cov.overall.realDataCells + ' real / ' + cov.overall.totalCells + ' total = ' + fmt(cov.overall.populationRate));
})();
