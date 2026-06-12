/**
 * Composition-engine validation — Sunroad at two subtypes.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-composition-engine-sunroad.ts
 *
 * What this validates:
 *   - PARTITION: reduce_proceeds + require_amortization composed sequentially
 *     (de-levering); guaranty / springing / etc. stacked orthogonally.
 *   - DE-LEVERING (Sunroad CBD): the proceeds cut FULLY cures exit DSCR.
 *     Standalone amortization → $0 in the composed package (the lender's
 *     reconciliation says exactly why it dropped).
 *   - DE-LEVERING (Sunroad Medical): the proceeds cut SHRINKS the exit gap
 *     but doesn't close it. Composed amortization carries a smaller
 *     RESIDUAL paydown sized off L', not the original loan.
 *   - ORTHOGONAL: guaranty stacks unchanged; its NW × loan + liquidity % of
 *     loan covenants resolve to dollar magnitudes against L' (not the
 *     original loan) in the reconciliation.
 *   - The composition layer does NOT call any per-lever builder; it only
 *     calls produceMitigations + the harness recompute callback. "What fires"
 *     stays separate from "how they compose".
 *
 * Sunroad-resolved profile (same as dim-4 / dim-7 harnesses):
 *   loanAmount BASE       $82,460,000
 *   uwY1Noi (issuer)      $10,172,319.74
 *   Office NCF/NOI 0.89   → sustainableNcf $9.05M
 *   stressed refi const   10.00% (Office, asset-keyed)
 *   coupon                7.90%, IO 5yr / 5yr term
 *   Office cap floors     CBD 9.00%, suburban 8.50%, medical 7.75%
 *
 * Expected (analytic):
 *   CBD:
 *     dim-7 stressedValue = 9.05 / 0.09 = $100.59M
 *     stressedLtv         = 82.46 / 100.59 = 0.820 > 0.70 → reduce_proceeds LTV arm fires
 *     L'_LTV              = 0.68 × 100.59 = $68.40M
 *     requiredEquity      = 82.46 - 68.40 = $14.06M
 *     exit DSCR at L'     = 9.05 / (0.10 × 68.40) = 1.323 ≥ 1.20 → amortization DROPS
 *
 *   Medical:
 *     dim-7 stressedValue = 9.05 / 0.0775 = $116.79M
 *     stressedLtv         = 82.46 / 116.79 = 0.7061 > 0.70 → reduce_proceeds LTV arm fires
 *     L'_LTV              = 0.68 × 116.79 = $79.42M
 *     requiredEquity      = 82.46 - 79.42 = $3.04M
 *     exit DSCR at L'     = 9.05 / (0.10 × 79.42) = 1.140 < 1.20 → amortization STILL fires
 *     B_target at L'      = 9.05 / (0.10 × 1.25) = $72.43M
 *     residual paydown    = 79.42 - 72.43 = $6.99M
 *
 * Composition narrative for the lender:
 *   CBD:   "Proceeds cut $14.06M to L' = $68.40M; standalone amortization $10.03M → $0."
 *   Med:   "Proceeds cut $3.04M  to L' = $79.42M; standalone amortization $10.03M → $6.99M residual."
 */
import { fileURLToPath } from 'node:url';
import {
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import {
  DEFAULT_MITIGATION_DESK,
} from '../services/mitigation/produce-mitigations.js';
import type { AdjustedInputs, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

/* ---------------- Sunroad-resolved profile (subtype-agnostic) ------------- */

const SUNROAD = {
  assetType: 'Office' as const,
  uwY1Noi: 10_172_319.74,
  ncfNoiRatio: 0.89,
  capRateByOfficeSubtype: {
    CBD:       0.0900,
    suburban:  0.0850,
    medical:   0.0775,
    _default:  0.0900,
  },
  coupon: 0.079,
  amortMonths: 0,        // IO
  ioYears: 5,
  termYears: 5,
  marketTier: 'Unknown' as const,
  judgmentConcludedValue: 126_200_362,
  realLoanAmount: 82_460_000,
};

const sustainableNcf = SUNROAD.uwY1Noi * SUNROAD.ncfNoiRatio;

/* ----------- AdjustedInputs / UnderwritingModel / DealBag builders -------- */

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

/**
 * Construct AdjustedInputs at a given loan size. Loan-derived fields
 * (debtService, maturity balance, DSCR, debtYield) are recomputed from
 * the loan size + the FIXED Sunroad cashflow. Asset / cashflow fields
 * pass through unchanged.
 */
function buildAi(loanAmount: number): AdjustedInputs {
  // IO loan: debtService = loan × coupon; maturity balance = loan.
  const debtServiceAnnual = loanAmount * SUNROAD.coupon;
  const dscr = sustainableNcf / debtServiceAnnual;
  const debtYield = SUNROAD.uwY1Noi / loanAmount;
  return {
    id: 'AI_COMPOSE_CAL' as any, analysisAsOfDate: '2026-05-31T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, 13_628_082) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: {
      loanAmount: li(loanAmount, loanAmount),
      interestRate: li(SUNROAD.coupon, SUNROAD.coupon),
      termMonths: li(SUNROAD.termYears * 12, SUNROAD.termYears * 12),
      amortizationMonths: li(SUNROAD.amortMonths, SUNROAD.amortMonths),
      ioPeriodMonths: li(SUNROAD.ioYears * 12, SUNROAD.ioYears * 12),
      maturityBalance: li(null, loanAmount),
      maturityDate: '2031-05-31T00:00:00Z' as any,
      debtServiceAnnual: li(null, debtServiceAnnual),
    },
    assumptions: { capRate: li(0.0675, 0.0675), terminalCapRate: li(0.08, 0.08), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
    metrics: {
      noi: SUNROAD.uwY1Noi,
      value: SUNROAD.judgmentConcludedValue,
      dscr,
      ltvAppraisal: null,                   // dim 7 path is preferred by the LTV arm
      debtYield,
      expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
    },
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}

function liField(id: string, label: string, amt: number): any {
  return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt };
}

function buildUw(loanAmount: number): UnderwritingModel {
  const egi = 13_628_082;
  const noi = SUNROAD.uwY1Noi;
  const toe = egi - noi;
  const annualDebtService = loanAmount * SUNROAD.coupon;
  const dscr = noi / annualDebtService;
  const debtYield = noi / loanAmount;
  // Legacy LTV basis — the LTV arm prefers dim 7's stressedValue when
  // available; impliedValue is the fallback. We pin it conservatively (real
  // appraisal-equivalent) so the legacy fallback agrees with the doctrine.
  const impliedValueLegacy = SUNROAD.judgmentConcludedValue;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.0675, impliedValue: impliedValueLegacy, loanAmount,
    interestRate: SUNROAD.coupon * 100, amortizationYears: 0, termYears: SUNROAD.termYears,
    annualDebtService, dscr, ltv: loanAmount / impliedValueLegacy, debtYield,
    asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: SUNROAD.coupon * 100, rateType: 'fixed', ioMonths: SUNROAD.ioYears * 12, amortizationMonths: SUNROAD.amortMonths, termMonths: SUNROAD.termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-05-31', maturityDate: '2031-05-31' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

function mkDealBag(loanAmount: number, subType: string): DealBag {
  return {
    propertyName: 'Sunroad Centrum (synthetic resolution)',
    assetType: SUNROAD.assetType,
    subType,
    loanAmount,
    coupon: SUNROAD.coupon,
    concludedValue: SUNROAD.judgmentConcludedValue,
    uwY1Noi: SUNROAD.uwY1Noi,
    t12Noi: null,
    underwrittenOccupancy: null,
    largestTenantPct: null,
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: SUNROAD.amortMonths,
    ioYears: SUNROAD.ioYears,
    termYears: SUNROAD.termYears,
    marketTier: SUNROAD.marketTier,
  };
}

/** Per-subtype state-builder closure: same Sunroad shape, different subType. */
function makeStateBuilder(subType: string): (loanAmount: number) => DealComputeState {
  return (loanAmount: number): DealComputeState => {
    const ai = buildAi(loanAmount);
    const uw = buildUw(loanAmount);
    const dealBag = mkDealBag(loanAmount, subType);
    const dealResult = evaluateDeal(dealBag);
    return { adjustedInputs: ai, uwModel: uw, dealResult };
  };
}

/* ------------------------------- formatting ------------------------------- */

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function reportSubtype(label: string, subType: string): void {
  console.log('================================================================');
  console.log(`SUNROAD ${label.toUpperCase()}  (subType=${subType}; loan=${fmtUsd(SUNROAD.realLoanAmount)})`);
  console.log('================================================================');

  const buildState = makeStateBuilder(subType);
  const baseline = buildState(SUNROAD.realLoanAmount);

  /* ---- baseline diagnostics: what the doctrine sees pre-composition ---- */
  const dim7 = baseline.dealResult.dimensions.capRateValuationStress;
  const dim4 = baseline.dealResult.dimensions.refinanceFeasibility;
  const stressedValue = (dim7.derivedOutputs?.stressedValue as number | null | undefined) ?? null;
  const stressedLtv = (dim7.derivedOutputs?.stressedLtv as number | null | undefined) ?? null;
  const exitDscr = (dim4.derivedOutputs?.exitDscr as number | null | undefined) ?? null;
  console.log('');
  console.log('Baseline doctrine signals (at original loan):');
  console.log(`  cap floor                ${(SUNROAD.capRateByOfficeSubtype[subType as 'CBD' | 'suburban' | 'medical'] * 100).toFixed(2)}%`);
  console.log(`  dim-7 stressedValue      ${stressedValue !== null ? fmtUsd(stressedValue) : 'null'}`);
  console.log(`  dim-7 stressedLtv        ${stressedLtv !== null ? stressedLtv.toFixed(4) : 'null'}  (T_LTV_TRIGGER ${DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER})`);
  console.log(`  dim-4 exit DSCR          ${exitDscr !== null ? exitDscr.toFixed(3) : 'null'}  (TRIGGER 1.20, CURE_TARGET ${DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET})`);
  console.log(`  baseline ai.metrics.dscr ${(baseline.adjustedInputs.metrics.dscr as number).toFixed(3)} (T_DSCR ${DEFAULT_MITIGATION_DESK.T_DSCR})`);
  console.log(`  baseline ai.metrics.debtYield ${((baseline.adjustedInputs.metrics.debtYield as number) * 100).toFixed(2)}% (T_DY ${(DEFAULT_MITIGATION_DESK.T_DY * 100).toFixed(2)}%)`);

  /* ---- compose ---- */
  const result = composeMitigations({
    adjustedInputs: baseline.adjustedInputs,
    uwModel: baseline.uwModel,
    dealResult: baseline.dealResult,
    firedFlags: [],
    recomputeAtLoan: buildState,
  });

  /* ---- baseline (pre-composition) lever list ---- */
  console.log('');
  console.log('BASELINE proposals (produceMitigations on original loan):');
  if (result.initialProposals.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of result.initialProposals) {
      const extra =
        p.lever === 'reduce_proceeds'    ? ` requiredEquity=${fmtUsd(p.requiredEquity ?? NaN)} (target ${p.targetMetric ?? '—'})`
      : p.lever === 'require_amortization' ? ` requiredPaydown=${fmtUsd(p.requiredPaydown ?? NaN)} → B_target ${fmtUsd((p as any).targetMaturityBalance ?? NaN)}`
      : '';
      console.log(`  - ${p.id ?? '?'}  [${p.lever}]${extra}`);
    }
  }

  /* ---- composed lever list ---- */
  console.log('');
  console.log(`COMPOSED proposals (final L' = ${fmtUsd(result.finalLoanAmount)}):`);
  if (result.proposals.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of result.proposals) {
      const extra =
        p.lever === 'reduce_proceeds'    ? ` requiredEquity=${fmtUsd(p.requiredEquity ?? NaN)}`
      : p.lever === 'require_amortization' ? ` requiredPaydown=${fmtUsd(p.requiredPaydown ?? NaN)} → B_target ${fmtUsd((p as any).targetMaturityBalance ?? NaN)}`
      : '';
      console.log(`  - ${p.id ?? '?'}  [${p.lever}]${extra}`);
    }
  }

  /* ---- reconciliation ---- */
  const r = result.reconciliation;
  console.log('');
  console.log('RECONCILIATION:');
  console.log(`  original loan           ${fmtUsd(r.originalLoanAmount)}`);
  console.log(`  final loan (L')         ${fmtUsd(r.finalLoanAmount)}`);
  console.log(`  proceeds reduction      ${fmtUsd(r.proceedsReduction)}`);
  console.log(`  standalone amort paydown ${r.standaloneAmortPaydown !== null ? fmtUsd(r.standaloneAmortPaydown) : '—'}`);
  console.log(`  composed  amort paydown ${r.composedAmortPaydown !== null ? fmtUsd(r.composedAmortPaydown) : '—  (dropped)'}`);
  console.log('  notes:');
  for (const n of r.notes) console.log(`    • ${n}`);
  if (r.covenantMagnitudesAtFinalLoan.length > 0) {
    console.log('  orthogonal covenant magnitudes (resolved against L\'):');
    for (const c of r.covenantMagnitudesAtFinalLoan) {
      console.log(`    ${c.lever} (${c.leverId}):`);
      for (const line of c.resolvedMagnitudes) console.log(`      ${line}`);
    }
  }

  /* ---- final-state verification ---- */
  const fai = result.finalState.adjustedInputs;
  const fdim4 = result.finalState.dealResult.dimensions.refinanceFeasibility;
  const fdim7 = result.finalState.dealResult.dimensions.capRateValuationStress;
  const fexit = (fdim4.derivedOutputs?.exitDscr as number | null | undefined) ?? null;
  const fStressLtv = (fdim7.derivedOutputs?.stressedLtv as number | null | undefined) ?? null;
  console.log('');
  console.log('FINAL-STATE doctrine signals (at L\'):');
  console.log(`  dim-7 stressedLtv at L'  ${fStressLtv !== null ? fStressLtv.toFixed(4) : 'null'}  (TRIGGER ${DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER})`);
  console.log(`  dim-4 exit DSCR at L'    ${fexit !== null ? fexit.toFixed(3) : 'null'}  (TRIGGER 1.20)`);
  console.log(`  ai.metrics.dscr at L'    ${(fai.metrics.dscr as number).toFixed(3)}`);
  console.log(`  ai.metrics.debtYield     ${((fai.metrics.debtYield as number) * 100).toFixed(2)}%`);
  console.log('');
}

function main(): void {
  console.log('================================================================');
  console.log('COMPOSITION ENGINE VALIDATION — Sunroad at two Office subtypes');
  console.log('================================================================');
  console.log('');
  console.log('Engine boundary:');
  console.log('  composeMitigations() lives in services/mitigation/compose-mitigations.ts.');
  console.log('  It calls produceMitigations() twice (baseline + recomputed) and partitions');
  console.log('  fired levers into DE-LEVERING (reduce_proceeds, require_amortization) and');
  console.log('  ORTHOGONAL (guaranty / springing / lockbox / fund_reserve / CP). Sequential');
  console.log('  single-pass resolution; no iteration (proceeds cut is monotonic).');
  console.log('');
  console.log('Sunroad inputs (held constant across subtypes):');
  console.log(`  loanAmount         ${fmtUsd(SUNROAD.realLoanAmount)}`);
  console.log(`  uwY1Noi            ${fmtUsd(SUNROAD.uwY1Noi)}`);
  console.log(`  NCF/NOI            ${SUNROAD.ncfNoiRatio}  → sustainableNcf ${fmtUsd(sustainableNcf)}`);
  console.log(`  coupon             ${(SUNROAD.coupon * 100).toFixed(2)}%  IO ${SUNROAD.ioYears}yr / term ${SUNROAD.termYears}yr`);
  console.log(`  Office cap floors  CBD 9.00% / medical 7.75%`);
  console.log(`  refi const         10.00% (Office, asset-keyed)`);
  console.log('');

  reportSubtype('CBD (proceeds cut should FULLY cure exit DSCR)',     'CBD');
  reportSubtype('Medical (proceeds cut should leave a RESIDUAL gap)', 'medical');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
