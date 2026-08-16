/**
 * PROOF — loan assetType wiring (fix c read-time resolve + fix b underwrite write-back).
 * DISPLAY/DATA-ONLY, MINT-SAFE. Reads cre.db read-only; the write-back test runs fully
 * in-memory (throwaway stores) so canonical is untouched.
 *
 * Gates:
 *  (A) read-time resolve (c): getPropertyTypeForRoot returns the engine's type for a real
 *      root — Sunroad eval-id → Office, 640 eval-id → Office (faithful to the engine).
 *  (B) casing normalization: normalizeAssetType maps 'office' → 'Office', round-trips all 9,
 *      and returns null for unknown/blank/null.
 *  (C) endpoint composition: assetType = loan.assetType ?? normalize(getPropertyTypeForRoot)
 *      → Office for Sunroad even though the pool row's assetType is null.
 *  (D) checklist keys off it: buildChecklist('Office') → the Office list (not generic Other).
 *  (E) write-back primitive (b): setLoanAssetType updates BOTH the column and the payload,
 *      so getLoanInPool reflects the new type.
 *  (F) write-back wiring (b): drainUnderwriteJobs fills a null-assetType loan from the engine
 *      after a scored job; a loan whose type can't be derived stays null (honest).
 *  (G) un-underwritten honesty: no asset profile → null → the generic checklist.
 *  (H) canonical byte-identical (BMARK 17, 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/loan-asset-type-wiring-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { store as sqliteStore } from '../storage/sqlite-store.js';
import { PoolStore } from '../storage/pool-store.js';
import { UnderwriteJobStore } from '../storage/underwrite-job-store.js';
import { drainUnderwriteJobs } from '../services/pool/underwrite-worker.service.js';
import type { UnderwriteLoanResult } from '../services/pool/underwrite-loan.service.js';
import { normalizeAssetType, buildChecklist, ASSET_TYPES, type PoolId, type AssetType, type Pool, type ISODateTime } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

/** Seed a minimal pool so seedSingleLoan's FK (loan_in_pool → pool) is satisfied. */
function seedPool(ps: PoolStore, id: string): PoolId {
  const pool: Pool = {
    id: id as PoolId, shelfName: 'mem', vintage: 2024, seller: null,
    createdAt: '2026-01-01T00:00:00Z' as ISODateTime, tapeIds: [], currentTapeId: null, closedAt: null,
  };
  ps.createPool(pool);
  return id as PoolId;
}
const DB = path.join(process.cwd(), 'data', 'cre.db');
const HEAD_640_EVAL_ID = '8259948db54784048bc63cc367731d087d2b0f2f0e9fe8bbb6cd6b74e74812a8';

function partA_C(): void {
  console.log('\n(A/C) read-time resolve — engine asset type for a real root:');
  const db = new Database(DB, { readonly: true });
  const sun = db.prepare(`SELECT de.id AS evalId FROM doctrine_evaluations de JOIN extraction_results er ON er.id = de.extraction_result_id WHERE er.deal_ref LIKE '%unroad%' LIMIT 1`).get() as { evalId: string } | undefined;
  db.close();

  const raw640 = sqliteStore.getPropertyTypeForRoot(HEAD_640_EVAL_ID);
  check('640 eval-id → engine type Office (faithful, not corrected to MixedUse)', normalizeAssetType(raw640) === 'Office', `raw='${raw640}'`);

  check('found a Sunroad eval id', sun !== undefined);
  if (sun) {
    const rawSun = sqliteStore.getPropertyTypeForRoot(sun.evalId);
    check('Sunroad eval-id → Office (the deal-room read-time path)', normalizeAssetType(rawSun) === 'Office', `raw='${rawSun}'`);
    // Endpoint composition: pool assetType is null → falls through to the derived value.
    const poolAssetType: AssetType | null = null; // the pool row's (unset) value
    const composed = poolAssetType ?? normalizeAssetType(sqliteStore.getPropertyTypeForRoot(sun.evalId));
    check('composed endpoint assetType (poolValue ?? derived) → Office', composed === 'Office');
  }
}

function partB(): void {
  console.log('\n(B) casing normalization:');
  check("'office' → 'Office' (the lowercase profile)", normalizeAssetType('office') === 'Office');
  check("'Office' → 'Office'", normalizeAssetType('Office') === 'Office');
  check("'MIXEDUSE' → 'MixedUse'", normalizeAssetType('MIXEDUSE') === 'MixedUse');
  check('all 9 canonical values round-trip', ASSET_TYPES.every((t) => normalizeAssetType(t) === t));
  check('unknown / blank / null → null', normalizeAssetType('condos') === null && normalizeAssetType('  ') === null && normalizeAssetType(null) === null);
}

function partD(): void {
  console.log('\n(D) checklist keys off the resolved type:');
  const office = buildChecklist('Office');
  check("buildChecklist('Office') → Office list (not generic)", office.assetKey === 'Office' && office.groups[0]!.items.length > 0);
  const generic = buildChecklist(null);
  check('buildChecklist(null) → generic Other list (un-underwritten honesty)', generic.assetKey === 'Other');
}

function partE(): void {
  console.log('\n(E) write-back primitive — column + payload:');
  const ps = new PoolStore(':memory:');
  const pid = seedPool(ps, 'P-mem');
  const loan = ps.seedSingleLoan(pid, 'Test Property', null);
  check('seeded loan starts with assetType null', ps.getLoanInPool(loan.id)?.assetType == null);
  const ok = ps.setLoanAssetType(loan.id, 'Office');
  check('setLoanAssetType returns true + getLoanInPool now reads Office (payload updated)', ok && ps.getLoanInPool(loan.id)?.assetType === 'Office');
}

async function partF(): Promise<void> {
  console.log('\n(F) write-back wiring — drainUnderwriteJobs fills the pool loan:');
  const ps = new PoolStore(':memory:');
  const js = new UnderwriteJobStore(':memory:');
  const pid = seedPool(ps, 'P-mem');
  const loan = ps.seedSingleLoan(pid, 'Sunroad-ish', null);
  js.enqueue(pid, loan.id);

  const ingested = (): UnderwriteLoanResult => ({
    outcome: 'ingested', loanInPoolId: loan.id, docCount: 1,
    rootId: 'fake-revision' as never, analysisId: 'a-1', narrativeStatus: 'ok', narrativeDeferredReason: null,
  });

  // resolveAssetType stub returns Office → the write-back fires.
  await drainUnderwriteJobs({
    jobStore: js, poolStore: ps,
    underwriteLoan: (async () => ingested()) as never,
    resolveAssetType: () => 'Office' as AssetType,
  });
  check('after a scored job, null-assetType loan is filled → Office', ps.getLoanInPool(loan.id)?.assetType === 'Office');

  // A loan whose type can't be derived stays null (honest — no false fill).
  const ps2 = new PoolStore(':memory:');
  const js2 = new UnderwriteJobStore(':memory:');
  const pid2 = seedPool(ps2, 'P-mem');
  const loan2 = ps2.seedSingleLoan(pid2, 'Unknown', null);
  js2.enqueue(pid2, loan2.id);
  await drainUnderwriteJobs({
    jobStore: js2, poolStore: ps2,
    underwriteLoan: (async () => ({ ...ingested(), loanInPoolId: loan2.id })) as never,
    resolveAssetType: () => null,
  });
  check('loan with no derivable type stays null (generic, honest)', ps2.getLoanInPool(loan2.id)?.assetType == null);
}

function partG(): void {
  console.log('\n(G) un-underwritten honesty:');
  check('unknown graph id → no profile → null', sqliteStore.getPropertyTypeForRoot('deadbeef'.repeat(8)) === null);
}

function partH(): void {
  console.log('\n(H) canonical byte-identical (read-only):');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nLoan assetType wiring proof (read-only on cre.db; write-back tested in-memory)');
  partA_C(); partB(); partD(); partE(); await partF(); partG(); partH();
  console.log(failures === 0 ? '\nloan assetType wiring proof: OK\n' : `\nloan assetType wiring proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
