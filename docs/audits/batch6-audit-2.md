# Batch 6 Audit 2 — Render Side-Channel Inventory

**Date:** 2026-05-08
**Target:** `apps/api/src/services/render*`, `apps/api/src/services/template-engine.service.ts`, `apps/api/src/services/template-registry.ts`, `apps/api/src/routes/render.routes.ts`
**Goal:** Catalogue every import, runtime call, and side-channel data fetch performed by the render layer. Cross-check each read against the planned `HydratedRecordGraph` shape (doctrine §2.1) and the permitted-import allow-list (doctrine §4 D2). Surface every D1/D2 violation; recommend bundle expansion / context expansion / dependency removal per finding. No code modifications.
**Doctrine reference:** `docs/architecture/batch6-record-graph-and-resolution.md` §4 (D1, D2, D3).

---

## Dependency graph

Each module's imports are grouped by the doctrine taxonomy. The classification reflects the **resolved import path's runtime behavior**, not just the surface name.

### `apps/api/src/services/render.service.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| contracts/types (allowed)               | `type { CellBindings, RenderInput, RenderPayload, ResolvedUnderwritingContext } from '@cre/shared'` |
| contracts/values (allowed)              | `RENDER_CONTRACT_VERSION from '@cre/shared'`                                            |
| render-internal (allowed)               | `./render-schema.js` (assertProjectionMatchesSchema, assertStructuralIdentity, buildTables, getAssetClassVariantModeTabs, getManagedNamespace, getSchemaAddresses, getStructuralIdentity, getVisibleTabs, projectCellBindings, RenderSchemaError, ProjectionInput) |
| render-internal (allowed)               | `./render-output-scrubber.js` (assertNoProvenanceLeak)                                  |
| **producer (FORBIDDEN under D1)**       | **`./resolve-underwriting-context.js` (assertResolvedByResolver, resolveUnderwritingContext)** — see V1 |
| FORBIDDEN stores                        | none                                                                                    |
| FORBIDDEN calculators                   | none                                                                                    |

Runtime data accesses: pure projection over `RenderInput`. No file reads, no env reads, no clock reads. Calls `new Date()` are absent (timestamps come from `input.meta.generatedAt`).

### `apps/api/src/services/render-schema.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| node builtin (allowed)                  | `createHash from 'node:crypto'` (used for canonical structural fingerprint hashing — schema-internal, not record-graph hashing) |
| contracts/types (allowed)               | `type { AdjustedInputs, AdjustedLineItem, AssetType, CellBindings, CellValue, ManagedNamespacePolicy, RenderInput, RenderPayload, ResolvedUnderwritingContext, StructuralIdentity, StructuralVariantKey, TableLayout, TablePayload, UnderwritingMode } from '@cre/shared'` |
| contracts/values (allowed)              | `RENDER_CONTRACT_VERSION from '@cre/shared'`                                            |
| **render-internal but cycles into a runtime** | **`require('./field-migration-state.js')` at boot inside `assertFieldStatesConsistentWithSchema`** — see V2. (`field-migration-state` itself only imports a *type* from `@cre/shared` plus a *type* from this module; the cycle is type-only at the static-import level but the runtime dynamic require introduces a side dependency.) |
| FORBIDDEN producers                     | none                                                                                    |
| FORBIDDEN stores                        | none                                                                                    |
| FORBIDDEN calculators                   | none                                                                                    |

Runtime data accesses: at module boot, walks every `(contractVersion × assetClass × variantKey × mode)` to compute canonical structural fingerprints (`createHash('sha256').update(stableStringify(...))`). All inputs are static module-level data — no I/O, no env, no clock. Per-render: `projectCellBindings` reads only `ProjectionInput` (= `RenderInput` + `resolvedContext`).

Numeric transforms in selectors (`Math.round(m / 12)` for amortization-months → years at lines 295, 308): not "calculation" in the sense of D1 (no producer math), but these *are* unit conversions performed inside render. See V3 (advisory).

### `apps/api/src/services/render-migrations.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| contracts/values (allowed)              | `RENDER_CONTRACT_VERSION from '@cre/shared'`                                            |
| contracts/types (allowed)               | `type { MigrationManifest, RenderContractMigration } from '@cre/shared'`                |
| render-internal (allowed)               | `./render-schema.js` (RenderSchemaError)                                                |

Runtime data accesses: none beyond the static MIGRATIONS array. Boot-time chain validation; pure functions. **CLEAN under D1/D2.**

### `apps/api/src/services/render-output-scrubber.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| render-internal (allowed)               | `./render-schema.js` (RenderSchemaError)                                                |
| contracts/types (allowed)               | `type { CellBindings, CellValue } from '@cre/shared'`                                   |

Runtime data accesses: regex matching over CellBindings string values. **CLEAN under D1/D2.**

### `apps/api/src/services/template-engine.service.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| third-party runtime (advisory)          | `import ExcelJS from 'exceljs'` — Excel I/O is the engine's mandate, not a violation    |
| third-party runtime (advisory)          | `(await import('jszip')).default` — dynamic; for post-write zip-level provenance scrubbing |
| contracts/types (allowed)               | `type { CellValue, RenderPayload, TablePayload, TemplateMetadata, UnderwritingModel } from '@cre/shared'` |
| render-internal (allowed)               | `./render-output-scrubber.js` (matchProvenancePattern)                                  |

Side-channel: `UnderwritingModel` is the legacy adjusted-inputs-shaped model used by `populateTemplate` / `populateRollUpTemplate` (the *legacy* heuristic-mapping path at lines 247–337 / 441–533). Those code paths perform regex-pattern label scanning over a workbook to find target cells — an alternative population path that pre-dates the schema-addressed canonical path (`applyRenderPayloadToTemplate`). The legacy path doesn't import producers/stores at the module level, but it is render-layer code performing field-by-field number placement based on its own `FIELD_PATTERNS` regex registry — see V4 (advisory; pre-existing legacy surface).

Runtime data accesses: reads/writes Excel buffers (intentional). No filesystem direct reads. No env reads. No clock reads.

### `apps/api/src/services/template-registry.ts`

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| contracts/types (allowed)               | `type { AssetType, StructuralVariantKey, TemplateMetadata, TemplateType, UnderwritingMode } from '@cre/shared'` |
| contracts/values (allowed)              | `RENDER_CONTRACT_VERSION from '@cre/shared'`                                            |
| render-internal (allowed)               | `./render-schema.js` (getAssetClassesForContractVersion, getModesForVariant, getRegisteredContractVersions, getVariantsForAssetClass, RenderSchemaError) |

Runtime data accesses: static REGISTRY + boot-time coverage validation against schema slices. **CLEAN under D1/D2.**

### `apps/api/src/routes/render.routes.ts`

This is the route handler — by doctrine, the route is the composition seam where `Analysis` (legacy) is allowed to meet `RenderInput`. Even so, the route is in scope for D1 because `apps/web` and Express handlers are explicitly listed under the render layer ("`services/render-*`, `routes/render`, `apps/web` analysis page").

| Category                                | Import                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| third-party runtime                     | `Router, Request, Response from 'express'`                                              |
| **FORBIDDEN store (D1)**                | **`store from '../storage/sqlite-store.js'`** — see V5                                  |
| render-internal (allowed)               | `../services/render.service.js` (buildRenderPayload, getAssetClassVariantModeTabs, getManagedNamespace, RenderSchemaError) |
| render-internal (allowed)               | `../services/render-schema.js` (getModesForVariant, getSchemaAddresses, getSchemaSourcesByAddress, getVariantsForAssetClass) |
| **producer (FORBIDDEN under D1)**       | **`../services/resolve-structural-variant.js` (assertUnderwritingModeRegistered, assertVariantRegistered, resolveStructuralVariant)** — see V6 |
| render-internal (allowed)               | `../services/render-migrations.js` (getAllMigrations, getMigrationManifest)             |
| **producer (FORBIDDEN under D1)**       | **`../services/analysis-to-adjusted-inputs.adapter.js` (adaptAnalysisToAdjustedInputs)** — see V7 |
| **producer (FORBIDDEN under D1)**       | **`../services/hydrate-underwriting-context.js` (hydrateUnderwritingContext)** — see V8 |
| **producer-adjacent (D1)**              | **`../services/underwriting-observability.service.js` (buildObservabilityEvent, emitObservabilityEvent, persistObservabilityEvent)** — see V9 |
| **producer-adjacent + store (D1)**      | **`../services/migration-readiness.service.js` (computeReadiness, readObservabilityWindow)** — see V10 |
| render-internal (allowed)               | `../services/template-engine.service.js` (applyRenderPayloadToTemplate, assertTemplateCanSatisfySchema, TemplateIntegrityError, validateTemplateCompatibility) |
| contracts/values (allowed)              | `RENDER_CONTRACT_VERSION from '@cre/shared'`                                            |
| contracts/types (allowed)               | `type { Analysis, AssetType, MigrationManifest, RenderConservatismStatus, RenderInput, RenderLibraryBaselineMeta, RenderPayload, StructuralVariantKey, TemplateType, UnderwritingMode } from '@cre/shared'` |

Runtime data accesses (route handlers):

- `store.getAnalysis(dealId)` — store read (V5)
- `store.getActiveTemplate(templateType)` — store read (V5)
- `store.rawDb()` — raw better-sqlite3 handle handed to observability + readiness (V5, V9, V10)
- `new Date().toISOString()` (line 290) — clock read for `meta.generatedAt`. **Side channel** (S1).
- `process.stdout.write(JSON.stringify(...))` for export-time observability (line 520) — log emission, not a read; side-channel S2 (write only).

---

## Permitted-import baseline (passing)

The following imports are **fully D1/D2 compliant** as written:

- All `@cre/shared` type imports throughout every module — pure types, no runtime functions carrying policy.
- `RENDER_CONTRACT_VERSION` constant (`@cre/shared`) — a primitive value, not a runtime function.
- `node:crypto.createHash` in `render-schema.ts` — node builtin, used only for content-hashing static schema definitions at boot. Not a "calculator" in the doctrine sense (no domain math).
- `render-schema.ts` ↔ `render-output-scrubber.ts` ↔ `render-migrations.ts` ↔ `template-registry.ts` mutual references — all render-internal.
- `template-engine.service.ts` → `render-output-scrubber.ts` (`matchProvenancePattern`) — render-internal pattern reuse.
- `exceljs` and `jszip` in `template-engine.service.ts` — third-party serializers required for the Excel renderer's mandate.
- `express` types/symbols in `routes/render.routes.ts` — HTTP framework.

`render-migrations.ts`, `render-output-scrubber.ts`, and `template-registry.ts` are clean under D1/D2 with **no violations**.

---

## Violations

### V1 — `render.service.ts` imports a runtime *function* from `resolve-underwriting-context`

- **Importing module:** `apps/api/src/services/render.service.ts`
- **Imported module:** `apps/api/src/services/resolve-underwriting-context.ts`
- **Import statement:**
  ```ts
  import {
    assertResolvedByResolver,
    resolveUnderwritingContext,
  } from './resolve-underwriting-context.js';
  ```
- **Why it's a violation:** Under the new doctrine (§3.1), the resolver becomes a *Stage 12* function with the signature `resolve(bundle: HydratedRecordGraph, mode): UnderwritingContext`. Render's permitted dependencies are explicitly enumerated in D2: `UnderwritingContext` (resolver *output*), `render-schema`, `render-output-scrubber`, and `@cre/contracts` types. The resolver function itself is **not** on that list — render must consume the *output*, not the function. Today render co-resolves: it accepts a half-resolved `UnderwritingContext` from the route, then internally calls `resolveUnderwritingContext()` to project it to `ResolvedUnderwritingContext`. Under §3 R5 the resolver is a pure function from bundle to context, and `ResolvedUnderwritingContext` collapses into `UnderwritingContext` (the resolver's output) per §3.2 R2 — there is no second resolution step inside render. Note also that the imported module performs a `readFileSync(import.meta.url)` self-introspection at boot (line 229) — once it lives upstream of render, render will not transitively trigger that I/O.
- **Runtime usage:** `render.service.ts:111` `const resolvedContext = resolveUnderwritingContext(input.underwritingContext, underwritingMode);` and `render.service.ts:115` `assertResolvedByResolver(resolvedContext);`. The result is passed into `projectCellBindings()` as `projectionInput.resolvedContext`.
- **Recommendation:** **expand context** + **remove dependency**.
- **Rationale:** Fold the current `ResolvedUnderwritingContext` projection into Stage 12. The resolver in §3.1 already produces the post-projection shape; render reads it verbatim and never re-resolves. Delete the `resolveUnderwritingContext` and `assertResolvedByResolver` imports from `render.service.ts`. The identity-brand check (`assertResolvedByResolver`) becomes the type guarantee provided by the resolver's branded return type.

---

### V2 — `render-schema.ts` runtime-`require`s `field-migration-state` at boot

- **Importing module:** `apps/api/src/services/render-schema.ts`
- **Imported module:** `apps/api/src/services/field-migration-state.ts`
- **Import statement (line 890):**
  ```ts
  const {
    REQUIRED_SOURCE_BY_STATE,
    getFieldStateRegistryForVersion,
    getFieldState,
    isLegalTransition,
  } = require('./field-migration-state.js') as typeof import('./field-migration-state.js');
  ```
- **Why it's a violation:** Soft. `field-migration-state` is a static governance registry, not a producer / store / calculator. But the *mechanism* (CommonJS `require()` at runtime inside an ESM module that elsewhere uses static `import` exclusively) is anomalous and bypasses the static module-boundary lint policy that §2.3 requires for ExtractionResult isolation. A future `dependency-cruiser` pass over `services/render-*` may not catch dynamic requires.
- **Runtime usage:** `assertFieldStatesConsistentWithSchema()` invoked from `assertSchemaWellFormed()` at module boot (line 874). Cross-checks every schema cell against the field-state registry; throws on inconsistency.
- **Recommendation:** **remove dependency** (cosmetic refactor).
- **Rationale:** Convert to a static `import { ... } from './field-migration-state.js'` at the top of the file. The author's stated reason for the dynamic require is "to avoid circular deps at module-init time" (line 882), but `field-migration-state.ts` only imports `type SourceSurface` from `render-schema.ts` — that's a TypeScript type-only import, erased at runtime. There is no actual runtime cycle. Static import is safe and lets `dependency-cruiser` see the edge.

---

### V3 — `render-schema.ts` selector helpers perform unit math (`Math.round(m / 12)`)

- **Importing module:** `apps/api/src/services/render-schema.ts`
- **Imported module:** none (in-module helpers `amortizationYears` line 293, `ctxLoanMonthsToYears` line 304)
- **Import statement:** N/A — internal selector arithmetic.
- **Why it's a violation:** Under D1, render "MUST NOT import calculators" and "anything performing math". Months → years is unit conversion, not credit math, but it is **arithmetic on the value of a render cell** performed at the render boundary. Per the doctrine §4 spirit and §3.2 R3 ("Implicit recomputation: recomputing NOI / DSCR / value rather than reading `metrics.*`" is forbidden in the resolver), unit-coded numbers should arrive at render in their final display unit. The schema layer is supposed to be a pure projection.
- **Runtime usage:**
  - `render-schema.ts:295` `return typeof m === 'number' && m > 0 ? Math.round(m / 12) : null;` for `Amortization_Term`.
  - `render-schema.ts:308` `return typeof v === 'number' && v > 0 ? Math.round(v / 12) : v;` for `Balloon_Term` and `Amortization_Term` v7 selectors.
- **Recommendation:** **expand context** (move unit conversion upstream into the resolver / `UnderwritingContext`).
- **Rationale:** Have the resolver expose `loan.amortizationYears` and `loan.termYears` as projected fields on `UnderwritingContext` (or pre-projected on `AdjustedInputs.loan` for v6 carry-over). Render becomes a pure passthrough. This is also a soft §3.2 R3 risk: the conditional `m > 0 ? ... : null` is a numeric ternary that hides degraded values — the doctrine's smell test calls these out (§3.3 bullet 2). Lifting the conversion upstream brings the ternary with it, where R8 ("failure surfacing, not failure repair") governs.

---

### V4 — `template-engine.service.ts` legacy `populateTemplate` / `populateRollUpTemplate` perform heuristic field-to-cell mapping over `UnderwritingModel`

- **Importing module:** `apps/api/src/services/template-engine.service.ts`
- **Imported module:** `@cre/shared` (type `UnderwritingModel`); the violation is in *behavior*, not in an import edge.
- **Import statement:** `import type { ... UnderwritingModel ... } from '@cre/shared';`
- **Why it's a violation:** Under D2 the render layer reads `UnderwritingContext` (resolver output) — not `UnderwritingModel`, which is the legacy, pre-spine numeric model. The functions `populateTemplate` (line 288), `populateRollUpTemplate` (line 441), and `buildValueMap` (line 247) implement an **alternative render path** that bypasses `RenderPayload`, `cellBindings`, schema addresses, and `applyRenderPayloadToTemplate`. They scan worksheet labels with regexes (`FIELD_PATTERNS`, line 159) and write values into cells based on label-text matches — this is render-side schema *inference*, exactly the kind of side-channel the four-axis schema is supposed to replace.
  Additionally, `populateRollUpTemplate` accepts a pre-summed `portfolioTotals` parameter and writes those numbers into "summary/debt" tabs by category — that's not arithmetic inside render, but the function's signature makes it a hidden coupling point with whatever upstream sums those numbers.
- **Runtime usage:**
  - `populateTemplate(buffer, uwModel)` — invoked from elsewhere in the codebase (legacy export paths). Not invoked from `render.routes.ts` `/export` (that handler uses `applyRenderPayloadToTemplate`).
  - `populateRollUpTemplate(buffer, properties, portfolioTotals)` — same legacy posture.
- **Recommendation:** **remove dependency** (delete the legacy paths after parity-corpus migration).
- **Rationale:** These functions predate the schema-addressed `RenderPayload` path. Once Audit 4 (parity-corpus seeding) lands, every existing analysis can be replayed through `applyRenderPayloadToTemplate` and the legacy `populateTemplate` / `populateRollUpTemplate` are dead code. Defer the actual deletion until parity is proven, but do **not** ship Batch 6 with these heuristic paths still wired to any production endpoint — they are a schema-inference back door.

---

### V5 — `routes/render.routes.ts` imports the storage layer (`store`)

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/storage/sqlite-store.ts`
- **Import statement (line 12):**
  ```ts
  import { store } from '../storage/sqlite-store.js';
  ```
- **Why it's a violation:** D1 explicit deny-list: render MUST NOT import "stores: `storage/*`, `record-graph-store`, `approved-deals-store`". The route is in render's scope (D1 names "`routes/render`"). Under the new pipeline (§1) the route's load posture should be "load `HydratedRecordGraph` by id from `record-graph-store`, run the resolver, hand the result to render" — there is no direct `Analysis` row read, and there is no direct `uw_templates` row read either.
- **Runtime usage:**
  - `render.routes.ts:223` `const analysis = store.getAnalysis(dealId);` — composes `RenderInput` from the legacy `Analysis` row.
  - `render.routes.ts:416` `const template = store.getActiveTemplate(templateType);` — pulls the active artifact + `templateMetadata` for `/export`.
  - `render.routes.ts:329` `persistObservabilityEvent(store.rawDb(), event);` — leaks the raw better-sqlite3 handle into observability service.
  - `render.routes.ts:677` `const events = readObservabilityWindow(store.rawDb(), cv, win);` — same handle leak into readiness service.
- **Recommendation:** **expand bundle** (for the analysis read) + **remove dependency** (for the rest).
- **Rationale:**
  - **Analysis read.** Replace `store.getAnalysis(dealId)` with `loadHydratedRecordGraph(dealId)` from a new record-graph-store layer (or, during the cutover, dispatch by id per §5.1: legacy ids → existing path, graph-backed ids → new path — but the dispatch is at the route entry, not in render).
  - **Template read.** `store.getActiveTemplate()` returns artifact bytes plus `templateMetadata`. The metadata belongs on the `HydratedRecordGraph`-adjacent `assetProfile` or a new `renderTemplateBinding` projection on the resolver output. The artifact bytes are not data — they're a serializable target — and may keep a narrow store edge **only** if route-level dispatch is documented separately. The cleanest cut: a tiny `render-template-loader` service that returns `{ buffer, metadata }` and is on the D2 allow-list.
  - **`store.rawDb()` leak.** Move `persistObservabilityEvent` and `readObservabilityWindow` to take a typed sink interface, not a raw sqlite handle. The route stops importing `store` for those paths; an adapter wires the sink at boot.

---

### V6 — `routes/render.routes.ts` imports `resolve-structural-variant`

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/services/resolve-structural-variant.ts`
- **Import statement (lines 25–29):**
  ```ts
  import {
    assertUnderwritingModeRegistered,
    assertVariantRegistered,
    resolveStructuralVariant,
  } from '../services/resolve-structural-variant.js';
  ```
- **Why it's a violation:** Soft. `resolve-structural-variant.ts` itself only imports from `render-schema` and `@cre/shared`, so the *module* is render-internal in spirit. But its name and `resolve*` verb pattern matches doctrine §3.3's smell list ("Function names with verbs `compute`, `derive`, `aggregate`, `normalize`, `default`, `coalesce`"). Its single runtime function inspects `AdjustedInputs` and chooses a variant key — that's a **producer-adjacent classification** that, by §3 R3, is forbidden in the resolver. If the variant key is a Stage-12 projection, it belongs *on* the resolver's output (`UnderwritingContext.structuralVariantKey`), not in a side-call from the route.
- **Runtime usage:**
  - `render.routes.ts:262` `structuralVariantKey = resolveStructuralVariant(assetClass, adjustedInputs, {}, targetContractVersion);`
  - `render.routes.ts:259` `assertVariantRegistered(...)`, line 269 `assertUnderwritingModeRegistered(...)` — these are pure schema lookups; not problematic.
- **Recommendation:** **expand context** (project `structuralVariantKey` onto `UnderwritingContext`).
- **Rationale:** The route should not need to "resolve" anything. The resolver (§3.1) computes the variant key from the bundle and returns it as a field on `UnderwritingContext` (or, equivalently, on the Stage 11/12 boundary). The two `assert*` helpers stay — they are schema membership checks, not domain logic — and can move into `render-schema.ts` directly so render-internal callers (incl. route) reach them through the allowed `render-schema` edge.

---

### V7 — `routes/render.routes.ts` imports `analysis-to-adjusted-inputs.adapter`

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/services/analysis-to-adjusted-inputs.adapter.ts`
- **Import statement (line 34):**
  ```ts
  import { adaptAnalysisToAdjustedInputs } from '../services/analysis-to-adjusted-inputs.adapter.js';
  ```
- **Why it's a violation:** This adapter is a producer in the strict sense — it builds `AdjustedInputs` (a record shape that lives in `HydratedRecordGraph` per §2.1) from a legacy `Analysis` row. Under §1 the new pipeline has Stages 1–10 (producers) → 11 (hydration) → 12 (resolver) → 13 (render). The adapter is doing producer work at *route time*, inside the render layer's directory. D1 explicitly forbids render from importing producers.
- **Runtime usage:** `render.routes.ts:243` `const adjustedInputs = adaptAnalysisToAdjustedInputs(analysis);`. Used twice downstream:
  1. As input to `resolveStructuralVariant` (V6).
  2. As input to `hydrateUnderwritingContext` (V8) and as a top-level `RenderInput.adjustedInputs` field (line 295) feeding the v6 schema selectors.
- **Recommendation:** **expand bundle** (`HydratedRecordGraph.adjustedInputs`).
- **Rationale:** §2.1 already has `adjustedInputs: AdjustedInputs` in the bundle. Once the storage strategy is dispatched per §5.1, the route loads the bundle, reads `bundle.adjustedInputs` directly, and the adapter becomes unnecessary at the route. The adapter file may live on as a cutover-helper inside the legacy dispatch path — but it does **not** belong on render's import graph.

---

### V8 — `routes/render.routes.ts` imports `hydrate-underwriting-context`

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/services/hydrate-underwriting-context.ts`
- **Import statement (line 35):**
  ```ts
  import { hydrateUnderwritingContext } from '../services/hydrate-underwriting-context.js';
  ```
- **Why it's a violation:** Hydration is **Stage 11** per §1. The route is **render** (Stage 13). D1 forbids render from invoking hydration directly — the data flow is `extraction → producers → hydration → resolver → render`, not `route → hydration → render`. Today the route is fused with hydration; under the new architecture, the route is a thin dispatcher that loads the bundle and calls the resolver.
- **Runtime usage:** `render.routes.ts:296` ``underwritingContext: hydrateUnderwritingContext({ analysis, adjustedInputs, mode: underwritingMode }),``
- **Recommendation:** **expand bundle** + **remove dependency**.
- **Rationale:** Replace with `loadHydratedRecordGraph(dealId)` followed by `resolve(bundle, mode)`. Hydration becomes a single named producer call inside the route's record-graph-loading code, not a render-time ad-hoc invocation. Note: `hydrate-underwriting-context.ts` itself imports `field-authority.types` and `field-authority.resolver` — those become Stage 11 producer-internal details and stop appearing on the render-layer transitive import graph entirely.

---

### V9 — `routes/render.routes.ts` imports `underwriting-observability.service`

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/services/underwriting-observability.service.ts`
- **Import statement (lines 36–40):**
  ```ts
  import {
    buildObservabilityEvent,
    emitObservabilityEvent,
    persistObservabilityEvent,
  } from '../services/underwriting-observability.service.js';
  ```
- **Why it's a violation:** Soft. The observability service is read-only by design — it does not produce records, mutate inputs, or carry policy. But: (a) `persistObservabilityEvent` writes a row into `underwriting_observability_log` (a sqlite table) — a **store write**, even if non-canonical; (b) `buildObservabilityEvent` synthesizes a `UnderwritingObservabilityEvent` by reading multiple input surfaces (`adjustedInputs`, `resolvedContext`, the `analysis` row, `cellBindings`) and re-attributing each field to a source surface — that's a side-channel measurement that, if it ever drifts, could couple render's behavior to its own metrics.
- **Runtime usage:** `render.routes.ts:315–329` — invoked inside `onProjected` callback after every render. `persistObservabilityEvent(store.rawDb(), event)` performs a sqlite INSERT.
- **Recommendation:** **remove dependency** (move observability behind a sink interface) or **expand bundle** (the `analysis` field passed in `buildObservabilityEvent` is the only producer-shaped argument; pass `librarySnapshot` or `narrativeFacts` from the bundle instead).
- **Rationale:** Observability is allowed to *read* render output — that's its purpose. But it should not be allowed to *write* via a raw sqlite handle leaked through the route. Under the cleanup: define a `RenderEventSink` interface with `emit(event)`, wire the sqlite-backed implementation at app boot, and let render call `sink.emit(...)` through dependency injection — no `store.*` import on the render side. The `analysis` argument in `buildObservabilityEvent` should be replaced by the bundle's `librarySnapshot` + `narrativeFacts` so the metric does not couple to the legacy `Analysis` shape during cutover.

---

### V10 — `routes/render.routes.ts` imports `migration-readiness.service` (which queries sqlite directly)

- **Importing module:** `apps/api/src/routes/render.routes.ts`
- **Imported module:** `apps/api/src/services/migration-readiness.service.ts`
- **Import statement (lines 41–44):**
  ```ts
  import {
    computeReadiness,
    readObservabilityWindow,
  } from '../services/migration-readiness.service.js';
  ```
- **Why it's a violation:** `readObservabilityWindow` accepts a raw better-sqlite3 handle (`db: any`) and runs `db.prepare(...).all(...)` against `underwriting_observability_log`. That's a direct store read — one step away from a producer/store import. The route then does `readObservabilityWindow(store.rawDb(), cv, win)` (line 677), which is a transitive D1 violation: render is tunneling a store handle into a service that reads the store.
- **Runtime usage:** `/migration-readiness` GET handler (lines 663–683). The handler is only loosely "render" — it does not produce a `RenderPayload`. Arguably it does not belong on `renderRoutes` at all, but on a separate `/governance` or `/observability` router.
- **Recommendation:** **remove dependency** (move handler off the render router) **or** **remove dependency** (introduce a sink-side reader interface mirroring V9's recommendation).
- **Rationale:** The `/migration-readiness` endpoint is governance tooling, not a render endpoint. Splitting it onto a `governanceRoutes` router (or a separate `/admin/*` namespace) cleanly removes the readiness import from the render-layer surface. If the endpoint stays here, it must consume the same sink interface introduced in V9 — never `store.rawDb()` directly.

---

## Side-channel data fetches

Items in this section are runtime accesses that bypass the formal import graph — file reads, network calls, env reads, clock reads, global state, and any `process.*` access. Audited against doctrine §2.2 H4 (no `Date.now()`, no random, no env reads in hydration) and §4 D1 (no calculators).

### S1 — `routes/render.routes.ts` reads the wall clock

- **Location:** `render.routes.ts:290` ``generatedAt: new Date().toISOString()``.
- **Classification:** **policy** if any downstream record-id derivation depends on `generatedAt`; **safe** if `generatedAt` is purely a metadata field on `RenderPayload` for human display.
- **Cross-check vs. §2.2 H4:** Hydration is forbidden a clock read. Render is not explicitly bound by H4, but **§5.2 B5** (idempotency end-to-end) requires "Same `ExtractionResult` → same `DoctrineEvaluationId` → same rendered output bytes. Zero non-deterministic inputs (no `Date.now()` in record bodies)". A clock-derived `generatedAt` injected at render time and emitted on the wire **breaks B5** unless explicitly excluded from the byte-equality predicate.
- **Recommendation:** **expand context** — surface a canonical `analysisAsOfDate` (the record's stable date) on `UnderwritingContext.meta`, and use that for `generatedAt`. If a true wall-clock "rendered at" stamp is wanted for audit, put it in a response header (`X-Rendered-At`) outside the payload bytes, not on `RenderInput.meta`.

### S2 — `routes/render.routes.ts` writes structured logs to `process.stdout`

- **Location:** `render.routes.ts:520` ``process.stdout.write(JSON.stringify({ kind: 'EXPORT_OBSERVABILITY', ... }) + '\n');``
- **Classification:** **safe** — write-only telemetry, no policy effect.
- **Recommendation:** No change required, but route through the same `RenderEventSink` interface proposed in V9 for consistency.

### S3 — `services/render-schema.ts` calls `createHash('sha256').update(...)`

- **Location:** `render-schema.ts:1235` `return createHash('sha256').update(stableStringify(snap)).digest('hex');`.
- **Classification:** **safe**. The hash is over static schema definitions only; deterministic and computed once at boot. No domain inputs.
- **Recommendation:** No change.

### S4 — `services/resolve-underwriting-context.ts` `readFileSync(import.meta.url, 'utf8')` self-introspection

- **Location:** `resolve-underwriting-context.ts:229` `source = readFileSync(fileURLToPath(import.meta.url), 'utf8');`
- **Classification:** **safe in spirit, dirty in practice**. The resolver reads its own source file at boot to enforce the import-graph guardrail. Under the new pipeline this resolver becomes Stage 12; the self-introspection check belongs at the lint layer (`dependency-cruiser` or ESLint `no-restricted-imports` per §2.3), not in module code. Today it adds a filesystem read to the render layer's transitive boot dependencies — when render imports `resolveUnderwritingContext`, it transitively triggers this `readFileSync`.
- **Cross-check vs. §2.3:** §2.3 explicitly says "Enforcement — module-boundary policy, NOT grep audits." This in-module self-grep duplicates what `dependency-cruiser` will do, with the disadvantage that it reads the disk at boot.
- **Recommendation:** **remove dependency** (lift the import-graph check to CI lint per §2.3).

### S5 — Boot-time module side effects (advisory)

`render-schema.ts`, `render-migrations.ts`, and `template-registry.ts` each run boot-time IIFEs (`assertSchemaWellFormed()`, `assertChainComplete()`, `assertRegistryCoverageWithinSchema()`) at first import. These read only their own module-level data and throw on misconfiguration. **Safe.** They are also the load-bearing reason `render-schema.ts` would be slow to test in isolation if it grew further — flag for future refactor only.

---

## Recommendations

### Must-fix before Batch 6

1. **V1, V8** — Decouple render from in-render resolver invocation and from hydration. Once Stage 11/12/13 are real, render imports only `UnderwritingContext` (the resolver's output type) and the schema modules. The `resolveUnderwritingContext` and `hydrateUnderwritingContext` runtime imports must be gone from `render.service.ts` and `render.routes.ts`.
2. **V5, V7** — Strip the `store` and `analysis-to-adjusted-inputs.adapter` imports from `render.routes.ts`. Replace with `loadHydratedRecordGraph(dealId)` + `resolve(bundle, mode)`. Strict-dispatch (§5.1) keeps the legacy path for legacy ids without putting `store` back on the render-layer import graph.
3. **V6** — Remove `resolve-structural-variant` from the route. Project `structuralVariantKey` onto `UnderwritingContext` via the resolver. Move the two membership-assertion helpers into `render-schema.ts` so the route reaches them through the allowed render-internal edge.
4. **V10** — Move `/migration-readiness` off `renderRoutes` to a dedicated governance router. It is not a render endpoint and its sqlite read is a transitive D1 violation today.
5. **S1** — Stop reading `new Date()` at render time. Surface `analysisAsOfDate` from the record graph (§2.2 H4 / §5.2 B5). If a wall-clock "rendered at" is needed, put it in a response header, never the payload.

### Nice-to-have cleanups

6. **V2** — Convert the runtime `require('./field-migration-state.js')` in `render-schema.ts` to a static `import`. There is no real runtime cycle (the back-edge is a type-only import).
7. **V3** — Move the `Math.round(m / 12)` unit conversions (`amortizationYears`, `ctxLoanMonthsToYears`) out of selector helpers into the resolver. Render selectors should be pure passthrough.
8. **V4** — Schedule deletion of the legacy `populateTemplate` / `populateRollUpTemplate` / `buildValueMap` / `findFieldTargets` / `FIELD_PATTERNS` heuristic mapping in `template-engine.service.ts` once the parity corpus (Audit 4) covers the cases they currently serve. They are an alternative render path that bypasses schema addresses entirely.
9. **V9** — Introduce a `RenderEventSink` interface so observability does not require `store.rawDb()`. Same lever fixes V10 if `/migration-readiness` is kept on `renderRoutes`.
10. **S4** — Lift the resolver's self-introspection import-graph guard to `dependency-cruiser` / ESLint `no-restricted-imports` per §2.3, and drop the `readFileSync` from the module body.

### Bundle / context expansion proposals

The findings imply the following additions to `HydratedRecordGraph` and `UnderwritingContext` to make the V1–V10 fixes possible without re-introducing forbidden edges:

- **Bundle (`HydratedRecordGraph`)**:
  - Already contains `adjustedInputs: AdjustedInputs` (§2.1) — this absorbs V7.
  - Needs a `renderTemplateBinding` projection or sibling record (carries `templateMetadata`, NOT the artifact bytes — bytes are loaded separately by the export route's narrow loader). Absorbs the metadata half of V5.
  - All other render reads route through the existing 9 records.

- **Context (`UnderwritingContext`)** — projected fields the resolver should expose so render becomes pure:
  - `structuralVariantKey: StructuralVariantKey` — absorbs V6.
  - `loan.amortizationYears: number | null`, `loan.termYears: number | null`, `loan.ioYears: number | null` — pre-converted units; absorbs V3.
  - `meta.analysisAsOfDate: string` — replaces clock-derived `generatedAt`; absorbs S1.
  - The full post-projection narrative surface (currently `ResolvedUnderwritingContext`) collapses into `UnderwritingContext` — render reads `context.parties.borrowerName` directly, no second-stage resolution. Absorbs V1.

- **No-change-needed**:
  - `render-schema`, `render-output-scrubber`, `render-migrations`, `template-registry` are already D1/D2 compliant. Keep as-is.

---

*End of Audit 2.*
