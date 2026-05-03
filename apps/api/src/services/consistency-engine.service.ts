import crypto from 'crypto';
import { store } from '../storage/sqlite-store.js';
import type { AssetType } from '@cre/shared';

/**
 * Bump this constant whenever pipeline logic changes materially:
 * - AI prompt changes
 * - New pipeline steps added/removed
 * - Scoring formula or weight changes
 * - Stress test defaults change
 */
export const MODEL_LOGIC_VERSION = '1.0.0';

export const MODEL_LOGIC_CHANGELOG: { version: string; date: string; description: string; changes: string[] }[] = [
  {
    version: '1.0.0',
    date: '2026-05-02',
    description: 'Initial release',
    changes: [
      '10-step analysis pipeline with document parsing, cross-validation, research, findings extraction, UW reconstruction, template population, intelligence application, stress testing, credit scoring, and B-piece decision',
      'Severity-based scoring: critical (-22.5), high (-15), medium (-7.5), low (-3) deductions',
      'Weighted category scoring: cash_flow (25%), leasing (20%), market (15%), sponsor (15%), loan_structure (15%), expense (10%)',
      'Risk tiers: strong (85+), acceptable (70-84), watchlist (50-69), high_risk (<50)',
      'Mandatory validation layer with 5 check categories before output release',
    ],
  },
];

/**
 * Register the current model logic version in the database on startup.
 * Call this from the server initialization.
 */
export function registerCurrentModelVersion(): void {
  const current = MODEL_LOGIC_CHANGELOG.find(v => v.version === MODEL_LOGIC_VERSION);
  if (current) {
    store.registerModelLogicVersion(current.version, current.description, current.changes);
  }
}

export interface HashComponents {
  asrHash: string;
  uwHash: string | null;
  supportingDocsHash: string;
  templateHash: string | null;
  assetType: AssetType;
  manifestoVersion: string;
  modelLogicVersion: string;
}

export interface CacheCheckResult {
  hit: boolean;
  analysisId: string | null;
  inputHash: string;
  components: HashComponents;
}

// --- Hashing ---

export function computeFileHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function computeManifestoVersion(assetType: AssetType): string {
  const criteria = store.getCriteria(assetType);
  if (!criteria) return 'no-criteria';

  // Include active manifesto ID so uploads automatically invalidate cache
  const manifestoRow = store.getActiveManifesto();
  const manifestoId = manifestoRow?.id || 'no-manifesto';

  // Deterministic serialization: sort rules by id before hashing
  const sortedRules = [...criteria.rules].sort((a, b) => a.id.localeCompare(b.id));
  const payload = JSON.stringify({
    manifestoId,
    rules: sortedRules,
    scoringWeights: criteria.scoringWeights,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// --- Composite Hash ---

export function computeCompositeHash(
  asrBuffer: Buffer,
  assetType: AssetType,
  uwBuffer?: Buffer,
  supportingDocs?: { buffer: Buffer; name: string }[],
  templateBuffer?: Buffer,
): CacheCheckResult {
  const asrHash = computeFileHash(asrBuffer);
  const uwHash = uwBuffer ? computeFileHash(uwBuffer) : null;

  // Sort supporting docs by filename for order-independence
  const sortedDocs = (supportingDocs || [])
    .sort((a, b) => a.name.localeCompare(b.name));
  const docsConcat = sortedDocs.length > 0
    ? sortedDocs.map(d => computeFileHash(d.buffer) + ':' + d.name).join('|')
    : '';
  const supportingDocsHash = crypto.createHash('sha256').update(docsConcat).digest('hex');

  const templateHash = templateBuffer ? computeFileHash(templateBuffer) : null;
  const manifestoVersion = computeManifestoVersion(assetType);

  const components: HashComponents = {
    asrHash,
    uwHash,
    supportingDocsHash,
    templateHash,
    assetType,
    manifestoVersion,
    modelLogicVersion: MODEL_LOGIC_VERSION,
  };

  // Build composite hash from all components
  const compositePayload = [
    asrHash,
    uwHash || 'none',
    supportingDocsHash,
    templateHash || 'none',
    assetType,
    manifestoVersion,
    MODEL_LOGIC_VERSION,
  ].join('::');

  const inputHash = crypto.createHash('sha256').update(compositePayload).digest('hex');

  // Check cache
  const cached = store.getCacheEntry(inputHash);

  // Debug logging
  console.log(`[ConsistencyEngine] Hash: ${inputHash.substring(0, 16)}...`);
  console.log(`[ConsistencyEngine]   ASR: ${asrHash.substring(0, 12)}...`);
  console.log(`[ConsistencyEngine]   UW: ${uwHash ? uwHash.substring(0, 12) + '...' : 'none'}`);
  console.log(`[ConsistencyEngine]   Docs: ${supportingDocsHash.substring(0, 12)}... (${sortedDocs.length} file(s))`);
  console.log(`[ConsistencyEngine]   Template: ${templateHash ? templateHash.substring(0, 12) + '...' : 'none'}`);
  console.log(`[ConsistencyEngine]   Asset Type: ${assetType}`);
  console.log(`[ConsistencyEngine]   Manifesto: ${manifestoVersion.substring(0, 12)}...`);
  console.log(`[ConsistencyEngine]   Model: ${MODEL_LOGIC_VERSION}`);
  console.log(`[ConsistencyEngine]   Result: ${cached ? 'CACHE HIT -> analysis ' + cached.analysisId : 'CACHE MISS — running full pipeline'}`);

  return {
    hit: !!cached,
    analysisId: cached?.analysisId || null,
    inputHash,
    components,
  };
}

// --- Cache Recording ---

export function recordCacheEntry(inputHash: string, analysisId: string, components: HashComponents): void {
  store.createCacheEntry(inputHash, analysisId, JSON.stringify(components));
  console.log(`[ConsistencyEngine] Cached: ${inputHash.substring(0, 16)}... -> analysis ${analysisId}`);
}

// --- Cache Invalidation ---

export function invalidateCacheForAssetType(assetType: AssetType): number {
  const count = store.invalidateCacheByAssetType(assetType);
  if (count > 0) {
    console.log(`[ConsistencyEngine] Invalidated ${count} cache entries for asset type: ${assetType}`);
  }
  return count;
}
