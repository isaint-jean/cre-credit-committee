/**
 * applyRevisionDelta — non-root revision creation (Option C / issue #20, step 8.5).
 *
 * Given a parent revision and a delta (currently only 'adjusted-input-overrides'), produces a
 * child revision in the lineage:
 *
 *   1. Validates parent envelope exists and is the latest in its lineage (linear-chain rule,
 *      spec §7 pre-6.3 lock).
 *   2. Loads parent AdjustedInputs and the dependency context (asset profile, library snapshot,
 *      narrative facts) reachable via FK from the parent's DoctrineEvaluation.
 *   3. Validates every override path against the v1 editable whitelist.
 *   4. Applies overrides to a deep-cloned parent body and runs `recomputeDerivedFields` to
 *      maintain internal consistency between line items and rollups/metrics.
 *   5. Computes the child AdjustedInputsId and runs the shared `evaluateFromAdjustedInputs`
 *      tail (persists AI + CC + SO + VC + DE in dependency order).
 *   6. Computes the child RevisionId, builds and persists the envelope + provenance.
 *
 * The recompute step is non-conservative by design (v1 / β.1): it does NOT replay the engine's
 * expense-ratio floor or NOI cap. An analyst override is treated as an explicit opt-out of
 * those conservatism transforms; downstream cross-check / doctrine still run on the child and
 * surface findings if the new numbers violate those gates. See Finding 2 of the design recon
 * for the full rationale.
 *
 * Determinism: identical args produce identical childRevisionId. ON CONFLICT DO NOTHING on
 * every insert (AdjustedInputs, CC, SO, VC, DE, envelope, provenance) makes the service
 * idempotent at the storage layer — a second call returns the same triple as the first.
 */

import type {
  AdjustedInputs,
  AdjustedInputsDiff,
  AdjustedInputsFieldDiff,
  AdjustedInputsId,
  AdjustedMetrics,
  AssetProfile,
  DoctrineEvaluation,
  LibrarySnapshot,
  NarrativeFacts,
  RevisionId,
  RevisionLineageEnvelope,
  RevisionProvenance,
  RevisionTrigger,
} from '@cre/contracts';
import { DOCTRINE_VERSION } from '@cre/contracts';
import {
  computeAdjustedInputsId,
  computeRevisionId,
} from '../util/content-hash.js';
import { evaluateFromAdjustedInputs } from './evaluate-from-adjusted-inputs.js';
import { annualDebtService, maturityBalance } from './judgment/amortization.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';

/* ---------------------------------- errors --------------------------------- */

export class ParentRevisionNotFoundError extends Error {
  override readonly name = 'ParentRevisionNotFoundError';
  constructor(public readonly parentRevisionId: string) {
    super(`Parent revision not found: ${parentRevisionId}`);
  }
}

export class NotLatestRevisionError extends Error {
  override readonly name = 'NotLatestRevisionError';
  constructor(
    public readonly requestedParentRevisionId: string,
    public readonly currentLatestRevisionId: string,
  ) {
    super(
      `Parent ${requestedParentRevisionId} is not the latest revision in its lineage ` +
        `(latest is ${currentLatestRevisionId}). v1 enforces linear chains; re-fetch and retry.`,
    );
  }
}

export type InvalidDeltaErrorCode =
  | 'NON_EDITABLE_PATH'
  | 'PATH_NOT_FOUND_ON_PARENT'
  | 'BAD_VALUE_TYPE'
  | 'VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE';

export class InvalidDeltaError extends Error {
  override readonly name = 'InvalidDeltaError';
  constructor(
    public readonly code: InvalidDeltaErrorCode,
    public readonly path: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(`[${code}] path=${path}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  }
}

export class LineageCorruptionError extends Error {
  override readonly name = 'LineageCorruptionError';
  constructor(
    public readonly revisionId: string,
    public readonly missing: string,
  ) {
    super(`Lineage corrupted at ${revisionId}: ${missing} unreachable via FK`);
  }
}

/* ---------------------------------- delta ---------------------------------- */

export interface OverrideOp {
  readonly path: string;
  readonly value: number;
}

export type RevisionDelta =
  | { readonly kind: 'adjusted-input-overrides'; readonly overrides: ReadonlyArray<OverrideOp> };

/* -------------------------------- args/result ------------------------------ */

export interface ApplyRevisionDeltaArgs {
  readonly parentRevisionId: RevisionId;
  readonly delta: RevisionDelta;
  readonly triggerSource: RevisionTrigger;
  readonly adjustmentOrigin?: ReadonlyArray<string>;
}

export interface ApplyRevisionDeltaResult {
  readonly envelope: RevisionLineageEnvelope;
  readonly provenance: RevisionProvenance;
  readonly evaluation: DoctrineEvaluation;
}

/* ------------------------------- editable set ------------------------------ */

const EDITABLE_PATHS: ReadonlySet<string> = new Set([
  'income.grossRentalIncome.adjusted',
  'income.otherIncome.adjusted',
  'income.vacancyPct.adjusted',
  'income.concessionsPct.adjusted',
  'expenses.realEstateTaxes.adjusted',
  'expenses.insurance.adjusted',
  'expenses.utilities.adjusted',
  'expenses.managementFee.adjusted',
  'expenses.payroll.adjusted',
  'expenses.maintenance.adjusted',
  'expenses.other.adjusted',
  'loan.loanAmount.adjusted',
  'loan.interestRate.adjusted',
  'loan.termMonths.adjusted',
  'loan.amortizationMonths.adjusted',
  'loan.ioPeriodMonths.adjusted',
  'assumptions.capRate.adjusted',
  'assumptions.terminalCapRate.adjusted',
  'assumptions.rentGrowthPct.adjusted',
  'assumptions.expenseGrowthPct.adjusted',
]);

export function isEditablePath(path: string): boolean {
  return EDITABLE_PATHS.has(path);
}

/* -------------------------------- path utils ------------------------------- */

/** Read the leaf value at a dotted path. Returns `undefined` if any intermediate is missing. */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const key of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** Returns a deep-cloned object with the leaf at `path` set to `value`. Caller is responsible
 *  for ensuring the path is valid; this helper does not validate against a schema. */
function applyOverride<T extends object>(obj: T, path: string, value: unknown): T {
  const cloned = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  const parts = path.split('.');
  const leaf = parts.pop();
  if (leaf === undefined) return cloned as unknown as T;
  let cursor: Record<string, unknown> = cloned;
  for (const key of parts) {
    const next = cursor[key];
    if (next === null || next === undefined || typeof next !== 'object') {
      throw new InvalidDeltaError('PATH_NOT_FOUND_ON_PARENT', path);
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[leaf] = value;
  return cloned as unknown as T;
}

/* ----------------------------- recompute helper ---------------------------- */

/**
 * Recomputes derived fields on a post-override AdjustedInputs body:
 *   - income.effectiveGrossIncome.adjusted     (engine formula)
 *   - expenses.totalOperatingExpenses.adjusted (sum of 7 sub-lines)
 *   - loan.debtServiceAnnual.adjusted          (annualDebtService helper)
 *   - loan.maturityBalance.adjusted            (maturityBalance helper)
 *   - metrics.{noi, value, dscr, ltvAppraisal, debtYield, expenseRatio}
 *
 * Carries over from parent unchanged:
 *   - metrics.top1IncomeShare, metrics.pctIncomeExpiringWithinTerm (rent-roll-derived)
 *   - All line-item .raw, .source, .adjustments fields (audit trail lives in RevisionProvenance)
 *
 * Does NOT replay conservatism floors/caps — see service header. Throws
 * `InvalidDeltaError('VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE', ...)` if the post-override vacancy +
 * concessions composite is outside [0, 1], mirroring the engine's `JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE`.
 */
export function recomputeDerivedFields(
  body: Omit<AdjustedInputs, 'id'>,
  narrativeFacts: NarrativeFacts,
): Omit<AdjustedInputs, 'id'> {
  const gri = body.income.grossRentalIncome.adjusted;
  const otherIncome = body.income.otherIncome.adjusted;
  const vacancy = body.income.vacancyPct.adjusted;
  const concessions = body.income.concessionsPct.adjusted;
  const lossFactor = vacancy + concessions;
  if (lossFactor < 0 || lossFactor > 1) {
    throw new InvalidDeltaError('VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE', 'income.vacancyPct.adjusted', {
      vacancy,
      concessions,
      sum: lossFactor,
    });
  }
  const egi = (gri + otherIncome) * (1 - lossFactor);

  const e = body.expenses;
  const totalOpEx =
    e.realEstateTaxes.adjusted +
    e.insurance.adjusted +
    e.utilities.adjusted +
    e.managementFee.adjusted +
    e.payroll.adjusted +
    e.maintenance.adjusted +
    e.other.adjusted;

  const loanAmount = body.loan.loanAmount.adjusted;
  const interestRate = body.loan.interestRate.adjusted;
  const amortizationMonths = body.loan.amortizationMonths.adjusted;
  const termMonths = body.loan.termMonths.adjusted;
  const debtService = annualDebtService({ loanAmount, interestRate, amortizationMonths });
  const matBalance = maturityBalance({ loanAmount, interestRate, amortizationMonths, termMonths });

  const capRate = body.assumptions.capRate.adjusted;
  const noi = egi - totalOpEx;
  const value = capRate > 0 ? noi / capRate : null;
  const dscr = debtService > 0 ? noi / debtService : null;
  const debtYield = loanAmount > 0 ? noi / loanAmount : null;
  const expenseRatio = egi > 0 ? totalOpEx / egi : null;
  const appraisalValue = narrativeFacts.appraisalValue;
  const ltvAppraisal =
    appraisalValue !== null && appraisalValue > 0 ? loanAmount / appraisalValue : null;

  const newMetrics: AdjustedMetrics = {
    noi,
    value,
    dscr,
    ltvAppraisal,
    debtYield,
    expenseRatio,
    top1IncomeShare: body.metrics.top1IncomeShare,
    pctIncomeExpiringWithinTerm: body.metrics.pctIncomeExpiringWithinTerm,
  };

  return {
    ...body,
    income: {
      ...body.income,
      effectiveGrossIncome: { ...body.income.effectiveGrossIncome, adjusted: egi },
    },
    expenses: {
      ...body.expenses,
      totalOperatingExpenses: { ...body.expenses.totalOperatingExpenses, adjusted: totalOpEx },
    },
    loan: {
      ...body.loan,
      debtServiceAnnual: { ...body.loan.debtServiceAnnual, adjusted: debtService },
      maturityBalance: { ...body.loan.maturityBalance, adjusted: matBalance },
    },
    metrics: newMetrics,
  };
}

/* --------------------------- structural diff ------------------------------- */

/**
 * Recursive structural diff between two AdjustedInputs. Emits one
 * `AdjustedInputsFieldDiff` per scalar leaf where `before !== after` (strict equality on
 * primitives; objects are recursed into). All emitted changes use `changeType: 'modified'`
 * since the AdjustedInputs schema is structurally fixed — no fields are added or removed
 * by the v1 delta surface.
 */
export function diffAdjustedInputs(before: AdjustedInputs, after: AdjustedInputs): AdjustedInputsDiff {
  const changedFields: AdjustedInputsFieldDiff[] = [];
  walk('', before as unknown, after as unknown, changedFields);
  return { changedFields };
}

function walk(
  path: string,
  before: unknown,
  after: unknown,
  out: AdjustedInputsFieldDiff[],
): void {
  if (before === after) return;
  const beforeIsObject = before !== null && typeof before === 'object' && !Array.isArray(before);
  const afterIsObject = after !== null && typeof after === 'object' && !Array.isArray(after);
  if (beforeIsObject && afterIsObject) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`;
      walk(
        childPath,
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        out,
      );
    }
    return;
  }
  // Either both arrays, or scalar vs scalar, or shape mismatch. For v1 we only diff
  // scalar leaves and treat any shape mismatch / array change at this path as a single
  // modification entry.
  out.push({ path, before, after, changeType: 'modified' });
}

/* ---------------------------------- service -------------------------------- */

export function applyRevisionDelta(
  args: ApplyRevisionDeltaArgs,
  store: RecordGraphStore,
): ApplyRevisionDeltaResult {
  // a. Load parent envelope.
  const parentEnvelope = store.getRevisionEnvelope(args.parentRevisionId);
  if (parentEnvelope === null) {
    throw new ParentRevisionNotFoundError(args.parentRevisionId);
  }

  // b. Hydrate dependency context.
  const parentAdjustedInputs = store.getAdjustedInputs(parentEnvelope.adjustedInputsId);
  if (parentAdjustedInputs === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'AdjustedInputs');
  }
  const parentDoctrine = store.getDoctrineEvaluation(parentEnvelope.doctrineEvaluationId);
  if (parentDoctrine === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'DoctrineEvaluation');
  }
  const librarySnapshot = store.getLibrarySnapshot(parentDoctrine.librarySnapshotId);
  if (librarySnapshot === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'LibrarySnapshot');
  }
  const narrativeFacts = store.getNarrativeFacts(parentDoctrine.narrativeFactsId);
  if (narrativeFacts === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'NarrativeFacts');
  }
  const assetProfile = store.getAssetProfile(parentDoctrine.assetProfileId);
  if (assetProfile === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'AssetProfile');
  }

  // c. Validate every override path before mutating anything.
  for (const op of args.delta.overrides) {
    if (!isEditablePath(op.path)) {
      throw new InvalidDeltaError('NON_EDITABLE_PATH', op.path);
    }
    if (typeof op.value !== 'number' || !Number.isFinite(op.value)) {
      throw new InvalidDeltaError('BAD_VALUE_TYPE', op.path, { value: op.value });
    }
    if (getByPath(parentAdjustedInputs, op.path) === undefined) {
      throw new InvalidDeltaError('PATH_NOT_FOUND_ON_PARENT', op.path);
    }
  }

  // d. Apply overrides to a clone, then recompute derived fields.
  const { id: _id, ...parentBody } = parentAdjustedInputs;
  let childBody: Omit<AdjustedInputs, 'id'> = parentBody;
  for (const op of args.delta.overrides) {
    childBody = applyOverride(childBody, op.path, op.value);
  }
  childBody = recomputeDerivedFields(childBody, narrativeFacts);

  // e. Compute child AdjustedInputs id and the would-be childRevisionId.
  //    `doctrineVersion` is a build-time constant (DOCTRINE_VERSION); the evaluator stamps the
  //    same value on the resulting DoctrineEvaluation, so using the constant here is identical
  //    to using the evaluation's stamped version. This lets us check for an existing identical
  //    revision BEFORE running the heavy pipeline tail.
  const childAdjustedInputsId = computeAdjustedInputsId(childBody) as AdjustedInputsId;
  const childRevisionId = computeRevisionId({
    parentRevisionId: args.parentRevisionId,
    adjustedInputsId: childAdjustedInputsId,
    doctrineVersion: DOCTRINE_VERSION,
  });

  // f. Idempotency short-circuit. If a revision with this id already exists in the lineage,
  //    return it as-is — same args produce the same triple, and a duplicate write is a no-op.
  //    This must run BEFORE the linear-chain guard: an idempotent re-call of an earlier delta
  //    is legitimate even when the current latest is now downstream of the requested parent.
  const existingEnvelope = store.getRevisionEnvelope(childRevisionId);
  if (existingEnvelope !== null) {
    const existingProvenance = store.getRevisionProvenance(childRevisionId);
    const existingEvaluation = store.getDoctrineEvaluation(existingEnvelope.doctrineEvaluationId);
    if (existingProvenance === null || existingEvaluation === null) {
      throw new LineageCorruptionError(childRevisionId, 'provenance or evaluation');
    }
    return { envelope: existingEnvelope, provenance: existingProvenance, evaluation: existingEvaluation };
  }

  // g. Linear-chain guard (only when we're about to create a NEW envelope).
  const latest = store.getLatestRevisionByLineageRoot(parentEnvelope.lineageRootId);
  if (latest === null) {
    throw new LineageCorruptionError(args.parentRevisionId, 'lineage root has no latest envelope');
  }
  if (latest.revisionId !== args.parentRevisionId) {
    throw new NotLatestRevisionError(args.parentRevisionId, latest.revisionId);
  }

  // h. Construct child AdjustedInputs record.
  const childAdjustedInputs: AdjustedInputs = {
    id: childAdjustedInputsId,
    ...childBody,
  };

  // i. Drive the shared pipeline tail (persists AI + CC + SO + VC + DE).
  const { evaluation } = evaluateFromAdjustedInputs(
    {
      adjustedInputs: childAdjustedInputs,
      assetProfile,
      librarySnapshot,
      narrativeFacts,
      extractionResultId: parentDoctrine.extractionResultId,
      analysisAsOfDate: parentAdjustedInputs.analysisAsOfDate,
    },
    store,
  );
  const envelope: RevisionLineageEnvelope = {
    revisionId: childRevisionId,
    lineageRootId: parentEnvelope.lineageRootId,
    parentRevisionId: args.parentRevisionId,
    revisionOrdinal: parentEnvelope.revisionOrdinal + 1,
    doctrineEvaluationId: evaluation.id,
    adjustedInputsId: childAdjustedInputsId,
    doctrineVersion: evaluation.doctrineVersion,
    judgmentEngineVersion: evaluation.judgmentEngineVersion,
    stressEngineVersion: evaluation.stressEngineVersion,
    valuationEngineVersion: evaluation.valuationEngineVersion,
  };
  store.insertRevisionLineageEnvelope(envelope);

  // i. Structural diff for provenance.
  const inputDiff = diffAdjustedInputs(parentAdjustedInputs, childAdjustedInputs);

  // j. Provenance.
  const provenance: RevisionProvenance = {
    revisionId: childRevisionId,
    inputDiff,
    triggerSource: args.triggerSource,
    appliedRuleIds: [],
    adjustmentOrigin: args.adjustmentOrigin ?? [],
    beforeHash: parentAdjustedInputs.id,
    afterHash: childAdjustedInputsId,
  };
  store.insertRevisionProvenance(provenance);

  return { envelope, provenance, evaluation };
}
