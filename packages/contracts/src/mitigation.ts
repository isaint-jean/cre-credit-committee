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
import type { MitigationEngineVersion } from './versioning.js';

export const MITIGATION_LEVERS = [
  'reduce_proceeds',
  'fund_reserve',
  'require_amortization',
  'require_guaranty',
  'springing_cash_management',
  'in_place_cash_management',
  'condition_precedent',
  // v1.3 — structure-first mid-band levers. Fire ONLY when the doctrine
  // dimension breaches its trigger but stays within the desk's structured
  // band (LTV: trigger < stressedLtv ≤ ceiling; EXIT: floor ≤ exit < trigger).
  // They produce structural protections in lieu of a proceeds cut. See
  // produce-mitigations.ts header for the band-classification spec.
  'leverage_band_recourse',
  'cash_sweep_refi_reserve',
  'springing_dscr_recourse',
] as const;
export type MitigationLever = (typeof MITIGATION_LEVERS)[number];

/**
 * Lever kinds.
 *
 * v1 (emitted today): `recalc_delta` (apply L' to a uwModel clone, recalc, diff)
 *                     `coverage_reserve` (dollars-funded + coverage statement)
 *
 * Mitigant v2 phase 1 — DECLARED for phase 2 expansion; NO producer emits
 * these yet. The taxonomy is scaffolding for the structural-mitigation
 * catalogue that wires up to the clean doctrine's dimensions (refi 4,
 * concentration 5, cap-rate 7, asset-class 8, sponsor 9):
 *   - `amortization`            — re-amort to a shorter schedule (refi-feasibility lever)
 *   - `guaranty`                — full / limited / payment / burn-off / bad-boy (sponsor lever)
 *   - `springing_cash_management` — springing lockbox / sweep on trigger (refi + concentration)
 *   - `in_place_cash_management` — closing-date in-place lockbox (cap-rate aggression lever)
 *   - `condition_precedent`     — closing-conditional fix (e.g. tenant signed before close)
 *
 * Note: no `equity_requirement` here. The dim-7 "stressed value" insight is
 * folded into `reduce_proceeds` via the LTV-arm re-point (phase 1 part D),
 * not surfaced as a separate lever. This avoids splitting "reduce proceeds"
 * into two visually-similar levers; the binding-constraint logic naturally
 * selects the more-conservative L'.
 */
export const LEVER_KINDS = [
  'recalc_delta',
  'coverage_reserve',
  // Phase-2-pending — declared but no emitter today:
  'amortization',
  'guaranty',
  'springing_cash_management',
  'in_place_cash_management',
  'condition_precedent',
] as const;
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
  /**
   * require_amortization: total principal the borrower must pay down
   * between origination and maturity to land the maturity balance at
   * `targetMaturityBalance`. Sized so the doctrine's exit-DSCR clears
   * the refinanceable threshold at the stressed take-out constant.
   */
  readonly requiredPaydown?: number;
  /**
   * require_amortization: balloon balance at maturity that satisfies the
   * doctrine's refinanceable threshold (sustainableNCF / (stressedRefiConstant
   * × refiDscrThreshold)).
   */
  readonly targetMaturityBalance?: number;
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
  /**
   * Clean-doctrine dimension ids that this proposal addresses.
   *
   * Mitigant v2 phase 1 — DECLARED for phase 2 wiring; today this is
   * populated only for the LTV-arm proposal (addresses 'leverage-ltv'
   * + 'cap-rate-valuation-stress' since the LTV arm now sizes against
   * dim 7's stressed value). Phase 2 wires structural levers for refi (4),
   * concentration (5), asset-class (8), and sponsor (9).
   *
   * Optional + readonly; consumers MUST tolerate empty / absent. The
   * field is additive to the v1 contract and does not change content-hash
   * compatibility for v1 records (JCS drops undefined keys).
   */
  readonly addressesDimensions?: readonly string[];
}

/**
 * Persisted sibling graph record. Content-hashed over
 * (adjustedInputsId, handbookEvaluationId, mitigationEngineVersion, proposals[]).
 * Bumping `mitigationEngineVersion` changes the id even for the same proposals;
 * intentional cache-invalidation so re-evaluation under a new engine version
 * produces a fresh record rather than colliding.
 */
export interface MitigationProposalSet {
  readonly id: MitigationProposalSetId;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly handbookEvaluationId: HandbookEvaluationId;
  readonly mitigationEngineVersion: MitigationEngineVersion;
  readonly proposals: readonly MitigationProposal[];
}
