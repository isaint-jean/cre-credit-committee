/**
 * Render Service — Excel projection layer.
 *
 * Architecture: Excel is a renderer only (memory/architecture_excel_role.md).
 * This service consumes ONE input — `RenderInput` — and emits a `RenderPayload`
 * the workbook iterates verbatim.
 *
 * Hard rules:
 *   - This module has NO dependency on Analysis, the storage layer, or any
 *     pipeline-internal state. Its only inputs are types from @cre/shared.
 *   - It performs NO computation. cellBindings are produced by reading
 *     `adjustedInputs` only.
 *   - The set of cells, the managed-namespace policy, and the table layouts
 *     are ALL declared in `render-schema.ts` per (asset class, variant). The
 *     workbook is a derivative enforcement client and never declares schema
 *     rules locally.
 *   - structuralVariantKey is REQUIRED on the RenderInput — the route resolves
 *     it (explicit param OR resolveStructuralVariant). The service does not
 *     resolve, default, or fall back.
 */
import type {
  CellBindings,
  RenderInput,
  RenderPayload,
  ResolvedUnderwritingContext,
} from '@cre/shared';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import {
  assertProjectionMatchesSchema,
  assertStructuralIdentity,
  buildTables,
  getAssetClassVariantModeTabs,
  getManagedNamespace,
  getSchemaAddresses,
  getStructuralIdentity,
  getVisibleTabs,
  projectCellBindings,
  RenderSchemaError,
  type ProjectionInput,
} from './render-schema.js';
import {
  assertResolvedByResolver,
  resolveUnderwritingContext,
} from './resolve-underwriting-context.js';
import { assertNoProvenanceLeak } from './render-output-scrubber.js';

/**
 * Read-only observability hook. Invoked after the payload is fully validated
 * (projection matches schema, no provenance leak, structural identity OK).
 * The hook receives the resolvedContext, cellBindings, and final payload —
 * all THREE are passed by reference for inspection but the hook MUST NOT
 * mutate any of them.
 *
 * The render service swallows any error the hook throws — observability
 * failures cannot block the export. Callers wire this from the route where
 * Analysis context (for fallback detection / persistence) is available.
 */
export type ProjectionObserver = (ctx: {
  resolvedContext: ResolvedUnderwritingContext;
  cellBindings: CellBindings;
  payload: RenderPayload;
}) => void;

export interface BuildRenderPayloadOptions {
  /**
   * Contract version to render against. Defaults to the current
   * RENDER_CONTRACT_VERSION; export against an older template artifact passes
   * the template's compatibleContractVersion so the schema slice for THAT
   * version is used. Schema-by-version is the only registered compatibility
   * source — there is no second registry.
   */
  contractVersion?: number;
  /**
   * Optional, best-effort instrumentation hook. Called after every
   * structural invariant has passed and the payload is final. Errors from
   * the hook are caught and logged — the export proceeds regardless.
   */
  onProjected?: ProjectionObserver;
}

export function buildRenderPayload(
  input: RenderInput,
  opts: BuildRenderPayloadOptions = {},
): RenderPayload {
  const contractVersion = opts.contractVersion ?? RENDER_CONTRACT_VERSION;
  const { assetClass, structuralVariantKey, underwritingMode } = input;
  if (input.underwritingContext.underwritingMode !== underwritingMode) {
    throw new RenderSchemaError(
      'UNDERWRITING_MODE_DISAGREEMENT',
      `RenderInput.underwritingMode=${underwritingMode} does not match underwritingContext.underwritingMode=${input.underwritingContext.underwritingMode}.`,
      { topLevel: underwritingMode, context: input.underwritingContext.underwritingMode },
    );
  }
  if (underwritingMode === 'roll_up' && !input.underwritingContext.rollUpAggregation) {
    throw new RenderSchemaError(
      'ROLLUP_CONTEXT_MISSING',
      `underwritingMode=roll_up requires underwritingContext.rollUpAggregation; got null.`,
      { underwritingMode },
    );
  }
  if (underwritingMode === 'single_loan' && input.underwritingContext.rollUpAggregation) {
    throw new RenderSchemaError(
      'ROLLUP_CONTEXT_FORBIDDEN',
      `underwritingMode=single_loan must NOT carry underwritingContext.rollUpAggregation; got non-null.`,
      { underwritingMode },
    );
  }
  // Pre-render projection layer: resolve nulls / lists / mode-specific
  // roll-up into a flat CellValue surface. Schema selectors read this
  // verbatim — no branching in the schema layer.
  const resolvedContext = resolveUnderwritingContext(input.underwritingContext, underwritingMode);
  // Identity-brand check (resolver guardrail #4). Rejects any context not
  // produced by resolveUnderwritingContext() — hand-rolled or
  // alternately-sourced objects fail at the schema boundary.
  assertResolvedByResolver(resolvedContext);
  const projectionInput: ProjectionInput = { ...input, resolvedContext };

  const cellBindings = projectCellBindings(projectionInput, contractVersion);
  // Closed-system invariant — throws RenderSchemaError on any drift.
  assertProjectionMatchesSchema(assetClass, structuralVariantKey, underwritingMode, cellBindings, contractVersion);
  // Provenance guard: hard-fail if any cell value carries filesystem paths
  // (Z:\, /Users/, /Volumes/, …) or known ingestion markers (AFSBR, etc.).
  // No silent stripping — a leak indicates a producer bug that must be
  // fixed upstream (route, resolver, judgment engine, or extractor).
  assertNoProvenanceLeak(cellBindings);

  const payload: RenderPayload = {
    contractVersion,
    dealId: input.meta.dealId,
    assetClass,
    structuralVariantKey,
    underwritingMode,
    structuralIdentity: getStructuralIdentity(assetClass, structuralVariantKey, underwritingMode, contractVersion),
    visibleTabs: getVisibleTabs(assetClass, structuralVariantKey, underwritingMode, contractVersion),
    cellBindings,
    schemaAddresses: getSchemaAddresses(assetClass, structuralVariantKey, underwritingMode, contractVersion),
    managedNamespace: getManagedNamespace(assetClass, structuralVariantKey, underwritingMode, contractVersion),
    tables: buildTables(input, contractVersion),
    conservatismStatus: input.conservatismStatus,
    libraryBaselineMeta: input.libraryBaselineMeta,
    generatedAt: input.meta.generatedAt,
  };

  // Deterministic-replayability gate. Hard-fails if visibleTabs,
  // schemaAddresses, managedNamespace, or table layouts diverge from the
  // canonical snapshot for the four-axis tuple (assetClass, contractVersion,
  // structuralVariantKey, underwritingMode).
  // See memory/architecture_render_versioning.md.
  assertStructuralIdentity(payload);

  // Best-effort instrumentation hook. Runs AFTER every validation gate has
  // passed; the payload is final at this point. Hook errors are caught
  // and logged — observability cannot block the export.
  if (opts.onProjected) {
    try {
      opts.onProjected({ resolvedContext, cellBindings, payload });
    } catch (err) {
      console.error('[render.service] onProjected hook error (swallowed):', (err as Error)?.message);
    }
  }

  return payload;
}

export {
  getAssetClassVariantModeTabs,
  getManagedNamespace,
  RenderSchemaError,
};
