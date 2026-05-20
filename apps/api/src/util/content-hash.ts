/**
 * computeContentHash — sole implementation of `ContentHashFn` from `@cre/contracts/identity`.
 *
 * SHA-256 of the canonical-JSON serialization, hex-lowercase encoded, branded as `ContentHash`.
 * Same content always produces the same hash. Different content always produces a different hash
 * (modulo SHA-256 collision resistance).
 *
 * Producers MUST use the per-record `compute*Id` factories below rather than branding raw hashes
 * — the factories give compile-time discrimination between record kinds (`AdjustedInputsId` ≠
 * `LibrarySnapshotId` etc.).
 */

import { createHash } from 'node:crypto';
import type {
  AdjustedInputsId,
  AssetProfileId,
  AuditEventId,
  CommitteeActionId,
  CommitteeSnapshotId,
  ContentHash,
  CreditManifestoId,
  CrossCheckResultId,
  DoctrineEvaluationId,
  ExtractionResultId,
  LibrarySnapshotId,
  MarketBenchmarksId,
  NarrativeFactsId,
  OverlayPatchId,
  PropertyMetadataId,
  RenderedAnalysisId,
  RentRollId,
  StressOutputsId,
  ValuationConclusionId,
} from '@cre/contracts';
import { canonicalize } from './canonical-json.js';

export function computeContentHash<T>(value: T): ContentHash {
  const canonical = canonicalize(value);
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return hex as ContentHash;
}

/**
 * SHA-256 of raw bytes (no JSON canonicalization). For SourceDocumentRef.contentHash
 * and any other byte-level provenance. Distinct from computeContentHash<T>, which
 * canonicalizes its input as JSON first — pick this one when hashing an UPLOADED
 * FILE (xlsx, pdf), pick computeContentHash<T> when hashing a record BODY.
 */
export function computeBufferContentHash(bytes: Buffer): ContentHash {
  return createHash('sha256').update(bytes).digest('hex') as ContentHash;
}

/**
 * Single-pass canonical-form + hash. Returns both so callers persisting a record can store the
 * canonical payload string AND its hash without re-running canonicalize.
 *
 * Pass the record body WITHOUT the `id` field. Using on a record that includes `id` produces a
 * payload that includes the (self-referential) id and hashes to a different value than the one
 * the record was originally constructed with — which is wrong by construction.
 */
export function serializeRecordBody<T>(body: T): { id: ContentHash; payload: string } {
  const payload = canonicalize(body);
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex');
  return { id: hex as ContentHash, payload };
}

export const computeAdjustedInputsId      = (content: unknown): AdjustedInputsId      => computeContentHash(content) as AdjustedInputsId;
export const computeLibrarySnapshotId     = (content: unknown): LibrarySnapshotId     => computeContentHash(content) as LibrarySnapshotId;
export const computeNarrativeFactsId      = (content: unknown): NarrativeFactsId      => computeContentHash(content) as NarrativeFactsId;
export const computeCrossCheckResultId    = (content: unknown): CrossCheckResultId    => computeContentHash(content) as CrossCheckResultId;
export const computeStressOutputsId       = (content: unknown): StressOutputsId       => computeContentHash(content) as StressOutputsId;
export const computeValuationConclusionId = (content: unknown): ValuationConclusionId => computeContentHash(content) as ValuationConclusionId;
export const computeDoctrineEvaluationId  = (content: unknown): DoctrineEvaluationId  => computeContentHash(content) as DoctrineEvaluationId;
export const computeExtractionResultId    = (content: unknown): ExtractionResultId    => computeContentHash(content) as ExtractionResultId;
export const computeAssetProfileId        = (content: unknown): AssetProfileId        => computeContentHash(content) as AssetProfileId;
export const computeRenderedAnalysisId    = (content: unknown): RenderedAnalysisId    => computeContentHash(content) as RenderedAnalysisId;
export const computeMarketBenchmarksId    = (content: unknown): MarketBenchmarksId    => computeContentHash(content) as MarketBenchmarksId;
export const computeCreditManifestoId     = (content: unknown): CreditManifestoId     => computeContentHash(content) as CreditManifestoId;
// Phase 2 (post-7.2) edit-surface hash factories. Same SHA-256 / JCS-canonical scheme
// as the spine record factories; the only difference is what the input body contains
// (overlay patches, audit events, committee snapshots).
export const computeOverlayPatchId        = (content: unknown): OverlayPatchId        => computeContentHash(content) as OverlayPatchId;
export const computeAuditEventId          = (content: unknown): AuditEventId          => computeContentHash(content) as AuditEventId;
export const computeCommitteeSnapshotId   = (content: unknown): CommitteeSnapshotId   => computeContentHash(content) as CommitteeSnapshotId;
// Phase 3 - committee action event hash factory. Same SHA-256/JCS scheme.
export const computeCommitteeActionId     = (content: unknown): CommitteeActionId     => computeContentHash(content) as CommitteeActionId;
// Batch 1A - rent-roll input record. Hash over the full body (asOfDate + propertyName +
// source + lines[]) so identical rent rolls round-trip with identical ids.
export const computeRentRollId            = (content: unknown): RentRollId            => computeContentHash(content) as RentRollId;
// Batch 1H - property-metadata extraction. Same scheme.
export const computePropertyMetadataId    = (content: unknown): PropertyMetadataId    => computeContentHash(content) as PropertyMetadataId;
