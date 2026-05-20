# Batch 6 Audit 5 — API Route Compatibility Matrix

**Date:** 2026-05-08
**Target:** `apps/api/src/routes/*.ts` + `apps/web` consumers
**Goal:** Catalogue every API route touching analysis / render / underwriting outputs, confirm response shapes, identify which routes are safe under STRICT DISPATCH and which require versioning before cutover. (Doctrine: doc'ing what the legacy → graph-backed route boundary must guarantee.)
**Doctrine reference:** `docs/architecture/batch6-record-graph-and-resolution.md` §5.1 (storage strategy: STRICT DISPATCH locked) and §6.5 (this audit).

## Route catalog

Routes are grouped by file. Mount prefixes (from `apps/api/src/routes/index.ts`):

- `/api/auth` → `auth.routes.ts`
- `/api/analyses` → `analysis.routes.ts`
- `/api/criteria` → `criteria.routes.ts`
- `/api/research` → `research.routes.ts`
- `/api/uw-intelligence` → `uw-intelligence.routes.ts`
- `/api/manifesto` → `manifesto.routes.ts`
- `/api/underwriting` → `render.routes.ts`

| # | Method + path | Handler file:line | Response shape (summary) | Web consumer | Cutover classification |
|---|---|---|---|---|---|
| R1  | POST   /api/analyses                                  | analysis.routes.ts:28  | `{ id, status, name, assetType, createdAt, inputHash, cached? }` | `apps/web/src/app/analysis/new/page.tsx:111` (via `api.uploadAnalysis`)  | STRICT_DISPATCH_REQUIRED (write path) |
| R2  | GET    /api/analyses                                  | analysis.routes.ts:163 | `{ analyses: Analysis[] }`                                       | `apps/web/src/app/page.tsx:11` (via `api.listAnalyses`)                  | ADDITIVE_SAFE                          |
| R3  | GET    /api/analyses/compare                          | analysis.routes.ts:169 | `{ comparison }`                                                 | `apps/web/src/lib/api-client.ts:336` (no current page caller)           | STRICT_DISPATCH_REQUIRED (per-id)      |
| R4  | GET    /api/analyses/audit-log                        | analysis.routes.ts:188 | `{ entries }`                                                    | `apps/web/src/lib/api-client.ts:337` (no current page caller)           | ADDITIVE_SAFE                          |
| R5  | GET    /api/analyses/model-versions                   | analysis.routes.ts:196 | `{ versions }`                                                   | `apps/web/src/lib/api-client.ts:344`                                    | ADDITIVE_SAFE                          |
| R6  | GET    /api/analyses/:id                              | analysis.routes.ts:202 | `{ analysis: Analysis }` (full detail incl. uwModel, findings, score, bPieceDecision, criteriaEvaluations, mitigations, crossCheckFindings, stressScenarios, research, comments, validationResult, executiveSummary, manifestoVersion, modelLogicVersion, inputHash) | `apps/web/src/app/analysis/[id]/page.tsx:38, 68` | **STRICT_DISPATCH_REQUIRED** |
| R7  | GET    /api/analyses/:id/status                       | analysis.routes.ts:212 | `{ id, status, progress, currentStep, error }`                   | `apps/web/src/lib/api-client.ts:76` (polling)                            | STRICT_DISPATCH_REQUIRED               |
| R8  | DELETE /api/analyses/:id                              | analysis.routes.ts:228 | `{ success: true }`                                              | `apps/web/src/lib/api-client.ts:77`                                      | STRICT_DISPATCH_REQUIRED               |
| R9  | PATCH  /api/analyses/:id/uw-model                     | analysis.routes.ts:238 | `{ uwModel, changedMetrics: [{metric, oldValue, newValue}] }`    | `apps/web/src/app/analysis/[id]/page.tsx:75`                            | **VERSIONING_REQUIRED**                |
| R10 | PATCH  /api/analyses/:id/loan-terms                   | analysis.routes.ts:294 | `{ uwModel, repaymentSchedule, changedMetrics }`                 | `apps/web/src/app/analysis/[id]/page.tsx:82`                            | **VERSIONING_REQUIRED**                |
| R11 | POST   /api/analyses/:id/stress-test                  | analysis.routes.ts:364 | `{ results }`                                                    | `apps/web/src/app/analysis/[id]/page.tsx:89`                            | STRICT_DISPATCH_REQUIRED               |
| R12 | GET    /api/analyses/:id/comments                     | analysis.routes.ts:380 | `{ comments: Comment[], bySectionId: Record<sectionId,Comment[]> }` | `apps/web/src/lib/api-client.ts:129`                                  | STRICT_DISPATCH_REQUIRED               |
| R13 | POST   /api/analyses/:id/comments                     | analysis.routes.ts:390 | `{ comment }` (201)                                              | `apps/web/src/app/analysis/[id]/page.tsx:66`                            | STRICT_DISPATCH_REQUIRED               |
| R14 | PUT    /api/analyses/:id/comments/:commentId          | analysis.routes.ts:418 | `{ comment }`                                                    | (api-client has no helper; reachable via direct fetch)                   | STRICT_DISPATCH_REQUIRED               |
| R15 | DELETE /api/analyses/:id/comments/:commentId          | analysis.routes.ts:427 | `{ success: true }`                                              | `apps/web/src/lib/api-client.ts:135`                                    | STRICT_DISPATCH_REQUIRED               |
| R16 | GET    /api/analyses/:id/populated-template           | analysis.routes.ts:437 | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (binary stream) | `apps/web/src/lib/api-client.ts:81`                | STRICT_DISPATCH_REQUIRED               |
| R17 | GET    /api/analyses/:id/populated-template/info      | analysis.routes.ts:450 | `{ available, fileName, mappedFields, unmappedFields, tabsPopulated }` | `apps/web/src/app/analysis/[id]/page.tsx:49`                  | STRICT_DISPATCH_REQUIRED               |
| R18 | GET    /api/analyses/:id/audit                        | analysis.routes.ts:467 | `{ entries }`                                                    | `apps/web/src/lib/api-client.ts:334`                                    | STRICT_DISPATCH_REQUIRED               |
| R19 | GET    /api/underwriting/render                       | render.routes.ts:353   | `RenderPayload` (flat cell-bindings, visible tabs, drivers, contractVersion, structuralVariantKey, underwritingMode, migrationsFromClient?) | (none in `apps/web` today — Excel workbook macro consumes) | **STRICT_DISPATCH_REQUIRED** |
| R20 | GET    /api/underwriting/export                       | render.routes.ts:389   | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (binary; X-Render-* headers) | `apps/web/src/app/analysis/[id]/page.tsx:164,177` | **STRICT_DISPATCH_REQUIRED** |
| R21 | GET    /api/underwriting/render-config                | render.routes.ts:544   | `{ contractVersion, assetClassVariantModeTabs, variantsByAssetClass, assetClassVariantDefaults, modesByAssetClassVariant, addressesByAssetClassVariantMode, managedNamespaceByAssetClassVariantMode, migrationsFromClient? }` | Excel workbook | ADDITIVE_SAFE (deal-agnostic) |
| R22 | GET    /api/underwriting/render-migrations            | render.routes.ts:627   | `{ contractVersion, all }` or migration manifest                 | tooling/CI                                                               | ADDITIVE_SAFE                          |
| R23 | GET    /api/underwriting/migration-readiness          | render.routes.ts:663   | `{ ...readiness report }`                                        | governance tooling (no current web caller)                               | ADDITIVE_SAFE                          |
| R24 | POST   /api/auth/login                                | auth.routes.ts:10      | `{ token, user }`                                                | login flow (api-client `request<>` helper redirects)                     | OUT_OF_SCOPE                           |
| R25 | POST   /api/auth/register                             | auth.routes.ts:35      | `{ user }` (201)                                                 | admin flow                                                               | OUT_OF_SCOPE                           |
| R26 | GET    /api/auth/me                                   | auth.routes.ts:59      | `{ user }`                                                       | session bootstrap                                                        | OUT_OF_SCOPE                           |
| R27 | GET    /api/criteria/:assetType                       | criteria.routes.ts:11  | `{ criteria }`                                                   | `apps/web/src/app/admin/criteria/page.tsx`                               | OUT_OF_SCOPE                           |
| R28 | POST   /api/criteria/:assetType                       | criteria.routes.ts:22  | `{ rule }` (201)                                                 | criteria admin                                                           | OUT_OF_SCOPE                           |
| R29 | PUT    /api/criteria/:assetType/:id                   | criteria.routes.ts:50  | `{ rule }`                                                       | criteria admin                                                           | OUT_OF_SCOPE                           |
| R30 | DELETE /api/criteria/:assetType/:id                   | criteria.routes.ts:71  | `{ success }`                                                    | criteria admin                                                           | OUT_OF_SCOPE                           |
| R31 | PUT    /api/criteria/:assetType/weights               | criteria.routes.ts:86  | `{ scoringWeights }`                                             | criteria admin                                                           | OUT_OF_SCOPE                           |
| R32 | POST   /api/research/sponsor                          | research.routes.ts:6   | `{ results }`                                                    | not used by web today (api-client wrappers exist)                        | OUT_OF_SCOPE                           |
| R33 | POST   /api/research/market                           | research.routes.ts:20  | `{ results }`                                                    | not used by web today                                                    | OUT_OF_SCOPE                           |
| R34 | POST   /api/research/news                             | research.routes.ts:34  | `{ results }`                                                    | not used by web today                                                    | OUT_OF_SCOPE                           |
| R35 | POST   /api/research/crime                            | research.routes.ts:48  | `{ results }`                                                    | not used by web today                                                    | OUT_OF_SCOPE                           |
| R36 | POST   /api/uw-intelligence/upload                    | uw-intelligence.routes.ts:48  | `{ underwriting }` (201)                                  | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R37 | POST   /api/uw-intelligence/batch-upload              | uw-intelligence.routes.ts:83  | `{ message, results }` (201)                              | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R38 | POST   /api/uw-intelligence/batch-upload-async        | uw-intelligence.routes.ts:145 | `{ jobId, message, totalFiles }` (202)                    | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R39 | GET    /api/uw-intelligence/batch-jobs/:jobId         | uw-intelligence.routes.ts:168 | `{ job }`                                                 | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R40 | GET    /api/uw-intelligence/library                   | uw-intelligence.routes.ts:178 | `{ underwritings }`                                       | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R41 | GET    /api/uw-intelligence/library/:id               | uw-intelligence.routes.ts:184 | `{ underwriting }`                                        | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R42 | GET    /api/uw-intelligence/library/:id/download      | uw-intelligence.routes.ts:194 | binary file                                               | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R43 | GET    /api/uw-intelligence/library/:id/children      | uw-intelligence.routes.ts:207 | `{ children }`                                            | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R44 | PUT    /api/uw-intelligence/library/:id               | uw-intelligence.routes.ts:213 | `{ underwriting }`                                        | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R45 | DELETE /api/uw-intelligence/library/:id               | uw-intelligence.routes.ts:223 | `{ success }`                                             | underwriting-library admin                                               | OUT_OF_SCOPE                           |
| R46 | POST   /api/uw-intelligence/re-extract                | uw-intelligence.routes.ts:233 | `{ ...result }`                                           | admin tooling                                                            | OUT_OF_SCOPE                           |
| R47 | GET    /api/uw-intelligence/market-intelligence       | uw-intelligence.routes.ts:248 | `{ markets }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R48 | GET    /api/uw-intelligence/insights                  | uw-intelligence.routes.ts:264 | `{ insights }`                                            | admin                                                                    | OUT_OF_SCOPE                           |
| R49 | GET    /api/uw-intelligence/sufficiency               | uw-intelligence.routes.ts:271 | `{ sufficient, ... }`                                     | admin                                                                    | OUT_OF_SCOPE                           |
| R50 | GET    /api/uw-intelligence/rules/metadata            | uw-intelligence.routes.ts:282 | `{ metadata }`                                            | admin                                                                    | OUT_OF_SCOPE                           |
| R51 | POST   /api/uw-intelligence/rules/generate            | uw-intelligence.routes.ts:288 | `{ rules, count }`                                        | admin                                                                    | OUT_OF_SCOPE                           |
| R52 | GET    /api/uw-intelligence/rules                     | uw-intelligence.routes.ts:305 | `{ rules }`                                               | admin                                                                    | OUT_OF_SCOPE                           |
| R53 | PUT    /api/uw-intelligence/rules/:id                 | uw-intelligence.routes.ts:312 | `{ rule }`                                                | admin                                                                    | OUT_OF_SCOPE                           |
| R54 | DELETE /api/uw-intelligence/rules/:id                 | uw-intelligence.routes.ts:322 | `{ success }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R55 | GET    /api/uw-intelligence/rules/:id/versions        | uw-intelligence.routes.ts:332 | `{ versions }`                                            | admin                                                                    | OUT_OF_SCOPE                           |
| R56 | POST   /api/uw-intelligence/rules/:id/rollback        | uw-intelligence.routes.ts:338 | `{ rule }`                                                | admin                                                                    | OUT_OF_SCOPE                           |
| R57 | POST   /api/uw-intelligence/apply                     | uw-intelligence.routes.ts:357 | `{ intelligence }`                                        | admin                                                                    | OUT_OF_SCOPE                           |
| R58 | POST   /api/uw-intelligence/outcomes-upload           | uw-intelligence.routes.ts:374 | `{ ...result }` (201)                                     | admin                                                                    | OUT_OF_SCOPE                           |
| R59 | POST   /api/uw-intelligence/outcomes-apply            | uw-intelligence.routes.ts:391 | `{ success }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R60 | GET    /api/uw-intelligence/unmatched-outcomes        | uw-intelligence.routes.ts:420 | `{ outcomes }`                                            | admin                                                                    | OUT_OF_SCOPE                           |
| R61 | GET    /api/uw-intelligence/unmatched-outcomes/:id    | uw-intelligence.routes.ts:426 | `{ outcome }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R62 | POST   /api/uw-intelligence/unmatched-outcomes/:id/link | uw-intelligence.routes.ts:436 | `{ success }`                                           | admin                                                                    | OUT_OF_SCOPE                           |
| R63 | DELETE /api/uw-intelligence/unmatched-outcomes/:id    | uw-intelligence.routes.ts:452 | `{ success }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R64 | POST   /api/uw-intelligence/templates                 | uw-intelligence.routes.ts:466 | `{ template, structure, message }` (201)                  | admin                                                                    | OUT_OF_SCOPE                           |
| R65 | GET    /api/uw-intelligence/templates                 | uw-intelligence.routes.ts:533 | `{ templates }`                                           | admin                                                                    | OUT_OF_SCOPE                           |
| R66 | GET    /api/uw-intelligence/templates/active/:templateType | uw-intelligence.routes.ts:540 | `{ template (meta) }`                                | admin                                                                    | OUT_OF_SCOPE                           |
| R67 | GET    /api/uw-intelligence/templates/:id/download    | uw-intelligence.routes.ts:559 | binary                                                    | admin                                                                    | OUT_OF_SCOPE                           |
| R68 | GET    /api/uw-intelligence/templates/:templateType/versions | uw-intelligence.routes.ts:572 | `{ versions }`                                     | admin                                                                    | OUT_OF_SCOPE                           |
| R69 | POST   /api/uw-intelligence/templates/:id/activate    | uw-intelligence.routes.ts:584 | `{ success }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R70 | DELETE /api/uw-intelligence/templates/:id             | uw-intelligence.routes.ts:594 | `{ success }`                                             | admin                                                                    | OUT_OF_SCOPE                           |
| R71 | POST   /api/manifesto/upload                          | manifesto.routes.ts:10 | `{ id, version, status, message }` (201)                         | admin                                                                    | OUT_OF_SCOPE                           |
| R72 | GET    /api/manifesto/active                          | manifesto.routes.ts:46 | `{ manifesto, hasManifesto }`                                    | admin                                                                    | OUT_OF_SCOPE                           |
| R73 | GET    /api/manifesto/history                         | manifesto.routes.ts:57 | `{ manifestos }`                                                 | admin                                                                    | OUT_OF_SCOPE                           |
| R74 | GET    /api/manifesto/compare                         | manifesto.routes.ts:63 | `{ diff }`                                                       | admin                                                                    | OUT_OF_SCOPE                           |
| R75 | GET    /api/manifesto/:id/status                      | manifesto.routes.ts:82 | `{ id, status, extractedRulesCount, ambiguitiesCount, error }`   | admin                                                                    | OUT_OF_SCOPE                           |
| R76 | GET    /api/manifesto/:id                             | manifesto.routes.ts:98 | `{ manifesto }`                                                  | admin                                                                    | OUT_OF_SCOPE                           |
| R77 | POST   /api/manifesto/:id/activate                    | manifesto.routes.ts:109 | `{ success, message }`                                          | admin                                                                    | OUT_OF_SCOPE                           |

> "OUT_OF_SCOPE" = does not touch analysis-graph data; not affected by the legacy/new spine boundary. Listed for completeness per audit charter.

## Per-route detail (in-scope routes only)

The 23 in-scope routes are R1–R23. Out-of-scope routes (R24–R77) are catalogued in the matrix above but not detailed below.

### R1 — POST /api/analyses
- **Handler:** `apps/api/src/routes/analysis.routes.ts:28`
- **Method + path:** `POST /api/analyses`
- **Request shape:** `multipart/form-data` — `asr` (file, required), `seller_uw|uw` (file, optional), `supporting_docs[]` (files), `template` (file), `templateType` (`single_loan|roll_up`), `assetType` (string, required), `name` (string).
- **Response shape:**
  - 201: `{ id: string, status: 'parsing', name, assetType, createdAt, inputHash }`
  - 200 cache-hit: `{ id, status: 'complete', name, assetType, createdAt, cached: true, inputHash }`
- **Web consumers:** `apps/web/src/app/analysis/new/page.tsx:111` (via `api.uploadAnalysis`).
- **External consumers:** none observed.
- **Coupling — required fields per consumer:** `id` (used to `router.push(/analysis/${id})`).
- **Cutover classification:** STRICT_DISPATCH_REQUIRED (write path)
- **Rationale:** This is the entry point that creates a new analysis. Cutover means new uploads must mint graph-backed ids and traverse the new spine; legacy analyses already exist in the legacy store with their own (uuid v4) ids and are read-only.
- **Implementation notes:** Mode-feature-flag dispatch happens here (e.g. env `USE_GRAPH_BACKED_PIPELINE`), not by id pattern (since the id is being minted). Once flipped, all new ids are graph-backed; downstream id-pattern dispatch then routes legacy ids to the legacy reader and graph-backed ids to the new reader.

### R2 — GET /api/analyses
- **Handler:** `apps/api/src/routes/analysis.routes.ts:163`
- **Method + path:** `GET /api/analyses`
- **Request shape:** none.
- **Response shape:** `{ analyses: Analysis[] }` (list — `store.listAnalyses()`).
- **Web consumers:** `apps/web/src/app/page.tsx:11` reads `data.analyses` and projects `id, name, assetType, status, createdAt`.
- **Coupling — required fields per consumer:** `id, name, assetType, status, createdAt`.
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Listing endpoint. Both legacy and graph-backed analyses must appear in a single list. The handler can union results from both stores transparently; no caller-visible breaking change.
- **Implementation notes:** Implementation reads from `store.listAnalyses()`; post-cutover, this becomes a union over legacy + graph-backed records. Each record carries its own id, so per-row dispatch on detail fetches still works.

### R3 — GET /api/analyses/compare
- **Handler:** `apps/api/src/routes/analysis.routes.ts:169`
- **Method + path:** `GET /api/analyses/compare?base=<id>&compare=<id>`
- **Request shape:** query `base`, `compare`.
- **Response shape:** `{ comparison }`.
- **Web consumers:** api-client wrapper exists; no current page caller.
- **Coupling:** unspecified (no active consumer to constrain).
- **Cutover classification:** STRICT_DISPATCH_REQUIRED (per-id, on each side)
- **Rationale:** Each id is dispatched independently. If both ids are legacy → legacy compare. If both are graph-backed → new compare. Mixed mode is an interesting case that should error explicitly until cross-spine compare is implemented.
- **Implementation notes:** Dispatch each id independently; if formats differ, return 409 `MIXED_SPINE_COMPARE_UNSUPPORTED`.

### R4 — GET /api/analyses/audit-log
- **Handler:** `apps/api/src/routes/analysis.routes.ts:188`
- **Response shape:** `{ entries }` (filterable by `assetType`, `limit`).
- **Web consumers:** api-client wrapper exists; no active page consumer.
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Cross-analysis audit log; can union legacy + graph-backed entries.

### R5 — GET /api/analyses/model-versions
- **Handler:** `apps/api/src/routes/analysis.routes.ts:196`
- **Response shape:** `{ versions }`.
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Static-ish data about model logic versions; not id-bound.

### R6 — GET /api/analyses/:id  (CRITICAL)
- **Handler:** `apps/api/src/routes/analysis.routes.ts:202`
- **Method + path:** `GET /api/analyses/:id`
- **Request shape:** path `id`.
- **Response shape:** `{ analysis: Analysis }` — the entire `Analysis` object from the legacy `Analysis` type in `@cre/shared`. From `apps/web/src/app/analysis/[id]/page.tsx` and `apps/web/src/lib/api-client.ts`, the consumer reads:
  - top-level: `id, name, assetType, status, currentStep, progress, error, createdAt, updatedAt, inputHash, manifestoVersion, modelLogicVersion, validationResult{passed, checks[]}, executiveSummary, overallAdjustmentBias`
  - findings + scoring: `findings[]`, `creditScore`, `criteriaEvaluations[]`, `mitigations[]`, `crossCheckFindings[]`, `bPieceDecision{recommendation, conviction, summary, dealBreakers[], keyConditions[], pricingGuidance}`
  - underwriting model: `uwModel{ income{...}, expenses{...}, netOperatingIncome, capRate, impliedValue, loanAmount, interestRate, loanDetails{rateType, ioMonths, termMonths, amortizationMonths, prepaymentTerms}, termYears, amortizationYears, annualDebtService, dscr, ltv, debtYield, repaymentSchedule{summary{balloonBalance, balloonDate, minDSCR}, schedule[]} }`
  - misc: `research{sponsor[], market[], news[]}`, `stressScenarios[]`, `comments[]`
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:38, 68` (via `api.getAnalysis`).
- **Coupling — required fields per consumer:** `id, name, assetType, status, progress, currentStep, uwModel, findings, creditScore, crossCheckFindings, criteriaEvaluations, mitigations, bPieceDecision, executiveSummary, comments, research, stressScenarios, validationResult, overallAdjustmentBias, inputHash, manifestoVersion, modelLogicVersion`.
- **Cutover classification:** **STRICT_DISPATCH_REQUIRED**
- **Rationale:** This is the keystone read endpoint. The web page expects the full legacy `Analysis` shape. Strict dispatch means: legacy id → return the legacy `Analysis` document directly; graph-backed id → hydrate the record graph and project it back into the legacy `Analysis` shape (a one-way adapter living at the route entry point). The shape contract holds because the projection adapter targets the same TypeScript type. Field-level parity is verified by the `fixtures/stabilized/` corpus (§5.3).
- **Implementation notes:** Single endpoint, two code paths (one underlying retrieval per id format). The adapter is the responsibility of the new spine, not the legacy side. Adapter must NOT compute UW values; it only flattens / renames / picks (resolver-style transforms only). Any null-coercion in the adapter is forbidden by the doctrine §3.2 R3.

### R7 — GET /api/analyses/:id/status
- **Handler:** `apps/api/src/routes/analysis.routes.ts:212`
- **Response shape:** `{ id, status, progress, currentStep, error }`.
- **Web consumers:** `apps/web/src/lib/api-client.ts:76` (used as a polling helper; main page uses R6 for polling).
- **Coupling:** `id, status, progress, currentStep, error`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Tied to a per-id retrieval. The new spine produces ids that are content-hash-bound; for in-flight processing status, the new pipeline must surface the same five fields.
- **Implementation notes:** Trivial dispatch on id format.

### R8 — DELETE /api/analyses/:id
- **Handler:** `apps/api/src/routes/analysis.routes.ts:228`
- **Response shape:** `{ success: true }`.
- **Web consumers:** `apps/web/src/lib/api-client.ts:77`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Per-id mutation. Note: doctrine §2.2 H7 declares producer outputs immutable / append-only — graph-backed analyses are never mutated, but the *index/handle* may be tombstoned. Legacy ids continue to use the existing delete.
- **Implementation notes:** Graph-backed delete is a tombstone, not a row delete.

### R9 — PATCH /api/analyses/:id/uw-model  (CRITICAL — incompatible with new spine)
- **Handler:** `apps/api/src/routes/analysis.routes.ts:238`
- **Request shape:** `{ updates: { path: string; value: number }[] }` — arbitrary nested-path mutation of `uwModel`.
- **Response shape:** `{ uwModel, changedMetrics: [{metric, oldValue, newValue}] }`.
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:75` (interactive metric edits).
- **Coupling:** caller updates `prev.uwModel` with `result.uwModel`.
- **Cutover classification:** **VERSIONING_REQUIRED**
- **Rationale:** This endpoint mutates a persisted analysis in place by setting nested paths and re-running `recalculateFullModel()`. This violates doctrine §2.2 H7 (producer outputs immutable, append-only, content-hash-addressed) for the new spine. A graph-backed analysis cannot accept in-place edits — an edit must produce a *new* DoctrineEvaluationId. Either:
  1. Deprecate this endpoint for graph-backed analyses (read-only views), OR
  2. Introduce `/v2/analyses/:id/scenarios` that creates a new analysis derived from the original (append-only semantics).
  Until that decision is made, graph-backed ids hitting this endpoint must return 409 `MUTATION_NOT_SUPPORTED_ON_GRAPH_BACKED_ANALYSIS`.
- **Implementation notes:** Strict dispatch by id with a hard 409 for graph-backed ids until v2 lands.

### R10 — PATCH /api/analyses/:id/loan-terms  (CRITICAL — incompatible with new spine)
- **Handler:** `apps/api/src/routes/analysis.routes.ts:294`
- **Request shape:** `{ interestRate?, ioMonths?, amortizationMonths?, termMonths?, rateType?, paymentFrequency?, prepaymentTerms?, loanAmount? }`.
- **Response shape:** `{ uwModel, repaymentSchedule, changedMetrics }`.
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:82`.
- **Cutover classification:** **VERSIONING_REQUIRED**
- **Rationale:** Same as R9 — in-place mutation of the persisted UW model. Forbidden under §2.2 H7. Same v2 path forward.
- **Implementation notes:** 409 for graph-backed ids until v2 ("scenarios") lands.

### R11 — POST /api/analyses/:id/stress-test
- **Handler:** `apps/api/src/routes/analysis.routes.ts:364`
- **Response shape:** `{ results }`.
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:89`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Currently writes `stressScenarios` back onto the analysis (in-place). For graph-backed analyses, stress outputs are an immutable producer record (`StressOutputs`) — re-running stress against new scenarios produces a new record id, not a mutation. Endpoint becomes a read on the existing `StressOutputs` for graph-backed ids.
- **Implementation notes:** Likely needs a deeper review during Batch 6 — the legacy semantics ("re-run with custom scenarios and persist") don't carry over cleanly. Mark as a candidate for v2 if custom scenarios are required at runtime.

### R12 — GET /api/analyses/:id/comments
- **Handler:** `apps/api/src/routes/analysis.routes.ts:380`
- **Response shape:** `{ comments: Comment[], bySectionId: Record<string, Comment[]> }`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Comments are a sidecar concern — they live in their own table, keyed by `analysis_id`. They are user-state, not part of the producer pipeline. Dispatch per id format reads comments either from the legacy comments table (existing) or a graph-backed-id-keyed comments store.
- **Implementation notes:** Could share a single comments table keyed by analysis id regardless of spine, since comments are append-only-by-creation (and editable by their own id).

### R13 — POST /api/analyses/:id/comments
- **Handler:** `apps/api/src/routes/analysis.routes.ts:390`
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Same as R12. Sidecar write.

### R14 — PUT /api/analyses/:id/comments/:commentId
- **Handler:** `apps/api/src/routes/analysis.routes.ts:418`
- **Cutover classification:** STRICT_DISPATCH_REQUIRED

### R15 — DELETE /api/analyses/:id/comments/:commentId
- **Handler:** `apps/api/src/routes/analysis.routes.ts:427`
- **Cutover classification:** STRICT_DISPATCH_REQUIRED

### R16 — GET /api/analyses/:id/populated-template
- **Handler:** `apps/api/src/routes/analysis.routes.ts:437`
- **Response shape:** binary `.xlsx` stream (the legacy "populated template" produced by the background pipeline).
- **Web consumers:** download helper at `apps/web/src/lib/api-client.ts:81`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Legacy populated templates are stored alongside legacy analyses. Graph-backed analyses do not produce a populated template via this path; they go through R20 (`/api/underwriting/export`). For graph-backed ids, this endpoint should 404 (or 410 Gone with a hint to use `/api/underwriting/export`).
- **Implementation notes:** Dispatch returns 410 for graph-backed ids; web caller already tolerates 404 (caught and `setPopulatedTemplateInfo({ available: false })`).

### R17 — GET /api/analyses/:id/populated-template/info
- **Handler:** `apps/api/src/routes/analysis.routes.ts:450`
- **Response shape:** `{ available: boolean, fileName?, mappedFields?, unmappedFields?, tabsPopulated? }`.
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:49`.
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Same as R16. For graph-backed ids return `{ available: false }` (caller already handles).

### R18 — GET /api/analyses/:id/audit
- **Handler:** `apps/api/src/routes/analysis.routes.ts:467`
- **Response shape:** `{ entries }` (audit history for one analysis).
- **Cutover classification:** STRICT_DISPATCH_REQUIRED
- **Rationale:** Per-id read; the new spine has its own audit channel (the version-axis trail attached to records).

### R19 — GET /api/underwriting/render  (CRITICAL render endpoint)
- **Handler:** `apps/api/src/routes/render.routes.ts:353` (via `composeRenderPayloadFromQuery`).
- **Method + path:** `GET /api/underwriting/render?dealId=<id>&assetClass=<...>&underwritingMode=<...>&structuralVariantKey=<...>&clientContractVersion=<n>`
- **Response shape:** `RenderPayload` from `@cre/shared` (flat cell bindings, visible tabs, drivers, contractVersion, structuralVariantKey, underwritingMode, optional `migrationsFromClient`).
- **Web consumers:** none in `apps/web` today; the Excel workbook is the consumer.
- **Coupling:** Excel workbook expects a stable shape governed by `RENDER_CONTRACT_VERSION` (four-axis index). The contract version axis is already in place — backwards-compatible additions migrate via `migrationsFromClient`.
- **Cutover classification:** **STRICT_DISPATCH_REQUIRED**
- **Rationale:** The handler currently calls `store.getAnalysis(dealId)` then `adaptAnalysisToAdjustedInputs(analysis)` and `hydrateUnderwritingContext({analysis, adjustedInputs, mode})`. Post-cutover, graph-backed `dealId`s must skip the legacy `Analysis` adapter entirely and source directly from the `HydratedRecordGraph` (`bundle → resolver(mode) → context`). Legacy ids continue down the existing path. Same response shape, two retrieval paths.
- **Implementation notes:**
  - The render layer's permitted dependencies (§4.1 D2) means the route is the integration point — it composes the resolver output and feeds `buildRenderPayload`.
  - `composeRenderPayloadFromQuery` is shared by both `/render` and `/export`; the dispatch needs to live there (single call site) and be exercised by both endpoints.

### R20 — GET /api/underwriting/export  (CRITICAL Excel export)
- **Handler:** `apps/api/src/routes/render.routes.ts:389`
- **Method + path:** `GET /api/underwriting/export?dealId=<id>&assetClass=<...>&underwritingMode=<...>&profile=bank|bp_spire&templateType=<...>&structuralVariantKey=<...>`
- **Response shape:** binary `.xlsx`; response headers: `X-Render-Contract-Version`, `X-Structural-Variant-Key`, `X-Underwriting-Mode`, `X-Export-Profile`, `X-Template-Type`, `X-Template-Version`, `X-Render-Bindings-Written`, `X-Render-Bindings-Unresolved`.
- **Web consumers:** `apps/web/src/app/analysis/[id]/page.tsx:164,177` (Bank + BP Spire export buttons).
- **Coupling:** caller treats response as `Blob` and saves to disk; only depends on binary stream + Content-Type. No structural coupling to JSON.
- **Cutover classification:** **STRICT_DISPATCH_REQUIRED**
- **Rationale:** Same dispatch as R19 (shares `composeRenderPayloadFromQuery`). Same `RenderPayload` produced; same template applied. Once R19 dispatches correctly, R20 follows for free.
- **Implementation notes:** The dispatch decision is made inside `composeRenderPayloadFromQuery` and is invisible to the export pipeline.

### R21 — GET /api/underwriting/render-config
- **Handler:** `apps/api/src/routes/render.routes.ts:544`
- **Response shape:** `{ contractVersion, assetClassVariantModeTabs, variantsByAssetClass, assetClassVariantDefaults, modesByAssetClassVariant, addressesByAssetClassVariantMode, managedNamespaceByAssetClassVariantMode, migrationsFromClient? }`.
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Deal-agnostic; reads the static schema registry. Not affected by spine cutover — same response regardless of any analysis id.

### R22 — GET /api/underwriting/render-migrations
- **Handler:** `apps/api/src/routes/render.routes.ts:627`
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Tooling/CI endpoint; deal-agnostic.

### R23 — GET /api/underwriting/migration-readiness
- **Handler:** `apps/api/src/routes/render.routes.ts:663`
- **Cutover classification:** ADDITIVE_SAFE
- **Rationale:** Reads the observability log table. The log is keyed by `(analysisId, contractVersion, ...)`; either spine writes to the same observability table → same readout.

## Strict-dispatch feasibility

### Id format conventions observed
- Legacy ids: `uuid()` v4 (verified at `apps/api/src/routes/analysis.routes.ts:96` and `474, 482, 483` of `sqlite-store.ts`). Format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
- Graph-backed ids (planned per doctrine §2.2 H4 + §2.2 H6): content-hash-addressed `DoctrineEvaluationId`. Format: hex digest (e.g. `de_<hash>` or similar prefix-tagged hex). Final shape is a Batch 6 design choice but doctrine pins them as content-hash, not random.
- These two formats are trivially distinguishable by regex/length and prefix. **Strict dispatch by id format is feasible without ambiguity.**

### Routes that need internal dispatch (single endpoint, two underlying code paths)
- R6 GET /analyses/:id  — full detail
- R7 GET /analyses/:id/status
- R8 DELETE /analyses/:id (tombstone semantics differ for graph-backed)
- R11 POST /analyses/:id/stress-test (semantics shift — see R11 rationale)
- R12–R15 comments (sidecar; could share a single store)
- R16, R17 populated-template (graph-backed → 404/410)
- R18 audit
- R19 GET /underwriting/render  — composeRenderPayloadFromQuery is the single dispatch point
- R20 GET /underwriting/export — inherits R19's dispatch via composeRenderPayloadFromQuery

The natural choke point: `composeRenderPayloadFromQuery` for R19/R20, and a thin `getAnalysisById(id)` adapter (or `dispatchById<T>(id, legacyHandler, graphHandler)`) for R6–R8 and friends.

### Routes that are clean to bifurcate at routing layer
- R1 POST /analyses (write path) — single feature flag, not per-id (id is being minted).
- R21–R23 render-config / render-migrations / migration-readiness — deal-agnostic; no dispatch.
- R2, R4, R5 listing endpoints — union, no per-id dispatch in the response builder.

### Open questions / risks
1. **Mutation endpoints (R9, R10):** the doctrine forbids in-place mutation on graph-backed analyses. We currently lack a "scenario" model that creates a derived analysis. Without that, R9/R10 are 409 for graph-backed ids — meaning the `/analysis/[id]/page.tsx` "edit cap rate" / "edit loan terms" UI will not work for graph-backed analyses post-cutover. **Decision needed before Batch 6 lands UI.**
2. **R11 stress-test semantics:** is "run a one-off custom stress scenario" supported on graph-backed ids? Doctrine implies no (would create a new `StressOutputs` record id). Treat as an open scoping question.
3. **R20 export with graph-backed ids and profile=bank vs bp_spire:** the existing `profile` param is currently a label-only differentiator (filename + header), since both paths share `composeRenderPayloadFromQuery`. Confirm the new spine continues that — no profile-driven branching in the resolver.
4. **R6 adapter purity:** the legacy → `Analysis`-shape projection from a `HydratedRecordGraph` must follow resolver semantics (R3 in §3.2 — pick / rename / re-key / mode-projection / deterministic order only). Any null-coercion added "for compatibility" with the legacy shape is a doctrine violation. The `Analysis` type tolerates `null` (e.g. `dscr: number | null`) so this should be feasible without coercion, but PR review must enforce it.
5. **Mixed-spine compare (R3):** currently no support; needs explicit error case.
6. **Cache hit short-circuit at R1:** the `consistency-engine.service` cache currently round-trips through `store.getAnalysis()`. Post-cutover the cache must record graph-backed ids too — otherwise a hash that matches an old legacy id would short-circuit incorrectly to a legacy analysis. Cache needs an explicit "spine" tag added or a per-spine namespace.

## Recommendations

### Routes requiring versioning before cutover
- **R9** PATCH `/api/analyses/:id/uw-model` — needs a `/v2/analyses/:id/scenarios` (creates derived analysis) before this endpoint can serve graph-backed ids. Until v2 lands, return 409 `MUTATION_NOT_SUPPORTED_ON_GRAPH_BACKED_ANALYSIS` for graph-backed ids.
- **R10** PATCH `/api/analyses/:id/loan-terms` — same.

### Routes safe under strict dispatch as-is (no shape change required)
- R6 GET `/api/analyses/:id` (single endpoint, two retrieval paths; adapter from graph → `Analysis` shape lives at the route)
- R7 GET `/api/analyses/:id/status`
- R8 DELETE `/api/analyses/:id` (tombstone for graph-backed)
- R11 POST `/api/analyses/:id/stress-test` (subject to semantic review — see open question 2)
- R12–R15 comment routes (sidecar; trivial dispatch)
- R16 / R17 populated-template (graph-backed returns 404/410)
- R18 GET `/api/analyses/:id/audit`
- R19 GET `/api/underwriting/render` (dispatch at `composeRenderPayloadFromQuery`)
- R20 GET `/api/underwriting/export` (inherits R19 dispatch)

### Routes safe with additive shape changes (both spines return the same shape; new optional fields can be added)
- R1 POST `/api/analyses` (write-path feature flag, not per-id)
- R2 GET `/api/analyses` (list union)
- R3 GET `/api/analyses/compare` (per-id dispatch, mixed-spine 409)
- R4 GET `/api/analyses/audit-log`
- R5 GET `/api/analyses/model-versions`
- R21 GET `/api/underwriting/render-config`
- R22 GET `/api/underwriting/render-migrations`
- R23 GET `/api/underwriting/migration-readiness`

### Open decisions for the user
1. **Scenario / "derived analysis" endpoint design**: what does the v2 replacement for R9/R10 look like? Same route shape with append-only semantics, or a brand-new `/v2/analyses/:id/scenarios`?
2. **R11 stress-test on graph-backed analyses**: read-only (return the canonical `StressOutputs`)? Or accept new scenarios → mint a new derived analysis (needs the v2 path from #1)?
3. **Web UI cutover for R9/R10**: the `apps/web/src/app/analysis/[id]/page.tsx` cap-rate / loan-terms editors must be hidden or rerouted for graph-backed analyses. Choose: hide editors entirely on graph-backed → read-only view, OR wire to the v2 scenario endpoint when it ships.
4. **DoctrineEvaluationId format**: choose a content-hash id format that is unambiguously distinguishable from uuid v4 (e.g. prefix `de_` + 32-char hex) to make dispatch trivial. Locks in §2.2 H4 / H6.
5. **Consistency cache namespace**: confirm the input-hash cache will be partitioned per-spine post-cutover.
6. **Mixed-spine compare (R3)**: does cross-spine comparison need to work eventually, or is it permanently 409?

## Cutover classification summary

- STRICT_DISPATCH_REQUIRED: 14 routes (R1, R3, R6, R7, R8, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20) → 15 actually; R1 is the write-path variant. Effectively: 14 read/sidecar/render dispatch, 1 write-path dispatch.
- ADDITIVE_SAFE: 6 routes (R2, R4, R5, R21, R22, R23).
- VERSIONING_REQUIRED: 2 routes (R9, R10).
- OUT_OF_SCOPE: 54 routes (R24–R77).

Total inventoried: 77 routes across 7 files. In-scope for Batch 6 cutover: 23 routes.
