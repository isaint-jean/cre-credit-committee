export type AssetType = 'office' | 'multifamily' | 'retail' | 'industrial' | 'hotel' | 'self_storage' | 'mixed_use' | 'manufactured_housing';

export type AnalysisStatus = 'uploading' | 'parsing' | 'analyzing' | 'complete' | 'error';

export type FindingCategory = 'leasing' | 'cash_flow' | 'expense' | 'market' | 'sponsor' | 'loan_structure';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Stance = 'agree' | 'disagree' | 'note';

export type Recommendation = 'approve' | 'approve_with_conditions' | 'decline' | 'further_review';

export interface DocumentSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  content: string;
  tables?: TableData[];
  sectionType: 'narrative' | 'financial' | 'appendix' | 'unknown';
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface ParsedDocument {
  fileName: string;
  fileType: 'pdf' | 'docx' | 'xlsx' | 'txt';
  totalPages: number;
  sections: DocumentSection[];
  rawText: string;
  metadata: {
    author?: string;
    createdDate?: string;
    fileSize: number;
  };
}

export interface PageReference {
  page: number;
  sectionId: string;
  sectionTitle: string;
  excerpt: string;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  pageReferences: PageReference[];
  appliedRuleId?: string;
  impact: {
    metric?: string;
    currentValue?: number;
    adjustedValue?: number;
    description: string;
  };
}

// Batch 6.2 (audit U5): 'unmeasurable' added to distinguish "we couldn't compare" from
// "small variance is fine." Mapping null variance to 'minor' silently risk-washed deals
// where the comparison failed.
export type AdjustmentFlag = 'minor' | 'moderate' | 'material' | 'unmeasurable';
// Batch 6.2 (audit U6): 'INSUFFICIENT_DATA' added; verdict downgrades when any finding is
// unmeasurable.
export type AdjustmentBias = 'conservative' | 'neutral' | 'aggressive' | 'INSUFFICIENT_DATA';

export type SellerMetricStatus = 'found' | 'missing';

export interface SellerMetricEntry {
  value: number | null;
  source: string;
  confidence: number;
  status: SellerMetricStatus;
}

export interface SellerExtractedMetrics {
  noi: SellerMetricEntry;
  loanAmount: SellerMetricEntry;
  interestRate: SellerMetricEntry;
  capRate: SellerMetricEntry;
  propertyValue: SellerMetricEntry;
  debtService: SellerMetricEntry;
  dscr: SellerMetricEntry;
}

export interface CrossCheckFinding {
  id: string;
  metric: string;
  sellerBankValue: string;
  bpSpiralValue: string;
  absoluteVariance: string;
  percentVariance: number | null;
  direction: 'positive' | 'negative' | 'neutral';
  flag: AdjustmentFlag;
  commentary: string;
  severity: Severity;
  sellerSource: PageReference;
  bpSource: string;
  // Legacy aliases for backward compatibility with stored analyses
  explanation?: string;
  asrValue?: string;
  uwValue?: string;
  difference?: string;
  asrSource?: PageReference;
  uwSource?: { sheetName: string; cellReference?: string };
}

export interface MitigationStrategy {
  id: string;
  findingId: string;
  strategy: string;
  description: string;
  structuralChanges: string[];
  financialImpact: {
    targetMetric: string;
    currentValue: number;
    projectedValue: number;
    improvement: string;
  };
  requiredReserve?: number;
  requiredEquity?: number;
  riskReduction: 'significant' | 'moderate' | 'marginal';
}

export interface Comment {
  id: string;
  analysisId: string;
  sectionId: string;
  findingId?: string;
  stance: Stance;
  text: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * CategoryTier — display tier for a single credit-score category.
 *
 * Source of truth for thresholds (80 / 60 / 40): apps/api/src/services/doctrine/credit-policy-bands.ts
 * (CATEGORY_TIER_THRESHOLDS) — Batch 6 sub-batch 6.1, decision D6.
 *
 * NOTE: these thresholds intentionally differ from the overall-score `riskTier`
 * (85 / 70 / 50). A category can dip into 'watchlist' without dragging the
 * overall score below 50.
 */
export type CategoryTier = 'strong' | 'acceptable' | 'watchlist' | 'high_risk';

export interface CreditScoreCategory {
  category: FindingCategory;
  score: number;
  maxScore: number;
  weight: number;
  weightedScore: number;
  findings: string[];
  explanation: string;
  // 6.1 — server-emitted tier; null when score is missing.
  tier?: CategoryTier | null;
}

export interface CreditScore {
  overall: number;
  categories: CreditScoreCategory[];
  recommendation: Recommendation;
  narrative: string;
  riskTier: 'strong' | 'acceptable' | 'watchlist' | 'high_risk';
  whyThisScore: string;
  howToImprove: string;
}

export interface BPieceDecision {
  recommendation: Recommendation;
  conviction: 'strong' | 'moderate' | 'weak';
  dealBreakers: string[];
  keyConditions: string[];
  pricingGuidance: string;
  summary: string;
}

export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedDate?: string;
  riskSignal: 'negative' | 'neutral' | 'positive';
}

export interface ResearchResults {
  sponsor: ResearchResult[];
  market: ResearchResult[];
  news: ResearchResult[];
}

export interface CriteriaEvaluation {
  ruleId: string;
  ruleName: string;
  result: 'pass' | 'fail' | 'unknown';
  reason: string;
  source?: string;
}

export interface StressScenario {
  name: string;
  adjustments: {
    vacancyDelta: number;
    rentDelta: number;
    capRateDelta: number;
    interestRateDelta: number;
  };
  results: {
    noi: number;
    // Nullable: null = not computable from current inputs. Downstream MUST
    // treat null as "skip evaluation", never as 0 / pass / fail.
    dscr: number | null;
    ltv: number | null;
    debtYield: number | null;
    impliedValue: number | null;
    // 6.1 — per-cell breach flags. null = metric not computable
    // (distinct from false). Source: apps/api/src/services/doctrine/credit-policy-bands.ts
    // (STRESS_THRESHOLDS — DSCR < 1.15, LTV > 0.80, DY < 0.07).
    dscrBreached?: boolean | null;
    ltvBreached?: boolean | null;
    debtYieldBreached?: boolean | null;
  };
  breaksCovenants: boolean;
  covenantBreaches: string[];
  // Covenants that could not be evaluated (input was null). Distinct from
  // breaches — a skipped covenant is neither a pass nor a fail.
  covenantSkips: string[];
}

export interface SupportingDocument {
  fileName: string;
  fileType: string;
  parsed: ParsedDocument | null;
}

export interface Analysis {
  id: string;
  name: string;
  assetType: AssetType;
  status: AnalysisStatus;
  progress: number;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  // Batch 6.3 — revision lineage on the legacy path. Per architecture decision D4 and the
  // revision-lineage spec (docs/architecture/revision-lineage-spec.md): single-parent,
  // append-only, immutable. Edits create a NEW Analysis row pointing to its parent rather
  // than mutating the existing row. The new-spine path (sub-batch 6.4+) will use the full
  // RevisionLineageEnvelope from @cre/contracts; the legacy path uses these three fields.
  /** Pointer to the immediate parent revision. `null` ONLY for the original (root) analysis. */
  parentAnalysisId?: string | null;
  /** Always equals the original analysis id. Stable across all revisions in the lineage (L3). */
  lineageRootId?: string;
  /** 0-based ordinal in the lineage. `0` for root. Strictly monotonic (never edited after write). */
  revisionOrdinal?: number;
  document: ParsedDocument | null;
  uwDocument: ParsedDocument | null;
  supportingDocuments: SupportingDocument[];
  templateDocument: ParsedDocument | null;
  findings: Finding[];
  creditScore: CreditScore | null;
  uwModel: import('./underwriting').UnderwritingModel | null;
  research: ResearchResults | null;
  crossCheckFindings: CrossCheckFinding[];
  sellerMetrics?: SellerExtractedMetrics | null;
  overallAdjustmentBias?: AdjustmentBias | null;
  mitigations: MitigationStrategy[];
  executiveSummary: string | null;
  bPieceDecision: BPieceDecision | null;
  comments: Comment[];
  criteriaEvaluations: CriteriaEvaluation[];
  stressScenarios: StressScenario[];
  extractionResult?: ExtractionResult | null;
  preValidationGate?: PreValidationGateResult | null;
  // Batch 1B — rent-roll input record (post-Phase 4 contract addition). Resolved
  // by the pipeline via precedence: rent_roll_file > ASR table extraction > Seller UW
  // exhibit extraction. Null when no source produced a parseable rent roll; the
  // caller surfaces a derivationIssues 'missing-support: rent-roll' entry alongside.
  rentRoll?: import('@cre/contracts').RentRoll | null;
  // Batch 1H — property-metadata extraction output. Null when the AI returned
  // all-null fields (no property facts found). Used by Property & Loan Summary
  // header + Property Detail tabs.
  propertyMetadata?: import('@cre/contracts').PropertyMetadata | null;
  // Batch 0 traceability ledger. The merge layer pushes literal-string entries here
  // shaped 'merge-conflict[<field>] asr=... seller=... chosen=...'. Batch 1B extends
  // this with 'missing-support: <subject>' entries when an evidence-gated input is
  // absent (e.g., 'missing-support: rent-roll').
  derivationIssues?: string[];
  error?: string;
  inputHash?: string;
  manifestoVersion?: string;
  modelLogicVersion?: string;
  validationResult?: ValidationResult;
}

// --- Validation Layer ---

export type ValidationCategory = 'data_consistency' | 'rule_application' | 'score_validation' | 'decision_validation' | 'traceability' | 'extraction_completeness';

export interface ValidationCheck {
  name: string;
  category: ValidationCategory;
  passed: boolean;
  details: string;
  expected?: string | number;
  actual?: string | number;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  errors: ValidationCheck[];
  timestamp: string;
}

export interface AnalysisSummary {
  id: string;
  name: string;
  assetType: AssetType;
  status: AnalysisStatus;
  creditScore: number | null;
  riskTier: string | null;
  createdAt: string;
  updatedAt: string;
  inputHash?: string;
  manifestoVersion?: string;
  modelLogicVersion?: string;
  // Batch 6.3 — lineage fields. Optional for backwards compatibility with rows
  // pre-dating revision semantics; new analyses always populate them.
  parentAnalysisId?: string | null;
  lineageRootId?: string;
  revisionOrdinal?: number;
}

/**
 * `LineageEntry` — single revision's summary as returned by `GET /analyses/:id/lineage`.
 * Subset of `AnalysisSummary` plus the lineage chain pointers.
 */
export interface LineageEntry {
  id: string;
  name: string;
  parentAnalysisId: string | null;
  lineageRootId: string;
  revisionOrdinal: number;
  createdAt: string;
  status: AnalysisStatus;
  creditScore: number | null;
  riskTier: string | null;
}

// --- Version Control & Audit ---

export interface AuditLogEntry {
  id: string;
  analysisId: string;
  analysisName: string;
  assetType: AssetType;
  inputHash: string;
  manifestoVersion: string;
  manifestoLabel: string;
  modelLogicVersion: string;
  creditScoreOverall: number | null;
  recommendation: string | null;
  riskTier: string | null;
  validationPassed: boolean;
  timestamp: string;
}

export interface VersionComparison {
  baseAnalysis: AuditLogEntry;
  compareAnalysis: AuditLogEntry;
  metricDiffs: { metric: string; base: number | string | null; compare: number | string | null; delta: string }[];
  scoreDiff: { base: number | null; compare: number | null; delta: number };
  decisionChanged: boolean;
  ruleChanges: { ruleId: string; ruleName: string; baseResult: string; compareResult: string }[];
  manifestoChanged: boolean;
  modelLogicChanged: boolean;
}

export interface ModelLogicVersionEntry {
  version: string;
  description: string;
  changes: string[];
  createdAt: string;
}

// --- Data Extraction Layer ---

export type ExtractionConfidence = 'high' | 'medium' | 'low';

/** A single extracted field with traceability and confidence scoring. */
export interface ExtractedField {
  /** The extracted numeric value, or null if not found. */
  value: number | null;
  /** Confidence level: high = exact label match, medium = inferred/derived, low = ambiguous. */
  confidence: ExtractionConfidence;
  /** The original label as found in the source document (e.g., "SOFR + Spread"). */
  originalLabel: string | null;
  /** Where the value was found: page number, section title, or file reference. */
  sourceLocation: string | null;
  /** How the value was obtained. */
  method: 'exact_match' | 'synonym_match' | 'derived' | 'not_found';
  /** If derived, the formula used (e.g., "NOI / Cap Rate"). */
  derivationFormula?: string;
}

/** The canonical field names required for underwriting. */
export type CoreFieldName = 'noi' | 'loanAmount' | 'interestRate' | 'capRate' | 'propertyValue';

/**
 * String-valued descriptor fields. These are NOT numeric — they carry
 * property identity, addressing, classification, and counterparty names.
 * The extraction layer captures these via label-then-text patterns and
 * stores the trimmed string verbatim. No semantic interpretation,
 * inference, or library matching happens here.
 */
export type DescriptorFieldName =
  | 'propertyName'
  | 'street'
  | 'city'
  | 'state'
  | 'zip'
  | 'propertyType'
  | 'borrowerName'
  | 'sponsorName';

/** Single extracted descriptor (string value with traceability). */
export interface ExtractedDescriptor {
  value: string | null;
  confidence: ExtractionConfidence;
  originalLabel: string | null;
  sourceLocation: string | null;
  method: 'exact_match' | 'synonym_match' | 'not_found';
}

/**
 * Numeric structural fields beyond the core financial five — loan term,
 * amortization, interest-only period, vintage, building size, unit count,
 * occupancy. Captured via the same numeric-normalization machinery as the
 * core fields but expressed as their natural unit (months for time
 * periods, decimal fraction for occupancy, integer for years/units, etc.).
 */
export type StructuralFieldName =
  | 'loanTermMonths'
  | 'amortizationMonths'
  | 'ioMonths'
  | 'yearBuilt'
  | 'totalSquareFeet'
  | 'units'
  | 'occupancy';

/** Full extraction result for all core fields, with pre-validation status. */
export interface ExtractionResult {
  fields: Record<CoreFieldName, ExtractedField>;
  /**
   * Optional. Present when the extraction layer captures property
   * descriptors. Absent on legacy analyses extracted before this surface
   * existed — consumers MUST treat undefined as "no descriptors known"
   * (not as an empty record).
   */
  descriptors?: Record<DescriptorFieldName, ExtractedDescriptor>;
  /**
   * Optional. Present when the extraction layer captures structural
   * numerics. Same legacy semantics as `descriptors`.
   */
  structural?: Record<StructuralFieldName, ExtractedField>;
  /**
   * Optional. Comparable / CMBS linkage references the extractor found in
   * the source documents (e.g. CMBS deal codes, sales-comp identifiers,
   * lease-comp tenant names). String literals from the doc — no resolution
   * to a comp database happens here. Absent or empty when the extractor
   * found nothing.
   */
  comparablesLinkageRefs?: string[];
  /** True if all required fields are present or derivable. */
  allRequiredPresent: boolean;
  /** List of field names that are missing and could not be derived. */
  missingFields: CoreFieldName[];
  /** List of field names with low confidence that need review. */
  lowConfidenceFields: CoreFieldName[];
  /** Timestamp of extraction. */
  extractedAt: string;
}

/** Result of the pre-validation gate — must pass before underwriting proceeds. */
export interface PreValidationGateResult {
  passed: boolean;
  /** Human-readable status message. */
  message: string;
  /** Details per field. */
  fieldStatus: Record<CoreFieldName, {
    present: boolean;
    derived: boolean;
    confidence: ExtractionConfidence | null;
    issue?: string;
  }>;
  /** Fields that were successfully derived via fallback logic. */
  derivedFields: CoreFieldName[];
  /** Fields that are still missing after all fallback attempts. */
  missingCriticalFields: CoreFieldName[];
}
