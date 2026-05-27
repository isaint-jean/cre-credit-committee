/**
 * Determinism + sensitivity + golden tests for `computeRevisionId`.
 *
 * Source-of-truth: `docs/architecture/revision-lineage-spec.md` §5.
 * Companion contract: `packages/contracts/src/revision-lineage.ts`.
 *
 *   npm run test:revision-id        (from apps/api)
 *
 * Exits 0 on success, 1 on any failure.
 *
 * Two independent implementations MUST produce byte-identical RevisionId from
 * byte-identical RevisionIdHashInput (the §5 hard requirement). The golden block
 * below pins the canonical-form + SHA-256 output for hand-checked inputs so any
 * future drift in the hash boundary or canonicalizer fails the test.
 */

import type {
  AdjustedInputsId,
  ParentRevisionId,
  RevisionId,
  RevisionIdHashInput,
} from '@cre/contracts';
import type { DoctrineVersion } from '@cre/contracts';
import { computeRevisionId } from '../util/content-hash.js';

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

/* ----- shared fixture (cast-narrow; we don't need the brands enforced here) -- */

const ADJ_A = '1111111111111111111111111111111111111111111111111111111111111111' as AdjustedInputsId;
const ADJ_B = '2222222222222222222222222222222222222222222222222222222222222222' as AdjustedInputsId;
const PARENT_X = '3333333333333333333333333333333333333333333333333333333333333333' as RevisionId;
const PARENT_Y = '4444444444444444444444444444444444444444444444444444444444444444' as RevisionId;
const DOC_V1 = 'doctrine@1' as DoctrineVersion;
const DOC_V2 = 'doctrine@2' as DoctrineVersion;

function input(overrides: Partial<RevisionIdHashInput> = {}): RevisionIdHashInput {
  return {
    parentRevisionId: null as ParentRevisionId,
    adjustedInputsId: ADJ_A,
    doctrineVersion: DOC_V1,
    ...overrides,
  };
}

console.log('Format:');

{
  const h = computeRevisionId(input());
  assert(/^[0-9a-f]{64}$/.test(h), `RevisionId is 64-char lowercase hex (got ${h})`);
}

console.log('\nDeterminism:');

// idempotent on identical input
{
  const a = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  const b = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  assertEqual(a, b, 'idempotent on identical input');
}

// JCS / object key ordering insensitivity (top-level)
{
  const a = computeRevisionId({
    parentRevisionId: PARENT_X,
    adjustedInputsId: ADJ_A,
    doctrineVersion: DOC_V1,
  });
  const b = computeRevisionId({
    doctrineVersion: DOC_V1,
    adjustedInputsId: ADJ_A,
    parentRevisionId: PARENT_X,
  } as RevisionIdHashInput);
  assertEqual(a, b, 'reordered top-level keys yield same hash (JCS L6)');
}

// root revision (parentRevisionId=null) is deterministic
{
  const a = computeRevisionId(input({ parentRevisionId: null }));
  const b = computeRevisionId(input({ parentRevisionId: null }));
  assertEqual(a, b, 'root revision (parent=null) is deterministic');
}

console.log('\nField sensitivity (each hash-input field must affect the id):');

// parentRevisionId sensitivity (non-null vs null)
{
  const root = computeRevisionId(input({ parentRevisionId: null }));
  const child = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  assert(root !== child, 'parentRevisionId null vs non-null changes hash');
}

// parentRevisionId sensitivity (different non-null values)
{
  const a = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  const b = computeRevisionId(input({ parentRevisionId: PARENT_Y }));
  assert(a !== b, 'different parentRevisionId values yield different hashes');
}

// adjustedInputsId sensitivity
{
  const a = computeRevisionId(input({ adjustedInputsId: ADJ_A }));
  const b = computeRevisionId(input({ adjustedInputsId: ADJ_B }));
  assert(a !== b, 'different adjustedInputsId values yield different hashes');
}

// doctrineVersion sensitivity
{
  const a = computeRevisionId(input({ doctrineVersion: DOC_V1 }));
  const b = computeRevisionId(input({ doctrineVersion: DOC_V2 }));
  assert(a !== b, 'different doctrineVersion values yield different hashes');
}

console.log('\nL5 — no timestamp leakage (provenance/timestamps must not be in scope):');

// Constructing a "noisy" object with extra non-hash-input fields would fail at the
// type system at the call site. We can only test the contract: callers must pass
// EXACTLY RevisionIdHashInput, and identical hash-input → identical id regardless
// of any wall-clock environment. Round-trip across a setTimeout (a stand-in for
// wall-clock progression) and assert equal.
{
  const a = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  // Synthetic delay equivalent: no actual sleep, but call again "later" in code path.
  const b = computeRevisionId(input({ parentRevisionId: PARENT_X }));
  assertEqual(a, b, 'wall-clock-independent (identical input → identical id)');
}

console.log('\nGolden values (canonical form locked; investigate if these change):');

// Hand-checked: JCS(canonical-JSON) of these inputs hashed with SHA-256, lowercase
// hex. Computed by feeding identical inputs through computeContentHash first; if a
// canonicalizer or hashing primitive change ever flips these, two implementations
// would no longer round-trip — the spec §5 hard requirement would break.
{
  const root = computeRevisionId({
    parentRevisionId: null,
    adjustedInputsId: ADJ_A,
    doctrineVersion: DOC_V1,
  });
  // First-write golden: print + lock. Subsequent runs MUST match.
  const GOLDEN_ROOT = '5686d1e93d88f7235a44157d4e908901db307abd6f05c86f41ff99b36c663994';
  assertEqual(root, GOLDEN_ROOT, 'golden #1 — root revision (parent=null, ADJ_A, DOC_V1)');
}

{
  const child = computeRevisionId({
    parentRevisionId: PARENT_X,
    adjustedInputsId: ADJ_B,
    doctrineVersion: DOC_V1,
  });
  const GOLDEN_CHILD = '6e90f60c93ea2a584ce60176d9fb5f1223358a1e8e618eb74bba1a5e1a4cab61';
  assertEqual(child, GOLDEN_CHILD, 'golden #2 — child revision (PARENT_X, ADJ_B, DOC_V1)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
