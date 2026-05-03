import { UnderwritingModel } from '@cre/shared';
import { StressScenario } from '@cre/shared';
import { applyStressToModel } from '@cre/shared';

interface StressInput {
  name: string;
  adjustments: {
    vacancyDelta: number;
    rentDelta: number;
    capRateDelta: number;
    interestRateDelta: number;
  };
}

const COVENANT_THRESHOLDS = {
  minDSCR: 1.15,
  maxLTV: 80,
  minDebtYield: 7,
};

export function runStressTests(
  baseModel: UnderwritingModel,
  scenarios: StressInput[]
): StressScenario[] {
  return scenarios.map((scenario) => {
    const stressed = applyStressToModel(baseModel, scenario.adjustments);

    const breaches: string[] = [];
    const skips: string[] = [];

    // Strict SKIP semantics: null inputs are NOT pass, NOT fail. The covenant
    // simply cannot be evaluated. Never coerce null → 0 → comparison.
    if (stressed.dscr === null) {
      skips.push(`DSCR not evaluable (input missing)`);
    } else if (stressed.dscr < COVENANT_THRESHOLDS.minDSCR) {
      breaches.push(`DSCR ${stressed.dscr.toFixed(2)}x below ${COVENANT_THRESHOLDS.minDSCR}x minimum`);
    }

    if (stressed.ltv === null) {
      skips.push(`LTV not evaluable (input missing)`);
    } else if (stressed.ltv > COVENANT_THRESHOLDS.maxLTV) {
      breaches.push(`LTV ${stressed.ltv.toFixed(1)}% exceeds ${COVENANT_THRESHOLDS.maxLTV}% maximum`);
    }

    if (stressed.debtYield === null) {
      skips.push(`Debt Yield not evaluable (input missing)`);
    } else if (stressed.debtYield < COVENANT_THRESHOLDS.minDebtYield) {
      breaches.push(`Debt Yield ${stressed.debtYield.toFixed(2)}% below ${COVENANT_THRESHOLDS.minDebtYield}% minimum`);
    }

    return {
      name: scenario.name,
      adjustments: scenario.adjustments,
      results: {
        noi: stressed.netOperatingIncome,
        dscr: stressed.dscr,
        ltv: stressed.ltv,
        debtYield: stressed.debtYield,
        impliedValue: stressed.impliedValue,
      },
      // breaksCovenants reflects ACTUAL breaches only — skipped covenants
      // do not count as breaches (or as passes).
      breaksCovenants: breaches.length > 0,
      covenantBreaches: breaches,
      covenantSkips: skips,
    };
  });
}

export const DEFAULT_STRESS_SCENARIOS: StressInput[] = [
  {
    name: 'Vacancy Increase (+5%)',
    adjustments: { vacancyDelta: 5, rentDelta: 0, capRateDelta: 0, interestRateDelta: 0 },
  },
  {
    name: 'Rent Decline (-10%)',
    adjustments: { vacancyDelta: 0, rentDelta: -10, capRateDelta: 0, interestRateDelta: 0 },
  },
  {
    name: 'Cap Rate Expansion (+100bps)',
    adjustments: { vacancyDelta: 0, rentDelta: 0, capRateDelta: 1, interestRateDelta: 0 },
  },
  {
    name: 'Interest Rate Shock (+200bps)',
    adjustments: { vacancyDelta: 0, rentDelta: 0, capRateDelta: 0, interestRateDelta: 2 },
  },
  {
    name: 'Combined Downturn',
    adjustments: { vacancyDelta: 5, rentDelta: -10, capRateDelta: 1, interestRateDelta: 1 },
  },
];
