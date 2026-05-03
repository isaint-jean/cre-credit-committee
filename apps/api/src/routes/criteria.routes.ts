import { Router, Request, Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import { AssetType } from '@cre/shared';
import { CriteriaRule } from '@cre/shared';
import { invalidateCacheForAssetType } from '../services/consistency-engine.service.js';
import { v4 as uuid } from 'uuid';

export const criteriaRoutes = Router();

// GET /api/criteria/:assetType
criteriaRoutes.get('/:assetType', (req: Request, res: Response) => {
  const assetType = req.params.assetType as AssetType;
  const criteria = store.getCriteria(assetType);
  if (!criteria) {
    res.status(404).json({ error: 'Criteria not found for asset type' });
    return;
  }
  res.json({ criteria });
});

// POST /api/criteria/:assetType — Add new rule
criteriaRoutes.post('/:assetType', (req: Request, res: Response) => {
  const assetType = req.params.assetType as AssetType;
  const criteria = store.getCriteria(assetType);
  if (!criteria) {
    res.status(404).json({ error: 'Criteria not found for asset type' });
    return;
  }

  const newRule: CriteriaRule = {
    id: uuid(),
    assetType,
    category: req.body.category,
    name: req.body.name,
    description: req.body.description,
    condition: req.body.condition,
    threshold: req.body.threshold,
    severity: req.body.severity,
    weight: req.body.weight || 5,
    enabled: req.body.enabled !== false,
  };

  criteria.rules.push(newRule);
  store.updateCriteria(assetType, criteria);
  invalidateCacheForAssetType(assetType);
  res.status(201).json({ rule: newRule });
});

// PUT /api/criteria/:assetType/:id — Update rule
criteriaRoutes.put('/:assetType/:id', (req: Request, res: Response) => {
  const assetType = req.params.assetType as AssetType;
  const criteria = store.getCriteria(assetType);
  if (!criteria) {
    res.status(404).json({ error: 'Criteria not found' });
    return;
  }

  const idx = criteria.rules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  criteria.rules[idx] = { ...criteria.rules[idx], ...req.body, id: req.params.id, assetType };
  store.updateCriteria(assetType, criteria);
  invalidateCacheForAssetType(assetType);
  res.json({ rule: criteria.rules[idx] });
});

// DELETE /api/criteria/:assetType/:id
criteriaRoutes.delete('/:assetType/:id', (req: Request, res: Response) => {
  const assetType = req.params.assetType as AssetType;
  const criteria = store.getCriteria(assetType);
  if (!criteria) {
    res.status(404).json({ error: 'Criteria not found' });
    return;
  }

  criteria.rules = criteria.rules.filter((r) => r.id !== req.params.id);
  store.updateCriteria(assetType, criteria);
  invalidateCacheForAssetType(assetType);
  res.json({ success: true });
});

// PUT /api/criteria/:assetType/weights — Update scoring weights
criteriaRoutes.put('/:assetType/weights', (req: Request, res: Response) => {
  const assetType = req.params.assetType as AssetType;
  const criteria = store.getCriteria(assetType);
  if (!criteria) {
    res.status(404).json({ error: 'Criteria not found' });
    return;
  }

  criteria.scoringWeights = { ...criteria.scoringWeights, ...req.body };
  store.updateCriteria(assetType, criteria);
  invalidateCacheForAssetType(assetType);
  res.json({ scoringWeights: criteria.scoringWeights });
});
