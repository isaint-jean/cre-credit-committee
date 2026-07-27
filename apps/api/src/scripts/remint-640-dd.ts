/**
 * Re-mint 640's external-DD with the per-principal (Vornado + Crown) sponsor DD.
 *
 * WHY A SIBLING RE-SNAPSHOT (not a from-scratch re-ingest). `parties` lives on
 * the content-hashed ExtractionResult, but the score-bearing head
 * (RevisionId = hash(parentRevisionId, adjustedInputsId, doctrineVersion)) does
 * NOT include parties — parties are narrative-only and don't touch AdjustedInputs.
 * So a re-ingest with parties populated would produce the SAME revisionId (numbers
 * unchanged) → envelope ON CONFLICT DO NOTHING → the new extraction/eval orphaned.
 * The architecturally-correct home for the per-principal DD is the render snapshot
 * (a sibling, outside the score hash boundary — the same reason externalDD lives
 * there). We REPLACE only the doctrine_render_snapshots row; the eval / adjusted
 * inputs / envelope / analysis / score are byte-IDENTICAL. Head 221235987967
 * untouched, ONE canonical 640, zero duplicate risk.
 *
 * Part A (live): extract the sponsor principals from 640's real ASR (Vornado +
 * Crown), grounded/cited. Part B (live, cache-backed): per-principal DD. Then the
 * sibling re-snapshot freezes it. retrievedAt pinned to the as-of date → the DD is
 * frozen; re-render is byte-identical.
 *
 *   cd apps/api && npx tsx src/scripts/remint-640-dd.ts --db /tmp/cre.temp.db   # temp
 *   cd apps/api && npx tsx src/scripts/remint-640-dd.ts                          # canonical
 * Add --dry to run Part A/B + show the would-be §4 WITHOUT writing.
 */
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { FilesystemBlobStore } from '../storage/blob-store.js';
import { extractText, getDocumentProxy } from 'unpdf';
import { extractPartiesFromAsrLlm } from '../services/extract-parties-from-asr-llm.js';
import { runExternalDueDiligence, buildExternalDDSnapshot, type ExternalDDInput } from '../services/external-dd.service.js';
import { externalDDBlock } from '../services/render-memo/build-committee-memo.js';
import { computeDoctrineRenderSnapshotId } from '../util/content-hash.js';
import {
  SNAPSHOT_PRODUCER_VERSION,
  extractDoctrineRenderSnapshotHashInput,
  type DoctrineRenderSnapshot,
  type DoctrineRenderSnapshotId,
  type RevisionId,
  type ContentHash,
} from '@cre/contracts';

const ANALYSIS_ID = '26027996-5d1c-4a7a-ab72-03f4900a0be0';
const EXPECT_HEAD = '221235987967';
const EXPECT_SCORE = 60.238095238095234;
const AS_OF = '2026-07-10T00:00:00Z';
const EXPECT_SPONSORS = ['Vornado Realty Trust', 'Crown Acquisitions'];

const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : undefined;
const DRY = argv.includes('--dry');

function hr(t: string): void { console.log('\n════════════════════════════════════════\n' + t + '\n════════════════════════════════════════'); }
function abort(m: string): never { console.error(`\n  ✗ ABORT — ${m}`); process.exit(2); }
function txt(h: string): string { return h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

(async () => {
  hr(`RE-MINT 640 DD (per-principal)   [db=${dbPath ?? 'CANONICAL'}]   ${DRY ? '(DRY)' : ''}`);
  if (SNAPSHOT_PRODUCER_VERSION !== '1.2') abort(`SNAPSHOT_PRODUCER_VERSION=${SNAPSHOT_PRODUCER_VERSION}, expected 1.2`);
  const sqs = dbPath ? new SqliteStore(dbPath) : new SqliteStore();
  const rgs = dbPath ? new RecordGraphStore(dbPath) : new RecordGraphStore();
  const blob = new FilesystemBlobStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (rgs as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => { changes: number } } } }).db;

  const a = sqs.getAnalysis(ANALYSIS_ID);
  if (!a) abort('640 analysis not found');
  const env = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId);
  if (!env) abort('no envelope');
  const doc = rgs.getDoctrineEvaluation(env.doctrineEvaluationId)!;
  const existing = rgs.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  if (!existing) abort('640 has no existing snapshot');
  const er = rgs.getExtractionResult(doc.extractionResultId)! as Record<string, any>;

  // ── PRE: capture the invariants ──
  const preScore = (doc as any).finalScore ?? (doc as any).final_score;
  console.log(`  head            : ${String(a.graphRevisionId).slice(0, 14)}…  (expect ${EXPECT_HEAD})`);
  console.log(`  finalScore      : ${preScore}  (expect ${EXPECT_SCORE})`);
  console.log(`  rating          : ${JSON.stringify(existing.rating)}`);
  console.log(`  existing snap   : v${existing.snapshotProducerVersion}  externalDD.personSubjects=${JSON.stringify((existing as any).externalDD?.personSubjects ?? (existing as any).externalDD?.personSubject ?? null)}`);
  if (!String(a.graphRevisionId).startsWith(EXPECT_HEAD)) abort('head mismatch — refusing to touch');

  // ── PART A (live): extract the sponsor principals from 640's ASR ──
  hr('PART A — extract sponsors (live, cited)');
  const asrRef = (er.sourceDocuments ?? []).find((s: any) => s.kind === 'asr');
  if (!asrRef) abort('640 ASR source doc not found');
  const bytes = await blob.getBlob(String(asrRef.contentHash) as ContentHash);
  if (!bytes) abort('ASR bytes not in blob store');
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
  const partsLlm = await extractPartiesFromAsrLlm((text as string[]).join('\n'), String(asrRef.contentHash), {});
  const sponsors = partsLlm.parties?.sponsors ?? [];
  console.log(`  sponsors (cited): ${JSON.stringify(sponsors)}`);
  for (const t of partsLlm.traces) if (t.cited) console.log(`    ✓ "${t.name}"`);
  if (JSON.stringify(sponsors) !== JSON.stringify(EXPECT_SPONSORS)) {
    abort(`sponsors ${JSON.stringify(sponsors)} != expected ${JSON.stringify(EXPECT_SPONSORS)} — refusing (determinism guard)`);
  }

  // ── PART B (live, cache-backed): per-principal DD ──
  hr('PART B — per-principal DD (live/cache)');
  const ddInput: ExternalDDInput = {
    sponsorName: sponsors[0]!, sponsors, borrowerName: er.parties?.borrowerName ?? null,
    propertyAddress: er.appraisal?.addressFull ?? '640 Fifth Avenue',
    city: 'New York', state: 'NY', submarket: 'Plaza District', assetType: 'office', retrievedAt: AS_OF,
  };
  const ddResult = await runExternalDueDiligence(ddInput, { store: rgs });
  const externalDD = buildExternalDDSnapshot(ddResult, AS_OF);
  console.log(`  personSubjects  : ${JSON.stringify(externalDD.personSubjects)}`);
  console.log(`  status          : ${externalDD.status}  | guarded findings: ${externalDD.findings.length}`);
  for (const f of externalDD.findings) {
    console.log(`    • [${f.finding.subject}] decision=${f.decision}`);
    console.log(`      rendered: ${f.rendered}`);
  }

  // ── SIBLING RE-SNAPSHOT: copy existing fields + new externalDD ──
  hr('SIBLING RE-SNAPSHOT (head/eval/score untouched)');
  const body: Omit<DoctrineRenderSnapshot, 'id'> = {
    doctrineEvaluationId:      existing.doctrineEvaluationId,
    snapshotProducerVersion:   SNAPSHOT_PRODUCER_VERSION,
    capturedAt:                new Date().toISOString(),
    rating:                    existing.rating,                    // ← underwrite verbatim
    dimOutputs:                existing.dimOutputs,
    authoritativeNumbers:      existing.authoritativeNumbers,
    composedMitigationPackage: existing.composedMitigationPackage,
    ...(existing.noiBasis !== undefined ? { noiBasis: existing.noiBasis } : {}),
    externalDD,
  };
  const newSnap: DoctrineRenderSnapshot = {
    id: computeDoctrineRenderSnapshotId(extractDoctrineRenderSnapshotHashInput(body)) as DoctrineRenderSnapshotId,
    ...body,
  };
  console.log(`  new snapshot id : ${newSnap.id.slice(0, 14)}…`);
  console.log(`  rating preserved: ${JSON.stringify(newSnap.rating)}  (== existing: ${JSON.stringify(newSnap.rating) === JSON.stringify(existing.rating)})`);

  if (!DRY) {
    const del = rawDb.prepare('DELETE FROM doctrine_render_snapshots WHERE doctrine_evaluation_id = ?').run(env.doctrineEvaluationId);
    const ins = rgs.insertDoctrineRenderSnapshot(newSnap);
    if (!ins.inserted) abort('insert no-op');
    console.log(`  REPLACED snapshot (deleted ${del.changes}, inserted 1).`);
    // No-cascade proof.
    const reEnv = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
    const reDoc = rgs.getDoctrineEvaluation(reEnv.doctrineEvaluationId)!;
    const postScore = (reDoc as any).finalScore ?? (reDoc as any).final_score;
    console.log(`  head unchanged  : ${reEnv.revisionId === env.revisionId && a.graphRevisionId === reEnv.revisionId ? '✓' : '✗'}`);
    console.log(`  eval unchanged  : ${reEnv.doctrineEvaluationId === env.doctrineEvaluationId ? '✓' : '✗'}`);
    console.log(`  score unchanged : ${postScore === preScore ? `✓ ${postScore}` : `✗ ${postScore}`}`);
    if (postScore !== preScore) abort('SCORE CHANGED — this must never happen');
    if (dbPath === undefined) { rawDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run(); console.log('  WAL checkpointed.'); }
  }

  // ── §4 render (per-principal) ──
  hr('§4 SPONSOR (rendered, per-principal)');
  const block = externalDDBlock(DRY ? externalDD : rgs.getDoctrineRenderSnapshot(env.doctrineEvaluationId)!.externalDD, 'person', 'the sponsor');
  console.log('  ' + txt(block).slice(0, 1100));

  hr('DONE');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(2); });
