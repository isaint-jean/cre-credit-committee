// Committee snapshot contract (Phase 2 - post-7.2).
//
// A frozen, content-hashed bundle suitable for committee review or archival. Wraps
// a RenderedAnalysis (the producer-owned, deterministic truth artifact) plus an
// optional EditableOverlay (analyst commentary / overrides / tags) plus an export
// context (who exported, when, why).
//
// CRITICAL DISCIPLINE (locked at Phase 2 v1):
//   - The snapshot is a READ-ONLY bundle. The builder never mutates inputs and never
//     recomputes any field. Both `renderedAnalysis` and `overlay` are embedded as-is.
//   - The snapshot id is hashed over the full body. Same `(renderedAnalysisId,
//     overlayId, exportContext)` -> same `CommitteeSnapshotId`.
//   - The export context's timestamp IS in the identity hash. Snapshots taken at
//     different times are different snapshots, even if their underlying rendered +
//     overlay are identical. This is intentional: the committee needs to know which
//     snapshot was reviewed at which meeting.
//   - The snapshot does NOT participate in the cache for RenderedAnalysis. It is a
//     separate artifact category, suitable for its own future storage scheme.

import type { CommitteeSnapshotId, OverlayId, RenderedAnalysisId } from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { RenderedAnalysis } from './rendered-analysis.js';
import type { EditableOverlay } from './editable-overlay.js';

export interface ExportContext {
  readonly exportedBy: string;
  readonly exportedAt: ISODateTime;
  // Human-readable purpose: 'committee-q1-2026', 'archival', 'analyst-handoff', etc.
  // Free-form on the contract surface; consumers may impose stricter conventions.
  readonly purpose: string;
}

export interface CommitteeSnapshot {
  readonly id: CommitteeSnapshotId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly renderedAnalysis: RenderedAnalysis;
  // Overlay is optional. A snapshot may be taken of pure rendered output without any
  // analyst annotations (e.g., a producer-only archival snapshot before any analyst
  // touches the deal).
  readonly overlayId: OverlayId | null;
  readonly overlay: EditableOverlay | null;
  readonly exportContext: ExportContext;
}
