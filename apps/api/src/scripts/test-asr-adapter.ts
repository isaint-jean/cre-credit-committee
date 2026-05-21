/**
 * Tests for runAsrAdapter and runAsrAdapterOnDocument.
 *
 *   tsx src/scripts/test-asr-adapter.ts
 *
 * Primary surface: runAsrAdapterOnDocument with synthetic ParsedDocument
 * inputs and mocked AsrAdapterDeps. Sub-extractors make AI calls in
 * production; mocking via DI lets us exercise the adapter's coordination
 * logic without network or model dependency.
 *
 * One outer-function case (#14) exercises the parseDocument-throws boundary
 * with non-PDF bytes. Full real-PDF coverage lives in
 * test-asr-adapter-integration.ts (Step 4 of the resume plan).
 *
 * NOTE on the `?? null` defensive expressions below: same as test-cf-adapter.ts
 * / test-rent-roll-adapter.ts — the codebase's "no ?? / no || numeric
 * defaulting" discipline applies to PRODUCTION code (adapters, composer,
 * orchestration) and not test assertions. Do NOT import this license into
 * adapter or composer code.
 */

import type {
  ASRExtraction,
  ContentHash,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computePropertyMetadataId, computeRentRollId } from '../util/content-hash.js';
import {
  runAsrAdapter,
  runAsrAdapterOnDocument,
  ASR_ADAPTER_VERSION,
  type AsrAdapterDeps,
} from '../services/extraction/adapters/asr.adapter.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------- synthetic input builders ----------------------- */

function makeDoc(): ParsedDocument {
  return {
    fileName: 'test.pdf',
    fileType: 'pdf',
    totalPages: 1,
    rawText: 'PROPERTY DESCRIPTION ...',
    sections: [],
    metadata: { fileSize: 0 },
  };
}

function makeRentRoll(opts: { lines?: number; vacantIdx?: number } = {}): RentRoll {
  const linesCount = opts.lines ?? 2;
  const vacantIdx = opts.vacantIdx ?? 1;
  const lines = Array.from({ length: linesCount }, (_, i) => {
    const occupied = i !== vacantIdx;
    return {
      tenantName: occupied ? `Tenant ${i + 1}` : null,
      suite: i === vacantIdx ? null : `${100 + i}`,
      squareFeet: 1000,
      status: (occupied ? 'OCCUPIED' : 'VACANT') as 'OCCUPIED' | 'VACANT',
      leaseStart: occupied ? '2024-01-01T00:00:00Z' : null,
      leaseEnd: occupied ? '2029-01-01T00:00:00Z' : null,
      inPlaceRentAnnual: occupied ? 36000 : null,
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
    };
  });
  const body = {
    asOfDate: '2026-01-01T00:00:00Z',
    propertyName: 'Test Property',
    source: 'asr_table' as const,
    lines,
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

function makeAsr(): ASRExtraction {
  return {
    impliedValue: 10_000_000,
    impliedCapRate: 0.06,
    underwrittenNOI: 600_000,
  };
}

const A_HASH = 'a'.repeat(64) as ContentHash;

/* ----------------------- console.warn capture helper ---------------------- */

interface WarnCapture {
  readonly warns: string[];
  restore(): void;
}

function captureWarns(): WarnCapture {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]): void => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return { warns, restore: () => { console.warn = orig; } };
}

/* -------------------------------- deps mock ------------------------------- */

type DepBehavior<T> = 'null' | 'throw' | T;

interface DepsOverrides {
  rentRoll?: DepBehavior<RentRoll>;
  propertyMetadata?: DepBehavior<PropertyMetadata>;
  asr?: DepBehavior<ASRExtraction>;
}

function makeDeps(o: DepsOverrides = {}): AsrAdapterDeps {
  const rr = o.rentRoll ?? 'null';
  const pm = o.propertyMetadata ?? 'null';
  const a = o.asr ?? 'null';
  return {
    extractRentRoll: async () => {
      if (rr === 'null') return null;
      if (rr === 'throw') throw new Error('AI service unavailable');
      return rr;
    },
    extractPropertyMetadata: async () => {
      if (pm === 'null') return null;
      if (pm === 'throw') throw new Error('PM AI failed');
      return pm;
    },
    extractAsr: async () => {
      if (a === 'null') return null;
      if (a === 'throw') throw new Error('ASR call failed');
      return a;
    },
  };
}

/* ----------------------------- test cases -------------------------------- */

(async () => {
  /* CASE 1 — three-way happy path (Ticket I prep / v0.2.0+ shape) */
  console.log('1. three-way happy path (mocked extractAsr returns non-null)');
  {
    const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
      rentRoll: makeRentRoll(),
      propertyMetadata: makePropertyMetadata(),
      asr: makeAsr(),
    }));
    assertEqual(o.status, 'ok', '1.1 status ok');
    if (o.status === 'ok') {
      assertEqual(o.sourceRefs.length, 3, '1.2 sourceRefs.length === 3');
      const kinds = o.sourceRefs.map((r) => r.kind).sort();
      assertEqual(kinds.join(','), 'asr,property_metadata,rent_roll', '1.3 kinds sorted match');
      const hashes = new Set(o.sourceRefs.map((r) => r.contentHash));
      assertEqual(hashes.size, 1, '1.4 all three refs share the same contentHash');
      assert(o.value.asr !== null, '1.5 value.asr populated');
      assert(o.value.propertyMetadata !== null, '1.6 value.propertyMetadata populated');
      assert(o.value.rentRollFallback !== null, '1.7 value.rentRollFallback populated');
    }
  }

  /* CASE 2 — v0.1.0 happy path (extractAsr placeholder returns null) */
  console.log('\n2. v0.1.0 happy path (extractAsr=null, others populated)');
  {
    const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
      rentRoll: makeRentRoll(),
      propertyMetadata: makePropertyMetadata(),
    }));
    assertEqual(o.status, 'ok', '2.1 status ok');
    if (o.status === 'ok') {
      assertEqual(o.sourceRefs.length, 2, '2.2 sourceRefs.length === 2');
      const kinds = o.sourceRefs.map((r) => r.kind).sort();
      assertEqual(kinds.join(','), 'property_metadata,rent_roll', '2.3 kinds sorted match');
      assertEqual(o.value.asr, null, '2.4 value.asr null in v0.1.0 shape');
      assert(o.value.propertyMetadata !== null, '2.5 value.propertyMetadata populated');
      assert(o.value.rentRollFallback !== null, '2.6 value.rentRollFallback populated');
    }
    assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '2.7 adapterVersion stamped on ok');
  }

  /* CASE 3 — all-null no-throw */
  console.log('\n3. all three sub-extractors fulfilled with null');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({}));
      assertEqual(o.status, 'empty', '3.1 status empty');
      if (o.status === 'empty') {
        assertEqual(o.sourceRefs.length, 0, '3.2 sourceRefs.length === 0');
        assert(o.reason.length > 0, '3.3 reason populated');
      }
      assertEqual(cap.warns.length, 0, '3.4 zero console.warn calls (no throws)');
      assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '3.5 adapterVersion stamped on empty');
    } finally { cap.restore(); }
  }

  /* CASE 4 — single throw + others null */
  console.log('\n4. extractRentRoll throws, others null');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({ rentRoll: 'throw' }));
      assertEqual(o.status, 'empty', '4.1 status empty (throw collapses, no value)');
      if (o.status === 'empty') {
        assertEqual(o.sourceRefs.length, 0, '4.2 sourceRefs.length === 0');
      }
      assertEqual(cap.warns.length, 1, '4.3 exactly one warn captured');
      const regex = /^\[asr\.adapter\] sub-extractor rejected: AI:RentRoll: AI service unavailable TODO\(observability\)$/;
      assert(regex.test(cap.warns[0] ?? ''), '4.4 warn matches exact grep-format regex');
    } finally { cap.restore(); }
  }

  /* CASE 5 — single throw + others non-null (throw isolated) */
  console.log('\n5. extractRentRoll throws, others populated');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
        rentRoll: 'throw',
        propertyMetadata: makePropertyMetadata(),
        asr: makeAsr(),
      }));
      assertEqual(o.status, 'ok', '5.1 status ok (others succeeded)');
      if (o.status === 'ok') {
        assertEqual(o.value.rentRollFallback, null, '5.2 rentRollFallback null (throw collapsed)');
        assert(o.value.propertyMetadata !== null, '5.3 propertyMetadata populated');
        assert(o.value.asr !== null, '5.4 asr populated');
        const kinds = o.sourceRefs.map((r) => r.kind).sort();
        assertEqual(kinds.join(','), 'asr,property_metadata', '5.5 kinds = asr, property_metadata');
      }
      assertEqual(cap.warns.length, 1, '5.6 one warn captured');
    } finally { cap.restore(); }
  }

  /* CASE 6 — two throws + one non-null */
  console.log('\n6. two throws (rentRoll, propertyMetadata); asr populated');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
        rentRoll: 'throw',
        propertyMetadata: 'throw',
        asr: makeAsr(),
      }));
      assertEqual(o.status, 'ok', '6.1 status ok (one extraction is enough)');
      if (o.status === 'ok') {
        assert(o.value.asr !== null, '6.2 asr populated');
        assertEqual(o.value.propertyMetadata, null, '6.3 propertyMetadata null');
        assertEqual(o.value.rentRollFallback, null, '6.4 rentRollFallback null');
        assertEqual(o.sourceRefs.length, 1, '6.5 sourceRefs.length === 1');
        assertEqual(o.sourceRefs[0]?.kind, 'asr', '6.6 only asr kind');
      }
      assertEqual(cap.warns.length, 2, '6.7 two warns captured');
    } finally { cap.restore(); }
  }

  /* CASE 7 — two throws + one fulfilled-null → empty (NOT failed) */
  console.log('\n7. two throws + one fulfilled-null → empty (NOT failed)');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
        rentRoll: 'throw',
        propertyMetadata: 'throw',
        asr: 'null',
      }));
      assertEqual(o.status, 'empty', '7.1 status empty (one fulfilled, not all rejected)');
      if (o.status === 'empty') {
        assertEqual(o.sourceRefs.length, 0, '7.2 sourceRefs.length === 0');
      }
      assertEqual(cap.warns.length, 2, '7.3 two warns captured (AI:RentRoll + AI:PropertyMetadata)');
    } finally { cap.restore(); }
  }

  /* CASE 8 — all three sub-extractors reject → 'failed' / 'allSubExtractorsThrew'.
   *
   * Reachable as of v0.2.0 (Ticket I #6): DEFAULT_ASR_DEPS.extractAsr is now
   * extractASR, an AI call that can throw on network/API failure. This case
   * exercises the previously dead branch in runAsrAdapterOnDocument that
   * collapses three concurrent throws into one 'failed' outcome. */
  console.log('\n8. all three sub-extractors reject → failed / allSubExtractorsThrew');
  {
    const cap = captureWarns();
    try {
      const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
        rentRoll: 'throw',
        propertyMetadata: 'throw',
        asr: 'throw',
      }));
      assertEqual(o.status, 'failed', '8.1 status failed');
      if (o.status === 'failed') {
        assertEqual(o.error.name, 'allSubExtractorsThrew', '8.2 error.name = allSubExtractorsThrew');
        assert(
          o.error.message.includes('AI service unavailable'),
          '8.3 error.message carries rentRoll cause',
        );
        assert(
          o.error.message.includes('PM AI failed'),
          '8.4 error.message carries propertyMetadata cause',
        );
        assert(
          o.error.message.includes('ASR call failed'),
          '8.5 error.message carries asr cause',
        );
        assert(
          o.error.message.includes(' | '),
          '8.6 error.message joins causes with " | "',
        );
        assertEqual(o.sourceRefs.length, 0, '8.7 sourceRefs empty on all-rejected');
      }
      assertEqual(cap.warns.length, 3, '8.8 three console.warn calls (one per throw)');
      assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '8.9 adapterVersion stamped on failed');
    } finally { cap.restore(); }
  }

  /* CASE 9 — rent-roll projection delegation */
  console.log('\n9. rent-roll projection delegates to projectToRentRollExtraction');
  {
    const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
      rentRoll: makeRentRoll({ lines: 2, vacantIdx: 1 }),
    }));
    assertEqual(o.status, 'ok', '9.1 status ok');
    if (o.status === 'ok' && o.value.rentRollFallback) {
      assertEqual(o.value.rentRollFallback.units.length, 2, '9.2 units.length === 2');
      assertEqual(o.value.rentRollFallback.summary.totalUnits, 2, '9.3 totalUnits === 2');
      assertEqual(o.value.rentRollFallback.summary.occupiedUnits, 1, '9.4 occupiedUnits === 1');
      assertEqual(o.value.rentRollFallback.units[1]?.unitId, 'unit-2', '9.5 unitId synthesized when suite null');
    } else {
      fail('9.x rentRollFallback should be populated for projection check');
    }
  }

  /* CASE 10 — hash passthrough (inner direction) */
  console.log('\n10. hash passthrough — bufferHash → sourceRefs[*].contentHash');
  {
    const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
      rentRoll: makeRentRoll(),
    }));
    if (o.status === 'ok' && o.sourceRefs.length > 0) {
      assertEqual(o.sourceRefs[0]?.contentHash ?? null, A_HASH, '10.1 contentHash matches input bufferHash');
    } else {
      fail('10.x expected ok with sourceRefs');
    }
  }

  /* CASE 12 — durationMs is a non-negative number on every outcome */
  console.log('\n12. durationMs non-negative on ok / empty / failed-via-parse');
  {
    const okO = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({ rentRoll: makeRentRoll() }));
    assert(typeof okO.durationMs === 'number' && okO.durationMs >= 0, '12.1 ok durationMs non-negative');

    const emptyO = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({}));
    assert(typeof emptyO.durationMs === 'number' && emptyO.durationMs >= 0, '12.2 empty durationMs non-negative');

    const failedO = await runAsrAdapter({ buffer: Buffer.from('not a pdf', 'utf8'), filename: 'corrupt.pdf' });
    assert(typeof failedO.durationMs === 'number' && failedO.durationMs >= 0, '12.3 failed durationMs non-negative');
  }

  /* CASE 13 — ASR position v0.1.0 baseline (extractAsr default = null) */
  console.log('\n13. ASR position v0.1.0 baseline — extractAsr-null contract');
  {
    const o = await runAsrAdapterOnDocument(makeDoc(), A_HASH, makeDeps({
      rentRoll: makeRentRoll(),
      propertyMetadata: makePropertyMetadata(),
      asr: 'null',
    }));
    assertEqual(o.status, 'ok', '13.1 status ok');
    if (o.status === 'ok') {
      assertEqual(o.value.asr, null, '13.2 value.asr null when extractAsr returns null');
      const hasAsrKind = o.sourceRefs.some((r) => r.kind === 'asr');
      assertEqual(hasAsrKind, false, '13.3 asr kind NOT in sourceRefs');
    }
  }

  /* CASE 14 — outer-function parseDocument-throws path */
  console.log('\n14. runAsrAdapter: parseDocument throws on non-PDF bytes');
  {
    const corruptBuf = Buffer.from('this is definitely not a real PDF document', 'utf8');
    const o = await runAsrAdapter({ buffer: corruptBuf, filename: 'corrupt.pdf' });
    assertEqual(o.status, 'failed', '14.1 status failed');
    if (o.status === 'failed') {
      assertEqual(o.error.name, 'parseDocumentThrew', '14.2 error.name = parseDocumentThrew');
      assert(o.error.message.length > 0, '14.3 error.message populated');
      assertEqual(o.sourceRefs.length, 0, '14.4 sourceRefs empty on parseDocument-throws');
    }
    assertEqual(o.adapterVersion, ASR_ADAPTER_VERSION, '14.5 adapterVersion stamped on failed');
  }

  /* ------------------------------- summary -------------------------------- */

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
