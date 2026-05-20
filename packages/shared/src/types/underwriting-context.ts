/**
 * UnderwritingContext — narrative + portfolio + aggregation metadata.
 *
 * Architecture role:
 *   AdjustedInputs is strictly quantitative (income, expenses, loan, derived
 *   metrics). UnderwritingContext carries everything else the workbook
 *   renders that ISN'T a numeric driver — narrative text, third-party report
 *   summaries, borrower profile, market overview, comps, and (when in
 *   roll_up mode) portfolio-level aggregation metadata.
 *
 * Hard rules:
 *   - Sentinels (DATA_NOT_PROVIDED, NOT_AVAILABLE, REQUIRES_EXTERNAL_DATA)
 *     are ONLY allowed in this type. Numeric driver fields in AdjustedInputs
 *     remain `number | null` — never strings, never sentinels.
 *   - Producers populate every section. Missing/unavailable narrative is
 *     represented by an explicit sentinel; never elided.
 *   - This file declares the contract only. No producers, no defaults.
 */

/** The sole permitted underwriting modes. */
export type UnderwritingMode = 'single_loan' | 'roll_up';

/**
 * Sentinel values for missing narrative content. Excel renders these
 * verbatim. The producer chooses which sentinel applies based on why the
 * field is absent — see the BP Spire execution layer:
 *
 *   DATA_NOT_PROVIDED      — source documents did not include this field
 *   NOT_AVAILABLE          — section is structurally inapplicable to the deal
 *                            (e.g. Site Inspection / Photos / Maps)
 *   REQUIRES_EXTERNAL_DATA — pipeline cannot derive without external sources
 *                            we have not yet wired (e.g. CMBS comps)
 */
export type MissingDataSentinel =
  | 'DATA_NOT_PROVIDED'
  | 'NOT_AVAILABLE'
  | 'REQUIRES_EXTERNAL_DATA';

/** A narrative cell value: real string, explicit sentinel, or null. */
export type NarrativeValue = string | MissingDataSentinel | null;

/** A list of narrative bullets, each subject to the same null/sentinel rule. */
export type NarrativeList = NarrativeValue[];

/** Tab 1 — Property & Loan Summary. */
export interface PropertyLoanSummary {
  propertyDescription: NarrativeValue;
  loanTermsSummary: NarrativeValue;
  sourcesAndUses: NarrativeValue;
  ownershipSummary: NarrativeValue;
  equityAndCashFlowAnalysis: NarrativeValue;
  historicalOwnership: NarrativeValue;
  annualCashFlowsCommentary: NarrativeValue;
  generalAssetComments: NarrativeValue;
  tenancySummaryCommentary: NarrativeValue;
}

/** Tab 2 — Conclusion & Escrows. */
export interface ConclusionAndEscrows {
  loanSummary: NarrativeValue;
  strengths: NarrativeList;
  weaknesses: NarrativeList;
  mitigants: NarrativeList;
  escrowSummary: NarrativeValue;
  loanStructureCommentary: NarrativeValue;
}

/** Tab 3 — Property Detail. */
export interface PropertyDetailNarrative {
  propertyInformation: NarrativeValue;
  propertyRights: NarrativeValue;
  management: NarrativeValue;
  demographics: NarrativeValue;
  comments: NarrativeValue;
}

/** Tab 4 — Operating History & Pro Forma. Numeric values come from
 *  AdjustedInputs / a separate ProForma model; this carries narrative only. */
export interface OperatingProFormaNarrative {
  historicalOperatingCommentary: NarrativeValue;
  year1ProFormaCommentary: NarrativeValue;
  tenYearProFormaCommentary: NarrativeValue;
}

/** Tab 5 — Stress Scenario commentary. The numeric stress outcomes live in
 *  AdjustedInputs.metrics or a dedicated stress block; this is narrative. */
export interface StressScenarioNarrative {
  stressMethodology: NarrativeValue;
  revenueDownsideCommentary: NarrativeValue;
  expenseUpsideCommentary: NarrativeValue;
  noiAndDscrCommentary: NarrativeValue;
}

/** Tab 6 — Third-Party Report Summary. */
export interface ThirdPartyReports {
  appraisalSummary: NarrativeValue;
  environmentalSummary: NarrativeValue;
  propertyConditionSummary: NarrativeValue;
}

/** Tab 7 — Borrower. */
export interface BorrowerProfile {
  borrowerProfile: NarrativeValue;
  sponsorshipStrength: NarrativeValue;
}

/** Tab 8 — Market. */
export interface MarketNarrative {
  marketOverview: NarrativeValue;
  submarketTrends: NarrativeValue;
}

/** Tab 9 — Site Inspection / Photos / Maps. Per BP Spire spec this tab is
 *  always rendered with NOT_AVAILABLE sentinels in the current contract. */
export interface SiteInspection {
  inspectionNotes: NarrativeValue;
  photos: NarrativeValue;
  maps: NarrativeValue;
}

/** Tab 10 — Comparables. Lease / sales / CMBS comp commentary. */
export interface ComparablesNarrative {
  leaseComps: NarrativeValue;
  salesComps: NarrativeValue;
  cmbsComps: NarrativeValue;
}

/**
 * Roll-up aggregation metadata. Required iff underwritingMode === 'roll_up';
 * MUST be null when underwritingMode === 'single_loan'.
 *
 * Numeric portfolio aggregates flow through AdjustedInputs (the metric block
 * is the aggregated portfolio). This block carries metadata about how the
 * aggregation was performed.
 */
export interface RollUpAggregation {
  /** Number of underlying loans in the roll-up. */
  loanCount: number;
  /** How portfolio-level numbers were combined (e.g. weighted by balance). */
  aggregationMethodology: NarrativeValue;
  /** Cross-portfolio normalization choices applied before aggregation. */
  normalizationCommentary: NarrativeValue;
  /** Per-loan identifiers participating in the roll-up. */
  constituentLoanIds: string[];
}

/**
 * Atomic property descriptors. Populated by the hydration layer from
 * extractionResult.descriptors + structural. Render schema does not read
 * these today (v6 is loan+metrics only); they sit on the context for v7+
 * to wire into Property & Loan Summary / Property Detail cells.
 */
export interface UnderwritingPropertyAtoms {
  name:               string | null;
  street:             string | null;
  city:               string | null;
  state:              string | null;
  zip:                string | null;
  /** County name (no AdjustedInputs or descriptors source; propertyMetadata-only). */
  county:             string | null;
  type:               string | null;
  yearBuilt:          number | null;
  totalSquareFeet:    number | null;
  units:              number | null;
  /** Decimal fraction (0..1). */
  occupancy:          number | null;
  /** e.g. "Fee Simple" / "Leasehold" (propertyMetadata-only). */
  ownershipInterest:  string | null;
}

/**
 * Atomic loan-structure descriptors not already on AdjustedInputs.loan or
 * with potentially-divergent values. Hydration layer applies the precedence
 * rule: AdjustedInputs first, extractionResult.structural fallback.
 */
export interface UnderwritingLoanAtoms {
  termMonths:         number | null;
  amortizationMonths: number | null;
  ioMonths:           number | null;
}

/** Counterparty descriptors. Extraction-only — no AdjustedInputs equivalent. */
export interface UnderwritingPartyAtoms {
  borrowerName: string | null;
  sponsorName:  string | null;
}

/**
 * Top-level context object. The render layer reads narrative cells from this
 * and numeric cells from AdjustedInputs — never the reverse.
 *
 * Producers populate this. Some fields may be null (data missing, not yet
 * derived) or list-shaped. Schema selectors do NOT read this directly —
 * they read the `ResolvedUnderwritingContext` produced by the render
 * service's pre-render projection layer (resolveUnderwritingContext()),
 * which translates nulls into sentinels, joins lists, and pre-flattens the
 * roll-up view per the active underwritingMode.
 *
 * Atomic blocks (property, loan, parties, comparablesLinkageRefs) are
 * OPTIONAL. They are populated by the hydration layer (hydrate-
 * underwriting-context.ts) and unify two upstream surfaces:
 *   - existing AdjustedInputs (legacy numeric pipeline) — authoritative
 *     for any logical field it carries
 *   - extractionResult.descriptors / structural / comparablesLinkageRefs —
 *     used as a fallback for fields AdjustedInputs does not carry
 *
 * The resolver does NOT read atomic blocks today; schema selectors do NOT
 * read them today. They are forward state for v7 wiring.
 */
export interface UnderwritingContext {
  underwritingMode: UnderwritingMode;
  propertyLoanSummary:    PropertyLoanSummary;
  conclusionAndEscrows:   ConclusionAndEscrows;
  propertyDetail:         PropertyDetailNarrative;
  operatingProForma:      OperatingProFormaNarrative;
  stressScenario:         StressScenarioNarrative;
  thirdPartyReports:      ThirdPartyReports;
  borrower:               BorrowerProfile;
  market:                 MarketNarrative;
  siteInspection:         SiteInspection;
  comparables:            ComparablesNarrative;
  /** Required iff underwritingMode === 'roll_up'. Null otherwise. */
  rollUpAggregation:      RollUpAggregation | null;

  // --- Atomic blocks (optional, populated by the hydration layer) -------
  property?:               UnderwritingPropertyAtoms;
  loan?:                   UnderwritingLoanAtoms;
  parties?:                UnderwritingPartyAtoms;
  /** Flat list of comp / CMBS deal references found in source documents. */
  comparablesLinkageRefs?: string[];
}

/**
 * A fully-resolved cell value emitted by the pre-render projection layer.
 * Strings (real text or a MissingDataSentinel), numbers, booleans, or null
 * for genuinely-numeric "no value" cases. This is the shape schema
 * selectors read.
 *
 * Mirrors `CellValue` in the render contract — kept here as a separate
 * declaration so this types module remains self-contained.
 */
export type ResolvedCellValue = number | string | boolean | null;

/**
 * The resolved view of UnderwritingContext that the schema layer consumes.
 *
 * Architectural rule (HARD INVARIANT):
 *   The schema layer is purely declarative — its selectors are simple
 *   "read this field" projections. All branching (null → sentinel, list →
 *   joined string, mode-aware roll-up flattening) lives in the resolver.
 *   Schema selectors MUST NOT inspect underwritingMode or apply fallbacks.
 *
 * Each section is a flat record of CellValue, indexed by the same field
 * names the schema entries reference. The resolver guarantees every entry
 * is populated — schema reads it verbatim.
 *
 * Branding (HARD INVARIANT, enforced by the resolver module):
 *   The render service asserts that every ResolvedUnderwritingContext it
 *   accepts was produced by `resolveUnderwritingContext()`. The resolver
 *   maintains a private registry of issued instances; objects constructed
 *   anywhere else are rejected at the schema boundary. See
 *   `apps/api/src/services/resolve-underwriting-context.ts`.
 */
export interface ResolvedUnderwritingContext {
  underwritingMode: UnderwritingMode;
  propertyLoanSummary:    Record<keyof PropertyLoanSummary, ResolvedCellValue>;
  conclusionAndEscrows: {
    loanSummary:              ResolvedCellValue;
    /** Strengths joined into a single newline-separated string. */
    strengths:                ResolvedCellValue;
    weaknesses:               ResolvedCellValue;
    mitigants:                ResolvedCellValue;
    escrowSummary:            ResolvedCellValue;
    loanStructureCommentary:  ResolvedCellValue;
  };
  propertyDetail:         Record<keyof PropertyDetailNarrative,    ResolvedCellValue>;
  operatingProForma:      Record<keyof OperatingProFormaNarrative, ResolvedCellValue>;
  stressScenario:         Record<keyof StressScenarioNarrative,    ResolvedCellValue>;
  thirdPartyReports:      Record<keyof ThirdPartyReports,          ResolvedCellValue>;
  borrower:               Record<keyof BorrowerProfile,            ResolvedCellValue>;
  market:                 Record<keyof MarketNarrative,            ResolvedCellValue>;
  siteInspection:         Record<keyof SiteInspection,             ResolvedCellValue>;
  comparables:            Record<keyof ComparablesNarrative,       ResolvedCellValue>;
  /**
   * Pre-flattened roll-up view. ALWAYS present, regardless of mode.
   * In single_loan mode, every field is the DATA_NOT_PROVIDED sentinel.
   * In roll_up mode with a populated rollUpAggregation, fields carry the
   * actual values. The schema layer reads this without inspecting mode.
   */
  rollUpView: {
    loanCount:                ResolvedCellValue;
    aggregationMethodology:   ResolvedCellValue;
    normalizationCommentary:  ResolvedCellValue;
    /** Comma-joined list of constituent loan IDs, or a sentinel. */
    constituentLoanIds:       ResolvedCellValue;
  };

  /**
   * v7 atomic-block projections. Sourced from UnderwritingContext.{property,
   * loan, parties, comparablesLinkageRefs} via the resolver. Schema cells
   * registered at v7+ read directly from these fields.
   *
   * String fields: null → DATA_NOT_PROVIDED sentinel.
   * Numeric fields: passed through as-is, including null (the artifact
   * cell renders blank when the value is null).
   * comparablesLinkageRefs: empty array → empty string (NOT sentinel) per
   * the v7 spec; non-empty → comma-joined.
   */
  property: {
    name:              ResolvedCellValue;
    street:            ResolvedCellValue;
    city:              ResolvedCellValue;
    state:             ResolvedCellValue;
    zip:               ResolvedCellValue;
    county:            ResolvedCellValue;
    type:              ResolvedCellValue;
    yearBuilt:         ResolvedCellValue;
    totalSquareFeet:   ResolvedCellValue;
    units:             ResolvedCellValue;
    occupancy:         ResolvedCellValue;
    ownershipInterest: ResolvedCellValue;
  };
  loan: {
    termMonths:         ResolvedCellValue;
    amortizationMonths: ResolvedCellValue;
    ioMonths:           ResolvedCellValue;
  };
  parties: {
    borrowerName: ResolvedCellValue;
    sponsorName:  ResolvedCellValue;
  };
  comparablesLinkageRefs: ResolvedCellValue;
}
