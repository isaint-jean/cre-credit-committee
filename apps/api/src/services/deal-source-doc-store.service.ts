/**
 * Deal-scoped raw-upload store — records WHICH original uploaded files belong to
 * a per-deal ingest (keyed by rootId / AnalysisId) so a later append can
 * re-supply the prior doc set without forcing a full re-upload.
 *
 * Storage split (maximal reuse, no double-store):
 *   - BYTES  ride the existing content-addressed blobStore (.data/blobs/,
 *     hash-keyed, deduped). build-and-ingest already putBlob()s every slot;
 *     this store calls putBlob() too (idempotent) so it is self-sufficient.
 *   - MAPPING (rootId → which slot/hash/filename) is the only NEW storage: an
 *     atomic JSON manifest at .data/deal-source-docs/deal-doc-manifests.json.
 *
 * NAMESPACE SEPARATION (flag 1): the library store's manifest is
 * .data/source-docs/source-doc-manifests.json keyed by historicalUwId; THIS
 * store's manifest is .data/deal-source-docs/deal-doc-manifests.json keyed by
 * rootId. Separate directories, separate files — a rootId entry can never
 * collide with a historicalUwId entry. (Bytes are shared in .data/blobs/ by
 * content hash, which is correct dedup, not a namespace collision: identical
 * bytes → identical hash → one blob, by design.)
 *
 * RELIABILITY (flag 3): the manifest is the SOURCE OF TRUTH for what is
 * retrievable. saveDealSourceDoc putBlob()s the bytes BEFORE recording them, and
 * any failure THROWS — never a silent half-persist. getDealSourceDocs THROWS if
 * a manifest-listed blob is absent from the blobStore, so a caller (append) can
 * trust the manifest lists exactly what is retrievable.
 *
 * Writes only to .data/deal-source-docs (manifest) + .data/blobs (bytes, via
 * blobStore) — never cre.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceDocSlot } from '@cre/shared';
import { SOURCE_DOC_SLOTS } from '@cre/shared';
import type { ContentHash } from '@cre/contracts';
import { blobStore } from '../storage/blob-store.js';

/** Best-effort MIME from filename extension (multer's mimetype isn't threaded
 *  through takeFile). Re-supply keys on the slot + bytes, not the MIME, so this
 *  is metadata only. */
function mimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.xlsx' || ext === '.xlsm') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  return 'application/octet-stream';
}

// --- Paths (separate namespace) --------------------------------------------
function dealDocsDir(): string {
  return path.join(path.resolve(process.cwd(), '.data'), 'deal-source-docs');
}
function manifestFile(): string {
  return path.join(dealDocsDir(), 'deal-doc-manifests.json');
}

// --- Types (rootId-keyed; distinct from the library DealSourceDocManifest) --
export interface DealRawDocEntry {
  readonly slot: SourceDocSlot;
  readonly fileHash: string; // hex SHA-256 of bytes (the blobStore key)
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string; // ISO-8601
}
export interface DealRawDocManifest {
  readonly rootId: string;
  readonly entries: ReadonlyArray<DealRawDocEntry>;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface DealRawDocManifestFile {
  readonly version: 1;
  readonly manifests: DealRawDocManifest[];
}

// --- Manifest I/O — single source of truth, atomic tmp-rename write ---------
function readManifestFile(): DealRawDocManifestFile {
  const file = manifestFile();
  if (!fs.existsSync(file)) return { version: 1, manifests: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (parsed && parsed.version === 1 && Array.isArray(parsed.manifests)) {
    return parsed as DealRawDocManifestFile;
  }
  throw new Error(`deal-source-doc manifest corrupt at ${file}`);
}
function writeManifestFile(f: DealRawDocManifestFile): void {
  fs.mkdirSync(dealDocsDir(), { recursive: true });
  const target = manifestFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, target);
}

// --- Public API ------------------------------------------------------------
/**
 * Persist one raw upload for a deal. Bytes go to the content-addressed
 * blobStore (idempotent); the (rootId, slot, hash, filename) mapping goes to the
 * manifest. Idempotent per (rootId, slot, fileHash). THROWS on any failure
 * (flag 3). Returns the manifest entry.
 */
export async function saveDealSourceDoc(
  rootId: string,
  slot: SourceDocSlot,
  file: { originalFileName: string; bytes: Buffer },
): Promise<DealRawDocEntry> {
  if (!SOURCE_DOC_SLOTS.includes(slot)) throw new Error(`invalid deal-doc slot: ${slot}`);

  // 1. Bytes FIRST (idempotent, content-addressed). Throws on write failure.
  const fileHash = await blobStore.putBlob(file.bytes);

  const entry: DealRawDocEntry = {
    slot,
    fileHash,
    fileName: file.originalFileName,
    mimeType: mimeFromName(file.originalFileName),
    size: file.bytes.length,
    uploadedAt: new Date().toISOString(),
  };

  // 2. Mapping (atomic). Dedupe per (slot, fileHash); reconstruct immutably.
  const mf = readManifestFile();
  const now = entry.uploadedAt;
  const existing = mf.manifests.find((x) => x.rootId === rootId);
  const base: DealRawDocManifest = existing ?? { rootId, entries: [], createdAt: now, updatedAt: now };
  const without = base.entries.filter((e) => !(e.slot === slot && e.fileHash === fileHash));
  const updated: DealRawDocManifest = { ...base, entries: [...without, entry], updatedAt: now };
  const manifests = existing
    ? mf.manifests.map((x) => (x.rootId === rootId ? updated : x))
    : [...mf.manifests, updated];
  writeManifestFile({ version: 1, manifests });
  return entry;
}

/**
 * Retrieve a deal's persisted raw docs as composer-ready inputs. THROWS if a
 * manifest-listed blob is absent from the blobStore (flag 3 — the manifest must
 * list exactly what is retrievable). Returns [] when the deal has none.
 */
export async function getDealSourceDocs(
  rootId: string,
): Promise<Array<{ slot: SourceDocSlot; fileName: string; mimeType: string; contentHash: string; bytes: Buffer }>> {
  const mf = readManifestFile();
  const m = mf.manifests.find((x) => x.rootId === rootId);
  if (!m) return [];
  const out: Array<{ slot: SourceDocSlot; fileName: string; mimeType: string; contentHash: string; bytes: Buffer }> = [];
  for (const e of m.entries) {
    const bytes = await blobStore.getBlob(e.fileHash as ContentHash);
    if (bytes === null) {
      throw new Error(`deal-source-doc blob missing from blobStore: ${rootId}/${e.slot}/${e.fileHash} (manifest/blob drift)`);
    }
    out.push({ slot: e.slot, fileName: e.fileName, mimeType: e.mimeType, contentHash: e.fileHash, bytes });
  }
  return out;
}
