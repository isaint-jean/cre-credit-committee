import { Finding, FindingCategory, Severity, CreditScoreCategory } from '../types/analysis';
import { DEFAULT_SCORING_WEIGHTS } from '../constants/scoring-weights';

export interface ScoreDeduction {
  category: FindingCategory;
  severity: Severity;
  points: number;
  findingId: string;
  reason: string;
}

const SEVERITY_DEDUCTION_RANGES: Record<Severity, { min: number; max: number }> = {
  critical: { min: 20, max: 25 },
  high: { min: 10, max: 20 },
  medium: { min: 5, max: 10 },
  low: { min: 1, max: 5 },
};

export function getDeductionForSeverity(severity: Severity): number {
  const range = SEVERITY_DEDUCTION_RANGES[severity];
  return (range.min + range.max) / 2;
}

export function calculateCategoryScore(
  maxScore: number,
  deductions: ScoreDeduction[]
): number {
  const totalDeduction = deductions.reduce((sum, d) => sum + d.points, 0);
  return Math.max(0, maxScore - totalDeduction);
}

export function calculateOverallScore(
  categories: CreditScoreCategory[],
  weights?: Record<FindingCategory, number>
): number {
  const w = weights || DEFAULT_SCORING_WEIGHTS;
  let totalWeightedScore = 0;

  for (const cat of categories) {
    const weight = w[cat.category] || 0;
    totalWeightedScore += (cat.score / 100) * weight;
  }

  return Math.round(totalWeightedScore);
}

export function getRiskTier(score: number): 'strong' | 'acceptable' | 'watchlist' | 'high_risk' {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'acceptable';
  if (score >= 50) return 'watchlist';
  return 'high_risk';
}

export function getRecommendation(score: number, criticalCount: number) {
  if (score >= 85 && criticalCount === 0) return 'approve' as const;
  if (score >= 70) return 'approve_with_conditions' as const;
  if (score >= 50) return 'further_review' as const;
  return 'decline' as const;
}

/**
 * SINGLE SOURCE OF TRUTH for credit-score numerics.
 *
 * Derives the overall score and per-category scores deterministically from
 * findings + scoring weights. Same inputs always produce the same outputs —
 * no AI involvement.
 *
 * Used by both:
 *   - generateCreditScore (initial scoring)
 *   - validateScore       (consistency check)
 *
 * If both call sites use this helper, the consistency check is mathematically
 * guaranteed to pass. AI is restricted to producing narrative text only.
 */
export const SCORING_CATEGORIES: FindingCategory[] = [
  'cash_flow',
  'leasing',
  'expense',
  'market',
  'sponsor',
  'loan_structure',
];

export interface DeterministicScore {
  overall: number;
  categories: CreditScoreCategory[];
  riskTier: 'strong' | 'acceptable' | 'watchlist' | 'high_risk';
  recommendation: 'approve' | 'approve_with_conditions' | 'further_review' | 'decline';
  criticalCount: number;
}

export function computeDeterministicScore(
  findings: Finding[],
  scoringWeights: Record<FindingCategory, number>,
): DeterministicScore {
  const categories: CreditScoreCategory[] = SCORING_CATEGORIES.map(cat => {
    const catFindings = findings.filter(f => f.category === cat);
    const deductions: ScoreDeduction[] = catFindings.map(f => ({
      category: cat,
      severity: f.severity,
      points: getDeductionForSeverity(f.severity),
      findingId: f.id,
      reason: f.title,
    }));
    const score = calculateCategoryScore(100, deductions);
    const weight = scoringWeights[cat] ?? 0;
    return {
      category: cat,
      score,
      maxScore: 100,
      weight,
      weightedScore: (score / 100) * weight,
      findings: catFindings.map(f => f.id),
      explanation: '',
    };
  });

  const overall = calculateOverallScore(categories, scoringWeights);
  const criticalCount = findings.filter(f => f.severity === 'critical').length;

  return {
    overall,
    categories,
    riskTier: getRiskTier(overall),
    recommendation: getRecommendation(overall, criticalCount),
    criticalCount,
  };
}
