/**
 * NarrativeEvaluation — LLM-produced narrative output record (Piece A
 * Phase 1, batch 1). Sibling to HandbookEvaluation.
 *
 * SPEC anchor: docs/specs/uw-template-populator/SPEC.md §14.4 (v17 through
 * v23 amendment chain). Phase 1 ships the executive_summary survivor only;
 * additional injection-point slots land in subsequent Phase 1 sub-batches
 * via MINOR version bump (NARRATIVE_ENGINE_VERSION '1.0' → '1.1' …).
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
   * filter for the executive_summary injection point and were
   * therefore embedded in the producer's prompt. Sorted ascending for
   * canonicalization stability — replay can recompute this list from
   * the handbook evaluation and verify equality without rerunning the
   * LLM.
   *
   * Empty array is valid (no flags fire on executive_summary → the
   * producer composes a no-flags narrative, which is still useful
   * prose).
   */
  readonly consumedFlagPrincipleIds: readonly string[];

  /**
   * LLM-produced executive-summary prose. Phase 1 survivor; the only
   * injection-point slot in batch 1. Additional slots (red_flag_
   * assessment, mitigation_suggestions, committee_recommendation)
   * land as sibling fields in later Phase 1 sub-batches via MINOR
   * engine version bump.
   *
   * Always present (non-nullable). If the LLM returns an empty
   * response the producer throws — empty prose is a producer bug,
   * not a valid state.
   */
  readonly executiveSummary: string;
}
