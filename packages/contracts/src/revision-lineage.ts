/**
 * Revision lineage spec — canonical contract definition (pre-Batch-6.3).
 *
 * Source of truth for the spec: `docs/architecture/revision-lineage-spec.md`.
 *
 * This module is CONTRACT DEFINITION only — types + invariants + hash-boundary declarations.
 * Implementation (the actual hash function, the route handlers, the storage tables) lives in
 * `apps/api/` and lands in sub-batch 6.3.
 *
 * The lineage model is single-parent, append-only, content-addressed. Revisions are immutable
 * derivations; they are NEVER patches, mutations, or overwrites. See `docs/architecture/
 * revision-lineage-spec.md` for the full spec, hash-boundary table, and CI invariants.
 */

import type {
  AdjustedInputsId,
  ContentHash,
  DoctrineEvaluationId,
} from './identity.js';
import type {
  DoctrineVersion,
  JudgmentEngineVersion,
  StressEngineVersion,
  ValuationEngineVersion,
} from './versioning.js';
import type { JudgmentEngineRuleId } from './judgment-engine-rules.js';

/* -------------------------------------------------------------------------- */
/* §1. Core identities                                                        */
/* -------------------------------------------------------------------------- */

declare const __revisionId: unique symbol;

/**
 * `RevisionId` — immutable identity for a single revision in an analysis lineage.
 *
 * Computed deterministically via SHA-256 over the canonical-JSON of `RevisionIdHashInput`
 * (RFC 8785 / JCS). Identical hash inputs → identical id (lineage invariant L4).
 *
 * Branded over `ContentHash` so a raw string cannot stand in for a real revision id.
 */
export type RevisionId = ContentHash & { readonly [__revisionId]: 'RevisionId' };

/**
 * `AnalysisId` — the canonical analysis identity. Equal to the root revision's `RevisionId`.
 *
 * Type alias (not a distinct brand): every analysis IS its root revision. Subsequent revisions
 * inherit the same `lineageRootId` (= this `AnalysisId`).
 */
export type AnalysisId = RevisionId;

/**
 * `LineageRootId` — every revision in a lineage carries this; always equals the original
 * `AnalysisId` (lineage invariant L3 — never changes after creation).
 */
export type LineageRootId = AnalysisId;

/**
 * `ParentRevisionId` — pointer to the immediate parent revision. `null` ONLY for the root
 * revision (lineage invariant L1, single-parent topology rule §6).
 */
export type ParentRevisionId = RevisionId | null;

/* -------------------------------------------------------------------------- */
/* §5. Content-hash boundary — RevisionId hash input                          */
/* -------------------------------------------------------------------------- */

/**
 * The exact, exhaustive set of fields that participate in `RevisionId` computation.
 *
 * Two independent implementations MUST produce byte-identical `RevisionId` values when fed
 * byte-identical `RevisionIdHashInput` (the §5 hard requirement).
 *
 * **Included** (this interface):
 *   - `parentRevisionId` — lineage chain anchor; `null` for root.
 *   - `adjustedInputsId` — content-hash of the resulting AdjustedInputs. Encodes the delta
 *     from parent transitively (AdjustedInputs is itself content-addressed).
 *   - `doctrineVersion` — pins the doctrine engine identity for replay.
 *
 * **Excluded** (ANY OF THESE MUST NEVER appear in a RevisionId hash input):
 *   - timestamps (any form: createdAt, updatedAt, analysisAsOfDate, wall-clock)
 *   - logs / traces / diagnostics
 *   - UI-only fields (display names, labels, color hints)
 *   - runtime flags (feature toggles, debug switches)
 *   - ordering artifacts of non-semantic inputs
 *   - `RevisionProvenance` and any of its fields
 *   - ephemeral evaluation outputs (in-memory caches, validation pass-throughs)
 *
 * See `docs/architecture/revision-lineage-spec.md` §5 for the canonical boundary table.
 */
export interface RevisionIdHashInput {
  readonly parentRevisionId: ParentRevisionId;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly doctrineVersion: DoctrineVersion;
}

/* -------------------------------------------------------------------------- */
/* §2 + §6. Lineage envelope                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `RevisionLineageEnvelope` — the persisted, content-addressed identity record for a single
 * revision.
 *
 * The envelope is IMMUTABLE. Every field is `readonly`. Once written, no field is ever updated
 * in place (lineage invariants L1, L2, L3). Edits produce a new envelope (a new revision) with
 * a new `revisionId`; the parent's envelope stays intact.
 *
 * `revisionId` is computed from a strict subset of fields (`RevisionIdHashInput`). The other
 * fields on this envelope are STAMPED (recorded for audit / replay) but DO NOT participate in
 * the hash. The `RevisionLineageEnvelope` itself is therefore NOT just a content-hash record —
 * it's an envelope where one specific field IS the hash, and other fields exist alongside.
 *
 * Two envelopes with identical `revisionId` are guaranteed to be the same revision (by L4 +
 * §5 hash-boundary spec). The reverse is also true: identical state → identical id → identical
 * envelope (post-version-pinning).
 */
export interface RevisionLineageEnvelope {
  /** Identity. Computed from `RevisionIdHashInput`. */
  readonly revisionId: RevisionId;

  /** Original analysis id. Invariant across the entire lineage (L3). */
  readonly lineageRootId: LineageRootId;

  /** Single-parent pointer (§6 topology). `null` ONLY for the root revision. */
  readonly parentRevisionId: ParentRevisionId;

  /**
   * 0-based ordinal position within the lineage. `0` for the root. Strictly monotonic.
   * Stamped for ergonomics; NOT part of identity (computable by walking parent chain).
   */
  readonly revisionOrdinal: number;

  /** FK to the doctrine evaluation that represents this revision's analysis state. */
  readonly doctrineEvaluationId: DoctrineEvaluationId;

  /** FK to the AdjustedInputs that produced this revision's doctrine evaluation. */
  readonly adjustedInputsId: AdjustedInputsId;

  /** Engine versions in effect when this revision was produced. Stamped for replay. */
  readonly doctrineVersion: DoctrineVersion;
  readonly judgmentEngineVersion: JudgmentEngineVersion;
  readonly stressEngineVersion: StressEngineVersion;
  readonly valuationEngineVersion: ValuationEngineVersion;
}

/* -------------------------------------------------------------------------- */
/* §4. Replay provenance — observable only                                    */
/* -------------------------------------------------------------------------- */

/**
 * `RevisionTrigger` — the named source that produced a revision. Closed enum so trigger
 * conditions are statically inspectable; new trigger sources require an explicit literal addition.
 */
export const REVISION_TRIGGERS = [
  'USER_EDIT',
  'STRESS_ENGINE',
  'DOCTRINE_ADJUSTMENT',
  'SYSTEM_RECALC',
] as const;
export type RevisionTrigger = typeof REVISION_TRIGGERS[number];

/**
 * `AdjustedInputsFieldDiff` — a single semantic field-level change between parent and child
 * AdjustedInputs. Used to populate `RevisionProvenance.inputDiff` for observability.
 *
 * `path` is a dotted path through the AdjustedInputs tree (e.g.
 * `"income.vacancyPct.adjusted"`). `before` and `after` are the field values; `unknown`
 * because they can be `number | string | null | object` depending on the path.
 */
export interface AdjustedInputsFieldDiff {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changeType: 'added' | 'removed' | 'modified';
}

export interface AdjustedInputsDiff {
  readonly changedFields: readonly AdjustedInputsFieldDiff[];
}

/**
 * `RevisionProvenance` — observable-only metadata describing how this revision came to exist.
 *
 * **HARD INVARIANT:** Provenance MUST NEVER participate in identity hash generation. It is
 * recorded for audit and replay reasoning; it is not part of the revision's identity.
 * Two revisions with different provenance but identical `RevisionIdHashInput` MUST produce
 * the same `revisionId` (L4).
 *
 * Stored as a sibling record to `RevisionLineageEnvelope`, keyed by `revisionId` for FK lookup.
 * The split is intentional: the envelope is content-addressed (its identity is the hash of its
 * hash inputs); the provenance is keyed-not-hashed (its identity is the FK to the envelope).
 */
export interface RevisionProvenance {
  /** FK to the `RevisionLineageEnvelope` this provenance describes. */
  readonly revisionId: RevisionId;

  /** Structured semantic diff of AdjustedInputs (parent → this revision). */
  readonly inputDiff: AdjustedInputsDiff;

  /** Closed-enum trigger that initiated the revision. */
  readonly triggerSource: RevisionTrigger;

  /** Judgment-engine rule ids that fired during the revision's adjustment phase. */
  readonly appliedRuleIds: readonly JudgmentEngineRuleId[];

  /** Free-text origins of adjustments. Bounded usage — for narrative display, not parsing. */
  readonly adjustmentOrigin: readonly string[];

  /** Content hashes of AdjustedInputs — before (parent) and after (this revision). */
  readonly beforeHash: AdjustedInputsId;
  readonly afterHash: AdjustedInputsId;
}

/* -------------------------------------------------------------------------- */
/* §3. Lineage invariants — declarative form                                  */
/* -------------------------------------------------------------------------- */

/**
 * Six non-negotiable lineage invariants. Reproduced here as a const-asserted array so the spec
 * is statically inspectable from code (e.g., a CI invariant check could iterate this list).
 *
 * Source of truth: `docs/architecture/revision-lineage-spec.md` §3.
 */
export const LINEAGE_INVARIANTS = [
  'L1: append-only lineage graph',
  'L2: parentRevisionId never mutates after creation',
  'L3: lineageRootId never changes',
  'L4: identical (parent, AdjustedInputs delta, doctrineVersion) → identical revisionId',
  'L5: no timestamps participate in identity computation',
  'L6: ordering of non-semantic inputs MUST NOT affect identity',
] as const;
export type LineageInvariantId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/* -------------------------------------------------------------------------- */
/* §8. CI invariant summary — single-line enforceable rule                    */
/* -------------------------------------------------------------------------- */

/**
 * The one-line summary for CI tagging / commit hooks / PR review:
 *
 *   "lineage is append-only, deterministic, single-parent, content-addressed"
 */
export const REVISION_LINEAGE_INVARIANT_SUMMARY =
  'lineage is append-only, deterministic, single-parent, content-addressed' as const;
