# Legacy Reduction Plan

> **Status:** Observational / planning artifact. Not a coding directive. Drafted post-6.8 +
> caching + observability + consumer-migration-v1 + type-plumbing tightening.
> **Scope:** Inventory legacy dashboard capabilities, classify gaps vs. `RenderedAnalysis`,
> establish retirement criteria, sequence the migration of remaining legacy-only features.
> **Non-goals:** Mutating render semantics to match legacy. Introducing client-side
> formatting patches. Bypassing the unified-read surface. Editable rendered views.

---

## 1. Context

### Frozen surfaces (do not modify)

- `dispatchByIdFormat` — single classifier
- `GET /api/analyses/:id` dispatch logic — UUID → legacy, content-hash → graph spine
- 12 other id-bearing routes — format-agnostic with natural fall-through
- Render service (RD1–RD5)
- Cache wrapper / observability — additive, side-channel
- HY1–HY7 hydration, PJ1–PJ5 projection invariants

### What's been migrated already

| Surface | Status |
|---|---|
| Server-side: producers → ingest → hydrate → project → render | ✅ shipped 6.3–6.7 |
| `GET /api/analyses/:id` with strict-dispatch | ✅ shipped 6.8 |
| `RenderedAnalysis` cache + observability | ✅ shipped post-6.8 |
| Web client `RenderedAnalysisView` (read-only, display-only) | ✅ shipped consumer-migration-v1 |
| Shared `@cre/contracts` types between server + client | ✅ shipped type-plumbing tightening |

### What this plan covers

The legacy dashboard at `apps/web/src/app/analysis/[id]/page.tsx` (1507 lines) remains
the primary UI surface for **legacy uuid-keyed analyses**. Graph-keyed analyses route
through `RenderedAnalysisView`. To retire the legacy dashboard, we need to (a) inventory
what it does, (b) classify the gaps, (c) decide what's worth migrating, what's worth
deprecating, and (d) sequence the work.

---

## 2. Legacy capability inventory

Cataloged from `apps/web/src/app/analysis/[id]/page.tsx` and the api-client surface it
exercises. Grouped by user's classification axes:
**display-only / mutation-edit / audit-lineage-history / export-reporting / operational**.

### 2.1 Display-only capabilities

| # | Capability | Source field(s) on legacy `Analysis` | Endpoint |
|---|---|---|---|
| D01 | Header: analysis name + status | `analysis.name`, `analysis.status` | GET /:id |
| D02 | Status / progress indicator (during processing) | `analysis.progress`, `analysis.currentStep` | GET /:id/status |
| D03 | Executive summary | `analysis.executiveSummary` | GET /:id |
| D04 | Findings list (filterable by severity) | `analysis.findings[]` | GET /:id |
| D05 | Cross-check findings table | `analysis.crossCheckFindings[]` | GET /:id |
| D06 | Mitigation strategies list | `analysis.mitigationStrategies[]` | GET /:id |
| D07 | Research results (sponsor / market / news) | `analysis.researchResults` | GET /:id |
| D08 | Criteria evaluations | `analysis.criteriaEvaluations[]` | GET /:id |
| D09 | Credit score breakdown — per category | `analysis.creditScore.components[]` | GET /:id |
| D10 | Credit narrative ("Why this score") | `analysis.creditScore.narrative` | GET /:id |
| D11 | Score-improvement suggestions | `analysis.creditScore.improvementSuggestions[]` | GET /:id |
| D12 | B-piece decision — final verdict | `analysis.bPieceDecision.verdict` | GET /:id |
| D13 | B-piece decision — deal breakers | `analysis.bPieceDecision.dealBreakers[]` | GET /:id |
| D14 | B-piece decision — conditions for approval | `analysis.bPieceDecision.conditions[]` | GET /:id |
| D15 | B-piece decision — pricing guidance | `analysis.bPieceDecision.pricingGuidance` | GET /:id |
| D16 | UW model — income lines (line-item table) | `analysis.uwModel.income.*` | GET /:id |
| D17 | UW model — expense lines | `analysis.uwModel.expenses.*` | GET /:id |
| D18 | UW model — metrics row | `analysis.uwModel.metrics` (dscr/ltv/dy/noi/value) | GET /:id |
| D19 | Payment schedule table | `analysis.uwModel.repaymentSchedule[]` | GET /:id |
| D20 | Stress scenario results table | `analysis.uwModel.stressScenarios[]` | GET /:id |
| D21 | Loan structure card | `analysis.loanDetails.*` | GET /:id |
| D22 | Timeline card | `analysis.timeline` | GET /:id |
| D23 | Comments / annotations panel | `analysis.comments[]` | GET /:id |
| D24 | Version info | `analysis.version`, `analysis.modelVersionId` | GET /:id |

### 2.2 Mutation / edit flows

| # | Capability | Endpoint |
|---|---|---|
| M01 | Add comment to a section / finding | POST /:id/comments |
| M02 | Edit a UW-model cell (creates immutable revision) | POST /:id/revisions (`uw-model-cells`) |
| M03 | Edit loan terms (creates immutable revision) | POST /:id/revisions (`loan-terms`) |
| M04 | Run stress test | POST /:id/stress-test |

### 2.3 Audit / lineage / history

| # | Capability | Endpoint |
|---|---|---|
| A01 | Lineage chain (parent → child revisions) | GET /:id/lineage |
| A02 | Specific historical revision | GET /:id?revisionId=... |
| A03 | Audit log | GET /:id/audit |

### 2.4 Export / reporting

| # | Capability | Endpoint |
|---|---|---|
| E01 | Populated template download | GET /:id/populated-template |
| E02 | Populated template availability info | GET /:id/populated-template/info |

### 2.5 Operational tooling

| # | Capability | Endpoint |
|---|---|---|
| O01 | Status polling (during ingestion) | GET /:id/status |
| O02 | Delete analysis | DELETE /:id |
| O03 | Compare analyses | GET /compare |
| O04 | Model versions index | GET /model-versions |
| O05 | Audit log index | GET /audit-log |

---

## 3. RenderedAnalysis v1 surface (canonical truth source)

For comparison.

| Section | Cells |
|---|---|
| `summary` | `ratingBand`, `finalScore` |
| `metrics` | `dscr`, `ltv`, `debtYield`, `noi` |
| `valuation` | `finalValue`, `anchorUsed` |
| `doctrine` | `mechanicalScore`, `weightedAggregate`, `flags[]` |
| `dataQuality` | `flags[]` |
| `metadata` | `hashedAt`, `renderVersion` |

That's **10 cells + 2 badge arrays + 1 metadata block**.

Legacy dashboard surfaces ~24 display capabilities + 4 mutation flows + 3 audit/lineage
+ 2 export + 5 operational. The legacy surface is **substantially wider than v1 RenderedAnalysis**
by intentional design: v1 is the materialized truth core; the rest is migration scope.

---

## 4. Coverage matrix

For each legacy capability, classify its status against `RenderedAnalysis` v1.

**Status legend:**
- ✅ **covered** — fully present in `RenderedAnalysis` v1
- 🟢 **partial** — value is reachable through a different field; client could derive (but should not — display-only is server's job)
- ⚪ **missing render field** — should be added to `RenderedAnalysis` in a future version (not yet)
- 🔄 **mutation flow** — out of read-model scope; depends on writable rendered semantics (deferred)
- 📜 **audit / lineage** — out of read-model scope; needs separate endpoint design
- 📦 **export** — out of read-model scope; orthogonal concern
- ⚙️ **operational** — out of read-model scope

| ID | Capability | Status | Notes |
|----|---|:---:|---|
| D01 | Name + status | ⚪ | Status is a write-side concept (only meaningful for legacy ingestion). Graph analyses are immutable post-ingest; no `status` field needed in `RenderedAnalysis`. Header label could be `dealRef` from extraction. |
| D02 | Progress indicator | ⚪ | Only relevant to legacy async ingestion. Graph ingestion is synchronous; no progress concept. |
| D03 | Executive summary | ⚪ | Free-text producer output. Not in v1 RenderedAnalysis. Future: a `narrative` section on `RenderedAnalysis`. |
| D04 | Findings list | ✅ | **Shipped at render version 7.2** as the fifth and final Phase-1 additive parity expansion. Top-level `findings: readonly RenderedFinding[]` bijectively projects `DoctrineEvaluation.reasons[]`; each entry is `{ruleId, reasonCode}` (ruleId from `DoctrineRuleId`, reasonCode from `DoctrineReasonCode`). Ordering and count preserved exactly. **Producer-side note:** doctrine reasons do not carry per-finding severity (architecture: bounded labels, not graded warnings). Render does NOT synthesize severity; if severity is needed for display grouping, it is a producer-spine architectural decision. |
| D05 | Cross-check findings table | ⚪ | **Known v1 gap (6.4):** ingestion emits empty `CrossCheckResult.findings[]` because the cross-check producer signature is legacy-shaped (see `docs/batch6-implementation-plan.md` §6.4 "Open architectural decisions"). Producer refactor is its own batch. |
| D06 | Mitigation strategies | ⚪ | Producer-side artifact not in spine yet. Was AI-generated in legacy. New-spine equivalent TBD. |
| D07 | Research results | ⚪ | External-data integration; outside the deterministic spine. May not migrate (operational concern). |
| D08 | Criteria evaluations | ⚪ | Manifesto evaluation results exist on `AdjustedInputs.topLevelAdjustments` but not projected. Future. |
| D09 | Credit score breakdown — per category | ✅ | **Shipped at render version 6.8** as the first additive parity expansion. `doctrine.components[]` bijectively projects `DoctrineEvaluation.componentScores[]` (name, ruleId, rawValue, score, weight, contribution, reasonCodes-as-badges). |
| D10 | Credit narrative | ⚪ | Free-text producer output. Future. |
| D11 | Improvement suggestions | ⚪ | Was AI-generated. Operational / out-of-spine. |
| D12 | B-piece verdict | ⚪ | Out-of-spine (different deliverable). Possibly retire entirely. |
| D13 | Deal breakers | ⚪ | Out-of-spine. Possibly retire. |
| D14 | Approval conditions | ⚪ | Out-of-spine. Possibly retire. |
| D15 | Pricing guidance | ⚪ | Out-of-spine. Possibly retire. |
| D16 | UW model income lines | ✅ | **Shipped at render version 6.9** as the second additive parity expansion. `incomeLines[]` (top-level) bijectively projects `AdjustedInputs.income.*` (5 lines: grossRentalIncome, otherIncome, vacancyPct, concessionsPct, effectiveGrossIncome). Each entry carries `name` / `raw` / `adjusted` / `source` / `adjustments[]` ledger. |
| D17 | UW model expense lines | ✅ | **Shipped at render version 6.9** alongside D16. `expenseLines[]` (top-level) projects `AdjustedInputs.expenses.*` (8 lines: realEstateTaxes, insurance, utilities, managementFee, payroll, maintenance, other, totalOperatingExpenses). Same shape as D16. |
| D18 | UW model metrics row | ✅ | `metrics.dscr/ltv/debtYield/noi` already in `RenderedAnalysis`. Legacy dashboard's metrics row maps 1:1. |
| D19 | Payment schedule | ⚪ | Producer-side artifact. Schedule is computed by `recalculateFullModel` (legacy). New-spine equivalent unclear. |
| D20 | Stress scenarios table | ✅ | **Shipped at render version 7.1** as the fourth additive parity expansion. Top-level `stress: {method, scenarios[]}` mirroring `StressOutputs`. Each `RenderedStressScenario` projects name + 5 metric cells (noi/dscr/value/ltv/debtYield) + breach/skipped badge arrays. Render does not recompute breach outcomes — producer's `breaches[]` is the truth source. |
| D21 | Loan structure | ✅ | **Shipped at render version 7.0** as the third additive parity expansion. Top-level `loan` named-field struct mirroring `AdjustedInputs.loan` (7 fields: loanAmount, interestRate, termMonths, amortizationMonths, ioPeriodMonths, maturityBalance, debtServiceAnnual). Each field is a `RenderedLineItem`. Render does not recompute `debtServiceAnnual` or `maturityBalance` — both are producer-emitted. |
| D22 | Timeline | ⚪ | Producer-side / extraction artifact. May be a `narrativeFacts`-derived section. Future. |
| D23 | Comments panel | 🔄 | Comments are append-only mutation state; require their own endpoint integration. **Not a `RenderedAnalysis` concern.** |
| D24 | Version info | 🟢 | `metadata.renderVersion` already in v1; full doctrineVersion / judgmentEngineVersion stamps live on `DoctrineEvaluation` and could surface in metadata. |
| M01 | Add comment | 🔄 | Mutation flow. Out of v1 read-model scope. |
| M02 | UW-cell edit (revision) | 🔄 | Editable rendered semantics — deferred per directive. |
| M03 | Loan term edit (revision) | 🔄 | Same. |
| M04 | Run stress | 🔄 | Same. |
| A01 | Lineage chain | 📜 | GET /:id/lineage exists today. Could be wired to the rendered view as a side panel without re-deriving anything. |
| A02 | Historical revision | 📜 | GET /:id?revisionId= already supported on legacy; unified-read keeps this format-agnostic. |
| A03 | Audit log | 📜 | Operational; possibly retire. |
| E01 | Populated template download | 📦 | Export concern; orthogonal to read model. Stays as legacy endpoint. |
| E02 | Template availability info | 📦 | Same. |
| O01 | Status polling | ⚙️ | Legacy-only; graph analyses are immutable. Polling stops automatically for graph-keyed responses (consumer-migration v1). |
| O02 | Delete | ⚙️ | Architecture: graph store is append-only (L1). Delete is a legacy concept. |
| O03 | Compare | ⚙️ | Cross-analysis comparison. Out of read-model scope. |
| O04 | Model versions | ⚙️ | Operational. Stays. |
| O05 | Audit log index | ⚙️ | Operational. Stays. |

### Coverage summary

| Status | Count | Notes |
|--------|------:|---|
| ✅ covered | 1 | metrics row (D18) |
| 🟢 partial | 1 | version info (D24) |
| ⚪ missing render field | 17 | The largest bucket. Each requires a contract addition + render-schema update + producer-side surface. **Migration scope.** |
| 🔄 mutation flow | 4 | Editable rendered semantics — deferred. |
| 📜 audit/lineage | 3 | Endpoint exists; UI wiring is the work. |
| 📦 export | 2 | Orthogonal. Stays as legacy. |
| ⚙️ operational | 5 | Mostly stays; some retire by content-hash semantics. |

---

## 5. Mismatch classification framework

When the parity corpus runs, every divergence between legacy output and `RenderedAnalysis`
falls into one of four categories.

### 5.1 Intentional modernization

The new spine produces a DIFFERENT (and correct) result because the legacy was wrong,
inconsistent, or violated an architectural invariant.

**Examples:**
- Legacy applied `?? 0` to missing NOI; new spine surfaces `null` + `INSUFFICIENT_DATA` flag (architecture §8 ban on null→0 coercion).
- Legacy hardcoded credit thresholds in UI; new spine emits doctrine-classified rating bands (Batch 6.1).
- Legacy used the adapter for line-item synthesis; new spine bypasses it (D7 isolation).

**Action:** record divergence in the parity report; tag as `intentional-modernization`.
**Do not back-port.** The new behavior is the spec.

### 5.2 Legacy bug

The legacy output is observably wrong (silently swallowed errors, threshold drift, hidden
fallbacks producing incorrect display values).

**Examples:**
- Legacy displayed DSCR computed against pre-floor expense ratio; new spine uses post-floor.
- Legacy classified `n=15` library data as fully usable; new spine emits library-degraded flag.

**Action:** record in parity report; tag as `legacy-bug`. **Do not patch the new spine** to
reproduce the bug. The migration story includes "this previously displayed wrong" as a
disclosed change to consumers.

### 5.3 Missing render field

The new spine is correct, but `RenderedAnalysis` does not yet expose the data the legacy
displayed. The data exists upstream (typed records in record-graph store) but has not
been projected into the render contract.

**Examples (all rows tagged ⚪ in §4):**
- Income/expense line items (D16/D17) — exist on `AdjustedInputs`; not in render schema.
- Per-category credit-score breakdown (D09) — exists on `DoctrineEvaluation.componentScores`; not in render schema.
- Stress scenarios (D20) — exists on `StressOutputs.scenarios`; not in render schema.

**Action:** record in parity report; tag as `missing-render-field`. **Resolve by adding to
`RenderedAnalysis` contract** in a dedicated PR with: (a) a new section in the contract,
(b) render-schema update, (c) `RenderedAnalysisView` consumption, (d) `RENDER_VERSION` bump,
(e) cache invalidates naturally (new entries at the new version; old version coexists).

### 5.4 Migration gap

The legacy capability has no current new-spine equivalent because the underlying producer
work hasn't been done yet (or because the capability is fundamentally a write-side or
out-of-spine concern).

**Examples:**
- Cross-check findings (D05) — producer signature mismatch; refactor is a separate batch.
- Mitigations (D06), narrative (D10), B-piece decision (D12–D15) — were AI-generated; new-spine path TBD.
- Comments (D23, M01) — write-side concern; deferred until editable-rendered semantics are designed.

**Action:** record in parity report; tag as `migration-gap` with a sub-tag (`producer-pending` /
`out-of-spine` / `deferred-write-side`).

---

## 6. Retirement readiness matrix

For each legacy capability, define an objective **retire-when** condition. The legacy
dashboard can be retired only when all `must-retire` rows have their conditions met.

| ID | Capability | Retire when… | Tier |
|----|---|---|:---:|
| D01–D02 | Name / status / progress | Graph-keyed analyses are the dominant data set; legacy ingestion is sunset | low |
| D03 | Executive summary | A `narrative.executiveSummary` field is added to `RenderedAnalysis` OR feature is officially deprecated | medium |
| D04 | Findings | ✅ shipped at render version 7.2 — projected as top-level `findings[]` (bijective from `DoctrineEvaluation.reasons[]`) | ✅ ready |
| D05 | Cross-check | Cross-check producer refactored to new-spine shape; `crossCheck` section added to `RenderedAnalysis` | **high** (load-bearing for credit-quality visibility) |
| D06 | Mitigations | Either: (a) new-spine mitigation producer ships, OR (b) feature deprecated | medium |
| D07 | Research results | Decision: keep operational endpoint as-is, or sunset feature | low |
| D08 | Criteria evaluations | Manifesto evaluations projected into `RenderedAnalysis` | medium |
| D09 | Credit-score breakdown | ✅ shipped at render version 6.8 — projected as `doctrine.components[]` | ✅ ready |
| D10 | Credit narrative | A `narrative` section is added to `RenderedAnalysis` | medium |
| D11 | Improvement suggestions | Decision: keep AI feature as legacy-only, or migrate to new-spine producer | low |
| D12–D15 | B-piece decision | Decision: rebuild as new-spine producer, or sunset | low (likely sunset) |
| D16–D17 | UW line items | ✅ shipped at render version 6.9 — projected as top-level `incomeLines[]` + `expenseLines[]` | ✅ ready |
| D18 | Metrics row | ✅ already covered | — |
| D19 | Payment schedule | Decision: amortization schedule producer ships in new spine, OR feature sunset | medium |
| D20 | Stress scenarios | ✅ shipped at render version 7.1 — projected as `stress: {method, scenarios[]}` | ✅ ready |
| D21 | Loan structure | ✅ shipped at render version 7.0 — projected as named-field `loan` section | ✅ ready |
| D22 | Timeline | Producer-side surface for timeline data; OR feature sunset | low |
| D23 | Comments | Editable-rendered semantics defined (deferred) | **deferred** |
| D24 | Version info | All upstream version stamps surfaced in `metadata` | low |
| M01–M04 | Mutation flows | Editable-rendered semantics defined (deferred) | **deferred** |
| A01 | Lineage chain | Legacy endpoint wired to a side-panel component on `RenderedAnalysisView` (no re-derivation; just renders the chain as a list) | low |
| A02 | Historical revision | `?revisionId=` already format-agnostic; works today | ✅ ready |
| A03 | Audit log | Decision: keep as legacy-only; not load-bearing | low (likely retain endpoint, retire UI surface) |
| E01–E02 | Populated template | Stays as legacy endpoint indefinitely; unrelated to read model | — |
| O01 | Status polling | Already disabled for graph-keyed analyses (consumer-migration-v1) | ✅ ready |
| O02 | Delete | Graph analyses are append-only; delete is legacy-only | ✅ ready (won't apply to graph) |
| O03 | Compare | Decision: rebuild on `RenderedAnalysis` shape, or retire | low |
| O04–O05 | Operational indices | Stays | — |

---

## 7. Migration sequencing plan

Phased plan ordered by **load-bearing weight** (impact on retirement readiness) and
**architectural coupling** (how much new-spine work each requires). Each phase is
self-contained and can ship independently.

### Phase 1 — High-value display-only migrations

These add to `RenderedAnalysis` what already exists in upstream typed records. No producer
work; just contract + schema + render-view + view-consumer. Each phase 1 item bumps
`RENDER_VERSION`; cache layer handles the version split automatically (post-6.8 caching
semantics). PJ2 / RD2 discipline preserved (no re-derivation; just projection).

1. ✅ **`doctrine.components[]` projection** (D09) — **SHIPPED at render version 6.8.** Adds a per-category score table to render output (name, ruleId, rawValue, score, weight, contribution, reasonCodes). First additive parity expansion validated; cache-partition continuity preserved (entries at 6.7 orphan; 6.8 entries computed fresh; deterministic content hash holds).
2. ✅ **`incomeLines[]` + `expenseLines[]`** (D16, D17) — **SHIPPED at render version 6.9.** Top-level arrays projecting `AdjustedInputs.income.*` (5 lines) and `AdjustedInputs.expenses.*` (8 lines). Each entry carries `name`, `raw`, `adjusted`, `source`, and the `adjustments[]` ledger. Render-side discipline preserved (no arithmetic, no re-derivation of `adjusted` from raw + sum-of-deltas; producer's `adjusted` is the truth source).
3. ✅ **`loan` section** (D21) — **SHIPPED at render version 7.0.** Top-level named-field struct (`RenderedLoanSection`) mirroring `AdjustedInputs.loan`: 7 fields, each a `RenderedLineItem`. Bijective passthrough; render-side discipline preserved (no recomputation of debtServiceAnnual or maturityBalance). Phase-1 third additive expansion validated; D09/D16/D17/D21 all on the same expansion pattern.
4. ✅ **`stress.scenarios[]`** (D20) — **SHIPPED at render version 7.1.** Top-level `stress` section mirroring `StressOutputs.method` + `StressOutputs.scenarios[]`. Each scenario carries 5 producer-emitted metric cells (noi/dscr/value/ltv/debtYield) plus breach/skipped covenant codes promoted to badges. Render-side discipline preserved (no recomputation of breach outcomes; no threshold logic). Phase-1 fourth additive expansion.
5. ✅ **`findings[]`** (D04) — **SHIPPED at render version 7.2 — final Phase-1 expansion.** Top-level array bijectively projecting `DoctrineEvaluation.reasons[]`. Each finding is exactly `{ruleId, reasonCode}` — both fields preserved exactly, ordering preserved, counts preserved. **Migration discipline locked:** render is a deterministic translator, not an analyst — no severity synthesis, no rationale text generation, no priority ranking, no collapsing. Where the legacy dashboard had per-finding severity badges, the rendered surface intentionally does not — severity is a producer-spine concern (doctrine layer treats reasons as bounded labels, not graded warnings). If/when the doctrine adds per-finding severity, `RenderedFinding` extends additively.

### Phase 2 — Producer-pending migrations

Require new-spine producer work BEFORE the render projection. Each is a separate batch.

6. **Cross-check producer refactor** (D05) — refactor `buildCrossCheckResult` to consume `(extractionResult, adjustedInputs, analysisAsOfDate)` instead of legacy `sellerMetrics + uwModel`. Then project `crossCheck.findings[]`.
7. **Manifesto-evaluation projection** (D08) — already runs (judgment engine emits manifesto outcomes). Project as `criteria[]`.
8. **Narrative producer** (D03, D10) — design TBD; possibly an AI-summarization step that consumes `RenderedAnalysis` and produces a typed narrative record.

### Phase 3 — Lineage / audit visibility

9. **Lineage side-panel** (A01) — wire GET /:id/lineage to a side-panel component on `RenderedAnalysisView`; renders the parent chain. Read-only; calls existing endpoint.
10. **Historical revision viewer** (A02) — already format-agnostic on the endpoint; UI work to surface it on the rendered view.

### Phase 4 — Editable rendered semantics (DEFERRED)

11. **Comments** (D23, M01) — requires a writable-rendered-state contract design.
12. **UW edits** (M02), **loan-term edits** (M03), **stress runs** (M04) — same.

**Per the directive:** do not begin Phase 4 until Phases 1–3 are stable, the parity corpus
shows clean coverage of read concerns, and the architectural domain of writable rendered
semantics has been explicitly opened.

### Phase 5 — Sunsets

Decisions, not migrations. Each item below should get an explicit deprecation decision
before the legacy dashboard is fully retired.

13. **B-piece decision** (D12–D15) — rebuild on new spine, or sunset?
14. **Mitigations** (D06) — rebuild on new spine, or sunset?
15. **Improvement suggestions** (D11) — sunset?
16. **Compare** (O03), **research feature** (D07) — keep as legacy-only operational tools, or rebuild?
17. **Audit log UI** (A03, O05) — keep as legacy operational, retire the dashboard surface?

---

## 8. Parity corpus methodology

### 8.1 What the corpus IS

A set of fixture pairs documenting, for representative deals, **what the legacy dashboard
displays vs. what `RenderedAnalysis` exposes**. The corpus is **observational** — it
catalogs divergences with classifications. It is NOT a regression suite that fails the
build on mismatch.

### 8.2 What the corpus is NOT

- A mechanism to enforce parity. (We don't want parity enforcement; we want classification.)
- A justification to back-port legacy behavior into the new spine.
- A way to bypass the unified-read surface. The legacy snapshot must come from
  `GET /api/analyses/:id` against a uuid; the new snapshot must come from
  `GET /api/analyses/:id` against a content-hash. No internal store reads, no synthesized
  data outside the unified-read surface.

### 8.3 Fixture format

Each fixture lives at `apps/api/fixtures/parity/{name}/`:

| File | Content |
|---|---|
| `extraction-result.json` | Synthetic `ExtractionResult` input that drives the new-spine ingestion |
| `expected-rendered.json` | Snapshot of `GET /api/analyses/{rootId}` after ingesting the extraction; canonical truth from new spine |
| `expected-legacy.json` | Hand-authored snapshot representing what the legacy dashboard WOULD have displayed for the equivalent deal |
| `parity-report.md` | Per-field classification: `match` / `intentional-modernization` / `legacy-bug` / `missing-render-field` / `migration-gap` |

### 8.4 Reporter script (read-only)

`apps/api/src/scripts/parity-report.ts` (skeleton ships in this phase; real fixtures are
added incrementally):

- Reads each `apps/api/fixtures/parity/*/parity-report.md`
- Aggregates classifications across fixtures
- Emits a summary: count by classification per fixture, cross-fixture totals, any
  un-classified fields (red flag — every divergence MUST be classified)
- Read-only: no comparison enforcement; no PR-blocking behavior

### 8.5 Adding new fixtures

Each new fixture should:

1. Pick a representative scenario (asset class × business plan × data-quality regime).
   Initial set targets: Office stabilized, Multifamily stabilized, Office lease-up,
   Hotel with PIP, library-degraded (`n<20`).
2. Synthesize the `extraction-result.json` (deterministic from a seed; mirrors the
   pattern in `test-ingest-pipeline.ts`).
3. Run ingestion + render to produce `expected-rendered.json`.
4. Hand-author `expected-legacy.json` from a representative real legacy analysis (or
   synthesize against the legacy ingestion path).
5. Walk every legacy field; classify it. Any unclassified field is a red flag.
6. Update `parity-report.md` with prose context for non-trivial classifications
   (especially `intentional-modernization` and `legacy-bug` rows — those need explicit
   rationale).

---

## 9. Out of scope (per directive — do not revisit)

- Dispatch architecture
- Render semantics
- Caching semantics
- Observability topology
- Client-side semantic reconstruction
- Mirrored type systems
- Editable rendered views (deferred until parity coverage + dependency inventory + risk measure)
- Render-side mutation endpoints
- Dual-mode editing semantics
- Expanding `RenderedAnalysis` into a writable state container

---

## 10. Document status

- **Drafted:** post-6.8 + post-caching + post-observability + post-consumer-migration-v1 + post-type-plumbing-tightening.
- **Owner:** architecture (CRE Credit Committee Platform).
- **Review cadence:** at the close of each migration phase. Each phase concluded should
  update §6 (retirement readiness matrix) to flip the relevant rows from "retire when…"
  to "✅ ready."
- **End state:** when every row in §6 reads ✅ or has an explicit "deferred / retain as
  legacy / sunset" decision recorded, the legacy dashboard can be retired.
