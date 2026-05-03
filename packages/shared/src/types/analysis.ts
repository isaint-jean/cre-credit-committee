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

export type AdjustmentFlag = 'minor' | 'moderate' | 'material';
export type AdjustmentBias = 'conservative' | 'neutral' | 'aggressive';

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

export interface CreditScoreCategory {
  category: FindingCategory;
  score: number;
  maxScore: number;
  weight: number;
  weightedScore: number;
  findings: string[];
  explanation: string;
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

/** Full extraction result for all core fields, with pre-validation status. */
export interface ExtractionResult {
  fields: Record<CoreFieldName, ExtractedField>;
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
