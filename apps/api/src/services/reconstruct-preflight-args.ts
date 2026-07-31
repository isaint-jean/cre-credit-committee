/**
 * Reconstruct `PreFlightArgs` from an already-persisted deal — the SAME records
 * the mint consumed (adjustedInputs, librarySnapshot, narrativeFacts,
 * assetProfile, extraction, propertyMetadata, rentRoll), read off the graph via
 * envelope → doctrineEvaluation (mirrors apply-revision-delta's hydration). Used
 * by the dry-run CLI + the byte-identical proof. Read-only.
 */
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { RevisionId, SourceDocumentKind } from '@cre/contracts';
import type { PreFlightArgs } from './pre-flight-readiness.service.js';

export interface ReconstructedDeal {
  readonly args: PreFlightArgs;
  /** The deal's persisted MINTED verdict — for the byte-identical comparison. */
  readonly minted: {
    readonly doctrineEvaluationId: string;
    readonly finalScore: number | null;
    readonly snapshotRating: { recommendation?: string; band?: string | null; ratedRisk?: number | null } | null;
  };
  readonly graphRevisionId: string;
}

export function reconstructPreFlightArgs(
  analysisId: string,
  rgs: RecordGraphStore,
  sqs: SqliteStore,
): ReconstructedDeal | { error: string } {
  const a = sqs.getAnalysis(analysisId);
  if (!a) return { error: `analysis ${analysisId} not found` };
  const revId = a.graphRevisionId;
  if (!revId) return { error: `analysis ${analysisId} has no graphRevisionId (not graph-minted)` };
  const env = rgs.getRevisionEnvelope(revId as RevisionId);
  if (!env) return { error: `no revision envelope for ${String(revId).slice(0, 16)}` };
  const doctrine = rgs.getDoctrineEvaluation(env.doctrineEvaluationId);
  if (!doctrine) return { error: 'doctrine evaluation not resolvable' };

  const adjustedInputs = rgs.getAdjustedInputs(env.adjustedInputsId);
  const librarySnapshot = rgs.getLibrarySnapshot(doctrine.librarySnapshotId);
  const narrativeFacts = rgs.getNarrativeFacts(doctrine.narrativeFactsId);
  const assetProfile = rgs.getAssetProfile(doctrine.assetProfileId);
  const extraction = rgs.getExtractionResult(doctrine.extractionResultId);
  const propertyMetadata = rgs.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? rgs.getRentRoll(doctrine.rentRollId) : null;

  if (!adjustedInputs || !librarySnapshot || !narrativeFacts || !assetProfile || !extraction) {
    return { error: 'lineage incomplete — one of {adjustedInputs, librarySnapshot, narrativeFacts, assetProfile, extraction} missing' };
  }

  const sourceDocumentKinds: SourceDocumentKind[] =
    (extraction.sourceDocuments ?? []).map((d) => d.kind);

  const snap = rgs.getDoctrineRenderSnapshot(env.doctrineEvaluationId) as { rating?: ReconstructedDeal['minted']['snapshotRating'] } | null;

  return {
    args: {
      extraction,
      adjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      propertyMetadata,
      rentRoll,
      sourceDocumentKinds,
      // Graph-native deals carry no legacy overlays; the K resolver reads the
      // spine off extractionResult (attached above). Matches the intake endpoint's
      // behavior for graph-native deals.
    },
    minted: {
      doctrineEvaluationId: env.doctrineEvaluationId,
      finalScore: (doctrine as { finalScore?: number | null }).finalScore ?? null,
      snapshotRating: snap?.rating ?? null,
    },
    graphRevisionId: String(revId),
  };
}
