/**
 * Excel Render Contract
 *
 * Architecture role: Excel is a deterministic rendering layer ONLY.
 * See memory/architecture_excel_role.md.
 *
 * The render layer is a PURE PROJECTION over `AdjustedInputs`. It does not
 * read internal pipeline state, intermediate models, or analysis graphs.
 * Inputs in → flat cell map out.
 */
import type { AssetType, CrossCheckFinding } from './analysis';
import type { AdjustedInputs } from './adjusted-inputs';
import type { UnderwritingContext, UnderwritingMode } from './underwriting-context';
import type { MigrationManifest } from './render-migration';

/**
 * Bumped on any breaking change to RenderPayload or BINDING_SCHEMA.
 *
 * v7 → v8 (Phase B, populated-workbook initiative): RenderPayload gains
 * `cellStates` + `cellComments` parallel maps; RenderConservatismStatus
 * gains `floorBindings`. No new cells. Same (assetClass, variantKey,
 * underwritingMode) renders the same structural surface as v7 — every
 * v7 cell is marked `cellState: 'concluded'` at v8.
 */
export const RENDER_CONTRACT_VERSION = 8;

/**
 * Controlled structural variance within an asset class. Each (assetClass,
 * structuralVariantKey) pair selects ONE schema definition (visibleTabs,
 * schemaAddresses, cellBindings, tableLayouts, managedNamespace policy).
 *
 * Determinism rules (see memory/architecture_render_versioning.md):
 *   - structuralVariantKey is REQUIRED for every render.
 *   - The key is determined by (a) the request's explicit
 *     `structuralVariantKey` parameter, OR (b) backend
 *     resolveStructuralVariant(assetClass, adjustedInputs, analysisMeta).
 *     No other sources, no implicit defaults, no fallback.
 *   - Same (assetClass, contractVersion, structuralVariantKey) MUST always
 *     produce identical structural output.
 *   - The key participates in fingerprint computation.
 */
export type StructuralVariantKey =
  | 'office_core'
  | 'office_trophy'
  | 'office_value_add'
  | 'office_distressed'
  | 'mf_core'
  | 'mf_large_scale'
  | 'mf_workforce'
  | 'mf_value_add'
  | 'ind_core'
  | 'ind_logistics'
  | 'ind_light'
  | 'retail_core'
  | 'hotel_core'
  | 'self_storage_core'
  | 'mixed_use_core'
  | 'manufactured_housing_core';

/** A primitive a cell can hold. No formulas, no objects. */
export type CellValue = number | string | boolean | null;

/**
 * Map of fully-qualified cell addresses to values.
 *
 * Address syntax (BOTH supported by VBA Range()):
 *   "SheetName!A1"          — explicit cell address
 *   "SheetName!NamedRange"  — sheet- or workbook-scoped named range
 *
 * Excel iterates this map and writes each value verbatim. No Excel-side math.
 */
export type CellBindings = Record<string, CellValue>;

/**
 * Three-state classification for every cell the workbook will render.
 * Parallel to CellBindings — every address in cellBindings has exactly
 * one CellState in cellStates.
 *
 *   concluded      — engine value-add; the cell carries the engine value
 *                    with no special fill or comment. Template formatting
 *                    is preserved verbatim.
 *   hitl           — deliberately blank; analyst input required (site
 *                    visit, broker interview, market commentary, sales
 *                    comps). The cell value is null, a GRAY fill is
 *                    applied, and a comment naming the HITL category is
 *                    written.
 *   awaiting_input — a rule fired that needs a manual input which does
 *                    not yet exist (extraction gap, manualInputs gap,
 *                    missing field). The cell value is null, a RED fill
 *                    is applied (the existing "missing data" visual is
 *                    preserved), and a comment naming the rule + the
 *                    specific gap is written.
 */
export type CellState = 'concluded' | 'hitl' | 'awaiting_input';

/**
 * Parallel to cellBindings: every address declared by the schema also
 * has a state declaring how the workbook should render it. Keys MUST
 * exactly match the keys of cellBindings (well-formedness invariant).
 */
export type CellStateMap = Record<string, CellState>;

/**
 * Optional cell comment attached to non-'concluded' cells. Only `hitl`
 * and `awaiting_input` cells emit comments — `concluded` cells never do.
 * The `text` field is the comment body written into the Excel cell note.
 */
export interface CellComment {
  readonly state: 'hitl' | 'awaiting_input';
  readonly text: string;
}

/**
 * Parallel to cellBindings, but sparse: only `hitl` and `awaiting_input`
 * cells appear. A 'concluded' cell address NEVER has an entry here.
 */
export type CellCommentMap = Record<string, CellComment>;

/**
 * Surfaces an AdjustedInputs line item whose adjusted value was raised
 * by a library or bank floor (e.g. `JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN`,
 * `JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN`,
 * `JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY`). Downstream consumers
 * — including the populated workbook's Conclusions tab — surface this
 * as a visible disclosure so floor-driven metrics aren't read as
 * source-derived. Keeps the floor-chain honest.
 */
export interface FloorBinding {
  /** Line-item field name on AdjustedInputs (e.g. 'totalOperatingExpenses', 'vacancyPct', 'noi'). */
  readonly lineItem: string;
  /** The rule id that fired the floor (e.g. 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN'). */
  readonly ruleId: string;
  /**
   * Dollars (or unit-appropriate magnitude) the floor raised the value
   * by, signed positive. For non-dollar line items (e.g. vacancyPct), the
   * delta is in that field's native units; consumers display it through
   * the same renderer the line item itself uses.
   */
  readonly delta: number;
  /** Human-readable reason; mirrors the source AdjustmentEntry.reason. */
  readonly reason: string;
}

export interface RenderConservatismStatus {
  approved: boolean;
  flags: string[];
  /**
   * Line items whose adjusted value was raised by a library or bank
   * floor. Empty array when no floor-binding rule fired during judgment.
   * Order is deterministic over the judgment-ledger walk: top-level
   * adjustments first (in their original order), then per-line-item
   * adjustments (walked in a stable, alphabetized structural path).
   */
  readonly floorBindings: ReadonlyArray<FloorBinding>;
}

export interface RenderLibraryBaselineMeta {
  assetType: AssetType;
  sampleSize: number | null;
  vacancyMedian: number | null;
  expenseRatioMedian: number | null;
  capRateMedian: number | null;
  degraded: boolean;
}

/** Minimal deal metadata that the workbook displays on the Cover sheet. */
export interface RenderMeta {
  dealId: string;
  dealName: string;
  generatedAt: string;
}

/**
 * Sole input to the render service. Composing this object is the only
 * coupling point with the rest of the system.
 *
 * `structuralVariantKey` AND `underwritingMode` are REQUIRED. The route either
 * reads each from the request or computes it via the appropriate resolver;
 * the render service never resolves, defaults, or falls back. Together with
 * (assetClass, contractVersion) they form the four-axis key the schema is
 * indexed by.
 *
 * `underwritingContext` carries every narrative / portfolio / aggregation
 * field the workbook renders. AdjustedInputs remains strictly numeric — no
 * sentinels, no narrative.
 */
export interface RenderInput {
  meta: RenderMeta;
  assetClass: AssetType;
  structuralVariantKey: StructuralVariantKey;
  underwritingMode: UnderwritingMode;
  adjustedInputs: AdjustedInputs;
  underwritingContext: UnderwritingContext;
  drivers: CrossCheckFinding[];
  conservatismStatus: RenderConservatismStatus;
  libraryBaselineMeta: RenderLibraryBaselineMeta;
}

/**
 * Authoritative description of which workbook named ranges belong to the
 * "managed namespace" — i.e. names whose existence is governed by the schema.
 *
 * Backend is the SOLE owner of this policy. The workbook receives it from
 * the API and applies it without inferring or extending. Any name in the
 * managed namespace must appear in `schemaAddresses`; anything outside it is
 * user-owned and ignored by validation.
 */
export interface ManagedNamespacePolicy {
  prefixes: string[];        // e.g. ["Income_", "Expense_", "Metric_", ...]
  literals: string[];        // e.g. ["Deal_Name", "Asset_Class", "Generated_At"]
  excludedSheets: string[];  // sheets the validator should skip (e.g. ["Inputs", "_Config"])
}

/**
 * Declarative layout for a tabular section the workbook renders. Columns,
 * sheet, and starting rows are decided by the backend — VBA only writes.
 */
export interface TableColumn {
  header: string;
  sourceField: string;  // key into the row object the backend ships
}
export interface TableLayout {
  name: string;
  sheetName: string;
  headerRow: number;       // 1-indexed row where headers are written
  dataStartRow: number;    // 1-indexed row where the first data row goes
  columns: TableColumn[];
}
export interface TablePayload {
  layout: TableLayout;
  rows: Array<Record<string, CellValue>>;
}

/**
 * Derived structural identity for a render payload. Two payloads sharing the
 * same (assetClass, contractVersion, structuralVariantKey, underwritingMode)
 * MUST produce the same fingerprint — i.e. identical visibleTabs,
 * schemaAddresses, managedNamespace, and table layouts.
 *
 * The fingerprint is a SHA-256 hash over a canonical, sorted-key JSON encoding
 * that includes assetClass + contractVersion + structuralVariantKey +
 * underwritingMode + the canonical schema snapshot. No hidden inputs. The
 * backend asserts the payload's structural surface matches the canonical
 * snapshot for the four-axis key before responding; clients may also verify
 * the fingerprint independently.
 */
export interface StructuralIdentity {
  assetClass: AssetType;
  contractVersion: number;
  structuralVariantKey: StructuralVariantKey;
  underwritingMode: UnderwritingMode;
  fingerprint: string;
}

export interface RenderPayload {
  contractVersion: number;
  dealId: string;
  assetClass: AssetType;
  /**
   * Mirrored at top level so the workbook can route on it without unpacking
   * structuralIdentity. MUST equal structuralIdentity.structuralVariantKey.
   */
  structuralVariantKey: StructuralVariantKey;
  /**
   * Mirrored at top level for the same reason. MUST equal
   * structuralIdentity.underwritingMode.
   */
  underwritingMode: UnderwritingMode;
  /**
   * Derived from (assetClass, contractVersion, structuralVariantKey,
   * underwritingMode). Asserted at runtime by the backend; consumers may
   * verify independently. Identical four-axis inputs → identical fingerprint,
   * irrespective of deal data.
   */
  structuralIdentity: StructuralIdentity;
  visibleTabs: string[];
  cellBindings: CellBindings;
  /**
   * Parallel to `cellBindings`. Every address present in cellBindings
   * MUST appear in cellStates. The state classifies how the workbook
   * should render the cell — 'concluded' (no fill), 'hitl' (gray fill +
   * comment), or 'awaiting_input' (red fill + comment).
   */
  cellStates: CellStateMap;
  /**
   * Sparse map: only `hitl` and `awaiting_input` cells emit comments.
   * 'concluded' cells never have an entry here. Comment.state MUST
   * agree with cellStates[address] for the same address.
   */
  cellComments: CellCommentMap;
  /**
   * Canonical, sorted list of every address declared by the schema for this
   * asset class. Equal to `Object.keys(cellBindings)` after backend runtime
   * validation. The workbook MUST verify it can resolve a Range for every
   * entry before writing — this is the closed-system contract.
   */
  schemaAddresses: string[];
  /**
   * Backend-declared managed-namespace policy. The workbook applies this
   * verbatim during reverse-direction validation. Workbook MUST NOT define
   * or extend this locally.
   */
  managedNamespace: ManagedNamespacePolicy;
  /**
   * Backend-declared tabular sections (e.g. cross-check drivers). The
   * workbook iterates layout + rows; it does not decide columns or layout.
   */
  tables: TablePayload[];
  conservatismStatus: RenderConservatismStatus;
  libraryBaselineMeta: RenderLibraryBaselineMeta;
  /**
   * Present iff the client supplied `clientContractVersion` < contractVersion.
   * Lists every migration step the workbook needs to catch up. Workbook MUST
   * surface these to the user before applying any structural action.
   */
  migrationsFromClient?: MigrationManifest;
  generatedAt: string;
}
