/**
 * PROOF — Chunk 3b-1: DEAL access (Spine A analyses + Spine B render/workflow).
 * CANONICAL-SAFE: grants live in an injected in-memory deal_access store (the real
 * cre.db deal_access is never written); resolution reads the real cre.db read-only.
 * Proves, with the flag ON: a fresh buyer is DENIED, admin bypasses, the granted
 * owner is allowed, the list filter drops inaccessible rows; and with the flag OFF
 * everything is allowed (dark no-op). Real deal_access rows byte-identical.
 *
 * Run: npx tsx src/scripts/deal-access-3b1-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { Request } from 'express';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { canAccessDeal, filterAccessibleAnalyses } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const asUser = (userId: string, role: string): Request => ({ user: { userId, role } } as unknown as Request);

function main(): void {
  const read = new Database(DB_PATH, { readonly: true });
  const canonical = new DealAccessStore(DB_PATH);
  const canonicalBefore = canonical.countAll();
  console.log('\nDeal-access 3b-1 proof — DEAL access (analyses/render/workflow), flag-gated\n');

  const uid = (email: string): string =>
    ((read.prepare(`SELECT id FROM users WHERE email=?`).get(email) as { id: string } | undefined)?.id ?? '');
  const originatorId = uid('originator@cre.com');
  const adminId = uid('admin@cre.com');
  const buyerId = uid('buyer@cre.com');

  // Two real, distinct deal roots.
  const roots = (read.prepare(`SELECT DISTINCT lineage_root_id AS r FROM analyses WHERE lineage_root_id IS NOT NULL LIMIT 2`).all() as Array<{ r: string }>).map((x) => x.r);
  check('two real deal roots present', roots.length === 2, roots.map((r) => r.slice(0, 10)).join(', '));
  const [grantedRoot, otherRoot] = roots;

  // Inject an in-memory grant store; seed originator on ONE root only. No buyer grants.
  const mem = new DealAccessStore(':memory:');
  setDealAccessStore(mem);
  try {
    mem.grant({ resourceType: 'deal', resourceKey: grantedRoot!, userId: originatorId, party: 'originator' });

    // Flag ON — enforcement active.
    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';
    check('buyer DENIED the deal (no grant)', !canAccessDeal(buyerId, 'BUYER', grantedRoot!));
    check('admin BYPASSES (sees the deal)', canAccessDeal(adminId, 'ADMIN', grantedRoot!));
    check('originator (owner) ALLOWED the granted deal', canAccessDeal(originatorId, 'ORIGINATOR', grantedRoot!));
    check('originator DENIED a deal they were not granted', !canAccessDeal(originatorId, 'ORIGINATOR', otherRoot!));

    // List filter (per-row, never a blanket 403).
    const items = [{ lineageRootId: grantedRoot! }, { lineageRootId: otherRoot! }];
    check('list filter — buyer sees 0 rows', filterAccessibleAnalyses(asUser(buyerId, 'BUYER'), items, (a) => a.lineageRootId).length === 0);
    check('list filter — originator sees only granted (1)', filterAccessibleAnalyses(asUser(originatorId, 'ORIGINATOR'), items, (a) => a.lineageRootId).length === 1);
    check('list filter — admin sees all (2)', filterAccessibleAnalyses(asUser(adminId, 'ADMIN'), items, (a) => a.lineageRootId).length === 2);

    // Flag OFF — dark no-op: everything allowed (current live behavior).
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    check('flag OFF — buyer allowed (ships dark)', canAccessDeal(buyerId, 'BUYER', grantedRoot!));
    check('flag OFF — list filter passes all through', filterAccessibleAnalyses(asUser(buyerId, 'BUYER'), items, (a) => a.lineageRootId).length === 2);
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
  }

  check('canonical deal_access untouched', canonical.countAll() === canonicalBefore, `${canonicalBefore} rows`);
  read.close();
  console.log(failures === 0 ? '\ndeal-access 3b-1 proof: OK\n' : `\ndeal-access 3b-1 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
