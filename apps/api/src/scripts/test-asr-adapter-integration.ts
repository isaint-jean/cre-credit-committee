/**
 * Integration tests for runAsrAdapter against the real parseDocument + a
 * pinned PDF fixture.
 *
 *   tsx src/scripts/test-asr-adapter-integration.ts
 *
 * Fixture: apps/api/fixtures/asr-minimal.pdf — synthesized by
 * apps/api/src/scripts/generate-asr-minimal-pdf.ts (byte-deterministic
 * with pinned pdfkit info fields). Regenerate via:
 *
 *   npx tsx apps/api/src/scripts/generate-asr-minimal-pdf.ts
 *
 * After regenerating, UPDATE EXPECTED_FIXTURE_SHA below to match the new
 * hash printed by the generator.
 *
 * Scope: this file covers what unit tests (test-asr-adapter.ts) can't —
 * the parseDocument boundary, the buffer-to-hash flow, durationMs
 * outer-includes-inner ordering, and real-PDF section detection.
 * Sub-extractors are mocked via DI so default-mode runs are deterministic
 * and free of AI cost. The optional E2E mode (case 5, gated on ASR_E2E=1)
 * removes the mocks and exercises the real AI pipeline; caller pays.
 *
 * NOTE on the `?? null` defensive expressions below: same as the other
 * adapter tests — the codebase's "no ?? / no || numeric defaulting"
 * discipline applies to PRODUCTION code (adapters, composer, orchestration)
 * and not test assertions. Do NOT import this license into adapter or
 * composer code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  ContentHash,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computeBufferContentHash, computePropertyMetadataId, computeRentRollId } from '../util/content-hash.js';
import { parseDocument } from '../services/document-parser.service.js';
import {
  runAsrAdapter,
  runAsrAdapterOnDocument,
  ASR_ADAPTER_VERSION,
  type AsrAdapterDeps,
} from '../services/extraction/adapters/asr.adapter.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/asr-minimal.pdf');

/**
 * Pinned hash of apps/api/fixtures/asr-minimal.pdf.
 *
 * This value is printed by generate-asr-minimal-pdf.ts when the fixture is
 * regenerated. If the byte-stability assertion (case 4) fails, EITHER the
 * fixture was modified intentionally (update this constant to the new SHA
 * from the generator's output) OR pdfkit's determinism regressed (see the
 * generator script's header for the fallback discussion).
 */
const EXPECTED_FIXTURE_SHA = 'e13b29c4940d1ce9df0e33144c845aa85b2f1ae26e9fafce8363be0ae8ea5b19';

const E2E_ENABLED = process.env.ASR_E2E === '1' || process.env.ASR_E2E === 'true';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------- synthetic value builders ----------------------- */

function makeRentRoll(): RentRoll {
  const body = {
    asOfDate: '2026-01-01T00:00:00Z',
    propertyName: 'Test Property',
    source: 'asr_table' as const,
    lines: [
      {
        tenantName: 'Tenant 1',
        suite: '100',
        squareFeet: 1000,
        status: 'OCCUPIED' as const,
        leaseStart: '2024-01-01T00:00:00Z',
        leaseEnd: '2029-01-01T00:00:00Z',
        inPlaceRentAnnual: 36000,
        marketRentAnnual: 40000,
        leaseType: 'NNN' as const,
        recoveriesAnnual: null,
        otherIncomeAnnual: null,
        newTiPsf: null,
        renewTiPsf: null,
        newLcPct: null,
        renewLcPct: null,
        downtimeMonths: null,
        notes: null,
      },
    ],
  };
  return { id: computeRentRollId(body), ...body };
}

function makePropertyMetadata(): PropertyMetadata {
  const body = {
    source: 'asr_extraction' as const,
    propertyName: 'Test Property',
    propertySubtype: 'Suburban Office',
    address: '123 Main St',
    city: 'Testville',
    state: 'CA',
    zip: '90000',
    county: null,
    msa: null,
    submarket: null,
    yearBuilt: 2010,
    yearRenovated: null,
    buildingClass: 'B',
    totalSquareFeet: 50000,
    totalUnits: null,
    totalRooms: null,
    totalPads: null,
    occupancyPhysical: 0.92,
    occupancyEconomic: null,
    ownershipInterest: 'Fee Simple',
    numberOfBuildings: 1,
  };
  return { id: computePropertyMetadataId(body), ...body };
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`FATAL: fixture not found at ${FIXTURE}`);
    console.error('Run: npx tsx apps/api/src/scripts/generate-asr-minimal-pdf.ts');
    process.exit(2);
  }

  const buffer = fs.readFileSync(FIXTURE);

  /* CASE 1 — parseDocument happy path on the fixture */
  console.log('1. parseDocument happy path on asr-minimal.pdf');
  {
    const doc = await parseDocument(buffer, 'asr-minimal.pdf', 'application/pdf');
    assert(doc.totalPages >= 1, '1.1 totalPages >= 1');
    assert(doc.sections.length >= 1, '1.2 sections.length >= 1');
    const titles = doc.sections.map((s) => s.title.toUpperCase());
    const hasExpected = titles.some((t) =>
      /EXECUTIVE\s+SUMMARY|PROPERTY\s+DESCRIPTION/.test(t),
    );
    assert(hasExpected, '1.3 detected at least one ASR-style section title');
  }

  /* CASE 2 — runAsrAdapter end-to-end with mocked sub-extractors.
   *
   * The mocked extractRentRoll captures the doc parameter it receives so we
   * can prove that parseDocument's output threaded through to the inner
   * function (not just that the outcome shape is correct). */
  console.log('\n2. runAsrAdapter end-to-end (mocked deps + real parseDocument)');
  {
    let observedDoc: ParsedDocument | null = null;
    const mockRr = makeRentRoll();
    const mockPm = makePropertyMetadata();
    const deps: AsrAdapterDeps = {
      extractRentRoll: async (doc) => {
        observedDoc = doc;
        return mockRr;
      },
      extractPropertyMetadata: async () => mockPm,
      extractAsr: async () => null,
    };

    const o = await runAsrAdapter({ buffer, filename: 'asr-minimal.pdf' }, deps);

    assertEqual(o.status, 'ok', '2.1 status ok');
    if (o.status === 'ok') {
      assertEqual(o.sourceRefs.length, 2, '2.2 sourceRefs.length === 2');
      const kinds = o.sourceRefs.map((r) => r.kind).sort();
      assertEqual(kinds.join(','), 'property_metadata,rent_roll', '2.3 kinds match');

      const expectedHash = computeBufferContentHash(buffer);
      const hashes = new Set(o.sourceRefs.map((r) => r.contentHash));
      assertEqual(hashes.size, 1, '2.4 sourceRefs share a single contentHash');
      assertEqual(o.sourceRefs[0]?.contentHash ?? null, expectedHash, '2.5 contentHash equals computeBufferContentHash(buffer)');
    }

    // Mock-observer assertion: prove parseDocument-to-inner threading.
    // The captured doc must be the real ParsedDocument from parseDocument,
    // not a stub the test passed in directly.
    assert(observedDoc !== null, '2.6 mock received a non-null doc');
    const captured = observedDoc as ParsedDocument | null;
    assert(captured !== null && captured.totalPages >= 1, '2.7 mock received doc with totalPages >= 1 (real ParsedDocument)');
    assert(captured !== null && captured.sections.length >= 1, '2.8 mock received doc with non-empty sections (parseDocument output)');

    assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '2.9 adapterVersion stamped');
  }

  /* CASE 3 — durationMs outer-includes-inner.
   *
   * Inner direct call has only Promise.allSettled time. Outer call adds
   * parseDocument time on top via the (b) decision patch. We assert
   * outer.durationMs >= inner.durationMs.
   *
   * NOTE: Date.now() has millisecond precision. On fast machines parseDocument
   * can complete sub-millisecond against a small fixture, and the rounding
   * boundary can fall either side of the ms tick. A strict outer >= inner
   * therefore flakes (~5% of runs, observed). We absorb the rounding noise
   * with a 1ms tolerance: outer >= inner - 1. The semantic check survives —
   * the adapter's patch (Date.now() - t0 at the end of runAsrAdapter) cannot
   * produce a result LESS than the inner's reported durationMs by more than
   * one ms-rounding boundary. */
  console.log('\n3. durationMs outer >= inner (parseDocument time patched in)');
  {
    const doc = await parseDocument(buffer, 'asr-minimal.pdf', 'application/pdf');
    const bufferHash = computeBufferContentHash(buffer);
    const deps: AsrAdapterDeps = {
      extractRentRoll: async () => makeRentRoll(),
      extractPropertyMetadata: async () => null,
      extractAsr: async () => null,
    };

    const innerO = await runAsrAdapterOnDocument(doc, bufferHash, deps);
    const outerO = await runAsrAdapter({ buffer, filename: 'asr-minimal.pdf' }, deps);

    assert(typeof innerO.durationMs === 'number' && innerO.durationMs >= 0, '3.1 inner durationMs non-negative number');
    assert(typeof outerO.durationMs === 'number' && outerO.durationMs >= 0, '3.2 outer durationMs non-negative number');
    assert(outerO.durationMs >= innerO.durationMs - 1, `3.3 outer durationMs >= inner - 1ms tolerance (outer=${outerO.durationMs}ms, inner=${innerO.durationMs}ms)`);
  }

  /* CASE 4 — fixture byte-stability.
   *
   * Pins the fixture's SHA-256 against EXPECTED_FIXTURE_SHA. If this fails,
   * EITHER the fixture was regenerated intentionally (update the constant)
   * OR pdfkit's determinism regressed. See generate-asr-minimal-pdf.ts for
   * the regen recipe and the fallback discussion. */
  console.log('\n4. fixture byte-stability — SHA pinned to generator output');
  {
    const actualSha = createHash('sha256').update(buffer).digest('hex');
    assertEqual(
      actualSha,
      EXPECTED_FIXTURE_SHA,
      '4.1 fixture SHA matches EXPECTED_FIXTURE_SHA (regenerate via generate-asr-minimal-pdf.ts if intentional)',
    );
  }

  /* CASE 5 — E2E real-pipeline smoke (gated on ASR_E2E=1).
   *
   * When disabled, prints a skip line and continues. When enabled, runs
   * runAsrAdapter with NO deps override — real extractors hit Anthropic.
   * Caller pays for the API calls. Asserts are permissive (status is
   * 'ok' or 'empty') so AI response variance doesn't fail the test. */
  console.log('\n5. E2E real-pipeline smoke (gated on ASR_E2E=1)');
  if (!E2E_ENABLED) {
    console.log('  skip  5.* E2E disabled (set ASR_E2E=1 to enable; caller pays for AI calls)');
  } else {
    const o = await runAsrAdapter({ buffer, filename: 'asr-minimal.pdf' });
    assert(o.status === 'ok' || o.status === 'empty', `5.1 status is 'ok' or 'empty' (got '${o.status}')`);
    assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '5.2 adapterVersion stamped');
    assert(typeof o.durationMs === 'number' && o.durationMs >= 0, '5.3 durationMs non-negative number');
  }

  /* ------------------------------- summary -------------------------------- */

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
