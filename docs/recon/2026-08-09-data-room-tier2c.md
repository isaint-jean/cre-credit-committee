# Data Room Tier 2(c) — per-slot extraction display: recon + plan

**Date:** 2026-08-09
**Status:** PLAN + BUILT (rent_roll first cut). pca/asr/appraisal follow the same pattern.

Expose the RICH per-slot extraction the render layer hides — rent-roll tenants (richest), appraisal
detail, pca/asr — via a boundary-honoring display DTO. Credit-free (pure read of ingest-time extraction).

## 1. The boundary permits this — via a display DTO
`hydrated-record-graph.ts:14`: *"`extractionResult` is included for narrative/audit **display only** …
Producers downstream MUST NOT read it."* A **display read is allowed by design**; only *producer* stages
are barred. Safe pattern (used by buyer-diff + intake-completeness): read the graph chain → **project to a
small typed DTO** → return the DTO, never the raw `ExtractionResult`. **Do NOT widen `RenderedAnalysis`.**

## 2. Accessor
`resolveAnalysisForRead(id, recordGraphStore, store)` → `stored.graphRevisionId` → `getRevisionEnvelope`
→ `getDoctrineEvaluation` → `doctrine.rentRollId ? getRentRoll(rentRollId) : null`. Null-safe (buyer-diff
pattern); `null` → "not extracted" (not an error). Endpoint: `GET /analyses/:id/slot-extraction/:docType`
(reuses `enforceAnalysisParam` deal-access gate; matches `/:id/buyer-diff`).

## 3. Per-docType projection + reachability
| docType | DTO | Reachability | Volume |
|---|---|---|---|
| **rent_roll ⭐** | summary {totalUnits, occupiedUnits, occupancyPct} + units[] {label, status, leaseStart/End, inPlaceRent(+period), marketRent, detail (sqft or bed/bath), leaseType} | RICHEST, deterministic; Sunroad ~10 units | **needs bounding — paginate 50** (MF → 1000s) |
| pca | repairs + capexSchedule[] + narratives | present | bounded (~12 yrs) |
| asr | NOI/value + sources&uses + cash flows | present | small |
| appraisal | value card + proforma | HIGH value but **often null** (template-dependent; Sunroad's is null) | small |
| cf/t12 | — | already done (Tier 2b) | — |

RentRoll node (`rent-roll.ts:154`) = `{ id, asOfDate, propertyName, source, lines[] }` — **no cached
summary** (compute from lines). Lines are a discriminated union: `tenant` (annual rent) | `unit` (monthly).

## 4. Build (this arc)
- `SlotExtraction` DTO (`@cre/contracts`), rent_roll variant.
- `projectRentRoll(rentRoll, offset, limit)` — pure projection → summary + paginated units + totalCount.
- `GET /analyses/:id/slot-extraction/:docType` (rent_roll branch; others → 501 not-implemented for now).
- `RentRollTable` component (summary header + rows + Prev/Next at 50), wired to a "Tenants" affordance on
  rent-roll file rows in the tree.

## 5. Honest flags
- **Credit-free** — pure read of ingest-time extraction; no LLM; works with credits exhausted.
- **Appraisal is the weak link** — extraction frequently null even when the doc exists → don't build first.
- **Rent-roll volume** — the one needing pagination (50/page).
- **Boundary honored** — DTO projection only; raw ExtractionResult stays internal; RenderedAnalysis not widened.

## 6. Sequence: rent_roll (this) → pca → asr → appraisal.
