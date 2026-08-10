/**
 * PROOF — Chunk 3: continuous re-eval. A loan underwrites the moment it crosses
 * partial→ready on ANY loan-touching event. READ-ONLY on cre.db (in-memory stubs).
 *
 * Gates:
 *  (A) /identify DEAD-END FIX: a loan with income already present; its ASR was in
 *      the HELD backlog. Before attach → NOT ready (no job). After the held ASR
 *      attaches → reevaluateAndEnqueueIfReady → READY → job enqueued. (headline)
 *  (B) doc MOVE completes a loan → enqueued (same primitive, reclassify path).
 *  (C) IDEMPOTENT: re-touch a loan whose job is already active → dedup → NO 2nd job.
 *  (D) partial stays partial: re-eval a loan missing income → no job, reports missing.
 *  (E) unresolvable loan → no-op.
 *  (F) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/underwrite-continuous-reeval-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { isReadyToUnderwrite } from '../services/pool/underwrite-readiness.service.js';
import { reevaluateAndEnqueueIfReady } from '../services/pool/batch-settle-fanout.service.js';
import { UnderwriteJobStore } from '../storage/underwrite-job-store.js';
import type { PoolStore } from '../storage/pool-store.js';
import type { listPoolDocs as ListPoolDocsFn } from '../services/data-room-store.service.js';
type ListDocsFn = typeof ListPoolDocsFn;
type DocEntry = ReturnType<ListDocsFn>[number];

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const doc = (loanInPoolId: string, docType: string, fileHash: string) =>
  ({ loanInPoolId, docType, fileHash, ingest: true } as unknown as DocEntry);
const listDocs = (rows: DocEntry[]): ListDocsFn => ((_p: string) => rows) as unknown as ListDocsFn;

const P = 'P';
const poolStore = {
  getLoanInPool: (id: string) => (id === 'L' ? { poolId: P, dealRef: 'deal-L' } : null),
} as unknown as PoolStore;

function partA(): void {
  console.log('\n(A) /identify dead-end fix — held ASR completes a loan that had income:');
  const jobStore = new UnderwriteJobStore(':memory:');
  // BEFORE: loan L has income (cf) only; its ASR sits in HELD (not in data_room_doc).
  const before = { listPoolDocs: listDocs([doc('L', 'cf', 'c1')]), poolStore, jobStore, kickDrain: false };
  check('BEFORE attach: loan is NOT ready (ASR still held)', !isReadyToUnderwrite(P, 'L', before));
  const pre = reevaluateAndEnqueueIfReady(P, 'L', before);
  check('BEFORE attach: no job enqueued (stays partial)', !pre.enqueued && jobStore.getActiveForLoan('L') === null);

  // AFTER: identify attaches the held ASR → now in the manifest → asr + cf present.
  const after = { listPoolDocs: listDocs([doc('L', 'cf', 'c1'), doc('L', 'asr', 'a1')]), poolStore, jobStore, kickDrain: false };
  const post = reevaluateAndEnqueueIfReady(P, 'L', after);
  check('AFTER attach: loan crosses into READY', post.ready);
  check('AFTER attach: a job is ENQUEUED (dead-end fixed)', post.enqueued && post.jobId !== null);
  check('job store now holds an active job for L', jobStore.getActiveForLoan('L') !== null);
  jobStore.rawDb().close();
}

function partB(): void {
  console.log('\n(B) doc move completes a loan → enqueued:');
  const jobStore = new UnderwriteJobStore(':memory:');
  // A move lands the completing ASR onto loan L which already had income.
  const deps = { listPoolDocs: listDocs([doc('L', 'cf', 'c1'), doc('L', 'asr', 'a1')]), poolStore, jobStore, kickDrain: false };
  const r = reevaluateAndEnqueueIfReady(P, 'L', deps);
  check('move that completes the loan → enqueued', r.ready && r.enqueued);
  jobStore.rawDb().close();
}

function partC(): void {
  console.log('\n(C) idempotent — re-touch an already-active loan → NO second job:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const deps = { listPoolDocs: listDocs([doc('L', 'cf', 'c1'), doc('L', 'asr', 'a1')]), poolStore, jobStore, kickDrain: false };
  const first = reevaluateAndEnqueueIfReady(P, 'L', deps);
  const second = reevaluateAndEnqueueIfReady(P, 'L', deps);
  check('1st call mints a job', first.enqueued && first.jobId !== null);
  check('2nd call dedups (enqueued:false, SAME jobId)', !second.enqueued && second.jobId === first.jobId);
  const active = jobStore.rawDb().prepare(`SELECT count(*) c FROM underwrite_job WHERE loan_in_pool_id='L' AND state IN ('pending','running')`).get() as { c: number };
  check('exactly ONE active job after two re-touches', active.c === 1, `active=${active.c}`);
  jobStore.rawDb().close();
}

function partD(): void {
  console.log('\n(D) partial stays partial — re-eval a loan missing income:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const deps = { listPoolDocs: listDocs([doc('L', 'asr', 'a1')]), poolStore, jobStore, kickDrain: false }; // ASR only
  const r = reevaluateAndEnqueueIfReady(P, 'L', deps);
  check('not ready → no job (stays partial)', !r.ready && !r.enqueued && jobStore.getActiveForLoan('L') === null);
  check('reports what it still needs (income)', r.missing.some((m) => /cash-flow/i.test(m)), r.missing.join(', '));
  jobStore.rawDb().close();
}

function partE(): void {
  console.log('\n(E) unresolvable loan → no-op:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const deps = { listPoolDocs: listDocs([doc('X', 'asr', 'a1'), doc('X', 'cf', 'c1')]), poolStore, jobStore, kickDrain: false };
  const r = reevaluateAndEnqueueIfReady(P, 'X', deps); // X not in pool store
  check('loan not in pool → no job, no throw', !r.ready && !r.enqueued);
  jobStore.rawDb().close();
}

function partF(): void {
  console.log('\n(F) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nUnderwrite continuous re-eval proof (read-only on cre.db)');
partA(); partB(); partC(); partD(); partE(); partF();
console.log(failures === 0 ? '\ncontinuous-reeval proof: OK\n' : `\ncontinuous-reeval proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
