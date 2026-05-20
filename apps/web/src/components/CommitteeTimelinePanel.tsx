// CommitteeTimelinePanel (Phase 3 - committee workflow UI).
//
// Display-only consumer of CommitteeTimeline. Renders the chronological merge of
// audit events + committee actions + snapshot creations as a vertical timeline.
// No filtering UI, no interactive mutation, no client-side ordering changes; the
// server's builder produced canonical chronological order and the UI just prints.
//
// Discipline:
//   - No formatting helpers
//   - No business logic
//   - No client-side ordering
//   - Each entry displayed as the server materialized it

'use client';

import React from 'react';
import type {
  CommitteeTimeline,
  TimelineEntry,
  TimelineEntryKind,
} from '@cre/contracts';

interface Props {
  readonly timeline: CommitteeTimeline;
}

const KIND_TONE: { readonly [K in TimelineEntryKind]: string } = {
  'overlay-event':    'border-blue-400 bg-blue-50',
  'committee-action': 'border-amber-400 bg-amber-50',
  'snapshot-created': 'border-purple-400 bg-purple-50',
};

const KIND_LABEL: { readonly [K in TimelineEntryKind]: string } = {
  'overlay-event':    'overlay',
  'committee-action': 'committee',
  'snapshot-created': 'snapshot',
};

function TimelineRow({ entry }: { entry: TimelineEntry }): React.ReactElement {
  const tone = KIND_TONE[entry.kind];
  const label = KIND_LABEL[entry.kind];
  return (
    <li className={'border-l-4 pl-3 py-2 ' + tone}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-xs uppercase tracking-wide text-gray-500 font-mono">{label}</span>
        <span className="text-xs font-mono text-gray-500">{entry.subKind}</span>
        <span className="text-xs font-mono text-gray-400">{entry.occurredAt}</span>
      </div>
      <div className="text-sm text-gray-900 mt-1">{entry.summary}</div>
      <div className="text-xs text-gray-500 mt-0.5">
        by <span className="font-mono">{entry.author}</span>
        <span className="text-gray-400"> — </span>
        <span className="font-mono">{entry.refId.slice(0, 16)}…</span>
      </div>
    </li>
  );
}

export function CommitteeTimelinePanel({ timeline }: Props): React.ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Committee Timeline</h2>
      {timeline.entries.length === 0 ? (
        <div className="text-sm text-gray-400 border border-dashed border-gray-300 rounded p-4 text-center">
          No events yet for this deal.
        </div>
      ) : (
        <ul className="space-y-2">
          {timeline.entries.map((e) => <TimelineRow key={e.refId} entry={e} />)}
        </ul>
      )}
    </section>
  );
}
