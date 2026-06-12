/**
 * Synthetic DY-binding deal — observe current behavior and the
 * compose-mitigations.ts diagnostic-label bug.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-dy-binding-synthetic.ts
 *
 * What this validates:
 *   PART A — Empirical: the Office anchor (NOI $8M, loan $105M, appraisal $140M)
 *            does NOT route DY-only. dim-7 computes stressedValue = NCF / cap_floor
 *            (the appraisal is only a comparator for valuation aggressiveness),
 *            so stressedLtv ~1.33 dwarfs the ceiling and the LTV arm wins on
 *            smallest-L'.
 *   PART B — Multifamily-anchored synthetic where DY is the SOLE breach.
 *            Multifamily's cap floor (0.065) + NCF/NOI (0.95) opens a narrow
 *            window where stressedLtv lands mid-band while DY breaches.
 *            stressedRefiConstant is overridden (per-deal contract input, NOT
 *            a doctrine change) so exit DSCR is clean and the amortization
 *            lever doesn't shadow the DY-arm cut.
 *   PART C — Surface the compose-mitigations.ts:279 diagnostic bug live:
 *            the cut-candidate source label hardcodes "LTV above ceiling"
 *            regardless of the binding metric.
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
} from '../services/mitigation/produce-mitigations.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import { buildNarrative } from '../services/narrative/build-narrative.js';
import { computeMitigationProposalSetId } from '../util/content-hash.js';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  HandbookEvaluation,
  HandbookEvaluationId,
  MitigationProposalSet,
} from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

const OUT_HTML = path.resolve('/tmp/synthetic-mf-dy-memo.html');

/* -------------------- helpers -------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(d) + '%';
}
function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(3) + 'x';
}

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

function buildAi(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number, egi: number, dscr: number, debtYield: number): AdjustedInputs {
  return {
    id: 'AI_SYNTH_DY' as any, analysisAsOfDate: '2026-06-12T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, egi) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: {
      loanAmount: li(loanAmount, loanAmount),
      interestRate: li(coupon, coupon),
      termMonths: li(termYears * 12, termYears * 12),
      amortizationMonths: li(0, 0),
      ioPeriodMonths: li(ioYears * 12, ioYears * 12),
      maturityBalance: li(null, loanAmount),
      maturityDate: '2031-06-12T00:00:00Z' as any,
      debtServiceAnnual: li(null, loanAmount * coupon),
    },
    assumptions: { capRate: li(0.06, 0.06), terminalCapRate: li(0.07, 0.07), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
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
function buildUw(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number, egi: number): UnderwritingModel {
  const toe = egi - noi;
  const annualDebtService = loanAmount * coupon;
  const dscr = noi / annualDebtService;
  const debtYield = noi / loanAmount;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.06, impliedValue: valueForLegacyLtv, loanAmount,
    interestRate: coupon * 100, amortizationYears: 0, termYears, annualDebtService, dscr,
    ltv: loanAmount / valueForLegacyLtv, debtYield, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: coupon * 100, rateType: 'fixed', ioMonths: ioYears * 12, amortizationMonths: 0, termMonths: termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-06-12', maturityDate: '2031-06-12' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

function makeDealBag(opts: {
  name: string;
  assetType: 'Office' | 'Multifamily';
  loan: number;
  coupon: number;
  noi: number;
  concludedValue: number;
  termYears: number; ioYears: number;
  stressedRefiConstant?: number | null;
}): DealBag {
  return {
    propertyName: opts.name,
    assetType: opts.assetType,
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
    amortMonths: 0,
    ioYears: opts.ioYears,
    termYears: opts.termYears,
    marketTier: 'Unknown',
    stressedRefiConstant: opts.stressedRefiConstant ?? null,
  } as DealBag;
}

/* ============================== PART A ==================================== */

function partA_OfficeAnchorRoutesLTV(): void {
  console.log('================================================================');
  console.log("PART A — Office anchor empirical: does it route DY-only? (NO — LTV wins)");
  console.log('================================================================');
  console.log('');
  const NOI = 8_000_000, LOAN = 105_000_000, RATE = 0.055, APPRAISAL = 140_000_000;
  const EGI = NOI * 1.7;
  const dealBag = makeDealBag({
    name: 'Synthetic Office (DY-routing attempt)',
    assetType: 'Office', loan: LOAN, coupon: RATE, noi: NOI, concludedValue: APPRAISAL,
    termYears: 5, ioYears: 5,
  });
  const dealResult = evaluateDeal(dealBag);
  const dim7 = dealResult.dimensions.capRateValuationStress;
  const stressedValue = dim7.derivedOutputs?.stressedValue as number;
  const stressedLtv  = dim7.derivedOutputs?.stressedLtv as number;
  const ds = LOAN * RATE;
  const dscr = NOI / ds;
  const dy = NOI / LOAN;
  console.log('Inputs:');
  console.log(`  assetType                : Office`);
  console.log(`  NOI                      : ${fmtUsd(NOI)}`);
  console.log(`  loan                     : ${fmtUsd(LOAN)}`);
  console.log(`  coupon                   : ${fmtPct(RATE)}  (IO ${5}yr / term ${5}yr)`);
  console.log(`  operator concludedValue  : ${fmtUsd(APPRAISAL)}  ← does NOT enter stressedLtv math`);
  console.log('');
  console.log('Doctrine output (dim 7):');
  console.log(`  sustainable NCF          : ${fmtUsd(dealResult.normalization.sustainableNcf)}`);
  console.log(`  Office cap floor (going-in): ${fmtPct(0.09)}`);
  console.log(`  stressedValue (NCF / cap_floor) : ${fmtUsd(stressedValue)}  ← NOT the $140M appraisal`);
  console.log(`  stressedLtv (loan / stressedValue): ${fmtPct(stressedLtv)}  ← way above 0.80 Office ceiling`);
  console.log(`  concludedValue (comparator only): ${fmtUsd(APPRAISAL)} → valuationAggressiveness ${fmtPct(((APPRAISAL - stressedValue) / APPRAISAL))} (informational)`);
  console.log('');
  console.log('Lever breach detection:');
  const officeCeiling = resolveLtvStructuredCeiling('Office');
  const ltvBreached = stressedLtv > DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
  const dscrBreached = dscr < DEFAULT_MITIGATION_DESK.T_DSCR;
  const dyBreached = dy < DEFAULT_MITIGATION_DESK.T_DY;
  console.log(`  DSCR ${fmtDscr(dscr)} < ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)} ? ${dscrBreached ? 'breached' : 'PASSES'}`);
  console.log(`  DY   ${fmtPct(dy)} < ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} ? ${dyBreached ? 'BREACHED' : 'PASSES'}`);
  console.log(`  LTV  ${fmtPct(stressedLtv)} > ${fmtPct(DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER)} ? ${ltvBreached ? 'BREACHED' : 'PASSES'}  (Office ceiling ${fmtPct(officeCeiling)}; ${stressedLtv > officeCeiling ? 'BEYOND-CEILING — LTV arm cuts to ceiling' : 'mid-band — LTV arm skips'})`);
  console.log('');
  // Hand-compute each arm's L'
  const lPrimeLtv = officeCeiling * stressedValue;
  const lPrimeDy = NOI / DEFAULT_MITIGATION_DESK.T_DY;
  const lPrimeDscr = NOI / (DEFAULT_MITIGATION_DESK.T_DSCR * RATE);
  console.log("Per-arm L' (each arm sizes independently; smallest wins):");
  console.log(`  LTV arm     L' = ceiling × stressedValue       = ${fmtPct(officeCeiling)} × ${fmtUsd(stressedValue)} = ${fmtUsd(lPrimeLtv)}`);
  console.log(`  DY arm      L' = NOI / T_DY                    = ${fmtUsd(NOI)} / ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} = ${fmtUsd(lPrimeDy)}`);
  console.log(`  DSCR arm    L' = NOI / (T_DSCR × rate)         = ${fmtUsd(NOI)} / (${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)} × ${fmtPct(RATE)}) = ${fmtUsd(lPrimeDscr)} (n/a — DSCR not breached)`);
  console.log('');
  console.log(`Binding constraint (smallest L'): ${lPrimeLtv < lPrimeDy ? 'LTV ' + fmtUsd(lPrimeLtv) : 'DY ' + fmtUsd(lPrimeDy)} — ${lPrimeLtv < lPrimeDy ? 'LTV arm wins; DY arm does NOT bind' : 'DY arm wins'}`);
  console.log('');
  // Actual produce-mitigations call
  const ai = buildAi(LOAN, RATE, 5, 5, NOI, APPRAISAL, EGI, dscr, dy);
  const uw = buildUw(LOAN, RATE, 5, 5, NOI, APPRAISAL, EGI);
  const proposals = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult });
  const reduce = proposals.find(p => p.lever === 'reduce_proceeds');
  console.log(`Actual reduce_proceeds proposal: id="${reduce?.id ?? '—'}", targetMetric="${(reduce as any)?.targetMetric ?? '—'}", requiredEquity=${fmtUsd((reduce as any)?.requiredEquity)}`);
  console.log('');
  console.log('✓ Office anchor routes LTV-binding, NOT DY-binding. Pivoting to Multifamily for DY-only routing.');
  console.log('');
}

/* ============================== PART B ==================================== */

async function partB_MultifamilyDYOnly(): Promise<void> {
  console.log('================================================================');
  console.log('PART B — Multifamily synthetic: DY is the SOLE binding constraint');
  console.log('================================================================');
  console.log('');
  // Multifamily cap floor 0.065, NCF/NOI 0.95.
  // Window: DY ∈ [0.0805, 0.085) where DY breaches AND stressedLtv ≤ 0.85 ceiling.
  // Pick DY = 0.082. NOI $8M ⇒ loan = $8M/0.082 = $97.56M.
  // Override stressedRefiConstant 0.06 so exit DSCR is clean (else amortization
  // fallback would shadow the DY-arm cut in composeMitigations).
  const NOI = 8_000_000;
  const LOAN = 97_560_000;       // ⇒ DY = 0.0820
  const RATE = 0.055;            // ⇒ DSCR (UW) = NOI / (loan × rate) = 8/5.366 = 1.49 → clean
  const APPRAISAL = 140_000_000;
  const EGI = NOI * 1.7;
  const RC_OVERRIDE = 0.06;
  const dealBag = makeDealBag({
    name: 'Synthetic Multifamily (DY-binding)',
    assetType: 'Multifamily', loan: LOAN, coupon: RATE, noi: NOI, concludedValue: APPRAISAL,
    termYears: 5, ioYears: 5,
    stressedRefiConstant: RC_OVERRIDE,
  });
  const dealResult = evaluateDeal(dealBag);
  const dim7 = dealResult.dimensions.capRateValuationStress;
  const dim4 = dealResult.dimensions.refinanceFeasibility;
  const stressedValue = dim7.derivedOutputs?.stressedValue as number;
  const stressedLtv  = dim7.derivedOutputs?.stressedLtv as number;
  const exitDscrRaw = dim4.derivedOutputs?.exitDscr as number;
  const ds = LOAN * RATE;
  const dscr = NOI / ds;
  const dy = NOI / LOAN;
  console.log('Inputs (the DY-only construction):');
  console.log(`  assetType                : Multifamily`);
  console.log(`  NOI                      : ${fmtUsd(NOI)}`);
  console.log(`  loan                     : ${fmtUsd(LOAN)}`);
  console.log(`  coupon                   : ${fmtPct(RATE)}  (IO 5yr / term 5yr)`);
  console.log(`  concludedValue           : ${fmtUsd(APPRAISAL)}`);
  console.log(`  stressedRefiConstant (override): ${fmtPct(RC_OVERRIDE)}  ← per-deal CONTRACT input on DealBag (not a doctrine change)`);
  console.log('');
  console.log('Doctrine signals:');
  console.log(`  sustainable NCF          : ${fmtUsd(dealResult.normalization.sustainableNcf)}  (Multifamily NCF/NOI 0.95)`);
  console.log(`  Multifamily cap floor    : ${fmtPct(0.065)}`);
  console.log(`  dim-7 stressedValue      : ${fmtUsd(stressedValue)}  (NCF / cap_floor)`);
  console.log(`  dim-7 stressedLtv        : ${fmtPct(stressedLtv)}`);
  console.log(`  dim-4 exit DSCR (raw)    : ${fmtDscr(exitDscrRaw)}  (NCF / (${fmtPct(RC_OVERRIDE)} × loan))`);
  console.log(`  Day-1 DSCR (NOI / DS)    : ${fmtDscr(dscr)}`);
  console.log(`  DY                       : ${fmtPct(dy)}`);
  console.log('');
  // Band classifications
  const mfCeiling = resolveLtvStructuredCeiling('Multifamily');
  console.log('Band classifications:');
  console.log(`  LTV: ${fmtPct(stressedLtv)} vs trigger ${fmtPct(DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER)} / ceiling ${fmtPct(mfCeiling)} → ${stressedLtv > DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER && stressedLtv <= mfCeiling ? 'MID-BAND (LTV arm SKIPS reduce_proceeds; leverage_band_recourse fires instead)' : stressedLtv > mfCeiling ? 'BEYOND-CEILING' : 'CLEAN'}`);
  console.log(`  Exit DSCR (raw): ${fmtDscr(exitDscrRaw)} vs trigger ${fmtDscr(1.20)} → ${exitDscrRaw >= 1.20 ? 'CLEAN (amortization does NOT fire)' : 'breach'}`);
  console.log(`  Day-1 DSCR: ${fmtDscr(dscr)} vs T_DSCR ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)} → ${dscr >= DEFAULT_MITIGATION_DESK.T_DSCR ? 'CLEAN (DSCR arm does NOT fire)' : 'BREACHED'}`);
  console.log(`  DY: ${fmtPct(dy)} vs T_DY ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} → ${dy < DEFAULT_MITIGATION_DESK.T_DY ? 'BREACHED — DY arm pushes to breaches[]' : 'CLEAN'}`);
  console.log('');
  console.log("Per-arm L' (hand-check):");
  const lPrimeDY = NOI / DEFAULT_MITIGATION_DESK.T_DY;
  console.log(`  DY arm    L' = NOI / T_DY = ${fmtUsd(NOI)} / ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)} = ${fmtUsd(lPrimeDY)}`);
  console.log(`  LTV arm   SKIPPED (mid-band; leverage_band_recourse handles structurally)`);
  console.log(`  DSCR arm  SKIPPED (Day-1 DSCR ${fmtDscr(dscr)} ≥ ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)})`);
  console.log('');
  const equity = LOAN - lPrimeDY;
  console.log(`Predicted cut: ${fmtUsd(equity)} (loan ${fmtUsd(LOAN)} → L' ${fmtUsd(lPrimeDY)}, DY at L' = ${fmtPct(NOI / lPrimeDY)})`);
  console.log('');
  // Actual produce + compose
  const ai = buildAi(LOAN, RATE, 5, 5, NOI, APPRAISAL, EGI, dscr, dy);
  const uw = buildUw(LOAN, RATE, 5, 5, NOI, APPRAISAL, EGI);
  const proposals = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult });
  const reduce = proposals.find(p => p.lever === 'reduce_proceeds');
  console.log('Actual reduce_proceeds proposal:');
  console.log(`  id            = "${reduce?.id ?? '—'}"`);
  console.log(`  targetMetric  = "${(reduce as any)?.targetMetric ?? '—'}"`);
  console.log(`  requiredEquity= ${fmtUsd((reduce as any)?.requiredEquity)}`);
  console.log(`  ${reduce?.id === 'reduce_proceeds_debtYield' ? '✓ DY arm fires (single binding metric in breaches[])' : '✗ Different arm fired — investigate'}`);
  console.log('');

  // Compose end-to-end
  const composed = composeMitigations({
    adjustedInputs: ai, uwModel: uw, dealResult, firedFlags: [],
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const newBag = { ...dealBag, loanAmount: newLoan };
      const newDealResult = evaluateDeal(newBag);
      const newDs = newLoan * RATE;
      const newDscr = NOI / newDs;
      const newDy = NOI / newLoan;
      return {
        adjustedInputs: buildAi(newLoan, RATE, 5, 5, NOI, APPRAISAL, EGI, newDscr, newDy),
        uwModel: buildUw(newLoan, RATE, 5, 5, NOI, APPRAISAL, EGI),
        dealResult: newDealResult,
      };
    },
  });
  console.log('================================================================');
  console.log('COMPOSED PACKAGE');
  console.log('================================================================');
  console.log('');
  console.log(`  final loan (L')  : ${fmtUsd(composed.finalLoanAmount)}`);
  console.log(`  proceeds cut     : ${fmtUsd(composed.reconciliation.proceedsReduction)}`);
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
  console.log('  Reconciliation notes (LOOK FOR THE BUG):');
  for (const n of composed.reconciliation.notes) console.log(`    • ${n}`);
  console.log('');

  // Final-state signals
  const fs7 = composed.finalState.dealResult.dimensions.capRateValuationStress;
  const finalStressedLtv = fs7.derivedOutputs?.stressedLtv as number;
  console.log('Final-state signals (post-cut):');
  console.log(`  loan at L'                 : ${fmtUsd(composed.finalLoanAmount)}`);
  console.log(`  stressedLtv at L'          : ${fmtPct(finalStressedLtv)}  ${finalStressedLtv > DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER && finalStressedLtv <= mfCeiling ? '(still mid-band — leverage_band_recourse re-fires)' : finalStressedLtv <= DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER ? '(below trigger — no LTV mid-band lever)' : '(beyond ceiling)'}`);
  console.log(`  Day-1 DSCR at L'           : ${fmtDscr(NOI / (composed.finalLoanAmount * RATE))}`);
  console.log(`  DY at L'                   : ${fmtPct(NOI / composed.finalLoanAmount)}  (target ${fmtPct(DEFAULT_MITIGATION_DESK.T_DY)})`);
  console.log('');

  // Sponsor burden
  const b = composed.sponsorBurdenProfile;
  console.log('================================================================');
  console.log('SPONSOR BURDEN PROFILE');
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
  console.log(`  Threshold                  : ${fmtPct(b.flagThreshold, 0)}`);
  console.log(`  Flag                       : ${b.flagsBurden ? '⚑ FLAGGED' : '✓ below threshold'}`);
  if (b.flagCopy) console.log(`    > ${b.flagCopy}`);
  console.log('');

  // Render memo via buildCommitteeMemo (skip live LLM; use stub for routing-focused harness).
  // The narrative slots receive a deterministic stub since the routing is the question;
  // the v1.6 prompt machinery is exercised the same way.
  const stubLlm: any = async ({ messages }: { messages: Array<{ content: string }> }) => {
    const userMsg = messages?.[0]?.content ?? '';
    if (userMsg.startsWith('Compose a single executive-summary paragraph')) {
      return `Stub executive summary — synthetic Multifamily DY-binding deal; recommend ApproveWithConditions with proceeds reduction of ${fmtUsd(equity)} to L' = ${fmtUsd(lPrimeDY)}.`;
    }
    if (userMsg.startsWith('Compose a red-flag assessment')) {
      return '- [dim-3 debt-yield] tier=concerning — DY below floor at original loan.';
    }
    if (userMsg.startsWith('Compose a committee recommendation')) {
      return `Stub committee recommendation — recommend conditional approval subject to ${fmtUsd(equity)} proceeds reduction (DY-driven cut to ${fmtUsd(lPrimeDY)}) + the composed structural conditions.`;
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
    dealName: 'Synthetic Multifamily (DY-binding)',
    memoDate: '2026-06-12',
    narrative, dealResult, composedMitigationPackage: composed,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`Memo written: ${OUT_HTML}  (${html.length.toLocaleString()} bytes)`);
  console.log('');
}

/* ================================ MAIN ==================================== */

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('SYNTHETIC DY-BINDING DEAL — observe + locate the diagnostic bug');
  console.log(`Mitigation engine v${MITIGATION_ENGINE_VERSION}`);
  console.log('================================================================');
  console.log('');
  partA_OfficeAnchorRoutesLTV();
  await partB_MultifamilyDYOnly();
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });
