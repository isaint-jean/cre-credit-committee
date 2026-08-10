/**
 * PROOF — Chunk 2: auto-attach HELD docs on loan arrival. READ-ONLY on cre.db
 * (in-memory stubs; the classifier + Chunk-3 reeval are the REAL ones).
 *
 * Gates:
 *  (A) HEADLINE: a HELD ASR for a loan not yet present → the loan arrives → the ASR
 *      auto-attaches (held→routed via identifyHeldDoc) → the loan (which already had
 *      income) crosses into READY → underwrite enqueued. All automatic.
 *  (B) ambiguous held doc (filename matches 2 loans) → refuse → STAYS held.
 *  (C) held doc matching NO current loan → STAYS held (untouched).
 *  (D) held doc with no docType hint → can't route → STAYS held.
 *  (E) attach that lands on a still-PARTIAL loan (no income) → attaches but does NOT
 *      underwrite (Chunk 1 holds).
 *  (F) empty backlog → no-op.
 *  (G) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/auto-attach-held-on-loan-arrival-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { rescanHeldOnLoanArrival, type RescanHeldDeps } from '../services/pool/rescan-held-on-loan-arrival.service.js';
import type { HeldDoc } from '../services/data-room-store.service.js';
import type { PoolLoanNameKey } from '../services/data-room-classify.service.js';
import { UnderwriteJobStore } from '../storage/underwrite-job-store.js';
import type { PoolStore } from '../storage/pool-store.js';
import type { listPoolDocs as ListPoolDocsFn } from '../services/data-room-store.service.js';
type DocEntry = ReturnType<typeof ListPoolDocsFn>[number];

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const P = 'P';
const held = (fileHash: string, fileName: string, hintDocType: string | null): HeldDoc =>
  ({ poolId: P, fileHash, fileName, mimeType: 'application/pdf', size: 1, uploadedAt: 't', hintDocType, hintLoanInPoolId: null, hintCategory: null } as HeldDoc);
const loanKey = (loanInPoolId: string, propertyName: string): PoolLoanNameKey =>
  ({ loanInPoolId, originatorLoanRef: null, propertyName });
const docEntry = (loanInPoolId: string, docType: string, fileHash: string) =>
  ({ loanInPoolId, docType, fileHash, ingest: true } as unknown as DocEntry);
const poolStore = { getLoanInPool: (id: string) => (id === 'L' ? { poolId: P, dealRef: 'deal-L' } : null) } as unknown as PoolStore;

/** Build rescan deps with a MUTABLE manifest; the identify stub simulates the real
 *  held→routed move by pushing the attached doc into the manifest (so the Chunk-3
 *  readiness re-check sees it), then Chunk-3's REAL reeval runs against that manifest. */
function makeDeps(heldDocs: HeldDoc[], loans: PoolLoanNameKey[], manifest: DocEntry[], jobStore: UnderwriteJobStore): RescanHeldDeps {
  return {
    listHeldDocs: (() => heldDocs) as unknown as RescanHeldDeps['listHeldDocs'],
    listLoanNameKeys: () => loans,
    getHeldText: async () => '', // content tier skipped in these deterministic cases
    identifyHeldDoc: (async (args: { loanInPoolId: string; docType: string; fileHash: string }) => {
      manifest.push(docEntry(args.loanInPoolId, args.docType, args.fileHash));
      return { status: 'routed' };
    }) as unknown as RescanHeldDeps['identifyHeldDoc'],
    // Chunk-3 reeval is the REAL one — wire its inputs through the shared deps:
    listPoolDocs: (() => manifest) as unknown as RescanHeldDeps['listPoolDocs'],
    poolStore,
    jobStore,
    kickDrain: false,
  };
}

async function partA(): Promise<void> {
  console.log('\n(A) HEADLINE — held ASR for absent loan → loan arrives → auto-attach → underwrite:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const manifest: DocEntry[] = [docEntry('L', 'cf', 'c1')]; // income already routed for L
  const deps = makeDeps([held('h-asr', 'Sunroad Centrum - ASR FINAL.pdf', 'asr')], [loanKey('L', 'Sunroad Centrum')], manifest, jobStore);
  const res = await rescanHeldOnLoanArrival(P, deps);
  check('the held ASR auto-attached to loan L (via filename)', res.attached.some((a) => a.fileHash === 'h-asr' && a.loanInPoolId === 'L' && a.docType === 'asr' && a.via === 'filename'));
  check('nothing left held', res.stillHeld === 0);
  check('loan L underwrite ENQUEUED (crossed into ready)', res.enqueued.some((e) => e.loanInPoolId === 'L'));
  check('job store holds an active job for L', jobStore.getActiveForLoan('L') !== null);
  jobStore.rawDb().close();
}

async function partB(): Promise<void> {
  console.log('\n(B) ambiguous held doc (filename matches 2 loans) → stays held:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const manifest: DocEntry[] = [];
  // Two loans with the SAME property name → refuse-unless-exactly-one → null.
  const deps = makeDeps([held('h-amb', 'Sunroad Centrum - ASR.pdf', 'asr')], [loanKey('A', 'Sunroad Centrum'), loanKey('B', 'Sunroad Centrum')], manifest, jobStore);
  const res = await rescanHeldOnLoanArrival(P, deps);
  check('ambiguous doc NOT attached', res.attached.length === 0 && res.stillHeld === 1);
  check('no underwrite fired', res.enqueued.length === 0);
  jobStore.rawDb().close();
}

async function partC(): Promise<void> {
  console.log('\n(C) held doc matching NO current loan → stays held:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const manifest: DocEntry[] = [];
  const deps = makeDeps([held('h-none', 'Random Vendor Report.pdf', 'pca')], [loanKey('L', 'Sunroad Centrum')], manifest, jobStore);
  const res = await rescanHeldOnLoanArrival(P, deps);
  check('non-matching doc untouched (stays held)', res.attached.length === 0 && res.stillHeld === 1);
  jobStore.rawDb().close();
}

async function partD(): Promise<void> {
  console.log('\n(D) held doc with no docType hint → cannot route → stays held:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const manifest: DocEntry[] = [];
  const deps = makeDeps([held('h-nodt', 'Sunroad Centrum.pdf', null)], [loanKey('L', 'Sunroad Centrum')], manifest, jobStore);
  const res = await rescanHeldOnLoanArrival(P, deps);
  check('no-docType doc not attached (stays held)', res.attached.length === 0 && res.stillHeld === 1);
  jobStore.rawDb().close();
}

async function partE(): Promise<void> {
  console.log('\n(E) attach lands on a still-PARTIAL loan (no income) → attaches, no underwrite:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const manifest: DocEntry[] = []; // L has NO income
  const deps = makeDeps([held('h-asr2', 'Sunroad Centrum - ASR.pdf', 'asr')], [loanKey('L', 'Sunroad Centrum')], manifest, jobStore);
  const res = await rescanHeldOnLoanArrival(P, deps);
  check('ASR attached to L', res.attached.some((a) => a.loanInPoolId === 'L'));
  check('but NOT underwritten (still missing income — Chunk 1 holds)', res.enqueued.length === 0 && jobStore.getActiveForLoan('L') === null);
  jobStore.rawDb().close();
}

async function partF(): Promise<void> {
  console.log('\n(F) empty backlog → no-op:');
  const jobStore = new UnderwriteJobStore(':memory:');
  const res = await rescanHeldOnLoanArrival(P, makeDeps([], [loanKey('L', 'Sunroad Centrum')], [], jobStore));
  check('nothing attached / enqueued', res.attached.length === 0 && res.enqueued.length === 0 && res.stillHeld === 0);
  jobStore.rawDb().close();
}

function partG(): void {
  console.log('\n(G) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nAuto-attach-held-on-loan-arrival proof (read-only on cre.db)');
  await partA(); await partB(); await partC(); await partD(); await partE(); await partF();
  partG();
  console.log(failures === 0 ? '\nauto-attach proof: OK\n' : `\nauto-attach proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
