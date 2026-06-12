/**
 * Lever calibration harness — dim-7 reduce_proceeds (LTV arm), no lever-code changes.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-lever-dim7-reduce-proceeds.ts
 *
 * What this does:
 *   - Feeds Sunroad's resolved profile into evaluateDeal so dim 7 RESOLVES
 *     (concludedValue threaded via the DealBag — the fence is honored, the
 *     adapter is bypassed by constructing the DealBag directly).
 *   - Sweeps loanAmount so dim 7's stressedLtv moves 0.60 → 0.95 in
 *     ~0.025-step increments. NOTE: concludedValue does NOT drive stressedLtv
 *     (stressedLtv = loan / stressedValue; stressedValue = sustainableNcf /
 *     Office floor 8.00%). To make stressedLtv actually move you must move
 *     loan, NCF, or cap rate. Loan is the cleanest sweep — same property,
 *     varying loan size, same dim-7 base stressed value across the curve.
 *   - At each step CALLS THE REAL produceMitigations + buildReduceProceedsProposal
 *     (no re-implementation). DSCR/DY are pinned WELL above their desk
 *     targets so the LTV arm is the only breached arm — isolates the LTV
 *     arm cleanly.
 *   - Reports the value basis the lever USES for the re-point (dim 7's
 *     SINGLE base stressed value — not a downturn / stress-engine value).
 *
 * Sunroad-resolved profile (Q3 conversation):
 *   loanAmount BASE       $82,460,000   (IO 60mo at 7.9%)
 *   uwY1Noi (issuer)      $10,172,319.74 (sellerUwOperatingStatement.noi)
 *   Office NCF/NOI ratio  0.93          (clean normalization)
 *   sustainableNcf        $9,460,257.36 (= uwY1Noi × 0.93; no t12 → no divergence haircut; no occupancy → no vacancy haircut)
 *   stressedCapRate       8.00%         (Office public floor; market tier Unknown → 0 bps delta)
 *   stressedValue         $118,253,217  (= sustainableNcf / 0.08; CONSTANT across sweep)
 *   judgment-side base
 *     concludedValue      $126,200,362  (judgment uwValue at 6.75% cap on $8.52M judgment-NOI)
 *
 * What the lever should do (POST-PARAMETERIZATION):
 *   - T_LTV_TRIGGER = 0.70 — fire when stressedLtv > 0.70.
 *   - T_LTV_TARGET  = 0.68 — cure to L'_LTV = 0.68 × stressedValue.
 *   - With trigger != target, the first fire row carries a step-up of
 *     ≈ (T_LTV_TRIGGER − T_LTV_TARGET) × stressedValue.
 *   - Value basis = dim 7 BASE stressed value. NOT a scenario / downturn
 *     value. One value, conservatively derived, used everywhere.
 *
 * Office subtype split (operator-judgment, NOT employer-derived):
 *   Office.CBD       9.00%   (most pressured post-2020)
 *   Office.suburban  8.50%
 *   Office.medical   7.75%   (sticky tenant base)
 *   Office._default  9.00%   (subType null / unrecognized)
 *
 * Office NCF/NOI ratio: 0.93 → 0.89 (operator-judgment, anchored to KBRA/DBRS).
 *
 * Once this curve validates, extend to the other 6 levers.
 */
import { fileURLToPath } from 'node:url';
import {
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import { produceMitigations, DEFAULT_MITIGATION_DESK } from '../services/mitigation/produce-mitigations.js';
import type { AdjustedInputs, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

/* ---------- inputs pinned to the Sunroad-resolved profile ---------- */

const SUNROAD = {
  assetType: 'Office' as const,
  uwY1Noi: 10_172_319.74,                    // raw issuer sellerUwOperatingStatement.noi
  ncfNoiRatio: 0.89,                          // OPERATOR-JUDGMENT locked desk knob (was 0.93)
  // Office subtype floors (operator-judgment anchored to public Office range).
  capRateByOfficeSubtype: {
    CBD:       0.0900,
    suburban:  0.0850,
    medical:   0.0775,
    _default:  0.0900,                        // subType null/unknown
  },
  // CBD is the primary sweep subtype (Sunroad-equivalent profile).
  sweepSubtype: 'CBD' as const,
  coupon: 0.079,                              // Sunroad coupon
  amortMonths: 0,                             // IO loan
  ioYears: 5,                                 // 60-month IO over 60-month term
  termYears: 5,
  marketTier: 'Unknown' as const,             // 0 bps delta
  // Judgment-side concluded value (the basis behind the handbook's LTV 65.3%).
  // We THREAD this in via the DealBag so dim 7 resolves and produces stressedValue.
  // concludedValue feeds the valuation-aggressiveness comparator; it does NOT
  // appear in the stressedValue formula.
  judgmentConcludedValue: 126_200_362,
  realLoanAmount: 82_460_000,                 // Sunroad actual loan
};

const sustainableNcf = SUNROAD.uwY1Noi * SUNROAD.ncfNoiRatio;
const dim7StressedValueExpected = sustainableNcf / SUNROAD.capRateByOfficeSubtype[SUNROAD.sweepSubtype];

/* ---------- AdjustedInputs / UnderwritingModel stubs ---------- */

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

/** Build AdjustedInputs with DSCR / DY pinned ABOVE desk targets so the
 *  LTV arm is the only breached arm — isolates the LTV-arm behavior. */
function buildAi(loanAmount: number): AdjustedInputs {
  return {
    id: 'AI_DIM7_CAL' as any, analysisAsOfDate: '2026-05-31T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
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
      // PIN dscr / debtYield ABOVE desk thresholds so the LTV arm is the
      // only breached arm. The harness deliberately isolates LTV behavior;
      // a future sweep can let DSCR/DY co-breach to study binding-constraint flips.
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
  // Set uw.impliedValue HIGHER than dim 7's stressed value so the LTV arm's
  // legacy fallback would say "OK", proving that the lever uses dim 7's
  // stressed value (the smaller, more conservative basis) NOT the legacy
  // impliedValue. This is the load-bearing phase-1 dim-7 re-point assertion.
  const impliedValueLegacy = SUNROAD.judgmentConcludedValue;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.0675, impliedValue: impliedValueLegacy, loanAmount, interestRate: SUNROAD.coupon * 100, amortizationYears: 0, termYears: SUNROAD.termYears, annualDebtService: loanAmount * SUNROAD.coupon, dscr: 1.50, ltv: loanAmount / impliedValueLegacy, debtYield: 0.12, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: SUNROAD.coupon * 100, rateType: 'fixed', ioMonths: SUNROAD.ioYears * 12, amortizationMonths: SUNROAD.amortMonths, termMonths: SUNROAD.termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-05-31', maturityDate: '2031-05-31' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/* ---------- harness sweep ---------- */

function mkDealBag(loanAmount: number, concludedValue: number, subType: string): DealBag {
  return {
    propertyName: 'Sunroad Centrum (synthetic resolution)',
    assetType: SUNROAD.assetType,
    subType,
    loanAmount,
    coupon: SUNROAD.coupon,
    concludedValue,                            // ← threaded via input; bypasses adapter fence at the DealBag level
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

function evalAndProposal(loanAmount: number, subType: string) {
  const deal = mkDealBag(loanAmount, SUNROAD.judgmentConcludedValue, subType);
  const dealResult = evaluateDeal(deal);
  const ai = buildAi(loanAmount);
  const uw = buildUw(loanAmount);
  const proposals = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult });
  const reduce = proposals.find(p => p.id?.startsWith('reduce_proceeds'));
  const dim7Stressed = dealResult.dimensions.capRateValuationStress.derivedOutputs?.stressedValue as number | null | undefined;
  const stressedLtvActual = typeof dim7Stressed === 'number' && dim7Stressed > 0 ? loanAmount / dim7Stressed : null;
  return { reduce, dim7Stressed, stressedLtvActual };
}

function rowFor(targetLtv: number, subType: string): string {
  const loanAmount = targetLtv * dim7StressedValueExpected;
  const { reduce, dim7Stressed, stressedLtvActual } = evalAndProposal(loanAmount, subType);
  let lPrime: string = '—', equity: string = '—', basis: string = '—', fired = 'no', binding = '—';
  if (reduce && reduce.targetMetric === 'ltv') {
    fired = 'yes (LTV)'; binding = reduce.targetMetric;
    const lPrimeNum = loanAmount - (reduce.requiredEquity ?? 0);
    lPrime = fmtUsd(lPrimeNum);
    equity = fmtUsd(reduce.requiredEquity ?? 0);
    basis = (reduce.addressesDimensions ?? []).includes('cap-rate-valuation-stress') ? 'dim 7 BASE stressed' : 'legacy impliedValue';
  } else if (reduce) {
    fired = 'yes (' + (reduce.targetMetric ?? '?') + ')';
    binding = reduce.targetMetric ?? '?';
    lPrime = '(non-LTV binding)';
  }
  return [
    targetLtv.toFixed(4),
    fmtUsd(loanAmount),
    fmtUsd(dim7Stressed ?? NaN),
    (stressedLtvActual !== null ? stressedLtvActual.toFixed(4) : 'null'),
    fired, binding, lPrime, equity, basis,
  ].map(s => String(s).padEnd(22)).join('');
}

function main(): void {
  console.log('================================================================');
  console.log('LEVER CALIBRATION — dim-7 reduce_proceeds (LTV arm)');
  console.log('  POST-PARAMETERIZATION — Office subtype map + locked NCF/NOI 0.89 +');
  console.log('  T_LTV_TRIGGER 0.70 / T_LTV_TARGET 0.68 split');
  console.log('================================================================');
  console.log('');
  console.log('Sunroad-resolved profile:');
  console.log(`  assetType                 ${SUNROAD.assetType}`);
  console.log(`  uwY1Noi (issuer)          ${fmtUsd(SUNROAD.uwY1Noi)}`);
  console.log(`  Office NCF/NOI ratio      ${SUNROAD.ncfNoiRatio}  ← LOCKED DESK KNOB (was 0.93)`);
  console.log(`  sustainableNcf            ${fmtUsd(sustainableNcf)} (computed by normalization)`);
  console.log(`  Office cap floor          CBD ${fmtPct(SUNROAD.capRateByOfficeSubtype.CBD)} / suburban ${fmtPct(SUNROAD.capRateByOfficeSubtype.suburban)} / medical ${fmtPct(SUNROAD.capRateByOfficeSubtype.medical)} / _default ${fmtPct(SUNROAD.capRateByOfficeSubtype._default)}`);
  console.log(`  Sweep subtype             ${SUNROAD.sweepSubtype} → floor ${fmtPct(SUNROAD.capRateByOfficeSubtype[SUNROAD.sweepSubtype])}`);
  console.log(`  dim-7 base stressed value ${fmtUsd(dim7StressedValueExpected)}  ← CONSTANT across CBD sweep`);
  console.log(`  concludedValue threaded   ${fmtUsd(SUNROAD.judgmentConcludedValue)} (judgment uwValue; orthogonal to stressedLtv)`);
  console.log(`  coupon                    ${fmtPct(SUNROAD.coupon)} IO ${SUNROAD.ioYears}yr term ${SUNROAD.termYears}yr`);
  console.log('');
  console.log('Harness isolation: ai.metrics.dscr=1.50, debtYield=0.12 — both pinned ABOVE');
  console.log('  desk targets so only the LTV arm can breach.');
  console.log('');
  console.log('Desk thresholds (from DEFAULT_MITIGATION_DESK):');
  console.log(`  T_LTV_TRIGGER  = ${DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER}  (fire when stressedLtv > this)`);
  console.log(`  T_LTV_TARGET   = ${DEFAULT_MITIGATION_DESK.T_LTV_TARGET}  (cure to L' = TARGET × stressedValue)`);
  console.log(`  T_DSCR         = ${DEFAULT_MITIGATION_DESK.T_DSCR}`);
  console.log(`  T_DY           = ${DEFAULT_MITIGATION_DESK.T_DY}`);
  console.log('');
  console.log('Lever LTV-arm formula:');
  console.log('  ltvDenominator = dim7StressedValue (preferred over uw.impliedValue when present)');
  console.log('  ltv            = loanAmount / ltvDenominator');
  console.log('  breach         = ltv > T_LTV_TRIGGER');
  console.log('  L\'_LTV         = T_LTV_TARGET × ltvDenominator         ← target, not trigger');
  console.log('  requiredEquity = loanAmount − L\'_LTV');
  console.log('');
  console.log('SWEEP — vary loanAmount so stressedLtv covers 0.60 → 0.95 in 0.025 steps');
  console.log('  (subtype = CBD; concludedValue held fixed at $126.20M; DSCR/DY pinned safe)');
  console.log('');

  /* === HEADER === */
  const hdr = [
    'targetLTV', 'loanAmount', 'dim7 stressedValue', 'stressedLtv (actual)',
    'fired?', 'binding', 'L\'', 'requiredEquity', 'value basis',
  ];
  console.log(hdr.map(h => h.padEnd(22)).join(''));
  console.log('─'.repeat(22 * hdr.length));

  /* === FULL SWEEP === */
  const targets: number[] = [];
  for (let x = 0.60; x <= 0.951; x += 0.025) targets.push(Math.round(x * 1000) / 1000);
  for (const targetLtv of targets) console.log(rowFor(targetLtv, SUNROAD.sweepSubtype));
  console.log('');

  /* === BOUNDARY ZOOM around 0.70 === */
  console.log('================================================================');
  console.log('BOUNDARY ZOOM — rows just on each side of T_LTV_TRIGGER = 0.70');
  console.log('  Expected: $0 at/below 0.70; first fire row has step ≈');
  console.log('  (T_LTV_TRIGGER − T_LTV_TARGET) × stressedValue =');
  console.log(`  (0.70 − 0.68) × ${fmtUsd(dim7StressedValueExpected)} = ${fmtUsd(0.02 * dim7StressedValueExpected)}`);
  console.log('================================================================');
  console.log('');
  console.log(hdr.map(h => h.padEnd(22)).join(''));
  console.log('─'.repeat(22 * hdr.length));
  for (const t of [0.6900, 0.6950, 0.6999, 0.7000, 0.7001, 0.7050, 0.7100]) {
    console.log(rowFor(t, SUNROAD.sweepSubtype));
  }
  console.log('');

  /* === SUNROAD ACTUALS — real loan $82.46M against all 3 subtypes === */
  console.log('================================================================');
  console.log(`SUNROAD ACTUALS — loanAmount ${fmtUsd(SUNROAD.realLoanAmount)} (real Sunroad loan)`);
  console.log(`  NCF/NOI 0.89 → sustainableNcf ${fmtUsd(sustainableNcf)}`);
  console.log('  computed across all three Office subtype floors');
  console.log('================================================================');
  console.log('');
  const subtypeHdr = [
    'subtype', 'cap floor', 'dim7 stressedValue', 'stressedLtv', 'fired?', 'L\'', 'requiredEquity',
  ];
  console.log(subtypeHdr.map(h => h.padEnd(22)).join(''));
  console.log('─'.repeat(22 * subtypeHdr.length));
  for (const sub of ['CBD', 'suburban', 'medical'] as const) {
    const floor = SUNROAD.capRateByOfficeSubtype[sub];
    const { reduce, dim7Stressed, stressedLtvActual } = evalAndProposal(SUNROAD.realLoanAmount, sub);
    let lPrime = '—', equity = '—', fired = 'no';
    if (reduce && reduce.targetMetric === 'ltv') {
      fired = 'yes (LTV)';
      lPrime = fmtUsd(SUNROAD.realLoanAmount - (reduce.requiredEquity ?? 0));
      equity = fmtUsd(reduce.requiredEquity ?? 0);
    } else if (reduce) {
      fired = 'yes (' + (reduce.targetMetric ?? '?') + ')';
    }
    console.log([
      sub, fmtPct(floor), fmtUsd(dim7Stressed ?? NaN),
      stressedLtvActual !== null ? stressedLtvActual.toFixed(4) : 'null',
      fired, lPrime, equity,
    ].map(s => String(s).padEnd(22)).join(''));
  }
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
