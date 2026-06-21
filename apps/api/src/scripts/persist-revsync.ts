/**
 * persist-revsync — sync the stale blob data.graphRevisionId to the authoritative
 * COLUMN graph_revision_id for the Sunroad row (71edb76c). The loader already
 * overrides this field from the column, so production is unaffected; this removes
 * a dead cross-deal orphan pointer (b09f6c26, a foreign $11M lineage) from the
 * blob so it is self-consistent. Single-row UPDATE; dry-run default.
 */
import Database from 'better-sqlite3';
const DB = process.env.RS_DB ?? '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const AID = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const APPLY = process.argv.includes('--apply');
const db = new Database(DB);
const row = db.prepare('SELECT data, graph_revision_id FROM analyses WHERE id = ?').get(AID) as { data: string; graph_revision_id: string } | undefined;
if (!row) { console.error('FATAL: row not found'); process.exit(2); }
const col = row.graph_revision_id;
if (!col) { console.error('FATAL: column graph_revision_id is null — refuse to sync to null'); process.exit(2); }
const data = JSON.parse(row.data);
console.log('=== persist-revsync ===  DB:', DB, '| APPLY:', APPLY);
console.log('  blob.graphRevisionId  :', String(data.graphRevisionId).slice(0, 12), '(stale)');
console.log('  column (authoritative):', String(col).slice(0, 12));
if (data.graphRevisionId === col) { console.log('  already in sync — nothing to do.'); db.close(); process.exit(0); }
data.graphRevisionId = col;
console.log('  → blob.graphRevisionId set to column value');
if (!APPLY) { console.log('\nDRY-RUN — no write. Re-run with --apply.'); db.close(); process.exit(0); }
const upd = db.prepare('UPDATE analyses SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), new Date().toISOString(), AID);
if (upd.changes !== 1) { console.error('FATAL: expected 1 row, got', upd.changes); process.exit(2); }
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ LIVE: blob graphRevisionId synced to column; WAL checkpointed.');
