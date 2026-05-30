/**
 * Read-through projection — overlay graph substrate onto a legacy Analysis.
 *
 * When a legacy Analysis carries `graphRevisionId` (set by the promote-from-graph
 * operation in Phase 2), this projection fills the legacy substrate fields from
 * the linked new-spine records (NarrativeEvaluation, DoctrineEvaluation,
 * HandbookEvaluation) so the legacy view renders real handbook output instead
 * of legacy LLM output.
 *
 * Phase 3 scope: executiveSummary only. Other tabs (Score, Mitigations) project
 * in subsequent phases through this same function.
 *
 * Fallback: when `graphRevisionId` is null/undefined, OR when any of the linked
 * records cannot be resolved, the input Analysis is returned unchanged —
 * preserving legacy behavior for unlinked analyses and degrading gracefully
 * for partial graph state.
 */

import { NARRATIVE_ENGINE_VERSION, type RevisionId } from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

export function projectLegacyAnalysisFromGraph(
  analysis: Analysis,
  store: RecordGraphStore,
): Analysis {
  const link = analysis.graphRevisionId;
  if (link === null || link === undefined || link.length === 0) {
    return analysis;
  }

  const envelope = store.getRevisionEnvelope(link as RevisionId);
  if (envelope === null) {
    return analysis;
  }

  const narrative = store.getLatestNarrativeForAdjustedInputs(
    envelope.adjustedInputsId,
    NARRATIVE_ENGINE_VERSION,
  );
  if (narrative === null) {
    return analysis;
  }

  return {
    ...analysis,
    executiveSummary: narrative.executiveSummary,
  };
}
