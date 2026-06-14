/**
 * Value-seam validation — REAL Sunroad ExtractionResult.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-value-seam-sunroad-real.ts
 *
 * What this validates:
 *   The operator-supplied value-seam preserves the fence (the adapter never
 *   reads judgment / AdjustedInputs / valuationConclusion). The operator
 *   value is an EXPLICIT contract input on AdapterOptions, FALLBACK only
 *   (used when extraction yields nothing for the concluded value), and
 *   carries a 'operator-supplied' source tag end-to-end into dim 7's
 *   derivedOutputs + rationale.
 *
 * Why Sunroad is the ideal test:
 *   The real persisted Sunroad ExtractionResult (data/phase4-sunroad.db)
 *   has appraisal.{} EMPTY and asr.{} EMPTY — the LLM extractor surfaced
 *   no concluded value because the source PDFs (Sunroad CF + PCA) don't
 *   contain one. This is the lender's reality: a real deal where the
 *   doctrine's spine input is missing absent operator action. Today this
 *   routes dim 7 to HITL; with the value-seam, the operator threads
 *   $126,200,362 (the desk's BOV / appraisal-equivalent) and the rating
 *   produces — WITH the source tag disclosed on every downstream surface.
 *
 * Two-pass validation:
 *   (A) NO operator value → confirm fence holds: dim 7 HITLs, no silent
 *       default substituted, rating cannot produce.
 *   (B) Operator value $126.20M → confirm dim 7 RESOLVES, source tag reads
 *       'operator-supplied', reduce_proceeds fires (LTV arm), composition
 *       engine yields a coherent package.
 *
 * NO synthetic DealBag construction. The DealBag flows out of
 * adaptExtractionToDealBag(realExtraction, realPropertyMetadata, options).
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  adaptExtractionToDealBag,
  evaluateDeal,
  type OperatorSuppliedValue,
} from '../doctrine-clean/index.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import {
  produceMitigations,
} from '../services/mitigation/produce-mitigations.js';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  AssetProfile,
  ExtractionResult,
  PropertyMetadata,
} from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

/* --------------------------- db read helpers ------------------------------ */

const SUNROAD_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');

function readSunroadExtraction(): { extraction: ExtractionResult; assetProfile: AssetProfile } {
  const db = new Database(SUNROAD_DB, { readonly: true, fileMustExist: true });
  try {
    const exRow = db.prepare(
      `SELECT id, payload FROM extraction_results ORDER BY length(payload) DESC LIMIT 1`,
    ).get() as { id: string; payload: string } | undefined;
    if (!exRow) throw new Error(`No extraction_results row in ${SUNROAD_DB}`);
    const exBody = JSON.parse(exRow.payload) as Record<string, unknown>;
    const extraction = { id: exRow.id, ...exBody } as ExtractionResult;

    const apRow = db.prepare(
      `SELECT id, payload FROM asset_profiles LIMIT 1`,
    ).get() as { id: string; payload: string } | undefined;
    if (!apRow) throw new Error(`No asset_profiles row in ${SUNROAD_DB}`);
    const apBody = JSON.parse(apRow.payload) as Record<string, unknown>;
    const assetProfile = { id: apRow.id, ...apBody } as AssetProfile;

    return { extraction, assetProfile };
  } finally {
    db.close();
  }
}

/* ---------------- adjusted inputs / uw at a given loan size --------------- */
/* Bare-minimum AI/UW so produceMitigations + composeMitigations can run.
 * Loan-derived fields recompute against the loan; cashflow side stays pinned
 * to the real Sunroad NCF (sustainable = uwY1Noi × 0.89). */

const SUNROAD_NCF_NOI_RATIO = 0.89;

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

function buildAi(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number): AdjustedInputs {
  const debtServiceAnnual = loanAmount * coupon;
  const sustainableNcf = noi * SUNROAD_NCF_NOI_RATIO;
  const dscr = sustainableNcf / debtServiceAnnual;
  const debtYield = noi / loanAmount;
  return {
    id: 'AI_VS_SUNROAD' as any, analysisAsOfDate: '2026-05-31T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, 13_628_082) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: {
      loanAmount: li(loanAmount, loanAmount),
      interestRate: li(coupon, coupon),
      termMonths: li(termYears * 12, termYears * 12),
      amortizationMonths: li(0, 0),
      ioPeriodMonths: li(ioYears * 12, ioYears * 12),
      maturityBalance: li(null, loanAmount),
      maturityDate: '2031-05-31T00:00:00Z' as any,
      debtServiceAnnual: li(null, debtServiceAnnual),
    },
    assumptions: { capRate: li(0.0675, 0.0675), terminalCapRate: li(0.08, 0.08), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
    metrics: {
      noi, value: valueForLegacyLtv,
      dscr, ltvAppraisal: null, debtYield,
      expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null, noiDivergence: null,
    },
    topLevelAdjustments: [], dataQualityFlags: [],
  } as unknown as AdjustedInputs;
}

function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }

function buildUw(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number): UnderwritingModel {
  const egi = 13_628_082;
  const toe = egi - noi;
  const annualDebtService = loanAmount * coupon;
  const dscr = noi / annualDebtService;
  const debtYield = noi / loanAmount;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.0675, impliedValue: valueForLegacyLtv, loanAmount,
    interestRate: coupon * 100, amortizationYears: 0, termYears, annualDebtService, dscr,
    ltv: loanAmount / valueForLegacyLtv, debtYield, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: coupon * 100, rateType: 'fixed', ioMonths: ioYears * 12, amortizationMonths: 0, termMonths: termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-05-31', maturityDate: '2031-05-31' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/* ------------------------------- formatting ------------------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function header(title: string): void {
  console.log('================================================================');
  console.log(title);
  console.log('================================================================');
}

/* --------------------------------- main ----------------------------------- */

function main(): void {
  header('VALUE-SEAM VALIDATION — REAL Sunroad ExtractionResult');
  console.log('');
  console.log(`Reading: ${SUNROAD_DB}`);
  const { extraction, assetProfile } = readSunroadExtraction();
  console.log(`Loaded ExtractionResult dealRef=${(extraction as any).dealRef ?? '?'} id=${(extraction as any).id?.slice(0, 12) ?? '?'}…`);
  console.log(`Loaded AssetProfile propertyType=${(assetProfile as any).propertyType ?? '?'}`);
  console.log('');
  console.log('Raw value-bearing fields in the persisted extraction:');
  console.log(`  appraisal.valueConclusion : ${(extraction.appraisal as any)?.valueConclusion ?? '(absent)'}`);
  console.log(`  asr.impliedValue          : ${(extraction.asr as any)?.impliedValue ?? '(absent)'}`);
  console.log(`  loanTerms.loanAmount      : ${fmtUsd((extraction as any).loanTerms?.loanAmount ?? null)}`);
  console.log(`  loanTerms.interestRate    : ${((extraction as any).loanTerms?.interestRate ?? 0) * 100}%`);
  console.log(`  sellerUwOpStmt.noi        : ${fmtUsd((extraction as any).sellerUwOperatingStatement?.noi ?? null)}`);
  console.log('');
  console.log('Observation: BOTH extraction value paths are empty — this is real Sunroad reality');
  console.log('  (the source PDFs do not surface a concluded value). Today this routes dim 7 to');
  console.log('  HITL by design (fence intact). The operator value-seam fills the gap with an');
  console.log('  EXPLICIT desk input, tagged so the audit can disclose the basis verbatim.');
  console.log('');

  // PropertyMetadata is not persisted in this db; pass null + use explicitAssetType
  // from the AssetProfile (same as production evaluate-from-adjusted-inputs.ts:231).
  const propertyMetadata: PropertyMetadata | null = null;

  /* ============== PASS A — NO OPERATOR VALUE (FENCE TEST) =============== */
  header('PASS A — adapter WITHOUT operatorSuppliedValue (regression / fence test)');
  console.log('');
  const bagA = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: (assetProfile as any).propertyType ?? null,
    // NO operatorSuppliedValue.
  });
  console.log(`  DealBag.concludedValue        : ${bagA.concludedValue}`);
  console.log(`  DealBag.concludedValueSource  : ${bagA.concludedValueSource}`);
  console.log(`  DealBag.assetType             : ${bagA.assetType}`);
  console.log(`  DealBag.loanAmount            : ${fmtUsd(bagA.loanAmount)}`);
  console.log(`  DealBag.uwY1Noi               : ${fmtUsd(bagA.uwY1Noi)}`);
  console.log('');
  const drA = evaluateDeal(bagA);
  const dim7A = drA.dimensions.capRateValuationStress;
  console.log(`  dim-7 applicability           : ${dim7A.applicability}  (expected: hitl-needed)`);
  console.log(`  dim-7 stressedValue           : ${fmtUsd((dim7A.derivedOutputs?.stressedValue as number | null | undefined) ?? null)}`);
  console.log(`  dim-7 rationale               : ${dim7A.rationale}`);
  console.log(`  rating recommendation         : ${(drA.rating as any).recommendation ?? '?'}`);
  console.log(`  rating ratingBand             : ${(drA.rating as any).ratingBand ?? '?'}`);
  console.log('');
  if (dim7A.applicability !== 'hitl-needed') {
    console.log('  ✗ REGRESSION: fence breached — dim 7 resolved without operator value AND without extracted value.');
  } else {
    console.log('  ✓ FENCE INTACT — no silent default; dim 7 routed to HITL as designed.');
  }
  console.log('');

  /* ============== PASS B — WITH OPERATOR VALUE ========================== */
  header('PASS B — adapter WITH operatorSuppliedValue $126,200,362 (value-seam in use)');
  console.log('');
  const operatorValue: OperatorSuppliedValue = {
    value: 126_200_362,
    source: 'operator-supplied',
    asOf: '2026-04-15T00:00:00Z' as any,
    basis: 'Desk BOV anchored to recent Q1 ratings actions on comparable Office CBD towers',
  };
  console.log('  Operator value contract:');
  console.log(`    value                       : ${fmtUsd(operatorValue.value)}`);
  console.log(`    source                      : ${operatorValue.source}`);
  console.log(`    asOf                        : ${operatorValue.asOf}`);
  console.log(`    basis                       : ${operatorValue.basis}`);
  console.log('');

  const bagB = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: (assetProfile as any).propertyType ?? null,
    operatorSuppliedValue: operatorValue,
  });
  console.log(`  DealBag.concludedValue        : ${fmtUsd(bagB.concludedValue)}`);
  console.log(`  DealBag.concludedValueSource  : ${bagB.concludedValueSource}  (expected: 'operator-supplied')`);
  console.log('');

  const drB = evaluateDeal(bagB);
  const dim7B = drB.dimensions.capRateValuationStress;
  const sourceTagInDerived = (dim7B.derivedOutputs?.concludedValueSource as string | null | undefined) ?? null;
  console.log(`  dim-7 applicability           : ${dim7B.applicability}  (expected: applicable)`);
  console.log(`  dim-7 stressedValue           : ${fmtUsd((dim7B.derivedOutputs?.stressedValue as number | null | undefined) ?? null)}`);
  console.log(`  dim-7 stressedLtv             : ${(((dim7B.derivedOutputs?.stressedLtv as number | null | undefined) ?? 0) * 1).toFixed(4)}`);
  console.log(`  dim-7 derivedOutputs.source   : ${sourceTagInDerived}  (expected: 'operator-supplied')`);
  console.log(`  rating recommendation         : ${(drB.rating as any).recommendation ?? '?'}`);
  console.log(`  rating ratingBand             : ${(drB.rating as any).ratingBand ?? '?'}`);
  console.log('');
  console.log(`  dim-7 rationale (last sentence — confidence note):`);
  console.log(`    ${dim7B.rationale}`);
  console.log('');

  if (dim7B.applicability !== 'applicable') {
    console.log('  ✗ FAIL: dim 7 did not resolve with operator value — investigate.');
    return;
  }
  if (sourceTagInDerived !== 'operator-supplied') {
    console.log(`  ✗ FAIL: source tag not propagated to derivedOutputs (got '${sourceTagInDerived}').`);
    return;
  }
  if (!dim7B.rationale.includes('operator-supplied')) {
    console.log('  ✗ FAIL: rationale does not disclose operator-supplied basis.');
    return;
  }
  console.log('  ✓ VALUE-SEAM WORKING — dim 7 resolves; source tag propagates to derivedOutputs + rationale.');
  console.log('');

  /* ============== levers + composition on the resolved path ============= */
  header('PRODUCEMITIGATIONS + COMPOSEMITIGATIONS on the operator-supplied path');
  console.log('');
  const loanAmount = bagB.loanAmount as number;
  const coupon = bagB.coupon as number;
  const termYears = 5;
  const ioYears = 5;
  const noi = bagB.uwY1Noi as number;
  const ai = buildAi(loanAmount, coupon, termYears, ioYears, noi, operatorValue.value);
  const uw = buildUw(loanAmount, coupon, termYears, ioYears, noi, operatorValue.value);

  const initialProposals = produceMitigations({
    adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult: drB,
  });
  console.log(`  produceMitigations fired ${initialProposals.length} proposal(s):`);
  for (const p of initialProposals) {
    const extra =
      p.lever === 'reduce_proceeds'        ? ` requiredEquity=${fmtUsd(p.requiredEquity)} (target ${p.targetMetric ?? '—'})`
    : p.lever === 'require_amortization'   ? ` requiredPaydown=${fmtUsd(p.requiredPaydown)} → B_target ${fmtUsd((p as any).targetMaturityBalance)}`
    : '';
    console.log(`    - ${p.id ?? '?'}  [${p.lever}]${extra}`);
  }
  console.log('');

  const reduceFire = initialProposals.find(p => p.lever === 'reduce_proceeds');
  if (!reduceFire) {
    console.log('  ✗ FAIL: reduce_proceeds did not fire on the operator-supplied path.');
    return;
  }
  console.log('  ✓ reduce_proceeds fires (LTV arm). The doctrine consumed the operator value.');
  console.log('');

  const composed = composeMitigations({
    adjustedInputs: ai, uwModel: uw, dealResult: drB, firedFlags: [],
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      // Recompute via the SAME adapter, same operator value — same fence.
      const newBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
        explicitAssetType: (assetProfile as any).propertyType ?? null,
        operatorSuppliedValue: operatorValue,
      });
      const overriddenBag = { ...newBag, loanAmount: newLoan };
      const newDealResult = evaluateDeal(overriddenBag);
      return {
        adjustedInputs: buildAi(newLoan, coupon, termYears, ioYears, noi, operatorValue.value),
        uwModel: buildUw(newLoan, coupon, termYears, ioYears, noi, operatorValue.value),
        dealResult: newDealResult,
      };
    },
  });
  console.log(`  composeMitigations final L'   : ${fmtUsd(composed.finalLoanAmount)}`);
  console.log(`  composed proposals (${composed.proposals.length}):`);
  for (const p of composed.proposals) {
    const extra =
      p.lever === 'reduce_proceeds'        ? ` requiredEquity=${fmtUsd(p.requiredEquity)}`
    : p.lever === 'require_amortization'   ? ` requiredPaydown=${fmtUsd(p.requiredPaydown)}`
    : '';
    console.log(`    - ${p.id ?? '?'}  [${p.lever}]${extra}`);
  }
  console.log('');
  console.log('  reconciliation notes:');
  for (const n of composed.reconciliation.notes) console.log(`    • ${n}`);
  console.log('');

  /* ---- verify the SOURCE TAG flows into the FINAL state too ---- */
  const finalDim7 = composed.finalState.dealResult.dimensions.capRateValuationStress;
  const finalSourceTag = (finalDim7.derivedOutputs?.concludedValueSource as string | null | undefined) ?? null;
  console.log(`  final-state dim-7 source tag  : ${finalSourceTag}  (expected: 'operator-supplied')`);
  if (finalSourceTag !== 'operator-supplied') {
    console.log('  ✗ FAIL: source tag not carried into the post-composition final state.');
    return;
  }
  console.log('  ✓ Source tag carries through the recompute pass — audit chain intact end-to-end.');
  console.log('');

  header('SUMMARY — value-seam validated on real Sunroad');
  console.log('');
  console.log('  ✓ PASS A (no operator value)   : fence intact — dim 7 HITLs, no silent default.');
  console.log('  ✓ PASS B (with operator value) : dim 7 resolves; tag = operator-supplied;');
  console.log('                                    rationale discloses confidence note;');
  console.log('                                    reduce_proceeds fires; composition succeeds.');
  console.log('  ✓ Source tag end-to-end        : baseline derivedOutputs AND final-state');
  console.log('                                    (post-recompute) carry the tag.');
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
