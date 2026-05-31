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

const sampleAssetProfile: AssetProfile = {
  id: 'ap1', propertyType: 'Office', businessPlan: 'Stabilized', marketLiquidity: 'Primary',
};

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});
