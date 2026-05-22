/**
 * One-time extractor: convert the Master Kick List sheet of a Kicks.xlsx file
 * into a JSON array, written to `apps/api/.data/kicks-master-list.json`.
 *
 *   npx tsx src/scripts/extract-kicks-xlsx.ts <path/to/Kicks.xlsx>
 *
 * Why this script exists (vs. parsing xlsx inline in the importer): the .xlsx
 * is 4.3 MB with 5 unused sheets; we don't want it in the repo. The extracted
 * JSON (Master Kick List sheet only) is committed at apps/api/.data/, the
 * importer reads from there. This split lets us iterate cleaning rules in the
 * importer without re-running the slow xlsx parser.
 *
 * Header normalization: the source file's Units column header is literally
 * " Units " (with surrounding whitespace). We trim each header during
 * extraction so downstream lookups can use clean keys.
 */

import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SHEET_NAME = 'Master Kick List';
// fileURLToPath decodes %-encoded characters in the URL (e.g. spaces). Using
// new URL().pathname directly would leave "CRE%20Credit Comittee" in the path,
// creating a literal %-encoded directory.
const __filename = fileURLToPath(import.meta.url);
const OUTPUT_PATH = path.resolve(path.dirname(__filename), '../../.data/kicks-master-list.json');

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npx tsx src/scripts/extract-kicks-xlsx.ts <path/to/Kicks.xlsx>');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Reading ${inputPath} ...`);
  const wb = XLSX.readFile(inputPath, { cellDates: true });
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    console.error(`Sheet '${SHEET_NAME}' not found. Available: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }

  // header:1 keeps the literal header row as row 0 of the array; defval:null
  // means missing cells come through as null instead of undefined. raw:false
  // gives us the cell's displayed/formatted string (matters for "$27,000,000"
  // style values that would otherwise become 27000000 raw numbers + lose the
  // distinction between "missing" and "$0").
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  if (rows.length < 2) {
    console.error(`Sheet '${SHEET_NAME}' has no data rows.`);
    process.exit(1);
  }

  // Trim each header to handle the " Units " case. Strip the trailing
  // unnamed column (the source xlsx has an empty header in column AG).
  const rawHeader = rows[0]!;
  const header: (string | null)[] = rawHeader.map((h) =>
    typeof h === 'string' ? h.trim() : null,
  );

  const dataRows = rows.slice(1);
  const records: Record<string, unknown>[] = dataRows.map((row) => {
    const rec: Record<string, unknown> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (key === null || key === '') continue;
      rec[key] = row[i] ?? null;
    }
    return rec;
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2));
  console.log(`Wrote ${records.length} records to ${OUTPUT_PATH}`);
  const headerKeys = header.filter((h) => h !== null && h !== '');
  console.log(`Columns extracted (${headerKeys.length}):`);
  for (const h of headerKeys) console.log(`  ${h}`);
}

main();
