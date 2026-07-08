/**
 * ByLoanView — projection 2: docs grouped by loanInPoolId. Same pile, second
 * projection. Each loan is a collapsible group; the doc-type is shown as the
 * per-row context label. propertyName (from the pool membership) labels the
 * group when known, falling back to the loan id.
 *
 * ★ SLICE 4 (version pin): within a loan, docs are grouped by docType. A slot
 *   with 2+ versions of the SAME document (e.g. two appraisals) renders the
 *   VersionPicker — the honest "which version underwrites + why" surface with
 *   per-version pin/unpin. Single-version slots render a plain DocRow (no pin
 *   friction — nothing to choose). This loan-grouped view is the natural home
 *   for the picker because the pin endpoint is (loan, docType)-scoped.
 */
'use client';

import { useMemo, useState } from 'react';
import type { DataRoomDocEntry, DataRoomLoanGroup } from '@/lib/api-client';
import { DocRow } from './DocRow';
import { VersionPicker } from './VersionPicker';
import { shortLoan } from './data-room-utils';

export function ByLoanView({
  poolId,
  groups,
  unread,
  onRead,
  onChanged,
  loanLabels,
  docTypeLabels,
}: {
  readonly poolId: string;
  readonly groups: readonly DataRoomLoanGroup[];
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
  /** Refetch the projections after a pin/unpin so the selected marker updates. */
  readonly onChanged: () => void | Promise<void>;
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
          onChanged={onChanged}
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
  onChanged,
  label,
  docTypeLabels,
}: {
  readonly poolId: string;
  readonly group: DataRoomLoanGroup;
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
  readonly onChanged: () => void | Promise<void>;
  readonly label: string | null;
  readonly docTypeLabels: ReadonlyMap<string, string>;
}) {
  // Default COLLAPSED — the loan view is a loan-level SUMMARY (per-loan count +
  // new-badge), not a thousand-row dump. Expand a loan to see its files.
  const [open, setOpen] = useState(false);
  const unreadCount = group.docs.reduce((n, d) => n + (unread.has(d.fileHash) ? 1 : 0), 0);

  // Group the loan's docs by docType (a "slot"), preserving first-seen order. A
  // slot with 2+ versions gets the version picker; a single-version slot renders
  // a plain row. Multi-version slots sort ahead so the choices surface first.
  const slots = useMemo(() => {
    const byType = new Map<string, DataRoomDocEntry[]>();
    for (const d of group.docs) {
      const arr = byType.get(d.docType) ?? [];
      arr.push(d);
      byType.set(d.docType, arr);
    }
    const entries = [...byType.entries()].map(([docType, docs]) => ({ docType, docs }));
    return entries.sort((a, b) => b.docs.length - a.docs.length);
  }, [group.docs]);

  const multiVersionCount = slots.filter((s) => s.docs.length > 1).length;

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
          {multiVersionCount > 0 && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted border border-border-primary"
              title="Doc-type slots with 2+ versions — pick which one underwrites."
            >
              {multiVersionCount} multi-version
            </span>
          )}
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
          {slots.map((slot) =>
            slot.docs.length > 1 ? (
              <VersionPicker
                key={slot.docType}
                poolId={poolId}
                docTypeLabel={docTypeLabels.get(slot.docType) ?? slot.docType}
                versions={slot.docs}
                unread={unread}
                onRead={onRead}
                onChanged={onChanged}
              />
            ) : (
              <DocRow
                key={`${slot.docType}:${slot.docs[0]!.fileHash}`}
                poolId={poolId}
                doc={slot.docs[0]!}
                unread={unread.has(slot.docs[0]!.fileHash)}
                context={{ kind: 'docType', value: docTypeLabels.get(slot.docType) ?? slot.docType }}
                onRead={onRead}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}
