/**
 * ExtractionResult — Stage-1 producer output.
 *
 * Pure mirror of source documents. NOT interpretation. NOT cleaning. NOT normalization.
 * The structured surface that downstream stages (Stage 4 judgment engine in particular) read
 * before any underwriting transform is applied.
 *
 * Architecture rule (§2): "AI is allowed as an extractor only. AI may NOT define underwriting
 * assumptions, override adjustments, or influence final metrics." This contract enforces that
 * boundary by giving extraction a strictly-typed surface; downstream consumers read these
 * fields and apply the underwriting transforms separately.
 *
 * Architecture rule (§8): "Missing inputs remain `null` through extraction." Every numeric
 * field is `number | null`; the extractor never substitutes 0 for missing data.
 */

import type {
  ContentHash,
  ExtractionResultId,
} from './identity.js';
import type {
  ExtractionEngineVersion,
  ISODateTime,
} from './versioning.js';
import type { SourceTier } from './source-tier.js';

/* ------------------------- source-document provenance ----------------------- */

export const SOURCE_DOCUMENT_KINDS = [
  'rent_roll',
  /**
   * Generic CF / operating-statement document kind. Retained for back-compat;
   * new emissions prefer one of the three column-specific kinds below
   * ('t12_actual', 'in_place', 'seller_uw') so source-document refs are
   * traceable to the SPECIFIC column inside the workbook that produced data.
   */
  't12',
  /**
   * Strict T-12 / trailing-twelve column from the seller CF (the column whose
   * header reads "T-12", "Trailing Twelve", etc.). Distinct from 'in_place'
   * (current-rent column) and 'seller_uw' (issuer-underwriting column).
   * Added 2026-05-31 with the period-classification fix.
   */
  't12_actual',
  /**
   * In-Place / current column from the seller CF. Historically emitted under
   * the misleading kind 't12' due to a regex collision in the extractor that
   * the 2026-05-31 split fixed. New emissions use this kind.
   */
  'in_place',
  'pca',
  'appraisal',
  'asr',
  'seller_uw',
  'loan_terms',
  'property_metadata',
] as const;
export type SourceDocumentKind = (typeof SOURCE_DOCUMENT_KINDS)[number];

/**
 * Provenance ref to a source document. The `contentHash` is the hash of the document file's
 * bytes (not of the extraction output) — lets us detect drift if the same logical document
 * is re-uploaded with edits.
 */
export interface SourceDocumentRef {
  readonly kind: SourceDocumentKind;
  readonly contentHash: ContentHash;
}

/* --------------------------------- rent roll -------------------------------- */

/**
 * Line-level discriminated union for the EXTRACTION-side rent-roll type
 * (mirrors the persisted RentRoll.lines discipline at
 * `packages/contracts/src/rent-roll.ts`). `kind: 'tenant'` carries the
 * office/retail/industrial shape; `kind: 'unit'` carries the
 * multifamily/MHC/student-housing shape. Consumers reading variant-
 * specific fields MUST narrow on `kind` — tsc --strict enforces this.
 *
 * Naming note: this type is still called `RentRollUnit` for historical
 * back-compat (it's the export the doctrine-clean adapter reads), but
 * the meaning is now "one rent-roll line" — tenant or unit per discriminant.
 */

/** Office / retail / industrial extraction-side line. */
export interface TenantUnit {
  readonly kind: 'tenant';
  readonly unitId: string;                       // suite or unit identifier (kept generic; legacy adapter synthesizes "unit-N" when source is null)
  readonly tenantName: string | null;            // null for vacant
  readonly leaseStart: ISODateTime | null;
  readonly leaseEnd: ISODateTime | null;
  readonly baseRentMonthly: number | null;
  readonly inPlaceRentMonthly: number | null;
  readonly occupied: boolean;
  readonly concessions: number | null;           // dollars/month equivalent
  readonly securityDeposit: number | null;
}

/** Multifamily / MHC / student-housing extraction-side line. */
export interface ResidentialUnit {
  readonly kind: 'unit';
  readonly unitId: string;
  /**
   * Categorization: residential dwelling unit (true) vs ancillary rent-roll
   * line (false: parking, storage, employee unit, leasing office, amenity).
   * Filter convention `=== false`-to-exclude — untyped legacy data defaults
   * to INCLUDED. See `packages/contracts/src/rent-roll.ts` UnitRentRollLine
   * for the full rationale.
   */
  readonly isResidential: boolean;
  readonly bedrooms: number | null;
  readonly bathrooms: number | null;
  readonly unitType: string | null;              // "1BR/1BA", "Studio", "Townhome", etc.
  readonly leaseStart: ISODateTime | null;
  readonly leaseEndOrMTM: ISODateTime | null;    // null === month-to-month (NOT missing data)
  readonly baseRentMonthly: number | null;
  readonly inPlaceRentMonthly: number | null;
  readonly occupied: boolean;
  readonly concessionsMonthly: number | null;    // dollars/month
  readonly securityDeposit: number | null;
}

export type RentRollUnit = TenantUnit | ResidentialUnit;

export interface RentRollExtraction {
  readonly units: readonly RentRollUnit[];
  readonly summary: {
    readonly totalUnits: number;
    readonly occupiedUnits: number;
    readonly economicOccupancy: number | null;   // 0..1; null if not derivable
  };
}

/* ----------------------------- operating statement -------------------------- */

export interface OperatingStatementExtraction {
  readonly period: string;                        // free-form label (e.g., "T-12 ending Apr 2026")
  readonly income: {
    readonly grossPotentialRent: number | null;
    readonly effectiveRent: number | null;
    readonly otherIncome: number | null;
    readonly totalIncome: number | null;
    /**
     * CMBS-style "Total UW Adjustments" bucket — the section that sits above
     * vacancy on the issuer's underwritten cash flow build-up. Populated for
     * deals whose seller-UW carries forward-looking income adjustments that
     * the issuer adds to the rent build above vacancy: e.g. present-value
     * rent steps for investment-grade tenants, contractual escalations, or
     * other documented one-time additions. Null when the seller UW does not
     * carry such a line, or when the deal's UW model does not use the
     * adjustment-bucket pattern (T-12 actuals never carry this; in-place
     * rarely does; seller-UW often does on CMBS-style sheets). Optional —
     * additive contract widening; existing consumers ignore.
     */
    readonly uwAdjustments?: number | null;
  };
  readonly expenses: {
    readonly taxes: number | null;
    readonly insurance: number | null;
    readonly utilities: number | null;
    readonly repairsMaintenance: number | null;
    readonly managementFees: number | null;
    readonly generalAndAdmin: number | null;
    readonly janitorial: number | null;
    readonly reimbursements: number | null;
    readonly totalOperatingExpenses: number | null;
  };
  readonly noi: number | null;
  readonly vacancyLoss: number | null;
  /**
   * Line items reported below the NOI line in the source cash flow statement.
   * These are NCF adjustments, not operating expenses; per handbook P-III-3
   * they must be deducted from NOI to arrive at realistic NCF.
   */
  readonly belowNoiAdjustments: {
    readonly replacementReserves: number | null;
    readonly tenantImprovements: number | null;
    readonly leasingCommissions: number | null;
  };
}

/* ------------------------------------ PCA ----------------------------------- */

/**
 * PCA (Property Condition Assessment) extraction. Source: ASTM E2018-style
 * Property Condition Report PDF, prepared by an engineering firm for the lender.
 *
 * Phase 1+2 widening (#TBD, scoped against the Sunroad PCA fixture committed at
 * 431102d, design captured in v8 §14.1 of docs/specs/uw-template-populator/SPEC.md):
 * the shape carries Table 1 totals (immediate + short-term repair dollars),
 * Table 2 metadata (evaluation period, inflation rate, per-SF-per-year reserves),
 * Table 2 per-year capex schedules (inflated + uninflated), and the structural
 * narratives. Decisions 2 (no annual reserves field — derive downstream), 4 (no
 * structural-narrative widening), and 6 (no utility infrastructure field) are
 * reasons the contract is NOT widened in directions one might initially expect.
 */
export interface PCAExtraction {
  /**
   * Total dollars from Table 1's "Immediate Repair" column. Items that require
   * action at closing — reserved up-front (cell E49 in the template).
   */
  readonly immediateRepairs: number | null;

  /**
   * Total dollars from Table 1's "Short-Term Cost" column. Items that should be
   * addressed within ~2 years per ASTM E2018 — inform the year-1+ capex plan.
   * RENAMED from `nearTermRepairs` (Decision 5 / Item 6a of the implementation
   * recon — zero non-fixture consumers; clean rename eliminates the field-name
   * ambiguity). The Short-Term Cost column is structurally present in standard
   * PCA reports even when the total is $0 (Sunroad's case); return `null` only
   * if the column is structurally absent.
   */
  readonly shortTermRepairs: number | null;

  /**
   * Evaluation period from Table 2's header (e.g., "12-Year Replacement Reserve
   * Schedule"). Anchors the length of `capexScheduleInflated` / `capexScheduleUninflated`
   * — extractor post-processing enforces `evaluationPeriodYears === array.length`
   * by trusting the array and overriding the field when they disagree
   * (Item 6c of the recon).
   */
  readonly evaluationPeriodYears: number | null;

  /**
   * Annual inflation rate applied to the uninflated schedule to produce the
   * inflated schedule (e.g., 0.025 for 2.5%). Decimal fraction, NOT percent.
   */
  readonly inflationRate: number | null;

  /**
   * PCA-reported summary metric: average annual replacement reserve cost per
   * square foot, inflated dollars. Used as a cross-check value against the
   * primary derivation `sum(capexScheduleInflated) / evaluationPeriodYears`
   * (Item 6b of the recon).
   */
  readonly replacementReservesPerSfPerYearInflated: number | null;

  /**
   * Same metric as above, in uninflated (year-0) dollars.
   */
  readonly replacementReservesPerSfPerYearUninflated: number | null;

  /**
   * Year-by-year capex schedule in inflated dollars. One entry per year of the
   * evaluation period. Years with no scheduled capex emit
   * `{year: N, amount: 0}` — do NOT omit zero-amount years (would silently
   * misrepresent back-loaded capex profiles per v8 §10.4 Errata).
   *
   * Engine consumption: projected to the handbook field-bag as
   * `bag['capex_projection']` (a length-N array of amounts) for P-IV-RET-6's
   * `sum_over_term` formula.
   *
   * Extracted deterministically via pdfjs-dist's positional API (see
   * `apps/api/src/services/extract-pca-schedule.ts`) — issue #44 resolution,
   * v10. The v9 KNOWN LIMITATION here (50-60% per-year alignment accuracy)
   * was framed as PDF-format-structural; it was actually
   * extractor-choice-structural: `unpdf`'s `extractText({ mergePages: true })`
   * path stripped column positions, but pdfjs-dist (already accessible
   * through `unpdf`'s `getDocumentProxy`) preserves them. The deterministic
   * extractor reads Table 2's year-header row + the labeled
   * INFLATED/UNINFLATED totals rows directly.
   */
  readonly capexScheduleInflated: ReadonlyArray<{
    readonly year: number;     // 1-indexed
    readonly amount: number;   // dollars; 0 for years with no scheduled capex
  }> | null;

  /**
   * Same schedule in uninflated (year-0) dollars. Cross-source for the
   * inflated schedule; not consumed by the handbook engine directly.
   */
  readonly capexScheduleUninflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;

  /**
   * Condition narratives for the four major building-system categories.
   * 1-3 sentence summary of each system's condition + remaining useful life.
   * LLM_CONTEXT consumers (P-IV-MF-4, P-IV-MHC-1) read these for credit
   * narrative; no DET check reads them today. Decision 4: not widened to a
   * structured rating + narrative split — flat strings serve the handbook
   * principles adequately.
   */
  readonly structural: {
    readonly roof: string | null;
    readonly hvac: string | null;
    readonly plumbing: string | null;
    readonly electrical: string | null;
  };
}

/* --------------------------------- appraisal -------------------------------- */

/**
 * Per-line stabilized operating-statement breakdown, matching the appraiser's
 * direct-cap pro-forma table (CBRE format on Sunroad p.88 / p.101). Each field
 * is broken out so the workbook's Operating-tab Appraisal column J reconciles
 * end-to-end: SUM of per-line expenses = totalOperatingExpenses, and
 * EGI - totalOperatingExpenses = stabilizedNOI. Same shape as
 * OperatingStatementExtraction's expense block but appraiser-sourced.
 *
 * `netEffectiveReimbursements` is reimbursements gross MINUS the "Vacancy &
 * Credit Loss on Other Income" line — the template has no dedicated row for
 * the latter, so the appraiser's effective other-income subtotal is captured
 * net. This keeps L17 / J17 (Total Revenues) tied to EGI exactly.
 */
export interface AppraisalStabilizedProForma {
  readonly potentialRentalIncome: number | null;
  readonly vacancyPct: number | null;              // 0..1 fraction
  readonly vacancyLoss: number | null;             // negative dollars
  readonly creditLossPct: number | null;           // 0..1 fraction
  readonly creditLoss: number | null;              // negative dollars
  readonly otherIncomeGross: number | null;        // pre-VCL
  readonly otherIncomeVCL: number | null;          // negative; vacancy/credit loss on other income
  readonly netEffectiveReimbursements: number | null;  // reimbursementsGross + otherIncomeVCL share (template-aware)
  readonly effectiveGrossIncome: number | null;    // EGI

  readonly realEstateTaxes: number | null;
  readonly insurance: number | null;
  readonly utilities: number | null;
  readonly generalOperating: number | null;        // "General Operating" / G&A
  readonly janitorial: number | null;
  readonly repairsMaintenance: number | null;
  readonly managementFee: number | null;
  readonly nonreimbursableLandlord: number | null;
  readonly replacementReserves: number | null;
  readonly totalOperatingExpenses: number | null;

  readonly netOperatingIncome: number | null;
}

/**
 * Current-period operating snapshot at the as-of value date (Sunroad's 2022 actuals
 * column on CBRE p.88 reconciliation table). Used for going-in DSCR/DY — the honest
 * picture when a property is in lease-up.
 */
export interface AppraisalCurrentProForma {
  readonly effectiveGrossIncome: number | null;    // current EGI (e.g. Sunroad 2022: $1.94M)
  readonly totalOperatingExpenses: number | null;
  readonly netOperatingIncome: number | null;      // can be negative during lease-up
}

/**
 * Per-line escrow / reserve estimates surfaced by the appraisal for the
 * Conclusions & Escrows tab's "Per Appraisal" column.
 */
export interface AppraisalReserveEstimates {
  readonly realEstateTaxes: number | null;
  readonly insurance: number | null;
  readonly replacementReserves: number | null;
  readonly tenantImprovements: number | null;
  readonly leasingCommissions: number | null;
  readonly environmental: number | null;
}

/**
 * AppraisalExtraction — the source-agnostic appraisal contract.
 *
 * SUNROAD-APPRAISAL: this shape is filled by `extract-cbre-appraisal.ts` for
 * the CBRE Sunroad PDF. Future appraisal-firm extractors (JLL, Cushman, etc.)
 * fill the SAME shape so downstream consumers (workbook populator, memo,
 * judgment) read symbolically. Page-level provenance via `pageReferences`.
 *
 * Identity fields (address / yearBuilt / ...) are BACKFILLS — the workbook
 * populator and projector merge them into PropertyMetadata only where PM is
 * null (per Sprint-0 honest-blank discipline; appraisal NEVER overwrites the
 * ASR-AI extracted PM).
 *
 * SCOPE NOTE: this extraction is consumed as a REFERENCE INPUT for workbook +
 * memo rendering. It does NOT re-trigger doctrine evaluation. Doctrine is
 * frozen; lease-up handling lives entirely in the renderer / memo / workbook.
 */
export interface AppraisalExtraction {
  readonly source?: 'cbre' | 'jll' | 'cushman' | 'colliers' | 'other';
  readonly reportName?: string | null;             // "CB23US057102-1_Sunroad Centrum I…"

  // ---- Identity (backfills for PropertyMetadata nulls) ----
  readonly addressFull?: string | null;            // "8620 Spectrum Center Blvd"
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly county?: string | null;
  readonly yearBuilt?: number | null;
  readonly grossBuildingArea?: number | null;      // GBA (distinct from NRA)
  readonly netRentableArea?: number | null;        // NRA (cross-check)
  readonly numberOfStories?: number | null;
  readonly numberOfBuildings?: number | null;

  // ---- Interest + value dates ----
  readonly interestAppraised?: string | null;      // 'Leased Fee Interest' | 'Fee Simple Estate'
  readonly asIsValueDate?: ISODateTime | null;
  readonly asStabilizedValueDate?: ISODateTime | null;

  // ---- Headline values ----
  readonly asIsValue?: number | null;
  readonly asStabilizedValue?: number | null;
  readonly landValue?: number | null;
  readonly insurableValue?: number | null;

  // ---- Income-cap math ----
  readonly overallCapRate?: number | null;         // 0..1 fraction
  readonly terminalCapRate?: number | null;
  readonly discountRate?: number | null;

  // ---- Stabilized + current pro forma (load-bearing for column J reconcile) ----
  readonly stabilizedProForma?: AppraisalStabilizedProForma;
  readonly currentProForma?: AppraisalCurrentProForma;

  // ---- Lease-up axis ----
  readonly stabilizedOccupancy?: number | null;    // 0..1 fraction
  readonly currentOccupancyPhysical?: number | null;
  readonly currentLeasedPct?: number | null;
  readonly stabilizationMonths?: number | null;

  // ---- Per-appraisal reserves (Conclusions tab) ----
  readonly perAppraisalReserves?: AppraisalReserveEstimates;

  // ---- Provenance: field name → PDF page (1-indexed) ----
  readonly pageReferences?: Readonly<Record<string, number>>;

  // ---- Legacy 3-field interface, preserved for backwards compat ----
  readonly valueConclusion: number | null;        // alias for asIsValue (legacy callers)
  readonly capRate: number | null;                // alias for overallCapRate
  readonly methodology: string | null;            // 'Income Capitalization Approach' etc.
}

/* ----------------------------- Parties (Borrower / Sponsor) --------------- */

/**
 * Counterparty identity surfaced for the workbook's Borrower tab. Standalone
 * field (not part of the spine ExtractionResult) so it can be lifted off the
 * ASR via a deterministic regex without re-running the full extraction
 * pipeline. Same pattern as the appraisal / PCA / issuer-UW standalone seams.
 *
 * Source convention on the ASR is: a "Borrower Summary" section near the
 * front of the document with "Borrower Entity Name: <value>" and
 * "Sponsor / Guarantor: <value>" lines, plus a loan-terms table that
 * restates "Borrower: <value>" and "Sponsor: <value>" later on. Either
 * surface satisfies the extraction; both are present on every CMBS-style
 * ASR encountered to date.
 */
export interface PartiesExtraction {
  readonly borrowerName: string | null;
  readonly sponsorName:  string | null;
  /** Optional provenance — page number(s) the names were lifted from. */
  readonly pageReferences?: Readonly<Record<string, number>>;
}

/* ------------------------------- seller UW + ASR ---------------------------- */

export interface SellerUWExtraction {
  readonly underwrittenNOI: number | null;
  readonly underwrittenRentGrowth: number | null;  // 0..1 fraction (annualized)
  readonly underwrittenVacancy: number | null;     // 0..1 fraction
}

export interface ASRExtraction {
  readonly impliedValue: number | null;
  readonly impliedCapRate: number | null;          // 0..1 fraction
  readonly underwrittenNOI: number | null;
  /**
   * Dollar amount being refinanced — the existing-loan payoff line in the
   * ASR's Sources & Uses table (e.g. "Loan Payoff $65,365,379" in the
   * Sunroad ASR). null when the deal is not a refinance, when the line is
   * not present, or when extraction cannot identify it.
   *
   * Used by the data-integrity gate's cross-consistency check:
   *   refinance && loanAmount < priorDebtPayoff → HARD halt.
   *
   * Additive widening — older ASRExtraction records persist with this
   * field absent at the JSON layer; readers must treat undefined and null
   * identically (both = "not extracted").
   */
  readonly priorDebtPayoff: number | null;
}

/* -------------------------------- loan terms -------------------------------- */

export interface LoanTermsExtraction {
  readonly loanAmount: number | null;
  readonly interestRate: number | null;            // 0..1 annualized fraction
  readonly amortization: number | null;            // months
  readonly interestOnlyPeriod: number | null;      // months
  readonly maturityDate: ISODateTime | null;
  /**
   * Provenance tag for the loan-terms record. Optional for back-compat —
   * legacy persisted records (and the caller-supplied / route-form-field
   * path) do not carry this field; line-item builders treat absent as
   * 'BANK' (the historical default, semantically "caller-supplied").
   *
   * Set to 'ASR' when the loan-terms block was parsed from the ASR PDF
   * (`extractAsrLoanTerms`). The data-integrity gate's
   * STUB_SUSPECT_SOURCES does NOT include 'ASR', so document-extracted
   * loan terms clear the provenance gate; caller-supplied terms
   * (source=BANK) continue to surface a WARN.
   */
  readonly source?: SourceTier;
}

/* ------------------------------- 424B5 Annex A ------------------------------ */

/**
 * 424B5 prospectus Annex A — issuer-stated, per-loan stratification tables.
 * Cross-reference layer: these numbers are what the ISSUER underwrote and what
 * the appraiser concluded as of cut-off; they are NOT the answer key. The
 * system underwrites independently from operating statements + rent rolls and
 * IMPROVES on the issuer's numbers (Model A frame, per handbook §I and the
 * NOI-recon precedence rule P-III-15).
 *
 * MUST NEVER drive `AdjustedInputs.metrics.noi`. The issuer-NOI fields below
 * target the dedicated cross-reference slots:
 *   - issuer-CF GS-U/W column   → AdjustedInputs.metrics.issuerCfUwNoi
 *   - issuer-prospectus UW NOI  → AdjustedInputs.metrics.issuerStatedNoiSellerUw
 *                                  (when the Annex A figure is the issuer's
 *                                   prospectus-disclosed UW NOI, not the CF column)
 * The system's `metrics.noi` continues to flow from the judgment cascade
 * against `t12Actual → sellerUwOperatingStatement → inPlace`. See the boundary
 * report in the v1.6 commit for the cell-by-cell destination map.
 *
 * 22 fields mirror the spike's DealBag (apps/api/src/scripts/clean-corpus-
 * spike-annexA.ts, hand-decoded for WFRBS 2013-C11 Loan #17) — the exact
 * shape the productionized parser populates. Field-population status per
 * source shelf is tracked in the adapter's report; null fields here mean
 * the Annex A column for this loan was absent / "Various" / NAV.
 */
export interface AnnexAExtraction {
  /** Origination loan amount (cut-off principal balance — pre-paydown). */
  readonly loanAmount: number | null;
  /** Original term to maturity, years. */
  readonly termYears: number | null;
  /** Original amortization term, months. 0 = balloon-only / IO. */
  readonly amortMonths: number | null;
  /** Interest-only period, years. */
  readonly ioYears: number | null;
  /** Mortgage rate, 0..1 fraction. */
  readonly coupon: number | null;
  /** Loan maturity date (ARD when applicable). */
  readonly maturityDate: ISODateTime | null;
  /** Canonical asset class from the General Property Type column. */
  readonly assetType: string | null;
  /** Specific Property Type / subtype string from Annex A. */
  readonly subType: string | null;
  /** Physical / underwritten occupancy at issuer cut-off, 0..1 fraction. */
  readonly occupancyCurrent: number | null;
  /** Most-Recent / TTM NOI from issuer's operating-statement summary. */
  readonly t12Noi: number | null;
  /** Most-Recent / TTM EGI (revenue) from issuer's operating-statement summary. */
  readonly t12Egi: number | null;
  /** Most-Recent / TTM operating expenses from issuer's operating-statement summary. */
  readonly t12OpEx: number | null;
  /** Prior-year actual NOI (one year before TTM), when separately disclosed. */
  readonly priorPeriodNoi: number | null;
  /** Issuer's Underwritten NOI as disclosed in Annex A's UW column. */
  readonly uwY1Noi: number | null;
  /**
   * Issuer's UW NOI DSCR (NOI / UW DS basis — matches prospectus's first
   * DSCR column position; for WFRBS 2013-C11 this is the "UW NOI DSCR (x)"
   * column at T4 position 1). UW NCF DSCR is column 2 in T4 and is NOT
   * currently surfaced on AnnexAExtraction; add as a sibling field if a
   * future consumer needs it. (Originally docstring'd as NCF DSCR per the
   * spike's hand-decode convention — corrected 2026-06-13 in lockstep with
   * the t12Noi / uwY1Noi swap; the numeric VALUE was always the NOI DSCR.)
   */
  readonly uwDscr: number | null;
  /** Issuer's underwritten NOI Debt Yield. */
  readonly uwDebtYield: number | null;
  /** Appraised value at issuer cut-off, dollars. */
  readonly concludedValue: number | null;
  /** Cut-off LTV ratio (loan / appraised value), 0..1 fraction. */
  readonly concludedLtv: number | null;
  /** Upfront PIP / CapEx / Engineering reserve dollars (named-reserve cell). */
  readonly pipOrCapexReserve: number | null;
  /** Upfront TI/LC reserve dollars (named-reserve cell). */
  readonly tiLcReserve: number | null;
  /** Largest tenant name. Null for hospitality / multifamily / self-storage. */
  readonly largestTenant: string | null;
  /** Largest-tenant lease expiration date (ISO). Null for non-tenant assets. */
  readonly leaseExpirationLargest: ISODateTime | null;
  /**
   * Pari-passu split-loan companion record. Populated when the loan is a
   * Note in a pari-passu combination (this trust holds one note; other notes
   * are held by other trusts). When set, the prospectus's stated LTV / DSCR /
   * Debt Yield identities are computed against the COMBINED whole-loan
   * cut-off balance, NOT the trust-slice loanAmount.
   *
   * Three pari-passu loans on WFRBS 2013-C11: #1 Republic Plaza
   * ($280M combined), #2 Concord Mills ($235M), #6 One South Wacker Drive
   * ($165M). Distinct from cross-collateralized constructs (e.g. #57/#58)
   * — those do NOT populate this field.
   *
   * Source: prose footnote #4 in the Annex A footnotes region. Parser regex
   * pattern: "For mortgage loan #N (PropertyName), the mortgage loan
   * represents Note A-X of [count] pari passu companion loans, which have a
   * combined Cut-off date principal balance of $Y."
   */
  readonly pariPassuCombination: PariPassuCombination | null;
}

/**
 * Pari-passu split-loan companion data. When a mortgage loan is split into
 * multiple notes (Note A-1, A-2, …) held by different trusts, this record
 * captures the THIS-loan's note position and the FULL combined balance
 * across all notes. The prospectus's stated LTV/DY/DSCR use the combined
 * balance as denominator/DS-input; this trust's slice (`loanAmount`) is the
 * portion of cash flows accrued to this trust's investors only.
 *
 * Optional on AnnexAExtraction — null for single-trust loans (the majority).
 */
export interface PariPassuCombination {
  /** This trust's note position, e.g. "A-1" or "A-2". String to keep
   *  open-shaped (some shelves use "A-3" or other conventions). */
  readonly noteNumber: string;
  /** Total notes across the combination (e.g. 2 for "two pari passu
   *  companion loans"). */
  readonly totalNotes: number;
  /** Combined cut-off date principal balance across ALL notes — the
   *  denominator used by the prospectus's stated identities (LTV, DY,
   *  DSCR). Dollars. */
  readonly combinedCutOffBalance: number;
}

/* ------------------------------ ExtractionResult ---------------------------- */

/**
 * Stage-1 record. `id` is the SHA-256 of the JCS canonical serialization of every field below
 * EXCEPT `id`. Producers compute the hash, brand as `ExtractionResultId`, attach.
 *
 * Re-extraction of the same source documents produces the same `id`; re-running with a different
 * `extractionEngineVersion` produces a new `id` (engine bump → new record).
 */
export interface ExtractionResult {
  readonly id: ExtractionResultId;
  readonly analysisAsOfDate: ISODateTime;
  readonly extractionEngineVersion: ExtractionEngineVersion;

  /** External deal identifier (e.g., loan number, opportunity name). Distinct from `id`. */
  readonly dealRef: string;

  readonly rentRoll: RentRollExtraction | null;
  /**
   * In-Place / current column from the seller CF (contractual rents currently
   * in effect, annualized).
   *
   * RENAMED 2026-05-31 from `t12` — that name was misleading because this slot
   * has always held the In-Place column when both In-Place and T-12 columns
   * exist in the source workbook (regex collision in the extractor + dedup
   * made the t12 column unreachable). The collision was fixed and the field
   * renamed in one atomic commit. Strict T-12 / trailing-twelve data, when
   * present in the source, now flows into the separate `t12Actual` slot.
   *
   * Class-(a) downstream fields (reserves, taxes, reimbursements, vacancyLoss,
   * totalOpEx) DO NOT read primarily from this slot — they cascade through
   * `t12Actual → sellerUwOperatingStatement → inPlace`. Neutral income lines
   * preserve the legacy semantic where In-Place wins the revenue baseline.
   */
  readonly inPlace: OperatingStatementExtraction | null;
  /**
   * Strict T-12 / trailing-twelve column extracted from the seller CF when
   * the source workbook actually exposes one (most CMBS-style seller CFs do
   * NOT — they show In-Place + GS U/W only, in which case this slot is null).
   *
   * Always null today on every deal whose source CF lacks a T-12 column. A
   * separate class-(b) ingest slot for true trailing operating statements
   * (T-12 P&L PDFs / spreadsheets uploaded as a 5th input) is planned but
   * NOT in scope here — when that lands, this field gains a second producer
   * and `JE_TRAILING_ACTUALS_MISSING` will stop firing on deals carrying a
   * T-12 statement. Until then, the field documents the gap honestly rather
   * than silently borrowing the In-Place column's data.
   *
   * Load-bearing consumer: `AdjustedInputs.metrics.trailingActualNoi` reads
   * `t12Actual.noi`. The NOI-reconciliation rule (P-III-15) uses
   * trailing-actual NOI as the truth floor for the issuer's underwritten NOI.
   */
  readonly t12Actual: OperatingStatementExtraction | null;
  readonly pca: PCAExtraction | null;
  readonly appraisal: AppraisalExtraction | null;
  readonly sellerUw: SellerUWExtraction | null;
  /**
   * Full operating-statement projection of the seller's underwriting column (the right-most
   * column in a Seller CF workbook — labels vary: "GS U/W", "Seller U/W", "Issuer UW"). Distinct
   * from `sellerUw` above, which carries only three summary fields (NOI / rent growth / vacancy)
   * consumed by the judgment source-cascade. This field mirrors the shape of `inPlace` so the
   * same downstream renderers can treat In-Place and Seller-UW columns symmetrically.
   *
   * Load-bearing for class-(a) downstream fields. Reserves, taxes,
   * reimbursements, vacancyLoss, and totalOpEx cascade through this slot
   * (preferring t12Actual when present, falling back to inPlace) because the
   * GS U/W column carries the issuer's adjustments — Prop 13 tax bases,
   * market-rent reimbursements, etc. Reading In-Place for these fields
   * understated reserves to $0 on Sunroad before the 2026-05-31 fix.
   *
   * Engine bump 1.0 → 1.1 introduced this field; pre-1.1 extractions did not carry it.
   */
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
  readonly asr: ASRExtraction | null;
  /** Counterparty identity lifted off the ASR (borrower / sponsor / guarantor).
   *  Sub-extractor of asr.adapter — populated when an asrPdf slot is passed
   *  and the regex matches; null otherwise. Same Option-A pattern as
   *  propertyMetadata: ASR-derived sub-record, surfaced sibling-style on
   *  ExtractionResult so the projector + render path can consume it without
   *  re-parsing the PDF. */
  readonly parties: PartiesExtraction | null;
  readonly loanTerms: LoanTermsExtraction | null;
  /**
   * 424B5 prospectus Annex A — issuer-stated per-loan stratification. Always
   * null when the deal has no Annex A source filing OR when the parser couldn't
   * locate the section. CROSS-REFERENCE LAYER ONLY — see the AnnexAExtraction
   * docstring for the Model-A boundary contract. v1.6 addition (engine version
   * label bump 1.5 → 1.6 covers the new slot; no manifest gates this today).
   */
  readonly annexA: AnnexAExtraction | null;

  readonly sourceDocuments: readonly SourceDocumentRef[];

  /**
   * Per-sub-record extractor versions, stamped by the composer (Ticket D #?).
   *
   * Open-shaped Record<string, string>: keys are sub-record field names from
   * this contract (e.g., 'inPlace', 't12Actual', 'sellerUwOperatingStatement',
   * 'rentRoll', 'asr'); values are the adapter version strings that produced
   * the corresponding field's data. New adapters add new keys without contract
   * widening. (The historical 't12' key was renamed to 'inPlace' alongside
   * the 2026-05-31 field rename; producers that wrote 't12' before that date
   * are interpreted as having written In-Place data.)
   *
   * Composer emission rule: a key appears IFF the sub-record value is
   * non-null. Empty `{}` is valid for "no extractor produced data" (e.g.,
   * a synthesized extraction from caller-provided data only). For sub-records
   * with multiple potential producers (rentRoll: xlsx-adapter vs ASR-AI-fallback),
   * the version recorded is that of the adapter that won precedence (see
   * pickRentRoll's source field).
   *
   * `loanTerms` is intentionally NOT in this map — it's caller-provided via
   * the build-and-ingest route's `loanTerms` form field (Ticket K), not
   * extractor-produced. When a future extractLoanTerms adapter ships (parallel
   * to Ticket I's extractASR), it'll start emitting a 'loanTerms' key here.
   * Similarly, pca / appraisal will get adapter producers in later batches
   * and gain entries then.
   *
   * Part of the JCS-canonical hash input: bumping any adapter version
   * produces a new ExtractionResultId (same discipline as
   * extractionEngineVersion).
   */
  readonly extractorVersions: Record<string, string>;
}
