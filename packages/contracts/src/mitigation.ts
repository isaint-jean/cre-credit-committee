/**
 * Mitigations doctrine v1 — spine-side `MitigationProposal` contract.
 *
 * Sibling graph record produced between HandbookEvaluation and NarrativeEvaluation
 * by a future mitigation engine. v1 supports two levers (see doctrine doc):
 *
 *   reduce_proceeds  — `recalc_delta`     (apply L' to a uwModel clone, recalc, diff)
 *   fund_reserve     — `coverage_reserve` (dollars-funded + coverage statement)
 *
 * The lever set is intentionally narrow in v1 so the toolkit doesn't read as one
 * trick. Extensible: add literals here, doctrine table, and renderer arm in lockstep.
 *
 * v1 contract notes:
 *   - `requiredEquity` is set for reduce_proceeds; `requiredReserve` for fund_reserve
 *     (mutually exclusive in v1).
 *   - `recalcBefore/After` set for `recalc_delta` levers; absent for `coverage_reserve`
 *     because reserves don't move concluded-cap metrics (they pre-fund a future cost).
 *   - `targetMetric` names the binding constraint when multiple coverage flags fire.
 *   - `coverageStatement` is the human-readable explanation for reserve-shaped levers.
 *   - `principleIds` may carry several entries when one proposal addresses multiple
 *     fired flags (deduplicated to the binding constraint per the doctrine).
 *
 * This commit (1 of 2) ships the contract only. No producer. No record-graph store
 * write-path. No MITIGATION_ENGINE_VERSION / MITIGATION_ENGINE_MANIFEST yet.
 * RenderedAnalysis surfaces an empty `mitigations` array by default; the UI section
 * is hidden when empty.
 */

import type {
  AdjustedInputsId,
  HandbookEvaluationId,
  MitigationProposalSetId,
} from './identity.js';
import type { Severity } from './handbook.js';

export const MITIGATION_LEVERS = ['reduce_proceeds', 'fund_reserve'] as const;
export type MitigationLever = (typeof MITIGATION_LEVERS)[number];

export const LEVER_KINDS = ['recalc_delta', 'coverage_reserve'] as const;
export type LeverKind = (typeof LEVER_KINDS)[number];

export const RISK_REDUCTIONS = ['significant', 'moderate', 'marginal'] as const;
export type RiskReduction = (typeof RISK_REDUCTIONS)[number];

export const MITIGATION_TARGET_METRICS = ['dscr', 'debtYield', 'ltv'] as const;
export type MitigationTargetMetric = (typeof MITIGATION_TARGET_METRICS)[number];

/**
 * Pre/post snapshot of the four metrics a counterfactual recalc moves. All four
 * are nullable to preserve "null in → null out" semantics from
 * recalculateFullModel (e.g., DSCR is null when debt service is uncomputable).
 */
export interface RecalcSnapshot {
  readonly dscr:          number | null;
  readonly ltv:           number | null;
  readonly debtYield:     number | null;
  readonly impliedValue:  number | null;
}

/**
 * One mitigation proposal — a structuring lever a B-piece buyer would use,
 * sized against the firing band's metricValue, applied to a clone of the
 * concluded model when `leverKind === 'recalc_delta'`, and reported with
 * before/after numbers (or a coverage statement for reserves).
 */
export interface MitigationProposal {
  /** Stable within-set id (e.g., 'reduce_proceeds_dscr', 'tilc_reserve_office').
   *  Not a content hash — set ids are content-hashed at the set level. */
  readonly id: string;
  /** Fired-flag principleIds this proposal addresses (deduped). May be >1 when
   *  the lever is sized to the binding constraint among multiple coverage flags. */
  readonly principleIds: readonly string[];
  readonly lever: MitigationLever;
  readonly leverKind: LeverKind;
  readonly title: string;
  readonly description: string;
  /** Human-readable deal terms (e.g., "Reduce loan from $82.5M to $79.5M",
   *  "Escrow $1.4M TI/LC reserve at closing"). One entry per lever side-effect. */
  readonly structuralChanges: readonly string[];
  /** reduce_proceeds: the proceeds cut the sponsor must fill. */
  readonly requiredEquity?: number;
  /** fund_reserve: the upfront escrow size. */
  readonly requiredReserve?: number;
  /** recalc_delta levers: concluded-model metrics before the lever is applied. */
  readonly recalcBefore?: RecalcSnapshot;
  /** recalc_delta levers: concluded-model metrics after the lever is applied. */
  readonly recalcAfter?: RecalcSnapshot;
  /** The binding constraint when multiple coverage flags fire. */
  readonly targetMetric?: MitigationTargetMetric;
  /** coverage_reserve: free-form one-liner explaining what the reserve covers. */
  readonly coverageStatement?: string;
  readonly riskReduction: RiskReduction;
  readonly severity: Severity;
  /** Trace back to the firing band (per-principle deterministicCheck.bands[] index). */
  readonly bandIndex?: number;
}

/**
 * Persisted sibling graph record. Content-hashed over
 * (adjustedInputsId, handbookEvaluationId, proposals[]).
 */
export interface MitigationProposalSet {
  readonly id: MitigationProposalSetId;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly handbookEvaluationId: HandbookEvaluationId;
  readonly proposals: readonly MitigationProposal[];
}
