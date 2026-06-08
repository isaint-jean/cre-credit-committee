/**
 * Calibration baseline harness — run buildDoctrineEvaluation across the Eightfold
 * corpus at ~/Downloads/Intelligence/Archive with FAIR (production-realistic)
 * synthesized inputs, against analyst BC/DS loss ground truth.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/calibration-baseline.ts
 *
 * Read-only on the engine; does not commit/push anywhere. Emits CSV to
 * /tmp/calibration-baseline.csv. No LLM, no narrative, no handbook.
 *
 * Scope (state explicitly): measures the DOCTRINE SCORING layer given fair
 * inputs. Validates the aggregation/cap/floor surface the next-stage fix
 * targets — NOT end-to-end extraction/judgment accuracy. Upper bound on
 * doctrine behavior given good extraction.
 *
 * Inputs synthesized (per H2 inventory):
 *   - AdjustedInputs.metrics: loan, NOI, DSCR, DY (read), concluded cap/value,
 *     trailing-12 actual NOI, top1IncomeShare + pctIncomeExpiringWithinTerm
 *     (when rent roll present), vacancy raw, expense ratio, ltvAppraisal=null
 *   - NarrativeFacts: occupancyCurrent, trailingOccAvg, t12NoiTrend,
 *     exitCapRateStressed, asrValue (concluded value), appraisalValue=null,
 *     isMall (from sub-type)
 *   - StressOutputs: synthesized 2-scenario set with worstStressNoi present
 *   - ValuationConclusion: from real buildValuationConclusion
 *
 * Ground truth: Loss Discussion BC/DS row 14.
 *   clean       (BC=0, DS=0)
 *   stress-only (BC=0, DS>0)
 *   loss-bearing (BC>0)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import ExcelJS from 'exceljs';
import {
  ASSET_TYPES,
  type AssetType,
  type AdjustedInputs,
  type AdjustedInputsId,
  type AdjustedLineItem,
  type AdjustmentEntry,
  type AssetProfile,
  type AssetProfileId,
  type ContentHash,
  type CreditManifesto,
  type CrossCheckResult,
  type CrossCheckResultId,
  type DoctrineEvaluation,
  type ExtractionResultId,
  type ISODateTime,
  type LibrarySnapshot,
  type LibrarySnapshotId,
  type MarketBenchmarks,
  type NarrativeFacts,
  type NarrativeFactsId,
  type RentRoll,
  type StressOutputs,
  type StressOutputsId,
  type StressScenarioOutput,
  type ValuationConclusion,
  type ValuationConclusionId,
  JUDGMENT_ENGINE_VERSION,
  STRESS_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  VALUATION_ENGINE_VERSION,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeCreditManifestoId,
  computeCrossCheckResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
  computeNarrativeFactsId,
  computeStressOutputsId,
  computeValuationConclusionId,
} from '../util/content-hash.js';
import { buildDoctrineEvaluation } from '../services/doctrine/build-doctrine-evaluation.js';
import { buildValuationConclusion } from '../services/valuation.service.js';

const CORPUS_DIR = path.join(os.homedir(), 'Downloads', 'Intelligence', 'Archive');
const OUT_CSV = '/tmp/calibration-baseline.csv';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

/* ----------------------- workbook reader (defensive) ---------------------- */

interface DealBag {
  readonly file: string;
  // Ground truth (Loss Discussion row 14: BC col C, DS col D)
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
  // Property & Loan Summary
  readonly loanAmount: number | null;
  readonly termYears: number | null;
  readonly amortMonths: number | null;
  readonly ioYears: number | null;
  readonly coupon: number | null;
  readonly occupancyCurrent: number | null;
  readonly assetType: string | null; // "Retail", "Office", "Multifamily", "Hotel", "SelfStorage", "MHC", "Industrial", "MixedUse", "Other"
  readonly subType: string | null;
  // Operating History — T-12 column NOI/EGI/OpEx + prior period for trend
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly t12VacancyLoss: number | null;
  readonly t12Gpr: number | null;
  readonly priorPeriodNoi: number | null; // 2023 column (B), used for t12NoiTrend
  readonly uwY1Noi: number | null;        // UW Year 1 column
  readonly t12Dscr: number | null;
  readonly t12Dy: number | null;
  // Conclusions
  readonly concludedCap: number | null;
  readonly concludedLtv: number | null;
  readonly concludedValue: number | null;
  readonly pcaImmediateRepairs: number | null;
  readonly upfrontTiLcEscrow: number | null;
  // Rent roll derived
  readonly top1IncomeShare: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // ExcelJS sometimes wraps formula results as { result: number }
  if (typeof v === 'object' && v !== null && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && v !== null && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim() || null;
  }
  return null;
}

function findRowByLabel(ws: ExcelJS.Worksheet, labelRegex: RegExp, startRow = 1, endRow = 80): number | null {
  const last = Math.min(endRow, ws.rowCount);
  for (let r = startRow; r <= last; r++) {
    const row = ws.getRow(r);
    // Labels are in col A (1) or B (2) typically
    for (const col of [1, 2, 3, 4]) {
      const cell = row.getCell(col);
      const s = strOrNull(cell.value);
      if (s !== null && labelRegex.test(s)) return r;
    }
  }
  return null;
}

function readDeal(filePath: string): DealBag | { error: string; file: string } {
  const file = path.basename(filePath);
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
  } catch (e) {
    return { file, error: `init: ${(e as Error).message}` };
  }
  return new Promise<DealBag | { error: string; file: string }>(() => {}) as any; // placeholder; real impl below
}

async function readDealAsync(filePath: string): Promise<DealBag | { error: string; file: string }> {
  const file = path.basename(filePath);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch (e) {
    return { file, error: `xlsx-read: ${(e as Error).message}` };
  }

  const sheets = wb.worksheets.map((w) => w.name);
  const loss = wb.getWorksheet('Loss Discussion');
  const pls  = wb.getWorksheet('Property & Loan Summary');
  const ops  = wb.getWorksheet('Operating History and Pro Forma');
  const ce   = wb.getWorksheet('Conclusions & Escrows');
  const rr   = wb.getWorksheet('Rent Roll');

  // ----- Loss Discussion: row 14, col C (3) BC, col D (4) DS -----
  let bcLoss: number | null = null, dsLoss: number | null = null;
  if (loss) {
    const r14 = loss.getRow(14);
    bcLoss = numOrNull(r14.getCell(3).value);
    dsLoss = numOrNull(r14.getCell(4).value);
  }

  // ----- Property & Loan Summary -----
  let loanAmount: number | null = null, termYears: number | null = null,
      amortMonths: number | null = null, ioYears: number | null = null,
      coupon: number | null = null, occupancyCurrent: number | null = null,
      assetType: string | null = null, subType: string | null = null;
  if (pls) {
    // Layout per probe: D12=loan, D15=term yr (E15=term months), E16=amort months,
    // D17=IO yr (E17=IO months), D18=coupon decimal.
    loanAmount = numOrNull(pls.getCell('D12').value);
    termYears  = numOrNull(pls.getCell('D15').value);
    amortMonths = numOrNull(pls.getCell('E16').value);
    ioYears   = numOrNull(pls.getCell('D17').value);
    coupon    = numOrNull(pls.getCell('D18').value);

    // Asset type label: PLS row 3 col J = "Retail" / "Office" / "Hospitality" / etc.
    // Probed canonical position; label "Property Type / Subtype" is at col G of same row.
    // Fall back to label-matching scan when canonical position misses.
    assetType = strOrNull(pls.getCell('J3').value);
    if (assetType === null) {
      const ptRow = findRowByLabel(pls, /property\s*type\s*\/?\s*sub/i, 1, 10);
      if (ptRow !== null) {
        const row = pls.getRow(ptRow);
        assetType = strOrNull(row.getCell(10).value) ?? strOrNull(row.getCell(8).value) ?? strOrNull(row.getCell(11).value);
      }
    }
    // Sub-type (mall flag): scan row 4 for "Sub-Type" label or fall back to row immediately below.
    subType = strOrNull(pls.getCell('J4').value);
    // Occupancy
    const occRow = findRowByLabel(pls, /occupancy\s*\/?\s*date/i, 1, 10);
    if (occRow !== null) {
      occupancyCurrent = numOrNull(pls.getRow(occRow).getCell(10).value) ??
                         numOrNull(pls.getRow(occRow).getCell(8).value) ??
                         numOrNull(pls.getRow(occRow).getCell(5).value);
    }
  }

  // ----- Operating History — re-enabled with T-12 column detection (H-FIX-2) -----
  // Probed layout: row 3 col 8 = T-12 period label when present; col 12 = Issuer UW; col 14 = In-Place.
  // Cols 2/4/6 are historical years on workbooks that have them.
  let t12Noi: number | null = null;
  let t12Egi: number | null = null;
  let t12OpEx: number | null = null;
  let t12VacancyLoss: number | null = null;
  let t12Gpr: number | null = null;
  let priorPeriodNoi: number | null = null;
  const uwY1Noi: number | null = null;
  const t12Dscr: number | null = null;
  const t12Dy: number | null = null;
  if (ops) {
    // Determine T-12 column: probe r3 col 8 for "T-12"/"TTM"/"Trailing" label.
    const r3 = ops.getRow(3);
    const c8Label = strOrNull(r3.getCell(8).value);
    const t12Col = (c8Label !== null && /T[\-\s]?12|TTM|trailing/i.test(c8Label)) ? 8 : null;
    // Determine prior-period column: scan cols 2, 4, 6 for a 4-digit year label at r3.
    let priorCol: number | null = null;
    for (const c of [6, 4, 2]) {
      const lab = strOrNull(r3.getCell(c).value);
      if (lab !== null && /^20[12]\d/.test(lab)) { priorCol = c; break; }
    }

    if (t12Col !== null) {
      const noiRow = findRowByLabel(ops, /^net\s+operating\s+income\b/i, 30, 50);
      if (noiRow !== null) {
        t12Noi = numOrNull(ops.getRow(noiRow).getCell(t12Col).value);
        if (priorCol !== null) {
          priorPeriodNoi = numOrNull(ops.getRow(noiRow).getCell(priorCol).value);
        }
      }
      const egiRow = findRowByLabel(ops, /^effective\s+gross\s+(income|revenue)\b/i, 1, 30);
      if (egiRow !== null) {
        t12Egi = numOrNull(ops.getRow(egiRow).getCell(t12Col).value);
      }
      const opexRow = findRowByLabel(ops, /^total\s+operating\s+expenses\b/i, 30, 50);
      if (opexRow !== null) {
        t12OpEx = numOrNull(ops.getRow(opexRow).getCell(t12Col).value);
      }
      const vacRow = findRowByLabel(ops, /^(total\s+)?vacancy(\s*[\/&+]\s*credit)?(\s*loss)?\b/i, 1, 50);
      if (vacRow !== null) {
        t12VacancyLoss = numOrNull(ops.getRow(vacRow).getCell(t12Col).value);
      }
      const gprRow = findRowByLabel(ops, /^gross\s+potential\s+rent\b|^gross\s+rent(al)?\s+(revenue|income)\b/i, 1, 30);
      if (gprRow !== null) {
        t12Gpr = numOrNull(ops.getRow(gprRow).getCell(t12Col).value);
      }
    }
  }

  // ----- Conclusions -----
  let concludedCap: number | null = null, concludedLtv: number | null = null,
      concludedValue: number | null = null, pcaImmediateRepairs: number | null = null,
      upfrontTiLcEscrow: number | null = null;
  if (ce) {
    // Showcase pattern: "Eightfold Concluded Cap Rate / LTV:" at row 9, cap=I9, LTV=J9
    const capRow = findRowByLabel(ce, /eightfold\s+concluded\s+cap/i, 1, 30) ?? 9;
    const r = ce.getRow(capRow);
    concludedCap = numOrNull(r.getCell(9).value); // I9
    concludedLtv = numOrNull(r.getCell(10).value); // J9
    const valRow = findRowByLabel(ce, /eightfold\s+concluded\s+value/i, 1, 30) ?? 7;
    concludedValue = numOrNull(ce.getRow(valRow).getCell(9).value);

    // Escrows: row by label
    const irRow = findRowByLabel(ce, /immediate\s+repairs/i, 45, 60);
    if (irRow !== null) {
      // up-front in col D (4) per Showcase escrow layout
      pcaImmediateRepairs = numOrNull(ce.getRow(irRow).getCell(4).value);
    }
    const tilcRow = findRowByLabel(ce, /general\s+ti\s*\/?\s*lc/i, 45, 60);
    if (tilcRow !== null) {
      upfrontTiLcEscrow = numOrNull(ce.getRow(tilcRow).getCell(4).value);
    }
  }

  // ----- Rent Roll — SKIPPED (slow on large rolls + portfolio mega-files; null mirrors
  //       production for deals without a rent roll. The risk-dim scorers will sink — that's
  //       what the baseline measures).
  const top1IncomeShare: number | null = null;
  const pctIncomeExpiringWithinTerm: number | null = null;
  void rr;

  return {
    file, bcLoss, dsLoss,
    loanAmount, termYears, amortMonths, ioYears, coupon, occupancyCurrent, assetType, subType,
    t12Noi, t12Egi, t12OpEx, t12VacancyLoss, t12Gpr, priorPeriodNoi, uwY1Noi,
    t12Dscr, t12Dy,
    concludedCap, concludedLtv, concludedValue, pcaImmediateRepairs, upfrontTiLcEscrow,
    top1IncomeShare, pctIncomeExpiringWithinTerm,
  };
}

/* ------------------------ synthesizers ------------------------------------ */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeLibrarySnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  const base = { dscr: { median: 1.30, p25: 1.20, p75: 1.40 }, treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 }, n: 25 };
  byAssetType.Multifamily = { vacancy:{median:0.05,p25:0.03,p75:0.07}, expenseRatio:{median:0.40,p25:0.35,p75:0.45}, capRate:{median:0.055,p25:0.05,p75:0.06}, ...base };
  byAssetType.Office      = { vacancy:{median:0.10,p25:0.07,p75:0.13}, expenseRatio:{median:0.30,p25:0.25,p75:0.35}, capRate:{median:0.075,p25:0.07,p75:0.08}, ...base };
  byAssetType.Retail      = { vacancy:{median:0.06,p25:0.04,p75:0.08}, expenseRatio:{median:0.25,p25:0.20,p75:0.30}, capRate:{median:0.070,p25:0.065,p75:0.075}, ...base };
  byAssetType.Hotel       = { vacancy:{median:0.30,p25:0.25,p75:0.40}, expenseRatio:{median:0.65,p25:0.60,p75:0.70}, capRate:{median:0.085,p25:0.08,p75:0.09}, ...base };
  byAssetType.Industrial  = { vacancy:{median:0.05,p25:0.03,p75:0.08}, expenseRatio:{median:0.22,p25:0.18,p75:0.27}, capRate:{median:0.065,p25:0.06,p75:0.07}, ...base };
  byAssetType.SelfStorage = { vacancy:{median:0.10,p25:0.08,p75:0.13}, expenseRatio:{median:0.35,p25:0.30,p75:0.40}, capRate:{median:0.065,p25:0.06,p75:0.07}, ...base };
  byAssetType.MHC         = { vacancy:{median:0.05,p25:0.03,p75:0.07}, expenseRatio:{median:0.30,p25:0.25,p75:0.35}, capRate:{median:0.060,p25:0.055,p75:0.065}, ...base };
  byAssetType.MixedUse    = { vacancy:{median:0.08,p25:0.05,p75:0.11}, expenseRatio:{median:0.30,p25:0.25,p75:0.35}, capRate:{median:0.070,p25:0.065,p75:0.075}, ...base };
  byAssetType.Other       = { vacancy:{median:0.10,p25:0.07,p75:0.15}, expenseRatio:{median:0.30,p25:0.25,p75:0.35}, capRate:{median:0.075,p25:0.07,p75:0.08}, ...base };
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeMarketBenchmarks(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates:     { ...emptyByAssetType<number | null>(null), Office: 0.075, Retail: 0.070, Multifamily: 0.055, Hotel: 0.085, Industrial: 0.065, SelfStorage: 0.065, MHC: 0.060, MixedUse: 0.070, Other: 0.075 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Office: 0.10, Retail: 0.06, Multifamily: 0.05, Hotel: 0.30, Industrial: 0.05, SelfStorage: 0.10, MHC: 0.05, MixedUse: 0.08, Other: 0.10 },
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

function mkLI(raw: number | null, adjusted: number, source: 'T12_ACTUAL' | 'MANUAL' | 'IN_PLACE' | 'SELLER_UW' | 'BANK' | 'RENT_ROLL' | 'PCA' = 'MANUAL', adjs: AdjustmentEntry[] = []): AdjustedLineItem {
  return { raw, adjusted, source, adjustments: adjs };
}
function naLI(): AdjustedLineItem { return { raw: null, adjusted: 0, source: 'MANUAL', adjustments: [] }; }

function mapAssetType(label: string | null, subType: string | null): AssetType {
  if (label === null) return 'Other';
  const s = (label + ' ' + (subType ?? '')).toLowerCase();
  if (/multifamily|apartment/.test(s)) return 'Multifamily';
  if (/office/.test(s)) return 'Office';
  if (/retail|mall|shopping/.test(s)) return 'Retail';
  if (/hotel|lodging|hospitality/.test(s)) return 'Hotel';
  if (/industrial|warehouse|distribution|logistic/.test(s)) return 'Industrial';
  if (/storage|self[-\s]?stor/.test(s)) return 'SelfStorage';
  if (/manufactured|mhc|mobile\s+home/.test(s)) return 'MHC';
  if (/mixed/.test(s)) return 'MixedUse';
  return 'Other';
}

function isMall(subType: string | null): boolean | null {
  if (subType === null) return null;
  return /mall|lifestyle\s+center|regional\s+center/i.test(subType);
}

function deriveT12NoiTrend(t12: number | null, prior: number | null): 'up' | 'flat' | 'down' | null {
  if (t12 === null || prior === null || prior <= 0) return null;
  const delta = (t12 - prior) / prior;
  if (delta >= 0.02) return 'up';
  if (delta <= -0.02) return 'down';
  return 'flat';
}

function synthesizeAdjustedInputs(d: DealBag): AdjustedInputs | null {
  // Require: loanAmount, concludedCap, term, coupon, concludedLtv OR concludedValue (NOI derived).
  const loan = d.loanAmount ?? null;
  const cap  = d.concludedCap ?? null;
  const term = d.termYears !== null ? d.termYears * 12 : null;
  const interestRate = d.coupon ?? null;
  // NOI cascade: uwY1 → t12 → derive from concluded value × cap → derive from loan/LTV × cap.
  let noi = d.uwY1Noi ?? d.t12Noi ?? null;
  if (noi === null && d.concludedValue !== null && cap !== null) {
    noi = d.concludedValue * cap;
  }
  if (noi === null && loan !== null && d.concludedLtv !== null && d.concludedLtv > 0 && cap !== null) {
    noi = (loan / d.concludedLtv) * cap;
  }
  if (loan === null || noi === null || cap === null || term === null || interestRate === null) {
    return null;
  }

  // Annualized debt service (IO if amort=0, else amortizing — calibration uses the T-12 DSCR
  // when available; otherwise compute IO).
  const ds = (d.amortMonths !== null && d.amortMonths > 0)
    ? amortizingDS(loan, interestRate, d.amortMonths)
    : loan * interestRate;
  const dscr = d.t12Dscr ?? (ds > 0 ? noi / ds : null);
  const debtYield = d.t12Dy ?? (loan > 0 ? noi / loan : null);
  const value = cap > 0 ? noi / cap : null;
  const vacancyRaw = (d.t12Gpr !== null && d.t12VacancyLoss !== null && d.t12Gpr > 0)
    ? Math.abs(d.t12VacancyLoss) / d.t12Gpr : null;
  const expenseRatio = (d.t12Egi !== null && d.t12OpEx !== null && d.t12Egi > 0)
    ? d.t12OpEx / d.t12Egi : null;

  const body: Omit<AdjustedInputs, 'id'> = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: 'placeholder' as LibrarySnapshotId,

    income: {
      grossRentalIncome:  mkLI(d.t12Gpr ?? null, d.t12Gpr ?? 0, 'T12_ACTUAL'),
      otherIncome:        naLI(),
      vacancyPct:         mkLI(vacancyRaw, vacancyRaw ?? 0.06, 'T12_ACTUAL'),
      concessionsPct:     naLI(),
      effectiveGrossIncome: mkLI(d.t12Egi ?? null, d.t12Egi ?? 0, 'T12_ACTUAL'),
    },
    expenses: {
      realEstateTaxes: naLI(), insurance: naLI(), utilities: naLI(),
      managementFee:   naLI(), payroll:   naLI(), maintenance: naLI(),
      other: naLI(), generalAndAdmin: naLI(), janitorial: naLI(),
      reimbursements:  naLI(),
      totalOperatingExpenses: mkLI(d.t12OpEx ?? null, d.t12OpEx ?? 0, 'T12_ACTUAL'),
    },
    capitalReserves: {
      upfrontCapex:               mkLI(null, d.pcaImmediateRepairs ?? 0, 'MANUAL'),
      upfrontReplacementReserves: naLI(),
      upfrontTiLc:                mkLI(null, d.upfrontTiLcEscrow ?? 0, 'MANUAL'),
      monthlyCapex:               naLI(),
      monthlyTiLc:                naLI(),
      monthlyReplacementReserves: naLI(),
      monthlyTenantImprovements:  naLI(),
      monthlyLeasingCommissions:  naLI(),
      pcaImmediateRepairs:        mkLI(d.pcaImmediateRepairs, d.pcaImmediateRepairs ?? 0, 'PCA'),
      capexScheduleInflated:      [],
      capexScheduleUninflated:    [],
    },
    loan: {
      loanAmount:        mkLI(loan, loan, 'BANK'),
      interestRate:      mkLI(interestRate, interestRate, 'BANK'),
      termMonths:        mkLI(term, term, 'BANK'),
      amortizationMonths: mkLI(d.amortMonths, d.amortMonths ?? 0, 'BANK'),
      ioPeriodMonths:    mkLI(d.ioYears !== null ? d.ioYears * 12 : null, (d.ioYears ?? 0) * 12, 'BANK'),
      maturityBalance:   mkLI(null, loan, 'BANK'),  // IO assumption; conservative
      maturityDate:      null,
      debtServiceAnnual: mkLI(ds, ds, 'BANK'),
    },
    assumptions: {
      capRate:         mkLI(cap, cap, 'MANUAL'),
      terminalCapRate: mkLI(null, cap + 0.005, 'MANUAL'),
      concludedCapRate: null,
      rentGrowthPct:   naLI(),
      expenseGrowthPct: naLI(),
    },
    metrics: {
      noi,
      value,
      dscr,
      ltvAppraisal: null,    // explicit sink (mirrors production)
      debtYield,
      expenseRatio,
      top1IncomeShare:           d.top1IncomeShare ?? null,
      pctIncomeExpiringWithinTerm: d.pctIncomeExpiringWithinTerm ?? null,
      trailingActualNoi: d.t12Noi ?? null,
      issuerCfUwNoi: null,
      inPlaceNoi: null,
      issuerStatedNoiSellerUw: null,
      issuerStatedNoiAsr: null,
    },
    dataConfidence: 'validated',
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: [
      'JE_APPRAISAL_MISSING',
      ...(d.top1IncomeShare === null ? ['JE_RENT_ROLL_MISSING' as const] : []),
      ...(d.pcaImmediateRepairs === null ? ['JE_PCA_MISSING' as const] : []),
    ] as any,
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function amortizingDS(loan: number, rate: number, amortMonths: number): number {
  if (amortMonths <= 0 || rate <= 0) return loan * rate;
  const m = rate / 12;
  const monthly = loan * (m * Math.pow(1 + m, amortMonths)) / (Math.pow(1 + m, amortMonths) - 1);
  return monthly * 12;
}

function synthesizeNarrativeFacts(d: DealBag, ai: AdjustedInputs): NarrativeFacts {
  const trend = deriveT12NoiTrend(d.t12Noi, d.priorPeriodNoi);
  const body: Omit<NarrativeFacts, 'id'> = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: d.occupancyCurrent,
    occupancyCurrent: d.occupancyCurrent,
    propertyClass: null,
    shadowVacancyFlag: null,
    subleaseCompetition: null,
    leasingVelocityDataAvailable: null,
    isMall: isMall(d.subType),
    franchiseExpirationWithinTerm: null,
    pipRequired: null,
    pipBudgetPerKey: null,
    privateWastewater: null,
    parkOwnedHomesPct: null,
    t12NoiTrend: trend,
    isSingleTenant: null,
    appraisalValue: null,           // intentional — mirrors production
    appraisalCapRate: null,
    asrValue: d.concludedValue,     // use concluded value as ASR proxy
    marketValueFromComps: null,
    exitCapRateBase: d.concludedCap !== null ? d.concludedCap + 0.005 : null,
    exitCapRateStressed: d.concludedCap !== null ? d.concludedCap + 0.010 : null,
  };
  return { id: computeNarrativeFactsId(body) as NarrativeFactsId, ...body } as NarrativeFacts;
}

function synthesizeStressOutputs(ai: AdjustedInputs): StressOutputs {
  // Two-scenario stress: -10% NOI; -20% NOI. Compute value/dscr/ltv/debtYield from each.
  const noi = ai.metrics.noi ?? 0;
  const ds  = ai.loan.debtServiceAnnual.adjusted;
  const loan = ai.loan.loanAmount.adjusted;
  const cap = ai.assumptions.capRate.adjusted;
  const scenarios: StressScenarioOutput[] = [-0.10, -0.20].map((d) => {
    const stressedNoi = noi * (1 + d);
    const stressedValue = cap > 0 ? stressedNoi / cap : null;
    return {
      name: `NOI_${(d * 100).toFixed(0)}pct`,
      noi: stressedNoi,
      dscr: ds > 0 ? stressedNoi / ds : null,
      value: stressedValue,
      ltv: stressedValue !== null && stressedValue > 0 ? loan / stressedValue : null,
      debtYield: loan > 0 ? stressedNoi / loan : null,
      breaches: [],
      skipped: [],
    };
  });
  const body = {
    analysisAsOfDate: AS_OF,
    adjustedInputsId: ai.id,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    method: 'DEFAULT' as const,
    scenarios,
  };
  return { id: computeStressOutputsId(body) as StressOutputsId, ...body } as StressOutputs;
}

function emptyCrossCheck(aiId: AdjustedInputsId): CrossCheckResult {
  const body = { analysisAsOfDate: AS_OF, adjustedInputsId: aiId, findings: [], overallAdjustmentBias: 'neutral' as const };
  return { id: computeCrossCheckResultId(body) as CrossCheckResultId, ...body } as CrossCheckResult;
}

function mkAssetProfile(type: AssetType): AssetProfile {
  return {
    id: 'apf-baseline' as AssetProfileId,
    propertyType: type,
    businessPlan: 'Stabilized',
    marketLiquidity: 'Primary',
  };
}

/* ----------------------------- ground-truth band -------------------------- */

type AnalystClass = 'clean' | 'stress-only' | 'loss-bearing' | 'unknown';

function classifyAnalyst(bc: number | null, ds: number | null): AnalystClass {
  if (!isNum(bc) || !isNum(ds)) return 'unknown';
  if (bc > 0) return 'loss-bearing';
  if (ds > 0) return 'stress-only';
  return 'clean';
}

function expectedBandSet(c: AnalystClass): readonly string[] {
  switch (c) {
    case 'clean':        return ['Strong', 'Acceptable'];
    case 'stress-only':  return ['Acceptable', 'Weak'];
    case 'loss-bearing': return ['Weak', 'High Risk'];
    default: return [];
  }
}

/* ------------------------------ run --------------------------------------- */

interface Row {
  file: string;
  assetType: AssetType;
  analystClass: AnalystClass;
  bcLoss: number | null;
  dsLoss: number | null;
  engineBand: string;
  finalScore: number;
  mechScore: number;
  sinkingRuleIds: string[];
  evaluatedPctApprox: number;
  // v1.1 coverage (commit 2): real engine coverage struct
  coverageEvaluatedPct: number;
  bandCapApplied: boolean;
  gateFired: boolean;
  excludedRiskDimsCount: number;
}

async function readDealWithTimeout(filePath: string, ms = 30_000): Promise<DealBag | { file: string; error: string }> {
  const file = path.basename(filePath);
  return await Promise.race([
    readDealAsync(filePath),
    new Promise<{ file: string; error: string }>((resolve) =>
      setTimeout(() => resolve({ file, error: `timeout-${ms}ms` }), ms)
    ),
  ]);
}

async function main(): Promise<void> {
  const sanityMode = process.argv.includes('--sanity');
  const SANITY_TARGETS = new Set([
    '003. Showcase I.xlsm',
    '001- Sunroad Centrum - OK TO PRINT JN.xlsm',
    '002- Cortland West Champions - JK with sites.xlsx',
  ]);

  // H-FIX-3: portfolio carve-out. Skip aggregate workbooks that ExcelJS's
  // sync xlsx.readFile blocks on (the Promise.race timeout doesn't yield on
  // CPU-bound sync work). Conservative dual filter: filename "Portfolio" OR
  // file size > 25 MB.
  const PORTFOLIO_NAME_RE = /portfolio/i;
  const SIZE_THRESHOLD_BYTES = 25 * 1024 * 1024;
  const allFiles = fs.readdirSync(CORPUS_DIR).filter((f) => /\.(xlsm|xlsx)$/i.test(f));
  const carvedOut: { file: string; reason: string; sizeMB: number }[] = [];
  const filesAllowed: string[] = [];
  for (const f of allFiles.sort()) {
    if (sanityMode && !SANITY_TARGETS.has(f)) continue;
    const fp = path.join(CORPUS_DIR, f);
    const sz = fs.statSync(fp).size;
    const sizeMB = sz / (1024 * 1024);
    if (PORTFOLIO_NAME_RE.test(f)) {
      carvedOut.push({ file: f, reason: 'name-matches-portfolio', sizeMB });
      continue;
    }
    if (sz > SIZE_THRESHOLD_BYTES) {
      carvedOut.push({ file: f, reason: 'oversized-25MB', sizeMB });
      continue;
    }
    filesAllowed.push(fp);
  }
  const files = filesAllowed;
  console.log(`[harness] CORPUS_DIR=${CORPUS_DIR}  files=${files.length}  (carved out ${carvedOut.length}: ${sanityMode ? 'SANITY MODE' : 'portfolios + oversized'})`);
  if (sanityMode) {
    console.log(`[harness] SANITY MODE — only ${files.length} target deals`);
  }

  // Incremental CSV write so progress survives any subsequent crash/hang.
  const csvHeader = 'file,assetType,analystClass,bcLoss,dsLoss,engineBand,finalScore,mechScore,evaluatedPctApprox,coverageEvaluatedPct,bandCapApplied,gateFired,excludedRiskDimsCount,sinkingRuleIds';
  fs.writeFileSync(OUT_CSV, csvHeader + '\n');
  console.log(`[harness] writing CSV incrementally to ${OUT_CSV}`);

  const rows: Row[] = [];
  const errors: { file: string; reason: string }[] = [];
  const skips: { file: string; reason: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    if (i % 10 === 0) console.log(`[harness] processing ${i}/${files.length} ...`);
    const filePath = files[i]!;
    const file = path.basename(filePath);
    let bag: DealBag | { file: string; error: string };
    try {
      bag = await readDealWithTimeout(filePath, 30_000);
    } catch (e) {
      errors.push({ file, reason: `read-throw: ${(e as Error).message}` });
      continue;
    }
    if ('error' in bag) { errors.push({ file, reason: bag.error }); continue; }

    const analystClass = classifyAnalyst(bag.bcLoss, bag.dsLoss);
    if (analystClass === 'unknown') {
      skips.push({ file, reason: 'no BC/DS' });
      continue;
    }

    const assetType = mapAssetType(bag.assetType, bag.subType);
    const ai = synthesizeAdjustedInputs(bag);
    if (ai === null) {
      skips.push({ file, reason: 'missing core fields (loan/NOI/cap/term/coupon)' });
      continue;
    }

    const nf = synthesizeNarrativeFacts(bag, ai);
    const so = synthesizeStressOutputs(ai);

    let val: ValuationConclusion;
    try {
      val = buildValuationConclusion({ adjustedInputs: ai, stressOutputs: so, narrativeFacts: nf });
    } catch (e) {
      errors.push({ file, reason: `valuation: ${(e as Error).message}` });
      continue;
    }

    const cc = emptyCrossCheck(ai.id);
    const library = makeLibrarySnapshot();
    const profile = mkAssetProfile(assetType);

    let de: DoctrineEvaluation;
    try {
      de = buildDoctrineEvaluation({
        adjustedInputs: ai,
        assetProfile: profile,
        librarySnapshot: library,
        narrativeFacts: nf,
        crossCheckResult: cc,
        stressOutputs: so,
        valuationConclusion: val,
        extractionResultId: 'placeholder' as ExtractionResultId,
        rentRoll: null,
      });
    } catch (e) {
      errors.push({ file, reason: `doctrine: ${(e as Error).message}` });
      continue;
    }

    const sinking = de.componentScores
      .filter((cs) => cs.reasonCodes.includes('INSUFFICIENT_DATA' as never))
      .map((cs) => cs.ruleId);

    // evaluatedPctApprox: 1 - (sum of weights of sinking rules) / (sum of weights of all rules)
    // Note: this is the per-component-rule weight × score relation (weight = component weight),
    // so multiple rules in the same component share the component weight equally.
    const totalContribWeight = de.componentScores.reduce((s, cs) => s + cs.weight, 0);
    const sinkingContribWeight = de.componentScores
      .filter((cs) => cs.reasonCodes.includes('INSUFFICIENT_DATA' as never))
      .reduce((s, cs) => s + cs.weight, 0);
    const evaluatedPctApprox = totalContribWeight > 0 ? 1 - sinkingContribWeight / totalContribWeight : 0;

    if (sanityMode) {
      console.log(`\n[sanity] ${file}`);
      console.log(`  raw asset label: ${JSON.stringify(bag.assetType)}  → mapped: ${assetType}`);
      console.log(`  loan=${bag.loanAmount}  cap=${bag.concludedCap}  value=${bag.concludedValue}  noi(adj)=${ai.metrics.noi}`);
      console.log(`  t12Noi=${bag.t12Noi}  t12OpEx=${bag.t12OpEx}  vacancyLoss=${bag.t12VacancyLoss}  priorNoi=${bag.priorPeriodNoi}`);
      console.log(`  BC=${bag.bcLoss}  DS=${bag.dsLoss}  analystClass=${analystClass}`);
      console.log(`  engine: band=${de.ratingBand}  finalScore=${de.finalScore.toFixed(2)}  evaluatedPct=${(evaluatedPctApprox * 100).toFixed(1)}%`);
      console.log(`  per-component status (v1.1 commit 1):`);
      for (const cs of de.componentScores) {
        const tag = (cs as { status?: string }).status ?? '(no status?)';
        console.log(`    ${cs.componentId.padEnd(16)} ${cs.ruleId.padEnd(32)} ${tag.padEnd(18)} score=${cs.score.toFixed(0).padStart(3)} contrib=${cs.contribution.toFixed(2).padStart(6)}`);
      }
    }

    const cov = (de as { coverage?: { evaluatedPct: number; bandCapApplied: boolean; insufficientCoverageGate: boolean; excludedRiskDimRuleIds: readonly string[] } }).coverage;
    const row: Row = {
      file,
      assetType,
      analystClass,
      bcLoss: bag.bcLoss,
      dsLoss: bag.dsLoss,
      engineBand: de.ratingBand,
      finalScore: de.finalScore,
      mechScore: de.mechanicalScore,
      sinkingRuleIds: sinking,
      evaluatedPctApprox,
      coverageEvaluatedPct: cov?.evaluatedPct ?? 0,
      bandCapApplied: cov?.bandCapApplied ?? false,
      gateFired: cov?.insufficientCoverageGate ?? false,
      excludedRiskDimsCount: cov?.excludedRiskDimRuleIds.length ?? 0,
    };
    rows.push(row);

    // Append row immediately to CSV so progress survives any crash/hang.
    const csvLine = [
      JSON.stringify(row.file),
      row.assetType,
      row.analystClass,
      row.bcLoss ?? '',
      row.dsLoss ?? '',
      row.engineBand,
      row.finalScore.toFixed(2),
      row.mechScore.toFixed(2),
      row.evaluatedPctApprox.toFixed(3),
      row.coverageEvaluatedPct.toFixed(3),
      row.bandCapApplied ? '1' : '0',
      row.gateFired ? '1' : '0',
      row.excludedRiskDimsCount.toString(),
      JSON.stringify(row.sinkingRuleIds.join('|')),
    ].join(',');
    fs.appendFileSync(OUT_CSV, csvLine + '\n');
  }

  console.log(`\n[harness] CSV complete: ${OUT_CSV}  rows=${rows.length}`);

  /* ------------------------ metrics ---------------------------------------- */

  console.log('\n=== (1) Band distribution ===');
  const dist: Record<string, number> = {};
  for (const r of rows) dist[r.engineBand] = (dist[r.engineBand] ?? 0) + 1;
  for (const band of ['Strong', 'Acceptable', 'Weak', 'High Risk']) {
    const n = dist[band] ?? 0;
    console.log(`  ${band.padEnd(11)} ${n.toString().padStart(4)} (${(n*100/Math.max(1,rows.length)).toFixed(1)}%)`);
  }

  console.log('\n=== (2) Band-agreement % (engine band in expected range for analyst class) ===');
  const byClass: Record<AnalystClass, { in: number; out: number; total: number }> = {
    'clean': { in: 0, out: 0, total: 0 },
    'stress-only': { in: 0, out: 0, total: 0 },
    'loss-bearing': { in: 0, out: 0, total: 0 },
    'unknown': { in: 0, out: 0, total: 0 },
  };
  for (const r of rows) {
    const expected = expectedBandSet(r.analystClass);
    byClass[r.analystClass].total++;
    if (expected.includes(r.engineBand)) byClass[r.analystClass].in++; else byClass[r.analystClass].out++;
  }
  for (const c of ['clean', 'stress-only', 'loss-bearing'] as AnalystClass[]) {
    const x = byClass[c];
    const pct = x.total > 0 ? (x.in * 100 / x.total) : 0;
    console.log(`  ${c.padEnd(13)} n=${x.total.toString().padStart(3)}  in-band ${x.in.toString().padStart(3)}  out ${x.out.toString().padStart(3)}  agreement=${pct.toFixed(1)}%`);
  }
  const overallIn = Object.values(byClass).reduce((s, x) => s + x.in, 0);
  const overallTotal = Object.values(byClass).reduce((s, x) => s + x.total, 0);
  console.log(`  OVERALL n=${overallTotal}  in-band ${overallIn}  agreement=${(overallIn*100/Math.max(1,overallTotal)).toFixed(1)}%`);

  console.log('\n=== (3) Over-crediting guard — stress-only deals the engine rates Strong (PRIMARY) ===');
  const strongOnStress = rows.filter(r => r.analystClass === 'stress-only' && r.engineBand === 'Strong');
  const totalStress = rows.filter(r => r.analystClass === 'stress-only').length;
  console.log(`  stress-only rated Strong: ${strongOnStress.length} of ${totalStress}`);
  for (const r of strongOnStress.slice(0, 10)) console.log(`    ${r.file}  finalScore=${r.finalScore.toFixed(2)}`);
  // Loss-bearing (directional, n small)
  const strongOnLoss = rows.filter(r => r.analystClass === 'loss-bearing' && (r.engineBand === 'Strong' || r.engineBand === 'Acceptable'));
  const totalLoss = rows.filter(r => r.analystClass === 'loss-bearing').length;
  console.log(`\n  loss-bearing rated Strong or Acceptable (low-n directional): ${strongOnLoss.length} of ${totalLoss}`);
  for (const r of strongOnLoss) console.log(`    ${r.file}  band=${r.engineBand}  finalScore=${r.finalScore.toFixed(2)}`);

  console.log('\n=== (4) Per-component sink frequency (% of deals where rule attaches INSUFFICIENT_DATA) ===');
  const sinkCount: Record<string, number> = {};
  for (const r of rows) for (const rid of r.sinkingRuleIds) sinkCount[rid] = (sinkCount[rid] ?? 0) + 1;
  const sorted = Object.entries(sinkCount).sort((a,b) => b[1] - a[1]);
  for (const [rid, n] of sorted) {
    console.log(`  ${rid.padEnd(40)} ${n.toString().padStart(4)} / ${rows.length} (${(n*100/rows.length).toFixed(1)}%)`);
  }

  console.log('\n=== Coverage diagnostics ===');
  const avgEval = rows.reduce((s,r)=>s+r.evaluatedPctApprox,0) / Math.max(1,rows.length);
  console.log(`  mean evaluatedPctApprox (harness-side): ${(avgEval*100).toFixed(1)}%`);
  const avgCovEng = rows.reduce((s,r)=>s+r.coverageEvaluatedPct,0) / Math.max(1,rows.length);
  console.log(`  mean coverage.evaluatedPct (engine):    ${(avgCovEng*100).toFixed(1)}%`);
  const capCount = rows.filter(r => r.bandCapApplied).length;
  const gateCount = rows.filter(r => r.gateFired).length;
  console.log(`  bandCapApplied:                         ${capCount}/${rows.length} (${(100*capCount/rows.length).toFixed(1)}%)`);
  console.log(`  insufficientCoverageGate fired:         ${gateCount}/${rows.length} (${(100*gateCount/rows.length).toFixed(1)}%)`);

  console.log('\n=== Run summary ===');
  console.log(`  total files in corpus: ${allFiles.length}`);
  console.log(`  carved out:           ${carvedOut.length}`);
  if (carvedOut.length > 0) {
    console.log('  carve-out list:');
    for (const c of carvedOut) console.log(`    ${c.file}  (${c.reason}, ${c.sizeMB.toFixed(1)} MB)`);
  }
  console.log(`  files attempted:      ${files.length}`);
  console.log(`  rows produced:        ${rows.length}`);
  console.log(`  skips:                ${skips.length}`);
  console.log(`  errors:               ${errors.length}`);
  if (errors.length > 0) {
    console.log('\n  first 10 errors:');
    for (const e of errors.slice(0, 10)) console.log(`    ${e.file} → ${e.reason}`);
  }
  if (skips.length > 0) {
    console.log('\n  skip breakdown:');
    const byReason: Record<string, number> = {};
    for (const s of skips) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    for (const [r, n] of Object.entries(byReason)) console.log(`    ${r}: ${n}`);
  }
}

main().catch((e) => { console.error('harness threw:', e); process.exit(2); });

// Silence the unused-suppression complaint for the placeholder helper.
void readDeal;
