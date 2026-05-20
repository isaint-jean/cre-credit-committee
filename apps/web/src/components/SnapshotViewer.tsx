// SnapshotViewer (Phase 4 - operational workflow UX).
//
// Read-only viewer for the most-recent committee snapshot referenced by a deal's
// workflow state. Snapshots are immutable artifacts produced by buildCommitteeSnapshot
// at submission/approval time. We display the snapshot id (truncated) and offer no
// editing affordances. Future expansion: list all snapshots from the timeline and
// allow navigation; the v1 surface shows the lastSnapshotId from DealWorkflowState.
//
// DISCIPLINE:
//   - No client-side reconstruction of snapshot contents.
//   - No interpretation of the snapshot ledger; we display the references the
//     server has already projected via DealWorkflowState.lastSnapshotId.

'use client';

import React from 'react';
import type { DealWorkflowState } from '@cre/contracts';

interface Props {
  readonly workflow: DealWorkflowState;
}

export function SnapshotViewer({ workflow }: Props): React.ReactElement {
  const snapshotId = workflow.lastSnapshotId;
  return (
    <section className="space-y-2 border border-gray-200 rounded p-4 bg-white">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
        Frozen Committee Packet
      </h2>
      {snapshotId === null ? (
        <p className="text-xs text-gray-500">No committee snapshot has been frozen for this deal yet.</p>
      ) : (
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Snapshot Id</dt>
            <dd className="text-gray-900 font-mono text-xs break-all">{snapshotId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500">Last Action</dt>
            <dd className="text-gray-900 font-mono text-xs">
              {workflow.lastActionAt ?? '—'}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
