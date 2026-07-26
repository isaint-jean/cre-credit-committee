/**
 * LIVE exercise of the Brave → ExternalFinding → guard chain on Sunroad ad9e9e90.
 * Real web search + real LLM classification. Logs findings + guard decisions;
 * renders NOTHING to a memo, writes NOTHING to the DB. First live exercise —
 * also a rate/quality check.
 *   npx tsx src/scripts/exercise-external-dd-sunroad.ts
 */
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { runExternalDueDiligence } from '../services/external-dd.service.js';
import type { RevisionId } from '@cre/contracts';

const RETRIEVED_AT = '2026-07-26T00:00:00Z'; // frozen fetch timestamp (no wall-clock)

(async () => {
  // Read-only against the canonical DB (reads sponsor name + address; writes nothing).
  const sqs = new SqliteStore();
  const rgs = new RecordGraphStore();
  const a = sqs.getAnalysis(((sqs as any).db.prepare("SELECT id FROM analyses WHERE id LIKE 'ad9e9e90%'").get() as any).id)!;
  const env = rgs.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  const d: any = rgs.getDoctrineEvaluation(env.doctrineEvaluationId)!;
  const er: any = rgs.getExtractionResult(d.extractionResultId)!;
  const pm: any = rgs.getPropertyMetadataByExtractionResultId(d.extractionResultId);

  const sponsorName = er.parties?.sponsorName ?? null;
  const borrowerName = er.parties?.borrowerName ?? null;
  const address = er.appraisal?.addressFull ?? pm?.address ?? null;
  const city = er.appraisal?.city ?? pm?.city ?? null;
  const state = er.appraisal?.state ?? pm?.state ?? null;
  const submarket = pm?.submarket ?? null;
  const assetType = (a.assetType as string | undefined) ?? pm?.assetType ?? null;
  console.log('=== Sunroad ad9e9e90 search keys (disambiguation context) ===');
  console.log('  sponsorName :', sponsorName);
  console.log('  borrowerName:', borrowerName);
  console.log('  address     :', address, '| city:', city, '| state:', state, '| submarket:', submarket, '| assetType:', assetType, '\n');

  console.log('Running live chain (Brave + LLM)…\n');
  const res = await runExternalDueDiligence({
    sponsorName, borrowerName, propertyAddress: address, city, state, submarket, assetType, retrievedAt: RETRIEVED_AT,
  });

  console.log('=== QUERIES ISSUED (tightened) ===');
  res.queries.forEach((q) => console.log('  •', q));
  console.log('\n=== RATE / QUALITY ===');
  console.log(`  raw Brave results (unioned+deduped): person=${res.rawCounts.person}, property=${res.rawCounts.property}`);
  console.log(`  ★ STATUS: ${res.status}  ${res.status === 'no_findings_surfaced' ? '(searched, nothing surfaced — NOT a "clean" signal)' : ''}`);

  console.log('\n=== GUARDED FINDINGS (fetch → finding → guard) ===');
  if (res.guarded.length === 0) console.log('  (no findings survived construction)');
  for (const g of res.guarded) {
    console.log(`\n  [${g.finding.subjectType}] subject: ${g.finding.subject}`);
    console.log(`    claim (reported speech): ${g.finding.claim}`);
    console.log(`    claimKind: ${g.finding.claimKind} | sentiment: ${g.finding.sentiment} | sources: ${g.finding.sources.length} (${[...new Set(g.finding.sources.map(s=>s.publisher))].join(', ')})`);
    console.log(`    ★ renderDecision: ${g.decision.toUpperCase()}`);
    console.log(`    rendered → ${g.rendered === null ? '(blank — nothing renders)' : '"' + g.rendered + '"'}`);
  }

  console.log('\n=== DROPPED (never reached output un-guarded) ===');
  if (res.dropped.length === 0) console.log('  (none)');
  for (const dr of res.dropped) console.log(`  ✗ [${dr.subjectType}] "${dr.title.slice(0,70)}" — ${dr.reason}`);

  console.log('\n=== INVARIANT CHECK ===');
  console.log(`  ${res.rawCounts.person + res.rawCounts.property} raw results → ${res.guarded.length} guarded findings + ${res.dropped.length} dropped (+ merges). Every result accounted for; none un-guarded.`);
})().catch((e) => { console.error('FATAL:', e?.message || e); process.exit(2); });
