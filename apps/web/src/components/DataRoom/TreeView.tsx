'use client';

/**
 * Data Room — nested tree browser (Chunk 1) + manual MOVE control (Chunk 2c).
 *
 *   Deal/Pool → New Issue → Deal name → BANK → CATEGORY → loan-file
 *
 * The CATEGORY is the folder; LOANS are the leaf files inside it. Every node is
 * COLLAPSED BY DEFAULT and mounts its children ONLY when expanded (each *Node
 * keeps its own `open` state) — a collapsed subtree is zero DOM. Each file row
 * carries a "Move" control (Chunk 2c) that re-files the doc to a different
 * category (re-type) and/or loan via the reclassify endpoint; on success the tree
 * re-fetches and the file re-renders under its new (derived) category.
 */
import { createContext, useContext, useState } from 'react';
import type {
  DataRoomTree,
  DataRoomTreeNewIssue,
  DataRoomTreeBank,
  DataRoomTreeCategory,
  DataRoomTreeFile,
  DocTypeEntry,
} from '@cre/contracts';
import { CATEGORIES_IN_ORDER } from '@cre/contracts';
import { api } from '@/lib/api-client';
import { formatBytes, formatDate, tierChip } from './data-room-utils';
import { LoanAnalysisSummary } from './LoanAnalysisSummary';

type LoanOption = { loanInPoolId: string; label: string };

/** Move-control context — threaded once, consumed by the leaf FileRow (avoids
 *  drilling props through five node levels). Absent → read-only tree. */
type MoveCtx = { poolId: string; docTypes: readonly DocTypeEntry[]; loans: readonly LoanOption[]; onMoved: () => void };
const MoveContext = createContext<MoveCtx | null>(null);

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

/** The inline "move to a different category / loan" picker, shown under a file. */
function MovePicker({ file, ctx, onDone }: { file: DataRoomTreeFile; ctx: MoveCtx; onDone: () => void }) {
  const [docType, setDocType] = useState(file.docType);
  const [loanInPoolId, setLoanInPoolId] = useState(file.loanInPoolId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function move() {
    setBusy(true);
    setErr(null);
    try {
      await api.dataRoomReclassify(ctx.poolId, file.fileHash, { loanInPoolId, docType });
      onDone();
      ctx.onMoved(); // re-fetch the tree → the file re-renders under its new category
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const grouped = CATEGORIES_IN_ORDER.map((cat) => ({
    cat,
    types: ctx.docTypes.filter((t) => t.category === cat),
  })).filter((g) => g.types.length > 0);

  return (
    <div
      className="flex flex-wrap items-center gap-2 py-2 text-xs"
      style={{ paddingLeft: `${8 + 4 * 16 + 32}px` }}
    >
      <span className="text-text-secondary">Move to</span>
      <select
        value={docType}
        onChange={(e) => setDocType(e.target.value)}
        className="rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-text-primary"
      >
        {grouped.map((g) => (
          <optgroup key={g.cat} label={g.cat}>
            {g.types.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {ctx.loans.length > 0 && (
        <select
          value={loanInPoolId}
          onChange={(e) => setLoanInPoolId(e.target.value)}
          className="rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-text-primary"
        >
          {ctx.loans.map((l) => (
            <option key={l.loanInPoolId} value={l.loanInPoolId}>{l.label}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={move}
        disabled={busy}
        className="rounded border border-accent/40 bg-accent-soft px-2 py-1 text-accent hover:opacity-80 disabled:opacity-50"
      >
        {busy ? 'Moving…' : 'Move'}
      </button>
      <button type="button" onClick={onDone} className="rounded px-2 py-1 text-text-secondary hover:text-text-primary">
        Cancel
      </button>
      {err && <span className="text-score-weak">{err}</span>}
    </div>
  );
}

/** A document leaf — LABELED BY ITS LOAN, with doc-type + version/date metadata,
 *  and (Chunk 2c) a Move control when the move context is present. */
function FileRow({ file, depth }: { file: DataRoomTreeFile; depth: number }) {
  const ctx = useContext(MoveContext);
  const [moving, setMoving] = useState(false);
  const [verdict, setVerdict] = useState(false);
  const chip = tierChip(file.tier);
  const dateLabel = file.docEffectiveDate
    ? `as of ${formatDate(file.docEffectiveDate)}`
    : `received ${formatDate(file.uploadedAt)}`;
  return (
    <div>
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
        {/* Differentiator — the engine's verdict for this file's loan. Shown ONLY on
            docs that FED underwriting (ingest=true); its presence signals "this
            document informed the credit opinion". Record-only docs have no verdict. */}
        {file.ingest && (
          <button
            type="button"
            onClick={() => setVerdict((v) => !v)}
            className="shrink-0 rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-xs text-accent hover:opacity-80"
            title="This document fed the underwriting — show the loan's score, red flags, and what the engine pulled"
          >
            {verdict ? 'Hide verdict' : '⚡ Verdict'}
          </button>
        )}
        {ctx && (
          <button
            type="button"
            onClick={() => setMoving((m) => !m)}
            className="shrink-0 rounded border border-border-primary px-1.5 py-0.5 text-xs text-text-secondary hover:text-text-primary"
          >
            {moving ? 'Close' : 'Move'}
          </button>
        )}
      </div>
      {verdict && <LoanAnalysisSummary analysisId={file.analysisId} depth={depth} />}
      {ctx && moving && <MovePicker file={file} ctx={ctx} onDone={() => setMoving(false)} />}
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

export function TreeView({
  tree,
  poolId,
  docTypes,
  loans,
  onMoved,
}: {
  tree: DataRoomTree;
  /** Chunk 2c move control — omit to render a read-only tree. */
  poolId?: string;
  docTypes?: readonly DocTypeEntry[];
  loans?: readonly LoanOption[];
  onMoved?: () => void;
}) {
  if (tree.newIssue === null) {
    return (
      <div className="rounded-lg border border-border-primary bg-bg-secondary p-6 text-center text-sm text-text-secondary">
        No documents in this room yet.
      </div>
    );
  }
  const bankCount = tree.newIssue.banks.length;
  const moveCtx: MoveCtx | null =
    poolId && docTypes && onMoved ? { poolId, docTypes, loans: loans ?? [], onMoved } : null;
  return (
    <MoveContext.Provider value={moveCtx}>
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
    </MoveContext.Provider>
  );
}
