/**
 * buildExtractionResult — composer that turns typed input slots into an ExtractionResult.
 *
 * Sits alongside ingestExtractionResult (not replacing it). The POST /api/build-and-ingest
 * route calls this, then hands the resulting ExtractionResult to ingestExtractionResult.
 * The composer itself is ingest-blind: it does not import or call any ingestion code,
 * and a module-graph guardrail (mirroring test-extraction-isolation.ts) will enforce that.
 *
 * Composition shape:
 *
 *   1. Fan out: each provided slot runs its adapter under Promise.allSettled (failure
 *      isolation: one extractor's throw cannot taint the others' outputs).
 *   2. Project: each adapter's `value` projects into the corresponding ExtractionResult
 *      field(s). The CF adapter's single outcome carries two fields (t12 +
 *      sellerUwOperatingStatement); the projection step splits them. sourceRefs from
 *      every slot concatenate into ExtractionResult.sourceDocuments.
 *   3. Resolve rent-roll precedence: pickRentRoll() runs over the rent-roll outcomes
 *      (xlsx vs AI-from-PDF). XLSX wins if its outcome is 'ok' with non-empty units;
 *      AI fallback fills in only when XLSX is missing/empty. This is the ONLY policy
 *      decision the composer makes — extracted into its own pure helper, unit-tested
 *      in isolation, so the composer body stays mechanical.
 *   4. Decide: every provided slot that returned 'ok' OR 'empty' is a clean slot. A
 *      provided slot that returned 'failed', OR a slot that was absent, lands in
 *      `missing`. If `missing` is empty AND every provided slot's outcome was 'ok' or
 *      'empty', the composer hashes the body and returns ok:true with a full
 *      ExtractionResult. Otherwise it returns ok:false with the same body shape sans id
 *      (H4 invariant: incomplete records are not content-addressed) plus the missing list.
 *
 * Hard semantics (pinned per the loose-A decision):
 *
 *   `missing` lists slots that did NOT yield a record — that is, slots which were
 *   absent (no SlotInput provided) OR whose extractor failed (threw).
 *   `missing` does NOT include 'empty' slots: an empty slot did its job — the
 *   document simply didn't carry the thing — and contributes null to ExtractionResult,
 *   which is contract-valid. Empty slots are ok:true-eligible. Do not reinterpret.
 */

import type { ExtractionResult, ISODateTime } from '@cre/contracts';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';
import type {
  ExtractorOutcome,
  ExtractionSlot,
  InputSlots,
} from './extractor-outcome.js';

export interface BuildExtractionResultArgs {
  readonly slots: InputSlots;
  readonly analysisAsOfDate: ISODateTime;
  readonly dealRef: string;
  readonly propertyHint?: string | null;
}

/**
 * Same body shape as ExtractionResult, MINUS `id`. A record with missing slots is
 * not content-addressed (H4 invariant: only complete records get a hash).
 * `extractionEngineVersion` stays stamped so the partial is still debuggable.
 */
export type PartialExtractionResult = Omit<ExtractionResult, 'id'>;

export interface BuildReport {
  readonly startedAt: ISODateTime;
  readonly finishedAt: ISODateTime;
  readonly engineVersion: typeof EXTRACTION_ENGINE_VERSION;
  /** Per-slot outcome. 'absent' covers the case where no SlotInput was provided. */
  readonly slots: Readonly<Record<
    ExtractionSlot,
    ExtractorOutcome<unknown> | { readonly status: 'absent' }
  >>;
}

export type BuildExtractionResultOutput =
  | { readonly ok: true;  readonly extractionResult: ExtractionResult;     readonly report: BuildReport }
  | { readonly ok: false; readonly partial: PartialExtractionResult;       readonly report: BuildReport; readonly missing: readonly ExtractionSlot[] };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function buildExtractionResult(
  _args: BuildExtractionResultArgs,
): Promise<BuildExtractionResultOutput> {
  throw new Error('not implemented');
}
