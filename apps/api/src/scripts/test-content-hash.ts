/**
 * Determinism + rejection tests for `computeContentHash`.
 *
 * Run via:  npm run test:content-hash      (from apps/api)
 * Exits 0 on success, 1 on any failure. Designed to be wired into CI without a test runner —
 * later we can port the cases into vitest if/when a real runner is added.
 */

import { canonicalize } from '../util/canonical-json.js';
import { computeContentHash } from '../util/content-hash.js';

let failed = 0;
let passed = 0;

function ok(message: string): void {
  passed++;
  console.log(`  ok    ${message}`);
}

function fail(message: string): void {
  failed++;
  console.error(`  FAIL  ${message}`);
}

function assert(condition: boolean, message: string): void {
  condition ? ok(message) : fail(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) ok(message);
  else fail(`${message} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch {
    ok(message);
  }
}

console.log('Determinism:');

// same content, reordered top-level keys
{
  const a = computeContentHash({ a: 1, b: 2 });
  const b = computeContentHash({ b: 2, a: 1 });
  assertEqual(a, b, 'reordered top-level keys yield same hash');
}

// deeply reordered
{
  const a = computeContentHash({ a: 1, b: { c: 2, d: 3 } });
  const b = computeContentHash({ b: { d: 3, c: 2 }, a: 1 });
  assertEqual(a, b, 'reordered nested keys yield same hash');
}

// idempotent
{
  const v = { x: 1.5, y: [true, null, 'hello'] };
  assertEqual(computeContentHash(v), computeContentHash(v), 'idempotent on identical input');
}

// array order matters
{
  const a = computeContentHash([1, 2, 3]);
  const b = computeContentHash([3, 2, 1]);
  assert(a !== b, 'array order is significant');
}

// null vs missing key
{
  const a = computeContentHash({ a: null, b: 1 });
  const b = computeContentHash({ b: 1 });
  assert(a !== b, 'null differs from missing key');
}

// number vs stringified number
{
  const a = computeContentHash({ x: 1 });
  const b = computeContentHash({ x: '1' });
  assert(a !== b, 'number differs from string-of-number');
}

// boolean vs number
{
  const a = computeContentHash({ x: true });
  const b = computeContentHash({ x: 1 });
  assert(a !== b, 'true differs from 1');
}

// empty object vs empty array
{
  assert(
    computeContentHash({}) !== computeContentHash([]),
    'empty object differs from empty array',
  );
}

// hash format
{
  const h = computeContentHash({ a: 1 });
  assert(/^[0-9a-f]{64}$/.test(h), `hash is 64-char lowercase hex (got ${h})`);
}

// floating-point determinism (same float yields same hash)
{
  const a = computeContentHash({ x: 0.1 + 0.2 });
  const b = computeContentHash({ x: 0.1 + 0.2 });
  assertEqual(a, b, 'idempotent on float arithmetic');
}

// -0 and 0 collapse to same canonical form (per ECMAScript ToString)
{
  const a = computeContentHash({ x: 0 });
  const b = computeContentHash({ x: -0 });
  assertEqual(a, b, '-0 canonicalizes to 0');
}

console.log('\nRejections:');

assertThrows(() => canonicalize(undefined),         'reject undefined at root');
assertThrows(() => canonicalize({ x: undefined }),  'reject undefined as object value');
assertThrows(() => canonicalize([1, undefined, 3]), 'reject undefined inside array');
assertThrows(() => canonicalize(NaN),               'reject NaN');
assertThrows(() => canonicalize(Infinity),          'reject Infinity');
assertThrows(() => canonicalize(-Infinity),         'reject -Infinity');
assertThrows(() => canonicalize(() => 1),           'reject function');
assertThrows(() => canonicalize(Symbol('x')),       'reject symbol');
assertThrows(() => canonicalize(BigInt(1)),         'reject bigint');
assertThrows(() => canonicalize(new Map()),         'reject Map');
assertThrows(() => canonicalize(new Set()),         'reject Set');
assertThrows(() => canonicalize(new Date()),        'reject Date (class instance)');

// cycle detection
{
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assertThrows(() => canonicalize(cycle), 'reject cycle');
}

// nested cycle
{
  const a: { b?: unknown } = {};
  const b: { a?: unknown } = { a };
  a.b = b;
  assertThrows(() => canonicalize(a), 'reject mutual cycle');
}

console.log('\nGolden values (canonical form locked; investigate if these change):');

{
  const golden = computeContentHash({ analysisAsOfDate: '2026-05-08T00:00:00Z', loanAmount: 50000000 });
  console.log(`  hash for golden #1: ${golden}`);
}
{
  const golden = computeContentHash({
    assetType: 'Office',
    metrics: { dscr: 1.25, ltvAppraisal: 0.65, debtYield: 0.095 },
  });
  console.log(`  hash for golden #2: ${golden}`);
}
{
  const golden = computeContentHash({
    flags: ['VACANCY_UNDERSTATED', 'CAPEX_SHORTFALL'],
    finalScore: 58,
    ratingBand: 'Weak',
  });
  console.log(`  hash for golden #3: ${golden}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
