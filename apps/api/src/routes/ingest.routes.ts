/**
 * Ingestion route (Batch 6.4) — `POST /api/ingest`.
 *
 * Dumb constructor of a lineage event: validate body shape, call ingestion service, return.
 * Per the user's directive: route handlers do not interpret meaning. All semantic validation,
 * data-quality reasoning, and asset-class branching is the producers' job. This handler only
 * checks that required body fields are present.
 *
 * Body shape (locked sub-batch 6.4):
 *
 *   {
 *     extractionResult: ExtractionResult,
 *     propertyType: AssetType,
 *     marketLiquidityHint?: MarketLiquidity,
 *     librarySnapshotId: LibrarySnapshotId,    // pre-persisted via seed:approved-deals
 *     marketBenchmarks: MarketBenchmarks,
 *     creditManifesto: CreditManifesto,
 *     analysisAsOfDate: ISODateTime,
 *   }
 *
 * On success: 201 with { rootId, evaluation }.
 *
 * Errors surface as 400 with the underlying error name and message. Producer errors
 * (JudgmentEngineError, RecordIdMismatchError, etc.) propagate through unchanged — the handler
 * does not interpret them, only reports them.
 *
 * Strict-dispatch unification with `POST /api/analyses` arrives in Batch 6.8; for now the
 * graph-backed ingestion lives at `/api/ingest` and the legacy route is unaffected.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  ingestExtractionResult,
  IngestionError,
} from '../services/ingest-extraction-result.js';
import { recordGraphStore } from '../storage/record-graph-store.js';

export const ingestRoutes = Router();

interface IngestRequestBody {
  extractionResult?: unknown;
  propertyType?: unknown;
  marketLiquidityHint?: unknown;
  librarySnapshotId?: unknown;
  marketBenchmarks?: unknown;
  creditManifesto?: unknown;
  analysisAsOfDate?: unknown;
}

ingestRoutes.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as IngestRequestBody;

  /* Shape-only validation. Producers own semantic validation. */
  const required: ReadonlyArray<keyof IngestRequestBody> = [
    'extractionResult',
    'propertyType',
    'librarySnapshotId',
    'marketBenchmarks',
    'creditManifesto',
    'analysisAsOfDate',
  ];
  const missing = required.filter((k) => body[k] === undefined || body[k] === null);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'INGEST_BAD_REQUEST',
      message: `Required fields missing: ${missing.join(', ')}`,
    });
  }

  try {
    const result = ingestExtractionResult(
      {
        extractionResult: body.extractionResult as never,
        propertyType: body.propertyType as never,
        ...(body.marketLiquidityHint !== undefined
          ? { marketLiquidityHint: body.marketLiquidityHint as never }
          : {}),
        librarySnapshotId: body.librarySnapshotId as never,
        marketBenchmarks: body.marketBenchmarks as never,
        creditManifesto: body.creditManifesto as never,
        analysisAsOfDate: body.analysisAsOfDate as never,
      },
      recordGraphStore,
    );
    return res.status(201).json({
      rootId: result.rootId,
      evaluation: result.evaluation,
    });
  } catch (e) {
    if (e instanceof IngestionError) {
      return res.status(400).json({
        error: e.code,
        message: e.message,
        ...e.context,
      });
    }
    const err = e as Error;
    return res.status(400).json({
      error: err?.name ?? 'INGEST_ERROR',
      message: err?.message ?? 'Ingestion failed',
    });
  }
});
