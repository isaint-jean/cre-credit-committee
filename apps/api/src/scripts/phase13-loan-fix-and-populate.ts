/**
 * Phase 13 — corrected-loan-terms re-run + populated-workbook export (Phase A).
 *
 *   cd apps/api && npx tsx src/scripts/phase13-loan-fix-and-populate.ts
 *
 * Writes to data/phase13-loan-fix.db (SEPARATE from cre.db and every prior
 * phase db: phase8-rr-node.db, phase9-refi-gate.db,
 * phase10-reserve-footnote-gate.db, phase11-noi-recon.db, phase12-period-fix.db).
 *
 * Two things happen in this script:
 *   1. Re-run the Sunroad fixtures (ASR + CF + PCA + 4-file ingest) with the
 *      CORRECTED LOAN_TERMS (Phase A prerequisite — phase12 LOAN_TERMS was
 *      $80M @ 7% / 30-yr amort placeholder; real Sunroad is $82.46M @ 7.9%
 *      IO-only over a 60-mo term).
 *   2. EXPORT the populated workbook through the v9 render pipeline. The
 *      populated .xlsm is written to data/phase13-populated.xlsm (NOT
 *      committed — gitignored via the data/ directory).
 *
 * After the ingest, the report covers:
 *   - Corrected loan inputs flowing through to AdjustedInputs.metrics:
 *     debtServiceAnnual, dscr, debtYield, value, ltvAppraisal.
 *   - DSCR + Debt Yield diff vs the Sunroad answer key (1.343 NOI / 1.305 NCF
 *     / Debt Yield 0.106), with ±5% / ±50bps bands. Confirms the
 *     CONCLUDED-vs-AWAITING_INPUT classification chosen in v9.
 *   - The three-state map per cell:
 *       * CONCLUDED   — engine value, ARGB null, comment null
 *       * AWAITING_INPUT — value null, ARGB FFFFC7CE, comment text verbatim
 *       * HELD        — explicitly NOT in SCHEMA_V9 (verified by query)
 *   - The conservatismStatus.floorBindings contents (vacancy floor binding
 *     should be present on Sunroad; expense-ratio floor may or may not
 *     bind depending on corrected loan flow).
 *
 * The script intentionally does NOT exit non-zero on diff drift — it
 * REPORTS verbatim. The brief's Phase-A discipline is "ship as
 * AWAITING_INPUT iff diff is dirty or optimistic"; the human reviewer
 * confirms the classification before this commit lands.
 */

import path from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  HandbookEvaluation,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  ManualInputs,
  MarketBenchmarks,
  RevisionId,
  RentRoll,
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
import { projectLegacyAnalysisFromGraph } from '../services/project-legacy-analysis-from-graph.js';
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
const DB_PATH = path.join(REPO, 'apps/api/data/phase13-loan-fix.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(SCRIPT_DIR, '../../../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm');
const POPULATED_OUT = path.join(REPO, 'apps/api/data/phase13-populated.xlsm');
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

// Corrected per the Sunroad answer-key Property & Loan Summary.
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

const ANSWER_KEY = {
  dscrNoi: 1.343,
  dscrNcf: 1.305,
  debtYield: 0.106,
  capRate: 0.085,         // analyst-concluded cap on Sunroad
  concludedValue: 103_100_000,
} as const;

/**
 * Pre-process the template buffer: detach every cell that uses a
 * sharedFormula reference, replacing its model with the resolved formula
 * (a standalone copy) so subsequent overwrites of a master cell don't
 * orphan its descendants at xlsx-write time.
 *
 * This is a Phase-A export workaround scoped to phase13 — the long-term
 * fix is in the template-engine (which the brief flags as cleanup #8 in
 * the broader populated-workbook initiative, not a Phase A scope item).
 */
async function preprocessSharedFormulas(buf: Buffer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  wb.eachSheet((ws) => {
    // Build a master-formula lookup keyed by A1 master ref (the
    // sharedFormula value points to the master cell's address).
    const masters: Record<string, string> = {};
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'formula' in v && !('sharedFormula' in v) && typeof v.formula === 'string') {
          masters[cell.address] = v.formula as string;
        }
      });
    });
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'sharedFormula' in v) {
          const masterRef = v.sharedFormula as string;
          const masterFormula = masters[masterRef];
          if (masterFormula) {
            // Detach: replace the sharedFormula cell with a standalone
            // formula. The result value is preserved.
            cell.value = {
              formula: masterFormula,
              result: v.result,
            } as any;
          } else {
            // Master not tracked — drop the formula entirely, keep the
            // result. The cell becomes a plain value cell.
            cell.value = v.result ?? null;
          }
        }
      });
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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

async function ingest(
  store: RecordGraphStore,
  composed: { extractionResult: import('@cre/contracts').ExtractionResult; rentRoll: RentRoll | null },
  label: string,
  manualInputs: ManualInputs | undefined,
): Promise<{ rootId: RevisionId; he: HandbookEvaluation }> {
  console.log(`\n--- ingest: ${label}`);
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const dealRef = `SUNROAD-PHASE13-${label}`;
  const er = { ...composed.extractionResult, dealRef };
  const { computeExtractionResultId } = await import('../util/content-hash.js');
  const { id: _oldId, ...erBody } = er;
  void _oldId;
  const newId = computeExtractionResultId(erBody);
  const erCorrect = { id: newId, ...erBody } as typeof composed.extractionResult;
  const ingestResult = await ingestExtractionResult(
    {
      extractionResult: erCorrect,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
    },
    store,
    manualInputs !== undefined ? { manualInputs } : {},
  );
  const envelope = store.getRevisionEnvelope(ingestResult.rootId as RevisionId);
  if (!envelope) throw new Error('envelope null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (!he) throw new Error('HE null');
  return { rootId: ingestResult.rootId as RevisionId, he };
}

function diff(actual: number | null, expected: number, bandPct: number, bandBps?: number): {
  ok: boolean; delta: number; deltaPct: number; direction: 'conservative' | 'optimistic' | 'match';
} {
  if (actual === null) return { ok: false, delta: NaN, deltaPct: NaN, direction: 'match' };
  const delta = actual - expected;
  const deltaPct = delta / expected;
  const direction = Math.abs(deltaPct) < 0.001 ? 'match' : (actual > expected ? 'optimistic' : 'conservative');
  // ratios use bandBps; dollar values use bandPct
  if (bandBps !== undefined) {
    return { ok: Math.abs(delta) <= bandBps / 10_000, delta, deltaPct, direction };
  }
  return { ok: Math.abs(deltaPct) <= bandPct, delta, deltaPct, direction };
}

function fmt(n: number | null): string {
  return n === null ? 'null' : (Math.abs(n) > 1000 ? n.toFixed(0) : n.toFixed(4));
}

/** Compose a RenderPayload for a stored analysis. Mirrors the
 *  composeForAnalysis pattern from phase4-workbook-ground-truth.ts. */
function composeRenderPayload(analysis: Analysis): ReturnType<typeof buildRenderPayload> {
  const adjustedInputs: SharedAdjustedInputs | null = adaptAnalysisToAdjustedInputs(analysis);
  if (!adjustedInputs) throw new Error('adapt → AdjustedInputs returned null');
  // analysis.assetType is the @cre/shared LEGACY AssetType (lowercase
  // 'office' | 'retail' | …). The render-schema layer uses the same
  // alphabet — we cast through `unknown` to bridge type signatures (the
  // contracts package's AssetType uses 'Office' etc. but the schema
  // signature here is the shared LegacyAssetType, just imported under
  // the same identifier).
  const assetClass: SharedAssetType = analysis.assetType;
  const mode: UnderwritingMode = 'single_loan';
  const variantKey: StructuralVariantKey = resolveStructuralVariant(
    assetClass, adjustedInputs, {}, RENDER_CONTRACT_VERSION,
  );
  const underwritingContext = hydrateUnderwritingContext({ analysis, adjustedInputs, mode });
  // floor-binding disclosure ships v8+; pulls floor-rule entries off the
  // AdjustedInputs.adjustments ledger.
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

(async () => {
  console.log('============================================================');
  console.log('PHASE 13 — corrected-loan-terms re-run + populated workbook');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH], ['TEMPLATE', TEMPLATE_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:             ${DB_PATH}`);
  console.log(`Template:       ${TEMPLATE_PATH}`);
  console.log(`Populated out:  ${POPULATED_OUT}`);
  console.log(`Loan terms:     loanAmount=${LOAN_TERMS.loanAmount}, rate=${LOAN_TERMS.interestRate}, amort=${LOAN_TERMS.amortization}, ioMonths=${LOAN_TERMS.interestOnlyPeriod}`);

  // -------- Composer pass
  console.log('\n--- composer pass (real PCA + ASR AI extraction; ~30-60s)');
  const tComp = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE13-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);

  // -------- Real ingest
  const store = new RecordGraphStore(DB_PATH);
  const { rootId } = await ingest(store, composed, 'mode-A-with-comp', PLACEHOLDER_COMP);

  // -------- Inspect AdjustedInputs.metrics (post loan-fix)
  const envelope = store.getRevisionEnvelope(rootId);
  if (!envelope) throw new Error('envelope null');
  const adjustedInputsContract = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (!adjustedInputsContract) throw new Error('AdjustedInputs null');

  console.log('\n============================================================');
  console.log('CORRECTED METRICS (post loan-terms fix)');
  console.log('============================================================');
  console.log(`  debtServiceAnnual:  ${fmt(adjustedInputsContract.loan.debtServiceAnnual.adjusted)}`);
  console.log(`  noi:                ${fmt(adjustedInputsContract.metrics.noi)}`);
  console.log(`  dscr:               ${fmt(adjustedInputsContract.metrics.dscr)}`);
  console.log(`  debtYield:          ${fmt(adjustedInputsContract.metrics.debtYield)}`);
  console.log(`  value:              ${fmt(adjustedInputsContract.metrics.value)}`);
  console.log(`  ltvAppraisal:       ${fmt(adjustedInputsContract.metrics.ltvAppraisal)}`);

  // -------- Diff vs answer key
  console.log('\n============================================================');
  console.log('DIFF vs answer key (DSCR ±50bps, Debt Yield ±50bps)');
  console.log('============================================================');
  const dscrDiff = diff(adjustedInputsContract.metrics.dscr, ANSWER_KEY.dscrNoi, 0.05, 50);
  const dyDiff = diff(adjustedInputsContract.metrics.debtYield, ANSWER_KEY.debtYield, 0.05, 50);
  console.log(`  DSCR(NOI):   engine=${fmt(adjustedInputsContract.metrics.dscr)}  answer=${ANSWER_KEY.dscrNoi}  delta=${fmt(dscrDiff.delta)} (${(dscrDiff.deltaPct * 100).toFixed(2)}%)  band=${dscrDiff.ok ? 'IN' : 'OUT'}  direction=${dscrDiff.direction}  → ${dscrDiff.ok && dscrDiff.direction !== 'optimistic' ? 'CONCLUDED' : 'AWAITING_INPUT'}`);
  console.log(`  Debt Yield:  engine=${fmt(adjustedInputsContract.metrics.debtYield)}  answer=${ANSWER_KEY.debtYield}  delta=${fmt(dyDiff.delta)} (${(dyDiff.deltaPct * 100).toFixed(2)}%)  band=${dyDiff.ok ? 'IN' : 'OUT'}  direction=${dyDiff.direction}  → ${dyDiff.ok && dyDiff.direction !== 'optimistic' ? 'CONCLUDED' : 'AWAITING_INPUT'}`);

  // -------- Build a legacy-Analysis shell from the graph so we can compose
  //          a RenderPayload through the same pipeline /render uses.
  const legacyUwModel: UnderwritingModel | null = synthesizeUwModelFromGraph(rootId, store);
  if (legacyUwModel === null) throw new Error('synthesize uwModel returned null');
  const analysisShell: Analysis = {
    id: 'phase13-sunroad', name: 'Sunroad Centrum (phase13)', assetType: 'office',
    status: 'complete', progress: 100, currentStep: '',
    createdAt: AS_OF, updatedAt: AS_OF,
    document: null, uwDocument: null, supportingDocuments: [], templateDocument: null,
    findings: [], creditScore: null, uwModel: legacyUwModel, research: null,
    crossCheckFindings: [], mitigations: [], executiveSummary: null,
    bPieceDecision: null, comments: [], criteriaEvaluations: [], stressScenarios: [],
    overallAdjustmentBias: 'conservative',
  } as any;
  // projectLegacyAnalysisFromGraph is a no-op when uwModel is already populated
  const analysis = projectLegacyAnalysisFromGraph(analysisShell, store);

  // -------- Compose + apply
  console.log('\n--- composing + applying render payload (v9)');
  const payload = composeRenderPayload(analysis);
  console.log(`  contractVersion:   ${payload.contractVersion}`);
  console.log(`  schemaAddresses:   ${payload.schemaAddresses.length}`);
  console.log(`  cellBindings keys: ${Object.keys(payload.cellBindings).length}`);
  console.log(`  cellStates keys:   ${Object.keys(payload.cellStates).length}`);
  console.log(`  cellComments keys: ${Object.keys(payload.cellComments).length}`);

  const templateBuffer = readFileSync(TEMPLATE_PATH);
  // Try to materialize the populated workbook. The Blank UW Template
  // makes heavy use of sharedFormula references AND conditional-formatting
  // expressions that some ExcelJS write paths choke on when downstream
  // values change. The schema-layer projection above is the load-bearing
  // result of Phase A; the Excel write is a downstream demo, not a
  // blocker. If the write fails we still emit the cell-by-cell projection
  // report below.
  let applyOk = false;
  let applyResult: import('../services/template-engine.service.js').RenderApplyResult | null = null;
  try {
    const preprocessed = await preprocessSharedFormulas(templateBuffer);
    applyResult = await applyRenderPayloadToTemplate(preprocessed, payload);
    writeFileSync(POPULATED_OUT, applyResult.populatedBuffer);
    console.log(`\n  wrote populated workbook: ${POPULATED_OUT} (${applyResult.populatedBuffer.length} bytes)`);
    console.log(`  writtenAddresses:    ${applyResult.writtenAddresses.length}`);
    console.log(`  unresolvedAddresses: ${applyResult.unresolvedAddresses.length}`);
    if (applyResult.unresolvedAddresses.length > 0) {
      console.log(`    [first 5]: ${applyResult.unresolvedAddresses.slice(0, 5).join(', ')}`);
    }
    applyOk = true;
  } catch (err) {
    console.log(`\n  template-engine Excel write FAILED: ${(err as Error).message}`);
    console.log('  This is a known Blank UW Template integration issue ' +
                '(shared formulas + conditional-formatting) and is OUT OF ' +
                'SCOPE for Phase A. The projection report below is the ' +
                'authoritative cell-by-cell discipline check.');
  }

  // -------- Cell-by-cell projection report
  console.log('\n============================================================');
  console.log('CELL-BY-CELL REPORT (v9 projection — payload state map)');
  console.log('============================================================');
  let wb: ExcelJS.Workbook | null = null;
  if (applyOk && applyResult) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(applyResult.populatedBuffer as any);
  }

  function getCellInfo(addr: string): { value: unknown; fillArgb: string | null } {
    if (!wb) return { value: '<no workbook>', fillArgb: null };
    const idx = addr.indexOf('!');
    const sheet = addr.slice(0, idx);
    const ref = addr.slice(idx + 1);
    const ws = wb.getWorksheet(sheet);
    if (!ws) return { value: '<<NO SHEET>>', fillArgb: null };
    let cell;
    if (/^[A-Z]+\d+$/.test(ref)) {
      cell = ws.getCell(ref);
    } else {
      try {
        const dnRanges = (wb.definedNames as any).getMatrix(ref);
        const r = dnRanges?.sheets?.[sheet]?.[0];
        if (r) cell = ws.getCell(r);
      } catch { /* fall through */ }
      if (!cell) cell = ws.getCell('A1');
    }
    const fill = (cell as any).fill;
    const fillArgb = fill && fill.type === 'pattern' && fill.fgColor && fill.fgColor.argb
      ? String(fill.fgColor.argb) : null;
    return { value: cell.value, fillArgb };
  }

  console.log('\nCONCLUDED cells (engine value, no fill, no comment):');
  for (const [addr, state] of Object.entries(payload.cellStates)) {
    if (state !== 'concluded') continue;
    const expected = payload.cellBindings[addr];
    const info = applyOk ? getCellInfo(addr) : { value: '<projection only>', fillArgb: null };
    console.log(`  ${addr.padEnd(60)}  binding=${JSON.stringify(expected)}  written=${JSON.stringify(info.value)}  fill=${info.fillArgb ?? 'null'}`);
  }
  console.log('\nAWAITING_INPUT cells (value null, RED fill FFFFC7CE, comment text):');
  for (const [addr, state] of Object.entries(payload.cellStates)) {
    if (state !== 'awaiting_input') continue;
    const c = payload.cellComments[addr];
    const commentText = c?.text ?? '(none)';
    const info = applyOk ? getCellInfo(addr) : { value: null, fillArgb: '<projection only>' };
    console.log(`  ${addr.padEnd(60)}  written=${JSON.stringify(info.value)}  fill=${info.fillArgb ?? 'null'}`);
    console.log(`    comment: ${commentText}`);
  }

  // -------- HELD cells discipline
  console.log('\nHELD rollup cells (NOT in SCHEMA_V9 — silent omission):');
  const heldPatterns = [
    /Operating History and Pro Forma!.+35$/,  // NOI
    /Operating History and Pro Forma!.+44$/,  // NCF
    /Operating History and Pro Forma!.+17$/,  // EGI / Total Revenues
    /Operating History and Pro Forma!.+33$/,  // Total OpEx
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

  store.close();
  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
})().catch((e) => {
  console.error('phase 13 script threw:', e);
  process.exit(2);
});
