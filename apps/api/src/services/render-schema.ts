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
import type { RentRoll, TenantRentRollLine } from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  AssetType,
  CellBindings,
  CellComment,
  CellCommentMap,
  CellState,
  CellStateMap,
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
  | 'Comparables_CMBS'
  | 'Rent_Roll'
  | 'Cover_Page'
  | 'Ten_Year_Pro_Forma';

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
  'Rent_Roll',
  'Cover_Page',
  'Ten_Year_Pro_Forma',
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
    case 'Rent_Roll':             return 'Rent Roll';
    case 'Cover_Page':            return 'Cover Page';
    case 'Ten_Year_Pro_Forma':    return '10 Yr Pro Forma';
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
  | 'libraryBaselineMeta'
  | 'rentRoll';

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
/**
 * A single schema entry — one cell the workbook will render.
 *
 * `cellState` (added in v8 — Phase B of the populated-workbook initiative)
 * classifies how the cell should be drawn:
 *   - 'concluded'      — engine value-add; no fill, no comment. DEFAULT.
 *   - 'hitl'           — deliberately blank, analyst input required;
 *                        gray fill + comment.
 *   - 'awaiting_input' — rule fired needing a manual input that doesn't
 *                        exist; red fill + comment.
 *
 * `comment` is consulted only when cellState is 'hitl' or 'awaiting_input'.
 * For 'concluded' it is ignored. The function receives the same
 * ProjectionInput the selector consumes and returns the comment text
 * (or null/undefined to skip emitting a comment).
 *
 * Both fields default to the 'concluded' / no-comment shape so every
 * v6 and v7 entry continues to render with identical behavior.
 */
interface SchemaEntry {
  slot: SheetSlot;
  range: string;
  selector: Selector;
  cellState?: CellState;
  comment?: (input: ProjectionInput) => string | null | undefined;
  /**
   * Engine-concluded direct-display flag. When `true`, the populator's
   * writeCellValue overwrites the existing formula with the selector's
   * literal value instead of preserving the formula. Used to display
   * engine-concluded figures into template cells that are formulas by
   * default (rent-roll-coupled or column-cascade formulas) — the J/L
   * "fill leaves, let subtotals compute" pattern, but for column P
   * where the template's leaf cells are FORMULAS rather than inputs.
   *
   * NEVER set on cells whose formula correctly produces the desired
   * value (subtotals like P17/P33/P35 — those stay as formulas and
   * compute from the leaves we wrote). Set ONLY on the 16 P-column
   * leaf cells that need to display engine-concluded line items.
   */
  forceOverwrite?: boolean;
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
  { slot: 'Property_Loan_Summary', range: 'Current_Balance',      selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Original_Balance',     selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  // Coupon and Amortization_Term: the CRE convention in this workbook is
  // decimal interest (0.0716 → "7.16%") and amortization in YEARS (30, not
  // 360 months). Unit conversion lives at the producer (adapter) for
  // interestRate and at the selector for amortization (schema declares the
  // shape of the cell value the artifact expects).
  { slot: 'Property_Loan_Summary', range: 'Coupon',               selector: num((a) => a.loan.interestRate),          cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Amortization_Term',    selector: amortizationYears,                        cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Interest_Only_Period', selector: num((a) => a.loan.ioMonths),              cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Annual_Debt_Service',  selector: num((a) => a.metrics.annualDebtService),  cellState: 'concluded' },
  // Conclusions & Escrows — value / cap-rate output.
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Cap_Rate',   selector: num((a) => a.metrics.capRate),            cellState: 'concluded' },
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Value',      selector: num((a) => a.metrics.impliedValue),       cellState: 'concluded' },
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
  { slot: 'Property_Loan_Summary', range: 'Property_Name',     selector: ctx((c) => c.property.name),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Address',           selector: ctx((c) => c.property.street),              cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'City',              selector: ctx((c) => c.property.city),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'State',             selector: ctx((c) => c.property.state),               cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'ZIP',               selector: ctx((c) => c.property.zip),                 cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'County',            selector: ctx((c) => c.property.county),              cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Property_Type',     selector: ctx((c) => c.property.type),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Year_Built',        selector: ctx((c) => c.property.yearBuilt),           cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Occupancy',         selector: ctx((c) => c.property.occupancy),           cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Ownership_Interest',selector: ctx((c) => c.property.ownershipInterest),   cellState: 'concluded' },

  // --- Loan block (hybrid authority — single-sourced per cell) ---
  // adjustedInputs-authoritative cells (carried over from v6):
  { slot: 'Property_Loan_Summary', range: 'Current_Balance',     selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Original_Balance',    selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Coupon',              selector: num((a) => a.loan.interestRate),          cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Annual_Debt_Service', selector: num((a) => a.metrics.annualDebtService),  cellState: 'concluded' },
  // resolvedContext-authoritative cells (months → years for cell display):
  // Term: hydrator falls back to AdjustedInputs when extraction missing.
  // Amort / IO: extraction-only per spec (no fallback in hydrator).
  { slot: 'Property_Loan_Summary', range: 'Balloon_Term',        selector: ctxLoanMonthsToYears((l) => l.termMonths),         cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Amortization_Term',   selector: ctxLoanMonthsToYears((l) => l.amortizationMonths), cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Interest_Only_Period',selector: ctx((c) => c.loan.ioMonths),              cellState: 'concluded' },

  // --- Valuation block (adjustedInputs-only authority, carry-over) ---
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Cap_Rate',  selector: num((a) => a.metrics.capRate),            cellState: 'concluded' },
  { slot: 'Conclusion_Escrows',    range: 'Concluded_Value',     selector: num((a) => a.metrics.impliedValue),       cellState: 'concluded' },

  // --- Party block (resolvedContext-only authority) ---
  { slot: 'Borrower',              range: 'Borrower',            selector: ctx((c) => c.parties.borrowerName),       cellState: 'concluded' },
  { slot: 'Borrower',              range: 'Sponsor',             selector: ctx((c) => c.parties.sponsorName),        cellState: 'concluded' },
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

// --- v8 SCHEMA ENTRIES ------------------------------------------------------
// v8 is the populated-workbook initiative's Phase-B SHAPE bump. Per the
// brief: no new cells. v8 is structurally identical to v7 — every entry
// is carried forward verbatim — but the RenderPayload contract now
// carries `cellStates` and `cellComments` parallel maps and
// RenderConservatismStatus carries a `floorBindings` array. v8 entries
// continue to render at cellState='concluded' (the v7 behavior), so the
// rendered workbook surface is byte-identical to v7 today. Cells that
// will mark `hitl` or `awaiting_input` will be added in subsequent
// phases that gate on the GATE diff.
const V8_SHARED_ENTRIES: SchemaEntry[] = V7_SHARED_ENTRIES.map((e) => ({ ...e }));

const V8_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  literals: V8_SHARED_ENTRIES.map((e) => e.range),
  excludedSheets: [...SHARED_MANAGED_NAMESPACE.excludedSheets],
};

function v8Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V8_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V8_MANAGED_NAMESPACE,
  };
}

function v8DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v8Definition(assetClass)];
}

const SCHEMA_V8: ContractSchema = {
  office: {
    office_core:       v8DefsFor('office'),
    office_trophy:     v8DefsFor('office'),
    office_value_add:  v8DefsFor('office'),
    office_distressed: v8DefsFor('office'),
  },
  multifamily: {
    mf_core:        v8DefsFor('multifamily'),
    mf_large_scale: v8DefsFor('multifamily'),
    mf_workforce:   v8DefsFor('multifamily'),
    mf_value_add:   v8DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v8DefsFor('industrial'),
    ind_logistics: v8DefsFor('industrial'),
    ind_light:     v8DefsFor('industrial'),
  },
  retail:               { retail_core:               v8DefsFor('retail') },
  hotel:                { hotel_core:                v8DefsFor('hotel') },
  self_storage:         { self_storage_core:         v8DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v8DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v8DefsFor('manufactured_housing') },
};

// --- v9 SCHEMA ENTRIES ------------------------------------------------------
// Phase A of the populated-workbook initiative. v9 ADDS schema entries; no
// payload-shape changes (v8 already shipped cellStates + cellComments +
// floorBindings). Every cell-by-cell classification below is pre-approved
// from the Sunroad GATE diff:
//
//   CONCLUDED — engine value-add; no fill, no comment. Operating ProForma
//     P-column ("Eightfold Concluded") fills plus DSCR / Debt Yield in
//     Conclusions & Escrows. After the loan-terms fix re-run, DSCR and
//     Debt Yield diff clean against the answer key (DSCR 1.343 NOI vs
//     engine; Debt Yield 0.106 vs engine — both within ±5% band).
//
//   AWAITING_INPUT — red fill + comment naming the gap. Five "dangerous
//     expense" cells (utilities, G&A, insurance, TI, LC) pending the
//     expense-markup value-add rule. Concluded_Cap_Rate and Concluded_Value
//     FLIP from v8 'concluded' to v9 'awaiting_input' because the library
//     median cap rate is optimistic vs analyst-concluded on Sunroad and
//     the value chain inherits the optimism. Extraction gaps
//     (LTV_Appraisal, NCF_DSCR, Net_Rentable_Area, Property_Building_Class)
//     surface their specific blockers.
//
//   HELD — explicitly NOT in the schema (NOI, NCF, EGI, Total OpEx).
//     Per the GATE diff these rollups match the answer key only by
//     coincidental cancellation of unresolved errors (vacancy floor binding
//     up + expense markup down). Adding them as awaiting_input would
//     suggest the engine knows it should be here; silent omission is the
//     correct posture until both calibration tickets resolve.
//
// Sheet/cell mapping notes:
//   The Blank UW Template ships ~58 user defined names — almost all on the
//   Property & Loan Summary, Conclusions & Escrows, and Borrower tabs.
//   Operating ProForma cells have NO defined names; we use explicit A1
//   addresses (e.g. 'Operating History and Pro Forma'!P38 for replacement
//   reserves). A1 addresses are brittle vs sheet-row reflow but acceptable;
//   each one is documented inline.
//
// Source-tagging notes:
//   Awaiting_input selectors that return null still declare a source
//   surface — the source-policy boot check is per ALLOWED_SOURCES_BY_VERSION
//   and per FIELD_STATE_REGISTRY's REQUIRED_SOURCE_BY_STATE; null-valued
//   selectors are tagged 'adjustedInputs' (LEGACY state) by default.

/**
 * Vacancy as a fraction (0..1). Derived from
 * adjustedInputs.income.vacancyLoss.adjusted and
 * adjustedInputs.income.grossPotentialRent.adjusted. vacancyLoss is
 * stored as a negative number (loss), so the magnitude is |vacancyLoss|.
 * Returns null when GPR is zero / missing to avoid divide-by-zero.
 *
 * Floor-binding disclosure: on Sunroad the engine's vacancyPct equals the
 * library-median 0.10 (raised from source-derived ~3.4%) — the
 * conservatismStatus.floorBindings surfaces this so the cell value is
 * not read as source-derived.
 */
const vacancyPctSelector: Selector = tagSelector((input) => {
  const gpr = input.adjustedInputs.income.grossPotentialRent.adjusted;
  const vl = input.adjustedInputs.income.vacancyLoss.adjusted;
  if (!Number.isFinite(gpr) || gpr === 0) return null;
  return Math.abs(vl) / gpr;
}, ['adjustedInputs']);

/** Selector returning the constant null. Used by AWAITING_INPUT cells whose
 *  value is intentionally not produced today. Tagged 'adjustedInputs' so
 *  it satisfies the LEGACY state required-source policy. */
const nullSelector: Selector = tagSelector(() => null, ['adjustedInputs']);

/** Same as nullSelector but tagged 'resolvedContext' so it satisfies the
 *  FULL_MODERN required-source policy. Used for cells whose value is
 *  intentionally not written (formula-guarded caveats) but whose data
 *  semantics live in the resolved context (e.g. appraisal caveats). */
const nullSelectorResolvedContext: Selector = tagSelector(() => null, ['resolvedContext']);

/** Selector that returns adjustedInputs.metrics.ltv if present, else null —
 *  for the LTV_Appraisal AWAITING_INPUT cell. Surfaces the actual computed
 *  LTV when a future appraisal-ingest slot lands; today returns null
 *  because the 4-file ingest model has no appraisal input. */
const ltvAppraisalSelector: Selector = tagSelector((input) => {
  const v = input.adjustedInputs.metrics.ltv;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}, ['adjustedInputs']);

// v9 carries forward v8's CONCLUDED entries minus the cap-rate / value pair
// (those FLIP to awaiting_input here) and adds the operating-proforma fills
// and metric closures.
const V9_SHARED_ENTRIES: SchemaEntry[] = [
  // ----- Carried-forward v7/v8 entries (concluded, unchanged) --------------
  { slot: 'Property_Loan_Summary', range: 'Property_Name',     selector: ctx((c) => c.property.name),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Address',           selector: ctx((c) => c.property.street),              cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'City',              selector: ctx((c) => c.property.city),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'State',             selector: ctx((c) => c.property.state),               cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'ZIP',               selector: ctx((c) => c.property.zip),                 cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'County',            selector: ctx((c) => c.property.county),              cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Property_Type',     selector: ctx((c) => c.property.type),                cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Year_Built',        selector: ctx((c) => c.property.yearBuilt),           cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Occupancy',         selector: ctx((c) => c.property.occupancy),           cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Ownership_Interest',selector: ctx((c) => c.property.ownershipInterest),   cellState: 'concluded' },
  // Sprint-0 additions — named ranges that exist in the template but had no
  // V9 entry. propertyMetadata-only sources.
  { slot: 'Property_Loan_Summary', range: 'MSA',               selector: ctx((c) => c.property.msa),                 cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Year_Renovated',    selector: ctx((c) => c.property.yearRenovated),       cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Current_Balance',     selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Original_Balance',    selector: num((a) => a.loan.loanAmount),            cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Coupon',              selector: num((a) => a.loan.interestRate),          cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Annual_Debt_Service', selector: num((a) => a.metrics.annualDebtService),  cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Balloon_Term',        selector: ctxLoanMonthsToYears((l) => l.termMonths),         cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Amortization_Term',   selector: ctxLoanMonthsToYears((l) => l.amortizationMonths), cellState: 'concluded' },
  { slot: 'Property_Loan_Summary', range: 'Interest_Only_Period',selector: ctx((c) => c.loan.ioMonths),              cellState: 'concluded' },
  { slot: 'Borrower',              range: 'Borrower',            selector: ctx((c) => c.parties.borrowerName),       cellState: 'concluded' },
  { slot: 'Borrower',              range: 'Sponsor',             selector: ctx((c) => c.parties.sponsorName),        cellState: 'concluded' },

  // ----- Sprint-0: Property Detail tab (Property Detail - Comm for office) -
  // 8 cells fed by propertyMetadata. A1 addresses verified by openpyxl scan
  // of Blank_UW_Template_v2.xlsm. Per Sprint-0 corrections, B3 (Gross
  // Building Area; GBA ≠ NRA, no PM source) and F10 (Property Rights;
  // appraisal-derived, no appraisal for Sunroad) are NOT mapped — they stay
  // honest-blank.
  // Appraisal-ingest: B3 (Gross Building Area) now has a source via
  // resolvedContext.appraisal.grossBuildingArea (CBRE Sunroad p.12: 285,085 SF).
  // Sprint-0 left this honest-blank (GBA ≠ NRA; no PM source).
  { slot: 'Property_Detail',       range: 'B3',                  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.grossBuildingArea),  cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'B4',                  selector: ctx((c) => c.property.totalSquareFeet),    cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'F3',                  selector: ctx((c) => c.property.type),               cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'F4',                  selector: ctx((c) => c.property.yearBuilt),          cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'F5',                  selector: ctx((c) => c.property.yearRenovated),      cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'B9',                  selector: ctx((c) => c.property.totalSquareFeet),    cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'B11',                 selector: ctx((c) => c.property.numberOfBuildings),  cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'F11',                 selector: ctx((c) => c.property.ownershipInterest),  cellState: 'concluded' },
  { slot: 'Property_Detail',       range: 'B15',                 selector: ctx((c) => c.property.buildingClass),      cellState: 'concluded' },

  // ----- Sprint-0: Site Inspection tab ------------------------------------
  // Only C6 is a true input cell. The other property-identity cells on this
  // tab (C4 NRA / C5 Year Built / E4 Occupancy / E5 Year Renovated) are
  // FORMULAS that auto-cascade from the Property & Loan Summary named ranges
  // when those are filled — writing to them would break the formula.
  { slot: 'Site_Inspection',       range: 'C6',                  selector: ctx((c) => c.property.numberOfBuildings),  cellState: 'concluded' },

  // ----- Appraisal-ingest: Operating ProForma column J (Appraisal) ---------
  // STABILIZED basis. Sourced from analysis.appraisalExtraction via the
  // `c.appraisal.*` atoms. 17 input rows on the canonical 18-input/13-formula
  // template structure; J11 Bad Debt has dedicated row so we plant it. The
  // FORMULA subtotals (J10/J12/J17/J27/J33/J35/J42/J44/J46-J50) are NEVER
  // written — they cascade from inputs.
  //
  // ★ Checksum gate (verified at extractor test time):
  //   J33 (template SUM of expense inputs) = stabilized totalOperatingExpenses ($3,932,767)
  //   J17 (Net Rental Rev + OtherInc + NetEffReimb) ≈ stabilizedEGI ($12,536,598, off $1 rounding)
  //   J35 (= J17 - J33) ≈ stabilized NOI ($8,603,831 → computed $8,603,832, off $1)
  { slot: 'Operating_ProForma',    range: 'J9',                  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.pgr),                           cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J6',                  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.economicOccupancy),             cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J7',                  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.physicalOccupancy),             cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J11',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.badDebt),                       cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J14',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.otherIncomeGross),              cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J15',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.netEffectiveReimbursements),    cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J22',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesGeneralAdmin),          cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J24',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesRepairsMaintenance),    cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J25',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesUtilities),             cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J26',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesOtherVariable),         cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J30',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesManagement),            cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J31',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesTaxes),                 cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J32',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesInsurance),             cellState: 'concluded' },
  { slot: 'Operating_ProForma',    range: 'J38',                 selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.capex),                         cellState: 'concluded' },

  // ----- v9 NEW: Operating ProForma — CONCLUDED -----------------------------
  // "Eightfold Concluded" column = column P on Operating History and Pro Forma.
  // No defined names exist for these row positions in the Blank UW Template;
  // we use explicit A1 addresses below. Row numbers verified by inspection
  // of `Blank UW Template.xlsm` at the canonical layout.

  // ----- Column P direct-display: engine-concluded operating set ------------
  // P column shows the engine's CONCLUDED figures (the J/L "fill leaves, let
  // subtotals compute" pattern, but for cells the template made FORMULA by
  // default — rent-roll-coupled or L-column-cascade). Each leaf uses
  // forceOverwrite: true so the populator replaces the template formula with
  // the engine literal. Subtotal cells P12/P17/P27/P33/P35/P42/P44 stay as
  // formulas and recompute from the new leaves. Vacancy P10 = -(1-P6)*P9 is
  // intentionally left as a formula (mirrors J column) — it derives from
  // the P6 + P9 leaves we write.

  // P9 — Potential Gross Rental Income (engine $13,383,468).
  {
    slot: 'Operating_ProForma',
    range: 'P9',
    selector: adj((a) => a.income.grossPotentialRent),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P6 — Avg Economic Occupancy. The template's P10 formula
  // `=-((1-P6)*P9)` expects an OCCUPANCY ratio, not a vacancy ratio. We
  // therefore write `1 - vacancyPct` (engine concluded ≈ 0.89898 on Sunroad).
  // P10 then derives -$1,352,147 from our P6 + P9 leaves.
  {
    slot: 'Operating_ProForma',
    range: 'P6',
    selector: num((a) => {
      const v = a.income.vacancyLoss?.adjusted;
      const g = a.income.grossPotentialRent?.adjusted;
      if (typeof v !== 'number' || typeof g !== 'number' || g <= 0) return null;
      // vacancyLoss is stored negative; pct = -v/g; occupancy = 1 - pct.
      return 1 - (-v / g);
    }),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P10 — Vacancy Loss. KEEP AS FORMULA (P10 = -(1-P6)*P9). The template's
  // existing formula computes the right value from our P6 + P9 leaves.
  // No forceOverwrite — formula guard preserves it; schema entry's selector
  // value is for the governance gate (every schema address has an entry).
  {
    slot: 'Operating_ProForma',
    range: 'P10',
    selector: adj((a) => a.income.vacancyLoss),
    cellState: 'concluded',
  },
  // P14 — Other Income (engine $138K). Issue rewriting as literal even though
  // L14's existing pass-through formula =+L14 already produces this — keeps
  // column P self-contained (independent of column L's value).
  {
    slot: 'Operating_ProForma',
    range: 'P14',
    selector: adj((a) => a.income.otherIncome),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P31 — Property Taxes (engine $960,500).
  {
    slot: 'Operating_ProForma',
    range: 'P31',
    selector: adj((a) => a.expenses.realEstateTaxes),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P30 — Management Fee (engine $408,842).
  {
    slot: 'Operating_ProForma',
    range: 'P30',
    selector: adj((a) => a.expenses.management),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P38 — Capital Expenditures / Replacement Reserves. Engine $54,952 (= answer
  // key $54,952 EXACT). Source: `AdjustedInputs.capitalReserves.monthlyReplacementReserves`
  // (monthly $; × 12 for annual). The legacy `expenses.replacementReserves`
  // slot stays at 0 by design (NOI tie-out — the new-spine engine treats
  // reserves as below-NOI / capital). Reading from capitalReserves
  // surfaces the real value without breaking the NOI build-up that
  // downstream tabs depend on.
  {
    slot: 'Operating_ProForma',
    range: 'P38',
    selector: num((a) => a.capitalReserves.monthlyReplacementReserves.adjusted * 12),
    cellState: 'concluded',
    forceOverwrite: true,
  },

  // ----- v9 NEW: Conclusions & Escrows — CONCLUDED metrics ------------------
  // After the Phase-14 IO-only debt-service fix (Bugs 1+2 — both
  // `judgment/amortization.ts:annualDebtService` and the legacy
  // `uw-calc.ts:calculateAnnualDebtService` now return
  // `loanAmount × interestRate` for `amortizationMonths === 0`), the
  // Sunroad metrics close cleanly against the answer key:
  //   Debt Yield: engine 0.1033 vs answer 0.106 (-2.54% conservative, in
  //     ±5% band) — CONCLUDED.
  //   DSCR (NOI): engine ~1.31 vs answer 1.343 (-2.5% conservative; in
  //     ±5% band and ±50bps) — CONCLUDED (Phase-14 flip from AWAITING_INPUT).
  // Cell I-column on Conclusions & Escrows; no defined names for these
  // specific rows; A1 addresses below.
  // I16 — DSCR (NOI). CONCLUDED post Bugs 1+2 fix.
  {
    slot: 'Conclusion_Escrows',
    range: 'I16',
    selector: num((a) => a.metrics.dscr),
    cellState: 'concluded',
  },
  // J16 — Debt Yield (NOI). Conclusions sheet J16 is the paired debt-yield
  // output cell. Engine 0.1033 vs answer 0.106 — in band (±50bps),
  // conservative direction.
  {
    slot: 'Conclusion_Escrows',
    range: 'J16',
    selector: num((a) => a.metrics.debtYield),
    cellState: 'concluded',
  },

  // ----- v9 NEW: Operating ProForma — AWAITING_INPUT ------------------------
  // The "dangerous expense" cells. Engine reads issuer CF columns; B-piece
  // judgment typically restates these upward. Awaiting the expense-markup
  // value-add rule (cleanup ticket #5).

  // P11 — Bad Debt Expense. Engine has no separate bad-debt surface
  // (folded into the vacancy haircut at the income side). Display 0.
  {
    slot: 'Operating_ProForma',
    range: 'P11',
    selector: num(() => 0),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P21 — Salaries and Benefits. Engine reads payroll = 0 from
  // AdjustedInputs.expenses (CMBS-style cash flows fold salaries into G&A
  // or treat them as null). Display 0.
  {
    slot: 'Operating_ProForma',
    range: 'P21',
    selector: adj((a) => a.expenses.payroll),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P23 — Advertising and Marketing. Engine has no separate advertising
  // surface on AdjustedInputs.expenses. Display 0.
  {
    slot: 'Operating_ProForma',
    range: 'P23',
    selector: num(() => 0),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P24 — Repairs and Maintenance (engine $817,537).
  {
    slot: 'Operating_ProForma',
    range: 'P24',
    selector: adj((a) => a.expenses.repairsAndMaintenance),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P26 — Other (variable). ★ Carries the EXPENSE-FLOOR top-up. The engine
  // raises totalExpenses to max(library median, bank ratio) × EGI per
  // judgment/line-item-builders.ts:buildTotalOperatingExpenses (rule
  // JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN). The residual (= totalExpenses −
  // sum of broken-out lines) lands here, with a labeled cell note so the
  // analyst sees the floor mechanism explicitly. P33 SUM(...P26 + P30:P32)
  // then ties to engine totalExpenses exactly.
  {
    slot: 'Operating_ProForma',
    range: 'P26',
    selector: num((a) => {
      const e = a.expenses;
      const sum =
        (e.realEstateTaxes?.adjusted ?? 0) +
        (e.insurance?.adjusted ?? 0) +
        (e.utilities?.adjusted ?? 0) +
        (e.repairsAndMaintenance?.adjusted ?? 0) +
        (e.management?.adjusted ?? 0) +
        (e.generalAndAdmin?.adjusted ?? 0) +
        (e.payroll?.adjusted ?? 0);
      const total = e.totalExpenses?.adjusted ?? 0;
      const residual = total - sum;
      return residual > 0 ? residual : 0;
    }),
    cellState: 'concluded',
    forceOverwrite: true,
    comment: (input) => {
      const e = input.adjustedInputs.expenses;
      const sum =
        (e.realEstateTaxes?.adjusted ?? 0) +
        (e.insurance?.adjusted ?? 0) +
        (e.utilities?.adjusted ?? 0) +
        (e.repairsAndMaintenance?.adjusted ?? 0) +
        (e.management?.adjusted ?? 0) +
        (e.generalAndAdmin?.adjusted ?? 0) +
        (e.payroll?.adjusted ?? 0);
      const total = e.totalExpenses?.adjusted ?? 0;
      const residual = total - sum;
      const egi = input.adjustedInputs.income.effectiveGrossIncome?.adjusted ?? null;
      const ratioPct = egi !== null && egi > 0 ? ((total / egi) * 100).toFixed(2) + '%' : 'n/a';
      const fmt = (n: number) => '$' + Math.round(n).toLocaleString();
      return (
        `Expense floor: total opex floored to ${ratioPct} of EGI (max of library ` +
        `median and bank ratio per judgment rule JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN). ` +
        `Itemized ${fmt(sum)} floored up to ${fmt(total)} (+${fmt(residual)}).`
      );
    },
  },

  // P25 — Utilities (engine $276,580).
  {
    slot: 'Operating_ProForma',
    range: 'P25',
    selector: adj((a) => a.expenses.utilities),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P22 — General and Administrative (engine $314,303).
  {
    slot: 'Operating_ProForma',
    range: 'P22',
    selector: adj((a) => a.expenses.generalAndAdmin),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P32 — Insurance (engine $306,000).
  {
    slot: 'Operating_ProForma',
    range: 'P32',
    selector: adj((a) => a.expenses.insurance),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P39 — Tenant Improvements (annual). Engine has no separate TI/LC line
  // on AdjustedInputs.expenses — carried below NOI via capex schedule. P39
  // displays 0 for the concluded operating set; analyst overrides as needed.
  {
    slot: 'Operating_ProForma',
    range: 'P39',
    selector: num(() => 0),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P40 — Leasing Commissions (annual). Same rationale as P39.
  {
    slot: 'Operating_ProForma',
    range: 'P40',
    selector: num(() => 0),
    cellState: 'concluded',
    forceOverwrite: true,
  },
  // P15 — Expense Reimbursements. Engine doesn't carry a reimbursements
  // surface on AdjustedExpenses (it's folded into revenue / GPR upstream).
  // Display 0 in the concluded view; reimbursements show up implicitly via
  // EGI = P12 + P14 + P15 with P15 = 0.
  {
    slot: 'Operating_ProForma',
    range: 'P15',
    selector: num(() => 0),
    cellState: 'concluded',
    forceOverwrite: true,
  },

  // ----- v9: Conclusions & Escrows ----------------------------------------
  // Concluded_Value reads `adjustedInputs.metrics.value` — the persisted
  // operator-supplied concluded valuation ($126.20M on Sunroad; matches the
  // memo's verbatim "concluded value of $126.20M" callouts and the basis
  // disclosure "valuation basis: operator-supplied"). The legacy v8 entry
  // (which read `a.metrics.impliedValue`, a field that no longer exists
  // and produced library-median-derived $113.58M) is structurally overridden.
  //
  // PATH-DEPENDENT BEHAVIOR — the cell renders ONLY when the upstream
  // pipeline populated `metrics.value` with an operator-supplied valuation:
  //   - calibration-memo-v1 path: loads AdjustedInputs directly from
  //     phase4-sunroad.db where `value: 126200361.95` is persisted from a
  //     run that DID have operator input wired → cell renders $126.20M.
  //   - phase14-produce-workbook path: routes through the legacy producer
  //     (ingestExtractionResult → analysis-to-adjusted-inputs.adapter →
  //     metrics.value = null), which has NO operator-input seam → cell
  //     correctly stays blank.
  // Phase14's blank is by design, not a wiring bug. Populating it for
  // phase14 requires either (a) an operator-input field at deal-setup
  // plumbed through the legacy producer, or (b) phase14 switching to the
  // clean-room `evaluateAndNarrate` path. Both are out of scope for the
  // schema layer.
  //
  // Concluded_Cap_Rate stays awaiting_input: the operator supplied a value
  // anchored to ratings actions on comparable towers, NOT a cap rate.
  // The implied (NOI/value = ~6.75%) is a derivation the memo doesn't
  // validate; wiring it would invent a figure the deal record never made.
  {
    slot: 'Conclusion_Escrows',
    range: 'Concluded_Cap_Rate',
    selector: nullSelector,
    cellState: 'awaiting_input',
    comment: () =>
      'Operator-supplied valuation is a $-value, not a cap rate (Sunroad: ' +
      'BOV anchored to Q1 ratings actions on comparable Office CBD towers). ' +
      'No concluded cap rate was provided; the NOI/value implication is a ' +
      'derivation the deal record never made. Awaiting either an explicit ' +
      'operator-supplied cap rate field or a per-deal calibration rule.',
  },
  {
    slot: 'Conclusion_Escrows',
    range: 'Concluded_Value',
    selector: num((a) => a.metrics.value),
    cellState: 'concluded',
    comment: () =>
      'Operator-supplied valuation (Sunroad: BOV $126.20M, basis anchored ' +
      'to Q1 ratings actions on comparable Office CBD towers). Matches the ' +
      'memo\'s "concluded value of $126.20M; valuation basis: ' +
      'operator-supplied" disclosure. PENDING LEASE-UP CORRECTION — engine ' +
      'inPlace EGI ($13.6M) tracks stabilized ($12.5M), not current ($1.9M); ' +
      'value figure should be reread against the appraisal As-Is ($122M) ' +
      'until the lease-up timing is wired into the income projection.',
  },

  // ----- Appraisal-ingest: Appraisal Value / LTV / escrows -----------------
  // Sunroad CBRE p.3 As-Is conclusion = $122M; the named range
  // `Appraised_Value` resolves to 'Conclusions & Escrows'!$I$11 and feeds the
  // downstream formulas at I13 (LTV) and I14 (Appraisal Cap Rate). Wiring
  // this cell makes the HARD CONSTRAINT "headline LTV = loan / asIsValue
  // ($75M/$122M = 61.5%)" compute natively in the workbook.
  {
    slot: 'Conclusion_Escrows',
    range: 'Appraised_Value',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.asIsValue),
    cellState: 'concluded',
    comment: (input) => {
      // Read the figures from the resolved context so the comment can't drift
      // away from what the extractor actually surfaced. The CBRE appraisal
      // value table sits on page 3; that page citation is the only literal.
      const a = (input.resolvedContext as unknown as { appraisal?: Record<string, unknown> }).appraisal ?? {};
      const asIs = typeof a.asIsValue === 'number' ? a.asIsValue : null;
      const asStab = typeof a.asStabilizedValue === 'number' ? a.asStabilizedValue : null;
      const months = typeof a.stabilizationMonths === 'number' ? a.stabilizationMonths : null;
      const fmt = (n: number | null): string => (n === null ? 'n/a' : '$' + n.toLocaleString());
      return (
        `Appraisal As-Is value (CBRE p.3: ${fmt(asIs)}). Drives headline LTV ` +
        `via Appraisal LTV (I13 = Current_Balance / Appraised_Value) and ` +
        `Appraisal Cap Rate via I14. As-Stabilized reference (CBRE p.3): ` +
        `${fmt(asStab)}; stabilization in ${months ?? 'n/a'} months. Going-in ` +
        `NOI is negative; appraisal DSCR/DY at I13/I14 are computed on the ` +
        `STABILIZED NOI (Operating ProForma!J35) per template wiring — the ` +
        `template has no separate column for the going-in basis, so OPF J35/` +
        `J48/J50 carry cell notes that surface the going-in NOI alongside ` +
        `the stabilized formula values.`
      );
    },
  },
  // Per-Appraisal escrows: column D on rows 47-49 of Conclusions & Escrows.
  // Sourced from the CBRE Stabilized Pro Forma per-line expenses (D47/D48)
  // and the appraiser's reserve estimate (D49). D50/D51/D52/D54/D55 stay
  // honest-blank — not in the appraisal's scope (Immediate Repairs is from
  // PCA; TI/LC, environmental, FF&E, PIP are operator/PCA inputs).
  {
    slot: 'Conclusion_Escrows',
    range: 'D47',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesTaxes),
    cellState: 'concluded',
  },
  {
    slot: 'Conclusion_Escrows',
    range: 'D48',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.expensesInsurance),
    cellState: 'concluded',
  },
  {
    slot: 'Conclusion_Escrows',
    range: 'D49',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.perAppraisalCapex),
    cellState: 'concluded',
  },
  // I14 caveat. The template formula reads `=+I12/Appraised_Value`, i.e.
  // (stabilized NOI from OPF!J35) / (As-Is value). That arithmetic is
  // valid given the inputs, but it contradicts the appraiser's CONCLUDED
  // overall cap rate (CBRE p.12 OAR = 6.25%). Surface the discrepancy as
  // a cell note so a reader who sees "7.05%" doesn't conclude the
  // appraiser's OAR was 7.05%.
  {
    slot: 'Conclusion_Escrows',
    range: 'I14',
    selector: nullSelectorResolvedContext,
    cellState: 'awaiting_input',
    comment: (input) => {
      const a = (input.resolvedContext as unknown as { appraisal?: Record<string, unknown> }).appraisal ?? {};
      const oar = typeof a.overallCapRate === 'number' ? a.overallCapRate : null;
      const oarText = oar === null ? 'n/a' : (oar * 100).toFixed(2) + '%';
      return (
        `Appraiser's concluded Overall Cap Rate is ${oarText} (CBRE p.12). ` +
        `The figure shown here is the template artifact (stabilized NOI ÷ ` +
        `As-Is value), NOT the appraiser's concluded OAR. As-Is is used in ` +
        `Appraised_Value to anchor the conservative LTV; it should not be ` +
        `paired with stabilized NOI to imply a market cap rate.`
      );
    },
  },

  // ----- Appraisal-ingest: going-in caveats on the stabilized appraisal -----
  // Operating ProForma column J wires the appraisal STABILIZED basis. The
  // template has no second column for the appraisal CURRENT (going-in) basis
  // — N/In-Place cascades from rent roll, L is Issuer UW, P is Concluded UW,
  // R-Q are blank but writing formulas into them via the renderer would
  // violate the renderer-is-not-template-authoring boundary. So we caveat
  // the stabilized J35 NOI and J48/J50 DSCR/DY cells with cell notes that
  // surface the going-in NOI and label these outputs as stabilized-only.
  // The formula-guard in writeCellValue preserves the J35/J48/J50 formulas
  // while attaching the note. Same for Conclusions & Escrows I13/I14 LTV &
  // cap rate (computed off J35).
  {
    slot: 'Operating_ProForma',
    range: 'J35',
    selector: nullSelectorResolvedContext,
    cellState: 'awaiting_input',
    comment: (input) => {
      const a = (input.resolvedContext as unknown as { appraisal?: Record<string, unknown> }).appraisal ?? {};
      const currNOI = typeof a.currentNOI === 'number' ? a.currentNOI : null;
      const stabNOI = typeof a.stabilizedNOI === 'number' ? a.stabilizedNOI : null;
      const fmt = (n: number | null): string => (n === null ? 'n/a' : '$' + n.toLocaleString());
      return (
        `Appraisal NOI shown is STABILIZED ($8,603,831 expected; J35 displays ${fmt(stabNOI)}). ` +
        `Going-in NOI = ${fmt(currNOI)} (negative; 2022 actuals column from the ` +
        `appraisal Operating History table, CBRE p.88). Template has no second ` +
        `column for appraisal going-in; coverage cells J48 (DSCR) and J50 (DY) ` +
        `are computed on stabilized NOI only.`
      );
    },
  },
  {
    slot: 'Operating_ProForma',
    range: 'J48',
    selector: nullSelectorResolvedContext,
    cellState: 'awaiting_input',
    comment: (input) => {
      const a = (input.resolvedContext as unknown as { appraisal?: Record<string, unknown> }).appraisal ?? {};
      const currNOI = typeof a.currentNOI === 'number' ? a.currentNOI : null;
      const fmt = (n: number | null): string => (n === null ? 'n/a' : '$' + n.toLocaleString());
      return (
        `DSCR shown is STABILIZED basis (J35 / Annual_Debt_Service). Going-in ` +
        `DSCR is NEGATIVE: appraisal 2022-actuals NOI ${fmt(currNOI)} / ` +
        `Annual_Debt_Service ≈ sub-zero coverage. Awaiting going-in-basis column ` +
        `wiring (not yet available in template).`
      );
    },
  },
  {
    slot: 'Operating_ProForma',
    range: 'J50',
    selector: nullSelectorResolvedContext,
    cellState: 'awaiting_input',
    comment: (input) => {
      const a = (input.resolvedContext as unknown as { appraisal?: Record<string, unknown> }).appraisal ?? {};
      const currNOI = typeof a.currentNOI === 'number' ? a.currentNOI : null;
      const fmt = (n: number | null): string => (n === null ? 'n/a' : '$' + n.toLocaleString());
      return (
        `Debt Yield shown is STABILIZED basis (J35 / Current_Balance). Going-in ` +
        `DY is NEGATIVE: appraisal 2022-actuals NOI ${fmt(currNOI)} / loan ` +
        `balance. Awaiting going-in-basis column wiring (not yet available in ` +
        `template).`
      );
    },
  },

  // ----- Sprint-2: Third Party Reports Summary — appraisal + PCA -----------
  // Appraisal Summary section (rows 4-19) reuses c.appraisal.* atoms already
  // shipped in the appraisal commit. Engineering/PCR section (rows 23-28)
  // sources from the new c.pca.* atoms. Both sections write ONLY to input
  // cells; the formula cells (E5/E15/E17) cascade and are never declared.
  // Honest-blank rule: no PCA source → blank, never 0; same for appraisal.
  {
    slot: 'Third_Party_Reports',
    range: 'E4',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.asIsValueDate),
    cellState: 'concluded',
  },
  {
    slot: 'Third_Party_Reports',
    range: 'E6',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.asStabilizedValue),
    cellState: 'concluded',
  },
  {
    slot: 'Third_Party_Reports',
    range: 'E7',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.asStabilizedValueDate),
    cellState: 'concluded',
  },
  {
    slot: 'Third_Party_Reports',
    range: 'E8',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.insurableValue),
    cellState: 'concluded',
  },
  // E18 terminalCapRate, E19 discountRate — both in resolver
  // c.appraisal.terminalCapRate / .discountRate.
  {
    slot: 'Third_Party_Reports',
    range: 'E18',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.terminalCapRate),
    cellState: 'concluded',
  },
  {
    slot: 'Third_Party_Reports',
    range: 'E19',
    selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.discountRate),
    cellState: 'concluded',
  },
  // Engineering / PCR section. ★ The CBRE PCA carries inflated reserves
  // ($0.11/SF/yr) and immediate repairs ($19,400). Both surface here; the
  // immediate-repairs value ALSO surfaces on Conclusions & Escrows D50 as
  // an escrow-basis context (TPR = "what the PCA said"; D50 = "what we'd
  // escrow against it").
  {
    slot: 'Third_Party_Reports',
    range: 'E24',
    selector: ctx((c) => (c as never as { pca: Record<string, CellValue> }).pca.replacementReservesPerSfPerYearInflated),
    cellState: 'concluded',
  },
  {
    slot: 'Third_Party_Reports',
    range: 'E25',
    selector: ctx((c) => (c as never as { pca: Record<string, CellValue> }).pca.immediateRepairs),
    cellState: 'concluded',
  },
  {
    slot: 'Conclusion_Escrows',
    range: 'D50',
    selector: ctx((c) => (c as never as { pca: Record<string, CellValue> }).pca.immediateRepairs),
    cellState: 'concluded',
  },

  // ----- Sprint-1: Operating ProForma column L (Issuer UW) -----------------
  // GS U/W column from the seller cash-flow extraction; sits beside J
  // (appraisal stabilized) and P (engine concluded). Inputs only — formula
  // subtotals (L10/L12/L17/L27/L33/L35/L42/L44/L46–L50) are NEVER declared.
  // L13 carries the new uwAdjustments bucket (Sunroad: $297,545 credit-tenant
  // rent steps PV) with a cell note explaining the source. economicOccupancy
  // is derived so L10 = -L9*(1-L6) reproduces the issuer's vacancyLoss.
  {
    slot: 'Operating_ProForma', range: 'L9',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.pgr),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L6',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.economicOccupancy),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L11',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.badDebt),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L13',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.uwAdjustments),
    cellState: 'concluded',
    comment: () =>
      'Issuer UW adjustment $297,545 = PV of contractual rent steps for ' +
      'IG tenants (CMBS CF footnote 3); forward-looking, excluded from ' +
      'engine concluded NOI.',
  },
  {
    slot: 'Operating_ProForma', range: 'L14',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.otherIncome),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L15',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.reimbursements),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L22',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesGeneralAdmin),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L24',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesRepairsMaintenance),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L25',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesUtilities),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L26',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesOtherVariable),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L30',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesManagement),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L31',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesTaxes),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L32',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.expensesInsurance),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L38',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.capex),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L39',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.tenantImprovements),
    cellState: 'concluded',
  },
  {
    slot: 'Operating_ProForma', range: 'L40',
    selector: ctx((c) => (c as never as { issuerUw: Record<string, CellValue> }).issuerUw.leasingCommissions),
    cellState: 'concluded',
  },

  // ----- v9 NEW: Extraction / data gaps — AWAITING_INPUT --------------------
  // K6 — LTV (Appraisal). Conclusions & Escrows / Property & Loan Summary
  // K-column area. No appraisal slot in current 4-file ingest model (CF +
  // ASR + PCA + rent-roll). Selector returns adjustedInputs.metrics.ltv
  // when present; null today.
  {
    slot: 'Property_Loan_Summary',
    range: 'E41',
    // nullSelector (not ltvAppraisalSelector) — awaiting_input only flags
    // the cell as preliminary; it does NOT blank the value. The previous
    // ltvAppraisalSelector returned adjustedInputs.metrics.ltv (impliedValue-
    // basis ≈ 69.21% on the phase14 Sunroad re-run), which both (a) used the
    // wrong basis (impliedValue, not the operator-supplied concluded value)
    // AND (b) contradicted the memo's single-LTV-basis discipline (the gate
    // in calibration-memo-v1-sunroad-real.ts asserts 65.34% / 40.90% are
    // ABSENT from the memo). nullSelector forces a genuinely blank cell —
    // honest absence rather than a value that the memo refuses to validate.
    selector: nullSelector,
    cellState: 'awaiting_input',
    comment: () =>
      'Appraised-basis LTV is intentionally not surfaced. (1) No appraisal ' +
      'slot in the 4-file ingest model (CF + ASR + PCA + rent-roll). (2) The ' +
      'memo follows a single-LTV-basis discipline using the doctrine-stressed ' +
      'basis (Sunroad: 87.98% pre-cut / 80.00% at L′); the appraised-basis ' +
      'figure (loanAmount / operator-supplied value) is deliberately absent ' +
      'from memo prose and is omitted here for the same reason. Wiring it ' +
      'bare without a basis qualifier would imply third-party appraisal ' +
      'support that the deal does not have. Awaiting a basis-label cell ' +
      'mechanism or an appraisal ingest slot.',
  },
  // P49 — NCF DSCR. Engine surfaces NOI DSCR only today; NCF = NOI − annual
  // reserves. Awaiting NCF metric on AdjustedInputs.metrics or render-side
  // derivation.
  {
    slot: 'Operating_ProForma',
    range: 'P49',
    selector: nullSelector,
    cellState: 'awaiting_input',
    comment: () =>
      'Engine does not surface NCF DSCR today (only NOI DSCR). NCF = NOI − ' +
      'annual reserves. Awaiting NCF metric on AdjustedInputs.metrics or ' +
      'render-side derivation.',
  },
  // K3 area — Net Rentable Area. The Blank UW Template has K3 reserved for
  // a rent-roll-derived RRP formula; the rent-roll sum-of-squareFeet pathway
  // is not surfaced on resolvedContext today. Awaiting either resolvedContext
  // extension or a manual NRA input.
  //
  // PHASE A (v10) — K5 is overridden in V10_SHARED_ENTRIES with a rent-roll
  // selector that sums tenant.squareFeet directly. v9 keeps the nullSelector
  // because v9's source allowlist does NOT permit 'rentRoll' — the rent-roll
  // bundle entered the picture at v10. Cells still under v9 (no v10 template
  // override) render honest-blank as before.
  {
    slot: 'Property_Loan_Summary',
    range: 'K5',
    selector: nullSelector,
    cellState: 'awaiting_input',
    comment: () =>
      'Net Rentable Area requires summing squareFeet across rent-roll lines. ' +
      'Today\'s resolvedContext does not surface the rent-roll-derived NRA on ' +
      'the property block. Awaiting resolvedContext extension or manual NRA input.',
  },
  // K6 — Property Building Class. PropertyMetadata extraction does not
  // produce a building class designation on Sunroad. Phase-11 confirmed
  // missing_field 'building_class' for P-IV-OFF-2.
  {
    slot: 'Property_Loan_Summary',
    range: 'K6',
    selector: nullSelector,
    cellState: 'awaiting_input',
    comment: () =>
      'PropertyMetadata extraction does not produce a building class designation ' +
      'on Sunroad. Phase-11 confirmed missing_field \'building_class\' for ' +
      'P-IV-OFF-2. Awaiting extraction widening.',
  },
];

const V9_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  // Carry forward v8 literals (defined names only — the new v9 P-column / A1
  // addresses on Operating ProForma are NOT named ranges and so are NOT
  // managed-namespace literals; they're explicit A1 writes).
  literals: V8_SHARED_ENTRIES.map((e) => e.range),
  excludedSheets: [...SHARED_MANAGED_NAMESPACE.excludedSheets],
};

function v9Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V9_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V9_MANAGED_NAMESPACE,
  };
}

function v9DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v9Definition(assetClass)];
}

const SCHEMA_V9: ContractSchema = {
  office: {
    office_core:       v9DefsFor('office'),
    office_trophy:     v9DefsFor('office'),
    office_value_add:  v9DefsFor('office'),
    office_distressed: v9DefsFor('office'),
  },
  multifamily: {
    mf_core:        v9DefsFor('multifamily'),
    mf_large_scale: v9DefsFor('multifamily'),
    mf_workforce:   v9DefsFor('multifamily'),
    mf_value_add:   v9DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v9DefsFor('industrial'),
    ind_logistics: v9DefsFor('industrial'),
    ind_light:     v9DefsFor('industrial'),
  },
  retail:               { retail_core:               v9DefsFor('retail') },
  hotel:                { hotel_core:                v9DefsFor('hotel') },
  self_storage:         { self_storage_core:         v9DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v9DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v9DefsFor('manufactured_housing') },
};

// --- v10 SCHEMA ENTRIES -----------------------------------------------------
// v10 takes the Rent Roll sheet OUT of excludedSheets and writes per-tenant
// rows into the template's input columns (rows 14..43 — 30-tenant capacity).
// Also writes "TRUE" to Property & Loan Summary!AA3 (the RRP toggle) so the
// derivative tabs' IF($S$8, …) formulas resolve to a clean boolean rather
// than propagating #N/A. Source surface: a new 'rentRoll' tag on
// SchemaEntry selectors, declared in ALLOWED_SOURCES_BY_VERSION[10].

const RENT_ROLL_TENANT_CAPACITY = 30 as const;
const RENT_ROLL_FIRST_ROW = 14 as const;

function tenantLines(rr: RentRoll | null | undefined): readonly TenantRentRollLine[] {
  if (!rr) return [];
  const out: TenantRentRollLine[] = [];
  for (const l of rr.lines) {
    if (l.kind === 'tenant') out.push(l);
  }
  return out;
}

function rrField(
  rowIdx: number,
  pick: (line: TenantRentRollLine) => CellValue,
): Selector {
  return tagSelector((input) => {
    const lines = tenantLines(input.rentRoll);
    if (rowIdx >= lines.length) return null; // honest-blank for unused rows
    const v = pick(lines[rowIdx]!);
    return v;
  }, ['rentRoll']);
}

const V10_RENT_ROLL_ENTRIES: SchemaEntry[] = (() => {
  const out: SchemaEntry[] = [];
  for (let i = 0; i < RENT_ROLL_TENANT_CAPACITY; i++) {
    const row = RENT_ROLL_FIRST_ROW + i;
    // B<row>: Unit / suite — string | null (honest-blank when source is null)
    out.push({
      slot: 'Rent_Roll',
      range: `B${row}`,
      selector: rrField(i, (l) => l.suite),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // C<row>: Tenant Name — string | null
    out.push({
      slot: 'Rent_Roll',
      range: `C${row}`,
      selector: rrField(i, (l) => l.tenantName),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // D<row>: Square Feet — number | null (HONEST-BLANK never 0)
    out.push({
      slot: 'Rent_Roll',
      range: `D${row}`,
      selector: rrField(i, (l) => l.squareFeet),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // E<row>: Status code — template uses LEFT($E,1) for VLOOKUP, so we
    // write the status enum verbatim (PRELEASED / OCCUPIED / VACANT /
    // PRELEASED / HOLDOVER / UNKNOWN). First letter selects the lookup row.
    out.push({
      slot: 'Rent_Roll',
      range: `E${row}`,
      selector: rrField(i, (l) => l.status),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // F<row>: Lease Start — ISO date string | null (honest-blank)
    out.push({
      slot: 'Rent_Roll',
      range: `F${row}`,
      selector: rrField(i, (l) => l.leaseStart),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // G<row>: Lease End / Expiration — ISO date string | null
    out.push({
      slot: 'Rent_Roll',
      range: `G${row}`,
      selector: rrField(i, (l) => l.leaseEnd),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // I<row>: Contract Rent PSF — derived from inPlaceRentAnnual / squareFeet.
    // Null when either input is missing — never fabricated as 0.
    out.push({
      slot: 'Rent_Roll',
      range: `I${row}`,
      selector: rrField(i, (l) => {
        if (l.inPlaceRentAnnual == null || l.squareFeet == null || l.squareFeet === 0) {
          return null;
        }
        return l.inPlaceRentAnnual / l.squareFeet;
      }),
      cellState: 'concluded',
      forceOverwrite: true,
    });
    // N<row>: Lease Type — the LeaseType enum verbatim (UNKNOWN renders
    // visibly per the rent-roll-render brief; never blanked).
    out.push({
      slot: 'Rent_Roll',
      range: `N${row}`,
      selector: rrField(i, (l) => l.leaseType),
      cellState: 'concluded',
      forceOverwrite: true,
    });
  }
  return out;
})();

// RRP toggle override on Property & Loan Summary!AA3. The template formula
// at AA3 is IF(VLOOKUP(Property_Type, Controls!$A$2:$E$17, 5, 0) = "RRP",
// "TRUE") — fails to resolve cleanly on Sunroad and caches as #N/A, which
// then propagates to S8 = AND(RRP="TRUE", $C$8="Mark to Market") on the
// Pro Forma sheet and through every dependent IF($S$8, …) formula. We
// hardcode "TRUE" here because rent-roll data exists; the downstream
// IF($S$8, …, in_place_branch) then resolves to a clean boolean and picks
// the in-place branch (since C8 defaults to a numeric, not "Mark to Market").
const V10_RRP_OVERRIDE_ENTRY: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'AA3',
  selector: tagSelector(() => 'TRUE', ['rentRoll']),
  cellState: 'concluded',
  forceOverwrite: true,
};

/**
 * Phase-A K5 override (v10) — Net Rentable Area sums tenant.squareFeet from
 * the v10 rent-roll bundle that the selector already has in scope. v9's K5
 * entry (nullSelector) is filtered out below; v10's selector takes its place
 * with cellState='concluded'. Honest-blank when no rent-roll lines are
 * present or no tenant carries a finite squareFeet — defensive sum: never
 * fabricates 0, an absent line contributes nothing, and the result is null
 * unless at least one finite-squareFeet line existed.
 */
const V10_NRA_OVERRIDE_ENTRY: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'K5',
  selector: tagSelector((input) => {
    const rr = input.rentRoll;
    if (!rr) return null;
    let total = 0;
    let any = false;
    for (const l of rr.lines) {
      if (l.kind !== 'tenant') continue;
      const sf = (l as { squareFeet?: number | null }).squareFeet;
      if (typeof sf === 'number' && Number.isFinite(sf) && sf > 0) {
        total += sf;
        any = true;
      }
    }
    return any ? total : null;
  }, ['rentRoll']),
  cellState: 'concluded',
  forceOverwrite: true,
};

/**
 * Phase A.5 E41 override (v10) — Appraised LTV = loanAmount / appraisal.asIsValue.
 *
 * The pre-existing v9 nullSelector comment rested on a premise that no longer
 * holds: it claimed "No appraisal slot in current 4-file ingest model (CF +
 * ASR + PCA + rent-roll)." Sunroad's CBRE appraisal IS ingested — the
 * extraction has `appraisal.valueConclusion = $122M`, `asIsValue = $122M`,
 * `overallCapRate = 6.25%`, etc., and the resolvedContext exposes these via
 * `buildAppraisalAtoms`. The original concern about "wiring it bare without
 * a basis qualifier" is also moot: the cell IS the explicit "Appraised LTV"
 * row in the workbook's Property & Loan Summary section, so the label
 * itself carries the basis.
 *
 * Selector reads BOTH adjustedInputs (loan amount) and resolvedContext
 * (appraisal value), tagged with both sources. APPRAISAL_SOURCED state
 * requires 'resolvedContext'; the multi-source tag satisfies via set
 * membership. Sunroad result: $11M / $122M = 9.02%.
 *
 * Honest-blank: when the bundle lacks an appraisal record (no
 * resolvedContext.appraisal.asIsValue) OR when loanAmount is missing, the
 * selector returns null — the cell stays blank.
 */
const V10_E41_OVERRIDE_ENTRY: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'E41',
  // NOTE on the shared/contract AdjustedInputs split: the render layer reads
  // packages/shared/src/types/adjusted-inputs.ts where loan.loanAmount is a
  // plain `number`, NOT the contracts-side AdjustedLineItem. Existing num()
  // selectors at lines 368/493/740 use `num((a) => a.loan.loanAmount)`
  // identically — no `.adjusted` access on this side.
  selector: tagSelector((input) => {
    const loan = (input.adjustedInputs as unknown as { loan: { loanAmount: number | null } }).loan.loanAmount;
    const apx = (input.resolvedContext as unknown as { appraisal?: { asIsValue?: number | null } }).appraisal;
    const value = apx?.asIsValue ?? null;
    if (typeof loan !== 'number' || !Number.isFinite(loan) || loan <= 0) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return loan / value;
  }, ['adjustedInputs', 'resolvedContext']),
  cellState: 'concluded',
  forceOverwrite: true,
};

/**
 * Phase A.5 Concluded_Cap_Rate override (v10) — appraiser-concluded OAR.
 *
 * The v9 nullSelector comment said: "Operator-supplied valuation is a
 * $-value, not a cap rate." True for the OPERATOR. But the CBRE appraisal
 * states an Overall Capitalization Rate explicitly — 6.25% in the exec
 * summary AND in the Direct Capitalization Summary. The workbook cell name
 * "Concluded_Cap_Rate" reads naturally as the appraiser-concluded OAR on a
 * deal that has an appraisal.
 *
 * Distinct from the doctrine-stressed cap rate (~8.50% for Sunroad) used in
 * dim-7 valuation stress — that's a separate engine output for a separate
 * cell. We are NOT crossing those.
 */
const V10_CONCLUDED_CAP_RATE_OVERRIDE_ENTRY: SchemaEntry = {
  slot: 'Conclusion_Escrows',
  range: 'Concluded_Cap_Rate',
  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.overallCapRate),
  cellState: 'concluded',
  forceOverwrite: true,
};

const V10_SHARED_ENTRIES: SchemaEntry[] = [
  // Carry V9 forward but drop entries we override at v10. Filter is keyed
  // on slot+range to avoid mis-matching other entries in the same slot.
  ...V9_SHARED_ENTRIES.filter(
    (e) =>
      !(e.slot === 'Property_Loan_Summary' && e.range === 'K5') &&
      !(e.slot === 'Property_Loan_Summary' && e.range === 'E41') &&
      !(e.slot === 'Conclusion_Escrows'    && e.range === 'Concluded_Cap_Rate'),
  ),
  ...V10_RENT_ROLL_ENTRIES,
  V10_RRP_OVERRIDE_ENTRY,
  V10_NRA_OVERRIDE_ENTRY,
  V10_E41_OVERRIDE_ENTRY,
  V10_CONCLUDED_CAP_RATE_OVERRIDE_ENTRY,
];

const V10_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  literals: V8_SHARED_ENTRIES.map((e) => e.range),
  // v10 takes 'Rent Roll' OUT of excludedSheets so the populator writes
  // per-tenant cells there. 'Presentation Rent Roll' / 'Rent Roll Summary' /
  // 'Rent Roll Footnotes' stay excluded — they're formula-only derivatives
  // that compute off the Rent Roll tab and have no inputs to receive.
  excludedSheets: SHARED_MANAGED_NAMESPACE.excludedSheets.filter(
    (s) => s !== 'Rent Roll',
  ),
};

function v10Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V10_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V10_MANAGED_NAMESPACE,
  };
}

function v10DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v10Definition(assetClass)];
}

const SCHEMA_V10: ContractSchema = {
  office: {
    office_core:       v10DefsFor('office'),
    office_trophy:     v10DefsFor('office'),
    office_value_add:  v10DefsFor('office'),
    office_distressed: v10DefsFor('office'),
  },
  multifamily: {
    mf_core:        v10DefsFor('multifamily'),
    mf_large_scale: v10DefsFor('multifamily'),
    mf_workforce:   v10DefsFor('multifamily'),
    mf_value_add:   v10DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v10DefsFor('industrial'),
    ind_logistics: v10DefsFor('industrial'),
    ind_light:     v10DefsFor('industrial'),
  },
  retail:               { retail_core:               v10DefsFor('retail') },
  hotel:                { hotel_core:                v10DefsFor('hotel') },
  self_storage:         { self_storage_core:         v10DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v10DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v10DefsFor('manufactured_housing') },
};

// --- v11 SCHEMA ENTRIES -----------------------------------------------------
// Tier-1 safe render wires. Two pure selectors against data already computed
// elsewhere in the pipeline. No new source surfaces — both selectors tag
// surfaces v10 already permits ('meta', 'adjustedInputs'). v10 entries carry
// forward verbatim; v11 only ADDS two cells and unexcludes the two sheets
// they live on.
//
//   • Cover Page!Deal_Control_Number (H2) ← meta.dealId. The analysis ID is
//     a route-controlled metadata field already on every RenderInput;
//     surfacing it on the Cover Page closes the workbook's deal-tracking
//     identifier slot.
//
//   • 10 Yr Pro Forma!Terminal_Cap_Rate (P36) ← resolvedContext.appraisal
//     .terminalCapRate. The terminal cap rate is already extracted from the
//     CBRE appraisal (extract-cbre-appraisal.ts:114), threaded into
//     AdjustedInputs.assumptions by the judgment engine (apply-judgment-
//     adjustments.ts buildTerminalCapRate), AND surfaced on
//     resolvedContext.appraisal.terminalCapRate (the resolver projects it
//     for render). The render-side AdjustedInputs shape (packages/shared)
//     strips `assumptions`, so this wire reads through the same
//     resolvedContext.appraisal channel that v10's Third Party Reports!E18
//     already uses for the identical datum. The verdict path already uses
//     this value through the stress-output chain; this wire only closes the
//     10 Yr Pro Forma render gap so the same value also displays in its
//     Terminal_Cap_Rate cell.
//
// HELD (NOT in schema): Property & Loan Summary!Loan_Balance (W7:W97).
// Recon confirmed the engine surfaces no amortization balance series — only
// scalars annualDebtService + maturityBalance. The workbook's own
// Amortization Schedule sheet projects the series via its existing formula
// chain (column I "Ending Balance", driven by Note_Date / Original_Balance /
// Coupon). Wiring W7:W97 would require either (a) a formula-emitting
// selector path that does not currently exist (selectors return CellValue,
// not formulas) or (b) an engine extension to compute the series. Either is
// out of scope for "render-layer selectors only". Surfaced as a finding;
// keep W7:W97 honest-blank at v11.

const V11_DEAL_CONTROL_NUMBER_ENTRY: SchemaEntry = {
  slot: 'Cover_Page',
  range: 'Deal_Control_Number',
  selector: meta((i) => i.meta.dealId),
  cellState: 'concluded',
};

const V11_TERMINAL_CAP_RATE_ENTRY: SchemaEntry = {
  slot: 'Ten_Year_Pro_Forma',
  range: 'Terminal_Cap_Rate',
  // Same resolvedContext channel that v10's Third Party Reports!E18 reads
  // for the identical extracted-appraisal value (CBRE OAR / terminal). The
  // shared-package AdjustedInputs shape does not surface `assumptions`, so
  // the render layer reads through resolvedContext.appraisal — matching the
  // E18 wire's source-tagging.
  selector: ctx((c) => (c as never as { appraisal: Record<string, CellValue> }).appraisal.terminalCapRate),
  cellState: 'concluded',
};

const V11_SHARED_ENTRIES: SchemaEntry[] = [
  ...V10_SHARED_ENTRIES,
  V11_DEAL_CONTROL_NUMBER_ENTRY,
  V11_TERMINAL_CAP_RATE_ENTRY,
];

const V11_MANAGED_NAMESPACE: ManagedNamespacePolicy = {
  prefixes: [],
  literals: V8_SHARED_ENTRIES.map((e) => e.range),
  // v11 takes 'Cover Page' and '10 Yr Pro Forma' OUT of excludedSheets so
  // the populator can write H2 / P36 there. 'Rent Roll' is already
  // unexcluded at v10; carry that through.
  excludedSheets: V10_MANAGED_NAMESPACE.excludedSheets.filter(
    (s) => s !== 'Cover Page' && s !== '10 Yr Pro Forma',
  ),
};

function v11Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V11_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE,
  };
}

function v11DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v11Definition(assetClass)];
}

const SCHEMA_V11: ContractSchema = {
  office: {
    office_core:       v11DefsFor('office'),
    office_trophy:     v11DefsFor('office'),
    office_value_add:  v11DefsFor('office'),
    office_distressed: v11DefsFor('office'),
  },
  multifamily: {
    mf_core:        v11DefsFor('multifamily'),
    mf_large_scale: v11DefsFor('multifamily'),
    mf_workforce:   v11DefsFor('multifamily'),
    mf_value_add:   v11DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v11DefsFor('industrial'),
    ind_logistics: v11DefsFor('industrial'),
    ind_light:     v11DefsFor('industrial'),
  },
  retail:               { retail_core:               v11DefsFor('retail') },
  hotel:                { hotel_core:                v11DefsFor('hotel') },
  self_storage:         { self_storage_core:         v11DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v11DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v11DefsFor('manufactured_housing') },
};

// ── v12: Loan Purpose → K27 (Property & Loan Summary) ────────────────────────
// Purely additive over v11. The single new emitted address is
// 'Property & Loan Summary!K27', sourced from c.property.loanPurpose
// (propertyMetadata.loanPurpose), mirroring the buildingClass binding pattern.
// The v11 slice above is NOT mutated — older templates keep rendering identical
// output. (Hard invariant: do not change v11 to accommodate v12.)
const V12_LOAN_PURPOSE_ENTRY: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'K27',
  selector: ctx((c) => c.property.loanPurpose),
  cellState: 'concluded',
};

const V12_SHARED_ENTRIES: SchemaEntry[] = [
  ...V11_SHARED_ENTRIES,
  V12_LOAN_PURPOSE_ENTRY,
];

function v12Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V12_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged — K27 needs no namespace change
  };
}

function v12DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v12Definition(assetClass)];
}

const SCHEMA_V12: ContractSchema = {
  office: {
    office_core:       v12DefsFor('office'),
    office_trophy:     v12DefsFor('office'),
    office_value_add:  v12DefsFor('office'),
    office_distressed: v12DefsFor('office'),
  },
  multifamily: {
    mf_core:        v12DefsFor('multifamily'),
    mf_large_scale: v12DefsFor('multifamily'),
    mf_workforce:   v12DefsFor('multifamily'),
    mf_value_add:   v12DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v12DefsFor('industrial'),
    ind_logistics: v12DefsFor('industrial'),
    ind_light:     v12DefsFor('industrial'),
  },
  retail:               { retail_core:               v12DefsFor('retail') },
  hotel:                { hotel_core:                v12DefsFor('hotel') },
  self_storage:         { self_storage_core:         v12DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v12DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v12DefsFor('manufactured_housing') },
};

// v13 — bind the Rent Roll Rank column (Rent Roll!A14:A43). The rent-roll lines
// arrive income-sorted (largest in-place rent first), so a tenant's rank is its
// 1-based index: A14=1, A15=2, … A43=30. The existing rrField guard returns null
// for rows beyond the tenant count (honest-blank, never 0). This is the join key
// the Stress Scenario tab keys on (SUMIF/MATCH on 'Rent Roll'!$A$14:$A$323) —
// the column was previously unbound (V10_RENT_ROLL_ENTRIES binds B,C,D,E,F,G,I,N
// but NOT A), which is why the tenant-loss stress columns returned N/A.
//
// NEW array — V10_RENT_ROLL_ENTRIES is spread into v10–v12 and must NOT be
// edited (that would retroactively mutate prior versions). v13 appends only.
const V13_RENT_ROLL_RANK_ENTRIES: SchemaEntry[] = (() => {
  const out: SchemaEntry[] = [];
  for (let i = 0; i < RENT_ROLL_TENANT_CAPACITY; i++) {
    const row = RENT_ROLL_FIRST_ROW + i;
    // A<row>: Rank — income-sorted 1-based index. rrField(i, …)'s guard yields
    // null for unused rows (i >= tenant count) → honest-blank for A24+ here.
    out.push({
      slot: 'Rent_Roll',
      range: `A${row}`,
      selector: rrField(i, () => i + 1),
      cellState: 'concluded',
      forceOverwrite: true,
    });
  }
  return out;
})();

const V13_SHARED_ENTRIES: SchemaEntry[] = [
  ...V12_SHARED_ENTRIES,
  ...V13_RENT_ROLL_RANK_ENTRIES,
];

function v13Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V13_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged — Rank needs no namespace change
  };
}

function v13DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v13Definition(assetClass)];
}

const SCHEMA_V13: ContractSchema = {
  office: {
    office_core:       v13DefsFor('office'),
    office_trophy:     v13DefsFor('office'),
    office_value_add:  v13DefsFor('office'),
    office_distressed: v13DefsFor('office'),
  },
  multifamily: {
    mf_core:        v13DefsFor('multifamily'),
    mf_large_scale: v13DefsFor('multifamily'),
    mf_workforce:   v13DefsFor('multifamily'),
    mf_value_add:   v13DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v13DefsFor('industrial'),
    ind_logistics: v13DefsFor('industrial'),
    ind_light:     v13DefsFor('industrial'),
  },
  retail:               { retail_core:               v13DefsFor('retail') },
  hotel:                { hotel_core:                v13DefsFor('hotel') },
  self_storage:         { self_storage_core:         v13DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v13DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v13DefsFor('manufactured_housing') },
};

// v14 — bind the Property & Loan Summary Sources & Uses block from the ASR's
// deterministically-parsed S&U table, via resolvedContext.sourcesUses.*. The
// six value cells (F27-F31, K30) are template inputs (0); the totals (F32, B32,
// K31, K32) and the sources side (B27 = Original_Balance) are formula-wired and
// are NOT bound. Purchase Price (K29) stays honest-blank — Sunroad is a refi.
//
// NEW array — appends to V13; the v13 slice carries forward byte-for-byte.
const V14_SOURCES_USES_ENTRIES: SchemaEntry[] = [
  // F27 — "Previous Debt" (D27 label is ="Refinance"→Previous Debt): loan payoff.
  { slot: 'Property_Loan_Summary', range: 'F27', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.loanPayoff),          cellState: 'concluded' },
  // F28 — Cash to Borrower (refi return of equity).
  { slot: 'Property_Loan_Summary', range: 'F28', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.returnOfEquity),      cellState: 'concluded' },
  // F29 — Escrow / Reserves (unfunded obligations).
  { slot: 'Property_Loan_Summary', range: 'F29', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.unfundedObligations), cellState: 'concluded' },
  // F30 — Closing Costs.
  { slot: 'Property_Loan_Summary', range: 'F30', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.closingCosts),        cellState: 'concluded' },
  // F31 — Other (capital expenditures reserve).
  { slot: 'Property_Loan_Summary', range: 'F31', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.capitalExpenditures), cellState: 'concluded' },
  // K30 — Total Cost Basis.
  { slot: 'Property_Loan_Summary', range: 'K30', selector: ctx((c) => (c as never as { sourcesUses: Record<string, CellValue> }).sourcesUses.totalCostBasis),      cellState: 'concluded' },
];

const V14_SHARED_ENTRIES: SchemaEntry[] = [
  ...V13_SHARED_ENTRIES,
  ...V14_SOURCES_USES_ENTRIES,
];

function v14Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V14_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged
  };
}

function v14DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v14Definition(assetClass)];
}

const SCHEMA_V14: ContractSchema = {
  office: {
    office_core:       v14DefsFor('office'),
    office_trophy:     v14DefsFor('office'),
    office_value_add:  v14DefsFor('office'),
    office_distressed: v14DefsFor('office'),
  },
  multifamily: {
    mf_core:        v14DefsFor('multifamily'),
    mf_large_scale: v14DefsFor('multifamily'),
    mf_workforce:   v14DefsFor('multifamily'),
    mf_value_add:   v14DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v14DefsFor('industrial'),
    ind_logistics: v14DefsFor('industrial'),
    ind_light:     v14DefsFor('industrial'),
  },
  retail:               { retail_core:               v14DefsFor('retail') },
  hotel:                { hotel_core:                v14DefsFor('hotel') },
  self_storage:         { self_storage_core:         v14DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v14DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v14DefsFor('manufactured_housing') },
};

// v15 — bind Property & Loan Summary!C13 (the Note_Date named range's cell) to
// the loan Note Date serial (resolvedContext.property.noteDate, derived
// credit-free from maturityDate − termMonths). This anchors the period-date
// headers: YEAR(Note_Date)-1 etc. were rendering 1899 (empty cell → epoch).
// Mirrors the K27 loanPurpose binding. The TODAY()-leak in OH!H3 (→ 2026) is
// fixed separately in the template artifact (H3 now reads YEAR(Note_Date)).
const V15_NOTE_DATE_ENTRY: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'C13',
  selector: ctx((c) => c.property.noteDate),
  cellState: 'concluded',
};

const V15_SHARED_ENTRIES: SchemaEntry[] = [
  ...V14_SHARED_ENTRIES,
  V15_NOTE_DATE_ENTRY,
];

function v15Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V15_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged
  };
}

function v15DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v15Definition(assetClass)];
}

const SCHEMA_V15: ContractSchema = {
  office: {
    office_core:       v15DefsFor('office'),
    office_trophy:     v15DefsFor('office'),
    office_value_add:  v15DefsFor('office'),
    office_distressed: v15DefsFor('office'),
  },
  multifamily: {
    mf_core:        v15DefsFor('multifamily'),
    mf_large_scale: v15DefsFor('multifamily'),
    mf_workforce:   v15DefsFor('multifamily'),
    mf_value_add:   v15DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v15DefsFor('industrial'),
    ind_logistics: v15DefsFor('industrial'),
    ind_light:     v15DefsFor('industrial'),
  },
  retail:               { retail_core:               v15DefsFor('retail') },
  hotel:                { hotel_core:                v15DefsFor('hotel') },
  self_storage:         { self_storage_core:         v15DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v15DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v15DefsFor('manufactured_housing') },
};

// v16 — corrective OVERRIDE of Balloon_Term (an existing v6 address). The v6
// entries (lines ~506/~750) bind it via ctxLoanMonthsToYears(termMonths) →
// round(27/12)=2 (wrong source: remaining term; wrong unit: years). Those v6
// entries are spread into v6–v15 and must NOT be edited (render-versioning).
// Appended last, this override wins (projectCellBindings is last-by-order) and
// emits ioMonths (60, MONTHS), matching Interest_Only_Period — so the
// amortization balloon fires at month 60 and Annual_Debt_Service takes the IO
// branch. No new address; the v15 slice carries forward byte-for-byte.
const V16_BALLOON_TERM_OVERRIDE: SchemaEntry = {
  slot: 'Property_Loan_Summary',
  range: 'Balloon_Term',
  selector: ctx((c) => c.loan.ioMonths),
  cellState: 'concluded',
};

// Schema slices require UNIQUE addresses, so this REPLACES the carried-forward
// Balloon_Term entry (filter it out) rather than appending a duplicate.
const V16_SHARED_ENTRIES: SchemaEntry[] = [
  ...V15_SHARED_ENTRIES.filter(
    (e) => !(e.slot === 'Property_Loan_Summary' && e.range === 'Balloon_Term'),
  ),
  V16_BALLOON_TERM_OVERRIDE,
];

function v16Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V16_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged
  };
}

function v16DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v16Definition(assetClass)];
}

const SCHEMA_V16: ContractSchema = {
  office: {
    office_core:       v16DefsFor('office'),
    office_trophy:     v16DefsFor('office'),
    office_value_add:  v16DefsFor('office'),
    office_distressed: v16DefsFor('office'),
  },
  multifamily: {
    mf_core:        v16DefsFor('multifamily'),
    mf_large_scale: v16DefsFor('multifamily'),
    mf_workforce:   v16DefsFor('multifamily'),
    mf_value_add:   v16DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v16DefsFor('industrial'),
    ind_logistics: v16DefsFor('industrial'),
    ind_light:     v16DefsFor('industrial'),
  },
  retail:               { retail_core:               v16DefsFor('retail') },
  hotel:                { hotel_core:                v16DefsFor('hotel') },
  self_storage:         { self_storage_core:         v16DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v16DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v16DefsFor('manufactured_housing') },
};

// v17 — bind the T12 historical column (H) on Operating History from
// resolvedContext.t12.* (analysis.t12Extraction — the normalized borrower
// 12-month statement). Mirrors the issuer-UW column L cell-for-cell (same 16
// input rows; the H10/H12/H17/H27/H33/H35 subtotals are formulas, never bound).
// Display-only historical column — doctrine stays frozen. Column H was
// previously honest-blank (no source); v17 fills it from the FINAL-vintage
// borrower actuals while the loan terms remain PRELIM vintage (asymmetry noted
// in the H9 cell comment).
const v17T12 = (range: string, atom: string, comment?: () => string): SchemaEntry => ({
  slot: 'Operating_ProForma', range,
  selector: ctx((c) => (c as never as { t12: Record<string, CellValue> }).t12[atom]),
  cellState: 'concluded',
  ...(comment ? { comment } : {}),
});

const V17_T12_ENTRIES: SchemaEntry[] = [
  v17T12('H9', 'pgr', () =>
    'T12 historical actuals — borrower 12-month operating statement, period ' +
    'Mar 2023–Feb 2024 (FINAL vintage 3/25/2024). NORMALIZATIONS: (1) one-time ' +
    'lease-termination fee $2,850,631 (acct 420625, Jul-2023) EXCLUDED from ' +
    'income; (2) operating electric $228,405 (Vacant-Space $82,869 + GSA ' +
    '$145,536) reclassified from below-NOI into utilities. Derived T12 NOI ' +
    '$3,873,434; ties to the issuer completed-UW T12 ($3,863,842) within ~$9.6K ' +
    '(~0.25%, category-mapping rounding). VINTAGE ASYMMETRY: this T12 column is ' +
    'FINAL-vintage actuals; the loan terms on this deal remain PRELIM vintage. ' +
    'RED FLAG: a tenant paid $2.85M to terminate early in the trailing period ' +
    'and the window also carries vacant-space electric — a tenant-departure / ' +
    'rollover signal for the memo, not just a normalization.'),
  v17T12('H6', 'economicOccupancy'),
  v17T12('H11', 'badDebt'),
  v17T12('H13', 'uwAdjustments'),
  v17T12('H14', 'otherIncome'),
  v17T12('H15', 'reimbursements'),
  v17T12('H22', 'expensesGeneralAdmin'),
  v17T12('H24', 'expensesRepairsMaintenance'),
  v17T12('H25', 'expensesUtilities'),
  v17T12('H26', 'expensesOtherVariable'),
  v17T12('H30', 'expensesManagement'),
  v17T12('H31', 'expensesTaxes'),
  v17T12('H32', 'expensesInsurance'),
  v17T12('H38', 'capex'),
  v17T12('H39', 'tenantImprovements'),
  v17T12('H40', 'leasingCommissions'),
];

const V17_SHARED_ENTRIES: SchemaEntry[] = [
  ...V16_SHARED_ENTRIES,
  ...V17_T12_ENTRIES,
];

function v17Definition(assetClass: AssetType): SchemaDefinition {
  return {
    underwritingModes: ['single_loan', 'roll_up'],
    visibleTabs: tabsFor(assetClass),
    entries: V17_SHARED_ENTRIES,
    tableLayouts: V6_TABLE_LAYOUTS,
    managedNamespace: V11_MANAGED_NAMESPACE, // unchanged
  };
}

function v17DefsFor(assetClass: AssetType): SchemaDefinition[] {
  return [v17Definition(assetClass)];
}

const SCHEMA_V17: ContractSchema = {
  office: {
    office_core:       v17DefsFor('office'),
    office_trophy:     v17DefsFor('office'),
    office_value_add:  v17DefsFor('office'),
    office_distressed: v17DefsFor('office'),
  },
  multifamily: {
    mf_core:        v17DefsFor('multifamily'),
    mf_large_scale: v17DefsFor('multifamily'),
    mf_workforce:   v17DefsFor('multifamily'),
    mf_value_add:   v17DefsFor('multifamily'),
  },
  industrial: {
    ind_core:      v17DefsFor('industrial'),
    ind_logistics: v17DefsFor('industrial'),
    ind_light:     v17DefsFor('industrial'),
  },
  retail:               { retail_core:               v17DefsFor('retail') },
  hotel:                { hotel_core:                v17DefsFor('hotel') },
  self_storage:         { self_storage_core:         v17DefsFor('self_storage') },
  mixed_use:            { mixed_use_core:            v17DefsFor('mixed_use') },
  manufactured_housing: { manufactured_housing_core: v17DefsFor('manufactured_housing') },
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
  8: SCHEMA_V8,
  9: SCHEMA_V9,
  10: SCHEMA_V10,
  11: SCHEMA_V11,
  12: SCHEMA_V12,
  13: SCHEMA_V13,
  14: SCHEMA_V14,
  15: SCHEMA_V15,
  16: SCHEMA_V16,
  17: SCHEMA_V17,
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
    // v8 is a SHAPE bump (cellStates + cellComments + floorBindings on the
    // payload contract). No cells move source surfaces — every v8 entry is
    // carried over verbatim from v7 with cellState='concluded'. The allowed-
    // source set therefore equals v7.
    8: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta']),
    // v9 (Phase A, populated-workbook) ADDS operating-proforma fills and
    // DSCR/Debt Yield closures plus AWAITING_INPUT entries. No new source
    // surfaces — every v9 selector reads from adjustedInputs (numeric
    // line-items + metrics) or resolvedContext (carried-forward property /
    // party / loan-term atoms). Allowed-source set therefore equals v8.
    9: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta']),
    // v10 ADDS the 'rentRoll' source surface — the per-tenant Rent Roll rows
    // (and the RRP toggle on Property & Loan Summary!AA3) read from the
    // hydrated bundle.rentRoll passthrough on RenderInput. Carry-forward
    // entries from v9 continue to read from adjustedInputs / resolvedContext /
    // meta unchanged.
    10: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v11 ADDS no new source surface — Deal_Control_Number reads from 'meta'
    // (already permitted since v7) and Terminal_Cap_Rate reads from
    // 'adjustedInputs' (the foundational v6 surface). The v11 widening is
    // structural (two new SheetSlots + two new addresses + Cover Page /
    // 10 Yr Pro Forma removed from excludedSheets), not source-policy.
    11: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v12 ADDS no new source surface — the single new address (K27 Loan Purpose)
    // reads from 'resolvedContext' (c.property.loanPurpose), permitted since v7.
    // All v11 entries carry forward verbatim.
    12: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v13 ADDS no new source surface — the 30 new Rent Roll!A14:A43 Rank cells
    // read from 'rentRoll' (allowlisted since v10). All v12 entries carry
    // forward verbatim.
    13: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v14 ADDS no new source surface — the 6 new Sources & Uses cells
    // (F27-F31, K30) read from 'resolvedContext' (c.sourcesUses.*), permitted
    // since v7. All v13 entries carry forward verbatim.
    14: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v15 ADDS no new source surface — the single new Note_Date cell (C13)
    // reads from 'resolvedContext' (c.property.noteDate), permitted since v7.
    // All v14 entries carry forward verbatim.
    15: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v16 ADDS no new source surface and no new address — it re-points an
    // existing cell (Balloon_Term) to 'resolvedContext' (c.loan.ioMonths),
    // permitted since v7. All v15 entries carry forward verbatim.
    16: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
    // v17 ADDS no new source surface — the 16 new T12 column-H cells read from
    // 'resolvedContext' (c.t12.*), permitted since v7. All v16 entries carry
    // forward verbatim.
    17: new Set<SourceSurface>(['adjustedInputs', 'resolvedContext', 'meta', 'rentRoll']),
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
 * Result of projecting a ProjectionInput against the schema. The three
 * maps are address-keyed:
 *   - bindings: every declared address → CellValue (number/string/bool/null)
 *   - states:   every declared address → CellState (matches bindings keys)
 *   - comments: SPARSE — only addresses whose state is 'hitl' or
 *               'awaiting_input' AND whose `comment` selector returned
 *               non-null text emit an entry.
 *
 * Adopted in v8 (Phase B of the populated-workbook initiative). v6/v7
 * callers see the bindings map under the same keys; the additional maps
 * are simply empty-of-comments and uniformly 'concluded' for those
 * versions (every v6/v7 entry was annotated cellState: 'concluded').
 */
export interface ProjectionResult {
  bindings: CellBindings;
  states: CellStateMap;
  comments: CellCommentMap;
  /** Sparse map: addresses where the schema entry set forceOverwrite=true.
   *  Populator uses this to overwrite an existing formula cell with the
   *  literal value instead of preserving the formula. */
  overwrites: Record<string, boolean>;
}

/**
 * Project a ProjectionInput (RenderInput + pre-resolved underwriting
 * context) into the complete cellBindings + cellStates + cellComments
 * maps for its (asset class, structural variant, underwriting mode) at
 * the given contract version. Pure projection — selectors do not branch.
 *
 * The three maps share their key set (states ⊇ bindings; comments ⊆
 * bindings). `assertProjectionMatchesSchema` verifies this invariant
 * downstream.
 */
export function projectCellBindings(
  input: ProjectionInput,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): ProjectionResult {
  const def = definitionFor(
    input.assetClass,
    input.structuralVariantKey,
    input.underwritingMode,
    contractVersion,
  );
  const bindings: CellBindings = {};
  const states: CellStateMap = {};
  const comments: CellCommentMap = {};
  const overwrites: Record<string, boolean> = {};
  for (const e of def.entries) {
    const sheetName = sheet(input.assetClass, e.slot);
    const address = `${sheetName}!${e.range}`;
    bindings[address] = e.selector(input);
    const state: CellState = e.cellState ?? 'concluded';
    states[address] = state;
    if (e.forceOverwrite === true) {
      overwrites[address] = true;
    }
    // Comments are emitted ONLY for non-'concluded' states OR when
    // forceOverwrite is set (direct-display cells may carry an explanatory
    // cell note even though they're concluded). 'concluded' cells without
    // forceOverwrite never carry a comment.
    if ((state !== 'concluded' || e.forceOverwrite === true) && e.comment) {
      const text = e.comment(input);
      if (text != null && text !== '') {
        comments[address] = { state, text };
      }
    }
  }
  return { bindings, states, comments, overwrites };
}

/**
 * Per-request invariant: bindings emitted by projectCellBindings must equal
 * (set-wise) the canonical schema addresses for the four-axis tuple. Any
 * drift — extra key, missing key, mistyped address — is a hard error.
 *
 * v8 extension: also verifies that `states` shares its key set with
 * `bindings`, and that `comments` is a SUBSET of bindings (sparse map).
 * For each non-'concluded' state, no further structural check — the
 * comment map may legitimately omit a cell whose comment selector
 * returned null.
 */
export function assertProjectionMatchesSchema(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  result: CellBindings | ProjectionResult,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): void {
  const expected = new Set(
    getSchemaAddresses(assetClass, variantKey, underwritingMode, contractVersion),
  );
  const bindings: CellBindings = isProjectionResult(result) ? result.bindings : result;
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
  if (isProjectionResult(result)) {
    const stateKeys = new Set(Object.keys(result.states));
    const stateMissing: string[] = [];
    const stateUnexpected: string[] = [];
    for (const k of actual) if (!stateKeys.has(k)) stateMissing.push(k);
    for (const k of stateKeys) if (!actual.has(k)) stateUnexpected.push(k);
    if (stateMissing.length || stateUnexpected.length) {
      throw new RenderSchemaError(
        'PROJECTION_CELL_STATES_MISMATCH',
        `cellStates keys do not match cellBindings keys for (contractVersion=${contractVersion}, assetClass=${assetClass}, structuralVariantKey=${variantKey}, underwritingMode=${underwritingMode}).`,
        {
          contractVersion, assetClass, structuralVariantKey: variantKey, underwritingMode,
          missingStateKeys: stateMissing,
          unexpectedStateKeys: stateUnexpected,
        },
      );
    }
    // Comments are sparse — they MUST be a subset of bindings, and each
    // entry's state MUST agree with cellStates for the same address.
    const commentExtras: string[] = [];
    const commentStateDisagreements: Array<{ address: string; commentState: string; cellState: string }> = [];
    for (const [addr, c] of Object.entries(result.comments)) {
      if (!actual.has(addr)) {
        commentExtras.push(addr);
        continue;
      }
      const cs = result.states[addr];
      if (cs !== c.state) {
        commentStateDisagreements.push({ address: addr, commentState: c.state, cellState: cs });
      }
    }
    if (commentExtras.length || commentStateDisagreements.length) {
      throw new RenderSchemaError(
        'PROJECTION_CELL_COMMENTS_MISMATCH',
        `cellComments contains entries that are not addresses in cellBindings, or whose state disagrees with cellStates.`,
        {
          contractVersion, assetClass, structuralVariantKey: variantKey, underwritingMode,
          unexpectedCommentKeys: commentExtras,
          stateDisagreements: commentStateDisagreements,
        },
      );
    }
  }
}

function isProjectionResult(v: CellBindings | ProjectionResult): v is ProjectionResult {
  return v != null && typeof v === 'object' && 'bindings' in v && 'states' in v && 'comments' in v;
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
