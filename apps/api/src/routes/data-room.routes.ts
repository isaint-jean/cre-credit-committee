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
import { DOC_TYPE_TAXONOMY, DOC_TYPE_CATEGORY, CATEGORIES_IN_ORDER } from '@cre/contracts';
import type { DocTypeCategory } from '@cre/contracts';
import { upload } from '../middleware/upload.js';
import { createStagingBatch } from '../services/source-doc-store.service.js';
import {
  assignDataRoomFiles,
  projectByDocType,
  projectByLoan,
  projectByCategory,
  listPoolDocs,
  getDataRoomDoc,
  holdStagedFiles,
  listHeldDocs,
  getHeldDoc,
  identifyHeldDoc,
  deleteHeldDoc,
  pinDataRoomDoc,
  unpinDataRoomDoc,
  type DataRoomAssignment,
  type HoldStagedFile,
} from '../services/data-room-store.service.js';
import {
  classifyFileCascade,
  verdictFor,
  type PathClassifyHints,
} from '../services/data-room-classify.service.js';
import { unpackZipToSandbox, looksLikeFolderZip } from '../services/data-room/unpack-zip.service.js';
import { promises as fsp } from 'node:fs';
import { DocumentReadStateStore } from '../storage/document-read-state-store.js';
import { PoolStore } from '../storage/pool-store.js';
import { enqueueUnderwriteOnSettle } from '../services/pool/batch-settle-fanout.service.js';
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
  // Track sandbox cleanups so the finally always rm -rf's every unpacked archive
  // once its validated bytes have been staged into the content-addressed store.
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const poolId = req.params.poolId!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'At least one file is required.' });
      return;
    }

    // ── poolLoans fetched ONCE per batch (loan-axis classify for BOTH loose
    //    filenames and zip entry paths). NOT re-fetched per file/per entry. ──
    const poolLoans = poolStore().listLoanNameKeysForPool(poolId as PoolId);

    // ── Data Room v2 Piece B, Phase 3 — zip-unpack ⟶ path-classify ⟶ the SAME
    //    staging seam ────────────────────────────────────────────────────────
    // Build ONE unified list of staged inputs from BOTH loose uploads and zip
    // entries, each carrying the ClassifyHints (+ contradiction flag) that will
    // seed the verdict. The zip is only a DELIVERY mechanism: a validated entry
    // is staged exactly like a loose file (bytes + leaf display name), then it
    // rides the identical createStagingBatch → verdictFor → assignDataRoomFiles →
    // persist → enqueue path. No new seam, no second truth-table.
    interface StagedInput {
      readonly buffer: Buffer;
      readonly originalFileName: string; // leaf, for display
      readonly mimeType: string;
      readonly hints: PathClassifyHints;
    }
    const stagedInputs: StagedInput[] = [];
    let rejectedCount = 0; // Phase-1 rejected[] entries: COUNTED, routed NOWHERE.

    // ── isZip: cheap checks FIRST, magic-byte peek ONLY if they miss. ─────────
    // ★ ROOT-CAUSE FIX: a real zip can arrive with its `.zip` extension stripped
    // and a generic octet-stream mime (Isabelle's "Sunroad Zip"). The extension +
    // mime tiers catch the labeled case with zero byte-reads; the magic-byte tier
    // (`looksLikeFolderZip`) catches the STRIPPED case by peeking the bytes we
    // already hold — and CRITICALLY excludes Office Open XML containers
    // (.xlsx/.docx/.pptx are zips too) so a stripped-extension spreadsheet routes
    // as a DOCUMENT, never explodes into its XML parts.
    const isZip = async (f: Express.Multer.File): Promise<boolean> => {
      // Tier 1 — extension (cheapest, no byte read).
      if (/\.zip$/i.test(f.originalname)) return true;
      // Tier 2 — declared zip mime.
      const mime = f.mimetype.toLowerCase();
      if (mime === 'application/zip' || mime === 'application/x-zip-compressed') {
        return true;
      }
      // Tier 3 — magic bytes + Office-container exclusion (buffer already in hand;
      // a 4-byte signature check + central-directory name peek, not a full read).
      return await looksLikeFolderZip(f.buffer);
    };

    // ── UNIFIED classify cascade (Data-Room content-routing SLICE 1) ──────────
    // ONE path for loose drops AND zip entries. `classifyFileCascade` runs the
    // per-axis cascade folder(zip top folder)→filename→content, first-confident-
    // wins, with the tier-3 CONTENT scan (page-1 text) as a parse-once fallback
    // reached only when the folder+filename tiers leave an axis unresolved. The
    // bytes are ALREADY in hand here (loose `f.buffer`; zip entry read from the
    // sandbox), so the content tier scans them directly — no re-read. Loose and
    // zip differ ONLY in whether an `internalPath` (folder tier) is present.
    for (const f of files) {
      if (await isZip(f)) {
        // Fail-closed unpack. rejected[] entries never reach classify/stage/assign.
        const unpacked = await unpackZipToSandbox(f.buffer);
        cleanups.push(unpacked.cleanup);
        rejectedCount += unpacked.rejected.length;
        for (const entry of unpacked.files) {
          const bytes = await fsp.readFile(entry.sandboxPath);
          const leaf = entry.internalPath.split('/').filter((s) => s.length > 0).pop() ?? entry.internalPath;
          stagedInputs.push({
            buffer: bytes,
            originalFileName: leaf,
            // Best-effort mime from the multer part is meaningless for an inner
            // entry; the store never routes on it. Keep octet-stream.
            mimeType: 'application/octet-stream',
            hints: await classifyFileCascade(
              { internalPath: entry.internalPath, fileName: leaf, bytes },
              poolLoans,
            ),
          });
        }
      } else {
        // Loose file: no folder tier (internalPath omitted) → filename→content.
        stagedInputs.push({
          buffer: f.buffer,
          originalFileName: f.originalname,
          mimeType: f.mimetype,
          hints: await classifyFileCascade(
            { fileName: f.originalname, bytes: f.buffer },
            poolLoans,
          ),
        });
      }
    }

    const unpackedCount = stagedInputs.length;

    if (unpackedCount === 0) {
      // Every dropped file was a zip whose every entry was rejected (or empty).
      // Nothing to stage; report the rejected count so the UI can surface it.
      res.status(201).json({
        batch: { batchId: null, createdAt: new Date().toISOString(), files: [] },
        routing: [],
        autoRouted: [],
        summary: { unpackedCount: 0, autoRoutedCount: 0, needConfirmCount: 0, rejectedCount },
        underwriting: { settled: false, affectedLoans: [], enqueuedCount: 0, jobs: [] },
      });
      return;
    }

    const batch = await createStagingBatch({
      files: stagedInputs.map((s) => ({
        buffer: s.buffer,
        originalFileName: s.originalFileName,
        mimeType: s.mimeType,
      })),
    });

    // ── Data-Room Phase 2c — classify-on-stage → auto-route or hint ──────────
    // Two independent deterministic classifiers per input; BOTH-confident AND no
    // contradiction → auto-file via the SAME assignDataRoomFiles seam the manual
    // tray uses (no parallel path). Every other cell stays staged, pre-filled with
    // whatever WAS confident (the confirm tray seeds from these hints). A Phase-2
    // path CONTRADICTION forces the tray even when both axes resolved — a
    // contradiction must never auto-file.
    const autoAssignments: DataRoomAssignment[] = [];
    // Per-file verdict surfaced to the UI, keyed by stagingId.
    const routing: Array<{
      stagingId: string;
      auto: boolean; // auto-filed on stage → skips the tray
      prefill: { docType?: string; loanInPoolId?: string };
    }> = [];

    for (let i = 0; i < batch.files.length; i++) {
      const f = batch.files[i]!;
      const hints = stagedInputs[i]!.hints;
      const verdict = verdictFor(hints.docType, hints.loanInPoolId);
      // A cross-check contradiction demotes an otherwise-auto verdict to confirm:
      // the docType/loan hints are still the best pre-fill, but a folder-vs-docType
      // disagreement must be human-confirmed, never auto-filed.
      const contradicted = hints.contradiction === true;
      const auto = verdict.action === 'auto' && !contradicted;
      if (
        auto &&
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
        auto,
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

    // ── Data-Room content-routing SLICE 3 — DURABLE never-reject ──────────────
    // Every file the cascade did NOT auto-route is ACCEPTED + KEPT in the durable
    // HELD ("needs identification") set — never dropped, never left only in the
    // transient staging batch. It carries whatever PARTIAL hints the cascade found
    // (docType and/or loan, plus the browse category), so the human resolves it
    // pre-filled. Bytes ride the content-addressed blob store (idempotent). The
    // held files STILL ride the confirm-tray response (`batch.files` /`routing`)
    // for the immediate in-batch UX, but they are ALSO now durable in cre.db so a
    // restart / batch-expiry never discards them. Security-rejected zip entries
    // never reach here — they were refused at the unpack gate (rejectedCount).
    const heldToPersist: HoldStagedFile[] = [];
    for (let i = 0; i < batch.files.length; i++) {
      const f = batch.files[i]!;
      if (autoRoutedIds.has(f.stagingId)) continue; // routed → data_room_doc, not held
      const staged = stagedInputs[i]!;
      heldToPersist.push({
        stagingId: f.stagingId,
        buffer: staged.buffer,
        originalFileName: staged.originalFileName,
        mimeType: staged.mimeType,
        hintDocType: staged.hints.docType,
        hintLoanInPoolId: staged.hints.loanInPoolId,
        hintCategory: staged.hints.categoryHint ?? null,
      });
    }
    const heldResults =
      heldToPersist.length > 0 ? await holdStagedFiles({ poolId, files: heldToPersist }) : [];

    // ── Data-Room Phase 3, P3 — batch-settled DURABLE enqueue (settle path a). ─
    // When Phase-2 auto-routing files EVERY dropped file (nothing left for the
    // confirm tray), the batch is SETTLED on this one request → ENQUEUE one
    // durable underwrite_job per distinct affected loan (dedup — one active job
    // per loan), then RETURN FAST. The in-process worker drains off the request
    // path; a restart re-claims any in-flight job. A batch with any file still
    // needing confirm is NOT settled → nothing enqueues here (it enqueues on the
    // later POST /assign that confirms the last file). We do NOT wait on the LLM.
    const fan = enqueueUnderwriteOnSettle(poolId, batch.batchId, { poolStore: poolStore() });

    res.status(201).json({
      // Only the confirm-needed files ride in `batch.files` so the tray never
      // shows an already-filed doc; auto-routed files appear under their folder
      // on the next projection refresh.
      batch: { ...batch, files: stagedForConfirm },
      routing: routingForConfirm,
      autoRouted: autoResults.filter((r) => r.status === 'assigned'),
      // Data Room v2 Piece B, Phase 3 — the widened summary (P4 renders it):
      //   unpackedCount   staged inputs (loose files + validated zip entries)
      //   autoRoutedCount both-confident, no-contradiction → auto-filed
      //   needConfirmCount left in the confirm tray
      //   rejectedCount   Phase-1 security-rejected zip entries (routed NOWHERE)
      summary: {
        unpackedCount,
        autoRoutedCount: autoRoutedIds.size,
        needConfirmCount: stagedForConfirm.length,
        rejectedCount,
        // SLICE 3: how many of the non-auto files were durably HELD (needs-ID).
        // ★ COUNT RECONCILIATION: accepted (unpackedCount) == autoRoutedCount +
        // heldCount, always (every accepted file is routed OR held — none dropped).
        // rejectedCount is SEPARATE — those never entered (refused at the gate).
        heldCount: heldResults.filter((r) => r.status === 'held').length,
      },
      // P3: which loans (if any) the settle just enqueued into underwriting.
      underwriting: {
        settled: fan.settled,
        affectedLoans: fan.affectedLoans,
        enqueuedCount: fan.enqueuedCount,
        jobs: fan.jobs,
      },
    });
  } catch (err: any) {
    console.error('data-room staging upload error:', err);
    res.status(500).json({ error: 'staging_upload_failed', message: err?.message ?? String(err) });
  } finally {
    // rm -rf every unpacked archive's sandbox. The validated bytes are already
    // in the content-addressed store (staged), so the sandbox is disposable. Run
    // AFTER staging (success OR error) so no unvalidated bytes linger on disk.
    for (const cleanup of cleanups) {
      await cleanup().catch(() => { /* best-effort */ });
    }
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

    // ── Data-Room Phase 3, P3 — batch-settled DURABLE enqueue (settle path b). ─
    // Confirming tray files may have just assigned the LAST unassigned file in the
    // batch → the batch is now SETTLED. ENQUEUE one durable underwrite_job per
    // distinct affected loan (dedup — one active job per loan) and RETURN FAST; the
    // in-process worker drains off the request path, a restart re-claims in-flight
    // jobs. If any file is still tray-pending (this confirm didn't cover the whole
    // batch), the batch is NOT settled → nothing enqueues.
    const fan = enqueueUnderwriteOnSettle(poolId, batchId, { poolStore: poolStore() });

    res.json({
      results,
      underwriting: {
        settled: fan.settled,
        affectedLoans: fan.affectedLoans,
        enqueuedCount: fan.enqueuedCount,
        jobs: fan.jobs,
      },
    });
  } catch (err: any) {
    console.error('data-room assign error:', err);
    res.status(500).json({ error: 'assign_failed', message: err?.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// Data-Room content-routing SLICE 3 — the DURABLE HELD ("needs identification")
// set + human resolution (held → routed).
//
//   GET  /:poolId/held                     the needs-identification set + count
//   GET  /:poolId/held/:fileHash           stream one held doc's bytes
//   POST /:poolId/held/:fileHash/identify  assign (loan, docType) → MOVE to routed
//
// A held file is one the cascade could not confidently identify — accepted +
// kept durably, surfaced here with its partial hints. Identify moves it into
// data_room_doc (routed) → it underwrites on settle. A clean move (persist-to-doc
// then delete-from-held). Security-rejected zip entries never reach this set.
// ---------------------------------------------------------------------------

dataRoomRoutes.get('/:poolId/held', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const poolId = req.params.poolId!;
  const held = listHeldDocs(poolId);
  res.json({ poolId, held, count: held.length });
});

dataRoomRoutes.get('/:poolId/held/:fileHash', async (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { poolId, fileHash } = req.params as { poolId: string; fileHash: string };
  const found = await getHeldDoc(poolId, fileHash);
  if (!found) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', found.held.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(found.held.fileName)}"`);
  res.setHeader('Content-Length', String(found.bytes.length));
  res.send(found.bytes);
});

dataRoomRoutes.post('/:poolId/held/:fileHash/identify', async (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { poolId, fileHash } = req.params as { poolId: string; fileHash: string };
  const body = req.body as { loanInPoolId?: string; docType?: string; notes?: string } | undefined;
  const loanInPoolId = typeof body?.loanInPoolId === 'string' ? body.loanInPoolId : null;
  const docType = typeof body?.docType === 'string' ? body.docType : null;
  if (!loanInPoolId || !docType) {
    res.status(400).json({ error: 'invalid_body', message: '`loanInPoolId` and `docType` are required.' });
    return;
  }

  const result = await identifyHeldDoc({
    poolId,
    fileHash,
    loanInPoolId,
    docType,
    ...(typeof body?.notes === 'string' ? { notes: body.notes } : {}),
  });
  if (result.status === 'error') {
    const status = result.error === 'held_doc_not_found' ? 404 : 400;
    res.status(status).json({ error: result.error ?? 'identify_failed' });
    return;
  }

  // The file just moved held → routed. If assigning it settled its original
  // batch, the underwrite enqueue happens on the confirming POST /assign path; a
  // manual identify is an out-of-band resolution of a genuinely-unidentified file,
  // so it routes the doc (eligible for the underwrite queue on the next settle)
  // without re-deriving a batch here.
  res.json({ result });
});

// ---------------------------------------------------------------------------
// RETRY-HELD — re-process an already-held blob through the (now magic-byte-fixed)
// gate WITHOUT re-uploading.
//
//   POST /:poolId/held/:fileHash/retry
//
// ★ WHY: a real zip that arrived with its `.zip` extension stripped
// (application/octet-stream) fell through the OLD extension+mime-only gate → it
// was HELD as one opaque 52.8 MB blob, never unpacked. Now that `looksLikeFolderZip`
// recognizes it by its bytes, this route fetches the held bytes, runs the SAME
// unpack → classify-cascade → auto-route / durable-hold pipeline the /staging
// route uses (no second truth-table), then — iff the retry actually resolved into
// unpacked entries — DELETES the original opaque held row (it's now split into
// routed docs / per-entry held rows). If the blob still can't be treated as a
// folder zip (e.g. it's genuinely a single document), it stays held untouched.
// ---------------------------------------------------------------------------

dataRoomRoutes.post('/:poolId/held/:fileHash/retry', async (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { poolId, fileHash } = req.params as { poolId: string; fileHash: string };

  const cleanups: Array<() => Promise<void>> = [];
  try {
    const found = await getHeldDoc(poolId, fileHash);
    if (!found) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Run the NOW-FIXED gate on the held bytes (extension is already stripped —
    // the held fileName carries no `.zip`, mime is octet-stream — so this is
    // exactly the magic-byte path). If it's not a folder zip, leave it held.
    if (!(await looksLikeFolderZip(found.bytes))) {
      res.status(409).json({
        error: 'not_a_folder_zip',
        message:
          'The held file is not a folder zip (no ZIP magic bytes, or it is an Office document). Left held.',
      });
      return;
    }

    const poolLoans = poolStore().listLoanNameKeysForPool(poolId as PoolId);

    // Fail-closed unpack → validated entries only (rejected entries never route).
    const unpacked = await unpackZipToSandbox(found.bytes);
    cleanups.push(unpacked.cleanup);
    const rejectedCount = unpacked.rejected.length;

    interface StagedInput {
      readonly buffer: Buffer;
      readonly originalFileName: string;
      readonly mimeType: string;
      readonly hints: PathClassifyHints;
    }
    const stagedInputs: StagedInput[] = [];
    for (const entry of unpacked.files) {
      const bytes = await fsp.readFile(entry.sandboxPath);
      const leaf =
        entry.internalPath.split('/').filter((s) => s.length > 0).pop() ?? entry.internalPath;
      stagedInputs.push({
        buffer: bytes,
        originalFileName: leaf,
        mimeType: 'application/octet-stream',
        hints: await classifyFileCascade(
          { internalPath: entry.internalPath, fileName: leaf, bytes },
          poolLoans,
        ),
      });
    }

    const unpackedCount = stagedInputs.length;
    if (unpackedCount === 0) {
      // A folder zip whose every entry was rejected/empty. Nothing to route; the
      // original held blob is NOT deleted (nothing resolved it).
      res.status(200).json({
        retried: fileHash,
        resolved: false,
        summary: { unpackedCount: 0, autoRoutedCount: 0, heldCount: 0, rejectedCount },
      });
      return;
    }

    // Stage the validated entries through the SAME batch primitive.
    const batch = await createStagingBatch({
      files: stagedInputs.map((s) => ({
        buffer: s.buffer,
        originalFileName: s.originalFileName,
        mimeType: s.mimeType,
      })),
    });

    // Auto-route both-confident, non-contradicted entries via the SAME assign seam.
    const autoAssignments: DataRoomAssignment[] = [];
    for (let i = 0; i < batch.files.length; i++) {
      const f = batch.files[i]!;
      const hints = stagedInputs[i]!.hints;
      const verdict = verdictFor(hints.docType, hints.loanInPoolId);
      const auto = verdict.action === 'auto' && hints.contradiction !== true;
      if (auto && verdict.prefill.docType && verdict.prefill.loanInPoolId) {
        autoAssignments.push({
          stagingId: f.stagingId,
          loanInPoolId: verdict.prefill.loanInPoolId,
          docType: verdict.prefill.docType,
        });
      }
    }
    const autoResults =
      autoAssignments.length > 0
        ? await assignDataRoomFiles({ poolId, batchId: batch.batchId, assignments: autoAssignments })
        : [];
    const autoRoutedIds = new Set(
      autoResults.filter((r) => r.status === 'assigned').map((r) => r.stagingId),
    );

    // Everything not auto-routed is durably HELD (as a per-entry needs-ID row) —
    // never dropped. This is the SLICE-3 never-reject discipline unchanged.
    const heldToPersist: HoldStagedFile[] = [];
    for (let i = 0; i < batch.files.length; i++) {
      const f = batch.files[i]!;
      if (autoRoutedIds.has(f.stagingId)) continue;
      const staged = stagedInputs[i]!;
      heldToPersist.push({
        stagingId: f.stagingId,
        buffer: staged.buffer,
        originalFileName: staged.originalFileName,
        mimeType: staged.mimeType,
        hintDocType: staged.hints.docType,
        hintLoanInPoolId: staged.hints.loanInPoolId,
        hintCategory: staged.hints.categoryHint ?? null,
      });
    }
    const heldResults =
      heldToPersist.length > 0 ? await holdStagedFiles({ poolId, files: heldToPersist }) : [];

    // The opaque archive is now fully resolved into routed docs + per-entry held
    // rows → remove the ORIGINAL held row. Ordered AFTER the entries persist so a
    // crash can only leave the archive both resolved AND still-held (recoverable,
    // a re-retry is a no-op), never lose the entries.
    deleteHeldDoc(poolId, fileHash);

    // A settle may now be due (auto-routed entries can complete a loan).
    const fan = enqueueUnderwriteOnSettle(poolId, batch.batchId, { poolStore: poolStore() });

    res.status(200).json({
      retried: fileHash,
      resolved: true,
      summary: {
        unpackedCount,
        autoRoutedCount: autoRoutedIds.size,
        heldCount: heldResults.filter((r) => r.status === 'held').length,
        rejectedCount,
      },
      autoRouted: autoResults.filter((r) => r.status === 'assigned'),
      underwriting: {
        settled: fan.settled,
        affectedLoans: fan.affectedLoans,
        enqueuedCount: fan.enqueuedCount,
        jobs: fan.jobs,
      },
    });
  } catch (err: any) {
    console.error('data-room retry-held error:', err);
    res.status(500).json({ error: 'retry_held_failed', message: err?.message ?? String(err) });
  } finally {
    for (const cleanup of cleanups) {
      await cleanup().catch(() => { /* best-effort */ });
    }
  }
});

// ---------------------------------------------------------------------------
// Data-Room content-routing SLICE 4 — the manual PIN override (available, never
// required). Pin a specific version (file_hash) of a (loan, docType) slot as the
// underwrite winner, overriding the latest-content-date tiebreak. Default (no
// pin) = latest-content-date wins, zero human action.
//
//   POST /:poolId/loans/:loanInPoolId/pin     { docType, fileHash }  → pin
//   POST /:poolId/loans/:loanInPoolId/unpin   { docType }            → unpin
// ---------------------------------------------------------------------------

dataRoomRoutes.post('/:poolId/loans/:loanInPoolId/pin', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { poolId, loanInPoolId } = req.params as { poolId: string; loanInPoolId: string };
  const body = req.body as { docType?: string; fileHash?: string } | undefined;
  const docType = typeof body?.docType === 'string' ? body.docType : null;
  const fileHash = typeof body?.fileHash === 'string' ? body.fileHash : null;
  if (!docType || !fileHash) {
    res.status(400).json({ error: 'invalid_body', message: '`docType` and `fileHash` are required.' });
    return;
  }
  const result = pinDataRoomDoc({ poolId, loanInPoolId, docType, fileHash });
  if (result.status === 'error') {
    const status = result.error === 'doc_not_found' ? 404 : 400;
    res.status(status).json({ error: result.error ?? 'pin_failed' });
    return;
  }
  res.json({ result });
});

dataRoomRoutes.post('/:poolId/loans/:loanInPoolId/unpin', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { poolId, loanInPoolId } = req.params as { poolId: string; loanInPoolId: string };
  const body = req.body as { docType?: string } | undefined;
  const docType = typeof body?.docType === 'string' ? body.docType : null;
  if (!docType) {
    res.status(400).json({ error: 'invalid_body', message: '`docType` is required.' });
    return;
  }
  const result = unpinDataRoomDoc({ poolId, loanInPoolId, docType });
  if (result.status === 'error') {
    res.status(400).json({ error: result.error ?? 'unpin_failed' });
    return;
  }
  res.json({ result });
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

// ---------------------------------------------------------------------------
// By-CATEGORY SUMMARY (Data-Room v2 — Piece D: the category-control surface).
//
// ★ ANTI-BOMBARDMENT: this returns per-category COUNTS ONLY — never the file
// list. A pool holds thousands of files; the room's default surface is the five
// CATEGORIES, so this route ships {category, count, unreadCount}, never rows.
// The drill-in to a category's files reuses the existing by-doc-type / by-loan
// projections scoped client-side; this route stays a pure summary.
//
// count       — from projectByCategory(poolId) (reads the INDEXED data_room_doc
//               table via listPoolDocs → docStore(); no O(N) JSON rewrite).
// unreadCount — server-side, per category, from the SAME per-user read cursor
//               the /unread route uses (readStateStore().readSet): intersect
//               each category's file hashes with the user's UNREAD set. Auth-
//               gated; actor is req.user.userId (never client-supplied).
//
// Every category in CATEGORIES_IN_ORDER is emitted — including ones with zero
// docs (count 0 / unreadCount 0) — so the UI's five-card shape is stable and a
// category never silently vanishes. projectByCategory only emits categories the
// pool has docs for, so we fold its groups into a full CATEGORIES_IN_ORDER map.
// ---------------------------------------------------------------------------

dataRoomRoutes.get('/:poolId/by-category', (req: Request, res: Response) => {
  const uid = userId(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const poolId = req.params.poolId!;
  const groups = projectByCategory(poolId);
  const read = readStateStore().readSet(uid);

  const byCategory = new Map(groups.map((g) => [g.category, g.docs] as const));
  const summary = CATEGORIES_IN_ORDER.map((category) => {
    const docs = byCategory.get(category) ?? [];
    // Unread = a doc the user hasn't marked read (mirror /unread's set math).
    const unreadCount = docs.reduce((n, d) => n + (read.has(d.fileHash) ? 0 : 1), 0);
    return { category, count: docs.length, unreadCount };
  });

  res.json({ poolId, categories: summary });
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

  // Optional ?category= filter — download just one category's folder. Validated
  // against CATEGORIES_IN_ORDER (the ONE source); unknown category → 400.
  const rawCategory = typeof req.query.category === 'string' ? req.query.category : null;
  let categoryFilter: DocTypeCategory | null = null;
  if (rawCategory !== null) {
    if (!(CATEGORIES_IN_ORDER as readonly string[]).includes(rawCategory)) {
      res.status(400).json({
        error: 'invalid_category',
        message: `Unknown category '${rawCategory}'.`,
        validCategories: CATEGORIES_IN_ORDER,
      });
      return;
    }
    categoryFilter = rawCategory as DocTypeCategory;
  }

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
    // CATEGORY-FIRST path tree: category resolved via DOC_TYPE_CATEGORY (the ONE
    // source), so downloading lands a Category/ folder on disk. Unknown docType
    // (should never happen — assign validates) falls back to 'General'.
    const category = DOC_TYPE_CATEGORY[entry.docType] ?? 'General';
    if (categoryFilter !== null && category !== categoryFilter) continue;
    const got = await getDataRoomDoc(poolId, nd.fileHash);
    if (!got) continue;
    // Prefix with category + loan + docType so the zip is a category-organized
    // folder tree on disk (Legal/, Third-Party Reports/, …).
    archive.append(got.bytes, {
      name: `${category}/${entry.loanInPoolId}/${entry.docType}/${entry.fileName}`,
    });
  }
  await archive.finalize();

  // Advance the cursor AFTER a successful pull (streamed above). Only advance
  // when there was something to sync so a repeated pull with nothing new is a
  // no-op that still returns an (empty) zip.
  if (nextCursor !== null && newDocs.length > 0) {
    store.setCursor(uid, poolId, nextCursor);
  }
});
