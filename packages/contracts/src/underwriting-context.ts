/**
 * UnderwritingContext (Batch 6.6) - Stage 12 projection output.
 *
 * Bijective structural projection over HydratedRecordGraph: 9 record passthroughs +
 * rootId + metadata wrapper. NO interpretation, NO derivation, NO fallback synthesis.
 *
 * The render layer (Stage 13) consumes this directly. If a field is not present in the
 * underlying HydratedRecordGraph, it is NOT synthesized here - render is responsible for
 * sentinel display of missing data per architecture doctrine D2.
 *
 * Contract distinction: this is the NEW underwriting-context shape (Batch 6.6). The
 * legacy `UnderwritingContext` in `@cre/shared/src/types/underwriting-context.ts` is the
 * legacy-resolver output shape; it is consumed by the legacy render path and will be
 * retired in Batch 6.8 (strict-dispatch). The two coexist during the migration window.
 */

import type { AdjustedInputs } from './adjusted-inputs.js';
import type { AssetProfile } from './asset.js';
import type { CrossCheckResult } from './cross-check.js';
import type { DoctrineEvaluation } from './doctrine/evaluation.js';
import type { DoctrineEvaluationId } from './identity.js';
import type { ExtractionResult } from './extraction.js';
import type { LibrarySnapshot } from './library-snapshot.js';
import type { NarrativeFacts } from './narrative-facts.js';
import type { StressOutputs } from './stress.js';
import type { ValuationConclusion } from './valuation.js';
import type { ISODateTime } from './versioning.js';

export const PROJECTION_VERSION = '6.6' as const;
export type ProjectionVersion = typeof PROJECTION_VERSION;

export interface UnderwritingContextProjectionMetadata {
  readonly hydratedAt: ISODateTime;
  readonly projectionVersion: ProjectionVersion;
}

export interface UnderwritingContext {
  readonly rootId: DoctrineEvaluationId;

  readonly assetProfile: AssetProfile;
  readonly extractionResult: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly adjustedInputs: AdjustedInputs;
  readonly narrativeFacts: NarrativeFacts;
  readonly crossCheckResult: CrossCheckResult;
  readonly stressOutputs: StressOutputs;
  readonly valuationConclusion: ValuationConclusion;
  readonly doctrineEvaluation: DoctrineEvaluation;

  readonly metadata: UnderwritingContextProjectionMetadata;
}
