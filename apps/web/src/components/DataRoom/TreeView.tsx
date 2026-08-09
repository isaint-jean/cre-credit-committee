'use client';

/**
 * Data Room — read-only nested tree browser (Chunk 1).
 *
 *   Deal/Pool → New Issue → Deal name → BANK → CATEGORY → loan-file
 *
 * The CATEGORY is the folder; LOANS are the leaf files inside it (a file is
 * labeled by its loan, with its doc-type as metadata). Every node is COLLAPSED
 * BY DEFAULT and mounts its children ONLY when expanded (each *Node keeps its own
 * `open` state) — a collapsed subtree is zero DOM, the "never cluttered even at
 * thousands of files" guarantee. Purely presentational over GET /:poolId/tree;
 * no mutations, no download, no open-doc (those are later chunks).
 */
import { useState } from 'react';
import type {
  DataRoomTree,
  DataRoomTreeNewIssue,
  DataRoomTreeBank,
  DataRoomTreeCategory,
  DataRoomTreeFile,
} from '@cre/contracts';
import { formatBytes, formatDate, tierChip } from './data-room-utils';

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

/** A document leaf — LABELED BY ITS LOAN, with doc-type + version/date metadata. */
function FileRow({ file, depth }: { file: DataRoomTreeFile; depth: number }) {
  const chip = tierChip(file.tier);
  const dateLabel = file.docEffectiveDate
    ? `as of ${formatDate(file.docEffectiveDate)}`
    : `received ${formatDate(file.uploadedAt)}`;
  return (
    <div
      className="flex items-center gap-2 py-1 pr-2 text-sm"
      style={{ paddingLeft: `${8 + depth * 16 + 16}px` }}
    >
      <span className="text-text-secondary">📄</span>
      <span className="shrink-0 font-medium text-text-primary">{file.loanName}</span>
      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${chip.cls}`}>{file.docTypeLabel}</span>
      <span className="truncate text-xs text-text-secondary" title={file.fileName}>
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

/** A category folder (e.g. "Third-Party Reports") — its loan-files are the leaves. */
function CategoryNode({ category, depth }: { category: DataRoomTreeCategory; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-medium text-text-primary">📁 {category.category}</span>
        <CountPill n={category.fileCount} />
      </DiscRow>
      {open && category.files.map((f) => <FileRow key={`${f.loanInPoolId}:${f.docType}:${f.fileHash}`} file={f} depth={depth} />)}
    </div>
  );
}

/** A contributing bank (mortgageLoanSeller). */
function BankNode({ bank, depth }: { bank: DataRoomTreeBank; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-primary/40 last:border-b-0">
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-semibold text-text-primary">🏦 {bank.bank}</span>
        <CountPill n={bank.fileCount} />
      </DiscRow>
      {open && bank.categories.map((c) => <CategoryNode key={c.category} category={c} depth={depth + 1} />)}
    </div>
  );
}

/** The deal-name repeat (under "New Issue") → its banks. */
function DealNameNode({ newIssue, depth }: { newIssue: DataRoomTreeNewIssue; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DiscRow open={open} depth={depth} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-semibold text-text-primary">📗 {newIssue.dealName ?? 'Deal'}</span>
        <CountPill n={newIssue.fileCount} />
      </DiscRow>
      {open && newIssue.banks.map((b) => <BankNode key={b.bank} bank={b} depth={depth + 1} />)}
    </div>
  );
}

/** The "New Issue" level. */
function NewIssueNode({ newIssue }: { newIssue: DataRoomTreeNewIssue }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <DiscRow open={open} depth={0} onClick={() => setOpen((o) => !o)}>
        <span className="text-sm font-semibold text-text-primary">🗂 New Issue</span>
        <CountPill n={newIssue.fileCount} />
      </DiscRow>
      {open && <DealNameNode newIssue={newIssue} depth={1} />}
    </div>
  );
}

export function TreeView({ tree }: { tree: DataRoomTree }) {
  if (tree.newIssue === null) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-secondary p-6 text-center text-sm text-text-secondary">
        No documents in this room yet.
      </div>
    );
  }
  const bankCount = tree.newIssue.banks.length;
  return (
    <div className="rounded-lg border border-border-primary bg-bg-secondary">
      <div className="flex items-baseline gap-2 border-b border-border-primary px-4 py-3">
        <span className="text-sm font-semibold text-text-primary">{tree.poolName ?? 'Data Room'}</span>
        {tree.seller && <span className="text-xs text-text-secondary">· {tree.seller}</span>}
        <CountPill n={tree.fileCount} />
        <span className="ml-auto text-xs text-text-secondary">
          {bankCount} bank{bankCount === 1 ? '' : 's'} · collapsed by default
        </span>
      </div>
      <div className="py-1">
        <NewIssueNode newIssue={tree.newIssue} />
      </div>
    </div>
  );
}
