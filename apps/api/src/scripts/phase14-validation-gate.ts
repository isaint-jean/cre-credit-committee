/**
 * Phase 14 — pre-fix / post-fix validation gate (Sunroad).
 *
 *   cd apps/api && npx tsx src/scripts/phase14-validation-gate.ts
 *
 * The brief's hard checkpoint: re-run Sunroad through the post-fix code,
 * compare against well-known pre-fix expected values, and assert that ONLY
 * the intended deltas changed (NOI, expenses tie-out, etc., MUST be
 * identical to the pre-fix baseline). Any UNEXPECTED FIELD DIFFERS → STOP
 * and report verbatim; do NOT proceed to .xlsm production.
 *
 * The pre-fix baseline values come from the phase12 / phase13 reports —
 * well-known stable values captured before the Phase 14 fixes landed. The
 * post-fix actual values come from re-running Sunroad ingest with the
 * Phase 14 fixes applied.
 *
 * Intended deltas (ALL OTHER FIELDS unchanged):
 *   - metrics.annualDebtService (legacy): 0 → ~$6,514,340 (Bug 1+2 IO-only fix)
 *   - metrics.dscr (legacy): null → ~1.31 (Bug 1+2 cascading)
 *   - adjustments[] length: 0 → >0 (Bug 3 adapter projection)
 *   - capitalReserves (NEW field): not present → populated (Bug 4 widening)
 *
 * Unchanged invariants (validation):
 *   - metrics.netOperatingIncome: $8,518,524 (the canonical NOI tie-out)
 *   - metrics.debtYield: ~0.1033 (NOI not perturbed)
 *   - expenses.realEstateTaxes.adjusted: $960,500
 *   - expenses.totalExpenses.adjusted: $3,650,796
 *   - expenses.replacementReserves.adjusted: 0 (zero by design — NOI tie-out)
 */
import path from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  ManualInputs,
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
import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
import { synthesizeUwModelFromGraph } from '../services/synthesize-uw-model-from-graph.js';
import type { Analysis, UnderwritingModel } from '@cre/shared';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase14-post-fix.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,            // IO-only
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

const PLACEHOLDER_COMP: ManualInputs = {
  marketRentComps: [
    { tenantOrSpace: 'Top Tenant (T-1)',           psf: 29, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Second Tenant (T-2)',        psf: 28, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Third Tenant (T-3)',         psf: 27, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Remaining Tenants (blended)', psf: 26, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
  ],
};

// Pre-fix baseline (well-known values from phase12 / phase13 reports).
const PRE_FIX_EXPECTED = {
  netOperatingIncome:               8_518_524,    // legacy uwModel NOI (Sunroad answer key class-(b) sum)
  expensesRealEstateTaxesAdjusted:    960_500,
  expensesTotalExpensesAdjusted:    3_650_796,
  expensesReplacementReservesAdjusted: 0,         // zero by design
  metricsAnnualDebtService:           0,          // BUG 1+2 — IO-only returned 0 before
  metricsDscr:                      null,         // BUG 1+2 cascade — null
  metricsDebtYield:                   0.1033,     // unchanged
  adjustmentsLength:                  0,          // BUG 3 — empty before adapter projects
  capitalReservesPresent:           false,        // BUG 4 — field absent in pre-fix shape
};

// Post-fix expected (with bands).
const POST_FIX_EXPECTED = {
  netOperatingIncome:               8_518_524,    // UNCHANGED
  expensesRealEstateTaxesAdjusted:    960_500,    // UNCHANGED
  expensesTotalExpensesAdjusted:    3_650_796,    // UNCHANGED
  expensesReplacementReservesAdjusted: 0,         // UNCHANGED — by design (NOI tie-out)
  metricsAnnualDebtService:         6_514_340,    // CHANGED — IO-only formula
  metricsDscrLow:                     1.25,       // CHANGED — null → ~1.31 (band)
  metricsDscrHigh:                    1.40,
  metricsDebtYield:                   0.1033,     // UNCHANGED
  adjustmentsLengthMin:                1,         // CHANGED — projection
  capitalReservesMonthlyRRLow:    4_400,          // CHANGED — present + populated
  capitalReservesMonthlyRRHigh:   4_700,
};

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(m: string): void { passCount++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failCount++; failures.push(m); console.error(`  FAIL  ${m}`); }
function assertClose(actual: number | null, expected: number, eps: number, m: string): void {
  if (actual === null) { fail(`${m} (actual=null, expected=${expected})`); return; }
  Math.abs(actual - expected) <= eps ? ok(m) : fail(`${m} (actual=${actual}, expected=${expected}, eps=${eps})`);
}
function assertInBand(actual: number | null, low: number, high: number, m: string): void {
  if (actual === null) { fail(`${m} (actual=null, expected [${low}, ${high}])`); return; }
  (actual >= low && actual <= high) ? ok(m) : fail(`${m} (actual=${actual}, expected [${low}, ${high}])`);
}
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

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
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return String(n);
  return Math.abs(n) > 1000 ? n.toFixed(0) : n.toFixed(4);
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 14 — pre-fix / post-fix validation gate');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  // Fresh DB each run for determinism.
  if (existsSync(DB_PATH)) {
    rmSync(DB_PATH);
    console.log(`removed prior db ${DB_PATH}`);
  }

  console.log(`\n--- composing extraction (real PCA + ASR AI extraction; ~30-60s)`);
  const tComp = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE14-VALIDATION',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);

  console.log('\n--- ingesting');
  const store = new RecordGraphStore(DB_PATH);
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingestResult = await ingestExtractionResult(
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
    { manualInputs: PLACEHOLDER_COMP },
  );
  const rootId = ingestResult.rootId as RevisionId;
  const envelope = store.getRevisionEnvelope(rootId);
  if (!envelope) throw new Error('envelope null');
  const aiContract = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (!aiContract) throw new Error('aiContract null');

  // --- Synthesize legacy uwModel + adapter output (Phase 14 surfaces).
  const uw: UnderwritingModel | null = synthesizeUwModelFromGraph(rootId, store);
  if (uw === null) throw new Error('synthesize uwModel returned null');
  const analysisShell: Analysis = {
    id: 'phase14-validation', name: 'Sunroad Centrum (phase14)',
    assetType: 'office', status: 'complete', progress: 100, currentStep: '',
    createdAt: AS_OF, updatedAt: AS_OF,
    document: null, uwDocument: null, supportingDocuments: [], templateDocument: null,
    findings: [], creditScore: null, uwModel: uw, research: null,
    crossCheckFindings: [], mitigations: [], executiveSummary: null,
    bPieceDecision: null, comments: [], criteriaEvaluations: [], stressScenarios: [],
    overallAdjustmentBias: 'conservative',
  } as any;
  const aiShared = adaptAnalysisToAdjustedInputs(analysisShell);
  if (!aiShared) throw new Error('adapter returned null');

  // --- Pretty-print the actuals
  console.log('\n============================================================');
  console.log('POST-FIX ACTUALS');
  console.log('============================================================');
  console.log('\n@cre/contracts.AdjustedInputs.metrics (new spine):');
  console.log(`  noi:               ${fmt(aiContract.metrics.noi)}`);
  console.log(`  debtServiceAnnual: ${fmt(aiContract.loan.debtServiceAnnual.adjusted)}`);
  console.log(`  dscr:              ${fmt(aiContract.metrics.dscr)}`);
  console.log(`  debtYield:         ${fmt(aiContract.metrics.debtYield)}`);

  console.log('\nLegacy uwModel (synthesized):');
  console.log(`  netOperatingIncome:           ${fmt(uw.netOperatingIncome)}`);
  console.log(`  annualDebtService:            ${fmt(uw.annualDebtService)}`);
  console.log(`  dscr:                         ${fmt(uw.dscr)}`);
  console.log(`  debtYield:                    ${fmt(uw.debtYield)}`);
  console.log(`  expenses.realEstateTaxes:     ${fmt(uw.expenses.realEstateTaxes.annualAmount)}`);
  console.log(`  expenses.totalExpenses:       ${fmt(uw.expenses.totalExpenses.annualAmount)}`);
  console.log(`  expenses.replacementReserves: ${fmt(uw.expenses.replacementReserves.annualAmount)}`);
  console.log(`  capitalReserves present:      ${uw.capitalReserves != null ? 'YES' : 'NO'}`);
  if (uw.capitalReserves != null) {
    console.log(`    monthlyReplacementReserves: ${fmt(uw.capitalReserves.monthlyReplacementReserves)}`);
  }

  console.log('\n@cre/shared.AdjustedInputs (adapter output — render-layer input):');
  console.log(`  metrics.netOperatingIncome:           ${fmt(aiShared.metrics.netOperatingIncome)}`);
  console.log(`  metrics.annualDebtService:            ${fmt(aiShared.metrics.annualDebtService)}`);
  console.log(`  metrics.dscr:                         ${fmt(aiShared.metrics.dscr)}`);
  console.log(`  metrics.debtYield:                    ${fmt(aiShared.metrics.debtYield)}`);
  console.log(`  expenses.realEstateTaxes.adjusted:    ${fmt(aiShared.expenses.realEstateTaxes.adjusted)}`);
  console.log(`  expenses.totalExpenses.adjusted:      ${fmt(aiShared.expenses.totalExpenses.adjusted)}`);
  console.log(`  expenses.replacementReserves.adjusted: ${fmt(aiShared.expenses.replacementReserves.adjusted)}`);
  console.log(`  capitalReserves.monthlyReplacementReserves.adjusted: ${fmt(aiShared.capitalReserves.monthlyReplacementReserves.adjusted)}`);
  console.log(`  adjustments.length:                   ${aiShared.adjustments.length}`);

  // --- Pre-fix vs post-fix delta table.
  console.log('\n============================================================');
  console.log('PRE-FIX vs POST-FIX DELTA TABLE');
  console.log('============================================================');
  console.log('Field                              | Pre-fix     | Post-fix    | Delta type   ');
  console.log('-----------------------------------+-------------+-------------+--------------');
  const rows: Array<[string, string, string, string]> = [
    ['metrics.annualDebtService (legacy)',
      String(PRE_FIX_EXPECTED.metricsAnnualDebtService),
      fmt(aiShared.metrics.annualDebtService),
      'INTENDED'],
    ['metrics.dscr (legacy)',
      String(PRE_FIX_EXPECTED.metricsDscr),
      fmt(aiShared.metrics.dscr),
      'INTENDED'],
    ['metrics.debtYield (legacy)',
      String(PRE_FIX_EXPECTED.metricsDebtYield),
      fmt(aiShared.metrics.debtYield),
      'UNCHANGED'],
    ['metrics.netOperatingIncome',
      String(PRE_FIX_EXPECTED.netOperatingIncome),
      fmt(aiShared.metrics.netOperatingIncome),
      'UNCHANGED'],
    ['expenses.realEstateTaxes.adjusted',
      String(PRE_FIX_EXPECTED.expensesRealEstateTaxesAdjusted),
      fmt(aiShared.expenses.realEstateTaxes.adjusted),
      'UNCHANGED'],
    ['expenses.totalExpenses.adjusted',
      String(PRE_FIX_EXPECTED.expensesTotalExpensesAdjusted),
      fmt(aiShared.expenses.totalExpenses.adjusted),
      'UNCHANGED'],
    ['adjustments[] length',
      String(PRE_FIX_EXPECTED.adjustmentsLength),
      String(aiShared.adjustments.length),
      'INTENDED'],
    ['expenses.replacementReserves.adjusted',
      String(PRE_FIX_EXPECTED.expensesReplacementReservesAdjusted),
      fmt(aiShared.expenses.replacementReserves.adjusted),
      'UNCHANGED'],
    ['capitalReserves.monthlyReplacementReserves',
      'not present',
      fmt(aiShared.capitalReserves.monthlyReplacementReserves.adjusted),
      'INTENDED'],
  ];
  for (const r of rows) {
    console.log(`${r[0].padEnd(35)}| ${r[1].padEnd(12)}| ${r[2].padEnd(12)}| ${r[3]}`);
  }

  // --- Assert intended deltas
  console.log('\n--- assertions (intended deltas)');
  assertClose(aiShared.metrics.annualDebtService, POST_FIX_EXPECTED.metricsAnnualDebtService, 100,
    `annualDebtService = $${POST_FIX_EXPECTED.metricsAnnualDebtService.toLocaleString()} (Bugs 1+2 IO-only fix)`);
  assertInBand(aiShared.metrics.dscr, POST_FIX_EXPECTED.metricsDscrLow, POST_FIX_EXPECTED.metricsDscrHigh,
    `dscr in [${POST_FIX_EXPECTED.metricsDscrLow}, ${POST_FIX_EXPECTED.metricsDscrHigh}] (Bugs 1+2 cascade)`);
  if (aiShared.adjustments.length < POST_FIX_EXPECTED.adjustmentsLengthMin) {
    fail(`adjustments[].length >= ${POST_FIX_EXPECTED.adjustmentsLengthMin} (Bug 3 projection) — got ${aiShared.adjustments.length}`);
  } else {
    ok(`adjustments[].length >= ${POST_FIX_EXPECTED.adjustmentsLengthMin} (got ${aiShared.adjustments.length})`);
  }
  assertInBand(
    aiShared.capitalReserves.monthlyReplacementReserves.adjusted,
    POST_FIX_EXPECTED.capitalReservesMonthlyRRLow,
    POST_FIX_EXPECTED.capitalReservesMonthlyRRHigh,
    `capitalReserves.monthlyReplacementReserves.adjusted in [$${POST_FIX_EXPECTED.capitalReservesMonthlyRRLow}, $${POST_FIX_EXPECTED.capitalReservesMonthlyRRHigh}] (Bug 4)`,
  );

  // --- Assert UNCHANGED invariants (the gate's load-bearing part)
  console.log('\n--- assertions (UNCHANGED invariants — DSCR cannot perturb NOI)');
  assertClose(aiShared.metrics.netOperatingIncome, PRE_FIX_EXPECTED.netOperatingIncome, 1.0,
    `metrics.netOperatingIncome === $${PRE_FIX_EXPECTED.netOperatingIncome.toLocaleString()} UNCHANGED`);
  assertClose(aiShared.expenses.realEstateTaxes.adjusted, PRE_FIX_EXPECTED.expensesRealEstateTaxesAdjusted, 1.0,
    `expenses.realEstateTaxes.adjusted === $${PRE_FIX_EXPECTED.expensesRealEstateTaxesAdjusted.toLocaleString()} UNCHANGED`);
  assertClose(aiShared.expenses.totalExpenses.adjusted, PRE_FIX_EXPECTED.expensesTotalExpensesAdjusted, 1.0,
    `expenses.totalExpenses.adjusted === $${PRE_FIX_EXPECTED.expensesTotalExpensesAdjusted.toLocaleString()} UNCHANGED`);
  assertEqual(aiShared.expenses.replacementReserves.adjusted, 0,
    'expenses.replacementReserves.adjusted === 0 UNCHANGED (NOI tie-out)');
  assertClose(aiShared.metrics.debtYield, PRE_FIX_EXPECTED.metricsDebtYield, 0.001,
    `metrics.debtYield === ${PRE_FIX_EXPECTED.metricsDebtYield} UNCHANGED (NOI not perturbed)`);

  console.log('\n============================================================');
  console.log('VALIDATION GATE RESULT');
  console.log('============================================================');
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failures.length > 0) {
    console.log('\n*** FAILED ASSERTIONS (STOP — do NOT proceed to .xlsm production):');
    for (const f of failures) console.log(`  - ${f}`);
  }

  store.close();
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => {
  console.error('validation gate threw:', e);
  process.exit(2);
});
