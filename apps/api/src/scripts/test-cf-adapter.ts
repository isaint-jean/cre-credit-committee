/**
 * Tests for runCfAdapter.
 *
 *   npm run test:cf-adapter   (wire in apps/api/package.json: tsx src/scripts/test-cf-adapter.ts)
 *
 * Fixture: apps/api/fixtures/sunroad-centrum-cf.xlsx — same Sunroad Centrum Seller CF
 * Preliminary 2023-07-25 used by test-extract-cash-flow-from-xlsx.ts. We verify the
 * adapter wraps the extractor without transforming its output and that ExtractorOutcome
 * envelope semantics are honored for ok / empty / failed paths.
 *
 * Pattern mirrors test-extract-cash-flow-from-xlsx.ts and test-extraction-contract.ts:
 *   tsx + ok/fail/assert/assertEqual, exit code = failure count, no vitest/jest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCashFlowFromXlsx } from '../services/extract-cash-flow-from-xlsx.js';
import { runCfAdapter, CF_ADAPTER_VERSION } from '../services/extraction/adapters/cf.adapter.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/sunroad-centrum-cf.xlsx');

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`FATAL: fixture not found at ${FIXTURE}`);
    process.exit(2);
  }

  const sunroadBuf = fs.readFileSync(FIXTURE);

  /* ----------------------- happy path: Sunroad fixture ---------------------- */

  console.log('runCfAdapter — Sunroad CF (happy path, both columns):');
  const outcome = await runCfAdapter({ buffer: sunroadBuf, filename: 'sunroad-centrum-cf.xlsx' });

  assertEqual(outcome.status, 'ok', 'status is "ok" when both columns extract cleanly');
  assertEqual(outcome.adapterVersion, CF_ADAPTER_VERSION, 'adapterVersion stamped');
  assert(outcome.durationMs >= 0, 'durationMs non-negative');

  if (outcome.status === 'ok') {
    /* Value carries both columns. */
    assert(outcome.value.t12 !== null, 'value.t12 populated');
    assert(outcome.value.sellerUwOperatingStatement !== null, 'value.sellerUwOperatingStatement populated');

    /* Adapter does not transform: outcome.value === extractor output, field by field.
       We compare against a fresh, independent extractor call on the same buffer.

       NOTE on the `?? null` below: the codebase's "no ?? / no || numeric defaulting"
       discipline (see ingest-extraction-result.ts header) applies to PRODUCTION code
       — adapters, composer, orchestration — where it preserves null fidelity. In test
       assertions, `?? null` here is purely defensive against the optional-chain
       returning `undefined` when the field is null; we then compare null===null.
       This is a test-only pattern. Do not import this license into adapter or composer code. */
    const raw = await extractCashFlowFromXlsx(sunroadBuf);
    assertEqual(outcome.value.t12?.noi ?? null, raw.t12?.noi ?? null, 'value.t12.noi matches raw extractor output (no transformation)');
    assertEqual(
      outcome.value.sellerUwOperatingStatement?.noi ?? null,
      raw.sellerUwOperatingStatement?.noi ?? null,
      'value.sellerUwOperatingStatement.noi matches raw extractor output',
    );

    /* Dual-kind sourceRefs: two entries, same hash, distinct kinds. */
    assertEqual(outcome.sourceRefs.length, 2, 'two sourceRefs (both columns populated)');
    const kinds = outcome.sourceRefs.map((r) => r.kind).sort();
    assertEqual(kinds.join(','), 'seller_uw,t12', 'sourceRefs kinds are exactly t12 and seller_uw');
    const hashes = new Set(outcome.sourceRefs.map((r) => r.contentHash));
    assertEqual(hashes.size, 1, 'both refs share the same contentHash (same physical document)');

    /* Hash is deterministic: re-running the adapter on the same buffer reproduces the hash. */
    const outcome2 = await runCfAdapter({ buffer: sunroadBuf, filename: 'sunroad-centrum-cf.xlsx' });
    if (outcome2.status === 'ok') {
      assertEqual(
        outcome2.sourceRefs[0]?.contentHash ?? null,
        outcome.sourceRefs[0]?.contentHash ?? null,
        'sourceRefs[0].contentHash is deterministic across runs on the same buffer',
      );
    } else {
      fail(`re-run expected status "ok", got "${outcome2.status}"`);
    }
  }

  /* ------------------------- empty: unrecognizable workbook ----------------- */

  console.log('\nrunCfAdapter — unrecognizable xlsx (status "empty"):');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['just a label', '', '', '']);
  ws.addRow(['', '', '', '']);
  const emptyBuf = Buffer.from(await wb.xlsx.writeBuffer());

  const emptyOutcome = await runCfAdapter({ buffer: emptyBuf, filename: 'unrecognizable.xlsx' });
  assertEqual(emptyOutcome.status, 'empty', 'status is "empty" when no CF structure detected');
  if (emptyOutcome.status === 'empty') {
    assertEqual(emptyOutcome.sourceRefs.length, 0, 'sourceRefs is empty (nothing extracted to attribute)');
    assert(emptyOutcome.reason.length > 0, 'reason is non-empty');
    assertEqual(emptyOutcome.adapterVersion, CF_ADAPTER_VERSION, 'adapterVersion stamped on empty');
  }

  /* ------------------------- failed: corrupt buffer ------------------------- */

  console.log('\nrunCfAdapter — non-xlsx bytes (status "failed"):');
  const corruptBuf = Buffer.from('this is not a real xlsx file at all', 'utf8');
  const failedOutcome = await runCfAdapter({ buffer: corruptBuf, filename: 'corrupt.xlsx' });

  assertEqual(failedOutcome.status, 'failed', 'status is "failed" when xlsx parse throws');
  if (failedOutcome.status === 'failed') {
    assertEqual(failedOutcome.sourceRefs.length, 0, 'sourceRefs is empty on failed (could not parse)');
    assert(failedOutcome.error.name.length > 0, 'error.name is populated');
    assert(failedOutcome.error.message.length > 0, 'error.message is populated');
    assertEqual(failedOutcome.adapterVersion, CF_ADAPTER_VERSION, 'adapterVersion stamped on failure');
  }

  /* ----------------------------- summary ------------------------------------ */

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
