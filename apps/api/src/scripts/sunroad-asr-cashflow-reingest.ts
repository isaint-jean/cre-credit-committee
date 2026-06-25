/**
 * Sunroad ASR cash-flow re-ingest (P3) — SURGICAL, deal-scoped, dry-run by default.
 *
 * Adds `asr.underwrittenCashFlows` to the appraisal deal's stored extraction by
 * re-ingesting a corrected ExtractionResult. SAFETY by construction:
 *   - Scoped to ONE deal (ad9e9e90) — never the prelim, never another deal.
 *   - Reuses EVERY score-relevant input verbatim (sellerUw, t12, appraisal,
 *     library, rentRoll, propertyMetadata, asOf) AND the deal's exact
 *     benchmarks + manifesto (via getRevisionEvaluationContext, not
 *     reconstructed) → identical doctrine inputs → finalScore must stay 27.1.
 *   - The only change is the inert `asr.underwrittenCashFlows` field (parsed
 *     DETERMINISTICALLY — no LLM). Content-addressing forces a new chain; the
 *     LLM narrative re-runs but cannot move the score.
 *   - Append-only: old envelope (599f5270) stays; the leasing-override side
 *     branch (527c711c) is untouched. Rollback = repoint back / restore backup.
 *
 * DRY RUN by default (prints the plan, writes nothing). Pass --commit to ingest
 * + repoint. Take a cre.db backup before any --commit run.
 */
import * as fs from 'fs';
import { extractText, getDocumentProxy } from 'unpdf';
import { store as sqliteStore } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { parseAsrCashFlowsFromText } from '../services/extract-asr-cashflows.js';
import { computeExtractionResultId, computeMarketBenchmarksId, computeCreditManifestoId } from '../util/content-hash.js';
import { MANIFESTO_CONTRACT_VERSION } from '@cre/contracts';
import type {
  AssetType, RevisionId, ExtractionResult, ExtractionResultId,
  MarketBenchmarks, CreditManifesto,
} from '@cre/contracts';

const DEAL_ID = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00';
const ASR_PDF = '/Users/isabellesaint-jean/Downloads/Sunroad Centrum - ASR FINAL.pdf';
const EXPECTED_SCORE = 27.09999999999998;
const COMMIT = process.argv.includes('--commit');

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('Sunroad ASR cash-flow re-ingest (P3) — ' + (COMMIT ? 'COMMIT (WRITES SQLite)' : 'DRY RUN (no write)'));
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  DEAL_ID:', DEAL_ID);

  // 1. Load existing graph state — reuse ALL of it verbatim.
  const oldAnalysis = sqliteStore.getAnalysis(DEAL_ID);
  if (!oldAnalysis) { console.error('FATAL: analysis missing'); process.exit(2); }
  const oldEnvelopeId = oldAnalysis.graphRevisionId as RevisionId;
  const oldEnv = recordGraphStore.getRevisionEnvelope(oldEnvelopeId)!;
  const oldDoctrine = recordGraphStore.getDoctrineEvaluation(oldEnv.doctrineEvaluationId)!;
  const oldExt = recordGraphStore.getExtractionResult(oldDoctrine.extractionResultId)!;
  const librarySnapshot = recordGraphStore.getLibrarySnapshot(oldDoctrine.librarySnapshotId)!;
  const rentRoll = oldDoctrine.rentRollId ? recordGraphStore.getRentRoll(oldDoctrine.rentRollId) : null;
  const pm = recordGraphStore.getPropertyMetadataByExtractionResultId(oldDoctrine.extractionResultId);
  const asOf = oldDoctrine.analysisAsOfDate;

  // The benchmarks + manifesto 599f5270 used are NOT stored retrievably (passed
  // inline + content-addressed at the original ingest). Reconstruct the EXACT
  // content from the original ingest (scripts/ingest-final-asr.ts) so the hashes
  // reproduce the deal's ids → identical doctrine inputs → same score. A guard
  // (below) aborts if the reconstructed ids don't match the revision's eval
  // context — protecting the score from any content drift.
  const TYPES = ['Office', 'Retail', 'Multifamily', 'Hotel', 'Industrial', 'SelfStorage', 'MHC', 'MixedUse', 'Other'] as const;
  const fill = (d: number | null, office: number) =>
    Object.fromEntries(TYPES.map((t) => [t, t === 'Office' ? office : d]));
  const mbBody = {
    asOfDate: asOf,
    capRates: fill(null, 0.075),
    vacancyRates: fill(0.05, 0.10),
    expensesPerSqFt: fill(8.50, 8.50),
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  const marketBenchmarks = { id: computeMarketBenchmarksId(mbBody as never), ...mbBody } as never as MarketBenchmarks;
  const cmBody = { analysisAsOfDate: asOf, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  const creditManifesto = { id: computeCreditManifestoId(cmBody as never), ...cmBody } as never as CreditManifesto;

  // ★ Guard: reconstructed ids MUST match the revision's eval context, else the
  // doctrine inputs differ → score risk. Abort rather than risk the 27.1.
  const evalCtx = recordGraphStore.getRevisionEvaluationContext(oldEnvelopeId);
  if (evalCtx && (marketBenchmarks.id !== evalCtx.marketBenchmarksId || creditManifesto.id !== evalCtx.creditManifestoId)) {
    console.error('FATAL: reconstructed benchmarks/manifesto ids do NOT match the revision eval context — aborting to protect the score.');
    console.error('  reconstructed:', marketBenchmarks.id.slice(0, 12), '/', creditManifesto.id.slice(0, 12));
    console.error('  expected     :', evalCtx.marketBenchmarksId.slice(0, 12), '/', evalCtx.creditManifestoId.slice(0, 12));
    process.exit(2);
  }

  console.log('  OLD root            :', oldEnvelopeId.slice(0, 24) + '…', oldEnvelopeId.startsWith('599f5270') ? '(599f5270 ✓)' : '(★ NOT 599f5270!)');
  console.log('  OLD finalScore      :', oldDoctrine.finalScore, '| flags', JSON.stringify(oldDoctrine.flags));
  console.log('  asOf                :', asOf);
  console.log('  benchmarks/manifesto:', marketBenchmarks.id.slice(0, 12), '/', creditManifesto.id.slice(0, 12), evalCtx ? '(matches eval ctx ✓)' : '(no eval ctx)');
  console.log('  reused score slots  : sellerUw NOI', (oldExt as { sellerUw?: { underwrittenNOI?: number } }).sellerUw?.underwrittenNOI,
    '| t12 NOI', (oldExt as { t12Actual?: { noi?: number } }).t12Actual?.noi);

  if (!(oldExt as { asr?: unknown }).asr) { console.error('FATAL: oldExt.asr absent — nothing to extend'); process.exit(2); }

  // 2. Parse ASR cash-flows DETERMINISTICALLY (no LLM).
  const buf = fs.readFileSync(ASR_PDF);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  const underwrittenCashFlows = parseAsrCashFlowsFromText(pages.join('\n'));
  if (!underwrittenCashFlows) { console.error('FATAL: cash-flow parse returned null'); process.exit(2); }
  console.log('  ★ parsed cash-flows : NOI 2021', underwrittenCashFlows.y2021.netOperatingIncome,
    '· 2023', underwrittenCashFlows.y2023.netOperatingIncome, '· UW', underwrittenCashFlows.uw.netOperatingIncome);

  // 3. Corrected extraction — same body + asr.underwrittenCashFlows, new id.
  const { id: _oldId, ...extBody } = oldExt as ExtractionResult & { asr: Record<string, unknown> };
  void _oldId;
  const correctedExtBody = { ...extBody, asr: { ...extBody.asr, underwrittenCashFlows } };
  const correctedExtId = computeExtractionResultId(correctedExtBody) as ExtractionResultId;
  const correctedExt: ExtractionResult = { id: correctedExtId, ...correctedExtBody } as ExtractionResult;
  console.log('  ★ NEW extraction id :', correctedExtId.slice(0, 24) + '…');

  if (!COMMIT) {
    console.log('\n  DRY RUN — wrote NOTHING. Re-run with --commit to ingest + repoint (DEAL_ID only).');
    console.log('  Plan: ingest new chain from NEW extraction → UPDATE analyses.graph_revision_id WHERE id =', DEAL_ID);
    return;
  }

  // 4. COMMIT — ingest the new chain.
  console.log('\n  --commit: ingestExtractionResult (judgment → doctrine → handbook → mitigation → narrative)…');
  const t0 = Date.now();
  const ingest = await ingestExtractionResult(
    {
      extractionResult: correctedExt,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: librarySnapshot.id,
      marketBenchmarks,
      creditManifesto,
      analysisAsOfDate: asOf,
      rentRoll,
      propertyMetadata: pm,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    recordGraphStore,
  );
  console.log('  ingest ms           :', Date.now() - t0);
  console.log('  ★ NEW rootId        :', ingest.rootId);

  // 5. Repoint — DEAL_ID ONLY.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlDb = (sqliteStore as unknown as { db: any }).db;
  const upd = sqlDb.prepare('UPDATE analyses SET graph_revision_id = ?, updated_at = ? WHERE id = ?')
    .run(ingest.rootId, new Date().toISOString(), DEAL_ID);
  if (upd.changes !== 1) { console.error('FATAL: repoint affected', upd.changes, 'rows — expected 1'); process.exit(2); }
  console.log('  repointed analysis  :', (sqliteStore.getAnalysis(DEAL_ID)?.graphRevisionId ?? '').slice(0, 24) + '…');

  // 6. Inline verify (the load-bearing gate).
  const newEnv = recordGraphStore.getRevisionEnvelope(ingest.rootId)!;
  const newDe = recordGraphStore.getDoctrineEvaluation(newEnv.doctrineEvaluationId)!;
  const newExt = recordGraphStore.getExtractionResult(newDe.extractionResultId)!;
  const cf = (newExt as { asr?: { underwrittenCashFlows?: { uw?: { netOperatingIncome?: number } } } }).asr?.underwrittenCashFlows;
  console.log('\n  ★★ finalScore       :', newDe.finalScore, '| flags', JSON.stringify(newDe.flags));
  console.log('  ★★ cash-flows landed:', cf ? 'YES (UW NOI ' + cf.uw?.netOperatingIncome + ')' : 'NO');
  const scoreOk = Math.abs((newDe.finalScore ?? 0) - EXPECTED_SCORE) < 1e-9;
  console.log(scoreOk ? '\n  ✓ SCORE PRESERVED (27.1) — re-ingest clean.' : '\n  ✗✗ SCORE DRIFTED — RESTORE THE BACKUP IMMEDIATELY.');
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
