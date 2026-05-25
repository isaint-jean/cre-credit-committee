/**
 * Composite cache key for the re-upload short-circuit (Tier B of issue #10,
 * ADR §6).
 *
 * Maps (per-slot bytes hash + per-extractor versions) → a single ContentHash
 * suitable as a primary key in extraction_input_cache. Same algorithm as
 * record-id hashing: JCS canonical SHA-256 over the inputs object. The
 * canonicalization makes the key insensitive to key ordering and whitespace,
 * which means callers don't need to worry about how they spell or order the
 * inputs object — only the actual values matter.
 *
 * What the key includes:
 *   - slotHashes: { cf: ContentHash | null, rentRoll: ContentHash | null,
 *                   asr: ContentHash | null }
 *   - extractorVersions: { cf, rentRoll, asr, engine } (the four version
 *     strings stamped into ExtractionResult.extractorVersions + the
 *     extraction-engine top-level version)
 *
 * What the key does NOT include:
 *   - The marketBenchmarks / creditManifesto / librarySnapshot references.
 *     Those are inputs to INGEST, not to EXTRACTION; the cache only
 *     short-circuits extraction.
 *   - loanTerms, propertyHint, marketLiquidityHint — those flow through to
 *     the composer but don't enter the AI extraction pipeline; they're
 *     deterministic projections over slot bytes. (loanTerms IS used by the
 *     composer to populate ExtractionResult.loanTerms, but it's structural,
 *     not extracted via AI. We treat it as out-of-cache-key for now;
 *     if the same slot bytes are re-uploaded with different loanTerms,
 *     the cached extractionResult.loanTerms will reflect the first call's
 *     value — see "known edge case" below.)
 *
 * Known edge case: if the same bytes are re-uploaded with different
 * loanTerms / propertyHint values, the cache hit returns the FIRST call's
 * ExtractionResult.id with its embedded loanTerms. This is the cache's
 * defining trade-off: re-running with different non-byte inputs would
 * require re-running adapters (defeating the cache). For the production
 * flow (admin tooling), loanTerms is fixed per deal; this is acceptable.
 * If/when the input mix changes, expand this key.
 */

import type { ContentHash } from '@cre/contracts';
import { computeContentHash } from './content-hash.js';

export interface ExtractionInputKeyArgs {
  readonly slotHashes: {
    readonly cf: ContentHash | null;
    readonly rentRoll: ContentHash | null;
    readonly asr: ContentHash | null;
    readonly pca: ContentHash | null;
  };
  readonly extractorVersions: Record<string, string>;
}

export function computeExtractionInputKey(args: ExtractionInputKeyArgs): ContentHash {
  // JCS canonicalization (inside computeContentHash) lex-sorts object keys
  // and produces deterministic byte output. Same logical inputs → same key
  // regardless of source-code spelling.
  return computeContentHash({
    slotHashes: args.slotHashes,
    extractorVersions: args.extractorVersions,
  });
}
