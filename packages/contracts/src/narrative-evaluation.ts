/**
 * NarrativeEvaluation — LLM-produced narrative output record (Piece A
 * Phase 1, batch 1). Sibling to HandbookEvaluation.
 *
 * SPEC anchor: docs/specs/uw-template-populator/SPEC.md §14.4 (v17 through
 * v23 amendment chain). Phase 1 ships the executive_summary survivor only;
 * additional injection-point slots land in subsequent Phase 1 sub-batches
 * via MINOR version bump (NARRATIVE_ENGINE_VERSION '1.0' → '1.1' → '1.2' → '1.3').
 * Phase 4 ('1.3') closes the slot set — all 4 InjectionPoints have producers.
 *
 * Sibling-record architecture (matches HandbookEvaluation precedent):
 *   - FK is `adjustedInputsId: AdjustedInputsId` only (not
 *     `doctrineEvaluationId`, not `handbookEvaluationId` as the FK).
 *     Siblings of the same AdjustedInputs do NOT FK to each other; the
 *     dependency relationship is "evaluation depends on inputs," not
 *     "one sibling on another." SPEC v17-v23 referred to the FK as
 *     `rootId` colloquially — the sibling-record principle dictates
 *     AdjustedInputs as the shared anchor.
 *
 *   - `handbookEvaluationId` is preserved as a substrate REFERENCE (the
 *     specific HE the producer consumed for its flags), distinct from
 *     the FK. Stored so replay can identify exactly which HE shaped this
 *     narrative without re-running format-flags.
 *
 * Atomicity (v23 reframe): idempotency via content-hash + ON CONFLICT
 * DO NOTHING at the store layer. Same content (same handbook flags,
 * same engine version, same prompt template hash, same LLM output) →
 * same id → no-op insert. No DB transactions; the codebase has no
 * transactional model.
 *
 * Coupled producer wrapper (v22 architecture, provisional name
 * `evaluateAndNarrate`): a 3c-style atomic call that produces the
 * HandbookEvaluation and the NarrativeEvaluation in one shot, persisting
 * both. Lives in apps/api/src/services/ when wired (batch 2). This
 * contract module declares only shape.
 */

import type {
  AdjustedInputsId,
  HandbookEvaluationId,
  NarrativeEvaluationId,
} from './identity.js';
import type {
  ISODateTime,
  NarrativeEngineVersion,
} from './versioning.js';

/**
 * Persisted record — one row per `(handbookEvaluation, narrative-engine
 * version)` pair after the format-flags + LLM pipeline runs. Phase 1
 * carries only the executive_summary slot; additional injection-point
 * slots land as new fields in Phase 1 sub-batches via a MINOR engine
 * version bump.
 */
export interface NarrativeEvaluation {
  readonly id: NarrativeEvaluationId;
  readonly analysisAsOfDate: ISODateTime;

  /**
   * Sibling FK. NarrativeEvaluation depends on AdjustedInputs (the
   * shared anchor for all siblings of a deal), not on the
   * HandbookEvaluation it consumed. Same shape as HandbookEvaluation
   * itself, which also FKs to AdjustedInputs only.
   */
  readonly adjustedInputsId: AdjustedInputsId;

  /**
   * The specific HandbookEvaluation the producer consumed. NOT a FK
   * in the strict sibling-record sense (the store may relax this if
   * doctrine ever produces narratives from different sources), but
   * preserved here so replay can answer "which HE shaped this
   * narrative" without re-running format-flags.
   */
  readonly handbookEvaluationId: HandbookEvaluationId;

  /**
   * Branded narrative-engine version. Bumps when prompt templates,
   * format-flags filter semantics, or producer wiring changes in a
   * way that materially affects LLM output. Distinct from
   * HANDBOOK_ENGINE_VERSION — narrative version = how we composed;
   * handbook version = what flags we consumed.
   */
  readonly engineVersion: NarrativeEngineVersion;

  /**
   * Principle ids of the fired flags that survived the format-flags
   * filter for the **executive_summary** injection point and were
   * therefore embedded in that slot's prompt. Sorted ascending for
   * canonicalization stability — replay can recompute this list from
   * the handbook evaluation and verify equality without rerunning the
   * LLM.
   *
   * SCOPE NOTE: this field's scope is executive_summary only, per the
   * additive-widening decision (Phase 2 Q-S3 (γ.2)). Phase 2+ adds
   * sibling fields per slot rather than collapsing into a map. The
   * verbose naming is the accepted trade-off; a v2.0 (MAJOR) clean
   * rename is the planned exit if slot 3 or 4 verbosity becomes
   * painful.
   *
   * Empty array is valid (no flags fire on executive_summary → the
   * producer composes a no-flags narrative, which is still useful
   * prose).
   */
  readonly consumedFlagPrincipleIds: readonly string[];

  /**
   * Principle ids of the fired flags that survived the format-flags
   * filter for the **red_flag_assessment** injection point (Phase 2
   * addition; NARRATIVE_ENGINE_VERSION '1.1'). Sibling to
   * `consumedFlagPrincipleIds` (which scopes to executive_summary)
   * per the additive-widening decision Q-S3 (γ.2). Sorted ascending
   * for canonicalization stability. Empty array is valid.
   */
  readonly redFlagAssessmentConsumedFlagPrincipleIds: readonly string[];

  /**
   * Principle ids of the fired flags that survived the format-flags
   * filter for the **mitigation_suggestions** injection point
   * (Phase 3 addition; NARRATIVE_ENGINE_VERSION '1.2'). Third
   * sibling consumed-IDs field per Q-S3 (γ.2) additive-widening.
   * Sorted ascending for canonicalization stability. Empty array
   * is valid.
   *
   * Semantic relationship to other slots is NOT guaranteed by the
   * handbook engine — each principle declares its own
   * `injectionPoints` array; mitigation could include flags not in
   * executive_summary or red_flag_assessment. Consumers must not
   * assume subset / superset relationships between slot scopes.
   */
  readonly mitigationSuggestionsConsumedFlagPrincipleIds: readonly string[];

  /**
   * Principle ids of the fired flags that survived the format-flags
   * filter for the **committee_recommendation** injection point
   * (Phase 4 addition; NARRATIVE_ENGINE_VERSION '1.3'). Fourth and
   * final sibling consumed-IDs field — closes the 4-slot set per
   * v20 D5 shipping order. Sorted ascending. Empty array is valid.
   *
   * Same no-cross-slot-guarantee discipline as the prior consumed-
   * IDs fields: NO subset / superset relationship asserted; each
   * principle declares its own injectionPoints.
   */
  readonly committeeRecommendationConsumedFlagPrincipleIds: readonly string[];

  /**
   * LLM-produced executive-summary prose. Phase 1 survivor; the
   * first injection-point slot. Sibling slot prose lives in
   * `redFlagAssessment` (Phase 2), `mitigationSuggestions` (Phase 3),
   * and `committeeRecommendation` (Phase 4). With Phase 4 the slot
   * set is complete — all 4 InjectionPoints have producers.
   *
   * Always present (non-nullable). If the LLM returns an empty
   * response the producer throws — empty prose is a producer bug,
   * not a valid state.
   */
  readonly executiveSummary: string;

  /**
   * LLM-produced red-flag-assessment prose (Phase 2 addition;
   * NARRATIVE_ENGINE_VERSION '1.1'). Mirrors `executiveSummary`
   * shape; required, non-nullable. Producer throws on empty LLM
   * response.
   *
   * Composed by `buildRedFlagAssessment` from the same HE flags
   * filtered to InjectionPoint='red_flag_assessment'. Slot
   * independence (Q-S4 (f.1)): if any slot's LLM call fails,
   * `buildNarrative` throws and the record is not persisted; v23
   * idempotency-via-content-hash semantics handle retries.
   */
  readonly redFlagAssessment: string;

  /**
   * LLM-produced mitigation-suggestions prose (Phase 3 addition;
   * NARRATIVE_ENGINE_VERSION '1.2'). Mirrors prior slot shapes;
   * required, non-nullable. Producer throws on empty LLM response.
   *
   * Composed by `buildMitigationSuggestions` from the same HE
   * flags filtered to InjectionPoint='mitigation_suggestions'.
   * Intent differs from prior slots: each bullet pairs a fired
   * flag with a concrete recommended action (escrow, reserve,
   * covenant, structure adjustment). The prompt template is the
   * design surface for that intent.
   */
  readonly mitigationSuggestions: string;

  /**
   * LLM-produced committee-recommendation prose (Phase 4 addition;
   * NARRATIVE_ENGINE_VERSION '1.3'). Final slot in the v20 D5
   * shipping order. Mirrors prior slot shapes; required, non-
   * nullable. Producer throws on empty LLM response.
   *
   * Composed by `buildCommitteeRecommendation` from HE flags
   * filtered to InjectionPoint='committee_recommendation'. Intent
   * differs from the prior 3 slots: synthesizes the deal-level
   * recommendation (approve / conditional approve / reject) with
   * the conditions inline. Structural form likely a synthesized
   * paragraph rather than a bulleted list — this is the slot the
   * committee reads last and acts on.
   */
  readonly committeeRecommendation: string;
}
