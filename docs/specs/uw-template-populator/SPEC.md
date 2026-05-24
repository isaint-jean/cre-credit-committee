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
- **v4 — 2026-05-26.** Piece 3 recon completed. Bucket 4 PROVISIONAL CONFIRMED as Type Y appraisal, with ghost-contract finding: `AppraisalExtraction` exists at `packages/contracts/src/extraction.ts:108-114` with 3 fields but has no producer today (always null in production), so a future appraisal-extractor workstream builds from zero. Bucket 5 PROVISIONAL PARTIALLY REVISED — split across Type Z `external_cmbs_database_integration` (3 cells: C18 composite, C19, D19), Type Z `product_decision_on_required_uploads` (1 cell: E18 — static historical number, needs prior-loan-doc upload, not external database), and Mapped partial (C18 deal-code portion already extracted today by `extractComparablesLinkageRefs`; see §3.4). The previous §9 PROVISIONAL section is REMOVED; subsequent sections renumbered (§10 Next steps → §9; §11 Tier B stub → §10; §12 Analysis page stub → §11). Added an extractor-surface-sweep candidate to Next steps (now §9 item 5) based on the recon meta-finding: "extractor exists but narrowly applied / unfilled" surfaced three times across the three recon cycles.
- **v5 — 2026-05-30.** D.3 SellerUW triplet back-fill shipped as the first implementation ticket (commit `83328b4` on main). Added `derive` as a third Type X sub-flag for derivations from existing extractor output into separate empty target sub-records — D.3 retroactively classified under it. New §3.5 documents the SellerUW triplet under Mapped cells. New §4.4 reserves the `derive` sub-flag (currently 0 open candidates). §9 item 2 marked COMPLETED with D.3 details; §9 item 7 adds [#42](https://github.com/isaint-jean/cre-credit-committee/issues/42) (T-12 vacancy cascade sign-convention bug) as a carried-forward architectural question. §8 footnote notes D.3 sits outside the original six-bucket cross-reference. New §10 Behavior change log documents the bank-floor activation and EXTRACTION_ENGINE_VERSION bump as production-behavior changes; §10 Tier B stub renumbered to §11 and §11 Analysis page stub renumbered to §12.
- **v6 — 2026-05-31.** Tier B coverage-gap recon completed (Piece 6 in the session sequence; Pieces 1-3 were Tier A bucket recons, Piece 4 was the extractor surface sweep, Piece 5 was the D.3 scoping recon). §11 Tier B promoted from stub to workstream section with cell inventory + gap-pattern analysis: §11.1 coverage table (32 rows mapping every Tier B cell against existing builder infrastructure), §11.2 five gap-pattern categories (surface mismatch / PCA ghost-gated / contract gap / mechanical-or-text-gen / new territory), §11.3 Tier-B-on-Tier-B dependency analysis (cells aren't order-independent the way Tier A line-item-builders are), §11.4 next-step sequencing pointers cross-referenced against §9 candidates. The §11 stub content (Definition / Status / Why it matters / Quality dependency) preserved as the §11.0 preamble with Status + Next step updated to past tense. §9 item 3 updated from "stub" to "recon completed"; §9 item 5 cross-referenced to §11.2 Cat 2 + Cat 3; §9 item 7 gains a new architectural-question bullet about Tier-B-on-Tier-B ordering. Stress Scenario + 10-Yr Pro Forma cells that v3 registry didn't enumerate noted in §11.1 as a documentation gap.
- **v7 — 2026-05-31.** C.2 OperatingStatementExtraction widening shipped (commit `c936008` on main) as the second implementation ticket after D.3. Promotes §11.2 Category 3 from "contract gap (needs widening)" to "(0 OPEN cells; 2 closed in `c936008`)" — L15 Reimbursements and L22 G&A now have contract fields + builders, though populator wiring still gated on [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41). §11.1 coverage table rows for L15 and L22 updated. Three new §10 Behavior change log entries: §10.3 totalOpEx Path B correction (correctness improvement, not behavior change); §10.4 `JUDGMENT_ENGINE_VERSION` 1.1 + manifest workflow; §10.5 three new `JE_*_DEFAULTED` rules activated. §9 item 2 marks C.2 as the second completed implementation ticket; §9 item 7 gains a new bullet for [#43](https://github.com/isaint-jean/cre-credit-committee/issues/43) (P-IV-RET-6 cumulative-cash-flow check dormant — 3/4 inputs still undefined). New §13 Process learnings section (4 subsections) captures meta-insights from C.2 implementation: empirical-verification discipline catches real bugs; judgment-engine manifest workflow as load-bearing invariant; test-sweep scope includes downstream consumers; "small D.3-shape" framings have predictably under-estimated scope.
- **v8 — 2026-06-01 (this revision).** PCA producer scoping session: empirical-verification anchor fixture committed (`apps/api/fixtures/sunroad-centrum-pca.pdf`, commit `431102d` on main, Partner Engineering ASTM E2018-15 report for the Sunroad-Centrum deal, 174 pages, 44MB); `sum_over_term` semantics investigation completed; six contract decisions closed for PCAExtraction Phase 2 widening. New §14 Contract design decisions section captures the six decisions with schemas, rationales, and Sunroad anchor values awaiting the implementation ticket. §14 extends the spec's structural vocabulary (v5 added §10 Behavior change log; v7 added §13 Process learnings; v8 adds §14 Contract design decisions — a backward-looking decision-record section, different from §10's *shipped* behavior changes and §13's forward-looking process guidance). §11.4 item 1 (PCA producer) framing corrected: the v6 "5 cells + C14" claim was empirically wrong — Phase 1 against the current 6-field contract unlocks only 1 cell (G51); Phase 2 widening per §14.1 unlocks the rest; C14 Clear Height carved out (probably belongs under AppraisalExtraction per §5.2 or PropertyMetadata). §9 item 5 cross-references §14 for PCA design-in-progress status. §9 item 7 gains a 7th bullet for the `sum_over_term` JSDoc gap discovered during the v8 investigation (operator doesn't implement scalar-broadcast across `loan_term` despite formula.ts:21 JSDoc; engine-side ticket deferred). §10.4 receives an inline Errata note correcting v7's mistaken claim that `sum_over_term` broadcasts scalars across loan term — v7's original text preserved as historical record; errata makes the correction prominent. No code shipped today; v8 is design-only.

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
| **X** — Wire-up against existing extraction | Data is already extracted somewhere in the codebase but not surfaced into the cell's target record. | Wiring + light contract widening + possibly repointing an existing extractor at a different input. Sub-flag: `'repoint'` (extractor exists but runs against wrong input) vs `'surface'` (extractor runs against right input but output not surfaced into target record) vs `'derive'` (an extractor produces output, and a separate target sub-record exists in the contract but has no producer; a derivation rule projects source-record into target-record without requiring new extraction. Distinct from `'surface'` because the target sub-record is its own contract slot, not just an unwired field on the same record; distinct from `'repoint'` because no extractor needs to run against a different input). |
| **Y** — New extractor against an added upload document | Data reliably exists in a real-world document but we don't currently extract that document type (or don't require its upload). | New sub-record contract + new extractor + upload-flow change. Sub-flag: `document_type` (`'loan_docs'`, `'appraisal'`, `'pca'`, etc.). Cells with the same `document_type` are candidates for joint ticketing. |
| **Z** — Data not reliably in any required-document upload | The data doesn't exist in documents borrowers would reasonably upload. | Requires a **product decision** before any engineering scoping: (1) accept permanent blank, (2) add new required upload, or (3) external data integration. Sub-flag: `blocked_on` (which decision unblocks it). |
| **D** — Derived from other extracted fields | Cell isn't directly extracted but could be computed from one or more other extracted fields. | Requires a **soundness review** of the derivation rule before treatment as "free." Sub-flag: `source_fields` (the fields the derivation reads from) and `soundness` (`'sound'` / `'risky'` / `'unknown'`). |
| **Mapped (with quality notes)** | Cells already producing a value today. | NOT a gap. Carry a note about any known limitation (e.g., shared source field, hidden period assumption). |

---

## 2.5 Scope of the X/Y/Z/D taxonomy

The X/Y/Z/D taxonomy in §2 classifies **Tier A (extraction) cells only**. Tier B (judgment) and Tier C (manual) cells are out of scope for this taxonomy. Tier B has its own workstream at §11 with its own gap-pattern categorization (§11.2). Tier C cells stay red-highlighted as designed (manual entry by the underwriter); no engineering work is intended for them.

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

### 3.5 SellerUWExtraction triplet (derived; shipped in D.3)

`deriveSellerUwTriplet` in `apps/api/src/services/extraction/build-extraction-result.ts` (commit `83328b4`) back-fills the 3-field SellerUW summary triplet from `sellerUwOperatingStatement` (the seller-CF extractor's UW-column output). Runs on every composition where a CF upload with a UW column exists.

Derivation rules:
- `underwrittenNOI`: direct passthrough of `sellerUwOperatingStatement.noi`.
- `underwrittenVacancy`: `|vacancyLoss| / grossPotentialRent`, clamped to `[0, 1]`. `Math.abs` handles the negative-loss sign convention surfaced in the D.3 scoping recon.
- `underwrittenRentGrowth`: always null (not derivable from this source — needs prior-period data the CF doesn't carry).

Returns null when the source is null OR when both derivable fields would be null.

**Quality notes:**
- Field-by-field cascade evaluation means the partial triplet (NOI + vacancy populated, rent-growth null) is fully usable by the source-cascade for vacancy and NOI tiers. The rent-growth consumer (`buildRentGrowthPct`) falls through to the 3% default when null, unchanged from prior behavior.
- `EXTRACTION_ENGINE_VERSION` bumped 1.1 → 1.2 to rotate the extraction id space. See §10.2 for the behavior-change-log entry.
- Classified retroactively as Type X `derive` (see §2 sub-flag definition and §4.4).

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

### 4.4 Group: derived sub-records — sub-flag `'derive'`

Currently **0 open Type X derive candidates.** D.3 (SellerUW triplet back-fill) was the first; shipped in `83328b4` — see §3.5. Future candidates would appear here if recon surfaces additional cases where an extractor's output could project into a separate empty contract sub-record.

The Piece 4 sweep noted two adjacent candidates worth flagging — neither is a `derive` candidate as such:
- **PCAExtraction (ghost contract).** No existing extractor output to derive from. Listed under Type Y in §5 because it requires a new extractor.
- **AppraisalExtraction (ghost contract).** Same shape as PCA; also Type Y in §5.

The `derive` sub-flag is reserved for the specific pattern where source-record and target-record both already exist in the contract; only the projection rule is missing.

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

Mapping the old concept-bucket framing to the new taxonomy. Anyone holding the v1 mental model can find their way to the v2 classifications. **Tier A cells only** — Tier B and Tier C cells are not enumerated here (Tier B has its own workstream at §11; Tier C cells are red-highlight manual entry).

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

**Note (v5):** D.3 (SellerUW triplet back-fill, shipped in `83328b4`) is not represented in this six-bucket cross-reference because it was a Piece 4 extractor-surface-sweep finding, outside the original bucket framing. See §3.5 for the mapped-cells entry and §4.4 for the Type X `derive` sub-flag definition.

---

## 9. Next steps

1. **Piece 3 recon — COMPLETED 2026-05-26.** Confirmed Bucket 4 as Type Y appraisal (with `AppraisalExtraction` ghost-contract finding — see §5.2). Partially revised Bucket 5: split across Type Z external_cmbs (C18 composite, C19, D19; see §6.2), Type Z product_decision (E18; see §6.1), and Mapped partial (C18 deal-code via `extractComparablesLinkageRefs`; see §3.4). The prior §9 PROVISIONAL section was removed in v4; subsequent sections renumbered.
2. **First implementation ticket — COMPLETED `83328b4` (2026-05-29).** D.3 SellerUW triplet back-fill shipped as the first implementation ticket after four sessions of recon (Pieces 1-4 + Piece 5 scoping). New `deriveSellerUwTriplet` helper + composer wire-up + `EXTRACTION_ENGINE_VERSION` bump (1.1 → 1.2) + 5 fixture updates + bank-floor reason text addition. Production-behavior changes documented in §10 Behavior change log.

   **Second implementation ticket — COMPLETED `c936008` (2026-05-31).** C.2 OperatingStatementExtraction widening shipped Phase 1+2 in one ticket per the scope decisions made jointly during morning session (see §13 for process notes on the multi-phase decision). 6 new contract fields + 6 new builders + `EXTRACTION_ENGINE_VERSION` bump (1.2 → 1.3) + `JUDGMENT_ENGINE_VERSION` bump (1.0 → 1.1) + `JUDGMENT_ENGINE_MANIFEST` append + 39 fixture updates + [#43](https://github.com/isaint-jean/cre-credit-committee/issues/43) cross-reference. Production-behavior changes documented in §10 Behavior change log §§10.3-10.5. The implementation-ticket gate from v5 remains open for the next candidate from the list below.
3. **Tier B workstream — coverage-gap recon COMPLETED 2026-05-31.** See §11 for the full inventory + gap-pattern analysis. The §9 candidates intersect with Tier B work; see §11.4 for suggested sequencing. The workstream design is no longer a blocking task — the gap patterns provide the design.
4. **Analysis page upgrade scoping session:** Scope the rebuild of the legacy analysis page (red-flag detection, internet research, credit scoring), including its dependency on Tier B shipping criteria from §11. See §12 for the stub.
5. **Extractor surface sweep:** A targeted sweep of all current extractors (legacy POST extraction services, AI-tier extractors, regex-based extractors) to surface other "extractor exists but narrowly applied / unfilled" patterns. Three instances surfaced across the three recon cycles: `uw-intelligence.service.ts` repoint candidate for loan structural terms, `AppraisalExtraction` ghost contract, `extractComparablesLinkageRefs` narrow regex output. A single sweep would either find 2-3 more Type X recovery candidates or confirm none exist; either way it makes first-ticket selection sharper. Not auto-scheduled; treat as a peer candidate to the other four next steps. **Cross-reference (v6):** the Piece 4 sweep's D.2 PCAExtraction ghost-contract finding maps to Tier B Category 2 in §11.2 (5 cells gated on PCA producer); its C.2 OperatingStatementExtraction narrow-output finding maps to Tier B Category 3 in §11.2 (3 cells gated on contract widening). **Update (v8):** the PCA producer scoping is now in progress — recon completed, anchor fixture committed at `431102d`, and six contract decisions closed in §14.1. Implementation ticket TBD; this candidate is no longer "next candidate, unscoped" — it is "scoped, awaiting implementation."
6. **Product decisions to surface** (not engineering scope):
   - Whether to add an audited-statements upload slot for Bucket 3 prior-year columns (Type Z product_decision resolution).
   - Whether to add a prior-loan-doc upload slot for Bucket 5 cell E18 (Type Z product_decision resolution).
   - Whether to integrate an external CMBS database for Bucket 5 cells C18 (composite) / C19 / D19 (Type Z external_cmbs resolution).
   - Whether to add loan_docs as a required upload slot (unlocks ~18 Type Y cells across Buckets 1, 2, 6).
7. **Open architectural questions** carried forward from the recon:
   - The hidden-period-assumption in Operating History col H (Mapped today, but the populator can't tell whether the source data is T-12 actuals or a forecast).
   - The conflation of D12 Current Balance and D13 Original Balance via shared `uwModel.loanAmount` — clean fix is a separate `currentBalance` field on the loan terms record.
   - The Type X / Type D choice for H12 Ground Lease.
   - **T-12 vacancy cascade sign-convention bug** ([#42](https://github.com/isaint-jean/cre-credit-committee/issues/42), filed during D.3 implementation). The cascade at `source-cascade.ts:55-72` has the same naive `vl/gpr` derivation D.3 handled locally; #42 carries the architectural-question discussion of retroactive vs version-gated fix, `JUDGMENT_ENGINE_VERSION` rotation, and cascade-side vs contract-side fix. Not blocked on anything specific; deferred from D.3's scope per the scope decisions in that brief.
   - **Tier-B-on-Tier-B dependency ordering** (§11.3). I9 Concluded Cap Rate depends on NOI which depends on col L UW values; this is a structural difference from Tier A line-item-builders' order-independence. When Tier B implementation starts, the execution ordering needs deliberate design.
   - **P-IV-RET-6 cumulative-cash-flow check dormant** ([#43](https://github.com/isaint-jean/cre-credit-committee/issues/43), filed during C.2 implementation). C.2 activated 1 of 4 inputs for P-IV-RET-6's deterministic check (`bag['reserves']` from `monthlyReplacementReserves × 12`). The remaining 3 inputs (`capex_projection`, `noi_projection`, `debt_service`) stay `INTENTIONALLY_UNDEFINED`. `debt_service` is derivable today from existing `AdjustedInputs.loan`; `noi_projection` needs extraction; `capex_projection` needs contract-design decision (per-period schedule vs. synthesized array). Activation-risk consideration: P-IV-RET-6 has been silently dormant since handbook engine shipped — full activation may surface previously-invisible Mall scoring deltas.
   - **`sum_over_term` implementation vs JSDoc gap** (discovered during v8 PCA scoping investigation). The handbook engine's `sum_over_term` operator does NOT broadcast scalars across `loan_term` despite `packages/handbook-engine/src/formula.ts:21` JSDoc describing that behavior. The actual implementation dispatches into `evaluateFormulaAsArray` which lifts scalars to length-1 arrays; if all operands in an `op` resolve to length-1 (i.e., all scalars), the target length stays 1 and no period multiplication happens. No `loan_term` field is implemented anywhere in the codebase. Today the gap is masked because P-IV-RET-6 is the sole `sum_over_term` consumer and three of its four operands are `INTENTIONALLY_UNDEFINED`. The gap will surface when other operands populate — `bag['reserves']` (populated as scalar in C.2) currently does nothing observable in P-IV-RET-6's formula precisely because of this. Fix options: (a) implement `loan_term` broadcast and add a `loan_term` field to the field-bag; (b) correct the JSDoc to describe actual array-only semantics; (c) both — implement the broadcast AND keep the JSDoc, making scalars semantically correct. Engine-side ticket; scoping deferred. See §10.4 Errata (v8) for the related v7 record correction.

---

## 10. Behavior change log

Tracks production-behavior changes shipped in implementation tickets so future-readers can trace what changed when. Tickets that change observable behavior (rule emissions, judgment outputs, cell values, content-hash id rotations) should add an entry here as part of their commit.

### 10.1 D.3 — Bank-floor activation (`83328b4`, 2026-05-29)

The judgment engine's vacancy bank-floor at `line-item-builders.ts:127` was dead code before D.3 because `args.extraction.sellerUw` was always null (the ghost contract). D.3's derivation populates `sellerUw` on every deal with a CF upload with a UW column; `adjustWithFloor` now enforces `max(picked, library_median, bankFloor)` actively. On deals where the seller's UW vacancy exceeds picked + library_median, adjusted vacancy will rise to the seller's UW vacancy, and `JE_VACANCY_RAISED_TO_BANK` will emit with attribution text noting the D.3 introduction.

The cascade design clearly anticipated this floor's activation; D.3 delivers the activation. The user-visible note in the rule's reason text is the trace for underwriters who notice the new behavior.

### 10.2 D.3 — EXTRACTION_ENGINE_VERSION bump (`83328b4`, 2026-05-29)

`EXTRACTION_ENGINE_VERSION` bumped from `'1.1'` to `'1.2'`. All newly-built ExtractionResults post-bump have different content-hash ids than pre-bump records for the same source documents. Previously-persisted ExtractionResults retain their pre-bump ids unchanged (they're never rehashed on read). Treat pre-1.2 and post-1.2 extraction outputs as different id spaces.

### 10.3 C.2 — totalOpEx Path B correction (`c936008`, 2026-05-31)

The `buildTotalOperatingExpenses` Path B sub-line sum extended from 5 fields to 7: now sums `[taxes, insurance, utilities, repairsMaintenance, managementFees, generalAndAdmin, janitorial]`. **This is a correctness improvement, not a behavior change.** The previous derivation was under-counting Path B totalOpEx on every deal where G&A or janitorial was populated, because the contract didn't carry those fields. Empirical Sunroad-CF verification: previous Path B sum $2,769,459; corrected sum $3,455,762, exactly matching the source's row 36 "Total Expenses" line.

Reimbursements EXCLUDED from totalOpEx per CMBS source-CF convention: reimbursements is revenue-side (added to EGR upstream of OpEx), not an expense offset. The working assumption during scope-decision walkthrough that reimbursements should subtract from totalOpEx was empirically wrong; the seller's `totalIncome` (= EGR) already includes reimbursements, so OpEx-side subtraction would double-count. `AdjustedExpenses.reimbursements` remains populated for audit-trail and doctrine visibility but does not feed totalOpEx or NOI math.

### 10.4 C.2 — JUDGMENT_ENGINE_VERSION 1.1 + manifest workflow (`c936008`, 2026-05-31)

`JUDGMENT_ENGINE_VERSION` bumped from `'1.0'` to `'1.1'`. `JudgmentEngineVersion` type alias widened to `'1.0' | '1.1'` to satisfy the append-only manifest convention. New manifest entry appended: `'1.1': '8b1289e7c3f07dfa8a78afbec3d80507f9c2d2fe65129acdd6c81242d3e06f67'`. Boot check (`check:judgment-engine`) verifies the hash on api startup.

Discovered architectural invariant: the judgment engine has a rule-registry hash-drift detector. Any rule-registry change MUST be paired with `JUDGMENT_ENGINE_VERSION` bump + manifest entry. Pre-C.2, the brief didn't know about this workflow; CC surfaced it mid-implementation when `check:judgment-engine` failed after adding 3 new rule IDs. See §13 Process learnings for the codification.

> **Errata (v8):** the sentence in v7's assembler commentary that read "The engine's `sum_over_term` broadcasts the scalar across the loan term as a constant annual reserve assumption" is wrong. Per the v8 investigation, `sum_over_term` does NOT broadcast scalars across `loan_term` — the operator dispatches into `evaluateFormulaAsArray` which lifts scalars to length-1 arrays and, when combined with other length-1 operands, produces a single-period sum. The "loan term broadcast" semantic described in `packages/handbook-engine/src/formula.ts:21` JSDoc is intended but not implemented. `bag['reserves']` populated as a scalar in C.2 currently does nothing observable in P-IV-RET-6's formula because no other operand is array-shaped (all three remain `INTENTIONALLY_UNDEFINED`). See §9 item 7 `sum_over_term` bullet for the architectural question (engine ticket deferred).

### 10.5 C.2 — Three new JE_*_DEFAULTED rules activated (`c936008`, 2026-05-31)

Three new judgment-engine rule IDs registered in `packages/contracts/src/judgment-engine-rules.ts`: `JE_REPLACEMENT_RESERVES_DEFAULTED`, `JE_TENANT_IMPROVEMENTS_DEFAULTED`, `JE_LEASING_COMMISSIONS_DEFAULTED`. Each fires when a seller CF lacks the corresponding below-NOI line, defaulting to 0 monthly per the Pattern-3 convention (T-12 + MANUAL default + `JE_<FIELD>_DEFAULTED`).

These rule emissions are now visible in `AdjustedInputs.capitalReserves.*.adjustments` for every deal whose seller CF lacks a below-NOI replacement reserves / tenant improvements / leasing commissions line. On Sunroad these don't fire (the lines are present); on deals where they ARE present but a different upstream field is missing, the emissions surface the absence to doctrine. Pattern matches the existing `JE_OTHER_INCOME_DEFAULTED` / `JE_RENT_GROWTH_DEFAULTED` / `JE_EXPENSE_GROWTH_DEFAULTED` conventions.

---

## 11. Tier B (judgment) workstream

### 11.0 Preamble

**Definition.** Tier B cells are populated from LLM judgment guided by the handbook. Examples: year-1 pro forma assumptions (Operating History col L), 10-year projections, stress scenarios, concluded values (Conclusions & Escrows tab — concluded cap rate, escrow recommendations, etc.). Yellow-background convention in the populated workbook.

**Status.** Coverage-gap recon completed 2026-05-31 (Piece 6). The X/Y/Z/D taxonomy in §2 does NOT classify Tier B cells (per §2.5 — the taxonomy is Tier A-scoped); Tier B uses its own gap-pattern categorization (§11.2) instead.

**Why this matters for the populator.** The populator's value above "extraction transcription tool" depends on Tier B cells being populated AND trustworthy. Shipping the populator with extraction-only coverage (Tier A populated, Tier B blank or red) reduces the deliverable to a workbook generator. Shipping with weak Tier B coverage is worse than blank — plausibly-wrong judgment is harder to detect than missing values.

**Quality dependency on §12.** Tier B output trustworthiness is most naturally surfaced via the analysis page (reasoning traces, doctrine principle invoked, override surface). Populator → analysis page is therefore a quality dependency, not just a parallel feature.

**Next step.** See §11.4 for sequencing recommendations against the §9 candidates.

### 11.1 Coverage table

The Tier B cells in the registry, mapped against existing builder infrastructure (`apps/api/src/services/judgment/line-item-builders.ts`) and doctrine principles (handbook clusters at `packages/handbook-data/src/handbook.json`).

| Cell | Sheet | Label | Has builder? | Builder function | Anchor pattern | Wired to cell? | Doctrine principle | Notes |
|---|---|---|---|---|---|---|---|---|
| I9 | Conclusions & Escrows | Concluded Cap Rate | No | NONE | N/A | No | P-III-9 | "THE MOST CONSEQUENTIAL SINGLE JUDGMENT CELL" per registry. Distinct from `buildCapRate` (going-in) and `buildTerminalCapRate` (exit). No existing builder for concluded cap rate. |
| E47 | Conclusions & Escrows | RE Taxes — Up Front Deposit | No | NONE | N/A | No | NONE clearly applies | Real estate tax reserve at closing. Not in `AdjustedInputs.capitalReserves` block. |
| E48 | Conclusions & Escrows | Insurance — Up Front Deposit | No | NONE | N/A | No | NONE clearly applies | Insurance reserve at closing. Same shape as E47. |
| E49 | Conclusions & Escrows | Replacement Reserves — Up Front | Partial | `buildUpfrontCapex` (line 576) | Pattern 3 (PCAExtraction → default 0) | No | P-III-3, P-IV-OFF-3 | Registry note: $1/SF formula likely; partly mechanical. PCAExtraction is a ghost contract — builder returns 0 today. |
| G49 | Conclusions & Escrows | Replacement Reserves — Annual Escrow | Partial | `buildMonthlyCapex` (line 595) | Pattern 3 | No | P-III-3, P-IV-OFF-3 | Maps to `AdjustedInputs.capitalReserves.monthlyCapex × 12`. PCAExtraction ghost dependency. |
| G51 | Conclusions & Escrows | Immediate Repairs — Annual Escrow | Partial | `buildPcaImmediateRepairs` (line 619) | Pattern 3 (PCAExtraction → null) | No | P-III-3 | PCAExtraction ghost dependency. Sunroad = 0. |
| E54 | Conclusions & Escrows | General TI/LC — Up Front Deposit | Partial | `buildUpfrontTiLc` (line 590) | applicability flag, MANUAL default 0 | No | P-III-3, P-IV-OFF-3 | Builder emits MANUAL default 0 unless applicability=true. Sunroad = $6.17M; dollar requires judgment current builder can't produce. |
| L9 | Operating History | Potential Gross Rental Income (UW year-1) | Yes — different surface | `buildGrossRentalIncome` (line 193) | Pattern 3 (T-12 → rentRoll annualized) | No (populator wires from `pipeline.uwModelFromSeller`) | P-III-2, P-II-2 | **Surface mismatch.** Builder produces judgment-anchored value; populator instead writes the seller's UW from CF extraction. v3 §3.2 notes the underwriter is expected to revise. |
| L14 | Operating History | Other Income (UW year-1) | Yes — different surface | `buildOtherIncome` (line 234) | Pattern 3 + MANUAL default 0 | No (uwModelFromSeller) | P-III-1, P-III-2 | Surface mismatch (same as L9). |
| L15 | Operating History | Expense Reimbursements (UW year-1) | Yes | `buildReimbursements` | Pattern 3 (silent NAP) | No (uwModelFromSeller) | P-III-2 | Builder shipped in C.2 (`c936008`); populator-side wiring deferred. Per the source-CF convention discovered during C.2, reimbursements is revenue-side (added to EGR upstream of OpEx) — see §10.3 for the totalOpEx-exclusion rationale. |
| L22 | Operating History | General and Administrative (UW year-1) | Yes | `buildGeneralAndAdmin` | Pattern 3 (silent NAP) | No (uwModelFromSeller) | P-III-2 | Builder shipped in C.2 (`c936008`); populator-side wiring deferred. |
| L24 | Operating History | Repairs and Maintenance (UW year-1) | Yes — different surface | `buildMaintenance` (line 441) | Pattern 3 default 0 | No (uwModelFromSeller) | P-III-2 | Surface mismatch. |
| L25 | Operating History | Utilities (UW year-1) | Yes — different surface | `buildUtilities` (line 435) | Pattern 3 default 0 | No (uwModelFromSeller) | P-III-2 | Surface mismatch. |
| L30 | Operating History | Management Fee (UW year-1) | Yes — different surface | `buildManagementFee` (line 438) | Pattern 3 default 0 | No (uwModelFromSeller) | P-III-2 | Surface mismatch. Has paired Q30 growth-rate parameter. |
| L31 | Operating History | Property Taxes (UW year-1) | Yes — different surface | `buildRealEstateTaxes` (line 429) | Pattern 3 default 0 | No (uwModelFromSeller) | P-III-2 | Surface mismatch. |
| L32 | Operating History | Insurance (UW year-1) | Yes — different surface | `buildInsurance` (line 432) | Pattern 3 default 0 | No (uwModelFromSeller) | P-III-2 | Surface mismatch. |
| L38 | Operating History | Replacement Reserves (UW year-1) | Partial | `buildMonthlyCapex × 12` (line 595) | Pattern 3 (PCAExtraction → null) | No | P-III-3, P-IV-OFF-3 | Ghost-contract dependency. |
| L39 | Operating History | TI (UW year-1) | Partial | `buildMonthlyTiLc × 12` (line 615) | applicability flag, MANUAL default 0 | No | P-III-3 | Ghost-adjacent + applicability gated. |
| L40 | Operating History | LC (UW year-1) | Partial | `buildMonthlyTiLc × 12` (line 615) | applicability flag, MANUAL default 0 | No | P-III-3 | Same single `monthlyTiLc` field as L39 — TI and LC not split today. |
| R14, R22, R24, R25, R31, R32, R38 | Operating History | UW assumption notes (free-text) | No | NONE | N/A | No | P-III-2 (justification surface) | 7 free-text cells (e.g., "Set to T-12 +3%", "UW to Prop 13"). LLM-generated explanatory prose; no builder produces strings. Registry: "Generated by LLM as part of judgment output, Milestone 2." |
| Q30 | Operating History | Management fee growth rate (3% parameter) | No | NONE | N/A | No | P-III-2 | Per-line-item growth-rate override. `buildExpenseGrowthPct` returns a single 0.03 default; no per-line-item differentiation today. |
| C4, D4, E4 | Stress Scenario | "Tenants Lost" scenario tier identifiers (1/2/3) | No | NONE | N/A | No | P-III-8 | Scenario definitions, not judgment parameters. Marginal Tier B. |
| D62 | Stress Scenario | Refi-stress Amortization Period (360 months) | No | NONE | N/A | No | P-III-10 | Refinance-stress amort assumption used in stressed refi DSCR test. |
| D65 | Stress Scenario | Refi-stress Required DSCR (1.35) | No | NONE | N/A | No | P-III-10, P-III-8, P-III-6 | DSCR threshold for refi-stress test. Deal-level UW assumption (bank's required-refi-DSCR target). |
| E28-M28 (9 cells) | 10 Yr Pro Forma | Expense Growth Rate per year (3% × 9) | Yes | `buildExpenseGrowthPct` (line 756) | MANUAL default 0.03 (JE_EXPENSE_GROWTH_DEFAULTED) | Unknown | P-III-2, P-III-1 | Builder emits a single 0.03 default; whether the populator broadcasts `AdjustedInputs.assumptions.expenseGrowthPct.adjusted` to 9 cells is unverified — needs grep during ticket scoping. |
| E35-M35 (9 cells) | 10 Yr Pro Forma | Other Capital Expenditures per year (0 × 9) | No | NONE | N/A | No | P-III-3 | Discretionary year-by-year capex schedule. Not in `AdjustedInputs.capitalReserves` (which carries monthlyCapex as a single rate, not a year-by-year schedule). |
| E77 | 10 Yr Pro Forma | Critical Tenant Sweep — Months Prior trigger | No | NONE | N/A | No | P-IV-OFF-6 (tentative) | Trigger month before tenant expiration to start sweeping reserves. Tenant-sweep judgment unique to tenant-concentration deals. |

**Table is 27 rows representing ~51 individual cells.** Cells from L38/L39/L40 listed separately; R-column notes grouped as one row (R14, R22, R24, R25, R31, R32, R38); broadcasts E28-M28 and E35-M35 grouped as one row each (9 cells per broadcast); C4/D4/E4 grouped as one row (3 scenario tier identifiers). The table is the working artifact — future Tier B tickets should reference rows by Cell + Sheet and update the "Wired to cell?" column as cells get covered.

**Inventory additions to the v3 registry (documentation gap).** Piece 6 enumerated cells that the v3 registry deferred. To incorporate eventually:
- **Stress Scenario:** C4/D4/E4 (scenario IDs, marginal Tier B), D62 (refi-stress amortization, 360), D65 (refi-stress DSCR threshold, 1.35).
- **10-Yr Pro Forma:** E28-M28 (expense growth broadcast, 9 cells of 0.03), E35-M35 (other capex broadcast, 9 cells of 0), E77 (critical-tenant sweep months prior, 0).

These were not in v3 registry's `inputs[]` arrays for those sheets; the registry should eventually be updated to reflect them. Tracked here as a documentation gap, not blocking Tier B work.

### 11.2 Gap patterns (the five categories)

The 32 cells cluster into five distinct categories of work shape:

**Category 1 — Surface mismatch (8 cells).** Existing builders produce judgment-anchored values; the populator (when it ships) would wire those cells from `pipeline.uwModelFromSeller` (the seller's UW passthrough) instead. Same shape as D.3's `derive` sub-flag — existing capability, narrow application; fix is wiring, not new infrastructure.
Cells: L9, L14, L24, L25, L30, L31, L32, L38 (partial).

**Category 2 — PCAExtraction ghost-contract gated (5 cells).** Builders exist (`buildUpfrontCapex`, `buildMonthlyCapex`, `buildPcaImmediateRepairs`) but read from `PCAExtraction` which is always null in production (Piece 4 sweep finding D.2). Cannot recover via wiring alone; needs PCA producer to ship first. PCA producer would also unlock Bucket 6 cell C14 (Clear Height, industrial-specific).
Cells: E49, G49, G51, L38 (full), E35-M35.

**Category 3 — Contract gap (0 OPEN cells; 2 closed in `c936008`).** Per Piece 4 C.2 finding, `OperatingStatementExtraction` was widened to add G&A, janitorial, reimbursements (expenses) and replacementReserves / tenantImprovements / leasingCommissions (belowNoiAdjustments). L15 Reimbursements and L22 G&A now have contract fields and builders (`buildReimbursements`, `buildGeneralAndAdmin`). Populator wiring (the actual L15/L22 cell-fill step) remains gated on [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41) — what shipped in C.2 is contract slots + judgment-engine builders, not template population.
Cells: L15 (Reimbursements) — CLOSED in `c936008`; L22 (G&A) — CLOSED in `c936008`.

Note: the original Piece 4 C.2 finding identified bad-debt as a contract gap as well, but bad-debt was DROPPED from C.2 scope during scope-decision walkthrough. No Tier B cell currently exists for bad debt; if the contract is widened in a future ticket, template revisions could add one.

**Category 4 — Mechanical or text-generation (10 cells).** Not builder-shaped work. E47/E48 are formulaic reserve calculations (months-of-tax/insurance); E49 partially is a $1/SF formula (registry note); R-column notes are LLM-generated free-text explanations; C4/D4/E4 are scenario identifiers, not parameters to tune.
Cells: E47, E48, E49 (partial — the mechanical portion), R14, R22, R24, R25, R31, R32, R38, C4, D4, E4.

**Category 5 — New territory (4 cells / cell groups).** No builder, no contract slot, no doctrine principle wired through to infrastructure. Each requires contract widening + new builder + doctrine work. I9 Concluded Cap Rate is the most consequential single cell in the entire template per registry notes.
Cells: I9 Concluded Cap Rate (highest single-cell consequence per registry), D62 Refi-stress amortization, D65 Refi-stress DSCR threshold, E77 Critical-tenant sweep months prior, Q30 Management fee growth-rate parameter (per-line-item override of the global expense growth default).

### 11.3 Cross-cell dependencies

Tier B cells aren't independent of each other. The Conclusions & Escrows sheet derives Concluded Value via cell formula from I9 Concluded Cap Rate × NOI. NOI computes from Operating History col L values. So the natural ordering is:

> col L UW values (Cat 1, Cat 3) → NOI computes → I9 cap rate judgment → Concluded Value renders.

This is structurally different from Tier A line-item-builders, which all source from extraction inputs and can run in any order. Tier B has **Tier-B-on-Tier-B dependencies** — one Tier B cell's value depends on another Tier B cell's value being settled first.

Practical implication: if I9 is scoped as a Tier B ticket, the underwriter's intent question becomes load-bearing — "set I9 against the seller's UW NOI" vs. "set I9 against the bank's stressed UW NOI" is a sequencing decision that has to be made before the I9 builder can be designed.

### 11.4 Next-step pointers (Tier B sequencing)

The §9 list of next-step candidates intersects with Tier B work at multiple points. Suggested sequencing based on the gap-pattern analysis (recommendation, not commitment — the user picks tickets):

1. **PCAExtraction producer + Phase 2 widening ticket.** Scoping completed; design decisions captured in §14.1; anchor fixture committed at `431102d`. The v6 framing of this item ("unlocks 5 cells + C14, highest cell-count return") was empirically wrong on both counts:
   - **Cell-unlock split correction.** Against the current 6-field PCAExtraction contract, **Phase 1 (extractor producer alone) unlocks only 1 cell** — G51 Immediate Repairs Annual via `buildPcaImmediateRepairs`. The 5-cell unlock the v6 framing claimed (E49 Replacement Reserves Up Front, G49 Annual Escrow, L38 Replacement Reserves UW year-1, E35-M35 Other Capex broadcast) requires the **Phase 2 contract widening** captured in §14.1 (per-period capex schedule arrays + replacement-reserves metrics + immediate/short-term split). Phase 1+2 together unlock the full set. The user's Path B choice is to ship Phase 1+2 in one ticket per §13.4's scope-growth expectations.
   - **C14 Clear Height carve-out.** PCAs for industrial deals sometimes document clear height, but the field is more typically extracted from the appraisal or broker fact sheet. C14 is removed from PCA scope and either (a) deferred to the AppraisalExtraction workstream per §5.2 (ghost-contract), or (b) carved out as a separate small PropertyMetadata-shaped ticket. Removing C14 from PCA scope sharpens the PCA implementation surface.

   See §14.1 for the six closed contract design decisions and the consolidated Phase 2 schema. Implementation ticket TBD; non-trivial per §13.4's "small D.3-shape framing has predictably under-estimated scope" expectation.

2. **OperatingStatementExtraction widening (Piece 4 C.2 finding).** Unlocks Category 3 (2 cells: L15, L22) plus any other cells dependent on bad debt / reimbursements / G&A / janitorial / TI / LC line items the seller CF carries today but the contract drops. Contract-touch + extractor-touch coordinated edit; similar shape to D.3 but on the `OperatingStatementExtraction` contract instead of `SellerUWExtraction`.

3. **I9 Concluded Cap Rate as a Tier B ticket.** Highest single-cell consequence in the template per registry notes. Greenfield: new contract slot (e.g., `concludedCapRate` field), new builder, new doctrine wiring. Significantly larger scope than D.3 — closer to "a mini-feature" than "a wire-up ticket." Has Tier-B-on-Tier-B dependencies (§11.3) that should be settled before scoping.

4. **Category 1 wiring (8 surface-mismatch cells).** Cannot ship until the populator (#41) is built — these are populator-side wiring decisions about which `AdjustedInputs` fields project to which template cells. When the populator scoping starts, this category becomes the natural first chunk of populator work because the values already exist.

5. **Category 4 cells.** Not engineering work in the line-item-builders sense. E47/E48/E49-mechanical-portion need formula logic, R-column notes need text-generation pipeline. Each sub-category is its own smaller scoping conversation.

Note: this sequencing is a recommendation, not a commitment. The §9 next-step candidates remain peer choices; Tier B work is one of several directions.

---

## 12. Analysis page upgrade — stub

**Definition.** Rebuild of the legacy analysis page that did red-flag detection, internet research (sponsor / market / news), and credit scoring against the handbook. The legacy version is currently degraded.

**Status.** No spec exists. Legacy code existed but needed significant upgrade per prior sessions.

**Dependency relationship with the populator.**
- **(a)** Shares extraction infrastructure with the populator — both consume the same extraction pipeline outputs (ExtractionResult, PropertyMetadata, RentRoll, UnderwritingModel).
- **(b)** Is the natural surface for displaying Tier B reasoning, which makes its readiness a quality gate for shipping Tier B cells in the populator (per §11).

**Sequencing implication.** Framing the analysis page as a "follow-on" to the populator creates a risk that the populator ships in a state where Tier B values are visible only in the workbook with no reasoning surface. Parallel-track development is the sequencing this spec recommends, with the understanding that this is a **roadmap statement, not a resource commitment** — the user is the only person driving this work and the parallel-track recommendation is open to revision in a later session.

**Next step.** Dedicated session to scope the analysis page rebuild. Not scoped here.

---

## 13. Process learnings

Captures meta-insights surfaced during implementation work. Not architectural decisions (those live in earlier sections); not behavior changes (those live in §10). These are observations about the discipline of doing the work in this codebase — patterns that improve future scoping and execution.

### 13.1 Empirical-verification discipline catches real bugs (D.3 + C.2)

Both implementation tickets to date have surfaced bugs via empirical verification against the Sunroad fixture during implementation, not via chat-side framing or contract reasoning.

D.3 (commit `83328b4`): the bank-floor wake-up was anticipated, but the `vacancyLoss` negative-sign convention was discovered only by looking at the actual Sunroad UW column.

C.2 (commit `c936008`): two corrections.
- The reimbursements regex initially matched a section header row ("Commercial Reimbursement Revenue", value=null) before the actual total row. Tightened to require `^total\s+` prefix only after CC ran the patterns against the Sunroad UW column and found the first-match-wins bug.
- The totalOpEx derivation working assumption (reimbursements should subtract from totalOpEx) was empirically wrong. The source-CF convention is revenue-side: reimbursements is added to EGR upstream, not netted against OpEx. CC discovered this only by reading the Sunroad CF's actual NOI math: row 36 Total Expenses = $3.46M EXCLUDES reimbursements; row 24 EGR = $13.6M INCLUDES them; row 37 NOI = EGR − Total Expenses.

**Practical implication.** Implementation steps that touch extraction patterns or derivations should include an explicit empirical-verification sub-step that runs the new code against the canonical Sunroad fixture before declaring the step complete. This is cheap (a few lines of targeted grep/node script) and has now prevented bugs on both ships.

### 13.2 Judgment-engine manifest workflow as load-bearing invariant

The judgment engine enforces rule-registry hash-drift detection via `check:judgment-engine` boot check. Any rule-registry change requires:

1. Bump `JUDGMENT_ENGINE_VERSION` constant in `packages/contracts/src/versioning.ts`.
2. Widen `JudgmentEngineVersion` type alias (append-only union expansion).
3. Run `npm run judgment-engine:print-hash` to capture the new state hash.
4. Append (do not edit) a new entry in `JUDGMENT_ENGINE_MANIFEST`.
5. Verify with `npm run check:judgment-engine`.

The C.2 scoping recon did not know about this workflow; CC discovered it mid-Step-4 when the boot check failed after registering 3 new rule IDs. The brief had specified "investigate whether `JUDGMENT_ENGINE_VERSION` should bump" as a Step 5 decision; the actual workflow made it mandatory, not optional.

**Practical implication.** Future tickets touching judgment-engine state should include an explicit verification sub-step: `npm run check:judgment-engine` after any change to the rule registry or related state. The manifest workflow above should be in any implementation brief that anticipates rule-registry changes.

### 13.3 Test-sweep scope includes downstream consumers

Tickets touching judgment-engine state affect not just judgment-* test suites but also doctrine-*, valuation-*, and ingest-* suites that consume `JudgmentEngineVersion` or judgment-output shapes. The C.2 ticket's Step 5 test sweep was scoped to "the full judgment test suite" which CC reasonably read as judgment-* files; this left 6 doctrine and valuation fixture sites invisible until Step 6's wider grep surfaced them.

**Practical implication.** Test-sweep instructions in implementation briefs should explicitly enumerate the suite scope. For judgment-engine work: judgment-* + doctrine-* + valuation-* + ingest-* + handbook-evaluation-route. For extraction work: extraction-* + ingest-* + extract-cash-flow + build-extraction-result. For contract-widening work: anywhere with inline literals of the affected contract — this is the largest sweep.

### 13.4 "Small D.3-shape" framing has predictably under-estimated scope

Both D.3 and C.2 were framed at session-start as "small ticket" with the implicit comparison to a hypothetical D.3-scale unit. Both grew substantially during scoping and implementation:

D.3 (framed: back-fill triplet from existing record):
- Bank-floor activation as production behavior change
- Sign-convention handling for negative `vacancyLoss`
- `EXTRACTION_ENGINE_VERSION` bump with 5 fixture updates
- Actually shipped ~ days, not hours

C.2 (framed: small D.3-shape contract widening):
- Six scope decisions surfaced and resolved jointly
- Two empirical corrections discovered mid-implementation
- Judgment-engine manifest workflow discovered mid-implementation
- Multi-phase decision (Phase 1+2 in one ticket vs. two)
- 39 fixture updates (vs. predicted ~17-22)
- Three new behavior-change log entries
- Actually shipped ~ days, not hours

**Observation.** Tickets that look "D.3-shape" from a scoping recon probably aren't. The codebase has accumulated complexity (judgment-engine manifest workflow, doctrine consumers of judgment-engine state, field-bag assembler invariants) that the surface-level scoping framing doesn't capture. This is not a problem with our recon-then-scope discipline — it's *because* of that discipline that we surface these complexities.

**Practical implication.** Scoping briefs should anticipate scope growth via empirical discovery, and expect implementation to take substantially longer than the initial framing suggests. The "small ticket to maintain momentum" framing trades real value (cadence) for underestimated work; in this codebase, that trade is typically not worth the optimism.

This is not actionable as a process rule; it's an honest expectation adjustment for the user and Claude alike. Expect tickets to be larger than they look. Plan accordingly.

---

## 14. Contract design decisions

Captures design decisions made during scoping conversations *before* implementation work begins. Decisions in this section are documented commitments awaiting implementation; the corresponding code changes ship in implementation tickets that cross-reference back here. Different from §10 (which records *shipped* behavior changes) and from §13 (which records process guidance). When an implementation ticket ships against a §14 decision, that ticket's commit references this section and §10 gets a new entry recording the actual behavior change.

### 14.1 PCA producer (Phase 1+2) — PCAExtraction Phase 2 widening

Scoped during the v8 session against the Sunroad PCA fixture committed at `431102d` (`apps/api/fixtures/sunroad-centrum-pca.pdf`, Partner Engineering ASTM E2018-15 report, 174 pages, prepared for Goldman Sachs Bank USA, dated 2023-07-27). Six decisions taken jointly (chat + user) following a recon-then-design pattern: the morning's PCA-producer recon surfaced the empirical findings (no fixture existed; v6's "5 cells unlocked" framing was wrong; C14 belongs elsewhere); the afternoon's contract design conversation resolved the six design choices against the now-available fixture; this section records the design commitments for the implementation ticket to execute against.

**Decision 1 — Per-period capex schedule shape**

CHOSEN: per-year structured array of `{ year, amount }` objects, both inflated and uninflated.

```ts
readonly capexScheduleInflated: ReadonlyArray<{
  readonly year: number;   // 1-indexed
  readonly amount: number;
}> | null;
readonly capexScheduleUninflated: ReadonlyArray<{
  readonly year: number;
  readonly amount: number;
}> | null;
```

Rationale: matches PCA Table 2's natural structure (per-year sparse schedule); anchors `sum_over_term`'s array path for correct multi-year semantics in P-IV-RET-6; sets the precedent for per-period series shape in the engine. Per the v8 `sum_over_term` investigation, the operator REQUIRES at least one array-shaped operand for the cumulative-over-term semantic to compute correctly — pure scalars produce a degenerate single-period result. Currently `bag['reserves']` is a scalar that anchors nothing (see §10.4 Errata); Decision 1 makes `capex_projection` the load-bearing array operand that the others can broadcast against.

Sunroad anchor values (12-year schedule per PCA Table 2):

```ts
capexScheduleInflated: [
  { year: 1, amount: 0 },        { year: 2, amount: 5125 },
  { year: 3, amount: 63037 },    { year: 4, amount: 24230 },
  { year: 5, amount: 115900 },   { year: 6, amount: 0 },
  { year: 7, amount: 0 },        { year: 8, amount: 139671 },
  { year: 9, amount: 6092 },     { year: 10, amount: 0 },
  { year: 11, amount: 0 },       { year: 12, amount: 0 },
]
capexScheduleUninflated: [
  { year: 1, amount: 0 },        { year: 2, amount: 5000 },
  { year: 3, amount: 60000 },    { year: 4, amount: 22500 },
  { year: 5, amount: 105000 },   { year: 6, amount: 0 },
  { year: 7, amount: 0 },        { year: 8, amount: 117500 },
  { year: 9, amount: 5000 },     { year: 10, amount: 0 },
  { year: 11, amount: 0 },       { year: 12, amount: 0 },
]
```

**Decision 2 — Replacement reserves shape**

CHOSEN: no separate annual field; replacement reserves derived downstream from the capex schedule (Decision 1).

Schema: no new field.

Rationale: the PCA itself treats Table 2 as the replacement-reserves source — the page-ii narrative reads "These items are identified in Table 2 – Long-Term Cost Opinion." Decision 1's capex schedule covers it. The per-SF-per-year summary metric the PCA explicitly reports is captured separately via Decision 3. The "how to derive an annual rate from a per-year schedule" question (total/years vs per-SF × NRA vs underwriter judgment) is a builder-side decision belonging to the implementation ticket, not an extraction-shape decision.

**Decision 3 — PCA metadata fields**

CHOSEN: capex-anchoring + reserves-metric fields.

```ts
readonly evaluationPeriodYears: number | null;
readonly inflationRate: number | null;
readonly replacementReservesPerSfPerYearInflated: number | null;
readonly replacementReservesPerSfPerYearUninflated: number | null;
```

Rationale: `evaluationPeriodYears` anchors the array length from Decision 1 (consistency check: `capexScheduleInflated.length === evaluationPeriodYears`); `inflationRate` makes the inflated/uninflated relationship traceable and reconstructible if either array's entries need verification; the two per-SF-per-year fields capture what the PCA explicitly reports as its summary replacement-reserves metric (page-ii narrative + Table 2 footer).

Sunroad anchor values:

```ts
evaluationPeriodYears: 12,
inflationRate: 0.025,                                       // 2.50%
replacementReservesPerSfPerYearInflated: 0.11,              // $/SF/yr
replacementReservesPerSfPerYearUninflated: 0.10,            // $/SF/yr
```

**Decision 4 — Structural narrative widening**

CHOSEN: no widening; defer to a future Phase 3.

Schema: existing `structural: { roof, hvac, plumbing, electrical }` preserved unchanged.

Rationale: not load-bearing for the cells Phase 1+2 unlocks (E49/G49/L38/G51 want capex/reserves data); the handbook principles that consume condition data (P-IV-MF-4, P-IV-MHC-1) are LLM_CONTEXT consumers — flat condition-narrative strings serve them as well as a structured rating + narrative split would; widening to 8 systems × 2 fields (rating + narrative) = 16 new contract fields would add scope without proportional value; non-blocking for cell-unlock work. The implementation ticket preserves the 4 existing narrative fields without modification.

**Decision 5 — Immediate repairs detail**

CHOSEN: aggregate + immediate/short-term split.

```ts
readonly immediateRepairs: number | null;       // preserved
readonly shortTermRepairs: number | null;       // NEW
```

Rationale: the Immediate vs Short-Term distinction is meaningful underwriting data — Immediate items reserve at closing (E49 Replacement Reserves Up Front); Short-Term items inform the year-1+ capex plan and feed into the L38 / E35-M35 broadcasts. PCAs report both columns explicitly in their cost tables. One-field addition (`shortTermRepairs`) is materially less scope than Option C (a full per-line-item array of repair items with descriptions, costs, system categories).

Sunroad anchor values: `immediateRepairs: 19400`, `shortTermRepairs: 0`.

**Note on the existing `nearTermRepairs` field.** The current PCAExtraction contract carries `nearTermRepairs: number | null` ("year 1-5 typically" per existing JSDoc). Decision 5 doesn't explicitly address its fate — `shortTermRepairs` is the new field for the PCA's explicit Short-Term column. The implementation ticket should resolve whether to preserve `nearTermRepairs` alongside `shortTermRepairs` (back-compat for any persisted records), rename it (`shortTermRepairs` IS what `nearTermRepairs` was trying to be), or drop it. Surfaced as an implementation-ticket question, not a §14.1 decision.

**Decision 6 — Utility infrastructure**

CHOSEN: no field; defer entirely. File an explicit follow-up issue for "MHC PCA support" when MHC underwriting work is scoped.

Schema: no new field.

Rationale: the Sunroad anchor fixture is Office; no MHC PCA fixture is available; adding `utilityInfrastructureType` (the field P-IV-MHC-3 and P-IV-MHC-6 would read) without an MHC empirical anchor would create an untested code path. P-IV-MHC-3 and P-IV-MHC-6 stay correctly dormant — they have no MHC PCA data to consume because we don't ingest MHC PCAs today. The MHC ingestion gap is a workstream of its own; the field should land alongside it, not pre-emptively against an Office fixture.

#### Consolidated PCAExtraction Phase 2 shape

After applying Decisions 1, 3, and 5 (Decisions 2, 4, 6 add no fields), the post-widening contract:

```ts
export interface PCAExtraction {
  // Existing fields (preserved unchanged per Decisions 4 + 5).
  readonly immediateRepairs: number | null;
  /**
   * Existing field; relationship to `shortTermRepairs` (new) to be
   * resolved during implementation — preserve / rename / drop.
   * See §14.1 Decision 5 "Note on the existing nearTermRepairs field."
   */
  readonly nearTermRepairs: number | null;
  readonly structural: {
    readonly roof: string | null;
    readonly hvac: string | null;
    readonly plumbing: string | null;
    readonly electrical: string | null;
  };

  // NEW — Decision 5 (aggregate + split).
  readonly shortTermRepairs: number | null;

  // NEW — Decision 3 (PCA metadata).
  readonly evaluationPeriodYears: number | null;
  readonly inflationRate: number | null;
  readonly replacementReservesPerSfPerYearInflated: number | null;
  readonly replacementReservesPerSfPerYearUninflated: number | null;

  // NEW — Decision 1 (per-period capex schedule).
  readonly capexScheduleInflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;
  readonly capexScheduleUninflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;
}
```

**Field count.** 13 fields total: 7 top-level numeric (`immediateRepairs`, `nearTermRepairs`, `shortTermRepairs`, `evaluationPeriodYears`, `inflationRate`, `replacementReservesPerSfPerYearInflated`, `replacementReservesPerSfPerYearUninflated`) + 4 narrative strings in `structural` + 2 nested arrays of `{ year, amount }` objects. Field count drops to 12 if the implementation ticket decides to remove `nearTermRepairs` (per Decision 5's surfaced question).

**Anchor fixture:** `apps/api/fixtures/sunroad-centrum-pca.pdf` (commit `431102d` on main).

**Implementation ticket:** TBD. Phase 1+2 in one ticket per the user's Path B choice; expected scope per §13.4's "small D.3-shape framing has predictably under-estimated scope" — plan for multi-week, not multi-day. Per the v8 §11.4 framing correction, Phase 1 alone unlocks 1 cell (G51 Immediate Repairs Annual); Phase 2 widening unlocks the rest of Category 2 in §11.2 (E49, G49, L38, E35-M35).

**Open implementation-time questions** (deliberately deferred, not §14.1 decisions):
- `nearTermRepairs` fate (Decision 5 note).
- Builder-side derivation rule for annual replacement reserves rate (Decision 2 rationale).
- Whether `evaluationPeriodYears` consistency should be enforced at the contract level (TypeScript can't express `arr.length === field`), at the extractor's post-processing step, or via runtime invariant check.
- Whether the PCA's "Site effective age: 17 years" datum (from page 1 property data table) belongs in PCAExtraction or in PropertyMetadata. Not part of Decisions 1-6; surface during implementation.

### 14.2 (Placeholder for future contract design decisions)

The §14.1 entry establishes the format for this section. Future contract design conversations capture under §14.2, §14.3, etc. This is a forward-looking section type, expected to grow as more design-then-implement workstreams reach the design-done / implementation-pending stage.

---

## Cross-references

- Tracking ticket: [#41 — UW Template Populator — deferred pending extraction coverage](https://github.com/isaint-jean/cre-credit-committee/issues/41)
- Related: [#35 — Handbook: surface upstream data fields required by inert deterministic checks](https://github.com/isaint-jean/cre-credit-committee/issues/35) (Bucket 2 / S&U tracked as item 10)
- Related: [#38 — Extract per-period pro-forma arrays from seller UW models](https://github.com/isaint-jean/cre-credit-committee/issues/38) (Bucket 3 / multi-period)
- Related: [#39 — Promote PropertyMetadata to spine record with FK to ExtractionResult](https://github.com/isaint-jean/cre-credit-committee/issues/39) (Type X surface candidates in Bucket 6)
- Sibling target registry in code: `apps/api/src/services/field-authority.registry.ts` (1563 lines, ~80 cells declared against future-state UnderwritingContext shape)
