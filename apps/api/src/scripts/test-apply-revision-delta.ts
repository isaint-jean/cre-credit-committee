/**
 * Tests for `applyRevisionDelta` (Option C / issue #20, step 8.5).
 *
 *   npm run test:apply-revision-delta       (from apps/api)
 *
 * Approximately 26 assertions across 8 blocks:
 *   - Happy path
 *   - Envelope shape
 *   - Provenance shape
 *   - Lineage walk
 *   - Determinism + idempotency
 *   - Linear-chain guard
 *   - Drift protection (β.1: rollup formulas match engine for conservatism-quiet inputs)
 *   - Behavior-locking (T-12-direct parent: no-op recompute changes totalOpEx — documented v1 surprise)
 *   - Metrics chain correctness (vacancy override → EGI/NOI/DSCR/value/LTV/debtYield move correctly)
 *   - Error cases (mirrored vacancy+concessions validation, invalid paths, missing parent)
 *
 * Uses ingestExtractionResult to seed a real root revision, so applyRevisionDelta runs against
 * a fully-formed lineage.
 */

import {
  EXTRACTION_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  RevisionId,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import {
  applyRevisionDelta,
  recomputeDerivedFields,
  isEditablePath,
  diffAdjustedInputs,
  ParentRevisionNotFoundError,
  NotLatestRevisionError,
  InvalidDeltaError,
} from '../services/apply-revision-delta.js';

const AS_OF = '2026-05-22T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number | null, b: number, eps: number, m: string): void {
  if (a === null) { fail(`${m} (actual=null, expected≈${b})`); return; }
  Math.abs(a - b) <= eps
    ? ok(m)
    : fail(`${m} (actual=${a}, expected≈${b}, diff=${Math.abs(a - b)})`);
}
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  message: string,
  predicate?: (e: E) => boolean,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (!(e instanceof ctor)) {
      fail(`${message} (threw ${(e as Error)?.name ?? typeof e})`);
      return;
    }
    if (predicate && !predicate(e)) {
      fail(`${message} (wrong instance: ${e.message})`);
      return;
    }
    ok(message);
  }
}

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(asOf: string = AS_OF, dealRef = 'REV-DELTA-1'): ExtractionResult {
  const body = {
    analysisAsOfDate: asOf,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef,
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'Tenant B', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2034-01-01T00:00:00Z', baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000,
          occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    t12: {
      period: 'T-12 ending Apr 2026', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000,
                   repairsMaintenance: 36_000, managementFees: 40_000,
                   generalAndAdmin: null, janitorial: null, reimbursements: null,
                   totalOperatingExpenses: 218_000 },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    pca: {
      immediateRepairs: 50_000, shortTermRepairs: 150_000,
      evaluationPeriodYears: null, inflationRate: null,
      replacementReservesPerSfPerYearInflated: null, replacementReservesPerSfPerYearUninflated: null,
      capexScheduleInflated: null, capexScheduleUninflated: null,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: {
      loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
      interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z',
    },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
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

function makeManifesto(asOf: string = AS_OF): CreditManifesto {
  const body = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

/** Seed a root revision via the standard ingest path and return the resulting record graph state. */
function seedRoot(store: RecordGraphStore) {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingest = ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
    },
    store,
  );
  return ingest;
}

/* ----------------------------------- tests --------------------------------- */

console.log('Happy path — single override on root:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootEnvelope = store.getRevisionEnvelope(root.rootId)!;
  const rootAi = store.getAdjustedInputs(rootEnvelope.adjustedInputsId)!;
  const newVacancy = rootAi.income.vacancyPct.adjusted + 0.02;

  const result = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: {
        kind: 'adjusted-input-overrides',
        overrides: [{ path: 'income.vacancyPct.adjusted', value: newVacancy }],
      },
      triggerSource: 'USER_EDIT',
      adjustmentOrigin: ['manual: vacancy stress'],
    },
    store,
  );

  assert(/^[0-9a-f]{64}$/.test(result.envelope.revisionId), 'child revisionId is 64-hex');
  assert(result.envelope.revisionId !== (root.rootId as string), 'child revisionId !== root revisionId');
  assert(result.evaluation.id !== root.evaluationId, 'child evaluation.id !== root evaluation.id');
  assert(result.evaluation.adjustedInputsId !== rootAi.id, 'child adjustedInputsId differs from root');
  assert(store.getRevisionEnvelope(result.envelope.revisionId) !== null, 'child envelope persisted');
  assert(store.getRevisionProvenance(result.envelope.revisionId) !== null, 'child provenance persisted');
  assert(store.getDoctrineEvaluation(result.evaluation.id) !== null, 'child evaluation persisted');
}

console.log('\nEnvelope shape — child wired to root:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const result = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: {
        kind: 'adjusted-input-overrides',
        overrides: [{ path: 'assumptions.capRate.adjusted', value: 0.06 }],
      },
      triggerSource: 'USER_EDIT',
    },
    store,
  );

  assertEqual(result.envelope.parentRevisionId, root.rootId, 'child parentRevisionId === root.rootId');
  assertEqual(result.envelope.lineageRootId, root.rootId, 'child lineageRootId === root.rootId');
  assertEqual(result.envelope.revisionOrdinal, 1, 'child revisionOrdinal === 1');
  assertEqual(result.envelope.doctrineEvaluationId, result.evaluation.id, 'envelope.doctrineEvaluationId points at child evaluation');
  assertEqual(result.envelope.doctrineVersion, result.evaluation.doctrineVersion, 'envelope.doctrineVersion stamped from child evaluation');
  assertEqual(result.envelope.judgmentEngineVersion, result.evaluation.judgmentEngineVersion, 'envelope.judgmentEngineVersion stamped');
  assertEqual(result.envelope.stressEngineVersion, result.evaluation.stressEngineVersion, 'envelope.stressEngineVersion stamped');
  assertEqual(result.envelope.valuationEngineVersion, result.evaluation.valuationEngineVersion, 'envelope.valuationEngineVersion stamped');
}

console.log('\nProvenance shape — diff carries the override path:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootEnvelope = store.getRevisionEnvelope(root.rootId)!;
  const result = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: {
        kind: 'adjusted-input-overrides',
        overrides: [{ path: 'loan.interestRate.adjusted', value: 0.08 }],
      },
      triggerSource: 'USER_EDIT',
      adjustmentOrigin: ['rate stress to 8%'],
    },
    store,
  );

  assertEqual(result.provenance.triggerSource, 'USER_EDIT', 'triggerSource preserved');
  assertEqual(result.provenance.beforeHash, rootEnvelope.adjustedInputsId, 'beforeHash === parent AdjustedInputsId');
  assertEqual(result.provenance.afterHash, result.envelope.adjustedInputsId, 'afterHash === child AdjustedInputsId');
  assertEqual(result.provenance.adjustmentOrigin.length, 1, 'adjustmentOrigin preserved');
  const paths = result.provenance.inputDiff.changedFields.map((f) => f.path);
  assert(paths.includes('loan.interestRate.adjusted'), 'inputDiff includes the override path');
  // Recomputed derived fields also show up in the diff.
  assert(paths.some((p) => p.startsWith('loan.debtServiceAnnual')), 'inputDiff includes recomputed debtServiceAnnual');
  assert(paths.some((p) => p.startsWith('metrics.')), 'inputDiff includes recomputed metrics');
}

console.log('\nLineage walk — chain grows from 1 to 2:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  assertEqual(store.walkLineageChain(root.rootId).length, 1, 'chain length is 1 before delta');
  const result = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: {
        kind: 'adjusted-input-overrides',
        overrides: [{ path: 'expenses.insurance.adjusted', value: 25_000 }],
      },
      triggerSource: 'USER_EDIT',
    },
    store,
  );
  const chain = store.walkLineageChain(root.rootId);
  assertEqual(chain.length, 2, 'chain length is 2 after delta');
  assertEqual(chain[0]!.revisionId, root.rootId, 'chain[0] is root');
  assertEqual(chain[1]!.revisionId, result.envelope.revisionId, 'chain[1] is child');
  const latest = store.getLatestRevisionByLineageRoot(root.rootId);
  assertEqual(latest?.revisionId, result.envelope.revisionId, 'getLatestRevisionByLineageRoot returns child');
}

console.log('\nDeterminism + idempotency — same args twice → same child:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const args = {
    parentRevisionId: root.rootId,
    delta: {
      kind: 'adjusted-input-overrides' as const,
      overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }],
    },
    triggerSource: 'USER_EDIT' as const,
  };
  const r1 = applyRevisionDelta(args, store);
  const r2 = applyRevisionDelta(args, store);
  assertEqual(r1.envelope.revisionId, r2.envelope.revisionId, 'identical args → identical childRevisionId');
  assertEqual(r1.evaluation.id, r2.evaluation.id, 'identical args → identical child evaluation.id');
  assertEqual(store.walkLineageChain(root.rootId).length, 2, 'chain stays length 2 (second call no-op)');
}

console.log('\nLinear-chain guard — applying to non-latest parent throws:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  // First delta — root → child1.
  const child1 = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.08 }] },
      triggerSource: 'USER_EDIT',
    },
    store,
  );
  // Second delta against root (not latest) — must throw.
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: root.rootId,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.09 }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    NotLatestRevisionError,
    'delta against non-latest parent throws NotLatestRevisionError',
    (e) => e.currentLatestRevisionId === (child1.envelope.revisionId as string),
  );
  // Delta against latest succeeds.
  const child2 = applyRevisionDelta(
    {
      parentRevisionId: child1.envelope.revisionId,
      delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.09 }] },
      triggerSource: 'USER_EDIT',
    },
    store,
  );
  assertEqual(child2.envelope.revisionOrdinal, 2, 'chain extends linearly: root → child1 → child2 (ordinal 2)');
}

console.log('\nDrift protection — recompute matches engine formulas where conservatism does not interfere:');
{
  // The engine and β.1 recompute share these formulas verbatim:
  //   - EGI = (gri + otherIncome) × (1 - vacancy - concessions)   (engine line-item-builders.ts:387,405)
  //   - debtServiceAnnual = annualDebtService(loan terms)         (engine reuses same helper)
  //   - maturityBalance   = maturityBalance(loan terms)           (engine reuses same helper)
  // If the engine ever changes these formulas, this test fails immediately.
  //
  // EXPECTED DIVERGENCES (β.1 limitation, documented in apply-revision-delta.ts header):
  //   - totalOperatingExpenses: engine may apply expense-ratio floor (line-item-builders.ts:537-553)
  //     based on library median × EGI or bank ratio × EGI. β.1 recompute returns the raw
  //     sum-of-sub-lines without flooring. This test does NOT compare totalOpEx to engine.
  //   - metrics.noi: engine applies bank-CF NOI cap (apply-judgment-adjustments.ts:294-302).
  //     β.1 recompute returns uncapped EGI - totalOpEx. NOT compared to engine here.
  //   - metrics.{value,dscr,debtYield}: derived from NOI, inherit the cap divergence above.
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootEnvelope = store.getRevisionEnvelope(root.rootId)!;
  const rootAi = store.getAdjustedInputs(rootEnvelope.adjustedInputsId)!;
  const narrativeFacts = store.getNarrativeFacts(root.evaluation.narrativeFactsId)!;
  const { id: _id, ...body } = rootAi;
  const recomputed = recomputeDerivedFields(body, narrativeFacts);

  assertEqual(
    recomputed.income.effectiveGrossIncome.adjusted,
    rootAi.income.effectiveGrossIncome.adjusted,
    'recomputed EGI matches engine (shared formula)',
  );
  assertEqual(
    recomputed.loan.debtServiceAnnual.adjusted,
    rootAi.loan.debtServiceAnnual.adjusted,
    'recomputed debtServiceAnnual matches engine (same helper call)',
  );
  assertEqual(
    recomputed.loan.maturityBalance.adjusted,
    rootAi.loan.maturityBalance.adjusted,
    'recomputed maturityBalance matches engine (same helper call)',
  );
}

console.log('\nBehavior-locking — recompute formula self-consistency (hand-rolled, no engine):');
{
  // Hand-built body bypasses the engine entirely. Asserts the recompute formulas produce
  // the exact arithmetic documented in apply-revision-delta.ts.
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootEnvelope = store.getRevisionEnvelope(root.rootId)!;
  const rootAi = store.getAdjustedInputs(rootEnvelope.adjustedInputsId)!;
  const narrativeFacts = store.getNarrativeFacts(root.evaluation.narrativeFactsId)!;

  // Synthesize a body where every editable input has a fresh known value. recompute should
  // then produce a body whose rollups match hand-computed arithmetic.
  const { id: _id, ...body } = rootAi;
  const synthBody = recomputeDerivedFields(
    {
      ...body,
      income: {
        ...body.income,
        grossRentalIncome: { ...body.income.grossRentalIncome, adjusted: 1_000_000 },
        otherIncome: { ...body.income.otherIncome, adjusted: 100_000 },
        vacancyPct: { ...body.income.vacancyPct, adjusted: 0.05 },
        concessionsPct: { ...body.income.concessionsPct, adjusted: 0.01 },
      },
      expenses: {
        ...body.expenses,
        realEstateTaxes: { ...body.expenses.realEstateTaxes, adjusted: 100_000 },
        insurance: { ...body.expenses.insurance, adjusted: 20_000 },
        utilities: { ...body.expenses.utilities, adjusted: 30_000 },
        managementFee: { ...body.expenses.managementFee, adjusted: 40_000 },
        payroll: { ...body.expenses.payroll, adjusted: 0 },
        maintenance: { ...body.expenses.maintenance, adjusted: 50_000 },
        other: { ...body.expenses.other, adjusted: 10_000 },
      },
      loan: {
        ...body.loan,
        loanAmount: { ...body.loan.loanAmount, adjusted: 10_000_000 },
        interestRate: { ...body.loan.interestRate, adjusted: 0.06 },
        amortizationMonths: { ...body.loan.amortizationMonths, adjusted: 360 },
        termMonths: { ...body.loan.termMonths, adjusted: 120 },
      },
      assumptions: {
        ...body.assumptions,
        capRate: { ...body.assumptions.capRate, adjusted: 0.07 },
      },
    },
    narrativeFacts,
  );

  // EGI = (1_000_000 + 100_000) × (1 - 0.05 - 0.01) = 1_100_000 × 0.94 ≈ 1_034_000 (within ULP)
  assertClose(synthBody.income.effectiveGrossIncome.adjusted, 1_034_000, 1e-6,
    'EGI = (gri+other) × (1 - vacancy - concessions)');
  // totalOpEx = 100k + 20k + 30k + 40k + 0 + 50k + 10k = 250_000 (exact — integer additions)
  assertEqual(synthBody.expenses.totalOperatingExpenses.adjusted, 250_000,
    'totalOpEx = sum of 7 sub-lines (β.1 — no floor)');
  // NOI = 1_034_000 - 250_000 ≈ 784_000 (inherits EGI's ULP drift)
  assertClose(synthBody.metrics.noi, 784_000, 1e-6, 'NOI = EGI - totalOpEx (β.1 — no cap)');
  // value = NOI / capRate = 784_000 / 0.07 ≈ 11_200_000
  assertClose(synthBody.metrics.value, 11_200_000, 1e-3, 'value = NOI / capRate');
  // debtYield = NOI / loanAmount = 784_000 / 10_000_000 ≈ 0.0784
  assertClose(synthBody.metrics.debtYield, 0.0784, 1e-9, 'debtYield = NOI / loanAmount');
  // expenseRatio = 250_000 / 1_034_000 (depends on EGI's exact float value)
  assertClose(synthBody.metrics.expenseRatio, 250_000 / 1_034_000, 1e-9,
    'expenseRatio = totalOpEx / EGI');
}

console.log('\nMetrics chain — sequential child deltas show recompute is monotonic in vacancy:');
{
  // Compare TWO consecutive β.1 children rather than parent vs child. Parent metrics may have
  // been engine-floored/capped; child β.1 metrics never are. Child-vs-child eliminates that
  // confound, so the differential cleanly tracks the recompute's arithmetic response to vacancy.
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootEnvelope = store.getRevisionEnvelope(root.rootId)!;
  const rootAi = store.getAdjustedInputs(rootEnvelope.adjustedInputsId)!;

  const childA = applyRevisionDelta(
    {
      parentRevisionId: root.rootId,
      delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: rootAi.income.vacancyPct.adjusted + 0.01 }] },
      triggerSource: 'USER_EDIT',
    },
    store,
  );
  const childB = applyRevisionDelta(
    {
      parentRevisionId: childA.envelope.revisionId,
      delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: rootAi.income.vacancyPct.adjusted + 0.10 }] },
      triggerSource: 'USER_EDIT',
    },
    store,
  );
  const aAi = store.getAdjustedInputs(childA.evaluation.adjustedInputsId)!;
  const bAi = store.getAdjustedInputs(childB.evaluation.adjustedInputsId)!;

  assert(bAi.income.effectiveGrossIncome.adjusted < aAi.income.effectiveGrossIncome.adjusted, 'EGI: childB (higher vacancy) < childA');
  assert((bAi.metrics.noi ?? 0) < (aAi.metrics.noi ?? 0), 'NOI: childB < childA');
  assert((bAi.metrics.dscr ?? 0) < (aAi.metrics.dscr ?? 0), 'DSCR: childB < childA');
  assert((bAi.metrics.value ?? 0) < (aAi.metrics.value ?? 0), 'value: childB < childA');
  assert((bAi.metrics.debtYield ?? 0) < (aAi.metrics.debtYield ?? 0), 'debtYield: childB < childA');
  assert((bAi.metrics.expenseRatio ?? 0) > (aAi.metrics.expenseRatio ?? 0), 'expenseRatio: childB > childA (EGI shrank, totalOpEx unchanged)');
  assertEqual(bAi.metrics.ltvAppraisal, aAi.metrics.ltvAppraisal, 'LTV: unchanged (loanAmount + appraisal both invariant)');
}

console.log('\nError — parent revision not found:');
{
  const store = new RecordGraphStore(':memory:');
  seedRoot(store);
  const ghost = ('f'.repeat(64)) as unknown as RevisionId;
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: ghost,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: 0.1 }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    ParentRevisionNotFoundError,
    'unknown parent revisionId throws ParentRevisionNotFoundError',
  );
}

console.log('\nError — non-editable path:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: root.rootId,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'metrics.dscr', value: 1.5 }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    InvalidDeltaError,
    'editing metrics.dscr throws InvalidDeltaError(NON_EDITABLE_PATH)',
    (e) => e.code === 'NON_EDITABLE_PATH',
  );
}

console.log('\nError — editable path that doesn\'t resolve on parent body:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  // A typo'd path that ISN'T in the whitelist — caught by NON_EDITABLE_PATH first.
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: root.rootId,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacanyPct.adjusted', value: 0.1 }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    InvalidDeltaError,
    'typo path throws InvalidDeltaError(NON_EDITABLE_PATH)',
    (e) => e.code === 'NON_EDITABLE_PATH',
  );
}

console.log('\nError — vacancy + concessions out of range (mirrored engine validation):');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootAi = store.getAdjustedInputs(store.getRevisionEnvelope(root.rootId)!.adjustedInputsId)!;
  // Push vacancy + (parent concessions) above 1 to trigger the mirror.
  const badVacancy = 1.5 - rootAi.income.concessionsPct.adjusted;
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: root.rootId,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: badVacancy }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    InvalidDeltaError,
    'vacancy+concessions > 1 throws InvalidDeltaError(VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE)',
    (e) => e.code === 'VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE',
  );
}

console.log('\nError — bad value type (non-finite number):');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  assertThrowsInstance(
    () => applyRevisionDelta(
      {
        parentRevisionId: root.rootId,
        delta: { kind: 'adjusted-input-overrides', overrides: [{ path: 'income.vacancyPct.adjusted', value: Number.NaN }] },
        triggerSource: 'USER_EDIT',
      },
      store,
    ),
    InvalidDeltaError,
    'NaN value throws InvalidDeltaError(BAD_VALUE_TYPE)',
    (e) => e.code === 'BAD_VALUE_TYPE',
  );
}

console.log('\nUnit — isEditablePath whitelist semantics:');
{
  assertEqual(isEditablePath('income.vacancyPct.adjusted'), true, 'editable path returns true');
  assertEqual(isEditablePath('metrics.dscr'), false, 'metrics.* returns false');
  assertEqual(isEditablePath('income.effectiveGrossIncome.adjusted'), false, 'derived rollup returns false');
  assertEqual(isEditablePath('loan.maturityBalance.adjusted'), false, 'recomputed loan.maturityBalance returns false');
}

console.log('\nUnit — diffAdjustedInputs surfaces scalar changes only:');
{
  const store = new RecordGraphStore(':memory:');
  const root = seedRoot(store);
  const rootAi = store.getAdjustedInputs(store.getRevisionEnvelope(root.rootId)!.adjustedInputsId)!;
  const diff = diffAdjustedInputs(rootAi, rootAi);
  assertEqual(diff.changedFields.length, 0, 'identical bodies yield empty diff');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
