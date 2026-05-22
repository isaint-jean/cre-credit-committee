/**
 * EvaluationGroup runner, principle evaluator, and top-level handbook
 * evaluator.
 *
 * The structure mirrors the contract:
 *   - A DeterministicCheck has many EvaluationGroups
 *   - Each EvaluationGroup has a condition and many Bands
 *   - The engine evaluates groups in order; the FIRST group whose condition
 *     matches is the chosen group
 *   - Within that group, bands evaluate in order; the FIRST band whose
 *     operator + threshold returns true is the FIRED band
 *
 * This first-match-wins semantic is critical for the nested-exception
 * pattern (P-IV-RET-5: fortress group first, catch-all group second).
 * Each group's bands are mutually exclusive severity tiers (e.g.,
 * P-IV-SS-2: high-severity > 9 SF/capita; medium-severity 7-9 SF/capita).
 *
 * Message interpolation: flag_message strings can include `{field}`
 * placeholders that resolve against the deal bag at firing time. Missing
 * fields stay as `{field}` literally — the LLM/UI consumer can decide
 * how to handle. We don't substitute "[missing]" or similar because the
 * raw placeholder is more diagnostic.
 */

import type {
  Condition,
  DeterministicCheck,
  ExecutionMode,
  Handbook,
  Principle,
} from '@cre/contracts';
import { evaluateCondition } from './condition.js';
import { evaluateMetric, resolveThreshold } from './metric.js';
import { evaluateOperator } from './operator.js';
import type {
  FieldBag,
  FieldValue,
  FiredFlag,
  HandbookEvaluationResult,
  PrincipleEvaluationResult,
  SkippedPrinciple,
} from './types.js';

const DETERMINISTIC: ExecutionMode = 'DETERMINISTIC';

/**
 * Evaluate a single principle against a deal bag. Returns either a fired
 * flag or a skip with reason.
 *
 * Order of operations:
 *   1. Check trigger — if false, skip with reason 'trigger_inactive'
 *   2. Check executionModes includes DETERMINISTIC — if not, skip
 *   3. Check deterministicCheck is present — if not, skip
 *   4. Evaluate metric — if null and metric kind isn't 'categorical', skip
 *      with reason 'missing_field' (best-effort detail on the path)
 *   5. Walk evaluation groups; for the first group whose condition matches,
 *      walk bands; first band whose operator returns true fires
 *   6. If no group matches, skip 'no_group_matched'
 *   7. If a group matched but no band fired, skip 'no_band_matched'
 */
export function evaluatePrinciple(
  principle: Principle,
  bag: FieldBag,
): PrincipleEvaluationResult {
  // 1. Trigger
  if (!evaluateCondition(principle.trigger, bag)) {
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'trigger_inactive' },
    };
  }

  // 2. Execution mode
  if (!principle.executionModes.includes(DETERMINISTIC)) {
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'not_deterministic' },
    };
  }

  // 3. Check defined
  const check = principle.deterministicCheck;
  if (!check) {
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'no_check_defined' },
    };
  }

  return runDeterministicCheck(principle, check, bag);
}

function runDeterministicCheck(
  principle: Principle,
  check: DeterministicCheck,
  bag: FieldBag,
): PrincipleEvaluationResult {
  // 4. Metric
  const metricValue = evaluateMetric(check.metric, bag);

  // For non-categorical metrics, undefined or null means we couldn't
  // compute it (missing input field). Skip with diagnostic.
  // Simple-metric lookups return undefined for absent fields; computed
  // metrics return null when their formula can't resolve. We treat both
  // as "missing input" — the principle can't be evaluated without data.
  if (
    check.metric.kind !== 'categorical' &&
    (metricValue === null || metricValue === undefined)
  ) {
    return {
      status: 'skipped',
      skip: {
        principleId: principle.id,
        reason: 'missing_field',
        detail: describeMetricSource(check),
      },
    };
  }

  // 5-7. Walk groups
  for (let groupIndex = 0; groupIndex < check.evaluationGroups.length; groupIndex++) {
    const group = check.evaluationGroups[groupIndex]!;
    if (!evaluateCondition(group.condition, bag)) continue;

    // Found the matching group. Now walk bands.
    for (let bandIndex = 0; bandIndex < group.bands.length; bandIndex++) {
      const band = group.bands[bandIndex]!;
      const resolved = resolveThreshold(band.threshold, bag);
      if (resolved.kind === 'unresolvable') {
        // Threshold couldn't be resolved (e.g., field_reference missing).
        // Skip this band; continue to next band — could be the next band's
        // threshold IS resolvable.
        continue;
      }
      if (evaluateOperator(metricValue, band.operator, resolved)) {
        return {
          status: 'fired',
          flag: buildFiredFlag(
            principle,
            band,
            metricValue,
            groupIndex,
            bandIndex,
            bag,
          ),
        };
      }
    }
    // Group matched but no band fired — that's a clean "principle was
    // checked, no flag warranted" result. Skip diagnostic.
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'no_band_matched' },
    };
  }

  // No group's condition matched.
  return {
    status: 'skipped',
    skip: { principleId: principle.id, reason: 'no_group_matched' },
  };
}

function buildFiredFlag(
  principle: Principle,
  band: { flag_message: string; severity: import('@cre/contracts').Severity },
  metricValue: FieldValue,
  groupIndex: number,
  bandIndex: number,
  bag: FieldBag,
): FiredFlag {
  return {
    principleId: principle.id,
    severity: band.severity,
    flag_message: interpolateMessage(band.flag_message, bag),
    metricValue,
    groupIndex,
    bandIndex,
    injectionPoints: principle.injectionPoints,
  };
}

/**
 * Resolve `{field_name}` placeholders in a flag message against the bag.
 * Missing fields stay as `{field_name}` literally so the consumer can see
 * the gap. Arrays and booleans render via String() — good enough for v1;
 * if we need precise number formatting later, add a format-spec syntax.
 */
function interpolateMessage(template: string, bag: FieldBag): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    const v = bag[key as string];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

/**
 * Best-effort description of where a deterministic check sources its
 * metric data. Used as the `detail` string on skipped principles with
 * reason 'missing_field' so consumers know which field to populate.
 */
function describeMetricSource(check: DeterministicCheck): string {
  const metric = check.metric;
  switch (metric.kind) {
    case 'simple':
      return `metric field '${metric.path}'`;
    case 'computed':
      return `computed metric (formula references: ${collectFormulaFields(metric.formula).join(', ') || 'none'})`;
    case 'categorical':
      return 'categorical (no metric source)';
  }
}

function collectFormulaFields(
  formula: import('@cre/contracts').FormulaNode,
): string[] {
  const out: string[] = [];
  walkFormula(formula, (node) => {
    if (node.kind === 'field') out.push(node.path);
  });
  return out;
}

function walkFormula(
  formula: import('@cre/contracts').FormulaNode,
  visit: (node: import('@cre/contracts').FormulaNode) => void,
): void {
  visit(formula);
  if (formula.kind === 'op') {
    for (const sub of formula.operands) walkFormula(sub, visit);
  }
}

// =============================================================================
// Top-level: evaluate the whole handbook
// =============================================================================

/**
 * Evaluate every principle in the handbook against a deal bag. Returns the
 * full list of fired flags plus diagnostic information for skipped
 * principles.
 *
 * Iteration order: handbook.principles array order. Engine does not sort
 * or group results — the api layer handles presentation (e.g., grouping
 * by severity, by injection point, or by cluster).
 *
 * The engine ignores principles whose `executionModes` doesn't include
 * DETERMINISTIC (recorded as skipped, reason 'not_deterministic') — those
 * principles are handled by the LLM_CONTEXT or RESEARCH execution paths,
 * which are a different layer.
 */
export function evaluateHandbook(
  handbook: Handbook,
  bag: FieldBag,
): HandbookEvaluationResult {
  const firedFlags: FiredFlag[] = [];
  const skippedPrinciples: SkippedPrinciple[] = [];

  for (const principle of handbook.principles) {
    const result = evaluatePrinciple(principle, bag);
    if (result.status === 'fired') {
      firedFlags.push(result.flag);
    } else {
      skippedPrinciples.push(result.skip);
    }
  }

  return { firedFlags, skippedPrinciples };
}
