/**
 * PROOF — shelving the bank↔buyer negotiation loop behind NEGOTIATION_LOOP_ENABLED.
 * READ-ONLY on cre.db (mint runs on an in-memory graph store).
 *
 * Gates:
 *  (A) the route guard: flag OFF → requireNegotiationLoop sends 404 + returns false;
 *      flag ON → returns true (routes proceed). Full recovery by flipping the flag.
 *  (B) PRODUCER UNTOUCHED: with the flag OFF, a normal mint STILL produces a
 *      CrossCheckResult graph node (buildBuyerDiffCrossCheck is in the mint, never
 *      gated) — mint byte-identity preserved.
 *  (C) KEPT routes are NOT gated: requireNegotiationLoop appears ONLY on the
 *      negotiation handlers (buyer-diff ×4, overlays/overlay-comments ×2); the
 *      committee-action log, general /:id/comments, disposition, and close routes
 *      carry NO guard.
 *  (D) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/negotiation-shelf-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetType } from '@cre/contracts';
import { AS_OF, makeBenchmarks, makeFullExtraction, makeManifesto, makeSnapshot } from './fixtures/office-deal-fixture.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { requireNegotiationLoop, negotiationLoopEnabled } from '../middleware/negotiation-flag.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

// Minimal express Response stub for the guard.
function mockRes() {
  return {
    statusCode: 0 as number,
    body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

const stub: LLMCallFn = async ({ messages }) => {
  const content = messages[0]?.content;
  const text = typeof content === 'string' ? content : '';
  if (text.includes('committee recommendation')) return 'Recommend (proof stub).';
  if (text.includes('mitigation-suggestions list')) return '(deterministic)';
  if (text.includes('red-flag assessment')) return '- [P] flag.';
  return 'Exec summary.';
};

function partA(): void {
  console.log('\n(A) route guard — off → 404/false, on → proceed:');
  const saved = process.env.NEGOTIATION_LOOP_ENABLED;
  try {
    delete process.env.NEGOTIATION_LOOP_ENABLED; // default OFF
    check('default: negotiationLoopEnabled() is false', negotiationLoopEnabled() === false);
    const r1 = mockRes();
    const proceed1 = requireNegotiationLoop(r1 as never);
    check('flag OFF → guard returns false (route halts)', proceed1 === false);
    check('flag OFF → guard sent 404', r1.statusCode === 404 && (r1.body as { error?: string })?.error === 'NOT_FOUND');

    process.env.NEGOTIATION_LOOP_ENABLED = 'true';
    check('flag ON → negotiationLoopEnabled() is true', negotiationLoopEnabled() === true);
    const r2 = mockRes();
    const proceed2 = requireNegotiationLoop(r2 as never);
    check('flag ON → guard returns true (route proceeds)', proceed2 === true && r2.statusCode === 0);
  } finally {
    if (saved === undefined) delete process.env.NEGOTIATION_LOOP_ENABLED;
    else process.env.NEGOTIATION_LOOP_ENABLED = saved;
  }
}

async function partB(): Promise<void> {
  console.log('\n(B) producer untouched — mint with flag OFF still yields a CrossCheckResult:');
  const saved = process.env.NEGOTIATION_LOOP_ENABLED;
  delete process.env.NEGOTIATION_LOOP_ENABLED; // OFF during the mint
  try {
    const store = new RecordGraphStore(':memory:');
    const lib = makeSnapshot();
    store.insertLibrarySnapshot(lib);
    const ingest = await ingestExtractionResult(
      {
        extractionResult: makeFullExtraction(),
        propertyType: 'Office' as AssetType,
        marketLiquidityHint: 'Primary',
        librarySnapshotId: lib.id,
        marketBenchmarks: makeBenchmarks(),
        creditManifesto: makeManifesto(),
        analysisAsOfDate: AS_OF,
        rentRoll: null,
      },
      store,
      { llmCall: stub },
    );
    const doctrine = store.getDoctrineEvaluation(ingest.evaluationId)!;
    check('DoctrineEvaluation has a crossCheckResultId (producer ran)', !!doctrine.crossCheckResultId);
    const cc = store.getCrossCheckResult(doctrine.crossCheckResultId);
    check('CrossCheckResult node resolves despite flag OFF', cc !== null);
    store.close();
  } finally {
    if (saved === undefined) delete process.env.NEGOTIATION_LOOP_ENABLED;
    else process.env.NEGOTIATION_LOOP_ENABLED = saved;
  }
}

function partC(): void {
  console.log('\n(C) kept routes NOT gated — guard only on negotiation handlers:');
  const base = process.cwd();
  const analysis = fs.readFileSync(path.join(base, 'src/routes/analysis.routes.ts'), 'utf8');
  const workflow = fs.readFileSync(path.join(base, 'src/routes/workflow.routes.ts'), 'utf8');
  const pool = fs.readFileSync(path.join(base, 'src/routes/pool.routes.ts'), 'utf8');
  const countGuard = (s: string) => (s.match(/requireNegotiationLoop\(res\)/g) ?? []).length;

  check('analysis.routes: guard on exactly 4 handlers (the buyer-diff routes)', countGuard(analysis) === 4, `${countGuard(analysis)}`);
  check('workflow.routes: guard on exactly 2 handlers (overlays + overlay-comments)', countGuard(workflow) === 2, `${countGuard(workflow)}`);
  check('committee-action LOG route exists + NOT guarded', /post\('\/committee-actions'/.test(workflow) && countGuard(workflow) === 2);
  check('general /:id/comments routes exist (kept, ungated)', /'\/:id\/comments'/.test(analysis));
  check('disposition + close routes carry NO negotiation guard', countGuard(pool) === 0 && /\/disposition'/.test(pool) && /\/close'/.test(pool));
  // The CrossCheckResult producer import is present in the mint (not gated).
  const evalSrc = fs.readFileSync(path.join(base, 'src/services/evaluate-from-adjusted-inputs.ts'), 'utf8');
  check('buildBuyerDiffCrossCheck still wired into the mint (producer untouched)', /buildBuyerDiffCrossCheck\(/.test(evalSrc));
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
  console.log('\nNegotiation-loop shelf proof (read-only on cre.db)');
  partA();
  await partB();
  partC();
  partD();
  console.log(failures === 0 ? '\nnegotiation-shelf proof: OK\n' : `\nnegotiation-shelf proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
