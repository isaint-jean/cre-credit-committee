/**
 * Source-document intake contracts.
 *
 * Per-deal typed slots for source documents that PAIR with completed UW
 * workbooks (HistoricalUnderwriting records). Empty optional slots are
 * NOT errors — a deal mid-gathering with only ASR + CF is valid.
 *
 * Storage: apps/api/.data/source-docs/<historicalUwId>/<slot>/<fileHash>.<ext>
 * Manifest: apps/api/.data/source-docs/source-doc-manifests.json
 *
 * Identity: every entry FKs to HistoricalUnderwriting.id (uuidv4); no new
 * id space. Files are content-addressed by SHA-256 of bytes.
 *
 * Scope discipline: this is an upload-and-organize layer. NOT wired to
 * extraction or ingest pipelines; that's a separate future build.
 */

export const SOURCE_DOC_SLOTS = [
  'asr',
  'cf',
  'rent_roll',
  'pca',
  'seller_uw',
  't12',
  'appraisal',
] as const;
export type SourceDocSlot = (typeof SOURCE_DOC_SLOTS)[number];

export const REQUIRED_SOURCE_DOC_SLOTS: ReadonlyArray<SourceDocSlot> = ['asr', 'cf'];

/** Per-file metadata. Content-addressed; the blob lives on disk at
 *  .data/source-docs/<historicalUwId>/<slot>/<fileHash>.<ext>. */
export interface SourceDocEntry {
  readonly fileHash: string;            // hex SHA-256 of bytes (64 chars)
  readonly originalFileName: string;    // what the user uploaded
  readonly size: number;                // bytes
  readonly mimeType: string;
  readonly uploadedAt: string;          // ISO-8601
  readonly notes: string | null;        // optional analyst note; null when absent
}

/** Per-deal source-doc manifest. One per historicalUwId that has any docs. */
export interface DealSourceDocManifest {
  readonly historicalUwId: string;      // FK -> HistoricalUnderwriting.id
  readonly dealName: string;            // denormalized for human-readable scanning
  readonly slots: {
    readonly asr:        ReadonlyArray<SourceDocEntry>;
    readonly cf:         ReadonlyArray<SourceDocEntry>;
    readonly rent_roll:  ReadonlyArray<SourceDocEntry>;
    readonly pca:        ReadonlyArray<SourceDocEntry>;
    readonly seller_uw:  ReadonlyArray<SourceDocEntry>;
    readonly t12:        ReadonlyArray<SourceDocEntry>;
    readonly appraisal:  ReadonlyArray<SourceDocEntry>;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Manifest file shape (the single source-doc-manifests.json on disk). */
export interface SourceDocManifestFile {
  readonly version: 1;
  readonly manifests: ReadonlyArray<DealSourceDocManifest>;
}

/** Per-slot rollup for a deal — what's present, how many. NON-JUDGMENTAL:
 *  an empty optional slot is NOT an error, just visible state. */
export interface DealSlotStatus {
  readonly present: boolean;            // count > 0
  readonly count: number;
  readonly required: boolean;           // true for asr, cf; false for the rest
}

/** Completeness view for one deal. hasMinimum = both required slots present.
 *  Even hasMinimum=false is NOT an error — it just means the deal is still
 *  being assembled. The view is informational, never blocking. */
export interface DealCompleteness {
  readonly historicalUwId: string;
  readonly dealName: string;
  readonly slots: Readonly<Record<SourceDocSlot, DealSlotStatus>>;
  readonly hasMinimum: boolean;         // asr.present && cf.present
  readonly totalDocsPresent: number;    // sum of slot counts
}

/** Bulk-staging shape — files uploaded but not yet assigned to a deal+slot. */
export interface StagingFileEntry {
  readonly stagingId: string;           // uuid for this file's staging slot
  readonly fileHash: string;
  readonly originalFileName: string;
  readonly size: number;
  readonly mimeType: string;
  readonly uploadedAt: string;
}

export interface StagingBatch {
  readonly batchId: string;             // uuid for the batch
  readonly createdAt: string;
  readonly files: ReadonlyArray<StagingFileEntry>;
}

/** Body for bulk assignment. */
export interface StagingAssignment {
  readonly stagingId: string;
  readonly historicalUwId: string;
  readonly slot: SourceDocSlot;
  readonly notes?: string;
}

/** Per-staging-id outcome of an assignment operation. */
export interface StagingAssignmentResult {
  readonly stagingId: string;
  readonly status: 'assigned' | 'error' | 'skipped';
  readonly historicalUwId?: string;
  readonly slot?: SourceDocSlot;
  readonly fileHash?: string;
  readonly error?: string;
}
