/**
 * Data-Room document store (Data-Room Phase 1, Deliverable 2).
 *
 * A two-level (Deal × Doc-type) per-POOL document store. Every dropped doc has
 * a (poolId, loanInPoolId, docType) address and a content-addressed fileHash.
 * This store holds ALL dropped docs — including docs for un-analyzed loans and
 * tier-(c) room-only doc-types (legal/title/insurance/…) that never feed
 * ingest.
 *
 * DECOUPLED FROM INGEST (hard invariant for this deliverable). This module:
 *   - never imports or calls the composer / ingest / registry / governed path,
 *   - never triggers a re-ingest on drop or assign,
 *   - mirrors the source-doc-store.service.ts scope discipline: an
 *     upload-and-organize layer, nothing more.
 *
 * STORAGE SPLIT (maximal reuse, no double-store):
 *   - BYTES ride the existing content-addressed blobStore (.data/blobs/,
 *     hash-keyed, deduped) — the SAME bytes a future ingest would read. This
 *     store never writes bytes anywhere else.
 *   - MAPPING is the only NEW storage: an atomic JSON manifest at
 *     .data/data-room/data-room-manifests.json, one manifest per poolId.
 *
 * NAMESPACE SEPARATION: three doc manifests now coexist, byte-shared in
 * .data/blobs/ but keyed differently and in different directories, so they can
 * never collide:
 *   - library:   .data/source-docs/...        keyed by historicalUwId
 *   - deal-raw:  .data/deal-source-docs/...    keyed by rootId (ingest re-supply)
 *   - data-room: .data/data-room/...           keyed by poolId  (THIS store)
 *
 * DOC-TYPE is a first-class field drawn from the ONE authoritative taxonomy
 * (DOC_TYPE_TAXONOMY / docTypeById from @cre/contracts). Assign validates
 * docType ∈ taxonomy. Tier-(c) room-only types are first-class citizens here
 * (stored/browsable/downloadable), they simply carry ingest:false.
 *
 * BULK DROP reuses the existing StagingBatch primitive verbatim
 * (createStagingBatch / getStagingBatch in source-doc-store.service.ts). The
 * staging system stages raw bytes with no docType/loan opinion; this store's
 * assignDataRoomFiles is the Phase-2 seam: it reads the staged blobs and files
 * them into the pool manifest at a (loanInPoolId, docType) address.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DOC_TYPE_TAXONOMY, docTypeById, DOC_TYPE_CATEGORY, CATEGORIES_IN_ORDER } from '@cre/contracts';
import type { DocTypeEntry, DocTypeCategory } from '@cre/contracts';
import { blobStore } from '../storage/blob-store.js';
import type { ContentHash } from '@cre/contracts';
import { getStagingBatch } from './source-doc-store.service.js';
import { DataRoomDocStore } from '../storage/data-room-doc-store.js';

// ---------------------------------------------------------------------------
// Paths (separate namespace — never touches cre.db, never touches ingest dirs)
// ---------------------------------------------------------------------------

let dataRootOverride: string | null = null;
/** Test seam ONLY (mirrors source-doc-store.setDataRoot). Production code must
 *  not call this. Lets the incremental-download proof run on a temp root. */
export function setDataRoomRoot(root: string | null): void {
  dataRootOverride = root;
}
function dataDir(): string {
  return dataRootOverride ?? path.resolve(process.cwd(), '.data');
}
function dataRoomDir(): string {
  return path.join(dataDir(), 'data-room');
}
function manifestFile(): string {
  return path.join(dataRoomDir(), 'data-room-manifests.json');
}

// ---------------------------------------------------------------------------
// SQLite write-through replica (Data-Room v2, Phase 1).
//
// The JSON manifest above stays AUTHORITATIVE for every READ this phase. In
// PARALLEL, each manifest write ALSO upserts a lazy-DDL SQLite table so the port
// populates without any read-path change (cutover is Phase 2). Behavior-
// preserving: the upsert is additive, wrapped so a table hiccup never breaks a
// drop (the JSON is the source of truth).
//
// The default store is keyed on the SAME data-root context as the manifest:
//   - no override (real server): <cwd>/data/cre.db (the real db).
//   - test root set via setDataRoomRoot: <root>/data/cre.db — NEVER the real
//     cre.db. This makes the existing proofs (which only call setDataRoomRoot)
//     write-through-safe automatically: their replica lives under the throwaway
//     root they discard, so the real cre.db stays byte-unchanged.
// A separate test seam (setDataRoomDocStore) can inject an explicit replica.
// ---------------------------------------------------------------------------

let docStoreOverride: DataRoomDocStore | null = null;
/** Cache the default replica per resolved db-path so a root switch re-derives. */
let defaultDocStore: { dbPath: string; store: DataRoomDocStore } | null = null;

/** Test seam ONLY — inject an explicit temp-db-backed replica store (proofs).
 *  Takes precedence over the root-derived default. Pass null to clear. */
export function setDataRoomDocStore(store: DataRoomDocStore | null): void {
  docStoreOverride = store;
}

/** The cre.db path the write-through replica targets, following the manifest's
 *  data-root context: temp-root/data/cre.db under a test root, else the real
 *  <cwd>/data/cre.db. The two-root gotcha: manifest under <root>/data-room,
 *  db under <root>/data (no dot) — mirroring the real apps/api layout. */
function replicaDbPath(): string {
  const base = dataRootOverride ? path.dirname(dataRootOverride) : process.cwd();
  return path.join(base, 'data', 'cre.db');
}

/** The write-through replica store (explicit override for tests, else the
 *  root-derived default — re-derived if the resolved db-path changes). */
function docStore(): DataRoomDocStore {
  if (docStoreOverride) return docStoreOverride;
  const dbPath = replicaDbPath();
  if (defaultDocStore === null || defaultDocStore.dbPath !== dbPath) {
    defaultDocStore = { dbPath, store: new DataRoomDocStore(dbPath) };
  }
  return defaultDocStore.store;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One dropped document, addressed by (loanInPoolId, docType) + content hash. */
export interface DataRoomDocEntry {
  readonly loanInPoolId: string;
  readonly docType: string; // a DOC_TYPE_TAXONOMY id
  readonly fileHash: string; // hex SHA-256 (the blobStore key + the doc's natural id)
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string; // ISO-8601
  readonly notes: string | null;
  /** Denormalized from the taxonomy for cheap projection rendering. */
  readonly tier: DocTypeEntry['tier'];
  readonly ingest: boolean; // true only for tier 'ingesting'
}

/** One pool's document pile. Two projections are derived from `docs`. */
export interface DataRoomManifest {
  readonly poolId: string;
  readonly docs: ReadonlyArray<DataRoomDocEntry>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DataRoomManifestFile {
  readonly version: 1;
  readonly manifests: DataRoomManifest[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidDocTypeError extends Error {
  readonly docType: string;
  readonly validDocTypes: ReadonlyArray<string>;
  constructor(docType: string) {
    super(`Invalid doc-type (not in DOC_TYPE_TAXONOMY): ${docType}`);
    this.name = 'InvalidDocTypeError';
    this.docType = docType;
    this.validDocTypes = DOC_TYPE_TAXONOMY.map((e) => e.id);
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O — atomic tmp-rename write, single-writer
// ---------------------------------------------------------------------------

function readManifestFile(): DataRoomManifestFile {
  const file = manifestFile();
  if (!fs.existsSync(file)) return { version: 1, manifests: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (parsed && parsed.version === 1 && Array.isArray(parsed.manifests)) {
    return parsed as DataRoomManifestFile;
  }
  throw new Error(`data-room manifest corrupt at ${file}`);
}

function writeManifestFile(f: DataRoomManifestFile): void {
  fs.mkdirSync(dataRoomDir(), { recursive: true });
  const target = manifestFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, target);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a docType against the ONE taxonomy. Throws InvalidDocTypeError. */
export function assertValidDocType(docType: string): DocTypeEntry {
  const entry = docTypeById(docType);
  if (!entry) throw new InvalidDocTypeError(docType);
  return entry;
}

// ---------------------------------------------------------------------------
// Public API — single drop (the primitive assign wraps)
// ---------------------------------------------------------------------------

export interface SaveDataRoomDocArgs {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly buffer: Buffer;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly notes?: string;
}

/**
 * Persist one dropped doc into the pool manifest at (loanInPoolId, docType).
 * Bytes → blobStore (idempotent, content-addressed) FIRST; mapping → manifest.
 * Idempotent per (loanInPoolId, docType, fileHash): re-dropping the same bytes
 * to the same address refreshes metadata rather than duplicating.
 * VALIDATES docType ∈ DOC_TYPE_TAXONOMY (throws InvalidDocTypeError otherwise).
 */
export async function saveDataRoomDoc(args: SaveDataRoomDocArgs): Promise<DataRoomDocEntry> {
  const taxo = assertValidDocType(args.docType);

  // Bytes FIRST (idempotent). Throws on write failure — never a half-persist.
  const fileHash = await blobStore.putBlob(args.buffer);

  const entry: DataRoomDocEntry = {
    loanInPoolId: args.loanInPoolId,
    docType: taxo.id,
    fileHash,
    fileName: args.originalFileName,
    mimeType: args.mimeType,
    size: args.buffer.length,
    uploadedAt: nowIso(),
    notes: args.notes ?? null,
    tier: taxo.tier,
    ingest: taxo.tier === 'ingesting',
  };

  const mf = readManifestFile();
  const existing = mf.manifests.find((m) => m.poolId === args.poolId);
  const base: DataRoomManifest =
    existing ?? { poolId: args.poolId, docs: [], createdAt: entry.uploadedAt, updatedAt: entry.uploadedAt };
  // Dedupe per (loanInPoolId, docType, fileHash).
  const without = base.docs.filter(
    (d) => !(d.loanInPoolId === entry.loanInPoolId && d.docType === entry.docType && d.fileHash === entry.fileHash),
  );
  const updated: DataRoomManifest = { ...base, docs: [...without, entry], updatedAt: entry.uploadedAt };
  const manifests = existing
    ? mf.manifests.map((m) => (m.poolId === args.poolId ? updated : m))
    : [...mf.manifests, updated];
  writeManifestFile({ version: 1, manifests });

  // ── SQLite write-through (parallel replica; JSON stays authoritative) ──────
  // Same fields, SEQ bump on every write (fresh insert AND refresh) so ORDER BY
  // seq reproduces docs[] with a refreshed row relocated to the tail — matching
  // the filter-out-then-append above. Additive: guarded so it can never break a
  // drop (the JSON manifest is already durably written by this point).
  try {
    docStore().upsert({
      poolId: args.poolId,
      loanInPoolId: entry.loanInPoolId,
      docType: entry.docType,
      fileHash: entry.fileHash,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      size: entry.size,
      uploadedAt: entry.uploadedAt,
      notes: entry.notes,
      tier: entry.tier,
      ingest: entry.ingest,
    });
  } catch (err) {
    // Non-fatal this phase — the JSON manifest is the source of truth for reads.
    process.stderr.write(
      `[data-room] write-through replica upsert failed (non-fatal, JSON authoritative): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Marker-gated importer (Data-Room v2, Phase 1).
//
// For envs WITH an existing JSON manifest, backfill every entry once into the
// SQLite replica — non-lossy (all fields, docs[] order preserved as ascending
// seq) + IDEMPOTENT (a per-pool marker row; a re-run is a no-op). No-op in a
// tree with NO manifest. Reads stay on the JSON this phase.
// ---------------------------------------------------------------------------

/** Import all pools' manifest docs[] into the replica table. Idempotent per pool
 *  (marker-gated). Returns per-pool imported counts (0 = already imported). */
export function importManifestToTable(): ReadonlyArray<{ poolId: string; imported: number }> {
  const mf = readManifestFile();
  const store = docStore();
  return mf.manifests.map((m) => ({
    poolId: m.poolId,
    imported: store.importPoolManifest(
      m.poolId,
      m.docs.map((d) => ({
        loanInPoolId: d.loanInPoolId,
        docType: d.docType,
        fileHash: d.fileHash,
        fileName: d.fileName,
        mimeType: d.mimeType,
        size: d.size,
        uploadedAt: d.uploadedAt,
        notes: d.notes,
        tier: d.tier,
        ingest: d.ingest,
      })),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Public API — reads + the two projections
// ---------------------------------------------------------------------------

export function getPoolManifest(poolId: string): DataRoomManifest | null {
  return readManifestFile().manifests.find((m) => m.poolId === poolId) ?? null;
}

/** Every doc in the pool (flat pile). */
export function listPoolDocs(poolId: string): ReadonlyArray<DataRoomDocEntry> {
  return getPoolManifest(poolId)?.docs ?? [];
}

/** PROJECTION 1 — docs grouped by doc-type across the pool's loans. */
export interface DocTypeGroup {
  readonly docType: string;
  readonly label: string;
  readonly tier: DocTypeEntry['tier'];
  readonly ingest: boolean;
  readonly docs: ReadonlyArray<DataRoomDocEntry>;
}
export function projectByDocType(poolId: string): ReadonlyArray<DocTypeGroup> {
  const docs = listPoolDocs(poolId);
  const groups = new Map<string, DataRoomDocEntry[]>();
  for (const d of docs) {
    const arr = groups.get(d.docType) ?? [];
    arr.push(d);
    groups.set(d.docType, arr);
  }
  // Order by the taxonomy (tier a → b → c), only emitting doc-types present.
  const out: DocTypeGroup[] = [];
  for (const t of DOC_TYPE_TAXONOMY) {
    const g = groups.get(t.id);
    if (!g) continue;
    out.push({
      docType: t.id,
      label: t.label,
      tier: t.tier,
      ingest: t.tier === 'ingesting',
      docs: g,
    });
  }
  return out;
}

/** PROJECTION 3 — docs grouped by CATEGORY (the human folder above doc-types),
 *  via DOC_TYPE_CATEGORY. Read-only projection; mirrors projectByDocType /
 *  projectByLoan. Categories are emitted in CATEGORIES_IN_ORDER, only those the
 *  pool actually has docs for. Serves Piece D (category-browsable data room). */
export interface CategoryGroup {
  readonly category: DocTypeCategory;
  readonly docs: ReadonlyArray<DataRoomDocEntry>;
}
export function projectByCategory(poolId: string): ReadonlyArray<CategoryGroup> {
  const docs = listPoolDocs(poolId);
  const groups = new Map<DocTypeCategory, DataRoomDocEntry[]>();
  for (const d of docs) {
    const category = DOC_TYPE_CATEGORY[d.docType];
    if (!category) continue; // docType not in taxonomy (should never happen — assign validates)
    const arr = groups.get(category) ?? [];
    arr.push(d);
    groups.set(category, arr);
  }
  const out: CategoryGroup[] = [];
  for (const category of CATEGORIES_IN_ORDER) {
    const g = groups.get(category);
    if (!g) continue;
    out.push({ category, docs: g });
  }
  return out;
}

/** PROJECTION 2 — docs grouped by loanInPoolId. */
export interface LoanGroup {
  readonly loanInPoolId: string;
  readonly docs: ReadonlyArray<DataRoomDocEntry>;
}
export function projectByLoan(poolId: string): ReadonlyArray<LoanGroup> {
  const docs = listPoolDocs(poolId);
  const groups = new Map<string, DataRoomDocEntry[]>();
  for (const d of docs) {
    const arr = groups.get(d.loanInPoolId) ?? [];
    arr.push(d);
    groups.set(d.loanInPoolId, arr);
  }
  return Array.from(groups.entries()).map(([loanInPoolId, ds]) => ({ loanInPoolId, docs: ds }));
}

/** Fetch a doc's bytes by (poolId, fileHash). fileHash is the content-addressed
 *  natural id; a doc can appear once per (loan, docType), so the pool + hash is
 *  enough to stream it. Returns null if the doc is not in this pool's manifest
 *  or the blob is missing. */
export async function getDataRoomDoc(
  poolId: string,
  fileHash: string,
): Promise<{ bytes: Buffer; entry: DataRoomDocEntry } | null> {
  const docs = listPoolDocs(poolId);
  const entry = docs.find((d) => d.fileHash === fileHash);
  if (!entry) return null;
  const bytes = await blobStore.getBlob(fileHash as ContentHash);
  if (bytes === null) return null;
  return { bytes, entry };
}

// ---------------------------------------------------------------------------
// Public API — bulk assign (the Phase-2 seam over the existing staging batch)
// ---------------------------------------------------------------------------

export interface DataRoomAssignment {
  readonly stagingId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly notes?: string;
}

export interface DataRoomAssignmentResult {
  readonly stagingId: string;
  readonly status: 'assigned' | 'error';
  readonly loanInPoolId?: string;
  readonly docType?: string;
  readonly fileHash?: string;
  readonly error?: string;
}

/**
 * Assign staged files (from an existing StagingBatch) into the pool manifest at
 * (loanInPoolId, docType). Each assignment is processed independently — one
 * failure never aborts the others. Validates docType ∈ DOC_TYPE_TAXONOMY per
 * file. The staged bytes are already in the blobStore (staging putBlob-equivalent
 * wrote them to _staging, and saveDataRoomDoc re-putBlobs idempotently), so this
 * only reads the staged blob + records the mapping.
 */
export async function assignDataRoomFiles(args: {
  readonly poolId: string;
  readonly batchId: string;
  readonly assignments: ReadonlyArray<DataRoomAssignment>;
}): Promise<ReadonlyArray<DataRoomAssignmentResult>> {
  const batch = getStagingBatch(args.batchId);
  const results: DataRoomAssignmentResult[] = [];
  if (!batch) {
    for (const a of args.assignments) {
      results.push({ stagingId: a.stagingId, status: 'error', error: `staging_batch_not_found:${args.batchId}` });
    }
    return results;
  }

  for (const a of args.assignments) {
    const staged = batch.files.find((f) => f.stagingId === a.stagingId);
    if (!staged) {
      results.push({ stagingId: a.stagingId, status: 'error', error: 'staged_file_not_found_in_batch' });
      continue;
    }
    // Validate docType BEFORE touching bytes.
    if (!docTypeById(a.docType)) {
      results.push({ stagingId: a.stagingId, status: 'error', error: `invalid_doc_type:${a.docType}` });
      continue;
    }
    // Staging stored bytes under _staging; but they are also content-addressed:
    // the staged entry carries the fileHash, so read from the blobStore. The
    // staging service does NOT putBlob, so fetch the staged bytes from disk via
    // the staging batch dir is required — expose it through getStagedBlob.
    const bytes = await getStagedBytes(args.batchId, a.stagingId);
    if (!bytes) {
      results.push({ stagingId: a.stagingId, status: 'error', error: 'staged_blob_missing' });
      continue;
    }
    try {
      const entry = await saveDataRoomDoc({
        poolId: args.poolId,
        loanInPoolId: a.loanInPoolId,
        docType: a.docType,
        buffer: bytes,
        originalFileName: staged.originalFileName,
        mimeType: staged.mimeType,
        notes: a.notes,
      });
      results.push({
        stagingId: a.stagingId,
        status: 'assigned',
        loanInPoolId: entry.loanInPoolId,
        docType: entry.docType,
        fileHash: entry.fileHash,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ stagingId: a.stagingId, status: 'error', error: msg });
    }
  }
  return results;
}

/** Read a staged file's raw bytes from the staging batch directory. The staging
 *  layer writes staged blobs under .data/source-docs/_staging/<batchId>/. We
 *  read them here (read-only) to move them into the content-addressed store on
 *  assign. */
async function getStagedBytes(batchId: string, stagingId: string): Promise<Buffer | null> {
  const stagingBatchDir = path.join(dataDir(), 'source-docs', '_staging', batchId);
  if (!fs.existsSync(stagingBatchDir)) return null;
  const candidates = fs.readdirSync(stagingBatchDir).filter((n) => n.startsWith(stagingId));
  if (candidates.length === 0) return null;
  try {
    return fs.readFileSync(path.join(stagingBatchDir, candidates[0]!));
  } catch {
    return null;
  }
}
