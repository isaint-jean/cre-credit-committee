// Editable overlay contract (Phase 2 - post-7.2).
//
// The "edit surface" wrapper around RenderedAnalysis. Diff-only, NOT authoritative state.
// Carries human-authored annotations (comments, overrides, tags) as additive metadata
// over the producer-owned, deterministic, content-hashed rendered artifact.
//
// CRITICAL DISCIPLINE (locked at Phase 2 v1):
//   - The overlay does NOT replace any field in RenderedAnalysis.
//   - The overlay does NOT participate in underwriting computation.
//   - The overlay does NOT enter the cache key for RenderedAnalysis (cache partition
//     remains keyed by `(rootId, render_version)` only).
//   - Each overlay is pinned to a specific (renderedAnalysisId, renderVersion) pair.
//     If the rendered surface evolves (new render version), a new overlay is created;
//     the old overlay remains as a historical artifact.
//   - Patches are append-only with respect to the audit log. The overlay's `comments[]`
//     / `overrides[]` / `tags[]` arrays reflect the CURRENT state derived from the
//     audit log; addition and removal both produce audit events.
//
// This module is types-only. There is no execution wiring, no storage, no endpoints
// in Phase 2 v1. Wiring is a subsequent step once the contract has been validated.

import type {
  OverlayId,
  OverlayPatchId,
  RenderedAnalysisId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { RenderVersion } from './rendered-analysis.js';

// Patch kind discriminator. Three patch types in v1:
//   - 'comment'  : free-text human annotation attached to a path in the rendered tree
//   - 'override' : analyst-proposed alternative value (does NOT replace render output;
//                  stored as metadata alongside the producer's value for committee review)
//   - 'tag'      : free-text label (e.g. 'needs-followup', 'reviewed-by-jdoe')
export const OVERLAY_PATCH_KINDS = ['comment', 'override', 'tag'] as const;
export type OverlayPatchKind = (typeof OVERLAY_PATCH_KINDS)[number];

// Common base fields for all patches.
interface OverlayPatchBase {
  readonly id: OverlayPatchId;
  readonly path: string;             // dotted path into RenderedAnalysis (e.g. 'metrics.dscr', 'findings[3]')
  readonly author: string;           // analyst identifier
  readonly createdAt: ISODateTime;   // wall-clock stamp; observability only, NOT in identity hash
}

export interface OverlayCommentPatch extends OverlayPatchBase {
  readonly kind: 'comment';
  readonly text: string;
}

export interface OverlayOverridePatch extends OverlayPatchBase {
  readonly kind: 'override';
  // The analyst's proposed alternative value. Stored as a string (canonical JSON of
  // the proposed value). The original render output remains unchanged - the override
  // is metadata, not a replacement.
  readonly proposedValue: string;
  // The producer-emitted value at the time of override authoring (for committee
  // context: "what did the analyst override?"). Captured at patch creation time.
  readonly originalValue: string;
  readonly rationale: string;
}

export interface OverlayTagPatch extends OverlayPatchBase {
  readonly kind: 'tag';
  readonly tag: string;
}

// Discriminated union of all patch kinds.
export type OverlayPatch =
  | OverlayCommentPatch
  | OverlayOverridePatch
  | OverlayTagPatch;

// The editable overlay itself. Contains the current state derived from the audit log
// (which is the source of truth for ordering and history). The overlay's id is a uuid
// v4 (workspace grouping), NOT a content hash - the overlay evolves as patches are
// added or removed, while the audit log captures the full immutable history.
export interface EditableOverlay {
  readonly id: OverlayId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly renderVersion: RenderVersion;
  readonly createdAt: ISODateTime;
  readonly comments: readonly OverlayCommentPatch[];
  readonly overrides: readonly OverlayOverridePatch[];
  readonly tags: readonly OverlayTagPatch[];
}
