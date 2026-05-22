/**
 * Handbook lint pass.
 *
 * Walks the handbook and collects every field path reference (in
 * Principle.trigger, DeterministicCheck.metric, DeterministicCheck
 * evaluationGroups → condition and bands → threshold). Returns the set
 * of distinct paths found.
 *
 * Pair with a known-fields registry to detect typos in handbook authoring:
 *   const referenced = collectReferencedFields(handbook);
 *   const unknown = referenced.filter(p => !KNOWN_FIELDS.has(p));
 *   // unknown ⇒ either typo or new field that needs to be added to bag assembler
 *
 * The lint pass is the engineering safety net for design choice B2 (untyped
 * field bag): we can't get compile-time guarantees from TS that
 * handbook.principles[0].deterministicCheck.metric.path is a real Deal
 * field, but we CAN get a build-time guarantee by running this lint pass
 * against a curated registry of known fields.
 */

import type {
  Condition,
  DeterministicCheck,
  FormulaNode,
  Handbook,
  Principle,
  ThresholdValue,
} from '@cre/contracts';

/**
 * Collect every field path referenced anywhere in the handbook.
 *
 * Walks: each principle's trigger, deterministicCheck (metric +
 * evaluationGroups condition + bands threshold). Does NOT walk:
 * researchActions (those are LLM-consumed prose, not engine-evaluated)
 * or flag_message templates (interpolation tolerates missing fields).
 */
export function collectReferencedFields(handbook: Handbook): string[] {
  const fields = new Set<string>();

  for (const principle of handbook.principles) {
    collectFromCondition(principle.trigger, fields);
    if (principle.deterministicCheck) {
      collectFromCheck(principle.deterministicCheck, fields);
    }
  }

  return Array.from(fields).sort();
}

function collectFromCondition(condition: Condition, fields: Set<string>): void {
  switch (condition.kind) {
    case 'always':
      return;
    case 'field_equals':
    case 'field_in':
    case 'field_gte':
    case 'field_gt':
    case 'field_lte':
    case 'field_lt':
    case 'field_exists':
    case 'field_truthy':
      fields.add(condition.field);
      return;
    case 'all_of':
    case 'any_of':
      for (const sub of condition.conditions) {
        collectFromCondition(sub, fields);
      }
      return;
    case 'not':
      collectFromCondition(condition.condition, fields);
      return;
  }
}

function collectFromCheck(
  check: DeterministicCheck,
  fields: Set<string>,
): void {
  // Metric
  switch (check.metric.kind) {
    case 'simple':
      fields.add(check.metric.path);
      break;
    case 'computed':
      collectFromFormula(check.metric.formula, fields);
      break;
    case 'categorical':
      break;
  }
  // Evaluation groups
  for (const group of check.evaluationGroups) {
    collectFromCondition(group.condition, fields);
    for (const band of group.bands) {
      collectFromThreshold(band.threshold, fields);
    }
  }
}

function collectFromFormula(
  formula: FormulaNode,
  fields: Set<string>,
): void {
  if (formula.kind === 'field') {
    fields.add(formula.path);
  } else if (formula.kind === 'op') {
    for (const operand of formula.operands) {
      collectFromFormula(operand, fields);
    }
  }
}

function collectFromThreshold(
  threshold: ThresholdValue,
  fields: Set<string>,
): void {
  if (threshold.kind === 'field_reference') {
    fields.add(threshold.path);
  }
}

// =============================================================================
// Lint report
// =============================================================================

/**
 * Run a full lint pass. Given a known-fields registry, returns three
 * disjoint sets:
 *   - referenced AND known: in good shape
 *   - referenced AND NOT known: likely typos or new fields that need
 *     to be added to the bag assembler. Build should fail on these.
 *   - known AND NOT referenced: orphan fields in the registry —
 *     either dead code or principles haven't yet been added that
 *     reference them. Build can warn but not fail.
 */
export interface LintReport {
  referencedAndKnown: string[];
  referencedButUnknown: string[];
  knownButUnreferenced: string[];
}

export function lintHandbook(
  handbook: Handbook,
  knownFields: ReadonlySet<string>,
): LintReport {
  const referenced = new Set(collectReferencedFields(handbook));
  const referencedAndKnown: string[] = [];
  const referencedButUnknown: string[] = [];
  for (const f of referenced) {
    if (knownFields.has(f)) referencedAndKnown.push(f);
    else referencedButUnknown.push(f);
  }
  const knownButUnreferenced: string[] = [];
  for (const f of knownFields) {
    if (!referenced.has(f)) knownButUnreferenced.push(f);
  }
  return {
    referencedAndKnown: referencedAndKnown.sort(),
    referencedButUnknown: referencedButUnknown.sort(),
    knownButUnreferenced: knownButUnreferenced.sort(),
  };
}

// Helper: assert no unknown references. Throws with a descriptive error
// listing the offending paths. Intended use: in a build-time test that
// fails CI if any handbook references an unknown field.
export function assertNoUnknownFields(
  handbook: Handbook,
  knownFields: ReadonlySet<string>,
): void {
  const report = lintHandbook(handbook, knownFields);
  if (report.referencedButUnknown.length > 0) {
    throw new Error(
      `Handbook references ${report.referencedButUnknown.length} field path(s) not in the known-fields registry:\n  ` +
        report.referencedButUnknown.map((f) => `'${f}'`).join('\n  ') +
        `\nFix by either (a) correcting typos in the handbook, or (b) adding the field to the registry's bag assembler.`,
    );
  }
}

// Helper for unit tests: list all DETERMINISTIC-mode principles, with
// their referenced fields. Useful for "show me what data each principle
// needs" diagnostic queries.
export function principleFieldDependencies(
  handbook: Handbook,
): ReadonlyArray<{ principleId: string; fields: string[] }> {
  const out: { principleId: string; fields: string[] }[] = [];
  for (const principle of handbook.principles) {
    if (!principle.executionModes.includes('DETERMINISTIC')) continue;
    const fields = new Set<string>();
    collectFromCondition(principle.trigger, fields);
    if (principle.deterministicCheck) {
      collectFromCheck(principle.deterministicCheck, fields);
    }
    out.push({
      principleId: principle.id,
      fields: Array.from(fields).sort(),
    });
  }
  return out;
}
