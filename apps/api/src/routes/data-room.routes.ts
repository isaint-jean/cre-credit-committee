/**
 * Data-Room routes (Data-Room Phase 1, Deliverables 2 + 3).
 *
 * Per-POOL two-level (Deal × Doc-type) document room + per-user read/unread +
 * download-what's-new. Mounted under /api/data-room. Auth-gated at the router
 * level (routes/index.ts); every handler reads req.user.userId.
 *
 * DECOUPLED FROM INGEST — upload-and-organize + browse + download only. No
 * handler here touches the composer / ingest / registry / governed path.
 *
 * Endpoints:
 *   POST   /:poolId/staging                 bulk drop  → StagingBatch (reuse)
 *   POST   /:poolId/assign                  assign staged files → (loan, docType)
 *   GET    /:poolId/by-doc-type             projection 1
 *   GET    /:poolId/by-loan                 projection 2
 *   GET    /:poolId/docs                    flat pile + per-user read flags
 *   GET    /:poolId/doc/:fileHash           stream one doc's bytes
 *   POST   /:poolId/read                    mark one doc read   { fileHash }
 *   GET    /:poolId/unread                  per-user unread set + count
 *   GET    /:poolId/download                zip since cursor (download-what's-new)
 *   GET    /doc-types                       the taxonomy (UI, no hardcoding)
 */

import { Router, type Request, type Response } from 'express';
import archiver from 'archiver';
import { DOC_TYPE_TAXONOMY } from '@cre/contracts';
import { upload } from '../middleware/upload.js';
import { createStagingBatch } from '../services/source-doc-store.service.js';
import {
  assignDataRoomFiles,
  projectByDocType,
  projectByLoan,
  listPoolDocs,
  getDataRoomDoc,
  type DataRoomAssignment,
} from '../services/data-room-store.service.js';
import {
  classifyStagedFile,
  verdictFor,
} from '../services/data-room-classify.service.js';
import { DocumentReadStateStore } from '../storage/document-read-state-store.js';
import { PoolStore } from '../storage/pool-store.js';
import type { PoolId } from '@cre/contracts';

export const dataRoomRoutes = Router();

const uploadFilesArray = upload.array('files', 50);

// Lazy singleton (mirrors pool.routes.ts _store pattern). The store's lazy DDL
// runs on first construction — so cre.db is untouched until a first data-room
// request actually hits this router.
let _readState: DocumentReadStateStore | null = null;
function readStateStore(): DocumentReadStateStore {
  if (_readState === null) _readState = new DocumentReadStateStore();
  return _readState;
}
/** Test seam. */
export function _setReadStateStoreForTests(s: DocumentReadStateStore): void {
  _readState = s;
}

// Lazy PoolStore for the classify-on-stage loan axis (read-only SELECTs only —
// listLoanNameKeysForPool). Constructed only when a staging request first needs
// to classify. Mirrors pool.routes.ts _store.
let _poolStore: PoolStore | null = null;
function poolStore(): PoolStore {
  if (_poolStore === null) _poolStore = new PoolStore();
  return _poolStore;
}
/** Test seam. */
export function _setPoolStoreForTests(s: PoolStore): void {
  _poolStore = s;
}

function userId(req: Request): string | null {
  return req.user?.userId ?? null;
}

// ---------------------------------------------------------------------------
// Taxonomy (UI rendering — no hardcoding)
// ---------------------------------------------------------------------------

dataRoomRoutes.get('/doc-types', (_req: Request, res: Response) => {
  res.json({ docTypes: DOC_TYPE_TAXONOMY });
});

// ---------------------------------------------------------------------------
// Bulk drop → staging (reuse) + assign → (loan, docType)
// ---------------------------------------------------------------------------

dataRoomRoutes.post('/:poolId/staging', uploadFilesArray as any, async (req: Request, res: Response) => {
  try {
    const poolId = req.params.poolId!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'At least one file is required.' });
      return;
    }
    const batch = await createStagingBatch({
      files: files.map((f) => ({ buffer: f.buffer, originalFileName: f.originalname, mimeType: f.mimetype })),
    });

    // ── Data-Room Phase 2c — classify-on-stage → auto-route or hint ──────────
    // Two independent deterministic classifiers over each staged file's NAME;
    // BOTH-confident → auto-file via the SAME assignDataRoomFiles seam the manual
    // tray uses (no parallel path). Every other cell stays staged, pre-filled
    // with whatever WAS confident (the confirm tray seeds from these hints).
    const poolLoans = poolStore().listLoanNameKeysForPool(poolId as PoolId);

    const autoAssignments: DataRoomAssignment[] = [];
    // Per-file verdict surfaced to the UI, keyed by stagingId.
    const routing: Array<{
      stagingId: string;
      auto: boolean; // auto-filed on stage → skips the tray
      prefill: { docType?: string; loanInPoolId?: string };
    }> = [];

    for (const f of batch.files) {
      const hints = classifyStagedFile(f.originalFileName, poolLoans);
      const verdict = verdictFor(hints.docType, hints.loanInPoolId);
      if (
        verdict.action === 'auto' &&
        verdict.prefill.docType &&
        verdict.prefill.loanInPoolId
      ) {
        autoAssignments.push({
          stagingId: f.stagingId,
          loanInPoolId: verdict.prefill.loanInPoolId,
          docType: verdict.prefill.docType,
        });
      }
      routing.push({
        stagingId: f.stagingId,
        auto: verdict.action === 'auto',
        prefill: verdict.prefill,
      });
    }

    // File the both-confident files NOW via the SAME store the manual tray uses.
    const autoResults =
      autoAssignments.length > 0
        ? await assignDataRoomFiles({ poolId, batchId: batch.batchId, assignments: autoAssignments })
        : [];
    // Reconcile: only mark a file auto-routed if its assign actually succeeded.
    // A failed auto-assign (e.g. transient) falls back to a confirm row.
    const failedAuto = new Set(
      autoResults.filter((r) => r.status !== 'assigned').map((r) => r.stagingId),
    );
    if (failedAuto.size > 0) {
      for (const r of routing) {
        if (r.auto && failedAuto.has(r.stagingId)) r.auto = false;
      }
    }

    const autoRoutedIds = new Set(
      autoResults.filter((r) => r.status === 'assigned').map((r) => r.stagingId),
    );
    // The confirm tray should only receive files that were NOT auto-filed.
    const stagedForConfirm = batch.files.filter((f) => !autoRoutedIds.has(f.stagingId));
    const routingForConfirm = routing.filter((r) => !autoRoutedIds.has(r.stagingId));

    res.status(201).json({
      // Only the confirm-needed files ride in `batch.files` so the tray never
      // shows an already-filed doc; auto-routed files appear under their folder
      // on the next projection refresh.
      batch: { ...batch, files: stagedForConfirm },
      routing: routingForConfirm,
      autoRouted: autoResults.filter((r) => r.status === 'assigned'),
      summary: {
        autoRoutedCount: autoRoutedIds.size,
        needConfirmCount: stagedForConfirm.length,
      },
    });
  } catch (err: any) {
    console.error('data-room staging upload error:', err);
    res.status(500).json({ error: 'staging_upload_failed', message: err?.message ?? String(err) });
  }
});

dataRoomRoutes.post('/:poolId/assign', async (req: Request, res: Response) => {
  try {
    const poolId = req.params.poolId!;
    const body = req.body as { batchId?: string; assignments?: ReadonlyArray<DataRoomAssignment> } | undefined;
    const batchId = typeof body?.batchId === 'string' ? body.batchId : null;
    const assignments = Array.isArray(body?.assignments) ? body!.assignments : null;
    if (!batchId || !assignments) {
      res.status(400).json({ error: 'invalid_body', message: '`batchId` and `assignments` are required.' });
      return;
    }
    const results = await assignDataRoomFiles({ poolId, batchId, assignments });
    res.json({ results });
  } catch (err: any) {
    console.error('data-room assign error:', err);
    res.status(500).json({ error: 'assign_failed', message: err?.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// The two projections + flat pile (with per-user read flags)
// ---------------------------------------------------------------------------

dataRoomRoutes.get('/:poolId/by-doc-type', (req: Request, res: Response) => {
  res.json({ poolId: req.params.poolId, groups: projectByDocType(req.params.poolId!) });
});

dataRoomRoutes.get('/:poolId/by-loan', (req: Request, res: Response) => {
  res.json({ poolId: req.params.poolId, groups: projectByLoan(req.params.poolId!) });
});

dataRoomRoutes.get('/:poolId/docs', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const poolId = req.params.poolId!;
  const docs = listPoolDocs(poolId);
  const read = readStateStore().readSet(uid);
  const annotated = docs.map((d) => ({ ...d, read: read.has(d.fileHash) }));
  res.json({ poolId, docs: annotated });
});

dataRoomRoutes.get('/:poolId/doc/:fileHash', async (req: Request, res: Response) => {
  const { poolId, fileHash } = req.params as { poolId: string; fileHash: string };
  const found = await getDataRoomDoc(poolId, fileHash);
  if (!found) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', found.entry.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(found.entry.fileName)}"`);
  res.setHeader('Content-Length', String(found.bytes.length));
  res.send(found.bytes);
});

// ---------------------------------------------------------------------------
// Read/unread (per-user)
// ---------------------------------------------------------------------------

dataRoomRoutes.post('/:poolId/read', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const fileHash = typeof req.body?.fileHash === 'string' ? req.body.fileHash : null;
  if (!fileHash) {
    res.status(400).json({ error: 'invalid_body', message: '`fileHash` is required.' });
    return;
  }
  readStateStore().markRead(uid, fileHash);
  res.json({ ok: true, fileHash, read: true });
});

dataRoomRoutes.get('/:poolId/unread', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const poolId = req.params.poolId!;
  const hashes = listPoolDocs(poolId).map((d) => d.fileHash);
  const { unread, count } = readStateStore().unreadOf(uid, hashes);
  res.json({ poolId, unread, count });
});

// ---------------------------------------------------------------------------
// Download-what's-new (zip-since-cursor)
// ---------------------------------------------------------------------------

dataRoomRoutes.get('/:poolId/download', async (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const poolId = req.params.poolId!;
  const store = readStateStore();
  const docs = listPoolDocs(poolId);
  const { newDocs, nextCursor } = store.whatsNew(
    uid,
    poolId,
    docs.map((d) => ({ fileHash: d.fileHash, uploadedAt: d.uploadedAt })),
  );

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="data-room-${poolId}-new.zip"`);
  res.setHeader('X-Data-Room-New-Count', String(newDocs.length));

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    // If headers already sent we can only destroy; otherwise 500.
    if (!res.headersSent) res.status(500).json({ error: 'zip_failed', message: err.message });
    else res.destroy(err);
  });
  archive.pipe(res);

  const byHash = new Map(docs.map((d) => [d.fileHash, d]));
  for (const nd of newDocs) {
    const entry = byHash.get(nd.fileHash);
    if (!entry) continue;
    const got = await getDataRoomDoc(poolId, nd.fileHash);
    if (!got) continue;
    // Prefix with loan + docType so the zip is browsable on disk.
    archive.append(got.bytes, { name: `${entry.loanInPoolId}/${entry.docType}/${entry.fileName}` });
  }
  await archive.finalize();

  // Advance the cursor AFTER a successful pull (streamed above). Only advance
  // when there was something to sync so a repeated pull with nothing new is a
  // no-op that still returns an (empty) zip.
  if (nextCursor !== null && newDocs.length > 0) {
    store.setCursor(uid, poolId, nextCursor);
  }
});
