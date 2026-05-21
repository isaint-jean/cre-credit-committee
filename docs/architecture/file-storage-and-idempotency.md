# File Storage and Idempotency Model for buildExtractionResult

> **Status:** Accepted 2026-05-20.
> **Closes:** Issue #3 (design half — Tier A). Implementation half tracked separately.
> **Scope:** How raw uploaded bytes relate to `ExtractionResult`, what idempotency means for re-uploads, and which decisions the composer has already locked in by virtue of having shipped without this doc.

---

## §1. Context — implementation preceded the design

Issue #3 (`Define file storage and idempotency model for buildExtractionResult`) was opened as a **blocker** for the composer, with the acceptance criterion *"ADR (or short design doc) accepted before composer implementation begins."* That gate was implicitly relaxed: the composer (`apps/api/src/services/extraction/build-extraction-result.ts`) shipped in commit `feaf71e`, the build-and-ingest route (`apps/api/src/routes/build-and-ingest.routes.ts`) shipped in commit `1777a90`, and the surrounding adapters + tests landed across `3b0742c` / `3758253` / `ab99534` — all without a written design.

This document retroactively captures the decisions the shipped implementation embodies, plus the gaps it has. It is honest about the inversion: the composer didn't wait. Future record-graph PRs MUST wait — see the cross-references in §8.

---

## §2. Current state (as of this ADR)

### §2.1 What works

| Property | Mechanism | Verified by |
|---|---|---|
| **Per-file content addressing.** Each uploaded file's bytes are hashed via `computeBufferContentHash(buffer)` to derive a `ContentHash` (SHA-256, lowercase hex). | `apps/api/src/util/content-hash.ts` + per-adapter calls (`cf.adapter.ts:79`, `rent-roll.adapter.ts:166`, `asr.adapter.ts:55`). | Per-adapter unit tests. |
| **`SourceDocumentRef` records carry only `{ kind, contentHash }`.** No bytes inline; the ref is a pointer. | `packages/contracts/src/extraction.ts` (`SourceDocumentRef` shape, `SOURCE_DOCUMENT_KINDS`). | `test:extraction-contract`. |
| **Record-level idempotency.** Same input file set + same extractor versions → same `ExtractionResult.id`. The id is JCS-canonical SHA-256 of the body (including `sourceDocuments[*].contentHash` and `extractorVersions`). | `computeExtractionResultId` + `INSERT … ON CONFLICT(id) DO NOTHING` in `record-graph-store.ts`. | `test-build-and-ingest-route.ts` Case 8; `test-build-and-ingest-e2e.ts` Case 4. |

### §2.2 What does NOT work

| Gap | Symptom | Cause |
|---|---|---|
| **Bytes are not persisted anywhere.** `multer.memoryStorage()` holds them in RAM for the request lifetime; after the response is sent, Node GCs the buffers. | `sourceDocuments[*].contentHash` references bytes that no longer exist on disk or in any store. The hash is provenance-only. | No `BlobStore` exists. Search for `getByContentHash` / `loadBlob` / `fetchBlob` across `apps/api/src` returns zero hits. |
| **Re-upload of identical bytes re-runs all extractors.** Record-level idempotency dedupes the OUTPUT (same `ExtractionResult.id` → ON CONFLICT no-op), not the WORK. The AI extractors (`extractASR`, `extractPropertyMetadata`, `extractRentRollFromDocument`) run again on every upload. | Re-extraction is O(N AI calls), not O(1). | No `ContentHash` → `ExtractionResult.id` lookup table. The composer has no short-circuit path. |

### §2.3 Legacy contrast

`apps/api/src/services/uw-intelligence.service.ts` (the legacy `/api/analyses` flow, NOT on the new spine) has a working filesystem-backed file persistence at `.data/uploads/<recordId>.<ext>` (lines 64–104). The pattern is proven; the new spine has not adopted it. The legacy storage is keyed by opaque `recordId`, not `contentHash`, so it cannot be lifted as-is — it lacks the dedupe property.

---

## §3. Decisions (committed — pinned by issue #3)

These were pre-committed in the ticket body. The shipped composer is consistent with them.

| # | Decision | Status |
|---|---|---|
| **C1** | **Re-upload semantics → dedupe to existing blob, reuse `ExtractionResult.id`.** Same bytes uploaded twice ⇒ same hash ⇒ same `SourceDocumentRef` ⇒ same canonical body ⇒ same id. | Works at the record level today; will extend to skip extraction once a blob store exists (Tier B). |
| **C2** | **Same file in two deals → one blob, two refs.** Blob is identified by hash; deal is identified by `ExtractionResult.id`. They are orthogonal. | Compatible with current content-addressing. No blob exists yet to be shared. |
| **C3** | **Content-address scheme: SHA-256 over raw bytes, per file.** Same algorithm as record-id hashing (JCS for records; raw bytes for blobs). | Already in use via `computeBufferContentHash`. No change. |
| **C4** | **Hard invariant.** Same input file set + same extractor versions ⇒ same `ExtractionResult.id`. | Enforced via JCS-canonical hash of `ExtractionResult` body including `sourceDocuments` and `extractorVersions`. Idempotency tests already cover this. |

---

## §4. Decisions (resolved by this ADR)

The four open questions issue #3 left for the design doc.

### §4.1 Storage backend → filesystem (v1); S3 is a future plugin

**Decision.** v1 stores blobs on the local filesystem under:

```
.data/blobs/<hash[0:2]>/<hash>.bin
```

Two-level sharding by hash prefix keeps any directory bounded as upload volume grows. The path is content-derived, no manifest needed.

**Rationale.**
- Greenfield: no production traffic yet, no S3 bucket provisioned, no cost or scale constraint that filesystem can't satisfy.
- Keeps the dev loop simple: `.data/` is already the convention (record-graph-store, audit-events-store, etc. all sit there in dev).
- The interface in §5 is the actual contract; the backend is a swap. S3/MinIO/etc. lands as a plugin when production scale demands it — not before.

**Rejected.** SQLite blob storage (rejected because the record-graph store already lives in SQLite and we don't want a single DB file growing without bound from binary content; backup/replay strategies differ for blobs vs. records).

### §4.2 Orphan/cleanup policy → append-only, no GC (v1)

**Decision.** Blobs are append-only. No garbage collection in v1.

**Rationale.**
- Storage is cheap; the volume is bounded by user uploads (not generated artifacts).
- A GC pass requires **reachability analysis** from current `ExtractionResult.sourceDocuments` records, which adds infrastructure (a graph walk, a quiesce period, transactional coordination with the record-graph store). The complexity isn't justified at v1 scale.
- Re-running a deleted-from-store extraction would re-create the blob (content-addressed), so "leaks" are bounded by total uploaded volume, not by churn.

**When this gets revisited.** When storage costs become real, or when a privacy/compliance requirement forces hard-delete (e.g. user-data deletion request). At that point: a follow-up ticket adds the reachability scan + an `orphans-gc` script under `apps/api/src/scripts/`. Documented as Tier C in the implementation ticket.

### §4.3 Streaming vs buffering → buffering (current behavior)

**Decision.** Keep `multer.memoryStorage()` with the 1GB limit. No streaming.

**Rationale.**
- Streaming changes the adapter contract: `slot.buffer: Buffer` would have to become `slot.stream: ReadableStream` or `slot.path: string`. That's a larger refactor touching every adapter (`cf.adapter.ts`, `rent-roll.adapter.ts`, `asr.adapter.ts`) plus the composer.
- Production PDF/Excel sizes haven't been measured; ASR PDFs are typically <50MB; rent rolls and CF workbooks are typically <20MB. The 1GB limit is generous headroom.
- The blob-write step in Tier B can stream-from-memory-buffer to disk without changing the adapter contract — `fs.createWriteStream(path)` accepts a `Buffer`.

**When this gets revisited.** When a real large-file scenario appears (someone uploads a 500MB rent roll and the API OOMs). At that point: refactor adapters to accept a `slot.path` string + a `BlobStore.openReadStream(hash)`. Documented as Tier C in the implementation ticket.

### §4.4 Hash-per-file vs bundle hash → per-file (already in use)

**Decision.** Per-file `ContentHash`. No separate bundle hash.

**Rationale.**
- Per-file is already in use via `computeBufferContentHash` and is required for C2 (same file in two deals → one blob).
- A "bundle hash" is implicit: `ExtractionResult.id` is JCS-hashed over the body, which includes `sourceDocuments[*].contentHash`. Same set of file hashes (in any order, since JCS lexsorts keys but `sourceDocuments` is an array — see §4.4.1 below) ⇒ same `extractionResult.id`. The bundle's identity is the record's identity. No second hash needed.

**§4.4.1 Array-order subtlety.** `sourceDocuments` is an array, and JCS preserves array order. Today the composer concatenates refs in slot order `[cf, rentRoll, asr]` (see `build-extraction-result.ts:257–259`). Two uploads that produce the same set of refs but in different order would produce different `extractionResult.id`s. This is acceptable because the slot order is fixed by the route handler (always `[cf, rentRoll, asr]`); a re-upload with the same files goes through the same path. If a future producer emits refs in non-deterministic order, sort by `(kind, contentHash)` before assigning — see the inline comment in `build-extraction-result.ts:49–60`.

---

## §5. Interface sketch

The actual implementation lands in Tier B. This is the contract Tier B MUST satisfy.

```ts
/** Content-addressed blob store. Implementations: FilesystemBlobStore (v1);
 *  S3BlobStore (future, behind the same interface). */
interface BlobStore {
  /** Persist bytes; return their content hash. Idempotent: if the hash
   *  already exists, this is a no-op and returns the existing hash. */
  putBlob(buffer: Buffer): Promise<ContentHash>;

  /** Retrieve bytes by content hash. Returns null if not present. */
  getBlob(hash: ContentHash): Promise<Buffer | null>;

  /** Existence check without retrieving bytes. Cheaper than getBlob for
   *  short-circuit decisions. */
  hasBlob(hash: ContentHash): Promise<boolean>;
}
```

**Properties Tier B must guarantee.**

| ID | Property |
|---|---|
| **B1** | `putBlob(buffer)` is idempotent. Calling it twice with identical bytes returns the same `ContentHash` and produces no net storage change. |
| **B2** | The returned `ContentHash` from `putBlob(buffer)` MUST equal `computeBufferContentHash(buffer)`. The blob's identity in the store is the buffer's content hash — no separate ID. |
| **B3** | `getBlob(h)` returns either bytes byte-identical to those originally `putBlob`'d under `h`, or `null`. No partial reads, no transformed reads. |
| **B4** | `hasBlob(h)` is a strict subset of `getBlob(h) !== null` and may be implemented more cheaply (e.g. `fs.access` instead of `fs.readFile`). |
| **B5** | `BlobStore` is the ONLY module that touches blob storage. `services/extraction/*`, route handlers, and adapters MUST go through this interface — no direct `fs.writeFile` to `.data/blobs/`. |

**What this interface does NOT include (intentionally).**
- `deleteBlob` — append-only per §4.2.
- `listBlobs` — no enumeration in v1; reachability analysis is deferred.
- Streaming methods — buffering per §4.3.
- Metadata or tags — content-addressing means no out-of-band metadata; the bytes ARE the identity.

---

## §6. Re-upload short-circuit pattern

Once Tier B lands, the build-and-ingest route can short-circuit before the composer runs.

```ts
// Pseudo-code for Tier B. Goes in build-and-ingest.routes.ts, before the
// `await deps.buildExtractionResult(...)` call.

const slotHashes = [
  asr  ? computeBufferContentHash(asr.buffer)  : null,
  rr   ? computeBufferContentHash(rr.buffer)   : null,
  cf   ? computeBufferContentHash(cf.buffer)   : null,
];

// Composite cache key: the set of input hashes + the current extractor versions.
// Same slot bytes + same extractor versions ⇒ same ExtractionResult.id (C4).
const cacheKey = computeExtractionInputKey({
  slotHashes,
  extractorVersions: CURRENT_EXTRACTOR_VERSIONS,
});

const cachedExtractionResultId = await extractionCache.get(cacheKey);
if (cachedExtractionResultId !== null) {
  // Already extracted these exact bytes under these exact versions. Fetch
  // the cached ExtractionResult from the record-graph store and skip the
  // composer entirely. Adapter AI calls do not run.
  const cached = recordGraphStore.getExtractionResult(cachedExtractionResultId);
  if (cached !== null) {
    // ... continue to ingest as if composer had just produced this ...
    return cached;
  }
  // Cache hit but record missing ⇒ orphaned cache entry. Fall through and
  // re-extract. (Edge case; expected only after manual record deletion.)
}

// Cache miss: persist blobs, then run composer.
if (asr) await blobStore.putBlob(asr.buffer);
if (rr)  await blobStore.putBlob(rr.buffer);
if (cf)  await blobStore.putBlob(cf.buffer);

const composed = await deps.buildExtractionResult({ slots, ... });
await extractionCache.set(cacheKey, composed.extractionResult.id);
```

**Required new piece for Tier B beyond the BlobStore interface:** an `extractionCache` keyed by the composite `(slotHashes, extractorVersions)` tuple, mapping to `ExtractionResult.id`. This is a separate concern from blob storage proper — blobs persist bytes; the extraction cache persists the bytes-to-output mapping that makes re-upload O(1). Likely lives in a new table in the existing record-graph SQLite database.

**Cache invalidation.** When any `extractorVersions[k]` advances, the composite key changes, so re-uploads with the new versions will cache-miss and re-extract. Old cache entries become unreachable from `CURRENT_EXTRACTOR_VERSIONS` but remain in the table (consistent with the append-only blob policy §4.2). If table bloat becomes real, a periodic prune of entries whose `extractorVersions` are no longer current is straightforward.

---

## §7. What this ADR does NOT decide

Tier B implementation specifics — locked in the Tier B PR, not here:

| Item | Why deferred |
|---|---|
| Exact method signatures (`putBlob` vs `put`, sync vs async error returns vs throws, etc.) | Naming bikeshed; settle when writing the code. |
| Error handling for `putBlob` failures (disk full, permission denied, ENOENT on parent dir) | Implementation detail. Throwing with a typed error class is the expected default. |
| Transactional semantics between `BlobStore.putBlob` and `recordGraphStore.insertExtractionResult` | The compose step is naturally idempotent (content-addressed); partial failures land bytes-without-record (acceptable — re-upload completes the picture) or record-without-bytes (an orphan ref the next GC pass can detect). Exact recovery semantics: Tier B PR. |
| Cache table schema, FK relationships, ON CONFLICT behavior | Tier B implementation. |
| Whether `BlobStore` is injected via `BuildAndIngestDeps` or imported as a singleton | Same DI pattern as `recordGraphStore`. Tier B PR. |
| Test fixtures for the blob store (a `MemoryBlobStore` for unit tests, real filesystem for integration) | Tier B PR. |
| Production migration path: when a real first user uploads, do we need to seed anything? | No — `.data/blobs/` is created on first `putBlob`. No migration. |

---

## §8. Cross-references

- **Companion contract module:** `packages/contracts/src/extraction.ts` — `SourceDocumentRef` shape, `SOURCE_DOCUMENT_KINDS` enumeration, `ContentHash` brand.
- **Hash discipline:** `apps/api/src/util/content-hash.ts` — `computeBufferContentHash` (used by adapters) and the JCS+SHA-256 record-id factories (used by the composer).
- **Composer:** `apps/api/src/services/extraction/build-extraction-result.ts` — see the inline comment block at lines 40–65 on source-ref ordering.
- **Route:** `apps/api/src/routes/build-and-ingest.routes.ts` — the integration point where Tier B short-circuits.
- **Architectural precedent:** `docs/architecture/batch6-record-graph-and-resolution.md` §5.1 (strict-dispatch storage decision; dual-write rejected — same content-addressing discipline applies here).
- **Identity precedent:** `docs/architecture/revision-lineage-spec.md` §5 (content-hash boundary; the principle that included-vs-excluded fields are explicit, not implicit — this ADR follows that convention for `BlobStore`'s "what it stores").

---

## §9. Acceptance-criteria mapping

Mapping back to issue #3's acceptance criteria, as a closeout:

- [x] Decisions 3 and 4 pre-committed in the ticket — §3, C1 and C2.
- [x] ADR (or short design doc) accepted — this document.
- [ ] Storage interface documented in code (`apps/api/src/storage/blob-store.ts` if filesystem; new module if S3) — **deferred to Tier B**.
- [x] Idempotency property has at least one test — already exists (`test-build-and-ingest-route.ts:360` Case 8; `test-build-and-ingest-e2e.ts:318` Case 4).
- [ ] Re-upload of an identical file is O(1) — no re-extraction — **deferred to Tier B** (§6 pattern).
- [ ] Orphan-GC policy documented — §4.2 (no GC in v1; revisit triggers documented).
- [x] Linked to epic via `extraction-pipeline` label.

The three unchecked items are the Tier B implementation surface and are the scope of the follow-up ticket.

---

*Accepted 2026-05-20. Subsequent revisions append below with a dated change log.*
