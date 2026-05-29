/**
 * Tests for format-flags (Piece A Phase 1 batch 1).
 *
 *   npm run test:format-flags
 *
 * Loads the synthetic Sunroad HandbookEvaluation anchor and verifies:
 *   - Each InjectionPoint returns the documented flag-count split
 *     (executive_summary=2, red_flag_assessment=4, mitigation_suggestions=1,
 *     committee_recommendation=4).
 *   - Filter excludes flags whose `injectionPoints` array does NOT contain
 *     the requested point (P-IV-OFF-2 + P-IV-OFF-9 missing from
 *     executive_summary).
 *   - Sort order is severity (critical first) then principleId ascending.
 *   - FormattedFlag shape preserves principleId / severity / message /
 *     metric, drops engine indices.
 *   - consumedPrincipleIdsForInjectionPoint is sort-stable.
 *   - Empty input + no-match input both return [].
 *
 * Hand-rolled assertEqual pattern matching test-handbook-evaluation.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FiredFlag, HandbookEvaluation, Severity } from '@cre/contracts';
import {
  formatFlagsForInjectionPoint,
  consumedPrincipleIdsForInjectionPoint,
  type FormattedFlag,
} from '../services/narrative/format-flags.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  SCRIPT_DIR,
  '../../fixtures/sunroad-centrum-handbook-evaluation.json',
);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}
function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(m);
  else fail(`${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}

const he = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as HandbookEvaluation;

console.log('\n=== Fixture sanity ===');
assertEqual(he.firedFlags.length, 4, 'fixture has 4 fired flags');
assertEqual(
  [...he.firedFlags].map((f) => f.principleId).sort(),
  ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
  'fixture principleIds match documented Sunroad anchor',
);

console.log('\n=== formatFlagsForInjectionPoint — counts per InjectionPoint ===');
{
  const exec = formatFlagsForInjectionPoint(he.firedFlags, 'executive_summary');
  const rfa  = formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  const mit  = formatFlagsForInjectionPoint(he.firedFlags, 'mitigation_suggestions');
  const comm = formatFlagsForInjectionPoint(he.firedFlags, 'committee_recommendation');
  assertEqual(exec.length, 2, 'executive_summary returns 2 flags');
  assertEqual(rfa.length, 4,  'red_flag_assessment returns 4 flags');
  assertEqual(mit.length, 1,  'mitigation_suggestions returns 1 flag');
  assertEqual(comm.length, 4, 'committee_recommendation returns 4 flags');
}

console.log('\n=== executive_summary filter: drops P-IV-OFF-2 + P-IV-OFF-9 ===');
{
  const exec = formatFlagsForInjectionPoint(he.firedFlags, 'executive_summary');
  const ids = exec.map((f) => f.principleId);
  assertEqual(ids, ['P-II-3', 'P-II-8'], 'executive_summary keeps only flags whose injectionPoints include it');
}

console.log('\n=== mitigation_suggestions filter: keeps only P-II-3 (Phase 3 parallel-depth coverage) ===');
{
  // Fixture: only P-II-3 declares mitigation_suggestions in its injectionPoints
  // (the universal critical cash-out flag). P-II-8 + P-IV-OFF-2 + P-IV-OFF-9
  // are NOT in mitigation_suggestions.
  const mit = formatFlagsForInjectionPoint(he.firedFlags, 'mitigation_suggestions');
  assertEqual(mit.map((f) => f.principleId), ['P-II-3'], 'mitigation_suggestions returns the singleton');

  const only = mit[0];
  if (!only) {
    fail('expected P-II-3 in mitigation_suggestions output');
  } else {
    assertEqual(only.principleId, 'P-II-3', 'singleton is P-II-3');
    assertEqual<Severity>(only.severity, 'critical', 'severity preserved');
    assertEqual(only.metric, '8500000', 'numeric metricValue stringified');
    assertEqual(
      only.message,
      'Cash-out refinance of $8.5M elevates risk; scrutiny warranted.',
      'flag_message mapped to .message',
    );
  }

  // Verify exclusion: the other 3 flags must NOT appear in mitigation_suggestions.
  const mitIds = new Set(mit.map((f) => f.principleId));
  for (const excluded of ['P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9']) {
    if (mitIds.has(excluded)) fail(`${excluded} should NOT appear in mitigation_suggestions`);
  }
  ok('P-II-8 + P-IV-OFF-2 + P-IV-OFF-9 correctly excluded from mitigation_suggestions');
}

console.log('\n=== committee_recommendation filter: all 4 flags (Phase 4 parallel-depth coverage) ===');
{
  // Fixture: all 4 fired flags include committee_recommendation in their
  // injectionPoints arrays — committee_recommendation matches red_flag_assessment
  // in count (4 flags). Severity sort: 1 critical + 3 high; high tiebroken by
  // principleId ascending.
  const comm = formatFlagsForInjectionPoint(he.firedFlags, 'committee_recommendation');
  assertEqual(
    comm.map((f) => f.principleId),
    ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
    'committee_recommendation ordering: critical first, then high ascending by principleId',
  );

  const first = comm[0];
  if (!first) {
    fail('expected at least one formatted flag for committee_recommendation');
  } else {
    assertEqual(first.principleId, 'P-II-3', 'first formatted flag is P-II-3 (critical)');
    assertEqual<Severity>(first.severity, 'critical', 'severity preserved');
    assertEqual(first.metric, '8500000', 'numeric metricValue stringified');
  }

  // Spot-check string + non-overlapping principle ids that the prior 3 slots
  // partition differently — P-IV-OFF-2 appears in red_flag + committee but
  // NOT in executive_summary or mitigation_suggestions. This confirms
  // committee_recommendation's distinct membership shape.
  const commIds = new Set(comm.map((f) => f.principleId));
  if (!commIds.has('P-IV-OFF-2')) fail('P-IV-OFF-2 should appear in committee_recommendation');
  if (!commIds.has('P-IV-OFF-9')) fail('P-IV-OFF-9 should appear in committee_recommendation');
  ok('committee_recommendation includes P-IV-OFF-2 + P-IV-OFF-9 (red_flag overlap; not in exec_summary or mitigation)');
}

console.log('\n=== red_flag_assessment filter + ordering (Phase 2 parallel-depth coverage) ===');
{
  // All 4 fixture flags target red_flag_assessment. Severity sort: 1 critical
  // (P-II-3) + 3 high (P-II-8, P-IV-OFF-2, P-IV-OFF-9). Among 'high',
  // principleId ascending tiebreak: P-II-8 < P-IV-OFF-2 < P-IV-OFF-9.
  const rfa = formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  assertEqual(
    rfa.map((f) => f.principleId),
    ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
    'red_flag_assessment ordering: critical first, then high ascending by principleId',
  );
  const first = rfa[0];
  if (!first) {
    fail('expected at least one formatted flag for red_flag_assessment');
  } else {
    assertEqual(first.principleId, 'P-II-3', 'first red-flag formatted is P-II-3 (critical)');
    assertEqual<Severity>(first.severity, 'critical', 'severity preserved');
    assertEqual(first.metric, '8500000', 'numeric metricValue stringified');
  }
  // P-IV-OFF-2 + P-IV-OFF-9 are red_flag_assessment-only — verify they
  // surface here but NOT in executive_summary.
  const execIds = formatFlagsForInjectionPoint(he.firedFlags, 'executive_summary').map((f) => f.principleId);
  for (const id of ['P-IV-OFF-2', 'P-IV-OFF-9']) {
    if (execIds.includes(id)) fail(`${id} should NOT appear in executive_summary`);
    if (!rfa.map((f) => f.principleId).includes(id)) fail(`${id} should appear in red_flag_assessment`);
  }
  ok('P-IV-OFF-2 + P-IV-OFF-9 are red_flag_assessment-only (not in executive_summary)');
}

console.log('\n=== red_flag_assessment FormattedFlag string-metric formatting ===');
{
  // P-II-8 has metricValue: 'Medical Office' (string). Verify formatting.
  const rfa = formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  const p2_8 = rfa.find((f) => f.principleId === 'P-II-8');
  if (!p2_8) {
    fail('expected P-II-8 in red_flag_assessment output');
  } else {
    assertEqual(p2_8.metric, 'Medical Office', 'string metricValue passes through to red-flag output');
    assertEqual(
      p2_8.message,
      'Medical Office subtype falls within specialty-assets category.',
      'red-flag .message mapped from flag_message',
    );
  }
}

console.log('\n=== Sort order: severity then principleId ===');
{
  // Construct a synthetic mixed-severity input. Two of severity 'high', one
  // 'critical', one 'advisory'. Expected order: critical → high(by id) → advisory.
  const mixed: FiredFlag[] = [
    { principleId: 'P-A', severity: 'high',      flag_message: '', metricValue: 1, groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
    { principleId: 'P-B', severity: 'critical',  flag_message: '', metricValue: 2, groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
    { principleId: 'P-C', severity: 'advisory',  flag_message: '', metricValue: 3, groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
    { principleId: 'P-D', severity: 'high',      flag_message: '', metricValue: 4, groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
  ];
  const sorted = formatFlagsForInjectionPoint(mixed, 'executive_summary');
  assertEqual(
    sorted.map((f) => f.principleId),
    ['P-B', 'P-A', 'P-D', 'P-C'],
    'critical first; high tiebroken by principleId ascending; advisory last',
  );
}

console.log('\n=== FormattedFlag shape ===');
{
  const exec = formatFlagsForInjectionPoint(he.firedFlags, 'executive_summary');
  const first = exec[0];
  if (!first) {
    fail('expected at least one formatted flag');
  } else {
    // Sunroad fixture: P-II-3 critical fires first
    assertEqual(first.principleId, 'P-II-3', 'first formatted flag is P-II-3 (critical)');
    assertEqual<Severity>(first.severity, 'critical', 'severity preserved');
    assertEqual(
      first.message,
      'Cash-out refinance of $8.5M elevates risk; scrutiny warranted.',
      'flag_message mapped to .message',
    );
    assertEqual(first.metric, '8500000', 'numeric metricValue stringified');
    // Ensure engine indices are NOT exposed
    const keys = Object.keys(first as object).sort();
    assertEqual(keys, ['message', 'metric', 'principleId', 'severity'], 'no groupIndex/bandIndex leakage');
  }
}

console.log('\n=== Metric formatting: string + array + null ===');
{
  const mixed: FiredFlag[] = [
    { principleId: 'P-1', severity: 'high', flag_message: 'string metric', metricValue: 'Medical Office', groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
    { principleId: 'P-2', severity: 'high', flag_message: 'array metric',  metricValue: [1, 2, 3],         groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
    { principleId: 'P-3', severity: 'high', flag_message: 'null metric',   metricValue: null,              groupIndex: 0, bandIndex: 0, injectionPoints: ['executive_summary'] },
  ];
  const out = formatFlagsForInjectionPoint(mixed, 'executive_summary');
  const byId = Object.fromEntries(out.map((f) => [f.principleId, f.metric])) as Record<string, string>;
  assertEqual(byId['P-1'], 'Medical Office', 'string metric passes through');
  assertEqual(byId['P-2'], '1, 2, 3',        'array metric joins comma-space');
  assertEqual(byId['P-3'], '—',              'null metric renders em-dash');
}

console.log('\n=== consumedPrincipleIdsForInjectionPoint ===');
{
  const ids = consumedPrincipleIdsForInjectionPoint(he.firedFlags, 'executive_summary');
  assertEqual(ids, ['P-II-3', 'P-II-8'], 'consumed ids sorted ascending for executive_summary');
  const idsRfa = consumedPrincipleIdsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  assertEqual(
    idsRfa,
    ['P-II-3', 'P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9'],
    'consumed ids sorted ascending for red_flag_assessment',
  );
}

console.log('\n=== Empty + no-match input returns [] ===');
{
  assertEqual(formatFlagsForInjectionPoint([], 'executive_summary'), [], 'empty input → []');
  const noMatch: FiredFlag[] = [
    { principleId: 'P-X', severity: 'critical', flag_message: '', metricValue: 0, groupIndex: 0, bandIndex: 0, injectionPoints: ['red_flag_assessment'] },
  ];
  assertEqual(formatFlagsForInjectionPoint(noMatch, 'executive_summary'), [], 'no-match input → []');
  assertEqual(consumedPrincipleIdsForInjectionPoint([], 'executive_summary'), [], 'empty consumed-ids → []');
}

console.log('\n=== Determinism (same input → same output) ===');
{
  const a = formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  const b = formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'repeated call returns byte-identical JSON');
  // also: input array not mutated
  const before = he.firedFlags.map((f) => f.principleId);
  formatFlagsForInjectionPoint(he.firedFlags, 'red_flag_assessment');
  const after = he.firedFlags.map((f) => f.principleId);
  assertEqual(after, before, 'input array order not mutated');
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
// Mark FormattedFlag as used (type-only import is silently elided)
const _: FormattedFlag = { principleId: '', severity: 'advisory', message: '', metric: '' };
void _;
process.exit(failed > 0 ? 1 : 0);
