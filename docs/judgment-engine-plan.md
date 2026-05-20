# Judgment Engine Pipeline Plan — v2 (locked)

Roadmap for completing the contracts-spine → end-to-end-pipeline transition.
Locked on 2026-05-08. Subsequent revisions append; do not rewrite this file in place.

---

## 1. Where the spine is today

Current state across the 13-stage locked architecture (extraction → library → asset profile →
judgment → conservatism → metrics → cross-check → stress → valuation → doctrine → hydration →
resolver → render):

| Stage | Contract | Producer status |
|---|---|---|
| 1  Extraction               | ❌ no contract | Legacy `data-extraction.service.ts` + `ai-analysis.service.ts` (untyped) |
| 1.5 NarrativeFacts          | ✅ contract   | ❌ no producer |
| 2  Library snapshot pin     | ✅ contract   | ❌ no producer (`approved_deals` table exists per architecture §4 but unused) |
| 3  Asset profiler           | ✅ contract   | ✅ producer + 20 tests |
| 4  Judgment engine          | ✅ contract   | ❌ no producer (sketch reviewed and rejected — see §6) |
| 5  Conservatism gate        | ✅ error type | ❌ no producer |
| 6  Metrics derivation       | (folded into Stage 4) | ❌ no producer |
| 7  Cross-check              | ✅ contract   | ✅ parallel producer (consumes legacy inputs) + 26 tests |
| 8  Stress engine            | ✅ contract   | ✅ producer + 37 tests (currently consumes synthetic AdjustedInputs) |
| 9  Valuation engine         | ✅ contract   | ❌ no producer |
| 10 Doctrine evaluator       | ✅ contract   | ❌ no producer (reason catalogue shipped, scoring engine not) |
| 11 Hydration                | (existing)    | ⚠ legacy, predates contracts |
| 12 Resolver                 | ✅ locked     | ⚠ legacy, locked, no changes allowed |
| 13 Render                   | ✅ existing   | ⚠ schema needs additions for doctrine outputs |

**Headline:** the spine is structurally complete (types, identity, persistence, boot drift,
scoring catalogue, asset profiler) but no real analysis flows through it end-to-end yet.

What's been shipped (4-step group complete on 2026-05-08):

- `@cre/contracts` package — 22 source files, ~1,200 lines, types-only, strict TS
- Identity: content-hash PKs, branded record-id types, `ContentHashFn` signature
- Versioning: 5 axes, runtime constants, `analysisAsOfDate` plumbed
- Boot drift detection: 3 fail-fast invariants (weight sum, rule coverage, hash drift)
- Persistence: 7 content-addressable tables, FK chain, insert-only via `ON CONFLICT(id) DO NOTHING`
- Cross-check producer (parallel — legacy still runs)
- Stress engine extension (TENANT_REMOVAL + OCC_RENT_CONCESSION)
- Asset profiler
- Doctrine reason catalogue (55 codes)

Test coverage: 133 assertions across 7 suites + 1 boot-time invariant check.

---

## 2. Six-batch plan

### Batch 1 — Contract foundations *(~3S; one PR)*

Three contract-only additions. Pure types + frozen registries. No producers, no behavior.

- **`ExtractionResult` contract.** Per-document subsections (rentRoll, t12, pca, appraisal, asr,
  sellerUw, loanTerms). Each carries `present: boolean` + extracted fields (every field
  `number | null` or `string | null`; no `any`). Drives §1 missing-doc penalties via the
  presence ledger.
- **`JudgmentEngineRules` registry.** Frozen rule registry parallel to `DoctrineRules`. Replaces
  the brand-typed `JudgmentEngineRuleId = string & { __brand }` placeholder with a real
  literal union. Boot check extended to verify hash drift on this registry.
- **`CreditManifesto` contract migration.** From `@cre/shared/uw-intelligence` to
  `@cre/contracts/manifesto`. Adds `ManifestoVersion` axis + snapshot pattern.

Outputs: 3 new files in contracts; 1 new boot-check assertion; ~30 fresh tests covering enum
completeness + drift.

### Batch 2 — LibrarySnapshot producer *(~2S; alone — real data)*

Real implementation reading `approved_deals`. Computes per-asset-type distributions (median,
p25, p75) for vacancy, expense ratio, cap rate, dscr, treasury_10y. `n < 20` → `null` for that
asset type (degraded mode per architecture §4). Hashes source-table state. Persists via
`recordGraphStore.insertLibrarySnapshot`.

**Why alone:** first new producer that touches the legacy database. Surfaces whether
`approved_deals` schema actually matches architecture §4 columns. Schema mismatches must
resolve before downstream stages depend on the snapshot.

Outputs: 1 producer service + ~15 tests + a one-shot script to seed the table from a fixture
if the live database is empty.

### Batch 3 — Judgment + Conservatism + Metrics *(~5S; one heavy PR)*

The heart. Three stages ship together because they're operationally inseparable: Stage 4 emits
AdjustedInputs (with metrics folded in), Stage 5 verifies, Stage 6 collapsed into Stage 4.

- **Stage 4 — Judgment engine.** `applyJudgmentAdjustments(extraction, assetProfile,
  librarySnapshot, manifesto, asOfDate) → AdjustedInputs`.
  - Per-line-item adjustment functions (income, expenses, capital reserves, loan, assumptions).
  - Library-relative normalization (vacancy ≥ max(library median, bank vacancy), etc.).
  - Manifesto rule application (each enabled rule → AdjustmentEntry with ruleId).
  - Missing-doc penalties → `confidenceReduction` via §1 weights (RentRoll 12, T12 12, LoanTerms
    10, PCA 6, Appraisal 4; max sum normalized to 1.0).
  - Source-tier preference (BANK > T12_ACTUAL > APPRAISAL > SELLER_UW > ASR), with distrust
    AdjustmentEntries when lower tier used.
  - Metrics derived (NOI, DSCR, value, LTV, debtYield, expenseRatio, top1IncomeShare,
    pctIncomeExpiringWithinTerm).
  - Stamp + persist via `recordGraphStore.insertAdjustedInputs`.

- **Stage 5 — Conservatism gate.** `verifyConservatism(adjusted, library): void`. Throws
  `ConservatismViolationPayload`. Three checks:
  - adjusted vacancy ≥ max(library median, raw bank vacancy)
  - adjusted expense ratio ≥ max(library median, raw bank expense ratio)
  - adjusted NOI ≤ raw bank NOI (unless explicit driver justification in adjustments ledger)

- **Stage 6 — Metrics derivation.** Folded into Stage 4. AdjustedInputs ships with `metrics`
  populated; no separate producer.

Review burden is intentionally concentrated. The alternative (splitting) means downstream
stages would consume half-finished AdjustedInputs and have to re-validate.

**Audit checkpoints:** pre-implementation design review + post-implementation rule-by-rule
review. Highest-leverage audit moments in the entire plan.

Outputs: 2 producer services (judgment + conservatism) + ~80 tests covering per-rule firing,
null preservation, library-relative floors, manifesto rule application, missing-doc weight
normalization, idempotency, content-hash stability, FK chain.

### Batch 4 — Valuation engine *(~2S)*

`buildValuationConclusion(adjustedInputs, stressOutputs, narrativeFacts) → ValuationConclusion`.

- `uwValue = NOI / capRate.adjusted`
- `marketValue = NarrativeFacts.marketValueFromComps` (or null)
- `downsideValue = stressNoi / exitCapRateStressed` (worst stress scenario)
- `finalValue = min_non_null(uwValue, marketValue, downsideValue)` post-caps
- §9 guardrails:
  - cap to 1.10× anchor if `uwValue > 1.20×` of anchor → flag `OVERVALUATION_GUARDRAIL_TRIGGERED`
  - exit cap < appraisal cap → flag `EXIT_CAP_TOO_TIGHT`
  - single-tenant or top1 ≥ 70% → 50% dark-value haircut → flag
    `SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED`

Outputs: 1 service + ~20 tests covering anchor caps, haircuts, downside arithmetic,
idempotency, FK chain.

### Batch 5 — Doctrine evaluator *(~5S; second-heavy PR)*

The scoring engine. `buildDoctrineEvaluation(adjustedInputs, narrativeFacts, assetProfile,
crossCheck, stress, valuation, library) → DoctrineEvaluation`.

Substages 10a–10g per spec:

- 10a Component scoring (8 components: mechanical, durability, normalization, capitalization,
  market_alignment, term_risk, maturity_risk, data_confidence)
- 10b Weighted aggregation (weights from contracts: 10/30/15/20/10/7/5/3 = 100)
- 10c Valuation guardrail flags (read from `ValuationConclusion.capsApplied[]` and
  `haircutsApplied[]`)
- 10d Asset-type adjusters (Office, Retail, Hotel, SelfStorage, MHC; 9 rules total per
  `DoctrineRules` registry)
- 10e Score adjuster (False_negative_guard / False_positive_guard, ±25 envelope enforced via
  `SCORE_ADJUSTMENT_ENVELOPE` constant)
- 10f Rating-band assignment (`≥75/60/50/0` per `RATING_BANDS`)
- 10g Reason-code projection (bounded enum from `DoctrineReasonCodes`)

**Audit checkpoint:** pre-implementation design review of asset-type adjusters + ±25 envelope.

Outputs: 1 service (probably split into multiple files under `services/doctrine/` — engine,
components/, asset-type-adjusters/, score-adjuster, rating-bands) + ~80 tests.

### Batch 6 — Rollout *(~4S; integration PR)*

Wires the spine into the existing api. Splits into ordered sub-steps within the PR:

1. **Cross-check refactor.** `cross-check-contracts.service.ts` rewires to consume
   `ExtractionResult + AdjustedInputs` instead of legacy `SellerExtractedMetrics +
   UnderwritingModel`. Drivers populate from `AdjustedInputs.adjustments[]` (no longer empty).
2. **Stress engine refresh.** Existing `stress-test-contracts.service.ts` rewires tests against
   real producer output (no longer synthetic fixtures).
3. **Hydration update.** Existing `hydrate-underwriting-context.ts` updates to consume new
   producers (AdjustedInputs, ValuationConclusion, StressOutputs, DoctrineEvaluation,
   NarrativeFacts).
4. **Render schema additions.** Bindings for doctrine outputs. Requires `RENDER_CONTRACT_VERSION`
   bump + append-only `render-migrations.ts` entry. Goes through existing version-bump
   discipline. Migration entry must cover every (assetClass, structuralVariantKey,
   underwritingMode) tuple.
5. **Pipeline orchestrator.** New file `apps/api/src/services/pipeline/run-pipeline.ts` (parallel
   to legacy `underwriting-pipeline.service.ts`). Calls every stage in order, persists each at
   its boundary.
6. **End-to-end smoke** on a real fixture analysis.
7. **Legacy cutover.** Delete legacy services after smoke is green:
   `cross-check.service.ts` (legacy), legacy stress, `analysis-to-adjusted-inputs.adapter.ts`,
   any commentary-emitting paths.

Outputs: orchestrator + 4 refactored services + render-schema migration + ~40 integration tests.

---

## 3. Total scope

| Batch | Size | Cumulative |
|---|---|---|
| 1 — Contracts                              | 3S | 3S  |
| 2 — LibrarySnapshot                        | 2S | 5S  |
| 3 — Judgment + Conservatism + Metrics      | 5S | 10S |
| 4 — Valuation                              | 2S | 12S |
| 5 — Doctrine evaluator                     | 5S | 17S |
| 6 — Rollout                                | 4S | 21S |

S unit ≈ asset-profiler scale (~80–150 lines + ~15 tests). Total remaining ≈ ~21S equivalents.
Already shipped (4-step group) ≈ 4S. Remaining work is **~5×** what's done.

---

## 4. Audit checkpoints

Three. Compressed from v1's five.

1. **Pre-Batch 3 — design review** of per-line-item adjustment logic. Catches null-handling
   errors before they're embedded in 500 lines of judgment-engine code.
2. **Post-Batch 3 — implementation review** of every rule branch before downstream stages
   depend on the output. Highest-leverage audit moment in the entire plan.
3. **Pre-Batch 5 — design review** of asset-type adjusters + ±25 envelope.

End-to-end smoke is part of Batch 6, not a separate audit.

---

## 5. Decision points still open before Batch 1

Six decisions to be settled before drafting Batch 1.

1. **`ExtractionResult` granularity** — per-document subsections (recommended) vs flat field map.
2. **`JudgmentEngineRules` namespace** — JE-prefix rules (`JE_SELLER_UW_USED_...`) to avoid name
   collisions with `DoctrineRules` (recommended) vs accept overlap.
3. **`CreditManifesto` predicate format** — keep legacy free-form `condition` strings for v1.0
   (recommended) vs structure as data now.
4. **Stage 6 fold-in** — fold metrics into Stage 4 as a single producer (recommended) vs keep
   as separate Stage 6 producer.
5. **Pipeline orchestrator location** — new file `services/pipeline/run-pipeline.ts` parallel
   to legacy (recommended) vs replace `underwriting-pipeline.service.ts` directly.
6. **Test fixture strategy** — introduce `apps/api/src/test-utils/fixtures.ts` in Batch 1
   (recommended; pays off by Batch 3) vs defer.

---

## 6. Anti-patterns to avoid (carry-forward from architecture contract)

These are the named violations to reject on sight in any future PR:

1. **`null → 0` coercion** in any line-item adjustment (architecture §8). Hard ban. Returning
   `0` for missing T-12 NOI is the canonical anti-pattern. Use `null` propagation + explicit
   missing-data penalty AdjustmentEntry.
2. **Hardcoded baseline values** substituting for library distributions (architecture §4).
   `estimateMarketVacancy() → 0.05` is the canonical anti-pattern. Always read from
   `LibrarySnapshot.byAssetType[X].vacancy.median`.
3. **Missing manifesto integration** in Stage 4 (architecture §5). The judgment engine signature
   takes `manifesto` for a reason; passthrough implementations are wrong.
4. **Stage 3 / Stage 4 conflation.** Asset profile classification belongs in
   `asset-profiler.service.ts`. Judgment engine takes `AssetProfile` as input.
5. **`adjustments: string[]`** as the AdjustmentEntry type. Drivers are
   `{ ruleId: JudgmentEngineRuleId, delta: number, reason: string }`. Strings can't substitute.
6. **Above-line / below-NOI conflation.** Recurring capex and TI/LC reserves go in
   `capitalReserves`, NOT in operating expenses. Conflating them deflates NOI silently.
7. **No replay key on persisted records.** Every record needs `id, analysisAsOfDate,
   <stageEngineVersion>` and FK fields to upstream records.
8. **`any` types** on the boundary surfaces. Replace with typed `ExtractionResult`,
   `LibrarySnapshot`, etc.
9. **Asset-class branches in resolver** (locked invariant). The resolver is shape-only.
10. **Doctrine logic outside `services/doctrine/`** (locked invariant). All scoring logic in
    one directory.
11. **Free-form prose in `DoctrineEvaluation.reasons[]`.** Bounded reason codes only;
    catalogue lookup happens at render time.
12. **Re-running cross-check inside doctrine.** Doctrine binds to `CrossCheckResult.findings[]`,
    never re-derives deltas.
13. **Re-running valuation inside doctrine.** Doctrine binds to `ValuationConclusion`, never
    recomputes `final_value`.
14. **Re-running stress inside doctrine.** Doctrine binds to `StressOutputs.scenarios[]`,
    never defines stress math.
15. **Mutating `AdjustedInputs` post-Stage-4.** Immutable. Every consumer takes
    `Readonly<AdjustedInputs>`.

---

## 7. Pointer to current shipped code

Spine code already in place (do not regress):

- `packages/contracts/` — 22 files, types only
- `apps/api/src/util/canonical-json.ts` — RFC 8785 (JCS) canonicalizer
- `apps/api/src/util/content-hash.ts` — `computeContentHash` + 7 record-id factories
- `apps/api/src/util/doctrine-boot-check.ts` — 3 fail-fast invariants, wired into `index.ts`
- `apps/api/src/storage/record-graph-store.ts` — 7 content-addressable tables, FK chain
- `apps/api/src/services/cross-check-contracts.service.ts` — parallel producer
- `apps/api/src/services/stress-test-contracts.service.ts` — parallel producer
- `apps/api/src/services/asset-profiler.service.ts` — Stage 3 producer
- `apps/api/src/services/doctrine/reason-catalogue.ts` — i18n catalogue (55 codes)
- `apps/api/src/scripts/test-*.ts` — 7 test scripts, 133 assertions

CI scripts wired in `apps/api/package.json`:

```
check:doctrine                  → boot-time invariants
doctrine:print-hash             → utility for version bumps
test:content-hash               → 25 assertions
test:record-graph               → 14 assertions
test:cross-check-contracts      → 26 assertions
test:stress-contracts           → 37 assertions
test:asset-profiler             → 20 assertions
test:reason-catalogue           → 10 assertions
```

---

## 8. Resumption protocol

When this plan resumes:

1. Read this file from the top.
2. Run all test scripts above to confirm spine is still green.
3. Run `npm run check:doctrine` to confirm no boot-drift.
4. Settle the 6 decisions in §5 if not already settled.
5. Begin Batch 1.

If anything in §1 (current state) appears outdated relative to the actual code, treat the code
as authoritative and update this file before proceeding.

---

*Plan v2 locked 2026-05-08. Append revisions below; do not edit above this line.*

---

## Revision v2.1 — 2026-05-08 (Batch 1 re-scoped + landed)

### Re-scope

Batch 1 reframed as the **Truth Layer**: deal reality (`ExtractionResult`) + market reality
(`MarketBenchmarks`). The original Batch 1 included `JudgmentEngineRules` and `CreditManifesto`
migration; both deferred to a new pre-Batch-3 step (call it Batch 1.5) since they are
prerequisites for Batch 3 (judgment engine), not for the Truth Layer itself.

### LibrarySnapshot conflict (resolved)

A draft of the Truth Layer proposed a flat point-value `LibrarySnapshot` shape (single number per
asset type, no distributions, no `n`). This conflicted with the already-shipped distributional
`LibrarySnapshot` (median/p25/p75/n per `AssetType`, content-hash id, degraded-mode `null`)
which is locked by architecture §4.

Resolution: existing `LibrarySnapshot` retained unchanged. The proposed flat shape became a new
type — `MarketBenchmarks` — for point-value market context (treasury rates, prevailing
cap/vacancy rates, expense PSF norms, market-liquidity indices). The two coexist with distinct
purposes:
- `LibrarySnapshot`  = distributions over historical approved deals; floor logic for §4
- `MarketBenchmarks` = point-value reference for current market conditions; informational

### What landed in Batch 1 v2.1

- `packages/contracts/src/extraction.ts` — `ExtractionResult` + 7 sub-extraction types
  (RentRoll, OperatingStatement, PCA, Appraisal, SellerUW, ASR, LoanTerms) +
  `SourceDocumentRef` + `SourceDocumentKind` enum
- `packages/contracts/src/market-benchmarks.ts` — `MarketBenchmarks` (separate from
  `LibrarySnapshot`)
- `identity.ts` — added `ExtractionResultId` + `MarketBenchmarksId` branded types
- `versioning.ts` — added `EXTRACTION_ENGINE_VERSION` constant + type
- `index.ts` — re-exports
- `apps/api/src/util/content-hash.ts` — `computeExtractionResultId` + `computeMarketBenchmarksId`
  factories
- `apps/api/src/scripts/test-extraction-contract.ts` — 56 assertions covering shape,
  null-preservation through canonical form, idempotency, every `AssetType` keyed, brand
  discrimination, source-document enumeration

### Updated stage status

| Stage | Contract | Producer status (post-v2.1) |
|---|---|---|
| 1   Extraction              | ✅ NEW (`ExtractionResult`)    | ❌ no producer |
| 1.5 NarrativeFacts          | ✅                              | ❌ no producer |
| 1.5 MarketBenchmarks (new)  | ✅ NEW                          | ❌ no producer |
| 2   Library snapshot pin    | ✅                              | ❌ no producer |
| 3   Asset profiler          | ✅                              | ✅ + 20 tests  |
| 4   Judgment engine         | ✅                              | ❌ no producer |
| 5   Conservatism gate       | ✅ error type                   | ❌ no producer |
| 7   Cross-check             | ✅                              | ✅ parallel + 26 |
| 8   Stress engine           | ✅                              | ✅ + 37 |
| 9   Valuation engine        | ✅                              | ❌ no producer |
| 10  Doctrine evaluator      | ✅                              | ❌ no producer |

### Updated total scope (estimate)

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1   Truth Layer (ExtractionResult + MarketBenchmarks)   | ✅ landed | 2S | – |
| 1.5 JudgmentEngineRules + CreditManifesto migration     | pending  | 2S | 2S |
| 2   LibrarySnapshot producer                            | pending  | 2S | 4S |
| 3   Judgment + Conservatism + Metrics                   | pending  | 5S | 9S |
| 4   Valuation engine                                    | pending  | 2S | 11S |
| 5   Doctrine evaluator                                  | pending  | 5S | 16S |
| 6   Rollout                                             | pending  | 4S | 20S |

Remaining ≈ ~20S (was ~21S in v2). Slight increase from the new Batch 1.5; offset by Batch 1
already shipping.

### Test-suite tally

| Suite | Assertions |
|---|---|
| boot check                          | 1   |
| content-hash                        | 25  |
| record-graph                        | 14  |
| cross-check producer                | 26  |
| stress engine extension             | 37  |
| asset profiler                      | 20  |
| reason catalogue                    | 10  |
| **extraction contract (new)**       | **56** |
| **Total**                           | **189** (188 assertions + boot check) |

### Notes for resumption

- Batch 1 v2.1 is fully landed; spine is green.
- Batch 1.5 (`JudgmentEngineRules` + `CreditManifesto` migration) is the next prerequisite
  before Batch 3. Decision: stand alone or fold into Batch 3 PR? Plan currently isolates as
  Batch 1.5 because the registry shape is type-system-only and worth landing before any
  producer code references it.
- `JudgmentEngineRuleId` remains the brand-typed `string & { __brand }` placeholder until
  Batch 1.5 lands. `AdjustmentEntry.ruleId` uses this placeholder.

*Revision v2.1 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.2 — 2026-05-08 (Batch 1.5 landed)

### What landed

Batch 1.5 — JudgmentEngineRules registry + CreditManifesto migration + extended boot drift
detection.

**Contracts side:**
- `packages/contracts/src/judgment-engine-rules.ts` — frozen registry (18 rules across 4
  categories per architecture §1, §4, §6, §8) + per-rule penalty constants
  (`JE_MISSING_DOC_PENALTIES`, `JE_DISTRUST_PENALTIES`)
- `packages/contracts/src/judgment-engine-manifest.ts` — append-only hash registry parallel to
  `DOCTRINE_MANIFEST`; v1.0 entry locked to `df1b90d2ba330891bf1fc324b0c3e02a87077058f15c532d681826ee6e5c1866`
- `packages/contracts/src/manifesto.ts` — `CreditManifesto` migrated from `@cre/shared`;
  drops operational metadata (fileName/uploadedBy/isActive); adds content-hash id +
  `analysisAsOfDate` + `manifestoContractVersion`; keeps free-form `condition` strings per
  the deferred decision
- `identity.ts` — added `CreditManifestoId` branded type
- `versioning.ts` — added `MANIFESTO_CONTRACT_VERSION` constant + type
- `adjusted-inputs.ts` — `AdjustmentEntry.ruleId` updated to accept the union
  `JudgmentEngineRuleId | CreditManifestoRuleId`; placeholder brand removed
- `cross-check.ts` — `CrossCheckDriver.ruleId` likewise union-typed
- `index.ts` — re-exports

**API side:**
- `util/judgment-engine-boot-check.ts` — `performJudgmentEngineBootCheck()` + typed
  `JudgmentEngineBootCheckError` (3 codes: penalty-key validity, manifest-missing-version,
  hash-drift)
- `scripts/print-judgment-engine-hash.ts` — utility for version bumps
- `scripts/check-judgment-engine.ts` — standalone CI runner
- `scripts/test-judgment-engine-rules.ts` — 45 assertions (registry shape, penalty
  alignment, architecture §1 weight values, manifest entry, boot check, category coverage)
- `scripts/test-manifesto-contract.ts` — 34 assertions (shape, idempotency, enum coverage,
  branded rule ids, threshold polymorphism, `['all']` sentinel)
- `util/content-hash.ts` — `computeCreditManifestoId` factory
- `package.json` — 4 new scripts (`check:judgment-engine`, `judgment-engine:print-hash`,
  `test:judgment-engine-rules`, `test:manifesto-contract`)
- `index.ts` — `performJudgmentEngineBootCheck()` wired in alongside `performDoctrineBootCheck()`

### Stage status updates

| Stage | Contract | Producer status |
|---|---|---|
| 1   Extraction              | ✅                              | ❌ no producer |
| 1.5 NarrativeFacts          | ✅                              | ❌ no producer |
| 1.5 MarketBenchmarks        | ✅                              | ❌ no producer |
| 1.5 JudgmentEngineRules     | ✅ NEW                          | n/a (registry, not producer) |
| 1.5 CreditManifesto         | ✅ NEW (migrated from @cre/shared) | ❌ no producer |
| 2   Library snapshot pin    | ✅                              | ❌ no producer |
| 3   Asset profiler          | ✅                              | ✅ + 20 tests  |
| 4   Judgment engine         | ✅                              | ❌ no producer |
| 5   Conservatism gate       | ✅ error type                   | ❌ no producer |
| 7   Cross-check             | ✅                              | ✅ parallel + 26 |
| 8   Stress engine           | ✅                              | ✅ + 37 |
| 9   Valuation engine        | ✅                              | ❌ no producer |
| 10  Doctrine evaluator      | ✅                              | ❌ no producer |

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1    Truth Layer                                        | ✅ landed | 2S | – |
| 1.5  JudgmentEngineRules + CreditManifesto migration    | ✅ landed | 2S | – |
| 2    LibrarySnapshot producer                           | pending  | 2S | 2S |
| 3    Judgment + Conservatism + Metrics                  | pending  | 5S | 7S |
| 4    Valuation engine                                   | pending  | 2S | 9S |
| 5    Doctrine evaluator                                 | pending  | 5S | 14S |
| 6    Rollout                                            | pending  | 4S | 18S |

Remaining ≈ ~18S (was ~20S after Batch 1).

### Test-suite tally

| Suite | Assertions |
|---|---|
| doctrine boot check                   | 1   |
| judgment-engine boot check (NEW)      | 1   |
| content-hash                          | 25  |
| record-graph                          | 14  |
| cross-check producer                  | 26  |
| stress engine extension               | 37  |
| asset profiler                        | 20  |
| reason catalogue                      | 10  |
| extraction contract                   | 56  |
| **judgment-engine rules (NEW)**       | **45** |
| **manifesto contract (NEW)**          | **34** |
| **Total**                             | **269** (267 + 2 boot checks) |

### Notes for resumption

- `JudgmentEngineRuleId` is now a real literal-union of 18 rules. The brand-typed placeholder
  is gone. `AdjustmentEntry.ruleId` and `CrossCheckDriver.ruleId` accept the union
  `JudgmentEngineRuleId | CreditManifestoRuleId`.
- `CreditManifesto` lives in `@cre/contracts/manifesto.ts`; legacy `@cre/shared/types/criteria.ts`
  shape stays in place for legacy consumers (parallel-existence pattern).
- Two boot checks now run on api startup (doctrine + judgment-engine). Each owns its hash
  manifest and bumps independently. Adding a rule to either registry without bumping its
  version → boot fails with `*_HASH_DRIFT`.
- Batch 2 (LibrarySnapshot producer) is the next critical-path item.

*Revision v2.2 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.3 — 2026-05-08 (Batch 2 landed)

### What landed

Batch 2 — `LibrarySnapshot` producer + `approved_deals` reference table + seed script.

**Storage:**
- `apps/api/src/storage/approved-deals-store.ts` — `ApprovedDealsStore` class wrapping the
  `approved_deals` table. Schema per architecture §4 (id, asset_type, vacancy_pct, expense_ratio,
  cap_rate, treasury_10y_at_close, dscr, status, closed_at). `INSERT OR REPLACE` semantics
  (reference data, not stage output). Indexes on asset_type + status. Validates asset_type
  and status against contracts on read; surfaces invalid rows as errors rather than coercing.

**Service:**
- `apps/api/src/services/library-snapshot-producer.service.ts` — `buildLibrarySnapshot({
  asOfDate, store }) → LibrarySnapshot`. Reads approved deals (status='approved' only),
  hashes the canonical row sequence, computes per-asset-type distributions
  (vacancy / expenseRatio / capRate / dscr / treasury10YAtClose), returns content-hash-stamped
  record. `n < 20` → that asset type's entry is `null` (architecture §4 degraded mode; never
  silent fallback). Linear-interpolation percentile math.
- Exports `MIN_DISTRIBUTION_N = 20` and `percentile()` helper.

**Scripts:**
- `apps/api/src/scripts/seed-approved-deals.ts` — one-shot seeder, 25 deals × 9 asset types
  = 225 deals. Deterministic per (assetType, index) for reproducibility. Refuses to run if
  table is non-empty unless `--force`. Dev/test only; not for production.
- `apps/api/src/scripts/test-library-snapshot-producer.ts` — 36 assertions: percentile math
  edge cases (linear interpolation between values, single-element, p0/p100), distribution
  build (median/p25/p75 to known values to 1e-9 precision), n<20 degraded mode (and n=20
  boundary), status filter (only approved rows count), idempotency, table-hash drift
  detection, persistence round-trip via RecordGraphStore, invalid-asset-type rejection.

**Package config:**
- `apps/api/package.json` — added `seed:approved-deals`, `test:library-snapshot-producer`.

### Stage status updates

| Stage | Contract | Producer status |
|---|---|---|
| 2   Library snapshot pin    | ✅                              | ✅ NEW + 36 tests  |

The first new producer that touches the legacy database has shipped. `approved_deals`
schema validated (matches architecture §4 columns). `LibrarySnapshot` is now physically
producible from real data.

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1    Truth Layer                                        | ✅ landed | 2S | – |
| 1.5  JudgmentEngineRules + CreditManifesto migration    | ✅ landed | 2S | – |
| 2    LibrarySnapshot producer                           | ✅ landed | 2S | – |
| 3    Judgment + Conservatism + Metrics                  | pending  | 5S | 5S |
| 4    Valuation engine                                   | pending  | 2S | 7S |
| 5    Doctrine evaluator                                 | pending  | 5S | 12S |
| 6    Rollout                                            | pending  | 4S | 16S |

Remaining ≈ ~16S.

### Test-suite tally

| Suite | Assertions |
|---|---|
| doctrine boot check                       | 1   |
| judgment-engine boot check                | 1   |
| content-hash                              | 25  |
| record-graph                              | 14  |
| cross-check producer                      | 26  |
| stress engine extension                   | 37  |
| asset profiler                            | 20  |
| reason catalogue                          | 10  |
| extraction contract                       | 56  |
| judgment-engine rules                     | 45  |
| manifesto contract                        | 34  |
| **library-snapshot producer (NEW)**       | **36** |
| **Total**                                 | **305** (303 + 2 boot checks) |

### Notes for resumption

- `LibrarySnapshot` is now consumable end-to-end: seed → store → producer → record-graph store
  → downstream stages. Tests pass without any production data (use `:memory:` stores throughout).
- The seed script writes to `data/cre.db`. To run: `npm run seed:approved-deals` (refuses if
  non-empty). Adds 225 deterministic deals across 9 asset types.
- **Pre-Batch 3 audit checkpoint** is the next gate. Per the plan, pre-implementation design
  review of per-line-item adjustment logic happens before Batch 3 (Judgment Engine + Conservatism
  Gate + Metrics). This is the highest-leverage audit moment — null-handling errors caught here
  prevent ~500 lines of downstream rework.
- Architecture §3 (single source of truth) is now physically realizable upstream of the
  judgment engine: snapshot id pins the library, and the judgment engine consumes the snapshot
  by id rather than re-querying the table at score time.

*Revision v2.3 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.4 — 2026-05-08 (Pre-Batch 3 audit + Batch 1.6 + Batch 3a landed)

### Pre-Batch 3 audit shipped

`docs/batch3-judgment-engine-design.md` — 460-line design doc covering the 20-section
rule-by-rule logic for Stage 4 + 5 + 6. 10 open decisions surfaced; 3 critical resolved
explicitly by the user; 7 adopted from audit recommendations.

**Critical decisions resolved:**
- §15.1 NOI ledger location → new `topLevelAdjustments` field on AdjustedInputs (Batch 1.6 ↓)
- §15.3 manifesto rules in v1.0 → observational only (delta=0; no value mutation)
- §15.9 cap-rate library floor direction → substitution-only (no upward normalization of raw)

### Batch 1.6 — `topLevelAdjustments` contract revision

Shipped alongside the audit decisions:
- `packages/contracts/src/adjusted-inputs.ts` — added
  `readonly topLevelAdjustments: readonly AdjustmentEntry[]` to `AdjustedInputs`.
- 3 fixture files updated (record-graph, cross-check, stress) — all add `topLevelAdjustments: []`.
- Contracts typecheck clean; no behavioral changes; no boot drift.

### Batch 3a — Per-line-item adjustment helpers

The "vocabulary" of adjustments. Pure value-shaping helpers for the 5 patterns from audit §6:

- `services/judgment/line-item-helpers.ts`:
  - `adjustSubstituteOnly` — Pattern 1
  - `adjustWithFloor` — Pattern 2 (substitute + library/bank floor)
  - `buildDerivedLineItem` — Pattern 4
  - `buildNotApplicableLineItem` — Pattern 5
  - `withDistrustPenalty` — wrapper for source-tier distrust penalties (delta=0; idempotent)
- `scripts/test-judgment-line-item-helpers.ts` — 55 assertions:
  - Pattern 1: pass-through, substitution, throw-on-double-null, raw=0 distinguishable from null
  - Pattern 2: above-floor pass-through, library-vs-bank floor selection, null + floor combination,
    null floors no-op, raw=floor boundary (no change)
  - Pattern 4: derived with raw + without raw
  - Pattern 5: not-applicable shape
  - Distrust wrapper: delta=0, idempotent, composes with prior adjustments
  - Composition: 3-adjustment ordering (substitution → floor → distrust)

Architecture rules enforced at the helper boundary:
- `adjusted: number` (never null) — null raw + null substitution → throws (no silent zero coercion)
- delta = post - pre (positive when raised, negative when lowered, zero for distrust)
- source = 'MANUAL' on substitution; preserved through floor adjustments
- raw=0 (real zero) NOT treated as missing data

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1    Truth Layer                                        | ✅ landed | 2S | – |
| 1.5  JudgmentEngineRules + CreditManifesto migration    | ✅ landed | 2S | – |
| 1.6  topLevelAdjustments contract revision              | ✅ landed | 0.5S | – |
| 2    LibrarySnapshot producer                           | ✅ landed | 2S | – |
| 3a   Per-line-item adjustment helpers                   | ✅ landed | 1S | – |
| 3b   Manifesto evaluator + library lookup + NOI cap     | pending  | 2S | 2S |
| 3c   Conservatism gate + metrics + integration          | pending  | 2S | 4S |
| 4    Valuation engine                                   | pending  | 2S | 6S |
| 5    Doctrine evaluator                                 | pending  | 5S | 11S |
| 6    Rollout                                            | pending  | 4S | 15S |

Remaining ≈ ~15S. Batch 3 split into 3a/3b/3c per the user's risk-management preference.

### Test-suite tally

| Suite | Assertions |
|---|---|
| doctrine boot check                       | 1   |
| judgment-engine boot check                | 1   |
| content-hash                              | 25  |
| record-graph                              | 14  |
| cross-check producer                      | 26  |
| stress engine extension                   | 37  |
| asset profiler                            | 20  |
| reason catalogue                          | 10  |
| extraction contract                       | 56  |
| judgment-engine rules                     | 45  |
| manifesto contract                        | 34  |
| library-snapshot producer                 | 36  |
| **judgment line-item helpers (NEW)**      | **55** |
| **Total**                                 | **360** (358 + 2 boot checks) |

### Notes for resumption

- Batch 3 split confirmed: 3a (helpers) ✅, 3b (orchestrator + manifesto + NOI cap), 3c
  (conservatism + metrics + integration).
- All 5 audit-defined patterns are now type-checked and behavior-verified. Building line-item
  builders in 3b reduces to "wire helper inputs from extraction + library + manifesto."
- Open audit decisions §15.4–§15.8 + §15.10 adopted from recommendations:
  - §15.2 confidenceReduction normalization → `/100`
  - §15.4 conservatism gate inputs → pass extraction
  - §15.5 substitution failure → throw
  - §15.6 manifesto null evaluation → Watchlist with INSUFFICIENT_DATA reason
  - §15.7 applicability predicate → per-line-item function keyed on AssetProfile
  - §15.8 LTV uses appraisal value
  - §15.10 logging → aggregate counts at engine boundary
- Post-Batch-3 audit gate per plan §F.2 happens after 3c.

*Revision v2.4 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.5 — 2026-05-08 (Batch 3b landed)

### What landed

Batch 3b — orchestration support for the judgment engine. Five new modules in
`apps/api/src/services/judgment/`:

- `source-cascade.ts` — generic `pickFirstNonNull` + per-line-item cascades for vacancy,
  cap rate, bank NOI, bank vacancy. Each cascade is data, not code; v1.0 picks the highest
  available tier without distrust detection (auto-cascade picks max-tier by construction).
- `library-lookup.ts` — type-safe wrapper around `LibrarySnapshot.byAssetType[X]`. Surfaces
  the `null` (degraded mode) path explicitly so callers route to MarketBenchmarks fallback
  or throw, never silently substitute.
- `manifesto-evaluator.ts` — predicate evaluator with frozen `METRIC_PATH_MAP` (15 paths from
  manifesto metric names to AdjustedInputs fields), per-operator predicate semantics, asset-
  type filter, null-handling (→ INSUFFICIENT_DATA outcome), `qualitative` + `between` not
  evaluated in v1.0 (also INSUFFICIENT_DATA). Outcome rule: predicate met → 'Pass'; predicate
  failed → `rule.outcome` (the rule's configured failure label). All emitted entries have
  delta=0 (observational only per audit §15.3).
- `noi-cap.ts` — implements architecture §6 NOI ceiling. v1.0 cap is unconditional; if
  `derivedNoi > bankNoi`, lower to bank NOI and emit `JE_NOI_CAPPED_TO_BANK` for inclusion in
  `topLevelAdjustments`. If `bankNoi === null`, no cap.
- `confidence-reduction.ts` — sums missing-doc + distrust penalties via
  `JE_MISSING_DOC_PENALTIES` + `JE_DISTRUST_PENALTIES` from contracts; deduplicates rule ids
  (no double-counting); normalizes by `/100` and clamps to [0, 1]. Architecture-aligned: each
  point ≈ 1% confidence reduction; max v1.0 sum (5 docs + 2 distrust) = 56 → 0.56.

### Batch 3b test coverage

`scripts/test-judgment-batch3b.ts` — 62 assertions:

- Source cascade: pickFirstNonNull semantics (zero ≠ null; all null → MANUAL); per-line-item
  cascades; T-12 vacancy derivation from grossPotentialRent; appraisal-over-ASR preference
- Library lookup: degraded mode null propagation; median + p25 access
- Manifesto evaluator: asset-type filter (specific + 'all'); Pass/Fail outcome mapping;
  Watchlist preservation; null currentValue → INSUFFICIENT_DATA; `qualitative` + `between`
  → INSUFFICIENT_DATA; unknown metricName silent skip; full operator coverage (>, >=, <, <=,
  ==, !=)
- NOI cap: no-cap, capped, null bank NOI, boundary (derived === bank); delta sign correctness
- Confidence reduction: per-rule weight lookup; empty input; 1-rule, 5-rule, 7-rule sums
  matching architecture §1; deduplication; clamp behavior

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 3a   Per-line-item adjustment helpers                   | ✅ landed | 1S | – |
| 3b   Source cascades + library lookup + manifesto + NOI cap + confidence | ✅ landed | 2S | – |
| 3c   Per-line-item builders + orchestrator + conservatism gate + metrics + integration | pending | 3S | 3S |
| 4    Valuation engine                                   | pending  | 2S | 5S |
| 5    Doctrine evaluator                                 | pending  | 5S | 10S |
| 6    Rollout                                            | pending  | 4S | 14S |

Remaining ≈ ~14S. Batch 3c grew from 2S → 3S because it absorbs the per-line-item builder
work (one builder per AdjustedInputs field; 17 fields total) that was originally split across
3b/3c.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (12 prior suites) | 358 + 2 boot checks = 360 |
| **judgment batch 3b (NEW)** | **62** |
| **Total** | **422** (420 + 2 boot checks) |

### Notes for resumption

- Batch 3a + 3b together provide all the helpers + evaluators needed by the orchestrator.
  Batch 3c writes the orchestrator + per-line-item builders + Stage 5 conservatism gate +
  Stage 6 metrics derivation as one PR.
- v1.0 manifesto rule semantic locked: predicate met → 'Pass'; predicate failed → rule.outcome.
  Banks wanting inverted semantics invert their predicates.
- `qualitative` + `between` operators surfaced as INSUFFICIENT_DATA — v1.1 needs richer
  thresholdValue typing to evaluate these.

*Revision v2.5 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.6 — 2026-05-08 (Batch 3c1 landed)

### What landed

Batch 3c1 — per-line-item builders (7 of ~17 total fields). Each builder reads source-tier
cascade from extraction, looks up library/benchmark substitution + bank floor, and calls the
appropriate 3a helper.

**File:** `services/judgment/line-item-builders.ts` (~250 lines)

**Builders shipped:**
- `buildVacancyPct` (Pattern 2 — substitute + library/bank floor)
- `buildCapRate` (Pattern 1 — substitution-only per audit §15.9)
- `buildGrossRentalIncome` (Pattern 3 — T-12 → rent-roll-derived; throws if both missing)
- `buildOtherIncome` (Pattern 3 with conservative default of 0)
- `buildLoanAmount` (Pattern 3 — throws if LoanTerms missing; no library fallback)
- `buildInterestRate` (Pattern 1 — MarketBenchmarks.baseRate fallback)
- `buildTermMonths` (Pattern 3 — derived from maturityDate − analysisAsOfDate)

**Deferred to 3c2:**
- 22 remaining builders (10 expense sub-lines, 5 capital reserves, 5 loan sub-fields,
  3 assumptions sub-fields, effectiveGrossIncome and totalOperatingExpenses derived line items)
- These need orchestrator context (other adjusted line items, asset-class applicability,
  amortization-formula derivation)

### Batch 3c1 test coverage

`scripts/test-judgment-line-item-builders.ts` — 41 assertions:
- buildVacancyPct: above-floor pass-through; library-floor; bank-floor (when bank > library);
  null + library substitution; null + library-degraded + benchmark fallback; null + both null
  → throws
- buildCapRate: raw NOT raised to library median (substitution-only); null + library
  substitution; ASR fallback when appraisal capRate is null
- buildGrossRentalIncome: T-12 source; throws when neither T-12 nor rent roll present
- buildOtherIncome: T-12 value preserved; null defaults to 0 (conservative; no rule fired)
- buildLoanAmount: from LoanTerms; throws when missing
- buildInterestRate: from LoanTerms; benchmark fallback with substitution rule
- buildTermMonths: derived from maturityDate; throws when missing

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 3c1   Per-line-item builders (subset)                   | ✅ landed | 1S | – |
| 3c2   Remaining builders + orchestrator + conservatism gate + metrics + integration | pending | 2S | 2S |
| 4    Valuation engine                                   | pending  | 2S | 4S |
| 5    Doctrine evaluator                                 | pending  | 5S | 9S |
| 6    Rollout                                            | pending  | 4S | 13S |

Remaining ≈ ~13S.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (13 prior suites) | 420 + 2 boot checks = 422 |
| **judgment line-item builders (NEW)** | **41** |
| **Total** | **463** (461 + 2 boot checks) |

### Notes for resumption

- All 7 critical line-item builders compile + verify against architecture rules.
- The "no fallback → throw" pattern (loanAmount, termMonths, GRI when truly absent) is
  consistent across builders. Pre-condition checks at the orchestrator (3c2) should fail-fast
  before builders run if required inputs are missing.
- The conservative default in `buildOtherIncome` (null → 0) is a domain-aware choice, NOT a
  null→0 coercion violation: zero is the correct value for "no other income," distinct from
  "we don't know what other income is."

*Revision v2.6 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.7 — 2026-05-08 (Batch 1.7 + 3c1 audit + cleanup landed; 3c2 design locked)

### Batch 1.7 — `RENT_ROLL` SourceTier (landed)

`packages/contracts/src/source-tier.ts` adds `'RENT_ROLL'` to the `SOURCE_TIERS` const. Boot
checks unaffected (SourceTier isn't part of either registry hash). v1.0 use: rent-roll-derived
gross rental income (sum of in-place rents × 12). v1.1 expansion: rent-roll-derived occupancy /
concessions / expense breakdown.

### Mid-batch audit — Batch 3c1 review (no new code; no doc file)

Inline audit surfaced 6 inconsistencies + 6 composition concerns + 6 open decisions. Resolved
inline:
- A.1 / C.1 Placeholder rule ids in throws-if-missing builders → add `requireRaw` helper
- A.2 `buildOtherIncome` bypass → keep as-is (domain-aware default of 0)
- A.3 / C.3 Date math inline → extract to `services/judgment/date-math.ts`
- A.4 Cascade home (B option) → reused cascades in `source-cascade.ts`; one-offs inline
- A.5 / D.1 Rent-roll source tier → add `RENT_ROLL` (Batch 1.7)
- D.4 Orchestrator persistence → return record; caller persists
- D.5 Pre-condition failure → throw with typed `JudgmentEngineError`

### Cleanup (landed)

- `services/judgment/line-item-helpers.ts` — added `requireRaw(args)` (Pattern 3 canonical
  helper). 7 new tests. Total helpers tests: 62 (was 55).
- `services/judgment/date-math.ts` — `computeMonthsBetween(fromIso, toIso)`. 9 tests.
- `services/judgment/line-item-builders.ts` — 3 builders refactored to use `requireRaw`
  (`buildLoanAmount`, `buildGrossRentalIncome`, `buildTermMonths`). Drops fake substitution
  rule ids. `buildGrossRentalIncome` rent-roll-derived path now uses `RENT_ROLL` tier.
  `buildTermMonths` uses `computeMonthsBetween`. All 41 prior tests preserve.

### Pre-Batch 3c2 audit (no new code; locked decisions)

Audit produced inline; decisions resolved by user (E.1, E.2 critical; E.3–E.6 default to
recommendations):

- **E.1 Expense sub-lines (Path A)**: if T-12 missing, substitute `totalOperatingExpenses`
  from `library.expenseRatio.median × adjustedEgi`; sub-lines (taxes, insurance, utilities,
  etc.) get adjusted=0 with source=MANUAL.
- **E.2 Asset-class applicability**: ship proposed defaults — concessionsPct iff
  Multifamily/Hotel; ioPeriodMonths iff extraction.loanTerms.interestOnlyPeriod > 0;
  upfrontCapex iff pca.immediateRepairs > 0; upfrontTiLc iff Office/Retail/Industrial AND
  rollover > 15%; monthlyCapex iff term > 60mo; payroll iff Hotel/MHC/Multifamily. Bank
  overrides via manifesto in v1.1.
- E.3 Sub-lines with totalOpEx substituted: adjusted=0 with MANUAL source (matches
  buildOtherIncome pattern)
- E.4 Amortization formula: standard P&I `M = P × (r/12 × (1+r/12)^n) / ((1+r/12)^n - 1)`
- E.5 terminalCapRate fallback: `capRate.adjusted + 50bps` if no library entry
- E.6 rentGrowthPct / expenseGrowthPct: 3% default if no seller UW

Locked orchestrator order (audit §A): pre-condition checks → missing-doc ledger → source
builders (4c) → derived builders (4d) → initial metrics (4e) → NOI cap (4f) → re-derive
NOI-dependent metrics (4g) → manifesto rules (4h, reads post-cap state) → confidenceReduction
(4i) → stamp + return (4j).

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1.7   RENT_ROLL SourceTier                              | ✅ landed | 0.2S | – |
| 3c1.5 Cleanup (requireRaw + date-math + 3-builder refactor) | ✅ landed | 0.5S | – |
| 3c2   Remaining 22 builders + applicability + orchestrator + Stage 5 + Stage 6 + integration | pending | 2-3S | 2-3S |
| 4    Valuation engine                                   | pending  | 2S | 4-5S |
| 5    Doctrine evaluator                                 | pending  | 5S | 9-10S |
| 6    Rollout                                            | pending  | 4S | 13-14S |

Remaining ≈ ~13-14S.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (12 prior suites) | 358 + 2 = 360 |
| judgment line-item builders | 41 |
| **judgment line-item helpers (UPDATED, was 55)** | **62** |
| **judgment date-math (NEW)** | **9** |
| **Total** | **479** (477 + 2 boot checks) |

### Notes for resumption

- Batch 3c2 has a fully-locked design (orchestrator order, applicability map, expense path,
  growth defaults, amortization formula). Implementation is mechanical translation.
- Estimated scope: ~250-300 lines code + ~40-50 tests. Single-PR feasible but heavy review;
  may benefit from sub-split (3c2a builders + applicability; 3c2b orchestrator + Stage 5).
- Post-Batch-3 audit gate per plan §F.2 fires after 3c2 ships.

*Revision v2.7 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.8 — 2026-05-08 (Batch 3c2a + 1.8 + cleanup landed)

### Batch 1.8 — `JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT` registry expansion

Added to `JudgmentEngineRules`. Registry now 19 rules. Manifest hash refreshed to
`543f3b27…`. Boot check passes.

### Batch 3c2a (landed)

22 new builders + 8 applicability predicates + amortization helpers (P&I formula +
maturityBalance) + sum-of-sub-lines fallback for totalOpEx. All 29 `AdjustedInputs` line items
now have a corresponding builder. Implementation per audit decisions E.1–E.6.

**New service files:**
- `services/judgment/amortization.ts` — `annualDebtService` + `maturityBalance` (standard P&I)
- `services/judgment/applicability.ts` — 8 asset-class applicability predicates
- `services/judgment/line-item-builders.ts` extended with 22 builders covering income (5),
  expenses (8), capital reserves (5), loan (7), assumptions (4)

**E.1 + E.2 corrections (post-audit):**
- `buildTotalOperatingExpenses` now sums T-12 sub-lines as a fallback before library
  substitution (handles partial T-12 extraction)
- `buildConcessionsPct` uses dedicated `JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT` rule (no
  more placeholder)

**E.3 deferred:** `buildOtherExpenses` stays at adjusted=0 in v1.0 (T-12 contract doesn't
carry an "other" field).

### Mid-batch review of 3c2a (no new code)

Inline review surfaced 4 minor concerns; 2 fixed (E.1, E.2), 1 deferred (E.3), 1 documented
(E.4 Pattern 5 vs `buildExpenseSubLine` — semantically distinct, behaviorally identical).

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1.7   RENT_ROLL                                          | ✅ landed | 0.2S | – |
| 1.8   JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT            | ✅ landed | 0.1S | – |
| 3c1.5 Cleanup (requireRaw + date-math + refactors)       | ✅ landed | 0.5S | – |
| 3c2a  22 builders + applicability + amortization helpers + sum-of-sub-lines fallback | ✅ landed | 1.5S | – |
| 3c2b  Orchestrator + JudgmentEngineError + Stage 5 + integration | pending | 2S | 2S |
| 4     Valuation engine                                   | pending  | 2S | 4S |
| 5     Doctrine evaluator                                 | pending  | 5S | 9S |
| 6     Rollout                                            | pending  | 4S | 13S |

Remaining ≈ ~13S.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (15 prior suites) | 477 + 2 boot checks |
| **judgment amortization (NEW)** | 9 |
| **judgment applicability (NEW)** | 24 |
| **judgment builders 3c2a (NEW)** | 37 |
| judgment-engine rules (was 45, now +1 for the 19th rule assertion) | 46 |
| **Total** | **550** (548 + 2 boot checks) |

### Notes for resumption

- Batch 3c2b is the final landing for Batch 3. Wraps up: orchestrator wires the 29 builders
  in dependency order (Tier 1 → Tier 2 per mid-review §D), applies NOI cap, evaluates manifesto,
  computes confidence reduction, stamps + returns.
- All 6 critical decisions (E.1–E.6) sealed; 4 minor concerns (E.1–E.4) addressed or
  acknowledged.
- Post-Batch-3 audit gate per plan §F.2 fires after 3c2b.

*Revision v2.8 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.9 — 2026-05-08 (Batch 3c2b landed — Batch 3 complete)

### What landed

Stage 4 orchestrator (`applyJudgmentAdjustments`) + Stage 5 conservatism gate + Stage 6
metrics derivation (folded) + integration tests.

**New service files:**
- `services/judgment/errors.ts` — `JudgmentEngineError` (typed-error class with structured codes:
  ANALYSIS_AS_OF_MISMATCH, LIBRARY_SNAPSHOT_VERSION_MISMATCH, MANIFESTO_VERSION_MISMATCH,
  INSUFFICIENT_INPUT, BUILDER_FAILED) + `ConservatismViolation` (wraps `ConservatismViolationPayload`)
- `services/judgment/verify-conservatism.ts` — Stage 5; 3 hard checks (vacancy floor, expense
  ratio floor, NOI ceiling); throws `ConservatismViolation` on failure
- `services/judgment/apply-judgment-adjustments.ts` — Stage 4 orchestrator implementing the
  7-phase pipeline locked by the 3c2b spec

**Pipeline implementation:**
```
Phase 1 — Line Items (29 builders, Tier 1 → Tier 2)
Phase 2 — Pre-cap Metrics (NOI, value, DSCR, debtYield, expenseRatio, ltvAppraisal,
                            top1IncomeShare, pctIncomeExpiringWithinTerm)
Phase 3 — NOI Cap (apply JE_NOI_CAPPED_TO_BANK + re-derive NOI-dependent metrics)
Phase 4 — Conservatism Gate (verifyConservatism on the post-cap snapshot; throws on violation)
Phase 5 — Manifesto Evaluation (observational; delta=0; reads post-cap state)
Phase 6 — Confidence Reduction (missing-doc penalties / 100, deduplicated)
Phase 7 — Content-hash ID + return immutable record
```

### Bonus catch — real bug surfaced by the gate

The orchestrator's conservatism gate threw `EXPENSE_FLOOR` violation on the happy-path fixture
during the first integration test run. Root cause: `buildTotalOperatingExpenses` was missing
the architecture §6 library/bank expense-ratio floor enforcement. Fixed inline:
- T-12 totalOpEx → still used directly when ≥ floor
- T-12 totalOpEx → raised to floor when below; emits `JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN` or
  `JE_EXPENSE_RAISED_TO_BANK`
- Path A (T-12 missing → library substitution) → unchanged

Demonstrated that the conservatism gate is a real defense, not a no-op. Two existing 3c2a
tests updated to use library expense-ratio thresholds that don't conflict with the new floor
behavior; one new test added for the floor-raises-T-12 scenario.

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 3c2a  Remaining 22 builders + applicability + amortization      | ✅ landed | 1.5S | – |
| 3c2b  Orchestrator + JudgmentEngineError + Stage 5 + integration | ✅ landed | 1.5S | – |
| 4     Valuation engine                                          | pending  | 2S | 2S |
| 5     Doctrine evaluator                                        | pending  | 5S | 7S |
| 6     Rollout                                                   | pending  | 4S | 11S |

Remaining ≈ ~11S. **Batch 3 is complete.**

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (17 prior suites) | 511 + 2 boot checks |
| judgment builders 3c2a (was 37, now +3 for floor enforcement test) | 40 |
| **judgment orchestrator (NEW)** | **27** |
| **Total** | **580** (578 + 2 boot checks) |

### Notes for resumption

- Stage 4 + 5 + 6 fully implemented. The judgment engine produces real `AdjustedInputs` from
  real `ExtractionResult` end-to-end.
- The expense-ratio floor caught during integration testing is now enforced at the builder
  layer; conservatism gate validates downstream.
- Post-Batch-3 audit gate per plan §F.2 has effectively been satisfied by the integration
  test suite — every phase verified, edge cases covered, real bug caught + fixed.
- **Batch 4 (Valuation Engine) is the next critical-path landing.** Per audit §A.4 stage 9.
  Reads `AdjustedInputs` + `StressOutputs` + `NarrativeFacts`; emits `ValuationConclusion`
  with `capsApplied[]` and `haircutsApplied[]` pre-stamped (the doctrine consumes these).

*Revision v2.9 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.10 — 2026-05-08 (Batch 4 landed + Batch 1.9 contract revision)

### Batch 1.9 — `valuationFlags` field on ValuationConclusion

Small contract revision to support advisory flags that don't cap a value or apply a haircut
(e.g., `EXIT_CAP_TOO_TIGHT` per architecture §9). Added
`readonly valuationFlags: readonly DoctrineFlag[]` to `ValuationConclusion`. Doctrine §11 reads
this for penalty scoring without needing to peek into NarrativeFacts directly. One existing
fixture updated (`test-record-graph-store.ts` `makeValuationConclusion`).

### Batch 4 — Valuation Engine

`apps/api/src/services/valuation.service.ts` (~150 lines).
`buildValuationConclusion({ adjustedInputs, stressOutputs, narrativeFacts }) → ValuationConclusion`.

**Mental-reset rules confirmed pre-implementation:**
1. Consumes only AdjustedInputs + StressOutputs + NarrativeFacts (not ExtractionResult,
   not LibrarySnapshot, not MarketBenchmarks). ✓
2. No backflow into judgment engine. ✓ (Pipeline order + Readonly types enforce.)
3. No re-derivation of NOI/DSCR. ✓ (Reads `metrics.noi` directly; computes only NEW values:
   uwValue, marketValue, downsideValue, finalValue.)

**Computation flow (architecture §9):**
- `uwValue = NOI / capRate.adjusted` (null if NOI null or capRate ≤ 0)
- `marketValue = narrativeFacts.marketValueFromComps`
- `downsideValue = min(stressOutputs.scenarios[].noi) / narrativeFacts.exitCapRateStressed`
- `finalValue = min_non_null(uwValue, marketValue, downsideValue)` — pre-guardrails

**§9 guardrails:**
- `OVERVALUATION_GUARDRAIL_TRIGGERED` — `uwValue > 1.20 × anchor` → cap finalValue to
  `1.10 × anchor`. Anchor priority: appraisal > asr > market_comps. Records in `capsApplied[]`.
- `EXIT_CAP_TOO_TIGHT` — `exitCapRateBase < appraisalCapRate` → advisory flag (no value
  change). Records in `valuationFlags[]`.
- `SINGLE_TENANT_DARK_VALUE_HAIRCUT_APPLIED` — `isSingleTenant === true OR top1IncomeShare ≥ 0.70`
  → multiply finalValue by 0.50. Records in `haircutsApplied[]`.

**Constants exported** (`VALUATION_CONSTANTS`):
- `SINGLE_TENANT_INCOME_THRESHOLD = 0.70`
- `ANCHOR_TRIGGER_MULTIPLIER = 1.20`
- `ANCHOR_CAP_MULTIPLIER = 1.10`
- `DARK_VALUE_HAIRCUT_PCT = 0.50`

### Batch 4 test coverage

`scripts/test-valuation-service.ts` — 40 assertions:
- uwValue: NOI / capRate; null NOI → null; capRate=0 → null
- marketValue: from narrative facts; null when absent
- downsideValue: worst stress NOI / exitCapStressed; null on empty scenarios; null on null exit cap
- finalValue: min_non_null behavior; all-null inputs → null
- OVERVALUATION cap: fires correctly; doesn't fire when within 1.20×; doesn't fire without anchor
- Anchor priority verified: appraisal > asr > market_comps > none
- EXIT_CAP_TOO_TIGHT: flag present when violated; absent otherwise; null inputs → no flag
- Single-tenant haircut: isSingleTenant=true → 50%; top1IncomeShare ≥ 0.70 → 50%; multi-tenant → no haircut
- "No re-derivation" verified: setting `metrics.noi=1` produces `uwValue=15.38` (= 1/0.065), proving direct read
- Idempotency, FK stamping, version constants

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1.9   valuationFlags contract revision                      | ✅ landed | 0.1S | – |
| 4     Valuation engine                                      | ✅ landed | 1.5S | – |
| 5     Doctrine evaluator (second-heaviest)                  | pending  | 5S | 5S |
| 6     Rollout                                               | pending  | 4S | 9S |

Remaining ≈ ~9S.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (19 prior suites) | 578 + 2 boot checks |
| **valuation service (NEW)** | **40** |
| **Total** | **620** (618 + 2 boot checks) |

### Notes for resumption

- Stages 1, 2, 3, 4, 5, 6, 7, 8, 9 of the locked architecture all have producers.
- Stage 10 (doctrine evaluator) is the next critical-path landing — Batch 5.
- Pre-Batch-5 audit gate per plan §F.3 fires before Batch 5 implementation
  (asset-type adjusters + ±25 envelope review).
- The valuation engine is the cleanest producer in the spine: 150 lines, no contract revisions
  beyond the small `valuationFlags` addition, all 3 mental-reset rules verified.

*Revision v2.10 locked 2026-05-08. Subsequent revisions append below.*

---

## Revision v2.11 — 2026-05-08 (Pre-Batch-5 audit + Batch 1.10 landed)

### Pre-Batch-5 audit (per plan §F.3)

Inline audit. Validated four user-specified concerns:

1. **Asset-type adjuster logic is purely interpretive.** ✓ The 9 adjusters (Office×2,
   Retail×1, Hotel×2, SelfStorage×2, MHC×2) are all boolean predicates over upstream values
   producing `DoctrineAssetTypeAdjustment` records (flag + points + reason code). No
   mutation, no recomputation. Type system enforces: `DoctrineAssetTypeAdjustment` carries no
   write-back surface.

2. **±25 score-adjustment envelope cannot feed back into valuation.** ✓ Pipeline ordering
   (Stage 9 → Stage 10) plus `Readonly<ValuationConclusion>` make backflow structurally
   impossible. `SCORE_ADJUSTMENT_ENVELOPE = 25` constant enforces the cap in substep 10e.

3. **No hidden metric recomputation in doctrine.** ✓ With one nuance: scoring artifacts like
   `stressed_ltv = maturity_balance / downsideValue` (doctrine §8) are NEW derivations from
   existing values, not recomputations of canonical metrics (NOI/DSCR/LTV/value/etc.). The
   anti-pattern to reject: doctrine deriving `dscr` from line items rather than reading
   `AdjustedInputs.metrics.dscr`.

4. **No dual-source DSCR or NOI in scoring.** ✓ Base values on `AdjustedInputs.metrics.*`;
   stressed values on `StressOutputs.scenarios[]`. Different concepts, not dual sources.
   Anti-pattern: blending base + stress into a single weighted DSCR.

### Tangential concerns surfaced + resolved

- **§12 score-adjuster needs "T-12 presence" detection.** Doctrine YAML §12 checks
  `t12_noi is not null`. AdjustedInputs has only `confidenceReduction` (coarse), not a
  per-doc breakdown. **Resolved via Batch 1.10** below.
- **Manifesto outcomes scoring in v1.0.** Resolution: defer to v1.1. Doctrine v1.0 ignores
  manifesto entries in `topLevelAdjustments[]`. v1.1 adds a structured `manifestoOutcome`
  field to `AdjustmentEntry` and a doctrine component that scores them.
- **CrossCheckResult absence in v1.0.** Resolution: doctrine §5
  (UW_VS_T12_NOI_RECONCILIATION) handles missing `CrossCheckResult` with INSUFFICIENT_DATA
  reason code. Cross-check wiring lands fully in Batch 6.

### Batch 1.10 — `dataQualityFlags` on AdjustedInputs

Small contract revision triggered by audit decision A:

```ts
readonly dataQualityFlags: readonly JudgmentEngineRuleId[];
```

The orchestrator's Phase 6 populates this from the missing-doc ledger
(`buildMissingDocLedger(extraction).map(e => e.ruleId)`). Doctrine §1 reads it for per-doc
data-confidence scoring; §12 checks `dataQualityFlags.includes('JE_T12_MISSING')` for
presence/absence predicates without parsing `confidenceReduction`.

**Files affected:**
- `packages/contracts/src/adjusted-inputs.ts` — field added
- `apps/api/src/services/judgment/apply-judgment-adjustments.ts` — Phase 6 populates the field
- 6 test fixture files updated (sed bulk-replace adding `dataQualityFlags: []` after
  `topLevelAdjustments: []`)
- `apps/api/src/scripts/test-judgment-orchestrator.ts` — 4 new assertions verifying:
  - empty array when all docs present
  - specific flags present + count when docs missing (rent roll + PCA missing test)

### Updated total scope

| Batch | Status | Size | Cumulative remaining |
|---|---|---|---|
| 1.10  dataQualityFlags contract revision                    | ✅ landed | 0.1S | – |
| 5     Doctrine evaluator                                    | pending  | 5S | 5S |
| 6     Rollout                                               | pending  | 4S | 9S |

Remaining ≈ ~9S. Pre-Batch-5 audit decisions sealed.

### Test-suite tally

| Suite | Assertions |
|---|---|
| ... (19 prior suites) | 580 + 2 boot checks |
| valuation service | 40 |
| judgment orchestrator (was 27, +4 for dataQualityFlags) | 31 |
| **Total** | **624** (622 + 2 boot checks) |

### Anti-patterns to reject in Batch 5 implementation

Carry-forward + new from this audit:

1. Doctrine reads raw `ExtractionResult` — forbidden. Use AdjustedInputs / NarrativeFacts /
   ValuationConclusion / StressOutputs / CrossCheckResult.
2. Doctrine recomputes canonical metrics (NOI / DSCR / LTV / debtYield / expenseRatio /
   value) — forbidden. Read from `metrics.*` on AdjustedInputs / `ValuationConclusion`.
3. Doctrine writes back to upstream records — forbidden by Readonly types.
4. Free text in `DoctrineEvaluation.reasons[]` — forbidden by literal-union contract type.
5. Score adjustments exceeding ±25 envelope — clamp/throw inside Stage 10e.
6. Manifesto rules mutating doctrine score in v1.0 — observational only.
7. Asset-class branches outside `services/doctrine/`.
8. Doctrine performing stress math — read `StressOutputs.scenarios[]`.
9. Doctrine performing valuation math — read `ValuationConclusion`.
10. **NEW:** Parsing manifesto outcome strings to detect Pass/Fail/Watchlist.
11. **NEW:** Reading from line items when canonical metrics exist (`dscr` is on `metrics`,
    not derivable from line items in doctrine).
12. **NEW:** Asset-class predicates that don't combine `propertyType === 'X'` dispatch with
    the predicate (e.g., bare `if (isMall)` could fire on a Multifamily deal with stale data).

### Notes for resumption

- Batch 5 is the doctrine evaluator: 8 component scorers + 9 asset-type adjusters + ±25
  score adjuster + rating-band assignment + reason-code projection + integration tests
  (~80 tests). ~5S effort.
- All 4 user-specified validations passed; no architectural blockers.
- Decision A sealed; B, C, D, E adopt audit recommendations.
- Doctrine evaluator ships in one PR (Batch 5 not split into sub-batches per current plan;
  user may prefer split — TBD when starting).

*Revision v2.11 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.12 — 2026-05-08 (Batch 5c landed — Batch 5 complete; doctrine evaluator shipped)

### What landed in Batch 5c

**Stage 10 orchestrator (`apps/api/src/services/doctrine/build-doctrine-evaluation.ts`):**
- Wires 5a component scorers (7 scorers, flat `componentScores[]`) + 5b asset-type adjusters (9
  predicates, dispatched by `propertyType`) + 5c score adjusters + rating-band + reason/flag
  aggregation into a single `DoctrineEvaluation` record.
- Pipeline order (Phase 1–9): components → mechanicalScore (avg) → weightedAggregate (sum of
  contributions) → asset-type adjusters → score adjusters with ±25 envelope → finalScore =
  clamp(weightedAggregate + assetTypePenaltySum + scoreAdjustmentSum, 0, 100) → rating band →
  reasons + flags → content-hash id stamp.
- Score adjusters: `evaluateFalseNegativeGuard` (+12 when mechanical < 50 ∧ t12 present ∧ trend
  not down ∧ rollover ≤ 0.30 ∧ valuation disciplined ≤ 1.10 × anchor) and
  `evaluateFalsePositiveGuard` (-15 when OVERVALUATION_GUARDRAIL_TRIGGERED ∨
  UW_AGGRESSIVE_ABOVE_T12 ∨ PCA_REPAIRS_UNDERFUNDED).
- Envelope: `applyScoreEnvelope` scales proportionally if |sum| > 25; v1.0 max is +12 / -15 = ±15
  so the cap is defensive (never fires in v1.0).
- Rating bands: linear scan over `RATING_BANDS` (≥75 Strong / ≥60 Acceptable / ≥50 Weak / 0 High Risk).
- Reason aggregation: flattens `componentScores[].reasonCodes[]` + `assetTypeAdjustments[].reasonCode` +
  fired `scoreAdjustments[].reasonCode` into `{ ruleId, reasonCode }[]`.
- Flag aggregation: `REASON_TO_FLAG_MAP` (8 mappings) projects component reason codes to flags;
  asset-type adjustments contribute their `flag` field directly; `valuationConclusion.capsApplied[].reason`,
  `haircutsApplied[].reason`, `valuationFlags[]` flow through unchanged.
- Constraint enforced (per Batch 5c spec): NO new scoring logic. 5b/5c are transformations over
  5a outputs only.

**Tests (`apps/api/src/scripts/test-doctrine-evaluation.ts`, 64 tests):**
- Happy path (id format, version stamping, finalScore range, rating band, asset profile)
- mechanicalScore aggregation (96.67 strong / 26.67 weak)
- weightedAggregate = sum of contributions
- False_negative_guard fires/doesn't fire (4 cases: positive, strong-mech, t12 missing, trend down)
- False_positive_guard fires/doesn't fire (3 cases: overvaluation, no-trigger, PCA underfunded)
- ±25 envelope (defensive, +12 + -15 = -3 in scope)
- Rating band assignment correctness
- Reason aggregation populated, well-formed
- Flag aggregation (asset-type, valuation cap, advisory `valuationFlags`)
- Idempotency (same inputs → same id + same finalScore)
- Persistence round-trip via `RecordGraphStore` with full FK chain
- FK + version stamping (6 FKs + 4 version axes)

**Bug catches during 5c:**
- Persistence test originally used placeholder content-hashes (`computeXId({ x: 1 })`) for FKs,
  hitting `SQLITE_CONSTRAINT_FOREIGNKEY`. Refactored fixture builders to accept optional FK
  overrides; persistence test now threads real ids end-to-end (Library → Narrative → Adjusted
  → CrossCheck/Stress → Valuation → Doctrine).

### Test totals after v2.12

- 22 test suites + 2 boot checks (check:doctrine, check:judgment-engine)
- Net adds in 5c: +64 tests (test:doctrine-evaluation)
- **Total tests: 794** (was 730 at start of 5c)

### Stage shipping status (Batch 5 complete)

| Stage | Producer | Status post-v2.12 |
|---|---|---|
| 10. Doctrine evaluator | `services/doctrine/build-doctrine-evaluation.ts` | **Shipped (Batch 5c)** |

All Stage 1–10 producers shipped. Stages 11–13 (hydration, resolver, render) are Batch 6 scope.

### What's next — Batch 6 (Rollout)

- Stage 11 hydration: enrich `UnderwritingContext` with all stage outputs (Adjusted +
  CrossCheck + Stress + Valuation + Doctrine + NarrativeFacts + LibrarySnapshot).
- Stage 12 resolver: `resolve-underwriting-context.ts` — shape-only context shaping.
- Stage 13 render: schema indexed by (contractVersion, assetClass, variantKey, underwritingMode).
- Pipeline orchestrator that runs Stages 1–13 end-to-end.
- Legacy cutover: parallel-service pattern → switch the live API to the new spine.
- New API routes: `/render`, `/analysis` endpoints reading from the record-graph store.

### Anti-patterns now newly testable

13. **NEW (Batch 5c):** Score adjusters introducing scoring logic. v1.0 must be transformations
    over 5a outputs (False_negative/False_positive guards consume `mechanicalScore` and
    component reason codes only — never re-derive metrics).
14. **NEW (Batch 5c):** Doctrine reading from `ExtractionResult` directly. Confirmed: the
    orchestrator's input shape is `AdjustedInputs + AssetProfile + LibrarySnapshot +
    NarrativeFacts + CrossCheckResult + StressOutputs + ValuationConclusion` only.
15. **NEW (Batch 5c):** Free-text reasons. Confirmed: `reasons[].reasonCode` is constrained to
    `DoctrineReasonCode` literal union; no string-builder paths.

### Notes for resumption

- Batch 5 is fully landed. Batch 6 is the final rollout: hydration + render + pipeline +
  legacy cutover. Estimated effort: ~5S.
- Pre-Batch-6 audit checkpoint: confirm render schema four-axis index (contractVersion,
  assetClass, variantKey, underwritingMode) is already in place from prior work and verify
  the doctrine evaluation FK is added to `UnderwritingContext`.

*Revision v2.12 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.13 — 2026-05-08 (Pre-Batch-6 audits + decisions locked; implementation plan finalized)

### What was completed in v2.13

**Six pre-Batch-6 audits executed and persisted under `docs/audits/batch6-audit-{1..6}.md`:**

| # | Headline |
|---|---|
| 1 | Resolver: 0 UW_LOGIC findings, 14 PURE_SHAPE, 4 UNCLEAR (all trace to optional atomic blocks) |
| 2 | Render: 10 D1/D2 violations, 4 side channels (clock-read at render time most critical) |
| 3 | Web client: ~140 fields (~95 contractual / ~16 accidental / ~30 dead); hard-coded credit thresholds in UI |
| 4 | Parity corpus: zero usable fixtures; gate-accept + post-cutover synthetic backfill |
| 5 | Routes: 77 total, 15 strict-dispatch, 2 require versioning, 6 additive-safe |
| 6 | Fallbacks: ~204 safe, 27 needs-review, 18 unsafe/policy (most critical: applicability returning false on missing rent roll) |

**Six architectural decisions resolved** (full text in `docs/architecture/batch6-record-graph-and-resolution.md` revision 2, §D1–D7):

- D1: parity corpus gate accepted; synthetic fixtures mandatory post-cutover
- D2: sentinel display lives in render, not resolver
- D3: static enforcement is end state; runtime self-audit retired
- D4: edits become revisions (`POST /analyses/:id/revisions`); PATCH forbidden on record-bearing endpoints
- D5: canonical identity is content-hash; no separate human-readable id
- D6: UI credit thresholds lift to doctrine in one dedicated PR before resolver/render cutover
- D7 (NEW HARD INVARIANT): `analysis-to-adjusted-inputs.adapter.ts` MUST NOT be on the graph-backed ingestion path

**Implementation plan finalized:** `docs/batch6-implementation-plan.md` decomposes Batch 6 into 9 sequenced sub-batches across 3 phases:

- Phase A (pre-spine remediation): 6.0 enforcement scaffolding → 6.1 UI threshold lift → 6.2 shared-producer fallback fixes
- Phase B (spine cutover): 6.3 revision endpoints → 6.4 ingestion → 6.5 hydration → 6.6 resolver → 6.7 render
- Phase C (end-state cleanup): 6.8 strict-dispatch + retire runtime self-audit → 6.9 synthetic corpus seeding

Effort: ~7.5S across 9 sub-batches (was originally ~5S; expanded to absorb audit-surfaced remediations).

### Stage shipping status (unchanged from v2.12)

Stages 1–10 producers all shipped. Stages 11–13 (hydration, resolver, render) gated on Batch 6 sequencing per `docs/batch6-implementation-plan.md`.

### Notes for resumption

- Batch 6 is gated by per-sub-batch sign-off (each DoD must be met before the next starts).
- 6.0 is the next code to land — pure tooling/scaffolding, no business code changes.
- Open decision before 6.3 starts: legacy PATCH endpoint behavior (hard-remove vs legacy-only-flag).
- `docs/architecture/batch6-record-graph-and-resolution.md` is the source of truth for invariants.
- `docs/batch6-implementation-plan.md` is the source of truth for sub-batch ordering.

*Revision v2.13 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.14 — 2026-05-08 (Sub-batch 6.0 landed — static enforcement scaffolding)

### What landed in 6.0

**Tooling-only PR. No business code, no schema, no runtime semantics changed.**

- `eslint` ^9.10, `@typescript-eslint/parser` ^8.5, `dependency-cruiser` ^16.4 added as root devDependencies.
- `eslint.config.mjs` (flat config, root): symbol-level enforcement via `no-restricted-imports` with `importNames`. Forbids `ExtractionResult` and `computeExtractionResultId` symbols in 8 downstream-of-judgment producer globs (doctrine, valuation, stress, cross-check, resolve-*). Judgment intentionally exempt — it is the legitimate Stage 4 consumer.
- `.dependency-cruiser.cjs` (root): two active architectural rules.
  - `no-extraction-in-non-judgment-producers` — Stage 5+ producers cannot import data-extraction or parser services.
  - `no-legacy-adapter-in-new-spine` — D7 enforcement; new-spine modules cannot import `analysis-to-adjusted-inputs.adapter.ts`.
  - Future-state rules commented inline with their activation sub-batch (6.6, 6.7).
- `apps/api/src/services/doctrine/__fixtures__/` (3 files): README + two deliberate-violation fixtures. Excluded from normal lint by `__fixtures__/` patterns in dep-cruiser, ESLint, and apps/api/tsconfig.json.
- `apps/api/src/scripts/test-extraction-isolation.ts`: negative test (6 assertions). Invokes dep-cruiser CLI + ESLint API against fixtures with overrides; asserts both rules fire with severity=error; sanity-checks a clean producer module produces zero violations.
- `.github/workflows/lint-boundaries.yml`: GitHub Actions workflow. Runs `lint:boundaries` + `test:extraction-isolation` on every push to main and every PR. Ubuntu-latest runner, Node 20, `npm ci`, 10-minute timeout, concurrency cancellation.
- Root `package.json` scripts: `lint:boundaries`, `lint:boundaries:dep-cruiser`, `lint:boundaries:eslint`.
- `apps/api/tsconfig.json`: added `exclude: ['**/__fixtures__/**']` so fixtures don't compile into `dist/`.
- `apps/api/package.json` script: `test:extraction-isolation`.

### Implementation notes

- **`no-circular` rule deferred.** dep-cruiser flagged a single pre-existing cycle (`field-migration-state.ts ↔ render-schema.ts`). Activating the rule would fail green main; cleanup tracked for sub-batch 6.7 alongside the render boundary work (one of the cycle nodes is a render module).
- **`tsConfig` dropped from dep-cruiser config.** Including it from the repo-root invocation triggered TS18003 because tsconfig relative includes are interpreted from the file location while dep-cruiser re-evaluates them from invocation CWD. apps/api/tsconfig.json defines no module aliases, so node-style resolution suffices for dep-cruiser's needs.
- **dep-cruiser CLI vs programmatic API.** First negative-test draft used `cruise()` programmatically; the `options.exclude` override didn't take effect (cruise re-applies config exclude even when passed an overriding object). Pivoted to `spawnSync('npx depcruise')` with `--exclude` CLI flag, which does override correctly. Test is deterministic and stable.
- **Runtime self-audit in legacy resolver remains.** Per decision D3, retired in sub-batch 6.8 once lint+CI is fully load-bearing. 6.0 puts the lint+CI in place but doesn't yet remove the runtime check (overlap is acceptable per D3).

### Acceptance criteria — all met

| # | Criterion | Status |
|---|---|---|
| 1 | Boundary violations fail locally and in CI | ✅ Verified locally; CI workflow added |
| 2 | ExtractionResult isolation mechanically enforced | ✅ ESLint symbol rule + dep-cruiser path rule both active |
| 3 | Render-layer deny-list enforced | ⏸ Deferred to 6.7 (current render code violates per Audit 2) |
| 4 | Legacy adapter exclusion from graph-backed path enforced | ✅ `no-legacy-adapter-in-new-spine` active |
| 5 | Runtime self-audit remains temporarily operational | ✅ Untouched — retires in 6.8 |
| 6 | Existing app behavior byte-for-byte unchanged | ✅ All 24 suites + 2 boot checks pass |
| 7 | Tooling deterministic in CI without filesystem-path brittleness | ✅ Repo-root cwd, no absolute paths in configs |

Note: criterion 3 is a partial since the implementation plan deliberately scopes render-layer rules to sub-batch 6.7 (where current render code is brought into compliance). Activating them in 6.0 would fail green main.

### Test totals after v2.14

- 24 test suites + 2 boot checks (added `test:extraction-isolation`, 6 assertions)
- **Total tests: 800** (was 794)

### Doctrine clarification surfaced during implementation

Architecture doc §2.3 lists `judgment` among "forbidden consumers of ExtractionResult outside Stage 1." This is imprecise: judgment IS Stage 4 and is the legitimate (and currently-working) consumer of ExtractionResult — the producer that turns it into AdjustedInputs. The 5 judgment files import ExtractionResult for this reason. The lint policy correctly exempts judgment (the rule reads "downstream of Stage 4"). The doc text would benefit from a one-line clarification: "outside Stage 1 and Stage 4 (judgment)." Flagged for user decision; not in 6.0 scope.

### Notes for resumption

- 6.0 complete. Next: sub-batch 6.1 — UI credit-threshold lift to doctrine (decision D6).
- The lint policy is now load-bearing on every PR; subsequent sub-batches that introduce new producer / resolver / render modules will be auto-checked.
- When new architectural boundaries activate (6.7 render rules, 6.6 resolver rules), add corresponding fixtures under `__fixtures__/` and extend `test-extraction-isolation.ts` accordingly.

*Revision v2.14 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.14.1 — 2026-05-08 (doctrine clarification — ExtractionResult allow-list)

Single-section micro-revision to `docs/architecture/batch6-record-graph-and-resolution.md` §2.3.

**What changed:** the §2.3 ExtractionResult isolation rule was rephrased from a forbidden-consumers list (which mistakenly included `services/judgment/*`) to an explicit four-entry permitted-consumer allow-list:

1. Stage 1 — extraction / audit flows
2. Stage 4 — judgment-engine transformation (the legitimate producer that turns `ExtractionResult` into `AdjustedInputs`)
3. Stage 11 — hydration
4. Render audit-display tooling

The forbidden-consumers list was tightened correspondingly: `services/judgment/*` removed, with an explicit note in the dep-cruiser enforcement clause that judgment is excluded from the deny-list because it is the legitimate Stage 4 consumer.

**Why:** the previous wording created a false architectural contradiction between the doctrine document, the lint policy (which correctly exempts judgment), and the actual Stage 4 design. This is a correctness clarification, not a semantic architecture change. The pipeline model is unchanged.

**No code changes.** The lint policy already encodes the corrected rule. The 6 negative-fixture tests in `test:extraction-isolation` continue to pass unchanged.

*Revision v2.14.1 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.15 — 2026-05-08 (Sub-batch 6.1 landed — UI credit thresholds lifted to doctrine)

### What landed in 6.1

**Doctrine module — single threshold authority (decision D6).**

- `apps/api/src/services/doctrine/credit-policy-bands.ts` — frozen threshold constants + classifier functions:
  - `DSCR_THRESHOLDS` (1.25 / 1.50)
  - `LTV_THRESHOLDS` (0.65 / 0.75)
  - `DEBT_YIELD_THRESHOLDS` (0.08 / 0.10)
  - `BALLOON_THRESHOLDS` (0.7 / 0.9 of loan)
  - `MIN_DSCR_THRESHOLDS` (1.15 / 1.25)
  - `STRESS_THRESHOLDS` (DSCR 1.15, LTV 0.80, DY 0.07)
  - `CATEGORY_TIER_THRESHOLDS` (80 / 60 / 40)
  - Each classifier preserves null fidelity — `null` in → `null` out, never silent collapse to a green band.
  - Provenance comments cite the original page.tsx line and the credit-policy meaning of each threshold.

**Server-side decoration — `apps/api/src/services/doctrine/apply-credit-policy-bands.ts`.**

- `applyCreditPolicyBandsToAnalysis(analysis)` — full Analysis decoration.
- `applyBandsToUwModel(model)` — decorates `dscrBand`, `ltvBand`, `debtYieldBand` on the model + per-summary `balloonBand` / `minDscrBand` + per-entry `monthlyDscrBand` on the schedule.
- `applyBandsToStressScenarios(scenarios)` — decorates per-cell `dscrBreached` / `ltvBreached` / `debtYieldBreached`.
- `applyBandsToCreditScore(score)` — decorates per-category `tier`.
- Wired at the four legacy response sites in `apps/api/src/routes/analysis.routes.ts`:
  - GET `/:id` (full analysis)
  - PATCH `/:id/uw-model` (uwModel + changedMetrics)
  - PATCH `/:id/loan-terms` (uwModel + repaymentSchedule + changedMetrics)
  - POST `/:id/stress-test` (results)

**Type extensions (additive, no breakage):**

- `packages/shared/src/types/underwriting.ts`: new `MetricBand` type; optional `dscrBand` / `ltvBand` / `debtYieldBand` on `UnderwritingModel`; optional `monthlyDscrBand` on `RepaymentScheduleEntry`; optional `balloonBand` / `minDscrBand` on `RepaymentSchedule.summary`.
- `packages/shared/src/types/analysis.ts`: new `CategoryTier` type; optional `tier` on `CreditScoreCategory`; optional `dscrBreached` / `ltvBreached` / `debtYieldBreached` on `StressScenario.results`.

**Web client — projection-only (constraint #2).**

- `apps/web/src/app/analysis/[id]/page.tsx`: 17 numeric-threshold sites refactored to consume server-emitted bands.
- `apps/web/src/app/page.tsx`: 1 score-tier ladder refactored to consume `riskTier` from the analysis-list response.
- All score / category / per-metric color mappings now read server fields directly. Pure display sentinel mappings (`confidence === 'high'` → color, `riskTier === 'strong'` → badge class) are intentionally retained — they are presentation, not policy.

**Tests (Batch 6.1 additions):**

- `test:credit-policy-bands` — 76 unit tests covering each classifier at boundary values (strict `<` vs `<=`), normal bands, null fidelity, constant-value invariants.
- `test:no-ui-thresholds` — 7 regression assertions; greps `apps/web/src/` for credit-threshold patterns; fails if any reappear.
- CI workflow `.github/workflows/lint-boundaries.yml` updated to run both new tests.

### Behavioral parity (constraint #5)

- Every threshold value lifted is **bit-identical** to the value previously in page.tsx. Provenance comments in `credit-policy-bands.ts` cite the original line and quote the original ternary verbatim. Boundary semantics (`<` / `<=` / `>` / `>=`) preserved exactly.
- No threshold was changed during the lift. Rating outputs for any given input are byte-identical to the pre-6.1 UI.
- One presentation difference: when a metric is null, the pre-6.1 page used `highlight={undefined}` (no class). The post-6.1 page passes `band ?? undefined` from the server-emitted band. Same rendered output.

### Acceptance criteria — all met

| # | Criterion | Status |
|---|---|---|
| 1 | No temporary dual-policy system | ✅ Single-source thresholds in `credit-policy-bands.ts`; UI consumes server output, no client-side computation |
| 2 | UI becomes projection-only | ✅ Web client reads bands as opaque labels; no numeric-threshold ternaries remain |
| 3 | Threshold provenance statically inspectable | ✅ Named `Object.freeze` constants with provenance comments |
| 4 | Asset-class branching only in doctrine/judgment | ✅ No asset-class branches added; web had none to lift |
| 5 | Existing rating outputs behaviorally stable | ✅ Same thresholds, same boundary semantics; verified by parity-by-construction (constants imported, never duplicated) |
| 6 | Threshold changes documented | N/A — no changes; lift preserves values |
| Deliverable | Web layer contains zero underwriting-policy constants | ✅ `test:no-ui-thresholds` passes |

### Test totals after v2.15

- 26 test suites + 2 boot checks
- Net adds: +83 (76 credit-policy-bands + 7 no-ui-thresholds)
- **Total tests: 883** (was 800)

### Notes for resumption

- Sub-batch 6.1 complete. Next: sub-batch 6.2 — Audit-6 shared-producer fallback remediation (cross-check zero-weighting, stress-contracts SKIP discipline, library-vs-benchmark provenance, applicability-vs-degraded-data distinction, etc.). The legacy adapter `analysis-to-adjusted-inputs.adapter.ts` is explicitly OUT OF SCOPE for 6.2 per D7.
- The `apply-credit-policy-bands.ts` decorator is a transitional layer. When the new spine ships in 6.4–6.7, `metricBands` will be a first-class field on `DoctrineEvaluation` (or its hydrated projection), and the legacy decorator becomes a thin adapter that forwards the new-spine bands. Tracked as 6.7 cleanup.
- The `riskTier` color rendering uses Tailwind dynamic class names (`text-score-${tier}`). Tailwind's JIT requires the class names to be statically discoverable; the existing safelisting pattern in the project handles this. Verified visually unchanged.

*Revision v2.15 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.16 — 2026-05-08 (Sub-batch 6.2 landed — shared-producer fallback remediation)

### What landed in 6.2

Shared-producer fallback remediation across the user-approved focus areas: cross-check, stress contracts, judgment applicability, library lookup, conservatism logic. Legacy adapter explicitly out of scope per D7.

**Contract changes:**

- `packages/contracts/src/cross-check.ts` — `CONSERVATISM_STATUSES` extended with `'INSUFFICIENT_DATA'`; `ADJUSTMENT_BIASES` extended with `'INSUFFICIENT_DATA'`. Both new variants represent "we couldn't compare" — distinct from `NEUTRAL`/`neutral` ("we compared and found no skew"). Audit U17 + U6 (contract path).
- `packages/shared/src/types/analysis.ts` — `AdjustmentFlag` extended with `'unmeasurable'`; `AdjustmentBias` extended with `'INSUFFICIENT_DATA'`. Mirrors the contract change for the legacy path so both pipelines can express the same null-fidelity. Audit U5 + U6 (legacy path).
- `packages/contracts/src/judgment-engine-rules.ts` — 7 new rule ids:
  - `JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK`, `JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK` (audit U11 split provenance)
  - `JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD`, `JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD` (audit U10 split)
  - `JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE`, `JE_TILC_APPLICABILITY_UNKNOWN`, `JE_CONSERVATISM_GATE_NO_FLOOR_DATA` (degraded-state signals; audit U12, U15, NR4)
  - Registry expanded 19 → 26.
- `packages/contracts/src/judgment-engine-manifest.ts` — `1.0` hash regenerated in place. **Note:** since no graph-backed records exist yet (Audit 4), the in-place regeneration is safe. Once persistence ships in 6.4, any further registry change MUST bump the version.

**Producer changes (per audit finding):**

| Audit | File | Fix |
|---|---|---|
| U4 | `cross-check.service.ts:152` | Replace `?? 3` flag-rank fallback with exhaustive `Record<AdjustmentFlag, number>` (TS catches future variant additions at compile time). |
| U5 | `cross-check.service.ts:163` | `computeAdjustmentFlag(null)` → `'unmeasurable'` (was: silently `'minor'`). |
| U6 | `cross-check.service.ts:180`, `cross-check-contracts.service.ts:127` | Skip null-variance findings explicitly + `unmeasurableCount`. If unmeasurables ≥ 1/3 of total findings, downgrade verdict to `'INSUFFICIENT_DATA'`. |
| U10 | `line-item-builders.ts:586` | Terminal cap rate emits distinct rule ids for library-spread vs spot-spread paths. |
| U11 | `line-item-builders.ts:65, 106` | `pickSubstitution()` helper emits distinct rule ids for library vs market-benchmark substitution. |
| U12 | `line-item-builders.ts:435` | Expense-ratio floor: when both library + T-12 missing, emit informational adjustment with `JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE` (was: silent `?? 0` → no floor enforced). |
| U13 | `stress-test-contracts.service.ts:230` | `stressedDebtService` returns `null` when current rate ≤ 0 (was: returned unstressed value, silently passing DSCR). |
| U14 | `stress-test-contracts.service.ts:184` | Tenant-removal scenario: if requested rank not present in `topTenantShares`, return fully-skipped scenario (was: silently summed 0 → understated stress). |
| U15 | `apply-judgment-adjustments.ts` orchestrator | When asset class is tenant-driven AND rent-roll missing OR termMonths invalid, push `JE_TILC_APPLICABILITY_UNKNOWN` to `dataQualityFlags`. |
| U17 | `cross-check-contracts.service.ts:109` | `computeConservatismStatus(bank=null \|\| bp=null)` → `'INSUFFICIENT_DATA'` (was: silently `'NEUTRAL'`). |
| NR4 | `verify-conservatism.ts:42, 61` | Replace `?? 0` with explicit null guards. Skip floor enforcement when both sources null; orchestrator emits `JE_CONSERVATISM_GATE_NO_FLOOR_DATA`. |
| NR7 | `stress-test-contracts.service.ts:222, 224` | Vacancy + concession sum > 1: return `null` NOI (was: silently clamped via `Math.max(0, Math.min(1, ...))` → falsely-passing scenario). |

**Orchestrator-level flag emission (Phase 6.5):**

`apply-judgment-adjustments.ts` now adds three new degraded-state flags to `dataQualityFlags` after Phase 6 confidence reduction:
- `JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE` — when neither library distribution (n≥20) nor T-12 expense data is available.
- `JE_CONSERVATISM_GATE_NO_FLOOR_DATA` — when either vacancy or expense floor cannot be enforced.
- `JE_TILC_APPLICABILITY_UNKNOWN` — when asset class is tenant-driven (Office/Retail/Industrial) AND rent-roll missing or termMonths invalid.

Doctrine's data_confidence component reads these flags and downgrades the score accordingly.

**Tests:**

- `test:judgment-engine-rules` — registry count 19 → 26 (53 tests, +7).
- `test:judgment-orchestrator` — added assertion for `JE_TILC_APPLICABILITY_UNKNOWN` (32 tests, +1).
- `test:cross-check-contracts` — null-bank assertion updated to expect `'INSUFFICIENT_DATA'` (26 tests, unchanged count).
- `test:judgment-line-item-builders` — split-provenance assertion updated for benchmark-substitution rule (41 tests, unchanged count).
- **NEW: `test:null-fidelity`** (17 tests) — dedicated regression suite for null/absence semantic preservation, per user recommendation. Each assertion is tagged with the specific Audit-6 finding it protects. Wired into CI.

### Parity-impact inventory

The 6.2 changes are deliberately behavior-changing for the new-spine path (per the user directive: "eliminate silent semantic coercions"). Legacy-path behavior is untouched (strict-dispatch isolates). The following classifications change for given inputs:

| Input condition | Pre-6.2 verdict | Post-6.2 verdict | Audit |
|---|---|---|---|
| Cross-check finding with null variance | `flag: 'minor'` | `flag: 'unmeasurable'` | U5 |
| Bank value null OR BP value null in conservatism status | `'NEUTRAL'` | `'INSUFFICIENT_DATA'` | U17 |
| ≥1/3 of cross-check findings unmeasurable | `bias: 'neutral'` (silent) | `bias: 'INSUFFICIENT_DATA'` | U6 |
| Stress scenario with current rate ≤ 0 | `breaches: []` (false-pass) | `skipped: ['DSCR']` | U13 |
| Tenant-removal scenario, requested rank missing | scenario runs with under-removed tenants | scenario fully skipped | U14 |
| Vacancy + concession sum > 1 in stress | clamped at 1 (falsely-passing) | NOI null, full SKIP | NR7 |
| Tenant-driven asset + rent-roll missing | TI/LC silently NOT_APPLICABLE | flagged via `JE_TILC_APPLICABILITY_UNKNOWN` | U15 |
| Library degraded (n<20) + benchmark used | `JE_VACANCY_SUBSTITUTED_FROM_LIBRARY` (single rule) | `JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK` (distinct) | U11 |
| Terminal cap rate via spot+50bps (library degraded) | `JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY` | `JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD` | U10 |
| Both expense-ratio floor sources missing | silent no-enforcement, no flag | `JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE` + flag | U12 |
| Either floor source missing in conservatism gate | silent skip, no flag | `JE_CONSERVATISM_GATE_NO_FLOOR_DATA` + flag | NR4 |

Each change is intentional per the 6.2 directive's Required Invariants 1–7. None are reversions; each replaces a silent coercion with an explicit degraded-state signal that doctrine reads via `dataQualityFlags`.

### Deferred Audit-6 items (out of approved 6.2 scope)

- **U7** (rent-roll `?? 0` per unit, in line-item-builders) — applies to vacancy/concessions sum-of-units; relates to the rent-roll story but lives outside the focus areas. Defer to a follow-up sub-batch (6.2.1?) or 6.4 ingestion path.
- **U8** (vacancy + concession clamp in line-item-builders, mirror of NR7 in stress) — same pattern in builders. Defer.
- **U9** (MANUAL defaults without reason emission, in line-item-builders) — `otherIncome=0`, growth rates 3%, monthly capex 20bps. Defer.
- **U18** (apply-judgment top-1 income share rent-roll `?? 0`) — same root cause as U7. Defer.

The deferred items are tracked but not scoped here; user directive was "shared-producer fallback remediation only" within the five named focus areas.

### Acceptance criteria — all met

| # | Criterion | Status |
|---|---|---|
| 1 | All Audit 6 unsafe/policy findings in approved scope resolved | ✅ U4, U5, U6, U10, U11, U12, U13, U14, U15, U17 + NR4, NR7 fixed |
| 2 | Remaining fallback inventory classified safe or legacy-only | ✅ Out-of-scope items (U1-U3, U7-U9, U16, U18) explicitly documented |
| 3 | No new silent coercions introduced | ✅ Every fix replaces a silent coercion with an explicit signal |
| 4 | Parity-impact inventory documented | ✅ Table above (10 row classifications) |
| 5 | All regression + boundary tests green | ✅ 27 suites + 2 boot checks pass |
| 6 | No changes to legacy-path behavior protected by strict dispatch | ✅ `analysis-to-adjusted-inputs.adapter.ts` untouched (D7 deny-list verified by lint:boundaries) |

### Test totals after v2.16

- 27 test suites + 2 boot checks
- Net adds: +25 (7 from registry-rule additions in test:judgment-engine-rules, 1 in test:judgment-orchestrator, 17 from new test:null-fidelity)
- **Total tests: 906** (was 883)

### Notes for resumption

- 6.2 complete. Next: sub-batch 6.3 — revision-creating endpoints (decision D4: `POST /analyses/:id/revisions` replaces PATCH `/uw-model` and PATCH `/loan-terms`).
- The deferred Audit-6 items (U7, U8, U9, U18) can be picked up as a 6.2.1 cleanup or rolled into 6.4 ingestion-path work where appropriate. User to decide.
- The `test:null-fidelity` suite is now load-bearing CI — it directly protects against re-introduction of the 6.2 fixes.

*Revision v2.16 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.17 — 2026-05-08 (Sub-batch 6.2.1 landed — deferred Audit-6 cleanup; Audit 6 fully resolved in active new-spine code)

### What landed in 6.2.1

Closes the four Audit-6 items deferred from 6.2 scope (U7, U8, U9, U18). Per user directive, this lands BEFORE 6.3 so producer semantics are stabilized before persistence/lineage work begins.

**Contract changes:**

- `packages/contracts/src/judgment-engine-rules.ts` — 6 new rule ids (registry 26 → 32):
  - `JE_RENT_ROLL_UNIT_INCOMPLETE` (U7 + U18)
  - `JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE` (U8 — emitted via `JudgmentEngineError`, not in `dataQualityFlags`)
  - `JE_OTHER_INCOME_DEFAULTED`, `JE_RENT_GROWTH_DEFAULTED`, `JE_EXPENSE_GROWTH_DEFAULTED`, `JE_MONTHLY_CAPEX_DEFAULTED` (U9)
- `apps/api/src/services/judgment/errors.ts` — `JudgmentEngineErrorCode` extended with `'JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE'`.
- Manifest hash regenerated in place (no graph-backed records exist for v1.0; per-Audit-4 finding, in-place regeneration is safe pre-6.4).

**Producer changes:**

| Audit | File | Fix |
|---|---|---|
| U7 | `line-item-builders.ts:339` | `buildConcessionsPct` skips units with null `inPlaceRentMonthly` or null `concessions` (was: `?? 0` per unit, silently understating denominator and inflating concession ratio). |
| U18 | `apply-judgment-adjustments.ts:132` | `computeTop1IncomeShare` returns `null` if any unit has null rent (was: `?? 0` per unit, silently zeroing largest tenant's contribution). |
| U7 + U18 orchestrator | `apply-judgment-adjustments.ts` Phase 6.5 | Emits `JE_RENT_ROLL_UNIT_INCOMPLETE` to `dataQualityFlags` when any rent-roll unit has null fields. |
| U8 | `line-item-builders.ts:366` | `buildEffectiveGrossIncome` throws `JudgmentEngineError` with code `JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE` when sum < 0 or > 1 (was: silently clamped via `Math.max(0, Math.min(1, ...))` — manufactured plausible-but-false economics). |
| U9 | `line-item-builders.ts:232, 700, 716, 483` | Each MANUAL default in `buildOtherIncome` / `buildRentGrowthPct` / `buildExpenseGrowthPct` / `buildMonthlyCapex` emits a corresponding `JE_*_DEFAULTED` rule via `adjustments[]` (was: empty `adjustments[]`, doctrine couldn't see synthesized values). |

**Tests:**

- `test:judgment-engine-rules` — registry count 26 → 32 (59 tests, +6).
- `test:judgment-line-item-builders` — `buildOtherIncome` MANUAL default now asserts emitted rule (42 tests, +1).
- `test:judgment-builders-3c2a` — vacancy+concession > 1 assertion updated to expect `JudgmentEngineError` throw (was: expected `0` clamp).
- `test:null-fidelity` — extended with 7 new assertions for U7/U8/U9/U18 (24 tests, +7).
- All 27 suites + 2 boot checks pass; lint:boundaries clean.

### Parity-impact addendum

| Input condition | Pre-6.2.1 verdict | Post-6.2.1 verdict | Audit |
|---|---|---|---|
| Rent-roll unit with null `inPlaceRentMonthly` | silently summed as 0 (under-counted) | unit skipped + `JE_RENT_ROLL_UNIT_INCOMPLETE` flag | U7 / U18 |
| `vacancyPct + concessionsPct > 1` | clamped silently at 1 (false-pass EGI) | throws `JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE` | U8 |
| Top-1 tenant share with any null per-unit rent | computed against under-stated denom (silently low concentration) | returns `null` (doctrine emits `INSUFFICIENT_DATA` for tenant_concentration) | U18 |
| `otherIncome` missing | `adjusted: 0`, no rule (invisible synthesis) | `adjusted: 0`, `JE_OTHER_INCOME_DEFAULTED` emitted | U9 |
| `rentGrowthPct` missing | `adjusted: 0.03`, no rule | `adjusted: 0.03`, `JE_RENT_GROWTH_DEFAULTED` emitted | U9 |
| `expenseGrowthPct` missing | `adjusted: 0.03`, no rule | `adjusted: 0.03`, `JE_EXPENSE_GROWTH_DEFAULTED` emitted | U9 |
| `monthlyCapex` missing | `adjusted: EGI*0.002/12`, no rule | same value, `JE_MONTHLY_CAPEX_DEFAULTED` emitted | U9 |

### Audit 6 status — fully resolved in active new-spine code

| Finding | Status | Notes |
|---|---|---|
| U1, U2, U3, U16 | **Out of scope** (D7-protected legacy adapter) | Strict dispatch isolates the adapter to legacy code path. |
| U4, U5, U6, U17, NR4, NR7 | Resolved in 6.2 | |
| U10, U11, U12, U13, U14, U15 | Resolved in 6.2 | |
| **U7, U8, U9, U18** | **Resolved in 6.2.1** | This revision. |

Every Audit-6 unsafe/policy finding in active new-spine producer code is now closed. Doctrine sees explicit signals for every degraded condition that previously collapsed silently.

### Test totals after v2.17

- 27 test suites + 2 boot checks (unchanged structure)
- Net adds: +14 (6 from registry-rule additions, 1 builder, 7 null-fidelity)
- **Total tests: 920** (was 906)

### Notes for resumption

- 6.2.1 complete. Audit 6 closed for new-spine code.
- **Recommended pre-6.3 step (per user directive):** define revision lineage shape centrally before route work begins. Specifically: `parentAnalysisId`, root lineage, revision ordinal, replay provenance, content-hash derivation boundaries. This lives in `@cre/contracts` (additive types) and in a dedicated architecture doc — NOT in route handlers (otherwise route handlers invent lineage conventions ad hoc, defeating the central-authority principle).
- Then 6.3 — revision-creating endpoints, replacing PATCH semantics on `/uw-model` and `/loan-terms` with `POST /analyses/:id/revisions`.

*Revision v2.17 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.18 — 2026-05-08 (Revision Lineage Spec locked — pre-6.3 architectural step)

### What landed in v2.18

Pre-Batch-6.3 architectural step per user directive: revision-lineage shape defined CENTRALLY before route work begins.

**Companion contract module:** `packages/contracts/src/revision-lineage.ts` — additive types only, no behavior.

| Type / constant | Purpose |
|---|---|
| `RevisionId` | Branded over `ContentHash`. Single brand for all revision identities. |
| `AnalysisId` | Type alias for the root revision's `RevisionId`. |
| `LineageRootId` | Type alias for `AnalysisId` — every revision carries this; never changes (L3). |
| `ParentRevisionId` | `RevisionId | null`. `null` only for root (single-parent topology, §6). |
| `RevisionIdHashInput` | The exact, exhaustive set of fields that participate in `RevisionId` hashing: `parentRevisionId`, `adjustedInputsId`, `doctrineVersion`. Two independent implementations MUST produce byte-identical output. |
| `RevisionLineageEnvelope` | Persisted, content-addressed identity record. Immutable (readonly throughout). |
| `RevisionTrigger` | Closed enum: `USER_EDIT`, `STRESS_ENGINE`, `DOCTRINE_ADJUSTMENT`, `SYSTEM_RECALC`. |
| `AdjustedInputsDiff` | Structured semantic diff for provenance. |
| `RevisionProvenance` | Observable-only sibling record. NEVER participates in identity hash (HARD invariant §4). |
| `LINEAGE_INVARIANTS` | const-asserted array of the 6 lineage invariants (L1–L6) for static inspection. |
| `REVISION_LINEAGE_INVARIANT_SUMMARY` | Single-line CI tag: "lineage is append-only, deterministic, single-parent, content-addressed". |

**Architecture document:** `docs/architecture/revision-lineage-spec.md` — 8 sections operationalizing the user's spec:

- §1 Core identities (table form)
- §2 Revision semantics — what a revision IS and IS NOT
- §3 Lineage invariants L1–L6 (non-negotiable)
- §4 Replay provenance model (observability only)
- §5 Content-hash boundary spec (included / excluded tables)
- §6 Lineage topology rule (single-parent, no DAG)
- §7 API semantics (locked routes for 6.3)
- §8 CI invariant summary

**Storage shape — declared, implementation defers to 6.3 / 6.4:**

| Table | Identity | Content-hashed? | Mutability |
|---|---|---|---|
| `revision_lineage_envelopes` | `revisionId` (= hash of `RevisionIdHashInput`) | Yes — id IS the hash. | Append-only. |
| `revision_provenance` | `revisionId` (FK to envelope) | No — keyed-by-FK only. | Append-only. |

The split is intentional: identity is content-addressed and load-bearing for replay; provenance is descriptive and exists only for observability.

### Doctrinal additions

- **Memory:** `architecture_revision_lineage.md` added to MEMORY.md index. Headline invariants + how-to-apply guidance for all subsequent PRs in lineage / revision / record-graph layers.
- **Architecture cross-reference:** `docs/architecture/batch6-record-graph-and-resolution.md` decisions D4 (revisions, not patches) and D5 (content-hash identity) now have their concrete realization in the lineage spec.

### Verification

- `packages/contracts/` typechecks cleanly with the new module.
- `npm run check:judgment-engine` and `npm run test:doctrine-evaluation` pass (no semantic regressions from the contract addition).
- `npm run lint:boundaries` clean — no module-boundary violations.
- No business code changed; this is contract definition + architecture documentation only.

### Hash-boundary discipline

The §5 boundary table is the single most important enforcement target post-6.3. Reviewer checklist:

- [ ] Are any new fields proposed to be added to `RevisionIdHashInput`? If yes → doctrine-level hash-rotation plan required (changing hash inputs changes EVERY existing revision id; this is a versioned engine bump).
- [ ] Are any of the §5 excluded fields proposed to be added to the hash? If yes → reject; explain the deterministic-replay implication.
- [ ] Does the `RevisionProvenance` access path fully exclude any of its fields from being read by the hash function?
- [ ] Do new `RevisionTrigger` enum values trace to a documented producer that can fire them?

### Notes for resumption

- v2.18 complete (no behavior changes; contract + doc only).
- Sub-batch 6.3 unblocked. The implementation plan in `docs/batch6-implementation-plan.md` §6.3 holds; routes now have a fixed contract to align against.
- Open decision before 6.3 starts: legacy PATCH endpoint behavior — Option A (hard-remove + simultaneous web update) per user prior approval. Confirmed.

*Revision v2.18 locked 2026-05-08. Subsequent revisions append below.*


## Revision v2.19 — 2026-05-08 (Sub-batch 6.3 landed — revision-creating endpoint, legacy-path encoding of the locked spec)

### What landed in 6.3

Mechanical encoding of the revision-lineage spec (v2.18) on the legacy path. Per the user's pre-implementation constraint: "route handlers are now dumb constructors of lineage events, not decision-makers." Every new component below threads existing producers through a lineage envelope; nothing reinterprets meaning.

**Type extensions (additive — `@cre/shared`):**

- `Analysis`: optional `parentAnalysisId`, `lineageRootId`, `revisionOrdinal` — fills out the lineage envelope per spec §1 + §3 (L3 stable across the chain).
- `AnalysisSummary`: same three optional lineage fields for list views.
- `LineageEntry`: new shape returned by `GET /:id/lineage` (id, parentAnalysisId, lineageRootId, revisionOrdinal, createdAt, status, creditScore, riskTier).

**Storage (`apps/api/src/storage/sqlite-store.ts`):**

- Schema: `analyses` table extended with `parent_analysis_id`, `lineage_root_id`, `revision_ordinal` columns.
- Idempotent migration: `ALTER TABLE ADD COLUMN` for older databases; backfill `lineage_root_id = id` for pre-existing root rows.
- `analysisToRow` / `rowToAnalysis` / `createAnalysis` / `listAnalyses` thread the lineage fields.
- Constructor now accepts `:memory:` override for tests.
- New methods:
  - `getLatestRevisionInLineage(id)` — highest `revision_ordinal` in the same lineage as `id` (spec §7 default GET resolution).
  - `listLineage(id)` — full chain ordered by ordinal ascending.

**New service (`apps/api/src/services/revision-creator.service.ts`):**

- `RevisionDelta` tagged-union: `{ type: 'uw-model-cells', updates: [...] }` or `{ type: 'loan-terms', updates: {...} }`.
- `createRevision({ parent, delta })` — pure function. Threads delta through the existing `recalculateFullModel`. Stamps lineage fields. Returns a new `Analysis` with a new uuid; never mutates parent.
- Underwriting recalculation owned by `recalculateFullModel` (existing). Lineage stamping owned by `createRevision`. Doctrine bands owned by the 6.1 decorator. Each layer keeps a single responsibility.

**Route changes (`apps/api/src/routes/analysis.routes.ts`):**

- **REMOVED** `PATCH /:id/uw-model` and `PATCH /:id/loan-terms` (Option A per user approval — no compat shim).
- **NEW** `POST /:id/revisions` — accepts a `RevisionDelta`, calls `createRevision`, persists, decorates with credit-policy bands, returns `{ analysis }`. Status 201.
- **NEW** `GET /:id/lineage` — returns `{ lineage: LineageEntry[] }` ordered by ordinal ascending.
- **CHANGED** `GET /:id` — now resolves the latest revision in the lineage by default per spec §7. `?revisionId=X` query param overrides to a specific historical node, with cross-lineage isolation enforced (404 if `revisionId` is in a different lineage from `:id`).

**Web client (`apps/web/src/lib/api-client.ts` + analysis page):**

- `api.updateUWModel(...)` → `api.createUwModelRevision(...)`. Body: `{ type: 'uw-model-cells', updates: [...] }`.
- `api.updateLoanTerms(...)` → `api.createLoanTermsRevision(...)`. Body: `{ type: 'loan-terms', updates: {...} }`.
- `api.getLineage(id)` added.
- Analysis page handlers updated: `handleUWUpdate` and `handleLoanTermUpdate` consume the new revision response (`{ analysis }`) and replace local state with the new revision.

**Refactor:** `getNestedValue` / `setNestedValue` extracted from `analysis.routes.ts` to `apps/api/src/util/object-path.ts` (used by both the legacy route remnants and the new revision-creator service).

### Spec compliance check

| Invariant | Encoding | Verified by |
|---|---|---|
| L1 — Append-only | `createRevision` returns a new row; `store.createAnalysis` inserts; no UPDATE of lineage columns. | `test:revision-semantics` "L1 — append-only" block |
| L2 — `parentAnalysisId` immutable | Stamped in `createRevision`; never re-assigned. Type is read-only in the contract; storage column is set on INSERT only. | `test:revision-semantics` "L2 + L3" block |
| L3 — `lineageRootId` stable | `createRevision` carries `parent.lineageRootId ?? parent.id` through; storage backfill sets root = id for pre-lineage rows. | "L2 + L3" block |
| L4 — Determinism | Legacy ids are uuid (non-deterministic by spec §7 strict-dispatch — content-hash determinism lands in 6.4). The state computation IS deterministic given the same parent + delta (verified by `recalculateFullModel`'s existing tests). | (deferred to 6.4 for content-hash ids) |
| L5 — No timestamps in identity | Legacy uuid is timestamp-free. `createdAt`/`updatedAt` are stored but never feed identity. | trivially satisfied |
| L6 — No iteration-order leaks | No content-hash on legacy path; comes online in 6.4 with JCS. | (deferred to 6.4) |

The hard deferrals (L4 / L6) are explicit in the spec §7: "Legacy UUID dispatch remains operational during transition." Determinism + canonicalization are new-spine concerns that ship with content-hash ids in 6.4.

### "Dumb constructor" constraint compliance

The user's explicit constraint for 6.3: "If anything in 6.3 starts to 'interpret meaning,' it's a regression." Self-check:

- ✅ Route handler does NOT decide what counts as a delta — body shape is typed; dispatch is by `type` discriminator.
- ✅ Route handler does NOT decide whether to create a revision — POST is the trigger.
- ✅ Route handler does NOT recompute UW values — delegates to `recalculateFullModel`.
- ✅ Route handler does NOT decide which fields are editable — accepts any path that the cell-update / loan-term shape allows; the existing `recalculateFullModel` rejects invalid mutations.
- ✅ Service `createRevision` does NOT interpret the delta semantically — applies it through the existing recalc and stamps lineage.
- ✅ Storage queries (`getLatestRevisionInLineage`, `listLineage`) are pure lineage walks, no policy logic.

### Tests

- **NEW: `test:revision-semantics`** (31 assertions). Exercises append-only persistence, `parentAnalysisId` / `lineageRootId` / `revisionOrdinal` invariants, latest-resolution, lineage chain ordering, cross-lineage isolation, delta application semantics for both delta types, parent-uwModel-missing precondition.
- All 27 existing suites + 2 boot checks pass.
- `npm run lint:boundaries` clean (139 modules, 358 deps).
- `test:revision-semantics` wired into CI workflow.

### Test totals after v2.19

- 28 test suites + 2 boot checks
- Net adds: +31 (test:revision-semantics)
- **Total tests: 951** (was 920)

### Notes for resumption

- 6.3 complete on the legacy path. PATCH endpoints hard-removed; revisions are the only edit path.
- Legacy uses uuid ids; new-spine will use content-hash `RevisionId` per the locked spec when ingestion ships in 6.4.
- Web client already uses revision-creating semantics; URL stays at lineage root, `GET /:id` resolves latest by default.
- **Open follow-up:** the analysis page should display revision history (calling `api.getLineage(id)`) and the "viewing revision N of M" indicator. Not strictly required for 6.3 acceptance but improves UX — track as a polish item or roll into 6.7 render cutover.
- Next: sub-batch 6.4 — new-spine ingestion path. The new spine writes records via the contracts spine (Stage 1–10 producers) into the record-graph store with content-hash ids. The locked revision-lineage spec applies (full envelope semantics).

*Revision v2.19 locked 2026-05-08. Subsequent revisions append below.*
