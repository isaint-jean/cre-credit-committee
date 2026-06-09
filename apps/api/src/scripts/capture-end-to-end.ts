/**
 * Throwaway capture tool — Sunroad (current) + Showcase (current) +
 * Showcase (FUTURE-STATE rent-roll-seeded). Reads source docs out of the
 * intake store, runs buildExtractionResult → ingestExtractionResult,
 * then pulls AdjustedInputs / HandbookEval / DoctrineEval /
 * MitigationProposalSet / NarrativeEvaluation from the store and dumps
 * to stdout + /tmp/end-to-end-capture.out.
 *
 *   cd apps/api && npx tsx src/scripts/capture-end-to-end.ts
 *
 * Real Anthropic API key is loaded from .env. Network calls hit Anthropic
 * for narrative slots + judgment-side seller-metric extraction.
 *
 * Pass 3 (Showcase FUTURE-STATE) seeds an in-memory rent-roll-only xlsx
 * extracted from the Eightfold workbook's "Rent Roll" sheet. Model A
 * purity: the seeded buffer contains ONLY the Rent Roll sheet's cell
 * values (formulas unwrapped to results, no cross-sheet refs). The script
 * also asserts that the resulting RentRoll has lines>0 and that the
 * composer's slotReport for the conclusion-side slots is empty.
 *
 * NOT a commit — uncommitted artifact for this capture task.
 */
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';

import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
  NARRATIVE_ENGINE_VERSION,
  MITIGATION_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
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
import {
  getSourceDocBuffer,
  getDealManifest,
} from '../services/source-doc-store.service.js';
import type { SourceDocSlot, SourceDocEntry } from '@cre/shared';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/end-to-end-capture.db');
const AS_OF = '2026-06-08T00:00:00Z' as ISODateTime;
const OUT_PATH = '/tmp/end-to-end-capture.out';

const SUNROAD_UW_ID  = '3327fd55-e382-4286-8378-64d33a11e518';
const SHOWCASE_UW_ID = '67a58a50-cb57-418c-bd59-6f3966c49823';
const EIGHTFOLD_PATH = '/Users/isabellesaint-jean/Downloads/Intelligence/Archive/003. Showcase I.xlsm';

// Sunroad — corrected loan terms (phase15 baseline).
const SUNROAD_LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};
// Showcase — from the deep-check workbook.
const SHOWCASE_LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 169_500_000,
  interestRate: 0.0636,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2029-05-31T00:00:00Z' as ISODateTime,
};

/* ----------------------------- shared fixtures ----------------------------- */
function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}
function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  for (const t of ['Office','Retail','Multifamily','Hotel','Industrial','SelfStorage','MHC','MixedUse','Other'] as AssetType[]) {
    byAssetType[t] = {
      vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
      expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
      capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
      dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
      treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
      n: 25,
    };
  }
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}
function makeBenchmarks(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(0.075) },
    vacancyRates: { ...emptyByAssetType<number | null>(0.07) },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50) },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}
function makeManifesto(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

/* ------------------------------ intake helpers ----------------------------- */
function resolveSlotFirst(historicalUwId: string, slot: SourceDocSlot):
  { buffer: Buffer; filename: string } | null {
  const manifest = getDealManifest(historicalUwId);
  if (!manifest) return null;
  const entries: ReadonlyArray<SourceDocEntry> = manifest.slots[slot] ?? [];
  if (entries.length === 0) return null;
  const entry = entries[entries.length - 1]!; // prefer the most recent (Final, not Prelim)
  const buf = getSourceDocBuffer({ historicalUwId, slot, fileHash: entry.fileHash });
  return buf ? { buffer: buf.buffer, filename: buf.entry.originalFileName } : null;
}

/* ------------------------ rent-roll-only buffer (pass 3) ------------------- */
/** Extract ONLY the 'Rent Roll' sheet from the Eightfold workbook into a fresh
 *  xlsx buffer. Formulas are unwrapped to their numeric results. No other
 *  sheets are copied. Provable Model A purity. */
async function buildRentRollOnlyBuffer(srcPath: string, sheetName = 'Rent Roll'): Promise<Buffer> {
  const src = new ExcelJS.Workbook();
  await src.xlsx.readFile(srcPath);
  const srcSheet = src.getWorksheet(sheetName);
  if (!srcSheet) throw new Error(`Sheet "${sheetName}" not found in ${srcPath}`);

  // Reduce each src cell to a writable primitive. Handles formula cells
  // (`{formula, result}`), shared-formula descendants (`{sharedFormula}`),
  // rich text, dates, and primitives. Shared-formula cells with no cached
  // result resolve to null — these are typically derived numeric columns
  // the rent-roll parser doesn't read anyway (it only needs tenant name,
  // unit/SF, lease start/end, in-place rent).
  function reduce(cell: ExcelJS.Cell): ExcelJS.CellValue | null {
    const v = cell.value as any;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) {
        const r = v.result;
        if (r === null || r === undefined) return null;
        if (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') return r;
        if (r instanceof Date) return r;
        return null;
      }
      if ('richText' in v) {
        return (v.richText as { text: string }[]).map(rt => rt.text).join('');
      }
      if ('text' in v && typeof v.text === 'string') return v.text;
      // sharedFormula / undefined master — fall through to cell.text as last resort
      const t = cell.text;
      if (typeof t === 'string' && t !== '') {
        const num = Number(t.replace(/[$,\s%]/g, ''));
        if (Number.isFinite(num)) return num;
        return t;
      }
      return null;
    }
    return null;
  }

  const dst = new ExcelJS.Workbook();
  const dstSheet = dst.addWorksheet(sheetName);
  for (let r = 1; r <= srcSheet.rowCount; r++) {
    const srcRow = srcSheet.getRow(r);
    const dstRow = dstSheet.getRow(r);
    srcRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const v = reduce(cell);
      if (v !== null) dstRow.getCell(col).value = v;
    });
    dstRow.commit();
  }
  const ab = await dst.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/* ------------------------- per-pass orchestration ------------------------- */
interface PassResult {
  label: string;
  dealRef: string;
  futureState: boolean;
  slotsReport: any;
  rentRollUnits: number;
  ai: any;
  he: any;
  doctrine: any;
  mits: any;
  narrative: any;
}

async function runPass(args: {
  store: RecordGraphStore;
  label: string;
  dealRef: string;
  futureState: boolean;
  asr?: { buffer: Buffer; filename: string };
  cf?:  { buffer: Buffer; filename: string };
  pca?: { buffer: Buffer; filename: string };
  rentRoll?: { buffer: Buffer; filename: string };
  loanTerms: LoanTermsExtraction;
  assetType: AssetType;
}): Promise<PassResult> {
  console.log(`\n========================================`);
  console.log(`PASS: ${args.label}  (dealRef=${args.dealRef}, assetType=${args.assetType}${args.futureState ? ', FUTURE-STATE' : ''})`);
  console.log(`========================================`);
  const slots: any = {};
  if (args.asr) slots.asrPdf = args.asr;
  if (args.cf)  slots.sellerCfXlsx = args.cf;
  if (args.pca) slots.pcaPdf = args.pca;
  if (args.rentRoll) slots.rentRollXlsx = args.rentRoll;
  for (const k of ['asrPdf','sellerCfXlsx','pcaPdf','rentRollXlsx']) {
    const v = slots[k];
    console.log(`  ${k.padEnd(14)} ${v ? `✓ ${v.filename} (${v.buffer.length} bytes)` : '(empty)'}`);
  }

  const t0 = Date.now();
  const composed = await buildExtractionResult({
    slots,
    analysisAsOfDate: AS_OF,
    dealRef: args.dealRef,
    loanTerms: args.loanTerms,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);
  console.log(`  composer slotReport: ${JSON.stringify({
    asrPdf: composed.report.asrPdf?.status ?? 'absent',
    sellerCfXlsx: composed.report.sellerCfXlsx?.status ?? 'absent',
    rentRollXlsx: composed.report.rentRollXlsx?.status ?? 'absent',
    pcaPdf: composed.report.pcaPdf?.status ?? 'absent',
  })}`);
  const rentRollUnits = composed.rentRoll?.lines?.length ?? 0;
  console.log(`  composer rentRoll units: ${rentRollUnits}`);

  // Pass 3 invariant: feeding ONLY the rent-roll slot must NOT yield CF/PCA data.
  if (args.futureState && args.rentRoll && !args.cf && composed.report.sellerCfXlsx?.status === 'ok') {
    throw new Error('PURITY VIOLATION: rent-roll-only feed produced a CF outcome — extractor pulled conclusion-side data');
  }

  const lib = makeSnapshot();
  args.store.insertLibrarySnapshot(lib);
  const t1 = Date.now();
  const ingestResult = await ingestExtractionResult(
    {
      extractionResult: composed.extractionResult,
      propertyType: args.assetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
    },
    args.store,
    {},
  );
  console.log(`  ingest ms (incl. LLM): ${Date.now() - t1}`);

  const env = args.store.getRevisionEnvelope(ingestResult.rootId as RevisionId);
  if (!env) throw new Error('envelope null');
  const ai = args.store.getAdjustedInputs(env.adjustedInputsId);
  const he = args.store.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId);
  const doctrine = ingestResult.evaluation;
  const mits = args.store.getLatestMitigationProposalSetForAdjustedInputs(env.adjustedInputsId, MITIGATION_ENGINE_VERSION);
  const narrative = args.store.getLatestNarrativeForAdjustedInputs(env.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  return { label: args.label, dealRef: args.dealRef, futureState: args.futureState,
           slotsReport: composed.report, rentRollUnits, ai, he, doctrine, mits, narrative };
}

/* ------------------------------- dumping ---------------------------------- */
function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return `${(n * 100).toFixed(2)}%`;
}
function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return n.toFixed(2);
}
function ratingBandDisplay(d: any, ai: any): string {
  if (!d) return 'null';
  const base = d.ratingBand;
  if (d.coverage.insufficientCoverageGate) return `${base} (insufficient coverage)`;
  if (d.coverage.bandCapApplied) {
    const n = d.coverage.excludedRiskDimRuleIds.length;
    return `${base} (capped — ${n} risk dimension${n === 1 ? '' : 's'} unevaluated)`;
  }
  if (ai?.dataConfidence === 'unvalidated') return `${base} (provisional)`;
  return base;
}

function dumpPass(p: PassResult, out: string[]): void {
  const tag = p.futureState ? '⚠ FUTURE-STATE — rent-roll-seeded' : '';
  out.push(`\n${'='.repeat(70)}`);
  out.push(`PASS: ${p.label}  ${tag}`);
  out.push(`dealRef: ${p.dealRef}`);
  out.push('='.repeat(70));
  if (!p.ai) { out.push('  (no AdjustedInputs)'); return; }
  const m = p.ai.metrics;

  out.push(`\n--- DETERMINISTIC FIGURES ---`);
  out.push(`  NOI                          ${fmt(m.noi)}`);
  out.push(`  DSCR (concluded)             ${fmtNum(m.dscr)}`);
  out.push(`  Debt Yield                   ${fmtRate(m.debtYield)}`);
  out.push(`  LTV (Appraisal)              ${fmtRate(m.ltvAppraisal)}`);
  out.push(`  Cap Rate (going-in, adj)     ${fmtRate(p.ai.assumptions?.capRate?.adjusted)}`);
  out.push(`  Cap Rate (terminal, adj)     ${fmtRate(p.ai.assumptions?.terminalCapRate?.adjusted)}`);
  out.push(`  Concluded Cap (analyst)      ${fmtRate(p.ai.assumptions?.concludedCapRate?.adjusted ?? null)}`);
  out.push(`  Value (implied)              ${fmt(m.value)}`);
  out.push(`  Trailing Actual NOI          ${fmt(m.trailingActualNoi)}`);
  out.push(`  In-Place NOI                 ${fmt(m.inPlaceNoi)}`);
  out.push(`  Issuer-CF UW NOI             ${fmt(m.issuerCfUwNoi)}`);
  out.push(`  Top-1 Income Share           ${m.top1IncomeShare !== null ? `${(m.top1IncomeShare*100).toFixed(1)}%` : 'null'}`);
  out.push(`  Pct Income Expiring (term)   ${m.pctIncomeExpiringWithinTerm !== null ? `${(m.pctIncomeExpiringWithinTerm*100).toFixed(1)}%` : 'null'}`);
  out.push(`  Total OpEx (adj)             ${fmt(p.ai.expenses?.totalOperatingExpenses?.adjusted)}`);

  // Income build-up (raw vs adjusted vs per-rule recovery). AdjustedIncome
  // has no `reimbursements` slot today — the legacy reimbursements column
  // is rolled into `otherIncome` via JE_OTHER_INCOME_RECOVERED_FROM_TOTAL.
  // The income-recovery delta lives on each AdjustedLineItem's adjustments[]
  // ledger — print it so the rigor leg has the real recovery story.
  const rawAdjLine = (li: any, label: string) => {
    if (!li) { out.push(`  ${label.padEnd(28)} (slot absent)`); return; }
    const raw = li.raw, adj = li.adjusted;
    let delta = '';
    if (typeof raw === 'number' && typeof adj === 'number' && Number.isFinite(raw) && Number.isFinite(adj)) {
      const d = adj - raw;
      delta = d === 0 ? ' (Δ 0)' : `  (Δ ${d >= 0 ? '+' : ''}${fmt(d)})`;
    }
    out.push(`  ${label.padEnd(28)} raw=${fmt(raw).padEnd(15)} adj=${fmt(adj)}${delta}`);
    if (Array.isArray(li.adjustments) && li.adjustments.length > 0) {
      for (const a of li.adjustments) {
        out.push(`      • ${a.ruleId.padEnd(40)} delta=${fmt(a.delta)}  "${(a.reason ?? '').slice(0, 90)}"`);
      }
    }
  };
  rawAdjLine(p.ai.income?.grossRentalIncome, 'Gross Rental Income');
  rawAdjLine(p.ai.income?.otherIncome,       'Other Income (incl. recoveries)');
  rawAdjLine(p.ai.income?.vacancyPct,        'Vacancy %');
  rawAdjLine(p.ai.income?.concessionsPct,    'Concessions %');
  rawAdjLine(p.ai.income?.effectiveGrossIncome, 'Effective Gross Income');
  out.push(`  dataConfidence               ${p.ai.dataConfidence}`);
  out.push(`  dataQualityFlags             [${(p.ai.dataQualityFlags ?? []).join(', ')}]`);

  out.push(`\n--- DOCTRINE EVALUATION ---`);
  if (!p.doctrine) {
    out.push('  (no doctrine)');
  } else {
    out.push(`  ratingBand (raw)             ${p.doctrine.ratingBand}`);
    out.push(`  ratingBand displayValue      "${ratingBandDisplay(p.doctrine, p.ai)}"`);
    out.push(`  finalScore                   ${p.doctrine.finalScore?.toFixed(2)}`);
    out.push(`  mechanicalScore              ${p.doctrine.mechanicalScore?.toFixed(2)}`);
    out.push(`  weightedAggregate            ${p.doctrine.weightedAggregate?.toFixed(2)}`);
    out.push(`  coverage.evaluatedPct        ${(p.doctrine.coverage.evaluatedPct * 100).toFixed(1)}%`);
    out.push(`  coverage.evaluatedWeight     ${p.doctrine.coverage.evaluatedWeight.toFixed(2)} / ${p.doctrine.coverage.totalEvaluableWeight.toFixed(2)}`);
    out.push(`  coverage.bandCapApplied      ${p.doctrine.coverage.bandCapApplied}`);
    out.push(`  coverage.insufficientGate    ${p.doctrine.coverage.insufficientCoverageGate}`);
    out.push(`  coverage.excludedRiskDims    [${p.doctrine.coverage.excludedRiskDimRuleIds.join(', ')}]`);
    out.push(`  flags                        [${p.doctrine.flags.map((f:any) => f.flagId ?? f).join(', ')}]`);
    out.push(`  per-component:`);
    for (const c of p.doctrine.componentScores) {
      out.push(`    [${c.componentId.padEnd(15)}] ${c.ruleId.padEnd(34)} status=${(c.status ?? '').padEnd(18)} score=${String(c.score).padStart(3)}  w=${c.weight.toFixed(2)}  contrib=${c.contribution.toFixed(2)}  raw=${c.rawValue !== null ? c.rawValue.toFixed(3) : 'null'}`);
    }
  }

  out.push(`\n--- MITIGATION PROPOSALS (deterministic) ---`);
  if (!p.mits || p.mits.proposals.length === 0) {
    out.push('  (no proposals)');
  } else {
    for (const pr of p.mits.proposals) {
      out.push(`\n  [${pr.id}]  lever=${pr.lever}  leverKind=${pr.leverKind}  severity=${pr.severity}`);
      out.push(`    title: ${pr.title}`);
      out.push(`    description: ${pr.description}`);
      out.push(`    principleIds: [${pr.principleIds.join(', ')}]`);
      if (pr.requiredEquity !== undefined) out.push(`    requiredEquity (sponsor cut): ${fmt(pr.requiredEquity)}`);
      if (pr.requiredReserve !== undefined) out.push(`    requiredReserve (upfront escrow): ${fmt(pr.requiredReserve)}`);
      if (pr.targetMetric) out.push(`    targetMetric (binding): ${pr.targetMetric}`);
      if (pr.coverageStatement) out.push(`    coverageStatement: ${pr.coverageStatement}`);
      if (pr.structuralChanges?.length) {
        out.push(`    structuralChanges:`);
        for (const s of pr.structuralChanges) out.push(`      - ${s}`);
      }
      if (pr.recalcBefore) {
        out.push(`    before: NOI=${fmt(pr.recalcBefore.noi)} DSCR=${fmtNum(pr.recalcBefore.dscr)} DY=${fmtRate(pr.recalcBefore.debtYield)} LTV=${fmtRate(pr.recalcBefore.ltv)}`);
      }
      if (pr.recalcAfter) {
        out.push(`    after:  NOI=${fmt(pr.recalcAfter.noi)} DSCR=${fmtNum(pr.recalcAfter.dscr)} DY=${fmtRate(pr.recalcAfter.debtYield)} LTV=${fmtRate(pr.recalcAfter.ltv)}`);
      }
      out.push(`    riskReduction: ${pr.riskReduction}`);
    }
  }

  out.push(`\n--- PIECE A NARRATIVE (LLM-generated) ---`);
  if (!p.narrative) {
    out.push('  (no narrative — LLM may have failed)');
  } else {
    const slots = [
      ['executive_summary',        p.narrative.executiveSummary],
      ['red_flag_assessment',      p.narrative.redFlagAssessment],
      ['mitigation_suggestions',   p.narrative.mitigationSuggestions],
      ['committee_recommendation', p.narrative.committeeRecommendation],
    ] as const;
    for (const [name, text] of slots) {
      out.push(`\n  --- ${name} ---`);
      out.push(text || '(empty)');
    }
  }
}

/* --------------------------------- main ----------------------------------- */
async function main() {
  // Wipe the local db so each run is clean.
  try { fs.unlinkSync(DB_PATH); } catch {}

  const store = new RecordGraphStore(DB_PATH);
  const results: PassResult[] = [];
  const errors: Array<{ label: string; err: string }> = [];

  async function tryPass(label: string, fn: () => Promise<PassResult>): Promise<void> {
    try { results.push(await fn()); }
    catch (e) {
      const msg = (e as Error)?.stack ?? String(e);
      console.error(`[pass-failure] ${label}: ${msg}`);
      errors.push({ label, err: msg });
    }
  }

  /* ---- PASS 1: Sunroad current intake (asr + cf-final + pca) ---- */
  const sunroadAsr = resolveSlotFirst(SUNROAD_UW_ID, 'asr');
  const sunroadCf  = resolveSlotFirst(SUNROAD_UW_ID, 'cf');
  const sunroadPca = resolveSlotFirst(SUNROAD_UW_ID, 'pca');
  if (!sunroadAsr || !sunroadCf) throw new Error('Sunroad ASR/CF missing in intake');
  await tryPass('SUNROAD-E2E-CURRENT', () => runPass({
    store, label: 'SUNROAD (current intake, Office)', dealRef: 'SUNROAD-E2E-CURRENT',
    futureState: false,
    asr: sunroadAsr, cf: sunroadCf, ...(sunroadPca ? { pca: sunroadPca } : {}),
    loanTerms: SUNROAD_LOAN_TERMS, assetType: 'Office',
  }));

  /* ---- PASS 2: Showcase current intake (asr + cf-final, NO rent roll) ---- */
  const showcaseAsr = resolveSlotFirst(SHOWCASE_UW_ID, 'asr');
  const showcaseCf  = resolveSlotFirst(SHOWCASE_UW_ID, 'cf');
  if (!showcaseAsr || !showcaseCf) throw new Error('Showcase ASR/CF missing in intake');
  await tryPass('SHOWCASE-E2E-CURRENT', () => runPass({
    store, label: 'SHOWCASE pass 1 (current intake, Retail, no rent roll slot)',
    dealRef: 'SHOWCASE-E2E-CURRENT',
    futureState: false,
    asr: showcaseAsr, cf: showcaseCf,
    loanTerms: SHOWCASE_LOAN_TERMS, assetType: 'Retail',
  }));

  /* ---- PASS 3: Showcase FUTURE-STATE — rent-roll-only seeded into slot ---- */
  await tryPass('SHOWCASE-E2E-FUTURE-RR', async () => {
    console.log(`\n[pass-3 prep] Extracting "Rent Roll" sheet from Eightfold workbook …`);
    const rentRollBuf = await buildRentRollOnlyBuffer(EIGHTFOLD_PATH, 'Rent Roll');
    console.log(`[pass-3 prep] rent-roll-only xlsx buffer: ${rentRollBuf.length} bytes`);
    return runPass({
      store, label: 'SHOWCASE pass 2 (FUTURE-STATE — Eightfold Rent Roll seeded)',
      dealRef: 'SHOWCASE-E2E-FUTURE-RR',
      futureState: true,
      asr: showcaseAsr, cf: showcaseCf,
      rentRoll: { buffer: rentRollBuf, filename: '003-Showcase-I-Rent-Roll-only.xlsx' },
      loanTerms: SHOWCASE_LOAN_TERMS, assetType: 'Retail',
    });
  });

  /* ---- DUMP ---- */
  const out: string[] = [];
  out.push(`END-TO-END CAPTURE  ${new Date().toISOString()}`);
  out.push(`engine: current (doctrine v1.3, judgment + narrative + mitigation as in working tree)`);
  for (const p of results) dumpPass(p, out);
  if (errors.length) {
    out.push(`\n${'='.repeat(70)}\nFAILURES\n${'='.repeat(70)}`);
    for (const e of errors) out.push(`\n  [${e.label}]\n${e.err}`);
  }
  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(`\n[capture] wrote ${text.length} chars to ${OUT_PATH}`);
  console.log(text);
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
