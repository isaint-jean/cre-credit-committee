'use client';

/**
 * Data Room — read-only nested tree browser (Chunk 1).
 *
 * Deal → Loan → Category → docType slot → file. Every node is COLLAPSED BY
 * DEFAULT and renders its children ONLY when expanded (each *Node keeps its own
 * `open` state, so children are not mounted until you expand) — that is the
 * "never cluttered even at thousands of files" guarantee: a collapsed subtree is
 * zero DOM. Purely presentational over GET /:poolId/tree; no mutations, no
 * download, no open-doc (those are later chunks).
 */
import { useState } from 'react';
import type {
  DataRoomTree,
  DataRoomTreeLoan,
  DataRoomTreeCategory,
  DataRoomTreeSlot,
  DataRoomTreeFile,
} from '@cre/contracts';
import { formatBytes, formatDate, shortLoan, tierChip } from './data-room-utils';

/** A count pill (files under a node). */
function CountPill({ n }: { n: number }) {
  return (
    <span className="ml-2 rounded-full border border-border-primary bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
      {n} file{n === 1 ? '' : 's'}
    </span>
  );
}

/** The disclosure row shared by every collapsible node. */
function DiscRow({
  open,
  depth,
  onClick,
  children,
}: {
  open: boolean;
  depth: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-bg-tertiary/60"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <span className="w-3 shrink-0 text-text-secondary">{open ? '▾' : '▸'}</span>
      {children}
    </button>
  );
}

/** A single file leaf: name, receipt date (labeled), version/pin/current badges, size. */
function FileRow({ file, depth }: { file: DataRoomTreeFile; depth: number }) {
  // Receipt date: prefer the extracted content/as-of date; else the upload date.
  const dateLabel = file.docEffectiveDate
    ? `as of ${formatDate(file.docEffectiveDate)}`
    : `received ${formatDate(file.uploadedAt)}`;
  return (
    <div
      className="flex items-center gap-2 py-1 pr-2 text-sm"
      style={{ paddingLeft: `${8 + depth * 16 + 16}px` }}
    >
      <span className="text-text-secondary">📄</span>
      <span className="truncate text-text-primary" title={file.fileName}>
        {file.fileName}
      </span>
      {file.versionCount > 1 && (
        <span className="shrink-0 rounded border border-border-primary px-1.5 py-0.5 text-xs text-text-secondary">
          v{file.versionIndex} of {file.versionCount}
        </span>
      )}
      {file.isSelectedVersion && file.versionCount > 1 && (
        <span className="shrink-0 rounded border border-score-strong/30 bg-score-strong/15 px-1.5 py-0.5 text-xs text-score-strong">
          current
        </span>
      )}
      {file.pinned && (
        <span className="shrink-0 rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-xs text-accent">
          pinned
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs text-text-secondary">{dateLabel}</span>
      <span className="shrink-0 text-xs text-text-secondary">{formatBytes(file.size)}</span>
    </div>
  );
}

/** A docType slot (e.g. "Appraisal") — its versions are the leaves. */
function SlotNode({ slot, depth }: { slot: DataRoomTreeSlot; depth: number }) {
  const [open, setOpen] = useState(false);
  const chip = tierChip(slot.tier);
  return (
    <div>
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm text-text-primary">{slot.label}</span>
        <span className={`ml-2 rounded border px-1.5 py-0.5 text-xs ${chip.cls}`}>{chip.label}</span>
        <CountPill n={slot.files.length} />
      </DiscRow>
      {open && slot.files.map((f) => <FileRow key={f.fileHash} file={f} depth={depth} />)}
    </div>
  );
}

/** A category folder (e.g. "Third-Party Reports") within a loan. */
function CategoryNode({ category, depth }: { category: DataRoomTreeCategory; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-medium text-text-primary">📁 {category.category}</span>
        <CountPill n={category.fileCount} />
      </DiscRow>
      {open && category.slots.map((s) => <SlotNode key={s.docType} slot={s} depth={depth + 1} />)}
    </div>
  );
}

/** A loan within the deal. */
function LoanNode({ loan, depth }: { loan: DataRoomTreeLoan; depth: number }) {
  const [open, setOpen] = useState(false);
  const name = loan.propertyName ?? shortLoan(loan.loanInPoolId);
  return (
    <div className="border-b border-border-primary/50 last:border-b-0">
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-semibold text-text-primary">🏢 {name}</span>
        <CountPill n={loan.fileCount} />
      </DiscRow>
      {open && loan.categories.map((c) => <CategoryNode key={c.category} category={c} depth={depth + 1} />)}
    </div>
  );
}

export function TreeView({ tree }: { tree: DataRoomTree }) {
  if (tree.loans.length === 0) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-secondary p-6 text-center text-sm text-text-secondary">
        No documents in this room yet.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border-primary bg-bg-secondary">
      <div className="flex items-baseline gap-2 border-b border-border-primary px-4 py-3">
        <span className="text-sm font-semibold text-text-primary">{tree.poolName ?? 'Data Room'}</span>
        {tree.seller && <span className="text-xs text-text-secondary">· {tree.seller}</span>}
        <CountPill n={tree.fileCount} />
        <span className="ml-auto text-xs text-text-secondary">
          {tree.loans.length} loan{tree.loans.length === 1 ? '' : 's'} · collapsed by default
        </span>
      </div>
      <div className="py-1">
        {tree.loans.map((loan) => (
          <LoanNode key={loan.loanInPoolId} loan={loan} depth={0} />
        ))}
      </div>
    </div>
  );
}
