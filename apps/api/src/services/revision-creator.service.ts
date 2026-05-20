/**
 * Revision creator (Batch 6.3) — dumb constructor of lineage events.
 *
 * Per the user's explicit constraint for 6.3: "Route handlers are now dumb constructors of
 * lineage events, not decision-makers." This service mirrors that role on the legacy path:
 * it applies a caller-provided delta to a parent analysis and produces a NEW immutable
 * analysis row with lineage pointers set. It does NOT decide what counts as a delta, what
 * counts as a valid revision, or whether the revision should be created.
 *
 * Spec compliance (`docs/architecture/revision-lineage-spec.md`):
 *   - L1 Append-only: returns a new Analysis row; never mutates the parent.
 *   - L2 parentAnalysisId fixed at creation; never re-assigned.
 *   - L3 lineageRootId carried through unchanged.
 *   - L4 Determinism: legacy uuids are non-deterministic by design (5.1 strict-dispatch);
 *     determinism on the new-spine path lands in 6.4 with content-hash ids.
 *   - L5 No timestamps in identity (legacy id is uuid, not hash, so trivially holds).
 *   - L6 No iteration-order leaks (no canonicalization needed on legacy; new-spine ships in 6.4).
 *
 * Two delta shapes are supported, matching the previously-existing PATCH endpoints:
 *   - UwModel cell edits — `{ updates: [{ path, value }] }`
 *   - Loan-term edits — typed object of optional loan-term fields
 *
 * Both shapes are applied through the existing legacy recalculation pipeline
 * (`recalculateFullModel`) — that pipeline owns the underwriting logic; this service merely
 * threads a parent through it and stamps lineage onto the result.
 */

import { v4 as uuid } from 'uuid';
import type { Analysis, UnderwritingModel } from '@cre/shared';
import { recalculateFullModel } from '@cre/shared';
import { getNestedValue, setNestedValue } from '../util/object-path.js';

/* --------------------------------- delta shapes --------------------------- */

export interface UwModelCellUpdate {
  readonly path: string;
  readonly value: number;
}

export interface UwModelCellsDelta {
  readonly type: 'uw-model-cells';
  readonly updates: readonly UwModelCellUpdate[];
}

export interface LoanTermsDelta {
  readonly type: 'loan-terms';
  readonly updates: {
    readonly interestRate?: number;
    readonly ioMonths?: number;
    readonly amortizationMonths?: number;
    readonly termMonths?: number;
    readonly rateType?: 'fixed' | 'floating';
    readonly paymentFrequency?: 'monthly' | 'quarterly';
    readonly prepaymentTerms?: string;
    readonly loanAmount?: number;
  };
}

export type RevisionDelta = UwModelCellsDelta | LoanTermsDelta;

/* ------------------------------- model mutators --------------------------- */

function applyCellUpdates(model: UnderwritingModel, updates: readonly UwModelCellUpdate[]): UnderwritingModel {
  // Deep-clone so we never mutate the parent's model.
  const next = JSON.parse(JSON.stringify(model)) as UnderwritingModel & { modifiedCells?: string[] };
  for (const u of updates) {
    setNestedValue(next, u.path, u.value);
    // Mark as overridden if it's a line item.
    const parts = u.path.split('.');
    if (parts.length >= 2) {
      const overriddenPath = parts.slice(0, -1).join('.') + '.isOverridden';
      try { setNestedValue(next, overriddenPath, true); } catch { /* not all paths support this */ }
    }
    if (next.modifiedCells && !next.modifiedCells.includes(u.path)) {
      next.modifiedCells.push(u.path);
    }
  }
  next.asReported = false;
  return recalculateFullModel(next);
}

function applyLoanTermUpdates(model: UnderwritingModel, updates: LoanTermsDelta['updates']): UnderwritingModel {
  const next = JSON.parse(JSON.stringify(model)) as UnderwritingModel;
  if (updates.interestRate !== undefined) {
    next.interestRate = updates.interestRate;
    next.loanDetails.interestRate = updates.interestRate;
  }
  if (updates.loanAmount !== undefined) {
    next.loanAmount = updates.loanAmount;
    next.loanDetails.loanAmount = updates.loanAmount;
  }
  if (updates.ioMonths !== undefined) next.loanDetails.ioMonths = updates.ioMonths;
  if (updates.amortizationMonths !== undefined) {
    next.loanDetails.amortizationMonths = updates.amortizationMonths;
    next.amortizationYears = updates.amortizationMonths / 12;
  }
  if (updates.termMonths !== undefined) {
    next.loanDetails.termMonths = updates.termMonths;
    next.termYears = updates.termMonths / 12;
  }
  if (updates.rateType !== undefined) next.loanDetails.rateType = updates.rateType;
  if (updates.paymentFrequency !== undefined) next.loanDetails.paymentFrequency = updates.paymentFrequency;
  if (updates.prepaymentTerms !== undefined) next.loanDetails.prepaymentTerms = updates.prepaymentTerms;
  next.asReported = false;
  return recalculateFullModel(next);
}

/* --------------------------- revision construction ------------------------ */

export interface RevisionInputs {
  readonly parent: Analysis;
  readonly delta: RevisionDelta;
  /** Optional override for the new revision name. Defaults to the parent's name. */
  readonly name?: string;
}

/**
 * Compute the new revision's `Analysis` row from a parent + a delta. Pure: does not write
 * to storage. The route handler is responsible for persisting the returned row.
 *
 * Lineage stamping (immutable, set once):
 *   - id            — fresh uuid (legacy convention)
 *   - parentAnalysisId — parent.id
 *   - lineageRootId — parent.lineageRootId ?? parent.id (root case)
 *   - revisionOrdinal — parent.revisionOrdinal + 1
 */
export function createRevision(args: RevisionInputs): Analysis {
  const { parent, delta } = args;
  if (!parent.uwModel) {
    throw new Error('REVISION_CREATE_PRECONDITION: parent has no uwModel; cannot derive revision.');
  }

  let nextModel: UnderwritingModel;
  if (delta.type === 'uw-model-cells') {
    nextModel = applyCellUpdates(parent.uwModel, delta.updates);
  } else if (delta.type === 'loan-terms') {
    nextModel = applyLoanTermUpdates(parent.uwModel, delta.updates);
  } else {
    // exhaustive switch — unreachable
    const _: never = delta;
    throw new Error(`REVISION_CREATE_UNKNOWN_DELTA_TYPE: ${JSON.stringify(_)}`);
  }

  const now = new Date().toISOString();
  const newId = uuid();
  const lineageRootId = parent.lineageRootId ?? parent.id;
  const parentOrdinal = parent.revisionOrdinal ?? 0;

  return {
    ...parent,
    id: newId,
    parentAnalysisId: parent.id,
    lineageRootId,
    revisionOrdinal: parentOrdinal + 1,
    name: args.name ?? parent.name,
    uwModel: nextModel,
    // Lineage events reset volatile fields. Stress scenarios from the parent are not carried
    // into the child — they are scenario-against-parent-state, not against the new state.
    // Re-running stress against the new state happens via POST /:id/stress-test on the child.
    stressScenarios: [],
    createdAt: now,
    updatedAt: now,
  };
}
