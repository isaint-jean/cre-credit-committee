/**
 * Stage 5 — Conservatism Gate.
 *
 * Hard constraint layer per architecture contract §6:
 *   - adjusted vacancy ≥ max(library median, raw bank vacancy)
 *   - adjusted expense ratio ≥ max(library median, raw bank expense ratio)
 *   - adjusted NOI ≤ raw bank NOI (unless explicit driver justification in topLevelAdjustments)
 *
 * Throws `ConservatismViolation` (wrapping `ConservatismViolationPayload` from contracts) on
 * any failure. v1.0 cap (audit §B.4) ensures NOI ceiling is satisfied by Phase 3 of the
 * orchestrator before this gate runs — the NOI check is defensive (catches bugs in the cap).
 */

import type {
  AdjustedInputs,
  AssetProfile,
  ConservatismViolationDetail,
  ExtractionResult,
  LibrarySnapshot,
} from '@cre/contracts';
import { getLibraryMedian } from './library-lookup.js';
import {
  bankNoiCascade,
  pickFirstNonNull,
  vacancyPctCascade,
} from './source-cascade.js';
import { ConservatismViolation } from './errors.js';

export function verifyConservatism(args: {
  readonly adjustedInputs: AdjustedInputs;
  readonly extraction: ExtractionResult;
  readonly librarySnapshot: LibrarySnapshot;
  readonly assetProfile: AssetProfile;
}): void {
  const { adjustedInputs, extraction, librarySnapshot, assetProfile } = args;
  const violations: ConservatismViolationDetail[] = [];

  // 1. Vacancy floor — adjusted >= max(library median, bank vacancy).
  //
  // Batch 6.2 (audit NR4): explicit null handling — distinguish "no floor data" from
  // "floor of 0." When both sources are null, the gate cannot enforce a floor; skip
  // enforcement. The orchestrator emits JE_CONSERVATISM_GATE_NO_FLOOR_DATA in
  // dataQualityFlags so doctrine sees the degraded state.
  const adjustedVacancy = adjustedInputs.income.vacancyPct.adjusted;
  const libraryVacancy = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'vacancy');
  const bankVacancy = pickFirstNonNull(vacancyPctCascade(extraction)).value;
  if (libraryVacancy !== null || bankVacancy !== null) {
    // At least one source available — `?? 0` here is safe because we've established the other
    // floor candidate exists; null → 0 lets `Math.max` pick the present source.
    const expectedVacancyFloor = Math.max(libraryVacancy ?? 0, bankVacancy ?? 0);
    if (expectedVacancyFloor > 0 && adjustedVacancy < expectedVacancyFloor - 1e-9) {
      violations.push({
        metric: 'vacancy',
        rule: 'VACANCY_FLOOR',
        expected: expectedVacancyFloor,
        actual: adjustedVacancy,
      });
    }
  }

  // 2. Expense ratio floor — adjusted >= max(library median, bank ratio).
  //
  // Same pattern as vacancy floor. Both null → skip enforcement, orchestrator emits flag.
  const expenseRatio = adjustedInputs.metrics.expenseRatio;
  if (expenseRatio !== null) {
    const libraryRatioMedian = getLibraryMedian(librarySnapshot, assetProfile.propertyType, 'expenseRatio');
    const t12 = extraction.t12;
    const bankEgi = t12?.income.totalIncome ?? null;
    const bankOpex = t12?.expenses.totalOperatingExpenses ?? null;
    const bankRatio =
      bankEgi !== null && bankOpex !== null && bankEgi > 0 ? bankOpex / bankEgi : null;
    if (libraryRatioMedian !== null || bankRatio !== null) {
      const expectedRatioFloor = Math.max(libraryRatioMedian ?? 0, bankRatio ?? 0);
      if (expectedRatioFloor > 0 && expenseRatio < expectedRatioFloor - 1e-9) {
        violations.push({
          metric: 'expense_ratio',
          rule: 'EXPENSE_FLOOR',
          expected: expectedRatioFloor,
          actual: expenseRatio,
        });
      }
    }
  }

  // 3. NOI ceiling — adjusted <= bank NOI (unless explicit driver justification)
  const adjustedNoi = adjustedInputs.metrics.noi;
  const bankNoi = pickFirstNonNull(bankNoiCascade(extraction)).value;
  if (adjustedNoi !== null && bankNoi !== null && adjustedNoi > bankNoi + 1e-9) {
    const hasJustification = adjustedInputs.topLevelAdjustments.some(
      a => a.ruleId === 'JE_NOI_CAPPED_TO_BANK',
    );
    if (!hasJustification) {
      violations.push({
        metric: 'noi',
        rule: 'NOI_CEILING',
        expected: bankNoi,
        actual: adjustedNoi,
      });
    }
  }

  if (violations.length > 0) {
    throw new ConservatismViolation({ violations });
  }
}
