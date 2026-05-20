/**
 * Stage 9 — Valuation Engine.
 *
 * `buildValuationConclusion(args) → ValuationConclusion`. The SOLE owner of valuation
 * computation per architecture §9 + audit §C.4. Inputs are restricted to the post-judgment
 * world: AdjustedInputs (with finalized NOI + capRate), StressOutputs (with stressed NOI per
 * scenario), and NarrativeFacts (anchor values, exit cap rates, single-tenant flag). Never
 * reads ExtractionResult, LibrarySnapshot, or MarketBenchmarks.
 *
 * Output flow:
 *   - uwValue        = noi / capRate.adjusted
 *   - marketValue    = narrativeFacts.marketValueFromComps (or null)
 *   - downsideValue  = worstStressNoi / exitCapRateStressed
 *   - finalValue     = min_non_null(uwValue, marketValue, downsideValue) — then guardrails
 *
 * §9 guardrails (architecture):
 *   - OVERVALUATION_GUARDRAIL_TRIGGERED — if uwValue > 1.20 × anchor: cap finalValue to
 *     1.10 × anchor. Anchor priority: appraisal > asr > market_comps. Records in capsApplied.
 *   - EXIT_CAP_TOO_TIGHT — if exitCapRateBase < appraisalCapRate: advisory flag (no value
 *     change). Records in valuationFlags.
 *   - SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED — if isSingleTenant === true OR
 *     top1IncomeShare ≥ 0.70: multiply finalValue by 0.50. Records in haircutsApplied.
 *
 * Architecture rules enforced:
 *   - No re-derivation of NOI or DSCR. Reads `adjustedInputs.metrics.noi` directly.
 *   - No backflow into judgment engine. Outputs flow forward to doctrine only.
 *   - Output is content-hash addressable + immutable. Caller persists; engine returns.
 */

import type {
  AdjustedInputs,
  DoctrineFlag,
  NarrativeFacts,
  StressOutputs,
  ValuationAnchor,
  ValuationCap,
  ValuationConclusion,
  ValuationHaircut,
} from '@cre/contracts';
import { VALUATION_ENGINE_VERSION } from '@cre/contracts';
import { computeValuationConclusionId } from '../util/content-hash.js';

export interface BuildValuationConclusionArgs {
  readonly adjustedInputs: AdjustedInputs;
  readonly stressOutputs: StressOutputs;
  readonly narrativeFacts: NarrativeFacts;
}

const SINGLE_TENANT_INCOME_THRESHOLD = 0.70 as const;
const ANCHOR_TRIGGER_MULTIPLIER = 1.20 as const;
const ANCHOR_CAP_MULTIPLIER = 1.10 as const;
const DARK_VALUE_HAIRCUT_PCT = 0.50 as const;

/* ------------------------------ helpers ------------------------------ */

function pickAnchor(narrativeFacts: NarrativeFacts): { value: number | null; basis: ValuationAnchor } {
  if (narrativeFacts.appraisalValue !== null && narrativeFacts.appraisalValue > 0) {
    return { value: narrativeFacts.appraisalValue, basis: 'appraisal' };
  }
  if (narrativeFacts.asrValue !== null && narrativeFacts.asrValue > 0) {
    return { value: narrativeFacts.asrValue, basis: 'asr' };
  }
  if (narrativeFacts.marketValueFromComps !== null && narrativeFacts.marketValueFromComps > 0) {
    return { value: narrativeFacts.marketValueFromComps, basis: 'market_comps' };
  }
  return { value: null, basis: 'none' };
}

function pickWorstStressNoi(stressOutputs: StressOutputs): number | null {
  const nois = stressOutputs.scenarios
    .map(s => s.noi)
    .filter((n): n is number => n !== null);
  if (nois.length === 0) return null;
  return Math.min(...nois);
}

function minNonNull(...values: readonly (number | null)[]): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return null;
  return Math.min(...nonNull);
}

function isSingleTenantExposure(
  adjustedInputs: AdjustedInputs,
  narrativeFacts: NarrativeFacts,
): boolean {
  if (narrativeFacts.isSingleTenant === true) return true;
  const top1 = adjustedInputs.metrics.top1IncomeShare;
  return top1 !== null && top1 >= SINGLE_TENANT_INCOME_THRESHOLD;
}

/* ---------------------------- main entry ----------------------------- */

export function buildValuationConclusion(args: BuildValuationConclusionArgs): ValuationConclusion {
  const { adjustedInputs, stressOutputs, narrativeFacts } = args;

  /* Step 1: uwValue = NOI / capRate.adjusted (read NOI; do NOT re-derive). */
  const noi = adjustedInputs.metrics.noi;
  const capRate = adjustedInputs.assumptions.capRate.adjusted;
  const uwValue = noi !== null && capRate > 0 ? noi / capRate : null;

  /* Step 2: marketValue from comps (or null). */
  const marketValue = narrativeFacts.marketValueFromComps;

  /* Step 3: downsideValue = worst stress NOI / exit-cap-stressed. */
  const worstStressNoi = pickWorstStressNoi(stressOutputs);
  const exitCapStressed = narrativeFacts.exitCapRateStressed;
  const downsideValue =
    worstStressNoi !== null && exitCapStressed !== null && exitCapStressed > 0
      ? worstStressNoi / exitCapStressed
      : null;

  /* Step 4: anchor + pre-cap finalValue. */
  const anchor = pickAnchor(narrativeFacts);
  const preGuardrailFinal = minNonNull(uwValue, marketValue, downsideValue);

  /* Step 5: Apply §9 guardrails. */
  const capsApplied: ValuationCap[] = [];
  const haircutsApplied: ValuationHaircut[] = [];
  const valuationFlags: DoctrineFlag[] = [];
  let finalValue: number | null = preGuardrailFinal;

  // 5a: OVERVALUATION_GUARDRAIL_TRIGGERED
  if (
    anchor.value !== null &&
    uwValue !== null &&
    uwValue > ANCHOR_TRIGGER_MULTIPLIER * anchor.value
  ) {
    const cap = ANCHOR_CAP_MULTIPLIER * anchor.value;
    if (finalValue === null || finalValue > cap) {
      finalValue = cap;
    }
    capsApplied.push({
      reason: 'OVERVALUATION_GUARDRAIL_TRIGGERED',
      cappedTo: cap,
      basis: anchor.basis,
    });
  }

  // 5b: EXIT_CAP_TOO_TIGHT — advisory flag; no value change
  const exitCapBase = narrativeFacts.exitCapRateBase;
  const appraisalCap = narrativeFacts.appraisalCapRate;
  if (exitCapBase !== null && appraisalCap !== null && exitCapBase < appraisalCap) {
    valuationFlags.push('EXIT_CAP_TOO_TIGHT');
  }

  // 5c: SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED
  if (isSingleTenantExposure(adjustedInputs, narrativeFacts)) {
    if (finalValue !== null) {
      finalValue = finalValue * (1 - DARK_VALUE_HAIRCUT_PCT);
    }
    haircutsApplied.push({
      reason: 'SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED',
      pct: DARK_VALUE_HAIRCUT_PCT,
    });
  }

  /* Step 6: stamp + return. */
  const body = {
    analysisAsOfDate: adjustedInputs.analysisAsOfDate,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
    adjustedInputsId: adjustedInputs.id,
    stressOutputsId: stressOutputs.id,
    narrativeFactsId: narrativeFacts.id,

    uwValue,
    marketValue,
    downsideValue,
    finalValue,

    appraisalValue: narrativeFacts.appraisalValue,
    asrValue: narrativeFacts.asrValue,

    capsApplied,
    haircutsApplied,
    valuationFlags,

    anchorUsed: anchor.basis,
  };

  return { id: computeValuationConclusionId(body), ...body } as ValuationConclusion;
}

/* Used internally + by tests; exported for transparency. */
export const VALUATION_CONSTANTS = {
  SINGLE_TENANT_INCOME_THRESHOLD,
  ANCHOR_TRIGGER_MULTIPLIER,
  ANCHOR_CAP_MULTIPLIER,
  DARK_VALUE_HAIRCUT_PCT,
} as const;
