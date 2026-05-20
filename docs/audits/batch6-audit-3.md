# Batch 6 Audit 3 — Web Client UnderwritingContext Contract

**Date:** 2026-05-08
**Targets:** `apps/web/src/app/analysis/[id]/page.tsx` + downstream consumers
**Goal:** Capture the REAL shape of the analysis-API response that the web client consumes today. This is the de-facto `UnderwritingContext` contract that must be preserved across the legacy/new pipeline cutover (strict dispatch — doctrine §5.1).
**Doctrine reference:** `docs/architecture/batch6-record-graph-and-resolution.md` §5.2 B2 (API contract continuity), §6.3 (Audit 3).

---

## Files inspected

- `apps/web/src/app/analysis/[id]/page.tsx` — the analysis dashboard. Single-file React client (1526 lines) — owns rendering of summary, findings, cross-check, mitigations, research, score, criteria, B-piece decision, comments, and the bottom-panel UW model (income / expenses / metrics / loan schedule / stress test). All sub-components (`FindingCard`, `CrossCheckRow`, `CriteriaCard`, `UWTable`, `MetricRow`, `EditableCell`, `LoanSchedulePanel`, `LoanTermInput`) are defined inline in this file — no outside component imports.
- `apps/web/src/lib/api-client.ts` — flat `fetch` wrapper over the API. Every analysis call (`getAnalysis`, `updateUWModel`, `updateLoanTerms`, `runStressTest`, `addComment`, `exportUnderwriting`, `getPopulatedTemplateInfo`, `downloadPopulatedTemplate`) returns `Promise<any>`. **No response typing** — the `Analysis` shape contract is enforced only by what the page reads.
- `apps/web/src/lib/format.ts` — pure formatting helpers. `formatDecimalPercent`, `formatMultipleSafe`, `formatCurrencyFullSafe` all treat `null` / `undefined` as `"N/A"`. Decimal-storage convention: percent fields are stored as fraction (0.75 = 75%) and multiplied by 100 only on render.
- `packages/shared/src/types/index.ts` — barrel export of all `@cre/shared` types.
- `packages/shared/src/types/analysis.ts` — defines `Analysis`, `Finding`, `CreditScore`, `CrossCheckFinding`, `MitigationStrategy`, `Comment`, `BPieceDecision`, `ResearchResult`, `ResearchResults`, `CriteriaEvaluation`, `StressScenario`, `ValidationResult`, `ExtractionResult`, `PreValidationGateResult`, `SellerExtractedMetrics`, `AdjustmentBias`, plus enum types (`AssetType`, `Severity`, `Recommendation`).
- `packages/shared/src/types/underwriting.ts` — defines `UnderwritingModel`, `IncomeSection`, `ExpenseSection`, `LineItem`, `LoanDetails`, `RepaymentSchedule`, `RepaymentScheduleEntry`. Imported by page for `UnderwritingModel` + `RepaymentScheduleEntry` types.
- `packages/shared/src/types/criteria.ts` — defines `CriteriaRule`, `CriteriaRuleSet`, manifesto types. Page only consumes `CriteriaEvaluation` (which is in `analysis.ts`, not here).
- `packages/shared/src/types/uw-intelligence.ts` — historical-UW / market-intelligence / template-management types. **Not consumed by the analysis page** — used by other web routes.
- `packages/shared/src/types/underwriting-context.ts` — the *target* shape (narrative contract for v6+ render). **Not yet imported by the analysis page.** This is the type the new spine will emit; the page today still consumes the legacy `Analysis` flat-bag shape.

---

## Consumed-field matrix

Every field path the analysis page reads from the API response. `analysis.*` is the `Analysis` returned by `api.getAnalysis(id).analysis`.

| Field path | Read at (file:line) | Nullability assumed | Mode dependence | Classification | Notes |
|---|---|---|---|---|---|
| `analysis.id` | page.tsx:165, 178, 193 | required | none | contractual | Used as deal id for export / template download. |
| `analysis.name` | page.tsx:115, 153, 167, 180 | required string | none | contractual | Heading + filename interpolation. |
| `analysis.assetType` | page.tsx:154, 166, 179 | required, `.toUpperCase()` called | none | contractual | Used as `assetClass` param to render API. |
| `analysis.status` | page.tsx:42, 110, 129, 160, 273 | required, narrowed | none | contractual | Drives loading/processing/error/complete branches. |
| `analysis.progress` | page.tsx:120, 123 | required number | none | contractual | Progress bar interpolation. |
| `analysis.currentStep` | page.tsx:116 | required string | none | contractual | Status display. |
| `analysis.error` | page.tsx:133 | optional string | none | contractual | Rendered raw under error status. |
| `analysis.executiveSummary` | page.tsx:263, 266 | nullable (`?`-truthiness) | none | contractual | Free-text block. |
| `analysis.inputHash` | page.tsx:279 | optional (`?.substring`) | none | contractual | First 12 chars displayed; falls back to `'N/A'`. |
| `analysis.manifestoVersion` | page.tsx:283 | optional (`?.substring`) | none | contractual | Same as above. |
| `analysis.modelLogicVersion` | page.tsx:287 | optional (`||`) | none | contractual | Falls back to `'N/A'`. |
| `analysis.validationResult.passed` | page.tsx:291, 292 | optional via `?.` | none | contractual | Boolean toggles label. |
| `analysis.validationResult.checks.length` | page.tsx:292 | non-null when `passed` | none | contractual | Displayed as `(N checks)`. |
| `analysis.findings` | page.tsx:138, 363 | nullable (`|| []`) | none | contractual | Source array; severity-grouped. |
| `analysis.findings[].id` | page.tsx:373, 391, 456 | required | none | contractual | Key + comment join. |
| `analysis.findings[].severity` | page.tsx:139–143, 363 | required (`Severity`) | none | contractual | Filter + grouping + badge. |
| `analysis.findings[].title` | page.tsx:462, 1250 | required | none | contractual | Heading. |
| `analysis.findings[].confidence` | page.tsx:1241–1242, 1257, 1259 | required string union (`if`-checked) | none | contractual | Color band. |
| `analysis.findings[].pageReferences` | page.tsx:1252, 1276 | optional (`?.[0]`, `?.map`) | none | contractual | First-page summary + expanded list. |
| `analysis.findings[].pageReferences[].page` | page.tsx:1254, 1278 | required when ref exists | none | contractual | |
| `analysis.findings[].pageReferences[].sectionTitle` | page.tsx:1254, 1278 | required when ref exists | none | contractual | |
| `analysis.findings[].pageReferences[].excerpt` | page.tsx:1279 | optional (`if (ref.excerpt)`) | none | contractual | |
| `analysis.findings[].explanation` | page.tsx:1272 | required string | none | contractual | Body text. |
| `analysis.findings[].impact.description` | page.tsx:1273–1274 | optional via `?.` | none | contractual | Subordinate text. |
| `analysis.findings[].category` | (typed only) | n/a | none | dead/unused | Type defines `category`; never read by page. |
| `analysis.findings[].appliedRuleId` | (typed only) | n/a | none | dead/unused | Never read. |
| `analysis.findings[].impact.metric` | (typed only) | n/a | none | dead/unused | |
| `analysis.findings[].impact.currentValue` | (typed only) | n/a | none | dead/unused | |
| `analysis.findings[].impact.adjustedValue` | (typed only) | n/a | none | dead/unused | |
| `analysis.creditScore` | page.tsx:145 (`score = ...`) | nullable | none | contractual | Whole-block guard. |
| `analysis.creditScore.overall` | page.tsx:203–208, 305–309, 581–599 | non-null inside `score &&` guard | none | contractual | Score number + colour-banding (multiple thresholds, see derivations). |
| `analysis.creditScore.riskTier` | page.tsx:212–217 | optional (`?.replace`) | none | contractual | Discriminated union: `strong`/`acceptable`/`watchlist`/`high_risk`. |
| `analysis.creditScore.recommendation` | page.tsx:219–225, 318–322 | optional (`?.replace`) | none | contractual | Discriminated union (`approve`, etc.). |
| `analysis.creditScore.categories` | page.tsx:608 | nullable (`|| []`) | none | contractual | Score breakdown array. |
| `analysis.creditScore.categories[].category` | page.tsx:609, 611 | required | none | contractual | Key + label. |
| `analysis.creditScore.categories[].score` | page.tsx:619–625 | required number | none | accidental | Compared to magic thresholds 80/60/40 — see "Frontend-side derivations". |
| `analysis.creditScore.categories[].weight` | page.tsx:613 | required number | none | contractual | Bar denominator. |
| `analysis.creditScore.categories[].weightedScore` | page.tsx:613 | required number | none | contractual | `Math.round(weightedScore)`. |
| `analysis.creditScore.categories[].explanation` | page.tsx:627–629 | optional truthy check | none | contractual | |
| `analysis.creditScore.categories[].maxScore` | (typed only) | n/a | none | dead/unused | Type carries it; page never reads it. |
| `analysis.creditScore.categories[].findings` | (typed only) | n/a | none | dead/unused | Never read by page. |
| `analysis.creditScore.narrative` | page.tsx:636, 639 | optional truthy check | none | contractual | |
| `analysis.creditScore.whyThisScore` | page.tsx:644, 647 | optional truthy check | none | contractual | |
| `analysis.creditScore.howToImprove` | page.tsx:652, 655 | optional truthy check | none | contractual | |
| `analysis.crossCheckFindings` | page.tsx:241, 425, 440 | nullable (`?.length`, `|| []`) | UW-vs-Bank | contractual | Tab is hidden when empty; see Mode-dependence. |
| `analysis.crossCheckFindings[].id` | page.tsx:441 | required | n/a | contractual | |
| `analysis.crossCheckFindings[].metric` | page.tsx:1313 | required | n/a | contractual | |
| `analysis.crossCheckFindings[].sellerBankValue` | page.tsx:1297 | optional (`||` chain w/ `asrValue`) | n/a | accidental | Falls back through legacy alias `asrValue` — fragile dual-name access. |
| `analysis.crossCheckFindings[].asrValue` | page.tsx:1297 | optional alias | n/a | accidental | Marked legacy in type. |
| `analysis.crossCheckFindings[].bpSpiralValue` | page.tsx:1298 | optional (`||` chain w/ `uwValue`) | n/a | accidental | Same dual-name pattern. |
| `analysis.crossCheckFindings[].uwValue` | page.tsx:1298 | optional alias | n/a | accidental | |
| `analysis.crossCheckFindings[].percentVariance` | page.tsx:1299, 1317–1320 | nullable (`!== null && !== undefined`) | n/a | contractual | Sign + 1-decimal display. |
| `analysis.crossCheckFindings[].absoluteVariance` | page.tsx:1322 | optional (`||`) | n/a | accidental | Falls through to `difference` legacy. |
| `analysis.crossCheckFindings[].difference` | page.tsx:1322 | optional alias | n/a | accidental | Marked legacy. |
| `analysis.crossCheckFindings[].flag` | page.tsx:1300, 1303–1308, 1326–1330 | optional (`if`-narrowed) | n/a | contractual | Discriminated `'minor' \| 'moderate' \| 'material'`. Drives badge label. |
| `analysis.crossCheckFindings[].commentary` | page.tsx:1301, 1336 | optional truthy check | n/a | contractual | |
| `analysis.crossCheckFindings[].explanation` | page.tsx:1339 | optional fallback for `commentary` | n/a | accidental | Marked legacy. |
| `analysis.crossCheckFindings[].severity` | page.tsx:1329 | required | n/a | contractual | Used when `flag` is absent. |
| `analysis.crossCheckFindings[].sellerSource.sectionTitle` | page.tsx:1343–1344 | optional (`?.`) | n/a | contractual | |
| `analysis.crossCheckFindings[].sellerSource.page` | page.tsx:1344 | optional (`?`-ternary) | n/a | contractual | |
| `analysis.crossCheckFindings[].asrSource.sectionTitle` | page.tsx:1346–1347 | legacy fallback (`?.`) | n/a | accidental | |
| `analysis.crossCheckFindings[].asrSource.page` | page.tsx:1347 | legacy fallback | n/a | accidental | |
| `analysis.crossCheckFindings[].bpSource` | page.tsx:1349 | optional (`||` to literal) | n/a | contractual | |
| `analysis.crossCheckFindings[].direction` | (typed only) | n/a | n/a | dead/unused | Type defines it; not read. |
| `analysis.crossCheckFindings[].uwSource` | (typed only) | n/a | n/a | dead/unused | Marked legacy in type, never read. |
| `analysis.overallAdjustmentBias` | page.tsx:405–420 | nullable (truthy guard) | UW-vs-Bank | contractual | Discriminated union; drives banner color + commentary string. |
| `analysis.mitigations` | page.tsx:375, 390, 452, 455 | nullable (`|| []`) | none | contractual | |
| `analysis.mitigations[].id` | page.tsx:458 | required | none | contractual | |
| `analysis.mitigations[].findingId` | page.tsx:375, 390, 456 | required | none | contractual | Joined back to findings list. |
| `analysis.mitigations[].strategy` | page.tsx:465 | required string | none | contractual | |
| `analysis.mitigations[].description` | page.tsx:466 | required string | none | contractual | |
| `analysis.mitigations[].structuralChanges` | page.tsx:467–474 | required array (length-checked) | none | contractual | |
| `analysis.mitigations[].financialImpact.targetMetric` | page.tsx:478, 480 | optional truthy check | none | contractual | |
| `analysis.mitigations[].financialImpact.currentValue` | page.tsx:481 | rendered as raw value | none | accidental | Type says `number`; rendered via JSX coercion (no formatter). |
| `analysis.mitigations[].financialImpact.projectedValue` | page.tsx:483 | same | none | accidental | |
| `analysis.mitigations[].financialImpact.improvement` | page.tsx:484 | required string | none | contractual | |
| `analysis.mitigations[].requiredReserve` | page.tsx:487, 488 | optional (`!= null`) | none | contractual | |
| `analysis.mitigations[].requiredEquity` | page.tsx:490, 491 | optional (`!= null`) | none | contractual | |
| `analysis.mitigations[].riskReduction` | page.tsx:496–500 | required (discriminated) | none | contractual | |
| `analysis.research` | page.tsx:512, 521 | nullable (truthy guard) | none | contractual | Whole-block guard. |
| `analysis.research.sponsor[]` | page.tsx:521 | nullable (`|| []`) | none | contractual | Plus `market`, `news`. |
| `analysis.research.market[]` | page.tsx:521 | nullable | none | contractual | |
| `analysis.research.news[]` | page.tsx:521 | nullable | none | contractual | |
| `analysis.research.*[i].title` | page.tsx:540 | required | none | contractual | |
| `analysis.research.*[i].snippet` | page.tsx:541 | required | none | contractual | |
| `analysis.research.*[i].source` | page.tsx:543 | required | none | contractual | |
| `analysis.research.*[i].publishedDate` | page.tsx:544 | optional truthy | none | contractual | |
| `analysis.research.*[i].url` | page.tsx:545 | optional truthy | none | contractual | |
| `analysis.research.*[i].riskSignal` | page.tsx:533–537 | required discriminated | none | contractual | |
| `analysis.criteriaEvaluations` | page.tsx:567, 570 | nullable (`|| []`) | none | contractual | |
| `analysis.criteriaEvaluations[].ruleName` | page.tsx:1368 | required | none | contractual | |
| `analysis.criteriaEvaluations[].result` | page.tsx:1365–1366 | required (`pass`/`fail`/`unknown`) | none | contractual | |
| `analysis.criteriaEvaluations[].reason` | page.tsx:1372 | required | none | contractual | |
| `analysis.criteriaEvaluations[].source` | page.tsx:1373 | optional truthy | none | contractual | |
| `analysis.criteriaEvaluations[].ruleId` | (typed only) | n/a | none | dead/unused | Never displayed. |
| `analysis.bPieceDecision` | page.tsx:246, 661, 665 | nullable (truthy guard) | none | contractual | Whole tab hidden when null. |
| `analysis.bPieceDecision.recommendation` | page.tsx:665–674 | required (discriminated) | none | contractual | |
| `analysis.bPieceDecision.conviction` | page.tsx:677 | required | none | contractual | |
| `analysis.bPieceDecision.summary` | page.tsx:684 | required | none | contractual | |
| `analysis.bPieceDecision.dealBreakers` | page.tsx:688–696 | required array | none | contractual | Length-guarded. |
| `analysis.bPieceDecision.keyConditions` | page.tsx:703–711 | required array | none | contractual | |
| `analysis.bPieceDecision.pricingGuidance` | page.tsx:718–722 | optional truthy | none | contractual | |
| `analysis.comments` | page.tsx:738, 742 | nullable (`|| []`) | none | contractual | |
| `analysis.comments[].id` | page.tsx:743 | required | none | contractual | |
| `analysis.comments[].stance` | page.tsx:746–751 | required (discriminated) | none | contractual | |
| `analysis.comments[].author` | page.tsx:752 | required | none | contractual | |
| `analysis.comments[].createdAt` | page.tsx:754 | required ISO | none | contractual | `new Date().toLocaleDateString()`. |
| `analysis.comments[].text` | page.tsx:757 | required | none | contractual | |
| `analysis.stressScenarios` | page.tsx:44–46 | optional truthy | UW-only | contractual | Hydrated into local `stressResults` state. |
| `analysis.stressScenarios[].name` | page.tsx:926, 951 | required | n/a | contractual | |
| `analysis.stressScenarios[].results.noi` | page.tsx:927 | required (formatted via `formatCurrencyFull`) | n/a | accidental | Type says `number`, but other `results.*` are `number\|null`. Inconsistent contract — see Risks. |
| `analysis.stressScenarios[].results.dscr` | page.tsx:929–930 | nullable (`!== null` guard) | n/a | contractual | |
| `analysis.stressScenarios[].results.ltv` | page.tsx:933–934 | nullable | n/a | contractual | |
| `analysis.stressScenarios[].results.debtYield` | page.tsx:936–937 | nullable | n/a | contractual | |
| `analysis.stressScenarios[].results.impliedValue` | (typed only) | n/a | n/a | dead/unused | Type carries; never displayed. |
| `analysis.stressScenarios[].breaksCovenants` | page.tsx:940–941, 949 | required boolean | n/a | contractual | |
| `analysis.stressScenarios[].covenantBreaches` | page.tsx:952 | required array | n/a | contractual | `.join('; ')`. |
| `analysis.stressScenarios[].adjustments` | (typed only) | n/a | n/a | dead/unused | Page never displays scenario adjustments. |
| `analysis.stressScenarios[].covenantSkips` | (typed only) | n/a | n/a | dead/unused | Designed to surface skipped covenants — page does not render them. **Degraded-state regression risk** (doctrine R8 / B6). |
| `analysis.uwModel` | page.tsx:146, 160, 822 | nullable | UW-only / view-mode | contractual | Whole bottom panel hidden when null. |
| `analysis.uwModel.income.grossPotentialRent` | page.tsx:827 | required `LineItem` | none | contractual | |
| `analysis.uwModel.income.vacancyLoss` | page.tsx:828 | required | none | contractual | |
| `analysis.uwModel.income.concessions` | page.tsx:829 | required | none | contractual | |
| `analysis.uwModel.income.otherIncome` | page.tsx:830 | required | none | contractual | |
| `analysis.uwModel.income.additionalItems` | page.tsx:831 | required array (spread) | none | contractual | |
| `analysis.uwModel.income.effectiveGrossIncome` | page.tsx:832 | required | none | contractual | |
| `analysis.uwModel.expenses.realEstateTaxes` | page.tsx:841 | required | none | contractual | |
| `analysis.uwModel.expenses.insurance` | page.tsx:842 | required | none | contractual | |
| `analysis.uwModel.expenses.utilities` | page.tsx:843 | required | none | contractual | |
| `analysis.uwModel.expenses.repairsAndMaintenance` | page.tsx:844 | required | none | contractual | |
| `analysis.uwModel.expenses.management` | page.tsx:845 | required | none | contractual | |
| `analysis.uwModel.expenses.generalAndAdmin` | page.tsx:846 | required | none | contractual | |
| `analysis.uwModel.expenses.payroll` | page.tsx:847 | required | none | contractual | |
| `analysis.uwModel.expenses.replacementReserves` | page.tsx:848 | required | none | contractual | |
| `analysis.uwModel.expenses.additionalItems` | page.tsx:849 | required array (spread) | none | contractual | |
| `analysis.uwModel.expenses.totalExpenses` | page.tsx:850 | required | none | contractual | |
| `LineItem.id` | page.tsx:1397 | required | none | contractual | Row key. |
| `LineItem.label` | page.tsx:1397–1417 | required, used as **lookup key** for dotted edit paths | none | accidental | Label-string switch maps human label → field path. Severe coupling — see Risks. |
| `LineItem.annualAmount` | page.tsx:1402, 1423–1424 | required number | none | contractual | |
| `LineItem.isEditable` | page.tsx:1400 | required boolean | none | contractual | |
| `LineItem.perUnit` | (typed only) | n/a | none | dead/unused | |
| `LineItem.perSqFt` | (typed only) | n/a | none | dead/unused | |
| `LineItem.percentOfEGI` | (typed only) | n/a | none | dead/unused | |
| `LineItem.isOverridden` | (typed only) | n/a | none | dead/unused | |
| `LineItem.originalValue` | (typed only) | n/a | none | dead/unused | |
| `LineItem.source` | (typed only) | n/a | none | dead/unused | Provenance never surfaced. |
| `analysis.uwModel.netOperatingIncome` | page.tsx:858, 918 | required (`formatCurrencyFull`) | UW/Bank/Adjusted | accidental | Typed `number` but in practice nullable post-Step3; `formatCurrencyFull` will throw on null. |
| `analysis.uwModel.capRate` | page.tsx:860 | required (decimal) | UW/Bank/Adjusted | contractual | Editable. |
| `analysis.uwModel.impliedValue` | page.tsx:861 | nullable (uses `*Safe`) | UW/Bank/Adjusted | contractual | |
| `analysis.uwModel.loanAmount` | page.tsx:863, 883, 1047 | required (`formatCurrencyFull`) | UW/Bank/Adjusted | contractual | Editable. Used in **frontend-derived threshold** (`* 0.9`, `* 0.7`). |
| `analysis.uwModel.interestRate` | page.tsx:865, 1020, 1103 | required (percent units) | UW/Bank/Adjusted | contractual | Editable. |
| `analysis.uwModel.amortizationYears` | page.tsx:868–869 | required (fallback for missing `loanDetails.*`) | UW/Bank/Adjusted | accidental | Used as backup when `loanDetails.amortizationMonths` is missing — duplicate source of truth. |
| `analysis.uwModel.termYears` | page.tsx:868 | required (fallback) | UW/Bank/Adjusted | accidental | Same dual-source issue. |
| `analysis.uwModel.annualDebtService` | page.tsx:870 | nullable (`*Safe`) | UW/Bank/Adjusted | contractual | |
| `analysis.uwModel.dscr` | page.tsx:876, 919, 929 | nullable (explicit `=== null`) | UW/Bank/Adjusted | contractual | Threshold bands hard-coded — see derivations. |
| `analysis.uwModel.ltv` | page.tsx:878, 920, 933 | nullable | UW/Bank/Adjusted | contractual | Hard-coded 0.65 / 0.75 / 0.80 bands. |
| `analysis.uwModel.debtYield` | page.tsx:879, 921, 936 | nullable | UW/Bank/Adjusted | contractual | Hard-coded 0.07 / 0.08 / 0.10 bands. |
| `analysis.uwModel.totalUnits` | (typed only) | n/a | none | dead/unused | |
| `analysis.uwModel.totalSqFt` | (typed only) | n/a | none | dead/unused | |
| `analysis.uwModel.asReported` | (typed only) | n/a | none | dead/unused | Mode flag the page never reads — interesting: doctrine §3.2 R2 says mode is a view selector, but page hard-codes single mode. |
| `analysis.uwModel.modifiedCells` | (typed only) | n/a | none | dead/unused | |
| `analysis.uwModel.loanDetails` | page.tsx:866–872, 979 | optional (`?.`) | none | contractual | |
| `analysis.uwModel.loanDetails.rateType` | page.tsx:866, 1020 | optional (`?.`) | none | contractual | |
| `analysis.uwModel.loanDetails.ioMonths` | page.tsx:867, 996, 1104 | optional (`?.` then `|| 0`) | none | accidental | `\|\| 0` coerces missing → 0 (smell test §3.3). |
| `analysis.uwModel.loanDetails.termMonths` | page.tsx:868, 997, 1105 | optional (`?.` w/ fallback to `termYears * 12`) | none | accidental | Multi-source coercion. |
| `analysis.uwModel.loanDetails.amortizationMonths` | page.tsx:869, 998, 1106 | optional (`?.` w/ fallback) | none | accidental | Same. |
| `analysis.uwModel.loanDetails.prepaymentTerms` | page.tsx:871–872, 1026, 1029 | optional truthy | none | contractual | |
| `analysis.uwModel.loanDetails.paymentFrequency` | page.tsx:1024 | required when `details` exists | none | contractual | |
| `analysis.uwModel.loanDetails.originationDate` | page.tsx:1092 | required when `details` exists | none | contractual | |
| `analysis.uwModel.loanDetails.loanAmount` | (typed only) | n/a | none | dead/unused | Page reads only top-level `uwModel.loanAmount`. |
| `analysis.uwModel.loanDetails.interestRate` | (typed only) | n/a | none | dead/unused | Same. |
| `analysis.uwModel.repaymentSchedule` | page.tsx:880, 978 | nullable | none | contractual | Whole sub-panel guarded. |
| `analysis.uwModel.repaymentSchedule.entries` | page.tsx:985 | nullable (`|| []`) | none | contractual | |
| `RepaymentScheduleEntry.month` | page.tsx:1141, 1144, 1148, 1152, 1153 | required | none | contractual | |
| `RepaymentScheduleEntry.date` | page.tsx:1154 | required | none | contractual | |
| `RepaymentScheduleEntry.isIO` | page.tsx:1152, 1156–1157, 990 | required boolean | none | contractual | |
| `RepaymentScheduleEntry.beginningBalance` | page.tsx:1160 | required | none | contractual | |
| `RepaymentScheduleEntry.scheduledPrincipal` | page.tsx:1161 | required | none | contractual | |
| `RepaymentScheduleEntry.interest` | page.tsx:1162 | required | none | contractual | |
| `RepaymentScheduleEntry.totalPayment` | page.tsx:1163 | required | none | contractual | |
| `RepaymentScheduleEntry.endingBalance` | page.tsx:1164 | required | none | contractual | |
| `RepaymentScheduleEntry.cumulativePrincipal` | page.tsx:1165 | required | none | contractual | |
| `RepaymentScheduleEntry.monthlyDSCR` | page.tsx:1168–1176 | nullable (explicit `=== null`) | none | contractual | Hard-coded 1.15 / 1.25 bands. |
| `analysis.uwModel.repaymentSchedule.summary.totalInterest` | page.tsx:1039 | required | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.totalPrincipal` | page.tsx:1043 | required | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.balloonBalance` | page.tsx:883, 1047, 1048 | required (fed into `* 0.9` derivation) | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.balloonDate` | page.tsx:884, 1094 | required | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.minDSCR` | page.tsx:885, 1054–1063 | nullable | none | contractual | Hard-coded 1.15 / 1.25 bands. |
| `analysis.uwModel.repaymentSchedule.summary.minDSCRMonth` | page.tsx:1066 | nullable | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.ioEndDate` | page.tsx:1093 | required | none | contractual | |
| `analysis.uwModel.repaymentSchedule.summary.totalPayments` | (typed only) | n/a | none | dead/unused | |
| `analysis.uwModel.repaymentSchedule.summary.averageDSCR` | (typed only) | n/a | none | dead/unused | |
| `analysis.sellerMetrics` | (typed only) | n/a | UW-vs-Bank | dead/unused | Optional `SellerExtractedMetrics` defined; never displayed by page. |
| `analysis.extractionResult` | (typed only) | n/a | none | dead/unused | Page does not show extraction-trace. **Doctrine §2.3 forbids ExtractionResult outside Stage 1 / hydration / audit-tab — page is fine since it doesn't read it.** |
| `analysis.preValidationGate` | (typed only) | n/a | none | dead/unused | |
| `analysis.document` | (typed only) | n/a | none | dead/unused | Raw parsed PDF — never rendered. |
| `analysis.uwDocument` | (typed only) | n/a | none | dead/unused | |
| `analysis.supportingDocuments` | (typed only) | n/a | none | dead/unused | |
| `analysis.templateDocument` | (typed only) | n/a | none | dead/unused | |
| `analysis.createdAt` / `analysis.updatedAt` | (typed only) | n/a | none | dead/unused | |
| `populatedTemplateInfo.available` | page.tsx:191 | required | none | contractual | Out-of-band response from `getPopulatedTemplateInfo`. |
| `populatedTemplateInfo.fileName` | page.tsx:193 | optional | none | contractual | |
| `populatedTemplateInfo.mappedFields` / `unmappedFields` / `tabsPopulated` | (typed via local state; not consumed) | n/a | none | dead/unused | Local state shape includes them; page never reads. |

Total fields catalogued: ~140.

**Counts by classification:**

- **contractual** (must survive cutover): ~95
- **accidental** (fragile / dual-source / hidden coercion): ~16
- **dead/unused** (typed but never read by analysis page): ~30

---

## Frontend-side derivations

Computations that arguably belong upstream (in producers / resolver / render output) rather than in React.

| File:line | Computation | What it encodes | Recommended destination |
|---|---|---|---|
| page.tsx:202–207, 304–309, 581–599 | `score.overall >= 85 ? 'strong' : >= 70 ? 'acceptable' : >= 50 ? 'watchlist' : 'high_risk'` | Score → tier band thresholds (85/70/50). | These thresholds duplicate `score.riskTier` (already on the API response). Page should use `score.riskTier` directly. **The page even computes the colour from `overall` rather than reading `riskTier` for colour selection** — silent disagreement risk. |
| page.tsx:619–625 | `cat.score >= 80 ? 'strong' : >= 60 : 40 ...` | Category-level tier band 80/60/40 — different thresholds than overall. | Push `tier` onto each category server-side, or document the thresholds as a render-contract constant. Currently invented in the page. |
| page.tsx:876 | `uw.dscr < 1.25 ? 'danger' : uw.dscr < 1.5 ? 'warning' : 'safe'` | DSCR band thresholds 1.25 / 1.50. | **Policy: lift to producer.** These are credit-policy thresholds, not display formatting. Reason code should flow through as `dataQualityFlags` / band classification on the metric. |
| page.tsx:878 | `uw.ltv > 0.75 ? 'danger' : uw.ltv > 0.65 ? 'warning' : 'safe'` | LTV bands 0.65 / 0.75. | Same — policy thresholds. Lift to producer. |
| page.tsx:879 | `uw.debtYield < 0.08 ? 'danger' : uw.debtYield < 0.10 ? 'warning' : 'safe'` | Debt-yield bands 0.08 / 0.10. | Same. |
| page.tsx:883 | `summary.balloonBalance > uw.loanAmount * 0.9 ? 'danger' : * 0.7 ? 'warning' : 'safe'` | Balloon-vs-loan threshold (90% / 70%). | Should be a derived classification on `repaymentSchedule.summary` (e.g. `balloonClassification`). The page is multiplying numbers on the client. |
| page.tsx:885, 1054–1063 | `summary.minDSCR < 1.15 ? 'danger' : 1.25 ? 'warning' : 'safe'` | Min-DSCR band thresholds 1.15 / 1.25. | Same — push classification upstream. |
| page.tsx:929–937 | Stress `dscr < 1.15`, `ltv > 0.80`, `debtYield < 0.07` thresholds | Stress-test pass/fail bands inline. | `breaksCovenants` exists already but the per-cell colouring re-invents bands. Lift cell-level classification into stress output. |
| page.tsx:1047 | `summary.balloonBalance > uwModel.loanAmount * 0.9` | Same balloon threshold, second copy. | Centralise. |
| page.tsx:1167–1175 | per-month `monthlyDSCR < 1.15 ? danger : 1.25 ? warning : safe` | Same DSCR bands a third time. | Producer should classify each entry. |
| page.tsx:1241–1243 | `finding.confidence === 'high' ? positive : 'low' ? high-risk : muted` | Confidence → colour band. Pure display map — fine to keep on client. | Safe (display only). |
| page.tsx:1297–1298 | `finding.sellerBankValue \|\| finding.asrValue \|\| ''` | Field-name fallback chain (legacy alias). | API should retire `asrValue`/`uwValue`/`difference` aliases. Page coerces. |
| page.tsx:1303–1308 | `flag === 'material' ? "Material Credit Deviation" : 'moderate' ? "Moderate Adjustment" : "Minor Adjustment"` | Flag → label string. | Display map; safe to keep on client BUT consider exposing the canonical label so Excel and web agree. |
| page.tsx:1317–1320 | `pctVar.toFixed(1) + '%'` with explicit sign | Display formatting. Safe. | Safe. |
| page.tsx:867–869 | `uw.loanDetails?.ioMonths || 0`, `termMonths || uw.termYears * 12`, etc. | Implicit numeric fallback chains. | **Policy smell** — coercing missing structural inputs to 0 / inferring months from years. Should be canonical on the model. |
| page.tsx:996–998 | `details.ioMonths || 0`, `termMonths || 0`, `amortizationMonths || 0` | Same `|| 0` pattern. | Same. |
| page.tsx:1086–1088 | `(termMonths - ioMonths) / termMonths * 100` | Timeline width as percent. | Display calc — safe (assumes upstream guarantees `termMonths > 0`). |
| page.tsx:986–994 | Schedule sampling logic (first 12, last 6, IO/amort transition month, every 12th) | Compression rule for the table. | View-layer concern; OK to keep in React, but could be parameterised. |
| page.tsx:1404–1417 | Hard-coded map from `LineItem.label` (e.g. `'Real Estate Taxes'`) → dotted edit path (e.g. `'expenses.realEstateTaxes.annualAmount'`) | Recovers field path from human label string. | **Severe smell** — translation-fragile. Add `lineItem.fieldPath` to the API response (or a stable `lineItem.key`) so the page does not rely on label strings. |

---

## Mode-dependence summary

The page **does not currently support a UW vs Bank vs Adjusted view-mode toggle**. There is no URL param, no React state, no prop, and no tab dedicated to switching mode. Consequences:

- The single `analysis.uwModel` object is rendered as the only view of underwriting numbers. The model carries an `asReported: boolean` flag (per `UnderwritingModel` type) but the page **never reads it** — so the user cannot tell which projection they are looking at.
- Mode is encoded only at **export time** via `api.exportUnderwriting(..., { profile: 'bank' \| 'bp_spire', underwritingMode: 'single_loan' })` (page.tsx:166–180). The two buttons hard-code `single_loan` mode — `roll_up` mode is unreachable from this page today.
- `analysis.crossCheckFindings` is the only place where Bank vs UW perspectives appear: each row exposes `sellerBankValue` and `bpSpiralValue` side by side. Cross-check is the de-facto two-mode comparison view.
- `analysis.overallAdjustmentBias` ('conservative' / 'aggressive' / 'neutral') summarises the BP-vs-seller direction — also a cross-check artefact, not a UW-mode selector.
- `analysis.sellerMetrics` (typed `SellerExtractedMetrics`) is not consumed — implies seller-side metrics existed in an earlier design that the page no longer renders.

**Implication for Batch 6:** the new spine emits `UnderwritingContext` plus an `AdjustedInputs` block parameterised by `mode ∈ {UW, Bank, Adjusted}` (doctrine §3.2 R2). The current page contract assumes a single-mode flat `uwModel`. The cutover MUST either (a) keep returning a flattened single-mode `uwModel` for the legacy endpoint **and** add a new versioned endpoint for the multi-mode view, or (b) coordinate a UI change to consume mode-projected data. Doctrine §5.2 B2 says new fields land additively and breaking changes get a versioned endpoint — option (a) is the doctrine-aligned path.

---

## Contract risks

1. **`numeric \|\| 0` coercion in loan-details fallbacks** (page.tsx:867–869, 996–998). The `??`/`||`/`* 12` chains hide degraded state — exact pattern doctrine §3.3 calls a smell test. If the new spine emits `null` for missing months, the page silently coerces to 0 and infers from `termYears * 12`. Risk: a missing IO/amort surfaces as "0 months" and breaks the timeline visualisation.

2. **Multi-name field fallbacks on `CrossCheckFinding`** (page.tsx:1297, 1298, 1322, 1339, 1346–1347). The `Analysis` type explicitly carries legacy aliases (`asrValue`, `uwValue`, `difference`, `asrSource`, `uwSource`, `explanation`). Page has `||` chains across all of them. The new spine MUST decide: emit canonical names only (and break old stored analyses) OR continue emitting both. Doctrine B2 says additive — keep both, but document.

3. **`stressScenarios[].results.noi` typed `number` while `dscr/ltv/debtYield/impliedValue` are `number | null`** (analysis.ts:198–206). The page calls `formatCurrencyFull(s.results.noi)` (page.tsx:927) which will crash on `null`. The new spine must either keep `noi` non-null (matching legacy contract) or change the type AND the formatter call site. R8 / B6 say degraded state must surface — so likely `noi` should become `number | null` and the formatter should switch to `formatCurrencyFullSafe`.

4. **`covenantSkips` typed but never rendered** (analysis.ts:211, page.tsx 949–954). The doctrine explicitly distinguishes a covenant *break* from a covenant *skip* (B6, R8). The page only renders breaches. **A scenario whose DSCR is null silently looks "PASS"** because `breaksCovenants` is `false`. Lifted-policy regression: legacy silent fallback masquerading as a green light.

5. **Frontend-side credit thresholds** — DSCR (1.25 / 1.50), LTV (0.65 / 0.75), Debt Yield (0.08 / 0.10), Min-DSCR (1.15 / 1.25), Balloon-to-loan (0.7 / 0.9), Stress (DSCR 1.15 / LTV 0.80 / DY 0.07) — all hard-coded as ternaries on numeric values. These are **policy** (smell test §6.6) inhabiting the view layer. If the spine ever changes credit policy, the web client lies until redeployed.

6. **Magic-string `LineItem.label` → field path translation** (page.tsx:1404–1417). If a producer renames "Real Estate Taxes" to "Property Taxes", editing breaks silently — the lookup returns `undefined` and the PATCH never fires. No type safety.

7. **`uwModel.asReported` typed but unread.** The mode flag exists; nothing displays it. A user editing values has no visible signal whether they are looking at as-reported, BP-adjusted, or stressed inputs. This is the single biggest UX blocker for the multi-mode view doctrine §3.2 R2 enables.

8. **`api.getAnalysis` is typed `Promise<any>`** (api-client.ts:75). The web client has no compile-time link between the API response and the `Analysis` type — every field is a runtime contract. Refactoring the spine cannot rely on the TypeScript compiler to catch breakages.

9. **`analysis.creditScore.recommendation` and `riskTier` accessed via `?.replace`** (page.tsx:217, 225). Both are typed as required (non-optional) on `CreditScore` but the page treats them as nullable. Either the type lies or the page is over-defensive. Pick one.

10. **Polling `getAnalysis` every 2 seconds** (page.tsx:33–61). After cutover, `Analysis` will be assembled on the fly from `HydratedRecordGraph` on every poll. Resolver determinism (R5) makes this safe but performance-aware. Note for spine implementation.

---

## Recommendations

### Server-side moves (lift derivation upstream)

- **Threshold classification fields.** Emit `dscrBand`, `ltvBand`, `debtYieldBand`, `balloonBand`, `minDscrBand`, plus per-stress-scenario per-metric bands as discriminated strings (`'safe' | 'warning' | 'danger' | null`). Page reads bands directly. Bands are a producer-rule output, not a render concern.
- **`riskTier` as the colour driver.** The page recomputes the tier from `score.overall` numeric thresholds. Use `score.riskTier` (already on the type) as the single source of truth; deprecate the `>= 85` ladder in the page.
- **Per-category tier on `CreditScoreCategory`.** Add `tier: 'strong' | 'acceptable' | 'watchlist' | 'high_risk'` so the per-category bar colour also reads instead of computes.
- **Stress-scenario per-cell pass/fail.** Today `breaksCovenants` is one boolean; the page colours each cell with hard-coded thresholds. Surface `results.dscrBreached`, `results.ltvBreached`, `results.debtYieldBreached`. (Or per-cell bands if more nuance is wanted.)
- **`covenantSkips` rendering.** Either render it on the page (correct doctrine) or remove the field. Today it is a silent regression vector.
- **`LineItem.fieldPath`** (or `LineItem.key`). Stop using `label` strings as keys for edit dispatch.
- **Resolve `loanDetails.{ioMonths, termMonths, amortizationMonths}` upstream.** Eliminate `|| 0` and `|| termYears * 12` fallbacks in the page. If they are missing, surface a `dataQualityFlag`.
- **Canonical labels for cross-check flags.** Move `flagLabel` table (page.tsx:1306–1308) into the API response.

### Type-tightening opportunities

- Switch `api.getAnalysis` from `Promise<any>` to `Promise<{ analysis: Analysis }>`. Same for `updateUWModel`, `runStressTest`, `addComment`, etc. This converts cutover regressions from runtime to compile-time errors.
- Drop legacy `CrossCheckFinding` aliases (`asrValue`, `uwValue`, `difference`, `asrSource`, `uwSource`, `explanation`) once stored analyses are migrated. Until then, leave them but mark `@deprecated`.
- Make `stressScenarios[].results.noi: number | null` to match the rest of the metrics block. Update `formatCurrencyFull` call site to `formatCurrencyFullSafe`.
- Either make `CreditScore.recommendation` and `CreditScore.riskTier` `| null` to match the page's defensive `?.replace`, or make the page non-defensive.

### Documented contract version (the field set the new spine MUST emit)

Below is the minimum field set required to render the page without behavioural regression. The new `/analysis/:id` endpoint MUST emit at least these fields (additive shape additions are fine; semantic renames or removals are not).

**Top-level `Analysis`:**
- `id`, `name`, `assetType`, `status`, `progress`, `currentStep`, `error`
- `executiveSummary`, `inputHash`, `manifestoVersion`, `modelLogicVersion`
- `validationResult.{passed, checks[]}`
- `findings[]` with: `id`, `severity`, `title`, `confidence`, `pageReferences[]{page, sectionTitle, excerpt?}`, `explanation`, `impact.description?`
- `creditScore`: `overall`, `riskTier`, `recommendation`, `categories[]{category, score, weight, weightedScore, explanation?}`, `narrative`, `whyThisScore`, `howToImprove`
- `crossCheckFindings[]` (canonical names): `id`, `metric`, `sellerBankValue`, `bpSpiralValue`, `percentVariance`, `absoluteVariance`, `flag`, `commentary`, `severity`, `sellerSource{sectionTitle, page}`, `bpSource`
- `overallAdjustmentBias`
- `mitigations[]`: `id`, `findingId`, `strategy`, `description`, `structuralChanges[]`, `financialImpact{targetMetric, currentValue, projectedValue, improvement}`, `requiredReserve?`, `requiredEquity?`, `riskReduction`
- `research{sponsor[], market[], news[]}` each `{title, snippet, source, publishedDate?, url?, riskSignal}`
- `criteriaEvaluations[]{ruleName, result, reason, source?}`
- `bPieceDecision?{recommendation, conviction, summary, dealBreakers[], keyConditions[], pricingGuidance?}`
- `comments[]{id, stance, author, createdAt, text}`
- `stressScenarios[]{name, results{noi, dscr, ltv, debtYield}, breaksCovenants, covenantBreaches[], covenantSkips[]}`
- `uwModel`: `income.{grossPotentialRent, vacancyLoss, concessions, otherIncome, additionalItems[], effectiveGrossIncome}`, `expenses.{realEstateTaxes, insurance, utilities, repairsAndMaintenance, management, generalAndAdmin, payroll, replacementReserves, additionalItems[], totalExpenses}`, `netOperatingIncome`, `capRate`, `impliedValue`, `loanAmount`, `interestRate`, `amortizationYears`, `termYears`, `annualDebtService`, `dscr`, `ltv`, `debtYield`, `loanDetails{rateType, ioMonths, termMonths, amortizationMonths, prepaymentTerms, paymentFrequency, originationDate}`, `repaymentSchedule{entries[]{month, date, isIO, beginningBalance, scheduledPrincipal, interest, totalPayment, endingBalance, cumulativePrincipal, monthlyDSCR}, summary{totalInterest, totalPrincipal, balloonBalance, balloonDate, ioEndDate, minDSCR, minDSCRMonth}}`
- `LineItem`: `id`, `label`, `annualAmount`, `isEditable`. (Plus `fieldPath` recommended.)

**Out-of-band endpoints used:**
- `GET /analyses/:id/populated-template/info` → `{available, fileName?, mappedFields?, unmappedFields?, tabsPopulated?}`
- `GET /analyses/:id/populated-template` → binary
- `PATCH /analyses/:id/uw-model` body `{updates:[{path,value}]}` → `{uwModel}`
- `PATCH /analyses/:id/loan-terms` body `{interestRate?,ioMonths?,amortizationMonths?,termMonths?,rateType?,paymentFrequency?,prepaymentTerms?,loanAmount?}` → `{uwModel}`
- `POST /analyses/:id/stress-test` body `{scenarios?}` → `{results:[StressScenario]}`
- `POST /analyses/:id/comments` body `{sectionId,findingId?,stance,text}` → `{analysis}` (page re-fetches after add)
- `GET /underwriting/export?dealId=&profile=&assetClass=&underwritingMode=&structuralVariantKey?=&templateType?=` → binary xlsx

The new spine must preserve all of the above unchanged at `/analysis/:id` (legacy strict-dispatch route). Any new mode-projected views go on a versioned endpoint per doctrine §5.2 B2.
