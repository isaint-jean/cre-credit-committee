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
 *   - MAPPING lives in the `data_room_doc` SQLite table on cre.db. ★ Data-Room v2
 *     Phase 4: the table is now the SOLE writer AND reader. The old JSON manifest
 *     (.data/data-room/data-room-manifests.json) is FROZEN — kept read-only for a
 *     one-release safety valve (readManifestFile + the marker-gated importer +
 *     getPoolManifest), never written.
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
import type {
  DataRoomTree,
  DataRoomTreeNewIssue,
  DataRoomTreeBank,
  DataRoomTreeCategory,
  DataRoomTreeFile,
} from '@cre/contracts';
import { blobStore } from '../storage/blob-store.js';
import type { ContentHash } from '@cre/contracts';
import { getStagingBatch } from './source-doc-store.service.js';
import { DataRoomDocStore } from '../storage/data-room-doc-store.js';
import type { DataRoomDocRow } from '../storage/data-room-doc-store.js';
import { DataRoomHeldStore } from '../storage/data-room-held-store.js';
import type { DataRoomHeldRow } from '../storage/data-room-held-store.js';
import { classifyDateFromContent } from '@cre/shared';
import { extractFrontMatterText } from './data-room/page1-text.service.js';

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
// SQLite store (Data-Room v2 — Phase 4: the SOLE source for reads AND writes).
//
// The `data_room_doc` table (lazy-DDL) is now authoritative for every READ
// (Phase 2) AND WRITE (Phase 4 — persistDataRoomEntries writes ONLY the table).
// The JSON manifest is frozen (read-only safety valve; see the Manifest I/O
// section). The store is keyed on the data-root so proofs setting a temp root
// write/read a throwaway db, never the real cre.db.
//
// The default store is keyed on the SAME data-root context as the (now frozen)
// manifest:
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

/** The cre.db path the write-through replica (Phase 1) AND the read path
 *  (Phase 2) target, following the manifest's data-root context:
 *    - test root set: <root>/data/cre.db — UNDER the throwaway root, so it is
 *      isolated per-root (auto-cleaned when the proof rms its tmpRoot) AND is
 *      NEVER the real cre.db. Manifest lives at <root>/data-room/…, the replica
 *      at <root>/data/cre.db — a sibling INSIDE the same root.
 *    - no override (real server): <cwd>/data/cre.db (the real db).
 *
 *  ★ PHASE-2 LESSON (why this must live UNDER the root, not dirname(root)):
 *  the read path now reads this db. If the db lived at dirname(root)/data
 *  (root's PARENT, e.g. os.tmpdir()/data), every sibling temp root would share
 *  ONE replica db → cross-proof/cross-run row bleed the moment reads move off
 *  the per-root JSON. Keeping it UNDER the root makes each proof's table reads
 *  see exactly (and only) that proof's writes — the data-root-following identity
 *  the Phase-1 lesson demands, now enforced on the READ path too. Proofs that
 *  inject an explicit replica via setDataRoomDocStore are unaffected (that
 *  override wins over this default). */
function replicaDbPath(): string {
  const base = dataRootOverride ?? process.cwd();
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
// The HELD store (Data-Room content-routing SLICE 3 — durable never-reject).
//
// A DURABLE home for accepted-but-unidentified files (the "needs identification"
// set). Follows the EXACT SAME data-root discipline as docStore(): keyed on the
// resolved replicaDbPath() (dataRootOverride ?? cwd → <root>/data/cre.db), so a
// proof that sets only a data-room root reads/writes the temp-root db, never the
// real cre.db. The held store is a SIBLING table (data_room_held) on the same db
// file — it never pollutes data_room_doc's routed PK/dedup.
// ---------------------------------------------------------------------------

let heldStoreOverride: DataRoomHeldStore | null = null;
let defaultHeldStore: { dbPath: string; store: DataRoomHeldStore } | null = null;

/** Test seam ONLY — inject an explicit temp-db-backed held store (proofs).
 *  Takes precedence over the root-derived default. Pass null to clear. */
export function setDataRoomHeldStore(store: DataRoomHeldStore | null): void {
  heldStoreOverride = store;
}

function heldStore(): DataRoomHeldStore {
  if (heldStoreOverride) return heldStoreOverride;
  const dbPath = replicaDbPath();
  if (defaultHeldStore === null || defaultHeldStore.dbPath !== dbPath) {
    defaultHeldStore = { dbPath, store: new DataRoomHeldStore(dbPath) };
  }
  return defaultHeldStore.store;
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
  /** SLICE 4 — extracted effective/as-of/report date (ISO-UTC) or null. The
   *  version tiebreak signal (latest-content-date wins the underwrite slot). */
  readonly docEffectiveDate?: string | null;
  /** SLICE 4 — human pin: this version wins its (loan, docType) slot for
   *  underwriting, overriding latest-content-date. Read-only on the entry. */
  readonly pinned?: boolean;
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
// Manifest I/O — READ-ONLY safety valve (Data-Room v2, Phase 4).
//
// ★ Phase 4 dropped the JSON WRITE (the table is the sole writer). readManifestFile
// is KEPT — read-only — for the one-release safety valve: the marker-gated importer
// (importManifestToTable) migrates a pre-existing manifest in, and getPoolManifest
// still answers off any frozen JSON. The write function was removed as dead code
// once persistDataRoomEntries stopped calling it (grep-clean, no callers).
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

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * SLICE 4 — extract a doc's effective/as-of/report content date at persist time
 * (durable on data_room_doc.doc_effective_date, not re-derived each read).
 *
 * Scoped to TIER-A (ingest===true) docs — the ones that underwrite, whose version
 * selection the date resolves. Tier-(b/c) docs skip the scan (no underwrite
 * selection to resolve) → null → uploadedAt tiebreak if ever needed. NO-LLM: a
 * cheap deterministic front-matter (page-1..N) text scan + the shared regex
 * classifier. Returns null on any parse miss / non-tier-a doc (honest — the
 * tiebreak then falls back to uploadedAt).
 */
async function extractEffectiveDate(bytes: Buffer, ingest: boolean): Promise<string | null> {
  if (!ingest) return null; // only tier-a docs feed the underwrite selection
  const text = await extractFrontMatterText(bytes);
  if (text.length === 0) return null;
  return classifyDateFromContent(text);
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

  const ingest = taxo.tier === 'ingesting';
  // SLICE 4: extract the content date for tier-a docs (the version tiebreak
  // signal). Never throws into the persist path — extractEffectiveDate is '' /
  // null-safe.
  const docEffectiveDate = await extractEffectiveDate(args.buffer, ingest);

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
    ingest,
    docEffectiveDate,
  };

  // Single drop = a one-element batch. saveDataRoomDoc and assignDataRoomFiles now
  // share ONE persist code path (persistDataRoomEntries) — no divergence, no drift.
  // Signature/return are unchanged: still resolves the built entry.
  persistDataRoomEntries(args.poolId, [entry]);
  return entry;
}

// ---------------------------------------------------------------------------
// Batched persist (Data-Room v2 — Phase 4: the table is the SOLE writer).
//
// ★ PHASE 4 CUTOVER: the JSON manifest write is DROPPED. The table
// (`data_room_doc`) is now authoritative for BOTH reads (Phase 2) AND writes.
// The table's `ON CONFLICT(pk) DO UPDATE` + `seq = MAX(seq)+1` per row ALREADY
// reproduces the old JSON filter-out-then-append dedup + tail-relocation exactly
// (proven byte-identical in Phases 1–3): a re-drop of the same
// (loanInPoolId, docType, fileHash) UPSERTs the SAME row and bumps its seq to a
// fresh global max, so ORDER BY seq relocates it to the tail — identical to the
// manifest's filter-out-then-append. Applying the batch in array order → strictly
// increasing seq → the same intra-batch dedup (same-triple last-wins at tail) +
// dedup against existing rows. So the table is self-sufficient; the JSON read for
// dedup and the whole-JSON rewrite are both gone.
//
// ★ THE JSON READ-ONLY SAFETY VALVE stays intact (one release): readManifestFile,
// the marker-gated importer (importManifestToTable / importPoolManifest), and
// getPoolManifest are retained + any existing JSON files are NOT deleted, so a
// post-cutover problem stays comparable and a real-manifest env can still migrate
// in. Only the WRITE side of the JSON is dropped here.
//
// ★ DATA-ROOT: the sole writer is docStore() (via replicaDbPath() →
// dataRootOverride ?? process.cwd() → <root>/data/cre.db), so the write path
// resolves to the data-root, NEVER <cwd> when a root is set and NEVER
// dirname(root). No more manifest write, so no <root>/.data manifest is touched.
// ---------------------------------------------------------------------------

/**
 * Persist N built entries into one pool's replica table in ONE transaction. The
 * TABLE is the sole writer: upsertMany bumps seq = MAX(seq)+1 per row in array
 * order, so ORDER BY seq reproduces the old manifest docs[] EXACTLY (in-order
 * filter-out-then-append dedup, same-triple last-wins at the tail, existing-row
 * dedup, tail-relocation). No JSON is read or written. Returns the entries.
 */
export function persistDataRoomEntries(
  poolId: string,
  entries: ReadonlyArray<DataRoomDocEntry>,
): ReadonlyArray<DataRoomDocEntry> {
  if (entries.length === 0) return entries;

  // ── SQLite is the SOLE writer (Phase 4). ───────────────────────────────────
  // ONE transaction; each row bumps seq = MAX(seq)+1 IN ARRAY ORDER so ORDER BY
  // seq reproduces the old docs[] (refreshed rows relocated to the tail). No JSON
  // manifest is read or written — the table's PK-upsert + seq-bump is the dedup +
  // ordering, exactly as the JSON docs[] filter-out-then-append was.
  docStore().upsertMany(
    entries.map((entry) => ({
      poolId,
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
      docEffectiveDate: entry.docEffectiveDate ?? null,
    })),
  );

  return entries;
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

/**
 * F3 — reads the (now Phase-4-FROZEN) JSON manifest for a pool's createdAt/
 * updatedAt envelope. ★ NO LIVE CONSUMER: kept as part of the one-release
 * read-only safety valve (the frozen JSON stays readable for comparison /
 * migration). It is the ONLY reader of the pool-level createdAt/updatedAt, which
 * the `data_room_doc` table does not carry (the table stores per-doc uploadedAt
 * only). Since the JSON write is dropped, any value it returns reflects the
 * manifest AS FROZEN at cutover — do NOT wire a live consumer onto it without
 * first sourcing createdAt/updatedAt from the table.
 */
export function getPoolManifest(poolId: string): DataRoomManifest | null {
  return readManifestFile().manifests.find((m) => m.poolId === poolId) ?? null;
}

/** Strip a table row (poolId + seq) down to the manifest's DataRoomDocEntry
 *  shape. tier/ingest ride the row (denormalized, as the manifest); CATEGORY is
 *  never on the entry — it is derived on read from DOC_TYPE_CATEGORY by the
 *  projections, the ONE source. */
function rowToEntry(r: DataRoomDocRow): DataRoomDocEntry {
  return {
    loanInPoolId: r.loanInPoolId,
    docType: r.docType,
    fileHash: r.fileHash,
    fileName: r.fileName,
    mimeType: r.mimeType,
    size: r.size,
    uploadedAt: r.uploadedAt,
    notes: r.notes,
    tier: r.tier,
    ingest: r.ingest,
    docEffectiveDate: r.docEffectiveDate,
    pinned: r.pinned,
  };
}

/**
 * Every doc in the pool (flat pile).
 *
 * ── Data-Room v2, Phase 2: READS CUT OVER TO THE TABLE ──────────────────────
 * Reads `data_room_doc` (ORDER BY seq) via the SAME data-root-following
 * `docStore()` the write-through replica writes — so a proof that sets only a
 * data-room root reads from the temp-root db, never the real cre.db. The
 * `ORDER BY seq` reproduces the manifest's `docs[]` order EXACTLY (write-order,
 * with any refreshed row relocated to the tail). This is THE BASE: the three
 * projections + getDataRoomDoc + download all build on this one query, so they
 * inherit the cutover (and the first-seen / seq ordering) for free.
 *
 * JSON stays WRITE-THROUGH this phase (drop is Phase 4); reads no longer touch
 * the manifest.
 */
export function listPoolDocs(poolId: string): ReadonlyArray<DataRoomDocEntry> {
  return docStore().listPoolDocs(poolId).map(rowToEntry);
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

// ---------------------------------------------------------------------------
// PROJECTION 4 (Chunk 1) — the read-only NESTED TREE.
//   Deal (pool) → Loan → Category → docType slot → file
// Pure composition of projectByLoan + DOC_TYPE_CATEGORY + the selected-version
// tiebreak. No new state, no writes, no ingest coupling. Loan display names are
// INJECTED by the caller (resolveLoanName) so this service stays decoupled from
// PoolStore, exactly like the rest of this module. On-demand folders: a loan /
// category / slot node is emitted ONLY when it has ≥1 file.
// ---------------------------------------------------------------------------

/** Newest-first ordering of a slot's versions — MIRRORS pickWinningVersion
 *  (underwrite-loan.service) / pickSelectedVersion (web data-room-utils), kept
 *  local so this module never imports the ingest path: latest docEffectiveDate
 *  wins (a present date beats a null one), else latest uploadedAt. */
function orderVersionsNewestFirst(versions: readonly DataRoomDocEntry[]): DataRoomDocEntry[] {
  return versions.slice().sort((a, b) => {
    const ad = a.docEffectiveDate ?? null;
    const bd = b.docEffectiveDate ?? null;
    if (ad !== null && bd !== null && ad !== bd) return ad < bd ? 1 : -1;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;
    return a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0;
  });
}

/** The version that wins its (loan, docType) slot — a pin wins outright, else
 *  the newest by the ordering above. Same rule the underwrite path + client
 *  version picker use. */
function selectedFileHashForSlot(versions: readonly DataRoomDocEntry[]): string {
  const pinned = versions.filter((v) => v.pinned === true);
  const pool = pinned.length > 0 ? pinned : versions;
  return orderVersionsNewestFirst(pool)[0]!.fileHash;
}

/** Taxonomy slot order (doc-type id → index) for stable file ordering. */
const SLOT_ORDER: ReadonlyMap<string, number> = new Map(
  DOC_TYPE_TAXONOMY.map((t, i) => [t.id, i] as const),
);
const UNKNOWN_BANK = '(unknown seller)';

export interface ProjectTreeOptions {
  /** Resolve a loanInPoolId → its display name + contributing bank
   *  (LoanMembership.propertyName / .mortgageLoanSeller). */
  readonly resolveLoan?: (loanInPoolId: string) => { name: string | null; bank: string | null; analysisId?: string | null };
  readonly poolName?: string | null;
  readonly seller?: string | null;
}

/**
 * The nested tree: Deal → New Issue → Deal name → BANK → CATEGORY → loan-file.
 * The category is the FOLDER; loans are the leaf files inside it. Pure read —
 * composes listPoolDocs + DOC_TYPE_CATEGORY + the per-(loan,doc-type) version
 * tiebreak; loan names + banks are injected (resolveLoan) so this module stays
 * decoupled from PoolStore.
 */
export function projectTree(poolId: string, opts: ProjectTreeOptions = {}): DataRoomTree {
  const docs = listPoolDocs(poolId);

  // (1) Version metadata per (loan, doc-type) slot — index/count/selected. Keyed
  //     by slot+fileHash so the same bytes under two doc-types never collide.
  const slotKey = (loanInPoolId: string, docType: string) => `${loanInPoolId} ${docType}`;
  const slotGroups = new Map<string, DataRoomDocEntry[]>();
  for (const d of docs) {
    const k = slotKey(d.loanInPoolId, d.docType);
    const arr = slotGroups.get(k) ?? [];
    arr.push(d);
    slotGroups.set(k, arr);
  }
  const versionMeta = new Map<string, { index: number; count: number; selected: boolean }>();
  for (const [k, versions] of slotGroups) {
    const ordered = orderVersionsNewestFirst(versions);
    const selectedHash = selectedFileHashForSlot(versions);
    ordered.forEach((v, i) =>
      versionMeta.set(`${k} ${v.fileHash}`, {
        index: i + 1,
        count: ordered.length,
        selected: v.fileHash === selectedHash,
      }),
    );
  }

  // (2) Bucket every doc into BANK → CATEGORY, building the loan-labeled leaf.
  const banks = new Map<string, Map<DocTypeCategory, DataRoomTreeFile[]>>();
  for (const d of docs) {
    const category = DOC_TYPE_CATEGORY[d.docType];
    if (!category) continue; // not in taxonomy (assign validates; defensive)
    const info = opts.resolveLoan?.(d.loanInPoolId) ?? { name: null, bank: null, analysisId: null };
    const bank = info.bank && info.bank.trim() !== '' ? info.bank : UNKNOWN_BANK;
    const vm = versionMeta.get(`${slotKey(d.loanInPoolId, d.docType)} ${d.fileHash}`)!;
    const t = docTypeById(d.docType);
    const file: DataRoomTreeFile = {
      fileHash: d.fileHash,
      fileName: d.fileName,
      size: d.size,
      uploadedAt: d.uploadedAt,
      docEffectiveDate: d.docEffectiveDate ?? null,
      pinned: d.pinned === true,
      isSelectedVersion: vm.selected,
      versionIndex: vm.index,
      versionCount: vm.count,
      loanInPoolId: d.loanInPoolId,
      loanName: info.name ?? d.loanInPoolId,
      docType: d.docType,
      docTypeLabel: t?.label ?? d.docType,
      tier: d.tier,
      ingest: d.ingest,
      analysisId: info.analysisId ?? null,
    };
    let catMap = banks.get(bank);
    if (!catMap) { catMap = new Map(); banks.set(bank, catMap); }
    const arr = catMap.get(category) ?? [];
    arr.push(file);
    catMap.set(category, arr);
  }

  // (3) Emit deterministically: banks A→Z, categories in CATEGORIES_IN_ORDER,
  //     files by loan → doc-type (taxonomy order) → version (newest first).
  const bankNodes: DataRoomTreeBank[] = [];
  for (const bankName of Array.from(banks.keys()).sort((a, b) => a.localeCompare(b))) {
    const catMap = banks.get(bankName)!;
    const categories: DataRoomTreeCategory[] = [];
    let bankFileCount = 0;
    for (const category of CATEGORIES_IN_ORDER) {
      const files = catMap.get(category);
      if (!files || files.length === 0) continue; // on-demand: no empty category
      files.sort(
        (a, b) =>
          a.loanName.localeCompare(b.loanName) ||
          (SLOT_ORDER.get(a.docType)! - SLOT_ORDER.get(b.docType)!) ||
          a.versionIndex - b.versionIndex,
      );
      categories.push({ category, files, fileCount: files.length });
      bankFileCount += files.length;
    }
    bankNodes.push({ bank: bankName, categories, fileCount: bankFileCount });
  }

  const totalFiles = bankNodes.reduce((n, b) => n + b.fileCount, 0);
  const newIssue: DataRoomTreeNewIssue | null =
    bankNodes.length > 0
      ? { dealName: opts.poolName ?? null, banks: bankNodes, fileCount: totalFiles }
      : null;

  return {
    poolId,
    poolName: opts.poolName ?? null,
    seller: opts.seller ?? null,
    newIssue,
    fileCount: totalFiles,
  };
}

// ---------------------------------------------------------------------------
// Tier 2 (a) — MISSING-DOC surface via SET-DIFFERENCE. Pure/instant; NO engine
// call (works for an un-underwritten loan + with credits exhausted). The source
// of truth for "what's missing"; the engine's dataQuality flags corroborate.
// ---------------------------------------------------------------------------

export interface MissingDoc {
  readonly slot: string; // docType id (asr/cf/rent_roll/pca/appraisal)
  readonly label: string; // humanized (taxonomy label)
  readonly blocks: string; // what its absence blocks
}

/** Curated "blocks what" per ingest slot — grounded in the intake `blocks`
 *  semantics (a per-slot line reads cleaner than concatenating field-level ones). */
const SLOT_BLOCKS: Readonly<Record<string, string>> = {
  asr: 'the rent-record baseline',
  cf: 'NOI, DSCR & debt-yield metrics',
  rent_roll: 'tenant concentration & occupancy',
  pca: 'capital-reserve sizing',
  appraisal: 'value, LTV & cap-rate checks',
};

/** The loan's EMPTY ingest slots = expected ingest slots − what the loan HAS. */
export function computeMissingDocs(poolId: string, loanInPoolId: string): MissingDoc[] {
  const present = new Set(
    listPoolDocs(poolId).filter((d) => d.loanInPoolId === loanInPoolId).map((d) => d.docType),
  );
  const missing: MissingDoc[] = [];
  for (const t of DOC_TYPE_TAXONOMY) {
    if (t.tier !== 'ingesting') continue; // only the expected engine-ingest slots
    if (present.has(t.id)) continue;
    missing.push({ slot: t.id, label: t.label, blocks: SLOT_BLOCKS[t.id] ?? 'part of the underwriting' });
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Manual MOVE / RECLASSIFY (Chunk 2c) — re-file a routed doc.
// ---------------------------------------------------------------------------

export class ReclassifyError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_DOCTYPE';
  constructor(code: 'NOT_FOUND' | 'INVALID_DOCTYPE', message: string) {
    super(message);
    this.name = 'ReclassifyError';
    this.code = code;
  }
}

export interface ReclassifyResult {
  readonly moved: boolean;
  readonly from: { loanInPoolId: string; docType: string; category: DocTypeCategory | null };
  readonly to: { loanInPoolId: string; docType: string; category: DocTypeCategory | null };
}

/**
 * Manual move / reclassify of a routed doc: re-type it (its CATEGORY re-derives
 * from the new docType) and/or re-assign its loan. Patterned on the HELD identify
 * flow — persist the new address, then delete the old. The only new primitive is
 * store.deleteByAddress; upsert is reused. Idempotent no-op when the target equals
 * the current address. Throws ReclassifyError('NOT_FOUND' | 'INVALID_DOCTYPE').
 * Address-scoped writes → never disturbs any OTHER doc.
 */
export function reclassifyDataRoomDoc(args: {
  poolId: string;
  fileHash: string;
  targetLoanInPoolId: string;
  targetDocType: string;
}): ReclassifyResult {
  const store = docStore();
  const current = store.firstByHash(args.poolId, args.fileHash);
  if (!current) {
    throw new ReclassifyError('NOT_FOUND', `data-room doc not found (pool ${args.poolId}, hash ${args.fileHash})`);
  }
  const target = docTypeById(args.targetDocType);
  if (!target) {
    throw new ReclassifyError('INVALID_DOCTYPE', `unknown docType: ${args.targetDocType}`);
  }

  const from = {
    loanInPoolId: current.loanInPoolId,
    docType: current.docType,
    category: DOC_TYPE_CATEGORY[current.docType] ?? null,
  };
  const to = {
    loanInPoolId: args.targetLoanInPoolId,
    docType: args.targetDocType,
    category: DOC_TYPE_CATEGORY[args.targetDocType] ?? null,
  };

  if (from.loanInPoolId === to.loanInPoolId && from.docType === to.docType) {
    return { moved: false, from, to };
  }

  // Persist the new address FIRST, then delete the old (upsert-then-delete → a
  // crash leaves a harmless duplicate, never a loss). tier/ingest come from the
  // TARGET taxonomy entry; the content date carries over; pin resets (new slot).
  store.upsert({
    poolId: args.poolId,
    loanInPoolId: to.loanInPoolId,
    docType: to.docType,
    fileHash: current.fileHash,
    fileName: current.fileName,
    mimeType: current.mimeType,
    size: current.size,
    uploadedAt: current.uploadedAt,
    notes: current.notes,
    tier: target.tier,
    ingest: target.tier === 'ingesting',
    docEffectiveDate: current.docEffectiveDate,
  });
  store.deleteByAddress(args.poolId, from.loanInPoolId, from.docType, current.fileHash);
  return { moved: true, from, to };
}

/** Fetch a doc's bytes by (poolId, fileHash). fileHash is the content-addressed
 *  natural id; a doc can appear once per (loan, docType), so the pool + hash is
 *  enough to stream it. Returns null if the doc is not in this pool's manifest
 *  or the blob is missing. */
export async function getDataRoomDoc(
  poolId: string,
  fileHash: string,
): Promise<{ bytes: Buffer; entry: DataRoomDocEntry } | null> {
  // Data-Room v2, Phase 2 — F2: read the table for the FIRST (ORDER BY seq)
  // doc in this pool matching the content hash, reproducing the original
  // `listPoolDocs(...).find((d) => d.fileHash === fileHash)` first-in-docs[]
  // semantics via a single indexed query. Reads through the SAME
  // data-root-following docStore() as the write-through.
  const row = docStore().firstByHash(poolId, fileHash);
  if (!row) return null;
  const entry = rowToEntry(row);
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

  // ── Phase 3: per-file do ONLY the async part (staged bytes + putBlob + docType
  //    validation + build the entry), collecting the successful entries. The
  //    persist (manifest-once + one txn) runs ONCE for all of them below. Same
  //    validation, same errors (staged_file_not_found / invalid_doc_type /
  //    staged_blob_missing), same result shape/order (results are pushed in
  //    assignment order; entries carry the assignment index for post-persist
  //    result emission). ──
  const built: Array<{ index: number; entry: DataRoomDocEntry }> = [];
  for (const a of args.assignments) {
    const index = results.length; // this assignment's slot in the ordered results
    const staged = batch.files.find((f) => f.stagingId === a.stagingId);
    if (!staged) {
      results.push({ stagingId: a.stagingId, status: 'error', error: 'staged_file_not_found_in_batch' });
      continue;
    }
    // Validate docType BEFORE touching bytes.
    const taxo = docTypeById(a.docType);
    if (!taxo) {
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
    let fileHash: string;
    try {
      // Bytes FIRST (idempotent, content-addressed) — same as saveDataRoomDoc.
      fileHash = await blobStore.putBlob(bytes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ stagingId: a.stagingId, status: 'error', error: msg });
      continue;
    }
    const ingest = taxo.tier === 'ingesting';
    // SLICE 4: content-date scan for tier-a docs (bytes already in hand here).
    const docEffectiveDate = await extractEffectiveDate(bytes, ingest);
    const entry: DataRoomDocEntry = {
      loanInPoolId: a.loanInPoolId,
      docType: taxo.id,
      fileHash,
      fileName: staged.originalFileName,
      mimeType: staged.mimeType,
      size: bytes.length,
      uploadedAt: nowIso(),
      notes: a.notes ?? null,
      tier: taxo.tier,
      ingest,
      docEffectiveDate,
    };
    // Reserve this assignment's ordered result slot; fill it after the persist.
    results.push({
      stagingId: a.stagingId,
      status: 'assigned',
      loanInPoolId: entry.loanInPoolId,
      docType: entry.docType,
      fileHash: entry.fileHash,
    });
    built.push({ index, entry });
  }

  // ── ONE batched persist for all successful entries (manifest-once + one txn).
  //    Behavior-identical to N sequential saveDataRoomDoc calls: in-order
  //    filter-out-then-append dedup (incl. intra-batch same-triple last-wins) +
  //    seq tail-relocation. If the persist throws (never should — the JSON write
  //    is the durable step and the table upsert is guarded internally), surface
  //    it on every entry's slot so the failure isn't silently reported assigned. ──
  if (built.length > 0) {
    try {
      persistDataRoomEntries(
        args.poolId,
        built.map((b) => b.entry),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const b of built) {
        results[b.index] = { stagingId: results[b.index]!.stagingId, status: 'error', error: msg };
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API — the DURABLE HELD ("needs identification") set (SLICE 3).
//
// A file the routing cascade could NOT confidently identify (either axis
// unresolved after folder→filename→content) is ACCEPTED + KEPT here — never
// dropped, never left only in the transient staging batch. It carries the PARTIAL
// hints the cascade DID find. A human can later identify it (loan + docType) →
// it MOVES to data_room_doc (routed) and underwrites on settle.
//
// SECURITY-REJECTED zip entries never reach here — they're refused at the unpack
// gate (counted in rejectedCount) and NEVER admitted to the store. Held = admitted
// + kept + unidentified; security-reject = never admitted.
// ---------------------------------------------------------------------------

/** The public shape of one held file (its payload + partial hints + browse
 *  category). Category is DERIVED on read from the hint doc-type when the store
 *  carries no explicit folder-tier category. */
export interface HeldDoc {
  readonly poolId: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly hintDocType: string | null;
  readonly hintLoanInPoolId: string | null;
  readonly hintCategory: DocTypeCategory | null;
}

function heldRowToDoc(r: DataRoomHeldRow): HeldDoc {
  // Prefer the stored folder-tier category; else derive from the hint docType.
  const category: DocTypeCategory | null =
    (r.hintCategory as DocTypeCategory | null) ??
    (r.hintDocType !== null ? DOC_TYPE_CATEGORY[r.hintDocType] ?? null : null);
  return {
    poolId: r.poolId,
    fileHash: r.fileHash,
    fileName: r.fileName,
    mimeType: r.mimeType,
    size: r.size,
    uploadedAt: r.uploadedAt,
    hintDocType: r.hintDocType,
    hintLoanInPoolId: r.hintLoanInPoolId,
    hintCategory: category,
  };
}

/** One file to HOLD (persist to the durable never-reject set) with its partial
 *  cascade hints. The bytes ride the content-addressed blob store (idempotent),
 *  exactly as saveDataRoomDoc does. */
export interface HoldStagedFile {
  readonly stagingId: string;
  readonly buffer: Buffer;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly hintDocType: string | null;
  readonly hintLoanInPoolId: string | null;
  readonly hintCategory: string | null;
}

export interface HoldResult {
  readonly stagingId: string;
  readonly status: 'held' | 'error';
  readonly fileHash?: string;
  readonly error?: string;
}

/**
 * Persist N accepted-but-unidentified files into the DURABLE held set. Bytes →
 * blobStore FIRST (idempotent, content-addressed — the SAME bytes a later routed
 * copy reads), then the mapping + partial hints → data_room_held. Each file is
 * processed independently (one failure never aborts the others). Idempotent per
 * (poolId, fileHash): re-holding the same bytes refreshes the row (latest hints
 * win). Returns per-file outcomes.
 */
export async function holdStagedFiles(args: {
  readonly poolId: string;
  readonly files: ReadonlyArray<HoldStagedFile>;
}): Promise<ReadonlyArray<HoldResult>> {
  const store = heldStore();
  const results: HoldResult[] = [];
  for (const f of args.files) {
    try {
      // Bytes FIRST (idempotent). Throws on write failure — never a half-persist.
      const fileHash = await blobStore.putBlob(f.buffer);
      store.upsert({
        poolId: args.poolId,
        fileHash,
        fileName: f.originalFileName,
        mimeType: f.mimeType,
        size: f.buffer.length,
        uploadedAt: nowIso(),
        hintDocType: f.hintDocType,
        hintLoanInPoolId: f.hintLoanInPoolId,
        hintCategory: f.hintCategory,
      });
      results.push({ stagingId: f.stagingId, status: 'held', fileHash });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ stagingId: f.stagingId, status: 'error', error: msg });
    }
  }
  return results;
}

/** The "needs identification" projection for a pool — every durably-held file in
 *  write-order, with derived browse category. */
export function listHeldDocs(poolId: string): ReadonlyArray<HeldDoc> {
  return heldStore().listForPool(poolId).map(heldRowToDoc);
}

/** The held count for a pool (the room's "needs identification" badge). */
export function countHeldDocs(poolId: string): number {
  return heldStore().countForPool(poolId);
}

/** Fetch a held doc's bytes by (poolId, fileHash). Mirrors getDataRoomDoc — the
 *  held file is browsable/downloadable before it's identified. Returns null if the
 *  file isn't held in this pool or the blob is missing. */
export async function getHeldDoc(
  poolId: string,
  fileHash: string,
): Promise<{ bytes: Buffer; held: HeldDoc } | null> {
  const row = heldStore().get(poolId, fileHash);
  if (!row) return null;
  const bytes = await blobStore.getBlob(fileHash as ContentHash);
  if (bytes === null) return null;
  return { bytes, held: heldRowToDoc(row) };
}

/**
 * Remove a held row by (poolId, fileHash) WITHOUT routing it. Used by the
 * retry-held flow: once a held ZIP has been re-processed through the fixed gate
 * (its entries unpacked → classified → routed/re-held), the ORIGINAL opaque held
 * blob is fully resolved and its held entry must go (else it lingers as a dead
 * "needs identification" row). Distinct from identifyHeldDoc (which routes then
 * deletes) — here the resolution already happened via the unpack, so this is a
 * pure delete. The content-addressed bytes stay in the blob store (any routed
 * entry that happens to share bytes still reads them; GC is out of scope).
 * Returns true iff a row was removed.
 */
export function deleteHeldDoc(poolId: string, fileHash: string): boolean {
  return heldStore().delete(poolId, fileHash);
}

export class HeldDocNotFoundError extends Error {
  constructor(poolId: string, fileHash: string) {
    super(`held doc not found: pool=${poolId} hash=${fileHash}`);
    this.name = 'HeldDocNotFoundError';
  }
}

export interface IdentifyHeldResult {
  readonly status: 'routed' | 'error';
  readonly loanInPoolId?: string;
  readonly docType?: string;
  readonly fileHash?: string;
  readonly error?: string;
}

/**
 * HUMAN RESOLUTION — identify a held file (assign loan + doc-type) → MOVE it from
 * the held set into data_room_doc (routed) so it underwrites on settle. A CLEAN
 * move: persist-to-doc FIRST (durable), then delete-from-held. Ordered so a crash
 * mid-move can only leave a file BOTH routed AND held (recoverable — the routed
 * copy wins, a re-identify is a no-op delete) and NEVER neither (a "drop").
 *
 * Validates docType ∈ DOC_TYPE_TAXONOMY. The bytes are already in the blobStore
 * (put when the file was held), and the fileHash IS the content id, so this only
 * records the mapping — no re-read of bytes needed. Idempotent-ish: re-identifying
 * an already-moved file (no held row) is an error (not found) since the routed
 * copy already exists; identifying the same held file twice with the same address
 * is a data_room_doc upsert (no-op) + held delete.
 */
export async function identifyHeldDoc(args: {
  readonly poolId: string;
  readonly fileHash: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly notes?: string;
}): Promise<IdentifyHeldResult> {
  const taxo = docTypeById(args.docType);
  if (!taxo) {
    return { status: 'error', error: `invalid_doc_type:${args.docType}` };
  }
  const row = heldStore().get(args.poolId, args.fileHash);
  if (!row) {
    return { status: 'error', error: 'held_doc_not_found' };
  }

  // SLICE 4: a held file identified AS a tier-a doc now enters the underwrite
  // selection → extract its content date. Bytes are already in the blob store
  // (put when held); the fileHash is the content id. Best-effort — a fetch/parse
  // miss yields null (uploadedAt tiebreak), never fails the identify move.
  const ingest = taxo.tier === 'ingesting';
  let docEffectiveDate: string | null = null;
  if (ingest) {
    const bytes = await blobStore.getBlob(row.fileHash as ContentHash);
    if (bytes !== null) docEffectiveDate = await extractEffectiveDate(bytes, ingest);
  }

  // Build the routed entry from the held row (its fileName/mimeType/size ride the
  // held record; loan/docType are the human's identification).
  const entry: DataRoomDocEntry = {
    loanInPoolId: args.loanInPoolId,
    docType: taxo.id,
    fileHash: row.fileHash,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    uploadedAt: nowIso(),
    notes: args.notes ?? null,
    tier: taxo.tier,
    ingest,
    docEffectiveDate,
  };

  // 1) Persist-to-doc FIRST (durable). Then 2) delete-from-held — the clean move.
  persistDataRoomEntries(args.poolId, [entry]);
  heldStore().delete(args.poolId, args.fileHash);

  return {
    status: 'routed',
    loanInPoolId: entry.loanInPoolId,
    docType: entry.docType,
    fileHash: entry.fileHash,
  };
}

// ---------------------------------------------------------------------------
// Public API — the manual PIN override (SLICE 4; available, never required).
//
// Pin one version (file_hash) of a (loan, docType) slot as the underwrite winner,
// overriding the latest-content-date tiebreak. Default (no pin) = latest-date
// wins, zero human action. Pin is EXCLUSIVE per slot (pinning one clears the
// others). Unpin → back to latest-date-wins.
// ---------------------------------------------------------------------------

export interface PinResult {
  readonly status: 'pinned' | 'unpinned' | 'error';
  readonly loanInPoolId?: string;
  readonly docType?: string;
  readonly fileHash?: string;
  readonly error?: string;
}

/** Pin a specific version (fileHash) as the winner of its (loan, docType) slot.
 *  Validates docType ∈ taxonomy + that the version exists in this pool's slot. */
export function pinDataRoomDoc(args: {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly fileHash: string;
}): PinResult {
  const taxo = docTypeById(args.docType);
  if (!taxo) return { status: 'error', error: `invalid_doc_type:${args.docType}` };
  const ok = docStore().pinSlot(args.poolId, args.loanInPoolId, args.docType, args.fileHash);
  if (!ok) return { status: 'error', error: 'doc_not_found' };
  return { status: 'pinned', loanInPoolId: args.loanInPoolId, docType: taxo.id, fileHash: args.fileHash };
}

/** Clear the pin on a (loan, docType) slot → latest-content-date-wins again. */
export function unpinDataRoomDoc(args: {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
}): PinResult {
  const taxo = docTypeById(args.docType);
  if (!taxo) return { status: 'error', error: `invalid_doc_type:${args.docType}` };
  docStore().unpinSlot(args.poolId, args.loanInPoolId, args.docType);
  return { status: 'unpinned', loanInPoolId: args.loanInPoolId, docType: taxo.id };
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
