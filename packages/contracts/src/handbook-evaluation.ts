/**
 * HandbookEvaluation — engine output record (issue #31, Commit 1 of the
 * engine-invocation integration).
 *
 * Parallel "handbook says" annotation produced by running
 * @cre/handbook-engine against AdjustedInputs (via the field-bag
 * assembler from commit 0eddc80). Persisted as a sibling to the
 * doctrine-rooted HydratedRecordGraph (not in the bundle) to avoid
 * disturbing the Batch 6.5 HY1 single-hop invariant.
 *
 * Two design decisions documented here:
 *
 *   1. Engine output is NOT input to doctrine scoring in v1. The flags
 *      live alongside DoctrineEvaluation in the analysis surface but
 *      don't feed back into doctrine components. This is the Q3
 *      decision from the field-bag assembler design session.
 *
 *   2. The persisted shape mirrors @cre/handbook-engine's FiredFlag and
 *      SkippedPrinciple types exactly (which are re-exported from this
 *      module). Single source of truth, no drift risk across packages.
 *
 * The record FKs only to AdjustedInputs. It does NOT FK to
 * DoctrineEvaluation despite both being parallel outputs — the
 * dependency relationship is "evaluation depends on inputs," not "one
 * sibling depends on the other." Same architectural shape as if we had
 * two independent analyses of the same AdjustedInputs.
 */

import type { AdjustedInputsId, HandbookEvaluationId } from './identity.js';
import type {
  HandbookEngineVersion,
  ISODateTime,
} from './versioning.js';
import type { Severity, InjectionPoint } from './handbook.js';

// =============================================================================
// Engine-output types (formerly in @cre/handbook-engine/src/types.ts)
//
// These types are now sourced from this contract module. The engine
// imports them back via `import type { FiredFlag, ... } from '@cre/contracts'`.
// Persistence consumers (this record, the field-bag assembler, the api
// render layer) reference these same types directly.
// =============================================================================

export const SKIP_REASONS = [
  'trigger_inactive',
  'not_deterministic',
  'no_check_defined',
  'missing_field',
  'no_band_matched',
  'no_group_matched',
  'degenerate_evaluation',
  // LLM_CONTEXT path (Phase 2 of the LLM evaluator). Emitted when the LLM
  // call fails to return parseable structured output even after one retry.
  // Distinct from missing_field (no data) and not_deterministic (no path
  // wired) — this means the path WAS wired and the LLM call attempted.
  'llm_eval_failed',
  // LLM_CONTEXT path — Manual-input layer. Emitted when a principle
  // TRIGGERED and is otherwise healthy, but cannot conclude without an
  // analyst-supplied input it has correctly declined to fabricate
  // (e.g. market rent comps for Rule B / P-IV-OFF-10). Distinct from
  // 'missing_field' (deterministic data gap — input is supposed to come
  // from extraction but didn't) and 'no_band_matched' (concluded "no
  // flag warranted"). The principle's `manualInputRequests` payload on
  // the SkippedPrinciple record carries the structured request shape.
  'needs_manual_input',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Structured analyst-input request attached to a SkippedPrinciple with
 * reason 'needs_manual_input'. Each entry names a specific input the
 * principle needs to conclude. Free-form `detail` text supplements the
 * structured `kind` for analyst-facing display.
 */
export interface ManualInputRequest {
  readonly kind: string;       // e.g. 'market_rent_comp', 'sales_comp', 'sponsor_lookup'
  readonly detail: string;     // analyst-facing description ("per-tenant market PSF for above-market tenants")
}

/**
 * One analyst-supplied market rent comp. Sits in the manual-input layer
 * (analyst-entered, never extracted from ASR/seller UW). Consumed by
 * Office Rule B (P-IV-OFF-10) and any future principle that requires
 * per-tenant or asset-wide market rent for above-market underwriting.
 */
export interface MarketRentComp {
  /** Tenant id, space label, or 'asset-wide' for a blended figure. */
  readonly tenantOrSpace: string;
  /** Market rent in dollars per square foot per year. */
  readonly psf: number;
  /** Optional provenance note (broker, CoStar, etc.). */
  readonly source?: string;
  /** Optional ISO date the comp was sourced. */
  readonly asOfDate?: string;
}

/**
 * Manual-input bundle — analyst-supplied data that the extraction layer
 * does NOT produce (comps, manual research, etc.). Threaded through the
 * ingest/eval entry points as an optional dep. When present, the per-
 * principle LLM context includes it; principles that require this kind
 * of input reach a fired conclusion instead of needs_manual_input.
 *
 * Extensible — add new fields here (salesComps, submarketVacancy,
 * sponsorLookup, etc.) as principles get authored that need them.
 */
export interface ManualInputs {
  readonly marketRentComps?: ReadonlyArray<MarketRentComp>;
}

// `Severity` and `InjectionPoint` come from the handbook contract module
// (handbook.ts), where they were originally defined as part of the
// Principle metadata. Re-exported here so engine-output consumers can
// import all related types from this one module.
export type { Severity, InjectionPoint };

/**
 * A FieldValue from the field bag — the engine's allowed payload types.
 * Mirrors @cre/handbook-engine's FieldValue exactly.
 *
 * `undefined` is the canonical "field absent" signal. In persisted form
 * (JSON canonicalization), undefined keys are dropped, so a bag snapshot
 * with 17 undefined entries serializes as 14 populated keys.
 */
export type FieldValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | null
  | undefined;

export type FieldBag = Readonly<Record<string, FieldValue>>;

/**
 * A single fired flag — emitted when a principle's deterministic check
 * fires for a given deal context. Carries enough context for the LLM
 * (or a human reviewer) to reconstruct what fired and why.
 *
 * Field-by-field rationale for what's preserved:
 *
 *   - `metricValue`: the resolved metric at firing time. Lets the LLM
 *     cite specifics ("debt yield is 12%") without re-resolving the
 *     bag. Also useful for the admin UI's "why this flag?" surface.
 *
 *   - `groupIndex`: which evaluationGroup matched. Critical for
 *     diagnosing nested-exception cases like P-IV-RET-5 (fortress
 *     Class A) where multiple groups apply different bands.
 *
 *   - `injectionPoints`: which LLM-prompt sections this flag should
 *     inject into. The bridge to the future LLM-context integration
 *     (Commit 4 of the engine-invocation work).
 */
export interface FiredFlag {
  readonly principleId: string;
  readonly severity: Severity;
  readonly flag_message: string;
  readonly metricValue: FieldValue;
  readonly groupIndex: number;
  readonly bandIndex: number;
  readonly injectionPoints: ReadonlyArray<InjectionPoint>;
}

/**
 * A principle that didn't fire — either trigger was false, deterministic
 * execution mode wasn't selected, the field bag was missing required
 * data, or no band matched. Kept as a distinct shape (not just absence)
 * so downstream consumers can distinguish "principle was checked and
 * clean" from "principle was checked and skipped because data was
 * missing."
 */
export interface SkippedPrinciple {
  readonly principleId: string;
  readonly reason: SkipReason;
  /**
   * Best-effort diagnostic detail. For reason 'missing_field', this is
   * the missing field path (e.g., "metric field 'msa'"). Consumers
   * should not parse this as structured data — it's free-form text for
   * humans and LLMs to read.
   */
  readonly detail?: string;
  /**
   * Structured analyst-input requests. Present only when
   * `reason === 'needs_manual_input'`. Each entry names a specific
   * input the principle needs to conclude. Analyst-input UIs read this
   * shape directly; the `detail` string is the prose summary for LLM
   * narrative consumption.
   */
  readonly manualInputRequests?: ReadonlyArray<ManualInputRequest>;
}

// =============================================================================
// HandbookEvaluation — the persisted record
// =============================================================================

export interface HandbookEvaluation {
  readonly id: HandbookEvaluationId;
  readonly analysisAsOfDate: ISODateTime;
  readonly adjustedInputsId: AdjustedInputsId;

  /**
   * The handbook's `version` field (e.g., "2026.1"). Mirrors the
   * Handbook root's version property. Lets historical evaluations stay
   * anchored to the handbook revision they were produced against; re-
   * evaluation against a newer handbook produces a new
   * HandbookEvaluation record rather than mutating the old one.
   */
  readonly handbookVersion: string;

  /**
   * Branded engine version. Bumps when engine semantics change (e.g.,
   * fixed a FormulaNode bug, added a new operator). Distinct from
   * handbookVersion — engine version = how we evaluated; handbook
   * version = what we evaluated against.
   *
   * For v1, sourced as a hardcoded constant (HANDBOOK_ENGINE_VERSION)
   * from the engine package. Pattern matches StressEngineVersion.
   */
  readonly engineVersion: HandbookEngineVersion;

  /**
   * Flags fired by the engine. Each carries enough context for the LLM
   * to cite specifics and for the admin UI to reconstruct the firing
   * path (which group matched, which band).
   */
  readonly firedFlags: readonly FiredFlag[];

  /**
   * Principles that didn't fire, with diagnostic reasons. The 'reason'
   * field is the primary signal: 'missing_field' surfaces data gaps,
   * 'trigger_inactive' confirms a principle didn't apply, etc.
   *
   * Volume-wise this dominates the record — typically 80+ skips per
   * deal (only a handful of principles apply to any given asset type
   * AND have populated input data). That's fine; storage is cheap and
   * the skips are diagnostic gold.
   */
  readonly skippedPrinciples: readonly SkippedPrinciple[];

  /**
   * What the field-bag assembler produced for this evaluation. Self-
   * describing — lets the admin UI and audit consumers reconstruct
   * "what did the engine see?" without re-running the assembler.
   *
   * After JSON canonicalization, undefined keys are dropped, so this
   * stores only the keys with non-undefined values (14 of 31 in v1).
   * Array values (per-period arrays, when those land) preserve order
   * via JCS array semantics.
   */
  readonly fieldBagSnapshot: FieldBag;
}
