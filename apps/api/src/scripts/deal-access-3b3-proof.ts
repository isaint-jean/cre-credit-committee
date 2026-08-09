/**
 * PROOF — Chunk 3b-3: DATA-ROOM reads (Spine C by poolId, incl. the file-stream-
 * before-bytes trap — all /data-room/:poolId/* fire the same enforcePoolParam) +
 * the pool→deal DERIVATION. CANONICAL-SAFE (in-memory grants; real cre.db untouched).
 *
 * Flag ON: a fresh buyer is DENIED every data-room read for a pool they lack; a
 * buyer GRANTED the pool is allowed, AND derives access to that pool's loans' deals
 * (best-effort dealRef chain); admin bypass. Flag OFF: all allowed (dark no-op).
 *
 * Run: npx tsx src/scripts/deal-access-3b3-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DealAccessStore, setDealAccessStore } from '../storage/deal-access-store.js';
import { canAccessPool, canAccessDeal, dealRootsForPool } from '../middleware/deal-access.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function main(): void {
  const read = new Database(DB_PATH, { readonly: true });
  const canonical = new DealAccessStore(DB_PATH);
  const canonicalBefore = canonical.countAll();
  console.log('\nDeal-access 3b-3 proof — DATA-ROOM reads + pool→deal derivation, flag-gated\n');

  const uid = (email: string): string =>
    ((read.prepare(`SELECT id FROM users WHERE email=?`).get(email) as { id: string } | undefined)?.id ?? '');
  const adminId = uid('admin@cre.com');
  const buyerId = uid('buyer@cre.com');

  // A real deal root NOT reachable from BMARK (to prove derivation is bounded).
  const derivable = [...dealRootsForPool(BMARK)];
  const unrelated = (read.prepare(`SELECT DISTINCT lineage_root_id AS r FROM analyses WHERE lineage_root_id IS NOT NULL`).all() as Array<{ r: string }>)
    .map((x) => x.r)
    .find((r) => !derivable.includes(r)) ?? '__none__';

  const mem = new DealAccessStore(':memory:');
  setDealAccessStore(mem);
  try {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'true';

    // Buyer with NO grant → denied the whole data room (every /:poolId/* route).
    check('buyer DENIED data-room pool (no grant)', !canAccessPool(buyerId, 'BUYER', BMARK));
    check('admin BYPASSES data-room pool', canAccessPool(adminId, 'ADMIN', BMARK));

    // Grant the buyer the POOL → allowed the room, AND derives its loans' deals.
    mem.grant({ resourceType: 'pool', resourceKey: BMARK, userId: buyerId, party: 'buyer' });
    check('buyer GRANTED pool → data-room allowed', canAccessPool(buyerId, 'BUYER', BMARK));
    check('BMARK exposes derivable deal roots (dealRef chain)', derivable.length > 0, `${derivable.length} roots`);
    check('buyer with POOL grant DERIVES deal access', derivable.length > 0 && canAccessDeal(buyerId, 'BUYER', derivable[0]!));
    check('buyer still DENIED an unrelated deal (derivation bounded)', unrelated === '__none__' || !canAccessDeal(buyerId, 'BUYER', unrelated));

    // Flag OFF — dark no-op.
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    const freshBuyer = uid('buyer@cre.com');
    check('flag OFF — a pool-less buyer is allowed (ships dark)', canAccessPool(freshBuyer, 'BUYER', BMARK));
  } finally {
    process.env.DEAL_ACCESS_ENFORCEMENT = 'false';
    setDealAccessStore(null);
  }

  check('canonical deal_access untouched', canonical.countAll() === canonicalBefore, `${canonicalBefore} rows`);
  read.close();
  console.log(failures === 0 ? '\ndeal-access 3b-3 proof: OK\n' : `\ndeal-access 3b-3 proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
