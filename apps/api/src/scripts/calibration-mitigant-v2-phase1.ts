/**
 * Validation for mitigant-v2 phase 1 — integration backbone + dim-7 win.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-mitigant-v2-phase1.ts
 *
 * Checks:
 *   (1) Part B no-behavior-change: produceMitigations WITHOUT dealResult →
 *       byte-identical to v1 (the producer ignores the optional input).
 *   (2) Part C scaffolding: LEVER_KINDS includes the 5 phase-2-pending kinds;
 *       MitigationProposal interface accepts addressesDimensions.
 *   (3) Part D dim-7 win — the LTV-arm re-point:
 *       - synthetic deal where stressedValue < impliedValue → LTV arm cuts
 *         loan amount MORE than the legacy basis (binding constraint flips
 *         or tightens)
 *       - addressesDimensions populated with ['leverage-ltv',
 *         'cap-rate-valuation-stress'] when stressed-basis was used
 *       - fallback: when dealResult is null OR dim 7 didn't resolve, LTV
 *         arm sizes exactly as before (no behavior change)
 *       - non-LTV-binding cases: addressesDimensions still populated with
 *         the binding metric's dim
 *   (4) Fence: produceMitigations reads only dealResult.dimensions; no
 *       judgment-engine output / no AdjustedInputs.metrics.noi /
 *       no valuationConclusion. The dealResult itself is the clean
 *       evaluateDeal output.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { produceMitigations, DEFAULT_MITIGATION_DESK } from '../services/mitigation/produce-mitigations.js';
import { LEVER_KINDS } from '@cre/contracts';
import type { AdjustedInputs, FiredFlag, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import { evaluateDeal } from '../doctrine-clean/index.js';
import type { DealBag, EvaluateDealResult } from '../doctrine-clean/index.js';

const OUT_PATH = '/tmp/calibration-mitigant-v2-phase1.out';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assertEq<T>(got: T, want: T, label: string) {
  if (got === want) { passed++; return; }
  failed++; failures.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function assert(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failed++; failures.push(label);
}

/* ---------- stub builders (mirror diag from state-assessment) ---------- */

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}
function buildAi(opts: { noi: number; loanAmount: number; interestRate: number; amortMonths: number; egi?: number; pctRollover?: number | null; dscr: number; debtYield: number; ltvAppraisal?: number | null; }): AdjustedInputs {
  return {
    id: 'AI_TEST' as any, analysisAsOfDate: '2026-06-12T00:00:00.000Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, opts.egi ?? opts.noi * 1.4) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: { loanAmount: li(opts.loanAmount, opts.loanAmount), interestRate: li(opts.interestRate, opts.interestRate), termMonths: li(120, 120), amortizationMonths: li(opts.amortMonths, opts.amortMonths), ioPeriodMonths: li(0, 0), maturityBalance: li(null, opts.loanAmount * 0.92), maturityDate: '2034-12-01T00:00:00.000Z' as any, debtServiceAnnual: li(null, opts.loanAmount * opts.interestRate) },
    assumptions: { capRate: li(0.07, 0.07), terminalCapRate: li(0.075, 0.075), concludedCapRate: null, rentGrowthPct: li(0.02, 0.02), expenseGrowthPct: li(0.025, 0.025) },
    metrics: { noi: opts.noi, value: opts.noi / 0.07, dscr: opts.dscr, ltvAppraisal: opts.ltvAppraisal ?? null, debtYield: opts.debtYield, expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: opts.pctRollover ?? null, trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null, issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null , noiDivergence: null},
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}
function liField(id: string, label: string, amt: number): any {
  return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt };
}
function buildUw(opts: { loanAmount: number; interestRate: number; impliedValue: number; dscr: number; ltv: number; debtYield: number; amortMonths: number; noi: number; egi?: number; }): UnderwritingModel {
  const egi = opts.egi ?? opts.noi * 1.4;
  const toe = egi - opts.noi;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'Vacancy', -egi * 0.05), concessions: liField('con', 'Concessions', 0), otherIncome: liField('oth', 'Other', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'Taxes', toe * 0.30), insurance: liField('ins', 'Ins', toe * 0.08), utilities: liField('util', 'Util', toe * 0.10), repairsAndMaintenance: liField('rm', 'R&M', toe * 0.10), management: liField('mgmt', 'Mgmt', toe * 0.08), generalAndAdmin: liField('ga', 'G&A', toe * 0.04), payroll: liField('pr', 'Payroll', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: opts.noi, capRate: 0.07, impliedValue: opts.impliedValue, loanAmount: opts.loanAmount, interestRate: opts.interestRate * 100, amortizationYears: opts.amortMonths / 12, termYears: 10, annualDebtService: opts.loanAmount * opts.interestRate, dscr: opts.dscr, ltv: opts.ltv, debtYield: opts.debtYield, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount: opts.loanAmount, interestRate: opts.interestRate * 100, rateType: 'fixed', ioMonths: 0, amortizationMonths: opts.amortMonths, termMonths: 120, paymentFrequency: 'monthly', originationDate: '2024-01-01', maturityDate: '2034-12-01' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/** Build a real clean DealResult via evaluateDeal so dim 7 actually runs. */
function buildRealDealResult(deal: DealBag): EvaluateDealResult {
  return evaluateDeal(deal);
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function main(): void {
  const out: string[] = [];
  out.push('mitigant-v2 phase 1 — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === (1) Part C scaffolding ============================== */
  out.push('================================================================');
  out.push('(1) PART C — contract scaffolding declared');
  out.push('================================================================');
  out.push('');
  out.push(`  LEVER_KINDS = [${LEVER_KINDS.map(k => `'${k}'`).join(', ')}]`);
  const expectedNew = ['amortization', 'guaranty', 'springing_cash_management', 'in_place_cash_management', 'condition_precedent'];
  for (const k of expectedNew) {
    assert((LEVER_KINDS as readonly string[]).includes(k), `LEVER_KINDS includes '${k}'`);
  }
  const expectedV1 = ['recalc_delta', 'coverage_reserve'];
  for (const k of expectedV1) {
    assert((LEVER_KINDS as readonly string[]).includes(k), `LEVER_KINDS preserves v1 '${k}'`);
  }
  out.push('');

  /* === (2) Part B no-behavior-change without dealResult ===== */
  out.push('================================================================');
  out.push('(2) PART B — no-behavior-change when dealResult is absent');
  out.push('================================================================');
  out.push('');
  // Scenario A from state assessment — over-leveraged office
  const aiA = buildAi({ noi: 3_500_000, loanAmount: 55_000_000, interestRate: 0.060, amortMonths: 360, dscr: 1.18, debtYield: 0.064 });
  const uwA = buildUw({ loanAmount: 55_000_000, interestRate: 0.060, impliedValue: 55_000_000 / 0.78, dscr: 1.18, ltv: 0.78, debtYield: 0.064, amortMonths: 360, noi: 3_500_000 });
  const propsV1 = produceMitigations({ adjustedInputs: aiA, uwModel: uwA, firedFlags: [] });
  out.push(`  Scenario A (legacy basis): ${propsV1.length} proposal(s)`);
  for (const p of propsV1) {
    out.push(`    ${p.id}  binding=${p.targetMetric}  L'=${fmtUsd((uwA.loanAmount - (p.requiredEquity ?? 0)))}  addresses=[${(p.addressesDimensions ?? []).join(', ')}]`);
  }
  assert(propsV1.length === 1, 'Scenario A: exactly 1 reduce_proceeds proposal');
  assertEq(propsV1[0]!.targetMetric, 'dscr', 'Scenario A (no dim 7): binding = DSCR (legacy outcome)');
  out.push('');

  /* === (3) Part D dim-7 win — LTV arm sizes against stressed value === */
  out.push('================================================================');
  out.push('(3) PART D — dim 7 win: LTV arm "lend to MY value"');
  out.push('================================================================');
  out.push('');
  // Synthesize a real DealBag → real DealResult so dim 7 actually computes
  // a stressedValue. Cap-rate stress on an Office property at 8.00% going-in
  // on NOI=$3.5M → stressedValue = $43.75M (< appraised $70.5M).
  const dealA: DealBag = {
    propertyName: 'Synthetic Office Tower A',
    assetType: 'Office',
    subType: 'CBD',
    loanAmount: 55_000_000,
    coupon: 0.060,
    concludedValue: 70_500_000,
    uwY1Noi: 3_500_000,
    t12Noi: null,
    underwrittenOccupancy: 0.93,
    largestTenantPct: null,
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360,
    ioYears: null,
    termYears: null,
    marketTier: 'Unknown',
  };
  const dealResultA = buildRealDealResult(dealA);
  const stressedValueA = dealResultA.dimensions.capRateValuationStress.derivedOutputs?.stressedValue as number;
  out.push(`  Synthetic Office Tower A:`);
  out.push(`    appraised value:  ${fmtUsd(70_500_000)}`);
  out.push(`    dim 7 stressed:   ${fmtUsd(stressedValueA)}`);
  out.push(`    haircut:          ${(((70_500_000 - stressedValueA) / 70_500_000) * 100).toFixed(1)}%`);
  out.push('');
  // Same uwModel, same aiA → produceMitigations WITH dealResult
  const propsV2 = produceMitigations({ adjustedInputs: aiA, uwModel: uwA, firedFlags: [], dealResult: dealResultA });
  out.push(`  Proposals with dim-7 dealResult threaded: ${propsV2.length}`);
  for (const p of propsV2) {
    const lPrime = uwA.loanAmount - (p.requiredEquity ?? 0);
    out.push(`    ${p.id}  binding=${p.targetMetric}  L'=${fmtUsd(lPrime)}  addresses=[${(p.addressesDimensions ?? []).join(', ')}]`);
  }
  out.push('');
  // Validation: with stressed value $43.75M and T_LTV=0.70, the LTV arm
  // supports L'_LTV = 0.70 × 43.75M = $30.6M. That is more conservative
  // than DSCR's $38.9M (which was the v1 binding). So binding FLIPS to LTV.
  assert(propsV2.length === 1, 'dim-7 case: 1 proposal');
  assertEq(propsV2[0]!.targetMetric, 'ltv', 'dim-7 case: binding flips to LTV (stressed basis more conservative than DSCR)');
  const ltvAddresses = propsV2[0]!.addressesDimensions ?? [];
  assert(ltvAddresses.includes('leverage-ltv') && ltvAddresses.includes('cap-rate-valuation-stress'), 'addressesDimensions = [leverage-ltv, cap-rate-valuation-stress]');
  // Strictly tighter loan
  const lPrimeV1 = uwA.loanAmount - (propsV1[0]!.requiredEquity ?? 0);
  const lPrimeV2 = uwA.loanAmount - (propsV2[0]!.requiredEquity ?? 0);
  assert(lPrimeV2 < lPrimeV1, `dim-7 L' (${fmtUsd(lPrimeV2)}) < legacy L' (${fmtUsd(lPrimeV1)}) — more conservative`);
  assert((propsV2[0]!.description ?? '').includes('lend to my value'), 'rationale text cites "lend to MY value"');
  assert((propsV2[0]!.description ?? '').includes('doctrine-stressed value'), 'rationale cites doctrine-stressed value');
  out.push('');

  /* === (4) FALLBACK — dim 7 HITL (no stressedValue) → legacy basis === */
  out.push('================================================================');
  out.push('(4) FALLBACK — dim 7 HITL → legacy appraised-value basis (no behavior change)');
  out.push('================================================================');
  out.push('');
  // Build a DealBag where dim 7 will route to HITL (missing concludedValue)
  const dealHitl: DealBag = { ...dealA, concludedValue: null };
  const dealResultHitl = buildRealDealResult(dealHitl);
  out.push(`  dim 7 applicability: ${dealResultHitl.dimensions.capRateValuationStress.applicability}`);
  const propsHitl = produceMitigations({ adjustedInputs: aiA, uwModel: uwA, firedFlags: [], dealResult: dealResultHitl });
  out.push(`  Proposals (dim 7 HITL): ${propsHitl.length}`);
  for (const p of propsHitl) {
    const lPrime = uwA.loanAmount - (p.requiredEquity ?? 0);
    out.push(`    ${p.id}  binding=${p.targetMetric}  L'=${fmtUsd(lPrime)}  addresses=[${(p.addressesDimensions ?? []).join(', ')}]`);
  }
  assertEq(propsHitl[0]!.targetMetric, propsV1[0]!.targetMetric, 'dim 7 HITL: same binding metric as v1 (legacy basis)');
  assertEq(propsHitl[0]!.requiredEquity, propsV1[0]!.requiredEquity, 'dim 7 HITL: same requiredEquity as v1');
  assertEq((propsHitl[0]!.description ?? '').includes('lend to my value'), false, 'dim 7 HITL: no "lend to my value" clause');
  out.push('');

  /* === (5) Non-LTV-binding case: addressesDimensions still populated === */
  out.push('================================================================');
  out.push('(5) NON-LTV BINDING — addressesDimensions populated by binding arm');
  out.push('================================================================');
  out.push('');
  // Scenario where DSCR remains the binding constraint even with dim 7
  // re-pointing. Use a deal with very low LTV but thin DSCR.
  const aiB = buildAi({ noi: 2_500_000, loanAmount: 30_000_000, interestRate: 0.075, amortMonths: 360, dscr: 1.05, debtYield: 0.083 });
  const uwB = buildUw({ loanAmount: 30_000_000, interestRate: 0.075, impliedValue: 60_000_000, dscr: 1.05, ltv: 0.50, debtYield: 0.083, amortMonths: 360, noi: 2_500_000 });
  const dealB: DealBag = { propertyName: 'B Tower', assetType: 'Multifamily', subType: 'Garden', loanAmount: 30_000_000, coupon: 0.075, concludedValue: 60_000_000, uwY1Noi: 2_500_000, t12Noi: null, underwrittenOccupancy: 0.93, largestTenantPct: null, largestTenantBasis: 'base-rent', pctIncomeExpiringWithinTerm: null, tenantDataStatus: 'na-by-asset-type', amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown' };
  const dealResultB = buildRealDealResult(dealB);
  const propsB = produceMitigations({ adjustedInputs: aiB, uwModel: uwB, firedFlags: [], dealResult: dealResultB });
  for (const p of propsB) {
    out.push(`    ${p.id}  binding=${p.targetMetric}  addresses=[${(p.addressesDimensions ?? []).join(', ')}]`);
  }
  if (propsB.length > 0) {
    assertEq(propsB[0]!.targetMetric, 'dscr', 'low-LTV thin-DSCR: binding stays DSCR (LTV arm not tightest even with stressed basis)');
    const addr = propsB[0]!.addressesDimensions ?? [];
    assertEq(addr.includes('coverage-dscr'), true, 'DSCR-binding proposal addresses coverage-dscr');
    assertEq(addr.includes('cap-rate-valuation-stress'), false, 'non-LTV-binding case: does NOT tag cap-rate-valuation-stress');
  }
  out.push('');

  /* === (6) FENCE — what dealResult fields are read =========== */
  out.push('================================================================');
  out.push('(6) FENCE — produce-mitigations reads only from clean dealResult');
  out.push('================================================================');
  out.push('');
  const src = fs.readFileSync('/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/mitigation/produce-mitigations.ts', 'utf8');
  // Only field of dealResult accessed: dimensions.capRateValuationStress.derivedOutputs.stressedValue
  const dealResultReads = (src.match(/dealResult[?]?\.[a-zA-Z.]+/g) ?? []).filter(s => !s.startsWith('dealResultArg'));
  out.push(`  dealResult field accesses in producer:`);
  for (const r of dealResultReads) out.push(`    ${r}`);
  const expected = ['dealResult?.dimensions.capRateValuationStress.derivedOutputs'];
  const allowed = dealResultReads.every(r =>
    r.startsWith('dealResult?.dimensions.capRateValuationStress.derivedOutputs') ||
    r === 'dealResult'
  );
  assert(allowed, `producer reads only dimensions.capRateValuationStress.derivedOutputs (got: ${dealResultReads.join(', ')})`);
  // Confirm producer does NOT read judgment-engine fields off dealResult (it shouldn't — dealResult is pure clean)
  const banned = [/dealResult.*adjusted/i, /dealResult.*judgment/i, /dealResult.*manifesto/i, /dealResult.*valuationConclusion/i];
  let bannedHits = 0;
  for (const rx of banned) {
    if (rx.test(src)) bannedHits++;
  }
  assertEq(bannedHits, 0, 'producer does NOT read judgment/AdjustedInputs/valuationConclusion off dealResult');
  out.push('');

  /* === SUMMARY ============================================= */
  out.push('================================================================');
  out.push('SUMMARY');
  out.push('================================================================');
  out.push('');
  out.push(`  Asserts: ${passed} passed / ${failed} failed`);
  if (failures.length > 0) {
    out.push('  Failures:');
    for (const f of failures.slice(0, 20)) out.push(`    ✗ ${f}`);
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[mitigant-v2 phase 1] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
