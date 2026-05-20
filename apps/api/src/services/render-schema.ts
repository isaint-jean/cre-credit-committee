/**
 * Render Schema — declarative, exhaustive per-(asset-class, variant,
 * underwriting-mode) projection.
 *
 * Hard rule (memory/architecture_excel_role.md):
 *   "If a field is not in cellBindings, it does not exist in the rendering
 *    system."
 *
 * Hard rule (memory/architecture_render_versioning.md):
 *   "Same (assetClass, contractVersion, structuralVariantKey,
 *    underwritingMode) MUST always produce identical structural output."
 *
 * This module is the single declaration of every cell the workbook is allowed
 * to display. The schema is a three-level registry whose leaves are LISTS of
 * SchemaDefinition (each declaring which underwritingModes it serves):
 *
 *   contractVersion → assetClass → structuralVariantKey → SchemaDefinition[]
 *
 * Multi-mode reusability:
 *   A SchemaDefinition declares `underwritingModes: UnderwritingMode[]` —
 *   the modes it serves. Most variants today use a single shared definition
 *   covering both `single_loan` and `roll_up`. Only when a mode genuinely
 *   needs a different structural surface does a variant ship a second
 *   definition. The well-formedness check enforces that, for any
 *   (contractVersion, assetClass, variantKey), the underwritingModes
 *   declared across its definitions PARTITION the full set of valid modes —
 *   each mode is covered exactly once.
 *
 * Each SchemaDefinition is exhaustive: visibleTabs, schema entries (which
 * become schemaAddresses + cellBindings), tableLayouts, managedNamespace.
 * The selector is a pure function over RenderInput.
 *
 * Versioning:
 *   - RENDER_CONTRACT_VERSION (in shared/types/render.ts) is the DEFAULT
 *     version used by /render and new exports. Older versions remain queryable
 *     so templates registered against them keep rendering.
 *   - Bump RENDER_CONTRACT_VERSION when a structural change would break
 *     existing workbooks. Add a new SCHEMA_V<N> slice and register it in
 *     SCHEMA_BY_CONTRACT_VERSION; do NOT mutate older slices.
 *   - Adding a new asset class within an existing version = add an
 *     ASSET_CLASS_PREFIX entry and a variant registry under that version's
 *     slice.
 *   - Adding a new variant within an existing asset class = add a row under
 *     that asset class. Same four-axis tuple MUST produce a stable
 *     structural fingerprint.
 *
 * Architecture rule (per the BP Spire execution layer + the four-axis
 * decision log):
 *   - underwritingMode is NOT a variant. It is a separate axis of selection.
 *   - 'single_loan' renders the full 10-tab BP Spire workbook structure.
 *   - 'roll_up' is an execution / aggregation layer ON TOP of the same
 *     structural surface. By default a single SchemaDefinition serves both
 *     modes; the structural surface is identical and the
 *     RU_* aggregation cells render DATA_NOT_PROVIDED in single_loan mode
 *     (rollUpAggregation === null) and the populated values in roll_up.
 *     Variants are only split into mode-specific definitions when a mode
 *     genuinely requires a different visibleTabs / addresses / layouts surface.
 */
import { createHash } from 'node:crypto';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  AssetType,
  CellBindings,
  CellValue,
  ManagedNamespacePolicy,
  RenderInput,
  RenderPayload,
  ResolvedUnderwritingContext,
  StructuralIdentity,
  StructuralVariantKey,
  TableLayout,
  TablePayload,
  UnderwritingMode,
} from '@cre/shared';

/**
 * The schema layer reads the resolved context produced by
 * resolve-underwriting-context.ts. Selectors are pure projections — no
 * branching, no sentinels, no mode awareness. The render service is
 * responsible for constructing this object before calling
 * projectCellBindings() / buildTables().
 */
export interface ProjectionInput extends RenderInput {
  resolvedContext: ResolvedUnderwritingContext;
}

// --- Tab visibility (v6) ----------------------------------------------------
// v6 conforms to the canonical artifact `Blank UW Template.xlsm`. The schema
// declares 12 LOGICAL slots; the SHEET_MAPPING boundary layer resolves each
// (assetType, slot) → real artifact sheet name. Per-asset-class divergence
// (Property Detail variants; Operating ProForma vs Hotel Op variant) lives
// ONLY in SHEET_MAPPING — the schema's logical structure remains unified
// across asset classes.
//
// The 12 logical slots (the 10 BP Spire sections, with Comparables split into
// the artifact's 3 actual comp sheets):
//   1. Property_Loan_Summary
//   2. Conclusion_Escrows
//   3. Property_Detail        — asset-class-specific real sheet
//   4. Operating_ProForma     — asset-class-specific real sheet (hotel diverges)
//   5. Stress_Scenario
//   6. Third_Party_Reports
//   7. Borrower
//   8. Market
//   9. Site_Inspection
//  10. Comparables_Lease
//  11. Comparables_Sales
//  12. Comparables_CMBS

type SheetSlot =
  | 'Property_Loan_Summary'
  | 'Conclusion_Escrows'
  | 'Property_Detail'
  | 'Operating_ProForma'
  | 'Stress_Scenario'
  | 'Third_Party_Reports'
  | 'Borrower'
  | 'Market'
  | 'Site_Inspection'
  | 'Comparables_Lease'
  | 'Comparables_Sales'
  | 'Comparables_CMBS';

const SHEET_SLOTS: ReadonlyArray<SheetSlot> = [
  'Property_Loan_Summary',
  'Conclusion_Escrows',
  'Property_Detail',
  'Operating_ProForma',
  'Stress_Scenario',
  'Third_Party_Reports',
  'Borrower',
  'Market',
  'Site_Inspection',
  'Comparables_Lease',
  'Comparables_Sales',
  'Comparables_CMBS',
];

/**
 * Boundary mapping: (assetType, SheetSlot) → real worksheet name in the
 * artifact. This is the ONLY place asset-class divergence is permitted —
 * the schema entries below reference SheetSlot values, not real sheets.
 *
 * Adding a new asset class or renaming a sheet in the artifact is a v-bump
 * iff it changes the schemaAddresses (i.e. visibleTabs differ for some
 * (assetClass, variantKey, mode) triple).
 */
const SHEET_MAPPING_PROPERTY_DETAIL: Record<AssetType, string> = {
  office:               'Property Detail - Comm',
  retail:               'Property Detail - Comm',
  industrial:           'Property Detail - Comm',
  mixed_use:            'Property Detail - Comm',
  multifamily:          'Property Detail - MF SS MHP',
  self_storage:         'Property Detail - MF SS MHP',
  manufactured_housing: 'Property Detail - MF SS MHP',
  hotel:                'Property Detail - Hotel',
};

const SHEET_MAPPING_OPERATING_PROFORMA: Record<AssetType, string> = {
  office:               'Operating History and Pro Forma',
  retail:               'Operating History and Pro Forma',
  industrial:           'Operating History and Pro Forma',
  mixed_use:            'Operating History and Pro Forma',
  multifamily:          'Operating History and Pro Forma',
  self_storage:         'Operating History and Pro Forma',
  manufactured_housing: 'Operating History and Pro Forma',
  hotel:                'Hotel Op History and Pro Forma',
};

function sheet(assetClass: AssetType, slot: SheetSlot): string {
  switch (slot) {
    case 'Property_Loan_Summary': return 'Property & Loan Summary';
    case 'Conclusion_Escrows':    return 'Conclusions & Escrows';
    case 'Property_Detail':       return SHEET_MAPPING_PROPERTY_DETAIL[assetClass];
    case 'Operating_ProForma':    return SHEET_MAPPING_OPERATING_PROFORMA[assetClass];
    case 'Stress_Scenario':       return 'Stress Scenario';
    case 'Third_Party_Reports':   return 'Third Party Reports Summary';
    case 'Borrower':              return 'Borrower';
    case 'Market':                return 'Market';
    case 'Site_Inspection':       return 'Site Inspection';
    case 'Comparables_Lease':     return 'Lease Comps';
    case 'Comparables_Sales':     return 'Sales Comps';
    case 'Comparables_CMBS':      return 'CMBS Comps';
  }
}

function tabsFor(assetClass: AssetType): string[] {
  return SHEET_SLOTS.map((s) => sheet(assetClass, s));
}

const ASSET_CLASS_PREFIX: Record<AssetType, true> = {
  multifamily: true, office: true, retail: true, industrial: true,
  hotel: true, self_storage: true, mixed_use: true, manufactured_housing: true,
};

// --- Selector helpers --------------------------------------------------------
// Selectors are pure projections of ProjectionInput — they read a single
// pre-resolved value and return it. No branching, no sentinel injection,
// no mode awareness. All runtime logic lives upstream of this layer (in
// resolve-underwriting-context.ts and the render service).
//
// Each selector is tagged with the SET of input surfaces it touches via a
// non-enumerable `__sources` property. The boot-time per-version allowlist
// (ALLOWED_SOURCES_BY_VERSION below) then enforces the incremental
// migration policy:
//   v6 = AdjustedInputs-driven (no resolvedContext reads permitted)
//   v7 = UnderwritingContext-driven (resolvedContext reads enter here)
//
// This is the code-level expression of the policy — adding a SchemaEntry
// to v6 whose selector reads from resolvedContext fails boot with a
// SCHEMA_FORBIDDEN_SOURCE_FOR_VERSION error.

/**
 * The input surfaces a selector may read from. Each tag maps to a top-level
 * field on `ProjectionInput`. Adding a new surface (e.g. a future
 * library-baseline projection) requires adding the tag here AND extending
 * ALLOWED_SOURCES_BY_VERSION for the version that introduces it.
 */
export type SourceSurface =
  | 'adjustedInputs'
  | 'resolvedContext'
  | 'meta'
  | 'conservatismStatus'
  | 'libraryBaselineMeta';

interface TaggedSelector {
  (input: ProjectionInput): CellValue;
  /** Non-enumerable. The set of ProjectionInput fields this selector reads. */
  __sources: ReadonlySet<SourceSurface>;
}

function tagSelector(
  fn: (input: ProjectionInput) => CellValue,
  sources: SourceSurface[],
): TaggedSelector {
  const tagged = fn as TaggedSelector;
  if (Object.prototype.hasOwnProperty.call(tagged, '__sources')) return tagged;
  Object.defineProperty(tagged, '__sources', {
    value: Object.freeze(new Set(sources)),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return tagged;
}

type Selector = TaggedSelector;

const adj = (pick: (a: AdjustedInputs) => AdjustedLineItem): Selector =>
  tagSelector((input) => pick(input.adjustedInputs).adjusted, ['adjustedInputs']);

const raw = (pick: (a: AdjustedInputs) => AdjustedLineItem): Selector =>
  tagSelector((input) => pick(input.adjustedInputs).raw, ['adjustedInputs']);

const num = (pick: (a: AdjustedInputs) => number | null): Selector =>
  tagSelector((input) => pick(input.adjustedInputs), ['adjustedInputs']);

/**
 * Resolved-context selector. Reads a single CellValue from the pre-resolved
 * narrative / roll-up view. The resolver guarantees the value is already a
 * real CellValue (string, number, boolean, or null) — this helper does not
 * inspect, transform, or branch.
 *
 * Tagged with `'resolvedContext'`; FORBIDDEN by ALLOWED_SOURCES_BY_VERSION
 * for v6 (boot-time check). Permitted starting at v7.
 */
const ctx = (pick: (c: ResolvedUnderwritingContext) => CellValue): Selector =>
  tagSelector((input) => pick(input.resolvedContext), ['resolvedContext']);

/**
 * Convenience for the small set of route-controlled metadata fields
 * (dealName, generatedAt, assetClass, underwritingMode). Not used by v6
 * today; available to v7+ where allowed by the per-version policy.
 */
const meta = (pick: (i: ProjectionInput) => CellValue): Selector =>
  tagSelector((input) => pick(input), ['meta']);

// --- Schema entries ---------------------------------------------------------
interface SchemaEntry {
  slot: SheetSlot;
  range: string;
  selector: Selector;
}

/**
 * Amortization in YEARS — the artifact's `Amortization_Term` cell uses
 * the CRE convention of years (30) rather than months (360). The adapter
 * stores months on AdjustedInputs.loan.amortizationMonths; this selector
 * converts. Returns null when the source is null/unset to avoid emitting 0.
 */
const amortizationYears: Selector = tagSelector((input) => {
  const m = input.adjustedInputs.loan.amortizationMonths;
  return typeof m === 'number' && m > 0 ? Math.round(m / 12) : null;
}, ['adjustedInputs']);

// --- v7 SCHEMA SELECTORS (resolvedContext-sourced unit conversions) ---------
// The artifact's loan-term cells (Balloon_Term, Amortization_Term) are
// formatted in years; the resolvedContext stores months. These helpers do
// the months→years conversion while keeping the selector single-sourced
// against resolvedContext (per the v7 field-authority policy).

const ctxLoanMonthsToYears = (
  pick: (l: ResolvedUnderwritingContext['loan']) => CellValue,
): Selector => tagSelector((input) => {
  const v = pick(input.resolvedContext.loan);
  return typeof v === 'number' && v > 0 ? Math.round(v / 12) : v;
}, ['resolvedContext']);

// --- v6 SCHEMA ENTRIES ------------------------------------------------------
// Conservative artifact-grounded schema. Every `range` is a real defined name
// in `Blank UW Template.xlsm`. Fields the artifact does not expose as named
// ranges are intentionally OUT of v6 — they require either a producer
// extension (UnderwritingContext) or an artifact-side named-range addition.
// Both are additive future work and require a contract bump.
const SHARED_TEN_TAB_ENTRIES: SchemaEntry[] = [
  // Property & Loan Summary — loan structural fields.
  // Property_Name is intentionally NOT in v6: the only source for it today
  // is `analysis.name` (the uploaded filename), which is provenance data.
  // Add Property_Name back once the extraction pipeline produces a clean
  // property-name field via AdjustedInputs / UnderwritingContext.
  { slot: 'Property_Loan_Summary', range: 'Current_Balance',      selector: num((a) => a.loan.loanAmount) },
  { slot: 'Property_Loan_Summary', range: 'Original_Balance',     selector: num((a) => a.loan.loanAmount) },
  // Coupon and Amortization_Term: the CRE convention in this workbook is
  // decimal interest (0.0716 → "7.16%") and amortization in YEARS (30, not
  // 360 months). Unit conversion lives at the producer (adapter) for
  // interestRate and at the selector for amortization (schema declares the
  // shape of the cell value the artifact expects).
  { slot: 'Property_Loan_Summary', range: 'Coupon',               selector: num((a) => a.loan.interestRate) },
  { slot: 'Property_Loan_Summary', range: 'Amortization_Term',    selector: amortizationYears },
  { slot: 'Property_Loan_Summary', range: 'Interest_Only_Period', selector: num((a) => a.loan.ioMonths) },
  { slot: 'Property_Loan_Summary', range: 'Annual_Debt_Service',  selector: num((a) => a.metrics.annualDebtService) },
  // Conclusions & Escrows — value / cap-rate output.
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Cap_Rate',   selector: num((a) => a.metrics.capRate) },
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Value',      selector: num((a) => a.metrics.impliedValue) },
];

// --- Managed namespace policy (v6) ------------------------------------------
// The artifact's defined-name vocabulary is human-named without a prefix
// scheme. The managed namespace declares each schema name as a literal; no
// prefixes are claimed. excludedSheets covers artifact sheets we do not
// project into.
const SHARED_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  literals: SHARED_TEN_TAB_ENTRIES.map((e) => e.range),
  excludedSheets: [
    'Start Page',
    'Cover Page',
    '10 Yr Pro Forma',
    'Rent Roll',
    'Presentation Rent Roll',
    'Rent Roll Summary',
    'Rent Roll Footnotes',
    'Broker Interview',
    'Pictures',
    'Maps',
    'Addendum',
    'Detailed Rollover',
    'Amortization Schedule',
    'Controls',
  ],
};

// --- Table layouts ----------------------------------------------------------
// v6 ships no canonical drivers-table layout. The artifact has no reserved
// rows for a cross-check drivers table; locating one without visual
// inspection risks overwriting existing user content. Drivers can be added
// in a later bump once a target range is identified.
const V6_TABLE_LAYOUTS: TableLayout[] = [];

// --- Variant schema definitions ---------------------------------------------
// Each SchemaDefinition declares which underwritingModes it serves. For a
// given (contractVersion, assetClass, variantKey), the modes declared across
// the variant's definition list MUST partition the full UnderwritingMode set
// — every mode covered exactly once. The well-formedness check enforces this.
interface SchemaDefinition {
  /**
   * The modes this definition serves. ['single_loan', 'roll_up'] = shared.
   * A definition that lists exactly one mode is mode-specific; one that
   * lists multiple is shared (and the structural surface is identical for
   * all listed modes — the fingerprint differs only because the mode is
   * folded into the snapshot).
   */
  underwritingModes: UnderwritingMode[];
  visibleTabs: string[];
  entries: SchemaEntry[];
  tableLayouts: TableLayout[];
  managedNamespace: ManagedNamespacePolicy;
}

type ContractSchema = Record<
  AssetType,
  Partial<Record<StructuralVariantKey, SchemaDefinition[]>>
>;

/**
 * The shared 12-slot definition serves BOTH single_loan and roll_up.
 * Per-asset-class divergence (Property Detail variants; Operating ProForma
 * vs Hotel Op variant) is resolved by the SHEET_MAPPING boundary in
 * tabsFor() and sheet() — the schema entries themselves stay unified.
 */
function sharedTenTabDefinition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: SHARED_TEN_TAB_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: SHARED_MANAGED_NAMESPACE,
  };
}

function defsFor(assetClass: AssetType): SchemaDefinition[] {
  // Today every variant uses the same shared definition. Variants that need
  // a mode-specific surface in the future can ship a `[shared, modeSpecific]`
  // pair or a fully-split list — provided the modes partition the full set.
  return [sharedTenTabDefinition(assetClass)];
}

// --- v7 SCHEMA ENTRIES ------------------------------------------------------
// Per the v7 field-authority migration spec. Each entry declares EXACTLY
// ONE source surface (no mixed-source cells, no implicit fallback chains
// in schema). Fallback policy where the spec permits it (loan term) lives
// in the hydration layer — see hydrate-underwriting-context.ts.
//
// Cells deferred from this v7 slice (artifact has no named ranges for them):
//   - Total_Square_Feet (no PL or Property Detail named range)
//   - Units             (no Property Detail named range)
//   - CMBS_Comps_Refs   (the comp sheets carry only #REF! dead names)
// These fields exist on resolvedContext.{property,comparablesLinkageRefs}
// today; the v7 slice will register addresses for them once the artifact
// ships matching named ranges.
const V7_SHARED_ENTRIES: SchemaEntry[] = [
  // --- Property block (resolvedContext-only authority) ---
  { slot: 'Property_Loan_Summary', range: 'Property_Name',     selector: ctx((c) => c.property.name) },
  { slot: 'Property_Loan_Summary', range: 'Address',           selector: ctx((c) => c.property.street) },
  { slot: 'Property_Loan_Summary', range: 'City',              selector: ctx((c) => c.property.city) },
  { slot: 'Property_Loan_Summary', range: 'State',             selector: ctx((c) => c.property.state) },
  { slot: 'Property_Loan_Summary', range: 'ZIP',               selector: ctx((c) => c.property.zip) },
  { slot: 'Property_Loan_Summary', range: 'County',            selector: ctx((c) => c.property.county) },
  { slot: 'Property_Loan_Summary', range: 'Property_Type',     selector: ctx((c) => c.property.type) },
  { slot: 'Property_Loan_Summary', range: 'Year_Built',        selector: ctx((c) => c.property.yearBuilt) },
  { slot: 'Property_Loan_Summary', range: 'Occupancy',         selector: ctx((c) => c.property.occupancy) },
  { slot: 'Property_Loan_Summary', range: 'Ownership_Interest',selector: ctx((c) => c.property.ownershipInterest) },

  // --- Loan block (hybrid authority — single-sourced per cell) ---
  // adjustedInputs-authoritative cells (carried over from v6):
  { slot: 'Property_Loan_Summary', range: 'Current_Balance',     selector: num((a) => a.loan.loanAmount) },
  { slot: 'Property_Loan_Summary', range: 'Original_Balance',    selector: num((a) => a.loan.loanAmount) },
  { slot: 'Property_Loan_Summary', range: 'Coupon',              selector: num((a) => a.loan.interestRate) },
  { slot: 'Property_Loan_Summary', range: 'Annual_Debt_Service', selector: num((a) => a.metrics.annualDebtService) },
  // resolvedContext-authoritative cells (months → years for cell display):
  // Term: hydrator falls back to AdjustedInputs when extraction missing.
  // Amort / IO: extraction-only per spec (no fallback in hydrator).
  { slot: 'Property_Loan_Summary', range: 'Balloon_Term',        selector: ctxLoanMonthsToYears((l) => l.termMonths) },
  { slot: 'Property_Loan_Summary', range: 'Amortization_Term',   selector: ctxLoanMonthsToYears((l) => l.amortizationMonths) },
  { slot: 'Property_Loan_Summary', range: 'Interest_Only_Period',selector: ctx((c) => c.loan.ioMonths) },

  // --- Valuation block (adjustedInputs-only authority, carry-over) ---
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Cap_Rate',  selector: num((a) => a.metrics.capRate) },
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Value',     selector: num((a) => a.metrics.impliedValue) },

  // --- Party block (resolvedContext-only authority) ---
  { slot: 'Borrower',              range: 'Borrower',            selector: ctx((c) => c.parties.borrowerName) },
  { slot: 'Borrower',              range: 'Sponsor',             selector: ctx((c) => c.parties.sponsorName) },
];

const V7_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  literals: V7_SHARED_ENTRIES.map((e) => e.range),
  excludedSheets: [...SHARED_MANAGED_NAMESPACE.excludedSheets],
};

function v7Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V7_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V7_MANAGED_NAMESPACE,
  };
}

function v7DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v7Definition(assetClass)];
}

const SCHEMA_V6: ContractSchema = {
  office: {
    office_core:       defsFor('office'),
    office_trophy:     defsFor('office'),
    office_value_add:  defsFor('office'),
    office_distressed: defsFor('office'),
  },
  multifamily: {
    mf_core:        defsFor('multifamily'),
    mf_large_scale: defsFor('multifamily'),
    mf_workforce:   defsFor('multifamily'),
    mf_value_add:   defsFor('multifamily'),
  },
  industrial: {
    ind_core:      defsFor('industrial'),
    ind_logistics: defsFor('industrial'),
    ind_light:     defsFor('industrial'),
  },
  retail:               { retail_core:               defsFor('retail') },
  hotel:                { hotel_core:                defsFor('hotel') },
  self_storage:         { self_storage_core:         defsFor('self_storage') },
  mixed_use:            { mixed_use_core:            defsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: defsFor('manufactured_housing') },
};

const SCHEMA_V7: ContractSchema = {
  office: {
    office_core:       v7DefsFor('office'),
    office_trophy:     v7DefsFor('office'),
    office_value_add:  v7DefsFor('office'),
    office_distressed: v7DefsFor('office'),
  },
  multifamily: {
    mf_core:        v7DefsFor('multifamily'),
    mf_large_scale: v7DefsFor('multifamily'),
    mf_workforce:   v7DefsFor('multifamily'),
    mf_value_add:   v7DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v7DefsFor('industrial'),
    ind_logistics: v7DefsFor('industrial'),
    ind_light:     v7DefsFor('industrial'),
  },
  retail:               { retail_core:               v7DefsFor('retail') },
  hotel:                { hotel_core:                v7DefsFor('hotel') },
  self_storage:         { self_storage_core:         v7DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v7DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v7DefsFor('manufactured_housing') },
};

/**
 * The complete contract-version → schema map. Older versions stay queryable
 * so templates registered against them keep rendering. RENDER_CONTRACT_VERSION
 * is the default for /render and new exports; templates may pin themselves to
 * any registered version.
 *
 * v5 was a 10-tab BP Spire layout indexed against synthetic sheet names
 * (Property_Loan_Summary, Conclusion_Escrows, etc.). It never matched any
 * shipped artifact and is intentionally retired at v6 — the schema now
 * conforms to `Blank UW Template.xlsm` directly. If a v5-pinned template
 * artifact ever ships, restore the v5 slice; do not change v6 to
 * accommodate it.
 *
 * INCREMENTAL MIGRATION POLICY (HARD INVARIANT, code-enforced):
 *   v6 is AdjustedInputs-driven. Selectors in SCHEMA_V6 entries MAY only
 *   read from `input.adjustedInputs`. resolvedContext reads are FORBIDDEN
 *   in v6 — the boot-time invariant `assertSchemaWellFormed` checks each
 *   selector's `__sources` tag against the per-version allowlist
 *   `ALLOWED_SOURCES_BY_VERSION`.
 *
 *   v7 (when it lands) will be UnderwritingContext-driven. v7's slice
 *   declares `'resolvedContext'` as an allowed source. The migration is
 *   GRADUAL — v7 cells move to resolvedContext field-by-field; cells that
 *   still source from AdjustedInputs in v7 keep working unchanged.
 *
 *   No dual-write. No conflicting authority. A given (contractVersion,
 *   cell-address) pair has exactly one source surface declared by its
 *   selector's tag. Switching a cell from AdjustedInputs to
 *   resolvedContext requires bumping its contract version.
 *
 *   AdjustedInputs is NOT deprecated. The hydration layer
 *   (hydrate-underwriting-context.ts) reads AdjustedInputs as a
 *   precedence input for the loan-atom fallback chain on
 *   UnderwritingContext, but the schema layer continues to consume
 *   AdjustedInputs directly for v6 cells.
 */
const SCHEMA_BY_CONTRACT_VERSION: Readonly<Record<number, ContractSchema>> = {
  6: SCHEMA_V6,
  7: SCHEMA_V7,
};

// --- Hard-error type ---------------------------------------------------------
export class RenderSchemaError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RenderSchemaError';
    this.code = code;
    this.details = details;
  }
}

function getContractSchema(contractVersion: number): ContractSchema {
  const slice = SCHEMA_BY_CONTRACT_VERSION[contractVersion];
  if (!slice) {
    throw new RenderSchemaError(
      'CONTRACT_VERSION_UNKNOWN',
      `No schema registered for contractVersion=${contractVersion}.`,
      {
        contractVersion,
        registeredContractVersions: getRegisteredContractVersions(),
      },
    );
  }
  return slice;
}

/** Every contract version the schema can render against. */
export function getRegisteredContractVersions(): number[] {
  return Object.keys(SCHEMA_BY_CONTRACT_VERSION)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

function definitionFor(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): SchemaDefinition {
  const variants = getContractSchema(contractVersion)[assetClass];
  const defs = variants?.[variantKey];
  if (!defs || defs.length === 0) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_UNKNOWN',
      `No schema registered for (contractVersion=${contractVersion}, assetClass=${assetClass}, structuralVariantKey=${variantKey}).`,
      {
        contractVersion,
        assetClass,
        structuralVariantKey: variantKey,
        underwritingMode,
        validVariantKeys: variants ? Object.keys(variants).sort() : [],
      },
    );
  }
  const def = defs.find((d) => d.underwritingModes.includes(underwritingMode));
  if (!def) {
    const declared = defs.flatMap((d) => d.underwritingModes).sort();
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_UNKNOWN',
      `No schema registered for (contractVersion=${contractVersion}, assetClass=${assetClass}, structuralVariantKey=${variantKey}, underwritingMode=${underwritingMode}).`,
      {
        contractVersion,
        assetClass,
        structuralVariantKey: variantKey,
        underwritingMode,
        validModesForVariant: declared,
      },
    );
  }
  return def;
}

// --- Module-init invariant: every registered version is well-formed ---------
function assertSchemaWellFormed(): void {
  const allTypes = Object.keys(ASSET_CLASS_PREFIX) as AssetType[];
  const allModes: UnderwritingMode[] = ['single_loan', 'roll_up'];
  for (const cv of getRegisteredContractVersions()) {
    const slice = SCHEMA_BY_CONTRACT_VERSION[cv];
    const declared = Object.keys(slice) as AssetType[];
    const missing = allTypes.filter((a) => !(a in slice));
    const extra = declared.filter((a) => !(a in ASSET_CLASS_PREFIX));
    if (missing.length || extra.length) {
      throw new RenderSchemaError(
        'SCHEMA_ASSET_CLASS_MISMATCH',
        `ASSET_CLASS_PREFIX and SCHEMA_BY_CONTRACT_VERSION[${cv}] must declare the same asset classes.`,
        { contractVersion: cv, missing, extra },
      );
    }
    for (const ac of allTypes) {
      const variants = slice[ac];
      const variantKeys = Object.keys(variants) as StructuralVariantKey[];
      if (variantKeys.length === 0) {
        throw new RenderSchemaError(
          'SCHEMA_VARIANT_MISSING',
          `Asset class ${ac} declares no structural variants in contractVersion=${cv}.`,
          { contractVersion: cv, assetClass: ac },
        );
      }
      for (const vk of variantKeys) {
        const defs = variants[vk];
        if (!defs || defs.length === 0) {
          throw new RenderSchemaError(
            'SCHEMA_VARIANT_EMPTY',
            `Variant ${vk} (assetClass=${ac}, contractVersion=${cv}) declares no SchemaDefinitions.`,
            { contractVersion: cv, assetClass: ac, structuralVariantKey: vk },
          );
        }
        // Mode-partition check: union of underwritingModes across defs MUST
        // equal allModes, with no duplicates across defs.
        const seenModes = new Set<UnderwritingMode>();
        for (const def of defs) {
          if (!def.underwritingModes || def.underwritingModes.length === 0) {
            throw new RenderSchemaError(
              'SCHEMA_DEFINITION_HAS_NO_MODES',
              `A SchemaDefinition for variant ${vk} (assetClass=${ac}, contractVersion=${cv}) declares an empty underwritingModes list.`,
              { contractVersion: cv, assetClass: ac, structuralVariantKey: vk },
            );
          }
          for (const m of def.underwritingModes) {
            if (seenModes.has(m)) {
              throw new RenderSchemaError(
                'SCHEMA_MODE_DUPLICATE',
                `underwritingMode=${m} is served by more than one SchemaDefinition for variant ${vk} (assetClass=${ac}, contractVersion=${cv}). Each mode must be served by exactly one definition.`,
                { contractVersion: cv, assetClass: ac, structuralVariantKey: vk, mode: m },
              );
            }
            seenModes.add(m);
          }
        }
        const missingModes = allModes.filter((m) => !seenModes.has(m));
        if (missingModes.length) {
          throw new RenderSchemaError(
            'SCHEMA_MODE_MISSING',
            `Variant ${vk} (assetClass=${ac}, contractVersion=${cv}) is missing SchemaDefinitions for underwritingModes: ${missingModes.join(', ')}.`,
            { contractVersion: cv, assetClass: ac, structuralVariantKey: vk, missingModes },
          );
        }
        for (const def of defs) {
          const modeLabel = def.underwritingModes.join('+');
          const seen = new Set<string>();
          for (const e of def.entries) {
            if (!e.range || !/^[A-Za-z_][A-Za-z0-9_]*$|^[A-Z]+\d+$/.test(e.range)) {
              throw new RenderSchemaError(
                'SCHEMA_INVALID_RANGE',
                `Invalid range "${e.range}" in v${cv}/${ac}/${vk}/[${modeLabel}] schema (slot=${e.slot}).`,
                { contractVersion: cv, assetClass: ac, structuralVariantKey: vk, underwritingModes: def.underwritingModes, slot: e.slot, range: e.range },
              );
            }
            const addr = `${sheet(ac, e.slot)}!${e.range}`;
            if (seen.has(addr)) {
              throw new RenderSchemaError(
                'SCHEMA_DUPLICATE_ADDRESS',
                `Duplicate schema address ${addr} for v${cv}/${ac}/${vk}/[${modeLabel}].`,
                { contractVersion: cv, assetClass: ac, structuralVariantKey: vk, underwritingModes: def.underwritingModes, address: addr },
              );
            }
            seen.add(addr);
          }
        }
      }
    }
  }
  // Provenance guard #1 (boot-time): no schema entry's range may declare a
  // forbidden debug / ingestion / filesystem-provenance token. Aggregates
  // every entry across every (cv, ac, vk, mode) and audits in one pass —
  // catches a forbidden token even if introduced in a single variant.
  // Substring match (case-insensitive) — these tokens are never legitimate
  // output cell names. Mirror of FORBIDDEN_RANGE_TOKENS in
  // render-output-scrubber.ts; duplicated here to avoid import cycles
  // (the scrubber imports RenderSchemaError from this module).
  const FORBIDDEN_TOKENS_BOOT = [
    'file_path', 'filepath', 'source_file', 'sourcefile',
    'document_origin', 'doc_origin', 'ingestion_trace', 'ingest_trace',
    'ingestion_path', 'ingest_path', 'origin_path', 'upload_path',
    'source_path', 'parser_trace', 'extraction_trace', 'debug_trace',
    '_debug', '_trace',
  ];
  const provenanceViolations: Array<{ address: string; token: string }> = [];
  for (const cv of getRegisteredContractVersions()) {
    const slice = SCHEMA_BY_CONTRACT_VERSION[cv];
    for (const ac of Object.keys(slice) as AssetType[]) {
      const variants = slice[ac];
      for (const vk of Object.keys(variants) as StructuralVariantKey[]) {
        const defs = variants[vk];
        if (!defs) continue;
        for (const def of defs) {
          for (const e of def.entries) {
            const addr = `${sheet(ac, e.slot)}!${e.range}`;
            const lower = addr.toLowerCase();
            for (const token of FORBIDDEN_TOKENS_BOOT) {
              if (lower.includes(token)) {
                provenanceViolations.push({ address: addr, token });
                break;
              }
            }
          }
        }
      }
    }
  }
  if (provenanceViolations.length) {
    throw new RenderSchemaError(
      'SCHEMA_FORBIDDEN_PROVENANCE_RANGE',
      `Schema declares ${provenanceViolations.length} address(es) with forbidden provenance / debug tokens. These can never be written to a visible Excel cell. Move debug data to logs or analysis.metadata.`,
      { violations: provenanceViolations, forbiddenTokens: FORBIDDEN_TOKENS_BOOT },
    );
  }

  // --- Per-version source-surface policy (incremental migration policy) ---
  // Encodes the architectural decision that each contract version reads
  // from a SPECIFIC set of input surfaces. The migration model is:
  //   v6 = AdjustedInputs-driven. resolvedContext reads forbidden.
  //   v7 = UnderwritingContext-driven (gradual). resolvedContext permitted;
  //        AdjustedInputs reads still permitted so v6 fields can be carried
  //        forward without rewrite.
  //
  // The policy is enforced at boot — adding a SchemaEntry to v6 whose
  // selector reads from resolvedContext fails immediately. Adding v7 (when
  // it lands) requires extending the map below.
  //
  // This is the code-level expression of the "no dual-write, no conflicting
  // authority" rule: a v6 cell cannot be sourced from UnderwritingContext,
  // and a v7 cell cannot accidentally fall back to AdjustedInputs without
  // an explicit declaration.
  const ALLOWED_SOURCES_BY_VERSION: Readonly<Record<number, ReadonlySet<SourceSurface>>> = {
    6: new Set<SourceSurface>(['adjustedInputs']),
    7: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta']),
  };

  const sourceViolations: Array<{
    contractVersion: number;
    address: string;
    actualSources: string[];
    allowedSources: string[];
  }> = [];
  for (const cv of getRegisteredContractVersions()) {
    const allowed = ALLOWED_SOURCES_BY_VERSION[cv];
    if (!allowed) {
      throw new RenderSchemaError(
        'SCHEMA_VERSION_HAS_NO_SOURCE_POLICY',
        `contractVersion=${cv} is registered in SCHEMA_BY_CONTRACT_VERSION but has no entry in ALLOWED_SOURCES_BY_VERSION. Adding a new contract version requires declaring its allowed source surfaces.`,
        { contractVersion: cv, registeredContractVersions: getRegisteredContractVersions() },
      );
    }
    const slice = SCHEMA_BY_CONTRACT_VERSION[cv];
    for (const ac of Object.keys(slice) as AssetType[]) {
      const variants = slice[ac];
      for (const vk of Object.keys(variants) as StructuralVariantKey[]) {
        const defs = variants[vk];
        if (!defs) continue;
        for (const def of defs) {
          for (const e of def.entries) {
            const sel = e.selector as TaggedSelector;
            const actual = sel.__sources;
            if (!actual) {
              throw new RenderSchemaError(
                'SCHEMA_SELECTOR_UNTAGGED',
                `SchemaEntry selector for v${cv}/${ac}/${vk}/${e.range} is not tagged with a SourceSurface set. Wrap with tagSelector() declaring its source surfaces.`,
                { contractVersion: cv, assetClass: ac, structuralVariantKey: vk, range: e.range },
              );
            }
            for (const s of actual) {
              if (!allowed.has(s)) {
                sourceViolations.push({
                  contractVersion: cv,
                  address: `${sheet(ac, e.slot)}!${e.range}`,
                  actualSources: [...actual].sort(),
                  allowedSources: [...allowed].sort(),
                });
                break;
              }
            }
          }
        }
      }
    }
  }
  if (sourceViolations.length) {
    throw new RenderSchemaError(
      'SCHEMA_FORBIDDEN_SOURCE_FOR_VERSION',
      `Schema entries declare source surfaces not permitted by their contract version. v6 must remain AdjustedInputs-driven; resolvedContext reads enter at v7+ only.`,
      { violations: sourceViolations },
    );
  }

  // --- Field-migration governance: per-version state declarations ---------
  // Spec: every shipped schema cell MUST appear in the field-state
  // registry, the declared state's REQUIRED_SOURCE_BY_STATE must match
  // the selector's __sources tag, and cross-version state changes must
  // follow LEGAL_TRANSITIONS (or be in GRANDFATHERED_TRANSITIONS).
  assertFieldStatesConsistentWithSchema(
    SCHEMA_BY_CONTRACT_VERSION,
    sheet,
  );
}
assertSchemaWellFormed();

// --- Field-state ↔ schema invariant -----------------------------------------
function assertFieldStatesConsistentWithSchema(
  schemaByCv: Readonly<Record<number, ContractSchema>>,
  sheetFn: (ac: AssetType, slot: SheetSlot) => string,
): void {
  // Lazy-import to avoid circular deps at module-init time.
  // field-migration-state.ts only imports a *type* from this module
  // (`SourceSurface`), not values, so the cycle is type-only — but we
  // require the runtime-reachable bindings here.
  const {
    REQUIRED_SOURCE_BY_STATE,
    getFieldStateRegistryForVersion,
    getFieldState,
    isLegalTransition,
  } = require('./field-migration-state.js') as typeof import('./field-migration-state.js');

  const allViolations: Array<Record<string, unknown>> = [];

  for (const cv of getRegisteredContractVersions()) {
    const slice = schemaByCv[cv];
    const declared = new Set<string>();
    for (const decl of getFieldStateRegistryForVersion(cv)) declared.add(decl.address);

    const observed = new Set<string>();
    for (const ac of Object.keys(slice) as AssetType[]) {
      const variants = slice[ac];
      for (const vk of Object.keys(variants) as StructuralVariantKey[]) {
        const defs = variants[vk];
        if (!defs) continue;
        for (const def of defs) {
          for (const e of def.entries) {
            const addr = `${sheetFn(ac, e.slot)}!${e.range}`;
            observed.add(addr);

            const decl = getFieldState(addr, cv);
            if (!decl) {
              allViolations.push({
                kind: 'FIELD_STATE_NOT_DECLARED',
                contractVersion: cv,
                address: addr,
              });
              continue;
            }

            const required = REQUIRED_SOURCE_BY_STATE[decl.state];
            const actualSources = (e.selector as TaggedSelector).__sources;
            if (!actualSources || !actualSources.has(required)) {
              allViolations.push({
                kind: 'FIELD_STATE_SOURCE_MISMATCH',
                contractVersion: cv,
                address: addr,
                declaredState: decl.state,
                requiredSource: required,
                actualSources: actualSources ? [...actualSources] : [],
              });
            }
          }
        }
      }
    }

    // Registry must not declare states for cells the schema doesn't render.
    for (const addr of declared) {
      if (!observed.has(addr)) {
        allViolations.push({
          kind: 'FIELD_STATE_DECLARED_NOT_RENDERED',
          contractVersion: cv,
          address: addr,
        });
      }
    }
  }

  // Cross-version transition check. For each cell, walk consecutive
  // registered versions; if the cell appears in both, the (prev, curr)
  // state pair must be a legal transition.
  const versions = getRegisteredContractVersions();
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1];
    const curr = versions[i];
    const prevDecls = getFieldStateRegistryForVersion(prev);
    for (const pd of prevDecls) {
      const cd = getFieldState(pd.address, curr);
      if (!cd) continue; // cell removed at curr
      if (!isLegalTransition(pd.state, cd.state, pd.address, prev, curr)) {
        allViolations.push({
          kind: 'FIELD_STATE_ILLEGAL_TRANSITION',
          address: pd.address,
          fromVersion: prev,
          toVersion: curr,
          fromState: pd.state,
          toState: cd.state,
        });
      }
    }
  }

  if (allViolations.length) {
    throw new RenderSchemaError(
      'FIELD_STATE_GOVERNANCE_VIOLATION',
      `Field-state governance check failed. ${allViolations.length} violation(s). Adding a new schema entry requires a matching FIELD_STATE_REGISTRY entry; cross-version state changes must follow LEGAL_TRANSITIONS or be GRANDFATHERED.`,
      { violations: allViolations },
    );
  }
}

/**
 * Project a ProjectionInput (RenderInput + pre-resolved underwriting
 * context) into the complete cellBindings map for its
 * (asset class, structural variant, underwriting mode) at the given contract
 * version. Pure projection — selectors do not branch.
 */
export function projectCellBindings(
  input: ProjectionInput,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): CellBindings {
  const def = definitionFor(
    input.assetClass,
    input.structuralVariantKey,
    input.underwritingMode,
    contractVersion,
  );
  const out: CellBindings = {};
  for (const e of def.entries) {
    const sheetName = sheet(input.assetClass, e.slot);
    const address = `${sheetName}!${e.range}`;
    out[address] = e.selector(input);
  }
  return out;
}

/**
 * Per-request invariant: bindings emitted by projectCellBindings must equal
 * (set-wise) the canonical schema addresses for the four-axis tuple. Any
 * drift — extra key, missing key, mistyped address — is a hard error.
 */
export function assertProjectionMatchesSchema(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  bindings: CellBindings,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): void {
  const expected = new Set(
    getSchemaAddresses(assetClass, variantKey, underwritingMode, contractVersion),
  );
  const actual = new Set(Object.keys(bindings));
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const k of expected) if (!actual.has(k)) missing.push(k);
  for (const k of actual) if (!expected.has(k)) unexpected.push(k);
  if (missing.length || unexpected.length) {
    throw new RenderSchemaError(
      'PROJECTION_SCHEMA_MISMATCH',
      `cellBindings does not match the declared schema for (contractVersion=${contractVersion}, assetClass=${assetClass}, structuralVariantKey=${variantKey}, underwritingMode=${underwritingMode}).`,
      { contractVersion, assetClass, structuralVariantKey: variantKey, underwritingMode, missing, unexpected },
    );
  }
}

export function getManagedNamespace(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): ManagedNamespacePolicy {
  const ns = definitionFor(assetClass, variantKey, underwritingMode, contractVersion).managedNamespace;
  return {
    prefixes: [...ns.prefixes],
    literals: [...ns.literals],
    excludedSheets: [...ns.excludedSheets],
  };
}

export function buildTables(
  input: RenderInput,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): TablePayload[] {
  const layouts = definitionFor(
    input.assetClass,
    input.structuralVariantKey,
    input.underwritingMode,
    contractVersion,
  ).tableLayouts;
  return layouts.map((layout) => {
    const rows = layout.name === 'drivers'
      ? input.drivers.map((d) => {
          const row: Record<string, CellValue> = {};
          for (const col of layout.columns) {
            const v = (d as unknown as Record<string, unknown>)[col.sourceField];
            row[col.sourceField] =
              v === undefined || v === null ? null :
              typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v :
              String(v);
          }
          return row;
        })
      : [];
    return { layout, rows };
  });
}

/**
 * All asset-class → variant-key → underwriting-mode → tabs (for
 * /render-config and the _Config sheet). When two modes share a definition
 * the per-mode tab list is the same — the consumer sees identical entries
 * keyed under each mode, which is what the workbook needs.
 */
export function getAssetClassVariantModeTabs(
  contractVersion: number = RENDER_CONTRACT_VERSION,
): Record<AssetType, Partial<Record<StructuralVariantKey, Partial<Record<UnderwritingMode, string[]>>>>> {
  const slice = getContractSchema(contractVersion);
  const out = {} as Record<AssetType, Partial<Record<StructuralVariantKey, Partial<Record<UnderwritingMode, string[]>>>>>;
  for (const ac of Object.keys(slice) as AssetType[]) {
    const variants = slice[ac];
    const tabs: Partial<Record<StructuralVariantKey, Partial<Record<UnderwritingMode, string[]>>>> = {};
    for (const vk of Object.keys(variants) as StructuralVariantKey[]) {
      const defs = variants[vk];
      if (!defs) continue;
      const modeTabs: Partial<Record<UnderwritingMode, string[]>> = {};
      for (const def of defs) {
        for (const m of def.underwritingModes) {
          modeTabs[m] = [...def.visibleTabs];
        }
      }
      tabs[vk] = modeTabs;
    }
    out[ac] = tabs;
  }
  return out;
}

/** Variants registered for a given asset class at the given contract version. */
export function getVariantsForAssetClass(
  assetClass: AssetType,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): StructuralVariantKey[] {
  const variants = getContractSchema(contractVersion)[assetClass];
  if (!variants) return [];
  return (Object.keys(variants) as StructuralVariantKey[]).sort();
}

/** Underwriting modes registered for an (assetClass, variantKey) pair. */
export function getModesForVariant(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): UnderwritingMode[] {
  const defs = getContractSchema(contractVersion)[assetClass]?.[variantKey];
  if (!defs) return [];
  const out = new Set<UnderwritingMode>();
  for (const d of defs) for (const m of d.underwritingModes) out.add(m);
  return [...out].sort();
}

/** Asset classes registered at the given contract version. */
export function getAssetClassesForContractVersion(
  contractVersion: number = RENDER_CONTRACT_VERSION,
): AssetType[] {
  return (Object.keys(getContractSchema(contractVersion)) as AssetType[]).sort();
}

export function getVisibleTabs(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): string[] {
  return [...definitionFor(assetClass, variantKey, underwritingMode, contractVersion).visibleTabs];
}

/**
 * Read-only enumeration of (address → declared source surfaces) for a
 * given (assetClass, variantKey, mode, contractVersion). Observability and
 * tooling call this to attribute each rendered cell to its source surface
 * without re-running the schema pipeline.
 *
 * The map's value is the same Set the per-version source-policy invariant
 * checks against — single-element for v6 (`{adjustedInputs}`) and v7
 * (single-sourced per cell).
 */
export function getSchemaSourcesByAddress(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): Map<string, ReadonlySet<SourceSurface>> {
  const def = definitionFor(assetClass, variantKey, underwritingMode, contractVersion);
  const out = new Map<string, ReadonlySet<SourceSurface>>();
  for (const e of def.entries) {
    const addr = `${sheet(assetClass, e.slot)}!${e.range}`;
    const sources = (e.selector as TaggedSelector).__sources ?? new Set<SourceSurface>();
    out.set(addr, sources);
  }
  return out;
}

/** Enumerate the schema (used by validation, tests, dump-script, _Config). */
export function getSchemaAddresses(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): string[] {
  return definitionFor(assetClass, variantKey, underwritingMode, contractVersion)
    .entries.map((e) => `${sheet(assetClass, e.slot)}!${e.range}`)
    .sort();
}

// --- Structural identity (deterministic-replayability gate) -----------------
// Hard rule (memory/architecture_render_versioning.md):
//   Two renders sharing the same (contractVersion, assetClass,
//   structuralVariantKey, underwritingMode) MUST produce identical structural
//   output — visibleTabs, schemaAddresses, managedNamespace, table layouts.
//   Cell *values* depend on the deal; cell *structure* depends only on the
//   four-axis tuple.

interface TableLayoutSignature {
  name: string;
  sheetName: string;
  headerRow: number;
  dataStartRow: number;
  columns: Array<{ header: string; sourceField: string }>;
}

interface StructuralSnapshot {
  assetClass: AssetType;
  contractVersion: number;
  structuralVariantKey: StructuralVariantKey;
  underwritingMode: UnderwritingMode;
  visibleTabs: string[];
  schemaAddresses: string[];
  managedNamespace: {
    prefixes: string[];
    literals: string[];
    excludedSheets: string[];
  };
  tableLayouts: TableLayoutSignature[];
}

function layoutSignature(l: TableLayout): TableLayoutSignature {
  return {
    name: l.name,
    sheetName: l.sheetName,
    headerRow: l.headerRow,
    dataStartRow: l.dataStartRow,
    columns: l.columns.map((c) => ({ header: c.header, sourceField: c.sourceField })),
  };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function fingerprintFromSnapshot(snap: StructuralSnapshot): string {
  return createHash('sha256').update(stableStringify(snap)).digest('hex');
}

export function getCanonicalStructuralSnapshot(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): StructuralSnapshot {
  const def = definitionFor(assetClass, variantKey, underwritingMode, contractVersion);
  return {
    assetClass,
    contractVersion,
    structuralVariantKey: variantKey,
    underwritingMode,
    visibleTabs: [...def.visibleTabs],
    schemaAddresses: getSchemaAddresses(assetClass, variantKey, underwritingMode, contractVersion),
    managedNamespace: {
      prefixes: [...def.managedNamespace.prefixes],
      literals: [...def.managedNamespace.literals],
      excludedSheets: [...def.managedNamespace.excludedSheets],
    },
    tableLayouts: def.tableLayouts.map(layoutSignature),
  };
}

const CANONICAL_FINGERPRINTS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const cv of getRegisteredContractVersions()) {
    const slice = SCHEMA_BY_CONTRACT_VERSION[cv];
    for (const ac of Object.keys(slice) as AssetType[]) {
      for (const vk of getVariantsForAssetClass(ac, cv)) {
        for (const mode of getModesForVariant(ac, vk, cv)) {
          out[fingerprintKey(ac, vk, mode, cv)] = fingerprintFromSnapshot(
            getCanonicalStructuralSnapshot(ac, vk, mode, cv),
          );
        }
      }
    }
  }
  return Object.freeze(out);
})();

function fingerprintKey(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number,
): string {
  return `${contractVersion}|${assetClass}|${variantKey}|${underwritingMode}`;
}

export function getStructuralIdentity(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): StructuralIdentity {
  const fp = CANONICAL_FINGERPRINTS[fingerprintKey(assetClass, variantKey, underwritingMode, contractVersion)];
  if (!fp) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_UNKNOWN',
      `No canonical fingerprint for (contractVersion=${contractVersion}, assetClass=${assetClass}, structuralVariantKey=${variantKey}, underwritingMode=${underwritingMode}).`,
      { contractVersion, assetClass, structuralVariantKey: variantKey, underwritingMode },
    );
  }
  return {
    assetClass,
    contractVersion,
    structuralVariantKey: variantKey,
    underwritingMode,
    fingerprint: fp,
  };
}

export function getCanonicalFingerprints(): Readonly<Record<string, string>> {
  return CANONICAL_FINGERPRINTS;
}

function extractStructuralSnapshotFromPayload(payload: RenderPayload): StructuralSnapshot {
  return {
    assetClass: payload.assetClass,
    contractVersion: payload.contractVersion,
    structuralVariantKey: payload.structuralVariantKey,
    underwritingMode: payload.underwritingMode,
    visibleTabs: [...payload.visibleTabs],
    schemaAddresses: [...payload.schemaAddresses].sort(),
    managedNamespace: {
      prefixes: [...payload.managedNamespace.prefixes],
      literals: [...payload.managedNamespace.literals],
      excludedSheets: [...payload.managedNamespace.excludedSheets],
    },
    tableLayouts: payload.tables.map((t) => layoutSignature(t.layout)),
  };
}

/**
 * Per-render invariant: the payload's structural surface MUST match the
 * canonical snapshot for the four-axis tuple, AND the declared
 * structuralIdentity MUST equal the canonical values for THAT version.
 */
export function assertStructuralIdentity(payload: RenderPayload): void {
  if (!SCHEMA_BY_CONTRACT_VERSION[payload.contractVersion]) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_VERSION_UNKNOWN',
      `Payload contractVersion=${payload.contractVersion} is not registered in the schema.`,
      {
        payloadContractVersion: payload.contractVersion,
        registeredContractVersions: getRegisteredContractVersions(),
      },
    );
  }
  if (payload.structuralVariantKey !== payload.structuralIdentity.structuralVariantKey) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_VARIANT_DISAGREEMENT',
      `Payload top-level structuralVariantKey=${payload.structuralVariantKey} does not match structuralIdentity.structuralVariantKey=${payload.structuralIdentity.structuralVariantKey}.`,
      {
        topLevel: payload.structuralVariantKey,
        identity: payload.structuralIdentity.structuralVariantKey,
      },
    );
  }
  if (payload.underwritingMode !== payload.structuralIdentity.underwritingMode) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_MODE_DISAGREEMENT',
      `Payload top-level underwritingMode=${payload.underwritingMode} does not match structuralIdentity.underwritingMode=${payload.structuralIdentity.underwritingMode}.`,
      {
        topLevel: payload.underwritingMode,
        identity: payload.structuralIdentity.underwritingMode,
      },
    );
  }
  const canonical = getCanonicalStructuralSnapshot(
    payload.assetClass,
    payload.structuralVariantKey,
    payload.underwritingMode,
    payload.contractVersion,
  );
  const actual = extractStructuralSnapshotFromPayload(payload);
  const canonicalFp = CANONICAL_FINGERPRINTS[
    fingerprintKey(payload.assetClass, payload.structuralVariantKey, payload.underwritingMode, payload.contractVersion)
  ];
  const liveFp = fingerprintFromSnapshot(canonical);
  const actualFp = fingerprintFromSnapshot(actual);

  if (liveFp !== canonicalFp) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_DRIFT',
      `Live schema diverges from canonical fingerprint frozen at boot for (contractVersion=${payload.contractVersion}, assetClass=${payload.assetClass}, structuralVariantKey=${payload.structuralVariantKey}, underwritingMode=${payload.underwritingMode}). Schema was mutated without a contract bump.`,
      {
        contractVersion: payload.contractVersion,
        assetClass: payload.assetClass,
        structuralVariantKey: payload.structuralVariantKey,
        underwritingMode: payload.underwritingMode,
        frozenFingerprint: canonicalFp,
        liveFingerprint: liveFp,
      },
    );
  }
  if (actualFp !== canonicalFp) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_MISMATCH',
      `Render payload structure does not match canonical for (assetClass=${payload.assetClass}, contractVersion=${payload.contractVersion}, structuralVariantKey=${payload.structuralVariantKey}, underwritingMode=${payload.underwritingMode}).`,
      {
        assetClass: payload.assetClass,
        contractVersion: payload.contractVersion,
        structuralVariantKey: payload.structuralVariantKey,
        underwritingMode: payload.underwritingMode,
        canonicalFingerprint: canonicalFp,
        actualFingerprint: actualFp,
        canonical,
        actual,
      },
    );
  }
  const declared = payload.structuralIdentity;
  if (
    !declared ||
    declared.assetClass !== payload.assetClass ||
    declared.contractVersion !== payload.contractVersion ||
    declared.structuralVariantKey !== payload.structuralVariantKey ||
    declared.underwritingMode !== payload.underwritingMode ||
    declared.fingerprint !== canonicalFp
  ) {
    throw new RenderSchemaError(
      'STRUCTURAL_IDENTITY_FINGERPRINT_MISMATCH',
      `Payload structuralIdentity does not match canonical (assetClass=${payload.assetClass}, contractVersion=${payload.contractVersion}, structuralVariantKey=${payload.structuralVariantKey}, underwritingMode=${payload.underwritingMode}).`,
      {
        declared,
        expected: {
          assetClass: payload.assetClass,
          contractVersion: payload.contractVersion,
          structuralVariantKey: payload.structuralVariantKey,
          underwritingMode: payload.underwritingMode,
          fingerprint: canonicalFp,
        },
      },
    );
  }
}
