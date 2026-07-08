# Portfolio Roll-Up Workbook — Design Scoping (READ-ONLY recon)

Date: 2026-07-08
Author: recon pass (no code/DB writes, no commits, no underwrite/LLM)
Scope: a workbook for ONE loan secured by MANY properties — where the underwriting
is the *roll-up* (aggregate DSCR, blended cap/value, concentration by property /
geo / asset-class, cross-collateralization, release provisions). Contrast:
single-loan = one property, one score (validated today via Sunroad `ad9e9e90`).

Every claim below is grounded with `file:line` or a live DB query.

---

## 0. TL;DR — the verdict up front

1. **DATA MODEL: multi-property is NOT representable today. Portfolio is a real,
   net-new data-model change.** `Analysis`, `ExtractionResult`, and `DealBag`
   are each hard-wired to ONE property (one `assetType`, one `concludedValue`,
   one NOI, one `largestTenantPct`). No property array exists anywhere on the
   scoring/extraction spine. (§1)

2. **`roll_up` MODE: the axis is fully plumbed through the RENDER layer, but the
   payload it carries is a metadata STUB, not property data.** `underwritingMode
   = 'roll_up'` is a first-class four-axis selector with schema partitioning,
   fingerprints, invariants, and a required `rollUpAggregation` block — but that
   block is 4 fields of metadata (`loanCount`, `constituentLoanIds`, two
   methodology strings), populated by a literal placeholder `buildRollUpStub()`.
   The comment says it out loud: *"until a portfolio aggregator service lands."*
   The **seam is real and waiting**; the aggregator behind it is unbuilt. (§2)

3. **ROLL-UP MATH: none of it exists as portfolio math today.** All 9 doctrine
   dimensions are pure per-property functions. Aggregate DSCR / blended cap /
   concentration-across-properties / cross-collateral / release are all net-new.
   BUT the numeric inputs mostly exist per-property and can be summed — the math
   is additive-layer work, not doctrine surgery. (§3)

3b. **CONCENTRATION REUSE — the crux question, answered: NO, not reusable as-is.**
   The `income-concentration` (dim 5) and `rollover` (dim 6) machinery is
   PER-PROPERTY-INTERNAL — it measures the top *tenant* inside ONE rent roll. It
   has zero notion of a *portfolio of properties*. Portfolio concentration
   (top-property %, geo mix, asset-class mix) is a **different, net-new** metric
   that happens to share the word "concentration." (§3)

4. **TEST DATA: yes — a real multi-property loan exists to test on, and there are
   many.** `Prime Storage - Blue Portfolio` is genuinely 5 real NJ self-storage
   properties under one loan, with per-property NOI/value/occupancy already in
   `comps.db`. The corpus holds **240 component-property rows across 8 CMBS
   deals**, structured `{loanAsset}-{propertyOrdinal}`. A real end-to-end
   portfolio test is possible today. (§5)

Bottom line: this is **a genuine build, not a config flip** — but the two hardest
things (a first-class mode axis + real multi-property source data) already exist.
The missing middle is (a) a multi-property data model and (b) an aggregator
service. Phased plan in §6.

---

## 1. ★★ THE DATA-MODEL VERDICT — one property per analysis is baked in

### 1a. `Analysis` — singular everything
`packages/shared/src/types/analysis.ts:262`
- `assetType: AssetType` (line 265) — ONE asset type, not an array.
- `extractionResult?: ExtractionResult | null` (line 318) — ONE result.
- `rentRoll?: RentRoll | null` (324), `propertyMetadata?: PropertyMetadata | null`
  (328), `appraisalExtraction` (336), `sourcesAndUses` (376) — all singular,
  all one-property. There is no `properties: X[]` field anywhere.

### 1b. `ExtractionResult` — flat single-property field map
`analysis.ts:552`
```
fields: Record<CoreFieldName, ExtractedField>   // line 553
```
`CoreFieldName = 'noi'|'loanAmount'|'interestRate'|'capRate'|'propertyValue'`
(`analysis.ts:507`). ONE noi, ONE propertyValue, ONE capRate. `descriptors`,
`structural` (lines 560/565) are likewise a single `Record<...>` per property —
one `propertyName`, one `state`, one `totalSquareFeet`.

### 1c. `DealBag` — the `evaluateDeal()` input — singular
`apps/api/src/doctrine-clean/scoring/evaluate-deal.ts:50`
```
readonly assetType: string | null;         // 55  — ONE
readonly loanAmount: number | null;        // 59
readonly concludedValue: number | null;    // 61  — ONE value
readonly uwY1Noi: number | null;           // 79  — ONE NOI
readonly largestTenantPct: number | null;  // 84  — ONE property's top tenant
```
`evaluateDeal(deal: DealBag, ...)` (line 135) evaluates exactly one property's
bag and returns exactly one `RatingResult`. There is no vector input, no
per-property loop, no aggregation return.

### 1d. `AssetClassDimensionInput` — one class, one name
`apps/api/src/doctrine-clean/types.ts:126` — `assetType`, `subType`,
`propertyName` all singular. `AssetClass` (types.ts:17) is a scalar union.

### 1e. Graph record model — one property node
The record graph (`packages/contracts/src/hydrated-record-graph.ts`,
`revision-lineage.ts`) is keyed revision → doctrine-eval → extraction. The
`ExtractionResult` at the leaf is the single-property shape from §1b. One
property node per revision; no property fan-out.

### 1f. The ONLY multi-property-aware surface today: the EX-102 parser
`apps/api/src/scripts/clean-corpus-ex102-parser.ts:520`
```
const multiPropertyCount = (block.match(/<property>/g) ?? []).length;
if (multiPropertyCount > 1) quirks.push(
  `multi-property asset (${multiPropertyCount} <property> children) —
   composer must aggregate property-level fields`);       // :521
```
The SEC Schedule AL (EX-102) source data is *natively* one-loan-many-properties
(`<property>` children under one asset). The parser SEES this and flags it — but
the DealBag it collapses into is single-property (it aggregates/samples down).
So the multi-property signal is *present at ingest and thrown away at the model
boundary*.

### VERDICT
**A multi-property loan is NOT representable in the scoring/extraction data model
today.** "One analysis = one property" is baked into `Analysis`,
`ExtractionResult`, `DealBag`, and the graph leaf. Portfolio requires a real
data-model addition (a property collection + a portfolio/loan-level container).
This is the load-bearing net-new item — everything else sequences off it.

---

## 2. ★★ THE `roll_up` MODE — plumbed as an axis, stubbed as a payload

### 2a. It is a genuine first-class selection axis (not just an enum value)
- `VALID_UNDERWRITING_MODES: UnderwritingMode[] = ['single_loan', 'roll_up']`
  — `apps/api/src/routes/render.routes.ts:99`; required query param, no implicit
  default (`render.routes.ts:649-667`).
- Four-axis schema index: `(contractVersion, assetClass, structuralVariantKey,
  underwritingMode)` — `render-schema.ts:3123`, `definitionFor()` at `:3141`
  selects by `def.underwritingModes.includes(underwritingMode)`.
- Mode-partition invariant: every variant MUST have exactly one
  `SchemaDefinition` per mode; boot-time check throws otherwise
  (`render-schema.ts:3194-3220`). Canonical fingerprints are keyed by mode
  (`render-schema.ts:3975`, `fingerprintKey`).
- Render service enforces the mode↔payload invariant HARD:
  `render.service.ts:94-107` — `roll_up` REQUIRES `rollUpAggregation` non-null;
  `single_loan` FORBIDS it. Two distinct `RenderSchemaError`s.

### 2b. But every schema definition serves BOTH modes identically
Grep of `render-schema.ts`: **every** `underwritingModes:` declaration is
`['single_loan', 'roll_up']` (lines 456, 530, 612, 1551, 1842, 1954, 2011,
2082, 2155, 2212, 2275, 2364, 2420, 2480, 2552, 2605, 2686, 2745, 2911). There
is currently **no roll-up-specific SchemaDefinition** — no roll-up-only tab, no
divergent structure. The doctrine at `render-schema.ts:49-55` is explicit:
> "'roll_up' is an execution / aggregation layer ON TOP of the same [structure]…
>  the difference is the SENTINEL values in single_loan (rollUpAggregation ===
>  null) and the populated values in roll_up."

So today `roll_up` = single_loan structure + a metadata block. No portfolio tabs.

### 2c. The `rollUpAggregation` payload is a 4-field METADATA stub
`packages/shared/src/types/underwriting-context.ts:136`
```
interface RollUpAggregation {
  loanCount: number;                         // 138
  aggregationMethodology: NarrativeValue;    // 140
  normalizationCommentary: NarrativeValue;   // 142
  constituentLoanIds: string[];              // 144
}
```
Note: this is **metadata about how you aggregated**, plus a *loan* ID list — it
carries NO per-property numbers. Even the docstring (137-145) says numeric
portfolio aggregates are meant to "flow through AdjustedInputs (the metric block
IS the aggregated portfolio)" — i.e. the design intent is that the render reads
ONE already-aggregated metric block, never N property blocks. There is no
property-level surface in the render context at all.

### 2d. It is populated by a hard-coded placeholder
`apps/api/src/services/hydrate-underwriting-context.ts:324`
```
function buildRollUpStub(): RollUpAggregation {
  // Single-loan deals export with rollUpAggregation === null. Roll-up mode
  // requires a populated block; until a portfolio aggregator service lands,
  // ship a deterministic placeholder so the render-service invariant
  // (rollUpAggregation iff mode === 'roll_up') holds.
  return { loanCount: 1, aggregationMethodology: 'DATA_NOT_PROVIDED',
           normalizationCommentary: 'DATA_NOT_PROVIDED', constituentLoanIds: [] };
}
```
Wired at `hydrate-underwriting-context.ts:362`:
`rollUpAggregation: s.mode === 'roll_up' ? buildRollUpStub() : null`.
The resolver flattens it to sentinels when absent
(`resolve-underwriting-context.ts:377` `rollUpFlatten`; migration note
`render-migrations.ts:141` emits `DATA_NOT_PROVIDED` when null).

### `roll_up` REAL STATE
**SEAM built, ENGINE not.** The mode axis, schema partitioning, invariants,
fingerprints, and the required-block contract are all real and enforced. What's
missing is (a) any roll-up-specific SchemaDefinition (portfolio/concentration
tabs), and (b) the "portfolio aggregator service" the stub is a placeholder for.
`roll_up` today renders the single-loan structure with a `loanCount:1` /
`DATA_NOT_PROVIDED` metadata block. **This is exactly the seam to build behind.**

---

## 3. ★ THE ROLL-UP MATH — spec + where it lives

All 9 dimensions are pure per-property functions of a single `DealBag`
(`evaluate-deal.ts:135-…`). None takes a portfolio. The math below is a **new
aggregation layer that runs BEFORE / AROUND `evaluateDeal`**, not inside a dim.

| Metric | Input exists today? | Basis / where math lives |
|---|---|---|
| **Aggregate DSCR** | YES per-property (`uwY1Noi`, `t12Noi` on DealBag; NCF via `normalizeSustainableCashflow`). Loan debt service is one number. | Σ(property sustainable NCF) ÷ ONE loan debt service. New portfolio-aggregator step; reuses `normalizeSustainableCashflow` per property, then sums. |
| **Blended / weighted cap rate + value** | YES per-property (`concludedValue`, `uwY1Noi`, `capRate`). | Two honest bases to pick: value-weighted (Σ value) vs NOI-weighted blended cap (Σ NOI ÷ Σ value). comps.db already stores per-property `value` + `noi` (see §5) → blended cap is directly computable. New aggregator. |
| **Portfolio value** | YES | Σ per-property concludedValue; feeds one portfolio LTV vs one loanAmount. New aggregator. |
| **Top-property concentration %** | data exists (per-property `value`/`loanPieceAmount`), machinery does NOT | max(propertyValue)/Σ value, or allocated-loan share. **Net-new metric.** NOT the dim-5 machinery (that's per-tenant, see below). |
| **Geographic concentration** | data exists (per-property `state`/`city`/`county` in comps.db + `ExtractionResult.descriptors.state`), machinery does NOT | % of value/NOI by state/MSA; a Herfindahl over geo. **Net-new.** |
| **Asset-class mix** | data exists (per-property `propertyType`), machinery does NOT | % of portfolio by asset class; a mixed-collateral loan has N classes where single-loan has 1 (`AssetClass` scalar, types.ts:17). **Net-new** — and note dim-8 asset-class scoring assumes ONE class (`asset-class.ts` takes one `assetType`), so a portfolio needs a *dominant-class or weighted-class* policy decision. |
| **Cross-collateralization** | NO modeling hook | No field, no dim. The whole-loan is cross-collateralized by construction; the parser flags pari-passu (`ex102-parser.ts:517`) but that's cross-*shelf* not cross-*property*. **Net-new** (structural flag + its risk treatment). |
| **Release provisions** | NO hook | A property can be released from the pool (release price, min-DSCR/LTV post-release test). No field, no dim, no stress hook. **Net-new** — this is genuinely portfolio-only risk (releasing the best asset degrades the residual pool). |

### The concentration REUSE question — decisive
`income-concentration` (dim 5) and `rollover` (dim 6) do NOT operate at the loan
level across properties. They are **per-property-internal**:
- dim 5 input `IncomeConcentrationInput` (`income-concentration.ts:99-124`):
  `assetType` (scalar), `largestTenantPct` (ONE property's top *tenant*),
  `largestTenantBasis`, optional `topNTenantShares` (tenants within one rent
  roll). Bands (`:160-202`) measure single-*tenant* dominance of ONE property's
  income. Zero notion of multiple properties.
- dim 6 `rollover` (`rollover.ts:89,95,104`): `pctIncomeExpiringWithinTerm`
  (scalar), `assetType` (scalar), `tenantDataStatus` — again ONE property's
  lease-rollover share.

The sweep observation ("concentration/rollover fire for retail, N/A for MF") is
the **applicability gate by asset type** (`income-concentration.ts:219-238`
returns `not-applicable-by-asset-type` for Multifamily/Hotel/SelfStorage/MHC) —
it is NOT portfolio behavior. **Verdict: the concentration MACHINERY is not
reusable for portfolio concentration.** Portfolio-level concentration (by
property / geo / asset-class) is a *new metric family*. What IS reusable is the
*pattern* — the banded-tier + Herfindahl-hook shape (`income-concentration.ts:293`
already sketches `herfindahlIndex`) is a clean template to copy for a new
`portfolio-concentration` dimension.

---

## 4. ★ TAB DELTA — against the 15-slot single-loan structure

Single-loan slots (`render-schema.ts:117-150`, `SHEET_SLOTS`):

| # | Slot | Single-loan role | Portfolio role |
|---|---|---|---|
| 1 | Property_Loan_Summary | one property + the loan | **Split**: loan-level summary STAYS (one loan); property facts → per-property ×N |
| 2 | Conclusion_Escrows | one property conclusions/escrows | per-property ×N (escrows often pooled → also a roll-up view) |
| 3 | Property_Detail | one property (`Comm`/`MF SS MHP`/`Hotel`) | **per-property ×N** (N detail sheets; class varies per property) |
| 4 | Operating_ProForma | one property T12/UW ladder | **per-property ×N** + a **NEW blended pro-forma** roll-up sheet |
| 5 | Stress_Scenario | one property stress | portfolio stress (+ release-sensitivity) — **new roll-up variant** |
| 6 | Third_Party_Reports | one property's appraisal/PCA/env | per-property ×N |
| 7 | Borrower | one borrower/sponsor | STAYS (one borrower for the loan) |
| 8 | Market | one property's market | per-property ×N (properties span markets) |
| 9 | Site_Inspection | one property | per-property ×N |
| 10-12 | Comparables (Lease/Sales/CMBS) | one property's comps | per-property ×N (comps are per asset) |
| 13 | Rent_Roll | one property rent roll | **per-property ×N** |
| 14 | Cover_Page | deal cover | STAYS (one loan) |
| 15 | Ten_Year_Pro_Forma | one property 10-yr | **per-property ×N** + a **NEW portfolio 10-yr** roll-up |

**NEW roll-up-only tabs (net-new SchemaDefinitions for `underwritingMode:['roll_up']`):**
- **Portfolio Summary** — loanCount, Σ value, portfolio DSCR/LTV/DY, blended cap,
  constituent list (the honest home of `RollUpAggregation`).
- **Concentration** — top-property %, geo mix, asset-class mix (the net-new dim).
- **Allocation & Release Schedule** — per-property allocated loan amount, release
  prices, post-release covenant tests.
- **Blended Metrics / Pro-Forma** — the aggregated operating view.

Structural implication: today ALL definitions serve both modes with ONE structure
(`render-schema.ts:49-55`). Portfolio breaks that — it needs roll-up-only
definitions (mode `['roll_up']`) AND a per-property REPETITION mechanism the
schema has no concept of today (the four-axis index has no "property N" axis).
Repetition is the deepest render-layer net-new: either a 5th axis
(`propertyOrdinal`) or a nested-workbook composition. **This is the single
biggest render-side unknown and should be spiked early.**

---

## 5. ★ TEST DATA — a real multi-property loan exists (several)

`comps.db` (`data/comps/comps.db`) schema: `comps` table, PK `(cik,
assetNumber)`; 889 rows; each row = ONE property.

**Component-property pattern found:** parent loan rows have integer
`assetNumber` (e.g. `19`); constituent properties have `{n}-{ordinal}` (e.g.
`19-001`…`19-005`). Live query results:

**Prime Storage - Blue Portfolio** (the sweep-named deal) — GENUINELY multi-property:
```
assetNumber  propertyName                 city         state  netRentableSF  value       noi         occ
19           Prime Storage - Blue Portfolio            NJ     247112         91,200,000  5,288,725   0.925   ← loan rollup
19-001       Prime Storage - Union City   Union City   NJ     69217          29,000,000  1,799,399   0.954
19-002       Prime Storage - Jersey City  Jersey City  NJ     44841          21,500,000  1,201,226   0.933
19-003       Prime Storage - Newark       Newark       NJ     62563          19,500,000  1,191,855   0.909
19-004       Prime Storage - Hoboken      Jersey City  NJ     34064          13,500,000    706,231   0.876
19-005       Prime Storage - Garfield     Garfield     NJ     36427           7,700,000    390,013   0.930
```
Real per-property NOI, value, SF, occupancy — the `19` row IS the roll-up
(247,112 SF ≈ Σ components; $91.2M value; $5.29M NOI ≈ Σ). **This is a complete,
real, self-consistent portfolio test fixture** — you can validate an aggregator
against the pre-computed `19` rollup row.

**Rechler "Rancho Bernardo Technology Portfolio"** (the other sweep name):
present as loan `18` (BANK 2024-BNK47) — but only the ROLLUP row is in the corpus
(no `18-00x` component rows captured for it). "Portfolio" here is in the *name*;
its per-property breakout wasn't parsed. So Rechler is a NAME-ONLY portfolio in
comps.db; **Prime Storage-Blue is the one with real per-property data.**

**Corpus depth:** 240 component-property rows across 8 CMBS deals:
```
BANK 2024-BNK47:38  BANK5 2024-5YR5:2   BANK5 2025-5YR15:43  BANK5 2025-5YR19:59
BBCMS 2024-C28:6    BMO 2024-C8:18      Benchmark 2024-V8:54 WFCM 2024-5C1:20
```
Plenty of multi-property loans (retail net-lease pools, MF/MHC pools, industrial
pools, self-storage pools) to test asset-class-mix and geo-concentration on.

**TEST-DATA ANSWER: YES.** A real end-to-end portfolio test is possible today.
Prime Storage-Blue (5 NJ self-storage props, one loan, full per-property numbers,
plus a pre-computed rollup row to check against) is the recommended fixture.

---

## 6. REUSE vs NET-NEW + phased plan

### The clean seam
Portfolio = **`evaluateDeal()` (or `normalizeSustainableCashflow`) run PER
PROPERTY + a NEW aggregation layer on top**, feeding the (already-enforced)
`roll_up` render axis. The doctrine dims do NOT need rewriting — they're pure and
per-property, which is exactly what a "run per property then aggregate" design
wants. The doctrine does NOT itself assume single-property in a way that blocks
reuse; the *data model and the render structure* are what assume it.

### Reusable NOW (no change)
- The `roll_up` mode axis + schema partitioning + invariants + fingerprints
  (`render-schema.ts`, `render.service.ts:94-107`) — the seam is built.
- Per-property scoring: `evaluateDeal` / `normalizeSustainableCashflow` /
  all 9 dims — run them per property unchanged.
- The EX-102 multi-property parser signal (`ex102-parser.ts:520`) — already
  detects `<property>` children; today it collapses them. Un-collapse it.
- comps.db component-property rows as the test corpus (§5).
- The banded-tier + Herfindahl-hook pattern (`income-concentration.ts:160,293`)
  as a template for the new portfolio-concentration dim.

### Genuinely NET-NEW
1. **Multi-property data model** (load-bearing): a `PropertyExtraction[]` (or
   `properties: X[]`) collection + a portfolio/loan container. Touches
   `Analysis`, `ExtractionResult`, and a new portfolio DealBag.
2. **Portfolio aggregator service** (the thing `buildRollUpStub` is a placeholder
   for): Σ NCF, blended cap/value, portfolio DSCR/LTV/DY, and populates a REAL
   `rollUpAggregation` (needs enriching beyond its 4 metadata fields, or a
   sibling numeric block).
3. **Portfolio-concentration dimension(s)**: top-property %, geo, asset-class mix
   — new, not the dim-5/6 reuse.
4. **Cross-collateral + release modeling**: new structural flags + a
   release-sensitivity stress.
5. **Render: per-property repetition + roll-up-only tabs** — the 5th-axis /
   nested-composition question (§4); the deepest render unknown.
6. **Asset-class policy for mixed collateral**: dim-8 assumes one class; decide
   dominant-class vs weighted-class for the portfolio score.

### Suggested sequencing
- **Phase 0 (spike):** un-collapse the EX-102 parser to emit per-property rows
  for Prime Storage-Blue; prove N-property data can round-trip. Answer the render
  repetition question (5th axis vs nested workbook) on paper. No model change yet.
- **Phase 1 (data model):** add the multi-property collection + portfolio
  container to `Analysis`/`ExtractionResult`. Backwards-compatible (single-loan =
  1-element collection or the existing singular path untouched).
- **Phase 2 (aggregator):** build the portfolio aggregator; run `evaluateDeal`
  per property, sum to portfolio DSCR/LTV/DY/blended-cap; populate a real
  `rollUpAggregation`. Validate against the `19` rollup row.
- **Phase 3 (concentration + structure):** portfolio-concentration dim(s);
  cross-collateral flag; release-sensitivity stress; mixed-class policy.
- **Phase 4 (render):** roll-up-only SchemaDefinitions (Portfolio Summary /
  Concentration / Allocation-Release / Blended) + per-property repetition; wire
  through the already-enforced `roll_up` axis. Contract-version bump.

---

## Appendix — evidence index
- Data model singular: `analysis.ts:262,265,318,507,552-553`;
  `evaluate-deal.ts:50,55,59,61,79,84,135`; `doctrine-clean/types.ts:17,126`.
- Parser sees multi-property: `clean-corpus-ex102-parser.ts:517,520-527`.
- `roll_up` axis: `render.routes.ts:99,649-667`; `render-schema.ts:49-55,
  3123,3141,3194-3220,3975`; `render.service.ts:94-107`.
- `rollUpAggregation` stub: `underwriting-context.ts:136-145,237`;
  `hydrate-underwriting-context.ts:324-335,362`;
  `resolve-underwriting-context.ts:377`; `render-migrations.ts:141`.
- Concentration/rollover per-property: `income-concentration.ts:99-124,
  160-202,219-238,293`; `rollover.ts:89,95,104`.
- 15 slots: `render-schema.ts:117-150`.
- Test data: `data/comps/comps.db` (PK `(cik,assetNumber)`; 889 rows;
  Prime Storage-Blue `19` + `19-001..005`; 240 component rows / 8 deals).
