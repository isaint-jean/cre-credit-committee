/**
 * HydratedRecordGraph — Stage 11 hydration output.
 *
 * Typed bundle of the 9 records that constitute one analysis. Produced by
 * `hydrate-underwriting-context` from a single `DoctrineEvaluationId` root via FK closure
 * (see `apps/api/src/services/hydrate-underwriting-context.ts` and the hydration invariants
 * locked in Batch 6.5).
 *
 * Architecture rule (§2.1 H1): typed graph, NOT a flattened context. Flattening to a bag of
 * fields is forbidden — it destroys provenance, creates shadow sources of truth, and enables
 * hidden fallback chains. Resolver (Stage 12) and render audit-display (Stage 13) consume
 * this bundle directly; they never re-flatten it.
 *
 * `extractionResult` is included for narrative / audit display only (§2.3 isolation
 * boundary — enforced by the lint policy in Batch 6.0). Producers downstream of Stage 4
 * judgment-engine MUST NOT read it; they read `adjustedInputs` instead.
 */

import type { AdjustedInputs } from './adjusted-inputs.js';
import type { AssetProfile } from './asset.js';
import type { CrossCheckResult } from './cross-check.js';
import type { DoctrineEvaluation } from './doctrine/evaluation.js';
import type { ExtractionResult } from './extraction.js';
import type { LibrarySnapshot } from './library-snapshot.js';
import type { NarrativeFacts } from './narrative-facts.js';
import type { StressOutputs } from './stress.js';
import type { ValuationConclusion } from './valuation.js';

export interface HydratedRecordGraph {
  readonly doctrineEvaluation: DoctrineEvaluation;
  readonly valuationConclusion: ValuationConclusion;
  readonly stressOutputs: StressOutputs;
  readonly crossCheckResult: CrossCheckResult;
  readonly adjustedInputs: AdjustedInputs;
  readonly narrativeFacts: NarrativeFacts;
  readonly librarySnapshot: LibrarySnapshot;
  readonly assetProfile: AssetProfile;
  readonly extractionResult: ExtractionResult;
}
