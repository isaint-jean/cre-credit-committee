# Data Room differentiator — Tier 2 (slot-level attribution) recon + plan

**Date:** 2026-08-09
**Status:** PLAN + BUILT (a)+(b). (c) deferred.

Finer than Tier 1 (loan verdict), coarser than Tier 3 (per-file flag attribution): at the slot level,
show (a) a MISSING-DOC flag when a slot is empty (+ what it blocks) and (b) the EXTRACTION pulled from a
slot's docs.

## 1. Missing-doc flags — reachable NOW, two ways
`DQ_CODE_TO_SLOT` (`doctype-taxonomy.ts:280`): JE_RENT_ROLL_MISSING→rent_roll, JE_TRAILING_ACTUALS_MISSING
/JE_IN_PLACE_MISSING→cf, JE_PCA_MISSING→pca, JE_APPRAISAL_MISSING→appraisal. Empty slots two ways:
- **(a) set-difference (cleaner, no engine call):** expected ingest slots `{asr,cf,rent_roll,pca,appraisal}`
  minus what the loan HAS in `data_room_doc`. Pure/instant; works with no underwriting + no credits. The
  source of truth for "what's missing" (engine `dataQuality.flags` = corroboration only). **← BUILT.**
- (b) engine flags: `RenderedAnalysis.dataQuality.flags` (raw `JE_*_MISSING` codes, already in the panel).

**"Blocks what":** intake `blocks` are field-level; a slot→blocks message is derivable (slot → intake
fields whose `sources` include the doc → their `.blocks`), but a **short curated per-slot line reads
cleaner** and is the sanctioned fallback — used here. **Labels** humanized via `docTypeById(slot).label`.

## 2. Per-slot extraction — split by reachability
| Doc-type | Richness | Reachable from what the panel already fetches? |
|---|---|---|
| **cf / t12** | HIGH (income/expense/NOI) | ✅ **NOW** — `RenderedAnalysis.incomeLines[]`/`expenseLines[]`. **← BUILT (b).** |
| rent_roll | RICHEST (tenants) | ❌ behind the ExtractionResult boundary → needs a new per-slot read |
| appraisal / pca / asr | HIGH | ❌ new linkage |
| seller_uw | LOW (3 scalars) | — |
| legal / insurance / … | none | presence-only |

The render layer deliberately doesn't expose raw extraction — tenants/appraisal/pca need **(c)** a new
`GET /analyses/:id/slot-extraction/:docType` + components. cf/t12 income/expense is the exception (already
in the rendered output).

## 3. Build (this arc)
- **(a)** `GET /pools/:poolId/loans/:loanInPoolId/missing-docs` → set-difference empty slots, humanized
  label + curated "blocks what". Surfaced in the Verdict panel. No engine/LLM call.
- **(b)** income/expense/NOI table in the Verdict panel from the already-fetched `RenderedAnalysis`,
  read-only (a compact inline table, not the editable analysis-page component).
- **(c) DEFERRED** — rent-roll tenants / appraisal / pca via a new per-slot extraction read. Second cut.

## 4. Honest flags
- **Raw-extraction boundary:** the richest extraction (rent-roll tenants, appraisal detail) is not in the
  rendered output by design — (c) needs a new read, not just UI.
- **Blocks-what** is curated (grounded in the intake `blocks` semantics); derivation is possible but reads
  noisier.
- Set-difference (a) is the source of truth (no engine dependency); engine flags corroborate.
- (a)+(b) are read-only reuse of data on hand — no engine changes, no new persistence, no credits needed.
