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
- **v8 — 2026-06-01.** PCA producer scoping session: empirical-verification anchor fixture committed (`apps/api/fixtures/sunroad-centrum-pca.pdf`, commit `431102d` on main, Partner Engineering ASTM E2018-15 report for the Sunroad-Centrum deal, 174 pages, 44MB); `sum_over_term` semantics investigation completed; six contract decisions closed for PCAExtraction Phase 2 widening. New §14 Contract design decisions section captures the six decisions with schemas, rationales, and Sunroad anchor values awaiting the implementation ticket. §14 extends the spec's structural vocabulary (v5 added §10 Behavior change log; v7 added §13 Process learnings; v8 adds §14 Contract design decisions — a backward-looking decision-record section, different from §10's *shipped* behavior changes and §13's forward-looking process guidance). §11.4 item 1 (PCA producer) framing corrected: the v6 "5 cells + C14" claim was empirically wrong — Phase 1 against the current 6-field contract unlocks only 1 cell (G51); Phase 2 widening per §14.1 unlocks the rest; C14 Clear Height carved out (probably belongs under AppraisalExtraction per §5.2 or PropertyMetadata). §9 item 5 cross-references §14 for PCA design-in-progress status. §9 item 7 gains a 7th bullet for the `sum_over_term` JSDoc gap discovered during the v8 investigation (operator doesn't implement scalar-broadcast across `loan_term` despite formula.ts:21 JSDoc; engine-side ticket deferred). §10.4 receives an inline Errata note correcting v7's mistaken claim that `sum_over_term` broadcasts scalars across loan term — v7's original text preserved as historical record; errata makes the correction prominent. No code shipped today; v8 is design-only.
- **v9 — 2026-06-02.** PCA producer Phase 1+2 SHIPPED (commit `f94d9f2` on main, 44 files, +1,211/-85). Implementation reifies the six Phase 2 contract decisions from v8 §14.1; v8 §14.1 is therefore marked implementation-complete with per-decision `f94d9f2` cross-references. New extractor at `apps/api/src/services/extract-pca.ts` uses a hybrid two-call AI architecture (Call A for scalars + structural narratives; Call B for capex schedules with inflated-vs-uninflated explicit prompting) — derived empirically when a single-call attempt produced positional packing of inflated values into the uninflated array's positions. Adapter at `apps/api/src/services/extraction/adapters/pca.adapter.ts` mirrors `asr.adapter.ts`. `EXTRACTION_ENGINE_VERSION` bumps `'1.3'` → `'1.4'`; `JUDGMENT_ENGINE_VERSION` bumps `'1.1'` → `'1.2'` with new rule `JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED` and manifest entry hash `a34151a7568cf30e31fab531ab3dd95af6b4190f6609ce7fb124fc44c6144bf5`. Assembler-layer `bag['capex_projection']` activated — P-IV-RET-6's first array-shaped operand; updates §9 item 7's #43 bullet from "3/4 missing" → "2/4 missing." §11.4 item 1 receives a THIRD-pass framing correction (layered onto v8's correction of v6): Phase 2 actually unlocks 3 cells (E49, G49, E35-M35), not 4 — L38 was already a C.2 unlock via `buildMonthlyCapex × 12` reading `belowNoiAdjustments.replacementReservesMonthly`, NOT PCA-gated as the v6 / v8 framing carried forward. The same §11.4 layered note documents the E49 framing correction: pre-implementation framings carried an implicit assumption that `buildUpfrontCapex` would need to be rewired during Phase 2; the Step 5 design recon for this ticket surfaced that `buildUpfrontCapex` is load-bearing for doctrine's `scorePcaCoverage` (`components.ts:271-274`) and rewiring would have silently inflated the Sunroad coverage ratio from 1.0x to 18.2x. What shipped instead: a NEW sibling field `upfrontReplacementReserves` with its OWN builder, leaving `upfrontCapex` bound to its doctrine semantic. §11.1 coverage-table rows for E49 / G49 / G51 / L38 / E35-M35 updated. Four new §10 entries: §10.6 PCA Phase 1+2 ship; §10.7 new JE rule; §10.8 `JUDGMENT_ENGINE_VERSION` 1.2 + manifest workflow (second JE_VERSION bump of the project); §10.9 `bag['capex_projection']` activation + v8 §10.4 Errata reification. Two new §13 process learnings: §13.5 on chat-side brief drafting carrying inherent fidelity loss against the codebase (~9 deltas surfaced across Steps 0-7 of this ticket, all caught in flight; gap-naming framing); §13.6 on assembler-layer nullish-tolerance against fixture-cast-discipline gaps. §9 item 2 marks PCA producer as the third completed implementation ticket; §9 item 5 cross-reference receives a v9 update layered onto v8's "scoping in progress" note. Cross-references section gains four `#TBD` follow-up issue placeholders (year-alignment improvement, `extraction_input_cache.pca_hash` column migration, fixture cast-discipline cleanup, npm scripts sweep) to be resolved in Sub-step 9.3 issue filing.
- **v10 — 2026-06-03 (this revision).** PCA capex-schedule year-alignment improvement SHIPPED (commit `<SHIP-HASH>` on main; replaces the AI Call B path with deterministic extraction via `pdfjs-dist`'s positional API). Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). The v9 §10.6 KNOWN LIMITATION block (which framed schedule-array year-by-year accuracy of ~50-60% as PDF-format-structural — text extraction stripping column positions) is corrected: the limitation was extractor-choice-structural. `unpdf`'s `extractText({ mergePages: true })` strips positions; the bundled pdf.js (`unpdf/pdfjs`) exposes `TextItem.transform` per item, accessible through `getDocumentProxy` which was already imported elsewhere in the codebase. Phase A of the implementation (model-upgrade experiment: `claude-opus-4-7` with the same Call B prompt against the same Sunroad fixture) confirmed the ceiling wasn't model-capability-bound — Opus reached 7/12 per-year exact, structurally identical failure-mode-class to the sonnet-4 baseline's 6/12. Phase B replaced Call B with `apps/api/src/services/extract-pca-schedule.ts`: scans pages for a year-header row matching multi-pattern `/^YR\s*\d+$/i | /^Year\s*\d+$/i | /^\d{1,2}$/ | /^\d{4}$/`, builds a `year → x` map, reads the explicitly labeled `INFLATED TOTALS:` and `UNINFLATED TOTALS:` rows by year-column x-lookup. Sunroad acceptance check: **12/12 per-year exact** for both inflated and uninflated arrays; sum exact ($354,055 inflated, $315,000 uninflated); all 6 Call A scalar anchors and 4 narrative anchors unchanged. `EXTRACTION_ENGINE_VERSION` bumps `'1.4'` → `'1.5'` (id-space rotation — same shape, different per-entry values for any PCA where the prior AI ceiling produced misaligned years); `PCA_ADAPTER_VERSION` bumps `'1.0'` → `'1.1'` (signature widening: the adapter now threads `slot.buffer` through to the deterministic extractor, since pdf.js's positional API needs the raw bytes the prior flat-text path discarded). Net code-line delta in `extract-pca.ts`: **-155 lines** (the Call B AI infrastructure removed exceeds the deterministic call site added); a new 320-line module ships at `extract-pca-schedule.ts`. Four new §10 entries: §10.10 #44 ship details; §10.11 EEV bump; §10.12 PAV bump; §10.13 KNOWN LIMITATION resolution + v9 framing correction. New §13.7 process learning codifies the framing-discipline lesson: when documenting a KNOWN LIMITATION, distinguish format-structural from choice-structural — name the specific API surface that's load-bearing so future readers can evaluate whether a different choice would lift the ceiling. §11.4 receives a FOURTH layered correction noting the year-alignment limitation's resolution. §11.1 E35-M35 row updated to remove the KNOWN LIMITATION reference. §10.6's KNOWN LIMITATION block gets a 1-sentence forward-pointer to §10.13. §9 item 2 marks PCA year-alignment as the fourth completed implementation ticket; §9 item 5 receives a v10 layered note closing the PCA producer line entirely. No contract changes, no JE rule changes, no JUDGMENT_ENGINE_MANIFEST additions; `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`.

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

   **Second implementation ticket — COMPLETED `c936008` (2026-05-31).** C.2 OperatingStatementExtraction widening shipped Phase 1+2 in one ticket per the scope decisions made jointly during morning session (see §13 for process notes on the multi-phase decision). 6 new contract fields + 6 new builders + `EXTRACTION_ENGINE_VERSION` bump (1.2 → 1.3) + `JUDGMENT_ENGINE_VERSION` bump (1.0 → 1.1) + `JUDGMENT_ENGINE_MANIFEST` append + 39 fixture updates + [#43](https://github.com/isaint-jean/cre-credit-committee/issues/43) cross-reference. Production-behavior changes documented in §10 Behavior change log §§10.3-10.5.

   **Third implementation ticket — COMPLETED `f94d9f2` (2026-06-02).** PCA producer Phase 1+2 shipped as the third implementation ticket after D.3 and C.2, reifying the six Phase 2 contract decisions from §14.1. New hybrid two-call AI extractor at `apps/api/src/services/extract-pca.ts` (Call A for scalars + structural narratives, Call B for capex schedules with inflated-vs-uninflated explicit prompting); new adapter at `apps/api/src/services/extraction/adapters/pca.adapter.ts` mirroring `asr.adapter.ts`; PCAExtraction contract widened from 6 leaf positions to 12 (Decisions 1, 3, 5 added fields; Decisions 2, 4, 6 added none; Decision 5's `nearTermRepairs` fate question resolved via rename → `shortTermRepairs` rather than preserve, see §14.1); 3 new line-item builders (`buildUpfrontReplacementReserves`, `buildCapexScheduleInflated`, `buildCapexScheduleUninflated`) + `EXTRACTION_ENGINE_VERSION` bump (1.3 → 1.4) + `JUDGMENT_ENGINE_VERSION` bump (1.1 → 1.2) + `JUDGMENT_ENGINE_MANIFEST` append + 30 fixture updates + assembler-layer `bag['capex_projection']` activation (P-IV-RET-6's first array-shaped operand). Production-behavior changes documented in §10 Behavior change log §§10.6-10.9; §14.1 marked implementation-complete with per-decision cross-references; §11.4 receives a third-pass framing correction (Phase 2 unlocks 3 cells, not 4 — L38 was already a C.2 unlock); §11.1 coverage table rows updated for E49 / G49 / G51 / L38 / E35-M35. The implementation-ticket gate from v5 remains open for the next candidate from the list below (visible peers: I9 Concluded Cap Rate as a Tier B ticket per §11.4 item 3; additional OperatingStatementExtraction widenings beyond C.2's bad-debt drop; AppraisalExtraction producer per §5.2; or the analysis page upgrade per §12).

   **Fourth implementation ticket — COMPLETED `<SHIP-HASH>` (2026-06-03).** PCA capex-schedule year-alignment improvement shipped as the fourth implementation ticket after D.3, C.2, and PCA Phase 1+2. Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). Replaces the AI Call B path inside `extract-pca.ts` with deterministic extraction via `pdfjs-dist`'s positional API in a new module at `apps/api/src/services/extract-pca-schedule.ts`. Call A (scalars + structural narratives) is unchanged. `EXTRACTION_ENGINE_VERSION` bump (`'1.4'` → `'1.5'`) + `PCA_ADAPTER_VERSION` bump (`'1.0'` → `'1.1'`, signature widening to thread `slot.buffer` through to the deterministic extractor) + 7 mechanical fixture-version updates. **No contract changes; no JE rule changes; no JUDGMENT_ENGINE_MANIFEST additions.** Production-behavior changes documented in §10 Behavior change log §§10.10-10.13. Empirical anchor: 12/12 per-year exact match against the Sunroad fixture's INFLATED + UNINFLATED totals rows (the v9 §10.6 ~50-60% accuracy limitation is fully resolved on this fixture); see §13.7 for the process-learning generalization about KNOWN LIMITATION framing discipline that the ticket's recon surfaced. The implementation-ticket gate from v5 remains open; with #44 closed, the visible peer candidates above (I9, OperatingStatementExtraction extensions, AppraisalExtraction producer, analysis page upgrade) are unchanged.
3. **Tier B workstream — coverage-gap recon COMPLETED 2026-05-31.** See §11 for the full inventory + gap-pattern analysis. The §9 candidates intersect with Tier B work; see §11.4 for suggested sequencing. The workstream design is no longer a blocking task — the gap patterns provide the design.
4. **Analysis page upgrade scoping session:** Scope the rebuild of the legacy analysis page (red-flag detection, internet research, credit scoring), including its dependency on Tier B shipping criteria from §11. See §12 for the stub.
5. **Extractor surface sweep:** A targeted sweep of all current extractors (legacy POST extraction services, AI-tier extractors, regex-based extractors) to surface other "extractor exists but narrowly applied / unfilled" patterns. Three instances surfaced across the three recon cycles: `uw-intelligence.service.ts` repoint candidate for loan structural terms, `AppraisalExtraction` ghost contract, `extractComparablesLinkageRefs` narrow regex output. A single sweep would either find 2-3 more Type X recovery candidates or confirm none exist; either way it makes first-ticket selection sharper. Not auto-scheduled; treat as a peer candidate to the other four next steps. **Cross-reference (v6):** the Piece 4 sweep's D.2 PCAExtraction ghost-contract finding maps to Tier B Category 2 in §11.2 (5 cells gated on PCA producer); its C.2 OperatingStatementExtraction narrow-output finding maps to Tier B Category 3 in §11.2 (3 cells gated on contract widening). **Update (v8):** the PCA producer scoping is now in progress — recon completed, anchor fixture committed at `431102d`, and six contract decisions closed in §14.1. Implementation ticket TBD; this candidate is no longer "next candidate, unscoped" — it is "scoped, awaiting implementation." **Update (v9):** PCA producer Phase 1+2 SHIPPED in `f94d9f2`. This candidate is now closed; see §§10.6-10.9 for the shipped behavior changes and §14.1 for the implementation-complete markings against each of the six Phase 2 contract decisions. With PCA closed, the v6 sweep's remaining two candidates (AppraisalExtraction ghost contract per §5.2; `extractComparablesLinkageRefs` narrow regex output per §3.4) become the visible peers if the sweep pattern continues. **Update (v10):** the PCA producer line is now fully closed end-to-end — the year-alignment quality improvement (#44) shipped in `<SHIP-HASH>` replaces the AI Call B path with deterministic extraction (see §§10.10-10.13). No further PCA-producer-line follow-up work is anticipated; the visible peer candidates from the v9 update are unchanged.
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
   - **P-IV-RET-6 cumulative-cash-flow check dormant** ([#43](https://github.com/isaint-jean/cre-credit-committee/issues/43), filed during C.2 implementation). C.2 activated 1 of 4 inputs for P-IV-RET-6's deterministic check (`bag['reserves']` from `monthlyReplacementReserves × 12`). **PCA producer Phase 1+2 (`f94d9f2`) activated a second input** — `bag['capex_projection']` projected from `AdjustedCapitalReserves.capexScheduleInflated` per §14.1 Decision 1; this is the first array-shaped operand `sum_over_term` has seen in P-IV-RET-6's formula, against which the previously-scalar `bag['reserves']` can now broadcast (see §10.9). The remaining 2 inputs (`noi_projection`, `debt_service`) stay `INTENTIONALLY_UNDEFINED`. `debt_service` is derivable today from existing `AdjustedInputs.loan`; `noi_projection` needs extraction. The "`capex_projection` needs contract-design decision" item from the v7 framing is closed: §14.1 Decision 1 picked the per-year structured-array shape (`{ year, amount }`), and `f94d9f2` shipped it. Activation-risk consideration unchanged: P-IV-RET-6 has been silently dormant since handbook engine shipped — full activation (when `noi_projection` and `debt_service` populate) may surface previously-invisible Mall scoring deltas.
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

### 10.6 PCA producer Phase 1+2 ship (`f94d9f2`, 2026-06-02)

Reifies the six contract decisions captured in v8 §14.1. PCAExtraction widened from 6 leaf positions to 12 per Decisions 1, 3, 5 (Decisions 2, 4, 6 add no fields). (The v8 design intent was 13 leaf positions — `nearTermRepairs` preserved + `shortTermRepairs` added per Decision 5's surfaced implementation-ticket question; the v9 ship resolved that question via rename rather than preserve, dropping the count by one. See §14.1 Decision 5 implementation-complete marker.) The widened contract is now produced by a new hybrid two-call AI extractor at `apps/api/src/services/extract-pca.ts`. The two-call architecture was derived empirically during Step 0 of the ticket — a single-call attempt at the full 13-field PCAExtraction shape failed because the model packed inflated values into the uninflated array's positions when both arrays were requested in one call. The two-call split (Call A: scalars + structural narratives; Call B: capex schedules, B-explicit prompting about inflated vs. uninflated columns) recovered correctness.

The adapter at `apps/api/src/services/extraction/adapters/pca.adapter.ts` mirrors `asr.adapter.ts`'s shape, including failure-mapping conventions: parseDocument throw → `'failed'`; extractPca throw → `'failed'`; extractPca null → `'empty'`; success → `'ok'` with a single `kind: 'pca'` SourceDocumentRef. Composition wired through `apps/api/src/services/extraction/build-extraction-result.ts` (new pcaPdf slot, `runPcaAdapter` in DEFAULT_COMPOSER_DEPS, `extractorVersions.pca` stamping) and `apps/api/src/services/extraction/extractor-outcome.ts` (`EXTRACTION_SLOTS` widened with `pcaPdf`). Multer slot `'pca'` added to `apps/api/src/routes/build-and-ingest.routes.ts`; `ExtractionInputKeyArgs.slotHashes` widened with `pca: ContentHash | null` (correctness-critical for cache-distinguishing of cache-hits between deals with PCA and without).

Three new line-item builders shipped in `apps/api/src/services/judgment/line-item-builders.ts`. `buildUpfrontReplacementReserves` reads `extraction.pca?.capexScheduleInflated` and returns `sum(amount)` as a PCA-sourced `AdjustedLineItem` or falls through to MANUAL 0 with `JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED` (see §10.7). `buildCapexScheduleInflated` and `buildCapexScheduleUninflated` are pure pass-through projections from the contract field to the `AdjustedCapitalReserves` sibling field. The pre-existing `buildUpfrontCapex` builder is **unchanged** — the doctrine-preservation discipline preserved it bound to the `scorePcaCoverage` semantic at `packages/handbook-data/src/components.ts:271-274`. See §11.4 E49 framing correction for the architectural reason and §13.5 for the source-trust discipline that surfaced the near-miss.

Fixture sweep: **30 fixture files** updated across `apps/api/src/scripts/` to add the new PCAExtraction fields, rename `nearTermRepairs` → `shortTermRepairs`, widen `AdjustedCapitalReserves` with the new sibling fields, bump `extractionEngineVersion` 1.3 → 1.4 and `judgmentEngineVersion` 1.1 → 1.2, and add `pcaPdf` to BuildReport slot lists / `incompleteSlots` count assertions. (The commit message records "28 fixture files"; the actual `git diff --stat` reports 30. Footnote-level correction; numbers do not affect any code path.)

End-to-end empirical verification against the Sunroad anchor fixture (`431102d`): all 6 scalar anchor values exact (`evaluationPeriodYears: 12`, `inflationRate: 0.025`, `replacementReservesPerSfPerYearInflated: 0.11`, `replacementReservesPerSfPerYearUninflated: 0.10`, `immediateRepairs: 19400`, `shortTermRepairs: 0`); both capex schedule arrays sum-exact ($354,055 inflated, $315,000 uninflated); 4 narrative fields populated (roof, hvac, plumbing, electrical). **KNOWN LIMITATION:** per-year alignment of capex schedule entries achieves ~50-60% per-year accuracy ceiling — sum-of-amounts is exact, but each entry's year-index is approximate (e.g., a $115,900 outlay that PCA Table 2 reports for year 5 may land at year 4 or 6 in the extracted array; an additional prompt-engineering iteration adding "READ THE TOTALS ROW" guidance regressed from 6/12 to 4/12 entries correctly aligned and was reverted). The limitation is surfaced in the JSDoc block on `PCAExtraction.capexScheduleInflated` and in `extract-pca.ts`'s file header; follow-up issue [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44) tracks the improvement (see Cross-references). **Resolved in §10.13 (v10).**

`EXTRACTION_ENGINE_VERSION` bumped `'1.3'` → `'1.4'` to rotate the extraction id space for any ExtractionResult that includes a populated `pca` field. `JUDGMENT_ENGINE_VERSION` bumped `'1.1'` → `'1.2'` — see §10.8.

### 10.7 New JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED rule (`f94d9f2`, 2026-06-02)

New judgment-engine rule ID registered: `JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED`. Fires when `buildUpfrontReplacementReserves` falls through to the MANUAL 0 default — i.e., when `extraction.pca` is null OR `extraction.pca.capexScheduleInflated` is null. Pattern matches the existing `JE_*_DEFAULTED` conventions: the three C.2 below-NOI defaulteds from §10.5, the earlier `JE_OTHER_INCOME_DEFAULTED` / `JE_RENT_GROWTH_DEFAULTED` / `JE_EXPENSE_GROWTH_DEFAULTED` from D.3 and prior.

The rule fires on every deal where the PCA upload was missing or empty; visible in `AdjustedInputs.capitalReserves.upfrontReplacementReserves.adjustments` array. On Sunroad (with the anchor PCA present) the rule does NOT fire — `capexScheduleInflated` populates and `buildUpfrontReplacementReserves` returns the actual sum.

Registry total advances from 35 (v1.1) → 36 (v1.2). The `test-judgment-engine-rules.ts` rule-count assertion bumps `35` → `36` and the version label `"v1.1"` → `"v1.2"`; the category-coverage tests cover the new rule via the `_DEFAULTED` suffix pattern check without further modification. See §10.8 for the version-bump entry.

### 10.8 JUDGMENT_ENGINE_VERSION 1.2 + manifest workflow (`f94d9f2`, 2026-06-02)

`JUDGMENT_ENGINE_VERSION` bumped from `'1.1'` to `'1.2'`. `JudgmentEngineVersion` type alias widened to `'1.0' | '1.1' | '1.2'` per the append-only manifest convention. New manifest entry appended: `'1.2': 'a34151a7568cf30e31fab531ab3dd95af6b4190f6609ce7fb124fc44c6144bf5' as ContentHash`. Boot check (`check:judgment-engine`) passes against the new state.

Second `JUDGMENT_ENGINE_VERSION` bump of the project. The workflow documented in §13.2 (bump constant → widen type union → register rule → print-hash → append manifest → verify boot check) executed cleanly on this ticket — zero surprises. The discipline that surfaced as a load-bearing invariant during C.2 is now mechanical for future rule-registry additions.

### 10.9 bag['capex_projection'] activation + v8 §10.4 Errata reification (`f94d9f2`, 2026-06-02)

The handbook-engine assembler (`apps/api/src/services/handbook/assembler.ts`) now populates `bag['capex_projection']` from `AdjustedCapitalReserves.capexScheduleInflated`:

```ts
const capexSchedule = graph.adjustedInputs.capitalReserves.capexScheduleInflated;
if (capexSchedule != null) {
  const sorted = [...capexSchedule].sort((a, b) => a.year - b.year);
  bag['capex_projection'] = sorted.map((entry) => entry.amount);
} else {
  bag['capex_projection'] = undefined;
}
```

`bag['capex_projection']` becomes **P-IV-RET-6's first array-shaped operand**. The v8 §10.4 Errata correctly identified that `sum_over_term` does not broadcast scalars across `loan_term` — it dispatches into `evaluateFormulaAsArray` which lifts scalars to length-1 arrays. For P-IV-RET-6's cumulative-cash-flow formula to compute a multi-period sum, at least one operand must be genuinely array-shaped. Pre-`f94d9f2`, all four operands were either scalar (`reserves`, via C.2) or `INTENTIONALLY_UNDEFINED` (`capex_projection`, `noi_projection`, `debt_service`). Post-`f94d9f2`, `capex_projection` is the array anchor; `bag['reserves']` (scalar) now broadcasts against `capex_projection`'s length, producing the correct per-period reserves contribution to the cumulative sum.

The v8 §10.4 Errata is therefore **reified, not corrected** — this ticket did NOT fix the underlying `sum_over_term` JSDoc-vs-implementation gap (the engine-side ticket remains deferred per §9 item 7's `sum_over_term` bullet). It made the workaround real: `capex_projection` is now the load-bearing operand that the formula needs in order to compute anything observable. The v8 §10.4 Errata's prediction that "the gap will surface when other operands populate" is borne out — and the consumer-side fix (provide an array operand) was selected over the engine-side fix (implement the JSDoc-promised broadcast).

POPULATED_FIELDS count in the assembler's KNOWN_FIELDS partition: 14 → 15. INTENTIONALLY_UNDEFINED_FIELDS: 17 → 16. P-IV-RET-6 dormancy advances from 3-of-4-missing to 2-of-4-missing (see §9 item 7 #43 update). The v8 §10.4 doc-comment block in `assembler.ts` describing `sum_over_term` semantics has been replaced with the accurate description per Decision 1's array-anchoring rationale.

Two implementation-time surprises surfaced in Step 6 and were fixed in flight (see §13.5 delta count): (a) `if (capexSchedule !== null)` originally used strict equality and let test-fixture-produced `undefined` values through to a destructure that threw — fixed by switching to `!= null` (nullish-tolerant; covers `null` and `undefined`); (b) the `else` branch was originally omitted, which violated the KNOWN_FIELDS invariant that every declared key must appear in the bag — fixed by adding explicit `bag['capex_projection'] = undefined` in the else branch. Both surprises are documented in §13.6 as part of the assembler-layer nullish-tolerance discipline.

### 10.10 PCA capex-schedule year-alignment improvement (`<SHIP-HASH>`, 2026-06-03)

Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). Replaces the AI Call B path inside `extract-pca.ts` with deterministic extraction via `pdfjs-dist`'s positional API in a new module at `apps/api/src/services/extract-pca-schedule.ts`. Call A (scalars + structural narratives) is unchanged. The merge layer at `buildPcaFromAiResponses` is unchanged — the deterministic result is wrapped in the existing `CallBResult` shape before merge, so the partial-success policy (null on either side) carries over unchanged. (The `CallBResult` type name is retained for merge-interface stability; treat the field set as the contract, not the name. Cosmetic naming gap recorded here in lieu of a follow-up issue — the rename is well under 30 lines and isn't blocking anything; future-CC reading the merge function should follow the trail back through this entry.)

Implementation flow in the new module: scan pages for a y-bucket of items matching multi-pattern `/^YR\s*\d+$/i | /^Year\s*\d+$/i | /^\d{1,2}$/ | /^\d{4}$/` (handles "YR N", "Year N", bare integers, or 4-digit calendar years — covers reasonable PCA-vendor variation); sort by x to build `year → x` map (year = index + 1); locate the explicitly labeled `INFLATED TOTALS:` and `UNINFLATED TOTALS:` rows via text-content match at low x; for each year-x position in the totals row, find the nearest dollar item within ±8 user-space units. Zero-cell-by-absence (no item within tolerance → amount = 0). Returns `null` overall if no page presents a year-header row with at least one totals row; per-array null if a specific totals label is absent. Totals-row-only v1: per-line-item summation fallback deferred to a future multi-vendor follow-up if a PCA surfaces without explicitly labeled totals.

Adapter signature widened to thread the raw PDF bytes through. The prior `extractPca(document: ParsedDocument)` signature didn't carry the buffer (it was consumed and discarded by `parseDocument` upstream). The new `extractPca(document: ParsedDocument, pdfBuffer: Buffer)` preserves the bytes alongside the parsed intermediate so the deterministic extractor can call `getDocumentProxy` on them. The change propagates through `runPcaAdapter(slot)` → `runPcaAdapterOnDocument(doc, hash, pdfBuffer, deps)` → `deps.extractPca(doc, pdfBuffer)`. Test mocks were unaffected: the `runPcaAdapter` mock at `test-build-extraction-result.ts:222` operates at the slot level (where `slot.buffer` is already in scope), not at the inner `extractPca` level.

Net code-line delta in `extract-pca.ts`: **-155 lines** (the removed Call B AI infrastructure — `PCA_CALL_B_SYSTEM`, `buildCallBPrompt`, `parseAiPcaCallBResponse`, the private `parseScheduleArray` helper, and the parallel `Promise.allSettled` orchestration — exceeds the deterministic call site added). The new module ships at 320 lines including JSDoc + exported helpers (`groupItemsByY`, `findYearHeaderRow`, `buildYearXMap`, `parseDollarAmount`, `findNearestItemByX`, all exported for test discipline per the existing pure-parser convention).

Empirical verification against the Sunroad anchor fixture (`apps/api/fixtures/sunroad-centrum-pca.pdf`, committed at `431102d`): **12/12 per-year exact** on both inflated and uninflated arrays (vs. the v9 baseline 6/12 inflated exact and a v10-Phase-A `claude-opus-4-7` upgrade attempt that reached 7/12 with the same prompt — confirming the ceiling wasn't model-capability-bound). Sums exact ($354,055 inflated, $315,000 uninflated). All 6 Call A scalar anchors and 4 narrative anchors unchanged (Call A is structurally untouched). Wall-clock: 10.8s overall (parity with the prior architecture — Call A dominates the parallel block; the deterministic schedule extractor completes in well under 1s but waits inside `Promise.allSettled`).

Process-discipline note: this ticket surfaced 6 brief-vs-codebase deltas across recon and implementation (Step 1 buffer-access misframing in the original Item 2 sketch; Step 2 signature simplification + buffer threading + parallel orchestration + multi-page edge case; Step 4 missing npm script aliases for `test:build-extraction-result` + nonexistent `test-apply-judgment-adjustments.ts`). All caught in flight; zero rework. The §13.5 pattern (briefs from chat predictably miss codebase deltas) persists; v9 §13.5's count is frozen as a PCA-producer-ticket historical record, and v10's count is captured here as evidence the discipline transfers across tickets.

### 10.11 EXTRACTION_ENGINE_VERSION bump 1.4 → 1.5 (`<SHIP-HASH>`, 2026-06-03)

`EXTRACTION_ENGINE_VERSION` bumped from `'1.4'` to `'1.5'`. The PCAExtraction contract shape is unchanged, but the per-entry values change for any PCA where the prior AI Call B produced misaligned years (on Sunroad: 6 of 12 years had values relocated). Cache-key semantics require id rotation: post-bump ExtractionResults have different content-hash ids than pre-bump records for the same source documents. Treat pre-1.5 and post-1.5 extraction outputs as different id spaces — the same justification pattern as v5 §10.2 (D.3 1.1→1.2), v7 §10.4 (C.2 1.2→1.3 implicit in EEV-bump-with-version-history-discipline), v9 §10.6 (Phase 1+2 1.3→1.4).

This is the third EEV bump of the project. The bump cadence reflects the rule "any change that affects per-entry extraction values rotates the id space," even when the contract shape is stable — the cache invalidation requirement is real, and the bump is the canonical signal to downstream consumers. Pre-1.5 cache entries become orphans (not hit by post-bump cache lookups); new post-1.5 cache entries write through the storage schema. (See §10.13 for the interaction with the still-open `extraction_input_cache.pca_hash` column gap from #46.)

5 fixture-version literals + the production constant updated in the v10 fixture sweep; full count 6 sites. No fixture hardcodes EEV-derived content-hashes, so no cascading fixture-id breakage.

### 10.12 PCA_ADAPTER_VERSION bump 1.0 → 1.1 (`<SHIP-HASH>`, 2026-06-03)

`PCA_ADAPTER_VERSION` bumped from `'1.0'` to `'1.1'`. The adapter's external entry point (`runPcaAdapter(slot)`) signature is unchanged; the internal interface `PcaAdapterDeps.extractPca` widens from `(doc) => Promise<...>` to `(doc, pdfBuffer) => Promise<...>` to thread the raw bytes through to the deterministic schedule extractor. The internal core `runPcaAdapterOnDocument(doc, bufferHash, pdfBuffer, deps)` gains `pdfBuffer` as a new 3rd positional parameter; existing test mocks operate at the external entry point (where `slot.buffer` is already in scope) and are unaffected.

Stamped into `ExtractionResult.extractorVersions['pca']` by the composer's version harvester. 1 fixture-version literal updated in `test-build-and-ingest-route.ts:253` (the synthetic BuildReport's `pcaPdf.adapterVersion`); per-adapter convention same as ASR/CF/rent-roll adapters carrying local version constants.

### 10.13 §10.6 KNOWN LIMITATION resolution + v9 framing correction (`<SHIP-HASH>`, 2026-06-03)

The v9 §10.6 KNOWN LIMITATION block — which framed PCA capex-schedule per-year alignment accuracy of ~50-60% as a property of PDF text extraction — is **resolved** by §10.10's deterministic extractor. Sunroad now reads 12/12 per-year exact via `pdfjs-dist`'s positional API. The v9 KNOWN LIMITATION text in `extract-pca.ts`'s file header, in `PCAExtraction.capexScheduleInflated`'s JSDoc, and in `AdjustedCapitalReserves.capexScheduleInflated`'s JSDoc are all replaced with notes pointing to the new deterministic module. §10.6's own KNOWN LIMITATION block receives a 1-sentence "Resolved in §10.13 (v10)" forward-pointer; the v9 prose is preserved per the layering discipline.

Beyond the resolution itself, this entry records a **framing correction**: v9's KNOWN LIMITATION block claimed the limitation was structural to PDF text extraction. It wasn't. The limitation was structural to **our specific extractor's API choice** (`unpdf`'s `extractText({ mergePages: true })` collapses each PDF page's text items to a flat string, discarding the `TextItem.transform` matrices that pdf.js itself preserves). The bundled pdf.js (`unpdf/pdfjs`, accessible via `getDocumentProxy` which was already imported at `apps/api/src/services/pdf-parser.service.ts:19`) exposes `transform[4]` as x-coordinate and `transform[5]` as y-coordinate per text item — the exact positional information needed to recover year-column assignments. The capability was always present in the dep we already had; we just weren't reaching it.

Phase A of the implementation (the model-upgrade experiment) load-bearingly confirmed this framing: running `claude-opus-4-7` against the Sunroad fixture with the same Call B prompt produced 7/12 per-year exact, structurally identical failure-mode-class to the sonnet-4 baseline's 6/12 (off-by-one shifts of non-zero values to adjacent years; sum exact in both runs). A higher-capability model couldn't recover positional information that wasn't in its input — the ceiling wasn't model-capability-bound. Phase A's marginal +1 entry over baseline confirmed the structural ceiling sits at the text-extraction-API layer, and Phase B's clean 12/12 against the same fixture confirmed pdf.js's positional API lifts it cleanly.

See §13.7 for the codified process-learning generalization — the discipline question this ticket surfaced is broader than the PCA case: when documenting a KNOWN LIMITATION, distinguish format-structural (truly intrinsic to the data format) from choice-structural (artifact of our specific API surface). v9 §10.6 conflated the two; future KNOWN LIMITATION blocks across the codebase should name the specific API choice that's load-bearing so future readers can evaluate whether a different choice would lift the ceiling.

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
| E49 | Conclusions & Escrows | Replacement Reserves — Up Front | Yes (new in v9) | `buildUpfrontReplacementReserves` (PCA producer ticket `f94d9f2`) | Pattern 3 (`extraction.pca.capexScheduleInflated` → MANUAL 0 with `JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED`) | No (populator gated on #41) | P-III-3, P-IV-OFF-3 | **Updated (v9):** new builder shipped per §14.1 Decision 5; returns `sum(capexScheduleInflated.amount)` as PCA-source. The pre-existing `buildUpfrontCapex` is **unchanged** — preserved for doctrine `scorePcaCoverage` semantic (see §11.4 E49 framing correction). Two distinct concepts now have two distinct fields on `AdjustedCapitalReserves`. |
| G49 | Conclusions & Escrows | Replacement Reserves — Annual Escrow | No (per §14.1 Decision 2) | NONE | N/A | No (populator gated on #41) | P-III-3, P-IV-OFF-3 | **Updated (v9):** no dedicated builder per §14.1 Decision 2 — replacement reserves derived downstream from `capexScheduleInflated` rather than carried as a separate annual field. Natural derivation `sum(capexScheduleInflated.amount) / evaluationPeriodYears`; per-deal underwriter-judgment rule (total/years vs. per-SF × NRA vs. other) is itself a builder-design question deferred to the populator-side ticket. (The pre-v9 entry pointed at `buildMonthlyCapex × 12`; that builder reads C.2's `belowNoiAdjustments.replacementReservesMonthly`, a different semantic — seller's UW monthly reserve, not PCA-derived annual escrow.) |
| G51 | Conclusions & Escrows | Immediate Repairs — Annual Escrow | Yes (Phase 1 woke existing builder) | `buildPcaImmediateRepairs` (line 619) | Pattern 3 (`extraction.pca.immediateRepairs` → null) | No (populator gated on #41) | P-III-3 | **Updated (v9):** builder pre-existed; Phase 1 of `f94d9f2` populated `extraction.pca` for the first time, waking the builder on every deal with a PCA upload. Sunroad PCA: `immediateRepairs: 19400` (was 0 because PCA was always null pre-`f94d9f2`). |
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
| L38 | Operating History | Replacement Reserves (UW year-1) | Yes (C.2 unlock, v9 correction) | `buildMonthlyCapex × 12` (line 595) | Pattern 3 (`belowNoiAdjustments.replacementReservesMonthly` → MANUAL 0 with `JE_REPLACEMENT_RESERVES_DEFAULTED`) | No (populator gated on #41) | P-III-3, P-IV-OFF-3 | **Correction (v9):** previously misattributed as PCA-gated. L38 is actually a C.2 unlock — `buildMonthlyCapex` reads OperatingStatementExtraction's `belowNoiAdjustments.replacementReservesMonthly` (added in `c936008`), NOT PCAExtraction. Removed from Category 2 in the §11.2 mental model; see §11.4's v9 cell-unlock-split correction. |
| L39 | Operating History | TI (UW year-1) | Partial | `buildMonthlyTiLc × 12` (line 615) | applicability flag, MANUAL default 0 | No | P-III-3 | Ghost-adjacent + applicability gated. |
| L40 | Operating History | LC (UW year-1) | Partial | `buildMonthlyTiLc × 12` (line 615) | applicability flag, MANUAL default 0 | No | P-III-3 | Same single `monthlyTiLc` field as L39 — TI and LC not split today. |
| R14, R22, R24, R25, R31, R32, R38 | Operating History | UW assumption notes (free-text) | No | NONE | N/A | No | P-III-2 (justification surface) | 7 free-text cells (e.g., "Set to T-12 +3%", "UW to Prop 13"). LLM-generated explanatory prose; no builder produces strings. Registry: "Generated by LLM as part of judgment output, Milestone 2." |
| Q30 | Operating History | Management fee growth rate (3% parameter) | No | NONE | N/A | No | P-III-2 | Per-line-item growth-rate override. `buildExpenseGrowthPct` returns a single 0.03 default; no per-line-item differentiation today. |
| C4, D4, E4 | Stress Scenario | "Tenants Lost" scenario tier identifiers (1/2/3) | No | NONE | N/A | No | P-III-8 | Scenario definitions, not judgment parameters. Marginal Tier B. |
| D62 | Stress Scenario | Refi-stress Amortization Period (360 months) | No | NONE | N/A | No | P-III-10 | Refinance-stress amort assumption used in stressed refi DSCR test. |
| D65 | Stress Scenario | Refi-stress Required DSCR (1.35) | No | NONE | N/A | No | P-III-10, P-III-8, P-III-6 | DSCR threshold for refi-stress test. Deal-level UW assumption (bank's required-refi-DSCR target). |
| E28-M28 (9 cells) | 10 Yr Pro Forma | Expense Growth Rate per year (3% × 9) | Yes | `buildExpenseGrowthPct` (line 756) | MANUAL default 0.03 (JE_EXPENSE_GROWTH_DEFAULTED) | Unknown | P-III-2, P-III-1 | Builder emits a single 0.03 default; whether the populator broadcasts `AdjustedInputs.assumptions.expenseGrowthPct.adjusted` to 9 cells is unverified — needs grep during ticket scoping. |
| E35-M35 (9 cells) | 10 Yr Pro Forma | Other Capital Expenditures per year (0 × 9) | Yes (Phase 2 via assembler projection; per-year exact since v10) | `buildCapexScheduleInflated` (pure passthrough) + assembler-layer `bag['capex_projection']` activation | Pattern 3 (`capexScheduleInflated` → undefined when PCA absent) | No (populator gated on #41) | P-III-3 | **Updated (v9):** new in `f94d9f2` per §14.1 Decision 1. `AdjustedCapitalReserves` now carries `capexScheduleInflated` / `capexScheduleUninflated` as sibling arrays alongside the scalar `monthlyCapex`; assembler projects `capexScheduleInflated` into `bag['capex_projection']` (P-IV-RET-6's first array operand — see §10.9). **Updated (v10):** the v9 KNOWN LIMITATION on per-year alignment accuracy is resolved — `capexScheduleInflated` now arrives per-year exact via deterministic extraction (`apps/api/src/services/extract-pca-schedule.ts`, see §§10.10-10.13). Sunroad achieves 12/12 per-year exact. Year-precise consumers (eventual populator wiring, audit-trail display) can rely on the per-year values. |
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

**Update (v9):** Category 2's cell count is corrected by `f94d9f2`'s ship. Post-PCA-Phase-1+2: G51 has graduated out of ghost-gated (`buildPcaImmediateRepairs` now produces a value whenever `extraction.pca` is populated), and L38 was actually a C.2 unlock — NOT PCA-gated as the v6 framing carried into this paragraph claimed. The accurate post-`f94d9f2` Category 2 membership is **3 cells**: E49 (new builder `buildUpfrontReplacementReserves` shipped), G49 (no builder per §14.1 Decision 2 — downstream-derivation), E35-M35 (new builder `buildCapexScheduleInflated` + assembler-layer `bag['capex_projection']` projection). See §11.1 coverage table rows for the authoritative per-cell attribution, §10.6 for the ship details, and §11.4's v9 correction for the framing-evolution arc.

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

   **Further correction (v9).** Phase 1+2 shipped in `f94d9f2` (2026-06-02), and the implementation surfaced a second cell-unlock-split error that the v8 framing had carried forward from v6. **Phase 2 actually unlocks 3 cells**, not 4 — L38 was already a C.2 unlock via `buildMonthlyCapex × 12`, reading OperatingStatementExtraction's `belowNoiAdjustments.replacementReservesMonthly` field (added in `c936008`), NOT PCAExtraction. The v6 framing's inclusion of L38 in the PCA-unlock set, preserved through v8's correction without re-examination, was the residual error. The accurate cell-unlock breakdown:

   - **Phase 1 (extractor wakes existing builder):** G51 Immediate Repairs Annual via the pre-existing `buildPcaImmediateRepairs` builder, which reads `extraction.pca.immediateRepairs`. Builder existed before this ticket; Phase 1 wakes it by populating `extraction.pca` for the first time.
   - **Phase 2 cell 1 — E49 Replacement Reserves Up Front:** unlocked via the NEW builder `buildUpfrontReplacementReserves`, reading `extraction.pca.capexScheduleInflated` (Decision 1) and returning `sum(amount)`. The existing `buildUpfrontCapex` builder is **unchanged** — see the E49 framing correction below for the architectural reason.
   - **Phase 2 cell 2 — G49 Replacement Reserves Annual Escrow:** **no builder shipped.** Per §14.1 Decision 2 (no separate annual field), the consumer side derives the annual rate downstream — `sum(capexScheduleInflated.amount) / evaluationPeriodYears` is the natural derivation, but the per-deal underwriter judgment (total/years vs. per-SF × NRA vs. other) is itself a builder-design question deferred to the populator-side ticket.
   - **Phase 2 cell 3 — E35-M35 Other Capital Expenditures broadcast (9 cells):** unlocked via assembler-layer projection. `apps/api/src/services/handbook/assembler.ts` reads `AdjustedCapitalReserves.capexScheduleInflated`, sorts by year, and projects to `bag['capex_projection']` as an amount-array in year order — P-IV-RET-6's first array-shaped operand (see §9 item 7 `sum_over_term` bullet and §10.9 for the assembler activation entry).

   **E49 framing correction.** E49 (Replacement Reserves — Up Front Deposit) has been listed in v6 / v8 §11.1 with `buildUpfrontCapex` as the existing-but-PCA-gated builder. The implicit framing carried into pre-implementation scoping was that `buildUpfrontCapex` would need to be rewired during Phase 2 to read the new `capexScheduleInflated` array — the natural source for the "long-term replacement reserves at closing" semantic E49's label suggests. The Step 5 design recon for this ticket surfaced two reasons that framing was wrong:

   1. **No populator exists, so no populator-side mismatch can exist.** The "builder-intent mismatch" framing presupposes a downstream consumer of `buildUpfrontCapex` that reads its output as "Replacement Reserves Up Front." But Tier B cells aren't wired to any populator today — the populator-side wiring is gated on #41. The output of `buildUpfrontCapex` lands in `AdjustedInputs.capitalReserves.upfrontCapex`, where it is consumed by doctrine's `scorePcaCoverage` (`packages/handbook-data/src/components.ts:271-274`), NOT by a Tier B cell populator. There is no populator-side mismatch to correct on a path that does not yet exist.

   2. **`upfrontCapex` is load-bearing for doctrine's PCA-coverage signal.** `scorePcaCoverage` reads `upfrontCapex` as the closing-time PCA-immediate-repair-reserve operand and compares it against `pcaImmediateRepairs.raw` to detect deals with insufficient closing reserves. Rewiring `buildUpfrontCapex` to read `capexScheduleInflated` (which sums multi-year capex, not closing-only repairs) would have silently inflated the Sunroad coverage ratio from 1.0x to 18.2x, masking the doctrine signal that exists precisely to surface coverage gaps. The architectural near-miss was averted because the Step 5 design recon traced the actual consumer of `upfrontCapex` through the doctrine layer; the v9 §13.5 process learning captures the discipline that surfaced it.

   What shipped instead: a NEW sibling field on `AdjustedCapitalReserves`, `upfrontReplacementReserves: AdjustedLineItem`, with its OWN builder `buildUpfrontReplacementReserves` reading `extraction.pca.capexScheduleInflated`. `upfrontCapex` stays bound to the doctrine PCA-coverage semantic ("PCA immediate-repair reserve at closing"); `upfrontReplacementReserves` carries the long-term replacement-reserves-at-closing semantic that E49 wants. Two distinct concepts, two distinct fields — the architectural lesson is that semantic conflation in the v6 framing reflected the fact that the codebase didn't yet have separate fields for the two concepts, and the v9 ship now does.

   **Implication for §11.2 categorization.** Category 2 (PCAExtraction ghost-contract gated) in the v6 framing listed E49, G49, G51, L38 (full), E35-M35 — 5 cells. Post-v9, the accurate Category 2 membership is 3 cells (E49, G49, E35-M35), G51 graduates to "PCA-source populated" (Phase 1 woke the existing builder), and L38 moves to a "C.2 unlock" attribution. §11.2's Category 2 paragraph now carries a v9 inline update note documenting the corrected membership; §11.1 coverage table rows for the affected cells have been updated accordingly. The original v6 paragraph wording is preserved above the update note to keep the v6→v8→v9 evolution arc visible — readers should treat §11.1 as the authoritative cell-by-cell ledger and the v9 update note as the corrected categorization.

   **Further correction (v10).** The year-alignment quality limitation on `capexScheduleInflated` documented in v9 §10.6 (and previously inherited into the §11.1 E35-M35 row) was resolved deterministically in `<SHIP-HASH>` per #44 — see §§10.10-10.13. The §11.1 E35-M35 row reflects the resolution; the v9 KNOWN LIMITATION inheritance is gone. The architectural insight that the recon for #44 surfaced (the limitation was extractor-choice-structural, not PDF-format-structural — pdf.js positional data was available in the dep we already had) is captured as a general process learning at §13.7. This v10 layer doesn't unwind the prior v9 / v8 / v6 corrections; it closes the loop on the year-alignment quality concern within the broader §11.4 PCA-producer sequencing arc.

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

### 13.5 Briefs from chat predictably miss codebase deltas (PCA producer)

Chat-side brief drafting carries an inherent fidelity loss against the codebase. The brief carries the chat's MENTAL MODEL of the codebase; the codebase itself carries the AUTHORITATIVE state. Where these diverge — and they predictably will — trust the codebase, surface the delta, don't paper over.

The PCA producer ticket surfaced ~9 brief-vs-codebase deltas across Steps 0-7 of implementation, all caught in flight via the source-trust discipline, zero rework. The exact number isn't load-bearing; the categorization is. Categories observed:

- **Line-number references (4 instances).** Composer line offsets in `build-extraction-result.ts`, JE rule registry line positions, builder function line positions in `line-item-builders.ts`, and a `scorePcaCoverage` line range in `components.ts` were each slightly off in the brief — typically by 5-15 lines, occasionally by enough to point at the wrong function entirely. Pattern: any line number in the brief should be re-verified against the current file before being used as an anchor for an edit. The brief is a *plan*, not a *transcript* — line numbers age fast.
- **Location / file-path assumptions (2 instances).** The API key location and the `PCA_ADAPTER_VERSION` location in the brief named paths the codebase doesn't use today. File-path guesses look authoritative in prose but are easy to mis-remember chat-side; readers (CC included) should resist the urge to treat a brief-stated path as a verified path.
- **Schema-shape mismatches (2 instances).** The `SourceDocumentKind` name and the expected `AdjustedCapitalReserves` "shape-break authorization" the brief anticipated were both subtly different from the codebase's actual shape — `SourceDocumentKind` was correct, and `AdjustedCapitalReserves` widening turned out NOT to be a shape-break because non-`AdjustedLineItem` sibling fields are an already-documented pattern on that contract. Both surfaced as "expected a hurdle, no hurdle present."
- **Surface-area gap the brief didn't anticipate (1 instance).** The `synthesizeBuildReport` cache-hit path in `build-and-ingest.routes.ts` needs to wire the real `pca !== undefined` boolean into the synthesized `BuildReport.slots.pcaPdf` shape. The brief reasoned about the fresh-extraction path (where `runPcaAdapter` produces the slot status) and missed the cache-hit path entirely, where the slot status has to be reconstructed without re-running the adapter. The discovery added one new edit site late in implementation; no rework, but a real architectural addition CC made independent of the brief.

Plus the implementation-time storage-table-schema-gap finding (Step 4 surfaced that `extraction_input_cache` doesn't have a `pca_hash` column even though the cache-key shape now includes `pca: ContentHash | null`; deferred to follow-up issue [#46](https://github.com/isaint-jean/cre-credit-committee/issues/46) per the "scope-honesty" discipline §13.4 captures).

**Operational instruction.** Expect deltas. Verifying brief content against source code before accepting framing is operational, not optional. The discipline that catches deltas is reading the actual file at the actual path *before* committing to a step's outputs — not "checking once at the start of the ticket," but "checking at each step that depends on a brief-stated fact."

This is gap-naming, not positive-spin: the chat-side brief drafting fidelity loss is observed (D.3, C.2, and PCA producer all surfaced delta counts in the 4-10 range), inherent (chat reasoning about a codebase is reasoning from memory, not from current state), and predictable (CC should plan for it). The corollary — that the source-trust discipline catches the deltas without rework — is implicit; the operational instruction is what the future-reader needs.

### 13.6 AdjustedInputs nullish-tolerance at assembler layer

Test fixtures throughout `apps/api/src/scripts/` use `as unknown as HydratedRecordGraph` (and sibling-shape) casts that bypass TypeScript's contract enforcement. Runtime values may be `undefined` at sites where the contract declares `T | null`. Observed twice in close succession:

- **C.2's `monthlyReplacementReserves` edge case.** A test fixture for the assembler had the field shaped via `as unknown as` and reached assembler-layer code that expected the field to be `null`-or-populated, not `undefined`. C.2's assembler-layer reads accommodated this without explicit framing of the discipline.
- **PCA's `capexScheduleInflated` edge case (`f94d9f2`).** The assembler's `bag['capex_projection']` activation initially used `if (capexSchedule !== null)` — strict equality. Test fixtures via `as unknown as` passed `undefined` through (`undefined !== null` is `true`), which reached the destructure-and-sort path and threw. Fixed during Step 6 by switching to `!= null` (nullish — covers both `null` and `undefined`). Plus the missing `else` branch: the original implementation omitted the `else { bag['capex_projection'] = undefined; }` clause, which violated the KNOWN_FIELDS invariant (every declared field key must appear in the bag, even when set to `undefined`). Both surprises caught by the assembler test sweep, not by type-checking — because the test fixtures bypass the type-check via the `as unknown as` cast.

**Two paths available.** The pragmatic-near-term path is what shipped: assembler-layer code reading from `AdjustedInputs.*` should use loose `!= null` (covers both `undefined` and `null`) rather than strict `!== null` (covers `null` only). The architecturally clean path is fixture-discipline cleanup — replacing `as unknown as HydratedRecordGraph` casts with proper full-contract literals so runtime values match what the contract declares. Both paths are documented; the choice is whose ticket scope absorbs the cleanup work.

Until the fixture cleanup ships, prefer `!= null` at assembler-layer reads against `AdjustedInputs.*` fields. The follow-up issue [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) tracks the fixture-discipline cleanup; when it ships, the runtime checks can be re-tightened to `!== null` since the runtime values will actually match the contract.

**Practical implication.** When implementation work touches assembler-layer reads, watch for the strict-vs-loose equality choice. If tests fail with destructure errors on `undefined` values, the fix isn't to add a defensive check at each call site — it's to either (a) use loose `!= null` consistently at the `AdjustedInputs` boundary, or (b) tighten the fixtures. Don't pick (a) at one site and (b) at another; pick the project-wide discipline. This learning is also a corollary of §13.5's "trust the codebase" — the codebase (via runtime cast-discipline) is telling us something about what the type system has not been carrying, and the assembler layer is where the gap surfaces.

### 13.7 KNOWN LIMITATION framing — distinguish format-structural from choice-structural

When documenting a KNOWN LIMITATION in code or spec, distinguish between **format-structural** limitations (truly intrinsic to the data format or external system being read) and **choice-structural** limitations (artifact of OUR specific API surface for reading it). The discipline question to ask before writing a KNOWN LIMITATION block: *is this limitation intrinsic to the data, or to our choice of API for accessing the data?* If the answer is the latter (or unknown), the KNOWN LIMITATION block should name the specific API choice that's load-bearing — so future readers can evaluate whether a different choice would lift the ceiling without reproducing the recon work that surfaced the answer.

**Concrete case — PCA capex-schedule year-alignment (resolved by #44).** The v9 §10.6 KNOWN LIMITATION block claimed: *"PDF text extraction (`unpdf` / pdf.js) strips column positions from Table 2 cells. The extracted text shows row data + dollar amounts as a linear stream… with NO positional cue indicating which year column each $30,000 belongs to."* The framing implied the limitation was structural to PDF text extraction in general — a property of the data format. Three iterations of prompt engineering against the AI extractor (vanilla → B-explicit → totals-row guidance) confirmed a ceiling at ~50-60% per-year alignment accuracy. Phase A of the #44 implementation added a fourth experimental data point: running `claude-opus-4-7` (the highest-capability model available) against the same Sunroad fixture with the same Call B prompt reached 7/12 per-year exact — structurally identical failure-mode-class to the sonnet-4 baseline's 6/12 (off-by-one shifts of non-zero values to adjacent years; sum exact in both). A higher-capability model couldn't recover positional information that wasn't in its input. The ceiling wasn't model-capability-bound; the v9 framing's "structural to PDF text extraction" diagnosis seemed reinforced.

But Phase B's recon (Item 4) discovered the framing was wrong. The limitation was structural to **OUR specific extractor's API choice** (`unpdf`'s `extractText({ mergePages: true })` collapses each PDF page's text items to a flat string, discarding the `TextItem.transform` matrices that pdf.js itself preserves). The bundled pdf.js (`unpdf/pdfjs`, accessible via `getDocumentProxy`) exposes `transform[4]` as x-coordinate and `transform[5]` as y-coordinate per text item — the exact positional information needed to recover year-column assignments. The capability was always present in the dep we already had; we just weren't reaching it. `getDocumentProxy` was even already imported elsewhere in the codebase (at `apps/api/src/services/pdf-parser.service.ts:19`). The v9 KNOWN LIMITATION block named the right surface (text extraction strips positions) but generalized the diagnosis to the wrong layer (PDF text extraction in general) when the actual layer was much narrower (`unpdf.extractText`'s flat-text mode). Phase B replaced the AI Call B with deterministic extraction over pdf.js's positional API and achieved 12/12 per-year exact on Sunroad on first run.

**General lesson.** KNOWN LIMITATION blocks that name a structural ceiling should also name the specific API choice that's load-bearing for the ceiling. The pattern that catches the wrong framing: when a KNOWN LIMITATION attributes a ceiling to "PDF text extraction" / "AI extraction" / "the format" / "the model" without naming the specific call site or library function that's structurally constraining the output, the framing is doing too much work. Either the constraint is more specific than the framing claims (and a different API choice in the same library lifts it — the #44 case), or the framing is correct but unverified (and the next ticket pays for re-deriving the answer). In either case, naming the specific API surface in the KNOWN LIMITATION block reduces future-work cost.

The recon question to ask when writing a KNOWN LIMITATION: *can I name the call site (`module.fn(args)`) that's the load-bearing layer here?* If yes, name it explicitly. If no, the recon to find it is part of the KNOWN LIMITATION block's writing — not deferred to a follow-up ticket. The cost of misframing isn't theoretical: v9 §10.6's framing led the recon for #44 to consider Python-subprocess architectures (`pdfplumber`, `tabula`, `camelot`) before discovering pdf.js positional data was already accessible in-Node — a delta the recon caught early but that would have been avoided entirely if the v9 KNOWN LIMITATION had named `unpdf.extractText({ mergePages: true })` as the load-bearing surface rather than "PDF text extraction" generally.

**Practical implication.** Future KNOWN LIMITATION blocks across the codebase (in JSDoc, in spec, in commit messages) should follow the discipline: state the limitation, name the specific load-bearing API choice, distinguish format-structural from choice-structural explicitly. The PCA case is the empirical anchor; the discipline is general. v9 §10.6's original KNOWN LIMITATION text is preserved in the spec as a historical record per the layering discipline — it's now also useful as the canonical example of the framing error this learning corrects.

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

**Implemented in `f94d9f2` (v9).** Phase 2 contract widening reified; both arrays land on `PCAExtraction` and propagate through `AdjustedCapitalReserves` (sibling-shape fields). Assembler-layer `bag['capex_projection']` activated against `capexScheduleInflated`'s sorted-by-year `amount` projection. Sum-of-amounts exact against Sunroad anchor; per-year alignment ~50-60% per the documented known-limitation.

**Decision 2 — Replacement reserves shape**

CHOSEN: no separate annual field; replacement reserves derived downstream from the capex schedule (Decision 1).

Schema: no new field.

Rationale: the PCA itself treats Table 2 as the replacement-reserves source — the page-ii narrative reads "These items are identified in Table 2 – Long-Term Cost Opinion." Decision 1's capex schedule covers it. The per-SF-per-year summary metric the PCA explicitly reports is captured separately via Decision 3. The "how to derive an annual rate from a per-year schedule" question (total/years vs per-SF × NRA vs underwriter judgment) is a builder-side decision belonging to the implementation ticket, not an extraction-shape decision.

**Implemented in `f94d9f2` (v9).** No-op as designed: no separate annual replacement-reserves field shipped. G49 (Replacement Reserves Annual Escrow) in §11.1 reflects this — no builder, deferred downstream-derivation rule belongs to the populator-side ticket.

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

**Implemented in `f94d9f2` (v9).** All four fields shipped on PCAExtraction; extractor populates them from PCA Table 2 footer + page-ii narrative. All four anchor values exact against Sunroad.

**Decision 4 — Structural narrative widening**

CHOSEN: no widening; defer to a future Phase 3.

Schema: existing `structural: { roof, hvac, plumbing, electrical }` preserved unchanged.

Rationale: not load-bearing for the cells Phase 1+2 unlocks (E49/G49/L38/G51 want capex/reserves data); the handbook principles that consume condition data (P-IV-MF-4, P-IV-MHC-1) are LLM_CONTEXT consumers — flat condition-narrative strings serve them as well as a structured rating + narrative split would; widening to 8 systems × 2 fields (rating + narrative) = 16 new contract fields would add scope without proportional value; non-blocking for cell-unlock work. The implementation ticket preserves the 4 existing narrative fields without modification.

**Implemented in `f94d9f2` (v9).** No-op as designed: `structural: { roof, hvac, plumbing, electrical }` preserved unchanged; extractor populates all four narrative strings against Sunroad.

**Decision 5 — Immediate repairs detail**

CHOSEN: aggregate + immediate/short-term split.

```ts
readonly immediateRepairs: number | null;       // preserved
readonly shortTermRepairs: number | null;       // NEW
```

Rationale: the Immediate vs Short-Term distinction is meaningful underwriting data — Immediate items reserve at closing (E49 Replacement Reserves Up Front); Short-Term items inform the year-1+ capex plan and feed into the L38 / E35-M35 broadcasts. PCAs report both columns explicitly in their cost tables. One-field addition (`shortTermRepairs`) is materially less scope than Option C (a full per-line-item array of repair items with descriptions, costs, system categories).

Sunroad anchor values: `immediateRepairs: 19400`, `shortTermRepairs: 0`.

**Note on the existing `nearTermRepairs` field.** The current PCAExtraction contract carries `nearTermRepairs: number | null` ("year 1-5 typically" per existing JSDoc). Decision 5 doesn't explicitly address its fate — `shortTermRepairs` is the new field for the PCA's explicit Short-Term column. The implementation ticket should resolve whether to preserve `nearTermRepairs` alongside `shortTermRepairs` (back-compat for any persisted records), rename it (`shortTermRepairs` IS what `nearTermRepairs` was trying to be), or drop it. Surfaced as an implementation-ticket question, not a §14.1 decision.

**Implemented in `f94d9f2` (v9).** `shortTermRepairs: number | null` field shipped on PCAExtraction. Resolution on the `nearTermRepairs` fate question: **renamed** to `shortTermRepairs` across 13 fixture sites — the rename was the right call because `shortTermRepairs` IS the semantic `nearTermRepairs` was trying to be, per Decision 5's own rationale. No back-compat preserve / drop alternative shipped; persisted records pre-`f94d9f2` would need a one-time migration if rehydration is required (no such records exist in production today). Sunroad anchor: `immediateRepairs: 19400`, `shortTermRepairs: 0` (exact).

**Decision 6 — Utility infrastructure**

CHOSEN: no field; defer entirely. File an explicit follow-up issue for "MHC PCA support" when MHC underwriting work is scoped.

Schema: no new field.

Rationale: the Sunroad anchor fixture is Office; no MHC PCA fixture is available; adding `utilityInfrastructureType` (the field P-IV-MHC-3 and P-IV-MHC-6 would read) without an MHC empirical anchor would create an untested code path. P-IV-MHC-3 and P-IV-MHC-6 stay correctly dormant — they have no MHC PCA data to consume because we don't ingest MHC PCAs today. The MHC ingestion gap is a workstream of its own; the field should land alongside it, not pre-emptively against an Office fixture.

**Implemented in `f94d9f2` (v9).** No-op as designed: no `utilityInfrastructureType` field shipped. Deferred to MHC PCA workstream — follow-up issue #TBD tracks the pre-condition (MHC PCA anchor fixture + ingestion path) and the field-addition itself when MHC underwriting work is scoped.

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
- `nearTermRepairs` fate (Decision 5 note). — **RESOLVED in `f94d9f2`** via rename (see Decision 5 implementation-complete marker).
- Builder-side derivation rule for annual replacement reserves rate (Decision 2 rationale). — **DEFERRED to populator-side ticket** per Decision 2 implementation-complete marker; no builder shipped in `f94d9f2`.
- Whether `evaluationPeriodYears` consistency should be enforced at the contract level (TypeScript can't express `arr.length === field`), at the extractor's post-processing step, or via runtime invariant check. — **Not enforced in `f94d9f2`.** Sunroad anchor has `capexScheduleInflated.length === 12 === evaluationPeriodYears`, but the consistency is informally maintained by the extractor's prompt rather than enforced. If/when a deal surfaces with a divergent length, the gap surfaces in cross-check rather than at extraction.
- Whether the PCA's "Site effective age: 17 years" datum (from page 1 property data table) belongs in PCAExtraction or in PropertyMetadata. — **Not addressed in `f94d9f2`**; the field was not shipped on either contract. Defer to future scoping.

**Implementation summary (v9).** Phase 1+2 SHIPPED in commit `f94d9f2` on main (44 files, +1,211/-85) on 2026-06-02. End-to-end empirical verification against the Sunroad anchor fixture (`apps/api/fixtures/sunroad-centrum-pca.pdf`, commit `431102d`): all 6 scalar anchor values exact match (per Decisions 3 + 5 anchor values above); both capex schedule arrays sum-exact ($354,055 inflated, $315,000 uninflated) with the documented ~50-60% per-year-alignment known-limitation; 4 narrative fields populated (`structural.{roof, hvac, plumbing, electrical}`). Doctrine `scorePcaCoverage` semantic preserved by adding the new sibling field `upfrontReplacementReserves` rather than rewiring `upfrontCapex` — the Step 5 architectural near-miss captured in §11.4 E49 framing correction (v9). `JUDGMENT_ENGINE_MANIFEST` entry appended: `'1.2': 'a34151a7568cf30e31fab531ab3dd95af6b4190f6609ce7fb124fc44c6144bf5'`. Note on the consolidated Phase 2 schema (lines above): the schema documents the v8 design intent, which preserved `nearTermRepairs` alongside the new `shortTermRepairs`. The actual ship resolved Decision 5's surfaced question by renaming `nearTermRepairs` → `shortTermRepairs` (one field, not two); the schema block above is therefore one field over-count relative to the actual contract. The discrepancy is intentional — the schema is the v8 design record, the rename-resolution lives in the Decision 5 implementation-complete marker.

### 14.2 (Placeholder for future contract design decisions)

The §14.1 entry establishes the format for this section. Future contract design conversations capture under §14.2, §14.3, etc. This is a forward-looking section type, expected to grow as more design-then-implement workstreams reach the design-done / implementation-pending stage.

---

## Cross-references

- Tracking ticket: [#41 — UW Template Populator — deferred pending extraction coverage](https://github.com/isaint-jean/cre-credit-committee/issues/41)
- Related: [#35 — Handbook: surface upstream data fields required by inert deterministic checks](https://github.com/isaint-jean/cre-credit-committee/issues/35) (Bucket 2 / S&U tracked as item 10)
- Related: [#38 — Extract per-period pro-forma arrays from seller UW models](https://github.com/isaint-jean/cre-credit-committee/issues/38) (Bucket 3 / multi-period)
- Related: [#39 — Promote PropertyMetadata to spine record with FK to ExtractionResult](https://github.com/isaint-jean/cre-credit-committee/issues/39) (Type X surface candidates in Bucket 6)
- Related: [#42 — T-12 vacancy cascade sign-convention bug](https://github.com/isaint-jean/cre-credit-committee/issues/42) (filed during D.3 implementation)
- Related: [#43 — P-IV-RET-6 cumulative-cash-flow check dormant](https://github.com/isaint-jean/cre-credit-committee/issues/43) (filed during C.2 implementation; advanced to 2/4 missing in `f94d9f2` — see §10.9)
- Sibling target registry in code: `apps/api/src/services/field-authority.registry.ts` (1563 lines, ~80 cells declared against future-state UnderwritingContext shape)

**Implementation tickets shipped against this spec:**
- `83328b4` (2026-05-29) — D.3 SellerUW triplet back-fill (§3.5, §10.1-10.2).
- `c936008` (2026-05-31) — C.2 OperatingStatementExtraction Phase 1+2 widening (§10.3-10.5).
- `f94d9f2` (2026-06-02) — PCA producer Phase 1+2 (§10.6-10.9, §14.1 implementation-complete markings, §11.4 v9 framing correction).
- `<SHIP-HASH>` (2026-06-03) — PCA capex-schedule year-alignment improvement (resolves #44; §§10.10-10.13, §11.4 v10 layered correction, §13.7 process learning).

**Anchor fixtures used for empirical verification:**
- `apps/api/fixtures/sunroad-centrum-pca.pdf` — Sunroad-Centrum PCA (committed `431102d`, Partner Engineering ASTM E2018-15 report). Anchor for §14.1 Decisions 1, 3, 5 and the `f94d9f2` end-to-end verification per §10.6. Also the empirical anchor for the v10 deterministic-extraction acceptance check (12/12 per-year exact on both inflated and uninflated arrays, see §10.10).

**Cosmetic gaps recorded (no follow-up issues filed):**
- `CallBResult` type name in `apps/api/src/services/extract-pca.ts` — historically named for the AI Call B parser; post-v10 produced by the deterministic extractor and wrapped to this shape. Name retained for merge-interface stability; recorded in §10.10's body as known cosmetic gap to be cleaned up alongside any future PCA-adjacent ticket. Not filed as a GitHub follow-up issue (well under 30 lines of rename + 3 reference updates; too small for issue ceremony).

**Follow-up issues (filed in Sub-step 9.3 of the PCA producer ticket):**
- [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44) — **CLOSED in `<SHIP-HASH>` (v10).** PCA capex-schedule year-alignment improvement resolved via deterministic extraction in `apps/api/src/services/extract-pca-schedule.ts`; 12/12 per-year exact on Sunroad. The v9 framing of the limitation as "structural to PDF text extraction" was corrected — the limitation was choice-structural (`unpdf`'s flat-text path); pdf.js's positional API was always accessible. See §§10.10-10.13 for the shipped behavior changes and §13.7 for the codified process learning.
- [#46](https://github.com/isaint-jean/cre-credit-committee/issues/46) — `extraction_input_cache` table `pca_hash` column migration. Per §13.5 Step 4 finding: the `ExtractionInputKeyArgs.slotHashes` shape was widened in `f94d9f2` to include `pca: ContentHash | null` for cache-distinguishing correctness, but the storage-table schema does not yet have a `pca_hash` column. Production impact today is debug-info-only (cache lookups already correctly distinguish PCA-vs-non-PCA via the composite `cache_key` hash); the missing column affects only admin / observability surface. Issue body lays out the migration shape via the existing `migrateAddColumns()` idempotent shim. **Note (v10):** the `EXTRACTION_ENGINE_VERSION` 1.4 → 1.5 bump in `<SHIP-HASH>` (see §10.11) doesn't address the storage-schema gap — pre-bump entries become orphan, new post-bump entries still write through the column-incomplete schema. Slightly accelerated urgency; not a re-prioritization.
- [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) — Test fixture cast-discipline cleanup. Per §13.6: replace contract-type `as unknown as` casts (the AdjustedInputs / HydratedRecordGraph / AssemblerInputs / PropertyMetadata family — ~27-28 occurrences across ~10 target types) with proper full-contract literals so runtime values match the contract. Express Request/Response mock-casts (53 occurrences) explicitly out-of-scope per the recon split. Until this ships, assembler-layer reads use loose `!= null` rather than strict `!== null`.
- [#47](https://github.com/isaint-jean/cre-credit-committee/issues/47) — `package.json` test-script aliases sweep. 15 test files in `apps/api/src/scripts/` are not registered as `test:*` aliases in `apps/api/package.json` (surfaced when `npm run test:extraction-input-cache` returned "no such script" during PCA implementation). Sub-recon also surfaced a reverse-direction asymmetry of 6 orphan aliases pointing to files that no longer exist; the issue body notes this as an optional sibling cleanup for whoever picks up the work.
