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
- **v10 — 2026-06-03.** PCA capex-schedule year-alignment improvement SHIPPED (commit `b6323fb` on main; replaces the AI Call B path with deterministic extraction via `pdfjs-dist`'s positional API). Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). The v9 §10.6 KNOWN LIMITATION block (which framed schedule-array year-by-year accuracy of ~50-60% as PDF-format-structural — text extraction stripping column positions) is corrected: the limitation was extractor-choice-structural. `unpdf`'s `extractText({ mergePages: true })` strips positions; the bundled pdf.js (`unpdf/pdfjs`) exposes `TextItem.transform` per item, accessible through `getDocumentProxy` which was already imported elsewhere in the codebase. Phase A of the implementation (model-upgrade experiment: `claude-opus-4-7` with the same Call B prompt against the same Sunroad fixture) confirmed the ceiling wasn't model-capability-bound — Opus reached 7/12 per-year exact, structurally identical failure-mode-class to the sonnet-4 baseline's 6/12. Phase B replaced Call B with `apps/api/src/services/extract-pca-schedule.ts`: scans pages for a year-header row matching multi-pattern `/^YR\s*\d+$/i | /^Year\s*\d+$/i | /^\d{1,2}$/ | /^\d{4}$/`, builds a `year → x` map, reads the explicitly labeled `INFLATED TOTALS:` and `UNINFLATED TOTALS:` rows by year-column x-lookup. Sunroad acceptance check: **12/12 per-year exact** for both inflated and uninflated arrays; sum exact ($354,055 inflated, $315,000 uninflated); all 6 Call A scalar anchors and 4 narrative anchors unchanged. `EXTRACTION_ENGINE_VERSION` bumps `'1.4'` → `'1.5'` (id-space rotation — same shape, different per-entry values for any PCA where the prior AI ceiling produced misaligned years); `PCA_ADAPTER_VERSION` bumps `'1.0'` → `'1.1'` (signature widening: the adapter now threads `slot.buffer` through to the deterministic extractor, since pdf.js's positional API needs the raw bytes the prior flat-text path discarded). Net code-line delta in `extract-pca.ts`: **-155 lines** (the Call B AI infrastructure removed exceeds the deterministic call site added); a new 320-line module ships at `extract-pca-schedule.ts`. Four new §10 entries: §10.10 #44 ship details; §10.11 EEV bump; §10.12 PAV bump; §10.13 KNOWN LIMITATION resolution + v9 framing correction. New §13.7 process learning codifies the framing-discipline lesson: when documenting a KNOWN LIMITATION, distinguish format-structural from choice-structural — name the specific API surface that's load-bearing so future readers can evaluate whether a different choice would lift the ceiling. §11.4 receives a FOURTH layered correction noting the year-alignment limitation's resolution. §11.1 E35-M35 row updated to remove the KNOWN LIMITATION reference. §10.6's KNOWN LIMITATION block gets a 1-sentence forward-pointer to §10.13. §9 item 2 marks PCA year-alignment as the fourth completed implementation ticket; §9 item 5 receives a v10 layered note closing the PCA producer line entirely. No contract changes, no JE rule changes, no JUDGMENT_ENGINE_MANIFEST additions; `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`.
- **v11 — 2026-06-04.** §12 Analysis page upgrade graduates from stub (v3) to workstream section, integrating `docs/legacy-reduction-plan.md` by light reference. The §12 scoping recon surfaced that the v3 stub had drifted materially from codebase reality — the stub claimed "no spec exists" and "legacy version is currently degraded" when `legacy-reduction-plan.md` (440 lines, drafted post-6.8 + caching + observability + consumer-migration-v1) is the canonical operational spec and Phase 1 had already shipped 5 expansions (render versions 6.8 → 7.2: D04 findings, D09 doctrine.components, D16/D17 income/expense lines, D20 stress scenarios, D21 loan section, plus D18 metrics already-covered). v11 brings §12 into line: new §12.0 preamble preserving the v3 stub content with graduation note; §12.1 phase-level summary table (6 rows mirroring `legacy-reduction-plan.md` §7's 5-phase sequencing, light-integration per Decision B); §12.2 brief migration-phase prose; §12.3 dependencies on Tier B + extraction coverage (concrete via `AdjustedInputs` projection paths, partially-already-fulfilled via the rendered surface); §12.4 product-decision territory (the 7 Phase-5 items: research feature, B-piece decision, mitigations, improvement suggestions, comments/edits, audit log UI, compare); §12.5 open issues + cross-references ([#24](https://github.com/isaint-jean/cre-credit-committee/issues/24) AdjustedAssumptions projection, [#40](https://github.com/isaint-jean/cre-credit-committee/issues/40) narrative producer, [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41) populator parallel). §9 item 4 prose rewritten to reflect "workstream ongoing" not "scoping session pending." §9 item 2 fourth-ticket marker gains an inline v11 note: the "analysis page upgrade per §12" peer-candidate framing is post-v11 outdated — the work is parallel-track ongoing rather than implementation-ticket-gate-waiting. §11.0 preamble gains a v11 layered note acknowledging partial-fulfillment of the Tier-B-needs-analysis-page-as-surface claim (the new spine already surfaces some Tier B via D09/D16/D17/D21; the original "Populator → analysis page" sequencing assumed two separate workstreams that have evolved largely independently). New §13.8 process learning codifies the spec-stub-currency discipline lesson: spec stubs predictably drift from codebase reality; scoping sessions should recon-first before drafting against stub framing. §13.7 gains a cross-reference back to §13.8 noting the related failure-mode-class at a different abstraction layer (limitation-framing vs work-state-framing; both are spec-vs-reality drift). `legacy-reduction-plan.md` itself unchanged. No code shipped; v11 is design + documentation only. No EEV / JE_VERSION / contract changes.
- **v12 — 2026-06-05.** [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24) AdjustedAssumptions render-side projection SHIPPED (commit `413e93f` on main). **First render-side implementation ticket** — prior shipped tickets (D.3, C.2, PCA Phase 1+2, PCA year-alignment) were all extraction-side. `RenderedAnalysis` widens with a `RenderedAssumptionsSection` (4 fields: `capRate`, `terminalCapRate`, `rentGrowthPct`, `expenseGrowthPct`) projected from `AdjustedInputs.assumptions` via the existing `projectLineItem` helper — 1:1 passthrough mirroring the D21 loan-section idiom. `RENDER_VERSION` bumps `'7.2'` → `'7.3'` (id-space rotation: new section means new content-hash for any RenderedAnalysis; cache wrapper auto-handles the version split). Frontend whitelist updated in `apps/web/src/lib/uw-edit-utils.ts`: 4 new paths added to `EDITABLE_PATHS` (16 → 20 total) and to `PERCENT_PATHS` (3 → 7 total). RenderedAnalysisView gains an Assumptions section mirroring the income/expense/loan LineItemTable pattern. Empirical anchor: `test-render-underwriting-context.ts` at **590/590 passing** (+19 new assumptions assertions); bijection check confirms exactly-4-fields shape; 9 adjacent test suites unaffected (974/974 total assertions across the sweep). One §10 entry shipped (§10.14 — light v12 framing); no new §13 process learning (the 8 deltas captured during this ticket are §13.5/§13.8 instances at multiple drafting layers — recon / implementation / brief-design / enumeration / composition — not a new failure-mode-class). §12.5 [#24] line updated from OPEN → CLOSED. §12.3 AdjustedAssumptions bullet receives v12 layered note (resolved dependency). §12.1 Phase 2 row's `[#24] adjacent` parenthetical updated to mark closure. §9 item 4 receives v12 layered note acknowledging [#24] closure (Phase 2 work continues via [#40] narrative producer). The 8-delta capture is the substantive content of §10.14: 5 at implementation-time layers (recon trace miss; fixture-count high-end-of-range; brief ordering assumption broken by TypeScript strict mode; buildPath cascade; pre-existing `new Date` discipline violation surfaced by `test-client-rendered-discipline.ts` — not introduced by #24, recorded per the §10.10 cosmetic-gap convention) + 3 at brief-drafting layers (enumeration brief missed §12.3 bullet update; meta-observation that brief drafts predictably miss inline structural-fact updates under light-amendment framing; composition-layer volume-estimate overstated source-line reality — caught at composition-time `wc -l` reality-check). The §13.5 pattern persists across render-side work despite different ticket shape; it also persists at the brief-drafting layer despite the recon-first discipline applied at lower layers. `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`; no EEV bump; no contract changes beyond the render-contract widening. Net SPEC.md addition ~35 lines — lighter than v11's 117-line / v10's 128-line precedent. (The v12 enumeration brief estimated 70-90 net lines, and the v12 revision-history draft initially claimed ~85; both were composition-author overstatements caught at composition-time per the §13.5 pattern at the composition layer — see §10.14 Delta 8.)
- **v13 — 2026-06-06.** §13.6 fixture cast-discipline cleanup SHIPPED across a 4-commit arc closing [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) and [#48](https://github.com/isaint-jean/cre-credit-committee/issues/48). **First process-driven implementation ticket** — prior shipped tickets (D.3, C.2, PCA Phase 1+2, PCA year-alignment) were all extraction-side and v12's #24 was render-side; this arc is the first whose substantive content is test-discipline cleanup with one assembler-layer behavior tightening. The 4-commit arc: `b11098d` (#48 factory-pattern cleanup in `test-handbook-field-bag.ts` + `assembler.ts:252` loose-to-strict `!== null` tightening — the lone production-behavior change — + smoke-e2e sibling fixture correction per Delta G); `c8b7dc6` (#45 sub-pass 1 — 11 branded-type narrowings to single-cast per §13.6 acceptance (a)); `69a5066` (#45 sub-pass 2 — `AssemblerInputs` full-shape factory in smoke-e2e via file-local `makeSmokeInputs`); `27e6d3e` (#45 semantic-claim JSDoc per §13.6 acceptance (b)). 14 of 14 #45 in-scope contract-type casts cleaned + 3 of 3 #48 in-scope factory-pattern casts cleaned + 1 semantic-claim formally justified (17 arc total; see §10.15 for accounting detail); 11 sites deferred per the recon reclassification (3 RecordGraphStore → [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) architectural ticket to be filed; 7 DI escape-hatch → out-of-§13.6-scope per the recon split; 1 `typeof er` semantic-claim → §13.6 (b) justified in 27e6d3e). One §10 entry shipped (§10.15 — single-section per the β-framing decision: ONE behavior change across multiple commits; body documents the cleanup arc). §13.6 receives a layered note (v13) acknowledging cleanup completion; original loose-`!= null` framing preserved as historical record per the layering discipline. §9 item 2 receives a fifth-ticket entry with process-driven framing (the prior 4 sequence-entries were all extraction-side; v12's #24 went into §9 item 4 via the §12 workstream; this is the first non-extraction non-render entry in §9 item 2's sequence). Cross-references section also bundles in #47 close-out (`62b9f24`, the package.json aliases sweep — shipped 2026-05-26 but cross-references still framed it as OPEN follow-up; corrected in this revision per the §13.8-shape drift the framing represented). One process-discipline observation worth recording (kept inline in §10.15, not a new §13.x entry): the b11098d assembler-tightening surfaced a sibling-file fixture-leak in smoke-e2e (Delta G) that the loose `!= null` had masked — caught in flight, corrected in same commit; the §13.6 discipline already covers this failure-mode-class, so the corrective response is a recon-discipline refinement (broader consumer-coverage grep before tightening) rather than new §13.x codification. `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`; no EEV bump; no contract changes; one runtime check tightened at `assembler.ts:252` (same-semantic correctness improvement against contract-conforming values). `SHIP-HASH` placeholder at `assembler.ts:249` resolved to `b11098d` in this same commit per the path-α pattern (v13 is therefore docs + 1-line code, not purely docs-only — first amendment commit to carry a code change since the SHIP-HASH placeholder pattern was introduced).
- **v14 — 2026-06-07.** [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) Phase 1 SHIPPED in `e4dfa86`: first interface-segregation cleanup against `RecordGraphStore`. **Second process-driven implementation ticket** documented — sibling-precedent to v13's §10.15 (test-fixture-cleanup arc), not a continuation. New `HandbookEvaluationReadStore` interface co-located in `record-graph-store.ts` (2-method subset of the 43-method class); `handleHandbookEvaluationRead` parameter narrowed from the full class to the interface; production singleton satisfies via width-subtyping. Site 1 cleanup at `test-handbook-evaluation-route.ts:76` removes the `as unknown as RecordGraphStore` cast via full-shape `RevisionLineageEnvelope` construction (new file-local `makeEnvelope` helper). Sites 2+3 at `test-build-and-ingest-route.ts:210`/`:797` retained with §13.6 (b) JSDoc — cascade-narrowing through `ingestExtractionResult` (which itself calls 9 store methods) requires deeper architectural work outside the (α'-hybrid) cleanup scope, deferred to a dedicated architectural ticket if appetite arises. One §10 entry shipped (§10.16 — second process-driven §10 entry, sibling-precedent framing per the v14 SPEC-section decision). §13.6 receives a v14 layered note acknowledging partial cleanup, inserted immediately after the v13 layered note per chronological-layering convention; v13 layered note and original loose-`!= null` framing below preserved as historical record. §9 item 2 receives a sixth-ticket entry framing #49 Phase 1 as second process-driven ticket (parallel to v13's fifth-ticket, not appended — sibling-precedent consistency with §10.16). Cross-references touches per Deltas L+M (orient): #49 line updated from `*to be filed*` placeholder to PARTIALLY RESOLVED with reference to §10.16; #45 line at the original "3 RecordGraphStore deferred" framing tightened to "1 of 3 cleaned in v14 via interface segregation; 2 cascade-deferred per §13.6 (b)". Two process-discipline observations captured inline in §10.16 (kept tight per the v14 framing decision, not a §10.14-style 8-delta enumeration): Delta K (recon-layer §13.5 manifestation — the cast at Site 1 was hiding TWO failure-modes, not one, leading to a ~4× LOC under-estimate at Step 3 recommendation; generalizable discipline takeaway: "what TWO things might this cast be doing?" before estimating cleanup scope) and the cascade-narrowing barrier observation (first time the "narrowing forces downstream cascade" structural problem surfaced; worth naming as a recognizable pattern for future RecordGraphStore narrowings). `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`; no EEV bump; no contract changes; no production-behavior change (v14 ship is interface declaration + parameter type narrowing + test-fixture cleanup — all type-level, zero runtime difference). Unlike v13's amendment, v14 is purely docs (e4dfa86 had no placeholders to resolve in non-SPEC files); v14 amendment commit therefore lands as docs-only per the original v9-v12 cadence.
- **v15 — 2026-06-08 (this revision).** AppraisalExtraction producer scoping session. §14.2 decisions document drafted (replacing the v8 §14.2 placeholder), capturing 7 contract-design decisions across architectural-shape (3), phase-scope (3), and one detailed-deferred (anchor fixture); 3 additional deferred decisions listed without per-decision detail (C14 disposition, joint-extractor vs separate-call architecture, adapter pattern fit) — all four deferrals explicit for next-session pickup. **Critical scoping reframing — Delta P**: the current AppraisalExtraction contract (3 fields: valueConclusion, capRate, methodology) serves the *valuation anchor* purpose only — its outputs flow through narrative-facts → valuation engine for the final-value anchor. The Bucket 4 operating-statement cells (13) and Bucket 6 descriptor cells (8) that §5.2 attributed to the "appraisal producer workstream" are NOT addressable from the 3-field contract; they require a multi-record producer that writes to AppraisalExtraction (anchor-fields widening) + a new operating-statement sub-record (Phase 2) + PropertyMetadata extensions (Phase 3). The "what TWO things might this contract be doing?" recon discipline from Delta K applied at the contract-design layer surfaced the reframing. The original naive scoping mental-model — "mirror PCA: widen AppraisalExtraction from 3 to ~12 fields, single ticket" — would have mis-framed the work by a wide margin; the actual scope spans 3 sub-records across 3 implementation tickets. §5.2 receives a v15 layered note acknowledging the multi-record reframing without rewriting the original ghost-contract framing per the §13.6/§13.8 layering discipline. §11.4 receives a new item 6 (appended to avoid renumbering items 4 + 5) covering the appraisal producer sequencing — multi-record scope, 3-phase split, I9 separation, anchor fixture deferred, comparable cell-unlock count to PCA's full arc (~21 cells across Bucket 4 + Bucket 6 + valuation anchor extensions). **Delta Q** (Step 2 of v15 orient): §11.4 didn't pre-stage appraisal-producer sequencing — PCA got item 1, OperatingStatementExtraction got item 2, I9 got item 3, but appraisal was mentioned only in passing in item 1's C14 carve-out. v15 closes that documentation gap. No §10 entry per the v11 precedent for docs-only design/scoping amendments — substantive narrative carried by this revision history entry + §14.2 itself; §10 is reserved for behavior-change documentation, and v15 ships zero production code. Two new deltas captured inline in §14.2's opening paragraph rather than as new §13.x entries: Delta P (contract-design-layer manifestation of the §13.5 "what TWO things" pattern; the AppraisalExtraction contract was hiding the multi-record scope under its single-contract name) and Delta Q (§11.4 sequencing documentation gap — same §13.8 spec-stub-currency family; the original §11.4 drafting predated the producer-by-producer scoping cadence the project adopted). `JUDGMENT_ENGINE_VERSION` stays at `'1.2'`; no EEV bump; no contract changes; v15 is a pure design/scoping amendment per the original v8 PCA-scoping precedent (which was also docs-only). v15 amendment commit therefore lands as docs-only; no SHIP-HASH or other code-side placeholders to resolve.

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

**Update (v15).** Multi-record producer reframing per §14.2 (v15 scoping session). The v4 ghost-contract framing above scoped the appraisal-producer work as "widen `AppraisalExtraction` from 3 to N fields" — a single-contract widening pattern mirroring the PCA precedent. v15 recon (Delta P) surfaced that the framing was incomplete: the contract's 3 fields serve the *valuation anchor* purpose (flowing through narrative-facts to the valuation engine), while the Bucket 4 operating-statement cells (13) and Bucket 6 descriptor cells (8) require a *different* sub-record (new `AppraisalOperatingStatement` field on ExtractionResult, sibling to `sellerUwOperatingStatement`) and the *existing* PropertyMetadata contract (8-field extension). The "appraisal producer" workstream therefore writes to 2-3 sub-records, not 1. The v4 joint-extractor design observation parenthetical above anticipated this (the "two sub-records" framing was already present); v15 explicitly commits to multi-record architecture and resolves it into a 3-phase implementation arc — Phase 1 anchor-fields widening + Phase 2 operating-statement sub-record + Phase 3 PropertyMetadata descriptor extensions. See §14.2 for the seven contract-design decisions and §11.4 item 6 for sequencing. Original v4 framing above preserved per the §13.6/§13.8 layering discipline; v15 reframes scope without rewriting history.

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

   **Fourth implementation ticket — COMPLETED `b6323fb` (2026-06-03).** PCA capex-schedule year-alignment improvement shipped as the fourth implementation ticket after D.3, C.2, and PCA Phase 1+2. Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). Replaces the AI Call B path inside `extract-pca.ts` with deterministic extraction via `pdfjs-dist`'s positional API in a new module at `apps/api/src/services/extract-pca-schedule.ts`. Call A (scalars + structural narratives) is unchanged. `EXTRACTION_ENGINE_VERSION` bump (`'1.4'` → `'1.5'`) + `PCA_ADAPTER_VERSION` bump (`'1.0'` → `'1.1'`, signature widening to thread `slot.buffer` through to the deterministic extractor) + 7 mechanical fixture-version updates. **No contract changes; no JE rule changes; no JUDGMENT_ENGINE_MANIFEST additions.** Production-behavior changes documented in §10 Behavior change log §§10.10-10.13. Empirical anchor: 12/12 per-year exact match against the Sunroad fixture's INFLATED + UNINFLATED totals rows (the v9 §10.6 ~50-60% accuracy limitation is fully resolved on this fixture); see §13.7 for the process-learning generalization about KNOWN LIMITATION framing discipline that the ticket's recon surfaced. The implementation-ticket gate from v5 remains open; with #44 closed, the visible peer candidates above (I9, OperatingStatementExtraction extensions, AppraisalExtraction producer, analysis page upgrade) are unchanged. **Update (v11):** the "analysis page upgrade per §12" peer-candidate framing is now outdated — §12 graduated to workstream section in v11; the work is parallel-track ongoing (Phase 1 shipped at render versions 6.8 → 7.2 per `legacy-reduction-plan.md`), not implementation-ticket-gate-waiting. The remaining visible peers reduce to three: I9, OperatingStatementExtraction extensions, AppraisalExtraction producer.

   **Fifth implementation ticket — COMPLETED `b11098d` + sweep arc `c8b7dc6` / `69a5066` / `27e6d3e` (2026-05-26 → 2026-05-28).** §13.6 fixture cast-discipline cleanup arc shipped as the fifth implementation ticket — **first process-driven implementation ticket** in this sequence (prior 4 entries were extraction-side; v12's #24 was render-side but went into §9 item 4 via the §12 workstream, not this sequence). The arc closes [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) (14 of 14 in-scope contract-type cast sites cleaned + 1 semantic-claim formally justified per §13.6 acceptance (b)) and [#48](https://github.com/isaint-jean/cre-credit-committee/issues/48) (factory-pattern cleanup in `test-handbook-field-bag.ts` + `assembler.ts:252` loose-to-strict `!== null` tightening — the lone production-behavior change in the entire arc — + smoke-e2e sibling fixture correction per the Delta G class catch). The 4-commit arc spans b11098d (#48 ship + sub-pass 0 cleanup + the tightening), c8b7dc6 (#45 sub-pass 1 — 11 branded-type narrowings to single-cast `as <BrandedId>` per §13.6 acceptance (a)), 69a5066 (#45 sub-pass 2 — `AssemblerInputs` full-shape factory in smoke-e2e via file-local `makeSmokeInputs`), and 27e6d3e (#45 semantic-claim JSDoc per §13.6 acceptance (b)). 11 cast sites deferred per the recon reclassification: 3 RecordGraphStore (class-stub-not-interface pattern, architectural — deferred to [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) to be filed); 7 DI escape-hatch (private-field inspection — not §13.6 scope, noted in #45's close-out); 1 `typeof er` semantic-claim (documented per §13.6 (b) in 27e6d3e). Production-behavior change documented in §10 Behavior change log §10.15 (single-section per the β-framing decision). The implementation-ticket gate's visible peer candidates from the v10 update are unchanged.

   **Sixth implementation ticket — COMPLETED `e4dfa86` (2026-05-27).** [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) Phase 1 — first interface-segregation cleanup against `RecordGraphStore` shipped as the sixth implementation ticket. **Second process-driven implementation ticket** in this sequence; sibling-precedent to the fifth-ticket §13.6 fixture-cleanup arc (not a continuation — distinct architectural pattern: interface segregation against a class without natural interfaces, applied selectively where the consumer handler is terminal). New `HandbookEvaluationReadStore` interface co-located in `record-graph-store.ts` (2-method subset of the 43-method `RecordGraphStore`); `handleHandbookEvaluationRead` parameter narrowed from the full class to the interface; production singleton satisfies via width-subtyping. Site 1 cleanup at `test-handbook-evaluation-route.ts:76` removes the `as unknown as RecordGraphStore` cast via full-shape `RevisionLineageEnvelope` construction (new file-local `makeEnvelope` helper). Sites 2+3 at `test-build-and-ingest-route.ts:210`/`:797` retained with §13.6 (b) JSDoc — cascade-narrowing through `ingestExtractionResult` (which itself calls 9 store methods) requires deeper architectural work outside the (α'-hybrid) cleanup scope. Production-behavior change documented in §10 Behavior change log §10.16. The implementation-ticket gate's visible peer candidates from the v10 update are unchanged (I9 Concluded Cap Rate Tier B greenfield; AppraisalExtraction producer; OperatingStatementExtraction widenings).
3. **Tier B workstream — coverage-gap recon COMPLETED 2026-05-31.** See §11 for the full inventory + gap-pattern analysis. The §9 candidates intersect with Tier B work; see §11.4 for suggested sequencing. The workstream design is no longer a blocking task — the gap patterns provide the design.
4. **§12 analysis page workstream — ongoing.** Updated v11: graduated from stub to workstream section. Phase 1 shipped 5 expansions via `docs/legacy-reduction-plan.md` §7 (render versions 6.8 → 7.2: D04 findings, D09 doctrine.components, D16/D17 income/expense, D20 stress, D21 loan). Phase 2 producer work tracked at [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24) (AdjustedAssumptions projection) and [#40](https://github.com/isaint-jean/cre-credit-committee/issues/40) (narrative producer). Phases 3-5 (lineage/audit visibility, editable rendered semantics, sunsets) per the legacy-reduction-plan sequencing. See §12 for the workstream section + phase structure; `legacy-reduction-plan.md` is the canonical operational doc. **Update (v12):** [#24] closed in `413e93f` (see §10.14 for ship details — first render-side implementation ticket; RENDER_VERSION 7.2 → 7.3). Phase 2 work continues via [#40] (narrative producer) plus D05 cross-check producer refactor and D08 manifesto-evaluation projection still pending.
5. **Extractor surface sweep:** A targeted sweep of all current extractors (legacy POST extraction services, AI-tier extractors, regex-based extractors) to surface other "extractor exists but narrowly applied / unfilled" patterns. Three instances surfaced across the three recon cycles: `uw-intelligence.service.ts` repoint candidate for loan structural terms, `AppraisalExtraction` ghost contract, `extractComparablesLinkageRefs` narrow regex output. A single sweep would either find 2-3 more Type X recovery candidates or confirm none exist; either way it makes first-ticket selection sharper. Not auto-scheduled; treat as a peer candidate to the other four next steps. **Cross-reference (v6):** the Piece 4 sweep's D.2 PCAExtraction ghost-contract finding maps to Tier B Category 2 in §11.2 (5 cells gated on PCA producer); its C.2 OperatingStatementExtraction narrow-output finding maps to Tier B Category 3 in §11.2 (3 cells gated on contract widening). **Update (v8):** the PCA producer scoping is now in progress — recon completed, anchor fixture committed at `431102d`, and six contract decisions closed in §14.1. Implementation ticket TBD; this candidate is no longer "next candidate, unscoped" — it is "scoped, awaiting implementation." **Update (v9):** PCA producer Phase 1+2 SHIPPED in `f94d9f2`. This candidate is now closed; see §§10.6-10.9 for the shipped behavior changes and §14.1 for the implementation-complete markings against each of the six Phase 2 contract decisions. With PCA closed, the v6 sweep's remaining two candidates (AppraisalExtraction ghost contract per §5.2; `extractComparablesLinkageRefs` narrow regex output per §3.4) become the visible peers if the sweep pattern continues. **Update (v10):** the PCA producer line is now fully closed end-to-end — the year-alignment quality improvement (#44) shipped in `b6323fb` replaces the AI Call B path with deterministic extraction (see §§10.10-10.13). No further PCA-producer-line follow-up work is anticipated; the visible peer candidates from the v9 update are unchanged.
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

### 10.10 PCA capex-schedule year-alignment improvement (`b6323fb`, 2026-06-03)

Resolves [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44). Replaces the AI Call B path inside `extract-pca.ts` with deterministic extraction via `pdfjs-dist`'s positional API in a new module at `apps/api/src/services/extract-pca-schedule.ts`. Call A (scalars + structural narratives) is unchanged. The merge layer at `buildPcaFromAiResponses` is unchanged — the deterministic result is wrapped in the existing `CallBResult` shape before merge, so the partial-success policy (null on either side) carries over unchanged. (The `CallBResult` type name is retained for merge-interface stability; treat the field set as the contract, not the name. Cosmetic naming gap recorded here in lieu of a follow-up issue — the rename is well under 30 lines and isn't blocking anything; future-CC reading the merge function should follow the trail back through this entry.)

Implementation flow in the new module: scan pages for a y-bucket of items matching multi-pattern `/^YR\s*\d+$/i | /^Year\s*\d+$/i | /^\d{1,2}$/ | /^\d{4}$/` (handles "YR N", "Year N", bare integers, or 4-digit calendar years — covers reasonable PCA-vendor variation); sort by x to build `year → x` map (year = index + 1); locate the explicitly labeled `INFLATED TOTALS:` and `UNINFLATED TOTALS:` rows via text-content match at low x; for each year-x position in the totals row, find the nearest dollar item within ±8 user-space units. Zero-cell-by-absence (no item within tolerance → amount = 0). Returns `null` overall if no page presents a year-header row with at least one totals row; per-array null if a specific totals label is absent. Totals-row-only v1: per-line-item summation fallback deferred to a future multi-vendor follow-up if a PCA surfaces without explicitly labeled totals.

Adapter signature widened to thread the raw PDF bytes through. The prior `extractPca(document: ParsedDocument)` signature didn't carry the buffer (it was consumed and discarded by `parseDocument` upstream). The new `extractPca(document: ParsedDocument, pdfBuffer: Buffer)` preserves the bytes alongside the parsed intermediate so the deterministic extractor can call `getDocumentProxy` on them. The change propagates through `runPcaAdapter(slot)` → `runPcaAdapterOnDocument(doc, hash, pdfBuffer, deps)` → `deps.extractPca(doc, pdfBuffer)`. Test mocks were unaffected: the `runPcaAdapter` mock at `test-build-extraction-result.ts:222` operates at the slot level (where `slot.buffer` is already in scope), not at the inner `extractPca` level.

Net code-line delta in `extract-pca.ts`: **-155 lines** (the removed Call B AI infrastructure — `PCA_CALL_B_SYSTEM`, `buildCallBPrompt`, `parseAiPcaCallBResponse`, the private `parseScheduleArray` helper, and the parallel `Promise.allSettled` orchestration — exceeds the deterministic call site added). The new module ships at 320 lines including JSDoc + exported helpers (`groupItemsByY`, `findYearHeaderRow`, `buildYearXMap`, `parseDollarAmount`, `findNearestItemByX`, all exported for test discipline per the existing pure-parser convention).

Empirical verification against the Sunroad anchor fixture (`apps/api/fixtures/sunroad-centrum-pca.pdf`, committed at `431102d`): **12/12 per-year exact** on both inflated and uninflated arrays (vs. the v9 baseline 6/12 inflated exact and a v10-Phase-A `claude-opus-4-7` upgrade attempt that reached 7/12 with the same prompt — confirming the ceiling wasn't model-capability-bound). Sums exact ($354,055 inflated, $315,000 uninflated). All 6 Call A scalar anchors and 4 narrative anchors unchanged (Call A is structurally untouched). Wall-clock: 10.8s overall (parity with the prior architecture — Call A dominates the parallel block; the deterministic schedule extractor completes in well under 1s but waits inside `Promise.allSettled`).

Process-discipline note: this ticket surfaced 6 brief-vs-codebase deltas across recon and implementation (Step 1 buffer-access misframing in the original Item 2 sketch; Step 2 signature simplification + buffer threading + parallel orchestration + multi-page edge case; Step 4 missing npm script aliases for `test:build-extraction-result` + nonexistent `test-apply-judgment-adjustments.ts`). All caught in flight; zero rework. The §13.5 pattern (briefs from chat predictably miss codebase deltas) persists; v9 §13.5's count is frozen as a PCA-producer-ticket historical record, and v10's count is captured here as evidence the discipline transfers across tickets.

### 10.11 EXTRACTION_ENGINE_VERSION bump 1.4 → 1.5 (`b6323fb`, 2026-06-03)

`EXTRACTION_ENGINE_VERSION` bumped from `'1.4'` to `'1.5'`. The PCAExtraction contract shape is unchanged, but the per-entry values change for any PCA where the prior AI Call B produced misaligned years (on Sunroad: 6 of 12 years had values relocated). Cache-key semantics require id rotation: post-bump ExtractionResults have different content-hash ids than pre-bump records for the same source documents. Treat pre-1.5 and post-1.5 extraction outputs as different id spaces — the same justification pattern as v5 §10.2 (D.3 1.1→1.2), v7 §10.4 (C.2 1.2→1.3 implicit in EEV-bump-with-version-history-discipline), v9 §10.6 (Phase 1+2 1.3→1.4).

This is the third EEV bump of the project. The bump cadence reflects the rule "any change that affects per-entry extraction values rotates the id space," even when the contract shape is stable — the cache invalidation requirement is real, and the bump is the canonical signal to downstream consumers. Pre-1.5 cache entries become orphans (not hit by post-bump cache lookups); new post-1.5 cache entries write through the storage schema. (See §10.13 for the interaction with the still-open `extraction_input_cache.pca_hash` column gap from #46.)

5 fixture-version literals + the production constant updated in the v10 fixture sweep; full count 6 sites. No fixture hardcodes EEV-derived content-hashes, so no cascading fixture-id breakage.

### 10.12 PCA_ADAPTER_VERSION bump 1.0 → 1.1 (`b6323fb`, 2026-06-03)

`PCA_ADAPTER_VERSION` bumped from `'1.0'` to `'1.1'`. The adapter's external entry point (`runPcaAdapter(slot)`) signature is unchanged; the internal interface `PcaAdapterDeps.extractPca` widens from `(doc) => Promise<...>` to `(doc, pdfBuffer) => Promise<...>` to thread the raw bytes through to the deterministic schedule extractor. The internal core `runPcaAdapterOnDocument(doc, bufferHash, pdfBuffer, deps)` gains `pdfBuffer` as a new 3rd positional parameter; existing test mocks operate at the external entry point (where `slot.buffer` is already in scope) and are unaffected.

Stamped into `ExtractionResult.extractorVersions['pca']` by the composer's version harvester. 1 fixture-version literal updated in `test-build-and-ingest-route.ts:253` (the synthetic BuildReport's `pcaPdf.adapterVersion`); per-adapter convention same as ASR/CF/rent-roll adapters carrying local version constants.

### 10.13 §10.6 KNOWN LIMITATION resolution + v9 framing correction (`b6323fb`, 2026-06-03)

The v9 §10.6 KNOWN LIMITATION block — which framed PCA capex-schedule per-year alignment accuracy of ~50-60% as a property of PDF text extraction — is **resolved** by §10.10's deterministic extractor. Sunroad now reads 12/12 per-year exact via `pdfjs-dist`'s positional API. The v9 KNOWN LIMITATION text in `extract-pca.ts`'s file header, in `PCAExtraction.capexScheduleInflated`'s JSDoc, and in `AdjustedCapitalReserves.capexScheduleInflated`'s JSDoc are all replaced with notes pointing to the new deterministic module. §10.6's own KNOWN LIMITATION block receives a 1-sentence "Resolved in §10.13 (v10)" forward-pointer; the v9 prose is preserved per the layering discipline.

Beyond the resolution itself, this entry records a **framing correction**: v9's KNOWN LIMITATION block claimed the limitation was structural to PDF text extraction. It wasn't. The limitation was structural to **our specific extractor's API choice** (`unpdf`'s `extractText({ mergePages: true })` collapses each PDF page's text items to a flat string, discarding the `TextItem.transform` matrices that pdf.js itself preserves). The bundled pdf.js (`unpdf/pdfjs`, accessible via `getDocumentProxy` which was already imported at `apps/api/src/services/pdf-parser.service.ts:19`) exposes `transform[4]` as x-coordinate and `transform[5]` as y-coordinate per text item — the exact positional information needed to recover year-column assignments. The capability was always present in the dep we already had; we just weren't reaching it.

Phase A of the implementation (the model-upgrade experiment) load-bearingly confirmed this framing: running `claude-opus-4-7` against the Sunroad fixture with the same Call B prompt produced 7/12 per-year exact, structurally identical failure-mode-class to the sonnet-4 baseline's 6/12 (off-by-one shifts of non-zero values to adjacent years; sum exact in both runs). A higher-capability model couldn't recover positional information that wasn't in its input — the ceiling wasn't model-capability-bound. Phase A's marginal +1 entry over baseline confirmed the structural ceiling sits at the text-extraction-API layer, and Phase B's clean 12/12 against the same fixture confirmed pdf.js's positional API lifts it cleanly.

See §13.7 for the codified process-learning generalization — the discipline question this ticket surfaced is broader than the PCA case: when documenting a KNOWN LIMITATION, distinguish format-structural (truly intrinsic to the data format) from choice-structural (artifact of our specific API surface). v9 §10.6 conflated the two; future KNOWN LIMITATION blocks across the codebase should name the specific API choice that's load-bearing so future readers can evaluate whether a different choice would lift the ceiling.

### 10.14 AdjustedAssumptions render-side projection — #24 ship (`413e93f`, 2026-06-05)

Resolves [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24). **First render-side implementation ticket** documented in §10 — prior shipped tickets (D.3, C.2, PCA Phase 1+2, #44 PCA year-alignment) all sat extraction-side. Future render-side tickets follow this convention: they share the §10 Behavior change log surface with extraction-side work but the affected version is `RENDER_VERSION` (in `packages/contracts/src/rendered-analysis.ts`), not `EXTRACTION_ENGINE_VERSION` or `JUDGMENT_ENGINE_VERSION`. No JE rule changes, no `JUDGMENT_ENGINE_MANIFEST` additions, no contract changes outside the render contract.

**Ship details.** `RenderedAnalysis` widens with a new `RenderedAssumptionsSection` interface — named-field struct, 4 `RenderedLineItem` fields (`capRate` / `terminalCapRate` / `rentGrowthPct` / `expenseGrowthPct`) — mirroring the D21 `RenderedLoanSection` shape. The projection in `apps/api/src/services/render-underwriting-context.ts` adds a 4-line block using the existing `projectLineItem` helper for 1:1 passthrough from `AdjustedInputs.assumptions`. No new projection helpers needed. Frontend wiring in `apps/web/src/lib/uw-edit-utils.ts` extends `EDITABLE_PATHS` (16 → 20) and `PERCENT_PATHS` (3 → 7) with the 4 new `assumptions.*.adjusted` paths, plus widens the `buildPath` section-union signature. `apps/web/src/components/RenderedAnalysisView.tsx` adds an Assumptions section render block mirroring the income/expense/loan `LineItemTable` pattern, and widens `EditableLineItemTable`'s `section` prop union to include `'assumptions'`. Fixture sweep updates 3 test files (`test-committee-workflow.ts`, `test-edit-surface-stores.ts`, `test-materialize-rendered-analysis.ts`) constructing `RenderedAnalysis` literals.

**Version impact.** `RENDER_VERSION` bumps `'7.2'` → `'7.3'`. Same id-space-rotation semantics as `EXTRACTION_ENGINE_VERSION` bumps (§10.2 / §10.11): post-bump RenderedAnalysis records carry different content-hash ids than pre-bump records for the same logical inputs, because the new `assumptions` field participates in the content-hash. Cache invalidation is automatic via the `materialize-rendered-analysis.ts` cache wrapper's `(rootId, RENDER_VERSION)` lookup key; pre-7.3 cache rows orphan; new post-7.3 rows compute fresh on first lookup. No manual migration. Append-only cache semantics preserved (`ON CONFLICT(id) DO NOTHING`).

**Empirical anchor.** `test-render-underwriting-context.ts` at **590/590 passing** (baseline 571; +19 new assumptions assertions; 2 stale-literal updates for `'7.2'` → `'7.3'` and top-keys-list inclusion of `'assumptions'`). Bijection check confirms the assumptions section has exactly 4 fields matching the `AdjustedAssumptions` source. 16 positive assertions across the 4 fields verify `name`, `raw.displayValue`, `adjusted.displayValue`, and `source` propagate correctly through `projectLineItem`. 9 adjacent test suites unaffected by the contract widening (974/974 total assertions across the sweep including `test-committee-workflow`, `test-edit-surface-stores`, `test-materialize-rendered-analysis`, `test-build-committee-snapshot`, `test:doctrine-evaluation`, `test:doctrine-components`, `test:cross-check-contracts`, `test:valuation-service`, `test:render-isolation`).

**Process-discipline note — §13.5 pattern persists at multiple drafting layers.** This ticket surfaced 8 brief-vs-codebase deltas across the implementation arc; all caught in flight via the recon-first discipline at the appropriate layer; zero rework. The 8 deltas split as 5 implementation-time + 3 brief-drafting-layer (enumeration + meta-observation + composition-volume-estimate), and the split itself is informative — the §13.5 pattern transfers across ticket shape (render-side now, after extraction-side ship-arcs in §10.6 / §10.10) AND across drafting layers (recon / implementation / brief-design / enumeration / composition). The recon-first discipline catches deltas at every drafting layer, not just at the implementation surface.

**Five implementation-time deltas (Steps 1-3):**

1. **Recon-trace miss — `section` prop type union.** Step 0 recon Item 5 traced the EditCell + EDITABLE_PATHS infrastructure but missed that `EditableLineItemTable` carries a literal-union `section: 'income' | 'expenses' | 'loan'` prop type that needed widening to accept `'assumptions'`. Caught at the first typecheck pass after Step 2 implementation. Fix is small (one literal-union widening at `RenderedAnalysisView.tsx:400`); recon's mental model of "mirror existing affordance" was correct in shape, but a TypeScript-level constraint inside the affordance machinery required widening too.

2. **Fixture-sweep estimate at high end of range.** Step 0 recon Item 7 estimated "2-3 edits across 2-3 files" for the fixture sweep. Actual count: **3 sites in 3 files** (the third — `test-materialize-rendered-analysis.ts:344` — was missed at Step 0 recon; surfaced at Step 1 verification grep). Within the recon estimate's range but at the high end. The miss reflects that "files that construct `RenderedAnalysis` literals" is narrower than "files that reference `RenderedAnalysis` types" — the recon grep conflated the two.

3. **Brief-design ordering assumption — TypeScript strict mode couples Step 2 with Step 4.** The implementation brief sequenced Step 2 (implementation) → Step 3 (empirical verification) → Step 4 (fixture sweep). TypeScript's strict mode rejected this ordering: the 3 fixture files fail typecheck immediately after Step 2's contract widening because their `RenderedAnalysis` literals are missing the new `assumptions` field. The brief-time assumption that fixture updates could defer to Step 4 was incompatible with strict-mode TypeScript's "any consumer of the widened type must be updated atomically" reality. Folded fixture sweep into Step 2 as option α (see Step 2 continuation report). The discipline catches the ordering misframing at typecheck time before any commits.

4. **`buildPath` cascade — type-union downstream consumer.** Widening `EditableLineItemTable`'s `section` prop union triggered a one-step TypeScript cascade through `buildPath(section: 'income' | 'expenses' | 'loan', ...)` in `apps/web/src/lib/uw-edit-utils.ts:130` — a parallel narrow union that consumed the same logical concept. Caught at the second typecheck pass; fixed with a ~5-line signature widening + JSDoc update. One-step cascade only; no deeper consumers. The pattern: widening a typed-union prop may require parallel widening in helper functions consuming the same union.

5. **Pre-existing `new Date` discipline violation surfaced by sweep.** Step 3 broader test sweep ran `test-client-rendered-discipline.ts` and surfaced `FAIL RenderedAnalysisView.tsx: FORBIDDEN new Date (wall-clock) - line: {new Date(evaluation.analysisAsOfDate).toISOString().slice(0, 10)}` at `RenderedAnalysisView.tsx:258`. **Verified pre-existing** (not introduced by #24): stashing the #24 changes and re-running the test still surfaces the same failure at the same line. Not in #24 scope to fix; recorded here per the §10.10 cosmetic-gap-in-spec-rather-than-issue-ceremony convention (the failure is a small discipline cleanup of pre-existing code, not worth a dedicated GitHub issue, but worth keeping discoverable for future contributors who grep the spec for `new Date` or for discipline-test discussions). A future render-side cleanup ticket may opportunistically address this; alternatively, the discipline test's expected-failure handling could be widened to acknowledge the pre-existing exemption (architectural decision, not in scope here).

**Three brief-drafting-layer deltas (Step 4 enumeration / Step 5 composition):**

6. **Enumeration brief missed §12.3 bullet update.** Step 4 v12 enumeration listed 8 items; the §12.3 "Open dependencies" bullet on AdjustedAssumptions (which claimed the field was "not projected to RenderedAnalysis") needed a v12 layered note (Item 9, added at composition-time orientation). Same shape as Items 3-5 (§12.5 / §12.1 / §9 item 4 inline updates) but the enumeration brief miscounted. Caught at Step 5 orientation by re-reading the existing §12 prose; surfaced for chat decision before any composition edit; added to enumeration as Item 9 with chat approval.

7. **Meta-observation: enumeration briefs predictably miss inline structural-fact updates under light-amendment framing.** The §13.5 pattern at the brief-drafting layer. v9 enumeration brief missed 3 items (CC caught all 3); v10 enumeration brief missed 2 items (CC caught both); v11 enumeration brief missed 3 items (CC caught all 3); v12 enumeration brief missed 1 item (CC caught it at orientation). The pattern: when a brief author sets "light amendment" framing, the brief under-counts the inline structural-fact updates the amendment requires (cross-reference cells, status markers, layered notes on existing prose). The recon-first discipline catches these at the layer immediately above the brief — at composition-time orientation, the same way recon catches deltas at implementation-time orientation. Each drafting layer has its own §13.5-shape failure mode; the discipline applied at the next layer up catches them.

8. **Composition-layer mental-volume estimate overstated source-line reality.** The v12 enumeration brief estimated 70-90 net lines for the amendment; the v12 revision-history entry initially claimed ~85 lines. The actual net addition was ~35 lines. Caught at composition-time via `wc -l` reality-check on the diff stat (`git diff --stat` reported 40 insertions / 5 deletions = 35 net) before commit. The pattern: a composition author's "feels like" mental model of prose volume systematically diverges from byte-counted reality, particularly for amendments whose substance is structured-list content — numbered-delta paragraphs that read as substantial-feeling at composition time but land as moderate source-line counts because markdown source uses single-line paragraphs without wrapping. Same §13.5 failure-mode-class at yet another drafting layer (composition, not just enumeration or recon); same recon-first (here: word-count-check-first) discipline catches it before the inaccurate claim ships in the revision history.

The substance of this entry is the 8-delta capture above — a render-side ticket's process-discipline state at multiple drafting layers (recon, implementation, brief-design, enumeration, composition). The §13.5 pattern (briefs miss codebase deltas; recon-first catches them) extends naturally to enumeration briefs and composition briefs and even to composition-time self-claims. Future amendment work should treat each drafting layer as a first-class subject of its own recon-first discipline at the next layer up.

### 10.15 §13.6 fixture cast-discipline cleanup arc — #45 + #48 ship (`b11098d` + sweep arc `c8b7dc6` / `69a5066` / `27e6d3e`, 2026-05-26 → 2026-05-28)

Resolves [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) and [#48](https://github.com/isaint-jean/cre-credit-committee/issues/48). **First process-driven implementation ticket** documented in §10 — prior §10 entries documented extraction-side ship arcs (§10.1-10.13) and one render-side ship (§10.14); this entry documents a test-discipline cleanup arc whose lone production-behavior change is a single nullish-equality operator tightening at the assembler layer. The 4-commit arc is documented as a single §10 entry per the β-framing decision: §10 entries document **behavior changes**, not ticket boundaries; one production behavior change with preconditional test cleanup across multiple commits maps to one §10 entry. The framing question (split into §10.15 + §10.16 per ticket vs single §10.15 per behavior change) was surfaced and decided at v13 enumeration time; the single-section choice mirrors §10.6-§10.9's inverse pattern (one commit, multiple §10 entries — same convention of "entries document changes, not commits/tickets").

**Ship details (the behavior change).** `apps/api/src/services/handbook/assembler.ts:252` tightens from loose `if (capexSchedule != null)` to strict `if (capexSchedule !== null)`. The contract guarantees the field is `ReadonlyArray<...> | null`; pre-cleanup test fixtures via `as unknown as` casts could pass `undefined` through, which the loose check tolerated. The tightening is safe only after the precondition — fixture cleanup eliminating the `undefined` leak paths — landed; the 4-commit arc captures the preconditional cleanup. Lines 247-250 inline comment reworded from the prior loose-check defense ("Loose check covers both nullish cases without forcing a fixture sweep") to a forward-pointer naming the SHIP-HASH and the rationale: "Fixture-cast leak path closed in `b11098d` per #48 (test-handbook-field-bag.ts factory cleanup removed the as-unknown-as casts that previously allowed undefined to reach this read)."

**The 4-commit cleanup arc.** (1) `b11098d` — #48 factory-pattern cleanup in `test-handbook-field-bag.ts` (3 contract-type casts removed via file-local `makeMinimalGraph` / `makeMinimalMetadata` / `makeStressScenario` factories with full-shape `HydratedRecordGraph` / `PropertyMetadata` / `StressScenarioOutput` defaults) + the `assembler.ts:252` tightening + smoke-e2e sibling fixture correction (Delta G — see Process-discipline note below). (2) `c8b7dc6` — #45 sub-pass 1, 11 branded-type narrowings from `as unknown as <BrandedId>` to single-cast `as <BrandedId>` per §13.6 acceptance criterion (a); mechanical token-level swap across `test-revision-storage.ts` / `test-revision-id.ts` / `test-apply-revision-delta.ts`. (3) `69a5066` — #45 sub-pass 2, full-shape `AssemblerInputs` construction in `test-handbook-field-bag-smoke-e2e.ts` via file-local `makeSmokeInputs` factory; flat scalar override surface for the 4 dimensions that vary per scenario (`loanAmount` / `dscr` / `debtYield` / `propertyType`) plus `Partial<T>` overrides for the 3 sub-records that vary as units (`narrativeFacts` / `stressOutputs` / `propertyMetadata`); `Partial<PropertyMetadata> | null` tri-state for the metadata-absent scenario. (4) `27e6d3e` — #45 semantic-claim JSDoc formally justifying the one remaining `typeof er` cast at `test-extraction-contract.ts:359` per §13.6 acceptance criterion (b); the cast IS the test's claim that branded types are compile-time only and have no runtime presence.

**Scope totals.** 17 contract-type cast removals + 1 semantic-claim cast formally justified across the 4-commit arc: 3 cleaned in `b11098d` (test-handbook-field-bag.ts, #48 scope — factory-pattern); 11 cleaned in `c8b7dc6` (#45 sub-pass 1 — 8 RevisionId + 2 AdjustedInputsId + 1 ValuationConclusion['stressOutputsId'] indexed-access); 3 cleaned in `69a5066` (#45 sub-pass 2 — 3 AssemblerInputs in smoke-e2e); 1 documented in-place in `27e6d3e` (#45 semantic-claim — the `typeof er` cast at test-extraction-contract.ts:359). **#45's 14 in-scope sites** (post-recon-reclassification, excluding the 3 RecordGraphStore casts deferred to #49) all addressed: 11 in sub-pass 1 + 3 in sub-pass 2 = 14 of 14 cleaned. **#48's 3 in-scope sites** all addressed in b11098d. 11 sites deferred per the recon reclassification: **3 RecordGraphStore casts** (`test-handbook-evaluation-route.ts:76`, `test-build-and-ingest-route.ts:210` + `:797`) require architectural work — `RecordGraphStore` is exported as a class with ~50+ methods rather than an interface, so cleaning these casts cleanly requires production-code refactor (interface segregation or `Pick<RecordGraphStore, ...>` narrowing at the route call sites); deferred to [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) (architectural ticket to be filed). **7 DI escape-hatch casts** (Express router `{ stack: unknown[] }` × 3 at `test-revision-route.ts:103` / `test-get-analysis-route.ts:102` / `test-workflow-api.ts:108`; SQLite store `{ db: import('better-sqlite3').Database }` × 3 at `test-materialize-rendered-analysis.ts:196` / `test-hydrate-record-graph.ts:289` / `test-library-snapshot-producer.ts:236`; blob store `{ blobs: Map<string, Buffer> }` × 1 at `test-blob-store.ts:214`) bypass TypeScript `private` access rather than contract enforcement; conceptually out-of-§13.6-scope per the recon reclassification, noted in #45's close-out comment. **1 `typeof er` semantic-claim** documented in-place (27e6d3e); the cast itself is the test's load-bearing assertion that branded types carry no runtime bits. Pre-arc raw count was 28 `as unknown as` sites (25 surfaced at v13 recon time, performed mid-arc after b11098d had shipped, plus the 3 b11098d had already cleaned); the recon's 25-site count breaks down as 14 #45-in-scope contract-type + 3 RecordGraphStore (architectural, deferred) + 7 DI escape-hatch (out of scope) + 1 semantic-claim (justified). Post-arc workspace contract-type cast inventory: 0 in-scope (all 17 cleaned); 3 RecordGraphStore deferred to #49; 1 semantic-claim documented but still as-unknown-as per §13.6 acceptance (b).

**Version impact.** No `EXTRACTION_ENGINE_VERSION` / `JUDGMENT_ENGINE_VERSION` / `JUDGMENT_ENGINE_MANIFEST` / `RENDER_VERSION` / `PCA_ADAPTER_VERSION` / `STRESS_ENGINE_VERSION` / `VALUATION_ENGINE_VERSION` / `DOCTRINE_VERSION` bumps. No contract changes outside the test-fixture surface (test files construct full-shape contract literals where they previously used `as unknown as` casts; the contracts themselves are unchanged). The one runtime check tightening at `assembler.ts:252` is a same-semantic correctness improvement against contract-conforming runtime values — strict `!== null` reads exactly the contract's `ReadonlyArray<...> | null` declaration, where the loose `!= null` was a defensive accommodation for the cast-leaked `undefined` path that has now been eliminated. Both checks would behave identically against contract-conforming values; the tightening just removes the silent-tolerance fallback that masked fixture-shape bugs (per the §13.6 acceptance argument that fixture-discipline cleanup IS the precondition that makes strict equality safe).

**Empirical anchor.** 10 affected test suites green post-arc: `test-handbook-field-bag` 43/43, `test-handbook-field-bag-smoke-e2e` 7/7 (preserved across both b11098d sub-step 2.6 fixture correction and 69a5066 factory cleanup), `test-handbook-field-bag-known-fields` 2/2, `test-handbook-evaluation` 24/24, `test-build-handbook-evaluation` 26/26 (preserved from yesterday's pilot ship `f177605`), `test-compute-workbook-coverage` 16/16, `test-revision-storage` 33/33, `test-revision-id` 11/11, `test-apply-revision-delta` 58/58, `test-extraction-contract` 57/57. `tsc --noEmit -p apps/api/tsconfig.json` clean across all 4 commits. `lint:boundaries` clean (228 modules / 699 dependencies cruised). The pilot ship at `f177605` (yesterday — 6 contract-type casts cleaned in `test-build-handbook-evaluation.ts`, 3 latent enum-value bugs caught in flight) is the direct predecessor of this arc; the recon for #45/#48 sweep used yesterday's pilot pattern as the canonical example for the file-local factory + Partial<T> override approach now standardized across `test-handbook-field-bag.ts` (b11098d) and `test-handbook-field-bag-smoke-e2e.ts` (69a5066).

**Process-discipline note — Delta G in-flight catch.** The b11098d assembler-tightening surfaced a latent fixture-shape leak in a sibling test file: `test-handbook-field-bag-smoke-e2e.ts` had 3 fixtures that constructed `AssemblerInputs` via `as unknown as` casts and **omitted** `capexScheduleInflated` entirely (the field was reaching the assembler as `undefined`). Pre-tightening, the loose `!= null` matched both `null` and `undefined` and routed undefined through the else-branch; post-tightening, the strict `!== null` let `undefined` fall through into `[...undefined]` → `TypeError: capexSchedule is not iterable`. Caught at the b11098d adjacent-suite sweep (Item 6 of the cleanup brief's verification); fixed in same commit (b11098d sub-step 2.6) by adding `capexScheduleInflated: null, capexScheduleUninflated: null` to each of the 3 smoke-e2e fixtures. The pattern is new evidence (the assembler-tightening-surfaces-sibling-leak pattern) but the §13.6 discipline already covers this failure-mode-class — the cleanup IS the precondition that makes the tightening safe; the recon-coverage extension (run a broader consumer-grep against all sites that read the tightened field, not just within-file) is a recon-discipline refinement, not a new §13.x failure-mode-class. No new §13 process-learning entry created; the lesson is captured here inline. Future strict-equality tightenings should anticipate the same shape: any read where the contract declares `T | null` but the implementation uses `!= null` is likely accommodating a sibling-file fixture leak; the recon for tightening should run a workspace-wide consumer-coverage grep before the tightening lands.

### 10.16 #49 Site 1 cleanup + Sites 2+3 cascade-deferral — interface segregation against `RecordGraphStore` (`e4dfa86`, 2026-05-27)

Partially resolves [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49). **Second process-driven implementation ticket** documented in §10 — sibling-precedent to §10.15 (test-fixture-cleanup arc), not a continuation. §10.15 captured "behavior-change + test cleanup arc"; §10.16 captures a distinct pattern — *interface segregation from a class without natural interfaces, applied selectively where the consumer handler is terminal*. The (α'-hybrid) recon-driven scope-split (clean what's clean / document what isn't) is itself a precedent: where v13 split #48 from #45 *before* implementation (architectural fork), v14 split *within* #49 (terminal vs cascading consumers). Two different shapes of split; both worth distinct precedent capture. First interface segregation FROM `RecordGraphStore` — future cleanups of the remaining 2 RecordGraphStore casts (if appetite arises) would look here first.

**Site 1 cleanup details.** New `HandbookEvaluationReadStore` interface co-located in `apps/api/src/storage/record-graph-store.ts` above the class declaration: 2-method subset of the 43-method `RecordGraphStore` (`getLatestRevisionByLineageRoot` + `getLatestHandbookEvaluationForAdjustedInputs`). `handleHandbookEvaluationRead`'s `graphStore` parameter at `apps/api/src/routes/analysis.routes.ts:504` narrowed from `RecordGraphStore` to `HandbookEvaluationReadStore`; production singleton `recordGraphStore` (full class) satisfies the narrower interface via width-subtyping, so the production call site at `analysis.routes.ts:322` is unchanged. Test stub at `test-handbook-evaluation-route.ts:76` becomes a typed literal of `HandbookEvaluationReadStore` — `as unknown as RecordGraphStore` cast removed. New file-local `makeEnvelope` helper constructs a full-shape `RevisionLineageEnvelope` (10 fields: revisionId, lineageRootId, parentRevisionId, revisionOrdinal, doctrineEvaluationId, adjustedInputsId, doctrineVersion, judgmentEngineVersion, stressEngineVersion, valuationEngineVersion) replacing the 3 partial `{adjustedInputsId}` envelope literals at the test's call sites. Helper is file-local per yesterday's "test files stay independent" convention (existing `makeEnvelope` in `test-revision-storage.ts` is over-parameterized for our needs and would create a cross-file fixture dependency).

**Sites 2+3 cascade-deferral.** Casts at `test-build-and-ingest-route.ts:210` (makeDeps default storeMock) and `:797` (orphan-cache override via `{...realStore, ...overrides}` spread) retained with §13.6 (b) JSDoc. The structural barrier: `makeBuildAndIngestHandler` directly calls 5 store methods, but delegates `deps.recordGraphStore` to `ingestExtractionResult(args, store: RecordGraphStore)` which itself calls 9 more store methods. Narrowing the outer handler's parameter to a hypothetical `BuildAndIngestStore` (5 methods) creates a downstream type mismatch — `ingestExtractionResult` won't accept the narrower interface. Three resolution paths exist (cascade narrowing through `IngestExtractionResultStore` and possibly further; move the cast to production code; keep the test casts as-is); only the cascade path is architecturally clean, and cascade scoping is design recon (interface names, where they live, how deep the cascade goes) outside §13.6's fixture-cleanup framing. JSDoc per §13.6 acceptance (b) at both sites; Site 3's JSDoc cross-references Site 2's full justification to avoid duplicating the framing.

**Process-discipline observations.** Two captures kept inline per the v14 framing decision (not new §13.x entries; not a §10.14-style 8-delta enumeration). (1) **Delta K — recon-layer §13.5 manifestation.** Step 3 architectural recommendation estimated Site 1 cleanup at ~10 LOC; Step 4 implementation inspection surfaced that the cast at Site 1 was hiding TWO failure-modes, not one — class-vs-interface (the framing the issue body named) AND partial-envelope-vs-full-envelope (the second failure-mode the cast was simultaneously covering). Actual scope ~59 LOC including the new `makeEnvelope` helper. The §13.5 pattern (mental models systematically under-credit drift between recon mental-model and codebase reality) manifests at the recon layer here, joining v12's composition layer (§10.14 Delta 8) and v9's enumeration layer (§13.5 origin). The generalizable discipline takeaway: *"what TWO things might this cast be doing?"* — when inspecting a cast site at recon time, explicitly enumerate alternative failure-modes the cast might be simultaneously covering, not just the obvious one named by the framing. (2) **Cascade-narrowing barrier.** First time the "narrowing forces downstream cascade" structural problem surfaced in this codebase — worth naming as a recognizable pattern for future RecordGraphStore narrowings or other class-typed dependency-cascade cleanups: when a handler under-test delegates the store to a helper that itself uses the store, narrowing the handler's parameter forces a corresponding narrowing of the helper's parameter, and so on transitively until the cascade terminates at a leaf consumer. The cascade depth is part of the cleanup scope; pre-recon inspection of the consumer graph (not just the handler under test) is the discipline that reveals the actual scope.

**Empirical anchor.** Affected test suites green post-ship: `test-handbook-evaluation-route` 11/11 (baseline preserved); `test-build-and-ingest-route` 66/66 (baseline preserved, JSDoc additions don't affect runtime). `tsc --noEmit -p apps/api/tsconfig.json` clean. `lint:boundaries` clean (228 modules / 700 dependencies cruised — +1 from v13's count, attributable to the new type-only import from `record-graph-store.ts` into `analysis.routes.ts`). Consumer-coverage grep per Delta G discipline confirmed only 3 files touch `handleHandbookEvaluationRead` or `HandbookEvaluationReadStore` — all 3 modified in the ship; no hidden consumers. Workspace post-ship contract-type cast inventory: 0 in-scope contract-type casts (Site 1 cleaned); 2 RecordGraphStore class-stub casts retained with JSDoc per §13.6 (b) (Sites 2+3); 7 DI escape-hatch casts (out of §13.6 scope per the v13 recon reclassification); 1 `typeof er` semantic-claim documented per §13.6 (b) in 27e6d3e; 53 Express `Request`/`Response` mock-casts explicitly out-of-scope per the original #45 issue body.

---

## 11. Tier B (judgment) workstream

### 11.0 Preamble

**Definition.** Tier B cells are populated from LLM judgment guided by the handbook. Examples: year-1 pro forma assumptions (Operating History col L), 10-year projections, stress scenarios, concluded values (Conclusions & Escrows tab — concluded cap rate, escrow recommendations, etc.). Yellow-background convention in the populated workbook.

**Status.** Coverage-gap recon completed 2026-05-31 (Piece 6). The X/Y/Z/D taxonomy in §2 does NOT classify Tier B cells (per §2.5 — the taxonomy is Tier A-scoped); Tier B uses its own gap-pattern categorization (§11.2) instead.

**Why this matters for the populator.** The populator's value above "extraction transcription tool" depends on Tier B cells being populated AND trustworthy. Shipping the populator with extraction-only coverage (Tier A populated, Tier B blank or red) reduces the deliverable to a workbook generator. Shipping with weak Tier B coverage is worse than blank — plausibly-wrong judgment is harder to detect than missing values.

**Quality dependency on §12.** Tier B output trustworthiness is most naturally surfaced via the analysis page (reasoning traces, doctrine principle invoked, override surface). Populator → analysis page is therefore a quality dependency, not just a parallel feature.

**Update (v11):** the claim above is partially fulfilled by the in-flight legacy-to-rendered migration. The new spine already surfaces Tier B values via `RenderedAnalysis` projection (D09 doctrine.components, D16/D17 income/expense, D21 loan section — all shipped at render versions 6.8 → 7.2 per `docs/legacy-reduction-plan.md` §7 Phase 1). The original "Populator → analysis page" sequencing assumed two separate workstreams in dependency order; in practice the analysis page work has gone ahead largely independent of [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41) (the populator tracking ticket, deferred). The remaining Tier-B-on-analysis-page dependency is narrower than v6 framed: per-cell reasoning traces / override surfaces specifically (Phase 2-3 work), not the wholesale "analysis page must exist first" framing.

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

   **Further correction (v10).** The year-alignment quality limitation on `capexScheduleInflated` documented in v9 §10.6 (and previously inherited into the §11.1 E35-M35 row) was resolved deterministically in `b6323fb` per #44 — see §§10.10-10.13. The §11.1 E35-M35 row reflects the resolution; the v9 KNOWN LIMITATION inheritance is gone. The architectural insight that the recon for #44 surfaced (the limitation was extractor-choice-structural, not PDF-format-structural — pdf.js positional data was available in the dep we already had) is captured as a general process learning at §13.7. This v10 layer doesn't unwind the prior v9 / v8 / v6 corrections; it closes the loop on the year-alignment quality concern within the broader §11.4 PCA-producer sequencing arc.

2. **OperatingStatementExtraction widening (Piece 4 C.2 finding).** Unlocks Category 3 (2 cells: L15, L22) plus any other cells dependent on bad debt / reimbursements / G&A / janitorial / TI / LC line items the seller CF carries today but the contract drops. Contract-touch + extractor-touch coordinated edit; similar shape to D.3 but on the `OperatingStatementExtraction` contract instead of `SellerUWExtraction`.

3. **I9 Concluded Cap Rate as a Tier B ticket.** Highest single-cell consequence in the template per registry notes. Greenfield: new contract slot (e.g., `concludedCapRate` field), new builder, new doctrine wiring. Significantly larger scope than D.3 — closer to "a mini-feature" than "a wire-up ticket." Has Tier-B-on-Tier-B dependencies (§11.3) that should be settled before scoping.

4. **Category 1 wiring (8 surface-mismatch cells).** Cannot ship until the populator (#41) is built — these are populator-side wiring decisions about which `AdjustedInputs` fields project to which template cells. When the populator scoping starts, this category becomes the natural first chunk of populator work because the values already exist.

5. **Category 4 cells.** Not engineering work in the line-item-builders sense. E47/E48/E49-mechanical-portion need formula logic, R-column notes need text-generation pipeline. Each sub-category is its own smaller scoping conversation.

6. **AppraisalExtraction producer (3-phase multi-record arc).** Scoped during v15 against the ghost-contract finding from §5.2 (with v15 layered note reframing); contract-design decisions captured in §14.2. **Delta Q (v15)**: §11.4 didn't pre-stage appraisal-producer sequencing in earlier revisions — PCA got item 1 (full pre-scoping treatment), OperatingStatementExtraction got item 2, I9 got item 3, but appraisal was mentioned only in passing in item 1's C14 carve-out. v15 closes that documentation gap. Scope shape per §14.2: multi-record producer writing to AppraisalExtraction (Phase 1 anchor-fields widening; 0 populator cells but improves valuation-engine quality) + new `AppraisalOperatingStatement` sub-record (Phase 2; unlocks 13 Bucket 4 cells: D47/D48 + J9-J32 Appraisal column) + PropertyMetadata extensions (Phase 3; unlocks 8 Bucket 6 cells: H3 Subtype, L3/L4 Parking, G7/H7 Zoning, L11 Land Area, C13 Outparcels, C14 Clear Height — the last per §11.4 item 1 (a) carve-in, resolving the v8 deferral). Total cell-unlock ~21 cells across 3 phases — comparable to PCA's full arc (PCA Phase 1+2 unlocked 4 cells: G51 + E49 + G49 + E35-M35 broadcast = 1+3 = 4 cells per §10.6/§10.9 attributions; v15's appraisal scope is materially larger). I9 Concluded Cap Rate (item 3 above) stays separate per Decision 6 in §14.2 — appraisal documents are a natural I9 source but I9 has Tier-B-on-Tier-B dependencies (§11.3) that should be settled before bundling. Anchor fixture not yet committed (Decision 7 in §14.2 explicitly deferred to next session); Phase 1 implementation gates on anchor fixture acquisition. Phase 1 doesn't gate Phase 2 or 3; Phase 2 and Phase 3 are independent of each other. Three additional decisions deferred to per-phase implementation-time scoping per the §14.1 PCA precedent's contract-shape-vs-implementation-architecture scope boundary: joint-extractor vs separate-call architecture; adapter pattern fit (single appraisal.adapter.ts vs phase-specific adapters); per-phase specific field decisions against the committed anchor fixture.

Note: this sequencing is a recommendation, not a commitment. The §9 next-step candidates remain peer choices; Tier B work is one of several directions.

---

## 12. Analysis page workstream

### 12.0 Preamble

**Status (graduated v11).** §12 graduates from stub to workstream section in v11 — mirroring §11's v6 stub-to-workstream promotion. The v3-original stub content is preserved below as a historical record per the layering discipline, with v11 update layered on top. The canonical operational doc is `docs/legacy-reduction-plan.md` (440 lines, drafted post-6.8 + caching + observability + consumer-migration-v1); §12 carries the spec-side framework (workstream framing + phase-level summary + decision points + cross-references); per-capability operational detail (38-item capability inventory, coverage matrix, parity-corpus methodology) lives in the canonical doc.

**Definition (v3-original, preserved).** Rebuild of the legacy analysis page that did red-flag detection, internet research (sponsor / market / news), and credit scoring against the handbook. The legacy version was framed as "currently degraded" at v3 time.

**Status (v3-original, preserved).** "No spec exists. Legacy code existed but needed significant upgrade per prior sessions."

**Status correction (v11).** Both v3 claims are materially out of date as of v11. (1) `docs/legacy-reduction-plan.md` IS the spec — drafted between v3 and v11, ~440 lines, comprehensive capability inventory + coverage matrix + 5-phase sequencing + retirement-readiness framework. (2) The legacy analysis page at `apps/web/src/app/analysis/[id]/page.tsx` (~1,595 lines) is operational and remains the primary UI for legacy uuid-keyed analyses; graph-keyed analyses route through `RenderedAnalysisView` (the new spine). The "degraded" framing applied to specific legacy components (mitigation strategies, internet research, AI-narrative credit-scoring wrappers) at v3-time, not to the dashboard as a whole. The §13.8 process learning captures the spec-stub-currency drift surfaced by this graduation.

**Dependency relationship with the populator (v3-original, preserved + v11 update).** (a) Shares extraction infrastructure with the populator — both consume the same extraction pipeline outputs. (b) Is the natural surface for displaying Tier B reasoning, which makes its readiness a quality gate for shipping Tier B cells in the populator. **v11 update:** the new spine already surfaces partial Tier B via `RenderedAnalysis` (D09 / D16 / D17 / D21 shipped at render versions 6.8 → 7.2); the remaining Tier-B-on-analysis-page dependency is narrower than v3-v6 framed — see §11.0's v11 layered note for the partial-fulfillment discussion.

**Sequencing implication (v3-original, preserved + v11 update).** v3 recommended parallel-track development between populator and analysis page. **v11 update:** in practice the analysis page work has gone ahead largely independent of the populator ([#41](https://github.com/isaint-jean/cre-credit-committee/issues/41), still deferred). The parallel-track recommendation held in spirit.

**Next step (v11).** Spec-side: this workstream section is the framework; operational truth lives in `legacy-reduction-plan.md`. No "dedicated scoping session" is pending — the scoping recon happened during the v11 graduation and surfaced that the operational scoping already existed.

### 12.1 Phase-level summary table

| Phase | Status | Items | Notes |
|---|---|---:|---|
| Phase 1 — High-value display-only migrations | ✅ shipped | 5 + 1 already-covered | Render versions 6.8 → 7.2; D04 findings (7.2), D09 doctrine.components (6.8), D16 income lines (6.9), D17 expense lines (6.9), D20 stress scenarios (7.1), D21 loan section (7.0) + D18 metrics row already-covered |
| Phase 2 — Producer-pending migrations | 🔄 in progress | 3 | D03 + D10 narrative producer (tracked at [#40](https://github.com/isaint-jean/cre-credit-committee/issues/40)); D05 cross-check producer refactor; D08 manifesto-evaluation projection; AdjustedAssumptions projection [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24) (closed in v12, see §10.14) |
| Phase 3 — Lineage / audit visibility | ⚪ pending | 2 | A01 lineage side-panel; A02 historical revision viewer. Endpoints already exist; UI wiring is the work. |
| Phase 4 — Editable rendered semantics | 📜 DEFERRED | 4 | D23 / M01-M04. Needs explicit decision to open Phase 4 per `legacy-reduction-plan.md` directive. |
| Phase 5 — Sunsets / deprecation decisions | 📜 decision-pending | 7 | Per §12.4 product-decision territory; each item needs explicit keep/rebuild/sunset decision before legacy dashboard retirement. |

**Status legend:** ✅ shipped • 🔄 in progress • ⚪ pending • 📜 deferred-or-decision-pending.

The 5+1 / 3 / 2 / 4 / 7 counts mirror `legacy-reduction-plan.md` §7's phase structure. Per-capability detail (D01-D24 display + M01-M04 mutation + A01-A03 audit + E01-E02 export + O01-O05 operational) is operational truth in `legacy-reduction-plan.md` §2-§4, not duplicated here per the v11 light-integration discipline (Decision B).

### 12.2 Migration phase structure

Per `legacy-reduction-plan.md` §7, the 5 phases are sequenced by **load-bearing weight** (impact on retirement readiness) and **architectural coupling** (how much new-spine work each requires). Brief framing of each — refer to the canonical doc for operational detail:

- **Phase 1** adds to `RenderedAnalysis` what already exists in upstream typed records (no producer work; contract + schema + render-view + view-consumer per item). Each item bumps `RENDER_VERSION`; the cache layer handles version splits automatically. PJ2 / RD2 discipline preserved (no re-derivation; just projection).
- **Phase 2** requires new-spine producer work BEFORE the render projection. Each is a separate batch. Items 6-8 in the canonical doc (cross-check producer refactor, manifesto-evaluation projection, narrative producer).
- **Phase 3** is lineage / audit-history UI wiring; endpoints exist (GET /:id/lineage, GET /:id?revisionId=...) and need surface integration on `RenderedAnalysisView`.
- **Phase 4** is editable rendered semantics — comments, UW edits, loan-term edits, stress runs. **Explicitly deferred** per the canonical doc directive: "do not begin Phase 4 until Phases 1-3 are stable, the parity corpus shows clean coverage of read concerns, and the architectural domain of writable rendered semantics has been explicitly opened."
- **Phase 5** is decisions, not migrations — see §12.4.

### 12.3 Dependencies on Tier B + extraction coverage

The Tier-B-on-analysis-page dependency from §9 item 4's original framing is mediated by `AdjustedInputs` projection paths, not conceptual. The trace:

1. `RenderedAnalysisView` (new spine) consumes `RenderedAnalysis`.
2. `RenderedAnalysis` is projected from `AdjustedInputs` by `apps/api/src/services/render-underwriting-context.ts` + `build-underwriting-context-projection.ts`.
3. `AdjustedInputs` is the canonical output of the judgment engine (per the architecture-contract memory).
4. Tier B cells per §11.1 are judgment-engine-decided values (yellow-background per §11.0): cap rate concluded, escrow recommendations, 10-year pro forma assumptions, stress scenarios, etc.

**Already-bridged dependencies** (Tier B values that flow through `AdjustedInputs` and project to the rendered surface):
- Loan fields → `loan` section (D21, render version 7.0)
- Income / expense lines (some Tier B by registry; some Tier A) → `incomeLines[]` / `expenseLines[]` (D16, D17, render version 6.9)
- Metrics → `metrics` (D18, already covered)
- Stress scenarios → `stress` (D20, render version 7.1)
- Doctrine component scores → `doctrine.components[]` (D09, render version 6.8)
- Findings → `findings[]` (D04, render version 7.2)

**Open dependencies** (Tier B values NOT yet rendered):
- I9 Concluded Cap Rate (§11.4 item 3) — needs its own contract slot and projection. Greenfield per §11.4 framing.
- Per-cell reasoning traces / override surfaces — Phase 2-3 work; not a single missing field but a UI affordance pattern that needs surface design.
- AdjustedAssumptions (rentGrowthPct, expenseGrowthPct, capRate, terminalCapRate) — backend-editable today via POST /:id/revisions but not projected to `RenderedAnalysis`. Tracked at [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24). **Update (v12):** projected to `RenderedAnalysis` as of `413e93f` (see §10.14); [#24] closed. Resolved dependency; bullet preserved as a historical record per the layering discipline.

### 12.4 Product-decision territory

Per `legacy-reduction-plan.md` §7 Phase 5, the items below require explicit product decisions (keep-as-legacy-only / rebuild-on-new-spine / sunset) before the legacy dashboard can be fully retired. Brief framing of each — operational scoping in the canonical doc:

- **D07 Research feature (internet research).** Brave Search API integration at `apps/api/src/services/research.service.ts`. Marked "external-data integration; outside the deterministic spine" in `legacy-reduction-plan.md` §4. Decision: rebuild on new spine, keep as legacy-only operational tool, or sunset entirely.
- **D12-D15 B-piece decision (verdict / deal breakers / approval conditions / pricing guidance).** Out-of-spine artifacts; legacy AI-generated. Possibly retire entirely per `legacy-reduction-plan.md` Phase 5 #13.
- **D06 Mitigation strategies.** Was AI-generated in legacy. New-spine equivalent TBD. Possibly rebuild on new spine; possibly sunset. Phase 5 #14.
- **D11 Score-improvement suggestions.** Was AI-generated. Phase 5 #15 marks "sunset?" as the operative question.
- **D23 + M01-M04 Comments / editable rendered semantics (Phase 4 entire phase).** Requires writable-rendered-state contract design. Explicit decision required to open Phase 4.
- **A03 + O05 Audit log UI.** Marked "operational; possibly retire" in coverage matrix; Phase 5 #17 asks "retire the dashboard surface entirely?"
- **O03 Compare (cross-analysis comparison).** Out of read-model scope; Phase 5 #16 alongside research feature: "keep as legacy-only operational tools, or rebuild?"

These 7 decisions don't block Phase 1-3 work but DO block full retirement of the legacy dashboard. Worth surfacing at scoping sessions, not deferring to retirement-readiness time.

### 12.5 Open issues + cross-references

**Active GitHub issues directly relevant to §12 work:**

- [#24](https://github.com/isaint-jean/cre-credit-committee/issues/24) — **CLOSED in `413e93f` (v12).** Exposed AdjustedAssumptions in RenderedAnalysis: `RenderedAssumptionsSection` interface added (4 fields: capRate / terminalCapRate / rentGrowthPct / expenseGrowthPct); projected via the existing `projectLineItem` helper in `render-underwriting-context.ts` mirroring the D21 loan-section idiom; `RENDER_VERSION` bumped `'7.2'` → `'7.3'`; UI edit affordance wired through the existing `EDITABLE_PATHS` + `PERCENT_PATHS` whitelist in `apps/web/src/lib/uw-edit-utils.ts` (16 → 20 editable paths total); RenderedAnalysisView gains an Assumptions section render block. See §10.14 for ship details + the 8-delta capture from the implementation arc.
- [#40](https://github.com/isaint-jean/cre-credit-committee/issues/40) — Wire HandbookEvaluation into the new-spine narrative producer. Phase 2 item 8 (narrative producer for D03 + D10). Cross-references `legacy-reduction-plan.md` §7 explicitly. Sandbox artifacts already exist (34 passing tests); narrative producer design pending.
- [#41](https://github.com/isaint-jean/cre-credit-committee/issues/41) — UW Template Populator (parallel-track per §12.0 sequencing note; deferred indefinitely per v8 §11.4 framing).

**Adjacent issues (legacy retirement readiness, not §12 work directly):**

- [#11](https://github.com/isaint-jean/cre-credit-committee/issues/11) — Production-traffic check before legacy Path C retirement.
- [#32](https://github.com/isaint-jean/cre-credit-committee/issues/32) — Sunset legacy AssetType lowercase type.

**Canonical operational doc:** `docs/legacy-reduction-plan.md`. Per Decision B (light integration), this section's framework references the canonical doc rather than duplicating its content. Updates to the canonical doc should NOT cascade to §12 unless they affect the phase structure or decision points.

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

**Update (v13).** Cleanup arc shipped — see §10.15 for ship details (`b11098d` primary commit + sweep arc `c8b7dc6` / `69a5066` / `27e6d3e`, 2026-05-26 → 2026-05-28). The runtime check at `assembler.ts:252` is now strict `!== null`; the original loose-`!= null` framing in the paragraph below is preserved as historical record per the layering discipline. The two-paths question is resolved: the architecturally clean path (fixture-discipline cleanup) won.

**Update (v14).** #49 Phase 1 shipped (`e4dfa86`) — Site 1 (`test-handbook-evaluation-route.ts:76`) cleaned via `HandbookEvaluationReadStore` interface segregation; Sites 2+3 (`test-build-and-ingest-route.ts:210`/`:797`) cascade-deferred per §13.6 acceptance (b) — narrowing the outer build-and-ingest handler's parameter forces a downstream `IngestExtractionResultStore` extraction (and potentially further), which is architectural-design work outside the (α'-hybrid) fixture-cleanup framing. See §10.16 for ship details. The v13 layered note above and the original loose-`!= null` framing below stay preserved as historical record per the layering discipline.

Until the fixture cleanup ships, prefer `!= null` at assembler-layer reads against `AdjustedInputs.*` fields. The follow-up issue [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) tracks the fixture-discipline cleanup; when it ships, the runtime checks can be re-tightened to `!== null` since the runtime values will actually match the contract.

**Practical implication.** When implementation work touches assembler-layer reads, watch for the strict-vs-loose equality choice. If tests fail with destructure errors on `undefined` values, the fix isn't to add a defensive check at each call site — it's to either (a) use loose `!= null` consistently at the `AdjustedInputs` boundary, or (b) tighten the fixtures. Don't pick (a) at one site and (b) at another; pick the project-wide discipline. This learning is also a corollary of §13.5's "trust the codebase" — the codebase (via runtime cast-discipline) is telling us something about what the type system has not been carrying, and the assembler layer is where the gap surfaces.

### 13.7 KNOWN LIMITATION framing — distinguish format-structural from choice-structural

When documenting a KNOWN LIMITATION in code or spec, distinguish between **format-structural** limitations (truly intrinsic to the data format or external system being read) and **choice-structural** limitations (artifact of OUR specific API surface for reading it). The discipline question to ask before writing a KNOWN LIMITATION block: *is this limitation intrinsic to the data, or to our choice of API for accessing the data?* If the answer is the latter (or unknown), the KNOWN LIMITATION block should name the specific API choice that's load-bearing — so future readers can evaluate whether a different choice would lift the ceiling without reproducing the recon work that surfaced the answer.

**Concrete case — PCA capex-schedule year-alignment (resolved by #44).** The v9 §10.6 KNOWN LIMITATION block claimed: *"PDF text extraction (`unpdf` / pdf.js) strips column positions from Table 2 cells. The extracted text shows row data + dollar amounts as a linear stream… with NO positional cue indicating which year column each $30,000 belongs to."* The framing implied the limitation was structural to PDF text extraction in general — a property of the data format. Three iterations of prompt engineering against the AI extractor (vanilla → B-explicit → totals-row guidance) confirmed a ceiling at ~50-60% per-year alignment accuracy. Phase A of the #44 implementation added a fourth experimental data point: running `claude-opus-4-7` (the highest-capability model available) against the same Sunroad fixture with the same Call B prompt reached 7/12 per-year exact — structurally identical failure-mode-class to the sonnet-4 baseline's 6/12 (off-by-one shifts of non-zero values to adjacent years; sum exact in both). A higher-capability model couldn't recover positional information that wasn't in its input. The ceiling wasn't model-capability-bound; the v9 framing's "structural to PDF text extraction" diagnosis seemed reinforced.

But Phase B's recon (Item 4) discovered the framing was wrong. The limitation was structural to **OUR specific extractor's API choice** (`unpdf`'s `extractText({ mergePages: true })` collapses each PDF page's text items to a flat string, discarding the `TextItem.transform` matrices that pdf.js itself preserves). The bundled pdf.js (`unpdf/pdfjs`, accessible via `getDocumentProxy`) exposes `transform[4]` as x-coordinate and `transform[5]` as y-coordinate per text item — the exact positional information needed to recover year-column assignments. The capability was always present in the dep we already had; we just weren't reaching it. `getDocumentProxy` was even already imported elsewhere in the codebase (at `apps/api/src/services/pdf-parser.service.ts:19`). The v9 KNOWN LIMITATION block named the right surface (text extraction strips positions) but generalized the diagnosis to the wrong layer (PDF text extraction in general) when the actual layer was much narrower (`unpdf.extractText`'s flat-text mode). Phase B replaced the AI Call B with deterministic extraction over pdf.js's positional API and achieved 12/12 per-year exact on Sunroad on first run.

**General lesson.** KNOWN LIMITATION blocks that name a structural ceiling should also name the specific API choice that's load-bearing for the ceiling. The pattern that catches the wrong framing: when a KNOWN LIMITATION attributes a ceiling to "PDF text extraction" / "AI extraction" / "the format" / "the model" without naming the specific call site or library function that's structurally constraining the output, the framing is doing too much work. Either the constraint is more specific than the framing claims (and a different API choice in the same library lifts it — the #44 case), or the framing is correct but unverified (and the next ticket pays for re-deriving the answer). In either case, naming the specific API surface in the KNOWN LIMITATION block reduces future-work cost.

The recon question to ask when writing a KNOWN LIMITATION: *can I name the call site (`module.fn(args)`) that's the load-bearing layer here?* If yes, name it explicitly. If no, the recon to find it is part of the KNOWN LIMITATION block's writing — not deferred to a follow-up ticket. The cost of misframing isn't theoretical: v9 §10.6's framing led the recon for #44 to consider Python-subprocess architectures (`pdfplumber`, `tabula`, `camelot`) before discovering pdf.js positional data was already accessible in-Node — a delta the recon caught early but that would have been avoided entirely if the v9 KNOWN LIMITATION had named `unpdf.extractText({ mergePages: true })` as the load-bearing surface rather than "PDF text extraction" generally.

**Practical implication.** Future KNOWN LIMITATION blocks across the codebase (in JSDoc, in spec, in commit messages) should follow the discipline: state the limitation, name the specific load-bearing API choice, distinguish format-structural from choice-structural explicitly. The PCA case is the empirical anchor; the discipline is general. v9 §10.6's original KNOWN LIMITATION text is preserved in the spec as a historical record per the layering discipline — it's now also useful as the canonical example of the framing error this learning corrects.

**Related (v11):** see §13.8 for a sibling spec-vs-reality-drift discipline at a different abstraction layer (spec-stub-currency vs limitation-framing). Both §13.7 and §13.8 codify failure-mode-classes of spec-artifact-vs-codebase drift; the operational instructions are complementary, not overlapping.

### 13.8 Spec-stub-currency discipline — recon-first before scoping against stub framing

Spec stubs predictably drift from codebase reality between draft-time and use-time. A stub written to defer scoping ("no spec exists; scope this later") becomes materially wrong once the deferred work happens elsewhere — typically in a sibling doc, an in-flight workstream, or a separately-tracked initiative. The drift goes uncorrected because the stub's "deferred" framing makes it look like nothing has changed (the stub still says "not yet scoped"), when in fact the scoping has happened, the work is in flight, and the spec is the only artifact that hasn't caught up.

**Concrete case — §12 analysis page stub vs `docs/legacy-reduction-plan.md` (v11 graduation).** The §12 stub from v3 (2026-05-25) carried three claims that were materially out of date by v11 (2026-06-04):

- "Definition: rebuild of the legacy analysis page that did red-flag detection, internet research, and credit scoring against the handbook. The legacy version is currently degraded." → Reality at v11: the legacy dashboard (`apps/web/src/app/analysis/[id]/page.tsx`, 1595 lines) is operational and remains the primary UI for legacy uuid-keyed analyses. "Degraded" applied to specific legacy components at v3-time, not the dashboard as a whole. Specific-vs-aggregate framing error.
- "Status: no spec exists. Legacy code existed but needed significant upgrade per prior sessions." → Reality at v11: `docs/legacy-reduction-plan.md` (440 lines) IS the spec — drafted between v3 and v11, comprehensive 5-phase migration plan with capability inventory, coverage matrix, retirement-readiness framework. The "no spec exists" claim was true at v3-time and remained true in the stub through v11 even though the canonical operational spec had landed.
- "Next step: dedicated session to scope the analysis page rebuild. Not scoped here." → Reality at v11: scoping happened in `legacy-reduction-plan.md`; Phase 1 has already shipped 5 expansions (render versions 6.8 → 7.2). The "dedicated scoping session" was never explicitly scheduled because the scoping happened organically in the legacy-reduction-plan drafting.

The drift was caught by the v11 §12 graduation's recon step — a read-only inventory of (a) the §12 stub content, (b) the codebase surface area, (c) the components named in the §9 item 4 description, (d) the dependency map, (e) existing partial-implementation state, (f) adjacent specs. Item (f) surfaced `legacy-reduction-plan.md` and the recon's "Net read" section explicitly flagged: *"§12 isn't a 'scoping session that produces a spec for a greenfield rebuild.' The spec exists … the work is actively in flight … the §12 stub is materially out of date."* Without the recon, the v11 scoping session would have started drafting greenfield §12 content against the stub's framing — wasting effort and likely introducing additional drift with the existing canonical doc.

**General lesson.** Spec stubs deferring future work should be currency-checked before any scoping session drafts against their framing. The pattern that catches the failure: when a section reads "no spec exists" / "currently degraded" / "needs upgrade" / "scope this later" / similar deferred-state framing, the recon question to ask is: *has the deferred work already happened somewhere I'm not looking?* Sibling docs in `docs/`, in-flight workstreams, separately-tracked GitHub issues, and recent commits all qualify. If the deferred work HAS happened, the stub framing is itself a §13.7-shape KNOWN LIMITATION error — claiming a state that doesn't reflect reality.

The cost of misframing isn't theoretical: drafting against a stale stub commits to a workstream framing that may conflict with operational truth elsewhere (the canonical doc, the in-flight workstream). Reconciling later requires either rewriting the new spec content (work) or accepting a divergent spec surface (architectural-debt accumulation). The recon-first discipline avoids both costs at the price of one read-only inventory pass.

**Practical implication.** Scoping sessions opening against a stub-framed section should run a recon-first inventory pass before drafting. The pattern that the v11 §12 graduation used:

- (a) Read the stub content verbatim — what does it claim?
- (b) Survey the codebase surface area the stub references — what's actually there?
- (c) Check for adjacent docs / issues / workstreams that may have absorbed the work — has the deferred scoping happened elsewhere?
- (d) Surface deltas between stub claims and current reality before any composition step.

When the recon surfaces drift (as it did here), the scoping session's output shifts from "draft new spec content" to "integrate / reconcile with existing operational truth." Both are valid outputs; the choice should be driven by what's empirically there, not by what the stub framing assumes.

**Related (v11):** see §13.7 for the sibling KNOWN-LIMITATION-framing discipline. Both §13.7 and §13.8 codify spec-vs-reality-drift failure modes; the operational instructions are complementary. §13.7's question — "is this limitation format-structural or choice-structural?" — applies at the API-choice layer. §13.8's question — "is this stub current?" — applies at the spec-artifact layer. Both should be in the standard recon-checklist for any work that draws framing from existing spec content.

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

### 14.2 AppraisalExtraction producer (Phase 1+2+3) — multi-record extraction scope

Scoped during the v15 session against the AppraisalExtraction ghost contract (`packages/contracts/src/extraction.ts` — 3 fields: `valueConclusion`, `capRate`, `methodology`). Anchor fixture not yet committed; selection deferred per Decision 7 below. Recon-then-design pattern matching the v8 PCA-scoping precedent (§14.1): the morning's recon surfaced the empirical findings (the contract is a valuation-anchor reader, not a document-producer template; §5.2's Bucket 4 + Bucket 6 cell attributions don't address the current contract's fields; §11.4 didn't pre-stage appraisal-producer sequencing); the afternoon's contract-design conversation resolved seven design choices against the multi-record reframing this section records.

**Critical opening note — Delta P contract-design-layer manifestation.** §14.1's PCA-producer decisions ALL targeted a single contract (PCAExtraction widening). §14.2's AppraisalExtraction-producer decisions target multiple sub-records because the v15 recon surfaced that the appraisal *document* feeds three distinct producer outputs: (a) the existing AppraisalExtraction contract for *valuation-anchor* data (the current 3 fields plus possible additions), (b) a new operating-statement sub-record for the 13 Bucket 4 cells, (c) PropertyMetadata extensions for the 8 Bucket 6 cells. The naive "mirror PCA: widen AppraisalExtraction from 3 to ~12 fields" mental model was wrong by a wide margin — the actual scope spans 3 sub-records across 3 implementation tickets. This is the contract-design-layer manifestation of the "what TWO things might this cast/contract be doing?" recon discipline from §10.16 Delta K — applied here at the contract layer, the answer is that the AppraisalExtraction contract was hiding the multi-record scope under its single-contract name. **Delta Q** is documented separately at §11.4 item 6 (§11.4 sequencing documentation gap closed by v15 — same §13.8 spec-stub-currency family).

**Architectural decisions (3) — how the work is structured:**

**Decision 1 — Producer scope shape**

CHOSEN: multi-record producer.

Schema: no single contract widening; the producer writes to *multiple* sub-records during execution. Composer integration writes the produced values into ExtractionResult.appraisal AND ExtractionResult.appraisalOperatingStatement (new field, sibling to existing sellerUwOperatingStatement) AND threads PropertyMetadata extensions through the asr-side / appraisal-side property-metadata merge (composer-level decision deferred to Phase 3 implementation-time).

Rationale: the current AppraisalExtraction contract serves the valuation engine (anchor fields flow through narrative-facts to valuation.service.ts). Bucket 4's 13 cells need operating-statement-shape data; Bucket 6's 8 cells need property-descriptor data. Neither belongs on the current contract's three-field valuation-anchor footprint. §5.2's joint-extractor design observation already foreshadowed this: "appraisals carry a structured income/expense projection AND a property-description block as separate sections." The reframing captures three distinct producer outputs from one document source.

**Decision 2 — Phase split**

CHOSEN: 3-phase split (Phase 1 anchor-fields + Phase 2 operating-statement + Phase 3 descriptors).

Rationale: PCA shipped Phase 1+2 in one ticket per §13.4's "small D.3-shape framing has predictably under-estimated scope" expectation (Path B). AppraisalExtraction has meaningfully larger scope (~25+ field decisions across 3 sub-records vs PCA's 6 decisions on 1 contract), so a 1-ticket compaction risks the same under-estimation pattern §13.4 catches. 3-phase split allows each phase to ship as a tractable D.3-or-C.2-shape ticket, with the architectural multi-record framing decided once in this scoping session and per-phase field decisions made progressively. Phase 1 doesn't gate on Phase 2 or 3 (anchor-fields widening is value-additive without the other phases shipping); Phase 2 and Phase 3 are independent of each other (operating-statement and descriptor sub-records don't share fields).

**Decision 6 — I9 Concluded Cap Rate intersection**

CHOSEN: I9 stays separate (§11.4 item 3 remains its own ticket).

Rationale: appraisal documents are the natural source for `concludedCapRate`, but I9 has Tier-B-on-Tier-B dependencies per §11.3 (concluded cap rate depends on NOI which depends on col-L UW values) that should be settled before scoping. Bundling I9 with appraisal would entangle two scoping conversations: the appraisal producer's multi-record contract shape AND the Tier-B execution-ordering design. The two scopes can run on independent timelines; appraisal Phase 1 ships when its anchor fixture is committed and the field-list is decided; I9 scoping picks up its own pre-decisions (Tier-B-on-Tier-B execution model) when there's appetite for the broader Tier-B sequencing conversation.

**Phase-scope decisions (3) — what each phase contains:**

**Decision 3 — Phase 1 scope (anchor-fields widening of AppraisalExtraction)**

CHOSEN: Phase 1 widens AppraisalExtraction itself with anchor-related fields beyond the current 3. Specific field list deferred to Phase 1 implementation-time recon against the committed anchor fixture (per the v9 PCA pattern: §14.1 specified the SHAPE of capex schedule decisions in v8, but the field-by-field anchor values were verified against Sunroad post-fixture-commit in the implementation session).

Scope coverage: anchor fields are the valuation-anchor outputs the existing 3 fields already serve (valueConclusion, capRate, methodology), plus any additional fields the appraisal anchor fixture surfaces as natural anchor data (e.g., methodology weights if the appraisal uses multiple methods; income-approach NOI projection if it differs from the operating statement; reconciliation narrative pointers). Field list is implementation-time scope; this decision commits to "Phase 1 widens AppraisalExtraction, not PropertyMetadata or new sub-records." Cell-unlock count from Phase 1 alone: 0 populator cells (anchor fields feed the valuation engine, not template cells); the valuation-engine quality improvement is the Phase 1 value-add.

**Decision 4 — Phase 2 scope (new AppraisalOperatingStatement sub-record)**

CHOSEN: Phase 2 introduces a new sub-record (`AppraisalOperatingStatement` shape), sibling to the existing `sellerUwOperatingStatement` field on ExtractionResult. The new field name is provisional and may rename during Phase 2 implementation per §13.4 considerations.

Schema (preliminary, decision-shape not field-shape):
```ts
// In packages/contracts/src/extraction.ts:
readonly appraisalOperatingStatement: AppraisalOperatingStatement | null;
```
The internal shape of `AppraisalOperatingStatement` mirrors the OperatingStatementExtraction pattern (per-period structured fields for revenue / expense / reserve line items) but is appraisal-specific (NOI projection methodology, expense reimbursement structure that may differ from seller UW). Phase 2 implementation-time recon decides specific field list against the anchor fixture.

Rationale: Phase 2 unlocks the 13 Bucket 4 cells via the populator wiring those cells to the appraisal operating statement's field projections. Sibling-to-sellerUwOperatingStatement keeps the operating-statement family conceptually grouped on ExtractionResult; the existing sellerUwOperatingStatement precedent informs the schema shape. Cell-unlock count from Phase 2: ~13 Bucket 4 cells (per §5.2 inventory: D47/D48 + J9-J32 column).

**Decision 5 — Phase 3 scope (PropertyMetadata descriptor extensions + C14 carve-in)**

CHOSEN: Phase 3 extends PropertyMetadata with the 8 Bucket 6 appraisal-source descriptor fields (H3 Subtype, L3 Surface Parking, L4 Covered Parking, G7 Zoning Code, H7 Zoning Description, L11 Land Area, C13 Outparcels, C14 Clear Height). C14 carve-in disposition resolved per §11.4 item 1's (a) option — C14 rides with the appraisal producer ticket since the appraisal-document-as-source path already covers it; the v11.4 item 1 (b) alternative (separate small PropertyMetadata-shaped ticket) is therefore unused.

Schema (preliminary): no new sub-record; existing PropertyMetadata contract widens with 8 new fields (`propertySubtype`, `surfaceParking`, `coveredParking`, `zoningCode`, `zoningDescription`, `landAreaAcres`, `outparcels`, `clearHeight`). Field names provisional. Some fields may already exist on PropertyMetadata (e.g., `propertySubtype` is plausibly already there); Phase 3 implementation-time recon dedupes against the current contract.

Rationale: Phase 3 unlocks the 8 Bucket 6 descriptor cells via PropertyMetadata population. C14 carve-in (rather than separate ticket) is marginal-cost-near-zero since the extractor is already reading the appraisal document for the other 7 Bucket 6 fields. PropertyMetadata-side extension keeps the descriptor family conceptually grouped on the existing PropertyMetadata contract (which already carries the ~10-15 ASR-sourced descriptors); no new sub-record needed. Cell-unlock count from Phase 3: 8 Bucket 6 cells + the marginal C14 carve-in.

**Deferred decisions (4) — recorded for next-session pickup:**

The decisions deferred here are NOT the per-phase implementation-time field decisions (those naturally defer to per-phase implementation sessions). These are scoping-layer decisions that gate one or more phases starting:

- **Anchor fixture selection** — gates Phase 1 starting. Detailed below as Decision 7.
- **C14 disposition** — resolved in Decision 5 (rides with Phase 3); no further scoping decision needed but noted here for traceability against §11.4 item 1's original deferral.
- **Joint-extractor vs separate-call architecture** — defer to Phase 1 implementation-time scoping. The §5.2 design observation ("two sections in one document") suggests joint extraction; the PCA precedent suggests separate Call A + Call B per architectural-shape difference. Decision belongs at Phase 1 recon time against the anchor fixture's actual document structure.
- **Adapter pattern fit** — defer to Phase 1 implementation-time scoping. Single `appraisal.adapter.ts` (mirroring `pca.adapter.ts`) vs phase-specific adapters is an implementation-time choice that depends on the extractor architecture (Decision deferred above) and the multi-record output threading through the composer. The §14.1 PCA precedent focused on contract-shape decisions, not implementation-architecture decisions; §14.2 mirrors that scope.

**Decision 7 — Anchor fixture selection (deferred)**

DEFERRED to next session. No fixture committed today.

Rationale: appraisal PDFs are typically 100-200 pages (per the PCA Sunroad precedent at 174 pages; appraisals are comparable length); selecting an anchor requires real-document availability. The Sunroad-Centrum deal already has a PCA fixture committed at `431102d`; if a Sunroad-Centrum appraisal PDF is available, it would be the natural symmetric choice (cross-document consistency for testing the multi-record producer's ExtractionResult cohesion). Alternative anchor fixtures are also acceptable; the selection isn't load-bearing for the architectural decisions above (Decisions 1-6 + Decision 5's C14 carve-in are anchor-independent). What anchor selection IS load-bearing for: Phase 1 implementation-time field-decisions, Phase 1 implementation-time joint-vs-separate-call decision, Phase 1 implementation-time adapter pattern fit decision.

Anchor-acquisition cost considerations (per the v8 PCA precedent's fixture work): the anchor fixture commit involves possibly-redaction work + size considerations (commit hash bloat for large PDFs). The Sunroad PCA fixture is 44MB at commit `431102d`; appraisals may be similar or larger. If the v15 next-session can't acquire a Sunroad-Centrum appraisal, a different deal's appraisal works as long as the producer architecture validates against it (the architectural decisions don't require Sunroad-specific anchor values).

**Future contract design conversations capture under §14.3, §14.4, etc.** This forward-looking placeholder language is preserved from the v8 §14.2 stub that v15 replaces.

---



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
- `b6323fb` (2026-06-03) — PCA capex-schedule year-alignment improvement (resolves #44; §§10.10-10.13, §11.4 v10 layered correction, §13.7 process learning).
- `413e93f` (2026-06-05) — #24 AdjustedAssumptions render-side projection (first render-side implementation ticket; resolves #24; §10.14 ship details + 8-delta capture; §12.5 closure marker; §12.1 + §12.3 + §9 item 4 v12 layered notes; RENDER_VERSION 7.2 → 7.3).
- `b11098d` + sweep arc `c8b7dc6` / `69a5066` / `27e6d3e` (2026-05-26 → 2026-05-28) — §13.6 fixture cast-discipline cleanup arc (resolves #45 + #48; **first process-driven implementation ticket**; §10.15 single-section ship details per the β-framing decision; §13.6 v13 layered note; §9 item 2 fifth-ticket entry). The lone production-behavior change is `assembler.ts:252` loose-to-strict `!== null` tightening (shipped in b11098d, the primary commit). 14 of 14 in-scope contract-type cast sites cleaned + 1 semantic-claim formally justified; 11 sites deferred (3 RecordGraphStore → #49 architectural ticket to be filed; 7 DI escape-hatch → out-of-§13.6-scope per the recon split; 1 typeof er semantic-claim → §13.6 (b) justified in 27e6d3e).
- `e4dfa86` (2026-05-27) — #49 Phase 1: first interface-segregation cleanup against `RecordGraphStore` (**second process-driven implementation ticket**; §10.16 sibling-precedent to §10.15; §13.6 v14 layered note; §9 item 2 sixth-ticket entry). New `HandbookEvaluationReadStore` interface co-located in `record-graph-store.ts`; `handleHandbookEvaluationRead` parameter narrowed; Site 1 cast at `test-handbook-evaluation-route.ts:76` cleaned via full-shape `RevisionLineageEnvelope` construction (new file-local `makeEnvelope` helper). Sites 2+3 at `test-build-and-ingest-route.ts:210`/`:797` cascade-deferred per §13.6 (b) — JSDoc explaining the `ingestExtractionResult` downstream cascade. 1 of 3 #49 cast sites cleaned; 2 deferred to a future architectural ticket if appetite arises.

**Spec amendment commits (docs primarily; v13 also resolves the `assembler.ts:249` SHIP-HASH placeholder per the path-α pattern):**
- `5e056a7` (2026-06-04) — v11: §12 graduation from stub to workstream section; new §13.8 process learning (spec-stub-currency discipline); §9 item 4 prose rewritten; §9 item 2 + §11.0 v11 layered notes.
- `f9c5ed4` (2026-06-05) — v12: §10.14 #24 ship documentation (first render-side §10 entry; 8-delta capture); §12.5 #24 closure marker; §12.1 Phase 2 row light parenthetical edit; §12.3 AdjustedAssumptions bullet v12 layered note; §9 item 4 v12 layered update.
- `336e88c` (2026-06-06) — v13: §10.15 #45 + #48 §13.6 cleanup-arc ship documentation (single-section β framing — ONE behavior change across four commits); §13.6 v13 layered note (cleanup-shipped marker per the layering discipline); §9 item 2 fifth-ticket entry (first process-driven implementation ticket in the sequence); #45 / #48 marked CLOSED in cross-references; new #49 placeholder line (RecordGraphStore architectural ticket — to be filed in v13 Phase 2 close-out); #47 close-out (per Delta D scope decision — `62b9f24` shipped 2026-05-26, cross-references corrected from OPEN to CLOSED in same revision that's already touching the section). SHIP-HASH placeholder at `apps/api/src/services/handbook/assembler.ts:249` resolved to `b11098d` in this same commit per the path-α pattern (v13 is therefore docs + 1-line code, not purely docs-only — first amendment commit to carry a code change since the SHIP-HASH placeholder pattern was introduced in v9).
- `12ffcd1` (2026-06-07) — v14: §10.16 #49 Phase 1 ship documentation (second process-driven §10 entry; sibling-precedent to §10.15 — interface segregation against a class without natural interfaces, applied selectively where the consumer handler is terminal); §13.6 v14 layered note (inserted immediately after v13 layered note per chronological-layering convention; v13 note and original loose-`!= null` framing below preserved as historical record); §9 item 2 sixth-ticket entry (second process-driven implementation ticket — sibling-precedent framing consistent with §10.16); #49 line in cross-references updated from `*to be filed*` placeholder to PARTIALLY RESOLVED (Site 1 cleaned in e4dfa86; Sites 2+3 cascade-deferred per §13.6 (b)); #45 line at the 3-RecordGraphStore framing tightened per Delta M (1 of 3 cleaned in v14 via interface segregation; 2 cascade-deferred). Two process-discipline observations captured inline in §10.16 per the v14 framing decision (not §10.14-style 8-delta enumeration): Delta K (recon-layer §13.5 manifestation) and the cascade-narrowing barrier observation. e4dfa86 had no placeholders to resolve in non-SPEC files; v14 amendment is therefore purely docs-only per the original v9-v12 cadence.
- `9e61853` (2026-06-08) — v15: §14.2 AppraisalExtraction producer decisions document (replaces v8 §14.2 placeholder; second contract-decisions section after §14.1 PCA; 7 decisions across architectural-shape, phase-scope, and one detailed-deferred (anchor fixture); 3 additional deferred decisions listed without per-decision detail — C14 disposition resolved via §11.4 item 1 (a) carve-in, joint-extractor vs separate-call architecture deferred to Phase 1 implementation-time, adapter pattern fit deferred same). §5.2 v15 layered note (multi-record reframing per Delta P; original v4 ghost-contract framing preserved per §13.6/§13.8 layering discipline). §11.4 new item 6 (appended to avoid renumbering items 4 + 5; Delta Q closure — §11.4 sequencing documentation gap closed). Two new deltas captured inline: Delta P (contract-design-layer manifestation of "what TWO things might X be doing?") and Delta Q (§11.4 sequencing documentation gap, §13.8 spec-stub-currency family). No §10 entry per the v11 precedent for docs-only design/scoping amendments — substantive narrative in the v15 revision history entry + §14.2 body; v15 ships zero production code (pure scoping per the v8 PCA-scoping precedent which was also docs-only). v15 amendment commit is therefore docs-only; no SHIP-HASH or other code-side placeholders to resolve.

**Canonical operational docs referenced (light-integration discipline per v11 Decision B):**
- `docs/legacy-reduction-plan.md` (~440 lines, drafted post-6.8 + caching + observability + consumer-migration-v1) — canonical operational spec for §12 analysis page workstream. §12 carries spec-side framework (workstream framing + phase-level summary + decision points); per-capability operational detail (38-item capability inventory, coverage matrix, parity-corpus methodology) lives in this doc.

**Anchor fixtures used for empirical verification:**
- `apps/api/fixtures/sunroad-centrum-pca.pdf` — Sunroad-Centrum PCA (committed `431102d`, Partner Engineering ASTM E2018-15 report). Anchor for §14.1 Decisions 1, 3, 5 and the `f94d9f2` end-to-end verification per §10.6. Also the empirical anchor for the v10 deterministic-extraction acceptance check (12/12 per-year exact on both inflated and uninflated arrays, see §10.10).

**Cosmetic gaps recorded (no follow-up issues filed):**
- `CallBResult` type name in `apps/api/src/services/extract-pca.ts` — historically named for the AI Call B parser; post-v10 produced by the deterministic extractor and wrapped to this shape. Name retained for merge-interface stability; recorded in §10.10's body as known cosmetic gap to be cleaned up alongside any future PCA-adjacent ticket. Not filed as a GitHub follow-up issue (well under 30 lines of rename + 3 reference updates; too small for issue ceremony).

**Follow-up issues (filed in Sub-step 9.3 of the PCA producer ticket):**
- [#44](https://github.com/isaint-jean/cre-credit-committee/issues/44) — **CLOSED in `b6323fb` (v10).** PCA capex-schedule year-alignment improvement resolved via deterministic extraction in `apps/api/src/services/extract-pca-schedule.ts`; 12/12 per-year exact on Sunroad. The v9 framing of the limitation as "structural to PDF text extraction" was corrected — the limitation was choice-structural (`unpdf`'s flat-text path); pdf.js's positional API was always accessible. See §§10.10-10.13 for the shipped behavior changes and §13.7 for the codified process learning.
- [#46](https://github.com/isaint-jean/cre-credit-committee/issues/46) — `extraction_input_cache` table `pca_hash` column migration. Per §13.5 Step 4 finding: the `ExtractionInputKeyArgs.slotHashes` shape was widened in `f94d9f2` to include `pca: ContentHash | null` for cache-distinguishing correctness, but the storage-table schema does not yet have a `pca_hash` column. Production impact today is debug-info-only (cache lookups already correctly distinguish PCA-vs-non-PCA via the composite `cache_key` hash); the missing column affects only admin / observability surface. Issue body lays out the migration shape via the existing `migrateAddColumns()` idempotent shim. **Note (v10):** the `EXTRACTION_ENGINE_VERSION` 1.4 → 1.5 bump in `b6323fb` (see §10.11) doesn't address the storage-schema gap — pre-bump entries become orphan, new post-bump entries still write through the column-incomplete schema. Slightly accelerated urgency; not a re-prioritization.
- [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) — **CLOSED in v13's 4-commit arc** (`b11098d` + `c8b7dc6` + `69a5066` + `27e6d3e`, 2026-05-26 → 2026-05-28). Test fixture cast-discipline cleanup shipped per §13.6's two-paths framing — chose the architecturally clean path (fixture-discipline cleanup). 14 of 14 in-scope contract-type cast sites cleaned + 1 semantic-claim formally justified per §13.6 acceptance (b). The original recon's "~27-28 occurrences across ~10 target types" was reclassified during the v13 recon-first sweep into 14 contract-type (cleaned in arc) + 7 DI escape-hatch (bypassing TypeScript `private` access, not contract enforcement — out-of-§13.6-scope) + 3 RecordGraphStore (class-stub-not-interface pattern — architectural, split to [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49); v14 update: 1 of 3 cleaned in `e4dfa86` via `HandbookEvaluationReadStore` interface segregation, 2 cascade-deferred per §13.6 (b) — see §10.16) + 1 typeof er semantic-claim (the cast IS the test's claim; §13.6 (b) justified). Express Request/Response mock-casts (53 occurrences) explicitly out-of-scope per the original recon split, unchanged. See §10.15 for ship details and §13.6 v13 layered note for the cleanup-shipped marker.
- [#47](https://github.com/isaint-jean/cre-credit-committee/issues/47) — **CLOSED in `62b9f24` (2026-05-26).** `package.json` test-script aliases sweep: 15 missing `test:*` aliases added (chronological-append convention per the codebase; the brief had assumed alphabetical — caught as a recon delta) + 6 orphan aliases removed (`test:parse-rent-roll` / `test:extract-rent-roll-ai` / `test:populate-rent-roll-tab` / `test:populate-property-loan-summary` / `test:extract-property-metadata` / `test:populate-property-metadata`). Cross-references entry was framed as OPEN follow-up through v12; corrected to CLOSED in v13 per Delta D scope decision (keep cross-references honest in the same revision that's already updating them).
- [#48](https://github.com/isaint-jean/cre-credit-committee/issues/48) — **CLOSED in `b11098d` (2026-05-26).** Factory-builder cast treatment + assembler-layer tightening — split from [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) per the v13 recon reclassification when the factory-builder pattern (b11098d's territory) surfaced as distinct from the broader fixture-discipline cleanup (#45's territory). Both halves of #48's acceptance criteria shipped together in b11098d: (a) `test-handbook-field-bag.ts` factory-pattern cleanup (3 contract-type casts removed via file-local `makeMinimalGraph` / `makeMinimalMetadata` / `makeStressScenario` factories with full-shape `HydratedRecordGraph` / `PropertyMetadata` / `StressScenarioOutput` defaults), and (b) `assembler.ts:252` loose-to-strict `!== null` tightening (the lone production-behavior change in v13's entire arc). The same commit also corrects a sibling-file fixture leak surfaced by the tightening (Delta G class catch in `test-handbook-field-bag-smoke-e2e.ts`). See §10.15 for full ship details.
- [#49](https://github.com/isaint-jean/cre-credit-committee/issues/49) — **PARTIALLY RESOLVED in `e4dfa86` (v14 §10.16).** RecordGraphStore cast cleanup — architectural ticket split from [#45](https://github.com/isaint-jean/cre-credit-committee/issues/45) per the v13 recon reclassification (same split-pattern as #48 split from #45). 3 cast sites at `test-handbook-evaluation-route.ts:76` + `test-build-and-ingest-route.ts:210` + `:797` construct partial method-stub objects and cast to the full `RecordGraphStore` class (43 methods). v14 (α'-hybrid) recon-driven scope-split: **Site 1 cleaned** via `HandbookEvaluationReadStore` interface co-located in `record-graph-store.ts` (2-method subset; `handleHandbookEvaluationRead` parameter narrowed; production singleton satisfies via width-subtyping; new file-local `makeEnvelope` helper for full-shape `RevisionLineageEnvelope` construction). **Sites 2+3 cascade-deferred** per §13.6 acceptance (b) — JSDoc explains the structural barrier: `makeBuildAndIngestHandler` delegates `deps.recordGraphStore` to `ingestExtractionResult` which itself calls 9 store methods, so narrowing the outer handler forces a downstream `IngestExtractionResultStore` extraction and potentially further cascade. That architectural-design work (interface boundaries, names, location, cascade depth) is outside the (α'-hybrid) fixture-cleanup framing; full closure pending a dedicated architectural ticket if appetite arises. Issue stays OPEN; cascade-narrowing work is the architectural ticket's territory. See §10.16 for v14 ship details + Delta K capture (recon-layer §13.5 manifestation — the cast at Site 1 was hiding TWO failure-modes, not one).
