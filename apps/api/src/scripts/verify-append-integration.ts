/**
 * verify-append-integration — LOCAL behavioral verify for the append flow
 * (appendSourceDocToDeal). Proves the six bars the unit mocks couldn't:
 *
 *   1. CHILD PERSISTS + READS BACK — the child revision envelope is actually
 *      inserted and re-readable with correct lineage (lineageRootId from parent,
 *      parentRevisionId set, ordinal = parent+1).
 *   2. ADVANCE COHERENCE — the analyses row's COLUMN graph_revision_id AND the
 *      blob data.graphRevisionId BOTH point at the child (no stale-blob / foreign
 *      orphan — the seam the whole revsync discipline guards).
 *   3. OVERLAYS SURVIVE — a parent overlay (t12Extraction) is still present on
 *      the child after the advance (updateAnalysis load-merge-save carried it).
 *   4. DIVERGENCE FLAG — OWN CHANNEL — the appended doc's fresh extraction
 *      diverges from the overlay; the flag fires in result.overlayDivergences,
 *      NOT in doctrine findings; the overlay is PRESERVED (PRIMARY), not cleared.
 *   5. PROVENANCE — child provenance is DOC_APPEND + a non-empty inputDiff
 *      (loanTerms reconstructed, so PRELIM→FINAL is a real structural diff).
 *   6. RENDER COHERENT — the child projects through the real loader chain
 *      (projectLegacyAnalysisFromGraph) with the child revision.
 *
 * HOW: fully COPY-BOUND via the SqliteStore file-path seam — cp cre.db → a temp
 * copy, then `new SqliteStore(copy)` / `new RecordGraphStore(copy)` used
 * EVERYWHERE (never the live singletons). It NEVER touches live cre.db. The temp
 * copy + the test deal-doc manifest are removed on exit.
 *
 * REQUIRES (this is a LOCAL integration script, NOT hermetic CI — do NOT wire it
 * into the test runner or package scripts; it would fail on a clean machine):
 *   - a local source-doc-store with the Sunroad library docs under
 *     UW 3327fd55-e382-4286-8378-64d33a11e518 (asr / cf PRELIM+FINAL / pca), and
 *   - a cre.db whose .data path holds those docs.
 * Run by hand like the phase15 scripts:  npx tsx src/scripts/verify-append-integration.ts
 *
 * .buffer GOTCHA (don't re-derive): getSourceDocBuffer returns
 * `{ buffer, entry }`, NOT a raw Buffer. Feeding the wrapper to the xlsx parser
 * fails the zip read → cf.adapter returns null inPlace → JE_GROSS_RENTAL_INCOME_
 * MISSING. The slot() helper below extracts `.buffer`.
 */
import { rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteStore } from '../storage/sqlite-store.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildExtractionResult } from '../services/extraction/build-extraction-result.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { getSourceDocBuffer, getDealManifest } from '../services/source-doc-store.service.js';
import { saveDealSourceDoc } from '../services/deal-source-doc-store.service.js';
import { appendSourceDocToDeal } from '../services/append-source-doc.service.js';
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
import { computeLibrarySnapshotId, computeMarketBenchmarksId, computeCreditManifestoId } from '../util/content-hash.js';
import type { ContentHash, ISODateTime, AssetType, MarketBenchmarks, LibrarySnapshot, CreditManifesto, RevisionId } from '@cre/contracts';

const REPO = path.resolve(process.cwd());
const LIVE = path.join(REPO, 'data', 'cre.db');
const COPY = path.join(REPO, '.data', `verify-append-${process.pid}.db`);
const DEAL_DOCS_DIR = path.join(REPO, '.data', 'deal-source-docs');
const UW = '3327fd55-e382-4286-8378-64d33a11e518';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;
const LT = { loanAmount: 82460000, interestRate: 0.079, amortization: 0, interestOnlyPeriod: 60, maturityDate: '2031-05-31T00:00:00Z' } as never;

const empty = <T,>(v: T): Record<string, T> => ({ Office: v, Multifamily: v, Industrial: v, Retail: v, Hotel: v, SelfStorage: v, MixedUse: v, ManufacturedHousing: v });
const snap = (): LibrarySnapshot => { const b = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType: { ...empty(null), Office: { vacancy: { median: .10, p25: .07, p75: .13 }, expenseRatio: { median: .30, p25: .25, p75: .35 }, capRate: { median: .075, p25: .07, p75: .08 }, dscr: { median: 1.3, p25: 1.2, p75: 1.4 }, treasury10YAtClose: { median: .04, p25: .035, p75: .045 }, n: 25 } } }; return { id: computeLibrarySnapshotId(b), ...b } as never; };
const bench = (): MarketBenchmarks => { const b = { asOfDate: AS_OF, capRates: { ...empty(null), Office: .075 }, vacancyRates: { ...empty(.05), Office: .10 }, expensesPerSqFt: { ...empty(8.5), Office: 8.5 }, interestRateAssumptions: { baseRate: .065, stressRate: .085 }, marketLiquidityIndex: { primary: .85, secondary: .55, tertiary: .30 } }; return { id: computeMarketBenchmarksId(b), ...b } as never; };
const manif = (): CreditManifesto => { const b = { analysisAsOfDate: AS_OF, manifestoContractVersion: 1, rules: [] }; return { id: computeCreditManifestoId(b), ...b } as never; };

/** Resolve a library slot's first/by-prefix doc → { buffer, filename }.
 *  NOTE the `.buffer` extraction — getSourceDocBuffer returns { buffer, entry }. */
function slot(s: string, prefix?: string): { buffer: Buffer; filename: string } | undefined {
  const m = getDealManifest(UW); if (!m) return undefined;
  const es = (m.slots as never as Record<string, Array<{ fileHash: string; originalFileName: string }>>)[s] ?? [];
  const e = prefix ? es.find((x) => x.fileHash.startsWith(prefix)) : es[0];
  if (!e) return undefined;
  const r = getSourceDocBuffer({ historicalUwId: UW, slot: s as never, fileHash: e.fileHash });
  return r ? { buffer: r.buffer, filename: e.originalFileName } : undefined;
}

function cleanup(): void {
  for (const p of [COPY, `${COPY}-wal`, `${COPY}-shm`]) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
  try { rmSync(DEAL_DOCS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  copyFileSync(LIVE, COPY);
  const graph = new RecordGraphStore(COPY);
  const sql = new SqliteStore(COPY);

  const asr = slot('asr'), cfP = slot('cf', 'c6e6286b'), pca = slot('pca');
  const lib = snap(); graph.insertLibrarySnapshot(lib);
  const mb = bench(); graph.insertMarketBenchmarks(mb);
  const cm = manif(); graph.insertCreditManifesto(cm);

  // PARENT — mirror the route: asr + cf PRELIM + pca, loanTerms, marketLiquidityHint.
  const composed = await buildExtractionResult({ slots: { asrPdf: asr, sellerCfXlsx: cfP, pcaPdf: pca } as never, analysisAsOfDate: AS_OF, dealRef: 'verify-append', loanTerms: LT });
  const parent = await ingestExtractionResult({ extractionResult: composed.extractionResult, propertyType: 'Office' as AssetType, marketLiquidityHint: 'Primary' as never, librarySnapshotId: lib.id, marketBenchmarksId: mb.id, creditManifestoId: cm.id, analysisAsOfDate: AS_OF, rentRoll: composed.rentRoll, propertyMetadata: composed.propertyMetadata }, graph, {});
  const pe = graph.getRevisionEnvelope(parent.rootId)!;
  console.log(`PARENT minted: ordinal ${pe.revisionOrdinal} (income present — ingest succeeded)`);

  const AID = 'verify-append-analysis';
  sql.createAnalysis({ id: AID, name: 'Verify Append', assetType: 'office', status: 'complete', progress: 100, currentStep: '', createdAt: AS_OF, updatedAt: AS_OF, document: null, uwDocument: null, supportingDocuments: [], templateDocument: null, findings: [], creditScore: null, uwModel: null, propertyMetadata: null, appraisalExtraction: null, rentRoll: null, t12Extraction: { noi: 7777777 }, research: null, crossCheckFindings: [], mitigations: [], executiveSummary: null, bPieceDecision: null, comments: [], criteriaEvaluations: [], stressScenarios: [], overallAdjustmentBias: 'conservative', graphRevisionId: parent.rootId, lineageRootId: parent.rootId, revisionOrdinal: 0, parentAnalysisId: null, error: null } as never);
  for (const [s, d] of [['asr', asr], ['cf', cfP], ['pca', pca]] as Array<[string, { buffer: Buffer; filename: string } | undefined]>) {
    if (d) await saveDealSourceDoc(parent.rootId, s as never, { originalFileName: d.filename, bytes: d.buffer });
  }
  console.log('analyses row + deal-docs persisted; parent overlay t12Extraction.noi=7777777 stamped');

  // APPEND — the FINAL CF (the real PRELIM→FINAL update), copy-bound deps.
  const cfF = slot('cf', '4926a5a8')!;
  const res = await appendSourceDocToDeal(
    { analysisId: AID, newDoc: { slot: 'cf' as never, originalFileName: cfF.filename, bytes: cfF.buffer }, marketBenchmarksId: mb.id, creditManifestoId: cm.id },
    { sqliteStore: sql, recordGraphStore: graph },
  );

  console.log('\n===== SIX BARS =====');
  const ce = graph.getRevisionEnvelope(res.childRevisionId as RevisionId)!;
  const bar1 = ce && ce.lineageRootId === pe.lineageRootId && ce.parentRevisionId === parent.rootId && ce.revisionOrdinal === pe.revisionOrdinal + 1;
  console.log(`1. CHILD PERSISTS+READS BACK: ${bar1 ? `✓ lineageRoot=${ce.lineageRootId.slice(0, 8)} parent=${ce.parentRevisionId!.slice(0, 8)} ord=${ce.revisionOrdinal}` : '✗ ' + JSON.stringify(ce)}`);

  const row = sql.rawDb().prepare('SELECT graph_revision_id, data FROM analyses WHERE id = ?').get(AID) as { graph_revision_id: string; data: string };
  const colRev = row.graph_revision_id; const blobRev = JSON.parse(row.data).graphRevisionId;
  const bar2 = colRev === res.childRevisionId && blobRev === res.childRevisionId;
  console.log(`2. ADVANCE COHERENCE: column=${String(colRev).slice(0, 8)} blob=${String(blobRev).slice(0, 8)} ${bar2 ? '✓ both=child, no orphan' : '✗ STALE/ORPHAN'}`);

  const childAnalysis = sql.getAnalysis(AID) as never as { t12Extraction?: { noi?: number }; findings: unknown[] };
  const bar3 = childAnalysis.t12Extraction?.noi === 7777777;
  console.log(`3. OVERLAYS SURVIVE: t12Extraction.noi=${childAnalysis.t12Extraction?.noi} ${bar3 ? '✓ preserved' : '✗ lost'}`);

  const bar4 = res.overlayDivergences.length === 1 && childAnalysis.findings.length === 0;
  console.log(`4. DIVERGENCE FLAG (own channel): ${JSON.stringify(res.overlayDivergences)} | findings len ${childAnalysis.findings.length} ${bar4 ? '✓ own channel, not findings' : '✗'}`);

  const prov = graph.getRevisionProvenance(res.childRevisionId as RevisionId)!;
  const diffN = prov.inputDiff?.changedFields?.length ?? 0;
  const bar5 = prov.triggerSource === 'DOC_APPEND' && diffN > 0;
  console.log(`5. PROVENANCE: trigger=${prov.triggerSource} changedFields=${diffN} ${bar5 ? '✓ DOC_APPEND + real diff' : '✗'}`);

  const proj = projectLegacyAnalysisFromGraph(sql.getAnalysis(AID) as never, graph as never) as never as { graphRevisionId?: string; uwModel?: unknown };
  const bar6 = proj.graphRevisionId === res.childRevisionId && proj.uwModel != null;
  console.log(`6. RENDER COHERENT: child projects via real loader, graphRevisionId=${String(proj.graphRevisionId).slice(0, 8)} uwModel=${!!proj.uwModel} ${bar6 ? '✓' : '✗'}`);

  const allPass = bar1 && bar2 && bar3 && bar4 && bar5 && bar6;
  console.log(`\n===== ${allPass ? 'ALL SIX BARS PASS ✓' : 'FAILURE — see ✗ above'} =====`);
  if (!allPass) process.exitCode = 2;
}

main()
  .catch((e) => { console.error('HARNESS THREW:', (e as Error)?.message ?? e); process.exitCode = 2; })
  .finally(cleanup);
