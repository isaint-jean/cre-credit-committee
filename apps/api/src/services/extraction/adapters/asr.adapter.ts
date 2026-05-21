/**
 * ASR adapter — sole call site of parseDocument + ASR-sourced extractors in
 * the composer path.
 *
 * Two-function split:
 *   - runAsrAdapter(slot)          external entry point; what the composer calls
 *   - runAsrAdapterOnDocument(...)  internal core; what tests call directly
 *
 * The split exists because parseDocument produces an intermediate typed value
 * (ParsedDocument) that's the substrate for THREE downstream extractor calls.
 * Tests that exercise the adapter's coordination logic should not have to
 * round-trip through PDF byte parsing — they synthesize ParsedDocument inputs
 * directly and call runAsrAdapterOnDocument.
 *
 * Status mapping (Option C):
 *
 *   - parseDocument throws (corrupt PDF / unsupported format) → 'failed'
 *     (the only failure mode unique to runAsrAdapter; the inner function
 *     never re-parses bytes)
 *   - all three sub-extractors rejected                         → 'failed'
 *     (reachable as of v0.2.0 / Ticket I (#6); DEFAULT_ASR_DEPS.extractAsr
 *     is now extractASR(doc), which can throw on AI/network failure. The
 *     prior v0.1.0 placeholder always resolved to null, which made this
 *     branch dead-but-correct.)
 *   - mix of throws/nulls with no non-null value               → 'empty'
 *     (rejections collapse to null via unwrapOrWarn; the slot did its job,
 *     the document simply didn't carry the thing)
 *   - at least one non-null value                              → 'ok'
 *     (value carries the populated subset; sourceRefs emit one per kind)
 *
 * SourceDocumentRef emission on 'ok': one ref per populated kind, all
 * sharing the same bufferHash. 'empty' and 'failed' emit zero refs (same
 * discipline as CF and rent-roll adapters — don't stamp a kind we didn't
 * actually extract).
 *
 * The Promise.allSettled array order is LOAD-BEARING. See the inline comment
 * immediately above the array literal.
 *
 * Adapter version is local (ASR_ADAPTER_VERSION). Ticket D will harvest
 * per-extractor versions into a new ExtractionResult field; until then the
 * composer projects only EXTRACTION_ENGINE_VERSION into the result.
 */

import type {
  ASRExtraction,
  ContentHash,
  PropertyMetadata,
  PropertyMetadataSource,
  RentRoll,
  RentRollExtraction,
  RentRollSource,
  SourceDocumentRef,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { parseDocument } from '../../document-parser.service.js';
import { extractRentRollFromDocument } from '../../extract-rent-roll-from-document.js';
import { extractPropertyMetadata } from '../../extract-property-metadata.js';
import { extractASR } from '../../extract-asr.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';
import { projectToRentRollExtraction } from './rent-roll.adapter.js';

/** Bump when this adapter's contract with downstream changes. Stamped into
 *  ExtractionResult.extractorVersions['asr'] by the composer's version
 *  harvester (Ticket D).
 *
 *  History:
 *    0.1.0 — initial. DEFAULT_ASR_DEPS.extractAsr was a null-returning
 *            placeholder; the `asr` field was always null in production.
 *    0.2.0 — Ticket I (#6). DEFAULT_ASR_DEPS.extractAsr is now extractASR
 *            (AI-driven). Adapter coordination/contract unchanged. */
export const ASR_ADAPTER_VERSION = '0.2.0';

/**
 * One outcome value covers three ExtractionResult-relevant fields PLUS one
 * auxiliary record. propertyMetadata has no ExtractionResult slot — the
 * composer's output widens to carry it sibling-style per Finding 2 decision 2a.
 * rentRollFallback feeds pickRentRoll() in the composer's projection step.
 *
 * As of v0.2.0, `asr` carries the AI-extracted broker headline numbers
 * (implied value / cap rate / underwritten NOI) when present, else null.
 */
export interface AsrAdapterValue {
  readonly asr: ASRExtraction | null;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly rentRollFallback: RentRollExtraction | null;
}

/**
 * Sub-extractor dependencies. Both adapter entry points take this as an
 * optional final parameter (defaulting to DEFAULT_ASR_DEPS). Production
 * code calls the adapter without supplying deps; tests pass mocked deps
 * to control sub-extractor behavior without making AI calls.
 *
 * Ticket I (#6) shipped extractASR; only DEFAULT_ASR_DEPS.extractAsr
 * changed at that point — the adapter body and the array order stayed
 * untouched, validating this dep-injection seam end-to-end.
 */
export interface AsrAdapterDeps {
  readonly extractRentRoll:
    (doc: ParsedDocument, source: RentRollSource) => Promise<RentRoll | null>;
  readonly extractPropertyMetadata:
    (doc: ParsedDocument, source: PropertyMetadataSource) => Promise<PropertyMetadata | null>;
  readonly extractAsr:
    (doc: ParsedDocument) => Promise<ASRExtraction | null>;
}

export const DEFAULT_ASR_DEPS: AsrAdapterDeps = {
  extractRentRoll: extractRentRollFromDocument,
  extractPropertyMetadata: extractPropertyMetadata,
  extractAsr: extractASR,
};

/**
 * Unwrap a Promise.allSettled result by position. Fulfilled-with-null and
 * rejected both collapse to null in the return value; rejections also log a
 * grep-friendly warning tagged by sub-extractor so the throw is visible at
 * debug time.
 *
 * Log format (stable, grep-able):
 *   [asr.adapter] sub-extractor rejected: <diagnosticTag>: <message> TODO(observability)
 *
 * TODO(observability): promote each call site to a typed log event when
 * observability infrastructure lands. The console.warn is a stopgap.
 *
 * Private to this file. If a second multi-extractor adapter materializes,
 * lift to extractor-outcome.ts then — not before.
 */
function unwrapOrWarn<T>(
  result: PromiseSettledResult<T | null>,
  diagnosticTag: string,
): T | null {
  if (result.status === 'fulfilled') return result.value;
  const reason = result.reason as Error | undefined;
  const message = reason?.message ?? String(result.reason);
  // eslint-disable-next-line no-console -- TODO(observability): typed log event
  console.warn(
    `[asr.adapter] sub-extractor rejected: ${diagnosticTag}: ${message} TODO(observability)`,
  );
  return null;
}

/**
 * External entry point.
 *
 *   1. Hash the buffer (for sourceRefs + so the inner function gets a hash
 *      without re-touching bytes).
 *   2. parseDocument(buffer, filename, 'application/pdf'). mimeType is
 *      hardcoded: the slot is named asrPdf by contract; threading mimeType
 *      through SlotInput would duplicate the format commitment the slot
 *      name already carries.
 *   3. Delegate to runAsrAdapterOnDocument(doc, bufferHash).
 *   4. Patch the returned outcome's durationMs to include parseDocument
 *      time (decision (b): operationally more useful for the composer).
 *
 * parseDocument-throws is the ONE failure mode unique to this function.
 */
export async function runAsrAdapter(
  slot: SlotInput,
  deps: AsrAdapterDeps = DEFAULT_ASR_DEPS,
): Promise<ExtractorOutcome<AsrAdapterValue>> {
  const t0 = Date.now();
  const bufferHash = computeBufferContentHash(slot.buffer);

  let doc: ParsedDocument;
  try {
    doc = await parseDocument(slot.buffer, slot.filename, 'application/pdf');
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'parseDocumentThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'parseDocument failed'}`,
      },
    };
  }

  const inner = await runAsrAdapterOnDocument(doc, bufferHash, deps);
  // Decision (b): outer durationMs includes parseDocument time, so the composer
  // sees total wallclock for this slot. Inner durationMs is overwritten.
  return { ...inner, durationMs: Date.now() - t0 };
}

/**
 * Internal core. Exported so tests can synthesize ParsedDocument inputs and
 * call directly without going through PDF byte parsing.
 *
 * bufferHash is passed in because the bytes are gone by the time this
 * function runs.
 */
export async function runAsrAdapterOnDocument(
  doc: ParsedDocument,
  bufferHash: ContentHash,
  deps: AsrAdapterDeps = DEFAULT_ASR_DEPS,
): Promise<ExtractorOutcome<AsrAdapterValue>> {
  const t0 = Date.now();

  // ORDER IS LOAD-BEARING. Indices map by position to the local variables
  // unpacked below. If you reorder this array (e.g., alphabetize it), you
  // MUST update the three unwrapOrWarn calls AND the status-mapping logic
  // that follows.
  //
  //   Index 0 — AI rent-roll fallback   → RentRoll | null
  //               (deps.extractRentRoll with source='asr_table')
  //   Index 1 — property metadata        → PropertyMetadata | null
  //               (deps.extractPropertyMetadata with source='asr_extraction')
  //   Index 2 — ASR extraction           → ASRExtraction | null
  //               (deps.extractAsr; default in DEFAULT_ASR_DEPS is extractASR
  //                as of v0.2.0 / Ticket I (#6). Tests inject mocks here to
  //                avoid live AI calls.)
  const results = await Promise.allSettled<
    [Promise<RentRoll | null>, Promise<PropertyMetadata | null>, Promise<ASRExtraction | null>]
  >([
    deps.extractRentRoll(doc, 'asr_table'),
    deps.extractPropertyMetadata(doc, 'asr_extraction'),
    deps.extractAsr(doc),
  ]);

  // Unwrap by position. Throws collapse to null + console.warn.
  const rentRollLegacy = unwrapOrWarn(results[0]!, 'AI:RentRoll');
  const propertyMetadata = unwrapOrWarn(results[1]!, 'AI:PropertyMetadata');
  const asr = unwrapOrWarn(results[2]!, 'AI:ASR');

  // Project rent-roll legacy → spine shape (reuses rent-roll.adapter.ts's
  // documented lossy projection — same field mapping, same caveats).
  const rentRollFallback = rentRollLegacy === null
    ? null
    : projectToRentRollExtraction(rentRollLegacy);

  // 'failed' if all three sub-extractors rejected. Reachable as of v0.2.0
  // (Ticket I #6): extractASR is now an AI call that can throw on
  // network/API failure. Test-asr-adapter.ts case 8 exercises this branch
  // (all three deps reject → status 'failed' / error 'allSubExtractorsThrew').
  const allRejected = results.every((r) => r.status === 'rejected');
  if (allRejected) {
    const causes = results.map((r) => {
      const e = r.status === 'rejected' ? (r.reason as Error | undefined) : undefined;
      return `${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'}`;
    });
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'allSubExtractorsThrew',
        message: `all three sub-extractors rejected; causes: [${causes.join(' | ')}]`,
      },
    };
  }

  const hasAsr = asr !== null;
  const hasPm = propertyMetadata !== null;
  const hasRrf = rentRollFallback !== null;

  if (!hasAsr && !hasPm && !hasRrf) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'parsed document; no extractor produced data',
    };
  }

  // ok path: emit one sourceRef per populated kind, all sharing bufferHash.
  // Same physical document, distinct semantic extractions — contract-allowed
  // dual/triple-kind emission (mirrors the CF adapter's dual-kind pattern).
  const refs: SourceDocumentRef[] = [];
  if (hasAsr) refs.push({ kind: 'asr', contentHash: bufferHash });
  if (hasPm) refs.push({ kind: 'property_metadata', contentHash: bufferHash });
  if (hasRrf) refs.push({ kind: 'rent_roll', contentHash: bufferHash });

  return {
    status: 'ok',
    value: { asr, propertyMetadata, rentRollFallback },
    sourceRefs: refs,
    adapterVersion: ASR_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}
