// Stage 12 projection (Batch 6.6) - bijective structural projection over HydratedRecordGraph.
//
// Pure function. NO interpretation. NO derivation. NO fallback synthesis. NO computed fields.
// HydratedRecordGraph -> UnderwritingContext is structural identity passthrough plus a
// rootId tag and a metadata wrapper.
//
// ============================================================================
// Projection invariants (LOCKED - load-bearing). Mirrors hydration discipline (HY1-HY7)
// for the read side. Any future change here must justify conformance to every line below
// or the change is rejected on first reading.
// ============================================================================
//
//   PJ1 - Bijective structural projection. HydratedRecordGraph -> UnderwritingContext
//         is a 1:1 mapping of all 9 records, plus rootId and metadata wrapper. No
//         additional fields. No dropped fields. No reshaping of inner records.
//
//   PJ2 - No interpretation. Forbidden in this file: nullish coalescing, logical-OR
//         numeric defaulting, Math.max / Math.min, asset-class branching (if propertyType
//         / if assetClass), Object.keys / Object.values iteration-order leaks, new Date
//         wall-clock reads (passthrough timestamps from records ARE permitted), Math.random,
//         process.env, readFileSync / writeFileSync.
//
//   PJ3 - No fallback construction. If a field is not present in the input bundle, it is
//         NOT synthesized here. Render is responsible for sentinel display of missing data
//         (architecture doctrine D2).
//
//   PJ4 - Pure function. Same input -> byte-identical output. No clock, no random, no env,
//         no filesystem, no network, no global state.
//
//   PJ5 - Identity passthrough only. Valid operations: field-to-field mapping, structural
//         renaming, graph dereference (graph.X), passthrough of immutable timestamps.
//         INVALID: any computation, normalization, conditional inference.
//
// ============================================================================

import type {
  DoctrineEvaluationId,
  HydratedRecordGraph,
  UnderwritingContext,
} from '@cre/contracts';
import { PROJECTION_VERSION } from '@cre/contracts';

export interface ProjectionInput {
  readonly rootId: DoctrineEvaluationId;
  readonly graph: HydratedRecordGraph;
}

export function buildUnderwritingContextProjection(
  input: ProjectionInput,
): UnderwritingContext {
  const { rootId, graph } = input;

  const doctrine = graph.doctrineEvaluation;
  const extraction = graph.extractionResult;

  return {
    rootId,

    assetProfile: graph.assetProfile,
    extractionResult: extraction,
    librarySnapshot: graph.librarySnapshot,
    adjustedInputs: graph.adjustedInputs,
    narrativeFacts: graph.narrativeFacts,
    crossCheckResult: graph.crossCheckResult,
    stressOutputs: graph.stressOutputs,
    valuationConclusion: graph.valuationConclusion,
    doctrineEvaluation: doctrine,

    metadata: {
      hydratedAt: doctrine.analysisAsOfDate,
      projectionVersion: PROJECTION_VERSION,
    },
  };
}
