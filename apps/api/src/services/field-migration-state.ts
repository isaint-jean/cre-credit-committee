/**
 * Field-Migration Governance — code-level expression of the spec.
 *
 * Encodes the per-field state machine (LEGACY → DUAL_OBSERVED → HYBRID →
 * FULL_MODERN), the per-group readiness thresholds (coverage, stability,
 * fallback pressure), and the per-(cellAddress, contractVersion) declared
 * state registry. The boot invariant `assertFieldStatesConsistent()`
 * verifies every shipped schema entry's selector source-surface matches
 * its declared state, and that cross-version state changes follow the
 * legal-transition table.
 *
 * HARD RULES (code-enforced):
 *   - Each schema entry MUST appear in FIELD_STATE_REGISTRY at every
 *     contract version where it is rendered.
 *   - The selector's source surface MUST match the declared state's
 *     expected source surface (LEGACY → adjustedInputs, HYBRID →
 *     resolvedContext, FULL_MODERN → resolvedContext, DUAL_OBSERVED →
 *     adjustedInputs since AI is still primary in that state).
 *   - Cross-version state transitions for the same cell MUST follow
 *     LEGAL_TRANSITIONS. A jump from LEGACY directly to FULL_MODERN is
 *     forbidden (must pass through DUAL_OBSERVED and HYBRID).
 *   - One-time grandfathering for the v6→v7 bring-up is captured in
 *     GRANDFATHERED_TRANSITIONS — every entry there is a documented
 *     historical exception that future v8+ migrations CANNOT add to.
 *
 * GOVERNANCE RULES (cannot be enforced at boot — measured at query time):
 *   - Coverage / stability / fallback-pressure thresholds (see THRESHOLDS).
 *     The readiness aggregator (migration-readiness.service.ts) reads the
 *     observability log to compute these per field. Future contributors
 *     consult /api/underwriting/migration-readiness BEFORE declaring a
 *     state change.
 *   - "No migration allowed without observability evidence" — there is
 *     no code path that automates a state transition. Transitions are
 *     code edits to FIELD_STATE_REGISTRY; the spec's discipline is that
 *     such edits cite the readiness route's verdict.
 */
import type { SourceSurface } from './render-schema.js';

// --- States, groups, thresholds --------------------------------------------

export type FieldMigrationState =
  | 'LEGACY'         // adjustedInputs-only; resolvedContext ignored
  | 'DUAL_OBSERVED'  // resolvedContext exists; adjustedInputs still primary
  | 'HYBRID'         // resolvedContext primary; adjustedInputs fallback allowed (in hydrator)
  | 'FULL_MODERN';   // resolvedContext sole authority; adjustedInputs forbidden

export type FieldGroup =
  | 'property'
  | 'party'
  | 'loan'
  | 'comps'
  | 'financial_core';

/**
 * The source surface a schema entry's selector MUST read from given the
 * cell's declared state. The v7 single-sourced rule means HYBRID still
 * reads from resolvedContext at the schema level — fallback to
 * adjustedInputs lives in the hydrator, not the selector.
 */
export const REQUIRED_SOURCE_BY_STATE: Readonly<Record<FieldMigrationState, SourceSurface>> = {
  LEGACY:        'adjustedInputs',
  DUAL_OBSERVED: 'adjustedInputs',
  HYBRID:        'resolvedContext',
  FULL_MODERN:   'resolvedContext',
};

/**
 * Per-group readiness thresholds. A field is migration-eligible iff
 * C(field) ≥ minCoverage AND S(field) ≥ minStability AND F(group) ≤
 * maxFallbackPressure.
 */
export interface GroupThresholds {
  minCoverage: number;          // 0..1
  minStability: number;         // 0..1
  maxFallbackPressure: number;  // 0..1
  /** Minimum consecutive renders required for the stability window. */
  minConsecutiveRuns: number;
}

export const THRESHOLDS: Readonly<Record<FieldGroup, GroupThresholds>> = {
  property:        { minCoverage: 0.90, minStability: 0.95, maxFallbackPressure: 0.05, minConsecutiveRuns: 100 },
  party:           { minCoverage: 0.95, minStability: 0.95, maxFallbackPressure: 0.05, minConsecutiveRuns: 100 },
  loan:            { minCoverage: 0.85, minStability: 0.90, maxFallbackPressure: 0.05, minConsecutiveRuns: 100 },
  comps:           { minCoverage: 0.70, minStability: 0.85, maxFallbackPressure: 0.05, minConsecutiveRuns: 100 },
  financial_core:  { minCoverage: 0.99, minStability: 0.99, maxFallbackPressure: 0.01, minConsecutiveRuns: 100 },
};

/**
 * Migration order specified in §6 of the governance doc. Lower index =
 * earlier in the queue. The readiness route surfaces this so contributors
 * know which group to attempt next.
 */
export const MIGRATION_ORDER: ReadonlyArray<FieldGroup> = [
  'property', 'party', 'loan', 'comps', 'financial_core',
];

/**
 * Global deprecation thresholds for retiring AdjustedInputs entirely.
 * Spec §5: every field must be FULL_MODERN AND legacyDependencyRatio <
 * 0.10 globally for ≥ 30 consecutive runs AND no v6 templates active.
 */
export const ADJUSTED_INPUTS_DEPRECATION = {
  maxLegacyDependencyRatio: 0.10,
  minConsecutiveRunsBelowRatio: 30,
} as const;

// --- Field-state registry --------------------------------------------------

export interface FieldStateDeclaration {
  /** Schema cell address: "Sheet!Range". */
  address: string;
  group: FieldGroup;
  state: FieldMigrationState;
  /**
   * Optional notes — typically the readiness verdict that justified a
   * recent state transition, or a grandfathering rationale.
   */
  notes?: string;
}

/**
 * Per-version registry. Adding a v(N+1) requires declaring states for
 * every cell that appears in v(N+1). Cells removed at v(N+1) are simply
 * absent from that version's map.
 */
export const FIELD_STATE_REGISTRY: Readonly<Record<number, ReadonlyArray<FieldStateDeclaration>>> = {
  6: [
    { address: 'Property & Loan Summary!Current_Balance',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Original_Balance',     group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Coupon',               group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Amortization_Term',    group: 'loan',           state: 'LEGACY' },
    { address: 'Property & Loan Summary!Interest_Only_Period', group: 'loan',           state: 'LEGACY' },
    { address: 'Property & Loan Summary!Annual_Debt_Service',  group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Cap_Rate',     group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Value',        group: 'financial_core', state: 'LEGACY' },
  ],
  7: [
    // --- Property block (new in v7; introduced at FULL_MODERN per spec). ---
    // New-in-version cells are not subject to the LEGACY→FULL_MODERN no-skip
    // rule because they had no prior state.
    { address: 'Property & Loan Summary!Property_Name',     group: 'property', state: 'FULL_MODERN', notes: 'New at v7. resolvedContext.property.name only; no AdjustedInputs equivalent.' },
    { address: 'Property & Loan Summary!Address',           group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!City',              group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!State',             group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!ZIP',               group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!County',            group: 'property', state: 'FULL_MODERN', notes: 'New at v7. resolvedContext.property.county only; sourced from propertyMetadata.' },
    { address: 'Property & Loan Summary!Property_Type',     group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Year_Built',        group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Occupancy',         group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Ownership_Interest',group: 'property', state: 'FULL_MODERN', notes: 'New at v7. resolvedContext.property.ownershipInterest only; sourced from propertyMetadata.' },
    // --- Party block (new in v7). ---
    { address: 'Borrower!Borrower',                      group: 'party',    state: 'FULL_MODERN' },
    { address: 'Borrower!Sponsor',                       group: 'party',    state: 'FULL_MODERN' },
    // --- Loan block. ---
    // Balloon_Term is new at v7 with HYBRID semantics: the hydrator falls
    // back to adjustedInputs.loan.termMonths when extraction is missing.
    { address: 'Property & Loan Summary!Balloon_Term',          group: 'loan', state: 'HYBRID',      notes: 'Hydrator fallback: extraction → AdjustedInputs.loan.termMonths.' },
    // Amortization_Term and Interest_Only_Period TRANSITIONED from LEGACY
    // (v6) to FULL_MODERN (v7) without passing through DUAL_OBSERVED or
    // HYBRID. Per spec §7 this is a forbidden jump; documented as a
    // one-time grandfathering exception (see GRANDFATHERED_TRANSITIONS).
    // Future migrations CANNOT use this path.
    { address: 'Property & Loan Summary!Amortization_Term',     group: 'loan', state: 'FULL_MODERN', notes: 'GRANDFATHERED v6→v7 jump (LEGACY→FULL_MODERN). No future cell may follow this path.' },
    { address: 'Property & Loan Summary!Interest_Only_Period',  group: 'loan', state: 'FULL_MODERN', notes: 'GRANDFATHERED v6→v7 jump.' },
    // Financial-core cells continue at LEGACY (adjustedInputs-authoritative).
    { address: 'Property & Loan Summary!Current_Balance',       group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Original_Balance',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Coupon',                group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Annual_Debt_Service',   group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Cap_Rate',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Value',         group: 'financial_core', state: 'LEGACY' },
  ],
};

// --- Legal cross-version transitions ---------------------------------------

/**
 * The state machine. Going from `from` to `to` is legal iff (from, to) is
 * in this set OR from === to (no change). Spec §7 forbids LEGACY →
 * FULL_MODERN directly.
 */
export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [FieldMigrationState, FieldMigrationState]> = [
  ['LEGACY', 'DUAL_OBSERVED'],
  ['DUAL_OBSERVED', 'HYBRID'],
  ['HYBRID', 'FULL_MODERN'],
  // Permit forward + backward only along the staircase. State demotions
  // (e.g. FULL_MODERN → HYBRID) are allowed iff explicitly listed for
  // remediation purposes; not currently allowed, so omitted.
];

/**
 * One-time documented exceptions to the no-skip rule. Each entry records
 * a (cellAddress, fromVersion, toVersion, fromState, toState) jump that
 * predates the governance spec and is grandfathered. The boot check
 * accepts these without firing the no-skip invariant; future v8+ entries
 * MUST NOT extend this list.
 */
export interface GrandfatheredTransition {
  address: string;
  fromVersion: number;
  toVersion: number;
  fromState: FieldMigrationState;
  toState: FieldMigrationState;
  reason: string;
}

export const GRANDFATHERED_TRANSITIONS: ReadonlyArray<GrandfatheredTransition> = [
  {
    address: 'Property & Loan Summary!Amortization_Term',
    fromVersion: 6, toVersion: 7,
    fromState: 'LEGACY', toState: 'FULL_MODERN',
    reason: 'v7 shipped Amortization_Term as resolvedContext-sourced with no hydrator fallback. The governance spec landed after v7. Future Amortization-related transitions must follow the staircase.',
  },
  {
    address: 'Property & Loan Summary!Interest_Only_Period',
    fromVersion: 6, toVersion: 7,
    fromState: 'LEGACY', toState: 'FULL_MODERN',
    reason: 'Same as Amortization_Term — v7 shipped before the governance spec.',
  },
];

// --- Lookup helpers --------------------------------------------------------

export function getFieldStateRegistryForVersion(
  contractVersion: number,
): ReadonlyArray<FieldStateDeclaration> {
  return FIELD_STATE_REGISTRY[contractVersion] ?? [];
}

export function getFieldState(
  address: string,
  contractVersion: number,
): FieldStateDeclaration | undefined {
  return getFieldStateRegistryForVersion(contractVersion).find((f) => f.address === address);
}

export function isLegalTransition(
  from: FieldMigrationState,
  to: FieldMigrationState,
  address: string,
  fromVersion: number,
  toVersion: number,
): boolean {
  if (from === to) return true;
  if (LEGAL_TRANSITIONS.some(([a, b]) => a === from && b === to)) return true;
  // Grandfathered exception?
  return GRANDFATHERED_TRANSITIONS.some((g) =>
    g.address === address &&
    g.fromVersion === fromVersion &&
    g.toVersion === toVersion &&
    g.fromState === from &&
    g.toState === to,
  );
}
