/**
 * Synthetic DSCR-binding deal — exercise the bisection cut arm and prove
 * it converges by side-by-side with a closed-form oracle.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-dscr-binding-synthetic.ts
 *
 * What this validates:
 *   - DSCR is the SOLE binding constraint (LTV mid-band, DY clear,
 *     exit DSCR clear → amortCutHint = null, no shadow).
 *   - The cut arm runs `binarySearchLoanForDscr` (amortMonths > 0 → not the
 *     IO closed form), and converges to the closed-form oracle within
 *     $0.01M precision — guards against silent-wrong drift in the
 *     bisection loop.
 *   - The v1.8 descriptor reads "coverage below floor" on this dscr-binding
 *     cut.
 *
 * Anchor (revised from recon — rate bumped from 8.75% → 9.50%, no rc override needed):
 *   Hotel · NOI $8.0M · NCF/NOI 0.96 · loan $66.0M · rate 9.50% ·
 *   amortMonths 300 (25y) · termMonths 60 (5y term).
 *
 * Why the rate bump from 8.75%: at 8.75% the DSCR cut sized to $1.13M = 1.71%
 * of loan, BELOW the desk's MATERIALITY_MIN_PROCEEDS_CUT_PCT = 0.02 (2%) gate
 * (produce-mitigations.ts:759). The engine drops sub-materiality cuts to null,
 * which means the bisection executes but its result is then discarded — the
 * cross-check would have nothing to compare. Bumping to 9.50% pushes the cut
 * to ~7.5% of loan, well clear of materiality, so the bisection result lives
 * through to the cut path. Doctrine knob respected; same anchor logic.
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import {
  produceMitigations,
  DEFAULT_MITIGATION_DESK,
  resolveLtvStructuredCeiling,
  SPONSOR_CASH_AT_RISK_FLAG_THRESHOLD,
} from '../services/mitigation/produce-mitigations.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import { buildNarrative } from '../services/narrative/build-narrative.js';
import { computeMitigationProposalSetId } from '../util/content-hash.js';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import { calculateAnnualDebtService } from '@cre/shared';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  HandbookEvaluation,
  HandbookEvaluationId,
  MitigationProposalSet,
} from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

const OUT_HTML = path.resolve('/tmp/synthetic-hotel-dscr-memo.html');

/* -------------------- helpers -------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}
function fmtUsdExact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtPct(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(d) + '%';
}
function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(4) + 'x';
}

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

function buildAi(opts: {
  loanAmount: number; coupon: number; amortMonths: number; termMonths: number;
  noi: number; valueForLegacyLtv: number; egi: number; dscr: number; debtYield: number;
  annualDebtService: number;
}): AdjustedInputs {
  const { loanAmount, coupon, amortMonths, termMonths, noi, valueForLegacyLtv, egi, dscr, debtYield, annualDebtService } = opts;
  // ioPeriod = 0 when amortizing.
  const ioMonths = amortMonths > 0 ? 0 : termMonths;
  return {
    id: 'AI_SYNTH_DSCR' as any, analysisAsOfDate: '2026-06-12T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, egi) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: {
      loanAmount: li(loanAmount, loanAmount),
      interestRate: li(coupon, coupon),
      termMonths: li(termMonths, termMonths),
      amortizationMonths: li(amortMonths, amortMonths),
      ioPeriodMonths: li(ioMonths, ioMonths),
      maturityBalance: li(null, loanAmount),
      maturityDate: '2031-06-12T00:00:00Z' as any,
      debtServiceAnnual: li(null, annualDebtService),
    },
    assumptions: { capRate: li(0.09, 0.09), terminalCapRate: li(0.095, 0.095), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
    metrics: {
      noi, value: valueForLegacyLtv, dscr,
      ltvAppraisal: null, debtYield,
      expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
    },
    topLevelAdjustments: [], dataQualityFlags: [],
    dataConfidence: 'validated' as any,
  } as unknown as AdjustedInputs;
}

function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }

function buildUw(opts: {
  loanAmount: number; coupon: number; amortMonths: number; termMonths: number;
  noi: number; valueForLegacyLtv: number; egi: number; annualDebtService: number;
}): UnderwritingModel {
  const { loanAmount, coupon, amortMonths, termMonths, noi, valueForLegacyLtv, egi, annualDebtService } = opts;
  const toe = egi - noi;
  const dscr = noi / annualDebtService;
  const debtYield = noi / loanAmount;
  const ioMonths = amortMonths > 0 ? 0 : termMonths;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.095, impliedValue: valueForLegacyLtv, loanAmount,
    interestRate: coupon * 100, amortizationYears: amortMonths / 12, termYears: termMonths / 12, annualDebtService, dscr,
    ltv: loanAmount / valueForLegacyLtv, debtYield, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: coupon * 100, rateType: 'fixed', ioMonths, amortizationMonths: amortMonths, termMonths, paymentFrequency: 'monthly', originationDate: '2026-06-12', maturityDate: '2031-06-12' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

function makeHotelBag(opts: {
  loan: number; coupon: number; noi: number; concludedValue: number;
  amortMonths: number; termMonths: number;
}): DealBag {
  return {
    propertyName: 'Synthetic Hotel (DSCR-binding)',
    assetType: 'Hotel',
    subType: null,
    loanAmount: opts.loan,
    coupon: opts.coupon,
    concludedValue: opts.concludedValue,
    concludedValueSource: 'operator-supplied',
    uwY1Noi: opts.noi,
    t12Noi: null,
    underwrittenOccupancy: null,
    largestTenantPct: null,
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: 'na-by-asset-type',
    amortMonths: opts.amortMonths,
    ioYears: 0,
    termYears: opts.termMonths / 12,
    marketTier: 'Unknown',
    stressedRefiConstant: null,
  } as DealBag;
}

/* ============================== main ====================================== */

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('SYNTHETIC HOTEL DSCR-BINDING — exercise binarySearchLoanForDscr');
  console.log(`MITIGATION_ENGINE_VERSION = ${MITIGATION_ENGINE_VERSION}`);
  console.log('================================================================');
  console.log('');

  /* ------ anchor ----------------------------------------------------- */
  const NOI = 8_000_000;
  const LOAN = 66_000_000;
  const RATE = 0.0950;             // 9.50% — bumped from recon 8.75% to clear MATERIALITY_MIN_PROCEEDS_CUT_PCT (2%)
  const AMORT_MONTHS = 300;        // 25-yr amortization (NOT IO)
  const TERM_MONTHS = 60;          // 5-yr term
  const APPRAISAL = 90_000_000;    // operator value (informational; not in stressedLtv math)
  const EGI = NOI * 1.55;          // Hotel-ish expense ratio

  // Closed-form annual debt service (oracle for the bisection — same primitive
  // the engine bisection calls: calculateAnnualDebtService(loan, ratePercent, amortYears)).
  const ratePercent = RATE * 100;
  const amortYears = AMORT_MONTHS / 12;
  const annualDsAtFullLoan = calculateAnnualDebtService(LOAN, ratePercent, amortYears) ?? Number.NaN;
  const amortConstant = annualDsAtFullLoan / LOAN;
  const dscrDay1 = NOI / annualDsAtFullLoan;
  const dy = NOI / LOAN;

  /* ------ doctrine pass --------------------------------------------- */
  const dealBag = makeHotelBag({
    loan: LOAN, coupon: RATE, noi: NOI, concludedValue: APPRAISAL,
    amortMonths: AMORT_MONTHS, termMonths: TERM_MONTHS,
  });
  const dealResult = evaluateDeal(dealBag);
  const dim7 = dealResult.dimensions.capRateValuationStress;
  const dim4 = dealResult.dimensions.refinanceFeasibility;
  const stressedValue = dim7.derivedOutputs?.stressedValue as number;
  const stressedLtv  = dim7.derivedOutputs?.stressedLtv as number;
  const exitDscrRaw  = dim4.derivedOutputs?.exitDscr as number;
  const maturityBalance = dim4.derivedOutputs?.maturityBalance as number;
  const stressedRefiConstant = dim4.derivedOutputs?.stressedRefiConstant as number;
  const sustainableNcf = dealResult.normalization.sustainableNcf as number;

  console.log('Inputs (the Hotel DSCR-binding construction):');
  console.log(`  assetType                : Hotel`);
  console.log(`  NOI                      : ${fmtUsd(NOI)}`);
  console.log(`  loan                     : ${fmtUsd(LOAN)}`);
  console.log(`  coupon                   : ${fmtPct(RATE)}  (amort 25yr / term 5yr — NOT IO)`);
  console.log(`  amortMonths              : ${AMORT_MONTHS}        (≠ 0 → isIO=false → bisection path)`);
  console.log(`  termMonths               : ${TERM_MONTHS}`);
  console.log(`  concludedValue           : ${fmtUsd(APPRAISAL)}  (informational; dim-7 uses NCF/cap_floor)`);
  console.log(`  stressedRefiConstant     : ${fmtPct(stressedRefiConstant)}  (default — NO rc override)`);
  console.log('');

  console.log('Doctrine signals:');
  console.log(`  sustainable NCF          : ${fmtUsd(sustainableNcf)}  (Hotel NCF/NOI 0.96)`);
  console.log(`  Hotel cap floor          : ${fmtPct(0.095)}`);
  console.log(`  dim-7 stressedValue      : ${fmtUsd(stressedValue)}  (= NCF / 0.095)`);
  console.log(`  dim-7 stressedLtv        : ${fmtPct(stressedLtv)}`);
  console.log(`  dim-4 maturityBalance    : ${fmtUsd(maturityBalance)}  (5-yr paydown at ${fmtPct(RATE)}/25-yr amort)`);
  console.log(`  dim-4 exit DSCR (raw)    : ${fmtDscr(exitDscrRaw)}  (= ${fmtUsd(sustainableNcf)} / (${fmtPct(stressedRefiConstant)} × ${fmtUsd(maturityBalance)}))`);
  console.log(`  Day-1 DSCR (NOI / DS)    : ${fmtDscr(dscrDay1)}  (DS = ${fmtUsd(annualDsAtFullLoan)} via calculateAnnualDebtService)`);
  console.log(`  DY                       : ${fmtPct(dy)}`);
  console.log('');

  /* ------ breach picture + band classification ---------------------- */
  const hotelCeiling = resolveLtvStructuredCeiling('Hotel');
  const ltvBreached  = stressedLtv > DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
  const dscrBreached = dscrDay1 < DEFAULT_MITIGATION_DESK.T_DSCR;
  const dyBreached   = dy < DEFAULT_MITIGATION_DESK.T_DY;
  const exitBreached = exitDscrRaw < 1.20;
  console.log('Breach picture (BEFORE the cut):');
  console.log(`  DSCR ${fmtDscr(dscrDay1)} < ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)}  ? ${dscrBreached ? '✓ BREACHED — DSCR arm pushes to breaches[]' : 'PASSES'}`);
  console.log(`  LTV  ${fmtPct(stressedLtv)} > ${fmtPct(DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER)} ? ${ltvBreached ? 'in band' : 'CLEAN'}  (Hotel ceiling ${fmtPct(hotelCeiling)}; ${stressedLtv > hotelCeiling ? 'BEYOND-CEILING' : 'MID-BAND — LTV arm SKIPS reduce_proceeds, leverage_band_recourse fires'})`);
  console.log(`  DY   ${fmtPct(dy)} < ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} ? ${dyBreached ? 'BREACHED' : '✓ CLEAN — DY arm SKIPS'}`);
  console.log(`  Exit DSCR ${fmtDscr(exitDscrRaw)} < ${fmtDscr(1.20)} ? ${exitBreached ? 'breached — require_amortization may fire' : '✓ CLEAN — require_amortization SKIPS entirely (amortCutHint = null)'}`);
  console.log('');
  console.log(`  → Sole breach metric expected: 'dscr'.  ${dscrBreached && !ltvBreached === false && !dyBreached && !exitBreached ? '' : ''}`);
  console.log('');

  /* ------ per-arm L' (what each arm WOULD produce) ------------------ */
  // closed-form oracle: L'_DSCR_closed = NOI / (T_DSCR × annualConstant_at_rate_term)
  const lPrimeDscrClosed = NOI / (DEFAULT_MITIGATION_DESK.T_DSCR * amortConstant);
  // DY arm sizing — not pushed (not breached) but for context.
  const lPrimeDy = NOI / DEFAULT_MITIGATION_DESK.T_DY;
  // LTV arm sizing — skipped (mid-band).
  const lPrimeLtvCeil = hotelCeiling * stressedValue;
  console.log("Per-arm L' (what each WOULD size; engine pushes only breached arms):");
  console.log(`  DSCR arm   L'  ≈ NOI / (T_DSCR × amortConstant)`);
  console.log(`                = ${fmtUsd(NOI)} / (${DEFAULT_MITIGATION_DESK.T_DSCR.toFixed(4)} × ${(amortConstant * 100).toFixed(4)}%) = ${fmtUsdExact(lPrimeDscrClosed)}`);
  console.log(`             ── via binarySearchLoanForDscr (amortMonths=${AMORT_MONTHS} ≠ 0)`);
  console.log(`  DY arm     L'  = NOI / T_DY = ${fmtUsd(NOI)} / ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} = ${fmtUsd(lPrimeDy)}  [SKIPPED — DY clean]`);
  console.log(`  LTV arm    L'  = ceiling × stressedValue = ${fmtPct(hotelCeiling)} × ${fmtUsd(stressedValue)} = ${fmtUsd(lPrimeLtvCeil)}  [SKIPPED — mid-band, leverage_band_recourse fires]`);
  console.log('');

  /* ------ amortCutHint — explicitly computed (must be null) --------- */
  // require_amortization only emits at all if exitDscrRaw < 1.20.
  // The day-1-blocked branch then computes equivalentCut = currentLoan − sustainableNcf/(rc × cureTarget).
  // We compute the "would-be" amortCutHint figure regardless, so "no shadow" is on the record.
  const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
  const wouldBeAmortCutHintLPrime = sustainableNcf / (stressedRefiConstant * cureTarget);
  const wouldBeAmortCutHintCut = Math.max(0, LOAN - wouldBeAmortCutHintLPrime);
  const amortCutHintActive = exitBreached;
  console.log('amortCutHint shadow check (compose-mitigations.ts:266):');
  console.log(`  Gate 1 — exitDscrRaw < 1.20 ? ${exitBreached ? 'yes' : 'NO'}  → require_amortization ${exitBreached ? 'fires' : 'returns null at the gate'}`);
  console.log(`  Result: amortCutHint = ${amortCutHintActive ? '(would compute)' : 'null'}  ← ${amortCutHintActive ? 'POSSIBLE SHADOW' : 'NO SHADOW — DSCR arm is sole cut candidate'}`);
  console.log(`  Reference (what amortCutHint WOULD be at current anchor IF exit breached):`);
  console.log(`    L'_amortCutHint = NCF / (rc × T_EXIT_DSCR_CURE_TARGET) = ${fmtUsd(sustainableNcf)} / (${fmtPct(stressedRefiConstant)} × ${cureTarget.toFixed(2)}x) = ${fmtUsdExact(wouldBeAmortCutHintLPrime)}`);
  console.log(`    Would-be cut    = ${fmtUsdExact(wouldBeAmortCutHintCut)}`);
  console.log(`  Shadowing condition: L'_amortHint < L'_DSCR? ${wouldBeAmortCutHintLPrime < lPrimeDscrClosed ? `${fmtUsd(wouldBeAmortCutHintLPrime)} < ${fmtUsd(lPrimeDscrClosed)} — would shadow if active` : `${fmtUsd(wouldBeAmortCutHintLPrime)} ≥ ${fmtUsd(lPrimeDscrClosed)} — DSCR arm wins even if active`}`);
  console.log('');

  /* ------ produce + extract bisection L' --------------------------- */
  const ai = buildAi({
    loanAmount: LOAN, coupon: RATE, amortMonths: AMORT_MONTHS, termMonths: TERM_MONTHS,
    noi: NOI, valueForLegacyLtv: APPRAISAL, egi: EGI, dscr: dscrDay1, debtYield: dy,
    annualDebtService: annualDsAtFullLoan,
  });
  const uw = buildUw({
    loanAmount: LOAN, coupon: RATE, amortMonths: AMORT_MONTHS, termMonths: TERM_MONTHS,
    noi: NOI, valueForLegacyLtv: APPRAISAL, egi: EGI, annualDebtService: annualDsAtFullLoan,
  });
  const proposals = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult });
  const reduce = proposals.find(p => p.lever === 'reduce_proceeds');
  const amort  = proposals.find(p => p.lever === 'require_amortization');
  console.log('produceMitigations() result — what the ENGINE saw:');
  console.log(`  reduce_proceeds:`);
  console.log(`    id            = "${reduce?.id ?? '—'}"`);
  console.log(`    targetMetric  = "${(reduce as any)?.targetMetric ?? '—'}"`);
  console.log(`    requiredEquity= ${fmtUsdExact((reduce as any)?.requiredEquity)}`);
  console.log(`    ${reduce?.id === 'reduce_proceeds_dscr' ? '✓ DSCR arm fires; id is reduce_proceeds_dscr' : '✗ Different arm fired — investigate'}`);
  console.log(`  require_amortization:`);
  console.log(`    id            = "${amort?.id ?? '(not emitted)'}"`);
  console.log(`    ${amort === undefined ? '✓ require_amortization SKIPS (exit DSCR ≥ 1.20)' : '✗ require_amortization emitted — investigate'}`);
  console.log('');

  /* ------ CROSS-CHECK: bisection L' vs closed-form L' --------------- */
  const lPrimeBisect = LOAN - (((reduce as any)?.requiredEquity as number) ?? 0);
  const delta = Math.abs(lPrimeBisect - lPrimeDscrClosed);
  const postCutDsAtBisect = calculateAnnualDebtService(lPrimeBisect, ratePercent, amortYears) ?? Number.NaN;
  const postCutDscrAtBisect = NOI / postCutDsAtBisect;
  console.log('================================================================');
  console.log('★ CROSS-CHECK — silent-wrong guard on the bisection');
  console.log('================================================================');
  console.log(`  amortConstant @ ${fmtPct(RATE)}/${amortYears.toFixed(0)}-yr   : ${(amortConstant * 100).toFixed(6)}%`);
  console.log(`  L'_closed   = NOI / (T_DSCR × amortConstant) = ${fmtUsdExact(lPrimeDscrClosed)}`);
  console.log(`  L'_bisect   = loan − requiredEquity          = ${fmtUsdExact(lPrimeBisect)}`);
  console.log(`  |Δ|         = ${fmtUsdExact(delta)}                  ← assert < $0.01M`);
  const TOL = 10_000;  // $0.01M
  const passDelta = delta < TOL;
  console.log(`  ${passDelta ? '✓ PASS' : '✗ FAIL'} — bisection ${passDelta ? 'converges to closed-form within $10K' : 'diverged'}`);
  console.log('');
  console.log(`  post-cut DSCR at L'_bisect : ${fmtDscr(postCutDscrAtBisect)}`);
  const POSTCUT_TOL = 0.0005;
  const passPostCut = Math.abs(postCutDscrAtBisect - DEFAULT_MITIGATION_DESK.T_DSCR) < POSTCUT_TOL;
  console.log(`  ${passPostCut ? '✓ PASS' : '✗ FAIL'} — DSCR lands ${DEFAULT_MITIGATION_DESK.T_DSCR.toFixed(4)}x ± ${POSTCUT_TOL} (not under-cut, not over-cut)`);
  console.log('');

  /* ------ compose end-to-end ---------------------------------------- */
  const composed = composeMitigations({
    adjustedInputs: ai, uwModel: uw, dealResult, firedFlags: [],
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const newBag = { ...dealBag, loanAmount: newLoan };
      const newDealResult = evaluateDeal(newBag);
      const newDs = calculateAnnualDebtService(newLoan, ratePercent, amortYears) ?? newLoan * RATE;
      const newDscr = NOI / newDs;
      const newDy = NOI / newLoan;
      return {
        adjustedInputs: buildAi({
          loanAmount: newLoan, coupon: RATE, amortMonths: AMORT_MONTHS, termMonths: TERM_MONTHS,
          noi: NOI, valueForLegacyLtv: APPRAISAL, egi: EGI, dscr: newDscr, debtYield: newDy,
          annualDebtService: newDs,
        }),
        uwModel: buildUw({
          loanAmount: newLoan, coupon: RATE, amortMonths: AMORT_MONTHS, termMonths: TERM_MONTHS,
          noi: NOI, valueForLegacyLtv: APPRAISAL, egi: EGI, annualDebtService: newDs,
        }),
        dealResult: newDealResult,
      };
    },
  });
  console.log('================================================================');
  console.log('COMPOSED PACKAGE');
  console.log('================================================================');
  console.log('');
  console.log(`  final loan (L')  : ${fmtUsdExact(composed.finalLoanAmount)}`);
  console.log(`  proceeds cut     : ${fmtUsdExact(composed.reconciliation.proceedsReduction)}`);
  console.log('');
  console.log('  Final proposals:');
  for (const p of composed.proposals) {
    const extra: string[] = [];
    if (p.requiredEquity !== undefined)  extra.push(`requiredEquity ${fmtUsd(p.requiredEquity)}`);
    if (p.requiredPaydown !== undefined) extra.push(`requiredPaydown ${fmtUsd(p.requiredPaydown)}`);
    if (p.requiredReserve !== undefined) extra.push(`requiredReserve ${fmtUsd(p.requiredReserve)}`);
    console.log(`    - ${p.id ?? '?'}  [${p.lever}]${extra.length ? '  ' + extra.join(' · ') : ''}`);
  }
  console.log('');
  console.log('  Reconciliation notes (descriptor check — expect "coverage below floor"):');
  for (const n of composed.reconciliation.notes) console.log(`    • ${n}`);
  console.log('');

  /* ------ post-cut final-state signals ----------------------------- */
  const fs7 = composed.finalState.dealResult.dimensions.capRateValuationStress;
  const fs4 = composed.finalState.dealResult.dimensions.refinanceFeasibility;
  const finalStressedLtv = fs7.derivedOutputs?.stressedLtv as number;
  const finalExitDscr = fs4.derivedOutputs?.exitDscr as number;
  const finalDs = calculateAnnualDebtService(composed.finalLoanAmount, ratePercent, amortYears) ?? Number.NaN;
  const finalDscr = NOI / finalDs;
  const finalDy = NOI / composed.finalLoanAmount;
  console.log('Final-state signals (post-cut):');
  console.log(`  loan at L'                 : ${fmtUsdExact(composed.finalLoanAmount)}`);
  console.log(`  stressedLtv at L'          : ${fmtPct(finalStressedLtv)}  ${finalStressedLtv > DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER && finalStressedLtv <= hotelCeiling ? '(still mid-band — leverage_band_recourse re-fires)' : finalStressedLtv <= DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER ? '(below trigger)' : '(beyond ceiling)'}`);
  console.log(`  Day-1 DSCR at L'           : ${fmtDscr(finalDscr)}  (target ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)})`);
  console.log(`  DY at L'                   : ${fmtPct(finalDy)}`);
  console.log(`  Exit DSCR raw at L'        : ${fmtDscr(finalExitDscr)}  (refi threshold 1.20)`);
  console.log('');

  /* ------ sponsor burden ------------------------------------------- */
  const b = composed.sponsorBurdenProfile;
  console.log('================================================================');
  console.log('SPONSOR BURDEN PROFILE — third data point');
  console.log('================================================================');
  console.log('');
  console.log(`  equity ask                 : ${fmtUsd(b.equityAsk)}`);
  console.log(`  net recourse cap           : ${fmtUsd(b.netRecourseCap)}`);
  for (const r of b.recourseBreakdown) {
    console.log(`    - ${r.lever}: ${fmtUsd(r.capUsd)}  (${r.note})`);
  }
  console.log(`  NW requirement             : ${fmtUsd(b.netWorthRequirement)}`);
  console.log(`  liquidity requirement      : ${fmtUsd(b.liquidityRequirement)}`);
  console.log(`  distribution lockup        : ${b.distributionLockupYears !== null ? b.distributionLockupYears.toFixed(1) + ' yr' : '—'}`);
  console.log('');
  console.log(`  CASH-AT-RISK               : ${fmtUsd(b.cashAtRiskUsd)} = ${fmtPct(b.cashAtRiskPctOfFinalLoan, 1)} of L'`);
  console.log(`  Threshold                  : ${fmtPct(SPONSOR_CASH_AT_RISK_FLAG_THRESHOLD, 0)}`);
  console.log(`  Flag                       : ${b.flagsBurden ? '⚑ FLAGGED' : '✓ below threshold'}`);
  if (b.flagCopy) console.log(`    > ${b.flagCopy}`);
  console.log('');
  console.log('  Contrast across the three synthetic data points:');
  console.log(`    Sunroad  (real, LTV-binding, beyond ceiling):           cash-at-risk 50.0% → FLAGGED`);
  console.log(`    DY synth (Multifamily, mid-band LTV + DY-binding):      cash-at-risk 28.3% → clean`);
  console.log(`    DSCR synth (Hotel,  mid-band LTV + DSCR-binding):       cash-at-risk ${fmtPct(b.cashAtRiskPctOfFinalLoan, 1)} → ${b.flagsBurden ? 'FLAGGED' : 'clean'}`);
  console.log('');

  /* ------ memo ------------------------------------------------------ */
  const stubLlm: any = async ({ messages }: { messages: Array<{ content: string }> }) => {
    const userMsg = messages?.[0]?.content ?? '';
    if (userMsg.startsWith('Compose a single executive-summary paragraph')) {
      return `Stub executive summary — synthetic Hotel DSCR-binding deal; recommend ApproveWithConditions with proceeds reduction of ${fmtUsd(LOAN - lPrimeBisect)} to L' = ${fmtUsd(lPrimeBisect)} via the binarySearchLoanForDscr cut arm.`;
    }
    if (userMsg.startsWith('Compose a red-flag assessment')) {
      return '- [dim-2 coverage-dscr] tier=concerning — day-1 DSCR below floor at original loan.';
    }
    if (userMsg.startsWith('Compose a committee recommendation')) {
      return `Stub committee recommendation — recommend conditional approval subject to ${fmtUsd(LOAN - lPrimeBisect)} proceeds reduction (DSCR-driven cut to ${fmtUsd(lPrimeBisect)}) + the composed structural conditions.`;
    }
    return 'Stub response.';
  };
  const proposalSetBody = {
    adjustedInputsId: ai.id,
    handbookEvaluationId: 'HE_STUB' as HandbookEvaluationId,
    mitigationEngineVersion: MITIGATION_ENGINE_VERSION,
    proposals,
  };
  const mitigationProposalSet: MitigationProposalSet = {
    id: computeMitigationProposalSetId(proposalSetBody),
    ...proposalSetBody,
  };
  const stubHandbook: HandbookEvaluation = {
    id: 'HE_STUB' as HandbookEvaluationId,
    analysisAsOfDate: '2026-06-12T00:00:00Z' as any,
    adjustedInputsId: ai.id,
    handbookVersion: '2026.1',
    firedFlags: [],
    skippedPrinciples: [],
    handbookEngineVersion: '1.0' as any,
  } as unknown as HandbookEvaluation;
  const narrative = await buildNarrative({
    handbookEvaluation: stubHandbook,
    adjustedInputsId: ai.id,
    analysisAsOfDate: '2026-06-12T00:00:00Z' as any,
    dataConfidence: 'validated' as any,
    dataQualityFlags: [],
    mitigationProposalSet,
    dealResult,
    composedMitigationPackage: composed,
  }, { llmCall: stubLlm });
  const html = buildCommitteeMemo({
    dealName: 'Synthetic Hotel (DSCR-binding)',
    memoDate: '2026-06-12',
    narrative, dealResult, composedMitigationPackage: composed,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`Memo written: ${OUT_HTML}  (${html.length.toLocaleString()} bytes)`);
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
