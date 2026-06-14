/**
 * Calibration baseline against the clean backbone corpus.
 *
 * Wires /tmp/clean-corpus-backbone-corpus.json into the existing doctrine
 * engine (buildDoctrineEvaluation) using the same synthesize-from-DealBag
 * pattern as calibration-baseline.ts. MEASUREMENT ONLY — no doctrine
 * edits, no manifesto_rules.json changes.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/calibration-clean-corpus.ts
 *
 * What it reports:
 *   - input completeness per record (a missing dimension → HITL, not a
 *     false judgment) — skips tracked-pending entirely
 *   - the existing doctrine's band / finalScore / gate / cap per record
 *   - discrimination: LOSS recall (Weak / High Risk on complete losses),
 *     CLEAN false-positive (Weak / High Risk on top-loan CLEANs), and the
 *     per-class rating distributions
 *   - the top-loan-CLEAN confound called out explicitly (cleans skew large)
 *
 * Reference, not a target to reproduce.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  type StressOutputs,
  type StressOutputsId,
  type StressScenarioOutput,
  type ValuationConclusion,
  JUDGMENT_ENGINE_VERSION,
  STRESS_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeCreditManifestoId,
  computeCrossCheckResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
  computeNarrativeFactsId,
  computeStressOutputsId,
} from '../util/content-hash.js';
import { buildDoctrineEvaluation } from '../services/doctrine/build-doctrine-evaluation.js';
import { buildValuationConclusion } from '../services/valuation.service.js';

const CORPUS_JSON = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_CSV = '/tmp/calibration-clean-corpus.csv';
const OUT_REPORT = '/tmp/calibration-clean-corpus.out';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

/* ============================================================================
 * Corpus record shape (mirrors AnswerKeyRecord in the corpus runner)
 * ========================================================================== */

interface AnswerKeyRecord {
  readonly file: string;
  readonly cik: string;
  readonly dealName: string;
  readonly shelf: string;
  readonly vintage: number;
  readonly originator: string;
  readonly prosId: string;
  readonly propertyName: string;
  readonly inputSource: 'body-page' | 'targeted-annexA' | 'targeted-body-page' | 'tracked-pending';
  readonly outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
  readonly outcomeEvidence: string | null;
  readonly loanAmount: number | null;
  readonly coupon: number | null;
  readonly maturityDate: string | null;
  readonly concludedValue: number | null;
  readonly concludedLtv: number | null;
  readonly uwDscrNoi: number | null;
  readonly uwDscrNcf: number | null;
  readonly uwY1Noi: number | null;
  readonly t12Noi: number | null;
  readonly shelfLabelCatalog: string | null;
  readonly bodyPageOffset: number | null;
  readonly notes: string | null;
}

/* ============================================================================
 * Synthesize helpers — duplicated from calibration-baseline.ts so this
 * script is self-contained. (The baseline harness keeps them private.)
 * ========================================================================== */

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

function mkLI(raw: number | null, adjusted: number, source: 'T12_ACTUAL' | 'MANUAL' | 'IN_PLACE' | 'SELLER_UW' | 'BANK' | 'RENT_ROLL' | 'PCA' = 'MANUAL', adjs: AdjustmentEntry[] = []): AdjustedLineItem {
  return { raw, adjusted, source, adjustments: adjs };
}
function naLI(): AdjustedLineItem { return { raw: null, adjusted: 0, source: 'MANUAL', adjustments: [] }; }

function mapAssetType(propertyName: string): AssetType {
  const s = propertyName.toLowerCase();
  if (/portfolio.*mhc|manufactured/.test(s)) return 'MHC';
  if (/apartment|multifamily|garden/.test(s)) return 'Multifamily';
  if (/office/.test(s)) return 'Office';
  if (/retail|mall|shopping|outlets|plaza|crossing|center|marketplace/.test(s)) return 'Retail';
  if (/hotel|lodging|hospitality|inn|resort|marriott|hilton|hyatt|residence inn|candlewood|comfort suites|extended stay|holiday inn|radisson|courtyard|home 2 suites|home2 suites/.test(s)) return 'Hotel';
  if (/industrial|warehouse|distribution|logistic|hanesbrands|portfolio.*industrial/.test(s)) return 'Industrial';
  if (/storage|self.*stor/.test(s)) return 'SelfStorage';
  if (/mixed|empire hotel/.test(s)) return 'MixedUse';
  return 'Other';
}

function amortizingDS(loan: number, rate: number, amortMonths: number): number {
  if (amortMonths <= 0 || rate <= 0) return loan * rate;
  const m = rate / 12;
  const monthly = loan * (m * Math.pow(1 + m, amortMonths)) / (Math.pow(1 + m, amortMonths) - 1);
  return monthly * 12;
}

/* The corpus carries loanAmount + coupon + concludedValue + concludedLtv +
 * uwY1Noi + (often) uwDscrNoi/Ncf — but not termYears / amortMonths /
 * concludedCap directly. Derive what's needed:
 *   - termYears: pre-2016 CMBS = 10yr typical → 120 months. Use a default;
 *     when calibration cares about exact term we'll need to parse maturityDate.
 *   - amortMonths: 360 (30yr) typical
 *   - concludedCap: uwY1Noi / concludedValue when both present */
function synthesizeAdjustedInputs(r: AnswerKeyRecord): AdjustedInputs | null {
  const loan = r.loanAmount;
  if (loan === null) return null;
  const interestRate = r.coupon;
  if (interestRate === null) return null;

  // NOI cascade (same as baseline): uwY1 → t12 → derive from value × cap
  let noi = r.uwY1Noi ?? r.t12Noi ?? null;
  let cap: number | null = null;
  if (r.uwY1Noi !== null && r.concludedValue !== null && r.concludedValue > 0) {
    cap = r.uwY1Noi / r.concludedValue;
  }
  if (cap === null && noi !== null && r.concludedValue !== null && r.concludedValue > 0) {
    cap = noi / r.concludedValue;
  }
  if (cap === null) return null;
  if (noi === null && r.concludedValue !== null) noi = r.concludedValue * cap;
  if (noi === null) return null;

  const termMonths = 120;       // default 10yr CMBS term
  const amortMonths = 360;       // default 30yr amort
  const ioMonths = 0;            // default no IO
  const ds = amortizingDS(loan, interestRate, amortMonths);
  const dscr = r.uwDscrNcf ?? (ds > 0 ? noi / ds : null);
  const debtYield = loan > 0 ? noi / loan : null;
  const value = cap > 0 ? noi / cap : null;

  const body: Omit<AdjustedInputs, 'id'> = {
    analysisAsOfDate: AS_OF,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: 'placeholder' as LibrarySnapshotId,
    income: {
      grossRentalIncome: naLI(),
      otherIncome: naLI(),
      vacancyPct: naLI(),
      concessionsPct: naLI(),
      effectiveGrossIncome: naLI(),
    },
    expenses: {
      realEstateTaxes: naLI(), insurance: naLI(), utilities: naLI(),
      managementFee: naLI(), payroll: naLI(), maintenance: naLI(),
      other: naLI(), generalAndAdmin: naLI(), janitorial: naLI(),
      reimbursements: naLI(),
      totalOperatingExpenses: naLI(),
    },
    capitalReserves: {
      upfrontCapex: naLI(),
      upfrontReplacementReserves: naLI(),
      upfrontTiLc: naLI(),
      monthlyCapex: naLI(), monthlyTiLc: naLI(),
      monthlyReplacementReserves: naLI(),
      monthlyTenantImprovements: naLI(),
      monthlyLeasingCommissions: naLI(),
      pcaImmediateRepairs: naLI(),
      capexScheduleInflated: [], capexScheduleUninflated: [],
    },
    loan: {
      loanAmount:        mkLI(loan, loan, 'BANK'),
      interestRate:      mkLI(interestRate, interestRate, 'BANK'),
      termMonths:        mkLI(termMonths, termMonths, 'BANK'),
      amortizationMonths: mkLI(amortMonths, amortMonths, 'BANK'),
      ioPeriodMonths:    mkLI(ioMonths, ioMonths, 'BANK'),
      maturityBalance:   mkLI(null, loan, 'BANK'),
      maturityDate:      null,
      debtServiceAnnual: mkLI(ds, ds, 'BANK'),
    },
    assumptions: {
      capRate:         mkLI(cap, cap, 'MANUAL'),
      terminalCapRate: mkLI(null, cap + 0.005, 'MANUAL'),
      concludedCapRate: null,
      rentGrowthPct: naLI(),
      expenseGrowthPct: naLI(),
    },
    metrics: {
      noi, value, dscr,
      ltvAppraisal: null,
      debtYield,
      expenseRatio: null,
      top1IncomeShare: null,
      pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: r.t12Noi,
      issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null, noiDivergence: null,
    },
    dataConfidence: 'validated',
    confidenceReduction: 0,
    topLevelAdjustments: [],
    dataQualityFlags: ['JE_APPRAISAL_MISSING', 'JE_RENT_ROLL_MISSING', 'JE_PCA_MISSING'] as never,
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}

function synthesizeNarrativeFacts(r: AnswerKeyRecord, ai: AdjustedInputs): NarrativeFacts {
  const cap = ai.assumptions.capRate.adjusted;
  const body: Omit<NarrativeFacts, 'id'> = {
    analysisAsOfDate: AS_OF,
    trailingOccAvg: null,
    occupancyCurrent: null,
    propertyClass: null,
    shadowVacancyFlag: null,
    subleaseCompetition: null,
    leasingVelocityDataAvailable: null,
    isMall: /mall/i.test(r.propertyName) ? true : null,
    franchiseExpirationWithinTerm: null,
    pipRequired: null,
    pipBudgetPerKey: null,
    privateWastewater: null,
    parkOwnedHomesPct: null,
    t12NoiTrend: null,
    isSingleTenant: null,
    appraisalValue: null,
    appraisalCapRate: null,
    asrValue: r.concludedValue,
    marketValueFromComps: null,
    exitCapRateBase: cap + 0.005,
    exitCapRateStressed: cap + 0.010,
  };
  return { id: computeNarrativeFactsId(body) as NarrativeFactsId, ...body } as NarrativeFacts;
}

function synthesizeStressOutputs(ai: AdjustedInputs): StressOutputs {
  const noi = ai.metrics.noi ?? 0;
  const ds = ai.loan.debtServiceAnnual.adjusted;
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
      breaches: [], skipped: [],
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
    id: 'apf-clean-corpus' as AssetProfileId,
    propertyType: type,
    businessPlan: 'Stabilized',
    marketLiquidity: 'Primary',
  };
}

/* ============================================================================
 * Discrimination metrics
 * ========================================================================== */

interface PerRecordResult {
  readonly cik: string;
  readonly dealName: string;
  readonly shelf: string;
  readonly prosId: string;
  readonly propertyName: string;
  readonly inputSource: string;
  readonly outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  readonly bcLoss: number | null;
  readonly loanAmount: number;
  readonly engineBand: string;
  readonly finalScore: number;
  readonly mechScore: number;
  readonly gateFired: boolean;
  readonly bandCapApplied: boolean;
  readonly inputCompletePct: number;
  readonly sinkingRuleIds: string[];
  readonly skipReason: string | null;
}

function reqFields(r: AnswerKeyRecord): string[] {
  // Which corpus-input dimensions are present (for completeness scoring).
  const present: string[] = [];
  if (r.loanAmount !== null) present.push('loanAmount');
  if (r.coupon !== null) present.push('coupon');
  if (r.concludedValue !== null) present.push('concludedValue');
  if (r.concludedLtv !== null) present.push('concludedLtv');
  if (r.uwDscrNcf !== null) present.push('uwDscrNcf');
  if (r.uwDscrNoi !== null) present.push('uwDscrNoi');
  if (r.uwY1Noi !== null) present.push('uwY1Noi');
  if (r.t12Noi !== null) present.push('t12Noi');
  if (r.maturityDate !== null) present.push('maturityDate');
  return present;
}

function main(): void {
  const out: string[] = [];
  out.push('CALIBRATION PHASE — BASELINE RUN (existing doctrine vs clean backbone corpus)');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Reference, not a target. No doctrine edits, no manifesto_rules.json edits.');
  out.push('');

  const corpus = JSON.parse(fs.readFileSync(CORPUS_JSON, 'utf8')) as { records: AnswerKeyRecord[] };
  out.push(`Corpus: ${CORPUS_JSON}`);
  out.push(`Total records: ${corpus.records.length}`);

  const pendingCount = corpus.records.filter(r => r.inputSource === 'tracked-pending').length;
  const usable = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  out.push(`  tracked-pending (skipped, null inputs): ${pendingCount}`);
  out.push(`  usable for calibration: ${usable.length}`);

  /* === Run doctrine per usable record === */
  const csvHeader = 'cik,dealName,shelf,prosId,propertyName,outcomeClass,inputSource,loanAmount,engineBand,finalScore,mechScore,gateFired,bandCapApplied,inputCompletePct';
  fs.writeFileSync(OUT_CSV, csvHeader + '\n');

  const results: PerRecordResult[] = [];
  const skips: { record: AnswerKeyRecord; reason: string }[] = [];
  for (const r of usable) {
    const present = reqFields(r);
    const inputCompletePct = present.length / 9;
    const ai = synthesizeAdjustedInputs(r);
    if (ai === null) {
      skips.push({ record: r, reason: 'missing core fields (loan/NOI/cap/term/coupon) — HITL not false judgment' });
      results.push({
        cik: r.cik, dealName: r.dealName, shelf: r.shelf, prosId: r.prosId,
        propertyName: r.propertyName, inputSource: r.inputSource,
        outcomeClass: r.outcomeClass, bcLoss: r.bcLoss,
        loanAmount: r.loanAmount ?? 0,
        engineBand: 'SKIP', finalScore: NaN, mechScore: NaN,
        gateFired: false, bandCapApplied: false,
        inputCompletePct, sinkingRuleIds: [], skipReason: 'inputs insufficient → HITL',
      });
      continue;
    }
    const assetType = mapAssetType(r.propertyName);
    const nf = synthesizeNarrativeFacts(r, ai);
    const so = synthesizeStressOutputs(ai);
    let val: ValuationConclusion;
    try {
      val = buildValuationConclusion({ adjustedInputs: ai, stressOutputs: so, narrativeFacts: nf });
    } catch (e) {
      skips.push({ record: r, reason: `valuation throw: ${(e as Error).message}` });
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
      skips.push({ record: r, reason: `doctrine throw: ${(e as Error).message}` });
      continue;
    }
    const sinking = de.componentScores
      .filter((cs) => cs.reasonCodes.includes('INSUFFICIENT_DATA' as never))
      .map((cs) => cs.ruleId);
    results.push({
      cik: r.cik, dealName: r.dealName, shelf: r.shelf, prosId: r.prosId,
      propertyName: r.propertyName, inputSource: r.inputSource,
      outcomeClass: r.outcomeClass, bcLoss: r.bcLoss,
      loanAmount: r.loanAmount ?? 0,
      engineBand: de.ratingBand, finalScore: de.finalScore, mechScore: de.mechanicalScore,
      gateFired: de.coverage?.insufficientCoverageGateFired ?? false,
      bandCapApplied: de.coverage?.bandCapApplied ?? false,
      inputCompletePct, sinkingRuleIds: sinking, skipReason: null,
    });
    fs.appendFileSync(OUT_CSV,
      `${r.cik},"${r.dealName}",${r.shelf},${r.prosId},"${r.propertyName.replace(/"/g, '""')}",${r.outcomeClass},${r.inputSource},${r.loanAmount},${de.ratingBand},${de.finalScore.toFixed(2)},${de.mechanicalScore.toFixed(2)},${de.coverage?.insufficientCoverageGateFired ? 'Y' : 'N'},${de.coverage?.bandCapApplied ? 'Y' : 'N'},${(inputCompletePct * 100).toFixed(0)}\n`,
    );
  }

  out.push('');
  out.push(`Records run through doctrine: ${results.length}`);
  out.push(`Skipped (HITL — inputs insufficient): ${skips.length}`);
  if (skips.length > 0) {
    out.push('  Skip detail:');
    for (const s of skips.slice(0, 10)) out.push(`    ${s.record.dealName} #${s.record.prosId} ${s.record.propertyName}: ${s.reason}`);
    if (skips.length > 10) out.push(`    ... and ${skips.length - 10} more`);
  }

  /* === (1) Input completeness per class === */
  out.push('');
  out.push('=== (1) INPUT COMPLETENESS (per outcome class) ===');
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const subset = results.filter(r => r.outcomeClass === cls && r.skipReason === null);
    const mean = subset.length > 0
      ? subset.reduce((s, r) => s + r.inputCompletePct, 0) / subset.length
      : 0;
    out.push(`  ${cls.padEnd(12)} n=${subset.length.toString().padStart(3)}  mean inputs filled = ${(mean * 100).toFixed(0)}%`);
  }

  /* === (2) Per-class rating distribution === */
  out.push('');
  out.push('=== (2) PER-CLASS RATING DISTRIBUTION ===');
  const bands = ['Strong', 'Acceptable', 'Weak', 'High Risk'];
  out.push(`  ${'class'.padEnd(12)} n   ` + bands.map(b => b.padStart(11)).join('') + '   gated   capped');
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const subset = results.filter(r => r.outcomeClass === cls && r.skipReason === null);
    const dist: Record<string, number> = {};
    for (const r of subset) dist[r.engineBand] = (dist[r.engineBand] ?? 0) + 1;
    const gateCount = subset.filter(r => r.gateFired).length;
    const capCount = subset.filter(r => r.bandCapApplied).length;
    const cells = bands.map(b => (dist[b] ?? 0).toString().padStart(11));
    out.push(`  ${cls.padEnd(12)} ${subset.length.toString().padStart(3)} ${cells.join('')}   ${gateCount.toString().padStart(5)}   ${capCount.toString().padStart(5)}`);
  }

  /* === (3) Loss recall: LOSS records flagged Weak / High Risk === */
  out.push('');
  out.push('=== (3) LOSS RECALL — losses flagged Weak / High Risk (origination-basis inputs) ===');
  const completeLosses = results.filter(r => r.outcomeClass === 'LOSS' && r.skipReason === null);
  const lossWeakHigh = completeLosses.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  const lossStrongAcc = completeLosses.filter(r => r.engineBand === 'Strong' || r.engineBand === 'Acceptable');
  out.push(`  Complete LOSS records: ${completeLosses.length}`);
  out.push(`  Flagged Weak / High Risk (caught): ${lossWeakHigh.length}/${completeLosses.length}  (${(lossWeakHigh.length * 100 / Math.max(1, completeLosses.length)).toFixed(0)}%)`);
  out.push(`  Rated Strong / Acceptable (missed): ${lossStrongAcc.length}/${completeLosses.length}  (${(lossStrongAcc.length * 100 / Math.max(1, completeLosses.length)).toFixed(0)}%)`);
  for (const r of completeLosses.sort((a, b) => (b.bcLoss ?? 0) - (a.bcLoss ?? 0))) {
    out.push(`    ${r.dealName.padEnd(20)} #${r.prosId.padEnd(3)} ${r.propertyName.padEnd(35)} band=${r.engineBand.padEnd(11)} score=${r.finalScore.toFixed(1)}  gate=${r.gateFired ? 'Y' : 'N'}  cap=${r.bandCapApplied ? 'Y' : 'N'}  bcLoss=$${(r.bcLoss ?? 0).toLocaleString()}`);
  }

  /* === (4) CLEAN false-positive: top-loan CLEANs flagged Weak/High Risk === */
  out.push('');
  out.push('=== (4) CLEAN FALSE-POSITIVE — top-loan CLEANs flagged Weak / High Risk ===');
  const completeCleans = results.filter(r => r.outcomeClass === 'CLEAN' && r.skipReason === null);
  const cleanWeakHigh = completeCleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push(`  Complete CLEAN records (top-loan body-page sample): ${completeCleans.length}`);
  out.push(`  Flagged Weak / High Risk (false positives): ${cleanWeakHigh.length}/${completeCleans.length}  (${(cleanWeakHigh.length * 100 / Math.max(1, completeCleans.length)).toFixed(0)}%)`);
  for (const r of cleanWeakHigh.slice(0, 15)) {
    out.push(`    ${r.dealName.padEnd(20)} #${r.prosId.padEnd(3)} ${r.propertyName.padEnd(35)} band=${r.engineBand.padEnd(11)} score=${r.finalScore.toFixed(1)}`);
  }
  if (cleanWeakHigh.length > 15) out.push(`    ... and ${cleanWeakHigh.length - 15} more`);

  /* === (5) STRESS-ONLY directional === */
  out.push('');
  out.push('=== (5) STRESS-ONLY DIRECTIONAL (loans liquidated DPO — not LOSS) ===');
  const stressOnly = results.filter(r => r.outcomeClass === 'STRESS-ONLY' && r.skipReason === null);
  const stressWeakHigh = stressOnly.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
  out.push(`  STRESS-ONLY records with usable inputs: ${stressOnly.length}`);
  out.push(`  Flagged Weak / High Risk: ${stressWeakHigh.length}/${stressOnly.length}`);

  /* === (6) Distribution of finalScore — mean / median per class === */
  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(sorted.length - 1, idx)] ?? NaN;
  }
  out.push('');
  out.push('=== (6) FINAL-SCORE DISTRIBUTION (origination-basis doctrine output) ===');
  out.push(`  ${'class'.padEnd(12)} n      mean    p25     median  p75`);
  for (const cls of ['CLEAN', 'STRESS-ONLY', 'LOSS'] as const) {
    const subset = results.filter(r => r.outcomeClass === cls && r.skipReason === null && Number.isFinite(r.finalScore));
    if (subset.length === 0) { out.push(`  ${cls.padEnd(12)} (n=0)`); continue; }
    const scores = subset.map(r => r.finalScore);
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    out.push(`  ${cls.padEnd(12)} ${scores.length.toString().padStart(3)}    ${mean.toFixed(1).padStart(5)}   ${pct(scores, 0.25).toFixed(1).padStart(5)}   ${pct(scores, 0.5).toFixed(1).padStart(5)}   ${pct(scores, 0.75).toFixed(1).padStart(5)}`);
  }

  /* === (7) Loan-size confound: CLEANs are top-loans; LOSSes are tail === */
  out.push('');
  out.push('=== (7) SELECTION CONFOUND — CLEAN sample is top-loan-weighted ===');
  function meanLoan(arr: PerRecordResult[]): number {
    return arr.length > 0 ? arr.reduce((s, r) => s + r.loanAmount, 0) / arr.length : 0;
  }
  const cleansAll = results.filter(r => r.outcomeClass === 'CLEAN' && r.skipReason === null);
  const lossesAll = results.filter(r => r.outcomeClass === 'LOSS' && r.skipReason === null);
  out.push(`  mean CLEAN loan size:  $${meanLoan(cleansAll).toLocaleString(undefined, { maximumFractionDigits: 0 })}  (n=${cleansAll.length})`);
  out.push(`  mean LOSS  loan size:  $${meanLoan(lossesAll).toLocaleString(undefined, { maximumFractionDigits: 0 })}  (n=${lossesAll.length})`);
  out.push('  → CLEAN body-page records are by construction the top loans by balance.');
  out.push('  → LOSSes lean toward the tail of the pool.');
  out.push('  → ANY separation between CLEAN and LOSS in the engine output is partially');
  out.push('     a SELECTION effect (large vs small loans), not pure doctrine skill.');
  // Compare losses to similarly-sized cleans (within 1.5x band)
  if (lossesAll.length > 0) {
    const lossMin = Math.min(...lossesAll.map(r => r.loanAmount));
    const lossMax = Math.max(...lossesAll.map(r => r.loanAmount));
    const lossLo = lossMin * 0.5;
    const lossHi = lossMax * 2.0;
    const sizedCleans = cleansAll.filter(r => r.loanAmount >= lossLo && r.loanAmount <= lossHi);
    out.push(`  CLEANs with loan in [${lossLo.toLocaleString()}, ${lossHi.toLocaleString()}] (overlap with LOSS size range): ${sizedCleans.length}/${cleansAll.length}`);
    if (sizedCleans.length >= 3) {
      const sizedDist: Record<string, number> = {};
      for (const r of sizedCleans) sizedDist[r.engineBand] = (sizedDist[r.engineBand] ?? 0) + 1;
      const sizedFP = sizedCleans.filter(r => r.engineBand === 'Weak' || r.engineBand === 'High Risk');
      out.push(`    size-matched CLEAN false-positive: ${sizedFP.length}/${sizedCleans.length}  (vs ${cleanWeakHigh.length}/${cleansAll.length} overall)`);
    } else {
      out.push('    NOTE: too few size-matched CLEANs for a meaningful comparison — the corpus lacks small CLEANs.');
    }
  }

  /* === (8) SEPARABILITY FINDING — the headline === */
  out.push('');
  out.push('=== (8) SEPARABILITY FINDING ===');
  const lossCaught = lossWeakHigh.length;
  const lossTotal = completeLosses.length;
  const cleanFp = cleanWeakHigh.length;
  const cleanTotal = completeCleans.length;
  const lossMeanScore = completeLosses.length > 0
    ? completeLosses.reduce((s, r) => s + r.finalScore, 0) / completeLosses.length
    : NaN;
  const cleanMeanScore = completeCleans.length > 0
    ? completeCleans.reduce((s, r) => s + r.finalScore, 0) / completeCleans.length
    : NaN;
  const scoreGap = cleanMeanScore - lossMeanScore;
  out.push(`  Loss recall (Weak / High Risk):    ${lossCaught}/${lossTotal}   (${(lossCaught * 100 / Math.max(1, lossTotal)).toFixed(0)}%)`);
  out.push(`  Clean FP    (Weak / High Risk):    ${cleanFp}/${cleanTotal}   (${(cleanFp * 100 / Math.max(1, cleanTotal)).toFixed(0)}%)`);
  out.push(`  Mean score CLEAN:                  ${cleanMeanScore.toFixed(1)}`);
  out.push(`  Mean score LOSS:                   ${lossMeanScore.toFixed(1)}`);
  out.push(`  Mean-score gap (CLEAN − LOSS):     ${scoreGap.toFixed(1)} pts ${scoreGap > 5 ? '(separation present)' : '(weak / no separation)'}`);
  out.push('');
  out.push('  CAVEAT: the CLEAN sample is top-loan-weighted (by construction — body-page');
  out.push('  primary architecture covers the top loans). LOSSes lean to the tail. Any');
  out.push('  separation reported above is at least partially a SELECTION effect, not');
  out.push('  pure doctrine skill. Use this as a REFERENCE for the rebuild, not a target.');
  out.push('');

  fs.writeFileSync(OUT_REPORT, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[calibration] CSV: ${OUT_CSV}`);
  console.log(`[calibration] report: ${OUT_REPORT}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
