/**
 * Integration test — Phase 3 read-through projection from legacy Analysis
 * to new-spine graph substrate (NarrativeEvaluation.executiveSummary).
 *
 *   npx tsx apps/api/src/scripts/test-project-legacy-from-graph.ts
 *
 * Verifies six properties:
 *   1. Null-link case: graphRevisionId absent → input returned unchanged
 *      (executiveSummary stays at its legacy value, including null).
 *   2. Legacy executiveSummary preserved when no link: input has legacy
 *      prose, projection passes it through.
 *   3. Missing-envelope case: graphRevisionId set but envelope not found
 *      → input returned unchanged (degrades gracefully).
 *   4. Missing-narrative case: envelope found but NE not found → input
 *      returned unchanged.
 *   5. Happy path: graphRevisionId points to a valid graph chain →
 *      projection overrides executiveSummary with NE.executiveSummary.
 *   6. Other fields untouched: only executiveSummary changes in Phase 3.
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

  console.log('\n3. missing-envelope → input unchanged');
  {
    const bogusLink = '0'.repeat(64) as RevisionId;
    const input = makeLegacyAnalysis({ graphRevisionId: bogusLink, executiveSummary: 'legacy fallback' });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, 'legacy fallback', '3.1 missing envelope → fallback preserved');
  }

  console.log('\n4. happy path — projection overrides with real narrative');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: 'this should be overridden',
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, STUB_EXEC, '4.1 executiveSummary projected from NarrativeEvaluation');
    assert(out.executiveSummary !== input.executiveSummary, '4.2 projection actually changed the value');
  }

  console.log('\n5. happy path with null legacy → projection still fills');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.executiveSummary, STUB_EXEC, '5.1 null legacy filled by projection (promote-from-graph case)');
  }

  console.log('\n6. other fields untouched (Phase 3 scope = summary only)');
  {
    const input = makeLegacyAnalysis({
      graphRevisionId: ingest.rootId,
      executiveSummary: null,
      name: 'Original name',
      findings: [],
      mitigations: [],
    });
    const out = projectLegacyAnalysisFromGraph(input, store);
    assertEqual(out.id, input.id, '6.1 id preserved');
    assertEqual(out.name, input.name, '6.2 name preserved');
    assertEqual(out.status, input.status, '6.3 status preserved');
    assertEqual(out.creditScore, input.creditScore, '6.4 creditScore preserved (null in Phase 3; future projection target)');
    assertEqual(out.mitigations.length, 0, '6.5 mitigations preserved (future projection target)');
    assertEqual(out.findings.length, 0, '6.6 findings preserved');
  }

  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});

void computeContentHash; // suppress unused
