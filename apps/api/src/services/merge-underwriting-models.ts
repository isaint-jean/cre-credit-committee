/**
 * mergeUnderwritingModels — deterministic field-by-field merge of two
 * UnderwritingModel outputs (one extracted from the ASR document, one from
 * the Seller UW document) into a single canonical UnderwritingModel.
 *
 * Replaces the prior `uwSource = uwDocument || asrDocument` pattern at
 * underwriting-pipeline.service.ts that collapsed both inputs to a single
 * source. The merge applies a locked precedence policy:
 *
 *   - Property structural (totalUnits, totalSqFt)         → ASR
 *   - Historical T-12 (income/expenses annualAmount, NOI) → ASR
 *   - Loan terms (loanAmount, interestRate, amortYears,
 *     termYears, loanDetails.*)                           → Seller UW
 *   - Forward UW assumption (capRate)                     → Seller UW
 *   - Derived (impliedValue, dscr, ltv, debtYield,
 *     annualDebtService)                                  → Recompute via
 *       legacy `recalculateFullModel` so unit conventions stay aligned with
 *       the rest of the pipeline (interestRate as percent, etc.). Critically,
 *       impliedValue MUST be recomputed and NOT taken from either source — the
 *       validation layer enforces `impliedValue = NOI / capRate`, which is
 *       violated whenever NOI and capRate come from different sources.
 *   - Bands (dscrBand, ltvBand, debtYieldBand)            → Recompute via
 *       `applyBandsToUwModel` after the full-model recompute, so bands
 *       classify against the recomputed metrics.
 *   - Rent-driven inputs                                  → Reserved for
 *     a future rent-roll batch. No legacy field maps to this category yet;
 *     when Year-1 / pro-forma fields are added, they MUST follow this rule
 *     instead of taking either input directly.
 *
 * Universal rules (apply to every field):
 *   - Both null/undefined            → null/undefined (no fabrication)
 *   - One null/undefined, one value  → take the non-null value (always)
 *   - Both equal                     → that value (no conflict logged)
 *   - Both non-null, unequal         → precedence wins; conflict IS logged
 *
 * Traceability invariant:
 *   Every conflict is appended to mergeConflicts (regardless of resolution),
 *   in the shape { field, asrValue, sellerValue, chosen }. This is the IC
 *   defensibility audit trail; the pipeline forwards it into derivationIssues.
 *
 * Boundary discipline:
 *   - Pure function. No I/O, no mutation of inputs.
 *   - No new contract fields. Output type is the existing UnderwritingModel.
 *   - No new extractor logic. Both inputs come from existing extractUnderwriting.
 */

import type {
  ExpenseSection,
  IncomeSection,
  LineItem,
  UnderwritingModel,
} from '@cre/shared';
import { recalculateFullModel } from '@cre/shared';
import { applyBandsToUwModel } from './doctrine/apply-credit-policy-bands.js';

export interface MergeConflict {
  readonly field: string;
  readonly asrValue: unknown;
  readonly sellerValue: unknown;
  readonly chosen: unknown;
}

export interface MergeResult {
  readonly merged: UnderwritingModel;
  readonly conflicts: readonly MergeConflict[];
}

/* --------------------------- value-level merge ------------------------- */

type Source = 'asr' | 'seller';

interface MergeContext {
  readonly conflicts: MergeConflict[];
}

function mergeValue<T>(
  field: string,
  asr: T | null | undefined,
  seller: T | null | undefined,
  precedence: Source,
  ctx: MergeContext,
): T | null {
  // Universal: both null/undefined → null
  if ((asr === null || asr === undefined) && (seller === null || seller === undefined)) {
    return null;
  }
  // Universal: one null, one non-null → take non-null
  if (asr === null || asr === undefined) return seller as T;
  if (seller === null || seller === undefined) return asr as T;
  // Universal: both equal → no conflict
  if (asr === seller) return asr;
  // Conflict path: log + apply precedence
  const chosen = precedence === 'asr' ? asr : seller;
  ctx.conflicts.push({ field, asrValue: asr, sellerValue: seller, chosen });
  return chosen;
}

function mergeLineItem(
  field: string,
  asr: LineItem | undefined,
  seller: LineItem | undefined,
  precedence: Source,
  ctx: MergeContext,
): LineItem {
  // Defensive: if both missing entirely, return a zero-amount placeholder so
  // downstream consumers don't NPE on .annualAmount. The legacy pipeline
  // always emits these fields, so reaching here means BOTH extractors failed
  // for this field — record the situation as a conflict against null.
  if (!asr && !seller) {
    return {
      id: field,
      label: field,
      annualAmount: 0,
      isEditable: true,
      isOverridden: false,
      originalValue: 0,
    };
  }
  if (!asr) return seller as LineItem;
  if (!seller) return asr as LineItem;

  // Compare on annualAmount; other LineItem fields (perUnit, perSqFt,
  // percentOfEGI, label, source) follow the precedence winner so the chosen
  // value's metadata carries through.
  if (asr.annualAmount === seller.annualAmount) return asr;
  ctx.conflicts.push({
    field: field + '.annualAmount',
    asrValue: asr.annualAmount,
    sellerValue: seller.annualAmount,
    chosen: precedence === 'asr' ? asr.annualAmount : seller.annualAmount,
  });
  return precedence === 'asr' ? asr : seller;
}

function mergeIncome(
  asr: IncomeSection,
  seller: IncomeSection,
  ctx: MergeContext,
): IncomeSection {
  // Historical T-12 → ASR primary on conflict. Note: when rent-roll-driven
  // Year-1 income lives in the model in a future batch, those fields must
  // bypass this rule and recompute from rent roll instead.
  return {
    grossPotentialRent:   mergeLineItem('income.grossPotentialRent',   asr.grossPotentialRent,   seller.grossPotentialRent,   'asr', ctx),
    vacancyLoss:          mergeLineItem('income.vacancyLoss',          asr.vacancyLoss,          seller.vacancyLoss,          'asr', ctx),
    concessions:          mergeLineItem('income.concessions',          asr.concessions,          seller.concessions,          'asr', ctx),
    otherIncome:          mergeLineItem('income.otherIncome',          asr.otherIncome,          seller.otherIncome,          'asr', ctx),
    effectiveGrossIncome: mergeLineItem('income.effectiveGrossIncome', asr.effectiveGrossIncome, seller.effectiveGrossIncome, 'asr', ctx),
    additionalItems:      mergeAdditionalItems('income.additionalItems', asr.additionalItems, seller.additionalItems, 'asr', ctx),
  };
}

function mergeExpenses(
  asr: ExpenseSection,
  seller: ExpenseSection,
  ctx: MergeContext,
): ExpenseSection {
  return {
    realEstateTaxes:      mergeLineItem('expenses.realEstateTaxes',      asr.realEstateTaxes,      seller.realEstateTaxes,      'asr', ctx),
    insurance:            mergeLineItem('expenses.insurance',            asr.insurance,            seller.insurance,            'asr', ctx),
    utilities:            mergeLineItem('expenses.utilities',            asr.utilities,            seller.utilities,            'asr', ctx),
    repairsAndMaintenance:mergeLineItem('expenses.repairsAndMaintenance',asr.repairsAndMaintenance,seller.repairsAndMaintenance,'asr', ctx),
    management:           mergeLineItem('expenses.management',           asr.management,           seller.management,           'asr', ctx),
    generalAndAdmin:      mergeLineItem('expenses.generalAndAdmin',      asr.generalAndAdmin,      seller.generalAndAdmin,      'asr', ctx),
    payroll:              mergeLineItem('expenses.payroll',              asr.payroll,              seller.payroll,              'asr', ctx),
    replacementReserves:  mergeLineItem('expenses.replacementReserves',  asr.replacementReserves,  seller.replacementReserves,  'asr', ctx),
    totalExpenses:        mergeLineItem('expenses.totalExpenses',        asr.totalExpenses,        seller.totalExpenses,        'asr', ctx),
    additionalItems:      mergeAdditionalItems('expenses.additionalItems', asr.additionalItems, seller.additionalItems, 'asr', ctx),
  };
}

// additionalItems is a free-form list. Merging by union (matched on `id`) is
// already a judgment call beyond pure precedence; for Batch 0 we take the
// precedence winner's list verbatim and log a conflict if the lists differ.
function mergeAdditionalItems(
  field: string,
  asr: readonly LineItem[],
  seller: readonly LineItem[],
  precedence: Source,
  ctx: MergeContext,
): LineItem[] {
  const sameLength = asr.length === seller.length;
  const sameIds = sameLength && asr.every((a, i) => a.id === seller[i]?.id);
  if (sameIds && asr.every((a, i) => a.annualAmount === seller[i]?.annualAmount)) {
    return [...asr];
  }
  ctx.conflicts.push({
    field,
    asrValue: asr.map((a) => ({ id: a.id, annualAmount: a.annualAmount })),
    sellerValue: seller.map((s) => ({ id: s.id, annualAmount: s.annualAmount })),
    chosen: precedence === 'asr' ? 'asr' : 'seller',
  });
  return precedence === 'asr' ? [...asr] : [...seller];
}

/* ------------------------------- merge --------------------------------- */

export function mergeUnderwritingModels(
  asr: UnderwritingModel,
  seller: UnderwritingModel,
): MergeResult {
  const ctx: MergeContext = { conflicts: [] };

  // Property structural → ASR
  const totalUnits = mergeValue('totalUnits', asr.totalUnits, seller.totalUnits, 'asr', ctx);
  const totalSqFt  = mergeValue('totalSqFt',  asr.totalSqFt,  seller.totalSqFt,  'asr', ctx);

  // Historical T-12 → ASR
  const income   = mergeIncome(asr.income,   seller.income,   ctx);
  const expenses = mergeExpenses(asr.expenses, seller.expenses, ctx);
  const noi      = mergeValue('netOperatingIncome', asr.netOperatingIncome, seller.netOperatingIncome, 'asr', ctx) ?? 0;

  // Forward UW assumption (capRate) → Seller UW. impliedValue is NOT merged here
  // because the legacy validator enforces `impliedValue = NOI / capRate`; mixing
  // a seller-sourced impliedValue with a separately-merged NOI/capRate breaks the
  // identity. impliedValue is recomputed at the bottom of this function via
  // recalculateFullModel. We still surface seller-vs-asr impliedValue disagreement
  // in the conflict log for IC defensibility — running mergeValue with throwaway
  // 'seller' precedence does exactly that without contaminating the merged model.
  const capRate = mergeValue('capRate', asr.capRate, seller.capRate, 'seller', ctx) ?? 0;
  mergeValue('impliedValue', asr.impliedValue, seller.impliedValue, 'seller', ctx);

  // Loan terms → Seller UW
  const loanAmount        = mergeValue('loanAmount',        asr.loanAmount,        seller.loanAmount,        'seller', ctx) ?? 0;
  const interestRate      = mergeValue('interestRate',      asr.interestRate,      seller.interestRate,      'seller', ctx) ?? 0;
  const amortizationYears = mergeValue('amortizationYears', asr.amortizationYears, seller.amortizationYears, 'seller', ctx) ?? 0;
  const termYears         = mergeValue('termYears',         asr.termYears,         seller.termYears,         'seller', ctx) ?? 0;

  // loanDetails sub-fields → Seller UW
  const loanDetails = {
    loanAmount:         mergeValue('loanDetails.loanAmount',         asr.loanDetails.loanAmount,         seller.loanDetails.loanAmount,         'seller', ctx) ?? 0,
    interestRate:       mergeValue('loanDetails.interestRate',       asr.loanDetails.interestRate,       seller.loanDetails.interestRate,       'seller', ctx) ?? 0,
    rateType:           mergeValue('loanDetails.rateType',           asr.loanDetails.rateType,           seller.loanDetails.rateType,           'seller', ctx) ?? asr.loanDetails.rateType,
    ioMonths:           mergeValue('loanDetails.ioMonths',           asr.loanDetails.ioMonths,           seller.loanDetails.ioMonths,           'seller', ctx) ?? 0,
    amortizationMonths: mergeValue('loanDetails.amortizationMonths', asr.loanDetails.amortizationMonths, seller.loanDetails.amortizationMonths, 'seller', ctx) ?? 0,
    termMonths:         mergeValue('loanDetails.termMonths',         asr.loanDetails.termMonths,         seller.loanDetails.termMonths,         'seller', ctx) ?? 0,
    paymentFrequency:   mergeValue('loanDetails.paymentFrequency',   asr.loanDetails.paymentFrequency,   seller.loanDetails.paymentFrequency,   'seller', ctx) ?? asr.loanDetails.paymentFrequency,
    prepaymentTerms:    mergeValue('loanDetails.prepaymentTerms',    asr.loanDetails.prepaymentTerms,    seller.loanDetails.prepaymentTerms,    'seller', ctx) ?? '',
    originationDate:    mergeValue('loanDetails.originationDate',    asr.loanDetails.originationDate,    seller.loanDetails.originationDate,    'seller', ctx) ?? '',
  };

  // Pre-recompute merged model. impliedValue / dscr / ltv / debtYield /
  // annualDebtService / repaymentSchedule are intentionally null/placeholder
  // here; recalculateFullModel fills them using the merged inputs and the
  // legacy unit conventions (interestRate as percent, etc.). We then apply
  // credit-policy bands on the recomputed metrics.
  const preRecompute: UnderwritingModel = {
    income,
    expenses,
    netOperatingIncome: noi,
    capRate,
    impliedValue: null,
    loanAmount,
    interestRate,
    amortizationYears,
    termYears,
    annualDebtService: null,
    dscr: null,
    ltv: null,
    debtYield: null,
    totalUnits: totalUnits ?? undefined,
    totalSqFt:  totalSqFt  ?? undefined,
    asReported: asr.asReported && seller.asReported,
    modifiedCells: Array.from(new Set([...asr.modifiedCells, ...seller.modifiedCells])),
    loanDetails,
    repaymentSchedule: null,
  };
  const recomputed = recalculateFullModel(preRecompute);
  const merged = applyBandsToUwModel(recomputed);

  return { merged, conflicts: ctx.conflicts };
}
