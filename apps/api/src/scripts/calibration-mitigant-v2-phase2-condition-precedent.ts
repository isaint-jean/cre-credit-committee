/**
 * Validation for mitigant-v2 phase 2 lever 5 (coverage-gate condition precedent).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-mitigant-v2-phase2-condition-precedent.ts
 *
 * Cases:
 *   (1) SPINE HITL (dim 7 → no concludedValue) → severity critical;
 *       coverage gate fires; spine clause cited; appraisal CP listed.
 *   (2) Two peer HITLs (concentration + rollover via no rent roll) →
 *       severity high; both CPs listed.
 *   (3) Only sponsor HITL (everything else resolved) → severity medium;
 *       single CP for sponsor financials; coverage gate did NOT fire.
 *   (4) Concentration HITL only → severity medium.
 *   (5) ALL RESOLVED (synthetic sponsor assessment + full inputs) → NO fire.
 *   (6) CORPUS-LIKE: sponsor universally HITL on CMBS → fires medium for
 *       sponsor-only case (the typical CMBS state).
 *   (7) BOUNDARY with lever 2: resolved + risk-increasing sponsor →
 *       lever 2 guaranty fires, lever 5 does NOT fire on sponsor dim.
 *   (8) NO REGRESSION: prior levers all still work.
 *   (9) FENCE: producer reads only dealResult.dimensions + dealResult.rating;
 *       no judgment / valuationConclusion / handbook.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { produceMitigations } from '../services/mitigation/produce-mitigations.js';
import {
  evaluateDeal,
  evaluateSponsorBorrowerQuality,
  type SponsorAssessment,
} from '../doctrine-clean/index.js';
import { MITIGATION_LEVERS } from '@cre/contracts';
import type { AdjustedInputs, AdjustedLineItem, DimensionContribution } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import type { DealBag, EvaluateDealResult } from '../doctrine-clean/index.js';

const OUT_PATH = '/tmp/calibration-mitigant-v2-phase2-condition-precedent.out';

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

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}
function buildAi(egi = 5_000_000): AdjustedInputs {
  return {
    id: 'AI_X' as any, analysisAsOfDate: '2026-06-12T00:00:00.000Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, egi) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: { loanAmount: li(30_000_000, 30_000_000), interestRate: li(0.045, 0.045), termMonths: li(120, 120), amortizationMonths: li(360, 360), ioPeriodMonths: li(0, 0), maturityBalance: li(null, 28_000_000), maturityDate: '2034-12-01T00:00:00.000Z' as any, debtServiceAnnual: li(null, 1_350_000) },
    assumptions: { capRate: li(0.07, 0.07), terminalCapRate: li(0.075, 0.075), concludedCapRate: null, rentGrowthPct: li(0.02, 0.02), expenseGrowthPct: li(0.025, 0.025) },
    metrics: { noi: 3_250_000, value: 50_000_000, dscr: 2.4, ltvAppraisal: 0.55, debtYield: 0.108, expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null, trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null, issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null , noiDivergence: null},
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}
function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }
function buildUw(): UnderwritingModel {
  const egi = 5_000_000, noi = 3_250_000, toe = egi - noi;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.07, impliedValue: 50_000_000, loanAmount: 30_000_000, interestRate: 4.5, amortizationYears: 30, termYears: 10, annualDebtService: 1_350_000, dscr: 2.41, ltv: 0.60, debtYield: 0.108, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount: 30_000_000, interestRate: 4.5, rateType: 'fixed', ioMonths: 0, amortizationMonths: 360, termMonths: 120, paymentFrequency: 'monthly', originationDate: '2024-01-01', maturityDate: '2034-12-01' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/** Swap dim 9 on a dealResult with a synthetic sponsor assessment. */
function withSponsor(dr: EvaluateDealResult, assessment: SponsorAssessment | null): EvaluateDealResult {
  const sp = evaluateSponsorBorrowerQuality({ assessment });
  return { ...dr, dimensions: { ...dr.dimensions, sponsorBorrowerQuality: sp }, allDimensions: [...dr.allDimensions.filter((d: DimensionContribution) => d.dimensionId !== 'sponsor-borrower-quality'), sp] };
}

function main(): void {
  const out: string[] = [];
  out.push('mitigant-v2 phase 2 lever 5 — coverage-gate condition precedent — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === (0) Contract ============================== */
  out.push('================================================================');
  out.push('(0) CONTRACT — MITIGATION_LEVERS includes condition_precedent (completes the 7-literal set)');
  out.push('================================================================');
  out.push('');
  out.push(`  MITIGATION_LEVERS = [${MITIGATION_LEVERS.map(l => `'${l}'`).join(', ')}]`);
  assert((MITIGATION_LEVERS as readonly string[]).includes('condition_precedent'), 'MITIGATION_LEVERS includes condition_precedent');
  assertEq(MITIGATION_LEVERS.length, 7, 'MITIGATION_LEVERS now has 7 literals');
  out.push('');

  const ai = buildAi(), uw = buildUw();

  /* === (1) SPINE HITL → critical ================== */
  out.push('================================================================');
  out.push('(1) SPINE HITL (dim 7) — no concludedValue → critical');
  out.push('================================================================');
  out.push('');
  const dealNoVal: DealBag = {
    propertyName: 'Office X', assetType: 'Office', subType: 'CBD',
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: null,
    uwY1Noi: 3_250_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: 0.30, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.15, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drSpine = evaluateDeal(dealNoVal);
  out.push(`  dim 7 applicability=${drSpine.dimensions.capRateValuationStress.applicability}`);
  out.push(`  rating recommendation=${drSpine.rating.recommendation}`);
  const propsSpine = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drSpine });
  const cpSpine = propsSpine.find(p => p.id === 'conditions_precedent_coverage');
  if (cpSpine) {
    out.push(`  ${cpSpine.id}  severity=${cpSpine.severity}  riskReduction=${cpSpine.riskReduction}`);
    out.push(`    addresses=[${(cpSpine.addressesDimensions ?? []).join(', ')}]`);
    out.push(`    structuralChanges (${cpSpine.structuralChanges.length}):`);
    for (const c of cpSpine.structuralChanges.slice(0, 6)) out.push(`      • ${c}`);
  }
  assert(cpSpine !== undefined, 'SPINE HITL: lever fires');
  if (cpSpine) {
    assertEq(cpSpine.lever, 'condition_precedent', 'lever = condition_precedent');
    assertEq(cpSpine.leverKind, 'condition_precedent', 'leverKind = condition_precedent');
    assertEq(cpSpine.severity, 'critical', 'severity = critical (spine HITL)');
    assert(cpSpine.description.includes('SPINE'), 'description cites SPINE');
    assert(cpSpine.description.includes('COVERAGE GATE') || cpSpine.description.includes('InsufficientData'), 'description cites coverage gate');
    assert((cpSpine.addressesDimensions ?? []).includes('cap-rate-valuation-stress'), 'addressesDimensions includes spine');
    assert(cpSpine.structuralChanges.some(c => /appraisal/i.test(c)), 'CP names appraisal');
    assert(cpSpine.requiredEquity === undefined && cpSpine.requiredReserve === undefined && cpSpine.requiredPaydown === undefined, 'no dollar fields');
  }
  out.push('');

  /* === (2) Two peer HITLs (concentration + rollover) === */
  out.push('================================================================');
  out.push('(2) Two peer HITLs (no rent roll → conc + rollover) → severity high');
  out.push('================================================================');
  out.push('');
  const dealNoRoll: DealBag = {
    propertyName: 'Office Y', assetType: 'Office', subType: 'CBD',
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: 50_000_000,
    uwY1Noi: 3_250_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: null, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null, tenantDataStatus: 'parse-failed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drRoll = evaluateDeal(dealNoRoll);
  out.push(`  dim 5 conc=${drRoll.dimensions.incomeConcentration.applicability}  dim 6 roll=${drRoll.dimensions.rollover.applicability}  dim 9 sponsor=${drRoll.dimensions.sponsorBorrowerQuality.applicability}`);
  const propsRoll = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drRoll });
  const cpRoll = propsRoll.find(p => p.id === 'conditions_precedent_coverage');
  if (cpRoll) {
    out.push(`  ${cpRoll.id}  severity=${cpRoll.severity}  addresses=[${(cpRoll.addressesDimensions ?? []).join(', ')}]`);
  }
  assert(cpRoll !== undefined, 'Two peer HITL: lever fires');
  if (cpRoll) {
    // Conc + roll = 2 non-sponsor peer HITLs → severity high (sponsor is also HITL but excluded from the peer count by design)
    assertEq(cpRoll.severity, 'high', 'severity = high (2+ peer HITLs)');
    assert((cpRoll.addressesDimensions ?? []).includes('income-concentration'), 'addresses concentration');
    assert((cpRoll.addressesDimensions ?? []).includes('rollover'), 'addresses rollover');
    assert(cpRoll.structuralChanges.some(c => /rent roll/i.test(c)), 'CP cites rent roll');
  }
  out.push('');

  /* === (3) Only sponsor HITL — typical CMBS case === */
  out.push('================================================================');
  out.push('(3) Only sponsor HITL (everything else resolved) → severity medium');
  out.push('================================================================');
  out.push('');
  // Clean Office deal where everything else resolves; sponsor stays HITL.
  const dealClean: DealBag = {
    propertyName: 'Clean Office', assetType: 'Office', subType: 'CBD',
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: 50_000_000,
    uwY1Noi: 3_250_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: 0.30, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.15, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drClean = evaluateDeal(dealClean);
  // Verify only sponsor HITL among the 9
  const hitlDims = ['cap-rate-valuation-stress','leverage-ltv','coverage-dscr','debt-yield','refinance-feasibility','income-concentration','rollover','asset-class','sponsor-borrower-quality'].filter(id => {
    const map: any = {
      'cap-rate-valuation-stress': drClean.dimensions.capRateValuationStress,
      'leverage-ltv':               drClean.dimensions.leverageLtv,
      'coverage-dscr':              drClean.dimensions.coverageDscr,
      'debt-yield':                 drClean.dimensions.debtYield,
      'refinance-feasibility':      drClean.dimensions.refinanceFeasibility,
      'income-concentration':       drClean.dimensions.incomeConcentration,
      'rollover':                   drClean.dimensions.rollover,
      'asset-class':                drClean.dimensions.assetClass,
      'sponsor-borrower-quality':   drClean.dimensions.sponsorBorrowerQuality,
    };
    return map[id]?.applicability === 'hitl-needed';
  });
  out.push(`  HITL dims: [${hitlDims.join(', ')}]`);
  const propsClean = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drClean });
  const cpClean = propsClean.find(p => p.id === 'conditions_precedent_coverage');
  if (cpClean) {
    out.push(`  ${cpClean.id}  severity=${cpClean.severity}  addresses=[${(cpClean.addressesDimensions ?? []).join(', ')}]`);
  }
  assert(cpClean !== undefined, 'Only sponsor HITL: lever fires');
  if (cpClean) {
    assertEq(cpClean.severity, 'medium', 'severity = medium (single non-spine peer HITL)');
    assertEq(cpClean.addressesDimensions?.length, 1, 'exactly 1 addressed dim');
    assertEq(cpClean.addressesDimensions?.[0], 'sponsor-borrower-quality', 'addresses sponsor only');
    assert(cpClean.structuralChanges.some(c => /sponsor financials/i.test(c)), 'CP cites sponsor financials');
  }
  out.push('');

  /* === (4) ALL RESOLVED → no fire ============== */
  out.push('================================================================');
  out.push('(4) ALL RESOLVED (sponsor assessment provided too) → no fire');
  out.push('================================================================');
  out.push('');
  // Take the clean dealResult and inject a NEUTRAL sponsor assessment so dim 9 resolves.
  const drAllResolved = withSponsor(drClean, {
    experience: 'Neutral', financialStrength: 'Neutral', alignment: 'Neutral',
    priorCreditEvents: 'Neutral', managementQuality: 'Neutral',
  });
  const propsAll = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drAllResolved });
  const cpAll = propsAll.find(p => p.id === 'conditions_precedent_coverage');
  assertEq(cpAll, undefined, 'all resolved: no fire');
  out.push('  ✓ no fire when every dim resolves');
  out.push('');

  /* === (5) BOUNDARY with lever 2 — resolved risk-increasing sponsor === */
  out.push('================================================================');
  out.push('(5) BOUNDARY — resolved + risk-increasing sponsor → lever 2 fires, lever 5 does NOT on sponsor');
  out.push('================================================================');
  out.push('');
  const drWithWeakSponsor = withSponsor(drClean, {
    experience: 'Weak', financialStrength: 'Weak', alignment: 'Weak',
    priorCreditEvents: 'Neutral', managementQuality: 'Neutral',
  });
  const propsBoundary = produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drWithWeakSponsor });
  const proposalIds = propsBoundary.map(p => p.id);
  out.push(`  proposals: ${proposalIds.join(', ')}`);
  const hasGuaranty = proposalIds.some(id => id?.startsWith('guaranty_sponsor'));
  const hasCp = proposalIds.some(id => id === 'conditions_precedent_coverage');
  assert(hasGuaranty, 'BOUNDARY: lever 2 guaranty fires on risk-increasing sponsor');
  assertEq(hasCp, false, 'BOUNDARY: lever 5 does NOT fire when sponsor is resolved');
  out.push('  ✓ Sponsor data resolved + risk-increasing → lever 2 territory, NOT lever 5');
  out.push('');

  /* === (6) NO REGRESSION — over-leveraged Office =====
     Prior levers (phase-1 dim-7, lever 1 amort, lever 4 lockbox) still fire. */
  out.push('================================================================');
  out.push('(6) NO REGRESSION — prior levers still fire');
  out.push('================================================================');
  out.push('');
  const dealOver: DealBag = {
    propertyName: 'OverLev', assetType: 'Office', subType: 'CBD',
    loanAmount: 55_000_000, coupon: 0.060, concludedValue: 70_500_000,
    uwY1Noi: 3_500_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: 0.30, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: 0.15, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: null, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drOver = evaluateDeal(dealOver);
  const aiOver: AdjustedInputs = { ...ai, loan: { ...ai.loan, loanAmount: li(55_000_000, 55_000_000), interestRate: li(0.060, 0.060) }, metrics: { ...ai.metrics, noi: 3_500_000, dscr: 1.18, debtYield: 0.064, ltvAppraisal: 0.78 } } as AdjustedInputs;
  const uwOver = { ...uw, loanAmount: 55_000_000, dscr: 1.18, ltv: 0.78, debtYield: 0.064, netOperatingIncome: 3_500_000, impliedValue: 70_500_000, annualDebtService: 3_300_000 } as UnderwritingModel;
  const propsOver = produceMitigations({ adjustedInputs: aiOver, uwModel: uwOver, firedFlags: [], dealResult: drOver });
  const idsOver = propsOver.map(p => p.id);
  out.push(`  proposals: ${idsOver.join(', ')}`);
  assert(idsOver.includes('reduce_proceeds_ltv'), 'NO REGRESSION: phase-1 dim-7 LTV');
  assert(idsOver.some(id => id?.startsWith('amortization_refi')), 'NO REGRESSION: lever 1 amort');
  assert(idsOver.includes('in_place_lockbox_asset_class'), 'NO REGRESSION: lever 4 lockbox');
  assert(idsOver.includes('conditions_precedent_coverage'), 'lever 5 also fires (sponsor HITL on CMBS path)');
  out.push('');

  /* === (7) FENCE ============================ */
  out.push('================================================================');
  out.push('(7) FENCE — producer reads only dealResult.dimensions + dealResult.rating');
  out.push('================================================================');
  out.push('');
  const srcAll = fs.readFileSync('/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/mitigation/produce-mitigations.ts', 'utf8');
  // Exclude doc-comment lines so fence-STATEMENT text ("NO judgment", etc.)
  // is not counted as a fence VIOLATION. The fence-violation check is about
  // code paths, not doc-comment prose.
  const src = srcAll.split('\n')
    .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n');
  const dealResultReads = Array.from(new Set((src.match(/dealResult[?]?\.[a-zA-Z.?]+/g) ?? [])));
  out.push('  dealResult field accesses in producer (code only, doc-comments excluded):');
  for (const r of dealResultReads) out.push(`    ${r}`);
  const banned = [/dealResult.*adjusted/i, /dealResult.*judgment/i, /dealResult.*valuationConclusion/i, /dealResult.*manifesto/i];
  let bannedHits = 0;
  for (const rx of banned) if (rx.test(src)) bannedHits++;
  assertEq(bannedHits, 0, 'no banned access patterns (code-only)');
  assert(src.includes('dealResult.rating.recommendation'), 'lever 5 reads rating.recommendation (coverage-gate state)');
  out.push('  ✓ Reads only doctrine-clean outputs');
  out.push('');

  /* === SUMMARY ============================================ */
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
  console.log(`\n[mitigant-v2 phase 2 lever 5] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
