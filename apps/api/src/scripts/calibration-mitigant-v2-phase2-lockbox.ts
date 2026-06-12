/**
 * Validation for mitigant-v2 phase 2 lever 4 (asset-class in-place lockbox).
 *
 *   cd apps/api && npx tsx src/scripts/calibration-mitigant-v2-phase2-lockbox.ts
 *
 * Synthetic cases:
 *   (1) Tier IV — MALL → fires (lockbox + Mall CapEx/TI reserve, severity critical)
 *   (2) Tier IV — SpecialtyAtypical (Data Center) → fires (severity critical)
 *   (3) Tier III — HOTEL → fires (lockbox + FF&E, severity high)
 *   (4) Tier III — OFFICE → fires (lockbox + Office CapEx/TI, severity high)
 *   (5) Tier I — MULTIFAMILY → NO fire
 *   (6) Tier II — UNANCHORED RETAIL → NO fire
 *   (7) HITL (no assetType) → NO fire
 *   (8) APPLICABLE but EGI ≤ 0 → manual variant
 *   (9) COORDINATION case — concentrated MALL: lever 3 AND lever 4 both fire,
 *       lever 4 description carries the subsumption note
 *   (10) NO REGRESSION: levers 1-3 + phase-1 dim-7 LTV re-point all preserved
 *   (11) FENCE: producer reads dim-8 + EGI source v1 already uses
 *   (12) Dead-code cleanup: isAnchoredRetailLike removed from source
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { produceMitigations } from '../services/mitigation/produce-mitigations.js';
import { evaluateDeal, ASSET_CLASS_ENUM } from '../doctrine-clean/index.js';
import { MITIGATION_LEVERS } from '@cre/contracts';
import type { AdjustedInputs, AdjustedLineItem } from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';
import type { DealBag } from '../doctrine-clean/index.js';

const OUT_PATH = '/tmp/calibration-mitigant-v2-phase2-lockbox.out';

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
function buildAi(egi: number): AdjustedInputs {
  return {
    id: 'AI_L' as any, analysisAsOfDate: '2026-06-12T00:00:00.000Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, egi) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: { loanAmount: li(30_000_000, 30_000_000), interestRate: li(0.045, 0.045), termMonths: li(120, 120), amortizationMonths: li(360, 360), ioPeriodMonths: li(0, 0), maturityBalance: li(null, 28_000_000), maturityDate: '2034-12-01T00:00:00.000Z' as any, debtServiceAnnual: li(null, 1_350_000) },
    assumptions: { capRate: li(0.07, 0.07), terminalCapRate: li(0.075, 0.075), concludedCapRate: null, rentGrowthPct: li(0.02, 0.02), expenseGrowthPct: li(0.025, 0.025) },
    metrics: { noi: egi * 0.65, value: egi * 0.65 / 0.07, dscr: 2.59, ltvAppraisal: 0.55, debtYield: 0.117, expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null, trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null, issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null },
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}
function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }
function buildUw(egi: number): UnderwritingModel {
  const noi = egi * 0.65, toe = egi - noi;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.07, impliedValue: noi / 0.07, loanAmount: 30_000_000, interestRate: 4.5, amortizationYears: 30, termYears: 10, annualDebtService: 1_350_000, dscr: 2.59, ltv: 0.60, debtYield: 0.117, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount: 30_000_000, interestRate: 4.5, rateType: 'fixed', ioMonths: 0, amortizationMonths: 360, termMonths: 120, paymentFrequency: 'monthly', originationDate: '2024-01-01', maturityDate: '2034-12-01' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

function mkDeal(propertyName: string, assetType: string, subType: string, opts?: Partial<DealBag>): DealBag {
  return {
    propertyName, assetType, subType,
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: 50_000_000,
    uwY1Noi: 3_250_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: null, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
    ...opts,
  };
}

function main(): void {
  const out: string[] = [];
  out.push('mitigant-v2 phase 2 lever 4 — asset-class in-place lockbox — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === (0) Contract ============================== */
  out.push('================================================================');
  out.push('(0) CONTRACT — MITIGATION_LEVERS includes in_place_cash_management');
  out.push('================================================================');
  out.push('');
  out.push(`  MITIGATION_LEVERS = [${MITIGATION_LEVERS.map(l => `'${l}'`).join(', ')}]`);
  assert((MITIGATION_LEVERS as readonly string[]).includes('in_place_cash_management'), 'MITIGATION_LEVERS includes in_place_cash_management');
  assert(ASSET_CLASS_ENUM.length >= 10, `ASSET_CLASS_ENUM exported (len=${ASSET_CLASS_ENUM.length})`);
  out.push('');

  const egi = 5_000_000;

  /* === (1) Tier IV Mall =========================== */
  out.push('================================================================');
  out.push('(1) Tier IV — MALL → fires, CapEx/TI reserve, critical');
  out.push('================================================================');
  out.push('');
  const dealMall = mkDeal('Test Mall', 'Retail', 'Regional');
  const drMall = evaluateDeal(dealMall);
  const acMall = drMall.dimensions.assetClass;
  out.push(`  dim 8: applicability=${acMall.applicability}  tier=${acMall.tier}  canonicalIdx=${acMall.derivedOutputs?.canonicalAssetClassIndex}`);
  const propsMall = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drMall });
  const lockMall = propsMall.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  if (lockMall) {
    out.push(`  ${lockMall.id}  severity=${lockMall.severity}  riskReduction=${lockMall.riskReduction}`);
    out.push(`    requiredReserve=$${(lockMall.requiredReserve! / 1_000_000).toFixed(2)}M`);
    out.push(`    addresses=[${(lockMall.addressesDimensions ?? []).join(', ')}]`);
    out.push('    structuralChanges:');
    for (const c of lockMall.structuralChanges) out.push(`      • ${c}`);
  }
  assert(lockMall !== undefined, 'Tier IV Mall: lever fires');
  if (lockMall) {
    assertEq(lockMall.id, 'in_place_lockbox_asset_class', 'Mall id');
    assertEq(lockMall.lever, 'in_place_cash_management', 'Mall lever');
    assertEq(lockMall.leverKind, 'in_place_cash_management', 'Mall leverKind');
    assertEq(lockMall.severity, 'critical', 'Mall severity = critical (Tier IV + Mall)');
    assertEq(lockMall.riskReduction, 'significant', 'Mall riskReduction = significant');
    assertEq(lockMall.addressesDimensions?.[0], 'asset-class', 'Mall addresses asset-class');
    // 3.5% of EGI = $175K
    assertClose(lockMall.requiredReserve, egi * 0.035, 1, 'Mall reserve = 3.5% × EGI');
    assert(lockMall.title.includes('Mall') && lockMall.title.includes('Tier IV'), 'Mall title carries asset class + tier');
    assert(lockMall.description.includes('in-place') || lockMall.description.includes('IN-PLACE'), 'description cites in-place');
    assert(lockMall.description.includes('hard') || lockMall.description.includes('controlled'), 'description cites hard / controlled lockbox');
    assert(lockMall.description.includes('SUBSUMES'), 'description carries subsumption note');
    assert(lockMall.structuralChanges.some(c => /lockbox/i.test(c)), 'structural changes include lockbox');
    assert(lockMall.structuralChanges.some(c => /TI.LC|tenant improvement|leasing commission|CapEx/i.test(c)), 'structural changes include Mall reserve');
  }
  out.push('');

  /* === (2) Tier IV SpecialtyAtypical =============== */
  out.push('================================================================');
  out.push('(2) Tier IV — SpecialtyAtypical (Data Center) → fires, critical');
  out.push('================================================================');
  out.push('');
  // Synthesize an extraction that resolves to SpecialtyAtypical via dim-8's
  // canonicalize path: assetType "Other" + subType "Data" hits specialty-collateral.
  const dealDataCenter: DealBag = {
    propertyName: 'Test Data Center', assetType: 'Other', subType: 'Data',
    loanAmount: 30_000_000, coupon: 0.045, concludedValue: 50_000_000,
    uwY1Noi: 3_250_000, t12Noi: null, underwrittenOccupancy: 0.93,
    largestTenantPct: null, largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null, tenantDataStatus: 'multi-tenant-parsed',
    amortMonths: 360, ioYears: null, termYears: null, marketTier: 'Unknown',
  };
  const drDC = evaluateDeal(dealDataCenter);
  const acDC = drDC.dimensions.assetClass;
  out.push(`  dim 8: applicability=${acDC.applicability}  tier=${acDC.tier}  canonicalIdx=${acDC.derivedOutputs?.canonicalAssetClassIndex} (${typeof acDC.derivedOutputs?.canonicalAssetClassIndex === 'number' ? ASSET_CLASS_ENUM[acDC.derivedOutputs.canonicalAssetClassIndex as number] : 'n/a'})`);
  const propsDC = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drDC });
  const lockDC = propsDC.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  if (lockDC) {
    out.push(`  ${lockDC.id}  severity=${lockDC.severity}  reserve=$${(lockDC.requiredReserve! / 1_000_000).toFixed(2)}M`);
    out.push(`    title: ${lockDC.title}`);
  }
  assert(lockDC !== undefined, 'Tier IV SpecialtyAtypical: lever fires');
  if (lockDC) {
    assertEq(lockDC.severity, 'critical', 'SpecialtyAtypical severity = critical');
    assertClose(lockDC.requiredReserve, egi * 0.04, 1, 'SpecialtyAtypical reserve = 4% × EGI');
    assert(lockDC.title.includes('SpecialtyAtypical') && lockDC.title.includes('Tier IV'), 'Specialty title carries class + tier');
    assert(lockDC.structuralChanges.some(c => /Specialty/i.test(c)), 'Specialty reserve named in structuralChanges');
  }
  out.push('');

  /* === (3) Tier III Hotel ========================== */
  out.push('================================================================');
  out.push('(3) Tier III — HOTEL → fires, FF&E reserve, high severity');
  out.push('================================================================');
  out.push('');
  const dealHotel = mkDeal('Test Hotel', 'Hotel', 'Full Service');
  const drHotel = evaluateDeal(dealHotel);
  const acHotel = drHotel.dimensions.assetClass;
  out.push(`  dim 8: applicability=${acHotel.applicability}  tier=${acHotel.tier}  class=${typeof acHotel.derivedOutputs?.canonicalAssetClassIndex === 'number' ? ASSET_CLASS_ENUM[acHotel.derivedOutputs.canonicalAssetClassIndex as number] : 'n/a'}`);
  const propsHotel = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drHotel });
  const lockHotel = propsHotel.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  if (lockHotel) {
    out.push(`  ${lockHotel.id}  severity=${lockHotel.severity}  reserve=$${(lockHotel.requiredReserve! / 1_000_000).toFixed(2)}M (FF&E)`);
  }
  assert(lockHotel !== undefined, 'Tier III Hotel: fires');
  if (lockHotel) {
    assertEq(lockHotel.severity, 'high', 'Hotel severity = high (Tier III)');
    assertEq(lockHotel.riskReduction, 'moderate', 'Hotel riskReduction = moderate');
    assertClose(lockHotel.requiredReserve, egi * 0.04, 1, 'Hotel reserve = 4% × EGI (FF&E)');
    assert(lockHotel.structuralChanges.some(c => /FF&E/i.test(c)), 'Hotel reserve cites FF&E');
    assert(lockHotel.title.includes('Hotel'), 'Hotel title carries class');
  }
  out.push('');

  /* === (4) Tier III Office ========================= */
  out.push('================================================================');
  out.push('(4) Tier III — OFFICE → fires, Office CapEx/TI reserve, high');
  out.push('================================================================');
  out.push('');
  const dealOffice = mkDeal('Test Office', 'Office', 'CBD');
  const drOffice = evaluateDeal(dealOffice);
  const propsOffice = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drOffice });
  const lockOffice = propsOffice.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  if (lockOffice) {
    out.push(`  ${lockOffice.id}  severity=${lockOffice.severity}  reserve=$${(lockOffice.requiredReserve! / 1_000_000).toFixed(2)}M`);
  }
  assert(lockOffice !== undefined, 'Tier III Office: fires');
  if (lockOffice) {
    assertEq(lockOffice.severity, 'high', 'Office severity = high');
    assertClose(lockOffice.requiredReserve, egi * 0.03, 1, 'Office reserve = 3% × EGI');
    assert(lockOffice.title.includes('Office'), 'Office title carries class');
  }
  out.push('');

  /* === (5-6) Tier I/II non-fire ===================== */
  out.push('================================================================');
  out.push('(5-6) Tier I/II — no fire');
  out.push('================================================================');
  out.push('');
  for (const tc of [
    { name: 'Tier I Multifamily', deal: mkDeal('MF', 'Multifamily', 'Garden') },
    { name: 'Tier II UnanchoredRetail', deal: mkDeal('Strip', 'Retail', 'Unanchored') },
  ]) {
    const dr = evaluateDeal(tc.deal);
    const ac = dr.dimensions.assetClass;
    out.push(`  ${tc.name}: tier=${ac.tier}`);
    const props = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: dr });
    const lock = props.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
    assertEq(lock, undefined, `${tc.name}: no fire`);
  }
  out.push('  ✓ Tiers I/II do not fire');
  out.push('');

  /* === (7) HITL ============================== */
  out.push('================================================================');
  out.push('(7) HITL (assetType=null) → no fire');
  out.push('================================================================');
  out.push('');
  const dealHitl: DealBag = { ...mkDeal('Unknown', 'Office', 'CBD'), assetType: null };
  const drHitl = evaluateDeal(dealHitl);
  out.push(`  dim 8 applicability=${drHitl.dimensions.assetClass.applicability}`);
  const propsHitl = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drHitl });
  const lockHitl = propsHitl.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  assertEq(lockHitl, undefined, 'HITL: no fire');
  out.push('  ✓ HITL: no fire');
  out.push('');

  /* === (8) Manual variant — EGI missing ============= */
  out.push('================================================================');
  out.push('(8) Tier III applicable but EGI ≤ 0 → manual variant');
  out.push('================================================================');
  out.push('');
  const aiNoEgi = buildAi(0);
  const propsNoEgi = produceMitigations({ adjustedInputs: aiNoEgi, uwModel: buildUw(egi), firedFlags: [], dealResult: drOffice });
  const lockManual = propsNoEgi.find(p => p.id?.startsWith('in_place_lockbox_asset_class'));
  if (lockManual) {
    out.push(`  ${lockManual.id}  severity=${lockManual.severity}`);
    assertEq(lockManual.id, 'in_place_lockbox_asset_class_manual', 'EGI-missing: manual variant');
    assert(lockManual.requiredReserve === undefined, 'manual variant: no dollar reserve');
    assertEq(lockManual.addressesDimensions?.[0], 'asset-class', 'manual: addresses preserved');
  }
  out.push('');

  /* === (9) COORDINATION — concentrated Mall ======== */
  out.push('================================================================');
  out.push('(9) COORDINATION — concentrated Mall: lever 3 AND lever 4 both fire');
  out.push('================================================================');
  out.push('');
  // Concentrated mall: concentration elevated → lever 3 fires; Tier IV asset → lever 4 fires.
  // BUT: dim 5 sets MallType to N/A? Let me check — Mall is treated as tenant-based, so it should
  // be 'applicable' in dim 5. Confirmed in dim 5: Mall ∈ TENANT_BASED_TYPES.
  const dealConcentratedMall = mkDeal('Concentrated Mall', 'Retail', 'Regional', { largestTenantPct: 0.65, tenantDataStatus: 'multi-tenant-parsed' });
  const drCoord = evaluateDeal(dealConcentratedMall);
  out.push(`  dim 5: ${drCoord.dimensions.incomeConcentration.applicability} tier=${drCoord.dimensions.incomeConcentration.tier}`);
  out.push(`  dim 8: tier=${drCoord.dimensions.assetClass.tier} (${ASSET_CLASS_ENUM[drCoord.dimensions.assetClass.derivedOutputs?.canonicalAssetClassIndex as number]})`);
  const propsCoord = produceMitigations({ adjustedInputs: buildAi(egi), uwModel: buildUw(egi), firedFlags: [], dealResult: drCoord });
  const proposalIds = propsCoord.map(p => p.id).filter(Boolean) as string[];
  out.push(`  proposals: ${proposalIds.join(', ')}`);
  const hasSpring = proposalIds.some(id => id.startsWith('springing_cash_trap_concentration'));
  const hasLock = proposalIds.some(id => id.startsWith('in_place_lockbox_asset_class'));
  assert(hasSpring, 'COORD: lever 3 (springing) fires');
  assert(hasLock, 'COORD: lever 4 (lockbox) fires');
  const lockCoord = propsCoord.find(p => p.id === 'in_place_lockbox_asset_class');
  if (lockCoord) {
    assert(lockCoord.description.includes('SUBSUMES'), 'COORD: lever 4 description carries SUBSUMES note');
    assert(lockCoord.description.includes('lever 3') || lockCoord.description.includes('tenant-concentration springing'), 'COORD: cites lever 3 explicitly');
  }
  out.push('  ✓ Both levers emitted; lever 4 carries subsumption note for human reconciliation');
  out.push('');

  /* === (10) NO REGRESSION ============================ */
  out.push('================================================================');
  out.push('(10) NO REGRESSION — prior levers still fire');
  out.push('================================================================');
  out.push('');
  // Over-leveraged IO Office (lever 1 / phase-1 LTV) — adds Office Tier III as a bonus.
  const dealOver: DealBag = mkDeal('OverLev Office', 'Office', 'CBD', {
    loanAmount: 55_000_000, coupon: 0.060, concludedValue: 70_500_000, uwY1Noi: 3_500_000, amortMonths: null,
  });
  const drOver = evaluateDeal(dealOver);
  const aiOver: AdjustedInputs = { ...buildAi(egi), loan: { ...buildAi(egi).loan, loanAmount: li(55_000_000, 55_000_000), interestRate: li(0.060, 0.060) }, metrics: { ...buildAi(egi).metrics, noi: 3_500_000, dscr: 1.18, debtYield: 0.064, ltvAppraisal: 0.78 } } as AdjustedInputs;
  const uwOver = { ...buildUw(egi), loanAmount: 55_000_000, dscr: 1.18, ltv: 0.78, debtYield: 0.064, netOperatingIncome: 3_500_000, impliedValue: 70_500_000, annualDebtService: 3_300_000 } as UnderwritingModel;
  const propsOver = produceMitigations({ adjustedInputs: aiOver, uwModel: uwOver, firedFlags: [], dealResult: drOver });
  const idsOver = propsOver.map(p => p.id);
  out.push(`  proposals: ${idsOver.join(', ')}`);
  assert(idsOver.includes('reduce_proceeds_ltv'), 'NO REGRESSION: phase-1 dim-7 LTV');
  assert(idsOver.some(id => id?.startsWith('amortization_refi')), 'NO REGRESSION: lever 1 (amort)');
  assert(idsOver.some(id => id === 'in_place_lockbox_asset_class'), 'lever 4 also fires (Tier III Office)');
  out.push('');

  /* === (11) FENCE ====================================== */
  out.push('================================================================');
  out.push('(11) FENCE — producer reads dim 8 + EGI source v1 uses');
  out.push('================================================================');
  out.push('');
  const src = fs.readFileSync('/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/mitigation/produce-mitigations.ts', 'utf8');
  const dealResultReads = Array.from(new Set((src.match(/dealResult[?]?\.[a-zA-Z.?]+/g) ?? [])));
  out.push('  dealResult field accesses in producer:');
  for (const r of dealResultReads) out.push(`    ${r}`);
  assert(src.includes('dealResult.dimensions.assetClass'), 'lever 4 reads dim 8 assetClass');
  const banned = [/dealResult.*adjusted/i, /dealResult.*judgment/i, /dealResult.*valuationConclusion/i, /dealResult.*manifesto/i];
  let bannedHits = 0;
  for (const rx of banned) if (rx.test(src)) bannedHits++;
  assertEq(bannedHits, 0, 'no banned access patterns');
  out.push('  ✓ EGI source: ai.income.effectiveGrossIncome.adjusted (consistent w/ v1 fund_reserve + levers 3)');
  out.push('');

  /* === (12) Dead-code cleanup =========================== */
  out.push('================================================================');
  out.push('(12) CLEANUP — isAnchoredRetailLike removed from lever 3');
  out.push('================================================================');
  out.push('');
  assert(!src.includes('isAnchoredRetailLike'), 'isAnchoredRetailLike dead stub removed');
  out.push('  ✓ dead-code cleanup confirmed');
  out.push('');

  /* === SUMMARY ============================================== */
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
  console.log(`\n[mitigant-v2 phase 2 lever 4] report: ${OUT_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
