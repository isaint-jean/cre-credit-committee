/**
 * Lever calibration harness — dim-4 require_amortization, no lever-code changes.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-lever-dim4-require-amortization.ts
 *
 * What this does:
 *   - Feeds Sunroad's resolved profile into evaluateDeal so dim 7 AND dim 4
 *     RESOLVE (concludedValue + stressedValue threaded via the DealBag —
 *     the fence is honored; the adapter is bypassed by constructing the
 *     DealBag directly, same trick as the dim-7 harness).
 *   - Sweeps loanAmount so dim 4's exit DSCR moves 1.40 → 0.90 in ~0.05
 *     increments. exit DSCR = sustainableNCF / (stressedRefiConstant ×
 *     maturityBalance). For an IO loan, maturityBalance = loanAmount, so
 *     varying loanAmount is the cleanest way to walk the curve. NCF and
 *     stressed refi constant are held fixed across the sweep.
 *   - At each step CALLS THE REAL produceMitigations + buildAmortizationProposal
 *     (no re-implementation). DSCR / DY / stressedLtv are pinned WELL above
 *     desk reduce_proceeds targets so the amortization arm is the only
 *     fireable lever — isolates dim 4's behavior cleanly.
 *   - Reports the resolved cure target the lever sizes to, the implied
 *     amort schedule (years) that produces the maturity balance, and the
 *     paydown required from origination.
 *
 * Sunroad-resolved profile:
 *   loanAmount BASE       $82,460,000   (IO 60mo at 7.9%)
 *   uwY1Noi (issuer)      $10,172,319.74 (sellerUwOperatingStatement.noi)
 *   Office NCF/NOI ratio  0.89          (operator-judgment desk knob)
 *   sustainableNcf        $9,053,364.57 (= uwY1Noi × 0.89; no t12 → no divergence haircut; no occupancy → no vacancy haircut)
 *   stressedRefiConstant  10.00%        (Office asset-keyed; STRESSED_REFI_CONSTANT_BY_ASSET)
 *   stressedCapRate       9.00%         (Office.CBD floor for dim 7 spine)
 *   judgment-side base
 *     concludedValue      $126,200,362  (judgment uwValue at 6.75% cap on $8.52M judgment-NOI)
 *
 * What the lever should do (POST-PARAMETERIZATION):
 *   - EXIT_DSCR_REFINANCEABLE_THRESHOLD = 1.20 (doctrine TRIGGER; dim 4
 *     scores against it, lever fire-gate reads it). Stays in doctrine.
 *   - T_EXIT_DSCR_CURE_TARGET = 1.25 (DESK knob; sizing only).
 *   - Fire when exitDscr < 1.20.
 *   - Size to B_target = sustainableNcf / (stressedRefiConstant × 1.25)
 *     — NOT 1.20. Cure target > trigger means the cured loan lands ABOVE
 *     the doctrine's refinanceable line, not just at it. Mirror of the
 *     dim-7 / reduce_proceeds T_LTV_TRIGGER / T_LTV_TARGET split.
 *   - With trigger != cure target, the first fire row carries a cushion
 *     step ≈ NCF/(rc × trigger) − NCF/(rc × cure_target).
 *
 * Stressed refi constant — STRESSED_REFI_CONSTANT_BY_ASSET (operator-judgment,
 * NOT employer-derived; anchored to KBRA office Watch + DBRS post-GFC
 * stressed take-out convention):
 *   Office     10.00%  (tightened — work-from-home / re-leasing pressure)
 *   _default    9.25%  (agency-convention central value)
 */
import { fileURLToPath } from 'node:url';
import {
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import {
  produceMitigations,
  DEFAULT_MITIGATION_DESK,
  buildAmortizationProposal,
  computeImpliedAmortYearsForBalance,
} from '../services/mitigation/produce-mitigations.js';
import {
  STRESSED_REFI_CONSTANT_BY_ASSET_TABLE,
  STRESSED_REFI_CONSTANT_DEFAULT,
  EXIT_DSCR_REFINANCEABLE_THRESHOLD,
} from '../doctrine-clean/dimensions/refinance-feasibility.js';
import type { AdjustedInputs, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

/* ---------- inputs pinned to the Sunroad-resolved profile ---------- */

const SUNROAD = {
  assetType: 'Office' as const,
  subType: 'CBD' as const,
  uwY1Noi: 10_172_319.74,                       // raw issuer sellerUwOperatingStatement.noi
  ncfNoiRatio: 0.89,                             // OPERATOR-JUDGMENT locked desk knob
  // Office cap-rate floor (subtype map, for dim 7 spine — only needed so dim 7
  // resolves and supplies stressedValue to dim 4). Sunroad is CBD.
  capRateByOfficeSubtype: {
    CBD:       0.0900,
    suburban:  0.0850,
    medical:   0.0775,
    _default:  0.0900,
  },
  coupon: 0.079,                                 // Sunroad coupon
  amortMonths: 0,                                // IO loan
  ioYears: 5,                                    // 60mo IO over 60mo term
  termYears: 5,
  marketTier: 'Unknown' as const,                // 0 bps delta
  judgmentConcludedValue: 126_200_362,           // dim-7 valuation-aggressiveness basis
  realLoanAmount: 82_460_000,                    // Sunroad actual loan
};

const sustainableNcf = SUNROAD.uwY1Noi * SUNROAD.ncfNoiRatio;
const stressedRefiConstantOffice =
  STRESSED_REFI_CONSTANT_BY_ASSET_TABLE.get(SUNROAD.assetType) ?? STRESSED_REFI_CONSTANT_DEFAULT;
const stressedCapRateOffice = SUNROAD.capRateByOfficeSubtype[SUNROAD.subType];
const dim7StressedValueExpected = sustainableNcf / stressedCapRateOffice;

/** loanAmount that produces a given exit DSCR on this profile.
 *  exitDscr = sustainableNcf / (rc × maturityBalance);
 *  IO loan ⇒ maturityBalance = loanAmount. */
function loanForExitDscr(targetExitDscr: number): number {
  return sustainableNcf / (stressedRefiConstantOffice * targetExitDscr);
}

/* ---------- AdjustedInputs / UnderwritingModel stubs ---------- */

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

/** Build AdjustedInputs with DSCR / DY pinned ABOVE desk targets and the
 *  uw value far above any plausible loan-as-LTV concern — so the
 *  amortization arm is the only fireable lever. */
function buildAi(loanAmount: number): AdjustedInputs {
  return {
    id: 'AI_DIM4_CAL' as any, analysisAsOfDate: '2026-05-31T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
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
      debtServiceAnnual: li(null, loanAmount * SUNROAD.coupon),
    },
    assumptions: { capRate: li(0.0675, 0.0675), terminalCapRate: li(0.08, 0.08), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
    metrics: {
      noi: SUNROAD.uwY1Noi,
      value: dim7StressedValueExpected,
      // Pin dscr / debtYield ABOVE desk thresholds. We can't pin ltv via
      // the reduce_proceeds LTV arm directly (it reads from dim 7's
      // stressedValue when dealResult is threaded), so we keep uw.impliedValue
      // very large to ensure the legacy fallback isn't a backdoor breach.
      dscr: 1.50,
      ltvAppraisal: null,
      debtYield: 0.12,
      expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null, trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null, issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null,
    },
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}

function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }

function buildUw(loanAmount: number): UnderwritingModel {
  const egi = 13_628_082;
  const noi = SUNROAD.uwY1Noi;
  const toe = egi - noi;
  // Very high impliedValue so the legacy LTV-arm fallback can't breach in
  // a row where dim 7's stressedValue is also healthy. Amortization arm
  // remains the only fireable lever.
  const impliedValueLegacy = SUNROAD.judgmentConcludedValue * 2;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.0675, impliedValue: impliedValueLegacy, loanAmount, interestRate: SUNROAD.coupon * 100, amortizationYears: 0, termYears: SUNROAD.termYears, annualDebtService: loanAmount * SUNROAD.coupon, dscr: 1.50, ltv: loanAmount / impliedValueLegacy, debtYield: 0.12, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: SUNROAD.coupon * 100, rateType: 'fixed', ioMonths: SUNROAD.ioYears * 12, amortizationMonths: SUNROAD.amortMonths, termMonths: SUNROAD.termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-05-31', maturityDate: '2031-05-31' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/* ---------- harness sweep ---------- */

function mkDealBag(loanAmount: number): DealBag {
  return {
    propertyName: 'Sunroad Centrum (synthetic resolution)',
    assetType: SUNROAD.assetType,
    subType: SUNROAD.subType,
    loanAmount,
    coupon: SUNROAD.coupon,
    concludedValue: SUNROAD.judgmentConcludedValue,  // threaded so dim 7 resolves → stressedValue → dim 4
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

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n: number): string { return (n * 100).toFixed(2) + '%'; }
function fmtNum(n: number, d = 4): string { return n.toFixed(d); }

function evalAndProposal(loanAmount: number) {
  const deal = mkDealBag(loanAmount);
  const dealResult = evaluateDeal(deal);
  const ai = buildAi(loanAmount);
  const uw = buildUw(loanAmount);
  // Full produceMitigations path — picks up dim-4 lever via the wire-in.
  const proposals = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult });
  // Also call buildAmortizationProposal directly as a cross-check (the desk
  // thread is the same DEFAULT_MITIGATION_DESK that produceMitigations uses).
  const direct = buildAmortizationProposal(ai, dealResult, DEFAULT_MITIGATION_DESK);
  const refiDim = dealResult.dimensions.refinanceFeasibility;
  const exitDscr = refiDim.derivedOutputs?.exitDscr as number | null | undefined;
  const stressedRefi = refiDim.derivedOutputs?.stressedRefiConstant as number | null | undefined;
  const maturityBalance = refiDim.derivedOutputs?.maturityBalance as number | null | undefined;
  const amort = proposals.find(p => p.lever === 'require_amortization');
  return { amort, direct, exitDscr, stressedRefi, maturityBalance, refiApplicability: refiDim.applicability };
}

function rowFor(targetExitDscr: number): string {
  const loanAmount = loanForExitDscr(targetExitDscr);
  const { amort, exitDscr, stressedRefi, maturityBalance, refiApplicability } = evalAndProposal(loanAmount);
  let fired = 'no', edge = '—', bTarget = '—', paydown = '—', amortYears = '—', idTag = '—';
  if (refiApplicability !== 'applicable') {
    fired = `refi=${refiApplicability}`;
  } else if (amort) {
    idTag = amort.id ?? '—';
    if (amort.id === 'amortization_refi_insufficient') {
      fired = 'yes'; edge = 'B≤0 (insufficient)'; bTarget = '—'; paydown = '—'; amortYears = '—';
    } else if (amort.id === 'amortization_refi_impractical') {
      fired = 'yes'; edge = '>40yr (impractical)';
      bTarget = fmtUsd((amort as any).targetMaturityBalance ?? NaN);
      paydown = fmtUsd((amort as any).requiredPaydown ?? NaN);
      amortYears = '—';
    } else {
      fired = 'yes';
      bTarget = fmtUsd((amort as any).targetMaturityBalance ?? NaN);
      paydown = fmtUsd((amort as any).requiredPaydown ?? NaN);
      const yrs = computeImpliedAmortYearsForBalance(
        loanAmount, SUNROAD.coupon, SUNROAD.termYears * 12, (amort as any).targetMaturityBalance ?? loanAmount,
      );
      amortYears = yrs !== null ? yrs.toFixed(1) + ' yr' : '—';
    }
  }
  return [
    targetExitDscr.toFixed(3),
    fmtUsd(loanAmount),
    typeof exitDscr === 'number' ? exitDscr.toFixed(3) : 'null',
    typeof stressedRefi === 'number' ? fmtPct(stressedRefi) : 'null',
    typeof maturityBalance === 'number' ? fmtUsd(maturityBalance) : 'null',
    fired, idTag, bTarget, paydown, amortYears, edge,
  ].map(s => String(s).padEnd(20)).join('');
}

function main(): void {
  console.log('================================================================');
  console.log('LEVER CALIBRATION — dim-4 require_amortization');
  console.log('  POST-PARAMETERIZATION — STRESSED_REFI_CONSTANT_BY_ASSET (Office 10.00%)');
  console.log('  EXIT_DSCR_REFINANCEABLE_THRESHOLD 1.20 [doctrine TRIGGER]');
  console.log('  T_EXIT_DSCR_CURE_TARGET            1.25 [desk CURE TARGET]');
  console.log('================================================================');
  console.log('');
  console.log('Sunroad-resolved profile:');
  console.log(`  assetType                 ${SUNROAD.assetType}`);
  console.log(`  subType                   ${SUNROAD.subType}`);
  console.log(`  uwY1Noi (issuer)          ${fmtUsd(SUNROAD.uwY1Noi)}`);
  console.log(`  Office NCF/NOI ratio      ${SUNROAD.ncfNoiRatio}  ← LOCKED DESK KNOB`);
  console.log(`  sustainableNcf            ${fmtUsd(sustainableNcf)} (computed by normalization)`);
  console.log(`  stressed refi constant    ${fmtPct(stressedRefiConstantOffice)} (asset-keyed Office; _default ${fmtPct(STRESSED_REFI_CONSTANT_DEFAULT)})`);
  console.log(`  stressed cap rate (dim 7) ${fmtPct(stressedCapRateOffice)} (Office.CBD floor — only matters so dim 7 resolves)`);
  console.log(`  dim-7 stressedValue       ${fmtUsd(dim7StressedValueExpected)}  ← passed to dim 4`);
  console.log(`  concludedValue threaded   ${fmtUsd(SUNROAD.judgmentConcludedValue)} (so dim 7 resolves)`);
  console.log(`  coupon                    ${fmtPct(SUNROAD.coupon)} IO ${SUNROAD.ioYears}yr term ${SUNROAD.termYears}yr`);
  console.log('');
  console.log('Harness isolation: ai.metrics.dscr=1.50, debtYield=0.12, uw.impliedValue=2× judgmentValue —');
  console.log('  reduce_proceeds arms pinned safe so only the amortization arm can fire.');
  console.log('');
  console.log('Desk thresholds (DEFAULT_MITIGATION_DESK):');
  console.log(`  EXIT_DSCR_REFINANCEABLE_THRESHOLD = ${EXIT_DSCR_REFINANCEABLE_THRESHOLD.toFixed(2)}x  (doctrine; fire-gate; STAYS in doctrine)`);
  console.log(`  T_EXIT_DSCR_CURE_TARGET           = ${DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET.toFixed(2)}x  (desk; lever sizes here)`);
  console.log('');
  console.log('Lever formula:');
  console.log('  exitDscr      = sustainableNCF / (stressedRefiConstant × maturityBalance)');
  console.log('  IO ⇒ maturityBalance = loanAmount');
  console.log('  breach        = exitDscr < 1.20');
  console.log("  B_target      = sustainableNCF / (stressedRefiConstant × 1.25)            ← cure target, not trigger");
  console.log('  requiredPaydown = currentLoan − B_target');
  console.log('  amort schedule = solve A_months s.t. L→B_target at coupon over termMonths');
  console.log('');
  // Expected cushion step at the trigger boundary.
  const bAtTrigger = sustainableNcf / (stressedRefiConstantOffice * EXIT_DSCR_REFINANCEABLE_THRESHOLD);
  const bAtCureTgt = sustainableNcf / (stressedRefiConstantOffice * DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET);
  const cushionStep = bAtTrigger - bAtCureTgt;
  console.log(`Expected cushion step at first-fire (exit DSCR 1.20 → 1.20⁻):`);
  console.log(`  cure-at-trigger  B_trigger = NCF / (10.00% × 1.20) = ${fmtUsd(bAtTrigger)}`);
  console.log(`  cure-at-target   B_target  = NCF / (10.00% × 1.25) = ${fmtUsd(bAtCureTgt)}`);
  console.log(`  cushion step                                       = ${fmtUsd(cushionStep)}`);
  console.log('');
  console.log('SWEEP — vary loanAmount so exit DSCR covers ~1.40 → 0.90');
  console.log('  (subType = CBD; concludedValue $126.20M; DSCR / DY / LTV-arm pinned safe)');
  console.log('');

  /* === HEADER === */
  const hdr = [
    'targetExitDSCR', 'loanAmount', 'exitDSCR (actual)', 'stressedRefi',
    'maturityBalance', 'fired?', 'lever id', 'B_target', 'requiredPaydown', 'impliedAmort', 'edge',
  ];
  console.log(hdr.map(h => h.padEnd(20)).join(''));
  console.log('─'.repeat(20 * hdr.length));

  /* === FULL SWEEP === */
  const targets: number[] = [1.40, 1.35, 1.30, 1.25, 1.21, 1.20, 1.19, 1.15, 1.10, 1.05, 1.00, 0.95, 0.90];
  for (const t of targets) console.log(rowFor(t));
  console.log('');

  /* === BOUNDARY ZOOM around 1.20 === */
  console.log('================================================================');
  console.log(`BOUNDARY ZOOM — rows just on each side of the doctrine TRIGGER (1.20x)`);
  console.log(`  Expected: $0 paydown at/above 1.20 (no fire); first fire row carries the`);
  console.log(`  cushion step ≈ ${fmtUsd(cushionStep)} (paydown from B_trigger → B_target).`);
  console.log('================================================================');
  console.log('');
  console.log(hdr.map(h => h.padEnd(20)).join(''));
  console.log('─'.repeat(20 * hdr.length));
  for (const t of [1.210, 1.205, 1.201, 1.200, 1.199, 1.195, 1.190]) {
    console.log(rowFor(t));
  }
  console.log('');

  /* === SUNROAD ACTUALS — real loan $82.46M at Office 10% === */
  console.log('================================================================');
  console.log(`SUNROAD ACTUALS — loanAmount ${fmtUsd(SUNROAD.realLoanAmount)} (real Sunroad loan)`);
  console.log(`  NCF/NOI 0.89 → sustainableNcf ${fmtUsd(sustainableNcf)}`);
  console.log(`  Office stressed refi constant ${fmtPct(stressedRefiConstantOffice)}`);
  console.log('================================================================');
  console.log('');
  const { amort, exitDscr, stressedRefi, maturityBalance, refiApplicability } = evalAndProposal(SUNROAD.realLoanAmount);
  console.log(`  refi applicability  ${refiApplicability}`);
  console.log(`  stressedRefiConst   ${typeof stressedRefi === 'number' ? fmtPct(stressedRefi) : 'null'}`);
  console.log(`  maturityBalance     ${typeof maturityBalance === 'number' ? fmtUsd(maturityBalance) : 'null'}`);
  console.log(`  exit DSCR (actual)  ${typeof exitDscr === 'number' ? exitDscr.toFixed(3) : 'null'}`);
  if (amort && amort.id === 'amortization_refi') {
    const bTarget = (amort as any).targetMaturityBalance as number;
    const paydown = (amort as any).requiredPaydown as number;
    const yrs = computeImpliedAmortYearsForBalance(
      SUNROAD.realLoanAmount, SUNROAD.coupon, SUNROAD.termYears * 12, bTarget,
    );
    console.log('');
    console.log(`  lever fired         require_amortization (id=${amort.id})`);
    console.log(`  B_target            ${fmtUsd(bTarget)}  (cure to ${DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET.toFixed(2)}x exit DSCR)`);
    console.log(`  required paydown    ${fmtUsd(paydown)}  (from ${fmtUsd(SUNROAD.realLoanAmount)} → ${fmtUsd(bTarget)})`);
    console.log(`  implied amort sched ${yrs !== null ? yrs.toFixed(1) + ' yr' : 'null'} at coupon ${fmtPct(SUNROAD.coupon)} over ${SUNROAD.termYears * 12} months`);
    console.log(`  severity            ${(amort as any).severity ?? '—'}`);
    console.log(`  riskReduction       ${(amort as any).riskReduction ?? '—'}`);
  } else if (amort) {
    console.log('');
    console.log(`  lever fired         ${amort.id} (edge variant)`);
    console.log(`  description         ${(amort as any).description ?? '—'}`);
  } else {
    console.log('');
    console.log('  lever did NOT fire — exit DSCR clears the doctrine\'s refinanceable threshold.');
  }
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
