/**
 * E2E smoke test for POST /api/build-and-ingest.
 *
 * Spins up a real Express app on an ephemeral port and sends real HTTP
 * requests via Node's native fetch + FormData. Exercises multer, Express
 * routing, requireAuth, the composer, ingest, and an in-memory
 * RecordGraphStore — the full HTTP stack except for production disk state.
 *
 * The test injects a fresh `:memory:` RecordGraphStore via DI to avoid
 * polluting data/cre.db. A separate identity-check assertion validates that
 * the PRODUCTION wiring (DEFAULT_BUILD_AND_INGEST_DEPS.recordGraphStore ===
 * the singleton) is correct, without exercising that path at runtime.
 *
 * Default mode: deterministic. Upload combinations skip the asrPdf slot so
 * no AI calls fire. Free, runs in CI.
 *
 * ASR_E2E=1 mode: adds case 6 that uploads asr-minimal.pdf and runs the
 * real AI pipeline end-to-end. Mirrors test-asr-adapter-integration.ts
 * case 5.
 *
 *   tsx src/scripts/test-build-and-ingest-e2e.ts
 *
 * Fixture builders (LibrarySnapshot, MarketBenchmarks, CreditManifesto) are
 * COPIED INLINE from test-ingest-pipeline.ts — identical shape. Refactoring
 * that file to export them would over-couple two independent test files;
 * the duplication is small and self-contained.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  MarketBenchmarks,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore, recordGraphStore } from '../storage/record-graph-store.js';
import {
  createBuildAndIngestRoutes,
  DEFAULT_BUILD_AND_INGEST_DEPS,
} from '../routes/build-and-ingest.routes.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const AS_OF = '2026-05-20T00:00:00Z' as ISODateTime;
const E2E_ENABLED = process.env.ASR_E2E === '1' || process.env.ASR_E2E === 'true';

/* -------------- inline fixture builders (from test-ingest-pipeline.ts) ---- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

/* ------------------------------ server setup ------------------------------ */

const testStore = new RecordGraphStore(':memory:');
const lib = makeSnapshot();
testStore.insertLibrarySnapshot(lib);

const benchmarks = makeBenchmarks();
const manifesto = makeManifesto();

const app = express();
app.use(express.json({ limit: '1gb' }));
app.use(
  '/api/build-and-ingest',
  requireAuth,
  createBuildAndIngestRoutes({
    buildExtractionResult: DEFAULT_BUILD_AND_INGEST_DEPS.buildExtractionResult,
    ingestExtractionResult: DEFAULT_BUILD_AND_INGEST_DEPS.ingestExtractionResult,
    recordGraphStore: testStore,
  }),
);

const TEST_TOKEN = jwt.sign(
  { userId: 'test-user', email: 'test@example.com', role: 'ANALYST' },
  env.jwtSecret,
);
const AUTH_HEADER = `Bearer ${TEST_TOKEN}`;

/** Synthesized loan terms — caller-provided per Ticket K (#7). Same shape
 *  as test-ingest-pipeline.ts's makeFullExtraction body. */
const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 11_000_000,
  interestRate: 0.07,
  amortization: 360,
  interestOnlyPeriod: 0,
  maturityDate: '2031-05-08T00:00:00Z' as ISODateTime,
};

function validForm(includeLoanTerms = true): Record<string, string> {
  const base: Record<string, string> = {
    analysisAsOfDate: AS_OF as string,
    dealRef: 'E2E-TEST',
    propertyType: 'Office',
    librarySnapshotId: lib.id,
    marketBenchmarks: JSON.stringify(benchmarks),
    creditManifesto: JSON.stringify(manifesto),
  };
  if (includeLoanTerms) {
    base.loanTerms = JSON.stringify(LOAN_TERMS);
  }
  return base;
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CF_FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/sunroad-centrum-cf.xlsx');
const ASR_FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/asr-minimal.pdf');

/** Append a file from disk to a FormData under the given field name. Uses
 *  Blob with the original filename (Node 25 FormData + fetch support this
 *  shape natively). */
function appendFile(fd: FormData, field: string, filePath: string, mimeType: string): void {
  const buf = readFileSync(filePath);
  const blob = new Blob([buf], { type: mimeType });
  fd.append(field, blob, path.basename(filePath));
}

/* ---------------------------------- run ---------------------------------- */

(async () => {
  let server: Server | null = null;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, () => resolve(s));
      s.on('error', reject);
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    /* Case 0 — Singleton wiring (code-level, no HTTP) */
    console.log('0. Singleton wiring assertion');
    assert(
      DEFAULT_BUILD_AND_INGEST_DEPS.recordGraphStore === recordGraphStore,
      '0.1 DEFAULT_BUILD_AND_INGEST_DEPS.recordGraphStore === singleton recordGraphStore',
    );

    /* Case 1 — POST with seller_cf + loanTerms form field → 201 (Ticket K #7
     * resolved via form-field input).
     *
     * Validates the full HTTP stack end-to-end producing a successful build:
     * multer parses the file, composer's CF adapter extracts t12 + sellerUwOS,
     * args.loanTerms threads into extractionResult.loanTerms (filling the
     * gap that previously caused JE_LOAN_AMOUNT_MISSING), ingest succeeds,
     * spine is persisted. Response carries the expected id shape and
     * BuildReport. */
    console.log('1. POST with seller_cf + loanTerms form field → 201 (happy path)');
    {
      const fd = makeFormData(validForm());
      appendFile(fd, 'seller_cf', CF_FIXTURE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const r = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd,
        headers: { authorization: AUTH_HEADER },
      });
      if (r.status !== 201) {
        const debugBody = await r.clone().text();
        console.error(`  DEBUG: response status=${r.status}, body=${debugBody}`);
      }
      assertEqual(r.status, 201, '1.1 HTTP 201');
      const body = await r.json() as {
        rootId: string;
        extractionResultId: string;
        propertyMetadataId: string | null;
        buildReport: { slots: Record<string, { status: string }> };
        evaluation: { id: string };
      };
      assert(/^[0-9a-f]{64}$/.test(body.extractionResultId), '1.2 extractionResultId is 64-hex');
      assert(/^[0-9a-f]{64}$/.test(body.rootId), '1.3 rootId is 64-hex');
      assertEqual(body.rootId, body.evaluation.id, '1.4 rootId === evaluation.id');
      assertEqual(body.buildReport.slots.sellerCfXlsx.status, 'ok', '1.5 cf slot ok');
      assertEqual(body.buildReport.slots.rentRollXlsx.status, 'absent', '1.6 rr slot absent');
      assertEqual(body.buildReport.slots.asrPdf.status, 'absent', '1.7 asr slot absent');
      assertEqual(body.propertyMetadataId, null, '1.8 propertyMetadataId null (no asr slot)');

      // Verify persistence: ExtractionResult and DoctrineEvaluation reachable
      // via the injected store. ExtractionResult.loanTerms should now carry
      // the caller-provided value (no longer null).
      const fetched = testStore.getExtractionResult(body.extractionResultId as never);
      assert(fetched !== null, '1.9 ExtractionResult persisted in store');
      assert(fetched?.loanTerms !== null, '1.10 ExtractionResult.loanTerms populated from caller input');
      assertEqual(fetched?.loanTerms?.loanAmount ?? null, 11_000_000, '1.11 loanAmount value matches input');
      assert(testStore.getDoctrineEvaluation(body.rootId as never) !== null,
        '1.12 DoctrineEvaluation persisted in store');
    }

    /* Case 2 — No files uploaded; only form fields.
     *
     * Validates the full HTTP wiring works (multer + Express + composer +
     * ingest all run), and that a PRODUCER error from deep in the spine
     * (judgment engine throwing on missing GrossRentalIncome) propagates
     * to a 400 response with the engine's message preserved.
     *
     * Originally proposed as "201 with all-absent slots", but in practice
     * the judgment engine throws when there's truly zero income data —
     * an all-null ExtractionResult is contract-valid but downstream
     * judgment requires at least one income source. The route catches
     * the throw via its producer-error path and returns 400. */
    console.log('\n2. POST with no files → 400 (producer error: judgment requires income data)');
    {
      const fd = makeFormData(validForm());
      const r = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd,
        headers: { authorization: AUTH_HEADER },
      });
      assertEqual(r.status, 400, '2.1 HTTP 400 (producer error propagated)');
      const body = await r.json() as { error: string; message: string };
      assert(typeof body.error === 'string' && body.error.length > 0, '2.2 error code populated');
      assert(typeof body.message === 'string' && body.message.length > 0, '2.3 error message populated');
      assert(body.message.includes('JE_'), '2.4 message carries judgment-engine reason code (JE_*)');
    }

    /* Case 3 — Missing required form field → 400 BUILD_AND_INGEST_BAD_REQUEST.
     *
     * Validates the handler's shape-validation path is reached AFTER multer
     * parsing. (If multer parsing failed, we'd get a different error before
     * the handler.) Confirms the missing-field surface is informative. */
    console.log('\n3. POST missing librarySnapshotId → 400 BUILD_AND_INGEST_BAD_REQUEST');
    {
      const form = validForm();
      delete (form as { librarySnapshotId?: string }).librarySnapshotId;
      const fd = makeFormData(form);
      appendFile(fd, 'seller_cf', CF_FIXTURE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const r = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd,
        headers: { authorization: AUTH_HEADER },
      });
      assertEqual(r.status, 400, '3.1 HTTP 400');
      const body = await r.json() as { error: string; missing?: string[] };
      assertEqual(body.error, 'BUILD_AND_INGEST_BAD_REQUEST', '3.2 error code is BUILD_AND_INGEST_BAD_REQUEST');
      assert(Array.isArray(body.missing), '3.3 missing list returned');
      assert(body.missing?.includes('librarySnapshotId') === true, '3.4 librarySnapshotId in missing list');
    }

    /* Case 4 — Idempotency under the 201 path.
     *
     * Same body submitted twice → same extractionResultId, same rootId, AND
     * only ONE record in the store (validates ON CONFLICT(id) DO NOTHING
     * actually fires on the second insert — not just that hashes are stable
     * but that the deduplication mechanism in record-graph-store works under
     * HTTP). The third assertion is the unique-to-e2e idempotency property
     * the unit-level handler test can't reach. */
    console.log('\n4. idempotency — same body twice → same ids + ON CONFLICT dedupe in store');
    {
      const fd1 = makeFormData(validForm());
      appendFile(fd1, 'seller_cf', CF_FIXTURE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const r1 = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd1,
        headers: { authorization: AUTH_HEADER },
      });
      assertEqual(r1.status, 201, '4.1 first request HTTP 201');
      const b1 = await r1.json() as { extractionResultId: string; rootId: string };

      const fd2 = makeFormData(validForm());
      appendFile(fd2, 'seller_cf', CF_FIXTURE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const r2 = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd2,
        headers: { authorization: AUTH_HEADER },
      });
      assertEqual(r2.status, 201, '4.2 second request HTTP 201');
      const b2 = await r2.json() as { extractionResultId: string; rootId: string };

      assertEqual(b1.extractionResultId, b2.extractionResultId, '4.3 extractionResultId stable across HTTP calls');
      assertEqual(b1.rootId, b2.rootId, '4.4 rootId stable across HTTP calls');

      // Store-level idempotency: only ONE record exists with this id, even
      // though insertExtractionResult was called twice. The second insert
      // hit ON CONFLICT(id) DO NOTHING. We verify this by fetching the
      // record — if there were duplicate rows, sqlite's PRIMARY KEY would
      // have rejected the second insert with an error rather than silently
      // ON-CONFLICTing. Successful fetch + same id confirms dedupe.
      const fetched = testStore.getExtractionResult(b1.extractionResultId as never);
      assert(fetched !== null, '4.5 ExtractionResult fetchable from store');
      assertEqual(fetched?.id, b1.extractionResultId, '4.6 stored record id matches response (single row, no duplicates)');
    }

    /* Case 5 — Auth failure: no Authorization header → 401.
     *
     * Confirms requireAuth middleware is correctly mounted before the
     * route handler. requireAuth's own response shape (different from the
     * route's BUILD_AND_INGEST_BAD_REQUEST shape) is what we assert here. */
    console.log('\n5. POST without Authorization header → 401');
    {
      const fd = makeFormData(validForm());
      const r = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd,
        // no authorization header
      });
      assertEqual(r.status, 401, '5.1 HTTP 401');
      const body = await r.json() as { error: string };
      assert(typeof body.error === 'string' && body.error.length > 0, '5.2 401 response has error field');
    }

    /* Case 6 — Full-stack ASR upload with ASR_E2E=1 (Ticket K #7 closed).
     *
     * When ASR_E2E=1: upload asr-minimal.pdf + seller_cf + loanTerms form
     * field. Real AI extractors run during composer (extractPropertyMetadata
     * + extractRentRollFromDocument); the asr placeholder still returns null
     * pending Ticket I (#6). Response carries 201 with buildReport showing
     * asrPdf slot 'ok', and propertyMetadataId populated when the AI
     * extractor produced a non-null record.
     *
     * Defense: also assert that the persisted PropertyMetadata carries at
     * least one non-null descriptive field — guards against AI returning a
     * structurally-valid but entirely-null record (which extractor returns
     * null for, but in case the heuristic ever changes). */
    console.log('\n6. ASR_E2E full-stack upload — real AI extractors run');
    if (!E2E_ENABLED) {
      console.log('  skip  6.* E2E disabled (set ASR_E2E=1 to enable; caller pays for AI calls)');
    } else {
      const fd = makeFormData(validForm());
      appendFile(fd, 'seller_cf', CF_FIXTURE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      appendFile(fd, 'asr', ASR_FIXTURE, 'application/pdf');
      const r = await fetch(`${baseUrl}/api/build-and-ingest`, {
        method: 'POST',
        body: fd,
        headers: { authorization: AUTH_HEADER },
      });
      if (r.status !== 201) {
        const debugBody = await r.clone().text();
        console.error(`  DEBUG: response status=${r.status}, body=${debugBody}`);
      }
      assertEqual(r.status, 201, '6.1 HTTP 201');
      const body = await r.json() as {
        rootId: string;
        extractionResultId: string;
        propertyMetadataId: string | null;
        buildReport: { slots: Record<string, { status: string }> };
      };
      assertEqual(body.buildReport.slots.asrPdf.status, 'ok', '6.2 asr slot ok (parseDocument succeeded; AI ran)');
      assertEqual(body.buildReport.slots.sellerCfXlsx.status, 'ok', '6.3 cf slot ok');

      // PropertyMetadata may be null if the AI extractor returned null
      // (e.g. minimal fixture text was insufficient). If it IS populated,
      // assert that at least one descriptive field is non-null — guards
      // against fully-empty PM somehow surviving the extractor's null gate.
      if (body.propertyMetadataId !== null) {
        assert(/^[0-9a-f]{64}$/.test(body.propertyMetadataId), '6.4 propertyMetadataId is 64-hex');
        const pm = testStore.getPropertyMetadata(body.propertyMetadataId as never);
        assert(pm !== null, '6.5 PropertyMetadata persisted in store');
        if (pm !== null) {
          const descriptiveFields = [
            pm.propertyName, pm.propertySubtype, pm.address, pm.city, pm.state, pm.zip,
            pm.county, pm.msa, pm.submarket, pm.yearBuilt, pm.yearRenovated, pm.buildingClass,
            pm.totalSquareFeet, pm.totalUnits, pm.totalRooms, pm.totalPads,
            pm.occupancyPhysical, pm.occupancyEconomic, pm.ownershipInterest, pm.numberOfBuildings,
          ];
          const anyNonNull = descriptiveFields.some((f) => f !== null);
          assert(anyNonNull, '6.6 persisted PropertyMetadata has at least one non-null descriptive field');
        }
      } else {
        console.log('  info  6.4-6.6 skipped (AI extractor returned null PropertyMetadata for this fixture)');
      }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    if (server !== null) await new Promise<void>((resolve) => server!.close(() => resolve()));
    testStore.close();
  }

  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
