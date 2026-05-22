# Handbook Atomization — Working Planning Doc

Status: IN PROGRESS. Not yet a final artifact.

This document captures atomization decisions for converting the CRE Credit Handbook
(CRE_Credit.docx) into structured Principle + ReviewStep records per the schema
designed during the session.

Session 1: Schema design + Sections II, III, V fully atomized + Section IV
Single-Tenant Risk cluster atomized.

Session 2: Section IV Industrial, Self-Storage, and MHC clusters atomized.
17 new atomic principles (Industrial 5, Self-Storage 4, MHC 8).

Session 3 (this commit): Section IV Office, Retail, Multifamily, and Hotel
clusters atomized — COMPLETES SECTION IV atomization. 45 new atomic principles
(Office 9, Retail 12, Multifamily 14, Hotel 10).

Cumulative total: 87 atomic principles + 1 cluster narrative + 7 review steps
across the full Eightfold CRE Credit Handbook.

Remaining work for future sessions:
- Cross-reference cleanup pass (queued CROSS-REF notes throughout the document
  need to be wired into the schema's `relatedPrincipleIds` and
  `relatedReviewStepIds` fields)
- JSON conversion conforming to the Handbook contract (future task)
- Handbook contract type definition in @cre/contracts
- handbook_registry table + admin UI
- Engine consultation paths (depends on engine architecture work, separate ticket)

See issue #31 for tracking.

---

# Handbook Atomization Notes

Working session: converting Eightfold's CRE Credit Handbook into atomic principles
per the schema designed in this conversation. Bottom-up order, markdown notes,
JSON conversion deferred to CC in a future session.

## Schema reference

Three execution modes:
- **DETERMINISTIC** — arithmetic check against threshold; flag pass/fail
- **RESEARCH** — fetch external data, surface for human verification
- **LLM_CONTEXT** — inject principle text into LLM prompts at relevant points

InjectionPoints: `executive_summary` | `red_flag_assessment` | `mitigation_suggestions` | `committee_recommendation`

Severity levels: `critical` | `high` | `medium` | `advisory`

Sections: `core_philosophy` | `universal_framework` | `asset_type_specific` | `asr_review_framework`

---

## Section II — Core Underwriting Philosophy

### P-II-1: Downside protection over upside capture

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, mitigation_suggestions, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 1
- **Principle text:** "Downside protection takes precedence over upside capture"

### P-II-2: Size loans against historical, not peak

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 2
- **Principle text:** "Loan sizing must be supported by historical performance and cost basis, not peak underwriting"
- **Research actions:**
  - **action_type:** uw_vs_historical_noi_comparison
  - **verification_required:** true (analyst judgment call on whether gap is supportable)
  - **target_data:** UW NOI vs T12 NOI; surface variance %
  - **summary_prompt_hint:** "Compare underwritten NOI to trailing-12 actuals. Flag if UW exceeds T12 by a material margin without clear justification."
  - **action_type:** cost_basis_comparison
  - **verification_required:** true
  - **target_data:** sponsor's acquisition cost + invested capital vs current appraised value; identify cash-out vs cash-in
  - **summary_prompt_hint:** "Surface when sponsor bought, what they paid, and how much they've invested. If refinance, identify cash-in vs cash-out and proceeds vs cost basis."

### P-II-3: Cash-out refinances elevated scrutiny

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets; loan_purpose = Refinance
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, mitigation_suggestions, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 3
- **Principle text:** "Cashout refinances materially increase risk and warrant heightened scrutiny"
- **Deterministic check (cash-out detection):**
  - **metric:** computed from sources & uses — `cash_out_amount = loan_proceeds - existing_debt - closing_costs - reserves`
  - **operator:** `>`
  - **threshold:** 0
  - **flag_message:** "Cash-out refinance detected: sponsor takes $X equity at closing. Per handbook, heightened scrutiny required."
  - **flag_severity:** high
  - **NOTE:** depends on engine surfacing sources & uses as structured data — likely future engine work; file follow-up ticket. Until then, this check is inert and LLM_CONTEXT carries the principle.

### P-II-4: Stable, durable cash flow preferred

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 4
- **Principle text:** "Stable, durable cash flow is preferred over recently ramped NOI or assets that face significant rollover over the term that could affect the NOI dramatically."
- **Research actions:**
  - **action_type:** noi_trajectory_surface
  - **verification_required:** true
  - **target_data:** historical NOI trend (T36/T24/T12 or available periods) — let analyst assess durability vs recent ramp
  - **summary_prompt_hint:** "Surface the NOI trajectory over available historical periods. Identify whether current NOI is steady-state or reflects recent ramp (renovation, lease-up, new operator)."
  - **action_type:** term_rollover_exposure
  - **verification_required:** true
  - **target_data:** % of NOI from tenants whose leases expire before loan maturity; identify the specific expiring tenants
  - **summary_prompt_hint:** "Identify tenants whose leases expire during the loan term. Compute % of NOI those tenants represent. Flag if material to debt service coverage."

### P-II-5: Fungible assets in liquid markets preferred

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 5
- **Principle text:** "Fungible assets in liquid, dynamic markets are preferred. The real estate should work for other tenants if there is future vacancy, and the building should be attractive to a buyer if something happens with our borrower. Illiquid assets in tertiary markets tend to cause high severity losses when things go wrong."
- **Deterministic check (tertiary market detection):**
  - **metric:** MSA string
  - **operator:** contains
  - **threshold:** "Non-Metro"
  - **flag_message:** "Tertiary market detected: property is in a non-metro MSA. Per handbook, illiquid markets tend to cause high-severity losses."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** submarket_sales_velocity
  - **verification_required:** true
  - **target_data:** count + $ volume of recent property sales in submarket × asset type
  - **summary_prompt_hint:** "Surface recent sales comp activity in the submarket for this asset type. Sparse data indicates thin market and elevated illiquidity risk."
  - **action_type:** building_fungibility_assessment
  - **verification_required:** true
  - **target_data:** building characteristics (specialty use, unique config, single-tenant build-to-suit, generic vs specialty)
  - **summary_prompt_hint:** "Assess whether the building could realistically serve other tenants if current occupier vacates. Flag specialty uses, unique configurations, or build-to-suit characteristics."

### P-II-6: Information gaps are credit negatives

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 6
- **Principle text:** "Lack of information or transparency is itself a credit negative"

### P-II-7: Early and severe losses kill B-piece

- **Cluster:** Core Philosophy
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §II, bullet 7
- **Principle text:** "Early losses and high severity losses will kill a B-piece investment"

### P-II-8: Specialized assets are higher risk

- **Cluster:** Core Philosophy
- **Trigger:** ALL asset types; check fires when property_sub_type ∈ specialty set
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §II, bullet 8
- **Principle text:** "Know what you don't know – specialized assets are inherently higher risk (data centers, cold-storage, student housing, etc.) and lead to high severity losses."
- **Deterministic check (specialty sub-type detection):**
  - **metric:** property_sub_type (string)
  - **operator:** in (set match, case-insensitive)
  - **threshold (set):** [
    - Handbook-explicit: "Data Center", "Cold Storage", "Student Housing"
    - Extension (handbook spirit, not literal): "Senior Housing", "Medical Office", "Life Sciences", "Parking Structure", "Marina", "Golf Course", "Religious Property", "Self-Storage" (already its own asset class but specialty when secondary), "Manufactured Housing" (own class), "Movie Theater" (single-tenant retail specialty)
    ]
  - **flag_message:** "Specialty asset detected ({sub_type}). Per handbook, specialty assets carry elevated severity risk in distress; underwrite with extra conservatism."
  - **flag_severity:** high
  - **NOTE:** specialty list is curated based on handbook spirit + CRE common knowledge; literal handbook examples are Data Center / Cold Storage / Student Housing. Future ticket may make the specialty list editable as a separate registry artifact rather than baked into the principle.

---

## Section V — Step-by-Step Framework for ASR Reviews

Handbook intro: "these steps can never be omitted"

Modeled as `ReviewStep[]` (separate top-level entity), NOT principles.

### Step 1: Executive Summary & Risk Assessment

- **stepNumber:** 1
- **title:** Executive Summary & Risk Assessment
- **description:** "Process the complete Asset Status Report (ASR) and associated issuer-provided Excel UW models to convey a comprehensive summary. This analysis should highlight core strengths, weaknesses, risks, and mitigants, utilizing the frameworks and historical context established in this Eightfold CRE Credit Handbook."
- **mandatory:** true
- **outputType:** `summary`
- **relatedPrincipleIds:** [P-II-1, P-II-2, P-II-3, P-II-4, P-II-5, P-II-6, P-II-7, P-II-8] (all of Section II foundational philosophy)
- **NOTE:** engine implementation should also pull in any asset-type-specific principles that fired for this deal when generating the executive summary.

### Step 2: Asset-Specific Stress Testing

- **stepNumber:** 2
- **title:** Asset-Specific Stress Testing
- **description:** "Perform detailed sensitivity analyses based on asset class: Office, Retail, and Industrial: Conduct tenant-specific NOI stress tests. Quantify the impact on NOI should the top three tenants—individually and in various combinations - vacate the premises. Multifamily, Hospitality, Self-Storage, and MHC: Execute stress scenarios centered on systematic reductions in occupancy levels and market rent concessions."
- **mandatory:** true
- **outputType:** `stress_test`
- **relatedPrincipleIds:** [P-II-4] (durable cash flow)
- **NOTE:** engine routes to TENANT_REMOVAL methodology for Office/Retail/Industrial; OCC_RENT_CONCESSION for Multifamily/Hospitality/Self-Storage/MHC. (Already implemented in new-spine engine `stress.method` field — see reconnaissance report.)

### Step 3: Reserve and Escrow Adequacy Analysis

- **stepNumber:** 3
- **title:** Reserve and Escrow Adequacy Analysis
- **description:** "Determine appropriate reserves and escrows based on the asset class, focusing on: Tenant Improvement (TI) and Leasing Commissions (LC) for Office, Retail, and Industrial assets. Property Improvement Plans (PIPs) for Hospitality assets."
- **mandatory:** true
- **outputType:** `reserve_analysis`
- **relatedPrincipleIds:** [P-III-4] (cash on hand reserves preferred over springing)

### Step 4: Market and Sponsor Due Diligence

- **stepNumber:** 4
- **title:** Market and Sponsor Due Diligence
- **description:** "Conduct comprehensive market research, leveraging your tools and internet to thoroughly evaluate the property, market dynamics, and sponsor. 'Google the asset, market, sponsor' approach."
- **mandatory:** true
- **outputType:** `research`
- **relatedPrincipleIds:** [P-II-5, P-III-12] (fungible assets in liquid markets; sponsor review). TBD: will add asset-type research principles (§IV, e.g., TripAdvisor for hotels) when atomized.

### Step 5: Comparative Market Analysis (Kicks Cross-Reference)

- **stepNumber:** 5
- **title:** Comparative Market Analysis (Kicks Cross-Reference)
- **description:** "Identify and analyze comparable properties using the EF Master Kicks query. Specifically: a. Filter by similar property type and market. b. Highlight assets with comparable size, age, and tenancy profiles. c. Detail reasons for previous removals (kicks), focusing on issues that may also apply to the current property under review."
- **mandatory:** true
- **outputType:** `comparative`
- **relatedPrincipleIds:** [P-III-13] (Eightfold Portfolio Exposure Study)
- **IMPLEMENTATION NOTE:** First real consumer of `kicks_registry` data at analysis time. Engine work needed: (1) take new deal's asset type + submarket (city/state or MSA), (2) query kicks_registry for matching prior kicks, (3) return kick details + Comments field, (4) pass to LLM to generate comparative section. File as separate engine ticket when ready to implement.

### Step 6: Portfolio Loss Correlation

- **stepNumber:** 6
- **title:** Portfolio Loss Correlation
- **description:** "Cross-Portfolio Loss Analysis. Access the database (qryCurrentLosses) to identify B-piece losses in similar properties or markets. Use this data to construct a refined risk profile and historical context analysis. The following metrics MUST be considered for every review: Property losses by market, Property losses by sponsor, Property losses by property type."
- **mandatory:** true
- **outputType:** `portfolio_correlation`
- **relatedPrincipleIds:** [P-II-7] (early/severe losses kill B-piece)
- **IMPLEMENTATION NOTE:** Hard dependency. References `qryCurrentLosses` database query that doesn't exist in current codebase. B-piece historical loss data corpus is not currently captured in any registry. Until infrastructure exists, engine should produce "Data unavailable — manual review required" output for this step. File ticket: "Build qryCurrentLosses equivalent + B-piece loss data corpus."

### Step 7: Cross-Portfolio Data Extraction

- **stepNumber:** 7
- **title:** Cross-Portfolio Data Extraction
- **description (modernized):** "Cross-reference the new deal against Eightfold's broader UW corpus to ensure consistent analysis and integration with historical data. Query approved deals and the UW Library snapshot for comparable properties — by submarket, asset type, sponsor — to surface relevant context and patterns from prior reviews. Loss data should be incorporated where available."
- **mandatory:** true
- **outputType:** `cross_portfolio`
- **relatedPrincipleIds:** [P-III-13] (Eightfold Portfolio Exposure Study)
- **NOTE (modernization record):** Original handbook text was "Develop similar tables to those used previously, extracting data from the CMBS UW Files Batch 1 and CMBS UW Files Batch 2 stored on SharePoint. This step ensures consistent analysis and integration of new insights with historical data, leveraging tblLossData where applicable." Modernized in this atomization because the literal artifacts (CMBS UW Files Batch 1/2 SharePoint folders, tblLossData) pre-date the current registry architecture; "develop similar tables to those used previously" refers to obsolete legacy template work. The step's intent (broad cross-portfolio query) remains valid and forms a coherent corpus-query trio with Step 5 (kicks_registry) and Step 6 (B-piece loss corpus, future). New-spine implementation: query `approved_deals` table + library_snapshot registry.

---

## Section III — Universal Credit Framework

All principles trigger on ALL assets, ALL deals unless noted.

### P-III-1: Reconcile historical NOI to UW NOI

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 1
- **Principle text:** "Reconcile historical NOI to underwritten NOI and explain all material variances"
- **Research actions:**
  - **action_type:** noi_reconciliation_table
  - **verification_required:** true
  - **target_data:** line-item comparison of UW NOI vs historical NOI (T12, T24 if available); identify which line items drive variances
  - **summary_prompt_hint:** "Produce a reconciliation table comparing UW NOI line items to historical periods. Identify material variances (e.g., >10% in any major line) and present the rationale provided by issuer; assess plausibility."

### P-III-2: Normalize UW to market with comps

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 2
- **Principle text:** "Normalize rents, vacancy, concessions, and operating expenses using market-supported assumptions – it is critical to have rent / lease comps provided"
- **Research actions:**
  - **action_type:** market_normalization_check
  - **verification_required:** true
  - **target_data:** compare issuer's UW rent/vacancy/concession/expense assumptions to market comps; surface variances
  - **summary_prompt_hint:** "Identify whether issuer has provided rent and lease comps. If not, flag the gap. If yes, assess whether issuer's UW assumptions are consistent with the comps."

### P-III-3: Subtract recurring capex/TI/LC/FF&E/reserves from NOI

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 3
- **Principle text:** "Incorporate recurring capex, TI/LC, FF&E, and replacement reserves regardless of NOI presentation"
- **Research actions:**
  - **action_type:** ncf_adjustment_check
  - **verification_required:** true
  - **target_data:** identify whether issuer's NOI is gross (excludes these) or net (includes these); compute NCF using market-standard reserve assumptions if missing
  - **summary_prompt_hint:** "Determine whether the issuer's stated NOI already incorporates recurring capex, TI/LC, FF&E, and replacement reserves. If not, deduct market-standard reserves to compute a realistic NCF. Surface the gap if material."

### P-III-4: Cash on hand reserves preferred over springing

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §III, bullet 4
- **Principle text:** "Cash on hand for capital needs is irreplaceable – springing structure is never as good as cash on hand up front and fixed ongoing deposits"
- **Research actions:**
  - **action_type:** reserve_structure_classification
  - **verification_required:** true
  - **target_data:** identify reserve structure type for each reserve category (TI/LC, capex, FF&E, replacement, debt service) — cash upfront, fixed ongoing deposits, springing, hybrid
  - **summary_prompt_hint:** "Classify each reserve and escrow in the loan documents as (1) cash on hand at close, (2) fixed ongoing deposits, (3) springing (triggered only by performance events), or (4) hybrid. Per handbook, springing structures are credit-negative. Flag if material reserves are springing-only."
- **CROSS-REF:** Section V Step 3 (Reserve and Escrow Adequacy Analysis) links this principle via relatedPrincipleIds.

### P-III-5: Cost basis + borrower cash position on refinancings

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, loan_purpose = Refinance
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 5
- **Principle text:** "Always know cost basis and Borrower cash position on refinancings - when did they buy it and how much has been invested"
- **Research actions:**
  - **action_type:** cost_basis_history
  - **verification_required:** true
  - **target_data:** acquisition date, acquisition price, subsequent capital invested
  - **summary_prompt_hint:** "Establish the sponsor's cost basis: acquisition date, purchase price, and total capital invested since acquisition. Surface as part of refinance context."
  - **action_type:** borrower_cash_position
  - **verification_required:** true
  - **target_data:** sponsor's balance sheet or liquidity statement; cash available for capital calls or shortfall coverage
  - **summary_prompt_hint:** "Identify whether the issuer has provided evidence of the sponsor's liquidity / cash position outside the subject deal. Flag if missing — material to refinance risk assessment."
- **NOTE:** Overlaps with P-II-2's cost_basis_comparison research action. Captured separately because (a) Section III restated this as a required check, (b) adds the "borrower cash position" dimension P-II-2 doesn't have, (c) atomization preserves handbook structure. Engine may consolidate executions at runtime if firing both is redundant for a given deal.

### P-III-6: Evaluate leverage via DSCR + Debt Yield + LTV combination

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 6
- **Principle text:** "Evaluate leverage using DSCR, Debt Yield, and LTV in combination"
- **NOTE:** Methodology principle, not a threshold. Asset-type-specific thresholds for these metrics live in Section IV principles. This one ensures LLM considers all three metrics together when summarizing leverage.

### P-III-7: Sales comps from submarket with comparability assessment

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 7
- **Principle text:** "Critical to have property sales comparables from the submarket to triangulate value; always evaluate how like they are to the subject"
- **Research actions:**
  - **action_type:** sales_comps_evaluation
  - **verification_required:** true
  - **target_data:** sales comps from the property's submarket × asset type; metadata for comparability (size, vintage, tenancy, sale date, condition)
  - **summary_prompt_hint:** "Identify whether issuer provided sales comparables. If yes, assess each comp's relevance to subject (submarket match, size, vintage, tenancy profile, condition, sale recency). If no, flag the gap and surface what comps are available externally."

### P-III-8: Stress DSCR per asset-level volatility

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 8
- **Principle text:** "Stress DSCR under scenarios consistent with asset-level volatility; for office, retail and industrial this means removing specific tenants from the NOI to see coverage if they vacate."
- **NOTE:** Methodology specifics live in Section V Step 2 (Asset-Specific Stress Testing). This principle ensures the philosophy ("stress per asset volatility") is injected as context when the engine processes stress test outputs.
- **CROSS-REF:** Section V Step 2 should link this principle via relatedPrincipleIds during cleanup pass.

### P-III-9: Value via stabilized and stressed cap rates

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §III, bullet 9
- **Principle text:** "Assess value using both stabilized and stressed cap rate assumptions"
- **NOTE:** Paired with stress testing (P-III-8 and Section V Step 2) but addresses VALUE rather than NOI. Engine should produce value scenarios under both cap rate assumptions. No deterministic threshold — handbook does not give one, and inventing one is out of scope.

### P-III-10: Distinguish term risk from maturity risk

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §III, bullet 10
- **Principle text:** "Explicitly distinguish term risk from maturity risk"

### P-III-11: Present sources & uses with cash-in/cash-out designation

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 11
- **Principle text:** "Clearly present sources and uses and identify whether proceeds are cash-in or cash-out"
- **Research actions:**
  - **action_type:** sources_and_uses_extraction
  - **verification_required:** true
  - **target_data:** structured sources & uses table from ASR; classification of proceeds direction (cash-in / cash-out / neutral / acquisition)
  - **summary_prompt_hint:** "Extract the sources and uses table from the deal documents. Identify the net direction of proceeds: cash-in (sponsor adds equity), cash-out (sponsor takes equity out), neutral (refinance at par), or acquisition (purchase money)."
- **CROSS-REF (upstream data dependency):** P-II-3's deterministic cash-out detection check depends on this research action's output. The engine cannot run P-II-3's arithmetic check until P-III-11's structured S&U data is available.

### P-III-12: Sponsor review (litigation, bankruptcies, foreclosures, press, portfolio correlation)

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 12
- **Principle text:** "Include a dedicated sponsor review addressing litigation, bankruptcies, foreclosures, press, and portfolio correlation"
- **Research actions:**
  - **action_type:** sponsor_litigation_search
  - **verification_required:** true
  - **target_data:** lawsuits naming sponsor or sponsor entities; court filings; settlements
  - **summary_prompt_hint:** "Search public court records and legal databases for litigation involving the sponsor or affiliated entities. Surface findings with case names, status, and any patterns."
  - **action_type:** sponsor_bankruptcy_foreclosure_history
  - **verification_required:** true
  - **target_data:** bankruptcy filings, foreclosure proceedings naming sponsor or affiliated entities
  - **summary_prompt_hint:** "Search bankruptcy and foreclosure records for the sponsor and known affiliated entities. Surface any prior or active proceedings."
  - **action_type:** sponsor_press_search
  - **verification_required:** true
  - **target_data:** news articles, industry press, controversy or fraud allegations
  - **summary_prompt_hint:** "Search for press coverage of the sponsor (industry publications + general news). Surface any controversies, fraud allegations, regulatory actions, or material negative coverage."
  - **action_type:** sponsor_portfolio_correlation
  - **verification_required:** true
  - **target_data:** other deals in Eightfold's UW corpus involving this sponsor (approved_deals + kicks_registry); outcomes
  - **summary_prompt_hint:** "Query Eightfold's UW Library and kicks_registry for prior deals involving this sponsor. Surface count, outcomes (approved/rejected), and any patterns."
- **CROSS-REF:** Section V Step 4 (Market and Sponsor Due Diligence) links this principle via relatedPrincipleIds.

### P-III-13: Eightfold Portfolio Exposure Study (cross-portfolio corpus query)

- **Cluster:** Universal Framework
- **Trigger:** ALL assets, ALL deals
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §III, bullet 13
- **Principle text:** "Eightfold Portfolio Exposure Study: always look at the existing portfolio of UWs that have been completed at Eightfold to see what has already been evaluated in a given submarket of a like-property type, and also cross reference sponsors. The Eightfold UW files are a source of independently verified and reviewed data and should be leveraged. There should also be a full review of our master list of loan removals over time to identify other prior kicks in a submarket of a given property type."
- **Research actions:**
  - **action_type:** uw_library_cross_reference
  - **verification_required:** true
  - **target_data:** approved_deals + library_snapshot — match by submarket (city/state/MSA) × asset type; cross-reference sponsors
  - **summary_prompt_hint:** "Query Eightfold's UW Library for prior deals in the same submarket and asset type. Cross-reference sponsors across all of UW history. Surface relevant patterns, comparable deals, and any context that informs the current review."
  - **action_type:** kicks_corpus_cross_reference
  - **verification_required:** true
  - **target_data:** kicks_registry — match by submarket × asset type; surface kick rationale (Comments field)
  - **summary_prompt_hint:** "Query the kicks_registry for prior rejections in the same submarket and asset type. Surface the Comments field — analyst rationale for those prior kicks. Identify whether issues that caused prior kicks may apply to the current deal."
- **CROSS-REF:** Section V Steps 5 and 7 link this principle via relatedPrincipleIds.
- **NOTE:** This principle is the universal-framework formalization of the institutional-memory consultation doctrine. P-III-13's research actions are the primary handles for institutional-memory queries at analysis time. Engine implementation should treat this as the canonical entry point for "consult prior UWs + prior kicks" rather than re-implementing the queries inside each Section V step.

---

## Section IV — Asset-Type Specific Underwriting Considerations

### Cluster: Single-Tenant Risk (any property type)

- **section:** asset_type_specific
- **title:** Single-Tenant Risk
- **assetTypeScope:** 'ANY' (cross-cutting — applies to single-tenant deals across all property types)
- **narrative (verbatim):**
  > "Single-tenant assets can generate outsized and asymmetric loss, particularly when tenancy is credit-driven rather than market-driven. As such, all single-tenant loans should be underwritten with elevated skepticism, regardless of reported in-place cash flow strength.
  >
  > A critical underwriting pitfall in single-tenant deals is overreliance on appraiser-derived 'dark value.' In our experience, appraisal dark value methodologies materially overstate realizable value in distress due to flawed assumptions around re-leasing velocity, achievable rents, downtime, and capital costs. The key driver of this is assumptions around entrepreneurial profit and what a buyer would truly pay to take on the risk of buying an empty building. Even if we agree on the re-stabilized value the appraisers overestimate what that means for dark value today and how much an investor would need to get paid to take that execution risk.
  >
  > Internally at Eightfold, we frequently diverge significantly from appraisal dark value conclusions because of this point. As a conservative rule of thumb, we often haircut appraised dark value by ~50% to approximate what we believe is a more realistic liquidation or re-tenanting value under stress.
  >
  > This adjustment is not a substitute for asset-specific analysis, but rather a baseline conservatism applied to single-tenant underwriting where exit value is highly path-dependent."

**Shared trigger for all principles in this cluster:**
- ALL asset types
- AND (single_tenant = TRUE OR top_tenant_share_of_noi > 0.50)

---

#### P-IV-ST-1: Single-tenant deals require elevated skepticism

- **Cluster:** Single-Tenant Risk
- **Trigger:** (shared cluster trigger)
- **Execution modes:** LLM_CONTEXT
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Single-Tenant Risk, paragraph 1
- **Principle text:** "All single-tenant loans should be underwritten with elevated skepticism, regardless of reported in-place cash flow strength."

#### P-IV-ST-2: Credit-driven tenancy higher risk than market-driven

- **Cluster:** Single-Tenant Risk
- **Trigger:** (shared cluster trigger)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Single-Tenant Risk, paragraph 1
- **Principle text:** "Single-tenant assets can generate outsized and asymmetric loss, particularly when tenancy is credit-driven rather than market-driven."
- **Research actions:**
  - **action_type:** tenancy_credit_vs_market_assessment
  - **verification_required:** true
  - **target_data:** evidence of whether tenant relationship is credit-driven (build-to-suit, sale-leaseback, bespoke terms, above-market rent) vs market-driven (standard market lease, market rent, location-driven)
  - **summary_prompt_hint:** "Classify the tenant relationship as credit-driven (build-to-suit, sale-leaseback, bespoke deal economics, rent above market) vs market-driven (location/market-supported tenancy at market terms). Credit-driven tenancy presents elevated risk because backfill at the same rent is unlikely if tenant vacates."

#### P-IV-ST-3: Appraiser dark value methodology overstates realizable value

- **Cluster:** Single-Tenant Risk
- **Trigger:** (shared cluster trigger)
- **Execution modes:** LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Single-Tenant Risk, paragraph 2
- **Principle text:** "Appraisal dark value methodologies materially overstate realizable value in distress due to flawed assumptions around re-leasing velocity, achievable rents, downtime, and capital costs. Even if we agree on the re-stabilized value, the appraisers overestimate what that means for dark value today and how much an investor would need to get paid to take that execution risk."

#### P-IV-ST-4: Haircut appraised dark value by ~50%

- **Cluster:** Single-Tenant Risk
- **Trigger:** (shared cluster trigger)
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Single-Tenant Risk, paragraph 3
- **Principle text:** "As a conservative rule of thumb, we often haircut appraised dark value by ~50% to approximate what we believe is a more realistic liquidation or re-tenanting value under stress. This adjustment is not a substitute for asset-specific analysis, but rather a baseline conservatism applied to single-tenant underwriting where exit value is highly path-dependent."
- **Deterministic check (stressed dark value coverage):**
  - **metric:** computed: `stressed_dark_value = appraised_dark_value × 0.50`
  - **operator:** `<`
  - **threshold:** `loan_amount`
  - **flag_message:** "Stressed dark value (50% haircut on appraised dark value) is below loan amount. The B-piece may be unsecured under stress. Per handbook, this is a baseline conservatism — confirm with asset-specific analysis."
  - **flag_severity:** high
- **NOTE:** The 50% haircut is a baseline heuristic, not a hard rule. The handbook explicitly states "This adjustment is not a substitute for asset-specific analysis." The deterministic flag should be paired with LLM context so the analyst sees both the computation result AND the handbook caveat. Engine should also surface asset-specific dark value analysis from issuer if available.
- **DEPENDENCY:** Requires `appraised_dark_value` field in the deal data. If form/extraction doesn't capture this today, the check is inert until added. File ticket if needed.

---

### Cluster: Industrial

- **section:** asset_type_specific
- **title:** Industrial
- **assetTypeScope:** Industrial
- **narrative:** None (flat-bullet section in handbook)

All principles in this cluster trigger on `asset_type = Industrial` unless noted otherwise.

---

#### P-IV-IND-1: Older specialized manufacturing assets — elevated backfill risk

- **Cluster:** Industrial
- **Trigger:** asset_type = Industrial AND property_sub_type ∈ {"Manufacturing", "Specialized Manufacturing", "Heavy Industrial"} (placeholder values — verify against actual sub-type taxonomy in production)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Industrial, "Functional obsolescence" group, bullet 1
- **Principle text:** "Older and highly specialized manufacturing assets pose elevated backfill risk"
- **Research actions:**
  - **action_type:** industrial_backfill_assessment
  - **verification_required:** true
  - **target_data:** building age, specialization indicators (purpose-built features, custom power/HVAC, unique floor configurations, heavy floor loading for specific equipment), evidence of re-tenanting market
  - **summary_prompt_hint:** "Assess the building's age and degree of specialization. Specialized manufacturing buildings (purpose-built power, plant configurations, custom HVAC, heavy floor loading for specific equipment) face elevated backfill risk if current tenant vacates. Surface re-tenanting feasibility."
- **NOTE:** Overlaps with P-II-5 (fungibility) and P-II-8 (specialty assets). Captured separately because the handbook restated this with industrial-specific framing (the "older + specialized + manufacturing" combination is more specific than the universal specialty list). Engine may consolidate firings at runtime.

#### P-IV-IND-2: Sale-leasebacks with PE-owned non-credit tenants are negative

- **Cluster:** Industrial
- **Trigger:** asset_type = Industrial AND single_tenant = TRUE (sale-leasebacks are by definition single-tenant)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Industrial, "Tenant and structure risk" group, bullet 1
- **Principle text:** "Sale-leasebacks with private equity-owned, non-credit tenants are viewed negatively"
- **Research actions:**
  - **action_type:** sale_leaseback_detection
  - **verification_required:** true
  - **target_data:** transaction history (was property recently acquired in a sale-leaseback structure?), tenant ownership type (PE-owned vs publicly traded vs privately held), tenant credit rating (investment-grade vs non-investment-grade vs unrated)
  - **summary_prompt_hint:** "Identify whether the deal is a sale-leaseback (tenant was prior owner, sold to current sponsor, leased back). Determine tenant ownership type — flag if PE-owned. Establish tenant credit quality — flag if non-investment-grade or unrated. The combination (sale-leaseback + PE-owned + non-credit tenant) is a handbook-level negative signal."
- **NOTE:** Three conditions must combine for the negative signal (sale-leaseback AND PE-owned AND non-credit). Captured as one principle rather than three separate principles to preserve the conjunctive structure the handbook articulated. Cross-references P-IV-ST-2 (credit-driven vs market-driven tenancy in single-tenant cluster) — these are related but distinct framings.

#### P-IV-IND-3: Tenant credit quality critical when lease term is primary support

- **Cluster:** Industrial
- **Trigger:** asset_type = Industrial AND (single_tenant = TRUE OR top_tenant_share_of_noi > 0.50)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Industrial, "Tenant and structure risk" group, bullet 2
- **Principle text:** "Tenant credit quality is critical where lease term is the primary support"
- **Research actions:**
  - **action_type:** tenant_credit_assessment
  - **verification_required:** true
  - **target_data:** tenant credit rating (S&P/Moody's/Fitch if rated), public financials if applicable, parent guarantor structure, remaining lease term, contracted rent vs market rent
  - **summary_prompt_hint:** "Assess the tenant's credit quality. Surface credit rating (or note absence), financial strength, parent guarantor. If the lease term is the primary credit support (long remaining lease, single-tenant or concentrated, rent above market), tenant default risk is the central concern. Flag accordingly."
- **NOTE:** Overlaps with P-IV-ST-2 (credit-driven tenancy in single-tenant cluster) but adds the "lease term as primary support" condition. Captured separately because the framing is meaningfully different — P-IV-ST-2 is about the NATURE of the relationship (credit-driven vs market-driven); this is about the ROLE of the lease in deal support.

#### P-IV-IND-4: Fungible newer-build industrial with modern specs preferred

- **Cluster:** Industrial
- **Trigger:** asset_type = Industrial
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary
- **Severity:** advisory
- **Source citation:** Handbook §IV, Industrial, "Preferred asset profile" group, bullet 1
- **Principle text:** "Fungible, newer-build industrial assets with standard modern specifications are favored"
- **Research actions:**
  - **action_type:** industrial_specs_assessment
  - **verification_required:** true
  - **target_data:** year built, year renovated, clear heights, loading dock count and configuration, power capacity, fire suppression, building configuration (column spacing, bay depth, office/warehouse ratio)
  - **summary_prompt_hint:** "Assess industrial asset profile vs modern market standards. Newer-build with standard modern specs (32'+ clear, ample loading, modern power, sprinklered) is positive. Explicitly evaluate clear height, loading, power, and configuration per handbook. Identify whether the asset matches modern preferences or shows obsolescence indicators."
- **NOTE:** Positive-attribute principle (describes what's "favored"). Severity is `advisory` because this is positive framing, not a credit negative. Injection point is `executive_summary` only — the LLM uses this to characterize the deal holistically when the preferred profile is present. Overlaps with P-II-5 (fungibility) but adds industrial-specific concrete specs. Handbook bullet "Evaluate clear height, loading, power, and configuration" was atomization-folded into this principle's research action (it specifies the methodology for the preferred-profile assessment rather than introducing a new principle).

#### P-IV-IND-5: Dynamic markets with diversified industrial demand preferred

- **Cluster:** Industrial
- **Trigger:** asset_type = Industrial
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** advisory
- **Source citation:** Handbook §IV, Industrial, "Preferred asset profile" group, bullet 2
- **Principle text:** "Dynamic markets with diversified demand are preferred"
- **Research actions:**
  - **action_type:** industrial_market_diversification
  - **verification_required:** true
  - **target_data:** submarket industrial absorption trends, dominant employment sectors driving demand, employment concentration (single-industry vs diversified)
  - **summary_prompt_hint:** "Assess the submarket's industrial demand base. Diversified demand (multiple sectors, no single-industry dependence) is positive. Surface single-industry concentration as a risk factor."
- **NOTE:** Bi-directional principle — fires as positive context (summary) when preferred condition holds, fires as red flag when condition is absent (concentrated single-industry demand). Overlaps with P-II-5 (fungible assets in liquid markets) but adds industrial-specific framing about demand diversification.

#### (Handbook bullet absorbed: "Highly specialized use like cold-storage is an underwriting challenge")

Captured upstream by P-II-8 (Specialized assets are higher risk). Cold Storage is already in P-II-8's deterministic specialty sub-type list. No new industrial-specific content; skipped to avoid pure duplication.

---

**End of Industrial cluster.** 5 atomic principles: P-IV-IND-1, P-IV-IND-2, P-IV-IND-3, P-IV-IND-4 (absorbed "evaluate clear height, loading, power, configuration" bullet), P-IV-IND-5.

---

### Cluster: Self-Storage

- **section:** asset_type_specific
- **title:** Self-Storage
- **assetTypeScope:** SelfStorage
- **narrative:** None (flat-bullet section)

All principles in this cluster trigger on `asset_type = SelfStorage` unless noted otherwise.

---

#### P-IV-SS-1: Stable historical performance essential

- **Cluster:** Self-Storage
- **Trigger:** asset_type = SelfStorage
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §IV, Self-Storage, "Operating stability" group, bullet 1
- **Principle text:** "Stable historical performance is essential"
- **Research actions:**
  - **action_type:** ss_historical_performance_stability
  - **verification_required:** true
  - **target_data:** historical NOI, occupancy, rent per SF trends over available periods (T36/T24/T12)
  - **summary_prompt_hint:** "Assess the stability of historical operating metrics — NOI, occupancy, rent per SF. Self-storage deals rely heavily on operating stability; volatility or recent ramp is a red flag. If history is short or shows volatility, surface as a credit concern."
- **NOTE:** Overlaps with P-II-4 (stable durable cash flow) but is asset-type-specific. Self-storage is particularly sensitive to operating stability because the asset class is more management-intensive than other property types.

#### P-IV-SS-2: SF per capita supply check (~7 SF benchmark)

- **Cluster:** Self-Storage
- **Trigger:** asset_type = SelfStorage
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Self-Storage, "Supply discipline" group, bullets 1-2 (absorbed methodology bullet "Evaluate supply at the trade-area level using per-capita metrics")
- **Principle text:** "Evaluate supply at the trade-area level using per-capita metrics. Approximately 7 SF per capita is a key benchmark; materially higher levels warrant caution."
- **Deterministic check (oversupply detection):**
  - **metric:** trade_area_sf_per_capita
  - **operator:** `>`
  - **threshold:** 9
  - **flag_message:** "Trade-area supply is {X} SF per capita, materially above the ~7 SF benchmark. Per handbook, oversupply warrants caution — flag elevated competition risk."
  - **flag_severity:** high
- **Advisory check (approaching saturation):**
  - **metric:** trade_area_sf_per_capita
  - **operator:** `>=`
  - **threshold:** 7
  - **AND `<= 9`**
  - **flag_message:** "Trade-area supply is {X} SF per capita, near the ~7 SF benchmark. Supply is at saturation; new product or rate-cutting competitors could pressure performance."
  - **flag_severity:** medium
- **Research actions:**
  - **action_type:** ss_trade_area_supply_analysis
  - **verification_required:** true
  - **target_data:** trade-area population (3-mile or 5-mile radius); existing self-storage SF in trade area (existing facilities + facilities under construction); resulting SF per capita
  - **summary_prompt_hint:** "Compute trade-area SF per capita: identify the relevant trade-area population (typically 3- or 5-mile radius), aggregate existing and under-construction self-storage SF in that area, divide. The handbook benchmark is ~7 SF per capita; materially higher signals oversupply risk."
- **DEPENDENCY:** Requires trade-area population data + competitor SF inventory data. If engine doesn't have this structured today, the research action surfaces what issuer provided (most ASRs include this analysis) and the deterministic check fires only when the metric is computable.
- **NOTE on threshold calibration:** Handbook explicitly says "Approximately 7 SF per capita" and "materially higher warrants caution." The "9" threshold for the high-severity flag and the 7-9 advisory band are calibration choices made during atomization, not directly from handbook text. The 7-9 advisory tier surfaces "approaching saturation" before the materially-oversupplied flag fires. Open to recalibration if 9 is too tight or too loose in practice.

#### P-IV-SS-3: Debt yield floor 8% with market quality condition

- **Cluster:** Self-Storage
- **Trigger:** asset_type = SelfStorage
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Self-Storage, "Credit standards" group, bullet 1
- **Principle text:** "Debt yield of 8% is as low as you should go, and only in good markets with history"
- **Deterministic check 1 (hard floor):**
  - **metric:** debt_yield
  - **operator:** `<`
  - **threshold:** 0.08
  - **flag_message:** "Debt yield is {X}%, below the 8% handbook floor for self-storage. This level should not be accepted."
  - **flag_severity:** critical
- **Deterministic check 2 (at-floor conditional):**
  - **metric:** debt_yield
  - **operator:** `>=`
  - **threshold:** 0.08
  - **AND `< 0.09`** (within 1% of floor)
  - **flag_message:** "Debt yield is {X}%, at or near the 8% handbook floor. Per handbook, this level is acceptable ONLY in good markets with operating history. Confirm market quality and historical track record meet the conditional."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** ss_market_quality_assessment
  - **verification_required:** true
  - **target_data:** market tier (primary/secondary/tertiary), submarket performance history, established competitors with operating track record, demographic trends
  - **summary_prompt_hint:** "Assess whether the market qualifies as 'good market with history' per handbook. Established primary/secondary submarkets with multi-year operating track records of mature self-storage facilities qualify. Developing markets, tertiary locations, or markets with limited competitor history do NOT qualify; in such markets, debt yield should exceed 8% by a meaningful margin."
- **NOTE on structure:** Two deterministic checks mirror the handbook's two conditions: (1) hard 8% floor for any deal, (2) conditional "good market with history" requirement when approaching the floor. The 9% upper bound for "near the floor" is a calibration choice; handbook doesn't quantify "good markets with history" so the conditional is qualitative.

#### P-IV-SS-4: Minimum DSCR ~1.30x

- **Cluster:** Self-Storage
- **Trigger:** asset_type = SelfStorage
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Self-Storage, "Credit standards" group, bullet 2
- **Principle text:** "Target minimum DSCR of approximately 1.30x"
- **Deterministic check (DSCR floor):**
  - **metric:** dscr
  - **operator:** `<`
  - **threshold:** 1.30
  - **flag_message:** "DSCR is {X}x, below the 1.30x handbook minimum for self-storage. Per handbook, this level falls short of the target minimum coverage."
  - **flag_severity:** high
- **Advisory check (near floor):**
  - **metric:** dscr
  - **operator:** `>=`
  - **threshold:** 1.30
  - **AND `< 1.35`**
  - **flag_message:** "DSCR is {X}x, at or near the 1.30x handbook minimum. Limited cushion against NOI decline or rate increase at refinance."
  - **flag_severity:** medium
- **NOTE on calibration:** Handbook says "approximately 1.30x" — captured at the 1.30 floor. Advisory band 1.30-1.35 (medium severity) added to surface deals at-or-near the floor where cushion is thin. Open to recalibration.

---

**End of Self-Storage cluster.** 4 atomic principles (P-IV-SS-2 absorbed the "evaluate supply via per-capita metrics" methodology bullet). This cluster exercised the deterministic schema heavily — 3 of 4 principles have deterministic checks with real thresholds, two with multi-tier (hard + advisory) structures.

---

### Cluster: Mobile Home Parks (MHC)

- **section:** asset_type_specific
- **title:** Mobile Home Parks (MHC)
- **assetTypeScope:** MHC
- **narrative:** None (flat-bullet section)

All principles in this cluster trigger on `asset_type = MHC` unless noted otherwise.

---

#### P-IV-MHC-1: Property age and condition critical

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** high
- **Source citation:** Handbook §IV, MHC, "Physical infrastructure quality" group, bullet 1
- **Principle text:** "Property age and condition are critical"
- **Research actions:**
  - **action_type:** mhc_age_condition_assessment
  - **verification_required:** true
  - **target_data:** park established date, average home age, condition reports, recent capex history, deferred maintenance indicators
  - **summary_prompt_hint:** "Assess the age and physical condition of the park. Many MHC parks are decades old with deferred infrastructure. Surface park age, condition rating, and any indicators of substantial deferred maintenance or capex requirements."

#### P-IV-MHC-2: Understand utility structure (municipal vs private)

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, MHC, "Physical infrastructure quality" group, bullet 2
- **Principle text:** "Fully understand utility structure for water and sewer, including municipal versus private systems"
- **Research actions:**
  - **action_type:** mhc_utility_structure_classification
  - **verification_required:** true
  - **target_data:** water source (municipal connection vs private wells), wastewater handling (municipal sewer vs private septic vs private treatment plant), age of any private systems, regulatory compliance status
  - **summary_prompt_hint:** "Classify the park's water and sewer infrastructure: (1) municipal (connected to city utilities), (2) private (wells, septic systems, on-site treatment), or (3) hybrid. Private systems represent material capex exposure and environmental compliance risk. Surface the structure type and any private infrastructure capex/compliance risks explicitly."

#### P-IV-MHC-3: Private wastewater treatment / lift stations — significant capex risk

- **Cluster:** MHC
- **Trigger:** asset_type = MHC AND has_private_wastewater_treatment_or_lift_station = TRUE
- **Execution modes:** DETERMINISTIC (conditional), LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, MHC, "Physical infrastructure quality" group, bullet 3
- **Principle text:** "Private wastewater treatment plants and lift stations pose significant capex risk"
- **Deterministic check (private wastewater detection):**
  - **metric:** utility_infrastructure_type (derived from P-IV-MHC-2's research output)
  - **operator:** contains
  - **threshold:** "private wastewater treatment" OR "lift station"
  - **flag_message:** "Park has private wastewater treatment plant and/or lift station infrastructure. Per handbook, these pose significant capex risk — material capital reserves and ongoing regulatory compliance exposure. Surface the system age, recent inspections, and any pending compliance issues."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** mhc_wastewater_capex_assessment
  - **verification_required:** true
  - **target_data:** age of treatment plant or lift station, recent capex history, pending regulatory issues, estimated replacement cost
  - **summary_prompt_hint:** "If park has private wastewater infrastructure, assess: age of the system (treatment plants typically have 20-30 year useful lives), recent capex history, any pending regulatory issues or compliance gaps, estimated replacement cost. Surface as material credit consideration."
- **CROSS-REF (upstream data dependency):** Depends on P-IV-MHC-2's research action output (utility structure classification) for the deterministic check to fire.
- **NOTE:** First principle with explicit research-action dependency for its deterministic check to fire (similar pattern to P-II-3 depending on P-III-11's sources & uses extraction). Schema accommodates this — it's a runtime ordering issue: engine implementation must run P-IV-MHC-2's research first, then evaluate P-IV-MHC-3's deterministic check against the output. Both fire together when the upstream returns private wastewater infrastructure.

#### P-IV-MHC-4: Park-owned homes — vacancy and capex exposure

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, MHC, "Park-owned homes" group, bullet 1
- **Principle text:** "Analyze the number of park-owned homes and associated vacancy and capex exposure"
- **Deterministic check (POH concentration):**
  - **metric:** park_owned_home_share (= park-owned home count / total home count)
  - **operator:** `>`
  - **threshold:** 0.25
  - **flag_message:** "Park-owned home share is {X}%, representing material POH exposure. Per handbook, POH carries direct vacancy and capex exposure on top of normal lot rent risk. Surface POH count, vacancy on POH specifically, and capex needs on the POH inventory."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** mhc_poh_analysis
  - **verification_required:** true
  - **target_data:** total home count, park-owned home count, POH share, vacancy on POH inventory, age and condition of POH inventory, recent capex history on POHs
  - **summary_prompt_hint:** "Surface the breakdown of park-owned vs tenant-owned homes. Analyze POH vacancy (separately from lot vacancy), age and condition of POH inventory, and recent capex history. Material POH exposure (>25% of homes) represents elevated risk on top of normal MHC park dynamics."
- **NOTE on threshold calibration:** Handbook does not specify a POH concentration threshold. The 25% threshold is calibration based on industry context — POH share below 25% is generally manageable; above 25% materially elevates risk profile. Open to recalibration.

#### P-IV-MHC-5: Regulatory and eviction dynamics

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, MHC, "Park-owned homes" group, bullet 2
- **Principle text:** "Understand regulatory and eviction dynamics"
- **Research actions:**
  - **action_type:** mhc_regulatory_assessment
  - **verification_required:** true
  - **target_data:** state-level MHC tenant protections, lot rent increase notice requirements, eviction restrictions, park closure restrictions, any local rent control or stabilization
  - **summary_prompt_hint:** "Identify state and local regulations affecting the park's economic flexibility. Surface notice requirements for lot rent increases, eviction procedures (often slower than typical multifamily), park closure restrictions, and any local rent control. States with strong MHC tenant protections (e.g., California, Oregon) materially affect both operations and exit liquidity."

#### P-IV-MHC-6: Environmental risk from older plumbing/sewage

- **Cluster:** MHC
- **Trigger:** asset_type = MHC AND has_private_wastewater_treatment_or_lift_station = TRUE (shared dependency with P-IV-MHC-3 — depends on P-IV-MHC-2's research output)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, MHC, "Regulatory and exit considerations" group, bullet 1
- **Principle text:** "Environment risk is a core concern, specifically with older plumbing / sewage systems"
- **Research actions:**
  - **action_type:** mhc_environmental_assessment
  - **verification_required:** true
  - **target_data:** Phase I/II environmental assessments, historical site contamination, EPA enforcement history, indemnity structures, environmental insurance
  - **summary_prompt_hint:** "Assess environmental risk specific to MHC infrastructure: older plumbing or sewage systems can leak/contaminate groundwater (environmental liability), septic system failures can trigger EPA or state-level enforcement, and the long lifespan of mobile home parks means historic contamination from prior decades may still surface. Surface Phase I/II environmental assessment status, any historical contamination, and indemnity structures in the loan documents."
- **NOTE:** Distinct from P-IV-MHC-3 despite both firing on private wastewater infrastructure. P-IV-MHC-3 is about CAPEX (replacement/upgrade cost). P-IV-MHC-6 is about ENVIRONMENTAL LIABILITY (contamination, EPA, indemnification). Different domains, different mitigations, captured separately.

#### P-IV-MHC-7: Exit liquidity and buyer universe under stress

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, MHC, "Regulatory and exit considerations" group, bullet 2
- **Principle text:** "Exit liquidity and buyer universe under stress must be evaluated"
- **Research actions:**
  - **action_type:** mhc_exit_liquidity_assessment
  - **verification_required:** true
  - **target_data:** recent MHC sales in submarket × similar size/quality, identifiable buyer universe (institutional MHC operators active in market, REITs, regional buyers), sales velocity under recent market conditions
  - **summary_prompt_hint:** "Assess exit liquidity specific to MHC: the buyer universe is materially narrower than mainstream CRE (handful of institutional MHC operators, REITs, regional mom-and-pop investors). Surface recent comparable MHC sales, identifiable buyer pool, and how that pool may contract under stress. Limited exit liquidity is a meaningful credit factor."
- **NOTE:** Overlaps with P-II-5 (fungible assets in liquid markets) but adds MHC-specific framing about the narrow institutional buyer universe.

#### P-IV-MHC-8: Tenant reviews mandate (1-2 star focus)

- **Cluster:** MHC
- **Trigger:** asset_type = MHC
- **Execution modes:** RESEARCH, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high (handbook uses "ALWAYS" — mandatory)
- **Source citation:** Handbook §IV, MHC, "Regulatory and exit considerations" group, bullet 3
- **Principle text:** "Tenant reviews from third party websites provide great insight, ALWAYS review these and summarize what you see in the 1 and 2 star reviews."
- **Research actions:**
  - **action_type:** tenant_reviews_third_party
  - **verification_required:** true (analyst MUST verify the AI summary independently)
  - **target_data:** 1-star and 2-star reviews from Google Maps, Yelp, ApartmentRatings.com, MobileHomeParkInsider.com, and similar third-party review sites for the specific park
  - **summary_prompt_hint:** "Search third-party review sites for the subject park. Focus on 1-star and 2-star reviews — these surface management issues, infrastructure problems, neighbor disputes, and operational red flags that often don't appear in issuer materials. Summarize themes; flag any patterns that indicate material credit concerns (chronic maintenance failures, predatory management practices, infrastructure deterioration, etc.). Analyst MUST independently verify before relying on this summary."
- **NOTE:** This principle also appears in the Multifamily and Hotel sections of the handbook. When those clusters are atomized, the principle will be duplicated there with asset-type-specific triggers and slightly different review-site targets (TripAdvisor for hotels; ApartmentRatings for multifamily; this set for MHC). The handbook stated the principle three times in three different asset-type contexts — atomization preserves that structure rather than hoisting it to a universal principle, because the relevant review sites differ by asset type.

---

**End of MHC cluster.** 8 atomic principles. Notable patterns: (1) two principles with explicit research-action dependencies (P-IV-MHC-3 and P-IV-MHC-6 both fire on P-IV-MHC-2's output), (2) the same tenant-reviews mandate principle appearing in MHC + soon to appear in Multifamily + Hotel, intentionally not hoisted because the relevant review sources differ by asset type.

---

### Cluster: Office

- **section:** asset_type_specific
- **title:** Office
- **assetTypeScope:** Office
- **narrative:** None (flat-bullet section)

All principles in this cluster trigger on `asset_type = Office` unless noted otherwise.

---

#### P-IV-OFF-1: Flight-to-quality favors top-tier well-located modern buildings

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** advisory (bi-directional — positive when present, implicit negative when absent)
- **Source citation:** Handbook §IV, Office, "Structural demand and asset quality" group, bullet 1
- **Principle text:** "Flight-to-quality dynamics favor top-tier, well-located buildings with modern amenities"
- **Research actions:**
  - **action_type:** office_quality_tier_assessment
  - **verification_required:** true
  - **target_data:** building class (A/B/C), age, amenities, location quality, building condition, recent renovations
  - **summary_prompt_hint:** "Assess the building's quality tier. Class A trophy assets in prime locations with modern amenities benefit from flight-to-quality demand. Class B/C assets face demand pressure. Surface the asset's positioning on this spectrum."

#### P-IV-OFF-2: Class B/C office assets — leasing costs, liquidity, value deterioration risk

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Structural demand and asset quality" group, bullet 2
- **Principle text:** "Class B and C assets face materially higher leasing costs, face liquidity challenges, and are at high risk of suffering value deterioration"
- **Deterministic check (Class B/C detection):**
  - **metric:** building_class (string)
  - **operator:** `in`
  - **threshold (set):** ["B", "C", "B-", "C+", "C-"]
  - **flag_message:** "Office property is Class {X}. Per handbook, Class B/C assets face materially higher leasing costs, liquidity challenges, and elevated value deterioration risk in the post-2020 office market."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** office_class_validation
  - **verification_required:** true
  - **target_data:** stated class designation, building condition relative to class peers, recent renovations that may have effectively upgraded the building, broker / market perception of the asset
  - **summary_prompt_hint:** "Validate the stated building class against the asset's actual characteristics. A 'Class B' designation may understate quality if the building has been recently renovated to A-tier standards; conversely 'Class A' may overstate quality for an older asset that's been poorly maintained. Surface the realistic market positioning."

#### P-IV-OFF-3: Capital reserves essential — appraisal TI estimates typically too low

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Office, "Structural demand and asset quality" group, bullet 3
- **Principle text:** "Capital is key – even the best performing office buildings will need to invest capital to defend occupancy and handle tenant rollover. Being properly reserved is crucial, and appraisal Tenant Improvement (TI) allowance estimates are almost always too low."
- **Research actions:**
  - **action_type:** office_capital_reserve_adequacy
  - **verification_required:** true
  - **target_data:** issuer's reserve structure for TI/LC, the underlying TI assumptions (PSF), reserve $ vs market-comparable TI requirements (which are typically $80-150 PSF for second-generation office in major markets, higher for new tenants), free rent assumptions, AND the subject property's own recent lease economics (TI/LC PSF, free rent months, effective rent net of concessions on leases signed at this property in last 2-3 years)
  - **summary_prompt_hint:** "Assess whether the proposed reserve structure adequately funds TI/LC needs. Compare the appraisal's TI assumptions against TWO benchmarks: (1) recent market-standard TI deals in the submarket (typically $80-150+ PSF for office second-gen, higher for new tenants in newer buildings), AND (2) the subject property's own recent lease economics. Appraisal-derived TI numbers are systematically low per handbook. Flag if reserves appear insufficient against either market reality or the property's own leasing history."
- **CROSS-REF:** Relates to P-III-4 (cash on hand reserves preferred over springing) and Section V Step 3 (Reserve and Escrow Adequacy Analysis). Office adds the specific concern that the appraisal-based TI math is unreliable.
- **NOTE:** Handbook bullet "Analyze TI/LC and free rent on recent leases" was atomization-folded into this principle's research action — same purpose (validate TI/LC/free rent assumptions) but adds the subject property's own historical leasing economics as a second data source alongside general market benchmarks.

#### P-IV-OFF-4: Assess actual utilization vs WFH and space contraction risk

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Space utilization and tenant behavior" group, bullet 1
- **Principle text:** "Assess actual utilization to evaluate work-from-home and space contraction risk"
- **Research actions:**
  - **action_type:** office_actual_utilization_assessment
  - **verification_required:** true
  - **target_data:** tenant utilization data if available (badge swipes, desk reservations, cell-phone-derived occupancy proxies like Placer.ai), tenant stated WFH policy, recent tenant downsizings at renewal in this submarket
  - **summary_prompt_hint:** "Assess actual office utilization vs leased footprint. Low utilization (high contractual occupancy but low physical presence) signals contraction risk at renewal — even AAA tenants may right-size by 20-50% when their lease expires. Surface any utilization data, tenant WFH policies, and submarket precedents for contraction at renewal."
- **NOTE:** Best-effort research action. The data sources (utilization metrics, Placer.ai, badge swipes) are typically not in standard ASR fields. If available, surface; if not available, the absence of utilization data is itself a credit concern that should be surfaced.

#### P-IV-OFF-5: Identify sublease offerings and shadow vacancy

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Space utilization and tenant behavior" group, bullet 2
- **Principle text:** "Identify active sublease offerings and shadow vacancy"
- **Research actions:**
  - **action_type:** office_sublease_shadow_vacancy
  - **verification_required:** true
  - **target_data:** active sublease listings in the submarket, sublease space within the subject property itself, shadow vacancy estimates (tenants underutilizing leased space)
  - **summary_prompt_hint:** "Surface sublease activity in the submarket and within the subject property. Published office vacancy understates real availability when sublease and shadow vacancy are added. Quantify effective vacancy (direct + sublease + shadow) and compare to published vacancy. Material gap = elevated supply pressure."

#### P-IV-OFF-6: Tenant-level DSCR stress with conditions on top 2-3 tenants

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Office, "Cash flow durability" group, bullet 1
- **Principle text:** "Run tenant-level DSCR stresses removing the top two to three tenants, especially if those tenants lease expirations within the term or 1-2 years past maturity or if those tenants are of weak credit quality"
- **Deterministic check (top-tenant concentration with expiration condition):**
  - **metric:** stressed_dscr (computed by removing top 1, 2, and 3 tenants)
  - **operator:** `<`
  - **threshold:** 1.0
  - **flag_message:** "Stressed DSCR after removing top {N} tenant(s) is {X}x, below 1.0x. Building cannot cover debt service without these tenants. Per handbook, this is especially material if their leases expire within term or 1-2 years past maturity."
  - **flag_severity:** critical
- **Research actions:**
  - **action_type:** office_top_tenant_exposure_analysis
  - **verification_required:** true
  - **target_data:** top 3 tenants by revenue, their lease expiration dates relative to loan maturity, their credit quality (rated/unrated, financial strength), the resulting NOI/DSCR under various removal scenarios
  - **summary_prompt_hint:** "Surface top 3 tenants by revenue with: (a) lease expiration vs loan maturity (within term? 1-2 years past? long beyond?), (b) credit quality. Compute DSCR under removal scenarios. Flag tenants meeting ANY of: lease expires within loan term, lease expires within 1-2 years past maturity, weak/unrated credit. These are the cases the handbook flags as 'especially' concerning."
- **CROSS-REF:** Section V Step 2 (Asset-Specific Stress Testing) `relatedPrincipleIds` should include P-IV-OFF-6. The office-specific methodology lives here; the generic stress framework lives in Step 2. The engine already implements TENANT_REMOVAL stress methodology per the reconnaissance report.

#### P-IV-OFF-7: Emphasize leasing velocity since 2023 as competitiveness indicator

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Cash flow durability" group, bullet 2
- **Principle text:** "Emphasize leasing velocity since 2023 as an indicator of competitiveness"
- **Research actions:**
  - **action_type:** office_leasing_velocity_post_2023
  - **verification_required:** true
  - **target_data:** leases signed at the subject property since 2023 (count, SF, rents, free rent, tenant types); submarket leasing velocity benchmarks for the same period
  - **summary_prompt_hint:** "Surface leasing activity at the subject property since 2023 (the post-COVID market reset period). Compare to submarket benchmark velocity. Strong recent leasing = competitive asset. Weak or absent leasing since 2023 in a building with rollover = elevated re-leasing risk. Flag accordingly."
- **NOTE:** Handbook hardcodes "since 2023" as the relevant post-COVID market reset period. Preserved verbatim. When/if handbook updates the reference year, this principle should update too.

#### P-IV-OFF-8: Office liquidity challenged even for quality assets — rely on market-clearing sales comps

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Liquidity and market context" group, bullet 1
- **Principle text:** "Liquidity is challenged even for higher-quality assets; rely on market-clearing sales comps"
- **Research actions:**
  - **action_type:** office_sales_comps_market_clearing
  - **verification_required:** true
  - **target_data:** recent office sales in submarket × similar quality tier; identify which sales were market-clearing (actual closed transactions) vs appraisal-derived; days on market for recent listings
  - **summary_prompt_hint:** "Identify recent ACTUAL closed office sales in the submarket at similar quality tier. Distinguish from appraisal-derived value estimates — only actual transactions reflect market-clearing prices. Note days on market for any recent listings (long DOM signals illiquidity). Office liquidity is materially impaired across all quality tiers; appraisal-derived values likely overstate realizable value in distress."
- **CROSS-REF:** Relates to P-III-7 (sales comps from submarket with comparability assessment). Office adds the specific concern that appraisal-derived values are unreliable; only market-clearing transactions count.

#### P-IV-OFF-9: Evaluate broader submarket distress

- **Cluster:** Office
- **Trigger:** asset_type = Office
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Office, "Liquidity and market context" group, bullet 2
- **Principle text:** "Evaluate broader submarket distress (e.g., DC, Philadelphia)"
- **Deterministic check (distressed submarket detection):**
  - **metric:** city OR msa (string)
  - **operator:** `in` (case-insensitive)
  - **threshold (set):** [
    - Handbook-explicit: "Washington DC", "DC", "District of Columbia", "Philadelphia"
    - Extension (broadly-recognized post-COVID distressed office markets): "San Francisco", "Chicago" (especially Loop/CBD), "Houston" (downtown/Energy Corridor), "Manhattan" (especially Lower/Midtown South Class B), "Portland", "Minneapolis", "St. Louis", "Cleveland", "Pittsburgh" (CBD)
    ]
  - **flag_message:** "Office property is in {X}, a submarket identified as facing structural distress. Per handbook, evaluate broader submarket dynamics beyond property-level fundamentals."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** office_submarket_distress_assessment
  - **verification_required:** true
  - **target_data:** submarket-level office vacancy trends, net absorption trends (positive/negative), tenant migration patterns, employment trends in office-using sectors, public sector / employer footprint changes
  - **summary_prompt_hint:** "Assess broader office submarket health. Surface vacancy trends, net absorption (positive/negative over recent periods), employer migration patterns, sector composition. The submarket distress list is non-exhaustive — flag any submarket showing sustained negative absorption, rising vacancy, or material employer departures."
- **NOTE:** Distressed submarket list is curated based on handbook examples (DC, Philadelphia) + broadly-recognized post-COVID distressed office markets. List is non-exhaustive; the research action is required to catch markets not on the static list. Future ticket may make the submarket list an editable registry artifact (similar to P-II-8's specialty list).

---

**End of Office cluster.** 9 atomic principles (P-IV-OFF-1 through P-IV-OFF-9, with P-IV-OFF-3 absorbing the "Analyze TI/LC and free rent on recent leases" bullet). Notable patterns: (1) bi-directional principle in P-IV-OFF-1 (positive when present, implicit negative when absent), (2) class-tier deterministic detection in P-IV-OFF-2, (3) tenant-stress methodology with explicit cross-ref to Section V Step 2 in P-IV-OFF-6, (4) curated "distressed submarket" list in P-IV-OFF-9 (handbook-explicit + extensions, similar pattern to P-II-8 specialty list).

---

### Cluster: Retail

- **section:** asset_type_specific
- **title:** Retail
- **assetTypeScope:** Retail
- **narrative:** None (flat-bullet section with sub-headings, no narrative prose)

All principles in this cluster trigger on `asset_type = Retail` unless noted otherwise. Mall-specific principles add `property_sub_type ∈ {"Mall", "Regional Mall", "Super-Regional Mall"}` to the trigger.

---

#### P-IV-RET-1: Tenant sales and occupancy costs — health indicators

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Retail, top-level bullet 1
- **Principle text:** "Tenant sales and occupancy costs best indicator of the health of a center"
- **Research actions:**
  - **action_type:** retail_sales_and_occ_cost_analysis
  - **verification_required:** true
  - **target_data:** in-line tenant sales (PSF, $), occupancy cost ratio (rent + CAM / tenant sales), trends in both over recent reporting periods, tenant-level breakdowns where available
  - **summary_prompt_hint:** "Surface tenant sales PSF and occupancy cost ratios for the subject center. Healthy centers show stable/growing sales and occupancy costs that tenants can support. Declining sales or rising occupancy costs signal stress. Surface tenant-level data where available — material weakness in anchor or key tenants is particularly meaningful."

#### P-IV-RET-2: Retail format bifurcation — necessity vs discretionary

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, top-level bullet 2
- **Principle text:** "Retail format bifurcation: power centers and grocery-anchored neighborhood centers are inherently different from regional malls, lifestyle centers and outlet centers"
- **Research actions:**
  - **action_type:** retail_format_classification
  - **verification_required:** true
  - **target_data:** property sub-type (Power Center, Grocery-Anchored, Strip, Mall, Lifestyle Center, Outlet Center, Neighborhood Shopping Center, etc.), anchor tenant identity, tenant mix breakdown by category
  - **summary_prompt_hint:** "Classify the retail asset into one of two broad categories: (1) necessity retail — power centers, grocery-anchored neighborhood centers, certain strip centers; or (2) discretionary retail — regional malls, lifestyle centers, outlet centers. The two categories have fundamentally different demand drivers, cyclicality, and structural outlook. Surface the classification and tailor the rest of the analysis accordingly."

#### P-IV-RET-3: B-quality malls difficult to finance absent dominant market positioning

- **Cluster:** Retail
- **Trigger:** asset_type = Retail AND property_sub_type ∈ {"Mall", "Regional Mall", "Super-Regional Mall"} AND mall_class ∈ {"B", "B+", "B-"}
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Mall-specific risk considerations" group, bullet 1
- **Principle text:** "B-quality malls are difficult to finance absent dominant market positioning"
- **Deterministic check (B-mall detection):**
  - **metric:** combined (property_sub_type is mall) AND (mall_class is B-tier)
  - **operator:** match
  - **threshold:** property_sub_type ∈ mall set AND mall_class ∈ {"B", "B+", "B-"}
  - **flag_message:** "Property is a Class {X} mall. Per handbook, B-quality malls are difficult to finance absent dominant market positioning. Verify whether the mall has dominant market positioning (e.g., only viable mall in trade area, anchor of regional shopping pattern) before proceeding."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** mall_market_positioning_assessment
  - **verification_required:** true
  - **target_data:** competing malls within drive-time (typically 30-60 minutes), trade-area population, anchor tenant uniqueness in the trade area, recent re-tenanting history, sales productivity vs nearby competing malls
  - **summary_prompt_hint:** "Assess whether the mall has 'dominant market positioning' per handbook. Dominant = clear market leader with no comparable competing mall in trade area, or strong-anchor uniqueness (e.g., only Apple Store, only luxury anchors in 50-mile radius). Surface competing malls, their relative sales productivity, and whether the subject mall's position is defensible."
- **NOTE:** Requires mall_class as structured data field. If not available today, deterministic check is inert and research action carries the principle. Future ticket may add mall_class extraction.

#### P-IV-RET-4: Mall inline sales and occupancy cost benchmarks

- **Cluster:** Retail
- **Trigger:** asset_type = Retail AND property_sub_type ∈ {"Mall", "Regional Mall", "Super-Regional Mall"}
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Mall-specific risk considerations" group, bullet 2
- **Principle text:** "Inline sales above ~$500 PSF and occupancy costs in the low-teens are key benchmarks"
- **Deterministic check 1 (inline sales benchmark):**
  - **metric:** inline_sales_psf
  - **operator:** `<`
  - **threshold:** 500
  - **flag_message:** "Mall inline sales are ${X} PSF, below the ~$500 PSF handbook benchmark. Low inline sales signal mall in decline; tenants likely struggle with occupancy costs."
  - **flag_severity:** high
- **Deterministic check 2 (occupancy cost ratio — high):**
  - **metric:** mall_occupancy_cost_ratio
  - **operator:** `>`
  - **threshold:** 0.15
  - **flag_message:** "Mall occupancy cost ratio is {X}%, above the low-teens benchmark. Tenants are under economic stress; expect rising vacancy and rent compression."
  - **flag_severity:** high
- **Advisory check (occupancy cost approaching upper bound):**
  - **metric:** mall_occupancy_cost_ratio
  - **operator:** `>=`
  - **threshold:** 0.13
  - **AND `<= 0.15`**
  - **flag_message:** "Mall occupancy cost ratio is {X}%, at the upper end of the low-teens range. Tenants are operating with thin margin; surface tenant-level stress indicators."
  - **flag_severity:** medium
- **Research actions:**
  - **action_type:** mall_inline_sales_and_occcost
  - **verification_required:** true
  - **target_data:** in-line tenant sales PSF (current period + 2-3 prior periods for trend), occupancy cost ratio (rent + CAM as % of tenant sales), tenant-level breakdowns
  - **summary_prompt_hint:** "Surface mall inline sales PSF and occupancy cost ratios. Compare to handbook benchmarks: $500 PSF inline sales floor, low-teens (~10-15%) occupancy cost. Surface trends — declining sales or rising occupancy costs are leading indicators of mall decline."
- **NOTE on threshold calibration:** Handbook says "above ~$500 PSF" (clear, used as 500 floor) and "low-teens" (interpreted as 10-15% range). The 15% high-severity ceiling and 13-15% advisory band are calibration choices. Open to recalibration.

#### P-IV-RET-5: Mall debt yield mid-teens minimum (fortress Class A exception)

- **Cluster:** Retail
- **Trigger:** asset_type = Retail AND property_sub_type ∈ {"Mall", "Regional Mall", "Super-Regional Mall"}
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Retail, "Mall-specific risk considerations" group, bullet 3
- **Principle text:** "Mall debt yields should generally be in the mid-teens at minimum; fortress Class A malls may support ~10–11%"
- **Deterministic check 1 (base mall debt yield floor):**
  - **metric:** debt_yield
  - **operator:** `<`
  - **threshold:** 0.15
  - **EXCEPTION:** if mall_class = "Fortress Class A", apply threshold 0.10 instead
  - **flag_message:** "Mall debt yield is {X}%, below the mid-teens (15%) handbook minimum. Mall finance market does not support sub-15% debt yields outside of fortress Class A malls."
  - **flag_severity:** critical
- **Deterministic check 2 (fortress Class A absolute floor):**
  - **metric:** debt_yield
  - **operator:** `<`
  - **threshold:** 0.10
  - **applies when:** mall_class = "Fortress Class A"
  - **flag_message:** "Fortress Class A mall debt yield is {X}%, below the 10% floor that applies even to fortress malls. Per handbook, sub-10% debt yields are not supportable for any mall."
  - **flag_severity:** critical
- **Advisory check (fortress Class A at-floor):**
  - **metric:** debt_yield
  - **operator:** `>=`
  - **threshold:** 0.10
  - **AND `< 0.11`**
  - **applies when:** mall_class = "Fortress Class A"
  - **flag_message:** "Fortress Class A mall debt yield is {X}%, at the low end of the ~10-11% acceptable range. Per handbook, this level is only supportable in confirmed fortress assets. Verify market dominance and tenant productivity."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** mall_class_validation
  - **verification_required:** true
  - **target_data:** mall_class designation (A, A+, B, etc.), sales productivity, anchor strength, dominant market positioning, comparison to industry "fortress Class A" definition
  - **summary_prompt_hint:** "Validate the mall_class designation, particularly any claim of 'Fortress Class A.' Fortress Class A is a high bar — typically requires sales > $700-1,000 PSF, top luxury anchors, dominant market position with no comparable competing mall in trade area, and strong long-term occupancy. Surface evidence for/against the designation. The exception to the mid-teens debt yield rule applies ONLY to confirmed fortress Class A."
- **NOTE:** SCHEMA-VALIDATING PRINCIPLE — uses nested exception structure (base threshold + conditional override). This is the case the schema was designed to express during the schema-design conversation (Example 1 from that discussion). Cross-references P-IV-RET-3 (B-mall positioning) — mall_class data feeds both principles.

#### P-IV-RET-6: Calculate cumulative owner cash flow after debt service over loan term

- **Cluster:** Retail
- **Trigger:** asset_type = Retail AND property_sub_type ∈ {"Mall", "Regional Mall", "Super-Regional Mall"}
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Mall-specific risk considerations" group, bullet 4
- **Principle text:** "Cumulative owner cash flow after debt service over the loan term should always be calculated"
- **Deterministic check (cumulative CF over term):**
  - **metric:** computed: `cumulative_cf = sum(NOI - debt_service - reserves - capex) over loan term`
  - **operator:** `<`
  - **threshold:** 0
  - **flag_message:** "Cumulative owner cash flow after debt service over loan term is negative (${X}). Per handbook, this metric must always be calculated for malls. Negative cumulative CF means sponsor must inject capital to service debt; refi risk is elevated."
  - **flag_severity:** high
- **NOTE:** This is the methodology principle — the metric should ALWAYS be computed, regardless of whether it triggers a flag. The deterministic check fires only when cumulative CF is negative. Engine implementation must compute and surface the value in all cases, even when not flagging.

#### P-IV-RET-7: Tenant bankruptcy risk evaluation

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Tenant and lease structure risk" group, bullet 1
- **Principle text:** "Evaluate tenant bankruptcy risk (e.g., movie theaters)"
- **Deterministic check (elevated bankruptcy risk tenant categories):**
  - **metric:** tenant_category (string, derived from tenant list)
  - **operator:** `in`
  - **threshold (set):** [
    - Handbook-explicit: "Movie Theater" (Regal/Cineworld, AMC bankruptcy history)
    - Extension (industries with elevated bankruptcy risk): "Department Store" (Macy's, J.C. Penney, Sears post-bk), "Big-Box Apparel" (Bed Bath & Beyond, Forever 21 post-bk), "Family Entertainment" (Chuck E. Cheese, Dave & Buster's category), "Discount Apparel" (some categories), "Specialty Retail" with weak finances
    ]
  - **flag_message:** "Tenant in elevated-bankruptcy-risk category: {X}. Per handbook, evaluate tenant default risk explicitly. Surface tenant's recent financial performance, any restructuring history, industry distress indicators."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** tenant_bankruptcy_risk_assessment
  - **verification_required:** true
  - **target_data:** tenant rent roll with tenant names and industry categories, public bankruptcy filings by tenant entities, industry-level distress indicators, tenant credit ratings if available
  - **summary_prompt_hint:** "Identify tenants in industries with elevated bankruptcy risk. Surface specific tenants on the rent roll matching the watchlist (movie theaters, department stores, struggling specialty retail, etc.). Check public records for any pending or recent bankruptcy filings by the tenant entities. Surface industry-wide stress patterns."
- **NOTE:** Watchlist categories are curated based on handbook example + broadly-recognized retail bankruptcy patterns. Non-exhaustive. Future ticket may make the watchlist an editable registry artifact (same pattern as P-II-8 specialty assets, P-IV-OFF-9 distressed submarkets).

#### P-IV-RET-8: Alternative tenancy with limited re-tenanting depth

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Tenant and lease structure risk" group, bullet 2
- **Principle text:** "Be wary of alternative tenancy with limited re-tenanting depth (trampoline parks, etc.)"
- **Deterministic check (limited-depth tenant categories):**
  - **metric:** tenant_category (string, derived from tenant list)
  - **operator:** `in`
  - **threshold (set):** [
    - Handbook-explicit: "Trampoline Park"
    - Extension (limited-depth experiential): "Escape Room", "Axe Throwing", "Virtual Reality Arcade", "Indoor Karting", "Indoor Mini Golf", "Children's Play Café", "Children's Edutainment", "Adult Recreation Concept", "Karaoke Room", "Boutique Fitness" (some categories like single-concept yoga/spin where there's limited backfill)
    ]
  - **flag_message:** "Tenant in limited-re-tenanting-depth category: {X}. Per handbook, alternative tenancy of this type carries elevated risk if the tenant vacates — backfill universe is narrow and build-out is concept-specific. Surface lease term, tenant strength, and backfill plan."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** alternative_tenancy_backfill_assessment
  - **verification_required:** true
  - **target_data:** tenant rent roll with category identification, build-out specifics, lease term remaining, the realistic re-tenanting universe (count of operators in the broader market for similar concepts)
  - **summary_prompt_hint:** "Identify tenants representing alternative/specialty concepts with limited re-tenanting depth. Surface the universe of potential replacement tenants if the space vacates — for many of these categories (trampoline parks, escape rooms, VR arcades) the replacement pool is shallow nationally. Build-out costs to convert to a different use can be substantial. Flag where lease has limited term or weak tenant."
- **NOTE:** Watchlist categories curated based on handbook example (trampoline parks) + broadly-recognized "experiential retail with limited backfill" categories. Non-exhaustive. Distinct from P-IV-RET-7 (bankruptcy risk) — this principle is about RE-TENANTING risk even if current tenant performs.

#### P-IV-RET-9: Co-tenancy provisions and sales kick-out rights analysis

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Tenant and lease structure risk" group, bullet 3
- **Principle text:** "Analyze co-tenancy provisions and sales kick-out rights in detail"
- **Research actions:**
  - **action_type:** retail_lease_provision_analysis
  - **verification_required:** true
  - **target_data:** lease abstracts for tenants with co-tenancy provisions or kick-out rights, the specific trigger conditions for each, percentage of NOI at risk if those provisions activate, anchor lease tie-ins
  - **summary_prompt_hint:** "Identify tenants with co-tenancy provisions (rent reduction or termination if anchor or occupancy thresholds aren't met) and sales kick-out rights (tenant termination right if sales fall below threshold). Quantify the percentage of NOI exposed to these provisions. Identify what specific conditions would trigger them (e.g., anchor X vacating, occupancy dropping below 80%, individual tenant sales below threshold). This is rent-at-risk exposure not visible in the rent roll."
- **NOTE:** This data is typically buried in lease documents and not in structured ASR fields. Engine work to extract this would require document parsing capabilities or analyst manual entry. Research action surfaces what issuer provided plus flags absence if analyst review is needed.

#### P-IV-RET-10: Shrinking prototype store sizes and big-box re-tenanting risk

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Physical and demographic fundamentals" group, bullet 1
- **Principle text:** "Understand shrinking prototype store sizes and big-box re-tenanting risk"
- **Research actions:**
  - **action_type:** retail_box_size_retenanting_assessment
  - **verification_required:** true
  - **target_data:** anchor and big-box tenant footprints (SF), tenant category typical prototype size (current vs historical), recent comparable big-box vacancies and re-tenanting outcomes (was box divided? rent lost?)
  - **summary_prompt_hint:** "Identify big-box tenants (typically > 20,000 SF) at the subject. Compare their actual footprint to their tenant category's CURRENT prototype size (most categories have shrunk meaningfully over 10-15 years). If material gap, the box may be larger than what replacement tenants want — re-tenanting risk includes division costs (build-out for multiple smaller tenants) and rent compression (smaller boxes typically pay lower total $)."

#### P-IV-RET-11: Demographics and population growth foundational

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** executive_summary, red_flag_assessment
- **Severity:** high
- **Source citation:** Handbook §IV, Retail, "Physical and demographic fundamentals" group, bullet 2
- **Principle text:** "Demographics and population growth are foundational"
- **Research actions:**
  - **action_type:** retail_trade_area_demographics
  - **verification_required:** true
  - **target_data:** trade-area population (1-mile, 3-mile, 5-mile typical for retail), household income, household density, 5-10 year population growth trend, age distribution, employment trends in the trade area
  - **summary_prompt_hint:** "Surface trade-area demographics for the retail subject. Standard radii: 1-mile, 3-mile, 5-mile (or 10-15 minute drive times for larger formats like malls). Key metrics: population, household income, household density, 5-10 year growth trend. Declining or stagnant demographics is a structural negative for retail; strong growth is a structural positive. Flag declining population or income trends; recognize strong-demographic markets in summary."

#### P-IV-RET-12: Sponsor quality and giveback history (particularly malls)

- **Cluster:** Retail
- **Trigger:** asset_type = Retail
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical (especially when property_sub_type is mall)
- **Source citation:** Handbook §IV, Retail, "Sponsorship" group, bullet 1
- **Principle text:** "Sponsor quality and historical behavior, including asset givebacks to lenders, are critical (particularly on malls)"
- **Research actions:**
  - **action_type:** sponsor_giveback_history
  - **verification_required:** true
  - **target_data:** sponsor's history of deeds-in-lieu, foreclosures where sponsor was borrower, abandoned malls or retail properties, special servicing actions on sponsor's other deals
  - **summary_prompt_hint:** "Research the sponsor's history with asset givebacks. Has this sponsor walked away from properties (deed-in-lieu, abandoned malls, foreclosure as borrower) previously? Particularly relevant for malls — sponsors with prior mall givebacks have demonstrated willingness to use this strategy. Surface specific giveback events with dates, properties, and circumstances. Cross-reference with kicks_registry and approved_deals if same sponsor appears there."
- **CROSS-REF:** Cross-references P-III-12 (sponsor review — litigation, bankruptcies, foreclosures, press, portfolio correlation). Adds retail/mall-specific concern about giveback behavior as a distinct credit signal.

---

**End of Retail cluster.** 12 atomic principles (P-IV-RET-1 through P-IV-RET-12). Notable patterns: (1) the schema-validating P-IV-RET-5 — Mall debt yield with fortress Class A nested exception, the exact case the schema was designed for; (2) four mall-specific principles (P-IV-RET-3 through P-IV-RET-6) using stricter triggers (asset_type = Retail AND property_sub_type ∈ mall set); (3) two principles with curated watchlist sets (P-IV-RET-7 bankruptcy categories, P-IV-RET-8 limited-depth tenancy) following the P-II-8 / P-IV-OFF-9 pattern; (4) sponsor giveback history (P-IV-RET-12) extending P-III-12's sponsor review with retail-specific behavior.

---

### Cluster: Multifamily

- **section:** asset_type_specific
- **title:** Multifamily
- **assetTypeScope:** Multifamily
- **narrative:** None (flat-bullet section)

All principles in this cluster trigger on `asset_type = Multifamily` unless noted otherwise.

---

#### P-IV-MF-1: Assets 5+ years old should demonstrate ~3 years stable operations

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily AND building_age >= 5
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Operating history and vintage risk" group, bullet 1
- **Principle text:** "Assets five years or older should demonstrate approximately three years of stable operations"
- **Deterministic check (operating history gap):**
  - **metric:** years_of_stable_operating_history
  - **operator:** `<`
  - **threshold:** 3
  - **applies when:** building_age >= 5
  - **flag_message:** "Building is {X} years old but issuer has provided less than 3 years of stable operating history. Per handbook, 5+ year multifamily assets should demonstrate ~3 years of stable operations. Limited history raises concerns about NOI durability."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** mf_operating_history_assessment
  - **verification_required:** true
  - **target_data:** building age, available historical operating periods (T36/T24/T12), NOI and occupancy trends over those periods, identification of any disruption events (renovation, ownership change, repositioning)
  - **summary_prompt_hint:** "Surface the building's age vs available operating history. For 5+ year buildings, the handbook expects ~3 years of stable operations. Assess what 'stable' means in context — consistent NOI, occupancy, and rent trends without major disruptions. If recent ownership change or repositioning means stable history is shorter, surface that explicitly as a concern."

#### P-IV-MF-2: Older vintage with renovation-driven NOI growth — skepticism warranted

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily AND building_age >= 20
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Operating history and vintage risk" group, bullet 2
- **Principle text:** "Older vintage properties are viewed skeptically where NOI growth is renovation-driven; incomplete renovation of units should be flagged as a first-order underwriting concern"
- **Research actions:**
  - **action_type:** mf_renovation_driven_growth_assessment
  - **verification_required:** true
  - **target_data:** building age, recent NOI growth and its components (rent growth on renovated vs un-renovated units), renovation completion status (% of units renovated), planned renovation pipeline, classic-to-renovated rent gap
  - **summary_prompt_hint:** "Assess whether recent NOI growth is renovation-driven (i.e., classic units being upgraded and re-leased at premium rents) vs market-driven. Renovation-driven growth is non-recurring — once all units are renovated, growth stops. Surface: % of units renovated, renovation pipeline status, premium captured per unit, organic market rent growth absent renovation. Incomplete renovations create both capex risk and leasing risk on remaining classic units."
- **NOTE:** "Older vintage" threshold of 20 years is calibration; handbook doesn't quantify. The principle's deterministic trigger could be tightened or loosened. Open to recalibration.

#### P-IV-MF-3: Class C → durable Class B upgrades difficult and often unsustainable

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Operating history and vintage risk" group, bullet 3
- **Principle text:** "Upgrading Class C assets into durable Class B properties is difficult and often unsustainable"
- **Research actions:**
  - **action_type:** mf_class_repositioning_assessment
  - **verification_required:** true
  - **target_data:** current asset class designation, business plan / sponsor narrative about repositioning, neighborhood class (often determines achievable property class), comparable asset class drift over time, rent premium being underwritten vs current market
  - **summary_prompt_hint:** "Identify whether the business plan involves repositioning the asset to a higher class tier. If yes, assess whether this is achievable given neighborhood quality and demographics. Class follows neighborhood — Class C neighborhoods generally produce Class C performance regardless of unit renovation. Surface evidence of similar repositioning attempts in the submarket and their outcomes. Skepticism warranted; explicit class-upgrade business plans should be flagged."

#### P-IV-MF-4: Scrutinize historical and forward-looking capex (roofs, major systems)

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Capital intensity and physical risk" group, bullet 1
- **Principle text:** "Scrutinize historical and forward-looking capex, particularly roofs and major systems"
- **Research actions:**
  - **action_type:** mf_capex_assessment
  - **verification_required:** true
  - **target_data:** historical capex spending (last 3-5 years, broken down by category), property condition report findings on roof, HVAC, plumbing, electrical, parking lots, exterior systems; estimated remaining useful life of major systems; engineering report (PCA) findings; proposed reserve structure
  - **summary_prompt_hint:** "Assess historical and forward-looking capex needs. Surface: (a) historical capex spending vs typical $/unit norms ($300-500/unit/year is a common baseline; higher for older assets), (b) condition of major systems from PCA — roof age and remaining life, HVAC status, plumbing, electrical, parking lots, (c) any flagged capex items in the engineering report. Compare to proposed reserve structure. Flag if reserves appear insufficient against identified capex needs."
- **CROSS-REF:** Relates to P-III-4 (cash on hand reserves) and Section V Step 3 (Reserve and Escrow Adequacy Analysis).

#### P-IV-MF-5: Crime as first-order concern — independent crime search

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** RESEARCH, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Multifamily, "Neighborhood quality and safety" group, bullet 1
- **Principle text:** "Crime is a first-order underwriting concern; do an independent crime search – this is often best done by searching the property name and finding news on the assets and also sometimes local Police Departments have GIS Mapping that can be a good source of data"
- **Research actions:**
  - **action_type:** mf_crime_independent_search
  - **verification_required:** true
  - **target_data:** news search results for "{property name} crime", "{property name} police", "{property address} incidents"; local Police Department GIS crime mapping data for the property and surrounding blocks; crime statistics for the census tract / police precinct; any specific high-profile incidents (shootings, deaths, sexual assaults, etc.) tied to the property
  - **summary_prompt_hint:** "Conduct independent crime research on the subject property. Search news sources for the property name + crime/police/incident keywords. Check local Police Department GIS mapping if available (many police departments publish incident data online, especially in larger cities). Surface: any specific incidents at the property, crime trends in the immediate area (1-3 block radius), comparison to broader submarket. Crime issues are first-order concerns — do not rely on issuer-provided safety narrative. Analyst must verify."
- **NOTE:** This principle's research is genuinely operational — handbook gives specific methodology (news search + police GIS). Engine should automate where possible (news search) and surface what's available; analyst must verify.

#### P-IV-MF-6: Tenant reviews mandate (1-2 star focus on crime, deferred maintenance, pests)

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** RESEARCH, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high (handbook uses "ALWAYS" — mandatory)
- **Source citation:** Handbook §IV, Multifamily — combines "Neighborhood quality and safety" group bullet 2 + closing bullet "Tenant reviews from third party websites provide great insight, ALWAYS review these and summarize what you see in the 1 and 2 star reviews."
- **Principle text:** "Focus on substantive resident issues such as crime, deferred maintenance, and pests by reading third party websites for tenant reviews. Tenant reviews from third party websites provide great insight, ALWAYS review these and summarize what you see in the 1 and 2 star reviews."
- **Research actions:**
  - **action_type:** tenant_reviews_third_party
  - **verification_required:** true (analyst MUST verify the AI summary independently)
  - **target_data:** 1-star and 2-star reviews from ApartmentRatings.com, Google Maps, Yelp, Apartments.com, Facebook reviews, and similar third-party review sites for the specific property; focus on patterns indicating crime, deferred maintenance, and pest issues
  - **summary_prompt_hint:** "Search third-party review sites for the subject multifamily property. Focus on 1-star and 2-star reviews. Per handbook, prioritize patterns indicating: (a) crime — break-ins, assaults, drug activity, unsafe environment; (b) deferred maintenance — broken appliances, water leaks, mold, HVAC failures, general decay; (c) pests — roaches, bedbugs, rodents, infestations. These three categories are first-order concerns. Surface themes and quantify how frequently they appear. Cross-reference with the crime search from P-IV-MF-5. Analyst MUST independently verify before relying on this summary."
- **NOTE:** Combines two handbook bullets — the substantive-issues bullet (under "Neighborhood quality and safety" group) and the closing "ALWAYS review tenant reviews" mandate. These are essentially the same principle stated with different emphases; handbook redundantly mentioned tenant reviews twice. Combined here to avoid duplication. This is the third instance of the tenant-reviews mandate (after P-IV-MHC-8; before Hotel's TripAdvisor version). Multifamily version adds the explicit focus areas (crime, deferred maintenance, pests).

#### P-IV-MF-7: Avoid highly syndicated equity structures

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Sponsor and capital structure" group, bullet 1
- **Principle text:** "Avoid highly syndicated equity structures"
- **Research actions:**
  - **action_type:** mf_equity_structure_assessment
  - **verification_required:** true
  - **target_data:** equity stack details — sponsor commitment, LP structure, number of investors, retail syndication indicators (use of crowdfunding platforms like CrowdStreet, RealtyMogul, Yieldstreet; many small LPs), GP/LP capital call provisions and history, sponsor's prior syndication track record
  - **summary_prompt_hint:** "Assess the equity capital structure. Highly syndicated structures (many small LPs, often raised through retail platforms like CrowdStreet, RealtyMogul, etc.) carry elevated risk: weak governance, limited capacity for capital calls under stress, sponsor often has minimal skin in the game. Surface: number of LPs, sponsor's $ commitment as % of total equity, whether retail syndication was used, capital call history if applicable. Flag highly syndicated structures explicitly per handbook."

#### P-IV-MF-8: Evaluate sponsor portfolio concentration and correlated exposure

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Sponsor and capital structure" group, bullet 2
- **Principle text:** "Evaluate sponsor portfolio concentration and correlated exposure"
- **Research actions:**
  - **action_type:** mf_sponsor_portfolio_concentration
  - **verification_required:** true
  - **target_data:** sponsor's broader portfolio (other multifamily deals, geographic distribution, asset types), public filings if any, news coverage of sponsor's portfolio, similar properties under same sponsorship in same MSA/submarket, financing structure across portfolio (floating-rate concentration, bridge vs permanent)
  - **summary_prompt_hint:** "Assess the sponsor's broader portfolio for correlated exposure. Surface: (a) geographic concentration — how many properties in the same MSA or submarket?, (b) strategic concentration — same business plan repeated (e.g., all value-add renovations)?, (c) financial structure concentration — all floating-rate? all bridge loans?, (d) recent news of distress at other portfolio properties. Correlated exposure means stress at one property predicts stress across the portfolio."
- **CROSS-REF:** Relates to P-III-12 (sponsor review) and P-III-13 (Eightfold portfolio exposure study). This principle is about THE SPONSOR'S OWN concentration, distinct from Eightfold's exposure to the sponsor.

#### P-IV-MF-9: Analyze concessions, bad debt, collections where operating history limited

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily AND (building_age < 5 OR years_of_stable_operating_history < 2)
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Newer assets and lease-up risk" group, bullet 1
- **Principle text:** "Analyze concessions, bad debt, and collections where operating history is limited"
- **Research actions:**
  - **action_type:** mf_lease_up_revenue_quality
  - **verification_required:** true
  - **target_data:** concession structure on recent leases (free months, reduced first-year rent), concession trend (rising/falling), bad debt as % of gross potential revenue, collections rate (actual cash received vs billed), aged receivables, comparison of net effective rent vs face rent
  - **summary_prompt_hint:** "For lease-up or newly-stabilized properties, scrutinize the quality of reported revenue. Surface: (a) concessions — how many free months, what % of total rent is being given away?, (b) bad debt — what % of gross revenue is being written off?, (c) collections — what % of billed revenue actually came in as cash?, (d) net effective rent vs face rent gap. Reported occupancy and rent can mask underlying revenue quality issues. If revenue quality is weak, the property's true stabilized economics may be materially different from underwriting."

#### P-IV-MF-10: Verify rents supportable via competing assets and their concessions

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Newer assets and lease-up risk" group, bullet 2
- **Principle text:** "Verify rents supportable by checking competing assets and knowing their concession offerings"
- **Research actions:**
  - **action_type:** mf_rent_comp_verification
  - **verification_required:** true
  - **target_data:** comparable property face rents (from comp survey or property listings), CONCESSIONS at comparable properties (free months, reduced first-year rents), effective rents net of concessions at comps, subject's underwritten rent vs effective comp rent
  - **summary_prompt_hint:** "Verify that the subject's underwritten rents are defensible against the competitive set. Critical to capture concessions at comp properties, not just face rents. Surface: comparable property face rents, their current concession offerings (free months, etc.), resulting effective rents net of concessions. Compare to subject's underwritten rent. If subject is being underwritten at face rent level while comps are offering material concessions, the rents are not realistic — flag explicitly."

#### P-IV-MF-11: Verify expense comparability — property tax reassessments

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Newer assets and lease-up risk" group, bullet 3
- **Principle text:** "Verify expense comparability, including property tax reassessments"
- **Research actions:**
  - **action_type:** mf_expense_verification
  - **verification_required:** true
  - **target_data:** subject expense ratios vs comparable properties (per-unit and per-SF basis for taxes, insurance, repairs/maintenance, payroll, marketing, management fees), state and county property tax reassessment rules and triggers (e.g., sale, refinance, improvement above threshold), projected post-closing taxes vs underwritten taxes, insurance market conditions in the geography (Florida, coastal states, wildfire zones have particular pressure)
  - **summary_prompt_hint:** "Verify the underwritten operating expenses against comparable benchmarks. Critical attention to: (a) property taxes — many jurisdictions reassess upon sale or refi; if the deal involves a transaction, taxes likely step up. Compare underwritten taxes to the projected post-transaction assessed value × millage. (b) insurance — in coastal/wildfire/high-loss markets, insurance has spiked materially in 2022-2024; ensure expense includes current market pricing. (c) other expense lines — flag any line that's materially below comp benchmarks as a potential underwriting understatement."

#### P-IV-MF-12: Confirm certificates of occupancy

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily AND (building_age < 5 OR has_recent_substantial_renovation = TRUE)
- **Execution modes:** RESEARCH
- **Injection points:** red_flag_assessment
- **Severity:** critical
- **Source citation:** Handbook §IV, Multifamily, "Newer assets and lease-up risk" group, bullet 4
- **Principle text:** "Confirm certificates of occupancy"
- **Research actions:**
  - **action_type:** mf_certificate_of_occupancy_verification
  - **verification_required:** true (must verify with municipal records)
  - **target_data:** number of units with C of O, number of units without C of O, status of any pending C of O issuance, the municipal building department records for the subject property
  - **summary_prompt_hint:** "Verify certificates of occupancy for all units. Especially critical for new construction and recently-renovated assets. Surface: (a) total unit count vs units with valid C of O, (b) any pending C of O applications or issues, (c) any units that cannot be legally occupied. Units without C of O cannot be leased; underwriting that includes those units is over-stated. Flag any C of O gap as a critical issue."
- **NOTE:** Trigger condition could narrow this further (only new construction within first 2-3 years). Used `building_age < 5 OR recent renovation` as a broad capture. May be tightened later.

#### P-IV-MF-13: Always assess new supply

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high (handbook uses "Always" — mandatory)
- **Source citation:** Handbook §IV, Multifamily, "Regulatory and supply risk" group, bullet 1
- **Principle text:** "Always assess new supply"
- **Research actions:**
  - **action_type:** mf_new_supply_assessment
  - **verification_required:** true
  - **target_data:** units under construction in the submarket (typically 3-5 mile radius for urban, 10-mile for suburban), units in planning/permitting pipeline, expected delivery dates, comparison to current submarket inventory (new supply as % of existing), historical absorption rate
  - **summary_prompt_hint:** "Assess new multifamily supply in the submarket. Surface: (a) units under construction (with expected delivery dates), (b) units in planning/permitting that may add to supply over the loan term, (c) ratio of new supply to existing submarket inventory (10%+ is materially elevated), (d) historical submarket absorption rate vs incoming supply. Heavy supply in delivery window compresses rent growth and pressures occupancy. Flag any submarket with material upcoming supply."

#### P-IV-MF-14: Evaluate exposure to rent control, stabilization, vouchers, and subsidies

- **Cluster:** Multifamily
- **Trigger:** asset_type = Multifamily
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Multifamily, "Regulatory and supply risk" group, bullet 2
- **Principle text:** "Evaluate exposure to rent control, stabilization, vouchers, and other subsidies"
- **Research actions:**
  - **action_type:** mf_regulatory_exposure_assessment
  - **verification_required:** true
  - **target_data:** state and municipal rent control / stabilization rules applicable to the subject property, percentage of units in rent control or stabilization, percentage of units accepting Section 8 vouchers, percentage of units subject to LIHTC or other affordability programs, expiration dates of any affordability restrictions, any pending legislation that could expand rent control
  - **summary_prompt_hint:** "Assess regulatory exposure. Surface: (a) rent control / stabilization — what % of units are restricted, what are the rules (CPI cap, fixed cap, none) and how do they affect future rent growth?, (b) Section 8 vouchers — what % of units accept vouchers, what are the source-of-income discrimination laws in this market?, (c) LIHTC or other subsidies — are there long-term affordability restrictions, when do they expire?, (d) pending legislation — any current efforts to expand rent control in this state/municipality? Each form of regulation constrains cash flow, operational flexibility, and exit liquidity differently."

#### (Handbook bullet absorbed: "Student housing is NOT down-the-fairway multifamily")

Captured upstream by P-II-8 (Specialized assets are higher risk). Student Housing is already in P-II-8's deterministic specialty sub-type list. Per the agreed pattern (same approach used for cold-storage in Industrial), no new multifamily-specific content; skipped to avoid pure duplication.

---

**End of Multifamily cluster.** 14 atomic principles (P-IV-MF-1 through P-IV-MF-14), with P-IV-MF-6 combining two handbook bullets (substantive-issues + ALWAYS-tenant-reviews mandate) and the student housing bullet absorbed by P-II-8. Notable patterns: (1) third instance of the tenant-reviews mandate in P-IV-MF-6 (after P-IV-MHC-8; before Hotel's TripAdvisor version), with multifamily adding explicit focus areas (crime, deferred maintenance, pests); (2) crime search principle (P-IV-MF-5) kept separate from tenant reviews because the data sources differ (police GIS / news vs review sites); (3) four lease-up verification principles (P-IV-MF-9 through P-IV-MF-12) kept separate because each has distinct data sources and verification methods.

---

### Cluster: Hotel

- **section:** asset_type_specific
- **title:** Hotel
- **assetTypeScope:** Hotel
- **narrative:** None (flat-bullet section)

All principles in this cluster trigger on `asset_type = Hotel` unless noted otherwise.

---

#### P-IV-HOT-1: New supply as primary risk — evaluate in detail

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical (handbook calls it "primary risk")
- **Source citation:** Handbook §IV, Hotel, "Supply and demand dynamics" group, bullet 1
- **Principle text:** "New supply is a primary risk and must be evaluated in detail"
- **Research actions:**
  - **action_type:** hotel_new_supply_assessment
  - **verification_required:** true
  - **target_data:** hotels under construction in the competitive set / submarket, hotels in planning/permitting pipeline, expected delivery dates, brand identity of incoming supply (relevant for competitive positioning), room counts of new supply, comparison to existing market room inventory, expected RevPAR impact from new supply
  - **summary_prompt_hint:** "Assess new hotel supply in the competitive market. Hotel is supply-sensitive — even modest new supply (5-10% of inventory) can materially impact RevPAR across the existing competitive set. Surface: (a) properties under construction with expected open dates, (b) properties in planning/permitting pipeline, (c) brand and segment match to subject (does the new supply compete directly, or is it different segment?), (d) impact analysis from STR or other industry sources if available. New supply is the primary credit risk per handbook."

#### P-IV-HOT-2: Guest reviews mandate (1-2 star focus, TripAdvisor primary)

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** RESEARCH, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high (handbook uses "always" / "ALWAYS" — mandatory, twice)
- **Source citation:** Handbook §IV, Hotel — combines "Supply and demand dynamics" group bullet 2 + closing bullet
- **Principle text:** "Read reviews from TripAdvisor always. Guest reviews from third party websites provide great insight, ALWAYS review these and summarize what you see in the 1 and 2 star reviews."
- **Research actions:**
  - **action_type:** guest_reviews_third_party
  - **verification_required:** true (analyst MUST verify the AI summary independently)
  - **target_data:** 1-star and 2-star reviews from TripAdvisor (primary), Google Maps, Booking.com, Hotels.com, Expedia, and similar third-party review sites for the specific hotel; focus on patterns indicating service failures, cleanliness issues, deferred maintenance, safety concerns, brand-standard compliance issues
  - **summary_prompt_hint:** "Search third-party review sites for the subject hotel, with TripAdvisor as the primary source per handbook. Focus on 1-star and 2-star reviews. Surface patterns indicating: (a) service failures (staff issues, front desk problems, broken service standards), (b) cleanliness (rooms, common areas, food service), (c) deferred maintenance (broken HVAC, plumbing, elevators, dated rooms), (d) safety concerns (crime, security issues), (e) brand-standard compliance gaps (relevant for franchise relationship risk under P-IV-HOT-3). Summarize themes; flag any pattern that suggests operational decline or franchise risk. Analyst MUST independently verify."
- **NOTE:** Fourth instance of the tenant/guest reviews mandate pattern (after P-IV-MHC-8 and P-IV-MF-6). Hotel emphasizes TripAdvisor specifically — the canonical hospitality review source. Combines two handbook bullets (early supply/demand section + closing mandate) per the precedent established in P-IV-MF-6.

#### P-IV-HOT-3: Franchise / flag expiration dates — required diligence

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Hotel, "Capital intensity and franchise risk" group, bullet 1
- **Principle text:** "Franchise or flag expiration dates are required diligence items"
- **Deterministic check (franchise expiration within or near loan term):**
  - **metric:** years_until_franchise_expiration_from_loan_maturity (negative = franchise expires before loan; positive = after)
  - **operator:** `<`
  - **threshold:** 3
  - **flag_message:** "Franchise/flag agreement expires within 3 years of loan maturity (or before). Per handbook, franchise expiration is required diligence. Surface renewal commitment status, expected PIP at renewal, and brand alternatives if franchise is not renewed."
  - **flag_severity:** critical
- **Research actions:**
  - **action_type:** hotel_franchise_diligence
  - **verification_required:** true
  - **target_data:** current franchise/flag (brand identity), franchise agreement expiration date, renewal terms negotiated or pending, history of brand relationship (any compliance issues, prior PIPs), expected PIP scope at renewal, sponsor's brand relationships and ability to attract alternative flag if non-renewal occurs
  - **summary_prompt_hint:** "Diligence the franchise/flag agreement. Surface: (a) current brand and franchise expiration date relative to loan maturity, (b) renewal status — is renewal committed? if not, when does negotiation begin?, (c) expected PIP at renewal — capital cost and scope, (d) brand compliance history — any current QA issues or franchise-relationship friction?, (e) brand alternatives — if this flag is lost, can the property attract a comparable replacement? Loss of flag typically destroys 20-40% of value; this is a critical diligence item."

#### P-IV-HOT-4: 7-year renovation cycle — calculate time since last renovation

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Capital intensity and franchise risk" group, bullet 2
- **Principle text:** "Most brands require renovations on roughly seven-year cycles; always calculate time since last renovation"
- **Deterministic check (years since last renovation):**
  - **metric:** years_since_last_renovation
  - **operator:** `>=`
  - **threshold:** 7
  - **flag_message:** "Hotel is {X} years past last major renovation, at or beyond the typical 7-year brand-mandated cycle. Per handbook, a PIP is likely required. Surface expected PIP scope and cost (see P-IV-HOT-5 for per-key benchmarks), and verify it's accounted for in reserves."
  - **flag_severity:** high
- **Advisory check (approaching renovation cycle):**
  - **metric:** years_since_last_renovation
  - **operator:** `>=`
  - **threshold:** 5
  - **AND `< 7`**
  - **flag_message:** "Hotel is {X} years past last renovation, approaching the 7-year brand-mandated cycle. PIP exposure becoming material over loan term."
  - **flag_severity:** medium
- **Research actions:**
  - **action_type:** hotel_renovation_cycle_assessment
  - **verification_required:** true
  - **target_data:** date and scope of last major renovation, brand's typical renovation cycle (most major brands require ~7 years, some shorter), any communications from brand regarding upcoming PIP requirements, planned renovation timeline if any
  - **summary_prompt_hint:** "Identify the date and scope of the last major renovation. Calculate time since last renovation. Most major brands require renovations on 7-year cycles; some (luxury, higher-tier) on shorter cycles. Surface: (a) date of last renovation, (b) scope (rooms only, public spaces, full property), (c) any brand communications about upcoming PIP requirements, (d) planned renovation timing. Property approaching or past 7-year cycle has imminent PIP exposure."

#### P-IV-HOT-5: PIP per-key cost benchmarks ($15K-$50K range)

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Capital intensity and franchise risk" group, bullet 3
- **Principle text:** "Typical PIPs range from ~$15k/key (low end) to ~$40–50k/key for full-service hotels"
- **Deterministic check 1 (PIP reserve per-key for limited/select-service):**
  - **metric:** pip_reserve_per_key
  - **operator:** `<`
  - **threshold:** 15000
  - **applies when:** hotel_service_level ∈ {"Limited-Service", "Select-Service"}
  - **flag_message:** "PIP reserve is ${X}/key, below the ~$15K/key handbook low-end benchmark for limited/select-service hotels. Reserve appears insufficient for typical PIP scope."
  - **flag_severity:** high
- **Deterministic check 2 (PIP reserve per-key for full-service):**
  - **metric:** pip_reserve_per_key
  - **operator:** `<`
  - **threshold:** 40000
  - **applies when:** hotel_service_level ∈ {"Full-Service", "Luxury", "Upper-Upscale"}
  - **flag_message:** "PIP reserve is ${X}/key, below the ~$40-50K/key handbook range for full-service hotels. Reserve appears insufficient — full-service PIPs typically include guest rooms, public spaces, F&B, technology, brand elements."
  - **flag_severity:** high
- **Research actions:**
  - **action_type:** hotel_pip_reserve_adequacy
  - **verification_required:** true
  - **target_data:** hotel service level (limited / select / full / luxury), PIP reserve structure (cash on hand, springing), expected PIP scope from brand and timing, comparison of reserve $/key to handbook benchmarks
  - **summary_prompt_hint:** "Assess PIP reserve adequacy against handbook benchmarks. Surface: (a) hotel service level (limited/select/full/luxury) and corresponding benchmark range ($15K low end to $40-50K full service), (b) reserve $/key, (c) expected PIP scope and timing (from P-IV-HOT-4 renovation cycle analysis and any brand communications), (d) gap between reserve and expected PIP cost. Reserve materially below handbook range suggests sponsor must fund PIP from operations or capital injection — flag accordingly."
- **CROSS-REF:** Pairs with P-IV-HOT-4 (renovation cycle timing). Together they assess WHEN the PIP hits and WHETHER reserves are sized for it.

#### P-IV-HOT-6: Older hotels — maintenance difficulty and franchise-exit risk

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel AND building_age >= 25
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Asset age and format risk" group, bullet 1
- **Principle text:** "Older hotels are more difficult to maintain and are at risk of being pushed out of franchise systems (think first gen Hampton Inns from the 1990's)"
- **Research actions:**
  - **action_type:** hotel_aging_franchise_exit_risk
  - **verification_required:** true
  - **target_data:** building age, brand vintage (when the property opened under current brand), brand's known position on legacy product (e.g., Hampton Inn pruning older first-gen properties), property condition vs current brand prototype, recent PIPs and their thoroughness
  - **summary_prompt_hint:** "Assess franchise-exit risk for older hotels. Surface: (a) building age and time under current brand, (b) brand's known stance on legacy product — some brands actively prune older properties from their system (e.g., Hilton's treatment of first-generation Hampton Inns), (c) property condition vs current brand prototype standards, (d) recent PIPs and whether they were sufficient to meet current brand requirements, (e) brand-relationship signals (any communications suggesting non-renewal). Older hotels carrying brand-mismatched product face elevated franchise risk."
- **NOTE:** "Older" threshold of 25 years is calibration. Handbook's specific example (first-gen Hampton Inns from the 1990s) suggests ~30-35 year age range. Open to recalibration.

#### P-IV-HOT-7: Older full-service CBD hotels — post-COVID business travel decline

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel AND building_age >= 20 AND hotel_service_level ∈ {"Full-Service", "Upper-Upscale", "Luxury"} AND location_type = "CBD"
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** critical
- **Source citation:** Handbook §IV, Hotel, "Asset age and format risk" group, bullet 2
- **Principle text:** "Older full-service CBD hotels are particularly challenging in light of reduced business travel post COVID"
- **Deterministic check (triple-condition triggering):**
  - **metric:** combined (building_age >= 20 AND service_level is full-service AND location is CBD)
  - **operator:** match
  - **flag_message:** "Property matches the handbook-flagged combination: older ({X} years) full-service CBD hotel. Per handbook, this combination is particularly challenged by reduced post-COVID business travel. Surface business mix, demand recovery vs 2019 baseline, and structural outlook."
  - **flag_severity:** critical
- **Research actions:**
  - **action_type:** hotel_cbd_business_recovery_assessment
  - **verification_required:** true
  - **target_data:** RevPAR recovery vs 2019 baseline, business vs leisure mix in demand, group/corporate vs transient mix, days-of-week occupancy patterns (Tuesday-Wednesday-Thursday weakness is signature post-COVID), submarket RevPAR recovery
  - **summary_prompt_hint:** "Assess post-COVID demand recovery for older full-service CBD hotels. Surface: (a) RevPAR vs 2019 (any post-COVID gap?), (b) business/group vs leisure demand mix and how it has shifted, (c) day-of-week patterns (sustained Tuesday-Thursday weakness indicates business-travel impairment), (d) the submarket's broader RevPAR recovery trajectory. Older full-service CBD hotels are at the structural intersection of three challenges — flag explicitly and surface mitigants if any (e.g., conversion to alternative use, repositioning toward leisure, etc.)."

#### P-IV-HOT-8: Analyze seasonality and demand mix (T12 monthly)

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Cash flow volatility" group, bullet 1
- **Principle text:** "Analyze seasonality and demand mix; trailing 12 month monthly cash flows help with this understanding"
- **Research actions:**
  - **action_type:** hotel_seasonality_demand_mix_analysis
  - **verification_required:** true
  - **target_data:** trailing 12 month MONTHLY revenue/RevPAR/NOI (not just annual), demand mix breakdown (business / group / corporate / leisure / transient), seasonality patterns (peak vs trough month spread), days-of-week patterns
  - **summary_prompt_hint:** "Analyze seasonality and demand mix using T12 monthly data. Surface: (a) revenue/NOI monthly distribution — peak month vs trough month, is the property highly seasonal?, (b) demand mix — business / group / corporate / leisure / transient breakdown, (c) days-of-week occupancy patterns, (d) any unusual months (one-time events, disruptions). Highly seasonal properties carry elevated stress risk during off-peak; deals dependent on group business carry concentration risk if convention pace softens. Annual averages mask these dynamics — T12 monthly is the right lens."

#### P-IV-HOT-9: Group and contract business concentration

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** LLM_CONTEXT, RESEARCH
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Cash flow volatility" group, bullet 2
- **Principle text:** "Evaluate group and contract business concentration"
- **Research actions:**
  - **action_type:** hotel_group_contract_concentration
  - **verification_required:** true
  - **target_data:** breakdown of revenue by segment (group, contract, transient, leisure), top 10 group accounts and their % of revenue, contract business identification (airline crew, government per-diem, hospital, university, etc.), contract terms and expiration dates, any recent contract losses or wins, dependency on adjacent convention center or major demand generator
  - **summary_prompt_hint:** "Assess group and contract business concentration. Surface: (a) revenue split by segment (group, contract, transient, leisure), (b) top group accounts and concentration — if top 5 group accounts represent >30% of group revenue, that's meaningful concentration, (c) contract business identification and terms (airline crew contracts, government per-diem, hospital, university) — these are often multi-year but renewable, (d) dependence on a single demand generator (convention center, university campus, military base). High concentration in group/contract creates discrete revenue cliffs if those relationships end."

#### P-IV-HOT-10: Assess leverage via debt yield AND multiples of room revenue

- **Cluster:** Hotel
- **Trigger:** asset_type = Hotel
- **Execution modes:** DETERMINISTIC, LLM_CONTEXT
- **Injection points:** red_flag_assessment, committee_recommendation
- **Severity:** high
- **Source citation:** Handbook §IV, Hotel, "Leverage assessment" group, bullet 1
- **Principle text:** "Assess leverage using both debt yield and multiples of room revenue"
- **Deterministic check (loan-to-room-revenue multiple):**
  - **metric:** loan_amount / annual_room_revenue
  - **operator:** `>`
  - **threshold:** 5.0
  - **flag_message:** "Loan-to-annual-room-revenue multiple is {X}x, above the ~5x industry benchmark. Hotel leverage looks aggressive relative to the most stable revenue stream. Per handbook, leverage must be assessed by BOTH debt yield AND room revenue multiple."
  - **flag_severity:** high
- **Advisory check (approaching upper bound):**
  - **metric:** loan_amount / annual_room_revenue
  - **operator:** `>=`
  - **threshold:** 4.0
  - **AND `<= 5.0`**
  - **flag_message:** "Loan-to-annual-room-revenue multiple is {X}x, at the upper end of typical hotel leverage. Cushion against RevPAR decline is thin."
  - **flag_severity:** medium
- **NOTE on threshold calibration:** Handbook says "assess leverage using both debt yield and multiples of room revenue" but doesn't quantify the multiple. The 5x ceiling and 4-5x advisory band are industry calibration choices. The handbook is mainly emphasizing the METHODOLOGY (use both metrics), not specific thresholds. Open to recalibration.

---

**End of Hotel cluster.** 10 atomic principles (P-IV-HOT-1 through P-IV-HOT-10), with P-IV-HOT-2 combining two handbook bullets (TripAdvisor early bullet + ALWAYS closing mandate) per the precedent established in P-IV-MF-6. Notable patterns: (1) fourth instance of the guest/tenant reviews mandate in P-IV-HOT-2, with hotel emphasizing TripAdvisor as primary source; (2) three explicit numerical thresholds from handbook (7-year renovation cycle, $15K/key low-end PIP, $40-50K/key full-service PIP), all captured as deterministic checks; (3) triple-condition deterministic trigger in P-IV-HOT-7 (older + full-service + CBD); (4) bi-modal PIP threshold in P-IV-HOT-5 that varies by hotel_service_level — schema accommodates conditional thresholds within a single principle.

---

## END OF SECTION IV ATOMIZATION

All 8 asset-type clusters complete. Total Section IV principles: 4 (Single-Tenant) + 5 (Industrial) + 4 (Self-Storage) + 8 (MHC) + 9 (Office) + 12 (Retail) + 14 (Multifamily) + 10 (Hotel) = **66 principles**.

Combined with Section II (8), Section III (13), and Section V (7 review steps): **87 atomic principles + 1 cluster narrative + 7 review steps captured across the full Eightfold CRE Credit Handbook.**

Remaining work for future sessions:
- Cross-reference cleanup pass (queued CROSS-REF notes throughout the document need to be wired into the schema's `relatedPrincipleIds` and `relatedReviewStepIds` fields)
- JSON conversion conforming to the Handbook contract
- Handbook contract type definition in @cre/contracts
- handbook_registry table + admin UI
- Engine implementation paths for the deterministic checks
