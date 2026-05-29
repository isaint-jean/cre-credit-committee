/**
 * `evaluateAndNarrate` — 3c coupled atomic wrapper (Piece A Phase 1
 * batch 2). Composes `evaluateFromAdjustedInputs` (producer-tail through
 * DoctrineEvaluation, including the Stage 6.5 HandbookEvaluation) with
 * `buildNarrative` + `insertNarrative` so a single call from the write-
 * path orchestrators (`ingestExtractionResult`, `applyRevisionDelta`)
 * produces and persists the full {DE, HE, Narrative} triple.
 *
 * SPEC anchors:
 *   - §14.4 v22 (coupled atomic wrapper architecture)
 *   - §14.4 v23 (atomicity via content-hash + ON CONFLICT, not transactions)
 *
 * Atomicity tracing (verified at recon, ITEM 1):
 *   - evaluateFromAdjustedInputs inserts AI → CC → SO → HE → VC → DE
 *     in dependency order, each via ON CONFLICT(id) DO NOTHING.
 *   - buildNarrative is async (LLM round-trip). If it throws, the
 *     producer-tail records are already persisted. Caller retries:
 *     evaluateFromAdjustedInputs re-runs as no-op (same content hashes),
 *     buildNarrative is re-attempted. Two narrative attempts can
 *     produce two rows (LLM non-determinism); both are valid and
 *     `getLatestNarrativeForAdjustedInputs(_, version)` returns the
 *     newer one.
 *
 * LLM DI seam (§14.4 batch 2 Q-R4): the `deps.llmCall` option cascades
 * downward into `buildNarrative`. Production callers omit it (the real
 * `callAIWithContinuation` is used); tests pass a deterministic stub.
 */

import type {
  DoctrineEvaluation,
  HandbookEvaluation,
  NarrativeEvaluation,
} from '@cre/contracts';
import { buildNarrative, type LLMCallFn } from './narrative/build-narrative.js';
import {
  evaluateFromAdjustedInputs,
  type EvaluateFromAdjustedInputsArgs,
} from './evaluate-from-adjusted-inputs.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

export interface EvaluateAndNarrateDeps {
  readonly llmCall?: LLMCallFn;
}

export interface EvaluateAndNarrateResult {
  readonly evaluation: DoctrineEvaluation;
  readonly handbookEvaluation: HandbookEvaluation;
  readonly narrative: NarrativeEvaluation;
}

export async function evaluateAndNarrate(
  args: EvaluateFromAdjustedInputsArgs,
  store: RecordGraphStore,
  deps: EvaluateAndNarrateDeps = {},
): Promise<EvaluateAndNarrateResult> {
  const { evaluation, handbookEvaluation } = evaluateFromAdjustedInputs(
    args,
    store,
  );

  const narrative = await buildNarrative(
    {
      handbookEvaluation,
      adjustedInputsId: args.adjustedInputs.id,
      analysisAsOfDate: args.analysisAsOfDate,
    },
    { llmCall: deps.llmCall },
  );
  store.insertNarrative(narrative);

  return { evaluation, handbookEvaluation, narrative };
}
