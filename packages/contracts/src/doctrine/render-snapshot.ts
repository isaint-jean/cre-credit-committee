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
 * Hash boundary (locked):
 *   `id` = SHA-256(JCS(`DoctrineRenderSnapshotHashInput`)) — STRICT SUBSET of
 *   the record's fields. `capturedAt` is STAMPED on the row but NOT in the
 *   hash; same render state captured at two different wall-clock times is the
 *   SAME logical snapshot with the SAME id (true content-addressing — mirrors
 *   the RevisionLineageEnvelope §5 hash-boundary pattern). The snapshot's
 *   identity is therefore a function of doctrine state, not capture timing.
 *
 *   NOT referenced by any other record's hash boundary — adding / updating /
 *   removing a snapshot does not perturb any other record's identity.
 */

import type {
  DoctrineEvaluationId,
  DoctrineRenderSnapshotId,
} from '../identity.js';
import type { ISODateTime } from '../versioning.js';
import type { MitigationProposal } from '../mitigation.js';
import type {
  ExternalFinding,
  ExternalRenderDecision,
} from '../external-finding.js';

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
export const SNAPSHOT_PRODUCER_VERSION = '1.2' as const;
/**
 * Snapshot producer version union — extend (don't replace) when bumping
 * `SNAPSHOT_PRODUCER_VERSION` so readers can carry historical version
 * support. Bump history:
 *   1.0 — initial release (PR i): rating, dimOutputs, authoritativeNumbers,
 *         composedMitigationPackage.
 *   1.1 — adds optional `noiBasis` field (judgmentNoi + contractedNoi for
 *         the NOI-basis disclosure callout). Reader treats a 1.0 snapshot
 *         as "no noiBasis field" → callout falls back to deterministic
 *         recompute. Forward-only: new evals stamp 1.1; existing 1.0
 *         snapshots stay valid + readable for their original fields.
 *   1.2 — adds optional `externalDD` field: the guard-approved external
 *         due-diligence findings frozen at mint (rendered ExternalFinding
 *         objects + render decisions + sources + retrievedAt +
 *         no_findings_surfaced status + per-lane searchability subjects),
 *         pinned to a frozen fetch timestamp and the analysis as-of date.
 *         Reader treats a <1.2 snapshot as "no externalDD field" → the
 *         external-DD block falls back to honest-blank (searched-nothing-
 *         surfaced is NOT the same as never-searched). Forward-only: new evals
 *         stamp 1.2; existing 1.0/1.1 snapshots stay valid + readable for their
 *         original fields. (The externalDD sub-shape was refined — adding the
 *         per-lane `personSubject`/`marketSubject` keys — while landing the
 *         first real producer; safe without a version bump because no snapshot
 *         had ever been persisted WITH the field emitted, so no reader can
 *         observe the earlier sub-shape.)
 */
export type SnapshotProducerVersion = '1.0' | '1.1' | '1.2';

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
 * NOI-basis disclosure facts (v1.1+). Captured so the memo + workbook can
 * surface a callout when the workbook NOI (judgment-engine basis) and the
 * verdict NOI (contracted-basis on lease-up deals) diverge. Both values are
 * load-bearing for the disclosure; `contractedNoi` is null when the
 * lease-up predicate didn't fire (stabilized deals — no divergence, no
 * callout).
 *
 * Wording reason — neutral, both bases defensible. The callout shouldn't
 * editorialize which basis is "right"; the difference is documented as a
 * methodological choice (other-income handling: contracted treats it as a
 * pass-through net of vacancy/expense; judgment scales it through
 * vacancy + expense as part of the income line).
 *
 * @stamp v1.1 (extended snapshot shape).
 */
export interface SnapshotNoiBasis {
  /** Workbook NOI = `AdjustedInputs.metrics.noi` (judgment-engine basis). */
  readonly judgmentNoi: number | null;
  /** Verdict NOI = `contracted-basis` pipeline. Null when predicate=false (stabilized deals). */
  readonly contractedNoi: number | null;
  /**
   * One-line neutral reason. Today always the same OI-handling sentence; the
   * field is here so future bases can declare their own reason.
   */
  readonly divergenceReason: string;
}

/**
 * A single guard-approved external-DD finding, frozen at mint (v1.2+).
 *
 * Carries the FULL `ExternalFinding` (subject, claim as reported speech,
 * claimKind, verificationTier, sentiment, sources, retrievedAt), the pure
 * defamation-guard `decision`, and the `rendered` string the memo would show
 * (`null` when the decision suppresses/blanks). The renderer reads `rendered`
 * verbatim — it does NOT re-run the guard at render time, so the minted memo
 * is pin-faithful to the guard logic in force AT MINT.
 *
 * Storing the finding + decision + rendered together (not just the string)
 * keeps the snapshot auditable: a reviewer can see WHY a claim rendered or was
 * suppressed without re-deriving it.
 */
export interface SnapshotExternalFinding {
  readonly finding: ExternalFinding;
  readonly decision: ExternalRenderDecision;
  /** The memo-ready text, or `null` when the guard suppressed/blanked the claim. */
  readonly rendered: string | null;
}

/**
 * External due-diligence snapshot (v1.2+). The guard-approved findings frozen
 * at mint so a DD finding is reproducible: same subject + as-of date → the
 * SAME rendered DD across re-renders, and a later change to the live web does
 * NOT move the minted finding.
 *
 * `status`:
 *   - `'findings'`             — one or more guard-approved findings surfaced.
 *   - `'no_findings_surfaced'` — searched, nothing survived the guard. This is
 *     an HONEST NULL, not a clean bill of health; the reader must render it as
 *     "searched — nothing surfaced", never as "no issues".
 *
 * `retrievedAt` pins the frozen fetch timestamp the findings were built over
 * (matches the fetch-cache row's `retrieved_at`). `analysisAsOfDate` pins the
 * deal's as-of date so the DD is reproducible against a fixed point in time,
 * independent of when the memo is re-rendered.
 *
 * PER-LANE SEARCHABILITY (`personSubject` / `marketSubject`) — load-bearing for
 * the memo's honesty. The two DD lanes have INDEPENDENT subject keys: §4 Sponsor
 * searches a sponsor/borrower NAME; §6 Market searches a property ADDRESS/market.
 * A deal can be searchable in one lane and not the other (e.g. an address but no
 * sponsor name). Each field is the subject actually searched, or `null` when that
 * lane had NO subject key (could-not-search). The renderer MUST keep three states
 * distinct and never collapse them:
 *   (a) FINDINGS          — the lane's subject is non-null AND findings surfaced.
 *   (b) SEARCHED-EMPTY    — the lane's subject is non-null but no finding surfaced
 *       ('no_findings_surfaced for this lane'): "searched, nothing specific" —
 *       NOT a clean bill of health.
 *   (c) COULD-NOT-SEARCH  — the lane's subject is `null`: fall back to the memo's
 *       existing "cannot assess because X is missing" honest-blank.
 * "We looked and found nothing" (b) ≠ "we couldn't look" (c).
 */
export interface SnapshotExternalDD {
  readonly status: 'findings' | 'no_findings_surfaced';
  /** Guard-approved findings (may be empty even when searched — see `status`). */
  readonly findings: readonly SnapshotExternalFinding[];
  /** Frozen fetch timestamp the findings are pinned to (matches the fetch-cache row). */
  readonly retrievedAt: ISODateTime;
  /** The deal's as-of date — the fixed point the DD is reproducible against. */
  readonly analysisAsOfDate: ISODateTime;
  /**
   * §4 lane: the sponsor/borrower subject actually searched, or `null` when no
   * sponsor/borrower name was available (could-not-search → §4 honest-blank).
   */
  readonly personSubject: string | null;
  /**
   * §6 lane: the property market/area subject actually searched, or `null` when
   * no address/market was available (could-not-search → §6 honest-blank).
   */
  readonly marketSubject: string | null;
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

/**
 * `DoctrineRenderSnapshotHashInput` — the EXACT subset of `DoctrineRenderSnapshot`
 * fields that participate in the id hash. PR (ii) hash-boundary lock.
 *
 * Excluded from the hash (stamped, not hashed):
 *   - `id` (the hash itself)
 *   - `capturedAt` (wall-clock; same render state captured at different times
 *     must yield the same id — true content-addressing)
 *
 * Two independent implementations MUST produce byte-identical SHA-256 over the
 * JCS canonicalization of this struct. Bumping `SNAPSHOT_PRODUCER_VERSION`
 * widens the hash boundary if new fields are added — readers handle the
 * version drift; never silently change the boundary at v1.0.
 */
export interface DoctrineRenderSnapshotHashInput {
  readonly doctrineEvaluationId: DoctrineEvaluationId;
  readonly snapshotProducerVersion: SnapshotProducerVersion;
  readonly rating: SnapshotRating;
  readonly dimOutputs: Readonly<Record<string, SnapshotDimOutput>>;
  readonly authoritativeNumbers: SnapshotAuthoritativeNumbers;
  readonly composedMitigationPackage: SnapshotComposedMitigationPackage;
  /**
   * v1.1+ — NOI-basis disclosure facts. Optional in the hash boundary so
   * 1.0 snapshots' hash inputs don't include this field (preserves 1.0 id
   * determinism). Producers writing at 1.1+ MUST emit this; the boot check
   * and reader gate on `snapshotProducerVersion` accordingly.
   */
  readonly noiBasis?: SnapshotNoiBasis;
  /**
   * v1.2+ — external due-diligence findings frozen at mint. Optional in the
   * hash boundary so 1.0/1.1 snapshots' hash inputs don't include this field
   * (preserves their id determinism). Producers writing at 1.2+ MUST emit this
   * when DD ran; the boot check and reader gate on `snapshotProducerVersion`.
   */
  readonly externalDD?: SnapshotExternalDD;
}

export interface DoctrineRenderSnapshot {
  /** Identity. SHA-256(JCS(`DoctrineRenderSnapshotHashInput`)). */
  readonly id: DoctrineRenderSnapshotId;

  /** FK to the doctrine eval this snapshot describes. One snapshot per eval. */
  readonly doctrineEvaluationId: DoctrineEvaluationId;

  /**
   * Snapshot shape version. Reader rejects unknown versions and falls back to
   * recompute. See `SNAPSHOT_PRODUCER_VERSION` bump rules.
   */
  readonly snapshotProducerVersion: SnapshotProducerVersion;

  /**
   * Wall-clock timestamp at snapshot-write time. STAMPED ONLY — NOT in the
   * hash boundary. Recorded for audit / replay reasoning ("when did this
   * memo's pinned outputs get captured?"). Re-running the producer over the
   * same render state at a later time would yield the same `id` and a new
   * `capturedAt`; the `ON CONFLICT(doctrine_evaluation_id) DO NOTHING`
   * constraint on the row makes the first write win.
   */
  readonly capturedAt: ISODateTime;

  /* --- captured outputs (mirror DoctrineRenderSnapshotHashInput) --- */

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

  /**
   * NOI-basis disclosure facts (v1.1+). Absent on 1.0 snapshots. Reader
   * checks `snapshotProducerVersion` before consuming.
   */
  readonly noiBasis?: SnapshotNoiBasis;

  /**
   * External due-diligence findings frozen at mint (v1.2+). Absent on
   * 1.0/1.1 snapshots. Reader checks `snapshotProducerVersion` before
   * consuming and falls back to honest-blank when absent.
   */
  readonly externalDD?: SnapshotExternalDD;
}

/**
 * Extract the hash-input subset from a full snapshot record. Single source of
 * truth for the §HashBoundary subset — producers AND verifiers call this so
 * the boundary can't drift between writer + reader.
 */
export function extractDoctrineRenderSnapshotHashInput(
  s: Pick<DoctrineRenderSnapshot,
    | 'doctrineEvaluationId'
    | 'snapshotProducerVersion'
    | 'rating'
    | 'dimOutputs'
    | 'authoritativeNumbers'
    | 'composedMitigationPackage'> & {
    readonly noiBasis?: SnapshotNoiBasis;
    readonly externalDD?: SnapshotExternalDD;
  },
): DoctrineRenderSnapshotHashInput {
  let hashInput: DoctrineRenderSnapshotHashInput = {
    doctrineEvaluationId:    s.doctrineEvaluationId,
    snapshotProducerVersion: s.snapshotProducerVersion,
    rating:                  s.rating,
    dimOutputs:              s.dimOutputs,
    authoritativeNumbers:    s.authoritativeNumbers,
    composedMitigationPackage: s.composedMitigationPackage,
  };
  // v1.1+: include noiBasis when present. Producers at 1.1 must emit it;
  // 1.0 inputs omit the field entirely so historical 1.0 ids stay stable.
  if (s.noiBasis !== undefined) {
    hashInput = { ...hashInput, noiBasis: s.noiBasis };
  }
  // v1.2+: include externalDD when present. 1.0/1.1 inputs omit it so their
  // historical ids stay stable.
  if (s.externalDD !== undefined) {
    hashInput = { ...hashInput, externalDD: s.externalDD };
  }
  return hashInput;
}
