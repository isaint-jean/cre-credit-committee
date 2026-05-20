// CommitteeStatusHeader (Phase 3 - committee workflow UI).
//
// Display-only consumer of DealWorkflowState. Renders the deal's lifecycle state,
// active participants, and last-action timestamp. Does NOT compute state, derive
// transitions, or interpret committee semantics; the server's projection is the
// truth source.
//
// Discipline (mirrors RenderedAnalysisView consumer-migration discipline):
//   - No formatting helpers
//   - No business logic
//   - No threshold interpretation
//   - State strings are passed through verbatim
//   - Timestamps are passed through verbatim (server-side ISO strings)

'use client';

import React from 'react';
import type { DealState, DealWorkflowState } from '@cre/contracts';

interface Props {
  readonly workflow: DealWorkflowState;
}

const STATE_TONE: { readonly [K in DealState]: string } = {
  DRAFT:        'bg-gray-100 text-gray-700 border-gray-300',
  IN_REVIEW:    'bg-blue-50  text-blue-800 border-blue-300',
  IN_COMMITTEE: 'bg-amber-50 text-amber-800 border-amber-300',
  APPROVED:     'bg-green-50 text-green-800 border-green-300',
  REJECTED:     'bg-red-50   text-red-800   border-red-300',
  POSTPONED:    'bg-purple-50 text-purple-800 border-purple-300',
};

export function CommitteeStatusHeader({ workflow }: Props): React.ReactElement {
  const tone = STATE_TONE[workflow.state];
  return (
    <section className="space-y-3 border border-gray-200 rounded p-4 bg-white">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Deal Status</h2>
        <span className={'inline-block px-2 py-0.5 text-sm font-medium border rounded ' + tone}>
          {workflow.state}
        </span>
      </div>

      <dl className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Active Participants</dt>
          <dd className="text-gray-900">
            {workflow.activeParticipants.length === 0
              ? <span className="text-gray-400">—</span>
              : workflow.activeParticipants.join(', ')}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Last Action</dt>
          <dd className="text-gray-900 font-mono text-xs">
            {workflow.lastActionAt === null
              ? <span className="text-gray-400">—</span>
              : workflow.lastActionAt}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">Last Snapshot</dt>
          <dd className="text-gray-900 font-mono text-xs">
            {workflow.lastSnapshotId === null
              ? <span className="text-gray-400">—</span>
              : workflow.lastSnapshotId.slice(0, 16) + '…'}
          </dd>
        </div>
      </dl>
    </section>
  );
}
