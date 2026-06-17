/**
 * Real-deal validation run.
 *
 * Ingests the Sunroad Centrum fixture (real CF + real PCA) through the
 * production graph/new-spine pipeline with the LIVE Anthropic LLM (no
 * stub). Writes to the production data/cre.db via the singleton stores.
 * Idempotent at the content-hash level — re-running with the same
 * fixture produces the same graph rootId.
 *
 * Pipeline exercised:
 *   1. buildExtractionResult (composer) — real PCA adapter Call A
 *      (AI extraction of scalars + narratives) + Call B (deterministic
 *      pdfjs schedule extraction). Real LLM call.
 *   2. ingestExtractionResult → judgment engine → handbook engine →
 *      doctrine engine → evaluateAndNarrate. Real narrative LLM calls
 *      (4 slots: executive_summary / red_flag_assessment /
 *      mitigation_suggestions / committee_recommendation).
 *
 * After ingest, dumps:
 *   - HE: fired-flag list + skip breakdown
 *   - DE: finalScore / ratingBand / componentScores
 *   - NE: all 4 narrative slots verbatim + consumed-flag-id lists
 *
 * Optionally promotes to a legacy Analysis row so the demo page can
 * render the result.
 *
 *   npx tsx /tmp/validation-real-deal.ts            # ingest + dump
 *   npx tsx /tmp/validation-real-deal.ts --promote  # also create legacy analysis row
 */

// NOTE on cwd: env.ts loads .env via `config({ path: resolve(process.cwd(),
// '../../.env') })`, which resolves correctly only when cwd is `apps/api`.
// Run this script with that cwd or set ANTHROPIC_API_KEY in the shell first.
// ES imports hoist above any top-level dotenv call, so we cannot inject the
// env var from this file without changing production code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  MarketBenchmarks,
} from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { store as sqliteStore } from '../storage/sqlite-store.js';
import { buildExtractionResult } from '../services/extraction/build-extraction-result.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const CF_PATH  = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-cf.xlsx');
const PCA_PATH = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-pca.pdf');
const ASR_PATH = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/.data/source-docs/3327fd55-e382-4286-8378-64d33a11e518/asr/645d573b6ad281d851c846bacc5441e495c154d33bdd8d029447f778c0c90514.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;
const PROMOTE = process.argv.includes('--promote');

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 11_000_000,
  interestRate: 0.07,
  amortization: 360,
  interestOnlyPeriod: 0,
  maturityDate: '2031-05-08T00:00:00Z' as ISODateTime,
};

(async () => {
  console.log('============================================================');
  console.log('REAL-DEAL VALIDATION RUN');
  console.log('============================================================');
  console.log(`As-of:        ${AS_OF}`);
  console.log(`CF fixture:   ${CF_PATH}`);
  console.log(`PCA fixture:  ${PCA_PATH}`);
  console.log(`LLM mode:     LIVE (no stub) — narrative producer omits deps.llmCall`);
  console.log('');

  const lib = makeSnapshot();
  recordGraphStore.insertLibrarySnapshot(lib);

  console.log('Step 1a — composer (buildExtractionResult). Real PCA adapter, real LLM.');
  const t0 = Date.now();
  const cfBuf = readFileSync(CF_PATH);
  const pcaBuf = readFileSync(PCA_PATH);
  const asrBuf = readFileSync(ASR_PATH);
  console.log(`  CF bytes:  ${cfBuf.length}`);
  console.log(`  PCA bytes: ${pcaBuf.length}`);
  console.log(`  ASR bytes: ${asrBuf.length}`);
  const composed = await buildExtractionResult({
    slots: {
      sellerCfXlsx: { buffer: cfBuf, filename: 'sunroad-centrum-cf.xlsx' },
      pcaPdf:       { buffer: pcaBuf, filename: 'sunroad-centrum-pca.pdf' },
      asrPdf:       { buffer: asrBuf, filename: 'sunroad-centrum-asr.pdf' },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-CENTRUM-REAL',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);
  console.log(`  slot reports:`);
  for (const [slot, report] of Object.entries(composed.report.slots)) {
    console.log(`    ${slot.padEnd(16)} status=${report.status}`);
  }
  console.log(`  extractionResult.id: ${composed.extractionResult.id}`);
  console.log(`  propertyMetadata: ${composed.propertyMetadata ? composed.propertyMetadata.id : 'null'}`);
  console.log('');

  console.log('Step 1b — ingest (judgment → doctrine → narrative). Real LLM × 4.');
  const t1 = Date.now();
  const ingest = await ingestExtractionResult(
    {
      extractionResult: composed.extractionResult,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
      propertyMetadata: composed.propertyMetadata,  // Sprint-0: persist PM through ingest
    },
    recordGraphStore,
    /* no deps → real LLM */
  );
  console.log(`  ingest ms: ${Date.now() - t1}`);
  console.log(`  rootId:        ${ingest.rootId}`);
  console.log(`  evaluationId:  ${ingest.evaluationId}`);
  console.log('');

  // Fetch substrate.
  const envelope = recordGraphStore.getRevisionEnvelope(ingest.rootId);
  if (envelope === null) { console.error('FATAL: envelope null'); process.exit(1); }
  const de = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (de === null) { console.error('FATAL: DE null'); process.exit(1); }
  const he = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (he === null) { console.error('FATAL: HE null'); process.exit(1); }
  const ne = recordGraphStore.getLatestNarrativeForAdjustedInputs(envelope.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  if (ne === null) { console.error('FATAL: NE null'); process.exit(1); }

  // ====================================================================
  // STEP 2 — Substrate diagnostics
  // ====================================================================
  console.log('============================================================');
  console.log('STEP 2 — SUBSTRATE DIAGNOSTICS');
  console.log('============================================================');
  console.log('');
  console.log('HandbookEvaluation');
  console.log(`  handbookVersion: ${he.handbookVersion}`);
  console.log(`  engineVersion:   ${he.engineVersion}`);
  console.log(`  firedFlags:      ${he.firedFlags.length}`);
  for (const f of he.firedFlags) {
    console.log(`    [${f.severity.padEnd(8)}] ${f.principleId}`);
    console.log(`        ${f.flag_message}`);
  }
  const skipReasons = new Map<string, number>();
  for (const s of he.skippedPrinciples) {
    skipReasons.set(s.reason, (skipReasons.get(s.reason) ?? 0) + 1);
  }
  console.log(`  skippedPrinciples: ${he.skippedPrinciples.length}`);
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(22)} ${count}`);
  }
  // missing_field detail — these are the load-bearing skips
  const missingFieldSkips = he.skippedPrinciples.filter((s) => s.reason === 'missing_field');
  if (missingFieldSkips.length > 0) {
    console.log(`  missing_field detail (${missingFieldSkips.length}):`);
    for (const s of missingFieldSkips) {
      console.log(`    ${s.principleId.padEnd(16)} ${s.detail ?? ''}`);
    }
  }
  console.log('');

  console.log('DoctrineEvaluation');
  console.log(`  doctrineVersion: ${de.doctrineVersion}`);
  console.log(`  finalScore:      ${de.finalScore}`);
  console.log(`  ratingBand:      ${de.ratingBand}`);
  console.log(`  mechanicalScore: ${de.mechanicalScore}`);
  console.log(`  weightedAggregate: ${de.weightedAggregate}`);
  console.log(`  componentScores (${de.componentScores.length}):`);
  const sortedComponents = [...de.componentScores].sort((a, b) => a.score - b.score);
  for (const c of sortedComponents) {
    const flag = c.score < 50 ? ' ← LOW' : c.score >= 80 ? ' ← high' : '';
    console.log(`    ${c.componentId.padEnd(20)} score=${c.score.toFixed(1).padStart(6)}  weight=${c.weight.toString().padStart(3)}  contribution=${c.contribution.toFixed(2).padStart(7)}${flag}`);
  }
  console.log(`  flags: ${de.flags.length}`);
  console.log(`  reasons: ${de.reasons.length}`);
  console.log('');

  // ====================================================================
  // STEP 3 — Narrative verbatim
  // ====================================================================
  console.log('============================================================');
  console.log('STEP 3 — NARRATIVE (VERBATIM)');
  console.log('============================================================');
  console.log(`narrativeEvaluation.id:        ${ne.id}`);
  console.log(`narrativeEvaluation.engineVersion: ${ne.engineVersion}`);
  console.log(`handbookEvaluationId:          ${ne.handbookEvaluationId}`);
  console.log('');
  console.log('--- executiveSummary ---');
  console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...ne.consumedFlagPrincipleIds])}`);
  console.log('');
  console.log(ne.executiveSummary);
  console.log('');
  console.log('--- redFlagAssessment ---');
  console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...ne.redFlagAssessmentConsumedFlagPrincipleIds])}`);
  console.log('');
  console.log(ne.redFlagAssessment);
  console.log('');
  console.log('--- mitigationSuggestions ---');
  console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...ne.mitigationSuggestionsConsumedFlagPrincipleIds])}`);
  console.log('');
  console.log(ne.mitigationSuggestions);
  console.log('');
  console.log('--- committeeRecommendation ---');
  console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...ne.committeeRecommendationConsumedFlagPrincipleIds])}`);
  console.log('');
  console.log(ne.committeeRecommendation);
  console.log('');

  // ====================================================================
  // STEP 4 — Promote (optional)
  // ====================================================================
  if (PROMOTE) {
    console.log('============================================================');
    console.log('STEP 4 — PROMOTE TO LEGACY ANALYSIS');
    console.log('============================================================');
    const id = uuid();
    const now = new Date().toISOString();
    const analysis: Analysis = {
      id,
      name: 'Sunroad Centrum (real-deal validation)',
      assetType: 'office',
      status: 'complete',
      progress: 100,
      currentStep: 'Complete (promoted from graph)',
      createdAt: now,
      updatedAt: now,
      document: null,
      uwDocument: null,
      supportingDocuments: [],
      templateDocument: null,
      findings: [],
      creditScore: null,
      uwModel: null,
      research: null,
      crossCheckFindings: [],
      mitigations: [],
      executiveSummary: null,
      bPieceDecision: null,
      comments: [],
      criteriaEvaluations: [],
      stressScenarios: [],
      graphRevisionId: ingest.rootId,
    };
    sqliteStore.createAnalysis(analysis);
    console.log(`  analysisId:    ${id}`);
    console.log(`  graphRevisionId: ${ingest.rootId}`);
    console.log(`  URL:           http://localhost:3000/analysis/${id}`);
  } else {
    console.log('STEP 4 skipped — pass --promote to mint a legacy Analysis row.');
  }

  console.log('');
  console.log('============================================================');
  console.log('VALIDATION RUN COMPLETE');
  console.log('============================================================');
  process.exit(0);
})().catch((e) => {
  console.error('validation script threw:', e);
  process.exit(2);
});
