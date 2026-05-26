import { buildHandbookEvaluation } from '../services/handbook/build-handbook-evaluation.js';
import type { BuildHandbookEvaluationArgs } from '../services/handbook/build-handbook-evaluation.js';
import { computeHandbookEvaluationId } from '../util/content-hash.js';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AdjustedLineItem,
  AssetProfile,
  AssetProfileId,
  HandbookEvaluation,
  ISODateTime,
  LibrarySnapshotId,
  NarrativeFacts,
  NarrativeFactsId,
  PropertyMetadata,
  PropertyMetadataId,
  StressOutputs,
  StressOutputsId,
} from '@cre/contracts';

// =============================================================================
// Hand-rolled runner
// =============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}
function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(m);
  else fail(`${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}
function assertTruthy(value: unknown, m: string): void {
  if (value) ok(m);
  else fail(`${m} (value was ${JSON.stringify(value)})`);
}

// =============================================================================
// Fixtures
// =============================================================================

const AS_OF: ISODateTime = '2026-01-01T00:00:00.000Z' as ISODateTime;

function lineItem(value: number): AdjustedLineItem {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

function makeAdjustedInputs(
  id: AdjustedInputsId,
  overrides: { readonly dscr?: number; readonly debtYield?: number; readonly loanAmount?: number } = {},
): AdjustedInputs {
  const loanAmount = overrides.loanAmount ?? 30_000_000;
  const dscr = overrides.dscr ?? 1.10;
  const debtYield = overrides.debtYield ?? 0.085;
  return {
    id,
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: '1.2',
    librarySnapshotId: ('lib' + '0'.repeat(61)) as LibrarySnapshotId,
    income: {
      grossRentalIncome: lineItem(0), otherIncome: lineItem(0),
      vacancyPct: lineItem(0), concessionsPct: lineItem(0),
      effectiveGrossIncome: lineItem(0),
    },
    expenses: {
      realEstateTaxes: lineItem(0), insurance: lineItem(0),
      utilities: lineItem(0), managementFee: lineItem(0),
      payroll: lineItem(0), maintenance: lineItem(0),
      other: lineItem(0), generalAndAdmin: lineItem(0),
      janitorial: lineItem(0), reimbursements: lineItem(0),
      totalOperatingExpenses: lineItem(0),
    },
    capitalReserves: {
      upfrontCapex: lineItem(0), upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0), monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0),
      monthlyTenantImprovements: lineItem(0), monthlyLeasingCommissions: lineItem(0),
      pcaImmediateRepairs: lineItem(0), upfrontReplacementReserves: lineItem(0),
      capexScheduleInflated: null, capexScheduleUninflated: null,
    },
    loan: {
      loanAmount: lineItem(loanAmount), interestRate: lineItem(0),
      termMonths: lineItem(0), amortizationMonths: lineItem(0),
      ioPeriodMonths: lineItem(0), maturityBalance: lineItem(0),
      debtServiceAnnual: lineItem(0),
    },
    assumptions: {
      capRate: lineItem(0), terminalCapRate: lineItem(0),
      rentGrowthPct: lineItem(0), expenseGrowthPct: lineItem(0),
    },
    metrics: {
      noi: 0, value: 0, dscr, ltvAppraisal: 0, debtYield,
      expenseRatio: 0, top1IncomeShare: 0, pctIncomeExpiringWithinTerm: 0,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
}

function makeArgs(overrides: Partial<BuildHandbookEvaluationArgs> = {}): BuildHandbookEvaluationArgs {
  const adjustedInputs: AdjustedInputs = makeAdjustedInputs('aaaa' as AdjustedInputsId);

  const assetProfile: AssetProfile = {
    id: ('ap' + '0'.repeat(62)) as AssetProfileId,
    propertyType: 'Office',
    businessPlan: 'Stabilized',
    marketLiquidity: 'Primary',
  };

  const narrativeFacts: NarrativeFacts = {
    id: ('nf' + '0'.repeat(62)) as NarrativeFactsId,
    analysisAsOfDate: AS_OF,
    trailingOccAvg: null, occupancyCurrent: null,
    propertyClass: null, shadowVacancyFlag: null,
    subleaseCompetition: null, leasingVelocityDataAvailable: null,
    isMall: null,
    franchiseExpirationWithinTerm: null, pipRequired: null, pipBudgetPerKey: null,
    privateWastewater: null, parkOwnedHomesPct: null,
    t12NoiTrend: null,
    isSingleTenant: false,
    appraisalValue: null, appraisalCapRate: null,
    asrValue: null, marketValueFromComps: null,
    exitCapRateBase: null, exitCapRateStressed: null,
  };

  const stressOutputs: StressOutputs = {
    id: ('so' + '0'.repeat(62)) as StressOutputsId,
    analysisAsOfDate: AS_OF,
    adjustedInputsId: adjustedInputs.id,
    stressEngineVersion: '1.0',
    method: 'TENANT_REMOVAL',
    scenarios: [{
      name: 'Remove T1+T2+T3', noi: null, dscr: 0.92, value: null, ltv: null, debtYield: null,
      breaches: [], skipped: [],
    }],
  };

  const propertyMetadata: PropertyMetadata = {
    id: 'pmpmpmpm' as PropertyMetadataId,
    source: 'asr_extraction',
    propertyName: null,
    propertySubtype: 'Suburban Office',
    address: null, city: null, state: null, zip: null, county: null,
    msa: 'Atlanta-Sandy Springs-Alpharetta, GA MSA',
    submarket: null,
    yearBuilt: 1996, yearRenovated: null,
    buildingClass: 'B',
    totalSquareFeet: null, totalUnits: null, totalRooms: null, totalPads: null,
    occupancyPhysical: null, occupancyEconomic: null,
    ownershipInterest: null, numberOfBuildings: null,
  };

  return {
    adjustedInputs, assetProfile, narrativeFacts, stressOutputs, propertyMetadata,
    analysisAsOfDate: AS_OF,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

console.log('\n=== Record construction ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(eval_.id, 'record has an id');
  assertEqual(eval_.adjustedInputsId, 'aaaa', 'adjustedInputsId FKs to AdjustedInputs');
  assertEqual(eval_.handbookVersion, '2026.1', 'handbookVersion stamped from handbook constant');
  assertEqual(eval_.engineVersion, '1.0.0', 'engineVersion stamped as constant');
  assertEqual(eval_.analysisAsOfDate, '2026-01-01T00:00:00.000Z', 'analysisAsOfDate preserved');
  assertTruthy(eval_.fieldBagSnapshot, 'fieldBagSnapshot present');
  assertTruthy(Array.isArray(eval_.firedFlags), 'firedFlags is array');
  assertTruthy(Array.isArray(eval_.skippedPrinciples), 'skippedPrinciples is array');
})();

console.log('\n=== Id consistency (store will recompute and verify) ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  const { id, ...body } = eval_;
  const recomputed = computeHandbookEvaluationId(body);
  assertEqual(id, recomputed, 'producer-computed id matches recomputation from body');
})();

console.log('\n=== Engine output propagates (adapted to real handbook) ===');

// Fixture (Office, Class B, DSCR 1.10, stressed DSCR 0.92) should fire at
// least P-IV-OFF-2 (Class B office). Real engine returns ~80 skips total.
(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(
    eval_.firedFlags.length >= 1,
    'at least one flag fires for Class B office with low DSCR',
  );
  const offTwo = eval_.firedFlags.find((f) => f.principleId === 'P-IV-OFF-2');
  assertTruthy(offTwo, 'P-IV-OFF-2 (Class B office) fires for this fixture');
})();

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(
    eval_.skippedPrinciples.length >= 1,
    'at least one skipped principle (real engine returns many)',
  );
  // Spot-check: principles that need fields the fixture doesn't populate
  // should skip with reason 'missing_field' or 'trigger_inactive'.
  const reasons = new Set(eval_.skippedPrinciples.map((s) => s.reason));
  assertTruthy(
    reasons.has('missing_field') || reasons.has('trigger_inactive'),
    'skips include at least one missing_field or trigger_inactive (data-gap diagnostics)',
  );
})();

console.log('\n=== fieldBagSnapshot reflects assembler output ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertEqual(eval_.fieldBagSnapshot['asset_type'], 'Office', 'snapshot includes asset_type');
  assertEqual(eval_.fieldBagSnapshot['dscr'], 1.10, 'snapshot includes dscr');
  assertEqual(
    eval_.fieldBagSnapshot['building_class'],
    'B',
    'snapshot includes building_class (from metadata)',
  );
})();

console.log('\n=== Null PropertyMetadata: producer succeeds, metadata fields absent ===');

(() => {
  const args = makeArgs({ propertyMetadata: null });
  const eval_ = buildHandbookEvaluation(args);
  assertTruthy(eval_.id, 'record built successfully with null propertyMetadata');
  assertEqual(eval_.fieldBagSnapshot['msa'], undefined, 'msa undefined when metadata null');
  assertEqual(
    eval_.fieldBagSnapshot['building_class'],
    undefined,
    'building_class undefined when metadata null',
  );
  assertEqual(eval_.fieldBagSnapshot['asset_type'], 'Office', 'asset_type still present');
})();

console.log('\n=== Determinism: same inputs → same id ===');

(() => {
  const eval1 = buildHandbookEvaluation(makeArgs());
  const eval2 = buildHandbookEvaluation(makeArgs());
  assertEqual(eval1.id, eval2.id, 'same inputs produce same id');
})();

console.log('\n=== Different inputs → different ids ===');

(() => {
  const eval1 = buildHandbookEvaluation(makeArgs());
  const eval2 = buildHandbookEvaluation(
    makeArgs({
      adjustedInputs: makeAdjustedInputs('bbbb' as AdjustedInputsId, {
        loanAmount: 5_000_000, dscr: 2.50, debtYield: 0.15,
      }),
    }),
  );
  if (eval1.id === eval2.id) {
    fail('different inputs produced identical ids (content-hash should differ)');
  } else {
    ok('different inputs produce different ids');
  }
})();

console.log('\n=== JSON round-trip preserves all fields ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  const round = JSON.parse(JSON.stringify(eval_)) as HandbookEvaluation;
  assertEqual(round.handbookVersion, eval_.handbookVersion, 'handbookVersion survives round-trip');
  assertEqual(round.firedFlags.length, eval_.firedFlags.length, 'firedFlags survives');
  assertEqual(
    round.skippedPrinciples.length,
    eval_.skippedPrinciples.length,
    'skippedPrinciples survives',
  );
  assertEqual(round.fieldBagSnapshot['asset_type'], 'Office', 'snapshot survives');
})();

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
