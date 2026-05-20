/**
 * Per-line-item adjustment helpers — the five patterns from the Batch 3 audit (§6).
 *
 * Each helper takes pre-resolved inputs (raw value, source tier, library/benchmark
 * substitution + floor values) and returns an `AdjustedLineItem`. The orchestrator (3b)
 * resolves source preferences and library lookups upstream; these helpers are pure
 * value-shaping functions.
 *
 * Hard rules enforced:
 *   - `adjusted: number` (never null) — null raw values trigger substitution + an
 *     AdjustmentEntry; if substitution is also null, the helper throws (architecture §8 spirit:
 *     no silent zero-coercion).
 *   - delta = post - pre (positive when raised, negative when lowered, zero when only flagging).
 *   - source defaults to 'MANUAL' when raw was null and a substitution was applied.
 *
 * The helpers accumulate AdjustmentEntries in firing order: substitution first, then library
 * floor, then bank floor, then any wrappers (distrust penalty, manifesto rules — applied
 * downstream by the orchestrator).
 */

import type {
  AdjustedLineItem,
  AdjustmentEntry,
  JudgmentEngineRuleId,
  SourceTier,
} from '@cre/contracts';

/**
 * Pattern 1 — substitute-only.
 *
 * If raw is non-null: use raw, no adjustments.
 * If raw is null and substitutionValue is provided: substitute, emit substitution AdjustmentEntry.
 * If raw is null and substitutionValue is null: throw (no silent zero-coercion).
 */
export function adjustSubstituteOnly(args: {
  readonly raw: number | null;
  readonly extractionSource: SourceTier;
  readonly substitutionValue: number | null;
  readonly substitutionRuleId: JudgmentEngineRuleId;
  readonly substitutionReason: string;
  readonly insufficientDataMessage: string;
}): AdjustedLineItem {
  if (args.raw !== null) {
    return {
      raw: args.raw,
      adjusted: args.raw,
      source: args.extractionSource,
      adjustments: [],
    };
  }
  if (args.substitutionValue === null) {
    throw new Error(args.insufficientDataMessage);
  }
  return {
    raw: null,
    adjusted: args.substitutionValue,
    source: 'MANUAL',
    adjustments: [
      {
        ruleId: args.substitutionRuleId,
        delta: args.substitutionValue,
        reason: args.substitutionReason,
      },
    ],
  };
}

/**
 * Pattern 2 — substitute, then raise to max(library floor, bank floor).
 *
 * Used for vacancyPct + expense ratio (architecture §6 conservatism normalization).
 *
 * Order:
 *   1. Substitute if raw is null (Pattern 1 logic).
 *   2. If adjusted < max(libraryFloor, bankFloor): raise to floor + emit floor-rule AdjustmentEntry.
 *   3. Floor rule fired = whichever floor (library or bank) was higher.
 *
 * Either floor can be null (data unavailable). If both are null, no normalization fires
 * (raw or substitution stands).
 */
export function adjustWithFloor(args: {
  readonly raw: number | null;
  readonly extractionSource: SourceTier;
  readonly substitutionValue: number | null;
  readonly substitutionRuleId: JudgmentEngineRuleId;
  readonly substitutionReason: string;
  readonly insufficientDataMessage: string;
  readonly libraryFloor: number | null;
  readonly libraryFloorRuleId: JudgmentEngineRuleId;
  readonly libraryFloorReason: string;
  readonly bankFloor: number | null;
  readonly bankFloorRuleId: JudgmentEngineRuleId;
  readonly bankFloorReason: string;
}): AdjustedLineItem {
  const initial = adjustSubstituteOnly({
    raw: args.raw,
    extractionSource: args.extractionSource,
    substitutionValue: args.substitutionValue,
    substitutionRuleId: args.substitutionRuleId,
    substitutionReason: args.substitutionReason,
    insufficientDataMessage: args.insufficientDataMessage,
  });

  const lib = args.libraryFloor;
  const bank = args.bankFloor;
  if (lib === null && bank === null) {
    return initial;
  }
  const libVal = lib ?? -Infinity;
  const bankVal = bank ?? -Infinity;
  const floor = Math.max(libVal, bankVal);
  if (initial.adjusted >= floor) {
    return initial;
  }

  const useLib = libVal >= bankVal;
  const ruleId = useLib ? args.libraryFloorRuleId : args.bankFloorRuleId;
  const reason = useLib ? args.libraryFloorReason : args.bankFloorReason;
  const delta = floor - initial.adjusted;

  return {
    raw: initial.raw,
    adjusted: floor,
    source: initial.source,
    adjustments: [
      ...initial.adjustments,
      { ruleId, delta, reason },
    ],
  };
}

/**
 * Pattern 4 — derived line item.
 *
 * `raw` (if present) is the value extracted from a document (e.g., T-12 totalIncome).
 * `adjusted` is the value computed from other already-adjusted line items.
 * No adjustments fire on the derived item itself; provenance traces through the source
 * line items' ledgers.
 *
 * Source = the extraction's tier when raw is present; 'MANUAL' otherwise (the value was
 * computed, not read from a doc).
 */
export function buildDerivedLineItem(args: {
  readonly rawFromExtraction: number | null;
  readonly extractionSource: SourceTier;
  readonly computedAdjusted: number;
}): AdjustedLineItem {
  return {
    raw: args.rawFromExtraction,
    adjusted: args.computedAdjusted,
    source: args.rawFromExtraction !== null ? args.extractionSource : 'MANUAL',
    adjustments: [],
  };
}

/**
 * Pattern 5 — not applicable.
 *
 * For line items that don't apply to the asset profile or loan structure (e.g.,
 * `concessionsPct` for office, `ioPeriodMonths` for fully-amortizing loans). raw=null is
 * NOT a missing-data condition; adjusted=0 is the correct value, no penalty.
 *
 * Distinct from Pattern 1's null path which substitutes from the library + emits a penalty.
 * The orchestrator must call `buildNotApplicableLineItem` only for items that genuinely
 * don't apply; using it as a null-substitute backdoor violates architecture §8.
 */
export function buildNotApplicableLineItem(): AdjustedLineItem {
  return {
    raw: null,
    adjusted: 0,
    source: 'MANUAL',
    adjustments: [],
  };
}

/**
 * Pattern 3 (canonical) — `requireRaw`.
 *
 * For line items that have NO library/benchmark substitution path (e.g., loan amount, term
 * months). If raw is null, throws with the supplied message — no silent zero-coercion. If
 * raw is present, returns it as-is with the given extraction source. No adjustments fire.
 *
 * Distinct from `adjustSubstituteOnly` with `substitutionValue: null`: this helper does not
 * require a placeholder substitution rule id, making call sites cleaner.
 */
export function requireRaw(args: {
  readonly raw: number | null;
  readonly extractionSource: SourceTier;
  readonly insufficientDataMessage: string;
}): AdjustedLineItem {
  if (args.raw === null) {
    throw new Error(args.insufficientDataMessage);
  }
  return {
    raw: args.raw,
    adjusted: args.raw,
    source: args.extractionSource,
    adjustments: [],
  };
}

/**
 * Distrust-penalty wrapper.
 *
 * Appends a distrust AdjustmentEntry (delta=0) to an existing AdjustedLineItem. The penalty
 * indicates that a lower-tier source was chosen despite a higher tier being available
 * (architecture §1). The line item's value is unchanged; the penalty is informational and
 * is summed by the engine into `confidenceReduction`.
 *
 * Idempotent: applying the same distrust rule twice produces only one entry. (The
 * orchestrator should never call this twice with the same ruleId, but the helper is robust.)
 */
export function withDistrustPenalty(
  item: AdjustedLineItem,
  args: {
    readonly distrustRuleId:
      | 'JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS'
      | 'JE_ASR_USED_WHEN_PRIMARY_EXISTS';
    readonly reason: string;
  },
): AdjustedLineItem {
  if (item.adjustments.some(a => a.ruleId === args.distrustRuleId)) {
    return item;
  }
  const entry: AdjustmentEntry = {
    ruleId: args.distrustRuleId,
    delta: 0,
    reason: args.reason,
  };
  return {
    raw: item.raw,
    adjusted: item.adjusted,
    source: item.source,
    adjustments: [...item.adjustments, entry],
  };
}
