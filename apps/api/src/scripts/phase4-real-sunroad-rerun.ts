/**
 * Phase 4 — Real Sunroad re-run with REALISTIC loan terms + live LLM.
 *
 *   cd apps/api && npx tsx src/scripts/phase4-real-sunroad-rerun.ts
 *
 * - Writes to a SEPARATE db (data/phase4-sunroad.db). Does NOT touch
 *   the production data/cre.db.
 * - Loan terms: $80M @ 7%, 30-year amort, 60-month balloon — REALISTIC
 *   for a ~$113M-value Sunroad asset (vs the prior synthetic $11M
 *   which produced a non-credible DSCR of 9.7).
 * - Live LLM via the production callAIWithContinuation (no stub). The
 *   LLM_CONTEXT evaluator fires for the 7 universal principles.
 * - Runs the ingest TWICE. Confirms second run hits the LLM cache and
 *   produces an identical HE id (cache-hit determinism).
 * - Dumps: fired flags (deterministic + LLM) verbatim; the 4 narrative
 *   slots verbatim; HE id comparison.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';

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
  RevisionId,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildExtractionResult } from '../services/extraction/build-extraction-result.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const CF_PATH = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-cf.xlsx');
const PCA_PATH = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-pca.pdf');
const DB_PATH = path.join(REPO, 'apps/api/data/phase4-sunroad.db');
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

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
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Office: 0.10 },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50), Office: 8.50 },
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

/**
 * REALISTIC loan terms for Sunroad. Asset NOI ~$8.5M; at a 7.5% library
 * cap → value ~$113M. Assumption: ~70% LTV → $80M loan. 7% interest,
 * 30-year amort, 5-year balloon (60mo term). Conventional CRE structure.
 *
 *   loanAmount       = $80,000,000
 *   interestRate     = 0.07
 *   amortization     = 360  (months)
 *   interestOnly     = 0
 *   maturityDate     = 2031-05-31  (60mo from as-of)
 *
 * Expected derived metrics on a real-deal evaluation:
 *   annual debt service ≈ $6.39M (P&I on $80M @ 7% / 30yr amort)
 *   DSCR  ≈ 8.5 / 6.39 = 1.33
 *   LTV   ≈ 80 / 113   = 0.71
 *   debt yield ≈ 8.5 / 80 = 0.106
 *
 * These are plausibly-leveraged numbers that several LLM_CONTEXT
 * principles can comment on substantively (vs the prior synthetic
 * $11M loan which trivially yielded DSCR 9.7 / LTV ~10%).
 */
const REALISTIC_LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 80_000_000,
  interestRate: 0.07,
  amortization: 360,
  interestOnlyPeriod: 0,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

async function runOnce(store: RecordGraphStore, label: string) {
  console.log(`\n--- ${label}: composer (real PCA AI extraction)`);
  const t0 = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      sellerCfXlsx: { buffer: readFileSync(CF_PATH), filename: 'sunroad-centrum-cf.xlsx' },
      pcaPdf: { buffer: readFileSync(PCA_PATH), filename: 'sunroad-centrum-pca.pdf' },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-CENTRUM-PHASE4-REAL',
    loanTerms: REALISTIC_LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);
  console.log(`  extractionResult.id: ${composed.extractionResult.id}`);

  console.log(`\n--- ${label}: ingest (judgment → doctrine → handbook[+LLM] → narrative)`);
  const t1 = Date.now();
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
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
    },
    store,
    // no deps → real LLM for both narrative AND LLM_CONTEXT principles
  );
  console.log(`  ingest ms: ${Date.now() - t1}`);
  console.log(`  rootId: ${ingest.rootId}`);
  console.log(`  evaluationId: ${ingest.evaluationId}`);

  const envelope = store.getRevisionEnvelope(ingest.rootId as RevisionId);
  if (envelope === null) throw new Error('envelope null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (he === null) throw new Error('HE null');
  const ne = store.getLatestNarrativeForAdjustedInputs(envelope.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  if (ne === null) throw new Error('NE null');
  return { ingest, he, ne };
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 4 — Sunroad re-run, REALISTIC loan terms, LIVE LLM');
  console.log('============================================================');
  console.log(`DB path:      ${DB_PATH}  (separate from production data/cre.db)`);
  console.log(`Loan amount:  $${REALISTIC_LOAN_TERMS.loanAmount?.toLocaleString() ?? 'null'}`);
  console.log(`Interest:     ${REALISTIC_LOAN_TERMS.interestRate === null ? 'null' : (REALISTIC_LOAN_TERMS.interestRate * 100).toFixed(2)}%`);
  console.log(`Amort:        ${REALISTIC_LOAN_TERMS.amortization}mo (30yr)`);
  console.log(`Maturity:     ${REALISTIC_LOAN_TERMS.maturityDate}`);
  console.log('');

  const store = new RecordGraphStore(DB_PATH);

  // First run: cold start. Composer + ingest run the real LLM for the
  // PCA adapter, the LLM_CONTEXT evaluator (7 principles), and the
  // narrative producer (4 slots).
  const run1 = await runOnce(store, 'run 1');

  console.log('\n============================================================');
  console.log('FIRED FLAGS (run 1)');
  console.log('============================================================');
  console.log(`HandbookEvaluation id:     ${run1.he.id}`);
  console.log(`handbookEngineVersion:     ${run1.he.engineVersion}`);
  console.log(`firedFlags:                ${run1.he.firedFlags.length}`);
  for (const f of run1.he.firedFlags) {
    console.log(`  [${f.severity.padEnd(8)}] ${f.principleId}`);
    console.log(`      ${f.flag_message}`);
  }

  console.log(`\nSkippedPrinciples (${run1.he.skippedPrinciples.length}):`);
  const skipReasons = new Map<string, number>();
  for (const s of run1.he.skippedPrinciples) {
    skipReasons.set(s.reason, (skipReasons.get(s.reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(22)} ${count}`);
  }

  console.log('\n============================================================');
  console.log('NARRATIVE — run 1 (verbatim)');
  console.log('============================================================');
  console.log(`NarrativeEvaluation id:    ${run1.ne.id}`);
  console.log(`engineVersion:             ${run1.ne.engineVersion}`);
  console.log('');
  for (const slot of ['executiveSummary', 'redFlagAssessment', 'mitigationSuggestions', 'committeeRecommendation'] as const) {
    const consumedKey = slot === 'executiveSummary'
      ? 'consumedFlagPrincipleIds'
      : `${slot}ConsumedFlagPrincipleIds`;
    console.log(`--- ${slot} ---`);
    console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...(run1.ne as never as Record<string, unknown[]>)[consumedKey]])}`);
    console.log('');
    console.log(run1.ne[slot]);
    console.log('');
  }

  // Second run: identical inputs → cache should hit for both the
  // extraction-input-cache (composer short-circuit) AND the
  // llm-principle-eval-cache (LLM_CONTEXT principles return cached
  // results). HE id must match exactly (content-stability invariant).
  console.log('\n============================================================');
  console.log('RUN 2 — cache-determinism check');
  console.log('============================================================');
  const run2 = await runOnce(store, 'run 2');

  console.log('');
  console.log(`run1.he.id: ${run1.he.id}`);
  console.log(`run2.he.id: ${run2.he.id}`);
  console.log(`HE id match: ${run1.he.id === run2.he.id ? '✓ IDENTICAL (cache held)' : '✗ DIFFERENT (cache miss — investigate)'}`);
  console.log(`firedFlags counts: run1=${run1.he.firedFlags.length}  run2=${run2.he.firedFlags.length}`);
  console.log(`run1.ne.id: ${run1.ne.id}`);
  console.log(`run2.ne.id: ${run2.ne.id}`);
  console.log(`NE id match: ${run1.ne.id === run2.ne.id ? '✓ IDENTICAL' : '✗ DIFFERENT (narrative LLM is per-call non-deterministic; this can vary even with cached HE)'}`);

  store.close();
  console.log('\n============================================================');
  console.log('PHASE 4 COMPLETE');
  console.log('============================================================');
  process.exit(0);
})().catch((e) => {
  console.error('phase 4 script threw:', e);
  process.exit(2);
});
