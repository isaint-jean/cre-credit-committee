/**
 * Server-side credit-policy band attachment (Batch 6 sub-batch 6.1).
 *
 * Pure decorator functions that walk an `Analysis` (or its sub-objects) and
 * populate the `*Band` / `*Breached` / `tier` display fields using the
 * doctrine-owned classifiers in `./credit-policy-bands.ts`. The web client
 * reads these fields directly; it MUST NOT recompute them from numeric metrics.
 *
 * Architecture:
 *   - Doctrine is the single authority for thresholds (D6).
 *   - Decoration applied at the API boundary, just before `res.json(...)`.
 *   - No mutation of stored records. Decorators receive a value and return a
 *     decorated copy (shallow / structural copy as appropriate).
 *   - Inputs that are `null` produce `null` band — degraded state surfaces.
 *
 * NOTE on placement: this is technically a "decorator at the route boundary"
 * rather than a producer. It lives under `services/doctrine/` because the
 * threshold knowledge it applies is doctrine-owned. When the new spine
 * (Batch 6.4–6.7) writes records via Stage-10 doctrine evaluation, the
 * `metricBands` will be a first-class field on `DoctrineEvaluation`; the
 * legacy decorator becomes redundant and is retired during 6.7 cutover.
 */

import type {
  Analysis,
  CreditScore,
  StressScenario,
} from '@cre/shared';
import type { UnderwritingModel } from '@cre/shared';
import {
  classifyBalloonBand,
  classifyCategoryTier,
  classifyDebtYieldBand,
  classifyDscrBand,
  classifyLtvBand,
  classifyMinDscrBand,
  classifyMonthlyDscrBand,
  classifyStressDebtYieldBreached,
  classifyStressDscrBreached,
  classifyStressLtvBreached,
} from './credit-policy-bands.js';

/**
 * Decorate a UW model with credit-policy bands. Returns a new object with
 * the same shape plus `dscrBand`, `ltvBand`, `debtYieldBand`, and (if a
 * repayment schedule is present) per-summary + per-entry bands.
 */
export function applyBandsToUwModel(model: UnderwritingModel): UnderwritingModel {
  const dscrBand = classifyDscrBand(model.dscr);
  const ltvBand = classifyLtvBand(model.ltv);
  const debtYieldBand = classifyDebtYieldBand(model.debtYield);

  let repaymentSchedule = model.repaymentSchedule;
  if (repaymentSchedule) {
    const summary = repaymentSchedule.summary;
    const decoratedSummary = {
      ...summary,
      balloonBand: classifyBalloonBand(summary.balloonBalance, model.loanAmount),
      minDscrBand: classifyMinDscrBand(summary.minDSCR),
    };
    const decoratedEntries = repaymentSchedule.entries.map(entry => ({
      ...entry,
      monthlyDscrBand: classifyMonthlyDscrBand(entry.monthlyDSCR),
    }));
    repaymentSchedule = {
      ...repaymentSchedule,
      entries: decoratedEntries,
      summary: decoratedSummary,
    };
  }

  return {
    ...model,
    dscrBand,
    ltvBand,
    debtYieldBand,
    repaymentSchedule,
  };
}

/**
 * Decorate a stress-scenario array with per-cell breach flags.
 * `breaksCovenants` (scenario-level) is preserved as-is.
 */
export function applyBandsToStressScenarios(scenarios: readonly StressScenario[]): StressScenario[] {
  return scenarios.map(s => ({
    ...s,
    results: {
      ...s.results,
      dscrBreached: classifyStressDscrBreached(s.results.dscr),
      ltvBreached: classifyStressLtvBreached(s.results.ltv),
      debtYieldBreached: classifyStressDebtYieldBreached(s.results.debtYield),
    },
  }));
}

/**
 * Decorate a credit-score object with per-category tier classifications.
 * `riskTier` (overall) is already on the record — left untouched.
 */
export function applyBandsToCreditScore(score: CreditScore): CreditScore {
  const categories = score.categories.map(cat => ({
    ...cat,
    tier: classifyCategoryTier(cat.score),
  }));
  return { ...score, categories };
}

/**
 * Apply all credit-policy bands to a complete Analysis. Used by every route
 * handler that returns the full Analysis to the client. Returns a new object;
 * does not mutate.
 */
export function applyCreditPolicyBandsToAnalysis(analysis: Analysis): Analysis {
  return {
    ...analysis,
    uwModel: analysis.uwModel ? applyBandsToUwModel(analysis.uwModel) : null,
    stressScenarios: applyBandsToStressScenarios(analysis.stressScenarios ?? []),
    creditScore: analysis.creditScore ? applyBandsToCreditScore(analysis.creditScore) : null,
  };
}
