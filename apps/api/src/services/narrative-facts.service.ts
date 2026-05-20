/**
 * NarrativeFacts producer (Batch 6.3.5) — Stage-1 projection of ExtractionResult.
 *
 * Pure deterministic projection. Encodes the structure spelled out in
 * `packages/contracts/src/narrative-facts.ts` and the 6.3.5 design lock:
 *
 *   - Pass-through fields drawn directly from typed extraction sections.
 *   - One narrow derivation: `isSingleTenant`, computed from `rentRoll` topology.
 *   - 13 fields are unconditionally `null` because no upstream source captures them yet
 *     (multi-period histories, market context, asset-class taxonomy). They become
 *     populated when extraction grows; this producer never invents them.
 *
 * Invariants (information-entropy rule, locked 2026-05-08):
 *
 *   - May DROP information (null propagation when a source section is absent).
 *   - MUST NOT invent inferred signals or fall back to proxies.
 *   - MUST NOT branch on asset class.
 *   - MUST NOT read any record other than ExtractionResult (no LibrarySnapshot,
 *     AdjustedInputs, StressOutputs, CrossCheckResult, DoctrineEvaluation).
 *
 * `isSingleTenant` semantics — null distinguishes UNKNOWN from FALSE:
 *
 *   - rentRoll === null              → null   (UNKNOWN: missing data)
 *   - rentRoll.units.length === 0    → false  (structurally observable: no tenants)
 *   - distinct(non-null tenantName) === 1 → true
 *   - distinct(non-null tenantName) !== 1 → false
 *
 * Returning null on the empty-units case would incorrectly trigger downstream
 * INSUFFICIENT_DATA classification and conservatism gating; the empty array is a fact,
 * not a missing input.
 */

import type { ExtractionResult, NarrativeFacts } from '@cre/contracts';
import type { ISODateTime } from '@cre/contracts';
import { computeNarrativeFactsId } from '../util/content-hash.js';

export interface BuildNarrativeFactsArgs {
  readonly extractionResult: ExtractionResult;
  readonly analysisAsOfDate: ISODateTime;
}

function deriveIsSingleTenant(extraction: ExtractionResult): boolean | null {
  const rentRoll = extraction.rentRoll;
  if (rentRoll === null) return null;
  if (rentRoll.units.length === 0) return false;

  const distinctTenants = new Set<string>();
  for (const unit of rentRoll.units) {
    if (unit.tenantName !== null) distinctTenants.add(unit.tenantName);
  }
  return distinctTenants.size === 1;
}

export function buildNarrativeFacts(args: BuildNarrativeFactsArgs): NarrativeFacts {
  const { extractionResult, analysisAsOfDate } = args;
  const { rentRoll, appraisal, asr } = extractionResult;

  const body: Omit<NarrativeFacts, 'id'> = {
    analysisAsOfDate,

    trailingOccAvg: null,
    occupancyCurrent: rentRoll === null ? null : rentRoll.summary.economicOccupancy,

    propertyClass: null,
    shadowVacancyFlag: null,
    subleaseCompetition: null,
    leasingVelocityDataAvailable: null,

    isMall: null,

    franchiseExpirationWithinTerm: null,
    pipRequired: null,
    pipBudgetPerKey: null,

    privateWastewater: null,
    parkOwnedHomesPct: null,

    t12NoiTrend: null,

    isSingleTenant: deriveIsSingleTenant(extractionResult),
    appraisalValue: appraisal === null ? null : appraisal.valueConclusion,
    appraisalCapRate: appraisal === null ? null : appraisal.capRate,
    asrValue: asr === null ? null : asr.impliedValue,
    marketValueFromComps: null,
    exitCapRateBase: null,
    exitCapRateStressed: null,
  };

  return {
    id: computeNarrativeFactsId(body),
    ...body,
  };
}
