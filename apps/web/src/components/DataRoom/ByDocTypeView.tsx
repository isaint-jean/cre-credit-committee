/**
 * ByDocTypeView — projection 1: folders ARE the taxonomy doc-types, tier-ordered
 * a→b→c by the server. Tier-(c) legal/title/insurance render as FIRST-CLASS
 * folders (browsable + downloadable), never hidden. Each folder is collapsible.
 */
'use client';

import { useState } from 'react';
import type { DataRoomDocTypeGroup } from '@/lib/api-client';
import { DocRow } from './DocRow';

const TIER_LABEL: Record<DataRoomDocTypeGroup['tier'], string> = {
  ingesting: '(a) Engine-ingesting',
  stored: '(b) Stored',
  room_only: '(c) Room-only',
};

export function ByDocTypeView({
  poolId,
  groups,
  unread,
  onRead,
}: {
  readonly poolId: string;
  readonly groups: readonly DataRoomDocTypeGroup[];
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="bg-bg-secondary border border-border-primary rounded-panel p-10 text-center">
        <p className="text-text-primary mb-1 font-medium">No documents in this room yet.</p>
        <p className="text-text-muted text-xs">Drop files above, then assign each to a (loan, doc-type).</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <DocTypeFolder key={g.docType} poolId={poolId} group={g} unread={unread} onRead={onRead} />
      ))}
    </div>
  );
}

function DocTypeFolder({
  poolId,
  group,
  unread,
  onRead,
}: {
  readonly poolId: string;
  readonly group: DataRoomDocTypeGroup;
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const unreadCount = group.docs.reduce((n, d) => n + (unread.has(d.fileHash) ? 1 : 0), 0);
  return (
    <section className="border border-border-primary rounded-panel overflow-hidden bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-bg-tertiary/50 transition-colors"
        aria-expanded={open}
      >
        <span className="text-text-muted text-xs w-3">{open ? '▾' : '▸'}</span>
        <span className="text-sm font-semibold text-text-primary">{group.label}</span>
        <span className="text-[10px] font-mono text-text-subtle uppercase tracking-wide">{TIER_LABEL[group.tier]}</span>
        <span className="ml-auto flex items-center gap-2">
          {unreadCount > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-soft text-accent border border-accent/30">
              {unreadCount} new
            </span>
          )}
          <span className="text-[11px] font-mono text-text-muted">{group.docs.length}</span>
        </span>
      </button>
      {open && (
        <div>
          {group.docs.map((d) => (
            <DocRow
              key={`${d.loanInPoolId}:${d.fileHash}`}
              poolId={poolId}
              doc={d}
              unread={unread.has(d.fileHash)}
              context={{ kind: 'loan', value: d.loanInPoolId }}
              onRead={onRead}
            />
          ))}
        </div>
      )}
    </section>
  );
}
