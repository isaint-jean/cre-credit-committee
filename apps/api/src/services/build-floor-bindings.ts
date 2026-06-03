/**
 * Floor-binding disclosure builder (Phase B, populated-workbook initiative).
 *
 * When an AdjustedInputs line item is raised by a library or bank floor
 * rule (e.g. `JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN`,
 * `JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN`,
 * `JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY`,
 * `JE_NOI_CAPPED_TO_BANK` / `JE_*_FLOOR`), downstream consumers — including
 * the populated workbook's Conclusions tab — must be able to see that the
 * value was floor-driven rather than source-derived. This builder walks the
 * adjustments ledger and surfaces those bindings on
 * `RenderConservatismStatus.floorBindings`.
 *
 * Hard rules (architecture):
 *   - Pure function over `AdjustedInputs`. No I/O. No clock. No randomness.
 *   - Deterministic: same input → byte-equal output (order, content, types).
 *   - Conservative regex over `ruleId` — the rule id catalogue is the single
 *     source of truth for "is this a floor binding?".
 *
 * The render layer's `AdjustedInputs` shape (`@cre/shared`) exposes a single
 * flat `adjustments: AdjustmentEntry[]` ledger; each entry has `ruleId`,
 * `field`, `before`, `after`, `reason`, `source`. The line-item field is
 * read from `entry.field`, the dollar delta is `after - (before ?? 0)`.
 *
 * NOTE on the contract shape: an internal pipeline build of `AdjustedInputs`
 * (in `@cre/contracts`) splits the ledger into per-`AdjustedLineItem`
 * `adjustments[]` arrays plus a cross-cutting `topLevelAdjustments` array.
 * The render layer's flat ledger is the projection target of both — this
 * builder reads the flat ledger only, which is what the schema layer sees.
 * When the producer migrates to the richer shape in a future bump, this
 * builder grows additional iteration without changing its signature.
 */
import type { AdjustedInputs, FloorBinding } from '@cre/shared';

/**
 * Regex matching every judgment-engine floor / library-substitution /
 * floor-cap rule id. Conservative — case-insensitive, anchored at the
 * common JE_* prefix. The catalogue (per the architecture brief):
 *
 *   JE_*_RAISED_TO_LIBRARY_*    — library-median floor lifts (vacancy, expense, …)
 *   JE_*_RAISED_TO_BANK_*       — bank-observed floor lifts
 *   JE_*_SUBSTITUTED_FROM_LIBRARY — library-derived substitution
 *   JE_*_FLOOR                  — explicit floor-clamp rules
 *   JE_*_CAPPED_TO_BANK         — bank-ceiling caps (conservatism direction
 *                                 NOI ceiling fired as floor-equivalent)
 *
 * If a future rule id introduces a new floor pattern, extend this regex
 * AND add a test case in test-floor-binding-disclosure.ts.
 */
const FLOOR_RULE_PATTERN =
  /^JE_.*(?:_RAISED_TO_(?:LIBRARY|BANK)|_SUBSTITUTED_FROM_LIBRARY|_FLOOR|_CAPPED_TO_BANK)/i;

/**
 * Return `true` iff the given rule id signals that the line item was
 * raised / substituted by a floor (library or bank). Exported for tests
 * and for callers that need the same predicate elsewhere.
 */
export function isFloorBindingRuleId(ruleId: string | undefined | null): boolean {
  if (!ruleId) return false;
  return FLOOR_RULE_PATTERN.test(ruleId);
}

/**
 * Build the `floorBindings` array for `RenderConservatismStatus`. Pure
 * over `AdjustedInputs.adjustments`. Order is the source-ledger order
 * (deterministic — the ledger is append-only). Entries without a `field`
 * are skipped — a floor binding without a target line item has no
 * meaning on the Conclusions tab.
 */
export function buildFloorBindings(adjustedInputs: AdjustedInputs): FloorBinding[] {
  const out: FloorBinding[] = [];
  for (const e of adjustedInputs.adjustments) {
    if (!isFloorBindingRuleId(e.ruleId)) continue;
    if (!e.field) continue;
    const delta = e.after - (e.before ?? 0);
    out.push({
      lineItem: e.field,
      ruleId: e.ruleId,
      delta,
      reason: e.reason,
    });
  }
  return out;
}
