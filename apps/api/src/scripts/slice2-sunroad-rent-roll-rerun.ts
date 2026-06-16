/**
 * DEAL END-TO-END Slice 2 — re-run Sunroad through the chain with the ASR's
 * real rent roll on page 14.
 *
 *   cd apps/api && npx tsx src/scripts/slice2-sunroad-rent-roll-rerun.ts
 *
 * The original `validation-real-deal.ts` produced cre.db's hollow Sunroad
 * analysis (e8778e74-…) by feeding ONLY CF + PCA into the composer. The ASR
 * slot was absent → no AI rent-roll extraction → no rent roll → no handbook
 * flags → no mitigants. This run adds the asrPdf slot (the 16-page real ASR
 * the rent-roll dig located), which fires the ASR adapter's rentRollFallback
 * path → composer.rentRoll non-null → ingest threads it into the chain.
 *
 * Verification discipline (★ HONESTY GATE):
 *   After buildExtractionResult and BEFORE ingestion, the script verifies the
 *   AI-extracted rent roll against the ASR p.14 ground truth surfaced by the
 *   dig (10 tenants, ~274,758 SF, ~$13.38M base rent, named tenants). If the
 *   extraction mis-reads the table (wrong count, dropped rows, garbled
 *   numbers), the script EXITS NON-ZERO before touching the chain. A wrong
 *   rent roll produces a confident-but-wrong analysis, which is worse than a
 *   hollow one.
 *
 * Identity reconciliation:
 *   New ExtractionResult (different content hash because rent roll changes
 *   payload) → new graph chain → new revision id. The script promotes to a
 *   NEW legacy Analysis row, then DELETES the old hollow one
 *   (e8778e74-8ac8-4777-9e09-6671c2ec3ed1) so the Slice-1 funnel fallback
 *   resolves cleanly to the new full one.
 *
 * Cost (real LLM):
 *   ASR adapter: 3 calls (rentRoll + propertyMetadata + asrExtraction).
 *   PCA adapter: 1 call (Call A).
 *   evaluateAndNarrate: 4 narrative slots.
 *   Total: ~8 calls × Sonnet-4, expect $1-3.
 */
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
  RentRoll,
  TenantRentRollLine,
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

const REPO = '/Users/isabellesaint-jean/Code/cre-credit-committee';
const CF_PATH  = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-cf.xlsx');
const PCA_PATH = path.join(REPO, 'apps/api/fixtures/sunroad-centrum-pca.pdf');
const ASR_PATH = path.join(REPO, 'apps/api/.data/source-docs/3327fd55-e382-4286-8378-64d33a11e518/asr/645d573b6ad281d851c846bacc5441e495c154d33bdd8d029447f778c0c90514.pdf');
const AS_OF = '2026-06-15T00:00:00Z' as ISODateTime;
const OLD_HOLLOW_ANALYSIS_ID = 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1';

/** ★ Ground truth from the rent-roll dig of ASR p.14. */
const GROUND_TRUTH = {
  tenantCount: 10,
  totalSquareFeetApprox: 274_758,
  totalSquareFeetTolerance: 0.05,                  // 5% — AI rounding tolerable
  baseRentAnnualApprox: 13_380_000,
  baseRentTolerance: 0.05,
  baseRentPsfApprox: 48.71,
  baseRentPsfTolerance: 0.10,                      // wider — depends on whether AI sums all rows
  expectedTenantSubstrings: [
    'GSA', 'EDD', 'AppFolio', 'Cypress', 'Sunroad Asset', 'Conam',
    'Kyocera', 'DRE', 'ABC', 'CDPH',
  ],
  expectedTenantSubstringMinHits: 7,               // tolerate name variation (e.g. "GSA - Cypress" gets one fewer)
};

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
  loanAmount: 75_000_000,
  interestRate: 0.07,
  amortization: 360,
  interestOnlyPeriod: 0,
  maturityDate: '2031-05-08T00:00:00Z' as ISODateTime,
};

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

/** ★ THE HONESTY GATE: verify AI extraction against ASR p.14 dig findings. */
function verifyRentRoll(rr: RentRoll | null): { ok: boolean; reasons: string[]; summary: string[] } {
  const reasons: string[] = [];
  const summary: string[] = [];

  if (rr === null) {
    reasons.push('rent roll is null — ASR adapter failed to produce a fallback');
    return { ok: false, reasons, summary };
  }

  const tenantLines = rr.lines.filter(
    (l): l is TenantRentRollLine => l.kind === 'tenant',
  );
  summary.push(`  asOfDate: ${rr.asOfDate ?? 'null'}`);
  summary.push(`  propertyName: ${rr.propertyName ?? 'null'}`);
  summary.push(`  source: ${rr.source}`);
  summary.push(`  total lines: ${rr.lines.length}  (tenant kind: ${tenantLines.length})`);

  // Tenant count (allow ±2 for AI capturing aggregate rows or splitting tenants).
  const tenantCount = tenantLines.length;
  if (Math.abs(tenantCount - GROUND_TRUTH.tenantCount) > 2) {
    reasons.push(`tenant count ${tenantCount} differs from ASR p.14 ground truth ${GROUND_TRUTH.tenantCount} by > 2`);
  }

  // SF total.
  const totalSf = tenantLines.reduce((sum, l) => sum + (l.squareFeet ?? 0), 0);
  summary.push(`  total square feet (summed): ${totalSf.toLocaleString()}`);
  summary.push(`  ground truth from ASR p.14: ${GROUND_TRUTH.totalSquareFeetApprox.toLocaleString()}`);
  const sfTol = GROUND_TRUTH.totalSquareFeetApprox * GROUND_TRUTH.totalSquareFeetTolerance;
  if (Math.abs(totalSf - GROUND_TRUTH.totalSquareFeetApprox) > sfTol) {
    reasons.push(`total SF ${totalSf.toLocaleString()} > ${(GROUND_TRUTH.totalSquareFeetTolerance * 100).toFixed(0)}% off ground truth ${GROUND_TRUTH.totalSquareFeetApprox.toLocaleString()}`);
  }

  // Base rent total.
  const totalBaseRent = tenantLines.reduce((sum, l) => sum + (l.inPlaceRentAnnual ?? 0), 0);
  summary.push(`  total in-place rent annual: ${fmtUsd(totalBaseRent)}`);
  summary.push(`  ground truth base rent:    ${fmtUsd(GROUND_TRUTH.baseRentAnnualApprox)}`);
  const brTol = GROUND_TRUTH.baseRentAnnualApprox * GROUND_TRUTH.baseRentTolerance;
  if (Math.abs(totalBaseRent - GROUND_TRUTH.baseRentAnnualApprox) > brTol) {
    reasons.push(`total base rent ${fmtUsd(totalBaseRent)} > ${(GROUND_TRUTH.baseRentTolerance * 100).toFixed(0)}% off ground truth ${fmtUsd(GROUND_TRUTH.baseRentAnnualApprox)}`);
  }

  // Named tenants present.
  const allNames = tenantLines.map((l) => (l.tenantName ?? '').toLowerCase()).join(' | ');
  const hits = GROUND_TRUTH.expectedTenantSubstrings.filter((s) => allNames.includes(s.toLowerCase()));
  summary.push(`  named-tenant substring hits: ${hits.length}/${GROUND_TRUTH.expectedTenantSubstrings.length}`);
  summary.push(`  hits: ${hits.join(', ') || '(none)'}`);
  if (hits.length < GROUND_TRUTH.expectedTenantSubstringMinHits) {
    reasons.push(`only ${hits.length} expected tenant names matched — need >= ${GROUND_TRUTH.expectedTenantSubstringMinHits}`);
  }

  // Lease dates: at least 60% of tenants should have BOTH leaseStart and leaseEnd.
  const withDates = tenantLines.filter((l) => l.leaseStart !== null && l.leaseEnd !== null).length;
  summary.push(`  tenants with both lease dates: ${withDates}/${tenantCount}`);
  if (tenantCount > 0 && withDates / tenantCount < 0.6) {
    reasons.push(`only ${withDates}/${tenantCount} tenants carry both leaseStart and leaseEnd (need >= 60%)`);
  }

  return { ok: reasons.length === 0, reasons, summary };
}

(async () => {
  console.log('============================================================');
  console.log('DEAL END-TO-END Slice 2 — Sunroad rent-roll re-run');
  console.log('============================================================');
  console.log(`As-of:        ${AS_OF}`);
  console.log(`CF fixture:   ${CF_PATH}`);
  console.log(`PCA fixture:  ${PCA_PATH}`);
  console.log(`ASR fixture:  ${ASR_PATH}  (★ the new slot)`);
  console.log(`LLM mode:     LIVE (Anthropic Sonnet)`);
  console.log('');

  const lib = makeSnapshot();
  recordGraphStore.insertLibrarySnapshot(lib);

  console.log('Step 1a — composer (buildExtractionResult) WITH asrPdf slot');
  const t0 = Date.now();
  const cfBuf  = readFileSync(CF_PATH);
  const pcaBuf = readFileSync(PCA_PATH);
  const asrBuf = readFileSync(ASR_PATH);
  console.log(`  CF  bytes: ${cfBuf.length}`);
  console.log(`  PCA bytes: ${pcaBuf.length}`);
  console.log(`  ASR bytes: ${asrBuf.length}  (16-page real ASR — page 14 = rent roll)`);
  const composed = await buildExtractionResult({
    slots: {
      sellerCfXlsx: { buffer: cfBuf,  filename: 'sunroad-centrum-cf.xlsx' },
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
  console.log(`  extractionResult.id:   ${composed.extractionResult.id}`);
  console.log(`  propertyMetadata:      ${composed.propertyMetadata ? composed.propertyMetadata.id : 'null'}`);
  console.log(`  rentRoll (typed):      ${composed.rentRoll ? composed.rentRoll.id : 'null'}`);
  console.log('');

  /* ★ THE HONESTY GATE — verify rent roll BEFORE touching the chain. */
  console.log('============================================================');
  console.log('★ STEP 1b — VERIFY rent roll vs ASR p.14 ground truth');
  console.log('============================================================');
  const verify = verifyRentRoll(composed.rentRoll);
  for (const line of verify.summary) console.log(line);
  console.log('');

  if (!verify.ok) {
    console.log('★★★ VERIFICATION FAILED. The chain will NOT run on an unverified extraction.');
    for (const r of verify.reasons) console.log(`  ✗ ${r}`);
    console.log('');
    console.log('A wrong rent roll produces a confident-but-wrong analysis, which is worse');
    console.log('than the hollow one. Re-run after fixing the extractor (prompt or model).');
    process.exit(1);
  }
  console.log('  ✓ ALL CHECKS PASS — rent roll matches ASR p.14 within tolerance.');
  console.log('');

  /* Surface the rent roll for Isabelle's eye. */
  console.log('--- Extracted rent roll (tenant rows) ---');
  if (composed.rentRoll !== null) {
    for (const l of composed.rentRoll.lines) {
      if (l.kind !== 'tenant') continue;
      const tn = l as TenantRentRollLine;
      console.log(`  ${(tn.tenantName ?? '—').padEnd(35)}  ${String(tn.squareFeet ?? '—').padStart(8)} SF  ${fmtUsd(tn.inPlaceRentAnnual).padStart(10)}  lease ${tn.leaseStart ?? '—'} → ${tn.leaseEnd ?? '—'}`);
    }
  }
  console.log('');

  console.log('Step 2 — ingest (judgment → doctrine → handbook → narrative → mitigation). Real LLM × 4.');
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
    },
    recordGraphStore,
  );
  console.log(`  ingest ms: ${Date.now() - t1}`);
  console.log(`  rootId:        ${ingest.rootId}`);
  console.log(`  evaluationId:  ${ingest.evaluationId}`);
  console.log('');

  // Fetch substrate.
  const envelope = recordGraphStore.getRevisionEnvelope(ingest.rootId);
  if (envelope === null) { console.error('FATAL: envelope null'); process.exit(2); }
  const de = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (de === null) { console.error('FATAL: DE null'); process.exit(2); }
  const he = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (he === null) { console.error('FATAL: HE null'); process.exit(2); }
  const ne = recordGraphStore.getLatestNarrativeForAdjustedInputs(envelope.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  if (ne === null) { console.error('FATAL: NE null'); process.exit(2); }

  /* ----- STEP 3 — Substrate diagnostics: BEFORE vs AFTER ----- */
  console.log('============================================================');
  console.log('STEP 3 — BEFORE (hollow Sunroad) vs AFTER (this run)');
  console.log('============================================================');
  console.log('  BEFORE (cre.db hollow e8778e74-…):');
  console.log('    doctrine.finalScore: 29.36  ratingBand: "High Risk"');
  console.log('    doctrine.flags: [INSUFFICIENT_DATA]');
  console.log('    handbook.firedFlags: 0  skippedPrinciples: 87');
  console.log('    narrative.mitigationSuggestions: "No mitigations recommended for this deal."');
  console.log('');
  console.log('  AFTER (this run):');
  console.log(`    doctrine.finalScore: ${de.finalScore.toFixed(2)}  ratingBand: "${de.ratingBand}"`);
  console.log(`    doctrine.flags: ${JSON.stringify(de.flags)}`);
  console.log(`    handbook.firedFlags: ${he.firedFlags.length}  skippedPrinciples: ${he.skippedPrinciples.length}`);
  console.log('');
  console.log('  Fired flag IDs:');
  for (const f of he.firedFlags) {
    const fid = (f as { principleId?: string }).principleId ?? JSON.stringify(f).slice(0, 80);
    console.log(`    - ${fid}`);
  }
  console.log('');

  /* ----- STEP 4 — narrative VERBATIM for Isabelle's eye ----- */
  console.log('============================================================');
  console.log('STEP 4 — NARRATIVE (verbatim, for Isabelle to judge)');
  console.log('============================================================');
  console.log(`narrativeEvaluation.id:           ${ne.id}`);
  console.log(`narrativeEvaluation.engineVersion: ${ne.engineVersion}`);
  console.log('');
  console.log('--- executiveSummary ---');
  console.log(ne.executiveSummary);
  console.log('');
  console.log('--- redFlagAssessment ---');
  console.log(ne.redFlagAssessment);
  console.log('');
  console.log('--- ★ mitigationSuggestions (the killer feature) ---');
  console.log(ne.mitigationSuggestions);
  console.log('');
  console.log('--- committeeRecommendation ---');
  console.log(ne.committeeRecommendation);
  console.log('');

  /* ----- STEP 5 — Promote + old-row cleanup for identity reconciliation ----- */
  console.log('============================================================');
  console.log('STEP 5 — promote + identity reconciliation');
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
  console.log(`  ★ NEW analysisId:        ${id}`);
  console.log(`  graphRevisionId:         ${ingest.rootId}`);
  console.log(`  URL:                     http://localhost:3000/analysis/${id}`);
  console.log('');

  // ----- delete the OLD hollow row so the funnel resolves cleanly -----
  // Slice-1 fallback resolves the pool's 'bmark2024v8-sunroad-centrum' →
  // analyses whose normalized name == 'sunroad centrum'. With both old + new
  // present, the route returns multipleFound:true; deleting the old makes the
  // resolution unambiguous (and the new is the only one with real content).
  const hollowExists = sqliteStore.getAnalysis(OLD_HOLLOW_ANALYSIS_ID);
  if (hollowExists !== null) {
    sqliteStore.deleteAnalysis(OLD_HOLLOW_ANALYSIS_ID);
    console.log(`  ✓ DELETED old hollow analysis row: ${OLD_HOLLOW_ANALYSIS_ID}`);
  } else {
    console.log(`  (old hollow row ${OLD_HOLLOW_ANALYSIS_ID} not found — already gone or never present)`);
  }
  console.log('');
  console.log('============================================================');
  console.log('Slice 2 RUN COMPLETE');
  console.log('============================================================');
  process.exit(0);
})().catch((e) => {
  console.error('slice2 script threw:', e);
  process.exit(2);
});
