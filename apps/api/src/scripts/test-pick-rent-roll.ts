/**
 * Tests for pickRentRoll — the rent-roll precedence policy used by
 * buildExtractionResult. Pure function over outcome-shape inputs;
 * exhaustively covers the 13-row truth table from the orchestration scoping.
 *
 *   tsx src/scripts/test-pick-rent-roll.ts
 */

import type { ContentHash, RentRoll, RentRollExtraction, RentRollUnit } from '@cre/contracts';
import type { ExtractorOutcome } from '../services/extraction/extractor-outcome.js';
import { pickRentRoll } from '../services/extraction/pick-rent-roll.js';
import type { RentRollAdapterValue } from '../services/extraction/adapters/rent-roll.adapter.js';
import { computeRentRollId } from '../util/content-hash.js';

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

/* Phase 1 (rent-roll-node): pickRentRoll now consumes ExtractorOutcome<RentRollAdapterValue>
 * (projection + typed) on the xlsx side. Tests synthesize a minimal typed RentRoll
 * whose id is computed from the body — the typed shape is then surfaced on the
 * pick result. The body content is irrelevant to the pick policy; it only needs
 * to be id-consistent. */
function makeTypedRentRoll(label: string): RentRoll {
  const body = {
    asOfDate: '2026-01-01T00:00:00Z' as const,
    propertyName: label,
    source: 'rent_roll_file' as const,
    lines: [],
  };
  return { id: computeRentRollId(body), ...body };
}

function okOutcome(projection: RentRollExtraction, typed: RentRoll): ExtractorOutcome<RentRollAdapterValue> {
  return {
    status: 'ok',
    value: { projection, typed },
    sourceRefs: [{ kind: 'rent_roll', contentHash: HASH }],
    adapterVersion: '0.1.0',
    durationMs: 1,
  };
}

function emptyOutcome(): ExtractorOutcome<RentRollAdapterValue> {
  return {
    status: 'empty',
    sourceRefs: [],
    adapterVersion: '0.1.0',
    durationMs: 1,
    reason: 'no tenant rows',
  };
}

function failedOutcome(): ExtractorOutcome<RentRollAdapterValue> {
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
const xlsxTyped = makeTypedRentRoll('xlsx-source');
const asrTyped = makeTypedRentRoll('asr-source');

console.log('pickRentRoll truth table:');

/* Each row asserts value, source, AND typed (Phase 1 (rent-roll-node) widening). */

/* 1. absent + null fallback → null */
{
  const r = pickRentRoll(null, null);
  assert(r.value === null, '1a. absent + null → value null');
  assert(r.source === null, '1b. absent + null → source null');
  assert(r.typed === null, '1c. absent + null → typed null');
}

/* 2. absent + fallback w/ units → fallback */
{
  const r = pickRentRoll(null, populated, asrTyped);
  assert(r.value === populated, '2a. absent + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '2b. absent + fallback w/units → source=asr_fallback');
  assert(r.typed === asrTyped, '2c. absent + fallback → typed=asrTyped');
}

/* 3. absent + fallback w/ empty units → null */
{
  const r = pickRentRoll(null, emptyUnits, asrTyped);
  assert(r.value === null, '3a. absent + fallback empty → value null');
  assert(r.source === null, '3b. absent + fallback empty → source null');
  assert(r.typed === null, '3c. absent + fallback empty → typed null (fallback rejected)');
}

/* 4. failed + null → null */
{
  const r = pickRentRoll(failedOutcome(), null);
  assert(r.value === null, '4a. failed + null → value null');
  assert(r.source === null, '4b. failed + null → source null');
  assert(r.typed === null, '4c. failed + null → typed null');
}

/* 5. failed + fallback w/ units → fallback */
{
  const r = pickRentRoll(failedOutcome(), populated, asrTyped);
  assert(r.value === populated, '5a. failed + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '5b. failed + fallback w/units → source=asr_fallback');
  assert(r.typed === asrTyped, '5c. failed + fallback → typed=asrTyped');
}

/* 6. failed + fallback empty → null */
{
  const r = pickRentRoll(failedOutcome(), emptyUnits, asrTyped);
  assert(r.value === null, '6a. failed + fallback empty → value null');
  assert(r.source === null, '6b. failed + fallback empty → source null');
  assert(r.typed === null, '6c. failed + fallback empty → typed null');
}

/* 7. empty + null → null */
{
  const r = pickRentRoll(emptyOutcome(), null);
  assert(r.value === null, '7a. empty + null → value null');
  assert(r.source === null, '7b. empty + null → source null');
  assert(r.typed === null, '7c. empty + null → typed null');
}

/* 8. empty + fallback w/ units → fallback */
{
  const r = pickRentRoll(emptyOutcome(), populated, asrTyped);
  assert(r.value === populated, '8a. empty + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '8b. empty + fallback w/units → source=asr_fallback');
  assert(r.typed === asrTyped, '8c. empty + fallback → typed=asrTyped');
}

/* 9. empty + fallback empty → null */
{
  const r = pickRentRoll(emptyOutcome(), emptyUnits, asrTyped);
  assert(r.value === null, '9a. empty + fallback empty → value null');
  assert(r.source === null, '9b. empty + fallback empty → source null');
  assert(r.typed === null, '9c. empty + fallback empty → typed null');
}

/* 10. ok w/ empty units + null → null */
const okEmptyUnits = okOutcome(emptyUnits, xlsxTyped);
{
  const r = pickRentRoll(okEmptyUnits, null);
  assert(r.value === null, '10a. ok empty-units + null → value null');
  assert(r.source === null, '10b. ok empty-units + null → source null');
  assert(r.typed === null, '10c. ok empty-units + null → typed null (xlsx rejected for empty units)');
}

/* 11. ok w/ empty units + fallback w/ units → fallback */
{
  const r = pickRentRoll(okEmptyUnits, populated, asrTyped);
  assert(r.value === populated, '11a. ok empty-units + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '11b. ok empty-units + fallback w/units → source=asr_fallback');
  assert(r.typed === asrTyped, '11c. ok empty-units + fallback → typed=asrTyped');
}

/* 12. ok w/ units + null → xlsx wins */
const okPop = okOutcome(populated, xlsxTyped);
{
  const r = pickRentRoll(okPop, null);
  assert(r.value === populated, '12a. ok w/units + null → value=xlsx');
  assert(r.source === 'xlsx', '12b. ok w/units + null → source=xlsx');
  assert(r.typed === xlsxTyped, '12c. ok w/units + null → typed=xlsxTyped');
}

/* 13. ok w/ units + fallback w/ units → xlsx wins (precedence) */
const otherFallback = makeExtraction([makeUnit('200', true)]);
{
  const r = pickRentRoll(okPop, otherFallback, asrTyped);
  assert(r.value === populated, '13a. ok w/units + fallback → value=xlsx (precedence)');
  assert(r.source === 'xlsx', '13b. ok w/units + fallback → source=xlsx (precedence)');
  assert(r.typed === xlsxTyped, '13c. ok w/units + fallback → typed=xlsxTyped (precedence)');
}

/* Bonus: undefined behaves the same as null */
{
  const r = pickRentRoll(undefined, null);
  assert(r.value === null, '14a. undefined + null → value null');
  assert(r.source === null, '14b. undefined + null → source null');
  assert(r.typed === null, '14c. undefined + null → typed null');
}
{
  const r = pickRentRoll(undefined, populated, asrTyped);
  assert(r.value === populated, '15a. undefined + fallback w/units → value=fallback');
  assert(r.source === 'asr_fallback', '15b. undefined + fallback w/units → source=asr_fallback');
  assert(r.typed === asrTyped, '15c. undefined + fallback → typed=asrTyped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
