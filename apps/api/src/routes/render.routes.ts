/**
 * Render routes — exposes already-completed analyses as a flat payload the
 * Excel workbook can iterate. Read-only. No underwriting computation.
 *
 * The route is the ONLY place permitted to know about both Analysis and
 * RenderInput; it composes a RenderInput and hands it to the pure render
 * service. It is also the only place permitted to resolve
 * structuralVariantKey — either by accepting the explicit query param OR by
 * calling resolveStructuralVariant(). No other source, no fallback.
 */
import { Router, Request, Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import {
  buildRenderPayload,
  getAssetClassVariantModeTabs,
  getManagedNamespace,
  RenderSchemaError,
} from '../services/render.service.js';
import {
  getModesForVariant,
  getSchemaAddresses,
  getSchemaSourcesByAddress,
  getVariantsForAssetClass,
} from '../services/render-schema.js';
import {
  assertUnderwritingModeRegistered,
  assertVariantRegistered,
  resolveStructuralVariant,
} from '../services/resolve-structural-variant.js';
import {
  getAllMigrations,
  getMigrationManifest,
} from '../services/render-migrations.js';
import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
import { hydrateUnderwritingContext } from '../services/hydrate-underwriting-context.js';
import {
  buildObservabilityEvent,
  emitObservabilityEvent,
  persistObservabilityEvent,
} from '../services/underwriting-observability.service.js';
import {
  computeReadiness,
  readObservabilityWindow,
} from '../services/migration-readiness.service.js';
import {
  applyRenderPayloadToTemplate,
  assertTemplateCanSatisfySchema,
  TemplateIntegrityError,
  validateTemplateCompatibility,
} from '../services/template-engine.service.js';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  Analysis,
  AssetType,
  MigrationManifest,
  RenderConservatismStatus,
  RenderInput,
  RenderLibraryBaselineMeta,
  RenderPayload,
  StructuralVariantKey,
  TemplateType,
  UnderwritingMode,
} from '@cre/shared';

export const renderRoutes = Router();

const VALID_ASSET_TYPES: AssetType[] = [
  'office', 'multifamily', 'retail', 'industrial',
  'hotel', 'self_storage', 'mixed_use', 'manufactured_housing',
];

function buildConservatismStatus(analysis: Analysis): RenderConservatismStatus {
  const findings = analysis.crossCheckFindings ?? [];
  const flags = findings
    .filter((f) => f.severity === 'high' || f.severity === 'critical')
    .map((f) => `${f.metric} [${f.flag}]`);
  const approved = analysis.overallAdjustmentBias === 'conservative' && flags.length === 0;
  return { approved, flags };
}

const VALID_UNDERWRITING_MODES: UnderwritingMode[] = ['single_loan', 'roll_up'];

function buildLibraryBaselineMeta(analysis: Analysis): RenderLibraryBaselineMeta {
  // TODO(library): wire to getLibraryBaselines() once exposed for completed
  // analyses. Architecture contract §4 requires baseline distributions, not
  // point values — keep null sentinels so Excel renders "—" rather than
  // fabricating numbers.
  return {
    assetType: analysis.assetType,
    sampleSize: null,
    vacancyMedian: null,
    expenseRatioMedian: null,
    capRateMedian: null,
    degraded: false,
  };
}

/**
 * GET /api/underwriting/render?dealId=...&assetClass=...&structuralVariantKey=...
 *
 * Returns a RenderPayload — flat cell-bindings, visible tabs, drivers.
 * The workbook iterates and writes; it never computes.
 *
 * `structuralVariantKey` resolution (memory/architecture_render_versioning.md):
 *   - If the query param is provided, it MUST be registered for the asset
 *     class; otherwise hard 400.
 *   - If absent, resolveStructuralVariant() is called. Any failure is hard.
 *   - There is NO implicit default variant.
 */
function parseClientVersion(req: Request): number | null {
  const raw = req.query.clientContractVersion;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

interface PayloadResolution {
  status: 'ok';
  payload: RenderPayload;
  analysis: Analysis;
  assetClass: AssetType;
  structuralVariantKey: StructuralVariantKey;
  underwritingMode: UnderwritingMode;
}
interface PayloadFailure {
  status: 'error';
  httpStatus: number;
  body: Record<string, unknown>;
}
type PayloadResult = PayloadResolution | PayloadFailure;

interface ComposeOptions {
  requireUwModel?: boolean;
  /**
   * Contract version to render against. Defaults to RENDER_CONTRACT_VERSION
   * (the /render contract). /export passes the active template's
   * compatibleContractVersion so the payload matches the artifact the
   * template registry pinned the export to.
   */
  contractVersion?: number;
}

/**
 * Compose a RenderPayload for a deal using identical resolution rules for
 * /render and /export. Both endpoints MUST share this — there is one render
 * pipeline, never a parallel one.
 */
function composeRenderPayloadFromQuery(
  req: Request,
  opts: ComposeOptions = {},
): PayloadResult {
  const requireUwModel = opts.requireUwModel ?? true;
  const targetContractVersion = opts.contractVersion ?? RENDER_CONTRACT_VERSION;
  const dealId = String(req.query.dealId ?? '').trim();
  const assetClassRaw = req.query.assetClass ? String(req.query.assetClass).trim() : '';
  const variantKeyRaw = req.query.structuralVariantKey
    ? String(req.query.structuralVariantKey).trim()
    : '';
  const underwritingModeRaw = req.query.underwritingMode
    ? String(req.query.underwritingMode).trim()
    : '';
  const clientVersion = parseClientVersion(req);

  if (!dealId) {
    return { status: 'error', httpStatus: 400, body: { error: 'dealId is required' } };
  }
  if (!assetClassRaw) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: 'assetClass is required', code: 'ASSET_CLASS_REQUIRED' },
    };
  }
  if (!VALID_ASSET_TYPES.includes(assetClassRaw as AssetType)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: `Unknown assetClass: ${assetClassRaw}` },
    };
  }
  if (!underwritingModeRaw) {
    return {
      status: 'error',
      httpStatus: 400,
      body: {
        error: 'underwritingMode is required (no implicit default)',
        code: 'UNDERWRITING_MODE_REQUIRED',
        validUnderwritingModes: VALID_UNDERWRITING_MODES,
      },
    };
  }
  if (!VALID_UNDERWRITING_MODES.includes(underwritingModeRaw as UnderwritingMode)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: {
        error: `Unknown underwritingMode: ${underwritingModeRaw}`,
        code: 'UNDERWRITING_MODE_UNKNOWN',
        validUnderwritingModes: VALID_UNDERWRITING_MODES,
      },
    };
  }
  if (clientVersion !== null && Number.isNaN(clientVersion)) {
    return {
      status: 'error',
      httpStatus: 400,
      body: { error: 'clientContractVersion must be a positive integer' },
    };
  }
  if (clientVersion !== null && clientVersion > RENDER_CONTRACT_VERSION) {
    return {
      status: 'error',
      httpStatus: 409,
      body: {
        error: 'Workbook is newer than backend.',
        code: 'CLIENT_AHEAD_OF_BACKEND',
        clientContractVersion: clientVersion,
        backendContractVersion: RENDER_CONTRACT_VERSION,
      },
    };
  }

  const analysis = store.getAnalysis(dealId);
  if (!analysis) {
    return {
      status: 'error',
      httpStatus: 404,
      body: { error: `No analysis found for dealId=${dealId}` },
    };
  }
  if (requireUwModel && !analysis.uwModel) {
    return {
      status: 'error',
      httpStatus: 409,
      body: {
        error: 'Analysis has not produced an underwriting model yet.',
        status: analysis.status,
        currentStep: analysis.currentStep,
      },
    };
  }

  const adjustedInputs = adaptAnalysisToAdjustedInputs(analysis);
  if (!adjustedInputs) {
    return {
      status: 'error',
      httpStatus: 409,
      body: { error: 'Could not adapt analysis to AdjustedInputs.' },
    };
  }

  const assetClass = assetClassRaw as AssetType;
  const underwritingMode = underwritingModeRaw as UnderwritingMode;

  let structuralVariantKey: StructuralVariantKey;
  try {
    if (variantKeyRaw) {
      const k = variantKeyRaw as StructuralVariantKey;
      assertVariantRegistered(assetClass, k, targetContractVersion);
      structuralVariantKey = k;
    } else {
      structuralVariantKey = resolveStructuralVariant(
        assetClass,
        adjustedInputs,
        {},
        targetContractVersion,
      );
    }
    assertUnderwritingModeRegistered(
      assetClass,
      structuralVariantKey,
      underwritingMode,
      targetContractVersion,
    );
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      return {
        status: 'error',
        httpStatus: 400,
        body: { error: err.message, code: err.code, details: err.details },
      };
    }
    throw err;
  }

  const renderInput: RenderInput = {
    meta: {
      dealId: analysis.id,
      dealName: analysis.name,
      generatedAt: new Date().toISOString(),
    },
    assetClass,
    structuralVariantKey,
    underwritingMode,
    adjustedInputs,
    underwritingContext: hydrateUnderwritingContext({
      analysis,
      adjustedInputs,
      mode: underwritingMode,
    }),
    drivers: analysis.crossCheckFindings ?? [],
    conservatismStatus: buildConservatismStatus(analysis),
    libraryBaselineMeta: buildLibraryBaselineMeta(analysis),
  };

  let payload: RenderPayload;
  try {
    payload = buildRenderPayload(renderInput, {
      contractVersion: targetContractVersion,
      onProjected: ({ resolvedContext, cellBindings, payload: built }) => {
        // Best-effort observability. Wrapped in try/catch by render.service.ts;
        // any throw here is also caught by the surrounding code path. NEVER
        // mutates inputs. NEVER blocks the export.
        try {
          const event = buildObservabilityEvent({
            analysisId: analysis.id,
            analysis,
            adjustedInputs,
            resolvedContext,
            cellBindings,
            contractVersion: built.contractVersion,
            assetClass: built.assetClass,
            variantKey: built.structuralVariantKey,
            mode: built.underwritingMode,
            generatedAt: built.generatedAt,
          });
          if (event) {
            emitObservabilityEvent(event);
            persistObservabilityEvent(store.rawDb(), event);
          }
        } catch (err) {
          console.error('[observability] route hook error (swallowed):', (err as Error)?.message);
        }
      },
    });
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      return {
        status: 'error',
        httpStatus: 500,
        body: { error: err.message, code: err.code, details: err.details },
      };
    }
    throw err;
  }
  if (clientVersion !== null && clientVersion < payload.contractVersion) {
    payload.migrationsFromClient = getMigrationManifest(clientVersion, payload.contractVersion);
  }

  return { status: 'ok', payload, analysis, assetClass, structuralVariantKey, underwritingMode };
}

renderRoutes.get('/render', (req: Request, res: Response) => {
  const result = composeRenderPayloadFromQuery(req);
  if (result.status === 'error') {
    res.status(result.httpStatus).json(result.body);
    return;
  }
  res.json(result.payload);
});

/**
 * GET /api/underwriting/export
 *   ?dealId=...&assetClass=...&structuralVariantKey=...
 *   &profile=bank|bp_spire&templateType=single_loan|roll_up
 *
 * The single, canonical Excel export pipeline. Both the "Bank Underwriter"
 * and "BP Spire Underwriter" buttons MUST converge here; they differ only in
 * the `profile` (input configuration) and the resulting filename. There is
 * NO separate render or analysis path for BP Spire — it is the same system
 * with different input configuration.
 *
 * Mandatory pipeline (memory/architecture_render_versioning.md):
 *   1. resolveRenderPayload()              — composeRenderPayloadFromQuery
 *   2. loadActiveTemplate(templateType)    — store.getActiveTemplate
 *   3. validateTemplateCompatibility()     — code-declared envelope check
 *   4. assertTemplateCanSatisfySchema()    — workbook ↔ schema binding check
 *   5. applyRenderPayloadToTemplate()      — write values, hide tabs, tables
 *   6. stream .xlsx
 *
 * Failures at steps 3 or 4 abort the export with HTTP 409. There is no
 * partial rendering, no fallback template selection, and no auto-patching
 * of missing sheets / ranges / tables.
 */
const VALID_PROFILES = ['bank', 'bp_spire'] as const;
type ExportProfile = (typeof VALID_PROFILES)[number];
const VALID_TEMPLATE_TYPES: TemplateType[] = ['single_loan', 'roll_up'];

renderRoutes.get('/export', async (req: Request, res: Response) => {
  const profileRaw = req.query.profile ? String(req.query.profile).trim() : '';
  if (!profileRaw || !VALID_PROFILES.includes(profileRaw as ExportProfile)) {
    res.status(400).json({
      error: `profile is required and must be one of: ${VALID_PROFILES.join(', ')}`,
      code: 'EXPORT_PROFILE_REQUIRED',
    });
    return;
  }
  const profile = profileRaw as ExportProfile;

  const templateTypeRaw = req.query.templateType
    ? String(req.query.templateType).trim()
    : 'single_loan';
  if (!VALID_TEMPLATE_TYPES.includes(templateTypeRaw as TemplateType)) {
    res.status(400).json({
      error: `Unknown templateType: ${templateTypeRaw}`,
      code: 'TEMPLATE_TYPE_UNKNOWN',
    });
    return;
  }
  const templateType = templateTypeRaw as TemplateType;

  // Step 1 — load active template artifact. Pulled before payload composition
  // so we can render at the template's compatibleContractVersion. The
  // template registry is the SINGLE compatibility source — schema slice for
  // that version is the only thing the payload pipeline reads.
  const template = store.getActiveTemplate(templateType);
  if (!template) {
    res.status(409).json({
      error: `No active underwriting template of type "${templateType}". Upload one in Underwriting Insights → Templates before exporting.`,
      code: 'TEMPLATE_NOT_FOUND',
    });
    return;
  }
  if (!template.templateMetadata) {
    res.status(409).json({
      error: `Active ${templateType} template (v${template.version}) is not registered in the template registry. Refusing to export — register the artifact in template-registry.ts before use.`,
      code: 'TEMPLATE_NOT_REGISTERED',
      details: {
        templateType,
        templateVersion: template.version,
        templateId: template.id,
      },
    });
    return;
  }

  // Step 2 — resolve RenderPayload at the template's contract version.
  const result = composeRenderPayloadFromQuery(req, {
    contractVersion: template.templateMetadata.compatibleContractVersion,
  });
  if (result.status === 'error') {
    res.status(result.httpStatus).json(result.body);
    return;
  }

  // Step 3 — code-declared compatibility envelope (BLOCKING).
  try {
    validateTemplateCompatibility(template.templateMetadata, result.payload);
  } catch (err) {
    if (err instanceof TemplateIntegrityError) {
      res.status(409).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  // Step 4 — workbook ↔ schema binding (BLOCKING). Verifies every schema
  // address resolves to a real Excel target and every visible tab / table
  // sheet exists in the artifact. Pure read; no mutations.
  try {
    await assertTemplateCanSatisfySchema(template.fileData, result.payload);
  } catch (err) {
    if (err instanceof TemplateIntegrityError) {
      res.status(409).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  // Step 5 — apply the payload. Pre-validated; failures here are unexpected.
  let applied;
  try {
    applied = await applyRenderPayloadToTemplate(template.fileData, result.payload);
  } catch (err: any) {
    res.status(500).json({
      error: err?.message || 'Failed to apply RenderPayload to template',
      code: 'EXPORT_RENDER_FAILED',
    });
    return;
  }

  // Step 6 — stream .xlsx.
  const safeName = result.analysis.name.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 60).trim() || 'Underwriting';
  const profileLabel = profile === 'bank' ? 'Bank' : 'BPSpire';
  const fileName = `${profileLabel}_UW_${safeName}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('X-Render-Contract-Version', String(result.payload.contractVersion));
  res.setHeader('X-Structural-Variant-Key', result.payload.structuralVariantKey);
  res.setHeader('X-Underwriting-Mode', result.payload.underwritingMode);
  res.setHeader('X-Export-Profile', profile);
  res.setHeader('X-Template-Type', templateType);
  res.setHeader('X-Template-Version', String(template.templateMetadata.templateVersion));
  res.setHeader('X-Render-Bindings-Written', String(applied.writtenAddresses.length));
  res.setHeader('X-Render-Bindings-Unresolved', String(applied.unresolvedAddresses.length));

  // Export-time observability log (per debug requirement §5). One line per
  // export. resolvedContextHits + adjustedInputsHits + emptyCellCount
  // computed from the final payload's cellBindings.
  try {
    const bindings = result.payload.cellBindings;
    let emptyCellCount = 0;
    for (const v of Object.values(bindings)) {
      if (v === null || v === '' || v === undefined) emptyCellCount++;
    }
    let resolvedContextHits = 0;
    let adjustedInputsHits = 0;
    for (const addr of Object.keys(bindings)) {
      const sources = getSchemaSourcesByAddress(
        result.payload.assetClass,
        result.payload.structuralVariantKey,
        result.payload.underwritingMode,
        result.payload.contractVersion,
      ).get(addr);
      const src = sources && sources.size ? [...sources][0] : null;
      if (src === 'resolvedContext') resolvedContextHits++;
      else if (src === 'adjustedInputs') adjustedInputsHits++;
    }
    process.stdout.write(JSON.stringify({
      kind: 'EXPORT_OBSERVABILITY',
      analysisId: result.analysis.id,
      contractVersion: result.payload.contractVersion,
      assetClass: result.payload.assetClass,
      mode: result.payload.underwritingMode,
      totalCells: Object.keys(bindings).length,
      resolvedContextHits,
      adjustedInputsHits,
      emptyCellCount,
    }) + '\n');
  } catch (err) {
    console.error('[export] observability log skipped:', (err as Error)?.message);
  }

  res.send(applied.populatedBuffer);
});

/**
 * GET /api/underwriting/render-config — static asset-class → variant → tabs
 * AND the canonical address set per (asset class, variant). Lets the workbook
 * hydrate its hidden _Config sheet AND run integrity validation on
 * Workbook_Open without needing a deal.
 */
renderRoutes.get('/render-config', (req: Request, res: Response) => {
  const clientVersion = parseClientVersion(req);
  if (clientVersion !== null && Number.isNaN(clientVersion)) {
    res.status(400).json({ error: 'clientContractVersion must be a positive integer' });
    return;
  }
  if (clientVersion !== null && clientVersion > RENDER_CONTRACT_VERSION) {
    res.status(409).json({
      error: 'Workbook is newer than backend.',
      code: 'CLIENT_AHEAD_OF_BACKEND',
      clientContractVersion: clientVersion,
      backendContractVersion: RENDER_CONTRACT_VERSION,
    });
    return;
  }

  const assetClassVariantModeTabs = getAssetClassVariantModeTabs();
  const variantsByAssetClass: Record<string, StructuralVariantKey[]> = {};
  // Deterministic per-asset-class default: the alphabetically-first registered
  // variant. Workbook reads this on assetClass change; it MUST NOT infer.
  const assetClassVariantDefaults: Record<string, StructuralVariantKey> = {};
  const modesByAssetClassVariant: Record<
    string,
    Record<string, UnderwritingMode[]>
  > = {};
  const addressesByAssetClassVariantMode: Record<
    string,
    Record<string, Record<string, string[]>>
  > = {};
  const managedNamespaceByAssetClassVariantMode: Record<
    string,
    Record<string, Record<string, ReturnType<typeof getManagedNamespace>>>
  > = {};
  for (const ac of Object.keys(assetClassVariantModeTabs) as AssetType[]) {
    const variantKeys = getVariantsForAssetClass(ac);
    variantsByAssetClass[ac] = variantKeys;
    assetClassVariantDefaults[ac] = variantKeys[0];
    modesByAssetClassVariant[ac] = {};
    addressesByAssetClassVariantMode[ac] = {};
    managedNamespaceByAssetClassVariantMode[ac] = {};
    for (const vk of variantKeys) {
      const modes = getModesForVariant(ac, vk);
      modesByAssetClassVariant[ac][vk] = modes;
      addressesByAssetClassVariantMode[ac][vk] = {};
      managedNamespaceByAssetClassVariantMode[ac][vk] = {};
      for (const mode of modes) {
        addressesByAssetClassVariantMode[ac][vk][mode] = getSchemaAddresses(ac, vk, mode);
        managedNamespaceByAssetClassVariantMode[ac][vk][mode] = getManagedNamespace(ac, vk, mode);
      }
    }
  }
  let migrationsFromClient: MigrationManifest | undefined;
  try {
    if (clientVersion !== null && clientVersion < RENDER_CONTRACT_VERSION) {
      migrationsFromClient = getMigrationManifest(clientVersion);
    }
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  res.json({
    contractVersion: RENDER_CONTRACT_VERSION,
    assetClassVariantModeTabs,
    variantsByAssetClass,
    assetClassVariantDefaults,
    modesByAssetClassVariant,
    addressesByAssetClassVariantMode,
    managedNamespaceByAssetClassVariantMode,
    migrationsFromClient,
  });
});

/**
 * GET /api/underwriting/render-migrations?fromVersion=N
 *
 * Returns the migration chain from `fromVersion` to current. Used by tools
 * and CI to verify deployed workbooks are compatible. If `fromVersion` is
 * omitted, returns the entire migration history.
 */
renderRoutes.get('/render-migrations', (req: Request, res: Response) => {
  const raw = req.query.fromVersion;
  if (raw === undefined || raw === '') {
    res.json({
      contractVersion: RENDER_CONTRACT_VERSION,
      all: getAllMigrations(),
    });
    return;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    res.status(400).json({ error: 'fromVersion must be a positive integer' });
    return;
  }
  try {
    res.json(getMigrationManifest(n));
  } catch (err) {
    if (err instanceof RenderSchemaError) {
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }
});

/**
 * GET /api/underwriting/migration-readiness?contractVersion=N&windowSize=M
 *
 * Field-by-field readiness verdict per the governance spec. Reads the last
 * `windowSize` events from underwriting_observability_log for the given
 * contractVersion and computes coverage / stability / fallback-pressure
 * against the per-group thresholds in field-migration-state.ts.
 *
 * Pure read. The response is the SOLE permitted basis for declaring a
 * state transition in FIELD_STATE_REGISTRY.
 */
renderRoutes.get('/migration-readiness', (req: Request, res: Response) => {
  const cvRaw = req.query.contractVersion;
  const cv = cvRaw === undefined || cvRaw === '' ? RENDER_CONTRACT_VERSION : Number(cvRaw);
  if (!Number.isInteger(cv) || cv < 1) {
    res.status(400).json({ error: 'contractVersion must be a positive integer' });
    return;
  }
  const winRaw = req.query.windowSize;
  const win = winRaw === undefined || winRaw === '' ? 200 : Number(winRaw);
  if (!Number.isInteger(win) || win < 1 || win > 10_000) {
    res.status(400).json({ error: 'windowSize must be an integer in [1, 10000]' });
    return;
  }
  try {
    const events = readObservabilityWindow(store.rawDb(), cv, win);
    const report = computeReadiness(events, cv);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message, code: 'MIGRATION_READINESS_FAILED' });
  }
});
