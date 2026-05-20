// Audit log model (Phase 2 - post-7.2). Append-only event stream.
//
// Each AuditEvent records a single mutation to an EditableOverlay. The events form
// an immutable chain: every event references its predecessor by id, anchoring the
// overlay's history to a deterministic ordering. Ids are content-hashed over the
// event's full body (including timestamp - audit events are temporally bound by
// design, distinct from analysis-spine records which exclude timestamps from identity
// per lineage spec L5).
//
// CRITICAL DISCIPLINE (locked at Phase 2 v1):
//   - Events are NEVER modified or deleted.
//   - Each event id is a deterministic hash over (kind, overlayId, previousEventId,
//     payload, author, occurredAt).
//   - The chain is single-parent. Two events with identical content but different
//     `previousEventId` values produce different ids.
//   - `previousEventId` is `null` for the first event in an overlay's chain (the
//     'overlay-created' event) - same root convention as RevisionLineageEnvelope's
//     `parentRevisionId`.
//   - Editing an existing patch is modeled as remove + add. The audit log NEVER has
//     an "edited" event; instead the original removal and the new addition are both
//     recorded.

import type {
  AuditEventId,
  OverlayId,
  OverlayPatchId,
  RenderedAnalysisId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { RenderVersion } from './rendered-analysis.js';

// Closed enum of audit event kinds. Each kind corresponds to a specific overlay
// mutation; no derived or composite kinds.
export const AUDIT_EVENT_KINDS = [
  'overlay-created',
  'comment-added',
  'comment-removed',
  'override-added',
  'override-removed',
  'tag-added',
  'tag-removed',
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

// Per-kind payload. Discriminated union; each variant carries only what's needed to
// reproduce the corresponding overlay state change.
// Phase 2 v2 (additive to v1): the 'overlay-created' event carries the rooting
// metadata so the audit log is self-describing for replay. Replay can reconstruct
// an overlay's anchor (renderedAnalysisId, renderVersion, createdAt) from this event
// alone, without external context.
export interface AuditOverlayCreatedPayload {
  readonly kind: 'overlay-created';
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly renderVersion: RenderVersion;
}

export interface AuditPatchAddedPayload {
  readonly kind: 'comment-added' | 'override-added' | 'tag-added';
  readonly patchId: OverlayPatchId;
  // Brief human-readable summary of what was added. NOT the full patch body - the
  // patch lives in the overlay record; this is just for log readability.
  readonly summary: string;
}

export interface AuditPatchRemovedPayload {
  readonly kind: 'comment-removed' | 'override-removed' | 'tag-removed';
  readonly patchId: OverlayPatchId;
  readonly summary: string;
}

export type AuditEventPayload =
  | AuditOverlayCreatedPayload
  | AuditPatchAddedPayload
  | AuditPatchRemovedPayload;

// One audit event. Chain-linked by `previousEventId`. The id is the SHA-256 of the
// JCS canonical serialization of every field below EXCEPT `id` itself. Producers
// (i.e. the overlay-mutation handlers, when they exist) compute the hash and brand
// as `AuditEventId`.
//
// Including `occurredAt` in the hash is intentional and distinct from analysis-spine
// records: audit events are temporal artifacts. Two events with identical content
// emitted at different times need distinct ids.
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly previousEventId: AuditEventId | null;   // null for the first event (overlay-created)
  readonly overlayId: OverlayId;
  readonly kind: AuditEventKind;
  readonly payload: AuditEventPayload;
  readonly author: string;
  readonly occurredAt: ISODateTime;                // INCLUDED in id hash (temporal identity)
}
