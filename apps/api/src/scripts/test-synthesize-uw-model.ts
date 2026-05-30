/**
 * Phase 1 test — synthesizeUwModelFromGraph.
 *
 *   npx tsx apps/api/src/scripts/test-synthesize-uw-model.ts
 *
 * Verifies:
 *   - Each mapped field reads through faithfully (income, expenses, loan,
 *     metrics).
 *   - Sign convention is correct (vacancy / concessions negative).
 *   - Unit conversions land in the expected units (pct→$, monthly→annual,
 *     decimal→percent, months→years).
 *   - Internal consistency: NOI = EGI - totalExpenses (uw-calc), DSCR =
 *     NOI / annualDebtService, impliedValue = NOI / capRate, debtYield =
 *     NOI / loanAmount, LTV = loanAmount / impliedValue.
 *   - recalculateFullModel accepts the synthesized model without throwing
 *     and the schedule length matches the amortization term.
 *   - NO-SOURCE defaults applied.
 *   - All line items marked non-editable.
 *
 * Also dumps a full sample synthesized uwModel for review (the Phase 1
 * faithfulness checkpoint).
 */

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
  MarketBenchmarks,
  PropertyMetadata,
} from '@cre/contracts';
import {
  computeContentHash,
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
  computePropertyMetadataId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { synthesizeUwModelFromGraph } from '../services/synthesize-uw-model-from-graph.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

const AS_OF = '2026-05-30T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, m: string, tolerance = 0.01): void {
  Math.abs(a - b) <= tolerance ? ok(m) : fail(`${m} (actual=${a}, expected≈${b}, |diff|=${Math.abs(a - b)})`);
}

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'PHASE-1-SYNTH-TEST',
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
      belowNoiAdjustments: { replacementReserves: 9_000, tenantImprovements: null, leasingCommissions: null },
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
    sourceDocuments: [], extractorVersions: {},
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
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 }, n: 25,
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

function makePropertyMetadata(): PropertyMetadata {
  const body = {
    source: 'manual_entry' as const,
    propertyName: 'Phase-1 Synth Office',
    propertySubtype: 'Suburban Office',
    address: '123 Synth Way', city: 'San Diego', state: 'CA', zip: '92101',
    county: 'San Diego', msa: 'San Diego-Chula Vista-Carlsbad', submarket: 'Mission Valley',
    yearBuilt: 1998, yearRenovated: 2018, buildingClass: 'B',
    totalSquareFeet: 50_000, totalUnits: 2, totalRooms: null, totalPads: null,
    occupancyPhysical: 0.95, occupancyEconomic: 0.93,
    ownershipInterest: 'Fee Simple', numberOfBuildings: 1,
  };
  return { id: computePropertyMetadataId(body), ...body } as PropertyMetadata;
}

const stubLlm: LLMCallFn = async ({ messages }) => {
  const content = messages[0]?.content;
  const text = typeof content === 'string' ? content : '';
  if (text.includes('committee recommendation')) return 'committee stub';
  if (text.includes('mitigation-suggestions list')) return '- [P] mitigation stub';
  if (text.includes('red-flag assessment')) return '- [P] red flag stub';
  return 'stub exec summary';
};

(async () => {
  const store = new RecordGraphStore(':memory:');
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);

  // Pre-insert ExtractionResult + PropertyMetadata + cache row so PM is
  // resolvable via getPropertyMetadataByExtractionResultId during ingest.
  const extraction = makeFullExtraction();
  const pm = makePropertyMetadata();
  store.insertExtractionResult(extraction);
  store.insertPropertyMetadata(pm);
  store.insertExtractionInputCache({
    cacheKey: computeContentHash(`phase1-synth-${Date.now()}`) as ContentHash,
    extractionResultId: extraction.id,
    propertyMetadataId: pm.id,
    cfHash: null, rentRollHash: null, asrHash: null, pcaHash: null,
    extractorVersions: {},
  });

  const ingest = await ingestExtractionResult(
    {
      extractionResult: extraction,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
    },
    store,
    { llmCall: stubLlm },
  );

  // Fetch graph records for assertion comparison.
  const envelope = store.getRevisionEnvelope(ingest.rootId);
  if (envelope === null) { console.error('envelope null'); process.exit(1); }
  const ai = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (ai === null) { console.error('AI null'); process.exit(1); }

  // Run synthesis.
  const uw = synthesizeUwModelFromGraph(ingest.rootId, store);
  if (uw === null) {
    console.error('FAIL: synthesizeUwModelFromGraph returned null');
    process.exit(1);
  }

  console.log('1. resolution');
  assert(uw !== null, '1.1 synthesis returned non-null for valid rootRevisionId');

  console.log('\n2. income — direct + signed-pct conversions');
  assertEqual(uw.income.grossPotentialRent.annualAmount, ai.income.grossRentalIncome.adjusted, '2.1 GPR direct map');
  assertEqual(uw.income.otherIncome.annualAmount, ai.income.otherIncome.adjusted, '2.2 otherIncome direct map');
  assertClose(uw.income.vacancyLoss.annualAmount, -(ai.income.vacancyPct.adjusted * ai.income.grossRentalIncome.adjusted), '2.3 vacancyLoss = -(vacancyPct * GPR)');
  assert(uw.income.vacancyLoss.annualAmount <= 0, '2.4 vacancyLoss is signed-negative (or zero)');
  assertClose(uw.income.concessions.annualAmount, -(ai.income.concessionsPct.adjusted * ai.income.grossRentalIncome.adjusted), '2.5 concessions = -(concessionsPct * GPR)');
  assert(uw.income.concessions.annualAmount <= 0, '2.6 concessions is signed-negative (or zero)');
  assertEqual(uw.income.additionalItems.length, 0, '2.7 additionalItems = [] (no graph source)');

  console.log('\n3. expenses — direct + namespace/granularity conversions');
  assertEqual(uw.expenses.realEstateTaxes.annualAmount, ai.expenses.realEstateTaxes.adjusted, '3.1 taxes direct map');
  assertEqual(uw.expenses.insurance.annualAmount, ai.expenses.insurance.adjusted, '3.2 insurance direct map');
  assertEqual(uw.expenses.utilities.annualAmount, ai.expenses.utilities.adjusted, '3.3 utilities direct map');
  assertEqual(uw.expenses.repairsAndMaintenance.annualAmount, ai.expenses.maintenance.adjusted, '3.4 repairsAndMaintenance ← AI.expenses.maintenance');
  assertEqual(uw.expenses.management.annualAmount, ai.expenses.managementFee.adjusted, '3.5 management ← AI.expenses.managementFee');
  assertEqual(uw.expenses.generalAndAdmin.annualAmount, ai.expenses.generalAndAdmin.adjusted, '3.6 generalAndAdmin direct map');
  assertEqual(uw.expenses.payroll.annualAmount, ai.expenses.payroll.adjusted, '3.7 payroll direct map');
  assertEqual(uw.expenses.replacementReserves.annualAmount, ai.capitalReserves.monthlyReplacementReserves.adjusted * 12, '3.8 replacementReserves = AI.capitalReserves.monthly × 12');
  // additionalItems carries the judgment-engine NOI cap entry (or is empty when
  // line-item math already matches AI.metrics.noi exactly).
  assert(uw.expenses.additionalItems.length <= 1, '3.9a additionalItems has at most one entry (Judgment Engine Adjustment when NOI cap fired)');
  if (uw.expenses.additionalItems.length === 1) {
    assertEqual(uw.expenses.additionalItems[0].label, 'Judgment Engine Adjustment', '3.9b additionalItem labeled "Judgment Engine Adjustment"');
    assertEqual(uw.expenses.additionalItems[0].isEditable, false, '3.9c JE adjustment is non-editable');
  }

  console.log('\n4. loan — unit conversions');
  assertEqual(uw.loanAmount, ai.loan.loanAmount.adjusted, '4.1 loanAmount direct');
  assertClose(uw.interestRate, ai.loan.interestRate.adjusted * 100, '4.2 interestRate = AI.loan.interestRate.adjusted × 100 (decimal → percent)');
  assertEqual(uw.amortizationYears, ai.loan.amortizationMonths.adjusted / 12, '4.3 amortizationYears = months / 12');
  assertEqual(uw.termYears, ai.loan.termMonths.adjusted / 12, '4.4 termYears = months / 12');
  assertEqual(uw.loanDetails.amortizationMonths, ai.loan.amortizationMonths.adjusted, '4.5 loanDetails.amortizationMonths direct');
  assertEqual(uw.loanDetails.termMonths, ai.loan.termMonths.adjusted, '4.6 loanDetails.termMonths direct');
  assertEqual(uw.loanDetails.ioMonths, ai.loan.ioPeriodMonths.adjusted, '4.7 loanDetails.ioMonths ← AI.loan.ioPeriodMonths');
  assertEqual(uw.loanDetails.rateType, 'fixed', '4.8 NO-SOURCE default: rateType = "fixed"');
  assertEqual(uw.loanDetails.paymentFrequency, 'monthly', '4.9 NO-SOURCE default: paymentFrequency = "monthly"');
  assertEqual(uw.loanDetails.prepaymentTerms, '', '4.10 NO-SOURCE default: prepaymentTerms = ""');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(uw.loanDetails.originationDate), '4.11 NO-SOURCE default: originationDate = today ISO');

  console.log('\n5. metrics — computed by recalculateFullModel');
  assertEqual(uw.capRate, ai.assumptions.capRate.adjusted, '5.1 capRate direct map');
  // After the judgment-engine-cap additionalItem closes the gap, synthesized
  // NOI must match AI.metrics.noi (the canonical post-cap graph value).
  assertClose(uw.netOperatingIncome, ai.metrics.noi ?? 0, '5.2 NOI === AI.metrics.noi after JE-cap closure', 1.0);
  // DSCR = NOI / annualDebtService. Both come from recalc.
  if (uw.annualDebtService !== null && uw.dscr !== null) {
    assertClose(uw.dscr, uw.netOperatingIncome / uw.annualDebtService, '5.3 DSCR = NOI / annualDebtService (internal consistency)');
  } else {
    fail('5.3 expected non-null DSCR and annualDebtService for this fixture');
  }
  // impliedValue = NOI / capRate
  if (uw.impliedValue !== null && uw.capRate > 0) {
    assertClose(uw.impliedValue, uw.netOperatingIncome / uw.capRate, '5.4 impliedValue = NOI / capRate (internal consistency)');
  } else {
    fail('5.4 expected non-null impliedValue for this fixture');
  }
  // debtYield = NOI / loanAmount
  if (uw.debtYield !== null) {
    assertClose(uw.debtYield, uw.netOperatingIncome / uw.loanAmount, '5.5 debtYield = NOI / loanAmount');
  } else {
    fail('5.5 expected non-null debtYield');
  }
  // LTV = loanAmount / impliedValue
  if (uw.ltv !== null && uw.impliedValue !== null) {
    assertClose(uw.ltv, uw.loanAmount / uw.impliedValue, '5.6 LTV = loanAmount / impliedValue');
  } else {
    fail('5.6 expected non-null LTV');
  }

  console.log('\n6. recalculateFullModel acceptance + schedule length');
  assert(uw.repaymentSchedule !== null, '6.1 repaymentSchedule generated (non-null)');
  if (uw.repaymentSchedule !== null) {
    // generateRepaymentSchedule iterates `m = 1..termMonths` (uw-calc.ts:152),
    // so the entry count equals the loan TERM (not the amortization period).
    // A 30-year amort with a 5-year balloon → 60 entries + a non-zero balloon.
    assertEqual(uw.repaymentSchedule.entries.length, uw.loanDetails.termMonths, '6.2 schedule length === termMonths');
    assert(uw.repaymentSchedule.summary.balloonBalance >= 0, '6.3 balloonBalance non-negative');
    assert(uw.repaymentSchedule.summary.minDSCR === null || uw.repaymentSchedule.summary.minDSCR > 0, '6.4 minDSCR null or positive');
  }

  console.log('\n7. line items marked non-editable');
  const allItems = [
    ...Object.values(uw.income).filter((v): v is import('@cre/shared').LineItem => typeof v === 'object' && v !== null && 'annualAmount' in v),
    ...Object.values(uw.expenses).filter((v): v is import('@cre/shared').LineItem => typeof v === 'object' && v !== null && 'annualAmount' in v),
  ];
  for (const it of allItems) {
    assertEqual(it.isEditable, false, `7.x ${it.label} isEditable === false`);
    assertEqual(it.isOverridden, false, `7.x ${it.label} isOverridden === false`);
  }

  console.log('\n8. NO-SOURCE defaults + model-level fields');
  assertEqual(uw.asReported, false, '8.1 asReported = false (synthesized)');
  assertEqual(uw.modifiedCells.length, 0, '8.2 modifiedCells = []');
  assertEqual(uw.totalUnits, 2, '8.3 totalUnits from PropertyMetadata');
  assertEqual(uw.totalSqFt, 50_000, '8.4 totalSqFt from PropertyMetadata');

  // ---------------- Sample dump (faithfulness checkpoint) ----------------
  console.log('\n\n=== SAMPLE SYNTHESIZED uwModel (faithfulness checkpoint) ===');
  console.log(`Deal: PHASE-1-SYNTH-TEST (Office, synthetic 2-unit, w/ PropertyMetadata)`);
  console.log(`Source: graphRevisionId=${ingest.rootId}`);
  console.log('');
  console.log('Headline metrics (recalculated from line items):');
  console.log(`  NOI               : $${uw.netOperatingIncome.toLocaleString()}    (AI.metrics.noi = $${ai.metrics.noi?.toLocaleString() ?? 'null'})`);
  console.log(`  Cap Rate          : ${(uw.capRate * 100).toFixed(2)}%             (AI.assumptions.capRate = ${(ai.assumptions.capRate.adjusted * 100).toFixed(2)}%)`);
  console.log(`  Implied Value     : $${uw.impliedValue?.toLocaleString() ?? 'null'}    (AI.metrics.value = $${ai.metrics.value?.toLocaleString() ?? 'null'})`);
  console.log(`  Loan Amount       : $${uw.loanAmount.toLocaleString()}`);
  console.log(`  Interest Rate     : ${uw.interestRate.toFixed(3)}%               (AI.loan.interestRate.adjusted = ${ai.loan.interestRate.adjusted})`);
  console.log(`  Annual Debt Svc   : $${uw.annualDebtService?.toLocaleString() ?? 'null'}    (AI.loan.debtServiceAnnual = $${ai.loan.debtServiceAnnual.adjusted.toLocaleString()})`);
  console.log(`  DSCR              : ${uw.dscr?.toFixed(3) ?? 'null'}              (AI.metrics.dscr = ${ai.metrics.dscr?.toFixed(3) ?? 'null'})`);
  console.log(`  LTV               : ${uw.ltv !== null ? (uw.ltv * 100).toFixed(2) + '%' : 'null'}             (AI.metrics.ltvAppraisal = ${ai.metrics.ltvAppraisal !== null ? (ai.metrics.ltvAppraisal * 100).toFixed(2) + '%' : 'null'})`);
  console.log(`  Debt Yield        : ${uw.debtYield !== null ? (uw.debtYield * 100).toFixed(2) + '%' : 'null'}        (AI.metrics.debtYield = ${ai.metrics.debtYield !== null ? (ai.metrics.debtYield * 100).toFixed(2) + '%' : 'null'})`);
  console.log('');
  console.log('Income tab:');
  for (const k of ['grossPotentialRent', 'vacancyLoss', 'concessions', 'otherIncome', 'effectiveGrossIncome'] as const) {
    const it = uw.income[k];
    console.log(`  ${it.label.padEnd(28)}: $${it.annualAmount.toLocaleString().padStart(14)}   (editable=${it.isEditable})`);
  }
  console.log('');
  console.log('Expense tab:');
  for (const k of ['realEstateTaxes', 'insurance', 'utilities', 'repairsAndMaintenance', 'management', 'generalAndAdmin', 'payroll', 'replacementReserves', 'totalExpenses'] as const) {
    const it = uw.expenses[k];
    console.log(`  ${it.label.padEnd(28)}: $${it.annualAmount.toLocaleString().padStart(14)}   (editable=${it.isEditable})`);
  }
  console.log('');
  console.log('Loan details:');
  console.log(`  amount=$${uw.loanDetails.loanAmount.toLocaleString()}  rate=${uw.loanDetails.interestRate}%  type=${uw.loanDetails.rateType}`);
  console.log(`  term=${uw.loanDetails.termMonths}mo (${uw.termYears}yr)  amort=${uw.loanDetails.amortizationMonths}mo (${uw.amortizationYears}yr)`);
  console.log(`  IO=${uw.loanDetails.ioMonths}mo  freq=${uw.loanDetails.paymentFrequency}  prepay="${uw.loanDetails.prepaymentTerms}"  origDate=${uw.loanDetails.originationDate}`);
  console.log('');
  console.log('Repayment schedule:');
  console.log(`  entries=${uw.repaymentSchedule?.entries.length ?? 0}  totalInterest=$${uw.repaymentSchedule?.summary.totalInterest.toLocaleString() ?? 'n/a'}  balloon=$${uw.repaymentSchedule?.summary.balloonBalance.toLocaleString() ?? 'n/a'}  minDSCR=${uw.repaymentSchedule?.summary.minDSCR ?? 'n/a'}`);
  console.log('');
  console.log('Model meta:');
  console.log(`  totalUnits=${uw.totalUnits}  totalSqFt=${uw.totalSqFt}  asReported=${uw.asReported}  modifiedCells.length=${uw.modifiedCells.length}`);
  console.log('=== END SAMPLE ===');

  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
