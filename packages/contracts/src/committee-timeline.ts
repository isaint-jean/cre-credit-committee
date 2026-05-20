// Committee timeline view model (Phase 3 - committee workflow layer).
//
// Read-only chronological merge of three event sources:
//   - overlay audit events (overlay-created, comment-added, etc.)
//   - committee action events (SUBMIT_TO_COMMITTEE, APPROVE_DEAL, etc.)
//   - committee snapshot creations (deal-level "we exported a packet at this moment")
//
// The timeline is a PURE PROJECTION over those three event sources. The builder
// MUST NOT modify any underlying store, MUST NOT synthesize entries, and MUST be
// deterministic (same store state -> same timeline).
//
// Each entry carries a small canonicalized summary so the UI can render it
// without re-fetching the underlying record. The entry's `refId` is the id of
// the source record so a UI consumer can drill in if needed.

import type { DoctrineEvaluationId } from './identity.js';
import type { ISODateTime } from './versioning.js';

export const TIMELINE_ENTRY_KINDS = [
  'overlay-event',
  'committee-action',
  'snapshot-created',
] as const;
export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number];

export interface TimelineEntry {
  readonly kind: TimelineEntryKind;
  // Sub-kind: the specific event kind from the source stream (e.g. 'overlay-created',
  // 'comment-added', 'SUBMIT_TO_COMMITTEE', 'snapshot-created'). Free-form string
  // for forward-compatibility with new event kinds.
  readonly subKind: string;
  readonly occurredAt: ISODateTime;
  readonly author: string;
  readonly summary: string;
  // Reference to the source record's id. UI consumers can use this to drill into
  // the source stream (audit-events, committee-actions, committee-snapshots).
  readonly refId: string;
}

export interface CommitteeTimeline {
  readonly rootId: DoctrineEvaluationId;
  readonly entries: readonly TimelineEntry[];   // chronological; ties broken deterministically by refId
}
