/**
 * DropAssign — the bulk-drop + manual-assign seam (Data-Room D4).
 *
 * FLOW (the Phase-2 seam, made explicit):
 *   1. Bulk drop — drag/drop or multi-file picker → POST /:poolId/staging →
 *      a StagingBatch (staged, UNASSIGNED).
 *   2. Assign tray — each staged file gets a (loan, doc-type) picker. Only files
 *      with BOTH chosen are eligible; "Assign N files" → POST /:poolId/assign.
 *      Manual now; Phase 2 auto-fills these exact two pickers per row.
 *   3. On success the parent re-fetches both projections + unread — the doc now
 *      appears under its doc-type folder AND its loan.
 *
 * P1 tokens throughout; the drop zone rides the active `?side` accent.
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import {
  api,
  type DocTypeEntry,
  type StagingBatch,
  type StagingFileEntry,
  type DataRoomAssignmentInput,
} from '@/lib/api-client';
import type { SideAccent } from '@/lib/side-accent';
import { formatBytes } from './data-room-utils';

/** One assignable loan the picker offers (from the pool membership). */
export interface AssignLoanOption {
  readonly loanInPoolId: string;
  readonly label: string;
}

/** Per-staged-file draft (loan + docType chosen in the tray). */
interface AssignDraft {
  loanInPoolId: string;
  docType: string;
}

export function DropAssign({
  poolId,
  accent,
  docTypes,
  loanOptions,
  onAssigned,
}: {
  readonly poolId: string;
  readonly accent: SideAccent;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  /** Called after a successful assign so the parent re-fetches projections. */
  readonly onAssigned: () => void;
}) {
  const [batch, setBatch] = useState<StagingBatch | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AssignDraft>>({});
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'assigning'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const stage = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy('uploading');
    setErr(null);
    setNotice(null);
    try {
      const { batch: b } = await api.dataRoomStageFiles(poolId, files);
      // Merge onto any existing staged (unassigned) batch so multiple drops queue.
      setBatch((prev) => (prev ? { ...b, files: [...prev.files, ...b.files] } : b));
      setNotice(`${b.files.length} file${b.files.length === 1 ? '' : 's'} staged — assign each below.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [poolId]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    stage(Array.from(e.dataTransfer.files));
  }, [stage]);

  function setDraft(stagingId: string, patch: Partial<AssignDraft>) {
    setDrafts((d) => {
      const prev = d[stagingId] ?? { loanInPoolId: '', docType: '' };
      return { ...d, [stagingId]: { ...prev, ...patch } };
    });
  }

  const eligible: DataRoomAssignmentInput[] = batch
    ? batch.files
        .map((f) => {
          const d = drafts[f.stagingId];
          if (!d || !d.loanInPoolId || !d.docType) return null;
          return { stagingId: f.stagingId, loanInPoolId: d.loanInPoolId, docType: d.docType };
        })
        .filter((x): x is DataRoomAssignmentInput => x !== null)
    : [];

  async function assign() {
    if (!batch || eligible.length === 0) return;
    setBusy('assigning');
    setErr(null);
    setNotice(null);
    try {
      const { results } = await api.dataRoomAssign(poolId, batch.batchId, eligible);
      const ok = results.filter((r) => r.status === 'assigned').map((r) => r.stagingId);
      const failed = results.filter((r) => r.status === 'error');
      // Drop the assigned files from the tray; keep any that failed or are still
      // un-drafted so the tray stays a clean, honest queue.
      const remaining = batch.files.filter((f) => !ok.includes(f.stagingId));
      setBatch(remaining.length > 0 ? { ...batch, files: remaining } : null);
      setDrafts((d) => {
        const next = { ...d };
        for (const id of ok) delete next[id];
        return next;
      });
      if (failed.length > 0) {
        setErr(`${failed.length} file(s) failed: ${failed.map((f) => f.error).join('; ')}`);
      }
      if (ok.length > 0) {
        setNotice(`${ok.length} file${ok.length === 1 ? '' : 's'} filed into the room.`);
        onAssigned();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }

  return (
    <div className="mb-6">
      {/* ── Bulk drop zone ──────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
        className={`cursor-pointer rounded-panel border-2 border-dashed px-6 py-8 text-center transition-colors ${
          dragOver ? `${accent.border} ${accent.softBg}` : 'border-border-primary bg-bg-secondary hover:border-border-secondary'
        }`}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { stage(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
        <p className={`text-sm font-medium ${accent.text}`}>
          {busy === 'uploading' ? 'Uploading…' : 'Drop files here or click to browse'}
        </p>
        <p className="text-text-muted text-xs mt-1">Bulk drop into staging — assign each to a (loan, doc-type) below.</p>
      </div>

      {notice && <p className="mt-2 text-xs text-score-strong">{notice}</p>}
      {err && <p className="mt-2 text-xs text-risk-high">{err}</p>}

      {/* ── Manual-assign tray (the Phase-2 seam) ───────────────────────── */}
      {batch && batch.files.length > 0 && (
        <div className="mt-4 border border-border-primary rounded-panel bg-bg-secondary overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-primary">
            <h3 className="text-sm font-semibold text-text-primary">
              Assign staged files
              <span className="ml-2 text-[11px] font-mono text-text-muted">{batch.files.length} pending</span>
            </h3>
            <button
              type="button"
              disabled={eligible.length === 0 || busy !== 'idle'}
              onClick={assign}
              className={`text-sm font-medium px-3 py-1.5 rounded-sm2 border transition-opacity disabled:opacity-40 disabled:cursor-not-allowed ${accent.border} ${accent.softBg} ${accent.text}`}
            >
              {busy === 'assigning' ? 'Assigning…' : `Assign ${eligible.length} file${eligible.length === 1 ? '' : 's'}`}
            </button>
          </div>
          <div>
            {batch.files.map((f) => (
              <AssignRow
                key={f.stagingId}
                file={f}
                draft={drafts[f.stagingId]}
                docTypes={docTypes}
                loanOptions={loanOptions}
                onLoan={(v) => setDraft(f.stagingId, { loanInPoolId: v })}
                onDocType={(v) => setDraft(f.stagingId, { docType: v })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssignRow({
  file,
  draft,
  docTypes,
  loanOptions,
  onLoan,
  onDocType,
}: {
  readonly file: StagingFileEntry;
  readonly draft: AssignDraft | undefined;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  readonly onLoan: (v: string) => void;
  readonly onDocType: (v: string) => void;
}) {
  const ready = draft && draft.loanInPoolId && draft.docType;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-border-primary">
      <span
        className={`shrink-0 w-2 h-2 rounded-full ${ready ? 'bg-score-strong' : 'bg-text-muted/40'}`}
        title={ready ? 'Ready to assign' : 'Pick a loan and doc-type'}
      />
      <div className="flex-1 min-w-[12rem]">
        <div className="truncate text-sm text-text-primary" title={file.originalFileName}>{file.originalFileName}</div>
        <div className="text-[10px] font-mono text-text-subtle">{formatBytes(file.size)}</div>
      </div>
      <select
        value={draft?.loanInPoolId ?? ''}
        onChange={(e) => onLoan(e.target.value)}
        className="text-xs bg-bg-primary border border-border-primary rounded-sm2 px-2 py-1.5 text-text-primary min-w-[10rem]"
      >
        <option value="">— loan —</option>
        {loanOptions.map((l) => (
          <option key={l.loanInPoolId} value={l.loanInPoolId}>{l.label}</option>
        ))}
      </select>
      <select
        value={draft?.docType ?? ''}
        onChange={(e) => onDocType(e.target.value)}
        className="text-xs bg-bg-primary border border-border-primary rounded-sm2 px-2 py-1.5 text-text-primary min-w-[12rem]"
      >
        <option value="">— doc-type —</option>
        {docTypes.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </div>
  );
}
