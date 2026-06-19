/**
 * DoctrineRenderSnapshot — sibling record carrying the projected, version-pinned
 * outputs the memo renderer + analysis-page projection need.
 *
 * Lives ALONGSIDE DoctrineEvaluation, keyed by `doctrineEvaluationId`. One snapshot
 * per eval. It is NOT referenced by DoctrineEvaluation or any envelope — adding the
 * snapshot record DOES NOT re-key any existing eval id or envelope id (it sits
 * outside the DoctrineEvaluation hash boundary, same sibling pattern as
 * `RevisionProvenance` vs `RevisionLineageEnvelope`).
 *
 * Why this exists:
 *   The renderer used to recompute `dealResult` + `composedMitigationPackage`
 *   from raw inputs at render time, then project the authoritative-numbers block
 *   from them. Under that pattern a deal pinned at doctrine 1.3 would render with
 *   HEAD's 1.5 doctrine outputs — silently misrepresenting the pin, and producing
 *   memos whose table cells (recompute) disagreed with their narrative prose
 *   (generated at the pinned doctrine).
 *
 *   The snapshot is captured at eval-write time and stores everything the view
 *   layer needs verbatim: the rating axis, per-dim derived outputs, the projected
 *   AUTHORITATIVE NUMBERS block, and the composed mitigation package. The renderer
 *   reads instead of recomputes — pin-faithful by construction.
 *
 * Forward-only:
 *   The producer fires inside `evaluate-and-narrate.ts` immediately after the
 *   doctrine eval is bridged. Existing evals (rows persisted before this contract
 *   landed) have NO snapshot row. The reader (PR ii) treats missing snapshots as
 *   "fall back to recompute + flag the memo as not pin-faithful" — the renderer
 *   degrades gracefully.
 *
 * Hash boundary:
 *   `id` = SHA-256(JCS(snapshot body — every field except `id`)). The snapshot's
 *   own hash. NOT referenced by any other record's hash boundary. Adding /
 *   updating / removing a snapshot does not perturb any other record's identity.
 */

import type {
  DoctrineEvaluationId,
  DoctrineRenderSnapshotId,
} from '../identity.js';
import type { ISODateTime } from '../versioning.js';
import type { MitigationProposal } from '../mitigation.js';

/**
 * Snapshot producer version. Bump when the snapshot SHAPE changes (e.g., adding
 * a new top-level field). Readers should reject snapshots whose
 * `snapshotProducerVersion` they don't recognize and fall back to recompute.
 *
 * Bump rules:
 *   MINOR (1.0 → 1.1): additive field, readers that know only 1.0 can ignore the
 *     new field and still produce a correct render.
 *   MAJOR (1.0 → 2.0): semantic change to an existing field, or a required new
 *     field. Readers MUST recognize the new version.
 *
 * The version is stamped on every snapshot row so a future reader can replay
 * historical snapshots correctly.
 */
export const SNAPSHOT_PRODUCER_VERSION = '1.0' as const;
export type SnapshotProducerVersion = typeof SNAPSHOT_PRODUCER_VERSION;

/* -------------------------------------------------------------------------- */
/* §1. Sub-shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Doctrine-clean recommendation literal. Mirrors `Recommendation` from
 * `apps/api/src/doctrine-clean/scoring/rating.ts` (kept here because contracts
 * cannot import from apps/api). If that producer-side union ever widens, bump
 * `SNAPSHOT_PRODUCER_VERSION` and extend this union in lock-step.
 */
export type SnapshotRecommendation =
  | 'Approve'
  | 'ApproveWithConditions'
  | 'Decline'
  | 'InsufficientData';

/**
 * Doctrine-clean rating band (NEW badness-scale). Mirrors `RatingBand` from
 * `apps/api/src/doctrine-clean/scoring/rating.ts`. Distinct from the OLD
 * goodness band table (`RATING_BANDS` in `components.ts`) — that one is keyed
 * off `finalScore` on the persisted DoctrineEvaluation and stays where it is.
 */
export type SnapshotRatingBand =
  | 'Strong'
  | 'Acceptable'
  | 'Watch'
  | 'Elevated'
  | 'Decline';

export interface SnapshotRating {
  readonly recommendation: SnapshotRecommendation;
  /** `null` only when `recommendation === 'InsufficientData'` (coverage-gate fired). */
  readonly band: SnapshotRatingBand | null;
  /** Post-sponsor-modifier risk in [0, 1]. `null` when InsufficientData. */
  readonly ratedRisk: number | null;
}

/**
 * Per-dim snapshot. Carries the tier, applicability, and the dim's full
 * `derivedOutputs` map. `derivedOutputs` is intentionally opaque — every dim
 * has its own keys (e.g., dim 7 has `stressedValue`/`stressedLtv`/
 * `valuationAggressiveness`, dim 4 has `exitDscr`). The reader knows which
 * keys to read for which surface. Preserving the map verbatim avoids dim-by-dim
 * mirroring in the contract.
 */
export interface SnapshotDimOutput {
  readonly tier: string;
  readonly applicability:
    | 'applicable'
    | 'not-applicable-by-asset-type'
    | 'hitl-needed';
  readonly derivedOutputs: Readonly<
    Record<string, number | string | null>
  >;
}

/**
 * Projected AUTHORITATIVE NUMBERS block — mirrors `AuthoritativeNumbers` from
 * `apps/api/src/services/narrative/prompt-templates.ts`. Captured verbatim so
 * the renderer's auth-block consumers (`buildCommitteeMemo`) can read instead
 * of re-projecting from dim outputs.
 *
 * Stamped at snapshot-write time; not recomputed. If `projectAuthoritativeNumbers`
 * gains a field later, bump `SNAPSHOT_PRODUCER_VERSION` and add it here too.
 */
export interface SnapshotAuthoritativeNumbers {
  readonly ratingRecommendation: string | null;
  readonly ratingBand: string | null;
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly originalLoanAmount: number | null;
  readonly finalLoanAmount: number | null;
  readonly proceedsReduction: number | null;
  readonly stressedValue: number | null;
  readonly stressedLtv: number | null;
  readonly stressedLtvAtFinalLoan: number | null;
  readonly ltvTrigger: number | null;
  readonly concludedValue: number | null;
  readonly concludedValueSource:
    | 'extracted-appraisal'
    | 'extracted-asr'
    | 'operator-supplied'
    | 'unspecified-source'
    | null;
  readonly valuationConfidenceNote: string | null;
  readonly exitDscrBaseline: number | null;
  readonly exitDscrAtFinalLoan: number | null;
  readonly exitDscrTrigger: number | null;
  readonly exitDscrCureTarget: number | null;
  readonly standaloneAmortPaydown: number | null;
  readonly composedAmortPaydown: number | null;
}

/**
 * Composed mitigation package snapshot.
 *
 * `proposals` and `initialProposals` use the contract-owned `MitigationProposal`
 * type. The aggregate sub-shapes (`reconciliation`, `sponsorBurdenProfile`,
 * `fundedExitProjection`) and `finalState` are preserved as opaque maps because
 * they're producer-owned (apps/api) types whose full shape mirroring would
 * inflate this contract without changing what gets stored. The snapshot persists
 * the in-memory shape verbatim; PR ii's reader casts back at the apps/api
 * boundary. Bump `SNAPSHOT_PRODUCER_VERSION` if any sub-shape semantics change.
 */
export interface SnapshotComposedMitigationPackage {
  readonly proposals: readonly MitigationProposal[];
  readonly initialProposals: readonly MitigationProposal[];
  readonly finalLoanAmount: number;
  readonly reconciliation: Readonly<Record<string, unknown>>;
  readonly sponsorBurdenProfile: Readonly<Record<string, unknown>>;
  readonly fundedExitProjection: Readonly<Record<string, unknown>>;
  /**
   * `finalState` carries `adjustedInputs` + `uwModel` + `dealResult` at L'. The
   * renderer reads dim outputs at L' (stressedLtv, exitDscr) off it; everything
   * else is preserved verbatim for future consumers.
   */
  readonly finalState: Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* §2. The snapshot record                                                    */
/* -------------------------------------------------------------------------- */

export interface DoctrineRenderSnapshot {
  /** Identity. SHA-256(JCS(body — every field except `id`)). */
  readonly id: DoctrineRenderSnapshotId;

  /** FK to the doctrine eval this snapshot describes. One snapshot per eval. */
  readonly doctrineEvaluationId: DoctrineEvaluationId;

  /**
   * Snapshot shape version. Reader rejects unknown versions and falls back to
   * recompute. See `SNAPSHOT_PRODUCER_VERSION` bump rules.
   */
  readonly snapshotProducerVersion: SnapshotProducerVersion;

  /**
   * Wall-clock timestamp at snapshot-write time. Recorded for audit / replay
   * reasoning ("when did this memo's pinned outputs get captured?"). Part of
   * the body, so changes to `capturedAt` change the snapshot id — this is
   * intentional, since the same eval re-snapshotted at a different time is a
   * distinguishable record. Producers should write only once per eval.
   */
  readonly capturedAt: ISODateTime;

  /* --- captured outputs --- */

  readonly rating: SnapshotRating;

  /**
   * Per-dim outputs keyed by `dimensionId` (e.g., 'leverage-ltv',
   * 'coverage-dscr', 'debt-yield', 'refinance-feasibility',
   * 'income-concentration', 'rollover', 'cap-rate-valuation-stress',
   * 'asset-class', 'sponsor-borrower-quality'). Reader reads the dims it needs.
   */
  readonly dimOutputs: Readonly<Record<string, SnapshotDimOutput>>;

  /** Pre-projected AUTHORITATIVE NUMBERS block — what the memo's auth section reads. */
  readonly authoritativeNumbers: SnapshotAuthoritativeNumbers;

  /** Composed mitigation package — what the restructuring/sponsor-burden sections read. */
  readonly composedMitigationPackage: SnapshotComposedMitigationPackage;
}
