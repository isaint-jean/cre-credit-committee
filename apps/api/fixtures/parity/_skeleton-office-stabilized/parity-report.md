# _skeleton-office-stabilized parity report

> **Status:** Skeleton placeholder. Demonstrates the classification format. NOT a real
> fixture; the `extraction-result.json` / `expected-rendered.json` / `expected-legacy.json`
> snapshots are not present yet. Real fixtures are added incrementally per
> `docs/legacy-reduction-plan.md` §8.5.

**Asset class:** Office
**Scenario:** Stabilized (n≥20 library data, full T-12, complete rent roll)
**Source analysisAsOfDate:** 2026-05-08T00:00:00Z

## Classifications

| Field | Legacy | Rendered | Tag | Notes |
|---|---|---|:---:|---|
| summary.ratingBand | "Acceptable" | "Acceptable" | `match` | |
| summary.finalScore | 62 | 62 | `match` | doctrine evaluation deterministic across spines for clean inputs |
| metrics.dscr | 1.34 | 1.34 | `match` | |
| metrics.ltv | 0.65 | 0.65 | `match` | |
| metrics.debtYield | 0.115 | 0.115 | `match` | |
| metrics.noi | 7670000 | 7670000 | `match` | |
| valuation.finalValue | 116461538 | 116461538 | `match` | |
| valuation.anchorUsed | "appraisal" | "appraisal" | `match` | |
| doctrine.mechanicalScore | 65 | 65 | `match` | |
| doctrine.weightedAggregate | 62 | 62 | `match` | |
| doctrine.components (per-category breakdown) | (table of 7 components) | (table of 7 components) | `match` | Shipped at render version 6.8 as D09 first additive parity expansion. Bijective passthrough of `DoctrineEvaluation.componentScores[]`: name, ruleId, rawValue, score, weight, contribution, reasonCodes. |
| doctrine.flags | ["TENANT_CONCENTRATION_HIGH"] | ["TENANT_CONCENTRATION_HIGH"] | `match` | |
| dataQuality.flags | (silent) | ["JE_T12_PRESENT_OK"] | `intentional-modernization` | Legacy implicitly trusted T-12 without surfacing data-quality state. New spine emits explicit data-quality flags (architecture §8). |
| executiveSummary | "This Office property in primary market..." (free text) | absent | `migration-gap` (sub: out-of-spine) | Was AI-generated; new-spine narrative producer is undecided. See legacy-reduction-plan.md §7 Phase 2 #8. |
| findings (list of {ruleId, reasonCode}) | [...N entries...] | (top-level `findings[]`, N RenderedFinding entries) | `match` | Shipped at render version 7.2 as D04 — final Phase-1 expansion. Bijective passthrough of `DoctrineEvaluation.reasons[]`. Each finding is exactly `{ruleId, reasonCode}`; ordering preserved exactly; counts preserved exactly. **Note on legacy "severity":** the doctrine layer does not emit per-finding severity (architecture: doctrine reasons are bounded labels, not graded warnings). Render does NOT synthesize severity. If severity is needed, it is a producer-spine architectural decision, not a render decision. |
| crossCheckFindings | [{metric: noi, bias: minor, ...}, ...] | (empty) | `migration-gap` (sub: producer-pending) | Phase 2 #6 — cross-check producer signature mismatch (see batch6-implementation-plan.md §6.4 Open decisions). |
| mitigationStrategies | [{strategy: ..., expectedImpact: ...}] | absent | `migration-gap` (sub: out-of-spine) | Was AI-generated. Decision pending. |
| researchResults.sponsor | (4 paragraphs from external search) | absent | `migration-gap` (sub: out-of-spine) | External integration; not part of deterministic spine. |
| researchResults.market | (3 paragraphs) | absent | `migration-gap` (sub: out-of-spine) | Same. |
| researchResults.news | (2 articles) | absent | `migration-gap` (sub: out-of-spine) | Same. |
| criteriaEvaluations | [...8 manifesto rule outcomes...] | absent | `missing-render-field` | Manifesto evaluations exist on `AdjustedInputs.topLevelAdjustments`; not projected. |
| creditScore.components (per-category) | (same data as doctrine.components) | (table of 7 components) | `match` | Same projection as `doctrine.components`; legacy displayed under "Credit Score" tab, new spine surfaces under "Component Breakdown" section. |
| creditScore.narrative | "The deal exhibits..." (free text) | absent | `migration-gap` (sub: out-of-spine) | Same as executiveSummary; narrative producer pending. |
| creditScore.improvementSuggestions | ["Increase reserves...", ...] | absent | `migration-gap` (sub: out-of-spine) | AI-generated; sunset candidate. |
| bPieceDecision.verdict | "Pass with conditions" | absent | `migration-gap` (sub: out-of-spine) | Sunset candidate per §7 Phase 5. |
| bPieceDecision.dealBreakers | [] | absent | `migration-gap` (sub: out-of-spine) | Same. |
| bPieceDecision.conditions | [...4...] | absent | `migration-gap` (sub: out-of-spine) | Same. |
| bPieceDecision.pricingGuidance | "200-225bp over..." | absent | `migration-gap` (sub: out-of-spine) | Same. |
| uwModel.income.* (line items with raw/adjusted) | (table of 5 lines) | (table of 5 lines, in `incomeLines[]`) | `match` | Shipped at render version 6.9 as D16. Bijective passthrough of `AdjustedInputs.income.*`: per-line `name`, `raw`, `adjusted`, `source`, `adjustments[]` ledger. |
| uwModel.expenses.* (line items) | (table of 8 lines) | (table of 8 lines, in `expenseLines[]`) | `match` | Shipped at render version 6.9 as D17. Same projection as D16, against `AdjustedInputs.expenses.*`. |
| uwModel.metrics row | (dscr/ltv/dy/noi) | metrics.* | `match` | already covered. |
| uwModel.repaymentSchedule | (table of 120 entries) | absent | `migration-gap` (sub: producer-pending) | Amortization schedule producer pending in new spine. |
| uwModel.stressScenarios | (4 named scenarios) | (named-field `stress` section: method + RenderedStressScenario[]) | `match` | Shipped at render version 7.1 as D20. Bijective passthrough of `StressOutputs.method` + `StressOutputs.scenarios[]`. Each scenario has 5 metric cells (noi/dscr/value/ltv/debtYield) + breaches[] + skipped[] (both as RenderBadge[]). Render does not recompute breach outcomes. |
| loanDetails.* | (loanAmount/interestRate/termMonths/amortizationMonths/ioPeriodMonths/maturityBalance/debtServiceAnnual) | (named-field `loan` section, 7 RenderedLineItems) | `match` | Shipped at render version 7.0 as D21. Bijective passthrough of `AdjustedInputs.loan.*`. Each field is a `RenderedLineItem` (raw/adjusted/source/adjustments). Render does NOT recompute `debtServiceAnnual` or `maturityBalance` — both are producer-emitted by the judgment-engine line-item builders. |
| timeline | (acquisition / closing / refinance dates) | absent | `migration-gap` (sub: producer-pending) | Producer-side surface for timeline data; designation pending. |
| comments | (3 user comments) | absent | `migration-gap` (sub: deferred-write-side) | Phase 4. Editable rendered semantics deferred. |
| version | "1.0" | metadata.renderVersion = "6.7" | `intentional-modernization` | Different concepts — legacy `version` was a manual stamp; `renderVersion` is a deterministic engine-pin per architecture H6. |

## Summary

| Tag | Count |
|---|---:|
| `match` | 18 |
| `intentional-modernization` | 2 |
| `legacy-bug` | 0 |
| `missing-render-field` | 0 |
| `migration-gap` (producer-pending) | 3 |
| `migration-gap` (out-of-spine) | 8 |
| `migration-gap` (deferred-write-side) | 1 |
| **Total fields classified** | **32** |

> **Updated render version 7.2 (post-D04 fifth and final Phase-1 additive parity expansion):**
> the `findings[]` projection moved 1 row from `missing-render-field` to `match`. Bijective
> passthrough of `DoctrineEvaluation.reasons[]` (each entry is `{ruleId, reasonCode}`);
> ordering and counts preserved exactly; render synthesizes nothing. **Phase-1 complete:
> the structural display surface of `RenderedAnalysis` is now substantially feature-parity
> with the legacy dashboard's display capabilities.** All `missing-render-field` rows have
> been resolved. Remaining open rows are `migration-gap` (producer-pending or out-of-spine
> or deferred-write-side) and the 2 `intentional-modernization` divergences.
>
> **Updated render version 7.1 (post-D20 fourth additive parity expansion):** the `stress`
> section (named-field struct: `method` + `scenarios[]`) moved 1 row from
> `missing-render-field` to `match`. Each scenario carries 5 metric cells + breaches/skipped
> badge arrays projected from `StressOutputs.scenarios[]`; render does not recompute
> breach outcomes. Phase-1 #4 shipped.
>
> **Updated render version 7.0 (post-D21 third additive parity expansion):** the `loan`
> section (named-field struct mirroring `AdjustedInputs.loan`) moved 1 row from
> `missing-render-field` to `match`. Each loan field is a `RenderedLineItem` carrying
> producer-emitted values; render does not recompute payment constants or amortization.
> Phase-1 #3 shipped.
>
> **Updated render version 6.9 (post-D16/D17 second additive parity expansion):**
> `incomeLines[]` and `expenseLines[]` projections moved 2 more rows from
> `missing-render-field` to `match` (UW model income/expense line items, projecting
> from `AdjustedInputs.income.*` / `AdjustedInputs.expenses.*` with `name` / `raw` /
> `adjusted` / `source` / `adjustments[]` ledger). High-value Phase-1 migration
> targets D16 + D17 shipped.
>
> **Updated render version 6.8 (post-D09 first additive parity expansion):** the
> `doctrine.components` projection moved 2 rows from `missing-render-field` to `match`
> (per-category breakdown × 2 entry points: legacy "Score" tab `creditScore.components`
> and legacy "Score" tab `componentScores` table - both now project from
> `DoctrineEvaluation.componentScores[]`). High-value Phase-1 migration target shipped.

## Unclassified fields

None.

## Notes

This is a SKELETON. Numbers in the legacy column are illustrative; not from a real
captured legacy analysis. When a real fixture is added, the `extraction-result.json`,
`expected-rendered.json`, and `expected-legacy.json` snapshots become required, and the
field-by-field tags must reflect actual observed values.
