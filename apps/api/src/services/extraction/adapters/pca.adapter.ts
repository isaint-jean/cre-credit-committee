/**
 * PCA adapter — sole call site of `parseDocument` + `extractPca` in the
 * composer path. PCA producer ticket Phase 1+2 ship.
 *
 * Two-function split (mirrors asr.adapter.ts):
 *   - runPcaAdapter(slot)            external entry point; what the composer calls
 *   - runPcaAdapterOnDocument(...)   internal core; what tests call directly
 *
 * The split exists for the same reason ASR's does: `parseDocument` produces a
 * typed intermediate `ParsedDocument` that's the substrate for the downstream
 * AI-tier extractor (`extractPca`). Tests that exercise adapter coordination
 * should not have to round-trip through PDF byte parsing — they synthesize
 * ParsedDocument inputs directly and call runPcaAdapterOnDocument.
 *
 * Status mapping (Option C semantics):
 *   - parseDocument throws (corrupt PDF / unsupported format) → 'failed'
 *   - extractPca rejected (AI call(s) threw)                  → 'failed'
 *   - extractPca returned null (both AI calls produced nulls) → 'empty'
 *   - extractPca returned a PCAExtraction value                → 'ok'
 *     with a single SourceDocumentRef of kind 'pca'.
 *
 * Distinction from ASR adapter: ASR has THREE sub-extractors running in
 * parallel (rent-roll AI fallback, property metadata, ASR headline numbers)
 * and merges results into a tri-record output. PCA has ONE sub-extractor
 * (`extractPca`) which itself orchestrates TWO internal AI calls (Call A
 * scalars+narratives, Call B capex schedules) via `Promise.allSettled`. The
 * adapter-level outcome wraps a single PCAExtraction value; the per-call
 * partial-success policy lives inside extractPca, not at the adapter level.
 *
 * Adapter version is local (PCA_ADAPTER_VERSION). Follows the convention
 * established by ASR_ADAPTER_VERSION, CF_ADAPTER_VERSION, RENT_ROLL_ADAPTER_VERSION
 * (per-adapter local constant; the composer harvests these into the
 * ExtractionResult's extractorVersions map). Ticket D will hoist these into
 * a contract field; until then, local diagnostic data.
 */

import type {
  ContentHash,
  PCAExtraction,
  SourceDocumentRef,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { parseDocument } from '../../document-parser.service.js';
import { extractPca } from '../../extract-pca.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/**
 * Bump when this adapter's contract with downstream changes. Stamped into
 * `ExtractionResult.extractorVersions['pca']` by the composer's version
 * harvester.
 *
 * History:
 *   1.0 — initial. Phase 1+2 ship of the PCA producer ticket. Wraps
 *         `extractPca` which performs hybrid two-call AI extraction
 *         (scalars + narratives in Call A, capex schedules in Call B).
 *         Schedule-array year-by-year accuracy is approximately 50-60%.
 *   1.1 — issue #44 resolution. Call B (AI capex-schedule extraction)
 *         replaced by deterministic extraction via pdfjs-dist's
 *         positional API. Call A (scalars + narratives) unchanged.
 *         Adapter threads `slot.buffer` through to the deterministic
 *         schedule extractor (the PDF bytes are needed for pdfjs's
 *         getTextContent; previously the buffer was consumed by
 *         parseDocument and discarded).
 */
export const PCA_ADAPTER_VERSION = '1.1';

/**
 * Sub-extractor dependency. The adapter takes this as an optional final
 * parameter (defaulting to DEFAULT_PCA_DEPS). Production code calls the
 * adapter without supplying deps; tests pass mocked deps to control
 * `extractPca` behavior without making AI calls.
 *
 * Signature widened in adapter v1.1 to accept the raw PDF buffer alongside
 * the parsed document — the deterministic schedule extractor needs
 * pdfjs-dist's positional API which operates on raw bytes.
 */
export interface PcaAdapterDeps {
  readonly extractPca: (
    doc: ParsedDocument,
    pdfBuffer: Buffer,
  ) => Promise<PCAExtraction | null>;
}

export const DEFAULT_PCA_DEPS: PcaAdapterDeps = {
  extractPca,
};

/**
 * External entry point — what the composer calls.
 *
 *   1. Hash the buffer (for the SourceDocumentRef + so the inner function
 *      gets a hash without re-touching bytes).
 *   2. parseDocument(buffer, filename, 'application/pdf'). mimeType is
 *      hardcoded: the slot is named pcaPdf by contract; threading mimeType
 *      through SlotInput would duplicate the format commitment the slot
 *      name already carries (same convention as ASR's adapter).
 *   3. Delegate to runPcaAdapterOnDocument(doc, bufferHash).
 *   4. Patch the returned outcome's durationMs to include parseDocument
 *      time (operationally more useful for the composer).
 *
 * parseDocument-throws is the ONE failure mode unique to this function.
 */
export async function runPcaAdapter(
  slot: SlotInput,
  deps: PcaAdapterDeps = DEFAULT_PCA_DEPS,
): Promise<ExtractorOutcome<PCAExtraction | null>> {
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
      adapterVersion: PCA_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'parseDocumentThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'parseDocument failed'}`,
      },
    };
  }

  const inner = await runPcaAdapterOnDocument(doc, bufferHash, slot.buffer, deps);
  // Outer durationMs includes parseDocument time, so the composer sees total
  // wallclock for this slot. Inner durationMs is overwritten.
  return { ...inner, durationMs: Date.now() - t0 };
}

/**
 * Internal core. Exported so tests can synthesize ParsedDocument inputs and
 * call directly without going through PDF byte parsing.
 *
 * `bufferHash` is passed in because the bytes are gone by the time this
 * function runs.
 *
 * `pdfBuffer` (adapter v1.1) is preserved alongside the parsed document so
 * the deterministic capex-schedule extractor can call pdfjs-dist's
 * positional API. parseDocument upstream produces the flat-text `doc`;
 * the raw bytes are still needed for per-text-item x/y coordinates.
 *
 * Failure isolation: `extractPca` itself runs Call A (AI) + the
 * deterministic schedule extractor in parallel and merges partials
 * internally. If both produce no usable data, `extractPca` returns null
 * (mapped to 'empty' here). If `extractPca` itself throws (unexpected —
 * the function is internally defensive), this catches and maps to
 * 'failed'.
 */
export async function runPcaAdapterOnDocument(
  doc: ParsedDocument,
  bufferHash: ContentHash,
  pdfBuffer: Buffer,
  deps: PcaAdapterDeps = DEFAULT_PCA_DEPS,
): Promise<ExtractorOutcome<PCAExtraction | null>> {
  const t0 = Date.now();

  let value: PCAExtraction | null;
  try {
    value = await deps.extractPca(doc, pdfBuffer);
  } catch (err) {
    const e = err as Error;
    // eslint-disable-next-line no-console -- TODO(observability): typed log event
    console.warn(
      `[pca.adapter] extractPca rejected: ${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'} TODO(observability)`,
    );
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: PCA_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'extractPcaThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'extractPca failed'}`,
      },
    };
  }

  if (value === null) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: PCA_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'parsed document; extractPca returned null (both AI calls produced no usable data)',
    };
  }

  // ok path: single SourceDocumentRef of kind 'pca'.
  const refs: SourceDocumentRef[] = [{ kind: 'pca', contentHash: bufferHash }];

  return {
    status: 'ok',
    value,
    sourceRefs: refs,
    adapterVersion: PCA_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}
