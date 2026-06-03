/**
 * Source-document intake store.
 *
 * Per-deal typed storage of source documents that pair with completed
 * HistoricalUnderwriting workbooks. Pure I/O — JSON-manifest + content-
 * addressed blobs on disk. Mirrors the persistence pattern in
 * uw-intelligence.service.ts (atomic JSON writes + dedicated upload dir).
 *
 * Disk layout:
 *   .data/source-docs/source-doc-manifests.json
 *   .data/source-docs/<historicalUwId>/<slot>/<fileHash>.<ext>
 *   .data/source-docs/_staging/<batchId>/<stagingId>.<ext>
 *
 * Identity discipline:
 *   - historicalUwId is the FK; we read .data/historical-uws.json (the same
 *     file uw-intelligence.service.ts persists to) to validate.
 *   - files are content-addressed by SHA-256 of bytes.
 *   - manifest entries are unique per (historicalUwId, slot, fileHash).
 *     Re-upload of the same bytes is idempotent.
 *
 * Atomicity:
 *   - manifest writes go through writeManifestFile() which writes to a
 *     <file>.tmp then renames; single-writer (admin tool).
 *   - blob writes use <path>.tmp + rename so a partial write is never
 *     visible at the canonical path.
 *
 * NOT wired to extraction or ingest. The producer pipeline never reads
 * from .data/source-docs/. This module is intentionally outside the §2.3
 * extraction-reader scope — it does not depend on data-extraction.service
 * and is not depended-on by doctrine/valuation/stress/cross-check/resolver.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  SOURCE_DOC_SLOTS,
  REQUIRED_SOURCE_DOC_SLOTS,
  type SourceDocSlot,
  type SourceDocEntry,
  type DealSourceDocManifest,
  type SourceDocManifestFile,
  type DealCompleteness,
  type DealSlotStatus,
  type StagingBatch,
  type StagingFileEntry,
  type StagingAssignment,
  type StagingAssignmentResult,
} from '@cre/shared';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(process.cwd(), '.data');
const SOURCE_DOCS_DIR = path.join(DATA_DIR, 'source-docs');
const MANIFEST_FILE = path.join(SOURCE_DOCS_DIR, 'source-doc-manifests.json');
const STAGING_DIR = path.join(SOURCE_DOCS_DIR, '_staging');
const HISTORICAL_UWS_FILE = path.join(DATA_DIR, 'historical-uws.json');

// Test override hook (used by test-source-doc-intake.ts). Production code
// MUST NOT call setDataRoot — it is a deliberate seam, not an API.
let dataRootOverride: string | null = null;
export function setDataRoot(root: string | null): void {
  dataRootOverride = root;
}
function dataDir(): string {
  return dataRootOverride ?? DATA_DIR;
}
function sourceDocsDir(): string {
  return path.join(dataDir(), 'source-docs');
}
function manifestFile(): string {
  return path.join(sourceDocsDir(), 'source-doc-manifests.json');
}
function stagingDir(): string {
  return path.join(sourceDocsDir(), '_staging');
}
function historicalUwsFile(): string {
  return path.join(dataDir(), 'historical-uws.json');
}

// ---------------------------------------------------------------------------
// Directory bootstrap
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
  if (!fs.existsSync(sourceDocsDir())) fs.mkdirSync(sourceDocsDir(), { recursive: true });
  if (!fs.existsSync(stagingDir())) fs.mkdirSync(stagingDir(), { recursive: true });
}

function ensureDealSlotDir(historicalUwId: string, slot: SourceDocSlot): string {
  ensureDirs();
  const dealDir = path.join(sourceDocsDir(), historicalUwId);
  const slotDir = path.join(dealDir, slot);
  if (!fs.existsSync(slotDir)) fs.mkdirSync(slotDir, { recursive: true });
  return slotDir;
}

function ensureStagingBatchDir(batchId: string): string {
  ensureDirs();
  const d = path.join(stagingDir(), batchId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// Manifest I/O — single-writer; atomic write via tmp-rename
// ---------------------------------------------------------------------------

function emptyManifestFile(): SourceDocManifestFile {
  return { version: 1, manifests: [] };
}

function readManifestFile(): SourceDocManifestFile {
  ensureDirs();
  const file = manifestFile();
  if (!fs.existsSync(file)) return emptyManifestFile();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      Array.isArray(parsed.manifests)
    ) {
      return parsed as SourceDocManifestFile;
    }
    return emptyManifestFile();
  } catch {
    return emptyManifestFile();
  }
}

function writeManifestFile(file: SourceDocManifestFile): void {
  ensureDirs();
  const target = manifestFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeFileHash(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extFromFileName(originalFileName: string): string {
  const ext = path.extname(originalFileName).toLowerCase();
  return ext; // includes leading dot, e.g. ".pdf"; '' for no extension
}

function blobPath(historicalUwId: string, slot: SourceDocSlot, fileHash: string, ext: string): string {
  return path.join(sourceDocsDir(), historicalUwId, slot, `${fileHash}${ext}`);
}

function writeBlobAtomically(targetPath: string, buf: Buffer): void {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, targetPath);
}

function isSourceDocSlot(s: unknown): s is SourceDocSlot {
  return typeof s === 'string' && (SOURCE_DOC_SLOTS as ReadonlyArray<string>).includes(s);
}

function isRequiredSlot(slot: SourceDocSlot): boolean {
  return (REQUIRED_SOURCE_DOC_SLOTS as ReadonlyArray<string>).includes(slot);
}

function emptySlots(): DealSourceDocManifest['slots'] {
  return {
    asr: [],
    cf: [],
    rent_roll: [],
    pca: [],
    seller_uw: [],
    t12: [],
    appraisal: [],
  };
}

// ---------------------------------------------------------------------------
// HistoricalUnderwriting FK validation
// ---------------------------------------------------------------------------

/**
 * Read .data/historical-uws.json (the file uw-intelligence.service.ts owns)
 * and return a (id -> dealName) lookup. We read fresh each call to avoid a
 * stale cache when a new deal is uploaded mid-session. The file is ~700KB
 * and reads are infrequent.
 *
 * Format: array of [id, record] tuples — matches Map.entries() output of
 * uw-intelligence.service.ts.
 */
function readHistoricalUwsIndex(): Map<string, { id: string; dealName: string }> {
  const out = new Map<string, { id: string; dealName: string }>();
  const file = historicalUwsFile();
  if (!fs.existsSync(file)) return out;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (
          Array.isArray(entry) &&
          entry.length >= 2 &&
          typeof entry[0] === 'string' &&
          entry[1] &&
          typeof entry[1] === 'object'
        ) {
          const id = entry[0];
          const rec = entry[1] as { id?: string; dealName?: string };
          out.set(id, {
            id,
            dealName: typeof rec.dealName === 'string' ? rec.dealName : id,
          });
        }
      }
    }
  } catch {
    // swallow — return what we got
  }
  return out;
}

export class HistoricalUwNotFoundError extends Error {
  readonly historicalUwId: string;
  constructor(historicalUwId: string) {
    super(`HistoricalUnderwriting record not found: ${historicalUwId}`);
    this.name = 'HistoricalUwNotFoundError';
    this.historicalUwId = historicalUwId;
  }
}

export class InvalidSlotError extends Error {
  readonly slot: string;
  readonly validSlots: ReadonlyArray<SourceDocSlot>;
  constructor(slot: string) {
    super(`Invalid source-doc slot: ${slot}`);
    this.name = 'InvalidSlotError';
    this.slot = slot;
    this.validSlots = SOURCE_DOC_SLOTS;
  }
}

function assertHistoricalUwIdExists(
  historicalUwId: string,
  index: Map<string, { id: string; dealName: string }> = readHistoricalUwsIndex(),
): { id: string; dealName: string } {
  const rec = index.get(historicalUwId);
  if (!rec) throw new HistoricalUwNotFoundError(historicalUwId);
  return rec;
}

function assertValidSlot(slot: string): SourceDocSlot {
  if (!isSourceDocSlot(slot)) throw new InvalidSlotError(slot);
  return slot;
}

// ---------------------------------------------------------------------------
// Manifest mutation
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function getOrCreateDealManifest(
  file: SourceDocManifestFile,
  historicalUwId: string,
  dealName: string,
): { file: SourceDocManifestFile; manifest: DealSourceDocManifest; index: number } {
  const idx = file.manifests.findIndex((m) => m.historicalUwId === historicalUwId);
  if (idx >= 0) {
    return { file, manifest: file.manifests[idx]!, index: idx };
  }
  const now = nowIso();
  const fresh: DealSourceDocManifest = {
    historicalUwId,
    dealName,
    slots: emptySlots(),
    createdAt: now,
    updatedAt: now,
  };
  const nextManifests = [...file.manifests, fresh];
  const nextFile: SourceDocManifestFile = { version: 1, manifests: nextManifests };
  return { file: nextFile, manifest: fresh, index: nextManifests.length - 1 };
}

function withManifestEntryUpserted(
  manifest: DealSourceDocManifest,
  slot: SourceDocSlot,
  entry: SourceDocEntry,
): DealSourceDocManifest {
  const existing = manifest.slots[slot];
  const dupIdx = existing.findIndex((e) => e.fileHash === entry.fileHash);
  let nextSlotEntries: ReadonlyArray<SourceDocEntry>;
  if (dupIdx >= 0) {
    // Idempotent: replace existing entry with refreshed metadata.
    nextSlotEntries = existing.map((e, i) => (i === dupIdx ? entry : e));
  } else {
    nextSlotEntries = [...existing, entry];
  }
  const nextSlots = { ...manifest.slots, [slot]: nextSlotEntries };
  return { ...manifest, slots: nextSlots, updatedAt: nowIso() };
}

function withManifestEntryRemoved(
  manifest: DealSourceDocManifest,
  slot: SourceDocSlot,
  fileHash: string,
): { next: DealSourceDocManifest; removed: boolean } {
  const existing = manifest.slots[slot];
  const idx = existing.findIndex((e) => e.fileHash === fileHash);
  if (idx < 0) return { next: manifest, removed: false };
  const nextSlotEntries = existing.filter((_, i) => i !== idx);
  const nextSlots = { ...manifest.slots, [slot]: nextSlotEntries };
  return {
    next: { ...manifest, slots: nextSlots, updatedAt: nowIso() },
    removed: true,
  };
}

function replaceManifestAt(
  file: SourceDocManifestFile,
  index: number,
  next: DealSourceDocManifest,
): SourceDocManifestFile {
  const arr = file.manifests.slice();
  arr[index] = next;
  return { version: 1, manifests: arr };
}

// ---------------------------------------------------------------------------
// Public API — single-file uploads
// ---------------------------------------------------------------------------

export interface UploadSourceDocArgs {
  readonly historicalUwId: string;
  readonly slot: SourceDocSlot;
  readonly buffer: Buffer;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly notes?: string;
}

export async function uploadSourceDoc(args: UploadSourceDocArgs): Promise<SourceDocEntry> {
  const slot = assertValidSlot(args.slot);
  const deal = assertHistoricalUwIdExists(args.historicalUwId);

  const fileHash = computeFileHash(args.buffer);
  const ext = extFromFileName(args.originalFileName);

  const slotDir = ensureDealSlotDir(deal.id, slot);
  const target = path.join(slotDir, `${fileHash}${ext}`);

  // Content-addressed: if the same bytes already exist at the path, skip the
  // write but still update the manifest entry (refresh uploadedAt + notes +
  // originalFileName).
  if (!fs.existsSync(target)) {
    writeBlobAtomically(target, args.buffer);
  }

  const entry: SourceDocEntry = {
    fileHash,
    originalFileName: args.originalFileName,
    size: args.buffer.length,
    mimeType: args.mimeType,
    uploadedAt: nowIso(),
    notes: args.notes ?? null,
  };

  const file0 = readManifestFile();
  const { file: file1, manifest, index } = getOrCreateDealManifest(file0, deal.id, deal.dealName);
  const nextManifest = withManifestEntryUpserted(manifest, slot, entry);
  const file2 = replaceManifestAt(file1, index, nextManifest);
  writeManifestFile(file2);

  return entry;
}

export interface DeleteSourceDocArgs {
  readonly historicalUwId: string;
  readonly slot: SourceDocSlot;
  readonly fileHash: string;
}

export async function deleteSourceDoc(args: DeleteSourceDocArgs): Promise<boolean> {
  const slot = assertValidSlot(args.slot);
  // For delete, we deliberately allow operating even if the deal is no longer
  // in historical-uws.json — the data should still be cleanable. We only need
  // the path, which is derived directly from historicalUwId.

  const file0 = readManifestFile();
  const idx = file0.manifests.findIndex((m) => m.historicalUwId === args.historicalUwId);
  if (idx < 0) return false;
  const manifest = file0.manifests[idx]!;
  const { next, removed } = withManifestEntryRemoved(manifest, slot, args.fileHash);
  if (!removed) return false;

  const file1 = replaceManifestAt(file0, idx, next);
  writeManifestFile(file1);

  // Best-effort delete of the blob. We don't know the extension, so glob the
  // slot dir for files starting with the hash.
  const slotDir = path.join(sourceDocsDir(), args.historicalUwId, slot);
  if (fs.existsSync(slotDir)) {
    try {
      const candidates = fs.readdirSync(slotDir).filter((n) => n.startsWith(args.fileHash));
      for (const c of candidates) {
        try {
          fs.unlinkSync(path.join(slotDir, c));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API — reads
// ---------------------------------------------------------------------------

export function listAllManifests(): ReadonlyArray<DealSourceDocManifest> {
  return readManifestFile().manifests;
}

export function getDealManifest(historicalUwId: string): DealSourceDocManifest | null {
  return readManifestFile().manifests.find((m) => m.historicalUwId === historicalUwId) ?? null;
}

export function getSourceDocBuffer(args: {
  historicalUwId: string;
  slot: SourceDocSlot;
  fileHash: string;
}): { buffer: Buffer; entry: SourceDocEntry } | null {
  const slot = assertValidSlot(args.slot);
  const manifest = getDealManifest(args.historicalUwId);
  if (!manifest) return null;
  const entry = manifest.slots[slot].find((e) => e.fileHash === args.fileHash);
  if (!entry) return null;

  const slotDir = path.join(sourceDocsDir(), args.historicalUwId, slot);
  if (!fs.existsSync(slotDir)) return null;
  const candidates = fs.readdirSync(slotDir).filter((n) => n.startsWith(args.fileHash));
  if (candidates.length === 0) return null;
  const blobPath = path.join(slotDir, candidates[0]!);
  try {
    const buffer = fs.readFileSync(blobPath);
    return { buffer, entry };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — completeness view
// ---------------------------------------------------------------------------

function completenessFromManifest(
  historicalUwId: string,
  dealName: string,
  manifest: DealSourceDocManifest | null,
): DealCompleteness {
  const slotsStatus: Record<SourceDocSlot, DealSlotStatus> = {} as Record<SourceDocSlot, DealSlotStatus>;
  let total = 0;
  for (const slot of SOURCE_DOC_SLOTS) {
    const count = manifest ? manifest.slots[slot].length : 0;
    total += count;
    slotsStatus[slot] = {
      present: count > 0,
      count,
      required: isRequiredSlot(slot),
    };
  }
  return {
    historicalUwId,
    dealName,
    slots: slotsStatus,
    hasMinimum: slotsStatus.asr.present && slotsStatus.cf.present,
    totalDocsPresent: total,
  };
}

export function getDealCompleteness(historicalUwId: string): DealCompleteness {
  const manifest = getDealManifest(historicalUwId);
  // If the deal has docs, the manifest holds the dealName. Otherwise pull from
  // historical-uws.json. If neither exists, we still produce a completeness
  // view with the id echoed as dealName — informational, never blocking.
  let dealName = manifest?.dealName;
  if (!dealName) {
    const idx = readHistoricalUwsIndex();
    dealName = idx.get(historicalUwId)?.dealName ?? historicalUwId;
  }
  return completenessFromManifest(historicalUwId, dealName, manifest);
}

export function getAllCompleteness(): ReadonlyArray<DealCompleteness> {
  const index = readHistoricalUwsIndex();
  const file = readManifestFile();
  const manifestById = new Map(file.manifests.map((m) => [m.historicalUwId, m]));

  const out: DealCompleteness[] = [];
  const seen = new Set<string>();

  // Every HistoricalUnderwriting record (whether or not it has docs).
  for (const [id, rec] of index.entries()) {
    seen.add(id);
    out.push(completenessFromManifest(id, rec.dealName, manifestById.get(id) ?? null));
  }
  // Orphan manifests (deal was deleted but docs remain) — surface them too so
  // they're not silently invisible.
  for (const m of file.manifests) {
    if (!seen.has(m.historicalUwId)) {
      out.push(completenessFromManifest(m.historicalUwId, m.dealName, m));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API — bulk staging
// ---------------------------------------------------------------------------

export interface CreateStagingBatchArgs {
  readonly files: ReadonlyArray<{
    readonly buffer: Buffer;
    readonly originalFileName: string;
    readonly mimeType: string;
  }>;
}

export async function createStagingBatch(args: CreateStagingBatchArgs): Promise<StagingBatch> {
  const batchId = uuid();
  const batchDir = ensureStagingBatchDir(batchId);
  const now = nowIso();

  const stagedFiles: StagingFileEntry[] = [];
  for (const f of args.files) {
    const stagingId = uuid();
    const fileHash = computeFileHash(f.buffer);
    const ext = extFromFileName(f.originalFileName);
    const target = path.join(batchDir, `${stagingId}${ext}`);
    writeBlobAtomically(target, f.buffer);
    stagedFiles.push({
      stagingId,
      fileHash,
      originalFileName: f.originalFileName,
      size: f.buffer.length,
      mimeType: f.mimeType,
      uploadedAt: now,
    });
  }

  const batch: StagingBatch = {
    batchId,
    createdAt: now,
    files: stagedFiles,
  };

  // Persist the batch metadata next to its blobs so it's reloadable.
  const metaPath = path.join(batchDir, '_batch.json');
  const tmp = `${metaPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(batch, null, 2));
  fs.renameSync(tmp, metaPath);

  return batch;
}

export function getStagingBatch(batchId: string): StagingBatch | null {
  const batchDir = path.join(stagingDir(), batchId);
  const metaPath = path.join(batchDir, '_batch.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) {
      return parsed as StagingBatch;
    }
    return null;
  } catch {
    return null;
  }
}

function findStagedBlobPath(batchId: string, stagingId: string): string | null {
  const batchDir = path.join(stagingDir(), batchId);
  if (!fs.existsSync(batchDir)) return null;
  const candidates = fs.readdirSync(batchDir).filter((n) => n.startsWith(stagingId));
  if (candidates.length === 0) return null;
  return path.join(batchDir, candidates[0]!);
}

export interface AssignStagingFilesArgs {
  readonly batchId: string;
  readonly assignments: ReadonlyArray<StagingAssignment>;
}

/**
 * Assign staged files to (deal, slot). Each assignment is processed
 * independently — a failure in one does NOT abort the others. The response
 * reports per-staging outcomes. Staged blobs that succeed are moved into the
 * deal's slot directory; on failure they remain staged.
 *
 * Idempotent in the same way uploadSourceDoc() is: re-uploading the same
 * bytes to the same (deal, slot) updates the existing manifest entry.
 */
export async function assignStagingFiles(
  args: AssignStagingFilesArgs,
): Promise<ReadonlyArray<StagingAssignmentResult>> {
  const batch = getStagingBatch(args.batchId);
  const results: StagingAssignmentResult[] = [];
  if (!batch) {
    for (const a of args.assignments) {
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: `staging_batch_not_found:${args.batchId}`,
      });
    }
    return results;
  }

  const histIndex = readHistoricalUwsIndex();

  // Mutate the manifest file once at the end of each successful assignment
  // (small N; correctness over throughput).
  for (const a of args.assignments) {
    const stagedFile = batch.files.find((f) => f.stagingId === a.stagingId);
    if (!stagedFile) {
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: 'staged_file_not_found_in_batch',
      });
      continue;
    }

    if (!isSourceDocSlot(a.slot)) {
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: `invalid_slot:${a.slot}`,
      });
      continue;
    }

    const deal = histIndex.get(a.historicalUwId);
    if (!deal) {
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: `historical_uw_not_found:${a.historicalUwId}`,
      });
      continue;
    }

    const blobSource = findStagedBlobPath(args.batchId, a.stagingId);
    if (!blobSource) {
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: 'staged_blob_missing',
      });
      continue;
    }

    try {
      const buffer = fs.readFileSync(blobSource);
      const entry = await uploadSourceDoc({
        historicalUwId: deal.id,
        slot: a.slot,
        buffer,
        originalFileName: stagedFile.originalFileName,
        mimeType: stagedFile.mimeType,
        notes: a.notes,
      });
      // Move-equivalent: delete staged blob after successful upload.
      try { fs.unlinkSync(blobSource); } catch { /* ignore */ }
      results.push({
        stagingId: a.stagingId,
        status: 'assigned',
        historicalUwId: deal.id,
        slot: a.slot,
        fileHash: entry.fileHash,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        stagingId: a.stagingId,
        status: 'error',
        error: msg,
      });
    }
  }

  // Update batch metadata: remove successfully-assigned files from the batch.
  const assignedIds = new Set(
    results.filter((r) => r.status === 'assigned').map((r) => r.stagingId),
  );
  if (assignedIds.size > 0) {
    const remaining = batch.files.filter((f) => !assignedIds.has(f.stagingId));
    const nextBatch: StagingBatch = { ...batch, files: remaining };
    const metaPath = path.join(stagingDir(), batch.batchId, '_batch.json');
    const tmp = `${metaPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nextBatch, null, 2));
    fs.renameSync(tmp, metaPath);
  }

  return results;
}

export async function discardStagingBatch(batchId: string): Promise<boolean> {
  const batchDir = path.join(stagingDir(), batchId);
  if (!fs.existsSync(batchDir)) return false;
  try {
    fs.rmSync(batchDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — slot taxonomy (for UI rendering, no hardcoding)
// ---------------------------------------------------------------------------

export function listSlots(): ReadonlyArray<{ slot: SourceDocSlot; required: boolean }> {
  return SOURCE_DOC_SLOTS.map((slot) => ({
    slot,
    required: isRequiredSlot(slot),
  }));
}
