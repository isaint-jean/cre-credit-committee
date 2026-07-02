/**
 * seed-cleared-fixture.ts — the DEMO cleared-deal fixture (committable, idempotent).
 *
 *   npx tsx apps/api/src/scripts/seed-cleared-fixture.ts [--db <path>]
 *
 * Purpose
 * -------
 * Seed ONE synthetic-but-COHERENT Multifamily deal that runs through the REAL
 * ingest pipeline (`ingestExtractionResult` — the same funnel the production
 * build-and-ingest route uses) and lets the doctrine engine DERIVE its own
 * rating. Nothing about band / score / gate / lever set is hand-forced; only the
 * economic INPUTS are supplied. See docs/recon/2026-07-02-cleared-seed.md (PATH B).
 *
 * What it seeds (additive-only, idempotent):
 *   1. A Multifamily ExtractionResult (dealRef = 'DEMO-CLEARED-MF-001') with strong,
 *      internally-consistent economics: going-in NOI ~$1.6M (>0), concluded value
 *      ~$26.0M, loan ~$12.0M (LTV <65%), DSCR ≥1.50×, debt-yield ~13%, 40 units
 *      100%-occupied. Underwritten stabilized vacancy is a disciplined 7.0% (the
 *      DBRS Multifamily stabilized floor) — the engine's spine haircuts any tighter
 *      assumption, so 7% is the honest stabilized vacancy for a 100%-leased asset.
 *   2. `ingestExtractionResult(...)` it as its OWN root (parentRevisionId absent) with
 *      its own doctrine_evaluations.
 *   3. ONE `loan_in_pool` row bound into an existing pool with
 *      deal_ref = 'DEMO-CLEARED-MF-001' + the DEMO propertyName.
 *
 * What it does NOT do (these are the live demo / the temp-proof, NOT baked in):
 *   - No committee ratification of the condition_precedent lever.
 *   - No /close. The deal is left INGESTED + BOUND but UN-ratified / UN-closed:
 *     cleared=false until a committee OVERRIDE_DECISION ratifies the cp lever.
 *
 * Idempotency: if extraction_results already carries deal_ref 'DEMO-CLEARED-MF-001',
 * the script no-ops (prints the existing ids and exits 0). Re-running is safe.
 *
 * ★ SAFETY: pass `--db /tmp/copy.db` to run against a throwaway copy. With no flag it
 *   targets the real apps/api/data/cre.db — the CALLER decides when that's intended.
 */

import path from 'path';
import Database from 'better-sqlite3';
import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  LoanInPool,
  MarketBenchmarks,
  TapeId,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { PoolStore } from '../storage/pool-store.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { stubLLMCall } from './_narrative-test-deps.js';

/* --------------------------------- constants ------------------------------- */

const DEAL_REF = 'DEMO-CLEARED-MF-001';
const PROPERTY_NAME = 'DEMO Cleared Deal — synthetic (not for underwriting)';
const AS_OF = '2026-05-08T00:00:00Z';
const DEMO_ASSET_TYPE: AssetType = 'Multifamily';

/** Deterministic LoanInPoolId so a re-run maps to the SAME row (idempotent bind). */
const DEMO_LOAN_IN_POOL_ID = 'de300000-0000-4000-8000-000000000001';

/* ------------------------------- CLI arg parse ----------------------------- */

function parseDbArg(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--db');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  return path.join(process.cwd(), 'apps', 'api', 'data', 'cre.db');
}

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

/**
 * The DEMO Multifamily ExtractionResult. Strong, internally-consistent economics.
 * Derived (by the engine): stressedValue ~$23.4M, stressedLTV ~51%, DSCR ~1.9×,
 * debt yield ~13.3%. Only INPUTS are set here — band / score / gate are the engine's.
 */
function makeDemoExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: DEAL_REF,
    rentRoll: {
      // 40 diversified units, 100% occupied. Narrative-only for MF scoring (the
      // spine reads underwritten stabilized vacancy, not unit rows), but recorded
      // honestly so the tape/summary read 40 units / 100%.
      units: Array.from({ length: 40 }, (_, k) => ({
        kind: 'unit' as const,
        unitId: `U${String(k + 1).padStart(2, '0')}`,
        isResidential: true,
        bedrooms: (k % 3) + 1,
        bathrooms: (k % 2) + 1,
        unitType: `${(k % 3) + 1}BR/${(k % 2) + 1}BA`,
        leaseStart: '2025-01-01T00:00:00Z',
        leaseEndOrMTM: '2026-12-31T00:00:00Z',
        baseRentMonthly: 5_000,
        inPlaceRentMonthly: 5_000,
        occupied: true,
        concessionsMonthly: 0,
        securityDeposit: 5_000,
      })),
      summary: { totalUnits: 40, occupiedUnits: 40, economicOccupancy: 1.0 },
    },
    inPlace: {
      period: 'T-12 ending Apr 2026',
      noi: 1_600_000,
      vacancyLoss: 168_000,
      income: {
        grossPotentialRent: 2_400_000,
        effectiveRent: 2_232_000,
        otherIncome: 120_000,
        totalIncome: 2_352_000,
      },
      expenses: {
        taxes: 300_000,
        insurance: 60_000,
        utilities: 120_000,
        repairsMaintenance: 96_000,
        managementFees: 96_000,
        generalAndAdmin: null,
        janitorial: null,
        reimbursements: null,
        totalOperatingExpenses: 752_000,
      },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    // Equal to uwY1Noi → no NOI-divergence haircut (divergence ratio 1.0).
    t12Actual: {
      period: 'T-12 actual ending Apr 2026',
      noi: 1_600_000,
      vacancyLoss: 168_000,
      income: {
        grossPotentialRent: 2_400_000,
        effectiveRent: 2_232_000,
        otherIncome: 120_000,
        totalIncome: 2_352_000,
      },
      expenses: {
        taxes: 300_000,
        insurance: 60_000,
        utilities: 120_000,
        repairsMaintenance: 96_000,
        managementFees: 96_000,
        generalAndAdmin: null,
        janitorial: null,
        reimbursements: null,
        totalOperatingExpenses: 752_000,
      },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    pca: {
      immediateRepairs: 25_000,
      shortTermRepairs: 75_000,
      evaluationPeriodYears: null,
      inflationRate: null,
      replacementReservesPerSfPerYearInflated: null,
      replacementReservesPerSfPerYearUninflated: null,
      capexScheduleInflated: null,
      capexScheduleUninflated: null,
      structural: { roof: 'good', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 26_000_000, capRate: 0.0615, methodology: 'Income' },
    sellerUw: {
      underwrittenNOI: 1_600_000,
      underwrittenRentGrowth: 0.03,
      // 7.0% = the DBRS Multifamily stabilized vacancy floor. A 100%-leased asset
      // is honestly underwritten to this stabilized level (the spine haircuts any
      // tighter figure); it is NOT a reverse-engineered band knob.
      underwrittenVacancy: 0.07,
    },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 26_000_000, impliedCapRate: 0.0615, underwrittenNOI: 1_600_000, priorDebtPayoff: null },
    loanTerms: {
      loanAmount: 12_000_000,
      interestRate: 0.055,
      amortization: 360,
      interestOnlyPeriod: 0,
      maturityDate: '2031-05-08T00:00:00Z',
    },
    sourceDocuments: [],
    extractorVersions: {},
    parties: null,
    annexA: null,
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

/** Multifamily-populated library snapshot (all other asset types null). */
function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Multifamily = {
    vacancy: { median: 0.05, p25: 0.03, p75: 0.07 },
    expenseRatio: { median: 0.40, p25: 0.35, p75: 0.45 },
    capRate: { median: 0.055, p25: 0.05, p75: 0.06 },
    dscr: { median: 1.35, p25: 1.25, p75: 1.50 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 40,
  };
  const dealBody = {
    asOf: AS_OF,
    // Distinct table hash from the test's 'aaa…' so this snapshot content-addresses
    // to its own id (won't collide with any other seeded snapshot).
    approvedDealsTableHash: 'd'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(dealBody), ...dealBody } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Multifamily: 0.055 },
    vacancyRates: { ...ratesAll, Multifamily: 0.05 },
    expensesPerSqFt: { ...expensesAll, Multifamily: 7.50 },
    interestRateAssumptions: { baseRate: 0.055, stressRate: 0.075 },
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

/* ------------------------------ pool selection ----------------------------- */

/**
 * Pick the target pool. PREFER the smaller, active demo-friendly pool
 * 'BMARK 2026-V12' (7 loans, a live current tape) over the 104-loan legacy stub
 * 'BMARK 2024-V8'. Falls back to the newest non-empty pool with a current tape.
 * Returns { poolId, tapeId } — tapeId is the pool's current tape (addedOnTape).
 */
function pickPool(poolStore: PoolStore): { poolId: string; tapeId: TapeId; shelfName: string } {
  const pools = poolStore.listPools();
  const preferred = pools.find((p) => p.shelfName === 'BMARK 2026-V12');
  const candidate =
    preferred ??
    [...pools].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).find((p) => p.currentTapeId);
  if (!candidate) throw new Error('no pool available to bind the DEMO loan (seed a pool first)');
  const tapeId = candidate.currentTapeId as TapeId | null;
  if (!tapeId) throw new Error(`pool ${candidate.shelfName} has no current tape to anchor addedOnTape`);
  return { poolId: candidate.id, tapeId, shelfName: candidate.shelfName };
}

/* ----------------------------------- run ----------------------------------- */

async function main(): Promise<void> {
  const dbPath = parseDbArg();
  const isReal = dbPath.endsWith(path.join('apps', 'api', 'data', 'cre.db'));
  console.log(`seed-cleared-fixture → ${dbPath}${isReal ? '  ⚠ (REAL cre.db)' : '  (temp/other)'}`);

  const recordGraphStore = new RecordGraphStore(dbPath);
  const sqliteStore = new SqliteStore(dbPath);
  const poolStore = new PoolStore(dbPath);

  // ── Idempotency guard: already seeded? ─────────────────────────────────────
  const existing = sqliteStore.lookupAnalysisByDealRef(DEAL_REF);
  if (existing.length > 0) {
    const loanRow = new Database(dbPath, { readonly: true })
      .prepare(`SELECT id, pool_id, lifecycle_status FROM loan_in_pool WHERE deal_ref = ?`)
      .get(DEAL_REF) as { id: string; pool_id: string; lifecycle_status: string | null } | undefined;
    console.log('\nNO-OP: DEMO-CLEARED-MF-001 already ingested — nothing to do.');
    console.log(`  graphRoot(s): ${existing.map((e) => e.graphId).join(', ')}`);
    if (loanRow) {
      console.log(`  loan_in_pool: ${loanRow.id}  pool=${loanRow.pool_id}  lifecycle=${loanRow.lifecycle_status ?? 'null'}`);
    } else {
      console.log('  loan_in_pool: (not bound — ingest present but bind missing; re-run after inspection)');
    }
    return;
  }

  // ── Pre-persist upstream inputs (idempotent inserts) ───────────────────────
  const snapshot = makeSnapshot();
  const benchmarks = makeBenchmarks();
  const manifesto = makeManifesto();
  recordGraphStore.insertLibrarySnapshot(snapshot);
  recordGraphStore.insertMarketBenchmarks(benchmarks);
  recordGraphStore.insertCreditManifesto(manifesto);

  // ── Ingest through the REAL pipeline (own root, own doctrine_evaluations) ───
  const extraction = makeDemoExtraction();
  const result = await ingestExtractionResult(
    {
      extractionResult: extraction,
      propertyType: DEMO_ASSET_TYPE,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: snapshot.id,
      marketBenchmarks: benchmarks,
      creditManifesto: manifesto,
      analysisAsOfDate: AS_OF,
      rentRoll: null,
      // parentRevisionId ABSENT → own root envelope (revisionOrdinal 0).
    },
    recordGraphStore,
    { llmCall: stubLLMCall },
  );

  // ── Bind ONE loan_in_pool into the picked pool (the load-bearing dealRef join) ─
  const { poolId, tapeId, shelfName } = pickPool(poolStore);
  const loan: LoanInPool = {
    // Deterministic uuid so a re-run maps to the same row (idempotent bind).
    id: DEMO_LOAN_IN_POOL_ID as LoanInPool['id'],
    poolId: poolId as LoanInPool['poolId'],
    dealRef: DEAL_REF,
    addedOnTape: tapeId,
    originatorLoanRef: 'DEMO-MF-001',
    propertyName: PROPERTY_NAME,
    assetType: DEMO_ASSET_TYPE,
    currentDispositionId: null,
    lifecycleStatus: null, // UN-closed; the /close in the demo sets 'closed'.
  };
  poolStore.insertLoanInPool(loan);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\nSEEDED (ingested + bound, UN-ratified / UN-closed):');
  console.log(`  dealRef        : ${DEAL_REF}`);
  console.log(`  propertyName   : ${PROPERTY_NAME}`);
  console.log(`  rootId         : ${result.rootId}`);
  console.log(`  evaluationId   : ${result.evaluationId}`);
  console.log(`  derived band   : ${result.evaluation.ratingBand}`);
  console.log(`  derived score  : ${result.evaluation.finalScore}`);
  console.log(`  loan_in_pool   : ${loan.id}`);
  console.log(`  bound to pool  : ${shelfName} (${poolId})  addedOnTape=${tapeId}`);
  console.log(
    '\n  un-ratified: cleared=false until a committee OVERRIDE_DECISION ratifies the condition_precedent lever.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
