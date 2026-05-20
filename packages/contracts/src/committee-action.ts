// Committee action events (Phase 3 - committee workflow layer).
//
// Append-only chain-linked event stream for deal-level workflow actions. Distinct
// from the overlay-scoped audit log: those events are scoped to an overlay
// (analyst commentary on rendered fields); committee action events are scoped to
// a deal (rootId) and represent committee-level decisions.
//
// Discipline (locked at Phase 3):
//   - Every action is immutable. Append-only; no edit, no delete.
//   - Every action references rootId (DoctrineEvaluationId) and renderedAnalysisId
//     (the rendered artifact the action was taken against). snapshotId is optional
//     and present when the action references a frozen committee packet (e.g.
//     APPROVE_DEAL of snapshot X).
//   - Chain-linked single-parent topology: previousActionId === null only for the
//     first action on a deal; subsequent actions reference their predecessor.
//   - Identity is content-hashed over the full body including timestamp +
//     previousActionId. Temporal artifacts; same content at different times = different ids.
//   - No derived or computed state in storage. The deal's lifecycle state is
//     ALWAYS computed by replay from the action chain (see compute-deal-workflow-state).

import type {
  CommitteeActionId,
  CommitteeSnapshotId,
  DoctrineEvaluationId,
  OverlayId,
  RenderedAnalysisId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';

export const COMMITTEE_ACTION_KINDS = [
  'SUBMIT_TO_COMMITTEE',
  'REQUEST_MORE_INFO',
  'OVERRIDE_DECISION',
  'APPROVE_DEAL',
  'REJECT_DEAL',
  'POSTPONE_DEAL',
] as const;
export type CommitteeActionKind = (typeof COMMITTEE_ACTION_KINDS)[number];

/* ------------------------------ payloads ------------------------------ */

export interface SubmitToCommitteePayload {
  readonly kind: 'SUBMIT_TO_COMMITTEE';
  readonly committeeName: string;       // e.g. 'CRE-Q2-2026'
  readonly summary: string;             // brief narrative for the committee packet
}

export interface RequestMoreInfoPayload {
  readonly kind: 'REQUEST_MORE_INFO';
  readonly questions: readonly string[];
}

export interface OverrideDecisionPayload {
  readonly kind: 'OVERRIDE_DECISION';
  readonly overlayId: OverlayId;        // links to the analyst overlay being acted upon
  readonly summary: string;
}

export interface ApproveDealPayload {
  readonly kind: 'APPROVE_DEAL';
  readonly conditions: readonly string[];
}

export interface RejectDealPayload {
  readonly kind: 'REJECT_DEAL';
  readonly reasons: readonly string[];
}

export interface PostponeDealPayload {
  readonly kind: 'POSTPONE_DEAL';
  readonly reason: string;
  readonly until: ISODateTime | null;   // optional revisit date
}

export type CommitteeActionPayload =
  | SubmitToCommitteePayload
  | RequestMoreInfoPayload
  | OverrideDecisionPayload
  | ApproveDealPayload
  | RejectDealPayload
  | PostponeDealPayload;

/* ----------------------------- the event ----------------------------- */

export interface CommitteeActionEvent {
  readonly id: CommitteeActionId;
  readonly previousActionId: CommitteeActionId | null;   // null only for first action
  readonly rootId: DoctrineEvaluationId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly snapshotId: CommitteeSnapshotId | null;
  readonly kind: CommitteeActionKind;
  readonly payload: CommitteeActionPayload;
  readonly author: string;
  readonly occurredAt: ISODateTime;
}
