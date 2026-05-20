/**
 * BuildReport — observability artifact produced by buildExtractionResult.
 *
 * Stripped per-slot reports: status, timing, adapter version, and (for empty
 * or failed) the diagnostic string. Deliberately excludes `value` and
 * `sourceRefs` from each slot's outcome — those already live in
 * extractionResult fields and extractionResult.sourceDocuments, respectively.
 * Carrying them again would bloat logs without adding signal.
 *
 * The `'absent'` status is unique to this report (not present in
 * ExtractorOutcome<T>): adapters never see absent slots — the composer
 * skips the adapter call entirely when a SlotInput is missing.
 *
 * The two helpers below — slotIsAcceptable and incompleteSlots — encode
 * the "loose-A" semantics from the orchestration scoping: a slot is
 * acceptable when its status is 'ok' or 'empty'; failed or absent slots
 * are not acceptable. Callers (route layer, observability) use these to
 * decide whether a build is "complete enough" without re-deriving the
 * categorization rule.
 */

import type { ExtractionEngineVersion, ISODateTime } from '@cre/contracts';
import type { ExtractionSlot } from './extractor-outcome.js';

export type SlotReport =
  | {
      readonly status: 'ok';
      readonly durationMs: number;
      readonly adapterVersion: string;
    }
  | {
      readonly status: 'empty';
      readonly durationMs: number;
      readonly adapterVersion: string;
      readonly reason: string;
    }
  | {
      readonly status: 'failed';
      readonly durationMs: number;
      readonly adapterVersion: string;
      readonly error: { readonly name: string; readonly message: string };
    }
  | {
      readonly status: 'absent';
    };

export interface BuildReport {
  readonly startedAt: ISODateTime;
  readonly finishedAt: ISODateTime;
  readonly engineVersion: ExtractionEngineVersion;
  readonly slots: Readonly<Record<ExtractionSlot, SlotReport>>;
}

/** Loose-A semantics: a slot is acceptable if it returned ok or empty. */
export function slotIsAcceptable(report: SlotReport): boolean {
  return report.status === 'ok' || report.status === 'empty';
}

/**
 * Slots that are NOT acceptable (failed or absent). Callers use this list
 * the way the previously-proposed `missing` field would have been used:
 * to surface incomplete builds to the route or to UI.
 */
export function incompleteSlots(report: BuildReport): readonly ExtractionSlot[] {
  return (Object.entries(report.slots) as ReadonlyArray<[ExtractionSlot, SlotReport]>)
    .filter(([, s]) => !slotIsAcceptable(s))
    .map(([k]) => k);
}
