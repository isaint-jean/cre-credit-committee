import { AssetType, Severity } from './analysis';

// --- Loan Type Classification ---

export type LoanType = 'single_asset' | 'portfolio';

export type DataQuality = 'complete' | 'partial' | 'incomplete';

export interface PortfolioProperty {
  name: string;
  city: string;
  state: string;
  assetClass: AssetType;
  units: number | null;              // unit count (multifamily, hotel, storage)
  sf: number | null;                 // square footage (office, retail, industrial)
}

// --- Batch Job Tracking ---

export interface BatchJob {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalFiles: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;                   // duplicates skipped
  results: BatchJobResult[];
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface BatchJobResult {
  fileName: string;
  status: 'success' | 'error' | 'skipped';
  id?: string;
  dealName?: string;
  assetType?: string;
  loanType?: LoanType;
  skipReason?: string;
  error?: string;
}

// --- Rule Versioning ---

export interface RuleVersion {
  ruleId: string;
  version: number;
  rule: string;
  confidenceLevel: ConfidenceLevel;
  sampleSize: number;
  supportingDealIds: string[];
  createdAt: string;
  reason: string;                    // 'auto-generated' | 'manual update' | 'regenerated' | 'rollback'
}

// --- Historical Underwriting Record ---

export interface HistoricalUWInputs {
  noi: number | null;
  rents: number | null;
  vacancy: number | null;
  expenses: number | null;
  capRate: number | null;
  loanAmount: number | null;
  loanTerm: number | null;
  interestRate: number | null;
  ltv: number | null;
  dscr: number | null;
}

export interface HistoricalUWAdjustments {
  noiAdjustment: number | null;       // % change applied to NOI
  capRateAdjustment: number | null;   // bps added to cap rate
  valueAdjustment: number | null;     // % change to appraised value
  leverageAdjustment: number | null;  // % change to LTV
}

export interface HistoricalUWStructure {
  reserves: number | null;            // $ reserve amount
  recourse: boolean | null;
  cashManagement: boolean | null;
  earnOut: boolean | null;
}

export type DealOutcome = 'approved' | 'modified' | 'rejected';

// --- Outcome Audit Trail (populated when kicks file match is applied) ---

export interface OutcomeAudit {
  sourceFileName: string;              // name of the uploaded kicks Excel file
  sourceRowId: number;                 // original row number in the kicks file
  matchConfidence: number;             // 0–100 percentage score
  matchedFields: string[];             // which fields contributed to the match (e.g. ['dealName','city','state'])
  matchedAt: string;                   // ISO timestamp of when the match was applied
}

// --- Unmatched Outcome (kicks file row that couldn't be linked to a UW record) ---

export interface UnmatchedOutcome {
  id: string;
  sourceFileName: string;              // kicks file name
  sourceRowId: number;                 // row number in the kicks file
  dealName: string | null;
  propertyName: string | null;
  loanAmount: number | null;
  city: string | null;
  state: string | null;
  assetClass: string | null;
  year: number | null;
  outcome: DealOutcome;
  kickReason: string | null;
  notes: string | null;
  linkedUWId: string | null;           // populated when admin manually links
  linkedAt: string | null;             // ISO timestamp of manual link
  uploadedAt: string;
}

// --- Broker Narrative (market commentary extracted from UW files) ---

export interface BrokerNarrative {
  brokerName: string;
  brokerFirm: string;
  subMarket: string;                  // sub-market area (e.g. "Downtown Brooklyn")
  marketNarrative: string;            // broker's market-level commentary
  subMarketNarrative: string;         // broker's sub-market-level commentary
  excerpt: string;                    // exact verbatim excerpt from the source
  sourcePage: string;                 // page number or reference
  sourceSection: string;              // section title or description
  confidence: ConfidenceLevel;        // high/medium/low confidence in extraction
}

export interface HistoricalUnderwriting {
  id: string;
  assetType: AssetType;
  dealName: string;
  outcome: DealOutcome;
  date: string;                       // ISO date string
  year: number;                       // loan year (extracted or manual)
  notes: string;
  fileName: string;
  fileSize: number;
  brokerName: string;                 // broker who originated the deal
  brokerFirm: string;                 // broker's firm
  city: string;                       // property city
  state: string;                      // property state (2-letter code)
  brokerNarratives: BrokerNarrative[];// broker market commentary
  inputs: HistoricalUWInputs;
  adjustments: HistoricalUWAdjustments;
  structure: HistoricalUWStructure;
  loanType: LoanType;                 // single asset or portfolio/roll-up
  parentId: string | null;            // if this is a child property in a portfolio
  portfolioProperties: PortfolioProperty[]; // properties within a portfolio (parent only)
  fileHash: string;                   // SHA-256 of source file for dedup
  dataQuality: DataQuality;           // completeness flag
  outcomeSource: string | null;       // e.g. "Kicks File Match" — how the outcome was determined
  outcomeConfidence: number | null;   // 0–100 match confidence when outcome came from kicks file
  kickMatchId: number | null;         // row ID from kicks file that produced this outcome
  outcomeAudit: OutcomeAudit | null;  // full audit trail for kicks-file-sourced outcomes
  extractedAt: string;                // when data was parsed from file
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalUWSummary {
  id: string;
  assetType: AssetType;
  dealName: string;
  outcome: DealOutcome;
  date: string;
  year: number;
  fileName: string;
  brokerName: string;
  brokerFirm: string;
  city: string;
  state: string;
  notes: string;
  loanType: LoanType;
  parentId: string | null;
  portfolioProperties: PortfolioProperty[];
  brokerNarratives: BrokerNarrative[];
  createdAt: string;
}

// --- Learned Credit Rules ---

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type RuleStatus = 'pending' | 'approved' | 'rejected' | 'disabled';

export interface LearnedRule {
  id: string;
  rule: string;                       // human-readable rule text
  assetType: AssetType | 'all';
  category: 'noi' | 'cap_rate' | 'ltv' | 'dscr' | 'vacancy' | 'reserves' | 'structure' | 'general';
  metric: string | null;              // e.g. 'DSCR', 'LTV', 'Vacancy', 'NOI Haircut', 'Cap Rate'
  threshold: number | null;           // threshold value (e.g. 1.05 for DSCR, 0.75 for LTV)
  pctDealsAffected: number | null;    // % of total deals at/beyond this threshold
  pctDealsRejected: number | null;    // % of affected deals that were rejected
  confidenceLevel: ConfidenceLevel;
  sampleSize: number;
  supportingDealIds: string[];        // IDs of historical UWs that support this rule
  status: RuleStatus;
  version: number;                    // incremented on each update
  createdAt: string;
  updatedAt: string;
}

// --- Rule Metadata (aggregate info about rule state) ---

export interface RuleMetadata {
  lastUpdated: string | null;         // ISO timestamp of last recalculation
  totalDeals: number;
  rejected: number;
  approved: number;
  modified: number;
  ruleCount: number;
  ruleVersion: number;                // global recalculation counter
}

// --- Pattern Insights (Aggregated Statistics) ---

export interface AdjustmentStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  sampleSize: number;
}

export interface RejectionPattern {
  pattern: string;                     // e.g. "Deals with LTV > 75% were rejected 68% of the time"
  metric: string;                      // e.g. "LTV", "DSCR", "Vacancy"
  threshold: number | null;
  rejectionRate: number;               // 0-100 percentage
  sampleSize: number;                  // how many deals hit this pattern
  totalRejected: number;               // how many of those were rejected
  severity: 'critical' | 'high' | 'medium';
}

export interface PatternInsights {
  assetType: AssetType | 'all';
  totalDeals: number;
  outcomeBreakdown: {
    approved: number;
    modified: number;
    rejected: number;
  };
  noiHaircut: AdjustmentStats | null;
  capRateExpansion: AdjustmentStats | null;
  maxLTV: AdjustmentStats | null;
  avgDSCR: AdjustmentStats | null;
  reserveSizes: AdjustmentStats | null;
  topDealKillers: { reason: string; frequency: number }[];
  rejectionPatterns: RejectionPattern[];
  rejectedDealStats: {
    avgDSCR: AdjustmentStats | null;
    avgLTV: AdjustmentStats | null;
    avgVacancy: AdjustmentStats | null;
    avgNOIHaircut: AdjustmentStats | null;
  } | null;
  lastUpdated: string;
}

// --- Market Intelligence (aggregated market-level view) ---

export type BrokerSentiment = 'bullish' | 'slightly_bullish' | 'neutral' | 'slightly_bearish' | 'bearish';

export type RentTrend = 'increasing' | 'stabilizing' | 'declining' | 'mixed';

export interface MarketRentOverview {
  avgRentLow: number | null;        // low end of observed rent range
  avgRentHigh: number | null;       // high end of observed rent range
  rentUnit: string;                 // 'psf' or 'per unit'
  trend: RentTrend;
  trendNarrative: string;           // aggregated description
}

export interface MarketVacancyOverview {
  vacancyLow: number | null;        // as decimal (e.g. 0.04)
  vacancyHigh: number | null;
  occupancyTrend: string;           // aggregated narrative
}

export interface MarketSupplyDemand {
  supplyNarrative: string;          // aggregated supply commentary
  demandNarrative: string;          // aggregated demand commentary
  newDevelopment: string;           // pipeline commentary
  absorptionTrend: string;          // absorption commentary
}

export interface MarketSentimentDetail {
  sentiment: BrokerSentiment;
  explanation: string;              // why this sentiment
  positiveThemes: string[];
  negativeThemes: string[];
}

export interface MarketSource {
  fileCount: number;
  yearRange: string;                // e.g. "2021–2025"
  excerpts: string[];               // sample excerpts (not full detail)
  pageReferences: string[];         // source pages
}

export interface MarketIntelligence {
  marketKey: string;                // e.g. "Brooklyn_NY_multifamily"
  displayName: string;              // e.g. "BROOKLYN — MULTIFAMILY"
  city: string;
  state: string;
  assetType: AssetType | 'all';
  subMarkets: string[];             // sub-markets included
  rentOverview: MarketRentOverview;
  vacancyOverview: MarketVacancyOverview;
  supplyDemand: MarketSupplyDemand;
  brokerSentiment: MarketSentimentDetail;
  keyThemes: string[];              // top 5 market themes
  sources: MarketSource;
  lastUpdated: string;
}

// --- Rejected Deals Upload (batch rejection labeling from Excel) ---

export type OutcomeMatchConfidence = 'high' | 'medium' | 'low' | 'none';

export type OutcomeReviewStatus = 'matched' | 'needs_review' | 'unmatched';

export interface DealOutcomeRow {
  rowIndex: number;                    // original row number in the uploaded file
  dealName: string | null;
  propertyName: string | null;
  loanAmount: number | null;
  city: string | null;
  state: string | null;
  assetClass: string | null;          // raw text from file, mapped to AssetType if possible
  year: number | null;
  outcome: string | null;             // raw text from file; defaults to 'rejected' when absent (file contains only kicked deals)
  kickReason: string | null;          // primary data column — reason the deal was kicked/rejected
  notes: string | null;
  missingFields: string[];            // columns that were absent or empty
}

export interface DealOutcomeMatch {
  rowIndex: number;
  dealName: string;
  assetClass: string;
  year: number | null;
  outcome: DealOutcome;               // normalized outcome
  kickReason: string | null;
  notes: string | null;
  matchedUWId: string | null;         // ID of matched HistoricalUnderwriting
  matchedDealName: string | null;     // name of the matched UW deal
  matchConfidence: OutcomeMatchConfidence;
  reviewStatus: OutcomeReviewStatus;
  matchScore: number;                 // 0–1 similarity score
  applied: boolean;                   // true if outcome was written to the UW record
}

export interface DealOutcomesUploadResult {
  fileName: string;
  totalRows: number;
  matched: number;
  needsReview: number;
  unmatched: number;
  applied: number;                    // how many UW records were updated
  affectedAssetTypes: string[];
  matches: DealOutcomeMatch[];
  uploadedAt: string;
}

// --- Underwriting Template Management ---

export type TemplateType = 'single_loan' | 'roll_up';

export interface UnderwritingTemplate {
  id: string;
  templateType: TemplateType;
  version: number;
  fileName: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: string;
  isActive: boolean;                   // only one active per templateType
}

export interface TemplateVersion {
  id: string;
  templateId: string;
  templateType: TemplateType;
  version: number;
  fileName: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: string;
}

/**
 * Versioned compatibility envelope for an underwriting template artifact.
 *
 * The render contract requires that, given identical
 *   (assetClass, contractVersion, structuralVariantKey, templateVersion),
 * the export pipeline always produce identical Excel structure / sheet
 * visibility / cell values / table layouts. This metadata is the part of that
 * tuple that the storage layer cannot self-attest to: it is declared in
 * code (the template registry) and bound to a specific template artifact
 * version, so an admin uploading a new file cannot silently widen support.
 */
export interface TemplateMetadata {
  templateType: TemplateType;
  templateVersion: number;
  compatibleContractVersion: number;
  /** Asset class strings (AssetType values) the template is allowed to render. */
  supportedAssetClasses: string[];
  /** StructuralVariantKey strings the template is allowed to render. */
  supportedVariants: string[];
  /**
   * UnderwritingMode strings the template is allowed to render. Required at
   * v5+. A template that ships only the single_loan workbook structure must
   * declare ['single_loan'] here so a payload composed in roll_up mode is
   * rejected at compatibility-gate time.
   */
  supportedUnderwritingModes: string[];
}

// --- Applied Intelligence (used during deal analysis) ---

export interface AppliedIntelligence {
  adjustments: {
    label: string;
    value: number;
    unit: string;              // '%', 'bps', '$'
    basis: string;             // e.g. "Based on 87 prior deals"
    ruleId: string;
    confidence: ConfidenceLevel;
  }[];
  redFlags: {
    flag: string;
    basis: string;
    ruleId: string;
    severity: Severity;
  }[];
  benchmarks: {
    metric: string;
    dealValue: number;
    historicalAvg: number;
    historicalRange: string;
    assessment: 'within_norms' | 'aggressive' | 'conservative';
  }[];
}
