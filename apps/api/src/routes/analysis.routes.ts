import { Router, Request, Response } from 'express';
import { uploadDualFiles, uploadAnalysisFiles, upload } from '../middleware/upload.js';
import { enforceAnalysisParam, filterAccessibleAnalyses, enforceDealForRoot, canAccessAnalysis } from '../middleware/deal-access.js';
import { projectPca, projectRentRoll, RENT_ROLL_PAGE_SIZE } from '../services/slot-extraction.service.js';
import { store } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { appendSourceDocToDeal } from '../services/append-source-doc.service.js';
import { IngestionError } from '../services/ingest-extraction-result.js';
import type { SourceDocSlot } from '@cre/shared';
import type { MarketBenchmarksId, CreditManifestoId } from '@cre/contracts';
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
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
import { renderMemoForAnalysis } from '../services/render-memo/render-memo-for-analysis.js';
import { resolveAnalysisForRead } from '../services/resolve-analysis-for-read.js';
import { buildBuyerDiffCrossCheck, projectBuyerDiff } from '../services/buyer-diff.service.js';
import { renderBuyerDiffHtml } from '../services/render-buyer-diff-html.js';
import {
  buildBuyerDiffSuggestions, mergeDecisions, decidableFindingIds, type BuyerDiffDecision,
} from '../services/buyer-diff-suggestions.service.js';
import { generateBuyerDiffWorkbook } from '../services/generate-buyer-diff-workbook.service.js';
import { resolveLoanForRoot } from '../services/pool/resolve-loan-for-root.js';
import { augmentIntakeCompletenessWithSourcing } from '../services/augment-intake-completeness.js';
import { getAssumedInputs } from '../services/assumed-inputs.service.js';
import {
  applyRevisionDelta,
  InvalidDeltaError,
  LineageCorruptionError,
  NotLatestRevisionError,
  ParentRevisionNotFoundError,
  type RevisionDelta as GraphRevisionDelta,
} from '../services/apply-revision-delta.js';
import { REVISION_TRIGGERS, type RevisionId, type RevisionTrigger, type AssetType as ContractsAssetType, type RevisionLineageEnvelope } from '@cre/contracts';
import { isSponsorFactorRating, type HumanSponsorAssessment } from '@cre/contracts';
import { requirePermission } from '../middleware/require-permission.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { DataIntegrityHardHaltError } from '../services/evaluate-from-adjusted-inputs.js';
import { SynthesizeUwModelTieOutError } from '../services/synthesize-uw-model-from-graph.js';
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
// P3b — field-level intake completeness (ADVISORY read-only meta-layer; never
// blocks export). Sibling to document-completeness; the read route below is its
// only surface.
import { computeIntakeCompleteness } from '../services/intake-completeness.service.js';
import { env } from '../config/env.js';
import type { RevisionId as GraphRevisionIdType } from '@cre/contracts';

export const analysisRoutes = Router();

// Chunk 3b (dark): gate EVERY /:id/* analysis route by DEAL access — resolves the id
// (uuid OR 64-hex lineageRoot) to its lineageRootId, then checks the grant. Covers
// buyer-diff, memo, intake-completeness, handbook-evaluation, status, decisions,
// revisions, archive/restore/delete, export. The list GET / is filtered per-row
// below; lookup/compare/audit-log + Spine-B rootId handlers gate in-handler. NO-OP
// when the flag is off.
analysisRoutes.param('id', enforceAnalysisParam);

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
analysisRoutes.get('/', (req: Request, res: Response) => {
  // Soft-archive: hide archived deals by default; ?includeArchived=true retrieves them.
  const includeArchived = req.query['includeArchived'] === 'true';
  // Chunk 3b (dark): per-ROW filter to the deals the user may see (never a blanket
  // 403 on the list). Pass-through when the flag is off / for admin.
  const analyses = filterAccessibleAnalyses(req, store.listAnalyses(includeArchived), (a) => a.lineageRootId);
  res.json({ analyses });
});

// GET /api/analyses/lookup?dealRef=X — Funnel PR. Answers "does an analysis exist for this
// dealRef, and what's its status?" The pool rail's loan rows use this to branch between
// "New analysis" and "Open underwriting" without attempting a full GET that would 400 on a
// non-id-shaped string.
//
// MUST be declared BEFORE /:id (line 378) — Express resolves routes in declaration order.
// Even though dispatchByIdFormat would 400 on the string 'lookup' (it matches neither
// uuid-v4 nor 64-hex), letting /:id intercept first would still return 400 instead of
// reaching this handler. Putting /lookup first is the safer guarantee.
//
// Response:
//   { found: true, analysisId, status, workflowState, multipleFound?, count? }
//   { found: false }
//   400 POOL_BAD_REQUEST when ?dealRef is missing/empty
//
// Multiplicity: dealRef is not unique in `extraction_results` — a re-extraction of the same
// underlying loan creates a second row. We return the MOST RECENT (ORDER BY created_at DESC
// in the store), set `multipleFound: true` and `count` when > 1. Caller is the rail UI; its
// link only needs one analysisId.
//
// Id preference: legacyId (uuid) if present; else graphId (lineage_root_id, 64-hex). The
// existing GET /:id dispatcher accepts either format, so either link works.
//
// workflowState: null in this PR. The DealWorkflowState projection is keyed on doctrine
// rootId; wiring it through is a small follow-up that doesn't change the response shape
// (the field is already in the contract).
analysisRoutes.get('/lookup', (req: Request, res: Response) => {
  const dealRef = req.query['dealRef'];
  if (typeof dealRef !== 'string' || dealRef.length === 0) {
    res.status(400).json({
      error: 'POOL_BAD_REQUEST',
      message: 'dealRef query parameter required',
    });
    return;
  }
  const matches = store.lookupAnalysisByDealRef(dealRef);
  if (matches.length === 0) {
    res.json({ found: false });
    return;
  }
  const head = matches[0]!;
  // Chunk 3b (dark): resolve-then-check — if the resolved deal isn't accessible,
  // answer as if it doesn't exist (no existence leak). Pass-through when flag off.
  const u = req.user!;
  if (!canAccessAnalysis(u.userId, u.role, head.graphId ?? head.legacyId)) {
    res.json({ found: false });
    return;
  }
  res.json({
    found: true,
    // Converge phase i — prefer the graph id (lineage_root_id, present for every
    // analysis with a graph spine, which is every analysis post-6.8) so pool
    // "Open underwriting" links land on RenderedAnalysisView. GET /:id still accepts
    // either format (dispatch-by-id-format); this only flips the default entry point
    // away from the legacy uuid / DealRoom. Falls back to legacyId only if a row has
    // no graphId (none today, but the branch stays honest).
    analysisId: head.graphId ?? head.legacyId,
    status: head.status,
    workflowState: null,
    ...(matches.length > 1 ? { multipleFound: true, count: matches.length } : {}),
  });
});

// GET /api/analyses/compare — Compare two analysis versions (must be before /:id)
analysisRoutes.get('/compare', (req: Request, res: Response) => {
  const baseId = req.query.base as string;
  const compareId = req.query.compare as string;

  if (!baseId || !compareId) {
    res.status(400).json({ error: 'Both base and compare query parameters are required' });
    return;
  }

  // Chunk 3b (dark): access-check BOTH ids; if either is inaccessible, answer with
  // the SAME 404 as not-found (never leak that an inaccessible deal exists).
  const cu = req.user!;
  if (!canAccessAnalysis(cu.userId, cu.role, baseId) || !canAccessAnalysis(cu.userId, cu.role, compareId)) {
    res.status(404).json({ error: 'One or both analyses not found' });
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
  // Chunk 3b (dark): per-ROW filter to the user's accessible deals (canAccessAnalysis
  // is a pass-through when the flag is off / for admin).
  const u = req.user!;
  const entries = store.getAuditLog({ assetType, limit }).filter((e) => canAccessAnalysis(u.userId, u.role, e.analysisId));
  res.json({ entries });
});

// GET /api/analyses/model-versions — Get model logic version history (must be before /:id)
analysisRoutes.get('/model-versions', (_req: Request, res: Response) => {
  const versions = store.listModelLogicVersions();
  res.json({ versions });
});

// POST /api/analyses/promote-from-graph — Mint a legacy Analysis row bridging to
// completed new-spine graph substrate (Phase 2 of read-through linkage spine).
//
// Given a graph root id (RevisionId, 64-hex), create a legacy Analysis carrying:
//   - deal metadata (dealRef, propertyType, as-of date, loan terms) sourced from
//     the linked ExtractionResult + AssetProfile
//   - committee status at the initial post-ingest state ('complete', 100%)
//   - graphRevisionId pointer set so the projection layer resolves substrate
//     from HE / DE / NE via the existing graph accessors
//   - Legacy substrate fields (executiveSummary, creditScore, findings, etc.)
//     left null — they are served by projection in Phase 3+, not stored.
//
// Body: { rootRevisionId: string (64-hex), name?: string }
//   - rootRevisionId: the RevisionId returned by POST /api/build-and-ingest
//   - name: optional analysis name; defaults to the extraction's dealRef
//
// Responses:
//   - 201: { analysisId, graphRevisionId, name, assetType }
//   - 400: { error: 'INVALID_REQUEST' | 'MALFORMED_REVISION_ID' }
//   - 404: { error: 'REVISION_NOT_FOUND' | 'GRAPH_RECORDS_INCOMPLETE' }
const CONTRACTS_TO_LEGACY_ASSET_TYPE: Record<ContractsAssetType, AssetType> = {
  Office: 'office',
  Retail: 'retail',
  Multifamily: 'multifamily',
  Hotel: 'hotel',
  Industrial: 'industrial',
  SelfStorage: 'self_storage',
  MHC: 'manufactured_housing',
  MixedUse: 'mixed_use',
  Other: 'mixed_use',
};

analysisRoutes.post('/promote-from-graph', (req: Request, res: Response) => {
  const body = req.body as { rootRevisionId?: unknown; name?: unknown };
  if (typeof body.rootRevisionId !== 'string') {
    res.status(400).json({ error: 'INVALID_REQUEST', message: 'rootRevisionId required' });
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(body.rootRevisionId)) {
    res.status(400).json({ error: 'MALFORMED_REVISION_ID', message: 'rootRevisionId must be 64-hex' });
    return;
  }
  const rootRevisionId = body.rootRevisionId as RevisionId;

  const envelope = recordGraphStore.getRevisionEnvelope(rootRevisionId);
  if (envelope === null) {
    res.status(404).json({ error: 'REVISION_NOT_FOUND', rootRevisionId });
    return;
  }

  const doctrine = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) {
    res.status(404).json({ error: 'GRAPH_RECORDS_INCOMPLETE', missing: 'DoctrineEvaluation' });
    return;
  }
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId);
  if (extraction === null) {
    res.status(404).json({ error: 'GRAPH_RECORDS_INCOMPLETE', missing: 'ExtractionResult' });
    return;
  }
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId);
  if (assetProfile === null) {
    res.status(404).json({ error: 'GRAPH_RECORDS_INCOMPLETE', missing: 'AssetProfile' });
    return;
  }

  const id = uuid();
  const now = new Date().toISOString();
  const explicitName = typeof body.name === 'string' && body.name.length > 0 ? body.name : null;
  const name = explicitName ?? extraction.dealRef ?? `Promoted Analysis ${id.slice(0, 8)}`;

  const analysis: Analysis = {
    id,
    name,
    assetType: CONTRACTS_TO_LEGACY_ASSET_TYPE[assetProfile.propertyType],
    status: 'complete',
    progress: 100,
    currentStep: 'Complete (promoted from graph)',
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
    graphRevisionId: rootRevisionId,
  };
  store.createAnalysis(analysis);

  res.status(201).json({
    analysisId: id,
    graphRevisionId: rootRevisionId,
    name,
    assetType: analysis.assetType,
  });
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
    handleGraphRead(req, res, recordGraphStore, store);
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
  // Phase 3 — read-through projection. When analysis.graphRevisionId is set,
  // overlay substrate fields (executiveSummary in this phase) from the linked
  // graph records. Null-link / missing-graph cases pass through unchanged.
  const projected = projectLegacyAnalysisFromGraph(analysis, recordGraphStore);

  // Converge phase i — expose the graph-spine LINEAGE ROOT (64-hex) so the web page
  // can redirect a uuid URL onto RenderedAnalysisView. This is NOT analysis.graphRevisionId
  // (a specific RevisionId, which for a revised deal is NOT the lineage root and would
  // fail getLatestRevisionByLineageRoot). We resolve the true root via the revision
  // envelope. Read-only, additive; null when the analysis has no graph spine (none today).
  let graphLineageRootId: string | null = null;
  if (typeof projected.graphRevisionId === 'string' && projected.graphRevisionId.length > 0) {
    const envelope = recordGraphStore.getRevisionEnvelope(projected.graphRevisionId as never);
    graphLineageRootId = envelope?.lineageRootId ?? null;
  }
  res.json({ analysis: applyCreditPolicyBandsToAnalysis(projected), graphLineageRootId });
});

// GET /api/analyses/:id/handbook-evaluation — Sibling endpoint for the handbook
// engine output (#31 Commit 3). Returns null when no evaluation exists.
analysisRoutes.get('/:id/handbook-evaluation', (req: Request, res: Response) => {
  handleHandbookEvaluationRead(req, res, recordGraphStore);
});

// GET /api/analyses/:id/intake-completeness — field-level intake completeness
// ledger (P3b). ADVISORY read-only meta-layer: returns the 4-state ceiling for
// each of the 30 locked intake fields plus a summary. NEVER blocks export; the
// governed compose pipeline is untouched (annexA stays null → whole_loan_balance
// resolves the honest not-in-any-doc). Reuses the same PRESENCE derivation the
// export route computes at render.routes.ts (sourceDocumentKinds ∪ overlays).
analysisRoutes.get('/:id/intake-completeness', async (req: Request, res: Response) => {
  // Unified-Read: resolve for both id formats. The graph-id case recovers the
  // bridged legacy row (its uuid id is the dealId the panel echoes for the
  // /underwriting/export CTA; the export path is legacy-uuid based today).
  let stored;
  try {
    stored = resolveAnalysisForRead(req.params.id, recordGraphStore, store);
  } catch (e) {
    if (e instanceof MalformedAnalysisIdError) {
      res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
      return;
    }
    throw e;
  }
  if (!stored) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  // Read-time projection so overlays (appraisalExtraction, pcaExtraction,
  // environmentalSummary, …) are present for the K resolver — identical to the
  // export route's projectLegacyAnalysisFromGraph(stored, recordGraphStore).
  const analysis = projectLegacyAnalysisFromGraph(stored, recordGraphStore);

  // sourceDocumentKinds — the SAME derivation as render.routes.ts:871-889:
  // graphRevisionId → envelope → doctrineEvaluation → ExtractionResult.sourceDocuments.
  let sourceDocumentKinds: import('@cre/contracts').SourceDocumentKind[] = [];
  let graphExtractionResult: import('@cre/contracts').ExtractionResult | null = null;
  let lineageRootId: string | null = null;
  let assumedInputs: import('../services/assumed-inputs.service.js').AssumedInput[] = [];
  try {
    const envelope = analysis.graphRevisionId
      ? recordGraphStore.getRevisionEnvelope(analysis.graphRevisionId as GraphRevisionIdType)
      : null;
    lineageRootId = envelope?.lineageRootId ?? null;
    const doctrine = envelope
      ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId)
      : null;
    graphExtractionResult = doctrine
      ? recordGraphStore.getExtractionResult(doctrine.extractionResultId)
      : null;
    sourceDocumentKinds = (graphExtractionResult?.sourceDocuments ?? []).map((d) => d.kind);
    // ★ FIX 4 — which verdict inputs are ASSUMED (benchmark-substituted / defaulted),
    // not sourced from documents? A B-piece buyer must know 640's 6.5% rate + the
    // debt service it drives are assumptions, not facts.
    const adjustedInputs = envelope ? recordGraphStore.getAdjustedInputs(envelope.adjustedInputsId) : null;
    if (adjustedInputs) assumedInputs = getAssumedInputs(adjustedInputs);
  } catch {
    // best-effort — a missing graph chain leaves kinds empty; overlays still count.
  }

  // ★ DATA-AVAILABILITY, not doc-slot presence. The K resolver reads the spine
  // sub-records (loanTerms / inPlace / t12Actual / rentRoll / asr) off
  // `analysis.extractionResult` — but projectLegacyAnalysisFromGraph never sets
  // that field, so for a graph-native / pool-appended deal (e.g. 640) genuinely
  // EXTRACTED data showed as "missing": loan_amount ($400M in er.loanTerms), the
  // as-is value + cap rate (er.asr.impliedValue/impliedCapRate), and the ASR's
  // embedded rent roll (er.rentRoll, 19 units) all read empty. Attach the graph
  // ExtractionResult the score actually consumed so completeness reflects what we
  // HAVE, not whether a separate doc of kind X exists. (No production consumer
  // reads analysis.extractionResult off a projected row — only this K resolver.)
  // Attach as an untyped add-on: the K resolver reads it via
  // `(analysis as { extractionResult?: unknown }).extractionResult` (Analysis has
  // no typed slot for it — the classic-ingest path stored it, graph-native deals
  // don't). Double-cast is the intended escape hatch for that seam.
  const analysisForCompleteness = graphExtractionResult
    ? ({ ...analysis, extractionResult: graphExtractionResult } as unknown as typeof analysis)
    : analysis;

  const result = computeIntakeCompleteness({
    analysis: analysisForCompleteness,
    sourceDocumentKinds,
    overlayPresence: {
      t12Extraction: !!analysis.t12Extraction,
      issuerUwExtraction: !!analysis.issuerUwExtraction,
      sourcesAndUses: !!analysis.sourcesAndUses,
      pcaExtraction: !!analysis.pcaExtraction,
      partiesExtraction: !!analysis.partiesExtraction,
      appraisalExtraction: !!analysis.appraisalExtraction,
    },
  });
  // ★ EXHAUSTIVE SOURCING PASS — before returning any field as "missing", search
  // EVERY document routed to the deal for it (not just the 5 the graph extracted).
  // 640 carries 10 docs (ESA, appraisals, cash-flow workbooks, seller UW) whose
  // facts the graph never read; this sources environmental status, NOI, values,
  // etc. from them, and marks deal-inapplicable fields (GSA on a non-GSA deal)
  // not-applicable. Cached (docSetHash+field); credit-gated + fail-safe → on no
  // credits / any error the base result passes through unchanged (never a false
  // blank). Best-effort: a resolution/search failure returns the base result.
  let finalResult = result;
  try {
    const loanRef = lineageRootId ? resolveLoanForRoot(lineageRootId) : null;
    if (loanRef && loanRef.resolved) {
      finalResult = await augmentIntakeCompletenessWithSourcing(
        result, loanRef.poolId, loanRef.loanInPoolId,
      );
    }
  } catch {
    // best-effort — the exhaustive pass never blocks the advisory read.
  }
  // Echo the export params the panel needs so its always-on "Create workbook"
  // CTA can call /underwriting/export without a second round-trip. dealId is the
  // stored analysis id (legacy uuid); assetClass drives the render schema.
  res.json({ ...finalResult, dealId: stored.id, assetClass: analysis.assetType, assumedInputs });
});

// GET /api/analyses/:id/buyer-diff — the buyer diff: ISSUER underwriting vs OUR
// buyer-adjusted underwriting, per field, with the WHY. Read-only + deterministic:
// projectBuyerDiff over the frozen AdjustedInputs (no recompute, no mint, no LLM).
// GET /api/analyses/:id/slot-extraction/:docType — Data Room Tier 2(c). Projects a
// slot's ingest-time extraction to a display DTO (rent_roll branch built). Boundary-
// honoring: reads the hydrated node, returns the DTO ONLY (never raw ExtractionResult).
// Credit-free (no LLM). Deal-access gated by the :id param. ?offset paginates (limit 50).
analysisRoutes.get('/:id/slot-extraction/:docType', (req: Request, res: Response) => {
  const docType = req.params['docType'];
  if (docType !== 'rent_roll' && docType !== 'pca') {
    res.status(501).json({ error: 'NOT_IMPLEMENTED', message: `slot-extraction for '${docType}' is not built yet` });
    return;
  }
  let stored;
  try {
    stored = resolveAnalysisForRead(req.params.id!, recordGraphStore, store);
  } catch {
    stored = null;
  }
  if (!stored) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  const envelope = stored.graphRevisionId
    ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as GraphRevisionIdType)
    : null;
  const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;

  if (docType === 'pca') {
    const extraction = doctrine?.extractionResultId
      ? recordGraphStore.getExtractionResult(doctrine.extractionResultId)
      : null;
    const pca = extraction?.pca ?? null;
    if (!pca) {
      res.json({ status: 'not_extracted', extraction: null });
      return;
    }
    res.json({ status: 'present', extraction: projectPca(pca) });
    return;
  }

  const rentRoll = doctrine?.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
  if (!rentRoll) {
    res.json({ status: 'not_extracted', extraction: null });
    return;
  }
  const offset = Number(req.query['offset']) || 0;
  res.json({ status: 'present', extraction: projectRentRoll(rentRoll, offset, RENT_ROLL_PAGE_SIZE) });
});

// `?format=html` returns the visual tri-state view (with the show/hide-changes
// toggle); default returns JSON. First-class + addressable — the bank-side centerpiece.
analysisRoutes.get('/:id/buyer-diff', (req: Request, res: Response) => {
  let stored;
  try {
    stored = resolveAnalysisForRead(req.params.id, recordGraphStore, store);
  } catch (e) {
    if (e instanceof MalformedAnalysisIdError) {
      res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
      return;
    }
    throw e;
  }
  if (!stored) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  const envelope = stored.graphRevisionId
    ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as GraphRevisionIdType)
    : null;
  const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
  const extraction = doctrine ? recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
  const adjustedInputs = envelope ? recordGraphStore.getAdjustedInputs(envelope.adjustedInputsId) : null;
  if (!envelope || !extraction || !adjustedInputs) {
    res.status(409).json({ error: 'GRAPH_RECORDS_INCOMPLETE', message: 'missing envelope / extraction / adjustedInputs for this analysis' });
    return;
  }

  const cross = buildBuyerDiffCrossCheck(adjustedInputs, extraction, extraction.analysisAsOfDate);
  const rows = projectBuyerDiff(cross);

  if (req.query.format === 'html') {
    res.status(200).type('html').send(
      renderBuyerDiffHtml({ id: req.params.id, dealRef: extraction.dealRef }, rows, cross.overallAdjustmentBias),
    );
    return;
  }
  res.status(200).json({
    id: req.params.id,
    dealRef: extraction.dealRef,
    overallAdjustmentBias: cross.overallAdjustmentBias,
    rows,
  });
});

// ── Buyer-diff DECISIONS (accept/reject) — a MUTABLE sibling keyed to the eval's
// crossCheckResultId, OUTSIDE the score hash. Read/write NEVER re-mints, NEVER
// touches the head: a decision governs ONLY what renders in the seller-UW Excel.
// A bank cannot reject its way to a better score.
function resolveBuyerDiffContext(id: string):
  | { ok: true; crossCheckResultId: import('@cre/contracts').CrossCheckResultId; adjustedInputs: import('@cre/contracts').AdjustedInputs; extraction: import('@cre/contracts').ExtractionResult }
  | { ok: false; status: number; error: string } {
  let stored;
  try { stored = resolveAnalysisForRead(id, recordGraphStore, store); }
  catch (e) { if (e instanceof MalformedAnalysisIdError) return { ok: false, status: 400, error: 'MALFORMED_ANALYSIS_ID' }; throw e; }
  if (!stored) return { ok: false, status: 404, error: 'Analysis not found' };
  const envelope = stored.graphRevisionId ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as GraphRevisionIdType) : null;
  const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
  const extraction = doctrine ? recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
  const adjustedInputs = envelope ? recordGraphStore.getAdjustedInputs(envelope.adjustedInputsId) : null;
  if (!doctrine || !extraction || !adjustedInputs) return { ok: false, status: 409, error: 'GRAPH_RECORDS_INCOMPLETE' };
  return { ok: true, crossCheckResultId: doctrine.crossCheckResultId, adjustedInputs, extraction };
}

// GET /api/analyses/:id/buyer-diff/decisions — the decidable adjustments + current
// accept/reject state (pending by default). Only ENGINE-REAL adjustments appear.
analysisRoutes.get('/:id/buyer-diff/decisions', (req: Request, res: Response) => {
  const ctx = resolveBuyerDiffContext(req.params.id);
  if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const suggestions = buildBuyerDiffSuggestions(ctx.adjustedInputs, ctx.extraction);
  const merged = mergeDecisions(suggestions, recordGraphStore.getBuyerDiffDecisions(ctx.crossCheckResultId));
  res.status(200).json({ id: req.params.id, dealRef: ctx.extraction.dealRef, findings: merged });
});

// PUT /api/analyses/:id/buyer-diff/decisions/:findingId — set accept/reject.
analysisRoutes.put('/:id/buyer-diff/decisions/:findingId', (req: Request, res: Response) => {
  const ctx = resolveBuyerDiffContext(req.params.id);
  if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const decision = (req.body as { decision?: unknown } | undefined)?.decision;
  if (decision !== 'accepted' && decision !== 'rejected' && decision !== 'pending') {
    res.status(400).json({ error: 'INVALID_DECISION', message: "decision must be 'accepted' | 'rejected' | 'pending'" });
    return;
  }
  const suggestions = buildBuyerDiffSuggestions(ctx.adjustedInputs, ctx.extraction);
  if (!decidableFindingIds(suggestions).has(req.params.findingId)) {
    // Only adjustments are decidable — agreement / can't-verify are not accept/reject-able.
    res.status(404).json({ error: 'NOT_DECIDABLE', message: `finding '${req.params.findingId}' is not a decidable adjustment` });
    return;
  }
  recordGraphStore.putBuyerDiffDecision(ctx.crossCheckResultId, req.params.findingId, decision as BuyerDiffDecision);
  const merged = mergeDecisions(suggestions, recordGraphStore.getBuyerDiffDecisions(ctx.crossCheckResultId));
  res.status(200).json({ id: req.params.id, findingId: req.params.findingId, decision, findings: merged });
});

// GET /api/analyses/:id/buyer-diff/export — download a CLEAN .xlsx generated FRESH
// from the current decisions: accepted adjustments marked (amber + comment + buyer #),
// rejected/pending clean (issuer stands). Deterministic — same decisions → same file.
analysisRoutes.get('/:id/buyer-diff/export', async (req: Request, res: Response) => {
  const ctx = resolveBuyerDiffContext(req.params.id);
  if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const merged = mergeDecisions(
    buildBuyerDiffSuggestions(ctx.adjustedInputs, ctx.extraction),
    recordGraphStore.getBuyerDiffDecisions(ctx.crossCheckResultId),
  );
  const buf = await generateBuyerDiffWorkbook(ctx.extraction.dealRef, merged);
  const safe = ctx.extraction.dealRef.replace(/[^A-Za-z0-9._-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Buyer-Adjusted-UW-${safe}.xlsx"`);
  res.status(200).send(buf);
});

// GET /api/analyses/:id/memo — Credit Committee Memorandum HTML.
//
// Reconstructs the deterministic dealResult + composedMitigationPackage from
// the persisted graph chain (no LLM re-spend; the narrative is read from the
// spine) and renders via buildCommitteeMemo. Returns the HTML as a downloadable
// attachment.
//
// 404 when the analysis is missing or lacks a graph chain; 409 when the chain
// is incomplete (e.g. narrative not yet produced).
analysisRoutes.get('/:id/memo', (req: Request, res: Response) => {
  // Unified-Read: resolve :id for BOTH id formats (graph lineage root → latest
  // revision, or legacy uuid → latest revision in lineage). The prior direct
  // store.getAnalysis(:id) 404'd whenever the deal was viewed via its 64-hex
  // graph id (the reported Sunroad download-memo bug). Malformed ids surface as
  // the existing 400.
  let analysis;
  try {
    analysis = resolveAnalysisForRead(req.params.id, recordGraphStore, store);
  } catch (e) {
    if (e instanceof MalformedAnalysisIdError) {
      res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
      return;
    }
    throw e;
  }
  if (!analysis) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  const result = renderMemoForAnalysis(analysis, recordGraphStore);
  if (!result.ok) {
    const httpStatus = result.code === 'NO_GRAPH_LINK' ? 409 : 409;
    res.status(httpStatus).json({ error: result.reason, code: result.code });
    return;
  }
  const safeName = analysis.name.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 60).trim() || 'CreditCommitteeMemo';
  // RFC 7230 § 3.2.4 forbids non-ASCII octets in field-value; Node's strict
  // http parser rejects setHeader() with non-ASCII (e.g. U+2014 em-dash) by
  // throwing ERR_INVALID_CHAR, which surfaces as a 500. Use a plain ASCII
  // hyphen-minus here. The frontend passes the prettier em-dash separator
  // via the <a download="…"> attribute (which DOES accept Unicode), so the
  // browser-saved filename keeps the typographic dash; only the server-side
  // fallback name is constrained to ASCII.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName} - Credit Committee Memo.html"`);
  res.send(result.html);
});

// GET /api/analyses/:id/status — Polling endpoint
analysisRoutes.get('/:id/status', (req: Request, res: Response) => {
  // Unified-Read: resolve for both id formats so polling by a 64-hex graph id
  // (the format the deal-room page routes with) doesn't 404.
  let analysis;
  try {
    analysis = resolveAnalysisForRead(req.params.id, recordGraphStore, store);
  } catch (e) {
    if (e instanceof MalformedAnalysisIdError) {
      res.status(400).json({ error: 'MALFORMED_ANALYSIS_ID', message: e.message });
      return;
    }
    throw e;
  }
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

// POST /api/analyses/:id/archive — soft-archive (hide from the default deal
// list). Reversible via /restore. Touches only the analyses row; graph history
// + blobs are preserved. The base primitive for a future deal-lifecycle
// (Cleared/Closed/Expired/Withdrawn) disposition doctrine.
analysisRoutes.post('/:id/archive', (req: Request, res: Response) => {
  const ok = store.setAnalysisArchived(req.params.id, true);
  if (!ok) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({ success: true, archived: true });
});

// POST /api/analyses/:id/restore — un-archive (flip archived → false). Proves
// the archive is genuinely reversible, not a soft-delete-that's-really-a-delete.
analysisRoutes.post('/:id/restore', (req: Request, res: Response) => {
  const ok = store.setAnalysisArchived(req.params.id, false);
  if (!ok) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({ success: true, archived: false });
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
  async (req: Request, res: Response) => {
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
      await handleGraphRevision(req, res, recordGraphStore);
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
/**
 * Resolve a graph `:id` (root, HEAD, or any revision on the lineage) to the
 * AUTHORITATIVE current-head envelope to render.
 *
 * WHY (the render-less-head 404): the naïve `getLatestRevisionByLineageRoot(id)`
 * has two failure modes that blanked the whole analysis view for a re-scored
 * deal: (1) it only matches a lineage ROOT, so a non-root HEAD id → null → 404;
 * (2) "latest by ordinal" is AMBIGUOUS when a lineage has branches (640's
 * rolled-back siblings are all ordinal-1 children of the same root) — it can pick
 * a stale sibling, not the current head. The ONLY authoritative head is the
 * deal's canonical `analyses.graph_revision_id`. `resolveAnalysisForRead` already
 * resolves that (canonical scored analysis → its graphRevisionId) and, as of the
 * non-root fix, handles any revision id — so route through it when the sqlite
 * store is available. Fall back to the graph-native latest (with non-root
 * handling) when it isn't (route tests pass only the graph store, and pure-graph
 * deals have no legacy head pointer).
 */
function resolveGraphHeadEnvelope(
  id: RevisionId,
  graphStore: RecordGraphStore,
  sqliteStore?: SqliteStore,
): RevisionLineageEnvelope | null {
  if (sqliteStore !== undefined) {
    const analysis = resolveAnalysisForRead(id, graphStore, sqliteStore);
    if (analysis !== null && typeof analysis.graphRevisionId === 'string' && analysis.graphRevisionId.length > 0) {
      const headEnv = graphStore.getRevisionEnvelope(analysis.graphRevisionId as RevisionId);
      if (headEnv !== null) return headEnv;
    }
  }
  // Graph-native fallback: latest by lineage root, resolving a non-root id via
  // its envelope so a head/child id still lands on its lineage's latest.
  const byRoot = graphStore.getLatestRevisionByLineageRoot(id);
  if (byRoot !== null) return byRoot;
  const self = graphStore.getRevisionEnvelope(id);
  if (self !== null) return graphStore.getLatestRevisionByLineageRoot(self.lineageRootId as RevisionId);
  return null;
}

export function handleGraphRead(
  req: Request,
  res: Response,
  graphStore: RecordGraphStore,
  sqliteStore?: SqliteStore,
): void {
  const id = req.params.id as RevisionId;
  const envelope = resolveGraphHeadEnvelope(id, graphStore, sqliteStore);
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
      lineageRootId: envelope.lineageRootId,
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
  const id = req.params.id as RevisionId;

  // Resolve to the latest revision envelope. Same non-root-robust pattern as
  // handleGraphRead: a re-scored deal's HEAD is a non-root revision, so try the
  // id as a root, then recover its lineage root via the envelope and walk to
  // latest. Without this a head id → null → a spurious 404 (silently caught by
  // the client, but the eval is then invisible).
  let envelope = graphStore.getLatestRevisionByLineageRoot(id);
  if (envelope === null) {
    const self = graphStore.getRevisionEnvelope(id);
    if (self !== null) {
      envelope = graphStore.getLatestRevisionByLineageRoot(self.lineageRootId as RevisionId);
    }
  }
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
export async function handleGraphRevision(
  req: Request,
  res: Response,
  graphStore: RecordGraphStore,
): Promise<void> {
  // Thin top-level body shape validation. Per-override validation (path whitelist, value type,
  // engine-mirrored vacancy+concessions) is the service's job; surfaces as InvalidDeltaError.
  const body = req.body as
    | {
        delta?: { kind?: string; overrides?: unknown; assessment?: unknown };
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
  const deltaKind = body.delta.kind;
  const isOverrides = deltaKind === 'adjusted-input-overrides' && Array.isArray(body.delta.overrides);
  const isSponsorAssessment = deltaKind === 'sponsor-assessment';
  if (!isOverrides && !isSponsorAssessment) {
    res.status(400).json({
      error: 'INVALID_BODY',
      message: "body.delta must be { kind: 'adjusted-input-overrides', overrides: [...] } or { kind: 'sponsor-assessment', assessment: {...} }",
    });
    return;
  }

  // Build the human sponsor assessment from the request. THE INVARIANT: every
  // factor is taken from the reviewer's explicit input — never derived from a
  // DD finding (there is no code path that reads a finding here). Provenance is
  // stamped 'human' and the server stamps who (authenticated reviewer) + when.
  let sponsorAssessmentInput: HumanSponsorAssessment | null = null;
  if (isSponsorAssessment) {
    const a = body.delta.assessment as Record<string, unknown> | undefined;
    const factors = ['experience', 'financialStrength', 'alignment', 'priorCreditEvents', 'managementQuality'] as const;
    if (!a || typeof a !== 'object') {
      res.status(400).json({ error: 'INVALID_BODY', message: 'sponsor-assessment requires delta.assessment with the five factors' });
      return;
    }
    for (const f of factors) {
      if (!isSponsorFactorRating(a[f])) {
        res.status(400).json({ error: 'INVALID_BODY', message: `delta.assessment.${f} must be one of Strong|Neutral|Weak|Severe (reviewer must set each factor)` });
        return;
      }
    }
    const enteredBy = req.user?.email ?? (typeof a.enteredBy === 'string' && a.enteredBy.length > 0 ? a.enteredBy : null);
    if (enteredBy === null) {
      res.status(400).json({ error: 'INVALID_BODY', message: 'sponsor-assessment requires an attributed reviewer (authenticated, or delta.assessment.enteredBy)' });
      return;
    }
    sponsorAssessmentInput = {
      experience:        a.experience as never,
      financialStrength: a.financialStrength as never,
      alignment:         a.alignment as never,
      priorCreditEvents: a.priorCreditEvents as never,
      managementQuality: a.managementQuality as never,
      enteredBy,
      enteredAt:         new Date().toISOString(),
      ...(typeof a.note === 'string' && a.note.length > 0 ? { note: a.note } : {}),
      provenance:        'human',
    };
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

  const delta: GraphRevisionDelta = isSponsorAssessment
    ? { kind: 'sponsor-assessment', assessment: sponsorAssessmentInput! }
    : {
        kind: 'adjusted-input-overrides',
        overrides: body.delta.overrides as ReadonlyArray<{ path: string; value: number }>,
      };

  try {
    const result = await applyRevisionDelta(
      {
        parentRevisionId: latest.revisionId,
        delta,
        triggerSource,
        adjustmentOrigin,
      },
      graphStore,
      // External DD at mint (§4/§6) — gated by EXTERNAL_DD_AT_MINT (default OFF).
      { externalDd: { enabled: env.externalDdAtMint } },
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
    // Data-integrity gate HARD halt — surface legible per-finding messages
    // and signal data_quality_failed. No verdict was persisted; the
    // existing revision lineage stays intact.
    if (e instanceof DataIntegrityHardHaltError) {
      // eslint-disable-next-line no-console
      console.warn('[analysis.routes /revisions] data-integrity HARD halt:', e.message);
      res.status(422).json({
        error: 'DATA_INTEGRITY_HARD_HALT',
        message:
          'Data-integrity gate blocked the verdict — one or more checks failed. ' +
          'Resolve the issues below and resubmit.',
        status: 'data_quality_failed',
        findings: e.report.findings.map((f) => ({
          severity: f.severity,
          layer:    f.layer,
          check:    f.check,
          title:    f.title,
          message:  f.message,
          ...(f.values ? { values: f.values } : {}),
        })),
      });
      return;
    }
    if (e instanceof SynthesizeUwModelTieOutError) {
      // Graceful 500 — the revision's synthesized UW model failed the NOI
      // tie-out (e.g. an override on a deal carrying a stale
      // JE_NOI_CAPPED_TO_BANK cap; see the option 2/3 root-cause recon). Surface
      // a clear error rather than letting the throw escape the async handler and
      // crash the process. No revision was persisted; the existing lineage is
      // intact. (This is robustness only — it does NOT make such overrides
      // succeed; that is the cap replay/drop fix.)
      res.status(500).json({
        error: 'REVISION_TIEOUT',
        message:
          'Revision could not be evaluated — the synthesized underwriting model did not ' +
          'tie out to the engine NOI. No revision was saved.',
        synthesizedNoi: e.synthesizedNoi,
        aiMetricsNoi: e.aiMetricsNoi,
      });
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

/* --------------------------- append-document (3a) ------------------------- */

/**
 * POST /api/analyses/:id/append-document — add a source document to an existing
 * deal and re-ingest it as a CHILD revision (append flow). SELF-SOURCES the
 * parent's market-benchmarks + credit-manifesto via the eval-context sibling
 * (the A-enabler), so the child stays consistent with the parent — no caller
 * re-benchmarking. Factory with INJECTABLE stores so the integration verify can
 * drive the handler copy-bound (analysis.routes is otherwise singleton-bound).
 *
 *   multipart: file field "document" + body field "slot"
 *   201 → { childRevisionId, revisionOrdinal, overlayDivergences, newDocPersist }
 */
export function makeAppendDocumentHandler(deps: { store: SqliteStore; graph: RecordGraphStore }) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    const slot = (req.body as { slot?: string } | undefined)?.slot;
    if (!file) { res.status(400).json({ error: 'no_document', message: 'multipart file field "document" is required' }); return; }
    if (!slot) { res.status(400).json({ error: 'missing_slot', message: 'body field "slot" is required' }); return; }

    const analysis = deps.store.getAnalysis(id);
    if (analysis === null) { res.status(404).json({ error: 'analysis_not_found', id }); return; }
    const parentRev = analysis.graphRevisionId;
    if (!parentRev) { res.status(404).json({ error: 'not_graph_backed', id, message: 'analysis has no graph revision' }); return; }

    // SELF-SOURCE benchmarks/manifesto from the parent (A-enabler). No caller
    // fallback — a deal that predates eval-context recording is not append-able.
    const ctx = deps.graph.getRevisionEvaluationContext(parentRev);
    if (ctx === null) {
      res.status(422).json({ error: 'no_eval_context', message: 'deal predates eval-context recording — not append-able' });
      return;
    }

    try {
      const result = await appendSourceDocToDeal(
        {
          analysisId: id,
          newDoc: { slot: slot as SourceDocSlot, originalFileName: file.originalname, bytes: file.buffer },
          marketBenchmarksId: ctx.marketBenchmarksId as MarketBenchmarksId,
          creditManifestoId: ctx.creditManifestoId as CreditManifestoId,
        },
        { sqliteStore: deps.store, recordGraphStore: deps.graph },
      );
      res.status(201).json(result);
    } catch (e) {
      if (e instanceof IngestionError) {
        if (e.code === 'MARKET_BENCHMARKS_NOT_FOUND' || e.code === 'CREDIT_MANIFESTO_NOT_FOUND') {
          res.status(422).json({ error: 'parent_context_unresolvable', code: e.code, message: "parent's benchmarks/manifesto not resolvable — not append-able" });
          return;
        }
        if (e.code === 'PARENT_REVISION_NOT_FOUND') { res.status(404).json({ error: e.code, message: e.message }); return; }
        res.status(400).json({ error: e.code, message: e.message });
        return;
      }
      const msg = (e as Error)?.message ?? 'append failed';
      if (/invalid deal-doc slot/.test(msg)) { res.status(400).json({ error: 'invalid_slot', message: msg }); return; }
      // eslint-disable-next-line no-console
      console.error('[append-document] error:', msg);
      res.status(500).json({ error: 'append_failed', message: msg });
    }
  };
}

analysisRoutes.post('/:id/append-document', upload.single('document'), makeAppendDocumentHandler({ store, graph: recordGraphStore }));
