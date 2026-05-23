/**
 * buildHandbookEvaluation — pure producer for the HandbookEvaluation
 * record (issue #31, Commit 2 of the engine-invocation integration).
 *
 * Composes the field-bag assembler (commit 0eddc80) + the handbook
 * engine (commit f981fec) into a single function that produces a
 * persistable HandbookEvaluation record. Pure: no I/O, no store, no
 * side effects.
 *
 * Pattern matches the existing Stage-4 producers (buildStressOutputs,
 * buildValuationConclusion, buildDoctrineEvaluation) — typed args in,
 * typed record out. The caller (evaluateFromAdjustedInputs) is
 * responsible for persisting.
 */

import type {
  AdjustedInputs,
  AssetProfile,
  FieldBag,
  HandbookEvaluation,
  HydratedRecordGraph,
  ISODateTime,
  NarrativeFacts,
  PropertyMetadata,
  StressOutputs,
} from '@cre/contracts';
import {
  evaluateHandbook,
  HANDBOOK_ENGINE_VERSION,
} from '@cre/handbook-engine';
import { handbook } from '@cre/handbook-data';
import { buildFieldBag } from './assembler.js';
import { computeHandbookEvaluationId } from '../../util/content-hash.js';

// =============================================================================
// Args
// =============================================================================

export interface BuildHandbookEvaluationArgs {
  /**
   * The freshly-built AdjustedInputs. This is the canonical metrics
   * record (architecture §3) and the FK target the resulting
   * HandbookEvaluation will reference.
   */
  readonly adjustedInputs: AdjustedInputs;

  /**
   * AssetProfile, NarrativeFacts, StressOutputs are the three other
   * deal records the field-bag assembler reads. They're already in
   * scope inside evaluateFromAdjustedInputs (assetProfile and
   * narrativeFacts come from the args; stressOutputs is built earlier
   * in the same function).
   */
  readonly assetProfile: AssetProfile;
  readonly narrativeFacts: NarrativeFacts;
  readonly stressOutputs: StressOutputs;

  /**
   * Best-effort PropertyMetadata. The assembler is null-tolerant —
   * when metadata is null, all metadata-derived fields (msa,
   * building_class, etc.) return undefined and the engine skips
   * principles that depend on them with reason 'missing_field'.
   *
   * The caller (evaluateFromAdjustedInputs) loads this via
   * getPropertyMetadataByExtractionResultId(extractionResultId);
   * see Commit 2 store changes.
   */
  readonly propertyMetadata: PropertyMetadata | null;

  /**
   * ISO timestamp threaded through from the surrounding pipeline.
   * Used both for the assembler (converted to Date for age
   * derivations) and stamped onto the HandbookEvaluation record for
   * symmetry with other Stage-4 outputs.
   */
  readonly analysisAsOfDate: ISODateTime;
}

// =============================================================================
// Producer
// =============================================================================

/**
 * Build (but do not persist) a HandbookEvaluation record from the
 * deal's typed records.
 *
 * Flow:
 *   1. Assemble HydratedRecordGraph subset that the field-bag
 *      assembler reads (the four records the assembler touches).
 *      We don't pass the FULL HydratedRecordGraph because at this
 *      point in the pipeline DoctrineEvaluation, ValuationConclusion,
 *      CrossCheckResult, etc. don't exist yet — the assembler only
 *      needs the four records the producer's args already carry.
 *   2. Call the field-bag assembler to project into FieldBag.
 *   3. Call the engine to evaluate against the handbook.
 *   4. Construct the HandbookEvaluation body.
 *   5. Compute the content-hash id and return the typed record.
 *
 * Notes on the partial-graph approach:
 *   The full HydratedRecordGraph interface requires 9 fields. The
 *   field-bag assembler today only reads 4 of them (adjustedInputs,
 *   assetProfile, narrativeFacts, stressOutputs). Passing a partial
 *   graph is type-safe because we cast through the assembler's
 *   AssemblerInputs (which accepts our partial shape structurally).
 *   If the assembler ever grows to read more graph fields, the
 *   producer's args must extend correspondingly.
 */
export function buildHandbookEvaluation(
  args: BuildHandbookEvaluationArgs,
): HandbookEvaluation {
  const {
    adjustedInputs,
    assetProfile,
    narrativeFacts,
    stressOutputs,
    propertyMetadata,
    analysisAsOfDate,
  } = args;

  // 1. Build the assembler's view of the deal records.
  //    Cast through `as unknown as HydratedRecordGraph` because the full
  //    HydratedRecordGraph has 5 more fields the assembler doesn't read.
  //    This is structurally safe at runtime (assembler only touches
  //    these 4 fields). When/if the assembler grows to read more, the
  //    producer's args extend accordingly and this cast tightens.
  const partialGraph = {
    adjustedInputs,
    assetProfile,
    narrativeFacts,
    stressOutputs,
  } as unknown as HydratedRecordGraph;

  // 2. Project into FieldBag.
  const bag: FieldBag = buildFieldBag({
    graph: partialGraph,
    propertyMetadata,
    asOfDate: new Date(analysisAsOfDate),
  });

  // 3. Evaluate against the handbook. Engine consumes the FULL bag, including
  //    undefined keys — its missing-field check treats undefined and key-absent
  //    identically. This is the canonical bag for evaluation.
  const result = evaluateHandbook(handbook, bag);

  // 4. Filter undefined keys for persistence. The workspace's canonical-json
  //    implementation rejects undefined values (strict JCS). The Commit 1
  //    contract docstring on fieldBagSnapshot anticipated this: "After JSON
  //    canonicalization, undefined keys are dropped, so this stores only the
  //    keys with non-undefined values (14 of 31 in v1)." We do the dropping
  //    explicitly here before content-hashing.
  const persistedBag: FieldBag = Object.fromEntries(
    Object.entries(bag).filter(([, value]) => value !== undefined),
  );

  // 5. Construct the record body (everything except id).
  const body = {
    analysisAsOfDate,
    adjustedInputsId: adjustedInputs.id,
    handbookVersion: handbook.version,
    engineVersion: HANDBOOK_ENGINE_VERSION,
    firedFlags: result.firedFlags,
    skippedPrinciples: result.skippedPrinciples,
    fieldBagSnapshot: persistedBag,
  };

  // 6. Compute id + return typed record. The two-step (computeId, then
  //    spread) matches the pattern used by other producers (e.g.,
  //    CrossCheckResult in evaluate-from-adjusted-inputs.ts). The
  //    insertHandbookEvaluation method on the store recomputes the id
  //    from the body and throws RecordIdMismatchError if it disagrees,
  //    so this construction must use the contract-provided factory.
  return {
    id: computeHandbookEvaluationId(body),
    ...body,
  } as HandbookEvaluation;
}
