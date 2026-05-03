import { AssetType, FindingCategory, Severity } from './analysis';

export interface CriteriaRule {
  id: string;
  assetType: AssetType;
  category: FindingCategory;
  name: string;
  description: string;
  condition: string;
  threshold?: string;
  severity: Severity;
  weight: number;
  enabled: boolean;
}

export interface CriteriaRuleSet {
  assetType: AssetType;
  rules: CriteriaRule[];
  scoringWeights: Record<FindingCategory, number>;
}

// --- Credit Manifesto Types ---

export type ManifestoComparisonOperator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'contains' | 'between' | 'qualitative';
export type ManifestoOutcome = 'Pass' | 'Fail' | 'Watchlist';
export type ManifestoStatus = 'processing' | 'active' | 'error';

export interface ManifestoExtractedRule {
  metric_name: string;
  condition: string;
  threshold_value: string | number | null;
  comparison_operator: ManifestoComparisonOperator;
  outcome: ManifestoOutcome;
  weight: number;
  category: FindingCategory;
  severity: Severity;
  asset_types: AssetType[] | ['all'];
  source_text: string;
  page_reference?: number | null;
}

export interface ManifestoAmbiguity {
  id: string;
  text: string;
  location: string;
  issue: string;
  suggestion: string;
  severity: 'high' | 'medium' | 'low';
}

export interface CreditManifesto {
  id: string;
  version: number;
  fileName: string;
  fileSize: number;
  status: ManifestoStatus;
  extractedRulesCount: number;
  ambiguitiesCount: number;
  assetTypesCovered: string[];
  uploadedBy: string;
  uploadedAt: string;
  processedAt: string | null;
  isActive: boolean;
  error: string | null;
}

export interface CreditManifestoDetail extends CreditManifesto {
  extractedRules: ManifestoExtractedRule[];
  ambiguities: ManifestoAmbiguity[];
  scoringWeights: Record<FindingCategory, number> | null;
  rawText: string;
}
