// OverlayActionPanel (Phase 4 - OVERRIDE_DECISION surface).
//
// Single-purpose panel: triggers OVERRIDE_DECISION via the dedicated client method.
// Mounted ONLY by the overlay-scoped route page; the deal-level dashboard never
// renders this component.
//
// DISCIPLINE:
//   - Submits via api.submitOverrideDecision; client never constructs payload.
//   - Disabled when workflow.state is APPROVED or REJECTED (terminal states).
//     This is NOT business inference; it consumes the server-projected state
//     verbatim and a server-provided list of terminal states.
//   - No summary field, no rationale field, no overlay editor here. The override
//     is a committee-level audit event; overlay patches themselves are managed
//     elsewhere.

'use client';

import React, { useState } from 'react';
import type {
  DealState,
  DealWorkflowState,
  DoctrineEvaluationId,
  OverlayId,
  RenderedAnalysisId,
} from '@cre/contracts';
import { api } from '@/lib/api-client';

interface Props {
  readonly rootId: DoctrineEvaluationId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly overlayId: OverlayId;
  readonly workflow: DealWorkflowState;
  readonly onSubmitted: () => void;
}

const TERMINAL_STATES: ReadonlySet<DealState> = new Set<DealState>(['APPROVED', 'REJECTED']);

export function OverlayActionPanel({
  rootId,
  renderedAnalysisId,
  overlayId,
  workflow,
  onSubmitted,
}: Props): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isTerminal = TERMINAL_STATES.has(workflow.state);
  const disabled = pending || isTerminal;

  async function trigger(): Promise<void> {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await api.submitOverrideDecision({ rootId, renderedAnalysisId, overlayId });
      onSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 border border-gray-200 rounded p-4 bg-white">
      <div className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
          Overlay Action
        </h2>
        <span className="text-xs font-mono text-gray-500">overlay: {overlayId}</span>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          disabled={disabled}
          onClick={() => { void trigger(); }}
          className={
            'px-3 py-1.5 text-sm rounded transition ' +
            (disabled
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-amber-600 hover:bg-amber-700 text-white')
          }
        >
          {pending ? '...' : 'Submit Override Decision'}
        </button>
        {isTerminal ? (
          <span className="text-xs text-gray-500">
            Disabled: workflow is {workflow.state}.
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p className="text-xs text-red-700 font-mono">{error}</p>
      ) : null}
    </section>
  );
}
