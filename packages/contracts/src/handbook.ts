/**
 * Handbook contract — types for the Eightfold CRE Credit Handbook.
 *
 * This contract is the single source of truth for the structured form of
 * the credit handbook. The handbook captures the firm's credit philosophy,
 * universal credit framework, asset-type-specific underwriting principles,
 * and the seven-step ASR review framework, all in machine-readable form.
 *
 * Three entity types:
 *   - `Handbook` — top-level wrapper containing version, metadata, all
 *     clusters of principles, and the review process.
 *   - `PrincipleCluster` — a grouping of principles (e.g., "Core Philosophy",
 *     "Industrial", "Hotel"). Optional cluster-level narrative prose.
 *   - `Principle` — atomic credit principle with trigger, execution modes,
 *     injection points, severity, optional deterministic check, optional
 *     research actions, and cross-references to other principles/steps.
 *   - `ReviewStep` — Section V framework step (separate top-level entity,
 *     not a Principle). Captures the seven-step ASR review process.
 *
 * Cross-reference semantics:
 *   - `relatedPrincipleIds` — peer principles, "see also" relationships
 *   - `relatedReviewStepIds` — review steps this principle's methodology
 *     contributes to (note: runtime fan-in via injection_points is implicit,
 *     not duplicated here)
 *   - `upstreamDependencies` — principles whose research action output this
 *     principle's deterministic check consumes (runtime ordering constraint)
 *   - `overlapsWith` — principles that cover overlapping semantic territory;
 *     engine may de-duplicate at runtime when both fire
 *
 * All cross-reference arrays are bidirectional and verbose: empty arrays
 * are explicitly included when no links exist. This makes JSON conversion
 * mechanical and engine code free of null checks.
 *
 * Versioning: the handbook root carries a single `version` field. Per-entity
 * history lives in git, not in the contract.
 */

// =============================================================================
// Enum-like const arrays + derived types
// =============================================================================

export const EXECUTION_MODES = [
  'DETERMINISTIC',
  'LLM_CONTEXT',
  'RESEARCH',
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const INJECTION_POINTS = [
  'executive_summary',
  'red_flag_assessment',
  'mitigation_suggestions',
  'committee_recommendation',
] as const;
export type InjectionPoint = (typeof INJECTION_POINTS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'advisory'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Asset-type scope for cluster targeting and trigger conditions.
 *
 * `All` denotes principles in Section II (Core Philosophy) and Section III
 * (Universal Framework) which apply to every deal regardless of asset type.
 *
 * Specific asset types in Section IV target only their cluster.
 */
export const ASSET_TYPE_SCOPES = [
  'All',
  'Office',
  'Retail',
  'Industrial',
  'Multifamily',
  'Hotel',
  'SelfStorage',
  'MHC',
  'SingleTenant',
] as const;
export type AssetTypeScope = (typeof ASSET_TYPE_SCOPES)[number];

/**
 * Comparison operators for deterministic check bands.
 *
 * - Numeric: `lt`, `lte`, `gt`, `gte`, `eq`, `neq`, `in_range`
 * - Set/string: `in`, `not_in`, `contains_any`, `contains_all`
 * - Categorical-only (no threshold comparison; condition itself fires): `matches`
 */
export const COMPARISON_OPS = [
  'lt',
  'lte',
  'gt',
  'gte',
  'eq',
  'neq',
  'in',
  'not_in',
  'contains_any',
  'contains_all',
  'in_range',
  'matches',
] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

// =============================================================================
// Metric expressions
// =============================================================================

/**
 * What value the deterministic check evaluates against. Three kinds:
 *   - `simple`: read a single field by path
 *   - `computed`: evaluate a formula tree (e.g., loan / annual_room_revenue)
 *   - `categorical`: no scalar metric — the condition match alone fires the
 *     flag (used with the `matches` operator)
 */
export type MetricExpression =
  | { kind: 'simple'; path: string }
  | { kind: 'computed'; formula: FormulaNode }
  | { kind: 'categorical' };

/**
 * Minimal formula tree for v1 of the contract. Sufficient to express the
 * computed metrics we have in the handbook today:
 *   - P-IV-ST-4: stressed_dark_value = appraised_dark_value × 0.50
 *   - P-IV-HOT-10: loan_amount / annual_room_revenue
 *   - P-IV-RET-6: cumulative cash flow over loan term (NOI - debt_service - reserves - capex, summed)
 *
 * Intentionally minimal. Extend in later contract versions if new principle
 * formulas exceed expressiveness.
 */
export type FormulaNode =
  | { kind: 'literal'; value: number }
  | { kind: 'field'; path: string }
  | { kind: 'op'; op: ArithmeticOp; operands: FormulaNode[] };

export const ARITHMETIC_OPS = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'sum_over_term',
] as const;
export type ArithmeticOp = (typeof ARITHMETIC_OPS)[number];

// =============================================================================
// Conditions (for trigger, evaluation group selection, etc.)
// =============================================================================

/**
 * Conditions used both at the Principle level (trigger) and at the
 * EvaluationGroup level (which group's bands apply to this deal).
 *
 * Designed as a closed discriminated union — engine has a fixed interpreter.
 */
export type Condition =
  | { kind: 'always' }
  | { kind: 'field_equals'; field: string; value: string | number | boolean }
  | {
      kind: 'field_in';
      field: string;
      values: ReadonlyArray<string | number>;
    }
  | { kind: 'field_gte'; field: string; value: number }
  | { kind: 'field_gt'; field: string; value: number }
  | { kind: 'field_lte'; field: string; value: number }
  | { kind: 'field_lt'; field: string; value: number }
  | { kind: 'field_exists'; field: string }
  | { kind: 'field_truthy'; field: string }
  | { kind: 'all_of'; conditions: Condition[] }
  | { kind: 'any_of'; conditions: Condition[] }
  | { kind: 'not'; condition: Condition };

// =============================================================================
// Threshold values
// =============================================================================

/**
 * The value a metric is compared against in a band. Four kinds:
 *   - `literal`: a single scalar (number, string, boolean)
 *   - `set`: an array, used with `in`/`not_in`/`contains_any`/`contains_all`
 *   - `range`: min/max with inclusivity flags, used with `in_range`
 *   - `field_reference`: compare metric to another field's value (e.g.,
 *     stressed_dark_value vs loan_amount)
 *
 * `null` is the threshold for the `matches` operator (categorical checks).
 */
export type ThresholdValue =
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'set'; values: ReadonlyArray<string | number> }
  | {
      kind: 'range';
      min: number;
      max: number;
      minInclusive: boolean;
      maxInclusive: boolean;
    }
  | { kind: 'field_reference'; path: string }
  | { kind: 'none' };

// =============================================================================
// Deterministic check — evaluation groups and bands
// =============================================================================

/**
 * A single severity band within an evaluation group.
 *
 * Bands within a group are mutually exclusive severity tiers. The engine
 * evaluates bands in order and the first band whose operator+threshold
 * evaluates true is the result.
 *
 * Example: P-IV-SS-2 self-storage supply has two bands in one group —
 * a high-severity band for > 9 SF/capita and a medium-severity advisory
 * band for 7-9 SF/capita.
 */
export interface Band {
  operator: ComparisonOp;
  threshold: ThresholdValue;
  severity: Severity;
  flag_message: string;
}

/**
 * A group of bands applicable when a particular condition holds.
 *
 * Engine semantics:
 *   1. Iterate over `evaluationGroups` in order.
 *   2. First group whose `condition` matches the deal is THE applicable group.
 *   3. Within that group, evaluate `bands` in order; first matching band fires.
 *   4. If no group's condition matches, no flag fires.
 *
 * Order matters. Place more-specific conditions before less-specific ones.
 * The catch-all (`{kind: 'always'}`) condition, if present, goes last.
 *
 * Example: P-IV-RET-5 mall debt yield with fortress Class A nested exception
 * uses two groups — fortress Class A group first (10% floor + 10-11% advisory
 * band), then a catch-all group for standard malls (15% floor).
 */
export interface EvaluationGroup {
  condition: Condition;
  bands: Band[];
}

/**
 * The deterministic check on a Principle. Optional — many principles are
 * LLM_CONTEXT and RESEARCH only and have no deterministic check.
 */
export interface DeterministicCheck {
  metric: MetricExpression;
  evaluationGroups: EvaluationGroup[];
}

// =============================================================================
// Research actions
// =============================================================================

/**
 * A research action describes one externally-grounded data-gathering or
 * verification step the engine performs when the principle fires in RESEARCH
 * mode.
 *
 * `verification_required: true` means the data must be confirmed by a human
 * analyst before relying on the AI-generated summary. Some research actions
 * (e.g., the third-party-reviews mandate for hotels/multifamily/MHC) are
 * explicitly mandatory analyst-verification — the analyst MUST read the
 * underlying reviews even if the LLM summarizes them.
 */
export interface ResearchAction {
  action_type: string;
  verification_required: boolean;
  target_data: string;
  summary_prompt_hint: string;
}

// =============================================================================
// Cross-references
// =============================================================================

/**
 * The four-field cross-reference block on every Principle.
 *
 * All four arrays are always present, even when empty. This makes JSON
 * conversion mechanical, contract types non-optional, and engine code
 * free of null checks.
 *
 * All cross-references are bidirectional: if A's `relatedPrincipleIds`
 * contains B, then B's `relatedPrincipleIds` also contains A. A validation
 * script should enforce this property.
 *
 * Distinctions:
 *   - `relatedPrincipleIds`: generic "see also" relatedness
 *   - `relatedReviewStepIds`: review steps whose methodology this principle
 *     contributes to (NOT every review step that pulls content from this
 *     principle at runtime — that's implicit in injection_points)
 *   - `upstreamDependencies`: this principle's deterministic check consumes
 *     output from these principles' research actions. Engine runtime must
 *     execute upstream principles' research first.
 *   - `overlapsWith`: principles that cover overlapping semantic territory.
 *     Engine may de-duplicate at runtime. Distinct from `relatedPrincipleIds`
 *     because overlap implies "firing both is potentially redundant," not
 *     just "they're related."
 */
export interface PrincipleCrossReferences {
  relatedPrincipleIds: string[];
  relatedReviewStepIds: string[];
  upstreamDependencies: string[];
  overlapsWith: string[];
}

/**
 * Cross-references on a ReviewStep. Only one field — review steps don't
 * have dependencies, overlaps, or step-to-step relatedness in the current
 * design.
 *
 * Captures METHODOLOGICAL ANCESTORS only. Runtime content fan-in (every
 * principle that injects content into this step's output) is implicit in
 * each principle's injection_points field.
 */
export interface ReviewStepCrossReferences {
  relatedPrincipleIds: string[];
}

// =============================================================================
// Principle
// =============================================================================

/**
 * An atomic credit principle.
 *
 * Identified by string ID in one of three patterns:
 *   - `P-II-N` for Section II (Core Philosophy) principles
 *   - `P-III-N` for Section III (Universal Framework) principles
 *   - `P-IV-XX-N` for Section IV (asset-type-specific) principles, where
 *     XX is the asset-type cluster code (OFF, RET, IND, MF, HOT, SS, MHC, ST)
 *
 * `trigger` is evaluated against the deal to decide if the principle applies.
 * `executionModes` declares how the engine handles the principle at runtime:
 *   - DETERMINISTIC: run the `deterministicCheck` (must be present)
 *   - LLM_CONTEXT: inject `principleText` as context into LLM prompts at
 *     each declared `injectionPoint`
 *   - RESEARCH: execute each `researchAction` to gather/verify external data
 *
 * A principle can declare multiple modes simultaneously.
 *
 * `severity` is the principle's own severity. Individual deterministic-check
 * bands can declare their own (potentially different) severity.
 */
export interface Principle {
  id: string;
  cluster: string;
  title: string;
  principleText: string;
  sourceCitation: string;

  trigger: Condition;
  executionModes: ExecutionMode[];
  injectionPoints: InjectionPoint[];
  severity: Severity;

  deterministicCheck?: DeterministicCheck;
  researchActions: ResearchAction[];

  crossReferences: PrincipleCrossReferences;

  /**
   * Free-text notes from atomization — calibration choices, schema-design
   * commentary, implementation hints. Not consumed by engine; informational.
   */
  notes?: string[];
}

// =============================================================================
// Principle cluster
// =============================================================================

/**
 * A grouping of principles. Examples:
 *   - "Core Philosophy" (Section II)
 *   - "Universal Framework" (Section III)
 *   - "Industrial", "Hotel", "Office" etc. (Section IV asset-type clusters)
 *   - "Single-Tenant Risk" (Section IV, applies to multiple asset types)
 *
 * `narrative` is optional cluster-level prose that frames the cluster's
 * principles. Currently used only by the Single-Tenant Risk cluster.
 */
export interface PrincipleCluster {
  id: string;
  title: string;
  section: HandbookSection;
  assetTypeScope: AssetTypeScope;
  narrative?: string;
  principleIds: string[];
}

export const HANDBOOK_SECTIONS = [
  'core_philosophy', // Section II
  'universal_framework', // Section III
  'asset_type_specific', // Section IV
] as const;
export type HandbookSection = (typeof HANDBOOK_SECTIONS)[number];

// =============================================================================
// Review step
// =============================================================================

/**
 * A step in the Section V seven-step ASR review framework. Each ReviewStep
 * is a separate top-level entity from Principles — review steps describe
 * the analytical process, not the underwriting principles themselves.
 *
 * IDs are formal: V-1 through V-7.
 *
 * `outputType` describes the shape of artifact the step produces.
 * `mandatory: true` for all current steps (per handbook: "these steps can
 * never be omitted").
 */
export interface ReviewStep {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  mandatory: boolean;
  outputType: ReviewStepOutputType;
  crossReferences: ReviewStepCrossReferences;
  notes?: string[];
}

export const REVIEW_STEP_OUTPUT_TYPES = [
  'summary',
  'stress_test',
  'reserve_analysis',
  'research',
  'comparative',
  'portfolio_correlation',
  'cross_portfolio',
] as const;
export type ReviewStepOutputType = (typeof REVIEW_STEP_OUTPUT_TYPES)[number];

// =============================================================================
// Handbook — top-level entity
// =============================================================================

/**
 * The full Eightfold CRE Credit Handbook in structured form.
 *
 * `version` is the single source of truth for handbook revision. Format
 * is freeform string (semver, calver, or human-readable label) — interpreted
 * by tooling. Per-entity revision history lives in git.
 */
export interface Handbook {
  version: string;
  effectiveDate: string; // ISO 8601 date
  description: string;

  clusters: PrincipleCluster[];
  principles: Principle[];
  reviewProcess: ReviewStep[];
}
