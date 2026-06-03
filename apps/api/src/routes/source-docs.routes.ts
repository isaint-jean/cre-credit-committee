/**
 * Source-document intake routes.
 *
 * Per-deal typed upload + manifest read + bulk staging endpoints. Mounted
 * under /api/source-docs. Multipart uploads reuse the shared `upload`
 * middleware from middleware/upload.ts (same multer config used by the
 * uw-intelligence routes).
 *
 * Error semantics:
 *   - 400 invalid_slot { slot, validSlots }
 *   - 404 historical_uw_not_found { historicalUwId }
 *   - 404 not_found (for streaming + manifest reads)
 *   - 200/201 success with typed bodies
 *
 * NOT wired to extraction/ingest. Upload-and-organize only.
 */

import { Router, type Request, type Response } from 'express';
import { upload } from '../middleware/upload.js';
import {
  uploadSourceDoc,
  deleteSourceDoc,
  listAllManifests,
  getDealManifest,
  getSourceDocBuffer,
  getDealCompleteness,
  getAllCompleteness,
  createStagingBatch,
  getStagingBatch,
  assignStagingFiles,
  discardStagingBatch,
  listSlots,
  HistoricalUwNotFoundError,
  InvalidSlotError,
} from '../services/source-doc-store.service.js';
import type { StagingAssignment } from '@cre/shared';

export const sourceDocsRoutes = Router();

const uploadFilesArray = upload.array('files', 50);

// ---------------------------------------------------------------------------
// Slot taxonomy
// ---------------------------------------------------------------------------

sourceDocsRoutes.get('/slots', (_req: Request, res: Response) => {
  res.json({ slots: listSlots() });
});

// ---------------------------------------------------------------------------
// Manifest + completeness reads
// ---------------------------------------------------------------------------

sourceDocsRoutes.get('/manifest', (req: Request, res: Response) => {
  const historicalUwId = typeof req.query.historicalUwId === 'string' ? req.query.historicalUwId : null;
  if (historicalUwId) {
    const m = getDealManifest(historicalUwId);
    res.json({ manifests: m ? [m] : [] });
    return;
  }
  res.json({ manifests: listAllManifests() });
});

sourceDocsRoutes.get('/completeness', (req: Request, res: Response) => {
  const historicalUwId = typeof req.query.historicalUwId === 'string' ? req.query.historicalUwId : null;
  if (historicalUwId) {
    res.json(getDealCompleteness(historicalUwId));
    return;
  }
  res.json({ completeness: getAllCompleteness() });
});

// ---------------------------------------------------------------------------
// Bulk staging
// ---------------------------------------------------------------------------

sourceDocsRoutes.post('/staging', uploadFilesArray as any, async (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'At least one file is required.' });
      return;
    }
    const batch = await createStagingBatch({
      files: files.map((f) => ({
        buffer: f.buffer,
        originalFileName: f.originalname,
        mimeType: f.mimetype,
      })),
    });
    res.status(201).json({ batch });
  } catch (err: any) {
    console.error('source-docs staging upload error:', err);
    res.status(500).json({ error: 'staging_upload_failed', message: err.message ?? String(err) });
  }
});

sourceDocsRoutes.get('/staging/:batchId', (req: Request, res: Response) => {
  const batch = getStagingBatch(req.params.batchId!);
  if (!batch) {
    res.status(404).json({ error: 'staging_batch_not_found', batchId: req.params.batchId });
    return;
  }
  res.json({ batch });
});

sourceDocsRoutes.post('/staging/:batchId/assign', async (req: Request, res: Response) => {
  try {
    const batchId = req.params.batchId!;
    const body = req.body as { assignments?: ReadonlyArray<StagingAssignment> } | undefined;
    const assignments = Array.isArray(body?.assignments) ? body!.assignments : null;
    if (!assignments) {
      res.status(400).json({ error: 'invalid_body', message: '`assignments` array is required.' });
      return;
    }
    const results = await assignStagingFiles({ batchId, assignments });
    res.json({ results });
  } catch (err: any) {
    console.error('source-docs assign error:', err);
    res.status(500).json({ error: 'assign_failed', message: err.message ?? String(err) });
  }
});

sourceDocsRoutes.delete('/staging/:batchId', async (req: Request, res: Response) => {
  const ok = await discardStagingBatch(req.params.batchId!);
  res.json({ discarded: ok });
});

// ---------------------------------------------------------------------------
// Per-slot upload + stream + delete
//
// NOTE: param-rich routes go AFTER the more specific paths above. Express
// matches in order, so /slots, /manifest, /completeness, /staging/... are
// guaranteed to win over /:historicalUwId/... .
// ---------------------------------------------------------------------------

sourceDocsRoutes.post(
  '/:historicalUwId/:slot',
  uploadFilesArray as any,
  async (req: Request, res: Response) => {
    try {
      const { historicalUwId, slot } = req.params as { historicalUwId: string; slot: string };
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'no_files', message: 'At least one file is required.' });
        return;
      }
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;

      const entries = [];
      for (const f of files) {
        const entry = await uploadSourceDoc({
          historicalUwId,
          slot: slot as any,
          buffer: f.buffer,
          originalFileName: f.originalname,
          mimeType: f.mimetype,
          notes,
        });
        entries.push(entry);
      }
      res.status(201).json({ entries });
    } catch (err: unknown) {
      if (err instanceof HistoricalUwNotFoundError) {
        res
          .status(404)
          .json({ error: 'historical_uw_not_found', historicalUwId: err.historicalUwId });
        return;
      }
      if (err instanceof InvalidSlotError) {
        res
          .status(400)
          .json({ error: 'invalid_slot', slot: err.slot, validSlots: err.validSlots });
        return;
      }
      console.error('source-docs upload error:', err);
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'upload_failed', message: msg });
    }
  },
);

sourceDocsRoutes.get('/:historicalUwId/:slot/:fileHash', (req: Request, res: Response) => {
  const { historicalUwId, slot, fileHash } = req.params as {
    historicalUwId: string;
    slot: string;
    fileHash: string;
  };
  try {
    const result = getSourceDocBuffer({ historicalUwId, slot: slot as any, fileHash });
    if (!result) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.setHeader('Content-Type', result.entry.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(result.entry.originalFileName)}"`,
    );
    res.setHeader('Content-Length', String(result.buffer.length));
    res.send(result.buffer);
  } catch (err: unknown) {
    if (err instanceof InvalidSlotError) {
      res
        .status(400)
        .json({ error: 'invalid_slot', slot: err.slot, validSlots: err.validSlots });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'stream_failed', message: msg });
  }
});

sourceDocsRoutes.delete(
  '/:historicalUwId/:slot/:fileHash',
  async (req: Request, res: Response) => {
    const { historicalUwId, slot, fileHash } = req.params as {
      historicalUwId: string;
      slot: string;
      fileHash: string;
    };
    try {
      const deleted = await deleteSourceDoc({ historicalUwId, slot: slot as any, fileHash });
      res.json({ deleted });
    } catch (err: unknown) {
      if (err instanceof InvalidSlotError) {
        res
          .status(400)
          .json({ error: 'invalid_slot', slot: err.slot, validSlots: err.validSlots });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'delete_failed', message: msg });
    }
  },
);
