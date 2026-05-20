/**
 * Tests for runRentRollAdapter and projectToRentRollExtraction.
 *
 *   tsx src/scripts/test-rent-roll-adapter.ts
 *
 * No on-disk fixture: we synthesize rent-roll xlsx buffers in-memory using
 * ExcelJS (same approach as the empty/failed paths in test-cf-adapter.ts).
 * Pattern: tsx + ok/fail/assert/assertEqual, exit code = failure count, no
 * vitest/jest.
 *
 * Two test surfaces:
 *
 *   1. projectToRentRollExtraction — pure function unit tests on synthetic
 *      RentRoll bodies. Asserts field-level mapping, lossy projection
 *      correctness, unitId synthesis, summary counts, and null fidelity.
 *
 *   2. runRentRollAdapter — end-to-end tests on synthesized xlsx buffers.
 *      Asserts status mapping (ok/empty/failed), sourceRef emission, hash
 *      determinism, and adapterVersion stamping.
 *
 * NOTE on the `?? null` defensive expressions below: same as test-cf-adapter.ts —
 * the codebase's "no ?? / no || numeric defaulting" discipline applies to PRODUCTION
 * code, not test assertions. Here `?? null` is purely defensive against the optional
 * chain returning `undefined` when the field is null, so we can compare null===null.
 * Do NOT import this license into adapter or composer code.
 */

import ExcelJS from 'exceljs';
import type { RentRoll } from '@cre/contracts';
import { computeRentRollId } from '../util/content-hash.js';
import {
  runRentRollAdapter,
  projectToRentRollExtraction,
  RENT_ROLL_ADAPTER_VERSION,
} from '../services/extraction/adapters/rent-roll.adapter.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

function buildRentRoll(lines: RentRoll['lines']): RentRoll {
  const body = {
    asOfDate: '2026-01-01T00:00:00Z' as const,
    propertyName: 'Test Property',
    source: 'rent_roll_file' as const,
    lines,
  };
  return { id: computeRentRollId(body), ...body };
}

async function buildRentRollXlsxBuffer(args: {
  withHeader: boolean;
  rows: Array<{ tenant: string; suite: string | null; sf: number; status: string; rentAnnual: number | null }>;
  includeTotalsRow?: boolean;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rent Roll');
  if (args.withHeader) {
    ws.addRow(['Tenant Name', 'Suite', 'SF', 'Status', 'In-Place Rent']);
    for (const row of args.rows) {
      ws.addRow([row.tenant, row.suite === null ? '' : row.suite, row.sf, row.status, row.rentAnnual === null ? '' : row.rentAnnual]);
    }
    if (args.includeTotalsRow) {
      ws.addRow(['Total', '', 100000, '', 12000000]);
    }
  } else {
    ws.addRow(['just some non-rent-roll content', 'foo', 'bar']);
    ws.addRow(['another line', 'baz', '']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

(async () => {
  /* ============================ PROJECTION TESTS =========================== */

  console.log('projectToRentRollExtraction — field-level mapping:');

  const rr = buildRentRoll([
    {
      tenantName: 'Acme Corp', suite: '100', squareFeet: 1500, status: 'OCCUPIED',
      leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2029-01-01T00:00:00Z',
      inPlaceRentAnnual: 36000, marketRentAnnual: 40000, leaseType: 'NNN',
      recoveriesAnnual: 5000, otherIncomeAnnual: 0,
      newTiPsf: 25, renewTiPsf: 10, newLcPct: 0.06, renewLcPct: 0.03,
      downtimeMonths: 3, notes: 'corner suite',
    },
    {
      tenantName: null, suite: null, squareFeet: 2000, status: 'VACANT',
      leaseStart: null, leaseEnd: null,
      inPlaceRentAnnual: null, marketRentAnnual: 48000, leaseType: 'UNKNOWN',
      recoveriesAnnual: null, otherIncomeAnnual: null,
      newTiPsf: null, renewTiPsf: null, newLcPct: null, renewLcPct: null,
      downtimeMonths: null, notes: null,
    },
    {
      tenantName: 'Future Tenant', suite: '200', squareFeet: 1200, status: 'PRELEASED',
      leaseStart: '2026-07-01T00:00:00Z', leaseEnd: '2031-07-01T00:00:00Z',
      inPlaceRentAnnual: 24000, marketRentAnnual: 26000, leaseType: 'NNN',
      recoveriesAnnual: 3000, otherIncomeAnnual: 0,
      newTiPsf: 20, renewTiPsf: 0, newLcPct: 0.06, renewLcPct: 0,
      downtimeMonths: 0, notes: null,
    },
  ]);

  const extraction = projectToRentRollExtraction(rr);

  /* Units count */
  assertEqual(extraction.units.length, 3, 'units.length matches lines.length');

  /* Unit 0 — direct passthrough, OCCUPIED, integer-divisible rent */
  const u0 = extraction.units[0]!;
  assertEqual(u0.unitId, '100', 'u0.unitId = legacy suite when non-null');
  assertEqual(u0.tenantName, 'Acme Corp', 'u0.tenantName direct passthrough');
  assertEqual(u0.leaseStart, '2024-01-01T00:00:00Z', 'u0.leaseStart direct passthrough');
  assertEqual(u0.leaseEnd, '2029-01-01T00:00:00Z', 'u0.leaseEnd direct passthrough');
  assertEqual(u0.occupied, true, 'u0.occupied = true when status OCCUPIED');
  assertEqual(u0.inPlaceRentMonthly, 3000, 'u0.inPlaceRentMonthly = inPlaceRentAnnual / 12 (36000/12 = 3000)');
  assertEqual(u0.baseRentMonthly, null, 'u0.baseRentMonthly null (no legacy source)');
  assertEqual(u0.concessions, null, 'u0.concessions null (no legacy source)');
  assertEqual(u0.securityDeposit, null, 'u0.securityDeposit null (no legacy source)');

  /* Unit 1 — synthesized unitId, vacant, null preservation on annual rent */
  const u1 = extraction.units[1]!;
  assertEqual(u1.unitId, 'unit-2', 'u1.unitId synthesized as unit-2 when legacy suite null');
  assertEqual(u1.tenantName, null, 'u1.tenantName null preserved');
  assertEqual(u1.occupied, false, 'u1.occupied = false when status VACANT');
  assertEqual(u1.inPlaceRentMonthly, null, 'u1.inPlaceRentMonthly null when inPlaceRentAnnual null (null fidelity)');
  assertEqual(u1.leaseStart, null, 'u1.leaseStart null preserved');
  assertEqual(u1.leaseEnd, null, 'u1.leaseEnd null preserved');

  /* Unit 2 — PRELEASED collapses to occupied:false (lossy, documented) */
  const u2 = extraction.units[2]!;
  assertEqual(u2.unitId, '200', 'u2.unitId direct from legacy suite');
  assertEqual(u2.occupied, false, 'u2.occupied = false when status PRELEASED (lossy projection)');
  assertEqual(u2.inPlaceRentMonthly, 2000, 'u2.inPlaceRentMonthly = 24000 / 12 = 2000');

  /* Summary */
  assertEqual(extraction.summary.totalUnits, 3, 'summary.totalUnits = lines.length');
  assertEqual(extraction.summary.occupiedUnits, 1, 'summary.occupiedUnits counts ONLY OCCUPIED status (not PRELEASED)');
  assertEqual(extraction.summary.economicOccupancy, null, 'summary.economicOccupancy is null (not synthesized)');

  /* Empty rent roll */
  console.log('\nprojectToRentRollExtraction — empty input:');
  const empty = projectToRentRollExtraction(buildRentRoll([]));
  assertEqual(empty.units.length, 0, 'empty input → empty units');
  assertEqual(empty.summary.totalUnits, 0, 'empty.summary.totalUnits = 0');
  assertEqual(empty.summary.occupiedUnits, 0, 'empty.summary.occupiedUnits = 0');
  assertEqual(empty.summary.economicOccupancy, null, 'empty.summary.economicOccupancy null');

  /* ============================== ADAPTER TESTS ============================ */

  console.log('\nrunRentRollAdapter — synthesized rent roll (happy path):');
  const happyBuf = await buildRentRollXlsxBuffer({
    withHeader: true,
    rows: [
      { tenant: 'Acme Corp', suite: '100', sf: 1500, status: 'Occupied', rentAnnual: 36000 },
      { tenant: 'Tenant B',  suite: '101', sf: 1200, status: 'Vacant',   rentAnnual: null  },
      { tenant: 'Tenant C',  suite: '102', sf: 800,  status: 'Occupied', rentAnnual: 24000 },
    ],
    includeTotalsRow: true,
  });

  const outcome = await runRentRollAdapter({ buffer: happyBuf, filename: 'rent-roll.xlsx' });
  assertEqual(outcome.status, 'ok', 'status is "ok" when tenant rows extracted');
  assertEqual(outcome.adapterVersion, RENT_ROLL_ADAPTER_VERSION, 'adapterVersion stamped');
  assert(outcome.durationMs >= 0, 'durationMs non-negative');

  if (outcome.status === 'ok') {
    assertEqual(outcome.value.units.length, 3, '3 tenant rows extracted (totals row skipped by parser)');
    assertEqual(outcome.value.summary.totalUnits, 3, 'summary.totalUnits = 3');
    assertEqual(outcome.value.summary.occupiedUnits, 2, 'summary.occupiedUnits = 2');

    assertEqual(outcome.sourceRefs.length, 1, 'one sourceRef (single physical document, single semantic kind)');
    assertEqual(outcome.sourceRefs[0]?.kind, 'rent_roll', "sourceRef kind is 'rent_roll'");

    /* Determinism */
    const outcome2 = await runRentRollAdapter({ buffer: happyBuf, filename: 'rent-roll.xlsx' });
    if (outcome2.status === 'ok') {
      assertEqual(
        outcome2.sourceRefs[0]?.contentHash ?? null,
        outcome.sourceRefs[0]?.contentHash ?? null,
        'contentHash deterministic across re-runs on same buffer',
      );
    } else {
      fail(`re-run expected status "ok", got "${outcome2.status}"`);
    }
  }

  /* Empty: header row recognized, no tenant rows */
  console.log('\nrunRentRollAdapter — header but no tenant rows (status "empty"):');
  const headerOnlyBuf = await buildRentRollXlsxBuffer({ withHeader: true, rows: [] });
  const emptyOutcome = await runRentRollAdapter({ buffer: headerOnlyBuf, filename: 'header-only.xlsx' });
  assertEqual(emptyOutcome.status, 'empty', 'status is "empty" when header found but no tenants');
  if (emptyOutcome.status === 'empty') {
    assertEqual(emptyOutcome.sourceRefs.length, 0, 'sourceRefs empty on empty outcome');
    assert(emptyOutcome.reason.length > 0, 'reason is populated');
    assertEqual(emptyOutcome.adapterVersion, RENT_ROLL_ADAPTER_VERSION, 'adapterVersion stamped on empty');
  }

  /* Failed: workbook with no recognizable header (parser throws) */
  console.log('\nrunRentRollAdapter — workbook with no rent-roll header (status "failed"):');
  const noHeaderBuf = await buildRentRollXlsxBuffer({ withHeader: false, rows: [] });
  const noHeaderOutcome = await runRentRollAdapter({ buffer: noHeaderBuf, filename: 'no-header.xlsx' });
  assertEqual(noHeaderOutcome.status, 'failed', 'status is "failed" when parser throws (no recognizable header)');
  if (noHeaderOutcome.status === 'failed') {
    assertEqual(noHeaderOutcome.sourceRefs.length, 0, 'sourceRefs empty on failed outcome (no header)');
    assert(noHeaderOutcome.error.message.length > 0, 'error.message populated');
    assertEqual(noHeaderOutcome.adapterVersion, RENT_ROLL_ADAPTER_VERSION, 'adapterVersion stamped on failure');
  }

  /* Failed: corrupt buffer */
  console.log('\nrunRentRollAdapter — non-xlsx bytes (status "failed"):');
  const corruptBuf = Buffer.from('this is not a real xlsx file at all', 'utf8');
  const corruptOutcome = await runRentRollAdapter({ buffer: corruptBuf, filename: 'corrupt.xlsx' });
  assertEqual(corruptOutcome.status, 'failed', 'status is "failed" when wb.xlsx.load throws');
  if (corruptOutcome.status === 'failed') {
    assertEqual(corruptOutcome.sourceRefs.length, 0, 'sourceRefs empty on corrupt-buffer failure');
    assert(corruptOutcome.error.name.length > 0, 'error.name populated');
    assert(corruptOutcome.error.message.length > 0, 'error.message populated');
  }

  /* Summary */
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
