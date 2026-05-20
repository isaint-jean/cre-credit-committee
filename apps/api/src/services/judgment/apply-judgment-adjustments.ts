/**
 * Stage 4 orchestrator — `applyJudgmentAdjustments`.
 *
 * Pipeline (per Batch 3c2b spec):
 *   Phase 1 — Line Item Construction         (29 builders, Tier 1 then Tier 2)
 *   Phase 2 — Pre-cap Metrics                (NOI, value, DSCR, debt yield, etc.)
 *   Phase 3 — NOI Cap                        (apply JE_NOI_CAPPED_TO_BANK; re-derive metrics)
 *   Phase 4 — Conservatism Gate              (verifyConservatism; may throw)
 *   Phase 5 — Manifesto Evaluation           (observational; emits AdjustmentEntries with delta=0)
 *   Phase 6 — Confidence Reduction           (sum missing-doc + distrust penalties)
 *   Phase 7 — Final Assembly                 (content-hash id; freeze; return)
 *
 * Architecture rules enforced at orchestration:
 *   - No in-place mutation across phases. Each phase produces a fresh snapshot.
 *   - No re-ordering. Conservatism runs AFTER NOI cap, BEFORE manifesto.
 *   - `null` and `0` are distinct (architecture §8). Builders enforce; orchestrator preserves.
 *   - Pre-condition violations throw `JudgmentEngineError`; conservatism violations throw
 *     `ConservatismViolation`.
 *   - The orchestrator does NOT persist. Caller writes the returned record to
 *     `recordGraphStore.insertAdjustedInputs` (audit §D.4).
 */

import type {
  AdjustedInputs,
  AdjustmentEntry,
  AssetProfile,
  CreditManifesto,
  ExtractionResult,
  ISODateTime,
  JudgmentEngineRuleId,
  LibrarySnapshot,
  LibrarySnapshotId,
  MarketBenchmarks,
} from '@cre/contracts';
import { JUDGMENT_ENGINE_VERSION } from '@cre/contracts';
import { computeAdjustedInputsId } from '../../util/content-hash.js';

import {
  buildAmortizationMonths,
  buildCapRate,
  buildConcessionsPct,
  buildDebtServiceAnnual,
  buildEffectiveGrossIncome,
  buildExpenseGrowthPct,
  buildGrossRentalIncome,
  buildInsurance,
  buildInterestRate,
  buildIoPeriodMonths,
  buildLoanAmount,
  buildMaintenance,
  buildManagementFee,
  buildMaturityBalance,
  buildMonthlyCapex,
  buildMonthlyTiLc,
  buildOtherExpenses,
  buildOtherIncome,
  buildPayroll,
  buildPcaImmediateRepairs,
  buildRealEstateTaxes,
  buildRentGrowthPct,
  buildTermMonths,
  buildTerminalCapRate,
  buildTotalOperatingExpenses,
  buildUpfrontCapex,
  buildUpfrontTiLc,
  buildUtilities,
  buildVacancyPct,
} from './line-item-builders.js';

import {
  concessionsApplies,
  ioPeriodApplies,
  monthlyCapexApplies,
  monthlyTiLcApplies,
  payrollApplies,
  pcaImmediateRepairsApplies,
  upfrontCapexApplies,
  upfrontTiLcApplies,
} from './applicability.js';

import { evaluateManifestoRule } from './manifesto-evaluator.js';
import { applyNoiCap } from './noi-cap.js';
import {
  computeConfidenceReduction,
  type PenaltyEntry,
} from './confidence-reduction.js';
import {
  bankNoiCascade,
  pickFirstNonNull,
  vacancyPctCascade,
} from './source-cascade.js';
import { getLibraryMedian } from './library-lookup.js';
import { verifyConservatism } from './verify-conservatism.js';
import { JudgmentEngineError } from './errors.js';

export interface ApplyJudgmentAdjustmentsArgs {
  readonly extraction: ExtractionResult;
  readonly assetProfile: AssetProfile;
  readonly librarySnapshot: LibrarySnapshot;
  readonly manifesto: CreditManifesto;
  readonly marketBenchmarks: MarketBenchmarks;
  readonly analysisAsOfDate: ISODateTime;
}

/* ------------------------------- pre-conditions ----------------------------- */

function checkPreconditions(args: ApplyJudgmentAdjustmentsArgs): void {
  if (args.extraction.analysisAsOfDate !== args.analysisAsOfDate) {
    throw new JudgmentEngineError({
      code: 'ANALYSIS_AS_OF_MISMATCH',
      context: {
        source: 'extraction',
        expected: args.analysisAsOfDate,
        actual: args.extraction.analysisAsOfDate,
      },
    });
  }
  if (args.manifesto.analysisAsOfDate !== args.analysisAsOfDate) {
    throw new JudgmentEngineError({
      code: 'ANALYSIS_AS_OF_MISMATCH',
      context: {
        source: 'manifesto',
        expected: args.analysisAsOfDate,
        actual: args.manifesto.analysisAsOfDate,
      },
    });
  }
}

/* ------------------------------ helpers (Stage 6) --------------------------- */

function computeTop1IncomeShare(extraction: ExtractionResult, gri: number): number | null {
  if (extraction.rentRoll === null || gri <= 0) return null;
  // Batch 6.2.1 (audit U18): if ANY unit has null inPlaceRentMonthly, the top-1 share cannot
  // be computed reliably — a single missing-rent row on the largest tenant fully breaks this
  // metric. Skip-with-flag (orchestrator emits JE_RENT_ROLL_UNIT_INCOMPLETE separately) rather
  // than silently zeroing the missing row's contribution.
  const hasIncompleteUnit = extraction.rentRoll.units.some(u => u.inPlaceRentMonthly === null);
  if (hasIncompleteUnit) return null;
  const annual = extraction.rentRoll.units.map(u => (u.inPlaceRentMonthly as number) * 12);
  if (annual.length === 0) return null;
  const max = Math.max(...annual);
  return max > 0 ? max / gri : null;
}

/**
 * True if any rent-roll unit has a null `inPlaceRentMonthly` or null `concessions`.
 * The orchestrator emits JE_RENT_ROLL_UNIT_INCOMPLETE when this returns true.
 */
function hasIncompleteRentRollUnit(extraction: ExtractionResult): boolean {
  if (extraction.rentRoll === null) return false;
  return extraction.rentRoll.units.some(
    u => u.inPlaceRentMonthly === null || u.concessions === null,
  );
}

function computePctIncomeExpiringWithinTerm(
  extraction: ExtractionResult,
  termMonths: number,
): number | null {
  if (extraction.rentRoll === null) return null;
  const now = Date.parse(extraction.analysisAsOfDate);
  if (!Number.isFinite(now)) return null;
  const cutoff = now + termMonths * 30.4375 * 24 * 60 * 60 * 1000;

  let totalAnnual = 0;
  let expiringAnnual = 0;
  for (const u of extraction.rentRoll.units) {
    if (u.inPlaceRentMonthly === null) continue;
    const annual = u.inPlaceRentMonthly * 12;
    totalAnnual += annual;
    if (u.leaseEnd === null) continue;
    const end = Date.parse(u.leaseEnd);
    if (Number.isFinite(end) && end <= cutoff) {
      expiringAnnual += annual;
    }
  }
  return totalAnnual > 0 ? expiringAnnual / totalAnnual : null;
}

function buildMissingDocLedger(extraction: ExtractionResult): readonly PenaltyEntry[] {
  const ledger: { ruleId: JudgmentEngineRuleId }[] = [];
  if (extraction.rentRoll === null) ledger.push({ ruleId: 'JE_RENT_ROLL_MISSING' });
  if (extraction.t12 === null) ledger.push({ ruleId: 'JE_T12_MISSING' });
  if (extraction.loanTerms === null) ledger.push({ ruleId: 'JE_LOAN_TERMS_MISSING' });
  if (extraction.pca === null) ledger.push({ ruleId: 'JE_PCA_MISSING' });
  if (extraction.appraisal === null) ledger.push({ ruleId: 'JE_APPRAISAL_MISSING' });
  return ledger;
}

/* ------------------------------- orchestrator ------------------------------- */

export function applyJudgmentAdjustments(args: ApplyJudgmentAdjustmentsArgs): AdjustedInputs {
  // Pre-conditions
  checkPreconditions(args);

  const { extraction, assetProfile, librarySnapshot, marketBenchmarks, manifesto, analysisAsOfDate } = args;

  /* --------------------------- Phase 1: Line Items -------------------------- */

  // Tier 1 — pure source builders (no inter-line-item dependencies)
  const grossRentalIncome = buildGrossRentalIncome({ extraction });
  const otherIncome = buildOtherIncome({ extraction });
  const vacancyPct = buildVacancyPct({ extraction, librarySnapshot, marketBenchmarks, assetProfile });
  const concessionsPct = buildConcessionsPct({
    extraction,
    applicable: concessionsApplies(assetProfile),
  });

  const realEstateTaxes = buildRealEstateTaxes({ extraction });
  const insurance = buildInsurance({ extraction });
  const utilities = buildUtilities({ extraction });
  const managementFee = buildManagementFee({ extraction });
  const maintenance = buildMaintenance({ extraction });
  const otherExp = buildOtherExpenses({ extraction });
  const payroll = buildPayroll({ extraction, applicable: payrollApplies(assetProfile) });

  const loanAmount = buildLoanAmount({ extraction });
  const interestRate = buildInterestRate({ extraction, marketBenchmarks });
  const termMonths = buildTermMonths({ extraction, analysisAsOfDate });
  const amortizationMonths = buildAmortizationMonths({ extraction });
  const ioPeriodMonths = buildIoPeriodMonths({
    extraction,
    applicable: ioPeriodApplies(extraction),
  });

  const capRate = buildCapRate({ extraction, librarySnapshot, marketBenchmarks, assetProfile });
  const terminalCapRate = buildTerminalCapRate({ extraction, librarySnapshot, assetProfile, capRate });
  const rentGrowthPct = buildRentGrowthPct({ extraction });
  const expenseGrowthPct = buildExpenseGrowthPct({ extraction });

  const upfrontCapex = buildUpfrontCapex({
    extraction,
    applicable: upfrontCapexApplies(extraction),
  });
  const tilcArgs = { profile: assetProfile, extraction, termMonths: termMonths.adjusted };
  const upfrontTiLc = buildUpfrontTiLc({ applicable: upfrontTiLcApplies(tilcArgs) });
  const monthlyTiLc = buildMonthlyTiLc({ applicable: monthlyTiLcApplies(tilcArgs) });
  const pcaImmediateRepairs = buildPcaImmediateRepairs({
    extraction,
    applicable: pcaImmediateRepairsApplies(extraction),
  });

  // Tier 2 — derived (depend on Tier 1 outputs)
  const effectiveGrossIncome = buildEffectiveGrossIncome({
    extraction,
    grossRentalIncome,
    otherIncome,
    vacancyPct,
    concessionsPct,
  });

  const totalOperatingExpenses = buildTotalOperatingExpenses({
    extraction,
    librarySnapshot,
    assetProfile,
    effectiveGrossIncome,
  });

  const debtServiceAnnual = buildDebtServiceAnnual({ loanAmount, interestRate, amortizationMonths });
  const loanMaturityBalance = buildMaturityBalance({
    loanAmount,
    interestRate,
    amortizationMonths,
    termMonths,
  });

  const monthlyCapex = buildMonthlyCapex({
    applicable: monthlyCapexApplies(termMonths.adjusted),
    effectiveGrossIncome,
  });

  /* --------------------------- Phase 2: Pre-cap Metrics --------------------- */

  const preCapNoi = effectiveGrossIncome.adjusted - totalOperatingExpenses.adjusted;

  const capRateAdj = capRate.adjusted;
  const dsAdj = debtServiceAnnual.adjusted;
  const loanAdj = loanAmount.adjusted;
  const egiAdj = effectiveGrossIncome.adjusted;

  const expenseRatio = egiAdj > 0 ? totalOperatingExpenses.adjusted / egiAdj : null;
  const appraisalValue = extraction.appraisal?.valueConclusion ?? null;
  const ltvAppraisal =
    appraisalValue !== null && appraisalValue > 0 ? loanAdj / appraisalValue : null;
  const top1IncomeShare = computeTop1IncomeShare(extraction, grossRentalIncome.adjusted);
  const pctIncomeExpiringWithinTerm = computePctIncomeExpiringWithinTerm(
    extraction,
    termMonths.adjusted,
  );

  /* ----------------------------- Phase 3: NOI Cap --------------------------- */

  const bankNoi = pickFirstNonNull(bankNoiCascade(extraction)).value;
  const capResult = applyNoiCap({ derivedNoi: preCapNoi, bankNoi });
  const finalNoi = capResult.capped;
  const noiCapAdjustments: AdjustmentEntry[] = capResult.entry ? [capResult.entry] : [];

  // Re-derive NOI-dependent metrics after cap
  const value = capRateAdj > 0 ? finalNoi / capRateAdj : null;
  const dscr = dsAdj > 0 ? finalNoi / dsAdj : null;
  const debtYield = loanAdj > 0 ? finalNoi / loanAdj : null;

  /* ------------------- Build snapshot for conservatism gate ----------------- */

  const partialAdjusted = {
    analysisAsOfDate,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: librarySnapshot.id,
    income: {
      grossRentalIncome,
      otherIncome,
      vacancyPct,
      concessionsPct,
      effectiveGrossIncome,
    },
    expenses: {
      realEstateTaxes,
      insurance,
      utilities,
      managementFee,
      payroll,
      maintenance,
      other: otherExp,
      totalOperatingExpenses,
    },
    capitalReserves: {
      upfrontCapex,
      upfrontTiLc,
      monthlyCapex,
      monthlyTiLc,
      pcaImmediateRepairs,
    },
    loan: {
      loanAmount,
      interestRate,
      termMonths,
      amortizationMonths,
      ioPeriodMonths,
      maturityBalance: loanMaturityBalance,
      debtServiceAnnual,
    },
    assumptions: { capRate, terminalCapRate, rentGrowthPct, expenseGrowthPct },
    metrics: {
      noi: finalNoi,
      value,
      dscr,
      ltvAppraisal,
      debtYield,
      expenseRatio,
      top1IncomeShare,
      pctIncomeExpiringWithinTerm,
    },
    confidenceReduction: 0, // placeholder; replaced in Phase 6
    topLevelAdjustments: noiCapAdjustments,
  };

  /* ----------------------- Phase 4: Conservatism Gate ----------------------- */

  // Synthesize an AdjustedInputs-shaped snapshot for the gate (id is irrelevant for the check
  // but required by the type; use a placeholder hash that matches what the gate reads).
  const gateSnapshot = {
    id: '0'.repeat(64),
    ...partialAdjusted,
  } as unknown as AdjustedInputs;

  verifyConservatism({
    adjustedInputs: gateSnapshot,
    extraction,
    librarySnapshot,
    assetProfile,
  });

  /* ----------------------- Phase 5: Manifesto Evaluation -------------------- */

  const manifestoEntries: AdjustmentEntry[] = [];
  for (const rule of manifesto.rules) {
    const result = evaluateManifestoRule({
      rule,
      adjusted: gateSnapshot,
      assetProfile,
    });
    if (result.fired && result.entry !== null) {
      manifestoEntries.push(result.entry);
    }
  }

  /* ----------------------- Phase 6: Confidence Reduction -------------------- */

  const missingDocLedger = buildMissingDocLedger(extraction);
  // v1.0: distrust ledger is empty — auto-cascade picks highest tier (audit B.5)
  const confidenceReduction = computeConfidenceReduction(missingDocLedger);
  const dataQualityFlags: JudgmentEngineRuleId[] = missingDocLedger.map(e => e.ruleId);

  /* ----------- Phase 6.5: Degraded-state flag emission (Batch 6.2) --------- */
  //
  // Surface conditions that previously collapsed silently into green bands. Each flag fires
  // when the new-spine path encounters missing data that prevents a producer from enforcing
  // a conservatism floor or running an applicable rule. Doctrine's data_confidence component
  // reads these flags and downgrades the score accordingly.

  // Audit U12 + NR4 — expense-ratio + vacancy floor data availability for the conservatism gate.
  const libVacancyMedian = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'vacancy');
  const bankVacancySource = pickFirstNonNull(vacancyPctCascade(extraction)).value;
  const libExpenseRatio = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'expenseRatio');
  const t12 = extraction.t12;
  const bankExpenseRatioComputable =
    !!t12 && t12.income.totalIncome !== null && t12.expenses.totalOperatingExpenses !== null
      && t12.income.totalIncome > 0;

  if (libExpenseRatio === null && !bankExpenseRatioComputable) {
    dataQualityFlags.push('JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE');
  }
  const vacancyFloorMissing = libVacancyMedian === null && bankVacancySource === null;
  const expenseFloorMissing = libExpenseRatio === null && !bankExpenseRatioComputable;
  if (vacancyFloorMissing || expenseFloorMissing) {
    dataQualityFlags.push('JE_CONSERVATISM_GATE_NO_FLOOR_DATA');
  }

  // Audit U15 — TI/LC applicability cannot be determined when rent roll or term months missing.
  // For tenant-driven asset classes (Office / Retail / Industrial), the legacy upfrontTiLcApplies
  // returns false in BOTH the "not applicable" case (non-tenant asset class) AND the
  // "insufficient data" case (tenant-driven but rent roll missing). Doctrine cannot distinguish.
  // Emit JE_TILC_APPLICABILITY_UNKNOWN when the asset class IS tenant-driven AND the data is
  // insufficient — surfacing the degraded state explicitly. The most credit-impactful finding
  // in Audit 6.
  const isTenantDriven =
    assetProfile.propertyType === 'Office' ||
    assetProfile.propertyType === 'Retail' ||
    assetProfile.propertyType === 'Industrial';
  const tilcDataInsufficient =
    isTenantDriven && (extraction.rentRoll === null || partialAdjusted.loan.termMonths.adjusted <= 0);
  if (tilcDataInsufficient) {
    dataQualityFlags.push('JE_TILC_APPLICABILITY_UNKNOWN');
  }

  // Audit U7 + U18 — rent-roll unit completeness. When any unit has null inPlaceRentMonthly
  // or null concessions, every rent-roll-derived metric (concessionsPct, top-1 income share,
  // tenant rollover, total in-place rent) is silently understated. Emit the flag so doctrine
  // sees the under-counting risk; producers separately skip the incomplete units rather than
  // contributing zeros.
  if (hasIncompleteRentRollUnit(extraction)) {
    dataQualityFlags.push('JE_RENT_ROLL_UNIT_INCOMPLETE');
  }

  /* --------------------------- Phase 7: Final Assembly ---------------------- */

  const allTopLevelAdjustments = [...noiCapAdjustments, ...manifestoEntries];

  const body = {
    analysisAsOfDate,
    judgmentEngineVersion: JUDGMENT_ENGINE_VERSION,
    librarySnapshotId: librarySnapshot.id satisfies LibrarySnapshotId,
    income: partialAdjusted.income,
    expenses: partialAdjusted.expenses,
    capitalReserves: partialAdjusted.capitalReserves,
    loan: partialAdjusted.loan,
    assumptions: partialAdjusted.assumptions,
    metrics: partialAdjusted.metrics,
    confidenceReduction,
    topLevelAdjustments: allTopLevelAdjustments,
    dataQualityFlags,
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}
