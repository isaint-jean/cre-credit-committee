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
import { v4 as uuid } from 'uuid';

export const analysisRoutes = Router();

// POST /api/analyses — Upload and start analysis
analysisRoutes.post('/', uploadAnalysisFiles as any, async (req: Request, res: Response) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const asrFile = files['asr']?.[0];
    const sellerUwFile = files['seller_uw']?.[0] || files['uw']?.[0];
    const supportingDocFiles = files['supporting_docs'] || [];
    const templateFile = files['template']?.[0];
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
      { inputHash: cacheResult.inputHash, components: cacheResult.components }
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

// GET /api/analyses/:id — Full detail
analysisRoutes.get('/:id', (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }
  res.json({ analysis });
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

// PATCH /api/analyses/:id/uw-model — Update UW model cells
analysisRoutes.patch('/:id/uw-model', (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis || !analysis.uwModel) {
    res.status(404).json({ error: 'Analysis or UW model not found' });
    return;
  }

  const { updates } = req.body as { updates: { path: string; value: number }[] };
  if (!updates || !Array.isArray(updates)) {
    res.status(400).json({ error: 'updates array required' });
    return;
  }

  let model = JSON.parse(JSON.stringify(analysis.uwModel));
  // Metric values are nullable — null = not computable for this version.
  const changedMetrics: { metric: string; oldValue: number | null; newValue: number | null }[] = [];

  for (const update of updates) {
    const oldValue = getNestedValue(model, update.path);
    setNestedValue(model, update.path, update.value);

    // Mark as overridden if it's a line item
    const parts = update.path.split('.');
    if (parts.length >= 2) {
      const overriddenPath = parts.slice(0, -1).join('.') + '.isOverridden';
      try { setNestedValue(model, overriddenPath, true); } catch {}
    }

    if (!model.modifiedCells.includes(update.path)) {
      model.modifiedCells.push(update.path);
    }
  }

  // Store old metrics
  const oldNOI = analysis.uwModel.netOperatingIncome;
  const oldDSCR = analysis.uwModel.dscr;
  const oldLTV = analysis.uwModel.ltv;

  model.asReported = false;
  model = recalculateFullModel(model);

  if (model.netOperatingIncome !== oldNOI) {
    changedMetrics.push({ metric: 'NOI', oldValue: oldNOI, newValue: model.netOperatingIncome });
  }
  if (model.dscr !== oldDSCR) {
    changedMetrics.push({ metric: 'DSCR', oldValue: oldDSCR, newValue: model.dscr });
  }
  if (model.ltv !== oldLTV) {
    changedMetrics.push({ metric: 'LTV', oldValue: oldLTV, newValue: model.ltv });
  }

  store.updateAnalysis(req.params.id, { uwModel: model });
  res.json({ uwModel: model, changedMetrics });
});

// PATCH /api/analyses/:id/loan-terms — Update loan terms interactively
analysisRoutes.patch('/:id/loan-terms', (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis || !analysis.uwModel) {
    res.status(404).json({ error: 'Analysis or UW model not found' });
    return;
  }

  const updates = req.body as {
    interestRate?: number;
    ioMonths?: number;
    amortizationMonths?: number;
    termMonths?: number;
    rateType?: 'fixed' | 'floating';
    paymentFrequency?: 'monthly' | 'quarterly';
    prepaymentTerms?: string;
    loanAmount?: number;
  };

  let model = JSON.parse(JSON.stringify(analysis.uwModel));
  // Metric values are nullable — null = not computable for this version.
  const changedMetrics: { metric: string; oldValue: number | null; newValue: number | null }[] = [];

  const oldDSCR = model.dscr;
  const oldADS = model.annualDebtService;

  // Apply updates to loanDetails
  if (updates.interestRate !== undefined) {
    model.interestRate = updates.interestRate;
    model.loanDetails.interestRate = updates.interestRate;
  }
  if (updates.loanAmount !== undefined) {
    model.loanAmount = updates.loanAmount;
    model.loanDetails.loanAmount = updates.loanAmount;
  }
  if (updates.ioMonths !== undefined) {
    model.loanDetails.ioMonths = updates.ioMonths;
  }
  if (updates.amortizationMonths !== undefined) {
    model.loanDetails.amortizationMonths = updates.amortizationMonths;
    model.amortizationYears = updates.amortizationMonths / 12;
  }
  if (updates.termMonths !== undefined) {
    model.loanDetails.termMonths = updates.termMonths;
    model.termYears = updates.termMonths / 12;
  }
  if (updates.rateType !== undefined) {
    model.loanDetails.rateType = updates.rateType;
  }
  if (updates.paymentFrequency !== undefined) {
    model.loanDetails.paymentFrequency = updates.paymentFrequency;
  }
  if (updates.prepaymentTerms !== undefined) {
    model.loanDetails.prepaymentTerms = updates.prepaymentTerms;
  }

  model.asReported = false;
  model = recalculateFullModel(model);

  if (model.annualDebtService !== oldADS) {
    changedMetrics.push({ metric: 'Annual Debt Service', oldValue: oldADS, newValue: model.annualDebtService });
  }
  if (model.dscr !== oldDSCR) {
    changedMetrics.push({ metric: 'DSCR', oldValue: oldDSCR, newValue: model.dscr });
  }

  store.updateAnalysis(req.params.id, { uwModel: model });
  res.json({ uwModel: model, repaymentSchedule: model.repaymentSchedule, changedMetrics });
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
  res.json({ results });
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
analysisRoutes.get('/:id/populated-template/info', (req: Request, res: Response) => {
  const populated = store.getPopulatedTemplate(req.params.id);
  if (!populated) {
    res.status(404).json({ available: false });
    return;
  }

  res.json({
    available: true,
    fileName: populated.fileName,
    mappedFields: JSON.parse(populated.mappedFields),
    unmappedFields: JSON.parse(populated.unmappedFields),
    tabsPopulated: JSON.parse(populated.tabsPopulated),
  });
});

// GET /api/analyses/:id/bp-spiral-memo — Download BP Spiral Underwriting memo (PDF)
analysisRoutes.get('/:id/bp-spiral-memo', async (req: Request, res: Response) => {
  const analysis = store.getAnalysis(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }

  if (analysis.status !== 'complete') {
    res.status(400).json({ error: 'Analysis is not complete. Memo is only available after successful completion.' });
    return;
  }

  if (!analysis.validationResult?.passed) {
    res.status(400).json({ error: 'Validation did not pass. Memo cannot be generated for unvalidated analyses.' });
    return;
  }

  try {
    const { generateBPSpiralMemo } = await import('../services/bp-spiral-memo.service.js');
    const pdfBuffer = await generateBPSpiralMemo(analysis);
    const safeName = analysis.name.replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 60);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="BP_Spiral_UW_${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('BP Spiral memo generation error:', error);
    res.status(500).json({ error: error.message || 'Memo generation failed' });
  }
});

// GET /api/analyses/:id/bank-underwriting — Download original bank underwriting file
analysisRoutes.get('/:id/bank-underwriting', (req: Request, res: Response) => {
  // Prefer seller_uw (the bank's underwriting); fall back to ASR
  let upload = store.getOriginalUpload(req.params.id, 'seller_uw');
  if (!upload) {
    upload = store.getOriginalUpload(req.params.id, 'asr');
  }
  if (!upload) {
    res.status(404).json({ error: 'No original underwriting file available for this analysis.' });
    return;
  }

  res.setHeader('Content-Type', upload.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${upload.fileName}"`);
  res.send(upload.fileData);
});

// GET /api/analyses/:id/bank-underwriting/info — Check availability of original files
analysisRoutes.get('/:id/bank-underwriting/info', (req: Request, res: Response) => {
  const uploads = store.listOriginalUploads(req.params.id);
  const sellerUw = uploads.find(u => u.fileType === 'seller_uw');
  const asr = uploads.find(u => u.fileType === 'asr');
  const bankUw = sellerUw || asr;

  res.json({
    available: !!bankUw,
    fileName: bankUw?.fileName || null,
    fileType: bankUw?.fileType || null,
    uploads: uploads.map(u => ({ fileType: u.fileType, fileName: u.fileName })),
  });
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
  cacheContext?: { inputHash: string; components: HashComponents }
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

    // Step 5a: Populate underwriting template (use default if none provided)
    if (uwModel) {
      try {
        store.updateAnalysis(id, { progress: 60, currentStep: 'Populating underwriting template...' });

        // Fall back to a generated default template when the user didn't select one
        const effectiveTemplateBuffer = templateBuffer || await createDefaultTemplate();
        const result = await populateTemplate(effectiveTemplateBuffer, uwModel);

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
      const errorSummary = validationResult.errors
        .map(e => `[${e.category}] ${e.name}: ${e.details}`)
        .join('; ');
      throw new Error(`Validation failed: ${errorSummary}`);
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

// Utility for nested property access
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]];
    if (!current) return;
  }
  current[keys[keys.length - 1]] = value;
}
