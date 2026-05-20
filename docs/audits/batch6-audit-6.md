# Batch 6 Audit 6 — Implicit Fallback Inventory

**Date:** 2026-05-08
**Goal:** Locate implicit fallback patterns (`??`, `||`, ternaries, `.filter(Boolean)`, default args, empty-array substitution, numeric clamps) that may encode silent underwriting policy in convenience code rather than via a named producer rule with an explicit reason code.
**Doctrine reference:** `docs/architecture/batch6-record-graph-and-resolution.md` §6.6 (Audit 6) and §3.2 R3 (expanded "no UW logic" definition).

## Methodology

1. **Initial scan** with `ripgrep` for `\?\?`, ` \|\| `, `\.filter\(Boolean\)`, `Math\.(min|max)\(0`, `Math\.(min|max)\(`, default-parameter syntax, and ternaries on numeric callsites — across `apps/api/src/services/` and `apps/api/src/routes/`.
2. **Per-file reading** of every priority module. Hit lines were read in surrounding context (±10 lines) before classification — never classified from the hit line alone.
3. **Skipped** per scope: `node_modules/`, `dist/`, `build/`, `.next/`, `.data/`, `apps/web/` (Audit 3), test files, `apps/api/src/scripts/`.
4. **Triage** also skipped trivial `?? ''` for label/sentinel display and `?? []` for pure-iteration safety in resolver narrative paths (R4-aligned: null fidelity → sentinel display in render, not policy).
5. **Classification rules:**
   - **safe** — label / formatting / display sentinel / domain-bounded clamp documented as physical bound; no UW judgment.
   - **needs-review** — a fallback whose policy implication is plausible but bounded or already partially mitigated by an upstream guard; reviewer judgment needed.
   - **unsafe / policy** — silently encodes a credit / underwriting decision (numeric coercion, fallback precedence, semantic sort, severity ordering, implicit "treat-missing-as-zero" or "treat-missing-as-no-stress") without a named rule + explicit reason code in the audit trail.

## Summary by file (top offenders)

| File | safe | needs-review | unsafe / policy |
|---|---:|---:|---:|
| `services/analysis-to-adjusted-inputs.adapter.ts` | 0 | 1 | 4 |
| `services/judgment/line-item-builders.ts` | 14 | 5 | 6 |
| `services/cross-check.service.ts` | 2 | 1 | 3 |
| `services/cross-check-contracts.service.ts` | 1 | 1 | 1 |
| `services/judgment/apply-judgment-adjustments.ts` | 4 | 1 | 1 |
| `services/judgment/applicability.ts` | 2 | 1 | 1 |
| `services/stress-test-contracts.service.ts` | 3 | 1 | 2 |
| `services/judgment/verify-conservatism.ts` | 1 | 2 | 0 |
| `services/judgment/line-item-helpers.ts` | 3 | 2 | 0 |
| `services/judgment/confidence-reduction.ts` | 1 | 1 | 0 |
| `services/doctrine/build-doctrine-evaluation.ts` | 2 | 4 | 0 |
| `services/doctrine/components.ts` | 22 | 1 | 0 |
| `services/doctrine/asset-type-adjusters.ts` | 9 | 0 | 0 |
| `services/underwriting-observability.service.ts` | 4 | 1 | 0 |
| `services/migration-readiness.service.ts` | 4 | 0 | 0 |
| `services/data-extraction.service.ts` | 14 | 2 | 0 |
| `services/valuation.service.ts` | 5 | 0 | 0 |
| `services/stress-test.service.ts` | 0 | 0 | 0 |
| `services/resolve-underwriting-context.ts` | 21 | 0 | 0 |
| `services/resolve-structural-variant.ts` | 0 | 0 | 0 |
| `services/hydrate-underwriting-context.ts` | 11 | 1 | 0 |
| `services/render.service.ts` | 1 | 0 | 0 |
| `services/render-schema.ts` | 12 | 0 | 0 |
| `services/render-migrations.ts` | 2 | 0 | 0 |
| `services/render-output-scrubber.ts` | 0 | 0 | 0 |
| `routes/render.routes.ts` | 17 | 0 | 0 |
| `services/template-engine.service.ts` | 16 | 0 | 0 |
| `services/template-registry.ts` | 0 | 0 | 0 |
| `services/manifesto.service.ts` | 9 | 1 | 0 |
| `services/judgment/manifesto-evaluator.ts` | 0 | 1 | 0 |
| `services/judgment/source-cascade.ts` | 0 | 0 | 0 |
| `services/judgment/library-lookup.ts` | 0 | 0 | 0 |
| `services/judgment/noi-cap.ts` | 0 | 0 | 0 |
| `services/field-authority.resolver.ts` | 25 | 1 | 0 |
| `services/field-authority.audit.ts` | 1 | 0 | 0 |
| `services/field-authority.registry.ts` | 0 | 0 | 0 |
| `services/field-authority.types.ts` | 0 | 0 | 0 |
| `services/field-migration-state.ts` | 1 | 0 | 0 |

## Summary by classification

| Classification | Count |
|---|---:|
| safe | ~204 |
| needs-review | 27 |
| unsafe / policy | 18 |

(Counts are approximate — many "safe" sites are nullable-string display defaults that recur dozens of times in a single file. The complete enumeration of unsafe and needs-review entries follows.)

## Unsafe / policy findings (priority for remediation)

### U1 — Adapter: missing UW line item silently becomes adjusted=0

- **File:line:** `apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts:33-49`
- **Pattern:** default-shaped object on `!li` + `Number.isFinite ? : 0` ternaries on numeric line-item fields
- **Code excerpt:**
  ```ts
  function lineItemToAdjusted(li: LineItem | undefined | null): AdjustedLineItem {
    if (!li) {
      return { raw: null, adjusted: 0, delta: 0, source: 'missing-data-penalty' };
    }
    const raw = Number.isFinite(li.originalValue) ? li.originalValue : null;
    const adjusted = Number.isFinite(li.annualAmount) ? li.annualAmount : 0;
    const delta = adjusted - (raw ?? 0);
    ...
  }
  ```
- **Why this is policy, not display:** `adjusted: 0` is not a sentinel — it directly feeds NOI / DSCR / value. Treating "missing line item" as zero income or zero expense is a UW judgment (zero income → lower NOI; zero expense → higher NOI). The string `'missing-data-penalty'` is informational provenance, but the *number* 0 silently propagates into all downstream metrics. Should emit a named `JE_LINE_ITEM_MISSING` reason that the cross-check / doctrine layers can score.
- **Recommended remediation:** Producer-side. Either propagate `null` end-to-end (matching the contract-shape `AdjustedLineItem.adjusted: number` type — likely needs to become `number | null`), or emit a `JE_*_MISSING` rule in `adjustments[]` when `li` is null. Block use of the adapter until `applyJudgmentAdjustments` is the primary producer. This file is marked TEMPORARY but is currently the live shim — cannot land Batch 6 with this in-place.

### U2 — Adapter: silent loan-detail precedence and 0/0-assumption defaults

- **File:line:** `apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts:88-99`
- **Pattern:** chained `??` (precedence cascade between two storage surfaces) + `?? 0` + `?? 'fixed'`
- **Code excerpt:**
  ```ts
  const ld = model.loanDetails;
  const rawRate = ld?.interestRate ?? model.interestRate;
  return {
    loanAmount: ld?.loanAmount ?? model.loanAmount,
    interestRate: normalizeRateToDecimal(rawRate),
    rateType: ld?.rateType ?? 'fixed',
    amortizationMonths: ld?.amortizationMonths ?? model.amortizationYears * 12,
    termMonths: ld?.termMonths ?? model.termYears * 12,
    ioMonths: ld?.ioMonths ?? 0,
  };
  ```
- **Why this is policy, not display:** Three policy decisions hidden in `??`:
  1. Loan-detail surface is preferred over model surface (precedence cascade — should be a declared rule).
  2. Missing `rateType` is silently assumed `'fixed'` (a credit assumption — affects stress).
  3. Missing `ioMonths` is silently 0 (a structural assumption — affects amortization).
- **Recommended remediation:** Lift to an explicit `loan-resolution.adapter.ts` with named rules `LOAN_FIELD_FROM_DETAILS`, `LOAN_RATE_TYPE_DEFAULTED_FIXED`, `LOAN_IO_MONTHS_DEFAULTED_ZERO`. Surface in `adjustments[]` so doctrine scoring can dock confidence.

### U3 — Adapter: `confidenceReduction: 0` baked in

- **File:line:** `apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts:124`
- **Pattern:** literal default
- **Code excerpt:**
  ```ts
  // Legacy uwModel does not carry an adjustment ledger — return empty.
  // The judgment engine will populate this once it lands.
  adjustments: [],
  confidenceReduction: 0,
  ```
- **Why this is policy, not display:** `confidenceReduction: 0` declares "we have full confidence" downstream — a UW lie when the legacy uwModel never quantified missing-doc penalties. Doctrine reads this and the data_confidence component scores 100 by default.
- **Recommended remediation:** Block. When the adapter is used (legacy path), return `confidenceReduction: null` and have doctrine emit `INSUFFICIENT_DATA` for the `data_confidence` component when the field is null. Better: stop using the adapter — strict-dispatch (§5.1) means legacy ids should not flow into the new schema or doctrine at all.

### U4 — Builder: cross-check sort with `?? 3` flag-rank fallback

- **File:line:** `apps/api/src/services/cross-check.service.ts:152`
- **Pattern:** semantic sort with `??` numeric fallback
- **Code excerpt:**
  ```ts
  const flagOrder: Record<AdjustmentFlag, number> = { material: 0, moderate: 1, minor: 2 };
  findings.sort((a, b) => (flagOrder[a.flag] ?? 3) - (flagOrder[b.flag] ?? 3));
  ```
- **Why this is policy, not display:** Sorting by severity is a *meaning-bearing* order (R3 forbids in resolver; here it lives in cross-check, a producer, where domain ordering is acceptable). What is policy is the `?? 3` — any unmapped flag ranks last silently. `AdjustmentFlag` is a closed literal union; the fallback is dead code that could mask a future rename. Sorting itself bakes severity policy that consumers (doctrine, render) cannot override.
- **Recommended remediation:** Replace fallback with exhaustiveness check (`assertNever(flag)`). Move sort responsibility to consumer (doctrine / render) or document that "ordered by severity desc" is a contract surface — and make it part of the type, not implicit.

### U5 — Cross-check: null variance silently classified `'minor'`

- **File:line:** `apps/api/src/services/cross-check.service.ts:163-168`
- **Pattern:** null coercion to outcome literal
- **Code excerpt:**
  ```ts
  export function computeAdjustmentFlag(absPctVariance: number | null): AdjustmentFlag {
    if (absPctVariance === null) return 'minor';
    if (absPctVariance <= MINOR_THRESHOLD) return 'minor';
    if (absPctVariance <= MODERATE_THRESHOLD) return 'moderate';
    return 'material';
  }
  ```
- **Why this is policy, not display:** `'minor'` is a UW judgment ("not a material concern"); applying it when variance is unmeasurable says "we couldn't compare, therefore it's fine." It should be `'INSUFFICIENT_DATA'` (or a fourth flag), not silently equated with "small variance."
- **Recommended remediation:** Extend `AdjustmentFlag` with `'unmeasurable'` or emit `'INSUFFICIENT_DATA'` reason; never collapse null→minor. Mirror the explicit-skip pattern from `stress-test.service.ts`.

### U6 — Cross-check: null variance scores zero weight in bias

- **File:line:** `apps/api/src/services/cross-check.service.ts:185` and `apps/api/src/services/cross-check-contracts.service.ts:134`
- **Pattern:** `||` on numeric (legacy) and `??` on numeric (contract-shape)
- **Code excerpt:**
  ```ts
  // legacy
  const weight = Math.abs(f.percentVariance || 0);
  // contract
  const w = Math.abs(f.delta.vsBankPct ?? 0);
  ```
- **Why this is policy, not display:** Treating an unmeasurable finding as zero-weight in the conservative-vs-aggressive bias scorer means a deal with several unmeasurable metrics may roll up `'neutral'` when it deserves `'INSUFFICIENT_DATA'`. The `'neutral'` verdict directly feeds `RenderConservatismStatus.approved` (route line 77). Silent risk-washing.
- **Recommended remediation:** Skip null-variance findings explicitly *and* add a `unmeasurableCount` field to the bias result; if any threshold is breached, downgrade verdict to `'INSUFFICIENT_DATA'`. Mirror `stress-test.service.ts` SKIP semantics.

### U7 — Builder: rent-roll defaults of `?? 0` per unit

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:281-282` (and similar at `services/judgment/apply-judgment-adjustments.ts:132`)
- **Pattern:** `?? 0` on individual unit fields inside a sum
- **Code excerpt:**
  ```ts
  const totalConc = args.extraction.rentRoll!.units.reduce<number>((a, u) => a + (u.concessions ?? 0), 0);
  const totalRent = args.extraction.rentRoll!.units.reduce<number>((a, u) => a + (u.inPlaceRentMonthly ?? 0), 0);
  ```
- **Why this is policy, not display:** When per-unit `concessions` or `inPlaceRentMonthly` is null, the row is silently treated as "$0 rent / $0 concession." For top-tenant share (`computeTop1IncomeShare`), missing rent rows hide tenant concentration. For concessionsPct, missing rows under-state concession exposure.
- **Recommended remediation:** Skip null rows explicitly and emit `JE_RENT_ROLL_UNIT_INCOMPLETE` reasons with row count + ID list; let doctrine downgrade `data_confidence` accordingly. The `nulls-as-zero` arithmetic makes the rent-roll silently more favorable than reality.

### U8 — Builder: vacancy + concession loss factor clamped to [0,1]

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:309` (mirrored in `services/stress-test-contracts.service.ts:224`)
- **Pattern:** `Math.max(0, Math.min(1, ...))` on a sum-of-rates
- **Code excerpt:**
  ```ts
  const lossFactor = Math.max(0, Math.min(1, args.vacancyPct.adjusted + args.concessionsPct.adjusted));
  ```
- **Why this is policy, not display:** When the inputs are extreme (e.g., manifesto bumps vacancy to 0.95 + concessions 0.10 = 1.05), the engine silently caps at 1.0 (effectively floors NOI loss at 100%, which is a hard policy ceiling on vacancy stress). Either is silently masking degraded inputs (sum > 1 means broken assumption) or quietly defending against a real stress condition.
- **Recommended remediation:** Throw `JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE` when sum > 1; emit a flag and let doctrine adjudicate. Distinguishing *"upstream produced an impossible composite"* from *"100% loss is a real outcome"* requires a named rule.

### U9 — Builder: hardcoded MANUAL defaults without reason emission

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:178-188` (otherIncome=0), `605-616` (rentGrowthPct=0.03), `621-629` (expenseGrowthPct=0.03), `483-496` (monthlyCapex=0.20%/12)
- **Pattern:** literal numeric default, `source: 'MANUAL'`, empty `adjustments: []`
- **Code excerpt:**
  ```ts
  // otherIncome
  if (raw === null) {
    return { raw: null, adjusted: 0, source: 'MANUAL', adjustments: [] };
  }
  // expense growth
  return { raw: null, adjusted: 0.03, source: 'MANUAL', adjustments: [] };
  // monthly capex
  const monthly = args.effectiveGrossIncome.adjusted * 0.002 / 12;
  return { raw: null, adjusted: monthly, source: 'MANUAL', adjustments: [] };
  ```
- **Why this is policy, not display:** These values are baked-in policy: 0% other income (conservative income haircut), 3% rent / expense growth assumption, 20bps annual capex reserve. The empty `adjustments[]` means doctrine cannot see that the value was synthesized — `data_confidence` cannot dock these. The numbers themselves are fine for v1.0 defaults; the *invisibility* is the violation.
- **Recommended remediation:** Emit a `JE_*_DEFAULT_USED` rule for each; treat it as a confidence-reduction signal. The `source: 'MANUAL'` is informational provenance; `adjustments[]` is the contract for "what happened." Mismatch.

### U10 — Builder: terminal cap rate cascade collapses provenance

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:586-598`
- **Pattern:** ternary fallback with shared substitutionRuleId
- **Code excerpt:**
  ```ts
  const libraryMedian = getLibraryMedian(...);
  const substitutionValue = libraryMedian !== null ? libraryMedian + 0.005 : args.capRate.adjusted + 0.005;
  return adjustSubstituteOnly({
    raw: null,
    extractionSource: 'MANUAL',
    substitutionValue,
    substitutionRuleId: 'JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY',  // same id regardless of branch
    ...
  });
  ```
- **Why this is policy, not display:** Two distinct fallbacks (library + 50bps vs. spot-cap + 50bps) emit the *same* rule id. Audit-tab cannot distinguish the two paths. The case "no library AND we used spot-cap-derived" is a weaker fallback that should score worse for `data_confidence`.
- **Recommended remediation:** Two rule ids — `JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD` vs. `JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD`. The reason string difference is hidden from machine consumers.

### U11 — Builder: vacancy substitution path collapses library vs. benchmark

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:65-89` (vacancyPct), `106-122` (capRate)
- **Pattern:** chained `??` between library and benchmark, single substitutionRuleId
- **Code excerpt:**
  ```ts
  const libraryMedian = getLibraryMedian(...);
  const benchmarkVacancy = args.marketBenchmarks.vacancyRates[args.assetProfile.propertyType];
  const substitutionValue = libraryMedian ?? benchmarkVacancy;
  return adjustWithFloor({
    ...
    substitutionRuleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',  // even when benchmark fired
    substitutionReason: `... library/benchmark median (${substitutionValue ?? 'unavailable'})`,
  });
  ```
- **Why this is policy, not display:** Single rule id for two distinct sources (library when `n ≥ 20`; market benchmark when `n < 20`). `migration-readiness` and audit cannot differentiate "library-backed substitution" from "n<20 degraded benchmark." Doctrine's data confidence cannot weight the two.
- **Recommended remediation:** Two rule ids per metric: `JE_*_SUBSTITUTED_FROM_LIBRARY` and `JE_*_SUBSTITUTED_FROM_MARKET_BENCHMARK`. Update `JE_MISSING_DOC_PENALTIES` to include benchmark-degraded weights.

### U12 — Builder: `getLibraryMedian(...) ?? 0` for floor in expense ratio

- **File:line:** `apps/api/src/services/judgment/line-item-builders.ts:436-440`
- **Pattern:** `?? 0` on numeric used in `Math.max` floor selection
- **Code excerpt:**
  ```ts
  const libRatio = getLibraryMedian(args.librarySnapshot, args.assetProfile.propertyType, 'expenseRatio') ?? 0;
  const bankEgi = t12?.income.totalIncome ?? null;
  const bankOpex = t12?.expenses.totalOperatingExpenses ?? null;
  const bankRatio = bankEgi !== null && bankOpex !== null && bankEgi > 0 ? bankOpex / bankEgi : 0;
  const floor = Math.max(libRatio, bankRatio) * egi;
  ```
- **Why this is policy, not display:** When library is degraded (`n<20` → null) AND T-12 is missing, the floor silently collapses to 0 — i.e., **no conservatism floor enforced at all**. Verify-conservatism then doesn't see a violation because there's no expected floor. This is the exact pattern §3.2 R3 calls out under "fallback precedence" + "null coercion" combined: silently degrading the conservatism gate when both surfaces are missing.
- **Recommended remediation:** Either throw `JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE` (block conservatism gate verdict) or emit an explicit `INSUFFICIENT_FLOOR_DATA` reason that doctrine reads as a hard `data_confidence` strike. Same pattern duplicated in `verify-conservatism.ts:42, 61` (see needs-review NR4).

### U13 — Stress: missing interest rate silently → no rate stress

- **File:line:** `apps/api/src/services/stress-test-contracts.service.ts:230-239`
- **Pattern:** early-return identity when `currentRate <= 0` (covers missing/zero)
- **Code excerpt:**
  ```ts
  function stressedDebtService(ai: AdjustedInputs, interestRateDelta: number): number | null {
    const currentRate = ai.loan.interestRate.adjusted;
    if (currentRate <= 0) return ai.loan.debtServiceAnnual.adjusted;  // returns unstressed
    ...
  }
  ```
- **Why this is policy, not display:** Returning the unstressed `debtServiceAnnual` when `currentRate <= 0` silently turns "no rate data" into "rate stress is a no-op." The stress scenario produces a falsely-passing DSCR. Should emit `STRESS_INTEREST_RATE_SKIP` and `skipped: ['DSCR']` (per `finalizeScenario` skip conventions), not silently pass.
- **Recommended remediation:** Return `null` for the stressed debtService; let `finalizeScenario` route into the existing skip path. Mirror the legacy `stress-test.service.ts` pattern (lines 33–49) which has a clean SKIP-vs-fail discipline.

### U14 — Stress: missing tenant rank silently zeroed in tenant removal

- **File:line:** `apps/api/src/services/stress-test-contracts.service.ts:189-192`
- **Pattern:** ternary on numeric inside a reducer
- **Code excerpt:**
  ```ts
  const removedShare = spec.removeRanks.reduce((sum, rank) => {
    const tenant = topTenantShares.find(t => t.rank === rank);
    return tenant ? sum + tenant.incomeShare : sum;
  }, 0);
  ```
- **Why this is policy, not display:** When a rank is absent from `topTenantShares` (e.g., the rent roll has only 2 tenants but the scenario removes T3), the contribution is silently zero. The scenario then claims "remove top 3" but actually removes only the tenants present, understating stress severity.
- **Recommended remediation:** If a requested rank is missing, emit `STRESS_TENANT_RANK_NOT_AVAILABLE` and skip the scenario rather than under-stress it. Or assert that `topTenantShares.length >= max(removeRanks)` upstream.

### U15 — Applicability: rolloverWithinTermFraction silently 0 on missing data

- **File:line:** `apps/api/src/services/judgment/applicability.ts:23-49`
- **Pattern:** early `return 0` on missing rent-roll OR missing termMonths OR zero-total-rent
- **Code excerpt:**
  ```ts
  function rolloverWithinTermFraction(extraction, termMonths): number {
    if (extraction.rentRoll === null || termMonths === null) return 0;
    if (termMonths <= 0) return 0;
    ...
    return totalAnnualRent > 0 ? expiringAnnualRent / totalAnnualRent : 0;
  }
  ```
- **Why this is policy, not display:** This drives `upfrontTiLcApplies` / `monthlyTiLcApplies`. Returning 0 means "TI/LC is NOT applicable." Therefore: missing rent roll (the most common reason for a degraded deal) silently downgrades TI/LC to NOT-APPLICABLE, producing `adjusted=0` reserves with NO penalty (`buildNotApplicableLineItem` per architecture §8 spirit). Effectively: missing rent roll → no TI/LC reserve required → potentially passing a deal that should be flagged.
- **Recommended remediation:** Distinguish "applicable but unmeasurable" from "not applicable." Make applicability return `boolean | 'INSUFFICIENT_DATA'` and route the third case to a `JE_TILC_APPLICABILITY_UNKNOWN` reason that doctrine penalizes.

### U16 — Adapter: `delta = adjusted - (raw ?? 0)` zeroing missing raw

- **File:line:** `apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts:42`
- **Pattern:** `?? 0` on numeric inside a delta computation
- **Code excerpt:** (see U1 excerpt)
  ```ts
  const delta = adjusted - (raw ?? 0);
  ```
- **Why this is policy, not display:** When raw is unknown, `delta` reports "we adjusted X by adjusted-0 = adjusted." This is the same line-item that downstream consumers will read as "the bank had 0 here and we changed it to adjusted." That is a UW assertion the adapter should not make.
- **Recommended remediation:** `delta` should be `null` when `raw` is null. Update the type to `number | null` (matches contract-shape).

### U17 — Cross-check-contracts: NEUTRAL conservatism on null comparison

- **File:line:** `apps/api/src/services/cross-check-contracts.service.ts:114`
- **Pattern:** null coercion to enum literal
- **Code excerpt:**
  ```ts
  function computeConservatismStatus(bank, bp, conservativeDirection): ConservatismStatus {
    if (bank === null || bp === null) return 'NEUTRAL';
    ...
  }
  ```
- **Why this is policy, not display:** `'NEUTRAL'` is a meaningful business outcome ("we compared and found no skew"). When one side is null, the comparison did not happen. Mapping null→NEUTRAL mis-attributes "no comparison" as "no skew." This bubbles up via `computeOverallBias` and into the route's `RenderConservatismStatus`.
- **Recommended remediation:** Add `'INSUFFICIENT_DATA'` variant to `ConservatismStatus`; downgrade `overallAdjustmentBias` to `'INSUFFICIENT_DATA'` if any finding has unmeasurable status. Surface in render badges.

### U18 — Apply-judgment: top-1 income share zero-rents-as-zero

- **File:line:** `apps/api/src/services/judgment/apply-judgment-adjustments.ts:132-136`
- **Pattern:** `?? 0` per unit + `Math.max(...annual)`
- **Code excerpt:**
  ```ts
  function computeTop1IncomeShare(extraction: ExtractionResult, gri: number): number | null {
    if (extraction.rentRoll === null || gri <= 0) return null;
    const annual = extraction.rentRoll.units.map(u => (u.inPlaceRentMonthly ?? 0) * 12);
    if (annual.length === 0) return null;
    const max = Math.max(...annual);
    return max > 0 ? max / gri : null;
  }
  ```
- **Why this is policy, not display:** Tenant concentration is the input to a doctrine adjuster. Missing per-unit rent silently zeroes that unit's contribution to the max — under-stating concentration. A single missing-rent row on the largest tenant fully breaks this metric, and the consumer cannot tell.
- **Recommended remediation:** Skip-with-flag if any unit has null `inPlaceRentMonthly`; emit `RENT_ROLL_INCOMPLETE_FOR_CONCENTRATION` reason + null result; let doctrine `tenant_concentration` rule fire `INSUFFICIENT_DATA` rather than score from an under-stated max.

## Needs-review findings

### NR1 — Doctrine anchor cascade duplicates valuation pickAnchor

- **File:line:** `apps/api/src/services/doctrine/build-doctrine-evaluation.ts:96`
- **Pattern:** `??` precedence cascade
- **Why review:** `valuationConclusion.appraisalValue ?? valuationConclusion.asrValue` mirrors `valuation.service.ts::pickAnchor`. Two sources of truth for "which anchor wins" — possible drift over time. Either delegate to a shared helper or read `valuationConclusion.anchorUsed` (the resolved choice already on the record).

### NR2 — Doctrine implicit "High Risk" default rating

- **File:line:** `apps/api/src/services/doctrine/build-doctrine-evaluation.ts:157-162`
- **Pattern:** implicit-default `return 'High Risk'` after band loop
- **Why review:** If `RATING_BANDS` doesn't cover a clamped finalScore (theoretically impossible since `Math.max(0, Math.min(100, ...))` precedes it), the function silently returns the worst rating. A bug in band definitions would silently push everything to High Risk. Should `assertNever` or throw `RATING_BAND_GAP`.

### NR3 — Doctrine mechanical aggregate returns 0 for empty inputs

- **File:line:** `apps/api/src/services/doctrine/build-doctrine-evaluation.ts:168`
- **Pattern:** early-return `0` on empty filter
- **Why review:** Empty mechanical-component list produces `mechanicalScore = 0` (worst), feeding `evaluateFalseNegativeGuard` which treats it as `mechWeak: true` (line 90). Empty list should be an upstream contract violation, not a silent zero. Throw or emit `DOCTRINE_MECHANICAL_INPUT_MISSING`.

### NR4 — Conservatism gate: `?? 0` on missing floor data

- **File:line:** `apps/api/src/services/judgment/verify-conservatism.ts:42, 61`
- **Pattern:** `?? 0` on library/bank floor candidates feeding `Math.max`
- **Why review:** Same pattern as U12 but in the gate itself. The `if (expectedVacancyFloor > 0 && ...)` short-circuits the both-null case (no floor enforced — already a policy). When only one source is null, the other is used unilaterally, which is correct. But the silent both-null case skipping the gate means the gate's enforcement depends on data availability, not on the conservatism rule itself. Should at minimum emit a `CONSERVATISM_GATE_NO_FLOOR_DATA` reason.

### NR5 — adjustWithFloor tie-break favors library

- **File:line:** `apps/api/src/services/judgment/line-item-helpers.ts:111-118`
- **Pattern:** tie-break ternary `useLib = libVal >= bankVal`
- **Why review:** When library median equals bank ratio, library wins attribution. Implicit policy choice — defensible (library is the "conservative" baseline) but undocumented. Add a comment or constant `TIE_BREAK_PREFERS_LIBRARY = true`.

### NR6 — Judgment confidence-reduction silently 0 on unknown rule id

- **File:line:** `apps/api/src/services/judgment/confidence-reduction.ts:39`
- **Pattern:** `return 0` for rules not in `MISSING_DOC_KEYS` ∪ `DISTRUST_KEYS`
- **Why review:** Documented in comment ("rules outside the missing-doc / distrust categories don't reduce confidence directly"). But a typo in a future rule id silently contributes nothing. `JudgmentEngineRuleId` is a literal union, so a typo is a compile error — currently safe, but easy to break.

### NR7 — Stress: vacancy+concession clamped to [0,1]

- **File:line:** `apps/api/src/services/stress-test-contracts.service.ts:224`
- **Pattern:** `Math.max(0, Math.min(1, ...))` (mirror of U8 in stress path)
- **Why review:** Same shape as U8 but inside stress engine. Whether to escalate to U-class depends on whether the doctrine differentiates between U8 and NR7 — recommended to treat both uniformly.

### NR8 — Cross-check `metricKeywords[metric] || [metric.toLowerCase()]`

- **File:line:** `apps/api/src/services/cross-check.service.ts:226`
- **Pattern:** `||` array fallback for keyword lookup
- **Why review:** Used only for narrative commentary keyword matching. Shape-only, but in narrative context where missing keyword could cause a missed `relevantRule` annotation. Low-stakes.

### NR9 — Observability: source defaults to `'adjustedInputs'` when schema lookup misses

- **File:line:** `apps/api/src/services/underwriting-observability.service.ts:236-238`
- **Pattern:** ternary on Set membership
- **Code excerpt:**
  ```ts
  const source: SourceSurface = sources && sources.size > 0
    ? ([...sources][0])
    : 'adjustedInputs';
  ```
- **Why review:** Observability inflates `adjustedInputsHits` when render-schema doesn't declare a source for an address. `legacyDependencyRatio` is therefore biased toward "still legacy" which delays migration verdicts. Migration-readiness should rely on schema completeness instead. Mark cells without declared source as `'unknown'` and surface separately.

### NR10 — Doctrine PCA score: same reasonCode for two outcomes

- **File:line:** `apps/api/src/services/doctrine/components.ts:234-239`
- **Pattern:** two if-branches share `PCA_REPAIRS_NOT_QUANTIFIED`
- **Code excerpt:**
  ```ts
  if (immediate === null) return { rawValue: null, score: 60, reasonCodes: [PCA_REPAIRS_NOT_QUANTIFIED] };
  if (immediate <= 0)     return { rawValue: 0,    score: 90, reasonCodes: [PCA_REPAIRS_NOT_QUANTIFIED] };
  ```
- **Why review:** Score 60 vs 90 with the same reasonCode means the audit trail can't distinguish "PCA missing" (60) from "PCA reports zero immediate repairs" (90). Add a `PCA_NO_IMMEDIATE_REPAIRS` reasonCode for the second branch.

### NR11 — Hydrator: explicit precedence cascade for termMonths

- **File:line:** `apps/api/src/services/hydrate-underwriting-context.ts:142-145`
- **Pattern:** `pickFirstFiniteNumber([...])` two-source cascade
- **Why review:** Doctrine §6.6 lists "fallback precedence" as forbidden in the resolver. The hydrator is a different layer, but the *expanded* R3 spirit ("no UW logic") asks: is "extraction first, then adjustedInputs" a UW judgment? Comment says yes (per migration policy). The cascade is named (`pickFirstFiniteNumber`), so attribution is technically possible — but no event is emitted. Recommend: emit `HYDRATION_FALLBACK_USED` for telemetry; otherwise the cascade ages without observability.

### NR12 — Resolver: `?? null` on optional atomic block accessors

- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:438-457`
- **Pattern:** `ctx.property?.X ?? null` per atom
- **Why review:** R4 says null fidelity in the resolver. `?? null` is no-op when the optional block is undefined — pure shape. *Safe.* Listed for completeness because the pattern looks like null coercion.

### NR13 — manifesto-evaluator: silent skip on unknown metric path

- **File:line:** `apps/api/src/services/judgment/manifesto-evaluator.ts:160-163`
- **Pattern:** early-return without event
- **Why review:** Comment says "prevents typos in user-uploaded manifestos from crashing the pipeline." Reasonable, but a user-uploaded manifesto with a typo silently no-ops the rule. Consider emitting `MANIFESTO_UNKNOWN_METRIC` to a manifesto validation report.

### NR14 — Field-authority sort fallback `?? ''`

- **File:line:** `apps/api/src/services/field-authority.resolver.ts:379`
- **Pattern:** `?? ''` in `localeCompare` sort comparator
- **Why review:** Sort comparator used for entity collection rows. `?? ''` for string-typed sort keys is shape-default (collation), but if `sortKey.field` references a numeric column carrying nulls, the fallback to `''` would produce silently broken ordering. Add a contract assertion that sort keys point to non-null string columns.

### NR15-17 — minor cross-check + manifesto formatting fallbacks

- `cross-check.service.ts:165` (`return 'minor'` for unmeasurable — see U5; secondary instance flagged for the contract path).
- `manifesto.service.ts:171-177` (`||` defaults on `parsed.rules`, `parsed.assetTypesCovered`) — string-shape defaults from external JSON; safe but worth schema-validating.
- `data-extraction.service.ts:170, 309, 582` (`numericValue === 0` skip) — silent skip when extracted value parses to 0. Could miss legitimate zero values (rare but possible). Considered lower-priority because most CRE financial fields with a literal 0 are bad data.

### NR18-21 — additional needs-review (brief)

- `data-extraction.service.ts:874-887` — domain range checks could be policy (cap rate > 30%, IR > 25%); currently only emit issues, not fail. Documented as advisory — safe.
- `cross-check-contracts.service.ts:114` (overlap with U17 — listed in unsafe).
- `stress-test-contracts.service.ts:80-83` — TENANT_REMOVAL → DEFAULT fallback when no rent roll. Documented; surfaces via `skipped` flags on scenarios. Safe.
- `migration-readiness.service.ts:130, 154` — `?? []` default registry / `Math.max(slice.length, 1)` to avoid div-by-zero in stability bucketing; both shape-only.

## Safe findings

High-level summary (counts approximate; not exhaustively listed because many recur):

- **Resolver** (`resolve-underwriting-context.ts`) — 21 `?? DATA_NOT_PROVIDED` / `?? null` sentinel projections. All R4-aligned (null fidelity → display sentinel). Correct.
- **Render-schema / render-migrations / render.service / render-output-scrubber** — 15+ `??`/`||` across these. Every one is a contract-version default, missing-cell guard, or string display fallback. No numeric coercion that could change UW.
- **Render routes** — 17 `??`/`||` across query-param parsing, response-shape building, and findings array null-fallback. Validation-oriented.
- **Template-engine** — 16 occurrences. Sheet-cell display, value-map building, range string formatting. Pure presentation.
- **Field-authority resolver** — 25 `??` across the file. The notable ones (`?? null` for valuationContext, `?? primary.document` for provenance attribution) are pure-shape defaults inside a registry that *already* declares its fallbacks explicitly per FieldRef. The registry's design is "no implicit fallback at runtime — fallbacks are declared types," which is the correct pattern.
- **Field-authority audit / registry / types / migration-state** — defensive shape lookups; no policy.
- **Doctrine components** (`components.ts`) — 22 explicit null-guards (`if (x === null) return INSUFFICIENT_DATA_SCORE`). Exemplary: every degraded-data path returns the `INSUFFICIENT_DATA_SCORE = 0` constant *with a `INSUFFICIENT_DATA` reason code attached*. This is the correct pattern (named producer rule + explicit reason).
- **Asset-type adjusters** — 9 explicit null-guards skip rule on missing data; never silently default. Exemplary.
- **Stress-test (legacy)** — 0 occurrences in the audit-relevant pattern; explicit SKIP semantics for null inputs.
- **Valuation** — 5 occurrences; all are anchor-priority cascades inside the named `pickAnchor` helper, null-skipping `pickWorstStressNoi`, and null-filtering `minNonNull`. Correct.
- **Hydrator** — 11 `?? null` for atomic-block fields where the underlying data is optional; pure shape pass-through.
- **Confidence-reduction** — `Math.max(0, Math.min(1, sum / 100))` documented as forward-compat saturation. Safe.

## Recommendations

### Must-remediate-before-Batch-6 (priority)

1. **U1, U2, U3, U16** — `analysis-to-adjusted-inputs.adapter.ts`. The whole file is a TEMPORARY shim but it is the live path for legacy ids. Strict-dispatch (§5.1, locked) implies legacy ids should not flow into the new resolver / hydrator / doctrine. Before Batch 6, **either** delete the file's reach into the new spine (route legacy ids strictly to legacy services) **or** rewrite it as an explicit-rule producer that emits `JE_LEGACY_LINE_ITEM_MISSING`, `LOAN_RATE_TYPE_DEFAULTED_FIXED`, etc. The current state silently injects 0-defaults and `confidenceReduction: 0` into doctrine.

2. **U5, U6, U17** — Cross-check null-variance handling. Add an `'INSUFFICIENT_DATA'` flag/conservatismStatus variant; route through to `RenderConservatismStatus`. The current `'minor'` / `'NEUTRAL'` / weight-zero behaviors silently risk-wash deals.

3. **U13, U14, NR7** — Stress engine SKIP discipline. Mirror the legacy stress service's strict SKIP semantics on the contract path. Today the contract path silently passes scenarios that should skip.

4. **U15** — Applicability: introduce `boolean | 'INSUFFICIENT_DATA'` for TI/LC and capex applicability. The current "no rent roll → not applicable → adjusted=0 with no penalty" path is the most credit-impactful silent fallback in the codebase.

5. **U7, U18** — Rent-roll per-unit `?? 0` skipping. Replace with explicit row-skip + `JE_RENT_ROLL_UNIT_INCOMPLETE` emissions.

6. **U9** — Hardcoded MANUAL defaults (otherIncome=0, rent/expense growth=3%, monthly capex=0.20%). Emit named `JE_*_DEFAULT_USED` rules; let doctrine see them.

7. **U10, U11** — Disambiguate library-vs-benchmark-vs-spot rule ids in substitutions.

8. **U12, NR4** — Conservatism gate must surface "no floor data" as a doctrine-visible event, not silently skip enforcement.

### Defer-and-track (acceptable as-is for Batch 6, track for follow-up)

- **NR1, NR2, NR3** — Doctrine band/anchor/aggregate edge cases. Possible-impossible today; harden by Batch 7.
- **NR5, NR6, NR8** — Tie-break / unknown-rule / metricKeywords. Documentary fixes (comments + typed assertions).
- **NR9** — Observability `'adjustedInputs'` default. Affects `legacyDependencyRatio` interpretation; address when migration verdicts begin to land.
- **NR10** — PCA reasonCode disambiguation. Adds a single new `DoctrineReasonCode`.
- **NR11** — Hydrator termMonths cascade. Explicit but un-audited; add observability.
- **NR12, NR13, NR14** — Resolver/manifesto/sort minor patterns. Documentation + assertion-only.

### Codebase-wide hygiene proposals

1. **Lint rule: ban `?? 0` on `number | null` record fields.** A custom ESLint rule (or `no-restricted-syntax` + AST query) that flags `??` whose RHS is a number literal and whose LHS is typed `number | null` (heuristic: type-info via `@typescript-eslint`). Allow only after explicit `// eslint-disable-line uw-policy/no-numeric-null-coercion` with a justification comment. Mirrors the resolver's import-graph guardrail (§3.2) for the policy-vs-shape boundary.

2. **Lint rule: ban `||` for default values on numeric or `null|undefined` types.** Same shape; covers the legacy `|| 0` pattern.

3. **Lint rule: ban `Math.max(0, …)` and `Math.min(1, …)` outside an allowlist.** Allowlist: confidence-reduction, vacancy clamping in stress-engine — all required to carry an inline `// uw-policy: bounded-by-domain` justification. Anything outside emits a lint error.

4. **Producer-rule emission gate.** Wherever a substitution / default / fallback fires, it must append to `adjustments[]` (or equivalent doctrine reason channel). Add a runtime assertion in dev: `AdjustedLineItem` with `source: 'MANUAL'` and `raw: null` AND `adjustments.length === 0` is a contract violation (likely paired with a fixture-rich CI check).

5. **Observability source attribution: distinguish "schema-undeclared" from "adjustedInputs."** Threefold split: `resolvedContext` / `adjustedInputs` / `unknown`. Migration-readiness uses only the explicitly-declared sources.

6. **Conservatism gate: emit "no floor data" reasons.** When `verifyConservatism` short-circuits because both `libraryVacancy` and `bankVacancy` are null, emit `CONSERVATISM_FLOOR_UNAVAILABLE` to surface in `dataQualityFlags`.

7. **`adjustments[]` audit assertion.** A boot-time check: every `JudgmentEngineRuleId` in `JE_*_PENALTIES` must be referenced by at least one builder OR by a downstream consumer (`computeConfidenceReduction`). Catches dead rule IDs and orphan emissions.

8. **Type sharpening: `AdjustedLineItem.adjusted: number | null`.** Currently `number`, forcing 0-coercion at the producer boundary. Allowing `null` makes the policy-vs-no-data distinction representable. The render layer already routes null→sentinel.
