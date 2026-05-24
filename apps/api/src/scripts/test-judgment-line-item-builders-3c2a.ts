/**
 * Tests for the 22 builders added in Batch 3c2a.
 *
 *   npm run test:judgment-line-item-builders-3c2a
 *
 * Companion to `test-judgment-line-item-builders.ts` (which covers the 7 original 3c1
 * builders). This file focuses on Pattern 4 (derived) + Pattern 5 (applicability) +
 * the totalOpEx Path A substitution logic.
 */

import {
  ASSET_TYPES,
  type AssetType,
  type AssetProfile,
  type ContentHash,
  type ExtractionResult,
  type LibrarySnapshot,
} from '@cre/contracts';
import { computeAssetProfileId } from '../util/content-hash.js';
import {
  buildAmortizationMonths,
  buildConcessionsPct,
  buildDebtServiceAnnual,
  buildEffectiveGrossIncome,
  buildExpenseGrowthPct,
  buildInterestRate,
  buildIoPeriodMonths,
  buildLoanAmount,
  buildMaturityBalance,
  buildPcaImmediateRepairs,
  buildRentGrowthPct,
  buildTerminalCapRate,
  buildTotalOperatingExpenses,
  buildUpfrontCapex,
  buildVacancyPct,
} from '../services/judgment/line-item-builders.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}
function assertThrows(fn: () => unknown, m: string): void {
  try { fn(); fail(`${m} (did not throw)`); } catch { ok(m); }
}

/* --------------------------------- fixtures -------------------------------- */

function emptyByAssetType(): { [K in AssetType]: null } {
  const out = {} as { [K in AssetType]: null };
  for (const t of ASSET_TYPES) out[t] = null;
  return out;
}

function makeProfile(t: AssetType): AssetProfile {
  const body = { propertyType: t, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeExtraction(o: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    id: 'a'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: '1.3',
    dealRef: 'TEST', rentRoll: null, t12: null, pca: null,
    appraisal: null, sellerUw: null, sellerUwOperatingStatement: null, asr: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
    ...o,
  };
}

function makeSnapshot(opts: { officeExpenseRatio?: number | undefined } = {}): LibrarySnapshot {
  const byAssetType = emptyByAssetType() as { [K in AssetType]: ReturnType<typeof anyDist> | null };
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: opts.officeExpenseRatio ?? 0.40, p25: 0.35, p75: 0.45 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  return {
    id: 'b'.repeat(64) as never,
    asOf: AS_OF,
    approvedDealsTableHash: 'c'.repeat(64) as ContentHash,
    byAssetType,
  };
}
function anyDist() {
  return {} as { vacancy: { median: number; p25: number; p75: number }; expenseRatio: { median: number; p25: number; p75: number }; capRate: { median: number; p25: number; p75: number }; dscr: { median: number; p25: number; p75: number }; treasury10YAtClose: { median: number; p25: number; p75: number }; n: number };
}

function lineItem(value: number) {
  return { raw: value, adjusted: value, source: 'BANK' as const, adjustments: [] };
}

/* ------------------------------ buildConcessionsPct ----------------------- */

console.log('buildConcessionsPct:');
{
  const r = buildConcessionsPct({ extraction: makeExtraction(), applicable: false });
  assertEqual(r.adjusted, 0, 'not applicable → 0');
  assertEqual(r.adjustments.length, 0, 'no penalty');
}
{
  // applicable + null → substitute 0.02 default
  const r = buildConcessionsPct({ extraction: makeExtraction(), applicable: true });
  assertEqual(r.adjusted, 0.02, 'applicable + null → 0.02 default');
  assertEqual(r.adjustments.length, 1, 'substitution rule fires');
}

/* ----------------------------- buildEffectiveGrossIncome ------------------ */

console.log('\nbuildEffectiveGrossIncome:');
{
  const r = buildEffectiveGrossIncome({
    extraction: makeExtraction(),
    grossRentalIncome: lineItem(1_000_000),
    otherIncome: lineItem(50_000),
    vacancyPct: lineItem(0.05),
    concessionsPct: lineItem(0.02),
  });
  // (1_050_000) * (1 - 0.07) = 976_500
  assertClose(r.adjusted, 976_500, 0.01, 'EGI = (gri + other) × (1 - vac - conc)');
}
{
  // Batch 6.2.1 (audit U8): vacancy + concessions > 1 is an upstream contract violation.
  // Throws JudgmentEngineError with code JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE rather than
  // silently clamping at 1 (the legacy behavior, which manufactured plausible-but-false EGI).
  let threw = false;
  try {
    buildEffectiveGrossIncome({
      extraction: makeExtraction(),
      grossRentalIncome: lineItem(1_000_000),
      otherIncome: lineItem(0),
      vacancyPct: lineItem(0.95),
      concessionsPct: lineItem(0.10),
    });
  } catch (e: any) {
    threw = e?.code === 'JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE';
  }
  assertEqual(threw, true, 'vac + conc > 1 → throws JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE');
}

/* -------------------------- buildTotalOperatingExpenses -------------------- */

console.log('\nbuildTotalOperatingExpenses:');
{
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: null,
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: {
        taxes: 100_000, insurance: 18_000, utilities: 24_000,
        repairsMaintenance: 36_000, managementFees: 40_000,
        generalAndAdmin: null, janitorial: null, reimbursements: null,
        totalOperatingExpenses: 218_000,
      },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const r = buildTotalOperatingExpenses({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeExpenseRatio: 0.15 }),  // floor=150k, T-12 218k clears it
    assetProfile: makeProfile('Office'),
    effectiveGrossIncome: lineItem(1_000_000),
  });
  assertEqual(r.adjusted, 218_000, 'T-12 total used directly when above library floor');
  assertEqual(r.source, 'T12_ACTUAL', 'source = T12_ACTUAL');
  assertEqual(r.adjustments.length, 0, 'no floor adjustment when T-12 above library floor');
}
{
  // T-12 missing → Path A: substitute via library expenseRatio × EGI
  const r = buildTotalOperatingExpenses({
    extraction: makeExtraction(),
    librarySnapshot: makeSnapshot({ officeExpenseRatio: 0.35 }),
    assetProfile: makeProfile('Office'),
    effectiveGrossIncome: lineItem(1_000_000),
  });
  assertEqual(r.adjusted, 350_000, 'Path A: 0.35 × 1M = 350k');
  assertEqual(r.source, 'MANUAL', 'source = MANUAL on substitution');
  assertEqual(r.adjustments[0]?.ruleId ?? '', 'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY', 'substitution rule');
}
{
  // T-12 missing AND library degraded for asset type → throws
  assertThrows(
    () => buildTotalOperatingExpenses({
      extraction: makeExtraction(),
      librarySnapshot: makeSnapshot(),
      assetProfile: makeProfile('Multifamily'), // null distribution in our snapshot
      effectiveGrossIncome: lineItem(1_000_000),
    }),
    'T-12 missing + library degraded → throws',
  );
}
{
  // E.1 sum-of-sub-lines fallback: T-12 partial (sub-lines present, totalOpEx null) → sum
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: null,
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: null, totalIncome: null },
      expenses: {
        taxes: 100_000, insurance: 18_000, utilities: 24_000,
        repairsMaintenance: 36_000, managementFees: 40_000,
        generalAndAdmin: null, janitorial: null, reimbursements: null,
        totalOperatingExpenses: null,        // partial T-12: sub-lines yes, total no
      },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const r = buildTotalOperatingExpenses({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeExpenseRatio: 0.15 }),  // floor=150k; sum 218k clears it
    assetProfile: makeProfile('Office'),
    effectiveGrossIncome: lineItem(1_000_000),
  });
  assertEqual(r.adjusted, 218_000, 'sum-of-sub-lines (100k+18k+24k+36k+40k = 218k) above library floor');
  assertEqual(r.source, 'T12_ACTUAL', 'source = T12_ACTUAL even when total is derived from sub-lines');
  assertEqual(r.adjustments.length, 0, 'no substitution OR floor rule fires (sum above floor)');
}
{
  // NEW: library floor raises T-12 totalOpEx when T-12 < library × EGI
  const ext = makeExtraction({
    t12: {
      period: 'T-12', noi: null, vacancyLoss: null,
      income: { grossPotentialRent: null, effectiveRent: null, otherIncome: null, totalIncome: 1_000_000 },
      expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, generalAndAdmin: null, janitorial: null, reimbursements: null, totalOperatingExpenses: 200_000 },  // ratio 0.20
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
  });
  const r = buildTotalOperatingExpenses({
    extraction: ext,
    librarySnapshot: makeSnapshot({ officeExpenseRatio: 0.40 }),  // floor 0.40 × 1M = 400k
    assetProfile: makeProfile('Office'),
    effectiveGrossIncome: lineItem(1_000_000),
  });
  assertEqual(r.adjusted, 400_000, 'T-12 200k raised to library floor 400k');
  assertEqual(r.adjustments.length, 1, 'one floor adjustment fired');
  assertEqual(r.adjustments[0]?.ruleId ?? '', 'JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN', 'library floor rule');
}

/* ------------------------------ buildAmortizationMonths ------------------- */

console.log('\nbuildAmortizationMonths:');
{
  const r = buildAmortizationMonths({
    extraction: makeExtraction({
      loanTerms: { loanAmount: 50_000_000, interestRate: 0.07, amortization: 360, interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z' },
    }),
  });
  assertEqual(r.adjusted, 360, 'amortization months from LoanTerms');
}
{
  assertThrows(
    () => buildAmortizationMonths({ extraction: makeExtraction() }),
    'no LoanTerms → throws',
  );
}

/* ------------------------------ buildIoPeriodMonths ----------------------- */

console.log('\nbuildIoPeriodMonths:');
{
  const r = buildIoPeriodMonths({ extraction: makeExtraction(), applicable: false });
  assertEqual(r.adjusted, 0, 'not applicable → 0');
}
{
  const r = buildIoPeriodMonths({
    extraction: makeExtraction({
      loanTerms: { loanAmount: null, interestRate: null, amortization: null, interestOnlyPeriod: 24, maturityDate: null },
    }),
    applicable: true,
  });
  assertEqual(r.adjusted, 24, 'applicable + value preserved');
}

/* ------------------------------ buildDebtServiceAnnual -------------------- */

console.log('\nbuildDebtServiceAnnual (derived from amortization):');
{
  const r = buildDebtServiceAnnual({
    loanAmount: lineItem(1_000_000),
    interestRate: lineItem(0.07),
    amortizationMonths: lineItem(360),
  });
  assertClose(r.adjusted, 79836.30, 1, 'P&I formula: 1M @ 7% / 30y → ~$79,836');
  assertEqual(r.source, 'MANUAL', 'derived from amortization → MANUAL');
}

/* ------------------------------ buildMaturityBalance ---------------------- */

console.log('\nbuildMaturityBalance:');
{
  const r = buildMaturityBalance({
    loanAmount: lineItem(100_000),
    interestRate: lineItem(0.06),
    amortizationMonths: lineItem(360),
    termMonths: lineItem(120),
  });
  assertClose(r.adjusted, 83686.40, 1, 'remaining balance at month 120 ≈ $83,686');
}

/* ------------------------------ buildTerminalCapRate ---------------------- */

console.log('\nbuildTerminalCapRate:');
{
  const r = buildTerminalCapRate({
    extraction: makeExtraction(),
    librarySnapshot: makeSnapshot(),
    assetProfile: makeProfile('Office'),
    capRate: lineItem(0.06),
  });
  // library median 0.075 + 50bps = 0.080
  assertClose(r.adjusted, 0.080, 1e-9, 'library median + 50bps');
  assertEqual(r.source, 'MANUAL', 'always MANUAL (computed)');
}
{
  // No library entry → fallback to capRate.adjusted + 50bps
  const r = buildTerminalCapRate({
    extraction: makeExtraction(),
    librarySnapshot: makeSnapshot(),
    assetProfile: makeProfile('Multifamily'),  // null distribution
    capRate: lineItem(0.06),
  });
  assertClose(r.adjusted, 0.065, 1e-9, 'capRate + 50bps when no library');
}

/* -------------------------------- buildRentGrowthPct ---------------------- */

console.log('\nbuildRentGrowthPct:');
{
  const r = buildRentGrowthPct({
    extraction: makeExtraction({
      sellerUw: { underwrittenNOI: null, underwrittenRentGrowth: 0.04, underwrittenVacancy: null },
      sellerUwOperatingStatement: null,
    }),
  });
  assertEqual(r.adjusted, 0.04, 'sellerUw rent growth preserved');
  assertEqual(r.source, 'SELLER_UW', 'source = SELLER_UW');
}
{
  const r = buildRentGrowthPct({ extraction: makeExtraction() });
  assertEqual(r.adjusted, 0.03, 'no sellerUw → 3% default');
  assertEqual(r.source, 'MANUAL', 'source = MANUAL');
}

/* -------------------------------- buildExpenseGrowthPct ------------------- */

console.log('\nbuildExpenseGrowthPct:');
{
  const r = buildExpenseGrowthPct({ extraction: makeExtraction() });
  assertEqual(r.adjusted, 0.03, 'always 3% in v1.0');
}

/* ------------------------------- buildUpfrontCapex ------------------------ */

console.log('\nbuildUpfrontCapex:');
{
  const r = buildUpfrontCapex({ extraction: makeExtraction(), applicable: false });
  assertEqual(r.adjusted, 0, 'not applicable → 0');
}
{
  const r = buildUpfrontCapex({
    extraction: makeExtraction({
      pca: { immediateRepairs: 50_000, nearTermRepairs: null, structural: { roof: null, hvac: null, plumbing: null, electrical: null } },
    }),
    applicable: true,
  });
  assertEqual(r.adjusted, 50_000, 'applicable + PCA value');
  assertEqual(r.source, 'PCA', 'source = PCA');
}

/* --------------------------- buildPcaImmediateRepairs --------------------- */

console.log('\nbuildPcaImmediateRepairs:');
{
  const r = buildPcaImmediateRepairs({ extraction: makeExtraction(), applicable: false });
  assertEqual(r.adjusted, 0, 'not applicable → 0');
}
{
  const r = buildPcaImmediateRepairs({
    extraction: makeExtraction({
      pca: { immediateRepairs: 75_000, nearTermRepairs: null, structural: { roof: null, hvac: null, plumbing: null, electrical: null } },
    }),
    applicable: true,
  });
  assertEqual(r.adjusted, 75_000, 'PCA immediate repairs preserved');
  assertEqual(r.source, 'PCA', 'source = PCA');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
