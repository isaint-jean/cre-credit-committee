// Committee timeline view-model builder (Phase 3).
//
// Pure derivation. Merges three event sources into a chronological timeline:
//   - overlay audit events (overlay-created, comment-added, etc.)
//   - committee action events (SUBMIT_TO_COMMITTEE, APPROVE_DEAL, etc.)
//   - committee snapshot creations
//
// Output is read-only and deterministic. Builder NEVER modifies any underlying
// store or event.
//
// ============================================================================
// Timeline-builder discipline (LOCKED).
// ============================================================================
//
//   TL1 - Pure read. No mutation of any source.
//   TL2 - Deterministic. Stable ordering: chronological by occurredAt; ties broken
//         by refId lexicographic order.
//   TL3 - No synthesis. Every entry corresponds to one source record. No
//         aggregation, no derived "summary" entries beyond per-record summaries.
//   TL4 - No render reach-back. Imports only contract types and stores.

import type {
  AuditEvent,
  CommitteeActionEvent,
  CommitteeSnapshot,
  CommitteeTimeline,
  DoctrineEvaluationId,
  TimelineEntry,
} from '@cre/contracts';
import type { AuditEventsStore } from '../storage/audit-events-store.js';
import type { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import type { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';

export interface BuildCommitteeTimelineInput {
  readonly rootId: DoctrineEvaluationId;
  readonly auditEventsStore: AuditEventsStore;
  readonly committeeActionsStore: CommitteeActionsStore;
  readonly committeeSnapshotsStore: CommitteeSnapshotsStore;
}

function summarizeAudit(e: AuditEvent): string {
  switch (e.payload.kind) {
    case 'overlay-created':
      return 'Overlay created';
    case 'comment-added':
      return 'Comment added: ' + e.payload.summary;
    case 'comment-removed':
      return 'Comment removed';
    case 'override-added':
      return 'Override added: ' + e.payload.summary;
    case 'override-removed':
      return 'Override removed';
    case 'tag-added':
      return 'Tag added: ' + e.payload.summary;
    case 'tag-removed':
      return 'Tag removed';
    default:
      // Forward-compatibility: unknown future kinds get a neutral label so the
      // timeline never throws or silently drops entries.
      return 'Audit event';
  }
}

function summarizeAction(a: CommitteeActionEvent): string {
  switch (a.payload.kind) {
    case 'SUBMIT_TO_COMMITTEE':
      return 'Submitted to committee: ' + a.payload.committeeName;
    case 'REQUEST_MORE_INFO':
      return 'More information requested (' + a.payload.questions.length + ' question' +
        (a.payload.questions.length === 1 ? '' : 's') + ')';
    case 'OVERRIDE_DECISION':
      return 'Override decision: ' + a.payload.summary;
    case 'APPROVE_DEAL':
      return 'Deal approved' +
        (a.payload.conditions.length > 0
          ? ' (' + a.payload.conditions.length + ' condition' +
            (a.payload.conditions.length === 1 ? '' : 's') + ')'
          : '');
    case 'REJECT_DEAL':
      return 'Deal rejected' +
        (a.payload.reasons.length > 0 ? ': ' + a.payload.reasons.length + ' reason' +
          (a.payload.reasons.length === 1 ? '' : 's') : '');
    case 'POSTPONE_DEAL':
      return 'Deal postponed: ' + a.payload.reason;
    default:
      return 'Committee action';
  }
}

function summarizeSnapshot(s: CommitteeSnapshot): string {
  return 'Snapshot exported: ' + s.exportContext.purpose;
}

export function buildCommitteeTimeline(
  input: BuildCommitteeTimelineInput,
): CommitteeTimeline {
  const { rootId, auditEventsStore, committeeActionsStore, committeeSnapshotsStore } = input;

  const auditEvents = auditEventsStore.getByRoot(rootId);
  const committeeActions = committeeActionsStore.getByRoot(rootId);

  // Snapshots are indexed by renderedAnalysisId, not rootId. Pull from each
  // committee action's renderedAnalysisId AND from any audit event's overlay
  // (via the overlay-created event payload). Deduplicate by snapshot id.
  const renderedIds = new Set<string>();
  for (const a of committeeActions) renderedIds.add(a.renderedAnalysisId);
  for (const e of auditEvents) {
    if (e.payload.kind === 'overlay-created') {
      renderedIds.add(e.payload.renderedAnalysisId);
    }
  }

  const snapshots: CommitteeSnapshot[] = [];
  const seenSnapshotIds = new Set<string>();
  for (const renderedId of renderedIds) {
    const snaps = committeeSnapshotsStore.getByRenderedAnalysis(renderedId as never);
    for (const s of snaps) {
      if (!seenSnapshotIds.has(s.id)) {
        seenSnapshotIds.add(s.id);
        snapshots.push(s);
      }
    }
  }

  const entries: TimelineEntry[] = [];

  for (const e of auditEvents) {
    entries.push({
      kind: 'overlay-event',
      subKind: e.kind,
      occurredAt: e.occurredAt,
      author: e.author,
      summary: summarizeAudit(e),
      refId: e.id,
    });
  }
  for (const a of committeeActions) {
    entries.push({
      kind: 'committee-action',
      subKind: a.kind,
      occurredAt: a.occurredAt,
      author: a.author,
      summary: summarizeAction(a),
      refId: a.id,
    });
  }
  for (const s of snapshots) {
    entries.push({
      kind: 'snapshot-created',
      subKind: 'snapshot-created',
      occurredAt: s.exportContext.exportedAt,
      author: s.exportContext.exportedBy,
      summary: summarizeSnapshot(s),
      refId: s.id,
    });
  }

  // Stable chronological order (TL2). Ties broken by refId lexicographic.
  const sorted = entries.slice().sort((a, b) => {
    if (a.occurredAt < b.occurredAt) return -1;
    if (a.occurredAt > b.occurredAt) return 1;
    if (a.refId < b.refId) return -1;
    if (a.refId > b.refId) return 1;
    return 0;
  });

  return {
    rootId,
    entries: sorted,
  };
}
