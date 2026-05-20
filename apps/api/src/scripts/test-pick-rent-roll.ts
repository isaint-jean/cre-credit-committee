/**
 * Tests for pickRentRoll — the rent-roll precedence policy used by
 * buildExtractionResult. Pure function over outcome-shape inputs;
 * exhaustively covers the 13-row truth table from the orchestration scoping.
 *
 *   tsx src/scripts/test-pick-rent-roll.ts
 */

import type { ContentHash, RentRollExtraction, RentRollUnit } from '@cre/contracts';
import type { ExtractorOutcome } from '../services/extraction/extractor-outcome.js';
import { pickRentRoll } from '../services/extraction/pick-rent-roll.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }

/* ----------------------------- builders ---------------------------------- */

function makeUnit(unitId: string, occupied: boolean): RentRollUnit {
  return {
    unitId,
    tenantName: occupied ? `Tenant ${unitId}` : null,
    leaseStart: null,
    leaseEnd: null,
    baseRentMonthly: null,
    inPlaceRentMonthly: occupied ? 3000 : null,
    occupied,
    concessions: null,
    securityDeposit: null,
  };
}

function makeExtraction(units: RentRollUnit[]): RentRollExtraction {
  return {
    units,
    summary: {
      totalUnits: units.length,
      occupiedUnits: units.filter((u) => u.occupied).length,
      economicOccupancy: null,
    },
  };
}

const HASH = 'a'.repeat(64) as ContentHash;

function okOutcome(value: RentRollExtraction): ExtractorOutcome<RentRollExtraction> {
  return {
    status: 'ok',
    value,
    sourceRefs: [{ kind: 'rent_roll', contentHash: HASH }],
    adapterVersion: '0.1.0',
    durationMs: 1,
  };
}

function emptyOutcome(): ExtractorOutcome<RentRollExtraction> {
  return {
    status: 'empty',
    sourceRefs: [],
    adapterVersion: '0.1.0',
    durationMs: 1,
    reason: 'no tenant rows',
  };
}

function failedOutcome(): ExtractorOutcome<RentRollExtraction> {
  return {
    status: 'failed',
    sourceRefs: [],
    adapterVersion: '0.1.0',
    durationMs: 1,
    error: { name: 'TestError', message: 'simulated' },
  };
}

/* --------------------------- 13-row truth table -------------------------- */

const populated = makeExtraction([makeUnit('100', true), makeUnit('101', false)]);
const emptyUnits = makeExtraction([]);

console.log('pickRentRoll truth table:');

/* 1. absent + null fallback → null */
assert(pickRentRoll(null, null) === null, '1. absent + null → null');

/* 2. absent + fallback w/ units → fallback */
assert(pickRentRoll(null, populated) === populated, '2. absent + fallback w/units → fallback');

/* 3. absent + fallback w/ empty units → null */
assert(pickRentRoll(null, emptyUnits) === null, '3. absent + fallback empty → null');

/* 4. failed + null → null */
assert(pickRentRoll(failedOutcome(), null) === null, '4. failed + null → null');

/* 5. failed + fallback w/ units → fallback */
assert(pickRentRoll(failedOutcome(), populated) === populated, '5. failed + fallback w/units → fallback');

/* 6. failed + fallback empty → null */
assert(pickRentRoll(failedOutcome(), emptyUnits) === null, '6. failed + fallback empty → null');

/* 7. empty + null → null */
assert(pickRentRoll(emptyOutcome(), null) === null, '7. empty + null → null');

/* 8. empty + fallback w/ units → fallback */
assert(pickRentRoll(emptyOutcome(), populated) === populated, '8. empty + fallback w/units → fallback');

/* 9. empty + fallback empty → null */
assert(pickRentRoll(emptyOutcome(), emptyUnits) === null, '9. empty + fallback empty → null');

/* 10. ok w/ empty units + null → null */
const okEmptyUnits = okOutcome(emptyUnits);
assert(pickRentRoll(okEmptyUnits, null) === null, '10. ok empty-units + null → null');

/* 11. ok w/ empty units + fallback w/ units → fallback */
assert(pickRentRoll(okEmptyUnits, populated) === populated, '11. ok empty-units + fallback w/units → fallback');

/* 12. ok w/ units + null → xlsx wins */
const okPop = okOutcome(populated);
assert(pickRentRoll(okPop, null) === populated, '12. ok w/units + null → xlsx');

/* 13. ok w/ units + fallback w/ units → xlsx wins (precedence) */
const otherFallback = makeExtraction([makeUnit('200', true)]);
assert(pickRentRoll(okPop, otherFallback) === populated, '13. ok w/units + fallback → xlsx wins (not fallback)');

/* Bonus: undefined behaves the same as null */
assert(pickRentRoll(undefined, null) === null, '14. undefined + null → null (undefined ≡ null for absent)');
assert(pickRentRoll(undefined, populated) === populated, '15. undefined + fallback w/units → fallback');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
