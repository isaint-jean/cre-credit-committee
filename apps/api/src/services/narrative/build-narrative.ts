/**
 * buildNarrative — Piece A Phase 1 narrative producer (batch 1).
 *
 * One-shot: takes a HandbookEvaluation + AdjustedInputs anchor, runs the
 * format-flags filter for the executive_summary injection point, builds the
 * prompt from prompt-templates, calls the LLM via callAIWithContinuation,
 * and assembles a NarrativeEvaluation record (content-hashed id, ready for
 * store insertion via insertNarrative).
 *
 * Phase 1 scope (the executive_summary survivor): a single string field on
 * the persisted record. Later Phase 1 sub-batches add sibling fields per
 * additional InjectionPoint and bump NARRATIVE_ENGINE_VERSION accordingly.
 *
 * Atomicity (v23 reframe): the producer is pure once the LLM call returns —
 * the content hash of the assembled body determines the record id. The
 * store's ON CONFLICT DO NOTHING handles idempotency. No transactions.
 *
 * LLM dependency: callAIWithContinuation from the legacy ai-analysis.service
 * (the existing primitive — model 'claude-sonnet-4-20250514', auto-
 * continuation on max_tokens). Reuse rather than reinvent per SPEC §14.4
 * v23 Decision 3 (hybrid: new producer + existing LLM primitive).
 */

import type {
  AdjustedInputsId,
  HandbookEvaluation,
  ISODateTime,
  NarrativeEvaluation,
} from '@cre/contracts';
import { NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
import { computeNarrativeEvaluationId } from '../../util/content-hash.js';
import { callAIWithContinuation } from '../ai-analysis.service.js';
import {
  formatFlagsForInjectionPoint,
  consumedPrincipleIdsForInjectionPoint,
} from './format-flags.js';
import {
  NARRATIVE_SYSTEM_PROMPT,
  buildExecutiveSummaryPrompt,
} from './prompt-templates.js';

const NARRATIVE_LLM_MODEL = 'claude-sonnet-4-20250514';
const EXECUTIVE_SUMMARY_MAX_TOKENS = 3000;

/**
 * DI seam for the LLM primitive. Production callers omit `deps.llmCall`
 * (defaulting to the real `callAIWithContinuation`); tests pass a
 * deterministic stub. Pattern cascades upward through `evaluateAndNarrate`,
 * `ingestExtractionResult`, and `applyRevisionDelta` so the whole write
 * path can be exercised in scripts-based tests without hitting the
 * Anthropic API.
 */
export type LLMCallFn = typeof callAIWithContinuation;

export interface BuildNarrativeDeps {
  readonly llmCall?: LLMCallFn;
}

export interface BuildNarrativeInput {
  readonly handbookEvaluation: HandbookEvaluation;
  /**
   * The shared anchor for sibling FK semantics. MUST equal
   * handbookEvaluation.adjustedInputsId — the producer asserts this to
   * catch caller wiring mistakes (passing a stale or mismatched id).
   */
  readonly adjustedInputsId: AdjustedInputsId;
  /**
   * Replay timestamp. Frozen at the upstream extraction step; never wall-
   * clock-derived in the producer (replay determinism).
   */
  readonly analysisAsOfDate: ISODateTime;
}

export class BuildNarrativeError extends Error {
  override readonly name = 'BuildNarrativeError';
  constructor(
    public readonly code:
      | 'ADJUSTED_INPUTS_ID_MISMATCH'
      | 'LLM_EMPTY_RESPONSE',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export async function buildNarrative(
  input: BuildNarrativeInput,
  deps: BuildNarrativeDeps = {},
): Promise<NarrativeEvaluation> {
  const { handbookEvaluation, adjustedInputsId, analysisAsOfDate } = input;
  const llm = deps.llmCall ?? callAIWithContinuation;

  if (handbookEvaluation.adjustedInputsId !== adjustedInputsId) {
    throw new BuildNarrativeError(
      'ADJUSTED_INPUTS_ID_MISMATCH',
      `handbookEvaluation.adjustedInputsId (${handbookEvaluation.adjustedInputsId}) does not match input.adjustedInputsId (${adjustedInputsId}). The producer requires both to point at the same AdjustedInputs anchor.`,
    );
  }

  const formattedFlags = formatFlagsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'executive_summary',
  );
  const consumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'executive_summary',
  );

  const prompt = buildExecutiveSummaryPrompt(formattedFlags);

  const llmOutput = await llm({
    model: NARRATIVE_LLM_MODEL,
    max_tokens: EXECUTIVE_SUMMARY_MAX_TOKENS,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const executiveSummary = llmOutput.trim();

  if (executiveSummary.length === 0) {
    throw new BuildNarrativeError(
      'LLM_EMPTY_RESPONSE',
      `LLM returned empty prose for executive_summary (handbookEvaluationId=${handbookEvaluation.id}). Empty prose is not a valid state for the producer.`,
    );
  }

  const body = {
    analysisAsOfDate,
    adjustedInputsId,
    handbookEvaluationId: handbookEvaluation.id,
    engineVersion: NARRATIVE_ENGINE_VERSION,
    consumedFlagPrincipleIds,
    executiveSummary,
  };

  return {
    id: computeNarrativeEvaluationId(body),
    ...body,
  };
}
