import { FindingCategory } from '../types/analysis';

export const DEFAULT_SCORING_WEIGHTS: Record<FindingCategory, number> = {
  cash_flow: 25,
  leasing: 20,
  market: 15,
  sponsor: 15,
  loan_structure: 15,
  expense: 10,
};

export const SCORING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  cash_flow: 'Cash Flow Quality',
  leasing: 'Tenancy & Lease Risk',
  market: 'Market Risk',
  sponsor: 'Sponsor Risk',
  loan_structure: 'Loan Structure Risk',
  expense: 'Valuation / Leverage Risk',
};

export const RISK_TIERS = [
  { min: 85, max: 100, label: 'Strong', color: '#10B981' },
  { min: 70, max: 84, label: 'Acceptable', color: '#F59E0B' },
  { min: 50, max: 69, label: 'Watchlist', color: '#F97316' },
  { min: 0, max: 49, label: 'High Risk', color: '#EF4444' },
] as const;
