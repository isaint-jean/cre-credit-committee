/**
 * Identity model — content-hash primary keys (Option A).
 *
 * Every persisted stage record's id is the SHA-256 of its canonical-JSON serialization
 * (RFC 8785 / JCS), hex-encoded. Same content ⇒ same id. Re-running an identical pipeline is
 * idempotent. The replay tuple is realized by construction.
 *
 * Branded types make ids non-interchangeable at compile time: an `AdjustedInputsId` cannot be
 * passed where a `LibrarySnapshotId` is expected, even though both are strings at runtime.
 *
 * Behavior (the actual hash function) lives outside this package — the contracts module declares
 * only the type of the function. Implementers compile against `ContentHashFn`.
 */

declare const __contentHash: unique symbol;
declare const __recordKind: unique symbol;

/**
 * SHA-256 hex digest of the JCS-canonical serialization of a value.
 * Always 64 lowercase hex characters. Branded so a raw string cannot stand in for a real hash.
 */
export type ContentHash = string & { readonly [__contentHash]: 'ContentHash' };

/**
 * Per-record id brand layered over `ContentHash`. The `K` type parameter discriminates record
 * kinds — `AdjustedInputsId` and `LibrarySnapshotId` are both `ContentHash`es but not assignable
 * to each other.
 */
type RecordId<K extends string> = ContentHash & { readonly [__recordKind]: K };

export type AdjustedInputsId       = RecordId<'AdjustedInputs'>;
export type LibrarySnapshotId      = RecordId<'LibrarySnapshot'>;
export type NarrativeFactsId       = RecordId<'NarrativeFacts'>;
export type CrossCheckResultId     = RecordId<'CrossCheckResult'>;
export type StressOutputsId        = RecordId<'StressOutputs'>;
export type ValuationConclusionId  = RecordId<'ValuationConclusion'>;
export type DoctrineEvaluationId   = RecordId<'DoctrineEvaluation'>;
export type ExtractionResultId     = RecordId<'ExtractionResult'>;
export type AssetProfileId         = RecordId<'AssetProfile'>;
export type RenderedAnalysisId     = RecordId<'RenderedAnalysis'>;
export type MarketBenchmarksId     = RecordId<'MarketBenchmarks'>;
export type CreditManifestoId      = RecordId<'CreditManifesto'>;
// Batch 1A (post-Phase 4) - rent-roll input record. Drives Year 1 rent-roll-based
// underwriting. Sourced from an uploaded rent-roll file or extracted from the
// ASR/Seller UW, with a documented precedence (rent-roll file > ASR > Seller UW).
export type RentRollId             = RecordId<'RentRoll'>;
// Batch 1H - property-metadata extractor output. Property identity + physical
// specs needed to populate the BP Spiral Property & Loan Summary header section
// and Property Detail tabs. Sourced from ASR extraction with no fallback (the
// ASR is the canonical source for property facts).
export type PropertyMetadataId     = RecordId<'PropertyMetadata'>;

// Phase 2 (post-7.2) - controlled write-back layer. These ids identify human-authored
// edit-surface artifacts that overlay RenderedAnalysis; they are NOT producer outputs
// and do NOT participate in the underwriting deterministic spine. Each lives in its
// own sibling contract module.
export type OverlayId              = string & { readonly __overlay: 'OverlayId' };       // uuid v4 (workspace grouping)
export type OverlayPatchId         = RecordId<'OverlayPatch'>;        // content-hash (immutable once created)
export type AuditEventId           = RecordId<'AuditEvent'>;          // content-hash (chain-linked)
export type CommitteeSnapshotId    = RecordId<'CommitteeSnapshot'>;   // content-hash (frozen export)

// Phase 3 (post-Phase-2-v2) - committee workflow layer. The committee action event
// is a parallel append-only chain-linked stream, distinct from the overlay-scoped
// audit log. Same identity discipline: content-hash over body including timestamp
// and previous-action pointer (temporal artifacts; chain ordering canonical).
export type CommitteeActionId      = RecordId<'CommitteeAction'>;

/**
 * Canonical content-hash function. Implementation lives in the api/util layer; producers compile
 * against this signature.
 *
 * Contract:
 *   1. Input is canonicalized via RFC 8785 (JCS): UTF-8, lexicographic key order, no whitespace,
 *      ECMAScript Number serialization.
 *   2. Hashed via SHA-256.
 *   3. Hex-lowercase encoded.
 *   4. Branded as `ContentHash` on return.
 *
 * Input constraints (caller responsibility — implementations MUST throw on violation):
 *   - no `undefined` (use `null`)
 *   - no functions, symbols, class instances, Maps, or Sets
 *   - object keys are strings only
 *   - finite numbers only (NaN / Infinity rejected)
 *   - finite recursion (no cycles)
 *
 * Determinism is the entire point. Any implementation that does not produce byte-identical output
 * for byte-identical input fails the contract.
 */
export type ContentHashFn = <T>(value: T) => ContentHash;

/**
 * Unsafe brand promotion. The api-side hash implementation calls this once per produced hash; no
 * other producer should. Centralizing the cast in one declared site makes audits trivial.
 */
export type AsRecordId<K extends string> = (hash: ContentHash) => RecordId<K>;
