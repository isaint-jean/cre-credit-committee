/**
 * Build-time lint test: ensures the handbook references no field paths
 * the assembler doesn't know about.
 *
 * This is the safety net for design choice B2 (untyped FieldBag).
 * Without it, a typo or new field in a handbook principle would
 * silently fail to fire — engine returns undefined from the bag, check
 * skips with 'missing_field', no test catches it.
 *
 * With it: any new field path in the handbook fails CI until the
 * assembler adds explicit handling — either real population logic, or
 * an entry in INTENTIONALLY_UNDEFINED_FIELDS with a comment explaining
 * why it's not implemented yet.
 *
 * Pairs the engine's lint module with the assembler's KNOWN_FIELDS
 * export.
 *
 * INTEGRATION NOTE FOR CC: change the imports to:
 *   import { handbook } from '@cre/handbook-data';
 *   import { assertNoUnknownFields, collectReferencedFields } from '@cre/handbook-engine';
 *   import { KNOWN_FIELDS } from '../src/index.ts';
 */

import { handbook } from '@cre/handbook-data';
import { assertNoUnknownFields, collectReferencedFields } from '@cre/handbook-engine';
import { KNOWN_FIELDS } from '../services/handbook/index.js';

// =============================================================================
// Test
// =============================================================================

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

console.log('\n=== Handbook ↔ assembler known-fields lint ===');

try {
  // This will throw if the handbook references any field path not in
  // KNOWN_FIELDS. The error message lists the offending paths.
  assertNoUnknownFields(handbook, KNOWN_FIELDS);
  ok('handbook references no field paths unknown to the assembler');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  fail(`assertNoUnknownFields threw: ${msg}`);
}

// Additional sanity check: every field the handbook references is in
// KNOWN_FIELDS. This is logically equivalent to assertNoUnknownFields
// but produces a cleaner diff if it fails.
const referenced = collectReferencedFields(handbook);
const unknown = referenced.filter((f) => !KNOWN_FIELDS.has(f));
if (unknown.length === 0) {
  ok(`all ${referenced.length} handbook-referenced fields are in KNOWN_FIELDS`);
} else {
  fail(
    `${unknown.length} handbook field(s) not in KNOWN_FIELDS:\n      ${unknown.map((f) => `'${f}'`).join('\n      ')}`,
  );
}

// And the reverse: KNOWN_FIELDS entries that the handbook doesn't
// reference are NOT a failure — they're orphan fields the assembler
// knows about but no principle uses yet. This is a warning, not an
// error. Useful diagnostic when handbook principles are removed.
const orphans = Array.from(KNOWN_FIELDS).filter((f) => !referenced.includes(f));
if (orphans.length > 0) {
  console.log(
    `  warn  ${orphans.length} KNOWN_FIELDS entries not referenced by any handbook principle:`,
  );
  for (const f of orphans) console.log(`        '${f}'`);
  console.log(`        (warning only — no failure)`);
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
