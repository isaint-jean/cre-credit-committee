/**
 * Ingestion route (Batch 6.4) — `POST /api/ingest`.
 *
 * Dumb constructor of a lineage event: validate body shape, call ingestion service, return.
 * Per the user's directive: route handlers do not interpret meaning. All semantic validation,
 * data-quality reasoning, and asset-class branching is the producers' job. This handler only
 * checks that required body fields are present.
 *
 * Body shape:
 *
 *   {
 *     extractionResult: ExtractionResult,
 *     propertyType: AssetType,
 *     marketLiquidityHint?: MarketLiquidity,
 *     librarySnapshotId: LibrarySnapshotId,    // pre-persisted via seed:approved-deals
 *     // exactly one of:
 *     marketBenchmarks?: MarketBenchmarks,
 *     marketBenchmarksId?: MarketBenchmarksId, // reference into the registry
 *     // exactly one of:
 *     creditManifesto?: CreditManifesto,
 *     creditManifestoId?: CreditManifestoId,   // reference into the registry
 *     analysisAsOfDate: ISODateTime,
 *   }
 *
 * On success: 201 with { rootId, evaluationId, evaluation }.
 *   - rootId: RevisionId — public AnalysisId (root revision envelope id, Option C / #20)
 *   - evaluationId: DoctrineEvaluationId — internal anchor for hydration / workflow / audit
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
  marketBenchmarksId?: unknown;
  creditManifesto?: unknown;
  creditManifestoId?: unknown;
  analysisAsOfDate?: unknown;
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

ingestRoutes.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as IngestRequestBody;

  /* Shape-only validation. Producers own semantic validation. */
  const requiredFlat: ReadonlyArray<keyof IngestRequestBody> = [
    'extractionResult',
    'propertyType',
    'librarySnapshotId',
    'analysisAsOfDate',
  ];
  const missing = requiredFlat.filter((k) => !isPresent(body[k]));
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'INGEST_BAD_REQUEST',
      message: `Required fields missing: ${missing.join(', ')}`,
    });
  }

  /* Dual-mode pairs: exactly one of inline-or-reference per pair. */
  const bmInline = isPresent(body.marketBenchmarks);
  const bmRef = isPresent(body.marketBenchmarksId);
  if (bmInline === bmRef) {
    return res.status(400).json({
      error: 'INGEST_BAD_REQUEST',
      message: bmInline
        ? 'Provide exactly one of marketBenchmarks (inline) or marketBenchmarksId (reference) — both supplied'
        : 'Provide exactly one of marketBenchmarks (inline) or marketBenchmarksId (reference) — neither supplied',
    });
  }
  const cmInline = isPresent(body.creditManifesto);
  const cmRef = isPresent(body.creditManifestoId);
  if (cmInline === cmRef) {
    return res.status(400).json({
      error: 'INGEST_BAD_REQUEST',
      message: cmInline
        ? 'Provide exactly one of creditManifesto (inline) or creditManifestoId (reference) — both supplied'
        : 'Provide exactly one of creditManifesto (inline) or creditManifestoId (reference) — neither supplied',
    });
  }

  try {
    const result = await ingestExtractionResult(
      {
        extractionResult: body.extractionResult as never,
        propertyType: body.propertyType as never,
        ...(body.marketLiquidityHint !== undefined
          ? { marketLiquidityHint: body.marketLiquidityHint as never }
          : {}),
        librarySnapshotId: body.librarySnapshotId as never,
        ...(bmInline
          ? { marketBenchmarks: body.marketBenchmarks as never }
          : { marketBenchmarksId: body.marketBenchmarksId as never }),
        ...(cmInline
          ? { creditManifesto: body.creditManifesto as never }
          : { creditManifestoId: body.creditManifestoId as never }),
        analysisAsOfDate: body.analysisAsOfDate as never,
      },
      recordGraphStore,
    );
    return res.status(201).json({
      rootId: result.rootId,
      evaluationId: result.evaluationId,
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
