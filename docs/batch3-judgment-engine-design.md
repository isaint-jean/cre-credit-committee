# Batch 3 Pre-Implementation Audit — Judgment Engine + Conservatism Gate + Metrics

Pre-implementation design review. **No code.** This document defines the rule-by-rule logic
that the Stage 4 + Stage 5 + Stage 6 producers must implement so the implementation pass is
mechanical translation rather than design-on-the-fly.

Locked 2026-05-08 (v2.3 of the rollout plan). Subsequent revisions append at the end.

---

## 1. Scope

Batch 3 ships three stages as one PR:

| Stage | Producer | Output |
|---|---|---|
| 4 | `applyJudgmentAdjustments(...)` | `AdjustedInputs` (immutable post-Stage-4) |
| 5 | `verifyConservatism(...)` | `void` (throws `ConservatismViolationPayload`) |
| 6 | (folded into Stage 4) | metrics live on `AdjustedInputs.metrics` |

This document covers all three. Stage 6 has no separate producer per v2 §G decision (avoids the
dual-write problem v0.2 of the prototype skeleton had).

## 2. Stage 4 input contract

```
applyJudgmentAdjustments({
  extraction:       ExtractionResult,
  assetProfile:     AssetProfile,
  librarySnapshot:  LibrarySnapshot,
  manifesto:        CreditManifesto,
  marketBenchmarks: MarketBenchmarks,
  analysisAsOfDate: ISODateTime,
}): AdjustedInputs
```

All inputs typed (no `any`). All inputs `Readonly<>` at the signature.

**Pre-conditions** (engine throws if violated):
- `librarySnapshot.byAssetType[assetProfile.propertyType]` may be `null` — engine accepts
  degraded mode but must surface it (see §9).
- `extraction.analysisAsOfDate === analysisAsOfDate` — extraction's frozen date must match the
  pipeline's frozen date.
- `manifesto.analysisAsOfDate === analysisAsOfDate` — same constraint.

## 3. Stage 4 output contract (recap)

`AdjustedInputs` from `@cre/contracts/adjusted-inputs.ts` — already shipped. Key fields the
engine populates:

```
id:                       AdjustedInputsId        ← content hash of body
analysisAsOfDate          ← from input
judgmentEngineVersion     ← '1.0' constant
librarySnapshotId         ← input.librarySnapshot.id

income.{grossRentalIncome, otherIncome, vacancyPct, concessionsPct, effectiveGrossIncome}:
  AdjustedLineItem        ← raw + adjusted + source + adjustments[]
expenses.{realEstateTaxes, insurance, utilities, managementFee, payroll, maintenance, other,
          totalOperatingExpenses}: AdjustedLineItem
capitalReserves.{upfrontCapex, upfrontTiLc, monthlyCapex, monthlyTiLc, pcaImmediateRepairs}:
  AdjustedLineItem
loan.{loanAmount, interestRate, termMonths, amortizationMonths, ioPeriodMonths,
      maturityBalance, debtServiceAnnual}: AdjustedLineItem
assumptions.{capRate, terminalCapRate, rentGrowthPct, expenseGrowthPct}: AdjustedLineItem
metrics.{noi, value, dscr, ltvAppraisal, debtYield, expenseRatio, top1IncomeShare,
         pctIncomeExpiringWithinTerm}: number | null

confidenceReduction:      number ∈ [0, 1]
```

## 4. Stage 4 internal orchestration

```
4a.  Build document-presence ledger from ExtractionResult
4b.  Per-line-item: source-tier resolution (read raw value + chosen source)
4c.  Per-line-item: missing-data substitution (raw === null → library/benchmark median)
4d.  Per-line-item: library-relative normalization (vacancy floor, expense floor, cap-rate floor)
4e.  Manifesto rule application (each enabled rule evaluates; emits AdjustmentEntry)
4f.  NOI ceiling enforcement (cap adjusted NOI at raw bank NOI)
4g.  Confidence-reduction computation (sum penalties / 100, capped at 1.0)
4h.  Metrics derivation (NOI, value, DSCR, LTV, debt yield, etc.)
4i.  Stamp (id, analysisAsOfDate, versions, FK) + return AdjustedInputs
```

Order is strict. 4d depends on 4c (substitutions land first). 4f depends on 4e (manifesto rules
may already have raised vacancy or expense). 4h depends on 4f (NOI is final by then).

No back-edges. No re-entry. Pure function from inputs → output.

## 5. Stage 4a — Document presence ledger

For each of the 5 §1 documents (RentRoll, T12, LoanTerms, PCA, Appraisal):

```
present = (extraction.<doc> !== null)
if (!present) → emit JE_<DOC>_MISSING entry into the missing-doc ledger
```

The ledger is an internal accumulator: `MissingDocLedger = { ruleId: JudgmentEngineRuleId, points: number }[]`. Used in 4g to compute `confidenceReduction`.

Penalty points come from `JE_MISSING_DOC_PENALTIES` in `@cre/contracts`:
- JE_RENT_ROLL_MISSING: 12
- JE_T12_MISSING: 12
- JE_LOAN_TERMS_MISSING: 10
- JE_PCA_MISSING: 6
- JE_APPRAISAL_MISSING: 4

ASR and SellerUW are NOT penalized for being missing — architecture §1 lists only 5 docs. Their
absence affects which line-item source tiers are available (see 5.2).

## 5.1 Source-tier preference per line item

Each line item has a per-item source-preference cascade. The engine reads from the highest
available tier; if a higher tier was available but not used, emit a distrust penalty.

| Line item | Preference order (highest → lowest) | Distrust rule |
|---|---|---|
| `income.grossRentalIncome`            | T12 → RentRoll-derived → SellerUW → MANUAL | JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS if T12 available but SellerUW chosen |
| `income.otherIncome`                  | T12 → SellerUW → MANUAL | same |
| `income.vacancyPct`                   | T12 (vacancyLoss / GPR) → RentRoll (1 - occupancy) → SellerUW.underwrittenVacancy → MANUAL | same |
| `income.concessionsPct`               | RentRoll-derived → SellerUW → MANUAL | — |
| `income.effectiveGrossIncome`         | T12.income.effectiveRent → derived from above | — (derived, no separate source) |
| `expenses.*` (per line)               | T12 → SellerUW → MANUAL | JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS if T12 available |
| `expenses.totalOperatingExpenses`     | T12 → sum of above lines → MANUAL | — |
| `capitalReserves.upfrontCapex`        | LoanTerms reserve schedule (if present) → PCA-derived → MANUAL | — |
| `capitalReserves.pcaImmediateRepairs` | PCA → MANUAL | — |
| `loan.loanAmount`                     | LoanTerms → SellerUW → MANUAL | — |
| `loan.interestRate`                   | LoanTerms → MANUAL → MarketBenchmarks.baseRate (substitution) | — |
| `loan.termMonths`, `amortizationMonths`, `ioPeriodMonths`, `maturityBalance` | LoanTerms → MANUAL | — |
| `loan.debtServiceAnnual`              | LoanTerms → derived from amortization formula → MANUAL | — |
| `assumptions.capRate`                 | Appraisal.capRate → SellerUW → ASR → LibrarySnapshot.capRate.median (substitution) | JE_ASR_USED_WHEN_PRIMARY_EXISTS if Appraisal available but ASR chosen |
| `assumptions.terminalCapRate`         | LoanTerms (if specified) → SellerUW → assumptions.capRate.adjusted + 50bps | — |
| `assumptions.rentGrowthPct`           | SellerUW → MarketBenchmarks → MANUAL | — |
| `assumptions.expenseGrowthPct`        | SellerUW → MarketBenchmarks → MANUAL | — |

**Note:** "Sourced" means the engine assigns `AdjustedLineItem.source = <tier>`; the value is
read from that tier. Not a vote between sources.

## 6. Stage 4b — Per-line-item adjustment (the meat)

For each line item, the engine produces an `AdjustedLineItem`:

```
{ raw: number | null, adjusted: number, source: SourceTier, adjustments: AdjustmentEntry[] }
```

Algorithm per line item:

```
1. Read raw + source per the preference cascade in §5.1.
2. If raw === null:
     a. Substitute from library/benchmark (per §6.1 below)
     b. Append AdjustmentEntry with ruleId = JE_<METRIC>_SUBSTITUTED_FROM_LIBRARY
     c. delta = (substituted - 0); (delta is documentary; raw was null so no math)
     d. adjusted = substituted value
3. Else:
     a. adjusted = raw  (provisional)
4. Apply library-relative normalization (per §7 below):
     a. If adjusted < library floor → raise to floor → emit JE_<METRIC>_RAISED_TO_LIBRARY_MEDIAN
     b. delta = floor - adjusted (positive)
5. Apply manifesto rules that target this line item (per §8 below):
     a. Rules that modify the value → emit AdjustmentEntry with manifesto ruleId
     b. Rules that only check (Pass/Fail/Watchlist) → emit AdjustmentEntry with delta=0
6. Apply distrust penalty if applicable (per §5.1):
     a. If chosen source is lower-tier than what was available → emit AdjustmentEntry with
        ruleId = JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS or JE_ASR_USED_WHEN_PRIMARY_EXISTS
     b. delta = 0 (penalty is on confidenceReduction, not the value)
7. Return AdjustedLineItem.
```

**Invariant carried throughout:** `adjusted: number` (never null). If after step 2 the
substitution still yields null (e.g., library has no entry), the engine THROWS (see §15).
Returning a null `adjusted` violates the contract.

### 6.1 Substitution rules per line item

| Line item | Substitution source | If unavailable |
|---|---|---|
| `vacancyPct`           | `librarySnapshot.byAssetType[X].vacancy.median` | `marketBenchmarks.vacancyRates[X]` → throw if both null |
| `expenseRatio` (derived) | `librarySnapshot.byAssetType[X].expenseRatio.median` | `marketBenchmarks` PSF-equivalent → throw if both null |
| `assumptions.capRate`  | `librarySnapshot.byAssetType[X].capRate.median` | `marketBenchmarks.capRates[X]` → throw if both null |
| `loan.interestRate`    | `marketBenchmarks.interestRateAssumptions.baseRate` | throw |
| Most others            | If raw is null AND no clear library/benchmark equivalent → throw `INSUFFICIENT_DATA` | — |

Throwing is correct: architecture §8 says "Missing inputs trigger judgment-engine penalties
(e.g. vacancy → library median + missing-data penalty). Missing inputs NEVER default to 0."
The penalty path REQUIRES a valid substitution source. If neither library nor benchmark has
data, the engine cannot honor the contract; failing loudly is the discipline.

### 6.2 Per-line-item walkthrough — vacancyPct (canonical example)

```
raw, source = readSource('vacancyPct')           // §5.1 cascade
adjustments = []

if raw === null:
  if librarySnapshot.byAssetType[X] !== null:
    substituted = librarySnapshot.byAssetType[X].vacancy.median
    adjustments.push({ ruleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', delta: substituted, reason: '...' })
    adjusted = substituted
    source = 'MANUAL'
  else if marketBenchmarks.vacancyRates[X] !== null:
    substituted = marketBenchmarks.vacancyRates[X]
    adjustments.push({ ruleId: 'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY', delta: substituted, reason: '...' })
    adjusted = substituted
    source = 'MANUAL'
  else:
    throw new Error('JE_VACANCY_SUBSTITUTION_IMPOSSIBLE')
else:
  adjusted = raw

// Library-relative normalization (§7)
libraryMedian = librarySnapshot.byAssetType[X]?.vacancy.median
bankVacancy   = sellerUw.underwrittenVacancy   // optional
floor = max(libraryMedian ?? 0, bankVacancy ?? 0)

if adjusted < floor:
  delta = floor - adjusted
  ruleId = (libraryMedian >= bankVacancy)
           ? 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN'
           : 'JE_VACANCY_RAISED_TO_BANK'
  adjustments.push({ ruleId, delta, reason: '...' })
  adjusted = floor

// Manifesto rules (§8)
for rule in manifesto.rules where rule.metricName === 'vacancy':
  outcome = evaluateRule(rule, { adjusted, raw, ... })
  if rule.outcome === 'Fail' && rule.modifies:
    delta = computeRuleDelta(rule, adjusted)
    adjusted = adjusted + delta
    adjustments.push({ ruleId: rule.ruleId, delta, reason: rule.condition })
  elif rule.outcome in ['Pass', 'Fail', 'Watchlist']:
    adjustments.push({ ruleId: rule.ruleId, delta: 0, reason: `${rule.outcome}: ${rule.condition}` })

return { raw, adjusted, source, adjustments }
```

The same shape repeats for every line item with appropriate substitution source, library
floor, and manifesto rule filter.

### 6.3 Derived line items (effectiveGrossIncome, totalOperatingExpenses, debtServiceAnnual)

These are line items whose `adjusted` value is computed from other line items rather than
extracted directly. Pattern:

```
raw = (extracted, may be null)
adjusted = compute_from_other_adjusted_lines()
source = (raw !== null) ? <extracted-source> : 'MANUAL'
adjustments = []                       // no direct adjustments; trace via source line items
```

Cross-check service can show the bank-vs-derived discrepancy by comparing `raw` to `adjusted`.

### 6.4 N/A line items per asset type

Some line items don't apply to all asset types:
- `concessionsPct` is multifamily/hotel-relevant; for office, set raw=null and adjusted=0 with
  source='MANUAL'. Emit no AdjustmentEntry (zero is a real value, not a penalty).
- `ioPeriodMonths` is 0 if no IO period. Same pattern.

These are NOT null-coercion violations because zero is the actual value, not a substitution
for missing data. The judgment engine MUST distinguish "null because missing" (substitution +
penalty) from "null because not applicable" (zero is correct).

**Convention:** the engine tracks a per-line-item `applicability` predicate. If the line item
does not apply (e.g., IO period for a fully-amortizing loan), `raw=null, adjusted=0,
source='MANUAL'`, no penalty. Otherwise null → substitution + penalty.

## 7. Stage 4d — Library-relative normalization

Architecture §6: adjusted vacancy ≥ max(library median, bank vacancy); adjusted expense ratio ≥
max(library median, bank); adjusted NOI ≤ raw bank NOI (Stage 4f, separate).

Three line items get library floors in v1:

| Line item | Floor formula | Rule fired when raised |
|---|---|---|
| `income.vacancyPct`      | `max(librarySnapshot.median, sellerUw.underwrittenVacancy)` | JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN or JE_VACANCY_RAISED_TO_BANK (whichever was higher) |
| `expenses.totalOperatingExpenses` (as % of EGI) | `max(library.expenseRatio.median × adjusted EGI, bank expense ratio × adjusted EGI)` | JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN or JE_EXPENSE_RAISED_TO_BANK |
| `assumptions.capRate`    | `librarySnapshot.capRate.median` (only library, no bank floor for cap rate) | JE_CAP_RATE_RAISED_TO_LIBRARY_MEDIAN |

The floor is **higher of library + bank** for vacancy/expense (architecture §6); only library
for cap rate. Bank cap rate is harder to define cleanly (multiple sources possible).

**Direction:** for vacancy/expense, "raise" = increase. For cap rate, "raise" = increase
(higher cap = lower value = more conservative).

## 8. Stage 4e — Manifesto rule application

For each enabled manifesto rule:

```
8.1 Asset-type filter:
    if rule.assetTypes !== ['all'] && !rule.assetTypes.includes(assetProfile.propertyType):
      skip

8.2 Predicate evaluation:
    Map rule.metricName → AdjustedInputs path (using a frozen mapping table)
    Read currentValue from that path (post-substitution, post-library-normalization)
    If currentValue === null: rule cannot evaluate → emit a Watchlist entry with
        delta=0, reason="INSUFFICIENT_DATA: <rule.metricName>"
    Else: evaluate `currentValue <op> rule.thresholdValue` per rule.comparisonOperator

8.3 Outcome handling:
    case 'Pass':       emit AdjustmentEntry { ruleId: rule.ruleId, delta: 0, reason: 'Pass: <name>' }
    case 'Fail':       emit AdjustmentEntry { ruleId: rule.ruleId, delta: 0, reason: 'Fail: <name>' }
                       (Fail does NOT modify the value in v1; only flags. Doctrine reads.)
    case 'Watchlist':  emit AdjustmentEntry { ruleId: rule.ruleId, delta: 0, reason: 'Watchlist: <name>' }
```

**Open decision:** v1.0 does NOT mutate values via manifesto rules. Manifesto rules are pure
checks (Pass/Fail/Watchlist outcomes). If a manifesto rule wants to override a value (e.g.,
"if cap rate < 5%, force to 5%"), that's a v1.1 feature requiring structured predicate
language. v1.0 manifesto rules are observational only.

This means `delta` on manifesto AdjustmentEntries is always 0 in v1.0.

### 8.1 Metric-name → AdjustedInputs path mapping

Frozen lookup table:

```
'noi'                  → metrics.noi
'dscr'                 → metrics.dscr
'capRate'              → assumptions.capRate.adjusted
'value'                → metrics.value
'loanAmount'           → loan.loanAmount.adjusted
'interestRate'         → loan.interestRate.adjusted
'debtYield'            → metrics.debtYield
'ltv', 'ltvAppraisal'  → metrics.ltvAppraisal
'vacancy', 'vacancyPct'→ income.vacancyPct.adjusted
'expenseRatio'         → metrics.expenseRatio
... etc (~15 entries)
```

Lives in a frozen const inside `services/judgment/manifesto-metric-paths.ts`. Adding a new
metric name requires a code change.

### 8.2 Predicate evaluation by operator

```
'>'           : currentValue > thresholdValue
'>='          : currentValue >= thresholdValue
'<'           : currentValue < thresholdValue
'<='          : currentValue <= thresholdValue
'=='          : currentValue === thresholdValue (or string equality if both strings)
'!='          : !==
'contains'    : (string only) currentValue.includes(thresholdValue)
'between'     : thresholdValue must be `[lo, hi]` shape; currentValue ∈ [lo, hi]
'qualitative' : v1.0 cannot evaluate → emit Watchlist with reason='QUALITATIVE_NOT_EVALUATED'
```

Numeric vs string thresholds resolved by `typeof rule.thresholdValue`.

## 9. Stage 4f — NOI ceiling

Architecture §6: "adjusted NOI cannot exceed bank NOI without explicit driver justification
recorded in `adjustments[]`."

Definition of "bank NOI":
- If `extraction.t12.noi !== null`: use that.
- Else if `extraction.sellerUw.underwrittenNOI !== null`: use that.
- Else: no bank NOI → no ceiling can be applied → flag as INSUFFICIENT_DATA but don't fail.

Algorithm:

```
adjustedNoi = derived from line items (income - expenses)
bankNoi = ... per above
if bankNoi !== null && adjustedNoi > bankNoi:
  // Architecture §6 requires explicit driver justification. v1.0 cap unconditionally and
  // flag. Future revision can accept rule-id justifications that allow exceedance.
  delta = bankNoi - adjustedNoi  (negative)
  metrics.noi = bankNoi
  // Emit on the underlying NOI computation by adding adjustments to relevant line items,
  // OR keep a separate top-level adjustment ledger. Decision below.
```

**Open decision:** where does JE_NOI_CAPPED_TO_BANK live in the ledger? Two options:

1. Append to `effectiveGrossIncome.adjustments[]` (effective decreases by the delta to make
   NOI = bank NOI). Asymmetric — NOI cap is an income reduction, not a real EGI change.
2. Add a top-level `AdjustedInputs.adjustmentLedger: AdjustmentEntry[]` for cross-cutting
   rules. Cleaner conceptually; requires contract addition.

**Recommendation:** option 2. Add `topLevelAdjustments: readonly AdjustmentEntry[]` to
`AdjustedInputs`. Used for rules that don't pin to a specific line item (NOI cap, distrust
penalties on confidenceReduction, etc.). This is a contract addition that needs a Batch 1.5
revision OR a new Batch 1.6 step.

Alternative for v1.0: skip Option 2's contract revision; deliberately scope NOI cap as a
metric clamp without a ledger entry; document that doctrine reads `metrics.noi` and can
detect the cap by comparing `metrics.noi === t12.noi` and the income-adjusted total. Less
clean but avoids a contract change.

## 10. Stage 4g — Confidence reduction math

```
sumPenalties = 0
for each entry in missing-doc ledger:
  sumPenalties += JE_MISSING_DOC_PENALTIES[entry.ruleId]
for each entry in distrust ledger:
  sumPenalties += JE_DISTRUST_PENALTIES[entry.ruleId]

confidenceReduction = clamp(sumPenalties / 100, 0, 1)
```

`/ 100` chosen as the normalization factor: each penalty point ≈ 1% confidence reduction.
Maximum sum (5 docs × full weights + 2 distrust × 6) = 56 → `confidenceReduction = 0.56`.
Hits 1.0 only if some future addition pushes total above 100 (room for growth).

**Note:** This is a v1.0 normalization choice. Alternatives considered:
- `sumPenalties / 56` (max-out at 1.0 today) — discarded because future additions break it
- `sumPenalties / 44` (missing-doc only) — discarded because distrust penalties are excluded
- Explicit `confidenceReductionMax: 0.56` constant — would be cleaner but adds another contract
  surface

## 11. Stage 4h — Metrics derivation

Folded into Stage 4. After all line items are adjusted, compute:

```
metrics.noi                     = income.effectiveGrossIncome.adjusted
                                  - expenses.totalOperatingExpenses.adjusted
                                  // (after NOI cap if applicable)

metrics.value                   = metrics.noi / assumptions.capRate.adjusted
                                  // null if capRate.adjusted === 0 (impossible; engine throws earlier)

metrics.dscr                    = metrics.noi / loan.debtServiceAnnual.adjusted

metrics.ltvAppraisal            = loan.loanAmount.adjusted / appraisal.valueConclusion
                                  // null if appraisal.valueConclusion is null
                                  // (LTV requires appraisal — different from .value above)

metrics.debtYield               = metrics.noi / loan.loanAmount.adjusted

metrics.expenseRatio            = expenses.totalOperatingExpenses.adjusted
                                  / income.effectiveGrossIncome.adjusted

metrics.top1IncomeShare         = (top tenant rent × 12) / annualGRI
                                  // from rent roll; null if no rent roll

metrics.pctIncomeExpiringWithinTerm = sum(units expiring <= termMonths) / total units' rent
                                      // from rent roll + loan terms; null if either missing
```

**Edge cases:**
- Division by zero → return `null` (don't throw). Doctrine handles `null` via INSUFFICIENT_DATA.
- Appraisal-dependent metrics (LTV) are null when appraisal is missing. Architecture §1 already
  penalizes missing appraisal with confidenceReduction; metric-level null is consistent.

## 12. Stage 5 — Conservatism gate

`verifyConservatism(adjusted: AdjustedInputs, library: LibrarySnapshot): void`. Throws on
violation; void on success.

Three predicates per architecture §6:

```
12.1 vacancy floor:
  libMedian = library.byAssetType[X]?.vacancy.median
  bankVacancy = (extraction's bank vacancy, passed via a context arg or recomputed)
  expectedFloor = max(libMedian ?? 0, bankVacancy ?? 0)
  if (adjusted.income.vacancyPct.adjusted < expectedFloor):
    throw ConservatismViolationPayload({
      metric: 'vacancy',
      rule: 'VACANCY_FLOOR',
      expected: expectedFloor,
      actual: adjusted.income.vacancyPct.adjusted,
    })

12.2 expense floor (computed as ratio against EGI):
  egi = adjusted.income.effectiveGrossIncome.adjusted
  opex = adjusted.expenses.totalOperatingExpenses.adjusted
  actualRatio = opex / egi
  libMedian = library.byAssetType[X]?.expenseRatio.median
  bankRatio = ... // from extraction
  expectedFloor = max(libMedian ?? 0, bankRatio ?? 0)
  if (actualRatio < expectedFloor):
    throw ConservatismViolationPayload({ metric: 'expense_ratio', ... })

12.3 NOI ceiling:
  bankNoi = ... // from extraction
  if (bankNoi !== null && adjusted.metrics.noi > bankNoi):
    // Allowed only if explicit driver justification exists
    hasJustification = adjusted.???.adjustments.some(a => a.ruleId === 'JE_NOI_CAPPED_TO_BANK')
                       OR similar rule indicating reasoned exceedance
    if (!hasJustification):
      throw ConservatismViolationPayload({ metric: 'noi', ... })
```

**Concern:** the gate needs access to the *raw bank* vacancy / expense ratio / NOI to compare
against. These live in `extraction`, not in `AdjustedInputs`. Either:
- Pass `extraction` to `verifyConservatism` alongside `adjustedInputs`
- Carry a derived `bankSnapshot: { vacancy, expenseRatio, noi }` on AdjustedInputs

**Recommendation:** add `extraction` to the gate's inputs. The gate is internal to the
pipeline; passing extraction is acceptable.

## 13. The list of judgment-engine rule IDs that fire

Cross-checking against the 18-rule registry from Batch 1.5:

| Rule | Stage 4 substep |
|---|---|
| JE_RENT_ROLL_MISSING                          | 4a (presence ledger) |
| JE_T12_MISSING                                | 4a |
| JE_LOAN_TERMS_MISSING                         | 4a |
| JE_PCA_MISSING                                | 4a |
| JE_APPRAISAL_MISSING                          | 4a |
| JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS          | 4b (per line item; distrust penalty) |
| JE_ASR_USED_WHEN_PRIMARY_EXISTS               | 4b |
| JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN           | 4d (vacancy normalization) |
| JE_VACANCY_RAISED_TO_BANK                     | 4d |
| JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN           | 4d (expense normalization) |
| JE_EXPENSE_RAISED_TO_BANK                     | 4d |
| JE_NOI_CAPPED_TO_BANK                         | 4f |
| JE_CAP_RATE_RAISED_TO_LIBRARY_MEDIAN          | 4d (cap-rate normalization) |
| JE_VACANCY_SUBSTITUTED_FROM_LIBRARY           | 4c |
| JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY     | 4c |
| JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY          | 4c |
| JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK   | 4c |
| JE_DSCR_SUBSTITUTED_FROM_LIBRARY              | 4c |

Coverage check: every rule has a clear firing site. ✓

## 14. Anti-patterns to reject (carry-forward + new)

From plan v2 §6 — still applicable. Plus new entries surfaced by this audit:

1. **`null → 0`** in any line-item adjustment (§8 hard ban). Re-confirmed.
2. **Hardcoded baseline values** substituting for library distributions (§4). Re-confirmed.
3. **Stage 3 / Stage 4 conflation.** AssetProfile is input, not output.
4. **`adjustments: string[]`** instead of `AdjustmentEntry[]`. Re-confirmed.
5. **Above-line / below-NOI conflation.** Capex/TI-LC stay in `capitalReserves`, NOT operating
   expenses.
6. **Skipping confidence-reduction on missing docs.** Even if a document is "optional" by
   convention (ASR), missing primary docs MUST hit the ledger.
7. **Manifesto rules mutating values in v1.0.** Per §8, v1.0 manifesto rules are observational
   only; mutation is a v1.1 feature.
8. **NOI cap silently raising NOI.** The cap can ONLY lower; if adjustedNoi < bankNoi, no cap
   applies.
9. **NEW: Conflating "applicable but missing" with "not applicable".** §6.4 — `concessionsPct=0`
   for a hotel is a real zero, not a substitution for missing data. Engine MUST distinguish.
10. **NEW: Source-tier choice that ignores availability.** Engine MUST pick the highest
    available tier per §5.1; choosing a lower tier without checking higher availability is
    wrong even if it doesn't trigger a distrust penalty (the penalty fires on actual misuse).
11. **NEW: Reading from `librarySnapshot.byAssetType[X]` when `X` may have a `null` entry.**
    Engine MUST check for null and route to MarketBenchmarks fallback OR throw, never
    silently substitute zero.
12. **NEW: Manifesto predicate evaluation against `null` line item values.** Predicates can't
    evaluate against null without false-negative results. Engine MUST treat `currentValue ===
    null` → emit `Watchlist` with reason `INSUFFICIENT_DATA`, never coerce null to 0 for
    comparison.

## 15. Open decisions (need resolution before implementation)

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | NOI cap ledger location: per-line-item adjustments[] vs new top-level `topLevelAdjustments` field on AdjustedInputs | Add `topLevelAdjustments` (Option 2 in §9). Requires a Batch 1.6 contract revision OR fold into Batch 3 PR. | Stage 4f implementation |
| 2 | confidenceReduction normalization factor: `/100` vs `/56` vs explicit constant | `/100` for forward compatibility | Stage 4g math |
| 3 | Manifesto rule mutability in v1.0: observational only vs allow value mutations | Observational only (§8); revisit in v1.1 | Stage 4e implementation |
| 4 | Conservatism gate inputs: pass extraction to access bank values vs carry bank snapshot on AdjustedInputs | Pass extraction (§12) | Stage 5 signature |
| 5 | Substitution failure (no library + no benchmark): throw vs return null | Throw (architecture §8 spirit) | Stage 4c implementation |
| 6 | Manifesto predicate evaluation against null line items | Treat as Watchlist with INSUFFICIENT_DATA reason | Stage 4e implementation |
| 7 | "Applicable but zero" vs "not applicable" — how does engine know? | Per-line-item `applicability` predicate keyed on AssetProfile + extraction context | Stage 4b implementation |
| 8 | LTV uses appraisal value or final value? | Architecture says appraisal; final value is post-cap. Use appraisal for the ratio that doctrine §4 LTV_LEVEL scores. | Stage 4h |
| 9 | Cap-rate library floor — direction. Cap rate higher = more conservative. Use library median as a *floor* (raise if below) or a *baseline* (use library if missing)? | Use as substitution (only when raw is null); don't normalize raw upward (cap rate is already the most-volatile assumption; over-conservatism here understates value heavily) | Stage 4d |
| 10 | Engine observability: log every AdjustmentEntry or aggregate? | Log aggregate counts per ruleId at engine boundary; full ledger lives on the persisted record | Implementation hygiene |

## 16. Test coverage plan (minimum)

**Per-line-item null-handling (15 tests):**
- For each of the 15 line items: raw=null + library available → substituted, source=MANUAL,
  AdjustmentEntry with substitution rule, adjusted=library median.

**Per-line-item library-floor enforcement (3 tests):**
- vacancyPct, expenseRatio, capRate: raw < library median → adjusted = library median, rule fired.

**Per-line-item bank-floor enforcement (2 tests):**
- vacancyPct, expenseRatio: raw < bank value > library median → adjusted = bank value, rule
  JE_*_RAISED_TO_BANK fired.

**Source-tier preference (5 tests):**
- T12 + SellerUW present → T12 chosen, no distrust penalty
- T12 absent, SellerUW present → SellerUW chosen, no distrust penalty (no higher tier
  available)
- Both T12 and SellerUW present, but T12 used → no penalty
- Edge: malformed source choice (test injection of bad data) → throw

**Manifesto rule application (5 tests):**
- Rule with assetTypes=['all'] applies regardless of asset type
- Rule with assetTypes=['Office'] doesn't apply to Multifamily
- Pass/Fail/Watchlist outcomes each emit AdjustmentEntry with delta=0
- Numeric predicate against null value → Watchlist with INSUFFICIENT_DATA
- Qualitative operator → Watchlist (v1.0 doesn't evaluate)

**Missing-doc penalties (5 tests):**
- Each of the 5 docs missing individually → penalty applied per architecture §1 weights
- All 5 missing → confidenceReduction = 0.44 (44/100)
- All 5 + both distrust → confidenceReduction = 0.56

**NOI cap (3 tests):**
- adjustedNoi <= bankNoi → no cap, no rule fired
- adjustedNoi > bankNoi → cap fires, metrics.noi = bankNoi
- bankNoi null → no cap possible, but flag

**Conservatism gate (4 tests):**
- All conservative → void
- Vacancy below floor → throws with metric='vacancy'
- Expense ratio below floor → throws with metric='expense_ratio'
- NOI exceeds bank without justification → throws with metric='noi'

**Metrics derivation (8 tests):**
- Each derived metric: known inputs → expected output to 1e-9 precision
- Division by zero → null (not throw)

**Idempotency + replay (3 tests):**
- Same inputs → same AdjustedInputs.id
- Different one input → different id
- Re-extracting raw values produces same downstream id (modulo extraction version)

**Pre-conditions (4 tests):**
- analysisAsOfDate mismatch (extraction vs caller) → throw
- LibrarySnapshot for asset type is null AND no benchmark fallback → throw
- librarySnapshot.id mismatch with caller's specified librarySnapshotId → throw

Total: ~58 tests. Same scale as test-stress-contracts (37) plus a margin for the rule-by-rule
walk.

## 17. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Per-line-item adjustment functions diverge from spec subtly | High (15 lines × 8 substeps each = 120 places to err) | High (downstream metrics rely on every line) | Audit checkpoint POST-implementation per plan §F.2 |
| Null-handling discipline breaks somewhere | High | Critical (architecture §8 violation) | Per-line-item test for null-substitution path; type-system invariant `adjusted: number` (never null) catches at compile time |
| Library substitution fails for a missing asset type | Medium | High (engine throws, pipeline aborts) | Acceptance — failing loudly is correct per §15.5; document operational handling |
| Manifesto predicate evaluator has bugs in `between` / `contains` operators | Medium | Medium (specific rules may misfire) | Per-operator tests; deterministic predicate coverage |
| NOI cap math wrong | Low | High | Dedicated tests with bank-NOI-known fixture |
| Performance: rule-by-rule application on a large rent roll | Low | Low (rent rolls are 100-1000 rows max) | Profile after implementation if observed |
| Manifesto rule registry grows unboundedly (new rules added per bank) | Medium (long term) | Medium | Manifesto branded id is per-instance content hash; doesn't bloat shared types. Each manifesto's rules fire independently |
| Source-tier choice leaks legacy strings (e.g., "Seller UW Memo Page 3") | Low (typed `SourceTier` enum) | Low | Type system catches |
| Engine emits AdjustmentEntry with a typo'd ruleId | Low (literal-union type) | Low | TS compile-time |

## 18. Concrete action items before implementation

In order:

1. **Resolve open decisions §15.1 (NOI ledger)** — decide whether to add `topLevelAdjustments`
   to AdjustedInputs (Batch 1.6 contract revision) or use Option 1 (per-line-item ledger).
2. **Resolve §15.7 (applicability predicate)** — define the per-line-item applicability map
   (AssetType + extraction context → which line items apply).
3. **Decide §15.9 (cap-rate library floor)** — substitution-only or floor-with-normalization.
4. **Spec the manifesto-metric-paths.ts frozen lookup** (§8.1) — full table of metricName →
   AdjustedInputs path.
5. **Spec the predicate evaluator** (§8.2) — exact semantics for each operator including null
   handling.
6. **Implement Stage 4 + 5 + 6 as one PR** (~600 lines of code + ~58 tests).

Implementation order within the PR:
- Stage 6 (metrics derivation) helpers first — pure math, easy to test
- Stage 4 line-item adjustment functions — one per line item, each individually testable
- Stage 4 orchestrator
- Stage 5 conservatism gate
- Integration tests across the chain

## 19. Implementation NOT covered by this audit

These topics are deliberately out of scope for the pre-Batch 3 audit:
- Rent-roll-derived `top1IncomeShare` and `pctIncomeExpiringWithinTerm` math (§11) — assumed
  to be straightforward sum/filter operations; covered in implementation tests
- Loan amortization formula for `debtServiceAnnual` derivation — standard finance formula
- Logging / observability hooks at the engine boundary
- Performance characteristics
- API/route wiring (Batch 6 concern)

## 20. Sign-off requirements

Before implementation begins, the user must explicitly confirm:
- [ ] Open decisions §15.1 through §15.10 are resolved
- [ ] §16 test coverage list is acceptable as the minimum bar
- [ ] §17 risk register is acceptable
- [ ] §14 anti-patterns are acceptable (10 carry-forward + 4 new)

Without sign-off, the audit's value is lost.

*Pre-Batch 3 audit locked 2026-05-08. Subsequent revisions append below.*
