import { Router, Request, Response } from 'express';
import { uploadDualFiles, uploadAnalysisFiles } from '../middleware/upload.js';
import { store } from '../storage/sqlite-store.js';
import { parseDocument } from '../services/document-parser.service.js';
import { populateTemplate, createDefaultTemplate } from '../services/template-engine.service.js';
import {
  extractFindings, generateCreditScore,
  extractResearchEntities, generateMitigations,
  generateExecutiveSummary, generateBPieceDecision
} from '../services/ai-analysis.service.js';
import { runUnderwritingPipeline } from '../services/underwriting-pipeline.service.js';
import { searchSponsor, searchMarket, searchNews } from '../services/research.service.js';
import { runStressTests, DEFAULT_STRESS_SCENARIOS } from '../services/stress-test.service.js';
import { applyIntelligence, listLearnedRules } from '../services/uw-intelligence.service.js';
import {
  computeCompositeHash, recordCacheEntry, HashComponents
} from '../services/consistency-engine.service.js';
import { validateAnalysisOutputs } from '../services/validation.service.js';
import { recordAnalysisAudit, compareAnalysisVersions } from '../services/version-control.service.js';
import { recalculateFullModel } from '@cre/shared';
import { Analysis, AssetType, Comment, ResearchResults } from '@cre/shared';
import type { TemplateType } from '@cre/shared';
import {
  applyCreditPolicyBandsToAnalysis,
  applyBandsToUwModel,
  applyBandsToStressScenarios,
} from '../services/doctrine/apply-credit-policy-bands.js';
import { createRevision, type RevisionDelta } from '../services/revision-creator.service.js';
import {
  applyRevisionDelta,
  InvalidDeltaError,
  LineageCorruptionError,
  NotLatestRevisionError,
  ParentRevisionNotFoundError,
  type RevisionDelta as GraphRevisionDelta,
} from '../services/apply-revision-delta.js';
import { REVISION_TRIGGERS, type RevisionId, type RevisionTrigger } from '@cre/contracts';
import { requirePermission } from '../middleware/require-permission.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { v4 as uuid } from 'uuid';
import {
  dispatchByIdFormat,
  MalformedAnalysisIdError,
} from '../util/dispatch-by-id-format.js';
import { HydrationError } from '../services/hydrate-record-graph.js';
import { materializeRenderedAnalysisWithMeta } from '../services/materialize-rendered-analysis.js';
import { recordGraphStore, RecordGraphStore } from '../storage/record-graph-store.js';
import type { HandbookEvaluationReadStore } from '../storage/record-graph-store.js';
// Batch 1B — rent-roll resolver imports
import { parseRentRollXlsx } from '../services/parse-rent-roll-xlsx.js';
import { extractRentRollFromDocument } from '../services/extract-rent-roll-from-document.js';
import type { RentRoll, PropertyMetadata } from '@cre/contracts';
// Batch 1H — property-metadata extractor (AI-tier)
import { extractPropertyMetadata } from '../services/extract-property-metadata.js';
// Coverage / measurement tool — analyzer for the populated workbook's per-tab cell coverage.
import { computeWorkbookCoverage } from '../services/compute-workbook-coverage.js';

export const analysisRoutes = Router();

// POST /api/analyses — Upload and start analysis
analysisRoutes.post('/', uploadAnalysisFiles as any, async (req: Request, res: Response) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const asrFile = files['asr']?.[0];
    const sellerUwFile = files['seller_uw']?.[0] || files['uw']?.[0];
    const supportingDocFiles = files['supporting_docs'] || [];
    const templateFile = files['template']?.[0];
    const rentRollFile = files['rent_roll']?.[0];
    const assetType = req.body.assetType as AssetType;
    const templateType = req.body.templateType as TemplateType | undefined;
    const name = req.body.name || asrFile?.originalname || 'Untitled Analysis';

    if (!asrFile) {
      res.status(400).json({ error: 'ASR document is required' });
      return;
    }
    if (!assetType) {
      res.status(400).json({ error: 'Asset type is required' });
      return;
    }

    // Credit Manifesto required check
    if (!store.hasActiveManifesto()) {
      res.status(400).json({
        error: 'Credit Manifesto required. Upload a credit manifesto in Underwriting Insights before running analyses.',
        code: 'MANIFESTO_REQUIRED',
      });
      return;
    }

    // Resolve template: use stored global template if templateType is specified
    let resolvedTemplateBuffer = templateFile?.buffer;
    let resolvedTemplateName = templateFile?.originalname;
    let resolvedTemplateMime = templateFile?.mimetype;

    if (!templateFile && templateType && ['single_loan', 'roll_up'].includes(templateType)) {
      const storedTemplate = store.getActiveTemplate(templateType);
      if (storedTemplate) {
        resolvedTemplateBuffer = storedTemplate.fileData;
        resolvedTemplateName = storedTemplate.fileName;
        resolvedTemplateMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
    }

    // --- Consistency Engine: check cache ---
    const cacheResult = computeCompositeHash(
      asrFile.buffer,
      assetType,
      sellerUwFile?.buffer,
      supportingDocFiles.map(f => ({ buffer: f.buffer, name: f.originalname })),
      resolvedTemplateBuffer,
    );

    if (cacheResult.hit && cacheResult.analysisId) {
      const cachedAnalysis = store.getAnalysis(cacheResult.analysisId);
      if (cachedAnalysis && cachedAnalysis.status === 'complete') {
        res.status(200).json({
          id: cachedAnalysis.id,
          status: cachedAnalysis.status,
          name: cachedAnalysis.name,
          assetType: cachedAnalysis.assetType,
          createdAt: cachedAnalysis.createdAt,
          cached: true,
          inputHash: cacheResult.inputHash,
        });
        return;
      }
    }

    const id = uuid();
    const now = new Date().toISOString();

    // Create initial analysis record
    const analysis: Analysis = {
      id,
      name,
      assetType,
      status: 'parsing',
      progress: 0,
      currentStep: 'Parsing document...',
      createdAt: now,
      updatedAt: now,
      document: null,
      uwDocument: null,
      supportingDocuments: [],
      templateDocument: null,
      findings: [],
      creditScore: null,
      uwModel: null,
      research: null,
      crossCheckFindings: [],
      mitigations: [],
      executiveSummary: null,
      bPieceDecision: null,
      comments: [],
      criteriaEvaluations: [],
      stressScenarios: [],
      inputHash: cacheResult.inputHash,
      manifestoVersion: cacheResult.components.manifestoVersion,
      modelLogicVersion: cacheResult.components.modelLogicVersion,
    };

    store.createAnalysis(analysis);

    // Persist original uploads for later download
    store.saveOriginalUpload(uuid(), id, 'asr', asrFile.originalname, asrFile.mimetype, asrFile.buffer);
    if (sellerUwFile) {
      store.saveOriginalUpload(uuid(), id, 'seller_uw', sellerUwFile.originalname, sellerUwFile.mimetype, sellerUwFile.buffer);
    }
    // Batch 1A — persist the rent-roll upload (if present). Parsing into a
    // RentRoll record happens in the background pipeline; this just ensures
    // the file is stored for download and re-parse. Pipeline wiring of the
    // parsed RentRoll into uwModel is deferred to Batch 1B.
    if (rentRollFile) {
      store.saveOriginalUpload(uuid(), id, 'rent_roll', rentRollFile.originalname, rentRollFile.mimetype, rentRollFile.buffer);
    }

    // Return immediately, process async
    res.status(201).json({
      id,
      status: 'parsing',
      name,
      assetType,
      createdAt: now,
      inputHash: cacheResult.inputHash,
    });

    // Run analysis pipeline in background
    runAnalysisPipeline(
      id,
      asrFile.buffer, asrFile.originalname, asrFile.mimetype,
      assetType,
      sellerUwFile?.buffer, sellerUwFile?.originalname, sellerUwFile?.mimetype,
      supportingDocFiles.map((f) => ({ buffer: f.buffer, name: f.originalname, mime: f.mimetype })),
      resolvedTemplateBuffer, resolvedTemplateName, resolvedTemplateMime,
      { inputHash: cacheResult.inputHash, components: cacheResult.components },
      // Batch 1B — pass the rent_roll buffer separately so the pipeline can
      // resolve it via the precedence chain: file > ASR table > Seller UW exhibit.
      rentRollFile?.buffer,
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// GET /api/analyses — List all
analysisRoutes.get('/', (_req: Request, res: Response) => {
  const analyses = store.listAnalyses();
  res.json({ analyses });
});

// GET /api/analyses/compare — Compare two analysis versions (must be before /:id)
analysisRoutes.get('/compare', (req: Request, res: Response) => {
  const baseId = req.query.base as string;
  const compareId = req.query.compare as string;

  if (!baseId || !compareId) {
    res.status(400).json({ error: 'Both base and compare query parameters are required' });
    return;
  }

  const comparison = compareAnalysisVersions(baseId, compareId);
  if (!comparison) {
    res.status(404).json({ error: 'One or both analyses not found' });
    return;
  }

  res.json({ comparison });
});

// GET /api/analyses/audit-log — Get full audit history (must be before /:id)
analysisRoutes.get('/audit-log', (req: Request, res: Response) => {
  const assetType = req.query.assetType as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  const entries = store.getAuditLog({ assetType, limit });
  res.json({ entries });
});

// GET /api/analyses/model-versions — Get model logic version history (must be before /:id)
analysisRoutes.get('/model-versions', (_req: Request, res: Response) => {
  const versions = store.listModelLogicVersions();
  res.json({ versions });
});

// GET /api/analyses/:id — Full detail.
//
// Per revision-lineage spec §7: resolves the LATEST revision in the lineage by default.
// `?revisionId=...` query param overrides to a specific historical node (must be in the
// same lineage as `:id`). v1 graph branch resolves latest only; historical lookups
// (?revisionId) are deferred to issue #21.
//
// Strict-dispatch (Batch 6.8 + option C / #20): classifies `:id` by format.
//   - UUID v4   -> legacy (existing revision-lineage lookup in sqlite-store)
//   - 64-hex    -> graph branch. The `:id` is the `lineageRootId` (= AnalysisId per
//                   spec §1 and the 8.3 contract migration). Resolved through
//                   `getLatestRevisionByLineageRoot` to the latest envelope's
//                   `doctrineEvaluationId`; then materialized via the same
//                   `hydrate -> project -> render` pipeline as before.
//
// Graph branch response shape on 200:
//   { ...RenderedAnalysis fields...,
//     lineageRootId: RevisionId,    // NEW (8.7): public AnalysisId, echoes URL :id
//     revisionOrdinal: number,      // NEW (8.7): 0 for root, monotonic per revision
//   }
//
// Note: `rendered.rootId` remains a `DoctrineEvaluationId` (the internal anchor for
// the workflow / audit / committee stores). Frontend consumers should use
// `body.lineageRootId` for URL routing and `body.rootId` for those scoped lookups,
// until issue #23 unifies them under a single lineage-scoped axis.
analysisRoutes.get('/:id', (req: Request, res: Response) => {
  let format: 'legacy' | 'graph';
  try {
    format = dispatchByIdFormat(req.params.id);
  } catch (e) {
    if (e instanceof MalformedAnalysisIdError) {
      res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
      return;
    }
    throw e;
  }

  if (format === 'graph') {
    handleGraphRead(req, res, recordGraphStore);
    return;
  }

  // Legacy path (uuid v4): existing revision-lineage lookup.
  const anchor = store.getAnalysis(req.params.id);
  if (!anchor) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }

  const explicitRevisionId = req.query.revisionId;
  let analysis: typeof anchor | null = null;

  if (typeof explicitRevisionId === 'string') {
    // §7: deterministic historical node. Verify cross-lineage isolation —
    // `revisionId` MUST be in the same lineage as `:id`.
    const target = store.getAnalysis(explicitRevisionId);
    const anchorRoot = anchor.lineageRootId ?? anchor.id;
    const targetRoot = target?.lineageRootId ?? target?.id;
    if (!target || targetRoot !== anchorRoot) {
      res.status(404).json({ error: 'Revision not found in this analysis lineage' });
      return;
    }
    analysis = target;
  } else {
    // §7 default: latest revision in lineage.
    analysis = store.getLatestRevisionInLineage(req.params.id);
  }

  if (!analysis) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({ analysis: applyCreditPolicyBandsToAnalysis(analysis) });
});

// GET /api/analyses/:id/handbook-evaluation — Sibling endpoint for the handbook
// engine output (#31 Commit 3). Returns null when no evaluation exists.
analysisRoutes.get('/:id/handbook-evaluation', (req: Request, res: Response) => {
  handleHandbookEvaluationRead(req, res, recordGraphStore);
});

// GET /api/analyses/:id/status — Polling endpoint
analysisRoutes.get('/:id/status', (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({
    id: analysis.id,
    status: analysis.status,
    progress: analysis.progress,
    currentStep: analysis.currentStep,
    error: analysis.error,
  });
});

// DELETE /api/analyses/:id
analysisRoutes.delete('/:id', (req: Request, res: Response) => {
  const deleted = store.deleteAnalysis(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({ success: true });
});

// Batch 6.3 — PATCH /:id/uw-model and PATCH /:id/loan-terms have been HARD-REMOVED per
// architecture decision D4 (revisions, not patches) and the user's pre-6.3 directive.
// In-place mutation semantics are forbidden on record-bearing endpoints. Edits now flow
// through `POST /:id/revisions` which creates a new immutable analysis row pointing at
// its parent via `parentAnalysisId`. The web client must use the revisions endpoint
// (no PATCH compat shim — Option A per user approval).

// POST /api/analyses/:id/revisions — Create a new revision of an analysis.
//
// Strict-dispatch entry per option C / issue #20 (step 8.6). Classifies the `:id` format and
// routes to the appropriate spine:
//   - UUID v4    → legacy branch (createRevision on legacy Analysis row, sqlite-store).
//   - 64-hex     → graph branch (applyRevisionDelta on new-spine lineage).
//
// `requirePermission('analysis:revise')` gates BOTH branches. Held by ANALYST, CREDIT_OFFICER,
// ADMIN — not COMMITTEE_MEMBER (separation of duties). VIEWER and unauthenticated callers
// are rejected by the middleware (403 / 401).
//
// Body shape depends on the branch:
//   - Legacy: { type: 'uw-model-cells', updates: [{ path, value }] }
//             { type: 'loan-terms',     updates: { ... } }
//   - Graph:  { delta: { kind: 'adjusted-input-overrides', overrides: [{ path, value }] },
//               triggerSource?: RevisionTrigger,
//               adjustmentOrigin?: string[] }
//
// Response shape on 201 (graph branch):
//   { rootId: RevisionId,           // lineageRootId — echoes URL :id
//     revisionId: RevisionId,       // the new child revisionId
//     evaluationId: DoctrineEvaluationId,
//     revisionOrdinal: number,      // for "Revision N of M" UI
//     inputDiff: AdjustedInputsDiff // already computed by the service; surfaced for the UI
//   }
analysisRoutes.post(
  '/:id/revisions',
  requirePermission('analysis:revise'),
  (req: Request, res: Response) => {
    let format: 'legacy' | 'graph';
    try {
      format = dispatchByIdFormat(req.params.id);
    } catch (e) {
      if (e instanceof MalformedAnalysisIdError) {
        res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
        return;
      }
      throw e;
    }
    if (format === 'graph') {
      handleGraphRevision(req, res, recordGraphStore);
      return;
    }
    handleLegacyRevision(req, res);
  },
);

function handleLegacyRevision(req: Request, res: Response): void {
  const parent = store.getAnalysis(req.params.id);
  if (!parent || !parent.uwModel) {
    res.status(404).json({ error: 'Parent analysis or UW model not found' });
    return;
  }

  const body = req.body as RevisionDelta | undefined;
  if (!body || (body.type !== 'uw-model-cells' && body.type !== 'loan-terms')) {
    res.status(400).json({
      error:
        "delta must be { type: 'uw-model-cells', updates: [{path, value}] } " +
        "or { type: 'loan-terms', updates: {...} }",
    });
    return;
  }

  let revision;
  try {
    revision = createRevision({ parent, delta: body });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'Failed to create revision' });
    return;
  }

  store.createAnalysis(revision);
  const decorated = applyCreditPolicyBandsToAnalysis(revision);
  res.status(201).json({ analysis: decorated });
}

/**
 * GET /:id graph branch handler. Exported for direct invocation by route tests
 * with an in-memory store. The production route closure passes the `recordGraphStore`
 * singleton.
 *
 * URL `:id` is the `lineageRootId`. Resolves the latest envelope in the lineage,
 * materializes from its `doctrineEvaluationId`, and attaches `lineageRootId` +
 * `revisionOrdinal` to the response so the client has both the public AnalysisId
 * (for routing) and the internal evaluation anchor (for workflow / audit / committee
 * lookups, until issue #23 unifies them).
 */
export function handleGraphRead(
  req: Request,
  res: Response,
  graphStore: RecordGraphStore,
): void {
  const lineageRootId = req.params.id as RevisionId;
  const envelope = graphStore.getLatestRevisionByLineageRoot(lineageRootId);
  if (envelope === null) {
    res.status(404).json({
      error: 'ANALYSIS_NOT_FOUND',
      message: `No revision lineage found with root ${req.params.id}`,
      lineageRootId: req.params.id,
    });
    return;
  }
  try {
    const meta = materializeRenderedAnalysisWithMeta(envelope.doctrineEvaluationId, graphStore);
    res.locals.observability = {
      cacheHit: meta.cacheHit,
      renderVersion: meta.rendered.metadata.renderVersion,
    };
    res.status(200).json({
      ...meta.rendered,
      lineageRootId,
      revisionOrdinal: envelope.revisionOrdinal,
    });
  } catch (e) {
    if (e instanceof HydrationError) {
      res.status(404).json({ error: e.code, message: e.message, ...e.context });
      return;
    }
    const err = e as Error;
    res.status(400).json({ error: err?.name ?? 'GET_ANALYSIS_ERROR', message: err?.message });
  }
}

/**
 * Route handler: GET /api/analyses/:id/handbook-evaluation (#31 Commit 3).
 *
 * Returns the latest HandbookEvaluation for the analysis identified by :id
 * (treated as a RevisionId lineageRootId, same as handleGraphRead).
 *
 * Response shape:
 *   200 + HandbookEvaluation  — eval exists for the latest revision
 *   200 + null                — analysis exists but no eval yet (pre-Commit-2
 *                                deals or eval not produced)
 *   404                        — analysis not found
 *
 * Design choice: 200+null vs 404 for "no eval" case. The analysis exists, but
 * the handbook eval doesn't. We choose 200+null rather than 404 because the
 * "no eval yet" case is normal data state, not an error. 404 typically signals
 * "wrong URL"; the client wraps the fetch in try/catch and silences errors
 * anyway (matching the workflow/timeline precedent), so either path leads to
 * the same UI — but 200+null is semantically truthful.
 */
export function handleHandbookEvaluationRead(
  req: Request,
  res: Response,
  graphStore: HandbookEvaluationReadStore,
): void {
  const lineageRootId = req.params.id as RevisionId;

  // Resolve the lineageRootId to the latest revision envelope. Same pattern
  // as handleGraphRead — content-hash root → latest envelope on that lineage.
  const envelope = graphStore.getLatestRevisionByLineageRoot(lineageRootId);
  if (envelope === null) {
    res.status(404).json({
      error: 'ANALYSIS_NOT_FOUND',
      message: `No revision lineage found with root ${req.params.id}`,
      lineageRootId: req.params.id,
    });
    return;
  }

  // May legitimately be null — analyses produced before #31 Commit 2 don't
  // have a HandbookEvaluation. The null is the truthful "no eval" signal.
  const evaluation = graphStore.getLatestHandbookEvaluationForAdjustedInputs(
    envelope.adjustedInputsId,
  );

  res.status(200).json(evaluation);
}

/** Exported for direct invocation by route tests with an in-memory store. The production
 *  route closure passes the `recordGraphStore` singleton. */
export function handleGraphRevision(
  req: Request,
  res: Response,
  graphStore: RecordGraphStore,
): void {
  // Thin top-level body shape validation. Per-override validation (path whitelist, value type,
  // engine-mirrored vacancy+concessions) is the service's job; surfaces as InvalidDeltaError.
  const body = req.body as
    | {
        delta?: { kind?: string; overrides?: unknown };
        triggerSource?: string;
        adjustmentOrigin?: unknown;
      }
    | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'INVALID_BODY', message: 'request body must be a JSON object' });
    return;
  }
  if (!body.delta || typeof body.delta !== 'object') {
    res.status(400).json({ error: 'INVALID_BODY', message: 'body.delta is required' });
    return;
  }
  if (body.delta.kind !== 'adjusted-input-overrides' || !Array.isArray(body.delta.overrides)) {
    res.status(400).json({
      error: 'INVALID_BODY',
      message: "body.delta must be { kind: 'adjusted-input-overrides', overrides: [...] }",
    });
    return;
  }
  const triggerSource: RevisionTrigger =
    body.triggerSource !== undefined && (REVISION_TRIGGERS as readonly string[]).indexOf(body.triggerSource) >= 0
      ? (body.triggerSource as RevisionTrigger)
      : 'USER_EDIT';
  const adjustmentOrigin: readonly string[] = Array.isArray(body.adjustmentOrigin)
    ? (body.adjustmentOrigin.filter((s) => typeof s === 'string') as string[])
    : [];

  // URL :id is the lineageRootId (AnalysisId per spec §1 + 8.3 contract migration).
  // Resolve the current latest revision in this lineage and pass it as parentRevisionId.
  // Linear-chain v1 rule means this is the only valid parent; the client never specifies
  // it explicitly (and the service's linear-chain guard cannot fire from this entry point
  // since we always pass the latest).
  const rootId = req.params.id as RevisionId;
  const latest = graphStore.getLatestRevisionByLineageRoot(rootId);
  if (latest === null) {
    res.status(404).json({
      error: 'PARENT_REVISION_NOT_FOUND',
      message: `No revision lineage found with root ${req.params.id}`,
      parentRevisionId: req.params.id,
    });
    return;
  }

  const delta: GraphRevisionDelta = {
    kind: 'adjusted-input-overrides',
    overrides: body.delta.overrides as ReadonlyArray<{ path: string; value: number }>,
  };

  try {
    const result = applyRevisionDelta(
      {
        parentRevisionId: latest.revisionId,
        delta,
        triggerSource,
        adjustmentOrigin,
      },
      graphStore,
    );
    res.status(201).json({
      rootId,
      revisionId: result.envelope.revisionId,
      evaluationId: result.evaluation.id,
      revisionOrdinal: result.envelope.revisionOrdinal,
      inputDiff: result.provenance.inputDiff,
    });
  } catch (e) {
    if (e instanceof ParentRevisionNotFoundError) {
      res.status(404).json({
        error: 'PARENT_REVISION_NOT_FOUND',
        message: e.message,
        parentRevisionId: e.parentRevisionId,
      });
      return;
    }
    if (e instanceof NotLatestRevisionError) {
      res.status(409).json({
        error: 'NOT_LATEST_REVISION',
        message: e.message,
        currentLatestRevisionId: e.currentLatestRevisionId,
      });
      return;
    }
    if (e instanceof InvalidDeltaError) {
      res.status(400).json({
        error: 'INVALID_DELTA',
        code: e.code,
        path: e.path,
        message: e.message,
        ...(e.detail ? { detail: e.detail } : {}),
      });
      return;
    }
    if (e instanceof LineageCorruptionError) {
      res.status(500).json({ error: 'LINEAGE_CORRUPTION', message: e.message });
      return;
    }
    if (e instanceof RecordIdMismatchError) {
      res.status(500).json({ error: 'RECORD_ID_MISMATCH', message: e.message });
      return;
    }
    throw e;
  }
}

// GET /api/analyses/:id/lineage — Return the full lineage chain for this analysis.
//
// Append-only view: every revision sharing the same `lineageRootId`, ordered by
// `revisionOrdinal` ascending. Used by the web client to display revision history.
analysisRoutes.get('/:id/lineage', (req: Request, res: Response) => {
  // 404 if the analysis doesn't exist.
  const head = store.getAnalysis(req.params.id);
  if (!head) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  const lineage = store.listLineage(req.params.id);
  res.json({ lineage });
});

// POST /api/analyses/:id/stress-test
analysisRoutes.post('/:id/stress-test', (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis || !analysis.uwModel) {
    res.status(404).json({ error: 'Analysis or UW model not found' });
    return;
  }

  const { scenarios } = req.body;
  const inputs = scenarios || DEFAULT_STRESS_SCENARIOS;
  const results = runStressTests(analysis.uwModel, inputs);

  store.updateAnalysis(req.params.id, { stressScenarios: results });
  res.json({ results: applyBandsToStressScenarios(results) });
});

// Comment routes nested under analysis
analysisRoutes.get('/:id/comments', (req: Request, res: Response) => {
  const comments = store.getComments(req.params.id);
  const bySectionId: Record<string, Comment[]> = {};
  for (const c of comments) {
    if (!bySectionId[c.sectionId]) bySectionId[c.sectionId] = [];
    bySectionId[c.sectionId].push(c);
  }
  res.json({ comments, bySectionId });
});

analysisRoutes.post('/:id/comments', (req: Request, res: Response) => {
  const { sectionId, findingId, stance, text } = req.body;
  if (!sectionId || !stance || !text) {
    res.status(400).json({ error: 'sectionId, stance, and text are required' });
    return;
  }

  const now = new Date().toISOString();
  const comment: Comment = {
    id: uuid(),
    analysisId: req.params.id,
    sectionId,
    findingId,
    stance,
    text,
    author: 'Analyst',
    createdAt: now,
    updatedAt: now,
  };

  const result = store.addComment(req.params.id, comment);
  if (!result) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.status(201).json({ comment: result });
});

analysisRoutes.put('/:id/comments/:commentId', (req: Request, res: Response) => {
  const result = store.updateComment(req.params.id, req.params.commentId, req.body);
  if (!result) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ comment: result });
});

analysisRoutes.delete('/:id/comments/:commentId', (req: Request, res: Response) => {
  const deleted = store.deleteComment(req.params.id, req.params.commentId);
  if (!deleted) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json({ success: true });
});

// GET /api/analyses/:id/populated-template — Download populated underwriting template
analysisRoutes.get('/:id/populated-template', (req: Request, res: Response) => {
  const populated = store.getPopulatedTemplate(req.params.id);
  if (!populated) {
    res.status(404).json({ error: 'No populated template available for this analysis.' });
    return;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${populated.fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(populated.fileData);
});

// GET /api/analyses/:id/populated-template/info — Get mapping info without downloading file
analysisRoutes.get('/:id/populated-template/info', async (req: Request, res: Response) => {
  const populated = store.getPopulatedTemplate(req.params.id);
  if (!populated) {
    res.status(404).json({ available: false });
    return;
  }

  // Include a coverage report alongside the existing mappedFields/unmappedFields/
  // tabsPopulated trio so a single call gives clients both the populator's
  // ledger AND the workbook's actual cell-level coverage.
  let coverage = null;
  try {
    coverage = await computeWorkbookCoverage(populated.fileData);
  } catch (err) {
    console.warn('[populated-template/info] coverage analysis failed:', err);
  }

  res.json({
    available: true,
    fileName: populated.fileName,
    mappedFields: JSON.parse(populated.mappedFields),
    unmappedFields: JSON.parse(populated.unmappedFields),
    tabsPopulated: JSON.parse(populated.tabsPopulated),
    coverage,
  });
});

// GET /api/analyses/:id/populated-template/coverage — Just the coverage report
analysisRoutes.get('/:id/populated-template/coverage', async (req: Request, res: Response) => {
  const populated = store.getPopulatedTemplate(req.params.id);
  if (!populated) {
    res.status(404).json({ available: false });
    return;
  }
  try {
    const coverage = await computeWorkbookCoverage(populated.fileData);
    res.json({ available: true, fileName: populated.fileName, coverage });
  } catch (err: unknown) {
    res.status(500).json({ available: false, error: (err as Error).message });
  }
});

// GET /api/analyses/:id/audit — Get version audit log for this analysis
analysisRoutes.get('/:id/audit', (req: Request, res: Response) => {
  const entries = store.getAuditLogByAnalysis(req.params.id);
  res.json({ entries });
});

// --- Background pipeline ---
async function runAnalysisPipeline(
  id: string,
  asrBuffer: Buffer,
  asrFileName: string,
  asrMimeType: string,
  assetType: AssetType,
  uwBuffer?: Buffer,
  uwFileName?: string,
  uwMimeType?: string,
  supportingDocs: { buffer: Buffer; name: string; mime: string }[] = [],
  templateBuffer?: Buffer,
  templateFileName?: string,
  templateMimeType?: string,
  cacheContext?: { inputHash: string; components: HashComponents },
  // Batch 1B — optional dedicated rent-roll xlsx upload. When present, takes
  // precedence over ASR-table or Seller-UW-exhibit AI extraction.
  rentRollBuffer?: Buffer,
) {
  try {
    // Step 1a: Parse ASR document
    store.updateAnalysis(id, { status: 'parsing', progress: 5, currentStep: 'Parsing ASR document...' });
    const document = await parseDocument(asrBuffer, asrFileName, asrMimeType);
    store.updateAnalysis(id, { document, progress: 10, currentStep: 'ASR document parsed' });

    // Step 1b: Parse seller underwriting document (if provided)
    let uwDocument = null;
    if (uwBuffer && uwFileName && uwMimeType) {
      store.updateAnalysis(id, { progress: 12, currentStep: 'Parsing seller underwriting...' });
      uwDocument = await parseDocument(uwBuffer, uwFileName, uwMimeType);
      store.updateAnalysis(id, { uwDocument, progress: 15, currentStep: 'Seller underwriting parsed' });
    }

    // Step 1c: Parse supporting documents (rent rolls, leases, PSAs, etc.)
    if (supportingDocs.length > 0) {
      store.updateAnalysis(id, { progress: 16, currentStep: `Parsing ${supportingDocs.length} supporting document(s)...` });
      const parsedSupporting = [];
      for (const doc of supportingDocs) {
        try {
          const parsed = await parseDocument(doc.buffer, doc.name, doc.mime);
          parsedSupporting.push({ fileName: doc.name, fileType: doc.mime, parsed });
        } catch (err) {
          console.warn(`Failed to parse supporting doc ${doc.name}:`, err);
          parsedSupporting.push({ fileName: doc.name, fileType: doc.mime, parsed: null });
        }
      }
      store.updateAnalysis(id, { supportingDocuments: parsedSupporting, progress: 17, currentStep: `${parsedSupporting.length} supporting document(s) parsed` });
    }

    // Step 1d: Parse underwriting template (if provided)
    if (templateBuffer && templateFileName && templateMimeType) {
      store.updateAnalysis(id, { progress: 18, currentStep: 'Parsing underwriting template...' });
      const templateDocument = await parseDocument(templateBuffer, templateFileName, templateMimeType);
      store.updateAnalysis(id, { templateDocument, progress: 19, currentStep: 'Underwriting template parsed' });
    }

    // ===== UNDERWRITING PIPELINE (single deterministic path) =====
    // ASR → JSON extraction → validation → credit engine → cross-check.
    // No step can be skipped or bypassed. Hard-stops on missing required fields.
    store.updateAnalysis(id, { progress: 20, currentStep: 'Running underwriting pipeline...' });
    const criteriaForPipeline = store.getCriteria(assetType);
    const pipeline = await runUnderwritingPipeline(
      document,
      uwDocument,
      assetType,
      criteriaForPipeline,
      {
        onStep: (s, m) => {
          console.log(`[Pipeline:${s}] ${m}`);
        },
      },
    );

    // Persist whatever each step produced before deciding pass/fail
    store.updateAnalysis(id, {
      sellerMetrics: pipeline.sellerMetrics,
      extractionResult: pipeline.extractionResult,
      preValidationGate: pipeline.preValidationGate,
    });

    if (pipeline.status === 'FAILED') {
      throw new Error(pipeline.error || 'Underwriting pipeline failed');
    }

    const sellerMetrics = pipeline.sellerMetrics;
    const extractionResult = pipeline.extractionResult!;
    let crossCheckFindings: any[] = pipeline.crossCheckFindings;

    // Log low-confidence fields as warnings (pipeline already passed gates)
    for (const lcField of extractionResult.lowConfidenceFields) {
      const f = extractionResult.fields[lcField];
      console.warn(`[Pipeline] LOW CONFIDENCE — ${lcField}: ${f.value} from "${f.originalLabel}" at ${f.sourceLocation}. Flagged for review.`);
    }

    store.updateAnalysis(id, { progress: 26, currentStep: 'Pipeline extraction + validation complete' });

    // Step 3: External research (non-fatal)
    let research: ResearchResults | null = null;
    try {
      store.updateAnalysis(id, { progress: 28, currentStep: 'Researching sponsor and market...' });
      const entities = await extractResearchEntities(document);
      const [sponsorRes, marketRes, newsRes] = await Promise.all([
        entities.sponsorName ? searchSponsor(entities.sponsorName) : Promise.resolve({ results: [] }),
        entities.propertyAddress && entities.city ? searchMarket(entities.propertyAddress, entities.city) : Promise.resolve({ results: [] }),
        entities.propertyName || entities.sponsorName ? searchNews(entities.propertyName || '', entities.sponsorName || '') : Promise.resolve({ results: [] }),
      ]);
      research = {
        sponsor: sponsorRes.results || [],
        market: marketRes.results || [],
        news: newsRes.results || [],
      };
      store.updateAnalysis(id, { research, progress: 35, currentStep: 'External research complete' });
    } catch (err) {
      console.warn('Research step failed (non-fatal):', err);
      store.updateAnalysis(id, { progress: 35, currentStep: 'Research skipped' });
    }

    // Step 4: Extract findings (non-fatal — partial results still allow pipeline to continue)
    store.updateAnalysis(id, { status: 'analyzing', progress: 38, currentStep: 'Extracting credit findings...' });
    const criteria = store.getCriteria(assetType);
    let findings: any[] = [];
    let criteriaEvaluations: any[] = [];
    try {
      const result = await extractFindings(
        document,
        assetType,
        criteria!,
        { uwDocument, crossCheckFindings, research }
      );
      findings = result.findings;
      criteriaEvaluations = result.criteriaEvaluations;
      store.updateAnalysis(id, { findings, criteriaEvaluations, progress: 50, currentStep: `${findings.length} findings extracted` });
    } catch (err) {
      console.warn('Findings extraction failed (non-fatal):', err);
      // Ensure all criteria rules still get evaluation entries
      criteriaEvaluations = (criteria?.rules || []).map((rule: any) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        result: 'unknown',
        reason: 'Not evaluated — AI extraction encountered an error',
        source: undefined,
      }));
      store.updateAnalysis(id, { findings: [], criteriaEvaluations, progress: 50, currentStep: 'Findings extraction encountered an error — continuing with remaining steps' });
    }

    // Step 5: UW model — produced by the pipeline credit-engine step.
    // No second extraction; the pipeline output is the single source of truth.
    const uwModel = pipeline.uwModel!;
    store.updateAnalysis(id, { uwModel, progress: 60, currentStep: 'Underwriting model built (pipeline)' });

    // Batch 1B — Rent-roll resolution. Sibling step to the underwriting pipeline.
    // Source-of-truth precedence: dedicated xlsx file > ASR table extraction >
    // Seller UW exhibit extraction > null + missing-support flag. Each step is
    // independent; failures in one fall through to the next.
    const issues: string[] = [...(pipeline.derivationIssues ?? [])];
    let rentRoll: RentRoll | null = null;
    if (rentRollBuffer) {
      try {
        rentRoll = await parseRentRollXlsx(rentRollBuffer);
      } catch (err) {
        console.warn('[RentRoll] xlsx parse failed, will try AI fallback:', err);
        issues.push('rent-roll: xlsx parser failed (' + (err as Error).message + ')');
      }
    }
    if (rentRoll === null) {
      try {
        rentRoll = await extractRentRollFromDocument(document, 'asr_table');
      } catch (err) {
        console.warn('[RentRoll] ASR AI extraction failed:', err);
      }
    }
    if (rentRoll === null && uwDocument !== null) {
      try {
        rentRoll = await extractRentRollFromDocument(uwDocument, 'seller_uw_exhibit');
      } catch (err) {
        console.warn('[RentRoll] Seller-UW AI extraction failed:', err);
      }
    }
    if (rentRoll === null) {
      issues.push('missing-support: rent-roll');
    }
    store.updateAnalysis(id, {
      rentRoll,
      derivationIssues: issues,
      progress: 60,
      currentStep: rentRoll ? 'Rent roll resolved (' + rentRoll.source + ', ' + rentRoll.lines.length + ' tenants)' : 'Rent roll unresolved',
    });

    // Batch 1H — Property metadata extraction. Sibling step to rent-roll
    // resolution. ASR-only source today; AI extractor returns null when no
    // property facts are found (logged via missing-support).
    let propertyMetadata: PropertyMetadata | null = null;
    try {
      propertyMetadata = await extractPropertyMetadata(document, 'asr_extraction');
    } catch (err) {
      console.warn('[PropertyMetadata] extraction failed:', err);
    }
    if (propertyMetadata === null) {
      issues.push('missing-support: property-metadata');
    }
    store.updateAnalysis(id, {
      propertyMetadata,
      derivationIssues: issues,
      progress: 60,
      currentStep: propertyMetadata
        ? 'Property metadata extracted (' + (propertyMetadata.propertyName ?? 'unnamed') + ')'
        : 'Property metadata unresolved',
    });

    // Step 5a: Populate underwriting template (use default if none provided)
    if (uwModel) {
      try {
        store.updateAnalysis(id, { progress: 60, currentStep: 'Populating underwriting template...' });

        // Fall back to a generated default template when the user didn't select one
        const effectiveTemplateBuffer = templateBuffer || await createDefaultTemplate();
        // Batch 1A/1B/1H — pass per-source extractions, rent-roll, and
        // property-metadata so the populator can fill multi-period columns,
        // tenant rows, and the property header / detail tabs. All optional;
        // absence falls back gracefully.
        const result = await populateTemplate(effectiveTemplateBuffer, uwModel, {
          periodSources: {
            mostRecent: pipeline.uwModelFromAsr ?? null,
            issuerUw:   pipeline.uwModelFromSeller ?? null,
          },
          rentRoll,
          propertyMetadata,
        });

        // Store the populated template for download
        const populatedFileName = templateBuffer && templateFileName
          ? `Populated_${templateFileName}`
          : 'Populated_Underwriting.xlsx';

        store.savePopulatedTemplate(
          uuid(),
          id,
          populatedFileName,
          result.populatedBuffer,
          JSON.stringify(result.mappedFields),
          JSON.stringify(result.unmappedFields),
          JSON.stringify(result.tabsPopulated),
        );

        store.updateAnalysis(id, {
          progress: 61,
          currentStep: `Template populated: ${result.mappedFields.length} fields mapped across ${result.tabsPopulated.length} tabs`,
        });
      } catch (err) {
        console.warn('Template population failed (non-fatal):', err);
        store.updateAnalysis(id, { progress: 61, currentStep: 'Template population skipped (mapping error)' });
      }
    }

    // Step 5b: Apply underwriting intelligence (learned rules from historical deals)
    const approvedRules = listLearnedRules(assetType).filter((r) => r.status === 'approved');
    if (approvedRules.length > 0 && uwModel) {
      store.updateAnalysis(id, { progress: 61, currentStep: 'Applying underwriting intelligence...' });
      try {
        const intelligence = applyIntelligence(assetType, {
          noi: uwModel.netOperatingIncome,
          capRate: uwModel.capRate,
          // null = metric not computable. Convert to undefined at the boundary
          // so applyIntelligence treats it as "not provided" (no rule applied),
          // never as 0 (which would trigger false rule matches).
          ltv: uwModel.ltv ?? undefined,
          dscr: uwModel.dscr ?? undefined,
        });

        // Add intelligence-driven red flags as findings
        for (const rf of intelligence.redFlags) {
          findings.push({
            id: uuid(),
            category: 'cash_flow',
            severity: rf.severity,
            title: `[Historical Pattern] ${rf.flag}`,
            explanation: rf.basis,
            confidence: 'medium',
            pageReferences: [],
            impact: { description: rf.basis },
          });
        }

        store.updateAnalysis(id, {
          findings,
          progress: 62,
          currentStep: `Applied ${approvedRules.length} learned rules`,
        });
      } catch (err) {
        console.warn('UW Intelligence application failed (non-fatal):', err);
      }
    }

    // Step 5c: Cross-check — produced by the pipeline. Persist its results.
    store.updateAnalysis(id, {
      crossCheckFindings,
      overallAdjustmentBias: pipeline.overallAdjustmentBias ?? undefined,
      progress: 63,
      currentStep: `Cross-check complete: ${crossCheckFindings.length} comparisons, bias: ${pipeline.overallAdjustmentBias ?? 'n/a'}`,
    });

    // Step 6: Generate mitigations for critical/high findings
    let mitigations: any[] = [];
    const critHighCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    if (critHighCount > 0) {
      store.updateAnalysis(id, { progress: 62, currentStep: 'Generating mitigation strategies...' });
      mitigations = await generateMitigations(assetType, findings, uwModel, crossCheckFindings);
      store.updateAnalysis(id, { mitigations, progress: 70, currentStep: `Generated ${mitigations.length} mitigation strategies` });
    }

    // Step 7: Run default stress tests
    store.updateAnalysis(id, { progress: 72, currentStep: 'Running stress tests...' });
    const stressScenarios = runStressTests(uwModel, DEFAULT_STRESS_SCENARIOS);
    store.updateAnalysis(id, { stressScenarios, progress: 78, currentStep: 'Stress tests complete' });

    // Step 8: Generate credit score — with score protection
    // If any required metric is missing from the UW model, DO NOT calculate score
    const requiredMetricsForScoring = [
      { name: 'NOI', value: uwModel.netOperatingIncome },
      { name: 'Loan Amount', value: uwModel.loanAmount },
      { name: 'Cap Rate', value: uwModel.capRate },
      { name: 'Interest Rate', value: uwModel.interestRate },
    ];
    const missingForScoring = requiredMetricsForScoring.filter(
      m => !m.value || m.value === 0 || isNaN(m.value)
    );

    let creditScore: import('@cre/shared').CreditScore | null = null;
    if (missingForScoring.length > 0) {
      console.warn(`[Pipeline] SCORE PROTECTION: Blocking scoring — missing metrics: ${missingForScoring.map(m => m.name).join(', ')}`);
      store.updateAnalysis(id, {
        progress: 85,
        currentStep: `Score blocked — missing required metrics: ${missingForScoring.map(m => m.name).join(', ')}`,
      });
    } else {
      store.updateAnalysis(id, { progress: 78, currentStep: 'Generating credit score...' });
      creditScore = await generateCreditScore(
        assetType,
        findings,
        uwModel,
        criteriaEvaluations,
        criteria!.scoringWeights
      );
      store.updateAnalysis(id, { creditScore, progress: 85, currentStep: 'Credit score generated' });
    }

    // Step 9: Generate executive summary
    store.updateAnalysis(id, { progress: 87, currentStep: 'Writing executive summary...' });
    const executiveSummary = await generateExecutiveSummary(
      assetType,
      findings,
      uwModel,
      crossCheckFindings.length,
      research !== null,
      stressScenarios
    );
    store.updateAnalysis(id, { executiveSummary, progress: 92, currentStep: 'Executive summary complete' });

    // Step 10: Generate B-piece decision (requires credit score)
    let bPieceDecision: import('@cre/shared').BPieceDecision | null = null;
    if (creditScore) {
      store.updateAnalysis(id, { progress: 93, currentStep: 'Rendering final B-piece decision...' });
      bPieceDecision = await generateBPieceDecision(
        assetType,
        findings,
        uwModel,
        mitigations,
        stressScenarios,
        creditScore,
        crossCheckFindings
      );
      store.updateAnalysis(id, { bPieceDecision, progress: 98, currentStep: 'B-piece decision rendered' });
    } else {
      console.warn('[Pipeline] Skipping B-piece decision — credit score was not generated (score protection active)');
      store.updateAnalysis(id, { progress: 98, currentStep: 'B-piece decision skipped — score protection blocked scoring' });
    }

    // Step 11: Validation Layer — mandatory before completion
    store.updateAnalysis(id, { progress: 99, currentStep: 'Running validation checks...' });

    const validationResult = validateAnalysisOutputs({
      assetType,
      uwModel,
      findings,
      criteriaEvaluations,
      creditScore,
      bPieceDecision,
      scoringWeights: criteria!.scoringWeights,
      extractionResult,
    });

    store.updateAnalysis(id, { validationResult });

    if (!validationResult.passed) {
      // Diagnostic dump: print the actual model state alongside the validation
      // error so we can debug live failures. The same dump is appended to the
      // thrown error so it surfaces in the failed-analysis response too.
      const dump = uwModel === null ? '{ uwModel: null }' : JSON.stringify({
        loanAmount: uwModel.loanAmount,
        interestRate: uwModel.interestRate,
        interestRate_loanDetails: uwModel.loanDetails?.interestRate,
        amortizationYears: uwModel.amortizationYears,
        amortizationMonths_loanDetails: uwModel.loanDetails?.amortizationMonths,
        termYears: uwModel.termYears,
        netOperatingIncome: uwModel.netOperatingIncome,
        capRate: uwModel.capRate,
        impliedValue: uwModel.impliedValue,
        annualDebtService: uwModel.annualDebtService,
        dscr: uwModel.dscr,
        ltv: uwModel.ltv,
        debtYield: uwModel.debtYield,
      });
      console.error('[Validation] FAILED. uwModel state:', dump);
      const errorSummary = validationResult.errors
        .map(e => `[${e.category}] ${e.name}: ${e.details}`)
        .join('; ');
      throw new Error(`Validation failed: ${errorSummary} | model=${dump}`);
    }

    // Complete — only reached if all validation checks pass
    store.updateAnalysis(id, {
      status: 'complete',
      progress: 100,
      currentStep: 'Analysis complete',
    });

    // Write version audit log
    const completedAnalysis = store.getAnalysis(id);
    if (completedAnalysis) {
      recordAnalysisAudit(completedAnalysis);
    }

    // Record in consistency cache (output is now locked for this input hash)
    if (cacheContext) {
      recordCacheEntry(cacheContext.inputHash, id, cacheContext.components);
    }
  } catch (error: any) {
    console.error('Analysis pipeline error:', error);
    store.updateAnalysis(id, {
      status: 'error',
      error: error.message || 'Analysis pipeline failed',
      currentStep: 'Error: ' + (error.message || 'Unknown error'),
    });
  }
}

// Nested property access helpers extracted to apps/api/src/util/object-path.ts in Batch 6.3
// (previously inline here). Used by the revision-creator service.
