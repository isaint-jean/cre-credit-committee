import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload.js';
import { store } from '../storage/sqlite-store.js';
import { AssetType, DealOutcome } from '@cre/shared';
import type { TemplateType } from '@cre/shared';
import { v4 as uuid } from 'uuid';
import {
  ingestUnderwriting,
  ingestAutoClassified,
  getHistoricalUW,
  listHistoricalUWs,
  getPortfolioChildren,
  updateHistoricalUW,
  deleteHistoricalUW,
  getUploadedFile,
  listLearnedRules,
  updateLearnedRule,
  deleteLearnedRule,
  getRuleVersions,
  rollbackRule,
  computePatternInsights,
  generateRulesFromPatterns,
  applyIntelligence,
  getDataSufficiency,
  getRuleMetadata,
  computeMarketIntelligence,
  reExtractAllNarratives,
  ingestDealOutcomes,
  applyOutcomeMatch,
  listUnmatchedOutcomes,
  getUnmatchedOutcome,
  linkUnmatchedOutcome,
  deleteUnmatchedOutcome,
} from '../services/uw-intelligence.service.js';
import { batchQueue, getBatchJob } from '../services/batch-queue.service.js';
import { analyzeTemplateStructure } from '../services/template-engine.service.js';

export const uwIntelligenceRoutes = Router();

const uploadSingle = upload.single('file');
const uploadMultiple = upload.array('files', 1000);

// ---------------------------------------------------------------------------
// Historical Underwriting Library
// ---------------------------------------------------------------------------

// POST /api/uw-intelligence/upload — Upload a completed underwriting file
uwIntelligenceRoutes.post('/upload', uploadSingle as any, async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Underwriting file is required' });
      return;
    }

    const assetType = req.body.assetType as AssetType;
    const outcome = req.body.outcome as DealOutcome;
    const dealName = req.body.dealName || file.originalname;
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const notes = req.body.notes || '';

    if (!assetType) {
      res.status(400).json({ error: 'assetType is required' });
      return;
    }
    if (!outcome || !['approved', 'modified', 'rejected'].includes(outcome)) {
      res.status(400).json({ error: 'outcome is required (approved / modified / rejected)' });
      return;
    }

    const record = await ingestUnderwriting(
      file.buffer, file.originalname, assetType, outcome, dealName, date, notes
    );

    res.status(201).json({ underwriting: record });
  } catch (error: any) {
    console.error('UW Intelligence upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// POST /api/uw-intelligence/batch-upload — Batch upload with auto-classification
uwIntelligenceRoutes.post('/batch-upload', uploadMultiple as any, async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'At least one file is required' });
      return;
    }

    const results: { fileName: string; status: 'success' | 'error' | 'skipped'; id?: string; dealName?: string; assetType?: string; loanType?: string; skipReason?: string; error?: string }[] = [];

    for (const file of files) {
      try {
        const record = await ingestAutoClassified(file.buffer, file.originalname);
        if ((record as any)._skipped) {
          results.push({
            fileName: file.originalname,
            status: 'skipped',
            id: record.id,
            dealName: record.dealName,
            assetType: record.assetType,
            loanType: record.loanType,
            skipReason: (record as any)._skipReason || 'Duplicate detected',
          });
        } else {
          results.push({
            fileName: file.originalname,
            status: 'success',
            id: record.id,
            dealName: record.dealName,
            assetType: record.assetType,
            loanType: record.loanType,
          });
        }
      } catch (err: any) {
        results.push({
          fileName: file.originalname,
          status: 'error',
          error: err.message || 'Processing failed',
        });
      } finally {
        // Release the multer memory buffer and give V8 a chance to reclaim
        // the large XLSX / text intermediates before loading the next file.
        (file as any).buffer = null;
        if (typeof (globalThis as any).gc === 'function') (globalThis as any).gc();
      }
    }

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    res.status(201).json({
      message: `Processed ${files.length} files: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (duplicates)`,
      results,
    });
  } catch (error: any) {
    console.error('Batch upload error:', error);
    res.status(500).json({ error: error.message || 'Batch upload failed' });
  }
});

// POST /api/uw-intelligence/batch-upload-async — Async batch upload with progress tracking
uwIntelligenceRoutes.post('/batch-upload-async', uploadMultiple as any, async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'At least one file is required' });
      return;
    }

    const fileData = files.map(f => ({ buffer: f.buffer, name: f.originalname }));
    const jobId = batchQueue.enqueue(fileData);

    res.status(202).json({
      jobId,
      message: `Batch job queued: ${files.length} files`,
      totalFiles: files.length,
    });
  } catch (error: any) {
    console.error('Async batch upload error:', error);
    res.status(500).json({ error: error.message || 'Batch upload failed' });
  }
});

// GET /api/uw-intelligence/batch-jobs/:jobId — Poll batch job status
uwIntelligenceRoutes.get('/batch-jobs/:jobId', (req: Request, res: Response) => {
  const job = getBatchJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Batch job not found' });
    return;
  }
  res.json({ job });
});

// GET /api/uw-intelligence/library — List all historical underwritings
uwIntelligenceRoutes.get('/library', (_req: Request, res: Response) => {
  const underwritings = listHistoricalUWs();
  res.json({ underwritings });
});

// GET /api/uw-intelligence/library/:id — Get single historical underwriting
uwIntelligenceRoutes.get('/library/:id', (req: Request, res: Response) => {
  const uw = getHistoricalUW(req.params.id);
  if (!uw) {
    res.status(404).json({ error: 'Historical underwriting not found' });
    return;
  }
  res.json({ underwriting: uw });
});

// GET /api/uw-intelligence/library/:id/download — Download original uploaded file
uwIntelligenceRoutes.get('/library/:id/download', (req: Request, res: Response) => {
  const file = getUploadedFile(req.params.id);
  if (!file) {
    res.status(404).json({ error: 'File not found — original file may not have been stored' });
    return;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Content-Type', file.mimeType);
  res.send(file.buffer);
});

// GET /api/uw-intelligence/library/:id/children — Get portfolio child records
uwIntelligenceRoutes.get('/library/:id/children', (req: Request, res: Response) => {
  const children = getPortfolioChildren(req.params.id);
  res.json({ children });
});

// PUT /api/uw-intelligence/library/:id — Update an underwriting record
uwIntelligenceRoutes.put('/library/:id', (req: Request, res: Response) => {
  const updated = updateHistoricalUW(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Historical underwriting not found' });
    return;
  }
  res.json({ underwriting: updated });
});

// DELETE /api/uw-intelligence/library/:id
uwIntelligenceRoutes.delete('/library/:id', (req: Request, res: Response) => {
  const deleted = deleteHistoricalUW(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Historical underwriting not found' });
    return;
  }
  res.json({ success: true });
});

// POST /api/uw-intelligence/re-extract — Re-extract narratives for all historical UWs
uwIntelligenceRoutes.post('/re-extract', async (_req: Request, res: Response) => {
  try {
    const result = await reExtractAllNarratives();
    res.json(result);
  } catch (error: any) {
    console.error('Re-extraction error:', error);
    res.status(500).json({ error: error.message || 'Re-extraction failed' });
  }
});

// ---------------------------------------------------------------------------
// Market Intelligence (aggregated market-level view)
// ---------------------------------------------------------------------------

// GET /api/uw-intelligence/market-intelligence — Market-level aggregated insights
uwIntelligenceRoutes.get('/market-intelligence', (req: Request, res: Response) => {
  const assetType = req.query.assetType as AssetType | undefined;
  const state = req.query.state as string | undefined;
  const city = req.query.city as string | undefined;
  const yearMin = req.query.yearMin ? parseInt(req.query.yearMin as string, 10) : undefined;
  const yearMax = req.query.yearMax ? parseInt(req.query.yearMax as string, 10) : undefined;

  const markets = computeMarketIntelligence({ assetType, state, city, yearMin, yearMax });
  res.json({ markets });
});

// ---------------------------------------------------------------------------
// Pattern Insights
// ---------------------------------------------------------------------------

// GET /api/uw-intelligence/insights — Aggregated pattern insights
uwIntelligenceRoutes.get('/insights', (req: Request, res: Response) => {
  const assetType = req.query.assetType as AssetType | undefined;
  const insights = computePatternInsights(assetType);
  res.json({ insights });
});

// GET /api/uw-intelligence/sufficiency — Check if enough data exists
uwIntelligenceRoutes.get('/sufficiency', (req: Request, res: Response) => {
  const assetType = req.query.assetType as AssetType | undefined;
  const result = getDataSufficiency(assetType);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Learned Rules
// ---------------------------------------------------------------------------

// GET /api/uw-intelligence/rules/metadata — Get rule recalculation metadata
uwIntelligenceRoutes.get('/rules/metadata', (_req: Request, res: Response) => {
  const metadata = getRuleMetadata();
  res.json({ metadata });
});

// POST /api/uw-intelligence/rules/generate — Recalculate rules from patterns + outcomes
uwIntelligenceRoutes.post('/rules/generate', (req: Request, res: Response) => {
  const assetType = req.body.assetType as AssetType | undefined;
  const sufficiency = getDataSufficiency(assetType);

  if (!sufficiency.sufficient) {
    res.status(400).json({
      error: 'Insufficient data for rule generation',
      ...sufficiency,
    });
    return;
  }

  const rules = generateRulesFromPatterns(assetType);
  res.json({ rules, count: rules.length });
});

// GET /api/uw-intelligence/rules — List learned rules
uwIntelligenceRoutes.get('/rules', (req: Request, res: Response) => {
  const assetType = req.query.assetType as AssetType | undefined;
  const rules = listLearnedRules(assetType);
  res.json({ rules });
});

// PUT /api/uw-intelligence/rules/:id — Update a rule (approve, reject, disable, edit)
uwIntelligenceRoutes.put('/rules/:id', (req: Request, res: Response) => {
  const updated = updateLearnedRule(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ rule: updated });
});

// DELETE /api/uw-intelligence/rules/:id
uwIntelligenceRoutes.delete('/rules/:id', (req: Request, res: Response) => {
  const deleted = deleteLearnedRule(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ success: true });
});

// GET /api/uw-intelligence/rules/:id/versions — Get version history for a rule
uwIntelligenceRoutes.get('/rules/:id/versions', (req: Request, res: Response) => {
  const versions = getRuleVersions(req.params.id);
  res.json({ versions });
});

// POST /api/uw-intelligence/rules/:id/rollback — Rollback a rule to a specific version
uwIntelligenceRoutes.post('/rules/:id/rollback', (req: Request, res: Response) => {
  const { version } = req.body;
  if (typeof version !== 'number') {
    res.status(400).json({ error: 'version (number) is required' });
    return;
  }
  const rule = rollbackRule(req.params.id, version);
  if (!rule) {
    res.status(404).json({ error: 'Rule or target version not found' });
    return;
  }
  res.json({ rule });
});

// ---------------------------------------------------------------------------
// Apply Intelligence
// ---------------------------------------------------------------------------

// POST /api/uw-intelligence/apply — Apply learned rules to a deal
uwIntelligenceRoutes.post('/apply', (req: Request, res: Response) => {
  const { assetType, dealInputs } = req.body;

  if (!assetType) {
    res.status(400).json({ error: 'assetType is required' });
    return;
  }

  const intelligence = applyIntelligence(assetType, dealInputs || {});
  res.json({ intelligence });
});

// ---------------------------------------------------------------------------
// Rejected Deals Upload
// ---------------------------------------------------------------------------

// POST /api/uw-intelligence/outcomes-upload — Upload an Excel of rejected/kicked deals
uwIntelligenceRoutes.post('/outcomes-upload', uploadSingle as any, (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Excel file is required' });
      return;
    }

    const result = ingestDealOutcomes(file.buffer, file.originalname);
    res.status(201).json(result);
  } catch (error: any) {
    console.error('Rejected deals upload error:', error);
    res.status(500).json({ error: error.message || 'Rejected deals upload failed' });
  }
});

// POST /api/uw-intelligence/outcomes-apply — Manually apply an outcome to a UW record
uwIntelligenceRoutes.post('/outcomes-apply', (req: Request, res: Response) => {
  const { uwId, outcome, kickReason, notes, sourceFileName, sourceRowId, matchScore } = req.body;

  if (!uwId || !outcome) {
    res.status(400).json({ error: 'uwId and outcome are required' });
    return;
  }

  if (!['approved', 'modified', 'rejected'].includes(outcome)) {
    res.status(400).json({ error: 'outcome must be approved, modified, or rejected' });
    return;
  }

  const success = applyOutcomeMatch(
    uwId, outcome, kickReason || null, notes || null,
    sourceFileName || undefined, sourceRowId || undefined, matchScore || undefined,
  );
  if (!success) {
    res.status(404).json({ error: 'Underwriting record not found' });
    return;
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Unmatched Outcomes
// ---------------------------------------------------------------------------

// GET /api/uw-intelligence/unmatched-outcomes — List unmatched outcome rows
uwIntelligenceRoutes.get('/unmatched-outcomes', (_req: Request, res: Response) => {
  const outcomes = listUnmatchedOutcomes();
  res.json({ outcomes });
});

// GET /api/uw-intelligence/unmatched-outcomes/:id — Get single unmatched outcome
uwIntelligenceRoutes.get('/unmatched-outcomes/:id', (req: Request, res: Response) => {
  const outcome = getUnmatchedOutcome(req.params.id);
  if (!outcome) {
    res.status(404).json({ error: 'Unmatched outcome not found' });
    return;
  }
  res.json({ outcome });
});

// POST /api/uw-intelligence/unmatched-outcomes/:id/link — Manually link to a UW record
uwIntelligenceRoutes.post('/unmatched-outcomes/:id/link', (req: Request, res: Response) => {
  const { uwId } = req.body;
  if (!uwId) {
    res.status(400).json({ error: 'uwId is required' });
    return;
  }

  const success = linkUnmatchedOutcome(req.params.id, uwId);
  if (!success) {
    res.status(404).json({ error: 'Unmatched outcome or underwriting record not found' });
    return;
  }
  res.json({ success: true });
});

// DELETE /api/uw-intelligence/unmatched-outcomes/:id — Remove an unmatched outcome
uwIntelligenceRoutes.delete('/unmatched-outcomes/:id', (req: Request, res: Response) => {
  const deleted = deleteUnmatchedOutcome(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Unmatched outcome not found' });
    return;
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Underwriting Template Management
// ---------------------------------------------------------------------------

// POST /api/uw-intelligence/templates — Upload a new template (or replace existing)
uwIntelligenceRoutes.post('/templates', uploadSingle as any, async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Upload failed – file not saved correctly. Please retry.' });
      return;
    }

    // Validate file extension (.xlsx only for templates)
    const ext = (file.originalname || '').toLowerCase().split('.').pop();
    if (!ext || !['xlsx', 'xlsm', 'xls'].includes(ext)) {
      res.status(400).json({ error: 'Only Excel files (.xlsx, .xlsm, .xls) are accepted for templates.' });
      return;
    }

    const templateType = req.body.templateType as TemplateType;
    if (!templateType || !['single_loan', 'roll_up'].includes(templateType)) {
      res.status(400).json({ error: 'templateType is required (single_loan or roll_up)' });
      return;
    }

    // Validate that the file is a readable Excel workbook
    let structure;
    try {
      structure = await analyzeTemplateStructure(file.buffer);
    } catch (parseErr: any) {
      res.status(400).json({
        error: `Upload failed – file could not be read as a valid Excel workbook. ${parseErr.message || 'Please retry with a valid .xlsx file.'}`,
      });
      return;
    }

    if (!structure.tabs || structure.tabs.length === 0) {
      res.status(400).json({ error: 'Upload failed – Excel file contains no worksheets.' });
      return;
    }

    const uploadedBy = req.body.uploadedBy || 'admin';

    const template = store.uploadTemplate(
      uuid(),
      templateType,
      file.originalname,
      file.buffer,
      uploadedBy,
      JSON.stringify(structure)
    );

    // Verify the file was persisted correctly
    const verify = store.getTemplateFile(template.id);
    if (!verify || !verify.fileData || verify.fileData.length === 0) {
      res.status(500).json({ error: 'Upload failed – file not saved correctly. Please retry.' });
      return;
    }

    res.status(201).json({
      template,
      structure,
      message: 'Template successfully uploaded and saved.',
    });
  } catch (error: any) {
    console.error('Template upload error:', error);
    res.status(500).json({ error: 'Upload failed – file not saved correctly. Please retry.' });
  }
});

// GET /api/uw-intelligence/templates — List all templates
uwIntelligenceRoutes.get('/templates', (req: Request, res: Response) => {
  const templateType = req.query.templateType as TemplateType | undefined;
  const templates = store.listTemplates(templateType);
  res.json({ templates });
});

// GET /api/uw-intelligence/templates/active/:templateType — Get the active template for a type
uwIntelligenceRoutes.get('/templates/active/:templateType', (req: Request, res: Response) => {
  const templateType = req.params.templateType as TemplateType;
  if (!['single_loan', 'roll_up'].includes(templateType)) {
    res.status(400).json({ error: 'Invalid template type' });
    return;
  }

  const template = store.getActiveTemplate(templateType);
  if (!template) {
    res.status(404).json({ error: `No ${templateType} template found. Please upload a template in Underwriting Insights.` });
    return;
  }

  // Return metadata only (not the file data)
  const { fileData, ...meta } = template;
  res.json({ template: meta });
});

// GET /api/uw-intelligence/templates/:id/download — Download template file
uwIntelligenceRoutes.get('/templates/:id/download', (req: Request, res: Response) => {
  const file = store.getTemplateFile(req.params.id);
  if (!file) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(file.fileData);
});

// GET /api/uw-intelligence/templates/:templateType/versions — Get version history
uwIntelligenceRoutes.get('/templates/:templateType/versions', (req: Request, res: Response) => {
  const templateType = req.params.templateType as TemplateType;
  if (!['single_loan', 'roll_up'].includes(templateType)) {
    res.status(400).json({ error: 'Invalid template type' });
    return;
  }

  const versions = store.getTemplateVersions(templateType);
  res.json({ versions });
});

// POST /api/uw-intelligence/templates/:id/activate — Activate a specific template version
uwIntelligenceRoutes.post('/templates/:id/activate', (req: Request, res: Response) => {
  const success = store.activateTemplateVersion(req.params.id);
  if (!success) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ success: true });
});

// DELETE /api/uw-intelligence/templates/:id
uwIntelligenceRoutes.delete('/templates/:id', (req: Request, res: Response) => {
  const deleted = store.deleteTemplate(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ success: true });
});
