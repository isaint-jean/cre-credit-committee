/**
 * buildNarrative — Piece A narrative producer. Phase 1 (batch 1) shipped
 * with single-slot semantics (executive_summary only). Phase 2 promoted
 * this fn to a thin orchestrator over per-slot helpers; Phase 3 extends
 * to 3 slots:
 *
 *   - `buildExecutiveSummary` (helper) — composes the executive_summary slot
 *   - `buildRedFlagAssessment` (helper) — composes the red_flag_assessment slot
 *   - `buildMitigationSuggestions` (helper) — composes the mitigation_suggestions slot
 *   - `buildNarrative` (orchestrator, this file's public export) — runs the
 *     helpers in parallel via `Promise.all`, assembles a full
 *     NarrativeEvaluation record, returns it ready for store insertion
 *
 * Per Phase 2 Q-S1 (b) + Q-S2 (n.1):
 *   - parallel separate producers: each slot's LLM call is independent;
 *     `Promise.all` recovers single-call wall-clock latency
 *   - orchestrator naming: `buildNarrative` remains the public name; per-
 *     slot helpers live in this file but are not exported
 *
 * Per Phase 2 Q-S4 (f.1) partial-failure semantics:
 *   - `Promise.all` rejects on the first helper rejection. `buildNarrative`
 *     throws; `evaluateAndNarrate` does NOT call `insertNarrative`; no
 *     NarrativeEvaluation row is persisted. A retry re-runs both slots; v23
 *     idempotency-via-content-hash + ON CONFLICT semantics make duplicate
 *     inserts no-ops, so retries are safe.
 *
 * Atomicity (v23 reframe): the producer is pure once both LLM calls return —
 * the content hash of the assembled body determines the record id. The
 * store's ON CONFLICT DO NOTHING handles idempotency.
 *
 * LLM dependency: `callAIWithContinuation` from the legacy ai-analysis.service
 * (the existing primitive — model 'claude-sonnet-4-20250514', auto-
 * continuation on max_tokens). Reuse rather than reinvent per SPEC §14.4
 * v23 Decision 3 (hybrid: new producer + existing LLM primitive). DI seam
 * `deps.llmCall?` lets tests inject a per-slot dispatching stub.
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
  buildRedFlagAssessmentPrompt,
  buildMitigationSuggestionsPrompt,
} from './prompt-templates.js';

const NARRATIVE_LLM_MODEL = 'claude-sonnet-4-20250514';
const EXECUTIVE_SUMMARY_MAX_TOKENS = 3000;
const RED_FLAG_ASSESSMENT_MAX_TOKENS = 3000;
const MITIGATION_SUGGESTIONS_MAX_TOKENS = 3000;

/**
 * DI seam for the LLM primitive. Production callers omit `deps.llmCall`
 * (defaulting to the real `callAIWithContinuation`); tests pass a
 * deterministic stub. The stub can dispatch on prompt content (e.g.,
 * `messages[0].content.includes('red-flag')`) to return different prose
 * per slot. Pattern cascades upward through `evaluateAndNarrate`,
 * `ingestExtractionResult`, and `applyRevisionDelta`.
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

/* ----------------------------- per-slot helpers ----------------------------- */

interface ExecutiveSummaryFragment {
  readonly executiveSummary: string;
  readonly consumedFlagPrincipleIds: readonly string[];
}

async function buildExecutiveSummary(
  input: BuildNarrativeInput,
  llm: LLMCallFn,
): Promise<ExecutiveSummaryFragment> {
  const { handbookEvaluation } = input;
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

  return { executiveSummary, consumedFlagPrincipleIds };
}

interface RedFlagAssessmentFragment {
  readonly redFlagAssessment: string;
  readonly redFlagAssessmentConsumedFlagPrincipleIds: readonly string[];
}

async function buildRedFlagAssessment(
  input: BuildNarrativeInput,
  llm: LLMCallFn,
): Promise<RedFlagAssessmentFragment> {
  const { handbookEvaluation } = input;
  const formattedFlags = formatFlagsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'red_flag_assessment',
  );
  const redFlagAssessmentConsumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'red_flag_assessment',
  );

  const prompt = buildRedFlagAssessmentPrompt(formattedFlags);
  const llmOutput = await llm({
    model: NARRATIVE_LLM_MODEL,
    max_tokens: RED_FLAG_ASSESSMENT_MAX_TOKENS,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const redFlagAssessment = llmOutput.trim();

  if (redFlagAssessment.length === 0) {
    throw new BuildNarrativeError(
      'LLM_EMPTY_RESPONSE',
      `LLM returned empty prose for red_flag_assessment (handbookEvaluationId=${handbookEvaluation.id}). Empty prose is not a valid state for the producer.`,
    );
  }

  return { redFlagAssessment, redFlagAssessmentConsumedFlagPrincipleIds };
}

interface MitigationSuggestionsFragment {
  readonly mitigationSuggestions: string;
  readonly mitigationSuggestionsConsumedFlagPrincipleIds: readonly string[];
}

async function buildMitigationSuggestions(
  input: BuildNarrativeInput,
  llm: LLMCallFn,
): Promise<MitigationSuggestionsFragment> {
  const { handbookEvaluation } = input;
  const formattedFlags = formatFlagsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'mitigation_suggestions',
  );
  const mitigationSuggestionsConsumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'mitigation_suggestions',
  );

  const prompt = buildMitigationSuggestionsPrompt(formattedFlags);
  const llmOutput = await llm({
    model: NARRATIVE_LLM_MODEL,
    max_tokens: MITIGATION_SUGGESTIONS_MAX_TOKENS,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const mitigationSuggestions = llmOutput.trim();

  if (mitigationSuggestions.length === 0) {
    throw new BuildNarrativeError(
      'LLM_EMPTY_RESPONSE',
      `LLM returned empty prose for mitigation_suggestions (handbookEvaluationId=${handbookEvaluation.id}). Empty prose is not a valid state for the producer.`,
    );
  }

  return { mitigationSuggestions, mitigationSuggestionsConsumedFlagPrincipleIds };
}

/* ----------------------------- orchestrator (public) ----------------------- */

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

  // Promise.all: parallel LLM calls (one per slot). If any rejects, the
  // wrapper rejects — per Q-S4 (f.1) partial-failure semantics. No partial
  // NarrativeEvaluation row is persisted; v23 idempotency-via-content-hash
  // makes the retry safe.
  const [execSummary, redFlag, mitigation] = await Promise.all([
    buildExecutiveSummary(input, llm),
    buildRedFlagAssessment(input, llm),
    buildMitigationSuggestions(input, llm),
  ]);

  const body = {
    analysisAsOfDate,
    adjustedInputsId,
    handbookEvaluationId: handbookEvaluation.id,
    engineVersion: NARRATIVE_ENGINE_VERSION,
    consumedFlagPrincipleIds: execSummary.consumedFlagPrincipleIds,
    redFlagAssessmentConsumedFlagPrincipleIds: redFlag.redFlagAssessmentConsumedFlagPrincipleIds,
    mitigationSuggestionsConsumedFlagPrincipleIds: mitigation.mitigationSuggestionsConsumedFlagPrincipleIds,
    executiveSummary: execSummary.executiveSummary,
    redFlagAssessment: redFlag.redFlagAssessment,
    mitigationSuggestions: mitigation.mitigationSuggestions,
  };

  return {
    id: computeNarrativeEvaluationId(body),
    ...body,
  };
}
