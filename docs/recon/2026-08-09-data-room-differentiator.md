# Data Room differentiator — doc→engine-output recon + tiered plan

**Date:** 2026-08-09
**Status:** PLAN. Tier 1 + 1.5 built (this arc); Tier 2/3 held.

The differentiator: when a buyer opens a data-room document/loan, show what the ENGINE already
extracted/scored/flagged. No other VDR does this.

## 1. The join path (data-room doc → engine output)

```
data_room_doc (pool_id, loan_in_pool_id, doc_type, file_hash, ingest, pinned)
  │  loanInPoolId                                        [soft ref, no FK]
  ▼
loan_in_pool.deal_ref
  │  deal_ref  ⚠ SOFT STRING MATCH — the fragile hop
  ▼
extraction_results.deal_ref → .id
  │  extraction_result_id                                [clean FK]
  ▼
doctrine_evaluations (final_score, rating_band, findings) → .id
  │  doctrine_evaluation_id                              [clean FK]
  ▼
revision_lineage_envelopes.lineage_root_id  = the deal key + analysis id
```

Hops 3–5 are clean FKs. **Hop 2 (loan `deal_ref` → extraction `deal_ref`) is the break point** — the same
`dealRef`-namespace inconsistency as Chunk 3b (pool `bmark2024v8-640-5th-avenue` vs extraction
`SUNROAD-CENTRUM-REAL`). `store.lookupAnalysisByDealRef` resolves it two-pass (exact, then fuzzy
property-name), and `GET /analyses/lookup?dealRef` encapsulates hop 2→5 → returns `analysisId`. Loans that
don't resolve → "no underwriting yet."

## 2. Doc-level vs deal-level — the honest answer

Engine output is architecturally DEAL-LEVEL by design. Three granularities:

| Granularity | Attributable | Real today? |
|---|---|---|
| **Deal-level** | final score, rating band, doctrine red flags, mitigants, narrative, memo, buyer-diff | ✅ clean read paths |
| **Slot / docType** | missing-doc flags map to a slot (`DQ_CODE_TO_SLOT`); rent-roll extraction is a first-class node; doc-type→slot→extraction seam is explicit | ✅ via existing maps |
| **Per-file / per-field** | "this flag came from THIS file", "this cell = row 7" | ❌ aspirational — findings not indexed by source doc; no per-field sourceDoc (only appraisal intra-PDF pageRefs; extraction carries a deal-wide `sourceDocuments[]`) |

Hidden gem: `GET /analyses/:id/intake-completeness` maps 30 fields → which `sourceDoc` sourced each (+
`sourceQuote`, `sourcedBy`) — genuine doc-attribution that exists now.

## 3. Surfaceable now
- Endpoints (keyed by analysis id/lineageRoot, reachable via `/lookup`): `/analyses/:id` (score,
  `doctrine.flags`, `dataQuality.flags`, `mitigations`, `findings`, `narrative`), `/:id/buyer-diff`,
  `/:id/memo`, `/:id/intake-completeness`.
- Components in `RenderedAnalysisView.tsx` (ScoreDonut, Badge, MitigationsSection, FindingsList,
  NarrativeSection) — but INTERNAL (unexported) and `DataQualityFlags` carries a write (click-to-flag).
  Tier 1 therefore renders a compact READ-ONLY panel over the same endpoints/contract (no re-derivation,
  no mutation), rather than importing those internals.

## 4. Tiered plan
- **Tier 1 — deal-level per-loan (built):** expand a loan → score / rating band / red flags / mitigants
  + links. Resolve loan `dealRef` → `/lookup` → `/analyses/:id`. S–M · LOW.
- **Tier 1.5 — intake-completeness (built):** per-field `sourceDoc`/`sourceQuote` map ("this NOI ← this
  T-12"). S · LOW.
- **Tier 2 — slot/docType:** missing-doc flag per empty slot + what was extracted from a slot. M · MED.
- **Tier 3 — per-file attribution:** needs new engine-side provenance (index findings/fields by source
  fileHash/docType). L · HIGH · aspirational.

## 5. Honest flags
- Hop 2 is fuzzy — some loans won't resolve; degrade to "no underwriting yet". Resolution is done
  server-side once (the tree loan node carries a resolved `analysisId | null`).
- Per-file attribution is aspirational; Tiers 1/1.5/2 deliver real value at deal + slot + field-source
  granularity without it.
- Tiers 1/1.5 are read-only reuse of existing endpoints — no engine changes, no new persistence.
