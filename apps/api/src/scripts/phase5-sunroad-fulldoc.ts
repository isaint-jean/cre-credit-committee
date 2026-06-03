/**
 * Phase 5 — Sunroad re-run with REAL ASR + real CF + real PCA. NO appraisal.
 *
 *   cd apps/api && npx tsx src/scripts/phase5-sunroad-fulldoc.ts
 *
 * Writes to data/phase5-sunroad-fulldoc.db (SEPARATE from production
 * data/cre.db — third reminder; do not wipe the prod db).
 *
 * Inputs:
 *   - ASR PRELIM (2023-07-19).pdf   → asrPdf slot → produces PropertyMetadata
 *     (UNBLOCKS the 4 missing_field principles: P-II-8, P-IV-OFF-2,
 *      P-IV-OFF-9, P-IV-OFF-6)
 *   - CF PRELIM (2023-07-25).xlsx   → sellerCfXlsx slot
 *   - PCA Report .. 080323.pdf      → pcaPdf slot
 *   - NO appraisal: not supplied; the only appraisal on hand is for a
 *     different property — supplying it would poison valuation reasoning.
 *
 * Loan terms: $80M @ 7% / 30-yr amort / 60-mo balloon (same as prior phase4
 * run). The CF / seller UW does not encode loan terms in the structure
 * the composer extracts, so they're caller-supplied; the figure is a
 * plausible market-LTV-anchored set (Sunroad ~$113M implied value at
 * library 7.5% cap → ~70% LTV at $80M loan).
 *
 * Live LLM throughout (no stub).
 */

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

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
const DB_PATH = path.join(REPO, 'apps/api/data/phase5-sunroad-fulldoc.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
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
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
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

// Corrected per the Sunroad answer-key Property & Loan Summary (Phase A loan-
// fix prerequisite — 2026-06-02). Real Sunroad loan: $82.46M @ 7.9% IO-only
// (60mo IO over 60mo term, amortization=0).
const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

(async () => {
  console.log('============================================================');
  console.log('PHASE 5 — Sunroad full-doc (ASR + CF + PCA), no appraisal');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    const ok = existsSync(p);
    console.log(`  ${label.padEnd(4)} ${ok ? '✓' : '✗'} ${p}`);
    if (!ok) { console.error('FATAL: input missing'); process.exit(1); }
  }
  console.log(`  DB:  ${DB_PATH}  (separate from data/cre.db)`);
  console.log(`  Loan: $${LOAN_TERMS.loanAmount?.toLocaleString() ?? 'null'} @ ${LOAN_TERMS.interestRate === null ? 'null' : (LOAN_TERMS.interestRate * 100).toFixed(2)}%`);
  console.log('');

  const store = new RecordGraphStore(DB_PATH);

  console.log('--- Step 1a: composer (ASR + CF + PCA adapters, real LLM)');
  const t0 = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE5-FULLDOC',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);
  for (const [slot, report] of Object.entries(composed.report.slots)) {
    console.log(`    ${slot.padEnd(16)} status=${report.status}`);
  }
  console.log(`  extractionResult.id:    ${composed.extractionResult.id}`);
  console.log(`  propertyMetadata.id:    ${composed.propertyMetadata?.id ?? 'null'}`);
  if (composed.propertyMetadata !== null) {
    const pm = composed.propertyMetadata;
    console.log(`    propertyName:         ${pm.propertyName}`);
    console.log(`    propertySubtype:      ${pm.propertySubtype}`);
    console.log(`    buildingClass:        ${pm.buildingClass}`);
    console.log(`    msa:                  ${pm.msa}`);
    console.log(`    yearBuilt:            ${pm.yearBuilt}`);
    console.log(`    totalSquareFeet:      ${pm.totalSquareFeet}`);
    console.log(`    occupancyPhysical:    ${pm.occupancyPhysical}`);
  }
  console.log(`  ExtractionResult.appraisal: ${composed.extractionResult.appraisal === null ? 'null (correct — no appraisal supplied)' : JSON.stringify(composed.extractionResult.appraisal)}`);

  console.log('\n--- Step 1b: ingest (judgment → doctrine → handbook[+LLM] → narrative)');
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
    // no deps → live LLM for both LLM_CONTEXT principles and narrative
  );
  console.log(`  ingest ms: ${Date.now() - t1}`);
  console.log(`  rootId:        ${ingest.rootId}`);
  console.log(`  evaluationId:  ${ingest.evaluationId}`);

  const envelope = store.getRevisionEnvelope(ingest.rootId as RevisionId);
  if (envelope === null) throw new Error('envelope null');
  const de = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (de === null) throw new Error('DE null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (he === null) throw new Error('HE null');
  const ne = store.getLatestNarrativeForAdjustedInputs(envelope.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  if (ne === null) throw new Error('NE null');
  const ai = store.getAdjustedInputs(envelope.adjustedInputsId);

  // ====================================================================
  // Step 2 — substrate diagnostics
  // ====================================================================
  console.log('\n============================================================');
  console.log('STEP 2 — SUBSTRATE DIAGNOSTICS');
  console.log('============================================================');
  console.log(`HE id:             ${he.id}`);
  console.log(`engineVersion:     ${he.engineVersion}`);
  console.log(`firedFlags:        ${he.firedFlags.length}`);
  console.log(`skippedPrinciples: ${he.skippedPrinciples.length}`);

  const skipReasons = new Map<string, number>();
  for (const s of he.skippedPrinciples) {
    skipReasons.set(s.reason, (skipReasons.get(s.reason) ?? 0) + 1);
  }
  console.log(`  Skip breakdown:`);
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(22)} ${count}`);
  }
  // Specific: did the 4 missing_field principles now evaluate?
  const targets = ['P-II-8', 'P-IV-OFF-2', 'P-IV-OFF-9', 'P-IV-OFF-6'];
  console.log(`  Specific check — 4 previously-missing_field principles:`);
  for (const pid of targets) {
    const fired = he.firedFlags.find((f) => f.principleId === pid);
    const skipped = he.skippedPrinciples.find((s) => s.principleId === pid);
    if (fired) console.log(`    ${pid.padEnd(14)} FIRED  severity=${fired.severity}`);
    else if (skipped) console.log(`    ${pid.padEnd(14)} skipped reason=${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ''}`);
    else console.log(`    ${pid.padEnd(14)} not present (?)`);
  }

  // Deterministic vs LLM split: LLM principles fire with metricValue null +
  // groupIndex/bandIndex 0 (per Phase 2 design). Deterministic principles
  // carry real metricValue + non-zero indices.
  const llmFired = he.firedFlags.filter((f) => f.metricValue === null && f.groupIndex === 0 && f.bandIndex === 0);
  const deterministicFired = he.firedFlags.filter((f) => !(f.metricValue === null && f.groupIndex === 0 && f.bandIndex === 0));
  console.log(`  Fired split (heuristic):`);
  console.log(`    LLM_CONTEXT-fired:    ${llmFired.length}`);
  console.log(`    DETERMINISTIC-fired:  ${deterministicFired.length}`);
  if (deterministicFired.length > 0) {
    console.log(`    Deterministic firers:`);
    for (const f of deterministicFired) console.log(`      ${f.principleId}  severity=${f.severity}  metricValue=${JSON.stringify(f.metricValue)}`);
  }

  console.log(`\nDoctrineEvaluation:`);
  console.log(`  finalScore:      ${de.finalScore}`);
  console.log(`  ratingBand:      ${de.ratingBand}`);
  if (ai) {
    console.log(`  AI.metrics.noi:        ${ai.metrics.noi}`);
    console.log(`  AI.metrics.dscr:       ${ai.metrics.dscr}`);
    console.log(`  AI.metrics.ltvAppraisal: ${ai.metrics.ltvAppraisal}`);
    console.log(`  AI.metrics.debtYield:  ${ai.metrics.debtYield}`);
    console.log(`  AI.metrics.value:      ${ai.metrics.value}`);
  }

  // ====================================================================
  // Step 3 — classification
  // ====================================================================
  console.log('\n============================================================');
  console.log('STEP 3 — FIRED-FLAG CLASSIFICATION (economics vs missing-data)');
  console.log('============================================================');

  // Heuristic classifier — substring matching on the LLM-authored flag_message.
  // Bucket B markers: "missing", "no [X] provided", "lacks [data]", "not provided",
  //   "no data", "absence of", "without", "unable to", "cannot perform", "preventing"
  // Bucket A markers: stated numeric metrics (DSCR, LTV, NOI, occupancy %),
  //   property attributes (Class B, MSA, age years), stress-scenario references
  //   that don't say "missing".
  const isMissingData = (msg: string): boolean => {
    const m = msg.toLowerCase();
    return /\b(missing|no\s+\w+\s+(data|provided|documentation|provided)|lacks|not\s+provided|absence\s+of|unable\s+to|cannot\s+perform|preventing|impair(s|ed|ing)?\s+(proper|the)|without\s+(specific|adequate|sufficient)|lack(s|ing)?\s+(any|tenant|sublease|leasing|sales|actual|specific))/.test(m);
  };
  const hasNumericEvidence = (msg: string): boolean => {
    return /\$[\d,]+|\d+(\.\d+)?\s*(%|x|years?|sqft|months?)\b|dscr\s*(of|=|reaches|falling|at)\s*\d|ltv\s*(of|=|reaches|rising|at)\s*\d|occupancy\s+at\s+\d|class\s+[a-c]\b/i.test(msg);
  };
  const bucketize = (msg: string): 'A' | 'B' | 'C' => {
    const missing = isMissingData(msg);
    const numeric = hasNumericEvidence(msg);
    if (missing && !numeric) return 'B';
    if (!missing && numeric) return 'A';
    if (numeric && missing) return 'C';
    if (numeric) return 'A';
    if (missing) return 'B';
    return 'C';
  };

  const buckets: Record<'A' | 'B' | 'C', { pid: string; severity: string; msg: string }[]> = { A: [], B: [], C: [] };
  for (const f of he.firedFlags) {
    buckets[bucketize(f.flag_message)].push({ pid: f.principleId, severity: f.severity, msg: f.flag_message });
  }

  for (const [bucket, label] of [
    ['A', 'ECONOMICS-GROUNDED — fired on actual property/deal metric or characteristic'],
    ['B', 'MISSING-DATA — fired because an input is absent'],
    ['C', 'MIXED / borderline — both numeric evidence AND missing-data complaint'],
  ] as const) {
    const items = buckets[bucket];
    console.log(`\nBucket ${bucket} (${items.length}): ${label}`);
    for (const it of items) {
      console.log(`  [${it.severity.padEnd(8)}] ${it.pid}`);
      console.log(`      ${it.msg}`);
    }
  }

  // ====================================================================
  // Step 4 — narrative verbatim
  // ====================================================================
  console.log('\n============================================================');
  console.log('STEP 4 — NARRATIVE (VERBATIM)');
  console.log('============================================================');
  console.log(`NE id:             ${ne.id}`);
  console.log(`engineVersion:     ${ne.engineVersion}`);
  console.log('');
  for (const slot of ['executiveSummary', 'redFlagAssessment', 'mitigationSuggestions', 'committeeRecommendation'] as const) {
    const consumedKey = slot === 'executiveSummary'
      ? 'consumedFlagPrincipleIds'
      : `${slot}ConsumedFlagPrincipleIds`;
    console.log(`--- ${slot} ---`);
    console.log(`consumedFlagPrincipleIds: ${JSON.stringify([...(ne as never as Record<string, unknown[]>)[consumedKey]])}`);
    console.log('');
    console.log(ne[slot]);
    console.log('');
  }

  store.close();
  console.log('============================================================');
  console.log('PHASE 5 COMPLETE');
  console.log('============================================================');
  process.exit(0);
})().catch((e) => {
  console.error('phase 5 script threw:', e);
  process.exit(2);
});
