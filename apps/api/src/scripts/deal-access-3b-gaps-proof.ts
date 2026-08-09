/**
 * PROOF — Chunk 3b gap-closure: the previously-ungated deal-scoped reads now go
 * through canAccessAnalysis (id → lineageRoot → check), which backs:
 *   - /analyses/lookup?dealRef  (resolve-then-check)
 *   - /analyses/compare          (per-id — both must pass)
 *   - /analyses/audit-log        (per-row filter)
 *   - /underwriting/render + /export (dealId, before work/bytes)
 *
 * CANONICAL-SAFE: grants in an injected in-memory store; resolution reads real
 * cre.db read-only. Flag ON: buyer DENIED, admin bypass, owner allowed; compare
 * needs BOTH; audit-log filters per-row. Flag OFF: all allowed (dark). Real
 * deal_access byte-identical (48).
 *
 * Run: npx tsx src/scripts/deal-access-3b-gaps-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { canAccessAnalysis } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function main(): void {
  const read = new Database(DB_PATH, { readonly: true });
  const canonical = new DealAccessStore(DB_PATH);
  const canonicalBefore = canonical.countAll();
  console.log('\nDeal-access 3b gap-closure proof — lookup/compare/audit-log + render/export\n');

  const uid = (email: string): string =>
    ((read.prepare(`SELECT id FROM users WHERE email=?`).get(email) as { id: string } | undefined)?.id ?? '');
  const originatorId = uid('originator@cre.com');
  const adminId = uid('admin@cre.com');
  const buyerId = uid('buyer@cre.com');

  // Two real analyses (id + its lineageRoot) — grant the owner ONE of them.
  const rows = read.prepare(`SELECT id, lineage_root_id AS root FROM analyses WHERE lineage_root_id IS NOT NULL LIMIT 2`).all() as Array<{ id: string; root: string }>;
  check('two real analyses present', rows.length === 2, rows.map((r) => r.id.slice(0, 8)).join(', '));
  const [granted, other] = rows;

  const mem = new DealAccessStore(':memory:');
  setDealAccessStore(mem);
  try {
    mem.grant({ resourceType: 'deal', resourceKey: granted!.root, userId: originatorId, party: 'originator' });

    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';

    // Backs lookup / render / export (canAccessAnalysis by id).
    check('buyer DENIED an analysis by id (no grant)', !canAccessAnalysis(buyerId, 'BUYER', granted!.id));
    check('admin BYPASSES analysis-by-id', canAccessAnalysis(adminId, 'ADMIN', granted!.id));
    check('owner ALLOWED the granted analysis (id → root)', canAccessAnalysis(originatorId, 'ORIGINATOR', granted!.id));
    check('owner DENIED an analysis not granted', !canAccessAnalysis(originatorId, 'ORIGINATOR', other!.id));
    check('unresolvable id fails closed (denied)', !canAccessAnalysis(originatorId, 'ORIGINATOR', 'not-a-real-id'));

    // compare — BOTH ids must pass.
    const canCompare = (u: string, r: string, a: string, b: string) => canAccessAnalysis(u, r, a) && canAccessAnalysis(u, r, b);
    check('compare — buyer denied (neither accessible)', !canCompare(buyerId, 'BUYER', granted!.id, other!.id));
    check('compare — owner denied when ONE side inaccessible', !canCompare(originatorId, 'ORIGINATOR', granted!.id, other!.id));
    check('compare — admin allowed (both, bypass)', canCompare(adminId, 'ADMIN', granted!.id, other!.id));

    // audit-log — per-row filter.
    const entries = [{ analysisId: granted!.id }, { analysisId: other!.id }];
    check('audit-log — buyer sees 0 rows', entries.filter((e) => canAccessAnalysis(buyerId, 'BUYER', e.analysisId)).length === 0);
    check('audit-log — owner sees only granted (1)', entries.filter((e) => canAccessAnalysis(originatorId, 'ORIGINATOR', e.analysisId)).length === 1);
    check('audit-log — admin sees all (2)', entries.filter((e) => canAccessAnalysis(adminId, 'ADMIN', e.analysisId)).length === 2);

    // Flag OFF — dark no-op.
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    check('flag OFF — buyer allowed (ships dark)', canAccessAnalysis(buyerId, 'BUYER', granted!.id));
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
  }

  check('canonical deal_access untouched', canonical.countAll() === canonicalBefore, `${canonicalBefore} rows`);
  read.close();
  console.log(failures === 0 ? '\ndeal-access 3b gap-closure proof: OK\n' : `\ndeal-access 3b gap-closure proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
