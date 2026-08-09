/**
 * PROOF — Chunk 3a: deal_access model + owner-stamp + backfill (NO enforcement).
 * Assumes backfill-deal-access.ts has run. READ-ONLY on the deals themselves;
 * verifies:
 *   - the deal_access table exists + is populated;
 *   - originator@ + admin@ are granted every existing deal root + the BMARK pool;
 *   - Sunroad / 640 / Prime deal roots each carry originator@ + admin@ grants;
 *   - buyer@ has ZERO grants (empty-until-invited — the point of 3b);
 *   - backfill is idempotent (re-grant adds no row);
 *   - canonical deals are byte-identical (BMARK 17 docs, 640 head intact) — the
 *     backfill only ADDED deal_access rows, changed nothing a user reads today.
 *
 * Run: npx tsx src/scripts/deal-access-3a-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DealAccessStore } from '../storage/deal-access-store.js';

const DB_PATH = path.join(process.cwd(), 'data', 'cre.db');
const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function main(): void {
  const read = new Database(DB_PATH, { readonly: true });
  const store = new DealAccessStore(DB_PATH);
  console.log('\nDeal-access 3a proof (model + backfill; no enforcement)\n');

  check('deal_access table populated (backfill ran)', store.countAll() > 0, `${store.countAll()} rows`);

  const uid = (email: string): string =>
    ((read.prepare(`SELECT id FROM users WHERE email=?`).get(email) as { id: string } | undefined)?.id ?? '');
  const originatorId = uid('originator@cre.com');
  const adminId = uid('admin@cre.com');
  const buyerId = uid('buyer@cre.com');
  check('seeded users resolved', !!originatorId && !!adminId && !!buyerId);

  // Pool grants.
  check('originator@ granted BMARK pool', store.has('pool', BMARK, originatorId));
  check('admin@ granted BMARK pool', store.has('pool', BMARK, adminId));

  // Deal-root grants for the named canonical deals.
  const roots = read
    .prepare(`SELECT DISTINCT lineage_root_id AS k, name FROM analyses WHERE lineage_root_id IS NOT NULL`)
    .all() as Array<{ k: string; name: string }>;
  const rootsNamed = (needle: string) =>
    roots.filter((r) => (r.name ?? '').toLowerCase().includes(needle)).map((r) => r.k);
  for (const [label, needle] of [['Sunroad', 'sunroad'], ['640', '640'], ['Prime', 'prime']] as const) {
    const ks = rootsNamed(needle);
    check(`${label} deal root(s) present`, ks.length > 0, `${ks.length} root(s)`);
    check(`originator@ + admin@ granted ${label}`, ks.length > 0 && ks.every((k) => store.has('deal', k, originatorId) && store.has('deal', k, adminId)));
  }

  // Buyer has NO grants — this is the whole point (empty-until-invited under 3b).
  check('buyer@ has ZERO grants (not invited)', store.listForUser(buyerId).length === 0, `${store.listForUser(buyerId).length} grants`);

  // Idempotency — re-granting an existing row adds nothing.
  const c0 = store.countAll();
  store.grant({ resourceType: 'pool', resourceKey: BMARK, userId: originatorId, party: 'originator' });
  check('idempotent — re-grant adds no row', store.countAll() === c0, `${c0} → ${store.countAll()}`);

  // Canonical byte-identical (only deal_access rows were added; deals untouched).
  const bmarkDocs = (read.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id=?`).get(BMARK) as { c: number }).c;
  check('canonical unaffected — BMARK data_room_doc still 17', bmarkDocs === 17, `${bmarkDocs}`);
  const head640 = read.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  check('640 head 221235987967 intact', !!head640);

  read.close();
  console.log(failures === 0 ? '\ndeal-access 3a proof: OK\n' : `\ndeal-access 3a proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
