// Committee snapshot builder (Phase 2 - post-7.2).
//
// Pure read-only transformation. Bundles a RenderedAnalysis (the deterministic truth
// artifact) with an optional EditableOverlay (analyst commentary) plus an export
// context, producing a content-hashed CommitteeSnapshot record.
//
// ============================================================================
// Snapshot-builder discipline (LOCKED). Modeled on RD1-RD5 / PJ1-PJ5; mirrors the
// read-only structural-passthrough principle for the export layer.
// ============================================================================
//
//   SX1 - Read-only. Inputs are NOT mutated. The output embeds inputs by reference
//         (TypeScript readonly types prevent shape drift); deep-cloning is unnecessary
//         because every input is already deeply readonly per its contract.
//
//   SX2 - Bijective. Same `(renderedAnalysis, overlay, exportContext)` -> same
//         CommitteeSnapshotId. The id is hashed over the full body.
//
//   SX3 - No recomputation. The snapshot does NOT re-derive any field of
//         RenderedAnalysis or EditableOverlay. It does NOT compute summaries, derive
//         severities, infer priorities, or apply any underwriting logic.
//
//   SX4 - No producer reach-back. This module imports types from @cre/contracts
//         and the content-hash factory only. It does NOT import producers, stores,
//         or render-side logic.
//
//   SX5 - Structural identity passthrough only. Permitted operations: pick, rename,
//         id-stamp. Forbidden: arithmetic, asset-class branching, conditional
//         severity assignment, free-text generation.
//
// ============================================================================

import type {
  CommitteeSnapshot,
  EditableOverlay,
  ExportContext,
  RenderedAnalysis,
} from '@cre/contracts';
import { computeCommitteeSnapshotId } from '../util/content-hash.js';

export interface BuildCommitteeSnapshotArgs {
  readonly renderedAnalysis: RenderedAnalysis;
  readonly overlay: EditableOverlay | null;
  readonly exportContext: ExportContext;
}

export function buildCommitteeSnapshot(args: BuildCommitteeSnapshotArgs): CommitteeSnapshot {
  const { renderedAnalysis, overlay, exportContext } = args;

  const body = {
    renderedAnalysisId: renderedAnalysis.id,
    renderedAnalysis,
    overlayId: overlay === null ? null : overlay.id,
    overlay,
    exportContext,
  };

  return {
    id: computeCommitteeSnapshotId(body),
    ...body,
  };
}
