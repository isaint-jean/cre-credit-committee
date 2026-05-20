/**
 * ReplayKey — the canonical tuple that uniquely identifies a doctrine evaluation for replay.
 *
 * For any `ReplayKey`, the system MUST be able to:
 *   1. Resolve every referenced record by id (all are content-hash PKs).
 *   2. Re-run the doctrine evaluator and produce a `DoctrineEvaluation` byte-identical to the
 *      one originally emitted.
 *   3. Detect drift if any version axis changes (re-running with a bumped DOCTRINE_VERSION
 *      produces a different evaluation; the new evaluation gets a new id).
 *
 * Every persisted stage record carries the subset of this key relevant to its replay scope.
 * The `DoctrineEvaluation` carries the full key.
 */

import type {
  AdjustedInputsId,
  CrossCheckResultId,
  DoctrineEvaluationId,
  LibrarySnapshotId,
  NarrativeFactsId,
  StressOutputsId,
  ValuationConclusionId,
} from './identity.js';
import type {
  DoctrineVersion,
  ISODateTime,
  JudgmentEngineVersion,
  StressEngineVersion,
  ValuationEngineVersion,
} from './versioning.js';

export interface ReplayKey {
  // Time anchor — frozen at extraction
  readonly analysisAsOfDate: ISODateTime;

  // Record graph (every node referenced; FK closure realized)
  readonly adjustedInputsId: AdjustedInputsId;
  readonly librarySnapshotId: LibrarySnapshotId;
  readonly narrativeFactsId: NarrativeFactsId;
  readonly crossCheckResultId: CrossCheckResultId;
  readonly stressOutputsId: StressOutputsId;
  readonly valuationConclusionId: ValuationConclusionId;
  readonly doctrineEvaluationId: DoctrineEvaluationId;

  // Independent version axes
  readonly doctrineVersion: DoctrineVersion;
  readonly judgmentEngineVersion: JudgmentEngineVersion;
  readonly stressEngineVersion: StressEngineVersion;
  readonly valuationEngineVersion: ValuationEngineVersion;
}
