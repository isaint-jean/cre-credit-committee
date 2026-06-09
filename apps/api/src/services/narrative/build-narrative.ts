/**
 * buildNarrative — Piece A narrative producer. Phase 1 (batch 1) shipped
 * with single-slot semantics (executive_summary only). Phase 2 promoted
 * this fn to a thin orchestrator over per-slot helpers; Phase 3 extended
 * to 3 slots; Phase 4 closes the slot set with the 4th and final
 * InjectionPoint helper:
 *
 *   - `buildExecutiveSummary` (helper) — composes the executive_summary slot
 *   - `buildRedFlagAssessment` (helper) — composes the red_flag_assessment slot
 *   - `buildMitigationSuggestions` (helper) — composes the mitigation_suggestions slot
 *   - `buildCommitteeRecommendation` (helper) — composes the committee_recommendation slot
 *   - `buildNarrative` (orchestrator, this file's public export) — runs the
 *     four helpers in parallel via `Promise.all`, assembles a full
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
  DataConfidence,
  HandbookEvaluation,
  ISODateTime,
  JudgmentEngineRuleId,
  MitigationProposalSet,
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
  buildCommitteeRecommendationPrompt,
  renderMitigationsListV1_5,
} from './prompt-templates.js';

const NARRATIVE_LLM_MODEL = 'claude-sonnet-4-20250514';
const EXECUTIVE_SUMMARY_MAX_TOKENS = 3000;
const RED_FLAG_ASSESSMENT_MAX_TOKENS = 3000;
const COMMITTEE_RECOMMENDATION_MAX_TOKENS = 3000;

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
  /**
   * Data-confidence axis from AdjustedInputs (v1.6 / engine v1.4 wire).
   * 'unvalidated' short-circuits buildCommitteeRecommendation BEFORE the LLM
   * call to a deterministic "insufficient to recommend" template — see the
   * data-confidence design v1 §2 / §5. 'validated' takes the existing LLM
   * path. Other slots (executiveSummary, redFlagAssessment, mitigation
   * Suggestions) flow through the LLM unchanged in either state.
   */
  readonly dataConfidence: DataConfidence;
  /**
   * AdjustedInputs.dataQualityFlags — the missing-doc / distrust ledger.
   * Consumed only by the committee-recommendation gate (above) to name the
   * material blocking docs when dataConfidence === 'unvalidated'.
   */
  readonly dataQualityFlags: readonly JudgmentEngineRuleId[];
  /**
   * The deterministic MitigationProposalSet produced by the mitigation
   * engine for this AdjustedInputs (v1.5 — 2026-06-08). Threaded in by
   * the orchestrator (`evaluate-and-narrate.ts`) so:
   *   - `mitigation_suggestions` is rendered deterministically from
   *     `proposals` (no LLM call; sized figures are engine output, not
   *     LLM authorship).
   *   - `committee_recommendation` is fed the same rendered text as
   *     prompt context, so the LLM can REFERENCE the deterministic
   *     mitigants but the template forbids it from inventing new sized
   *     conditions.
   *
   * Empty `proposals` is a valid state (Sunroad-style: no breaches, no
   * sizeable lever) — `renderMitigationsListV1_5` returns the canonical
   * empty-case text in that case.
   */
  readonly mitigationProposalSet: MitigationProposalSet;
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

/**
 * v1.5 (2026-06-08) — mitigation_suggestions is now DETERMINISTIC. The slot
 * is rendered directly from the MitigationProposalSet via
 * `renderMitigationsListV1_5`. No LLM call. The integrity guarantee: every
 * sized figure in the slot is byte-identical to a field on a
 * `MitigationProposal` the engine produced. consumedFlagPrincipleIds is
 * still derived from the handbook flags (which fired flags shaped the slot's
 * intent) — preserves the FK semantic across v1.4 → v1.5.
 *
 * Empty `proposals` is a valid state. The renderer emits the canonical
 * "no structural mitigants triggered" line (frozen + hashed).
 */
function buildMitigationSuggestions(
  input: BuildNarrativeInput,
): MitigationSuggestionsFragment {
  const { handbookEvaluation, mitigationProposalSet } = input;
  const mitigationSuggestionsConsumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'mitigation_suggestions',
  );
  const mitigationSuggestions = renderMitigationsListV1_5(mitigationProposalSet.proposals);
  return { mitigationSuggestions, mitigationSuggestionsConsumedFlagPrincipleIds };
}

interface CommitteeRecommendationFragment {
  readonly committeeRecommendation: string;
  readonly committeeRecommendationConsumedFlagPrincipleIds: readonly string[];
}

/**
 * Material missing-doc flags, in committee-readable priority order. Cashflow-
 * first (trailing actuals, in-place) because those are the binding blockers
 * for NOI validation. JE_APPRAISAL_MISSING is deliberately excluded per the
 * data-confidence design — the engine intentionally underwrites to its own
 * implied value (B-piece skepticism of appraisals), so its absence is normal,
 * not a gap. Order is the rendering order.
 */
const MISSING_DOC_LABELS: ReadonlyArray<readonly [JudgmentEngineRuleId, string]> = [
  ['JE_TRAILING_ACTUALS_MISSING',  'trailing-12 operating statement'],
  ['JE_IN_PLACE_MISSING',          'in-place cash flow'],
  ['JE_RENT_ROLL_MISSING',         'rent roll'],
  ['JE_RENT_ROLL_UNIT_INCOMPLETE', 'complete rent roll'],
  ['JE_LOAN_TERMS_MISSING',        'executed loan term sheet'],
  ['JE_PCA_MISSING',               'PCA / capex study'],
];

/**
 * Pure helper for the committee-recommendation gate template. Walks the
 * registered missing-doc flags in priority order and returns a comma-joined
 * human-readable list. Fallback when no listed flag is present — the
 * trailing-actuals flag fires on every deal today (extractor doesn't populate
 * t12Actual), so empty output would normally only happen if the caller passed
 * an empty array; we still emit the two-blocker fallback so the gate prose
 * always names a concrete ask.
 */
export function enumerateMissingDocs(
  flags: readonly JudgmentEngineRuleId[],
): string {
  const present: string[] = [];
  for (const [flag, label] of MISSING_DOC_LABELS) {
    if (flags.includes(flag)) present.push(label);
  }
  if (present.length === 0) {
    return 'trailing-12 operating statement and in-place cash flow';
  }
  return present.join(', ');
}

async function buildCommitteeRecommendation(
  input: BuildNarrativeInput,
  llm: LLMCallFn,
  mitigationsText: string,
): Promise<CommitteeRecommendationFragment> {
  const { handbookEvaluation, dataConfidence, dataQualityFlags } = input;

  // Data-confidence gate (engine v1.4). When inputs are unvalidated, the
  // committee-recommendation slot is replaced with a deterministic ask for
  // the blocking docs — the LLM is NOT called for this slot because making
  // an accept/decline call on unvalidatable data is the actual danger we're
  // closing. Other slots (executive_summary, red_flag_assessment, mitigation
  // _suggestions) still go through the LLM unchanged — those describe the
  // deal-as-extracted; only the verdict slot is hard-gated.
  if (dataConfidence === 'unvalidated') {
    const docList = enumerateMissingDocs(dataQualityFlags);
    const committeeRecommendation =
      'Insufficient data to issue a committee recommendation. The concluded ' +
      'metrics rest on conservative library fallbacks rather than an independent, ' +
      'validated cash-flow source; obtain the following and re-underwrite: ' +
      docList + '.';
    return {
      committeeRecommendation,
      committeeRecommendationConsumedFlagPrincipleIds: [],
    };
  }

  const formattedFlags = formatFlagsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'committee_recommendation',
  );
  const committeeRecommendationConsumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'committee_recommendation',
  );

  const prompt = buildCommitteeRecommendationPrompt(formattedFlags, mitigationsText);
  const llmOutput = await llm({
    model: NARRATIVE_LLM_MODEL,
    max_tokens: COMMITTEE_RECOMMENDATION_MAX_TOKENS,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const committeeRecommendation = llmOutput.trim();

  if (committeeRecommendation.length === 0) {
    throw new BuildNarrativeError(
      'LLM_EMPTY_RESPONSE',
      `LLM returned empty prose for committee_recommendation (handbookEvaluationId=${handbookEvaluation.id}). Empty prose is not a valid state for the producer.`,
    );
  }

  return { committeeRecommendation, committeeRecommendationConsumedFlagPrincipleIds };
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

  // v1.5 — mitigation_suggestions is now DETERMINISTIC (pure, no LLM call);
  // committee_recommendation receives the rendered mitigants text as prompt
  // context and is constrained by the template against inventing new sized
  // structuring. Single source of truth for sized figures: the
  // MitigationProposalSet → renderMitigationsListV1_5 string.
  const mitigation = buildMitigationSuggestions(input);

  // Promise.all: parallel LLM calls for the remaining three slots. If any
  // rejects, the wrapper rejects — per Q-S4 (f.1) partial-failure semantics.
  // No partial NarrativeEvaluation row is persisted; v23 idempotency-via-
  // content-hash makes the retry safe.
  const [execSummary, redFlag, committee] = await Promise.all([
    buildExecutiveSummary(input, llm),
    buildRedFlagAssessment(input, llm),
    buildCommitteeRecommendation(input, llm, mitigation.mitigationSuggestions),
  ]);

  const body = {
    analysisAsOfDate,
    adjustedInputsId,
    handbookEvaluationId: handbookEvaluation.id,
    engineVersion: NARRATIVE_ENGINE_VERSION,
    consumedFlagPrincipleIds: execSummary.consumedFlagPrincipleIds,
    redFlagAssessmentConsumedFlagPrincipleIds: redFlag.redFlagAssessmentConsumedFlagPrincipleIds,
    mitigationSuggestionsConsumedFlagPrincipleIds: mitigation.mitigationSuggestionsConsumedFlagPrincipleIds,
    committeeRecommendationConsumedFlagPrincipleIds: committee.committeeRecommendationConsumedFlagPrincipleIds,
    executiveSummary: execSummary.executiveSummary,
    redFlagAssessment: redFlag.redFlagAssessment,
    mitigationSuggestions: mitigation.mitigationSuggestions,
    committeeRecommendation: committee.committeeRecommendation,
  };

  return {
    id: computeNarrativeEvaluationId(body),
    ...body,
  };
}
