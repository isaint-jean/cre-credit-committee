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

/* Each row asserts BOTH value and source (Ticket D widening). */

/* 1. absent + null fallback → null */
{
  const r = pickRentRoll(null, null);
  assert(r.value === null, '1a. absent + null → value null');
  assert(r.source === null, '1b. absent + null → source null');
}

/* 2. absent + fallback w/ units → fallback */
{
  const r = pickRentRoll(null, populated);
  assert(r.value === populated, '2a. absent + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '2b. absent + fallback w/units → source=asr_fallback');
}

/* 3. absent + fallback w/ empty units → null */
{
  const r = pickRentRoll(null, emptyUnits);
  assert(r.value === null, '3a. absent + fallback empty → value null');
  assert(r.source === null, '3b. absent + fallback empty → source null');
}

/* 4. failed + null → null */
{
  const r = pickRentRoll(failedOutcome(), null);
  assert(r.value === null, '4a. failed + null → value null');
  assert(r.source === null, '4b. failed + null → source null');
}

/* 5. failed + fallback w/ units → fallback */
{
  const r = pickRentRoll(failedOutcome(), populated);
  assert(r.value === populated, '5a. failed + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '5b. failed + fallback w/units → source=asr_fallback');
}

/* 6. failed + fallback empty → null */
{
  const r = pickRentRoll(failedOutcome(), emptyUnits);
  assert(r.value === null, '6a. failed + fallback empty → value null');
  assert(r.source === null, '6b. failed + fallback empty → source null');
}

/* 7. empty + null → null */
{
  const r = pickRentRoll(emptyOutcome(), null);
  assert(r.value === null, '7a. empty + null → value null');
  assert(r.source === null, '7b. empty + null → source null');
}

/* 8. empty + fallback w/ units → fallback */
{
  const r = pickRentRoll(emptyOutcome(), populated);
  assert(r.value === populated, '8a. empty + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '8b. empty + fallback w/units → source=asr_fallback');
}

/* 9. empty + fallback empty → null */
{
  const r = pickRentRoll(emptyOutcome(), emptyUnits);
  assert(r.value === null, '9a. empty + fallback empty → value null');
  assert(r.source === null, '9b. empty + fallback empty → source null');
}

/* 10. ok w/ empty units + null → null */
const okEmptyUnits = okOutcome(emptyUnits);
{
  const r = pickRentRoll(okEmptyUnits, null);
  assert(r.value === null, '10a. ok empty-units + null → value null');
  assert(r.source === null, '10b. ok empty-units + null → source null');
}

/* 11. ok w/ empty units + fallback w/ units → fallback */
{
  const r = pickRentRoll(okEmptyUnits, populated);
  assert(r.value === populated, '11a. ok empty-units + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '11b. ok empty-units + fallback w/units → source=asr_fallback');
}

/* 12. ok w/ units + null → xlsx wins */
const okPop = okOutcome(populated);
{
  const r = pickRentRoll(okPop, null);
  assert(r.value === populated, '12a. ok w/units + null → value=xlsx');
  assert(r.source === 'xlsx', '12b. ok w/units + null → source=xlsx');
}

/* 13. ok w/ units + fallback w/ units → xlsx wins (precedence) */
const otherFallback = makeExtraction([makeUnit('200', true)]);
{
  const r = pickRentRoll(okPop, otherFallback);
  assert(r.value === populated, '13a. ok w/units + fallback → value=xlsx (precedence)');
  assert(r.source === 'xlsx', '13b. ok w/units + fallback → source=xlsx (precedence)');
}

/* Bonus: undefined behaves the same as null */
{
  const r = pickRentRoll(undefined, null);
  assert(r.value === null, '14a. undefined + null → value null');
  assert(r.source === null, '14b. undefined + null → source null');
}
{
  const r = pickRentRoll(undefined, populated);
  assert(r.value === populated, '15a. undefined + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '15b. undefined + fallback w/units → source=asr_fallback');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
