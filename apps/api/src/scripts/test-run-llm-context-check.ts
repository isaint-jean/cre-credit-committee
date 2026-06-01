/**
 * Phase 2 test — runLlmContextCheck with stub LLM.
 *
 *   npx tsx apps/api/src/scripts/test-run-llm-context-check.ts
 *
 * Covers:
 *   - cache miss → LLM call → fired=true → FiredFlag with LLM-provided
 *     severity/flag_message, principle metadata for principleId/injectionPoints,
 *     metricValue null, group/bandIndex 0.
 *   - cache miss → LLM call → fired=false → skip with reason 'no_band_matched'.
 *   - cache miss → malformed JSON twice → skip 'llm_eval_failed'.
 *   - cache miss → malformed once, valid second → fired flag (retry works).
 *   - cache write happens on success → second call hits cache → LLM NOT invoked.
 *   - cache write does NOT happen on llm_eval_failed → next call retries.
 *   - identical context across runs → identical contextHash → identical cache key.
 */

import type { AdjustedInputs, AssetProfile, NarrativeFacts, Principle, RentRoll, RentRollLine, StressOutputs } from '@cre/contracts';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { runLlmContextCheck } from '../services/handbook/run-llm-context-check.js';
import type { LlmContextCheckArgs } from '../services/handbook/run-llm-context-check.js';
import { computeRentRollId } from '../util/content-hash.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const samplePrinciple: Principle = {
  id: 'P-III-6',
  cluster: 'universal_framework',
  title: 'Evaluate leverage via DSCR + Debt Yield + LTV combination',
  principleText: 'Evaluate leverage using DSCR, Debt Yield, and LTV in combination',
  sourceCitation: 'Handbook §III, bullet 6',
  trigger: { kind: 'always' },
  executionModes: ['LLM_CONTEXT'],
  injectionPoints: ['executive_summary', 'committee_recommendation'],
  severity: 'high',
  researchActions: [],
  crossReferences: { relatedPrincipleIds: [], relatedReviewStepIds: [], upstreamDependencies: [], overlapsWith: [] },
};

function mkLineItem(adjusted: number) {
  return { raw: adjusted, adjusted, source: 'T12_ACTUAL' as const, adjustments: [] };
}

const sampleAdjustedInputs = {
  id: 'a'.repeat(64),
  analysisAsOfDate: '2026-05-31T00:00:00Z',
  judgmentEngineVersion: '1.0.0',
  librarySnapshotId: 'lib1',
  income: {
    grossRentalIncome: mkLineItem(1_200_000),
    vacancyPct: mkLineItem(0.10),
    concessionsPct: mkLineItem(0),
    otherIncome: mkLineItem(60_000),
    effectiveGrossIncome: mkLineItem(1_134_000),
  },
  expenses: {
    realEstateTaxes: mkLineItem(100_000),
    insurance: mkLineItem(18_000),
    utilities: mkLineItem(24_000),
    managementFee: mkLineItem(40_000),
    payroll: mkLineItem(0),
    maintenance: mkLineItem(36_000),
    other: mkLineItem(0),
    generalAndAdmin: mkLineItem(0),
    janitorial: mkLineItem(0),
    reimbursements: mkLineItem(0),
    totalOperatingExpenses: mkLineItem(340_200),
  },
  capitalReserves: {
    upfrontCapex: mkLineItem(0), upfrontReplacementReserves: mkLineItem(0),
    upfrontTiLc: mkLineItem(0), monthlyCapex: mkLineItem(0),
    monthlyTiLc: mkLineItem(0), monthlyReplacementReserves: mkLineItem(750),
    monthlyTenantImprovements: mkLineItem(0), monthlyLeasingCommissions: mkLineItem(0),
    pcaImmediateRepairs: mkLineItem(0),
    capexScheduleInflated: [], capexScheduleUninflated: [],
  },
  loan: {
    loanAmount: mkLineItem(11_000_000), interestRate: mkLineItem(0.07),
    termMonths: mkLineItem(59), amortizationMonths: mkLineItem(360),
    ioPeriodMonths: mkLineItem(0), maturityBalance: mkLineItem(10_367_000),
    maturityDate: null,
    debtServiceAnnual: mkLineItem(878_199),
  },
  assumptions: {
    capRate: mkLineItem(0.06), terminalCapRate: mkLineItem(0.065),
    concludedCapRate: null, rentGrowthPct: mkLineItem(0.03),
    expenseGrowthPct: mkLineItem(0.025),
  },
  metrics: {
    noi: 793_800, value: 13_230_000, dscr: 0.904, ltvAppraisal: 0.667,
    debtYield: 0.0722, expenseRatio: 0.30,
    top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
  },
  confidenceReduction: 0,
  topLevelAdjustments: [],
  dataQualityFlags: [],
} as unknown as AdjustedInputs;

const sampleStressOutputs = {
  id: 'so1', analysisAsOfDate: '2026-05-31T00:00:00Z',
  adjustedInputsId: 'a'.repeat(64), stressEngineVersion: '1.0.0',
  method: 'DEFAULT' as const, scenarios: [],
} as unknown as StressOutputs;

const sampleAssetProfile = {
  id: 'ap1', propertyType: 'Office', businessPlan: 'Stabilized', marketLiquidity: 'Primary',
} as unknown as AssetProfile;

const sampleNarrativeFacts = {
  id: 'nf1', analysisAsOfDate: '2026-05-31T00:00:00Z', isSingleTenant: null, hasInPlaceCashFlow: true,
} as unknown as NarrativeFacts;

function args(p: Principle = samplePrinciple): LlmContextCheckArgs {
  return {
    principle: p,
    adjustedInputs: sampleAdjustedInputs,
    stressOutputs: sampleStressOutputs,
    assetProfile: sampleAssetProfile,
    propertyMetadata: null,
    narrativeFacts: sampleNarrativeFacts,
    deterministicFiredFlags: [],
    handbookEngineVersion: '1.4.0',
  };
}

// Phase-2 defaults — every ComputedFacts must carry reserveSchedule + terminationOptions.
// Legacy refi-only tests below wrap their refinancingRisk values via withPhase2Defaults.
const PHASE2_DEFAULT_RESERVE_SCHEDULE = {
  source: 'adjusted_inputs.capitalReserves' as const,
  monthlyReplacementReserves: 0,
  monthlyCapex: 0,
  monthlyTiLc: 0,
  monthlyTenantImprovements: 0,
  monthlyLeasingCommissions: 0,
  upfrontReplacementReserves: 0,
  upfrontTiLc: 0,
  pcaImmediateRepairs: 0,
  capexScheduleInflated: null as ReadonlyArray<{ year: number; amount: number }> | null,
  totalMonthlyReservesDollars: 0 as number | null,
  totalUpfrontReservesDollars: 0 as number | null,
  anyMonthlyReservePopulated: false,
};
const PHASE2_DEFAULT_TERMINATION_OPTIONS = {
  source: 'rent_roll_footnotes' as const,
  extracted: false,
  options: null as ReadonlyArray<{ tenantName: string | null; description: string; effectiveDate: string | null; noticePeriodMonths: number | null }> | null,
  extractionGap: {
    kind: 'termination_option_extraction_gap' as const,
    detail: 'rent-roll footnote extraction not implemented (Phase 2 marker)',
    recommendedInputKind: 'termination_option_extraction_gap' as const,
  } as { kind: 'termination_option_extraction_gap'; detail: string; recommendedInputKind: 'termination_option_extraction_gap' } | null,
};
function withPhase2Defaults(refinancingRisk: import('../services/handbook/run-llm-context-check.js').ComputedFacts['refinancingRisk']) {
  return {
    refinancingRisk,
    reserveSchedule: PHASE2_DEFAULT_RESERVE_SCHEDULE,
    terminationOptions: PHASE2_DEFAULT_TERMINATION_OPTIONS,
  };
}

function makeStubLlm(responses: string[]) {
  let i = 0;
  let calls = 0;
  const promptsSent: string[] = [];
  const fn = async (opts: { model: string; max_tokens: number; messages: { role: string; content: string }[]; system?: string }): Promise<string> => {
    calls++;
    // Capture the user-message prompt for assertion access.
    const firstUser = opts.messages.find((m) => m.role === 'user');
    if (firstUser) promptsSent.push(firstUser.content);
    if (i >= responses.length) throw new Error('stub: no more responses');
    return responses[i++];
  };
  return { fn, calls: () => calls, prompts: (): readonly string[] => promptsSent };
}

// --- Rent-roll fixtures (Phase 2 — rent-roll-node) --------------------------

function makeRentRollLine(overrides: Partial<RentRollLine> & { tenantName: string; squareFeet: number | null; inPlaceRentAnnual: number | null }): RentRollLine {
  return {
    tenantName: overrides.tenantName,
    suite: overrides.suite ?? null,
    squareFeet: overrides.squareFeet,
    status: overrides.status ?? 'OCCUPIED',
    leaseStart: overrides.leaseStart ?? '2024-01-01T00:00:00Z',
    leaseEnd: overrides.leaseEnd ?? '2029-01-01T00:00:00Z',
    inPlaceRentAnnual: overrides.inPlaceRentAnnual,
    marketRentAnnual: overrides.marketRentAnnual ?? null,
    leaseType: overrides.leaseType ?? 'NNN',
    recoveriesAnnual: null, otherIncomeAnnual: null,
    newTiPsf: null, renewTiPsf: null, newLcPct: null, renewLcPct: null,
    downtimeMonths: null, notes: null,
  };
}

function makeRentRoll(lines: RentRollLine[], propertyName = 'Test Property'): RentRoll {
  const body = {
    asOfDate: '2026-05-31T00:00:00Z',
    propertyName,
    source: 'rent_roll_file' as const,
    lines,
  };
  return { id: computeRentRollId(body), ...body } as RentRoll;
}

function smallRentRoll(): RentRoll {
  return makeRentRoll([
    makeRentRollLine({ tenantName: 'Tenant A', squareFeet: 10_000, inPlaceRentAnnual: 360_000 }),
    makeRentRollLine({ tenantName: 'Tenant B', squareFeet: 20_000, inPlaceRentAnnual: 600_000 }),
  ]);
}

function twelveTenantRentRoll(): RentRoll {
  const lines: RentRollLine[] = [];
  // Top tenants by income: A($120k) is biggest, descending to L($10k).
  for (let i = 0; i < 12; i++) {
    const letter = String.fromCharCode('A'.charCodeAt(0) + i);
    lines.push(makeRentRollLine({
      tenantName: `Tenant ${letter}`,
      squareFeet: 1_000 + i * 100,
      inPlaceRentAnnual: (12 - i) * 10_000,
    }));
  }
  return makeRentRoll(lines, '12-Tenant Property');
}

(async () => {
  console.log('1. cache miss → LLM fired=true → FiredFlag');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ fired: true, severity: 'high', flag_message: 'DSCR 0.90 below 1.20 stress floor', evidenceQuotes: ['DSCR 0.904', 'debtServiceAnnual 878199'] }),
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'fired', '1.1 status === fired');
    if (result.status === 'fired') {
      assertEqual(result.flag.principleId, 'P-III-6', '1.2 principleId from metadata');
      assertEqual(result.flag.severity, 'high', '1.3 severity from LLM');
      assertEqual(result.flag.flag_message, 'DSCR 0.90 below 1.20 stress floor', '1.4 flag_message from LLM');
      assertEqual(result.flag.metricValue, null, '1.5 metricValue null for LLM principles');
      assertEqual(result.flag.groupIndex, 0, '1.6 groupIndex 0');
      assertEqual(result.flag.bandIndex, 0, '1.7 bandIndex 0');
      assertEqual([...result.flag.injectionPoints].join(','), 'executive_summary,committee_recommendation', '1.8 injectionPoints from metadata');
    }
    assertEqual(stub.calls(), 1, '1.9 LLM called exactly once');
    store.close();
  }

  console.log('\n2. cache miss → LLM fired=false → no_band_matched skip');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ fired: false, severity: 'high', flag_message: 'leverage profile within tolerance', evidenceQuotes: [] }),
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'skipped', '2.1 status === skipped');
    if (result.status === 'skipped') {
      assertEqual(result.skip.reason, 'no_band_matched', '2.2 reason === no_band_matched (clean negative)');
    }
  }

  console.log('\n3. malformed JSON twice → llm_eval_failed');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm(['this is not json', 'still not json']);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'skipped', '3.1 status === skipped');
    if (result.status === 'skipped') {
      assertEqual(result.skip.reason, 'llm_eval_failed', '3.2 reason === llm_eval_failed');
      assert(result.skip.detail !== undefined, '3.3 detail populated');
    }
    assertEqual(stub.calls(), 2, '3.4 LLM called twice (retry path)');
  }

  console.log('\n4. malformed once + valid second → fired (retry recovers)');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      'oops malformed',
      JSON.stringify({ fired: true, severity: 'critical', flag_message: 'second-attempt success', evidenceQuotes: ['x'] }),
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'fired', '4.1 retry recovered → status === fired');
    if (result.status === 'fired') {
      assertEqual(result.flag.severity, 'critical', '4.2 severity from second response');
    }
    assertEqual(stub.calls(), 2, '4.3 LLM called twice (first malformed, second OK)');
  }

  console.log('\n5. cache hit on second call → LLM NOT invoked');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ fired: true, severity: 'high', flag_message: 'first call result', evidenceQuotes: [] }),
    ]);
    const r1 = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(stub.calls(), 1, '5.1 first call invoked LLM');
    const r2 = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(stub.calls(), 1, '5.2 second call HIT CACHE (LLM not invoked again)');
    assertEqual(r1.status, 'fired', '5.3 first result fired');
    assertEqual(r2.status, 'fired', '5.4 second result fired');
    if (r1.status === 'fired' && r2.status === 'fired') {
      assertEqual(r2.flag.flag_message, r1.flag.flag_message, '5.5 cached message byte-identical');
      assertEqual(r2.flag.severity, r1.flag.severity, '5.6 cached severity identical');
    }
  }

  console.log('\n6. llm_eval_failed does NOT write cache → next call retries fresh');
  {
    const store = new RecordGraphStore(':memory:');
    const stub1 = makeStubLlm(['bad', 'bad']);
    await runLlmContextCheck(args(), store, { llmCall: stub1.fn as never });
    assertEqual(stub1.calls(), 2, '6.1 first attempt: 2 LLM calls (both bad)');

    const stub2 = makeStubLlm([JSON.stringify({ fired: false, severity: 'high', flag_message: 'ok', evidenceQuotes: [] })]);
    const r = await runLlmContextCheck(args(), store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 1, '6.2 follow-up attempt re-runs LLM (failure NOT cached)');
    assertEqual(r.status, 'skipped', '6.3 follow-up result valid');
  }

  console.log('\n7. different model_version → cache miss');
  {
    const store = new RecordGraphStore(':memory:');
    const stub1 = makeStubLlm([JSON.stringify({ fired: true, severity: 'high', flag_message: 'A', evidenceQuotes: [] })]);
    await runLlmContextCheck(args(), store, { llmCall: stub1.fn as never, modelVersion: 'claude-sonnet-4-20250514' });
    const stub2 = makeStubLlm([JSON.stringify({ fired: true, severity: 'critical', flag_message: 'B', evidenceQuotes: [] })]);
    const r = await runLlmContextCheck(args(), store, { llmCall: stub2.fn as never, modelVersion: 'claude-opus-5-2026-12-01' });
    assertEqual(stub2.calls(), 1, '7.1 different model_version → cache miss → LLM re-called');
    if (r.status === 'fired') assertEqual(r.flag.severity, 'critical', '7.2 new model produced new result');
  }

  console.log('\n8. new outcome: outcome=needs_manual_input → needs_manual_input skip + structured requests');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({
        outcome: 'needs_manual_input',
        flag_message: 'Cannot evaluate above-market rent exposure without per-tenant market PSF comps.',
        manualInputRequests: [
          { kind: 'market_rent_comp', detail: 'Per-tenant market PSF for above-market in-place tenants (T-1, T-2)' },
          { kind: 'submarket_vacancy', detail: 'Suburban San Diego office submarket vacancy rate (current)' },
        ],
      }),
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'skipped', '8.1 status === skipped');
    if (result.status === 'skipped') {
      assertEqual(result.skip.reason, 'needs_manual_input', '8.2 reason === needs_manual_input (NEW path)');
      assertEqual(result.skip.detail, 'Cannot evaluate above-market rent exposure without per-tenant market PSF comps.', '8.3 detail carries the prose');
      const reqs = result.skip.manualInputRequests ?? [];
      assertEqual(reqs.length, 2, '8.4 manualInputRequests count');
      assertEqual(reqs[0]?.kind, 'market_rent_comp', '8.5 first request kind');
      assertEqual(reqs[1]?.kind, 'submarket_vacancy', '8.6 second request kind');
      assert(reqs[0]?.detail.includes('Per-tenant market PSF'), '8.7 first request detail intact');
    }
    assertEqual(stub.calls(), 1, '8.8 LLM called once');
  }

  console.log('\n9. needs_manual_input requires non-empty manualInputRequests (parser strictness)');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'needs_manual_input', flag_message: 'missing info' }), // no requests array
      JSON.stringify({ outcome: 'needs_manual_input', flag_message: 'missing info', manualInputRequests: [] }), // empty
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    // Both attempts fail schema; final outcome should be llm_eval_failed.
    assertEqual(result.status, 'skipped', '9.1 status === skipped');
    if (result.status === 'skipped') {
      assertEqual(result.skip.reason, 'llm_eval_failed', '9.2 reason === llm_eval_failed (parser rejected both empty/missing requests)');
    }
  }

  console.log('\n10. legacy fired:boolean shape still parses (back-compat)');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ fired: true, severity: 'high', flag_message: 'legacy shape fire', evidenceQuotes: ['x'] }),
    ]);
    const result = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(result.status, 'fired', '10.1 legacy fired=true → fires');
    if (result.status === 'fired') {
      assertEqual(result.flag.flag_message, 'legacy shape fire', '10.2 legacy flag_message preserved');
    }
  }

  console.log('\n11b. manualInputs absent vs present → context hash differs (cache invariant)');
  {
    const store = new RecordGraphStore(':memory:');
    // First: no manualInputs — stub returns needs_manual_input
    const stub1 = makeStubLlm([
      JSON.stringify({
        outcome: 'needs_manual_input',
        flag_message: 'need comp',
        manualInputRequests: [{ kind: 'market_rent_comp', detail: 'per-tenant PSF' }],
      }),
    ]);
    const r1 = await runLlmContextCheck(args(), store, { llmCall: stub1.fn as never });
    assertEqual(r1.status, 'skipped', '11b.1 no-comp run → skipped');

    // Second: SAME deal + manualInputs provided → different context hash → cache miss → LLM re-called
    const argsWithComp = { ...args(), manualInputs: { marketRentComps: [{ tenantOrSpace: 'asset-wide', psf: 32, source: 'placeholder' }] } };
    const stub2 = makeStubLlm([
      JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'above-market exposure identified', evidenceQuotes: ['comp PSF $32'] }),
    ]);
    const r2 = await runLlmContextCheck(argsWithComp, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 1, '11b.2 manualInputs present → cache MISS → LLM called fresh');
    assertEqual(r2.status, 'fired', '11b.3 comp-fed run → fires (different bucket from no-comp)');

    // Third: identical args + same manualInputs as second → cache HIT
    const stub3 = makeStubLlm([]); // no stub responses available — proves cache hit
    const r3 = await runLlmContextCheck(argsWithComp, store, { llmCall: stub3.fn as never });
    assertEqual(stub3.calls(), 0, '11b.4 same manualInputs again → cache HIT (LLM not called)');
    assertEqual(r3.status, 'fired', '11b.5 cached result preserved');
    if (r2.status === 'fired' && r3.status === 'fired') {
      assertEqual(r3.flag.flag_message, r2.flag.flag_message, '11b.6 cached message byte-identical');
    }
  }

  console.log('\n11c. DIFFERENT manualInputs → different cache entry');
  {
    const store = new RecordGraphStore(':memory:');
    const argsCompA = { ...args(), manualInputs: { marketRentComps: [{ tenantOrSpace: 'asset-wide', psf: 28 }] } };
    const argsCompB = { ...args(), manualInputs: { marketRentComps: [{ tenantOrSpace: 'asset-wide', psf: 35 }] } };
    const stubA = makeStubLlm([JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'comp A result', evidenceQuotes: [] })]);
    const stubB = makeStubLlm([JSON.stringify({ outcome: 'not_fired', flag_message: 'comp B satisfied', evidenceQuotes: [] })]);
    const rA = await runLlmContextCheck(argsCompA, store, { llmCall: stubA.fn as never });
    const rB = await runLlmContextCheck(argsCompB, store, { llmCall: stubB.fn as never });
    assertEqual(stubA.calls(), 1, '11c.1 comp-A invoked LLM');
    assertEqual(stubB.calls(), 1, '11c.2 comp-B invoked LLM (different comp → cache miss)');
    assertEqual(rA.status === 'fired' && rA.flag.flag_message, 'comp A result', '11c.3 comp-A result preserved');
    assertEqual(rB.status, 'skipped', '11c.4 comp-B result differs');
  }

  console.log('\n11. needs_manual_input result IS cached (deterministic on replay)');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({
        outcome: 'needs_manual_input',
        flag_message: 'need comp',
        manualInputRequests: [{ kind: 'market_rent_comp', detail: 'per-tenant PSF' }],
      }),
    ]);
    const r1 = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(stub.calls(), 1, '11.1 first call invoked LLM');
    const r2 = await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    assertEqual(stub.calls(), 1, '11.2 second call HIT CACHE (LLM not invoked again)');
    if (r1.status === 'skipped' && r2.status === 'skipped') {
      assertEqual(r2.skip.reason, r1.skip.reason, '11.3 cached reason identical');
      assertEqual(r2.skip.manualInputRequests?.length, r1.skip.manualInputRequests?.length, '11.4 cached requests identical');
    }
  }

  // ===========================================================================
  // Phase 2 (rent-roll-node) — per-principle rent-roll context tests
  // ===========================================================================

  console.log('\n12. Phase 2 — per-tenant block appears in prompt when rentRoll present');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    const argsWithRR: LlmContextCheckArgs = { ...args(), rentRoll: smallRentRoll() };
    await runLlmContextCheck(argsWithRR, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('Per-tenant rent roll'), '12.1 prompt includes the per-tenant rent-roll header');
    assert(prompt.includes('Tenant A'), '12.2 prompt includes Tenant A name');
    assert(prompt.includes('Tenant B'), '12.3 prompt includes Tenant B name');
    assert(prompt.includes('"totalTenantCount":2'), '12.4 prompt includes totalTenantCount metadata');
    assert(prompt.includes('"otherAggregate":null'), '12.5 small roll has no otherAggregate');
  }

  console.log('\n13. Phase 2 — per-tenant block absent when rentRoll omitted');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(!prompt.includes('Per-tenant rent roll'), '13.1 prompt has no per-tenant rent-roll block when rentRoll absent');
  }

  console.log('\n14. Phase 2 — cache stability: same rentRoll bytes → same context hash → cache hit');
  {
    const store = new RecordGraphStore(':memory:');
    const argsRR: LlmContextCheckArgs = { ...args(), rentRoll: smallRentRoll() };
    const stub1 = makeStubLlm([
      JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'rent-roll baseline', evidenceQuotes: [] }),
    ]);
    const r1 = await runLlmContextCheck(argsRR, store, { llmCall: stub1.fn as never });
    assertEqual(stub1.calls(), 1, '14.1 first call invoked LLM');
    const stub2 = makeStubLlm([]); // no responses available — proves cache hit
    const r2 = await runLlmContextCheck(argsRR, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 0, '14.2 second call HIT CACHE (identical rentRoll bytes)');
    if (r1.status === 'fired' && r2.status === 'fired') {
      assertEqual(r2.flag.flag_message, r1.flag.flag_message, '14.3 cached message byte-identical');
    }
  }

  console.log('\n15. Phase 2 — cache invalidation: changed rentRoll → different hash → fresh eval');
  {
    const store = new RecordGraphStore(':memory:');
    const argsA: LlmContextCheckArgs = { ...args(), rentRoll: smallRentRoll() };
    const rollB = makeRentRoll([
      makeRentRollLine({ tenantName: 'Tenant A', squareFeet: 10_000, inPlaceRentAnnual: 360_000 }),
      // Tenant B rent dropped from 600k to 500k → different curated bytes.
      makeRentRollLine({ tenantName: 'Tenant B', squareFeet: 20_000, inPlaceRentAnnual: 500_000 }),
    ]);
    const argsB: LlmContextCheckArgs = { ...args(), rentRoll: rollB };
    const stubA = makeStubLlm([JSON.stringify({ outcome: 'not_fired', flag_message: 'A ok', evidenceQuotes: [] })]);
    const stubB = makeStubLlm([JSON.stringify({ outcome: 'fired', severity: 'medium', flag_message: 'B differs', evidenceQuotes: [] })]);
    await runLlmContextCheck(argsA, store, { llmCall: stubA.fn as never });
    const rB = await runLlmContextCheck(argsB, store, { llmCall: stubB.fn as never });
    assertEqual(stubA.calls(), 1, '15.1 first run invoked LLM');
    assertEqual(stubB.calls(), 1, '15.2 changed rentRoll → cache MISS → LLM re-invoked');
    if (rB.status === 'fired') assertEqual(rB.flag.flag_message, 'B differs', '15.3 new result reflects changed rent-roll');
  }

  console.log('\n16. Phase 2 — top-N + other aggregate: 12 tenants → 10 top + other.tenantCount=2');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    const argsWithRR: LlmContextCheckArgs = { ...args(), rentRoll: twelveTenantRentRoll() };
    await runLlmContextCheck(argsWithRR, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('"totalTenantCount":12'), '16.1 totalTenantCount reflects all 12 tenants');
    // Top-10 by income (descending): A=120k, B=110k, ..., J=30k. K(20k) and L(10k) are in "other".
    assert(prompt.includes('Tenant A'), '16.2 top-10 includes Tenant A (highest income)');
    assert(prompt.includes('Tenant J'), '16.3 top-10 includes Tenant J (10th)');
    assert(!prompt.includes('Tenant K'), '16.4 top-10 excludes Tenant K (11th by income)');
    assert(!prompt.includes('Tenant L'), '16.5 top-10 excludes Tenant L (12th by income)');
    assert(prompt.includes('"tenantCount":2'), '16.6 other aggregate counts the 2 remaining tenants');
    // Sum of K + L income = 20k + 10k = 30k; sum of SF = 2000 + 2100 = 4100
    assert(prompt.includes('"inPlaceRentAnnualTotal":30000'), '16.7 other aggregate sums income (20k+10k)');
    assert(prompt.includes('"squareFeetTotal":4100'), '16.8 other aggregate sums SF (2000+2100)');
  }

  console.log('\n17. Phase 2 — null fidelity: tenant with null SF has null inPlaceRentPsf in curated output');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    const rollNull = makeRentRoll([
      // Tenant with null SF and non-null rent → PSF must be null (no synthesis).
      makeRentRollLine({ tenantName: 'NullSF Tenant', squareFeet: null, inPlaceRentAnnual: 100_000 }),
      // Tenant with non-null SF and null rent → PSF must be null.
      makeRentRollLine({ tenantName: 'NullRent Tenant', squareFeet: 5_000, inPlaceRentAnnual: null }),
    ]);
    const argsWithRR: LlmContextCheckArgs = { ...args(), rentRoll: rollNull };
    await runLlmContextCheck(argsWithRR, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    // Canonicalized JSON preserves null fields. Both tenants must carry "inPlaceRentPsf":null.
    // The simple substring check is sufficient because no other field is named inPlaceRentPsf
    // and the only non-null path would emit a number, not "null".
    const matches = prompt.split('"inPlaceRentPsf":').slice(1);
    assertEqual(matches.length, 2, '17.1 two tenants → two inPlaceRentPsf fields in curated output');
    for (const m of matches) {
      assert(m.startsWith('null'), '17.2 inPlaceRentPsf is null when either SF or rent is null (no synthesis)');
    }
  }

  console.log('\n18. Phase 2 — omitted rentRoll: hash stable across two omit runs (cache hit on replay)');
  {
    const store = new RecordGraphStore(':memory:');
    const baseArgs = args();
    const stub1 = makeStubLlm([
      JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'no-roll baseline', evidenceQuotes: [] }),
    ]);
    await runLlmContextCheck(baseArgs, store, { llmCall: stub1.fn as never });
    assertEqual(stub1.calls(), 1, '18.1 first omit-run invoked LLM');
    const stub2 = makeStubLlm([]); // no responses available — cache hit proves identical hash
    const r2 = await runLlmContextCheck(baseArgs, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 0, '18.2 second omit-run HIT CACHE (null canonicalization stable)');
    assertEqual(r2.status, 'fired', '18.3 cached result preserved');
  }

  // ===========================================================================
  // Phase 1 (refi-window gate) — computedFacts per-principle context tests
  // ===========================================================================

  console.log('\n19. Phase 1 — computedFacts block appears in prompt when present (rollover_in_refi_window)');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'real rollover identified', evidenceQuotes: ['Tenant Early 2030'] }),
    ]);
    const argsWithFacts: LlmContextCheckArgs = {
      ...args(),
      computedFacts: withPhase2Defaults({
        refiWindowMonths: 12,
        termMonths: 60,
        maturityDate: '2031-05-31T00:00:00Z',
        maturityPlusWindowDate: '2032-05-31T00:00:00Z',
        aggregateRolloverFraction: 0.2,
        perTenantSchedule: [
          { tenantName: 'Early', suite: null, squareFeet: 1000, leaseEnd: '2030-01-01T00:00:00Z',
            expiresWithinRefiWindow: true, inPlaceRentAnnual: 200_000 },
          { tenantName: 'Late', suite: null, squareFeet: 4000, leaseEnd: '2040-01-01T00:00:00Z',
            expiresWithinRefiWindow: false, inPlaceRentAnnual: 800_000 },
        ],
        sourceDataComplete: true,
        verdict: 'rollover_in_refi_window',
      }),
    };
    await runLlmContextCheck(argsWithFacts, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('AUTHORITATIVE DERIVED FACTS'), '19.1 prompt includes the AUTHORITATIVE DERIVED FACTS header');
    assert(prompt.includes('refinancingRisk'), '19.2 prompt includes refinancingRisk key');
    assert(prompt.includes('rollover_in_refi_window'), '19.3 prompt includes the verdict literal');
    assert(prompt.includes('size to the actual aggregate fraction') || prompt.includes('size to the actual') ||
           prompt.includes('sized to the actual aggregate fraction'),
           '19.4 prompt includes size-to-actual fire-instruction line');
  }

  console.log('\n20. Phase 1 — computedFacts block absent when omitted');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    await runLlmContextCheck(args(), store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(!prompt.includes('AUTHORITATIVE DERIVED FACTS'), '20.1 no AUTHORITATIVE DERIVED FACTS header when omitted');
  }

  console.log('\n21. Phase 1 — verdict=no_rollover_in_refi_window prompt instructions');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'GSA runs to 2039 — well past maturity + 12mo; structural strength', evidenceQuotes: [] }),
    ]);
    const argsStrength: LlmContextCheckArgs = {
      ...args(),
      computedFacts: withPhase2Defaults({
        refiWindowMonths: 12,
        termMonths: 60,
        maturityDate: '2031-05-31T00:00:00Z',
        maturityPlusWindowDate: '2032-05-31T00:00:00Z',
        aggregateRolloverFraction: 0,
        perTenantSchedule: [
          { tenantName: 'GSA', suite: '100', squareFeet: 100_000, leaseEnd: '2039-01-01T00:00:00Z',
            expiresWithinRefiWindow: false, inPlaceRentAnnual: 5_000_000 },
        ],
        sourceDataComplete: true,
        verdict: 'no_rollover_in_refi_window',
      }),
    };
    const r = await runLlmContextCheck(argsStrength, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('no_rollover_in_refi_window'), '21.1 prompt cites the strength verdict');
    assert(prompt.includes('STRENGTH'), '21.2 prompt instructs strength-prose');
    assert(prompt.includes('not_fired'), '21.3 prompt instructs outcome=not_fired path');
    assertEqual(r.status, 'skipped', '21.4 LLM honored not_fired → status skipped');
  }

  console.log('\n22. Phase 1 — verdict=insufficient_data prompt instructions');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({
        outcome: 'needs_manual_input',
        flag_message: 'Per-tenant lease expirations are missing; cannot quantify refi-window rollover.',
        manualInputRequests: [
          { kind: 'lease_expiration', detail: 'Per-tenant lease end dates from the rent roll' },
        ],
      }),
    ]);
    const argsInsuff: LlmContextCheckArgs = {
      ...args(),
      computedFacts: withPhase2Defaults({
        refiWindowMonths: 12,
        termMonths: 60,
        maturityDate: '2031-05-31T00:00:00Z',
        maturityPlusWindowDate: '2032-05-31T00:00:00Z',
        aggregateRolloverFraction: null,
        perTenantSchedule: [
          { tenantName: 'A', suite: null, squareFeet: 1000, leaseEnd: null,
            expiresWithinRefiWindow: null, inPlaceRentAnnual: 100_000 },
        ],
        sourceDataComplete: false,
        verdict: 'insufficient_data',
      }),
    };
    const r = await runLlmContextCheck(argsInsuff, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('insufficient_data'), '22.1 prompt cites insufficient_data verdict');
    assert(prompt.includes('needs_manual_input'), '22.2 prompt instructs needs_manual_input path');
    assertEqual(r.status, 'skipped', '22.3 status === skipped');
    if (r.status === 'skipped') {
      assertEqual(r.skip.reason, 'needs_manual_input', '22.4 reason === needs_manual_input');
    }
  }

  console.log('\n23. Phase 1 — same computedFacts → same hash → cache hit');
  {
    const store = new RecordGraphStore(':memory:');
    const facts = withPhase2Defaults({
      refiWindowMonths: 12,
      termMonths: 60,
      maturityDate: '2031-05-31T00:00:00Z',
      maturityPlusWindowDate: '2032-05-31T00:00:00Z',
      aggregateRolloverFraction: 0,
      perTenantSchedule: [],
      sourceDataComplete: true,
      verdict: 'no_rollover_in_refi_window' as const,
    });
    const stub1 = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'strength', evidenceQuotes: [] }),
    ]);
    const r1 = await runLlmContextCheck({ ...args(), computedFacts: facts }, store, { llmCall: stub1.fn as never });
    assertEqual(stub1.calls(), 1, '23.1 first call invoked LLM');
    const stub2 = makeStubLlm([]); // none available proves cache hit
    const r2 = await runLlmContextCheck({ ...args(), computedFacts: facts }, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 0, '23.2 second call HIT CACHE (identical computedFacts bytes)');
    assertEqual(r1.status, r2.status, '23.3 cached status preserved');
  }

  console.log('\n24. Phase 1 — different refiWindowMonths → different hash → fresh eval');
  {
    const store = new RecordGraphStore(':memory:');
    const base = withPhase2Defaults({
      refiWindowMonths: 12,
      termMonths: 60,
      maturityDate: '2031-05-31T00:00:00Z',
      maturityPlusWindowDate: '2032-05-31T00:00:00Z',
      aggregateRolloverFraction: 0,
      perTenantSchedule: [],
      sourceDataComplete: true,
      verdict: 'no_rollover_in_refi_window' as const,
    });
    const wider = withPhase2Defaults({
      ...base.refinancingRisk,
      refiWindowMonths: 24, // different parameter
      maturityPlusWindowDate: '2033-05-31T00:00:00Z',
    });
    const stub1 = makeStubLlm([JSON.stringify({ outcome: 'not_fired', flag_message: 'window-12', evidenceQuotes: [] })]);
    const stub2 = makeStubLlm([JSON.stringify({ outcome: 'fired', severity: 'medium', flag_message: 'window-24 differs', evidenceQuotes: [] })]);
    await runLlmContextCheck({ ...args(), computedFacts: base }, store, { llmCall: stub1.fn as never });
    const r2 = await runLlmContextCheck({ ...args(), computedFacts: wider }, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 1, '24.1 different refiWindowMonths → cache MISS → LLM re-called');
    if (r2.status === 'fired') {
      assertEqual(r2.flag.flag_message, 'window-24 differs', '24.2 new result reflects changed window');
    }
  }

  console.log('\n25. Phase 1 — computedFacts absent vs present → different hash → fresh eval');
  {
    const store = new RecordGraphStore(':memory:');
    const stubA = makeStubLlm([JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'no-facts', evidenceQuotes: [] })]);
    await runLlmContextCheck(args(), store, { llmCall: stubA.fn as never });
    const argsWithFacts = {
      ...args(),
      computedFacts: withPhase2Defaults({
        refiWindowMonths: 12, termMonths: 60,
        maturityDate: '2031-05-31T00:00:00Z',
        maturityPlusWindowDate: '2032-05-31T00:00:00Z',
        aggregateRolloverFraction: 0,
        perTenantSchedule: [],
        sourceDataComplete: true,
        verdict: 'no_rollover_in_refi_window' as const,
      }),
    };
    const stubB = makeStubLlm([JSON.stringify({ outcome: 'not_fired', flag_message: 'with-facts', evidenceQuotes: [] })]);
    const r = await runLlmContextCheck(argsWithFacts, store, { llmCall: stubB.fn as never });
    assertEqual(stubB.calls(), 1, '25.1 adding computedFacts → cache MISS → LLM re-called');
    assertEqual(r.status, 'skipped', '25.2 new result distinct from no-facts run');
  }

  // ===========================================================================
  // Phase 2 (reserve-read + footnote-read) — extended computedFacts tests
  // ===========================================================================

  // Fixture builder shared across Phase 2 tests. Always emits a refinancingRisk
  // alongside the new fields so the full ComputedFacts shape is exercised.
  function phase2Facts(overrides: {
    reserveSchedule?: Partial<{
      monthlyReplacementReserves: number | null;
      monthlyCapex: number | null;
      monthlyTiLc: number | null;
      monthlyTenantImprovements: number | null;
      monthlyLeasingCommissions: number | null;
      upfrontReplacementReserves: number | null;
      upfrontTiLc: number | null;
      pcaImmediateRepairs: number | null;
      capexScheduleInflated: ReadonlyArray<{ year: number; amount: number }> | null;
      totalMonthlyReservesDollars: number | null;
      totalUpfrontReservesDollars: number | null;
      anyMonthlyReservePopulated: boolean;
    }>;
    terminationOptions?: Partial<{
      extracted: boolean;
      options: ReadonlyArray<{ tenantName: string | null; description: string; effectiveDate: string | null; noticePeriodMonths: number | null }> | null;
      extractionGap: { kind: 'termination_option_extraction_gap'; detail: string; recommendedInputKind: 'termination_option_extraction_gap' } | null;
    }>;
  } = {}) {
    const rs = {
      source: 'adjusted_inputs.capitalReserves' as const,
      monthlyReplacementReserves: 0,
      monthlyCapex: 0,
      monthlyTiLc: 0,
      monthlyTenantImprovements: 0,
      monthlyLeasingCommissions: 0,
      upfrontReplacementReserves: 0,
      upfrontTiLc: 0,
      pcaImmediateRepairs: 0,
      capexScheduleInflated: null,
      totalMonthlyReservesDollars: 0,
      totalUpfrontReservesDollars: 0,
      anyMonthlyReservePopulated: false,
      ...(overrides.reserveSchedule ?? {}),
    };
    const to = {
      source: 'rent_roll_footnotes' as const,
      extracted: false,
      options: null as ReadonlyArray<{ tenantName: string | null; description: string; effectiveDate: string | null; noticePeriodMonths: number | null }> | null,
      extractionGap: {
        kind: 'termination_option_extraction_gap' as const,
        detail: 'rent-roll footnote extraction not yet implemented',
        recommendedInputKind: 'termination_option_extraction_gap' as const,
      } as { kind: 'termination_option_extraction_gap'; detail: string; recommendedInputKind: 'termination_option_extraction_gap' } | null,
      ...(overrides.terminationOptions ?? {}),
    };
    return {
      refinancingRisk: {
        refiWindowMonths: 12,
        termMonths: 60,
        maturityDate: '2031-05-31T00:00:00Z' as const,
        maturityPlusWindowDate: '2032-05-31T00:00:00Z' as const,
        aggregateRolloverFraction: 0,
        perTenantSchedule: [],
        sourceDataComplete: true,
        verdict: 'no_rollover_in_refi_window' as const,
      },
      reserveSchedule: rs,
      terminationOptions: to,
    };
  }

  console.log('\n26. Phase 2 — reserveSchedule appears in prompt with all 9 fields');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({ outcome: 'not_fired', flag_message: 'ok', evidenceQuotes: [] }),
    ]);
    const argsRS: LlmContextCheckArgs = {
      ...args(),
      computedFacts: phase2Facts({
        reserveSchedule: {
          monthlyReplacementReserves: 0,
          monthlyCapex: 250,
          monthlyTiLc: 500,
          monthlyTenantImprovements: 300,
          monthlyLeasingCommissions: 200,
          upfrontReplacementReserves: 50_000,
          upfrontTiLc: 100_000,
          pcaImmediateRepairs: 25_000,
          capexScheduleInflated: [{ year: 1, amount: 5_000 }, { year: 2, amount: 7_500 }],
          totalMonthlyReservesDollars: 1_250,
          totalUpfrontReservesDollars: 175_000,
          anyMonthlyReservePopulated: true,
        },
      }),
    };
    await runLlmContextCheck(argsRS, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('"reserveSchedule"'), '26.1 prompt includes reserveSchedule key');
    assert(prompt.includes('"monthlyReplacementReserves":0'), '26.2 monthlyReplacementReserves present (=0)');
    assert(prompt.includes('"monthlyCapex":250'), '26.3 monthlyCapex present');
    assert(prompt.includes('"monthlyTiLc":500'), '26.4 monthlyTiLc present');
    assert(prompt.includes('"monthlyTenantImprovements":300'), '26.5 monthlyTenantImprovements present');
    assert(prompt.includes('"monthlyLeasingCommissions":200'), '26.6 monthlyLeasingCommissions present');
    assert(prompt.includes('"upfrontReplacementReserves":50000'), '26.7 upfrontReplacementReserves present');
    assert(prompt.includes('"upfrontTiLc":100000'), '26.8 upfrontTiLc present');
    assert(prompt.includes('"pcaImmediateRepairs":25000'), '26.9 pcaImmediateRepairs present');
    assert(prompt.includes('"capexScheduleInflated":'), '26.10 capexScheduleInflated present');
    assert(prompt.includes('"totalMonthlyReservesDollars":1250'), '26.11 totalMonthlyReservesDollars roll-up present');
    assert(prompt.includes('"totalUpfrontReservesDollars":175000'), '26.12 totalUpfrontReservesDollars roll-up present');
    assert(prompt.includes('"anyMonthlyReservePopulated":true'), '26.13 anyMonthlyReservePopulated roll-up present');
    assert(prompt.includes('For reserveSchedule specifically'), '26.14 prompt carries reserveSchedule instruction prose');
    assert(prompt.includes('"source":"adjusted_inputs.capitalReserves"'), '26.15 source tag identifies adjusted-inputs origin');
  }

  console.log('\n27. Phase 2 — reserveSchedule folds into context hash (cache stability)');
  {
    const store = new RecordGraphStore(':memory:');
    const facts = phase2Facts({
      reserveSchedule: {
        monthlyReplacementReserves: 750,
        monthlyCapex: 100,
        totalMonthlyReservesDollars: 850,
        anyMonthlyReservePopulated: true,
      },
    });
    const stub1 = makeStubLlm([
      JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'baseline-reserves', evidenceQuotes: [] }),
    ]);
    const r1 = await runLlmContextCheck({ ...args(), computedFacts: facts }, store, { llmCall: stub1.fn as never });
    assertEqual(stub1.calls(), 1, '27.1 first call invoked LLM');
    const stub2 = makeStubLlm([]); // proves cache hit
    const r2 = await runLlmContextCheck({ ...args(), computedFacts: facts }, store, { llmCall: stub2.fn as never });
    assertEqual(stub2.calls(), 0, '27.2 second call HIT CACHE (identical reserveSchedule bytes)');
    assertEqual(r1.status, r2.status, '27.3 cached status preserved');
  }

  console.log('\n28. Phase 2 — different reserveSchedule (single field flip) → different hash → fresh eval');
  {
    const store = new RecordGraphStore(':memory:');
    const factsA = phase2Facts({
      reserveSchedule: {
        monthlyReplacementReserves: 0,
        monthlyTiLc: null,
        totalMonthlyReservesDollars: 0,
        anyMonthlyReservePopulated: false,
      },
    });
    // Same shape, but monthlyTiLc flips from null → 500.
    const factsB = phase2Facts({
      reserveSchedule: {
        monthlyReplacementReserves: 0,
        monthlyTiLc: 500,
        totalMonthlyReservesDollars: 500,
        anyMonthlyReservePopulated: true,
      },
    });
    const stubA = makeStubLlm([JSON.stringify({ outcome: 'fired', severity: 'high', flag_message: 'tilc-null', evidenceQuotes: [] })]);
    const stubB = makeStubLlm([JSON.stringify({ outcome: 'not_fired', flag_message: 'tilc-populated', evidenceQuotes: [] })]);
    await runLlmContextCheck({ ...args(), computedFacts: factsA }, store, { llmCall: stubA.fn as never });
    const rB = await runLlmContextCheck({ ...args(), computedFacts: factsB }, store, { llmCall: stubB.fn as never });
    assertEqual(stubB.calls(), 1, '28.1 single-field flip → cache MISS → LLM re-invoked');
    if (rB.status === 'skipped') {
      assertEqual(rB.skip.reason, 'no_band_matched', '28.2 new result reflects the populated TI/LC field');
    }
  }

  console.log('\n29. Phase 2 — terminationOptions appears with extracted=false + extractionGap marker');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({
        outcome: 'needs_manual_input',
        flag_message: 'Termination options not extractable from current pipeline.',
        manualInputRequests: [
          { kind: 'termination_option_extraction_gap', detail: 'rent-roll footnotes not parsed' },
        ],
      }),
    ]);
    const argsTO: LlmContextCheckArgs = {
      ...args(),
      computedFacts: phase2Facts(),
    };
    const r = await runLlmContextCheck(argsTO, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    assert(prompt.includes('"terminationOptions"'), '29.1 prompt includes terminationOptions key');
    assert(prompt.includes('"extracted":false'), '29.2 extracted=false visible');
    assert(prompt.includes('"options":null'), '29.3 options is null (no data)');
    assert(prompt.includes('"kind":"termination_option_extraction_gap"'), '29.4 extractionGap.kind visible');
    assert(prompt.includes('"source":"rent_roll_footnotes"'), '29.5 source identifies footnote origin');
    assert(prompt.includes('For terminationOptions specifically'), '29.6 prompt carries terminationOptions instruction prose');
    assertEqual(r.status, 'skipped', '29.7 LLM honored needs_manual_input path');
    if (r.status === 'skipped') {
      assertEqual(r.skip.reason, 'needs_manual_input', '29.8 skip reason === needs_manual_input');
      assertEqual(r.skip.manualInputRequests?.[0]?.kind, 'termination_option_extraction_gap', '29.9 returned kind matches recommendedInputKind');
    }
  }

  console.log('\n30. Phase 2 — P-III-3-style fixture: $0 replacement reserves but populated TI/LC → both visible in prompt');
  {
    const store = new RecordGraphStore(':memory:');
    const stub = makeStubLlm([
      JSON.stringify({
        outcome: 'not_fired',
        flag_message: 'Replacement reserves $0 but monthly TI/LC of $500 and capex schedule populated cover reserve concern.',
        evidenceQuotes: ['monthlyReplacementReserves $0', 'monthlyTiLc $500', 'capexScheduleInflated 2 years'],
      }),
    ]);
    const argsP3: LlmContextCheckArgs = {
      ...args(),
      computedFacts: phase2Facts({
        reserveSchedule: {
          monthlyReplacementReserves: 0,
          monthlyCapex: 100,
          monthlyTiLc: 500,
          monthlyTenantImprovements: 300,
          monthlyLeasingCommissions: 200,
          upfrontReplacementReserves: 0,
          upfrontTiLc: 75_000,
          pcaImmediateRepairs: 0,
          capexScheduleInflated: [{ year: 1, amount: 3_000 }, { year: 2, amount: 4_500 }],
          totalMonthlyReservesDollars: 1_100,
          totalUpfrontReservesDollars: 75_000,
          anyMonthlyReservePopulated: true,
        },
      }),
    };
    const r = await runLlmContextCheck(argsP3, store, { llmCall: stub.fn as never });
    const prompt = stub.prompts()[0] ?? '';
    // Prompt must show BOTH the $0 replacement-reserves AND the populated TI/LC.
    assert(prompt.includes('"monthlyReplacementReserves":0'), '30.1 prompt shows the $0 replacement-reserves field');
    assert(prompt.includes('"monthlyTiLc":500'), '30.2 prompt shows the populated TI/LC field');
    assert(prompt.includes('"anyMonthlyReservePopulated":true'), '30.3 roll-up confirms "deal is reserved"');
    assertEqual(r.status, 'skipped', '30.4 LLM stub returned not_fired → status skipped');
    if (r.status === 'skipped') {
      assertEqual(r.skip.reason, 'no_band_matched', '30.5 skip reason === no_band_matched (clean negative; stub used populated TI/LC)');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
