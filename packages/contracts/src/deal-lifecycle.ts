// Deal-state lifecycle (Phase 3 - committee workflow layer).
//
// A strict enum-like state machine driven by append-only committee action events.
// State is NEVER stored as a field on any record - it is always DERIVED by the
// projection function `computeDealWorkflowState` from the action chain + the
// audit/overlay event stream. There is no UPDATE path; lifecycle progression
// happens by appending new immutable events.

import type {
  CommitteeActionId,
  CommitteeSnapshotId,
  DoctrineEvaluationId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';

export const DEAL_STATES = [
  'DRAFT',
  'IN_REVIEW',
  'IN_COMMITTEE',
  'APPROVED',
  'REJECTED',
  'POSTPONED',
] as const;
export type DealState = (typeof DEAL_STATES)[number];

// Output of the workflow projection function. Every field is DERIVED from the
// underlying immutable events; nothing stored.
export interface DealWorkflowState {
  readonly rootId: DoctrineEvaluationId;
  readonly state: DealState;
  // Unique authors who have acted on this deal via committee actions, sorted
  // alphabetically for determinism. Drawn from CommitteeActionEvent.author.
  readonly activeParticipants: readonly string[];
  readonly lastActionAt: ISODateTime | null;
  readonly lastActionId: CommitteeActionId | null;
  readonly lastSnapshotId: CommitteeSnapshotId | null;
}
