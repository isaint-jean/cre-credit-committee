# Handbook Atomization — Working Planning Doc

Status: IN PROGRESS. Not yet a final artifact.

This document captures atomization decisions for converting the CRE Credit Handbook
(CRE_Credit.docx) into structured Principle + ReviewStep records per the schema
designed during the session.

Session 1 (this commit): Schema design + Sections II, III, V fully atomized + Section IV
Single-Tenant Risk cluster atomized.

Remaining work for future sessions:
- Section IV remaining clusters: Office, Retail (with Mall sub-section), Multifamily,
  Hotel, Industrial, Self-Storage, MHC (~7 clusters, ~50+ principles)
- Cross-reference cleanup pass (8+ links queued in CROSS-REF notes)
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
