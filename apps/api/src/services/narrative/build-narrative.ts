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
 * (the existing primitive — model is configured via CLAUDE_MODEL from
 * config/llm-model.ts; auto-continuation on max_tokens). Reuse rather than
 * reinvent per SPEC §14.4
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
import { CLAUDE_MODEL } from '../../config/llm-model.js';
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
  // v1.6 — composed-package wiring + handbook demotion.
  buildExecutiveSummaryPromptV1_6,
  buildRedFlagAssessmentPromptV1_6,
  buildCommitteeRecommendationPromptV1_6,
  renderComposedMitigationsList,
  type AuthoritativeNumbers,
  type CleanDoctrineFinding,
  type ComposedMitigationView,
  // v1.8 — Open Items / Data Required deterministic slot.
  OPEN_ITEMS_HEADER_V1_8,
  OPEN_ITEMS_INTRO_V1_8,
  OPEN_ITEMS_EMPTY_V1_8,
  OPEN_ITEMS_THEME_HEADERS_V1_8,
  OPEN_ITEMS_PRINCIPLE_THEME_V1_8,
  OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8,
} from './prompt-templates.js';
import { dimensionRiskSentence, principleCreditQuestion, scrubResidualIdentifiers } from './committee-voice.js';
import type { EvaluateDealResult } from '../../doctrine-clean/scoring/evaluate-deal.js';
import type { ComposedMitigationPackage } from '../mitigation/compose-mitigations.js';
import {
  EXIT_DSCR_REFINANCEABLE_THRESHOLD,
} from '../../doctrine-clean/dimensions/refinance-feasibility.js';
import {
  DEFAULT_MITIGATION_DESK,
} from '../mitigation/produce-mitigations.js';

const NARRATIVE_LLM_MODEL = CLAUDE_MODEL;
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
  /**
   * v1.6 — clean-doctrine evaluation result. The producer projects the
   * authoritative-numbers block (rating, dim-7 stressedValue + source tag,
   * dim-4 exit DSCR, etc.) from this. OPTIONAL during the v1.5→v1.6
   * rollout: when present alongside composedMitigationPackage, the
   * producer takes the v1.6 path (clean-doctrine + composed-package
   * wiring + handbook demotion). When omitted, it falls back to the
   * v1.5 path so existing callers continue to work.
   */
  readonly dealResult?: EvaluateDealResult;
  /**
   * v1.6 — composed mitigation package (post-composition resolution). The
   * producer renders mitigation_suggestions FROM THE COMPOSED PROPOSALS +
   * reconciliation notes, not from the raw produceMitigations output.
   * Optional; see dealResult.
   */
  readonly composedMitigationPackage?: ComposedMitigationPackage;
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

/* ------- v1.6 deterministic projections from dealResult + composed ------- */

/**
 * Canonical dim numbering used for the v1.6 red-flag-assessment headline.
 * Matches the 9-dim doctrine the rest of the system uses.
 */
const DIM_NUMBER_BY_ID: Readonly<Record<string, number>> = {
  'leverage-ltv':                1,
  'coverage-dscr':               2,
  'debt-yield':                  3,
  'refinance-feasibility':       4,
  'income-concentration':        5,
  'rollover':                    6,
  'cap-rate-valuation-stress':   7,
  'asset-class':                 8,
  'sponsor-borrower-quality':    9,
};

/**
 * Committee-voice risk headline per dim. Delegates to the committee-voice
 * mapping layer: a plain-English RISK claim in the handbook's language, NOT a
 * metric restatement (metrics belong in the numbers sections of the memo, not
 * the risk headline). No dimension id, tier enum, or raw metric ever appears.
 */
function headlineFor(c: { dimensionId: string; tier: string; derivedOutputs?: Readonly<Record<string, number | string | null>> }): string {
  return dimensionRiskSentence(c.dimensionId, c.tier);
}

/**
 * Extract risk-elevated clean-doctrine dim findings, sorted by canonical
 * dim number. Filters to applicable + tier above 'baseline'/'low'. Pure.
 */
export function extractCleanDoctrineFindings(
  dealResult: EvaluateDealResult,
): CleanDoctrineFinding[] {
  const findings: CleanDoctrineFinding[] = [];
  for (const c of dealResult.allDimensions) {
    if (c.applicability !== 'applicable') continue;
    const tier = (c.tier ?? '').toLowerCase();
    // Surface anything that's NOT 'baseline', 'low', or 'N/A'. The doctrine's
    // tier strings vary per dim; this conservative filter keeps it broad.
    if (tier === 'baseline' || tier === 'low' || tier === 'n/a' || tier === '') continue;
    const dimNumber = DIM_NUMBER_BY_ID[c.dimensionId] ?? 0;
    findings.push({
      dimNumber,
      dimensionId: c.dimensionId,
      tier: c.tier ?? 'unknown',
      headline: headlineFor(c),
    });
  }
  findings.sort((a, b) => a.dimNumber - b.dimNumber);
  return findings;
}

/**
 * Project the AuthoritativeNumbers block from dealResult + composedPackage.
 * Pure. Every field traces to a derivedOutput or a composed proposal field;
 * no formula in the projection.
 */
export function projectAuthoritativeNumbers(
  dealResult: EvaluateDealResult,
  composed: ComposedMitigationPackage,
): AuthoritativeNumbers {
  const dim7 = dealResult.dimensions.capRateValuationStress;
  const dim4 = dealResult.dimensions.refinanceFeasibility;
  const dim7d = dim7.derivedOutputs ?? {};
  const dim4d = dim4.derivedOutputs ?? {};
  const dim7Final = composed.finalState.dealResult.dimensions.capRateValuationStress;
  const dim4Final = composed.finalState.dealResult.dimensions.refinanceFeasibility;

  const num = (rec: Readonly<Record<string, number | string | null>> | undefined, k: string): number | null => {
    const v = rec?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const str = (rec: Readonly<Record<string, number | string | null>> | undefined, k: string): string | null => {
    const v = rec?.[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  const concludedValueSource = str(dim7d, 'concludedValueSource');
  const valuationConfidenceNote = concludedValueSource === 'operator-supplied'
    ? 'valuation basis: operator-supplied (lower data confidence than third-party appraisal; data-confidence note, not a score penalty)'
    : null;

  return {
    ratingRecommendation: (dealResult.rating as { recommendation?: string }).recommendation ?? null,
    ratingBand:           (dealResult.rating as { ratingBand?: string }).ratingBand ?? null,
    assetType:            null,    // assetType isn't on dealResult.rating; producer can override
    subType:              null,
    originalLoanAmount:   composed.reconciliation.originalLoanAmount,
    finalLoanAmount:      composed.reconciliation.finalLoanAmount,
    proceedsReduction:    composed.reconciliation.proceedsReduction,
    stressedValue:        num(dim7d, 'stressedValue'),
    stressedLtv:          num(dim7d, 'stressedLtv'),
    stressedLtvAtFinalLoan: num(dim7Final.derivedOutputs ?? {}, 'stressedLtv'),
    ltvTrigger:           DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER,
    concludedValue:       num(dim7d, 'concludedValue') ?? null,
    concludedValueSource: concludedValueSource as AuthoritativeNumbers['concludedValueSource'],
    valuationConfidenceNote,
    exitDscrBaseline:     num(dim4d, 'exitDscr'),
    exitDscrAtFinalLoan:  num(dim4Final.derivedOutputs ?? {}, 'exitDscr'),
    exitDscrTrigger:      EXIT_DSCR_REFINANCEABLE_THRESHOLD,
    exitDscrCureTarget:   DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET,
    standaloneAmortPaydown: composed.reconciliation.standaloneAmortPaydown,
    composedAmortPaydown:   composed.reconciliation.composedAmortPaydown,
  };
}

/* ----------------------------- per-slot helpers ----------------------------- */

interface ExecutiveSummaryFragment {
  readonly executiveSummary: string;
  readonly consumedFlagPrincipleIds: readonly string[];
}

async function buildExecutiveSummary(
  input: BuildNarrativeInput,
  llm: LLMCallFn,
  auth: AuthoritativeNumbers | null,
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

  // v1.6 path: clean-doctrine authoritative numbers PRIMARY; handbook
  // observations qualitative-only (metric strings stripped by template).
  // v1.5 fallback: legacy handbook-only prompt.
  const prompt = auth !== null
    ? buildExecutiveSummaryPromptV1_6(auth, formattedFlags)
    : buildExecutiveSummaryPrompt(formattedFlags);
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
  auth: AuthoritativeNumbers | null,
  cleanFindings: readonly CleanDoctrineFinding[],
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

  // v1.6 path: clean-doctrine findings PRIMARY; handbook flags qualitative-
  // only via the template's renderHandbookSupportingObservations helper
  // (metric strings stripped). v1.5 fallback: legacy handbook-only prompt.
  const prompt = auth !== null
    ? buildRedFlagAssessmentPromptV1_6(auth, cleanFindings, formattedFlags)
    : buildRedFlagAssessmentPrompt(formattedFlags);
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
  const { handbookEvaluation, mitigationProposalSet, composedMitigationPackage } = input;
  const mitigationSuggestionsConsumedFlagPrincipleIds = consumedPrincipleIdsForInjectionPoint(
    handbookEvaluation.firedFlags,
    'mitigation_suggestions',
  );
  // v1.6 path: render the COMPOSED package (post-resolution proposals +
  // reconciliation notes) — the memo shows WHY a lever dropped or shrank,
  // not just the final list. v1.5 fallback: render the raw proposal set.
  const mitigationSuggestions = composedMitigationPackage !== undefined
    ? renderComposedMitigationsList({
        proposals: composedMitigationPackage.proposals,
        reconciliationNotes: composedMitigationPackage.reconciliation.notes,
        covenantMagnitudesAtFinalLoan:
          composedMitigationPackage.reconciliation.covenantMagnitudesAtFinalLoan,
      })
    : renderMitigationsListV1_5(mitigationProposalSet.proposals);
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
  auth: AuthoritativeNumbers | null,
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

  // v1.6 path: grounds in clean-doctrine rating + composed conditions; the
  // handbook flags filtered to this slot are NOT injected (the authoritative-
  // numbers block already carries the load-bearing facts; template forbids
  // inventing new sized structuring beyond what composition produced).
  // v1.5 fallback: legacy handbook+mitigations prompt.
  const prompt = auth !== null
    ? buildCommitteeRecommendationPromptV1_6(auth, mitigationsText)
    : buildCommitteeRecommendationPrompt(formattedFlags, mitigationsText);
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

/* -------------------- open items / data required (v1.8) -------------------- */

interface OpenItemsFragment {
  readonly openItemsAndDataRequired: string;
  readonly openItemsConsumedSkippedPrincipleIds: readonly string[];
}

// Parse "metric field 'cash_out_amount'" → "cash_out_amount". Robust to
// minor format drift in the engine's diagnostic text.
function extractMissingFieldToken(detail: string | undefined): string | null {
  if (!detail) return null;
  const m = detail.match(/^metric field '([a-zA-Z_][a-zA-Z0-9_]*)'$/);
  return m ? m[1]! : null;
}

function buildOpenItemsAndDataRequired(
  input: BuildNarrativeInput,
): OpenItemsFragment {
  const { handbookEvaluation } = input;

  // Filter to data-gated reasons. Other skip reasons (trigger_inactive,
  // no_band_matched, not_deterministic, etc.) are bookkeeping for the
  // engine's audit trail — they're not analyst-actionable open items.
  const dataGated = handbookEvaluation.skippedPrinciples.filter(
    (s) => s.reason === 'needs_manual_input' || s.reason === 'missing_field',
  );

  if (dataGated.length === 0) {
    return {
      openItemsAndDataRequired: [
        OPEN_ITEMS_HEADER_V1_8,
        '',
        OPEN_ITEMS_EMPTY_V1_8,
      ].join('\n'),
      openItemsConsumedSkippedPrincipleIds: [],
    };
  }

  // Bucket by theme; preserve principle-id order within each bucket so the
  // output is deterministic given identical input.
  type ThemeKey = 'sponsor_borrower' | 'income_leases' | 'market_comps' | 'property_ops' | 'other';
  const bucketed = new Map<ThemeKey, typeof dataGated>();
  for (const [theme] of OPEN_ITEMS_THEME_HEADERS_V1_8) {
    bucketed.set(theme as ThemeKey, [] as typeof dataGated);
  }
  for (const s of dataGated) {
    const theme = (OPEN_ITEMS_PRINCIPLE_THEME_V1_8[s.principleId] ?? 'other') as ThemeKey;
    bucketed.get(theme)!.push(s);
  }
  for (const arr of bucketed.values()) {
    arr.sort((a, b) => a.principleId.localeCompare(b.principleId));
  }

  // Render. Each theme section emits ONLY when it has items — keeps the
  // memo lean (no empty "## sponsor_borrower" headers when nothing landed
  // there).
  const lines: string[] = [OPEN_ITEMS_HEADER_V1_8, '', OPEN_ITEMS_INTRO_V1_8, ''];
  for (const [theme, header] of OPEN_ITEMS_THEME_HEADERS_V1_8) {
    const items = bucketed.get(theme as ThemeKey)!;
    if (items.length === 0) continue;
    lines.push(header);
    for (const s of items) {
      // Committee-voice: cite the plain-English credit question the principle
      // asks, never the "P-XX-N" identifier or the raw handbook title.
      const ask = renderOpenItemAsk(s);
      lines.push(`- **The committee cannot yet assess ${principleCreditQuestion(s.principleId)}.** ${ask}`);
    }
    lines.push('');
  }

  // The principle-id list for replay bookkeeping. Sorted ascending across
  // ALL data-gated skips (not by theme) — sibling to the existing
  // *ConsumedFlagPrincipleIds fields which are also flat sorted lists.
  const ids = dataGated.map((s) => s.principleId).sort();
  return {
    openItemsAndDataRequired: lines.join('\n').trimEnd(),
    openItemsConsumedSkippedPrincipleIds: ids,
  };
}

// Render the diligence ask for a single data-gated skip.
//   - needs_manual_input → the LLM-generated detail is already deal-specific
//     and fluent (verified across Sunroad's 18 such skips). Surface verbatim.
//   - missing_field → the engine's bare metric-path token gets translated
//     via OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8. Falls back to the bare
//     detail when the field token is not yet enumerated in the table; that's
//     the honest disclosure path for any new missing_field principle that
//     ships before the table is extended.
function renderOpenItemAsk(skip: { reason: string; detail?: string }): string {
  if (skip.reason === 'missing_field') {
    const token = extractMissingFieldToken(skip.detail);
    if (token !== null && OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8[token] !== undefined) {
      return `${OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8[token]} required.`;
    }
    return scrubResidualIdentifiers(skip.detail ?? '(field path unavailable)') + ' required.';
  }
  // needs_manual_input — the detail is the analyst-facing ask, authored by the
  // handbook engine. Scrub any engine-diagnostic token before surfacing so no
  // JE_ code, "P-" citation, metric-path, or key=value aside reaches committee
  // prose.
  return scrubResidualIdentifiers(skip.detail ?? '(detail unavailable; reason needs_manual_input)');
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

  // v1.6 path-select: when both dealResult + composedMitigationPackage are
  // provided, project the deterministic AuthoritativeNumbers block + clean-
  // doctrine findings ONCE; every LLM-authored slot then cites a single,
  // engine-derived set of figures. Source-tag disclosure
  // (concludedValueSource) flows through executive_summary. When omitted,
  // auth/cleanFindings stay null and the v1.5 fallback templates run.
  const v16Inputs = input.dealResult !== undefined && input.composedMitigationPackage !== undefined;
  const auth = v16Inputs
    ? projectAuthoritativeNumbers(input.dealResult!, input.composedMitigationPackage!)
    : null;
  const cleanFindings = v16Inputs ? extractCleanDoctrineFindings(input.dealResult!) : [];

  // v1.6 — mitigation_suggestions deterministic render now sources the
  // COMPOSED package (post-resolution proposals + reconciliation notes),
  // not raw produceMitigations output.
  const mitigation = buildMitigationSuggestions(input);

  // v1.8 — Open Items / Data Required deterministic slot. Surfaces the
  // handbook's data-gated skips (needs_manual_input + missing_field) so the
  // memo reads the diligence ledger, not just the fired-flag ledger. No
  // LLM call — pure template.
  const openItems = buildOpenItemsAndDataRequired(input);

  // Promise.all: parallel LLM calls for the remaining three slots. If any
  // rejects, the wrapper rejects — per Q-S4 (f.1) partial-failure semantics.
  // No partial NarrativeEvaluation row is persisted; v23 idempotency-via-
  // content-hash makes the retry safe.
  const [execSummary, redFlag, committee] = await Promise.all([
    buildExecutiveSummary(input, llm, auth),
    buildRedFlagAssessment(input, llm, auth, cleanFindings),
    buildCommitteeRecommendation(input, llm, mitigation.mitigationSuggestions, auth),
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
    openItemsConsumedSkippedPrincipleIds: openItems.openItemsConsumedSkippedPrincipleIds,
    executiveSummary: execSummary.executiveSummary,
    redFlagAssessment: redFlag.redFlagAssessment,
    mitigationSuggestions: mitigation.mitigationSuggestions,
    committeeRecommendation: committee.committeeRecommendation,
    openItemsAndDataRequired: openItems.openItemsAndDataRequired,
  };

  return {
    id: computeNarrativeEvaluationId(body),
    ...body,
  };
}
