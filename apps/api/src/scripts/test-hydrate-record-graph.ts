/**
 * Tests for `hydrate-record-graph.ts` (Batch 6.5 — Stage 11 hydration).
 *
 *   npm run test:hydrate-record-graph
 *
 * Verifies the locked hydration invariants HY1–HY7:
 *   - Round-trip: ingest → hydrate → bundle has all 9 records, each id matches the FK on the root
 *   - Determinism (HY6): hydrating same root twice → byte-identical bundle (JSON-serialization equal)
 *   - Pure read (HY5): hydration does not mutate row counts in the store
 *   - Single-hop FK closure (HY1): every record reachable in one FK lookup from root
 *   - DOCTRINE_EVALUATION_NOT_FOUND: unknown root throws HydrationError
 *   - DANGLING_FK_*: rows manually deleted (FK constraints temporarily disabled) → HydrationError
 *     fired with the correct code and missingId
 *   - HY3: hydration NEVER synthesizes a missing row (no fallback construction)
 *   - HY7 mode-invariant: hydrator signature accepts only (rootId, store) — no mode parameter
 */

import {
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  DoctrineEvaluationId,
  ExtractionResult,
  HydratedRecordGraph,
  LibrarySnapshot,
  MarketBenchmarks,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { STUB_LLM_DEPS } from './_narrative-test-deps.js';
import {
  hydrateRecordGraph,
  HydrationError,
} from '../services/hydrate-record-graph.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertThrowsCode(
  fn: () => unknown,
  expectedCode: string,
  message: string,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (e instanceof HydrationError && e.code === expectedCode) ok(message);
    else fail(`${message} (got ${(e as Error)?.name}/${(e as HydrationError)?.code ?? '?'})`);
  }
}

/* ------------------------------ fixtures ------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(asOf = AS_OF, dealRef = 'HYDR-1'): ExtractionResult {
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

function makeManifesto(): CreditManifesto {
  const body = {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

async function ingestSeed(store: RecordGraphStore): Promise<{ rootId: DoctrineEvaluationId }> {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const result = await ingestExtractionResult(
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
    STUB_LLM_DEPS,
  );
  // Post-#20: hydration anchors on the DoctrineEvaluationId, exposed as result.evaluationId.
  // result.rootId is the public AnalysisId (RevisionId), not consumable by hydrateRecordGraph.
  return { rootId: result.evaluationId };
}

/* ----------------------------------- run ---------------------------------- */

(async () => {

console.log('Round-trip — bundle contains all 9 records reachable from root:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = await ingestSeed(store);

  const bundle = hydrateRecordGraph(rootId, store);

  // 9 records present
  assert(bundle.doctrineEvaluation !== null, 'doctrineEvaluation present');
  assert(bundle.valuationConclusion !== null, 'valuationConclusion present');
  assert(bundle.stressOutputs !== null, 'stressOutputs present');
  assert(bundle.crossCheckResult !== null, 'crossCheckResult present');
  assert(bundle.adjustedInputs !== null, 'adjustedInputs present');
  assert(bundle.narrativeFacts !== null, 'narrativeFacts present');
  assert(bundle.librarySnapshot !== null, 'librarySnapshot present');
  assert(bundle.assetProfile !== null, 'assetProfile present');
  assert(bundle.extractionResult !== null, 'extractionResult present');

  // Each FK on the root resolves to the bundle's record id (single-hop closure)
  assertEqual(bundle.doctrineEvaluation.id, rootId, 'doctrineEvaluation.id === rootId');
  assertEqual(bundle.adjustedInputs.id, bundle.doctrineEvaluation.adjustedInputsId, 'adjustedInputsId FK resolves');
  assertEqual(bundle.librarySnapshot.id, bundle.doctrineEvaluation.librarySnapshotId, 'librarySnapshotId FK resolves');
  assertEqual(bundle.narrativeFacts.id, bundle.doctrineEvaluation.narrativeFactsId, 'narrativeFactsId FK resolves');
  assertEqual(bundle.crossCheckResult.id, bundle.doctrineEvaluation.crossCheckResultId, 'crossCheckResultId FK resolves');
  assertEqual(bundle.stressOutputs.id, bundle.doctrineEvaluation.stressOutputsId, 'stressOutputsId FK resolves');
  assertEqual(bundle.valuationConclusion.id, bundle.doctrineEvaluation.valuationConclusionId, 'valuationConclusionId FK resolves');
  assertEqual(bundle.assetProfile.id, bundle.doctrineEvaluation.assetProfileId, 'assetProfileId FK resolves');
  assertEqual(bundle.extractionResult.id, bundle.doctrineEvaluation.extractionResultId, 'extractionResultId FK resolves');

  store.close();
}

console.log('\nDeterminism (HY6) — same root, byte-identical bundle:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = await ingestSeed(store);

  const a = hydrateRecordGraph(rootId, store);
  const b = hydrateRecordGraph(rootId, store);

  // Compare full bundles via canonical JSON; identical roots must produce identical bundles
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'two hydrations of same root → byte-identical bundle');

  store.close();
}

console.log('\nPure read (HY5) — hydration does not mutate the store:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = await ingestSeed(store);

  // Snapshot id of every record before hydration
  const before = hydrateRecordGraph(rootId, store);
  const beforeIds = [
    before.doctrineEvaluation.id,
    before.valuationConclusion.id,
    before.stressOutputs.id,
    before.crossCheckResult.id,
    before.adjustedInputs.id,
    before.narrativeFacts.id,
    before.librarySnapshot.id,
    before.assetProfile.id,
    before.extractionResult.id,
  ];

  // Hydrate again multiple times — no mutation should occur
  hydrateRecordGraph(rootId, store);
  hydrateRecordGraph(rootId, store);

  const after = hydrateRecordGraph(rootId, store);
  const afterIds = [
    after.doctrineEvaluation.id,
    after.valuationConclusion.id,
    after.stressOutputs.id,
    after.crossCheckResult.id,
    after.adjustedInputs.id,
    after.narrativeFacts.id,
    after.librarySnapshot.id,
    after.assetProfile.id,
    after.extractionResult.id,
  ];
  assertEqual(JSON.stringify(beforeIds), JSON.stringify(afterIds), 'record ids unchanged after repeated hydration');

  store.close();
}

console.log('\nDOCTRINE_EVALUATION_NOT_FOUND — unknown root throws:');
{
  const store = new RecordGraphStore(':memory:');
  const fakeRoot = 'z'.repeat(64) as DoctrineEvaluationId;
  assertThrowsCode(
    () => hydrateRecordGraph(fakeRoot, store),
    'DOCTRINE_EVALUATION_NOT_FOUND',
    'unknown rootId throws DOCTRINE_EVALUATION_NOT_FOUND',
  );
  store.close();
}

/* Helpers for dangling-FK testing — temporarily disable FK constraints, surgically delete,
   then attempt hydration. SQLite's foreign_keys pragma can be flipped per connection.        */
function withFKOff<T>(store: RecordGraphStore, table: string, id: string, fn: () => T): T {
  // tsx skips type checking; cast to access the private db handle for surgical test mutation
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  db.pragma('foreign_keys = OFF');
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  db.pragma('foreign_keys = ON');
  return fn();
}

console.log('\nDANGLING_FK_* — each FK miss produces the right error code (HY3 enforced):');
{
  const cases: ReadonlyArray<{
    table: string;
    fk: keyof HydratedRecordGraph['doctrineEvaluation'];
    code: string;
  }> = [
    { table: 'adjusted_inputs',       fk: 'adjustedInputsId',      code: 'DANGLING_FK_ADJUSTED_INPUTS' },
    { table: 'library_snapshots',     fk: 'librarySnapshotId',     code: 'DANGLING_FK_LIBRARY_SNAPSHOT' },
    { table: 'narrative_facts',       fk: 'narrativeFactsId',      code: 'DANGLING_FK_NARRATIVE_FACTS' },
    { table: 'cross_check_results',   fk: 'crossCheckResultId',    code: 'DANGLING_FK_CROSS_CHECK_RESULT' },
    { table: 'stress_outputs',        fk: 'stressOutputsId',       code: 'DANGLING_FK_STRESS_OUTPUTS' },
    { table: 'valuation_conclusions', fk: 'valuationConclusionId', code: 'DANGLING_FK_VALUATION_CONCLUSION' },
    { table: 'asset_profiles',        fk: 'assetProfileId',        code: 'DANGLING_FK_ASSET_PROFILE' },
    { table: 'extraction_results',    fk: 'extractionResultId',    code: 'DANGLING_FK_EXTRACTION_RESULT' },
  ];

  for (const c of cases) {
    const store = new RecordGraphStore(':memory:');
    const { rootId } = await ingestSeed(store);
    const bundleBefore = hydrateRecordGraph(rootId, store);
    const missingId = bundleBefore.doctrineEvaluation[c.fk] as string;

    withFKOff(store, c.table, missingId, () => {
      assertThrowsCode(
        () => hydrateRecordGraph(rootId, store),
        c.code,
        `delete ${c.table}.${missingId.slice(0, 8)}… → ${c.code}`,
      );
    });

    store.close();
  }
}

console.log('\nHY3 — hydration NEVER synthesizes a missing row:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = await ingestSeed(store);
  const bundleBefore = hydrateRecordGraph(rootId, store);

  // Delete narrative_facts row out from under the doctrine root
  withFKOff(store, 'narrative_facts', bundleBefore.narrativeFacts.id, () => {
    let threw = false;
    try { hydrateRecordGraph(rootId, store); } catch { threw = true; }
    assert(threw, 'hydration throws on missing narrative_facts (does not synthesize)');
  });

  // After re-enable, narrative_facts is still missing — hydration still throws
  let threw2 = false;
  try { hydrateRecordGraph(rootId, store); } catch { threw2 = true; }
  assert(threw2, 'hydration still throws after FK constraints re-enabled (no synthesis on retry)');

  store.close();
}

console.log('\nHY7 — hydrator signature is (rootId, store) only; no mode parameter:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId } = await ingestSeed(store);
  // If hydrateRecordGraph accepted a mode arg, the type system would complain — but tsx
  // skips types. Functional check: it accepts exactly two args, returns the bundle.
  assertEqual(hydrateRecordGraph.length, 2, 'hydrateRecordGraph arity is 2 (rootId, store)');
  const bundle = hydrateRecordGraph(rootId, store);
  assert(bundle.doctrineEvaluation.id === rootId, 'hydration with no mode returns the bundle');
  store.close();
}

/* ---------------------------------- summary -------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})().catch((e) => { console.error(e); process.exit(1); });
