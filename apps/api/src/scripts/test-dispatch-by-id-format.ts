// Tests for dispatch-by-id-format (Batch 6.8 - strict dispatch).
//
//   npm run test:dispatch-by-id-format
//
// Verifies the id-format classification used at every route handler.

import {
  dispatchByIdFormat,
  MalformedAnalysisIdError,
  type IdFormat,
} from '../util/dispatch-by-id-format.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  m: string,
): void {
  try { fn(); fail(m + ' (did not throw)'); }
  catch (e) {
    if (e instanceof ctor) ok(m);
    else fail(m + ' (threw ' + (e as Error)?.name + ')');
  }
}

console.log('UUID v4 -> legacy:');
{
  const cases: ReadonlyArray<{ id: string; m: string }> = [
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', m: 'standard uuid v4' },
    { id: '00000000-0000-4000-8000-000000000000', m: 'all-zero uuid v4 (version 4, variant 8)' },
    { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', m: 'all-f uuid v4 (variant b)' },
    { id: '12345678-1234-4234-9234-123456789abc', m: 'representative uuid v4 (variant 9)' },
    { id: 'deadbeef-cafe-4bad-a000-feedfacecafe', m: 'mixed-case-looking uuid v4 (variant a)' },
  ];
  for (const c of cases) {
    const result: IdFormat = dispatchByIdFormat(c.id);
    assertEqual(result, 'legacy', c.m + ' -> legacy');
  }
}

console.log('\nContent-hash (64-char lowercase hex) -> graph:');
{
  const cases: ReadonlyArray<{ id: string; m: string }> = [
    { id: 'a'.repeat(64), m: 'all-a content hash' },
    { id: '0'.repeat(64), m: 'all-zero content hash' },
    { id: 'f'.repeat(64), m: 'all-f content hash' },
    {
      id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      m: 'representative 64-hex content hash',
    },
  ];
  for (const c of cases) {
    const result: IdFormat = dispatchByIdFormat(c.id);
    assertEqual(result, 'graph', c.m + ' -> graph');
  }
}

console.log('\nMalformed -> MalformedAnalysisIdError:');
{
  const cases: ReadonlyArray<{ id: string; m: string }> = [
    { id: '', m: 'empty string' },
    { id: 'not-an-id', m: 'arbitrary string' },
    { id: 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D', m: 'uppercase uuid (lowercase only per convention)' },
    { id: 'A'.repeat(64), m: 'uppercase 64-hex (lowercase only)' },
    { id: 'a'.repeat(63), m: '63-char hex (too short for content hash)' },
    { id: 'a'.repeat(65), m: '65-char hex (too long for content hash)' },
    { id: 'g'.repeat(64), m: 'non-hex 64-char string' },
    { id: '00000000-0000-3000-8000-000000000000', m: 'uuid v3 (wrong version nibble)' },
    { id: '00000000-0000-4000-7000-000000000000', m: 'uuid v4 with wrong variant nibble' },
    {
      id: '0123456789abcdef0123456789abcdef-0123456789abcdef0123456789abcdef',
      m: 'content-hash-length string with embedded dash',
    },
    { id: '   ', m: 'whitespace' },
    { id: 'a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d', m: 'uuid hex without dashes' },
  ];
  for (const c of cases) {
    assertThrowsInstance(
      () => dispatchByIdFormat(c.id),
      MalformedAnalysisIdError,
      c.m + ' -> MalformedAnalysisIdError',
    );
  }
}

console.log('\nDeterminism:');
{
  const id = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const a = dispatchByIdFormat(id);
  const b = dispatchByIdFormat(id);
  assertEqual(a, b, 'same input -> same dispatch result (pure function)');
}

console.log('\nIdFormat is the closed union { legacy | graph }:');
{
  // Type-level assertion: function arity is 1 (id only); runtime returns one of two strings
  assertEqual(dispatchByIdFormat.length, 1, 'arity === 1');
  const uuid = '12345678-1234-4234-9234-123456789abc';
  const hash = 'a'.repeat(64);
  const r1 = dispatchByIdFormat(uuid);
  const r2 = dispatchByIdFormat(hash);
  assert(r1 === 'legacy' || r1 === 'graph', 'result is one of {legacy, graph}');
  assert(r2 === 'legacy' || r2 === 'graph', 'result is one of {legacy, graph}');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
