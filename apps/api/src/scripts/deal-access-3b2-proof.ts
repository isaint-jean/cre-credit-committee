/**
 * PROOF — Chunk 3b-2: POOL access (Spine C pool workspace). CANONICAL-SAFE (grants
 * in an in-memory store; real cre.db untouched). Flag ON: fresh buyer DENIED the
 * pool, admin bypass, granted originator allowed, list filter drops inaccessible
 * pools. Flag OFF: all allowed (dark no-op).
 *
 * Run: npx tsx src/scripts/deal-access-3b2-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { Request } from 'express';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { canAccessPool, filterAccessiblePools } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';
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
  console.log('\nDeal-access 3b-2 proof — POOL access (pools workspace), flag-gated\n');

  const uid = (email: string): string =>
    ((read.prepare(`SELECT id FROM users WHERE email=?`).get(email) as { id: string } | undefined)?.id ?? '');
  const originatorId = uid('originator@cre.com');
  const adminId = uid('admin@cre.com');
  const buyerId = uid('buyer@cre.com');

  const pools = (read.prepare(`SELECT id FROM pool`).all() as Array<{ id: string }>).map((p) => p.id);
  check('pools present (incl. BMARK)', pools.includes(BMARK), `${pools.length} pools`);
  const otherPool = pools.find((p) => p !== BMARK) ?? '__none__';

  const mem = new DealAccessStore(':memory:');
  setDealAccessStore(mem);
  try {
    mem.grant({ resourceType: 'pool', resourceKey: BMARK, userId: originatorId, party: 'originator' });

    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';
    check('buyer DENIED BMARK pool (no grant)', !canAccessPool(buyerId, 'BUYER', BMARK));
    check('admin BYPASSES the pool', canAccessPool(adminId, 'ADMIN', BMARK));
    check('originator (owner) ALLOWED BMARK', canAccessPool(originatorId, 'ORIGINATOR', BMARK));
    check('originator DENIED a pool not granted', otherPool === '__none__' || !canAccessPool(originatorId, 'ORIGINATOR', otherPool));

    const items = pools.map((id) => ({ id }));
    check('list filter — buyer sees 0 pools', filterAccessiblePools(asUser(buyerId, 'BUYER'), items, (p) => p.id).length === 0);
    check('list filter — originator sees only BMARK (1)', filterAccessiblePools(asUser(originatorId, 'ORIGINATOR'), items, (p) => p.id).length === 1);
    check('list filter — admin sees all pools', filterAccessiblePools(asUser(adminId, 'ADMIN'), items, (p) => p.id).length === pools.length);

    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    check('flag OFF — buyer allowed (ships dark)', canAccessPool(buyerId, 'BUYER', BMARK));
    check('flag OFF — list filter passes all through', filterAccessiblePools(asUser(buyerId, 'BUYER'), items, (p) => p.id).length === pools.length);
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
  }

  check('canonical deal_access untouched', canonical.countAll() === canonicalBefore, `${canonicalBefore} rows`);
  read.close();
  console.log(failures === 0 ? '\ndeal-access 3b-2 proof: OK\n' : `\ndeal-access 3b-2 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
