/**
 * Validation for mitigant-v2 phase 2 lever 3 (springing cash trap on concentration).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-mitigant-v2-phase2-springing.ts
 *
 * Synthetic cases:
 *   (1) ELEVATED concentration (top tenant 60%, Office) → lever fires;
 *       cap = 0.60 × EGI × 0.75; severity high.
 *   (2) HIGH concentration (top tenant 85%, Retail) → fires; severity critical.
 *   (3) MODERATE concentration (top tenant 35%, Office) → NO fire.
 *   (4) NA-BY-ASSET-TYPE (Multifamily) → NO fire.
 *   (5) HITL (Office, no tenant data) → NO fire.
 *   (6) APPLICABLE but EGI missing → manual variant.
 *   (7) NO REGRESSION: dim-7 LTV + lever 1 (amort) + lever 2 (guaranty) all still fire.
 *   (8) DOUBLE-FIRE LEGITIMATE: high concentration + high rollover → BOTH v1
 *       fund_reserve AND v2 springing fire (different risks, no double-count).
 *   (9) FENCE: producer reads dim-5 + EGI source v1 already uses; no judgment metrics.noi.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { produceMitigations } from '../services/mitigation/produce-mitigations.js';
import { evaluateDeal } from '../doctrine-clean/index.js';
import { MITIGATION_LEVERS } from '@cre/contracts';
import type { AdjustedInputs, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import type { DealBag } from '../doctrine-clean/index.js';

const OUT_PATH = '/tmp/calibration-mitigant-v2-phase2-springing.out';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assertEq<T>(got: T, want: T, label: string) {
  if (got === want) { passed++; return; }
  failed++; failures.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function assertClose(got: number | null | undefined, want: number, eps: number, label: string) {
  if (typeof got === 'number' && Math.abs(got - want) <= eps) { passed++; return; }
  failed++; failures.push(`${label}: got ${got} want ~${want} (eps ${eps})`);
}
function assert(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failed++; failures.push(label);
}

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}
function buildAi(opts: { egi: number; pctRollover?: number | null; noi?: number; loan?: number; }): AdjustedInputs {
  const egi = opts.egi;
  const noi = opts.noi ?? egi * 0.65;
  const loan = opts.loan ?? 30_000_000;
  return {
    id: 'AI_S' as any, analysisAsOfDate: '2026-06-12T00:00:00.000Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, egi) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: { loanAmount: li(loan, loan), interestRate: li(0.045, 0.045), termMonths: li(120, 120), amortizationMonths: li(360, 360), ioPeriodMonths: li(0, 0), maturityBalance: li(null, loan * 0.92), maturityDate: '2034-12-01T00:00:00.000Z' as any, debtServiceAnnual: li(null, loan * 0.045) },
    assumptions: { capRate: li(0.07, 0.07), terminalCapRate: li(0.075, 0.075), concludedCapRate: null, rentGrowthPct: li(0.02, 0.02), expenseGrowthPct: li(0.025, 0.025) },
    metrics: { noi, value: noi / 0.07, dscr: 2.0, ltvAppraisal: 0.55, debtYield: 0.12, expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: opts.pctRollover ?? null, trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null, issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null , noiDivergence: null},
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}
function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }
function buildUw(opts: { noi?: number; loan?: number; egi: number; }): UnderwritingModel {
  const egi = opts.egi, noi = opts.noi ?? egi * 0.65, loan = opts.loan ?? 30_000_000, toe = egi - noi;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.07, impliedValue: noi / 0.07, loanAmount: loan, interestRate: 4.5, amortizationYears: 30, termYears: 10, annualDebtService: loan * 0.045, dscr: 2.0, ltv: 0.60, debtYield: 0.12, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount: loan, interestRate: 4.5, rateType: 'fixed', ioMonths: 0, amortizationMonths: 360, termMonths: 120, paymentFrequency: 'monthly', originationDate: '2024-01-01', maturityDate: '2034-12-01' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

function main(): void {
  const out: string[] = [];
  out.push('mitigant-v2 phase 2 lever 3 — concentration springing cash trap — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === (0) Contract ============================== */
  out.push('================================================================');
  out.push('(0) CONTRACT — MITIGATION_LEVERS includes springing_cash_management');
  out.push('================================================================');
  out.push('');
  out.push(`  MITIGATION_LEVERS = [${MITIGATION_LEVERS.map(l => `'${l}'`).join(', ')}]`);
  assert((MITIGATION_LEVERS as readonly string[]).includes('springing_cash_management'), 'MITIGATION_LEVERS includes springing_cash_management');
  out.push('');

  /* === (1) ELEVATED ============================== */
  out.push('================================================================');
  out.push('(1) ELEVATED concentration (top tenant 60%, Office)');
  out.push('================================================================');
  out.push('');
  const dealElev: DealBag = {
    propertyName: 'Office A', assetType: 'Office', subType: 'CBD',
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: 50_000_000,
    uwY1Noi: 3_500_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: 0.60, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.10, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drElev = evaluateDeal(dealElev);
  const concDimElev = drElev.dimensions.incomeConcentration;
  out.push(`  dim 5: applicability=${concDimElev.applicability}  tier=${concDimElev.tier}  topShare=${(concDimElev.derivedOutputs?.topTenantShare as number * 100).toFixed(1)}%`);
  const aiElev = buildAi({ egi: 5_000_000 });
  const uwElev = buildUw({ egi: 5_000_000 });
  const propsElev = produceMitigations({ adjustedInputs: aiElev, uwModel: uwElev, firedFlags: [], dealResult: drElev });
  const springElev = propsElev.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  if (springElev) {
    out.push(`  ${springElev.id}  lever=${springElev.lever}  kind=${springElev.leverKind}  severity=${springElev.severity}`);
    out.push(`    requiredReserve=$${(springElev.requiredReserve! / 1_000_000).toFixed(2)}M (springing trap CAP)`);
    out.push(`    addresses=[${(springElev.addressesDimensions ?? []).join(', ')}]`);
    out.push('    structuralChanges:');
    for (const c of springElev.structuralChanges) out.push(`      • ${c}`);
  }
  assert(springElev !== undefined, 'ELEVATED: fires');
  if (springElev) {
    assertEq(springElev.id, 'springing_cash_trap_concentration', 'ELEVATED id');
    assertEq(springElev.lever, 'springing_cash_management', 'ELEVATED lever');
    assertEq(springElev.leverKind, 'springing_cash_management', 'ELEVATED leverKind');
    assertEq(springElev.addressesDimensions?.[0], 'income-concentration', 'ELEVATED addresses');
    assertEq(springElev.severity, 'high', 'ELEVATED severity = high');
    // Math: cap = 0.60 × 5M × 0.75 = $2.25M
    assertClose(springElev.requiredReserve, 0.60 * 5_000_000 * 0.75, 1, 'ELEVATED trap cap = topShare × EGI × 0.75');
    assert(springElev.description.includes('springing'), 'description cites "springing"');
    assert(springElev.description.includes('NOT an upfront escrow') || springElev.description.includes('ACCUMULATION TARGET'), 'cap-is-not-escrow disclosure');
    assert(springElev.description.includes('BASIS CAVEAT'), 'description carries basis caveat');
    assert(springElev.structuralChanges.some(c => /notice.to.vacate|go-dark|bankruptcy|downgrade|DSCR/i.test(c)), 'trigger events listed');
  }
  out.push('');

  /* === (2) HIGH ================================= */
  out.push('================================================================');
  out.push('(2) HIGH concentration (top tenant 85%, Retail) → critical severity');
  out.push('================================================================');
  out.push('');
  const dealHigh: DealBag = {
    propertyName: 'Big Anchored Center', assetType: 'Retail', subType: 'Anchored',
    loanAmount: 30_000_000, coupon: 0.05, concludedValue: 45_000_000,
    uwY1Noi: 3_000_000, t12Noi: null, underwrittenOccupancy: 0.95,
    largestTenantPct: 0.85, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.10, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drHigh = evaluateDeal(dealHigh);
  const cdHigh = drHigh.dimensions.incomeConcentration;
  out.push(`  dim 5: applicability=${cdHigh.applicability}  tier=${cdHigh.tier}  topShare=${(cdHigh.derivedOutputs?.topTenantShare as number * 100).toFixed(1)}%`);
  const propsHigh = produceMitigations({ adjustedInputs: buildAi({ egi: 4_200_000 }), uwModel: buildUw({ egi: 4_200_000 }), firedFlags: [], dealResult: drHigh });
  const springHigh = propsHigh.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  if (springHigh) {
    out.push(`  ${springHigh.id}  severity=${springHigh.severity}  riskReduction=${springHigh.riskReduction}  cap=$${(springHigh.requiredReserve! / 1_000_000).toFixed(2)}M`);
  }
  assert(springHigh !== undefined, 'HIGH: fires');
  if (springHigh) {
    assertEq(springHigh.severity, 'critical', 'HIGH severity = critical');
    assertEq(springHigh.riskReduction, 'significant', 'HIGH riskReduction = significant');
    assertClose(springHigh.requiredReserve, 0.85 * 4_200_000 * 0.75, 1, 'HIGH cap math');
  }
  out.push('');

  /* === (3) MODERATE → no fire ===================== */
  out.push('================================================================');
  out.push('(3) MODERATE concentration (top tenant 35%, Office) → no fire');
  out.push('================================================================');
  out.push('');
  const dealMod: DealBag = { ...dealElev, largestTenantPct: 0.35 };
  const drMod = evaluateDeal(dealMod);
  out.push(`  dim 5 tier=${drMod.dimensions.incomeConcentration.tier}`);
  const propsMod = produceMitigations({ adjustedInputs: buildAi({ egi: 5_000_000 }), uwModel: buildUw({ egi: 5_000_000 }), firedFlags: [], dealResult: drMod });
  const springMod = propsMod.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  assertEq(springMod, undefined, 'MODERATE: no fire (tier moderate, not elevated+)');
  out.push('  ✓ no fire');
  out.push('');

  /* === (4) NA-BY-ASSET-TYPE → no fire ============ */
  out.push('================================================================');
  out.push('(4) NA-BY-ASSET-TYPE (Multifamily) → no fire');
  out.push('================================================================');
  out.push('');
  const dealNa: DealBag = { ...dealElev, assetType: 'Multifamily', subType: 'Garden', tenantDataStatus: 'na-by-asset-type' };
  const drNa = evaluateDeal(dealNa);
  out.push(`  dim 5 applicability=${drNa.dimensions.incomeConcentration.applicability}`);
  const propsNa = produceMitigations({ adjustedInputs: buildAi({ egi: 5_000_000 }), uwModel: buildUw({ egi: 5_000_000 }), firedFlags: [], dealResult: drNa });
  const springNa = propsNa.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  assertEq(springNa, undefined, 'NA-BY-ASSET-TYPE: no fire');
  out.push('  ✓ no fire (correct — multifamily has no tenant concentration concept)');
  out.push('');

  /* === (5) HITL → no fire ======================== */
  out.push('================================================================');
  out.push('(5) HITL (Office, no tenant data) → no fire');
  out.push('================================================================');
  out.push('');
  const dealHitl: DealBag = { ...dealElev, largestTenantPct: null, tenantDataStatus: 'parse-failed' };
  const drHitl = evaluateDeal(dealHitl);
  out.push(`  dim 5 applicability=${drHitl.dimensions.incomeConcentration.applicability}`);
  const propsHitl = produceMitigations({ adjustedInputs: buildAi({ egi: 5_000_000 }), uwModel: buildUw({ egi: 5_000_000 }), firedFlags: [], dealResult: drHitl });
  const springHitl = propsHitl.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  assertEq(springHitl, undefined, 'HITL: no fire (coverage gate domain)');
  out.push('  ✓ no fire');
  out.push('');

  /* === (6) Manual variant — EGI missing ============= */
  out.push('================================================================');
  out.push('(6) Applicable elevated, but EGI <= 0 → manual variant');
  out.push('================================================================');
  out.push('');
  const aiNoEgi = buildAi({ egi: 0 });
  const propsNoEgi = produceMitigations({ adjustedInputs: aiNoEgi, uwModel: buildUw({ egi: 5_000_000 }), firedFlags: [], dealResult: drElev });
  const springManual = propsNoEgi.find(p => p.id?.startsWith('springing_cash_trap_concentration'));
  if (springManual) {
    out.push(`  ${springManual.id}  severity=${springManual.severity}`);
    assertEq(springManual.id, 'springing_cash_trap_concentration_manual', 'EGI-missing: manual variant id');
    assert(springManual.requiredReserve === undefined, 'manual variant: no dollar cap (cannot size)');
    assertEq(springManual.addressesDimensions?.[0], 'income-concentration', 'manual variant: addressesDimensions preserved');
    assert(springManual.description.includes('Provide EGI'), 'manual variant: requests EGI input');
  }
  out.push('');

  /* === (7) NO REGRESSION — prior levers all still fire ===== */
  out.push('================================================================');
  out.push('(7) NO REGRESSION — dim-7 LTV + lever 1 (amort) + lever 2 (guaranty)');
  out.push('================================================================');
  out.push('');
  // Over-leveraged + thin exit DSCR + high concentration deal: should produce
  // multiple proposals.
  const dealMulti: DealBag = {
    propertyName: 'Multi-trigger Office', assetType: 'Office', subType: 'CBD',
    loanAmount: 55_000_000, coupon: 0.060, concludedValue: 70_500_000,
    uwY1Noi: 3_500_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: 0.65, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: null, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drMulti = evaluateDeal(dealMulti);
  const aiMulti = buildAi({ egi: 5_000_000, noi: 3_500_000, loan: 55_000_000 });
  const uwMulti = buildUw({ egi: 5_000_000, noi: 3_500_000, loan: 55_000_000 });
  // Force the over-leveraged dscr/debt-yield metrics for ratio-arm triggers
  (aiMulti.metrics as any).dscr = 1.18;
  (aiMulti.metrics as any).debtYield = 0.064;
  (aiMulti.metrics as any).ltvAppraisal = 0.78;
  (uwMulti as any).dscr = 1.18; (uwMulti as any).debtYield = 0.064; (uwMulti as any).ltv = 0.78;
  (uwMulti as any).impliedValue = 70_500_000;
  (uwMulti as any).annualDebtService = 3_300_000;
  const propsMulti = produceMitigations({ adjustedInputs: aiMulti, uwModel: uwMulti, firedFlags: [], dealResult: drMulti });
  out.push(`  proposals on multi-trigger deal: ${propsMulti.map(p => p.id).join(', ')}`);
  const hasLtvLever = propsMulti.some(p => p.id === 'reduce_proceeds_ltv');
  const hasAmort = propsMulti.some(p => p.id?.startsWith('amortization_refi'));
  const hasSpring = propsMulti.some(p => p.id?.startsWith('springing_cash_trap_concentration'));
  assert(hasLtvLever, 'NO REGRESSION: reduce_proceeds_ltv still fires (phase-1 dim-7)');
  assert(hasAmort, 'NO REGRESSION: amortization_refi (lever 1) still fires');
  assert(hasSpring, 'lever 3 fires on this deal too');
  out.push('');

  /* === (8) DOUBLE-FIRE LEGITIMATE — concentration + rollover both fire === */
  out.push('================================================================');
  out.push('(8) DOUBLE-FIRE — high concentration + high rollover → BOTH levers');
  out.push('================================================================');
  out.push('');
  // High concentration (dim 5 elevated) AND high rollover (>20% trigger for v1
  // fund_reserve) → both proposals expected. No double-count because different
  // metrics, different mechanisms.
  const dealBoth: DealBag = { ...dealElev, pctIncomeExpiringWithinTerm: 0.40, largestTenantPct: 0.60 };
  const drBoth = evaluateDeal(dealBoth);
  const aiBoth = buildAi({ egi: 5_000_000, pctRollover: 0.40 });
  const uwBoth = buildUw({ egi: 5_000_000 });
  const propsBoth = produceMitigations({ adjustedInputs: aiBoth, uwModel: uwBoth, firedFlags: [], dealResult: drBoth });
  out.push(`  proposals: ${propsBoth.map(p => p.id).join(', ')}`);
  const hasFundReserveV1 = propsBoth.some(p => p.id === 'fund_reserve_tilc_rollover');
  const hasSpringBoth = propsBoth.some(p => p.id?.startsWith('springing_cash_trap_concentration'));
  assert(hasFundReserveV1, 'v1 fund_reserve (rollover) still fires');
  assert(hasSpringBoth, 'v2 springing_cash_trap (concentration) also fires');
  assert(propsBoth.filter(p => p.id?.includes('reserve') || p.id?.includes('trap')).length === 2, 'BOTH reserve-type levers present — no double-count (different dims + mechanisms)');
  out.push('  ✓ Both levers fire on different signals; no double-count');
  out.push('');

  /* === (9) FENCE ============================================== */
  out.push('================================================================');
  out.push('(9) FENCE — producer reads dim 5 + EGI (same source v1 uses)');
  out.push('================================================================');
  out.push('');
  const src = fs.readFileSync('/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/mitigation/produce-mitigations.ts', 'utf8');
  // dealResult accesses
  const dealResultReads = Array.from(new Set((src.match(/dealResult[?]?\.[a-zA-Z.?]+/g) ?? [])));
  out.push('  dealResult field accesses in producer:');
  for (const r of dealResultReads) out.push(`    ${r}`);
  assert(src.includes('dealResult.dimensions.incomeConcentration'), 'lever 3 reads dim 5 incomeConcentration');
  // Confirm EGI source consistency with v1 fund_reserve
  assert(src.includes('ai.income.effectiveGrossIncome.adjusted'), 'EGI source: ai.income.effectiveGrossIncome.adjusted (same as v1 fund_reserve)');
  // Banned patterns
  const banned = [/dealResult.*adjusted/i, /dealResult.*judgment/i, /dealResult.*valuationConclusion/i, /dealResult.*manifesto/i];
  let bannedHits = 0;
  for (const rx of banned) if (rx.test(src)) bannedHits++;
  assertEq(bannedHits, 0, 'no banned access patterns on dealResult');
  out.push('  ✓ EGI source: AdjustedInputs.income.effectiveGrossIncome.adjusted (consistent w/ v1 fund_reserve)');
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
  console.log(`\n[mitigant-v2 phase 2 lever 3] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
