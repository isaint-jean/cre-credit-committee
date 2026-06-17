/**
 * Appraisal adapter — sole composer call site of `extractCbreAppraisal`.
 *
 * Simpler than pca.adapter and asr.adapter:
 *   - No `parseDocument` step (extractCbreAppraisal uses unpdf internally).
 *   - No LLM. Fully deterministic regex-over-PDF-text.
 *   - No internal `runOnDocument` split (no `ParsedDocument` intermediate;
 *     tests synthesize either real or mocked extractor responses via deps).
 *
 * Status mapping:
 *   - extractCbreAppraisal threw                            → 'failed'
 *   - extractor recognized NOTHING (sentinel below)         → 'empty'
 *   - extractor returned a record with any anchor populated → 'ok'
 *     with a single SourceDocumentRef of kind 'appraisal'.
 *
 * EMPTY SENTINEL — the condition is "the extractor recognized NOTHING":
 *
 *   asIsValue === null && netRentableArea === null && yearBuilt === null
 *
 * A deal with a real `asIsValue` but null `asStabilizedValue` is 'ok' (it's
 * a stabilized deal — no second-stage value to project). A deal with NRA or
 * yearBuilt populated even if asIsValue is null still indicates the page
 * regexes are finding identity anchors; we don't fire 'empty' on that case.
 * The 3-anchor compound (value + size + vintage) must ALL be null for the
 * extractor to be declared blind.
 *
 * Adapter version is local. Same convention as PCA_ADAPTER_VERSION /
 * ASR_ADAPTER_VERSION / CF_ADAPTER_VERSION (composer's version harvester
 * stamps it into ExtractionResult.extractorVersions['appraisal']).
 */
import type {
  AppraisalExtraction,
  ContentHash,
  SourceDocumentRef,
} from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { extractCbreAppraisal } from '../../extract-cbre-appraisal.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

export const APPRAISAL_ADAPTER_VERSION = '1.0';

export interface AppraisalAdapterDeps {
  readonly extractCbreAppraisal: (buffer: Buffer) => Promise<AppraisalExtraction>;
}

export const DEFAULT_APPRAISAL_DEPS: AppraisalAdapterDeps = {
  extractCbreAppraisal,
};

/**
 * External entry point — what the composer calls.
 *
 *   1. Hash the buffer for the SourceDocumentRef.
 *   2. Run extractCbreAppraisal. The extractor never returns null at the
 *      function level (it always produces an AppraisalExtraction shell);
 *      failure modes are (a) it throws (malformed PDF → 'failed') or
 *      (b) it returns a record where every anchor field is null
 *      (non-CBRE format → 'empty').
 *   3. The 'empty' sentinel is a 3-field compound: asIsValue + NRA +
 *      yearBuilt all null. See header comment for rationale.
 */
export async function runAppraisalAdapter(
  slot: SlotInput,
  deps: AppraisalAdapterDeps = DEFAULT_APPRAISAL_DEPS,
): Promise<ExtractorOutcome<AppraisalExtraction | null>> {
  const t0 = Date.now();
  const bufferHash: ContentHash = computeBufferContentHash(slot.buffer);

  let value: AppraisalExtraction;
  try {
    value = await deps.extractCbreAppraisal(slot.buffer);
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: APPRAISAL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'extractCbreAppraisalThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'extractCbreAppraisal failed'}`,
      },
    };
  }

  // EMPTY sentinel — 3-anchor compound. See header comment for the rationale.
  if (value.asIsValue === null && value.netRentableArea === null && value.yearBuilt === null) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: APPRAISAL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'extractor recognized no anchor fields (asIsValue + NRA + yearBuilt all null); buffer likely a non-CBRE format',
    };
  }

  const refs: SourceDocumentRef[] = [{ kind: 'appraisal', contentHash: bufferHash }];
  return {
    status: 'ok',
    value,
    sourceRefs: refs,
    adapterVersion: APPRAISAL_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}
