/**
 * Integration test — read-through projection from legacy Analysis to
 * new-spine graph substrate.
 *
 *   npx tsx apps/api/src/scripts/test-project-legacy-from-graph.ts
 *
 * Covers two projected slots end-to-end:
 *   - executiveSummary ← NarrativeEvaluation.executiveSummary
 *   - creditScore      ← DoctrineEvaluation.{finalScore, ratingBand, componentScores}
 *
 * Properties verified:
 *   1. Null-link case: graphRevisionId absent → input returned unchanged.
 *   2. Legacy fields preserved when link absent.
 *   3. Missing-envelope case: graphRevisionId set but envelope not found
 *      → both fallbacks fire (executiveSummary + creditScore left as legacy).
 *   4. Happy path: projection overrides both slots from graph substrate.
 *   5. Numbers from projection match what the new-spine view would show
 *      (componentScores bijection + finalScore + ratingBand).
 *   6. Other fields (id, name, status, mitigations, findings) untouched.
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
  RevisionId,
} from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import {
  computeContentHash,
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

const AS_OF = '2026-05-30T00:00:00Z';
const STUB_EXEC = 'PHASE-3-STUB: real handbook narrative projected end-to-end.';

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
    dealRef: 'PHASE-3-TEST',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
      ],
      summary: { totalUnits: 1, occupiedUnits: 1, economicOccupancy: 1.0 },
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
    pca: null, appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: null, sellerUwOperatingStatement: null, asr: null,
    loanTerms: { loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
                 interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
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

const stubLlm: LLMCallFn = async ({ messages }) => {
  const content = messages[0]?.content;
  const text = typeof content === 'string' ? content : '';
  if (text.includes('committee recommendation')) return 'committee stub';
  if (text.includes('mitigation-suggestions list')) return '- [P] mitigation stub';
  if (text.includes('red-flag assessment')) return '- [P] red flag stub';
  return STUB_EXEC;
};

function makeLegacyAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    id: 'test-analysis-uuid',
    name: 'Phase 3 test',
    assetType: 'office',
    status: 'complete',
    progress: 100,
    currentStep: '',
    createdAt: AS_OF,
    updatedAt: AS_OF,
    document: null,
    uwDocument: null,
    supportingDocuments: [],
    templateDocument: null,
    findings: [],
    creditScore: null,
    uwModel: null,
    research: null,
    crossCheckFindings: [],
    mitigations: [],
    executiveSummary: null,
    bPieceDecision: null,
    comments: [],
    criteriaEvaluations: [],
    stressScenarios: [],
    ...overrides,
  };
}

(async () => {
  const store = new RecordGraphStore(':memory:');
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
    { llmCall: stubLlm },
  );

  console.log('1. null-link → input unchanged');
  {
    const input = makeLegacyAnalysis({ graphRevisionId: null, executiveSummary: null });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, null, '1.1 executiveSummary stays null when link absent');
    assertEqual(out, input, '1.2 same reference returned (no work performed)');
  }

  console.log('\n2. legacy prose preserved when link absent');
  {
    const legacyProse = 'Legacy LLM prose from generateExecutiveSummary.';
    const input = makeLegacyAnalysis({ graphRevisionId: null, executiveSummary: legacyProse });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, legacyProse, '2.1 legacy executiveSummary preserved');
  }

  console.log('\n3. missing-envelope → BOTH slots fall back to legacy values');
  {
    const bogusLink = '0'.repeat(64) as RevisionId;
    const legacyScore: import('@cre/shared').CreditScore = {
      overall: 72,
      categories: [],
      recommendation: 'approve',
      narrative: 'legacy narrative',
      riskTier: 'acceptable',
      whyThisScore: 'legacy why',
      howToImprove: 'legacy how',
    };
    const input = makeLegacyAnalysis({
      graphRevisionId: bogusLink,
      executiveSummary: 'legacy fallback',
      creditScore: legacyScore,
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, 'legacy fallback', '3.1 missing envelope → executiveSummary fallback preserved');
    assertEqual(out.creditScore, legacyScore, '3.2 missing envelope → creditScore fallback preserved (same reference)');
  }

  console.log('\n4. happy path — both slots projected from graph');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: 'this should be overridden',
      creditScore: null,
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, STUB_EXEC, '4.1 executiveSummary projected from NarrativeEvaluation');
    assert(out.executiveSummary !== input.executiveSummary, '4.2 executiveSummary actually changed');
    assert(out.creditScore !== null, '4.3 creditScore projected (non-null)');
  }

  console.log('\n5. numbers projected match new-spine source (DE → CreditScore bijection)');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
      creditScore: null,
    });
    const out = projectLegacyAnalysisFromGraph(input, store);

    const envelope = store.getRevisionEnvelope(ingest.rootId);
    assert(envelope !== null, '5.0 envelope resolvable (precondition)');
    const doctrine = store.getDoctrineEvaluation(envelope!.doctrineEvaluationId);
    assert(doctrine !== null, '5.0b doctrine resolvable (precondition)');

    const cs = out.creditScore!;
    assertEqual(cs.overall, Math.round(doctrine!.finalScore), '5.1 overall = round(finalScore)');
    assertEqual(cs.categories.length, doctrine!.componentScores.length, '5.2 category count matches componentScores count');

    for (let i = 0; i < doctrine!.componentScores.length; i++) {
      const src = doctrine!.componentScores[i];
      const dst = cs.categories[i];
      assertEqual(dst.score, src.score, `5.3.${i} category[${i}].score === componentScore[${i}].score`);
      assertEqual(dst.weight, src.weight, `5.4.${i} category[${i}].weight === componentScore[${i}].weight`);
      assertEqual(dst.weightedScore, src.contribution, `5.5.${i} category[${i}].weightedScore === componentScore[${i}].contribution`);
      assertEqual(dst.maxScore, 100, `5.6.${i} category[${i}].maxScore === 100`);
      assertEqual(dst.category as unknown as string, src.componentId, `5.7.${i} category[${i}].category === componentScore[${i}].componentId`);
    }

    const expectedRiskTier =
      doctrine!.ratingBand === 'Strong'     ? 'strong'     :
      doctrine!.ratingBand === 'Acceptable' ? 'acceptable' :
      doctrine!.ratingBand === 'Weak'       ? 'watchlist'  :
                                              'high_risk';
    assertEqual(cs.riskTier, expectedRiskTier, '5.8 riskTier = ratingBandToRiskTier(ratingBand)');

    assertEqual(cs.recommendation, 'further_review', '5.9 recommendation = further_review (no DE source)');
    assertEqual(cs.narrative, '', '5.10 narrative = "" (no DE source)');
    assertEqual(cs.whyThisScore, '', '5.11 whyThisScore = "" (no DE source)');
    assertEqual(cs.howToImprove, '', '5.12 howToImprove = "" (no DE source)');
    for (let i = 0; i < cs.categories.length; i++) {
      assertEqual(cs.categories[i].findings.length, 0, `5.13.${i} categories[${i}].findings = [] (no DE source)`);
      assertEqual(cs.categories[i].explanation, '', `5.14.${i} categories[${i}].explanation = "" (no DE source)`);
    }

    assertEqual(out.executiveSummary, STUB_EXEC, '5.15 executiveSummary also projected in same call');
  }

  console.log('\n6. other fields untouched');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
      creditScore: null,
      name: 'Original name',
      findings: [],
      mitigations: [],
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.id, input.id, '6.1 id preserved');
    assertEqual(out.name, input.name, '6.2 name preserved');
    assertEqual(out.status, input.status, '6.3 status preserved');
    assertEqual(out.mitigations.length, 0, '6.4 mitigations preserved (future projection target)');
    assertEqual(out.findings.length, 0, '6.5 findings preserved');
  }

  console.log('\n7. uwModel synthesis — projected onto promoted record (Phase 2 wiring)');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
      creditScore: null,
      // uwModel: null (default from makeLegacyAnalysis — promote-from-graph
      // initial state). Projector should synthesize one from the graph.
    });
    assertEqual(input.uwModel, null, '7.0 precondition: input.uwModel null (promoted record)');
    const out = projectLegacyAnalysisFromGraph(input, store);
    assert(out.uwModel !== null, '7.1 uwModel populated by synthesis');
    if (out.uwModel !== null) {
      // Pull AI for ground-truth comparison.
      const envelope = store.getRevisionEnvelope(ingest.rootId);
      const ai = envelope ? store.getAdjustedInputs(envelope.adjustedInputsId) : null;
      assert(ai !== null, '7.1a precondition: AdjustedInputs resolvable');
      assertClose(out.uwModel.netOperatingIncome, ai!.metrics.noi ?? 0, '7.2 NOI === AI.metrics.noi (graph canonical)', 1.0);
      assertClose(out.uwModel.dscr ?? 0, ai!.metrics.dscr ?? 0, '7.3 DSCR === AI.metrics.dscr', 0.001);
      assertClose(out.uwModel.debtYield ?? 0, ai!.metrics.debtYield ?? 0, '7.4 debt yield === AI.metrics.debtYield', 0.0001);
      assertClose(out.uwModel.capRate, ai!.assumptions.capRate.adjusted, '7.5 capRate direct from AI');
      // Both LTVs present and distinct
      assert(out.uwModel.ltv !== null, '7.6a underwritten LTV (loan/impliedValue) present');
      assert(out.uwModel.ltvAppraised != null, '7.6b appraised LTV present');
      assertClose(out.uwModel.ltvAppraised!, ai!.metrics.ltvAppraisal ?? 0, '7.6c appraised LTV === AI.metrics.ltvAppraisal');
      // Income / expenses populated
      assert(out.uwModel.income.grossPotentialRent.annualAmount > 0, '7.7 income.grossPotentialRent populated');
      assert(out.uwModel.expenses.totalExpenses.annualAmount > 0, '7.8 expenses.totalExpenses populated');
      // Non-editable invariant
      assertEqual(out.uwModel.income.grossPotentialRent.isEditable, false, '7.9 synthesized line items non-editable');
      assertEqual(out.uwModel.income.grossPotentialRent.isOverridden, false, '7.10 synthesized line items not overridden');
      // Repayment schedule generated
      assert(out.uwModel.repaymentSchedule !== null, '7.11 repaymentSchedule generated');
    }
  }

  console.log('\n8. uwModel synthesis — preserves existing legacy uwModel (no overwrite)');
  {
    // When a legacy analyst-edited uwModel is already populated, the projector
    // must NOT replace it with a synthesized model.
    const sentinelUw = {
      ...({} as never),
    };
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
      creditScore: null,
      uwModel: sentinelUw as never,
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.uwModel as unknown as object, sentinelUw, '8.1 existing legacy uwModel preserved (synthesis only fires when uwModel is null)');
  }

  console.log('\n9. uwModel synthesis — null when graph chain unresolvable (legacy uwModel kept null)');
  {
    const bogusLink = '1'.repeat(64) as RevisionId;
    const input = makeLegacyAnalysis({ graphRevisionId: bogusLink });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.uwModel, null, '9.1 unresolvable graph + null legacy → uwModel stays null');
  }

  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});

void computeContentHash; // suppress unused
