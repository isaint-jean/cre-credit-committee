# UW Template Populator — Specification

**Status:** Deferred pending extraction coverage. Tracking ticket: [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41).

**Artifacts in this directory:**
- `Blank_UW_Template_v2.xlsm` — cleaned canonical template (Eightfold-scrubbed, fidelity preserved).
- `uw-template-registry-v3.json` — input-cell registry with source mapping (~34 mappable / ~79 missing / ~5 derived in v3 framing).
- `SPEC.md` — this document.

---

## Revision history

- **v1 — 2026-05-23 (initial deferral, filed via #41).** Six concept-buckets of "missing" Tier A cells:
  1. Loan structural/legal terms (11 cells)
  2. Sources & Uses (8 cells)
  3. Multi-period historicals (36 cells)
  4. Appraisal operating-statement line items (13 cells)
  5. Prior CMBS history (4 cells)
  6. Property Detail physical specs (13 cells)
- **v2 — 2026-05-24.** Two days of bucket recon (Buckets 1, 2, 3, 6 covered; 4 and 5 deferred) revealed that the 6-bucket framing groups cells by underwriting concept when the more decision-relevant grouping is by work-shape. Reclassified into a four-type taxonomy (X / Y / Z / D) plus a separate "Mapped (with quality notes)" non-gap category. Original 6-bucket framing preserved as a cross-reference index (§8).
- **v3 — 2026-05-25.** Added Tier B judgment workstream stub (now §10) and analysis page upgrade stub (now §11). Reframed the v2 X/Y/Z/D taxonomy as explicitly Tier A-scoped — it was implicitly already, but not stated (see §2.5 for the scope note; §8 cross-reference table updated to note Tier A scope). No Tier A reclassifications.
- **v4 — 2026-05-26 (this revision).** Piece 3 recon completed. Bucket 4 PROVISIONAL CONFIRMED as Type Y appraisal, with ghost-contract finding: `AppraisalExtraction` exists at `packages/contracts/src/extraction.ts:108-114` with 3 fields but has no producer today (always null in production), so a future appraisal-extractor workstream builds from zero. Bucket 5 PROVISIONAL PARTIALLY REVISED — split across Type Z `external_cmbs_database_integration` (3 cells: C18 composite, C19, D19), Type Z `product_decision_on_required_uploads` (1 cell: E18 — static historical number, needs prior-loan-doc upload, not external database), and Mapped partial (C18 deal-code portion already extracted today by `extractComparablesLinkageRefs`; see §3.4). The previous §9 PROVISIONAL section is REMOVED; subsequent sections renumbered (§10 Next steps → §9; §11 Tier B stub → §10; §12 Analysis page stub → §11). Added an extractor-surface-sweep candidate to Next steps (now §9 item 5) based on the recon meta-finding: "extractor exists but narrowly applied / unfilled" surfaced three times across the three recon cycles.

---

## 1. Background

Originally scoped as a multi-week Milestone 1 feature: take a blank UW Excel template + uploaded documents (ASR, rent roll, cash flow, asset class) → populate the template via extraction + judgment → output a working live financial model with formulas intact.

Source-mapping recon (v3 registry) revealed that only ~34 of ~119 Tier A cells (~30%) have actual sources in today's codebase. Shipping a 34-cell populator now would deliver "auto-fill 30% of property facts" — not the "the agency populates the underwriting" vision. The honest sequencing: extraction first, populator second.

This spec catalogs the gap cells by **work shape**, so the next implementation ticket can target one work-shape group cleanly.

---

## 2. Taxonomy (settled)

Four classifications for gap cells, plus a separate non-gap category:

| Type | Definition | Work shape |
|---|---|---|
| **X** — Wire-up against existing extraction | Data is already extracted somewhere in the codebase but not surfaced into the cell's target record. | Wiring + light contract widening + possibly repointing an existing extractor at a different input. Sub-flag: `'repoint'` (extractor exists but runs against wrong input) vs `'surface'` (extractor runs against right input but output not surfaced into target record). |
| **Y** — New extractor against an added upload document | Data reliably exists in a real-world document but we don't currently extract that document type (or don't require its upload). | New sub-record contract + new extractor + upload-flow change. Sub-flag: `document_type` (`'loan_docs'`, `'appraisal'`, `'pca'`, etc.). Cells with the same `document_type` are candidates for joint ticketing. |
| **Z** — Data not reliably in any required-document upload | The data doesn't exist in documents borrowers would reasonably upload. | Requires a **product decision** before any engineering scoping: (1) accept permanent blank, (2) add new required upload, or (3) external data integration. Sub-flag: `blocked_on` (which decision unblocks it). |
| **D** — Derived from other extracted fields | Cell isn't directly extracted but could be computed from one or more other extracted fields. | Requires a **soundness review** of the derivation rule before treatment as "free." Sub-flag: `source_fields` (the fields the derivation reads from) and `soundness` (`'sound'` / `'risky'` / `'unknown'`). |
| **Mapped (with quality notes)** | Cells already producing a value today. | NOT a gap. Carry a note about any known limitation (e.g., shared source field, hidden period assumption). |

---

## 2.5 Scope of the X/Y/Z/D taxonomy

The X/Y/Z/D taxonomy in §2 classifies **Tier A (extraction) cells only**. Tier B (judgment) and Tier C (manual) cells are out of scope for this taxonomy. Tier B has its own workstream — currently a stub at §10 pending dedicated inventory + roadmap design. Tier C cells stay red-highlighted as designed (manual entry by the underwriter); no engineering work is intended for them.

---

## 3. Mapped cells (with quality notes)

Cells already producing a value today. Listed here for completeness; not engineering scope.

### 3.1 Property & Loan Summary

| Cell | Field | Source today | Quality note |
|---|---|---|---|
| D12 | Current Balance | `uwModel.loanAmount` via `template-engine.service.ts:430` | Shares one source with D13 Original Balance. Correct for new originations (current = original); conflated for seasoned loans (where current ≠ original). Architecturally clean fix: separate `currentBalance` field on the loan terms record. |
| D13 | Original Balance | `uwModel.loanAmount` via `template-engine.service.ts:431` | Same as D12. |

### 3.2 Operating History and Pro Forma — single-period columns

| Column | Label | Source today | Quality note |
|---|---|---|---|
| H | T-12 line items | `pipeline.uwModelFromAsr.income/expenses.*` | Single-period extraction, no period label. Works in practice because ASRs typically lead with T-12 actuals, but the extractor doesn't ENFORCE any period and could silently fill col H with forecast data if an ASR led with a forecast. Hidden assumption worth flagging. |
| L | UW year-1 line items | `pipeline.uwModelFromSeller.income/expenses.*` (or the GS U/W column in the seller CF — verify exact path during integration) | Same single-period / no-period-label assumption as col H. Per v3 registry, col L is also classified Tier B (judgment) so the populator may choose to leave it blank for Milestone 1; if it does fill from `uwModelFromSeller`, the underwriter is expected to revise. |
| H6 | Average Physical Occupancy | `PropertyMetadata.occupancyPhysical` | Format conversion: stored as fraction 0..1, Excel may expect percent — verify cell format. |
| H9, H14, H22, H24, H25, H30, H31, H32 | T-12 line-item amounts (GPR, Other Income, G&A, R&M, Utilities, Mgmt, Property Taxes, Insurance) | `pipeline.uwModelFromAsr.<income|expenses>.<field>.annualAmount` | Same hidden-period-assumption caveat as col H header. |

### 3.3 Property identity block

~13 mapped cells covering property identity, sourced from `extract-property-metadata.ts` → `PropertyMetadata`. Field list: `propertyName`, `propertySubtype`, `address`, `city`, `state`, `zip`, `county`, `submarket`, `yearBuilt`, `yearRenovated`, `buildingClass`, `totalSquareFeet` (asset-class dispatch over `totalSquareFeet`/`totalUnits`/`totalRooms`/`totalPads` — only one applies per asset type), `ownershipInterest`. No known quality issues.

PropertyMetadata also carries `msa`, `occupancyPhysical`, `occupancyEconomic`, `numberOfBuildings` — these are populated by the extractor but mapped to different cells (occupancy → Operating History H6/H7 in §3.2; `numberOfBuildings` → C11 classified as Type X in §4.2; `msa` is contract-level but no Property & Loan Summary cell currently consumes it). See `uw-template-registry-v3.json` for the per-cell template addresses.

### 3.4 CMBS deal-code linkage (partial; Bucket 5 cell C18)

`extractComparablesLinkageRefs` in `apps/api/src/services/data-extraction.service.ts:631-661` extracts CMBS deal codes from ASR text via regex (patterns include `BMARK 20\d{2}`, `COMM 20\d{2}`, etc.). Output lands in legacy `ExtractionResult.comparablesLinkageRefs: string[]`. Run today via `extractCoreFields` in the legacy POST.

**Quality note: PARTIAL mapping of C18 Prior CMBS Deal/Status.** Recovers only the deal-code portion (e.g., "COMM 2014-CR19") and only when the ASR cites the prior pool. Sunroad PRELIM doesn't cite its prior pool, so this is empty for Sunroad in practice; for deals where the ASR does cite the prior pool, the deal code populates. The property-name portion ("Bridgepoint Tower" in Sunroad's filled template) and DQ-status portion ("(No DQ)") of C18 are NOT recovered by this extractor — those require external CMBS data. C18 therefore appears in both this Mapped-partial section AND under Type Z `external_cmbs_database_integration` (§6.2), reflecting its irreducibly cross-type composition.

---

## 4. Type X gap cells (grouped by source extractor)

Each group is a candidate single-ticket scope. The extractor exists; the work is wiring or contract widening.

### 4.1 Group: `uw-intelligence.service.ts:505-510` extractor — sub-flag `'repoint'`

The codebase has an AI extractor that pulls structured loan terms from spreadsheets — but it runs against **historical UW workbooks for the institutional-memory system**, not against the current deal's seller UW exhibit. Repointing it at current-deal inputs would unlock:

| Cell (registry id) | Field | Notes |
|---|---|---|
| J12 (Property & Loan Summary) | Recourse Y/N | `HistoricalUWStructure.recourse: boolean \| null` already in the type system. Repoint extractor at current-deal seller UW. |

**Additional fields the same repoint would produce (no current Bucket-1 cell):**
- **Cash Management (Y/N flag).** `HistoricalUWStructure.cashManagement: boolean | null` already in the type system. No Bucket-1 cell currently captures the Y/N flag itself; the lockbox/sweep cells (J14, K14) ask for descriptive labels (Hard/Soft/Springing, sweep-trigger description), which are a different shape from the boolean the extractor produces today. J14 + K14 are classified as Type Y loan_docs (see §5.1) because the descriptive content requires extracting from the loan documents themselves, not from the seller UW spreadsheet.
- **Earn Out.** `HistoricalUWStructure.earnOut: boolean | null` in the type system. No template cell today — flag for future template expansion.
- **Reserves $.** `HistoricalUWStructure.reserves: number | null` in the type system. Reserves data lives in the Conclusions & Escrows tab — currently classified as Tier B judgment per v3 registry; the same repoint would surface a candidate value, but reclassification from Tier B to Tier A is a separate design call.

### 4.2 Group: `extract-property-metadata.ts` extractor — sub-flag `'surface'`

The extractor runs against the right input (ASR text). The contract / prompt needs widening to add the new output fields.

| Cell (registry id) | Field | Notes |
|---|---|---|
| C12 (Property Detail - Comm) | Number of Stories | Recoverable from ASR prose ("11-story, LEED certified class A"). Requires extending `PropertyMetadata` contract + extractor prompt. Yesterday's recon verified the data is in the Sunroad ASR. |
| C11 (Property Detail - Comm) | Number of Buildings | `PropertyMetadata.numberOfBuildings` is **already in the contract** today. The gap is data-availability (ASR doesn't always state an explicit count; in Sunroad it's inferable from singular "the Property" phrasing). Classification flagged: this may be a data-availability issue (closer to Type Y / appraisal) rather than a contract-widening issue. |

### 4.3 Group: shared Type-X/Type-D decision

| Cell | Field | Notes |
|---|---|---|
| H12 (Property Detail - Comm) | Ground Lease (Y/N) | Classifiable as either Type X (`'surface'`, direct ASR extraction with null-on-absence) OR Type D (derive from `ownershipInterest === 'Fee Simple'`). See §7 for the Type D framing; the design choice between these two routes is a call for the eventual ticket. |

---

## 5. Type Y gap cells (grouped by required document_type)

Each `document_type` is a candidate multi-ticket workstream. Cells with the same `document_type` should be jointly scoped because they share the upload-flow extension and likely share an extractor service.

### 5.1 `document_type: 'loan_docs'`

The data is in loan-document attachments (PSA, commitment letter, intercreditor agreement, sources-and-uses exhibit). Currently no upload slot for these in the build-and-ingest flow.

**Bucket 1 cells (loan structural/legal terms):**

| Cell (registry id) | Field |
|---|---|
| C12 (Property & Loan Summary) | Cutoff Date |
| J11 (Property & Loan Summary) | Release Provisions Y/N |
| J13 (Property & Loan Summary) | Cross-Collateralized Y/N |
| J14 (Property & Loan Summary) | Lockbox Type (Hard/Soft/Springing) |
| K14 (Property & Loan Summary) | CF Sweep Trigger |
| J16 (Property & Loan Summary) | ARD Y/N (+ date if Y) |
| J19 (Property & Loan Summary) | Sub Debt flag |
| C22 (Property & Loan Summary) | Control Pari status |
| D22 (Property & Loan Summary) | Trust Pari Balance |
| E23 (Property & Loan Summary) | Controlling Party |

**Bucket 2 cells (Sources & Uses):**

Per recon, the S&U data is in loan documents and/or a sources-and-uses exhibit (sometimes a distinct attachment). Tracked separately in [#35 item 10](https://github.com/isaint-jean/cre-credit-committee/issues/35) as engine work that unlocks handbook principle P-II-3 (cash-out test).

| Cell (registry id) | Field |
|---|---|
| F27 (Property & Loan Summary) | Senior Loan (Sources) |
| F28 (Property & Loan Summary) | Cash to Borrower |
| F29 (Property & Loan Summary) | Escrow / Reserves |
| F30 (Property & Loan Summary) | Closing Costs |
| K27 (Property & Loan Summary) | Loan Purpose |
| K28 (Property & Loan Summary) | Date Acquired |
| K29 (Property & Loan Summary) | Purchase Price |
| K30 (Property & Loan Summary) | Total Cost Basis |

**Bucket 6 cells (Property Detail conditional fields):**

| Cell (registry id) | Field |
|---|---|
| H13 (Property Detail - Comm) | Ground Lease Subordinate (conditional on H12 = Y; NAP otherwise) |
| H14 (Property Detail - Comm) | Ground Lease Expiration Date (conditional) |
| H15 (Property Detail - Comm) | Ground Lease Options (conditional) |
| H16 (Property Detail - Comm) | GL Rent Steps (conditional) |

### 5.2 `document_type: 'appraisal'`

The data is in appraisal narratives + appraisal operating-statement projections. Currently no extractor for appraisal documents.

**Ghost-contract note (Piece 3 finding).** `AppraisalExtraction` exists as a contract slot at `packages/contracts/src/extraction.ts:108-114` with 3 fields (`valueConclusion`, `capRate`, `methodology`) but has **no producer today** — the composer hardcodes `appraisal: null` at `apps/api/src/services/extraction/build-extraction-result.ts:316`. The field is always null in production. A future appraisal-extractor workstream builds from zero, not from a 3-field starting point. (Joint-extractor design observation: the descriptor-shaped Bucket 6 cells and the operating-statement-shaped Bucket 4 cells could plausibly come from the same appraisal document via one workstream producing two sub-records — appraisals carry a structured income/expense projection AND a property-description block as separate sections.)

**Bucket 6 cells (Property Detail physical specs):**

| Cell (registry id) | Field |
|---|---|
| H3 (Property Detail - Comm) | Property Subtype (e.g. CBD/Suburban/Medical) |
| L3 (Property Detail - Comm) | Surface Parking count |
| L4 (Property Detail - Comm) | Covered Parking count |
| G7 (Property Detail - Comm) | Zoning Code (alternative: public records lookup — but that route is Type Z) |
| H7 (Property Detail - Comm) | Zoning Description (same alternative source options as G7) |
| L11 (Property Detail - Comm) | Land Area (acres) |
| C13 (Property Detail - Comm) | Number of Outparcels (retail-specific; NAP for office) |
| C14 (Property Detail - Comm) | Clear Height (ft) — possibly `document_type: 'pca'` instead. Industrial-specific; NAP for office. |

**Bucket 4 cells (Appraisal operating-statement line items):**

| Cell (registry id) | Field |
|---|---|
| D47 (Conclusions & Escrows) | Real Estate Taxes — Per Appraisal |
| D48 (Conclusions & Escrows) | Insurance — Per Appraisal |
| J9 (Operating History) | Potential Gross Rental Income (Appraisal column) |
| J11 (Operating History) | Bad Debt Expense (Appraisal column) |
| J14 (Operating History) | Other Income (Appraisal column) |
| J15 (Operating History) | Expense Reimbursements (Appraisal column) |
| J22 (Operating History) | General and Administrative (Appraisal column) |
| J24 (Operating History) | Repairs and Maintenance (Appraisal column) |
| J25 (Operating History) | Utilities (Appraisal column) |
| J26 (Operating History) | Other Op Ex (Appraisal column) |
| J30 (Operating History) | Management Fee (Appraisal column) |
| J31 (Operating History) | Property Taxes (Appraisal column) |
| J32 (Operating History) | Insurance (Appraisal column) |

---

## 6. Type Z gap cells (grouped by blocked_on decision)

NOT engineering scope. Each entry blocks on a product/architecture decision.

### 6.1 `blocked_on: 'product_decision_on_required_uploads'`

**Bucket 3 cells (multi-period historicals — Operating History cols B/D/F):**

The Sunroad seller CF carries Budget / In-Place / GS U/W (three perspectives on current state), not 3rd Prior / 2nd Prior / 1st Prior year actuals. Per Recon 2 (yesterday): "the source document doesn't carry multi-period data either" — the registry's column-source assumption was incorrect. Recovering these cells requires either:
1. An audited-statements upload slot (new required upload type).
2. Accepting permanent blank for these columns on most deals.
3. PDF-narrative extraction of multi-year trends from ASR prose (speculative).

Approximately **36 cells** affected (Operating History cols B/D/F × ~12 line items + per-period occupancy stats). Detailed cell list in `uw-template-registry-v3.json` under "Operating History and Pro Forma" → `inputs_summary_by_line_item`.

**Bucket 5 cell (added in v4 per Piece 3 split):**

| Cell (registry id) | Field | Notes |
|---|---|---|
| E18 (Conclusions & Escrows) | Prior CMBS Balance Before Disposition | Static historical number, not a performance feed. Would be satisfied by a prior-loan-doc upload slot, NOT external database integration. Per Piece 3: the Sunroad PRELIM ASR mentions "Loan Payoff $65,365,379" in Sources & Uses (the current refi's payoff amount) but not the prior loan's balance-before-disposition. |

### 6.2 `blocked_on: 'external_cmbs_database_integration'`

Requires integration with an external CMBS data source (Trepp / Intex / rating-agency presale lookups).

**Bucket 5 cells:**

| Cell (registry id) | Field | Notes |
|---|---|---|
| C18 (Conclusions & Escrows) | Prior CMBS Deal/Status | **Composite field.** Deal-code portion partially recovered by `extractComparablesLinkageRefs` (see §3.4 Mapped partial). Property-name portion ("Bridgepoint Tower" in Sunroad's filled template) and DQ-status portion ("(No DQ)") require external CMBS data. C18 is irreducibly cross-type — appears in both §3.4 Mapped partial AND here. |
| C19 (Conclusions & Escrows) | Prior CMBS Trough NCF Year | Performance metric — servicer-report data. |
| D19 (Conclusions & Escrows) | Prior CMBS Trough NCF Amount | Performance metric — servicer-report data. |

---

## 7. Type D derived cells (grouped by source_fields)

Cells that could be computed from already-extracted fields. Each requires a soundness review of the derivation rule before being treated as "free."

### 7.1 `source_fields: ['ownershipInterest']`, soundness `'risky'`

| Cell (registry id) | Field | Derivation rule | Risk |
|---|---|---|---|
| H12 (Property Detail - Comm) | Ground Lease (Y/N) | `Y` if `ownershipInterest !== 'Fee Simple'`, else `N` | **Risky.** Conflates ownership structure with ground-lease presence. A leasehold position implies ground lease, but a fee simple property can ALSO have a ground lease (where the borrower is the landlord on a ground lease they granted to another party). "Fee + Leasehold" is ambiguous. Alternative: classify as Type X (`'surface'`, direct extraction with null-on-absence). The choice is a design call for the eventual ticket — both classifications are listed deliberately. |

---

## 8. Original 6-bucket cross-reference

Mapping the old concept-bucket framing to the new taxonomy. Anyone holding the v1 mental model can find their way to the v2 classifications. **Tier A cells only** — Tier B and Tier C cells are not enumerated here (Tier B has its own workstream at §10; Tier C cells are red-highlight manual entry).

| v1 bucket | Cell count (v3) | v2 classifications |
|---|---:|---|
| Bucket 1 — Loan structural/legal terms | 11 | 2 Mapped (D12, D13) + 1 Type X repoint (J12 Recourse) + 8 Type Y loan_docs (C12 Cutoff, J11 Release, J13 Cross-Collat, J14 Lockbox, K14 CF Sweep, J16 ARD, J19 Sub Debt, C22 Control Pari, D22 Trust Pari) |
| Bucket 2 — Sources & Uses | 8 | 8 Type Y loan_docs (F27 Senior Loan, F28 Cash to Borrower, F29 Escrow, F30 Closing Costs, K27 Loan Purpose, K28 Date Acquired, K29 Purchase Price, K30 Total Cost Basis) |
| Bucket 3 — Multi-period historicals | 36 (gap only) | ~36 Type Z product_decision_on_required_uploads (cols B/D/F multi-year actuals). v3's 36-cell count referred only to the gap portion; the same sheet has ~18 additional Mapped cells (col H T-12 + col L UW year-1) that were already counted as mapped in v3 §"what_IS_well_mapped" and are listed in §3.2 of this spec. |
| Bucket 4 — Appraisal operating-statement line items | 13 | 13 Type Y appraisal (see §5.2). `AppraisalExtraction` is a ghost contract — no producer today; future workstream builds from zero (see §5.2 ghost-contract note). |
| Bucket 5 — Prior CMBS history | 4 | 1 Mapped partial (C18 deal-code portion via `extractComparablesLinkageRefs`; see §3.4) + 3 Type Z external_cmbs_database (C18 composite, C19, D19; see §6.2) + 1 Type Z product_decision (E18; see §6.1). **C18 appears in both Mapped partial and Type Z external** because it is irreducibly cross-type (deal-code extractable, property-name + DQ status not). |
| Bucket 6 — Property Detail physical specs | 13 | 2 Type X surface (C12 Stories, C11 Buildings) + 1 Type X/D dual (H12 Ground Lease) + 8 Type Y appraisal (H3 Subtype, L3 Surface Parking, L4 Covered Parking, G7 Zoning Code, H7 Zoning Desc, L11 Land Area, C13 Outparcels, C14 Clear Height) + 4 Type Y loan_docs (H13 GL Subordinate, H14 GL Expiration, H15 GL Options, H16 GL Rent Steps) |

**Net taxonomy counts** (Buckets 1, 2, 3, 4, 5, 6 — all recon'd):
- Mapped cells: ~20–21 (Bucket 1 ×2 + Bucket 3 col H ×9 + Bucket 3 col L ×9 + Bucket 5 C18 partial — counting C18 partial as +1 since it covers only the deal-code portion; not a full mapping).
- Type X cells: ~4 (1 from Bucket 1 repoint + 2 from Bucket 6 surface + 1 dual).
- Type Y cells: ~41 (8 Bucket 1 loan_docs + 8 Bucket 2 loan_docs + 4 Bucket 6 loan_docs + 8 Bucket 6 appraisal + 13 Bucket 4 appraisal).
- Type Z cells: ~40 (36 Bucket 3 cols B/D/F + 3 Bucket 5 external_cmbs + 1 Bucket 5 product_decision).
- Type D cells: 1 (Bucket 6 Ground Lease — dual classification with Type X).

(Cell counts may differ by ±1-2 from registry totals due to v1/v2 boundary differences; the registry is source of truth for the per-cell list. C18 is intentionally counted in both Mapped partial and Type Z external_cmbs — it is irreducibly cross-type.)

---

## 9. Next steps

1. **Piece 3 recon — COMPLETED 2026-05-26.** Confirmed Bucket 4 as Type Y appraisal (with `AppraisalExtraction` ghost-contract finding — see §5.2). Partially revised Bucket 5: split across Type Z external_cmbs (C18 composite, C19, D19; see §6.2), Type Z product_decision (E18; see §6.1), and Mapped partial (C18 deal-code via `extractComparablesLinkageRefs`; see §3.4). The prior §9 PROVISIONAL section was removed in v4; subsequent sections renumbered.
2. **First implementation ticket decision:** PENDING. With all six buckets now classified, the decision becomes "pick one Type X group or one Type Y document_type group" — both well-scoped single-ticket candidates.
3. **Tier B workstream design session:** Inventory Tier B cells in the template and design a judgment-coverage roadmap analogous to the v2 taxonomy for Tier A. See §10 for the stub.
4. **Analysis page upgrade scoping session:** Scope the rebuild of the legacy analysis page (red-flag detection, internet research, credit scoring), including its dependency on Tier B shipping criteria from §10. See §11 for the stub.
5. **Extractor surface sweep:** A targeted sweep of all current extractors (legacy POST extraction services, AI-tier extractors, regex-based extractors) to surface other "extractor exists but narrowly applied / unfilled" patterns. Three instances surfaced across the three recon cycles: `uw-intelligence.service.ts` repoint candidate for loan structural terms, `AppraisalExtraction` ghost contract, `extractComparablesLinkageRefs` narrow regex output. A single sweep would either find 2-3 more Type X recovery candidates or confirm none exist; either way it makes first-ticket selection sharper. Not auto-scheduled; treat as a peer candidate to the other four next steps.
6. **Product decisions to surface** (not engineering scope):
   - Whether to add an audited-statements upload slot for Bucket 3 prior-year columns (Type Z product_decision resolution).
   - Whether to add a prior-loan-doc upload slot for Bucket 5 cell E18 (Type Z product_decision resolution).
   - Whether to integrate an external CMBS database for Bucket 5 cells C18 (composite) / C19 / D19 (Type Z external_cmbs resolution).
   - Whether to add loan_docs as a required upload slot (unlocks ~18 Type Y cells across Buckets 1, 2, 6).
7. **Open architectural questions** carried forward from the recon:
   - The hidden-period-assumption in Operating History col H (Mapped today, but the populator can't tell whether the source data is T-12 actuals or a forecast).
   - The conflation of D12 Current Balance and D13 Original Balance via shared `uwModel.loanAmount` — clean fix is a separate `currentBalance` field on the loan terms record.
   - The Type X / Type D choice for H12 Ground Lease.

---

## 10. Tier B (judgment) workstream — stub

**Definition.** Tier B cells are populated from LLM judgment guided by the handbook. Examples: year-1 pro forma assumptions (Operating History col L), 10-year projections, stress scenarios, concluded values (Conclusions & Escrows tab — concluded cap rate, escrow recommendations, etc.). Yellow-background convention in the populated workbook.

**Status.** No roadmap exists yet. The X/Y/Z/D taxonomy in §2 does NOT classify Tier B cells (per §2.5 — the taxonomy is Tier A-scoped). A separate bucket inventory + taxonomy is needed for Tier B before any engineering scoping.

**Why this matters for the populator.** The populator's value above "extraction transcription tool" depends on Tier B cells being populated AND trustworthy. Shipping the populator with extraction-only coverage (Tier A populated, Tier B blank or red) reduces the deliverable to a workbook generator. Shipping with weak Tier B coverage is worse than blank — plausibly-wrong judgment is harder to detect than missing values.

**Quality dependency on §11.** Tier B output trustworthiness is most naturally surfaced via the analysis page (reasoning traces, doctrine principle invoked, override surface). Populator → analysis page is therefore a quality dependency, not just a parallel feature.

**Next step.** Dedicated session to inventory Tier B cells in the template and design the judgment-coverage roadmap. Not scoped here.

---

## 11. Analysis page upgrade — stub

**Definition.** Rebuild of the legacy analysis page that did red-flag detection, internet research (sponsor / market / news), and credit scoring against the handbook. The legacy version is currently degraded.

**Status.** No spec exists. Legacy code existed but needed significant upgrade per prior sessions.

**Dependency relationship with the populator.**
- **(a)** Shares extraction infrastructure with the populator — both consume the same extraction pipeline outputs (ExtractionResult, PropertyMetadata, RentRoll, UnderwritingModel).
- **(b)** Is the natural surface for displaying Tier B reasoning, which makes its readiness a quality gate for shipping Tier B cells in the populator (per §10).

**Sequencing implication.** Framing the analysis page as a "follow-on" to the populator creates a risk that the populator ships in a state where Tier B values are visible only in the workbook with no reasoning surface. Parallel-track development is the sequencing this spec recommends, with the understanding that this is a **roadmap statement, not a resource commitment** — the user is the only person driving this work and the parallel-track recommendation is open to revision in a later session.

**Next step.** Dedicated session to scope the analysis page rebuild. Not scoped here.

---

## Cross-references

- Tracking ticket: [#41 — UW Template Populator — deferred pending extraction coverage](https://github.com/isaint-jean/cre-credit-committee/issues/41)
- Related: [#35 — Handbook: surface upstream data fields required by inert deterministic checks](https://github.com/isaint-jean/cre-credit-committee/issues/35) (Bucket 2 / S&U tracked as item 10)
- Related: [#38 — Extract per-period pro-forma arrays from seller UW models](https://github.com/isaint-jean/cre-credit-committee/issues/38) (Bucket 3 / multi-period)
- Related: [#39 — Promote PropertyMetadata to spine record with FK to ExtractionResult](https://github.com/isaint-jean/cre-credit-committee/issues/39) (Type X surface candidates in Bucket 6)
- Sibling target registry in code: `apps/api/src/services/field-authority.registry.ts` (1563 lines, ~80 cells declared against future-state UnderwritingContext shape)
