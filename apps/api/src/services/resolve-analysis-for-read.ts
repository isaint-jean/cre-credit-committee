/**
 * resolveAnalysisForRead — the single shared read resolver for id-bearing
 * analysis READ routes (Unified-Read Contract, download-memo fix).
 *
 * WHY THIS EXISTS
 * ---------------
 * `GET /api/analyses/:id` classifies `:id` via `dispatchByIdFormat` and routes
 * a 64-hex GRAPH id through the graph spine (`handleGraphRead` →
 * `materializeRenderedAnalysisWithMeta`), while a legacy uuid goes through the
 * sqlite-store revision-lineage lookup. Sibling READ routes that called
 * `store.getAnalysis(req.params.id)` DIRECTLY skipped that classification, so a
 * graph id (e.g. Sunroad's lineage root `3454c89f…`) missed the legacy
 * `analyses` table and 404'd. The memo route was the reported symptom; the trap
 * was latent on every such route.
 *
 * This resolver centralizes the classification so those routes resolve the SAME
 * analysis object `GET /:id` would, for EITHER id format:
 *
 *   - legacy (uuid v4)  → `store.getLatestRevisionInLineage(id)` (the exact
 *                          legacy branch of `GET /:id`: latest revision in the
 *                          lineage).
 *   - graph (64-hex)    → resolve the LINEAGE ROOT → the LATEST envelope
 *                          (`getLatestRevisionByLineageRoot`), then recover the
 *                          bridged legacy `analyses` row via its HEAD
 *                          `graph_revision_id` (`getAnalysisByGraphRevisionId`).
 *                          That row carries the deal name + read-time overlays
 *                          (appraisal / PCA / S&U …) the memo renderer reads,
 *                          and its `graphRevisionId` already points at the HEAD
 *                          revision so the whole graph chain resolves.
 *                          Pure-graph deals (no legacy row) get a MINIMAL
 *                          synthesized Analysis whose `graphRevisionId` is the
 *                          HEAD revision + `name` from the root's extraction —
 *                          enough for the no-LLM memo reconstruction.
 *   - malformed         → throws `MalformedAnalysisIdError` (caller maps to 400,
 *                          same as `GET /:id`).
 *
 * Resolving to the LATEST revision (not the root's) is what KILLS THE
 * RECURRENCE: when a new child revision is minted for a lineage (an id shift on
 * the graph spine), the resolver still walks root → latest, so the memo keeps
 * resolving without a per-id-format patch.
 *
 * Reads only. No writes. Deterministic.
 */
import type { Analysis } from '@cre/shared';
import type { RevisionId } from '@cre/contracts';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  dispatchByIdFormat,
  type IdFormat,
} from '../util/dispatch-by-id-format.js';

/**
 * Resolve an analysis by `:id` for READ routes, honouring the Unified-Read
 * Contract (graph + legacy, lineage-root → latest revision).
 *
 * @throws MalformedAnalysisIdError when `id` is neither a uuid v4 nor a 64-hex
 *         content hash — the caller surfaces the existing 400.
 * @returns the resolved Analysis, or `null` when nothing exists for `id`
 *          (caller surfaces the existing 404).
 */
export function resolveAnalysisForRead(
  id: string,
  recordGraphStore: RecordGraphStore,
  store: SqliteStore,
): Analysis | null {
  const format: IdFormat = dispatchByIdFormat(id); // throws MalformedAnalysisIdError

  if (format === 'legacy') {
    // Exact legacy branch of GET /:id — latest revision in the lineage.
    return store.getLatestRevisionInLineage(id);
  }

  // format === 'graph' — id is the lineageRootId. Resolve the LATEST envelope on
  // that lineage the SAME way handleGraphRead does.
  const envelope = recordGraphStore.getLatestRevisionByLineageRoot(id as RevisionId);
  if (envelope === null) {
    return null;
  }

  // ★ CANONICAL RESOLUTION (fires for EVERY graph read) — resolve to the deal's
  // CANONICAL scored analysis so the deal page and pool coverage always agree on
  // which copy of a deal is authoritative. A deal_ref can carry more than one
  // chain (640: the original 26027996/8c454c15 [60.24, has LTV] AND a duplicate
  // 82fe3bf7 minted on the c9de8c37 chain by the 2026-07-15 agent-incident). The
  // UI navigating to the duplicate showed no verdict/LTV + the wrong
  // completeness. getCanonicalScoredAnalysisId picks the ORIGINAL (earliest
  // analysis) — the SAME rule pool coverage now uses — so both surfaces converge.
  const rootMeta = store.getRootRefAndName(id);
  if (rootMeta?.dealRef) {
    const canonicalId = store.getCanonicalScoredAnalysisId(rootMeta.dealRef);
    if (canonicalId !== null) {
      const canonical = store.getLatestRevisionInLineage(canonicalId);
      if (canonical !== null) return canonical; // the canonical scored deal
    }
  }

  // No canonical scored analysis for this deal_ref → recover THIS chain's own
  // bridged legacy row (name + read-time overlays). Its graph_revision_id points
  // at the lineage HEAD, which IS the latest envelope's revisionId.
  const legacy = store.getAnalysisByGraphRevisionId(envelope.revisionId);
  if (legacy !== null) {
    return legacy.graphRevisionId === envelope.revisionId
      ? legacy
      : { ...legacy, graphRevisionId: envelope.revisionId };
  }

  // Genuine pure-graph deal — no legacy row anywhere for this deal_ref.
  // Synthesize the minimal Analysis the no-LLM memo reconstruction needs:
  // graphRevisionId (HEAD) + name. All memo substrate is read from the graph
  // spine via graphRevisionId; overlays (appraisalExtraction) are honestly
  // absent for a deal that never had a legacy row.
  return synthesizePureGraphAnalysis({
    id,
    name: rootMeta?.name ?? id,
    graphRevisionId: envelope.revisionId,
    lineageRootId: id,
    revisionOrdinal: envelope.revisionOrdinal,
  });
}

/**
 * Build the minimal Analysis shell for a pure-graph deal (no legacy row). Only
 * the fields the memo renderer + noi-basis resolver read carry meaningful
 * values; the rest are honest empties. Kept in one place so the shape is
 * explicit rather than a scattered `as Analysis` cast.
 */
function synthesizePureGraphAnalysis(fields: {
  id: string;
  name: string;
  graphRevisionId: string;
  lineageRootId: string;
  revisionOrdinal: number;
}): Analysis {
  const now = new Date().toISOString();
  return {
    id: fields.id,
    name: fields.name,
    assetType: 'office',
    status: 'complete',
    progress: 100,
    currentStep: 'complete',
    createdAt: now,
    updatedAt: now,
    parentAnalysisId: null,
    lineageRootId: fields.lineageRootId,
    revisionOrdinal: fields.revisionOrdinal,
    graphRevisionId: fields.graphRevisionId,
    document: null,
    uwDocument: null,
    supportingDocuments: [],
    templateDocument: null,
    findings: [],
    creditScore: null,
    uwModel: null,
    research: null,
    crossCheckFindings: [],
    mitigations: [],
    executiveSummary: null,
    bPieceDecision: null,
    comments: [],
    criteriaEvaluations: [],
    stressScenarios: [],
  };
}
