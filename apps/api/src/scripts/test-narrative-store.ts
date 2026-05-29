/**
 * Tests for RecordGraphStore narratives table (Piece A Phase 1 batch 1).
 *
 *   npm run test:narrative-store
 *
 * Uses an in-memory sqlite db; no filesystem side effects. Exercises:
 *   - Round-trip insert + getNarrative
 *   - Idempotency (same content-hash id → no-op second insert)
 *   - FK enforcement (narrative with unknown handbookEvaluationId fails)
 *   - FK enforcement (narrative with unknown adjustedInputsId fails)
 *   - getNarrativesForAdjustedInputs returns ordered list
 *   - getLatestNarrativeForAdjustedInputs scopes by engineVersion
 *   - RecordIdMismatchError on tampered body
 *
 * Mirrors test-record-graph-store.ts conventions: hand-rolled assertions,
 * in-memory db per run, minimal FK predecessors built inline.
 */

import {
  EXTRACTION_ENGINE_VERSION,
  HANDBOOK_ENGINE_VERSION,
  JUDGMENT_ENGINE_VERSION,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AssetType,
  ContentHash,
  FieldBag,
  FiredFlag,
  HandbookEvaluation,
  HandbookEvaluationId,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeEngineVersion,
  NarrativeEvaluation,
} from '@cre/contracts';
import { ASSET_TYPES } from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeHandbookEvaluationId,
  computeLibrarySnapshotId,
  computeNarrativeEvaluationId,
} from '../util/content-hash.js';
import {
  RecordGraphStore,
  RecordIdMismatchError,
} from '../storage/record-graph-store.js';

const AS_OF = '2026-05-29T00:00:00Z';

let passed = 0;
let failed = 0;

function ok(message: string): void {
  passed++;
  console.log(`  ok    ${message}`);
}
function fail(message: string): void {
  failed++;
  console.error(`  FAIL  ${message}`);
}
function assert(condition: boolean, message: string): void {
  condition ? ok(message) : fail(message);
}
function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch {
    ok(message);
  }
}
function assertThrowsInstanceOf<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  message: string,
): void {
  try {
    fn();
    fail(`${message} (did not throw)`);
  } catch (e) {
    if (e instanceof ctor) ok(message);
    else fail(`${message} (threw ${(e as Error)?.name})`);
  }
}

/* -------------------------- FK-predecessor fixtures -------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function lineItem(value: number) {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

function makeLibrarySnapshot(): LibrarySnapshot {
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType: emptyByAssetType(),
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeAdjustedInputs(librarySnapshotId: LibrarySnapshotId): AdjustedInputs {
  const body = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId,
    income: {
      grossRentalIncome: lineItem(10_000_000),
      otherIncome: lineItem(500_000),
      vacancyPct: lineItem(0.05),
      concessionsPct: lineItem(0.01),
      effectiveGrossIncome: lineItem(9_400_000),
    },
    expenses: {
      realEstateTaxes: lineItem(800_000),
      insurance: lineItem(150_000),
      utilities: lineItem(200_000),
      managementFee: lineItem(280_000),
      payroll: lineItem(0),
      maintenance: lineItem(300_000),
      other: lineItem(100_000),
      generalAndAdmin: lineItem(0),
      janitorial: lineItem(0),
      reimbursements: lineItem(0),
      totalOperatingExpenses: lineItem(1_830_000),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0),
      upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0),
      monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0),
      monthlyTenantImprovements: lineItem(0),
      monthlyLeasingCommissions: lineItem(0),
      pcaImmediateRepairs: lineItem(0),
      upfrontReplacementReserves: lineItem(0),
      capexScheduleInflated: null,
      capexScheduleUninflated: null,
    },
    loan: {
      loanAmount: lineItem(50_000_000),
      interestRate: lineItem(0.07),
      termMonths: lineItem(120),
      amortizationMonths: lineItem(360),
      ioPeriodMonths: lineItem(0),
      maturityBalance: lineItem(45_000_000),
      debtServiceAnnual: lineItem(4_000_000),
    },
    assumptions: {
      capRate: lineItem(0.065),
      terminalCapRate: lineItem(0.075),
      concludedCapRate: null,
      rentGrowthPct: lineItem(0.03),
      expenseGrowthPct: lineItem(0.03),
    },
    metrics: {
      noi: 7_570_000,
      value: 116_461_538,
      dscr: 1.89,
      ltvAppraisal: 0.625,
      debtYield: 0.1514,
      expenseRatio: 0.195,
      top1IncomeShare: 0.18,
      pctIncomeExpiringWithinTerm: 0.22,
    },
    confidenceReduction: 0.05,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function makeHandbookEvaluation(
  adjustedInputsId: AdjustedInputsId,
  variant: string = 'a',
): HandbookEvaluation {
  const firedFlags: readonly FiredFlag[] = [
    {
      principleId: `P-${variant.toUpperCase()}-1`,
      severity: 'high',
      flag_message: 'Test flag',
      metricValue: 'Office',
      groupIndex: 0,
      bandIndex: 0,
      injectionPoints: ['executive_summary'],
    },
  ];
  const fieldBag: FieldBag = { asset_type: 'Office' };
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId,
    handbookVersion: '2026.1',
    engineVersion: HANDBOOK_ENGINE_VERSION,
    firedFlags,
    skippedPrinciples: [],
    fieldBagSnapshot: fieldBag,
  };
  return { id: computeHandbookEvaluationId(body), ...body };
}

function makeNarrative(
  adjustedInputsId: AdjustedInputsId,
  handbookEvaluationId: HandbookEvaluationId,
  overrides: {
    executiveSummary?: string;
    engineVersion?: NarrativeEngineVersion;
    redFlagAssessment?: string;
  } = {},
): NarrativeEvaluation {
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId,
    handbookEvaluationId,
    engineVersion: overrides.engineVersion ?? (NARRATIVE_ENGINE_VERSION as NarrativeEngineVersion),
    consumedFlagPrincipleIds: ['P-A-1'],
    redFlagAssessmentConsumedFlagPrincipleIds: ['P-A-1'],
    executiveSummary:
      overrides.executiveSummary ??
      'Test executive summary prose. The deal has one high-severity flag (P-A-1).',
    redFlagAssessment:
      overrides.redFlagAssessment ??
      '- [P-A-1] Test red-flag assessment for store test (Phase 2).',
  };
  return { id: computeNarrativeEvaluationId(body), ...body };
}

/* --------------------------------- run ----------------------------------- */

const store = new RecordGraphStore(':memory:');

// Build the FK chain once: LibrarySnapshot → AdjustedInputs → HandbookEvaluation
const lib = makeLibrarySnapshot();
store.insertLibrarySnapshot(lib);
const ai = makeAdjustedInputs(lib.id);
store.insertAdjustedInputs(ai);
const he = makeHandbookEvaluation(ai.id, 'a');
store.insertHandbookEvaluation(he);

console.log('Round-trip insert + get:');
{
  const narr = makeNarrative(ai.id, he.id);
  const r1 = store.insertNarrative(narr);
  assert(r1.inserted, 'insertNarrative reports inserted=true on first call');
  const fetched = store.getNarrative(narr.id);
  assert(fetched !== null, 'getNarrative returns row for known id');
  assert(fetched?.id === narr.id, 'retrieved id matches original');
  assert(fetched?.adjustedInputsId === ai.id, 'adjustedInputsId round-trips');
  assert(fetched?.handbookEvaluationId === he.id, 'handbookEvaluationId round-trips');
  assert(fetched?.engineVersion === NARRATIVE_ENGINE_VERSION, 'engineVersion round-trips');
  assert(
    fetched?.executiveSummary.startsWith('Test executive summary') ?? false,
    'executiveSummary round-trips',
  );

  if (fetched) {
    const { id: _retId, ...retBody } = fetched;
    const recomputed = computeNarrativeEvaluationId(retBody);
    assert(recomputed === narr.id, 'retrieved body re-hashes to original id');
  }
}

console.log('\nIdempotency:');
{
  const narr = makeNarrative(ai.id, he.id);
  store.insertNarrative(narr);
  const r2 = store.insertNarrative(narr);
  assert(!r2.inserted, 'second insert of same content reports inserted=false');
}

console.log('\nNonexistent get:');
{
  const fetched = store.getNarrative('z'.repeat(64) as never);
  assert(fetched === null, 'getNarrative returns null for unknown id');
}

console.log('\nID mismatch detection:');
{
  const narr = makeNarrative(ai.id, he.id, { executiveSummary: 'X' });
  const tampered = { ...narr, executiveSummary: 'Y' };  // body changed, id not recomputed
  assertThrowsInstanceOf(
    () => store.insertNarrative(tampered as NarrativeEvaluation),
    RecordIdMismatchError,
    'insert with mismatched id throws RecordIdMismatchError',
  );
}

console.log('\nFK enforcement — unknown handbookEvaluationId:');
{
  const orphanHe = 'f'.repeat(64) as HandbookEvaluationId;
  const orphan = makeNarrative(ai.id, orphanHe, { executiveSummary: 'orphan-he' });
  assertThrows(
    () => store.insertNarrative(orphan),
    'narrative with unknown handbookEvaluationId fails FK',
  );
}

console.log('\nFK enforcement — unknown adjustedInputsId:');
{
  const orphanAi = '0'.repeat(64) as AdjustedInputsId;
  const orphan = makeNarrative(orphanAi, he.id, { executiveSummary: 'orphan-ai' });
  assertThrows(
    () => store.insertNarrative(orphan),
    'narrative with unknown adjustedInputsId fails FK',
  );
}

console.log('\ngetNarrativesForAdjustedInputs — multi-row, newest-first:');
{
  // Insert a second narrative with different content so its id differs
  const second = makeNarrative(ai.id, he.id, {
    executiveSummary: 'Second narrative with different prose.',
  });
  // Tiny delay so created_at differs across the two inserts. better-sqlite3
  // serializes synchronously so back-to-back inserts can land in the same
  // ISO millisecond — force a fresh tick by busy-loop until clock moves.
  const t0 = Date.now();
  while (Date.now() === t0) { /* spin */ }
  store.insertNarrative(second);

  const all = store.getNarrativesForAdjustedInputs(ai.id);
  assert(all.length >= 2, `at least 2 narratives present (got ${all.length})`);
  // newest first by created_at
  assert(all[0]!.id === second.id, 'newest narrative first');
}

console.log('\ngetLatestNarrativeForAdjustedInputs — scoped by engineVersion:');
{
  const latest = store.getLatestNarrativeForAdjustedInputs(
    ai.id,
    NARRATIVE_ENGINE_VERSION as NarrativeEngineVersion,
  );
  assert(latest !== null, 'latest narrative at current engine version exists');
  assert(latest?.engineVersion === NARRATIVE_ENGINE_VERSION, 'returned narrative is at requested version');

  // unknown adjusted_inputs_id → null
  const none = store.getLatestNarrativeForAdjustedInputs(
    '9'.repeat(64),
    NARRATIVE_ENGINE_VERSION as NarrativeEngineVersion,
  );
  assert(none === null, 'unknown adjustedInputsId returns null');
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
