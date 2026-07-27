/**
 * Mint external-DD into §4/§6 for Sunroad (ad9e9e90) + 640 (26027996).
 *
 * WHAT IT DOES (sibling-only, head-safe):
 *   Runs the live external-DD fetch→guard chain for each deal, then RE-SNAPSHOTS:
 *   copies the deal's EXISTING render-snapshot fields verbatim, adds the frozen
 *   `externalDD` (bumping the row to producer 1.2), recomputes the snapshot id,
 *   and REPLACES the snapshot row. The doctrine eval + envelope + score head are
 *   NOT touched (the snapshot is a sibling record, outside the eval hash
 *   boundary) — mirrors sunroad-re-snapshot-v1-1.ts exactly.
 *
 * DETERMINISM: retrievedAt is pinned to each deal's analysisAsOfDate. The store
 * IS the fetch cache, so a re-run is free and byte-identical.
 *
 * SAFETY: run against a TEMP copy first (--db <path>), verify, THEN canonical.
 *   cd apps/api && npx tsx src/scripts/mint-dd-sec4-sec6.ts --db /tmp/cre.temp.db
 *   cd apps/api && npx tsx src/scripts/mint-dd-sec4-sec6.ts            # canonical
 * Add --dry to run DD + print the would-be memo WITHOUT writing.
 */
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import {
  runExternalDueDiligence,
  buildExternalDDSnapshot,
  type ExternalDDInput,
} from '../services/external-dd.service.js';
import { braveSearch } from '../services/research.service.js';
import { renderMemoForAnalysis } from '../services/render-memo/render-memo-for-analysis.js';
import { computeDoctrineRenderSnapshotId } from '../util/content-hash.js';
import {
  SNAPSHOT_PRODUCER_VERSION,
  extractDoctrineRenderSnapshotHashInput,
  type DoctrineRenderSnapshot,
  type DoctrineRenderSnapshotId,
  type RevisionId,
  type SnapshotExternalDD,
} from '@cre/contracts';

const DEALS = [
  { label: 'Sunroad', analysisId: 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00' },
  { label: '640',     analysisId: '26027996-5d1c-4a7a-ab72-03f4900a0be0' },
];

const argv = process.argv.slice(2);
const dbArgIdx = argv.indexOf('--db');
const dbPath = dbArgIdx >= 0 ? argv[dbArgIdx + 1] : undefined;   // undefined → canonical default
const DRY = argv.includes('--dry');

function hr(t: string): void { console.log('\n════════════════════════════════════════════════\n' + t + '\n════════════════════════════════════════════════'); }
function abort(m: string): never { console.error(`\n  ✗ ABORT — ${m}`); process.exit(2); }
/** Strip tags + collapse whitespace for readable console output. */
function textOf(html: string): string { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
/** Extract one memo <section> by its heading text. */
function sectionByHeading(html: string, heading: string): string | null {
  const secs = html.split('<section');
  for (const s of secs) if (s.includes(heading)) return '<section' + s.split('</section>')[0] + '</section>';
  return null;
}

(async () => {
  hr(`MINT DD → §4/§6   [db=${dbPath ?? 'CANONICAL'}]   ${DRY ? '(DRY RUN — no write)' : ''}`);
  if (SNAPSHOT_PRODUCER_VERSION !== '1.2') abort(`SNAPSHOT_PRODUCER_VERSION=${SNAPSHOT_PRODUCER_VERSION}, expected 1.2`);
  const sqs = dbPath ? new SqliteStore(dbPath) : new SqliteStore();
  const rgs = dbPath ? new RecordGraphStore(dbPath) : new RecordGraphStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (rgs as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => { changes: number } } } }).db;

  for (const deal of DEALS) {
    hr(`${deal.label}  (${deal.analysisId})`);
    const a = sqs.getAnalysis(deal.analysisId);
    if (!a) abort(`analysis ${deal.analysisId} not found`);
    const env = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId);
    if (!env) abort('no envelope');
    const doc = rgs.getDoctrineEvaluation(env.doctrineEvaluationId)!;
    const er = rgs.getExtractionResult(doc.extractionResultId)! as Record<string, any>;
    const pm = rgs.getPropertyMetadataByExtractionResultId(doc.extractionResultId) as Record<string, any> | null;
    const ap = rgs.getAssetProfile(doc.assetProfileId) as Record<string, any> | null;
    const existing = rgs.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
    if (!existing) abort(`${deal.label} has no existing snapshot to extend (recompute-fallback deal)`);
    console.log(`  head (graphRev): ${String(a.graphRevisionId).slice(0, 18)}…  [MUST stay intact]`);
    console.log(`  existing snap  : v${existing.snapshotProducerVersion}  externalDD=${(existing as any).externalDD ? 'YES' : 'no'}  id=${existing.id.slice(0, 14)}…`);

    const analysisAsOfDate = String(er.analysisAsOfDate);
    const ddInput: ExternalDDInput = {
      sponsorName:     er.parties?.sponsorName ?? null,
      sponsors:        er.parties?.sponsors ?? (er.parties?.sponsorName ? [er.parties.sponsorName] : []),
      borrowerName:    er.parties?.borrowerName ?? null,
      propertyAddress: er.appraisal?.addressFull ?? pm?.address ?? null,
      city:            er.appraisal?.city ?? pm?.city ?? null,
      state:           er.appraisal?.state ?? pm?.state ?? null,
      submarket:       pm?.submarket ?? null,
      assetType:       (ap?.propertyType as string | null) ?? null,
      retrievedAt:     analysisAsOfDate,      // pin to as-of for determinism
    };
    console.log(`  DD subject keys: sponsor=${ddInput.sponsorName ?? 'null'} | borrower=${ddInput.borrowerName ?? 'null'} | market=${[ddInput.submarket ?? ddInput.city, ddInput.state].filter(Boolean).join(', ') || 'null'}`);
    console.log('  running live external DD (Brave + classifier)…');
    const ddResult = await runExternalDueDiligence(ddInput, { store: rgs, braveSearch });
    const externalDD = buildExternalDDSnapshot(ddResult, analysisAsOfDate);

    console.log(`\n  ── DD RESULT ──`);
    console.log(`    status         : ${externalDD.status}`);
    console.log(`    personSubject  : ${externalDD.personSubject ?? 'null (§4 could-not-search)'}`);
    console.log(`    marketSubject  : ${externalDD.marketSubject ?? 'null (§6 could-not-search)'}`);
    console.log(`    raw counts     : person=${ddResult.rawCounts.person} property=${ddResult.rawCounts.property}`);
    console.log(`    guarded findings: ${externalDD.findings.length}`);
    for (const f of externalDD.findings) {
      console.log(`      • [${f.finding.subjectType}] decision=${f.decision} → ${f.rendered === null ? '(blank)' : '"' + f.rendered + '"'}`);
    }
    if (ddResult.dropped.length) console.log(`    dropped (guarded out): ${ddResult.dropped.length}`);

    // Build the new snapshot: copy the EXISTING hash-input fields verbatim +
    // add externalDD + bump to 1.2. Only externalDD changes — rating/dims/auth/
    // composed/noiBasis are preserved exactly, so the memo's numbers are byte-
    // identical; only §4/§6's DD block is new.
    const body: Omit<DoctrineRenderSnapshot, 'id'> = {
      doctrineEvaluationId:      existing.doctrineEvaluationId,
      snapshotProducerVersion:   SNAPSHOT_PRODUCER_VERSION,   // 1.2
      capturedAt:                new Date().toISOString(),
      rating:                    existing.rating,
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
    console.log(`\n  new snapshot id: ${newSnap.id.slice(0, 14)}…  (v1.2, + externalDD)`);

    if (!DRY) {
      const del = rawDb.prepare('DELETE FROM doctrine_render_snapshots WHERE doctrine_evaluation_id = ?').run(env.doctrineEvaluationId);
      const ins = rgs.insertDoctrineRenderSnapshot(newSnap);
      if (!ins.inserted) abort('insert no-op — unexpected');
      console.log(`  REPLACED snapshot (deleted ${del.changes}, inserted 1).`);
      // No-cascade: eval + envelope + head unchanged.
      const reEnv = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
      console.log(`  head intact: ${reEnv.doctrineEvaluationId === env.doctrineEvaluationId && a.graphRevisionId === reEnv.revisionId ? '✓ eval+envelope unchanged' : '✗ CASCADE!'}`);
      const re = rgs.getDoctrineRenderSnapshot(env.doctrineEvaluationId)!;
      if ((re as any).externalDD === undefined) abort('read-back has no externalDD');
    }

    // Render the memo + show §4/§6.
    const rendered = renderMemoForAnalysis(a as never, rgs);
    if (!rendered.ok) { console.log(`  memo render: ${rendered.reason} [${rendered.code}]`); continue; }
    for (const [n, h] of [['§4 SPONSOR', 'Sponsor'], ['§6 MARKET', 'Market']] as const) {
      const sec = sectionByHeading(rendered.html, h);
      console.log(`\n  ── ${n} (rendered) ──`);
      console.log('    ' + (sec ? textOf(sec).slice(0, 620) : '(section not located)'));
    }
  }

  if (!DRY && dbPath === undefined) {
    // Consolidate WAL into the canonical file (never leave an uncheckpointed WAL).
    rawDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
    console.log('\n  WAL checkpointed (TRUNCATE).');
  }
  hr('DONE');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e?.stack || e); process.exit(2); });
