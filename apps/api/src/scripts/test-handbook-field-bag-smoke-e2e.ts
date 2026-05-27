/**
 * End-to-end smoke test: synthetic deal → assembler → engine → fired flags.
 *
 * Proves the assembler's output is consumable by the engine for real
 * principles. Validates two scenarios chosen to exercise the populated
 * fields:
 *
 *   Scenario A: Office deal with weak metrics
 *     - Class B building, 30 years old, $30M loan, 0.85 stressed DSCR
 *     - Expect: P-IV-OFF-2 fires (Class B office), P-IV-OFF-6 fires
 *       (stressed DSCR < 1.0), various others may skip with
 *       missing_field for unimplemented data sources
 *
 *   Scenario B: Single-tenant deal with sponsor's dark value blocked
 *     - Single-Tenant tenancy, but appraised_dark_value not extracted
 *     - Expect: P-IV-ST-1 (LLM_CONTEXT only, no deterministic check;
 *       skip with 'not_deterministic'); P-IV-ST-4 (deterministic but
 *       trigger requires field_exists appraised_dark_value) skips with
 *       'trigger_inactive'
 *
 * INTEGRATION NOTE FOR CC: this smoke test runs against a private copy
 * of the engine in /home/claude/field-bag-assembler/_real-engine/. At
 * integration, swap to:
 *   import { handbook } from '@cre/handbook-data';
 *   import { evaluateHandbook } from '@cre/handbook-engine';
 */

import { buildFieldBag } from '../services/handbook/assembler.js';
import type { AssemblerInputs } from '../services/handbook/assembler.js';
import { ASSET_TYPES } from '@cre/contracts';
import {
  DOCTRINE_VERSION,
  EXTRACTION_ENGINE_VERSION,
  STRESS_ENGINE_VERSION,
  VALUATION_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AdjustedLineItem,
  AssetProfile,
  AssetProfileId,
  AssetType,
  ContentHash,
  CrossCheckResult,
  CrossCheckResultId,
  DoctrineEvaluation,
  DoctrineEvaluationId,
  ExtractionResult,
  ExtractionResultId,
  HydratedRecordGraph,
  ISODateTime,
  LibrarySnapshot,
  LibrarySnapshotId,
  NarrativeFacts,
  NarrativeFactsId,
  PropertyMetadata,
  PropertyMetadataId,
  PropertyType,
  StressOutputs,
  StressOutputsId,
  StressScenarioOutput,
  ValuationConclusion,
  ValuationConclusionId,
} from '@cre/contracts';

import { handbook } from '@cre/handbook-data';
import { evaluateHandbook } from '@cre/handbook-engine';

// =============================================================================
// Hand-rolled test runner
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

function assertFlagFired(
  result: ReturnType<typeof evaluateHandbook>,
  principleId: string,
  m: string,
): void {
  const fired = result.firedFlags.find((f) => f.principleId === principleId);
  if (fired) {
    ok(m);
  } else {
    const skipped = result.skippedPrinciples.find(
      (s) => s.principleId === principleId,
    );
    fail(
      `${m} (principle ${principleId} did not fire; skip reason: ${skipped?.reason ?? 'unknown'})`,
    );
  }
}

function assertFlagSkippedWith(
  result: ReturnType<typeof evaluateHandbook>,
  principleId: string,
  expectedReason: string,
  m: string,
): void {
  const skipped = result.skippedPrinciples.find(
    (s) => s.principleId === principleId,
  );
  const fired = result.firedFlags.find((f) => f.principleId === principleId);
  if (fired) {
    fail(`${m} (principle ${principleId} unexpectedly fired)`);
  } else if (skipped && skipped.reason === expectedReason) {
    ok(m);
  } else {
    fail(
      `${m} (expected skip reason '${expectedReason}', got '${skipped?.reason ?? 'NOT_FOUND'}')`,
    );
  }
}

// =============================================================================
// Fixture builders
// =============================================================================

// Fixture builders construct full-shape contract literals with sensible
// defaults for fields the smoke scenarios don't exercise. Per §13.6
// discipline: type-checked construction at file-local builder boundaries,
// no `as unknown as` casts. Callers pass flat scalar overrides for the
// deal-shape dimensions (loanAmount, dscr, debtYield, propertyType) +
// typed Partial<T> overrides for sub-records that vary as units.

const AS_OF: ISODateTime = '2026-01-01T00:00:00.000Z' as ISODateTime;

function lineItem(value: number): AdjustedLineItem {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

function makeStressScenario(
  overrides: Partial<StressScenarioOutput> = {},
): StressScenarioOutput {
  return {
    name: '',
    noi: null,
    dscr: null,
    value: null,
    ltv: null,
    debtYield: null,
    breaches: [],
    skipped: [],
    ...overrides,
  };
}

function emptyByAssetType(): { readonly [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

const defaultAssetProfile: AssetProfile = {
  id: ('ap' + '0'.repeat(62)) as AssetProfileId,
  propertyType: 'Office',
  businessPlan: 'Stabilized',
  marketLiquidity: 'Primary',
};

const defaultNarrativeFacts: NarrativeFacts = {
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

const defaultLibrarySnapshot: LibrarySnapshot = {
  id: ('lib' + '0'.repeat(61)) as LibrarySnapshotId,
  asOf: AS_OF,
  approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
  byAssetType: emptyByAssetType(),
};

function buildDefaultAdjustedInputs(args: {
  readonly loanAmount: number;
  readonly dscr: number;
  readonly debtYield: number;
}): AdjustedInputs {
  return {
    id: ('ai' + '0'.repeat(62)) as AdjustedInputsId,
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: '1.2',
    librarySnapshotId: defaultLibrarySnapshot.id,
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
      upfrontCapex: lineItem(0), upfrontReplacementReserves: lineItem(0),
      upfrontTiLc: lineItem(0),
      monthlyCapex: lineItem(0), monthlyTiLc: lineItem(0),
      monthlyReplacementReserves: lineItem(0),
      monthlyTenantImprovements: lineItem(0), monthlyLeasingCommissions: lineItem(0),
      pcaImmediateRepairs: lineItem(0),
      capexScheduleInflated: null, capexScheduleUninflated: null,
    },
    loan: {
      loanAmount: lineItem(args.loanAmount), interestRate: lineItem(0),
      termMonths: lineItem(0), amortizationMonths: lineItem(0),
      ioPeriodMonths: lineItem(0), maturityBalance: lineItem(0),
      debtServiceAnnual: lineItem(0),
    },
    assumptions: {
      capRate: lineItem(0), terminalCapRate: lineItem(0),
      rentGrowthPct: lineItem(0), expenseGrowthPct: lineItem(0),
    },
    metrics: {
      noi: 0, value: 0, dscr: args.dscr, ltvAppraisal: 0, debtYield: args.debtYield,
      expenseRatio: 0, top1IncomeShare: 0, pctIncomeExpiringWithinTerm: 0,
    },
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: [],
  };
}

const defaultStressOutputs: StressOutputs = {
  id: ('so' + '0'.repeat(62)) as StressOutputsId,
  analysisAsOfDate: AS_OF,
  adjustedInputsId: ('ai' + '0'.repeat(62)) as AdjustedInputsId,
  stressEngineVersion: STRESS_ENGINE_VERSION,
  method: 'TENANT_REMOVAL',
  scenarios: [],
};

const defaultCrossCheckResult: CrossCheckResult = {
  id: ('cc' + '0'.repeat(62)) as CrossCheckResultId,
  analysisAsOfDate: AS_OF,
  adjustedInputsId: ('ai' + '0'.repeat(62)) as AdjustedInputsId,
  findings: [],
  overallAdjustmentBias: 'neutral',
};

const defaultValuationConclusion: ValuationConclusion = {
  id: ('vc' + '0'.repeat(62)) as ValuationConclusionId,
  analysisAsOfDate: AS_OF,
  valuationEngineVersion: VALUATION_ENGINE_VERSION,
  adjustedInputsId: ('ai' + '0'.repeat(62)) as AdjustedInputsId,
  stressOutputsId: defaultStressOutputs.id,
  narrativeFactsId: defaultNarrativeFacts.id,
  uwValue: null, marketValue: null, downsideValue: null, finalValue: null,
  appraisalValue: null, asrValue: null,
  capsApplied: [], haircutsApplied: [], valuationFlags: [],
  anchorUsed: 'none',
};

const defaultExtractionResult: ExtractionResult = {
  id: ('er' + '0'.repeat(62)) as ExtractionResultId,
  analysisAsOfDate: AS_OF,
  extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
  dealRef: 'SMOKE-E2E',
  rentRoll: null, t12: null, pca: null, appraisal: null,
  sellerUw: null, sellerUwOperatingStatement: null,
  asr: null, loanTerms: null,
  sourceDocuments: [],
  extractorVersions: {},
};

const defaultDoctrineEvaluation: DoctrineEvaluation = {
  id: ('de' + '0'.repeat(62)) as DoctrineEvaluationId,
  analysisAsOfDate: AS_OF,
  doctrineVersion: DOCTRINE_VERSION,
  judgmentEngineVersion: '1.2',
  stressEngineVersion: STRESS_ENGINE_VERSION,
  valuationEngineVersion: VALUATION_ENGINE_VERSION,
  adjustedInputsId: ('ai' + '0'.repeat(62)) as AdjustedInputsId,
  librarySnapshotId: defaultLibrarySnapshot.id,
  narrativeFactsId: defaultNarrativeFacts.id,
  crossCheckResultId: defaultCrossCheckResult.id,
  stressOutputsId: defaultStressOutputs.id,
  valuationConclusionId: defaultValuationConclusion.id,
  assetProfileId: defaultAssetProfile.id,
  extractionResultId: defaultExtractionResult.id,
  mechanicalScore: 0,
  componentScores: [],
  weightedAggregate: 0,
  assetTypeAdjustments: [],
  scoreAdjustments: [],
  finalScore: 0,
  ratingBand: 'High Risk',
  flags: [],
  reasons: [],
};

const defaultPropertyMetadata: PropertyMetadata = {
  id: ('pm' + '0'.repeat(62)) as PropertyMetadataId,
  source: 'asr_extraction',
  propertyName: null,
  propertySubtype: null,
  address: null, city: null, state: null, zip: null, county: null,
  msa: null, submarket: null,
  yearBuilt: null, yearRenovated: null,
  buildingClass: null,
  totalSquareFeet: null, totalUnits: null, totalRooms: null, totalPads: null,
  occupancyPhysical: null, occupancyEconomic: null,
  ownershipInterest: null, numberOfBuildings: null,
};

function makeSmokeInputs(overrides: {
  readonly loanAmount?: number;
  readonly dscr?: number;
  readonly debtYield?: number;
  readonly propertyType?: PropertyType;
  readonly narrativeFacts?: Partial<NarrativeFacts>;
  readonly stressOutputs?: Partial<StressOutputs>;
  readonly propertyMetadata?: Partial<PropertyMetadata> | null;
} = {}): AssemblerInputs {
  const adjustedInputs = buildDefaultAdjustedInputs({
    loanAmount: overrides.loanAmount ?? 10_000_000,
    dscr: overrides.dscr ?? 1.35,
    debtYield: overrides.debtYield ?? 0.10,
  });
  const assetProfile: AssetProfile = overrides.propertyType !== undefined
    ? { ...defaultAssetProfile, propertyType: overrides.propertyType }
    : defaultAssetProfile;
  const graph: HydratedRecordGraph = {
    doctrineEvaluation: defaultDoctrineEvaluation,
    valuationConclusion: defaultValuationConclusion,
    stressOutputs: { ...defaultStressOutputs, ...overrides.stressOutputs },
    crossCheckResult: defaultCrossCheckResult,
    adjustedInputs,
    narrativeFacts: { ...defaultNarrativeFacts, ...overrides.narrativeFacts },
    librarySnapshot: defaultLibrarySnapshot,
    assetProfile,
    extractionResult: defaultExtractionResult,
  };
  const propertyMetadata: PropertyMetadata | null =
    overrides.propertyMetadata === null
      ? null
      : overrides.propertyMetadata === undefined
      ? defaultPropertyMetadata
      : { ...defaultPropertyMetadata, ...overrides.propertyMetadata };
  return {
    graph,
    propertyMetadata,
    asOfDate: new Date('2026-01-01'),
  };
}

// =============================================================================
// Scenario A: Office deal with weak metrics
// =============================================================================

console.log('\n=== Scenario A: Office deal with weak metrics ===');

(() => {
  const inputs = makeSmokeInputs({
    loanAmount: 30_000_000,
    dscr: 1.20,
    debtYield: 0.085,
    propertyType: 'Office',
    stressOutputs: {
      method: 'TENANT_REMOVAL',
      scenarios: [
        makeStressScenario({ name: 'Remove T1', dscr: 1.10 }),
        makeStressScenario({ name: 'Remove T1+T2', dscr: 0.95 }),
        makeStressScenario({ name: 'Remove T1+T2+T3', dscr: 0.85 }), // < 1.0 should fire P-IV-OFF-6
      ],
    },
    propertyMetadata: {
      propertySubtype: 'Suburban Office',
      buildingClass: 'B',
      msa: 'Atlanta-Sandy Springs-Alpharetta, GA MSA',
      yearBuilt: 1996,
      yearRenovated: null,
    },
  });

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped`,
  );

  // P-IV-OFF-2: Class B office assets
  assertFlagFired(result, 'P-IV-OFF-2', 'P-IV-OFF-2 fires for Class B office');

  // P-IV-OFF-6: stressed DSCR < 1.0
  assertFlagFired(
    result,
    'P-IV-OFF-6',
    'P-IV-OFF-6 fires when stressed_dscr_top_3_removed < 1.0',
  );

  // Sanity: P-IV-ST-4 (single-tenant dark value) should not fire because
  // tenancy is multi-tenant
  assertFlagSkippedWith(
    result,
    'P-IV-ST-4',
    'trigger_inactive',
    'P-IV-ST-4 trigger inactive for multi-tenant deal',
  );
})();

// =============================================================================
// Scenario B: Single-tenant deal with blocked dark value
// =============================================================================

console.log('\n=== Scenario B: Single-tenant deal with blocked dark value ===');

(() => {
  const inputs = makeSmokeInputs({
    loanAmount: 15_000_000,
    dscr: 1.45,
    debtYield: 0.11,
    propertyType: 'Industrial',
    narrativeFacts: { isSingleTenant: true },
    stressOutputs: {
      method: 'DEFAULT', // fallback because single-tenant industrial lacks rent roll
      scenarios: [],
    },
    propertyMetadata: {
      propertySubtype: 'Distribution',
      buildingClass: null,
      msa: 'Dallas-Fort Worth-Arlington, TX MSA',
      yearBuilt: 2018,
      yearRenovated: null,
    },
  });

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped`,
  );

  // P-IV-ST-4 trigger requires both tenancy_type=Single-Tenant AND
  // appraised_dark_value to exist. Tenancy is Single-Tenant, but
  // appraised_dark_value is not populated → trigger fails.
  assertFlagSkippedWith(
    result,
    'P-IV-ST-4',
    'trigger_inactive',
    'P-IV-ST-4 trigger inactive when dark value missing',
  );

  // P-IV-ST-1 has no deterministic check (LLM_CONTEXT only) → not_deterministic
  assertFlagSkippedWith(
    result,
    'P-IV-ST-1',
    'not_deterministic',
    'P-IV-ST-1 (LLM_CONTEXT only) skips as not_deterministic',
  );

  // Top-3 removed DSCR was not produced (DEFAULT stress method),
  // so P-IV-OFF-6 should skip with missing_field. But P-IV-OFF-6 trigger
  // is field_equals(asset_type, 'Office'), and this deal is Industrial,
  // so it actually skips at trigger.
  assertFlagSkippedWith(
    result,
    'P-IV-OFF-6',
    'trigger_inactive',
    'P-IV-OFF-6 trigger inactive for non-Office deal',
  );
})();

// =============================================================================
// Scenario C: PropertyMetadata absent
// =============================================================================

console.log('\n=== Scenario C: PropertyMetadata absent ===');

(() => {
  const inputs = makeSmokeInputs({
    loanAmount: 5_000_000,
    dscr: 1.50,
    debtYield: 0.12,
    propertyType: 'SelfStorage',
    stressOutputs: {
      method: 'OCC_RENT_CONCESSION',
      scenarios: [makeStressScenario({ name: 'Occ_down_10', dscr: 1.30 })],
    },
    propertyMetadata: null, // ← critical: PropertyMetadata absent
  });

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped (PropertyMetadata=null)`,
  );

  // We can still evaluate principles that don't depend on metadata.
  // dscr is in the bag (from adjusted inputs), so trigger-based skips
  // tied to asset_type='SelfStorage' should evaluate fine.
  // P-IV-SS-4 checks dscr < 1.30 — our dscr is 1.50, so doesn't fire,
  // but it should skip with 'no_band_matched', not 'missing_field'.
  assertFlagSkippedWith(
    result,
    'P-IV-SS-4',
    'no_band_matched',
    'P-IV-SS-4: bag-populated dscr=1.50 does not fire (correct), confirms metadata absence does not break non-metadata principles',
  );
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
}
process.exit(failed > 0 ? 1 : 0);
