/**
 * HydratedRecordGraph — Stage 11 hydration output.
 *
 * Typed bundle of the 10 records that constitute one analysis. Produced by
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
 *
 * `rentRoll` (Phase 2 of rent-roll-node) is the typed RentRoll captured at extraction time,
 * hoisted out of the legacy ExtractionResult.rentRoll projection into a first-class graph
 * node. The handbook evaluator reads this — NOT ExtractionResult — preserving the §2.3
 * isolation boundary for per-tenant analysis. Nullable: a deal genuinely may have no rent
 * roll (no xlsx uploaded + no ASR fallback). Hydration produces `rentRoll: null` when the
 * root's `rentRollId` is null; a non-null id that fails to resolve is a hard hydration error
 * (HY3 — see hydrate-record-graph.ts).
 */

import type { AdjustedInputs } from './adjusted-inputs.js';
import type { AssetProfile } from './asset.js';
import type { CrossCheckResult } from './cross-check.js';
import type { DoctrineEvaluation } from './doctrine/evaluation.js';
import type { ExtractionResult } from './extraction.js';
import type { LibrarySnapshot } from './library-snapshot.js';
import type { NarrativeFacts } from './narrative-facts.js';
import type { RentRoll } from './rent-roll.js';
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
  /**
   * Phase 2 (rent-roll-node): typed RentRoll, hydrated via single-hop FK lookup from
   * DoctrineEvaluation.rentRollId. The first optional FK in the bundle — null when the
   * root's rentRollId is null (deal has no rent roll). Hydration preserves null fidelity:
   * a non-null rentRollId that fails to resolve throws DANGLING_FK_RENT_ROLL (HY3).
   */
  readonly rentRoll: RentRoll | null;
}
