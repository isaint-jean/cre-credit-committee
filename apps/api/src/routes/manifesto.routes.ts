import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload.js';
import { store } from '../storage/sqlite-store.js';
import { processManifestoUpload } from '../services/manifesto.service.js';
import { compareManifestoVersions } from '../services/version-control.service.js';

export const manifestoRoutes = Router();

// POST /api/manifesto/upload — Upload a new credit manifesto
manifestoRoutes.post('/upload', upload.single('file') as any, async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Manifesto file is required' });
      return;
    }

    const ext = (file.originalname || '').toLowerCase().split('.').pop();
    if (!ext || !['pdf', 'docx', 'txt'].includes(ext)) {
      res.status(400).json({ error: 'Only PDF, DOCX, and TXT files are accepted.' });
      return;
    }

    const uploadedBy = req.body.uploadedBy || 'admin';

    const { id, version } = await processManifestoUpload(
      file.buffer,
      file.originalname,
      file.mimetype,
      uploadedBy,
    );

    res.status(201).json({
      id,
      version,
      status: 'processing',
      message: 'Manifesto uploaded. Rule extraction in progress.',
    });
  } catch (error: any) {
    console.error('Manifesto upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// GET /api/manifesto/active — Get the currently active manifesto
manifestoRoutes.get('/active', (_req: Request, res: Response) => {
  const manifesto = store.getActiveManifesto();
  if (!manifesto) {
    res.status(404).json({ error: 'No active credit manifesto', hasManifesto: false });
    return;
  }
  const { rawText, ...rest } = manifesto;
  res.json({ manifesto: rest, hasManifesto: true });
});

// GET /api/manifesto/history — List all uploaded manifestos
manifestoRoutes.get('/history', (_req: Request, res: Response) => {
  const manifestos = store.listManifestos();
  res.json({ manifestos });
});

// GET /api/manifesto/compare — Compare two manifesto versions (must be before /:id)
manifestoRoutes.get('/compare', (req: Request, res: Response) => {
  const baseId = req.query.base as string;
  const compareId = req.query.compare as string;

  if (!baseId || !compareId) {
    res.status(400).json({ error: 'Both base and compare query parameters are required' });
    return;
  }

  const diff = compareManifestoVersions(baseId, compareId);
  if (!diff) {
    res.status(404).json({ error: 'One or both manifesto versions not found' });
    return;
  }

  res.json({ diff });
});

// GET /api/manifesto/:id/status — Poll processing status
manifestoRoutes.get('/:id/status', (req: Request, res: Response) => {
  const manifesto = store.getManifesto(req.params.id);
  if (!manifesto) {
    res.status(404).json({ error: 'Manifesto not found' });
    return;
  }
  res.json({
    id: manifesto.id,
    status: manifesto.status,
    extractedRulesCount: manifesto.extractedRulesCount,
    ambiguitiesCount: manifesto.ambiguitiesCount,
    error: manifesto.error,
  });
});

// GET /api/manifesto/:id — Get a specific manifesto
manifestoRoutes.get('/:id', (req: Request, res: Response) => {
  const manifesto = store.getManifesto(req.params.id);
  if (!manifesto) {
    res.status(404).json({ error: 'Manifesto not found' });
    return;
  }
  const { rawText, ...rest } = manifesto;
  res.json({ manifesto: rest });
});

// POST /api/manifesto/:id/activate — Re-activate an older manifesto version
manifestoRoutes.post('/:id/activate', (req: Request, res: Response) => {
  const manifesto = store.getManifesto(req.params.id);
  if (!manifesto) {
    res.status(404).json({ error: 'Manifesto not found' });
    return;
  }
  if (manifesto.status === 'error') {
    res.status(400).json({ error: 'Cannot activate a manifesto that failed processing.' });
    return;
  }
  if (manifesto.status === 'processing') {
    res.status(400).json({ error: 'Manifesto is still processing. Wait for completion.' });
    return;
  }

  // Re-activate: deactivate all others, set this one active
  store.activateManifesto(
    manifesto.id,
    JSON.stringify(manifesto.extractedRules),
    JSON.stringify(manifesto.ambiguities),
    JSON.stringify(manifesto.assetTypesCovered),
    manifesto.scoringWeights ? JSON.stringify(manifesto.scoringWeights) : null,
  );

  res.json({ success: true, message: `Manifesto v${manifesto.version} activated.` });
});
