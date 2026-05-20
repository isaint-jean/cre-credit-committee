/**
 * Composer-internal vocabulary for buildExtractionResult.
 *
 * NOT exported through @cre/contracts: ExtractorOutcome envelopes are never persisted,
 * never cross a service boundary. They exist so the composer + per-slot adapters share
 * one shape; the projection step at the end of buildExtractionResult unpacks each
 * outcome's `value` into the corresponding ExtractionResult field(s) and concatenates
 * `sourceRefs` into ExtractionResult.sourceDocuments.
 *
 * Ticket D (per-extractor version metadata) will harvest each adapter's `adapterVersion`
 * into a new contract field on ExtractionResult. Until then, adapterVersion is local
 * diagnostic data and the composer projects only the rolled-up EXTRACTION_ENGINE_VERSION
 * into the result.
 */

import type { SourceDocumentRef } from '@cre/contracts';

/** Slot keys exposed by the composer. 1:1 with adapters under ./adapters/. */
export const EXTRACTION_SLOTS = ['sellerCfXlsx', 'rentRollXlsx', 'asrPdf'] as const;
export type ExtractionSlot = (typeof EXTRACTION_SLOTS)[number];

/**
 * Three statuses, not four:
 *
 *   ok     — extractor ran, returned a usable value. Internal nulls are preserved verbatim
 *            (null fidelity: a populated value with null sub-fields is still 'ok'). The
 *            composer projects `value` into ExtractionResult and `sourceRefs` into
 *            sourceDocuments.
 *
 *   empty  — extractor ran, found nothing extractable (e.g. CF workbook has no
 *            period-header). This is a LEGIT NO-DATA outcome, not a failure: the
 *            slot did its job, the document simply didn't carry the thing.
 *            Empty slots do NOT block ok:true on the composer's overall return.
 *            sourceRefs is empty by design — there's no real extraction to attribute.
 *
 *   failed — extractor threw. The composer absorbs the throw (allSettled isolation)
 *            and routes the slot into the `missing` list on its ok:false branch.
 *            sourceRefs is empty by design — without a successful parse we cannot
 *            attribute the bytes to any SourceDocumentKind.
 */
export type ExtractorOutcome<T> =
  | {
      readonly status: 'ok';
      readonly value: T;
      readonly sourceRefs: readonly SourceDocumentRef[];
      readonly adapterVersion: string;
      readonly durationMs: number;
    }
  | {
      readonly status: 'empty';
      readonly sourceRefs: readonly SourceDocumentRef[];
      readonly adapterVersion: string;
      readonly durationMs: number;
      readonly reason: string;
    }
  | {
      readonly status: 'failed';
      readonly sourceRefs: readonly SourceDocumentRef[];
      readonly adapterVersion: string;
      readonly durationMs: number;
      readonly error: { readonly name: string; readonly message: string };
    };

/** One uploaded file. `filename` is preserved for diagnostics + Ticket-C storage adapters. */
export interface SlotInput {
  readonly buffer: Buffer;
  readonly filename: string;
}

/**
 * Typed slots passed into buildExtractionResult.
 *
 * Every slot is optional at the type level. The composer's discriminated-union
 * return surfaces absent slots in `missing` on the ok:false branch. Callers that
 * require all three should validate up front; the composer does not.
 */
export interface InputSlots {
  readonly sellerCfXlsx?: SlotInput;
  readonly rentRollXlsx?: SlotInput;
  readonly asrPdf?: SlotInput;
}
