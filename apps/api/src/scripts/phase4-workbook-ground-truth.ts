/**
 * Phase 4 — workbook ground-truth inspection.
 *
 *   npx tsx apps/api/src/scripts/phase4-workbook-ground-truth.ts
 *
 * Generates the BP Spire .xlsx for TWO equivalent records and dumps the
 * tab-by-tab populated/blank map:
 *
 *   (A) "legacy" : a Promote-promoted analysis where uwModel is assigned
 *       BEFORE the projector runs (simulating a fully-uw'd legacy record).
 *   (B) "promoted": a Promote-promoted analysis where uwModel is null and
 *       the projector synthesizes one from graph.
 *
 * Both reach the export through the SAME composeRenderPayload pipeline
 * (replicated here since the upstream function is private). The two paths
 * should produce byte-equivalent payloads — same RenderedAnalysis numbers,
 * same workbook cells populated.
 *
 * Output:
 *   - /tmp/phase4-legacy-bp-spire.xlsx
 *   - /tmp/phase4-promoted-bp-spire.xlsx
 *   - inline report: writtenAddresses per sheet, hiddenSheets,
 *     unresolvedAddresses, proforma cell count, LTV cell presence.
 *
 * No persistence to data/cre.db — uses :memory: for the graph store and
 * never touches sqlite-store (the script bypasses the route handler and
 * calls buildRenderPayload + applyRenderPayloadToTemplate directly).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  PropertyMetadata,
} from '@cre/contracts';
import type { Analysis, UnderwritingModel } from '@cre/shared';
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
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
import { synthesizeUwModelFromGraph } from '../services/synthesize-uw-model-from-graph.js';
import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
import { hydrateUnderwritingContext } from '../services/hydrate-underwriting-context.js';
import { buildRenderPayload } from '../services/render.service.js';
import { resolveStructuralVariant } from '../services/resolve-structural-variant.js';
import { applyRenderPayloadToTemplate } from '../services/template-engine.service.js';
import type {
  AssetType as LegacyAssetType,
  RenderInput,
  RenderConservatismStatus,
  RenderLibraryBaselineMeta,
  StructuralVariantKey,
  UnderwritingMode,
} from '@cre/shared';
import type { LLMCallFn } from '../services/narrative/build-narrative.js';

const AS_OF = '2026-05-30T00:00:00Z';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(SCRIPT_DIR, '../../../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');

// -------------------- fixtures (copied from synthesis test) -----------------

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'PHASE-4-GROUND-TRUTH',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2027-01-01T00:00:00Z',
          baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000, occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'Tenant B', leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2034-01-01T00:00:00Z',
          baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000, occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    inPlace: {
      period: 'T-12 ending Apr 2026', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000, repairsMaintenance: 36_000,
                   managementFees: 40_000, generalAndAdmin: null, janitorial: null, reimbursements: null,
                   totalOperatingExpenses: 218_000 },
      belowNoiAdjustments: { replacementReserves: 9_000, tenantImprovements: null, leasingCommissions: null },
    },
    t12Actual: null,
    pca: {
      immediateRepairs: 50_000, shortTermRepairs: 150_000, evaluationPeriodYears: null, inflationRate: null,
      replacementReservesPerSfPerYearInflated: null, replacementReservesPerSfPerYearUninflated: null,
      capexScheduleInflated: null, capexScheduleUninflated: null,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: { loanAmount: 11_000_000, interestRate: 0.07, amortization: 360, interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
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
  return { id: computeLibrarySnapshotId({ asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType }),
           asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType } as LibrarySnapshot;
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
    propertyName: 'Phase-4 Ground Truth Office',
    propertySubtype: 'Suburban Office',
    address: '123 Ground Truth Way', city: 'San Diego', state: 'CA', zip: '92101',
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

function makeMinimalAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    id: 'phase4-test',
    name: 'Phase 4 Ground Truth',
    assetType: 'office',
    status: 'complete',
    progress: 100,
    currentStep: '',
    createdAt: AS_OF, updatedAt: AS_OF,
    document: null, uwDocument: null, supportingDocuments: [], templateDocument: null,
    findings: [], creditScore: null, uwModel: null, research: null,
    crossCheckFindings: [], mitigations: [],
    executiveSummary: null, bPieceDecision: null,
    comments: [], criteriaEvaluations: [], stressScenarios: [],
    overallAdjustmentBias: 'conservative',
    ...overrides,
  };
}

// -------------------- replicated compose pipeline ---------------------------

interface ComposeResult {
  payload: ReturnType<typeof buildRenderPayload>;
  assetClass: LegacyAssetType;
  variantKey: StructuralVariantKey;
  mode: UnderwritingMode;
}

function composeForAnalysis(analysis: Analysis): ComposeResult {
  const adjustedInputs = adaptAnalysisToAdjustedInputs(analysis);
  if (adjustedInputs === null) {
    throw new Error('adaptAnalysisToAdjustedInputs returned null');
  }
  // analysis.assetType is the @cre/shared legacy AssetType (lowercase);
  // resolveStructuralVariant + RenderInput consume that same shape.
  const assetClass: LegacyAssetType = analysis.assetType;
  const mode: UnderwritingMode = 'single_loan';
  const variantKey = resolveStructuralVariant(assetClass, adjustedInputs, {}, RENDER_CONTRACT_VERSION);
  const underwritingContext = hydrateUnderwritingContext({ analysis, adjustedInputs, mode });

  // Mirror buildConservatismStatus + buildLibraryBaselineMeta from render.routes.ts.
  const findings = analysis.crossCheckFindings ?? [];
  const flags = findings.filter((f) => f.severity === 'high' || f.severity === 'critical').map((f) => `${f.metric} [${f.flag}]`);
  const conservatismStatus: RenderConservatismStatus = {
    approved: analysis.overallAdjustmentBias === 'conservative' && flags.length === 0,
    flags,
  };
  const libraryBaselineMeta: RenderLibraryBaselineMeta = {
    assetType: analysis.assetType,
    sampleSize: null, vacancyMedian: null, expenseRatioMedian: null, capRateMedian: null,
    degraded: false,
  };

  const renderInput: RenderInput = {
    meta: { dealId: analysis.id, dealName: analysis.name, generatedAt: new Date().toISOString() },
    assetClass,
    structuralVariantKey: variantKey,
    underwritingMode: mode,
    adjustedInputs,
    underwritingContext,
    drivers: analysis.crossCheckFindings ?? [],
    conservatismStatus,
    libraryBaselineMeta,
  };
  const payload = buildRenderPayload(renderInput, { contractVersion: RENDER_CONTRACT_VERSION });
  return { payload, assetClass, variantKey, mode };
}

// -------------------- sheet inspection --------------------------------------

function bySheet(addresses: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of addresses) {
    const idx = a.indexOf('!');
    const sheet = idx >= 0 ? a.slice(0, idx) : '(no-sheet)';
    const range = idx >= 0 ? a.slice(idx + 1) : a;
    if (!out.has(sheet)) out.set(sheet, []);
    out.get(sheet)!.push(range);
  }
  return out;
}

function reportCells(label: string, result: { writtenAddresses: string[]; unresolvedAddresses: string[]; hiddenSheets: string[]; tablesWritten: string[] }, payload: ReturnType<typeof buildRenderPayload>): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  contractVersion=${payload.contractVersion}  assetClass=${payload.assetClass}  variantKey=${payload.structuralVariantKey}  mode=${payload.underwritingMode}`);
  console.log(`  visibleTabs (${payload.visibleTabs.length}): ${payload.visibleTabs.join(', ')}`);
  console.log(`  hiddenSheets (${result.hiddenSheets.length}): ${result.hiddenSheets.join(', ') || '—'}`);
  console.log(`  cellBindings count: ${Object.keys(payload.cellBindings).length}`);
  console.log(`  writtenAddresses (${result.writtenAddresses.length}):`);
  const grouped = bySheet(result.writtenAddresses);
  for (const [sheet, ranges] of [...grouped.entries()].sort()) {
    console.log(`    ${sheet} (${ranges.length}):`);
    for (const r of ranges) {
      const fullAddr = `${sheet}!${r}`;
      const value = payload.cellBindings[fullAddr];
      console.log(`      ${r.padEnd(34)} = ${JSON.stringify(value)}`);
    }
  }
  console.log(`  unresolvedAddresses (${result.unresolvedAddresses.length}): ${result.unresolvedAddresses.join(', ') || '—'}`);
  console.log(`  tablesWritten (${result.tablesWritten.length}): ${result.tablesWritten.join(', ') || '—'}`);

  // Specific probes the brief asks for.
  console.log(`\n  PROBES:`);
  const proformaSheets = ['Operating Pro Forma', 'Hotel Op Pro Forma', 'Operating_ProForma'];
  const proformaWritten = result.writtenAddresses.filter((a) => proformaSheets.some((s) => a.startsWith(`${s}!`)));
  console.log(`    Operating ProForma cells populated: ${proformaWritten.length} ${proformaWritten.length === 0 ? '(BLANK)' : `(${proformaWritten.join(', ')})`}`);
  const ltvAddresses = result.writtenAddresses.filter((a) => /ltv|LTV|Loan_To_Value/i.test(a));
  console.log(`    LTV cells:                          ${ltvAddresses.length} ${ltvAddresses.length === 0 ? '(ABSENT)' : `(${ltvAddresses.join(', ')})`}`);
  const incomeAddresses = result.writtenAddresses.filter((a) => /Income|Revenue|EGI|GPR/i.test(a));
  console.log(`    Income cells:                       ${incomeAddresses.length} ${incomeAddresses.length === 0 ? '(NONE)' : `(${incomeAddresses.join(', ')})`}`);
  const expenseAddresses = result.writtenAddresses.filter((a) => /Expense|OpEx|Taxes|Insurance|Utilities/i.test(a));
  console.log(`    Expense cells:                      ${expenseAddresses.length} ${expenseAddresses.length === 0 ? '(NONE)' : `(${expenseAddresses.join(', ')})`}`);
  const noiAddresses = result.writtenAddresses.filter((a) => /NOI|Net_Operating|Net Operating/i.test(a));
  console.log(`    NOI cells:                          ${noiAddresses.length} ${noiAddresses.length === 0 ? '(NONE)' : `(${noiAddresses.join(', ')})`}`);
}

// -------------------- main --------------------------------------------------

(async () => {
  // 1. Build shared graph substrate.
  const store = new RecordGraphStore(':memory:');
  store.insertLibrarySnapshot(makeSnapshot());

  const extraction = makeFullExtraction();
  const pm = makePropertyMetadata();
  store.insertExtractionResult(extraction);
  store.insertPropertyMetadata(pm);
  store.insertExtractionInputCache({
    cacheKey: computeContentHash(`phase4-${Date.now()}`) as ContentHash,
    extractionResultId: extraction.id, propertyMetadataId: pm.id,
    cfHash: null, rentRollHash: null, asrHash: null, pcaHash: null, extractorVersions: {},
  });

  const lib = makeSnapshot();
  const ingest = await ingestExtractionResult(
    {
      extractionResult: extraction,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: null,
    },
    store,
    { llmCall: stubLlm },
  );

  // 2. Path (A) — LEGACY: synthesize uwModel and assign it before projection.
  const legacyUwModel: UnderwritingModel | null = synthesizeUwModelFromGraph(ingest.rootId, store);
  if (legacyUwModel === null) throw new Error('synthesis null for legacy path');
  const legacyAnalysis = makeMinimalAnalysis({
    id: 'phase4-legacy',
    uwModel: legacyUwModel,
    // No graphRevisionId — simulates a pure legacy record.
  });

  // 3. Path (B) — PROMOTED: graphRevisionId set, uwModel null; projector synthesizes.
  const promotedAnalysisStored = makeMinimalAnalysis({
    id: 'phase4-promoted',
    uwModel: null,
    graphRevisionId: ingest.rootId,
  });
  const promotedAnalysisProjected = projectLegacyAnalysisFromGraph(promotedAnalysisStored, store);
  if (promotedAnalysisProjected.uwModel === null) throw new Error('projector did not synthesize uwModel for promoted path');

  // 4. Load template artifact.
  console.log(`Loading template: ${TEMPLATE_PATH}`);
  const templateBuffer = readFileSync(TEMPLATE_PATH);
  console.log(`  size: ${templateBuffer.length} bytes`);

  // 5. Compose + apply for both paths.
  console.log('\n--- Composing LEGACY ---');
  const legacyCompose = composeForAnalysis(legacyAnalysis);
  const legacyApply = await applyRenderPayloadToTemplate(templateBuffer, legacyCompose.payload);
  writeFileSync('/tmp/phase4-legacy-bp-spire.xlsx', legacyApply.populatedBuffer);
  console.log(`  saved /tmp/phase4-legacy-bp-spire.xlsx (${legacyApply.populatedBuffer.length} bytes)`);

  console.log('\n--- Composing PROMOTED ---');
  const promotedCompose = composeForAnalysis(promotedAnalysisProjected);
  const promotedApply = await applyRenderPayloadToTemplate(templateBuffer, promotedCompose.payload);
  writeFileSync('/tmp/phase4-promoted-bp-spire.xlsx', promotedApply.populatedBuffer);
  console.log(`  saved /tmp/phase4-promoted-bp-spire.xlsx (${promotedApply.populatedBuffer.length} bytes)`);

  // 6. Report cells.
  reportCells('LEGACY workbook (real uwModel)', legacyApply, legacyCompose.payload);
  reportCells('PROMOTED workbook (synthesized uwModel)', promotedApply, promotedCompose.payload);

  // 7. Cross-compare.
  console.log('\n=== CROSS-COMPARE ===');
  const legacyAddrs = new Set(legacyApply.writtenAddresses);
  const promotedAddrs = new Set(promotedApply.writtenAddresses);
  const onlyLegacy = [...legacyAddrs].filter((a) => !promotedAddrs.has(a));
  const onlyPromoted = [...promotedAddrs].filter((a) => !legacyAddrs.has(a));
  console.log(`  legacy cell count   : ${legacyAddrs.size}`);
  console.log(`  promoted cell count : ${promotedAddrs.size}`);
  console.log(`  only-in-legacy      : ${onlyLegacy.length} ${onlyLegacy.length === 0 ? '(none)' : `[${onlyLegacy.join(', ')}]`}`);
  console.log(`  only-in-promoted    : ${onlyPromoted.length} ${onlyPromoted.length === 0 ? '(none)' : `[${onlyPromoted.join(', ')}]`}`);

  let cellValueDiffs = 0;
  for (const addr of legacyAddrs) {
    if (!promotedAddrs.has(addr)) continue;
    const lv = legacyCompose.payload.cellBindings[addr];
    const pv = promotedCompose.payload.cellBindings[addr];
    if (JSON.stringify(lv) !== JSON.stringify(pv)) {
      console.log(`  VALUE DIFF: ${addr}  legacy=${JSON.stringify(lv)}  promoted=${JSON.stringify(pv)}`);
      cellValueDiffs++;
    }
  }
  console.log(`  cell-value diffs    : ${cellValueDiffs} ${cellValueDiffs === 0 ? '(IDENTICAL VALUES)' : ''}`);

  store.close();
  process.exit(0);
})().catch((e) => {
  console.error('phase 4 script threw:', e);
  process.exit(2);
});
