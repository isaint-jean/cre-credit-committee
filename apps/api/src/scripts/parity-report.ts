// Parity-corpus reporter (post-6.8 legacy reduction phase).
//
//   npm run parity:report
//
// Read-only aggregator. Walks apps/api/fixtures/parity/, parses each
// parity-report.md, emits a cross-fixture summary by classification tag.
//
// IMPORTANT: this script does NOT enforce parity. It does not fail on divergence.
// It does not block CI. It is purely observational - the parity corpus catalogs
// divergence; classification of each divergence is the work product, not parity itself.
// See docs/legacy-reduction-plan.md sections 5 and 8.

import * as fs from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const PARITY_DIR = resolve(REPO_ROOT, 'apps/api/fixtures/parity');

const KNOWN_TAGS: ReadonlyArray<string> = [
  'match',
  'intentional-modernization',
  'legacy-bug',
  'missing-render-field',
  'migration-gap',
];

const KNOWN_SUBTAGS: ReadonlyArray<string> = [
  'producer-pending',
  'out-of-spine',
  'deferred-write-side',
];

interface FixtureSummary {
  readonly name: string;
  readonly tagCounts: { [tag: string]: number };
  readonly subtagCounts: { [sub: string]: number };
  readonly unclassifiedFields: readonly string[];
  readonly hasReport: boolean;
  readonly hasExtraction: boolean;
  readonly hasRendered: boolean;
  readonly hasLegacy: boolean;
}

// Parse a parity-report.md file. Loose: looks for backticked tags inside table rows.
// Counts occurrences of each known tag. Sub-tags are detected when present in
// a row's notes column.
function parseReport(reportPath: string): {
  tagCounts: { [tag: string]: number };
  subtagCounts: { [sub: string]: number };
  unclassifiedFields: string[];
} {
  const tagCounts: { [tag: string]: number } = {};
  for (const t of KNOWN_TAGS) tagCounts[t] = 0;
  const subtagCounts: { [sub: string]: number } = {};
  for (const s of KNOWN_SUBTAGS) subtagCounts[s] = 0;
  const unclassified: string[] = [];

  const text = fs.readFileSync(reportPath, 'utf8');
  const lines = text.split('\n');
  let inClassificationsTable = false;

  for (const raw of lines) {
    const line = raw.trim();

    // Detect entry into the Classifications table (markdown table after the
    // "## Classifications" heading). Loose detection: any "| Field |" header.
    if (line.indexOf('| Field |') === 0) {
      inClassificationsTable = true;
      continue;
    }
    // Exit table on a blank line followed by a non-table line, or on a new heading.
    if (inClassificationsTable && (line === '' || line.startsWith('#'))) {
      inClassificationsTable = false;
      continue;
    }
    if (!inClassificationsTable) continue;
    if (line.indexOf('|---') === 0) continue;
    if (line.indexOf('|') !== 0) continue;

    // Each row is `| Field | Legacy | Rendered | Tag | Notes |`. Tag column is
    // index 4 (1-indexed) or 3 (0-indexed when split by '|').
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the leading empty before first |; field is cells[1]; tag is cells[4].
    const field = cells[1];
    const tagCell = cells[4];
    const notes = cells[5] ?? '';

    if (field === undefined || field.length === 0) continue;

    // Strip backticks from the tag cell to extract the tag name.
    const tag = (tagCell ?? '').replace(/`/g, '').trim();

    let matchedTag = false;
    for (const known of KNOWN_TAGS) {
      if (tag === known) {
        tagCounts[known] = (tagCounts[known] ?? 0) + 1;
        matchedTag = true;
        break;
      }
    }
    if (!matchedTag) {
      // Allow a tag of the form `migration-gap (sub: producer-pending)` directly in
      // the tag cell, OR a bare migration-gap with the sub in the notes.
      if (tag.indexOf('migration-gap') >= 0) {
        tagCounts['migration-gap'] = (tagCounts['migration-gap'] ?? 0) + 1;
        matchedTag = true;
      }
    }

    if (matchedTag) {
      // Detect subtag in the same row (tag cell or notes cell).
      const probe = tag + ' ' + notes;
      for (const sub of KNOWN_SUBTAGS) {
        if (probe.indexOf(sub) >= 0) {
          subtagCounts[sub] = (subtagCounts[sub] ?? 0) + 1;
          break;
        }
      }
    } else {
      // Unrecognized tag for a field row - flag it.
      unclassified.push(field);
    }
  }

  return { tagCounts, subtagCounts, unclassifiedFields: unclassified };
}

function summarizeFixture(fixtureDir: string): FixtureSummary {
  const name = fixtureDir.split('/').slice(-1)[0] ?? '?';
  const reportPath = join(fixtureDir, 'parity-report.md');
  const extractionPath = join(fixtureDir, 'extraction-result.json');
  const renderedPath = join(fixtureDir, 'expected-rendered.json');
  const legacyPath = join(fixtureDir, 'expected-legacy.json');

  const hasReport = fs.existsSync(reportPath);
  const hasExtraction = fs.existsSync(extractionPath);
  const hasRendered = fs.existsSync(renderedPath);
  const hasLegacy = fs.existsSync(legacyPath);

  if (!hasReport) {
    return {
      name,
      tagCounts: {},
      subtagCounts: {},
      unclassifiedFields: [],
      hasReport, hasExtraction, hasRendered, hasLegacy,
    };
  }
  const parsed = parseReport(reportPath);
  return {
    name,
    tagCounts: parsed.tagCounts,
    subtagCounts: parsed.subtagCounts,
    unclassifiedFields: parsed.unclassifiedFields,
    hasReport, hasExtraction, hasRendered, hasLegacy,
  };
}

// Walk apps/api/fixtures/parity/* (skip files; only directories).
function listFixtureDirs(): string[] {
  if (!fs.existsSync(PARITY_DIR)) return [];
  const entries = fs.readdirSync(PARITY_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(PARITY_DIR, e.name))
    .sort();
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

// Output ----------------------------------------------------------------

const dirs = listFixtureDirs();

console.log('Parity Corpus Report');
console.log('====================');
console.log('Fixtures directory: ' + PARITY_DIR);
console.log('Fixture count:      ' + dirs.length);
console.log('');

if (dirs.length === 0) {
  console.log('No fixtures present yet. See docs/legacy-reduction-plan.md section 8.5');
  console.log('for fixture-creation methodology.');
  process.exit(0);
}

const summaries: FixtureSummary[] = [];
for (const d of dirs) summaries.push(summarizeFixture(d));

// Per-fixture breakdown ----------------------------------------------------

console.log('Per-fixture classification counts:');
console.log('');
const header =
  '  ' + pad('fixture', 40) +
  pad('match', 8) +
  pad('intent-mod', 12) +
  pad('legacy-bug', 12) +
  pad('miss-field', 12) +
  pad('mig-gap', 10);
console.log(header);
console.log('  ' + '-'.repeat(94));

for (const s of summaries) {
  if (!s.hasReport) {
    console.log('  ' + pad(s.name, 40) + '(no parity-report.md)');
    continue;
  }
  console.log(
    '  ' + pad(s.name, 40) +
      pad(String(s.tagCounts['match'] ?? 0), 8) +
      pad(String(s.tagCounts['intentional-modernization'] ?? 0), 12) +
      pad(String(s.tagCounts['legacy-bug'] ?? 0), 12) +
      pad(String(s.tagCounts['missing-render-field'] ?? 0), 12) +
      pad(String(s.tagCounts['migration-gap'] ?? 0), 10),
  );
}

// Cross-fixture totals -----------------------------------------------------

console.log('');
console.log('Cross-fixture totals:');
console.log('');
const totals: { [tag: string]: number } = {};
for (const t of KNOWN_TAGS) totals[t] = 0;
const subtotals: { [sub: string]: number } = {};
for (const s of KNOWN_SUBTAGS) subtotals[s] = 0;

for (const s of summaries) {
  for (const t of KNOWN_TAGS) totals[t] = (totals[t] ?? 0) + (s.tagCounts[t] ?? 0);
  for (const sub of KNOWN_SUBTAGS) subtotals[sub] = (subtotals[sub] ?? 0) + (s.subtagCounts[sub] ?? 0);
}
for (const t of KNOWN_TAGS) {
  console.log('  ' + pad(t, 32) + (totals[t] ?? 0));
}
console.log('');
console.log('  migration-gap subtotals:');
for (const sub of KNOWN_SUBTAGS) {
  console.log('    ' + pad(sub, 30) + (subtotals[sub] ?? 0));
}

// Snapshot file presence ---------------------------------------------------

console.log('');
console.log('Fixture snapshot completeness:');
console.log('');
console.log('  ' + pad('fixture', 40) + pad('extraction', 12) + pad('rendered', 12) + pad('legacy', 10) + 'report');
console.log('  ' + '-'.repeat(80));
for (const s of summaries) {
  console.log(
    '  ' + pad(s.name, 40) +
      pad(s.hasExtraction ? '✓' : '-', 12) +
      pad(s.hasRendered ? '✓' : '-', 12) +
      pad(s.hasLegacy ? '✓' : '-', 10) +
      (s.hasReport ? '✓' : '-'),
  );
}

// Unclassified fields ------------------------------------------------------

const unclassified = summaries.flatMap((s) =>
  s.unclassifiedFields.map((f) => s.name + ': ' + f),
);
if (unclassified.length > 0) {
  console.log('');
  console.log('Unclassified fields (red flag - every divergence MUST be classified):');
  for (const u of unclassified) console.log('  - ' + u);
}

// This script does not exit non-zero on classification counts. It is observational.
process.exit(0);
