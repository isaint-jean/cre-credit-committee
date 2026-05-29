/**
 * Shared LLM-stub deps for scripts-based tests (Piece A Phase 1 batch 2).
 *
 * Every test that exercises the write-path (ingestExtractionResult,
 * applyRevisionDelta) transitively triggers `evaluateAndNarrate`, which
 * calls the LLM via `buildNarrative`. Tests pass `STUB_LLM_DEPS` as the
 * third arg to those services so the LLM is never invoked — the stub
 * returns a deterministic string and the narrative producer composes its
 * NarrativeEvaluation around it.
 *
 * Production code paths do NOT import this file; the underscore prefix
 * + scripts/ location keep it private to the test surface.
 */

import type { LLMCallFn } from '../services/narrative/build-narrative.js';

export const STUB_LLM_EXECUTIVE_SUMMARY =
  'Deterministic test executive summary. The deal carries flagged risks per the handbook evaluation.';

export const stubLLMCall: LLMCallFn = async () => STUB_LLM_EXECUTIVE_SUMMARY;

export const STUB_LLM_DEPS = { llmCall: stubLLMCall } as const;
