/**
 * Stress engine (contract-shape).
 *
 * Produces `StressOutputs` from `@cre/contracts/stress`. Asset-class dispatch:
 *
 *   Office / Retail / Industrial               → TENANT_REMOVAL
 *   Multifamily / Hotel / SelfStorage / MHC    → OCC_RENT_CONCESSION
 *   MixedUse / Other                           → DEFAULT  (fallback; vacancy + rent + cap + rate shocks)
 *
 * Doctrine §8 (maturity refi feasibility) reads `scenarios[].value`. Doctrine §10 is the source
 * of truth for which scenarios exist per method. This engine is the SOLE owner of stress math —
 * doctrine never recomputes.
 *
 * Architecture rule: extends the existing legacy `stress-test.service.ts` (which still owns the
 * legacy `StressScenario[]` shape used by current consumers). Runs in parallel during rollout.
 *
 * TENANT_REMOVAL needs rent-roll-derived top-tenant income shares. If the caller doesn't supply
 * them (no rent roll on the deal), the dispatch falls back to DEFAULT and stamps the scenarios
 * with `skipped: ['DSCR', 'LTV', 'DEBT_YIELD']` to surface the data gap.
 */

import type {
  AdjustedInputs,
  AdjustedInputsId,
  AssetProfile,
  ISODateTime,
  StressBreach,
  StressMethod,
  StressOutputs,
  StressScenarioOutput,
} from '@cre/contracts';
import { STRESS_ENGINE_VERSION } from '@cre/contracts';
import { computeStressOutputsId } from '../util/content-hash.js';

/** Minimal rent-roll summary needed for TENANT_REMOVAL — top-N tenants by income share. */
export interface TopTenantShare {
  readonly rank: number;          // 1, 2, 3, ...
  readonly incomeShare: number;   // 0..1; share of gross rental income
  readonly tenantName?: string;   // optional, narrative-only
}

/** Covenant thresholds. Locked here for the contract path (separate from legacy thresholds). */
export const STRESS_COVENANT_THRESHOLDS = {
  minDSCR: 1.15,
  maxLTV: 0.80,         // fraction (was percentage in legacy)
  minDebtYield: 0.07,   // fraction (was percentage in legacy)
} as const;

/* ------------------------------- dispatch -------------------------------- */

export function chooseStressMethod(propertyType: AssetProfile['propertyType']): StressMethod {
  switch (propertyType) {
    case 'Office':
    case 'Retail':
    case 'Industrial':
      return 'TENANT_REMOVAL';
    case 'Multifamily':
    case 'Hotel':
    case 'SelfStorage':
    case 'MHC':
      return 'OCC_RENT_CONCESSION';
    case 'MixedUse':
    case 'Other':
    default:
      return 'DEFAULT';
  }
}

/* ------------------------------- main entry ------------------------------ */

export function buildStressOutputs(args: {
  readonly adjustedInputs: AdjustedInputs;
  readonly assetProfile: AssetProfile;
  readonly topTenantShares?: readonly TopTenantShare[];
  readonly analysisAsOfDate: ISODateTime;
}): StressOutputs {
  const { adjustedInputs, assetProfile, topTenantShares, analysisAsOfDate } = args;

  const intendedMethod = chooseStressMethod(assetProfile.propertyType);
  const haveRentRoll = topTenantShares !== undefined && topTenantShares.length > 0;

  const method: StressMethod =
    intendedMethod === 'TENANT_REMOVAL' && !haveRentRoll ? 'DEFAULT' : intendedMethod;

  let scenarios: readonly StressScenarioOutput[];
  if (method === 'TENANT_REMOVAL') {
    scenarios = runTenantRemoval(adjustedInputs, topTenantShares!);
  } else if (method === 'OCC_RENT_CONCESSION') {
    scenarios = runOccRentConcession(adjustedInputs);
  } else {
    scenarios = runDefault(adjustedInputs);
  }

  const body = {
    analysisAsOfDate,
    adjustedInputsId: adjustedInputs.id satisfies AdjustedInputsId,
    stressEngineVersion: STRESS_ENGINE_VERSION,
    method,
    scenarios,
  };
  return { id: computeStressOutputsId(body), ...body } as StressOutputs;
}

/* ------------------------------ DEFAULT ---------------------------------- */

interface DefaultScenarioSpec {
  readonly name: string;
  readonly vacancyDelta: number;       // absolute pp added to vacancy fraction (0.05 = +5pp)
  readonly rentDelta: number;          // multiplicative; -0.10 = -10%
  readonly capRateDelta: number;       // absolute pp added to cap rate (0.01 = +100bps)
  readonly interestRateDelta: number;  // absolute pp added to interest rate (0.02 = +200bps)
}

const DEFAULT_SCENARIOS: readonly DefaultScenarioSpec[] = [
  { name: 'Vacancy +5%',          vacancyDelta: 0.05, rentDelta: 0,    capRateDelta: 0,    interestRateDelta: 0    },
  { name: 'Rent -10%',            vacancyDelta: 0,    rentDelta: -0.10, capRateDelta: 0,    interestRateDelta: 0    },
  { name: 'Cap +100bps',          vacancyDelta: 0,    rentDelta: 0,    capRateDelta: 0.01, interestRateDelta: 0    },
  { name: 'Interest +200bps',     vacancyDelta: 0,    rentDelta: 0,    capRateDelta: 0,    interestRateDelta: 0.02 },
  { name: 'Combined Downturn',    vacancyDelta: 0.05, rentDelta: -0.10, capRateDelta: 0.01, interestRateDelta: 0.01 },
];

function runDefault(ai: AdjustedInputs): readonly StressScenarioOutput[] {
  return DEFAULT_SCENARIOS.map(spec => {
    const noi = stressedNoi(ai, { vacancyDelta: spec.vacancyDelta, rentDelta: spec.rentDelta, expDelta: 0 });
    const capRate = ai.assumptions.capRate.adjusted + spec.capRateDelta;
    const value = noi !== null && capRate > 0 ? noi / capRate : null;
    const debtServiceAnnual = stressedDebtService(ai, spec.interestRateDelta);
    const dscr = noi !== null && debtServiceAnnual !== null && debtServiceAnnual > 0 ? noi / debtServiceAnnual : null;
    const ltv = value !== null && value > 0 ? ai.loan.loanAmount.adjusted / value : null;
    const debtYield = ai.loan.loanAmount.adjusted > 0 && noi !== null ? noi / ai.loan.loanAmount.adjusted : null;
    return finalizeScenario(spec.name, { noi, dscr, value, ltv, debtYield });
  });
}

/* ------------------------ OCC_RENT_CONCESSION ---------------------------- */

interface OccRentScenarioSpec {
  readonly name: string;
  readonly occDelta: number;      // -0.05 means occupancy down 5pp (= vacancy up 5pp)
  readonly rentDelta: number;
  readonly expDelta: number;
}

const OCC_RENT_SCENARIOS: readonly OccRentScenarioSpec[] = [
  { name: 'Occ -5%',     occDelta: -0.05, rentDelta:  0,    expDelta: 0    },
  { name: 'Occ -10%',    occDelta: -0.10, rentDelta:  0,    expDelta: 0    },
  { name: 'Rent -5%',    occDelta:  0,    rentDelta: -0.05, expDelta: 0    },
  { name: 'Rent -10%',   occDelta:  0,    rentDelta: -0.10, expDelta: 0    },
  { name: 'Combo',       occDelta: -0.05, rentDelta: -0.05, expDelta: 0.03 },
];

function runOccRentConcession(ai: AdjustedInputs): readonly StressScenarioOutput[] {
  return OCC_RENT_SCENARIOS.map(spec => {
    const vacancyDelta = -spec.occDelta;   // occupancy down N → vacancy up N
    const noi = stressedNoi(ai, { vacancyDelta, rentDelta: spec.rentDelta, expDelta: spec.expDelta });
    const capRate = ai.assumptions.capRate.adjusted;
    const value = noi !== null && capRate > 0 ? noi / capRate : null;
    const dscr = noi !== null && ai.loan.debtServiceAnnual.adjusted > 0
      ? noi / ai.loan.debtServiceAnnual.adjusted
      : null;
    const ltv = value !== null && value > 0 ? ai.loan.loanAmount.adjusted / value : null;
    const debtYield = ai.loan.loanAmount.adjusted > 0 && noi !== null
      ? noi / ai.loan.loanAmount.adjusted
      : null;
    return finalizeScenario(spec.name, { noi, dscr, value, ltv, debtYield });
  });
}

/* ----------------------------- TENANT_REMOVAL ---------------------------- */

interface TenantRemovalScenarioSpec {
  readonly name: string;
  readonly removeRanks: readonly number[];   // ranks to remove (1=top tenant)
}

const TENANT_REMOVAL_SCENARIOS: readonly TenantRemovalScenarioSpec[] = [
  { name: 'Remove T1',         removeRanks: [1]       },
  { name: 'Remove T2',         removeRanks: [2]       },
  { name: 'Remove T3',         removeRanks: [3]       },
  { name: 'Remove T1+T2',      removeRanks: [1, 2]    },
  { name: 'Remove T1+T2+T3',   removeRanks: [1, 2, 3] },
];

function runTenantRemoval(
  ai: AdjustedInputs,
  topTenantShares: readonly TopTenantShare[],
): readonly StressScenarioOutput[] {
  return TENANT_REMOVAL_SCENARIOS.map(spec => {
    // Batch 6.2 (U14): if a requested rank is not present in topTenantShares, do NOT silently
    // contribute zero. Producing a falsely-light scenario understates stress severity. Instead,
    // return a fully-skipped scenario — every covenant metric routes through the SKIP path in
    // finalizeScenario, surfacing the unmeasurable condition explicitly.
    const missingRanks = spec.removeRanks.filter(rank => !topTenantShares.some(t => t.rank === rank));
    if (missingRanks.length > 0) {
      return finalizeScenario(spec.name, {
        noi: null, dscr: null, value: null, ltv: null, debtYield: null,
      });
    }

    const removedShare = spec.removeRanks.reduce((sum, rank) => {
      const tenant = topTenantShares.find(t => t.rank === rank);
      // Guarded above; non-null assertion would be safe but keep the conditional for clarity.
      return tenant ? sum + tenant.incomeShare : sum;
    }, 0);

    const grossIncome = ai.income.grossRentalIncome.adjusted + ai.income.otherIncome.adjusted;
    const lostIncome = grossIncome * removedShare;
    const adjustedGrossIncome = grossIncome - lostIncome;
    const vacancy = ai.income.vacancyPct.adjusted;
    const concessions = ai.income.concessionsPct.adjusted;
    // Batch 6.2 (NR7): if vacancy + concessions > 1 the upstream produced an impossible
    // composite. Do NOT silently clamp — propagate as null NOI so the scenario surfaces as
    // unmeasurable rather than green-by-policy-cap.
    const occupancyLoss = vacancy + concessions;
    if (occupancyLoss > 1 || occupancyLoss < 0) {
      return finalizeScenario(spec.name, {
        noi: null, dscr: null, value: null, ltv: null, debtYield: null,
      });
    }
    const egi = adjustedGrossIncome * (1 - occupancyLoss);
    const opex = ai.expenses.totalOperatingExpenses.adjusted;
    const noi = egi - opex;

    const capRate = ai.assumptions.capRate.adjusted;
    const value = capRate > 0 ? noi / capRate : null;
    const dscr = ai.loan.debtServiceAnnual.adjusted > 0 ? noi / ai.loan.debtServiceAnnual.adjusted : null;
    const ltv = value !== null && value > 0 ? ai.loan.loanAmount.adjusted / value : null;
    const debtYield = ai.loan.loanAmount.adjusted > 0 ? noi / ai.loan.loanAmount.adjusted : null;
    return finalizeScenario(spec.name, { noi, dscr, value, ltv, debtYield });
  });
}

/* ------------------------------- math helpers ---------------------------- */

function stressedNoi(
  ai: AdjustedInputs,
  deltas: { vacancyDelta: number; rentDelta: number; expDelta: number },
): number | null {
  const grossRental = ai.income.grossRentalIncome.adjusted * (1 + deltas.rentDelta);
  const other = ai.income.otherIncome.adjusted;
  const grossWithRentDelta = grossRental + other;
  const stressedVacancy = ai.income.vacancyPct.adjusted + deltas.vacancyDelta;
  const concessions = ai.income.concessionsPct.adjusted;
  // Batch 6.2 (NR7): occupancy loss of stressedVacancy + concessions outside [0, 1] is an
  // upstream contract violation (sum-of-rates impossible composite). Do NOT silently clamp —
  // return null NOI so the scenario surfaces as unmeasurable via finalizeScenario's SKIP path.
  const occupancyLoss = stressedVacancy + concessions;
  if (occupancyLoss > 1 || occupancyLoss < 0) return null;
  const egi = grossWithRentDelta * (1 - occupancyLoss);
  const opex = ai.expenses.totalOperatingExpenses.adjusted * (1 + deltas.expDelta);
  return egi - opex;
}

function stressedDebtService(ai: AdjustedInputs, interestRateDelta: number): number | null {
  // Approximate stress: scale annual debt service by (1 + interestRateDelta / current_rate).
  // Real amortization re-calc requires a P&I formula; for stress purposes the linear
  // approximation is sufficient and matches the legacy heuristic.
  const currentRate = ai.loan.interestRate.adjusted;
  // Batch 6.2 (U13): when current rate is missing / zero we cannot compute a stressed debt
  // service. Returning the unstressed value silently turns "no rate data" into "rate stress is
  // a no-op" — the scenario falsely passes. Return null instead so finalizeScenario routes
  // DSCR through the SKIP path explicitly.
  if (currentRate <= 0) return null;
  const newRate = currentRate + interestRateDelta;
  const ratio = newRate / currentRate;
  return ai.loan.debtServiceAnnual.adjusted * ratio;
}

function finalizeScenario(
  name: string,
  m: {
    noi: number | null;
    dscr: number | null;
    value: number | null;
    ltv: number | null;
    debtYield: number | null;
  },
): StressScenarioOutput {
  const breaches: StressBreach[] = [];
  const skipped: StressBreach[] = [];

  if (m.dscr === null) skipped.push('DSCR');
  else if (m.dscr < STRESS_COVENANT_THRESHOLDS.minDSCR) breaches.push('DSCR');

  if (m.ltv === null) skipped.push('LTV');
  else if (m.ltv > STRESS_COVENANT_THRESHOLDS.maxLTV) breaches.push('LTV');

  if (m.debtYield === null) skipped.push('DEBT_YIELD');
  else if (m.debtYield < STRESS_COVENANT_THRESHOLDS.minDebtYield) breaches.push('DEBT_YIELD');

  return {
    name,
    noi: m.noi,
    dscr: m.dscr,
    value: m.value,
    ltv: m.ltv,
    debtYield: m.debtYield,
    breaches,
    skipped,
  };
}
