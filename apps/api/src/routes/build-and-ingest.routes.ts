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
 *     rootId: DoctrineEvaluationId,           // == evaluation.id (mirrors /api/ingest)
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
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResultId,
  ISODateTime,
  LibrarySnapshotId,
  LoanTermsExtraction,
  MarketBenchmarks,
  MarketLiquidity,
  PropertyMetadataId,
} from '@cre/contracts';
import {
  buildExtractionResult,
  type BuildExtractionResultOutput,
  type BuildExtractionResultArgs,
} from '../services/extraction/build-extraction-result.js';
import type { InputSlots } from '../services/extraction/extractor-outcome.js';
import type { BuildReport } from '../services/extraction/build-report.js';
import {
  ingestExtractionResult,
  IngestionError,
  type IngestExtractionResultArgs,
  type IngestionResult,
} from '../services/ingest-extraction-result.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
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
]);

/* --------------------------------- deps ---------------------------------- */

export interface BuildAndIngestDeps {
  readonly buildExtractionResult:
    (args: BuildExtractionResultArgs) => Promise<BuildExtractionResultOutput>;
  readonly ingestExtractionResult:
    (args: IngestExtractionResultArgs, store: RecordGraphStore) => IngestionResult;
  readonly recordGraphStore: RecordGraphStore;
}

export const DEFAULT_BUILD_AND_INGEST_DEPS: BuildAndIngestDeps = {
  buildExtractionResult,
  ingestExtractionResult,
  recordGraphStore,
};

/* ------------------------------ shape types ------------------------------ */

type MulterFilesMap = { [fieldname: string]: Express.Multer.File[] };

interface BuildAndIngestRequestBody {
  analysisAsOfDate?: unknown;
  dealRef?: unknown;
  propertyType?: unknown;
  librarySnapshotId?: unknown;
  marketBenchmarks?: unknown;
  creditManifesto?: unknown;
  loanTerms?: unknown;
  marketLiquidityHint?: unknown;
  propertyHint?: unknown;
}

const REQUIRED_FORM_FIELDS: ReadonlyArray<keyof BuildAndIngestRequestBody> = [
  'analysisAsOfDate',
  'dealRef',
  'propertyType',
  'librarySnapshotId',
  'marketBenchmarks',
  'creditManifesto',
];

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

    /* Parse the two JSON-stringified fields. */
    let marketBenchmarks: MarketBenchmarks;
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

    let creditManifesto: CreditManifesto;
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
    const slots: InputSlots = {
      ...(asr !== undefined ? { asrPdf: asr } : {}),
      ...(rr !== undefined ? { rentRollXlsx: rr } : {}),
      ...(cf !== undefined ? { sellerCfXlsx: cf } : {}),
    };

    /* Run the composer. Adapter throws are absorbed inside the composer's
       Promise.allSettled defense; composer itself shouldn't throw in normal
       operation. If it does, the catch below surfaces it as 500-ish 400. */
    let composed: BuildExtractionResultOutput;
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

    /* Run ingest against the composed ExtractionResult. Synchronous. */
    let ingested: IngestionResult;
    try {
      ingested = deps.ingestExtractionResult(
        {
          extractionResult: composed.extractionResult,
          propertyType: body.propertyType as AssetType,
          ...(body.marketLiquidityHint !== undefined && body.marketLiquidityHint !== null
            ? { marketLiquidityHint: body.marketLiquidityHint as MarketLiquidity }
            : {}),
          librarySnapshotId: body.librarySnapshotId as LibrarySnapshotId,
          marketBenchmarks,
          creditManifesto,
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
      res.status(400).json({
        error: err.name === undefined ? 'INGEST_ERROR' : err.name,
        message: err.message === undefined ? 'ingestion failed' : err.message,
      });
      return;
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
      rootId: DoctrineEvaluationId;
      extractionResultId: ExtractionResultId;
      propertyMetadataId: PropertyMetadataId | null;
      buildReport: BuildReport;
      evaluation: DoctrineEvaluation;
      propertyMetadataError?: { name: string; message: string };
    } = {
      rootId: ingested.rootId,
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
