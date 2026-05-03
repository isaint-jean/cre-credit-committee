import { store } from '../storage/sqlite-store.js';
import {
  AssetType, FindingCategory, Finding, CreditScore, CriteriaEvaluation,
  BPieceDecision, ValidationCheck, ValidationResult, ExtractionResult,
} from '@cre/shared';
import type { UnderwritingModel } from '@cre/shared';
import { CriteriaRuleSet } from '@cre/shared';
import {
  calculateEGI, calculateTotalExpenses, calculateNOI,
  calculateAnnualDebtService, calculateDSCR,
  calculateImpliedValue, calculateLTV, calculateDebtYield,
} from '@cre/shared';
import {
  getRiskTier, getRecommendation,
  computeDeterministicScore,
} from '@cre/shared';

// --- Tolerances ---

const METRIC_TOLERANCE = 0.01;        // absolute tolerance for metric comparison
const METRIC_PCT_TOLERANCE = 0.005;   // 0.5% relative tolerance
const SCORE_TOLERANCE = 2;            // ±2 points for AI-generated scores

// --- Main Entry Point ---

export interface ValidationInput {
  assetType: AssetType;
  uwModel: UnderwritingModel | null;
  findings: Finding[];
  criteriaEvaluations: CriteriaEvaluation[];
  creditScore: CreditScore | null;
  bPieceDecision: BPieceDecision | null;
  scoringWeights: Record<FindingCategory, number>;
  extractionResult?: ExtractionResult | null;
}

export function validateAnalysisOutputs(input: ValidationInput): ValidationResult {
  const checks: ValidationCheck[] = [];
  const timestamp = new Date().toISOString();

  console.log('[Validation] Running validation checks...');

  // A) Extraction Completeness (if extraction result available)
  if (input.extractionResult) {
    checks.push(...validateExtractionCompleteness(input.extractionResult));
  }

  // B) Data Consistency
  checks.push(...validateDataConsistency(input.uwModel));

  // C) Rule Application
  checks.push(...validateRuleApplication(input.assetType, input.criteriaEvaluations));

  // D) Score Protection — block scoring if required metrics are missing
  checks.push(...validateScoreProtection(input.uwModel, input.creditScore));

  // E) Score Validation
  checks.push(...validateScore(input.findings, input.creditScore, input.scoringWeights));

  // F) Decision Validation
  checks.push(...validateDecision(input.findings, input.creditScore, input.bPieceDecision));

  // G) Traceability
  checks.push(...validateTraceability(input.uwModel));

  const errors = checks.filter(c => !c.passed);
  const passed = errors.length === 0;

  console.log(`[Validation] Result: ${passed ? 'ALL CHECKS PASSED' : `FAILED — ${errors.length} error(s)`}`);
  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    console.log(`[Validation]   [${status}] ${check.category}: ${check.name} — ${check.details}`);
  }

  return { passed, checks, errors, timestamp };
}

// --- A) Data Consistency ---

function validateDataConsistency(uwModel: UnderwritingModel | null): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  if (!uwModel) {
    checks.push({
      name: 'UW Model Present',
      category: 'data_consistency',
      passed: false,
      details: 'No underwriting model available for validation',
    });
    return checks;
  }

  // Recalculate EGI
  if (uwModel.income) {
    const expectedEGI = calculateEGI(uwModel.income);
    const expectedExpenses = calculateTotalExpenses(uwModel.expenses);
    const expectedNOI = calculateNOI(expectedEGI, expectedExpenses);

    checks.push(metricCheck(
      'NOI Consistency',
      expectedNOI,
      uwModel.netOperatingIncome,
      'NOI must equal EGI minus Total Expenses',
    ));

    // Implied Value
    if (uwModel.capRate > 0) {
      const expectedImpliedValue = calculateImpliedValue(expectedNOI, uwModel.capRate);
      checks.push(metricCheck(
        'Implied Value Consistency',
        expectedImpliedValue,
        uwModel.impliedValue,
        'Implied Value must equal NOI / Cap Rate',
      ));
    }

    // Annual Debt Service & DSCR
    if (uwModel.loanAmount > 0 && uwModel.interestRate > 0) {
      const amortYears = uwModel.loanDetails?.amortizationMonths
        ? uwModel.loanDetails.amortizationMonths / 12
        : uwModel.amortizationYears || 0;

      if (amortYears > 0) {
        const expectedADS = calculateAnnualDebtService(uwModel.loanAmount, uwModel.interestRate, amortYears);
        // expectedADS may be null; metricCheck handles null on either side
        // explicitly (skip-as-not-passed). Only call calculateDSCR with a
        // real number — never pass null into a primitive that expects > 0.
        const expectedDSCR = expectedADS === null ? null : calculateDSCR(expectedNOI, expectedADS);

        checks.push(metricCheck(
          'DSCR Consistency',
          expectedDSCR,
          uwModel.dscr,
          'DSCR must equal NOI / Annual Debt Service',
        ));
      }
    }

    // LTV — only attempt when implied value is computable.
    if (uwModel.impliedValue !== null && uwModel.impliedValue > 0) {
      const expectedLTV = calculateLTV(uwModel.loanAmount, uwModel.impliedValue);
      checks.push(metricCheck(
        'LTV Consistency',
        expectedLTV,
        uwModel.ltv,
        'LTV must equal Loan Amount / Implied Value',
      ));
    }

    // Debt Yield
    if (uwModel.loanAmount > 0) {
      const expectedDebtYield = calculateDebtYield(expectedNOI, uwModel.loanAmount);
      checks.push(metricCheck(
        'Debt Yield Consistency',
        expectedDebtYield,
        uwModel.debtYield,
        'Debt Yield must equal NOI / Loan Amount',
      ));
    }
  } else {
    checks.push({
      name: 'Income Data Present',
      category: 'data_consistency',
      passed: false,
      details: 'UW model is missing income section — cannot validate metrics',
    });
  }

  return checks;
}

// --- B) Rule Application Check ---

function validateRuleApplication(
  assetType: AssetType,
  criteriaEvaluations: CriteriaEvaluation[],
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const criteria = store.getCriteria(assetType);

  if (!criteria) {
    checks.push({
      name: 'Criteria Available',
      category: 'rule_application',
      passed: false,
      details: `No criteria found for asset type: ${assetType}`,
    });
    return checks;
  }

  const enabledRules = criteria.rules.filter(r => r.enabled);
  const evaluatedRuleIds = new Set(criteriaEvaluations.map(e => e.ruleId));
  const missingRules = enabledRules.filter(r => !evaluatedRuleIds.has(r.id));

  checks.push({
    name: 'All Rules Evaluated',
    category: 'rule_application',
    passed: missingRules.length === 0,
    details: missingRules.length === 0
      ? `All ${enabledRules.length} enabled rules have evaluations`
      : `${missingRules.length} rule(s) were not evaluated: ${missingRules.map(r => r.name).join(', ')}`,
    expected: enabledRules.length,
    actual: enabledRules.length - missingRules.length,
  });

  // Check no evaluation references a non-existent rule
  const ruleIds = new Set(criteria.rules.map(r => r.id));
  const orphanEvals = criteriaEvaluations.filter(e => !ruleIds.has(e.ruleId));

  checks.push({
    name: 'No Orphan Evaluations',
    category: 'rule_application',
    passed: orphanEvals.length === 0,
    details: orphanEvals.length === 0
      ? 'All evaluations reference valid criteria rules'
      : `${orphanEvals.length} evaluation(s) reference non-existent rules`,
  });

  return checks;
}

// --- C) Score Validation ---

function validateScore(
  findings: Finding[],
  creditScore: CreditScore | null,
  scoringWeights: Record<FindingCategory, number>,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  if (!creditScore) {
    checks.push({
      name: 'Credit Score Present',
      category: 'score_validation',
      passed: false,
      details: 'No credit score generated',
    });
    return checks;
  }

  // Re-derive score from findings using the shared SSOT engine. Both
  // generateCreditScore (initial scoring) and this validator call the same
  // computeDeterministicScore helper — divergence is now mathematically
  // impossible. The consistency check below remains as a defensive sanity
  // gate that detects upstream regressions.
  const recalc = computeDeterministicScore(findings, scoringWeights);
  const recalcOverall = recalc.overall;
  const recalcCategories = recalc.categories;

  // Compare with tolerance
  const scoreDiff = Math.abs(recalcOverall - creditScore.overall);
  checks.push({
    name: 'Overall Score Consistency',
    category: 'score_validation',
    passed: scoreDiff <= SCORE_TOLERANCE,
    details: scoreDiff <= SCORE_TOLERANCE
      ? `Score ${creditScore.overall} is within ±${SCORE_TOLERANCE} of recalculated ${recalcOverall}`
      : `Score ${creditScore.overall} deviates by ${scoreDiff} from recalculated ${recalcOverall} (tolerance: ±${SCORE_TOLERANCE})`,
    expected: recalcOverall,
    actual: creditScore.overall,
  });

  // Validate risk tier matches score
  const expectedTier = getRiskTier(creditScore.overall);
  checks.push({
    name: 'Risk Tier Matches Score',
    category: 'score_validation',
    passed: creditScore.riskTier === expectedTier,
    details: creditScore.riskTier === expectedTier
      ? `Risk tier "${creditScore.riskTier}" is correct for score ${creditScore.overall}`
      : `Risk tier "${creditScore.riskTier}" should be "${expectedTier}" for score ${creditScore.overall}`,
    expected: expectedTier,
    actual: creditScore.riskTier,
  });

  // Validate score is within valid range
  checks.push({
    name: 'Score Range Valid',
    category: 'score_validation',
    passed: creditScore.overall >= 0 && creditScore.overall <= 100,
    details: `Score ${creditScore.overall} is ${creditScore.overall >= 0 && creditScore.overall <= 100 ? 'within' : 'outside'} valid range [0-100]`,
    expected: '0-100',
    actual: creditScore.overall,
  });

  return checks;
}

// --- D) Decision Validation ---

function validateDecision(
  findings: Finding[],
  creditScore: CreditScore | null,
  bPieceDecision: BPieceDecision | null,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  if (!creditScore) {
    checks.push({
      name: 'Score Available for Decision',
      category: 'decision_validation',
      passed: false,
      details: 'Cannot validate decision without credit score',
    });
    return checks;
  }

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const expectedRecommendation = getRecommendation(creditScore.overall, criticalCount);

  checks.push({
    name: 'Recommendation Matches Score',
    category: 'decision_validation',
    passed: creditScore.recommendation === expectedRecommendation,
    details: creditScore.recommendation === expectedRecommendation
      ? `Recommendation "${creditScore.recommendation}" is consistent with score ${creditScore.overall} and ${criticalCount} critical finding(s)`
      : `Recommendation "${creditScore.recommendation}" should be "${expectedRecommendation}" (score: ${creditScore.overall}, critical: ${criticalCount})`,
    expected: expectedRecommendation,
    actual: creditScore.recommendation,
  });

  // B-piece decision should align with credit score recommendation
  if (bPieceDecision) {
    // Map between recommendation names (b-piece uses same type)
    const scoreRec = creditScore.recommendation;
    const bpRec = bPieceDecision.recommendation;

    // These should be directionally consistent — both approve-ish or both decline-ish
    const isScorePositive = scoreRec === 'approve' || scoreRec === 'approve_with_conditions';
    const isBpPositive = bpRec === 'approve' || bpRec === 'approve_with_conditions';
    const isScoreNegative = scoreRec === 'decline';
    const isBpNegative = bpRec === 'decline';

    const aligned = (isScorePositive && isBpPositive) ||
                    (isScoreNegative && isBpNegative) ||
                    (!isScorePositive && !isScoreNegative); // further_review is flexible

    checks.push({
      name: 'B-Piece Decision Alignment',
      category: 'decision_validation',
      passed: aligned,
      details: aligned
        ? `B-piece decision "${bpRec}" aligns with credit score recommendation "${scoreRec}"`
        : `B-piece decision "${bpRec}" contradicts credit score recommendation "${scoreRec}"`,
      expected: scoreRec,
      actual: bpRec,
    });
  }

  return checks;
}

// --- E) Traceability Check ---

function validateTraceability(uwModel: UnderwritingModel | null): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  if (!uwModel) {
    checks.push({
      name: 'UW Model Available',
      category: 'traceability',
      passed: false,
      details: 'No underwriting model — cannot verify metric traceability',
    });
    return checks;
  }

  const criticalMetrics: { name: string; value: number }[] = [
    { name: 'NOI', value: uwModel.netOperatingIncome },
    { name: 'Loan Amount', value: uwModel.loanAmount },
    { name: 'Cap Rate', value: uwModel.capRate },
    { name: 'Interest Rate', value: uwModel.interestRate },
  ];

  for (const m of criticalMetrics) {
    checks.push({
      name: `${m.name} Traceable`,
      category: 'traceability',
      passed: m.value !== 0 && m.value !== undefined && m.value !== null && !isNaN(m.value),
      details: m.value !== 0 && !isNaN(m.value)
        ? `${m.name} = ${m.value} (non-zero, traceable)`
        : `${m.name} is zero, undefined, or NaN — cannot trace to source data`,
      actual: m.value,
    });
  }

  // Derived metrics: null = not computable from inputs (per validation contract).
  // A null value fails the traceability check explicitly — never coerced to 0.
  const derivedMetrics: { name: string; value: number | null; dependency: string }[] = [
    { name: 'DSCR', value: uwModel.dscr, dependency: 'NOI and debt service' },
    { name: 'LTV', value: uwModel.ltv, dependency: 'loan amount and implied value' },
    { name: 'Debt Yield', value: uwModel.debtYield, dependency: 'NOI and loan amount' },
    { name: 'Implied Value', value: uwModel.impliedValue, dependency: 'NOI and cap rate' },
  ];

  for (const m of derivedMetrics) {
    const isComputable = m.value !== null && !isNaN(m.value) && m.value !== 0;
    checks.push({
      name: `${m.name} Derived`,
      category: 'traceability',
      passed: isComputable,
      details: isComputable
        ? `${m.name} = ${(m.value as number).toFixed(4)} (derived from ${m.dependency})`
        : `${m.name} is null, zero, or NaN — derived metric not computable from ${m.dependency}`,
      actual: m.value ?? 'null',
    });
  }

  return checks;
}

// --- F) Extraction Completeness Check ---

function validateExtractionCompleteness(extraction: ExtractionResult): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  checks.push({
    name: 'All Required Fields Extracted',
    category: 'extraction_completeness',
    passed: extraction.allRequiredPresent,
    details: extraction.allRequiredPresent
      ? `All ${Object.keys(extraction.fields).length} required fields present or derived`
      : `Missing critical inputs: ${extraction.missingFields.join(', ')} — cannot underwrite`,
    expected: 'All fields present',
    actual: extraction.allRequiredPresent ? 'All present' : `Missing: ${extraction.missingFields.join(', ')}`,
  });

  // Flag low-confidence fields
  if (extraction.lowConfidenceFields.length > 0) {
    checks.push({
      name: 'No Low-Confidence Fields',
      category: 'extraction_completeness',
      passed: false,
      details: `Low-confidence fields require review: ${extraction.lowConfidenceFields.join(', ')}`,
      expected: 'No low-confidence fields',
      actual: extraction.lowConfidenceFields.join(', '),
    });
  }

  // Verify traceability: every extracted field must have source info
  for (const [fieldName, field] of Object.entries(extraction.fields)) {
    if (field.value !== null && !field.sourceLocation) {
      checks.push({
        name: `${fieldName} Source Traceable`,
        category: 'extraction_completeness',
        passed: false,
        details: `${fieldName} has a value (${field.value}) but no source location — traceability missing`,
      });
    }
  }

  return checks;
}

// --- Score Protection ---

function validateScoreProtection(
  uwModel: UnderwritingModel | null,
  creditScore: CreditScore | null,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  if (!uwModel) {
    if (creditScore) {
      checks.push({
        name: 'Score Protection — No UW Model',
        category: 'score_validation',
        passed: false,
        details: 'Credit score was generated without an underwriting model — scoring should have been blocked',
      });
    }
    return checks;
  }

  // Required metrics that must be non-zero for scoring to proceed
  const requiredForScoring: { name: string; value: number }[] = [
    { name: 'NOI', value: uwModel.netOperatingIncome },
    { name: 'Loan Amount', value: uwModel.loanAmount },
    { name: 'Cap Rate', value: uwModel.capRate },
    { name: 'Interest Rate', value: uwModel.interestRate },
  ];

  const missingMetrics = requiredForScoring.filter(
    m => m.value === 0 || m.value === undefined || m.value === null || isNaN(m.value)
  );

  if (missingMetrics.length > 0 && creditScore) {
    checks.push({
      name: 'Score Protection — Required Metrics',
      category: 'score_validation',
      passed: false,
      details: `Credit score generated despite missing required metrics: ${missingMetrics.map(m => m.name).join(', ')}. Partial scoring is not permitted.`,
      expected: 'All required metrics non-zero before scoring',
      actual: missingMetrics.map(m => `${m.name}=${m.value}`).join(', '),
    });
  }

  return checks;
}

// --- Helpers ---

function metricCheck(
  name: string,
  expected: number | null,
  actual: number | null,
  description: string,
): ValidationCheck {
  // null on either side = metric not computable. Cannot validate consistency
  // when one of the values doesn't exist. Mark as not-passed with explicit
  // reason — never coerce null to 0 to enable a numeric comparison.
  if (expected === null || actual === null) {
    return {
      name,
      category: 'data_consistency',
      passed: false,
      details: `${description}: not computable (expected=${expected ?? 'null'}, actual=${actual ?? 'null'})`,
      expected: expected ?? 'null',
      actual: actual ?? 'null',
    };
  }
  const absDiff = Math.abs(expected - actual);
  const relativeDiff = expected !== 0 ? absDiff / Math.abs(expected) : (actual === 0 ? 0 : 1);
  const passed = absDiff <= METRIC_TOLERANCE || relativeDiff <= METRIC_PCT_TOLERANCE;

  return {
    name,
    category: 'data_consistency',
    passed,
    details: passed
      ? `${description}: expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (within tolerance)`
      : `${description}: expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (diff: ${absDiff.toFixed(4)}, ${(relativeDiff * 100).toFixed(2)}%)`,
    expected: Number(expected.toFixed(4)),
    actual: Number(actual.toFixed(4)),
  };
}
