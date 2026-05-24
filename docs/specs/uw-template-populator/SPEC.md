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
- **v2 — 2026-05-24 (this revision).** Two days of bucket recon (Buckets 1, 2, 3, 6 covered; 4 and 5 deferred) revealed that the 6-bucket framing groups cells by underwriting concept when the more decision-relevant grouping is by work-shape. Reclassified into a four-type taxonomy (X / Y / Z / D) plus a separate "Mapped (with quality notes)" non-gap category. Original 6-bucket framing preserved as a cross-reference index (§8).

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

---

## 4. Type X gap cells (grouped by source extractor)

Each group is a candidate single-ticket scope. The extractor exists; the work is wiring or contract widening.

### 4.1 Group: `uw-intelligence.service.ts:505-510` extractor — sub-flag `'repoint'`

The codebase has an AI extractor that pulls structured loan terms from spreadsheets — but it runs against **historical UW workbooks for the institutional-memory system**, not against the current deal's seller UW exhibit. Repointing it at current-deal inputs would unlock:

| Cell (registry id) | Field | Notes |
|---|---|---|
| J12 | Recourse Y/N | `HistoricalUWStructure.recourse: boolean \| null` already in the type system. Repoint extractor at current-deal seller UW. |

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
| C12 | Cutoff Date |
| J11 | Release Provisions Y/N |
| J13 | Cross-Collateralized Y/N |
| J14 | Lockbox Type (Hard/Soft/Springing) |
| K14 | CF Sweep Trigger |
| J16 | ARD Y/N (+ date if Y) |
| J19 | Sub Debt flag |
| C22 | Control Pari status |
| D22 | Trust Pari Balance |
| E23 | Controlling Party |

**Bucket 2 cells (Sources & Uses):**

Per recon, the S&U data is in loan documents and/or a sources-and-uses exhibit (sometimes a distinct attachment). Tracked separately in [#35 item 10](https://github.com/isaint-jean/cre-credit-committee/issues/35) as engine work that unlocks handbook principle P-II-3 (cash-out test).

| Cell (registry id) | Field |
|---|---|
| F27 | Senior Loan (Sources) |
| F28 | Cash to Borrower |
| F29 | Escrow / Reserves |
| F30 | Closing Costs |
| K27 | Loan Purpose |
| K28 | Date Acquired |
| K29 | Purchase Price |
| K30 | Total Cost Basis |

**Bucket 6 cells (Property Detail conditional fields):**

| Cell (registry id) | Field |
|---|---|
| H13 | Ground Lease Subordinate (conditional on H12 = Y; NAP otherwise) |
| H14 | Ground Lease Expiration Date (conditional) |
| H15 | Ground Lease Options (conditional) |
| H16 | GL Rent Steps (conditional) |

### 5.2 `document_type: 'appraisal'`

The data is in appraisal narratives + appraisal operating-statement projections. Currently no extractor for appraisal documents beyond `{valueConclusion, capRate, methodology}` (see `@cre/contracts.AppraisalExtraction`).

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

**Bucket 4 cells — PROVISIONAL (see §9):** All ~13 appraisal operating-statement line-item cells provisionally assigned `document_type: 'appraisal'`. Joint scoping with the Bucket 6 appraisal cells is plausible because both unlock from the same extractor.

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

### 6.2 `blocked_on: 'external_cmbs_database_integration'`

**Bucket 5 cells — PROVISIONAL (see §9):** All 4 prior-CMBS-history cells provisionally assigned this blocker. Requires integration with an external CMBS data source (Trepp / Intex / rating-agency presale lookups).

| Cell (registry id) | Field |
|---|---|
| C18 (Conclusions & Escrows) | Prior CMBS Deal/Status |
| E18 (Conclusions & Escrows) | Prior CMBS Balance Before Disposition |
| C19 (Conclusions & Escrows) | Prior CMBS Trough NCF Year |
| D19 (Conclusions & Escrows) | Prior CMBS Trough NCF Amount |

---

## 7. Type D derived cells (grouped by source_fields)

Cells that could be computed from already-extracted fields. Each requires a soundness review of the derivation rule before being treated as "free."

### 7.1 `source_fields: ['ownershipInterest']`, soundness `'risky'`

| Cell (registry id) | Field | Derivation rule | Risk |
|---|---|---|---|
| H12 (Property Detail - Comm) | Ground Lease (Y/N) | `Y` if `ownershipInterest !== 'Fee Simple'`, else `N` | **Risky.** Conflates ownership structure with ground-lease presence. A leasehold position implies ground lease, but a fee simple property can ALSO have a ground lease (where the borrower is the landlord on a ground lease they granted to another party). "Fee + Leasehold" is ambiguous. Alternative: classify as Type X (`'surface'`, direct extraction with null-on-absence). The choice is a design call for the eventual ticket — both classifications are listed deliberately. |

---

## 8. Original 6-bucket cross-reference

Mapping the old concept-bucket framing to the new taxonomy. Anyone holding the v1 mental model can find their way to the v2 classifications.

| v1 bucket | Cell count (v3) | v2 classifications |
|---|---:|---|
| Bucket 1 — Loan structural/legal terms | 11 | 2 Mapped (D12, D13) + 1 Type X repoint (J12 Recourse) + 8 Type Y loan_docs (C12 Cutoff, J11 Release, J13 Cross-Collat, J14 Lockbox, K14 CF Sweep, J16 ARD, J19 Sub Debt, C22 Control Pari, D22 Trust Pari) |
| Bucket 2 — Sources & Uses | 8 | 8 Type Y loan_docs (F27 Senior Loan, F28 Cash to Borrower, F29 Escrow, F30 Closing Costs, K27 Loan Purpose, K28 Date Acquired, K29 Purchase Price, K30 Total Cost Basis) |
| Bucket 3 — Multi-period historicals | 36 (gap only) | ~36 Type Z product_decision_on_required_uploads (cols B/D/F multi-year actuals). v3's 36-cell count referred only to the gap portion; the same sheet has ~18 additional Mapped cells (col H T-12 + col L UW year-1) that were already counted as mapped in v3 §"what_IS_well_mapped" and are listed in §3.2 of this spec. |
| Bucket 4 — Appraisal operating-statement line items | 13 | **PROVISIONAL** Type Y appraisal (see §9) |
| Bucket 5 — Prior CMBS history | 4 | **PROVISIONAL** Type Z external_cmbs_database_integration (see §9) |
| Bucket 6 — Property Detail physical specs | 13 | 2 Type X surface (C12 Stories, C11 Buildings) + 1 Type X/D dual (H12 Ground Lease) + 8 Type Y appraisal (H3 Subtype, L3 Surface Parking, L4 Covered Parking, G7 Zoning Code, H7 Zoning Desc, L11 Land Area, C13 Outparcels, C14 Clear Height) + 4 Type Y loan_docs (H13 GL Subordinate, H14 GL Expiration, H15 GL Options, H16 GL Rent Steps) |

**Net taxonomy counts** (Buckets 1, 2, 3, 6 — recon'd):
- Mapped cells: ~20 (Bucket 1 ×2 + Bucket 3 col H ×9 + Bucket 3 col L ×9)
- Type X cells: ~4 (1 from Bucket 1 repoint + 2 from Bucket 6 surface + 1 dual)
- Type Y cells: ~28 (8 Bucket 1 loan_docs + 8 Bucket 2 loan_docs + 4 Bucket 6 loan_docs + 8 Bucket 6 appraisal)
- Type Z cells: ~36 (Bucket 3 cols B/D/F)
- Type D cells: 1 (Bucket 6 Ground Lease — dual classification with Type X)

(Cell counts may differ by ±1-2 from registry totals due to v1/v2 boundary differences; the registry is source of truth for the per-cell list.)

---

## 9. PROVISIONAL classifications — pending Piece 3 recon

The following classifications have **NOT been verified against the codebase**. They are inferred from the v3 gap report and may change after Piece 3 recon.

### 9.1 Bucket 4 — Appraisal operating-statement line items (13 cells, PROVISIONAL)

Provisionally **Type Y, `document_type: 'appraisal'`**. Rationale: the appraisal extraction today carries only `{valueConclusion, capRate, methodology}`; the line-item operating-statement projections (Real Estate Taxes per appraisal, Insurance per appraisal, and the appraisal column in Operating History) require widening the appraisal extractor's output. Same `document_type` as most Bucket 6 cells — suggests a joint appraisal extractor ticket would unlock both.

Affected cells include (from v3 registry):
- `D47 (Conclusions & Escrows)` — Real Estate Taxes per Appraisal
- `D48 (Conclusions & Escrows)` — Insurance per Appraisal
- All Operating History col J line-item rows: J9, J11, J14, J15, J22, J24, J25, J26, J30, J31, J32

### 9.2 Bucket 5 — Prior CMBS history (4 cells, PROVISIONAL)

Provisionally **Type Z, `blocked_on: 'external_cmbs_database_integration'`** (see §6.2 for the cell list and reasoning). Requires a CMBS data-source integration that doesn't exist today.

---

## 10. Next steps

1. **Piece 3 recon (next session):** Focused recon on Buckets 4 and 5 to verify or revise their provisional classifications. Specifically:
   - Confirm `AppraisalExtraction` shape and rule out hidden line-item extraction (Bucket 4).
   - Search for any latent CMBS-database integration or prior-loan history extraction (Bucket 5).
   - If Bucket 4 verifies as Type Y appraisal, decide whether to scope a joint appraisal extractor ticket with the Bucket 6 appraisal cells.
2. **First implementation ticket decision:** PENDING Piece 3 completion. Once all six buckets are classified, the decision becomes "pick one Type X group or one Type Y document_type group" — both well-scoped single-ticket candidates.
3. **Product decisions to surface** (not engineering scope):
   - Whether to add an audited-statements upload slot for Bucket 3 prior-year columns (Type Z resolution).
   - Whether to integrate an external CMBS database for Bucket 5 (Type Z resolution).
   - Whether to add loan_docs as a required upload slot (unlocks ~18 Type Y cells across Buckets 1, 2, 6).
4. **Open architectural questions** carried forward from the recon:
   - The hidden-period-assumption in Operating History col H (Mapped today, but the populator can't tell whether the source data is T-12 actuals or a forecast).
   - The conflation of D12 Current Balance and D13 Original Balance via shared `uwModel.loanAmount` — clean fix is a separate `currentBalance` field on the loan terms record.
   - The Type X / Type D choice for H12 Ground Lease.

---

## Cross-references

- Tracking ticket: [#41 — UW Template Populator — deferred pending extraction coverage](https://github.com/isaint-jean/cre-credit-committee/issues/41)
- Related: [#35 — Handbook: surface upstream data fields required by inert deterministic checks](https://github.com/isaint-jean/cre-credit-committee/issues/35) (Bucket 2 / S&U tracked as item 10)
- Related: [#38 — Extract per-period pro-forma arrays from seller UW models](https://github.com/isaint-jean/cre-credit-committee/issues/38) (Bucket 3 / multi-period)
- Related: [#39 — Promote PropertyMetadata to spine record with FK to ExtractionResult](https://github.com/isaint-jean/cre-credit-committee/issues/39) (Type X surface candidates in Bucket 6)
- Sibling target registry in code: `apps/api/src/services/field-authority.registry.ts` (1563 lines, ~80 cells declared against future-state UnderwritingContext shape)
