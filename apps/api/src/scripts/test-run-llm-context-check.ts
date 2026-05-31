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

import type { AdjustedInputs, AssetProfile, NarrativeFacts, Principle, StressOutputs } from '@cre/contracts';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { runLlmContextCheck } from '../services/handbook/run-llm-context-check.js';
import type { LlmContextCheckArgs } from '../services/handbook/run-llm-context-check.js';

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
    handbookEngineVersion: '1.1.0',
  };
}

function makeStubLlm(responses: string[]) {
  let i = 0;
  let calls = 0;
  const fn = async (_opts: { model: string; max_tokens: number; messages: { role: string; content: string }[]; system?: string }): Promise<string> => {
    calls++;
    if (i >= responses.length) throw new Error('stub: no more responses');
    return responses[i++];
  };
  return { fn, calls: () => calls };
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
