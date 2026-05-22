/**
 * GET /api/kicks            — paginated, filterable, sortable list of kicks.
 * GET /api/kicks/facets     — filter-dropdown values (asset types, states,
 *                              vintages, top sponsors, top MSAs).
 *
 * Auth: requireAuth at the mount point. Any authenticated role can read.
 *
 * Backs the /admin/kicks page (#34 follow-up). The kicks_registry table is
 * institutional memory per CRE Credit Handbook §III; this route surfaces it
 * for analyst consultation. Today reads only — no write endpoints.
 */

import { Router, type Request, type Response } from 'express';
import { ASSET_TYPES, type AssetType } from '@cre/contracts';
import {
  KICK_SORT_COLUMNS,
  kicksRegistryStore,
  type KickSortColumn,
} from '../storage/kicks-registry-store.js';

const ASSET_TYPE_SET = new Set<string>(ASSET_TYPES);
const SORT_COL_SET = new Set<string>(KICK_SORT_COLUMNS);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export const kicksRoutes = Router();

/** Parse a comma-separated or multi-value-repeated query parameter into an
 *  array of canonical AssetType values. Unknown values are dropped silently
 *  (the caller validates that AT LEAST one is left, if any were passed). */
function parseAssetTypesParam(raw: unknown): AssetType[] {
  if (raw === undefined || raw === null) return [];
  const values: string[] = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
  return values
    .map((v) => v.trim())
    .filter((v) => ASSET_TYPE_SET.has(v))
    .map((v) => v as AssetType);
}

function parseIntParam(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function parseStringParam(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s === '' ? undefined : s;
}

function parseBoolParam(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
}

kicksRoutes.get('/', (req: Request, res: Response): void => {
  const assetTypes = parseAssetTypesParam(req.query.assetType);
  const state = parseStringParam(req.query.state);
  const msa = parseStringParam(req.query.msa);
  const sponsor = parseStringParam(req.query.sponsor);
  const vintage = parseIntParam(req.query.vintage);
  const singleTenant = parseBoolParam(req.query.singleTenant);
  const search = parseStringParam(req.query.search);

  const sortByRaw = parseStringParam(req.query.sortBy);
  const sortBy: KickSortColumn = sortByRaw !== undefined && SORT_COL_SET.has(sortByRaw)
    ? (sortByRaw as KickSortColumn)
    : 'imported_at';
  const sortDirRaw = parseStringParam(req.query.sortDir);
  const sortDir: 'asc' | 'desc' = sortDirRaw === 'asc' ? 'asc' : 'desc';

  const pageRaw = parseIntParam(req.query.page);
  const page = pageRaw !== undefined && pageRaw >= 1 ? pageRaw : 1;
  const pageSizeRaw = parseIntParam(req.query.pageSize);
  const pageSize = pageSizeRaw !== undefined && pageSizeRaw > 0
    ? Math.min(pageSizeRaw, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const result = kicksRegistryStore.query({
    assetTypes: assetTypes.length > 0 ? assetTypes : undefined,
    state,
    msa,
    sponsor,
    vintage,
    singleTenant,
    search,
    sortBy,
    sortDir,
    page,
    pageSize,
  });

  res.json(result);
});

kicksRoutes.get('/facets', (_req: Request, res: Response): void => {
  res.json({
    assetTypes: kicksRegistryStore.distinctAssetTypes(),
    states: kicksRegistryStore.distinctStates(),
    vintages: kicksRegistryStore.distinctVintages(),
    topSponsors: kicksRegistryStore.topSponsors(50),
    topMsas: kicksRegistryStore.topMsas(50),
  });
});
