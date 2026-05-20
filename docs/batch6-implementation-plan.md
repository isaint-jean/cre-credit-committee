# Batch 6 Implementation Plan — Sequenced Remediation + Cutover

> **Status:** Locked 2026-05-08 after pre-Batch-6 audits + decisions.
> **Source decisions:** `docs/architecture/batch6-record-graph-and-resolution.md` (revision 2, §D1–D7)
> **Source audits:** `docs/audits/batch6-audit-{1..6}.md`
> **Effort:** ~5–7S total (was originally estimated ~5S; expanded to cover audit-surfaced remediations)
> **Sequencing rule:** Sub-batches MUST land in numeric order. Each requires user sign-off on the DoD before the next one begins.

## Decisions recap (locked, see architecture doc revision 2)

- **D1** Parity corpus gate accepted; synthetic fixtures mandatory for every post-Batch-6 wiring PR.
- **D2** Sentinel display lives in render, not resolver.
- **D3** Static enforcement is end state; runtime self-audit retired once lint+CI is load-bearing.
- **D4** Edits become revisions (`POST /analyses/:id/revisions`); PATCH semantics forbidden on record-bearing endpoints.
- **D5** Canonical identity is content-hash; no separate human-readable canonical id.
- **D6** UI credit thresholds lift to doctrine in one dedicated PR before resolver/render cutover.
- **D7** Legacy adapter (`analysis-to-adjusted-inputs.adapter.ts`) stays in the legacy path only; the new spine ingestion bypasses it entirely.

## Sub-batch sequence

The 9 sub-batches form three phases:

- **Phase A — Pre-spine remediation** (6.0 → 6.2): scaffolding + lift silent UW policy out of UI and shared producer code. Must land before any new spine code.
- **Phase B — Spine cutover** (6.3 → 6.7): revision endpoints, ingestion, hydration, resolver, render. Where the new pipeline replaces the legacy one.
- **Phase C — End-state cleanup** (6.8 → 6.9): retire transitional guardrails; seed synthetic corpus.

---

### Phase A — Pre-spine remediation

#### 6.0 — Static enforcement scaffolding *(~1S, foundational)*

**Trigger:** Decisions accepted (now).

**Scope:**
- Add ESLint `no-restricted-imports` rule covering doctrine §2.3 + §4.1 + D7:
  - `ExtractionResult` import deny-list (doctrine, valuation, stress, judgment, cross-check, resolver, render-internal)
  - Render allow-list (`UnderwritingContext`, `services/render-schema`, formatting utilities, `@cre/contracts` types only)
  - `analysis-to-adjusted-inputs.adapter.ts` deny-list for new-spine modules (D7)
- Add `dependency-cruiser` policy config + `npm run lint:boundaries` script
- Add negative test `apps/api/src/scripts/test-extraction-isolation.ts` — attempts each forbidden import in a sandbox file; asserts the lint rule errors
- Wire `lint:boundaries` + `test:extraction-isolation` into the test suite list and CI

**Files touched:** `.eslintrc.*` (or `eslint.config.*`), `.dependency-cruiser.cjs`, `apps/api/src/scripts/test-extraction-isolation.ts`, `apps/api/package.json`.

**No business code changes.**

**DoD:**
- `npm run lint:boundaries` passes on current code
- Deliberately introducing each forbidden import causes the lint rule to fail
- `npm run test:extraction-isolation` passes
- All scripts wired into CI

**Why first:** every subsequent sub-batch relies on this enforcement to detect regressions. Landing this before the rest of Batch 6 means every later PR is auto-gated.

---

#### 6.1 — UI credit-threshold lift to doctrine *(~1S, decision D6)*

**Trigger:** 6.0 merged.

**Scope:**
- Inventory from Audit 3: every hard-coded credit threshold in `apps/web/` (DSCR 1.25/1.50, LTV 0.65/0.75, DY 0.08/0.10, Balloon 0.7/0.9, Min-DSCR 1.15/1.25, stress bands, asset-specific policy).
- For each: identify or create the doctrine component scorer / asset-type adjuster that owns it. Most map to existing 5a/5b rules; any that don't get new rules with explicit reason codes.
- Update doctrine outputs to expose: rating-band, per-metric band classification, flags. Web consumes these instead of computing.
- Remove all numeric thresholds from `apps/web/src/app/analysis/[id]/page.tsx` and consumers.
- Add a regression test (`test:no-ui-thresholds`) that greps `apps/web/src/` for numeric literals matching credit-threshold patterns and fails on hits outside an explicit allow-list (e.g., chart axis bounds).

**Files touched:** doctrine adjusters/scorers (additions, no breaking changes), `apps/web/src/app/analysis/[id]/page.tsx`, consumed sub-components, possibly `packages/shared/src/types/analysis.ts` to add new server-side classification fields.

**DoD:**
- All Audit-3-listed thresholds removed from web
- Doctrine outputs the band classifications the UI now reads
- Web client renders identical output for representative inputs (manual smoke; no parity corpus exists yet)
- `test:no-ui-thresholds` passes
- `npm run lint:boundaries` passes
- Existing 24 test suites + 2 boot checks pass

**Why before resolver:** if UI keeps computing thresholds, both the legacy and new spines must agree with UI math. Lifting first means doctrine is the single authority.

---

#### 6.2 — Audit 6 shared-producer fallback remediation *(~1S, decision D7 + Audit 6)*

**Trigger:** 6.1 merged.

**Scope:** remediate the 18 unsafe / policy fallbacks Audit 6 flagged in **shared producer code** (code that the new spine will use). The legacy adapter (U1–U3, U16) is explicitly left alone — D7 isolates it to the legacy path.

Items to fix (from Audit 6):
- **Cross-check (U4–U6, U17):** null variances must produce `INSUFFICIENT_DATA`, not silently classify as `'minor'`/`'NEUTRAL'`. Stop zero-weighting nulls in bias scoring.
- **Stress contracts (U13, U14):** align `stress-test-contracts.service.ts` with the strict SKIP discipline of `stress-test.service.ts`. Missing interest rate is `skipped: ['DSCR']`, not "no stress." Missing tenant ranks is SKIP, not zero.
- **Rent-roll (U7, U18):** `?? 0` on per-unit values silently understates concentration. Either preserve null and emit `INSUFFICIENT_DATA`, or fail loudly.
- **MANUAL defaults (U9):** hardcoded `otherIncome=0`, growth rates 3%, monthly capex 20bps emit no rule code. Each becomes a named judgment-engine rule with explicit reason code (`JE_OTHER_INCOME_DEFAULTED`, etc.) so doctrine can score the substitution.
- **Library-vs-benchmark (U10, U11):** distinguish library substitution (`n≥20`) from benchmark substitution (`n<20`) via separate rule ids preserving degraded-source provenance.
- **Conservatism gate (U12, NR4):** silent skip when floor data missing → emit `JE_FLOOR_DATA_MISSING` reason and route through `INSUFFICIENT_DATA`, never silently bypass.
- **Applicability (U15):** `false` on missing rent roll currently silently downgrades TI/LC reserves to NOT-APPLICABLE. Distinguish "not applicable to this asset class" (true negative) from "data missing for this metric" (`INSUFFICIENT_DATA`). This is Audit 6's most credit-impactful finding.

**Files touched:** `services/cross-check.service.ts`, `services/stress-test-contracts.service.ts` (or merge with `services/stress-test.service.ts`), `services/judgment/applicability.ts`, `services/judgment/library-lookup.ts`, `services/judgment/source-cascade.ts`, `services/judgment/verify-conservatism.ts`, possibly new judgment-engine rule ids in `packages/contracts/src/judgment-engine-rules.ts`.

**DoD:**
- Each U-item from Audit 6 either fixed or explicitly marked `accepted` in a per-item line in this plan with rationale
- New judgment-engine rule ids added to the registry; rule-count tests updated
- All existing test suites pass
- `npm run lint:boundaries` passes
- Audit 6 report annotated post-hoc with per-item resolution status

**Why before new spine:** the new ingestion path (6.4) and new resolver (6.6) consume these producers. Fixing silent policy here prevents it from leaking into the new spine via shared code.

---

### Phase B — Spine cutover

#### 6.3 — Revision-creating endpoint *(~1S, decision D4)*

**Trigger:** 6.2 merged.

**Scope:**
- New endpoint: `POST /analyses/:id/revisions`. Accepts edited `uwModel` / `loanTerms` payload. Produces a new analysis with new content-hash ids end-to-end. Does NOT mutate the existing row.
- Web client UI flow: edits show "this will create a new revision" UX. Revision history surfaced (list of prior `DoctrineEvaluationId`s for the analysis lineage).
- Deprecate `PATCH /analyses/:id/uw-model` and `PATCH /analyses/:id/loan-terms` (Audit 5 R9, R10). Behavior options:
  - Option A: hard-remove the routes (web client must update simultaneously)
  - Option B: legacy-only mode-flag — accepts in legacy code path, errors in new spine
- Lineage tracking: `Analysis` has a `lineageRootId` so revisions can be grouped in UI.

**Files touched:** `apps/api/src/routes/analysis.routes.ts`, store (legacy + new), web client edit flow.

**DoD:**
- `POST /analyses/:id/revisions` works end-to-end (legacy path, since new spine doesn't ingest yet)
- PATCH endpoints removed or legacy-only-flagged
- Web client uses revision-creating flow
- Revision lineage visible in analysis list/history UI
- All tests pass

**Open decision before code:** Option A vs Option B for legacy PATCH endpoints. Recommend **Option A** (hard-remove + simultaneous web update) for cleanliness; **Option B** if web cutover is desynced.

---

#### 6.4 — New-spine ingestion path *(~1S, decision D5 + D7)*

**Trigger:** 6.3 merged.

**Scope:**
- Build `services/ingest-extraction-result.ts` (or similar) — the entry point for graph-backed analyses.
- Pipeline: `ExtractionResult → AssetProfile → LibrarySnapshot pin → JudgmentEngine.applyJudgmentAdjustments → AdjustedInputs → CrossCheck → Stress → Valuation → Doctrine`. All Stage 1–10 producers already exist; this just wires them.
- Persists every record to `record-graph-store` with content-hash ids.
- **MUST NOT call `analysis-to-adjusted-inputs.adapter.ts` (D7).** The dependency-cruiser policy added in 6.0 enforces this.
- Strict null fidelity throughout. Missing data → `INSUFFICIENT_DATA` + `dataQualityFlags`, never `?? 0`.
- New API entry point: `POST /analyses` (graph-backed) writes via this ingestion path.

**Files touched:** new `services/ingest-extraction-result.ts`, `apps/api/src/routes/analysis.routes.ts` (add graph-backed POST handler), record-graph-store wiring.

**DoD:**
- A `POST /analyses` to the graph-backed handler with a synthetic `ExtractionResult` produces all 9 records in `record-graph-store`
- Same input → same `DoctrineEvaluationId` (idempotency invariant H4)
- `npm run lint:boundaries` passes (verifies adapter is not imported)
- Integration test `test:ingest-pipeline` covers happy path + 2 degraded-data cases
- All existing tests pass

---

#### 6.5 — Hydration service *(~0.5S)*

**Trigger:** 6.4 merged.

**Scope:** implement `services/hydrate-underwriting-context.ts` per architecture §2.

- Input: `DoctrineEvaluationId` (root)
- Output: `HydratedRecordGraph` (typed bundle of 9 records)
- Total FK closure; throws on dangling FK
- Pure read; no computation, no branching
- Includes `ExtractionResult` for narrative/audit display only (D7 isolation already enforced by 6.0 lint policy)

**Files touched:** `services/hydrate-underwriting-context.ts`, contracts package may need `HydratedRecordGraph` type added.

**DoD:**
- Given a root id, returns the bundle
- Dangling FK throws (test covers)
- Same root id → byte-identical bundle (test covers)
- Test suite for hydration ≥10 tests
- `npm run lint:boundaries` passes

---

#### 6.6 — New resolver *(~1S, decisions D2 + Audit 1 unclear-block fix)*

**Trigger:** 6.5 merged.

**Scope:** replace `services/resolve-underwriting-context.ts` with a strict pick/rename projection.

- Input: `(bundle: HydratedRecordGraph, mode: UnderwritingMode)`
- Output: `UnderwritingContext`
- Strict total source map — every context field has exactly one declared source path
- No `??`, no `||`, no ternaries on numeric values, no asset-class branching (R3 expanded)
- **Always emits the optional atomic blocks** (`property`, `loan`, `parties`, `comparablesLinkageRefs`) — fixes Audit 1's UNCLEAR findings F13–F16
- **No sentinel application** (D2: render owns sentinels)
- Schema exhaustiveness check (D3): every field in the new `UnderwritingContext` is either rendered or marked `@internal` / `@audit-only`
- Mode is a view selector only (R2)

**Files touched:** `services/resolve-underwriting-context.ts` (replaced), `packages/shared/src/types/underwriting-context.ts` (likely tightened — required atomic blocks).

**DoD:**
- New resolver compiles + passes a comprehensive test suite (≥30 tests covering: total source map, mode projection, null fidelity, no-sentinel, idempotency)
- Schema exhaustiveness check passes
- Audit 1 UNCLEAR findings F13–F16 resolved (no `?? null` / `?? []` patterns remain)
- Legacy resolver runtime self-audit still in place (retired in 6.8)
- `npm run lint:boundaries` passes

---

#### 6.7 — Render layer cutover *(~1S, decisions D2 + D3 schema exhaustiveness + Audit 2 violations)*

**Trigger:** 6.6 merged.

**Scope:** remediate Audit 2's 10 violations and 4 side channels; introduce sentinel display.

- **V1** (`render.service.ts` imports resolver) — render now consumes `UnderwritingContext` provided by route handler, never calls resolver itself
- **V2** (`render-schema.ts` dynamic require) — replaced with static import
- **V3** (`render-schema.ts` in-selector unit math) — moved to producer or removed
- **V4** (`template-engine.service.ts` legacy heuristic mapping) — removed or moved
- **V5–V8, V10** (`render.routes.ts` forbidden imports — store, resolver, adapter, hydration, observability, readiness) — route handler now: receive request → load via hydration (allowed in route handler, not in render service) → resolve → render. Render itself touches none of these.
- **V9** (observability import) — observability hooks moved to a route-level wrapper, not render layer
- **S1** (clock read at render time) — removed; rendered output is purely deterministic from inputs (preserves H4/B5 idempotency)
- **S2, S3** (stdout, boot-time hash) — confirmed safe, documented
- **S4** (resolver self-introspection) — addressed in 6.8

- **Sentinel display added** (D2): render layer maps `INSUFFICIENT_DATA` reason codes + `dataQualityFlags` + null values to display sentinels (`"—"`, `"N/A"`, badges, warnings)
- **Schema exhaustiveness** (D3): boot-time check enumerates `UnderwritingContext` fields, intersects with schema usage, fails on unaccounted fields

**Files touched:** `services/render.service.ts`, `services/render-schema.ts`, `services/render-migrations.ts`, `services/template-engine.service.ts`, `services/render-output-scrubber.ts`, `apps/api/src/routes/render.routes.ts`.

**DoD:**
- All 10 Audit 2 violations resolved (closed in audit report annotations)
- Clock-read removed; same inputs → byte-identical render output (test covers)
- Sentinel display works end-to-end for `INSUFFICIENT_DATA`, null metrics, `dataQualityFlags`
- Schema exhaustiveness check passes; deliberately introducing an unaccounted field fails the check
- `npm run lint:boundaries` passes — render imports nothing computational
- All existing tests pass

---

### Phase C — End-state cleanup

#### 6.8 — Strict-dispatch routing + retire runtime self-audit *(~0.5S, decisions D3 + D5 + Audit 5)*

**Trigger:** 6.7 merged.

**Scope:**
- **Strict dispatch (D5):** at every analysis-bearing route handler, dispatch by id format. UUID v4 → legacy code path; content-hash → new spine. Centralized helper `dispatchByIdFormat(id)` returns the path discriminator.
- All 15 STRICT_DISPATCH_REQUIRED routes from Audit 5 wired up.
- Audit 5 ADDITIVE_SAFE routes (6) verified — same shape both pipelines.
- Audit 5 OUT_OF_SCOPE routes (54: auth, criteria, research, etc.) untouched.
- **Retire runtime self-audit (D3):** remove `readFileSync(import.meta.url)` import-graph check from the new resolver. Verify lint+CI is fully load-bearing first (run a deliberate-violation test).
- Resolve Audit 2 S4 (resolver self-introspection becoming a transitive boot dependency of render) — gone with the self-audit.

**Files touched:** every analysis/render-touching route handler in `apps/api/src/routes/`, the new resolver (remove self-audit), helpers.

**DoD:**
- Dispatch test: legacy-id requests hit legacy code path; content-hash requests hit new spine; verified end-to-end for all 15 routes
- Runtime self-audit removed
- Deliberate forbidden-import → CI red (proves lint is load-bearing)
- All tests pass

---

#### 6.9 — Synthetic fixture corpus seeding *(~0.5S, decision D1)*

**Trigger:** 6.8 merged.

**Scope:**
- Build `services/synthetic-extraction-generator.ts` — produces realistic `ExtractionResult` for a given asset class + scenario class (standard, missing-T-12, library-degraded, etc.).
- Generator is deterministic given a seed; same seed → same fixture.
- Run pipeline end-to-end; snapshot all 9 records + render output to `apps/api/fixtures/stabilized/{name}/` per architecture §5.3.
- Seed at least one fixture per asset class (Multifamily, Office, Retail, Hospitality, Industrial, SelfStorage, MHC, MixedUse) + 1–2 degraded-data scenarios. Total 9–10 fixtures.
- Add `npm run test:parity-corpus` — replays each fixture; asserts byte-identical output.
- Wire into CI.

**Files touched:** `services/synthetic-extraction-generator.ts`, `apps/api/src/scripts/seed-stabilized-fixtures.ts`, `apps/api/src/scripts/test-parity-corpus.ts`, `apps/api/fixtures/stabilized/{name}/*`.

**DoD:**
- 9–10 fixtures seeded and passing
- `test:parity-corpus` runs in CI
- Generator is deterministic (test covers)
- Per D1 binding requirement: from this point on, every PR touching doctrine / resolver / render / a producer for asset class X must update the X fixture (or document why no fixture-affecting change occurred). PR template updated.

**Why last:** the generator depends on the new ingestion path (6.4), hydration (6.5), resolver (6.6), and render (6.7). Seeding before they're done means re-snapshotting later; seeding after is one-and-done.

---

## Sub-batch sign-off matrix

| Sub-batch | Trigger | Effort | Audit/Decision sources |
|---|---|---|---|
| 6.0 | now | ~1S | architecture §2.3, §4.1, D7 |
| 6.1 | 6.0 merged | ~1S | D6, Audit 3, Audit 6 |
| 6.2 | 6.1 merged | ~1S | D7, Audit 6 (excluding U1–U3, U16) |
| 6.3 | 6.2 merged | ~1S | D4, Audit 5 R9/R10 |
| 6.4 | 6.3 merged | ~1S | D5, D7, architecture §2 |
| 6.5 | 6.4 merged | ~0.5S | architecture §2 |
| 6.6 | 6.5 merged | ~1S | D2, Audit 1 (UNCLEAR), §3 |
| 6.7 | 6.6 merged | ~1S | D2, D3, Audit 2, §4 |
| 6.8 | 6.7 merged | ~0.5S | D3, D5, Audit 5 |
| 6.9 | 6.8 merged | ~0.5S | D1 binding requirement |

**Total: ~7.5S** across 9 sub-batches.

## Cross-cutting acceptance criteria

These apply to every sub-batch:

- All existing tests continue to pass (no regressions).
- `npm run lint:boundaries` passes after 6.0 lands.
- New code adheres to architecture §7 PR review checklist.
- Audit findings referenced in scope are annotated with resolution status in the audit report.
- Memory + plan references stay current (`pipeline_rollout_plan.md`, `MEMORY.md`).

## Deferred items (out of Batch 6 scope)

- Manifesto rules graduating from observational to score-mutating (v1.1).
- Stress engine extensions for `TENANT_REMOVAL` and `OCC_RENT_CONCESSION` methods (v1.1).
- Markets benchmarks producer (Stage 2 sibling to LibrarySnapshot — already typed in contracts).
- Excel render export migration (currently legacy-only path).

These land in v1.1 / Batch 7+, not Batch 6.

---

*Locked 2026-05-08. Subsequent revisions append a dated change log to this section.*
