/**
 * NarrativeFacts — stage-1/3 producer output, consumed by the doctrine evaluator (and the
 * valuation engine, for anchor values).
 *
 * Distinct from the post-hydration `UnderwritingContext`. NarrativeFacts is the immutable
 * frozen-at-extraction record of facts derived from documents. It feeds the doctrine
 * asset-type adjusters (§11) and the valuation engine's anchor logic (§9).
 *
 * Sentinels permitted (`null`) — every field can be missing. Doctrine asset-type adjusters fire
 * only when the relevant fact is present and non-null; missing facts route through the
 * INSUFFICIENT_DATA path.
 */

import type { NarrativeFactsId } from './identity.js';
import type { ISODateTime } from './versioning.js';

export const SUBLEASE_COMPETITION_LEVELS = ['low', 'medium', 'high'] as const;
export type SubleaseCompetitionLevel = (typeof SUBLEASE_COMPETITION_LEVELS)[number];

export const PROPERTY_CLASSES = ['A', 'B', 'C'] as const;
export type PropertyClass = (typeof PROPERTY_CLASSES)[number];

export const T12_NOI_TRENDS = ['up', 'flat', 'down'] as const;
export type T12NoiTrend = (typeof T12_NOI_TRENDS)[number];

export interface NarrativeFacts {
  readonly id: NarrativeFactsId;
  readonly analysisAsOfDate: ISODateTime;

  // Occupancy / lease-up posture (drives §2 business plan classification)
  readonly trailingOccAvg: number | null;
  readonly occupancyCurrent: number | null;

  // Office §11
  readonly propertyClass: PropertyClass | null;
  readonly shadowVacancyFlag: boolean | null;
  readonly subleaseCompetition: SubleaseCompetitionLevel | null;
  readonly leasingVelocityDataAvailable: boolean | null;

  // Retail §11
  readonly isMall: boolean | null;

  // Hotel §11
  readonly franchiseExpirationWithinTerm: boolean | null;
  readonly pipRequired: boolean | null;
  readonly pipBudgetPerKey: number | null;

  // MHC §11
  readonly privateWastewater: boolean | null;
  readonly parkOwnedHomesPct: number | null;

  // §12 false-negative guard input
  readonly t12NoiTrend: T12NoiTrend | null;

  // Single-tenant + valuation anchor inputs (§9)
  readonly isSingleTenant: boolean | null;
  readonly appraisalValue: number | null;
  readonly appraisalCapRate: number | null;
  readonly asrValue: number | null;
  readonly marketValueFromComps: number | null;
  readonly exitCapRateBase: number | null;
  readonly exitCapRateStressed: number | null;
}
