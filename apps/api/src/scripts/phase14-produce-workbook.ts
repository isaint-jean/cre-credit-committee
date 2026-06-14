/**
 * Phase 14 — produce populated workbook (Sunroad).
 *
 *   cd apps/api && npx tsx src/scripts/phase14-produce-workbook.ts
 *
 * Runs the end-to-end produce path with all five Phase 14 fixes:
 *   - Bugs 1+2 — IO-only debt service (judgment + legacy)
 *   - Bug 3   — adapter projects synthesis additionalItems[] into adjustments[]
 *   - Bug 4   — AdjustedInputs.capitalReserves field surfaced through adapter
 *   - Bug 5   — template-engine pre-resolves sharedFormulas before mutation
 *
 * Writes the populated .xlsm to `apps/api/data/phase14-populated.xlsm`
 * (NOT committed — data/ is gitignored). Reports cell-by-cell:
 *   - CONCLUDED cells with their written values, fill state, comment
 *   - AWAITING_INPUT cells with red fill ARGB + comment text
 *   - HELD cells absent (silent omission discipline)
 *   - conservatismStatus.floorBindings verbatim
 *
 * REQUIRES: phase14-validation-gate.ts must have passed first (its DB
 * supplies the well-known-good AdjustedInputs the producer reads).
 * Re-runs the ingest on a separate db here (phase14-post-fix.db) so the
 * script is standalone-runnable.
 */
import path from 'node:path';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  ManualInputs,
  MarketBenchmarks,
  RevisionId,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildExtractionResult } from '../services/extraction/build-extraction-result.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { applyRenderPayloadToTemplate } from '../services/template-engine.service.js';
import { buildFloorBindings } from '../services/build-floor-bindings.js';
import { buildRenderPayload } from '../services/render.service.js';
import { resolveStructuralVariant } from '../services/resolve-structural-variant.js';
import { hydrateUnderwritingContext } from '../services/hydrate-underwriting-context.js';
import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
import { synthesizeUwModelFromGraph } from '../services/synthesize-uw-model-from-graph.js';
import type {
  Analysis,
  AssetType as SharedAssetType,
  RenderConservatismStatus,
  RenderLibraryBaselineMeta,
  StructuralVariantKey,
  UnderwritingMode,
  AdjustedInputs as SharedAdjustedInputs,
  UnderwritingModel,
} from '@cre/shared';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import ExcelJS from 'exceljs';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase14-post-fix.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(SCRIPT_DIR, '../../../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const POPULATED_OUT = path.join(REPO, 'apps/api/data/phase14-populated.xlsm');
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

const PLACEHOLDER_COMP: ManualInputs = {
  marketRentComps: [
    { tenantOrSpace: 'Top Tenant (T-1)',           psf: 29, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Second Tenant (T-2)',        psf: 28, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Third Tenant (T-3)',         psf: 27, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Remaining Tenants (blended)', psf: 26, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
  ],
};

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
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

function composeRenderPayload(
  analysis: Analysis,
  assetProfile?: import('@cre/contracts').AssetProfile,
): ReturnType<typeof buildRenderPayload> {
  const adjustedInputs: SharedAdjustedInputs | null = adaptAnalysisToAdjustedInputs(analysis);
  if (!adjustedInputs) throw new Error('adapt → AdjustedInputs returned null');
  const assetClass: SharedAssetType = analysis.assetType;
  const mode: UnderwritingMode = 'single_loan';
  const variantKey: StructuralVariantKey = resolveStructuralVariant(
    assetClass, adjustedInputs, {}, RENDER_CONTRACT_VERSION,
  );
  const underwritingContext = hydrateUnderwritingContext({ analysis, adjustedInputs, mode, assetProfile });
  const floorBindings = buildFloorBindings(adjustedInputs);
  const conservatismStatus: RenderConservatismStatus = {
    approved: floorBindings.length === 0,
    flags: [],
    floorBindings,
  };
  const libraryBaselineMeta: RenderLibraryBaselineMeta = {
    assetType: assetClass, sampleSize: null, vacancyMedian: null,
    expenseRatioMedian: null, capRateMedian: null, degraded: false,
  };
  return buildRenderPayload(
    {
      meta: { dealId: analysis.id, dealName: analysis.name, generatedAt: new Date().toISOString() },
      assetClass, structuralVariantKey: variantKey, underwritingMode: mode,
      adjustedInputs, underwritingContext,
      drivers: analysis.crossCheckFindings ?? [],
      conservatismStatus, libraryBaselineMeta,
    },
    { contractVersion: RENDER_CONTRACT_VERSION },
  );
}

function fmt(n: number | null): string {
  return n === null ? 'null' : (Math.abs(n) > 1000 ? n.toFixed(0) : n.toFixed(4));
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 14 — produce populated workbook');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH], ['TEMPLATE', TEMPLATE_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  // Fresh DB if validation gate didn't leave one.
  if (existsSync(DB_PATH)) rmSync(DB_PATH);

  console.log(`Template:       ${TEMPLATE_PATH}`);
  console.log(`Populated out:  ${POPULATED_OUT}`);

  // -------- Composer + ingest
  console.log('\n--- composing extraction (~30-60s)');
  const tComp = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE14-PRODUCE',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);

  console.log('\n--- ingesting');
  const store = new RecordGraphStore(DB_PATH);
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingestResult = await ingestExtractionResult(
    {
      extractionResult: composed.extractionResult,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
    },
    store,
    { manualInputs: PLACEHOLDER_COMP },
  );
  const rootId = ingestResult.rootId as RevisionId;

  // -------- Synthesize + compose payload
  const uw: UnderwritingModel | null = synthesizeUwModelFromGraph(rootId, store);
  if (uw === null) throw new Error('synthesize uwModel returned null');
  const analysisShell: Analysis = {
    id: 'phase14-produce', name: 'Sunroad Centrum (phase14)',
    assetType: 'office', status: 'complete', progress: 100, currentStep: '',
    createdAt: AS_OF, updatedAt: AS_OF,
    document: null, uwDocument: null, supportingDocuments: [], templateDocument: null,
    findings: [], creditScore: null, uwModel: uw, research: null,
    crossCheckFindings: [], mitigations: [], executiveSummary: null,
    bPieceDecision: null, comments: [], criteriaEvaluations: [], stressScenarios: [],
    overallAdjustmentBias: 'conservative',
  } as any;

  // Fetch the AssetProfile derived during ingest — surfaces `propertyType`
  // ("Office") for the v9 Property_Type cell tertiary fallback. Optional:
  // when null, Property_Type stays blank (no regression).
  const assetProfile = store.getAssetProfile(ingestResult.evaluation.assetProfileId);

  console.log('\n--- composing render payload (v9)');
  const payload = composeRenderPayload(analysisShell, assetProfile ?? undefined);
  console.log(`  contractVersion:   ${payload.contractVersion}`);
  console.log(`  schemaAddresses:   ${payload.schemaAddresses.length}`);
  console.log(`  cellBindings keys: ${Object.keys(payload.cellBindings).length}`);
  console.log(`  cellStates keys:   ${Object.keys(payload.cellStates).length}`);
  console.log(`  cellComments keys: ${Object.keys(payload.cellComments).length}`);
  console.log(`  floorBindings:     ${payload.conservatismStatus.floorBindings.length}`);

  // -------- Apply payload (template-engine now does sharedFormula pre-resolve internally)
  console.log('\n--- applying render payload to template');
  const templateBuffer = readFileSync(TEMPLATE_PATH);
  let applyOk = false;
  let applyResult: import('../services/template-engine.service.js').RenderApplyResult | null = null;
  try {
    applyResult = await applyRenderPayloadToTemplate(templateBuffer, payload);
    writeFileSync(POPULATED_OUT, applyResult.populatedBuffer);
    console.log(`  wrote populated workbook: ${POPULATED_OUT} (${applyResult.populatedBuffer.length} bytes)`);
    console.log(`  writtenAddresses:    ${applyResult.writtenAddresses.length}`);
    console.log(`  unresolvedAddresses: ${applyResult.unresolvedAddresses.length}`);
    if (applyResult.unresolvedAddresses.length > 0) {
      console.log(`    [first 5]: ${applyResult.unresolvedAddresses.slice(0, 5).join(', ')}`);
    }
    applyOk = true;
  } catch (err) {
    console.log(`\n  template-engine writeBuffer FAILED: ${(err as Error).message}`);
    console.log('  This is a Bug 5 regression — the template-engine\'s sharedFormula');
    console.log('  pre-resolution pass should have prevented this.');
  }

  // -------- Cell-by-cell report
  console.log('\n============================================================');
  console.log('CELL-BY-CELL REPORT (v9 projection — payload state map)');
  console.log('============================================================');
  let wb: ExcelJS.Workbook | null = null;
  if (applyOk && applyResult) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(applyResult.populatedBuffer as any);
  }

  function getCellInfo(addr: string): { value: unknown; fillArgb: string | null; noteText: string | null } {
    if (!wb) return { value: '<no workbook>', fillArgb: null, noteText: null };
    const idx = addr.indexOf('!');
    const sheet = addr.slice(0, idx);
    const ref = addr.slice(idx + 1);
    const ws = wb.getWorksheet(sheet);
    if (!ws) return { value: '<<NO SHEET>>', fillArgb: null, noteText: null };
    let cell: ExcelJS.Cell | undefined;
    if (/^[A-Z]+\d+$/.test(ref)) {
      cell = ws.getCell(ref);
    } else {
      // ExcelJS getMatrix returns a SPARSE 2D structure shaped as
      // sheets[name][row][col] — the cell's coordinate is at the actual
      // (row, col), NOT at index [0]. The prior `[0]` index always read
      // null and fell through to ws.getCell('A1'), producing FALSE
      // "written=null" reports for every named-range cell even when the
      // cell was correctly populated by the writer. Walk the matrix to
      // find the first populated coordinate (defined names point to a
      // single cell or a contiguous range; the first non-null entry is
      // the binding target).
      try {
        const dnRanges = (wb.definedNames as any).getMatrix(ref);
        const sheetMatrix = dnRanges?.sheets?.[sheet];
        if (Array.isArray(sheetMatrix)) {
          outer:
          for (let rIdx = 0; rIdx < sheetMatrix.length; rIdx++) {
            const row = sheetMatrix[rIdx];
            if (!Array.isArray(row)) continue;
            for (let cIdx = 0; cIdx < row.length; cIdx++) {
              const entry = row[cIdx];
              if (entry && typeof entry === 'object' && typeof entry.address === 'string') {
                cell = ws.getCell(entry.address);
                break outer;
              }
            }
          }
        }
      } catch { /* fall through */ }
      if (!cell) cell = ws.getCell('A1');
    }
    const fill = (cell as any).fill;
    const fillArgb = fill && fill.type === 'pattern' && fill.fgColor && fill.fgColor.argb
      ? String(fill.fgColor.argb) : null;
    const note = (cell as any).note;
    let noteText: string | null = null;
    if (note && Array.isArray(note.texts) && note.texts.length > 0) {
      noteText = note.texts.map((t: any) => t.text).join('');
    }
    return { value: cell.value, fillArgb, noteText };
  }

  console.log('\nCONCLUDED cells (engine value, no fill, no comment):');
  for (const [addr, state] of Object.entries(payload.cellStates)) {
    if (state !== 'concluded') continue;
    const expected = payload.cellBindings[addr];
    const info = applyOk ? getCellInfo(addr) : { value: '<projection only>', fillArgb: null, noteText: null };
    console.log(`  ${addr.padEnd(60)}  binding=${JSON.stringify(expected)}  written=${JSON.stringify(info.value)}  fill=${info.fillArgb ?? 'null'}`);
  }
  console.log('\nAWAITING_INPUT cells (value null, RED fill FFFFC7CE, comment text):');
  for (const [addr, state] of Object.entries(payload.cellStates)) {
    if (state !== 'awaiting_input') continue;
    const c = payload.cellComments[addr];
    const commentText = c?.text ?? '(none)';
    const info = applyOk ? getCellInfo(addr) : { value: null, fillArgb: '<projection only>', noteText: null };
    console.log(`  ${addr.padEnd(60)}  written=${JSON.stringify(info.value)}  fill=${info.fillArgb ?? 'null'}`);
    console.log(`    comment: ${commentText}`);
  }

  // -------- HELD cells discipline
  console.log('\nHELD rollup cells (NOT in SCHEMA_V9 — silent omission):');
  const heldPatterns = [
    /Operating History and Pro Forma!.+35$/,
    /Operating History and Pro Forma!.+44$/,
    /Operating History and Pro Forma!.+17$/,
    /Operating History and Pro Forma!.+33$/,
  ];
  for (const pat of heldPatterns) {
    const offenders = Object.keys(payload.cellStates).filter((a) => pat.test(a));
    console.log(`  pattern ${pat}: ${offenders.length === 0 ? 'OK (silent omission)' : `LEAK: ${offenders.join(', ')}`}`);
  }

  // -------- conservatismStatus.floorBindings
  console.log('\n============================================================');
  console.log('conservatismStatus.floorBindings (verbatim)');
  console.log('============================================================');
  if (payload.conservatismStatus.floorBindings.length === 0) {
    console.log('  (empty)');
  }
  for (const fb of payload.conservatismStatus.floorBindings) {
    console.log(`  [${fb.ruleId}]  lineItem=${fb.lineItem}  delta=${fb.delta}  reason=${fb.reason}`);
  }

  // -------- Key cell highlights (Phase 14 acceptance)
  console.log('\n============================================================');
  console.log('PHASE 14 ACCEPTANCE — key cells');
  console.log('============================================================');
  const dscrInfo = applyOk ? getCellInfo('Conclusions & Escrows!I16') : { value: null, fillArgb: null, noteText: null };
  console.log(`  DSCR (Conclusions & Escrows!I16): ${JSON.stringify(dscrInfo.value)} state=${payload.cellStates['Conclusions & Escrows!I16'] ?? 'absent'} fill=${dscrInfo.fillArgb ?? 'null'}`);
  const reservesInfo = applyOk ? getCellInfo('Operating History and Pro Forma!P38') : { value: null, fillArgb: null, noteText: null };
  console.log(`  Replacement Reserves (Op History!P38): ${JSON.stringify(reservesInfo.value)} state=${payload.cellStates['Operating History and Pro Forma!P38'] ?? 'absent'} fill=${reservesInfo.fillArgb ?? 'null'}`);
  const vacancyInfo = applyOk ? getCellInfo('Operating History and Pro Forma!P6') : { value: null, fillArgb: null, noteText: null };
  console.log(`  Vacancy % (Op History!P6): ${JSON.stringify(vacancyInfo.value)} state=${payload.cellStates['Operating History and Pro Forma!P6'] ?? 'absent'}`);
  const capRateInfo = applyOk ? getCellInfo('Conclusions & Escrows!Concluded_Cap_Rate') : { value: null, fillArgb: null, noteText: null };
  console.log(`  Concluded Cap Rate: state=${payload.cellStates['Conclusions & Escrows!Concluded_Cap_Rate'] ?? 'absent'} fill=${capRateInfo.fillArgb ?? 'null'}`);

  store.close();
  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
})().catch((e) => {
  console.error('phase 14 produce script threw:', e);
  process.exit(2);
});
