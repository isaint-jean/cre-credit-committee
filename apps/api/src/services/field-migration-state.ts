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
  | 'LEGACY'             // adjustedInputs-only; resolvedContext ignored
  | 'DUAL_OBSERVED'      // resolvedContext exists; adjustedInputs still primary
  | 'HYBRID'             // resolvedContext primary; adjustedInputs fallback allowed (in hydrator)
  | 'FULL_MODERN'        // resolvedContext sole authority; adjustedInputs forbidden
  | 'RENT_ROLL_SOURCED'  // bundle.rentRoll passthrough (per-tenant rows + RRP toggle); new at v10
  | 'APPRAISAL_SOURCED'  // resolvedContext.appraisal atoms (CBRE / appraiser-concluded); new at v10
                          // for cells whose source-of-truth is the appraisal extraction —
                          // E41 (Appraised LTV = loan/appraisal.valueConclusion),
                          // Concluded_Cap_Rate (appraisal.overallCapRate). Routed via
                          // resolvedContext at the schema level (same surface as HYBRID/
                          // FULL_MODERN), but state-named explicitly so the migration
                          // ledger distinguishes "appraisal-derived" from "extraction-
                          // descriptor-derived" cells in the readout.
  | 'META_SOURCED';      // RenderInput.meta passthrough (dealId, dealName,
                          // generatedAt); new at v11 for the Cover Page
                          // Deal_Control_Number wire. Route-controlled
                          // metadata that the render layer reads from
                          // input.meta — not derived from any extraction
                          // / engine output.

export type FieldGroup =
  | 'property'
  | 'party'
  | 'loan'
  | 'comps'
  | 'financial_core'
  | 'rent_roll';     // per-tenant Rent Roll rows + RRP toggle (new at v10)

/**
 * The source surface a schema entry's selector MUST read from given the
 * cell's declared state. The v7 single-sourced rule means HYBRID still
 * reads from resolvedContext at the schema level — fallback to
 * adjustedInputs lives in the hydrator, not the selector.
 */
export const REQUIRED_SOURCE_BY_STATE: Readonly<Record<FieldMigrationState, SourceSurface>> = {
  LEGACY:             'adjustedInputs',
  DUAL_OBSERVED:      'adjustedInputs',
  HYBRID:             'resolvedContext',
  FULL_MODERN:        'resolvedContext',
  RENT_ROLL_SOURCED:  'rentRoll',
  // Appraisal-sourced cells route via resolvedContext (buildAppraisalAtoms in
  // hydrate-underwriting-context.ts surfaces the appraisal extraction onto
  // resolvedContext.appraisal). A selector tagged with 'resolvedContext'
  // satisfies this state. Multi-source selectors (e.g., E41 reading
  // adjustedInputs.loan.loanAmount + resolvedContext.appraisal.asIsValue) pass
  // because `has(required)` checks set membership — the appraisal tag is
  // present alongside adjustedInputs.
  APPRAISAL_SOURCED:  'resolvedContext',
  // Meta-sourced cells read from RenderInput.meta (dealId, dealName,
  // generatedAt — the route-controlled identifiers). The selector tag is
  // 'meta', already permitted at the schema level since v7. New at v11.
  META_SOURCED:       'meta',
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
  rent_roll:       { minCoverage: 0.85, minStability: 0.90, maxFallbackPressure: 0.05, minConsecutiveRuns: 100 },
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
    { address: 'Property & Loan Summary!Measure',           group: 'property', state: 'FULL_MODERN' },
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
  // v8 is a SHAPE bump (Phase B, populated-workbook initiative). No new
  // cells, no source-surface migrations. Every cell carries over from v7
  // with the same state — the payload contract gains cellStates +
  // cellComments + floorBindings, but the per-cell migration state is
  // unchanged.
  8: [
    { address: 'Property & Loan Summary!Property_Name',         group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Address',               group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!City',                  group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!State',                 group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!ZIP',                   group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!County',                group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Property_Type',         group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Year_Built',            group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Measure',               group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Occupancy',             group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Ownership_Interest',    group: 'property', state: 'FULL_MODERN' },
    { address: 'Borrower!Borrower',                             group: 'party',    state: 'FULL_MODERN' },
    { address: 'Borrower!Sponsor',                              group: 'party',    state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Balloon_Term',          group: 'loan',     state: 'HYBRID' },
    { address: 'Property & Loan Summary!Amortization_Term',     group: 'loan',     state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Interest_Only_Period',  group: 'loan',     state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Current_Balance',       group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Original_Balance',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Coupon',                group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Annual_Debt_Service',   group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Cap_Rate',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Value',         group: 'financial_core', state: 'LEGACY' },
  ],
  // v9 (Phase A, populated-workbook initiative): ADDS schema entries. The
  // per-cell field-migration state for every carried-forward cell is
  // unchanged (cellState changes — Concluded_Cap_Rate and Concluded_Value
  // flip from cellState='concluded' to cellState='awaiting_input' — but the
  // field-migration state is about source-surface authority, NOT cellState,
  // and the source surface stays adjustedInputs / LEGACY). New CONCLUDED
  // and AWAITING_INPUT cells are declared at LEGACY by default (their
  // selectors read from adjustedInputs; nullSelector for awaiting_input
  // is tagged adjustedInputs).
  9: [
    // ---- carried forward unchanged ----
    { address: 'Property & Loan Summary!Property_Name',         group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Address',               group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!City',                  group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!State',                 group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!ZIP',                   group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!County',                group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Property_Type',         group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Year_Built',            group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Measure',               group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Occupancy',             group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Ownership_Interest',    group: 'property', state: 'FULL_MODERN' },
    { address: 'Borrower!Borrower',                             group: 'party',    state: 'FULL_MODERN' },
    { address: 'Borrower!Sponsor',                              group: 'party',    state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Balloon_Term',          group: 'loan',     state: 'HYBRID' },
    { address: 'Property & Loan Summary!Amortization_Term',     group: 'loan',     state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Interest_Only_Period',  group: 'loan',     state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Current_Balance',       group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Original_Balance',      group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Coupon',                group: 'financial_core', state: 'LEGACY' },
    { address: 'Property & Loan Summary!Annual_Debt_Service',   group: 'financial_core', state: 'LEGACY' },
    { address: 'Conclusions & Escrows!Concluded_Cap_Rate',      group: 'financial_core', state: 'LEGACY', notes: 'v9 Phase A: cellState flipped concluded → awaiting_input (cap-rate calibration ticket); source surface unchanged.' },
    { address: 'Conclusions & Escrows!Concluded_Value',         group: 'financial_core', state: 'LEGACY', notes: 'v9 Phase A: cellState flipped concluded → awaiting_input (inherits cap-rate optimism); source surface unchanged.' },
    // ---- NEW at v9 (CONCLUDED) ----
    { address: 'Operating History and Pro Forma!P9',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Income_Gross_Potential_Rental — adjustedInputs.income.grossPotentialRent.' },
    { address: 'Operating History and Pro Forma!P6',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Income_Vacancy_Pct — derived |vacancyLoss| / GPR.' },
    { address: 'Operating History and Pro Forma!P10',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Income_Vacancy_Loss — adjustedInputs.income.vacancyLoss.' },
    { address: 'Operating History and Pro Forma!P14',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Other_Income.' },
    { address: 'Operating History and Pro Forma!P31',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_Real_Estate_Taxes.' },
    { address: 'Operating History and Pro Forma!P30',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_Management_Fee.' },
    { address: 'Operating History and Pro Forma!P38',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_Replacement_Reserves_Annual.' },
    { address: 'Conclusions & Escrows!I16',                     group: 'financial_core', state: 'LEGACY', notes: 'New at v9. NOI_DSCR (post loan-terms fix).' },
    { address: 'Conclusions & Escrows!J16',                     group: 'financial_core', state: 'LEGACY', notes: 'New at v9. NOI_Debt_Yield (post loan-terms fix).' },
    // ---- NEW at v9 (AWAITING_INPUT) ----
    { address: 'Operating History and Pro Forma!P25',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_Utilities — awaiting_input pending expense-markup rule.' },
    { address: 'Operating History and Pro Forma!P22',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_GA — awaiting_input pending expense-markup rule.' },
    { address: 'Operating History and Pro Forma!P32',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. OpEx_Insurance — awaiting_input pending expense-markup rule.' },
    { address: 'Operating History and Pro Forma!P39',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Reserve_TI_Annual — awaiting_input pending expense-markup rule.' },
    { address: 'Operating History and Pro Forma!P40',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Reserve_LC_Annual — awaiting_input pending expense-markup rule.' },
    { address: 'Operating History and Pro Forma!P15',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Income_Reimbursements — awaiting_input pending @cre/shared field or derived selector.' },
    { address: 'Operating History and Pro Forma!P11',           group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Bad_Debt_Expense — engine folds bad debt into vacancy; cell displays 0.' },
    { address: 'Operating History and Pro Forma!P21',           group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. OpEx_Salaries_Benefits — adjustedInputs.expenses.payroll.' },
    { address: 'Operating History and Pro Forma!P23',           group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. OpEx_Advertising_Marketing — engine has no surface; cell displays 0.' },
    { address: 'Operating History and Pro Forma!P24',           group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. OpEx_Repairs_Maintenance — adjustedInputs.expenses.repairsAndMaintenance.' },
    { address: 'Operating History and Pro Forma!P26',           group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. OpEx_Other — carries expense-floor residual (totalExpenses − sum of broken-out lines) with labeled cell note.' },
    { address: 'Property & Loan Summary!E41',                   group: 'financial_core', state: 'LEGACY', notes: 'New at v9. LTV_Appraisal — awaiting_input pending appraisal ingest slot.' },
    { address: 'Operating History and Pro Forma!P49',           group: 'financial_core', state: 'LEGACY', notes: 'New at v9. NCF_DSCR — awaiting_input pending NCF metric.' },
    { address: 'Property & Loan Summary!K5',                    group: 'property',       state: 'LEGACY', notes: 'New at v9. Net_Rentable_Area — awaiting_input pending resolvedContext extension. (LEGACY because nullSelector reads adjustedInputs.)' },
    { address: 'Property & Loan Summary!K6',                    group: 'property',       state: 'LEGACY', notes: 'New at v9. Property_Building_Class — awaiting_input pending PropertyMetadata extraction widening.' },
    // Hotel asset class maps Operating_ProForma → 'Hotel Op History and Pro
    // Forma' (SHEET_MAPPING_OPERATING_PROFORMA[hotel]). Each Operating-ProForma
    // schema entry resolves to TWO addresses across asset classes — the
    // canonical 'Operating History and Pro Forma!*' for non-hotel and the
    // 'Hotel Op History and Pro Forma!*' variant for hotel. Field-state
    // registry must declare both.
    { address: 'Hotel Op History and Pro Forma!P9',             group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P9.' },
    { address: 'Hotel Op History and Pro Forma!P6',             group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P6.' },
    { address: 'Hotel Op History and Pro Forma!P10',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P10.' },
    { address: 'Hotel Op History and Pro Forma!P14',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P14.' },
    { address: 'Hotel Op History and Pro Forma!P31',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P31.' },
    { address: 'Hotel Op History and Pro Forma!P30',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P30.' },
    { address: 'Hotel Op History and Pro Forma!P38',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P38.' },
    { address: 'Hotel Op History and Pro Forma!P25',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P25.' },
    { address: 'Hotel Op History and Pro Forma!P22',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P22.' },
    { address: 'Hotel Op History and Pro Forma!P32',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P32.' },
    { address: 'Hotel Op History and Pro Forma!P39',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P39.' },
    { address: 'Hotel Op History and Pro Forma!P40',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P40.' },
    { address: 'Hotel Op History and Pro Forma!P15',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P15.' },
    { address: 'Hotel Op History and Pro Forma!P11',            group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Hotel-asset variant of OPF P11.' },
    { address: 'Hotel Op History and Pro Forma!P21',            group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Hotel-asset variant of OPF P21.' },
    { address: 'Hotel Op History and Pro Forma!P23',            group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Hotel-asset variant of OPF P23.' },
    { address: 'Hotel Op History and Pro Forma!P24',            group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Hotel-asset variant of OPF P24.' },
    { address: 'Hotel Op History and Pro Forma!P26',            group: 'financial_core', state: 'LEGACY', notes: 'Engine direct-display. Hotel-asset variant of OPF P26 (expense-floor residual).' },
    { address: 'Hotel Op History and Pro Forma!P49',            group: 'financial_core', state: 'LEGACY', notes: 'New at v9. Hotel-asset variant of OPF P49.' },
    // ---- Sprint-0 NEW: property-identity cells (CONCLUDED, sourced from --
    // ---- propertyMetadata via resolvedContext.property.* atoms) ----------
    // P&L Summary additions — named ranges that exist in the template but had
    // no V9 entry. New at v9-sprint-0 with FULL_MODERN state (resolvedContext-only).
    { address: 'Property & Loan Summary!MSA',                   group: 'property', state: 'FULL_MODERN', notes: 'Sprint-0. resolvedContext.property.msa; sourced from propertyMetadata.msa.' },
    { address: 'Property & Loan Summary!Year_Renovated',        group: 'property', state: 'FULL_MODERN', notes: 'Sprint-0. resolvedContext.property.yearRenovated; sourced from propertyMetadata.yearRenovated.' },
    // Property Detail B/F bindings (B3/B4/B9/B11/B15, F3/F4/F5/F11) REMOVED on
    // all three sheets — they wrote offset junk on office (absent cells) and
    // overwrote real LABEL cells on MF SS MHP / Hotel. Data now bound via Tier-1a
    // (P&L named ranges) + Tier-1b (scoped C11/C12). See render-schema.ts.
    // Site Inspection — only C6 is a true input cell; the other Property-
    // identity cells (C4/C5/E4/E5) are template formulas that auto-cascade
    // from P&L Summary named ranges, so they get no schema entry.
    { address: 'Site Inspection!C6',                            group: 'property', state: 'FULL_MODERN', notes: 'Sprint-0. resolvedContext.property.numberOfBuildings.' },
    // ---- Appraisal-ingest: Operating ProForma column J (Appraisal) -----
    // STABILIZED basis; sourced from analysis.appraisalExtraction via the
    // resolvedContext.appraisal.* atoms. 14 input rows; FORMULA subtotals
    // (J10/J12/J17/J27/J33/J35/J42/J44/J46-J50) are NEVER declared (they
    // compute via template SUMs).
    { address: 'Operating History and Pro Forma!J9',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.pgr (stabilized PRI).' },
    { address: 'Operating History and Pro Forma!J6',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.economicOccupancy.' },
    { address: 'Operating History and Pro Forma!J7',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.physicalOccupancy.' },
    { address: 'Operating History and Pro Forma!J11',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.badDebt (negative).' },
    { address: 'Operating History and Pro Forma!J14',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.otherIncomeGross.' },
    { address: 'Operating History and Pro Forma!J15',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. resolvedContext.appraisal.netEffectiveReimbursements.' },
    { address: 'Operating History and Pro Forma!J22',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesGeneralAdmin (=General Operating).' },
    { address: 'Operating History and Pro Forma!J24',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesRepairsMaintenance.' },
    { address: 'Operating History and Pro Forma!J25',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesUtilities.' },
    { address: 'Operating History and Pro Forma!J26',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesOtherVariable (Janitorial + Nonreimbursable Landlord).' },
    { address: 'Operating History and Pro Forma!J30',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesManagement (3% of EGI).' },
    { address: 'Operating History and Pro Forma!J31',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesTaxes (stabilized).' },
    { address: 'Operating History and Pro Forma!J32',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. expensesInsurance.' },
    { address: 'Operating History and Pro Forma!J38',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. capex (replacementReserves).' },
    { address: 'Hotel Op History and Pro Forma!J9',             group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J9.' },
    { address: 'Hotel Op History and Pro Forma!J6',             group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J6.' },
    { address: 'Hotel Op History and Pro Forma!J7',             group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J7.' },
    { address: 'Hotel Op History and Pro Forma!J11',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J11.' },
    { address: 'Hotel Op History and Pro Forma!J14',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J14.' },
    { address: 'Hotel Op History and Pro Forma!J15',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J15.' },
    { address: 'Hotel Op History and Pro Forma!J22',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J22.' },
    { address: 'Hotel Op History and Pro Forma!J24',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J24.' },
    { address: 'Hotel Op History and Pro Forma!J25',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J25.' },
    { address: 'Hotel Op History and Pro Forma!J26',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J26.' },
    { address: 'Hotel Op History and Pro Forma!J30',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J30.' },
    { address: 'Hotel Op History and Pro Forma!J31',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J31.' },
    { address: 'Hotel Op History and Pro Forma!J32',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J32.' },
    { address: 'Hotel Op History and Pro Forma!J38',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal. Hotel variant of OPF J38.' },
    // ---- Appraisal-ingest: Conclusions & Escrows ----------------------------
    // I11 is the named range `Appraised_Value` (see openpyxl-confirmed
    // defined name 'Conclusions & Escrows'!$I$11). Feeds I13/I14 LTV+Cap
    // formulas. D47/D48/D49 are the Per-Appraisal escrow columns (taxes,
    // insurance, replacement reserves).
    { address: 'Operating History and Pro Forma!J35',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. CAVEAT-ONLY (formula preserved): cell note surfaces going-in NOI vs stabilized basis.' },
    { address: 'Operating History and Pro Forma!J48',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. CAVEAT-ONLY: DSCR shown is stabilized; going-in negative.' },
    { address: 'Operating History and Pro Forma!J50',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. CAVEAT-ONLY: DY shown is stabilized; going-in negative.' },
    { address: 'Hotel Op History and Pro Forma!J35',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Hotel variant CAVEAT-ONLY J35.' },
    { address: 'Hotel Op History and Pro Forma!J48',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Hotel variant CAVEAT-ONLY J48.' },
    { address: 'Hotel Op History and Pro Forma!J50',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Hotel variant CAVEAT-ONLY J50.' },
    { address: 'Conclusions & Escrows!Appraised_Value',         group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. resolvedContext.appraisal.asIsValue (Sunroad CBRE p.3 $122M). Drives I13 headline LTV.' },
    { address: 'Conclusions & Escrows!D47',                     group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Per-Appraisal RE Taxes (stabilized).' },
    { address: 'Conclusions & Escrows!D48',                     group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Per-Appraisal Insurance (stabilized).' },
    { address: 'Conclusions & Escrows!D49',                     group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. Per-Appraisal Replacement Reserves (capex).' },
    { address: 'Conclusions & Escrows!I14',                     group: 'financial_core', state: 'FULL_MODERN', notes: 'Appraisal-ingest. CAVEAT-ONLY: shown cap rate (= stab NOI / as-is) is template artifact; appraiser OAR (6.25%) carried in cell note.' },
    // ---- Sprint-2: Third Party Reports Summary (appraisal + PCA) -----------
    { address: 'Third Party Reports Summary!E4',                group: 'property', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.asIsValueDate.' },
    { address: 'Third Party Reports Summary!E6',                group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.asStabilizedValue.' },
    { address: 'Third Party Reports Summary!E7',                group: 'property', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.asStabilizedValueDate.' },
    { address: 'Third Party Reports Summary!E8',                group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.insurableValue (CBRE p.13 $148.9M).' },
    { address: 'Third Party Reports Summary!E18',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.terminalCapRate.' },
    { address: 'Third Party Reports Summary!E19',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.appraisal.discountRate.' },
    { address: 'Third Party Reports Summary!E24',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.pca.replacementReservesPerSfPerYearInflated ($/SF/yr).' },
    { address: 'Third Party Reports Summary!E25',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.pca.immediateRepairs ($).' },
    { address: 'Third Party Reports Summary!E33',               group: 'property', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.statusLine (firm + Phase-I date + finding).' },
    { address: 'Third Party Reports Summary!E34',               group: 'property', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.phaseIIRequired.' },
    { address: 'Third Party Reports Summary!E35',               group: 'property', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.existingRec.' },
    { address: 'Third Party Reports Summary!E36',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.remediation (meaningful $0).' },
    { address: 'Third Party Reports Summary!E37',               group: 'financial_core', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.reserve (meaningful $0).' },
    { address: 'Third Party Reports Summary!G33',               group: 'property', state: 'FULL_MODERN', notes: 'Phase A. resolvedContext.environmental.provenanceNote (ASR-summary source label).' },
    { address: 'Conclusions & Escrows!D50',                     group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-2. resolvedContext.pca.immediateRepairs — escrow-basis Per-Appraisal column carries the PCA recommendation.' },
    // ---- Sprint-1: Operating ProForma column L (Issuer UW / GS U/W) -------
    { address: 'Operating History and Pro Forma!L9',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.pgr.' },
    { address: 'Operating History and Pro Forma!L6',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.economicOccupancy (derived from vacancyLoss/PGR).' },
    { address: 'Operating History and Pro Forma!L11',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.badDebt (null for Sunroad — no separate credit-loss line on the issuer UW).' },
    { address: 'Operating History and Pro Forma!L13',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.uwAdjustments — CMBS "Total UW Adjustments" bucket.' },
    { address: 'Operating History and Pro Forma!L14',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.otherIncome.' },
    { address: 'Operating History and Pro Forma!L15',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. resolvedContext.issuerUw.reimbursements.' },
    { address: 'Operating History and Pro Forma!L22',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesGeneralAdmin.' },
    { address: 'Operating History and Pro Forma!L24',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesRepairsMaintenance.' },
    { address: 'Operating History and Pro Forma!L25',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesUtilities.' },
    { address: 'Operating History and Pro Forma!L26',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesOtherVariable (Janitorial).' },
    { address: 'Operating History and Pro Forma!L30',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesManagement.' },
    { address: 'Operating History and Pro Forma!L31',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesTaxes.' },
    { address: 'Operating History and Pro Forma!L32',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.expensesInsurance.' },
    { address: 'Operating History and Pro Forma!L38',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.capex (belowNoiAdjustments.replacementReserves).' },
    { address: 'Operating History and Pro Forma!L39',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.tenantImprovements.' },
    { address: 'Operating History and Pro Forma!L40',           group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. issuerUw.leasingCommissions.' },
    { address: 'Hotel Op History and Pro Forma!L9',             group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L9.' },
    { address: 'Hotel Op History and Pro Forma!L6',             group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L6.' },
    { address: 'Hotel Op History and Pro Forma!L11',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L11.' },
    { address: 'Hotel Op History and Pro Forma!L13',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L13.' },
    { address: 'Hotel Op History and Pro Forma!L14',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L14.' },
    { address: 'Hotel Op History and Pro Forma!L15',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L15.' },
    { address: 'Hotel Op History and Pro Forma!L22',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L22.' },
    { address: 'Hotel Op History and Pro Forma!L24',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L24.' },
    { address: 'Hotel Op History and Pro Forma!L25',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L25.' },
    { address: 'Hotel Op History and Pro Forma!L26',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L26.' },
    { address: 'Hotel Op History and Pro Forma!L30',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L30.' },
    { address: 'Hotel Op History and Pro Forma!L31',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L31.' },
    { address: 'Hotel Op History and Pro Forma!L32',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L32.' },
    { address: 'Hotel Op History and Pro Forma!L38',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L38.' },
    { address: 'Hotel Op History and Pro Forma!L39',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L39.' },
    { address: 'Hotel Op History and Pro Forma!L40',            group: 'financial_core', state: 'FULL_MODERN', notes: 'Sprint-1. Hotel variant of L40.' },
  ],
  // v10: Rent Roll render. Carries v9 forward verbatim and adds the per-tenant
  // Rent Roll rows (rows 14..43 × 8 input columns = 240 entries) plus the RRP
  // toggle on Property & Loan Summary!AA3. New cells are RENT_ROLL_SOURCED —
  // the selector reads from RenderInput.rentRoll (bundle.rentRoll passthrough).
  10: (() => {
    const carryForward: ReadonlyArray<FieldStateDeclaration> = [
      // ---- carried forward from v9 unchanged ----
      { address: 'Property & Loan Summary!Property_Name',         group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Address',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!City',                  group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!State',                 group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!ZIP',                   group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!County',                group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Property_Type',         group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Year_Built',            group: 'property', state: 'FULL_MODERN' },
    { address: 'Property & Loan Summary!Measure',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Occupancy',             group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Ownership_Interest',    group: 'property', state: 'FULL_MODERN' },
      { address: 'Borrower!Borrower',                             group: 'party',    state: 'FULL_MODERN' },
      { address: 'Borrower!Sponsor',                              group: 'party',    state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Balloon_Term',          group: 'loan',     state: 'HYBRID' },
      { address: 'Property & Loan Summary!Amortization_Term',     group: 'loan',     state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Interest_Only_Period',  group: 'loan',     state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Current_Balance',       group: 'financial_core', state: 'LEGACY' },
      { address: 'Property & Loan Summary!Original_Balance',      group: 'financial_core', state: 'LEGACY' },
      { address: 'Property & Loan Summary!Coupon',                group: 'financial_core', state: 'LEGACY' },
      { address: 'Property & Loan Summary!Annual_Debt_Service',   group: 'financial_core', state: 'LEGACY' },
      // Phase A.5 — Concluded_Cap_Rate transitions LEGACY → APPRAISAL_SOURCED
      // at v10. Selector now reads resolvedContext.appraisal.overallCapRate
      // (6.25% for Sunroad, via CBRE). Concluded_Value stays LEGACY
      // (operator-supplied $122M flows through adjustedInputs as before).
      { address: 'Conclusions & Escrows!Concluded_Cap_Rate',      group: 'financial_core', state: 'APPRAISAL_SOURCED' },
      { address: 'Conclusions & Escrows!Concluded_Value',         group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P9',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P6',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P10',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P14',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P31',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P30',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P38',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Conclusions & Escrows!I16',                     group: 'financial_core', state: 'LEGACY' },
      { address: 'Conclusions & Escrows!J16',                     group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P25',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P22',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P32',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P39',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P40',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P15',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P11',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P21',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P23',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P24',           group: 'financial_core', state: 'LEGACY' },
      { address: 'Operating History and Pro Forma!P26',           group: 'financial_core', state: 'LEGACY' },
      // Phase A.5 — E41 transitions LEGACY → APPRAISAL_SOURCED at v10.
      // Selector reads loanAmount (adjustedInputs) / appraisal.asIsValue
      // (resolvedContext) → multi-source tag set ['adjustedInputs',
      // 'resolvedContext']; the source-mismatch check passes via set
      // membership on 'resolvedContext' (the APPRAISAL_SOURCED requirement).
      // For Sunroad: $11M / $122M = 9.02%.
      { address: 'Property & Loan Summary!E41',                   group: 'financial_core', state: 'APPRAISAL_SOURCED' },
      { address: 'Operating History and Pro Forma!P49',           group: 'financial_core', state: 'LEGACY' },
      // Phase A — K5 transitions LEGACY → RENT_ROLL_SOURCED at v10.
      // The K5 entry in V10_SHARED_ENTRIES now reads from
      // RenderInput.rentRoll (sum of tenant.squareFeet), so the v10 field-
      // state must declare RENT_ROLL_SOURCED to satisfy the source-mismatch
      // check (REQUIRED_SOURCE_BY_STATE['RENT_ROLL_SOURCED'] = 'rentRoll').
      // K6 stays LEGACY — building class still nullSelector.
      { address: 'Property & Loan Summary!K5',                    group: 'property',       state: 'RENT_ROLL_SOURCED' },
      { address: 'Property & Loan Summary!K6',                    group: 'property',       state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P9',             group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P6',             group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P10',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P14',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P31',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P30',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P38',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P25',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P22',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P32',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P39',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P40',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P15',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P11',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P21',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P23',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P24',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P26',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Hotel Op History and Pro Forma!P49',            group: 'financial_core', state: 'LEGACY' },
      { address: 'Property & Loan Summary!MSA',                   group: 'property', state: 'FULL_MODERN' },
      { address: 'Property & Loan Summary!Year_Renovated',        group: 'property', state: 'FULL_MODERN' },
      // Property Detail B/F bindings REMOVED (all 3 sheets) — see the [9] section
      // note above + render-schema.ts. Data now via Tier-1a + Tier-1b.
      { address: 'Site Inspection!C6',                            group: 'property', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J9',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J6',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J7',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J11',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J14',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J15',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J22',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J24',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J25',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J26',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J30',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J31',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J32',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J38',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J9',             group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J6',             group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J7',             group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J11',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J14',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J15',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J22',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J24',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J25',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J26',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J30',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J31',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J32',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J38',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J35',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J48',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!J50',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J35',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J48',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!J50',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!Appraised_Value',         group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!D47',                     group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!D48',                     group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!D49',                     group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!I14',                     group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E4',                group: 'property', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E6',                group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E7',                group: 'property', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E8',                group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E18',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E19',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E24',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E25',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E33',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E34',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E35',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E36',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!E37',               group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Third Party Reports Summary!G33',               group: 'property', state: 'FULL_MODERN' },
      { address: 'Conclusions & Escrows!D50',                     group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L9',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L6',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L11',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L13',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L14',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L15',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L22',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L24',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L25',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L26',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L30',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L31',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L32',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L38',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L39',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Operating History and Pro Forma!L40',           group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L9',             group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L6',             group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L11',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L13',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L14',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L15',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L22',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L24',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L25',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L26',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L30',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L31',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L32',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L38',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L39',            group: 'financial_core', state: 'FULL_MODERN' },
      { address: 'Hotel Op History and Pro Forma!L40',            group: 'financial_core', state: 'FULL_MODERN' },
    ];
    // Per-tenant rent-roll rows: 30 rows × 8 input columns = 240 entries.
    const rrEntries: FieldStateDeclaration[] = [];
    const cols: string[] = ['B', 'C', 'D', 'E', 'F', 'G', 'I', 'N'];
    for (let row = 14; row <= 43; row++) {
      for (const col of cols) {
        rrEntries.push({
          address: `Rent Roll!${col}${row}`,
          group: 'rent_roll',
          state: 'RENT_ROLL_SOURCED',
          notes: 'New at v10. Per-tenant rent-roll passthrough from bundle.rentRoll.lines[row-14].',
        });
      }
    }
    // RRP toggle override on Property & Loan Summary!AA3.
    const rrpOverride: FieldStateDeclaration = {
      address: 'Property & Loan Summary!AA3',
      group: 'rent_roll',
      state: 'RENT_ROLL_SOURCED',
      notes: 'New at v10. Hardcoded "TRUE" — overrides template formula so dependent IF($S$8, …) chains resolve cleanly. RENT_ROLL_SOURCED because the override is gated on rent-roll presence.',
    };
    return [...carryForward, ...rrEntries, rrpOverride];
  })(),
  // v11: Tier-1 safe render wires. Carries v10 forward verbatim and adds
  // two new cells — Cover Page!Deal_Control_Number (meta source) and
  // 10 Yr Pro Forma!Terminal_Cap_Rate (resolvedContext source, same channel
  // v10's Third Party Reports!E18 uses for the identical extracted-appraisal
  // value). No state transitions on carry-forward entries; only two
  // additions. v10 carry-forward is computed via the same closure pattern
  // that v10 itself uses, just re-inlined here because const-initializers
  // cannot self-reference the object they're populating.
  11: [],
};

// v11 carry-forward + additions. Defined post-registry-creation so the
// v10 entry is fully populated when we read it. Mutates the registry's
// v11 slot in place; the registry contract is read-only after this point.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[11] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[10] ?? [];
  const v11Additions: FieldStateDeclaration[] = [
    {
      address: 'Cover Page!Deal_Control_Number',
      group: 'property',
      state: 'META_SOURCED',
      notes: 'New at v11. meta.dealId — route-controlled identifier already on RenderInput; sourced via the meta selector helper (\'meta\' surface, permitted since v7).',
    },
    {
      address: '10 Yr Pro Forma!Terminal_Cap_Rate',
      group: 'financial_core',
      state: 'APPRAISAL_SOURCED',
      notes: 'New at v11. resolvedContext.appraisal.terminalCapRate — identical channel to v10\'s Third Party Reports!E18. Verdict path already consumes this value through judgment/apply-judgment-adjustments.ts (buildTerminalCapRate); v11 only closes the render gap so the Terminal_Cap_Rate cell also displays it.',
    },
  ];
  return [...carryForward, ...v11Additions];
})();

// v12 carry-forward + additions. Every v11 cell carries forward unchanged; the
// only new declaration is K27 Loan Purpose (resolvedContext.property.loanPurpose),
// a fresh FULL_MODERN property cell with no AdjustedInputs equivalent — same
// shape as the buildingClass / Sprint-0 property-metadata cells.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[12] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[11] ?? [];
  const v12Additions: FieldStateDeclaration[] = [
    {
      address: 'Property & Loan Summary!K27',
      group: 'property',
      state: 'FULL_MODERN',
      notes: 'New at v12. resolvedContext.property.loanPurpose (propertyMetadata.loanPurpose); no AdjustedInputs equivalent. Mirrors buildingClass / Sprint-0 property-metadata cells.',
    },
  ];
  return [...carryForward, ...v12Additions];
})();

// v13 carry-forward + additions. Every v12 cell carries forward unchanged; the
// only new declarations are the 30 Rent Roll Rank cells (A14:A43) — fresh
// RENT_ROLL_SOURCED cells in the rent_roll group, mirroring the existing
// per-tenant rent-roll rows (cols B,C,D,E,F,G,I,N) which used the same
// group/state since v10. A was the one input column never bound.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[13] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[12] ?? [];
  const v13Additions: FieldStateDeclaration[] = [];
  for (let row = 14; row <= 43; row++) {
    v13Additions.push({
      address: `Rent Roll!A${row}`,
      group: 'rent_roll',
      state: 'RENT_ROLL_SOURCED',
      notes: 'New at v13. Per-tenant rank (income-sorted index, rank = row-13) — the Stress Scenario tab join key. Same group/state as the v10 rent-roll passthrough cols (B,C,D,E,F,G,I,N).',
    });
  }
  return [...carryForward, ...v13Additions];
})();

// v14 carry-forward + additions. Every v13 cell carries forward unchanged; the
// only new declarations are the 6 Sources & Uses cells (F27-F31, K30) — fresh
// FULL_MODERN property cells sourced from resolvedContext.sourcesUses.* (the
// ASR S&U table), mirroring the K27 loanPurpose cell. No AdjustedInputs
// equivalent. Purchase Price (K29) is intentionally NOT declared — honest-blank.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[14] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[13] ?? [];
  const v14Additions: FieldStateDeclaration[] = [
    'F27', 'F28', 'F29', 'F30', 'F31', 'K30',
  ].map((cell) => ({
    address: `Property & Loan Summary!${cell}`,
    group: 'property' as const,
    state: 'FULL_MODERN' as const,
    notes: 'New at v14. resolvedContext.sourcesUses.* (ASR Sources & Uses table); no AdjustedInputs equivalent. Mirrors the K27 loanPurpose property cell.',
  }));
  return [...carryForward, ...v14Additions];
})();

// v15 carry-forward + additions. Every v14 cell carries forward unchanged; the
// only new declaration is Note_Date (Property & Loan Summary!C13) — a fresh
// FULL_MODERN property cell sourced from resolvedContext.property.noteDate
// (derived from maturityDate − termMonths). Mirrors the K27 loanPurpose cell.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[15] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[14] ?? [];
  const v15Additions: FieldStateDeclaration[] = [
    {
      address: 'Property & Loan Summary!C13',
      group: 'property',
      state: 'FULL_MODERN',
      notes: 'New at v15. resolvedContext.property.noteDate (Note Date serial = maturityDate − termMonths); no AdjustedInputs equivalent. Anchors the period-date headers. Mirrors the K27 loanPurpose property cell.',
    },
  ];
  return [...carryForward, ...v15Additions];
})();

// v16 carry-forward, no additions. v16 re-points the Balloon_Term selector (an
// existing address, already declared in the carried-forward registry) — it adds
// no new cell, so the field-state set is identical to v15.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[16] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[15] ?? [];
  return [...carryForward];
})();

// v17 carry-forward + the 16 T12 column-H cells. Fresh FULL_MODERN
// financial_core cells sourced from resolvedContext.t12.* — same group/state as
// the v10 issuer-UW column-L cells (the Operating History period columns are
// symmetric).
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[17] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[16] ?? [];
  const cells = ['H9', 'H6', 'H11', 'H13', 'H14', 'H15', 'H22', 'H24',
                 'H25', 'H26', 'H30', 'H31', 'H32', 'H38', 'H39', 'H40'];
  // The Operating_ProForma slot resolves to two distinct sheets across asset
  // classes (standard + hotel) — declare both, exactly as the issuer-UW L cells.
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const v17Additions: FieldStateDeclaration[] = sheets.flatMap((sh) =>
    cells.map((cell) => ({
      address: `${sh}!${cell}`,
      group: 'financial_core' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v17. resolvedContext.t12.* — normalized borrower 12-month statement (T12 historical column). Same shape as the issuer-UW column-L cells.',
    })),
  );
  return [...carryForward, ...v17Additions];
})();

// v18 carry-forward + the 2 T12-notes cells (R4 vintage, A53 credit signal),
// across both Operating_ProForma sheets (standard + hotel). Fresh FULL_MODERN
// property cells sourced from resolvedContext.t12.{vintage,creditSignal}.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[18] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[17] ?? [];
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const v18Additions: FieldStateDeclaration[] = sheets.flatMap((sh) =>
    ['A53', 'A54'].map((cell) => ({
      address: `${sh}!${cell}`,
      group: 'property' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v18. resolvedContext.t12.{vintage,creditSignal} — visible T12 must-carry notes (vintage label / credit signal).',
    })),
  );
  return [...carryForward, ...v18Additions];
})();

// v19 carry-forward + the 3 Document-Completeness Ledger cells (A55 present /
// A56 missing / A57 coverage), across both Operating_ProForma sheets. Declared
// (schema sentinel) but filled by the downstream display layer.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[19] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[18] ?? [];
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const v19Additions: FieldStateDeclaration[] = sheets.flatMap((sh) =>
    ['A55', 'A56', 'A57'].map((cell) => ({
      address: `${sh}!${cell}`,
      group: 'property' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v19. Document-Completeness Ledger — null sentinel selector; text filled by applyDocumentCompletenessDisplay (downstream render-time display).',
    })),
  );
  return [...carryForward, ...v19Additions];
})();

(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[20] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[19] ?? [];
  // v20: Rent Roll tier-table leasing baseline — 15 cells (C7:C11 market,
  // F7:F11 TI-new, G7:G11 TI-renew) reading adjustedInputs.assumptions.leasing.
  // State LEGACY because the authority is adjustedInputs (REQUIRED_SOURCE_BY_STATE
  // .LEGACY === 'adjustedInputs', matching the selector's ['adjustedInputs'] tag).
  // New addresses at v20 — no prior-version state, so no transition check applies.
  const v20Additions: FieldStateDeclaration[] = (['C', 'F', 'G'] as const).flatMap((col) =>
    [7, 8, 9, 10, 11].map((row): FieldStateDeclaration => ({
      address: `Rent Roll!${col}${row}`,
      group: 'rent_roll' as const,
      state: 'LEGACY' as const,
      notes: 'New at v20. Display-only appraisal leasing baseline (market / TI-new / TI-renew), flat down all 5 tier rows from adjustedInputs.assumptions.leasing. D/E (term/downtime) unbound.',
    })),
  );
  return [...carryForward, ...v20Additions];
})();

(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[21] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[20] ?? [];
  // v21: SCHEMA_V21 is the P1 skeleton — an exact mirror of V20
  // (V21_PROPERTY_DETAIL_ENTRIES is empty until P2 binds Property Detail
  // Part A). Carry v20 forward verbatim: no new cells and no state changes,
  // so every v20→v21 transition is identity (legal per isLegalTransition's
  // from === to short-circuit). When P2 populates V21_PROPERTY_DETAIL_ENTRIES,
  // add the matching declarations here (Property_Detail is a ctx slot reading
  // resolvedContext.appraisal → FULL_MODERN).
  return [...carryForward];
})();

(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[22] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[21] ?? [];
  // v22: Operating History T12 column (H) + row-3 year headers. ctx slot
  // reading resolvedContext.t12 → FULL_MODERN, mirroring the existing J/L
  // (issuerUw/appraisal) declarations. Prior-year cols B/D/F stay OUT.
  // Operating_ProForma resolves to BOTH sheets per asset class (office/etc. →
  // "Operating History and Pro Forma"; hotel → "Hotel Op History and Pro Forma"),
  // so declare on both — mirrors the existing J/L + v19 doc-completeness pattern.
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const v22Additions: FieldStateDeclaration[] = sheets.flatMap((sheet) =>
    ['H17', 'H3', 'F3', 'D3', 'B3'].map((cell): FieldStateDeclaration => ({
      address: `${sheet}!${cell}`,
      group: 'financial_core' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v22. Operating History T12 total revenues / year header — resolvedContext.t12.',
    })),
  );
  return [...carryForward, ...v22Additions];
})();

(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[23] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[22] ?? [];
  // v23: Issuer UW column L17 total revenues (the v22 H17 fix one column over).
  // ctx slot reading resolvedContext.issuerUw → FULL_MODERN, on both sheets.
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const v23Additions: FieldStateDeclaration[] = sheets.map((sheet): FieldStateDeclaration => ({
    address: `${sheet}!L17`,
    group: 'financial_core' as const,
    state: 'FULL_MODERN' as const,
    notes: 'New at v23. Issuer UW total revenues — resolvedContext.issuerUw.totalIncome.',
  }));
  return [...carryForward, ...v23Additions];
})();

(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[24] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[23] ?? [];
  // v24: prior-year columns B/D/F (2021/2022/2023) full ladder — new cells from
  // resolvedContext.{y2021/y2022/y2023} → FULL_MODERN, both sheets. The H/L
  // rebinds (H9/H6/H14/L9/L6/L14) reuse their carried-forward [23] declarations
  // (FULL_MODERN/resolvedContext — unchanged source surface, just a new block).
  const sheets = ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'];
  const bdfCells = ['B', 'D', 'F'].flatMap((col) =>
    ['9', '6', '14', '15', '22', '24', '25', '30', '31', '32', '38', '39', '40'].map((r) => col + r),
  );
  // Physical occupancy (row 7) — new at v24, FULL_MODERN from
  // resolvedContext.physicalOccupancy (rent-roll leased SF ÷ total). P7/L7 =
  // stabilized (occ + PRELEASED); H7 = in-place (occ only).
  const physOccCells = ['P7', 'L7', 'H7'];
  // Column N "Actual Income In Place" — new at v24, FULL_MODERN T12-mirror.
  // Full cfT12 ladder (income+expenses) + physical occ N7. Matches the LADDER
  // rows bound in render-schema's V24 colN block.
  const colNCells = ['N9', 'N6', 'N14', 'N15', 'N22', 'N24', 'N25', 'N30',
    'N31', 'N32', 'N38', 'N39', 'N40', 'N7'];
  const v24Additions: FieldStateDeclaration[] = sheets.flatMap((sheet) => [
    ...bdfCells.map((cell): FieldStateDeclaration => ({
      address: `${sheet}!${cell}`,
      group: 'financial_core' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v24. Operating History prior-year column — resolvedContext.{y2021/y2022/y2023}.',
    })),
    ...physOccCells.map((cell): FieldStateDeclaration => ({
      address: `${sheet}!${cell}`,
      group: 'financial_core' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v24. Physical occupancy (row 7) — resolvedContext.physicalOccupancy (leased SF ÷ total).',
    })),
    ...colNCells.map((cell): FieldStateDeclaration => ({
      address: `${sheet}!${cell}`,
      group: 'financial_core' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v24. Column N "Actual Income In Place" — T12-mirror of H (cfT12 + t12 block).',
    })),
  ]);
  // Tier-1b — asset-class-SCOPED Property Detail C11 (#buildings) / C12 (#stories),
  // V24-only. The render-schema entry is scoped `!== 'hotel'`, so it renders to the
  // Comm (office/retail/industrial/mixed_use) AND MF SS MHP (multifamily/self_storage/
  // manufactured_housing) sheets — NOT Hotel. Declare field-states on exactly those
  // two sheets (no Hotel) to match the governance's per-asset-class `observed` set.
  // GROUP B — non-hotel (Comm + MF SS MHP): C11/C12 (Tier-1b) + C15 (Tier-2b
  // Building Class — both layouts carry "Building Class"; Hotel excluded).
  const nonHotelSheets = ['Property Detail - Comm', 'Property Detail - MF SS MHP'];
  const scopedNonHotel = nonHotelSheets.flatMap((sheet) =>
    ['C11', 'C12', 'C15'].map((cell): FieldStateDeclaration => ({
      address: `${sheet}!${cell}`,
      group: 'property' as const,
      state: 'FULL_MODERN' as const,
      notes: 'New at v24. Scoped (non-hotel): C11 #buildings / C12 #stories (Tier-1b) / C15 building class (Tier-2b).',
    })),
  );
  // GROUP A — Comm-only (parking L3/L4, land L11, zoning H7). These labels exist
  // only on the Comm layout; the render-schema entry is scoped to the Comm-sheet
  // classes, so declare field-states on the Comm sheet ONLY (no MF/Hotel) to match
  // the governance's per-asset-class `observed` set.
  const commOnly = ['L3', 'L4', 'L11', 'H7'].map((cell): FieldStateDeclaration => ({
    address: `Property Detail - Comm!${cell}`,
    group: 'property' as const,
    state: 'FULL_MODERN' as const,
    notes: 'New at v24. Tier-2b Comm-only: L3 surface parking / L4 covered parking / L11 land area / H7 zoning — resolvedContext.appraisal.*.',
  }));
  return [...carryForward, ...v24Additions, ...scopedNonHotel, ...commOnly];
})();

// v25: CMBS office-comps TABLE layout (cmbsComps). The table cells (CMBS Comps
// r13–r18) are NOT schema cell-addresses — they're written via the TablePayload
// path (writeTable), not cellBindings — so the field-state registry needs NO new
// declarations. v25's cell-binding surface is identical to v24; carry forward
// verbatim.
(FIELD_STATE_REGISTRY as unknown as Record<number, FieldStateDeclaration[]>)[25] = (() => {
  const carryForward = FIELD_STATE_REGISTRY[24] ?? [];
  return [...carryForward];
})();

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
  // Phase A (v10) — LEGACY → RENT_ROLL_SOURCED. The rent-roll bundle landed
  // at v10 as a new source surface. Cells that had been LEGACY
  // awaiting_input but whose data lives in the rent-roll (e.g., Property &
  // Loan Summary!K5 / NRA = sum of tenant.squareFeet) can transition
  // directly. NOT a skip past the staircase — the staircase is
  // adjustedInputs/resolvedContext migration; rent-roll is an orthogonal
  // source surface that becomes available at v10. Single-step transition
  // because there's no intermediate state for rent-roll-sourcing.
  ['LEGACY', 'RENT_ROLL_SOURCED'],
  // Phase A.5 (v10) — LEGACY → APPRAISAL_SOURCED. The CBRE appraisal IS
  // ingested for Sunroad (the prior nullSelector comment claimed "no
  // appraisal slot in the 4-file ingest model"; that premise is now FALSE).
  // Cells whose source-of-truth is the appraisal — E41 (Appraised LTV) and
  // Concluded_Cap_Rate (appraiser's overall OAR) — transition directly.
  // Same orthogonal-source pattern as LEGACY → RENT_ROLL_SOURCED above;
  // single-step transition because there's no intermediate state for
  // appraisal-sourcing.
  ['LEGACY', 'APPRAISAL_SOURCED'],
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
