import { Severity } from '../types/analysis';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#DC2626',
  high: '#EF4444',
  medium: '#F59E0B',
  low: '#6B7280',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
