/**
 * Showcase deep-check (Stage 1 discrimination proof).
 *
 * Read-only. Parses Showcase I's Rent Roll tab → top1IncomeShare +
 * pctIncomeExpiringWithinTerm. Runs the full Stage-1 engine TWICE on
 * Showcase:
 *   (A) WITHOUT rent roll — corpus-harness state (n=4 risk dims excluded,
 *       capped to Weak (insufficient coverage)).
 *   (B) WITH rent roll parsed — the 3 tenant-driven dims now score; UW-vs-T12
 *       already scores (Showcase has T-12); n → 0; cap doesn't fire; coverage
 *       clears 50% floor → band reflects Showcase's actual credit.
 *
 * Reports both states side-by-side + full per-component breakdown WITH the
 * rent roll.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/showcase-deep-check.ts
 */

import * as path from 'node:path';
import * as os from 'node:os';
import ExcelJS from 'exceljs';
import {
  ASSET_TYPES, MANIFESTO_CONTRACT_VERSION,
  type AssetType, type ContentHash, type ISODateTime,
  type LibrarySnapshot, type MarketBenchmarks,
  type AdjustedInputs, type AdjustedInputsId,
  type CreditManifesto,
  type CrossCheckResult,
  type CrossCheckResultId,
  type StressOutputs, type StressOutputsId,
  type StressScenarioOutput,
  type AssetProfile, type AssetProfileId,
  type NarrativeFacts, type NarrativeFactsId,
  type ExtractionResultId,
  type AdjustedLineItem,
  type AdjustmentEntry,
  type DoctrineEvaluation,
  JUDGMENT_ENGINE_VERSION, STRESS_ENGINE_VERSION,
} from '@cre/contracts';
import {
  computeAdjustedInputsId, computeCrossCheckResultId,
  computeLibrarySnapshotId, computeMarketBenchmarksId,
  computeCreditManifestoId,
  computeNarrativeFactsId,
  computeStressOutputsId,
} from '../util/content-hash.js';
import { buildDoctrineEvaluation } from '../services/doctrine/build-doctrine-evaluation.js';
import { buildValuationConclusion } from '../services/valuation.service.js';

const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;
const CORPUS = path.join(os.homedir(), 'Downloads', 'Intelligence', 'Archive');
const FILE = '003. Showcase I.xlsm';

/* ----------------------------- workbook reader ----------------------------- */

function safe(v: any, fb: number | null = null): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // ExcelJS formula cells: { result: number, formula: string, sharedFormula?: ... }
  if (typeof v === 'object' && v !== null && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return fb;
}
function strOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && v !== null && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim() || null;
  }
  return null;
}

async function readShowcase() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(CORPUS, FILE));

  const pls = wb.getWorksheet('Property & Loan Summary')!;
  const ce = wb.getWorksheet('Conclusions & Escrows')!;
  const ops = wb.getWorksheet('Operating History and Pro Forma')!;
  const rr = wb.getWorksheet('Rent Roll')!;

  // ---- Core terms ----
  const loan = safe(pls.getCell('D12').value, 100_000_000)!;
  const termYears = safe(pls.getCell('D15').value, 5)!;
  const ioYears = safe(pls.getCell('D17').value, 5)!;
  const coupon = safe(pls.getCell('D18').value, 0.07)!;
  const cap = safe(ce.getCell('I9').value, 0.06)!;
  const ltv = safe(ce.getCell('J9').value, 0.82)!;
  const value = loan / ltv;

  // ---- T-12 NOI from Operating History (col 8 of row 35) ----
  let t12noi: number | null = null;
  const r3c8 = strOrNull(ops.getRow(3).getCell(8).value);
  if (r3c8 !== null && /T[-\s]?12/i.test(r3c8)) {
    t12noi = safe(ops.getRow(35).getCell(8).value);
  }

  // ---- UW Y1 NOI for the engine's metrics.noi ----
  // Use the concluded value × cap as the engine's NOI proxy (matches harness convention)
  const noi = value * cap;

  // ---- Up-front TI/LC + monthly TI/LC from Conclusions tab ----
  // Conclusions escrow columns: 4 = Per Appraisal, 5 = Up Front Deposit,
  // 6 = Monthly Escrow, 7 = Annual Escrow.
  let upfrontTiLc = 0;
  let monthlyTiLc = 0;
  for (let r = 45; r <= 58; r++) {
    const row = ce.getRow(r);
    const label = strOrNull(row.getCell(1).value) ?? strOrNull(row.getCell(2).value);
    if (label === null) continue;
    if (/ti\s*\/?\s*lc|tilc|gap\s*&\s*free|free\s*rent/i.test(label)) {
      const up = safe(row.getCell(5).value, 0);   // Up Front Deposit
      const mon = safe(row.getCell(6).value, 0);  // Monthly Escrow
      if (up !== null) upfrontTiLc += up;
      if (mon !== null) monthlyTiLc += mon;
    }
  }

  // ---- Rent Roll parse ----
  // Find header row (~row 13 per probe), identify the columns for UW Annual Rent + Lease End.
  const headerRowIdx = 13;
  const headerRow = rr.getRow(headerRowIdx);
  let rentCol: number | null = null;
  let leaseEndCol: number | null = null;
  for (let c = 1; c <= 40; c++) {
    const s = strOrNull(headerRow.getCell(c).value);
    if (s === null) continue;
    if (rentCol === null && /uw\s+annual\s+rent|annual\s+rent\b|in[-\s]?place\s+rent/i.test(s)) {
      rentCol = c;
    }
    if (leaseEndCol === null && /lease\s+end|expiration|exp(\s+date)?\b/i.test(s)) {
      leaseEndCol = c;
    }
  }
  // Fallbacks per Showcase probe pattern: rent col M (13), lease end varies — scan column types.
  if (rentCol === null) rentCol = 13;

  interface Unit { rentAnnual: number; leaseEnd: Date | null; tenant: string | null; }
  const units: Unit[] = [];
  const maxRow = Math.min(500, rr.rowCount);
  for (let rowIdx = 14; rowIdx <= maxRow; rowIdx++) {
    const row = rr.getRow(rowIdx);
    const rent = safe(row.getCell(rentCol).value, 0)!;
    if (rent <= 0) continue;
    const tenant = strOrNull(row.getCell(3).value) ?? strOrNull(row.getCell(2).value);
    // Skip aggregate / rollup rows: "Total:", "Subtotal", "Total Top 10", "Grand Total", "Vacant" etc.
    if (tenant !== null && /^(total|subtotal|grand\s*total|sum|average|avg)\b/i.test(tenant)) continue;
    if (tenant === null) continue;
    let leaseEnd: Date | null = null;
    if (leaseEndCol !== null) {
      const v = row.getCell(leaseEndCol).value;
      if (v instanceof Date) leaseEnd = v;
      else if (typeof v === 'number' && v > 30000 && v < 80000) {
        leaseEnd = new Date((v - 25569) * 86400 * 1000);
      }
    }
    units.push({ rentAnnual: rent, leaseEnd, tenant });
  }

  let top1IncomeShare: number | null = null;
  let pctIncomeExpiringWithinTerm: number | null = null;
  if (units.length > 0) {
    const totalRent = units.reduce((s, u) => s + u.rentAnnual, 0);
    const maxRent = Math.max(...units.map((u) => u.rentAnnual));
    top1IncomeShare = totalRent > 0 ? maxRent / totalRent : null;
    const now = new Date(AS_OF).getTime();
    const cutoff = now + termYears * 365.25 * 86400 * 1000;
    let expiring = 0;
    for (const u of units) {
      if (u.leaseEnd === null) continue;
      if (u.leaseEnd.getTime() <= cutoff) expiring += u.rentAnnual;
    }
    pctIncomeExpiringWithinTerm = totalRent > 0 ? expiring / totalRent : null;
  }

  return {
    loan, termMonths: termYears * 12, ioMonths: ioYears * 12, coupon,
    cap, ltv, value, noi, t12noi,
    upfrontTiLc, monthlyTiLc,
    rentRoll: {
      units: units.length,
      totalAnnualRent: units.reduce((s, u) => s + u.rentAnnual, 0),
      top1Tenant: units.length > 0 ? units.reduce((max, u) => u.rentAnnual > max.rentAnnual ? u : max).tenant : null,
      top1IncomeShare, pctIncomeExpiringWithinTerm,
    },
  };
}

/* ----------------------------- env builders ----------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}
function makeLib(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  const base = { dscr: { median: 1.30, p25: 1.20, p75: 1.40 }, treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 }, n: 25 };
  byAssetType.Retail = { vacancy:{median:0.06,p25:0.04,p75:0.08}, expenseRatio:{median:0.25,p25:0.20,p75:0.30}, capRate:{median:0.070,p25:0.065,p75:0.075}, ...base };
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}
function makeBench(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Retail: 0.070 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Retail: 0.06 },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50) },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}
function makeMani(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}
function mkLI(raw: number | null, adj: number, src: any = 'MANUAL', adjs: AdjustmentEntry[] = []): AdjustedLineItem {
  return { raw, adjusted: adj, source: src, adjustments: adjs };
}
function naLI(): AdjustedLineItem { return { raw: null, adjusted: 0, source: 'MANUAL', adjustments: [] }; }

interface ShowcaseBag {
  loan: number; termMonths: number; ioMonths: number; coupon: number;
  cap: number; ltv: number; value: number; noi: number; t12noi: number | null;
  upfrontTiLc: number; monthlyTiLc: number;
  rentRoll: {
    units: number; totalAnnualRent: number; top1Tenant: string | null;
    top1IncomeShare: number | null; pctIncomeExpiringWithinTerm: number | null;
  };
}

function mkAI(bag: ShowcaseBag, withRentRoll: boolean): AdjustedInputs {
  const ds = bag.loan * bag.coupon;
  const top1 = withRentRoll ? bag.rentRoll.top1IncomeShare : null;
  const pctRoll = withRentRoll ? bag.rentRoll.pctIncomeExpiringWithinTerm : null;
  const upfrontTi = withRentRoll ? bag.upfrontTiLc : 0;
  const monthlyTi = withRentRoll ? bag.monthlyTiLc : 0;
  const body: Omit<AdjustedInputs, 'id'> = {
    analysisAsOfDate: AS_OF, judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: 'p'.repeat(64) as any,
    income: { grossRentalIncome:naLI(), otherIncome:naLI(), vacancyPct:naLI(), concessionsPct:naLI(), effectiveGrossIncome:naLI() },
    expenses: { realEstateTaxes:naLI(),insurance:naLI(),utilities:naLI(),managementFee:naLI(),payroll:naLI(),maintenance:naLI(),other:naLI(),generalAndAdmin:naLI(),janitorial:naLI(),reimbursements:naLI(),totalOperatingExpenses:naLI() },
    capitalReserves: {
      upfrontCapex: naLI(),
      upfrontReplacementReserves: naLI(),
      upfrontTiLc: mkLI(null, upfrontTi),
      monthlyCapex: naLI(),
      monthlyTiLc: mkLI(null, monthlyTi),
      monthlyReplacementReserves: naLI(),
      monthlyTenantImprovements: naLI(),
      monthlyLeasingCommissions: naLI(),
      pcaImmediateRepairs: naLI(),
      capexScheduleInflated: [], capexScheduleUninflated: [],
    },
    loan: {
      loanAmount: mkLI(bag.loan, bag.loan, 'BANK'),
      interestRate: mkLI(bag.coupon, bag.coupon, 'BANK'),
      termMonths: mkLI(bag.termMonths, bag.termMonths, 'BANK'),
      amortizationMonths: mkLI(0, 0, 'BANK'),
      ioPeriodMonths: mkLI(bag.ioMonths, bag.ioMonths, 'BANK'),
      maturityBalance: mkLI(null, bag.loan, 'BANK'),
      maturityDate: null,
      debtServiceAnnual: mkLI(ds, ds, 'BANK'),
    },
    assumptions: {
      capRate: mkLI(bag.cap, bag.cap),
      terminalCapRate: mkLI(null, bag.cap + 0.005),
      concludedCapRate: null,
      rentGrowthPct: naLI(), expenseGrowthPct: naLI(),
    },
    metrics: {
      noi: bag.noi, value: bag.value, dscr: bag.noi/ds, ltvAppraisal: null,
      debtYield: bag.noi/bag.loan, expenseRatio: null,
      top1IncomeShare: top1,
      pctIncomeExpiringWithinTerm: pctRoll,
      trailingActualNoi: bag.t12noi,
      issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
    },
    dataConfidence: bag.t12noi !== null ? 'validated' : 'low_confidence',
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: ['JE_APPRAISAL_MISSING'] as any,
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function mkStress(ai: AdjustedInputs): StressOutputs {
  const noi = ai.metrics.noi ?? 0;
  const ds = ai.loan.debtServiceAnnual.adjusted;
  const loan = ai.loan.loanAmount.adjusted;
  const cap = ai.assumptions.capRate.adjusted;
  const scenarios: StressScenarioOutput[] = [-0.10, -0.20].map(d => {
    const sNoi = noi * (1 + d);
    const sVal = sNoi / cap;
    return { name: `NOI_${(d*100).toFixed(0)}pct`, noi: sNoi, dscr: sNoi/ds, value: sVal, ltv: loan/sVal, debtYield: sNoi/loan, breaches: [], skipped: [] };
  });
  const body = { analysisAsOfDate: AS_OF, adjustedInputsId: ai.id, stressEngineVersion: STRESS_ENGINE_VERSION, method: 'DEFAULT' as const, scenarios };
  return { id: computeStressOutputsId(body) as StressOutputsId, ...body } as StressOutputs;
}
function mkNF(bag: ShowcaseBag): NarrativeFacts {
  const body: Omit<NarrativeFacts, 'id'> = {
    analysisAsOfDate: AS_OF, trailingOccAvg: null, occupancyCurrent: null,
    propertyClass: null, shadowVacancyFlag: null, subleaseCompetition: null,
    leasingVelocityDataAvailable: null, isMall: false, // Showcase I is a retail center, not a mall
    franchiseExpirationWithinTerm: null, pipRequired: null, pipBudgetPerKey: null,
    privateWastewater: null, parkOwnedHomesPct: null, t12NoiTrend: null,
    isSingleTenant: false, appraisalValue: null, appraisalCapRate: null,
    asrValue: bag.value, marketValueFromComps: null,
    exitCapRateBase: bag.cap + 0.005, exitCapRateStressed: bag.cap + 0.010,
  };
  return { id: computeNarrativeFactsId(body) as NarrativeFactsId, ...body } as NarrativeFacts;
}
function mkCC(aid: AdjustedInputsId): CrossCheckResult {
  const b = { analysisAsOfDate: AS_OF, adjustedInputsId: aid, findings: [], overallAdjustmentBias: 'neutral' as const };
  return { id: computeCrossCheckResultId(b) as CrossCheckResultId, ...b } as CrossCheckResult;
}
function mkProfile(): AssetProfile {
  return { id: 'apf' as AssetProfileId, propertyType: 'Retail', businessPlan: 'Stabilized', marketLiquidity: 'Primary' };
}

async function runEngine(bag: ShowcaseBag, withRentRoll: boolean) {
  const ai = mkAI(bag, withRentRoll);
  const stress = mkStress(ai);
  const nf = mkNF(bag);
  const val = buildValuationConclusion({ adjustedInputs: ai, stressOutputs: stress, narrativeFacts: nf });
  const cc = mkCC(ai.id);
  const de = buildDoctrineEvaluation({
    adjustedInputs: ai, assetProfile: mkProfile(),
    librarySnapshot: makeLib(), narrativeFacts: nf, crossCheckResult: cc,
    stressOutputs: stress, valuationConclusion: val,
    extractionResultId: 'er' as ExtractionResultId, rentRoll: null,
  });
  return de;
}

/* ------------------------------- main ----------------------------------- */

function fmtPct(v: number | null): string {
  if (v === null) return 'null';
  return (v * 100).toFixed(1) + '%';
}
function fmtUsd(v: number | null): string {
  if (v === null) return 'null';
  return '$' + Math.round(v).toLocaleString();
}

function dumpSummary(label: string, de: DoctrineEvaluation): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  finalScore                  : ${de.finalScore.toFixed(2)}`);
  console.log(`  ratingBand (post-cap)       : ${de.ratingBand}`);
  console.log(`  mechanicalScore             : ${de.mechanicalScore.toFixed(2)}`);
  console.log(`  weightedAggregate           : ${de.weightedAggregate.toFixed(2)}`);
  console.log(`  coverage.evaluatedPct       : ${fmtPct(de.coverage.evaluatedPct)}`);
  console.log(`  coverage.evaluatedWeight    : ${de.coverage.evaluatedWeight.toFixed(2)}`);
  console.log(`  coverage.totalEvaluableWt   : ${de.coverage.totalEvaluableWeight.toFixed(2)}`);
  console.log(`  bandCapApplied              : ${de.coverage.bandCapApplied}`);
  console.log(`  insufficientCoverageGate    : ${de.coverage.insufficientCoverageGate}`);
  console.log(`  excludedRiskDimRuleIds (n)  : [${de.coverage.excludedRiskDimRuleIds.join(', ')}] (n=${de.coverage.excludedRiskDimRuleIds.length})`);
  console.log(`  flags                       : [${de.flags.join(', ')}]`);
}

function dumpComponents(de: DoctrineEvaluation): void {
  console.log('\n  --- per-component breakdown (componentId / ruleId / status / score / weight / contribution) ---');
  for (const cs of de.componentScores) {
    const rawStr = cs.rawValue === null ? '   —  ' : (Math.abs(cs.rawValue) < 1 ? (cs.rawValue * 100).toFixed(1) + '%' : Math.round(cs.rawValue).toLocaleString());
    console.log(
      `    ${cs.componentId.padEnd(16)} ${cs.ruleId.padEnd(34)} ${cs.status.padEnd(18)} ` +
      `score=${String(cs.score).padStart(3)} wt=${cs.weight.toFixed(2).padStart(5)} contrib=${cs.contribution.toFixed(2).padStart(6)} raw=${rawStr.padStart(10)}`
    );
  }
}

(async () => {
  console.log('===========================================================');
  console.log('SHOWCASE DEEP-CHECK — Stage 1 (engine v1.3) discrimination proof');
  console.log('===========================================================');

  const bag = await readShowcase();
  console.log('\n--- workbook extract ---');
  console.log(`  loan                : ${fmtUsd(bag.loan)}`);
  console.log(`  term/IO/coupon      : ${bag.termMonths}mo / ${bag.ioMonths}mo / ${(bag.coupon*100).toFixed(2)}%`);
  console.log(`  concluded cap / LTV : ${(bag.cap*100).toFixed(2)}% / ${(bag.ltv*100).toFixed(2)}%`);
  console.log(`  concluded value     : ${fmtUsd(bag.value)}`);
  console.log(`  implied NOI         : ${fmtUsd(bag.noi)}`);
  console.log(`  T-12 NOI (extracted): ${fmtUsd(bag.t12noi)}`);
  console.log(`  up-front TI/LC      : ${fmtUsd(bag.upfrontTiLc)}`);
  console.log(`  monthly TI/LC       : ${fmtUsd(bag.monthlyTiLc)} ($${(bag.monthlyTiLc*12).toLocaleString()}/yr)`);
  console.log('\n--- rent-roll extract ---');
  console.log(`  units (rent>0)            : ${bag.rentRoll.units}`);
  console.log(`  totalAnnualRent           : ${fmtUsd(bag.rentRoll.totalAnnualRent)}`);
  console.log(`  top-1 tenant              : ${bag.rentRoll.top1Tenant ?? 'null'}`);
  console.log(`  top1IncomeShare           : ${fmtPct(bag.rentRoll.top1IncomeShare)}`);
  console.log(`  pctIncomeExpiringWithinTerm: ${fmtPct(bag.rentRoll.pctIncomeExpiringWithinTerm)}`);

  console.log('\n===========================================================');
  console.log('(A) WITHOUT rent roll — corpus-harness state');
  console.log('===========================================================');
  const deWO = await runEngine(bag, false);
  dumpSummary('engine output (no rent roll)', deWO);

  console.log('\n===========================================================');
  console.log('(B) WITH rent roll — top1IncomeShare + pctIncomeExpiringWithinTerm + TI/LC reserves populated');
  console.log('===========================================================');
  const deW = await runEngine(bag, true);
  dumpSummary('engine output (rent roll populated)', deW);
  dumpComponents(deW);

  console.log('\n===========================================================');
  console.log('DELTA (B − A)');
  console.log('===========================================================');
  console.log(`  finalScore           : ${deWO.finalScore.toFixed(2)} → ${deW.finalScore.toFixed(2)}  (Δ ${(deW.finalScore - deWO.finalScore).toFixed(2)})`);
  console.log(`  ratingBand           : ${deWO.ratingBand} → ${deW.ratingBand}`);
  console.log(`  coverage.evaluatedPct: ${fmtPct(deWO.coverage.evaluatedPct)} → ${fmtPct(deW.coverage.evaluatedPct)}`);
  console.log(`  excludedRiskDims (n) : ${deWO.coverage.excludedRiskDimRuleIds.length} → ${deW.coverage.excludedRiskDimRuleIds.length}`);
  console.log(`  bandCapApplied       : ${deWO.coverage.bandCapApplied} → ${deW.coverage.bandCapApplied}`);
  console.log(`  insufficientCovGate  : ${deWO.coverage.insufficientCoverageGate} → ${deW.coverage.insufficientCoverageGate}`);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
