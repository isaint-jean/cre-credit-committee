/**
 * Tests for slotIsAcceptable + incompleteSlots (build-report.ts).
 *
 *   tsx src/scripts/test-build-report-helpers.ts
 *
 * Loose-A semantics: a slot is acceptable when its status is 'ok' or 'empty'.
 * Failed and absent are NOT acceptable. incompleteSlots returns the slot keys
 * where status is failed or absent.
 *
 * NOTE on the `as`-casts to `ExtractionEngineVersion` / `ISODateTime`: tests
 * synthesize BuildReport shapes; the contract-side branded types accept any
 * string at the type level via cast. Test-only license; production code
 * uses EXTRACTION_ENGINE_VERSION import.
 */

import type { ExtractionEngineVersion, ISODateTime } from '@cre/contracts';
import type { BuildReport, SlotReport } from '../services/extraction/build-report.js';
import {
  slotIsAcceptable,
  incompleteSlots,
} from '../services/extraction/build-report.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const okSlot: SlotReport = { status: 'ok', durationMs: 1, adapterVersion: '0.1.0' };
const emptySlot: SlotReport = { status: 'empty', durationMs: 1, adapterVersion: '0.1.0', reason: 'no rows' };
const failedSlot: SlotReport = { status: 'failed', durationMs: 1, adapterVersion: '0.1.0', error: { name: 'X', message: 'y' } };
const absentSlot: SlotReport = { status: 'absent' };

/* -------------------------- slotIsAcceptable ----------------------------- */

console.log('slotIsAcceptable:');
assert(slotIsAcceptable(okSlot) === true, '1. ok → true');
assert(slotIsAcceptable(emptySlot) === true, '2. empty → true');
assert(slotIsAcceptable(failedSlot) === false, '3. failed → false');
assert(slotIsAcceptable(absentSlot) === false, '4. absent → false');

/* --------------------------- incompleteSlots ----------------------------- */

console.log('\nincompleteSlots:');

const allClean: BuildReport = {
  startedAt: '2026-01-01T00:00:00Z' as ISODateTime,
  finishedAt: '2026-01-01T00:00:01Z' as ISODateTime,
  engineVersion: '1.1.0' as ExtractionEngineVersion,
  slots: {
    sellerCfXlsx: okSlot,
    rentRollXlsx: emptySlot,
    asrPdf: okSlot,
    pcaPdf: okSlot,
  },
};
const cleanResult = incompleteSlots(allClean);
assertEqual(cleanResult.length, 0, '5. all ok/empty → empty list');

const mixed: BuildReport = {
  startedAt: '2026-01-01T00:00:00Z' as ISODateTime,
  finishedAt: '2026-01-01T00:00:01Z' as ISODateTime,
  engineVersion: '1.1.0' as ExtractionEngineVersion,
  slots: {
    sellerCfXlsx: okSlot,
    rentRollXlsx: failedSlot,
    asrPdf: absentSlot,
    pcaPdf: okSlot,
  },
};
const mixedSorted = [...incompleteSlots(mixed)].sort();
assertEqual(mixedSorted.length, 2, '6. failed + absent → 2 slots incomplete');
assertEqual(mixedSorted[0], 'asrPdf', '7. asrPdf in incomplete list');
assertEqual(mixedSorted[1], 'rentRollXlsx', '8. rentRollXlsx in incomplete list');

const allBad: BuildReport = {
  startedAt: '2026-01-01T00:00:00Z' as ISODateTime,
  finishedAt: '2026-01-01T00:00:01Z' as ISODateTime,
  engineVersion: '1.1.0' as ExtractionEngineVersion,
  slots: {
    sellerCfXlsx: failedSlot,
    rentRollXlsx: absentSlot,
    asrPdf: failedSlot,
    pcaPdf: failedSlot,
  },
};
assertEqual(incompleteSlots(allBad).length, 4, '9. all-bad → 4 slots incomplete');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
