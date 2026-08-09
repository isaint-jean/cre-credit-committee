/**
 * Deal-access enforcement (Chunk 3b) — SHIPPED DARK behind a feature flag.
 *
 * ★ DEAL_ACCESS_ENFORCEMENT (env, default OFF). While off, EVERY function here is a
 *   pure pass-through NO-OP — the sweep changes NOTHING live until the flag is
 *   flipped (after the deployed-DB backfill). Read live from process.env so it is
 *   togglable per-process (and per-test).
 *
 * Boundary-only, mirrors enforcePermission: authenticate + role gate (elsewhere),
 * then THIS gates by data ownership. ADMIN always bypasses (explicit, tested).
 *
 * Access grains:
 *   - POOL  (data-room + pool workspace): direct 'pool' grant in deal_access.
 *   - DEAL  (analyses/render/workflow): direct 'deal' grant, OR derived — a pool
 *           the user can access whose loans resolve to this deal's lineageRoot.
 *
 * ⚠ DERIVATION CAVEAT: pool→deal derivation relies on loan_in_pool.deal_ref matching
 *   extraction_results.deal_ref. That namespace is INCONSISTENT in the current data
 *   (e.g. a pool loan's 'bmark2024v8-sunroad-centrum' vs extraction 'SUNROAD-CENTRUM-
 *   REAL'), so derivation can UNDER-resolve. Direct grants (backfill + the 3d invite
 *   flow granting explicit deal rows) are the reliable path; validate derivation
 *   before flipping the flag on. Under-resolution DENIES (fail-closed), never leaks.
 */
import type { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { dealAccessStore } from '../storage/deal-access-store.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

/** Live read of the dark-ship flag. Default OFF. */
export function dealAccessEnforcementEnabled(): boolean {
  return process.env.DEAL_ACCESS_ENFORCEMENT === 'true';
}

// Lazy read-only connection for RESOLUTION queries only (deal keys, pool→deal
// chain). Grants come from dealAccessStore(); this never writes.
let _read: Database.Database | null = null;
function read(): Database.Database {
  if (!_read) _read = new Database(DB_PATH, { readonly: true });
  return _read;
}
/** Test seam — inject the resolution read-db (proofs). Pass null to reset. */
export function setDealAccessReadDb(db: Database.Database | null): void {
  _read = db;
}

function isAdmin(role: string | undefined): boolean {
  return typeof role === 'string' && role.toUpperCase() === 'ADMIN';
}

// ── resolvers ──────────────────────────────────────────────────────────────

/** An analysis id (uuid OR 64-hex lineageRoot) → its lineageRootId (the deal key). */
export function resolveAnalysisLineageRoot(id: string): string | null {
  const byId = read().prepare(`SELECT lineage_root_id AS r FROM analyses WHERE id = ?`).get(id) as { r: string } | undefined;
  if (byId?.r) return byId.r;
  // id may already be a lineage root (graph root or a root analysis id).
  const asRoot =
    read().prepare(`SELECT 1 FROM analyses WHERE lineage_root_id = ? LIMIT 1`).get(id) ??
    read().prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE lineage_root_id = ? LIMIT 1`).get(id);
  return asRoot ? id : null;
}

/** A Spine-B rootId (DoctrineEvaluationId or lineageRoot) → its lineageRootId. */
export function resolveRootLineageRoot(rootId: string): string | null {
  const byEval = read()
    .prepare(`SELECT lineage_root_id AS r FROM revision_lineage_envelopes WHERE doctrine_evaluation_id = ? LIMIT 1`)
    .get(rootId) as { r: string } | undefined;
  if (byEval?.r) return byEval.r;
  const asRoot = read().prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE lineage_root_id = ? LIMIT 1`).get(rootId);
  return asRoot ? rootId : null;
}

/** Graph lineage roots reachable from a pool's loans (best-effort dealRef chain). */
export function dealRootsForPool(poolId: string): Set<string> {
  const rows = read()
    .prepare(
      `SELECT DISTINCT rle.lineage_root_id AS root
         FROM loan_in_pool lip
         JOIN extraction_results er        ON er.deal_ref = lip.deal_ref
         JOIN doctrine_evaluations de      ON de.extraction_result_id = er.id
         JOIN revision_lineage_envelopes rle ON rle.doctrine_evaluation_id = de.id
        WHERE lip.pool_id = ?`,
    )
    .all(poolId) as Array<{ root: string }>;
  return new Set(rows.map((r) => r.root));
}

// ── access predicates ────────────────────────────────────────────────────────

export function canAccessPool(userId: string, role: string | undefined, poolId: string): boolean {
  if (!dealAccessEnforcementEnabled()) return true; // dark: allow all
  if (isAdmin(role)) return true;
  return dealAccessStore().has('pool', poolId, userId);
}

export function canAccessDeal(userId: string, role: string | undefined, lineageRootId: string): boolean {
  if (!dealAccessEnforcementEnabled()) return true; // dark: allow all
  if (isAdmin(role)) return true;
  if (dealAccessStore().has('deal', lineageRootId, userId)) return true;
  // Derivation: a pool the user can access whose loans resolve to this deal.
  for (const g of dealAccessStore().listForUser(userId)) {
    if (g.resourceType === 'pool' && dealRootsForPool(g.resourceKey).has(lineageRootId)) return true;
  }
  return false;
}

// ── express wiring ───────────────────────────────────────────────────────────

function denyDeal(res: Response, extra: Record<string, unknown>): void {
  res.status(403).json({ error: 'DEAL_ACCESS_DENIED', ...extra });
}

/** router.param('poolId', …) — gates every :poolId route (pool + data-room) by
 *  POOL access. Pure pass-through when the flag is off. */
export function enforcePoolParam(req: Request, res: Response, next: NextFunction, poolId: string): void {
  if (!dealAccessEnforcementEnabled()) return next();
  const u = req.user;
  if (!u) { res.status(401).json({ error: 'Authentication required' }); return; }
  if (canAccessPool(u.userId, u.role, poolId)) return next();
  denyDeal(res, { resource: 'pool', poolId });
}

/** router.param('id', …) on the analyses router — resolves the id → lineageRoot,
 *  gates by DEAL access. Pure pass-through when the flag is off. */
export function enforceAnalysisParam(req: Request, res: Response, next: NextFunction, id: string): void {
  if (!dealAccessEnforcementEnabled()) return next();
  const u = req.user;
  if (!u) { res.status(401).json({ error: 'Authentication required' }); return; }
  const root = resolveAnalysisLineageRoot(id);
  if (root && canAccessDeal(u.userId, u.role, root)) return next();
  denyDeal(res, { resource: 'deal', id }); // fail-closed if unresolvable
}

/** Inline gate for Spine-B ?rootId= handlers (workflow/committee/render). Returns
 *  true to proceed. Pass-through when the flag is off. */
export function enforceDealForRoot(req: Request, res: Response, rootId: string): boolean {
  if (!dealAccessEnforcementEnabled()) return true;
  const u = req.user;
  if (!u) { res.status(401).json({ error: 'Authentication required' }); return false; }
  const root = resolveRootLineageRoot(rootId);
  if (root && canAccessDeal(u.userId, u.role, root)) return true;
  denyDeal(res, { resource: 'deal', rootId });
  return false;
}

// ── list filters (per-ROW, never a blanket 403) ──────────────────────────────

/** Filter an analyses list to the rows the user may see. Pass-through when off/admin. */
export function filterAccessibleAnalyses<T>(req: Request, items: readonly T[], rootOf: (it: T) => string | null | undefined): T[] {
  if (!dealAccessEnforcementEnabled()) return [...items];
  const u = req.user;
  if (!u || isAdmin(u.role)) return [...items];
  return items.filter((it) => {
    const r = rootOf(it);
    return typeof r === 'string' && canAccessDeal(u.userId, u.role, r);
  });
}

/** Filter a pools list to the pools the user may see. Pass-through when off/admin. */
export function filterAccessiblePools<T>(req: Request, items: readonly T[], poolIdOf: (it: T) => string): T[] {
  if (!dealAccessEnforcementEnabled()) return [...items];
  const u = req.user;
  if (!u || isAdmin(u.role)) return [...items];
  return items.filter((it) => canAccessPool(u.userId, u.role, poolIdOf(it)));
}
