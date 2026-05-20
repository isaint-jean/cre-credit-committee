# Batch 6 Architecture — Record Graph & Resolution

> **Status:** Locked 2026-05-08 after architecture review.
> **Scope:** Stages 11–13 (hydration → resolver → render) and the legacy/new pipeline boundary.
> **Purpose:** Foundational architectural doctrine. Long-term PR review criteria. Every PR touching `services/hydrate-*`, `services/resolve-*`, `services/render-*`, the record-graph store, or the legacy/new boundary MUST satisfy the invariants in this document.
> **Supersedes:** prior cutover-layer notes in `docs/judgment-engine-plan.md`.

## 1. Pipeline shape

```
extraction → producer stages (1–10) → hydration (11) → resolver (12) → render (13)
                                            ↓                ↓             ↓
                                  HydratedRecordGraph → UnderwritingContext → rendered output
```

Each arrow is one-way. No upward calls. No skipped stages. No back-pressure to producers from the resolver or render.

## 2. Stage 11 — HydratedRecordGraph

### 2.1 Definition

A typed bundle of pointers to the 9 records that constitute one analysis, retrieved by FK closure from a single `DoctrineEvaluationId` root.

```ts
interface HydratedRecordGraph {
  doctrineEvaluation:  DoctrineEvaluation;
  valuationConclusion: ValuationConclusion;
  stressOutputs:       StressOutputs;
  crossCheckResult:    CrossCheckResult;
  adjustedInputs:      AdjustedInputs;
  narrativeFacts:      NarrativeFacts;
  librarySnapshot:     LibrarySnapshot;
  assetProfile:        AssetProfile;
  extractionResult:    ExtractionResult;   // narrative / audit display only — see §2.3
}
```

### 2.2 Invariants

**H1 — Typed graph, not flattened context.** The bundle preserves record types and provenance. Flattening to a bag of fields is forbidden. Reasons: (a) destroys provenance, (b) creates shadow sources of truth, (c) enables hidden fallback chains, (d) makes field ownership non-inspectable in PR review.

**H2 — Single root, total closure.** Given a `DoctrineEvaluationId`, all 8 upstream FKs resolve to actual rows in the record-graph store. A dangling FK is structural corruption — hydration throws. Silent substitution is forbidden.

**H3 — No computation.** Hydration only reads + assembles. Zero math, zero branching by asset class, zero metric re-derivation, zero defaulting.

**H4 — Determinism.** Same root id → byte-identical bundle. Content-hash ids + content-hash FKs make this automatic. No `Date.now()`, no random, no env reads in hydration.

**H5 — Mode-invariant.** The bundle does not depend on UW vs Bank vs Adjusted view mode. Mode is a resolver parameter (§3.2 R2), not a hydration parameter.

**H6 — Version-self-consistent. `DoctrineEvaluationId` is version-bound.** Each record carries the version axes in effect when it was written. If `DOCTRINE_VERSION` (or any other axis) advances, replay produces a *new* `DoctrineEvaluationId` — never an in-place mutation. Historical analyses are immutable.

**H7 — Producer outputs are immutable.** Persisted records are append-only and content-hash-addressed. No row is ever patched in place. Re-runs produce new ids. Re-versioned engines produce new ids.

### 2.3 ExtractionResult isolation — HARD architectural boundary

`ExtractionResult` is included in the bundle for narrative / audit display (cross-check tab, evidence pinning, original-document reconciliation). **It MUST NOT influence any producer or computation OUTSIDE the explicit allow-list below.**

**Permitted consumers — exhaustive allow-list:**

1. **Stage 1 — extraction / audit flows.** `services/extraction/*`, parser services (data-extraction, document-parser, excel-parser, pdf-parser, word-parser).
2. **Stage 4 — judgment-engine transformation.** `services/judgment/*` legitimately consumes `ExtractionResult` to produce `AdjustedInputs`. This is the ONLY producer that reads the extraction record; every other producer downstream of Stage 4 reads `AdjustedInputs` (or further downstream records) instead.
3. **Stage 11 — hydration.** `services/hydrate-*` loads `ExtractionResult` into the `HydratedRecordGraph` for narrative / audit display only.
4. **Render audit-display tooling.** The audit-tab render route may surface `ExtractionResult` content for evidence pinning; render computations of derived values must NOT read it.

**Forbidden consumers** of `ExtractionResult` (everything else, including):

- `services/doctrine/*`
- `services/valuation.service`
- `services/stress-test.service`, stress-engine extensions
- `services/cross-check.service`, `services/cross-check-contracts.service`
- `services/resolve-*`
- render computations (display values are sourced from `AdjustedInputs`, `NarrativeFacts`, `ValuationConclusion`, etc.; raw extraction surfaces only in the audit / cross-check view routed through hydration)

**Enforcement — module-boundary policy, NOT grep audits.**

- ESLint `no-restricted-imports` rule: only the four allow-listed consumer scopes (Stage 1, Stage 4 judgment, Stage 11 hydration, render audit-display) may import the `ExtractionResult` type or its computed-id helper.
- `dependency-cruiser` (or `madge`) policy: `apps/api/src/services/{doctrine,valuation,stress,cross-check,resolve-*}` cannot resolve a path to `services/extraction/*` or to any module exporting `ExtractionResult`-shaped data. **Note:** `services/judgment/*` is excluded from this deny-list — it is the legitimate Stage 4 consumer.
- CI gate: the policy check is part of `npm run lint:boundaries` and blocks merge.
- A negative test (`test:extraction-isolation`) attempts a forbidden import in a sandbox file and asserts the lint rule errors. Without this test, the rule rots silently.

## 3. Stage 12 — Resolver

### 3.1 Definition

```ts
function resolve(bundle: HydratedRecordGraph, mode: UnderwritingMode): UnderwritingContext;
```

A pure projection from a typed bundle to the render-input shape, parameterized by view mode. The resolver replaces the legacy `resolve-underwriting-context.ts` after the audit in §6.1.

### 3.2 Invariants

**R1 — Total source map.** Every field in `UnderwritingContext` has exactly one declared source path of the form `bundle.<record>.<field>`. The map is enumerable at compile time and PR-review-greppable. No conditional source selection. No runtime path computation.

**R2 — Mode is a view selector, not a data switch.** `mode ∈ {UW, Bank, Adjusted}` chooses *which projection field* on `AdjustedLineItem` to surface (`adjusted` vs `raw` vs UW perspective). Mode never picks a different record. The records are mode-invariant; only the projection varies.

```
HydratedRecordGraph
    ↓
projection(mode)
    ↓
UnderwritingContext
    ↓
render
```

**R3 — No underwriting logic — expanded definition.**

The following are all forbidden in the resolver:

| Pattern                  | Example                                                    |
| ------------------------ | ---------------------------------------------------------- |
| Asset-class branching    | `if (assetClass === 'Office') ...`                         |
| Numeric normalization    | `Math.max(0, value)` to scrub negatives                    |
| Fallback precedence      | `adjusted ?? uw ?? raw`                                    |
| Null coercion            | `noi ?? 0`, `value ?? 0`, `array ?? []`                    |
| Derived UW booleans      | `dscrFails: dscr < 1.0`, `coversInterest: noi > debtSvc`   |
| Implicit recomputation   | recomputing NOI / DSCR / value rather than reading `metrics.*` |
| Semantic sorting         | sorting findings by "severity" or any meaning-bearing key |
| Implicit aggregation     | summing line items into a total when a canonical total exists |

**Allowed transforms — structural, deterministic, semantic-free:**

- Pick: `bundle.adjustedInputs.metrics.dscr`
- Rename: `bundle.X.fooId` → `context.fooReferenceId`
- Re-key: array → keyed map by `id`
- Mode-projection: `mode === 'UW' ? lineItem.uw : mode === 'Bank' ? lineItem.raw : lineItem.adjusted`
- Deterministic ordering: emit array in producer order or by content-hash sort

If a transform doesn't fit one of these five shapes, it doesn't belong in the resolver.

**R4 — Null fidelity.** `null` flows through unchanged. Sentinel display ("—", "N/A", "Insufficient data") is the render layer's job, not the resolver's.

**R5 — Pure function.** `(bundle, mode) → context`. No clock, no random, no env, no disk, no network, no global state.

**R6 — Deterministic ordering.** Any array-valued field is emitted in producer order or a documented hash-stable sort. No `Object.keys(...)` iteration-order leaks.

**R7 — No back-pressure.** The resolver does not call into doctrine, valuation, judgment, hydration, or storage. Everything required is in the bundle.

**R8 — Failure surfacing, not failure repair.** `INSUFFICIENT_DATA` reason codes and `dataQualityFlags` flow through to the context unchanged. The resolver never re-classifies, hides, or "softens" degraded state.

### 3.3 Smell tests — reject on sight in PR review

- `if (assetClass === ...)` anywhere in `resolve-*.ts`
- Any `??`, `||`, ternary that could change a *numeric* value (vs. a label string)
- Any `.filter(Boolean)`, `.filter(x => x != null)` that suppresses degraded state
- Any default parameter or empty-array substitution on a record field
- Function names with verbs `compute`, `derive`, `aggregate`, `normalize`, `default`, `coalesce`

## 4. Stage 13 — Render

### 4.1 Render boundary invariants

**D1 — Render imports nothing computational.** The render layer (`services/render-*`, `routes/render`, `apps/web` analysis page) MUST NOT import:

- producers: `services/extraction/*`, `services/judgment/*`, `services/doctrine/*`, `services/valuation.service`, `services/stress-test.service`, `services/cross-check.service`
- stores: `storage/*`, `record-graph-store`, `approved-deals-store`
- calculators: `services/judgment/amortization`, `services/judgment/date-math`, anything performing math

**D2 — Render's permitted dependencies.**

- `UnderwritingContext` (resolver output)
- `services/render-schema` (the four-axis schema definition)
- `services/render-output-scrubber`, formatting utilities (sentinel display, locale formatting)
- `@cre/contracts` *types only* — no runtime functions that compute hashes, evaluate rules, or otherwise carry policy

**D3 — Schema exhaustiveness.** Every `UnderwritingContext` field is either:

- rendered through the schema (mapped to a render cell), OR
- explicitly marked `@internal` / `@audit-only` in the context type definition.

Dead fields accumulate into silent drift. A boot-time / CI check enumerates context fields, intersects with schema usage, and fails on unaccounted fields. Likewise, every render-schema cell maps to exactly one `UnderwritingContext` field (no schema cell sourced from a literal, no cell with multiple potential sources).

**D4 — Render four-axis index unchanged.** Schema indexed by (`contractVersion`, `assetClass`, `variantKey`, `underwritingMode`). Same `(assetClass, RENDER_CONTRACT_VERSION)` → identical structural output. No silent drift in `ASSET_CLASS_TABS` or schema. (Existing hard invariant — see memory.)

**D5 — Excel role unchanged.** Excel / Office Scripts remain a view layer. No UW logic in VBA or worksheet formulas. (Existing hard invariant — see memory.)

## 5. Legacy / new boundary

### 5.1 Storage strategy — STRICT DISPATCH (locked)

**Decision:** Strict dispatch by analysis id. Dual-write rejected.

- Legacy analysis ids → legacy pipeline (existing `sqlite-store`, existing services)
- Graph-backed analysis ids → new spine (record-graph store, Stages 1–13)
- Dispatch happens at the route handler entry point. Each id has exactly one path.

**Rejected: dual-write.** Reasons: sync ambiguity between two stores, race conditions, debugging complexity, parity drift over time, recovery edge cases (one write succeeds, the other fails).

The parity corpus (§5.3) provides validation without dual-writing in production.

### 5.2 Boundary invariants

**B1 — Behavioral parity for migrated analyses.** Snapshot N existing analyses pre-cutover; replay through the new pipeline. Diff numbers, flags, rating bands. Differences must be (i) intentional, (ii) attributable to a named fix, (iii) documented in the cutover migration note.

**B2 — API contract continuity.** `/analysis/:id`, `/render`, and related endpoints do not break the web client. New fields land additively. Breaking changes get a versioned endpoint.

**B3 — All 7 version axes survive cutover.** DOCTRINE, JUDGMENT_ENGINE, STRESS_ENGINE, VALUATION_ENGINE, RENDER_CONTRACT, EXTRACTION_ENGINE, MANIFESTO_CONTRACT. `check:doctrine` and `check:judgment-engine` boot checks remain green post-cutover.

**B4 — One-way data flow.** Render reads resolver; resolver reads bundle; bundle loads from store. Render never calls a producer. Verified by the dependency-cruiser policy in §2.3.

**B5 — Idempotency end-to-end.** Same `ExtractionResult` → same `DoctrineEvaluationId` → same rendered output bytes. Zero non-deterministic inputs (no `Date.now()` in record bodies; only `analysisAsOfDate` which is canonical).

**B6 — Degraded-state invariants flow end-to-end.** Library `n < 20`, missing T-12, missing rent roll surface as `INSUFFICIENT_DATA` reason codes + `dataQualityFlags` + render badges. Legacy silent fallbacks are replaced with explicit indicators (audit gate 6, §6.6).

**B7 — Approved-deals seed replayability.** Re-running `seed:approved-deals` over unchanged source data produces the same `LibrarySnapshotId`.

### 5.3 Parity corpus — `fixtures/stabilized/`

The pre-cutover parity snapshots become permanent regression infrastructure, not throwaway test data.

**Location:** `apps/api/fixtures/stabilized/{fixtureName}/`

**Contents per fixture:**

- input: `extraction-result.json`
- expected records: `adjusted-inputs.json`, `cross-check-result.json`, `stress-outputs.json`, `valuation-conclusion.json`, `doctrine-evaluation.json`, `narrative-facts.json`, `library-snapshot.json`, `asset-profile.json`
- expected render: `rendered-output.json` (cell-by-cell)
- expected interpretive output: `rating-band`, `flags[]`, `reasons[]`, explanation traces (rules fired, adjusters triggered, score adjusters fired)

**CI gate:** `test:parity-corpus` replays each fixture end-to-end and asserts byte-identical output against the expected snapshot. Fixture updates require a documented intentional change with the change log entry naming the rule / version that drove it.

## 6. Pre-Batch-6 audit gates

Six audits required before Batch 6 coding begins. Each produces a written finding in `docs/audits/batch6-audit-{n}.md`. No code lands until all six are signed off and the storage-parallelism decision (§5.1, locked: strict dispatch) is recorded in the cutover migration note.

### 6.1 Audit 1 — Existing resolver UW-logic scrub

Read existing `services/resolve-underwriting-context.ts`. List every conditional and every non-trivial expression. Classify each as:

- **Pure-shape** (keep, document under R1's source map)
- **UW logic** (move to a producer; document where it lands and which reason code it emits)

### 6.2 Audit 2 — Existing render record dependencies

Read `services/render.service.ts`, `services/render-schema.ts`, and `services/render-migrations.ts`. Catalogue every record / field / store the render layer reads. Cross-check against the `HydratedRecordGraph` shape in §2.1. If render reads anything else, decide: (a) expand the bundle, or (b) refactor render to source via resolver. Either way, document.

### 6.3 Audit 3 — Web client field consumption

Audit `apps/web/src/app/analysis/[id]/page.tsx` and `apps/web/src/lib/api-client.ts`. Catalogue every field the client consumes — that is the de facto `UnderwritingContext` shape contract that must hold across cutover.

### 6.4 Audit 4 — Parity-corpus fixture seeding

Select 5–10 representative existing analyses (mix of asset classes, mix of degraded-data conditions, at least one with `n < 20` library data). Snapshot inputs + outputs into `fixtures/stabilized/`. These become the parity-test corpus (§5.3) and the long-term regression suite.

### 6.5 Audit 5 — API route catalogue

Catalogue every API route touching analysis / render. Confirm response shapes. Identify which need versioned endpoints vs which are safe under strict dispatch.

### 6.6 Audit 6 — Implicit fallback inventory

Search the entire codebase (priority order: `render*`, `resolve-*`, `valuation*`, `stress*`, `doctrine*`) for implicit fallbacks that may encode silent UW policy:

- `??` (nullish coalescing)
- `||` (logical OR with default)
- `condition ? a : b` ternaries on numeric values
- `.filter(Boolean)`, `.filter(x => x != null)`
- Default parameter values on functions consuming records
- Empty-array substitutions (`array ?? []`)
- `Math.max(0, ...)` / `Math.min(cap, ...)` and similar guards that hide degraded values

For each occurrence, classify as:

- **safe** — label / formatting / display sentinel; document and move on
- **policy** — silently encodes underwriting decision; must be lifted into a named producer rule with an explicit reason code before Batch 6 code lands

Findings drive Batch 6 cleanups *before* the new resolver lands.

## 7. PR review checklist (merge gate)

Every Batch 6 PR — and every subsequent PR touching hydration / resolver / render — must answer YES to all of these or be rejected:

- [ ] No `if (assetClass === ...)` in `resolve-*.ts`
- [ ] No new numeric `??` / `||` / ternary fallbacks introduced in resolver, render, or producer outputs
- [ ] No `noi ?? 0`, `value ?? 0`, or equivalent null coercions
- [ ] No new imports from `services/extraction/*` outside Stage 1, hydration, and the audit-tab render route
- [ ] No render-layer imports from producers, stores, or calculators
- [ ] Every new `UnderwritingContext` field has a declared source path or `@internal` marker
- [ ] Every new render-schema cell maps to exactly one `UnderwritingContext` field
- [ ] No mutation of persisted records (append-only, content-hash-addressed)
- [ ] `check:doctrine`, `check:judgment-engine` boot checks pass
- [ ] `test:parity-corpus` passes (or fixture updates are documented as intentional in the change log)
- [ ] Module-boundary lint policy passes (`dependency-cruiser` / `eslint no-restricted-imports`)

## 8. Document status

- **Locked:** 2026-05-08 after architecture review.
- **Status:** Foundational architectural doctrine. Long-term PR review criteria.
- **Owner:** Architecture (CRE Credit Committee Platform).

### Decisions recorded in this revision

- Storage strategy: **strict dispatch** (dual-write rejected).
- ExtractionResult isolation enforced via **lint policy + dependency-cruiser**, not grep.
- Resolver "no UW logic" expanded to cover numeric normalization, fallback precedence, null coercion, derived booleans, semantic sorting, implicit aggregation, and implicit recomputation.
- Parity corpus becomes permanent infrastructure: `fixtures/stabilized/`.
- Producer outputs declared **immutable** (append-only, content-hash-addressed).
- Schema exhaustiveness validation added as a render invariant (D3).
- Render boundary tightened: explicit allow-list of permitted imports (D2) + explicit deny-list (D1).
- Sixth audit gate added: implicit fallback inventory (§6.6).
- `DoctrineEvaluationId` is **version-bound**: same inputs + new doctrine version = new id.

### Cross-references

- Existing hard invariants (memory): Architecture Contract, Excel Role, Render Versioning, Render Four-Axis Index, Resolver Scope Guardrail. This document operationalizes those in the Batch 6 cutover.
- Plan: `docs/judgment-engine-plan.md` — for batch sequencing, test totals, and stage-shipping status. This document supersedes its cutover-layer notes.

*Subsequent revisions append below with a dated change log.*

---

## Revision 2 — 2026-05-08 (post-audit decisions locked)

After all six pre-Batch-6 audits completed, the following decisions are recorded and become binding architectural rules. They are added as if appearing inline in the body of this document.

### D1 — Parity corpus gate accepted (Audit 4)

The pre-cutover parity corpus may be empty. Production analyses are sensitive and in legacy shape; synthetic anonymized fixtures will become the permanent corpus instead.

**Binding requirement:** every asset-class wiring PR after Batch 6 MUST land with corresponding stabilized synthetic fixtures under `apps/api/fixtures/stabilized/`. Fixture generation is mandatory for all subsequent doctrine / render / resolver changes. PRs that touch any of these layers without fixture coverage for the asset classes they affect are rejected.

### D2 — Sentinel display lives in render, not resolver (Audit 1(a))

Resolver responsibility:
- preserve null fidelity
- surface `INSUFFICIENT_DATA` reason codes and `dataQualityFlags` unchanged
- never convert semantic state into presentation state

Render responsibility:
- convert degraded state into badges, placeholders, sentinel strings, visual warnings

Strengthens R4 (Null fidelity). The resolver MUST NOT apply `??` for display defaulting. That is render's job.

### D3 — Static enforcement is the end state (Audit 1(b))

The legacy resolver's runtime self-audit (`readFileSync(import.meta.url)` + import-graph check) is a transitional guardrail only. Once ESLint `no-restricted-imports`, `dependency-cruiser` policy, and the negative test (§2.3) are fully load-bearing in CI, the runtime self-audit is removed. End state: **static enforcement only**. Temporary overlap during the migration is acceptable.

### D4 — Edits are revisions, not patches (Audit 5 R9/R10)

`PATCH /uw-model` and `PATCH /loan-terms` semantics violate H7 (append-only, content-hash-addressed). They are replaced by:

```
POST /analyses/:id/revisions
```

Behavior:
- the existing analysis is immutable
- the edit produces a new analysis revision
- the new revision produces new content-hash ids end-to-end (`AdjustedInputsId`, `DoctrineEvaluationId`, etc.)
- the new revision produces new rendered outputs

PATCH semantics are forbidden on any record-bearing endpoint.

### D5 — Canonical identity is content-hash (Audit 5)

Graph-backed analysis ids are content-hash ids. No separate human-readable canonical id is introduced. Human-readable labels may exist as metadata / display aliases only; canonical identity is content-hash. Reasons:
- content-addressability is core to replay determinism
- avoids dual-identity systems
- simplifies dispatch
- simplifies dedupe
- preserves immutable lineage semantics

### D6 — UI credit thresholds lift to doctrine in one PR (Audit 6 + Audit 3)

All hard-coded credit-policy thresholds in the web client lift to doctrine in a single dedicated sub-PR before any new resolver or render code lands. Scope includes:
- DSCR bands
- LTV bands
- debt yield thresholds
- balloon logic
- minimum DSCR rules
- stress bands
- asset-specific credit policy

The doctrine layer is the single authority before resolver/render cutover proceeds. Splitting the lift across multiple PRs creates dual-policy systems, parity ambiguity, inconsistent ratings, and hidden doctrine drift.

### D7 — Legacy adapter isolation (HARD INVARIANT, new)

`apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts` MUST NOT be on the graph-backed ingestion path. Its silent coercions are legacy-compatibility behaviors only:

- `adjusted: 0` defaults on missing line items
- `confidenceReduction: 0` defaults
- rate-type defaults (`'fixed'`)
- IO-month defaults (`0`)
- silent line-item synthesis

Graph-backed ingestion MUST:

- preserve null fidelity
- preserve degraded-state signaling (`dataQualityFlags`, `INSUFFICIENT_DATA` reason codes)
- never synthesize missing economics silently

Strict dispatch (§5.1) isolates the legacy adapter to the legacy code path. The new spine has its own ingestion, free of the adapter's coercions.

**Enforcement:** the dependency-cruiser policy (§2.3) adds `analysis-to-adjusted-inputs.adapter.ts` to the deny-list for any module under the new-spine ingestion path (`services/hydrate-*`, the new resolver, `services/judgment/*`, `services/doctrine/*`, `services/valuation.service`, `services/stress-test.service`, etc.). A negative test verifies the rule.

### Implementation sequencing

The remediation + implementation sequence operationalizing these decisions lives in `docs/batch6-implementation-plan.md`. That document is the source of truth for sub-batch ordering, definitions of done, and per-sub-batch sign-off gates.

*Revision 2 locked 2026-05-08. Subsequent revisions append below with a dated change log.*
