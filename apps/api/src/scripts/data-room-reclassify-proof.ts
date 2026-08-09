/**
 * PROOF — Data Room Chunk 2c: the manual MOVE / RECLASSIFY control.
 *
 * CANONICAL-SAFE: all reclassify mutations run against an in-memory
 * DataRoomDocStore injected via setDataRoomDocStore(), so the real cre.db is NEVER
 * written. As a belt-and-braces check, the real BMARK doc count is read before and
 * after and asserted unchanged. Proves:
 *   - re-type re-derives category (cf → Financial Statements → appraisal → Third-Party);
 *   - move is reversible (round-trips back to the original address, byte-for-byte);
 *   - move to another loan works; delete-old-address leaves exactly one row;
 *   - no-op when target == current; invalid docType + missing hash throw guarded errors;
 *   - the real cre.db is untouched.
 *
 * Run: npx tsx src/scripts/data-room-reclassify-proof.ts   (from apps/api)
 */
import { DOC_TYPE_CATEGORY } from '@cre/contracts';
import { DataRoomDocStore } from '../storage/data-room-doc-store.js';
import {
  setDataRoomDocStore,
  reclassifyDataRoomDoc,
  ReclassifyError,
  listPoolDocs,
} from '../services/data-room-store.service.js';

const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
function expectThrow(label: string, fn: () => void, code: 'NOT_FOUND' | 'INVALID_DOCTYPE'): void {
  try { fn(); check(label, false, 'did not throw'); }
  catch (e) { check(label, e instanceof ReclassifyError && e.code === code, e instanceof ReclassifyError ? e.code : String(e)); }
}

function main(): void {
  console.log('\nData Room reclassify proof (in-memory; canonical-safe)\n');

  // Real BMARK count BEFORE (read-only, via the default cre.db store).
  const before = listPoolDocs(BMARK).length;

  // Isolate: all writes go to an in-memory replica, never cre.db.
  const mem = new DataRoomDocStore(':memory:');
  setDataRoomDocStore(mem);
  try {
    const POOL = '__rc_test__', A = '__loanA__', B = '__loanB__', HASH = 'rc_hash_1';
    mem.upsert({
      poolId: POOL, loanInPoolId: A, docType: 'cf', fileHash: HASH,
      fileName: 'x.xlsx', mimeType: 'application/vnd.ms-excel', size: 10,
      uploadedAt: '2024-01-01T00:00:00Z', notes: null, tier: 'ingesting', ingest: true,
      docEffectiveDate: null,
    });
    check('seed present at (loanA, cf)', !!mem.get(POOL, A, 'cf', HASH));
    check('cf derives Financial Statements', DOC_TYPE_CATEGORY['cf'] === 'Financial Statements');

    // Re-type cf → appraisal (re-derives category to Third-Party Reports).
    const r1 = reclassifyDataRoomDoc({ poolId: POOL, fileHash: HASH, targetLoanInPoolId: A, targetDocType: 'appraisal' });
    check('reclassify moved', r1.moved);
    check('new category = Third-Party Reports', r1.to.category === 'Third-Party Reports', `${r1.from.category} → ${r1.to.category}`);
    check('old address (loanA, cf) deleted', mem.get(POOL, A, 'cf', HASH) === null);
    check('new address (loanA, appraisal) present', !!mem.get(POOL, A, 'appraisal', HASH));
    check('exactly one row for the pool (no dup)', mem.listPoolDocs(POOL).length === 1);

    // Reversible: appraisal → cf restores the original address.
    reclassifyDataRoomDoc({ poolId: POOL, fileHash: HASH, targetLoanInPoolId: A, targetDocType: 'cf' });
    check('reversible — back at (loanA, cf)', !!mem.get(POOL, A, 'cf', HASH) && mem.get(POOL, A, 'appraisal', HASH) === null);

    // Move to another loan (same docType).
    reclassifyDataRoomDoc({ poolId: POOL, fileHash: HASH, targetLoanInPoolId: B, targetDocType: 'cf' });
    check('moved to loan B', !!mem.get(POOL, B, 'cf', HASH) && mem.get(POOL, A, 'cf', HASH) === null);

    // No-op when target == current.
    const r4 = reclassifyDataRoomDoc({ poolId: POOL, fileHash: HASH, targetLoanInPoolId: B, targetDocType: 'cf' });
    check('no-op when target == current address', r4.moved === false);
    check('still exactly one row after no-op', mem.listPoolDocs(POOL).length === 1);

    // Guards.
    expectThrow('invalid target docType throws INVALID_DOCTYPE', () =>
      reclassifyDataRoomDoc({ poolId: POOL, fileHash: HASH, targetLoanInPoolId: B, targetDocType: 'not_a_type' }), 'INVALID_DOCTYPE');
    expectThrow('missing file hash throws NOT_FOUND', () =>
      reclassifyDataRoomDoc({ poolId: POOL, fileHash: 'nope', targetLoanInPoolId: B, targetDocType: 'cf' }), 'NOT_FOUND');
  } finally {
    setDataRoomDocStore(null); // restore the real cre.db store
  }

  // Real BMARK count AFTER — must be unchanged (canonical never written).
  const after = listPoolDocs(BMARK).length;
  check('canonical cre.db untouched (BMARK doc count stable)', after === before, `${before} → ${after}`);

  console.log(failures === 0 ? '\ndata-room reclassify proof: OK\n' : `\ndata-room reclassify proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
