/**
 * Build-and-ingest route — POST /api/build-and-ingest.
 *
 * Closes the path from raw uploaded files to a content-addressed ExtractionResult
 * + persisted spine + sibling PropertyMetadata. Sits alongside POST /api/ingest;
 * the difference is that /ingest accepts a pre-built ExtractionResult JSON body
 * while this route accepts raw multipart files and BUILDS the ExtractionResult
 * via buildExtractionResult before delegating to ingestExtractionResult.
 *
 * Multipart fields (snake_case to match existing multer conventions):
 *   - `asr`        : single PDF → composer's asrPdf slot
 *   - `rent_roll`  : single XLSX/XLSM → composer's rentRollXlsx slot
 *   - `seller_cf`  : single XLSX/XLSM → composer's sellerCfXlsx slot
 * All three are optional at the multer level; the composer reports absent slots
 * in BuildReport.slots[k].status === 'absent'.
 *
 * Form fields (non-file, sent as multipart fields; multer populates req.body):
 *   - analysisAsOfDate     (required, ISO 8601 string)
 *   - dealRef              (required, free-form deal identifier)
 *   - propertyType         (required, AssetType — Office/Multifamily/etc.)
 *   - librarySnapshotId    (required, content hash of the pre-persisted library snapshot)
 *   - marketBenchmarks     (required, JSON-STRINGIFIED MarketBenchmarks object)
 *   - creditManifesto      (required, JSON-STRINGIFIED CreditManifesto object)
 *   - loanTerms            (optional, JSON-STRINGIFIED LoanTermsExtraction; closes
 *                           Ticket K #7 — see field-validation block below)
 *   - marketLiquidityHint  (optional, MarketLiquidity value)
 *   - propertyHint         (optional, free-form string passed to AI extractors)
 *
 * JSON-stringified fields: `marketBenchmarks`, `creditManifesto`, and (when
 * provided) `loanTerms`. Multipart form fields are flat strings; complex
 * objects ride as JSON strings that this route parses at the boundary.
 * Malformed JSON in any of these returns 400 with a parse-error response.
 *
 * Response shape on 201:
 *   {
 *     rootId: RevisionId,                     // public AnalysisId — root revision envelope id (Option C / #20)
 *     evaluationId: DoctrineEvaluationId,     // internal doctrine-eval anchor for hydration / workflow / audit
 *     extractionResultId: ExtractionResultId,
 *     propertyMetadataId: PropertyMetadataId | null,
 *     buildReport: BuildReport,
 *     evaluation: DoctrineEvaluation,
 *     propertyMetadataError?: { name: string, message: string },  // on PM persistence failure
 *   }
 *
 * HTTP status matrix:
 *   - 201: composer + ingest both completed. Response body conveys completeness
 *          via buildReport (some slots may be absent/failed; the spine record is
 *          contract-valid with however many nulls).
 *   - 400: malformed request (missing required form fields, invalid JSON,
 *          librarySnapshotId not found, or producer error propagated).
 *   - 500: unhandled error.
 *
 * Persistence atomicity is best-effort: spine ingest runs first, then PM
 * insertion runs conditionally (only when composer extracted PM). If spine
 * ingest succeeds but PM insertion fails, the response is still 201 with
 * propertyMetadataId=null + propertyMetadataError populated. The spine and PM
 * have no FK relationship — they're independent content-addressed records.
 *
 * Dependency injection: the handler is built via makeBuildAndIngestHandler(deps).
 * Production code uses DEFAULT_BUILD_AND_INGEST_DEPS (real composer, real ingest,
 * singleton store). Tests inject mocks to control composer + ingest outcomes
 * without exercising the real adapters.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import type {
  AssetType,
  CreditManifesto,
  CreditManifestoId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionEngineVersion,
  ExtractionResultId,
  ISODateTime,
  LibrarySnapshotId,
  LoanTermsExtraction,
  MarketBenchmarks,
  MarketBenchmarksId,
  MarketLiquidity,
  PropertyMetadataId,
  RevisionId,
} from '@cre/contracts';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';
import {
  buildExtractionResult,
  type BuildExtractionResultOutput,
  type BuildExtractionResultArgs,
} from '../services/extraction/build-extraction-result.js';
import type { InputSlots } from '../services/extraction/extractor-outcome.js';
import type { BuildReport, SlotReport } from '../services/extraction/build-report.js';
import {
  ingestExtractionResult,
  IngestionError,
  type IngestExtractionResultArgs,
  type IngestionResult,
} from '../services/ingest-extraction-result.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import { blobStore, BlobStoreError } from '../storage/blob-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import { computeBufferContentHash } from '../util/content-hash.js';
import { computeExtractionInputKey } from '../util/extraction-cache-key.js';
import { CF_ADAPTER_VERSION } from '../services/extraction/adapters/cf.adapter.js';
import { RENT_ROLL_ADAPTER_VERSION } from '../services/extraction/adapters/rent-roll.adapter.js';
import { ASR_ADAPTER_VERSION } from '../services/extraction/adapters/asr.adapter.js';
import { PCA_ADAPTER_VERSION } from '../services/extraction/adapters/pca.adapter.js';
import { upload } from '../middleware/upload.js';

/* ------------------------------ multer config ----------------------------- */

/** Multer fields config inline-defined for this route. Three optional single-
 *  file fields. Not lifted to upload.ts middleware because no other route
 *  needs this exact triple — uploadAnalysisFiles is the closest analog but
 *  uses `seller_uw` (a different document) instead of `seller_cf`. */
const uploadBuildAndIngestFields = upload.fields([
  { name: 'asr', maxCount: 1 },
  { name: 'rent_roll', maxCount: 1 },
  { name: 'seller_cf', maxCount: 1 },
  { name: 'pca', maxCount: 1 },
]);

/* --------------------------------- deps ---------------------------------- */

export interface BuildAndIngestDeps {
  readonly buildExtractionResult:
    (args: BuildExtractionResultArgs) => Promise<BuildExtractionResultOutput>;
  readonly ingestExtractionResult:
    (args: IngestExtractionResultArgs, store: RecordGraphStore) => Promise<IngestionResult>;
  readonly recordGraphStore: RecordGraphStore;
  /** Tier B of issue #10. Bytes are persisted before the composer runs so
   *  the SourceDocumentRef.contentHash refs in the resulting ExtractionResult
   *  point at bytes actually on disk. Tests inject a MemoryBlobStore. */
  readonly blobStore: BlobStore;
  /** Tier B of issue #10. The set of versions stamped on the
   *  ExtractionResult by the composer. Used to build the
   *  extraction_input_cache key together with the slot-byte hashes. Built
   *  from per-adapter version constants + EXTRACTION_ENGINE_VERSION at
   *  module load — same values the composer stamps on its output. */
  readonly extractorVersions: Record<string, string>;
}

/** Production defaults. Tests pass mocked deps. The extractorVersions map
 *  here MUST match what the composer stamps on the ExtractionResult — if
 *  these drift, the cache key is wrong and re-uploads cache-miss
 *  spuriously (a correctness-preserving but performance-eroding bug). */
export const DEFAULT_BUILD_AND_INGEST_DEPS: BuildAndIngestDeps = {
  buildExtractionResult,
  ingestExtractionResult,
  recordGraphStore,
  blobStore,
  extractorVersions: {
    cf: CF_ADAPTER_VERSION,
    rentRoll: RENT_ROLL_ADAPTER_VERSION,
    asr: ASR_ADAPTER_VERSION,
    pca: PCA_ADAPTER_VERSION,
    engine: EXTRACTION_ENGINE_VERSION,
  },
};

/* ------------------------------ shape types ------------------------------ */

type MulterFilesMap = { [fieldname: string]: Express.Multer.File[] };

interface BuildAndIngestRequestBody {
  analysisAsOfDate?: unknown;
  dealRef?: unknown;
  propertyType?: unknown;
  librarySnapshotId?: unknown;
  /** Inline JSON-stringified MarketBenchmarks. Mutually exclusive with
   *  marketBenchmarksId — exactly one MUST be supplied. */
  marketBenchmarks?: unknown;
  /** Plain string reference into /api/registry/market-benchmarks. */
  marketBenchmarksId?: unknown;
  /** Same dual-mode shape for credit manifesto. */
  creditManifesto?: unknown;
  creditManifestoId?: unknown;
  loanTerms?: unknown;
  marketLiquidityHint?: unknown;
  propertyHint?: unknown;
}

const REQUIRED_FORM_FIELDS: ReadonlyArray<keyof BuildAndIngestRequestBody> = [
  'analysisAsOfDate',
  'dealRef',
  'propertyType',
  'librarySnapshotId',
];

function isFormPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** Pull a file's first entry from req.files, if present. */
function takeFile(
  files: MulterFilesMap | undefined,
  field: string,
): { buffer: Buffer; filename: string } | undefined {
  const arr = files === undefined ? undefined : files[field];
  if (arr === undefined || arr.length === 0) return undefined;
  const f = arr[0];
  if (f === undefined) return undefined;
  return { buffer: f.buffer, filename: f.originalname };
}

/* ------------------------------- handler --------------------------------- */

export function makeBuildAndIngestHandler(
  deps: BuildAndIngestDeps = DEFAULT_BUILD_AND_INGEST_DEPS,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as BuildAndIngestRequestBody;

    /* Shape validation: required fields present (string-or-not-empty). */
    const missing = REQUIRED_FORM_FIELDS.filter(
      (k) => body[k] === undefined || body[k] === null || body[k] === '',
    );
    if (missing.length > 0) {
      res.status(400).json({
        error: 'BUILD_AND_INGEST_BAD_REQUEST',
        message: `Required form fields missing: ${missing.join(', ')}`,
        missing,
      });
      return;
    }

    /* Dual-mode: exactly one of (marketBenchmarks, marketBenchmarksId), same
       for credit manifesto. Inline arrives JSON-stringified; reference arrives
       as a plain string. */
    const bmInlinePresent = isFormPresent(body.marketBenchmarks);
    const bmRefPresent = isFormPresent(body.marketBenchmarksId);
    if (bmInlinePresent === bmRefPresent) {
      res.status(400).json({
        error: 'BUILD_AND_INGEST_BAD_REQUEST',
        message: bmInlinePresent
          ? 'Provide exactly one of marketBenchmarks (inline JSON) or marketBenchmarksId (reference) — both supplied'
          : 'Provide exactly one of marketBenchmarks (inline JSON) or marketBenchmarksId (reference) — neither supplied',
      });
      return;
    }
    const cmInlinePresent = isFormPresent(body.creditManifesto);
    const cmRefPresent = isFormPresent(body.creditManifestoId);
    if (cmInlinePresent === cmRefPresent) {
      res.status(400).json({
        error: 'BUILD_AND_INGEST_BAD_REQUEST',
        message: cmInlinePresent
          ? 'Provide exactly one of creditManifesto (inline JSON) or creditManifestoId (reference) — both supplied'
          : 'Provide exactly one of creditManifesto (inline JSON) or creditManifestoId (reference) — neither supplied',
      });
      return;
    }

    /* When inline, parse JSON-stringified payloads. */
    let marketBenchmarks: MarketBenchmarks | undefined;
    if (bmInlinePresent) {
      try {
        marketBenchmarks = JSON.parse(body.marketBenchmarks as string) as MarketBenchmarks;
      } catch (e) {
        const err = e as Error;
        res.status(400).json({
          error: 'BUILD_AND_INGEST_BAD_REQUEST',
          message: 'marketBenchmarks is not valid JSON',
          field: 'marketBenchmarks',
          parseError: err.message,
        });
        return;
      }
    }

    let creditManifesto: CreditManifesto | undefined;
    if (cmInlinePresent) {
      try {
        creditManifesto = JSON.parse(body.creditManifesto as string) as CreditManifesto;
      } catch (e) {
        const err = e as Error;
        res.status(400).json({
          error: 'BUILD_AND_INGEST_BAD_REQUEST',
          message: 'creditManifesto is not valid JSON',
          field: 'creditManifesto',
          parseError: err.message,
        });
        return;
      }
    }

    /* Optional loanTerms (Ticket K #7). When provided, parses as
       JSON-stringified LoanTermsExtraction and threads into composer args.
       When absent or empty string, treated as undefined (composer projects
       loanTerms: null, judgment throws JE_LOAN_AMOUNT_MISSING). */
    let loanTerms: LoanTermsExtraction | undefined;
    if (body.loanTerms !== undefined && body.loanTerms !== null && body.loanTerms !== '') {
      try {
        loanTerms = JSON.parse(body.loanTerms as string) as LoanTermsExtraction;
      } catch (e) {
        const err = e as Error;
        res.status(400).json({
          error: 'BUILD_AND_INGEST_BAD_REQUEST',
          message: 'loanTerms is not valid JSON',
          field: 'loanTerms',
          parseError: err.message,
        });
        return;
      }
    }

    /* Assemble slots from req.files (multer.fields populates this map). */
    const files = req.files as MulterFilesMap | undefined;
    const asr = takeFile(files, 'asr');
    const rr = takeFile(files, 'rent_roll');
    const cf = takeFile(files, 'seller_cf');
    const pca = takeFile(files, 'pca');
    const slots: InputSlots = {
      ...(asr !== undefined ? { asrPdf: asr } : {}),
      ...(rr !== undefined ? { rentRollXlsx: rr } : {}),
      ...(cf !== undefined ? { sellerCfXlsx: cf } : {}),
      ...(pca !== undefined ? { pcaPdf: pca } : {}),
    };

    /* Tier B short-circuit (issue #10 / ADR §6). Before invoking the composer:
     *   1. Compute slot hashes from in-memory buffers (cheap, deterministic)
     *   2. Compute composite cache key from (slotHashes + extractorVersions)
     *   3. Lookup the cache; on hit, fetch the cached ExtractionResult +
     *      optional PropertyMetadata; on hit-with-missing-records (orphan),
     *      fall through to the cache-miss path.
     *   4. On cache miss: persist each slot's bytes via blobStore FIRST
     *      (fail-fast before any AI calls), then run the composer, then
     *      write the cache entry. */
    const slotHashes = {
      cf: cf ? computeBufferContentHash(cf.buffer) : null,
      rentRoll: rr ? computeBufferContentHash(rr.buffer) : null,
      asr: asr ? computeBufferContentHash(asr.buffer) : null,
      pca: pca ? computeBufferContentHash(pca.buffer) : null,
    };
    const cacheKey = computeExtractionInputKey({
      slotHashes,
      extractorVersions: deps.extractorVersions,
    });
    const cached = deps.recordGraphStore.getExtractionInputCacheByKey(cacheKey);

    let composed: BuildExtractionResultOutput | null = null;
    if (cached !== null) {
      const cachedExtraction =
        deps.recordGraphStore.getExtractionResult(cached.extractionResultId);
      if (cachedExtraction !== null) {
        const cachedPM = cached.propertyMetadataId !== null
          ? deps.recordGraphStore.getPropertyMetadata(cached.propertyMetadataId)
          : null;
        composed = {
          extractionResult: cachedExtraction,
          propertyMetadata: cachedPM,
          report: synthesizeBuildReport({
            extractionEngineVersion: cachedExtraction.extractionEngineVersion,
            slotPresent: { cf: cf !== undefined, rentRoll: rr !== undefined, asr: asr !== undefined, pca: pca !== undefined },
            extractorVersions: deps.extractorVersions,
          }),
        };
      }
      // else: cached entry references a deleted ExtractionResult (manual
      // record deletion edge case per ADR §6). Fall through.
    }

    if (composed === null) {
      /* Cache miss (or orphan-cache-entry fall-through). Persist blobs FIRST
       * so SourceDocumentRef.contentHash references bytes actually on disk
       * (B5). Failures here fail-fast before any AI adapter call burns
       * tokens. */
      try {
        if (cf)  await deps.blobStore.putBlob(cf.buffer);
        if (rr)  await deps.blobStore.putBlob(rr.buffer);
        if (asr) await deps.blobStore.putBlob(asr.buffer);
        if (pca) await deps.blobStore.putBlob(pca.buffer);
      } catch (e) {
        if (e instanceof BlobStoreError) {
          res.status(500).json({
            error: e.code,
            message: e.message,
            hash: e.hash,
          });
          return;
        }
        const err = e as Error;
        res.status(500).json({
          error: err?.name ?? 'BLOB_STORE_ERROR',
          message: err?.message ?? 'blob persistence failed',
        });
        return;
      }

      /* Run the composer. Adapter throws are absorbed inside the composer's
         Promise.allSettled defense; composer itself shouldn't throw in normal
         operation. If it does, the catch below surfaces it as 500-ish 400. */
      try {
        composed = await deps.buildExtractionResult({
          slots,
          analysisAsOfDate: body.analysisAsOfDate as ISODateTime,
          dealRef: body.dealRef as string,
          ...(body.propertyHint !== undefined && body.propertyHint !== null
            ? { propertyHint: body.propertyHint as string }
            : {}),
          ...(loanTerms !== undefined ? { loanTerms } : {}),
        });
      } catch (e) {
        const err = e as Error;
        res.status(400).json({
          error: err.name === undefined ? 'BUILD_FAILED' : err.name,
          message: err.message === undefined ? 'composer failed' : err.message,
        });
        return;
      }

      /* Cache write moved to AFTER ingest persists the spine — see below. The
         FK extraction_input_cache.extraction_result_id → extraction_results(id)
         can only resolve once Stage 1 of ingestExtractionResult has inserted
         the ExtractionResult row. */
    }

    /* Run ingest against the composed ExtractionResult. Async since
       Phase 1 batch 2 (the coupled `evaluateAndNarrate` wrapper performs
       an LLM round-trip for the narrative producer). */
    let ingested: IngestionResult;
    try {
      ingested = await deps.ingestExtractionResult(
        {
          extractionResult: composed.extractionResult,
          propertyType: body.propertyType as AssetType,
          ...(body.marketLiquidityHint !== undefined && body.marketLiquidityHint !== null
            ? { marketLiquidityHint: body.marketLiquidityHint as MarketLiquidity }
            : {}),
          librarySnapshotId: body.librarySnapshotId as LibrarySnapshotId,
          ...(bmInlinePresent
            ? { marketBenchmarks: marketBenchmarks as MarketBenchmarks }
            : { marketBenchmarksId: body.marketBenchmarksId as MarketBenchmarksId }),
          ...(cmInlinePresent
            ? { creditManifesto: creditManifesto as CreditManifesto }
            : { creditManifestoId: body.creditManifestoId as CreditManifestoId }),
          analysisAsOfDate: body.analysisAsOfDate as ISODateTime,
        },
        deps.recordGraphStore,
      );
    } catch (e) {
      if (e instanceof IngestionError) {
        res.status(400).json({
          error: e.code,
          message: e.message,
          ...e.context,
        });
        return;
      }
      const err = e as Error;
      // eslint-disable-next-line no-console
      console.error('[build-and-ingest] non-IngestionError thrown by ingestExtractionResult:', err);
      res.status(400).json({
        error: err.name === undefined ? 'INGEST_ERROR' : err.name,
        message: err.message === undefined ? 'ingestion failed' : err.message,
      });
      return;
    }

    /* Write the cache entry now that ingest has persisted the extraction_result
       (Stage 1 of ingestExtractionResult). The FK to extraction_results(id) is
       satisfied. Cache writes are best-effort: a failure here does not fail the
       request — the spine is committed, the next re-upload simply won't dedupe.
       Only writes on the cache-miss path; cache hits don't need to re-insert. */
    if (cached === null) {
      try {
        deps.recordGraphStore.insertExtractionInputCache({
          cacheKey,
          extractionResultId: composed.extractionResult.id,
          propertyMetadataId: composed.propertyMetadata?.id ?? null,
          cfHash: slotHashes.cf,
          rentRollHash: slotHashes.rentRoll,
          asrHash: slotHashes.asr,
          pcaHash: slotHashes.pca,
          extractorVersions: deps.extractorVersions,
        });
      } catch (e) {
        // eslint-disable-next-line no-console -- TODO(observability): typed log event
        console.warn('[build-and-ingest] extraction_input_cache insert failed:', e);
      }
    }

    /* Conditional PM persistence. Best-effort: spine is already committed
       by this point; a PM failure is informational, not a request failure. */
    let propertyMetadataId: PropertyMetadataId | null = null;
    let propertyMetadataError: { name: string; message: string } | undefined;
    if (composed.propertyMetadata !== null) {
      try {
        deps.recordGraphStore.insertPropertyMetadata(composed.propertyMetadata);
        propertyMetadataId = composed.propertyMetadata.id;
      } catch (e) {
        const err = e as Error;
        propertyMetadataError = {
          name: err.name === undefined ? 'Error' : err.name,
          message: err.message === undefined ? 'insertPropertyMetadata failed' : err.message,
        };
      }
    }

    const responseBody: {
      rootId: RevisionId;
      evaluationId: DoctrineEvaluationId;
      extractionResultId: ExtractionResultId;
      propertyMetadataId: PropertyMetadataId | null;
      buildReport: BuildReport;
      evaluation: DoctrineEvaluation;
      propertyMetadataError?: { name: string; message: string };
    } = {
      rootId: ingested.rootId,
      evaluationId: ingested.evaluationId,
      extractionResultId: composed.extractionResult.id,
      propertyMetadataId,
      buildReport: composed.report,
      evaluation: ingested.evaluation,
    };
    if (propertyMetadataError !== undefined) {
      responseBody.propertyMetadataError = propertyMetadataError;
    }
    res.status(201).json(responseBody);
  };
}

/* --------------------------- router factory ------------------------------ */

export function createBuildAndIngestRoutes(deps?: BuildAndIngestDeps): Router {
  const r = Router();
  r.post('/', uploadBuildAndIngestFields, makeBuildAndIngestHandler(deps));
  return r;
}

/** Production singleton. Matches existing route-export style; tests use
 *  createBuildAndIngestRoutes(mockDeps) or makeBuildAndIngestHandler(mockDeps)
 *  directly. */
export const buildAndIngestRoutes: Router = createBuildAndIngestRoutes();

/** Synthesize a BuildReport on cache-hit. The cache table doesn't store the
 *  original BuildReport bodies (just the resulting ExtractionResult.id), so
 *  this is a best-effort reconstruction. Honest reporting: per-slot status
 *  is 'ok' for slots whose bytes were provided in this re-upload (we know
 *  the prior run succeeded on those bytes, otherwise no cache entry would
 *  exist) and 'absent' for slots not supplied. durationMs is 0 because no
 *  actual work was done; consumers reading durationMs as "how long did
 *  extraction take" will see 0 on cache hits and should interpret
 *  accordingly. */
function synthesizeBuildReport(args: {
  readonly extractionEngineVersion: ExtractionEngineVersion;
  readonly slotPresent: { cf: boolean; rentRoll: boolean; asr: boolean; pca: boolean };
  readonly extractorVersions: Record<string, string>;
}): BuildReport {
  const nowISO = new Date().toISOString() as ISODateTime;
  const cfVersion = args.extractorVersions.cf ?? '?';
  const rrVersion = args.extractorVersions.rentRoll ?? '?';
  const asrVersion = args.extractorVersions.asr ?? '?';
  const pcaVersion = args.extractorVersions.pca ?? '?';

  const okSlot = (adapterVersion: string): SlotReport => ({
    status: 'ok',
    durationMs: 0,
    adapterVersion,
  });
  const absent: SlotReport = { status: 'absent' };

  return {
    startedAt: nowISO,
    finishedAt: nowISO,
    engineVersion: args.extractionEngineVersion,
    slots: {
      sellerCfXlsx: args.slotPresent.cf ? okSlot(cfVersion) : absent,
      rentRollXlsx: args.slotPresent.rentRoll ? okSlot(rrVersion) : absent,
      asrPdf: args.slotPresent.asr ? okSlot(asrVersion) : absent,
      pcaPdf: args.slotPresent.pca ? okSlot(pcaVersion) : absent,
    },
  };
}
