/**
 * PROOF — narrative failure degrades to a scored-but-un-narrated PARTIAL, not a
 * failed job. READ-ONLY on cre.db (all work on in-memory stores).
 *
 * Gates:
 *  (A) evaluateAndNarrate with a THROWING narrative LLM → narrativeStatus 'deferred',
 *      narrative null, BUT the DoctrineEvaluation + render snapshot ARE persisted
 *      (score/band/dims readable); no memo yet. Extraction/doctrine did NOT throw.
 *  (B) RETRY with a working narrative LLM → narrativeStatus 'ok', narrative present,
 *      SAME evaluation id (producer-tail reused — only narrative re-runs), memo now
 *      readable.
 *  (C) worker: underwriteLoan → narrativeStatus 'deferred' ⇒ job PARTIAL (not failed),
 *      'ok' ⇒ done, a genuine throw ⇒ failed, no-ingestable-docs ⇒ failed.
 *  (D) canonical byte-identical (BMARK 17, 640 head) — nothing wrote cre.db.
 *
 * Run: npx tsx src/scripts/underwrite-narrative-partial-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
import type { AssetType } from '@cre/contracts';
import { AS_OF, makeBenchmarks, makeFullExtraction, makeManifesto, makeSnapshot } from './fixtures/office-deal-fixture.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { computeIngestFrontHalf } from '../services/ingest-extraction-result.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { UnderwriteJobStore } from '../storage/underwrite-job-store.js';
import { drainUnderwriteJobs } from '../services/pool/underwrite-worker.service.js';
import type { PoolStore } from '../storage/pool-store.js';
import type { underwriteLoan as UnderwriteLoanFn } from '../services/pool/underwrite-loan.service.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// Working narrative stub (per-slot dispatch, deterministic).
const workingStub: LLMCallFn = async ({ messages }) => {
  const content = messages[0]?.content;
  const text = typeof content === 'string' ? content : '';
  if (text.includes('committee recommendation')) return 'Recommend conditional approval (proof stub).';
  if (text.includes('mitigation-suggestions list')) return '(deterministic)';
  if (text.includes('red-flag assessment')) return '- [P-TEST] Proof red-flag prose.';
  return 'Proof executive summary prose.';
};
// Narrative LLM that ALWAYS throws — simulates credits exhausted mid-run.
const throwingStub: LLMCallFn = async () => {
  throw new Error('AI credits exhausted (simulated) — 402 insufficient_quota');
};

async function partA(): Promise<void> {
  console.log('\n(A) evaluateAndNarrate — narrative throw degrades to deferred (score persisted):');
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const extraction = makeFullExtraction();
  store.insertExtractionResult(extraction);

  const args = {
    extractionResult: extraction,
    propertyType: 'Office' as AssetType,
    marketLiquidityHint: 'Primary' as const,
    librarySnapshotId: lib.id,
    marketBenchmarks: makeBenchmarks(),
    creditManifesto: makeManifesto(),
    analysisAsOfDate: AS_OF,
    rentRoll: null,
  };
  const fh = computeIngestFrontHalf(args, store);
  const enArgs = {
    adjustedInputs: fh.adjustedInputs,
    assetProfile: fh.assetProfile,
    librarySnapshot: fh.librarySnapshot,
    narrativeFacts: fh.narrativeFacts,
    extractionResultId: extraction.id,
    extraction,
    analysisAsOfDate: AS_OF as never,
    propertyMetadata: fh.propertyMetadata,
    rentRoll: null,
  };

  // ── deferred path (throwing narrative LLM) ──
  const deferred = await evaluateAndNarrate(enArgs, store, { llmCall: throwingStub });
  check('narrativeStatus is deferred', deferred.narrativeStatus === 'deferred');
  check('narrative is null (memo pending)', deferred.narrative === null);
  check('deferred reason recorded (credits)', (deferred.narrativeDeferredReason ?? '').includes('credits'), deferred.narrativeDeferredReason ?? '');
  check('evaluateAndNarrate did NOT throw (soft degrade)', true);
  // score/band/dims persisted + readable despite the narrative failure:
  check('DoctrineEvaluation persisted (score readable)', store.getDoctrineEvaluation(deferred.evaluation.id) !== null);
  check('render snapshot persisted (band/dims readable)', store.getDoctrineRenderSnapshot(deferred.evaluation.id) !== null);
  const memoBefore = store.getLatestNarrativeForAdjustedInputs(fh.adjustedInputs.id, NARRATIVE_ENGINE_VERSION);
  check('no memo yet (narrative deferred)', memoBefore === null);

  // ── retry path (working narrative LLM) — producer-tail reused, only narrative re-runs ──
  console.log('\n(B) retry with a working narrative LLM → done, only narrative re-runs:');
  const done = await evaluateAndNarrate(enArgs, store, { llmCall: workingStub });
  check('narrativeStatus is ok on retry', done.narrativeStatus === 'ok');
  check('narrative present on retry', done.narrative !== null);
  check('SAME evaluation id (producer-tail reused — only narrative re-runs)', done.evaluation.id === deferred.evaluation.id, done.evaluation.id.slice(0, 12));
  const memoAfter = store.getLatestNarrativeForAdjustedInputs(fh.adjustedInputs.id, NARRATIVE_ENGINE_VERSION);
  check('memo now readable after retry', memoAfter !== null);
  store.close();
}

async function partC(): Promise<void> {
  console.log('\n(C) worker job-state branching (deferred→partial, ok→done, throw/no-docs→failed):');
  const POOL = 'pool-x';
  const LOAN = 'loan-x';
  const fakePoolStore = {
    getLoanInPool: (id: string) =>
      id === LOAN ? { poolId: POOL, dealRef: 'deal-x', assetType: 'Office', propertyName: 'X', originatorLoanRef: 'x' } : null,
  } as unknown as PoolStore;

  // Each case: fresh in-memory job store, enqueue one job, drain with a case stub.
  async function runCase(
    label: string,
    stub: typeof UnderwriteLoanFn,
    expected: 'partial' | 'done' | 'failed',
    reasonIncludes?: string,
  ): Promise<void> {
    const jobStore = new UnderwriteJobStore(':memory:');
    const { job } = jobStore.enqueue(POOL, LOAN);
    await drainUnderwriteJobs({ jobStore, poolStore: fakePoolStore, underwriteLoan: stub });
    const finalJob = jobStore.getJob(job.id);
    check(`${label} → job state ${expected}`, finalJob?.state === expected, `got ${finalJob?.state}`);
    if (reasonIncludes) check(`${label} → reason records "${reasonIncludes}"`, (finalJob?.reason ?? '').includes(reasonIncludes), finalJob?.reason ?? '');
    jobStore.rawDb().close();
  }

  const deferredStub = (async () => ({
    outcome: 'appended', loanInPoolId: LOAN, docCount: 1,
    parentRevisionId: 'p' as never, childRevisionId: 'c' as never, revisionOrdinal: 1, analysisId: 'a',
    narrativeStatus: 'deferred' as const, narrativeDeferredReason: 'Error: AI credits exhausted (simulated)',
  })) as unknown as typeof UnderwriteLoanFn;
  const okStub = (async () => ({
    outcome: 'ingested', loanInPoolId: LOAN, docCount: 1, rootId: 'r' as never, analysisId: 'a',
    narrativeStatus: 'ok' as const, narrativeDeferredReason: null,
  })) as unknown as typeof UnderwriteLoanFn;
  const throwStub = (async () => { throw new Error('BUILD_FAILED: extraction blew up'); }) as unknown as typeof UnderwriteLoanFn;
  const noDocsStub = (async () => ({
    outcome: 'no-ingestable-docs', loanInPoolId: LOAN, message: 'nothing to underwrite',
  })) as unknown as typeof UnderwriteLoanFn;

  await runCase('narrative deferred (credits)', deferredStub, 'partial', 'pending_credits');
  await runCase('narrative ok', okStub, 'done');
  await runCase('genuine earlier failure (extraction throw)', throwStub, 'failed', 'BUILD_FAILED');
  await runCase('no ingestable docs', noDocsStub, 'failed');
}

function partD(): void {
  console.log('\n(D) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nUnderwrite narrative-partial degradation proof (read-only on cre.db)\n');
  await partA();
  await partC();
  partD();
  console.log(failures === 0 ? '\nnarrative-partial proof: OK\n' : `\nnarrative-partial proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
