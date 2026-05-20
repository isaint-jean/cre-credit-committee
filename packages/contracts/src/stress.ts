/**
 * StressOutputs — stage-8 producer output.
 *
 * Existing `stress-test.service.ts` owns DEFAULT scenarios. v1 doctrine extends with two
 * asset-class-aware methods:
 *   - TENANT_REMOVAL: Office / Retail / Industrial — remove top-N tenants from the rent roll
 *   - OCC_RENT_CONCESSION: Multifamily / Hotel / SelfStorage / MHC — apply occ/rent/expense deltas
 *
 * Doctrine §8 maturity-risk reads `scenarios[].value` and the corresponding stressed LTV is
 * derived inside the engine. Doctrine never defines stress scenarios.
 */

import type {
  AdjustedInputsId,
  StressOutputsId,
} from './identity.js';
import type {
  ISODateTime,
  StressEngineVersion,
} from './versioning.js';

export const STRESS_METHODS = ['DEFAULT', 'TENANT_REMOVAL', 'OCC_RENT_CONCESSION'] as const;
export type StressMethod = (typeof STRESS_METHODS)[number];

export const STRESS_BREACHES = ['DSCR', 'LTV', 'DEBT_YIELD'] as const;
export type StressBreach = (typeof STRESS_BREACHES)[number];

export interface StressScenarioOutput {
  readonly name: string;                           // e.g. 'Remove_T1_T2', 'Occ_down_10', 'Vacancy_+5'
  readonly noi: number | null;
  readonly dscr: number | null;
  readonly value: number | null;
  readonly ltv: number | null;
  readonly debtYield: number | null;
  readonly breaches: readonly StressBreach[];
  readonly skipped: readonly StressBreach[];       // covenant skipped because input was null
}

export interface StressOutputs {
  readonly id: StressOutputsId;
  readonly analysisAsOfDate: ISODateTime;
  readonly adjustedInputsId: AdjustedInputsId;
  readonly stressEngineVersion: StressEngineVersion;

  readonly method: StressMethod;
  readonly scenarios: readonly StressScenarioOutput[];
}
