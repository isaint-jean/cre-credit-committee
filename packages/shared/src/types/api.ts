import { Analysis, AnalysisSummary, AssetType, Comment, Stance, StressScenario, ResearchResult } from './analysis';
import { UnderwritingModel, RepaymentSchedule } from './underwriting';
import { CriteriaRule, CriteriaRuleSet } from './criteria';

// Analysis endpoints
export interface CreateAnalysisResponse {
  id: string;
  status: string;
  name: string;
  assetType: AssetType;
  createdAt: string;
  cached?: boolean;
  inputHash?: string;
}

export interface AnalysisListResponse {
  analyses: AnalysisSummary[];
}

export interface AnalysisDetailResponse {
  analysis: Analysis;
}

export interface AnalysisStatusResponse {
  id: string;
  status: string;
  progress: number;
  currentStep: string;
  error?: string;
}

// UW Model endpoints
export interface UWModelUpdateRequest {
  updates: { path: string; value: number }[];
}

export interface UWModelUpdateResponse {
  uwModel: UnderwritingModel;
  changedMetrics: { metric: string; oldValue: number; newValue: number }[];
}

// Stress Test
export interface StressTestRequest {
  scenarios: {
    name: string;
    adjustments: {
      vacancyDelta: number;
      rentDelta: number;
      capRateDelta: number;
      interestRateDelta: number;
    };
  }[];
}

export interface StressTestResponse {
  results: StressScenario[];
}

// Comments
export interface CreateCommentRequest {
  sectionId: string;
  findingId?: string;
  stance: Stance;
  text: string;
}

export interface CommentsResponse {
  comments: Comment[];
}

// Research
export interface ResearchRequest {
  query: string;
  additionalKeywords?: string[];
}

export interface ResearchResponse {
  results: ResearchResult[];
  searchQuery: string;
}

// Criteria
export interface CriteriaResponse {
  criteria: CriteriaRuleSet;
}

export interface CreateRuleRequest {
  name: string;
  category: string;
  description: string;
  condition: string;
  threshold?: string;
  severity: string;
  weight: number;
  enabled: boolean;
}

export interface UpdateRuleRequest extends Partial<CreateRuleRequest> {
  id: string;
}

// Loan Terms
export interface LoanTermsUpdateRequest {
  interestRate?: number;
  ioMonths?: number;
  amortizationMonths?: number;
  termMonths?: number;
  rateType?: 'fixed' | 'floating';
  paymentFrequency?: 'monthly' | 'quarterly';
  prepaymentTerms?: string;
  loanAmount?: number;
}

export interface LoanTermsUpdateResponse {
  uwModel: UnderwritingModel;
  repaymentSchedule: RepaymentSchedule;
  changedMetrics: { metric: string; oldValue: number; newValue: number }[];
}
