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
  buildCapexScheduleInflated,
  buildCapexScheduleUninflated,
  buildCapRate,
  buildConcessionsPct,
  buildDebtServiceAnnual,
  buildEffectiveGrossIncome,
  buildExpenseGrowthPct,
  buildGeneralAndAdmin,
  buildGrossRentalIncome,
  buildInsurance,
  buildInterestRate,
  buildIoPeriodMonths,
  buildJanitorial,
  buildLoanAmount,
  buildMaintenance,
  buildManagementFee,
  buildMaturityBalance,
  buildMonthlyCapex,
  buildMonthlyLeasingCommissions,
  buildMonthlyReplacementReserves,
  buildMonthlyTenantImprovements,
  buildOtherExpenses,
  buildOtherIncome,
  buildPayroll,
  buildPcaImmediateRepairs,
  buildRealEstateTaxes,
  buildReimbursements,
  buildRentGrowthPct,
  buildTermMonths,
  buildTerminalCapRate,
  buildTotalOperatingExpenses,
  buildUpfrontCapex,
  buildUpfrontReplacementReserves,
  buildUpfrontTiLc,
  buildUtilities,
  buildVacancyPct,
  deriveMonthlyTiLc,
} from './line-item-builders.js';

import { applyCapRateStress } from './apply-cap-rate-stress.js';

import {
  concessionsApplies,
  ioPeriodApplies,
  monthlyCapexApplies,
  payrollApplies,
  pcaImmediateRepairsApplies,
  upfrontCapexApplies,
  upfrontTiLcApplies,
} from './applicability.js';

import { evaluateManifestoRule } from './manifesto-evaluator.js';
import { applyNoiCap } from './noi-cap.js';
import { checkNoiDivergence } from './noi-divergence.js';
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
  // 2026-05-31 — JE_T12_MISSING renamed JE_TRAILING_ACTUALS_MISSING. The flag
  // now fires when extraction.t12Actual is null (strict trailing-twelve
  // column absent), which is the case for every deal whose source CF lacks a
  // separate T-12 column — most CMBS-style CFs today. Until the class-(b)
  // trailing-actuals ingest slot lands, this flag will fire on essentially
  // every deal. That's intentional: honest signal that the trailing-actual
  // truth-floor for NOI-recon is unavailable.
  if (extraction.t12Actual === null) ledger.push({ ruleId: 'JE_TRAILING_ACTUALS_MISSING' });
  // 2026-05-31 — new flag. Fires when the seller CF's In-Place / current
  // column is absent. Lighter penalty (8 vs 12) than trailing-actuals because
  // most CFs do carry an In-Place column; absence usually means CF document
  // was structurally broken or missing entirely.
  if (extraction.inPlace === null) ledger.push({ ruleId: 'JE_IN_PLACE_MISSING' });
  if (extraction.loanTerms === null) ledger.push({ ruleId: 'JE_LOAN_TERMS_MISSING' });
  if (extraction.pca === null) ledger.push({ ruleId: 'JE_PCA_MISSING' });
  if (extraction.appraisal === null) ledger.push({ ruleId: 'JE_APPRAISAL_MISSING' });
  return ledger;
}

/**
 * Safeguard 1 (period-label sanity). Emits JE_PERIOD_LABEL_MISMATCH (informational —
 * delta=0) when a slot's `period` label doesn't match the expected pattern for that
 * slot. This catches silent extractor misclassification: e.g., a workbook where the
 * column headers are not in the canonical order and the regex matched the wrong
 * label.
 *
 * Does NOT dock data_confidence (the orchestrator's flag handling keeps this rule
 * out of the missing-doc penalty path). Audit-only.
 */
function checkPeriodLabels(extraction: ExtractionResult): readonly AdjustmentEntry[] {
  const mismatches: AdjustmentEntry[] = [];
  if (
    extraction.t12Actual !== null &&
    extraction.t12Actual.period &&
    !/t.?12|trailing/i.test(extraction.t12Actual.period)
  ) {
    mismatches.push({
      ruleId: 'JE_PERIOD_LABEL_MISMATCH',
      delta: 0,
      reason: `t12Actual slot's period label "${extraction.t12Actual.period}" does not match T-12/trailing pattern; possible misclassification.`,
    });
  }
  if (
    extraction.inPlace !== null &&
    extraction.inPlace.period &&
    !/in.?place|current/i.test(extraction.inPlace.period)
  ) {
    mismatches.push({
      ruleId: 'JE_PERIOD_LABEL_MISMATCH',
      delta: 0,
      reason: `inPlace slot's period label "${extraction.inPlace.period}" does not match In-Place/current pattern; possible misclassification.`,
    });
  }
  if (
    extraction.sellerUwOperatingStatement !== null &&
    extraction.sellerUwOperatingStatement.period &&
    !/u\/?w|underwrit|gs|seller|issuer/i.test(extraction.sellerUwOperatingStatement.period)
  ) {
    mismatches.push({
      ruleId: 'JE_PERIOD_LABEL_MISMATCH',
      delta: 0,
      reason: `sellerUwOperatingStatement slot's period label "${extraction.sellerUwOperatingStatement.period}" does not match UW pattern; possible misclassification.`,
    });
  }
  return mismatches;
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
  const generalAndAdmin = buildGeneralAndAdmin({ extraction });
  const janitorial = buildJanitorial({ extraction });
  const reimbursements = buildReimbursements({ extraction });

  const loanAmount = buildLoanAmount({ extraction });
  const interestRate = buildInterestRate({ extraction, marketBenchmarks });
  const termMonths = buildTermMonths({ extraction, analysisAsOfDate });
  const amortizationMonths = buildAmortizationMonths({ extraction });
  const ioPeriodMonths = buildIoPeriodMonths({
    extraction,
    applicable: ioPeriodApplies(extraction),
  });

  // Cap-rate doctrine v1: capRate is built tier-blind here; the cap-stress step
  // (after tenancy metrics, below) applies tier correction + risk widen + clamp
  // and may rebind. buildTerminalCapRate is intentionally deferred until AFTER
  // the stress step so the spot+spread fallback path inherits the stressed cap.
  let capRate = buildCapRate({ extraction, librarySnapshot, marketBenchmarks, assetProfile });
  const rentGrowthPct = buildRentGrowthPct({ extraction });
  const expenseGrowthPct = buildExpenseGrowthPct({ extraction });

  const upfrontCapex = buildUpfrontCapex({
    extraction,
    applicable: upfrontCapexApplies(extraction),
  });
  const upfrontReplacementReserves = buildUpfrontReplacementReserves({ extraction });
  const tilcArgs = { profile: assetProfile, extraction, termMonths: termMonths.adjusted };
  const upfrontTiLc = buildUpfrontTiLc({ applicable: upfrontTiLcApplies(tilcArgs) });
  const monthlyReplacementReserves = buildMonthlyReplacementReserves({ extraction });
  const monthlyTenantImprovements = buildMonthlyTenantImprovements({ extraction });
  const monthlyLeasingCommissions = buildMonthlyLeasingCommissions({ extraction });
  const monthlyTiLc = deriveMonthlyTiLc(monthlyTenantImprovements, monthlyLeasingCommissions);
  const capexScheduleInflated = buildCapexScheduleInflated({ extraction });
  const capexScheduleUninflated = buildCapexScheduleUninflated({ extraction });
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

  /* --------------------- Cap-rate stress doctrine v1 ------------------------ */
  // Apply tier correction (on tier-blind bases — library/benchmark) + risk
  // widen (business plan, tenancy rollover, tenancy concentration), then
  // clamp into [4.5%, 12.0%] band. Office-only in v1; non-Office is a no-op.
  // Rebinds `capRate`; terminalCapRate now built downstream off the post-
  // stress cap so the spot+spread fallback inherits the stress.
  const capStressResult = applyCapRateStress({
    capRate,
    assetProfile,
    top1IncomeShare,
    pctIncomeExpiringWithinTerm,
  });
  capRate = capStressResult.capRate;
  const terminalCapRate = buildTerminalCapRate({
    extraction,
    librarySnapshot,
    assetProfile,
    capRate,
  });
  const capRateAdj = capRate.adjusted;

  /* ----------------------------- Phase 3: NOI Cap --------------------------- */

  const bankNoi = pickFirstNonNull(bankNoiCascade(extraction)).value;
  // Data-confidence axis (v1.6). Binary: 'unvalidated' iff the bankNoi cascade
  // (t12Actual → sellerUwOperatingStatement → inPlace) returned null — no
  // independent cashflow source extracted, NOI is unvalidatable. Showcase I
  // pattern. Pure derivation from a cascade we already computed; no extra work.
  // See packages/contracts/src/adjusted-inputs.ts for downstream policy notes.
  const dataConfidence = bankNoi === null ? 'unvalidated' : 'validated';
  const capResult = applyNoiCap({ derivedNoi: preCapNoi, bankNoi });
  const finalNoi = capResult.capped;
  const noiCapAdjustments: AdjustmentEntry[] = capResult.entry ? [capResult.entry] : [];

  // v1.8 NOI divergence detect. Compare finalNoi against t12Actual.noi (trailing-twelve
  // actual) ONLY — inPlace and sellerUw are seller projections that dilute the signal.
  // Fires when concluded is ≥ 20% below the trailing-12. Pushes a topLevelAdjustment here;
  // mirrored to dataQualityFlags in Phase 6.5 (same pattern as JE_PERIOD_LABEL_MISMATCH).
  // Threshold lives in noi-divergence.ts (not in the hashed snapshot — see file JSDoc).
  const divergence = checkNoiDivergence({
    derivedNoi: finalNoi,
    trailingActualNoi: extraction.t12Actual?.noi ?? null,
  });
  if (divergence !== null && divergence.flagged) {
    const ref = extraction.t12Actual!.noi!;
    noiCapAdjustments.push({
      ruleId: 'JE_NOI_BELOW_TRAILING_ACTUAL',
      delta: finalNoi - ref,
      reason: `concluded NOI ${Math.round(finalNoi).toLocaleString('en-US')} is ${(divergence.shortfallPct * 100).toFixed(1)}% below trailing-12 actual ${Math.round(ref).toLocaleString('en-US')}`,
    });
  }

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
      generalAndAdmin,
      janitorial,
      reimbursements,
      totalOperatingExpenses,
    },
    capitalReserves: {
      upfrontCapex,
      upfrontReplacementReserves,
      upfrontTiLc,
      monthlyCapex,
      monthlyTiLc,
      monthlyReplacementReserves,
      monthlyTenantImprovements,
      monthlyLeasingCommissions,
      pcaImmediateRepairs,
      capexScheduleInflated,
      capexScheduleUninflated,
    },
    loan: {
      loanAmount,
      interestRate,
      termMonths,
      amortizationMonths,
      ioPeriodMonths,
      maturityBalance: loanMaturityBalance,
      // §2.3-legitimate: Stage 4 is the ONLY pipeline stage allowed to read
      // ExtractionResult. We denormalize `maturityDate` onto AdjustedInputs.loan
      // here so the Stage 5+ handbook evaluator can compute the refinancing-window
      // rollover gate (refi-window.ts) without re-importing extraction. Null when
      // LoanTermsExtraction is absent or the source did not carry an explicit date.
      maturityDate: extraction.loanTerms?.maturityDate ?? null,
      debtServiceAnnual,
    },
    // concludedCapRate is analyst-input-only per §14.3 Decision 3 + Delta X
    // (handbook P-III-9 disallows deterministic threshold derivation); null
    // until set via revision-delta override.
    assumptions: { capRate, terminalCapRate, concludedCapRate: null, rentGrowthPct, expenseGrowthPct },
    metrics: {
      noi: finalNoi,
      value,
      dscr,
      ltvAppraisal,
      debtYield,
      expenseRatio,
      top1IncomeShare,
      pctIncomeExpiringWithinTerm,
      // §2.3-legitimate: Stage 4 is the ONLY pipeline stage allowed to read
      // ExtractionResult. We denormalize trailing-actual NOI + the four
      // cross-reference NOI values onto AdjustedInputs.metrics here so the
      // Stage 5 handbook evaluator can build the noiReconciliation
      // computedFacts entry without re-importing extraction.
      //
      // trailingActualNoi sources from t12Actual.noi (strict trailing-twelve)
      // — null today for every deal until the class-(b) ingest slot lands.
      // The load-bearing input to the NOI-recon trigger (P-III-15).
      //
      // issuerCfUwNoi sources from the seller CF's GS U/W column. inPlaceNoi
      // sources from the seller CF's In-Place column. issuerStatedNoiSellerUw
      // and issuerStatedNoiAsr source from the separate narrative SellerUW
      // and ASR documents. ALL FOUR are cross-reference values — context for
      // the LLM-context evaluator's flag_message prose; none is load-bearing
      // for the NOI-recon verdict (which compares system UW NOI against
      // trailingActualNoi).
      trailingActualNoi: extraction.t12Actual?.noi ?? null,
      issuerCfUwNoi: extraction.sellerUwOperatingStatement?.noi ?? null,
      inPlaceNoi: extraction.inPlace?.noi ?? null,
      issuerStatedNoiSellerUw: extraction.sellerUw?.underwrittenNOI ?? null,
      issuerStatedNoiAsr: extraction.asr?.underwrittenNOI ?? null,
    },
    dataConfidence,
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

  // Cap-rate stress doctrine v1: informational flag fired when the absolute
  // sum of stress deltas (tier + risk widen, pre-clamp) exceeds 150bps.
  // Delta=0; no value change — surfaces in the audit only.
  if (capStressResult.netBandOutOfRange) {
    dataQualityFlags.push('JE_CAP_NET_ADJ_OUT_OF_BAND');
  }
  // v1.5 degraded-state flag — Office deal with no resolved market tier
  // (neither explicit hint nor metro lookup matched). Doctrine's
  // data_confidence component reads this so a no-tier-signal deal scores
  // honestly rather than silently riding the tier-blind library median.
  if (capStressResult.tierUnresolved) {
    dataQualityFlags.push('JE_CAP_TIER_UNRESOLVED');
  }

  /* ----------- Phase 6.5: Degraded-state flag emission (Batch 6.2) --------- */
  //
  // Surface conditions that previously collapsed silently into green bands. Each flag fires
  // when the new-spine path encounters missing data that prevents a producer from enforcing
  // a conservatism floor or running an applicable rule. Doctrine's data_confidence component
  // reads these flags and downgrades the score accordingly.

  // Audit U12 + NR4 — expense-ratio + vacancy floor data availability for the conservatism gate.
  //
  // Class-(a) bank-slot pick (locked 2026-05-31): prefer sellerUwOperatingStatement
  // (the GS U/W column carries the issuer's normalized totalIncome and
  // totalOperatingExpenses), fall back to inPlace. Previous code read
  // extraction.t12 which actually held In-Place data after the regex-collision
  // bug; the new cascade is explicit and correct.
  const libVacancyMedian = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'vacancy');
  const bankVacancySource = pickFirstNonNull(vacancyPctCascade(extraction)).value;
  const libExpenseRatio = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'expenseRatio');
  const bankSlot =
    extraction.sellerUwOperatingStatement ??
    extraction.inPlace ??
    null;
  const bankExpenseRatioComputable =
    !!bankSlot
      && bankSlot.income.totalIncome !== null
      && bankSlot.expenses.totalOperatingExpenses !== null
      && bankSlot.income.totalIncome > 0;

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

  // Safeguard 1 (period-label sanity, 2026-05-31). Informational emission —
  // delta=0; flags any slot whose `period` text doesn't match the expected
  // pattern for that slot. Surfaces possible extractor misclassification
  // (e.g., a workbook header layout the regex chose wrong). Pushed to
  // topLevelAdjustments AND mirrored to dataQualityFlags (so doctrine sees
  // the surface), but the rule is deliberately excluded from data_confidence
  // weighting in the doctrine components (rule registry knows it).
  const periodMismatches = checkPeriodLabels(extraction);
  if (periodMismatches.length > 0) {
    dataQualityFlags.push('JE_PERIOD_LABEL_MISMATCH');
  }

  // v1.8 NOI divergence — mirror the rule id into dataQualityFlags so doctrine + narrative
  // see the flag. The actual topLevelAdjustment with delta + reason was emitted in Phase 3
  // (above L405); this is the dataQualityFlags side of the same fire.
  if (divergence !== null && divergence.flagged) {
    dataQualityFlags.push('JE_NOI_BELOW_TRAILING_ACTUAL');
  }

  /* --------------------------- Phase 7: Final Assembly ---------------------- */

  const allTopLevelAdjustments = [...noiCapAdjustments, ...manifestoEntries, ...periodMismatches];

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
    dataConfidence,
    confidenceReduction,
    topLevelAdjustments: allTopLevelAdjustments,
    dataQualityFlags,
  };
  return { id: computeAdjustedInputsId(body), ...body } as AdjustedInputs;
}
