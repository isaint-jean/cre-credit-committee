/**
 * BACKFILL (Chunk 3a) — grant originator@ + admin@ access to every existing deal
 * (analysis lineage root) and every pool. ADDITIVE + IDEMPOTENT (INSERT OR IGNORE
 * on the PK, so re-running is a no-op). NO enforcement is added — this only seeds
 * deal_access rows so that when 3b turns on the filter, existing deals are already
 * owned (admin + originator see everything; a fresh buyer sees nothing until
 * invited). The deals themselves are byte-identical (only deal_access rows added).
 *
 * Run: npx tsx src/scripts/backfill-deal-access.ts   (from apps/api)
 * Reversible: DELETE FROM deal_access;  (or DROP TABLE deal_access;)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DealAccessStore } from '../storage/deal-access-store.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');

function main(): void {
  const read = new Database(DB_PATH, { readonly: true });
  const store = new DealAccessStore(DB_PATH);

  // Grantees — the seeded users. originator@ owns as 'originator'; admin@ as 'admin'.
  const userId = (email: string): string | null => {
    const r = read.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
    return r?.id ?? null;
  };
  const originatorId = userId('originator@cre.com');
  const adminId = userId('admin@cre.com');
  if (!originatorId || !adminId) {
    console.error(`✗ missing seeded users (originator@: ${originatorId}, admin@: ${adminId}) — cannot backfill`);
    process.exit(1);
  }

  // Deal roots = the stable per-deal key (lineageRootId), from BOTH the legacy
  // analyses table (Spine A) and the graph lineage envelopes (Spine B), unioned.
  const roots = (
    read
      .prepare(
        `SELECT DISTINCT lineage_root_id AS k FROM analyses WHERE lineage_root_id IS NOT NULL
         UNION
         SELECT DISTINCT lineage_root_id AS k FROM revision_lineage_envelopes WHERE lineage_root_id IS NOT NULL`,
      )
      .all() as Array<{ k: string }>
  ).map((r) => r.k);

  const pools = (read.prepare(`SELECT id AS k FROM pool`).all() as Array<{ k: string }>).map((r) => r.k);

  const before = store.countAll();
  const grantees: Array<{ id: string; party: 'originator' | 'admin' }> = [
    { id: originatorId, party: 'originator' },
    { id: adminId, party: 'admin' },
  ];
  for (const root of roots) {
    for (const g of grantees) {
      store.grant({ resourceType: 'deal', resourceKey: root, userId: g.id, party: g.party, grantedBy: adminId });
    }
  }
  for (const pool of pools) {
    for (const g of grantees) {
      store.grant({ resourceType: 'pool', resourceKey: pool, userId: g.id, party: g.party, grantedBy: adminId });
    }
  }
  const after = store.countAll();

  const expected = (roots.length + pools.length) * grantees.length;
  console.log(`\nbackfill-deal-access:`);
  console.log(`  deal roots: ${roots.length}   pools: ${pools.length}   grantees: ${grantees.length}`);
  console.log(`  deal_access rows: ${before} → ${after}  (expected total ${expected})`);
  console.log(
    after === expected
      ? `  ✓ row count == (roots + pools) × grantees\n`
      : `  ⚠ row count ${after} != expected ${expected} (pre-existing rows or a collision?)\n`,
  );

  read.close();
}

main();
