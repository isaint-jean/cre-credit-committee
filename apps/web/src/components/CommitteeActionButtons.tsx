// CommitteeActionButtons (Phase 4 - operational workflow UX).
//
// Display-only buttons that submit committee actions to the API. EVERY click
// is a thin POST /committee-actions call followed by a workflow refresh. The
// UI does NOT decide whether a button is allowed - the server's permission
// matrix + state projection is the truth source. If the click is denied, the
// server returns 401/403/400 and we surface the error message verbatim.
//
// DISCIPLINE (mirrors consumer-migration v1):
//   - No business logic. No state machine. No "allowed transitions" table.
//   - The button list is the full COMMITTEE_ACTION_KINDS surface.
//   - Each click calls the API. The API response (or refetched workflow state)
//     is the source of truth for what happened.
//   - Author is server-side from req.user; we never send author in the body.

'use client';

import React, { useState } from 'react';
import type {
  CommitteeActionKind,
  CommitteeActionPayload,
  DealWorkflowState,
  DoctrineEvaluationId,
  RenderedAnalysisId,
} from '@cre/contracts';
import { api } from '@/lib/api-client';

interface Props {
  readonly rootId: DoctrineEvaluationId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly workflow: DealWorkflowState;
  readonly onActionSubmitted: () => void;
}

interface ActionDef {
  readonly kind: CommitteeActionKind;
  readonly label: string;
  readonly tone: string;
}

const ACTIONS: readonly ActionDef[] = [
  { kind: 'SUBMIT_TO_COMMITTEE', label: 'Submit to Committee', tone: 'bg-blue-600 hover:bg-blue-700 text-white' },
  { kind: 'REQUEST_MORE_INFO',   label: 'Request More Info',   tone: 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300' },
  { kind: 'APPROVE_DEAL',        label: 'Approve',             tone: 'bg-green-600 hover:bg-green-700 text-white' },
  { kind: 'REJECT_DEAL',         label: 'Reject',              tone: 'bg-red-600 hover:bg-red-700 text-white' },
  { kind: 'POSTPONE_DEAL',       label: 'Postpone',            tone: 'bg-purple-100 hover:bg-purple-200 text-purple-900 border border-purple-300' },
];

function buildDefaultPayload(kind: CommitteeActionKind): CommitteeActionPayload {
  switch (kind) {
    case 'SUBMIT_TO_COMMITTEE':
      return { kind, committeeName: 'CRE-Committee', summary: 'Submitted via dashboard' };
    case 'REQUEST_MORE_INFO':
      return { kind, questions: ['Please clarify.'] };
    case 'APPROVE_DEAL':
      return { kind, conditions: [] };
    case 'REJECT_DEAL':
      return { kind, reasons: ['See committee notes.'] };
    case 'POSTPONE_DEAL':
      return { kind, reason: 'Deferred to next session', until: null };
    case 'OVERRIDE_DECISION':
      // OVERRIDE_DECISION requires an overlayId; this default surface does not
      // expose it. Override flows are launched from the overlay view, not here.
      throw new Error('OVERRIDE_DECISION must be triggered from the overlay context');
  }
}

export function CommitteeActionButtons({
  rootId,
  renderedAnalysisId,
  workflow,
  onActionSubmitted,
}: Props): React.ReactElement {
  const [pending, setPending] = useState<CommitteeActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(kind: CommitteeActionKind): Promise<void> {
    if (pending !== null) return;
    setPending(kind);
    setError(null);
    try {
      const payload = buildDefaultPayload(kind);
      await api.submitCommitteeAction({
        rootId,
        renderedAnalysisId,
        kind,
        payload,
      });
      onActionSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-3 border border-gray-200 rounded p-4 bg-white">
      <div className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
          Committee Actions
        </h2>
        <span className="text-xs font-mono text-gray-500">state: {workflow.state}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            disabled={pending !== null}
            onClick={() => { void trigger(a.kind); }}
            className={
              'px-3 py-1.5 text-sm rounded transition ' +
              (pending !== null ? 'opacity-50 cursor-not-allowed ' : '') +
              a.tone
            }
          >
            {pending === a.kind ? '...' : a.label}
          </button>
        ))}
      </div>
      {error !== null ? (
        <p className="text-xs text-red-700 font-mono">{error}</p>
      ) : null}
    </section>
  );
}
