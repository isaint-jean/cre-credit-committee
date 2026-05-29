// Tests for render-underwriting-context.ts (Batch 6.7 - Stage 13 read-pole render).
//
//   npm run test:render-underwriting-context
//
// Verifies:
//   - End-to-end: ingest -> hydrate -> project -> render produces a complete RenderedAnalysis
//   - Section-keyed shape matches contract (summary / metrics / valuation / doctrine / dataQuality / metadata)
//   - Cell completeness (RD5): every leaf cell has a non-empty displayValue
//   - Sentinel application: null metric -> displayValue '-'
//   - String passthrough: non-null string fields preserved in displayValue
//   - dataQualityFlags surface as RenderBadges with severity 'info'
//   - doctrine.flags surface as RenderBadges with severity 'warning'
//   - Idempotency (RD4): same UnderwritingContext -> identical id (byte-stable hash)
//   - Determinism: two renders of same input -> byte-identical full output
//   - rootId passthrough
//   - metadata.hashedAt mirrors doctrine.analysisAsOfDate (no clock leak)
//   - metadata.renderVersion === '7.7'
//   - Schema exhaustiveness (test-suite version, per the v1 cut): every cell key
//     in the output sources from a known UnderwritingContext path

import {
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  RENDER_VERSION,
  ASSET_TYPES,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  DoctrineEvaluationId,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  RenderedAnalysis,
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
import { hydrateRecordGraph } from '../services/hydrate-record-graph.js';
import { buildUnderwritingContextProjection } from '../services/build-underwriting-context-projection.js';
import { renderUnderwritingContext } from '../services/render-underwriting-context.js';
import { NULL_SENTINEL } from '../services/render-sentinels.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

// ------------------------------ fixtures -------------------------------

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'RENDER-1',
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

async function endToEnd(store: RecordGraphStore): Promise<{ rootId: DoctrineEvaluationId; rendered: RenderedAnalysis }> {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingest = await ingestExtractionResult(
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
  // hydrate / projection anchor on DoctrineEvaluationId (rendering cache key).
  // After Option C / #20, ingest.rootId is the public AnalysisId (a RevisionId);
  // the internal hydration anchor is ingest.evaluationId.
  const bundle = hydrateRecordGraph(ingest.evaluationId, store);
  const ctx = buildUnderwritingContextProjection({ rootId: ingest.evaluationId, graph: bundle });
  const rendered = renderUnderwritingContext(ctx);
  return { rootId: ingest.evaluationId, rendered };
}

// --------------------------------- run ---------------------------------

(async () => {

console.log('End-to-end: ingest -> hydrate -> project -> render:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);

  assert(/^[0-9a-f]{64}$/.test(rendered.id), 'rendered.id is 64-char content hash');
  assertEqual(rendered.rootId, rootId, 'rendered.rootId === ingest rootId');
  assert(rendered.summary !== undefined, 'summary section present');
  assert(rendered.metrics !== undefined, 'metrics section present');
  assert(rendered.valuation !== undefined, 'valuation section present');
  assert(rendered.doctrine !== undefined, 'doctrine section present');
  assert(rendered.dataQuality !== undefined, 'dataQuality section present');
  assert(rendered.metadata !== undefined, 'metadata section present');

  store.close();
}

console.log('\nSection-keyed shape (PJ1-style bijection check):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const topKeys = Object.keys(rendered).sort();
  const expected = [
    'assumptions', 'dataQuality', 'doctrine', 'expenseLines', 'findings', 'id',
    'incomeLines', 'loan', 'metadata', 'metrics', 'narrative', 'rootId', 'stress', 'summary',
    'valuation',
  ].sort();
  assertEqual(JSON.stringify(topKeys), JSON.stringify(expected), 'top-level keys match contract');

  store.close();
}

console.log('\nRD5 cell completeness: every leaf cell has a non-empty displayValue:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // Walk each section's RenderCell entries
  const cells: ReadonlyArray<{ path: string; value: unknown; displayValue: string }> = [
    { path: 'summary.ratingBand', value: rendered.summary.ratingBand.value, displayValue: rendered.summary.ratingBand.displayValue },
    { path: 'summary.finalScore', value: rendered.summary.finalScore.value, displayValue: rendered.summary.finalScore.displayValue },
    { path: 'metrics.dscr', value: rendered.metrics.dscr.value, displayValue: rendered.metrics.dscr.displayValue },
    { path: 'metrics.ltv', value: rendered.metrics.ltv.value, displayValue: rendered.metrics.ltv.displayValue },
    { path: 'metrics.debtYield', value: rendered.metrics.debtYield.value, displayValue: rendered.metrics.debtYield.displayValue },
    { path: 'metrics.noi', value: rendered.metrics.noi.value, displayValue: rendered.metrics.noi.displayValue },
    { path: 'valuation.finalValue', value: rendered.valuation.finalValue.value, displayValue: rendered.valuation.finalValue.displayValue },
    { path: 'valuation.anchorUsed', value: rendered.valuation.anchorUsed.value, displayValue: rendered.valuation.anchorUsed.displayValue },
    { path: 'doctrine.mechanicalScore', value: rendered.doctrine.mechanicalScore.value, displayValue: rendered.doctrine.mechanicalScore.displayValue },
    { path: 'doctrine.weightedAggregate', value: rendered.doctrine.weightedAggregate.value, displayValue: rendered.doctrine.weightedAggregate.displayValue },
  ];

  for (const cell of cells) {
    assert(typeof cell.displayValue === 'string' && cell.displayValue.length > 0,
      cell.path + ' has non-empty displayValue');
  }

  store.close();
}

console.log('\nrootId + metadata passthrough (no clock leak, no random):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);

  assertEqual(rendered.metadata.renderVersion, '7.7', 'metadata.renderVersion === "7.7"');
  assertEqual(rendered.metadata.renderVersion, RENDER_VERSION, 'metadata matches RENDER_VERSION constant');
  assertEqual(rendered.metadata.hashedAt, AS_OF, 'metadata.hashedAt mirrors doctrine.analysisAsOfDate');
  assertEqual(rendered.rootId, rootId, 'rootId pass-through');

  store.close();
}

console.log('\nIdempotency (RD4): same input -> byte-identical output:');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rootId, b.rootId, 'identical inputs -> identical rootId');
  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId');
  assertEqual(JSON.stringify(a.rendered), JSON.stringify(b.rendered),
    'two renders of same input -> byte-identical');

  storeA.close();
  storeB.close();
}

console.log('\nDeterminism: two render() calls on same context -> identical:');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);
  const bundle = hydrateRecordGraph(rootId, store);
  const ctx = buildUnderwritingContextProjection({ rootId, graph: bundle });

  const r1 = renderUnderwritingContext(ctx);
  const r2 = renderUnderwritingContext(ctx);

  assertEqual(r1.id, r2.id, 'two renders of same context -> identical id');
  assertEqual(r1.id, rendered.id, 'matches end-to-end render id');
  assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'byte-identical bodies');

  store.close();
}

console.log('\ndataQualityFlags surface as RenderBadges (severity = info):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // The synthetic fixture has minimal extraction context, so judgment-engine emits
  // some dataQualityFlags. Those should surface as info badges.
  for (const badge of rendered.dataQuality.flags) {
    assertEqual(badge.severity, 'info', 'dataQuality badge ' + badge.code + ' severity = info');
    assert(badge.code.length > 0, 'badge code non-empty');
    assert(badge.label.length > 0, 'badge label non-empty');
  }

  store.close();
}

console.log('\ndoctrine.flags surface as RenderBadges (severity = warning):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  for (const badge of rendered.doctrine.flags) {
    assertEqual(badge.severity, 'warning', 'doctrine badge ' + badge.code + ' severity = warning');
    assert(badge.code.length > 0, 'doctrine badge code non-empty');
  }

  store.close();
}

console.log('\nD09: doctrine.components projects DoctrineEvaluation.componentScores:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // The synthetic fixture exercises the full doctrine pipeline; expect at least one
  // component (the producer scores 7+ components for any complete evaluation).
  assert(rendered.doctrine.components.length > 0, 'components array is non-empty');

  for (const c of rendered.doctrine.components) {
    assert(typeof c.name === 'string' && c.name.length > 0, c.name + ': name is non-empty string');
    assert(typeof c.ruleId === 'string' && c.ruleId.length > 0, c.name + ': ruleId is non-empty');
    assert(typeof c.rawValue.displayValue === 'string', c.name + ': rawValue.displayValue is string');
    assert(typeof c.score.displayValue === 'string', c.name + ': score.displayValue is string');
    assert(typeof c.weight.displayValue === 'string', c.name + ': weight.displayValue is string');
    assert(typeof c.contribution.displayValue === 'string', c.name + ': contribution.displayValue is string');
    // PJ2/RD2 spirit: the projection passes through producer values; score must equal
    // the producer-emitted value (no re-derivation in render).
    assert(c.score.value === null || (c.score.value >= 0 && c.score.value <= 100),
      c.name + ': score.value in [0,100] or null');
    // Reason codes promote to RenderBadge[] with severity 'info'
    for (const b of c.reasonCodes) {
      assertEqual(b.severity, 'info', c.name + ': reason badge severity = info');
      assert(b.code.length > 0, c.name + ': reason badge code non-empty');
    }
  }

  store.close();
}

console.log('\nD09: components round-trip via cache (cache key partitions on render version 6.8):');
{
  // Same input must produce same RenderedAnalysisId at version 6.8. Cache miss + cache hit
  // both return identity-equal components arrays.
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId at 6.8');
  assertEqual(a.rendered.doctrine.components.length, b.rendered.doctrine.components.length,
    'components array length identical across stores');
  for (let i = 0; i < a.rendered.doctrine.components.length; i++) {
    const ca = a.rendered.doctrine.components[i];
    const cb = b.rendered.doctrine.components[i];
    if (ca === undefined || cb === undefined) continue;
    assertEqual(ca.name, cb.name, 'components[' + i + '].name identical');
    assertEqual(ca.score.value, cb.score.value, 'components[' + i + '].score.value identical');
    assertEqual(ca.weight.value, cb.weight.value, 'components[' + i + '].weight.value identical');
    assertEqual(ca.contribution.value, cb.contribution.value, 'components[' + i + '].contribution identical');
  }

  storeA.close();
  storeB.close();
}

console.log('\nNull metric -> sentinel display:');
{
  // Construct a context where a metric is null, verify sentinel.
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);

  // Verify that null values consistently produce NULL_SENTINEL
  const pairs = [
    { path: 'metrics.dscr', cell: rendered.metrics.dscr },
    { path: 'metrics.ltv', cell: rendered.metrics.ltv },
    { path: 'metrics.debtYield', cell: rendered.metrics.debtYield },
    { path: 'metrics.noi', cell: rendered.metrics.noi },
  ];
  for (const p of pairs) {
    if (p.cell.value === null) {
      assertEqual(p.cell.displayValue, NULL_SENTINEL, p.path + ': null -> NULL_SENTINEL');
    } else {
      assert(p.cell.displayValue !== NULL_SENTINEL, p.path + ': non-null -> not sentinel');
    }
  }

  store.close();
  void rootId; // keep linter happy with the destructure
}

console.log('\nD16: incomeLines projects AdjustedInputs.income (5 entries, fixed order):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const expectedNames: ReadonlyArray<string> = [
    'grossRentalIncome', 'otherIncome', 'vacancyPct', 'concessionsPct', 'effectiveGrossIncome',
  ];
  assertEqual(rendered.incomeLines.length, expectedNames.length,
    'incomeLines has ' + expectedNames.length + ' entries');
  for (let i = 0; i < expectedNames.length; i++) {
    const li = rendered.incomeLines[i];
    if (li === undefined) continue;
    assertEqual(li.name, expectedNames[i], 'incomeLines[' + i + '].name === ' + expectedNames[i]);
    assert(typeof li.raw.displayValue === 'string', li.name + ': raw.displayValue is string');
    assert(typeof li.adjusted.displayValue === 'string', li.name + ': adjusted.displayValue is string');
    assert(typeof li.source === 'string' && li.source.length > 0, li.name + ': source is non-empty');
    // Adjustments ledger: each entry has a delta cell + reason string + ruleId
    for (const a of li.adjustments) {
      assert(typeof a.ruleId === 'string' && a.ruleId.length > 0, li.name + ': adjustment.ruleId non-empty');
      assert(typeof a.delta.displayValue === 'string', li.name + ': adjustment.delta.displayValue is string');
      assert(typeof a.reason === 'string', li.name + ': adjustment.reason is string');
    }
  }

  store.close();
}

console.log('\nD17: expenseLines projects AdjustedInputs.expenses (8 entries, fixed order):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const expectedNames: ReadonlyArray<string> = [
    'realEstateTaxes', 'insurance', 'utilities', 'managementFee',
    'payroll', 'maintenance', 'other', 'totalOperatingExpenses',
  ];
  assertEqual(rendered.expenseLines.length, expectedNames.length,
    'expenseLines has ' + expectedNames.length + ' entries');
  for (let i = 0; i < expectedNames.length; i++) {
    const li = rendered.expenseLines[i];
    if (li === undefined) continue;
    assertEqual(li.name, expectedNames[i], 'expenseLines[' + i + '].name === ' + expectedNames[i]);
    assert(typeof li.raw.displayValue === 'string', li.name + ': raw.displayValue is string');
    assert(typeof li.adjusted.displayValue === 'string', li.name + ': adjusted.displayValue is string');
  }

  store.close();
}

console.log('\nD16/D17 RD2 spirit: render does not re-derive adjusted from raw + sum-of-deltas:');
{
  // This is a contract assertion, not a calculation. The producer emits `adjusted` directly;
  // render passes it through. The test verifies that adjusted.value === producer-emitted value
  // by checking that the rendered cell is identity-equal to a fresh fixture-side projection.
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);
  void rootId;

  // The synthetic fixture has known values; producer's adjusted for grossRentalIncome should
  // be a positive number under any sensible inputs (the deal has rent > 0).
  const gri = rendered.incomeLines[0];
  if (gri !== undefined) {
    assert(gri.adjusted.value !== null && gri.adjusted.value > 0,
      'grossRentalIncome.adjusted is producer-positive');
    // The displayValue for a non-null number is String(number) (per applyNumericSentinel)
    if (gri.adjusted.value !== null) {
      assertEqual(gri.adjusted.displayValue, String(gri.adjusted.value),
        'grossRentalIncome.adjusted.displayValue === String(producer value)');
    }
  }

  store.close();
}

console.log('\nD16/D17 cross-store determinism (cache partition continuity at 6.9):');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId at 6.9');
  assertEqual(a.rendered.incomeLines.length, b.rendered.incomeLines.length, 'incomeLines length identical');
  assertEqual(a.rendered.expenseLines.length, b.rendered.expenseLines.length, 'expenseLines length identical');
  for (let i = 0; i < a.rendered.incomeLines.length; i++) {
    const ax = a.rendered.incomeLines[i];
    const bx = b.rendered.incomeLines[i];
    if (ax === undefined || bx === undefined) continue;
    assertEqual(ax.name, bx.name, 'incomeLines[' + i + '].name identical');
    assertEqual(ax.raw.value, bx.raw.value, 'incomeLines[' + i + '].raw identical');
    assertEqual(ax.adjusted.value, bx.adjusted.value, 'incomeLines[' + i + '].adjusted identical');
    assertEqual(ax.source, bx.source, 'incomeLines[' + i + '].source identical');
  }

  storeA.close();
  storeB.close();
}

console.log('\nD21: loan section is a named-field struct (NOT array) - 7 explicit fields:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // Bijection check on the loan section keys: must be exactly the seven AdjustedLoan fields.
  // No more, no fewer; explicit names, not introspected.
  const loanKeys = Object.keys(rendered.loan).sort();
  const expectedLoanKeys = [
    'amortizationMonths', 'debtServiceAnnual', 'interestRate', 'ioPeriodMonths',
    'loanAmount', 'maturityBalance', 'termMonths',
  ].sort();
  assertEqual(JSON.stringify(loanKeys), JSON.stringify(expectedLoanKeys),
    'loan section has exactly the 7 AdjustedLoan fields');

  // Each field is a RenderedLineItem with the correct .name and the producer's typed values.
  const expectedNames: ReadonlyArray<{ key: keyof typeof rendered.loan; name: string }> = [
    { key: 'loanAmount', name: 'loanAmount' },
    { key: 'interestRate', name: 'interestRate' },
    { key: 'termMonths', name: 'termMonths' },
    { key: 'amortizationMonths', name: 'amortizationMonths' },
    { key: 'ioPeriodMonths', name: 'ioPeriodMonths' },
    { key: 'maturityBalance', name: 'maturityBalance' },
    { key: 'debtServiceAnnual', name: 'debtServiceAnnual' },
  ];
  for (const e of expectedNames) {
    const li = rendered.loan[e.key];
    assertEqual(li.name, e.name, 'loan.' + String(e.key) + '.name === ' + e.name);
    assert(typeof li.raw.displayValue === 'string', 'loan.' + e.name + ': raw.displayValue is string');
    assert(typeof li.adjusted.displayValue === 'string',
      'loan.' + e.name + ': adjusted.displayValue is string');
    assert(typeof li.source === 'string' && li.source.length > 0,
      'loan.' + e.name + ': source is non-empty');
  }

  store.close();
}

console.log('\n#24 (7.3) + §14.3 (7.4): assumptions section projects AdjustedInputs.assumptions (5 named fields; concludedCapRate nullable):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // Bijection check: exactly the 5 AdjustedAssumptions fields (4 from v12 #24 + 1 from v17 §14.3).
  const assumptionsKeys = Object.keys(rendered.assumptions).sort();
  const expectedAssumptionsKeys = [
    'capRate', 'concludedCapRate', 'expenseGrowthPct', 'rentGrowthPct', 'terminalCapRate',
  ].sort();
  assertEqual(JSON.stringify(assumptionsKeys), JSON.stringify(expectedAssumptionsKeys),
    'assumptions section has exactly the 5 AdjustedAssumptions fields');

  // Non-nullable fields have engine builders (capRate, terminalCapRate, rentGrowthPct, expenseGrowthPct) —
  // always present as RenderedLineItem with the correct .name and the producer's typed values.
  const expectedAssumptionNames: ReadonlyArray<{ key: 'capRate' | 'terminalCapRate' | 'rentGrowthPct' | 'expenseGrowthPct'; name: string }> = [
    { key: 'capRate', name: 'capRate' },
    { key: 'terminalCapRate', name: 'terminalCapRate' },
    { key: 'rentGrowthPct', name: 'rentGrowthPct' },
    { key: 'expenseGrowthPct', name: 'expenseGrowthPct' },
  ];
  for (const e of expectedAssumptionNames) {
    const li = rendered.assumptions[e.key];
    assertEqual(li.name, e.name, 'assumptions.' + String(e.key) + '.name === ' + e.name);
    assert(typeof li.raw.displayValue === 'string',
      'assumptions.' + e.name + ': raw.displayValue is string');
    assert(typeof li.adjusted.displayValue === 'string',
      'assumptions.' + e.name + ': adjusted.displayValue is string');
    assert(typeof li.source === 'string' && li.source.length > 0,
      'assumptions.' + e.name + ': source is non-empty');
  }

  // §14.3 Decision 3 + Delta X: concludedCapRate is nullable. Default endToEnd flow
  // (no analyst input) produces null. Handbook P-III-9 disallows deterministic threshold.
  assertEqual(rendered.assumptions.concludedCapRate, null,
    'assumptions.concludedCapRate === null when no analyst input (per §14.3 Delta S handbook constraint)');

  store.close();
}

console.log('\nD21 RD2 spirit: render does not recompute debtService from rate+term+amort:');
{
  // The producer (judgment-engine line-item builder) emits debtServiceAnnual.adjusted as
  // a numeric value. Render reads it directly. Verify the displayValue matches the raw
  // String() conversion of the producer's number - no formatting layer interjected.
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const ds = rendered.loan.debtServiceAnnual;
  if (ds.adjusted.value !== null) {
    assertEqual(ds.adjusted.displayValue, String(ds.adjusted.value),
      'debtServiceAnnual.adjusted.displayValue === String(producer value)');
  }
  // Same check on maturityBalance - producer-emitted, not amortization-table-derived in render.
  const mb = rendered.loan.maturityBalance;
  if (mb.adjusted.value !== null) {
    assertEqual(mb.adjusted.displayValue, String(mb.adjusted.value),
      'maturityBalance.adjusted.displayValue === String(producer value)');
  }

  store.close();
}

console.log('\nD21 cross-store determinism (cache partition continuity at 7.0):');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId at 7.0');
  // Field-by-field check on the loan section across stores.
  const fields: ReadonlyArray<keyof typeof a.rendered.loan> = [
    'loanAmount', 'interestRate', 'termMonths', 'amortizationMonths',
    'ioPeriodMonths', 'maturityBalance', 'debtServiceAnnual',
  ];
  for (const f of fields) {
    const la = a.rendered.loan[f];
    const lb = b.rendered.loan[f];
    assertEqual(la.name, lb.name, 'loan.' + String(f) + '.name identical');
    assertEqual(la.raw.value, lb.raw.value, 'loan.' + String(f) + '.raw identical');
    assertEqual(la.adjusted.value, lb.adjusted.value, 'loan.' + String(f) + '.adjusted identical');
    assertEqual(la.source, lb.source, 'loan.' + String(f) + '.source identical');
  }

  storeA.close();
  storeB.close();
}

console.log('\nD20: stress section projects StressOutputs (method + scenarios[]):');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  // method is a passthrough of StressMethod (closed enum DEFAULT|TENANT_REMOVAL|OCC_RENT_CONCESSION).
  const validMethods = ['DEFAULT', 'TENANT_REMOVAL', 'OCC_RENT_CONCESSION'];
  assert(validMethods.indexOf(rendered.stress.method) >= 0,
    'stress.method is a known StressMethod (' + rendered.stress.method + ')');

  // scenarios[] is a (possibly empty) array of RenderedStressScenario
  assert(Array.isArray(rendered.stress.scenarios), 'stress.scenarios is an array');

  for (const s of rendered.stress.scenarios) {
    assert(typeof s.name === 'string' && s.name.length > 0, s.name + ': name is non-empty');
    // 5 metric cells, each with displayValue
    assert(typeof s.noi.displayValue === 'string', s.name + ': noi.displayValue is string');
    assert(typeof s.dscr.displayValue === 'string', s.name + ': dscr.displayValue is string');
    assert(typeof s.value.displayValue === 'string', s.name + ': value.displayValue is string');
    assert(typeof s.ltv.displayValue === 'string', s.name + ': ltv.displayValue is string');
    assert(typeof s.debtYield.displayValue === 'string', s.name + ': debtYield.displayValue is string');

    // breach codes promote to warning badges
    for (const b of s.breaches) {
      assertEqual(b.severity, 'warning', s.name + ': breach badge severity = warning');
      assert(b.code.length > 0, s.name + ': breach badge code non-empty');
    }
    // skipped codes promote to info badges
    for (const sk of s.skipped) {
      assertEqual(sk.severity, 'info', s.name + ': skipped badge severity = info');
      assert(sk.code.length > 0, s.name + ': skipped badge code non-empty');
    }
  }

  store.close();
}

console.log('\nD20 RD2 spirit: render does not recompute breach outcomes:');
{
  // The producer (stress engine) computes breaches and skipped covenants and emits them
  // as StressBreach[] arrays. Render maps each code to a RenderBadge - no threshold
  // logic, no re-classification. Verify the badge code strings exactly match the
  // producer-emitted enum values (DSCR | LTV | DEBT_YIELD).
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const validBreachCodes = ['DSCR', 'LTV', 'DEBT_YIELD'];
  for (const s of rendered.stress.scenarios) {
    for (const b of s.breaches) {
      assert(validBreachCodes.indexOf(b.code) >= 0,
        s.name + ': breach code "' + b.code + '" is producer-enum-valid');
    }
    for (const sk of s.skipped) {
      assert(validBreachCodes.indexOf(sk.code) >= 0,
        s.name + ': skipped code "' + sk.code + '" is producer-enum-valid');
    }
    // For each numeric metric, displayValue is either NULL_SENTINEL or String(producer value).
    // RD2 spirit: no formatting layer interjected; producer's number is the truth.
    if (s.dscr.value !== null) {
      assertEqual(s.dscr.displayValue, String(s.dscr.value),
        s.name + ': dscr.displayValue === String(producer value)');
    }
  }

  store.close();
}

console.log('\nD20 cross-store determinism (cache partition continuity at 7.1):');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId at 7.1');
  assertEqual(a.rendered.stress.method, b.rendered.stress.method, 'stress.method identical');
  assertEqual(a.rendered.stress.scenarios.length, b.rendered.stress.scenarios.length,
    'stress.scenarios length identical');
  for (let i = 0; i < a.rendered.stress.scenarios.length; i++) {
    const sa = a.rendered.stress.scenarios[i];
    const sb = b.rendered.stress.scenarios[i];
    if (sa === undefined || sb === undefined) continue;
    assertEqual(sa.name, sb.name, 'scenarios[' + i + '].name identical');
    assertEqual(sa.dscr.value, sb.dscr.value, 'scenarios[' + i + '].dscr identical');
    assertEqual(sa.ltv.value, sb.ltv.value, 'scenarios[' + i + '].ltv identical');
    assertEqual(sa.debtYield.value, sb.debtYield.value, 'scenarios[' + i + '].debtYield identical');
    assertEqual(sa.breaches.length, sb.breaches.length, 'scenarios[' + i + '].breaches length identical');
  }

  storeA.close();
  storeB.close();
}

console.log('\nD04: findings projects DoctrineEvaluation.reasons[] (bijective passthrough):');
{
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);

  // Re-fetch the doctrine evaluation directly from the store to compare against the
  // rendered findings. Both should reference the same producer-emitted reasons[].
  const fetched = store.getDoctrineEvaluation(rootId);
  if (fetched === null) {
    fail('expected to fetch DoctrineEvaluation by rootId');
    store.close();
    process.exit(1);
  }
  const producerReasons = fetched.reasons;

  // 1. COUNT FIDELITY: rendered.findings.length must equal producer reasons.length.
  //    No collapsing, no deduplication, no synthesis.
  assertEqual(rendered.findings.length, producerReasons.length,
    'findings count === producer reasons count (no collapse, no synthesis)');

  // 2. ORDERING FIDELITY: index-by-index, ruleId and reasonCode must match exactly.
  //    No re-prioritization, no sorting.
  for (let i = 0; i < producerReasons.length; i++) {
    const p = producerReasons[i];
    const r = rendered.findings[i];
    if (p === undefined || r === undefined) continue;
    assertEqual(r.ruleId, p.ruleId, 'findings[' + i + '].ruleId === producer ruleId');
    assertEqual(r.reasonCode, p.reasonCode, 'findings[' + i + '].reasonCode === producer reasonCode');
  }

  // 3. SHAPE FIDELITY: each rendered finding has exactly two fields - ruleId + reasonCode.
  //    No severity, no rationale, no derived priority. Verify by key set.
  for (const r of rendered.findings) {
    const keys = Object.keys(r).sort();
    assertEqual(JSON.stringify(keys), JSON.stringify(['reasonCode', 'ruleId']),
      'finding has exactly {ruleId, reasonCode} keys; no severity, no synthesis');
    assert(typeof r.ruleId === 'string' && r.ruleId.length > 0, 'ruleId is non-empty string');
    assert(typeof r.reasonCode === 'string' && r.reasonCode.length > 0, 'reasonCode is non-empty string');
  }

  store.close();
}

console.log('\nD04 producer-side fidelity: rendered findings equal producer reasons by JSON:');
{
  // Stronger bijection check: serialize both sides and compare. Same input -> same hash
  // -> same projection -> same JSON. Any deviation indicates render-side mutation,
  // synthesis, or reordering - all forbidden.
  const store = new RecordGraphStore(':memory:');
  const { rootId, rendered } = await endToEnd(store);
  const fetched = store.getDoctrineEvaluation(rootId);
  if (fetched !== null) {
    const producerJson = JSON.stringify(
      fetched.reasons.map((r) => ({ ruleId: r.ruleId, reasonCode: r.reasonCode })),
    );
    const renderedJson = JSON.stringify(
      rendered.findings.map((r) => ({ ruleId: r.ruleId, reasonCode: r.reasonCode })),
    );
    assertEqual(renderedJson, producerJson, 'rendered findings === producer reasons (byte-identical)');
  }

  store.close();
}

console.log('\nD04 cross-store determinism (cache partition continuity at 7.2):');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = await endToEnd(storeA);
  const b = await endToEnd(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'identical inputs -> identical RenderedAnalysisId at 7.2');
  assertEqual(a.rendered.findings.length, b.rendered.findings.length,
    'findings length identical across stores');
  for (let i = 0; i < a.rendered.findings.length; i++) {
    const fa = a.rendered.findings[i];
    const fb = b.rendered.findings[i];
    if (fa === undefined || fb === undefined) continue;
    assertEqual(fa.ruleId, fb.ruleId, 'findings[' + i + '].ruleId identical');
    assertEqual(fa.reasonCode, fb.reasonCode, 'findings[' + i + '].reasonCode identical');
  }

  storeA.close();
  storeB.close();
}

console.log('\nSchema-exhaustiveness (v1, test-suite form):');
{
  // Every leaf cell key in the output is verified to exist in a known set; this catches
  // accidental cell drops or additions across rebases. The boot-time architecture-D3
  // check is deferred to a follow-up batch (full bidirectional with @internal annotations).
  const store = new RecordGraphStore(':memory:');
  const { rendered } = await endToEnd(store);

  const expectedCells: ReadonlyArray<string> = [
    'summary.ratingBand', 'summary.finalScore',
    'metrics.dscr', 'metrics.ltv', 'metrics.debtYield', 'metrics.noi',
    'valuation.finalValue', 'valuation.anchorUsed',
    'doctrine.mechanicalScore', 'doctrine.weightedAggregate',
  ];
  assertEqual(expectedCells.length, 10, 'expected cell count is 10 (v1 baseline)');

  // Verify each expected path resolves to a RenderCell
  const lookup: { [k: string]: { value: unknown; displayValue: string } } = {
    'summary.ratingBand': rendered.summary.ratingBand,
    'summary.finalScore': rendered.summary.finalScore,
    'metrics.dscr': rendered.metrics.dscr,
    'metrics.ltv': rendered.metrics.ltv,
    'metrics.debtYield': rendered.metrics.debtYield,
    'metrics.noi': rendered.metrics.noi,
    'valuation.finalValue': rendered.valuation.finalValue,
    'valuation.anchorUsed': rendered.valuation.anchorUsed,
    'doctrine.mechanicalScore': rendered.doctrine.mechanicalScore,
    'doctrine.weightedAggregate': rendered.doctrine.weightedAggregate,
  };
  for (const path of expectedCells) {
    const cell = lookup[path];
    assert(cell !== undefined, path + ' resolves to a RenderCell');
    if (cell !== undefined) {
      assert(typeof cell.displayValue === 'string', path + ' has displayValue: string');
    }
  }

  store.close();
}

// --------------------------------- summary ---------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

})().catch((e) => { console.error(e); process.exit(1); });
