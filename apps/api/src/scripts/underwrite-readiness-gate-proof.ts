/**
 * PROOF — Chunk 1: the underwrite readiness gate. READ-ONLY on cre.db (all work on
 * in-memory / injected stubs).
 *
 * Gates:
 *  (A) readiness predicate (pure doc-presence): ASR+CF → ready; ASR-only → not ready
 *      (missing income); CF-only → not ready (missing ASR); ASR+T12 → ready (t12
 *      satisfies income); empty → not ready.
 *  (B) settle fan-out gate: a settled batch touching a READY loan (ASR+CF) and a
 *      NOT-READY loan (ASR-only) → only the ready loan is enqueued; the partial loan
 *      is returned in skippedNotReady with what it needs (the bug fix).
 *  (C) manual-route gating rule: not-ready + force=false → blocked; not-ready +
 *      force=true → underwrites (human escape hatch); ready → underwrites.
 *  (D) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/underwrite-readiness-gate-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import {
  evaluateUnderwriteReadiness,
  isReadyToUnderwrite,
} from '../services/pool/underwrite-readiness.service.js';
import { enqueueUnderwriteOnSettle } from '../services/pool/batch-settle-fanout.service.js';
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

// A minimal data_room_doc entry (only the fields readiness + settle read).
const doc = (loanInPoolId: string, docType: string, fileHash: string) =>
  ({ loanInPoolId, docType, fileHash, ingest: true } as unknown as DocEntry);

// listPoolDocs stub over a fixed manifest.
const listDocs = (rows: DocEntry[]): ListDocsFn =>
  ((_poolId: string) => rows) as unknown as ListDocsFn;

function partA(): void {
  console.log('\n(A) readiness predicate (pure doc-presence):');
  const P = 'P';
  const ready = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([doc('L', 'asr', 'h1'), doc('L', 'cf', 'h2')]) });
  check('ASR + CF → ready', ready.ready && ready.missing.length === 0);

  const asrOnly = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([doc('L', 'asr', 'h1')]) });
  check('ASR only → not ready (missing income)', !asrOnly.ready && asrOnly.missing.some((m) => /cash-flow/i.test(m)), asrOnly.missing.join(', '));

  const cfOnly = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([doc('L', 'cf', 'h2')]) });
  check('CF only → not ready (missing ASR)', !cfOnly.ready && cfOnly.missing.some((m) => /ASR/i.test(m)), cfOnly.missing.join(', '));

  const asrT12 = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([doc('L', 'asr', 'h1'), doc('L', 't12', 'h3')]) });
  check('ASR + T12 → ready (t12 satisfies income)', asrT12.ready);

  const empty = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([]) });
  check('no docs → not ready (needs both)', !empty.ready && empty.missing.length === 2);

  // rent_roll / pca / appraisal do NOT satisfy the required set.
  const noReq = evaluateUnderwriteReadiness(P, 'L', { listPoolDocs: listDocs([doc('L', 'rent_roll', 'h1'), doc('L', 'pca', 'h2'), doc('L', 'appraisal', 'h3')]) });
  check('rent_roll + pca + appraisal (no ASR/income) → not ready', !noReq.ready && noReq.missing.length === 2);
}

function partB(): void {
  console.log('\n(B) settle fan-out gate — ready loan enqueued, partial loan skipped:');
  const P = 'P';
  // Manifest: loan A ready (ASR+CF), loan B partial (ASR only). All 3 files assigned → batch settles.
  const manifest = [doc('A', 'asr', 'a1'), doc('A', 'cf', 'a2'), doc('B', 'asr', 'b1')];
  const batch = { files: [{ fileHash: 'a1' }, { fileHash: 'a2' }, { fileHash: 'b1' }] };
  const jobStore = new UnderwriteJobStore(':memory:');
  const poolStore = {
    getLoanInPool: (id: string) => (id === 'A' || id === 'B' ? { poolId: P, dealRef: `deal-${id}` } : null),
  } as unknown as PoolStore;

  const res = enqueueUnderwriteOnSettle(P, 'batch-1', {
    listPoolDocs: listDocs(manifest),
    getStagingBatch: (() => batch) as never,
    poolStore,
    jobStore,
    kickDrain: false,
  });

  check('batch settled', res.settled);
  check('exactly ONE job enqueued (the ready loan)', res.enqueuedCount === 1 && res.jobs.length === 1);
  check('enqueued loan is A (ASR+CF)', res.jobs[0]?.loanInPoolId === 'A');
  check('partial loan B skipped (not_ready), NOT underwritten', res.skippedNotReady.some((s) => s.loanInPoolId === 'B'));
  check('skip records what B needs (income)', (res.skippedNotReady.find((s) => s.loanInPoolId === 'B')?.missing ?? []).some((m) => /cash-flow/i.test(m)));
  check('affectedLoans marks A enqueued / B not_ready', res.affectedLoans.find((l) => l.loanInPoolId === 'A')?.status === 'enqueued' && res.affectedLoans.find((l) => l.loanInPoolId === 'B')?.status === 'not_ready');
  // The queue holds ONLY the ready loan's job.
  const activeA = jobStore.getActiveForLoan('A');
  const activeB = jobStore.getActiveForLoan('B');
  check('job store: A has an active job, B has NONE', activeA !== null && activeB === null);
  jobStore.rawDb().close();
}

function partC(): void {
  console.log('\n(C) manual-route gating rule (force override):');
  const P = 'P';
  const partialDeps = { listPoolDocs: listDocs([doc('L', 'asr', 'h1')]) }; // ASR only → not ready
  const readyDeps = { listPoolDocs: listDocs([doc('L', 'asr', 'h1'), doc('L', 'cf', 'h2')]) };
  // The route enqueues iff (force || isReadyToUnderwrite). Replicate that exact rule.
  const wouldEnqueue = (ready: boolean, force: boolean) => force || ready;

  const partialReady = isReadyToUnderwrite(P, 'L', partialDeps);
  const readyReady = isReadyToUnderwrite(P, 'L', readyDeps);
  check('partial loan, force=false → BLOCKED (409)', wouldEnqueue(partialReady, false) === false);
  check('partial loan, force=true → underwrites (escape hatch)', wouldEnqueue(partialReady, true) === true);
  check('ready loan, force=false → underwrites (gate passes)', wouldEnqueue(readyReady, false) === true);
}

function partD(): void {
  console.log('\n(D) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nUnderwrite readiness-gate proof (read-only on cre.db)');
partA();
partB();
partC();
partD();
console.log(failures === 0 ? '\nreadiness-gate proof: OK\n' : `\nreadiness-gate proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
