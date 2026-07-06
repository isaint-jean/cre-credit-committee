/**
 * ByLoanView — projection 2: docs grouped by loanInPoolId. Same pile, second
 * projection. Each loan is a collapsible group; the doc-type is shown as the
 * per-row context label. propertyName (from the pool membership) labels the
 * group when known, falling back to the loan id.
 */
'use client';

import { useState } from 'react';
import type { DataRoomLoanGroup, DocTypeEntry } from '@/lib/api-client';
import { DocRow } from './DocRow';
import { shortLoan } from './data-room-utils';

export function ByLoanView({
  poolId,
  groups,
  unread,
  onRead,
  loanLabels,
  docTypeLabels,
}: {
  readonly poolId: string;
  readonly groups: readonly DataRoomLoanGroup[];
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
  /** loanInPoolId → human label (propertyName / dealRef), when resolvable. */
  readonly loanLabels: ReadonlyMap<string, string>;
  /** docType id → label, from the taxonomy. */
  readonly docTypeLabels: ReadonlyMap<string, string>;
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
        <LoanFolder
          key={g.loanInPoolId}
          poolId={poolId}
          group={g}
          unread={unread}
          onRead={onRead}
          label={loanLabels.get(g.loanInPoolId) ?? null}
          docTypeLabels={docTypeLabels}
        />
      ))}
    </div>
  );
}

function LoanFolder({
  poolId,
  group,
  unread,
  onRead,
  label,
  docTypeLabels,
}: {
  readonly poolId: string;
  readonly group: DataRoomLoanGroup;
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
  readonly label: string | null;
  readonly docTypeLabels: ReadonlyMap<string, string>;
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
        <span className="text-sm font-semibold text-text-primary">{label ?? shortLoan(group.loanInPoolId)}</span>
        {label !== null && (
          <span className="text-[10px] font-mono text-text-subtle">{shortLoan(group.loanInPoolId)}</span>
        )}
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
              key={`${d.docType}:${d.fileHash}`}
              poolId={poolId}
              doc={d}
              unread={unread.has(d.fileHash)}
              context={{ kind: 'docType', value: docTypeLabels.get(d.docType) ?? d.docType }}
              onRead={onRead}
            />
          ))}
        </div>
      )}
    </section>
  );
}
