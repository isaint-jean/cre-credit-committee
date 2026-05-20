/**
 * Deterministic Cross-Check Service
 *
 * Compares Seller/Bank claimed values against BP Spiral (internally derived)
 * underwriting values. Pure arithmetic — no AI calls. Same inputs always
 * produce identical variances, flags, and commentary.
 */

import { v4 as uuid } from 'uuid';
import type {
  CrossCheckFinding, SellerExtractedMetrics, AdjustmentFlag, AdjustmentBias,
  Severity, PageReference,
} from '@cre/shared';
import type { UnderwritingModel } from '@cre/shared';
import type { CriteriaRuleSet } from '@cre/shared';

// --- Thresholds ---

const MINOR_THRESHOLD = 5;     // <= 5% variance
const MODERATE_THRESHOLD = 15;  // <= 15% variance
// > 15% = material

// --- Main Entry Point ---

export interface CrossCheckResult {
  findings: CrossCheckFinding[];
  overallBias: AdjustmentBias;
}

export function generateDeterministicCrossCheck(
  sellerMetrics: SellerExtractedMetrics,
  uwModel: UnderwritingModel,
  criteria?: CriteriaRuleSet | null,
): CrossCheckResult {
  const findings: CrossCheckFinding[] = [];

  // Compare each metric where both seller and BP values exist.
  // Cross-check is limited to fields the seller-extraction prompt emits:
  // NOI, Loan Amount, Interest Rate, Cap Rate, Property Value, Debt Service, DSCR.
  const comparisons: {
    metric: string;
    sellerEntry: { value: number | null; source: string };
    // null = BP value is not computable; comparison must be skipped, never coerced to 0.
    bpValue: number | null;
    format: (v: number) => string;
    conservativeDirection: 'lower' | 'higher';
  }[] = [
    {
      metric: 'Net Operating Income (NOI)',
      sellerEntry: sellerMetrics.noi,
      bpValue: uwModel.netOperatingIncome,
      format: v => formatCurrency(v),
      conservativeDirection: 'lower',
    },
    {
      metric: 'DSCR',
      sellerEntry: sellerMetrics.dscr,
      bpValue: uwModel.dscr,
      format: v => `${v.toFixed(2)}x`,
      conservativeDirection: 'lower',
    },
    {
      metric: 'Cap Rate',
      sellerEntry: sellerMetrics.capRate,
      bpValue: uwModel.capRate,
      format: v => `${v.toFixed(2)}%`,
      conservativeDirection: 'higher',
    },
    {
      metric: 'Property Value',
      sellerEntry: sellerMetrics.propertyValue,
      bpValue: uwModel.impliedValue,
      format: v => formatCurrency(v),
      conservativeDirection: 'lower',
    },
    {
      metric: 'Loan Amount',
      sellerEntry: sellerMetrics.loanAmount,
      bpValue: uwModel.loanAmount,
      format: v => formatCurrency(v),
      conservativeDirection: 'lower',
    },
    {
      metric: 'Interest Rate',
      sellerEntry: sellerMetrics.interestRate,
      bpValue: uwModel.interestRate,
      format: v => `${v.toFixed(2)}%`,
      conservativeDirection: 'higher',
    },
    {
      metric: 'Debt Service',
      sellerEntry: sellerMetrics.debtService,
      bpValue: uwModel.annualDebtService,
      format: v => formatCurrency(v),
      conservativeDirection: 'higher',
    },
  ];

  for (const comp of comparisons) {
    const sellerVal = comp.sellerEntry.value;
    if (sellerVal === null || sellerVal === undefined) continue;
    // BP value not computable → skip cross-check (never compare against null).
    if (comp.bpValue === null) continue;
    const bpVal: number = comp.bpValue;
    if (bpVal === 0 && sellerVal === 0) continue;

    const absDiff = bpVal - sellerVal;
    const pctVariance = sellerVal !== 0 ? (absDiff / Math.abs(sellerVal)) * 100 : null;
    const absPctVariance = pctVariance !== null ? Math.abs(pctVariance) : null;

    // Determine direction
    let direction: 'positive' | 'negative' | 'neutral' = 'neutral';
    if (Math.abs(absDiff) > 0.001) {
      if (comp.conservativeDirection === 'lower') {
        direction = bpVal < sellerVal ? 'negative' : 'positive';
      } else {
        direction = bpVal > sellerVal ? 'negative' : 'positive';
      }
    }

    const flag = computeAdjustmentFlag(absPctVariance);
    const severity = flagToSeverity(flag);
    const commentary = generateCommentary(comp.metric, sellerVal, bpVal, pctVariance, direction, criteria);

    findings.push({
      id: uuid(),
      metric: comp.metric,
      sellerBankValue: comp.format(sellerVal),
      bpSpiralValue: comp.format(bpVal),
      absoluteVariance: comp.format(absDiff),
      percentVariance: pctVariance !== null ? Number(pctVariance.toFixed(2)) : null,
      direction,
      flag,
      commentary,
      severity,
      sellerSource: {
        page: 1,
        sectionId: '',
        sectionTitle: comp.sellerEntry.source || 'Seller/Bank Document',
        excerpt: '',
      },
      bpSource: 'BP Spiral UW Model',
      // Legacy fields
      asrValue: comp.format(sellerVal),
      uwValue: comp.format(bpVal),
      difference: pctVariance !== null ? `${pctVariance >= 0 ? '+' : ''}${pctVariance.toFixed(1)}%` : 'N/A',
    });
  }

  // Sort: material → moderate → unmeasurable → minor.
  // Unmeasurable findings rank between moderate and minor — they need attention but aren't
  // quantitative evidence of skew. Batch 6.2 (audit U4): exhaustive Record<> with no
  // fallback, so any future AdjustmentFlag addition fails compile rather than ranking last
  // silently.
  const flagOrder: Record<AdjustmentFlag, number> = {
    material: 0,
    moderate: 1,
    unmeasurable: 2,
    minor: 3,
  };
  findings.sort((a, b) => flagOrder[a.flag] - flagOrder[b.flag]);

  const overallBias = computeOverallBias(findings);

  console.log(`[CrossCheck] Generated ${findings.length} findings, bias: ${overallBias}`);

  return { findings, overallBias };
}

// --- Flag Computation ---

export function computeAdjustmentFlag(absPctVariance: number | null): AdjustmentFlag {
  // Batch 6.2 (audit U5): null variance → 'unmeasurable', not 'minor'. The legacy 'minor'
  // mapping silently classified missing-data deals as "no material concern" — risk-washing.
  if (absPctVariance === null) return 'unmeasurable';
  if (absPctVariance <= MINOR_THRESHOLD) return 'minor';
  if (absPctVariance <= MODERATE_THRESHOLD) return 'moderate';
  return 'material';
}

function flagToSeverity(flag: AdjustmentFlag): Severity {
  switch (flag) {
    case 'material': return 'critical';
    case 'moderate': return 'high';
    case 'unmeasurable': return 'medium';   // surface as a meaningful warning, not a low.
    case 'minor': return 'low';
  }
}

// --- Overall Bias ---

export function computeOverallBias(findings: CrossCheckFinding[]): AdjustmentBias {
  let conservativeScore = 0;
  let aggressiveScore = 0;
  let unmeasurableCount = 0;

  // Batch 6.2 (audit U6): skip null-variance findings explicitly (do NOT zero-weight them).
  // Track a count so we can downgrade the verdict to INSUFFICIENT_DATA if any threshold is
  // breached. Previously the legacy `Math.abs(f.percentVariance || 0)` silently scored
  // unmeasurables as zero-weight, allowing a deal with several unmeasurable metrics to roll
  // up 'neutral' — silent risk-washing.
  for (const f of findings) {
    if (f.percentVariance === null || f.flag === 'unmeasurable') {
      unmeasurableCount++;
      continue;
    }
    const weight = Math.abs(f.percentVariance);
    if (f.direction === 'negative') {
      conservativeScore += weight;
    } else if (f.direction === 'positive') {
      aggressiveScore += weight;
    }
  }

  // If the proportion of unmeasurable findings is high enough, the verdict cannot be trusted.
  // Threshold: any unmeasurable > 1/3 of total findings → INSUFFICIENT_DATA.
  if (findings.length > 0 && unmeasurableCount * 3 >= findings.length) {
    return 'INSUFFICIENT_DATA';
  }

  const total = conservativeScore + aggressiveScore;
  if (total < 1) return 'neutral';

  const ratio = conservativeScore / total;
  if (ratio > 0.6) return 'conservative';
  if (ratio < 0.4) return 'aggressive';
  return 'neutral';
}

// --- Commentary Generation ---

function generateCommentary(
  metric: string,
  sellerVal: number,
  bpVal: number,
  pctVariance: number | null,
  direction: string,
  criteria?: CriteriaRuleSet | null,
): string {
  const absPct = pctVariance !== null ? Math.abs(pctVariance).toFixed(1) : '0';
  const dirWord = bpVal > sellerVal ? 'higher' : bpVal < sellerVal ? 'lower' : 'equal to';

  // Find relevant manifesto rule for this metric
  const metricKeywords: Record<string, string[]> = {
    'Net Operating Income (NOI)': ['noi', 'net operating'],
    'DSCR': ['dscr', 'debt service coverage'],
    'Cap Rate': ['cap rate', 'capitalization'],
    'Property Value': ['value', 'valuation'],
    'Loan Amount': ['loan amount', 'loan size'],
    'Interest Rate': ['interest rate', 'coupon'],
    'Debt Service': ['debt service', 'annual debt service'],
  };

  const keywords = metricKeywords[metric] || [metric.toLowerCase()];
  const relevantRule = criteria?.rules?.find(r =>
    r.enabled && keywords.some(kw => r.condition.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw))
  );

  const ruleRef = relevantRule
    ? ` Per manifesto rule: "${relevantRule.name}" (${relevantRule.condition}).`
    : '';

  // Metric-specific commentary templates
  if (metric.includes('NOI')) {
    if (direction === 'negative') {
      return `BP Spiral NOI is ${absPct}% ${dirWord} than seller's claimed value. Adjusted to reflect normalized assumptions for vacancy, concessions, and operating expenses.${ruleRef}`;
    }
    return `BP Spiral NOI is ${absPct}% ${dirWord} than seller's projection.${ruleRef}`;
  }

  if (metric.includes('DSCR')) {
    if (direction === 'negative') {
      return `BP Spiral DSCR of ${bpVal.toFixed(2)}x reflects tighter debt service coverage due to normalized NOI and recalculated debt service.${ruleRef}`;
    }
    return `BP Spiral DSCR is ${absPct}% ${dirWord} at ${bpVal.toFixed(2)}x.${ruleRef}`;
  }

  if (metric.includes('Cap Rate')) {
    return `BP Spiral cap rate of ${bpVal.toFixed(2)}% is ${absPct}% ${dirWord} than seller's assumption, reflecting independent market assessment.${ruleRef}`;
  }

  if (metric.includes('Property Value')) {
    return `BP Spiral property value is ${absPct}% ${dirWord} than seller's valuation, derived from BP NOI and cap rate assumptions.${ruleRef}`;
  }

  if (metric.includes('Interest Rate')) {
    return `BP Spiral interest rate of ${bpVal.toFixed(2)}% is ${absPct}% ${dirWord} than seller's stated coupon.${ruleRef}`;
  }

  if (metric.includes('Debt Service')) {
    return `BP Spiral annual debt service is ${absPct}% ${dirWord} than seller's stated debt service, reflecting BP's recalculated payment schedule.${ruleRef}`;
  }

  if (metric.includes('Loan')) {
    return `Loan amount variance of ${absPct}%.${ruleRef}`;
  }

  return `BP Spiral value is ${absPct}% ${dirWord} than seller's value.${ruleRef}`;
}

// --- Helpers ---

function formatCurrency(value: number): string {
  return '$' + Math.round(value).toLocaleString('en-US');
}
