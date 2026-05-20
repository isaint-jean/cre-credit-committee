// Tests for mergeUnderwritingModels.
//
//   npm run test:merge-uw-models
//
// Coverage:
//   - both-null  → null in output, no conflict
//   - one-null   → take non-null, no conflict
//   - both-equal → that value, no conflict
//   - conflict path: ASR-priority field   → ASR wins, conflict logged
//   - conflict path: Seller-priority field → Seller wins, conflict logged
//   - derived recompute: ADS / DSCR / LTV / DY computed from merged inputs,
//     not taken from either source (we deliberately seed inputs with
//     incompatible derived values to prove they are overwritten)
//   - bands recompute: classification fires on the merged metrics
//   - conflict log shape: { field, asrValue, sellerValue, chosen }

import type { LineItem, UnderwritingModel } from '@cre/shared';
import { mergeUnderwritingModels } from '../services/merge-underwriting-models.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

function lineItem(id: string, annual: number, original?: number): LineItem {
  return {
    id,
    label: id,
    annualAmount: annual,
    isEditable: true,
    isOverridden: false,
    originalValue: original ?? annual,
  };
}

function baseModel(overrides: Partial<UnderwritingModel> = {}): UnderwritingModel {
  return {
    income: {
      grossPotentialRent:   lineItem('grossPotentialRent', 1_000_000),
      vacancyLoss:          lineItem('vacancyLoss', -50_000),
      concessions:          lineItem('concessions', 0),
      otherIncome:          lineItem('otherIncome', 100_000),
      effectiveGrossIncome: lineItem('effectiveGrossIncome', 1_050_000),
      additionalItems:      [],
    },
    expenses: {
      realEstateTaxes:      lineItem('realEstateTaxes', 100_000),
      insurance:            lineItem('insurance', 30_000),
      utilities:            lineItem('utilities', 25_000),
      repairsAndMaintenance:lineItem('repairsAndMaintenance', 40_000),
      management:           lineItem('management', 30_000),
      generalAndAdmin:      lineItem('generalAndAdmin', 20_000),
      payroll:              lineItem('payroll', 0),
      replacementReserves:  lineItem('replacementReserves', 5_000),
      totalExpenses:        lineItem('totalExpenses', 250_000),
      additionalItems:      [],
    },
    netOperatingIncome: 800_000,
    capRate: 0.06,
    impliedValue: 13_333_333,
    loanAmount: 8_000_000,
    // Legacy convention: interestRate is stored as a PERCENT (7.0 means 7%/yr).
    // recalculateFullModel uses this convention. Tests that stub interestRate
    // MUST follow the same convention.
    interestRate: 7.0,
    amortizationYears: 30,
    termYears: 10,
    annualDebtService: 999_999_999,  // intentionally wrong; should be recomputed
    dscr: 999_999_999,                // intentionally wrong; should be recomputed
    ltv: 999_999_999,                 // intentionally wrong; should be recomputed
    debtYield: 999_999_999,           // intentionally wrong; should be recomputed
    asReported: true,
    modifiedCells: [],
    loanDetails: {
      loanAmount: 8_000_000,
      interestRate: 7.0,
      rateType: 'fixed',
      ioMonths: 0,
      amortizationMonths: 360,
      termMonths: 120,
      paymentFrequency: 'monthly',
      prepaymentTerms: 'YM',
      originationDate: '2026-01-01',
    },
    repaymentSchedule: null,
    ...overrides,
  };
}

console.log('mergeUnderwritingModels: both-null total fields produce null');
{
  const asr    = baseModel({ totalUnits: undefined, totalSqFt: undefined });
  const seller = baseModel({ totalUnits: undefined, totalSqFt: undefined });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.totalUnits, undefined, 'both-null totalUnits → undefined');
  assertEqual(merged.totalSqFt,  undefined, 'both-null totalSqFt → undefined');
  assertEqual(conflicts.length,  0, 'no conflicts for both-null');
}

console.log('\nmergeUnderwritingModels: one-null takes non-null without conflict');
{
  const asr    = baseModel({ totalUnits: 100, totalSqFt: undefined });
  const seller = baseModel({ totalUnits: undefined, totalSqFt: 50_000 });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.totalUnits, 100,    'one-null totalUnits → take non-null');
  assertEqual(merged.totalSqFt,  50_000, 'one-null totalSqFt → take non-null');
  assertEqual(conflicts.length,  0, 'no conflicts when one side is null');
}

console.log('\nmergeUnderwritingModels: both-equal produces value with no conflict');
{
  const asr    = baseModel({ totalUnits: 200, totalSqFt: 75_000 });
  const seller = baseModel({ totalUnits: 200, totalSqFt: 75_000 });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.totalUnits, 200, 'both-equal totalUnits → that value');
  assertEqual(conflicts.length,  0, 'no conflict when values match');
}

console.log('\nmergeUnderwritingModels: ASR-priority conflict (totalUnits)');
{
  const asr    = baseModel({ totalUnits: 200 });
  const seller = baseModel({ totalUnits: 250 });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.totalUnits, 200, 'totalUnits chooses ASR on conflict');
  const c = conflicts.find((x) => x.field === 'totalUnits');
  assert(c !== undefined, 'totalUnits conflict logged');
  assertEqual(c?.asrValue,    200, 'log preserves ASR value');
  assertEqual(c?.sellerValue, 250, 'log preserves Seller value');
  assertEqual(c?.chosen,      200, 'log records chosen value');
}

console.log('\nmergeUnderwritingModels: Seller-priority conflict (loanAmount)');
{
  const asr    = baseModel({ loanAmount: 7_000_000, loanDetails: { ...baseModel().loanDetails, loanAmount: 7_000_000 } });
  const seller = baseModel({ loanAmount: 8_500_000, loanDetails: { ...baseModel().loanDetails, loanAmount: 8_500_000 } });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.loanAmount, 8_500_000, 'loanAmount chooses Seller on conflict');
  const c = conflicts.find((x) => x.field === 'loanAmount');
  assert(c !== undefined, 'loanAmount conflict logged');
  assertEqual(c?.chosen, 8_500_000, 'log records Seller as chosen');
}

console.log('\nmergeUnderwritingModels: Seller-priority conflict (capRate)');
{
  const asr    = baseModel({ capRate: 0.055 });
  const seller = baseModel({ capRate: 0.065 });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.capRate, 0.065, 'capRate chooses Seller on conflict');
  const c = conflicts.find((x) => x.field === 'capRate');
  assert(c !== undefined, 'capRate conflict logged');
}

console.log('\nmergeUnderwritingModels: ASR-priority on Historical T-12 lineitem (income.grossPotentialRent)');
{
  const asr    = baseModel();
  const seller = baseModel({ income: { ...baseModel().income, grossPotentialRent: lineItem('grossPotentialRent', 1_500_000) } });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.income.grossPotentialRent.annualAmount, 1_000_000, 'GPR chooses ASR on conflict');
  const c = conflicts.find((x) => x.field === 'income.grossPotentialRent.annualAmount');
  assert(c !== undefined, 'GPR conflict logged');
  assertEqual(c?.chosen, 1_000_000, 'log records ASR as chosen');
}

console.log('\nmergeUnderwritingModels: derived metrics ALWAYS recompute (ignore source values)');
{
  // Both inputs have garbage derived values (999_999_999). After merge, derived must be
  // recomputed from the merged inputs (NOI=800k, loanAmount=8M, value=13.33M).
  const { merged } = mergeUnderwritingModels(baseModel(), baseModel());
  assert(merged.annualDebtService !== 999_999_999, 'ADS recomputed (not source-copied)');
  assert(merged.dscr !== 999_999_999,              'DSCR recomputed (not source-copied)');
  assert(merged.ltv !== 999_999_999,               'LTV recomputed (not source-copied)');
  assert(merged.debtYield !== 999_999_999,         'DY recomputed (not source-copied)');

  // ADS = annualDebtService(loanAmount=8M, rate=0.07, amortMonths=360)
  // monthly = 8_000_000 * (0.07/12) * factor / (factor-1) ≈ 53,219.94
  // annual  ≈ 638,639.32
  const ads = merged.annualDebtService!;
  assert(ads > 638_000 && ads < 639_000, 'ADS within expected range for 7%/30yr/8M');

  // DSCR = NOI / ADS = 800_000 / ~638_639 ≈ 1.252
  const dscr = merged.dscr!;
  assert(dscr > 1.20 && dscr < 1.30, 'DSCR in expected range');

  // LTV = loanAmount / impliedValue = 8M / 13.33M ≈ 0.60
  const ltv = merged.ltv!;
  assert(ltv > 0.59 && ltv < 0.61, 'LTV in expected range');

  // DY = NOI / loanAmount = 800k / 8M = 0.10
  const dy = merged.debtYield!;
  assert(Math.abs(dy - 0.10) < 0.001, 'DY in expected range');
}

console.log('\nmergeUnderwritingModels: bands recompute from merged metrics');
{
  // With DSCR≈1.25, the band classifier returns 'danger' (threshold <1.25).
  // With LTV≈0.60, band → 'safe' (≤0.65).
  // With DY=0.10, band → 'warning' (between 0.08 and 0.10).
  const { merged } = mergeUnderwritingModels(baseModel(), baseModel());
  assert(merged.dscrBand !== undefined,      'dscrBand populated');
  assert(merged.ltvBand !== undefined,       'ltvBand populated');
  assert(merged.debtYieldBand !== undefined, 'debtYieldBand populated');
}

console.log('\nmergeUnderwritingModels: conflict log shape is exact');
{
  const asr    = baseModel({ totalUnits: 100 });
  const seller = baseModel({ totalUnits: 200 });
  const { conflicts } = mergeUnderwritingModels(asr, seller);
  const c = conflicts[0]!;
  assert('field'      in c, 'conflict has field');
  assert('asrValue'   in c, 'conflict has asrValue');
  assert('sellerValue' in c, 'conflict has sellerValue');
  assert('chosen'     in c, 'conflict has chosen');
}

console.log('\nmergeUnderwritingModels: NOI follows ASR (Historical T-12 rule)');
{
  const asr    = baseModel({ netOperatingIncome: 800_000 });
  const seller = baseModel({ netOperatingIncome: 950_000 });
  const { merged, conflicts } = mergeUnderwritingModels(asr, seller);
  assertEqual(merged.netOperatingIncome, 800_000, 'NOI chooses ASR on conflict');
  const c = conflicts.find((x) => x.field === 'netOperatingIncome');
  assert(c !== undefined, 'NOI conflict logged');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
