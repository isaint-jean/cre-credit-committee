/**
 * Phase 15 — One-deal ingest loop on Sunroad.
 *
 *   cd apps/api && npx tsx src/scripts/phase15-ingest-loop-sunroad.ts
 *
 * Writes to data/phase15-sunroad-ingest-loop.db (separate from production cre.db).
 *
 * Structure (per the 2026-06-04 brief):
 *   Run A — PRELIM CF (plumbing control): reproduces phase14's hardcoded
 *           constants on identical input. Pass criterion: engine NOI within
 *           a tight ±$1000 band of phase14's $8,518,524 etc. If it diverges,
 *           STOP — the new intake→engine path introduced a plumbing bug.
 *   Run B — FINAL CF (Model-A validation): different input vintage; diff
 *           against the analyst's OK-TO-PRINT concluded cells with the
 *           production ±5% $ / ±50bps rate bands and a DIRECTION flag.
 *
 * Both runs read source docs from the intake store at
 *   .data/source-docs/<historicalUwId>/<slot>/<fileHash>.<ext>
 * Same engine code, same fixtures (library, benchmarks, manifesto), same
 * loan terms (the corrected $82.46M / 7.9% / IO-only / 60mo / 2031-05-31).
 * The only thing that changes between runs is which CF blob is fed.
 *
 * Reports per run:
 *   - The 4-slot input map (which intake files reached the engine)
 *   - Intermediate extraction values (raw NOI/EGI/expense/reserve lines
 *     the engine read out of the CF, plus inPlace + sellerUw columns for
 *     cross-check — load-bearing for disentangling plumbing-bug from
 *     vintage-drift from judgment-gap)
 *   - Engine concluded values
 *   - The diff (vs phase14 baseline for Run A; vs answer-key cells for Run B)
 *
 * Plus a PRELIM-vs-FINAL line-by-line diff at the end.
 */
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import ExcelJS from 'exceljs';

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
const DB_PATH = path.join(REPO, 'apps/api/data/phase15-sunroad-ingest-loop.db');
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const SUNROAD_UW_ID = '3327fd55-e382-4286-8378-64d33a11e518';
const ANSWER_KEY_PATH = '/Users/isabellesaint-jean/Downloads/Intelligence/Archive/001- Sunroad Centrum - OK TO PRINT JN.xlsm';

// CF blob hashes for the two vintages in the intake (verified via the
// pre-flight manifest dump).
const CF_PRELIM_HASH = 'c6e6286bb8934dc8'; // prefix match
const CF_FINAL_HASH  = '4926a5a8de029551'; // prefix match

// Corrected loan terms — $82.46M / 7.9% IO-only / 60mo / 2031-05-31 (the
// phase12+ standard, after the loan-terms fix landed in commit 1532e74).
const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

// Phase14's hardcoded baseline (from phase14-validation-gate.ts POST_FIX_EXPECTED).
// Run A's pass criterion: engine output reproduces these within a tight band.
const PHASE14_BASELINE = {
  noi:                          8_518_524,
  annualDebtService:            6_514_340,
  dscrLow:                      1.25,
  dscrHigh:                     1.40,
  debtYield:                    0.1033,
  taxes:                        960_500,
  totalOperatingExpenses:       3_650_796,
  monthlyReplacementReservesLow:  4_400,
  monthlyReplacementReservesHigh: 4_700,
  vacancyPct:                   0.10,
};

// Tolerance bands.
const PLUMB_TOL_DOLLARS = 2_000;    // ±$2,000 — engine is deterministic; allow tiny rounding
const PLUMB_TOL_RATE    = 0.001;     // ±10 bps
const DIFF_BAND_PCT     = 0.05;      // ±5% on $ values
const DIFF_BAND_BPS     = 0.005;     // ±50 bps on rates

/* ----------------------- shared fixtures (mirror phase14) ------------------- */
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

/** No phase8-style manual comps in this loop — we want the engine's bare
 *  reading of what's on disk, not analyst-supplied augments. */
const NO_COMPS: ManualInputs | undefined = undefined;

/* ----------------------------- intake helpers ------------------------------ */

/** Engine-side slot names (the keys `buildExtractionResult` expects). */
interface EngineSlots {
  asrPdf?:       { buffer: Buffer; filename: string };
  sellerCfXlsx?: { buffer: Buffer; filename: string };
  rentRollXlsx?: { buffer: Buffer; filename: string };
  pcaPdf?:       { buffer: Buffer; filename: string };
}

/** Resolve a slot's first entry whose fileHash starts with `hashPrefix`.
 *  Returns null if no entry matches. */
function resolveSlotByHashPrefix(
  historicalUwId: string,
  slot: SourceDocSlot,
  hashPrefix: string,
): { buffer: Buffer; filename: string } | null {
  const manifest = getDealManifest(historicalUwId);
  if (!manifest) return null;
  const entries: ReadonlyArray<SourceDocEntry> = manifest.slots[slot] ?? [];
  const entry = entries.find((e) => e.fileHash.startsWith(hashPrefix));
  if (!entry) return null;
  const buf = getSourceDocBuffer({ historicalUwId, slot, fileHash: entry.fileHash });
  if (!buf) return null;
  return { buffer: buf.buffer, filename: buf.entry.originalFileName };
}

/** Resolve a slot's first entry (any). */
function resolveSlotFirst(
  historicalUwId: string,
  slot: SourceDocSlot,
): { buffer: Buffer; filename: string } | null {
  const manifest = getDealManifest(historicalUwId);
  if (!manifest) return null;
  const entries: ReadonlyArray<SourceDocEntry> = manifest.slots[slot] ?? [];
  if (entries.length === 0) return null;
  const entry = entries[0]!;
  const buf = getSourceDocBuffer({ historicalUwId, slot, fileHash: entry.fileHash });
  if (!buf) return null;
  return { buffer: buf.buffer, filename: buf.entry.originalFileName };
}

function reportSlots(label: string, slots: EngineSlots): void {
  console.log(`\n[${label}] Engine InputSlots (from intake):`);
  const rows: Array<[string, { buffer: Buffer; filename: string } | undefined]> = [
    ['asrPdf',       slots.asrPdf],
    ['sellerCfXlsx', slots.sellerCfXlsx],
    ['rentRollXlsx', slots.rentRollXlsx],
    ['pcaPdf',       slots.pcaPdf],
  ];
  for (const [k, v] of rows) {
    if (v) console.log(`  ${k.padEnd(14)} ✓  ${v.filename} (${v.buffer.length} bytes)`);
    else   console.log(`  ${k.padEnd(14)} (empty — engine will fire missing-input flags as appropriate)`);
  }
}

/* ------------------------- intermediate extraction dump -------------------- */

function dumpIntermediates(label: string, er: any): void {
  console.log(`\n[${label}] Intermediate extraction (raw lines read off CF — load-bearing for plumbing-isolation):`);

  const writeCol = (colName: string, col: any) => {
    if (col === null || col === undefined) {
      console.log(`  ${colName}: null (column absent)`);
      return;
    }
    const inc = col.income ?? {};
    const exp = col.expenses ?? {};
    const bni = col.belowNoiAdjustments ?? {};
    console.log(`  ${colName}: period="${col.period ?? ''}"`);
    console.log(`    income:    GPR=${fmt(inc.grossPotentialRent)}  totalIncome=${fmt(inc.totalIncome)}  otherIncome=${fmt(inc.otherIncome)}`);
    console.log(`    vacancyLoss=${fmt(col.vacancyLoss)}`);
    console.log(`    expenses:  taxes=${fmt(exp.taxes)}  ins=${fmt(exp.insurance)}  util=${fmt(exp.utilities)}  R&M=${fmt(exp.repairsMaintenance)}  mgmt=${fmt(exp.managementFees)}  G&A=${fmt(exp.generalAndAdmin)}  jan=${fmt(exp.janitorial)}  reimb=${fmt(exp.reimbursements)}`);
    console.log(`    totalOpEx=${fmt(exp.totalOperatingExpenses)}  NOI=${fmt(col.noi)}`);
    console.log(`    belowNOI: replReserves=${fmt(bni.replacementReserves)}  TI=${fmt(bni.tenantImprovements)}  LC=${fmt(bni.leasingCommissions)}`);
  };

  // The class-(a) period-classification fix (commit e335598) split CF readout
  // into THREE columns. Dump all three so we can see which the engine got.
  writeCol('t12Actual            ', er.t12Actual);
  writeCol('inPlace              ', er.inPlace);
  writeCol('sellerUwOperatingStmt', er.sellerUwOperatingStatement);

  const rr = er.rentRoll;
  if (rr && rr.units) {
    console.log(`  rentRoll: ${rr.units.length} units, ${rr.summary?.occupiedUnits ?? '?'} occupied`);
  } else {
    console.log(`  rentRoll: null (neither rent_roll slot nor ASR fallback produced a roll)`);
  }
  const pca = er.pca;
  if (pca) {
    console.log(`  pca: immediateRepairs=${fmt(pca.immediateRepairs)}  shortTerm=${fmt(pca.shortTermRepairs)}  evalYears=${pca.evaluationPeriodYears}  capexSched=${pca.capexScheduleInflated ? `${pca.capexScheduleInflated.length}yr` : 'null'}`);
  } else {
    console.log(`  pca: null`);
  }
}

/* ------------------------- engine concluded values ------------------------ */

interface EngineConcluded {
  noi: number | null;
  annualDebtService: number | null;
  dscr: number | null;
  debtYield: number | null;
  ltvAppraisal: number | null;
  value: number | null;
  capRate: number | null;            // adjusted assumption.capRate
  expenseRatio: number | null;
  vacancyPct: number | null;
  totalOperatingExpenses: number | null;
  realEstateTaxes: number | null;
  monthlyReplacementReserves: number | null;
  monthlyTI: number | null;
  monthlyLC: number | null;
  trailingActualNoi: number | null;
  issuerCfUwNoi: number | null;
  inPlaceNoi: number | null;
  dataQualityFlags: ReadonlyArray<string>;
}

function dumpEngineConcluded(label: string, c: EngineConcluded): void {
  console.log(`\n[${label}] Engine concluded values:`);
  console.log(`  NOI:                        ${fmt(c.noi)}`);
  console.log(`  Annual Debt Service:        ${fmt(c.annualDebtService)}`);
  console.log(`  DSCR:                       ${fmtPct(c.dscr, 2)}`);
  console.log(`  Debt Yield:                 ${fmtPctRate(c.debtYield)}`);
  console.log(`  LTV (Appraisal):            ${fmtPctRate(c.ltvAppraisal)}`);
  console.log(`  Value:                      ${fmt(c.value)}`);
  console.log(`  Cap Rate (assumption.adj):  ${fmtPctRate(c.capRate)}`);
  console.log(`  Expense Ratio:              ${fmtPctRate(c.expenseRatio)}`);
  console.log(`  Vacancy %:                  ${fmtPctRate(c.vacancyPct)}`);
  console.log(`  Total OpEx (adj):           ${fmt(c.totalOperatingExpenses)}`);
  console.log(`  Real Estate Taxes (adj):    ${fmt(c.realEstateTaxes)}`);
  console.log(`  Replacement Reserves /mo:   ${fmt(c.monthlyReplacementReserves)}`);
  console.log(`  TI / LC (monthly):          ${fmt(c.monthlyTI)} / ${fmt(c.monthlyLC)}`);
  console.log(`  trailingActualNoi (class-b):${fmt(c.trailingActualNoi)}`);
  console.log(`  issuerCfUwNoi:              ${fmt(c.issuerCfUwNoi)}`);
  console.log(`  inPlaceNoi:                 ${fmt(c.inPlaceNoi)}`);
  console.log(`  dataQualityFlags:           [${c.dataQualityFlags.join(', ')}]`);
}

function extractEngineConcluded(ai: any): EngineConcluded {
  const li = (x: any) => (x && typeof x.adjusted === 'number' ? x.adjusted : null);
  return {
    noi:                        ai.metrics?.noi ?? null,
    annualDebtService:          li(ai.loan?.debtServiceAnnual),
    dscr:                       ai.metrics?.dscr ?? null,
    debtYield:                  ai.metrics?.debtYield ?? null,
    ltvAppraisal:               ai.metrics?.ltvAppraisal ?? null,
    value:                      ai.metrics?.value ?? null,
    capRate:                    li(ai.assumptions?.capRate),
    expenseRatio:               ai.metrics?.expenseRatio ?? null,
    vacancyPct:                 li(ai.income?.vacancyPct),
    totalOperatingExpenses:     li(ai.expenses?.totalOperatingExpenses),
    realEstateTaxes:            li(ai.expenses?.realEstateTaxes),
    monthlyReplacementReserves: li(ai.capitalReserves?.monthlyReplacementReserves),
    monthlyTI:                  li(ai.capitalReserves?.monthlyTenantImprovements),
    monthlyLC:                  li(ai.capitalReserves?.monthlyLeasingCommissions),
    trailingActualNoi:          ai.metrics?.trailingActualNoi ?? null,
    issuerCfUwNoi:              ai.metrics?.issuerCfUwNoi ?? null,
    inPlaceNoi:                 ai.metrics?.inPlaceNoi ?? null,
    dataQualityFlags:           ai.dataQualityFlags ?? [],
  };
}

/* ----------------------------- run one cycle ------------------------------ */

async function runIngest(
  store: RecordGraphStore,
  label: string,
  slots: EngineSlots,
): Promise<{ extractionResult: any; adjustedInputs: any; he: HandbookEvaluation; engineMs: number }> {
  console.log(`\n--- ${label}: composer + ingest`);
  const t0 = Date.now();
  const composed = await buildExtractionResult({
    slots: slots as any,
    analysisAsOfDate: AS_OF,
    dealRef: `SUNROAD-PHASE15-${label}`,
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);

  const t1 = Date.now();
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
    NO_COMPS !== undefined ? { manualInputs: NO_COMPS } : {},
  );
  console.log(`  ingest ms: ${Date.now() - t1}`);
  const envelope = store.getRevisionEnvelope(ingestResult.rootId as RevisionId);
  if (!envelope) throw new Error('envelope null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (!he) throw new Error('HE null');
  const adjustedInputs = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (!adjustedInputs) throw new Error('AdjustedInputs null');
  return {
    extractionResult: composed.extractionResult,
    adjustedInputs,
    he,
    engineMs: Date.now() - t0,
  };
}

/* ----------------------------- diff helpers ------------------------------- */

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '       null';
  if (Number.isFinite(n)) {
    return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return String(n);
}
function fmtPct(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined) return '   null';
  return n.toFixed(dp);
}
function fmtPctRate(n: number | null | undefined): string {
  if (n === null || n === undefined) return '   null';
  return `${(n * 100).toFixed(2)}%`;
}

function diffDollars(actual: number | null, expected: number, tol: number, label: string): string {
  if (actual === null) return `  ⚠ ${label.padEnd(40)} actual=null  expected≈${fmt(expected)}  → MISSING`;
  const delta = actual - expected;
  const within = Math.abs(delta) <= tol;
  const dir = delta > 0 ? '↑ (higher)' : delta < 0 ? '↓ (lower)' : '=';
  const verdict = within ? '✓ match' : `✗ DIVERGE (Δ=${fmt(Math.abs(delta))} ${dir})`;
  return `  ${verdict.padEnd(40)} ${label.padEnd(34)} actual=${fmt(actual)}  expected=${fmt(expected)}  Δ=${fmt(delta)}`;
}
function diffRate(actual: number | null, expected: number, tol: number, label: string): string {
  if (actual === null) return `  ⚠ ${label.padEnd(40)} actual=null  expected≈${fmtPctRate(expected)}  → MISSING`;
  const delta = actual - expected;
  const within = Math.abs(delta) <= tol;
  const dir = delta > 0 ? '↑ (higher)' : delta < 0 ? '↓ (lower)' : '=';
  const verdict = within ? '✓ match' : `✗ DIVERGE (Δ=${(Math.abs(delta) * 100).toFixed(2)}pp ${dir})`;
  return `  ${verdict.padEnd(40)} ${label.padEnd(34)} actual=${fmtPctRate(actual)}  expected=${fmtPctRate(expected)}  Δ=${(delta * 100).toFixed(2)}pp`;
}
function diffBand(actual: number | null, low: number, high: number, label: string): string {
  if (actual === null) return `  ⚠ ${label.padEnd(40)} actual=null  expected∈[${fmt(low)}..${fmt(high)}]`;
  const within = actual >= low && actual <= high;
  return `  ${within ? '✓ match' : '✗ DIVERGE'.padEnd(40)} ${label.padEnd(34)} actual=${fmt(actual)}  band=[${fmt(low)}..${fmt(high)}]`;
}
function diffBandRate(actual: number | null, low: number, high: number, label: string): string {
  if (actual === null) return `  ⚠ ${label.padEnd(40)} actual=null  expected∈[${fmtPctRate(low)}..${fmtPctRate(high)}]`;
  const within = actual >= low && actual <= high;
  return `  ${within ? '✓ match' : '✗ DIVERGE'.padEnd(40)} ${label.padEnd(34)} actual=${fmtPctRate(actual)}  band=[${fmtPctRate(low)}..${fmtPctRate(high)}]`;
}

/* ------------------------------ answer key -------------------------------- */

interface AnswerKey {
  concludedNoi: number | null;
  concludedNcf: number | null;
  debtService: number | null;
  concludedDscr: number | null;
  concludedDebtYield: number | null;
  concludedCapRate: number | null;
  concludedValue: number | null;
  ltv: number | null;
  // cross-reference (not diffed; for context)
  t12Noi: number | null;
  issuerUwNoi: number | null;
  inPlaceNoi: number | null;
}

function readNum(cell: ExcelJS.Cell): number | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if ('result' in v && typeof (v as any).result === 'number') return (v as any).result;
  }
  return null;
}
async function readAnswerKey(workbookPath: string): Promise<AnswerKey> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(workbookPath) as never);
  const ops = wb.getWorksheet('Operating History and Pro Forma')!;
  const conc = wb.getWorksheet('Conclusions & Escrows')!;
  return {
    concludedNoi:        readNum(ops.getCell(35, 16)),   // P35
    concludedNcf:        readNum(ops.getCell(44, 16)),   // P44
    debtService:         readNum(ops.getCell(46, 16)),   // P46
    concludedDscr:       readNum(ops.getCell(48, 16)),   // P48
    concludedDebtYield:  readNum(ops.getCell(50, 16)),   // P50
    concludedCapRate:    readNum(conc.getCell('I9')),
    concludedValue:      readNum(conc.getCell('I7')),
    ltv:                 readNum(conc.getCell('J9')),
    t12Noi:              readNum(ops.getCell(35, 8)),    // H35 — cross-ref
    issuerUwNoi:         readNum(ops.getCell(35, 12)),   // L35 — cross-ref
    inPlaceNoi:          readNum(ops.getCell(35, 14)),   // N35 — cross-ref
  };
}

/* --------------------------------- main ----------------------------------- */

(async () => {
  console.log('============================================================');
  console.log('PHASE 15 — Sunroad ingest loop (PRELIM gate → FINAL validation)');
  console.log('============================================================');
  console.log(`historicalUwId: ${SUNROAD_UW_ID}`);
  console.log(`DB:             ${DB_PATH}`);
  console.log(`Answer key:     ${ANSWER_KEY_PATH}`);
  for (const p of [ANSWER_KEY_PATH]) {
    if (!existsSync(p)) { console.error(`FATAL: missing ${p}`); process.exit(1); }
  }

  // Resolve the four engine slots, picking the PRELIM CF first.
  const asrSlot = resolveSlotFirst(SUNROAD_UW_ID, 'asr');
  const pcaSlot = resolveSlotFirst(SUNROAD_UW_ID, 'pca');
  const rrSlot  = resolveSlotFirst(SUNROAD_UW_ID, 'rent_roll');
  const cfPRELIM = resolveSlotByHashPrefix(SUNROAD_UW_ID, 'cf', CF_PRELIM_HASH);
  const cfFINAL  = resolveSlotByHashPrefix(SUNROAD_UW_ID, 'cf', CF_FINAL_HASH);
  if (!asrSlot) { console.error('FATAL: ASR not found in intake'); process.exit(1); }
  if (!pcaSlot) { console.error('FATAL: PCA not found in intake'); process.exit(1); }
  if (!cfPRELIM) { console.error(`FATAL: CF PRELIM not found in intake (hash prefix=${CF_PRELIM_HASH})`); process.exit(1); }
  if (!cfFINAL)  { console.error(`FATAL: CF FINAL not found in intake (hash prefix=${CF_FINAL_HASH})`); process.exit(1); }

  const store = new RecordGraphStore(DB_PATH);

  // -------- RUN A: PRELIM CF (plumbing control) ----------------------------
  console.log('\n============================================================');
  console.log('RUN A — PRELIM CF (plumbing control, must reproduce phase14)');
  console.log('============================================================');
  const slotsA: EngineSlots = {
    asrPdf:       asrSlot,
    sellerCfXlsx: cfPRELIM,
    pcaPdf:       pcaSlot,
    ...(rrSlot ? { rentRollXlsx: rrSlot } : {}),
  };
  reportSlots('RUN A (PRELIM)', slotsA);
  const runA = await runIngest(store, 'mode-A-prelim', slotsA);
  dumpIntermediates('RUN A (PRELIM)', runA.extractionResult);
  const concludedA = extractEngineConcluded(runA.adjustedInputs);
  dumpEngineConcluded('RUN A (PRELIM)', concludedA);

  console.log('\n[RUN A] PLUMBING GATE — engine output vs phase14 baseline:');
  const gateLines = [
    diffDollars(concludedA.noi,                          PHASE14_BASELINE.noi,                          PLUMB_TOL_DOLLARS, 'NOI'),
    diffDollars(concludedA.annualDebtService,            PHASE14_BASELINE.annualDebtService,            PLUMB_TOL_DOLLARS, 'Annual Debt Service'),
    diffBand   (concludedA.dscr,                         PHASE14_BASELINE.dscrLow,  PHASE14_BASELINE.dscrHigh,            'DSCR'),
    diffRate   (concludedA.debtYield,                    PHASE14_BASELINE.debtYield,                    PLUMB_TOL_RATE,    'Debt Yield'),
    diffDollars(concludedA.realEstateTaxes,              PHASE14_BASELINE.taxes,                        PLUMB_TOL_DOLLARS, 'Real Estate Taxes'),
    diffDollars(concludedA.totalOperatingExpenses,       PHASE14_BASELINE.totalOperatingExpenses,       PLUMB_TOL_DOLLARS, 'Total Operating Expenses'),
    diffBand   (concludedA.monthlyReplacementReserves,   PHASE14_BASELINE.monthlyReplacementReservesLow,
                                                         PHASE14_BASELINE.monthlyReplacementReservesHigh,                  'Monthly Replacement Reserves'),
    diffRate   (concludedA.vacancyPct,                   PHASE14_BASELINE.vacancyPct,                   PLUMB_TOL_RATE,    'Vacancy %'),
  ];
  for (const l of gateLines) console.log(l);
  const gateFailures = gateLines.filter((l) => l.includes('✗')).length;
  const gateMissing  = gateLines.filter((l) => l.includes('⚠')).length;
  console.log(`\n[RUN A] Plumbing-gate result: ${gateFailures === 0 && gateMissing === 0 ? 'PASS' : `${gateFailures} divergence(s), ${gateMissing} missing`}`);

  if (gateFailures > 0 || gateMissing > 0) {
    console.log('\n========================================');
    console.log('STOPPING after Run A — plumbing gate did not pass.');
    console.log('A plumbing bug would contaminate Run B (FINAL CF) by the same factor.');
    console.log('Investigate the divergence above before trusting the FINAL diff.');
    console.log('========================================');
    process.exit(2);
  }

  // -------- RUN B: FINAL CF (Model-A validation) ---------------------------
  console.log('\n============================================================');
  console.log('RUN B — FINAL CF (Model-A: engine on closing-time data vs analyst conclusions)');
  console.log('============================================================');
  const slotsB: EngineSlots = {
    asrPdf:       asrSlot,
    sellerCfXlsx: cfFINAL,
    pcaPdf:       pcaSlot,
    ...(rrSlot ? { rentRollXlsx: rrSlot } : {}),
  };
  reportSlots('RUN B (FINAL)', slotsB);
  const runB = await runIngest(store, 'mode-B-final', slotsB);
  dumpIntermediates('RUN B (FINAL)', runB.extractionResult);
  const concludedB = extractEngineConcluded(runB.adjustedInputs);
  dumpEngineConcluded('RUN B (FINAL)', concludedB);

  // Read the analyst's answer-key cells.
  const ak = await readAnswerKey(ANSWER_KEY_PATH);
  console.log('\n[RUN B] Answer-key concluded cells (read from OK-TO-PRINT workbook):');
  console.log(`  OPS!P35 Concluded NOI:      ${fmt(ak.concludedNoi)}`);
  console.log(`  OPS!P44 Concluded NCF:      ${fmt(ak.concludedNcf)}`);
  console.log(`  OPS!P46 Debt Service:       ${fmt(ak.debtService)}`);
  console.log(`  OPS!P48 Concluded DSCR:     ${fmtPct(ak.concludedDscr, 2)}`);
  console.log(`  OPS!P50 Concluded DY:       ${fmtPctRate(ak.concludedDebtYield)}`);
  console.log(`  Conc!I9 Concluded Cap Rate: ${fmtPctRate(ak.concludedCapRate)}`);
  console.log(`  Conc!I7 Concluded Value:    ${fmt(ak.concludedValue)}`);
  console.log(`  Conc!J9 LTV:                ${fmtPctRate(ak.ltv)}`);
  console.log(`  (cross-ref) OPS!H35 T-12 NOI: ${fmt(ak.t12Noi)}    L35 Issuer UW NOI: ${fmt(ak.issuerUwNoi)}    N35 In-Place NOI: ${fmt(ak.inPlaceNoi)}`);

  console.log('\n[RUN B] DIFF — engine concluded vs analyst concluded (±5% $, ±50bps rates; DIRECTION flagged):');
  const diffLines: string[] = [];
  const diffDollarsBand = (a: number | null, e: number | null, label: string) => {
    if (e === null) return `  (skip) ${label}: answer-key absent`;
    if (a === null) return `  ⚠ ${label.padEnd(34)} actual=null  expected=${fmt(e)}  → ENGINE MISSING`;
    const delta = a - e;
    const pct = e !== 0 ? Math.abs(delta) / Math.abs(e) : 0;
    const within = pct <= DIFF_BAND_PCT;
    const dir = delta > 0 ? '↑ (engine HIGHER — DANGEROUS if metric is NOI/value/yield)' :
                delta < 0 ? '↓ (engine LOWER — conservative if metric is NOI/value/yield)' : '=';
    const verdict = within ? '✓ in-band' : '✗ OUT OF BAND';
    return `  ${verdict.padEnd(16)} ${label.padEnd(34)} engine=${fmt(a)}  analyst=${fmt(e)}  Δ=${fmt(delta)} (${(pct * 100).toFixed(1)}%)  ${dir}`;
  };
  const diffRateBand = (a: number | null, e: number | null, label: string, dangerousDir: 'higher' | 'lower') => {
    if (e === null) return `  (skip) ${label}: answer-key absent`;
    if (a === null) return `  ⚠ ${label.padEnd(34)} actual=null  expected=${fmtPctRate(e)}  → ENGINE MISSING`;
    const delta = a - e;
    const within = Math.abs(delta) <= DIFF_BAND_BPS;
    const sign = delta > 0 ? 'HIGHER' : 'LOWER';
    const dangerous = (dangerousDir === 'higher' && delta > 0) || (dangerousDir === 'lower' && delta < 0);
    const dir = delta === 0 ? '=' :
                dangerous   ? `↗ engine ${sign} — DANGEROUS direction (B-piece tool more optimistic than analyst)` :
                              `↘ engine ${sign} — conservative direction`;
    const verdict = within ? '✓ in-band' : '✗ OUT OF BAND';
    return `  ${verdict.padEnd(16)} ${label.padEnd(34)} engine=${fmtPctRate(a)}  analyst=${fmtPctRate(e)}  Δ=${(delta * 100).toFixed(2)}pp  ${dir}`;
  };

  diffLines.push(diffDollarsBand(concludedB.noi,                ak.concludedNoi,        'NOI'));
  diffLines.push(diffDollarsBand(concludedB.annualDebtService,  ak.debtService,         'Annual Debt Service'));
  diffLines.push(diffRateBand   (concludedB.dscr,               ak.concludedDscr,       'DSCR', 'higher'));
  diffLines.push(diffRateBand   (concludedB.debtYield,          ak.concludedDebtYield,  'Debt Yield', 'higher'));
  diffLines.push(diffRateBand   (concludedB.capRate,            ak.concludedCapRate,    'Cap Rate', 'lower'));
  diffLines.push(diffDollarsBand(concludedB.value,              ak.concludedValue,      'Concluded Value'));
  diffLines.push(diffRateBand   (concludedB.ltvAppraisal,       ak.ltv,                 'LTV', 'lower'));
  for (const l of diffLines) console.log(l);

  // -------- PRELIM vs FINAL line comparison --------------------------------
  console.log('\n============================================================');
  console.log('PRELIM vs FINAL — engine output drift attributable to CF vintage');
  console.log('============================================================');
  console.log('  metric                         | PRELIM (A)        | FINAL (B)         | Δ FINAL−PRELIM');
  const drift = (label: string, a: number | null, b: number | null) => {
    const delta = (a !== null && b !== null) ? b - a : null;
    console.log(`  ${label.padEnd(30)} | ${fmt(a).padEnd(17)} | ${fmt(b).padEnd(17)} | ${delta === null ? '       null' : fmt(delta)}`);
  };
  drift('NOI',                            concludedA.noi,                          concludedB.noi);
  drift('Total OpEx',                     concludedA.totalOperatingExpenses,       concludedB.totalOperatingExpenses);
  drift('Real Estate Taxes',              concludedA.realEstateTaxes,              concludedB.realEstateTaxes);
  drift('Annual Debt Service',            concludedA.annualDebtService,            concludedB.annualDebtService);
  drift('Replacement Reserves (mo)',      concludedA.monthlyReplacementReserves,   concludedB.monthlyReplacementReserves);
  drift('inPlaceNoi (cross-ref)',         concludedA.inPlaceNoi,                   concludedB.inPlaceNoi);
  drift('issuerCfUwNoi (cross-ref)',      concludedA.issuerCfUwNoi,                concludedB.issuerCfUwNoi);
  const driftRate = (label: string, a: number | null, b: number | null) => {
    const delta = (a !== null && b !== null) ? b - a : null;
    console.log(`  ${label.padEnd(30)} | ${fmtPctRate(a).padEnd(17)} | ${fmtPctRate(b).padEnd(17)} | ${delta === null ? '       null' : ((delta * 100).toFixed(2) + 'pp')}`);
  };
  driftRate('DSCR (as ratio)',            concludedA.dscr,                         concludedB.dscr);
  driftRate('Debt Yield',                 concludedA.debtYield,                    concludedB.debtYield);
  driftRate('Vacancy %',                  concludedA.vacancyPct,                   concludedB.vacancyPct);

  // -------- DONE -----------------------------------------------------------
  console.log('\n============================================================');
  console.log('DONE — Phase 15 ingest loop complete');
  console.log('============================================================');
})();
